/**
 * Pure helpers for the album Worker.
 *
 * Kept separate from `worker.js` so they can be unit-tested without Cloudflare
 * bindings (see tests/lib.test.mjs). Nothing here touches `env` except
 * `mediaUrl`, which only reads a string.
 */

export const VIDEO_EXT = new Set(['mp4', 'mov', 'm4v', 'webm', '3gp', 'avi', 'mkv']);
export const SUFFIX = { photo: '', thumb: '-t', video: '', poster: '-p' };

/** Split `m/<id>[-t|-p].<ext>` into its parts. Returns null for a broken key. */
export function parseKey(key) {
  if (typeof key !== 'string' || !key.startsWith('m/')) return null;
  const name = key.slice(2);
  const dot = name.lastIndexOf('.');
  if (dot < 1) return null;

  let base = name.slice(0, dot);
  const ext = name.slice(dot + 1).toLowerCase();
  if (!ext) return null;

  let variant = 'main';
  if (base.endsWith('-t')) {
    variant = 'thumb';
    base = base.slice(0, -2);
  } else if (base.endsWith('-p')) {
    variant = 'poster';
    base = base.slice(0, -2);
  }

  if (!base) return null;
  return { id: base, variant, ext };
}

/** Where the browser should fetch this object from. */
export function mediaUrl(env, key) {
  const base = String((env && env.PUBLIC_MEDIA_BASE) || '').replace(/\/+$/, '');
  return base ? `${base}/${key}` : `/i/${key}`;
}

/**
 * The reverse of `mediaUrl`: `/i/m/abc-t.jpg` -> `m/abc-t.jpg`.
 *
 * Returns '' when the URL does not point at this Worker's own media route
 * (a custom media domain, a blob:, a data: URL). The album bundle can only
 * read keys from its own bucket, so callers must treat '' as "not bundleable"
 * and fall back to a normal request.
 */
export function keyFromUrl(url) {
  const s = String(url || '');
  if (!s.startsWith('/i/')) return '';
  const key = s.slice(3);
  if (!key.startsWith('m/') || key.includes('..')) return '';
  return key;
}

/**
 * Parse a Range header against a known object size.
 *
 * Returns:
 *   { start, end }   a satisfiable byte range (both inclusive)
 *   'invalid'        malformed header
 *   'unsatisfiable'  range outside the object (answer 416)
 *   null             no header
 */
export function parseRange(header, size) {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(header).trim());
  if (!m) return 'invalid';

  const hasStart = m[1] !== '';
  const hasEnd = m[2] !== '';
  if (!hasStart && !hasEnd) return 'invalid';

  let start;
  let end;

  if (!hasStart) {
    // "bytes=-500" -> the last 500 bytes
    const suffix = Number(m[2]);
    if (suffix <= 0) return 'unsatisfiable';
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = hasEnd ? Number(m[2]) : size - 1;
    if (hasEnd && end < start) return 'invalid';
    if (end >= size) end = size - 1;
  }

  if (start >= size || start > end) return 'unsatisfiable';
  return { start, end };
}

/** Group a page of R2 objects into album items, newest first. */
export function groupObjects(objects, env) {
  const map = new Map();

  for (const o of objects) {
    const p = parseKey(o.key);
    if (!p) continue;

    let item = map.get(p.id);
    if (!item) {
      const metaTs = Number(o.customMetadata && o.customMetadata.ts);
      item = {
        id: p.id,
        // ids are timestamp-inverted so that R2's ascending key order yields
        // newest-first; the real upload time therefore comes from metadata
        ts: (Number.isFinite(metaTs) && metaTs > 0 ? metaTs : 0)
          || Number(o.uploaded)
          || Number(String(p.id).split('-')[0])
          || 0,
        guest: '',
        type: 'photo',
        size: 0,
        frame: '',
      };
      map.set(p.id, item);
    }

    if (p.variant === 'thumb') item.thumb = o.key;
    else if (p.variant === 'poster') item.poster = o.key;
    else {
      item.file = o.key;
      item.size = o.size || 0;
      item.type = VIDEO_EXT.has(p.ext) ? 'video' : 'photo';
    }

    const g = o.customMetadata && o.customMetadata.guest;
    if (g && !item.guest) item.guest = g;
    const f = o.customMetadata && o.customMetadata.frame;
    if (f && !item.frame) item.frame = f;
  }

  return [...map.values()]
    .filter((it) => it.file)
    .sort((a, b) => b.ts - a.ts)    .map((it) => ({
      id: it.id,
      ts: it.ts,
      guest: it.guest || 'Guest',
      type: it.type,
      size: it.size,
      frame: it.frame || '',
      url: mediaUrl(env, it.file),
      thumb: it.thumb
        ? mediaUrl(env, it.thumb)
        : it.type === 'video'
          ? (it.poster ? mediaUrl(env, it.poster) : '')
          : mediaUrl(env, it.file),
    }));
}
