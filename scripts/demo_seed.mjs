/**
 * Seed the album with a few generated demo photos (no external files needed).
 * Handy for screenshots and for eyeballing the design with content.
 *
 * Usage: node scripts/demo_seed.mjs [count]
 */
import { chromium } from 'playwright-core';
import path from 'node:path';

const COUNT = Number(process.argv[2] || 6);
const BASE = 'http://127.0.0.1:8787';
const CODE = 'demo-code';

const GUESTS = ['คุณแม่', 'พี่หน่อย', 'น้องมิ้นท์', 'ลุงชัย', 'ป้าแดง', 'เพื่อนเจ้าสาว', 'โต๊ะ 3', 'โต๊ะ 7'];

const CHROME = path.join(
  process.env.LOCALAPPDATA,
  'ms-playwright',
  'chromium-1217',
  'chrome-win64',
  'chrome.exe'
);

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const page = await browser.newPage();
await page.goto(`${BASE}/?e=${CODE}`, { waitUntil: 'domcontentloaded' });

const b64s = await page.evaluate(async (n) => {
  const out = [];
  for (let i = 0; i < n; i++) {
    const W = 1600;
    const H = [1200, 1600, 1067][i % 3];
    const c = document.createElement('canvas');
    c.width = W;
    c.height = H;
    const ctx = c.getContext('2d');

    // warm wedding-ish gradients
    const hues = [
      ['#f3e7d3', '#c9a882'],
      ['#efe0dc', '#b98b8f'],
      ['#e6e9dd', '#8fa189'],
      ['#f6ece0', '#d8b98d'],
      ['#ece3ea', '#a98b9c'],
      ['#e9e4d8', '#a89a7d'],
    ][i % 6];

    const g = ctx.createLinearGradient(0, 0, W, H);
    g.addColorStop(0, hues[0]);
    g.addColorStop(1, hues[1]);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);

    // soft bokeh
    for (let k = 0; k < 26; k++) {
      const r = 40 + Math.random() * 220;
      const rg = ctx.createRadialGradient(Math.random() * W, Math.random() * H, 0, Math.random() * W, Math.random() * H, r);
      rg.addColorStop(0, 'rgba(255,255,255,.55)');
      rg.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = rg;
      ctx.beginPath();
      ctx.arc(Math.random() * W, Math.random() * H, r, 0, Math.PI * 2);
      ctx.fill();
    }

    // a couple of petals
    for (let k = 0; k < 14; k++) {
      ctx.save();
      ctx.translate(Math.random() * W, Math.random() * H);
      ctx.rotate(Math.random() * Math.PI);
      ctx.fillStyle = `rgba(255,${230 + Math.random() * 25 | 0},${235 + Math.random() * 20 | 0},.5)`;
      ctx.beginPath();
      ctx.ellipse(0, 0, 26, 14, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    // subtle vignette
    const vg = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.25, W / 2, H / 2, Math.max(W, H) * 0.75);
    vg.addColorStop(0, 'rgba(0,0,0,0)');
    vg.addColorStop(1, 'rgba(60,40,30,.22)');
    ctx.fillStyle = vg;
    ctx.fillRect(0, 0, W, H);

    const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.9));
    const buf = await blob.arrayBuffer();
    const bytes = new Uint8Array(buf);
    let s = '';
    for (let p = 0; p < bytes.length; p += 0x8000) {
      s += String.fromCharCode.apply(null, bytes.subarray(p, p + 0x8000));
    }
    out.push(btoa(s));
  }
  return out;
}, COUNT);

let ok = 0;
for (let i = 0; i < b64s.length; i++) {
  const name = GUESTS[i % GUESTS.length];
  const id = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  const url = `${BASE}/api/upload?e=${CODE}&id=${id}&kind=photo&ext=jpg&name=${encodeURIComponent(name)}`;

  const res = await page.evaluate(
    async ({ url, b64 }) => {
      const bin = atob(b64);
      const arr = new Uint8Array(bin.length);
      for (let k = 0; k < bin.length; k++) arr[k] = bin.charCodeAt(k);
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'image/jpeg' },
        body: arr,
      });
      return r.status;
    },
    { url, b64: b64s[i] }
  );

  if (res === 200) ok++;
  // stagger timestamps so ordering looks natural
  await page.waitForTimeout(60);
}

console.log(`seeded ${ok}/${b64s.length} demo photos as ${GUESTS.slice(0, b64s.length).join(', ')}`);
await browser.close();
process.exit(ok === b64s.length ? 0 : 1);
