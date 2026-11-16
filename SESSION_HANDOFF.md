# SESSION_HANDOFF — Wedding Album

Last updated: 2026-11-15 · Status: **deployed and passing its production suite**

---

## 0. Deployment record

| Item | Value |
|---|---|
| Live URL | **https://wedding-album.rj-wedding.workers.dev** |
| Guest link | `https://wedding-album.rj-wedding.workers.dev/?e=demo-code` |
| Cloudflare account | `9989c93c130b3059711f14ba9ac31b5c` (`(owner email kept in the Worker secret / consent screen)`) |
| workers.dev subdomain | `rj-wedding` (registered 2026-11-15 via API) |
| R2 bucket | `wedding-album-media` (created 2026-11-15) |
| TLS certificate | valid, expires 2027-02-13 |
| Expiry | 2026-12-22 23:59 +07:00 |
| Production suite | `prod_test.py` **31/31**, `ui_test.mjs` **14/14**, zero console errors |
| Album contents after the run | emptied (all `TEST-` objects deleted from R2) |

**Wrinkle worth remembering:** a freshly registered workers.dev subdomain serves
`handshake_failure` (TLS alert 40) for a few minutes until Cloudflare issues its certificate.
DNS resolves the whole time, so do not read a successful `nslookup` as "it is live".

**Second wrinkle:** Cloudflare's managed protection answers **403 `error code: 1010`** to
clients with a non-browser User-Agent (Python's `urllib` is blocked; Postman's
`PostmanRuntime` is not). `scripts/prod_test.py` therefore sends a browser UA.

---

## 1. TL;DR

A guest-photo album for one wedding (22 Nov 2026, Rujira&a & Jenjobthid).
Guests scan a QR, shoot from the browser, photos are resized on the phone and stored in
Cloudflare R2. Everyone with the link sees the album for a week. The couple exports a ZIP
and (later) pushes the whole album into their own Google Photos with rclone.

Built from scratch instead of forking an existing project. **No database.** All tests pass
locally; it has never run on the real internet and never been opened on a real phone.

---

## 2. Decision log

Each decision is here because it is expensive to rediscover.

| # | Decision | Why |
|---|---|---|
| D1 | **Do not use Guestroll** (or any wedding SaaS repo) | Guestroll brings SQLite + sharp + ffmpeg + live wall + guestbook + multi-event + admin; we need ~3 of those. Forking and stripping it costs more than writing 250 lines. |
| D2 | **No database** | The gallery is derived from `R2.list()`. Object keys carry id/timestamp, `customMetadata` carries the guest name. Removing the DB removed the biggest source of complexity (sync→async refactor, migrations, connection limits). |
| D3 | **Cloudflare Workers + R2, not Vercel/Netlify** | R2 egress is free and unlimited; the whole page is static + 3 tiny API routes. Vercel/Netlify add a 4.5 MB body cap and a 30-day lockout if free-tier limits are exceeded. |
| D4 | **Upload through the Worker, not presigned URLs** | One less credential system. After on-device compression a photo is ~1 MB, far under the 100 MB request body limit. |
| D5 | **Compress on the phone, never on the server** | Workers free tier allows 10 ms CPU per request — server-side image work is impossible. Client compression also cuts venue bandwidth 4x. |
| D6 | **Never let compression make a file bigger** | `createImageBitmap({resizeWidth})` *upscales* small images: a 160-byte 1x1 JPEG became 25 KB. Guard: keep the original if the re-encode is larger. |
| D7 | **ZIP is built in the browser** (store-only, streaming) | A Worker cannot stream 7,500 files (50 subrequests on free). Store-only because photos are already compressed; `showSaveFilePicker` streams to disk so 4 GB never sits in RAM. |
| D8 | **Palette is sampled from the invitation card** | The card is the brief. Colours were pixel-counted, not eyeballed (see `docs/EVIDENCE.md`). |
| D9 | **`--ink` is darker than the card's green** | Card green `#637F4F` on cream measures 4.4:1 — fails AA for body text. Body uses `#3F5233` (6.8:1); the card green is kept for display-size headings only. |
| D10 | **Three design sources, split by role** | Invitation card = colour. *PHILATELY — the stamp album* = material (paper, perforated stamp frames, soft shadows). *Editorial Contemporâneo* = language (serif display, spaced caps labels, mono metadata, asymmetric grid). |
| D11 | **"Sheet" is currently only a UI label** | It is a pagination counter, not data. Making it real needs the DB (D14). Known limitation: photos shift between sheets as new ones arrive. |
| D12 | **Floral art is AI-generated, never cut from the card** | The card's artwork is single-use licensed designer work. Prompts are stored in `docs/art/PROMPTS.md`. |
| D13 | **The wreath is SVG, not AI** | A perfect circle of evenly spaced leaves is what diffusion models do worst. SVG is exact, 1.1 KB, recolourable. |
| D14 | **DB (D1) + real sheets: designed, not built** | Schema and pipeline are specified below. Deliberately deferred; nothing is blocked without it. |
| D15 | **Google Photos is an archive, not a serving layer** | Photos API cannot create share links (removed 2025-03-31) and Drive/Photos cannot serve 300 guests (API quotas). R2 serves; Google stores. |
| D16 | **rclone at a 5 GiB gate, never "move"** | 5 GiB ≈ 3,400 photos ≈ 3,480 API requests = 35% of the 10,000/day quota. Copy only — deleting from R2 would break the live album. |
| D17 | **Google sync runs on a Cloud Run Job**, paid by Google AI Pro credits | rclone is a Go binary and cannot run inside a Worker. Cloud Run Jobs bill per second, so idle cost is zero. |
| D18 | **Destination is the couple's own Google account** | Google Photos libraries are per-account; one album must live in exactly one account. The 5 TB plan is shared with 5 people, so headroom is a shared pool. |
| D19 | **All Google sync must happen inside 7 days of authorising** | OAuth app in Testing + External gives a 7-day refresh token. Syncing only during the event week sidesteps verification (which takes months). |
| D20 | **Nothing uploads until the guest confirms** (owner directive 2026-11-15) | Files go to a review strip first: thumbnail, size, tap to see full screen, ✕ to delete, "ลบทั้งหมด", then "อัปโหลด (n)". A guest cannot send a bad or accidental shot, and a mis-tap on `capture` costs nothing. Upload state is still shown per file, and a row that has not started can be dropped with ✕. |
| D21 | **Sheets + DB are optional and will not be built** (owner directive 2026-11-15) | "แผ่นแสตมป์ ไม่มีก็ได้". The gallery is a continuous stream; the sheet number stays a pagination label and nothing depends on it. No D1, no `sheet_no`, no per-sheet ZIP, no per-device cap. D14 is kept only as an option. |
| D22 | **Deploy order is test-first** (owner directive 2026-11-15) | Write the production test cases (`docs/TEST-CASES.md` + `scripts/prod_test.py`), deploy, run them against the real URL, then drive the API from Postman. Nothing is called done before it passes on the deployed host. |
| D23 | **Host = `*.workers.dev`, album expires 2026-12-22** (owner choice 2026-11-15) | No custom domain yet, so media goes through the Worker `/i/` proxy and counts against 100k requests/day. `EXPIRES_AT = 2026-12-22T23:59:59+07:00` = 30 days after the wedding. If a domain appears later, set `PUBLIC_MEDIA_BASE` and redeploy — no code change. |
| D24 | **Cloudflare agent setup installed** (official prompt, 2026-11-15) | Cloudflare skills are installed globally in `~/.agents/skills` (wrangler, workers-*, durable-objects, cf-cli, …). The Cloudflare remote MCP is configured in `~/.config/opencode/opencode.jsonc`, but its OAuth callback fails on this machine, so it stays unauthenticated until `opencode mcp auth cloudflare` succeeds from a normal terminal. Wrangler is authenticated through the device flow and is enough to deploy. |
| D25 | **Video is recorded inside the page, not by the native camera intent** (owner report from a real phone, 2026-11-15) | `<input type="file" accept="video/*" capture>` opened the **still camera** on the owner's phone, so "อัดวิดีโอ" silently produced photos, and media that did get uploaded would not play. The button now calls `getUserMedia` + `MediaRecorder` and records in an overlay: live preview, 60 s cap, 2.5 Mbit/s, container chosen by `isTypeSupported` in the order MP4/H.264 → MP4 → WebM/H.264 → WebM/VP8 (Chromium picks **MP4 + avc1**, the most widely playable). "วิดีโอจากคลัง" stays as the fallback for a browser that refuses camera access. |
| D26 | **Kind is decided by the file, never by the button** | `kindOf()` reads the MIME type first, then the extension, and only then the button hint. A photo returned by an OEM video picker is uploaded as a photo with a toast, instead of becoming an unplayable "video". |
| D27 | **Cleanup is a script, not a dashboard ritual** | `scripts/clean_album.py` lists the live album and deletes by guest prefix (`--guest TEST`) or the whole album (`--all --yes`) through `wrangler r2 object delete`. There is still no delete endpoint on the Worker (no per-guest auth). |
| D28 | **The tab and heading are called "ภาพความทรงจำ"** (owner directive 2026-11-15) | "แผ่นแสตมป์" read as a printing term, not as the guest's own words. The tab, the `<h2>`, the empty state and the count (`n รูป`) all use the new wording; the stamp look itself is unchanged. |
| D28b | **Album-toolbar wording** (owner directive 2026-11-15) | `เลือกที่โหลดแล้ว` → `เลือกทั้งหมด`, `ดาวน์โหลด ZIP` → `ดาวน์โหลดภาพทั้งหมดในรูปแบบ .zip`. |
| D29 | **Seven stamp frames, cycled by index** (owner directive 2026-11-15) | `v0` perforated (default) plus `v1` souvenir sheet, `v2` corner ticks, `v3` album mount, `v4` airmail, `v5` coil, `v6` cancelled. Only the frame changes — photo area, badge positions and tilt are shared, so a mixed album still reads as one collection. Spec table: `docs/DESIGN.md` §3.1. |
| D30 | **One library button for photos and videos** (owner directive 2026-11-15) | "เลือกจากคลัง" (`accept="image/*,video/*"`) replaces the separate video picker; `kindOf()` decides photo vs video per file. Button order: ถ่ายรูป → อัดวิดีโอ → เลือกจากคลัง. |
| D31 | **A guest can pick the frame before uploading** (owner directive 2026-11-15) | The review strip carries 8 swatches (อัตโนมัติ + v0…v6); the choice travels as `?frame=vN`, is stored in R2 `customMetadata.frame`, and `/api/list` returns it. Frames with no choice get a stable hash of the photo id. |
| D32 | **The grid is masonry and every frame matches its photo's ratio** (owner report: photos were being cropped) | Tiles read their real ratio after the thumbnail loads: portrait → 3:4, landscape → 4:3, square → 1:1, applied to the `<img>` so `object-fit: cover` has nothing to crop. `columns: 3 92px` on phones, `5 140px` above 720 px. The 2×2 hero plate was removed — at full column width it either cropped or became an enormous square. `ui_test` fails unless every tile's box ratio equals the photo's ratio within 4%. |
| D33 | **ZIP is always the untouched original; frames are only for single downloads** (owner directive 2026-11-15) | `ดาวน์โหลดภาพทั้งหมดในรูปแบบ .zip` streams the R2 objects, so no frame is ever baked in. In the lightbox the guest can pick a frame (default `ไม่ใส่กรอบ`) and `ดาวน์โหลดภาพนี้` renders it on a canvas at full resolution as PNG (perforation is punched with `destination-out`, so the holes are truly transparent). Videos always download as the original file. |
| D34 | **Frame corrections from the owner's review** (2026-11-15) | (a) `v6` (a cancel mark with no meaning) was removed — six frames remain. (b) Frames now take the photo's **real** ratio, not a snapped 3:4/4:3/1:1, so a 16:9 screenshot is no longer cropped. (c) The perforation is drawn with an outer margin equal to the hole radius, otherwise the canvas edge slices every hole in half. (d) The airmail frame draws both bands — the first version only striped the top. (e) The frame picker sits in the centre of the lightbox bar and the picture re-renders as a live preview the moment a frame is chosen. |
| D35 | **Site title is "The Wedding Collection"; the logo is the owner's bouquet with the background cut out** (2026-11-15) | `<title>`, `og:title` and the cover eyebrow all read The Wedding Collection. The bouquet the owner supplied is cut out by `scripts/make_logo.py` (flood fill from the edges + removal of the remaining pure-white pockets, then a 1 px alpha feather). Outputs `logo.webp` 512, `logo-192.png` (favicon + apple-touch), `logo-512.png`, `logo-32.png`; used as the favicon, the emblem above the eyebrow and the empty-state art. Original archived at `docs/art/source/logo-bouquet.webp`. |
| D36 | **The framed download margin scales with the geometric mean of the photo** (owner report: a phone screenshot looked like it spilled over the frame) | `pad = 6.5% × √(w×h)`, minimum 16 px. The old rule used the short side, so a 1080×2340 screenshot got a 2 % border and the gold line sat 23 px from the edge. Measured after the change: 41 px on v1 and 103 px on v2 for that same screenshot, symmetric on all four sides. |
| D37 | **The size limits line is gone; the cover date is written out in Thai** (owner directive 2026-11-15) | `#limits` ("รูปไม่เกิน 12 MB · วิดีโอไม่เกิน 80 MB") was removed from the cover and from the JS that filled it — the limit still exists and is enforced, it is just no longer announced. The date now reads **วันอาทิตย์ที่ 22 พฤศจิกายน พ.ศ. 2569** (`longDate()` in `app.js`; 2026-11-22 really is a Sunday, พ.ศ. 2569). The postmark keeps the compact `22.11.26` because a 40 px circle cannot hold Thai text, and the A5 QR card uses the long form while the small cards keep the short one. |
| D38 | **The 60-second cap is written on the record button; the photo/video split is dropped** (owner directive 2026-11-15) | The button now carries a second line, `อัดได้ครั้งละไม่เกิน 60 วินาที`, generated from `REC_MAX_MS` so the label cannot drift from the real limit. Separating photos and videos into their own views was analysed (client filter chips, `?kind=` filtering, separate prefixes) and **deferred** — too close to the wedding for a change that touches pagination, the count label and the ZIP scope. Revisit after the event. |
| D39 | **One typeface for the site, except the couple's names and the wordmark** (owner directive 2026-11-15) | Every label, heading, badge and button now uses the same Noto Sans Thai stack as the "ถ่ายรูป" button (13 rules switched from `--serif`/`--mono` to `--sans`; letter-spacing kept). **Kept as before:** `.names` (the couple's names, Playfair + Noto Serif Thai) and `.eyebrow` (THE WEDDING COLLECTION, spaced mono). JetBrains Mono was dropped from the Google Fonts request. |
| D40 | **The how-to hints are three bullets above the buttons** (owner directive 2026-11-15) | The single paragraph under the buttons became `<ul class="tips">` placed **before** ถ่ายรูป: อัดวิดีโอ (≤60 s) · เลือกจากคลัง (photo + video) · what to do when the browser refuses the camera. The old duplicate paragraph was deleted. |
| D41 | **The album is seeded with RAG-Diary artwork; every wipe writes a manifest first** (owner directive 2026-11-15) | `scripts/seed_demo_art.py` uploads eight generated illustrations from `Learning/Code-along/RAG-Diary` (four watercolour mood washes + four flat scenes), resized to ≤1600 px q86, guest label `RAG-Diary`. Both albums were wiped and reseeded; the 12 previous production items (4 `Guest` + 8 `กขค`, including two recorded clips of 25 MB and 44 MB) are listed with their R2 keys in `_backup/album_prod_before_seed_20261115.md`. Deletion is permanent — R2 has no versioning. |
| D42 | **Capacity measured, not guessed: the platform takes ≥100 concurrent uploads; viewing is what burns the quota** (2026-11-15) | `scripts/capacity_test.py` ran against the live host. 100 concurrent 8 KB uploads → 100/100, p50 1.6 s. 25 concurrent 853 KB photos → 25/25, p50 4.4 s. At 100 × 853 KB three requests timed out, but that is the test machine's uplink (83 MB in flight), not the Worker. Media GETs: 150/150 at concurrency 50, p50 1.5 s. **The number that matters**: 300 guests opening a 300-photo album once = ~90,000 Worker requests, i.e. 90 % of the 100 k/day free limit — *before* any upload traffic. Mitigation is one change: bind an R2 custom domain and set `PUBLIC_MEDIA_BASE`. Full tables in `docs/LOAD-TEST.md`. Test objects (665) were deleted afterwards; the album is back to the 8 RAG-Diary images. |
| D43 | **Stability probes found 4 real defects (not yet fixed)** (2026-11-15) | `scripts/stability_test.py` (15 cases, live host) → `docs/STABILITY.md`. Ranked: **(1) no `Range` support** in `handleMedia` → 200 instead of 206, so iOS Safari may refuse to play/seek videos; **(2) ZIP "ทั้งหมด" only packs `state.items`**, i.e. the first ~300 of 7,500 photos, silently; **(3) an invalid R2 cursor returns 500** from `handleList` (a stale "โหลดเพิ่ม" cursor dies mid-event); **(4) 12 parallel writes to one key return a 500** from `BUCKET.put`. Two warnings: `kind=poster` is accepted for a photo (could hide a photo), and `/i/` answers any HTTP method. Fixes 1-4 are ~60 lines total and touch no data structures. |
| D44 | **The tab bar was translucent, which made the two tabs look like different pages** (owner report) | `.tabsBar` used `rgba(251,248,243,.94)` + `backdrop-filter: blur(8px)`. On the album tab photos scroll under the sticky bar and tint it, so "ถ่ายรูป" looked cream and "ภาพความทรงจำ" looked pink. Now opaque `var(--paper)`, no blur. Verified by pixel probe: the bar reads `(251,248,243)` on both tabs at every scroll position. |
| D45 | **A page is now ~60-96 photos instead of ~300, because the wedding has 600-700 guests** (owner directive 2026-11-15) | `handleList` went from a 5×1000-object loop (900 objects ≈ 300 photos) to a single `list({limit:180})` call. Rationale: 650 guests × 300 thumbnails = 195,000 Worker requests when they open the album, double the free 100k/day; 650 × 60 = 39,000. It also cut the first-open payload from ~13.5 MB to ~3 MB on 4G. Full numbers and the paid options (Workers $5 vs an R2 custom domain vs staying free) are in `docs/CAPACITY-650.md`. Storage at that volume is ~12.6 GB, i.e. over the 10 GB free tier regardless. |
| D46 | **Pagination: 15 photos per page, buffered behind one API call** (owner directive 2026-11-16) | `PAGE_SIZE = 15` in `app.js`. The Worker still returns its 180-object page (~60-96 items) into `state.items`, and "ดูรูปถัดไป (15)" reveals the next 15 from that buffer — so four clicks cost one request, which is what keeps 650 guests inside the daily quota. Header reads `แสดง 15 จาก 90+ รูป`; the button hides when nothing is left. Reset after an upload re-fetches and shows the first 15. |
| D47 | **Google Drive archive is implemented in the Worker (no rclone, no Cloud Run)** (owner directive 2026-11-16) | `POST /api/sync?token=` + a 15-minute cron push every object under `m/` that has no `synced/<key>` marker into one Drive folder, with a resumable upload so an 80 MB clip never sits in memory. Markers live in R2 (no database) and are written only after Drive confirms, so a retry duplicates at worst. Proven against a mock Drive (`scripts/mock_drive.py` + `scripts/sync_test.py`, 9/9): token exchange, folder id, content-type pass-through, byte-for-byte stream, idempotent second run, 403 on a bad token. **Not live yet** — needs the owner's OAuth client + refresh token + folder id (`docs/GOOGLE-DRIVE.md`); until then the cron no-ops and production answers 503 on `/api/sync`. |
| D48 | **Flood test: Cloudflare held, the test machine did not** (owner directive 2026-11-16) | 600 photos (850 KB) + 600 clips (1 MB) = 2,400 requests at concurrency 200 → 2,213 ok (92 %), 187 failures **all client-side** (EOF/TLS/timeouts from 200 sockets on one home line), zero 5xx/429 from Cloudflare. The same shape at concurrency 30 → 600/600, p50 4.1 s, and *faster* (6.5 vs 4.2 req/s). 75 album entries were missing afterwards because a main file failed while its thumb succeeded — the app's 3× retry covers that in production. Reading 1,425 items took 17 pages / 7.9 s with no duplicates. Full numbers: `docs/FLOOD-TEST.md`. |
| D49 | **The album now opens on the NEWEST photos (ids are timestamp-inverted)** (found by the scenario suite, 2026-11-16) | R2 lists keys ascending, so an epoch-prefixed id put the **oldest** photo on page 1 — on the wedding day guests would open the album and see the first photo of the morning, with ~70 "next" taps to reach the reception. `makeId()` now emits `(9999999999999 − Date.now())`, so the newest upload has the smallest key and sits on page 1. The real upload time is read from `customMetadata.ts` (the id is no longer a timestamp). Demo art must be re-seeded so every key uses the new scheme. |
| D50 | **`Range` is supported — the real fix for "clip does not play on iPhone"** (owner question, 2026-11-16) | Recording was never broken (getUserMedia + MediaRecorder). Playback was: `/i/` answered every request with 200 + the whole file, and Safari needs **206** to play or seek. `handleMedia` now parses the header (`parseRange` in `src/lib.js`), streams just the asked-for bytes from R2, and returns `content-range`; HEAD returns a length, 416 is returned for unsatisfiable ranges. Verified on production: `Range: bytes=0-99` → `206`, `bytes 0-99/692`. |
| D51 | **Unit tests + a scenario suite exist now** (owner directive 2026-11-16) | Pure logic moved to `src/lib.js` (parseKey, mediaUrl, parseRange, groupObjects) and `public/util.js` (dates, hash, kindOf, extOf, safeName, human, fmtTime) so it can be tested without Cloudflare/DOM. `npm run test:unit` → **15/15** via `node --test`. `scripts/scenario_test.py` simulates S/M/L scales plus the edge cases and ran **11/11** on production (2,000 uploads at once, wrong code, 13 MB rejection, duplicate id, orphan thumb, bad kind, 120 views + 20 uploads simultaneously). Full numbers: `docs/SCENARIOS.md`. |
| D52 | **Bulk deletes now go through the Worker, per the new Bulk Operation Law** (2026-11-16) | The old cleanup ran `npx wrangler r2 object delete` once per object with 32 threads — exactly the process storm the global AGENTS.md now forbids. Added `POST /api/purge` (token = `SYNC_TOKEN`), which calls `BUCKET.delete([...up to 900 keys])`: **891 objects removed in 2 requests, 0 CLI processes**, album back to the 8 demo images. `scripts/purge.py` is the caller and prints the load projection before touching anything (`--dry-run` available). `clean_album.py` keeps its boto3/guarded-wrangler path for when no token is set. | `handleList` went from a 5×1000-object loop (900 objects ≈ 300 photos) to a single `list({limit:180})` call. Rationale: 650 guests × 300 thumbnails = 195,000 Worker requests when they open the album, double the free 100k/day; 650 × 60 = 39,000. It also cut the first-open payload from ~13.5 MB to ~3 MB on 4G. Full numbers and the paid options (Workers $5 vs an R2 custom domain vs staying free) are in `docs/CAPACITY-650.md`. Storage at that volume is ~12.6 GB, i.e. over the 10 GB free tier regardless. |
| D53 | **Cleanup is bulk-first: never one `npx` per file** (owner directive 2026-11-16) | `scripts/clean_album.py` now picks an engine. Above 20 keys with an R2 S3 token it deletes through `boto3 DeleteObjects` (1000 keys per request, ~2 s, one process); otherwise it calls `node node_modules/wrangler/bin/wrangler.js` directly (~2.4 s and 2 processes per key) and never `npx`. Measured on this machine: `npx` cold start **4.85 s / ~5 processes**, direct node **2.42 s / 2 processes**. The 701-key full wipe therefore drops from ~3,500 process creations (which froze the laptop: 67 node.exe, 5.1 GB RAM, 100% CPU) to 1,402, or **1** with a token. `--dry-run` plus a `_backup/` manifest come before any deletion, and `scripts/bulk_guard.py` caps workers at 2 and aborts on a storm. Verified 2026-11-16: wrangler exits 0 for a key that does not exist, so an exit code means "the call did not fail", not "an object existed"; the album re-list at the end is the real check. Install path for the token is `.dev.vars` (gitignored), template in `.dev.vars.example`. |
| D57 | **Drive archive is LIVE and measured** (2026-11-16) | Credentials were wired through `scripts/drive_setup.py` (reads the OAuth client JSON, uploads both secrets, runs the loopback consent on port 8765, exchanges the code, uploads the refresh token) after two failed manual attempts: the first pasted an **authorization code** (`4/0A…`, len 73) where a refresh token (`1//0…`, len 103) belongs, which Google only reports as a bare `invalid_grant`. Added `GET /api/sync?diag=1` (masked lengths + the token endpoint's own `error_description`) and `?folder=1` (creates the Drive folder as the app, since `drive.file` cannot see a folder made by hand). Folder: `YOUR_DRIVE_FOLDER_ID` ("Wedding-22.11.26"). **First real batch: 12 objects / 1.63 MB / 39.1 s = 18.4 objects/min, 2.50 MB/min, 3.26 s per file, 0 failures**, folder now holds all 12 demo objects and `pending` is 0. Full event (27,200 objects) therefore takes ~24.6 h continuously; with cron `*/2` + `SYNC_BATCH=20` it is ~1.9 days. Never set the cron interval shorter than one run (25 objects ≈ 81 s) or two overlapping runs will upload the same files twice. |
| D56 | **Drive archive: the ceiling is 50 fetch subrequests, measured — so 25 files per run, ~11 days** (2026-11-16) | Added `GET /api/limits` (token-gated) to measure the platform ceilings instead of trusting docs: **fetch = 50 per invocation** (50 pass, 51 fails with "Too many subrequests") and **R2/API = 999** (999 pass, 1,000 fails), with a sequential R2 op costing **93–98 ms**. That confirms the existing `limit: 25` was already at the fetch ceiling (2 fetches per file: resumable start + PUT), i.e. 25 × 96 runs = 2,400 objects/day → **~11.3 days** for the 27,200 objects of the event. `SYNC_BATCH` now sets the cron batch (default 200 was written for the 999 budget but the 50-fetch ceiling is binding, so the cron keeps 25). Added `?dry=1` to `/api/sync` (reports pending without any Drive call), `bytes` in the sync response, and `scripts/drive_sync.py`, which loops batches over HTTP (one request per batch, no per-file process) and prints obj/min + MB/min + ETA. **Blocking finding: the Drive refresh token expires in 7 days while the OAuth app is in Testing, so an 11-day archive dies halfway** — the app must be switched to In production (drive.file is not a sensitive scope, no verification needed). The Drive leg itself (start + PUT timing) stays `UNVERIFIED` until credentials exist. Details: `docs/DRIVE-SYNC-TIMING.md`. |
| D55 | **No money was spent: the album now bundles thumbnails, measured end to end** (owner directive 2026-11-16) | New `GET /api/page?e=CODE&k=<keys>` streams up to **8 thumbnails per request** as `multipart/mixed` (each part carries `x-key`), with a **420 KB byte budget** and a 200 KB per-part guard so a full-size photo can never slip in. The client splits the response into blobs, and if the bundle fails twice it falls back to one request per photo by itself. Measured with `scripts/req_count.mjs` on production: tapping the album for a 15-photo page went **15 → 4 requests** (list + 3 bundles), first visit **17 → 5**, repeat visit **10 → 1**; all 15 tiles rendered from blobs with zero individual `/i/` calls. CPU was measured with `wrangler tail`: the first design (JS stream re-enqueue) cost **14.6 ms avg**, over the free 10 ms ceiling, so it was replaced with a Blob concatenation (**median 4 ms, p90 8**). Removing the budget on purpose and firing 13 ms still returned 200/ok, i.e. the ceiling does not reject requests in practice, but the budget stays. Also fixed a real defect: `/api/*` sent no `cache-control`, so Chrome heuristically cached the list and a guest could reload the old list right after uploading (their photo missing). `/api/config` now caches 10 min, `/api/list` is `no-store`, `/api/page` is immutable. New tools: `scripts/page_test.py` (11 checks), `scripts/req_count.mjs`, `scripts/page_bench.py`, `scripts/page_scale.py`, `scripts/bench_seed.py`; raw numbers in `docs/CPU-MEASUREMENTS.md`. |
| D54 | **Every quota option is written down with trade-offs; the decision is still open** (2026-11-16) | `docs/QUOTA-OPTIONS.md` compares 7 paths against the current Cloudflare docs (all fetched 2026-11-16): Workers Paid $5 (0 code, no daily cap, CPU 10 ms → 30 s), R2 custom domain (~350–450 THB/yr, needs an owned zone in the same account), `r2.dev` (free but documented rate-limited and non-production), presigned S3 URLs (free, no domain needed, media leaves the Worker, ≤7-day expiry, no CDN cache, needs bucket CORS), batch upload (2,000 instead of 27,200 requests), bundle read (17 → 3 requests per album open), smaller pages, service worker cache. It also records why caching saves nothing (Workers run before cache and cached requests are still billed) and why static assets cannot hold guest photos (they must exist at deploy time, and static assets ignore `Range`, which breaks iPhone video). Numbers: wedding day 38,250 / 57,750 / 77,900 requests for 1 / 3 / 5 pages per guest. No option chosen yet. |

---

## 3. Architecture

```
Guest phone
  camera / gallery  ->  resize on device  ->  POST /api/upload  ->  Worker
                                                                     |
                                                    env.BUCKET.put(key, request.body)
                                                                     v
                                                              R2 bucket
                                                    m/<id>.jpg        full (<=2048px)
                                                    m/<id>-t.jpg      thumb 480px
                                                    m/<id>.mp4        video
                                                    m/<id>-p.jpg      poster frame
Gallery
  GET /api/list  ->  BUCKET.list(prefix "m/")  ->  group 4 variants by id  -> JSON
  images         ->  R2 custom domain (recommended) or /i/<key> proxy
ZIP
  browser fetches each object -> store-only ZIP -> File System Access API
```

Key facts baked into the design:

- Object key is `m/<epoch-ms>-<rand6><variant>.<ext>`; grouping works because `-` (0x2D)
  sorts before `.` (0x2E), so the four variants stay adjacent when listing.
- No DB, so guest names live in `customMetadata.guest`.
- `/api/config` and `/api/list` both honour `EVENT_CODE` (constant-time-ish compare) and
  `EXPIRES_AT` (410 after expiry).

---

## 4. What exists

### Backend — `src/worker.js` (209 lines)

| Route | Behaviour |
|---|---|
| `GET /api/config` | title, names, date, limits; 403 bad code; 410 expired |
| `POST /api/upload?e=&id=&kind=&ext=&name=` | validates kind/id/ext/content-type/content-length, writes to R2 |
| `GET /api/list?e=&cursor=` | up to 5×1000 objects per call, grouped, ~300 photos per page |
| `GET /i/<key>` | R2 passthrough with immutable cache headers |
| else | static assets |

### Front end — `public/`

| File | Role |
|---|---|
| `index.html` | album cover, tabs, upload buttons, review strip, stamp album, lightbox |
| `app.js` | capture, review/delete before upload, on-device compression, upload queue (3 parallel, 3 retries), gallery render, lightbox, sheet counter |
| `zip.js` | store-only ZIP with CRC32 + data descriptors, streams via `showSaveFilePicker`, capped under 4 GB |
| `styles.css` | full design system (tokens, stamp mask, review strip, typography, lightbox) |
| `art/*.webp` | sprig, divider, bouquet, wash — 56 KB total |

**Upload flow (D20):** pick → **review strip** (thumbnail · size · tap = full screen · ✕ = delete ·
"ลบทั้งหมด" · "อัปโหลด (n)") → queue (3 parallel, 3 retries, ✕ drops a row that has not started) →
gallery refresh. Nothing leaves the phone until "อัปโหลด" is pressed.

**Compression thresholds:** ≤3 MB and ≤2048px → untouched · 3–5 MB → 2048px q0.85 ·
&gt;5 MB → 1600px q0.80 · result bigger than source → keep source.

**Design highlights:** every 7th photo becomes a 2×2 "plate" with a SVG leaf-and-gold-dot
wreath postmark; tiles tilt deterministically (`-1.2°…+1.1°`); perforated edges are four
intersecting radial-gradient masks, dropped automatically above 120 items (`.grid.simple`).

---

## 5. What is verified

All numbers below come from real runs on this machine on 2026-11-15.

| Suite | Result |
|---|---|
| `smoke_test.py` | 26/26 API assertions |
| `zip_test.mjs` + `verify_zip.py` | archive valid, CRCs match, Thai filenames intact |
| `prep_test.mjs` | 4.75 MB / 3200×2400 → **0.72 MB (15.3%)** |
| `ui_test.mjs` | **14/14**, zero console errors (review → delete → upload → album → lightbox → video → ZIP) |
| `load_test.py` | 240 requests, 0 failures, 120 MB in 12.4 s (~19 req/s) |
| `check_thai.py` | 8,093 Thai characters, no U+FFFD |

Measured design data: card palette (see evidence log), shipped art 56 KB, page weight
unchanged otherwise.

---

## 6. What is NOT done — in priority order

| # | Item | Consequence if skipped |
|---|---|---|
| 1 | **Deploy to Cloudflare** (bucket, custom domain on R2, CORS, lifecycle) | It only exists on localhost |
| 2 | **Test on real phones: 5 devices, through the LINE in-app browser** | This is the number-one unknown; if upload fails there, guests cannot contribute |
| 3 | **iPhone live-shot test (HEIC) and an old low-RAM Android** | Compression path never exercised on real hardware |
| 4 | **Load test on a real mobile network**, not localhost/miniflare | The 19 req/s figure is optimistic |
| 5 | Print QR cards and table signs | Without a QR there is no album |
| 6 | Rehearse ZIP + restore | Backup never proven |
| 7 | Production test cases (see `docs/TEST-CASES.md`) run on the deployed host | "Works on my machine" is the only evidence |
| 8 | Host admin (delete/hide photos) | Bad photos can only be removed via the R2 dashboard |
| 9 | rclone pipeline (Dockerfile + sync script + Cloud Scheduler) | Nothing reaches Google Photos |

> Sheets, the D1 database, per-sheet ZIP and a per-device photo cap are **out of scope** (D21).

---

## 7. Next actions (fixed order, owner directive D22)

1. **Write the production test cases** — done (`docs/TEST-CASES.md` + `scripts/prod_test.py`, 31/31 on
   localhost).
2. **Enable R2 in the Cloudflare dashboard** — blocked here: `wrangler r2 bucket create` returns
   `code: 10042  Please enable R2 through the Cloudflare Dashboard`. One-time, needs the owner
   (`dash.cloudflare.com/<account>/r2/overview` → Enable R2).
3. **Deploy**: `wrangler r2 bucket create wedding-album-media` → `npx wrangler deploy`
   (account `9989c93c130b3059711f14ba9ac31b5c`, email `(owner email kept in the Worker secret / consent screen)`).
4. **Run the production suite** on the deployed URL, then **Postman** against the same host
   (`docs/postman/wedding-album.postman_collection.json`).
5. Real-device test: 5 phones, include LINE's in-app browser, HEIC, an old Android (~1 h).
   This closes the largest unknown in the project.

---

## 8. Deferred design — DB (D1) — **not planned, kept for reference only (D21)**

```sql
CREATE TABLE photos (
  id         TEXT PRIMARY KEY,      -- '1794737771673-4672fd'
  guest      TEXT NOT NULL,
  kind       TEXT NOT NULL,         -- photo | video
  ext        TEXT NOT NULL,
  bytes      INTEGER NOT NULL,
  width      INTEGER, height INTEGER,
  sheet_no   INTEGER NOT NULL,      -- 1,2,3…  (20 per sheet)
  slot       INTEGER NOT NULL,      -- 1..20
  device_id  TEXT,                  -- enforces 25 photos per device
  created_at INTEGER NOT NULL,
  hidden     INTEGER NOT NULL DEFAULT 0,
  r2_key     TEXT NOT NULL, thumb_key TEXT, poster_key TEXT
);
CREATE UNIQUE INDEX ux_slot    ON photos(sheet_no, slot);
CREATE INDEX        ix_sheet   ON photos(sheet_no, slot);
CREATE INDEX        ix_created ON photos(created_at DESC);
CREATE TABLE counters (name TEXT PRIMARY KEY, n INTEGER NOT NULL);
```

Pipeline: `UPDATE counters SET n=n+1 ... RETURNING n` → `sheet_no=((n-1)/20)+1`,
`slot=((n-1)%20)+1` → `R2.put` → `INSERT`. Reads become `SELECT … WHERE sheet_no=?`.
The DB is only an index: it can be rebuilt from R2 at any time, which is why losing it is safe.

Free-tier headroom: 7,500 rows ≈ 7.5 MB against 500 MB per database.

---

## 9. Deferred design — Google Photos archive

- Trigger: **5 GiB pending**, checked by a scheduled job; batch size justified by the API
  quota (see evidence log).
- Runner: **Cloud Run Job** (asia-southeast1) + Cloud Scheduler, credentials mounted from
  Secret Manager as a single `rclone.conf` (never as individual env vars — the token is JSON).
- Album name must stay constant (`Wedding-22.11.26`); changing it creates a second album.
- Filters: `--include "*.jpg" --include "*.mp4" --include "*.mov"`,
  `--exclude "*-t.jpg" --exclude "*-p.jpg"` (otherwise thumbnails and posters upload too).
- **Copy, never move.** R2 keeps serving the album while guests can still view it.

---

## 10. Secrets and configuration

| Value | Where it lives | Notes |
|---|---|---|
| `EVENT_NAMES`, `EVENT_TITLE`, `EVENT_DATE`, `EVENT_CODE`, `EXPIRES_AT`, `MAX_PHOTO_MB`, `MAX_VIDEO_MB`, `PUBLIC_MEDIA_BASE` | `wrangler.toml` `[vars]` | Public, not secret |
| Cloudflare R2 access key + secret | rclone.conf → Secret Manager | Never commit |
| Google OAuth client_id + client_secret + refresh token | rclone.conf → Secret Manager | One secret, mounted as a file |
| Google API key | **not used at all** | Photos API does not accept API keys |

`PUBLIC_MEDIA_BASE` empty means every image request passes through the Worker and counts
against the 100k/day request limit. Set it in production.

---

## 11. Known limitations (accepted)

- ZIP: no ZIP64 → max 4 GB per archive, 65,535 entries.
- Anyone with the link sees every photo; there are no per-guest permissions.
- A guest can delete a photo **before** it is sent (D20). After it is sent there is no delete
  UI — removal is done by the host in the R2 dashboard.
- Fonts load from Google Fonts; offline they fall back to system Thai fonts.
- The sheet number is a pagination label only (D11, D21).
- Google sync must finish inside 7 days of authorising (D19).

---

## 12. Open questions for the owner

1. Which hostname should the album use (a `*.workers.dev` URL, or a custom domain for R2 media)?
   This decides whether guests' image traffic counts against the Worker's 100k/day.
2. Where is the third invitation card file? Only two were provided.
3. Should the album stay online after the event (30 days, 90 days, forever)? This decides the
   R2 lifecycle rule and whether rclone must run before deletion.
