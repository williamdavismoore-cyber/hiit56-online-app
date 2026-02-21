# NDYRA Blueprint v7.3.1 — Implementation Log (Anti-Drift)

This file exists **only** to satisfy the anti-drift rule:

> No new routes / DB migrations / Netlify functions without an explicit Blueprint update.

The canonical Blueprint is:

`docs/ndyra/NDYRA_SoupToNuts_Blueprint_v7.3.1_LOCKED_CORRECTED.pdf`

---

## CP29 (2026-02-18)

Blueprint sections referenced:
- **2. Route Map** (member app routes)
- **4. UI Build Spec** (AppShell + PostCard contract)
- **6. Social Core** (FYP feed foundations)

Implemented / scaffolded routes (as defined in blueprint):
- `/app/fyp/` — For You feed (seek pagination + demo mode)
- `/app/post/{id}` — Post detail route (Netlify redirect + page scaffold)
- `/app/following/` — stub scaffold
- `/app/create/` — stub scaffold
- `/app/notifications/` — stub scaffold
- `/app/profile/` — stub scaffold

Notes:
- No new DB tables added.
- Uses existing Social Core migrations (CP27) as the required schema.

---

## CP30 (2026-02-18)

Blueprint sections referenced:
- **6. Social Core — Step 1B** (Following feed)

Changes:
- Implemented `/app/following/` feed using the same PostCard contract as `/app/fyp/`.
- Supports:
  - **Demo mode** via `?src=demo` (for deterministic E2E without Supabase)
  - Real mode requires auth + pulls posts from:
    - `follows_users` (followed people)
    - `follows_tenants` (followed gyms/tenants)
  - Seek pagination (created_at cursor)
  - Encouragement reactions (persisted when authed, disabled in demo)

Non-blueprint fixes (safe, no drift):
- Fixed Supabase public config key mismatch by accepting **camelCase + snake_case** keys.

Notes:
- No new routes added (route existed as scaffold in CP29).
- No DB schema changes.

---

## CP33 (2026-02-20)

Blueprint sections referenced:
- **2. Route Map** (Public + Business portal + booking fork routes)
- **9. Gym Ops System-of-Record** (Waivers + Quick Join requirements)
- **Appendix A** (waiver + SOR constraints)

Implemented (per blueprint route map):
- `/gym/{slug}/join` — Quick Join (account → waiver → payment → confirmation)
  - Demo mode: `?src=demo` (no Supabase required)
  - Real mode wiring:
    - fetch tenant by `slug`
    - load active waiver template
    - capture signature (canvas)
    - upload to Storage bucket `waiver-signatures`
    - record via RPC `sign_current_waiver(tenant_id, signature_storage_path)`

Backend additions (anti-drift approved by v7.3.1):
- **Supabase migration**: `supabase/migrations/2026-02-20_000000_NDYRA_CP33_SystemOfRecord_Waivers_v7.3.1.sql`
  - `tenants.system_of_record` + `tenants.active_waiver_version`
  - `waiver_templates` (immutable)
  - `waiver_signatures` (append-only)
  - `audit_log` (append-only)
  - RPC: `sign_current_waiver()` + helper `has_signed_current_waiver()`
  - Storage bucket + scoped RLS policies for `waiver-signatures`

Netlify Functions:
- `netlify/functions/waiver-template-update.mjs`
  - Staff-only endpoint to version-bump waiver templates and activate via `tenants.active_waiver_version`

QA / Gates:
- Added Playwright E2E: `tests/e2e/gym_join.spec.js` (demo mode)
- Updated `tools/qa_smoke.py` required-page checks to include new route files.
- Updated `package.json` to add `start:qa` and to use `tools/static_server.cjs` for local QA.

Notes:
- Payment step is scaffolded (CP34 wiring will connect Stripe checkout + membership requirements).

---

## CP34 (2026-02-20)

Blueprint sections referenced:
- **9. Gym Ops System-of-Record** (Quick Join end-to-end requirements)
- **2. Route Map** (QA-first entry points)

Changes:
- Quick Join payment step now supports:
  - demo skip (local QA, no Netlify functions)
  - Stripe Checkout redirect when deployed (Netlify Functions)
  - deterministic return URLs back into the join flow
- Stripe checkout session metadata now carries optional NDYRA context (`flow`, `tenant_slug`, `tenant_id`) for reconciliation.

Hardening:
- Updated cache headers + service worker cache-bust (prevents “stuck on old build” / wrong brand shell during QA).
- Updated home page CTA to land directly on NDYRA surfaces used in QA (`/app/fyp/`, `/app/following/`, `/gym/{slug}/join`).
