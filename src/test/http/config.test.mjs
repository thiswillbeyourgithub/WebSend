import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, stopServer } from './helpers.mjs';

let srv;
before(async () => { srv = await startServer(); });
after(() => stopServer(srv.proc));

test('/api/config returns 200 with expected shape', async () => {
    const res = await fetch(`${srv.baseUrl}/api/config`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(Array.isArray(body.iceServers), 'Missing iceServers array');
    assert.ok(typeof body.version === 'string', 'Missing version string');
    assert.ok(typeof body.allowedFileTypes === 'string', 'Missing allowedFileTypes');
});

test('/api/config with DEV_FORCE_CONNECTION=DIRECT returns empty iceServers', async () => {
    const res = await fetch(`${srv.baseUrl}/api/config`);
    const body = await res.json();
    assert.equal(body.iceServers.length, 0, 'DIRECT mode should have no ice servers');
    assert.equal(body.forceConnection, 'DIRECT');
});
