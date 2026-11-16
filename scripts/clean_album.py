#!/usr/bin/env python3
"""Delete photos from the LIVE album, in bulk, without freezing the machine.

The Worker deliberately has no delete endpoint (no per-guest auth), so cleanup
goes through R2. Two engines, picked automatically:

  > 20 keys + R2 token  -> boto3 DeleteObjects, ~1 request, ~2 s
  <= 20 keys / --local  -> direct wrangler binary, ~2.4 s per key

Both paths report the projected load before touching anything, and the
per-object path runs under BulkGuard so it can never turn into a process storm.

Usage
-----
  python scripts/clean_album.py --list                  # show the album, change nothing
  python scripts/clean_album.py --guest TEST --dry-run  # show what would be deleted
  python scripts/clean_album.py --guest TEST            # delete items whose guest starts with TEST
  python scripts/clean_album.py --guest "ทดสอบ"          # Thai prefix works too
  python scripts/clean_album.py --all --yes             # wipe the whole album (before the event)

  # force an engine
  python scripts/clean_album.py --all --yes --engine bulk
  python scripts/clean_album.py --guest TEST --engine wrangler --parallel 2
  python scripts/clean_album.py --guest TEST --local    # local dev store (Miniflare)

Always run --list or --dry-run first. Deletion is permanent; a manifest of what
was removed is written to _backup/ by default.
"""
from __future__ import annotations

import argparse
import json
import pathlib
import sys
import time
import urllib.request
from urllib.parse import quote

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

from bulk_guard import BulkGuard, BulkAbort  # noqa: E402
from r2_delete import (  # noqa: E402
    BUCKET,
    CredentialMissing,
    delete_keys,
    load_credentials,
)

DEFAULT_BASE = "https://wedding-album.rj-wedding.workers.dev"
HDRS = {"user-agent": "Mozilla/5.0"}
PROCESS_COST = {"bulk": 1, "wrangler": 2}  # measured: npx=5, direct node=2, bulk=1


def fetch_items(base: str, code: str) -> list[dict]:
    """Page through the WHOLE album, not just the first page."""
    items: list[dict] = []
    cursor = None
    for _ in range(500):
        url = f"{base}/api/list?e={code}" + (f"&cursor={quote(cursor)}" if cursor else "")
        req = urllib.request.Request(url, headers=HDRS)
        with urllib.request.urlopen(req, timeout=30) as r:
            data = json.load(r)
        items.extend(data.get("items", []))
        cursor = data.get("cursor")
        if not cursor:
            break
    return items


def keys_of(item: dict) -> list[str]:
    out = []
    for field in ("url", "thumb"):
        raw = item.get(field) or ""
        if "/i/" in raw:
            out.append(raw.split("/i/", 1)[1])
    return [k for k in dict.fromkeys(out) if k.startswith("m/")]


def write_manifest(keys: list[str], target: str, engine: str, path: pathlib.Path) -> pathlib.Path:
    stamp = time.strftime("%Y-%m-%d %H:%M")
    body = [f"# Album cleanup plan - {stamp}", "",
            f"Target : {target}", f"Engine : {engine}",
            f"Keys   : {len(keys)}", "",
            "| # | key |", "|---|---|"]
    body += [f"| {i} | {k} |" for i, k in enumerate(keys, 1)]
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(body) + "\n", encoding="utf-8")
    return path


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default=DEFAULT_BASE)
    ap.add_argument("--code", default="demo-code")
    ap.add_argument("--guest", default=None, help="delete items whose guest name starts with this")
    ap.add_argument("--id-prefix", default=None, help="delete items whose id starts with this")
    ap.add_argument("--all", action="store_true", help="delete every item")
    ap.add_argument("--list", action="store_true", help="only list, delete nothing")
    ap.add_argument("--yes", action="store_true", help="skip the confirmation for --all")
    ap.add_argument("--dry-run", action="store_true", help="show the plan, delete nothing")
    ap.add_argument("--engine", choices=("auto", "bulk", "wrangler"), default="auto",
                    help="auto: bulk for big jobs when a token exists, else wrangler")
    ap.add_argument("--parallel", type=int, default=2,
                    help="objects at once for the wrangler engine (capped by BulkGuard)")
    ap.add_argument("--threshold", type=int, default=20,
                    help="key count above which auto picks the bulk engine")
    ap.add_argument("--manifest", default="", help="write the key list here before deleting")
    ap.add_argument("--local", action="store_true", help="target the local dev store")
    args = ap.parse_args()

    items = fetch_items(args.base, args.code)
    keys_all = [k for it in items for k in keys_of(it)]
    print(f"album : {args.base}  ({len(items)} items, {len(keys_all)} R2 keys)")
    print("-" * 78)
    for it in items:
        print(f"  {it['type']:5} | {it['guest'][:20]:20} | {it.get('size', 0) / 1024:8.0f} KB | {it['id']}")
    print("-" * 78)

    if args.list:
        return 0

    if args.all:
        target = items
    elif args.guest:
        target = [i for i in items if str(i.get("guest", "")).startswith(args.guest)]
    elif args.id_prefix:
        target = [i for i in items if str(i.get("id", "")).startswith(args.id_prefix.lower())]
    else:
        print("nothing to do - pass --guest <prefix>, --all or --list")
        return 0

    if not target:
        print("no matching items")
        return 0

    if args.all and not args.yes:
        print(f"refusing to delete all {len(target)} items without --yes")
        return 1

    keys = list(dict.fromkeys(k for it in target for k in keys_of(it)))

    # --- plan, before any destructive step -------------------------------
    creds = None if args.local else load_credentials(ROOT)
    engine = args.engine
    if engine == "auto":
        engine = "bulk" if (len(keys) > args.threshold and creds) else "wrangler"
    per_item = PROCESS_COST[engine]
    projected = len(keys) * per_item
    print(f"plan   : {len(target)} items -> {len(keys)} keys")
    print(f"engine : {engine}"
          + ("  (S3 API, 1 request)" if engine == "bulk" else "  (direct wrangler, no npx)"))
    print(f"load   : ~{projected} process creations, parallel {min(args.parallel, 2)}")
    if engine == "bulk" and not creds:
        print()
        print("bulk engine requested but no R2 token found; run with --engine wrangler")
        return 1
    if engine == "wrangler" and len(keys) > args.threshold:
        print(f"note   : {len(keys)} keys through wrangler takes ~{len(keys) * 2.42 / max(1, args.parallel):.0f} s.")
        print("         Adding an R2 token makes this ~2 s (see scripts/r2_delete.py).")

    if args.manifest:
        path = write_manifest(keys, args.base, engine, ROOT / args.manifest)
        print(f"manifest: {path}")

    if args.dry_run:
        print(f"\nDRY RUN - nothing deleted. {len(keys)} keys would go via {engine}.")
        return 0

    # --- delete ----------------------------------------------------------
    guard = BulkGuard(label="clean_album", max_workers=min(args.parallel, 2))
    try:
        guard.check(planned_items=len(keys), processes_per_item=per_item)
        result = delete_keys(keys, ROOT, local=args.local, dry_run=False,
                             threshold=args.threshold, engine=engine, guard=guard)
    except BulkAbort as exc:
        print(f"\nABORTED: {exc}", flush=True)
        print("Nothing further was scheduled. Re-run --list to see what is left.")
        return 2
    except CredentialMissing as exc:
        print(str(exc))
        return 1

    print("-" * 78)
    print(result.summary())
    if result.errors:
        for key, why in result.errors[:10]:
            print(f"  FAILED {key}: {why}")
        if len(result.errors) > 10:
            print(f"  ... {len(result.errors) - 10} more failures")
    print(guard.report())

    left = fetch_items(args.base, args.code)
    print(f"album now holds {len(left)} items")
    return 0 if result.ok and (args.all or not left) else (0 if result.ok else 1)


if __name__ == "__main__":
    sys.exit(main())
