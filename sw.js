/*
 * Sahrae Predictor service worker.
 *
 * Strategy:
 *  - App shell (index.html): network-first, falling back to the cached copy so
 *    the SPA still boots offline.
 *  - Hashed build assets (/assets/*) and icons: cache-first (immutable).
 *  - Google Fonts: stale-while-revalidate.
 *  - Gemini API calls (generativelanguage.googleapis.com): never intercepted —
 *    live data and predictions must not be served stale from a SW cache.
 *    (Match data is persisted separately in localStorage by the app itself.)
 */

const VERSION = 'v1';
const SHELL_CACHE = `shell-${VERSION}`;
const ASSET_CACHE = `assets-${VERSION}`;
const FONT_CACHE = `fonts-${VERSION}`;

/**
 * Paths are resolved against the worker's own scope rather than the domain
 * root, so the same build works whether it is served from a root domain, a
 * GitHub Pages project subdirectory, or the Capacitor WebView.
 */
const SCOPE = new URL('./', self.registration.scope).pathname;
const SHELL_URL = SCOPE;

const PRECACHE_URLS = [
  SCOPE,
  SCOPE + 'manifest.webmanifest',
  SCOPE + 'icons/icon-192.png',
  SCOPE + 'icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE)
      // Individually, so one missing asset cannot fail the whole install.
      .then((cache) => Promise.allSettled(PRECACHE_URLS.map((u) => cache.add(u))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  const keep = [SHELL_CACHE, ASSET_CACHE, FONT_CACHE];
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => !keep.includes(k)).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // Never touch Gemini / Google API traffic.
  if (url.hostname.endsWith('googleapis.com') && !url.hostname.startsWith('fonts.')) {
    return;
  }

  // SPA navigations: network-first with cached shell fallback.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          caches.open(SHELL_CACHE).then((cache) => cache.put(SHELL_URL, copy));
          return response;
        })
        .catch(() => caches.match(SHELL_URL))
    );
    return;
  }

  // Google Fonts: stale-while-revalidate.
  if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') {
    event.respondWith(
      caches.open(FONT_CACHE).then(async (cache) => {
        const cached = await cache.match(request);
        const network = fetch(request)
          .then((response) => {
            if (response.ok) cache.put(request, response.clone());
            return response;
          })
          .catch(() => cached);
        return cached || network;
      })
    );
    return;
  }

  // Same-origin static assets: cache-first (Vite fingerprints /assets/*).
  if (url.origin === self.location.origin) {
    event.respondWith(
      caches.open(ASSET_CACHE).then(async (cache) => {
        const cached = await cache.match(request);
        if (cached) return cached;
        const response = await fetch(request);
        if (response.ok && (url.pathname.startsWith(SCOPE + 'assets/') || url.pathname.startsWith(SCOPE + 'icons/'))) {
          cache.put(request, response.clone());
        }
        return response;
      })
    );
  }
});
