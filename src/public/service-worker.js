/**
 * WebSend Service Worker
 *
 * Caches static assets for offline fallback and enables PWA installation.
 * Uses a "network-first" strategy for all assets:
 * - Always fetch from network to ensure latest version
 * - Fall back to cache only when network is unavailable
 *
 * Note: The app requires network for WebRTC signaling, so serving
 * the freshest assets from network costs nothing extra.
 */

// Bumping CACHE_NAME forces the activate handler below to drop every
// pre-existing cache, which is the only way to clear out cross-origin
// responses that earlier SW versions may have stored before this
// version restricted caching to same-origin basic responses.
const CACHE_NAME = 'websend-v2';

// Static assets to cache on install
const STATIC_ASSETS = [
    '/',
    '/index.html',
    '/receive.html',
    '/send.html',
    '/css/style.css',
    '/js/i18n.js',
    '/js/logger.js',
    '/js/crypto.js',
    '/js/webrtc.js',
    '/js/qrcode.min.js',
    '/js/jsqr.min.js',
    '/icons/icon-192.png',
    '/icons/icon-512.png',
    '/manifest.json'
];

// Install event: cache static assets
self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME).then((cache) => {
            console.log('[SW] Caching static assets');
            return cache.addAll(STATIC_ASSETS);
        })
    );
    // Activate immediately without waiting for old SW to finish
    self.skipWaiting();
});

// Activate event: clean up old caches
self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then((cacheNames) => {
            return Promise.all(
                cacheNames
                    .filter((name) => name !== CACHE_NAME)
                    .map((name) => {
                        console.log('[SW] Deleting old cache:', name);
                        return caches.delete(name);
                    })
            );
        })
    );
    // Take control of all clients immediately
    self.clients.claim();
});

// Fetch event: network-first for same-origin assets only.
//
// Cross-origin requests (e.g. an admin-configured Umami tracker) are
// deliberately NOT intercepted: if upstream is ever compromised and the
// SW had cached the bad response, every user would keep running the
// compromised script offline even after the upstream is fixed. Letting
// the browser handle cross-origin directly means a fix at the source is
// effective for everyone on their next online load.
self.addEventListener('fetch', (event) => {
    // Skip non-GET requests (WebSocket upgrades, POST, etc.)
    if (event.request.method !== 'GET') {
        return;
    }

    const url = new URL(event.request.url);

    // Skip cross-origin entirely (see comment above).
    if (url.origin !== self.location.origin) {
        return;
    }

    // API requests: network only (signaling requires fresh data)
    if (url.pathname.startsWith('/api/')) {
        event.respondWith(fetch(event.request));
        return;
    }

    // Same-origin assets: network-first, cache fallback.
    event.respondWith(
        fetch(event.request).then((networkResponse) => {
            // Only cache successful, same-origin, non-opaque responses.
            // `response.type === 'basic'` rules out opaque/cors/error
            // responses so we never persist something we cannot validate.
            // Browser-level SRI on <script integrity> still rejects any
            // tampered cached body at execution time; this is the
            // belt-and-braces layer that prevents storing it in the
            // first place.
            if (networkResponse.ok && networkResponse.type === 'basic') {
                const responseClone = networkResponse.clone();
                caches.open(CACHE_NAME).then((cache) => {
                    cache.put(event.request, responseClone);
                });
            }
            return networkResponse;
        }).catch(() => {
            // Network failed, try cache
            return caches.match(event.request);
        })
    );
});
