#!/usr/bin/env python3
"""Bulk-delete album objects through the Worker (one request per ~900 objects).

This exists because of the Bulk Operation Law: a CLI-per-item loop (`npx wrangler
r2 object delete` once per object) is a design error. `POST /api/purge` uses the
R2 binding's array delete, so 900 deletions cost ONE request and ZERO processes.

Load projection is printed before anything is deleted (rule 4).

Usage
-----
  python scripts/purge.py --base <url> --token <PURGE_TOKEN> --dry-run --prefix m/sc
  python scripts/purge.py --base <url> --token <T> --ids-prefix sc      # album ids
  python scripts/purge.py --base <url> --token <T> --guest FLOOD
  python scripts/purge.py --base <url> --token <T> --all
"""
from __future__ import annotations

import argparse
import json
import urllib.parse
import urllib.request

CODE = "demo-code"
UA = {"user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/131.0.0.0"}


def api(base: str, path: str, body: dict | None = None, headers: dict | None = None):
    h = dict(UA)
    h.update(headers or {})
    data = None
    if body is not None:
        data = json.dumps(body).encode()
        h["content-type"] = "application/json"
    req = urllib.request.Request(base + path, data=data, headers=h, method="POST" if body is not None else "GET")
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            return r.status, json.load(r)
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b"{}")


def list_all(base: str) -> list[dict]:
    items, cursor, pages = [], None, 0
    while True:
        q = f"/api/list?e={CODE}" + (f"&cursor={urllib.parse.quote(cursor)}" if cursor else "")
        st, d = api(base, q)
        if st != 200:
            raise SystemExit(f"list failed: {st} {d}")
        items.extend(d.get("items", []))
        pages += 1
        cursor = d.get("cursor")
        if not cursor or pages > 300:
            return items


def keys_of(item: dict) -> list[str]:
    out = []
    for field in ("url", "thumb"):
        raw = item.get(field) or ""
        if "/i/" in raw:
            out.append(raw.split("/i/", 1)[1])
    return [k for k in dict.fromkeys(out) if k.startswith("m/")]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", required=True)
    ap.add_argument("--token", required=True)
    ap.add_argument("--all", action="store_true")
    ap.add_argument("--guest", default=None)
    ap.add_argument("--ids-prefix", default=None)
    ap.add_argument("--prefix", default=None, help="raw R2 key prefix, e.g. m/sc")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    base = args.base.rstrip("/")
    hdr = {"x-purge-token": args.token}

    if args.prefix:
        st, d = api(base, "/api/purge", {"prefix": args.prefix, "dryRun": True, "limit": 900}, hdr)
        if st != 200:
            print(f"purge refused: {st} {d}")
            return 1
        remaining = d.get("wouldDelete", 0)
        print(f"prefix {args.prefix}: {remaining} objects in the first 900")
        if args.dry_run:
            print("dry run, nothing deleted")
            return 0

        total = 0
        while remaining:
            st, d = api(base, "/api/purge", {"prefix": args.prefix, "limit": 900}, hdr)
            if st != 200:
                print(f"purge failed: {st} {d}")
                return 1
            total += d.get("deleted", 0)
            print(f"  deleted {total}", flush=True)
            st, d2 = api(base, "/api/purge", {"prefix": args.prefix, "limit": 900, "dryRun": True}, hdr)
            remaining = d2.get("wouldDelete", 0) if st == 200 else 0
            if d.get("deleted", 0) == 0:
                break
        print(f"done: {total} objects deleted")
        return 0

    items = list_all(base)
    if args.all:
        target = items
    elif args.guest:
        target = [i for i in items if str(i.get("guest", "")).startswith(args.guest)]
    elif args.ids_prefix:
        target = [i for i in items if str(i.get("id", "")).startswith(args.ids_prefix.lower())]
    else:
        print("pick --all, --guest, --ids-prefix or --prefix")
        return 1

    keys = [k for it in target for k in keys_of(it)]
    requests_needed = max(1, -(-len(keys) // 900))

    print(f"album          : {len(items)} items")
    print(f"selected       : {len(target)} items")
    print(f"objects        : {len(keys)}")
    print(f"load projection: {len(keys)} objects -> {requests_needed} HTTP request(s), 0 CLI processes")
    print(f"                 ({'batched, within the law' if requests_needed <= 5 else 'still batched, just several requests'})")

    if args.dry_run:
        print("dry run, nothing deleted")
        return 0

    deleted = 0
    for i in range(0, len(keys), 900):
        chunk = keys[i:i + 900]
        st, d = api(base, "/api/purge", {"keys": chunk}, hdr)
        if st != 200:
            print(f"purge failed: {st} {d}")
            return 1
        deleted += d.get("deleted", 0)
        print(f"  chunk {i // 900 + 1}: deleted {d.get('deleted', 0)} (total {deleted})", flush=True)

    left = list_all(base)
    print(f"done: {deleted} objects deleted, album now {len(left)} items")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
