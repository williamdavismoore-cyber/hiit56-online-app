const { test, expect } = require('@playwright/test');

test('Gym Quick Join renders (demo mode)', async ({ page }) => {
  await page.goto('/gym/demo-gym/join?src=demo');
  await expect(page).toHaveTitle(/Quick Join/i);

  const root = page.locator('#join-root');
  await expect(root).toBeVisible();

  // Step 1: Account
  await expect(root).toContainText(/account/i);
  await page.getByRole('button', { name: /continue to waiver/i }).click();

  // Step 2: Waiver
  await expect(root).toContainText(/waiver/i);
  await page.getByRole('button', { name: /continue/i }).click();

  // Step 3: Payment
  await expect(root).toContainText(/payment/i);
  await page.getByRole('button', { name: /skip payment/i }).click();

  // Done
  await expect(root).toContainText(/all set/i);
});
