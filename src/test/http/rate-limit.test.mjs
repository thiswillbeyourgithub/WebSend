import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, stopServer } from './helpers.mjs';

let srv;
before(async () => { srv = await startServer(); });
after(() => stopServer(srv.proc));

test('POST /api/rooms returns 429 after rate limit exceeded', async () => {
    // Default room creation limit is 10/minute per IP. Send 15 rapid requests.
    const results = await Promise.all(
        Array.from({ length: 15 }, () =>
            fetch(`${srv.baseUrl}/api/rooms`, { method: 'POST', headers: { 'Content-Type': 'application/json' } })
        )
    );
    const statuses = results.map(r => r.status);
    assert.ok(statuses.includes(429), `Expected at least one 429, got: ${statuses.join(',')}`);
});

test('GET /api/rooms/:id/answer fast path participates in the general rate limit', async () => {
    // Create one room and use its secret to fast-path-fetch the answer many
    // times. Without the rate-limit middleware on this handler (the historical
    // gap that allowed long-poll DoS), all 200/204 responses came back. With
    // the middleware applied, the per-IP general cap (100/min) kicks in.
    const { roomId, secret } = await (await fetch(`${srv.baseUrl}/api/rooms`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
    })).json();

    // Post an answer so subsequent GETs hit the fast path (no waiter, no
    // queue). Each GET still passes through rateLimitMiddleware('general').
    await fetch(`${srv.baseUrl}/api/rooms/${roomId}/answer`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Room-Secret': secret },
        body: JSON.stringify({ type: 'answer', sdp: 'v=0\r\nx\r\n' }),
    });

    // Fire 110 fast-path GETs serially to keep ordering deterministic. The
    // 100th-ish should start returning 429.
    let saw429 = false;
    for (let i = 0; i < 110; i++) {
        const r = await fetch(`${srv.baseUrl}/api/rooms/${roomId}/answer`, {
            headers: { 'X-Room-Secret': secret },
        });
        if (r.status === 429) { saw429 = true; break; }
    }
    assert.ok(saw429, 'Expected at least one 429 from /answer GET after exceeding general rate limit');
});
