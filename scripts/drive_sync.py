#!/usr/bin/env python3
"""Drive the album's archive loop and MEASURE it.

`POST /api/sync` pushes one batch and reports what it did. This script calls it
repeatedly until nothing is left, timing every batch, so the answer to "how long
does the Drive archive take" comes from measurements rather than arithmetic.

Why a loop and not a CLI-per-file: the Worker does the pushing (it holds the
OAuth refresh token); this process only sends ~1 HTTP request per batch, so the
Bulk Operation Law is respected (no per-file process, no npx).

Limits that shape the batch size (both measured on this account, 2026-11-16):
  * 50 fetch subrequests per invocation  -> 25 files at 2 fetches each
  * 999 R2/API requests per invocation   -> not the binding constraint here

Usage
-----
  python scripts/drive_sync.py --base <url> --token <SYNC_TOKEN> --dry
  python scripts/drive_sync.py --base <url> --token <SYNC_TOKEN> --limit 25
"""
from __future__ import annotations

import argparse
import json
import time
import urllib.error
import urllib.request

UA = {"user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/131.0.0.0"}


def call(url: str, headers: dict, timeout: int = 300):
    req = urllib.request.Request(url, headers={**UA, **headers})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, json.load(r)
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read() or b"{}")
        except Exception:
            return e.code, {"error": "unreadable"}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", required=True)
    ap.add_argument("--token", required=True)
    ap.add_argument("--limit", type=int, default=25)
    ap.add_argument("--dry", action="store_true")
    ap.add_argument("--max-batches", type=int, default=0, help="0 = until done")
    args = ap.parse_args()

    base = args.base.rstrip("/")
    hdr = {"x-sync-token": args.token}

    st, d = call(f"{base}/api/sync?dry=1&limit={args.limit}", hdr, 120)
    if st != 200:
        print(f"dry run failed: {st} {d}")
        return 1
    pending = d.get("pending", 0)
    marked = d.get("marked", 0)
    print(f"album: {marked} objects already in Drive, {pending} waiting in this window")
    if args.dry or not pending:
        return 0

    print(f"\nbatch = {args.limit} objects (fetch budget 50 / 2 per file)")
    print(f"{'batch':>5} {'pushed':>6} {'bytes':>9} {'fail':>4} {'left':>6} {'sec':>6} {'obj/min':>8} {'MB/min':>7}")
    print("-" * 62)

    total_pushed = 0
    total_bytes = 0
    failures = 0
    t_start = time.time()
    batch = 0

    while True:
        batch += 1
        t0 = time.time()
        st, d = call(f"{base}/api/sync?limit={args.limit}", hdr)
        dt = time.time() - t0
        if st != 200:
            print(f"batch {batch}: HTTP {st} {d}")
            return 1

        pushed = d.get("pushed", 0)
        size = d.get("bytes", 0)
        failed = d.get("failed", 0)
        left = d.get("left", 0)

        total_pushed += pushed
        total_bytes += size
        failures += failed

        obj_min = pushed / dt * 60 if dt > 0 else 0
        mb_min = size / dt * 60 / 1048576 if dt > 0 else 0
        print(
            f"{batch:5} {pushed:6} {size/1048576:8.2f}M {failed:4} {left:6} {dt:6.1f} {obj_min:8.1f} {mb_min:7.2f}"
        )

        if pushed == 0 and failed == 0:
            print("nothing moved (pending list empty or all failing) — stopping")
            break
        if args.max_batches and batch >= args.max_batches:
            print(f"stopped after {args.max_batches} batches")
            break
        if pushed == 0 and failed > 0:
            print("every object in this batch failed — stopping so the error can be read")
            print(json.dumps(d.get("errors", []), ensure_ascii=False, indent=2))
            break

    elapsed = time.time() - t_start
    print("-" * 62)
    print(
        f"total: {total_pushed} objects, {total_bytes/1048576:.1f} MB in {elapsed/60:.1f} min "
        f"({total_pushed/elapsed*60 if elapsed else 0:.1f} objects/min, "
        f"{total_bytes/elapsed*60/1048576 if elapsed else 0:.2f} MB/min)"
    )
    if failures:
        print(f"WARNING: {failures} objects failed and will be retried on the next run")

    st, d = call(f"{base}/api/sync?dry=1&limit={args.limit}", hdr, 120)
    if st == 200:
        print(f"remaining: {d.get('pending', 0)} objects")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
