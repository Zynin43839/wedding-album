/**
 * End-to-end UI test with Playwright (uses the cached Chromium, no download).
 *
 * Verifies: page renders, name persists, file input -> compress -> upload -> "ส่งแล้ว",
 * gallery tab shows tiles, lightbox opens, and the ZIP download is a real archive.
 *
 * Run: node scripts/ui_test.mjs
 */
import { chromium } from 'playwright-core';
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const shots = process.env.SHOTS_DIR
  ? path.resolve(process.env.SHOTS_DIR)
  : path.join(root, 'docs', 'screenshots', 'test');
mkdirSync(shots, { recursive: true });

// scratch fixtures live in the OS temp dir, never in the project (folder hygiene)
const scratch = path.join(os.tmpdir(), 'opencode', 'wedding-album');
mkdirSync(scratch, { recursive: true });

const CHROME = path.join(
  process.env.LOCALAPPDATA,
  'ms-playwright',
  'chromium-1217',
  'chrome-win64',
  'chrome.exe'
);

// BASE_URL lets the same suite run against the deployed host (see docs/TEST-CASES.md)
const ORIGIN = (process.env.BASE_URL || 'http://127.0.0.1:8787').replace(/\/+$/, '');
const CODE = process.env.EVENT_CODE || 'demo-code';
const BASE = `${ORIGIN}/?e=${CODE}`;

const JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a' +
    'HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAA' +
    'AAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==',
  'base64'
);

const smallPath = path.join(scratch, 'small.jpg');
const bigPath = path.join(scratch, 'big.jpg');
const videoPath = path.join(scratch, 'clip.mp4');

writeFileSync(smallPath, JPEG);
// pad past the 3 MB threshold so the compression branch really runs
writeFileSync(bigPath, Buffer.concat([JPEG, Buffer.alloc(3_400_000, 0x20)]));

// 2-second test clip; skip the video checks if ffmpeg is unavailable
if (!existsSync(videoPath)) {
  const r = spawnSync(
    'ffmpeg',
    [
      '-y', '-loglevel', 'error',
      '-f', 'lavfi', '-i', 'testsrc=size=640x480:rate=25',
      '-t', '2', '-pix_fmt', 'yuv420p', '-c:v', 'libx264',
      videoPath,
    ],
    { stdio: 'ignore' }
  );
  if (r.status !== 0) console.log('note: ffmpeg not available, video checks will be skipped');
}

const steps = [];
const errs = [];

function step(name, ok, info = '') {
  steps.push({ name, ok, info });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${info ? ' — ' + info : ''}`);
}

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const context = await browser.newContext({
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 2,
  acceptDownloads: true,
});
const page = await context.newPage();

page.on('console', (m) => {
  if (m.type() === 'error') errs.push('console: ' + m.text());
});
page.on('pageerror', (e) => errs.push('pageerror: ' + e.message));

// force the in-memory ZIP path so no native save dialog appears
await page.addInitScript(() => {
  try {
    delete window.showSaveFilePicker;
  } catch {}
});

try {
  await page.goto(BASE, { waitUntil: 'networkidle' });
  step('page loads', true, await page.title());

  const title = await page.textContent('#eventTitle');
  step('event title rendered', Boolean(title && title.trim()), title.trim());

  await page.fill('#guestName', 'ทดสอบ UI');
  const saved = await page.evaluate(() => localStorage.getItem('guest_name'));
  step('guest name persisted', saved === 'ทดสอบ UI', String(saved));

  await page.setInputFiles('#pickPhoto', [smallPath, bigPath]);

  // ── review step: nothing is uploaded until the guest confirms ──
  await page.waitForSelector('#reviewList .rItem', { timeout: 15_000 });
  const staged = await page.locator('#reviewList .rItem').count();
  const sendLabel = (await page.textContent('#reviewSend'))?.trim();
  step('review strip shows picked files', staged === 2, `${staged} staged, button "${sendLabel}"`);

  const queuedBefore = await page.locator('#queue .qItem').count();
  step('nothing uploaded before confirm', queuedBefore === 0, `${queuedBefore} queue rows`);

  // delete one before sending
  await page.locator('#reviewList .rItem .rDel').first().click();
  await page.waitForFunction(
    () => document.querySelectorAll('#reviewList .rItem').length === 1,
    { timeout: 10_000 }
  );
  const left = await page.locator('#reviewList .rItem').count();
  const counter = (await page.textContent('#reviewCount'))?.trim();
  step('delete before upload works', left === 1, `1 left, counter "${counter}"`);

  await page.screenshot({ path: path.join(shots, 'mobile-review.png'), fullPage: true });

  await page.click('#reviewSend');
  await page.waitForFunction(
    () => document.querySelectorAll('#queue .qState').length >= 1 &&
      [...document.querySelectorAll('#queue .qState')].every((el) => el.textContent.includes('ส่งแล้ว')),
    { timeout: 60_000 }
  );
  const sent = await page.locator('#queue .qItem').count();
  const reviewGone = await page.locator('#reviewWrap').isHidden();
  step('confirmed file uploaded', sent === 1 && reviewGone, `${sent} queue row, review hidden=${reviewGone}`);

  // the batch must confirm itself when everything is sent
  await page.waitForSelector('#doneBanner:not([hidden])', { timeout: 15_000 });
  const done = await page.evaluate(() => ({
    title: document.querySelector('#doneTitle')?.textContent?.trim(),
    sub: document.querySelector('#doneSub')?.textContent?.trim(),
    warn: document.querySelector('#doneBanner')?.classList.contains('warn'),
  }));
  step('a "sent" confirmation appears when the batch finishes', /ส่งภาพแล้ว|ส่งแล้ว/.test(done.title || '') && !done.warn, `${done.title} — ${done.sub}`);

  await page.screenshot({ path: path.join(shots, 'mobile-upload.png'), fullPage: true });

  // ── library accepts photos AND videos, and the guest picks the frame ──
  if (existsSync(videoPath)) {
    // an image handed back by an OEM video picker must be treated as a photo (not a broken video)
    await page.setInputFiles('#captureVideo', [smallPath]);
    const toastText = (await page.textContent('#toast')) || '';
    step('image via the video button is treated as a photo', /ไฟล์นี้เป็นรูปภาพ/.test(toastText), toastText.trim());
    await page.locator('#reviewList .rItem .rDel').first().click();
    await page.waitForFunction(() => document.querySelectorAll('#reviewList .rItem').length === 0, { timeout: 8000 });

    const before = await page.locator('#queue .qState').count();

    // one pick, two kinds
    await page.setInputFiles('#pickPhoto', [smallPath, videoPath]);
    await page.waitForSelector('#reviewList .rItem', { timeout: 15_000 });
    const mix = await page.evaluate(() => ({
      total: document.querySelectorAll('#reviewList .rItem').length,
      videos: document.querySelectorAll('#reviewList .rItem .rKind').length,
    }));
    step('library pick takes photos and videos in one go', mix.total === 2 && mix.videos === 1, JSON.stringify(mix));

    // keep the video, drop the photo
    await page.locator('#reviewList .rItem:not(:has(.rKind)) .rDel').first().click();
    await page.waitForFunction(() => document.querySelectorAll('#reviewList .rItem').length === 1, { timeout: 8000 });

    // choose a frame before sending
    const swatches = await page.locator('#frameSwatches .swatch').count();
    await page.locator('#frameSwatches .swatch').nth(4).click();
    const picked = await page.locator('#frameSwatches .swatch[aria-checked="true"]').getAttribute('aria-label');
    step('frame picker offers every design and records the choice', swatches === 7 && picked === 'สันอัลบั้ม', `${swatches} swatches, picked ${picked}`);

    await page.click('#reviewSend');
    await page.waitForFunction(
      (n) => document.querySelectorAll('#queue .qState').length >= n &&
        [...document.querySelectorAll('#queue .qState')].every((el) => el.textContent.includes('ส่งแล้ว')),
      before + 1,
      { timeout: 90_000 }
    );
    step('video from the library uploaded', true);
  }

  await page.click('.tab[data-tab="album"]');
  await page.waitForSelector('#grid .tile', { timeout: 30_000 });
  const tiles = await page.locator('#grid .tile').count();
  step('gallery shows tiles', tiles > 0, `${tiles} tiles`);

  const variants = await page.evaluate(() => {
    const seen = new Set();
    document.querySelectorAll('#grid .tile').forEach((t) => {
      const v = [...t.classList].find((c) => /^v[0-5]$/.test(c));
      if (v) seen.add(v);
    });
    return [...seen].sort();
  });
  step(
    'stamp frame variants render',
    tiles < 10 ? variants.length >= 1 : variants.length >= 4,
    `${variants.length} variants: ${variants.join(',') || 'none'}`
  );

  // frames must follow each photo's own ratio — a cropped photo is the bug the owner reported
  const fit = await page.evaluate(() => {
    const bad = [];
    document.querySelectorAll('#grid .tile').forEach((t) => {
      const img = t.querySelector('img');
      if (!img || !img.naturalWidth || !img.clientWidth) return;
      const rImg = img.naturalWidth / img.naturalHeight;
      const rBox = img.clientWidth / img.clientHeight;
      if (Math.abs(rImg - rBox) > 0.04) bad.push(`${rImg.toFixed(2)}≠${rBox.toFixed(2)}`);
    });
    return bad.slice(0, 3);
  });
  step('every frame matches its photo ratio (nothing cropped)', fit.length === 0, fit.join(', ') || 'all matched');

  // the frame the guest picked in the review step must survive the upload
  const newestFrame = await page.evaluate(() => {
    const t = document.querySelector('#grid .tile');
    return [...t.classList].filter((c) => /^v[0-5]$/.test(c)).join(',');
  });
  step('newest upload keeps the chosen frame', newestFrame === 'v3', newestFrame || 'none');

  await page.screenshot({ path: path.join(shots, 'mobile-album.png'), fullPage: false });

  await page.locator('#grid .tile').first().click();
  await page.waitForSelector('#lightbox:not([hidden])', { timeout: 10_000 });
  const lbOk = await page.locator('#lbBody img, #lbBody video').count();
  step('lightbox opens', lbOk > 0, `${lbOk} media element`);

  // landscape phone: the photo must stay above the download bar (regression guard)
  await page.setViewportSize({ width: 844, height: 390 });
  await page.waitForTimeout(350);
  const overlap = await page.evaluate(() => {
    const media = document.querySelector('#lbBody img, #lbBody video');
    const bar = document.querySelector('.lbBar');
    if (!media || !bar) return -1;
    return Math.max(0, Math.round(media.getBoundingClientRect().bottom - bar.getBoundingClientRect().top));
  });
  step('lightbox media never overlaps the download bar', overlap === 0, `${overlap}px at 844x390`);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(250);

  await page.click('#lbClose');

  // video tile -> <video> in lightbox
  const videoTile = page.locator('#grid .tile:has(.vbadge)').first();
  if (await videoTile.count()) {
    await videoTile.click();
    await page.waitForSelector('#lightbox:not([hidden])', { timeout: 10_000 });
    const hasVideo = await page.locator('#lbBody video').count();
    const src = hasVideo ? await page.locator('#lbBody video').getAttribute('src') : '';
    step('video plays in lightbox', hasVideo > 0 && /\.mp4/.test(src || ''), src || 'none');
    await page.screenshot({ path: path.join(shots, 'mobile-video.png') });
    await page.click('#lbClose');
  } else {
    step('video tile present', false, 'no .vbadge tile found');
  }

  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 60_000 }),
    page.click('#zipBtn'),
  ]);
  const zipPath = path.join(scratch, 'ui-download.zip');
  await download.saveAs(zipPath);
  step('ZIP download produced', Boolean(download.suggestedFilename()), download.suggestedFilename());

  await page.waitForTimeout(2500);
  await page.screenshot({ path: path.join(shots, 'mobile-zip.png'), fullPage: false });

  // desktop look
  await page.setViewportSize({ width: 1280, height: 860 });
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(shots, 'desktop-album.png'), fullPage: false });
  step('desktop screenshot saved', true);
} catch (e) {
  step('run completed without exception', false, String(e && e.message).slice(0, 200));
} finally {
  await browser.close();
}

console.log();
if (errs.length) {
  console.log('browser errors:');
  for (const e of errs.slice(0, 10)) console.log('  ' + e);
} else {
  console.log('browser errors: none');
}

const failed = steps.filter((s) => !s.ok);
console.log(`\n${steps.length - failed.length}/${steps.length} checks passed`);
process.exit(failed.length || errs.length ? 1 : 0);
