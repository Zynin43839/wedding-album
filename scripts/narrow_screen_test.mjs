/**
 * Does every new message still fit a 320 px phone?
 *
 * 320 px is the narrowest phone a guest might bring (iPhone SE 1st gen, old
 * Android). The copy just got longer and kinder, so this measures, for each error
 * state: no horizontal scroll, no clipped text, and buttons inside the viewport.
 *
 * Run: BASE_URL=... EVENT_CODE=... node scripts/narrow_screen_test.mjs
 */
import { chromium } from 'playwright-core';
import path from 'node:path';
import os from 'node:os';
import { mkdirSync, writeFileSync } from 'node:fs';

const CHROME = path.join(process.env.LOCALAPPDATA, 'ms-playwright', 'chromium-1217', 'chrome-win64', 'chrome.exe');
const ORIGIN = (process.env.BASE_URL || 'https://wedding-album.rj-wedding.workers.dev').replace(/\/+$/, '');
const CODE = process.env.EVENT_CODE || 'demo-code';
const URL_ = `${ORIGIN}/?e=${CODE}`;
const W = 320;

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
const photo = path.join(scratch, 'narrow.jpg');
writeFileSync(photo, JPEG);

/** Every element that carries copy: measure clipping and viewport overflow. */
async function measure(page, selectors) {
  return page.evaluate((sels) => {
    const out = { docScroll: document.documentElement.scrollWidth, items: [] };
    for (const sel of sels) {
      const el = document.querySelector(sel);
      if (!el || el.hidden) continue;
      const r = el.getBoundingClientRect();
      out.items.push({
        sel,
        right: Math.round(r.right),
        width: Math.round(r.width),
        clipped: el.scrollWidth - el.clientWidth > 1,
        text: (el.textContent || '').trim().slice(0, 60),
      });
    }
    return out;
  }, selectors);
}

const browser = await chromium.launch({ executablePath: CHROME, headless: true });

async function withPage(routeHandler, fn) {
  const ctx = await browser.newContext({ viewport: { width: W, height: 640 }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  if (routeHandler) await routeHandler(page, ctx);
  await page.goto(URL_, { waitUntil: 'domcontentloaded' }).catch(() => {});
  await page.waitForTimeout(1200);
  try {
    await fn(page, ctx);
  } finally {
    await ctx.close();
  }
}

function report(name, m, sels) {
  const overflow = m.docScroll > W + 1;
  check(`${name}: no horizontal scroll`, !overflow, `scrollWidth ${m.docScroll}`);
  const clipped = m.items.filter((i) => i.clipped).map((i) => i.sel);
  check(`${name}: no clipped text`, clipped.length === 0, clipped.join(', ') || 'none');
  const outside = m.items.filter((i) => i.right > W + 1).map((i) => i.sel);
  check(`${name}: stays inside the screen`, outside.length === 0, outside.join(', ') || 'none');
  for (const i of m.items) console.log(`      ${i.sel}: ${i.width}px · right ${i.right} · "${i.text}"`);
}

// 1. file too large (413)
await withPage(
  async (page) => {
    await page.route('**/api/upload?**', (r) =>
      r.fulfill({ status: 413, contentType: 'application/json', body: JSON.stringify({ error: 'too_large' }) })
    );
  },
  async (page) => {
    await page.fill('#guestName', 'คุณสมชาย');
    await page.locator('#guestName').blur();
    await page.setInputFiles('#pickPhoto', [photo]);
    await page.waitForTimeout(700);
    await page.locator('#reviewSend').click({ force: true });
    await page.waitForTimeout(2500);
    report('too large', await measure(page, ['#toast', '#queue .qState', '#doneTitle', '#doneSub']));
  }
);

// 2. quota spent (429)
await withPage(
  async (page) => {
    await page.route('**/api/upload?**', (r) => r.fulfill({ status: 429, contentType: 'application/json', body: '{}' }));
  },
  async (page) => {
    await page.fill('#guestName', 'คุณสมชาย');
    await page.locator('#guestName').blur();
    await page.setInputFiles('#pickPhoto', [photo]);
    await page.waitForTimeout(700);
    await page.locator('#reviewSend').click({ force: true });
    await page.waitForTimeout(2500);
    report('quota', await measure(page, ['#toast', '#queue .qState', '#doneTitle']));
  }
);

// 3. offline queue banner (the longest line of copy in the app)
await withPage(
  null,
  async (page, ctx) => {
    await ctx.setOffline(true); // after the shell has loaded
    await page.fill('#guestName', 'คุณสมชาย');
    await page.locator('#guestName').blur();
    await page.setInputFiles('#pickPhoto', [photo, photo, photo]);
    await page.waitForTimeout(700);
    await page.locator('#reviewSend').click({ force: true });
    await page.waitForTimeout(4000);
    report('offline banner', await measure(page, ['#pendingBanner', '#pendingText', '#pendingRetry', '#pendingClear', '#queue .qState']));
    const overlap = await page.evaluate(() => {
      const a = document.querySelector('#pendingRetry').getBoundingClientRect();
      const b = document.querySelector('#pendingClear').getBoundingClientRect();
      return a.right <= b.left + 1 || b.right <= a.left + 1 || a.bottom <= b.top + 1;
    });
    check('offline banner: buttons do not overlap', overlap);
  }
);

// 4. expired album
await withPage(
  async (page) => {
    await page.route('**/api/config**', (r) =>
      r.fulfill({ status: 410, contentType: 'application/json', body: JSON.stringify({ expired: true }) })
    );
  },
  async (page) => {
    await page.waitForTimeout(600);
    report('expired', await measure(page, ['#eventSub', '#toast']));
  }
);

// 5. wrong link
await withPage(null, async (page, ctx) => {
  await page.goto(`${ORIGIN}/?e=wrong-code`, { waitUntil: 'domcontentloaded' }).catch(() => {});
  await page.waitForTimeout(1200);
  report('wrong link', await measure(page, ['#eventSub', '#toast']));
});

// 6. thank-you card tab (longest hint text)
await withPage(null, async (page) => {
  await page.locator('.tab[data-tab="card"]').click({ force: true });
  await page.waitForTimeout(700);
  report('card tab', await measure(page, ['#tab-card .hint', '#cardDownload', '#cardFrames']));
  await page.locator('#cardDownload').click({ force: true });
  await page.waitForTimeout(600);
  report('card without photo', await measure(page, ['#toast']));
});

await browser.close();
console.log('');
console.log(fails.length ? `RESULT: FAIL ${fails.join(', ')}` : 'RESULT: PASS');
process.exit(fails.length ? 1 : 0);
