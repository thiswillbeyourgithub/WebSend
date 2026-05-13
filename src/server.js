/**
 * Express server for WebSend
 * Serves static files, provides ICE configuration, and acts as a signaling server
 * for WebRTC SDP offer/answer exchange.
 */

const express = require('express');
const crypto = require('crypto');
const path = require('path');
const http = require('http');
const { WebSocketServer } = require('ws');
const { version: APP_VERSION } = require('./package.json');
const helpers = require('./server-helpers');

const app = express();
const PORT = parseInt(process.env.PORT, 10) || 8080;
const DOMAIN = process.env.DOMAIN || 'localhost';
// DEV mode: when 1, enables verbose debug logging for handshake/connection troubleshooting
const DEV = process.env.DEV === '1';

// ============ Analytics (Umami) ============
// Privacy-preserving analytics via Umami. Only enabled when both URL and website ID are set.
// UMAMI_URL: base URL of the Umami instance (e.g., https://u.example.org)
const UMAMI_URL = process.env.UMAMI_URL || '';
// UMAMI_WEBSITE_ID: the data-website-id for the Umami tracking script
const UMAMI_WEBSITE_ID = process.env.UMAMI_WEBSITE_ID || '';
// UMAMI_DNT: whether to respect Do Not Track browser setting ("true" or "false", default: "true")
const UMAMI_DNT = process.env.UMAMI_DNT || 'true';

// Pre-compute the Umami origin (scheme + host + port, no path) so we can
// extend the CSP script-src / connect-src / img-src to allow loading the
// tracker and posting events back to it. If UMAMI_URL is malformed,
// `new URL` throws and we leave UMAMI_ORIGIN empty; the strict validation
// below (UMAMI_URL_RE) will then exit() before any request is served.
let UMAMI_ORIGIN = '';
if (UMAMI_URL) {
    try { UMAMI_ORIGIN = new URL(UMAMI_URL).origin; } catch { /* validated later */ }
}

// OCR settings (scribe.js)
const OCR_LANGS = process.env.OCR_LANGS || 'eng,fra';
const OCR_PSM = process.env.OCR_PSM || '12';

// ALLOWED_FILE_TYPES: controls which file types can be sent.
// ONLY_IMAGES = only image/* files (original behavior)
// IMAGE_OR_PDF = image/* plus application/pdf
// ANY = any file type (default)
const ALLOWED_FILE_TYPES = (process.env.ALLOWED_FILE_TYPES || 'ANY').toUpperCase();

// ============ ICE Server Configuration ============
// STUN_SERVER: optional self-hosted STUN server (host:port)
const STUN_SERVER = process.env.STUN_SERVER || '';
// STUN_GOOGLE_FALLBACK: whether to include Google's public STUN as fallback (default: true)
const STUN_GOOGLE_FALLBACK = process.env.STUN_GOOGLE_FALLBACK !== 'false';
// TURN_SERVER: optional TURN relay server (host:port)
const TURN_SERVER = process.env.TURN_SERVER || '';
// TURN_SECRET: shared secret for time-based TURN credentials
const TURN_SECRET = process.env.TURN_SECRET || '';
// TURN_CREDENTIAL_TTL: how long TURN credentials are valid (default: 1 hour)
const TURN_CREDENTIAL_TTL = parseInt(process.env.TURN_CREDENTIAL_TTL, 10) || 3600;
// TURN_TIMEOUT: WebRTC connection timeout in seconds (default: 15s)
const TURN_TIMEOUT = parseInt(process.env.TURN_TIMEOUT, 10) || 15;
// TURNS_PORT: if set, a turns: (TURN-over-TLS) URL is added to ICE candidates,
// allowing WebRTC to traverse corporate firewalls that block non-HTTPS ports.
const TURNS_PORT = process.env.TURNS_PORT || '';
// RELAY_ENABLE: when truthy (default), expose the HTTP-relay fallback transport
// at /api/rooms/:id/relay (WebSocket) and the long-poll variants (commit 4).
// The relay forwards opaque encrypted bytes between two paired peers; the same
// end-to-end ECDH+AES-GCM crypto is used, so the server never sees plaintext.
// This is the corporate-network fallback path when both UDP and TURNS are
// blocked. Set RELAY_ENABLE=false to disable (back to WebRTC-only behavior).
// TODO: revisit default before production rollout once soak-tested.
const RELAY_ENABLE = (process.env.RELAY_ENABLE || 'true').toLowerCase() !== 'false';
// DEV_FORCE_CONNECTION: force a specific ICE transport for debugging.
// Valid values: DIRECT, STUN, GOOGLE_STUN, TURN, TURNS, ALL (default).
// DIRECT = no ICE servers (LAN host candidates only)
// STUN = self-hosted STUN only
// GOOGLE_STUN = Google's public STUN only
// TURN = TURN UDP+TCP relay only (forces iceTransportPolicy: relay)
// TURNS = TURN-over-TLS only (forces iceTransportPolicy: relay)
// ALL or unset = normal behavior (all configured servers)
const DEV_FORCE_CONNECTION = (process.env.DEV_FORCE_CONNECTION || 'DEFAULT').toUpperCase();

// DEV_FORCE_CONNECTION filter table: each mode picks a subset of the configured
// iceServers for transport-isolation debugging. `forceRelay: true` triggers
// iceTransportPolicy:'relay' on the response so STUN discovery is skipped.
function filterStunString(predicate) {
    return (servers) => servers.filter(s => typeof s.urls === 'string' && predicate(s.urls));
}
function filterTurnArray(predicate) {
    return (servers) => servers
        .filter(s => Array.isArray(s.urls))
        .map(s => ({ ...s, urls: s.urls.filter(predicate) }))
        .filter(s => s.urls.length > 0);
}
const FORCE_FILTERS = {
    DIRECT:      { filter: () => [],                                                                forceRelay: false },
    STUN:        { filter: filterStunString(u => u.startsWith('stun:') && !u.includes('google')),   forceRelay: false },
    GOOGLE_STUN: { filter: filterStunString(u => u.includes('stun.l.google.com')),                  forceRelay: false },
    TURN:        { filter: filterTurnArray(u => u.startsWith('turn:') && !u.startsWith('turns:')),  forceRelay: true  },
    TURNS:       { filter: filterTurnArray(u => u.startsWith('turns:')),                            forceRelay: true  },
    // RELAY_HTTPS: forces the HTTP-relay fallback path (WS / LP) to win
    // the transport race by suppressing every ICE server so WebRTC has
    // no path to connect. The client side reads forceConnection in
    // /api/config and short-circuits the race-grace window.
    RELAY_HTTPS: { filter: () => [],                                                                forceRelay: false },
};
FORCE_FILTERS.TURN_TLS = FORCE_FILTERS.TURNS;

/**
 * Debug logging helper - only logs when DEV=1
 * @param {string} context - Log context (e.g., 'ROOM', 'ICE', 'SIGNALING')
 * @param {string} message - Log message
 * @param {Object} [data] - Optional data to log
 */
function debugLog(context, message, data = null) {
    if (!DEV) return;
    const timestamp = new Date().toISOString();
    const dataStr = data ? ` | ${JSON.stringify(data)}` : '';
    console.log(`[${timestamp}] [DEBUG:${context}] ${message}${dataStr}`);
}

// ALLOWED_ORIGINS: comma-separated list of allowed origins for Origin header validation.
// If not set, defaults to https://{DOMAIN} and http://{DOMAIN} (for local dev).
// Example: ALLOWED_ORIGINS=https://share.example.com,https://backup.example.com
const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS
    ? process.env.ALLOWED_ORIGINS.split(',').map(o => o.trim())
    : [`https://${DOMAIN}`, `http://${DOMAIN}`];

// Trust proxy headers only from loopback (Caddy runs on same host).
// This ensures X-Forwarded-For cannot be spoofed by external clients.
app.set('trust proxy', 'loopback');

// ============ Defensive HTTP Headers ============
// Defense-in-depth headers applied to every response. These do not replace
// any existing protection (encryption, SRI, origin validation, CSRF-via-
// custom-header) but are the cheap belts-and-braces layer that buys us
// resilience against XSS / clickjacking / cross-origin leak vectors that
// future code changes could otherwise re-introduce silently.
//
// Notes:
//  - script-src includes 'unsafe-inline' because receive.html / send.html
//    still have large inline <script> blocks. Removing those is a separate
//    refactor (move them to dedicated .js files with SRI) that would let
//    us drop 'unsafe-inline'. Even with it, CSP still blocks remote script
//    injection (cross-origin), object/embed, framing, form posts, etc.
//  - 'wasm-unsafe-eval' is required so scribe.js-ocr's tesseract-core
//    WebAssembly modules can be compiled/instantiated. It permits WASM
//    compilation only, NOT general eval() (much narrower than 'unsafe-eval').
//  - style-src 'unsafe-inline' is needed because the HTML uses inline
//    style="..." attributes and a <style> block; same future cleanup path.
//  - blob: is allowed in img-src/media-src/worker-src because the
//    receiver builds blob: URLs from decrypted-then-octet-stream-wrapped
//    bytes, and scribe.js ships a worker bundle that loads via blob:.
//  - frame-ancestors 'none' replaces X-Frame-Options for browsers that
//    honour CSP; we still set X-Frame-Options for older clients.
//  - The COOP/CORP pair isolates this origin's window from cross-origin
//    openers and prevents other origins from embedding our resources.
// Extend script-src + connect-src + img-src with the Umami origin only
// when configured. Tracker loads from `${UMAMI_URL}/getinfo` (script) and
// POSTs events to the same origin (connect); some Umami themes also use
// 1px image beacons, so include img-src for safety.
const _umamiSrc = UMAMI_ORIGIN ? ` ${UMAMI_ORIGIN}` : '';
const CSP_DIRECTIVES = [
    "default-src 'self'",
    `script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'${_umamiSrc}`,
    "style-src 'self' 'unsafe-inline'",
    `img-src 'self' blob: data:${_umamiSrc}`,
    "media-src 'self' blob:",
    `connect-src 'self'${_umamiSrc}`,
    "worker-src 'self' blob:",
    "child-src 'self' blob:",
    "font-src 'self' data:",
    "manifest-src 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'none'",
].join('; ');

app.use((req, res, next) => {
    res.setHeader('Content-Security-Policy', CSP_DIRECTIVES);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    // Hash fragment carries the room secret; suppress full-URL leaks
    // even though most browsers already strip fragments from Referer.
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    res.setHeader('Permissions-Policy', 'interest-cohort=(), browsing-topics=()');
    next();
});

// Parse JSON bodies
app.use(express.json({ limit: '50kb' }));

// In-memory room storage (in production, use Redis or similar)
const rooms = new Map();
const ROOM_TTL = 10 * 60 * 1000; // 10 minutes TTL

// Server-side mirror of the protocol.js anti-DoS caps. These are enforced on
// the HTTP-relay transport (commits 2 + 4) so a hostile client cannot ignore
// the client-side bounds and force the relay container to forward unbounded
// bytes between paired peers. Keep these in sync with public/js/protocol.js.
const MAX_TOTAL_SESSION_BYTES = 4 * 1024 * 1024 * 1024; // 4 GiB
const MAX_CONTROL_MSG_BYTES = 16 * 1024; // 16 KiB

// Long-poll relay constants (commit 4). The LP transport uses two HTTP
// endpoints (POST /relay/up, GET /relay/down) per slot. Each slot is
// claimed by a one-shot token issued by the /relay/handshake endpoint.
const LP_DOWN_TIMEOUT_MS = 25_000;          // long-poll hold time
const LP_QUEUE_MAX_FRAMES = 32;             // bounded per-slot incoming queue
const LP_SLOT_TOKEN_BYTES = 16;             // 128-bit slot token
// Per-frame body cap on /relay/up. 256 KiB gives ~16x headroom over
// CHUNK_SIZE (16 KiB) for future protocol additions while keeping a
// hostile peer's max-body footprint bounded. MAX_TOTAL_SESSION_BYTES
// (4 GiB) is the session-level ceiling on top of this.
const LP_FRAME_BODY_LIMIT = '256kb';
const LP_SLOT_IDLE_TIMEOUT_MS = 60_000;     // close LP slot after this idle

// ============ Rate Limiting ============
// Simple sliding window rate limiter to prevent DoS and room enumeration attacks.
// Uses in-memory storage; in production, use Redis for distributed rate limiting.

// LRU-bounded rate limiter store. Uses Map insertion order: get() touches a key
// (delete + re-set) so it becomes most-recently-used; set() evicts the oldest
// key when at cap. O(1) per touch/insert/evict, vs. the previous O(n) scan that
// fired on every new key once the map saturated under a wide-source flood.
const RATE_LIMITERS_MAX = 10_000;

class LruMap {
    constructor(max) {
        this.max = max;
        this.map = new Map();
    }
    get size() { return this.map.size; }
    has(key) { return this.map.has(key); }
    get(key) {
        if (!this.map.has(key)) return undefined;
        const value = this.map.get(key);
        this.map.delete(key);
        this.map.set(key, value);
        return value;
    }
    set(key, value) {
        if (this.map.has(key)) {
            this.map.delete(key);
        } else if (this.map.size >= this.max) {
            const oldestKey = this.map.keys().next().value;
            this.map.delete(oldestKey);
        }
        this.map.set(key, value);
    }
    delete(key) { return this.map.delete(key); }
    entries() { return this.map.entries(); }
}

const rateLimiters = new LruMap(RATE_LIMITERS_MAX); // key=`${ip}:${limitType}` -> { timestamps: [], blockedUntil: null }

const RATE_LIMIT_CONFIG = {
    // Room creation: 5 rooms per minute per IP (prevents room flooding)
    roomCreation: { windowMs: 60 * 1000, maxRequests: 5 },
    // Room lookup: 30 requests per minute per IP (prevents enumeration)
    roomLookup: { windowMs: 60 * 1000, maxRequests: 30 },
    // General API: 100 requests per minute per IP
    general: { windowMs: 60 * 1000, maxRequests: 100 }
};

/**
 * Get client IP from Express request.
 * Uses req.ip which respects the 'trust proxy' setting - it will use
 * X-Forwarded-For only when the request comes from a trusted proxy (loopback).
 * @param {Request} req - Express request
 * @returns {string} Client IP address
 */
function getClientIp(req) {
    return req.ip || 'unknown';
}

/**
 * Check and update rate limit for a given IP and limit type
 * @param {string} ip - Client IP
 * @param {string} limitType - One of: 'roomCreation', 'roomLookup', 'general'
 * @returns {object} { allowed: boolean, retryAfter: number (seconds) }
 */
function checkRateLimit(ip, limitType) {
    const config = RATE_LIMIT_CONFIG[limitType];
    const now = Date.now();
    const key = `${ip}:${limitType}`;

    if (!rateLimiters.has(key)) {
        rateLimiters.set(key, { timestamps: [], blockedUntil: null });
    }

    const limiter = rateLimiters.get(key);

    // Check if currently blocked
    if (limiter.blockedUntil && now < limiter.blockedUntil) {
        const retryAfter = Math.ceil((limiter.blockedUntil - now) / 1000);
        return { allowed: false, retryAfter };
    }

    // Clear block if expired
    if (limiter.blockedUntil && now >= limiter.blockedUntil) {
        limiter.blockedUntil = null;
        limiter.timestamps = [];
    }

    // Remove timestamps outside the window
    const windowStart = now - config.windowMs;
    limiter.timestamps = limiter.timestamps.filter(ts => ts > windowStart);

    // Check if limit exceeded
    if (limiter.timestamps.length >= config.maxRequests) {
        // Block for the remainder of the window
        limiter.blockedUntil = now + config.windowMs;
        const retryAfter = Math.ceil(config.windowMs / 1000);
        return { allowed: false, retryAfter };
    }

    // Allow request and record timestamp
    limiter.timestamps.push(now);
    return { allowed: true, retryAfter: 0 };
}

/**
 * Express middleware factory for rate limiting
 * @param {string} limitType - Rate limit type to apply
 * @returns {Function} Express middleware
 */
// Test-only escape hatch: bypass rate limits when TEST_DISABLE_RATE_LIMIT=1.
// Not documented in env.example because it weakens DoS protection — tests only.
const RATE_LIMIT_DISABLED = process.env.TEST_DISABLE_RATE_LIMIT === '1';

function rateLimitMiddleware(limitType) {
    return (req, res, next) => {
        if (RATE_LIMIT_DISABLED) return next();
        const ip = getClientIp(req);
        const result = checkRateLimit(ip, limitType);

        if (!result.allowed) {
            res.set('Retry-After', result.retryAfter);
            return res.status(429).json({
                error: 'Too many requests',
                retryAfter: result.retryAfter
            });
        }

        next();
    };
}

/**
 * Clean up old rate limiter entries periodically
 */
function cleanupRateLimiters() {
    const now = Date.now();
    const maxAge = 2 * 60 * 1000; // Remove entries older than 2 minutes

    for (const [key, limiter] of rateLimiters.entries()) {
        // Remove if no recent timestamps and not blocked
        const hasRecentActivity = limiter.timestamps.some(ts => now - ts < maxAge);
        const isBlocked = limiter.blockedUntil && now < limiter.blockedUntil;

        if (!hasRecentActivity && !isBlocked) {
            rateLimiters.delete(key);
        }
    }
}

// Clean up rate limiters every 30 seconds (maxAge is 2 min, so entries expire
// at most 2.5 min after their last request — acceptable memory bound).
setInterval(cleanupRateLimiters, 30 * 1000);

// ============ Origin Validation ============
// Validates that requests come from expected origins to prevent malicious sites
// from connecting to the signaling server (CSRF-like protection for APIs).

/**
 * Middleware to validate Origin header against allowed origins.
 * Blocks requests from unexpected origins with 403 Forbidden.
 * Allows requests without Origin header (e.g., direct curl/Postman calls)
 * since those can't abuse browser credentials anyway.
 * @param {Request} req - Express request
 * @param {Response} res - Express response
 * @param {Function} next - Next middleware
 */
function validateOrigin(req, res, next) {
    const origin = req.headers.origin;

    // No Origin header = not a browser cross-origin request (e.g., curl, direct navigation)
    // These are safe since they can't access browser cookies/state
    if (!origin) {
        return next();
    }

    // Check if origin is in allowed list
    if (ALLOWED_ORIGINS.includes(origin)) {
        return next();
    }

    // Origin present but not allowed - reject
    console.warn(`Blocked request from unauthorized origin: ${origin} (allowed: ${ALLOWED_ORIGINS.join(', ')})`);
    return res.status(403).json({
        error: 'Forbidden',
        message: 'Request origin not allowed'
    });
}

// Apply origin validation to all API routes
app.use('/api', validateOrigin);

// /api/* responses are per-request signaling state (room offer/answer/ICE,
// active-room counts, TURN credentials) and must not be cached anywhere
// downstream. Without this a misbehaving CDN or browser cache could serve
// stale offers / re-issue expired TURN credentials, or surface another
// session's state to a different user. Setting it here (before the route
// handlers) ensures every /api/* response carries the directive even if a
// future handler forgets.
app.use('/api', (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
});

/**
 * Middleware to validate room secret from X-Room-Secret header.
 *
 * Defense-in-depth: returns the same 401 status and generic message for
 * three distinct failure modes (room missing, secret missing, secret
 * mismatch) so an attacker without the secret cannot enumerate which
 * roomIds are live by probing. We still run secureCompare against a
 * dummy when the room is missing so the timing of the response does not
 * leak room existence either. The 22-char base64url secret is the real
 * defense; this just removes the cheap oracle in front of it.
 */
const _DUMMY_SECRET = 'dummy-secret-for-constant-time-compare';
function validateRoomSecret(req, res, next) {
    const room = rooms.get(req.params.id);
    const providedSecret = req.headers['x-room-secret'] || '';
    const compareTarget = room ? room.secret : _DUMMY_SECRET;
    const ok = providedSecret && helpers.secureCompare(providedSecret, compareTarget);
    if (!room || !ok) {
        return res.status(401).json({ error: 'Invalid or missing room secret' });
    }

    // Attach room to request for use in handler
    req.room = room;
    next();
}

/**
 * Clean up expired rooms periodically
 */
function cleanupRooms() {
    const now = Date.now();
    for (const [id, room] of rooms.entries()) {
        if (now - room.created > ROOM_TTL) {
            // Drain pending long-pollers with 404 before deleting the room.
            // Each waiter's settle() decrements _totalWaiters, so the global
            // counter stays consistent across normal and TTL-expiry paths.
            if (room.answerWaiters && room.answerWaiters.length) {
                const waiters = room.answerWaiters.splice(0);
                for (const w of waiters) w.roomGone();
            }
            // Close any relay slots on TTL expiry so dangling WS or LP
            // peers do not outlive the room map entry they reference.
            if (room.relay) {
                for (const slotName of ['a', 'b']) {
                    const s = room.relay[slotName];
                    if (!s) continue;
                    if (s.kind === 'lp') {
                        closeLpSlot(s, 'Room expired');
                    } else if (s.readyState !== s.CLOSED) {
                        try { s.close(1001, 'Room expired'); } catch (_) {}
                    }
                }
                room.relay = null;
            }
            rooms.delete(id);
            console.log(`Room ${id} expired and removed`);
        }
    }
}

// Long-poll waiter caps. Each waiter on /api/rooms/:id/answer pins a TCP
// socket, an Express response, a setTimeout handle, and a closure for up to
// TIMEOUT_MS. Without a cap, any client holding a valid room secret can
// pipeline thousands of `?wait=true` requests over a single HTTP/2 connection
// and exhaust server memory and FDs. Three layered caps:
//   - MAX_WAITERS_PER_ROOM bounds a single attacker focusing on one room.
//   - MAX_TOTAL_WAITERS bounds a many-room or many-IP attacker.
//   - rateLimitMiddleware('general') bounds the request rate per IP.
// Legitimate use is at most one in-flight long-poll per peer, with a brief
// transient overlap during reconnect, so 4 per room is generous.
const MAX_WAITERS_PER_ROOM = 4;
const MAX_TOTAL_WAITERS = 10_000;
let _totalWaiters = 0;

// Run cleanup every minute
setInterval(cleanupRooms, 60 * 1000);

// ============ Umami Analytics Injection ============
// When Umami is configured, serve HTML files with the tracking script injected
// before </head>. This avoids modifying static HTML files and keeps analytics
// config server-side. Non-HTML static files are served normally below.
const fs = require('fs');

if (UMAMI_URL && UMAMI_WEBSITE_ID) {
    // Validate before HTML interpolation: these values are spliced raw into a
    // <script> tag served on every page, so a value containing `"`, `>`, or
    // whitespace would break the page or open a script-injection vector.
    const UMAMI_URL_RE = /^https?:\/\/[a-z0-9._\-]+(:\d+)?(\/[a-zA-Z0-9._~\-\/]*)?$/i;
    const UMAMI_ID_RE = /^[a-zA-Z0-9\-]{1,64}$/;
    const UMAMI_DNT_RE = /^(true|false)$/;
    if (!UMAMI_URL_RE.test(UMAMI_URL)) {
        console.error(`FATAL: UMAMI_URL is not a valid URL: ${JSON.stringify(UMAMI_URL)}`);
        console.error('Expected format: https://host[:port][/path] with no quotes or whitespace.');
        process.exit(1);
    }
    if (!UMAMI_ID_RE.test(UMAMI_WEBSITE_ID)) {
        console.error(`FATAL: UMAMI_WEBSITE_ID must match /^[a-zA-Z0-9-]{1,64}$/, got: ${JSON.stringify(UMAMI_WEBSITE_ID)}`);
        process.exit(1);
    }
    if (!UMAMI_DNT_RE.test(UMAMI_DNT)) {
        console.error(`FATAL: UMAMI_DNT must be "true" or "false", got: ${JSON.stringify(UMAMI_DNT)}`);
        process.exit(1);
    }

    const umamiScript = `    <script defer src="${UMAMI_URL}/getinfo" data-website-id="${UMAMI_WEBSITE_ID}" data-do-not-track="${UMAMI_DNT}"></script>\n`;

    // Read each HTML file once at startup, inject the analytics snippet,
    // and serve the cached string. Avoids a disk read per request.
    const htmlSources = {
        'index.html': path.join(__dirname, 'public', 'index.html'),
        'send.html': path.join(__dirname, 'public', 'send.html'),
        'receive.html': path.join(__dirname, 'public', 'receive.html'),
    };
    const cachedHtml = new Map();
    for (const [name, filePath] of Object.entries(htmlSources)) {
        let html;
        try {
            html = fs.readFileSync(filePath, 'utf8');
        } catch (e) {
            console.error(`FATAL: Umami enabled but could not read ${name} at ${filePath}: ${e.message}`);
            process.exit(1);
        }
        if (!html.includes('</head>')) {
            console.error(`FATAL: ${name} has no </head> — cannot inject Umami snippet`);
            process.exit(1);
        }
        cachedHtml.set(name, html.replace('</head>', umamiScript + '</head>'));
    }

    const routeToFile = {
        '/': 'index.html',
        '/index.html': 'index.html',
        '/send.html': 'send.html',
        '/receive.html': 'receive.html',
    };

    app.use((req, res, next) => {
        const file = routeToFile[req.path];
        if (!file) return next();
        res.type('html').send(cachedHtml.get(file));
    });
}

// Serve static files from public directory
app.use(express.static(path.join(__dirname, 'public')));

// Serve vendored libraries (scribe.js-ocr, client-zip, tessdata, etc.)
app.use('/vendor', express.static(path.join(__dirname, 'public', 'vendor')));
app.use('/scribe', express.static(path.join(__dirname, 'public', 'vendor', 'scribe.js-ocr')));
app.use('/tessdata', express.static(path.join(__dirname, 'public', 'vendor', 'tessdata')));

// Endpoint to get ICE server configuration
app.get('/api/config', (req, res) => {
    const iceServers = [];

    // Add self-hosted STUN server if configured
    if (STUN_SERVER) {
        iceServers.push({ urls: `stun:${STUN_SERVER}` });
        debugLog('CONFIG', `Using self-hosted STUN: ${STUN_SERVER}`);
    }

    // Add Google's public STUN as fallback if allowed
    if (STUN_GOOGLE_FALLBACK) {
        iceServers.push({ urls: 'stun:stun.l.google.com:19302' });
        debugLog('CONFIG', 'Google STUN fallback enabled');
    }

    // Add TURN server if configured (requires TURN_SECRET for credentials)
    if (TURN_SERVER && TURN_SECRET) {
        const { username, credential } = helpers.generateTurnCredentials(TURN_SECRET, TURN_CREDENTIAL_TTL);
        // Strip any :port from TURN_SERVER before composing the TURNS URL so
        // hostnames without an explicit port don't yield "turns:host?transport=tcp"
        // (a port-less URL that browsers either reject or default unpredictably).
        const turnHost = TURN_SERVER.replace(/:\d+$/, '');
        iceServers.push({
            urls: [
                `turn:${TURN_SERVER}?transport=udp`,
                `turn:${TURN_SERVER}?transport=tcp`,
                // TURNS (TURN-over-TLS) on a separate port, for networks blocking non-443/non-HTTPS traffic.
                // Drop ?transport=tcp: turns: is always TCP per RFC 7065, and the redundant param
                // has historically tripped some WebRTC stacks.
                ...(TURNS_PORT ? [`turns:${turnHost}:${TURNS_PORT}`] : [])
            ],
            username,
            credential
        });
        debugLog('CONFIG', `Using TURN server: ${TURN_SERVER}${TURNS_PORT ? ` (TURNS on port ${TURNS_PORT})` : ''}`, {
            credentialTTL: TURN_CREDENTIAL_TTL,
            username
        });
    } else if (TURN_SERVER && !TURN_SECRET) {
        // TURN_SERVER set but no secret - log warning
        console.warn('TURN_SERVER is set but TURN_SECRET is missing. TURN will not be available.');
    }

    // DEV_FORCE_CONNECTION: filter ICE servers to isolate a specific transport for debugging.
    // This lets you verify each connection method independently (e.g., confirm TURN works
    // before troubleshooting TURNS).
    let filteredServers = iceServers;
    let forceRelay = false;

    if (DEV_FORCE_CONNECTION !== 'DEFAULT') {
        debugLog('CONFIG', `DEV_FORCE_CONNECTION=${DEV_FORCE_CONNECTION}: filtering ICE servers`);

        const entry = FORCE_FILTERS[DEV_FORCE_CONNECTION];
        if (entry) {
            filteredServers = entry.filter(iceServers);
            forceRelay = entry.forceRelay;
        } else {
            console.warn(`Unknown DEV_FORCE_CONNECTION value: "${DEV_FORCE_CONNECTION}", using ALL`);
        }

        debugLog('CONFIG', `Filtered ICE servers (${DEV_FORCE_CONNECTION}):`, filteredServers);

        // Crash if the forced connection mode has no matching servers
        if (filteredServers.length === 0) {
            const serverRequirements = {
                'STUN': 'a self-hosted STUN server (TURN_SERVER)',
                'GOOGLE_STUN': 'Google STUN (should always be available — this is a bug)',
                'TURN': 'a TURN server (TURN_SERVER + TURN_SECRET)',
                'TURNS': 'a TURNS server (TURN_SERVER + TURN_SECRET + TURNS_PORT)',
                'TURN_TLS': 'a TURNS server (TURN_SERVER + TURN_SECRET + TURNS_PORT)',
            };
            const requirement = serverRequirements[DEV_FORCE_CONNECTION];
            if (requirement) {
                console.error(`FATAL: DEV_FORCE_CONNECTION=${DEV_FORCE_CONNECTION} but no matching ICE servers found.`);
                console.error(`This mode requires ${requirement}.`);
                process.exit(1);
            }
        }
    }

    // Warn if no ICE servers at all and we're not intentionally in DIRECT mode
    if (filteredServers.length === 0 && DEV_FORCE_CONNECTION !== 'DIRECT') {
        console.warn('No ICE servers configured! WebRTC connections will likely fail.');
    }

    // Note: domain is no longer returned; client uses window.location.origin
    res.json({
        iceServers: filteredServers,
        // iceTransportPolicy: 'relay' forces WebRTC to only use relay (TURN) candidates,
        // skipping direct and STUN-discovered paths. Only set when forcing TURN/TURNS.
        ...(forceRelay ? { iceTransportPolicy: 'relay' } : {}),
        forceConnection: DEV_FORCE_CONNECTION !== 'DEFAULT' ? DEV_FORCE_CONNECTION : undefined,
        dev: DEV,
        turnTimeout: TURN_TIMEOUT,
        version: APP_VERSION,
        ocrLangs: OCR_LANGS.split(',').map(l => l.trim()),
        ocrPsm: OCR_PSM,
        allowedFileTypes: ALLOWED_FILE_TYPES,
        // HTTP-relay fallback transport flag (commit 2). Clients open
        // a WebSocket to /api/rooms/:id/relay?secret=... when WebRTC
        // fails to connect within the 10s race window. The relay
        // forwards encrypted bytes verbatim; payload is still ECDH+
        // AES-GCM end-to-end encrypted.
        relayEnabled: RELAY_ENABLE
    });
});

// ============ Signaling API ============

/**
 * Create a new room
 * POST /api/rooms
 * Returns: { roomId: "ABC123" }
 * Rate limited: 5 rooms per minute per IP
 */
app.post('/api/rooms', rateLimitMiddleware('roomCreation'), (req, res) => {
    let roomId;
    // Ensure unique room ID. Bounded by MAX_ROOM_ID_TRIES so a future
    // pathological state (huge live-room set, broken RNG, etc.) cannot
    // turn this into an unbounded loop that pegs the event loop and
    // takes the server down. The roomId space (32^6 ≈ 10^9) plus the
    // 10-minute TTL means we should never hit this in practice.
    const MAX_ROOM_ID_TRIES = 32;
    let tries = 0;
    do {
        if (++tries > MAX_ROOM_ID_TRIES) {
            console.warn(`Room ID collision after ${MAX_ROOM_ID_TRIES} tries, refusing`);
            return res.status(503).json({ error: 'Server temporarily unable to allocate room id' });
        }
        roomId = helpers.generateRoomId();
    } while (rooms.has(roomId));

    // Generate cryptographic secret for room access authorization
    const secret = helpers.generateRoomSecret();

    rooms.set(roomId, {
        created: Date.now(),
        secret: secret,
        offer: null,
        answer: null,
        iceCandidatesOffer: [],
        iceCandidatesAnswer: [],
        // Pending long-poll resolvers waiting for `answer` to arrive.
        // Each entry: { send: (room) => void, timer: Timeout|null }.
        answerWaiters: [],
        // HTTP-relay fallback transport state. Lazily initialised by the
        // first /api/rooms/:id/relay WS upgrade (commit 2) or long-poll
        // handshake (commit 4). Shape: { a, b, sessionBytes, ... }.
        relay: null
    });

    console.log(`Room ${roomId} created`);
    debugLog('ROOM', `Room created`, { roomId, clientIp: getClientIp(req) });
    // Return both roomId and secret; secret is included in QR code URL
    res.json({ roomId, secret });
});

// Max SDP body size (per side). The 50kb express.json limit is the outer cap;
// this stricter per-field check rejects bloat that would otherwise be echoed
// to the peer verbatim.
const MAX_SDP_LEN = 20_000;

// Cap stored ICE candidates per side. Without this, a peer with the room
// secret could push up to general-rate-limit candidates per minute (each up
// to the 50KB body cap) for the room's TTL — tens of MB per room. 50 is well
// above the typical handful of host/srflx/relay candidates a real client
// generates.
const MAX_ICE_CANDIDATES = 50;
const MAX_ICE_CANDIDATE_LEN = 1024;
const MAX_ICE_MID_LEN = 16;
const MAX_ICE_UFRAG_LEN = 256;
const MAX_ICE_MLINE_INDEX = 32;

/**
 * Validate and reconstruct an RTCIceCandidateInit body. Whitelists fields,
 * enforces length/type bounds, and returns a clean object — never the raw
 * req.body — to prevent storing arbitrary attacker-controlled JSON that
 * gets fed into new RTCIceCandidate() on the peer.
 *
 * Returns { ok: true, value } or { ok: false, error }.
 */
function validateIceBody(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
        return { ok: false, error: 'body must be a JSON object' };
    }
    if (typeof body.candidate !== 'string' || body.candidate.length === 0 ||
        body.candidate.length > MAX_ICE_CANDIDATE_LEN) {
        return { ok: false, error: `candidate must be a string 1..${MAX_ICE_CANDIDATE_LEN}` };
    }
    const out = { candidate: body.candidate };
    if (body.sdpMid !== undefined && body.sdpMid !== null) {
        if (typeof body.sdpMid !== 'string' || body.sdpMid.length > MAX_ICE_MID_LEN) {
            return { ok: false, error: `sdpMid must be a string ≤${MAX_ICE_MID_LEN}` };
        }
        out.sdpMid = body.sdpMid;
    }
    if (body.sdpMLineIndex !== undefined && body.sdpMLineIndex !== null) {
        if (!Number.isInteger(body.sdpMLineIndex) ||
            body.sdpMLineIndex < 0 || body.sdpMLineIndex > MAX_ICE_MLINE_INDEX) {
            return { ok: false, error: `sdpMLineIndex must be an integer 0..${MAX_ICE_MLINE_INDEX}` };
        }
        out.sdpMLineIndex = body.sdpMLineIndex;
    }
    if (body.usernameFragment !== undefined && body.usernameFragment !== null) {
        if (typeof body.usernameFragment !== 'string' ||
            body.usernameFragment.length > MAX_ICE_UFRAG_LEN) {
            return { ok: false, error: `usernameFragment must be a string ≤${MAX_ICE_UFRAG_LEN}` };
        }
        out.usernameFragment = body.usernameFragment;
    }
    return { ok: true, value: out };
}

/**
 * Validate an SDP description body. Returns null on success or an error
 * message on failure. Strict: rejects unknown top-level fields so a malicious
 * sender cannot smuggle extra properties into the peer's RTCSessionDescription.
 */
function validateSdpBody(body, expectedType) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
        return 'body must be a JSON object';
    }
    if (body.type !== expectedType) {
        return `type must be "${expectedType}"`;
    }
    if (typeof body.sdp !== 'string') {
        return 'sdp must be a string';
    }
    if (body.sdp.length === 0 || body.sdp.length > MAX_SDP_LEN) {
        return `sdp length must be 1..${MAX_SDP_LEN} (got ${body.sdp.length})`;
    }
    const allowed = new Set(['type', 'sdp']);
    for (const key of Object.keys(body)) {
        if (!allowed.has(key)) return `unexpected field: ${key}`;
    }
    return null;
}

/**
 * Store SDP offer for a room
 * POST /api/rooms/:id/offer
 * Body: { sdp: "...", type: "offer" }
 * Headers: X-Room-Secret required
 * Rate limited: general (100/min)
 */
app.post('/api/rooms/:id/offer', rateLimitMiddleware('general'), validateRoomSecret, (req, res) => {
    const err = validateSdpBody(req.body, 'offer');
    if (err) return res.status(400).json({ error: err });
    req.room.offer = { type: req.body.type, sdp: req.body.sdp };
    console.log(`Room ${req.params.id}: offer stored`);
    debugLog('SIGNALING', `Offer stored for room ${req.params.id}`, {
        sdpLength: req.body.sdp?.length,
        type: req.body.type
    });
    res.json({ success: true });
});

/**
 * Get SDP offer for a room
 * GET /api/rooms/:id/offer
 * Headers: X-Room-Secret required
 * Rate limited: 30 lookups per minute per IP
 */
app.get('/api/rooms/:id/offer', rateLimitMiddleware('roomLookup'), validateRoomSecret, (req, res) => {
    if (!req.room.offer) {
        debugLog('SIGNALING', `Offer not ready for room ${req.params.id}`);
        return res.status(404).json({ error: 'Offer not ready yet' });
    }

    debugLog('SIGNALING', `Offer retrieved for room ${req.params.id}`, {
        sdpLength: req.room.offer.sdp?.length
    });
    res.json(req.room.offer);
});

/**
 * Store SDP answer for a room
 * POST /api/rooms/:id/answer
 * Body: { sdp: "...", type: "answer" }
 * Headers: X-Room-Secret required
 * Rate limited: general (100/min)
 */
app.post('/api/rooms/:id/answer', rateLimitMiddleware('general'), validateRoomSecret, (req, res) => {
    const err = validateSdpBody(req.body, 'answer');
    if (err) return res.status(400).json({ error: err });
    req.room.answer = { type: req.body.type, sdp: req.body.sdp };
    console.log(`Room ${req.params.id}: answer stored`);
    debugLog('SIGNALING', `Answer stored for room ${req.params.id}`, {
        sdpLength: req.body.sdp?.length,
        type: req.body.type
    });
    // Wake any pending long-pollers immediately rather than letting them
    // discover the new answer on the next setTimeout tick.
    const waiters = req.room.answerWaiters;
    if (waiters && waiters.length) {
        req.room.answerWaiters = [];
        for (const w of waiters) {
            if (w.timer) clearTimeout(w.timer);
            w.send(req.room);
        }
    }
    res.json({ success: true });
});

/**
 * Get SDP answer for a room (long-polling)
 * GET /api/rooms/:id/answer
 * Headers: X-Room-Secret required
 * Query: ?wait=true for long-polling (up to 30 seconds)
 */
app.get('/api/rooms/:id/answer', rateLimitMiddleware('general'), validateRoomSecret, (req, res) => {
    // Fast path: answer already available, or caller didn't ask to wait.
    if (req.room.answer) {
        return res.json(req.room.answer);
    }
    if (req.query.wait !== 'true') {
        return res.status(204).send();
    }

    // Defense-in-depth caps: bound the live waiter count both per-room and
    // process-wide. Refuse new long-polls (429 / 503) before allocating any
    // socket / closure / timer. The rate limit middleware above is the third
    // independent layer (per-IP request rate).
    if (req.room.answerWaiters.length >= MAX_WAITERS_PER_ROOM) {
        res.set('Retry-After', '5');
        return res.status(429).json({ error: 'Too many concurrent long-polls on this room' });
    }
    if (_totalWaiters >= MAX_TOTAL_WAITERS) {
        res.set('Retry-After', '5');
        return res.status(503).json({ error: 'Server temporarily overloaded' });
    }

    // Long-polling: register a one-shot waiter on the room. POST /answer
    // drains the queue immediately; cleanupRooms drains with 404 on
    // expiry. A 30s timer is the upper bound.
    const TIMEOUT_MS = 30000;
    let settled = false;
    const settle = (fn) => {
        if (settled) return;
        settled = true;
        const idx = req.room.answerWaiters.indexOf(waiter);
        if (idx !== -1) req.room.answerWaiters.splice(idx, 1);
        if (waiter.timer) clearTimeout(waiter.timer);
        _totalWaiters--;
        fn();
    };
    const waiter = {
        timer: null,
        send: (room) => settle(() => res.json(room.answer)),
        timeout: () => settle(() => res.status(204).send()),
        roomGone: () => settle(() => res.status(404).json({ error: 'Room not found' })),
    };
    waiter.timer = setTimeout(waiter.timeout, TIMEOUT_MS);
    req.room.answerWaiters.push(waiter);
    _totalWaiters++;

    // If the client disconnects, drop the waiter without writing a response.
    req.on('close', () => settle(() => {}));
});

/**
 * Add ICE candidate for offer side (receiver's candidates)
 * POST /api/rooms/:id/ice/offer
 * Headers: X-Room-Secret required
 * Rate limited: general (100/min)
 */
app.post('/api/rooms/:id/ice/offer', rateLimitMiddleware('general'), validateRoomSecret, (req, res) => {
    if (req.room.iceCandidatesOffer.length >= MAX_ICE_CANDIDATES) {
        return res.status(429).json({ error: `ICE candidate cap reached (${MAX_ICE_CANDIDATES})` });
    }
    const result = validateIceBody(req.body);
    if (!result.ok) return res.status(400).json({ error: result.error });
    req.room.iceCandidatesOffer.push(result.value);
    debugLog('ICE', `Offer ICE candidate added for room ${req.params.id}`, {
        candidate: result.value.candidate.substring(0, 50),
        total: req.room.iceCandidatesOffer.length
    });
    res.json({ success: true });
});

/**
 * Get ICE candidates for offer side
 * GET /api/rooms/:id/ice/offer
 * Headers: X-Room-Secret required
 */
app.get('/api/rooms/:id/ice/offer', rateLimitMiddleware('general'), validateRoomSecret, (req, res) => {
    debugLog('ICE', `Offer ICE candidates retrieved for room ${req.params.id}`, {
        count: req.room.iceCandidatesOffer.length
    });
    res.json({ candidates: req.room.iceCandidatesOffer });
});

/**
 * Add ICE candidate for answer side (sender's candidates)
 * POST /api/rooms/:id/ice/answer
 * Headers: X-Room-Secret required
 * Rate limited: general (100/min)
 */
app.post('/api/rooms/:id/ice/answer', rateLimitMiddleware('general'), validateRoomSecret, (req, res) => {
    if (req.room.iceCandidatesAnswer.length >= MAX_ICE_CANDIDATES) {
        return res.status(429).json({ error: `ICE candidate cap reached (${MAX_ICE_CANDIDATES})` });
    }
    const result = validateIceBody(req.body);
    if (!result.ok) return res.status(400).json({ error: result.error });
    req.room.iceCandidatesAnswer.push(result.value);
    debugLog('ICE', `Answer ICE candidate added for room ${req.params.id}`, {
        candidate: result.value.candidate.substring(0, 50),
        total: req.room.iceCandidatesAnswer.length
    });
    res.json({ success: true });
});

/**
 * Get ICE candidates for answer side
 * GET /api/rooms/:id/ice/answer
 * Headers: X-Room-Secret required
 */
app.get('/api/rooms/:id/ice/answer', rateLimitMiddleware('general'), validateRoomSecret, (req, res) => {
    debugLog('ICE', `Answer ICE candidates retrieved for room ${req.params.id}`, {
        count: req.room.iceCandidatesAnswer.length
    });
    res.json({ candidates: req.room.iceCandidatesAnswer });
});

/**
 * Check if room exists
 * GET /api/rooms/:id
 * Headers: X-Room-Secret required
 * Rate limited: 30 lookups per minute per IP (prevents enumeration)
 */
app.get('/api/rooms/:id', rateLimitMiddleware('roomLookup'), validateRoomSecret, (req, res) => {
    res.json({
        exists: true,
        hasOffer: !!req.room.offer,
        hasAnswer: !!req.room.answer
    });
});

// ============ HTTP-relay long-poll fallback (commit 4) ============
// Used when even the WS upgrade is refused or torn down by a proxy. The
// client hits these three endpoints over plain HTTPS POST/GET. Frames
// are forwarded between paired peers exactly like the WS relay, and
// share the same room.relay state and 4 GiB / 16 KiB caps. A slot can
// be a WS or an LP slot interchangeably: deliverToPeer() dispatches on
// peer.kind so an LP sender can talk to a WS receiver and vice versa.

/**
 * Claim a long-poll relay slot for this room.
 * POST /api/rooms/:id/relay/handshake
 * Returns { slot: 'a'|'b', token: '<hex>' }. The token is required on
 * subsequent up/down calls and is compared with constant-time secureCompare.
 */
app.post('/api/rooms/:id/relay/handshake', rateLimitMiddleware('general'), validateRoomSecret, (req, res) => {
    if (!RELAY_ENABLE) return res.status(404).json({ error: 'Relay disabled' });
    const room = req.room;
    const r = room.relay || (room.relay = { a: null, b: null, sessionBytes: 0 });
    let slotName;
    if (!r.a) slotName = 'a';
    else if (!r.b) slotName = 'b';
    else return res.status(409).json({ error: 'Room relay slots full' });

    const token = require('crypto').randomBytes(LP_SLOT_TOKEN_BYTES).toString('hex');
    const slot = {
        kind: 'lp',
        token,
        slotName,
        queue: [],
        waiters: [],
        closed: false,
        idleTimer: null,
        // WeakRef so the cleanup timer doesn't prevent the room from being
        // GC'd if it expires through TTL while the LP slot is idle.
        roomRef: typeof WeakRef === 'function' ? new WeakRef(room) : { deref: () => room },
    };
    r[slotName] = slot;
    armLpIdleTimer(slot);
    debugLog('RELAY-LP', `Slot ${slotName} claimed for room ${req.params.id}`, {});
    res.json({ slot: slotName, token });
});

/**
 * Forward a frame from this slot to its peer.
 * POST /api/rooms/:id/relay/up
 * Headers: X-Room-Secret, X-Slot-Token, Content-Type
 *   application/octet-stream -> binary frame
 *   anything else            -> text/control frame
 * Body: the frame bytes (raw). Capped at LP_FRAME_BODY_LIMIT by express.raw.
 */
app.post(
    '/api/rooms/:id/relay/up',
    rateLimitMiddleware('general'),
    validateRoomSecret,
    express.raw({ type: '*/*', limit: LP_FRAME_BODY_LIMIT }),
    (req, res) => {
        if (!RELAY_ENABLE) return res.status(404).json({ error: 'Relay disabled' });
        const room = req.room;
        const r = room.relay;
        if (!r) return res.status(409).json({ error: 'No relay session' });
        const providedToken = req.headers['x-slot-token'] || '';
        let slot = null, slotName = null;
        for (const name of ['a', 'b']) {
            const s = r[name];
            if (s && s.kind === 'lp' && helpers.secureCompare(providedToken, s.token)) {
                slot = s; slotName = name; break;
            }
        }
        if (!slot || slot.closed) return res.status(401).json({ error: 'Invalid slot token' });

        const data = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
        const isBinary = (req.headers['content-type'] || '').toLowerCase().includes('application/octet-stream');
        const len = data.length;
        if (!isBinary && len > MAX_CONTROL_MSG_BYTES) {
            closeLpSlot(slot, 'Control message too large');
            r[slotName] = null;
            return res.status(413).json({ error: 'Control message too large' });
        }
        r.sessionBytes += len;
        if (r.sessionBytes > MAX_TOTAL_SESSION_BYTES) {
            closeLpSlot(slot, 'Session byte cap exceeded');
            r[slotName] = null;
            const peer = slotName === 'a' ? r.b : r.a;
            teardownPeer(peer, 'Session byte cap exceeded');
            return res.status(413).json({ error: 'Session byte cap exceeded' });
        }
        armLpIdleTimer(slot);
        const peer = slotName === 'a' ? r.b : r.a;
        deliverToPeer(peer, data, isBinary);
        res.status(204).send();
    }
);

/**
 * Long-poll for the next incoming frame on this slot.
 * GET /api/rooms/:id/relay/down?wait=true
 * Headers: X-Room-Secret, X-Slot-Token
 * Response:
 *   200 application/octet-stream  -> binary frame in body
 *   200 application/json          -> control frame in body
 *   204                           -> no frame within LP_DOWN_TIMEOUT_MS
 *   410                           -> slot closed by server (peer gone, etc)
 */
app.get('/api/rooms/:id/relay/down', rateLimitMiddleware('general'), validateRoomSecret, (req, res) => {
    if (!RELAY_ENABLE) return res.status(404).json({ error: 'Relay disabled' });
    const room = req.room;
    const r = room.relay;
    if (!r) return res.status(409).json({ error: 'No relay session' });
    const providedToken = req.headers['x-slot-token'] || '';
    let slot = null;
    for (const name of ['a', 'b']) {
        const s = r[name];
        if (s && s.kind === 'lp' && helpers.secureCompare(providedToken, s.token)) {
            slot = s; break;
        }
    }
    if (!slot) return res.status(401).json({ error: 'Invalid slot token' });
    if (slot.closed) return res.status(410).json({ error: 'Slot closed' });

    armLpIdleTimer(slot);

    const sendFrame = (frame) => {
        if (frame.isBinary) {
            res.set('Content-Type', 'application/octet-stream');
            res.status(200).send(Buffer.isBuffer(frame.data) ? frame.data : Buffer.from(frame.data));
        } else {
            // Forward as-is. The client side treats text frames as JSON
            // control messages identical to the WS path.
            const body = Buffer.isBuffer(frame.data) ? frame.data.toString('utf8') : String(frame.data);
            res.set('Content-Type', 'application/json');
            res.status(200).send(body);
        }
    };

    // Fast path: a frame is already queued.
    if (slot.queue.length > 0) {
        return sendFrame(slot.queue.shift());
    }
    if (req.query.wait !== 'true') return res.status(204).send();

    // Long-poll path: bound the live waiter count per-room AND globally,
    // mirroring the /answer waiter caps. An LP peer should only have one
    // in-flight down request; we allow a small overlap for the reconnect
    // case.
    if (slot.waiters.length >= MAX_WAITERS_PER_ROOM) {
        res.set('Retry-After', '5');
        return res.status(429).json({ error: 'Too many concurrent down-polls on this slot' });
    }
    if (_totalWaiters >= MAX_TOTAL_WAITERS) {
        res.set('Retry-After', '5');
        return res.status(503).json({ error: 'Server temporarily overloaded' });
    }
    let settled = false;
    const settle = (fn) => {
        if (settled) return;
        settled = true;
        const idx = slot.waiters.indexOf(waiter);
        if (idx !== -1) slot.waiters.splice(idx, 1);
        if (waiter.timer) clearTimeout(waiter.timer);
        _totalWaiters--;
        fn();
    };
    const waiter = {
        timer: null,
        send: (frame) => settle(() => sendFrame(frame)),
        timeout: () => settle(() => res.status(204).send()),
        gone: (reason) => settle(() => res.status(410).json({ error: reason || 'Slot closed' })),
    };
    waiter.timer = setTimeout(waiter.timeout, LP_DOWN_TIMEOUT_MS);
    slot.waiters.push(waiter);
    _totalWaiters++;
    req.on('close', () => settle(() => {}));
});

/**
 * Explicitly tear down this slot.
 * POST /api/rooms/:id/relay/close
 * Lets the client signal a clean shutdown so the peer is closed
 * immediately instead of waiting for the LP idle timeout.
 */
app.post('/api/rooms/:id/relay/close', rateLimitMiddleware('general'), validateRoomSecret, (req, res) => {
    if (!RELAY_ENABLE) return res.status(404).json({ error: 'Relay disabled' });
    const r = req.room.relay;
    if (!r) return res.status(204).send();
    const providedToken = req.headers['x-slot-token'] || '';
    for (const name of ['a', 'b']) {
        const s = r[name];
        if (s && s.kind === 'lp' && helpers.secureCompare(providedToken, s.token)) {
            closeLpSlot(s, 'Client closed');
            r[name] = null;
            const peer = name === 'a' ? r.b : r.a;
            teardownPeer(peer, 'Peer closed');
            break;
        }
    }
    res.status(204).send();
});

// Catch-all route for /send/:roomId pattern - serve send.html
app.get('/send/:roomId', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'send.html'));
});

// Final 404 handler: keep the response body generic so a probe of
// unknown paths cannot fingerprint our routing tree (which would
// otherwise leak through Express's default text/html "Cannot GET /x"
// page). Logging here is deliberately low-noise: noise on 404 is the
// path of least resistance for log-injection too.
app.use((req, res) => {
    res.status(404).json({ error: 'Not found' });
});

// Final error handler: Express 4's default handler returns the full
// stack trace in the response body whenever NODE_ENV is not exactly
// "production". We do NOT set NODE_ENV anywhere (Docker, CI, local),
// so a thrown exception or `next(err)` from any current or future
// handler would leak server-side paths, dependency versions, and our
// in-memory data shape to the network. This middleware forces a
// generic 500 JSON regardless of env, while still logging the real
// error server-side for operators. The 4-arg signature (err, req,
// res, next) is what tells Express this is the error path.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
    console.error(`[error] ${req.method} ${req.path}:`, err && err.stack ? err.stack : err);
    if (res.headersSent) {
        return res.end();
    }
    // Preserve well-formed status codes set by middleware (body-parser
    // raises PayloadTooLargeError with statusCode 413 for bodies over
    // the 50kb cap, and similar for malformed JSON). Anything outside
    // 400..499 collapses to a generic 500 so internal bugs cannot leak
    // arbitrary status text.
    const status = (err && Number.isInteger(err.status) && err.status >= 400 && err.status < 500)
        ? err.status
        : (err && Number.isInteger(err.statusCode) && err.statusCode >= 400 && err.statusCode < 500)
            ? err.statusCode
            : 500;
    if (status === 500) {
        return res.status(500).json({ error: 'Internal server error' });
    }
    // For 4xx originating in middleware, surface a short generic
    // message tied to the status code, never `err.message` (which can
    // include "SyntaxError: Unexpected token } in JSON at position 17"
    // and similar parser fingerprints).
    const messages = {
        400: 'Bad request',
        401: 'Unauthorized',
        403: 'Forbidden',
        404: 'Not found',
        413: 'Payload too large',
        415: 'Unsupported media type',
        429: 'Too many requests',
    };
    res.status(status).json({ error: messages[status] || 'Request error' });
});

// ============ HTTP-Relay Fallback Transport (commit 2) ============
// When TURNS gets blocked or stripped on hostile corporate networks, the
// client races a WebSocket to /api/rooms/:id/relay against WebRTC. The
// relay forwards opaque encrypted bytes between two paired peers; the
// payload remains ECDH+AES-GCM end-to-end encrypted, so the server never
// sees plaintext. Three slots per room: 'a' (first connector), 'b' (second
// connector), and a 4409 close code for a third connector. Bounded by the
// mirrored MAX_TOTAL_SESSION_BYTES / MAX_CONTROL_MSG_BYTES caps.

const RELAY_PATH_RE = /^\/api\/rooms\/([A-Z0-9]{6})\/relay$/;
const wss = new WebSocketServer({ noServer: true });
// Track the relay rooms with at least one open socket so the heartbeat
// interval (ping/pong) only walks live entries.
const relayPings = new Set();

function deliverToPeer(peerSlot, data, isBinary) {
    if (!peerSlot) return;
    if (peerSlot.kind === 'lp') {
        if (peerSlot.closed) return;
        if (peerSlot.queue.length >= LP_QUEUE_MAX_FRAMES) {
            // Bounded queue: a stalled consumer must not be able to pin
            // server memory. We drop the oldest frame, not the newest,
            // because the newest is more useful to the live receiver.
            peerSlot.queue.shift();
        }
        peerSlot.queue.push({ data, isBinary });
        const w = peerSlot.waiters.shift();
        if (w) {
            const next = peerSlot.queue.shift();
            w.send(next);
        }
        return;
    }
    // ws slot
    if (peerSlot.readyState === peerSlot.OPEN) {
        peerSlot.send(data, { binary: isBinary });
    }
}

function teardownPeer(peer, reason) {
    if (!peer) return;
    if (peer.kind === 'lp') {
        closeLpSlot(peer, reason);
        // Also null out the LP slot's room.relay reference so a fresh
        // /relay/handshake can reclaim it immediately. Without this the
        // closed LP slot lingers in room.relay until the idle timer
        // (LP_SLOT_IDLE_TIMEOUT_MS, 60s) fires, which makes the room
        // appear "slots full" (409) and rejects up/down with 410 for
        // up to a minute after a cross-kind disconnect (e.g. a WS half
        // closing while its LP peer is still nominally present).
        const room = peer.roomRef && peer.roomRef.deref && peer.roomRef.deref();
        if (room && room.relay && peer.slotName && room.relay[peer.slotName] === peer) {
            room.relay[peer.slotName] = null;
        }
    } else if (peer.readyState !== peer.CLOSED) {
        try { peer.close(1000, reason); } catch (_) {}
    }
}

function closeLpSlot(slot, reason) {
    if (slot.closed) return;
    slot.closed = true;
    if (slot.idleTimer) { clearTimeout(slot.idleTimer); slot.idleTimer = null; }
    // Drain pending waiters with a 410 Gone signal so the client knows
    // the slot is dead and can stop polling.
    const waiters = slot.waiters.splice(0);
    for (const w of waiters) w.gone(reason);
}

function armLpIdleTimer(slot) {
    if (slot.idleTimer) clearTimeout(slot.idleTimer);
    slot.idleTimer = setTimeout(() => {
        // The peer has gone silent for LP_SLOT_IDLE_TIMEOUT_MS, which is
        // long after any reasonable retry window. Tear down to free
        // resources; if the client comes back it can re-handshake.
        const room = slot.roomRef && slot.roomRef.deref && slot.roomRef.deref();
        closeLpSlot(slot, 'idle');
        if (room && room.relay && room.relay[slot.slotName] === slot) {
            room.relay[slot.slotName] = null;
            const peer = slot.slotName === 'a' ? room.relay.b : room.relay.a;
            teardownPeer(peer, 'Peer idle');
        }
    }, LP_SLOT_IDLE_TIMEOUT_MS);
    slot.idleTimer.unref && slot.idleTimer.unref();
}

function attachRelay(room, ws, slot) {
    if (!room.relay) {
        room.relay = { a: null, b: null, sessionBytes: 0 };
    }
    const r = room.relay;
    ws.kind = 'ws';
    r[slot] = ws;
    relayPings.add(ws);
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });

    ws.on('message', (data, isBinary) => {
        const len = Buffer.isBuffer(data) ? data.length : (data && data.byteLength) || 0;
        if (!isBinary && len > MAX_CONTROL_MSG_BYTES) {
            // Mirrors the client-side handleMessage cap in webrtc.js so
            // a hostile peer cannot force the relay container to forward
            // multi-MB control messages.
            try { ws.close(4413, 'Control message too large'); } catch (_) {}
            return;
        }
        r.sessionBytes += len;
        if (r.sessionBytes > MAX_TOTAL_SESSION_BYTES) {
            // 4 GiB cap shared with the receiver-side cap (protocol.js
            // MAX_TOTAL_SESSION_BYTES). Tear down both sides so the
            // session is over end-to-end, not just on the hostile peer.
            const peer = slot === 'a' ? r.b : r.a;
            try { ws.close(4413, 'Session byte cap exceeded'); } catch (_) {}
            teardownPeer(peer, 'Session byte cap exceeded');
            return;
        }
        const peer = slot === 'a' ? r.b : r.a;
        deliverToPeer(peer, data, isBinary);
        // If the peer hasn't joined yet, the frame is dropped on the
        // floor. We don't buffer because the protocol is interactive:
        // dropped pre-handshake frames are renegotiated by the client.
    });

    ws.on('close', () => {
        relayPings.delete(ws);
        if (room.relay) {
            room.relay[slot] = null;
            // Tear down the peer too: the pair is symmetric; once one
            // half is gone the connection is dead. The receiver will
            // re-pair via createForReceiver if it wants to try again.
            const peer = slot === 'a' ? room.relay.b : room.relay.a;
            teardownPeer(peer, 'Peer disconnected');
        }
    });

    ws.on('error', () => {
        try { ws.close(1011, 'Server error'); } catch (_) {}
    });
}

// Heartbeat: any client that fails to pong within one interval is treated
// as dead and force-closed. Without this, a proxy that silently drops a
// connection leaves the peer holding an open socket for the room TTL.
const RELAY_PING_INTERVAL_MS = 20_000;
setInterval(() => {
    for (const ws of relayPings) {
        if (ws.isAlive === false) {
            try { ws.terminate(); } catch (_) {}
            relayPings.delete(ws);
            continue;
        }
        ws.isAlive = false;
        try { ws.ping(); } catch (_) {}
    }
}, RELAY_PING_INTERVAL_MS).unref();

const httpServer = http.createServer(app);

httpServer.on('upgrade', (req, socket, head) => {
    if (!RELAY_ENABLE) {
        socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
        socket.destroy();
        return;
    }
    // Parse URL with a synthetic base so URL() works for the relative path.
    let url;
    try {
        url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    } catch (_) {
        socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
        socket.destroy();
        return;
    }

    const match = RELAY_PATH_RE.exec(url.pathname);
    if (!match) {
        socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
        socket.destroy();
        return;
    }

    // Origin validation mirrors validateOrigin() for the HTTP API. No
    // Origin header = not a browser; we let it through (curl / test
    // clients). The room-secret check below is the real defense; this
    // just enforces the same surface area for free.
    const origin = req.headers.origin;
    if (origin && !ALLOWED_ORIGINS.includes(origin)) {
        socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
        socket.destroy();
        return;
    }

    // Per-IP rate limit. Reuses the existing 'general' category (100/min)
    // so a hostile client cannot pin slots by reconnecting in a tight
    // loop. We can't go through the Express middleware on upgrade so we
    // call checkRateLimit directly.
    const ip = req.socket.remoteAddress || 'unknown';
    if (!RATE_LIMIT_DISABLED) {
        const rl = checkRateLimit(ip, 'general');
        if (!rl.allowed) {
            socket.write(`HTTP/1.1 429 Too Many Requests\r\nRetry-After: ${rl.retryAfter}\r\n\r\n`);
            socket.destroy();
            return;
        }
    }

    const roomId = match[1];
    const room = rooms.get(roomId);
    const providedSecret = url.searchParams.get('secret') || '';
    // Same constant-time secret check as validateRoomSecret(), including
    // the dummy compare when the room is missing so an attacker cannot
    // tell from response timing whether a roomId exists.
    const compareTarget = room ? room.secret : _DUMMY_SECRET;
    const ok = providedSecret && helpers.secureCompare(providedSecret, compareTarget);
    if (!room || !ok) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
    }

    // Slot assignment: first connector becomes 'a', second 'b', third
    // gets a 4409 close. We have to commit to the slot BEFORE handleUpgrade
    // resolves so a concurrent third upgrade can't slip in.
    const r = room.relay || { a: null, b: null, sessionBytes: 0 };
    let slot;
    if (!r.a) slot = 'a';
    else if (!r.b) slot = 'b';
    else {
        socket.write('HTTP/1.1 409 Conflict\r\n\r\nRoom relay slots full');
        socket.destroy();
        return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
        attachRelay(room, ws, slot);
    });
});

httpServer.listen(PORT, '0.0.0.0', () => {
    console.log('='.repeat(60));
    console.log('  WebSend - Startup Configuration');
    console.log('='.repeat(60));

    const envVars = [
        { name: 'DOMAIN',               value: process.env.DOMAIN,               used: DOMAIN },
        { name: 'DEV',                   value: process.env.DEV,                  used: DEV ? '1' : '0' },
        { name: 'STUN_SERVER',           value: process.env.STUN_SERVER,          used: STUN_SERVER || '(none)' },
        { name: 'STUN_GOOGLE_FALLBACK',  value: process.env.STUN_GOOGLE_FALLBACK, used: String(STUN_GOOGLE_FALLBACK) },
        { name: 'TURN_SERVER',           value: process.env.TURN_SERVER,          used: TURN_SERVER || '(none)' },
        { name: 'TURN_SECRET',           value: process.env.TURN_SECRET,          used: TURN_SECRET ? '(set)' : '(not set)' },
        { name: 'TURN_CREDENTIAL_TTL',   value: process.env.TURN_CREDENTIAL_TTL,  used: String(TURN_CREDENTIAL_TTL) },
        { name: 'TURN_TIMEOUT',          value: process.env.TURN_TIMEOUT,         used: String(TURN_TIMEOUT) },
        { name: 'ALLOWED_ORIGINS',       value: process.env.ALLOWED_ORIGINS,      used: ALLOWED_ORIGINS.join(', ') },
        { name: 'TURNS_PORT',            value: process.env.TURNS_PORT,           used: TURNS_PORT || '(none)' },
        { name: 'RELAY_ENABLE',          value: process.env.RELAY_ENABLE,         used: String(RELAY_ENABLE) },
        { name: 'DEV_FORCE_CONNECTION',  value: process.env.DEV_FORCE_CONNECTION, used: DEV_FORCE_CONNECTION },
        { name: 'UMAMI_URL',             value: process.env.UMAMI_URL,            used: UMAMI_URL || '(none)' },
        { name: 'UMAMI_WEBSITE_ID',      value: process.env.UMAMI_WEBSITE_ID,     used: UMAMI_WEBSITE_ID || '(none)' },
        { name: 'UMAMI_DNT',             value: process.env.UMAMI_DNT,            used: UMAMI_DNT },
        { name: 'OCR_LANGS',             value: process.env.OCR_LANGS,            used: OCR_LANGS },
        { name: 'OCR_PSM',               value: process.env.OCR_PSM,              used: OCR_PSM },
    ];

    for (const v of envVars) {
        const status = v.value === undefined ? ' [NOT SET]' : '';
        console.log(`  ${v.name}${status}`);
        console.log(`    -> ${v.used}`);
    }

    console.log('-'.repeat(60));
    console.log(`  Listening on 0.0.0.0:${PORT}`);

    // Warnings
    if (!STUN_SERVER && !STUN_GOOGLE_FALLBACK && !TURN_SERVER) {
        console.log('  WARNING: No ICE servers configured! Connections will likely fail.');
    }
    if (TURN_SERVER && !TURN_SECRET) {
        console.log('  WARNING: TURN_SERVER is set but TURN_SECRET is missing - TURN disabled.');
    }
    if (DEV) {
        console.log('  DEV MODE ENABLED - verbose debug logging active');
    }

    // Print the exact ICE URL list that /api/config will hand out (without
    // credentials). Without this the operator has to mentally compose the
    // URLs from STUN_SERVER / TURN_SERVER / TURNS_PORT and can miss e.g.
    // TURNS not being offered because TURNS_PORT was unset.
    const previewUrls = { stun: [], turn: [], turns: [] };
    if (STUN_SERVER) previewUrls.stun.push(`stun:${STUN_SERVER}`);
    if (STUN_GOOGLE_FALLBACK) previewUrls.stun.push('stun:stun.l.google.com:19302');
    if (TURN_SERVER && TURN_SECRET) {
        previewUrls.turn.push(`turn:${TURN_SERVER}?transport=udp`);
        previewUrls.turn.push(`turn:${TURN_SERVER}?transport=tcp`);
        if (TURNS_PORT) {
            const turnHost = TURN_SERVER.replace(/:\d+$/, '');
            previewUrls.turns.push(`turns:${turnHost}:${TURNS_PORT}`);
        }
    }
    console.log('-'.repeat(60));
    console.log(`  ICE URLs offered to clients: STUN=${previewUrls.stun.length}, TURN=${previewUrls.turn.length}, TURNS=${previewUrls.turns.length}`);
    for (const u of previewUrls.stun)  console.log(`    STUN:  ${u}`);
    for (const u of previewUrls.turn)  console.log(`    TURN:  ${u}`);
    for (const u of previewUrls.turns) console.log(`    TURNS: ${u}`);
    if (TURN_SERVER && TURN_SECRET && !TURNS_PORT) {
        console.log('  Note: TURNS_PORT not set, so no turns: URL will be offered. Networks that block UDP and TCP-3478 will fail.');
    }

    // HTTP-relay fallback transport (commit 2): the client races a
    // WebSocket against WebRTC and switches over after a 10s grace
    // window if WebRTC has not connected. Surface the URL operators
    // should expect to see at Caddy / reverse-proxy time.
    if (RELAY_ENABLE) {
        const wsScheme = DOMAIN === 'localhost' ? 'ws' : 'wss';
        const httpScheme = DOMAIN === 'localhost' ? 'http' : 'https';
        console.log('  HTTP-relay fallback: ENABLED');
        console.log(`    WS:  ${wsScheme}://${DOMAIN}/api/rooms/:id/relay`);
        console.log(`    LP:  ${httpScheme}://${DOMAIN}/api/rooms/:id/relay/{handshake,up,down,close}`);
    } else {
        console.log('  HTTP-relay fallback: DISABLED (RELAY_ENABLE=false)');
    }

    console.log('='.repeat(60));
});
