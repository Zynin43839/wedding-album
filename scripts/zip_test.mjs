/**
 * Headless test for public/zip.js.
 *
 * Polyfills just enough browser surface (window/document/URL.createObjectURL)
 * to force the in-memory path, feeds it fake bytes, and writes the resulting
 * archive to ../tmp-test.zip so a real unzipper can verify it.
 *
 * Run: node scripts/zip_test.mjs
 */
import { writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';

const here = path.dirname(fileURLToPath(import.meta.url));
const scratch = path.join(os.tmpdir(), 'opencode', 'wedding-album');
mkdirSync(scratch, { recursive: true });
const outFile = path.join(scratch, 'zip-test.zip');

/* ── fixtures ─────────────────────────────────────────── */
const A = Buffer.from('hello wedding album '.repeat(500));
const B = Buffer.from([0xff, 0xd8, 0xff, 0xe0, ...Array(2000).fill(7)]);

const files = {
  'https://cdn.test/a.jpg': A,
  'https://cdn.test/b.mp4': B,
};

/* ── browser stubs (must be set before importing zip.js) ── */
globalThis.window = {}; // no showSaveFilePicker -> memory fallback
let captured = null;

globalThis.URL.createObjectURL = (blob) => {
  captured = blob;
  return 'blob:test';
};
globalThis.URL.revokeObjectURL = () => {};

globalThis.document = {
  createElement: () => ({ click() {}, remove() {}, set href(v) {}, set download(v) {} }),
  body: { appendChild() {} },
};

const realFetch = globalThis.fetch;
globalThis.fetch = async (url) => {
  const buf = files[url];
  if (!buf) return new Response('nope', { status: 404 });
  return new Response(buf, { status: 200 });
};

/* ── run ──────────────────────────────────────────────── */
const { buildZip } = await import('../public/zip.js');

const progress = [];
const result = await buildZip(
  [
    { name: '0001-สมชาย.jpg', url: 'https://cdn.test/a.jpg', ts: 1736000000000 },
    { name: '0002-Ann.mp4', url: 'https://cdn.test/b.mp4', ts: 1736000001000 },
    { name: '0003-missing.jpg', url: 'https://cdn.test/missing.jpg', ts: 1736000002000 },
  ],
  {
    filename: 'test.zip',
    estBytes: A.length + B.length,
    onProgress: (d, t) => progress.push(`${d}/${t}`),
  }
);

console.log('result:', result);
console.log('progress:', progress.join(' '));

if (!captured) {
  console.error('FAIL: no blob captured');
  process.exit(1);
}

const bytes = Buffer.from(await captured.arrayBuffer());
writeFileSync(outFile, bytes);
console.log(`wrote ${outFile} (${bytes.length} bytes)`);

globalThis.fetch = realFetch;

if (!result.ok) {
  console.error('FAIL: buildZip did not report ok');
  process.exit(1);
}
if (result.failed !== 1) {
  console.error('FAIL: expected exactly 1 failed entry, got', result.failed);
  process.exit(1);
}
console.log('PASS: zip_test completed');
