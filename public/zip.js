/**
 * Minimal ZIP writer — STORE only (no compression), streams straight to disk.
 *
 * Photos/videos are already compressed, so deflate buys nothing and costs CPU.
 * Uses "data descriptor" (flag bit 3) so each file can be streamed through
 * without knowing its size or CRC up front -> memory stays at one chunk.
 *
 * No ZIP64 support: the archive is capped below 4 GB on purpose.
 */

const MAX_BYTES = 4 * 1024 ** 3 - 8 * 1024 ** 2; // stay under 4 GB

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();

function makeCrc() {
  let c = 0xffffffff;
  return {
    update(u8) {
      for (let i = 0; i < u8.length; i++) c = CRC_TABLE[(c ^ u8[i]) & 0xff] ^ (c >>> 8);
    },
    digest() {
      return (c ^ 0xffffffff) >>> 0;
    },
  };
}

function dosDateTime(d) {
  const time = ((d.getHours() & 0x1f) << 11) | ((d.getMinutes() & 0x3f) << 5) | ((d.getSeconds() >> 1) & 0x1f);
  const date = (((d.getFullYear() - 1980) & 0x7f) << 9) | (((d.getMonth() + 1) & 0x0f) << 5) | (d.getDate() & 0x1f);
  return { time, date };
}

function localHeader(nameBytes, time, date) {
  const b = new Uint8Array(30 + nameBytes.length);
  const dv = new DataView(b.buffer);
  dv.setUint32(0, 0x04034b50, true);
  dv.setUint16(4, 20, true);
  dv.setUint16(6, 0x0808, true); // UTF-8 names + data descriptor
  dv.setUint16(8, 0, true); // store
  dv.setUint16(10, time, true);
  dv.setUint16(12, date, true);
  dv.setUint32(14, 0, true);
  dv.setUint32(18, 0, true);
  dv.setUint32(22, 0, true);
  dv.setUint16(26, nameBytes.length, true);
  dv.setUint16(28, 0, true);
  b.set(nameBytes, 30);
  return b;
}

function dataDescriptor(crc, size) {
  const b = new Uint8Array(16);
  const dv = new DataView(b.buffer);
  dv.setUint32(0, 0x08074b50, true);
  dv.setUint32(4, crc, true);
  dv.setUint32(8, size, true);
  dv.setUint32(12, size, true);
  return b;
}

function centralRecord(nameBytes, crc, size, offset, time, date) {
  const b = new Uint8Array(46 + nameBytes.length);
  const dv = new DataView(b.buffer);
  dv.setUint32(0, 0x02014b50, true);
  dv.setUint16(4, 20, true);
  dv.setUint16(6, 20, true);
  dv.setUint16(8, 0x0808, true);
  dv.setUint16(10, 0, true);
  dv.setUint16(12, time, true);
  dv.setUint16(14, date, true);
  dv.setUint32(16, crc, true);
  dv.setUint32(20, size, true);
  dv.setUint32(24, size, true);
  dv.setUint16(28, nameBytes.length, true);
  dv.setUint16(30, 0, true);
  dv.setUint16(32, 0, true);
  dv.setUint16(34, 0, true);
  dv.setUint16(36, 0, true);
  dv.setUint32(38, 0, true);
  dv.setUint32(42, offset, true);
  b.set(nameBytes, 46);
  return b;
}

function eocd(count, cdSize, cdOffset) {
  const b = new Uint8Array(22);
  const dv = new DataView(b.buffer);
  dv.setUint32(0, 0x06054b50, true);
  dv.setUint16(4, 0, true);
  dv.setUint16(6, 0, true);
  dv.setUint16(8, Math.min(count, 0xffff), true);
  dv.setUint16(10, Math.min(count, 0xffff), true);
  dv.setUint32(12, cdSize, true);
  dv.setUint32(16, cdOffset, true);
  dv.setUint16(20, 0, true);
  return b;
}

function saveBlob(blob, filename) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 60_000);
}

/**
 * @param {{name:string, url:string, ts?:number}[]} entries
 */
export async function buildZip(entries, opts = {}) {
  const { filename = 'album.zip', onProgress = () => {}, estBytes = 0 } = opts;

  if (!entries.length) return { error: 'empty' };
  if (estBytes > MAX_BYTES) return { error: 'too_big', estBytes };
  if (entries.length > 65000) return { error: 'too_many', count: entries.length };

  let write = null;
  let close = async () => {};
  const mem = [];

  if (typeof window.showSaveFilePicker === 'function') {
    try {
      const handle = await window.showSaveFilePicker({
        suggestedName: filename,
        types: [{ description: 'ZIP archive', accept: { 'application/zip': ['.zip'] } }],
      });
      const w = await handle.createWritable();
      write = (u8) => w.write(u8);
      close = () => w.close();
    } catch (e) {
      if (e && e.name === 'AbortError') return { cancelled: true };
      write = null;
    }
  }

  if (!write) {
    write = async (u8) => {
      mem.push(u8);
    };
  }

  const enc = new TextEncoder();
  const central = [];
  let offset = 0;
  let total = 0;
  let done = 0;
  let failed = 0;

  for (const entry of entries) {
    try {
      const res = await fetch(entry.url);
      if (!res.ok || !res.body) throw new Error('fetch ' + res.status);

      const nameBytes = enc.encode(entry.name);
      const { time, date } = dosDateTime(new Date(entry.ts || Date.now()));
      const localOffset = offset;

      const header = localHeader(nameBytes, time, date);
      await write(header);
      offset += header.length;

      const crc = makeCrc();
      let size = 0;
      const reader = res.body.getReader();
      for (;;) {
        const { done: fin, value } = await reader.read();
        if (fin) break;
        crc.update(value);
        size += value.length;
        total += value.length;
        offset += value.length;
        if (total > MAX_BYTES) {
          try { await reader.cancel(); } catch {}
          throw new Error('size_cap');
        }
        await write(value);
      }

      const sum = crc.digest();
      const dd = dataDescriptor(sum, size);
      await write(dd);
      offset += dd.length;

      central.push(centralRecord(nameBytes, sum, size, localOffset, time, date));
    } catch (e) {
      if (String(e && e.message) === 'size_cap') return { error: 'too_big', bytes: total };
      failed++;
    }
    done++;
    onProgress(done, entries.length);
  }

  const cdOffset = offset;
  let cdSize = 0;
  for (const rec of central) {
    await write(rec);
    cdSize += rec.length;
  }
  await write(eocd(central.length, cdSize, cdOffset));
  await close();

  if (mem.length) saveBlob(new Blob(mem, { type: 'application/zip' }), filename);

  return { ok: true, bytes: total, files: central.length, failed };
}
