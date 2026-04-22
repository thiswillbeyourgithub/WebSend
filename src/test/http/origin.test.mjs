import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, stopServer } from './helpers.mjs';

let srv;
before(async () => {
    // Start with an explicit DOMAIN so we know the allowed origins
    srv = await startServer({ DOMAIN: 'example.test' });
});
after(() => stopServer(srv.proc));

test('/api/rooms with no Origin header is allowed (curl-style)', async () => {
    const res = await fetch(`${srv.baseUrl}/api/rooms`, { method: 'POST' });
    // Should not be 403
    assert.notEqual(res.status, 403);
});

test('/api/rooms with wrong Origin is rejected with 403', async () => {
    const res = await fetch(`${srv.baseUrl}/api/rooms`, {
        method: 'POST',
        headers: { Origin: 'https://evil.example.com' },
    });
    assert.equal(res.status, 403);
});

test('/api/rooms with correct Origin is allowed', async () => {
    const res = await fetch(`${srv.baseUrl}/api/rooms`, {
        method: 'POST',
        headers: { Origin: 'https://example.test' },
    });
    assert.notEqual(res.status, 403);
});
