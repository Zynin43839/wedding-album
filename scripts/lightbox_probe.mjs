/**
 * Measure whether the lightbox image is covered by the download bar.
 * Checks several viewports (phone portrait, phone landscape, desktop) and
 * reports bounding boxes plus the amount of overlap.
 *
 * Run: node scripts/lightbox_probe.mjs
 */
import { chromium } from 'playwright-core';
import path from 'node:path';
import os from 'node:os';

const CHROME = path.join(process.env.LOCALAPPDATA, 'ms-playwright', 'chromium-1217', 'chrome-win64', 'chrome.exe');
const BASE = (process.env.BASE_URL || 'http://127.0.0.1:8787').replace(/\/+$/, '') + '/?e=' + (process.env.EVENT_CODE || 'demo-code');
const scratch = path.join(os.tmpdir(), 'opencode', 'wedding-album');

const browser = await chromium.launch({ executablePath: CHROME, headless: true });

for (const [w, h, label] of [
  [390, 844, 'phone-portrait'],
  [844, 390, 'phone-landscape'],
  [1280, 800, 'laptop'],
  [1920, 800, 'wide'],
]) {
  const page = await browser.newPage({ viewport: { width: w, height: h } });
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.click('.tab[data-tab="album"]');
  await page.waitForSelector('#grid .tile', { timeout: 30000 });
  await page.locator('#grid .tile').first().click();
  await page.waitForSelector('#lightbox:not([hidden])');
  await page.waitForTimeout(500);

  const m = await page.evaluate(() => {
    const r = (sel) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const b = el.getBoundingClientRect();
      return { top: Math.round(b.top), bottom: Math.round(b.bottom), left: Math.round(b.left), right: Math.round(b.right), h: Math.round(b.height), w: Math.round(b.width) };
    };
    const img = r('#lbBody img') || r('#lbBody video');
    const bar = r('.lbBar');
    const body = r('#lbBody');
    const vh = window.innerHeight;
    return {
      img,
      bar,
      body,
      vh,
      overlapPx: img && bar ? Math.max(0, img.bottom - bar.top) : null,
      imgBelowViewport: img ? img.bottom - vh : null,
      scroll: { bodyScrollH: document.querySelector('#lbBody')?.scrollHeight, bodyClientH: document.querySelector('#lbBody')?.clientHeight },
    };
  });
  console.log(`${label} ${w}x${h}`);
  console.log('  img :', JSON.stringify(m.img));
  console.log('  bar :', JSON.stringify(m.bar));
  console.log('  body:', JSON.stringify(m.body));
  console.log('  overlap with bar:', m.overlapPx, 'px | img bottom past viewport:', m.imgBelowViewport, 'px | scroll', m.scroll.bodyScrollH, '/', m.scroll.bodyClientH);
  await page.screenshot({ path: path.join(scratch, `lightbox-${label}.png`) });
  await page.close();
}

await browser.close();
console.log('shots in', scratch);
