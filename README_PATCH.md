# NDYRA – E2E Fix Patch (Windows friendly)

This patch fixes the failing Playwright test:

- `NDYRA For You feed renders in demo mode`

## Why it was failing

Our Playwright E2E static server (`tools/static_server.cjs`) did not serve `.mjs` files with a JavaScript MIME type.
Browsers refuse to execute ES modules unless the response has a JS MIME type, so `boot.mjs` never ran and the feed never rendered.

## What this patch changes

1) Adds `.mjs` => `application/javascript` to the E2E static server MIME map.
2) Enables Playwright HTML report output so `npx playwright show-report` works.

## How to apply

1) Unzip this patch.
2) Copy the **two files** into your repo root (overwrite when prompted):

- `tools/static_server.cjs`
- `playwright.config.cjs`

## Verify

From repo root:

```powershell
npm run qa:e2e
npx playwright show-report
```

Expected: all tests pass and HTML report opens.
