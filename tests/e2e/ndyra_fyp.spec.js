const { test, expect } = require('@playwright/test');

test('NDYRA For You feed renders in demo mode', async ({ page }) => {
  await page.goto('/app/fyp/?src=demo');

  // Sanity: correct page
  await expect(page).toHaveTitle(/For You/i);

  // At least one post card should render
  const cards = page.locator('.post-card');
  await expect(cards.first()).toBeVisible();

  // Reaction buttons exist (disabled for guest/demo)
  const firstReacts = cards.first().locator('.react-btn');
  await expect(firstReacts).toHaveCount(5);

  // Since demo mode does not authenticate, buttons should be disabled
  await expect(firstReacts.first()).toBeDisabled();
});
