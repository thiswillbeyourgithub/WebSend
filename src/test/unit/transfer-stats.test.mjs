import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadBrowserModule } from '../support/load-browser-module.mjs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const modulePath = path.resolve(__dirname, '../../public/js/transfer-stats.js');

const win = await loadBrowserModule(modulePath);
const { formatRate, formatTransferStats, createRateTracker } = win;

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

test('formatTransferStats: still shows short remaining time (<= 10s)', () => {
    // The ETA must stay visible all the way down instead of vanishing near
    // the end of a transfer.
    const s = formatTransferStats(99, 1024, 8);
    assert.ok(/\b8s$/.test(s), `Expected "8s" suffix, got: ${s}`);
});

test('formatTransferStats: shows 0s at completion', () => {
    const s = formatTransferStats(100, 1024 * 1024, 0);
    assert.ok(/\b0s$/.test(s), `Expected "0s" suffix, got: ${s}`);
});

test('formatTransferStats: omits remaining time when Infinity', () => {
    const s = formatTransferStats(10, 1024, Infinity);
    // Should not end with a time token like "5s" or "1m 10s"
    assert.ok(!/\d+s$/.test(s), `Should not end with time suffix, got: ${s}`);
});

// ---- createRateTracker (attempt-local rate after rewinds/reconnects) ----

test('createRateTracker: steady progress yields bytes per second', () => {
    const t = createRateTracker();
    assert.equal(t.update(0, 1000), 0, 'first sample is the baseline');
    assert.equal(t.update(1024, 2000), 1024);
    assert.equal(t.update(2048, 3000), 1024);
});

test('createRateTracker: resume byte credit does not inflate the rate', () => {
    // Sender resume regression: the first sample of a resumed attempt
    // already carries full byte credit for the prefix delivered before
    // the reconnect (offset baselines at estimateWireOffset). Dividing
    // that absolute offset by the fresh attempt clock showed rates ~10x
    // too high right after a resume; the tracker must measure from the
    // attempt's own baseline instead.
    const t = createRateTracker();
    t.update(30 * 1024 * 1024, 1000);
    assert.equal(t.update(30 * 1024 * 1024 + 2048, 3000), 1024);
});

test('createRateTracker: a stall longer than stallMs starts a new attempt', () => {
    // Receiver resume regression: the wire-byte clock used to keep
    // running across the outage, permanently deflating the displayed
    // rate (sender ended up showing ~2x the receiver). After a gap the
    // tracker rebases so only post-gap progress counts.
    const t = createRateTracker(3000);
    t.update(0, 0);
    t.update(1024, 1000);
    assert.equal(t.update(2048, 11000), 0, 'first sample after the gap rebaselines');
    assert.equal(t.update(4096, 12000), 2048, 'rate reflects only post-gap progress');
});

test('createRateTracker: backward progress (rewind / parser re-arm) rebaselines', () => {
    const t = createRateTracker();
    t.update(0, 0);
    t.update(10240, 1000);
    assert.equal(t.update(512, 2000), 0, 'backward jump rebaselines');
    assert.equal(t.update(1536, 3000), 1024);
});

