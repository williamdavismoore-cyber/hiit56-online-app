# HIIT56 Automated QA Harness (CP26)

This checkpoint adds *repeatable*, automated QA that you can run **every checkpoint** before packaging.

## 1) Install dependencies (one-time)

From the kit folder:

```bash
npm install
npx playwright install
```

Notes:
- `npm install` brings in Playwright + Lighthouse CI + static server tooling.
- `npx playwright install` downloads browsers (Chromium/Firefox/WebKit) for stable testing.

## 2) Run the automated QA suite

### Smoke (fast local validation)
```bash
npm run qa:smoke
```

### End-to-End (Playwright)
```bash
npm run qa:e2e
```

### Performance budgets (Lighthouse CI)
```bash
npm run qa:lighthouse
```

### Everything in one shot
```bash
npm run qa:all
```

Artifacts:
- Playwright HTML report (after a run): `playwright-report/`
- Lighthouse results: `artifacts/lighthouse/`

## 3) Vimeo domain allow-list verification

If Vimeo embeds randomly fail on preview/prod, **it is often privacy allow-list**, not code.

```bash
VIMEO_TOKEN="YOUR_TOKEN" npm run qa:vimeo:allowlist -- --domain hiit56online.com --domain YOUR_NETLIFY_DOMAIN.netlify.app
```

Optional auto-fix (adds missing domains):
```bash
VIMEO_TOKEN="YOUR_TOKEN" node tools/vimeo_allowlist_check.mjs --domain hiit56online.com --fix
```

## 4) Telemetry (Sentry-style)

The site now sends unhandled errors to:

`/.netlify/functions/telemetry_ingest`

In Netlify:
- Add env var `TELEMETRY_WEBHOOK_URL` to forward events to Slack/Discord webhook (optional)
- Otherwise, errors still appear in Netlify function logs.

## Recommended workflow per checkpoint

1) Pull latest kit
2) Run `npm run qa:all`
3) Fix any failures
4) Package checkpoint deliverables
