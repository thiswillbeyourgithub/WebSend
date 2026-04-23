/**
 * Coverage for room endpoints not exercised by rooms.test.mjs:
 *  - GET /api/rooms/:id (existence probe)
 *  - ICE answer POST/GET round-trip
 *  - Empty-state behaviors: 204 on no answer, 404 on offer-not-ready
 *  - 404 on nonexistent room (even with any secret)
 *  - JSON body size limit (50kb) → 413
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, stopServer } from './helpers.mjs';

let srv;
// Disable rate limiting: this file creates >5 rooms per run, which would trip
// the 5-rooms-per-minute roomCreation limiter.
before(async () => { srv = await startServer({ TEST_DISABLE_RATE_LIMIT: '1' }); });
after(() => stopServer(srv.proc));

const post = (url, body, secret) => fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(secret ? { 'X-Room-Secret': secret } : {}) },
    body: JSON.stringify(body),
});
const get = (url, secret) => fetch(url, { headers: secret ? { 'X-Room-Secret': secret } : {} });

async function newRoom() {
    return (await post(`${srv.baseUrl}/api/rooms`, {})).json();
}

test('GET /api/rooms/:id reports existence and offer/answer state', async () => {
    const { roomId, secret } = await newRoom();

    // Fresh room: exists, no offer, no answer
    let res = await get(`${srv.baseUrl}/api/rooms/${roomId}`, secret);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { exists: true, hasOffer: false, hasAnswer: false });

    // After posting an offer: hasOffer flips to true
    await post(`${srv.baseUrl}/api/rooms/${roomId}/offer`, { offer: { type: 'offer', sdp: 'v=0\r\n' } }, secret);
    res = await get(`${srv.baseUrl}/api/rooms/${roomId}`, secret);
    assert.deepEqual(await res.json(), { exists: true, hasOffer: true, hasAnswer: false });
});

test('GET /api/rooms/:id on nonexistent room returns 404', async () => {
    const res = await get(`${srv.baseUrl}/api/rooms/ZZZZZZ`, 'anysecret');
    assert.equal(res.status, 404);
});

test('GET /api/rooms/:id/offer returns 404 when no offer posted yet', async () => {
    const { roomId, secret } = await newRoom();
    const res = await get(`${srv.baseUrl}/api/rooms/${roomId}/offer`, secret);
    assert.equal(res.status, 404);
});

test('GET /api/rooms/:id/answer without wait returns 204 when no answer', async () => {
    const { roomId, secret } = await newRoom();
    const res = await get(`${srv.baseUrl}/api/rooms/${roomId}/answer`, secret);
    assert.equal(res.status, 204);
});

test('ICE answer: POST then GET round-trip', async () => {
    const { roomId, secret } = await newRoom();
    const cand = { candidate: 'candidate:2 1 UDP 1 10.0.0.1 40000 typ host', sdpMid: '0' };

    const postRes = await post(`${srv.baseUrl}/api/rooms/${roomId}/ice/answer`, cand, secret);
    assert.equal(postRes.status, 200);

    const getRes = await get(`${srv.baseUrl}/api/rooms/${roomId}/ice/answer`, secret);
    assert.equal(getRes.status, 200);
    const body = await getRes.json();
    assert.ok(Array.isArray(body.candidates));
    assert.deepEqual(body.candidates[0], cand);
});

test('ICE endpoints start with empty candidate list', async () => {
    const { roomId, secret } = await newRoom();
    const offerRes = await get(`${srv.baseUrl}/api/rooms/${roomId}/ice/offer`, secret);
    assert.deepEqual(await offerRes.json(), { candidates: [] });
    const answerRes = await get(`${srv.baseUrl}/api/rooms/${roomId}/ice/answer`, secret);
    assert.deepEqual(await answerRes.json(), { candidates: [] });
});

test('ICE candidates accumulate in insertion order', async () => {
    const { roomId, secret } = await newRoom();
    const c1 = { candidate: 'candidate:1 1 UDP 1 1.1.1.1 1 typ host' };
    const c2 = { candidate: 'candidate:2 1 UDP 1 2.2.2.2 2 typ host' };
    await post(`${srv.baseUrl}/api/rooms/${roomId}/ice/offer`, c1, secret);
    await post(`${srv.baseUrl}/api/rooms/${roomId}/ice/offer`, c2, secret);
    const res = await get(`${srv.baseUrl}/api/rooms/${roomId}/ice/offer`, secret);
    const { candidates } = await res.json();
    assert.equal(candidates.length, 2);
    assert.deepEqual(candidates, [c1, c2]);
});

test('Request without X-Room-Secret returns 401', async () => {
    const { roomId } = await newRoom();
    const res = await post(`${srv.baseUrl}/api/rooms/${roomId}/offer`,
        { offer: { type: 'offer', sdp: 'v=0\r\n' } }); // no secret
    assert.equal(res.status, 401);
});

test('JSON body over 50kb limit is rejected (413)', async () => {
    const { roomId, secret } = await newRoom();
    // ~60kb of SDP — well past the 50kb cap
    const huge = { offer: { type: 'offer', sdp: 'v=0\r\n' + 'a'.repeat(60 * 1024) } };
    const res = await post(`${srv.baseUrl}/api/rooms/${roomId}/offer`, huge, secret);
    assert.equal(res.status, 413);
});
