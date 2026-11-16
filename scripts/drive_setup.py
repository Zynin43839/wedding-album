#!/usr/bin/env python3
"""One command to wire the Drive archive end to end.

Does, in order:
  1. read client_id / client_secret from the OAuth client JSON that Google's
     console downloads (client_secret_*.apps.googleusercontent.com.json)
  2. push both to the Worker as secrets
  3. run the consent flow with a loopback server on port 8765 — the browser opens
     itself and the code is captured automatically (no copy-paste of codes)
  4. exchange the code for a refresh token and push that secret too
  5. print the next step (folder creation), which the agent then runs

Why a loopback server: the previous attempt pasted an authorization code
(`4/0A…`) where a refresh token (`1//0…`) was expected, and the only symptom was
a bare invalid_grant. Capturing the callback removes that whole class of mistake.

Usage:
  python scripts/drive_setup.py --client-json "%USERPROFILE%\\Downloads\\client_secret_....json"
"""
from __future__ import annotations

import argparse
import http.server
import json
import pathlib
import subprocess
import threading
import urllib.parse
import urllib.request
import webbrowser

SCOPE = "https://www.googleapis.com/auth/drive.file"
PORT = 8765
REDIRECT = f"http://localhost:{PORT}"
TOKEN_URL = "https://oauth2.googleapis.com/token"
AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth"

captured: dict[str, str] = {}


class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):  # noqa: N802
        q = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
        captured["code"] = (q.get("code") or [""])[0]
        captured["error"] = (q.get("error") or [""])[0]
        self.send_response(200)
        self.send_header("content-type", "text/html; charset=utf-8")
        self.end_headers()
        if captured.get("code"):
            self.wfile.write(
                "<h2 style='font-family:sans-serif'>เชื่อมต่อสำเร็จ — ปิดหน้านี้ได้เลย</h2>".encode()
            )
        else:
            self.wfile.write(
                f"<h2 style='font-family:sans-serif'>ไม่ได้รับ code: {captured.get('error')}</h2>".encode()
            )

    def log_message(self, *a):  # silence the default access log
        pass


def wrangler_secret(root: pathlib.Path, name: str, value: str) -> bool:
    r = subprocess.run(
        f"npx wrangler secret put {name}",
        input=value,
        text=True,
        encoding="utf-8",
        errors="replace",
        shell=True,
        cwd=str(root),
        capture_output=True,
    )
    out = (r.stdout or "") + (r.stderr or "")
    ok = r.returncode == 0 and "Success" in out
    print(f"  {'OK ' if ok else 'FAIL'} {name}" + ("" if ok else f"  ({out.strip().splitlines()[-1] if out.strip() else 'no output'})"))
    return ok


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--client-json", required=True)
    args = ap.parse_args()

    root = pathlib.Path(__file__).resolve().parents[1]
    data = json.loads(pathlib.Path(args.client_json).expanduser().read_text(encoding="utf-8"))
    block = data.get("installed") or data.get("web") or {}
    client_id = block.get("client_id", "")
    client_secret = block.get("client_secret", "")
    if not client_id or not client_secret:
        print("FAIL: ไฟล์ JSON ไม่มี client_id / client_secret")
        return 1
    print(f"client: {client_id[:18]}…  (secret {len(client_secret)} ตัวอักษร)")

    print("\n[1/4] อัปโหลด client id / secret")
    if not wrangler_secret(root, "GOOGLE_CLIENT_ID", client_id):
        return 1
    if not wrangler_secret(root, "GOOGLE_CLIENT_SECRET", client_secret):
        return 1

    print(f"\n[2/4] เปิดเบราว์เซอร์ให้กด Allow (รอที่ port {PORT} ≤ 300 วินาที)")
    params = {
        "client_id": client_id,
        "redirect_uri": REDIRECT,
        "response_type": "code",
        "scope": SCOPE,
        "access_type": "offline",
        "prompt": "consent",
    }
    url = AUTH_URL + "?" + urllib.parse.urlencode(params)

    server = http.server.HTTPServer(("127.0.0.1", PORT), Handler)
    t = threading.Thread(target=server.handle_request, daemon=True)
    t.start()
    print("   ถ้าเบราว์เซอร์ไม่เด้ง ให้เปิดลิงก์นี้:\n   " + url[:120] + "…")
    webbrowser.open(url)
    t.join(timeout=300)
    server.server_close()

    code = captured.get("code", "")
    if not code:
        print(f"FAIL: ไม่ได้ code (error={captured.get('error') or 'timeout'})")
        return 1
    print(f"   ได้ code {code[:8]}… (len {len(code)})")

    print("\n[3/4] แลก code เป็น refresh token")
    body = urllib.parse.urlencode(
        {
            "code": code,
            "client_id": client_id,
            "client_secret": client_secret,
            "redirect_uri": REDIRECT,
            "grant_type": "authorization_code",
        }
    ).encode()
    req = urllib.request.Request(
        TOKEN_URL, data=body, headers={"content-type": "application/x-www-form-urlencoded"}
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            tok = json.load(r)
    except urllib.error.HTTPError as e:
        print("FAIL:", e.read().decode("utf-8", "replace")[:300])
        return 1

    token = tok.get("refresh_token", "")
    if not token.startswith("1//"):
        print(f"FAIL: ได้ค่าที่ไม่ใช่ refresh token ({token[:8]}… len {len(token)})")
        return 1
    print(f"   refresh token: {token[:6]}… (len {len(token)})")

    print("\n[4/4] อัปโหลด refresh token")
    if not wrangler_secret(root, "GOOGLE_REFRESH_TOKEN", token):
        return 1

    print("\nเสร็จ — ขั้นต่อไปคือสร้างโฟลเดอร์ใน Drive")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
