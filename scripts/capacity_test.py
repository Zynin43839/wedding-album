#!/usr/bin/env python3
"""Capacity / rate-limit test for the album.

Answers three questions with numbers instead of guesses:
  1. how many uploads can hit the Worker at the same time before anything breaks
  2. how fast a photo comes back while that is happening (p50 / p95 / max)
  3. what the failure looks like when a limit is hit (status, Cloudflare body)

Usage
-----
  python scripts/capacity_test.py --base http://127.0.0.1:8787 --mode upload --concurrency 1 5 10 20 40
  python scripts/capacity_test.py --base https://... --mode view --concurrency 50 --count 200
  python scripts/capacity_test.py --base https://... --mode mixed --concurrency 20

Every object it writes uses guest `LOADTEST` and is left in place; clean with
  python scripts/clean_album.py --guest LOADTEST
"""
from __future__ import annotations

import argparse
import json
import statistics
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from io import BytesIO

from PIL import Image

CODE_DEFAULT = "demo-code"
GUEST = "LOADTEST"
# full browser UA: Cloudflare's managed rules answer 403 (error 1010) to clients
# whose User-Agent does not look like a browser
HDRS = {
    "user-agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
    )
}


def make_jpeg(kb: int) -> bytes:
    """A noise JPEG of roughly `kb` kilobytes.

    Noise on purpose: a flat image compresses to ~180 KB even at quality 92,
    which would understate the bandwidth a real photo uses. Sizing the canvas
    from the requested size lets the same script test a 5 KB thumbnail and an
    850 KB photo.
    """
    import math
    import random

    rnd = random.Random(7)
    side = max(32, min(1400, int(math.sqrt(kb * 1024 / 0.55))))
    im = Image.new("RGB", (side, side))
    px = im.load()
    for y in range(side):
        for x in range(side):
            px[x, y] = (rnd.randrange(256), rnd.randrange(256), rnd.randrange(256))
    buf = BytesIO()
    im.save(buf, "JPEG", quality=88)
    return buf.getvalue()


def post(url: str, body: bytes, ctype: str, timeout: float = 90):
    req = urllib.request.Request(url, data=body, method="POST", headers={**HDRS, "content-type": ctype})
    t0 = time.perf_counter()
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            r.read()
            return r.status, time.perf_counter() - t0, ""
    except urllib.error.HTTPError as e:
        body_txt = ""
        try:
            body_txt = e.read()[:200].decode("utf-8", "replace")
        except Exception:
            pass
        return e.code, time.perf_counter() - t0, body_txt
    except Exception as e:  # noqa: BLE001
        return 0, time.perf_counter() - t0, f"{type(e).__name__}: {e}"


def get(url: str, timeout: float = 90):
    t0 = time.perf_counter()
    try:
        with urllib.request.urlopen(urllib.request.Request(url, headers=HDRS), timeout=timeout) as r:
            body = r.read()
            return r.status, time.perf_counter() - t0, len(body)
    except urllib.error.HTTPError as e:
        return e.code, time.perf_counter() - t0, 0
    except Exception:  # noqa: BLE001
        return 0, time.perf_counter() - t0, 0


class Run:
    def __init__(self, label: str):
        self.label = label
        self.lock = threading.Lock()
        self.lat: list[float] = []
        self.codes: dict[int, int] = {}
        self.errors: dict[str, int] = {}
        self.bytes = 0

    def add(self, status: int, dt: float, err: str = "", nbytes: int = 0):
        with self.lock:
            self.lat.append(dt)
            self.codes[status] = self.codes.get(status, 0) + 1
            self.bytes += nbytes
            if err:
                key = f"{status} {err[:90]}"
                self.errors[key] = self.errors.get(key, 0) + 1

    def report(self) -> dict:
        lat = sorted(self.lat)
        n = len(lat) or 1

        def pct(p):
            return lat[min(n - 1, int(n * p))] * 1000

        ok = sum(v for k, v in self.codes.items() if 200 <= k < 300)
        return {
            "label": self.label,
            "requests": len(lat),
            "ok": ok,
            "fail": len(lat) - ok,
            "p50_ms": pct(0.50),
            "p95_ms": pct(0.95),
            "max_ms": lat[-1] * 1000 if lat else 0,
            "bytes": self.bytes,
            "codes": dict(sorted(self.codes.items())),
            "errors": self.errors,
        }


def run_concurrent(label: str, concurrency: int, total: int, fn) -> Run:
    r = Run(label)
    lock = threading.Lock()
    counter = {"i": 0}

    def worker():
        while True:
            with lock:
                if counter["i"] >= total:
                    return
                counter["i"] += 1
                idx = counter["i"]
            status, dt, err, nbytes = fn(idx)
            r.add(status, dt, err, nbytes)

    threads = [threading.Thread(target=worker) for _ in range(min(concurrency, total))]
    t0 = time.time()
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    r.wall = time.time() - t0
    return r


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", required=True)
    ap.add_argument("--code", default=CODE_DEFAULT)
    ap.add_argument("--mode", choices=["upload", "view", "mixed"], default="upload")
    ap.add_argument("--concurrency", type=int, nargs="+", default=[1, 5, 10, 20, 40])
    ap.add_argument("--count", type=int, default=0, help="requests per stage (default 4x concurrency)")
    ap.add_argument("--kb", type=int, default=900)
    ap.add_argument("--json", default="", help="write the raw results here")
    args = ap.parse_args()

    base = args.base.rstrip("/")
    payload = make_jpeg(args.kb)
    print(f"base    : {base}")
    print(f"payload : {len(payload) / 1024:.0f} KB per photo")
    print(f"mode    : {args.mode}")

    results = []

    if args.mode in ("view", "mixed"):
        req = urllib.request.Request(f"{base}/api/list?e={args.code}", headers=HDRS)
        with urllib.request.urlopen(req, timeout=60) as r:
            items = json.load(r)["items"]
        if not items:
            print("album is empty — upload something first")
            return 1
        media = [i["url"] if i["url"].startswith("http") else base + i["url"] for i in items]
        print(f"media   : {len(media)} objects available")

    for c in args.concurrency:
        total = args.count or c * 4

        if args.mode == "upload":
            def job(i, c=c):
                pid = f"load{int(time.time() * 1000)}-{i:04d}"
                q = urllib.parse.urlencode({"e": args.code, "id": pid, "kind": "photo", "ext": "jpg", "name": GUEST})
                st, dt, err = post(f"{base}/api/upload?{q}", payload, "image/jpeg")
                return st, dt, err, len(payload)

            run = run_concurrent(f"upload c={c}", c, total, job)

        elif args.mode == "view":
            def job(i):
                url = media[i % len(media)]
                st, dt, n = get(url)
                return st, dt, "", n

            run = run_concurrent(f"view c={c}", c, total, job)

        else:  # mixed: one uploader + viewers
            def job(i):
                if i % 3 == 0:
                    pid = f"load{int(time.time() * 1000)}-{i:04d}"
                    q = urllib.parse.urlencode({"e": args.code, "id": pid, "kind": "photo", "ext": "jpg", "name": GUEST})
                    st, dt, err = post(f"{base}/api/upload?{q}", payload, "image/jpeg")
                    return st, dt, err, len(payload)
                url = media[i % len(media)]
                st, dt, n = get(url)
                return st, dt, "", n

            run = run_concurrent(f"mixed c={c}", c, total, job)

        rep = run.report()
        rep["concurrency"] = c
        rep["wall_s"] = run.wall
        rep["rps"] = (rep["requests"] / run.wall) if run.wall else 0
        results.append(rep)

        print()
        print(f"--- {rep['label']}  ({rep['requests']} requests, {rep['rps']:.1f} req/s wall) ---")
        print(f"  ok/fail : {rep['ok']}/{rep['requests']}   codes={rep['codes']}")
        print(f"  latency : p50={rep['p50_ms']:.0f} ms  p95={rep['p95_ms']:.0f} ms  max={rep['max_ms']:.0f} ms")
        print(f"  data    : {rep['bytes'] / 1024 / 1024:.1f} MB")
        if rep["errors"]:
            print("  errors  :")
            for k, v in list(rep["errors"].items())[:5]:
                print(f"    {v}x {k}")

    if args.json:
        with open(args.json, "w", encoding="utf-8") as f:
            json.dump(results, f, ensure_ascii=False, indent=2)
        print(f"\nraw results -> {args.json}")

    bad = [r for r in results if r["fail"]]
    print()
    print("RESULT:", "PASS — no failed request" if not bad else f"{len(bad)} stage(s) had failures")
    return 0 if not bad else 1


if __name__ == "__main__":
    sys.exit(main())
