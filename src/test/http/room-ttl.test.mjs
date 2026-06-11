/**
 * Room TTL behavior: signaling-only rooms expire a fixed ROOM_TTL after
 * creation (anti-squatting), while relay activity refreshes
 * room.lastActivity so an in-flight transfer outlives the TTL. Runs the
 * real server with an env-shrunk TTL and cleanup interval
 * (WEBSEND_ROOM_TTL_MS / WEBSEND_ROOM_CLEANUP_INTERVAL_MS).
 *
 * Generated with the help of Claude Code.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, stopServer, lpHandshake, lpUp, lpDown } from './helpers.mjs';

const TTL_MS = 600;
const CLEANUP_MS = 100;

let srv;
before(async () => {
    srv = await startServer({
        TEST_DISABLE_RATE_LIMIT: '1',
        WEBSEND_ROOM_TTL_MS: String(TTL_MS),
        WEBSEND_ROOM_CLEANUP_INTERVAL_MS: String(CLEANUP_MS),
    });
});
after(() => stopServer(srv.proc));

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Every room gets an offer stored right away so GET /offer serves as the
// liveness probe: 200 while the room exists, 401 once cleaned up
// (validateRoomSecret answers a missing room with the same 401 as a bad
// secret, so room existence is not enumerable).
async function newRoom() {
    const res = await fetch(`${srv.baseUrl}/api/rooms`, { method: 'POST' });
    const { roomId, secret } = await res.json();
    const stored = await fetch(`${srv.baseUrl}/api/rooms/${roomId}/offer`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Room-Secret': secret },
        body: JSON.stringify({ type: 'offer', sdp: 'v=0\r\n' }),
    });
    assert.equal(stored.status, 200);
    return { roomId, secret };
}

function getOffer(roomId, secret) {
    return fetch(`${srv.baseUrl}/api/rooms/${roomId}/offer`, {
        headers: { 'X-Room-Secret': secret },
    });
}

test('signaling-only room expires a fixed TTL after creation', async () => {
    const { roomId, secret } = await newRoom();
    assert.equal((await getOffer(roomId, secret)).status, 200, 'alive within the TTL');
    await sleep(TTL_MS + 3 * CLEANUP_MS);
    assert.equal((await getOffer(roomId, secret)).status, 401, 'gone after the TTL');
});

test('relayed frames keep a room alive well past the TTL; silence then expires it', async () => {
    const { roomId, secret } = await newRoom();
    const a = await (await lpHandshake(srv.baseUrl, roomId, secret)).json();
    const b = await (await lpHandshake(srv.baseUrl, roomId, secret)).json();

    // Simulate an in-flight transfer for ~3x the TTL: a frame every
    // TTL/3, each drained by the peer so the queue never fills.
    const deadline = Date.now() + 3 * TTL_MS;
    while (Date.now() < deadline) {
        const r = await lpUp(srv.baseUrl, roomId, secret, a.token, Buffer.from([1, 2, 3]), true);
        assert.equal(r.status, 204, 'the room must not expire while frames flow');
        await lpDown(srv.baseUrl, roomId, secret, b.token, false);
        await sleep(TTL_MS / 3);
    }
    assert.equal((await getOffer(roomId, secret)).status, 200,
        'an active relay room outlives the fixed TTL');

    // Once the transfer stops, the idle TTL applies again.
    await sleep(TTL_MS + 3 * CLEANUP_MS);
    assert.equal((await getOffer(roomId, secret)).status, 401,
        'a silent relay room still dies after the TTL');
});

test('empty down-polls alone do not keep a relay room alive', async () => {
    const { roomId, secret } = await newRoom();
    await lpHandshake(srv.baseUrl, roomId, secret);
    const b = await (await lpHandshake(srv.baseUrl, roomId, secret)).json();

    // Poll (without any frames flowing) for ~2x the TTL.
    const deadline = Date.now() + 2 * TTL_MS;
    let lastStatus = 0;
    while (Date.now() < deadline) {
        lastStatus = (await lpDown(srv.baseUrl, roomId, secret, b.token, false)).status;
        await sleep(TTL_MS / 4);
    }
    assert.equal((await getOffer(roomId, secret)).status, 401,
        `a squatter polling an idle slot must not refresh the TTL (last poll: ${lastStatus})`);
});
