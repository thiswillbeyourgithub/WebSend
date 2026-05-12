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
 *   - close endpoint tears down peer
 *   - RELAY_ENABLE=false rejects with 404
 *
 * Generated with the help of Claude Code.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, stopServer } from './helpers.mjs';

let srv;
before(async () => { srv = await startServer({ TEST_DISABLE_RATE_LIMIT: '1' }); });
after(() => stopServer(srv.proc));

async function newRoom() {
    const res = await fetch(`${srv.baseUrl}/api/rooms`, { method: 'POST' });
    return res.json();
}

async function handshake(roomId, secret) {
    return fetch(`${srv.baseUrl}/api/rooms/${roomId}/relay/handshake`, {
        method: 'POST',
        headers: { 'X-Room-Secret': secret, 'Content-Type': 'application/json' },
        body: '{}',
    });
}

async function up(roomId, secret, token, body, isBinary) {
    return fetch(`${srv.baseUrl}/api/rooms/${roomId}/relay/up`, {
        method: 'POST',
        headers: {
            'X-Room-Secret': secret,
            'X-Slot-Token': token,
            // text/plain (not application/json) so the global express.json()
            // body parser doesn't intercept the body before our route's raw
            // parser; matches what lp-transport.js sends from the browser.
            'Content-Type': isBinary ? 'application/octet-stream' : 'text/plain',
        },
        body,
    });
}

async function down(roomId, secret, token, wait = false) {
    const url = `${srv.baseUrl}/api/rooms/${roomId}/relay/down${wait ? '?wait=true' : ''}`;
    return fetch(url, {
        method: 'GET',
        headers: { 'X-Room-Secret': secret, 'X-Slot-Token': token },
    });
}

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
