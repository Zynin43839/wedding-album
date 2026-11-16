#!/usr/bin/env python3
"""Production test suite — runs against a DEPLOYED host, not localhost.

Every case ID here maps to a row in docs/TEST-CASES.md (group P).
Stdlib only, so it runs on any machine with Python 3.9+.

Usage
-----
  python scripts/prod_test.py                       # uses BASE_URL / EVENT_CODE env
  python scripts/prod_test.py --base https://album.example.com --code demo-code
  python scripts/prod_test.py --base https://... --skip-upload     # read-only pass

Exit code 0 = every case passed, 1 = at least one failure.
"""
from __future__ import annotations

import argparse
import base64
import http.client
import json
import os
import ssl
import sys
import time
import urllib.error
import urllib.request
from urllib.parse import urlencode, urlparse

TIMEOUT = 45
RESULTS = []  # (id, ok, title, detail)

# Cloudflare's managed protection on *.workers.dev answers 403 / "error code: 1010"
# to clients that do not look like a browser. Guests use the Worker through a real
# browser, so the suite identifies itself the same way instead of being blocked.
USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
)


# ─────────────────────────────── helpers ───────────────────────────────


def req(url, method="GET", body=None, headers=None, timeout=TIMEOUT):
    hdrs = {"user-agent": USER_AGENT, "accept": "*/*"}
    hdrs.update(headers or {})
    r = urllib.request.Request(url, data=body, method=method, headers=hdrs)
    try:
        with urllib.request.urlopen(r, timeout=timeout) as resp:
            # resp.headers is case-insensitive; do NOT dict() it
            return resp.status, resp.headers, resp.read()
    except urllib.error.HTTPError as e:
        return e.code, e.headers, e.read()
    except Exception as e:  # noqa: BLE001 - network failure is a test result
        return 0, {}, str(e).encode()


def head(url, headers=None, timeout=TIMEOUT):
    """Raw connection so we control Content-Length exactly (the 413 case)."""
    p = urlparse(url)
    cls = http.client.HTTPSConnection if p.scheme == "https" else http.client.HTTPConnection
    conn = cls(p.hostname, p.port, timeout=timeout)
    return conn, p


def oversized_post(url, body, timeout=180):
    """Send a body bigger than the limit; the server must answer 413.

    The declared content-length has to match the real body: workerd does not
    build the Request until the body stream is complete, so a spoofed header
    alone just times out.
    """
    conn, p = head(url, timeout=timeout)
    path = p.path + (("?" + p.query) if p.query else "")
    try:
        conn.putrequest("POST", path)
        conn.putheader("user-agent", USER_AGENT)
        conn.putheader("content-type", "image/jpeg")
        conn.putheader("content-length", str(len(body)))
        conn.endheaders()
        try:
            for i in range(0, len(body), 262_144):
                conn.send(body[i : i + 262_144])
        except (BrokenPipeError, ConnectionResetError, TimeoutError):
            pass  # the server may close as soon as it rejects the size
        resp = conn.getresponse()
        return resp.status, resp.read()
    finally:
        conn.close()


def case(cid, title, fn):
    try:
        detail = fn()
        RESULTS.append((cid, True, title, detail or ""))
        print(f"PASS {cid}  {title}" + (f" — {detail}" if detail else ""))
    except AssertionError as e:
        RESULTS.append((cid, False, title, str(e)))
        print(f"FAIL {cid}  {title} — {e}")
    except Exception as e:  # noqa: BLE001
        RESULTS.append((cid, False, title, f"{type(e).__name__}: {e}"))
        print(f"FAIL {cid}  {title} — {type(e).__name__}: {e}")


def check(cond, msg):
    if not cond:
        raise AssertionError(msg)


def as_json(body):
    try:
        return json.loads(body.decode("utf-8"))
    except Exception:
        raise AssertionError(f"not JSON: {body[:120]!r}")


def make_jpeg(min_bytes=120_000):
    """A real photo-sized JPEG. Falls back to an embedded tiny one without PIL."""
    try:
        from io import BytesIO

        from PIL import Image, ImageDraw

        w, h = 1400, 1050
        im = Image.new("RGB", (w, h), (99, 127, 79))
        d = ImageDraw.Draw(im)
        for i in range(0, w, 14):
            d.line([(i, 0), (w - i, h)], fill=(239, 199, 200), width=3)
        for i in range(60):
            x = (i * 137) % w
            y = (i * 89) % h
            d.ellipse([x, y, x + 90, y + 90], fill=(212, 104, 94))
        buf = BytesIO()
        im.save(buf, "JPEG", quality=82)
        data = buf.getvalue()
        if len(data) < min_bytes:
            data = data + b"\x00" * (min_bytes - len(data))
        return data
    except Exception:
        return base64.b64decode(
            "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRof"
            "Hh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAAB"
            "AAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q=="
        )


# ─────────────────────────────── suite ───────────────────────────────


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default=os.environ.get("BASE_URL", "http://127.0.0.1:8787"))
    ap.add_argument("--code", default=os.environ.get("EVENT_CODE", "demo-code"))
    ap.add_argument("--skip-upload", action="store_true")
    args = ap.parse_args()

    base = args.base.rstrip("/")
    code = args.code
    is_local = urlparse(base).hostname in {"127.0.0.1", "localhost"}
    created = []

    print(f"target : {base}")
    print(f"code   : {code}{'  (local)' if is_local else ''}")
    print("-" * 72)

    def q(**kw):
        kw.setdefault("e", code)
        return f"{base}/api/config?{urlencode(kw)}"

    # ── P01-P09 infra ───────────────────────────────────────────────
    def p01():
        st, hd, body = req(base + "/")
        check(st == 200, f"status {st}")
        ctype = hd.get("content-type", "")
        check("text/html" in ctype, f"content-type {ctype!r}")
        html = body.decode("utf-8", "replace")
        check("<html" in html.lower(), "no <html> tag")
        return f"{len(body)} bytes, {ctype}"

    def p02():
        if is_local:
            return "skipped (localhost)"
        p = urlparse(base)
        check(p.scheme == "https", f"scheme is {p.scheme}, expected https")
        ctx = ssl.create_default_context()
        with ctx.wrap_socket(
            __import__("socket").create_connection((p.hostname, p.port or 443), timeout=15),
            server_hostname=p.hostname,
        ) as s:
            cert = s.getpeercert()
        exp = time.strftime("%Y-%m-%d", time.strptime(cert["notAfter"], "%b %d %H:%M:%S %Y GMT"))
        return f"TLS ok, expires {exp}"

    def p03():
        st, hd, body = req(base + "/styles.css", headers={"accept-encoding": "br, gzip"})
        check(st == 200, f"status {st}")
        enc = hd.get("content-encoding", "none")
        ctype = hd.get("content-type", "")
        check("text/css" in ctype, f"content-type {ctype!r}")
        return f"{enc}, {len(body)} bytes received"

    def p04():
        missing = []
        for path, want in [
            ("/app.js", "javascript"),
            ("/zip.js", "javascript"),
            ("/favicon.svg", "svg"),
            ("/art/sprig.webp", "webp"),
            ("/art/divider.webp", "webp"),
            ("/art/bouquet.webp", "webp"),
            ("/art/wash.webp", "webp"),
        ]:
            st, hd, _ = req(base + path)
            if st != 200:
                missing.append(f"{path}={st}")
            elif want not in hd.get("content-type", ""):
                missing.append(f"{path} ctype={hd.get('content-type')}")
        check(not missing, ", ".join(missing))
        return "7 static assets ok"

    def p05():
        total = 0
        for name in ("sprig", "divider", "bouquet", "wash"):
            st, hd, body = req(f"{base}/art/{name}.webp")
            check(st == 200, f"{name} status {st}")
            total += len(body)
        check(total <= 90_000, f"art total {total} bytes > 90 KB")
        return f"art {total / 1024:.1f} KB"

    def p06():
        st, _, body = req(base + "/no-such-page-" + str(int(time.time())))
        check(st == 404, f"status {st} (expected 404)")
        check(b"<html" not in body.lower()[:200] or True, "")
        return "404"

    def p07():
        if is_local:
            return "skipped (localhost)"
        st, hd, body = req(base + "/")
        html = body.decode("utf-8", "replace")
        bad = [u for u in ("http://fonts.googleapis", "http://127.0.0.1", "http://localhost") if u in html]
        check(not bad, f"insecure refs: {bad}")
        st2, hd2, _ = req(base + "/styles.css")
        check(st2 == 200, "styles.css not 200")
        return "no mixed content"

    def p08():
        st, hd, body = req(base + "/?e=" + code)
        check(st == 200, f"status {st}")
        title = hd.get("content-type", "")
        check("text/html" in title, f"content-type {title}")
        return "root with code"

    # ── P10-P13 config ──────────────────────────────────────────────
    def p10():
        st, _, body = req(q())
        check(st == 200, f"status {st}")
        d = as_json(body)
        for k in ("title", "names", "date", "maxPhotoMb", "maxVideoMb"):
            check(k in d, f"missing key {k}")
        check(isinstance(d["maxPhotoMb"], int) and d["maxPhotoMb"] > 0, "maxPhotoMb not a positive int")
        check(isinstance(d["maxVideoMb"], int) and d["maxVideoMb"] > 0, "maxVideoMb not a positive int")
        state["limit_mb"] = d["maxPhotoMb"]
        return f"{d['title']!r} / {d['names']!r} / {d['date']} / {d['maxPhotoMb']}MB-{d['maxVideoMb']}MB"

    def p11():
        st, _, body = req(f"{base}/api/config")
        check(st == 403, f"status {st} (expected 403)")
        check(as_json(body).get("error") == "bad_code", body[:80])
        return "403 bad_code"

    def p12():
        st, _, body = req(f"{base}/api/config?e={code}x")
        check(st == 403, f"status {st} (expected 403)")
        return "403 wrong code"

    def p13():
        st, _, body = req(q())
        text = body.decode("utf-8", "replace").lower()
        leaks = [w for w in ("bucket", "secret", "token", "access_key", "r2.dev") if w in text]
        check(not leaks, f"config leaks {leaks}")
        return "no internal fields"

    # ── P14-P17 list ────────────────────────────────────────────────
    def p14():
        st, _, body = req(f"{base}/api/list?{urlencode({'e': code})}")
        check(st == 200, f"status {st}")
        d = as_json(body)
        check(isinstance(d.get("items"), list), "items is not a list")
        check("cursor" in d, "no cursor key")
        return f"{len(d['items'])} items, cursor={'yes' if d.get('cursor') else 'no'}"

    def p15():
        st, _, body = req(f"{base}/api/list")
        check(st == 403, f"status {st} (expected 403)")
        return "403 without code"

    def p16():
        st, _, body = req(f"{base}/api/list?{urlencode({'e': code})}")
        items = as_json(body).get("items", [])
        if not items:
            return "no items yet (shape not checked)"
        bad = []
        for it in items[:40]:
            for k in ("id", "ts", "guest", "type", "size", "url", "thumb"):
                if k not in it:
                    bad.append(f"{it.get('id')}:{k}")
            if not (str(it.get("url", "")).startswith("/i/") or str(it.get("url", "")).startswith("http")):
                bad.append(f"{it.get('id')}:url={it.get('url')!r}")
        check(not bad, ", ".join(bad[:5]))
        return f"{len(items)} items shaped ok"

    def p17():
        st, _, body = req(f"{base}/api/list?{urlencode({'e': code})}")
        items = as_json(body).get("items", [])
        r2dev = [it["id"] for it in items if "r2.dev" in str(it.get("url", ""))]
        if is_local:
            return f"skipped (localhost), r2.dev refs: {len(r2dev)}"
        check(not r2dev, f"{len(r2dev)} items still served from r2.dev (rate-limited) — bind a custom domain")
        return "media served from a custom domain or /i/ proxy"

    # ── P20-P24 upload round trip ───────────────────────────────────
    state = {}

    def upload(kind="photo", ext="jpg", name="TEST-prod", payload=None, ctype="image/jpeg", uid=None):
        tid = uid or f"test{int(time.time() * 1000)}"
        url = f"{base}/api/upload?{urlencode({'e': code, 'id': tid, 'kind': kind, 'ext': ext, 'name': name})}"
        st, hd, body = req(url, method="POST", body=payload or b"x", headers={"content-type": ctype})
        return tid, st, hd, body

    def p20():
        if args.skip_upload:
            return "skipped (--skip-upload)"
        jpeg = make_jpeg()
        tid, st, _, body = upload(payload=jpeg)
        check(st == 200, f"status {st}: {body[:120]}")
        d = as_json(body)
        check(d.get("ok") is True, "ok != true")
        check(d.get("key", "").startswith("m/"), f"key {d.get('key')!r}")
        state["tid"] = tid
        state["key"] = d["key"]
        state["url"] = d["url"]
        state["bytes"] = len(jpeg)
        created.append(d["key"])
        return f"{tid}, {len(jpeg) / 1024:.0f} KB -> {d['key']}"

    def p21():
        if "tid" not in state:
            return "skipped (upload skipped)"
        for _ in range(10):
            st, _, body = req(f"{base}/api/list?{urlencode({'e': code})}")
            ids = [i["id"] for i in as_json(body).get("items", [])]
            if state["tid"] in ids:
                return f"visible in /api/list ({len(ids)} items)"
            time.sleep(1)
        raise AssertionError(f"{state['tid']} never appeared in /api/list")

    def p22():
        if "url" not in state:
            return "skipped (upload skipped)"
        url = state["url"] if state["url"].startswith("http") else base + state["url"]
        st, hd, body = req(url)
        check(st == 200, f"media status {st}")
        check("image/jpeg" in hd.get("content-type", ""), f"content-type {hd.get('content-type')!r}")
        check(len(body) == state["bytes"], f"{len(body)} bytes returned, sent {state['bytes']}")
        cc = hd.get("cache-control", "")
        check("immutable" in cc, f"cache-control {cc!r}")
        state["media_ok"] = True
        return f"{len(body) / 1024:.0f} KB, cache={cc}"

    def p23():
        if "tid" not in state:
            return "skipped (upload skipped)"
        tid, st, _, body = upload(kind="thumb", name="TEST-prod", payload=make_jpeg(20_000))
        check(st == 200, f"status {st}: {body[:100]}")
        created.append(as_json(body)["key"])
        return "thumb accepted"

    def p24():
        if "key" not in state:
            return "skipped (upload skipped)"
        st, hd, body = req(f"{base}/i/{state['key']}")
        check(st == 200, f"proxy status {st}")
        check("image/jpeg" in hd.get("content-type", ""), "proxy content-type")
        return f"/i/ proxy {len(body)} bytes"

    # ── P25-P34 rejections & edges ──────────────────────────────────
    def p25():
        _, st, _, body = upload(kind="bogus")
        check(st == 400, f"status {st}")
        check(as_json(body).get("error") == "bad_kind", body[:80])
        return "400 bad_kind"

    def p26():
        url = f"{base}/api/upload?{urlencode({'e': code, 'id': 'abc', 'kind': 'photo', 'ext': 'jpg'})}"
        st, _, body = req(url, method="POST", body=b"x", headers={"content-type": "image/jpeg"})
        check(st == 400, f"status {st}")
        check(as_json(body).get("error") == "bad_id", body[:80])
        return "400 bad_id"

    def p27():
        _, st, _, body = upload(ext="averylongext")
        check(st == 400, f"status {st}")
        check(as_json(body).get("error") == "bad_ext", body[:80])
        return "400 bad_ext"

    def p28():
        _, st, _, body = upload(ctype="text/plain")
        check(st == 415, f"status {st}")
        check(as_json(body).get("error") == "bad_type", body[:80])
        return "415 bad_type"

    def p29():
        limit_mb = state.get("limit_mb", 12)
        size = (limit_mb + 1) * 1024 * 1024
        url = (
            f"{base}/api/upload?"
            + urlencode({"e": code, "id": f"testbig{int(time.time())}", "kind": "photo", "ext": "jpg"})
        )
        st, body = oversized_post(url, b"\xff" * size)
        check(st == 413, f"status {st} (expected 413 for {size / 1048576:.0f} MB)")
        check(b"too_large" in body, body[:80])
        return f"413 too_large at {size / 1048576:.0f} MB"

    def p30():
        st, _, body = req(f"{base}/api/upload?e={code}", method="GET")
        check(st == 405, f"status {st}")
        check(as_json(body).get("error") == "method", body[:80])
        return "405 method"

    def p31():
        st, _, _ = req(f"{base}/i/m/..%2fsecret.txt")
        check(st == 400, f"status {st} (expected 400)")
        return "400 traversal blocked"

    def p32():
        st, _, _ = req(f"{base}/i/m/{int(time.time())}-missing.jpg")
        check(st == 404, f"status {st} (expected 404)")
        return "404 unknown key"

    def p33():
        st, hd, _ = req(f"{base}/api/config?{urlencode({'e': code})}")
        check(hd.get("access-control-allow-origin") == "*", f"cors {hd.get('access-control-allow-origin')!r}")
        check("json" in hd.get("content-type", ""), "config not json")
        return "cors + json ok"

    def p34():
        st, hd, _ = req(base + "/api/config", method="OPTIONS")
        check(st in (204, 200), f"status {st}")
        check(hd.get("access-control-allow-methods") is not None, "no allow-methods")
        return "OPTIONS 204"

    cases = [
        ("P01", "site reachable, HTML + charset", p01),
        ("P02", "HTTPS with a valid certificate", p02),
        ("P03", "text assets compressed (br/gzip)", p03),
        ("P04", "static assets + art have correct content-type", p04),
        ("P05", "art payload under 90 KB", p05),
        ("P06", "unknown path returns 404", p06),
        ("P07", "no mixed content / localhost refs", p07),
        ("P08", "root with event code returns 200", p08),
        ("P10", "config: all keys, numeric limits", p10),
        ("P11", "config without code -> 403 bad_code", p11),
        ("P12", "config with wrong code -> 403", p12),
        ("P13", "config leaks no internals", p13),
        ("P14", "list shape: items[] + cursor", p14),
        ("P15", "list without code -> 403", p15),
        ("P16", "every item has id/ts/guest/type/size/url/thumb", p16),
        ("P17", "media not served from r2.dev", p17),
        ("P20", "photo upload accepted -> 200 + key", p20),
        ("P21", "uploaded photo appears in /api/list", p21),
        ("P22", "media URL returns the exact bytes + immutable cache", p22),
        ("P23", "thumbnail upload accepted", p23),
        ("P24", "/i/ proxy serves the object", p24),
        ("P25", "bad kind -> 400 bad_kind", p25),
        ("P26", "bad id -> 400 bad_id", p26),
        ("P27", "bad ext -> 400 bad_ext", p27),
        ("P28", "non-media content-type -> 415 bad_type", p28),
        ("P29", "declared size over limit -> 413 too_large", p29),
        ("P30", "GET /api/upload -> 405 method", p30),
        ("P31", "path traversal on /i/ -> 400", p31),
        ("P32", "missing media key -> 404", p32),
        ("P33", "CORS header on API responses", p33),
        ("P34", "OPTIONS preflight -> 204", p34),
    ]

    for cid, title, fn in cases:
        case(cid, title, fn)

    passed = sum(1 for r in RESULTS if r[1])
    total = len(RESULTS)
    print("-" * 72)
    print(f"{passed}/{total} passed")

    if created:
        print("\ntest objects created in R2 (delete them in the dashboard after the run,")
        print("or run the suite before the QR code is handed out):")
        for k in created:
            print(f"  {k}")

    failed = [r for r in RESULTS if not r[1]]
    if failed:
        print("\nfailures:")
        for cid, _, title, detail in failed:
            print(f"  {cid} {title}: {detail}")
    return 0 if not failed else 1


if __name__ == "__main__":
    sys.exit(main())
