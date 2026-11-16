/**
 * Measure how many Worker requests ONE album open really costs.
 *
 * Method: read `performance.getEntriesByType('resource')` after each phase.
 * `transferSize > 0` means the bytes actually came over the network; `0` means
 * the browser served it from its own cache, which never reaches the Worker.
 * This is the number the free tier counts.
 *
 * The gallery tab is lazy, so it is measured separately from the page load.
 *
 * Run: node scripts/req_count.mjs
 *      BASE_URL=https://wedding-album.rj-wedding.workers.dev node scripts/req_count.mjs
 */
import { chromium } from 'playwright-core';
import path from 'node:path';

const CHROME = path.join(
  process.env.LOCALAPPDATA,
  'ms-playwright',
  'chromium-1217',
  'chrome-win64',
  'chrome.exe'
);

const ORIGIN = (process.env.BASE_URL || 'https://wedding-album.rj-wedding.workers.dev').replace(/\/+$/, '');
const CODE = process.env.EVENT_CODE || 'demo-code';
const PAGE_URL = `${ORIGIN}/?e=${CODE}`;

const CLASSIFY = (href) => {
  const u = new URL(href);
  if (u.pathname.startsWith('/api/')) return 'api';
  if (u.pathname.startsWith('/i/')) return 'media';
  return 'static';
};

async function snapshot(page) {
  return page.evaluate(() =>
    performance.getEntriesByType('resource').map((e) => ({
      name: e.name,
      transferSize: e.transferSize,
      encodedBodySize: e.encodedBodySize,
      duration: Math.round(e.duration),
    }))
  );
}

async function phase(page, label, action, settle = 3000) {
  const before = await snapshot(page);
  const seen = new Set(before.map((e) => e.name));
  await action();
  await new Promise((r) => setTimeout(r, settle));
  const after = await snapshot(page);
  const fresh = after.filter((e) => !seen.has(e.name));

  const rows = fresh.map((e) => ({ ...e, cls: CLASSIFY(e.name), net: e.transferSize > 0 }));
  const netWorker = rows.filter((r) => r.net && (r.cls === 'api' || r.cls === 'media'));
  const api = netWorker.filter((r) => r.cls === 'api').length;
  const media = netWorker.filter((r) => r.cls === 'media').length;
  const cached = rows.filter((r) => !r.net).length;
  const bytes = netWorker.reduce((a, r) => a + r.transferSize, 0);

  console.log(
    `  ${label.padEnd(26)} worker=${String(api + media).padStart(2)}` +
      ` (api ${String(api).padStart(2)} + media ${String(media).padStart(2)})` +
      `  servedFromBrowserCache=${String(cached).padStart(2)}` +
      `  transferred=${(bytes / 1024).toFixed(0)} KB`
  );
  return { worker: api + media, api, media, bytes, cached };
}

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const context = await browser.newContext({
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 3,
  userAgent:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
});

const page = await context.newPage();
const tapAlbum = () => page.click('[data-tab="album"]', { force: true });

console.log(`target: ${PAGE_URL}\n`);
console.log('VISIT 1 — first time ever on this phone');
const load1 = await phase(page, 'open page', () => page.goto(PAGE_URL, { waitUntil: 'networkidle' }));
const gal1 = await phase(page, 'tap ภาพความทรงจำ', tapAlbum, 4000);

console.log('\nVISIT 2 — same phone, later in the evening');
const load2 = await phase(page, 'open page again', () => page.goto(PAGE_URL, { waitUntil: 'networkidle' }));
const gal2 = await phase(page, 'tap ภาพความทรงจำ', tapAlbum, 4000);

console.log('\n──────────────────────────────────────────────');
const first = load1.worker + gal1.worker;
const later = load2.worker + gal2.worker;
console.log(`first visit : ${first} Worker requests  (page ${load1.worker} + gallery ${gal1.worker})`);
console.log(`later visit : ${later} Worker requests  (page ${load2.worker} + gallery ${gal2.worker})`);
console.log(`650 guests, first visit each : ~${(first * 650).toLocaleString()}`);
console.log(`650 guests, 3 visits each    : ~${((first + 2 * later) * 650).toLocaleString()}`);

await browser.close();
