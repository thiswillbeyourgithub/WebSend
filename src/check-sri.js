/**
 * check-sri.js — Verify that SRI integrity attributes in HTML files
 * match the actual hashes of the referenced JS/CSS assets.
 *
 * Exits with code 1 if any mismatch is found.
 * Usage: node check-sri.js
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PUBLIC_DIR = path.join(__dirname, 'public');

const ASSET_DIRS = ['js', 'css'];

const HTML_FILES = ['index.html', 'receive.html', 'send.html']
  .map(f => path.join(PUBLIC_DIR, f));

function computeSriHash(filePath) {
  const content = fs.readFileSync(filePath);
  const hash = crypto.createHash('sha384').update(content).digest('base64');
  return `sha384-${hash}`;
}

function buildHashMap() {
  const hashes = {};
  for (const dir of ASSET_DIRS) {
    const dirPath = path.join(PUBLIC_DIR, dir);
    if (!fs.existsSync(dirPath)) continue;
    const files = fs.readdirSync(dirPath).sort();
    for (const file of files) {
      const filePath = path.join(dirPath, file);
      if (!fs.statSync(filePath).isFile()) continue;
      hashes[`/${dir}/${file}`] = computeSriHash(filePath);
    }
  }
  return hashes;
}

const hashes = buildHashMap();
let mismatches = 0;

for (const htmlFile of HTML_FILES) {
  if (!fs.existsSync(htmlFile)) continue;
  const content = fs.readFileSync(htmlFile, 'utf-8');
  const re = /<(?:script|link)\b[^>]*?(?:src|href)="([^"]*)"[^>]*?integrity="([^"]*)"/g;
  let match;
  while ((match = re.exec(content)) !== null) {
    const [, assetPath, integrityValue] = match;
    const expected = hashes[assetPath];
    if (expected && expected !== integrityValue) {
      console.error(`MISMATCH in ${path.basename(htmlFile)}: ${assetPath}`);
      console.error(`  expected: ${expected}`);
      console.error(`  found:    ${integrityValue}`);
      mismatches++;
    }
  }
}

if (mismatches > 0) {
  console.error(`\n${mismatches} SRI mismatch(es) found. Run "node update-sri.js" to fix.`);
  process.exit(1);
} else {
  console.log('All SRI integrity hashes are up to date.');
}
