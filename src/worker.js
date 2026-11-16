/**
 * wedding-album — Cloudflare Worker
 *
 * Routes
 *   GET  /api/config                  -> event settings + limits
 *   POST /api/upload?e=&id=&kind=&ext=&name=  (binary body) -> store to R2
 *   GET  /api/list?e=&cursor=         -> grouped media items
 *   GET  /i/<key>                     -> media proxy (same origin)
 *   *                                 -> static assets (public/)
 *
 * Storage layout (single prefix "m/" so listing stays cheap & grouped):
 *   m/<id>.jpg      photo original (already resized on the phone)
 *   m/<id>-t.jpg    photo thumbnail 480px
 *   m/<id>.<ext>    video
 *   m/<id>-p.jpg    video poster frame
 *
 * No database: the gallery is built from R2 listing alone.
 */

import { VIDEO_EXT, SUFFIX, parseKey, mediaUrl, parseRange, groupObjects } from './lib.js';
const CACHE_IMMUTABLE = 'public, max-age=31536000, immutable';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors() });
    }

    try {
      if (path === '/api/config') return await handleConfig(env, url);
      if (path === '/api/upload') return await handleUpload(request, env, url);
      if (path === '/api/list') return await handleList(env, url);
      if (path === '/api/page') return await handlePage(env, url);
      if (path === '/api/sync') return await handleSync(request, env, url);
      if (path === '/api/purge') return await handlePurge(request, env);
      if (path === '/api/limits') return await handleLimits(request, env, url);
      if (path.startsWith('/i/')) return await handleMedia(request, env, path.slice(3));
    } catch (e) {
      return json({ error: 'server_error', detail: String(e && e.message || e) }, 500);
    }

    if (env.ASSETS) return env.ASSETS.fetch(request);
    return new Response('Not found', { status: 404 });
  },

  /** Cron: push un-synced objects into the couple's Drive folder. */
  async scheduled(event, env, ctx) {
    if (!env.DRIVE_FOLDER_ID || !env.GOOGLE_REFRESH_TOKEN) return;
    ctx.waitUntil(
      withSyncLock(env, () => syncBatch(env, Number(env.SYNC_BATCH) || 200)).catch(() => {})
    );
  },
};

/* ------------------------------------------------------------ sync lock */

/**
 * One archive run at a time.
 *
 * Storage reads/writes inside a Durable Object are serialized, so a simple
 * "if nobody holds it, take it" is a real mutex. A TTL makes an abandoned run
 * (isolate killed mid-push) self-heal instead of blocking the archive forever.
 */
export class SyncLock {
  constructor(state) {
    this.state = state;
  }

  async fetch(request) {
    const url = new URL(request.url);
    const now = Date.now();
    const until = Number((await this.state.storage.get('until')) || 0);

    if (url.pathname === '/release') {
      await this.state.storage.delete('until');
      return json({ released: true });
    }

    if (until > now) {
      return json({ acquired: false, remaining: Math.round((until - now) / 1000) });
    }

    const ttl = Math.max(60, Math.min(3600, Number(url.searchParams.get('ttl')) || 600));
    await this.state.storage.put('until', now + ttl * 1000);
    return json({ acquired: true, ttl });
  }
}

/* ---------------------------------------------------------- google drive */

/**
 * Archive to Google Drive.
 *
 * Every run takes objects under `m/` that have no `synced/<key>` marker and
 * uploads them into one folder with a resumable upload (the bytes are streamed,
 * so an 80 MB clip never has to sit in memory).
 *
 * State lives in R2 itself (`synced/<key>` zero-byte markers), so there is no
 * database and the queue survives a redeploy. A marker is written only after
 * Drive confirms the file, which makes a retry safe: worst case an object is
 * uploaded twice, never lost.
 */
let tokenCache = { value: '', exp: 0 };
let tokenInflight = null;

async function googleToken(env) {
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET || !env.GOOGLE_REFRESH_TOKEN) {
    throw new Error('google_not_configured');
  }
  if (tokenCache.value && Date.now() < tokenCache.exp) return tokenCache.value;
  // concurrent pushes must not each ask Google for a token
  if (tokenInflight) return tokenInflight;
  tokenInflight = fetchGoogleToken(env);
  try {
    return await tokenInflight;
  } finally {
    tokenInflight = null;
  }
}

async function fetchGoogleToken(env) {

  const body = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    client_secret: env.GOOGLE_CLIENT_SECRET,
    refresh_token: env.GOOGLE_REFRESH_TOKEN,
    grant_type: 'refresh_token',
  });
  const r = await fetch(env.GOOGLE_TOKEN_URL || 'https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || !d.access_token) throw new Error('token:' + (d.error || r.status));
  tokenCache = {
    value: d.access_token,
    exp: Date.now() + Math.max(60, Number(d.expires_in || 3600) - 120) * 1000,
  };
  return tokenCache.value;
}

async function syncedKeys(env) {
  const done = new Set();
  for (const prefix of ['synced/', 'failed/']) {
    let cursor;
    do {
      const page = await env.BUCKET.list({ prefix, limit: 1000, cursor });
      for (const o of page.objects) done.add(o.key.slice(prefix.length));
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
  }
  return done;
}

async function pushToDrive(env, key) {
  const token = await googleToken(env);
  const obj = await env.BUCKET.get(key);
  if (!obj) throw new Error('not_found');

  const type = (obj.httpMetadata && obj.httpMetadata.contentType) || 'application/octet-stream';
  const start = await fetch(
    env.GOOGLE_UPLOAD_URL ||
      'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id',
    {
      method: 'POST',
      headers: {
        authorization: 'Bearer ' + token,
        'content-type': 'application/json; charset=UTF-8',
        'x-upload-content-type': type,
        'x-upload-content-length': String(obj.size),
      },
      body: JSON.stringify({ name: key.slice(2), parents: [env.DRIVE_FOLDER_ID] }),
    }
  );
  if (!start.ok) throw new Error('start:' + start.status);
  const location = start.headers.get('location');
  if (!location) throw new Error('no_location');

  const put = await fetch(location, { method: 'PUT', headers: { 'content-type': type }, body: obj.body });
  if (!put.ok) throw new Error('put:' + put.status);
  const data = await put.json().catch(() => ({}));
  return { id: data.id || '', size: Number(obj.size) || 0 };
}

/**
 * Objects that exist in the album but have no `synced/` marker yet.
 *
 * Stops scanning once it has `want` candidates, because the scan itself costs
 * one R2 list per 180 objects and the run has to leave room in the invocation's
 * 1,000-request budget for the uploads.
 */
async function scanPending(env, want) {
  const done = await syncedKeys(env);
  const pending = [];
  let cursor;
  let scanned = 0;

  do {
    const page = await env.BUCKET.list({ prefix: 'm/', limit: 180, cursor });
    scanned += page.objects.length;
    const originalsOnly = String(env.ARCHIVE_ORIGINALS_ONLY ?? 'true') !== 'false';
    for (const o of page.objects) {
      if (done.has(o.key)) continue;
      // -t (thumbnail) and -p (video poster) are derived; skipping them halves
      // the object count and therefore the archive time
      if (originalsOnly) {
        const parsed = parseKey(o.key);
        if (!parsed || parsed.variant !== 'main') continue;
      }
      pending.push(o.key);
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor && pending.length < want);

  return { pending, scanned, marked: done.size };
}

async function syncBatch(env, limit, force = false) {
  const { pending, scanned, marked } = await scanPending(env, limit * 4);

  // "wrap them only once there are enough": nothing is pushed below the threshold
  const minBatch = Math.max(1, Number(env.SYNC_MIN_BATCH) || 1);
  if (!force && pending.length < minBatch) {
    return { skipped: 'below_threshold', pending: pending.length, minBatch, marked, scanned };
  }

  const batch = pending.slice(0, limit);
  const failed = [];
  let pushed = 0;
  let bytes = 0;

  // Wall time is dominated by waiting, so push CONCURRENCY files at once. The
  // per-invocation fetch budget (50) is unchanged: each object still costs 2
  // fetches, and the batch cap of 25 keeps 25 x 2 <= 50.
  const concurrency = Math.max(1, Math.min(8, Number(env.SYNC_CONCURRENCY) || 4));
  let next = 0;

  const worker = async () => {
    while (next < batch.length) {
      const key = batch[next++];
      try {
        const res = await pushToDrive(env, key);
        bytes += res.size;
        await env.BUCKET.put(`synced/${key}`, new Uint8Array(0), {
          customMetadata: { driveId: res.id, at: String(Date.now()) },
        });
        pushed++;
      } catch (e) {
        const error = String((e && e.message) || e).slice(0, 120);
        failed.push({ key, error });
        // "send it again" mode: mark it so it stops retrying and shows in the ledger
        if (String(env.SYNC_ON_FAIL || 'requeue') === 'skip') {
          try {
            await env.BUCKET.put(`failed/${key}`, new Uint8Array(0), {
              customMetadata: { error, at: String(Date.now()) },
            });
          } catch {
            /* the marker is best effort; the object stays pending and will retry */
          }
        }
      }
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(concurrency, batch.length) }, () => worker())
  );

  if (failed.length) {
    try {
      await env.BUCKET.put(
        'state/last-failed.json',
        new TextEncoder().encode(JSON.stringify({ at: new Date().toISOString(), failed })),
        { httpMetadata: { contentType: 'application/json' } }
      );
    } catch {
      /* reporting must never break the push */
    }
  }

  return {
    pushed,
    bytes,
    concurrency,
    failed: failed.length,
    errors: failed.slice(0, 5),
    mode: String(env.SYNC_ON_FAIL || 'requeue'),
    minBatch,
    pending: pending.length,
    scanned,
    marked,
    left: pending.length - pushed,
  };
}

async function handleSync(request, env, url) {
  if (!env.SYNC_TOKEN) return json({ error: 'sync_not_configured' }, 503);
  const given = request.headers.get('x-sync-token') || url.searchParams.get('token') || '';
  if (given !== env.SYNC_TOKEN) return json({ error: 'forbidden' }, 403);
  // Delete files the app created whose name starts with a prefix. Used to clear
  // test uploads; never touches anything the app did not create (drive.file).
  if (url.searchParams.get('cleanup') === '1') {
    const prefix = String(url.searchParams.get('prefix') || '').slice(0, 40);
    const confirm = url.searchParams.get('confirm') === 'yes';
    const limit = Math.max(1, Math.min(25, Number(url.searchParams.get('limit')) || 20));
    if (prefix.length < 4 || !confirm) {
      return json({ error: 'cleanup_needs_prefix_and_confirm' }, 400);
    }
    try {
      const token = await googleToken(env);
      const q = `name starts with '${prefix.replace(/'/g, "\\'")}' and trashed = false`;
      const lr = await fetch(
        `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id,name)&pageSize=${limit}`,
        { headers: { authorization: 'Bearer ' + token } }
      );
      const ld = await lr.json().catch(() => ({}));
      if (!lr.ok) return json({ error: 'list_failed', status: lr.status, detail: ld }, 502);
      const files = ld.files || [];
      const errors = [];
      let deleted = 0;
      for (const f of files) {
        const dr = await fetch(`https://www.googleapis.com/drive/v3/files/${f.id}`, {
          method: 'DELETE',
          headers: { authorization: 'Bearer ' + token },
        });
        if (dr.ok || dr.status === 204) deleted++;
        else errors.push(`${f.name}:${dr.status}`);
      }
      return json({ deleted, found: files.length, errors: errors.slice(0, 5) });
    } catch (e) {
      return json({ error: 'cleanup_failed', detail: String((e && e.message) || e).slice(0, 160) }, 502);
    }
  }

  // Create the destination folder from the Worker, so the host never has to
  // paste credentials into a local script. Needed because drive.file cannot see
  // a folder the user made by hand in the Drive web UI.
  if (url.searchParams.get('folder') === '1') {
    const name = (url.searchParams.get('name') || 'Wedding-22.11.26').slice(0, 80);
    try {
      const token = await googleToken(env);
      const r = await fetch('https://www.googleapis.com/drive/v3/files?fields=id,name,webViewLink', {
        method: 'POST',
        headers: {
          authorization: 'Bearer ' + token,
          'content-type': 'application/json; charset=UTF-8',
        },
        body: JSON.stringify({ name, mimeType: 'application/vnd.google-apps.folder' }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) return json({ error: 'folder_failed', status: r.status, detail: d }, 502);
      return json({ ok: true, id: d.id, name: d.name, link: d.webViewLink });
    } catch (e) {
      return json({ error: 'folder_failed', detail: String((e && e.message) || e).slice(0, 200) }, 502);
    }
  }

  // Diagnose the credential chain without printing any secret in full: lengths
  // and short masked tails are enough to spot a truncated or wrong-typed value,
  // and the token endpoint's own error_description says whether Google thinks the
  // token is expired/revoked or issued to another client.
  if (url.searchParams.get('diag') === '1') {
    const mask = (v) => (v ? `${String(v).slice(0, 6)}…${String(v).slice(-4)} (len ${String(v).length})` : '(missing)');
    let exchange;
    try {
      const body = new URLSearchParams({
        client_id: env.GOOGLE_CLIENT_ID || '',
        client_secret: env.GOOGLE_CLIENT_SECRET || '',
        refresh_token: env.GOOGLE_REFRESH_TOKEN || '',
        grant_type: 'refresh_token',
      });
      const r = await fetch(env.GOOGLE_TOKEN_URL || 'https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body,
      });
      const d = await r.json().catch(() => ({}));
      exchange = {
        status: r.status,
        error: d.error || '',
        description: String(d.error_description || '').slice(0, 140),
        gotAccessToken: Boolean(d.access_token),
      };
    } catch (e) {
      exchange = { thrown: String((e && e.message) || e).slice(0, 140) };
    }
    return json({
      clientId: mask(env.GOOGLE_CLIENT_ID),
      clientSecret: env.GOOGLE_CLIENT_SECRET
        ? String(env.GOOGLE_CLIENT_SECRET).startsWith('GOCSPX-')
          ? `GOCSPX-… (len ${String(env.GOOGLE_CLIENT_SECRET).length})`
          : `not a GOCSPX value (len ${String(env.GOOGLE_CLIENT_SECRET).length})`
        : '(missing)',
      refreshToken: mask(env.GOOGLE_REFRESH_TOKEN),
      folderId: env.DRIVE_FOLDER_ID || '(empty)',
      exchange,
    });
  }

  if (!env.DRIVE_FOLDER_ID && url.searchParams.get('dry') !== '1') {
    return json({ error: 'drive_folder_missing' }, 503);
  }

  const limit = Math.max(1, Math.min(400, Number(url.searchParams.get('limit')) || 25));
  try {
    if (url.searchParams.get('failed') === '1') {
      const obj = await env.BUCKET.get('state/last-failed.json');
      if (!obj) return json({ failed: [], note: 'no failures recorded yet' });
      return new Response(obj.body, {
        headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...cors() },
      });
    }
    if (url.searchParams.get('dry') === '1') {
      const r = await scanPending(env, limit * 4);
      const minBatch = Math.max(1, Number(env.SYNC_MIN_BATCH) || 1);
      return json({
        dry: true,
        marked: r.marked,
        pending: r.pending.length,
        scanned: r.scanned,
        minBatch,
        wouldPush: r.pending.length >= minBatch,
      });
    }
    const force = url.searchParams.get('force') === '1';
    const result = await withSyncLock(env, () => syncBatch(env, limit, force));
    return json(result);
  } catch (e) {
    return json({ error: 'sync_failed', detail: String((e && e.message) || e).slice(0, 200) }, 502);
  }
}

/** Run `fn` only if no other archive run holds the lock. */
async function withSyncLock(env, fn) {
  if (!env.SYNC_LOCK) return fn(); // local dev / older deploy: no lock available
  const stub = env.SYNC_LOCK.get(env.SYNC_LOCK.idFromName('drive-archive'));

  let hold;
  try {
    hold = await (await stub.fetch('https://lock/acquire?ttl=900')).json();
  } catch {
    return fn(); // a broken lock must not stop the archive
  }
  if (!hold.acquired) return { skipped: 'locked', remaining: hold.remaining };

  try {
    return await fn();
  } finally {
    try {
      await stub.fetch('https://lock/release', { method: 'POST' });
    } catch {
      /* TTL will release it */
    }
  }
}

/* ------------------------------------------------------------- big deletes */

/**
 * Bulk delete, so cleaning the album is ONE request per ~900 objects instead of
 * one CLI process per object (see the Bulk Operation Law in the global
 * AGENTS.md). `BUCKET.delete()` accepts an array, which is the batched path.
 *
 *   POST /api/purge            { "keys": ["m/a.jpg", ...] }
 *   POST /api/purge            { "prefix": "m/sc", "limit": 900, "dryRun": true }
 */
async function handlePurge(request, env) {
  if (request.method !== 'POST') return json({ error: 'method' }, 405);
  if (!env.SYNC_TOKEN) return json({ error: 'purge_not_configured' }, 503);

  const given = request.headers.get('x-purge-token') || '';
  if (given !== env.SYNC_TOKEN) return json({ error: 'forbidden' }, 403);

  let body = {};
  try {
    body = await request.json();
  } catch {
    return json({ error: 'bad_json' }, 400);
  }

  const dryRun = body.dryRun === true;
  const limit = Math.max(1, Math.min(900, Number(body.limit) || 900));

  let keys = Array.isArray(body.keys) ? body.keys.filter((k) => typeof k === 'string') : null;

  if (!keys) {
    const prefix = String(body.prefix || '');
    if (!prefix) return json({ error: 'keys_or_prefix_required' }, 400);
    const page = await env.BUCKET.list({ prefix, limit });
    keys = page.objects.map((o) => o.key);
  }

  keys = keys.slice(0, limit);
  if (dryRun) return json({ dryRun: true, wouldDelete: keys.length, keys });

  if (!keys.length) return json({ deleted: 0, keys: [] });

  // BUCKET.delete takes up to 1000 keys per call; chunk defensively.
  let deleted = 0;
  for (let i = 0; i < keys.length; i += 900) {
    await env.BUCKET.delete(keys.slice(i, i + 900));
    deleted += Math.min(900, keys.length - i);
  }

  return json({ deleted, keys: keys.length });
}

/* ---------------------------------------------------------------- helpers */

/**
 * JSON responses.
 *
 * `cache` is explicit on purpose: leaving it out made the browser guess, and
 * Chrome guessed "cacheable". A guest who had just uploaded a photo then got
 * the *previous* list back, so their own photo was missing from the album.
 * Every API answer now states its policy, so no browser has to guess.
 */
function json(data, status = 200, cache = 'no-store') {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': cache,
      ...cors(),
    },
  });
}

function cors() {
  return {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    'access-control-allow-headers': 'content-type',
  };
}

function mb(v, fallback) {
  const n = Number(v);
  return (Number.isFinite(n) && n > 0 ? n : fallback) * 1024 * 1024;
}

function expired(env) {
  if (!env.EXPIRES_AT) return false;
  const t = Date.parse(env.EXPIRES_AT);
  return Number.isFinite(t) && Date.now() > t;
}

function authOk(env, url) {
  if (!env.EVENT_CODE) return true;
  const given = url.searchParams.get('e') || '';
  if (given.length !== env.EVENT_CODE.length) return false;
  // constant-time-ish compare
  let diff = 0;
  for (let i = 0; i < given.length; i++) {
    diff |= given.charCodeAt(i) ^ env.EVENT_CODE.charCodeAt(i);
  }
  return diff === 0;
}



/* ---------------------------------------------------------------- handlers */

async function handleConfig(env, url) {
  if (expired(env)) return json({ expired: true }, 410);
  if (!authOk(env, url)) return json({ error: 'bad_code' }, 403);
  return json(
    {
      title: env.EVENT_TITLE || 'Wedding Album',
      names: env.EVENT_NAMES || '',
      date: env.EVENT_DATE || '',
      expiresAt: env.EXPIRES_AT || '',
      maxPhotoMb: Math.round(mb(env.MAX_PHOTO_MB, 12) / 1048576),
      maxVideoMb: Math.round(mb(env.MAX_VIDEO_MB, 80) / 1048576),
    },
    200,
    // only changes on deploy, so one request per device per 10 minutes is enough
    'public, max-age=600'
  );
}

async function handleUpload(request, env, url) {
  if (request.method !== 'POST') return json({ error: 'method' }, 405);
  if (expired(env)) return json({ error: 'expired' }, 410);
  if (!authOk(env, url)) return json({ error: 'bad_code' }, 403);

  const kind = url.searchParams.get('kind') || '';
  if (!Object.prototype.hasOwnProperty.call(SUFFIX, kind)) {
    return json({ error: 'bad_kind' }, 400);
  }

  const id = (url.searchParams.get('id') || '').toLowerCase();
  if (!/^[a-z0-9-]{8,40}$/.test(id)) return json({ error: 'bad_id' }, 400);

  const ext = (url.searchParams.get('ext') || 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '');
  if (!ext || ext.length > 5) return json({ error: 'bad_ext' }, 400);

  const guest = (url.searchParams.get('name') || '').slice(0, 40);
  // guest-chosen frame (see docs/DESIGN.md §3.1); anything else falls back to "auto"
  const frameParam = (url.searchParams.get('frame') || '').toLowerCase();
  const frame = /^v[0-6]$/.test(frameParam) ? frameParam : '';

  const ct = request.headers.get('content-type') || '';
  if (!/^(image|video)\//i.test(ct)) return json({ error: 'bad_type' }, 415);

  const declared = Number(request.headers.get('content-length') || 0);
  if (!declared) return json({ error: 'length_required' }, 411);

  const isVideo = kind === 'video';
  const limit = isVideo ? mb(env.MAX_VIDEO_MB, 80) : mb(env.MAX_PHOTO_MB, 12);
  if (declared > limit) {
    return json({ error: 'too_large', limitBytes: limit }, 413);
  }

  const key = `m/${id}${SUFFIX[kind]}.${ext}`;

  try {
    await env.BUCKET.put(key, request.body, {
      httpMetadata: { contentType: ct, cacheControl: CACHE_IMMUTABLE },
      customMetadata: {
        guest: guest || 'Guest',
        kind,
        ts: String(Date.now()),
        frame,
      },
    });
  } catch (e) {
    // two requests with the same id can collide; the client retries on 409
    return json({ error: 'conflict', detail: String((e && e.message) || e).slice(0, 120) }, 409);
  }

  return json({ ok: true, key, url: mediaUrl(env, key) });
}

async function handleList(env, url) {
  if (expired(env)) return json({ expired: true }, 410);
  if (!authOk(env, url)) return json({ error: 'bad_code' }, 403);

  const cursor = url.searchParams.get('cursor') || undefined;
  // ~60 photos per page (180 objects). The old page held ~300 photos, so a guest
  // opening the album fired 300 Worker requests at once; 650 guests x 300 = 195k
  // requests, double the free 100k/day. One list call per page also uses fewer
  // R2 operations than the previous 5-call loop.
  const PAGE_OBJECTS = 180;
  let res;
  try {
    res = await env.BUCKET.list({
      prefix: 'm/',
      limit: PAGE_OBJECTS,
      cursor,
      include: ['customMetadata'],
    });
  } catch (e) {
    // a cursor saved before the bucket changed comes back as error 10023; the
    // guest just needs a fresh first page instead of a 500
    if (cursor) {
      res = await env.BUCKET.list({ prefix: 'm/', limit: PAGE_OBJECTS, include: ['customMetadata'] });
    } else {
      throw e;
    }
  }
  const objects = res.objects;
  const truncated = Boolean(res.truncated);
  const next = res.cursor;

  const items = groupObjects(objects, env);

  return json({ items, cursor: next && truncated ? next : null, count: items.length });
}

/* ------------------------------------------------------- bundled thumbs */

/**
 * One request, many thumbnails.
 *
 * The album grid used to cost one Worker request per photo (15 per page), so a
 * guest opening the album once fired 15 requests, and 650 guests fired ~10,000
 * in a day — a tenth of the free 100,000/day allowance for nothing but the
 * thumbnails. `<img>` cannot ask for 15 files at once, so this endpoint does it
 * for the browser: it streams the requested thumbnails into ONE
 * `multipart/mixed` response, and the client splits it back into blobs.
 *
 *   GET /api/page?e=CODE&k=m/aaa-t.jpg,m/bbb-t.jpg,...   (max 8)
 *
 * Every part carries `x-key`, so a missing thumbnail simply drops out of the
 * response and the client falls back to a normal `/i/` request for that one.
 *
 * The URL is content-addressed (the keys are in it) and thumbnails never
 * change, so the response is immutable and the browser can keep it for a year —
 * the second visit from the same phone costs zero requests.
 */
// 8, not 15: CPU scales with the bytes copied and the free plan allows only
// 10 ms per invocation. Measured over production traffic (`wrangler tail`,
// 2026-11-16): 1 thumb avg 1.8 ms, 5 avg 4.3, 10 avg 5.5-6.5 with a 14 ms
// cold-start outlier, and a plain /api/list already costs ~4 ms. 8 keeps the
// ceiling out of reach while still turning a 15-photo page (15 requests)
// into 2.
const BUNDLE_MAX = 8;
// CPU is spent per byte sent, not per item: ~1 ms per 90 KB measured.
// These two constants are the guard rail that keeps one invocation inside
// the free plan's 10 ms ceiling even when thumbnails are unusually large.
const MAX_PART_BYTES = 200 * 1024; // one part bigger than this is not a thumb
const MAX_TOTAL_BYTES = 420 * 1024; // whole response budget
const KEY_RE = /^m\/[a-z0-9-]{3,40}(-t|-p)?\.[a-z0-9]{1,5}$/;

async function handlePage(env, url) {
  if (expired(env)) return json({ expired: true }, 410);
  if (!authOk(env, url)) return json({ error: 'bad_code' }, 403);

  const raw = url.searchParams.get('k') || '';
  if (raw.length > 1400) return json({ error: 'too_many' }, 413);

  const keys = [];
  for (const part of raw.split(',')) {
    const k = part.trim();
    if (!k || !KEY_RE.test(k) || keys.includes(k)) continue;
    keys.push(k);
    if (keys.length >= BUNDLE_MAX) break;
  }
  if (!keys.length) return json({ error: 'no_keys' }, 400);

  const boundary = 'album' + crypto.randomUUID().replace(/-/g, '').slice(0, 16);
  const enc = new TextEncoder();

  // Handing 15 R2 bodies to a ReadableStream and re-enqueuing every chunk cost
  // 9-21 ms of CPU (measured with `wrangler tail`: avg 14.6 ms), over the free
  // plan's 10 ms ceiling. Concatenating into one Blob and letting the runtime
  // send it costs a fraction of that, so the parts are collected first.
  const parts = [];

  const objects = await Promise.all(
    keys.map((key) => env.BUCKET.get(key).catch(() => null))
  );

  let total = 0;
  for (let i = 0; i < keys.length; i++) {
    const obj = objects[i];
    if (!obj || !obj.body) continue;
    const size = Number(obj.size) || 0;
    if (size > MAX_PART_BYTES) continue; // full-size photo, not a thumbnail
    if (total + size > MAX_TOTAL_BYTES) break; // stay inside the CPU budget
    total += size;
    const type = (obj.httpMetadata && obj.httpMetadata.contentType) || 'image/jpeg';
    parts.push(enc.encode(`--${boundary}\r\ncontent-type: ${type}\r\nx-key: ${keys[i]}\r\n\r\n`));
    parts.push(await obj.arrayBuffer());
    parts.push(enc.encode('\r\n'));
  }
  parts.push(enc.encode(`--${boundary}--\r\n`));

  return new Response(new Blob(parts, { type: `multipart/mixed; boundary=${boundary}` }), {
    headers: {
      'content-type': `multipart/mixed; boundary=${boundary}`,
      'cache-control': CACHE_IMMUTABLE,
      ...cors(),
    },
  });
}

/* ------------------------------------------------------- platform ceilings */

/**
 * How many subrequests can ONE invocation make on this account?
 *
 * The Drive archiver pushes each object with ~4 subrequests (R2 read, token,
 * Drive start, Drive PUT) plus one marker write, and the plan caps subrequests
 * per invocation. Rather than trust a number from the docs, this endpoint makes
 * cheap `head` calls until the platform refuses and reports where it stopped.
 *
 *   GET /api/limits?n=200   (header x-sync-token: SYNC_TOKEN)
 */
async function handleLimits(request, env, url) {
  if (!env.SYNC_TOKEN || request.headers.get('x-sync-token') !== env.SYNC_TOKEN) {
    return json({ error: 'forbidden' }, 403);
  }

  const budget = Math.max(1, Math.min(1000, Number(url.searchParams.get('n')) || 60));
  const mode = url.searchParams.get('mode') || 'r2';

  if (mode === 'fetch') {
    // The Drive leg is fetch(), which has its own per-invocation ceiling — the
    // number that decides how many files one cron run can actually archive.
    const target = url.searchParams.get('url') || 'https://www.cloudflare.com/cdn-cgi/trace';
    let attempted = 0;
    let error = '';
    const t0 = Date.now();
    for (let i = 0; i < budget; i++) {
      try {
        const r = await fetch(target, { method: 'GET', headers: { 'cache-control': 'no-store' } });
        await r.text();
        attempted++;
      } catch (e) {
        error = String((e && e.message) || e).slice(0, 160);
        break;
      }
    }
    return json({ mode: 'fetch', attempted, budget, error, ms: Date.now() - t0, target });
  }

  const page = await env.BUCKET.list({ prefix: 'm/', limit: 1 });
  const key = page.objects[0] && page.objects[0].key;
  if (!key) return json({ error: 'empty_bucket' }, 409);

  let attempted = 0;
  let error = '';
  const t0 = Date.now();
  for (let i = 0; i < budget; i++) {
    try {
      const meta = await env.BUCKET.head(key);
      if (!meta) break;
      attempted++;
    } catch (e) {
      error = String((e && e.message) || e).slice(0, 160);
      break;
    }
  }

  return json({ attempted, budget, error, ms: Date.now() - t0, key });
}

async function handleMedia(request, env, rawKey) {
  const key = decodeURIComponent(rawKey);
  if (!key.startsWith('m/') || key.includes('..')) {
    return new Response('Bad key', { status: 400 });
  }

  const rangeHeader = request.headers.get('range');
  const meta = await env.BUCKET.head(key);
  if (!meta) return new Response('Not found', { status: 404 });
  const size = meta.size;

  const base = new Headers();
  meta.writeHttpMetadata(base);
  base.set('etag', meta.httpEtag);
  base.set('cache-control', CACHE_IMMUTABLE);
  base.set('access-control-allow-origin', '*');
  base.set('accept-ranges', 'bytes');

  // Range support: Safari refuses to play or seek a video without 206 responses,
  // so a clip uploaded from our recorder could not be watched on an iPhone.
  if (rangeHeader) {
    const range = parseRange(rangeHeader, size);
    if (range === 'invalid') return new Response('Bad range', { status: 400, headers: base });
    if (range === 'unsatisfiable') {
      base.set('content-range', `bytes */${size}`);
      return new Response(null, { status: 416, headers: base });
    }

    const part = await env.BUCKET.get(key, {
      range: { offset: range.start, length: range.end - range.start + 1 },
    });
    if (!part) return new Response('Not found', { status: 404 });

    base.set('content-range', `bytes ${range.start}-${range.end}/${size}`);
    base.set('content-length', String(range.end - range.start + 1));
    const status = request.method === 'HEAD' ? 200 : 206;
    return new Response(request.method === 'HEAD' ? null : part.body, { status, headers: base });
  }

  if (request.method === 'HEAD') {
    base.set('content-length', String(size));
    return new Response(null, { status: 200, headers: base });
  }

  const obj = await env.BUCKET.get(key);
  if (!obj) return new Response('Not found', { status: 404 });
  base.set('content-length', String(size));
  return new Response(obj.body, { headers: base });
}
