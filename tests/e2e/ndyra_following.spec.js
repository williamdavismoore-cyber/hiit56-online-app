const { test, expect } = require('@playwright/test');

test('NDYRA Following feed renders in demo mode', async ({ page }) => {
  await page.goto('/app/following/?src=demo');

  // Sanity: correct page
  await expect(page).toHaveTitle(/Following/i);

  // At least one post card should render
  const cards = page.locator('.post-card');
  await expect(cards.first()).toBeVisible();

  // Reaction buttons exist and are disabled in demo mode (guest)
  const firstReacts = cards.first().locator('.react-btn');
  await expect(firstReacts).toHaveCount(5);
  await expect(firstReacts.first()).toBeDisabled();
});
