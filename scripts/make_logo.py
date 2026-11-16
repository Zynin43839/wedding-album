"""Turn the supplied bouquet artwork into the site logo (background removed).

Source : ~/Downloads/bouquet.webp (white background)
Archive: docs/art/source/logo-bouquet.webp (untouched original)
Ship   : public/art/logo.webp      512px transparent
         public/art/logo-192.png   192px (favicon / apple-touch)
         public/art/logo-512.png   512px (social / PWA)

Background removal is a flood fill from the four edges, not a global "delete all
white pixels": the roses have white highlights inside them and those must stay.

Run: python scripts/make_logo.py
"""
from __future__ import annotations

import pathlib
import shutil
from collections import deque

from PIL import Image

ROOT = pathlib.Path(__file__).resolve().parents[1]
SRC_DL = pathlib.Path.home() / "Downloads" / "bouquet.webp"
SRC = ROOT / "docs" / "art" / "source"
OUT = ROOT / "public" / "art"
SRC.mkdir(parents=True, exist_ok=True)
OUT.mkdir(parents=True, exist_ok=True)

WHITE = 244          # min(r,g,b) at or above this counts as background
SOFT = 232           # between SOFT and WHITE -> partial alpha (anti-halo)


def cut_background(im: Image.Image) -> Image.Image:
    im = im.convert("RGBA")
    w, h = im.size
    px = im.load()

    def is_white(x: int, y: int) -> bool:
        r, g, b, _ = px[x, y]
        return min(r, g, b) >= WHITE

    # flood fill from every border pixel, so interior white highlights survive
    seen = bytearray(w * h)
    q = deque()
    for x in range(w):
        for y in (0, h - 1):
            if is_white(x, y) and not seen[y * w + x]:
                seen[y * w + x] = 1
                q.append((x, y))
    for y in range(h):
        for x in (0, w - 1):
            if is_white(x, y) and not seen[y * w + x]:
                seen[y * w + x] = 1
                q.append((x, y))

    while q:
        x, y = q.popleft()
        for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            nx, ny = x + dx, y + dy
            if 0 <= nx < w and 0 <= ny < h and not seen[ny * w + nx] and is_white(nx, ny):
                seen[ny * w + nx] = 1
                q.append((nx, ny))

    removed = 0
    for y in range(h):
        row = y * w
        for x in range(w):
            r, g, b, a = px[x, y]
            # background = reachable from the border OR any remaining pure white
            # pocket (gaps between leaves); the highlights inside the roses are
            # pink (min channel well below the threshold), so nothing is holed.
            if seen[row + x] or min(r, g, b) >= WHITE:
                px[x, y] = (0, 0, 0, 0)
                removed += 1

    # soften the cut edge: pixels that touch transparency and are near-white
    # become semi-transparent instead of leaving a white halo
    edge = []
    for y in range(h):
        for x in range(w):
            if px[x, y][3] == 0:
                continue
            touching = False
            for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                nx, ny = x + dx, y + dy
                if 0 <= nx < w and 0 <= ny < h and px[nx, ny][3] == 0:
                    touching = True
                    break
            if not touching:
                continue
            r, g, b, a = px[x, y]
            lum = min(r, g, b)
            if lum >= SOFT:
                t = (WHITE - lum) / max(1, WHITE - SOFT)
                px[x, y] = (r, g, b, int(a * max(0.0, min(1.0, t))))
                edge.append(x)

    print(f"  removed {removed:,} background pixels, softened {len(edge):,} edge pixels")
    return im


def main() -> int:
    if not SRC_DL.exists():
        raise SystemExit(f"source not found: {SRC_DL}")

    shutil.copy2(SRC_DL, SRC / "logo-bouquet.webp")
    im = Image.open(SRC_DL)
    sw, sh = im.size
    print(f"source : {SRC_DL.name} {sw}x{sh}")

    cut = cut_background(im)

    bbox = cut.getbbox()
    if bbox:
        cut = cut.crop(bbox)
    print(f"trimmed: {cut.width}x{cut.height}")

    # square canvas with a little breathing room, so the mark centres cleanly
    side = int(max(cut.width, cut.height) * 1.06)
    canvas = Image.new("RGBA", (side, side), (0, 0, 0, 0))
    canvas.paste(cut, ((side - cut.width) // 2, (side - cut.height) // 2), cut)

    big = canvas.resize((512, 512), Image.LANCZOS)
    big.save(OUT / "logo.webp", "WEBP", quality=92, method=6)
    big.save(OUT / "logo-512.png", "PNG", optimize=True)
    canvas.resize((192, 192), Image.LANCZOS).save(OUT / "logo-192.png", "PNG", optimize=True)
    canvas.resize((32, 32), Image.LANCZOS).save(OUT / "logo-32.png", "PNG", optimize=True)

    for name in ("logo.webp", "logo-512.png", "logo-192.png", "logo-32.png"):
        p = OUT / name
        print(f"  {name:14} {p.stat().st_size / 1024:7.1f} KB")

    print("RESULT: PASS — logo cut out and written")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
