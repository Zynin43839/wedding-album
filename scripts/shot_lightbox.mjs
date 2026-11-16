/** Screenshot the lightbox with a frame preview, to check the centred bar. */
import { chromium } from 'playwright-core';
import path from 'node:path';

const CHROME = path.join(process.env.LOCALAPPDATA, 'ms-playwright', 'chromium-1217', 'chrome-win64', 'chrome.exe');
const ORIGIN = 'http://127.0.0.1:8787';
const shots = path.join(process.cwd(), 'docs', 'screenshots');

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
for (const [w, h, tag] of [[390, 844, 'mobile'], [1280, 800, 'desktop']]) {
  const page = await browser.newPage({ viewport: { width: w, height: h } });
  await page.goto(`${ORIGIN}/?e=demo-code`, { waitUntil: 'networkidle' });
  await page.click('.tab[data-tab="album"]');
  await page.waitForSelector('#grid .tile');
  await page.locator('#grid .tile:has(img[src*="frametest"])').first().click();  await page.waitForSelector('#lightbox:not([hidden])');
  await page.locator('#lbFrames .swatch').nth(1).click();
  await page.waitForFunction(() => {
    const img = document.querySelector('#lbBody img');
    return img && img.src.startsWith('blob:');
  }, { timeout: 20000 });
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(shots, `lightbox-frame-${tag}.png`) });
  console.log('saved', `lightbox-frame-${tag}.png`);
  await page.close();
}
await browser.close();
