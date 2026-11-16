import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  shortDate,
  longDate,
  hashOf,
  kindOf,
  extOf,
  safeName,
  human,
  fmtTime,
  keyFromUrl,
} from '../public/util.js';

test('shortDate prints the card style', () => {
  assert.equal(shortDate('2026-11-22'), '22.11.26');
  assert.equal(shortDate('2026-01-05'), '05.01.26');
  assert.equal(shortDate('not-a-date'), 'not-a-date');
  assert.equal(shortDate(''), '');
});

test('longDate prints the Thai date with the real weekday', () => {
  assert.equal(longDate('2026-11-22'), 'วันอาทิตย์ที่ 22 พฤศจิกายน พ.ศ. 2569');
  assert.equal(longDate('2026-11-16'), 'วันจันทร์ที่ 16 พฤศจิกายน พ.ศ. 2569');
  assert.equal(longDate('2026-01-01'), 'วันพฤหัสบดีที่ 1 มกราคม พ.ศ. 2569');
  assert.equal(longDate('bogus'), 'bogus');
});

test('hashOf is stable and spread out', () => {
  assert.equal(hashOf('1794-abc'), hashOf('1794-abc'));
  assert.notEqual(hashOf('1794-abc'), hashOf('1794-abd'));
  const frames = new Set();
  for (let i = 0; i < 200; i++) frames.add(hashOf(`1794-${i}`) % 6);
  assert.equal(frames.size, 6, 'all six frames get used');
});

test('kindOf trusts the file, not the button', () => {
  // the bug that started it: a photo returned by the video picker
  assert.equal(kindOf({ type: 'image/jpeg', name: 'IMG_1.jpg' }, 'video'), 'photo');
  assert.equal(kindOf({ type: 'video/mp4', name: 'clip.mp4' }, 'photo'), 'video');
  // empty MIME (some Android pickers) falls back to the extension
  assert.equal(kindOf({ type: '', name: 'MOV_1234.mov' }, 'photo'), 'video');
  assert.equal(kindOf({ type: '', name: 'IMG_1234.jpg' }, 'video'), 'photo');
  // neither MIME nor extension -> the hint wins
  assert.equal(kindOf({ type: '', name: 'file' }, 'video'), 'video');
  assert.equal(kindOf({ type: '', name: 'file' }, ''), 'photo');
});

test('extOf prefers the filename and sanitises the MIME fallback', () => {
  assert.equal(extOf({ name: 'IMG_1.JPG', type: 'image/jpeg' }), 'jpg');
  assert.equal(extOf({ name: 'clip.mov', type: '' }), 'mov');
  assert.equal(extOf({ name: 'no-extension', type: 'video/quicktime' }), 'quick');
  assert.equal(extOf({ name: '', type: '' }), 'jpg');
});

test('safeName strips characters a filesystem cannot take', () => {
  assert.equal(safeName('Ann/Boy:2026*?"<>|'), 'AnnBoy2026');
  assert.equal(safeName(''), 'guest');
  assert.equal(safeName('ก'.repeat(40)).length, 30);
});

test('human and fmtTime print what the UI shows', () => {
  assert.equal(human(512), '1 KB');
  assert.equal(human(950 * 1024), '950 KB');
  assert.equal(human(2 * 1048576), '2.0 MB');
  assert.equal(fmtTime(0), '00:00');
  assert.equal(fmtTime(59_400), '00:59');
  assert.equal(fmtTime(60_000), '01:00');
  assert.equal(fmtTime(3_661_000), '61:01');
});

test('keyFromUrl only accepts this Worker media route', () => {
  assert.equal(keyFromUrl('/i/m/1794-abc-t.jpg'), 'm/1794-abc-t.jpg');
  assert.equal(keyFromUrl('/i/m/1794-abc.mp4'), 'm/1794-abc.mp4');
  assert.equal(keyFromUrl('https://cdn.x.com/m/a.jpg'), '');
  assert.equal(keyFromUrl('/i/x/a.jpg'), '');
  assert.equal(keyFromUrl('/i/m/../a.jpg'), '');
  assert.equal(keyFromUrl(undefined), '');
});
