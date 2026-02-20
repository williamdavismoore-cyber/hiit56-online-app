# This is law. Run the gates before merge.

## Source of Truth (LOCKED)

**Blueprint v7.3.1 (LOCKED + Corrected)** is the only source of truth.

Repo path:

`docs/ndyra/NDYRA_SoupToNuts_Blueprint_v7.3.1_LOCKED_CORRECTED.pdf`

If you change routes, DB schema/RLS, RPCs, or serverless behavior, the Blueprint must be updated first.

---

## Merge Blockers

No PR merges unless **all gates pass**:

- E2E (Playwright)
- Lighthouse CI budget
- Supabase Anti‑Drift Audit SQL
- Supabase RLS Regression Tests SQL

---

## CI gates (GitHub Actions)

`checkpoint_qa.yml` runs:

- `npm run qa:e2e`
- `npm run qa:lighthouse:ci`

Database gates are designed to be run against **STAGING** before merge:

- `supabase/gates/NDYRA_CP27_AntiDrift_Audit_*.sql`
- `supabase/gates/NDYRA_CP27_RLS_Tests_*.sql`

---

## Blueprint Guard

If you change anything under `supabase/migrations/`, the PR must also include an updated Blueprint file under `docs/ndyra/`.
