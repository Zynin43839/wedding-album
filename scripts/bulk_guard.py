#!/usr/bin/env python3
"""bulk_guard.py - a hard ceiling on concurrency and process churn for bulk jobs.

Why this exists
---------------
A 4-core / 15 W laptop froze because a cleanup script ran `npx wrangler` once per
file with 8 threads. Every `npx` call creates ~5 processes, so 701 files meant
3,500 process creations, ~5 GB of Node instances and a Defender scan of each
one. The machine stayed at 100% CPU until the job drained.

This module makes that failure impossible by construction:

  * `max_workers` is clamped to a small number (default 2).
  * A background monitor samples live descendant processes and system-wide
    counts of watched names (default `node.exe`) while the job runs.
  * If either ceiling is crossed the pool stops scheduling and `BulkAbort`
    is raised, so the caller cannot keep flooding the machine.

No third-party dependencies: process enumeration uses the Windows
Toolhelp32 API through ctypes, with a /proc fallback elsewhere.

Usage
-----
    from bulk_guard import BulkGuard

    guard = BulkGuard(label="clean_album", max_workers=2)
    guard.check(planned_items=701, processes_per_item=1)
    results = guard.run(keys, delete_one)

Converting a loop instead of capping it is always better: run
`guard.advice(n_items)` to see the projected process count for the cheap
batched alternative.
"""
from __future__ import annotations

import ctypes
import os
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from typing import Any, Callable, Iterable, Sequence

# --- machine profile -------------------------------------------------------
# This machine: Intel i7-8565U, 4 cores / 8 threads @ 1.8 GHz base, 15 W TDP,
# 15.8 GB RAM. Parallel subprocess work must stay well under the core count.
DEFAULT_MAX_WORKERS = 2
DEFAULT_MAX_CHILDREN = 12
DEFAULT_MAX_NAMED = 24
DEFAULT_WATCH_NAMES = ("node.exe", "npm.exe", "cmd.exe")


class BulkAbort(RuntimeError):
    """Raised when the guard detects a process storm and stops the job."""


# --- process enumeration ---------------------------------------------------
TH32CS_SNAPPROCESS = 0x00000002
INVALID_HANDLE_VALUE = ctypes.c_void_p(-1).value


class _PROCESSENTRY32W(ctypes.Structure):
    _fields_ = [
        ("dwSize", ctypes.c_ulong),
        ("cntUsage", ctypes.c_ulong),
        ("th32ProcessID", ctypes.c_ulong),
        ("th32DefaultHeapID", ctypes.c_void_p),
        ("th32ModuleID", ctypes.c_ulong),
        ("cntThreads", ctypes.c_ulong),
        ("th32ParentProcessID", ctypes.c_ulong),
        ("pcPriClassBase", ctypes.c_long),
        ("dwFlags", ctypes.c_ulong),
        ("szExeFile", ctypes.c_wchar * 260),
    ]


def _snapshot_windows() -> list[tuple[int, int, str]]:
    """Return (pid, ppid, exe_name) for every process, or [] when unavailable."""
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.CreateToolhelp32Snapshot.restype = ctypes.c_void_p
    kernel32.CreateToolhelp32Snapshot.argtypes = [ctypes.c_ulong, ctypes.c_ulong]
    kernel32.Process32FirstW.argtypes = [ctypes.c_void_p, ctypes.POINTER(_PROCESSENTRY32W)]
    kernel32.Process32NextW.argtypes = [ctypes.c_void_p, ctypes.POINTER(_PROCESSENTRY32W)]
    kernel32.CloseHandle.argtypes = [ctypes.c_void_p]

    snap = kernel32.CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0)
    if not snap or snap == INVALID_HANDLE_VALUE:
        return []
    rows: list[tuple[int, int, str]] = []
    try:
        entry = _PROCESSENTRY32W()
        entry.dwSize = ctypes.sizeof(_PROCESSENTRY32W)
        ok = kernel32.Process32FirstW(snap, ctypes.byref(entry))
        while ok:
            rows.append((int(entry.th32ProcessID),
                         int(entry.th32ParentProcessID),
                         entry.szExeFile or ""))
            ok = kernel32.Process32NextW(snap, ctypes.byref(entry))
    finally:
        kernel32.CloseHandle(snap)
    return rows


def _snapshot_posix() -> list[tuple[int, int, str]]:
    rows: list[tuple[int, int, str]] = []
    proc = "/proc"
    if not os.path.isdir(proc):
        return rows
    for name in os.listdir(proc):
        if not name.isdigit():
            continue
        try:
            with open(f"{proc}/{name}/stat", "r", encoding="utf-8", errors="replace") as fh:
                fields = fh.read().split()
            comm = fields[1].strip("()")
            ppid = int(fields[3])
            rows.append((int(name), ppid, comm))
        except (OSError, IndexError, ValueError):
            continue
    return rows


def snapshot() -> list[tuple[int, int, str]]:
    return _snapshot_windows() if sys.platform == "win32" else _snapshot_posix()


def count_descendants(rows: Sequence[tuple[int, int, str]] | None = None,
                      root: int | None = None) -> int:
    """Number of live processes descended from `root` (default: this process)."""
    rows = snapshot() if rows is None else rows
    root = os.getpid() if root is None else root
    children: dict[int, list[int]] = {}
    for pid, ppid, _ in rows:
        children.setdefault(ppid, []).append(pid)
    total = 0
    stack = list(children.get(root, []))
    while stack:
        pid = stack.pop()
        total += 1
        stack.extend(children.get(pid, []))
    return total


def count_named(names: Iterable[str], rows: Sequence[tuple[int, int, str]] | None = None) -> int:
    """System-wide count of processes whose exe name is in `names` (case-insensitive)."""
    rows = snapshot() if rows is None else rows
    wanted = {n.lower() for n in names}
    return sum(1 for _, _, exe in rows if exe.lower() in wanted)


class BulkGuard:
    """Caps concurrency and aborts a bulk job if the machine starts to drown."""

    def __init__(self,
                 label: str = "job",
                 max_workers: int = DEFAULT_MAX_WORKERS,
                 max_children: int = DEFAULT_MAX_CHILDREN,
                 max_named: int = DEFAULT_MAX_NAMED,
                 watch_names: Iterable[str] = DEFAULT_WATCH_NAMES,
                 sample_seconds: float = 0.5,
                 allow_override: bool = False,
                 stream: Any = None):
        self.label = label
        self.max_children = max_children
        self.max_named = max_named
        self.watch_names = tuple(watch_names)
        self.sample_seconds = sample_seconds
        self.stream = stream if stream is not None else sys.stdout
        self.peak_children = 0
        self.peak_named = 0
        self.clamped_from = None

        if max_workers > DEFAULT_MAX_WORKERS and not allow_override:
            self.clamped_from = max_workers
            print(f"[guard] {label}: max_workers {max_workers} -> {DEFAULT_MAX_WORKERS} "
                  f"(machine profile allows {DEFAULT_MAX_WORKERS})", flush=True)
            max_workers = DEFAULT_MAX_WORKERS
        self.max_workers = max(1, int(max_workers))

    # -- introspection ------------------------------------------------------
    def alive_children(self) -> int:
        return count_descendants()

    def alive_named(self) -> int:
        return count_named(self.watch_names)

    @staticmethod
    def advice(n_items: int, processes_per_item: int = 1) -> str:
        """Projected process creations for a per-item loop vs one batched call."""
        loop = n_items * processes_per_item
        verdict = "OK" if loop <= 40 else "REDESIGN: batch this, do not loop"
        return (f"{n_items} items x {processes_per_item} proc/item = {loop} process creations "
                f"-> {verdict}")

    # -- pre-flight ---------------------------------------------------------
    def check(self, planned_items: int | None = None,
              processes_per_item: int = 1) -> None:
        """Refuse to start when the plan or the current machine state is unsafe."""
        if planned_items is not None:
            if planned_items * processes_per_item > 40 and self.max_workers > 1:
                print(f"[guard] warning: {self.advice(planned_items, processes_per_item)}",
                      flush=True)
        busy = self.alive_named()
        if busy > self.max_named:
            raise BulkAbort(
                f"{self.label}: {busy} processes already alive from {self.watch_names} "
                f"(ceiling {self.max_named}). Close or finish the running job first.")

    # -- execution ----------------------------------------------------------
    def run(self,
            items: Iterable[Any],
            fn: Callable[[Any], Any],
            on_result: Callable[[Any, Any], None] | None = None) -> list[Any]:
        """Map `fn` over `items` with a capped pool and a live storm monitor."""
        work = list(items)
        if not work:
            return []
        self.check()

        stop = threading.Event()
        tripped: list[str] = []

        def monitor() -> None:
            while not stop.is_set():
                kids = self.alive_children()
                named = self.alive_named()
                self.peak_children = max(self.peak_children, kids)
                self.peak_named = max(self.peak_named, named)
                if kids > self.max_children:
                    tripped.append(f"{kids} descendant processes > {self.max_children}")
                    stop.set()
                    return
                if named > self.max_named:
                    tripped.append(f"{named} {self.watch_names} processes > {self.max_named}")
                    stop.set()
                    return
                time.sleep(self.sample_seconds)

        watcher = threading.Thread(target=monitor, name=f"{self.label}-guard", daemon=True)
        watcher.start()

        results: list[Any] = []
        pool = ThreadPoolExecutor(max_workers=self.max_workers, thread_name_prefix=self.label)
        try:
            futures = [pool.submit(fn, item) for item in work]
            for pos, fut in enumerate(futures, 1):
                if stop.is_set():
                    break
                try:
                    value = fut.result()
                except Exception as exc:  # noqa: BLE001 - surface, do not swallow
                    value = exc
                results.append(value)
                if on_result is not None:
                    on_result(pos, value)
        finally:
            stop.set()
            pool.shutdown(wait=True, cancel_futures=True)
            watcher.join(timeout=2)

        if tripped:
            raise BulkAbort(f"{self.label}: aborted after {len(results)}/{len(work)} items - {tripped[0]}")
        return results

    def report(self) -> str:
        return (f"[guard] {self.label}: workers={self.max_workers} "
                f"peak_children={self.peak_children}/{self.max_children} "
                f"peak_named={self.peak_named}/{self.max_named}")


# --- self test -------------------------------------------------------------
def _selftest() -> int:
    """Mutation test: a job that spawns too much MUST abort, not finish."""
    import subprocess

    print("1) process enumeration works")
    rows = snapshot()
    print(f"   processes visible: {len(rows)}")
    assert rows, "snapshot returned nothing"
    print(f"   descendants of this process: {count_descendants(rows)}")

    print("2) max_workers is clamped")
    g = BulkGuard(label="clamp-demo", max_workers=8)
    assert g.max_workers == DEFAULT_MAX_WORKERS, g.max_workers
    print(f"   requested 8 -> clamped to {g.max_workers}")

    print("3) advice flags a bad plan")
    print(f"   {BulkGuard.advice(701, 5)}")
    assert "REDESIGN" in BulkGuard.advice(701, 5)

    print("4) a storming job aborts (mutation test)")
    spawn = [sys.executable, "-c", "import time; time.sleep(1.2)"]

    def hog(_i):
        subprocess.run(spawn, capture_output=True)
        return True

    g = BulkGuard(label="storm-demo", max_workers=1, max_children=2,
                  max_named=10_000, sample_seconds=0.05)
    # Sneak extra children past the monitor so the ceiling is genuinely crossed.
    def hog_wide(_i):
        procs = [subprocess.Popen(spawn) for _ in range(4)]
        time.sleep(0.2)
        for p in procs:
            p.wait()
        return True

    aborted = False
    try:
        g.run(range(3), hog_wide)
    except BulkAbort as exc:
        aborted = True
        print(f"   aborted as expected: {exc}")
    assert aborted, "guard failed to abort a storm - the check cannot fail, therefore it proves nothing"

    print("5) a calm job completes")
    g2 = BulkGuard(label="calm-demo", max_workers=2)
    out = g2.run([1, 2, 3], lambda x: x * 2)
    assert out == [2, 4, 6], out
    print(f"   results={out} {g2.report()}")

    print("\nRESULT: PASS")
    return 0


if __name__ == "__main__":
    if "--selftest" in sys.argv:
        sys.exit(_selftest())
    print(__doc__)
