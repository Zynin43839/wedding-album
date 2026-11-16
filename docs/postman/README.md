# Postman — ชุดทดสอบ API

ไฟล์ในโฟลเดอร์นี้

| ไฟล์ | ใช้ทำอะไร |
|---|---|
| `wedding-album.postman_collection.json` | คำขอทั้งหมด 18 รายการ พร้อม assertion ในแท็บ Tests |
| `wedding-album.postman_environment.json` | ตัวแปร `baseUrl` / `eventCode` / `guestName` |

## วิธีใช้

1. เปิด Postman → **Import** → ลากทั้ง 2 ไฟล์เข้าไป
2. เลือก environment **Wedding Album — local**
3. แก้ `baseUrl` ให้เป็นที่อยู่จริง (เช่น `https://wedding-album.<subdomain>.workers.dev`)
4. รันตามลำดับโฟลเดอร์ 1 → 6 หรือกด **Run collection**

## ลำดับและสิ่งที่ตรวจ

| โฟลเดอร์ | ตรวจอะไร |
|---|---|
| 1 · Health | หน้าเว็บโหลดได้, CSS ถูก content-type, 404 ทำงาน |
| 2 · Config | `/api/config` คืนค่าครบ, ไม่ใส่รหัส = 403, ใส่รหัสผิด = 403 |
| 3 · Album | `/api/list` คืน `items[]`, ทุกฟิลด์ครบ, ไม่ใส่รหัส = 403 |
| 4 · Upload | อัปโหลดรูปจริง → ได้ `key`, รูปโผล่ในลิสต์, อัปโหลด thumb ได้ |
| 5 · Media | ดึงไฟล์ที่อัปโหลดคืนมาเทียบ (ไบต์ตรง, cache immutable), 404, กัน path traversal |
| 6 · Rejections | kind ผิด 400, id สั้น 400, content-type ผิด 415, GET 405 |

## ข้อควรรู้

- **คำขอ P20 และ P23 ต้องเลือกไฟล์เอง** (Body → binary → Select File) ใช้รูปจริง 1–3 MB จะตรงกับของจริงที่สุด
- ชุดนี้ **ไม่ทดสอบ 413 (ไฟล์ใหญ่เกิน)** เพราะ Postman ต้องส่งไฟล์จริงเกิน 12 MB — เคสนี้อยู่ใน `scripts/prod_test.py` (P29)
- ทุกครั้งที่รัน จะมีรูปทดสอบค้างใน R2 2 ไฟล์ (`{{uploadId}}.jpg` และ `-t.jpg`, ชื่อแขก `TEST-postman`) ลบใน R2 dashboard ทีหลัง หรือรันก่อนแจก QR
- `P21` ต้องรัน **หลัง** `P20` เพราะอ่าน `uploadId` จากตัวแปรที่ P20 เซ็ตไว้
- ถ้าตั้ง `PUBLIC_MEDIA_BASE` แล้ว รูปจะเสิร์ฟจาก CDN ไม่ผ่าน `/i/` — เอา `lastUrl` ไปยิงแทนเพื่อตรวจเส้นทางนั้น
