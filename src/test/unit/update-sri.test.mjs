/**
 * Tests for update-sri.js and check-sri.js.
 *
 * update-sri.js uses __dirname-relative paths, so these tests operate on the
 * actual project files rather than temp dirs. They verify:
 *   1. The sri-hashes.json contains correct SHA-384 hashes for known files.
 *   2. check-sri.js exits 0 (hashes match) — the production integrity guard.
 *   3. The SHA-384 hash computation function is correct via spot-checking.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC_DIR    = path.resolve(__dirname, '../..');
const CHECK_SRI  = path.resolve(SRC_DIR, 'check-sri.js');
const HASH_FILE  = path.resolve(SRC_DIR, 'sri-hashes.json');
const PUBLIC_DIR = path.resolve(SRC_DIR, 'public');

function sha384(filePath) {
    const content = readFileSync(filePath);
    return 'sha384-' + createHash('sha384').update(content).digest('base64');
}

test('sri-hashes.json exists and is valid JSON', () => {
    assert.ok(existsSync(HASH_FILE), 'sri-hashes.json not found');
    const hashes = JSON.parse(readFileSync(HASH_FILE, 'utf8'));
    assert.ok(typeof hashes === 'object' && hashes !== null);
});

test('sri-hashes.json contains correct SHA-384 for transfer-stats.js', () => {
    const hashes = JSON.parse(readFileSync(HASH_FILE, 'utf8'));
    const key = '/js/transfer-stats.js';
    assert.ok(key in hashes, `Missing hash for ${key}`);
    const expected = sha384(path.join(PUBLIC_DIR, 'js', 'transfer-stats.js'));
    assert.equal(hashes[key], expected);
});

test('sri-hashes.json contains correct SHA-384 for image-transforms.js (new module)', () => {
    const hashes = JSON.parse(readFileSync(HASH_FILE, 'utf8'));
    const key = '/js/image-transforms.js';
    assert.ok(key in hashes, `Missing hash for ${key} — run update-sri.js`);
    const expected = sha384(path.join(PUBLIC_DIR, 'js', 'image-transforms.js'));
    assert.equal(hashes[key], expected);
});

test('check-sri exits 0 (all integrity hashes match project files)', () => {
    // If this fails, someone changed a JS/CSS file without running update-sri.js
    assert.doesNotThrow(
        () => execFileSync('node', [CHECK_SRI], { cwd: SRC_DIR, encoding: 'utf8' }),
        'check-sri.js failed — run: cd src && node update-sri.js'
    );
});

// Match <script ... src="/js/image-transforms.js" ... integrity="sha384-..." ...>
// in either attribute order on the SAME tag (proves the inject-integrity pass ran).
const TAG_WITH_INTEGRITY = new RegExp(
    '<script\\b[^>]*?' +
    '(?:src="/js/image-transforms\\.js"[^>]*?integrity="sha384-[^"]+"' +
    '|integrity="sha384-[^"]+"[^>]*?src="/js/image-transforms\\.js")' +
    '[^>]*>'
);

test('receive.html: image-transforms.js script tag has integrity attribute on same tag', () => {
    const html = readFileSync(path.join(PUBLIC_DIR, 'receive.html'), 'utf8');
    assert.match(html, TAG_WITH_INTEGRITY,
        'inject-integrity pass did not add integrity to image-transforms.js tag');
});

test('send.html: image-transforms.js script tag has integrity attribute on same tag', () => {
    const html = readFileSync(path.join(PUBLIC_DIR, 'send.html'), 'utf8');
    assert.match(html, TAG_WITH_INTEGRITY,
        'inject-integrity pass did not add integrity to image-transforms.js tag');
});

test('integrity hash on image-transforms.js tag matches sri-hashes.json', () => {
    const hashes = JSON.parse(readFileSync(HASH_FILE, 'utf8'));
    const expected = hashes['/js/image-transforms.js'];
    for (const file of ['receive.html', 'send.html']) {
        const html = readFileSync(path.join(PUBLIC_DIR, file), 'utf8');
        const m = html.match(TAG_WITH_INTEGRITY);
        assert.ok(m, `tag not found in ${file}`);
        assert.ok(m[0].includes(`integrity="${expected}"`),
            `${file}: integrity does not match sri-hashes.json (${expected})`);
    }
});
