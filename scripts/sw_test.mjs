/**
 * Does the service worker make a repeat visit cheaper once the HTTP cache is gone?
 *
 *   load -> wait for control -> open album (fills the media cache)
 *        -> clear the HTTP cache only -> reload -> open album again
 *
 * The second open should cost one request (the API list) instead of four.
 */
import { chromium } from 'playwright-core';
import path from 'node:path';

const CHROME = path.join(process.env.LOCALAPPDATA, 'ms-playwright', 'chromium-1217', 'chrome-win64', 'chrome.exe');
const ORIGIN = (process.env.BASE_URL || 'https://wedding-album.rj-wedding.workers.dev').replace(/\/+$/, '');
const CODE = process.env.EVENT_CODE || 'demo-code';
const URL_ = `${ORIGIN}/?e=${CODE}`;
const HOST = new URL(ORIGIN).host;

const fails = [];
const check = (n, ok, i = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${i ? `  [${i}]` : ''}`);
  if (!ok) fails.push(n);
};

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
const page = await ctx.newPage();
const cdp = await ctx.newCDPSession(page);
await cdp.send('Network.enable');

let count = 0;
// Count only requests that actually leave the browser: a request answered by
// the service worker still fires a request event, so counting events would say
// the cache did nothing.
page.on('response', (r) => {
  const u = new URL(r.url());
  if (u.host !== HOST) return;
  if (!u.pathname.startsWith('/api/') && !u.pathname.startsWith('/i/')) return;
  if (r.fromServiceWorker()) return;
  count += 1;
});

await page.goto(URL_, { waitUntil: 'networkidle' });

// wait for the worker to take control (it registers at boot)
let controlled = false;
for (let i = 0; i < 20 && !controlled; i++) {
  controlled = await page.evaluate(() => Boolean(navigator.serviceWorker.controller));
  if (!controlled) await page.waitForTimeout(300);
}
check('service worker controls the page', controlled);

// first album open: fills the media cache, costs the normal 3 requests
count = 0;
await page.locator('.tab[data-tab="album"]').click({ force: true });
await page.waitForTimeout(4000);
const firstOpen = count;
console.log(`      first album open: ${firstOpen} requests`);
const cached = await page.evaluate(async () => (await caches.open('wedding-media-v3')).keys().then((k) => k.length));
check('photos were cached in Cache Storage', cached > 0, `${cached} entries`);

// now drop the HTTP cache only
await cdp.send('Network.clearBrowserCache');
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(800);

count = 0;
await page.locator('.tab[data-tab="album"]').click({ force: true });
await page.waitForTimeout(4000);
const secondOpen = count;
console.log(`      second album open after clearing the HTTP cache: ${secondOpen} requests`);

const tiles = await page.locator('#grid .tile img').count();
check('album still renders from the service worker', tiles > 0, `${tiles} tiles`);
check('repeat open matches the measured floor', secondOpen <= firstOpen, `${firstOpen} -> ${secondOpen}`);
check('repeat open costs at most one request', secondOpen <= 1, `${secondOpen} requests`);

console.log('');
console.log(fails.length ? `RESULT: FAIL ${fails.join(', ')}` : 'RESULT: PASS');
await browser.close();
process.exit(fails.length ? 1 : 0);
