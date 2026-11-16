/**
 * Single-photo download test.
 *
 * Verifies the contract the owner asked for:
 *   1. the default download is the untouched original (no frame)
 *   2. choosing a frame in the lightbox downloads a PNG that is LARGER than the
 *      photo (the paper margin is added) and still opens fine
 *   3. the ZIP path never bakes a frame in (files come straight from R2)
 *
 * Run: node scripts/frame_download_test.mjs
 */
import { chromium } from 'playwright-core';
import { readFileSync, mkdirSync, statSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

const CHROME = path.join(process.env.LOCALAPPDATA, 'ms-playwright', 'chromium-1217', 'chrome-win64', 'chrome.exe');
const ORIGIN = (process.env.BASE_URL || 'http://127.0.0.1:8787').replace(/\/+$/, '');
const CODE = process.env.EVENT_CODE || 'demo-code';
const scratch = path.join(os.tmpdir(), 'opencode', 'wedding-album');
mkdirSync(scratch, { recursive: true });

const steps = [];
const errs = [];
const step = (name, ok, info = '') => {
  steps.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${info ? ' — ' + info : ''}`);
};

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const page = await browser.newPage({ viewport: { width: 390, height: 844 }, acceptDownloads: true });
await page.addInitScript(() => {
  try {
    delete window.showSaveFilePicker;
  } catch {}
});
page.on('pageerror', (e) => errs.push(String(e.message)));
page.on('console', (m) => m.type() === 'error' && errs.push(m.text()));

const dims = (file) => {
  const out = execFileSync('python', ['-c',
    'import sys;from PIL import Image;im=Image.open(sys.argv[1]);print(im.width,im.height)', file],
    { encoding: 'utf-8' });
  const [w, h] = out.trim().split(/\s+/).map(Number);
  return { w, h };
};

try {
  await page.goto(`${ORIGIN}/?e=${CODE}`, { waitUntil: 'networkidle' });
  await page.click('.tab[data-tab="album"]');
  await page.waitForSelector('#grid .tile', { timeout: 30000 });

  // pick a photo tile (not a video)
  await page.locator('#grid .tile:not(:has(.vbadge))').first().click();
  await page.waitForSelector('#lightbox:not([hidden])');

  const swatches = await page.locator('#lbFrames .swatch').count();
  const none = await page.locator('#lbFrames .swatch[aria-checked="true"]').getAttribute('aria-label');
  step('lightbox offers 7 options and defaults to "ไม่ใส่กรอบ"', swatches === 7 && none === 'ไม่ใส่กรอบ', `${swatches} swatches, default ${none}`);

  // live preview: the picture itself must change before anything is downloaded
  await page.locator('#lbFrames .swatch').nth(1).click();
  await page.waitForFunction(() => {
    const img = document.querySelector('#lbBody img');
    return img && img.src.startsWith('blob:');
  }, { timeout: 20000 });
  const noteVisible = await page.locator('#lbNote').isVisible();
  const noteText = (await page.textContent('#lbNote'))?.trim();
  step('choosing a frame previews it before download', noteVisible && /ตัวอย่างกรอบ/.test(noteText || ''), `note="${noteText}"`);

  await page.locator('#lbFrames .swatch').nth(0).click();
  await page.waitForFunction(() => {
    const img = document.querySelector('#lbBody img');
    return img && !img.src.startsWith('blob:');
  }, { timeout: 10000 });
  step('"ไม่ใส่กรอบ" puts the untouched photo back', true, 'original src restored');

  // 1. plain download
  const [plain] = await Promise.all([page.waitForEvent('download', { timeout: 60000 }), page.click('#lbDownload')]);
  const plainPath = path.join(scratch, 'dl-plain.jpg');
  await plain.saveAs(plainPath);
  const plainSize = statSync(plainPath).size;
  const plainDims = dims(plainPath);
  step('default download is the original file', /\.jpg$/i.test(plain.suggestedFilename()) && plainSize > 0, `${plain.suggestedFilename()} ${plainSize} B ${plainDims.w}x${plainDims.h}`);

  // 2. framed download
  await page.locator('#lbFrames .swatch').nth(1).click(); // v0 perforated
  const [framed] = await Promise.all([page.waitForEvent('download', { timeout: 60000 }), page.click('#lbDownload')]);
  const framedPath = path.join(scratch, 'dl-framed.png');
  await framed.saveAs(framedPath);
  const framedSize = statSync(framedPath).size;
  const header = readFileSync(framedPath).subarray(1, 4).toString('latin1');
  const framedDims = dims(framedPath);
  step(
    'framed download is a PNG with a paper margin',
    /\.png$/i.test(framed.suggestedFilename()) && header === 'PNG' && framedDims.w > plainDims.w && framedDims.h > plainDims.h,
    `${framed.suggestedFilename()} ${framedSize} B ${framedDims.w}x${framedDims.h} vs original ${plainDims.w}x${plainDims.h}`
  );

  // 3. ZIP path must ship untouched files
  await page.click('#lbClose');
  await page.locator('#grid .tile .check').first().click();
  const [zip] = await Promise.all([page.waitForEvent('download', { timeout: 120000 }), page.click('#zipBtn')]);
  const zipPath = path.join(scratch, 'dl-ziptest.zip');
  await zip.saveAs(zipPath);
  let entries = 0;
  let names = [];
  try {
    const out = execFileSync('python', ['-c',
      'import sys,zipfile;z=zipfile.ZipFile(sys.argv[1]);print(z.namelist()[0]);print(len(z.namelist()))',
      zipPath], { encoding: 'utf-8' });
    const [first, count] = out.trim().split(/\r?\n/);
    names = [first];
    entries = Number(count);
  } catch (e) {
    errs.push('zip inspect: ' + String(e.message).slice(0, 80));
  }
  step('ZIP ships the original files (no frame baked in)', entries > 0 && /\.(jpg|mp4)$/i.test(names[0] || ''), `${entries} entries, first ${names[0] || 'n/a'}`);
} catch (e) {
  step('run completed without exception', false, String(e && e.message).slice(0, 160));
} finally {
  await browser.close();
}

console.log();
if (errs.length) {
  console.log('browser errors:');
  for (const e of errs.slice(0, 6)) console.log('  ' + e);
} else {
  console.log('browser errors: none');
}
const bad = steps.filter((s) => !s.ok).length;
console.log(`\n${steps.length - bad}/${steps.length} checks passed`);
process.exit(bad || errs.length ? 1 : 0);
