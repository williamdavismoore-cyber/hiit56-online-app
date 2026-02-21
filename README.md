# NDYRA App

## Source of Truth (LOCKED)

**Blueprint v7.3.1 (LOCKED + Corrected)** is the *only* source of truth for routes, data model, RLS rules, serverless functions, and gate requirements.

Path in repo:

`docs/ndyra/NDYRA_SoupToNuts_Blueprint_v7.3.1_LOCKED_CORRECTED.pdf`

## Anti-Drift Rules (Non‑Negotiable)

- No PR merges unless **all gates pass** (Audit + RLS tests + E2E + Lighthouse).
- No new patterns/frameworks/root folders.
- No new routes/DB tables/RPCs unless the **Blueprint** is updated first.
- Enforcement is always **server-side** (RLS + RPC + serverless functions). UI is never the only gate.

## Quick Start (Local)

From the repo root (the folder with `package.json`):

```bash
npm ci
npx playwright install
npm run start:qa
```

Open:

- `http://localhost:4173/`

### If you’re seeing an old site (e.g. Hiit56) when you expect NDYRA

This repo uses a service worker for offline support. If an older build got cached, your browser can keep serving the old shell.

Quick fix:

- DevTools → **Application** → **Service Workers** → **Unregister**
- then **Clear storage** (tick “Unregister service workers”)
- hard refresh

Or test in an Incognito window.

## Run E2E (Playwright)

```bash
npm run qa:e2e
```

Useful variants:

```bash
npm run qa:e2e -- --headed
npm run qa:e2e -- --debug
npm run qa:e2e -- --project="Desktop Chromium"
npm run qa:e2e -- --project="Mobile Safari"
```

If you ever see:

`Project(s) "…" not found. Available projects: ""`

you’re almost always running Playwright from the wrong folder. `cd` back to the repo root.

After the run:

```bash
npx playwright show-report
```

## Performance Gate (Lighthouse CI)

```bash
npm run qa:lighthouse
```

## Database Gates (Supabase)

Run these in **Supabase SQL Editor** against **STAGING** before merge:

- `supabase/gates/NDYRA_CP27_AntiDrift_Audit_*.sql`
- `supabase/gates/NDYRA_CP27_RLS_Tests_*.sql`

See:

- `docs/ndyra/THIS_IS_LAW.md`
- `docs/ndyra/GATES_RUNBOOK.md`
