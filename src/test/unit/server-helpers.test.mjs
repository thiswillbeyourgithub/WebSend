import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    generateRoomId,
    generateRoomSecret,
    secureCompare,
    generateTurnCredentials,
    isOriginAllowed,
    clientIpKey,
    ROOM_ID_CHARS,
} from '../../server-helpers.js';

// ---- generateRoomId ----

test('generateRoomId: returns 6 characters', () => {
    for (let i = 0; i < 20; i++) {
        assert.equal(generateRoomId().length, 6);
    }
});

test('generateRoomId: only valid charset characters', () => {
    const charset = new Set(ROOM_ID_CHARS);
    for (let i = 0; i < 100; i++) {
        for (const ch of generateRoomId()) {
            assert.ok(charset.has(ch), `Unexpected character '${ch}' in room ID`);
        }
    }
});

test('generateRoomId: no ambiguous characters (0, O, 1, I, l)', () => {
    const ambiguous = new Set(['0', 'O', '1', 'I', 'l']);
    for (let i = 0; i < 100; i++) {
        for (const ch of generateRoomId()) {
            assert.ok(!ambiguous.has(ch), `Ambiguous character '${ch}' found`);
        }
    }
});

test('generateRoomId: generates distinct IDs (basic uniqueness)', () => {
    const ids = new Set(Array.from({ length: 50 }, generateRoomId));
    // With 30-bit entropy, 50 samples should all be unique
    assert.ok(ids.size >= 45, `Expected near-unique IDs, got ${ids.size}/50 unique`);
});

// ---- generateRoomSecret ----

test('generateRoomSecret: returns a non-empty string', () => {
    const s = generateRoomSecret();
    assert.ok(typeof s === 'string' && s.length > 0);
});

test('generateRoomSecret: 16 bytes base64url → 22 chars', () => {
    // base64url of 16 bytes: ceil(16/3)*4 = 24, minus 2 padding = 22
    assert.equal(generateRoomSecret().length, 22);
});

// ---- secureCompare ----

test('secureCompare: equal strings return true', () => {
    assert.ok(secureCompare('abc', 'abc'));
});

test('secureCompare: different strings return false', () => {
    assert.ok(!secureCompare('abc', 'def'));
});

test('secureCompare: different lengths return false', () => {
    assert.ok(!secureCompare('abc', 'abcd'));
});

test('secureCompare: non-string returns false', () => {
    assert.ok(!secureCompare(null, 'abc'));
    assert.ok(!secureCompare('abc', undefined));
    assert.ok(!secureCompare(123, 'abc'));
});

// ---- generateTurnCredentials ----

test('generateTurnCredentials: username format is "expiry:randomHex"', () => {
    const now = Date.now();
    const { username } = generateTurnCredentials('secret', 3600, () => now);
    const [expiry, randomId] = username.split(':');
    assert.ok(/^\d+$/.test(expiry), `expiry should be numeric: ${expiry}`);
    assert.ok(/^[0-9a-f]{8}$/.test(randomId), `randomId should be 8 hex chars: ${randomId}`);
    assert.equal(parseInt(expiry), Math.floor(now / 1000) + 3600);
});

test('generateTurnCredentials: credential is base64', () => {
    const { credential } = generateTurnCredentials('mysecret', 3600);
    assert.ok(/^[A-Za-z0-9+/=]+$/.test(credential));
});

// ---- isOriginAllowed ----

test('isOriginAllowed: no origin header is allowed (curl/direct)', () => {
    assert.ok(isOriginAllowed(undefined, ['https://example.com']));
});

test('isOriginAllowed: allowed origin', () => {
    assert.ok(isOriginAllowed('https://example.com', ['https://example.com']));
});

test('isOriginAllowed: blocked origin', () => {
    assert.ok(!isOriginAllowed('https://evil.com', ['https://example.com']));
});

// ---- clientIpKey ----
// Regression guard: the rate limiter keyed on the full client address, so an
// IPv6 host rotating through its /64 got a fresh bucket per request, and
// ::ffff:a.b.c.d counted apart from a.b.c.d.

test('clientIpKey: IPv4 is kept as is', () => {
    assert.equal(clientIpKey('203.0.113.7'), '203.0.113.7');
});

test('clientIpKey: IPv4-mapped IPv6 collapses to the IPv4', () => {
    assert.equal(clientIpKey('::ffff:203.0.113.7'), '203.0.113.7');
    assert.equal(clientIpKey('::ffff:cb00:7107'), '203.0.113.7');
    assert.equal(clientIpKey('0:0:0:0:0:ffff:203.0.113.7'), '203.0.113.7');
});

test('clientIpKey: addresses of one /64 share a key', () => {
    const a = clientIpKey('2001:db8:1:2:aaaa::1');
    assert.equal(a, '2001:db8:1:2::/64');
    assert.equal(clientIpKey('2001:0db8:0001:0002:ffff:ffff:ffff:ffff'), a);
    assert.equal(clientIpKey('2001:DB8:1:2::9'), a);
    assert.equal(clientIpKey('2001:db8:1:2::9%eth0'), a);
});

test('clientIpKey: :: compression inside the /64 prefix', () => {
    assert.equal(clientIpKey('2001:db8::1'), '2001:db8:0:0::/64');
    assert.equal(clientIpKey('2001::1:2:3:4'), '2001:0:0:0::/64');
    assert.equal(clientIpKey('fe80::1%eth0'), 'fe80:0:0:0::/64');
});

test('clientIpKey: different /64s get different keys', () => {
    assert.notEqual(clientIpKey('2001:db8:1:2::1'), clientIpKey('2001:db8:1:3::1'));
});

test('clientIpKey: loopback and the unspecified address', () => {
    assert.equal(clientIpKey('::1'), '0:0:0:0::/64');
    assert.equal(clientIpKey('::'), '0:0:0:0::/64');
    assert.equal(clientIpKey('::ffff:127.0.0.1'), '127.0.0.1');
});

test('clientIpKey: NAT64 prefix with embedded IPv4 is a plain /64', () => {
    assert.equal(clientIpKey('64:ff9b::192.0.2.33'), '64:ff9b:0:0::/64');
});

test('clientIpKey: missing or non-IP input', () => {
    assert.equal(clientIpKey(undefined), 'unknown');
    assert.equal(clientIpKey(null), 'unknown');
    assert.equal(clientIpKey(''), 'unknown');
    assert.equal(clientIpKey(42), 'unknown');
    assert.equal(clientIpKey('not-an-ip'), 'not-an-ip');
    assert.equal(clientIpKey('1:2:3:4:5:6:7:8:9'), '1:2:3:4:5:6:7:8:9');
    assert.equal(clientIpKey('999.1.1.1'), '999.1.1.1');
});
