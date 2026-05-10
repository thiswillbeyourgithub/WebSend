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

test('long-poll: per-room waiter cap rejects 5th concurrent waiter with 429', async () => {
    const { roomId, secret } = await newRoom();
    const url = `${srv.baseUrl}/api/rooms/${roomId}/answer?wait=true`;
    const headers = { 'X-Room-Secret': secret };
    const acs = [];
    const pendings = [];

    // Open MAX_WAITERS_PER_ROOM (4) concurrent long-polls. None should resolve
    // immediately; they all park on the waiter queue.
    for (let i = 0; i < 4; i++) {
        const ac = new AbortController();
        acs.push(ac);
        pendings.push(fetch(url, { headers, signal: ac.signal }));
    }
    // Give the server a tick to register all four waiters.
    await new Promise(r => setTimeout(r, 100));

    // The 5th call must be rejected with 429 before allocating a waiter.
    const overflow = await fetch(url, { headers });
    assert.equal(overflow.status, 429);
    assert.ok(overflow.headers.get('retry-after'));

    // Tear down: abort the 4 in-flight long-polls so they don't keep the test
    // hanging for 30s.
    acs.forEach(ac => ac.abort());
    await Promise.allSettled(pendings);

    // After abort, the cap clears and a new waiter can register again.
    await new Promise(r => setTimeout(r, 200));
    const ac = new AbortController();
    const reopen = fetch(url, { headers, signal: ac.signal });
    await new Promise(r => setTimeout(r, 100));
    ac.abort();
    await assert.rejects(reopen, /aborted|abort/i);
});
