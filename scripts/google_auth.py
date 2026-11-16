"""One-time helper: turn an OAuth client into a refresh token for the Drive sync.

Uses the loopback redirect, but you can paste the redirected URL instead of
letting the script catch it — on some machines the local callback is blocked.

Run: python scripts/google_auth.py
"""
from __future__ import annotations

import json
import urllib.parse
import urllib.request

SCOPE = "https://www.googleapis.com/auth/drive.file"
REDIRECT = "http://localhost:8765"


def main() -> int:
    client_id = input("Client ID     : ").strip()
    client_secret = input("Client secret : ").strip()
    if not client_id or not client_secret:
        print("ต้องใส่ทั้งสองค่า")
        return 1

    params = {
        "client_id": client_id,
        "redirect_uri": REDIRECT,
        "response_type": "code",
        "scope": SCOPE,
        "access_type": "offline",
        "prompt": "consent",
    }
    url = "https://accounts.google.com/o/oauth2/v2/auth?" + urllib.parse.urlencode(params)

    print("\n1) เปิดลิงก์นี้ในเบราว์เซอร์ แล้วกด Allow:\n")
    print(url)
    print(
        "\n2) เบราว์เซอร์จะเด้งไป http://localhost:8765/?code=... (หน้าอาจเปิดไม่ขึ้น = ปกติ)"
        "\n   คัดลอก URL เต็มจาก address bar มาวางด้านล่าง (หรือวางเฉพาะ code ก็ได้)\n"
    )
    raw = input("Redirect URL หรือ code : ").strip()

    if raw.startswith("http"):
        q = urllib.parse.parse_qs(urllib.parse.urlparse(raw).query)
        code = (q.get("code") or [""])[0]
    else:
        code = raw
    if not code:
        print("ไม่พบ code ในข้อความที่วาง")
        return 1

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
        "https://oauth2.googleapis.com/token",
        data=body,
        headers={"content-type": "application/x-www-form-urlencoded"},
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            data = json.load(r)
    except Exception as e:  # noqa: BLE001
        print("แลก code ไม่สำเร็จ:", e)
        return 1

    token = data.get("refresh_token")
    if not token:
        print("ไม่มี refresh_token ในผลลัพธ์:", json.dumps(data)[:300])
        print("มักเกิดเพราะเคยกด Allow ไปแล้ว — ตั้ง prompt=consent อยู่แล้ว ลองลบสิทธิ์ที่ myaccount.google.com/permissions แล้วทำใหม่")
        return 1

    # A refresh token always starts with "1//"; an authorization code starts with
    # "4/0". This check exists because the wrong one was pasted once and the only
    # symptom was a bare invalid_grant from Google.
    if not token.startswith("1//"):
        print(f"⚠️ ค่าที่ได้ไม่ใช่ refresh token (ขึ้นต้นด้วย {token[:6]}…) — ไม่บันทึก")
        return 1

    print("\nใช้คำสั่งนี้ต่อ:\n")
    print(f'  npx wrangler secret put GOOGLE_REFRESH_TOKEN')
    print(f"  (วางค่า: {token})\n")

    # Put the token on the clipboard so it can be handed to the Worker without
    # being retyped (or pasted into a chat window).
    try:
        import subprocess

        subprocess.run(
            [
                "powershell",
                "-NoProfile",
                "-Command",
                "Set-Clipboard -Value ([Console]::In.ReadToEnd().Trim())",
            ],
            input=token,
            text=True,
            timeout=30,
        )
        print("✅ คัดลอก token ไปที่คลิปบอร์ดแล้ว — บอก agent ว่า 'ก๊อปแล้ว' ได้เลย\n")
    except Exception as e:  # noqa: BLE001
        print(f"(คัดลอกอัตโนมัติไม่สำเร็จ: {e} — ให้คัดลอกค่าเอง)\n")

    # Offer to upload it straight away: the token is never shown to be retyped,
    # never written to disk, and never travels through a chat window.
    try:
        answer = input("อัปโหลดเป็น Worker secret ให้เลยไหม? (Y/n): ").strip().lower()
    except EOFError:
        answer = "n"
    if answer in ("", "y", "yes"):
        import subprocess

        print("\nกำลังอัปโหลด…")
        done = subprocess.run(
            "npx wrangler secret put GOOGLE_REFRESH_TOKEN",
            input=token,
            text=True,
            shell=True,
            capture_output=True,
        )
        out = (done.stdout or "") + (done.stderr or "")
        if done.returncode == 0 and "Success" in out:
            print("✅ อัปโหลด secret สำเร็จ — บอก agent ว่า 'เสร็จ' ได้เลย")
        else:
            print("⚠️ อัปโหลดอัตโนมัติไม่สำเร็จ — คัดลอกค่าด้านบนแล้วรันเอง:")
            print("   npx wrangler secret put GOOGLE_REFRESH_TOKEN")
            print("   " + (out.strip().splitlines()[-1] if out.strip() else "(no output)"))
    else:
        print("ข้ามการอัปโหลด — รันเองด้วย: npx wrangler secret put GOOGLE_REFRESH_TOKEN")

    print("หมายเหตุ: token นี้จะหมดอายุใน 7 วัน เพราะ OAuth app อยู่ในโหมด Testing")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
