/**
 * ImageSecureSend Service Worker
 *
 * Caches static assets for faster loading and enables PWA installation.
 * Uses a "stale-while-revalidate" strategy for most assets:
 * - Return cached version immediately (fast)
 * - Fetch fresh version in background and update cache
 *
 * Note: The app requires network for WebRTC signaling, so true offline
 * mode won't work. But the UI shell loads instantly from cache.
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

// Fetch event: stale-while-revalidate for static assets, network-first for API
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

    // Static assets: stale-while-revalidate
    event.respondWith(
        caches.open(CACHE_NAME).then((cache) => {
            return cache.match(event.request).then((cachedResponse) => {
                // Fetch fresh version in background
                const fetchPromise = fetch(event.request).then((networkResponse) => {
                    // Only cache successful responses
                    if (networkResponse.ok) {
                        cache.put(event.request, networkResponse.clone());
                    }
                    return networkResponse;
                }).catch(() => {
                    // Network failed, return cached if available
                    return cachedResponse;
                });

                // Return cached immediately, or wait for network
                return cachedResponse || fetchPromise;
            });
        })
    );
});
