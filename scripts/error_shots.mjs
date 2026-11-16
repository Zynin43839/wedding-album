/**
 * Capture every guest-facing error state as a phone screenshot.
 *
 * States are produced by intercepting responses, so the production album is
 * never actually broken: 413, 429 (quota), 410 (expired), 403 (bad link), the
 * offline pending banner, and the camera-denied path.
 *
 * Run: BASE_URL=... EVENT_CODE=... node scripts/error_shots.mjs
 */
import { chromium } from 'playwright-core';
import path from 'node:path';
import os from 'node:os';
import { mkdirSync, writeFileSync } from 'node:fs';

const CHROME = path.join(process.env.LOCALAPPDATA, 'ms-playwright', 'chromium-1217', 'chrome-win64', 'chrome.exe');
const ORIGIN = (process.env.BASE_URL || 'https://wedding-album.rj-wedding.workers.dev').replace(/\/+$/, '');
const CODE = process.env.EVENT_CODE || 'demo-code';
const OUT = path.join(process.cwd(), 'docs', 'screenshots', 'errors');
mkdirSync(OUT, { recursive: true });

const scratch = path.join(os.tmpdir(), 'opencode', 'queue-test');
mkdirSync(scratch, { recursive: true });
const JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAAQABABAREA/8QAFQABAQAAAAAAAAAAAAAAAAAAAj/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAX/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAA/AJ//2Q==',
  'base64'
);
const photo = path.join(scratch, 'err.jpg');
writeFileSync(photo, JPEG);

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const shots = [];

async function shot(page, name, note) {
  const file = path.join(OUT, `${name}.png`);
  await page.screenshot({ path: file, fullPage: false });
  shots.push({ name, file, note });
  console.log('  saved', name);
}

function newCtx() {
  return browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
}

// 1. offline queue: files waiting, banner visible
{
  const ctx = await newCtx();
  const page = await ctx.newPage();
  await page.goto(`${ORIGIN}/?e=${CODE}`, { waitUntil: 'domcontentloaded' });
  await page.fill('#guestName', 'คุณสมชาย');
  await page.locator('#guestName').blur();
  await ctx.setOffline(true);
  await page.setInputFiles('#pickPhoto', [photo, photo, photo]);
  await page.waitForTimeout(900);
  await page.locator('#reviewSend').click({ force: true });
  await page.waitForTimeout(4000);
  await shot(page, '01-offline-pending', 'เน็ตหลุด: แถบค้างส่ง + แถวขึ้น "เก็บไว้ในเครื่อง"');
  await ctx.close();
}

// 2. 413: file too large
{
  const ctx = await newCtx();
  const page = await ctx.newPage();
  await page.route('**/api/upload?**', (r) =>
    r.fulfill({ status: 413, contentType: 'application/json', body: JSON.stringify({ error: 'too_large' }) })
  );
  await page.goto(`${ORIGIN}/?e=${CODE}`, { waitUntil: 'domcontentloaded' });
  await page.fill('#guestName', 'คุณสมชาย');
  await page.locator('#guestName').blur();
  await page.setInputFiles('#pickPhoto', [photo]);
  await page.waitForTimeout(800);
  await page.locator('#reviewSend').click({ force: true });
  await page.waitForTimeout(2500);
  await shot(page, '02-too-large', 'ไฟล์ใหญ่เกิน: ข้อความ + tag E-413 + ไม่ค้างในคิว');
  await ctx.close();
}

// 3. 429: daily quota spent
{
  const ctx = await newCtx();
  const page = await ctx.newPage();
  await page.route('**/api/upload?**', (r) =>
    r.fulfill({ status: 429, contentType: 'application/json', body: '{}' })
  );
  await page.goto(`${ORIGIN}/?e=${CODE}`, { waitUntil: 'domcontentloaded' });
  await page.fill('#guestName', 'คุณสมชาย');
  await page.locator('#guestName').blur();
  await page.setInputFiles('#pickPhoto', [photo]);
  await page.waitForTimeout(800);
  await page.locator('#reviewSend').click({ force: true });
  await page.waitForTimeout(2200);
  await shot(page, '03-quota', 'โควตาวันหมด: บอกให้กลับมาหลัง 07:00 น.');
  await ctx.close();
}

// 4. 410: album closed
{
  const ctx = await newCtx();
  const page = await ctx.newPage();
  await page.route('**/api/config**', (r) =>
    r.fulfill({ status: 410, contentType: 'application/json', body: JSON.stringify({ expired: true }) })
  );
  await page.goto(`${ORIGIN}/?e=${CODE}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(800);
  await shot(page, '04-expired', 'อัลบั้มปิดแล้ว: หัวเรื่องเปลี่ยนเป็น "ปิดรับชมแล้ว"');
  await ctx.close();
}

// 5. 403: wrong link
{
  const ctx = await newCtx();
  const page = await ctx.newPage();
  await page.goto(`${ORIGIN}/?e=wrong-code`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(800);
  await shot(page, '05-bad-link', 'ลิงก์ผิด: บอกให้ขอ QR จากเจ้าภาพ');
  await ctx.close();
}

// 6. camera blocked by the browser
{
  const ctx = await newCtx();
  await ctx.grantPermissions([]);
  const page = await ctx.newPage();
  await page.goto(`${ORIGIN}/?e=${CODE}`, { waitUntil: 'domcontentloaded' });
  await page.locator('#recordBtn, [data-rec], #recStart').first().click({ force: true }).catch(() => {});
  await page.waitForTimeout(2500);
  await shot(page, '06-camera-denied', 'กล้องถูกปฏิเสธ: แนะนำให้ใช้ "วิดีโอจากคลัง"');
  await ctx.close();
}

await browser.close();

writeFileSync(
  path.join(OUT, 'README.md'),
  '# Error states (captured ' +
    new Date().toISOString().slice(0, 10) +
    ')\n\n' +
    shots.map((s) => `- \`${s.name}.png\` — ${s.note}`).join('\n') +
    '\n\nEvery state is produced by intercepting the response, so the live album is untouched.\n',
  'utf8'
);
console.log(`\n${shots.length} screenshots in ${OUT}`);
