# Floral art — prompts and provenance

ภาพตกแต่งทั้งชุดสร้างด้วย **Gemini (Google AI Pro ของเจ้าภาพ)** ไม่ได้ตัดจากการ์ดเชิญ
และไม่ได้ใช้ stock ที่มีลิขสิทธิ์

## Palette ที่ใช้สั่ง

| Token | Hex |
|---|---|
| paper | `#FFFFFF` |
| blush-hi | `#EFC7C8` |
| blush-mid | `#E6ACAA` |
| coral | `#D4685E` |
| olive | `#637F4F` |
| olive-deep | `#3F5233` |
| gold | `#C0A062` |

---

## 1. sprig — `docs/art/source/sprig.jpg`

```
Flat botanical illustration on a pure white background.
One gently curved stem rising from the bottom-left toward the upper-right.
Along the stem: five simple pointed leaves and one open rose near the top.
Rose petals are #EFC7C8 with #E6ACAA shading in the folds and a small #D4685E dot at the centre.
Leaves are #637F4F with a thin #3F5233 edge and a single centre vein.
Soft translucent watercolour texture inside the leaves and petals with slightly darker edges.
The stem with leaves and rose occupies only the left third of the frame; the remaining
two thirds are empty #FFFFFF. All four edges of the image are pure #FFFFFF.
Portrait 2:3. No text, no letters, no watermark, no frame, no shadow.
```

## 2. divider — `docs/art/source/divider.jpg`

```
A perfectly symmetrical horizontal botanical ornament, centered, mirror-imaged left to right.
EXACTLY: one five-petal flower in the exact centre (bloom 24mm, petals #EFC7C8 with #E6ACAA
shadow, centre dot #D4685E); on each side a pair of olive leaves (#637F4F fill, #3F5233
outline); the leaves are joined to the centre flower by a single #C0A062 hairline stem.
The ornament spans only the middle 60% of the canvas width, the outer 20% each side is white.
Ultra-wide 6:1 banner, everything fades to pure #FFFFFF, 25% white margin above and below.
No text, no letters, no watermark, no frame, no shadow.
```

## 3. bouquet — `docs/art/source/bouquet.webp`

```
A small compact round bouquet seen flat from directly above, centered, no vase, no ribbon.
EXACTLY: three dusty-rose roses (#EFC7C8 petals, #E6ACAA fold shadows, #D4685E centres),
four eucalyptus-style rounded leaves and three olive leaves (#637F4F fill, #3F5233 outline),
and two tiny #C0A062 gold sprigs. The bouquet forms a rough circle about 55% of the canvas
width; the surrounding 45% is empty white.
Square 1:1. No text, no letters, no watermark, no frame, no shadow.
```

## 4. wash — `docs/art/source/wash.webp`

```
An abstract, very soft watercolour field on white.
Only about 10% tint: #EFC7C8 and #E6ACAA, with a few barely visible touches of #D4685E.
The tint gathers toward the four corners and fades out completely toward the centre,
which stays almost pure #FFFFFF. No outlines, no defined shapes, no visible texture,
no paper grain. All four edges are pure #FFFFFF.
Square 1:1. No text, no letters, no watermark.
```

---

## 5. wreath — **ไม่ใช้ AI**
วาดด้วย SVG ใน `public/app.js` (`ICON.wreath`): ใบไม้ 10 ใบ (30° ไม่ใช่ — 36°) + จุดทอง 10 จุด
ที่ 62px ใบไม้ต้องหนาพอ (stroke 2.8) ไม่งั้นจะกลายเป็นวงจุด

**เหตุผลที่ไม่ใช้ AI**: วงกลมสมมาตรเป็นจุดอ่อนที่สุดของ diffusion model — ได้วงเบี้ยวทุกครั้ง

---

## การประมวลผล

```bash
python scripts/optimize_art.py
```

- ตัดขอบขาวอัตโนมัติ (threshold 6, pad 3%) ยกเว้น wash
- ย่อตามกล่องที่กำหนด (564×840 / 760×142 / 460×460 / 900×900)
- แปลงเป็น WebP q84–90
- เก็บต้นฉบับไว้ใน `docs/art/source/`

ผลลัพธ์รวม ~56 KB

---

## 6. logo — ดอกไม้ที่เจ้าภาพส่งมา (ตัดพื้นหลังแล้ว)

| เรื่อง | รายละเอียด |
|---|---|
| ต้นฉบับ | `docs/art/source/logo-bouquet.webp` (1024x1024, พื้นหลังขาว) |
| ที่มา | เจ้าภาพส่งไฟล์เอง — **ไม่ได้ตัดจากการ์ดเชิญ** |
| วิธีตัดพื้นหลัง | flood fill จากขอบทั้งสี่ + ลบพิกเซลขาวล้วนที่เหลือ (ช่องว่างระหว่างใบ) แล้ว soften ขอบ 1px กันขอบขาว |
| ผลลัพธ์ | `public/art/logo.webp` 512px โปร่งใส · `logo-192.png` (favicon/apple-touch) · `logo-512.png` · `logo-32.png` |
| ใช้ที่ไหน | favicon, apple-touch-icon, ตรากลาง cover, empty state |
| รันซ้ำ | `python scripts/make_logo.py` |
