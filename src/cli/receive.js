#!/usr/bin/env node
/**
 * Minimal WebSend CLI receiver.
 *
 * Pairs a phone sender against a deployed WebSend instance from a terminal —
 * useful for remote-instance smoke testing and for headless captures.
 *
 * Implementation note: the actual WebRTC + crypto flow runs inside a
 * Playwright-launched headless Chromium (already a project devDependency for
 * e2e tests), reusing src/public/js/crypto.js + src/public/js/protocol.js
 * verbatim. This avoids adding native node-webrtc bindings and keeps the wire
 * protocol in lockstep with the production browser path.
 *
 * Usage:
 *   node src/cli/receive.js <instance-url> [--out <dir>] [--auto-accept] [--verbose]
 *
 * Built with the help of Claude Code (Opus 4.7).
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');

// ============ args ============

function parseArgs(argv) {
    const opts = { url: null, out: null, autoAccept: false, verbose: false, help: false };
    const rest = [];
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--out') opts.out = argv[++i];
        else if (a === '--auto-accept') opts.autoAccept = true;
        else if (a === '--verbose' || a === '-v') opts.verbose = true;
        else if (a === '--help' || a === '-h') opts.help = true;
        else if (a.startsWith('-')) { console.error(`unknown flag: ${a}`); process.exit(2); }
        else rest.push(a);
    }
    opts.url = rest[0] || null;
    return opts;
}

function usage() {
    console.log(`Usage: node src/cli/receive.js <instance-url> [options]

Options:
  --out <dir>      Output directory (default: ./websend-received/<timestamp>)
  --auto-accept    Auto-confirm fingerprint without y/n prompt
  -v, --verbose    Verbose protocol/crypto logging
  -h, --help       Show this help

Requires Playwright Chromium:  npx playwright install chromium`);
}

// ============ helpers ============

function ts() {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function makeLog(verbose) {
    return {
        info: (m) => console.log(`[${ts()}] ${m}`),
        ok:   (m) => console.log(`[${ts()}] ${m}`),
        warn: (m) => console.warn(`[${ts()}] ! ${m}`),
        err:  (m) => console.error(`[${ts()}] x ${m}`),
        dbg:  (m) => { if (verbose) console.log(`[${ts()}] . ${m}`); },
    };
}

function safeFilename(name) {
    if (typeof name !== 'string' || !name) return 'unnamed';
    return path.basename(name).replace(/[\x00-\x1f/\\]/g, '_').slice(0, 200) || 'unnamed';
}

function uniquePath(dir, name) {
    let p = path.join(dir, name);
    if (!fs.existsSync(p)) return p;
    const ext = path.extname(name);
    const base = name.slice(0, name.length - ext.length);
    for (let n = 1; n < 10000; n++) {
        p = path.join(dir, `${base} (${n})${ext}`);
        if (!fs.existsSync(p)) return p;
    }
    throw new Error('too many duplicates');
}

function promptYesNo(question) {
    return new Promise((resolve) => {
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        rl.question(question, (ans) => { rl.close(); resolve(/^y(es)?$/i.test(ans.trim())); });
    });
}

// ============ main ============

async function main() {
    const opts = parseArgs(process.argv.slice(2));
    if (opts.help || !opts.url) {
        usage();
        process.exit(opts.help ? 0 : 2);
    }

    const log = makeLog(opts.verbose);
    const baseUrl = opts.url.replace(/\/+$/, '');
    const outDir = opts.out
        ? path.resolve(opts.out)
        : path.resolve('websend-received', new Date().toISOString().replace(/[:.]/g, '-'));
    fs.mkdirSync(outDir, { recursive: true });
    log.info(`Saving files to ${outDir}`);

    let chromium;
    try {
        ({ chromium } = require('@playwright/test'));
    } catch (e) {
        log.err('Playwright not installed. Run: cd src && npm install');
        process.exit(1);
    }

    const browser = await chromium.launch({ headless: true }).catch((e) => {
        log.err(`Could not launch Chromium: ${e.message}`);
        log.err('Did you run `npx playwright install chromium`?');
        process.exit(1);
    });
    const context = await browser.newContext();
    const page = await context.newPage();

    // Bridge functions BEFORE any navigation/script load so the in-page driver
    // can call them as soon as it starts.
    await page.exposeFunction('__nodeLog', (level, msg) => {
        const fn = log[level] || log.info;
        fn(msg);
    });

    let donePromiseResolve;
    const donePromise = new Promise((r) => { donePromiseResolve = r; });

    await page.exposeFunction('__nodeSenderUrl', (url) => {
        console.log('');
        console.log('  Open on your phone:');
        console.log(`  ${url}`);
        console.log('');
    });

    await page.exposeFunction('__nodePromptFp', async (myFp, theirFp) => {
        console.log('');
        console.log(`  Your fingerprint:   ${myFp}`);
        console.log(`  Sender fingerprint: ${theirFp}`);
        console.log('');
        if (opts.autoAccept) return true;
        return await promptYesNo('Do both fingerprints match on your phone? [y/N] ');
    });

    const stats = { savedCount: 0, savedBytes: 0 };
    await page.exposeFunction('__nodeSaveFile', async (name, mime, b64) => {
        const safe = safeFilename(name);
        const outPath = uniquePath(outDir, safe);
        const buf = Buffer.from(b64, 'base64');
        fs.writeFileSync(outPath, buf);
        stats.savedCount += 1;
        stats.savedBytes += buf.length;
        return path.relative(process.cwd(), outPath);
    });

    await page.exposeFunction('__nodeDone', (s) => {
        donePromiseResolve(s);
    });

    // Surface uncaught browser errors.
    page.on('pageerror', (e) => log.err(`page error: ${e.message}`));
    if (opts.verbose) {
        page.on('console', (m) => log.dbg(`console.${m.type()}: ${m.text()}`));
    }

    // Navigate to the instance origin so fetch() carries the right Origin
    // header. Any page on the instance will do; index.html is lightest.
    log.info(`Loading ${baseUrl} ...`);
    try {
        await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
    } catch (e) {
        log.err(`Could not load ${baseUrl}: ${e.message}`);
        await browser.close();
        process.exit(1);
    }

    // Inject the production crypto + protocol modules from the live server.
    // Any change to those files automatically flows through — zero drift.
    await page.addScriptTag({ url: '/js/crypto.js' });
    await page.addScriptTag({ url: '/js/protocol.js' });

    // Inject our minimal driver from disk.
    const driverSrc = fs.readFileSync(path.join(__dirname, 'shim.js'), 'utf8');
    await page.addScriptTag({ content: driverSrc });

    // Kick off the receiver flow inside the page. Returns when start() resolves
    // (which it doesn't, normally — the in-page driver runs an open-ended loop
    // and the only exit signal is __nodeDone via dc.onclose).
    page.evaluate((args) => window.__wsCli.start(args), {
        baseUrl,
        autoAccept: !!opts.autoAccept,
    }).catch((e) => log.err(`driver error: ${e.message}`));

    // Wait for the data channel to close (done) or Ctrl-C.
    process.on('SIGINT', () => {
        log.info('Interrupted, closing...');
        donePromiseResolve(stats);
    });

    await donePromise;
    console.log('');
    console.log(`  ${stats.savedCount} file(s) saved, ${stats.savedBytes} bytes total`);
    console.log(`  Output: ${outDir}`);
    try { await browser.close(); } catch {}
    process.exit(0);
}

main().catch((e) => {
    console.error(`fatal: ${e.stack || e.message || e}`);
    process.exit(1);
});
