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
