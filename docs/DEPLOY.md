# ขึ้น Production บน Cloudflare (free tier)

ใช้เวลาประมาณ 20 นาที ค่าใช้จ่าย 0 บาท (ยกเว้นค่าโดเมนถ้าต้องการโดเมนสวย)

## 1. เตรียมบัญชี

```bash
npx wrangler login
```

ถ้ายังไม่มีบัญชี Cloudflare ให้สมัครก่อน (ฟรี ไม่ต้องผูกบัตร)

## 2. สร้าง bucket

```bash
npx wrangler r2 bucket create wedding-album-media
```

R2 ต้องเปิดใช้ใน dashboard ครั้งแรกก่อน (เมนู R2 → Enable) ระบบจะขอให้ยืนยันวิธีชำระเงิน
แต่จะไม่คิดเงินตราบใดที่ยังอยู่ในโควตาฟรี 10 GB

## 3. ตั้งค่า event

แก้ `wrangler.toml`

```toml
[vars]
EVENT_TITLE = "งานแต่งบ่าวสาว"
EVENT_DATE  = "2026-12-12"
EVENT_CODE  = "สุ่มรหัสอะไรก็ได้ 8-12 ตัว"
EXPIRES_AT  = "2026-12-19T23:59:59+07:00"   # 1 สัปดาห์หลังงาน
MAX_PHOTO_MB = "12"
MAX_VIDEO_MB = "80"
PUBLIC_MEDIA_BASE = "https://cdn.โดเมนของคุณ.com"
```

> `EVENT_CODE` ควรเป็นคำที่เดาไม่ได้ เพราะใครมีลิงก์ก็เห็นรูปทั้งหมด

## 4. ตั้ง custom domain ให้ R2 (สำคัญ)

ถ้าไม่ทำ รูปทุกใบจะวิ่งผ่าน Worker และนับเป็น request (ฟรี 100k/วัน)

1. เอาโดเมนเข้า Cloudflare (Nameserver ชี้มาที่ Cloudflare)
2. ไปที่ R2 → bucket `wedding-album-media` → Settings → **Public access** → Connect domain
3. ใส่ `cdn.โดเมนของคุณ.com` แล้วรอสถานะ Active
4. ตั้ง CORS policy ของ bucket เพื่อให้ดาวน์โหลด ZIP ข้ามโดเมนได้

```json
[
  {
    "AllowedOrigins": ["https://โดเมนหลักของคุณ.com"],
    "AllowedMethods": ["GET", "HEAD"],
    "AllowedHeaders": ["*"],
    "MaxAgeSeconds": 3600
  }
]
```

5. ใส่ `PUBLIC_MEDIA_BASE = "https://cdn.โดเมนของคุณ.com"` ใน `wrangler.toml`

## 5. Deploy

```bash
python scripts/prod_test.py --base http://127.0.0.1:8787 --skip-upload   # 1. ด่านในเครื่องก่อน
npx wrangler deploy                                                     # 2. ขึ้นจริง
python scripts/prod_test.py --base https://<host> --code <code>         # 3. ตรวจของจริง (31 เคส)
BASE_URL=https://<host> EVENT_CODE=<code> node scripts/ui_test.mjs      # 4. เบราว์เซอร์ end-to-end
```

จะได้ URL แบบ `https://wedding-album.<subdomain>.workers.dev`
ทดสอบก่อนว่าอัปโหลดได้ แล้วค่อยผูกโดเมนสวยภายหลัง (Workers → Settings → Domains & Routes)

รายการเคสทั้งหมดพร้อมผลที่ต้องได้อยู่ที่ [`TEST-CASES.md`](TEST-CASES.md) — ตัวอักษร `P01…P34`,
`U01…U14`, `M01…M10` ตรงกับที่สคริปต์พิมพ์ออกมา

หลังรันชุดที่มี upload จะมีรูปทดสอบค้างในอัลบั้ม (ชื่อแขก `TEST-prod` / `TEST-postman`)
ลบทิ้งใน R2 dashboard ก่อนแจก QR

## 5.1 ตรวจ API ด้วย Postman

```bash
# import 2 ไฟล์นี้ใน Postman
docs/postman/wedding-album.postman_collection.json
docs/postman/wedding-album.postman_environment.json
```

ตั้ง `baseUrl` เป็น host จริง แล้วกด Run collection — 18 คำขอ ไล่ตามลำดับ
Health → Config → Album → Upload → Media → Rejections (รายละเอียดใน `docs/postman/README.md`)

## 6. ตั้งลบรูปอัตโนมัติ (ไม่บังคับ)

`EXPIRES_AT` ทำให้หน้าเว็บปิด แต่ไฟล์ยังอยู่ใน bucket ถ้าต้องการลบจริงเพื่อคืนพื้นที่

R2 → bucket → Settings → **Object lifecycle rules** → Add rule

- Prefix: `m/`
- Delete objects after: 30 days (หรือ 7 วันตามที่ต้องการ)

> เก็บสำรองไว้ก่อนลบ: ดาวน์โหลด ZIP ทั้งอัลบั้มแล้วเก็บไว้ในเครื่องหรือ cloud อื่น

## 7. ก่อนวันงาน (เช็กลิสต์)

- [ ] เปิดลิงก์บนมือถือจริง 3 เครื่อง (iPhone / Android เก่า / Android ใหม่)
- [ ] เปิดลิงก์ **จากใน LINE** แล้วลองถ่ายและอัปโหลด
- [ ] ยิงอัปพร้อมกัน 10-20 เครื่อง เพื่อดูว่าเน็ตในสถานที่ไหว
- [ ] รัน `scripts/prod_test.py` กับ host จริง — ต้องได้ 31/31
- [ ] รัน `ui_test.mjs` กับ host จริง — ต้องได้ 14/14
- [ ] ลบรูปทดสอบ (`TEST-`) ออกจาก R2 ให้หมด
- [ ] พิมพ์ QR ใส่ป้ายโต๊ะ 2-3 จุด
- [ ] จดรหัส `EVENT_CODE` และลิงก์สำรองไว้ให้คนช่วยหน้างาน
- [ ] ทดสอบ ZIP ทั้งอัลบั้มหนึ่งครั้ง

## ค่าใช้จ่ายจริง

| รายการ | โควตาฟรี | ค่าใช้จ่ายเมื่อเกิน |
|---|---|---|
| Workers requests | 100,000/วัน | $5/เดือน (แผนเหมาจ่าย) |
| Workers CPU | 10 ms/request | ต้องอัปแผน |
| R2 storage | 10 GB | $0.015/GB/เดือน |
| R2 egress | ไม่จำกัด | ฟรี |
| R2 class A (เขียน) | 1 ล้าน/เดือน | $4.50/ล้าน |
| R2 class B (อ่าน) | 10 ล้าน/เดือน | $0.36/ล้าน |
| โดเมน | - | ประมาณ 400 บาท/ปี |

## ต่อยอดเป็นสินค้า

ระบบนี้ออกแบบมาเพื่อขายเป็นรายอีเวนต์อยู่แล้ว ถ้าจะทำเป็นบริการ

1. **หนึ่งอีเวนต์ต่อหนึ่ง deployment** — แยก Worker + bucket ต่อลูกค้า กันข้อมูลปนกัน
   ใช้ `wrangler.toml` คนละไฟล์ หรือ environment (`--env customer-name`)
2. **คิดเงินต่ออีเวนต์** ไม่ต้องมีระบบสมาชิก รับโอนแล้วตั้งค่าให้
3. **เก็บเงินก่อน แล้วค่อยลบข้อมูล** ตามที่ตกลง (เช่น 30 วันหลังงาน)
4. **เพิ่มหน้า admin** ถ้าต้องการลบรูปไม่เหมาะสม (ตอนนี้ใช้ Dashboard ของ R2 ลบได้)
5. **ภาษา** — ถ้าขายต่างประเทศ แยกข้อความใน `index.html` และ `app.js` เป็นไฟล์ locale

## แก้ปัญหาที่เจอบ่อย

| อาการ | สาเหตุ | ทางแก้ |
|---|---|---|
| กล้องไม่เปิด | เปิดผ่าน HTTP | ต้องเป็น HTTPS เท่านั้น |
| อัปโหลดไม่ขึ้นใน LINE | in-app browser บางรุ่นจำกัด file input | ให้กด "เปิดในเบราว์เซอร์" มุมขวาบน |
| 413 too_large | ไฟล์เกินเพดาน | เพิ่ม `MAX_VIDEO_MB` หรือให้แขกตัดวิดีโอสั้นลง |
| 403 bad_code | รหัสในลิงก์ไม่ตรง | ตรวจ `EVENT_CODE` กับลิงก์ที่แจก |
| รูปไม่ขึ้น แต่มีข้อมูล | ไม่ได้ตั้ง CORS ของ bucket | ตั้ง CORS ตามข้อ 4 |
| 410 | เลย `EXPIRES_AT` แล้ว | ต่ออายุหรือปล่อยให้ปิดตามกำหนด |
