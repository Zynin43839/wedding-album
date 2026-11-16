# AGENTS_HUB — Wedding Album

Guest photo album for a wedding: guests scan a QR code, shoot on their phone, photos are
compressed on-device and uploaded to Cloudflare R2. Everyone at the event sees the whole
album; the couple can export a ZIP and later push everything to their Google Photos.

**Stack:** Cloudflare Workers + R2 + static assets. **No database.** Vanilla JS front end.

| Status | Value |
|---|---|
| Runs locally | yes (`npm run dev`) |
| Deployed | **yes** — https://wedding-album.rj-wedding.workers.dev |
| Tested on a real phone | **no** — never done |
| Last verified test run | prod 31/31 + ui 14/14 on the live host (2026-11-15); local suites also green |
| Cost at 300 guests | < 1 THB / month |

---

## Folder map

| Path | What belongs here |
|---|---|
| `src/worker.js` | The only backend. Upload, list, media proxy, auth, expiry |
| `public/` | Everything the browser downloads (HTML, CSS, JS, favicon) |
| `public/art/` | Shipped floral artwork (WebP, 56 KB total) |
| `scripts/` | Test suites and one-off tools. Never referenced by the app at runtime |
| `docs/` | Design spec, deploy guide, evidence log, test cases, art prompts |
| `docs/postman/` | Postman collection + environment for the API |
| `docs/art/source/` | Original AI-generated PNG/JPG (never shipped) |
| `docs/screenshots/` | Delivery screenshots. `screenshots/test/` is written by `ui_test.mjs` |
| root | Only this file, `SESSION_HANDOFF.md`, `README.md`, `package.json`, `wrangler.toml` |

---

## Commands

```bash
npm install
npm run dev                    # http://127.0.0.1:8787/?e=demo-code

npm run test:smoke             # API contract (needs dev running)
npm run test:zip               # ZIP writer + python zipfile check
npm run test:prep              # real 3200x2400 photo -> measures compression
npm run test:ui                # Playwright end-to-end, 10 checks
npm run test:load              # 40 guests x 3 photos burst
npm run test:thai              # mojibake scan
npm run test:unit              # pure logic unit tests (node --test, 15 checks)
npm run test:scenarios         # S/M/L scale + edge cases against a live host
npm run test:stability         # edge-case probes (Range, cursor, collisions)
npm run test:rec               # in-page video recorder (Chromium fake camera, 6 checks)
npm run test:frames            # single-photo download: plain vs framed vs ZIP (4 checks)
npm run test:prod              # production contract suite (BASE_URL env, 31 cases)

python scripts/make_qr.py      # rebuild docs/qr (4 print designs + SVG, QR verified)
python scripts/capacity_test.py --base <url> --mode upload|view --concurrency 3 10 25
                                 # load / rate-limit test (see docs/LOAD-TEST.md)
python scripts/stability_test.py --base <url>
                                 # edge-case probes (see docs/STABILITY.md)
python scripts/seed_demo_art.py --base <url> [--wipe --remote] [--manifest _backup/x.md]
                                 # seed RAG-Diary artwork; --wipe writes a manifest first
python scripts/purge.py --base <url> --token <SYNC_TOKEN> --prefix m/sc
                                 # bulk delete via POST /api/purge: 900 objects per
                                 # request, 0 CLI processes (Bulk Operation Law)
python scripts/clean_album.py --list             # what is in the live album
python scripts/clean_album.py --guest TEST --dry-run  # plan only, deletes nothing
python scripts/clean_album.py --guest TEST       # delete test uploads
python scripts/clean_album.py --all --yes       # wipe the album before the event
    # engine is picked automatically: >20 keys + R2 token -> boto3 bulk (~2 s),
    # otherwise direct wrangler (~2.4 s/key, capped at 2 workers by BulkGuard).
    # --engine bulk|wrangler forces one; --local targets the Miniflare store.
    # Needs wedding-album/.venv for the bulk path: .venv/Scripts/python.exe
node scripts/overflow_probe.mjs                  # horizontal-overflow check at 360px

BASE_URL=https://<host> EVENT_CODE=<code> npm run test:ui:prod   # browser e2e on the deployed host

npm run demo                   # seed 9 demo photos
npm run shot -- docs/screenshots/live.png "http://127.0.0.1:8787/?e=demo-code" shoot
python scripts/optimize_art.py # rebuild public/art from docs/art/source
npm run deploy                 # wrangler deploy (needs Cloudflare login)
```

Local state lives in `.wrangler/`. Delete that folder to wipe the album.

---

## Read these before changing anything

| File | Why |
|---|---|
| `SESSION_HANDOFF.md` | Decisions and their reasons, current state, what is left |
| `docs/DESIGN.md` | Colour tokens, type scale, stamp component, hard do-nots |
| `docs/EVIDENCE.md` | Every verified limit/price with its source — do not re-guess these |
| `docs/DEPLOY.md` | Production steps, R2 custom domain, CORS, lifecycle |
| `docs/art/PROMPTS.md` | The exact prompts used for the floral art |

---

## Rules for this project

1. **No database unless the owner explicitly asks.** The gallery is built from `R2.list()`.
   A DB was designed (D1 + `sheet_no`) but deliberately not built — see handoff.
2. **Never delete R2 objects while the album is live.** The site reads images only from R2;
   Google Photos cannot serve them (no share API, daily API quota).
3. **Never put photos in a database.** D1 caps a row/blob at 2 MB; images are 1–4 MB.
4. **Do not slice artwork out of the invitation card.** It is single-use licensed designer work.
   Use `docs/art/PROMPTS.md` to generate new art instead.
5. **`--gold` is for hairlines only, `--green` is display-size only.** Both fail WCAG AA as body text.
6. **Editing an existing file means editing it in place**, never regenerating it.
7. **Test with `npm run test:ui` after any CSS/HTML/JS change.** It catches things the eye misses.
8. **Bulk deletes go through `POST /api/purge`, never a CLI-per-object loop** (Bulk Operation
   Law). `BUCKET.delete([...keys])` handles 900 keys per request; `scripts/purge.py` is the
   caller. A loop of `npx wrangler r2 object delete` is a design error, not a tuning problem.
