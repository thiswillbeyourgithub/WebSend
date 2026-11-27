import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, stopServer } from './helpers.mjs';

let srv;
// Disable rate limiting: this file creates many rooms per run from one
// client, so it must not depend on the roomCreation limiter's budget
// (a trip would cause sporadic 429s in later tests).
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
    assert.ok(typeof body.hostSecret === 'string' && body.hostSecret.length > 8, `Bad hostSecret: ${body.hostSecret}`);
    assert.notEqual(body.hostSecret, body.secret);
});

test('POST /api/rooms/:id/offer stores offer; GET retrieves it', async () => {
    const { roomId, secret, hostSecret } = await (await post(`${srv.baseUrl}/api/rooms`, {})).json();
    const offer = { type: 'offer', sdp: 'v=0\r\no=test 1 1 IN IP4 0.0.0.0\r\n' };

    const postRes = await post(`${srv.baseUrl}/api/rooms/${roomId}/offer`, offer, hostSecret);
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
    const { roomId, hostSecret } = await (await post(`${srv.baseUrl}/api/rooms`, {})).json();

    // Wrong type
    let r = await post(`${srv.baseUrl}/api/rooms/${roomId}/offer`, { type: 'answer', sdp: 'v=0\r\n' }, hostSecret);
    assert.equal(r.status, 400);

    // Missing sdp
    r = await post(`${srv.baseUrl}/api/rooms/${roomId}/offer`, { type: 'offer' }, hostSecret);
    assert.equal(r.status, 400);

    // Extra field smuggled in
    r = await post(`${srv.baseUrl}/api/rooms/${roomId}/offer`, { type: 'offer', sdp: 'v=0\r\n', evil: 1 }, hostSecret);
    assert.equal(r.status, 400);

    // Oversize sdp
    r = await post(`${srv.baseUrl}/api/rooms/${roomId}/offer`, { type: 'offer', sdp: 'x'.repeat(20_001) }, hostSecret);
    assert.equal(r.status, 400);
});

test('POST /api/rooms/:id/answer + GET /api/rooms/:id/answer?wait=true round-trip', async () => {
    const { roomId, secret, hostSecret } = await (await post(`${srv.baseUrl}/api/rooms`, {})).json();
    // Post an offer first
    await post(`${srv.baseUrl}/api/rooms/${roomId}/offer`,
        { type: 'offer', sdp: 'v=0\r\n' }, hostSecret);

    const answer = { type: 'answer', sdp: 'v=0\r\na=answer\r\n' };

    // Start long-poll first (blocks until answer is posted)
    const pollPromise = get(`${srv.baseUrl}/api/rooms/${roomId}/answer?wait=true`, hostSecret);

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
    const { roomId, secret, hostSecret } = await (await post(`${srv.baseUrl}/api/rooms`, {})).json();
    // The server stores req.body directly, so send the candidate fields at the top level
    const candidateBody = { candidate: 'candidate:1 1 UDP 2130706431 192.168.1.1 50000 typ host', sdpMid: '0' };

    const postRes = await post(`${srv.baseUrl}/api/rooms/${roomId}/ice/offer`, candidateBody, hostSecret);
    assert.equal(postRes.status, 200);

    const getRes = await get(`${srv.baseUrl}/api/rooms/${roomId}/ice/offer`, secret);
    assert.equal(getRes.status, 200);
    const body = await getRes.json();
    assert.ok(Array.isArray(body.candidates));
    assert.deepEqual(body.candidates[0], candidateBody);
});

// Per-role secrets: the QR (sender) secret must not authorise the
// receiver's routes and vice versa. Each route is tried with the WRONG
// role's secret (expect 401, same shape as a bad secret) and then with
// the right one (expect anything but 401).
const ROLE_ROUTES = [
    // [method, path suffix, required role, body]
    ['POST', 'offer', 'host', { type: 'offer', sdp: 'v=0\r\n' }],
    ['GET', 'offer', 'sender'],
    ['POST', 'answer', 'sender', { type: 'answer', sdp: 'v=0\r\n' }],
    ['GET', 'answer', 'host'],
    ['POST', 'ice/offer', 'host', { candidate: 'candidate:1 1 UDP 1 10.0.0.1 1 typ host', sdpMid: '0' }],
    ['GET', 'ice/offer', 'sender'],
    ['POST', 'ice/answer', 'sender', { candidate: 'candidate:1 1 UDP 1 10.0.0.1 1 typ host', sdpMid: '0' }],
    ['GET', 'ice/answer', 'host'],
];

for (const [method, suffix, role, body] of ROLE_ROUTES) {
    test(`${method} /api/rooms/:id/${suffix} requires the ${role} secret`, async () => {
        const room = await (await post(`${srv.baseUrl}/api/rooms`, {})).json();
        const right = role === 'host' ? room.hostSecret : room.secret;
        const wrong = role === 'host' ? room.secret : room.hostSecret;
        const url = `${srv.baseUrl}/api/rooms/${room.roomId}/${suffix}`;
        const call = (secret) => method === 'POST' ? post(url, body, secret) : get(url, secret);

        const denied = await call(wrong);
        assert.equal(denied.status, 401, `wrong role must be refused on ${method} ${suffix}`);
        assert.deepEqual(await denied.json(), { error: 'Invalid or missing room secret' });

        const allowed = await call(right);
        assert.notEqual(allowed.status, 401, `right role must be admitted on ${method} ${suffix}`);
    });
}

test('GET /api/rooms/:id accepts both the host and the sender secret', async () => {
    const { roomId, secret, hostSecret } = await (await post(`${srv.baseUrl}/api/rooms`, {})).json();
    for (const s of [secret, hostSecret]) {
        const r = await get(`${srv.baseUrl}/api/rooms/${roomId}`, s);
        assert.equal(r.status, 200);
    }
    assert.equal((await get(`${srv.baseUrl}/api/rooms/${roomId}`, 'nope')).status, 401);
});
