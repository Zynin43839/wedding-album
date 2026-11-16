# Evidence log — verified facts and their sources

Every number used in a decision lives here with its source and the date it was read.
**Do not re-guess these.** If a value is needed and is not here, mark it `UNVERIFIED` and say so.

Verified: 2026-11-15 · Sources are official documentation unless stated otherwise.

---

## 1. Google Photos Library API

| Fact | Value | Source |
|---|---|---|
| Quota (all Library calls) | **10,000 requests/project/day** | developers.google.com/photos/library/guides/api-limits-quotas |
| Quota (media bytes via base URL) | 75,000 requests/project/day | same |
| Surviving scopes | `photoslibrary.appendonly`, `.readonly.appcreateddata`, `.edit.appcreateddata` | developers.google.com/photos/overview/authorization |
| Removed scopes | `photoslibrary.readonly`, `.sharing`, `photoslibrary` — after **2025-03-31** apps see only content they created | developers.google.com/photos/support/updates |
| Sharing API | `albums.share`, `albums.unshare`, `sharedAlbums.*` **removed**; return `403 PERMISSION_DENIED` | same |
| Service accounts | **not supported** — a real user must authorise | developers.google.com/photos/overview/authorization |
| Upload quality | always full resolution / original quality, counts toward the user's storage; warn user if >25 MB per user | library/guides/upload-media |
| `batchCreate` | max **50** items per call, never parallel for the same user | same |
| Album constraint | media can only be added to albums **created by the app** | library/guides/get-started |
| Verification | app must pass OAuth verification before launch; unverified ⇒ "unverified app" screen and **100 new user cap**; may take "several months" | support.google.com/cloud/answer/7454865 |

## 2. Google OAuth

| Fact | Value |
|---|---|
| Refresh token expiry | external user type + publishing status **Testing** ⇒ refresh token expires in **7 days** |
| Exception | only `name`, `email`, `openid` scopes are exempt |
| Source | developers.google.com/identity/protocols/oauth2 |
| Drive `drive.file` | classified **non-sensitive** — "only require basic OAuth App Verification" |
| Source | developers.google.com/workspace/drive/api/guides/api-specific-auth |

## 3. Cloudflare

| Service | Free tier | Paid |
|---|---|---|
| R2 storage | 10 GB-month | $0.015/GB-month |
| R2 egress | **free, unlimited** | free |
| R2 Class A / B ops | 1M / 10M per month | $4.50M / $0.36M |
| R2 `r2.dev` | rate-limited (**not for production**) | use a custom domain |
| Source | developers.cloudflare.com/r2/pricing, /r2/platform/limits |
| Workers requests | 100,000/day | $5/month, 10M requests |
| Workers CPU | **10 ms per invocation** | 30 s default, up to 5 min |
| Workers subrequests | **50 per invocation** | 10,000 |
| Workers memory | 128 MB | 128 MB |
| Request body (zone Free) | 100 MB | 200 MB–5 GB |
| Response body | no enforced limit | — |
| Source | developers.cloudflare.com/workers/platform/{limits,pricing} |
| D1 (free) | 500 MB **per database**, 5 GB per account, 50 queries per Worker invocation, 5M rows read/day, 100k rows written/day | 10 GB/db |
| Source | developers.cloudflare.com/d1/platform/limits |
| Images (free) | **5,000 unique transformations/month**, works on images stored in R2 | $0.50/1,000 transforms |
| Source | developers.cloudflare.com/images/pricing |

## 4. Other platforms (checked to justify rejection)

| Platform | Limiting fact | Source |
|---|---|---|
| Vercel Hobby | request/response body **4.5 MB** (streamed responses exempt); max duration 300 s; 100 GB fast data transfer; **over-quota ⇒ wait 30 days** | vercel.com/docs/functions/limitations, /docs/limits, /docs/plans/hobby |
| Netlify | SvelteKit "does not run on Netlify Server yet"; functions are ephemeral | docs.netlify.com/build/server |
| Supabase free | 500 MB DB, 1 GB storage, 5 GB egress, **project pauses after 1 week of inactivity** | supabase.com/pricing |
| Turso free | 100 DB, 5 GB, 500M rows read, 10M rows written per month | turso.tech/pricing |
| Fly.io | **no free tier**; bills under **$5/month are waived** for the personal org (card required) | docs.fly.io/about/{pricing,free-waiver} |
| Backblaze B2 | 10 GB free, egress free up to 3× storage | backblaze.com/cloud-storage/pricing |
| Tigris | 5 GB free, egress free | tigrisdata.com/pricing |
| Storj | no free tier — 30-day trial, **$5/month minimum** | storj.io/pricing |

## 5. rclone (Google Photos backend)

| Fact | Detail |
|---|---|
| Upload target | only albums **rclone created**; cannot delete media or albums |
| Read-back | since 2025-03-31 only photos it uploaded |
| Quality | original quality, counts toward the user's Google quota |
| **2026 change** | rclone's shared client_id is **being retired during 2026** ⇒ you must create your own |
| Source | rclone.org/googlephotos |

## 6. Self-hosted options evaluated

| Project | Licence | Verified capability |
|---|---|---|
| Guestroll (`achedon12/guestroll`) | MIT | QR → camera, client-side resize, resumable uploads, SQLite + Docker, live wall. 7★, 136 commits |
| PicPeak (`PicPeak/picpeak`) | MIT | 367★, 3,035 commits, guest uploads, S3-compatible storage, but photographer-oriented (proofing/CRM), no QR designer, i18n EN/DE |
| Immich | AGPL | Docs state public share links let a **non-account holder upload**; requires **6 GB RAM / 2 cores** |
| Piwigo + Community plugin | GPL | "allows users of your gallery to create albums and add photos", admin moderation, rev 16.g (Sep 2026) |
| Source | github.com/*, docs.immich.app/features/sharing, piwigo.org/ext/extension_view.php?eid=303 |

## 7. Commercial products

| Product | Free tier | Paid | Source |
|---|---|---|---|
| Guestpix | **50 photos / 30 days** | one-time: Medium Plus **$59**, Signature Bundle **$89** ($119/2 yr), Luxe 2 yr **$119**, Memory Keeper **$2/mo** | guestpix.com/shop |
| Wedbox | **free 2 months after the event** | **$2.50/month** to extend | wedbox.com |
| PhotoCircle | not published | plan-based, **app required** | photocircleapp.com |

## 8. Measured on this machine

| Measurement | Value | Method |
|---|---|---|
| Invitation card palette | `#637F4F` **11,153 px**, `#FFFFFF` 9,279, `#EFC7C8` 707, `#D4685E` 217, `#E6ACAA` 705 | pixel histogram of `694c9b2b-….jpg` |
| Card base | pure white with blush watercolour at the edges, olive-green type | visual inspection |
| Compression result | 4.74 MB / 3200×2400 → **0.73 MB (15.3%)** | `scripts/prep_test.mjs` |
| Burst upload | 240 requests, 0 failures, 120 MB in 12.4 s (~19 req/s) | `scripts/load_test.py` (localhost) |
| Shipped art total | **56 KB** (sprig 15, bouquet 24, wash 10, divider 7) | `scripts/optimize_art.py` |
| Worker source size | 209 lines / 7.8 KB | file listing |
| Compression quality — smooth photo | 6000×4000 4.84 MB → 2048×1365 **0.13 MB** (35.9:1), PSNR **42.6 dB**, SSIM **0.991** | `scripts/compare_real_photo.py` on `IMG_5312.JPG` |
| Compression quality — busy detail | 3888×5184 5.63 MB → 1536×2048 **1.02 MB** (5.5:1), PSNR **35.0 dB**, SSIM **0.976** | same script, unsplash brick-wall photo |
| Synthetic 4 MB → 1 MB comparison | resize-to-2048 + q0.85 = 30.7 dB / 0.875 vs keep-12MP + q30 = 27.4 dB / 0.777 | `scripts/quality_test.py` || Production deploy | `wedding-album.rj-wedding.workers.dev`, TLS valid to 2027-02-13 | `prod_test.py` P02 |
| Production suite | 31/31 (HTTP) and 14/14 (browser) | `prod_test.py`, `ui_test.mjs` |
| Cloudflare bot rule | non-browser User-Agent on `*.workers.dev` → `403 error code: 1010` | measured 2026-11-15 (curl `-A`) |
| New workers.dev cert | TLS `handshake_failure` (alert 40) for ~1 min after registration, DNS already resolving | measured 2026-11-15 (openssl s_client) |

## 9. UNVERIFIED — must be checked before relying on it

| Item | Why it matters | How to close |
|---|---|---|
| LINE in-app browser support for `<input type=file capture>` | The single biggest adoption risk for Thai guests | Test 5 real devices |
| HEIC behaviour on iOS Chrome/Safari when picking from the library | Could produce unreadable files | Test on a real iPhone |
| Google Photos per-album photo ceiling | Affects whether a 5 GiB batch needs multiple albums | Check when first syncing |
| Cloud Run Job free allowance and `--set-secrets` file mount details | Decides whether the sync runner is truly free | Check Cloud Run pricing + test deploy |
| e2-micro price in asia-southeast1 | Compare against Cloud Run Job | GCP pricing calculator |
| Amount of Google AI Pro Cloud credits | Decides how long a runner can live | Google One / GCP billing page |
| FPS with 120+ stamp tiles carrying masks | Low-end phones may stutter | Measure on a cheap Android |
| Contrast of the AI floral art against `#FBF8F3` under `multiply` | Could look muddy on real screens | Screenshot on a real device |
| Actual upload speed on venue Wi-Fi/4G | The 19 req/s figure is from localhost | Load test over a mobile network |

## 10. Citation rules for this project

1. A number without a source line here is not evidence.
2. Blogger/forum/AI-summary pages are leads, never sources.
3. Pricing and quota pages change — re-read before quoting to a client.
4. When two sources disagree, record both and the reason for the choice.
