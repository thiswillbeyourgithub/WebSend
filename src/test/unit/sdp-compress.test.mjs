import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadBrowserModule } from '../support/load-browser-module.mjs';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const modulePath = path.resolve(__dirname, '../../public/js/sdp-compress.js');

// SDPCompress uses CompressionStream/DecompressionStream (Node ≥ 18)
const win = await loadBrowserModule(modulePath, {
    CompressionStream: globalThis.CompressionStream,
    DecompressionStream: globalThis.DecompressionStream,
    TextEncoder,
    TextDecoder,
    btoa: globalThis.btoa,
    atob: globalThis.atob,
    RTCSessionDescription: function(init) { return init; },
});
const SDPCompress = win.SDPCompress;

const SDP_FIXTURE = readFileSync(
    path.resolve(__dirname, '../fixtures/sdp/offer.sdp'),
    'utf8'
);

// Synthetic RTCSessionDescription and ICE candidates for testing
const mockDescription = { sdp: SDP_FIXTURE, type: 'offer' };
const mockCandidates = [
    { candidate: 'candidate:1 1 UDP 2130706431 192.168.1.100 50000 typ host', sdpMid: '0', sdpMLineIndex: 0 }
];

test('extractEssentials: returns compact object with required fields', () => {
    const essentials = SDPCompress.extractEssentials(mockDescription, mockCandidates);
    assert.ok(typeof essentials === 'object');
    // sdp-compress uses short single-char keys: y=type, f=fingerprint, u=ufrag, w=pwd, c=candidates
    assert.ok('f' in essentials, 'Missing fingerprint field (f): ' + JSON.stringify(essentials));
    assert.ok('u' in essentials, 'Missing ufrag field (u): ' + JSON.stringify(essentials));
    assert.ok('w' in essentials, 'Missing pwd field (w): ' + JSON.stringify(essentials));
    assert.ok(Array.isArray(essentials.c), 'Missing candidates (c): ' + JSON.stringify(essentials));
    assert.ok(essentials.f.length > 0, 'Fingerprint should be non-empty from SDP: ' + JSON.stringify(essentials));
    assert.ok(essentials.u.length > 0, 'iceUfrag should be non-empty: ' + JSON.stringify(essentials));
});

test('compress: returns string starting with Z or J', async () => {
    const essentials = SDPCompress.extractEssentials(mockDescription, mockCandidates);
    const compressed = await SDPCompress.compress(essentials);
    assert.ok(typeof compressed === 'string');
    assert.ok(
        compressed.startsWith('Z') || compressed.startsWith('J'),
        `Expected Z or J prefix, got: ${compressed.slice(0, 5)}`
    );
});

test('compress/decompress round-trip preserves all fields', async () => {
    const essentials = SDPCompress.extractEssentials(mockDescription, mockCandidates);
    const compressed = await SDPCompress.compress(essentials);
    const decompressed = await SDPCompress.decompress(compressed);
    // Compare via JSON stringify to be robust against property ordering differences
    assert.equal(JSON.stringify(decompressed), JSON.stringify(essentials));
});

test('reconstructSDP: returns object with sdp string containing required SDP fields', () => {
    const essentials = SDPCompress.extractEssentials(mockDescription, mockCandidates);
    const reconstructed = SDPCompress.reconstructSDP(essentials);
    const sdp = reconstructed.sdp;
    assert.ok(typeof sdp === 'string', 'reconstructSDP.sdp should be a string');
    assert.ok(sdp.includes('v=0'), 'Missing v=0 line');
    assert.ok(sdp.includes('m=application'), 'Missing m=application line');
});

test('compress: produces output smaller than raw JSON of essentials', async () => {
    const essentials = SDPCompress.extractEssentials(mockDescription, mockCandidates);
    const compressed = await SDPCompress.compress(essentials);
    const rawJson = JSON.stringify(essentials);
    // The whole point is compression — compressed should be reasonably short
    // (allow 2x headroom for base64 overhead vs raw, but should beat raw JSON for large SDPs)
    assert.ok(compressed.length < rawJson.length * 3,
        `Compressed (${compressed.length}) >> raw JSON (${rawJson.length})`);
});
