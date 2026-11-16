# Deploy on push (GitHub → Cloudflare)

Two ways to make a push update the live album. Both keep the private values
(event code, couple's names, Drive folder id) out of the repository.

## What must stay private

| Value | Lives in | Why |
|---|---|---|
| `EVENT_CODE` | build secret | anyone with it can open 650 guests' photos |
| `EVENT_NAMES` | build secret | the couple's names |
| `DRIVE_FOLDER_ID` | build secret | a link into the host's Drive |
| Google client id / secret / refresh token | Worker secrets (already set) | never needed at build time |

`wrangler.toml` (committed) holds placeholders. `scripts/gen-prod-config.mjs`
writes `wrangler.prod.toml` from the three values at build time, and that file is
gitignored, so it never reaches GitHub.

---

## Option A — Workers Builds (recommended: no API token to manage)

1. Dashboard → **Workers & Pages** → `wedding-album` → **Settings** → **Build**
2. Connect the Git account and pick **`Zynin43839/wedding-album`**, branch **`master`**
3. Set the commands:

   | Field | Value |
   |---|---|
   | Build command | `npm ci && npm run test:unit && node scripts/gen-prod-config.mjs` |
   | Deploy command | `npx wrangler deploy -c wrangler.prod.toml` |

4. **Build variables and secrets** → add three entries, type **Secret**:
   `EVENT_CODE`, `EVENT_NAMES`, `DRIVE_FOLDER_ID`
5. Save, then push a commit to `master`.

What runs on every push:

```
npm ci                     (installs wrangler + test deps)
npm run test:unit          (17 checks; a failure stops the deploy)
gen-prod-config.mjs        (writes wrangler.prod.toml from the secrets)
wrangler deploy -c ...     (uploads Worker + static assets)
```

Notes
- Build variables are **build-time only**; runtime values still come from
  `wrangler.toml` + Worker secrets.
- Worker secrets (Google OAuth, `SYNC_TOKEN`) are untouched by a deploy; you only
  set them again if they rotate.
- Cron triggers are replaced by whatever `wrangler.prod.toml` says, so the
  schedule stays `*/15` unless the config changes.

## Option B — GitHub Actions (full control)

Use this if you want the deploy gated by a manual approval, or by tests that
need a live album (page/card/lock tests).

Add these repository secrets:

| Secret | Where to get it |
|---|---|
| `CLOUDFLARE_API_TOKEN` | Dashboard → My Profile → API Tokens → *Edit Cloudflare Workers* template |
| `CLOUDFLARE_ACCOUNT_ID` | `9989c93c130b3059711f14ba9ac31b5c` |
| `EVENT_CODE`, `EVENT_NAMES`, `DRIVE_FOLDER_ID` | same three values |

Then `.github/workflows/deploy.yml` (workflow_dispatch only, so a push cannot
deploy by itself):

```yaml
name: deploy
on:
  workflow_dispatch:
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22 }
      - run: npm ci
      - run: npm run test:unit
      - run: node scripts/gen-prod-config.mjs
        env:
          EVENT_CODE: ${{ secrets.EVENT_CODE }}
          EVENT_NAMES: ${{ secrets.EVENT_NAMES }}
          DRIVE_FOLDER_ID: ${{ secrets.DRIVE_FOLDER_ID }}
      - uses: cloudflare/wrangler-action@v3
        with:
          apiToken: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          accountId: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
          command: deploy -c wrangler.prod.toml
```

## Which to choose

| | Workers Builds | GitHub Actions |
|---|---|---|
| Setup | 5 clicks, no token | needs an API token + secrets |
| Runs on every push | yes | only when you trigger it |
| Gate with tests that touch production | no | yes |
| Risk | a broken commit goes live | deploy stays manual |

**Suggestion for this project**: Workers Builds with `npm run test:unit` in the
build command. Unit tests are fast and catch the classic breakages (dates,
bundle keys, range parsing). Keep the capacity/acceptance suites for manual runs.
