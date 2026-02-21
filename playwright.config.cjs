const { defineConfig } = require('@playwright/test');

const PORT = process.env.PW_PORT || 4174;
const BASE = `http://localhost:${PORT}`;

module.exports = defineConfig({
  testDir: './tests/e2e',
  timeout: 30_000,
  expect: { timeout: 15_000 },
  retries: 0,
  reporter: [
    ['html', { outputFolder: 'playwright-report', open: 'never' }],
    ['list'],
  ],
  use: {
    baseURL: BASE,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    // Avoid "old build ghosts" caused by service workers / aggressive caching
    serviceWorkers: 'block',
  },
  projects: [
    {
      name: 'Desktop Chromium',
      use: {
        browserName: 'chromium',
        viewport: { width: 1280, height: 720 },
      },
    },
    {
      name: 'Mobile Safari',
      use: {
        browserName: 'webkit',
        viewport: { width: 390, height: 844 },
        isMobile: true,
        hasTouch: true,
      },
    },
  ],
  webServer: {
    command: `node tools/static_server.cjs --root site --port ${PORT}`,
    url: BASE,
    reuseExistingServer: false,
    timeout: 120_000
  }
});
