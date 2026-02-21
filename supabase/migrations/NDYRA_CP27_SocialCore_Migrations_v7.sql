-- =========================================================
-- NDYRA CP27 — Social Core MVP (v7)
-- Supabase Postgres migrations (RLS-safe, blocked-safe, no private media leaks)
-- =========================================================
-- NOTES:
-- 1) Run in Supabase SQL editor as postgres/supabase_admin.
-- 2) This is CP27 ONLY (Social Core). Tokens/Booking/Gyms expand in CP28+.
-- 3) After running, verify RLS with Appendix J checklist in the blueprint.

-- ---------------------------------------------------------
-- Extensions
-- ---------------------------------------------------------
create extension if not exists "uuid-ossp";
create extension if not exists "pgcrypto";
create extension if not exists "pg_trgm";

-- ---------------------------------------------------------
-- Enums (safe create)
-- ---------------------------------------------------------
do $$ begin
  create type public.post_visibility as enum ('public','followers','members','club','private','staff');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.reaction_type as enum ('fire','clap','flex','heart','check');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.report_reason as enum ('harassment','hate','spam','nudity','violence','self_harm','misinformation','copyright','other');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.notification_type as enum ('reaction','comment','follow_user','follow_tenant','mention','booking','system');
exception when duplicate_object then null; end $$;

-- ---------------------------------------------------------
-- Helper functions (RLS building blocks)
-- Best practice: SECURITY DEFINER + fixed search_path for any function that reads tables
-- protected by RLS (e.g., blocks). Keep outputs minimal (booleans) to avoid leakage.
-- ---------------------------------------------------------
create or replace function public.is_platform_admin()
returns boolean
language plpgsql stable
security definer
set search_path = public
as $$
begin
  if to_regclass('public.platform_admins') is null then
    return false;
  end if;

  return exists(
    select 1 from public.platform_admins pa
    where pa.user_id = auth.uid()
  );
end $$;

create or replace function public.is_tenant_admin(tid uuid)
returns boolean
language plpgsql stable
security definer
set search_path = public
as $$
begin
  if tid is null then
    return false;
  end if;

  if to_regclass('public.tenant_users') is null then
    return false;
  end if;

  return exists(
    select 1 from public.tenant_users tu
    where tu.tenant_id = tid
      and tu.user_id = auth.uid()
      and tu.role = 'admin'
  );
end $$;

create or replace function public.is_tenant_staff(tid uuid)
returns boolean
language plpgsql stable
security definer
set search_path = public
as $$
begin
  if tid is null then
    return false;
  end if;

  if to_regclass('public.tenant_users') is null then
    return false;
  end if;

  return exists(
    select 1 from public.tenant_users tu
    where tu.tenant_id = tid
      and tu.user_id = auth.uid()
      and tu.role in ('admin','staff')
  );
end $$;

-- A user is a "member" of a gym if they have an active membership row.
-- CP27 note: gym_memberships is introduced in CP28. Until it exists, this returns false.
create or replace function public.is_tenant_member(tid uuid)
returns boolean
language plpgsql stable
security definer
set search_path = public
as $$
begin
  if tid is null then
    return false;
  end if;

  if to_regclass('public.gym_memberships') is null then
    return false;
  end if;

  return exists(
    select 1 from public.gym_memberships gm
    where gm.tenant_id = tid
      and gm.user_id = auth.uid()
      and gm.status = 'active'
  );
end $$;

-- Mutual blocking check (both directions). Returns false if either id is null.
create or replace function public.is_blocked_between(a uuid, b uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select
    case
      when a is null or b is null then false
      else exists(
        select 1 from public.blocks bl
        where (bl.blocker_id = a and bl.blocked_id = b)
           or (bl.blocker_id = b and bl.blocked_id = a)
      )
    end;
$$;

-- Central visibility rule for posts. This MUST be used by policies on post_media,
-- post_reactions, post_comments, post_stats to avoid private leaks.
create or replace function public.can_view_post(pid uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v public.post_visibility;
  au uuid;
  at uuid;
  tc uuid;
  deleted boolean;
  viewer uuid;
begin
  viewer := auth.uid();

  select p.visibility, p.author_user_id, p.author_tenant_id, p.tenant_context_id, p.is_deleted
  into v, au, at, tc, deleted
  from public.posts p
  where p.id = pid;

  if v is null then
    return false;
  end if;

  if deleted then
    return false;
  end if;

  -- platform admin override
  if public.is_platform_admin() then
    return true;
  end if;

  -- Public is public even for anon viewers
  if v = 'public' then
    -- If authored by a user and the viewer is blocked, hide it.
    if au is not null and public.is_blocked_between(viewer, au) then
      return false;
    end if;
    return true;
  end if;

  -- Everything below requires auth
  if viewer is null then
    return false;
  end if;

  -- Author's own post always visible
  if au is not null and au = viewer then
    return true;
  end if;

  -- Blocks (user-authored posts)
  if au is not null and public.is_blocked_between(viewer, au) then
    return false;
  end if;

  if v = 'private' then
    return false; -- already handled by author match
  end if;

  if v = 'followers' then
    -- user follows user OR user follows tenant
    if au is not null and exists(select 1 from public.follows_users fu where fu.follower_id = viewer and fu.followee_id = au) then
      return true;
    end if;

    if at is not null and exists(select 1 from public.follows_tenants ft where ft.follower_id = viewer and ft.tenant_id = at) then
      return true;
    end if;

    return false;
  end if;

  if v = 'members' then
    if tc is null then return false; end if;
    return public.is_tenant_member(tc);
  end if;

  if v = 'staff' then
    if tc is null then return false; end if;
    return public.is_tenant_staff(tc);
  end if;

  -- club handled later in CP31
  return false;
end $$;

-- ---------------------------------------------------------
-- Profiles (extend existing)
-- ---------------------------------------------------------
alter table public.profiles
  add column if not exists handle text unique,
  add column if not exists avatar_url text,
  add column if not exists bio text,
  add column if not exists location_city text,
  add column if not exists location_region text,
  add column if not exists updated_at timestamptz not null default now();

-- ---------------------------------------------------------
-- Privacy settings (user-controlled)
-- ---------------------------------------------------------
create table if not exists public.privacy_settings (
  user_id uuid primary key references auth.users(id) on delete cascade,
  biometrics_visibility text not null default 'followers', -- public|followers|clubs|private
  workouts_visibility text not null default 'followers',
  injuries_visibility text not null default 'my_gyms', -- private|my_gyms|custom
  location_visibility text not null default 'city', -- precise|city|off
  updated_at timestamptz not null default now()
);

alter table public.privacy_settings enable row level security;

create policy "privacy_select_own"
on public.privacy_settings for select
using (auth.uid() = user_id);

create policy "privacy_upsert_own"
on public.privacy_settings for insert
with check (auth.uid() = user_id);

create policy "privacy_update_own"
on public.privacy_settings for update
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

-- ---------------------------------------------------------
-- Follow system (users + tenants)
-- ---------------------------------------------------------
create table if not exists public.follows_users (
  follower_id uuid not null references auth.users(id) on delete cascade,
  followee_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (follower_id, followee_id)
);

alter table public.follows_users enable row level security;

create policy "follows_users_select_own"
on public.follows_users for select
using (auth.uid() = follower_id);

create policy "follows_users_insert_own"
on public.follows_users for insert
with check (auth.uid() = follower_id);

create policy "follows_users_delete_own"
on public.follows_users for delete
using (auth.uid() = follower_id);

create index if not exists follows_users_followee_idx on public.follows_users(followee_id, created_at desc);

create table if not exists public.follows_tenants (
  follower_id uuid not null references auth.users(id) on delete cascade,
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (follower_id, tenant_id)
);

alter table public.follows_tenants enable row level security;

create policy "follows_tenants_select_own"
on public.follows_tenants for select
using (auth.uid() = follower_id);

create policy "follows_tenants_insert_own"
on public.follows_tenants for insert
with check (auth.uid() = follower_id);

create policy "follows_tenants_delete_own"
on public.follows_tenants for delete
using (auth.uid() = follower_id);

create index if not exists follows_tenants_tenant_idx on public.follows_tenants(tenant_id, created_at desc);

-- ---------------------------------------------------------
-- Blocks (mutual invisibility)
-- ---------------------------------------------------------
create table if not exists public.blocks (
  blocker_id uuid not null references auth.users(id) on delete cascade,
  blocked_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (blocker_id, blocked_id)
);

alter table public.blocks enable row level security;

create policy "blocks_select_own"
on public.blocks for select
using (auth.uid() = blocker_id);

create policy "blocks_insert_own"
on public.blocks for insert
with check (auth.uid() = blocker_id);

create policy "blocks_delete_own"
on public.blocks for delete
using (auth.uid() = blocker_id);

-- ---------------------------------------------------------
-- Posts
-- ---------------------------------------------------------
create table if not exists public.posts (
  id uuid primary key default uuid_generate_v4(),
  author_user_id uuid references auth.users(id) on delete cascade,
  author_tenant_id uuid references public.tenants(id) on delete cascade,
  tenant_context_id uuid references public.tenants(id) on delete set null, -- "posted inside gym space"
  club_id uuid, -- phase later
  visibility public.post_visibility not null default 'public',
  content_text text,
  workout_ref jsonb not null default '{}'::jsonb,
  is_deleted boolean not null default false,
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (
    (author_user_id is not null and author_tenant_id is null)
    or (author_user_id is null and author_tenant_id is not null)
  )
);

alter table public.posts enable row level security;

create policy "posts_select_can_view"
on public.posts for select
using (public.can_view_post(id));

create policy "posts_insert_user_or_staff"
on public.posts for insert
with check (
  (author_user_id = auth.uid() and author_tenant_id is null)
  or (author_tenant_id is not null and public.is_tenant_staff(author_tenant_id))
);

create policy "posts_update_owner_or_staff"
on public.posts for update
using (
  (author_user_id = auth.uid())
  or (author_tenant_id is not null and public.is_tenant_staff(author_tenant_id))
  or public.is_platform_admin()
)
with check (
  (author_user_id = auth.uid())
  or (author_tenant_id is not null and public.is_tenant_staff(author_tenant_id))
  or public.is_platform_admin()
);

create policy "posts_delete_owner_or_staff"
on public.posts for delete
using (
  (author_user_id = auth.uid())
  or (author_tenant_id is not null and public.is_tenant_staff(author_tenant_id))
  or public.is_platform_admin()
);

create index if not exists posts_created_idx on public.posts(created_at desc);
create index if not exists posts_author_user_created_idx on public.posts(author_user_id, created_at desc);
create index if not exists posts_author_tenant_created_idx on public.posts(author_tenant_id, created_at desc);
create index if not exists posts_tenant_ctx_created_idx on public.posts(tenant_context_id, created_at desc);

-- ---------------------------------------------------------
-- Post media (images now; video later)
-- ---------------------------------------------------------
create table if not exists public.post_media (
  id uuid primary key default uuid_generate_v4(),
  post_id uuid not null references public.posts(id) on delete cascade,
  media_type text not null, -- image|video
  storage_path text not null,
  width integer,
  height integer,
  duration_ms integer,
  created_at timestamptz not null default now()
);

alter table public.post_media enable row level security;

create policy "post_media_select_can_view_post"
on public.post_media for select
using (public.can_view_post(post_id));

create policy "post_media_insert_owner"
on public.post_media for insert
with check (
  exists(
    select 1 from public.posts p
    where p.id = post_id
      and p.is_deleted = false
      and (
        (p.author_user_id = auth.uid())
        or (p.author_tenant_id is not null and public.is_tenant_staff(p.author_tenant_id))
      )
  )
);

-- ---------------------------------------------------------
-- Reactions (positive-only)
-- One reaction per user per post (reaction can be changed via update).
-- ---------------------------------------------------------
create table if not exists public.post_reactions (
  post_id uuid not null references public.posts(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  reaction public.reaction_type not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (post_id, user_id)
);

alter table public.post_reactions enable row level security;

create policy "post_reactions_select_can_view_post"
on public.post_reactions for select
using (public.can_view_post(post_id));

create policy "post_reactions_insert_own"
on public.post_reactions for insert
with check (auth.uid() = user_id and public.can_view_post(post_id));

create policy "post_reactions_update_own"
on public.post_reactions for update
using (auth.uid() = user_id and public.can_view_post(post_id))
with check (auth.uid() = user_id and public.can_view_post(post_id));

create policy "post_reactions_delete_own"
on public.post_reactions for delete
using (auth.uid() = user_id);

create index if not exists post_reactions_post_idx on public.post_reactions(post_id, created_at desc);
create index if not exists post_reactions_user_idx on public.post_reactions(user_id, created_at desc);

-- ---------------------------------------------------------
-- Comments (soft delete via deleted_at)
-- ---------------------------------------------------------
create table if not exists public.post_comments (
  id uuid primary key default uuid_generate_v4(),
  post_id uuid not null references public.posts(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  parent_id uuid references public.post_comments(id) on delete cascade,
  body text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

alter table public.post_comments enable row level security;

create policy "post_comments_select_can_view_post"
on public.post_comments for select
using (public.can_view_post(post_id));

create policy "post_comments_insert_own"
on public.post_comments for insert
with check (auth.uid() = user_id and public.can_view_post(post_id));

create policy "post_comments_update_own"
on public.post_comments for update
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

create index if not exists post_comments_post_idx on public.post_comments(post_id, created_at asc);

-- ---------------------------------------------------------
-- Cached stats (prevents COUNT() overload, enables trending)
-- ---------------------------------------------------------
create table if not exists public.post_stats (
  post_id uuid primary key references public.posts(id) on delete cascade,
  reactions_total integer not null default 0,
  reactions_fire integer not null default 0,
  reactions_clap integer not null default 0,
  reactions_flex integer not null default 0,
  reactions_heart integer not null default 0,
  reactions_check integer not null default 0,
  comments_count integer not null default 0,
  last_engaged_at timestamptz,
  score_48h numeric not null default 0,
  updated_at timestamptz not null default now()
);

alter table public.post_stats enable row level security;

create policy "post_stats_select_can_view_post"
on public.post_stats for select
using (public.can_view_post(post_id));

-- ---------------------------------------------------------
-- Reports (platform moderation)
-- ---------------------------------------------------------
create table if not exists public.reports (
  id uuid primary key default uuid_generate_v4(),
  reporter_id uuid not null references auth.users(id) on delete cascade,
  target_type text not null, -- post|comment|profile|tenant
  target_id uuid not null,
  reason public.report_reason not null,
  details text,
  status text not null default 'open', -- open|reviewing|resolved|rejected
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  resolved_by uuid references auth.users(id)
);

alter table public.reports enable row level security;

create policy "reports_insert_own"
on public.reports for insert
with check (auth.uid() = reporter_id);

create policy "reports_select_platform_admin"
on public.reports for select
using (public.is_platform_admin());

create policy "reports_update_platform_admin"
on public.reports for update
using (public.is_platform_admin())
with check (public.is_platform_admin());

-- ---------------------------------------------------------
-- Notifications (user inbox)
-- ---------------------------------------------------------
create table if not exists public.notifications (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid not null references auth.users(id) on delete cascade,
  type public.notification_type not null,
  actor_user_id uuid references auth.users(id),
  entity_type text, -- post|comment|tenant|booking
  entity_id uuid,
  title text not null,
  body text,
  is_read boolean not null default false,
  created_at timestamptz not null default now()
);

alter table public.notifications enable row level security;

create policy "notifications_select_own"
on public.notifications for select
using (auth.uid() = user_id);

create policy "notifications_update_own"
on public.notifications for update
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

create index if not exists notifications_user_idx on public.notifications(user_id, created_at desc);

-- =========================================================
-- Triggers (incremental post_stats + simple notifications)
-- =========================================================

-- Ensure stats row exists
create or replace function public.on_post_insert_init_stats()
returns trigger language plpgsql as $$
begin
  insert into public.post_stats(post_id) values (new.id)
  on conflict (post_id) do nothing;
  return new;
end $$;

drop trigger if exists trg_posts_init_stats on public.posts;
create trigger trg_posts_init_stats
after insert on public.posts
for each row execute function public.on_post_insert_init_stats();

-- Recompute score (simple, deterministic)
create or replace function public.refresh_post_score(pid uuid)
returns void language plpgsql as $$
declare
  age_hours numeric;
  s public.post_stats%rowtype;
begin
  select * into s from public.post_stats where post_id = pid;

  if not found then
    return;
  end if;

  -- age in hours since post created
  select extract(epoch from (now() - p.created_at))/3600
  into age_hours
  from public.posts p
  where p.id = pid;

  -- Simple decayed score: (reactions_total + 2*comments) * e^(-age/24)
  update public.post_stats
  set score_48h = (s.reactions_total + (2*s.comments_count)) * exp(-age_hours/24),
      updated_at = now()
  where post_id = pid;
end $$;

-- Apply reaction delta
create or replace function public.apply_reaction_delta(pid uuid, r public.reaction_type, delta int)
returns void language plpgsql as $$
begin
  insert into public.post_stats(post_id) values (pid)
  on conflict (post_id) do nothing;

  update public.post_stats
  set reactions_total = greatest(0, reactions_total + delta),
      reactions_fire  = case when r='fire'  then greatest(0, reactions_fire  + delta) else reactions_fire end,
      reactions_clap  = case when r='clap'  then greatest(0, reactions_clap  + delta) else reactions_clap end,
      reactions_flex  = case when r='flex'  then greatest(0, reactions_flex  + delta) else reactions_flex end,
      reactions_heart = case when r='heart' then greatest(0, reactions_heart + delta) else reactions_heart end,
      reactions_check = case when r='check' then greatest(0, reactions_check + delta) else reactions_check end,
      last_engaged_at = now(),
      updated_at = now()
  where post_id = pid;

  perform public.refresh_post_score(pid);
end $$;

-- Apply comment delta
create or replace function public.apply_comment_delta(pid uuid, delta int)
returns void language plpgsql as $$
begin
  insert into public.post_stats(post_id) values (pid)
  on conflict (post_id) do nothing;

  update public.post_stats
  set comments_count = greatest(0, comments_count + delta),
      last_engaged_at = now(),
      updated_at = now()
  where post_id = pid;

  perform public.refresh_post_score(pid);
end $$;

-- Reaction triggers
create or replace function public.on_reaction_insert()
returns trigger language plpgsql as $$
begin
  perform public.apply_reaction_delta(new.post_id, new.reaction, 1);
  return new;
end $$;

create or replace function public.on_reaction_delete()
returns trigger language plpgsql as $$
begin
  perform public.apply_reaction_delta(old.post_id, old.reaction, -1);
  return old;
end $$;

create or replace function public.on_reaction_update()
returns trigger language plpgsql as $$
begin
  if old.reaction <> new.reaction then
    perform public.apply_reaction_delta(old.post_id, old.reaction, -1);
    perform public.apply_reaction_delta(new.post_id, new.reaction,  1);
  end if;
  return new;
end $$;

drop trigger if exists trg_reaction_insert on public.post_reactions;
create trigger trg_reaction_insert
after insert on public.post_reactions
for each row execute function public.on_reaction_insert();

drop trigger if exists trg_reaction_delete on public.post_reactions;
create trigger trg_reaction_delete
after delete on public.post_reactions
for each row execute function public.on_reaction_delete();

drop trigger if exists trg_reaction_update on public.post_reactions;
create trigger trg_reaction_update
after update on public.post_reactions
for each row execute function public.on_reaction_update();

-- Comment triggers (only count non-deleted comments)
create or replace function public.on_comment_insert()
returns trigger language plpgsql as $$
begin
  if new.deleted_at is null then
    perform public.apply_comment_delta(new.post_id, 1);
  end if;
  return new;
end $$;

create or replace function public.on_comment_update()
returns trigger language plpgsql as $$
begin
  -- deleted_at changed from null -> not null (soft delete)
  if old.deleted_at is null and new.deleted_at is not null then
    perform public.apply_comment_delta(new.post_id, -1);
  end if;

  -- restore (rare)
  if old.deleted_at is not null and new.deleted_at is null then
    perform public.apply_comment_delta(new.post_id, 1);
  end if;

  return new;
end $$;

drop trigger if exists trg_comment_insert on public.post_comments;
create trigger trg_comment_insert
after insert on public.post_comments
for each row execute function public.on_comment_insert();

drop trigger if exists trg_comment_update on public.post_comments;
create trigger trg_comment_update
after update on public.post_comments
for each row execute function public.on_comment_update();

-- Simple notifications (reactions/comments) — user-authored posts only
create or replace function public.notify_post_author_on_reaction()
returns trigger language plpgsql as $$
declare
  author uuid;
begin
  select author_user_id into author from public.posts where id = new.post_id;

  if author is null then return new; end if;
  if author = new.user_id then return new; end if;
  if public.is_blocked_between(author, new.user_id) then return new; end if;

  insert into public.notifications(user_id, type, actor_user_id, entity_type, entity_id, title, body)
  values (author, 'reaction', new.user_id, 'post', new.post_id, 'New reaction', 'Someone reacted to your post.');

  return new;
end $$;

drop trigger if exists trg_notify_reaction on public.post_reactions;
create trigger trg_notify_reaction
after insert on public.post_reactions
for each row execute function public.notify_post_author_on_reaction();

create or replace function public.notify_post_author_on_comment()
returns trigger language plpgsql as $$
declare
  author uuid;
begin
  select author_user_id into author from public.posts where id = new.post_id;

  if author is null then return new; end if;
  if author = new.user_id then return new; end if;
  if new.deleted_at is not null then return new; end if;
  if public.is_blocked_between(author, new.user_id) then return new; end if;

  insert into public.notifications(user_id, type, actor_user_id, entity_type, entity_id, title, body)
  values (author, 'comment', new.user_id, 'post', new.post_id, 'New comment', 'Someone commented on your post.');

  return new;
end $$;

drop trigger if exists trg_notify_comment on public.post_comments;
create trigger trg_notify_comment
after insert on public.post_comments
for each row execute function public.notify_post_author_on_comment();

-- END CP27 migrations
