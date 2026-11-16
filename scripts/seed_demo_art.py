#!/usr/bin/env python3
"""Seed the album with artwork generated for the RAG-Diary project.

Optionally wipes the album first, always writing a manifest of what it removed so
nothing disappears without a record.

Usage
-----
  python scripts/seed_demo_art.py --base http://127.0.0.1:8787 --manifest _backup/album_local_before_seed.md
  python scripts/seed_demo_art.py --base https://... --wipe --remote --manifest _backup/album_prod_before_seed.md
"""
from __future__ import annotations

import os

import argparse
import json
import pathlib
import subprocess
import sys
import time
import urllib.request
from io import BytesIO

from PIL import Image

ROOT = pathlib.Path(__file__).resolve().parents[1]
RAG = pathlib.Path(r"C:\Users\TEEREDCOM\Desktop\Learning\Code-along\RAG-Diary")
BUCKET = "wedding-album-media"
HDRS = {"user-agent": "Mozilla/5.0"}
CODE = os.environ.get("EVENT_CODE", "demo-code")
GUEST = "RAG-Diary"

ARTWORKS = [
    "output/mood-palette-check/month1_v3_seed0.jpg",
    "output/mood-palette-check/month1_v3_seed7.jpg",
    "output/mood-palette-check/month1_scale_s0.jpg",
    "output/mood-palette-check/month1_solve_s0.jpg",
    "frontend/public/samples/sample-1.png",
    "frontend/public/samples/sample-2.png",
    "frontend/public/samples/sample-3.png",
    "frontend/public/samples/sample-4.png",
]


def api_list(base: str) -> list[dict]:
    url = f"{base}/api/list?e={CODE}"
    with urllib.request.urlopen(urllib.request.Request(url, headers=HDRS), timeout=30) as r:
        return json.load(r).get("items", [])


def keys_of(item: dict) -> list[str]:
    out = []
    for field in ("url", "thumb"):
        raw = item.get(field) or ""
        if "/i/" in raw:
            out.append(raw.split("/i/", 1)[1])
    return [k for k in dict.fromkeys(out) if k.startswith("m/")]


def delete(key: str, remote: bool) -> bool:
    args = ["npx", "wrangler", "r2", "object", "delete", f"{BUCKET}/{key}"]
    args.append("--remote" if remote else "--local")
    p = subprocess.run(args, capture_output=True, text=True, shell=True, encoding="utf-8", errors="replace")
    return p.returncode == 0


def upload(base: str, data: bytes, ext: str, uid: str, kind: str) -> None:
    url = f"{base}/api/upload?e={CODE}&id={uid}&kind={kind}&ext={ext}&name={GUEST}"
    req = urllib.request.Request(url, data=data, method="POST", headers={**HDRS, "content-type": "image/jpeg"})
    urllib.request.urlopen(req, timeout=60).read()


def shrink(path: pathlib.Path, max_edge: int = 1600) -> tuple[bytes, str, int, int]:
    im = Image.open(path)
    im = im.convert("RGB")
    w, h = im.size
    im.thumbnail((max_edge, max_edge), Image.LANCZOS)
    buf = BytesIO()
    im.save(buf, "JPEG", quality=86)
    return buf.getvalue(), "jpg", w, h


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", required=True)
    ap.add_argument("--wipe", action="store_true")
    ap.add_argument("--remote", action="store_true", help="delete from R2 (default: local dev store)")
    ap.add_argument("--manifest", default="")
    ap.add_argument("--limit", type=int, default=0)
    args = ap.parse_args()

    base = args.base.rstrip("/")
    items = api_list(base)
    print(f"album before : {len(items)} items")

    if args.wipe:
        lines = ["| type | guest | size KB | id | keys |", "|---|---|---|---|---|"]
        for it in items:
            keys = keys_of(it)
            lines.append(
                f"| {it['type']} | {it['guest']} | {it.get('size', 0) / 1024:.0f} | {it['id']} | {', '.join(keys)} |"
            )
        note = (
            f"# Album before seeding RAG-Diary art — {time.strftime('%Y-%m-%d %H:%M')}\n\n"
            f"Target: {base}\n\nItems: {len(items)}\n\n" + "\n".join(lines) + "\n"
        )
        if args.manifest:
            mp = ROOT / args.manifest
            mp.parent.mkdir(parents=True, exist_ok=True)
            mp.write_text(note, encoding="utf-8")
            print(f"manifest     : {mp}")

        removed = 0
        for it in items:
            for k in keys_of(it):
                if delete(k, args.remote):
                    removed += 1
        print(f"deleted      : {removed} objects")

    added = 0
    for i, rel in enumerate(ARTWORKS):
        p = RAG / rel
        if not p.exists():
            print(f"  missing {rel}")
            continue
        data, ext, ow, oh = shrink(p)
        uid = f"rag{int(time.time() * 1000)}{i}"
        try:
            upload(base, data, ext, uid, "photo")
            added += 1
            print(f"  + {p.name:22} {ow}x{oh} -> {len(data) / 1024:.0f} KB  {uid}")
        except Exception as e:  # noqa: BLE001
            print(f"  ! {p.name}: {e}")

    print("-" * 70)
    print(f"album after  : {len(api_list(base))} items ({added} uploaded)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
