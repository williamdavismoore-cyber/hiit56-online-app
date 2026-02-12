const { test, expect } = require('@playwright/test');

test('member timer can skip into REST mode (smoke)', async ({ page }) => {
  // Use explicit index.html to avoid directory fallback quirks
  await page.goto('/app/timer/index.html?src=demo:online_quick');

  // Sanity: correct template
  await expect(page.locator('body[data-page="member-timer"]')).toHaveCount(1);

  const start = page.locator('[data-start]');
  await expect(start).toHaveCount(1);
  await expect(start).toBeVisible({ timeout: 20_000 });

  await start.click();

  const skip = page.locator('[data-skip]');
  await expect(skip).toBeVisible();
  await expect(skip).toBeEnabled();

  const wrap = page.locator('[data-video-wrap]');
  await expect(wrap).toBeVisible();

  // Skip until we hit REST mode (avoid assuming exact segment ordering)
  for (let i = 0; i < 12; i++) {
    const hasRest = await wrap.evaluate(el => el.classList.contains('mode-rest'));
    if (hasRest) break;
    await skip.click();
    await page.waitForTimeout(90);
  }

  await expect(wrap).toHaveClass(/mode-rest/);

  const clock = page.locator('[data-clock]');
  await expect(clock).toBeVisible();
});
