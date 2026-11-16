/**
 * Realistic compression test.
 *
 * 1. Generates a genuine 3200x2400 noisy JPEG in the browser (~several MB).
 * 2. Uploads it through the real UI with the real prep pipeline.
 * 3. Reads the stored object size back from /api/list and asserts it shrank.
 *
 * Run: node scripts/prep_test.mjs
 */
import { chromium } from 'playwright-core';
import { writeFileSync, statSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const CHROME = path.join(process.env.LOCALAPPDATA, 'ms-playwright', 'chromium-1217', 'chrome-win64', 'chrome.exe');
const root = process.cwd();
const BASE = 'http://127.0.0.1:8787/?e=demo-code';
const scratch = path.join(os.tmpdir(), 'opencode', 'wedding-album');
mkdirSync(scratch, { recursive: true });
const fixture = path.join(scratch, 'real.jpg');

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const page = await browser.newPage({ viewport: { width: 390, height: 844 }, acceptDownloads: true });

const errs = [];
page.on('pageerror', (e) => errs.push(String(e.message)));
page.on('console', (m) => m.type() === 'error' && errs.push(m.text()));

await page.goto(BASE, { waitUntil: 'networkidle' });

/* ── 1. build a realistic large photo ─────────────────────────── */
const b64 = await page.evaluate(async () => {
  const W = 3200;
  const H = 2400;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const ctx = c.getContext('2d');

  const grad = ctx.createLinearGradient(0, 0, W, H);
  grad.addColorStop(0, '#7a5230');
  grad.addColorStop(1, '#20405e');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, W, H);

  // noise + shapes so the JPEG cannot compress to nothing
  const img = ctx.getImageData(0, 0, W, H);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const n = (Math.random() * 90) | 0;
    d[i] = Math.min(255, d[i] + n);
    d[i + 1] = Math.min(255, d[i + 1] + ((n * 7) % 90));
    d[i + 2] = Math.min(255, d[i + 2] + ((n * 13) % 90));
  }
  ctx.putImageData(img, 0, 0);

  for (let i = 0; i < 40; i++) {
    ctx.beginPath();
    ctx.arc(Math.random() * W, Math.random() * H, 40 + Math.random() * 260, 0, Math.PI * 2);
    ctx.fillStyle = `hsl(${(Math.random() * 360) | 0} 70% 55% / .55)`;
    ctx.fill();
  }

  const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.95));
  const buf = await blob.arrayBuffer();
  let s = '';
  const bytes = new Uint8Array(buf);
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + step));
  }
  return btoa(s);
});

writeFileSync(fixture, Buffer.from(b64, 'base64'));
const originalSize = statSync(fixture).size;
console.log(`fixture: 3200x2400 JPEG, ${(originalSize / 1048576).toFixed(2)} MB on disk`);

/* ── 2. upload through the real UI (review step first) ────────── */
await page.fill('#guestName', 'PrepTest');
await page.setInputFiles('#pickPhoto', [fixture]);
await page.waitForSelector('#reviewList .rItem', { timeout: 20_000 });
await page.click('#reviewSend');
await page.waitForFunction(
  () => {
    const s = document.querySelector('#queue .qState');
    return s && s.textContent.includes('ส่งแล้ว');
  },
  { timeout: 120_000 }
);
console.log('upload finished');

/* ── 3. read the stored size back ─────────────────────────────── */
const data = await page.evaluate(async () => {
  const r = await fetch('/api/list?e=demo-code');
  return r.json();
});

const mine = data.items.find((i) => i.guest === 'PrepTest');
if (!mine) {
  console.log('FAIL: uploaded item not found in album');
  process.exit(1);
}

const stored = mine.size;
const ratio = stored / originalSize;

console.log(`original : ${(originalSize / 1048576).toFixed(2)} MB`);
console.log(`stored   : ${(stored / 1048576).toFixed(2)} MB`);
console.log(`ratio    : ${(ratio * 100).toFixed(1)}%`);

const checks = [
  ['stored smaller than original', stored < originalSize, `${(ratio * 100).toFixed(1)}%`],
  ['stored under 2.5 MB target', stored < 2.5 * 1048576, `${(stored / 1048576).toFixed(2)} MB`],
  ['no browser errors', errs.length === 0, errs.slice(0, 3).join(' | ') || 'none'],
];

console.log();
let bad = 0;
for (const [name, ok, info] of checks) {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name} — ${info}`);
  if (!ok) bad++;
}

await browser.close();
console.log(`\n${checks.length - bad}/${checks.length} checks passed`);
process.exit(bad ? 1 : 0);
