/**
 * Shared helpers for the Playwright E2E specs.
 *
 * Not a spec file itself: Playwright's default testMatch only picks up
 * `*.spec.js` / `*.test.js`, so this module is only loaded via require().
 */

/**
 * Pair a receiver and sender context, walk both through the verification
 * modal, and return the pages ready for file transfers.
 *
 * The function only returns once the sender holds the shared key: before
 * that, handleFileSelect on the sender silently bails, so a spec that sets
 * files too early would flake rather than fail loudly.
 *
 * @param {import('@playwright/test').Browser} browser
 * @returns {Promise<{ctxA, pageA, ctxB, pageB}>} A = receiver, B = sender.
 */
async function pairAndVerify(browser) {
    // Context A = receiver
    const ctxA = await browser.newContext();
    const pageA = await ctxA.newPage();
    await pageA.goto('/receive.html');
    await pageA.waitForSelector('#qr-url-input', { timeout: 12000 });
    const senderUrl = await pageA.inputValue('#qr-url-input');

    // Context B = sender
    const ctxB = await browser.newContext();
    const pageB = await ctxB.newPage();
    await pageB.goto(senderUrl);
    await pageB.waitForLoadState('domcontentloaded');

    // The receiver's verification modal is un-hidden once the WebRTC
    // connection and key exchange produced a fingerprint to compare.
    await pageA.waitForFunction(() => {
        const m = document.getElementById('verification-modal');
        return m && !m.classList.contains('hidden');
    }, { timeout: 20000 });
    await pageA.click('#confirm-match-btn');

    // The sender modal may already be gone (or never shown) depending on
    // timing, so these two steps are best effort.
    await pageB.waitForFunction(() => {
        const m = document.getElementById('verification-modal');
        return m && !m.classList.contains('hidden');
    }, { timeout: 10000 }).catch(() => null);
    await pageB.$eval('#confirm-match-btn', btn => btn.click()).catch(() => null);

    // Receiver past verification.
    await pageA.waitForFunction(
        () => !document.getElementById('verification-modal') ||
              document.getElementById('verification-modal').classList.contains('hidden'),
        { timeout: 10000 }
    ).catch(() => null);

    // Sender has a sharedKey (post-verification) so handleFileSelect won't bail.
    await pageB.waitForFunction(
        () => window.SenderConnect && window.SenderConnect.getSharedKey() != null,
        { timeout: 15000 }
    );

    return { ctxA, pageA, ctxB, pageB };
}

module.exports = { pairAndVerify };
