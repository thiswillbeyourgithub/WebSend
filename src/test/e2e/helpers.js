/**
 * Shared helpers for the Playwright E2E specs.
 *
 * Not a spec file itself: Playwright's default testMatch only picks up
 * `*.spec.js` / `*.test.js`, so this module is only loaded via require().
 */

/**
 * Pair a receiver and sender context and return the pages ready for file
 * transfers. Pairing is automatic (QR secret K + encrypted key-confirm),
 * so this only waits for both sides to bind.
 *
 * The function only returns once the sender's pairing is bound: before
 * that, handleFileSelect on the sender silently bails, so a spec that sets
 * files too early would flake rather than fail loudly.
 *
 * @param {import('@playwright/test').Browser} browser
 * @param {{baseURL?: string, timeout?: number}} [opts] baseURL for specs
 *   that spawn their own server; timeout for the key-confirm wait.
 * @returns {Promise<{ctxA, pageA, ctxB, pageB}>} A = receiver, B = sender.
 */
async function pairAndVerify(browser, { baseURL, timeout = 20000 } = {}) {
    const ctxOpts = baseURL ? { baseURL } : {};
    // Context A = receiver
    const ctxA = await browser.newContext(ctxOpts);
    const pageA = await ctxA.newPage();
    await pageA.goto((baseURL || '') + '/receive.html');
    await pageA.waitForSelector('#qr-url-input', { timeout: 12000 });
    const senderUrl = await pageA.inputValue('#qr-url-input');

    // Context B = sender
    const ctxB = await browser.newContext(ctxOpts);
    const pageB = await ctxB.newPage();
    await pageB.goto(senderUrl);
    await pageB.waitForLoadState('domcontentloaded');

    // Sender bound: the receiver's key-confirm opened under keys derived
    // from ECDH + K, so handleFileSelect won't bail.
    await pageB.waitForFunction(
        () => window.SenderConnect && window.SenderConnect.isVerified(),
        { timeout }
    );
    // Receiver bound too: it hides its waiting banner and marks the
    // sidebar verified once the sender's key-confirm opened.
    await pageA.waitForFunction(
        () => document.getElementById('waiting-confirmation').classList.contains('hidden'),
        { timeout: 10000 }
    );

    return { ctxA, pageA, ctxB, pageB };
}

/**
 * Whether poppler's `pdftotext` is installed. Specs that inspect the text
 * layer of an exported PDF skip themselves without it.
 */
function hasPdftotext() {
    try {
        require('child_process').execFileSync('pdftotext', ['-v'], { stdio: 'ignore' });
        return true;
    } catch (_) {
        return false;
    }
}

module.exports = { pairAndVerify, hasPdftotext };
