#!/usr/bin/env python3
"""Stability probes: hit the edges the happy-path suites never touch.

Each case is written to answer one question about the code, and prints the raw
response so a finding can be argued from evidence, not opinion.

Run:
  python scripts/stability_test.py --base https://wedding-album.rj-wedding.workers.dev
  python scripts/stability_test.py --base http://127.0.0.1:8787

Objects written by this suite use ids starting with `stab` and guest `STABTEST`;
clean with: python scripts/clean_album.py --guest STABTEST
"""
from __future__ import annotations

import argparse
import json
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from io import BytesIO

from PIL import Image

CODE = "demo-code"
GUEST = "STABTEST"
UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
)

FINDINGS: list[tuple[str, str, str]] = []  # (id, verdict, detail)


def req(url, method="GET", body=None, headers=None, timeout=60):
    h = {"user-agent": UA}
    h.update(headers or {})
    r = urllib.request.Request(url, data=body, method=method, headers=h)
    try:
        with urllib.request.urlopen(r, timeout=timeout) as resp:
            return resp.status, dict(resp.headers), resp.read()
    except urllib.error.HTTPError as e:
        return e.code, dict(e.headers), e.read()
    except Exception as e:  # noqa: BLE001
        return 0, {}, str(e).encode()


def jpeg(px=64, quality=80) -> bytes:
    im = Image.new("RGB", (px, px), (200, 180, 170))
    buf = BytesIO()
    im.save(buf, "JPEG", quality=quality)
    return buf.getvalue()


def upload(base, uid, kind="photo", ext="jpg", payload=None, ctype="image/jpeg", name=GUEST, extra=""):
    q = urllib.parse.urlencode({"e": CODE, "id": uid, "kind": kind, "ext": ext, "name": name})
    return req(f"{base}/api/upload?{q}{extra}", method="POST", body=payload if payload is not None else jpeg(), headers={"content-type": ctype})


def list_ids(base):
    st, _, body = req(f"{base}/api/list?e={CODE}")
    if st != 200:
        return st, []
    return st, [i["id"] for i in json.loads(body).get("items", [])]


def case(cid, question, fn):
    try:
        verdict, detail = fn()
    except Exception as e:  # noqa: BLE001
        verdict, detail = "ERROR", f"{type(e).__name__}: {e}"
    FINDINGS.append((cid, verdict, detail))
    mark = {"OK": "PASS", "BUG": "FAIL", "WARN": "WARN", "INFO": "INFO"}.get(verdict, verdict)
    print(f"{mark} {cid}  {question}")
    print(f"        {detail}")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", required=True)
    args = ap.parse_args()
    base = args.base.rstrip("/")

    stamp = int(time.time() * 1000)
    pid = f"stab{stamp}"
    vid = f"stabv{stamp}"

    print(f"target: {base}\n" + "=" * 78)

    # ── S01 media HEAD ────────────────────────────────────────────────────
    def s01():
        upload(base, pid)
        st, h, body = req(f"{base}/i/m/{pid}.jpg", method="HEAD")
        cl = h.get("content-length") or h.get("Content-Length")
        return ("OK" if st == 200 else "BUG"), f"HEAD /i/ -> {st}, content-length={cl}"

    # ── S02 Range request (video seeking on iOS needs 206) ────────────────
    def s02():
        vidbx = _mk_video(base, vid)
        st, h, body = req(f"{base}/i/m/{vidbx}.mp4", headers={"range": "bytes=0-99"})
        cr = h.get("content-range") or h.get("Content-Range")
        ar = h.get("accept-ranges") or h.get("Accept-Ranges")
        if st == 206:
            return "OK", f"Range -> 206, content-range={cr}"
        return "BUG", f"Range -> {st} (expected 206), accept-ranges={ar}, body={len(body)}B"

    # ── S03 same id uploaded twice ───────────────────────────────────────
    def s03():
        a = upload(base, f"{pid}", payload=jpeg(80))
        b = upload(base, f"{pid}", payload=jpeg(96))
        _, ids = list_ids(base)
        n = ids.count(pid)
        return ("OK" if a[0] == 200 and b[0] == 200 and n == 1 else "BUG"), f"two uploads same id -> {a[0]}/{b[0]}, album entries={n}"

    # ── S04 thumbnail lands before the main file ─────────────────────────
    def s04():
        tid = f"stabt{stamp}"
        upload(base, tid, kind="thumb", payload=jpeg(48))
        _, before = list_ids(base)
        upload(base, tid, kind="photo", payload=jpeg(64))
        _, after = list_ids(base)
        if tid in before:
            return "WARN", "thumbnail-only id appeared in the album (item without a main file?)"
        return ("OK" if tid in after else "BUG"), f"thumb-first hidden={tid not in before}, visible after main={tid in after}"

    # ── S05 zero-byte upload ─────────────────────────────────────────────
    def s05():
        zid = f"stabz{stamp}"
        st, _, body = upload(base, zid, payload=b"")
        # 411 (no content-length) and 400/413 are all correct rejections
        ok = st in (400, 411, 413)
        return ("OK" if ok else "BUG"), f"0-byte upload -> {st} {body[:80]!r}"

    # ── S06 bogus cursor ─────────────────────────────────────────────────
    def s06():
        st, _, body = req(f"{base}/api/list?e={CODE}&cursor=not-a-real-cursor")
        ok = st in (200, 400)
        return ("OK" if ok else "BUG"), f"bad cursor -> {st} {body[:90]!r}"

    # ── S07 ext sanitising ───────────────────────────────────────────────
    def s07():
        eid = f"stabe{stamp}"
        st, _, body = upload(base, eid, ext="jpg.exe")
        return ("OK" if st == 400 else "WARN"), f"ext='jpg.exe' -> {st} {body[:70]!r}"

    # ── S08 uppercase id ─────────────────────────────────────────────────
    def s08():
        uid = f"stabU{stamp}"
        st, _, _ = upload(base, uid, payload=jpeg(60))
        _, ids = list_ids(base)
        found = uid.lower() in ids
        return ("OK" if st == 200 and found else "WARN"), f"uppercase id -> {st}, stored lowercase={found}"

    # ── S09 poster kind on a photo ───────────────────────────────────────
    def s09():
        st, _, body = upload(base, f"stabp{stamp}", kind="poster", payload=jpeg(40))
        return ("WARN" if st == 200 else "OK"), f"kind=poster accepted for a photo -> {st} (key collision risk with video posters)"

    # ── S10 path abuse on the media proxy ────────────────────────────────
    def s10():
        results = {}
        for path in ["m/..%2fx.jpg", "m//x.jpg", "m/" + "a" * 900 + ".jpg", "x.jpg"]:
            st, _, _ = req(f"{base}/i/{path}")
            results[path[:24]] = st
        ok = results["m/..%2fx.jpg"] == 400 and results["x.jpg"] == 400
        return ("OK" if ok else "BUG"), json.dumps(results, ensure_ascii=False)

    # ── S11 12 parallel uploads, same id ─────────────────────────────────
    def s11():
        cid = f"stabrace{stamp}"
        with ThreadPoolExecutor(max_workers=12) as pool:
            codes = list(pool.map(lambda _: upload(base, cid, payload=jpeg(72))[0], range(12)))
        _, ids = list_ids(base)
        return ("OK" if all(c == 200 for c in codes) and ids.count(cid) == 1 else "BUG"), f"codes={sorted(set(codes))}, album entries={ids.count(cid)}"

    # ── S12 long guest name ──────────────────────────────────────────────
    def s12():
        lid = f"stabl{stamp}"
        upload(base, lid, payload=jpeg(50), name="ก" * 300)
        st, _, body = req(f"{base}/api/list?e={CODE}")
        items = json.loads(body)["items"] if st == 200 else []
        item = next((i for i in items if i["id"] == lid), None)
        gl = len(item["guest"]) if item else -1
        return ("OK" if 0 <= gl <= 40 else "BUG"), f"guest name stored length={gl} (expected <=40)"

    # ── S13 list page shape after writes ─────────────────────────────────
    def s13():
        st, _, body = req(f"{base}/api/list?e={CODE}")
        d = json.loads(body)
        # a video without a poster legitimately has thumb:"" (the client draws a
        # placeholder); a missing url is always broken
        bad = []
        for i in d["items"]:
            if not i.get("url"):
                bad.append(f"{i['id']}:no-url")
            elif not i.get("thumb") and i.get("type") != "video":
                bad.append(f"{i['id']}:photo-without-thumb")
        return ("OK" if not bad else "BUG"), f"{len(d['items'])} items, broken={bad[:3]}"

    # ── S14 OPTIONS preflight on upload ──────────────────────────────────
    def s14():
        st, h, _ = req(f"{base}/api/upload", method="OPTIONS")
        return ("OK" if st in (200, 204) else "BUG"), f"OPTIONS -> {st}, allow={h.get('access-control-allow-methods') or h.get('Access-Control-Allow-Methods')}"

    # ── S15 upload with a wrong method on media ──────────────────────────
    def s15():
        st, _, _ = req(f"{base}/i/m/{pid}.jpg", method="POST", body=b"x", headers={"content-type": "image/jpeg"})
        return ("OK" if st in (404, 405, 400) else "WARN"), f"POST /i/... -> {st}"

    for cid, q, fn in [
        ("S01", "HEAD on media works (browsers and CDNs send it)", s01),
        ("S02", "Range request returns 206 (iOS video seeking)", s02),
        ("S03", "same id uploaded twice stays one album entry", s03),
        ("S04", "thumbnail arriving before the main file", s04),
        ("S05", "zero-byte upload is rejected", s05),
        ("S06", "bogus list cursor does not 500", s06),
        ("S07", "extension with a dot/extra chars is rejected", s07),
        ("S08", "uppercase id is normalised to lowercase", s08),
        ("S09", "kind=poster accepted for a photo", s09),
        ("S10", "path abuse on /i/ is rejected", s10),
        ("S11", "12 parallel uploads with the same id", s11),
        ("S12", "300-character guest name is truncated", s12),
        ("S13", "album items always carry url + thumb", s13),
        ("S14", "OPTIONS on /api/upload", s14),
        ("S15", "POST on a media path", s15),
    ]:
        case(cid, q, fn)

    bugs = [f for f in FINDINGS if f[1] == "BUG"]
    warns = [f for f in FINDINGS if f[1] == "WARN"]
    print("=" * 78)
    print(f"{len(FINDINGS) - len(bugs) - len(warns)} OK · {len(warns)} WARN · {len(bugs)} BUG")
    if bugs:
        print("\nto fix:")
        for cid, _, detail in bugs:
            print(f"  {cid}: {detail}")
    return 0


def _mk_video(base, vid):
    """A tiny mp4 is not needed to test Range: any object served by /i/ shows the
    header behaviour, so upload a jpeg under a .mp4 key via kind=video."""
    upload(base, vid, kind="video", ext="mp4", payload=jpeg(64), ctype="video/mp4")
    return vid


if __name__ == "__main__":
    raise SystemExit(main())
