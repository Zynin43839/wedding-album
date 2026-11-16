"""What does 4 MB -> 1 MB actually cost in sharpness?

Builds a 4032x3024 (12 MP) reference that saves at ~4 MB, runs three compressions
and measures each against the reference:

  A. the app's rule        (2048 px long edge, JPEG q0.85)
  B. 1 MB target at 2048px (quality tuned until the file is ~1 MB)
  C. 1 MB target at full resolution (all the saved bytes go to resolution, not quality)

PSNR and a block SSIM are computed on the same canvas as the candidate, so the
number describes JPEG damage and not the resize itself.

Run: python scripts/quality_test.py
"""
from __future__ import annotations

import math
import pathlib

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

ROOT = pathlib.Path(__file__).resolve().parents[1]
OUT = ROOT / "docs" / "screenshots"
OUT.mkdir(parents=True, exist_ok=True)

W, H = 4032, 3024


def reference() -> Image.Image:
    """A camera-ish scene: sky gradient, foliage texture, hard edges, fine detail."""
    rng = np.random.default_rng(7)
    yy, xx = np.mgrid[0:H, 0:W]
    base = np.zeros((H, W, 3), dtype=np.float32)
    base[..., 0] = 150 + 70 * (1 - yy / H) + 25 * np.sin(xx / 220)
    base[..., 1] = 165 + 55 * (1 - yy / H) + 20 * np.sin(xx / 310)
    base[..., 2] = 175 + 45 * (1 - yy / H)
    # foliage: high-frequency detail where JPEG hurts most
    noise = rng.normal(0, 26, (H, W, 3))
    base += noise
    im = Image.fromarray(np.clip(base, 0, 255).astype(np.uint8))

    d = ImageDraw.Draw(im)
    for i in range(260):  # leaves / twigs
        x, y = int(rng.integers(0, W)), int(rng.integers(H // 3, H))
        r = int(rng.integers(20, 90))
        d.ellipse([x, y, x + r, y + int(r * 0.6)], fill=(
            int(rng.integers(30, 90)), int(rng.integers(90, 150)), int(rng.integers(30, 80))))
    for i in range(40):  # hard edges + text-like bars
        x, y = int(rng.integers(0, W - 300)), int(rng.integers(0, H - 60))
        d.rectangle([x, y, x + int(rng.integers(120, 300)), y + int(rng.integers(8, 40))], fill=(250, 248, 244))

    im = im.filter(ImageFilter.GaussianBlur(0.6))  # camera lenses are not pixel-sharp
    return im


def save_size(im: Image.Image, q: int) -> int:
    p = OUT / "_q_tmp.jpg"
    im.save(p, "JPEG", quality=q, subsampling=0, optimize=True)
    n = p.stat().st_size
    p.unlink(missing_ok=True)
    return n


def encode_to(im: Image.Image, target: int, qmin: int = 40, qmax: int = 96) -> tuple[bytes, int]:
    """Binary-search the quality that lands closest to `target` bytes."""
    from io import BytesIO

    lo, hi = qmin, qmax
    best = None
    while lo <= hi:
        mid = (lo + hi) // 2
        buf = BytesIO()
        im.save(buf, "JPEG", quality=mid, subsampling=0, optimize=True)
        data = buf.getvalue()
        if best is None or abs(len(data) - target) < abs(len(best[0]) - target):
            best = (data, mid)
        if len(data) < target:
            lo = mid + 1
        else:
            hi = mid - 1
    return best


def psnr(a: np.ndarray, b: np.ndarray) -> float:
    mse = float(np.mean((a.astype(np.float64) - b.astype(np.float64)) ** 2))
    if mse == 0:
        return 99.0
    return 10 * math.log10((255.0**2) / mse)


def ssim_blocks(a: np.ndarray, b: np.ndarray, block: int = 8) -> float:
    """Mean SSIM over non-overlapping blocks (no extra dependencies)."""
    a = a.astype(np.float64)
    b = b.astype(np.float64)
    h, w = a.shape[:2]
    scores = []
    c1, c2 = (0.01 * 255) ** 2, (0.03 * 255) ** 2
    for y in range(0, h - block + 1, block):
        for x in range(0, w - block + 1, block):
            pa = a[y:y + block, x:x + block]
            pb = b[y:y + block, x:x + block]
            ma, mb = pa.mean(), pb.mean()
            va, vb = pa.var(), pb.var()
            cov = ((pa - ma) * (pb - mb)).mean()
            s = ((2 * ma * mb + c1) * (2 * cov + c2)) / ((ma**2 + mb**2 + c1) * (va + vb + c2))
            scores.append(s)
    return float(np.mean(scores))


def main() -> int:
    from io import BytesIO

    ref = reference()

    # the "original" is a 12 MP photo saved at ~4 MB, i.e. what a phone hands us
    orig_bytes, orig_q = encode_to(ref, 4 * 1024 * 1024, qmin=60, qmax=98)
    orig_im = Image.open(BytesIO(orig_bytes)).convert("RGB")
    print(f"original  : {orig_im.width}x{orig_im.height}  {len(orig_bytes) / 1024 / 1024:.2f} MB (q{orig_q})")

    target = 1024 * 1024
    jobs = []

    # A — what the app does to a 3-5 MB photo
    a_im = orig_im.resize((2048, 1536), Image.LANCZOS)
    b = BytesIO()
    a_im.save(b, "JPEG", quality=85, subsampling=0, optimize=True)
    jobs.append(("A. แอปตอนนี้ (2048px q0.85)", a_im, b.getvalue()))

    # B — 1 MB at 2048 px
    b_im = orig_im.resize((2048, 1536), Image.LANCZOS)
    b_bytes, b_q = encode_to(b_im, target, qmin=60, qmax=96)
    jobs.append((f"B. 1 MB ที่ 2048px (q{b_q})", b_im, b_bytes))

    # C — 1 MB at full resolution (resolution kept, quality sacrificed)
    c_bytes, c_q = encode_to(orig_im, target, qmin=20, qmax=96)
    jobs.append((f"C. 1 MB ที่ 4032px (q{c_q})", orig_im, c_bytes))

    print()
    print(f"{'variant':34} {'size':>8} {'ratio':>7} {'PSNR dB':>8} {'SSIM':>6}")
    print("-" * 72)

    for label, im, data in jobs:
        dec = Image.open(BytesIO(data)).convert("RGB")
        ref_for = np.asarray(orig_im.resize(dec.size, Image.LANCZOS))
        cur = np.asarray(dec)
        p = psnr(ref_for, cur)
        s = ssim_blocks(ref_for, cur)
        print(f"{label:34} {len(data) / 1024:7.0f}KB {len(orig_bytes) / len(data):6.1f}x {p:8.2f} {s:6.3f}")

    # ── visual: the same *relative* detail from each variant ─────────────
    def crop_tile(img: Image.Image) -> Image.Image:
        w, h = img.size
        side = int(min(w, h) * 0.16)
        x, y = int(w * 0.30), int(h * 0.30)
        return img.crop((x, y, x + side, y + side)).resize((300, 300), Image.LANCZOS)

    tiles = [crop_tile(orig_im)]
    for _, _, data in jobs:
        tiles.append(crop_tile(Image.open(BytesIO(data)).convert("RGB")))

    sheet = Image.new("RGB", (len(tiles) * 310 + 10, 330), (255, 255, 255))
    for i, t in enumerate(tiles):
        sheet.paste(t, (10 + i * 310, 15))
    sheet = sheet.resize((sheet.width * 2, sheet.height * 2), Image.LANCZOS)
    p = OUT / "quality-compare.png"
    sheet.save(p)
    print()
    print(f"visual -> {p}  (ซ้าย = ต้นฉบับ 4 MB, ถัดมา = A, B, C)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
