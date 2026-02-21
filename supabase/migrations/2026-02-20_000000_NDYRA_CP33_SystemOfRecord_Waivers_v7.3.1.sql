-- =========================================================
-- NDYRA CP33 — System-of-Record Foundations: Waivers (v7.3.1)
-- =========================================================
-- PURPOSE:
--   • Add tenants.system_of_record + active_waiver_version
--   • Add waiver_templates (immutable) + waiver_signatures (append-only)
--   • Add audit_log (append-only)
--   • Add has_signed_current_waiver() + sign_current_waiver() RPC
--   • Add Storage bucket + RLS policies for waiver signatures
--
-- NOTES:
--   • Run as postgres/supabase_admin.
--   • This migration is designed to be safe on existing DBs (IF EXISTS guards where possible).
--   • sign_current_waiver() is SECURITY DEFINER and validates:
--       - active waiver exists
--       - signature path matches required key format
--       - storage object exists (prevents forging paths)
--       - inserts are idempotent via unique(tenant_id,user_id,waiver_version)
-- =========================================================

-- ---------------------------------------------------------
-- Extensions (idempotent)
-- ---------------------------------------------------------
create extension if not exists "uuid-ossp";
create extension if not exists "pgcrypto";

-- ---------------------------------------------------------
-- Tenants: system_of_record + active_waiver_version
-- ---------------------------------------------------------
-- system_of_record: 'external' | 'ndyra'
alter table public.tenants
  add column if not exists system_of_record text not null default 'external',
  add column if not exists active_waiver_version integer;

-- Enforce allowed values for system_of_record
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'tenants_system_of_record_chk'
      AND conrelid = 'public.tenants'::regclass
  ) THEN
    ALTER TABLE public.tenants
      ADD CONSTRAINT tenants_system_of_record_chk
      CHECK (system_of_record IN ('external','ndyra'));
  END IF;
END $$;

-- ---------------------------------------------------------
-- Audit log (append-only)
-- ---------------------------------------------------------
create table if not exists public.audit_log (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid references public.tenants(id) on delete cascade,
  actor_user_id uuid references auth.users(id) on delete set null,
  action text not null,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

alter table public.audit_log enable row level security;

-- Read: tenant staff + platform admin
drop policy if exists audit_log_select_staff on public.audit_log;
create policy audit_log_select_staff
on public.audit_log for select
using (
  (tenant_id is not null and public.is_tenant_staff(tenant_id))
  or public.is_platform_admin()
);

-- No client insert/update/delete policies (server-only writes)

-- ---------------------------------------------------------
-- Waiver templates (immutable)
-- ---------------------------------------------------------
create table if not exists public.waiver_templates (
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  version integer not null,
  title text not null,
  body_md text not null,
  body_sha256 text,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (tenant_id, version)
);

alter table public.waiver_templates enable row level security;

-- Read: authenticated users can read the active waiver for a tenant they are joining.
-- We scope to the tenant's active_waiver_version to avoid leaking old versions.
-- (Staff can also read via this policy; platform admin always allowed.)
--
-- IMPORTANT: This is metadata + waiver text only; signatures are stored separately.

drop policy if exists waiver_templates_select_active on public.waiver_templates;
create policy waiver_templates_select_active
on public.waiver_templates for select
using (
  public.is_platform_admin()
  OR EXISTS (
    SELECT 1
    FROM public.tenants t
    WHERE t.id = waiver_templates.tenant_id
      AND t.active_waiver_version = waiver_templates.version
  )
);

-- No client insert/update/delete policies (server-only writes)

create index if not exists waiver_templates_tenant_version_idx
  on public.waiver_templates(tenant_id, version desc);

-- ---------------------------------------------------------
-- Waiver signatures (append-only)
-- ---------------------------------------------------------
create table if not exists public.waiver_signatures (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  waiver_version integer not null,
  signature_storage_path text not null,
  created_at timestamptz not null default now(),
  unique (tenant_id, user_id, waiver_version)
);

alter table public.waiver_signatures enable row level security;

-- Read own signature rows; staff can read tenant signature rows.
drop policy if exists waiver_signatures_select_own on public.waiver_signatures;
create policy waiver_signatures_select_own
on public.waiver_signatures for select
using (auth.uid() = user_id);

drop policy if exists waiver_signatures_select_staff on public.waiver_signatures;
create policy waiver_signatures_select_staff
on public.waiver_signatures for select
using (
  (tenant_id is not null and public.is_tenant_staff(tenant_id))
  or public.is_platform_admin()
);

-- No client insert/update/delete policies (writes happen only via RPC sign_current_waiver)

create index if not exists waiver_signatures_tenant_user_idx
  on public.waiver_signatures(tenant_id, user_id, waiver_version desc);

-- ---------------------------------------------------------
-- Helper: has_signed_current_waiver(tenant_id, user_id)
-- ---------------------------------------------------------
create or replace function public.has_signed_current_waiver(p_tenant_id uuid, p_user_id uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_version integer;
begin
  if p_tenant_id is null or p_user_id is null then
    return false;
  end if;

  select t.active_waiver_version
    into v_version
  from public.tenants t
  where t.id = p_tenant_id;

  if v_version is null then
    return false;
  end if;

  return exists(
    select 1
    from public.waiver_signatures ws
    where ws.tenant_id = p_tenant_id
      and ws.user_id = p_user_id
      and ws.waiver_version = v_version
  );
end $$;

-- ---------------------------------------------------------
-- RPC: sign_current_waiver(tenant_id, signature_storage_path)
-- ---------------------------------------------------------
-- Validates:
--   • user is authenticated
--   • tenant has active_waiver_version and template exists
--   • signature_storage_path matches required key format:
--       t/{tenant_id}/u/{user_id}/v{waiver_version}/{signature_uuid}.png
--   • object exists in storage.objects in bucket waiver-signatures
-- Inserts append-only (idempotent by unique constraint)
--
create or replace function public.sign_current_waiver(
  p_tenant_id uuid,
  p_signature_storage_path text
)
returns uuid
language plpgsql
security definer
set search_path = public, storage
as $$
declare
  v_uid uuid;
  v_version integer;
  v_existing uuid;
  v_filename text;
  v_expected_seg5 text;
  v_seg1 text;
  v_seg2 text;
  v_seg3 text;
  v_seg4 text;
  v_seg5 text;
  v_seg6 text;
begin
  v_uid := auth.uid();

  if v_uid is null then
    raise exception 'sign_current_waiver: auth required';
  end if;

  if p_tenant_id is null then
    raise exception 'sign_current_waiver: tenant_id required';
  end if;

  if p_signature_storage_path is null or length(trim(p_signature_storage_path)) = 0 then
    raise exception 'sign_current_waiver: signature_storage_path required';
  end if;

  select t.active_waiver_version
    into v_version
  from public.tenants t
  where t.id = p_tenant_id;

  if v_version is null then
    raise exception 'sign_current_waiver: no active waiver version for tenant';
  end if;

  -- Ensure template exists for that active version
  if not exists(
    select 1
    from public.waiver_templates wt
    where wt.tenant_id = p_tenant_id
      and wt.version = v_version
  ) then
    raise exception 'sign_current_waiver: active waiver template missing (tenant %, version %)', p_tenant_id, v_version;
  end if;

  -- Basic format check
  -- Required: t/{tenant_id}/u/{user_id}/v{version}/{uuid}.png
  if p_signature_storage_path !~* '^t/[0-9a-f\-]{36}/u/[0-9a-f\-]{36}/v[0-9]+/[0-9a-f\-]{36}\.png$' then
    raise exception 'sign_current_waiver: invalid signature path format';
  end if;

  v_seg1 := split_part(p_signature_storage_path, '/', 1);
  v_seg2 := split_part(p_signature_storage_path, '/', 2);
  v_seg3 := split_part(p_signature_storage_path, '/', 3);
  v_seg4 := split_part(p_signature_storage_path, '/', 4);
  v_seg5 := split_part(p_signature_storage_path, '/', 5);
  v_seg6 := split_part(p_signature_storage_path, '/', 6);

  v_expected_seg5 := 'v' || v_version::text;

  if v_seg1 <> 't' or v_seg3 <> 'u' then
    raise exception 'sign_current_waiver: invalid signature path segments';
  end if;

  if v_seg2 <> p_tenant_id::text then
    raise exception 'sign_current_waiver: tenant_id mismatch in signature path';
  end if;

  if v_seg4 <> v_uid::text then
    raise exception 'sign_current_waiver: user_id mismatch in signature path';
  end if;

  if v_seg5 <> v_expected_seg5 then
    raise exception 'sign_current_waiver: waiver version mismatch in signature path';
  end if;

  v_filename := v_seg6;
  if v_filename !~* '^[0-9a-f\-]{36}\.png$' then
    raise exception 'sign_current_waiver: invalid signature filename';
  end if;

  -- Verify object exists in Storage bucket
  if not exists(
    select 1
    from storage.objects o
    where o.bucket_id = 'waiver-signatures'
      and o.name = p_signature_storage_path
  ) then
    raise exception 'sign_current_waiver: storage object missing (upload required first)';
  end if;

  -- Insert append-only; return id (idempotent)
  insert into public.waiver_signatures(tenant_id, user_id, waiver_version, signature_storage_path)
  values (p_tenant_id, v_uid, v_version, p_signature_storage_path)
  on conflict (tenant_id, user_id, waiver_version) do nothing
  returning id into v_existing;

  if v_existing is not null then
    -- Audit
    insert into public.audit_log(tenant_id, actor_user_id, action, details)
    values (
      p_tenant_id,
      v_uid,
      'waiver_signed',
      jsonb_build_object(
        'waiver_version', v_version,
        'signature_storage_path', p_signature_storage_path
      )
    );

    return v_existing;
  end if;

  -- Already signed; return existing row id
  select ws.id
    into v_existing
  from public.waiver_signatures ws
  where ws.tenant_id = p_tenant_id
    and ws.user_id = v_uid
    and ws.waiver_version = v_version;

  return v_existing;
end $$;

grant execute on function public.sign_current_waiver(uuid, text) to authenticated;

-- ---------------------------------------------------------
-- Storage: waiver-signatures bucket + policies
-- ---------------------------------------------------------
-- Bucket (private)
insert into storage.buckets (id, name, public)
values ('waiver-signatures','waiver-signatures', false)
on conflict (id) do nothing;

-- Policies on storage.objects are global; scope tightly by bucket + key format.

-- Allow authenticated users to upload ONLY their own signature path
DROP POLICY IF EXISTS waiver_signatures_upload_own ON storage.objects;
CREATE POLICY waiver_signatures_upload_own
ON storage.objects
FOR INSERT
TO authenticated
WITH CHECK (
  bucket_id = 'waiver-signatures'
  AND split_part(name,'/',1) = 't'
  AND split_part(name,'/',3) = 'u'
  AND split_part(name,'/',4) = auth.uid()::text
  AND name ~* '^t/[0-9a-f\-]{36}/u/[0-9a-f\-]{36}/v[0-9]+/[0-9a-f\-]{36}\.png$'
);

-- Allow authenticated users to read ONLY their own signature objects
DROP POLICY IF EXISTS waiver_signatures_read_own ON storage.objects;
CREATE POLICY waiver_signatures_read_own
ON storage.objects
FOR SELECT
TO authenticated
USING (
  bucket_id = 'waiver-signatures'
  AND split_part(name,'/',1) = 't'
  AND split_part(name,'/',3) = 'u'
  AND split_part(name,'/',4) = auth.uid()::text
);

-- No DELETE policy (append-only); admins can clean up via service role if needed.

-- ---------------------------------------------------------
-- Patch: is_tenant_member should include comp (if gym_memberships exists)
-- ---------------------------------------------------------
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
    select 1
    from public.gym_memberships gm
    where gm.tenant_id = tid
      and gm.user_id = auth.uid()
      and gm.status in ('active','comp')
  );
end $$;

-- END CP33 waivers
