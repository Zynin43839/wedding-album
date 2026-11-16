# Stability probes — findings and the code they point at

รันด้วย `scripts/stability_test.py` ยิงเข้า production จริง (`wedding-album.rj-wedding.workers.dev`)
ทุกเคสจงใจยิง "ขอบ" ที่ชุดทดสอบปกติไม่แตะ — ผลคือ **3 บั๊กจริง + 2 จุดควรแก้ + 1 บั๊กฝั่ง client**

```bash
python scripts/stability_test.py --base https://wedding-album.rj-wedding.workers.dev
```

| # | เคส | ผล | สรุป |
|---|---|---|---|
| S01 | HEAD บนสื่อ | PASS (200) | ใช้ได้ (แต่ไม่ส่ง `content-length`) |
| S02 | Range request | **BUG** | ตอบ 200 แทน 206 — ไม่มี `Accept-Ranges` |
| S03 | อัป id เดิมซ้ำ | PASS | 200/200 และเหลือ 1 รายการ |
| S04 | thumb มาก่อน main | PASS | ซ่อนไว้จนกว่า main จะมา |
| S05 | อัปไฟล์ 0 ไบต์ | PASS | 411 (ปฏิเสธถูกต้อง) |
| S06 | cursor เพี้ยน | **BUG** | 500 `server_error` |
| S07 | นามสกุล `jpg.exe` | PASS | 400 `bad_ext` |
| S08 | id ตัวพิมพ์ใหญ่ | PASS | แปลงเป็นตัวเล็กให้ |
| S09 | `kind=poster` กับรูป | WARN | รับ 200 (ควรปฏิเสธ) |
| S10 | path abuse `/i/` | PASS | 400/404 ครบ |
| S11 | อัปพร้อมกัน 12 ครั้ง id เดียว | **BUG** | มี 500 ปนมา 1 ครั้ง |
| S12 | ชื่อแขก 300 ตัวอักษร | PASS | ตัดเหลือ 40 |
| S13 | รายการในอัลบั้มมี url/thumb | PASS | ไม่มีรายการเสีย |
| S14 | OPTIONS `/api/upload` | PASS | 204 + allow-methods |
| S15 | POST บน path สื่อ | WARN | ตอบ 200 (ควร 405) |

---

## 1. BUG — ไม่รองรับ `Range` (S02) · ผลกระทบสูงสุด

**โค้ดตอนนี้** (`src/worker.js` → `handleMedia`)

```js
const obj = await env.BUCKET.get(key);
const headers = new Headers();
obj.writeHttpMetadata(headers);
headers.set('etag', obj.httpEtag);
headers.set('cache-control', CACHE_IMMUTABLE);
return new Response(obj.body, { headers });   // ← ไม่มี Range, ไม่มี Content-Length
```

**อาการที่วัดได้**: ส่ง `Range: bytes=0-99` → ได้ **200** พร้อมไฟล์เต็ม ไม่มี `Accept-Ranges`

**ทำไมอันตราย**
- **iPhone/iPad (Safari) ต้องการ 206 ในการเล่นวิดีโอ** — คลิปที่แขกอัดอาจเล่นไม่ขึ้นหรือ seek ไม่ได้
- รูปใหญ่ไม่มี partial loading (เน็ตช้าแล้วหลุด = เริ่มใหม่หมด)
- CDN/browser บางตัวเลิกทำ progressive loading

**แก้**: ใช้ `obj.range(start, end)` ของ R2 ตอบ 206 + `Content-Range` + `Accept-Ranges: bytes` (~20 บรรทัด)

---

## 2. BUG — cursor เสียแล้วได้ 500 (S06)

**โค้ดตอนนี้**: `handleList` โยน error ของ R2 ขึ้นไปที่ `catch` ก่อนถึง `json()` → 500 `{"error":"server_error","detail":"list: Continuation token is not valid. (10023)"}`

**เมื่อไรเกิด**: guest กด "โหลดเพิ่ม" ด้วย cursor เก่า แล้วมี object ถูกเพิ่ม/ลบระหว่างนั้น (เกิดได้จริงตอนงาน — มีคนอัปไม่หยุด) → **หน้าเว็บขึ้น "โหลดอัลบั้มไม่สำเร็จ" และกดซ้ำก็ไม่ผ่าน**

**แก้**: catch error 10023 → เริ่มหน้าแรกใหม่ (cursor = null) แทนการ 500 หรือตอบ 409 พร้อมธง `restart: true` ให้ client เริ่มนับใหม่

---

## 3. BUG — เขียน key เดียวกันพร้อมกันได้ 500 (S11)

ยิง 12 request พร้อมกันที่ id เดียว → `codes=[200, 500]`

**เมื่อไรเกิด**: double-tap ปุ่มอัปโหลด, หรือ retry ซ้อนกับ request เดิมที่ยังค้าง (ผู้ใช้กด "ลองใหม่ทั้งหมด" เร็ว ๆ) — client retry 3 รอบช่วยกลบได้ แต่ 500 ใน log ทำให้ debug ยากและผู้ใช้อาจเห็น toast แปลก ๆ

**แก้**: ครอบ `BUCKET.put` ด้วย try/catch → ตอบ **409 `conflict`** (ให้ client retry) หรือ retry ภายใน 1 ครั้งก่อนตอบ

---

## 4. BUG ฝั่ง client — ZIP "ทั้งหมด" ได้แค่หน้าที่โหลดแล้ว

**โค้ดตอนนี้** (`public/app.js` → `startZip`)

```js
const picked = state.items.filter((i) => state.selected.has(i.id));
const list = picked.length ? picked : state.items;   // ← state.items = เฉพาะที่โหลดมา
```

`/api/list` คืนได้ครั้งละ ~300 รายการ (900 object) — ถ้าอัลบั้มมี 7,500 รูป การกด
"ดาวน์โหลดภาพทั้งหมดในรูปแบบ .zip" จะได้ **~300 รูปแรกเท่านั้น** โดยไม่มีการเตือน
(การเช็ค 3.5 GB ก็คำนวณจากชุดที่โหลดแล้วเช่นกัน)

**แก้**: ก่อนสร้าง ZIP ให้ไล่ `loadMore()` จน `state.cursor == null` พร้อมแสดงความคืบหน้า
หรือถ้าเกินเพดาน (เช่น 2,000 รายการ) ให้แจ้งให้แบ่งดาวน์โหลด

---

## 5. WARN — `kind=poster` ใช้กับรูปได้ (S09)

`SUFFIX` มี `poster: '-p'` และไม่ได้ผูกกับชนิดไฟล์ → อัป `kind=poster` ด้วย id ของรูป
จะได้ key `<id>-p.jpg` ที่ `handleList` ตีความเป็น "poster ของวิดีโอ" → รูปนั้นหายจากอัลบั้ม
(ไม่มี main file ที่ถูกต้อง) เป็นช่องให้ทำให้รูปคนอื่นหายได้ถ้ารู้ id

**แก้**: อนุญาต `poster` เฉพาะเมื่อมี `<id>.<video ext>` อยู่แล้ว หรือแยก endpoint

## 6. WARN — สื่อตอบทุก method (S15)

`POST /i/m/x.jpg` → **200** (เสิร์ฟไฟล์ให้) เพราะ `handleMedia` ไม่ตรวจ method
**แก้**: อนุญาตเฉพาะ GET/HEAD, ที่เหลือ 405

---

## สรุปลำดับความสำคัญ

| ลำดับ | รายการ | ผลกระทบ | งาน |
|---|---|---|---|
| 1 | Range / 206 | วิดีโอบน iPhone อาจเล่นไม่ได้ | ~20 บรรทัด |
| 2 | ZIP ได้แค่หน้าแรก | เจ้าภาพคิดว่าได้ครบ แต่หาย 7,200 รูป | ~15 บรรทัด |
| 3 | cursor เสีย → 500 | "โหลดเพิ่ม" ค้างกลางงาน | ~10 บรรทัด |
| 4 | เขียนชนกัน → 500 | อัปซ้ำแล้วขึ้น error | ~8 บรรทัด |
| 5 | poster loophole | รูปหายได้ถ้ารู้ id | ~5 บรรทัด |
| 6 | method บน /i/ | ไม่กระทบผู้ใช้ | ~3 บรรทัด |

ข้อ 1–4 ควรแก้ก่อนวันงาน ทั้งหมดรวมกันไม่เกิน 60 บรรทัดและไม่แตะโครงสร้างข้อมูล
