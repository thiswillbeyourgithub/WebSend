/**
 * Pure helper functions extracted from server.js for unit-testability.
 * These functions have no side-effects beyond their return values and
 * depend only on Node's built-in `crypto` and `net` modules.
 *
 * server.js requires this module and uses these functions directly — there is
 * no separate copy in server.js.
 */

'use strict';

const crypto = require('crypto');
const net = require('net');

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
 * Expand an IPv6 address into its 8 hextets (numbers), or null when the
 * input is not IPv6. Handles `::` compression, a zone id (`%eth0`) and a
 * trailing dotted IPv4 (`::ffff:1.2.3.4`, which fills the last two hextets).
 * @param {string} addr
 * @returns {number[]|null}
 */
function ipv6Hextets(addr) {
    if (!net.isIPv6(addr)) return null;
    let s = addr.split('%')[0];
    const dotted = s.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/);
    if (dotted) {
        const o = dotted[2].split('.').map(Number);
        s = `${dotted[1]}${((o[0] << 8) | o[1]).toString(16)}:${((o[2] << 8) | o[3]).toString(16)}`;
    }
    const [head, tail] = s.includes('::') ? s.split('::') : [s, null];
    const left = head === '' ? [] : head.split(':');
    const right = tail === null || tail === '' ? [] : tail.split(':');
    const fill = tail === null ? [] : new Array(8 - left.length - right.length).fill('0');
    return [...left, ...fill, ...right].map(h => parseInt(h, 16));
}

/**
 * Key under which a client address is counted by per-client limits.
 * IPv4 is kept as is; IPv4-mapped IPv6 (`::ffff:a.b.c.d`) collapses to
 * `a.b.c.d`; any other IPv6 address becomes its /64 prefix, because one
 * host (or one customer line) usually owns a whole /64 and can rotate
 * through it freely. Missing input gives 'unknown', non-IP input is
 * returned unchanged.
 * @param {string|undefined} addr
 * @returns {string} e.g. '2001:db8:1:2::/64'
 */
function clientIpKey(addr) {
    if (typeof addr !== 'string' || addr.length === 0) return 'unknown';
    if (net.isIPv4(addr)) return addr;
    const h = ipv6Hextets(addr);
    if (h === null) return addr;
    if (h.slice(0, 5).every(x => x === 0) && h[5] === 0xffff) {
        return [h[6] >> 8, h[6] & 0xff, h[7] >> 8, h[7] & 0xff].join('.');
    }
    return `${h.slice(0, 4).map(x => x.toString(16)).join(':')}::/64`;
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
    clientIpKey,
    ROOM_ID_CHARS,
};
