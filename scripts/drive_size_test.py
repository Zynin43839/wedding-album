#!/usr/bin/env python3
"""Measure how Drive archive time scales with file size.

Uploads three files of very different sizes, pushes each one on its own
(`/api/sync?limit=1`), and reports seconds per file. That separates the fixed
per-request cost (R2 get + Drive start + PUT + marker) from the per-MB cost, so
the time for any volume (5 GB, a wedding's 20 GB) is computed from measurements
instead of guessed.

Everything it creates is removed afterwards (objects + synced markers).

Run:
  python scripts/drive_size_test.py --base <url> --token <SYNC_TOKEN>
"""
from __future__ import annotations

import argparse
import json
import os
import time
import urllib.error
import urllib.parse
import urllib.request

CODE = "demo-code"
UA = {"user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/131.0.0.0"}


def api(base: str, path: str, headers: dict | None = None, body: bytes | None = None,
        ctype: str | None = None, method: str | None = None, timeout: int = 300):
    h = dict(UA)
    h.update(headers or {})
    if ctype:
        h["content-type"] = ctype
    req = urllib.request.Request(base + path, data=body, headers=h, method=method)
    t0 = time.perf_counter()
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            payload = r.read()
            return r.status, json.loads(payload or b"{}"), time.perf_counter() - t0
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b"{}"), time.perf_counter() - t0


def upload(base: str, ident: str, data: bytes, kind: str, ctype: str) -> tuple[int, float]:
    q = urllib.parse.urlencode(
        {"e": CODE, "kind": kind, "id": ident, "name": "SIZETEST", "ext": "mp4" if kind == "video" else "jpg"}
    )
    st, _, dt = api(base, f"/api/upload?{q}", body=data, ctype=ctype)
    return st, dt


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", required=True)
    ap.add_argument("--token", required=True)
    args = ap.parse_args()
    base = args.base.rstrip("/")
    hdr = {"x-sync-token": args.token}

    stamp = int(time.time())
    cases = [
        ("small 140 KB", f"szt{stamp}a", 140 * 1024, "photo", "image/jpeg"),
        ("photo 2 MB", f"szt{stamp}b", 2 * 1024 * 1024, "photo", "image/jpeg"),
        ("clip 19 MB", f"szt{stamp}c", 19 * 1024 * 1024, "video", "video/mp4"),
    ]

    print(f"{'case':14} {'upload s':>9} {'sync s':>8} {'MB':>7} {'MB/s':>7} {'obj/min':>8}")
    print("-" * 62)
    rows = []
    for label, ident, size, kind, ctype in cases:
        payload = os.urandom(size)
        st, up_dt = upload(base, ident, payload, kind, ctype)
        if st != 200:
            print(f"{label:14} upload failed: {st}")
            continue
        st, d, sync_dt = api(base, "/api/sync?limit=1", hdr)
        pushed = d.get("pushed", 0) if st == 200 else 0
        mb = size / 1048576
        rate = mb / sync_dt if sync_dt else 0
        print(f"{label:14} {up_dt:9.1f} {sync_dt:8.1f} {mb:7.2f} {rate:7.2f} {60/sync_dt if sync_dt else 0:8.1f}")
        rows.append({"label": label, "size_mb": mb, "sync_s": sync_dt, "pushed": pushed})

    print()
    if len(rows) >= 2:
        # linear fit: seconds = a + b * MB, using the smallest and the largest case
        small, large = min(rows, key=lambda r: r["size_mb"]), max(rows, key=lambda r: r["size_mb"])
        b = (large["sync_s"] - small["sync_s"]) / (large["size_mb"] - small["size_mb"]) if large["size_mb"] != small["size_mb"] else 0
        a = small["sync_s"] - b * small["size_mb"]
        print(f"model: sync_s ≈ {a:.2f} s fixed + {b:.2f} s per MB")
        for target_mb in (1024, 5 * 1024, 20 * 1024):
            secs = a + b * target_mb
            print(f"  {target_mb/1024:5.1f} GB -> {secs/3600:6.1f} h ({target_mb/ (secs/60):6.1f} MB/min)")

    # clean up whatever this test created (objects + markers); purge needs its own header
    keys = []
    st, d, _ = api(base, f"/api/list?e={CODE}")
    for it in d.get("items", []):
        if str(it.get("guest")) == "SIZETEST":
            for f in ("url", "thumb"):
                u = it.get(f) or ""
                if "/i/" in u:
                    k = u.split("/i/", 1)[1]
                    keys.append(k)
                    keys.append("synced/" + k)
    keys = list(dict.fromkeys(k for k in keys if k))
    st, d, _ = api(
        base,
        "/api/purge",
        {"x-sync-token": args.token, "x-purge-token": args.token},
        body=json.dumps({"keys": keys}).encode(),
        ctype="application/json",
    )
    print(f"\ncleanup: {d.get('deleted', '?')} objects removed" if st == 200 else f"\ncleanup failed: {st} {d}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
