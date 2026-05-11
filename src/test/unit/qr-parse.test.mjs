/**
 * Unit tests for js/qr-parse.js — focused on the foreign-origin
 * defense (a QR encoding `https://attacker.example/send/...#...` must
 * be refused even when the room+secret look syntactically valid) and
 * the basic well-formed / malformed / missing-secret cases that the
 * caller in send.html maps to specific user-facing toasts.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { JSDOM } from 'jsdom';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const moduleSource = readFileSync(
    path.resolve(__dirname, '../../public/js/qr-parse.js'),
    'utf8'
);

function load() {
    const dom = new JSDOM('<!doctype html><html><body></body></html>', {
        runScripts: 'outside-only', url: 'https://websend.example.org/',
    });
    const win = dom.window;
    new win.Function(moduleSource).call(win);
    return win.QrParse;
}

const ORIGIN = 'https://websend.example.org';
const VALID_SECRET = 'AbCdEfGhIjKlMnOpQrStUv'; // 22 base64url chars

test('valid same-origin URL is accepted', () => {
    const { parseSendInvite } = load();
    const r = parseSendInvite(`${ORIGIN}/send/ABC123#${VALID_SECRET}`, ORIGIN);
    assert.equal(r.ok, true);
    assert.equal(r.roomId, 'ABC123');
    assert.equal(r.secret, VALID_SECRET);
});

test('valid same-origin URL is uppercased', () => {
    const { parseSendInvite } = load();
    const r = parseSendInvite(`${ORIGIN}/send/abc123#${VALID_SECRET}`, ORIGIN);
    assert.equal(r.ok, true);
    assert.equal(r.roomId, 'ABC123');
});

test('foreign-origin URL is refused even with valid room/secret shape', () => {
    const { parseSendInvite } = load();
    const r = parseSendInvite(`https://attacker.example/send/ABC123#${VALID_SECRET}`, ORIGIN);
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'foreign-origin');
    assert.equal(r.foreignOrigin, 'https://attacker.example');
});

test('foreign-origin with different port is refused', () => {
    const { parseSendInvite } = load();
    // Same host, different port still counts as different origin.
    const r = parseSendInvite(`https://websend.example.org:8443/send/ABC123#${VALID_SECRET}`, ORIGIN);
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'foreign-origin');
});

test('http vs https on same host is refused as foreign origin', () => {
    const { parseSendInvite } = load();
    const r = parseSendInvite(`http://websend.example.org/send/ABC123#${VALID_SECRET}`, ORIGIN);
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'foreign-origin');
});

test('bare path with no scheme/host is allowed (manual entry)', () => {
    const { parseSendInvite } = load();
    const r = parseSendInvite(`/send/ABC123#${VALID_SECRET}`, ORIGIN);
    assert.equal(r.ok, true);
    assert.equal(r.roomId, 'ABC123');
});

test('valid URL but missing fragment yields secret-missing', () => {
    const { parseSendInvite } = load();
    const r = parseSendInvite(`${ORIGIN}/send/ABC123`, ORIGIN);
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'secret-missing');
    assert.equal(r.roomId, 'ABC123');
});

test('unrelated text yields no-room', () => {
    const { parseSendInvite } = load();
    const r = parseSendInvite('not a websend qr at all', ORIGIN);
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'no-room');
});

test('empty / non-string input yields no-room', () => {
    const { parseSendInvite } = load();
    assert.equal(parseSendInvite('', ORIGIN).reason, 'no-room');
    assert.equal(parseSendInvite(null, ORIGIN).reason, 'no-room');
    assert.equal(parseSendInvite(undefined, ORIGIN).reason, 'no-room');
});

test('secret over the length bound is rejected (no header smuggling)', () => {
    const { parseSendInvite } = load();
    const oversized = 'A'.repeat(64);
    const r = parseSendInvite(`${ORIGIN}/send/ABC123#${oversized}`, ORIGIN);
    assert.equal(r.ok, false);
});

test('javascript: pseudo-URL is treated as foreign and refused', () => {
    const { parseSendInvite } = load();
    // URL("javascript:...") parses; origin is "null". Either way the
    // current-origin check must reject it so we never act on a scheme
    // unrelated to https.
    const r = parseSendInvite('javascript:alert(1)/send/ABC123#' + VALID_SECRET, ORIGIN);
    assert.equal(r.ok, false);
});
