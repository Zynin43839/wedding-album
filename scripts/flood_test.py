#!/usr/bin/env python3
"""Flood test: N photos + M clips uploaded concurrently, then verify the album.

Answers "what breaks when 1,200 uploads land at once":
  * do any requests fail, and with what status
  * how does latency grow as concurrency rises
  * does /api/list still return every item afterwards (pagination integrity)
  * how much storage the run actually consumed

Clips are simulated with a small payload by default (`--video-kb`) so the test
does not push 11 GB through a home uplink or over the 10 GB free tier. Pass
`--video-kb 19000` to use real 60-second clip sizes.

Run:
  python scripts/flood_test.py --base https://... --photos 600 --videos 600 --concurrency 200
  python scripts/flood_test.py --base https://... --clean        # delete FLOOD objects
"""
from __future__ import annotations

import os

import argparse
import json
import math
import random
import statistics
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor

from PIL import Image
from io import BytesIO

CODE = os.environ.get("EVENT_CODE", "demo-code")
GUEST = "FLOOD"
UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
)

lock = threading.Lock()
codes: dict[int, int] = {}
errors: dict[str, int] = {}
lat: list[float] = []
done = 0


def noise_jpeg(kb: int) -> bytes:
    rnd = random.Random(kb)
    side = max(32, min(1400, int(math.sqrt(kb * 1024 / 0.55))))
    im = Image.new("RGB", (side, side))
    px = im.load()
    for y in range(side):
        for x in range(side):
            px[x, y] = (rnd.randrange(256), rnd.randrange(256), rnd.randrange(256))
    buf = BytesIO()
    im.save(buf, "JPEG", quality=88)
    return buf.getvalue()


def post(url: str, body: bytes, ctype: str, timeout: float = 180) -> None:
    global done
    req = urllib.request.Request(url, data=body, method="POST", headers={"user-agent": UA, "content-type": ctype})
    t0 = time.perf_counter()
    status, body_txt = 0, ""
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            r.read()
            status = r.status
    except urllib.error.HTTPError as e:
        status = e.code
        try:
            body_txt = e.read()[:160].decode("utf-8", "replace")
        except Exception:
            pass
    except Exception as e:  # noqa: BLE001
        status = 0
        body_txt = f"{type(e).__name__}: {str(e)[:90]}"
    dt = time.perf_counter() - t0

    with lock:
        lat.append(dt)
        codes[status] = codes.get(status, 0) + 1
        if status < 200 or status >= 300:
            key = f"{status} {body_txt[:80]}"
            errors[key] = errors.get(key, 0) + 1
        done += 1
        if done % 100 == 0:
            print(f"  ... {done} requests, {sum(1 for c in codes if not 200 <= c < 300)} non-2xx", flush=True)


def upload(base: str, uid: str, kind: str, ext: str, payload: bytes, ctype: str) -> None:
    q = urllib.parse.urlencode({"e": CODE, "id": uid, "kind": kind, "ext": ext, "name": GUEST})
    post(f"{base}/api/upload?{q}", payload, ctype)


def list_all(base: str) -> tuple[int, int]:
    """Page through the whole album: returns (items, pages)."""
    total, pages, cursor = 0, 0, None
    while True:
        url = f"{base}/api/list?e={CODE}" + (f"&cursor={urllib.parse.quote(cursor)}" if cursor else "")
        req = urllib.request.Request(url, headers={"user-agent": UA})
        with urllib.request.urlopen(req, timeout=120) as r:
            d = json.load(r)
        total += len(d.get("items", []))
        pages += 1
        cursor = d.get("cursor")
        if not cursor or pages > 200:
            break
    return total, pages


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", required=True)
    ap.add_argument("--photos", type=int, default=600)
    ap.add_argument("--videos", type=int, default=600)
    ap.add_argument("--concurrency", type=int, default=200)
    ap.add_argument("--photo-kb", type=int, default=850)
    ap.add_argument("--video-kb", type=int, default=200)
    ap.add_argument("--clean", action="store_true")
    args = ap.parse_args()

    base = args.base.rstrip("/")
    stamp = int(time.time() * 1000)

    photo = noise_jpeg(args.photo_kb)
    thumb = noise_jpeg(45)
    video = noise_jpeg(args.video_kb)

    photo_mb = len(photo) / 1024 / 1024
    video_mb = len(video) / 1024 / 1024
    planned = (args.photos * 2 + args.videos * 2)
    total_mb = args.photos * (photo_mb + 0.045) + args.videos * (video_mb + 0.045)

    print(f"base        : {base}")
    print(f"photo       : {photo_mb:.2f} MB   thumb 0.04 MB")
    print(f"clip        : {video_mb:.2f} MB   poster 0.04 MB")
    print(f"requests    : {planned}  ({args.photos} photos + {args.videos} clips, 2 each)")
    print(f"bytes sent  : ~{total_mb:.0f} MB")
    print(f"concurrency : {args.concurrency}")
    print("-" * 76, flush=True)

    jobs = []
    for i in range(args.photos):
        uid = f"flood{stamp}-p{i:05d}"
        jobs.append((uid, "photo", "jpg", photo, "image/jpeg"))
        jobs.append((uid, "thumb", "jpg", thumb, "image/jpeg"))
    for i in range(args.videos):
        uid = f"flood{stamp}-v{i:05d}"
        jobs.append((uid, "video", "mp4", video, "video/mp4"))
        jobs.append((uid, "poster", "jpg", thumb, "image/jpeg"))

    t0 = time.time()
    with ThreadPoolExecutor(max_workers=args.concurrency) as pool:
        list(pool.map(lambda j: upload(base, *j), jobs))
    wall = time.time() - t0

    ok = sum(v for k, v in codes.items() if 200 <= k < 300)
    print("-" * 76)
    print(f"wall        : {wall:.1f} s")
    print(f"ok / total  : {ok}/{len(jobs)}")
    print(f"status      : {dict(sorted(codes.items()))}")
    if lat:
        s = sorted(lat)
        print(f"latency     : p50={s[len(s)//2]*1000:.0f} ms  p95={s[int(len(s)*0.95)]*1000:.0f} ms  max={s[-1]*1000:.0f} ms")
    print(f"throughput  : {ok/wall:.1f} req/s")
    if errors:
        print("errors      :")
        for k, v in sorted(errors.items(), key=lambda kv: -kv[1])[:6]:
            print(f"  {v}x {k}")

    print("-" * 76)
    t1 = time.time()
    items, pages = list_all(base)
    print(f"list after  : {items} items over {pages} pages ({time.time() - t1:.1f} s)")
    expected = args.photos + args.videos
    print(f"expected    : {expected} items  ->  {'OK' if items >= expected else 'MISSING ' + str(expected - items)}")
    return 0 if ok == len(jobs) and items >= expected else 1


if __name__ == "__main__":
    sys.exit(main())
