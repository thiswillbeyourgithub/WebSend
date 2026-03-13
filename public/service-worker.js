/**
 * ImageSecureSend Service Worker
 *
 * Caches static assets for offline fallback and enables PWA installation.
 * Uses a "network-first" strategy for all assets:
 * - Always fetch from network to ensure latest version
 * - Fall back to cache only when network is unavailable
 *
 * Note: The app requires network for WebRTC signaling, so serving
 * the freshest assets from network costs nothing extra.
 */

const CACHE_NAME = 'imagesecuresend-v1';

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
    '/js/sdp-compress.js',
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

// Fetch event: network-first for all assets
self.addEventListener('fetch', (event) => {
    const url = new URL(event.request.url);

    // Skip non-GET requests (WebSocket upgrades, POST, etc.)
    if (event.request.method !== 'GET') {
        return;
    }

    // API requests: network only (signaling requires fresh data)
    if (url.pathname.startsWith('/api/')) {
        event.respondWith(fetch(event.request));
        return;
    }

    // All assets: network-first, cache fallback
    event.respondWith(
        fetch(event.request).then((networkResponse) => {
            // Update cache with fresh response
            if (networkResponse.ok) {
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
