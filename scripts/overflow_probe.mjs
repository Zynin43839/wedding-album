/**
 * Diagnose horizontal overflow on the shoot tab.
 * Uploads 8 gallery files with long names, then measures every element that
 * extends past its container, so the fix targets the real culprit.
 *
 * Run: node scripts/overflow_probe.mjs
 */
import { chromium } from 'playwright-core';
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const CHROME = path.join(process.env.LOCALAPPDATA, 'ms-playwright', 'chromium-1217', 'chrome-win64', 'chrome.exe');
const scratch = path.join(os.tmpdir(), 'opencode', 'wedding-album');
mkdirSync(scratch, { recursive: true });

const BASE = process.env.BASE_URL || 'http://127.0.0.1:8787';
const JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRof' +
    'Hh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAAB' +
    'AAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==',
  'base64'
);

const longNames = [
  'IMG_20261122_143355_ที่โต๊ะเจ้าสาว_รูปหมู่ญาติฝ่ายเจ้าบ่าว_แก้ไขแล้ว.jpg',
  'Screenshot 2026-11-22 at 14.33.55 (final version) (1).jpg',
  '1685-9821-2026-11-22-wedding-ceremony-ورود-عروسی.jpg',
  'photo.jpg',
  'a.jpg',
  'รูปคู่บ่าวสาวหน้าซุ้มดอกไม้บานใหญ่.jpg',
  'VID_very-long-name-that-should-be-truncated-with-ellipsis.jpg',
  'ตารางงาน_Wedding-Run-Down_22-Nov-2026_FINAL_v3.jpg',
];

const files = longNames.map((name, i) => {
  const p = path.join(scratch, `probe-${i}-${name}`);
  writeFileSync(p, JPEG);
  return p;
});

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const page = await browser.newPage({ viewport: { width: 360, height: 800 }, deviceScaleFactor: 2 });
await page.goto(`${BASE}/?e=demo-code`, { waitUntil: 'networkidle' });

await page.fill('#guestName', 'Probe');
await page.setInputFiles('#pickPhoto', files);
await page.waitForSelector('#reviewList .rItem', { timeout: 15000 });
await page.waitForTimeout(600);

const probe = await page.evaluate(() => {
  const out = { viewport: window.innerWidth, docScrollWidth: document.documentElement.scrollWidth, offenders: [] };
  const boxes = ['.review', '.reviewList', '.rItem', '#queueWrap', '.card', '.actions', '.btn'];

  const card = document.querySelector('#reviewWrap');
  const cardBox = card ? card.getBoundingClientRect() : null;

  for (const sel of boxes) {
    for (const el of document.querySelectorAll(sel)) {
      const r = el.getBoundingClientRect();
      if (r.width === 0) continue;
      const overRight = r.right - window.innerWidth;
      const overCard = cardBox ? r.right - cardBox.right : 0;
      if (overRight > 1 || overCard > 1) {
        out.offenders.push({
          sel,
          cls: el.className,
          left: Math.round(r.left),
          right: Math.round(r.right),
          width: Math.round(r.width),
          overRight: Math.round(overRight),
          overCard: Math.round(overCard),
          scrollW: el.scrollWidth,
          clientW: el.clientWidth,
        });
      }
    }
  }
  const gr = document.querySelector('#reviewList');
  if (gr) out.reviewGrid = { scrollW: gr.scrollWidth, clientW: gr.clientWidth, cols: getComputedStyle(gr).gridTemplateColumns };
  return out;
});

console.log(JSON.stringify(probe, null, 2));

await page.screenshot({ path: path.join(scratch, 'overflow-review.png'), fullPage: true });

// also check the queue card after upload starts
await page.click('#reviewSend');
await page.waitForTimeout(1200);
const queueProbe = await page.evaluate(() => {
  const res = { offenders: [] };
  const q = document.querySelector('#queueWrap');
  const qb = q ? q.getBoundingClientRect() : null;
  for (const el of document.querySelectorAll('.qItem, .qName, .progress, .qDel, .qPct')) {
    const r = el.getBoundingClientRect();
    if (r.width === 0) continue;
    const over = qb ? r.right - qb.right : 0;
    if (over > 1 || r.right - window.innerWidth > 1) {
      res.offenders.push({
        cls: el.className,
        right: Math.round(r.right),
        overCard: Math.round(over),
        scrollW: el.scrollWidth,
        clientW: el.clientWidth,
        text: (el.textContent || '').slice(0, 40),
      });
    }
  }
  return res;
});
console.log('QUEUE:', JSON.stringify(queueProbe, null, 2));
await page.screenshot({ path: path.join(scratch, 'overflow-queue.png'), fullPage: true });

await browser.close();
console.log('shots ->', path.join(scratch, 'overflow-review.png'), path.join(scratch, 'overflow-queue.png'));
