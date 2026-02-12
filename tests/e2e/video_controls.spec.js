const { test, expect } = require('@playwright/test');

test('video controls reveal on hover (desktop)', async ({ page }) => {
  await page.goto('/workouts/category.html?c=hiit');

  // Ensure we are on the category template (not a fallback page)
  await expect(page.locator('[data-video-root]')).toHaveCount(1);

  // Wait for at least one teaser card to render (data loads async)
  const cards = page.locator('[data-video-root] .card');
  await expect.poll(async () => await cards.count(), { timeout: 30_000 }).toBeGreaterThan(0);

  const firstCard = cards.first();
  await firstCard.click();

  const modal = page.locator('#videoModal');
  await expect(modal).toHaveClass(/open/);

  const shell = modal.locator('.video-shell').first();
  await expect(shell).toBeVisible({ timeout: 20_000 });

  const controls = shell.locator('.video-controls');
  await expect(controls).toHaveCount(1);

  // On desktop pointer-fine, controls should get more visible on hover.
  const before = Number(await controls.evaluate(el => getComputedStyle(el).opacity)) || 0;

  await shell.hover();
  await page.waitForTimeout(150);

  const after = Number(await controls.evaluate(el => getComputedStyle(el).opacity)) || 0;
  expect(after).toBeGreaterThan(before);
});
