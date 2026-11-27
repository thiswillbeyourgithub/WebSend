// Live-room caps on POST /api/rooms. Regression guard: rooms only leave
// memory through the expiry sweep, and nothing bounded how many one client
// (or all clients together) could hold at once.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, stopServer } from './helpers.mjs';

async function createRoomStatus(srv, xff) {
    const headers = xff ? { 'X-Forwarded-For': xff } : {};
    const res = await fetch(`${srv.baseUrl}/api/rooms`, { method: 'POST', headers });
    await res.arrayBuffer();
    return { status: res.status, retryAfter: res.headers.get('retry-after') };
}

async function createRooms(srv, n, xff) {
    const statuses = [];
    for (let i = 0; i < n; i++) statuses.push((await createRoomStatus(srv, xff)).status);
    return statuses;
}

describe('per-client live-room cap', () => {
    let srv;
    // Limiter live (the cap shares the per-client escape hatch), cap below
    // the room creation rate so it is the cap that bites, not the rate.
    before(async () => { srv = await startServer({ TEST_DISABLE_RATE_LIMIT: '0', ROOMS_MAX_PER_CLIENT: '3' }); });
    after(() => stopServer(srv.proc));

    test('the 4th live room of one client is 429 with Retry-After', async () => {
        assert.deepEqual(await createRooms(srv, 3, '198.51.100.1'), [200, 200, 200]);
        const refused = await createRoomStatus(srv, '198.51.100.1');
        assert.equal(refused.status, 429);
        assert.ok(Number(refused.retryAfter) > 0);
    });

    test('the cap is per client key: same /64 refused, other client allowed', async () => {
        assert.deepEqual(await createRooms(srv, 4, '2001:db8:cc:1::1'), [200, 200, 200, 429]);
        assert.equal((await createRoomStatus(srv, '2001:db8:cc:1::ffff')).status, 429);
        assert.equal((await createRoomStatus(srv, '198.51.100.2')).status, 200);
    });
});

describe('per-client live-room cap is released when rooms expire', () => {
    let srv;
    before(async () => {
        srv = await startServer({
            TEST_DISABLE_RATE_LIMIT: '0',
            ROOMS_MAX_PER_CLIENT: '2',
            WEBSEND_ROOM_TTL_MS: '300',
            WEBSEND_ROOM_CLEANUP_INTERVAL_MS: '100',
        });
    });
    after(() => stopServer(srv.proc));

    test('a client at the cap can create again once its rooms expired', async () => {
        assert.deepEqual(await createRooms(srv, 3), [200, 200, 429]);
        await new Promise(r => setTimeout(r, 700));
        assert.deepEqual(await createRooms(srv, 2), [200, 200]);
    });
});

describe('instance-wide live-room cap', () => {
    let srv;
    before(async () => { srv = await startServer({ TEST_DISABLE_RATE_LIMIT: '1', ROOMS_MAX: '2' }); });
    after(() => stopServer(srv.proc));

    test('room creation is 503 once the instance holds ROOMS_MAX rooms', async () => {
        assert.deepEqual(await createRooms(srv, 3), [200, 200, 503]);
    });
});
