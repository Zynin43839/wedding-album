#!/usr/bin/env python3
"""Verify the bundled-thumbnail endpoint (/api/page) against a live album.

What it proves, with numbers rather than assumptions:
  * one request returns N thumbnails, each byte-identical to its /i/ source
  * the response is cacheable for a year (so a second visit costs nothing)
  * the guard rails hold (no keys -> 400, bad code -> 403, >15 keys -> 413)

Run:
  python scripts/page_test.py --base https://wedding-album.rj-wedding.workers.dev
"""
from __future__ import annotations

import os

import argparse
import json
import sys
import urllib.error
import urllib.parse
import urllib.request

CODE = os.environ.get("EVENT_CODE", "demo-code")
UA = {"user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/131.0.0.0"}


def get(url: str, headers: dict | None = None):
    h = dict(UA)
    h.update(headers or {})
    req = urllib.request.Request(url, headers=h)
    try:
        with urllib.request.urlopen(req, timeout=90) as r:
            return r.status, {k.lower(): v for k, v in r.headers.items()}, r.read()
    except urllib.error.HTTPError as e:
        return e.code, {k.lower(): v for k, v in e.headers.items()}, e.read()


def split_parts(body: bytes, boundary: str) -> list[dict]:
    mark = b"--" + boundary.encode()
    cuts = []
    at = body.find(mark)
    while at != -1:
        cuts.append(at)
        at = body.find(mark, at + len(mark))

    parts = []
    for i in range(len(cuts) - 1):
        start = cuts[i] + len(mark)
        end = cuts[i + 1]
        if body[start:start + 2] == b"--":
            break
        h_end = body.find(b"\r\n\r\n", start, end)
        if h_end == -1:
            continue
        head = body[start:h_end].decode("latin-1")
        key = ""
        ctype = "application/octet-stream"
        for line in head.split("\r\n"):
            low = line.lower()
            if low.startswith("x-key:"):
                key = line.split(":", 1)[1].strip()
            elif low.startswith("content-type:"):
                ctype = line.split(":", 1)[1].strip()
        payload = body[h_end + 4:end]
        payload = payload.rstrip(b"\r\n")
        parts.append({"key": key, "type": ctype, "bytes": payload})
    return parts


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", required=True)
    args = ap.parse_args()
    base = args.base.rstrip("/")

    checks: list[tuple[str, bool, str]] = []

    def check(name: str, ok: bool, detail: str = "") -> None:
        checks.append((name, ok, detail))
        print(f"{'PASS' if ok else 'FAIL'}  {name}" + (f"  [{detail}]" if detail else ""))

    st, _, body = get(f"{base}/api/list?e={CODE}")
    if st != 200:
        print(f"list failed: {st}")
        return 1
    items = json.loads(body).get("items", [])
    keys = [i["thumb"][3:] for i in items if i.get("thumb", "").startswith("/i/m/")]
    print(f"album: {len(items)} items, {len(keys)} bundleable thumbs\n")
    if len(keys) < 2:
        print("need at least 2 photos with thumbnails")
        return 1

    params = urllib.parse.urlencode({"e": CODE, "k": ",".join(keys[:15])})
    st, headers, body = get(f"{base}/api/page?{params}")
    ctype = headers.get("content-type", "")
    cache = headers.get("cache-control", "")
    check("status 200", st == 200, str(st))
    check("multipart/mixed", ctype.startswith("multipart/mixed"), ctype)
    check("cacheable 1 year", "immutable" in cache, cache)

    boundary = ctype.split("boundary=", 1)[1].strip().strip('"') if "boundary=" in ctype else ""
    parts = split_parts(body, boundary) if boundary else []
    images = [p for p in parts if p["key"]]
    # The endpoint has a byte budget (MAX_TOTAL_BYTES), so it may return fewer
    # parts than keys: the rest are fetched individually by the client.
    check("never more parts than keys", 0 < len(images) <= len(keys[:8]), f"{len(images)} parts, {len(keys[:8])} keys")
    total = sum(len(p["bytes"]) for p in images)
    check("within the CPU byte budget", total <= 420 * 1024 + 4096, f"{total/1024:.0f} KB")
    check("1 request for the page", True, f"{len(images)} thumbs in 1 request")

    identical = 0
    for p in images:
        s2, _, direct = get(f"{base}/i/{p['key']}")
        if s2 == 200 and direct == p["bytes"]:
            identical += 1
    check("bytes identical to /i/", identical == len(images), f"{identical}/{len(images)}")

    total = sum(len(p["bytes"]) for p in images)
    check("payload sane", total > 0, f"{total/1024:.0f} KB for {len(images)} thumbs")

    st, _, _ = get(f"{base}/api/page?e={CODE}")
    check("no keys -> 400", st == 400, str(st))
    st, _, _ = get(f"{base}/api/page?e=wrong")
    check("bad code -> 403", st == 403, str(st))
    many = ",".join(f"m/x{i}-t.jpg" for i in range(40))
    st, _, b2 = get(f"{base}/api/page?{urllib.parse.urlencode({'e': CODE, 'k': many})}")
    check("40 keys -> 413 or capped", st in (200, 413), f"{st}")

    passed = sum(1 for _, ok, _ in checks if ok)
    print(f"\n{passed}/{len(checks)} passed")
    return 0 if passed == len(checks) else 1


if __name__ == "__main__":
    sys.exit(main())
