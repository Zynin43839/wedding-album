/** Render every frame onto a real photo after the perforation fix. */
import { chromium } from 'playwright-core';
import path from 'node:path';
import os from 'node:os';

const CHROME = path.join(process.env.LOCALAPPDATA, 'ms-playwright', 'chromium-1217', 'chrome-win64', 'chrome.exe');
const ORIGIN = 'http://127.0.0.1:8787';
const scratch = path.join(os.tmpdir(), 'opencode', 'wedding-album');
const id = process.argv[2];

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const page = await browser.newPage({ viewport: { width: 900, height: 900 }, acceptDownloads: true });
await page.goto(`${ORIGIN}/?e=demo-code`, { waitUntil: 'networkidle' });
await page.click('.tab[data-tab="album"]');
await page.waitForSelector('#grid .tile');

const tile = page.locator(`#grid .tile:has(img[src*="${id}"])`).first();
await tile.scrollIntoViewIfNeeded();
await tile.click();
await page.waitForSelector('#lightbox:not([hidden])');

const n = await page.locator('#lbFrames .swatch').count();
console.log('swatches:', n);
for (let i = 1; i < n; i++) {
  await page.locator('#lbFrames .swatch').nth(i).click();
  await page.waitForFunction(() => {
    const img = document.querySelector('#lbBody img');
    return img && img.src.startsWith('blob:');
  }, { timeout: 20000 });
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 30000 }), page.click('#lbDownload')]);
  const out = path.join(scratch, `frame2-v${i - 1}.png`);
  await dl.saveAs(out);
  console.log('saved', path.basename(out));
}
await browser.close();
