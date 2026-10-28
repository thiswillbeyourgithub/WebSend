/**
 * Unit test that vendor-pins/package.json matches the vendored files and the
 * README "Third-Party Libraries" table.
 *
 * The pins exist only so Dependabot can see the vendored libraries (CVE
 * alerts + bump PRs). Merging a Dependabot bump changes the pin but not the
 * vendored file, which would silence the alert while the old code still
 * ships. This test fails on that PR until the file is re-vendored.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel) => readFileSync(path.join(SRC, rel), 'utf8');

// client-zip's bundle carries no version string, so it is identified by the
// sha256 of the npm tarball's index.js. Add the new hash when re-vendoring.
const CLIENT_ZIP_SHA256 = {
  '2.4.5': '779bd285f37baad3a84732579181ddd5611de562dafced6e573bca7efa476a44',
  '2.5.1': '28c957c53d8e5290951d4b45ccff8ab8c9c37219da08b9d537bbdd595a75706d',
};

// Per npm package: its name in the README table, and the version actually
// vendored, read from the file's own marker.
const vendored = {
  'client-zip': {
    readme: 'client-zip',
    version: () => {
      const sha = createHash('sha256').update(readFileSync(path.join(SRC, 'public/vendor/client-zip.js'))).digest('hex');
      return Object.keys(CLIENT_ZIP_SHA256).find((v) => CLIENT_ZIP_SHA256[v] === sha);
    },
  },
  'eruda': { readme: 'eruda', version: () => read('public/vendor/eruda/eruda.js').match(/\/\*! eruda v(\S+) /)?.[1] },
  'jsqr': { readme: 'jsQR', version: () => read('public/js/jsqr.min.js').match(/\/npm\/jsqr@([^/]+)\//)?.[1] },
  'qrcode': { readme: 'qrcode.js', version: () => read('public/js/qrcode.min.js').match(/\/npm\/qrcode@([^/]+)\//)?.[1] },
  'scribe.js-ocr': { readme: 'scribe.js-ocr', version: () => JSON.parse(read('public/vendor/scribe.js-ocr/package.json')).version },
};

const pins = JSON.parse(read('vendor-pins/package.json')).dependencies;

test('every pinned package has a version check', () => {
  assert.deepEqual(Object.keys(pins).sort(), Object.keys(vendored).sort());
});

for (const [pkg, pinned] of Object.entries(pins)) {
  test(`${pkg}: vendored file is the pinned ${pinned}`, () => {
    assert.equal(vendored[pkg]?.version(), pinned);
  });

  test(`${pkg}: README table lists the pinned ${pinned}`, () => {
    const row = read('../README.md').split('\n').find((l) => l.startsWith(`| [${vendored[pkg]?.readme}](`));
    assert.ok(row, `no README row for ${pkg}`);
    assert.equal(row.split('|')[2].trim(), pinned);
  });
}
