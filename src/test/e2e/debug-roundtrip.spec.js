const { test, expect } = require('@playwright/test');
const path = require('path');
const fs = require('fs');

const FIXTURE_PNG = path.resolve(__dirname, '../fixtures/test-image.png');

test('debug full round-trip with file send', async ({ browser }) => {
    const ctxA = await browser.newContext();
    const pageA = await ctxA.newPage();
    const logsA = [];
    pageA.on('console', m => logsA.push(`[${m.type()}] ${m.text()}`));

    await pageA.goto('/receive.html');
    await pageA.waitForSelector('#qr-url-input', { timeout: 12000 });
    const senderUrl = await pageA.inputValue('#qr-url-input');

    const ctxB = await browser.newContext();
    const pageB = await ctxB.newPage();
    const logsB = [];
    pageB.on('console', m => logsB.push(`[${m.type()}] ${m.text()}`));

    await pageB.goto(senderUrl);
    await pageB.waitForLoadState('domcontentloaded');

    // Wait for key exchange
    await pageA.waitForTimeout(3000);

    // Check modal state
    const modalAClass = await pageA.$eval('#verification-modal', el => el.className).catch(() => 'not found');
    const modalBClass = await pageB.$eval('#verification-modal', el => el?.className || 'no modal').catch(() => 'not found');
    console.log('Modal A class:', modalAClass);
    console.log('Modal B class:', modalBClass);

    // Click confirm on both
    await pageA.click('#confirm-match-btn').catch(e => console.log('A confirm error:', e.message));
    await pageB.click('#confirm-match-btn').catch(e => console.log('B confirm error:', e.message));

    await pageA.waitForTimeout(2000);

    const modalAClassAfter = await pageA.$eval('#verification-modal', el => el.className).catch(() => 'not found');
    const modalBClassAfter = await pageB.$eval('#verification-modal', el => el?.className || 'no modal').catch(() => 'not found');
    console.log('Modal A class after click:', modalAClassAfter);
    console.log('Modal B class after click:', modalBClassAfter);

    // Send file
    await pageB.setInputFiles('#file-input', FIXTURE_PNG).catch(e => console.log('setInputFiles error:', e.message));
    await pageA.waitForTimeout(10000);

    await pageA.screenshot({ path: 'test-results/receiver-after-send.png' });
    await pageB.screenshot({ path: 'test-results/sender-after-send.png' });

    const receivedContainerHtml = await pageA.$eval('#received-images', el => el.innerHTML).catch(() => 'not found');
    console.log('Received container HTML (first 500):', receivedContainerHtml.slice(0, 500));

    const logsAFiltered = logsA.filter(l => /INFO|SUCCESS|WARN|error/i.test(l));
    const logsBFiltered = logsB.filter(l => /INFO|SUCCESS|WARN|error/i.test(l));
    console.log('Logs A:', logsAFiltered.slice(-20).join('\n'));
    console.log('Logs B:', logsBFiltered.slice(-20).join('\n'));

    await ctxA.close();
    await ctxB.close();
});
