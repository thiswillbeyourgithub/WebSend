/**
 * Pure helper functions extracted from server.js for unit-testability.
 * These functions have no side-effects beyond their return values and
 * depend only on Node's built-in `crypto` module.
 *
 * server.js requires this module and uses these functions directly — there is
 * no separate copy in server.js.
 */

'use strict';

const crypto = require('crypto');

const ROOM_ID_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // No ambiguous chars (0,O,1,I,l)

/**
 * Generate a short room ID (6 alphanumeric characters).
 * Note: slight modulo bias is acceptable for room IDs (not a security secret).
 * @returns {string} 6-character room ID (~30 bits entropy)
 */
function generateRoomId() {
    const randomBytes = crypto.randomBytes(6);
    let id = '';
    for (let i = 0; i < 6; i++) {
        id += ROOM_ID_CHARS[randomBytes[i] % ROOM_ID_CHARS.length];
    }
    return id;
}

/**
 * Generate a cryptographically secure room secret (16 bytes, base64url encoded).
 * @returns {string} 22-character base64url-encoded secret
 */
function generateRoomSecret() {
    return crypto.randomBytes(16).toString('base64url');
}

/**
 * Constant-time string comparison to prevent timing attacks on secret validation.
 * Hashes both inputs to fixed-length digests before comparing so
 * timingSafeEqual always operates on equal-length buffers.
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
function secureCompare(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string') return false;
    const ha = crypto.createHash('sha256').update(a).digest();
    const hb = crypto.createHash('sha256').update(b).digest();
    return crypto.timingSafeEqual(ha, hb);
}

/**
 * Generate time-based TURN credentials (TURN REST API / coturn ephemeral credentials).
 * Username format: expiry_timestamp:random_id
 * Credential: Base64(HMAC-SHA1(secret, username))
 *
 * @param {string} turnSecret - Shared secret configured on the TURN server
 * @param {number} ttlSeconds - Credential lifetime in seconds
 * @param {function} [nowFn=Date.now] - Injectable clock for testing
 * @returns {{ username: string, credential: string }}
 */
function generateTurnCredentials(turnSecret, ttlSeconds, nowFn = Date.now) {
    const expiryTime = Math.floor(nowFn() / 1000) + ttlSeconds;
    const randomId = crypto.randomBytes(4).toString('hex');
    const username = `${expiryTime}:${randomId}`;
    const credential = crypto
        .createHmac('sha1', turnSecret)
        .update(username)
        .digest('base64');
    return { username, credential };
}

/**
 * Check whether an origin is allowed.
 * Returns true if no origin (non-browser request) or if origin is in allowedOrigins.
 * @param {string|undefined} origin
 * @param {string[]} allowedOrigins
 * @returns {boolean}
 */
function isOriginAllowed(origin, allowedOrigins) {
    if (!origin) return true;
    return allowedOrigins.includes(origin);
}

module.exports = {
    generateRoomId,
    generateRoomSecret,
    secureCompare,
    generateTurnCredentials,
    isOriginAllowed,
    ROOM_ID_CHARS,
};
