# NDYRA Gates Runbook

## Source of Truth (LOCKED)

Blueprint v7.3.1 (LOCKED + Corrected):

`docs/ndyra/NDYRA_SoupToNuts_Blueprint_v7.3.1_LOCKED_CORRECTED.pdf`

---

## 0) Prereqs (one-time)

From repo root:

```bash
npm ci
npx playwright install
```

---

## 1) E2E Gate (Playwright)

Run all E2E:

```bash
npm run qa:e2e
```

Desktop only:

```bash
npm run qa:e2e -- --project=chromium
```

Mobile emulation:

```bash
npm run qa:e2e -- --project=mobile-chrome
```

Open the HTML report:

```bash
npx playwright show-report
```

---

## 2) Lighthouse Gate

```bash
npm run qa:lighthouse:ci
```

---

## 3) Supabase Gate A — Anti‑Drift Audit

Open Supabase → SQL Editor → New query → paste and run:

Preferred:

- `supabase/gates/NDYRA_CP27_AntiDrift_Audit_v8.sql`

Legacy (only if you have a reason):

- `supabase/gates/NDYRA_CP27_AntiDrift_Audit_v7.sql`

If it raises an exception, treat it as a **hard fail**.

---

## 4) Supabase Gate B — RLS Regression Tests

1) Create two test users in Supabase Auth:

- ALICE (author)
- BOB (viewer)

2) Copy their UUIDs from `auth.users` and paste them into:

Preferred:

- `supabase/gates/NDYRA_CP27_RLS_Tests_v8.sql`

Legacy:

- `supabase/gates/NDYRA_CP27_RLS_Tests_v7.sql`

3) Run the script in Supabase SQL Editor.

If it raises an exception, treat it as a **hard fail**.

Notes:

- v8 forces `role=authenticated` and `row_security=on` so you don’t get false positives/negatives when running inside the SQL Editor.
