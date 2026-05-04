import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, stopServer } from './helpers.mjs';

let srv;
// Disable rate limiting: this file creates >5 rooms per run, which would trip
// the 5/min creation cap and cause sporadic 429s in later tests.
before(async () => { srv = await startServer({ TEST_DISABLE_RATE_LIMIT: '1' }); });
after(() => stopServer(srv.proc));

async function post(url, body, secret) {
    return fetch(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            ...(secret ? { 'X-Room-Secret': secret } : {}),
        },
        body: JSON.stringify(body),
    });
}

async function get(url, secret) {
    return fetch(url, {
        headers: secret ? { 'X-Room-Secret': secret } : {},
    });
}

test('POST /api/rooms creates a room with roomId and secret', async () => {
    const res = await post(`${srv.baseUrl}/api/rooms`, {});
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(typeof body.roomId === 'string' && body.roomId.length === 6, `Bad roomId: ${body.roomId}`);
    assert.ok(typeof body.secret === 'string' && body.secret.length > 8, `Bad secret: ${body.secret}`);
});

test('POST /api/rooms/:id/offer stores offer; GET retrieves it', async () => {
    const { roomId, secret } = await (await post(`${srv.baseUrl}/api/rooms`, {})).json();
    const offer = { type: 'offer', sdp: 'v=0\r\no=test 1 1 IN IP4 0.0.0.0\r\n' };

    const postRes = await post(`${srv.baseUrl}/api/rooms/${roomId}/offer`, offer, secret);
    assert.equal(postRes.status, 200);

    const getRes = await get(`${srv.baseUrl}/api/rooms/${roomId}/offer`, secret);
    assert.equal(getRes.status, 200);
    const body = await getRes.json();
    assert.deepEqual(body, offer);
});

test('POST /api/rooms/:id/offer returns 401 with wrong secret', async () => {
    const { roomId } = await (await post(`${srv.baseUrl}/api/rooms`, {})).json();
    const res = await post(`${srv.baseUrl}/api/rooms/${roomId}/offer`,
        { type: 'offer', sdp: 'v=0\r\n' },
        'wrongsecret');
    assert.equal(res.status, 401);
});

test('POST /api/rooms/:id/offer rejects malformed body (400)', async () => {
    const { roomId, secret } = await (await post(`${srv.baseUrl}/api/rooms`, {})).json();

    // Wrong type
    let r = await post(`${srv.baseUrl}/api/rooms/${roomId}/offer`, { type: 'answer', sdp: 'v=0\r\n' }, secret);
    assert.equal(r.status, 400);

    // Missing sdp
    r = await post(`${srv.baseUrl}/api/rooms/${roomId}/offer`, { type: 'offer' }, secret);
    assert.equal(r.status, 400);

    // Extra field smuggled in
    r = await post(`${srv.baseUrl}/api/rooms/${roomId}/offer`, { type: 'offer', sdp: 'v=0\r\n', evil: 1 }, secret);
    assert.equal(r.status, 400);

    // Oversize sdp
    r = await post(`${srv.baseUrl}/api/rooms/${roomId}/offer`, { type: 'offer', sdp: 'x'.repeat(20_001) }, secret);
    assert.equal(r.status, 400);
});

test('POST /api/rooms/:id/answer + GET /api/rooms/:id/answer?wait=true round-trip', async () => {
    const { roomId, secret } = await (await post(`${srv.baseUrl}/api/rooms`, {})).json();
    // Post an offer first
    await post(`${srv.baseUrl}/api/rooms/${roomId}/offer`,
        { type: 'offer', sdp: 'v=0\r\n' }, secret);

    const answer = { type: 'answer', sdp: 'v=0\r\na=answer\r\n' };

    // Start long-poll first (blocks until answer is posted)
    const pollPromise = get(`${srv.baseUrl}/api/rooms/${roomId}/answer?wait=true`, secret);

    // Post the answer shortly after
    await new Promise(r => setTimeout(r, 50));
    const postRes = await post(`${srv.baseUrl}/api/rooms/${roomId}/answer`, answer, secret);
    assert.equal(postRes.status, 200);

    const pollRes = await pollPromise;
    assert.equal(pollRes.status, 200);
    const body = await pollRes.json();
    assert.deepEqual(body, answer);
});

test('ICE candidate offer: POST then GET round-trip', async () => {
    const { roomId, secret } = await (await post(`${srv.baseUrl}/api/rooms`, {})).json();
    // The server stores req.body directly, so send the candidate fields at the top level
    const candidateBody = { candidate: 'candidate:1 1 UDP 2130706431 192.168.1.1 50000 typ host', sdpMid: '0' };

    const postRes = await post(`${srv.baseUrl}/api/rooms/${roomId}/ice/offer`, candidateBody, secret);
    assert.equal(postRes.status, 200);

    const getRes = await get(`${srv.baseUrl}/api/rooms/${roomId}/ice/offer`, secret);
    assert.equal(getRes.status, 200);
    const body = await getRes.json();
    assert.ok(Array.isArray(body.candidates));
    assert.deepEqual(body.candidates[0], candidateBody);
});
