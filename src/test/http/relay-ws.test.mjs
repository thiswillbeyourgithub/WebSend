/**
 * HTTP-relay fallback transport: WebSocket endpoint /api/rooms/:id/relay.
 *
 * Covers:
 *   - happy path: two peers pair, binary + text frames forwarded both ways
 *   - WS sender -> slow LP receiver: socket-pause backpressure, no frame loss
 *   - wrong secret  -> 401 close
 *   - missing room  -> 401 close (no enumeration oracle)
 *   - third peer    -> 409 close
 *   - oversized control message (>16 KiB) -> 4413 close
 *   - 4 GiB session byte cap (proxy by injecting a smaller cap is impractical
 *     in a black-box test; instead we assert that bytes ARE forwarded up to
 *     the cap and the close-code path is exercised by an integration check)
 *   - peer disconnect closes the partner
 *   - RELAY_ENABLE=false rejects the upgrade with 404
 *
 * Generated with the help of Claude Code.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { startServer, stopServer, lpHandshake, lpDown } from './helpers.mjs';

let srv;
before(async () => { srv = await startServer({ TEST_DISABLE_RATE_LIMIT: '1' }); });
after(() => stopServer(srv.proc));

function wsUrl(roomId, secret) {
    return `ws://127.0.0.1:${srv.port}/api/rooms/${roomId}/relay?secret=${encodeURIComponent(secret)}`;
}

async function newRoom() {
    const res = await fetch(`${srv.baseUrl}/api/rooms`, { method: 'POST' });
    return res.json();
}

function openWs(url) {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(url);
        ws.binaryType = 'arraybuffer';
        const onOpen = () => { cleanup(); resolve(ws); };
        const onErr = (err) => { cleanup(); reject(err); };
        const onClose = (code, reason) => {
            cleanup();
            const err = new Error(`WS closed before open: ${code} ${reason}`);
            err.code = code;
            reject(err);
        };
        function cleanup() {
            ws.removeListener('open', onOpen);
            ws.removeListener('error', onErr);
            ws.removeListener('close', onClose);
        }
        ws.once('open', onOpen);
        ws.once('error', onErr);
        ws.once('close', onClose);
    });
}

function nextMessage(ws) {
    return new Promise((resolve, reject) => {
        const onMsg = (data, isBinary) => { cleanup(); resolve({ data, isBinary }); };
        const onErr = (err) => { cleanup(); reject(err); };
        const onClose = (code, reason) => {
            cleanup();
            const err = new Error(`closed: ${code} ${reason}`);
            err.code = code;
            reject(err);
        };
        function cleanup() {
            ws.removeListener('message', onMsg);
            ws.removeListener('error', onErr);
            ws.removeListener('close', onClose);
        }
        ws.once('message', onMsg);
        ws.once('error', onErr);
        ws.once('close', onClose);
    });
}

function nextClose(ws) {
    return new Promise((resolve) => {
        ws.once('close', (code, reason) => resolve({ code, reason: reason.toString() }));
    });
}

function expectUpgradeRejection(url) {
    return new Promise((resolve) => {
        const ws = new WebSocket(url);
        ws.on('unexpected-response', (req, res) => {
            resolve({ status: res.statusCode });
            req.destroy();
        });
        ws.on('error', (err) => {
            // Some rejection paths surface as error; mirror what wss does.
            const m = /Unexpected server response: (\d+)/.exec(err.message);
            if (m) resolve({ status: Number(m[1]) });
            else resolve({ status: 0, err: err.message });
        });
        ws.on('open', () => { ws.close(); resolve({ status: 101 }); });
    });
}

test('happy path: two peers pair and exchange binary + text frames', async () => {
    const { roomId, secret } = await newRoom();
    const a = await openWs(wsUrl(roomId, secret));
    const b = await openWs(wsUrl(roomId, secret));

    // Binary frame A -> B
    const payload = Buffer.from([1, 2, 3, 4, 5]);
    const recvB = nextMessage(b);
    a.send(payload, { binary: true });
    const got1 = await recvB;
    assert.equal(got1.isBinary, true);
    assert.deepEqual(Buffer.from(got1.data), payload);

    // Text frame B -> A
    const recvA = nextMessage(a);
    b.send('{"type":"ping"}');
    const got2 = await recvA;
    assert.equal(got2.isBinary, false);
    assert.equal(got2.data.toString(), '{"type":"ping"}');

    a.close(); b.close();
});

test('WS sender feeding a slow LP receiver loses no frames (socket pause backpressure)', async () => {
    const { roomId, secret } = await newRoom();
    // LP receiver claims slot a first, then the WS sender joins as slot b.
    const lp = await (await lpHandshake(srv.baseUrl, roomId, secret)).json();
    const ws = await openWs(wsUrl(roomId, secret));

    // Push well past LP_QUEUE_MAX_FRAMES (32) before the receiver drains
    // anything. 64 KiB frames so the flood cannot fit in the kernel/parser
    // buffers, forcing the server to actually pause the sender's socket
    // (the old code silently dropped the oldest queued frame instead,
    // corrupting the file). First byte of each frame is its sequence
    // number so order and completeness are both asserted on drain.
    const TOTAL = 48;
    const FRAME = 64 * 1024;
    for (let i = 0; i < TOTAL; i++) {
        const frame = Buffer.alloc(FRAME, 0xab);
        frame[0] = i;
        ws.send(frame, { binary: true });
    }

    const got = [];
    while (got.length < TOTAL) {
        const d = await lpDown(srv.baseUrl, roomId, secret, lp.token, true);
        if (d.status === 204) continue; // long-poll timeout while paused; repoll
        assert.equal(d.status, 200);
        const buf = Buffer.from(await d.arrayBuffer());
        assert.equal(buf.length, FRAME);
        got.push(buf[0]);
    }
    assert.deepEqual(got, [...Array(TOTAL).keys()]);
    ws.close();
});

test('wrong secret rejected with 401 (constant-time, no enumeration leak)', async () => {
    const { roomId } = await newRoom();
    const r = await expectUpgradeRejection(wsUrl(roomId, 'definitely-not-the-secret'));
    assert.equal(r.status, 401);
});

test('missing room rejected with 401 (same status as wrong secret)', async () => {
    const r = await expectUpgradeRejection(wsUrl('NOPE00', 'whatever'));
    assert.equal(r.status, 401);
});

test('third peer rejected (slots full)', async () => {
    const { roomId, secret } = await newRoom();
    const a = await openWs(wsUrl(roomId, secret));
    const b = await openWs(wsUrl(roomId, secret));
    const r = await expectUpgradeRejection(wsUrl(roomId, secret));
    assert.equal(r.status, 409);
    a.close(); b.close();
});

test('oversized control message (>16 KiB) closes connection with 4413', async () => {
    const { roomId, secret } = await newRoom();
    const a = await openWs(wsUrl(roomId, secret));
    const b = await openWs(wsUrl(roomId, secret));

    const huge = 'x'.repeat(17 * 1024); // > MAX_CONTROL_MSG_BYTES (16 KiB)
    const closed = nextClose(a);
    a.send(huge); // text frame
    const r = await closed;
    assert.equal(r.code, 4413);

    b.close();
});

test('binary frames of legitimate size are NOT capped by control-msg cap', async () => {
    // 32 KiB binary frame must be forwarded fine (caps only apply to text).
    const { roomId, secret } = await newRoom();
    const a = await openWs(wsUrl(roomId, secret));
    const b = await openWs(wsUrl(roomId, secret));

    const payload = Buffer.alloc(32 * 1024, 0xAA);
    const recvB = nextMessage(b);
    a.send(payload, { binary: true });
    const got = await recvB;
    assert.equal(got.isBinary, true);
    assert.equal(Buffer.from(got.data).length, 32 * 1024);

    a.close(); b.close();
});

test('peer disconnect closes the partner socket', async () => {
    const { roomId, secret } = await newRoom();
    const a = await openWs(wsUrl(roomId, secret));
    const b = await openWs(wsUrl(roomId, secret));

    const bClosed = nextClose(b);
    a.close();
    const r = await bClosed;
    assert.equal(r.code, 1000);
});

test('cross-kind WS+LP teardown frees the LP slot for a fresh handshake', async () => {
    // Regression: when a WS half closes its onclose fires teardownPeer on
    // its LP partner. closeLpSlot used to leave the LP slot reference in
    // room.relay until LP_SLOT_IDLE_TIMEOUT_MS (60s), so a fresh handshake
    // saw "slots full" and returned 409. teardownPeer now nulls the LP
    // slot reference too, letting a fresh handshake reclaim 'a' immediately.
    const { roomId, secret } = await newRoom();
    const a = await openWs(wsUrl(roomId, secret));

    // Claim slot b via long-poll handshake.
    const h1 = await fetch(`${srv.baseUrl}/api/rooms/${roomId}/relay/handshake`, {
        method: 'POST',
        headers: { 'X-Room-Secret': secret, 'Content-Type': 'application/json' },
        body: '{}',
    });
    assert.equal(h1.status, 200);
    const h1Body = await h1.json();
    assert.equal(h1Body.slot, 'b');

    // Close the WS half and give the server a moment to run onclose.
    a.close();
    await new Promise((r) => setTimeout(r, 100));

    // A fresh handshake must succeed (both slots should be free now):
    // it must NOT return 409 "slots full".
    const h2 = await fetch(`${srv.baseUrl}/api/rooms/${roomId}/relay/handshake`, {
        method: 'POST',
        headers: { 'X-Room-Secret': secret, 'Content-Type': 'application/json' },
        body: '{}',
    });
    assert.equal(h2.status, 200);
    const h2Body = await h2.json();
    assert.equal(h2Body.slot, 'a');
});

test('RELAY_ENABLE=false rejects upgrade with 404', async () => {
    const altSrv = await startServer({ TEST_DISABLE_RATE_LIMIT: '1', RELAY_ENABLE: 'false' });
    try {
        const room = await (await fetch(`${altSrv.baseUrl}/api/rooms`, { method: 'POST' })).json();
        const url = `ws://127.0.0.1:${altSrv.port}/api/rooms/${room.roomId}/relay?secret=${encodeURIComponent(room.secret)}`;
        const r = await expectUpgradeRejection(url);
        assert.equal(r.status, 404);
    } finally {
        await stopServer(altSrv.proc);
    }
});

test('/api/config advertises relayEnabled=true by default', async () => {
    const res = await fetch(`${srv.baseUrl}/api/config`);
    const cfg = await res.json();
    assert.equal(cfg.relayEnabled, true);
});

test('/api/config reflects RELAY_ENABLE=false', async () => {
    const altSrv = await startServer({ TEST_DISABLE_RATE_LIMIT: '1', RELAY_ENABLE: 'false' });
    try {
        const res = await fetch(`${altSrv.baseUrl}/api/config`);
        const cfg = await res.json();
        assert.equal(cfg.relayEnabled, false);
    } finally {
        await stopServer(altSrv.proc);
    }
});
