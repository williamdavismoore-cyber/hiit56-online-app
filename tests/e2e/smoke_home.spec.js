const { test, expect } = require('@playwright/test');

test('home loads and header nav renders', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveTitle(/HIIT56/i);

  // Header exists
  await expect(page.locator('.header')).toBeVisible();

  // The Workouts link exists in multiple places; we want the one in the header nav.
  const workoutsNav = page.locator('.header .nav a[href="/workouts/"]').first();
  await expect(workoutsNav).toBeVisible();
});

test('build label matches build.json', async ({ page, request }) => {
  const res = await request.get('/assets/build.json');
  expect(res.ok()).toBeTruthy();
  const build = await res.json();

  await page.goto('/');
  const footer = page.locator('.footer');

  // Expect CP label from build.json to appear in footer text (ex: "CP26")
  await expect(footer).toContainText(new RegExp(`\\b${build.label}\\b`));
});
