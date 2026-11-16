"""Smoke test the local Worker: config, upload, list, media, auth.

Usage: python scripts/smoke_test.py [base_url]
"""
import os
import base64
import json
import sys
import urllib.error
import urllib.parse
import urllib.request

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8787"
CODE = os.environ.get("EVENT_CODE", "demo-code")

JPEG = base64.b64decode(
    "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a"
    "HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAA"
    "AAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q=="
)

results = []


def call(method, path, body=None, ctype=None, expect=200):
    url = BASE + path
    req = urllib.request.Request(url, data=body, method=method)
    if ctype:
        req.add_header("content-type", ctype)
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            status, data = r.status, r.read()
    except urllib.error.HTTPError as e:
        status, data = e.code, e.read()

    ok = status == expect
    results.append((ok, f"{method} {path.split('?')[0]}", f"{status} (want {expect})"))
    return status, data


def q(**kw):
    return "?" + urllib.parse.urlencode(kw)


print("--- config ---")
st, body = call("GET", "/api/config" + q(e=CODE))
cfg = json.loads(body)
print(json.dumps(cfg, ensure_ascii=False, indent=2))

print("--- bad code (must be 403) ---")
call("GET", "/api/config" + q(e="wrong"), expect=403)

print("--- uploads ---")
photo_id = "1736000000000-aaaaaa"
call(
    "POST",
    "/api/upload" + q(e=CODE, id=photo_id, kind="photo", ext="jpg", name="สมชาย"),
    JPEG,
    "image/jpeg",
)
call(
    "POST",
    "/api/upload" + q(e=CODE, id=photo_id, kind="thumb", ext="jpg", name="สมชาย"),
    JPEG,
    "image/jpeg",
)

video_id = "1736000001000-bbbbbb"
call(
    "POST",
    "/api/upload" + q(e=CODE, id=video_id, kind="video", ext="mp4", name="Ann"),
    b"\x00\x00\x00\x18ftypmp42" + b"0" * 64,
    "video/mp4",
)
call(
    "POST",
    "/api/upload" + q(e=CODE, id=video_id, kind="poster", ext="jpg", name="Ann"),
    JPEG,
    "image/jpeg",
)

print("--- rejections ---")
call("POST", "/api/upload" + q(e=CODE, id="1736000002000-cccccc", kind="photo", ext="jpg"), b"x" * 16, "text/plain", expect=415)
call("POST", "/api/upload" + q(e=CODE, id="bad", kind="photo", ext="jpg"), JPEG, "image/jpeg", expect=400)
call("POST", "/api/upload" + q(e="nope", id="1736000003000-dddddd", kind="photo", ext="jpg"), JPEG, "image/jpeg", expect=403)

print("--- list ---")
st, body = call("GET", "/api/list" + q(e=CODE))
data = json.loads(body)
print(json.dumps(data, ensure_ascii=False, indent=2))

print("--- media proxy ---")
for item in data.get("items", []):
    path = urllib.parse.urlparse(item["url"]).path
    call("GET", path)

print()
print("=" * 58)
fails = [r for r in results if not r[0]]
for ok, name, info in results:
    print(("PASS " if ok else "FAIL ") + name.ljust(38) + info)
print("=" * 58)
print(f"{len(results) - len(fails)}/{len(results)} passed")
sys.exit(1 if fails else 0)
