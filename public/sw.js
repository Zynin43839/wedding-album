/**
 * Service worker for the album shell and the photos.
 *
 * Goal: a guest who opens the album a second time should not pay Worker
 * requests again, even when the browser's own HTTP cache has evicted the files
 * (iOS does this aggressively — a 20 MB-ish window). Cache Storage is separate
 * from the HTTP cache, so it survives that eviction.
 *
 * Rules:
 *   /api/*  -> network only. Freshness matters: a new photo must appear.
 *   /i/*    -> cache first, but only images under 1.5 MB (never a 80 MB clip)
 *   static  -> cache first (HTML/JS/CSS/art), refreshed in the background
 */

const SHELL = 'wedding-shell-v3';
const MEDIA = 'wedding-media-v3';
const SHELL_FILES = [
  './',
  './app.js',
  './styles.css',
  './util.js',
  './zip.js',
  './art/logo.webp',
  './art/divider.webp',
];
const MEDIA_LIMIT = 1.5 * 1024 * 1024;

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(SHELL)
      .then((cache) => cache.addAll(SHELL_FILES))
      .catch(() => {})
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== SHELL && k !== MEDIA).map((k) => caches.delete(k)))
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // never cache the mutable API: the album must show new photos immediately
  // (`/api/page` is the exception: its URL is the set of photo keys, so the same
  //  URL always means the same bytes and can be cached like a static file)
  if (url.pathname === '/api/page') {
    event.respondWith(
      caches.open(MEDIA).then(async (cache) => {
        const hit = await cache.match(req);
        if (hit) return hit;
        const res = await fetch(req);
        if (res.ok) cache.put(req, res.clone()).catch(() => {});
        return res;
      })
    );
    return;
  }
  if (url.pathname.startsWith('/api/')) return;

  // photos: cache first, images only, size-capped
  if (url.pathname.startsWith('/i/')) {
    event.respondWith(
      caches.open(MEDIA).then(async (cache) => {
        const hit = await cache.match(req);
        if (hit) return hit;
        const res = await fetch(req);
        const type = res.headers.get('content-type') || '';
        const len = Number(res.headers.get('content-length') || 0);
        if (res.ok && type.startsWith('image/') && len > 0 && len <= MEDIA_LIMIT) {
          cache.put(req, res.clone()).catch(() => {});
        }
        return res;
      })
    );
    return;
  }

  // the shell: cache first, then refresh in the background
  event.respondWith(
    caches.match(req).then((hit) => {
      const network = fetch(req)
        .then((res) => {
          if (res.ok) caches.open(SHELL).then((c) => c.put(req, res.clone())).catch(() => {});
          return res;
        })
        .catch(() => hit);
      return hit || network;
    })
  );
});
