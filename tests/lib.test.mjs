import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseKey,
  mediaUrl,
  parseRange,
  groupObjects,
  keyFromUrl,
  VIDEO_EXT,
} from '../src/lib.js';

test('parseKey reads the four variants', () => {
  assert.deepEqual(parseKey('m/1794-abc.jpg'), { id: '1794-abc', variant: 'main', ext: 'jpg' });
  assert.deepEqual(parseKey('m/1794-abc-t.jpg'), { id: '1794-abc', variant: 'thumb', ext: 'jpg' });
  assert.deepEqual(parseKey('m/1794-abc-p.jpg'), { id: '1794-abc', variant: 'poster', ext: 'jpg' });
  assert.deepEqual(parseKey('m/1794-abc.MP4'), { id: '1794-abc', variant: 'main', ext: 'mp4' });
});

test('parseKey rejects broken keys', () => {
  for (const bad of ['', 'x/1.jpg', 'm/noext', 'm/.jpg', 'm/-t.jpg', null, undefined]) {
    assert.equal(parseKey(bad), null, `expected null for ${JSON.stringify(bad)}`);
  }
});

test('mediaUrl honours PUBLIC_MEDIA_BASE and trims slashes', () => {
  assert.equal(mediaUrl({}, 'm/a.jpg'), '/i/m/a.jpg');
  assert.equal(mediaUrl({ PUBLIC_MEDIA_BASE: '' }, 'm/a.jpg'), '/i/m/a.jpg');
  assert.equal(mediaUrl({ PUBLIC_MEDIA_BASE: 'https://cdn.x.com/' }, 'm/a.jpg'), 'https://cdn.x.com/m/a.jpg');
  assert.equal(mediaUrl({ PUBLIC_MEDIA_BASE: 'https://cdn.x.com' }, 'm/a.jpg'), 'https://cdn.x.com/m/a.jpg');
});

test('parseRange handles every browser form', () => {
  assert.equal(parseRange(null, 1000), null);
  assert.deepEqual(parseRange('bytes=0-99', 1000), { start: 0, end: 99 });
  assert.deepEqual(parseRange('bytes=500-', 1000), { start: 500, end: 999 });
  assert.deepEqual(parseRange('bytes=-100', 1000), { start: 900, end: 999 });
  // end past the object is clamped, which is what Safari expects
  assert.deepEqual(parseRange('bytes=900-5000', 1000), { start: 900, end: 999 });
  // a one-byte object
  assert.deepEqual(parseRange('bytes=0-0', 1), { start: 0, end: 0 });
});

test('parseRange rejects the ranges that must not stream', () => {
  assert.equal(parseRange('bytes=1000-', 1000), 'unsatisfiable');
  assert.equal(parseRange('bytes=-0', 1000), 'unsatisfiable');
  assert.equal(parseRange('bytes=500-100', 1000), 'invalid');
  assert.equal(parseRange('items=0-1', 1000), 'invalid');
  assert.equal(parseRange('bytes=abc-def', 1000), 'invalid');
  assert.equal(parseRange('bytes=-', 1000), 'invalid');
});

test('groupObjects groups variants, sorts newest first and hides orphans', () => {
  const objects = [
    { key: 'm/2000-b.jpg', size: 100, customMetadata: { guest: 'Ann' } },
    { key: 'm/3000-c-t.jpg', size: 20 }, // thumb without a main file -> hidden
    { key: 'm/2000-b-t.jpg', size: 10 },
    { key: 'm/4000-d.mp4', size: 5000, customMetadata: { guest: 'Boy', frame: 'v3' } },
    { key: 'm/4000-d-p.jpg', size: 30 },
    { key: 'garbage', size: 1 },
  ];
  const items = groupObjects(objects, {});

  assert.equal(items.length, 2, 'only the two complete items survive');
  assert.deepEqual(items.map((i) => i.id), ['4000-d', '2000-b'], 'newest first');

  const [video, photo] = items;
  assert.equal(video.type, 'video');
  assert.equal(video.frame, 'v3');
  assert.equal(video.url, '/i/m/4000-d.mp4');
  assert.equal(video.thumb, '/i/m/4000-d-p.jpg');
  assert.equal(video.guest, 'Boy');

  assert.equal(photo.type, 'photo');
  assert.equal(photo.size, 100);
  assert.equal(photo.thumb, '/i/m/2000-b-t.jpg');
  assert.equal(photo.guest, 'Ann');
});

test('groupObjects falls back to the full image when a photo has no thumbnail', () => {
  const [item] = groupObjects([{ key: 'm/1000-x.jpg', size: 9 }], {});
  assert.equal(item.thumb, item.url);
  assert.equal(item.guest, 'Guest');
});

test('VIDEO_EXT covers the formats phones actually produce', () => {
  for (const ext of ['mp4', 'mov', 'm4v', 'webm', '3gp', 'avi', 'mkv']) {
    assert.ok(VIDEO_EXT.has(ext), ext);
  }
  assert.ok(!VIDEO_EXT.has('jpg'));
});

test('keyFromUrl reverses mediaUrl and refuses anything else', () => {
  assert.equal(keyFromUrl(mediaUrl({}, 'm/abc-t.jpg')), 'm/abc-t.jpg');
  // a custom media domain cannot be read from this bucket, so it is not bundleable
  assert.equal(keyFromUrl(mediaUrl({ PUBLIC_MEDIA_BASE: 'https://cdn.x.com' }, 'm/a.jpg')), '');
  assert.equal(keyFromUrl('blob:https://x/1'), '');
  assert.equal(keyFromUrl(''), '');
  assert.equal(keyFromUrl('/i/other/a.jpg'), '');
  assert.equal(keyFromUrl('/i/m/../../etc'), '');
});
