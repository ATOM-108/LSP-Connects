-- ============================================================================
-- LSP CONNECT — PHASE 0: ADMIN SECURITY FOUNDATION
-- STATUS: PROPOSAL ONLY — CORRECTED AFTER REVIEW — NOT APPLIED
-- ----------------------------------------------------------------------------
-- DO NOT RUN until the review document has been approved.
-- Nothing in this file has been executed against the live database.
--
-- SCOPE
--   * Fix role privilege escalation on public.profiles.
--   * Create/upgrade the admin authorization helpers used by RLS.
--   * Stop providers from self-approving their own verification status.
--   * Add a role-value constraint.
--   * Guarantee a correct provider_profiles INSERT policy exists.
--   * NO table drops, NO data deletion, NO column removals, NO RLS weakening.
--
-- CORRECTION NOTICE (review round 2)
--   The first draft of this file said the provider_profiles policies "could
--   never have been created" because they reference a column named `id`. That
--   is true of supabase/schema.sql, but NOT of what is live:
--   supabase/allow-authorized-writes.sql (the script that was actually
--   delivered and applied) defines lsp_providers_insert and lsp_providers_update
--   against `user_id = auth.uid()`, which is correct. The INSERT path is
--   therefore already working, and this file now only re-asserts it (B4.0) so
--   the migration is safe on BOTH databases: one built by
--   allow-authorized-writes.sql, and one built by a partial schema.sql attempt.
--   The same correction applies to `services` — see B6.
--
-- SAFETY MODEL
--   * Idempotent: every object is created with IF NOT EXISTS /
--     CREATE OR REPLACE / DROP ... IF EXISTS before CREATE.
--   * Additive: no existing policy is deleted except the lsp_* policies that
--     this file immediately recreates with equal-or-stricter logic.
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
-- actually contains, because the SQL scripts in supabase/ disagree with each
-- other and with the live schema.
-- ============================================================================

-- A1. Every RLS policy that currently exists on the public schema.
--     Look for policies NOT named lsp_* — those are outside this migration's
--     control and must be reviewed manually.
select schemaname, tablename, policyname, cmd, roles, qual, with_check
from pg_policies
where schemaname = 'public'
order by tablename, policyname;

-- A2. Is RLS enabled (and forced) on every table?
--     relforcerowsecurity MUST stay false on public.profiles: the SECURITY
--     DEFINER helpers below depend on the owner bypassing RLS. If it is true,
--     the helpers recurse and every profile read fails with 42P17.
select c.relname,
       c.relrowsecurity      as rls_enabled,
       c.relforcerowsecurity as rls_forced
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relkind = 'r'
order by c.relname;

-- A3. Which role values exist today, including NULLs?
select coalesce(role, '(null)') as role, count(*) as accounts
from public.profiles
group by role
order by accounts desc;

-- A4. Do the admin helper functions already exist? Who owns them, are they
--     SECURITY DEFINER, and do they pin their search_path?
--     `proowner` matters: a helper owned by a role that is NOT the table owner
--     does not bypass RLS and will recurse.
select p.proname,
       p.proowner::regrole   as owner,
       p.prosecdef           as security_definer,
       p.proconfig           as pinned_settings
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname like 'lsp\_%'
order by p.proname;

-- A5. What can anon/authenticated actually write on public.profiles?
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

-- A7. THE PROVIDER INSERT QUESTION. Does a provider_profiles INSERT policy
--     exist, and does it use the real key column (user_id) or the absent `id`?
--     Expect one row named lsp_providers_insert whose with_check contains
--     "user_id = ( SELECT auth.uid() ...)".
--     * Row present with user_id  -> provider registration is fine.
--     * Row present with id       -> impossible; such a policy could not compile.
--     * No row at all             -> provider registration is DENIED by RLS and
--                                    B4.0 below is required, not optional.
select policyname, cmd, roles, qual, with_check
from pg_policies
where schemaname = 'public'
  and tablename = 'provider_profiles'
order by policyname;

-- A8. THE SERVICES QUESTION. The live policy is expected to be permissive
--     (`using (true) with check (true)`), not broken. Confirm its real shape.
select policyname, cmd, roles, qual, with_check
from pg_policies
where schemaname = 'public'
  and tablename = 'services'
order by policyname;

-- A9. Invalid legacy role values that a NOT VALID constraint will tolerate but
--     that will block any future UPDATE of those specific rows.
select id, email, role
from public.profiles
where role is null
   or role not in ('customer', 'provider', 'admin')
order by role nulls first, email;


-- ============================================================================
-- SECTION B — MIGRATION
-- ============================================================================

begin;

-- ----------------------------------------------------------------------------
-- B1. Role values must be one of the three known roles.
-- ----------------------------------------------------------------------------
-- The audit brief assumed an `app_role` enum. It does not exist: profiles.role
-- is plain `text` (default 'customer') with no constraint in any repository
-- script. This adds the missing guard.
--
-- NOT VALID is deliberate: enforced for every new INSERT/UPDATE but does not
-- scan or reject existing rows, so it cannot fail on legacy data and cannot
-- modify a single record.
--
-- NOTE ON SQL SEMANTICS: a CHECK passes when the expression is NULL, so a NULL
-- role is not rejected here. B3 coerces NULL to 'customer' on INSERT, and the
-- profiles INSERT policy rejects it, so no NULL row can be created going
-- forward. Existing NULL rows are reported by A3/A9 and left untouched.
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
-- These statements UPGRADE the versions created by
-- supabase/allow-authorized-writes.sql, which pinned only `search_path = public`
-- and left EXECUTE granted to PUBLIC/anon. CREATE OR REPLACE is a no-op when
-- the objects are already identical.
--
-- Mitigations applied to all three functions:
--   * `set search_path = pg_catalog, public` — prevents object shadowing.
--   * Every identifier schema-qualified (public.profiles, auth.uid()).
--   * `stable` — one evaluation per statement, not per row.
--   * EXECUTE revoked from PUBLIC and anon, granted only to authenticated.
--   * Returns a scalar / boolean / the caller's own uuid, never another user's
--     data, so it cannot be abused as a reading oracle.

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

-- Provider identity helper. Referenced by the provider_documents and
-- provider_skills policies, and recreated here so its definition is guaranteed
-- to match the live table's real key (user_id).
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
--   The admin branch is intentionally absent from the UPDATE path. If admins
--   could change role from the client, ensureProfile() would demote an admin on
--   their next login (it sends the metadata role, typically 'customer').
--   Privileged role changes go through service_role or the SQL editor only.

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
-- B4. Policy changes (all named lsp_*, each recreated equal-or-stricter).
-- ----------------------------------------------------------------------------
-- Everything not listed here keeps its current definition. In particular the
-- bookings, customer_addresses, notifications and provider_profiles SELECT
-- policies are NOT touched, because the customer and provider modules depend on
-- them exactly as they are.

-- B4.0 provider_profiles INSERT — guarantee a correct definition exists.
--      api.js createProviderProfile() inserts { user_id, business_name,
--      service_category_id, years_experience, city, hourly_rate, bio,
--      is_available, verification_status:'pending' }, so the predicate must be
--      on user_id. The live policy (from allow-authorized-writes.sql) already
--      matches this; re-creating it is a no-op there and repairs a database
--      where only the broken schema.sql variant was attempted (which references
--      a non-existent `id` column and therefore creates no policy at all,
--      leaving provider registration denied by RLS).
drop policy if exists lsp_providers_insert on public.provider_profiles;
create policy lsp_providers_insert on public.provider_profiles for insert to authenticated
  with check (
    user_id = (select auth.uid())
    or public.lsp_is_admin()
  );

-- B4.1 profiles INSERT — a self-created profile may never be privileged.
--      (Previously: `with check (id = auth.uid())` only.)
drop policy if exists lsp_profiles_insert on public.profiles;
create policy lsp_profiles_insert on public.profiles for insert to authenticated
  with check (
    id = (select auth.uid())
    and role in ('customer', 'provider')
  );

-- B4.2 provider_profiles UPDATE — rewritten against the real primary key
--      (user_id) and extended with the admin branch needed for verification
--      decisions. The old schema.sql definition referenced `id`, which does not
--      exist; the live one already used user_id.
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

-- B4.4 provider_profiles verification guard — a provider must not approve
--      themselves. The policy above deliberately still lets a provider edit
--      their own row (business name, availability, city...). This trigger pins
--      the one field that decides verification.
--
--      Coercion instead of an exception on INSERT keeps provider registration
--      working: createProviderProfile() already sends 'pending', and a form that
--      submits 'approved' is silently corrected rather than rejected.
--
--      A NULL verification_status on INSERT is left alone (the column default
--      'pending' has already been applied before a BEFORE trigger runs), so the
--      normal registration path is untouched.
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


-- ----------------------------------------------------------------------------
-- B6. DOCUMENTED, NOT CHANGED — public.services is writable by ANY signed-in
--     user, including customers.
-- ----------------------------------------------------------------------------
-- Live definition (from allow-authorized-writes.sql, section 8):
--
--     create policy lsp_services_write on public.services for all
--       to authenticated using (true) with check (true);
--
-- This was intentional: it came from the earlier request to let every
-- authorized user add details to the database, and api.js addProviderService()
-- / removeProviderService() depend on it. The risk is real but bounded:
--   * Any customer can INSERT a junk service row, UPDATE any catalogue entry,
--     or DELETE the entire catalogue (removeProviderService deletes by id).
--   * It does NOT expose other users' data, bookings, profiles or payments.
-- Tightening it to provider-owner scope is IMPOSSIBLE on the live table:
-- `services` has no provider_id column (id, name, description, category_id,
-- is_active). An owner-scoped policy therefore needs an additive schema change
-- first, and an admin-only policy would break the provider "manage services"
-- screen. Neither belongs in Phase 0.
--
-- Decision: leave it. Record it as an accepted, documented risk and address it
-- in a later phase together with the services table change.

commit;


-- ============================================================================
-- SECTION C — POST-MIGRATION CHECKS (READ-ONLY)
-- ============================================================================

-- C1. Functions exist, are owned by a role that can bypass RLS, are
--     SECURITY DEFINER, and pin their search_path.
--     Expect three rows: security_definer = true, pinned_settings non-null,
--     owner = postgres (or the same owner as public.profiles).
select p.proname,
       p.proowner::regrole as owner,
       p.prosecdef         as security_definer,
       p.proconfig         as pinned_settings
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname like 'lsp\_%'
order by p.proname;

-- C2. Both guards are installed as BEFORE ROW triggers.
select c.relname, t.tgname, pg_get_triggerdef(t.oid)
from pg_trigger t
join pg_class c on c.oid = t.tgrelid
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and t.tgname like 'lsp\_guard%'
order by t.tgname;

-- C3. The recreated policies have the expected shape.
--     lsp_providers_insert and lsp_providers_update must reference user_id,
--     never `id`.
select tablename, policyname, cmd, roles, qual, with_check
from pg_policies
where schemaname = 'public'
  and policyname in ('lsp_providers_insert', 'lsp_providers_update',
                     'lsp_profiles_insert', 'lsp_documents_owner')
order by policyname;

-- C4. Exactly one admin exists (after Phase 1 provisioning).
select id, email, role from public.profiles where role = 'admin';

-- C5. Execute privileges on the helpers: authenticated only.
--     Expect three rows for authenticated, and NO rows for anon or PUBLIC.
select p.proname, a.grantee::text as grantee
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
cross join lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
where n.nspname = 'public' and p.proname like 'lsp\_%'
order by p.proname, grantee;

-- C6. The constraint exists and is NOT VALID (existing rows not yet scanned).
select conname, convalidated, pg_get_constraintdef(oid) as definition
from pg_constraint
where conname = 'profiles_role_allowed';


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

-- Restore the original definitions (from supabase/allow-authorized-writes.sql):
drop policy if exists lsp_profiles_insert on public.profiles;
create policy lsp_profiles_insert on public.profiles for insert to authenticated
  with check (id = auth.uid());

drop policy if exists lsp_providers_insert on public.provider_profiles;
create policy lsp_providers_insert on public.provider_profiles for insert to authenticated
  with check (user_id = auth.uid() or public.lsp_is_admin());

-- lsp_role(), lsp_is_admin() and lsp_provider_ids() are left in place: they are
-- still referenced by many policies and are inert on their own. Dropping them
-- would break every policy that calls them.

commit;
*/

-- ============================================================================
-- END OF PROPOSAL — NOT EXECUTED
-- ============================================================================
