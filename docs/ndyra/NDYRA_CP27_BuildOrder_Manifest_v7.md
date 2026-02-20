# NDYRA CP27 Build Order Manifest (v7)
Blueprint Source of Truth (LOCKED): `NDYRA_SoupToNuts_Blueprint_v7.3.1_LOCKED_CORRECTED.pdf`


Owner: William Davis Moore  
Lead Dev: Aelric Architect  
Scope: CP27 — Social Core MVP (FYP + Following + Post Create/Detail + Profile + Notifications + Moderation)

## Non‑Negotiables
- No private leaks: `can_view_post()` must gate posts + media + reactions + comments + stats.
- Portrait-first feed (9:16 card rhythm).
- Positive-only reactions. No downvotes.
- Seek pagination everywhere (no offset).
- All writes require auth. Guests read only public content.


## Anti-Drift Enforcement (Do Not Skip)
- No new patterns. If a change introduces a new pattern, update the blueprint first or reject the change.
- Every DB change must pass Anti-Drift Audit and RLS tests before merge.
- Capture and commit the RLS fingerprint at the start of CP27 and anytime policies change.

### Required Gates (must be green before any merge to main)
- Gate A: Run `NDYRA_CP27_AntiDrift_Audit_v7.sql` (enforce=true) on staging DB → must PASS.
- Gate B: Run `NDYRA_CP27_RLS_Tests_v7.sql` (with real test user UUIDs) → must PASS.
- Gate C: Storage policies validated: private post media must not be readable by unauthenticated users.
- Gate D: Seek pagination verified on /app/fyp and /app/following (no OFFSET).
- Gate E: PostCard + FeedQuery module boundary adhered to (no page-specific hacks).

## Step 0 — Run Migrations
- Apply `NDYRA_CP27_SocialCore_Migrations_v7.sql` in Supabase
- Verify RLS is enabled everywhere and policies are correct
- Create Storage buckets:
  - `avatars` (public read; user write to own folder)
  - `post-media` (visibility-aware read; author write)
- Add storage policies (see blueprint Appendix A / Security section)

## Step 1 — UI Pages (in this exact order)
### 1A) /app/fyp/
- Implement feed list, post card, skeletons, empty state
- Implement like/reaction + comments count + save
- Implement “Not Interested” (client-side hidden list MVP)

### 1B) /app/following/
- Implement chronological feed from followed users + gyms
- Same PostCard component

### 1C) /app/post/{id}
- Post detail, media carousel, comments thread
- Add comment composer with “encouragement prompt”

### 1D) /app/create/
- Post composer (text + image upload)
- Upload direct to Storage, then insert post_media rows

### 1E) /app/profile/
- Profile header + biometrics strip (manual entry)
- User’s posts list/grid
- Privacy settings page link

### 1F) /app/notifications/
- Notifications list + mark read

## Step 2 — Social Graph Actions
- Follow/unfollow user
- Follow/unfollow tenant
- Block/mute user
- Report post/comment/profile

## Step 3 — Moderation (MVP)
- Report queue view for platform admin
- Simple takedown (soft delete post)
- Strike / slow-mode updates in `user_moderation_state`

## Step 4 — Verification
- Run RLS test plan (`NDYRA_CP27_RLS_Tests_v7.sql`) with real test users
- QA checklist: mobile Safari, Chrome Android, desktop PWA, keyboard nav

## Step 5 — Release
- Enable feature flag for Boca pilot gyms
- Monitor: slow queries, error logs, webhook health