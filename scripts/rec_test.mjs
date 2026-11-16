/**
 * In-page video recorder test (Chromium fake camera, no real hardware).
 *
 * Verifies the flow the phone failed at: press "อัดวิดีโอ" -> the page opens its own
 * camera, record for ~2 s, stop -> a video lands in "ตรวจก่อนส่ง", upload -> the clip
 * appears in the album as type=video and plays in the lightbox.
 *
 * Run: node scripts/rec_test.mjs   (needs the dev server or BASE_URL)
 */
import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

const CHROME = path.join(process.env.LOCALAPPDATA, 'ms-playwright', 'chromium-1217', 'chrome-win64', 'chrome.exe');
const ORIGIN = (process.env.BASE_URL || 'http://127.0.0.1:8787').replace(/\/+$/, '');
const CODE = process.env.EVENT_CODE || 'demo-code';
const BASE = `${ORIGIN}/?e=${CODE}`;
const shots = process.env.SHOTS_DIR || path.join(process.cwd(), 'docs', 'screenshots', 'test');
mkdirSync(shots, { recursive: true });

const steps = [];
const errs = [];
const step = (name, ok, info = '') => {
  steps.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${info ? ' — ' + info : ''}`);
};

const browser = await chromium.launch({
  executablePath: CHROME,
  headless: true,
  args: [
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
    '--autoplay-policy=no-user-gesture-required',
  ],
});

const context = await browser.newContext({
  viewport: { width: 390, height: 844 },
  permissions: ['camera', 'microphone'],
});
const page = await context.newPage();
page.on('pageerror', (e) => errs.push(String(e.message)));
page.on('console', (m) => m.type() === 'error' && errs.push(m.text()));

try {
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.fill('#guestName', 'RecTest');

  await page.click('#recBtn');
  await page.waitForSelector('#recWrap:not([hidden])', { timeout: 15_000 });
  const live = await page.evaluate(() => {
    const v = document.querySelector('#recPreview');
    return { stream: !!v.srcObject, playing: !v.paused, w: v.videoWidth, h: v.videoHeight };
  });
  step('recorder opens with a live camera preview', live.stream && live.w > 0, `${live.w}x${live.h} playing=${live.playing}`);
  await page.screenshot({ path: path.join(shots, 'mobile-recorder.png') });

  await page.click('#recToggle');
  await page.waitForTimeout(2200);
  const btnLabel = (await page.textContent('#recToggle'))?.trim();
  step('recording state shows a stop button', btnLabel === 'หยุดอัด', btnLabel);
  await page.click('#recToggle');

  await page.waitForSelector('#reviewList .rItem', { timeout: 20_000 });
  const staged = await page.evaluate(() => {
    const li = document.querySelector('#reviewList .rItem');
    return { hasVideo: !!li?.querySelector('video'), kind: li?.querySelector('.rKind') ? 'video' : 'photo' };
  });
  step('recorded clip lands in the review strip as video', staged.hasVideo && staged.kind === 'video', JSON.stringify(staged));

  const codec = await page.evaluate(() => {
    const list = ['video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'video/mp4', 'video/webm;codecs=h264', 'video/webm;codecs=vp8', 'video/webm'];
    return list.filter((t) => {
      try {
        return MediaRecorder.isTypeSupported(t);
      } catch {
        return false;
      }
    });
  });
  console.log('   supported record types:', codec.join(' | ') || '(none)');

  await page.click('#reviewSend');
  await page.waitForFunction(
    () => {
      const s = document.querySelector('#queue .qState');
      return s && s.textContent.includes('ส่งแล้ว');
    },
    { timeout: 120_000 }
  );
  step('clip uploaded', true);

  await page.click('.tab[data-tab="album"]');
  await page.waitForSelector('#grid .tile', { timeout: 30_000 });
  const tile = page.locator('#grid .tile:has(.vbadge)').first();
  step('album shows a video tile', (await tile.count()) > 0);
  if (await tile.count()) {
    await tile.click();
    await page.waitForSelector('#lightbox:not([hidden])', { timeout: 10_000 });
    const src = await page.locator('#lbBody video').getAttribute('src');
    const playable = await page.evaluate(async () => {
      const v = document.querySelector('#lbBody video');
      if (!v) return 'no video element';
      if (v.readyState >= 1) return 'metadata loaded';
      await new Promise((r) => {
        v.addEventListener('loadedmetadata', r, { once: true });
        v.addEventListener('error', r, { once: true });
        setTimeout(r, 8000);
      });
      return v.error ? 'error code ' + v.error.code : 'metadata loaded';
    });
    step('recorded clip is playable in the lightbox', playable === 'metadata loaded', `${src} — ${playable}`);
    await page.click('#lbClose');
  }
} catch (e) {
  step('run completed without exception', false, String(e && e.message).slice(0, 160));
} finally {
  await browser.close();
}

console.log();
if (errs.length) {
  console.log('browser errors:');
  for (const e of errs.slice(0, 8)) console.log('  ' + e);
} else {
  console.log('browser errors: none');
}

const bad = steps.filter((s) => !s.ok).length;
console.log(`\n${steps.length - bad}/${steps.length} checks passed`);
process.exit(bad || errs.length ? 1 : 0);
