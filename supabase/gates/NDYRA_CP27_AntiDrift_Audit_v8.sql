-- NDYRA CP27 Anti-Drift Audit (v8)
-- Purpose: fail fast if any security drift is introduced.
-- Gate A (required): run this BEFORE any merge.

-- Notes:
-- 1) We do NOT require RESTRICTIVE policies (Postgres defaults to PERMISSIVE).
--    Instead, we hard-block dangerous patterns like USING (true) / WITH CHECK (true)
--    unless explicitly allow-listed.
-- 2) Post-adjacent SELECT policies MUST gate through public.can_view_post(...)

do $$
declare
  enforce boolean := true; -- set false to only emit NOTICEs (not recommended for CI)
  bad_count int;
  fingerprint text;
begin

  -- 1) Every PUBLIC table must have RLS enabled
  select count(*) into bad_count
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relkind in ('r','p')
    and c.relrowsecurity = false;

  if bad_count > 0 then
    if enforce then
      raise exception 'Anti-Drift FAIL: % public tables have RLS DISABLED', bad_count;
    else
      raise notice 'Anti-Drift WARN: % public tables have RLS DISABLED', bad_count;
    end if;
  end if;

  -- 2) No policy may use USING (true) or WITH CHECK (true) unless allow-listed
  with allowlist(tablename) as (
    values
      ('public.platform_admins'),
      ('public.stripe_events')
  ),
  permissive as (
    select (p.schemaname||'.'||p.tablename) as full_table,
           p.policyname, p.cmd,
           coalesce(p.qual,'') as qual,
           coalesce(p.with_check,'') as with_check
    from pg_policies p
    where (p.qual ~* '\(\s*true\s*\)' or p.with_check ~* '\(\s*true\s*\)')
  )
  select count(*) into bad_count
  from permissive x
  left join allowlist a on a.tablename = x.full_table
  where a.tablename is null;

  if bad_count > 0 then
    if enforce then
      raise exception 'Anti-Drift FAIL: % policies contain (true) patterns outside allowlist', bad_count;
    else
      raise notice 'Anti-Drift WARN: % policies contain (true) patterns outside allowlist', bad_count;
    end if;
  end if;

  -- 3) Post-adjacent SELECT policies must gate through can_view_post(...)
  with post_adjacent(tablename) as (
    values
      ('public.posts'),
      ('public.post_media'),
      ('public.post_reactions'),
      ('public.post_comments'),
      ('public.post_stats')
  ),
  missing_gate as (
    select (p.schemaname||'.'||p.tablename) as full_table,
           p.policyname, p.cmd,
           coalesce(p.qual,'') as qual
    from pg_policies p
    join post_adjacent t on t.tablename = (p.schemaname||'.'||p.tablename)
    where p.cmd = 'SELECT'
      and (coalesce(p.qual,'') !~* 'can_view_post')
  )
  select count(*) into bad_count from missing_gate;

  if bad_count > 0 then
    if enforce then
      raise exception 'Anti-Drift FAIL: % post-adjacent SELECT policies missing can_view_post(...)', bad_count;
    else
      raise notice 'Anti-Drift WARN: % post-adjacent SELECT policies missing can_view_post(...)', bad_count;
    end if;
  end if;

  -- 4) Required helper functions must exist
  select count(*) into bad_count
  from pg_proc pr
  join pg_namespace n on n.oid = pr.pronamespace
  where n.nspname = 'public'
    and pr.proname in ('can_view_post','is_blocked_between');

  if bad_count < 2 then
    if enforce then
      raise exception 'Anti-Drift FAIL: required helper functions missing (need can_view_post + is_blocked_between)';
    else
      raise notice 'Anti-Drift WARN: required helper functions missing (need can_view_post + is_blocked_between)';
    end if;
  end if;

  -- 5) Fingerprint (track this per checkpoint)
  select md5(string_agg(
        p.schemaname||'.'||p.tablename||'|'||p.policyname||'|'||p.cmd||'|'||
        coalesce(p.qual,'')||'|'||coalesce(p.with_check,''),
        '||' order by p.schemaname, p.tablename, p.policyname, p.cmd
  ))
  into fingerprint
  from pg_policies p;

  raise notice 'RLS FINGERPRINT: %', fingerprint;

end $$;
