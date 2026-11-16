# Test cases — wedding album (production)

Version 1 · 2026-11-15 · Owner: session owner (Rujira&a & Jenjobthid album)

These cases are written **before** deploying, and they are the definition of "done" for the
deployment. Every case runs against the real host, not localhost. Case IDs are stable — the
automated suites print the same IDs, so a failure line points straight at a row here.

| Group | What it proves | Runner |
|---|---|---|
| **P** | The deployed host serves the app and the API obeys its contract | `python scripts/prod_test.py` |
| **U** | A real browser completes the guest journey end to end | `BASE_URL=... node scripts/ui_test.mjs` |
| **M** | Real phones can actually shoot and upload (the biggest unknown) | manual, 5 devices |
| **Q** | The QR code / link a guest receives works | manual |
| **E** | The event-day rehearsal (load, expiry, backup) | manual |
| **R** | Recovery when something goes wrong | manual |

## 0. Run order

```bash
# 1. after `wrangler deploy` — read-only contract check (fast, no test photos)
python scripts/prod_test.py --base https://<host> --code <code> --skip-upload

# 2. full contract check, including a real upload round trip
python scripts/prod_test.py --base https://<host> --code <code>

# 3. browser end-to-end against the same host
BASE_URL=https://<host> EVENT_CODE=<code> node scripts/ui_test.mjs

# 4. Postman: import docs/postman/*.postman_collection.json with the same host/code
```

Run 1–3 **before** the QR code is printed or shared: step 2 leaves test photos in the album
(guest name `TEST-prod`, keys listed at the end of the output). If the album is already public,
use `--skip-upload` and delete the `TEST-` objects in the R2 dashboard.

---

## Group P — HTTP / API on the deployed host

Automatic: `python scripts/prod_test.py`. `--base` = deployed origin, `--code` = `EVENT_CODE`.

### Infrastructure

| ID | Case | Expected |
|---|---|---|
| P01 | `GET /` | 200, `text/html`, contains `<html`, UTF-8 |
| P02 | TLS | `https`, certificate valid and not expired |
| P03 | `GET /styles.css` with `accept-encoding: br, gzip` | 200, `text/css`, `content-encoding` present |
| P04 | `/app.js` `/zip.js` `/favicon.svg` `/art/*.webp` | 200 each, correct content-type |
| P05 | Art payload | ≤90 KB for all four WebP files |
| P06 | `GET /no-such-page` | 404 (no soft-404 HTML) |
| P07 | Root HTML | no `http://` google-font/localhost references (no mixed content) |
| P08 | `GET /?e=<code>` | 200 `text/html` |

### Config API

| ID | Case | Expected |
|---|---|---|
| P10 | `GET /api/config?e=<code>` | 200 JSON with `title`, `names`, `date`, `maxPhotoMb`, `maxVideoMb`; limits positive integers |
| P11 | `GET /api/config` (no code) | 403 `{error:"bad_code"}` |
| P12 | `GET /api/config?e=<code>x` | 403 |
| P13 | config body | no `bucket`/`secret`/`token`/`access_key`/`r2.dev` strings |

### List API

| ID | Case | Expected |
|---|---|---|
| P14 | `GET /api/list?e=<code>` | 200, `items[]`, `cursor` key present |
| P15 | `GET /api/list` (no code) | 403 |
| P16 | every item | has `id`,`ts`,`guest`,`type`,`size`,`url`,`thumb`; `url` is absolute or `/i/…` |
| P17 | media base | no item served from `r2.dev` (rate-limited) — custom domain or `/i/` proxy |

### Upload round trip

| ID | Case | Expected |
|---|---|---|
| P20 | `POST /api/upload` real ~150 KB JPEG, `kind=photo` | 200 `{ok:true, key:"m/…", url}` |
| P21 | same id via `GET /api/list` | appears within 10 s |
| P22 | `GET <url>` | 200, `image/jpeg`, byte length identical, `cache-control: …immutable` |
| P23 | `POST` `kind=thumb` | 200, key ends `-t.jpg` |
| P24 | `GET /i/<key>` | 200 `image/jpeg` (same-origin proxy works) |

### Rejections and edges

| ID | Case | Expected |
|---|---|---|
| P25 | `kind=bogus` | 400 `bad_kind` |
| P26 | `id=abc` (too short) | 400 `bad_id` |
| P27 | `ext=averylongext` | 400 `bad_ext` |
| P28 | `content-type: text/plain` | 415 `bad_type` |
| P29 | declared `content-length` 13 MB (limit 12) | 413 `too_large`, no body stored |
| P30 | `GET /api/upload` | 405 `method` |
| P31 | `GET /i/m/..%2fsecret.txt` | 400 (traversal blocked) |
| P32 | `GET /i/m/<missing>.jpg` | 404 |
| P33 | any API response | `access-control-allow-origin: *` |
| P34 | `OPTIONS /api/config` | 204 with `allow-methods` |

---

## Group U — browser end to end (deployed host)

Automatic: `BASE_URL=https://<host> EVENT_CODE=<code> node scripts/ui_test.mjs`.
Same 14 checks as the local run, but every request crosses the real network and R2.

| ID | Case | Expected |
|---|---|---|
| U01 | page loads | title rendered, no console error |
| U02 | event title from config | non-empty, matches `EVENT_TITLE` |
| U03 | guest name persists | `localStorage.guest_name` written |
| U04 | picking 2 files | review strip shows 2 tiles, button `อัปโหลด (2)` |
| U05 | nothing sent before confirm | 0 queue rows after picking |
| U06 | delete one before upload | 1 tile left, counter `1 ไฟล์ · x.x MB` |
| U07 | confirm upload | 1 row reaches `✓ ส่งแล้ว`, review strip disappears |
| U08 | video | staged for review, then uploaded |
| U09 | album tab | tiles render (thumbnails load over the real media host) |
| U10 | lightbox | opens an image |
| U11 | video in lightbox | `<video>` with `.mp4` source, plays |
| U12 | ZIP | download produced with the date in the filename |
| U13 | desktop viewport | layout intact at 1280×860 |
| U14 | console | zero browser errors across the whole run |
| U15 | image fed to the video button | treated as a photo, toast `ไฟล์นี้เป็นรูปภาพ` (D26) |
| U16 | queue row with a long filename | stays inside the card, name ellipsised (no horizontal overflow) |
| U17 | library pick | one pick can carry a photo **and** a video; `kindOf` keeps each in its own kind |
| U18 | frame picker in the review strip | 7 swatches, choice recorded, uploaded tile keeps `vN` |
| U19 | album grid | masonry columns; every tile's box ratio equals its photo's ratio within 4% (nothing cropped, 16:9 included) |
| U20 | lightbox download | 7 swatches centred in the bar; picking one previews the framed PNG in place; plain by default; ZIP always ships originals (`frame_download_test.mjs`) |

---

## Group V — in-page video recorder (`scripts/rec_test.mjs`)

Automatic, Chromium with a fake camera (`--use-fake-device-for-media-stream`).
This is the suite that reproduces the bug the owner hit on a real phone.

| ID | Case | Expected |
|---|---|---|
| V01 | press `อัดวิดีโอ` | overlay opens, `<video>` preview has a live stream with width > 0 |
| V02 | start recording | button becomes `หยุดอัด`, timer runs |
| V03 | stop after 2 s | clip lands in "ตรวจก่อนส่ง" as a **video** tile (with a poster) |
| V04 | supported containers | Chromium reports `video/mp4;codecs=avc1…` first (MP4/H.264 wins) |
| V05 | upload | clip reaches `✓ ส่งแล้ว` |
| V06 | album + lightbox | video tile present, `<video>` fires `loadedmetadata`, no error |

Pass rule: V06 is the case that failed in the field — "อัปโหลดเป็นวิดีโอที่ดูไม่ได้" — so it must
pass on the deployed host, not only locally.

Screenshots land in `docs/screenshots/test/` (override with `SHOTS_DIR=…`).

---

## Group M — real devices (manual, the biggest unknown)

No automation can cover this. Record the device, OS, browser and result in the log below.

| ID | Device / browser | What to do | Expected |
|---|---|---|---|
| M01 | iPhone 12+ / **Safari** | scan QR → `ถ่ายรูป` → shoot → review → upload | photo appears in album within 10 s |
| M02 | iPhone / **LINE in-app browser** | same flow as M01 | camera opens, upload succeeds (highest-risk case) |
| M03 | iPhone / Chrome, photo picked from library (HEIC) | `เลือกจากคลัง` | converts to JPEG and uploads (not a broken file) |
| M04 | Android 8–10, ≤3 GB RAM, Chrome | shoot 3 photos in a row | no crash, no freeze >5 s |
| M05 | Android / LINE in-app browser | M01 flow | succeeds |
| M06 | Android / Samsung Internet | M01 flow | succeeds |
| M07 | any phone, 4G (not Wi-Fi) | upload a 4 MB photo | progress moves, completes < 30 s |
| M08 | any phone, weak signal, then airplane mode mid-upload | kill the network during upload | row shows retry, `ลองใหม่ทั้งหมด` recovers after the network returns |
| M09 | iOS low-power mode | open album with 50+ photos | scrolling stays smooth, no blank tiles |
| M10 | 2 phones at once | both upload the same moment | both photos appear, no lost file |

Pass rule: M01–M07 must pass on every device counted; M08 at least on one device per OS.

---

## Group Q — the QR / link a guest receives

| ID | Case | Expected |
|---|---|---|
| Q01 | QR encodes `https://<host>/?e=<code>` | scanner opens the album, not a 404 or the bare origin |
| Q02 | QR scanned by LINE, iOS Camera, Android Camera, Google Lens | all open in a browser that can upload |
| Q03 | link forwarded in a group chat | still works (no login, no cookie required) |
| Q04 | link opened with the code removed | `ลิงก์ไม่ถูกต้อง` toast, no photos leak |
| Q05 | printed card at 3 cm × 3 cm | scans from 30 cm in indoor light |

---

## Group E — event-day rehearsal

| ID | Case | Expected |
|---|---|---|
| E01 | 40 guests × 3 photos burst (`scripts/load_test.py` against prod) | 0 failures, p95 < 5 s per upload |
| E02 | 300-photo album on a phone | first screen renders < 3 s, `โหลดเพิ่ม` works |
| E03 | ZIP of 100 photos on a laptop | downloads, opens, count matches the album |
| E04 | `EXPIRES_AT` set 2 minutes ahead | after expiry both API and UI show `ปิดรับชมแล้ว` (410) |
| E05 | R2 object count vs `/api/list` count | match (nothing lost by the list grouping) |

---

## Group R — recovery

| ID | Case | Expected |
|---|---|---|
| R01 | `wrangler tail` during an upload | request logged, no exception |
| R02 | restore path: download ZIP → re-upload into Google Photos album | manual copy verified by eye |
| R03 | R2 lifecycle rule preview | matches the agreed retention (see handoff §12) |
| R04 | worker redeploy | album still served, objects untouched |

---

## Result log

Fill one block per run. Keep the raw output next to it.

| Run | Date | Host | P | U | V | M | Q | E | R | Notes |
|---|---|---|---|---|---|---|---|---|---|---|
| local | 2026-11-15 | 127.0.0.1:8787 | 31/31 | 15/15 | 6/6 | — | — | — | — | pre-deploy baseline |
| prod-1 | 2026-11-15 | wedding-album.rj-wedding.workers.dev | **31/31** | **15/15** | **6/6** | partial (owner phone: video path failed → D25) | — | — | — | deployed; test objects removed |

### Notes from prod-1

- `P02` TLS certificate valid until 2027-02-13.
- `P22` media returned byte-identical with `cache-control: public, max-age=31536000, immutable`.
- `P29` 13 MB body correctly rejected with `413 too_large`.
- The first attempt failed 26/31 with `403 error code: 1010` — Cloudflare blocks non-browser
  User-Agents. Fixed in the suite; not a site defect (guests use browsers, Postman is allowed).
- The very first HTTP attempt also failed with `handshake_failure` because the new
  workers.dev certificate had not been issued yet; it went green a minute later.
- **Owner's phone test found the real bug**: the native `capture` intent opened the still camera,
  so no video was ever recorded. Fixed by recording in-page (D25) and re-verified with V01–V06.
- A second owner report — the upload card overflowed its frame — traced to a grid track with
  `min-width: auto` being widened by a long filename. Fixed in `.qItem > *` / `.qMid`
  (`scripts/overflow_probe.mjs` now reports `offenders: []`).
