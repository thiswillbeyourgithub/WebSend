import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, stopServer } from './helpers.mjs';

let srv;
before(async () => { srv = await startServer(); });
after(() => stopServer(srv.proc));

test('/api/stats returns exactly { activeRooms: number } and no extra fields', async () => {
    const res = await fetch(`${srv.baseUrl}/api/stats`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(typeof body.activeRooms, 'number', 'Missing/invalid activeRooms');
    assert.ok(body.activeRooms >= 0, 'activeRooms must be non-negative');
    // Endpoint is unauthenticated — guard against accidentally leaking
    // room IDs, secrets, or other internal state via new fields.
    assert.deepEqual(Object.keys(body).sort(), ['activeRooms'],
        `Unexpected fields in /api/stats: ${Object.keys(body).join(',')}`);
});
