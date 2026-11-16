#!/usr/bin/env python3
"""Time the album endpoints from the outside, so the Worker's own numbers can be
compared against real user latency.

Runs each endpoint N times, in order, and prints status, bytes and total time.
Used together with `wrangler tail --format json`, which reports the Worker CPU
time per invocation (see docs/CPU-MEASUREMENTS.md).

Run:
  python scripts/page_bench.py --base https://wedding-album.rj-wedding.workers.dev
"""
from __future__ import annotations

import os

import argparse
import json
import time
import urllib.parse
import urllib.request

CODE = os.environ.get("EVENT_CODE", "demo-code")
UA = {"user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/131.0.0.0"}


def call(url: str):
    req = urllib.request.Request(url, headers=UA)
    t0 = time.perf_counter()
    with urllib.request.urlopen(req, timeout=90) as r:
        body = r.read()
    return r.status, len(body), (time.perf_counter() - t0) * 1000


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", required=True)
    ap.add_argument("--repeats", type=int, default=6)
    args = ap.parse_args()
    base = args.base.rstrip("/")

    st, n, _ = call(f"{base}/api/list?e={CODE}")
    data = json.loads(urllib.request.urlopen(urllib.request.Request(f"{base}/api/list?e={CODE}", headers=UA)).read())
    keys = [i["thumb"][3:] for i in data["items"] if i.get("thumb", "").startswith("/i/m/")]
    k = urllib.parse.urlencode({"e": CODE, "k": ",".join(keys[:15])})

    print(f"album: {len(data['items'])} items, bundling {min(len(keys), 15)} thumbs\n")
    print(f"{'endpoint':28} {'status':>6} {'KB':>8} {'ms':>8}")
    for i in range(args.repeats):
        st, size, ms = call(f"{base}/api/page?{k}")
        print(f"{'api/page #' + str(i + 1):28} {st:6} {size/1024:8.0f} {ms:8.0f}")
    for i in range(3):
        st, size, ms = call(f"{base}/api/list?e={CODE}")
        print(f"{'api/list #' + str(i + 1):28} {st:6} {size/1024:8.1f} {ms:8.0f}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
