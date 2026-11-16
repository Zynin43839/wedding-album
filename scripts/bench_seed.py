#!/usr/bin/env python3
"""Seed a realistic page (15+ items) so `/api/page` can be measured at full size.

The album normally holds only the 8 demo images, which is too few to measure a
full 15-thumbnail bundle. This uploads copies of the existing demo images under
a distinct guest name (`BENCH`) so they can be removed afterwards with

    python scripts/purge.py --base <url> --token <SYNC_TOKEN> --guest BENCH

Run:
  python scripts/bench_seed.py --base https://wedding-album.rj-wedding.workers.dev --count 8
"""
from __future__ import annotations

import argparse
import json
import time
import urllib.parse
import urllib.request

CODE = "demo-code"
UA = {"user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/131.0.0.0"}
GUEST = "BENCH"


def get(url: str) -> bytes:
    return urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=90).read()


def post(url: str, body: bytes, ctype: str) -> tuple[int, bytes]:
    req = urllib.request.Request(url, data=body, method="POST", headers={**UA, "content-type": ctype})
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            return r.status, r.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", required=True)
    ap.add_argument("--count", type=int, default=8)
    args = ap.parse_args()
    base = args.base.rstrip("/")

    items = json.loads(get(f"{base}/api/list?e={CODE}"))["items"]
    sources = []
    for it in items:
        if it.get("type") != "photo":
            continue
        thumb = it.get("thumb") or it.get("url")
        sources.append(get(base + thumb))
        if len(sources) >= args.count:
            break
    if not sources:
        print("no demo images to copy")
        return 1

    print(f"seeding {len(sources)} items as guest {GUEST}")
    stamp = int(time.time() * 1000)
    for i, data in enumerate(sources):
        # ids are timestamp-inverted in the app, but any unique id works here
        ident = f"bench{stamp}{i:02d}"
        q = urllib.parse.urlencode(
            {"e": CODE, "kind": "photo", "id": ident, "name": GUEST, "ext": "jpg"}
        )
        st, _ = post(f"{base}/api/upload?{q}", data, "image/jpeg")
        q2 = urllib.parse.urlencode(
            {"e": CODE, "kind": "thumb", "id": ident, "name": GUEST, "ext": "jpg"}
        )
        st2, _ = post(f"{base}/api/upload?{q2}", data, "image/jpeg")
        print(f"  [{i+1}/{len(sources)}] {ident} main={st} thumb={st2}", flush=True)

    total = len(json.loads(get(f"{base}/api/list?e={CODE}"))["items"])
    print(f"album now {total} items")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
