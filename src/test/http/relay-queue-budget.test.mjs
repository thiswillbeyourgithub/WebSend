/**
 * Relay-wide byte budget (RELAY_QUEUE_BUDGET_BYTES), shared by every room's
 * LP queues and WS send buffers.
 *
 * Covers:
 *   - LP queues across rooms: past the budget /relay/up answers 429 with
 *     Retry-After: 1, in other rooms too; closing the slot holding the
 *     bytes gives them back
 *   - WS send buffers count too (a receiver that stops reading), and a
 *     closed socket gives its bytes back
 *   - a WS feeder is paused (not dropped) while the budget is spent and
 *     delivers every frame, in order, once it frees up
 *
 * Generated with the help of Claude Code.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { startServer, stopServer, lpHandshake, lpUp, lpDown } from './helpers.mjs';

const BUDGET = 256 * 1024;
const FRAME = 64 * 1024; // BUDGET / FRAME = 4 frames fill the budget

let srv;
before(async () => {
    srv = await startServer({ TEST_DISABLE_RATE_LIMIT: '1', RELAY_QUEUE_BUDGET_BYTES: String(BUDGET) });
});
after(() => stopServer(srv.proc));

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function newRoom() {
    const res = await fetch(`${srv.baseUrl}/api/rooms`, { method: 'POST' });
    return res.json();
}

// Room with two LP slots: { roomId, secret, a, b } where a/b are slot tokens.
async function lpPair() {
    const { roomId, secret, hostSecret } = await newRoom();
    const a = (await (await lpHandshake(srv.baseUrl, roomId, hostSecret)).json()).token;
    const b = (await (await lpHandshake(srv.baseUrl, roomId, secret)).json()).token;
    return { roomId, secret, a, b };
}

function lpClose(roomId, secret, token) {
    return fetch(`${srv.baseUrl}/api/rooms/${roomId}/relay/close`, {
        method: 'POST',
        headers: { 'X-Room-Secret': secret, 'X-Slot-Token': token },
    });
}

// One-byte frame through an LP pair whose receiver drains it right away,
// so the probe itself holds no budget. Returns { status, retryAfter }.
async function probe(p) {
    const res = await lpUp(srv.baseUrl, p.roomId, p.secret, p.a, Buffer.alloc(1), true);
    await res.arrayBuffer().catch(() => {});
    if (res.status === 204) await (await lpDown(srv.baseUrl, p.roomId, p.secret, p.b)).arrayBuffer();
    return { status: res.status, retryAfter: res.headers.get('retry-after') };
}

async function probeUntil(p, status, timeoutMs = 10_000) {
    const deadline = Date.now() + timeoutMs;
    let r;
    while (Date.now() < deadline) {
        r = await probe(p);
        if (r.status === status) return r;
        await sleep(50);
    }
    assert.fail(`probe never got ${status}, last ${JSON.stringify(r)}`);
}

function openWs(roomId, secret) {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${srv.port}/api/rooms/${roomId}/relay?secret=${encodeURIComponent(secret)}`);
        ws.once('open', () => resolve(ws));
        ws.once('error', reject);
    });
}

// Fill the budget with LP frames a non-polling receiver never drains.
async function fillWithLp() {
    const hog = await lpPair();
    for (let i = 0; i < BUDGET / FRAME; i++) {
        const res = await lpUp(srv.baseUrl, hog.roomId, hog.secret, hog.a, Buffer.alloc(FRAME), true);
        assert.equal(res.status, 204, `frame ${i} should fit in the budget`);
    }
    return hog;
}

test('LP queues share the budget across rooms; 429 Retry-After 1; closed slot gives bytes back', async () => {
    const hog = await fillWithLp();
    const over = await lpUp(srv.baseUrl, hog.roomId, hog.secret, hog.a, Buffer.alloc(FRAME), true);
    assert.equal(over.status, 429);
    assert.equal(over.headers.get('retry-after'), '1');

    // Another room, with an empty peer queue, is refused too.
    const other = await lpPair();
    const r = await probe(other);
    assert.deepEqual(r, { status: 429, retryAfter: '1' });

    // The receiver holding the bytes leaves: its queue returns to the budget.
    assert.equal((await lpClose(hog.roomId, hog.secret, hog.b)).status, 204);
    assert.equal((await probe(other)).status, 204);
});

test('WS send buffers count in the budget; a closed socket gives its bytes back', async () => {
    const probeRoom = await lpPair();
    assert.equal((await probe(probeRoom)).status, 204);

    const { roomId, secret, hostSecret } = await newRoom();
    const sender = await openWs(roomId, hostSecret);
    const receiver = await openWs(roomId, secret);
    // The receiver stops reading: once the loopback socket buffers fill,
    // further frames pile up in the relay's ws send buffer.
    receiver._socket.pause();

    const deadline = Date.now() + 15_000;
    let r;
    for (;;) {
        if (sender.bufferedAmount < 4 * 1024 * 1024) {
            for (let i = 0; i < 16; i++) sender.send(Buffer.alloc(FRAME), { binary: true });
        }
        r = await probe(probeRoom);
        if (r.status === 429 || Date.now() > deadline) break;
        await sleep(20);
    }
    assert.deepEqual(r, { status: 429, retryAfter: '1' });

    const closed = new Promise(res => sender.once('close', res));
    receiver.terminate();
    await closed; // the pair is torn down with its receiver
    await probeUntil(probeRoom, 204);
});

test('a WS feeder is paused, not dropped, while the budget is spent', async () => {
    const hog = await fillWithLp();

    const { roomId, secret, hostSecret } = await newRoom();
    const lp = (await (await lpHandshake(srv.baseUrl, roomId, hostSecret)).json()).token;
    const ws = await openWs(roomId, secret);
    const TOTAL = 16;
    for (let i = 0; i < TOTAL; i++) {
        const f = Buffer.alloc(FRAME, 0xab);
        f[0] = i;
        ws.send(f, { binary: true });
    }

    const got = [];
    const drain = async () => {
        for (;;) {
            const d = await lpDown(srv.baseUrl, roomId, secret, lp);
            if (d.status !== 200) return;
            got.push(Buffer.from(await d.arrayBuffer())[0]);
        }
    };
    await sleep(300);
    await drain();
    assert.ok(got.length < TOTAL, `feeder should be paused while the budget is spent, got all ${got.length}`);

    assert.equal((await lpClose(hog.roomId, hog.secret, hog.b)).status, 204);
    const deadline = Date.now() + 10_000;
    while (got.length < TOTAL && Date.now() < deadline) {
        await drain();
        await sleep(50);
    }
    assert.deepEqual(got, [...Array(TOTAL).keys()]);
    ws.close();
});
