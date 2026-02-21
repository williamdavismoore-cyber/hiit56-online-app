-- =========================================================
-- NDYRA CP27 — Anti-Drift Audit (v7)
-- =========================================================
-- PURPOSE:
-- Hard-fail on common drift patterns:
--   • RLS disabled on public tables
--   • permissive policies (`using (true)` / `with check (true)`) without explicit allowlist
--   • post-adjacent tables not gated by can_view_post()
--   • missing key helper functions used by RLS
--
-- HOW TO USE:
--   • Run manually in Supabase SQL editor before merges
--   • Or run in CI against staging DB (recommended)
--
-- OUTPUT:
--   • If ENFORCE MODE is enabled, this script raises exceptions on violations.
--   • Otherwise it prints an audit report.
-- =========================================================

-- Toggle enforce mode:
--   true  = raise exception on violations (CI gate)
--   false = report only
do $$
declare
  enforce boolean := true;
  v_count int;
begin

  -- -------------------------------------------------------
  -- 1) Required functions exist
  -- -------------------------------------------------------
  select count(*) into v_count
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname='public' and p.proname in ('can_view_post','is_blocked_between');

  if v_count < 2 then
    raise exception 'Anti-Drift FAIL: missing required functions (need can_view_post + is_blocked_between). Found=%', v_count;
  end if;

  -- -------------------------------------------------------
  -- 2) RLS enabled on all public tables
  -- -------------------------------------------------------
  select count(*) into v_count
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname='public'
    and c.relkind='r'
    and c.relname not like 'pg_%'
    and c.relrowsecurity = false;

  if v_count > 0 then
    if enforce then
      raise exception 'Anti-Drift FAIL: RLS disabled on % public tables', v_count;
    end if;
  end if;

  -- -------------------------------------------------------
  -- 3) No permissive "true" policies unless explicitly allowlisted
  -- -------------------------------------------------------
  -- Allowlist example (future):
  --   table_name = 'tenant_locations' AND policy_name = 'tenant_locations_select_public'
  --
  select count(*) into v_count
  from pg_policies p
  where p.schemaname='public'
    and (
      p.qual ~* '^\s*true\s*$'
      or p.qual ~* '\(\s*true\s*\)'
      or p.with_check ~* '^\s*true\s*$'
      or p.with_check ~* '\(\s*true\s*\)'
    );

  if v_count > 0 then
    if enforce then
      raise exception 'Anti-Drift FAIL: found % permissive policies using TRUE. Remove or explicitly allowlist.', v_count;
    end if;
  end if;

  -- -------------------------------------------------------
  -- 4) Post-adjacent policies must use can_view_post()
  -- -------------------------------------------------------
  -- For CP27, we require gating for these tables:
  --   post_media, post_reactions, post_comments, post_stats
  --
  select count(*) into v_count
  from pg_policies p
  where p.schemaname='public'
    and p.tablename in ('post_media','post_reactions','post_comments','post_stats')
    and p.cmd = 'SELECT'
    and (coalesce(p.qual,'') !~* 'can_view_post');

  if v_count > 0 then
    if enforce then
      raise exception 'Anti-Drift FAIL: % SELECT policies on post-adjacent tables do not use can_view_post()', v_count;
    end if;
  end if;

  -- -------------------------------------------------------
  -- 5) Report: RLS fingerprint snapshot (store per checkpoint)
  -- -------------------------------------------------------
  -- This fingerprint changes whenever RLS policies change.
  -- Store it in repo under docs/rls_fingerprint_cp27.txt and require approval on changes.
  --
  raise notice 'RLS_FINGERPRINT:%',
    (
      select md5(string_agg(coalesce(schemaname,'')||'.'||coalesce(tablename,'')||':'||coalesce(policyname,'')||'|'||coalesce(cmd,'')||'|'||coalesce(qual,'')||'|'||coalesce(with_check,''), E'\n' order by schemaname, tablename, policyname))
      from pg_policies
      where schemaname='public'
    );

  -- -------------------------------------------------------
  -- Done
  -- -------------------------------------------------------
  if enforce then
    raise notice 'Anti-Drift PASS: no violations found.';
  else
    raise notice 'Anti-Drift REPORT complete (enforce=false).';
  end if;

end $$;
