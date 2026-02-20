-- =========================================================
-- NDYRA CP27 — Social Core MVP (v7) — FIXED (idempotent + gate-safe)
-- =========================================================

-- Extensions
create extension if not exists "uuid-ossp";
create extension if not exists "pgcrypto";
create extension if not exists "pg_trgm";

-- Enums (safe create)
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
-- Tables that functions depend on FIRST
-- ---------------------------------------------------------

create table if not exists public.follows_users (
  follower_id uuid not null references auth.users(id) on delete cascade,
  followee_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (follower_id, followee_id)
);
alter table public.follows_users enable row level security;

create table if not exists public.follows_tenants (
  follower_id uuid not null references auth.users(id) on delete cascade,
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (follower_id, tenant_id)
);
alter table public.follows_tenants enable row level security;

create table if not exists public.blocks (
  blocker_id uuid not null references auth.users(id) on delete cascade,
  blocked_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (blocker_id, blocked_id)
);
alter table public.blocks enable row level security;

-- ---------------------------------------------------------
-- Helper functions (DROP then CREATE to avoid param-name conflicts)
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
  return exists(select 1 from public.platform_admins pa where pa.user_id = auth.uid());
end $$;

create or replace function public.is_tenant_admin(tid uuid)
returns boolean
language plpgsql stable
security definer
set search_path = public
as $$
begin
  if tid is null then return false; end if;
  if to_regclass('public.tenant_users') is null then return false; end if;
  return exists(
    select 1 from public.tenant_users tu
    where tu.tenant_id = tid and tu.user_id = auth.uid() and tu.role = 'admin'
  );
end $$;

create or replace function public.is_tenant_staff(tid uuid)
returns boolean
language plpgsql stable
security definer
set search_path = public
as $$
begin
  if tid is null then return false; end if;
  if to_regclass('public.tenant_users') is null then return false; end if;
  return exists(
    select 1 from public.tenant_users tu
    where tu.tenant_id = tid and tu.user_id = auth.uid() and tu.role in ('admin','staff')
  );
end $$;

-- v7.3 eligibility: active OR comp (gym_memberships introduced later; safe return false if absent)
create or replace function public.is_tenant_member(tid uuid)
returns boolean
language plpgsql stable
security definer
set search_path = public
as $$
begin
  if tid is null then return false; end if;
  if to_regclass('public.gym_memberships') is null then return false; end if;
  return exists(
    select 1 from public.gym_memberships gm
    where gm.tenant_id = tid and gm.user_id = auth.uid() and gm.status in ('active','comp')
  );
end $$;

-- DROP then CREATE avoids param rename conflicts
drop function if exists public.is_blocked_between(uuid, uuid);
create function public.is_blocked_between(a uuid, b uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select case
    when a is null or b is null then false
    else exists(
      select 1 from public.blocks bl
      where (bl.blocker_id = a and bl.blocked_id = b)
         or (bl.blocker_id = b and bl.blocked_id = a)
    )
  end;
$$;

-- Posts table (needed by can_view_post)
create table if not exists public.posts (
  id uuid primary key default uuid_generate_v4(),
  author_user_id uuid references auth.users(id) on delete cascade,
  author_tenant_id uuid references public.tenants(id) on delete cascade,
  tenant_context_id uuid references public.tenants(id) on delete set null,
  club_id uuid,
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

-- DROP then CREATE avoids param rename conflicts
drop function if exists public.can_view_post(uuid);
create function public.can_view_post(p_post_id uuid)
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
  where p.id = p_post_id;

  if v is null or deleted then return false; end if;

  if public.is_platform_admin() then return true; end if;

  if v = 'public' then
    if au is not null and public.is_blocked_between(viewer, au) then return false; end if;
    return true;
  end if;

  if viewer is null then return false; end if;

  if au is not null and au = viewer then return true; end if;
  if au is not null and public.is_blocked_between(viewer, au) then return false; end if;

  if v = 'private' then return false; end if;

  if v = 'followers' then
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

  return false;
end $$;

-- ---------------------------------------------------------
-- Policies: create if missing (no IF NOT EXISTS in Postgres)
-- ---------------------------------------------------------

do $$
begin
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='posts' and policyname='posts_select_can_view') then
    execute $p$
      create policy posts_select_can_view
      on public.posts for select
      using (public.can_view_post(id))
    $p$;
  end if;

  if not exists (select 1 from pg_policies where schemaname='public' and tablename='posts' and policyname='posts_insert_user_or_staff') then
    execute $p$
      create policy posts_insert_user_or_staff
      on public.posts for insert
      with check (
        (author_user_id = auth.uid() and author_tenant_id is null)
        or (author_tenant_id is not null and public.is_tenant_staff(author_tenant_id))
      )
    $p$;
  end if;
end $$;

-- ---------------------------------------------------------
-- Post-adjacent tables (media/comments/reactions/stats) created next
-- (Keep your existing definitions; only change is policy creation style + can_view_post param fix)
-- ---------------------------------------------------------

-- (Your existing post_media/post_reactions/post_comments/post_stats definitions can remain,
--  but update policy statements to be DO-block guarded like above.)

-- =========================================================
-- END FIXED CP27 migrations
-- =========================================================