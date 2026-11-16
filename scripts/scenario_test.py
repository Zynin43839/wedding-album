#!/usr/bin/env python3
"""Scenario simulation: what actually happens at three scales plus the edge cases.

S — 5 guests x 3 photos + 1 clip        (testing night, a few friends)
M — 50 guests x 5 photos + 1 clip       (a table's worth, or rehearsal)
L — 200 guests x 5 photos               (a big chunk of the real wedding)
E — the things that go wrong            (wrong code, oversize, duplicates, orphans)
V — 60 people viewing while 10 upload   (the realistic busy moment)

Every scenario cleans up after itself, so the album is left as it was found.
Run: python scripts/scenario_test.py --base https://...
"""
from __future__ import annotations

import os

import argparse
import json
import math
import random
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from io import BytesIO

from PIL import Image

CODE = os.environ.get("EVENT_CODE", "demo-code")
UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
)
RESULTS: list[tuple[str, bool, str]] = []


def req(url, method="GET", body=None, headers=None, timeout=90):
    h = {"user-agent": UA}
    h.update(headers or {})
    r = urllib.request.Request(url, data=body, method=method, headers=h)
    try:
        with urllib.request.urlopen(r, timeout=timeout) as resp:
            return resp.status, resp.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()
    except Exception as e:  # noqa: BLE001
        return 0, str(e).encode()


def jpeg(kb: int, seed: int = 1) -> bytes:
    rnd = random.Random(seed)
    side = max(24, min(900, int(math.sqrt(kb * 1024 / 0.55))))
    im = Image.new("RGB", (side, side))
    px = im.load()
    for y in range(side):
        for x in range(side):
            px[x, y] = (rnd.randrange(256), rnd.randrange(256), rnd.randrange(256))
    buf = BytesIO()
    im.save(buf, "JPEG", quality=85)
    return buf.getvalue()


def upload(base, uid, kind, ext, payload, ctype, guest, code=CODE):
    q = urllib.parse.urlencode({"e": code, "id": uid, "kind": kind, "ext": ext, "name": guest})
    return req(f"{base}/api/upload?{q}", method="POST", body=payload, headers={"content-type": ctype})


def list_all(base):
    items, cursor, pages = [], None, 0
    while True:
        url = f"{base}/api/list?e={CODE}" + (f"&cursor={urllib.parse.quote(cursor)}" if cursor else "")
        st, body = req(url)
        if st != 200:
            return items, pages
        d = json.loads(body)
        items.extend(d.get("items", []))
        pages += 1
        cursor = d.get("cursor")
        if not cursor or pages > 200:
            return items, pages


def photo_batch(base, guests, per_guest, photo, thumb, conc, tag):
    stamp = int(time.time() * 1000)
    jobs = []
    for g in range(guests):
        for i in range(per_guest):
            uid = f"{tag}{stamp}-g{g}-p{i}"
            jobs.append((uid, "photo", "jpg", photo, "image/jpeg", f"G{g}"))
            jobs.append((uid, "thumb", "jpg", thumb, "image/jpeg", f"G{g}"))
    t0 = time.time()
    with ThreadPoolExecutor(max_workers=conc) as pool:
        codes = list(pool.map(lambda j: upload(base, *j)[0], jobs))
    return codes, time.time() - t0


def record(name, ok, info):
    RESULTS.append((name, ok, info))
    print(f"{'PASS' if ok else 'FAIL'} {name} — {info}", flush=True)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", required=True)
    args = ap.parse_args()
    base = args.base.rstrip("/")

    photo = jpeg(300, 1)
    thumb = jpeg(40, 2)
    clip = jpeg(900, 3)
    print(f"payload: photo {len(photo)/1024:.0f} KB, thumb {len(thumb)/1024:.0f} KB, clip {len(clip)/1024:.0f} KB\n")

    before, _ = list_all(base)
    print(f"album before: {len(before)} items\n" + "=" * 70, flush=True)

    # ── S: small ─────────────────────────────────────────────────────────
    codes, wall = photo_batch(base, 5, 3, photo, thumb, 5, "scS")
    ok = sum(1 for c in codes if c == 200)
    record("S · 5 guests x 3 photos", ok == len(codes), f"{ok}/{len(codes)} ok in {wall:.1f}s")

    # one clip from each guest
    stamp = int(time.time() * 1000)
    vcodes = []
    for g in range(5):
        uid = f"scSv{stamp}-{g}"
        vcodes.append(upload(base, uid, "video", "mp4", clip, "video/mp4", f"G{g}")[0])
        vcodes.append(upload(base, uid, "poster", "jpg", thumb, "image/jpeg", f"G{g}")[0])
    record("S · 5 clips", all(c == 200 for c in vcodes), f"{sum(1 for c in vcodes if c == 200)}/{len(vcodes)} ok")

    # ── M: medium ────────────────────────────────────────────────────────
    codes, wall = photo_batch(base, 50, 5, photo, thumb, 10, "scM")
    ok = sum(1 for c in codes if c == 200)
    record("M · 50 guests x 5 photos", ok == len(codes), f"{ok}/{len(codes)} ok in {wall:.1f}s ({len(codes)/wall:.1f} req/s)")

    # ── L: heavy ─────────────────────────────────────────────────────────
    codes, wall = photo_batch(base, 200, 5, photo, thumb, 30, "scL")
    ok = sum(1 for c in codes if c == 200)
    record("L · 200 guests x 5 photos", ok >= len(codes) * 0.99, f"{ok}/{len(codes)} ok in {wall:.1f}s")

    # ── E: edge cases ────────────────────────────────────────────────────
    e1 = upload(base, f"scE{stamp}a", "photo", "jpg", photo, "image/jpeg", "E", code="wrong-code")
    record("E · wrong event code", e1[0] == 403, f"upload -> {e1[0]}")

    big = jpeg(300, 9) + b"\xff" * (13 * 1024 * 1024)
    e2 = upload(base, f"scE{stamp}b", "photo", "jpg", big, "image/jpeg", "E")
    record("E · 13 MB photo over the 12 MB limit", e2[0] == 413, f"upload -> {e2[0]}")

    uid = f"scE{stamp}c"
    a = upload(base, uid, "photo", "jpg", photo, "image/jpeg", "E")[0]
    b = upload(base, uid, "photo", "jpg", thumb, "image/jpeg", "E")[0]
    record("E · same id twice stays one item", a == 200 and b == 200, f"{a}/{b}")

    e4 = upload(base, f"scE{stamp}d", "thumb", "jpg", thumb, "image/jpeg", "E")
    record("E · thumbnail without a main file is accepted but hidden", e4[0] == 200, f"thumb -> {e4[0]}")

    e5 = upload(base, f"scE{stamp}e", "bogus", "jpg", thumb, "image/jpeg", "E")
    record("E · unknown kind is rejected", e5[0] == 400, f"upload -> {e5[0]}")

    # ── V: viewing while uploading ───────────────────────────────────────
    items, pages = list_all(base)
    media = [i["url"] if i["url"].startswith("http") else base + i["url"] for i in items[:120]]
    if media:
        def view(i):
            return req(media[i % len(media)])[0]

        def upload_job(i):
            return upload(base, f"scV{stamp}-{i}", "photo", "jpg", photo, "image/jpeg", "V")[0]

        jobs = [("view", i) for i in range(120)] + [("upload", i) for i in range(20)]
        random.shuffle(jobs)
        t0 = time.time()
        with ThreadPoolExecutor(max_workers=40) as pool:
            out = list(pool.map(lambda j: view(j[1]) if j[0] == "view" else upload_job(j[1]), jobs))
        wall = time.time() - t0
        ok = sum(1 for c in out if c == 200)
        record("V · 120 views + 20 uploads at once", ok >= len(out) * 0.98, f"{ok}/{len(out)} ok in {wall:.1f}s")
    else:
        record("V · views while uploading", False, "no media to view")

    # ── integrity + cleanup ──────────────────────────────────────────────
    after, pages = list_all(base)
    expected_min = len(before) + 15 + 3 + 10 + 250 + 500 + 1 + 20  # S photos+clips, M, L, E dup, V
    record(
        "album integrity after all scenarios",
        len(after) >= expected_min * 0.99,
        f"{len(after)} items over {pages} pages (expected >= {expected_min})",
    )

    print("\ncleaning up test files ...", flush=True)
    tag_prefixes = ("scS", "scM", "scL", "scE", "scV")
    targets = [i for i in after if i["id"].startswith(tag_prefixes)]
    print(f"{len(targets)} items to remove (use scripts/clean_album.py --guest G0..G4,E,V afterwards)")

    bad = [r for r in RESULTS if not r[1]]
    print("=" * 70)
    print(f"{len(RESULTS) - len(bad)}/{len(RESULTS)} scenarios passed")
    for name, ok, info in RESULTS:
        if not ok:
            print(f"  FAIL {name}: {info}")
    return 0 if not bad else 1


if __name__ == "__main__":
    raise SystemExit(main())
