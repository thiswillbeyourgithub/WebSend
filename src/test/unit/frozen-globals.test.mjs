/**
 * Verifies that the security-bearing namespace exports are frozen at
 * module load time, so a hostile script (XSS, malicious extension,
 * compromised script that loads after ours) cannot monkey-patch
 * cryptographic primitives, the protocol builder, the verification
 * gate, or the safe-blob-URL helper to subvert the E2EE handshake or
 * the anti-XSS mime forcing.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadBrowserModule } from '../support/load-browser-module.mjs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pub = path.resolve(__dirname, '../../public/js');

test('window.Protocol is frozen', async () => {
    const win = await loadBrowserModule(path.join(pub, 'protocol.js'));
    assert.ok(Object.isFrozen(win.Protocol), 'Protocol must be frozen');
    assert.ok(Object.isFrozen(win.Protocol.build), 'Protocol.build must be frozen');
    const original = win.Protocol.build.fingerprintConfirmed;
    // Strict mode would throw; non-strict silently no-ops. Either way the
    // value must NOT change.
    try { win.Protocol.build.fingerprintConfirmed = () => 'evil'; } catch (_) {}
    assert.equal(win.Protocol.build.fingerprintConfirmed, original);
});

test('window.QrParse is frozen', async () => {
    const win = await loadBrowserModule(path.join(pub, 'qr-parse.js'));
    assert.ok(Object.isFrozen(win.QrParse), 'QrParse must be frozen');
    const original = win.QrParse.parseSendInvite;
    try { win.QrParse.parseSendInvite = () => ({ ok: true, roomId: 'EVIL00', secret: 'xxxxxxxxxxxxxxxxxxxxxx' }); } catch (_) {}
    assert.equal(win.QrParse.parseSendInvite, original);
});

test('window.WebSendCrypto is frozen', async () => {
    // crypto.js relies on actual SubtleCrypto, but for the freeze
    // assertion we only need the module to have loaded. The Web Crypto
    // calls are inside method bodies, not at top level.
    const code = readFileSync(path.join(pub, 'crypto.js'), 'utf8');
    const dom = new JSDOM('<!doctype html><html></html>', { runScripts: 'outside-only' });
    dom.window.eval(code);
    const WebSendCrypto = dom.window.WebSendCrypto;
    assert.ok(Object.isFrozen(WebSendCrypto), 'WebSendCrypto must be frozen');
    const original = WebSendCrypto.deriveSharedKey;
    try { WebSendCrypto.deriveSharedKey = async () => ({ __evil: true }); } catch (_) {}
    assert.equal(WebSendCrypto.deriveSharedKey, original);
});

test('window.VerificationModal is frozen', async () => {
    const code = readFileSync(path.join(pub, 'verification-modal.js'), 'utf8');
    const dom = new JSDOM('<!doctype html><html><body><div id="verification-modal" class="hidden"></div></body></html>', { runScripts: 'outside-only' });
    dom.window.eval(code);
    assert.ok(Object.isFrozen(dom.window.VerificationModal), 'VerificationModal must be frozen');
});

test('window.SenderConnect is frozen', async () => {
    // sender-connect.js uses IIFE wrapper but only reads Protocol /
    // WebSendCrypto at call time, so loading it without those stubs is
    // safe for the freeze check.
    const code = readFileSync(path.join(pub, 'sender-connect.js'), 'utf8');
    const dom = new JSDOM('<!doctype html><html></html>', { runScripts: 'outside-only' });
    dom.window.eval(code);
    assert.ok(Object.isFrozen(dom.window.SenderConnect), 'SenderConnect must be frozen');
    const original = dom.window.SenderConnect.isVerified;
    try { dom.window.SenderConnect.isVerified = () => true; } catch (_) {}
    assert.equal(dom.window.SenderConnect.isVerified, original);
});

test('window.SenderSend is frozen', async () => {
    const code = readFileSync(path.join(pub, 'sender-send.js'), 'utf8');
    const dom = new JSDOM('<!doctype html><html></html>', { runScripts: 'outside-only' });
    dom.window.eval(code);
    assert.ok(Object.isFrozen(dom.window.SenderSend), 'SenderSend must be frozen');
});

test('window.ReceiveCard is frozen', async () => {
    const code = readFileSync(path.join(pub, 'receive-card.js'), 'utf8');
    const dom = new JSDOM('<!doctype html><html></html>', { runScripts: 'outside-only' });
    dom.window.eval(code);
    assert.ok(Object.isFrozen(dom.window.ReceiveCard), 'ReceiveCard must be frozen');
    const original = dom.window.ReceiveCard.makeSafeBlobUrl;
    try { dom.window.ReceiveCard.makeSafeBlobUrl = () => 'blob:evil'; } catch (_) {}
    assert.equal(dom.window.ReceiveCard.makeSafeBlobUrl, original);
});
