const { test, expect } = require('@playwright/test');

test('debug receive.html state', async ({ page }) => {
    const logs = [];
    page.on('console', m => logs.push(`[${m.type()}] ${m.text()}`));
    page.on('pageerror', e => logs.push(`[error] ${e.message}`));
    page.on('requestfailed', r => logs.push(`[reqfail] ${r.url()} ${r.failure()?.errorText}`));

    await page.goto('/receive.html');
    await page.waitForTimeout(8000);

    await page.screenshot({ path: 'test-results/receive-debug.png' });

    const inputEl = await page.$('#qr-url-input');
    const qrContainer = await page.$('#qr-container');
    const stepQr = await page.$('#step-qr');

    console.log('qr-url-input:', !!inputEl);
    console.log('qr-container:', !!qrContainer);
    console.log('step-qr:', !!stepQr);
    console.log('logs:', logs.join('\n'));
});
