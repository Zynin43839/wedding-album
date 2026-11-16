"""Compare a real phone photo against what the album stores, with labels drawn on.

Source : a real 4.8 MB JPEG found on this machine (not a generated picture)
Output : docs/screenshots/compare-original-vs-compact.png

Left  = the file as it came off the phone
Right = the same photo after the app's own rule (long edge 2048, JPEG q0.85)
Below = 100% crops of the same region, so sharpness can be judged

Run: python scripts/compare_real_photo.py [source.jpg]
"""
from __future__ import annotations

import math
import pathlib
import sys
from io import BytesIO

import numpy as np
from PIL import Image, ImageDraw, ImageFont

ROOT = pathlib.Path(__file__).resolve().parents[1]
OUT = ROOT / "docs" / "screenshots"
FONT_B = pathlib.Path("C:/Windows/Fonts/LeelaUIb.ttf")
FONT_R = pathlib.Path("C:/Windows/Fonts/leelawui.ttf")

DEFAULT_SRC = pathlib.Path.home() / "Downloads" / "IMG_5312.JPG"

INK = (63, 82, 51)
SOFT = (107, 122, 94)
GREEN = (99, 127, 79)
SEAL = (192, 84, 76)
PAPER = (251, 248, 243)
RULE = (232, 222, 209)


def psnr(a, b) -> float:
    mse = float(np.mean((a.astype(np.float64) - b.astype(np.float64)) ** 2))
    return 99.0 if mse == 0 else 10 * math.log10(255.0**2 / mse)


def ssim_blocks(a, b, block=8) -> float:
    a = a.astype(np.float64)
    b = b.astype(np.float64)
    h, w = a.shape[:2]
    c1, c2 = (0.01 * 255) ** 2, (0.03 * 255) ** 2
    vals = []
    for y in range(0, h - block + 1, block):
        for x in range(0, w - block + 1, block):
            pa, pb = a[y:y + block, x:x + block], b[y:y + block, x:x + block]
            ma, mb = pa.mean(), pb.mean()
            va, vb = pa.var(), pb.var()
            cov = ((pa - ma) * (pb - mb)).mean()
            vals.append(((2 * ma * mb + c1) * (2 * cov + c2)) / ((ma**2 + mb**2 + c1) * (va + vb + c2)))
    return float(np.mean(vals))


def compress_like_the_app(src: Image.Image) -> tuple[bytes, int, int]:
    """Exactly the app's branch for a 3-5 MB photo: long edge 2048, q0.85."""
    w, h = src.size
    scale = min(1.0, 2048 / max(w, h))
    out = src.resize((round(w * scale), round(h * scale)), Image.LANCZOS) if scale < 1 else src.copy()
    buf = BytesIO()
    q = 85
    out.save(buf, "JPEG", quality=q, optimize=True)
    while len(buf.getvalue()) > 2 * 1024 * 1024 and q > 70:
        q -= 5
        buf = BytesIO()
        out.save(buf, "JPEG", quality=q, optimize=True)
    return buf.getvalue(), q, 2048


def main() -> int:
    src_path = pathlib.Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_SRC
    if not src_path.exists():
        raise SystemExit(f"not found: {src_path}")

    orig_bytes = src_path.stat().st_size
    orig = Image.open(src_path).convert("RGB")
    comp_bytes, q, _ = compress_like_the_app(orig)
    comp = Image.open(BytesIO(comp_bytes)).convert("RGB")

    p = psnr(np.asarray(orig.resize(comp.size, Image.LANCZOS)), np.asarray(comp))
    s = ssim_blocks(np.asarray(orig.resize(comp.size, Image.LANCZOS)), np.asarray(comp))

    print(f"source : {src_path.name}")
    print(f"original : {orig.width}x{orig.height}  {orig_bytes / 1024 / 1024:.2f} MB")
    print(f"compact  : {comp.width}x{comp.height}  {len(comp_bytes) / 1024 / 1024:.2f} MB (q{q})")
    print(f"ratio    : {orig_bytes / len(comp_bytes):.1f}:1   PSNR {p:.1f} dB   SSIM {s:.3f}")

    # ── layout ───────────────────────────────────────────────────────────
    panel_w = 820
    pad = 34
    label_h = 76
    gap = 26

    def fit(im: Image.Image, w: int) -> Image.Image:
        h = round(im.height * w / im.width)
        return im.resize((w, h), Image.LANCZOS)

    left_top = fit(orig, panel_w)
    right_top = fit(comp, panel_w)
    top_h = max(left_top.height, right_top.height)

    # 100% crop of the ORIGINAL, and the same content from the compact one,
    # upscaled to the same display size so sharpness can be compared fairly
    crop_px = 620
    factor = orig.width / comp.width
    cx, cy = int(orig.width * 0.34), int(orig.height * 0.30)
    left_crop = orig.crop((cx, cy, cx + crop_px, cy + crop_px))

    small = max(1, round(crop_px / factor))
    rx, ry = int(comp.width * 0.34), int(comp.height * 0.30)
    right_crop = comp.crop((rx, ry, rx + small, ry + small)).resize((crop_px, crop_px), Image.LANCZOS)

    W = pad * 2 + panel_w * 2 + gap
    H = pad + 54 + label_h + top_h + 54 + crop_px + 92 + pad
    sheet = Image.new("RGB", (W, H), PAPER)
    d = ImageDraw.Draw(sheet)

    f_title = ImageFont.truetype(str(FONT_B), 34)
    f_label = ImageFont.truetype(str(FONT_B), 24)
    f_meta = ImageFont.truetype(str(FONT_R), 21)
    f_small = ImageFont.truetype(str(FONT_R), 19)

    d.text((pad, pad - 6), "ต้นฉบับจากมือถือ  vs  ภาพที่อัลบั้มเก็บไว้", font=f_title, fill=INK)

    y = pad + 54
    for i, (label, meta, colour, im_top, im_crop) in enumerate([
        (
            "ต้นฉบับ (Original)",
            f"{orig.width}×{orig.height} · {orig_bytes / 1024 / 1024:.2f} MB",
            SOFT,
            left_top,
            left_crop,
        ),
        (
            "หลัง Compact",
            f"{comp.width}×{comp.height} · {len(comp_bytes) / 1024 / 1024:.2f} MB",
            GREEN,
            right_top,
            right_crop,
        ),
    ]):
        x = pad + i * (panel_w + gap)
        d.rectangle([x, y, x + panel_w, y + label_h - 10], fill=colour)
        d.text((x + 16, y + 9), label, font=f_label, fill=(255, 255, 255))
        d.text((x + 16, y + 40), meta, font=f_meta, fill=(255, 255, 255))

        sheet.paste(im_top, (x, y + label_h))
        d.rectangle([x, y + label_h, x + im_top.width, y + label_h + im_top.height], outline=RULE, width=2)

        # crop row
        cyy = y + label_h + top_h + 46
        d.text(
            (x, cyy - 32),
            "จุดเดียวกัน — ต้นฉบับ 100%" if i == 0 else "จุดเดียวกัน — Compact ขยายให้เท่ากัน",
            font=f_small,
            fill=SOFT,
        )
        sheet.paste(im_crop, (x, cyy))
        d.rectangle([x, cyy, x + im_crop.width, cyy + im_crop.height], outline=RULE, width=2)

    foot_y = H - pad - 46
    d.line([pad, foot_y - 14, W - pad, foot_y - 14], fill=RULE, width=2)
    d.text(
        (pad, foot_y),
        f"อัตราส่วนบีบ {orig_bytes / len(comp_bytes):.1f}:1 · PSNR {p:.1f} dB · SSIM {s:.3f} "
        f"· วิธีเดียวกับแอป (ด้านยาว 2048 px, JPEG q{q})",
        font=f_meta,
        fill=SEAL,
    )

    OUT.mkdir(parents=True, exist_ok=True)
    path = OUT / "compare-original-vs-compact.png"
    sheet.save(path)
    print(f"\nsaved : {path}  ({sheet.width}x{sheet.height})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
