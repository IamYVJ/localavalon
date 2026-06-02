// ============================================================================
// sw.js — Service worker. Precaches the full app shell so the site loads
// instantly and works offline after the first visit.
//
// All precache paths are RELATIVE so the worker functions correctly under a
// GitHub Pages subpath (e.g. https://user.github.io/localavalon/). The SW's
// scope is its own directory, so relative URLs resolve against that.
//
// NOTE: caching the shell does NOT make multiplayer fully offline — PeerJS
// still needs to reach a signaling broker to set up the WebRTC handshake.
// See js/net.js for self-hosting a broker on the LAN.
// ============================================================================

// Bump this version to invalidate old caches on the next activate.
const CACHE = 'localavalon-v16';

// Core app shell (same-origin). Relative to the SW's scope.
const SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/styles.css',
  './js/main.js',
  './js/net.js',
  './js/state.js',
  './js/rules.js',
  './js/ui.js',
  './js/util.js',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable.png',
];

// Cross-origin assets we want available offline (fonts CSS + PeerJS lib). The
// actual font files are cached lazily at runtime on first fetch.
const EXTERNAL = [
  'https://unpkg.com/peerjs@1.5.4/dist/peerjs.min.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // Same-origin shell: fail the install if any of these are missing.
    await cache.addAll(SHELL);
    // External libs: best-effort (don't block install if a CDN hiccups).
    await Promise.allSettled(EXTERNAL.map((url) =>
      fetch(url, { mode: 'cors' }).then((r) => r.ok && cache.put(url, r.clone()))
    ));
    self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  const sameOrigin = url.origin === self.location.origin;

  // SPA navigations: network-first so the freshest HTML wins, cached shell as
  // an offline fallback.
  if (req.mode === 'navigate') {
    event.respondWith(networkFirst(req, './index.html'));
    return;
  }

  // App CODE (our own HTML/JS/CSS) is network-first: when online, always run the
  // latest build — this is what prevents users getting stuck on a stale version
  // even if the cache version wasn't bumped. Falls back to cache when offline.
  const isAppCode = sameOrigin && (
    req.destination === 'script' || req.destination === 'style' || req.destination === 'document' ||
    /\.(?:js|css|html)$/.test(url.pathname)
  );
  if (isAppCode) {
    event.respondWith(networkFirst(req));
    return;
  }

  const isFont =
    url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com';
  const isCDN = url.hostname === 'unpkg.com';

  // Everything else — icons, manifest, fonts, the version-pinned PeerJS lib — is
  // immutable-ish, so cache-first for instant loads.
  if (sameOrigin || isFont || isCDN) {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE);
      const cached = await cache.match(req, { ignoreSearch: false });
      if (cached) return cached;
      try {
        const res = await fetch(req);
        // Cache successful & opaque (font) responses for next time.
        if (res && (res.ok || res.type === 'opaque')) cache.put(req, res.clone());
        return res;
      } catch (_) {
        return cached || Response.error();
      }
    })());
  }
  // Everything else (e.g. signaling/WebRTC) falls through to the network.
});

// Network-first: try the network, refresh the cache on success, fall back to
// the cache (and optionally a named fallback) when the network is unavailable.
async function networkFirst(req, fallbackKey) {
  const cache = await caches.open(CACHE);
  try {
    const res = await fetch(req);
    if (res && res.ok) cache.put(req, res.clone());
    return res;
  } catch (_) {
    const cached = await cache.match(req, { ignoreSearch: false });
    if (cached) return cached;
    if (fallbackKey) {
      return (await cache.match(fallbackKey)) || (await cache.match('./')) || Response.error();
    }
    return Response.error();
  }
}
