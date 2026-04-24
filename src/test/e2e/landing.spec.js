const { test, expect } = require('@playwright/test');

test('index.html loads and shows the landing page', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveTitle(/WebSend/i);
    // The page should have some visible content
    await expect(page.locator('body')).not.toBeEmpty();
});

test('navigating to /receive.html loads the receiver page', async ({ page }) => {
    await page.goto('/receive.html');
    await expect(page.locator('body')).not.toBeEmpty();
    // QR code or connection indicator should eventually appear
    // (page initializes WebRTC and posts a room)
    await page.waitForTimeout(1000);
    const html = await page.content();
    expect(html.length).toBeGreaterThan(100);
});
