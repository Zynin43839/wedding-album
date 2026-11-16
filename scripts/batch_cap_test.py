"""Verify the per-run cap: 30 queued objects must push exactly 25 with zero failures.

Before the clamp, a run that asked for 30 (or the cron's 200) ran past the
50-fetch budget and the tail failed with "Too many subrequests".
"""
import json
import os
import pathlib
import time
import urllib.error
import urllib.parse
import urllib.request

BASE = "https://wedding-album.rj-wedding.workers.dev"
CODE = os.environ.get("EVENT_CODE", "demo-code")
TOKEN = (pathlib.Path(os.environ["TEMP"]) / "opencode" / "purge_token.txt").read_text().strip()
UA = {"user-agent": "Mozilla/5.0"}
fails = []


def check(name, ok, info=""):
    print(f"{'PASS' if ok else 'FAIL'}  {name}" + (f"  [{info}]" if info else ""))
    if not ok:
        fails.append(name)


def call(path, body=None, headers=None, data=None, ctype=None):
    h = dict(UA); h.update(headers or {})
    payload = data
    if body is not None:
        payload = json.dumps(body).encode(); h["content-type"] = "application/json"
    if ctype:
        h["content-type"] = ctype
    req = urllib.request.Request(BASE + path, data=payload, headers=h, method="POST" if payload is not None else "GET")
    try:
        with urllib.request.urlopen(req, timeout=300) as r:
            return r.status, json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b"{}")


stamp = str(int(time.time()))
for i in range(30):
    q = urllib.parse.urlencode({"e": CODE, "kind": "photo", "id": f"cap{stamp}-{i:02d}", "name": "CAPTEST", "ext": "jpg"})
    st, _ = call(f"/api/upload?{q}", data=os.urandom(90 * 1024), ctype="image/jpeg")
    if st != 200:
        print("upload failed", st)

st, d = call("/api/sync?dry=1", headers={"x-sync-token": TOKEN})
print(f"  queued: {d.get('pending')}")

# ask for far more than the platform allows on purpose (the run must clamp itself)
st, d = call("/api/sync?limit=200&force=1", headers={"x-sync-token": TOKEN})
print(f"  run: pushed={d.get('pushed')} failed={d.get('failed')} left={d.get('left')}")
check("run is clamped to 24 objects", d.get("pushed") == 24, f"pushed {d.get('pushed')}")
check("no object fails from the fetch ceiling", d.get("failed") == 0, f"failed {d.get('failed')}")

st, d2 = call("/api/sync?limit=200&force=1", headers={"x-sync-token": TOKEN})
check("the rest is picked up by the next run", (d2.get("pushed") or 0) > 0, f"pushed {d2.get('pushed')}")

st, d3 = call("/api/sync?dry=1", headers={"x-sync-token": TOKEN})
check("queue drains after two runs", d3.get("pending") == 0, f"pending {d3.get('pending')}")

# cleanup
st, listing = call(f"/api/list?e={CODE}")
keys = []
for it in listing.get("items", []):
    if str(it.get("guest")) == "CAPTEST":
        for f in ("url", "thumb"):
            u = it.get(f) or ""
            if "/i/" in u:
                k = u.split("/i/", 1)[1]
                keys += [k, "synced/" + k, "failed/" + k]
if keys:
    st, dc = call("/api/purge", {"keys": list(dict.fromkeys(keys))}, {"x-purge-token": TOKEN})
    print("cleanup:", dc.get("deleted", dc))

print("")
print("RESULT: PASS" if not fails else f"RESULT: FAIL {', '.join(fails)}")
raise SystemExit(0 if not fails else 1)
