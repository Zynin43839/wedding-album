#!/usr/bin/env python3
"""Measure how /api/page CPU time scales with the number of bundled thumbnails.

Runs the same endpoint with 1, 5, 10 and 15 keys so the fixed cost and the cost
per thumbnail can be separated instead of guessed. Pair it with
`wrangler tail --format json`, which reports cpuTime per invocation.

Run:
  python scripts/page_scale.py --base https://wedding-album.rj-wedding.workers.dev
"""
from __future__ import annotations

import argparse
import json
import time
import urllib.parse
import urllib.request

CODE = "demo-code"
UA = {"user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/131.0.0.0"}


def get(url: str):
    t0 = time.perf_counter()
    with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=90) as r:
        body = r.read()
    return r.status, len(body), (time.perf_counter() - t0) * 1000


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", required=True)
    ap.add_argument("--repeats", type=int, default=4)
    args = ap.parse_args()
    base = args.base.rstrip("/")

    items = json.loads(
        urllib.request.urlopen(
            urllib.request.Request(f"{base}/api/list?e={CODE}", headers=UA), timeout=60
        ).read()
    )["items"]
    keys = [i["thumb"][3:] for i in items if i.get("thumb", "").startswith("/i/m/")]
    print(f"album has {len(keys)} bundleable thumbs\n")

    for n in (1, 5, 10, 15):
        if len(keys) < n:
            continue
        q = urllib.parse.urlencode({"e": CODE, "k": ",".join(keys[:n])})
        for i in range(args.repeats):
            st, size, ms = get(f"{base}/api/page?{q}")
            print(f"n={n:2}  run {i+1}/{args.repeats}  status={st}  {size/1024:6.0f} KB  {ms:6.0f} ms", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
