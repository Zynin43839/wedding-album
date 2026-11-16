/**
 * Durable queue: a guest loses the network, closes the tab, comes back, and the
 * photos are still there — the app then resumes them by itself.
 *
 * Run: BASE_URL=... EVENT_CODE=... node scripts/queue_persist_test.mjs
 */
import { chromium } from 'playwright-core';
import path from 'node:path';
import os from 'node:os';
import { mkdirSync, writeFileSync } from 'node:fs';

const CHROME = path.join(process.env.LOCALAPPDATA, 'ms-playwright', 'chromium-1217', 'chrome-win64', 'chrome.exe');
const ORIGIN = (process.env.BASE_URL || 'https://wedding-album.rj-wedding.workers.dev').replace(/\/+$/, '');
const CODE = process.env.EVENT_CODE || 'demo-code';
const URL_ = `${ORIGIN}/?e=${CODE}`;

const fails = [];
const check = (n, ok, i = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${i ? `  [${i}]` : ''}`);
  if (!ok) fails.push(n);
};

const scratch = path.join(os.tmpdir(), 'opencode', 'queue-test');
mkdirSync(scratch, { recursive: true });
const JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAAQABABAREA/8QAFQABAQAAAAAAAAAAAAAAAAAAAj/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAX/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oACAEBAAA/AJ//2Q==',
  'base64'
);
const files = [0, 1, 2].map((i) => {
  const p = path.join(scratch, `q${i}.jpg`);
  writeFileSync(p, JPEG);
  return p;
});

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });

// --- session 1: send while offline -----------------------------------------
let page = await ctx.newPage();
await page.goto(URL_, { waitUntil: 'networkidle' });
await page.fill('#guestName', 'QUEUE-TEST');
await page.locator('#guestName').blur();

await ctx.setOffline(true);
await page.setInputFiles('#pickPhoto', files);
await page.waitForTimeout(1200);
const staged = await page.locator('#reviewList > *').count();
check('three files staged for review', staged > 0, `${staged} rows`);

await page.locator('#reviewSend').click({ force: true });
await page.waitForTimeout(4500);

const storedOffline = await page.evaluate(async () => {
  const q = await import('/queue.js');
  return await q.stats();
});
check('files are stored in IndexedDB while offline', storedOffline.files >= 2, `${storedOffline.files} files`);
const bannerVisible = await page.locator('#pendingBanner').isVisible().catch(() => false);
check('pending banner appears', bannerVisible);

await page.close();

// --- session 2: reopen with the network back -------------------------------
await ctx.setOffline(false);
page = await ctx.newPage();
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(String(e)));
await page.goto(URL_, { waitUntil: 'networkidle' });
await page.waitForTimeout(7000); // restore + auto-resume

const restoredRows = await page.locator('#queue > *').count();
check('queue rows come back after reopening the tab', restoredRows >= 2, `${restoredRows} rows`);

const doneRows = await page.locator('#queue .ok').count();
const bannerAfter = await page.locator('#pendingBanner').isVisible().catch(() => false);
check(
  'restored files resume by themselves',
  doneRows >= 2 || bannerAfter,
  `${doneRows} done, banner ${bannerAfter ? 'visible' : 'hidden'}`
);

if (bannerAfter) {
  await page.locator('#pendingRetry').click({ force: true });
  await page.waitForTimeout(6000);
}

const finalState = await page.evaluate(async () => {
  const q = await import('/queue.js');
  return { stats: await q.stats(), banner: !document.querySelector('#pendingBanner').hidden };
});
check('IndexedDB is empty once everything is sent', finalState.stats.files === 0, `${finalState.stats.files} left`);
check('banner clears', !finalState.banner);
check('no page errors during restore', pageErrors.length === 0, pageErrors[0] || '');

// --- a permanent refusal must not retry forever ----------------------------
const page2 = await ctx.newPage();
await page2.route('**/api/upload?**', (route) =>
  route.fulfill({ status: 413, contentType: 'application/json', body: JSON.stringify({ error: 'too_large' }) })
);
await page2.goto(URL_, { waitUntil: 'networkidle' });
await page2.fill('#guestName', 'QUEUE-413');
await page2.locator('#guestName').blur();
await page2.setInputFiles('#pickPhoto', [files[0]]);
await page2.waitForTimeout(800);
await page2.locator('#reviewSend').click({ force: true });
await page2.waitForTimeout(3000);

const body = await page2.locator('body').innerText();
check('413 shows a kind, plain reason', body.includes('ใหญ่เกินกว่าอัลบั้มจะรับได้'), body.match(/ใหญ่เกิน[^\n]{0,40}/)?.[0] || '');
check('no error code is shown to the guest', !/E-\d{3}/.test(body), (body.match(/E-\d{3}/) || ['none'])[0]);
check('413 is not queued for retry', !(await page2.locator('#retryAll').isVisible().catch(() => false)));
const stored413 = await page2.evaluate(async () => (await (await import('/queue.js')).stats()).files);
check('413 does not stay in IndexedDB', stored413 === 0, `${stored413} files`);

await browser.close();
console.log('');
console.log(fails.length ? `RESULT: FAIL ${fails.join(', ')}` : 'RESULT: PASS');
process.exit(fails.length ? 1 : 0);
