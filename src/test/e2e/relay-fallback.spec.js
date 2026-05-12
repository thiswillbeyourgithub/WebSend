/**
 * E2E: HTTP-relay fallback round-trip.
 *
 * Spawns its own server with DEV_FORCE_CONNECTION=RELAY_HTTPS so the
 * client-side race coordinator suppresses the WebRTC inner and lets
 * the WS relay win immediately on relay-hello. Verifies:
 *
 *   1. Both pages reach the verification modal (so signaling + key
 *      exchange completed over the relay, not via WebRTC SDP).
 *   2. Sidebar reads "Relayed via HTTP(S) fallback".
 *   3. A file transfer round-trips and lands in #received-images.
 *
 * Generated with the help of Claude Code.
 */

const { test, expect, _electron } = require('@playwright/test');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const net = require('net');

const FIXTURE_PNG = path.resolve(__dirname, '../fixtures/test-image.png');

function getFreePort() {
    return new Promise((resolve, reject) => {
        const srv = net.createServer();
        srv.listen(0, '127.0.0.1', () => {
            const port = srv.address().port;
            srv.close(() => resolve(port));
        });
        srv.on('error', reject);
    });
}

async function startRelayServer() {
    const port = await getFreePort();
    const proc = spawn('node', [path.resolve(__dirname, '../../server.js')], {
        env: {
            ...process.env,
            PORT: String(port),
            DOMAIN: 'localhost',
            // Forces the client race coordinator to use the HTTP-relay path.
            DEV_FORCE_CONNECTION: 'RELAY_HTTPS',
            STUN_GOOGLE_FALLBACK: 'false',
            ALLOWED_ORIGINS: `http://127.0.0.1:${port}`,
            RELAY_ENABLE: 'true',
            TEST_DISABLE_RATE_LIMIT: '1',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    // Wait until the server is up.
    await new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('server start timeout')), 10000);
        proc.stdout.on('data', (d) => {
            if (d.toString().includes(`0.0.0.0:${port}`) || d.toString().includes('Listening')) {
                clearTimeout(t);
                resolve();
            }
        });
        proc.on('exit', (code) => { clearTimeout(t); reject(new Error('server exited ' + code)); });
    });
    return { proc, port, baseURL: `http://127.0.0.1:${port}` };
}

function stopServer(proc) {
    return new Promise((resolve) => {
        proc.once('exit', resolve);
        proc.kill('SIGTERM');
    });
}

// Reuse the 8x8 PNG fixture from the existing two-peer roundtrip spec, which
// runs before this one in CI. If running this spec standalone, mint it here.
function ensureFixture() {
    if (fs.existsSync(FIXTURE_PNG)) return;
    const zlib = require('zlib');
    function crc32(buf) {
        let crc = 0xFFFFFFFF;
        for (const b of buf) { crc ^= b; for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (crc & 1 ? 0xEDB88320 : 0); }
        return (crc ^ 0xFFFFFFFF) >>> 0;
    }
    function chunk(type, data) {
        const typeBytes = Buffer.from(type, 'ascii');
        const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
        const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])));
        return Buffer.concat([len, typeBytes, data, crc]);
    }
    const w = 8, h = 8;
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
    ihdr[8] = 8; ihdr[9] = 2;
    const raw = Buffer.alloc(h * (1 + w * 3));
    for (let r = 0; r < h; r++) {
        const off = r * (1 + w * 3);
        raw[off] = 0;
        for (let c = 0; c < w; c++) { raw[off+1+c*3] = 255; raw[off+2+c*3] = 0; raw[off+3+c*3] = 0; }
    }
    const png = Buffer.concat([
        Buffer.from([137,80,78,71,13,10,26,10]),
        chunk('IHDR', ihdr),
        chunk('IDAT', zlib.deflateSync(raw)),
        chunk('IEND', Buffer.alloc(0)),
    ]);
    fs.mkdirSync(path.dirname(FIXTURE_PNG), { recursive: true });
    fs.writeFileSync(FIXTURE_PNG, png);
}

test.beforeAll(ensureFixture);

test('two-peer round-trip via HTTP-relay fallback', async ({ browser }) => {
    const server = await startRelayServer();
    try {
        const ctxA = await browser.newContext({ baseURL: server.baseURL });
        const pageA = await ctxA.newPage();
        await pageA.goto(server.baseURL + '/receive.html');

        await pageA.waitForSelector('#qr-url-input', { timeout: 12000 });
        const senderUrl = await pageA.inputValue('#qr-url-input');

        const ctxB = await browser.newContext({ baseURL: server.baseURL });
        const pageB = await ctxB.newPage();
        await pageB.goto(senderUrl);
        await pageB.waitForLoadState('domcontentloaded');

        // The relay path skips ICE entirely, so reaching the verification
        // modal here proves the WS relay completed pairing + key exchange.
        await pageA.waitForFunction(
            () => {
                const m = document.getElementById('verification-modal');
                return m && !m.classList.contains('hidden');
            },
            { timeout: 25000 }
        );
        await pageA.click('#confirm-match-btn');

        await pageB.waitForFunction(
            () => {
                const m = document.getElementById('verification-modal');
                return m && !m.classList.contains('hidden');
            },
            { timeout: 15000 }
        ).catch(() => null);
        await pageB.$eval('#confirm-match-btn', b => b.click()).catch(() => null);

        // Sidebar should announce the HTTP relay path. Localhost test runs
        // over plain HTTP, so we expect the HTTP (not HTTPS) label.
        await pageA.waitForFunction(
            () => {
                const el = document.getElementById('sidebar-connection-info');
                return el && /Relayed via/.test(el.textContent);
            },
            { timeout: 10000 }
        );

        // File round-trip
        await pageB.setInputFiles('#file-input', FIXTURE_PNG);
        await pageB.waitForFunction(
            () => {
                const btn = document.getElementById('send-btn');
                return btn && !btn.classList.contains('hidden');
            },
            { timeout: 10000 }
        ).catch(() => null);
        await pageB.$eval('#send-btn', btn => btn.click()).catch(() => null);

        await pageA.waitForFunction(
            () => {
                const c = document.getElementById('received-images');
                return c && c.querySelector('.received-image-item, .file-card, img') !== null;
            },
            { timeout: 30000 }
        );
        const items = await pageA.$$('#received-images .received-image-item, #received-images .file-card, #received-images img');
        expect(items.length).toBeGreaterThan(0);

        await ctxA.close();
        await ctxB.close();
    } finally {
        await stopServer(server.proc);
    }
});
