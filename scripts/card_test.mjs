/**
 * Thank-you card tab: proves it opens, draws, downloads, and costs no requests.
 *
 * Run: BASE_URL=https://... node scripts/card_test.mjs
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
const URL_ = `${ORIGIN}/?e=${CODE}`;
const ORIGIN_HOST = new URL(ORIGIN).host;

const fails = [];
const check = (name, ok, info = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? `  [${info}]` : ''}`);
  if (!ok) fails.push(name);
};

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, acceptDownloads: true });
const page = await ctx.newPage();

let workerRequests = 0;
page.on('request', (r) => {
  const u = new URL(r.url());
  if (u.host === ORIGIN_HOST && (u.pathname.startsWith('/api/') || u.pathname.startsWith('/i/'))) {
    workerRequests += 1;
  }
});

await page.goto(URL_, { waitUntil: 'networkidle' });

// 1. the tab exists and opens
const tab = page.locator('.tab[data-tab="card"]');
check('thank-you tab exists', (await tab.count()) === 1);
workerRequests = 0;
await tab.click({ force: true });
await page.waitForTimeout(600);
check('card pane is visible', await page.locator('#tab-card').isVisible());
check('opening the tab costs 0 requests', workerRequests === 0, `${workerRequests} requests`);

// 2. canvas draws something (not a blank sheet)
const canvasBox = page.locator('#cardCanvas');
check('canvas present', (await canvasBox.count()) === 1);
const blankBefore = await page.evaluate(() => {
  const cv = document.querySelector('#cardCanvas');
  const ctx = cv.getContext('2d');
  const d = ctx.getImageData(0, 0, cv.width, cv.height).data;
  let nonWhite = 0;
  for (let i = 0; i < d.length; i += 400) {
    if (d[i] < 250 || d[i + 1] < 250 || d[i + 2] < 250) nonWhite += 1;
  }
  return nonWhite;
});
check('card has a drawn frame before a photo is chosen', blankBefore > 50, `${blankBefore} sampled ink pixels`);

// 3. pick a photo from the album -> canvas changes
const before = await page.evaluate(() => document.querySelector('#cardCanvas').toDataURL().length);
await page.locator('#cardPickAlbum').click();
await page.waitForTimeout(1200);
const picks = page.locator('#cardPicker .cardPickItem');
const pickCount = await picks.count();
check('album picker shows photos', pickCount > 0, `${pickCount} choices`);
if (pickCount > 0) {
  await picks.first().click();
  await page.waitForTimeout(1200);
  const after = await page.evaluate(() => document.querySelector('#cardCanvas').toDataURL().length);
  check('canvas redrawn with the photo', after !== before, `${before} -> ${after}`);
}

// 4. download produces a PNG
const [download] = await Promise.all([
  page.waitForEvent('download', { timeout: 20000 }).catch(() => null),
  page.locator('#cardDownload').click(),
]);
if (download) {
  const name = download.suggestedFilename();
  const target = path.join(process.env.TEMP || '.', 'opencode', name);
  await download.saveAs(target);
  const { statSync } = await import('node:fs');
  const size = statSync(target).size;
  check('download is a PNG of realistic size', name.endsWith('.png') && size > 20000, `${name} ${Math.round(size / 1024)} KB`);
} else {
  check('download is a PNG of realistic size', false, 'no download event');
}

// 5. the other tabs still work
await page.locator('.tab[data-tab="album"]').click({ force: true });
await page.waitForTimeout(1500);
check('album tab still renders tiles', (await page.locator('#grid .tile').count()) > 0);
await page.locator('.tab[data-tab="shoot"]').click({ force: true });
await page.waitForTimeout(400);
check('shoot tab still renders', await page.locator('#tab-shoot').isVisible());

console.log('');
console.log(fails.length ? `RESULT: FAIL ${fails.join(', ')}` : 'RESULT: PASS');
await browser.close();
process.exit(fails.length ? 1 : 0);
