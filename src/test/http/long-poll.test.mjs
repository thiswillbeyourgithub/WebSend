/**
 * Long-poll edge cases for GET /api/rooms/:id/answer?wait=true:
 *  - fast path: returns immediately when answer is already present
 *  - mid-wait delivery: POST /answer during a pending wait wakes the poller
 *  - client abort: aborting the wait must not crash the server (req.on('close'))
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, stopServer } from './helpers.mjs';

let srv;
before(async () => { srv = await startServer({ TEST_DISABLE_RATE_LIMIT: '1' }); });
after(() => stopServer(srv.proc));

const post = (url, body, secret) => fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(secret ? { 'X-Room-Secret': secret } : {}) },
    body: JSON.stringify(body),
});

async function newRoom() {
    return (await post(`${srv.baseUrl}/api/rooms`, {})).json();
}

test('long-poll fast path: returns immediately when answer is already present', async () => {
    const { roomId, secret } = await newRoom();
    const answer = { type: 'answer', sdp: 'v=0\r\nfast\r\n' };
    await post(`${srv.baseUrl}/api/rooms/${roomId}/answer`, answer, secret);

    const t0 = Date.now();
    const res = await fetch(`${srv.baseUrl}/api/rooms/${roomId}/answer?wait=true`, {
        headers: { 'X-Room-Secret': secret },
    });
    const elapsed = Date.now() - t0;
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), answer);
    // Should be effectively instant — well under one poll interval (500ms).
    assert.ok(elapsed < 400, `fast path took ${elapsed}ms, expected <400ms`);
});

test('long-poll wakes when answer is posted mid-wait', async () => {
    const { roomId, secret } = await newRoom();
    const answer = { type: 'answer', sdp: 'v=0\r\nlate\r\n' };

    const waitPromise = fetch(`${srv.baseUrl}/api/rooms/${roomId}/answer?wait=true`, {
        headers: { 'X-Room-Secret': secret },
    });

    // Post answer after ~200ms (less than one full poll interval; arrives on next tick).
    await new Promise(r => setTimeout(r, 200));
    await post(`${srv.baseUrl}/api/rooms/${roomId}/answer`, answer, secret);

    const res = await waitPromise;
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), answer);
});

test('aborting a pending long-poll does not crash the server', async () => {
    const { roomId, secret } = await newRoom();

    const ac = new AbortController();
    const pending = fetch(`${srv.baseUrl}/api/rooms/${roomId}/answer?wait=true`, {
        headers: { 'X-Room-Secret': secret },
        signal: ac.signal,
    });

    // Let the long-poll begin, then abort the client connection.
    await new Promise(r => setTimeout(r, 150));
    ac.abort();
    await assert.rejects(pending, /aborted|abort/i);

    // Wait past one poll interval to give server-side cleanup a chance.
    await new Promise(r => setTimeout(r, 600));

    // Server is still healthy: a fresh request succeeds.
    const ok = await fetch(`${srv.baseUrl}/api/config`);
    assert.equal(ok.status, 200);
});
