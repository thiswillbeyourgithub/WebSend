// How per-client limits key a client. Regression guards:
// - the rate limiter keyed on the full address, so an IPv6 host rotating
//   through its /64 got a fresh bucket per request, and ::ffff:a.b.c.d
//   counted apart from a.b.c.d;
// - the WS upgrade path keyed on req.socket.remoteAddress, ignoring
//   'trust proxy', so behind a reverse proxy every client shared one bucket.
// The test server trusts loopback (the default), so X-Forwarded-For set by
// the test stands in for the real client address.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { startServer, stopServer } from './helpers.mjs';

let srv;
before(async () => { srv = await startServer({ TEST_DISABLE_RATE_LIMIT: '0' }); });
after(() => stopServer(srv.proc));

async function createRoomStatus(xff) {
    const res = await fetch(`${srv.baseUrl}/api/rooms`, {
        method: 'POST',
        headers: { 'X-Forwarded-For': xff },
    });
    await res.arrayBuffer();
    return res.status;
}

// Raw WS upgrade with no secret: 401 when it passes the rate limiter,
// 429 when it does not. Resolves with the status code.
function upgradeStatus(xff) {
    return new Promise((resolve, reject) => {
        const req = http.request({
            host: '127.0.0.1',
            port: srv.port,
            path: '/api/rooms/AAAAAA/relay',
            headers: {
                Connection: 'Upgrade',
                Upgrade: 'websocket',
                'Sec-WebSocket-Version': '13',
                'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
                'X-Forwarded-For': xff,
            },
        });
        req.on('response', (res) => { res.resume(); resolve(res.statusCode); });
        req.on('upgrade', (res, socket) => { socket.destroy(); resolve(101); });
        req.on('error', reject);
        req.end();
    });
}

test('room creation: addresses of one IPv6 /64 share a rate-limit bucket', async () => {
    const statuses = [];
    for (let i = 1; i <= 200 && !statuses.includes(429); i++) {
        statuses.push(await createRoomStatus(`2001:db8:aa:1::${i.toString(16)}`));
    }
    assert.ok(statuses.includes(429), 'rotating inside one /64 must not dodge the limit');
    // Another /64 is another client.
    assert.equal(await createRoomStatus('2001:db8:aa:2::1'), 200);
});

test('room creation: ::ffff:a.b.c.d and a.b.c.d share a rate-limit bucket', async () => {
    let status = 200;
    for (let i = 0; i < 200 && status !== 429; i++) {
        status = await createRoomStatus('::ffff:198.51.100.7');
    }
    assert.equal(status, 429);
    assert.equal(await createRoomStatus('198.51.100.7'), 429);
});

test('WS upgrade: rate limit honours trust proxy and keys by /64', async () => {
    let status = 401;
    for (let i = 1; i <= 2000 && status !== 429; i++) {
        status = await upgradeStatus(`2001:db8:bb:1::${i.toString(16)}`);
    }
    assert.equal(status, 429, 'rotating inside one /64 must not dodge the limit');
    // A different client behind the same proxy keeps its own budget.
    assert.equal(await upgradeStatus('203.0.113.50'), 401);
});
