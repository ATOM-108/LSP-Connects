-- ============================================================================
-- LSP CONNECT — PHASE 0: ADMIN SECURITY FOUNDATION
-- STATUS: PROPOSAL ONLY — REVISION 3 — NOT APPLIED
-- ----------------------------------------------------------------------------
-- DO NOT RUN until the review document has been approved.
-- Nothing in this file has been executed against the live database.
--
-- REVISION 3 CHANGES (this round of review)
--   R1  A3 now uses count(*) explicitly (it already did) and adds a separate
--       null/invalid count, so the reviewer's COUNT(*) requirement is visible
--       in one place.
--   R2  NEW B2.1 "owner gate": function ownership is now ESTABLISHED and
--       VERIFIED, not assumed. CREATE OR REPLACE never changes an existing
--       function's owner, so a helper owned by a role that is not the owner of
--       public.profiles would silently fail to bypass RLS. B2.1 reassigns
--       ownership to the table owner and ABORTS the whole transaction if it
--       cannot. It also aborts if relforcerowsecurity is true.
--   R3  Triggers no longer trust `auth.uid() is null` as proof of a trusted
--       context. They now classify the caller by current_user, which PostgREST
--       sets from the signed JWT role claim and a browser cannot forge.
--       `anon` is rejected outright. New pre-flight A10 proves whether any
--       write policy or grant would let anon reach these tables.
--   R4  NEW B4.5: provider_documents.status guard. Providers can no longer
--       self-approve (or self-reject) a document, while uploads and metadata
--       edits keep working. Required before Admin document review exists.
--   R5  B6 rewritten: a concrete future policy design for public.services,
--       including the pre-condition that must be verified first. Still not
--       applied in Phase 0.
--   R6  Role constraint handling restated: existing rows are NEVER modified.
--       NULL and invalid legacy values are only ever reported.
--
-- SCOPE
--   * Fix role privilege escalation on public.profiles.
--   * Create/upgrade the admin authorization helpers and pin their ownership.
--   * Stop providers from self-approving verification or documents.
--   * Add a role-value constraint.
--   * Guarantee a correct provider_profiles INSERT policy exists.
--   * NO table drops, NO data deletion, NO column removals, NO RLS weakening.
--
-- SAFETY MODEL
--   * Idempotent: IF NOT EXISTS / CREATE OR REPLACE / DROP ... IF EXISTS.
--   * Additive: no existing policy is deleted except the lsp_* policies that
--     this file immediately recreates with equal-or-stricter logic.
--   * Fail closed: every safety gate raises an exception, which rolls back the
--     whole transaction. A partially applied security migration is worse than
--     none, so partial success is made impossible.
--   * Reversible: see SECTION D.
--
-- RUN ORDER
--   SECTION A  -> read-only inspection (run first, keep the output)
--   SECTION B  -> the migration (one transaction)
--   SECTION C  -> read-only post-checks
--   SECTION D  -> rollback, only if needed
--
-- WHERE TO RUN
--   Supabase Dashboard -> SQL Editor, as the project owner (postgres).
--   Never from the browser, never with the anon key, never in frontend code.
-- ============================================================================


-- ============================================================================
-- SECTION A — PRE-FLIGHT INSPECTION (READ-ONLY, CHANGES NOTHING)
-- ============================================================================

-- A1. Every RLS policy that currently exists on the public schema.
--     Policies NOT named lsp_* are outside this migration's control and must be
--     reviewed manually.
select schemaname, tablename, policyname, cmd, roles, qual, with_check
from pg_policies
where schemaname = 'public'
order by tablename, policyname;

-- A2. Is RLS enabled (and forced) on every table?
--     relforcerowsecurity MUST be false on public.profiles. B2.1 aborts if it
--     is true, because a SECURITY DEFINER helper cannot bypass forced RLS and
--     every policy calling it would fail with 42P17.
select c.relname,
       c.relrowsecurity      as rls_enabled,
       c.relforcerowsecurity as rls_forced
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relkind = 'r'
order by c.relname;

-- A3. Role distribution. count(*) is used explicitly.
select coalesce(role, '(null)') as role,
       count(*)                 as accounts
from public.profiles
group by role
order by accounts desc;

-- A3b. Totals for the values that B1 must tolerate but that block future
--      UPDATEs of those specific rows (see B1 and R6).
select count(*)                                                    as total_profiles,
       count(*) filter (where role is null)                        as null_roles,
       count(*) filter (where role not in ('customer', 'provider', 'admin'))
                                                                   as invalid_roles
from public.profiles;

-- A4. Do the helper functions exist, who owns them, are they SECURITY DEFINER,
--     and do they pin search_path? `owner` must equal the owner of
--     public.profiles for the RLS bypass to work.
select p.proname,
       p.proowner::regrole   as owner,
       p.prosecdef           as security_definer,
       p.proconfig           as pinned_settings
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname like 'lsp\_%'
order by p.proname;

-- A4b. The owner of public.profiles itself — the role B2.1 will assign.
select c.relname, r.rolname as table_owner
from pg_class c
join pg_roles r on r.oid = c.relowner
where c.oid = 'public.profiles'::regclass;

-- A5. What can anon/authenticated write on public.profiles?
--     If UPDATE on `role` is listed, escalation is reachable.
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

-- A7. THE PROVIDER INSERT QUESTION. Expect one row named lsp_providers_insert
--     whose with_check references user_id (the real key), never `id`.
--     * Row with user_id -> provider registration is fine.
--     * Row with id      -> impossible; such a policy could not compile.
--     * No row           -> provider registration is DENIED by RLS, and B4.0
--                           is required, not optional.
select policyname, cmd, roles, qual, with_check
from pg_policies
where schemaname = 'public'
  and tablename = 'provider_profiles'
order by policyname;

-- A8. THE SERVICES QUESTION. Expected: a permissive policy
--     (`using (true) with check (true)`), not a broken one.
select policyname, cmd, roles, qual, with_check
from pg_policies
where schemaname = 'public'
  and tablename = 'services'
order by policyname;

-- A9. Invalid or NULL legacy role values. These are REPORTED ONLY. This
--     migration never modifies an existing profile row.
select id, email, role
from public.profiles
where role is null
   or role not in ('customer', 'provider', 'admin')
order by role nulls first, email;

-- A10. EVIDENCE FOR R3 — can anon reach these tables at all?
--      (1) table-level write grants held by anon.
select table_name, grantee, privilege_type
from information_schema.role_table_grants
where table_schema = 'public'
  and grantee in ('anon', 'authenticated', 'service_role')
  and privilege_type in ('INSERT', 'UPDATE', 'DELETE')
order by table_name, grantee, privilege_type;

-- A10b. (2) any non-SELECT policy whose roles include anon or public.
--       A row here means an unauthenticated session could reach a write path,
--       which is exactly the case R3's current_user check defends against.
select tablename, policyname, cmd, roles
from pg_policies
where schemaname = 'public'
  and cmd <> 'SELECT'
  and (roles::text like '%anon%' or roles::text = '{public}')
order by tablename, policyname;

-- A11. Document and skills policies, plus the document status distribution —
--      the evidence behind B4.5.
select tablename, policyname, cmd, roles, qual, with_check
from pg_policies
where schemaname = 'public'
  and tablename in ('provider_documents', 'provider_skills')
order by tablename, policyname;

select coalesce(status, '(null)') as status, count(*) as documents
from public.provider_documents
group by status
order by documents desc;


-- ============================================================================
-- SECTION B — MIGRATION (single transaction; any failure rolls back everything)
-- ============================================================================

begin;

-- ----------------------------------------------------------------------------
-- B1. Role values must be one of the three known roles.
-- ----------------------------------------------------------------------------
-- The audit brief assumed an `app_role` enum. It does not exist: profiles.role
-- is plain `text` (default 'customer') with no constraint in any repository
-- script. This adds the missing guard.
--
-- NOT VALID is deliberate and is the reason R6 is satisfied:
--   * It performs NO table scan, rejects NO existing row and modifies NO
--     existing record when applied.
--   * It IS enforced for every subsequent INSERT and UPDATE, so no new invalid
--     value can enter.
--   * A CHECK passes when its expression is NULL, so B1 alone does not reject a
--     NULL role. B3 handles NULL for NEW rows only (see B3).
--   * NOT VALID still validates the new row on UPDATE of an existing row, so a
--     legacy row holding an out-of-range value becomes un-editable (23514).
--     A9 lists those rows BEFORE you apply; none are ever rewritten here.
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
-- SECURITY DEFINER is required, not stylistic: these are called from policies
-- ON public.profiles. A SECURITY INVOKER function reading profiles from inside
-- a profiles policy re-enters that policy (infinite recursion, error 42P17).
-- Running as the table owner bypasses RLS, so the lookup is evaluated once.
--
-- Mitigations on all three:
--   * `set search_path = pg_catalog, public` — prevents object shadowing.
--   * Every identifier schema-qualified (public.profiles, auth.uid()).
--   * `stable` — one evaluation per statement, not per row.
--   * Returns only the caller's own status, never another user's data.

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


-- ----------------------------------------------------------------------------
-- B2.1 OWNER GATE — R2. Ownership is ESTABLISHED, not assumed.
-- ----------------------------------------------------------------------------
-- CREATE OR REPLACE FUNCTION never changes the owner of an existing function,
-- and a SECURITY DEFINER function only bypasses RLS when its owner is the table
-- owner (or holds BYPASSRLS). A helper owned by a different role would therefore
-- recurse, and every profile read would fail with 42P17 — a total outage.
--
-- This block therefore:
--   1. Aborts if FORCE ROW LEVEL SECURITY is on for public.profiles.
--   2. Reassigns each helper to the owner of public.profiles when needed.
--   3. Aborts if the reassignment fails (insufficient privilege) — the caller
--      then knows exactly which ALTER FUNCTION to run as which role.
--   4. Aborts if lsp_is_admin() is somehow not SECURITY DEFINER.
-- Every failure is an exception, so the transaction rolls back completely.
do $$
declare
  tbl_owner text;
  fn        record;
begin
  select r.rolname
    into tbl_owner
  from pg_class c
  join pg_roles r on r.oid = c.relowner
  where c.oid = 'public.profiles'::regclass;

  if tbl_owner is null then
    raise exception 'lsp_owner_gate_failed: public.profiles was not found';
  end if;

  if exists (
    select 1 from pg_class
    where oid = 'public.profiles'::regclass and relforcerowsecurity
  ) then
    raise exception
      'lsp_owner_gate_failed: FORCE ROW LEVEL SECURITY is enabled on public.profiles. A SECURITY DEFINER helper cannot bypass forced RLS, so every policy that calls it would fail with 42P17. Run: alter table public.profiles no force row level security; and re-run this script.';
  end if;

  for fn in
    select p.proname, pg_get_userbyid(p.proowner) as owner
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('lsp_role', 'lsp_is_admin', 'lsp_provider_ids')
  loop
    if fn.owner <> tbl_owner then
      begin
        execute format('alter function public.%I() owner to %I', fn.proname, tbl_owner);
        raise notice 'lsp: % owner reassigned from % to %', fn.proname, fn.owner, tbl_owner;
      exception when others then
        raise exception
          'lsp_owner_gate_failed: public.% is owned by % but must be owned by % (the owner of public.profiles). Automatic reassignment failed: %. Run this script as % in the SQL Editor, or run manually: alter function public.%I() owner to %I;',
          fn.proname, fn.owner, tbl_owner, sqlerrm, tbl_owner, fn.proname, tbl_owner;
      end;
    end if;
  end loop;

  if not exists (
    select 1
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'lsp_is_admin' and p.prosecdef
  ) then
    raise exception 'lsp_owner_gate_failed: lsp_is_admin() is not SECURITY DEFINER';
  end if;

  raise notice 'lsp: owner gate passed (table owner = %)', tbl_owner;
end $$;


-- ----------------------------------------------------------------------------
-- B2.2 Privileges on the helpers.
-- ----------------------------------------------------------------------------
-- Revoke from PUBLIC and anon explicitly: revoking only anon would leave the
-- implicit PUBLIC grant in place. service_role is granted because it is a
-- trusted backend role that may evaluate the helpers outside an RLS context.
revoke all on function public.lsp_role()         from public, anon;
revoke all on function public.lsp_is_admin()     from public, anon;
revoke all on function public.lsp_provider_ids() from public, anon;

grant execute on function public.lsp_role()         to authenticated, service_role;
grant execute on function public.lsp_is_admin()     to authenticated, service_role;
grant execute on function public.lsp_provider_ids() to authenticated, service_role;


-- ----------------------------------------------------------------------------
-- B3. Role escalation guard on public.profiles — R3.
-- ----------------------------------------------------------------------------
-- WHY A TRIGGER AND NOT A POLICY:
--   RLS is row-scoped, never column-scoped. `using (id = auth.uid())` limits
--   WHICH row may be updated but says nothing about WHICH COLUMNS. No policy can
--   stop PATCH profiles?id=eq.<self> with {"role":"admin"}. A BEFORE trigger is
--   the only place that sees both old and new values.
--
-- WHY current_user AND NOT `auth.uid() is null` (R3):
--   `auth.uid() is null` is NOT proof of a trusted context. It is also null for
--   an `anon` request, and anon would reach this trigger if any write policy or
--   grant admitted it. Trusting it would turn an anon write into a privileged
--   one — the exact hole this migration exists to close.
--   current_user is set by PostgREST from the signed JWT role claim
--   (SET LOCAL ROLE authenticated / anon / service_role). A browser cannot forge
--   it without the project's JWT secret. The classification is therefore:
--       current_user in ('authenticated','anon') -> API request
--       anything else (postgres, supabase_admin, service_role, migrations)
--                                                -> trusted provisioning
--   A10/A10b in Section A provide the evidence about what anon can reach.
--
-- WHY NOT A COLUMN-LEVEL REVOKE:
--   api.js ensureProfile() sends `role` in its UPDATE payload whenever it runs
--   for an account that already has a row (signup retry, a transient failed
--   read, or views that call it directly). Revoking UPDATE(role) would make that
--   statement fail, the error would be swallowed, profile would become null and
--   the session would lose its profile — a login regression. Rejected.
--
-- BEHAVIOUR:
--   * trusted context -> untouched.
--   * anon            -> 42501, always.
--   * authenticated INSERT -> only 'customer'/'provider'; NULL becomes
--     'customer' for the NEW row only; anything else raises 42501.
--   * authenticated UPDATE -> role is immutable. The stored value is kept
--     SILENTLY so profile saves that echo `role` keep succeeding. Existing
--     rows are never modified by this migration itself.
--   * No admin branch on UPDATE, deliberately: if admins could change role from
--     the client, ensureProfile() would demote them on their next login because
--     it sends the metadata role. Privileged role changes go through
--     service_role or the SQL Editor only.

create or replace function public.lsp_guard_profile_role()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  api_role text := current_user;
begin
  if api_role not in ('authenticated', 'anon') then
    return new;                          -- SQL Editor, migrations, service_role
  end if;

  if api_role = 'anon' then
    raise exception 'lsp_write_denied: anonymous sessions cannot write public.profiles'
      using errcode = '42501';
  end if;

  if (select auth.uid()) is null then
    raise exception 'lsp_write_denied: authenticated session without a subject'
      using errcode = '42501';
  end if;

  if tg_op = 'INSERT' then
    if new.role is null then
      new.role := 'customer';            -- NEW row only, never an existing one
    end if;

    if new.role not in ('customer', 'provider') then
      raise exception
        'lsp_role_escalation_blocked: a user cannot create a profile with role %', new.role
        using errcode = '42501';
    end if;

    return new;
  end if;

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
-- policies are NOT touched: the customer and provider modules depend on them.

-- B4.0 provider_profiles INSERT — guarantee a correct definition exists.
--      createProviderProfile() inserts { user_id, business_name, ... }, so the
--      predicate must be on user_id. The live policy already matches this;
--      re-creating it is a no-op there and repairs a database where only the
--      broken schema.sql variant was attempted (which references a non-existent
--      `id` column and therefore creates no policy at all, leaving provider
--      registration denied by RLS).
drop policy if exists lsp_providers_insert on public.provider_profiles;
create policy lsp_providers_insert on public.provider_profiles for insert to authenticated
  with check (
    user_id = (select auth.uid())
    or public.lsp_is_admin()
  );

-- B4.1 profiles INSERT — a self-created profile may never be privileged.
drop policy if exists lsp_profiles_insert on public.profiles;
create policy lsp_profiles_insert on public.profiles for insert to authenticated
  with check (
    id = (select auth.uid())
    and role in ('customer', 'provider')
  );

-- B4.2 provider_profiles UPDATE — real primary key (user_id) plus the admin
--      branch needed for verification decisions.
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
--      themselves. The policy above still lets a provider edit their own row
--      (business name, availability, city...); this pins the one field that
--      decides verification.
--
--      Coercion instead of an exception on INSERT keeps registration working:
--      createProviderProfile() already sends 'pending', and a form submitting
--      'approved' is silently corrected rather than rejected.
create or replace function public.lsp_guard_provider_verification()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  api_role text := current_user;
begin
  if api_role not in ('authenticated', 'anon') then
    return new;
  end if;

  if api_role = 'anon' then
    raise exception 'lsp_write_denied: anonymous sessions cannot write public.provider_profiles'
      using errcode = '42501';
  end if;

  if public.lsp_is_admin() then
    return new;                          -- Admin verification decision
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


-- B4.5 provider_documents status guard — R4.
-- ----------------------------------------------------------------------------
-- Without this, a provider can insert or update their own document row with
-- status 'approved' (the policy is FOR ALL), which makes Admin document review
-- meaningless and lets an unverified provider look verified.
--
-- Preserved on purpose:
--   * INSERT of a document with any non-privileged status (e.g. 'pending',
--     'uploaded') or with no status at all -> allowed, uploads keep working.
--   * UPDATE of file_url, document_type or any other column -> allowed.
--   * Admin INSERT/UPDATE -> allowed, that is the review workflow.
--
-- Blocked:
--   * Provider INSERT claiming 'approved' / 'verified' / 'rejected'
--     -> coerced to 'pending' (no error, so an upload never fails).
--   * Provider UPDATE changing status at all -> pinned to the stored value.
--
-- Only `status` is pinned. Nothing else on the row is touched, so the existing
-- upload and edit flows are unaffected.
create or replace function public.lsp_guard_document_status()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  api_role text := current_user;
begin
  if api_role not in ('authenticated', 'anon') then
    return new;
  end if;

  if api_role = 'anon' then
    raise exception 'lsp_write_denied: anonymous sessions cannot write public.provider_documents'
      using errcode = '42501';
  end if;

  if public.lsp_is_admin() then
    return new;
  end if;

  if tg_op = 'INSERT' then
    if new.status is null or new.status in ('approved', 'verified', 'rejected') then
      new.status := 'pending';
    end if;
    return new;
  end if;

  if new.status is distinct from old.status then
    raise log 'lsp_guard_document_status: blocked % -> % for document %',
      old.status, new.status, old.id;
    new.status := old.status;
  end if;

  return new;
end;
$$;

drop trigger if exists lsp_guard_document_status on public.provider_documents;
create trigger lsp_guard_document_status
  before insert or update on public.provider_documents
  for each row execute function public.lsp_guard_document_status();


-- ----------------------------------------------------------------------------
-- B5. OPTIONAL hardening — review before enabling.
-- ----------------------------------------------------------------------------
-- Supabase grants CREATE on schema public to anon/authenticated by default.
-- With that grant a signed-in user could create a function that shadows an
-- unqualified call inside a SECURITY DEFINER function. This migration already
-- defends by pinning search_path and schema-qualifying every reference, so this
-- is defence in depth, not a prerequisite.
--
-- Uncomment ONLY after confirming the app never creates database objects at
-- runtime (it does not):
--
-- revoke create on schema public from anon, authenticated;


-- ----------------------------------------------------------------------------
-- B6. DOCUMENTED, NOT CHANGED — public.services write policy, with the secure
--     future design (R5).
-- ----------------------------------------------------------------------------
-- CURRENT LIVE DEFINITION (from allow-authorized-writes.sql, section 8):
--
--     create policy lsp_services_write on public.services for all
--       to authenticated using (true) with check (true);
--
-- It came from the earlier request to let every authorized user add details to
-- the database. The risk is real but bounded: any signed-in user, including a
-- customer, can insert a junk catalogue row, rewrite any entry, or delete the
-- catalogue. It does NOT expose bookings, profiles, payments or documents.
--
-- WHY IT IS NOT CHANGED IN PHASE 0:
--   * Owner-scoping is impossible on the live table: `services` is
--     (id, name, description, category_id, is_active) with NO provider_id.
--   * An admin-only policy is the correct end state, but only if no provider
--     flow writes `services`. Provider service management is stored in
--     `provider_skills` (provider_id + category_id), which is already
--     owner-scoped through lsp_provider_ids(), so this is very likely safe —
--     but "very likely" is not evidence, and A8 plus a code check is required
--     first.
--
-- SECURE FUTURE DESIGN (apply in a later phase, after verifying the above):
--
--     -- 1. Split the single FOR ALL policy into explicit, least-privilege ones.
--     drop policy if exists lsp_services_write on public.services;
--
--     -- 2. Everyone signed in may read the catalogue.
--     create policy lsp_services_read on public.services for select
--       to authenticated using (true);
--
--     -- 3. Only an admin may modify the shared catalogue.
--     create policy lsp_services_admin_write on public.services for all
--       to authenticated
--       using      (public.lsp_is_admin())
--       with check (public.lsp_is_admin());
--
--     -- 4. anon keeps read-only visibility only if the storefront needs it:
--     --    create policy lsp_services_anon_read on public.services for select
--     --      to anon using (true);
--
-- PRE-CONDITIONS before applying that design (both must be evidenced):
--   (a) A8 shows the live policy is still the permissive FOR ALL one.
--   (b) A repository search proves no customer or provider flow writes
--       `services` (provider catalogue work goes through `provider_skills`).
--   If (b) cannot be proven, add a provider_id column to `services` and scope
--   writes with `provider_id = auth.uid()` instead — but that is a schema change
--   and needs its own justification and approval.

commit;


-- ============================================================================
-- SECTION C — POST-MIGRATION CHECKS (READ-ONLY)
-- ============================================================================

-- C1. Helpers exist, are SECURITY DEFINER, pin search_path, and are owned by
--     the SAME role that owns public.profiles (the RLS-bypass requirement).
select p.proname,
       p.proowner::regrole as owner,
       p.prosecdef         as security_definer,
       p.proconfig         as pinned_settings,
       (p.proowner = (select relowner from pg_class
                      where oid = 'public.profiles'::regclass)) as owner_matches_profiles
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname like 'lsp\_%'
order by p.proname;

-- C2. All guards are installed as BEFORE ROW triggers (expect four).
select c.relname, t.tgname, pg_get_triggerdef(t.oid)
from pg_trigger t
join pg_class c on c.oid = t.tgrelid
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and t.tgname like 'lsp\_guard%'
order by t.tgname;

-- C3. Recreated policies have the expected shape. lsp_providers_insert and
--     lsp_providers_update must reference user_id, never `id`.
select tablename, policyname, cmd, roles, qual, with_check
from pg_policies
where schemaname = 'public'
  and policyname in ('lsp_providers_insert', 'lsp_providers_update',
                     'lsp_profiles_insert', 'lsp_documents_owner')
order by policyname;

-- C4. Exactly one admin exists (after Phase 1 provisioning).
select id, email, role from public.profiles where role = 'admin';

-- C5. Execute privileges: authenticated + service_role only. Expect NO row for
--     anon and NO row for PUBLIC.
select p.proname, a.grantee::text as grantee, a.privilege_type
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
cross join lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
where n.nspname = 'public' and p.proname like 'lsp\_%'
order by p.proname, grantee;

-- C6. The constraint exists and is still NOT VALID (no existing row scanned or
--     rewritten).
select conname, convalidated, pg_get_constraintdef(oid) as definition
from pg_constraint
where conname = 'profiles_role_allowed';

-- C7. Role and document status distribution after the migration. These MUST
--     match the A3/A11 numbers: this migration modifies no existing row.
select coalesce(role, '(null)') as role, count(*) as accounts
from public.profiles group by role order by accounts desc;

select coalesce(status, '(null)') as status, count(*) as documents
from public.provider_documents group by status order by documents desc;


-- ============================================================================
-- SECTION D — ROLLBACK (only if a real regression appears)
-- ----------------------------------------------------------------------------
-- Order matters: policies are recreated FIRST so nothing references a function
-- that is about to disappear. No data is touched: this migration never modified
-- a row.
-- ============================================================================
/*
begin;

drop trigger if exists lsp_guard_document_status         on public.provider_documents;
drop trigger if exists lsp_guard_provider_verification   on public.provider_profiles;
drop trigger if exists lsp_guard_profile_role            on public.profiles;

drop function if exists public.lsp_guard_document_status();
drop function if exists public.lsp_guard_provider_verification();
drop function if exists public.lsp_guard_profile_role();

alter table public.profiles drop constraint if exists profiles_role_allowed;

-- Restore the original policy definitions (from allow-authorized-writes.sql):
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
