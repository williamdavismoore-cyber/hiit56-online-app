// @ts-check
const { defineConfig, devices } = require('@playwright/test');

/**
 * NDYRA E2E Harness
 * - Runs against the lightweight static server (tools/static_server.cjs)
 * - Default projects: Desktop Chromium + Mobile Safari (WebKit)
 *
 * Tip:
 *   npx playwright test --project="Desktop Chromium"
 *   npx playwright test --project="Mobile Safari"
 */
module.exports = defineConfig({
  testDir: './tests/e2e',
  fullyParallel: true,
  timeout: 30_000,
  expect: {
    timeout: 15_000,
  },

  // Console output + HTML report
  reporter: [
    ['list'],
    ['html', { open: 'never' }],
  ],

  use: {
    baseURL: 'http://localhost:4173',
    trace: 'retain-on-failure',
    video: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },

  webServer: {
    command: 'npm run dev:site',
    url: 'http://localhost:4173',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },

  projects: [
    {
      name: 'Desktop Chromium',
      use: {
        ...devices['Desktop Chrome'],
      },
    },
    {
      name: 'Mobile Safari',
      use: {
        ...devices['iPhone 14'],
      },
    },
  ],
});
