/**
 * A durable upload queue in IndexedDB.
 *
 * Why IndexedDB and not localStorage: localStorage stores strings (~5 MB) and
 * cannot hold a photo. IndexedDB stores Blobs/Files, so a guest who loses the
 * network (or closes the tab) can come back and finish sending.
 *
 * Guard rails, because this is someone's phone:
 *   - only 20 files / 50 MB are kept, newest kept, oldest dropped with a warning
 *   - entries older than 24 h are discarded on load
 *   - if the origin is >80% of its storage quota, nothing is persisted (memory only)
 *   - everything is deleted the moment the upload succeeds
 */

export const QUEUE_MAX_FILES = 20;
export const QUEUE_MAX_BYTES = 50 * 1024 * 1024;
export const QUEUE_TTL_MS = 24 * 60 * 60 * 1000;
const DB_NAME = 'wedding-upload-queue';
const STORE = 'pending';

let dbPromise = null;

export function supported() {
  try {
    return typeof indexedDB !== 'undefined' && Boolean(indexedDB.open);
  } catch {
    return false;
  }
}

function openDb() {
  if (!supported()) return Promise.reject(new Error('unsupported'));
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error('idb_open_failed'));
    });
  }
  return dbPromise;
}

function tx(mode, fn) {
  return openDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        const t = db.transaction(STORE, mode);
        const store = t.objectStore(STORE);
        let result;
        try {
          result = fn(store);
        } catch (e) {
          reject(e);
          return;
        }
        t.oncomplete = () => resolve(result && result.__value !== undefined ? result.__value : result);
        t.onerror = () => reject(t.error || new Error('idb_tx_failed'));
        t.onabort = () => reject(t.error || new Error('idb_aborted'));
      })
  );
}

/** @returns {Promise<number>} bytes still available before the guard trips */
export async function headroom() {
  try {
    if (!navigator.storage || !navigator.storage.estimate) return QUEUE_MAX_BYTES;
    const { usage = 0, quota = 0 } = await navigator.storage.estimate();
    if (!quota) return QUEUE_MAX_BYTES;
    return Math.max(0, quota * 0.8 - usage);
  } catch {
    return QUEUE_MAX_BYTES;
  }
}

export async function list() {
  if (!supported()) return [];
  try {
    const rows = await tx('readonly', (store) => {
      const out = [];
      const req = store.openCursor();
      req.onsuccess = () => {
        const cur = req.result;
        if (cur) {
          out.push(cur.value);
          cur.continue();
        }
      };
      const wrapped = { __value: out };
      return wrapped;
    });
    return Array.isArray(rows) ? rows : [];
  } catch {
    return [];
  }
}

/** Drop expired entries and enforce the file/size caps. */
export async function prune() {
  const rows = (await list()).sort((a, b) => a.ts - b.ts);
  const now = Date.now();
  const keepOldestFirst = rows.filter((r) => now - r.ts < QUEUE_TTL_MS);

  let total = keepOldestFirst.reduce((s, r) => s + (r.size || 0), 0);
  let kept = keepOldestFirst.slice();

  while (kept.length > QUEUE_MAX_FILES) {
    const dropped = kept.shift();
    total -= dropped.size || 0;
    await remove(dropped.id);
  }
  while (total > QUEUE_MAX_BYTES && kept.length) {
    const dropped = kept.shift();
    total -= dropped.size || 0;
    await remove(dropped.id);
  }

  const keepIds = new Set(kept.map((r) => r.id));
  for (const r of rows) {
    if (!keepIds.has(r.id)) await remove(r.id);
  }
  return kept;
}

/**
 * Persist one queued file. Returns false when it could not be stored (quota,
 * unsupported browser); the caller keeps it in memory in that case.
 */
export async function put({ id, file, guest, kind, frame }) {
  if (!supported() || !file) return false;
  const size = file.size || 0;
  if (size > QUEUE_MAX_BYTES) return false;

  const free = await headroom();
  if (free < size + 2 * 1024 * 1024) return false;

  await prune();
  try {
    await tx('readwrite', (store) => {
      store.put({
        id,
        blob: file,
        name: file.name || '',
        type: file.type || '',
        size,
        guest: guest || '',
        kind: kind || 'photo',
        frame: frame || '',
        ts: Date.now(),
      });
      return { __value: true };
    });
    return true;
  } catch {
    return false;
  }
}

export async function remove(id) {
  if (!supported()) return;
  try {
    await tx('readwrite', (store) => {
      store.delete(id);
      return { __value: true };
    });
  } catch {
    /* ignore: TTL will clean it up */
  }
}

export async function clear() {
  if (!supported()) return;
  try {
    await tx('readwrite', (store) => {
      store.clear();
      return { __value: true };
    });
  } catch {
    /* ignore */
  }
}

export async function stats() {
  const rows = await list();
  return { files: rows.length, bytes: rows.reduce((s, r) => s + (r.size || 0), 0) };
}
