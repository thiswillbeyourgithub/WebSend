/**
 * update-sri.js — Centralized SRI (Subresource Integrity) hash management.
 *
 * Computes SHA-384 hashes for all JS/CSS assets in public/, writes them to
 * sri-hashes.json, and updates integrity="..." attributes in all HTML files.
 *
 * This avoids manually recomputing and copy-pasting hashes across multiple
 * HTML files whenever an asset changes.
 *
 * Usage: npm run update-sri
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PUBLIC_DIR = path.join(__dirname, 'public');
const HASH_FILE = path.join(__dirname, 'sri-hashes.json');

// Directories containing assets that need SRI hashes
const ASSET_DIRS = ['js', 'css'];

// HTML files that reference these assets via integrity attributes
const HTML_FILES = ['index.html', 'receive.html', 'send.html']
  .map(f => path.join(PUBLIC_DIR, f));

/**
 * Compute the SRI hash (sha384) for a file's contents.
 * Returns the full integrity string, e.g. "sha384-abc123..."
 */
function computeSriHash(filePath) {
  const content = fs.readFileSync(filePath);
  const hash = crypto.createHash('sha384').update(content).digest('base64');
  return `sha384-${hash}`;
}

/**
 * Discover all JS/CSS assets and compute their SRI hashes.
 * Returns a map like { "/css/style.css": "sha384-...", "/js/crypto.js": "sha384-..." }
 */
function buildHashMap() {
  const hashes = {};

  for (const dir of ASSET_DIRS) {
    const dirPath = path.join(PUBLIC_DIR, dir);
    if (!fs.existsSync(dirPath)) continue;

    const files = fs.readdirSync(dirPath).sort();
    for (const file of files) {
      const filePath = path.join(dirPath, file);
      if (!fs.statSync(filePath).isFile()) continue;

      // Use the URL path as the key (matches href/src in HTML)
      const urlPath = `/${dir}/${file}`;
      hashes[urlPath] = computeSriHash(filePath);
    }
  }

  return hashes;
}

/**
 * Update or add integrity="..." attributes in an HTML file using the hash map.
 *
 * Handles two cases:
 *   1. Tags that already have integrity="..." — updates the hash in-place.
 *   2. Tags that have a local src/href but no integrity attribute — injects one.
 *
 * Only acts on paths found in the hash map (i.e. local /js/ and /css/ assets).
 */
function updateHtmlFile(filePath, hashes) {
  let content = fs.readFileSync(filePath, 'utf-8');
  let updateCount = 0;

  // Pass 1: update existing integrity attributes
  content = content.replace(
    /(<(?:script|link)\b[^>]*?(?:src|href)="([^"]*)"[^>]*?)integrity="[^"]*"/g,
    (match, before, assetPath) => {
      if (hashes[assetPath]) {
        updateCount++;
        return `${before}integrity="${hashes[assetPath]}"`;
      }
      return match;
    }
  );

  // Pass 2: inject integrity on tags that have a local asset path but no integrity attr.
  // Matches <script src="..."> or <link href="..."> without any integrity="..." present.
  content = content.replace(
    /<(script|link)\b([^>]*?)(src|href)="([^"]*)"([^>]*?)(?!\s*integrity=)>/g,
    (match, tag, before, attr, assetPath, after) => {
      // Skip if integrity already present anywhere in the tag
      if (/\bintegrity=/.test(match)) return match;
      if (!hashes[assetPath]) return match;
      updateCount++;
      return `<${tag}${before}${attr}="${assetPath}"${after} integrity="${hashes[assetPath]}">`;
    }
  );

  fs.writeFileSync(filePath, content, 'utf-8');
  return updateCount;
}

// --- Main ---

const hashes = buildHashMap();

// Write the JSON reference file (useful for diffing / CI checks)
fs.writeFileSync(HASH_FILE, JSON.stringify(hashes, null, 2) + '\n');
console.log(`Wrote ${Object.keys(hashes).length} hashes to sri-hashes.json`);

// Update each HTML file in-place
for (const htmlFile of HTML_FILES) {
  if (!fs.existsSync(htmlFile)) {
    console.warn(`  SKIP ${path.basename(htmlFile)} (not found)`);
    continue;
  }
  const count = updateHtmlFile(htmlFile, hashes);
  console.log(`  ${path.basename(htmlFile)}: ${count} integrity attribute(s) updated`);
}
