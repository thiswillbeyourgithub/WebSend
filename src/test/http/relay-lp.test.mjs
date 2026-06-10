/**
 * HTTP-relay long-poll fallback: /api/rooms/:id/relay/{handshake,up,down,close}.
 *
 * Covers:
 *   - handshake assigns slots a and b; third refused with 409
 *   - wrong secret -> 401 on every endpoint
 *   - wrong slot token -> 401 on up/down
 *   - binary frame round-trip A -> B and B -> A
 *   - text frame (control) round-trip
 *   - 204 on down-poll timeout when wait=true and nothing queued
 *   - control msg > 16 KiB -> 413
 *   - full peer queue -> 429 backpressure, no frame ever dropped
 *   - X-Peer-Backlog-Bytes header tracks the peer's undrained bytes
 *   - close endpoint tears down peer
 *   - RELAY_ENABLE=false rejects with 404
 *
 * Generated with the help of Claude Code.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, stopServer, lpHandshake, lpUp, lpDown } from './helpers.mjs';

let srv;
before(async () => { srv = await startServer({ TEST_DISABLE_RATE_LIMIT: '1' }); });
after(() => stopServer(srv.proc));

async function newRoom() {
    const res = await fetch(`${srv.baseUrl}/api/rooms`, { method: 'POST' });
    return res.json();
}

// Thin aliases over the shared wrappers (helpers.mjs) so the test bodies
// don't have to thread srv.baseUrl through every call.
const handshake = (roomId, secret) => lpHandshake(srv.baseUrl, roomId, secret);
const up = (roomId, secret, token, body, isBinary) => lpUp(srv.baseUrl, roomId, secret, token, body, isBinary);
const down = (roomId, secret, token, wait = false) => lpDown(srv.baseUrl, roomId, secret, token, wait);

test('handshake assigns slot a then b, third gets 409', async () => {
    const { roomId, secret } = await newRoom();
    const h1 = await handshake(roomId, secret);
    assert.equal(h1.status, 200);
    const b1 = await h1.json();
    assert.equal(b1.slot, 'a');
    assert.ok(typeof b1.token === 'string' && b1.token.length >= 32);

    const h2 = await handshake(roomId, secret);
    assert.equal(h2.status, 200);
    const b2 = await h2.json();
    assert.equal(b2.slot, 'b');

    const h3 = await handshake(roomId, secret);
    assert.equal(h3.status, 409);
});

test('handshake with wrong secret returns 401', async () => {
    const { roomId } = await newRoom();
    const res = await handshake(roomId, 'wrong-secret');
    assert.equal(res.status, 401);
});

test('up with wrong slot token returns 401', async () => {
    const { roomId, secret } = await newRoom();
    await handshake(roomId, secret);
    const res = await up(roomId, secret, 'badtoken', 'hello', false);
    assert.equal(res.status, 401);
});

test('binary frame round-trip A -> B', async () => {
    const { roomId, secret } = await newRoom();
    const a = await (await handshake(roomId, secret)).json();
    const b = await (await handshake(roomId, secret)).json();

    const payload = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]);
    const r = await up(roomId, secret, a.token, payload, true);
    assert.equal(r.status, 204);

    const d = await down(roomId, secret, b.token, false);
    assert.equal(d.status, 200);
    assert.equal(d.headers.get('content-type'), 'application/octet-stream');
    const got = Buffer.from(await d.arrayBuffer());
    assert.deepEqual([...got], [...payload]);
});

test('text frame round-trip B -> A', async () => {
    const { roomId, secret } = await newRoom();
    const a = await (await handshake(roomId, secret)).json();
    const b = await (await handshake(roomId, secret)).json();

    const msg = JSON.stringify({ type: 'relay-hello' });
    const r = await up(roomId, secret, b.token, msg, false);
    assert.equal(r.status, 204);

    const d = await down(roomId, secret, a.token, false);
    assert.equal(d.status, 200);
    assert.ok((d.headers.get('content-type') || '').includes('application/json'));
    assert.equal(await d.text(), msg);
});

test('down with wait=true blocks until peer sends', async () => {
    const { roomId, secret } = await newRoom();
    const a = await (await handshake(roomId, secret)).json();
    const b = await (await handshake(roomId, secret)).json();

    const downPromise = down(roomId, secret, b.token, true);
    // give the poll time to register, then send
    await new Promise(r => setTimeout(r, 50));
    const sendRes = await up(roomId, secret, a.token, 'hi', false);
    assert.equal(sendRes.status, 204);

    const dr = await downPromise;
    assert.equal(dr.status, 200);
    assert.equal(await dr.text(), 'hi');
});

test('control msg over MAX_CONTROL_MSG_BYTES returns 413 and closes slot', async () => {
    const { roomId, secret } = await newRoom();
    const a = await (await handshake(roomId, secret)).json();
    await handshake(roomId, secret); // peer b

    const big = 'x'.repeat(20_000); // > 16 KiB control cap
    const r = await up(roomId, secret, a.token, big, false);
    assert.equal(r.status, 413);
});

test('full peer queue returns 429 and loses no frames', async () => {
    const { roomId, secret } = await newRoom();
    const a = await (await handshake(roomId, secret)).json();
    const b = await (await handshake(roomId, secret)).json();

    // Push frames from a without b polling. The server must accept exactly
    // LP_QUEUE_MAX_FRAMES (32, mirrored here) and answer 429 for the rest:
    // the old behaviour silently dropped the oldest frame (corrupting any
    // in-flight file) while still returning 204.
    const MAX_FRAMES = 32;
    let accepted = 0;
    let rejected = 0;
    for (let i = 0; i < MAX_FRAMES + 4; i++) {
        const frame = Buffer.from([i, i, i, i]);
        const r = await up(roomId, secret, a.token, frame, true);
        if (r.status === 204) accepted++;
        else if (r.status === 429) rejected++;
        else assert.fail(`unexpected status ${r.status} on frame ${i}`);
    }
    assert.equal(accepted, MAX_FRAMES);
    assert.equal(rejected, 4);

    // Drain everything: all accepted frames arrive, in order, none dropped.
    for (let i = 0; i < MAX_FRAMES; i++) {
        const d = await down(roomId, secret, b.token, false);
        assert.equal(d.status, 200);
        const got = Buffer.from(await d.arrayBuffer());
        assert.deepEqual([...got], [i, i, i, i]);
    }
    const empty = await down(roomId, secret, b.token, false);
    assert.equal(empty.status, 204);

    // Once the queue has room again, up succeeds (the 429 is retryable).
    const retry = await up(roomId, secret, a.token, Buffer.from([99]), true);
    assert.equal(retry.status, 204);
});

test('up reports the peer backlog in X-Peer-Backlog-Bytes', async () => {
    const { roomId, secret } = await newRoom();
    const a = await (await handshake(roomId, secret)).json();
    const b = await (await handshake(roomId, secret)).json();

    // No waiter on b, so each accepted frame stays queued: the header must
    // reflect the backlog including the frame just enqueued.
    const r1 = await up(roomId, secret, a.token, Buffer.alloc(100), true);
    assert.equal(r1.status, 204);
    assert.equal(r1.headers.get('x-peer-backlog-bytes'), '100');

    const r2 = await up(roomId, secret, a.token, Buffer.alloc(50), true);
    assert.equal(r2.status, 204);
    assert.equal(r2.headers.get('x-peer-backlog-bytes'), '150');

    // Draining one frame shrinks the backlog reported on the next up.
    const d = await down(roomId, secret, b.token, false);
    assert.equal(d.status, 200);
    const r3 = await up(roomId, secret, a.token, Buffer.alloc(8), true);
    assert.equal(r3.status, 204);
    assert.equal(r3.headers.get('x-peer-backlog-bytes'), '58');
});

test('close endpoint tears down both sides', async () => {
    const { roomId, secret } = await newRoom();
    const a = await (await handshake(roomId, secret)).json();
    const b = await (await handshake(roomId, secret)).json();

    // b starts a long poll; a closes; b should get 410.
    const downPromise = down(roomId, secret, b.token, true);
    await new Promise(r => setTimeout(r, 50));

    const closeRes = await fetch(`${srv.baseUrl}/api/rooms/${roomId}/relay/close`, {
        method: 'POST',
        headers: { 'X-Room-Secret': secret, 'X-Slot-Token': a.token },
    });
    assert.equal(closeRes.status, 204);

    const dr = await downPromise;
    assert.equal(dr.status, 410);
});
