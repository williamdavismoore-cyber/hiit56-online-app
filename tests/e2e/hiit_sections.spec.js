const { test, expect } = require('@playwright/test');

test('HIIT category page renders sections in correct order', async ({ page }) => {
  await page.goto('/workouts/category.html?c=hiit');

  // Sanity: category template present
  await expect(page.locator('[data-cat-title]')).toHaveCount(1);
  await expect(page.locator('[data-cat-title]')).toHaveText(/HIIT/i);

  // Section containers should exist in DOM (may be hidden when empty)
  const maxSection = page.locator('[data-max-cardio-section]');
  const specialsSection = page.locator('[data-specials-section]');

  await expect(maxSection).toHaveCount(1);
  await expect(specialsSection).toHaveCount(1);

  await expect(maxSection).toContainText(/Max\s+Cardio/i);
  await expect(specialsSection).toContainText(/Specials/i);

  // Order check using DOM position (works even if hidden)
  const inOrder = await page.evaluate(() => {
    const max = document.querySelector('[data-max-cardio-section]');
    const specials = document.querySelector('[data-specials-section]');
    if (!max || !specials) return false;
    return Boolean(max.compareDocumentPosition(specials) & Node.DOCUMENT_POSITION_FOLLOWING);
  });
  expect(inOrder).toBeTruthy();
});
