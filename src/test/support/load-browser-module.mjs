/**
 * Helper for unit-testing browser JS files that attach to window.
 * Evaluates the file(s) in a vm context with a minimal browser-like global
 * (window, crypto, logger stub) and returns the populated window object.
 * Every unit test and support script that needs a browser realm goes
 * through here instead of hand-rolling createContext/runInContext.
 *
 * Usage:
 *   const win = await loadBrowserModule(publicJs('module.js'));
 *   const { SomeClass } = win;
 *
 *   // several scripts in one realm, extra globals, and code run after them
 *   const win = await loadBrowserModule(
 *       [publicJs('crypto.js'), publicJs('protocol.js')],
 *       { setTimeout, clearTimeout },
 *       { epilogue: 'globalThis.Protocol = window.Protocol;' });
 */

import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const PUBLIC_JS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../public/js');

/** Absolute path of a file under src/public/js. */
export function publicJs(name) {
    return path.join(PUBLIC_JS_DIR, name);
}

export const stubLogger = {
    info: () => {},
    success: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
};

/**
 * @param {string|string[]} filePath - one script, or several loaded into the
 *   same context in order (like consecutive <script> tags).
 * @param {object} [extraGlobals] - additional bare globals (and window props).
 * @param {object} [opts]
 * @param {string} [opts.epilogue] - code evaluated in the realm after the
 *   scripts, e.g. to expose a top-level `const` on window or as a bare global.
 * @returns {Promise<object>} the realm's window object
 */
export async function loadBrowserModule(filePath, extraGlobals = {}, { epilogue } = {}) {
    const paths = Array.isArray(filePath) ? filePath : [filePath];

    const win = { logger: stubLogger, ...extraGlobals };

    // Both window properties AND bare names (e.g. `logger`, `crypto`) must be
    // available in the vm context since browser globals are accessed without a prefix.
    const context = createContext({
        window: win,
        logger: stubLogger,
        crypto: globalThis.crypto,
        console,
        ...extraGlobals,
    });

    for (const p of paths) runInContext(readFileSync(p, 'utf8'), context);
    if (epilogue) runInContext(epilogue, context);

    return context.window;
}
