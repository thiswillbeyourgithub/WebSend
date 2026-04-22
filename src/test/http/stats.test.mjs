import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, stopServer } from './helpers.mjs';

let srv;
before(async () => { srv = await startServer(); });
after(() => stopServer(srv.proc));

test('/api/stats returns expected shape', async () => {
    const res = await fetch(`${srv.baseUrl}/api/stats`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(typeof body.activeRooms === 'number', 'Missing activeRooms');
});
