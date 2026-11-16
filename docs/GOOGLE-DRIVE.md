# สำรองภาพขึ้น Google Drive

Worker ดันรูป/คลิปทุกไฟล์ขึ้นโฟลเดอร์ Drive ของเจ้าภาพเอง **ทุก 15 นาที** โดยไม่ต้องมีเซิร์ฟเวอร์เพิ่ม
(ไม่ใช้ rclone, ไม่ใช้ Cloud Run — ใช้ Drive REST API ตรงจาก Worker)

## หลักการทำงาน

```
R2: m/<id>.jpg ──(ยังไม่มี marker)──> Worker ──resumable upload──> Drive/<โฟลเดอร์>
                                          └──> R2: synced/m/<id>.jpg  (marker 0 ไบต์)
```

- **ไม่มีฐานข้อมูล**: สถานะ "ซิงค์แล้ว" เก็บเป็น object ว่างใต้ `synced/` — รีดีพลอยไม่หาย
- **เขียน marker หลัง Drive ยืนยันสำเร็จเท่านั้น** → ถ้าพลาดกลางทาง รอบหน้าลองใหม่ (อย่างแย่สุดคืออัปซ้ำ ไม่มีทางหาย)
- **สตรีมไฟล์ ไม่โหลดเข้า memory** (resumable upload) — คลิป 80 MB ก็ผ่านได้ในหน่วยความจำ 128 MB
- cron รอบละ 25 ไฟล์ → 15,000 ไฟล์ใช้เวลาราว 7-8 วัน (ตั้ง `limit` สูงขึ้นได้ถ้าอยากเร็ว)

## สิ่งที่ต้องเตรียม (ทำครั้งเดียว ~15 นาที)

> ชื่อเมนูเปลี่ยนไปแล้วในปี 2026: หน้า OAuth ไม่ได้อยู่ที่ "APIs & Services → Credentials"
> แบบเดิมอีก แต่ย้ายไปอยู่ใต้ **Google Auth Platform** — ลิงก์ตรง:
> <https://console.developers.google.com/auth/clients>

### 1. สร้าง OAuth client (ได้ `GOOGLE_CLIENT_ID` + `GOOGLE_CLIENT_SECRET`)
1. เปิด <https://console.cloud.google.com/> → สร้างโปรเจกต์ใหม่ (หรือใช้ของเดิม)
2. เปิด **Google Drive API**: <https://console.cloud.google.com/apis/library/drive.googleapis.com> → **Enable**
3. ไปที่ **Google Auth Platform → Clients** → **CREATE CLIENT**
   - ถ้ายังไม่เคยตั้งค่า ระบบจะให้ "register your application" ก่อน (ตั้งชื่อแอป + อีเมลผู้ติดต่อ)
   - Application type = **Desktop app** (ไม่ต้องกรอก redirect URI — Google ให้ `http://localhost` มาให้)
4. กด **CREATE** แล้วคัดลอก **Client ID** และ **Client secret**
   > ⚠️ ตั้งแต่ มิ.ย. 2025 Google แสดง **client secret แค่ครั้งเดียวตอนสร้าง** — ถ้าปิดหน้าไปแล้ว
   > ต้องกด **Add Secret** เพื่อสร้างใหม่ (มีได้สูงสุด 2 อัน)

### 1.1 เลือกทาง: publish (ต้องมีโดเมน) หรืออยู่ Testing แต่เร่งความเร็ว

**สิ่งที่เอกสาร Google ระบุ (คัดตรงจาก "Manage OAuth App Branding")**

> **App Domain** — “These links are **required for all external production apps**.”

แปลว่าแอป External ที่จะขึ้น In production **ต้องมี** Home page + Privacy policy + Terms
โดยโฮสต์บน **โดเมนที่ยืนยันความเป็นเจ้าของแล้ว (Search Console)** และต้องลงทะเบียนใน Authorized domains
→ ถ้าเว้นว่าง ปุ่ม **Publish app** จะกดไม่ได้ (ข้อความ “complete your configuration on the Branding page”)

| ทาง | ต้องมีอะไร | ค่าใช้จ่าย | เวลาจบ archive |
|---|---|---|---|
| **A. อยู่ Testing + cron ทุกนาที** ⭐ | แค่เพิ่มตัวเองเป็น test user | **0 บาท** | **~18 ชั่วโมง** (25 ไฟล์/นาที) |
| B. Publish ด้วย `workers.dev` | ยืนยัน `xxx.workers.dev` ใน Search Console + ทำ 3 หน้าเว็บ | 0 บาท (แต่ยังไม่ยืนยันว่า Google รับ) | เท่าเดิม |
| C. Publish ด้วยโดเมนที่ซื้อเอง | ซื้อโดเมน + 3 หน้าเว็บ + DNS | ~350–450 บาท/ปี | เท่าเดิม |

**ทาง A ใช้ได้เพราะ**: token ที่ได้ตอน Testing อายุ **7 วัน** แต่ archive จบใน **< 1 วัน**
ถ้าตั้ง cron เป็นทุกนาที (25 ไฟล์ × 1,440 รอบ = 36,000 ไฟล์/วัน > 27,200)
ต้นทุนโควตา: 1,440 request/วัน = **1.4%** ของ 100k/วัน

```toml
# wrangler.toml — เปิดเฉพาะช่วงหลังงาน (แล้วเปลี่ยนกลับเป็น */15)
[triggers]
crons = ["* * * * *"]
```

**สิ่งที่ต้องแลก**: แขก/เจ้าภาพจะเห็นหน้าเตือน “unverified app” ตอนกด Allow (กด Continue ได้ปกติ)
และห้ามปล่อยให้เกิน 7 วันหลังกด Allow ครั้งแรก

### 2. ขอ `GOOGLE_REFRESH_TOKEN`
```bash
python scripts/google_auth.py
```
สคริปต์จะพิมพ์ลิงก์ → เปิดในเบราว์เซอร์ → กด Allow → เบราว์เซอร์จะเด้งไป `localhost:8765`
(หน้าอาจเปิดไม่ขึ้น ซึ่งไม่เป็นไร) → **คัดลอก URL เต็มจากช่อง address bar มาวางในสคริปต์**

### 3. สร้างโฟลเดอร์ปลายทางใน Drive (ได้ `DRIVE_FOLDER_ID`) — ต้องสร้าง "ด้วยแอป"

⚠️ scope `drive.file` ให้สิทธิ์เฉพาะไฟล์/โฟลเดอร์ที่ **แอปสร้างเอง** (หรือที่ผู้ใช้เปิดให้แอปผ่าน picker)
โฟลเดอร์ที่สร้างด้วยมือในเว็บ Drive จะมองไม่เห็นจากแอป → อัปโหลดจะได้ `404` แม้ folder id จะถูก

วิธีที่ปลอดภัย: ให้แอปสร้างโฟลเดอร์เอง (ครั้งเดียว)

```powershell
$env:GOOGLE_CLIENT_ID="..."
$env:GOOGLE_CLIENT_SECRET="..."
$env:GOOGLE_REFRESH_TOKEN="..."
python scripts/drive_make_folder.py --name "Wedding-22.11.26"
# PASS: สร้างโฟลเดอร์สำเร็จ
#   id   : 1AbC...
# ใส่ค่านี้ใน wrangler.toml:  DRIVE_FOLDER_ID = "1AbC..."
```

ทางเลือกถ้าอยากใช้โฟลเดอร์ที่มีอยู่แล้ว: เปิดโฟลเดอร์นั้นด้วย Google Picker จากแอปเดียวกัน
(ต้องมีหน้าเว็บ + API key) — ยุ่งกว่าการให้แอปสร้างเองมาก

### 4. ใส่ค่าให้ Worker
```bash
npx wrangler secret put GOOGLE_CLIENT_ID
npx wrangler secret put GOOGLE_CLIENT_SECRET
npx wrangler secret put GOOGLE_REFRESH_TOKEN
npx wrangler secret put SYNC_TOKEN          # รหัสสุ่มสำหรับเรียก /api/sync ด้วยมือ
```
แล้วแก้ `wrangler.toml`:
```toml
DRIVE_FOLDER_ID = "1AbC..."
```
`npx wrangler deploy`

### 5. ทดสอบและวัดความเร็ว
```bash
python scripts/drive_sync.py --base https://<host> --token <SYNC_TOKEN> --dry
python scripts/drive_sync.py --base https://<host> --token <SYNC_TOKEN> --limit 25 --max-batches 1
```
สคริปต์พิมพ์ `pushed / bytes / left / objต่อนาที / MBต่อนาที` — ตัวเลขนี้คือคำตอบจริงของ
"ผลักภาพเข้า Drive เร็วแค่ไหน" (ก่อนมี credential ตัวเลขฝั่ง Drive เป็น `UNVERIFIED`)

แล้วเปิด Drive ดูว่ามีไฟล์ขึ้น

## ข้อควรรู้

| เรื่อง | รายละเอียด |
|---|---|
| **refresh token อายุ 7 วัน** | เพราะ OAuth app อยู่ในสถานะ Testing → ต้อง authorize ใกล้วันงาน และถ้าเกิน 7 วันต้องทำข้อ 2 ใหม่ |
| โควตา Drive | 12,000 queries/นาที/ผู้ใช้ — ไม่ใช่ปัญหา |
| พื้นที่ | นับเข้า 5 TB ของเจ้าภาพ (ไฟล์ที่อัปคือไฟล์ย่อ ไม่ใช่ต้นฉบับจากมือถือ) |
| ลบไฟล์ | Worker ไม่ลบอะไรใน Drive — ถ้าอยากล้างให้ทำใน Drive เอง |
| หยุดชั่วคราว | เอา `DRIVE_FOLDER_ID` ออก (หรือเว้นว่าง) แล้ว deploy — cron จะเงียบ |

## ทดสอบโดยไม่ใช้บัญชีจริง

```bash
python scripts/mock_drive.py 8788          # mock Google
npx wrangler dev --port 8787 --local \
  --var SYNC_TOKEN:test-sync-token --var DRIVE_FOLDER_ID:mock-folder \
  --var GOOGLE_CLIENT_ID:mock --var GOOGLE_CLIENT_SECRET:mock \
  --var GOOGLE_REFRESH_TOKEN:mock --var GOOGLE_TOKEN_URL:http://127.0.0.1:8788/token \
  --var "GOOGLE_UPLOAD_URL:http://127.0.0.1:8788/upload/drive/v3/files?uploadType=resumable"
python scripts/sync_test.py                # 9 checks
```
