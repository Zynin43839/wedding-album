"""Burst test: many devices uploading at once, like a full wedding table.

Simulates N guests each sending a photo + thumbnail concurrently and reports
throughput / failure rate plus the final object count from /api/list.

Run: python scripts/load_test.py [guests] [photos_per_guest]
"""
import os
import base64
import json
import random
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

BASE = "http://127.0.0.1:8787"
CODE = os.environ.get("EVENT_CODE", "demo-code")

GUESTS = int(sys.argv[1]) if len(sys.argv) > 1 else 40
PER_GUEST = int(sys.argv[2]) if len(sys.argv) > 2 else 3

JPEG = base64.b64decode(
    "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a"
    "HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAA"
    "AAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q=="
)

# ~1 MB payload to mimic a real resized phone photo
PAYLOAD = JPEG + b"\x00" * (1024 * 1024 - len(JPEG))

lock = threading.Lock()
stats = {"ok": 0, "fail": 0, "bytes": 0, "errors": {}}


def put(url, body, ctype):
    req = urllib.request.Request(url, data=body, method="POST")
    req.add_header("content-type", ctype)
    with urllib.request.urlopen(req, timeout=60) as r:
        return r.status


def worker(guest_idx):
    name = f"Guest{guest_idx}"
    for i in range(PER_GUEST):
        pid = f"{int(time.time() * 1000)}-{random.randrange(16**6):06x}"
        for kind, ext in (("photo", "jpg"), ("thumb", "jpg")):
            q = urllib.parse.urlencode(
                {"e": CODE, "id": pid, "kind": kind, "ext": ext, "name": name}
            )
            try:
                status = put(f"{BASE}/api/upload?{q}", PAYLOAD if kind == "photo" else JPEG, "image/jpeg")
                with lock:
                    if status == 200:
                        stats["ok"] += 1
                        stats["bytes"] += len(PAYLOAD) if kind == "photo" else len(JPEG)
                    else:
                        stats["fail"] += 1
            except Exception as e:  # noqa: BLE001
                with lock:
                    stats["fail"] += 1
                    key = type(e).__name__ + ":" + str(getattr(e, "code", ""))
                    stats["errors"][key] = stats["errors"].get(key, 0) + 1


print(f"simulating {GUESTS} guests x {PER_GUEST} photos ({GUESTS * PER_GUEST * 2} requests)")
t0 = time.time()

threads = [threading.Thread(target=worker, args=(i,)) for i in range(GUESTS)]
for t in threads:
    t.start()
for t in threads:
    t.join()

elapsed = time.time() - t0
total = stats["ok"] + stats["fail"]

print()
print(f"elapsed      : {elapsed:.1f}s")
print(f"requests ok  : {stats['ok']} / {total}")
print(f"failures     : {stats['fail']}")
print(f"uploaded     : {stats['bytes'] / 1024 / 1024:.1f} MB")
if elapsed:
    print(f"throughput   : {total / elapsed:.1f} req/s, {stats['bytes'] / 1024 / 1024 / elapsed:.2f} MB/s")
if stats["errors"]:
    print("errors       :", stats["errors"])

# verify the album reflects the uploads
with urllib.request.urlopen(f"{BASE}/api/list?{urllib.parse.urlencode({'e': CODE})}", timeout=60) as r:
    data = json.loads(r.read())

print(f"list items   : {data['count']} (cursor: {'yes' if data['cursor'] else 'no'})")

fails = stats["fail"]
if fails == 0 and data["count"] > 0:
    print("\nRESULT: PASS")
    sys.exit(0)

print("\nRESULT: FAIL")
sys.exit(1)
