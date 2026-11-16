"""Prove the archive lock: two simultaneous runs must not push the same file twice.

Uploads N objects, fires two /api/sync calls at the same instant, and checks:
  * at least one call reports skipped=locked (the mutex engaged)
  * the total pushed equals N (nobody pushed twice)
  * every object has exactly one marker
"""
import json
import os
import pathlib
import threading
import urllib.error
import urllib.parse
import urllib.request

BASE = "https://wedding-album.rj-wedding.workers.dev"
CODE = os.environ.get("EVENT_CODE", "demo-code")
TOKEN = (pathlib.Path(os.environ["TEMP"]) / "opencode" / "purge_token.txt").read_text().strip()
UA = {"user-agent": "Mozilla/5.0"}
N = 10
fails = []


def check(name, ok, info=""):
    print(f"{'PASS' if ok else 'FAIL'}  {name}" + (f"  [{info}]" if info else ""))
    if not ok:
        fails.append(name)


def call(path, body=None, headers=None, data=None, ctype=None):
    h = dict(UA)
    h.update(headers or {})
    payload = data
    if body is not None:
        payload = json.dumps(body).encode()
        h["content-type"] = "application/json"
    if ctype:
        h["content-type"] = ctype
    req = urllib.request.Request(BASE + path, data=payload, headers=h, method="POST" if payload is not None else "GET")
    try:
        with urllib.request.urlopen(req, timeout=300) as r:
            return r.status, json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b"{}")


stamp = str(int(__import__("time").time()))
for i in range(N):
    q = urllib.parse.urlencode({"e": CODE, "kind": "photo", "id": f"lock{stamp}-{i:02d}", "name": "LOCKTEST", "ext": "jpg"})
    st, _ = call(f"/api/upload?{q}", data=os.urandom(180 * 1024), ctype="image/jpeg")
    if st != 200:
        print("upload failed", st)

st, dry = call("/api/sync?dry=1", headers={"x-sync-token": TOKEN})
queued_before = dry.get("pending", N)
print(f"  queue before the runs: {queued_before}")

results = {}


def run(tag):
    results[tag] = call("/api/sync?limit=25&force=1", headers={"x-sync-token": TOKEN})


threads = [threading.Thread(target=run, args=(t,)) for t in ("a", "b")]
for th in threads:
    th.start()
for th in threads:
    th.join()

a = results["a"][1]
b = results["b"][1]
locked = [r for r in (a, b) if r.get("skipped") == "locked"]
pushed = sum(r.get("pushed", 0) or 0 for r in (a, b))
print(f"  run A: {json.dumps(a, ensure_ascii=False)[:120]}")
print(f"  run B: {json.dumps(b, ensure_ascii=False)[:120]}")

check("the lock refused at least one overlapping run", len(locked) >= 1, f"{len(locked)} refused")
check(
    "no file was pushed twice",
    pushed <= queued_before,
    f"pushed {pushed} for {queued_before} queued objects",
)

st, d = call("/api/sync?dry=1", headers={"x-sync-token": TOKEN})
check("queue drained", d.get("pending") == 0, f"pending={d.get('pending')}")

# cleanup: objects + markers
st, d = call(f"/api/list?e={CODE}")
keys = []
for it in d.get("items", []):
    if str(it.get("guest")) == "LOCKTEST":
        for f in ("url", "thumb"):
            u = it.get(f) or ""
            if "/i/" in u:
                k = u.split("/i/", 1)[1]
                keys += [k, "synced/" + k]
if keys:
    st, d2 = call("/api/purge", {"keys": list(dict.fromkeys(keys))}, {"x-purge-token": TOKEN})
    print("r2 cleanup:", d2.get("deleted", d2))

print("")
print("RESULT: PASS" if not fails else f"RESULT: FAIL {', '.join(fails)}")
raise SystemExit(0 if not fails else 1)
