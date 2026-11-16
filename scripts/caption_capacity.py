"""How much Thai text fits in a framed photo's caption area?

Measures with the real font (Leelawadee UI, the same family the site falls back
to when Google Fonts is unavailable) instead of guessing characters-per-line.

Also renders one sample so the result can be judged by eye.

Run: python scripts/caption_capacity.py
"""
from __future__ import annotations

import math
import pathlib

from PIL import Image, ImageDraw, ImageFont

ROOT = pathlib.Path(__file__).resolve().parents[1]
OUT = ROOT / "docs" / "screenshots"
FONT = pathlib.Path("C:/Windows/Fonts/leelawui.ttf")
FONT_BOLD = pathlib.Path("C:/Windows/Fonts/LeelaUIb.ttf")

SAMPLE = "ขอให้ชีวิตคู่เต็มไปด้วยความรัก ความเข้าใจ และความสุขตลอดไป"
LONG = (
    "ขอให้ทั้งสองคนมีชีวิตคู่ที่อบอุ่นและมั่นคง มีกำลังใจให้กันในทุกวัน "
    "พบเจอแต่เรื่องดี ๆ และมีความสุขสมหวังในทุกสิ่งที่ตั้งใจไว้"
)
MEAS = ImageDraw.Draw(Image.new("RGB", (8, 8)))

PHOTOS = [
    ("portrait 4:3 (มือถือ)", 1536, 2048),
    ("portrait 3:4 (มือถือ)", 1440, 1920),
    ("square", 1600, 1600),
    ("landscape 4:3", 2048, 1536),
    ("landscape 16:9", 2048, 1152),
]

THAI_PER_WORD = 3.6  # ค่าเฉลี่ยของคำไทยในคำอวยพร


def width(text: str, f) -> float:
    l, _, r, _ = MEAS.textbbox((0, 0), text, font=f)
    return r - l


def chars_per_line(text: str, f, max_w: float) -> float:
    """Average characters per line by measuring the string and scaling."""
    w = width(text, f)
    return len(text) * (max_w / w) if w else 0


def main() -> int:
    print(f"{'photo':24} {'px':>12} {'pad':>5} {'band':>5} {'font':>5} {'chars/line':>11} {'lines':>6} {'chars':>6} {'~คำ':>5}")
    print("-" * 96)

    for label, w, h in PHOTOS:
        pad = max(16, round(math.sqrt(w * h) * 0.065))
        # a caption band keeps 78% of the height for the photo, the rest is paper
        band = round(h * 0.20)
        fsize = max(18, round(min(w, h) * 0.030))
        f = ImageFont.truetype(str(FONT), fsize)

        text_w = (w + pad * 2) * 0.84          # 8% safe inset each side
        cpl = chars_per_line(SAMPLE, f, text_w)
        line_h = round(fsize * 1.45)
        lines = int((band - pad) // line_h)
        total = int(cpl * lines)
        print(
            f"{label:24} {w}x{h:<6} {pad:5} {band:5} {fsize:5} {cpl:11.0f} {lines:6} {total:6} {total / THAI_PER_WORD:5.0f}"
        )

    # ── sample render: a portrait photo with a 3-line blessing ───────────────
    photo = Image.new("RGB", (1440, 1920), (238, 231, 220))
    d = ImageDraw.Draw(photo)
    for i in range(0, 1440, 60):
        d.line([(i, 0), (i, 1920)], fill=(230, 220, 206), width=1)
    d.ellipse([360, 420, 1080, 1140], fill=(240, 205, 200))
    d.rectangle([0, 1500, 1440, 1920], fill=(210, 200, 180))

    w, h = photo.size
    pad = max(16, round(math.sqrt(w * h) * 0.065))
    band = round(h * 0.20)
    canvas = Image.new("RGB", (w + pad * 2, h + band + pad), (255, 255, 255))
    canvas.paste(photo, (pad, pad))

    cd = ImageDraw.Draw(canvas)
    fsize = max(18, round(min(w, h) * 0.030))
    fb = ImageFont.truetype(str(FONT_BOLD), round(fsize * 1.15))
    fr = ImageFont.truetype(str(FONT), round(fsize * 0.85))

    cx = canvas.width // 2
    y = h + pad + round(band * 0.18)
    for line in [
        "ขอให้ชีวิตคู่เต็มไปด้วยความรัก",
        "ความเข้าใจ และความสุขตลอดไป",
    ]:
        l, _, _, _ = MEAS.textbbox((0, 0), line, font=fb)
        cd.text((cx - (width(line, fb)) / 2 - l, y), line, font=fb, fill=(63, 82, 51))
        y += round(fsize * 1.55)

    sig = "จาก คุณแม่ & ครอบครัว"
    l, _, _, _ = MEAS.textbbox((0, 0), sig, font=fr)
    cd.text((cx - width(sig, fr) / 2 - l, y + round(fsize * 0.3)), sig, font=fr, fill=(107, 122, 94))

    cd.rectangle([pad // 2, pad // 2, canvas.width - pad // 2, canvas.height - pad // 2], outline=(192, 160, 98), width=3)

    OUT.mkdir(parents=True, exist_ok=True)
    p = OUT / "frame-caption-sample.png"
    canvas.save(p)
    print()
    print(f"sample -> {p}  ({canvas.width}x{canvas.height})")
    print("RESULT: measured from the real font file")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
