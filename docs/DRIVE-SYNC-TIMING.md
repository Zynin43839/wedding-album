# ผลักภาพเข้า Google Drive ใช้เวลากี่วัน — ตัวเลขที่วัดได้

อัปเดต 2026-11-16 · ทุกตัวเลขในไฟล์นี้มาจากการยิงจริงกับ production
(ไม่ได้มาจากการอ่านเอกสาร) เว้นแต่จะระบุว่า `UNVERIFIED`

## 1. เพดานที่วัดได้ (ตัวกำหนดความเร็วทั้งหมด)

| เพดาน | ค่าที่วัดได้ | วิธีวัด |
|---|---|---|
| **fetch subrequest ต่อ invocation** | **50** | `GET /api/limits?mode=fetch&n=40/60/120` → 40 ผ่าน, 50 ผ่าน, ครั้งที่ 51 ตอบ `Too many subrequests by single Worker invocation` |
| **R2/API request ต่อ invocation** | **999** | `GET /api/limits?n=600/1200` → 600 ผ่าน, 999 ผ่าน, ครั้งที่ 1000 ตอบ `Too many API requests by single Worker invocation` |
| R2 ทีละคำขอ (sequential) | **93–98 ms** | 600 คำขอ = 56.1 s · 999 คำขอ = 98.3 s |

> ตัวเลข 50 ตัวนี้คือเหตุผลที่ค่าเริ่มต้นของ sync คือ **25 ไฟล์ต่อรอบ** (2 fetch ต่อไฟล์)

## 2. ต้นทุนต่อไฟล์ (จากโค้ด + ค่าที่วัด)

| ขั้น | ชนิด | เวลา/จำนวน |
|---|---|---|
| `BUCKET.get(key)` | R2 API | ~98 ms, 1 request |
| Drive resumable start | fetch | ~200–400 ms, 1 subrequest (`UNVERIFIED` — ยังไม่มี credential) |
| Drive PUT (body) | fetch | ∝ ขนาดไฟล์, 1 subrequest (`UNVERIFIED`) |
| `BUCKET.put('synced/…')` | R2 API | ~98 ms, 1 request |

รวม ≈ **0.5–0.8 วินาที/ไฟล์** → 25 ไฟล์/รอบ ≈ 15–20 วินาที (cron ทุก 15 นาที ไม่ทับซ้อน)

## 3. ไทม์ไลน์ (27,200 objects = 13,000 รูป + 13,000 thumb + 600 คลิป + 600 poster)

**วัดจริง 2026-11-16 กับ Google Drive ของเจ้าภาพ** (`scripts/drive_sync.py`, limit 25):

| การทดสอบ | ผล |
|---|---|
| **5.1 GB / 600 ไฟล์ × 8.5 MB** (โฟลเดอร์ทดสอบ) | ผลัก **507 objects / 4,309.5 MB ใน 14.8 นาที** = **34.3 obj/min · 291.6 MB/min** |
| รอบที่ไม่มี throttle | 62–72 obj/min (0.85–0.95 วินาที/ไฟล์) |
| รอบที่ถูก throttle | 9.8–27 obj/min (ช้าลง 3–7 เท่า) |
| ไฟล์ล้ม | **22 จาก ~529 ครั้ง (4.2%)** — ลองใหม่แล้วผ่าน เพราะ marker เขียนหลังสำเร็จ |
| อัปโหลด 5.1 GB จากเครื่องนี้ | 1.7–2.8 MB/s (แปรตามเน็ต) รวม ~40 นาที |
| ต่อไฟล์ (ไม่มี throttle) | **~0.9 วินาที** (จาก 3.36 วินาทีก่อนทำ concurrency) |

**ข้อสรุปสำคัญ: concurrency 4 ทำให้ Google throttle เป็นช่วง ๆ** — ค่าเฉลี่ยจึงตกจาก 63 เหลือ 34 obj/min
และมีไฟล์ล้ม ~4% (ลองใหม่ผ่าน) ตัวเลขที่ควรใช้วางแผนคือ **34 obj/min**

| ภาระจริง | objects | เวลาที่ 34 obj/min |
|---|---|---|
| งานนี้ (13,000 รูป + 13,000 thumb + 600 คลิป + 600 poster) | 27,200 | **~13.3 ชั่วโมง** |
| ถ้าไม่มี throttle (63 obj/min) | 27,200 | ~7.2 ชั่วโมง |

| วิธี | ไฟล์/รอบ | รอบ | ไฟล์/วัน | เวลาจบ 27,200 |
|---|---|---|---|---|
| cron `*/15` (ค่าเดิม) | 25 | 96 | 2,400 | ~11.3 วัน |
| **cron `*/1` + limit 25** ⭐ | 25 | 1,440 | 36,000 | **~13–18 ชั่วโมง** |
| รัน `drive_sync.py` ต่อเนื่อง | 25 | — | — | **~13.3 ชม.** |

## 3.1 ทางเลือกที่วัดแล้วและสิ่งที่เลือก (2026-11-16)

| ทาง | ผลที่วัดได้ | คำตัดสิน |
|---|---|---|
| **เก็บเฉพาะต้นฉบับ** (ข้าม `-t` thumb และ `-p` poster) | object 27,200 → **13,600** (ครึ่งเดียว) เวลาก็ครึ่งเดียว | ✅ **เลือก** (ยืนยันแล้ว: อัปรูป+thumb = นับ 1) |
| concurrency 4 | 0.9 วิ/ไฟล์ตอนลื่น · 34 obj/min เฉลี่ยตอนถูก throttle | ✅ **เลือก** (มี requeue รองรับ) |
| **รอให้ครบ N แล้วค่อยผลัก (threshold)** | เวลาต่อไฟล์เท่าเดิม (3.36 วิ ไม่ว่า 1 หรือ 25 ไฟล์) → ได้แค่ "ช้าลง" และไฟล์ท้ายงานอาจค้างไม่ถูกผลัก | ❌ **ไม่เลือก** (`SYNC_MIN_BATCH=1`) |
| multipart upload (1 fetch/ไฟล์) | ยังไม่วัด · จะเพิ่มเพดาน 25 → 50 ไฟล์/รอบ | ⏸ เก็บไว้ทำถ้ายังไม่ทัน (80 MB clip กินแรม) |
| cron `*/1` หลังงาน | 25 ไฟล์/นาที = 36,000/วัน | ✅ ใช้ช่วงเก็บงาน |

**สรุปเวลาที่แนะนำ**: 13,600 ต้นฉบับ ÷ 34 obj/min = **~6.7 ชั่วโมง** (หรือ ~3.4 ชม. ถ้าไม่ถูก throttle)

## 4. กับดักที่สำคัญกว่าเรื่องความเร็ว ⚠️
**Refresh token ของ Google หมดอายุใน 7 วัน** ถ้า OAuth app ยังอยู่ในสถานะ *Testing*
(ยืนยันจากเอกสาร Google: “Authorizations by a test user will expire seven days from the time of consent…
that token will also expire”)

| ทาง | ผล | ค่าใช้จ่าย |
|---|---|---|
| **A. อยู่ Testing + cron ทุกนาที** | 27,200 ไฟล์ ÷ 25 ไฟล์/นาที = 1,088 นาที ≈ **18 ชั่วโมง** < 7 วัน → จบก่อน token ตาย | **0 บาท** |
| B. Publish เป็น In production | token อยู่ยาว แต่แอป External ต้องมี Home page + Privacy + Terms บนโดเมนที่ยืนยันแล้ว (เอกสาร: “required for all external production apps”) | ต้องมีโดเมน |

> ข้อค้นพบ 2026-11-16: ปุ่ม Publish กดไม่ได้ถ้าไม่มีลิงก์เหล่านั้น — ไม่ใช่แค่ “แนะนำให้ใส่”
> และการยืนยันโดเมน `*.workers.dev` ใน Search Console ยังไม่ทดสอบว่า Google Cloud จะรับเป็น
> Authorized domain หรือไม่

**สรุปที่แนะนำ**: ทาง A — เพิ่มตัวเองเป็น test user, ตั้ง cron `* * * * *` หลังงาน, วัดผลจริง
แล้วเปลี่ยนกลับเป็น `*/15` เมื่อ sync เสร็จ (ต้นทุนโควตา 1,440 request/วัน = 1.4%)

## 5. สิ่งที่ยังวัดไม่ได้ (ต้องมี credential)

| ข้อ | สถานะ | ปิดด้วย |
|---|---|---|
| เวลาต่อไฟล์ฝั่ง Drive | ✅ **วัดแล้ว 3.26 วินาที/ไฟล์** | `drive_sync.py --max-batches 1` |
| throughput จริงของ Cloudflare → Google | ✅ **2.50 MB/นาที** | batch แรก 1.63 MB / 39.1 s |
| Drive quota/ข้อจำกัดต่อผู้ใช้ | ไม่ชน (18 files/min) | — |
| พฤติกรรมเมื่อ token หมดอายุ | ยัง `UNVERIFIED` | รอวันที่ 8 หรือเพิกถอนสิทธิ์เองแล้วเรียก `?diag=1` |

## 6. วิธีวัดจริงเมื่อมี credential

```powershell
# 1) ดูว่ามีอะไรค้าง
python scripts/drive_sync.py --base https://wedding-album.rj-wedding.workers.dev --token <SYNC_TOKEN> --dry

# 2) ผลักจริง 1 รอบ 25 ไฟล์ แล้วอ่านความเร็ว
python scripts/drive_sync.py --base https://wedding-album.rj-wedding.workers.dev --token <SYNC_TOKEN> --limit 25 --max-batches 1

# 3) ผลักจนหมด (พิมพ์ obj/min, MB/min, ETA ทุก batch)
python scripts/drive_sync.py --base https://wedding-album.rj-wedding.workers.dev --token <SYNC_TOKEN> --limit 25
```

สคริปต์ยิง HTTP 1 ครั้งต่อ batch (ไม่ใช่ 1 process ต่อไฟล์) — ตรงตาม Bulk Operation Law

## 7. สถาปัตยกรรม sync ที่มีอยู่ (เพื่อความเข้าใจ)

```
cron ทุก 15 นาที
  └─ scanPending(): list 'synced/' ทั้งหมด (1 request / 1,000 marker)
       + list 'm/' ทีละ 180 object จนได้ candidate ครบ limit×4
  └─ ต่อไฟล์: BUCKET.get → Drive resumable start → Drive PUT → BUCKET.put('synced/<key>')
  └─ marker = ไฟล์เปล่า 0 byte ที่เก็บ driveId ไว้ (ไม่ต้องมีฐานข้อมูล)
```

ต้นทุนการสแกน marker โตตามจำนวนไฟล์: ที่ 27,200 ไฟล์ = 28 request/รอบ (ยังต่ำกว่า 999 มาก)
ถ้าอนาคตจะเก็บหลายแสนไฟล์ ต้องเปลี่ยนไปใช้ manifest เดียว
