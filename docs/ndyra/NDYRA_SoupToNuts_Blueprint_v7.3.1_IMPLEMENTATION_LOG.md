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
