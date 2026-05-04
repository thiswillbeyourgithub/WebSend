/**
 * Express server for WebSend
 * Serves static files, provides ICE configuration, and acts as a signaling server
 * for WebRTC SDP offer/answer exchange.
 */

const express = require('express');
const crypto = require('crypto');
const path = require('path');
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
    TURN:        { filter: filterTurnArray(u => u.startsWith('turn:')),                             forceRelay: true  },
    TURNS:       { filter: filterTurnArray(u => u.startsWith('turns:')),                            forceRelay: true  },
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

// Parse JSON bodies
app.use(express.json({ limit: '50kb' }));

// In-memory room storage (in production, use Redis or similar)
const rooms = new Map();
const ROOM_TTL = 10 * 60 * 1000; // 10 minutes TTL

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
        const value = this.map.get(key);
        if (value === undefined && !this.map.has(key)) return undefined;
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

/**
 * Middleware to validate room secret from X-Room-Secret header.
 * Returns 401 if secret is missing or invalid.
 */
function validateRoomSecret(req, res, next) {
    const room = rooms.get(req.params.id);
    if (!room) {
        return res.status(404).json({ error: 'Room not found' });
    }

    const providedSecret = req.headers['x-room-secret'];
    if (!providedSecret) {
        return res.status(401).json({ error: 'Room secret required' });
    }

    if (!helpers.secureCompare(providedSecret, room.secret)) {
        return res.status(401).json({ error: 'Invalid room secret' });
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
            if (room.answerWaiters && room.answerWaiters.length) {
                const waiters = room.answerWaiters.splice(0);
                for (const w of waiters) w.roomGone();
            }
            rooms.delete(id);
            console.log(`Room ${id} expired and removed`);
        }
    }
}

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
        const html = fs.readFileSync(filePath, 'utf8').replace('</head>', umamiScript + '</head>');
        cachedHtml.set(name, html);
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
        iceServers.push({
            urls: [
                `turn:${TURN_SERVER}?transport=udp`,
                `turn:${TURN_SERVER}?transport=tcp`,
                // TURNS (TURN-over-TLS) on a separate port, for networks blocking non-443/non-HTTPS traffic
                ...(TURNS_PORT ? [`turns:${TURN_SERVER.replace(/:\d+$/, ':' + TURNS_PORT)}?transport=tcp`] : [])
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
        allowedFileTypes: ALLOWED_FILE_TYPES
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
    // Ensure unique room ID
    do {
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
        answerWaiters: []
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
        return `sdp length must be 1..${MAX_SDP_LEN}`;
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
app.get('/api/rooms/:id/answer', validateRoomSecret, (req, res) => {
    // Fast path: answer already available, or caller didn't ask to wait.
    if (req.room.answer) {
        return res.json(req.room.answer);
    }
    if (req.query.wait !== 'true') {
        return res.status(204).send();
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
    req.room.iceCandidatesOffer.push(req.body);
    debugLog('ICE', `Offer ICE candidate added for room ${req.params.id}`, {
        candidate: req.body.candidate?.substring(0, 50),
        total: req.room.iceCandidatesOffer.length
    });
    res.json({ success: true });
});

/**
 * Get ICE candidates for offer side
 * GET /api/rooms/:id/ice/offer
 * Headers: X-Room-Secret required
 */
app.get('/api/rooms/:id/ice/offer', validateRoomSecret, (req, res) => {
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
    req.room.iceCandidatesAnswer.push(req.body);
    debugLog('ICE', `Answer ICE candidate added for room ${req.params.id}`, {
        candidate: req.body.candidate?.substring(0, 50),
        total: req.room.iceCandidatesAnswer.length
    });
    res.json({ success: true });
});

/**
 * Get ICE candidates for answer side
 * GET /api/rooms/:id/ice/answer
 * Headers: X-Room-Secret required
 */
app.get('/api/rooms/:id/ice/answer', validateRoomSecret, (req, res) => {
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

/**
 * Get server stats (active room count) for adaptive fingerprint length.
 * GET /api/stats
 * No authentication required - only exposes aggregate count, not room details.
 */
app.get('/api/stats', (req, res) => {
    res.json({ activeRooms: rooms.size });
});

// Catch-all route for /send/:roomId pattern - serve send.html
app.get('/send/:roomId', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'send.html'));
});

app.listen(PORT, '0.0.0.0', () => {
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

    console.log('='.repeat(60));
});
