/**
 * Take a screenshot of the running app.
 *
 * Usage: node scripts/shot.mjs [outfile] [url] [tab] [width] [height]
 *   tab: shoot | album   (default shoot)
 */
import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

const out = process.argv[2] || 'docs/screenshots/live.png';
const url = process.argv[3] || 'http://127.0.0.1:8787/?e=demo-code';
const tab = process.argv[4] || 'shoot';
const width = Number(process.argv[5] || 400);
const height = Number(process.argv[6] || 860);

const CHROME = path.join(
  process.env.LOCALAPPDATA,
  'ms-playwright',
  'chromium-1217',
  'chrome-win64',
  'chrome.exe'
);

mkdirSync(path.dirname(out), { recursive: true });

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const page = await browser.newPage({
  viewport: { width, height },
  deviceScaleFactor: 2,
});

const errors = [];
page.on('pageerror', (e) => errors.push(String(e.message)));
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));

await page.goto(url, { waitUntil: 'networkidle' });

if (tab === 'album' || tab === 'lightbox') {
  await page.click('.tab[data-tab="album"]');
  await page.waitForTimeout(700);
}

if (tab === 'lightbox') {
  await page.locator('#grid .tile').first().click();
  await page.waitForSelector('#lightbox:not([hidden])', { timeout: 8000 });
  await page.waitForTimeout(500);
}

await page.waitForTimeout(300);
await page.screenshot({ path: out, fullPage: tab === 'shoot' });

const title = await page.textContent('#eventTitle');
const tiles = await page.locator('#grid .tile').count();

console.log(`saved   : ${out}  (${width}x${height}, tab=${tab})`);
console.log(`title   : ${title}`);
console.log(`tiles   : ${tiles}`);
console.log(`errors  : ${errors.length ? errors.join(' | ') : 'none'}`);

await browser.close();
process.exit(errors.length ? 1 : 0);
