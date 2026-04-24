/**
 * Helper for unit-testing browser JS files that attach to window.
 * Evaluates the file in a vm context with a minimal browser-like global
 * (window, crypto, logger stub) and returns the populated window object.
 *
 * Usage:
 *   const win = await loadBrowserModule('/abs/path/to/module.js');
 *   const { SomeClass } = win;
 */

import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';

const stubLogger = {
    info: () => {},
    success: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
};

export async function loadBrowserModule(filePath, extraGlobals = {}) {
    const code = readFileSync(filePath, 'utf8');

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

    runInContext(code, context);

    // Merge anything the script attached to window back into context.window
    Object.assign(context.window, context.window);
    return context.window;
}
