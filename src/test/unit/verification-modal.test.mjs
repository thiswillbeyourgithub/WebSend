/**
 * Unit test for verification-modal.js.
 *
 * Specifically covers the listener-leak fix: calling show() twice in a
 * row (e.g. on sender rekey) without an intervening hide() must NOT
 * accumulate keydown handlers on document. Without the fix, each
 * show() leaked a handler that fired alongside the new one for every
 * subsequent Enter/Space/Escape keypress.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { JSDOM } from 'jsdom';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const modulePath = path.resolve(__dirname, '../../public/js/verification-modal.js');
const moduleSource = readFileSync(modulePath, 'utf8');

function loadModal() {
    const dom = new JSDOM(`<!doctype html><html><body>
        <div id="verification-modal" class="hidden">
            <button id="confirm-match-btn"></button>
            <button id="deny-match-btn"></button>
        </div>
    </body></html>`, { runScripts: 'outside-only', url: 'http://localhost/' });
    const win = dom.window;
    win.eval(moduleSource);
    return win;
}

test('show() then hide() removes the keydown listener', () => {
    const win = loadModal();
    let confirms = 0;
    win.VerificationModal.show({
        onConfirm: () => { confirms++; },
        onDeny: () => {},
    });
    win.document.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Enter' }));
    assert.equal(confirms, 1);

    win.VerificationModal.hide();
    win.document.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Enter' }));
    assert.equal(confirms, 1, 'hide() should detach the keydown listener');
});

test('show() called twice without hide() does NOT accumulate listeners', () => {
    const win = loadModal();
    let firstConfirms = 0;
    let secondConfirms = 0;

    win.VerificationModal.show({
        onConfirm: () => { firstConfirms++; },
        onDeny: () => {},
    });

    // Re-open without hide() — simulates the sender-rekey path that pops
    // the modal a second time. Only the new handler should be live.
    win.VerificationModal.show({
        onConfirm: () => { secondConfirms++; },
        onDeny: () => {},
    });

    win.document.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Enter' }));

    assert.equal(firstConfirms, 0, 'the leaked-over first handler must not fire');
    assert.equal(secondConfirms, 1, 'only the most recent show() handler fires');
});
