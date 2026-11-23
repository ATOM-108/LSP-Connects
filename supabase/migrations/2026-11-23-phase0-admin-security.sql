-- ============================================================================
-- LSP CONNECT — PHASE 0: ADMIN SECURITY FOUNDATION
-- STATUS: PROPOSAL ONLY — REVIEWED BUT NOT APPLIED
-- ----------------------------------------------------------------------------
-- DO NOT RUN until the review document has been approved.
-- Nothing in this file has been executed against the live database.
--
-- SCOPE
--   * Fix role privilege escalation on public.profiles.
--   * Create the admin authorization helpers used by RLS.
--   * Stop providers from self-approving their own verification status.
--   * Add a role-value constraint.
--   * NO table drops, NO data deletion, NO column removals, NO RLS weakening.
--
-- SAFETY MODEL
--   * Idempotent: every object is created with IF NOT EXISTS /
--     CREATE OR REPLACE / DROP ... IF EXISTS before CREATE.
--   * Additive: no existing policy is deleted except the four named lsp_*
--     policies that this file immediately recreates with equal-or-stricter
--     logic.
--   * Reversible: see SECTION D (ROLLBACK).
--
-- RUN ORDER
--   SECTION A  -> read-only inspection (run first, keep the output)
--   SECTION B  -> the migration (run as one script)
--   SECTION C  -> read-only post-checks
--   SECTION D  -> rollback, only if needed
--
-- WHERE TO RUN
--   Supabase Dashboard -> SQL Editor, as the project owner.
--   Never from the browser, never with the anon key, never in frontend code.
-- ============================================================================


-- ============================================================================
-- SECTION A — PRE-FLIGHT INSPECTION (READ-ONLY, CHANGES NOTHING)
-- ----------------------------------------------------------------------------
-- Run these first and keep the output. They tell us what the live database
-- actually contains, because the two SQL scripts in supabase/ disagree with
-- each other and with the live schema.
-- ============================================================================

-- A1. Every RLS policy that currently exists on the public schema.
--     Look for policies NOT named lsp_* — those are outside this migration's
--     control and must be reviewed manually.
select schemaname, tablename, policyname, cmd, roles, qual, with_check
from pg_policies
where schemaname = 'public'
order by tablename, policyname;

-- A2. Is RLS enabled (and forced) on every table?
--     relforcerowsecurity must stay false on public.profiles: the SECURITY
--     DEFINER helpers below depend on the owner bypassing RLS.
select c.relname,
       c.relrowsecurity  as rls_enabled,
       c.relforcerowsecurity as rls_forced
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relkind = 'r'
order by c.relname;

-- A3. Which role values exist today? Anything outside customer/provider/admin
--     is legacy data that the new constraint will not validate (NOT VALID).
select role, count(*) as accounts
from public.profiles
group by role
order by accounts desc;

-- A4. Do the admin helper functions already exist, and are they SECURITY DEFINER
--     with a pinned search_path?
select p.proname, p.prosecdef as security_definer, p.proconfig as pinned_settings
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname like 'lsp\_%'
order by p.proname;

-- A5. What can the `authenticated` role actually write on public.profiles?
--     If UPDATE on the `role` column is listed here, escalation is live.
select grantee, privilege_type, column_name
from information_schema.column_privileges
where table_schema = 'public'
  and table_name = 'profiles'
  and grantee in ('anon', 'authenticated')
order by grantee, privilege_type, column_name;

-- A6. Existing triggers on the tables this migration guards.
select c.relname as table_name, t.tgname, pg_get_triggerdef(t.oid) as definition
from pg_trigger t
join pg_class c on c.oid = t.tgrelid
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and not t.tgisinternal
order by c.relname, t.tgname;


-- ============================================================================
-- SECTION B — MIGRATION
-- ============================================================================

begin;

-- ----------------------------------------------------------------------------
-- B1. Role values must be one of the three known roles.
-- ----------------------------------------------------------------------------
-- The audit assumed an `app_role` enum. It does not exist: profiles.role is
-- plain `text not null default 'customer'` with no constraint anywhere in the
-- repository. This adds the missing guard.
--
-- NOT VALID is deliberate: it is enforced for every new INSERT/UPDATE but does
-- not scan or reject existing rows, so it cannot fail on legacy data and cannot
-- modify a single record.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'profiles_role_allowed'
      and conrelid = 'public.profiles'::regclass
  ) then
    alter table public.profiles
      add constraint profiles_role_allowed
      check (role in ('customer', 'provider', 'admin')) not valid;
  end if;
end $$;


-- ----------------------------------------------------------------------------
-- B2. Authorization helpers.
-- ----------------------------------------------------------------------------
-- SECURITY DEFINER is required, not stylistic: these functions are called from
-- policies ON public.profiles. A SECURITY INVOKER function reading profiles
-- from inside a profiles policy re-enters that policy (infinite recursion,
-- PostgreSQL error 42P17). Running as the table owner bypasses RLS, so the
-- lookup is evaluated exactly once with no recursion.
--
-- Mitigations applied to both functions:
--   * `set search_path = pg_catalog, public` — prevents object shadowing.
--   * Every identifier schema-qualified (public.profiles, auth.uid()).
--   * `stable` — one evaluation per statement, not per row.
--   * EXECUTE revoked from PUBLIC and anon, granted only to authenticated.
--   * Returns a scalar / boolean, never a row or a table of other users' data,
--     so it cannot be abused as a data-reading oracle.

create or replace function public.lsp_role()
returns text
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select p.role
  from public.profiles p
  where p.id = (select auth.uid());
$$;

create or replace function public.lsp_is_admin()
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select exists (
    select 1
    from public.profiles p
    where p.id = (select auth.uid())
      and p.role = 'admin'
  );
$$;

-- Provider identity helper. Already referenced by the provider_documents policy
-- recreated in B4, and by the services/provider_skills policies in schema.sql.
create or replace function public.lsp_provider_ids()
returns setof uuid
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select pp.user_id
  from public.provider_profiles pp
  where pp.user_id = (select auth.uid());
$$;

revoke all on function public.lsp_role()         from public, anon;
revoke all on function public.lsp_is_admin()     from public, anon;
revoke all on function public.lsp_provider_ids() from public, anon;

grant execute on function public.lsp_role()         to authenticated;
grant execute on function public.lsp_is_admin()     to authenticated;
grant execute on function public.lsp_provider_ids() to authenticated;


-- ----------------------------------------------------------------------------
-- B3. Role escalation guard on public.profiles.
-- ----------------------------------------------------------------------------
-- WHY A TRIGGER AND NOT A POLICY:
--   RLS is row-scoped, never column-scoped. `using (id = auth.uid())` correctly
--   limits WHICH row a user may update but says nothing about WHICH COLUMNS.
--   No policy can prevent `PATCH profiles?id=eq.<self>` with {"role":"admin"}.
--   A BEFORE trigger is the only place that can see old and new values.
--
-- WHY NOT A COLUMN-LEVEL REVOKE:
--   api.js ensureProfile() sends `role` inside its UPDATE payload on the
--   duplicate path, i.e. on every login of an existing account. Revoking
--   UPDATE(role) would make that UPDATE fail, ensureProfile would swallow the
--   error and return null, and loadIdentity() would lose the profile — a login
--   regression for every existing customer and provider. Explicitly rejected.
--
-- POLICY OF THIS TRIGGER:
--   * Privileged context (no end-user session: service_role key, SQL editor,
--     migrations) -> untouched.
--   * INSERT by a user -> only 'customer' or 'provider' accepted. An 'admin'
--     insert raises 42501 and the whole statement rolls back.
--   * UPDATE by a user -> role is immutable. The stored value is kept silently
--     rather than raising, so legitimate profile saves that echo `role` in the
--     payload keep succeeding.
--
--   Note the admin branch is intentionally absent from the UPDATE path. If
--   admins could change role from the client, ensureProfile() would demote an
--   admin on their next login (it sends the metadata role, typically
--   'customer'). Privileged role changes go through service_role or
--   lsp_admin_set_role() below — never through the session's own row.

create or replace function public.lsp_guard_profile_role()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
begin
  -- No end-user session => service_role, SQL editor or a migration.
  -- Unreachable from the browser: the profiles policies only admit the
  -- `authenticated` role for INSERT and UPDATE.
  if (select auth.uid()) is null then
    return new;
  end if;

  if tg_op = 'INSERT' then
    if new.role is null then
      new.role := 'customer';
    end if;

    if new.role not in ('customer', 'provider') then
      raise exception
        'lsp_role_escalation_blocked: a user cannot create a profile with role %', new.role
        using errcode = '42501';
    end if;

    return new;
  end if;

  -- UPDATE: role is immutable for end users.
  if new.role is distinct from old.role then
    raise log 'lsp_guard_profile_role: blocked role change % -> % for profile %',
      old.role, new.role, new.id;
    new.role := old.role;
  end if;

  return new;
end;
$$;

drop trigger if exists lsp_guard_profile_role on public.profiles;
create trigger lsp_guard_profile_role
  before insert or update on public.profiles
  for each row execute function public.lsp_guard_profile_role();


-- ----------------------------------------------------------------------------
-- B4. Policy changes (only four, all named lsp_*).
-- ----------------------------------------------------------------------------
-- Everything not listed here keeps its current definition. In particular the
-- bookings, customer_addresses, notifications and provider_profiles SELECT
-- policies are NOT touched, because the customer and provider modules depend on
-- them exactly as they are.

-- B4.1 profiles INSERT — a self-created profile may never be privileged.
--      (Previously: `with check (id = auth.uid())` only.)
drop policy if exists lsp_profiles_insert on public.profiles;
create policy lsp_profiles_insert on public.profiles for insert to authenticated
  with check (
    id = (select auth.uid())
    and role in ('customer', 'provider')
  );

-- B4.2 provider_profiles UPDATE — the original definition referenced a column
--      that does not exist in the live table (`id`), so it could never have
--      been created. Rewritten against the real primary key (user_id) and
--      extended with the admin branch needed for verification decisions.
drop policy if exists lsp_providers_update on public.provider_profiles;
create policy lsp_providers_update on public.provider_profiles for update to authenticated
  using (
    user_id = (select auth.uid())
    or public.lsp_is_admin()
  )
  with check (
    user_id = (select auth.uid())
    or public.lsp_is_admin()
  );

-- B4.3 provider_documents — provider owns their documents, admin may review all.
--      Recreated only to guarantee the helper function it calls exists.
drop policy if exists lsp_documents_owner on public.provider_documents;
create policy lsp_documents_owner on public.provider_documents for all to authenticated
  using (
    provider_id in (select public.lsp_provider_ids())
    or public.lsp_is_admin()
  )
  with check (
    provider_id in (select public.lsp_provider_ids())
    or public.lsp_is_admin()
  );

-- B4.4 provider_profiles UPDATE guard — a provider must not approve themselves.
--      The policy above deliberately still lets a provider edit their own row
--      (business name, availability, city...). This trigger pins the one field
--      that decides verification. Coercion instead of an exception on INSERT
--      keeps provider registration working even if the form submits 'approved'.
create or replace function public.lsp_guard_provider_verification()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
begin
  if (select auth.uid()) is null then
    return new;
  end if;

  if public.lsp_is_admin() then
    return new;
  end if;

  if tg_op = 'INSERT' then
    if new.verification_status in ('approved', 'verified') then
      new.verification_status := 'pending';
    end if;
    return new;
  end if;

  if new.verification_status is distinct from old.verification_status then
    raise log 'lsp_guard_provider_verification: blocked % -> % for provider %',
      old.verification_status, new.verification_status, new.user_id;
    new.verification_status := old.verification_status;
  end if;

  return new;
end;
$$;

drop trigger if exists lsp_guard_provider_verification on public.provider_profiles;
create trigger lsp_guard_provider_verification
  before insert or update on public.provider_profiles
  for each row execute function public.lsp_guard_provider_verification();


-- ----------------------------------------------------------------------------
-- B5. OPTIONAL hardening — review before enabling.
-- ----------------------------------------------------------------------------
-- Supabase grants CREATE on schema public to anon/authenticated by default.
-- With that grant, a signed-in user could create a function that shadows an
-- unqualified call inside a SECURITY DEFINER function. This migration already
-- defends by pinning search_path and schema-qualifying every reference, so this
-- is defence in depth, not a prerequisite.
--
-- Uncomment ONLY after confirming the app never creates database objects at
-- runtime (it does not):
--
-- revoke create on schema public from anon, authenticated;

commit;


-- ============================================================================
-- SECTION C — POST-MIGRATION CHECKS (READ-ONLY)
-- ============================================================================

-- C1. Functions exist, are SECURITY DEFINER, and pin their search_path.
--     Expect three rows, security_definer = true, pinned_settings non-null.
select p.proname, p.prosecdef as security_definer, p.proconfig as pinned_settings
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname like 'lsp\_%'
order by p.proname;

-- C2. Both guards are installed as BEFORE ROW triggers.
select c.relname, t.tgname, pg_get_triggerdef(t.oid)
from pg_trigger t
join pg_class c on c.oid = t.tgrelid
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and t.tgname like 'lsp\_guard%';

-- C3. The four recreated policies have the expected shape.
select tablename, policyname, cmd, roles, qual, with_check
from pg_policies
where schemaname = 'public'
  and policyname in ('lsp_profiles_insert', 'lsp_providers_update',
                     'lsp_documents_owner', 'lsp_profiles_update')
order by policyname;

-- C4. Exactly one admin exists (after Phase 1 provisioning).
select id, email, role from public.profiles where role = 'admin';


-- ============================================================================
-- SECTION D — ROLLBACK (only if a real regression appears)
-- ----------------------------------------------------------------------------
-- Order matters: policies are recreated FIRST so nothing references a function
-- that is about to disappear.
-- ============================================================================
/*
begin;

drop trigger if exists lsp_guard_provider_verification on public.provider_profiles;
drop trigger if exists lsp_guard_profile_role          on public.profiles;

drop function if exists public.lsp_guard_provider_verification();
drop function if exists public.lsp_guard_profile_role();

alter table public.profiles drop constraint if exists profiles_role_allowed;

-- Restore the original definitions (from supabase/schema.sql):
drop policy if exists lsp_profiles_insert on public.profiles;
create policy lsp_profiles_insert on public.profiles for insert to authenticated
  with check (id = auth.uid());

-- lsp_role(), lsp_is_admin() and lsp_provider_ids() are left in place: they are
-- inert without callers and dropping them would break any policy still using
-- them. Drop them only after every referencing policy is gone.

commit;
*/

-- ============================================================================
-- END OF PROPOSAL — NOT EXECUTED
-- ============================================================================
