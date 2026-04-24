import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadBrowserModule } from '../support/load-browser-module.mjs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const modulePath = path.resolve(__dirname, '../../public/js/transfer-stats.js');

const win = await loadBrowserModule(modulePath);
const { formatRate, formatTransferStats } = win;

test('formatRate: MB/s for large rates', () => {
    assert.equal(formatRate(2 * 1024 * 1024), '2.0 MB/s');
});

test('formatRate: kB/s for small rates', () => {
    assert.equal(formatRate(345 * 1024), '345 kB/s');
});

test('formatRate: zero bytes/sec returns 0 kB/s', () => {
    assert.equal(formatRate(0), '0 kB/s');
});

test('formatRate: boundary exactly 1 MB/s', () => {
    assert.equal(formatRate(1024 * 1024), '1.0 MB/s');
});

test('formatTransferStats: basic percentage and rate', () => {
    const s = formatTransferStats(42, 1024 * 1024, Infinity);
    assert.ok(s.startsWith('42%'), `Expected "42%" prefix, got: ${s}`);
    assert.ok(s.includes('MB/s'), `Expected MB/s in: ${s}`);
});

test('formatTransferStats: appends remaining time when finite and > 10s', () => {
    const s = formatTransferStats(50, 500 * 1024, 90);
    assert.ok(s.includes('1m'), `Expected minutes in: ${s}`);
});

test('formatTransferStats: omits remaining time when Infinity', () => {
    const s = formatTransferStats(10, 1024, Infinity);
    // Should not end with a time token like "5s" or "1m 10s"
    assert.ok(!/\d+s$/.test(s), `Should not end with time suffix, got: ${s}`);
});

test('formatTransferStats: omits remaining time when <= 10s', () => {
    const s = formatTransferStats(99, 1024, 8);
    assert.ok(!s.includes('8s'), `Should not append short remaining, got: ${s}`);
});
