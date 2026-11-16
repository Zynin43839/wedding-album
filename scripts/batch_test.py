#!/usr/bin/env python3
"""Prove threshold batching and the two failure policies, step by step.

Run one step at a time; the operator changes wrangler.toml + deploys between
steps (that is the only way to change the Worker's vars).

  python scripts/batch_test.py --base URL --token T --step 1a
  ...
  python scripts/batch_test.py --base URL --token T --step cleanup
"""
from __future__ import annotations

import argparse
import json
import os
import pathlib
import time
import urllib.error
import urllib.parse
import urllib.request

CODE = "demo-code"
UA = {"user-agent": "Mozilla/5.0"}
STAMP_PATH = pathlib.Path(os.environ["TEMP"]) / "opencode" / "batch_stamp.txt"
fails: list[str] = []


def check(name: str, ok: bool, info: str = "") -> None:
    print(f"{'PASS' if ok else 'FAIL'}  {name}" + (f"  [{info}]" if info else ""))
    if not ok:
        fails.append(name)


def call(base: str, path: str, body=None, headers=None, data=None, ctype=None):
    h = dict(UA)
    h.update(headers or {})
    payload = data
    if body is not None:
        payload = json.dumps(body).encode()
        h["content-type"] = "application/json"
    if ctype:
        h["content-type"] = ctype
    req = urllib.request.Request(base + path, data=payload, headers=h, method="POST" if payload is not None else "GET")
    try:
        with urllib.request.urlopen(req, timeout=300) as r:
            return r.status, json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b"{}")


def upload(base: str, ident: str, size: int = 200 * 1024) -> int:
    q = urllib.parse.urlencode({"e": CODE, "kind": "photo", "id": ident, "name": "BATCHTEST", "ext": "jpg"})
    st, _ = call(base, f"/api/upload?{q}", data=os.urandom(size), ctype="image/jpeg")
    return st


def stamp() -> str:
    if STAMP_PATH.exists():
        return STAMP_PATH.read_text().strip()
    s = str(int(time.time()))
    STAMP_PATH.write_text(s)
    return s


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", required=True)
    ap.add_argument("--token", required=True)
    ap.add_argument("--step", required=True)
    args = ap.parse_args()
    base = args.base.rstrip("/")
    hdr = {"x-sync-token": args.token}
    s = stamp()
    step = args.step

    if step == "1a":  # below the threshold: nothing may be pushed
        for i in range(10):
            upload(base, f"bt{s}-{i:03d}")
        st, d = call(base, "/api/sync", headers=hdr)
        check("10 files are below the 25 threshold -> skipped", d.get("skipped") == "below_threshold", json.dumps(d, ensure_ascii=False)[:120])
        st, d = call(base, "/api/sync?dry=1", headers=hdr)
        check("pending counts them", d.get("pending") == 10, f"pending={d.get('pending')} wouldPush={d.get('wouldPush')}")

    elif step == "1b":  # cross the threshold: one wrapped push
        for i in range(10, 30):
            upload(base, f"bt{s}-{i:03d}")
        st, d = call(base, "/api/sync", headers=hdr)
        check("threshold reached -> one batch pushed", d.get("pushed") == 25, f"pushed={d.get('pushed')} failed={d.get('failed')} left={d.get('left')}")
        check("the rest waits for the next batch", d.get("left") == 5, f"left={d.get('left')}")

    elif step == "2":  # Drive refuses: nothing is marked, so it stays queued
        for i in range(30, 33):
            upload(base, f"bt{s}-{i:03d}")
        st, d = call(base, "/api/sync?limit=3&force=1", headers=hdr)
        check("all 3 fail with a bad folder", d.get("failed") == 3 and d.get("pushed") == 0, json.dumps(d.get("errors"), ensure_ascii=False)[:140])
        st, d = call(base, "/api/sync?dry=1", headers=hdr)
        check("failures stay in the queue (requeue)", d.get("pending", 0) >= 8, f"pending={d.get('pending')}")
        st, d = call(base, "/api/sync?failed=1", headers=hdr)
        check("ledger records the failures", len(d.get("failed", [])) == 3, f"{len(d.get('failed', []))} entries")

    elif step == "3":  # skip mode: mark as failed and stop retrying
        st, d = call(base, "/api/sync?limit=2&force=1", headers=hdr)
        check("skip mode still reports failures", d.get("failed") == 2, json.dumps(d, ensure_ascii=False)[:140])
        check("mode is reported as skip", d.get("mode") == "skip", f"mode={d.get('mode')}")

    elif step == "4":  # after restoring the folder: requeued files go through
        st, d = call(base, "/api/sync?limit=25&force=1", headers=hdr)
        check("requeued files now succeed", d.get("pushed", 0) >= 6, f"pushed={d.get('pushed')} failed={d.get('failed')}")

    elif step == "5":  # the two skipped ones must NOT be pushed
        st, d = call(base, "/api/sync?limit=25&force=1", headers=hdr)
        check("skipped files are not retried", d.get("pushed") == 0, f"pushed={d.get('pushed')}")
        st, d = call(base, "/api/sync?dry=1", headers=hdr)
        check("queue is empty", d.get("pending") == 0, f"pending={d.get('pending')}")

    elif step == "cleanup":
        # R2 objects + markers (synced/ and failed/)
        st, d = call(base, f"/api/list?e={CODE}")
        keys = []
        for it in d.get("items", []):
            if str(it.get("guest")) == "BATCHTEST":
                for f in ("url", "thumb"):
                    u = it.get(f) or ""
                    if "/i/" in u:
                        k = u.split("/i/", 1)[1]
                        keys += [k, "synced/" + k, "failed/" + k]
        keys = list(dict.fromkeys(k for k in keys if k))
        if keys:
            st, d2 = call(base, "/api/purge", {"keys": keys}, {"x-purge-token": args.token})
            print("r2 cleanup:", d2.get("deleted", d2))
        st, d = call(base, "/api/sync?cleanup=1&prefix=bt&confirm=yes&limit=25", headers=hdr)
        if st != 200:
            st, d = call(base, "/api/sync?cleanup=1&prefix=batch&confirm=yes&limit=25", headers=hdr)
        print("drive cleanup:", d.get("deleted", d))
        st, d = call(base, f"/api/list?e={CODE}")
        print("album items:", len(d.get("items", [])))

    print(f"\n{'RESULT: PASS' if not fails else 'RESULT: FAIL ' + ', '.join(fails)}")
    return 0 if not fails else 1


if __name__ == "__main__":
    raise SystemExit(main())
