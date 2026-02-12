const { defineConfig } = require('@playwright/test');

const PORT = process.env.PW_PORT || 4174;
const BASE = `http://localhost:${PORT}`;

module.exports = defineConfig({
  testDir: './tests/e2e',
  timeout: 30_000,
  expect: { timeout: 15_000 },
  retries: 0,
  use: {
    baseURL: BASE,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    // Avoid "old build ghosts" caused by service workers / aggressive caching
    serviceWorkers: 'block',
  },
  webServer: {
    command: `node tools/static_server.cjs --root site --port ${PORT}`,
    url: BASE,
    reuseExistingServer: false,
    timeout: 120_000
  }
});
