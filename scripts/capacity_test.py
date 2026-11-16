#!/usr/bin/env python3
"""Capacity rehearsal: 650 guests x 10 uploads, paced, with a hard machine budget.

Why it is shaped like this
--------------------------
650 guests x 10 files = 6,500 files = 13,000 Worker requests. Cloudflare counts
requests, not bytes, so the rehearsal uses small files (60 KB) and paces them at
a rate the venue's aggregate traffic would produce (~25 req/s). That measures the
platform without needing 4.6 GB of uplink or a second machine.

Machine safety (the laptop must stay usable):
  * one Python process, N worker threads (default 20), no subprocesses
  * token-bucket rate limit (default 25 requests/s)
  * abort after 5 consecutive failures, or if RSS exceeds 400 MB
  * progress every 250 requests, chunked runs so a shell timeout cannot orphan work

Run in chunks:
  python scripts/capacity_test.py --guests 216 --start 0
  python scripts/capacity_test.py --guests 217 --start 216
  ...
  python scripts/capacity_test.py --summary
"""
from __future__ import annotations

import argparse
import json
import os
import pathlib
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

BASE = "https://wedding-album.rj-wedding.workers.dev"
CODE = os.environ.get("EVENT_CODE", "demo-code")
TOKEN = (pathlib.Path(os.environ["TEMP"]) / "opencode" / "purge_token.txt").read_text().strip()
STATE = pathlib.Path(os.environ["TEMP"]) / "opencode" / "capacity_state.json"
UA = {"user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/131.0.0.0"}

lock = threading.Lock()
stats = {"ok": 0, "fail": 0, "lat": [], "errors": {}, "consecutive_fail": 0, "aborted": False}
START = time.perf_counter()


def rss_mb() -> float:
    try:
        import ctypes
        from ctypes import wintypes

        class PMC(ctypes.Structure):
            _fields_ = [
                ("cb", wintypes.DWORD),
                ("PageFaultCount", wintypes.DWORD),
                ("PeakWorkingSetSize", ctypes.c_size_t),
                ("WorkingSetSize", ctypes.c_size_t),
                ("QuotaPeakPagedPoolUsage", ctypes.c_size_t),
                ("QuotaPagedPoolUsage", ctypes.c_size_t),
                ("QuotaPeakNonPagedPoolUsage", ctypes.c_size_t),
                ("QuotaNonPagedPoolUsage", ctypes.c_size_t),
                ("PagefileUsage", ctypes.c_size_t),
                ("PeakPagefileUsage", ctypes.c_size_t),
            ]

        pmc = PMC()
        pmc.cb = ctypes.sizeof(PMC)
        ctypes.windll.psapi.GetProcessMemoryInfo(ctypes.windll.kernel32.GetCurrentProcess(), ctypes.byref(pmc), pmc.cb)
        return pmc.WorkingSetSize / 1048576
    except Exception:
        return 0.0


class Bucket:
    """Simple token bucket so the whole run stays under --rate requests/second."""

    def __init__(self, rate: float, burst: float):
        self.rate = rate
        self.capacity = burst
        self.tokens = burst
        self.ts = time.perf_counter()
        self.lock = threading.Lock()

    def take(self):
        while True:
            with self.lock:
                now = time.perf_counter()
                self.tokens = min(self.capacity, self.tokens + (now - self.ts) * self.rate)
                self.ts = now
                if self.tokens >= 1:
                    self.tokens -= 1
                    return
                wait = (1 - self.tokens) / self.rate
            time.sleep(min(wait, 0.2))


def post(path: str, data: bytes, ctype: str) -> tuple[int, float, str]:
    req = urllib.request.Request(
        BASE + path, data=data, method="POST", headers={**UA, "content-type": ctype}
    )
    t0 = time.perf_counter()
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            r.read()
            return r.status, time.perf_counter() - t0, ""
    except urllib.error.HTTPError as e:
        return e.code, time.perf_counter() - t0, f"http{e.code}"
    except Exception as e:  # noqa: BLE001
        return 0, time.perf_counter() - t0, type(e).__name__


def one_file(bucket: Bucket, guest: int, idx: int, size: int) -> None:
    ident = f"cap{guest:03d}-{idx:02d}"
    for kind, nbytes, ctype in (("photo", size, "image/jpeg"), ("thumb", 12 * 1024, "image/jpeg")):
        if stats["aborted"]:
            return
        bucket.take()
        q = urllib.parse.urlencode({"e": CODE, "kind": kind, "id": ident, "name": f"LOADTEST-{guest:03d}", "ext": "jpg"})
        st, dt, err = post(f"/api/upload?{q}", os.urandom(nbytes), ctype)
        with lock:
            stats["lat"].append(dt)
            if st == 200:
                stats["ok"] += 1
                stats["consecutive_fail"] = 0
            else:
                stats["fail"] += 1
                stats["consecutive_fail"] += 1
                key = err or f"status{st}"
                stats["errors"][key] = stats["errors"].get(key, 0) + 1
                if stats["consecutive_fail"] >= 5:
                    stats["aborted"] = True


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--guests", type=int, default=216)
    ap.add_argument("--start", type=int, default=0)
    ap.add_argument("--files", type=int, default=10)
    ap.add_argument("--size-kb", type=int, default=60)
    ap.add_argument("--concurrency", type=int, default=20)
    ap.add_argument("--rate", type=float, default=25.0)
    ap.add_argument("--summary", action="store_true")
    args = ap.parse_args()

    if args.summary:
        if not STATE.exists():
            print("no state yet")
            return 1
        s = json.loads(STATE.read_text())
        print(json.dumps(s, indent=2))
        return 0

    bucket = Bucket(args.rate, burst=max(4, args.concurrency))
    print(
        f"chunk guests {args.start}..{args.start + args.guests - 1} · {args.files} files each · "
        f"{args.size_kb} KB · concurrency {args.concurrency} · rate {args.rate}/s"
    )

    queue = [(g, f) for g in range(args.start, args.start + args.guests) for f in range(args.files)]
    cursor = {"i": 0}
    progress = {"last": 0}

    def worker():
        while True:
            with lock:
                if cursor["i"] >= len(queue) or stats["aborted"]:
                    return
                g, f = queue[cursor["i"]]
                cursor["i"] += 1
            one_file(bucket, g, f, args.size_kb * 1024)
            with lock:
                done = stats["ok"] + stats["fail"]
                if done - progress["last"] >= 250:
                    progress["last"] = done
                    el = time.perf_counter() - START
                    print(
                        f"  {done}/{len(queue)*2} requests · {done/el:.1f}/s · "
                        f"fail {stats['fail']} · RSS {rss_mb():.0f} MB",
                        flush=True,
                    )
                if rss_mb() > 400:
                    stats["aborted"] = True
                    print("  ABORT: RSS over 400 MB", flush=True)

    threads = [threading.Thread(target=worker) for _ in range(args.concurrency)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    el = time.perf_counter() - START
    lat = sorted(stats["lat"])
    p50 = lat[len(lat) // 2] if lat else 0
    p95 = lat[int(len(lat) * 0.95) - 1] if lat else 0
    summary = {
        "chunk": [args.start, args.start + args.guests - 1],
        "requests_ok": stats["ok"],
        "requests_fail": stats["fail"],
        "seconds": round(el, 1),
        "req_per_s": round((stats["ok"] + stats["fail"]) / el, 2) if el else 0,
        "p50_s": round(p50, 2),
        "p95_s": round(p95, 2),
        "errors": stats["errors"],
        "aborted": stats["aborted"],
    }
    print(json.dumps(summary, indent=2))

    prev = json.loads(STATE.read_text()) if STATE.exists() else {"chunks": []}
    prev["chunks"].append(summary)
    STATE.write_text(json.dumps(prev, indent=2))
    return 0 if stats["fail"] == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
