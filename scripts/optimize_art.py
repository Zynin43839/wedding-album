"""Bring the AI-generated floral art into the project.

Source  : ~/Downloads  (sprig.jpg, Divider.jpg, bouquet.webp, wash.webp)
Archive : docs/art/source/   (originals, untouched)
Ship    : public/art/*.webp  (auto-cropped to content, resized, recompressed)

Run: python scripts/optimize_art.py
"""
from pathlib import Path
from PIL import Image, ImageChops
import shutil

ROOT = Path(__file__).resolve().parents[1]
DL = Path.home() / "Downloads"
SRC = ROOT / "docs" / "art" / "source"
OUT = ROOT / "public" / "art"
SRC.mkdir(parents=True, exist_ok=True)
OUT.mkdir(parents=True, exist_ok=True)

# name, download filename, max box, webp quality, crop white margins?
JOBS = [
    ("sprig", "sprig.jpg", (520, 780), 84, True),
    ("divider", "Divider.jpg", (760, 200), 86, True),
    ("bouquet", "bouquet.webp", (460, 460), 84, True),
    ("wash", "wash.webp", (900, 900), 90, False),  # background: never crop
]

THRESHOLD = 6  # how far from pure white counts as "content"
PAD = 0.03     # keep 3% breathing room around the subject


def content_bbox(im):
    diff = ImageChops.difference(im, Image.new("RGB", im.size, (255, 255, 255)))
    mask = diff.convert("L").point(lambda v: 255 if v > THRESHOLD else 0)
    box = mask.getbbox()
    if not box:
        return None
    pad_x = int((box[2] - box[0]) * PAD)
    pad_y = int((box[3] - box[1]) * PAD)
    return (
        max(0, box[0] - pad_x),
        max(0, box[1] - pad_y),
        min(im.width, box[2] + pad_x),
        min(im.height, box[3] + pad_y),
    )


print(f"{'asset':9} {'source px':>12} {'cropped px':>14} {'shipped px':>12} {'in KB':>8} {'out KB':>7}")
print("-" * 76)

for name, fname, box, q, do_crop in JOBS:
    src = DL / fname
    if not src.exists():
        print(f"{name:9} {fname:16} MISSING in Downloads — skipped")
        continue

    archived = SRC / f"{name}{src.suffix.lower()}"
    shutil.copy2(src, archived)

    im = Image.open(src).convert("RGB")
    sw, sh = im.size
    cropped = "-"
    if do_crop:
        bb = content_bbox(im)
        if bb:
            im = im.crop(bb)
            cropped = f"{im.width}x{im.height}"

    im.thumbnail(box, Image.LANCZOS)
    out = OUT / f"{name}.webp"
    im.save(out, "WEBP", quality=q, method=6)

    print(
        f"{name:9} {sw}x{sh:<7} {cropped:>14} {im.width}x{im.height:<7}"
        f" {src.stat().st_size / 1024:8.0f} {out.stat().st_size / 1024:7.1f}"
    )

total = sum(p.stat().st_size for p in OUT.glob("*.webp"))
print("-" * 76)
print(f"total shipped: {total / 1024:.1f} KB  in {OUT}")
