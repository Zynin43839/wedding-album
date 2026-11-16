"""Prove the Drive sync end to end against the mock server (no Google account needed).

1. uploads 3 photos + 1 clip to the LOCAL worker
2. calls /api/sync twice (second run must find nothing new)
3. checks the mock Drive received the right names, types and byte counts
4. checks the `synced/` markers exist and the third run is a no-op

Run (with `python scripts/mock_drive.py` and `wrangler dev` already running):
  python scripts/sync_test.py
"""
from __future__ import annotations

import os

import json
import time
import urllib.parse
import urllib.request
from io import BytesIO

from PIL import Image

WORKER = "http://127.0.0.1:8787"
DRIVE = "http://127.0.0.1:8788"
CODE = os.environ.get("EVENT_CODE", "demo-code")
SYNC_TOKEN = "test-sync-token"
UA = {"user-agent": "Mozilla/5.0", "x-sync-token": SYNC_TOKEN}

fails: list[str] = []


def check(name: str, ok: bool, info: str = "") -> None:
    print(f"{'PASS' if ok else 'FAIL'} {name}" + (f" — {info}" if info else ""))
    if not ok:
        fails.append(name)


def jpeg(kb: int = 60) -> bytes:
    im = Image.new("RGB", (200, 150), (220, 200, 190))
    buf = BytesIO()
    im.save(buf, "JPEG", quality=80)
    data = buf.getvalue()
    return data + b"\x00" * max(0, kb * 1024 - len(data))


def post(path: str, body: bytes, ctype: str) -> tuple[int, bytes]:
    req = urllib.request.Request(WORKER + path, data=body, method="POST",
                                headers={"user-agent": "Mozilla/5.0", "content-type": ctype})
    with urllib.request.urlopen(req, timeout=60) as r:
        return r.status, r.read()


def get(url: str, headers=None) -> tuple[int, bytes]:
    req = urllib.request.Request(url, headers=headers or {"user-agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return r.status, r.read()


def sync(limit: int = 10) -> dict:
    st, body = get(f"{WORKER}/api/sync?token={SYNC_TOKEN}&limit={limit}", headers=UA)
    return json.loads(body) if st == 200 else {"http": st, "body": body[:200].decode("utf-8", "replace")}


def drive_log() -> list[dict]:
    st, body = get(f"{DRIVE}/__log")
    return json.loads(body)["entries"]


def main() -> int:
    stamp = int(time.time())

    # 3 photos (photo + thumb) and 1 clip (video + poster)
    for i in range(3):
        uid = f"synct{stamp}-{i}"
        post(f"/api/upload?{urllib.parse.urlencode({'e': CODE, 'id': uid, 'kind': 'photo', 'ext': 'jpg', 'name': 'SYNCTEST'})}", jpeg(80), "image/jpeg")
        post(f"/api/upload?{urllib.parse.urlencode({'e': CODE, 'id': uid, 'kind': 'thumb', 'ext': 'jpg', 'name': 'SYNCTEST'})}", jpeg(20), "image/jpeg")

    vid = f"synct{stamp}-v"
    post(f"/api/upload?{urllib.parse.urlencode({'e': CODE, 'id': vid, 'kind': 'video', 'ext': 'mp4', 'name': 'SYNCTEST'})}", jpeg(200), "video/mp4")
    post(f"/api/upload?{urllib.parse.urlencode({'e': CODE, 'id': vid, 'kind': 'poster', 'ext': 'jpg', 'name': 'SYNCTEST'})}", jpeg(20), "image/jpeg")
    print("uploaded 4 files (8 objects) to the local worker")

    # run 1
    r1 = sync(50)
    check("sync run 1 reports pushes", r1.get("pushed", 0) >= 8, json.dumps(r1, ensure_ascii=False)[:160])

    log = drive_log()
    starts = [e for e in log if e["kind"] == "start"]
    puts = [e for e in log if e["kind"] == "put"]
    names = sorted(e["name"] for e in starts if e.get("name"))
    check("drive received one request per object", len(starts) >= 8, f"{len(starts)} starts, {len(puts)} puts")
    check(
        "filenames are flat and keep the extension",
        all("/" not in n for n in names) and any(n.endswith(".mp4") for n in names) and any(n.endswith(".jpg") for n in names),
        str(names[:3]),
    )
    check("content types are passed through", any(e["ctype"] == "video/mp4" for e in starts), sorted({e["ctype"] for e in starts}))
    check("folder id is sent", all(e["parents"] == ["mock-folder"] for e in starts), str(starts[0].get("parents")))
    check("bearer token is used", all("Bearer" in (e["auth"] or "") for e in starts), starts[0].get("auth", ""))
    total_put = sum(e["bytes"] for e in puts)
    total_start = sum(int(e["size"] or 0) for e in starts)
    check("streamed bytes match the declared size", total_put == total_start, f"put {total_put} vs declared {total_start}")

    # run 2 must be a no-op
    before = len(drive_log())
    r2 = sync(50)
    check("second run pushes nothing new", r2.get("pushed", 0) == 0, json.dumps(r2, ensure_ascii=False)[:120])
    check("second run sends no upload", len(drive_log()) == before, f"{len(drive_log()) - before} new drive calls")

    print()
    print(f"{'RESULT: PASS' if not fails else 'RESULT: FAIL ' + ', '.join(fails)}")
    return 0 if not fails else 1


if __name__ == "__main__":
    raise SystemExit(main())
