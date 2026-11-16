#!/usr/bin/env python3
"""Create the destination folder AS THE APP, so the Worker may upload into it.

Why this exists
---------------
The Worker uses the `drive.file` scope, which only grants access to files and
folders the app itself created (or that the user explicitly opened with the app).
A folder the host creates by hand in the Drive web UI is invisible to the app, so
uploading into it can fail with 404/403 even though the folder id is correct.

Creating the folder through the API sidesteps that entirely: the app owns it, so
every later upload works, and the folder id printed here is the one to put in
`DRIVE_FOLDER_ID`.

Credentials are read from the environment so they never appear in the command
line (and therefore never in shell history or a process listing):

    $env:GOOGLE_CLIENT_ID="..."
    $env:GOOGLE_CLIENT_SECRET="..."
    $env:GOOGLE_REFRESH_TOKEN="..."
    python scripts/drive_make_folder.py --name "Wedding-22.11.26"

Optional: --parent-id <id> to create it inside an existing folder (that parent
must itself be app-visible, so normally omit it).
"""
from __future__ import annotations

import argparse
import json
import os
import urllib.error
import urllib.parse
import urllib.request

TOKEN_URL = "https://oauth2.googleapis.com/token"
FILES_URL = "https://www.googleapis.com/drive/v3/files?fields=id,name,webViewLink"
FOLDER_MIME = "application/vnd.google-apps.folder"


def fail(msg: str, detail: str = "") -> int:
    print(f"FAIL: {msg}")
    if detail:
        print(f"      {detail}")
    return 1


def access_token() -> str:
    body = urllib.parse.urlencode(
        {
            "client_id": os.environ["GOOGLE_CLIENT_ID"],
            "client_secret": os.environ["GOOGLE_CLIENT_SECRET"],
            "refresh_token": os.environ["GOOGLE_REFRESH_TOKEN"],
            "grant_type": "refresh_token",
        }
    ).encode()
    req = urllib.request.Request(
        TOKEN_URL, data=body, headers={"content-type": "application/x-www-form-urlencoded"}
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            data = json.load(r)
    except urllib.error.HTTPError as e:
        payload = e.read().decode("utf-8", "replace")[:400]
        raise SystemExit(
            "FAIL: ขอ access token ไม่สำเร็จ "
            f"({e.code})\n      {payload}\n"
            "      ถ้าเป็น invalid_grant = refresh token ตาย/ถูกเพิกถอน → รัน scripts/google_auth.py ใหม่\n"
            "      ถ้าเป็น unauthorized_client = client id/secret ไม่ตรงกับ token"
        )
    if not data.get("access_token"):
        raise SystemExit(f"FAIL: ไม่ได้ access_token: {json.dumps(data)[:300]}")
    return data["access_token"]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--name", default="Wedding-22.11.26")
    ap.add_argument("--parent-id", default="")
    args = ap.parse_args()

    missing = [k for k in ("GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_REFRESH_TOKEN") if not os.environ.get(k)]
    if missing:
        return fail("ยังไม่ได้ตั้ง environment variable", ", ".join(missing))

    token = access_token()

    meta = {"name": args.name, "mimeType": FOLDER_MIME}
    if args.parent_id:
        meta["parents"] = [args.parent_id]

    req = urllib.request.Request(
        FILES_URL,
        data=json.dumps(meta).encode(),
        method="POST",
        headers={
            "authorization": "Bearer " + token,
            "content-type": "application/json; charset=UTF-8",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            data = json.load(r)
    except urllib.error.HTTPError as e:
        return fail(f"สร้างโฟลเดอร์ไม่สำเร็จ ({e.code})", e.read().decode("utf-8", "replace")[:400])

    fid = data.get("id", "")
    print("PASS: สร้างโฟลเดอร์สำเร็จ (แอปเป็นเจ้าของ จึงอัปโหลดเข้าได้)")
    print(f"  name : {data.get('name')}")
    print(f"  id   : {fid}")
    print(f"  link : {data.get('webViewLink')}")
    print("\nใส่ค่านี้ใน wrangler.toml:")
    print(f'  DRIVE_FOLDER_ID = "{fid}"')
    return 0 if fid else 1


if __name__ == "__main__":
    raise SystemExit(main())
