const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
    testDir: '.',
    timeout: 60000,
    expect: { timeout: 15000 },
    use: {
        baseURL: 'http://127.0.0.1:8181',
        // Disable mDNS obfuscation so ICE uses plain host candidates over loopback
        launchOptions: {
            args: ['--disable-features=WebRtcHideLocalIpsWithMdns'],
        },
    },
    webServer: {
        // TEST_DISABLE_RATE_LIMIT=1 because Playwright's webServer is shared
        // across all tests in the run, and the suite creates ~10 rooms in a
        // minute. Without the escape hatch the per-IP roomCreation limit
        // (5/min) trips and later tests fail with a 429 during page init.
        command: 'PORT=8181 DEV_FORCE_CONNECTION=DIRECT STUN_GOOGLE_FALLBACK=false ALLOWED_ORIGINS=http://127.0.0.1:8181 TEST_DISABLE_RATE_LIMIT=1 node server.js',
        url: 'http://127.0.0.1:8181/api/config',
        reuseExistingServer: false,
        timeout: 10000,
        cwd: require('path').resolve(__dirname, '../..'),
    },
    reporter: [['list']],
});
