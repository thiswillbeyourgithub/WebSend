/**
 * Express server for WebSend
 * Serves static files, provides ICE configuration, and acts as a signaling server
 * for WebRTC SDP offer/answer exchange.
 */

const express = require('express');
const crypto = require('crypto');
const path = require('path');
const { version: APP_VERSION } = require('./package.json');

const app = express();
const PORT = 8080;
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

// ============ ICE Server Configuration ============
// STUN_SERVER: optional self-hosted STUN server (host:port)
const STUN_SERVER = process.env.STUN_SERVER || '';
// STUN_GOOGLE_FALLBACK: whether to include Google's public STUN as fallback (default: true)
const STUN_GOOGLE_FALLBACK = process.env.STUN_GOOGLE_FALLBACK !== 'false';
// TURN_SERVER: optional TURN relay server (host:port)
const TURN_SERVER = process.env.TURN_SERVER || '';
// TURN_SECRET: shared secret for time-based TURN credentials
const TURN_SECRET = process.env.TURN_SECRET || '';
// TURN_CREDENTIAL_TTL: how long TURN credentials are valid (default: 24 hours)
const TURN_CREDENTIAL_TTL = parseInt(process.env.TURN_CREDENTIAL_TTL, 10) || 86400;
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

const rateLimiters = new Map(); // IP -> { timestamps: [], blockedUntil: null }

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
function rateLimitMiddleware(limitType) {
    return (req, res, next) => {
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
    const maxAge = 5 * 60 * 1000; // Remove entries older than 5 minutes

    for (const [key, limiter] of rateLimiters.entries()) {
        // Remove if no recent timestamps and not blocked
        const hasRecentActivity = limiter.timestamps.some(ts => now - ts < maxAge);
        const isBlocked = limiter.blockedUntil && now < limiter.blockedUntil;

        if (!hasRecentActivity && !isBlocked) {
            rateLimiters.delete(key);
        }
    }
}

// Clean up rate limiters every 2 minutes
setInterval(cleanupRateLimiters, 2 * 60 * 1000);

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
 * Generate a short room ID (6 alphanumeric characters).
 * Uses crypto.randomBytes() for cryptographically secure randomness.
 * @returns {string} 6-character room ID from a 32-character alphabet (~30 bits entropy)
 */
function generateRoomId() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // No ambiguous chars (0,O,1,I,l)
    const randomBytes = crypto.randomBytes(6);
    let id = '';
    for (let i = 0; i < 6; i++) {
        // Use modulo to map random byte to alphabet index
        // Slight bias is acceptable for room IDs (not a security-critical secret)
        id += chars[randomBytes[i] % chars.length];
    }
    return id;
}

/**
 * Generate a cryptographically secure room secret (16 bytes, base64url encoded).
 * This secret must be presented to access room data, preventing room ID enumeration
 * and unauthorized room access.
 * @returns {string} 22-character base64url-encoded secret
 */
function generateRoomSecret() {
    return crypto.randomBytes(16).toString('base64url');
}

/**
 * Constant-time string comparison to prevent timing attacks on secret validation.
 * @param {string} a - First string
 * @param {string} b - Second string
 * @returns {boolean} True if strings are equal
 */
function secureCompare(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string') {
        return false;
    }
    if (a.length !== b.length) {
        return false;
    }
    return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

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

    if (!secureCompare(providedSecret, room.secret)) {
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
    const umamiScript = `    <script defer src="${UMAMI_URL}/getinfo" data-website-id="${UMAMI_WEBSITE_ID}" data-do-not-track="${UMAMI_DNT}"></script>\n`;

    // Intercept requests for HTML pages and inject the analytics script
    app.use((req, res, next) => {
        // Determine which HTML file to serve (if any)
        let htmlFile = null;
        if (req.path === '/' || req.path === '/index.html') {
            htmlFile = path.join(__dirname, 'public', 'index.html');
        } else if (req.path === '/send.html') {
            htmlFile = path.join(__dirname, 'public', 'send.html');
        } else if (req.path === '/receive.html') {
            htmlFile = path.join(__dirname, 'public', 'receive.html');
        }

        if (!htmlFile) return next();

        fs.readFile(htmlFile, 'utf8', (err, html) => {
            if (err) return next();
            html = html.replace('</head>', umamiScript + '</head>');
            res.type('html').send(html);
        });
    });
}

// Serve static files from public directory
app.use(express.static(path.join(__dirname, 'public')));

// Serve vendored libraries (scribe.js-ocr, client-zip, tessdata, etc.)
app.use('/vendor', express.static(path.join(__dirname, 'public', 'vendor')));
app.use('/scribe', express.static(path.join(__dirname, 'public', 'vendor', 'scribe.js-ocr')));
app.use('/tessdata', express.static(path.join(__dirname, 'public', 'vendor', 'tessdata')));

/**
 * Generate time-based TURN credentials using HMAC-SHA1.
 * This follows the TURN REST API / coturn ephemeral credentials standard.
 * Username format: expiry_timestamp:random_id
 * Credential: Base64(HMAC-SHA1(secret, username))
 *
 * @returns {{ username: string, credential: string }} Time-based credentials
 */
function generateTurnCredentials() {
    const expiryTime = Math.floor(Date.now() / 1000) + TURN_CREDENTIAL_TTL;
    // Include a random component to make each credential unique
    const randomId = crypto.randomBytes(4).toString('hex');
    const username = `${expiryTime}:${randomId}`;
    const credential = crypto
        .createHmac('sha1', TURN_SECRET)
        .update(username)
        .digest('base64');
    return { username, credential };
}

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
        const { username, credential } = generateTurnCredentials();
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

        switch (DEV_FORCE_CONNECTION) {
            case 'DIRECT':
                // No ICE servers at all — only host candidates (LAN only)
                filteredServers = [];
                break;

            case 'STUN':
                // Self-hosted STUN only (no Google, no TURN)
                filteredServers = iceServers.filter(s =>
                    typeof s.urls === 'string' && s.urls.startsWith('stun:') && !s.urls.includes('google')
                );
                break;

            case 'GOOGLE_STUN':
                // Google's public STUN only
                filteredServers = iceServers.filter(s =>
                    typeof s.urls === 'string' && s.urls.includes('stun.l.google.com')
                );
                break;

            case 'TURN':
                // TURN UDP+TCP only (no TURNS, no STUN) — force relay so STUN discovery is skipped
                filteredServers = iceServers
                    .filter(s => Array.isArray(s.urls))
                    .map(s => ({
                        ...s,
                        urls: s.urls.filter(u => u.startsWith('turn:'))
                    }))
                    .filter(s => s.urls.length > 0);
                forceRelay = true;
                break;

            case 'TURNS':
            case 'TURN_TLS':
                // TURNS (TURN-over-TLS) only — force relay
                filteredServers = iceServers
                    .filter(s => Array.isArray(s.urls))
                    .map(s => ({
                        ...s,
                        urls: s.urls.filter(u => u.startsWith('turns:'))
                    }))
                    .filter(s => s.urls.length > 0);
                forceRelay = true;
                break;

            default:
                console.warn(`Unknown DEV_FORCE_CONNECTION value: "${DEV_FORCE_CONNECTION}", using ALL`);
                break;
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
        ocrPsm: OCR_PSM
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
        roomId = generateRoomId();
    } while (rooms.has(roomId));

    // Generate cryptographic secret for room access authorization
    const secret = generateRoomSecret();

    rooms.set(roomId, {
        created: Date.now(),
        secret: secret,
        offer: null,
        answer: null,
        iceCandidatesOffer: [],
        iceCandidatesAnswer: []
    });

    console.log(`Room ${roomId} created`);
    debugLog('ROOM', `Room created`, { roomId, clientIp: getClientIp(req) });
    // Return both roomId and secret; secret is included in QR code URL
    res.json({ roomId, secret });
});

/**
 * Store SDP offer for a room
 * POST /api/rooms/:id/offer
 * Body: { sdp: "...", type: "offer" }
 * Headers: X-Room-Secret required
 * Rate limited: general (100/min)
 */
app.post('/api/rooms/:id/offer', rateLimitMiddleware('general'), validateRoomSecret, (req, res) => {
    req.room.offer = req.body;
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
    req.room.answer = req.body;
    console.log(`Room ${req.params.id}: answer stored`);
    debugLog('SIGNALING', `Answer stored for room ${req.params.id}`, {
        sdpLength: req.body.sdp?.length,
        type: req.body.type
    });
    res.json({ success: true });
});

/**
 * Get SDP answer for a room (long-polling)
 * GET /api/rooms/:id/answer
 * Headers: X-Room-Secret required
 * Query: ?wait=true for long-polling (up to 30 seconds)
 */
app.get('/api/rooms/:id/answer', validateRoomSecret, async (req, res) => {
    // If answer is ready, return immediately
    if (req.room.answer) {
        return res.json(req.room.answer);
    }

    // Long-polling: wait for answer up to 30 seconds
    if (req.query.wait === 'true') {
        const startTime = Date.now();
        const timeout = 30000; // 30 seconds
        const pollInterval = 500; // Check every 500ms
        const roomId = req.params.id;

        const checkAnswer = () => {
            const currentRoom = rooms.get(roomId);
            if (!currentRoom) {
                return res.status(404).json({ error: 'Room not found' });
            }

            if (currentRoom.answer) {
                return res.json(currentRoom.answer);
            }

            if (Date.now() - startTime >= timeout) {
                return res.status(204).send(); // No content yet
            }

            setTimeout(checkAnswer, pollInterval);
        };

        checkAnswer();
    } else {
        res.status(204).send(); // No content yet
    }
});

/**
 * Add ICE candidate for offer side (receiver's candidates)
 * POST /api/rooms/:id/ice/offer
 * Headers: X-Room-Secret required
 * Rate limited: general (100/min)
 */
app.post('/api/rooms/:id/ice/offer', rateLimitMiddleware('general'), validateRoomSecret, (req, res) => {
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
