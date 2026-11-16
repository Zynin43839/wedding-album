"""Generate the QR code and the printable table cards for the wedding album.

Outputs (all 300 dpi, ready to print):
  docs/qr/qr-stamp.png      90 x 110 mm   perforated stamp card
  docs/qr/qr-minimal.png    90 x  90 mm   hairline card
  docs/qr/qr-floral.png    100 x 130 mm   floral card (AI art from public/art)
  docs/qr/card-a5.png      148 x 210 mm   table card with 3 steps
  docs/qr/qr-code.svg                     bare vector code (no frame)
  docs/qr/preview-sheet.png               contact sheet of the four designs

Rules baked in here:
  * QR modules are near-black on pure white with a 4-module quiet zone (16:1), never
    the olive of the invitation card, so any phone camera can read them.
  * Every text run is shrunk until it fits its box (`fit_font`), so no line can overflow
    the card the way an unmeasured font size does.
  * Floral art is composited with multiply, so its white background disappears on blush
    and on cream instead of leaving a white rectangle.
  * Every PNG is decoded again with zxing-cpp; the run fails unless each reads back the
    exact album URL.

Run: python scripts/make_qr.py
"""
from __future__ import annotations

import os

import pathlib
import sys

import segno
import zxingcpp
from PIL import Image, ImageChops, ImageDraw, ImageFont

ROOT = pathlib.Path(__file__).resolve().parents[1]
OUT = ROOT / "docs" / "qr"
OUT.mkdir(parents=True, exist_ok=True)

# ── the link that goes on the card ───────────────────────────────────────────
BASE = "https://wedding-album.rj-wedding.workers.dev"
CODE = os.environ.get("EVENT_CODE", "demo-code")
URL = f"{BASE}/?e={CODE}"
SHORT = BASE.replace("https://", "")

# ── palette, sampled from the invitation card (see docs/DESIGN.md) ───────────
PAPER = (251, 248, 243)
WHITE = (255, 255, 255)
INK = (63, 82, 51)
GREEN = (99, 127, 79)
BLUSH = (239, 199, 200)
BLUSH_DEEP = (230, 172, 170)
CORAL = (212, 104, 94)
GOLD = (192, 160, 98)
RULE = (232, 222, 209)
SOFT = (107, 122, 94)
CODE_INK = "#1e221c"

NAMES = "รุจิรดา & เจนจบทธิ์"
EYEBROW = "THE WEDDING COLLECTION"
DATE = "22.11.26"
DATE_LONG = "วันอาทิตย์ที่ 22 พฤศจิกายน พ.ศ. 2569"
LINE1 = "สแกน QR แล้วถ่ายรูปได้เลย"
LINE2 = "รูปของคุณจะขึ้นอัลบั้มให้ทุกคนในงานเห็น"

DPI = 300
MEASURE = ImageDraw.Draw(Image.new("RGB", (8, 8)))


def mm(v: float) -> int:
    return round(v * DPI / 25.4)


FONTS = pathlib.Path("C:/Windows/Fonts")
FONT_CANDIDATES = {
    "thai_bold": ["LeelaUIb.ttf", "tahomabd.ttf", "arialbd.ttf"],
    "thai": ["leelawui.ttf", "tahoma.ttf", "arial.ttf"],
    "latin": ["georgia.ttf", "times.ttf", "arial.ttf"],
    "mono": ["consola.ttf", "cour.ttf", "arial.ttf"],
}


def font(kind: str, size_px: int) -> ImageFont.FreeTypeFont:
    for name in FONT_CANDIDATES[kind]:
        p = FONTS / name
        if p.exists():
            return ImageFont.truetype(str(p), size_px)
    return ImageFont.load_default(size_px)


def width_of(text: str, f) -> float:
    l, _, r, _ = MEASURE.textbbox((0, 0), text, font=f)
    return r - l


def fit_font(kind: str, text: str, max_w: int, start_mm: float, min_mm: float = 1.8):
    """Largest size of `kind` at which `text` fits inside `max_w` pixels."""
    size = start_mm
    while size > min_mm:
        f = font(kind, mm(size))
        if width_of(text, f) <= max_w:
            return f
        size -= 0.15
    return font(kind, mm(min_mm))


def center(d: ImageDraw.ImageDraw, cx: float, y: float, text: str, f, fill) -> None:
    l, _, _, _ = MEASURE.textbbox((0, 0), text, font=f)
    d.text((cx - width_of(text, f) / 2 - l, y), text, font=f, fill=fill)


def qr_image(box: int) -> Image.Image:
    """High-correction QR, 4-module quiet zone, near-black on pure white."""
    qr = segno.make(URL, error="h")
    tmp = OUT / "_qr_raw.png"
    qr.save(tmp, scale=8, border=4, dark=CODE_INK, light="#ffffff")
    im = Image.open(tmp).convert("RGB")
    tmp.unlink(missing_ok=True)
    return im.resize((box, box), Image.NEAREST)


def art(name: str, width_mm: float) -> Image.Image:
    im = Image.open(ROOT / "public" / "art" / name).convert("RGB")
    w = mm(width_mm)
    return im.resize((w, max(1, round(im.height * w / im.width))), Image.LANCZOS)


def paste_multiply(base: Image.Image, img: Image.Image, xy) -> None:
    """Drop white-background line art onto paper or blush without a white box."""
    x, y = max(0, int(xy[0])), max(0, int(xy[1]))
    x2, y2 = min(base.width, x + img.width), min(base.height, y + img.height)
    if x2 <= x or y2 <= y:
        return
    crop = img.crop((0, 0, x2 - x, y2 - y))
    region = ImageChops.multiply(base.crop((x, y, x2, y2)), crop)
    base.paste(region, (x, y))


def perforate(canvas: Image.Image, box, step: int, radius: int) -> None:
    d = ImageDraw.Draw(canvas)
    x0, y0, x1, y1 = box
    for x in range(x0 + step // 2, x1, step):
        for y in (y0, y1):
            d.ellipse((x - radius, y - radius, x + radius, y + radius), fill=PAPER)
    for y in range(y0 + step // 2, y1, step):
        for x in (x0, x1):
            d.ellipse((x - radius, y - radius, x + radius, y + radius), fill=PAPER)


# ── 1. stamp card 90 x 110 mm ────────────────────────────────────────────────
def design_stamp() -> Image.Image:
    w, h = mm(90), mm(110)
    im = Image.new("RGB", (w, h), PAPER)
    box = (mm(6), mm(6), w - mm(6), h - mm(6))
    ImageDraw.Draw(im).rectangle(box, fill=WHITE)
    perforate(im, box, step=mm(4), radius=mm(1.4))

    d = ImageDraw.Draw(im)
    inner = (box[0] + mm(4), box[1] + mm(4), box[2] - mm(4), box[3] - mm(4))
    d.rectangle(inner, outline=BLUSH_DEEP, width=2)
    cx = w / 2
    inner_w = inner[2] - inner[0] - mm(4)
    qx = int(cx - mm(26.5))

    y = mm(10.5)
    center(d, cx, y, EYEBROW, fit_font("mono", EYEBROW, inner_w, 3.0), GREEN)
    center(d, cx, mm(15.5), NAMES, fit_font("thai_bold", NAMES, inner_w, 6.2), INK)
    center(d, cx, mm(24.0), DATE, fit_font("mono", DATE, inner_w, 3.4), CORAL)

    im.paste(qr_image(mm(53)), (qx, mm(30.5)))

    d = ImageDraw.Draw(im)
    center(d, cx, mm(86.5), LINE1, fit_font("thai", LINE1, inner_w, 3.4), INK)
    center(d, cx, mm(92.5), LINE2, fit_font("thai", LINE2, inner_w, 2.8), SOFT)
    return im


# ── 2. minimal card 90 x 90 mm ───────────────────────────────────────────────
def design_minimal() -> Image.Image:
    w, h = mm(90), mm(90)
    im = Image.new("RGB", (w, h), WHITE)
    d = ImageDraw.Draw(im)
    pad = mm(7)
    d.rectangle((pad, pad, w - pad, h - pad), outline=RULE, width=2)

    cx = w / 2
    inner_w = w - 2 * pad - mm(10)
    center(d, cx, mm(12), EYEBROW, fit_font("mono", EYEBROW, inner_w, 2.9), GREEN)
    center(d, cx, mm(17.5), NAMES, fit_font("thai_bold", NAMES, inner_w, 5.4), INK)

    im.paste(qr_image(mm(42)), (int(cx - mm(21)), mm(25)))

    d = ImageDraw.Draw(im)
    center(d, cx, mm(70), LINE1, fit_font("thai", LINE1, inner_w, 3.2), INK)

    f_date = fit_font("mono", DATE, inner_w, 2.9)
    dw = width_of(DATE, f_date)
    y = mm(76.5)
    d.line((cx - dw / 2 - mm(7), y + mm(1.6), cx - dw / 2 - mm(2), y + mm(1.6)), fill=GOLD, width=2)
    d.line((cx + dw / 2 + mm(2), y + mm(1.6), cx + dw / 2 + mm(7), y + mm(1.6)), fill=GOLD, width=2)
    center(d, cx, y, DATE, f_date, CORAL)
    return im


# ── 3. floral card 100 x 130 mm ──────────────────────────────────────────────
def design_floral() -> Image.Image:
    w, h = mm(100), mm(130)
    im = Image.new("RGB", (w, h), WHITE)

    sprig = art("sprig.webp", 27)
    paste_multiply(im, sprig, (mm(1), -mm(1)))
    paste_multiply(im, sprig.transpose(Image.FLIP_LEFT_RIGHT), (w - sprig.width - mm(1), -mm(1)))

    divider = art("divider.webp", 50)
    paste_multiply(im, divider, (w / 2 - divider.width / 2, mm(32)))

    d = ImageDraw.Draw(im)
    cx = w / 2
    inner_w = w - mm(16)
    center(d, cx, mm(11), EYEBROW, fit_font("mono", EYEBROW, inner_w, 3.0), GREEN)
    center(d, cx, mm(17.5), NAMES, fit_font("thai_bold", NAMES, inner_w, 6.6), INK)
    center(d, cx, mm(27.5), DATE, fit_font("mono", DATE, inner_w, 3.2), CORAL)

    im.paste(qr_image(mm(50)), (int(cx - mm(25)), mm(41)))

    d = ImageDraw.Draw(im)
    center(d, cx, mm(96), LINE1, fit_font("thai", LINE1, inner_w, 3.6), INK)
    center(d, cx, mm(102.5), LINE2, fit_font("thai", LINE2, inner_w, 3.0), SOFT)
    center(d, cx, mm(118), SHORT, fit_font("mono", SHORT, inner_w, 2.4), (150, 140, 125))
    return im


# ── 4. A5 table card 148 x 210 mm ────────────────────────────────────────────
def design_a5() -> Image.Image:
    w, h = mm(148), mm(210)
    im = Image.new("RGB", (w, h), PAPER)

    band_h = mm(62)
    band = Image.new("RGB", (w, band_h), BLUSH)

    sprig = art("sprig.webp", 26)
    paste_multiply(band, sprig, (mm(3), -mm(3)))
    paste_multiply(band, sprig.transpose(Image.FLIP_LEFT_RIGHT), (w - sprig.width - mm(3), -mm(3)))

    divider = art("divider.webp", 58)
    paste_multiply(band, divider, (w / 2 - divider.width / 2, band_h - divider.height - mm(3)))
    im.paste(band, (0, 0))

    d = ImageDraw.Draw(im)
    cx = w / 2
    inner_w = w - mm(24)
    center(d, cx, mm(12), EYEBROW, fit_font("mono", EYEBROW, inner_w, 3.4), INK)
    center(d, cx, mm(19), NAMES, fit_font("thai_bold", NAMES, inner_w, 8.4), INK)
    center(d, cx, mm(37), DATE_LONG, fit_font("thai", DATE_LONG, inner_w, 4.2), CORAL)

    center(d, cx, mm(72), LINE1, fit_font("thai_bold", LINE1, inner_w, 5.6), INK)
    center(d, cx, mm(81), LINE2, fit_font("thai", LINE2, inner_w, 4.0), SOFT)

    qr_box = mm(56)
    qx, qy = int(cx - qr_box / 2), mm(92)
    pad = mm(4)
    d.rectangle((qx - pad, qy - pad, qx + qr_box + pad, qy + qr_box + pad), fill=WHITE)
    im.paste(qr_image(qr_box), (qx, qy))

    d = ImageDraw.Draw(im)
    steps = [
        ("1", "สแกน QR ด้วยกล้องมือถือ"),
        ("2", "กด “ถ่ายรูป” แล้วถ่ายได้เลย"),
        ("3", "ตรวจรูป กด “อัปโหลด”"),
    ]
    f_num = font("mono", mm(3.8))
    f_step = fit_font("thai", steps[1][1], w - mm(70), 4.2)
    y = mm(160)
    left = mm(22)
    for n, text in steps:
        d.ellipse((left, y - mm(0.8), left + mm(7.4), y + mm(6.6)), outline=GOLD, width=2)
        center(d, left + mm(3.7), y + mm(0.2), n, f_num, GOLD)
        d.text((left + mm(12), y + mm(0.6)), text, font=f_step, fill=INK)
        y += mm(11)

    center(d, cx, mm(192), "ไม่ต้องติดตั้งแอป · ไม่ต้องสมัครสมาชิก",
           fit_font("thai", "ไม่ต้องติดตั้งแอป · ไม่ต้องสมัครสมาชิก", inner_w, 3.6), SOFT)
    center(d, cx, mm(199), SHORT, fit_font("mono", SHORT, inner_w, 2.8), (150, 140, 125))
    return im


# ── verification ─────────────────────────────────────────────────────────────
def verify(path: pathlib.Path) -> str:
    im = Image.open(path).convert("RGB")
    results = zxingcpp.read_barcodes(im)
    if not results:
        raise SystemExit(f"FAIL: no QR found in {path.name}")
    got = results[0].text
    if got != URL:
        raise SystemExit(f"FAIL: {path.name} decodes to {got!r}, expected {URL!r}")
    return got


def main() -> int:
    jobs = [
        ("qr-stamp.png", design_stamp),
        ("qr-minimal.png", design_minimal),
        ("qr-floral.png", design_floral),
        ("card-a5.png", design_a5),
    ]

    print(f"url : {URL}")
    print(f"dpi : {DPI}")
    print("-" * 76)

    made = []
    for name, fn in jobs:
        im = fn()
        path = OUT / name
        im.save(path, dpi=(DPI, DPI))
        verify(path)
        print(f"{name:16} {im.width:>5}x{im.height:<5}px {im.width / DPI * 25.4:5.0f}x{im.height / DPI * 25.4:<4.0f}mm "
              f"{path.stat().st_size / 1024:7.1f} KB  QR decodes OK")
        made.append((name, im))

    segno.make(URL, error="h").save(
        OUT / "qr-code.svg", scale=10, border=4, dark=CODE_INK, light="#ffffff"
    )
    print(f"{'qr-code.svg':16} vector (no frame)")

    thumb_w = 520
    thumbs = []
    for name, im in made:
        t = im.copy()
        t.thumbnail((thumb_w, thumb_w), Image.LANCZOS)
        thumbs.append(t)
    cell_w = thumb_w + 40
    cell_h = max(t.height for t in thumbs) + 40
    sheet = Image.new("RGB", (2 * cell_w, 2 * cell_h), (250, 250, 250))
    for i, t in enumerate(thumbs):
        cx = (i % 2) * cell_w + (cell_w - t.width) // 2
        cy = (i // 2) * cell_h + (cell_h - t.height) // 2
        sheet.paste(t, (cx, cy))
    sheet.save(OUT / "preview-sheet.png")

    print("-" * 76)
    print(f"preview : {OUT / 'preview-sheet.png'}")
    print(f"RESULT: PASS — {len(made)} designs, every QR decodes to the album URL")
    return 0


if __name__ == "__main__":
    sys.exit(main())
