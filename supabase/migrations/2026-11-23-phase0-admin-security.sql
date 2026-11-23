-- ============================================================================
-- LSP CONNECT — PHASE 0: ADMIN SECURITY FOUNDATION
-- STATUS: PROPOSAL ONLY — REVISION 5 — NOT APPLIED — NOTHING EXECUTED
--
-- REVISION 5 CHANGES (this review round)
--   1. C7 uses count(*) throughout. Verified: the file contains no bare count()
--      (grep 'count()' returns nothing; every aggregate is count(*)).
--   2. C2 now expects THREE guard triggers, matching the three triggers Section D
--      drops. Section B0 lists every object the migration creates; C8 prints that
--      inventory so the rollback coverage is checkable, not asserted.
--   3. C4 is a report only. Phase 0 neither creates nor requires an admin account;
--      zero admins is a valid Phase 0 result.
--   4. Section D contains no block-comment delimiters. D.1 is fully line-commented
--      (prefix -- on every line) so nothing stray reaches the parser.
--   5. A0 now captures function definitions, owners, ACLs, configuration flags,
--      policies, triggers and table privileges BEFORE the migration. Section D is
--      explicitly NOT automatic and states exactly what must be restored by hand.
--   6. S5 tests the role gate with roles that actually hold table privileges, so
--      the test proves the trigger rather than the grants (see test plan).
--   7. S10/S11 carry a full truth table for the document guard.
--   8. S13 covers every related table, grounded in supabase/allow-authorized-writes.sql.
--   9. No authentication setting is changed anywhere. Email confirmation stays ON;
--      the authenticated tests stay unexecuted until you confirm accounts yourself.
--
-- RUN ORDER: A (capture + inspect, read-only) -> B (one transaction) -> C (verify)
--            D only if a regression appears. Run in the Supabase SQL Editor as the
--            project owner. Never from a browser, never with the anon key.
--
-- SAFETY: idempotent, additive, fail closed (every gate raises, so a partial
--         security migration is impossible), no drops of tables/columns/data, no
--         deletes, no RLS weakening, no authentication change.
-- ============================================================================


-- ============================================================================
-- SECTION A — CAPTURE AND INSPECT (READ-ONLY)
-- ============================================================================

-- A0. CAPTURE BEFORE MIGRATING — FUNCTIONS.
--     Save this output. Section D can only restore what A0 records: the body, the
--     owner, the ACL, the configuration flags and the SECURITY DEFINER bit.
--     A helper that returns no row here did not exist before this migration.
select p.proname,
       pg_get_userbyid(p.proowner)          as owner,
       p.prosecdef                          as security_definer,
       p.proconfig                          as pinned_settings,
       p.proacl                             as acl,
       pg_get_functiondef(p.oid)            as definition
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname like 'lsp\_%'
order by p.proname;

-- A0b. CAPTURE BEFORE MIGRATING — POLICIES (full text, all commands).
select tablename, policyname, permissive, roles, cmd, qual, with_check
from pg_policies
where schemaname = 'public' and policyname like 'lsp\_%'
order by tablename, policyname;

-- A0c. CAPTURE BEFORE MIGRATING — TRIGGERS on the three tables this migration
--      touches. A pre-existing trigger with a name this migration reuses must be
--      restored from this output.
select c.relname as table_name, t.tgname, t.tgenabled,
       pg_get_triggerdef(t.oid) as definition
from pg_trigger t join pg_class c on c.oid = t.tgrelid
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and not t.tgisinternal
  and c.relname in ('profiles','provider_profiles','provider_documents')
order by c.relname, t.tgname;

-- A0d. CAPTURE BEFORE MIGRATING — table privileges, PUBLIC and inheritance
--      included (has_table_privilege resolves both).
select c.relname,
       has_table_privilege('anon',          c.oid, 'SELECT') as anon_select,
       has_table_privilege('anon',          c.oid, 'INSERT') as anon_insert,
       has_table_privilege('authenticated', c.oid, 'INSERT') as auth_insert,
       has_table_privilege('authenticated', c.oid, 'UPDATE') as auth_update,
       has_table_privilege('authenticated', c.oid, 'DELETE') as auth_delete
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relkind = 'r'
order by c.relname;

-- A1. Every policy on the public schema. Non-lsp_* rows are outside this
--     migration and must be reviewed manually.
select tablename, policyname, cmd, roles, qual, with_check
from pg_policies where schemaname = 'public' order by tablename, policyname;

-- A2. relforcerowsecurity MUST be false on public.profiles, otherwise B2.1 aborts.
select c.relname, c.relrowsecurity as rls_enabled, c.relforcerowsecurity as rls_forced
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relkind = 'r' order by c.relname;

-- A3. Role distribution (count(*) explicit) and the NULL/invalid totals.
select coalesce(role, '(null)') as role, count(*) as accounts
from public.profiles group by role order by accounts desc;

select count(*) as total_profiles,
       count(*) filter (where role is null) as null_roles,
       count(*) filter (where role not in ('customer','provider','admin')) as invalid_roles
from public.profiles;

-- A4. Helpers: owner, SECURITY DEFINER flag, pinned settings.
select p.proname, p.proowner::regrole as owner, p.prosecdef as security_definer,
       p.proconfig as pinned_settings
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname like 'lsp\_%' order by p.proname;

-- A4b. The role B2.1 will assign: the owner of public.profiles.
select c.relname, r.rolname as table_owner
from pg_class c join pg_roles r on r.oid = c.relowner
where c.oid = 'public.profiles'::regclass;

-- A4c. Who is executing this script, and can it reassign ownership?
--      Expect current_user = postgres and table_owner = postgres.
--      pg_has_role is false for a role that cannot SET ROLE to the table owner,
--      which is exactly when B2.1's ALTER FUNCTION would fail.
select current_user as executing_role,
       session_user as login_role,
       version() as server,
       (select r.rolname from pg_class c join pg_roles r on r.oid = c.relowner
        where c.oid = 'public.profiles'::regclass) as table_owner,
       pg_has_role(current_user,
                   (select r.rolname from pg_class c join pg_roles r on r.oid = c.relowner
                    where c.oid = 'public.profiles'::regclass),
                   'USAGE') as can_set_role_to_owner;

-- A5. Column privileges on profiles — if UPDATE on `role` appears, escalation is reachable.
select grantee, privilege_type, column_name
from information_schema.column_privileges
where table_schema = 'public' and table_name = 'profiles'
  and grantee in ('anon','authenticated')
order by grantee, privilege_type, column_name;

-- A6. Existing non-internal triggers across the public schema.
select c.relname as table_name, t.tgname, pg_get_triggerdef(t.oid) as definition
from pg_trigger t join pg_class c on c.oid = t.tgrelid
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and not t.tgisinternal order by c.relname, t.tgname;

-- A7. Provider INSERT policy. Expect lsp_providers_insert keyed on user_id.
--     No row => provider registration is denied by RLS and B4.0 is required.
select policyname, cmd, roles, qual, with_check
from pg_policies where schemaname = 'public' and tablename = 'provider_profiles'
order by policyname;

-- A8. Services policy. Expect the permissive FOR ALL (using true / check true).
select policyname, cmd, roles, qual, with_check
from pg_policies where schemaname = 'public' and tablename = 'services'
order by policyname;

-- A9. Legacy NULL/invalid roles. REPORTED ONLY — never rewritten by this migration.
select id, email, role from public.profiles
where role is null or role not in ('customer','provider','admin')
order by role nulls first, email;

-- A10b. Any non-SELECT policy whose roles include anon or PUBLIC. A row here means
--       an unauthenticated session can reach a write path.
select tablename, policyname, cmd, roles from pg_policies
where schemaname = 'public' and cmd <> 'SELECT'
  and (roles::text like '%anon%' or roles::text = '{public}')
order by tablename, policyname;

-- A10c. Column-level probes on profiles (PUBLIC- and inheritance-aware).
select has_table_privilege('anon','public.profiles','INSERT') as anon_insert,
       has_table_privilege('anon','public.profiles','UPDATE') as anon_update,
       has_table_privilege('anon','public.profiles','DELETE') as anon_delete,
       has_column_privilege('anon','public.profiles','role','UPDATE') as anon_update_role,
       has_column_privilege('authenticated','public.profiles','role','UPDATE') as auth_update_role,
       has_function_privilege('anon','public.lsp_is_admin()','EXECUTE') as anon_exec_after,
       has_function_privilege('authenticated','public.lsp_is_admin()','EXECUTE') as auth_exec_after;

-- A11. Documents/skills policies and the document status distribution.
select tablename, policyname, cmd, roles, qual, with_check from pg_policies
where schemaname = 'public' and tablename in ('provider_documents','provider_skills')
order by tablename, policyname;

-- A11b. The real columns of provider_documents. B4.5 diffs the whole row as jsonb
--       and excludes only 'status' and 'updated_at'; if another column is
--       auto-maintained on every update, add it to that exclusion. The live table
--       as created by allow-authorized-writes.sql has id, provider_id,
--       document_type, file_url, status, created_at — no updated_at, so removing
--       that key is a no-op.
select column_name, data_type, is_nullable, column_default
from information_schema.columns
where table_schema = 'public' and table_name = 'provider_documents'
order by ordinal_position;

select coalesce(status,'(null)') as status, count(*) as documents
from public.provider_documents group by status order by documents desc;

-- A12. The write matrix per table — the ground truth for the S13 authorization
--      tests. Read this before interpreting any S13 result.
select tablename, policyname, cmd, roles
from pg_policies
where schemaname = 'public' and cmd in ('INSERT','UPDATE','ALL','DELETE')
order by tablename, policyname;


-- ============================================================================
-- SECTION B — MIGRATION (one transaction; any failure rolls back everything)
-- ----------------------------------------------------------------------------
-- B0. OBJECT INVENTORY. This migration creates or replaces exactly:
--       constraint  profiles_role_allowed                         (B1, 1)
--       functions   lsp_role, lsp_is_admin, lsp_provider_ids      (B2, 3 replaced)
--       trigger     lsp_guard_profile_role   on profiles          (B3, 1)
--       policies    lsp_providers_insert, lsp_profiles_insert,
--                   lsp_providers_update, lsp_documents_owner     (B4, 4 replaced)
--       trigger     lsp_guard_provider_verification on provider_profiles (B4.4, 1)
--       trigger     lsp_guard_document_status on provider_documents      (B4.5, 1)
--     Totals: 3 triggers, 3 guard functions, 4 policies, 1 constraint,
--     3 helper functions replaced in place. No fourth trigger exists: Phase 0
--     installs nothing on bookings, customer_addresses or notifications.
--     Section D must therefore drop 3 + 3 + 4 + 1 objects and restore 3 helpers.
-- ============================================================================

begin;

-- B1. Role vocabulary. profiles.role is plain text with no constraint (there is
--     no app_role enum). NOT VALID scans nothing, rejects nothing and rewrites
--     nothing on apply, but is enforced for every later INSERT/UPDATE. A CHECK
--     passes on NULL, so B3 handles NULL for new rows. Consequence: a legacy row
--     holding an out-of-range value becomes un-editable (23514) until you fix it
--     deliberately. A9 lists those rows first.
do $$
begin
  if not exists (select 1 from pg_constraint
                 where conname = 'profiles_role_allowed'
                   and conrelid = 'public.profiles'::regclass) then
    alter table public.profiles
      add constraint profiles_role_allowed
      check (role in ('customer','provider','admin')) not valid;
  end if;
end $$;

-- B2. Authorization helpers. SECURITY DEFINER is required: they are called from
--     policies ON profiles, and a SECURITY INVOKER read would re-enter that
--     policy (42P17). search_path pinned, every name schema-qualified, stable,
--     and they return only the caller's own status.
create or replace function public.lsp_role()
returns text language sql stable security definer
set search_path = pg_catalog, public as $$
  select p.role from public.profiles p where p.id = (select auth.uid());
$$;

create or replace function public.lsp_is_admin()
returns boolean language sql stable security definer
set search_path = pg_catalog, public as $$
  select exists (select 1 from public.profiles p
                 where p.id = (select auth.uid()) and p.role = 'admin');
$$;

create or replace function public.lsp_provider_ids()
returns setof uuid language sql stable security definer
set search_path = pg_catalog, public as $$
  select pp.user_id from public.provider_profiles pp
  where pp.user_id = (select auth.uid());
$$;

-- B2.1 OWNER GATE. CREATE OR REPLACE never changes an existing function's owner,
--      and a SECURITY DEFINER function bypasses RLS only when its owner is the
--      table owner (or has BYPASSRLS). Otherwise every policy caller fails with
--      42P17 — a total outage. Ownership is established and verified here, and
--      any failure aborts the whole transaction.
do $$
declare
  tbl_owner text;
  fn        record;
begin
  select r.rolname into tbl_owner
  from pg_class c join pg_roles r on r.oid = c.relowner
  where c.oid = 'public.profiles'::regclass;

  if tbl_owner is null then
    raise exception 'lsp_owner_gate_failed: public.profiles not found';
  end if;

  if exists (select 1 from pg_class
             where oid = 'public.profiles'::regclass and relforcerowsecurity) then
    raise exception 'lsp_owner_gate_failed: FORCE ROW LEVEL SECURITY is on for public.profiles; a SECURITY DEFINER helper cannot bypass forced RLS (42P17). Run: alter table public.profiles no force row level security;';
  end if;

  if not pg_has_role(current_user, tbl_owner, 'USAGE') then
    raise exception 'lsp_owner_gate_failed: this session (%) cannot SET ROLE to % (the owner of public.profiles). Run the script as %.', current_user, tbl_owner, tbl_owner;
  end if;

  for fn in
    select p.proname, pg_get_userbyid(p.proowner) as owner
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('lsp_role','lsp_is_admin','lsp_provider_ids')
  loop
    if fn.owner <> tbl_owner then
      begin
        execute format('alter function public.%I() owner to %I', fn.proname, tbl_owner);
        raise notice 'lsp: % owner reassigned % -> %', fn.proname, fn.owner, tbl_owner;
      exception when others then
        raise exception 'lsp_owner_gate_failed: public.% is owned by % but must be owned by %. Reassignment failed: %. Run manually: alter function public.%I() owner to %I;',
          fn.proname, fn.owner, tbl_owner, sqlerrm, fn.proname, tbl_owner;
      end;
    end if;
  end loop;

  if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                 where n.nspname = 'public' and p.proname = 'lsp_is_admin' and p.prosecdef) then
    raise exception 'lsp_owner_gate_failed: lsp_is_admin() is not SECURITY DEFINER';
  end if;

  raise notice 'lsp: owner gate passed (table owner = %)', tbl_owner;
end $$;

-- B2.2 Privileges on the helpers. Revoke from PUBLIC as well as anon: revoking
--      only anon would leave the implicit PUBLIC grant in place.
revoke all on function public.lsp_role()         from public, anon;
revoke all on function public.lsp_is_admin()     from public, anon;
revoke all on function public.lsp_provider_ids() from public, anon;
grant execute on function public.lsp_role()         to authenticated, service_role;
grant execute on function public.lsp_is_admin()     to authenticated, service_role;
grant execute on function public.lsp_provider_ids() to authenticated, service_role;

-- B3. Role escalation guard on public.profiles.
--     RLS is row-scoped, never column-scoped: no policy can stop a self-update of
--     {"role":"admin"}. Only a BEFORE trigger sees old and new values.
--     The trusted-role test is an ALLOWLIST over current_user, which PostgREST
--     sets from the signed JWT role claim and a browser cannot forge. Any role not
--     named below and not 'authenticated' is rejected — fail closed. The test is
--     role IDENTITY, not privilege: inheriting service_role's privileges does not
--     make current_user trusted, so membership cannot launder an unknown role.
--     Role is immutable on UPDATE (silently kept, so profile saves that echo
--     `role` keep working, which is what api.js ensureProfile() does). No admin
--     branch: a client-supplied role change could demote an admin on next login.
create or replace function public.lsp_guard_profile_role()
returns trigger language plpgsql security invoker
set search_path = pg_catalog, public as $$
declare
  api_role text := current_user;
  trusted  constant text[] := array['postgres','supabase_admin','supabase_storage_admin','supabase_auth_admin','service_role'];
begin
  if api_role = any (trusted) then
    return new;                                        -- SQL Editor, migrations, service_role
  end if;

  if api_role <> 'authenticated' then
    raise exception 'lsp_write_denied: role % may not write public.profiles', api_role
      using errcode = '42501';                         -- anon and any unknown role
  end if;

  if (select auth.uid()) is null then
    raise exception 'lsp_write_denied: authenticated session without a subject'
      using errcode = '42501';
  end if;

  if tg_op = 'INSERT' then
    if new.role is null then
      new.role := 'customer';                          -- new row only
    end if;
    if new.role not in ('customer','provider') then
      raise exception 'lsp_role_escalation_blocked: cannot create a profile with role %', new.role
        using errcode = '42501';
    end if;
    return new;
  end if;

  if new.role is distinct from old.role then
    raise log 'lsp_guard_profile_role: blocked % -> % for profile %', old.role, new.role, new.id;
    new.role := old.role;
  end if;
  return new;
end $$;

drop trigger if exists lsp_guard_profile_role on public.profiles;
create trigger lsp_guard_profile_role before insert or update on public.profiles
  for each row execute function public.lsp_guard_profile_role();

-- B4. Policies. Each is recreated equal-or-stricter. bookings, customer_addresses,
--     notifications, booking_photos, quotations, payments, reviews, complaints,
--     service_categories and the provider_profiles SELECT policy are NOT touched.
--     B4.0 provider_profiles INSERT on the real key (user_id; there is no id column).
--     Re-creating it is a no-op where the live policy is already correct and
--     repairs a database where only the schema.sql variant was attempted (that one
--     references a non-existent `id` and therefore creates no policy at all).
drop policy if exists lsp_providers_insert on public.provider_profiles;
create policy lsp_providers_insert on public.provider_profiles for insert to authenticated
  with check (user_id = (select auth.uid()) or public.lsp_is_admin());

-- B4.1 profiles INSERT: a self-created profile may never be privileged.
drop policy if exists lsp_profiles_insert on public.profiles;
create policy lsp_profiles_insert on public.profiles for insert to authenticated
  with check (id = (select auth.uid()) and role in ('customer','provider'));

-- B4.2 provider_profiles UPDATE on user_id, with the admin branch verification needs.
drop policy if exists lsp_providers_update on public.provider_profiles;
create policy lsp_providers_update on public.provider_profiles for update to authenticated
  using (user_id = (select auth.uid()) or public.lsp_is_admin())
  with check (user_id = (select auth.uid()) or public.lsp_is_admin());

-- B4.3 provider_documents: provider owns their rows, admin may review all.
--     DELIBERATE TIGHTENING vs the live policy, which is
--       using (provider_id = auth.uid() or public.lsp_is_admin())
--     lsp_provider_ids() returns the caller's provider_profiles rows, so a signed-in
--     user WITHOUT a provider_profiles row can no longer create a document row.
--     If your provider registration uploads a document before inserting
--     provider_profiles, keep the live predicate instead:
--       using (provider_id = auth.uid() or public.lsp_is_admin())
--       with check (provider_id = auth.uid() or public.lsp_is_admin())
--     The B4.5 guard still prevents self-approval either way.
drop policy if exists lsp_documents_owner on public.provider_documents;
create policy lsp_documents_owner on public.provider_documents for all to authenticated
  using (provider_id in (select public.lsp_provider_ids()) or public.lsp_is_admin())
  with check (provider_id in (select public.lsp_provider_ids()) or public.lsp_is_admin());

-- B4.4 Verification guard: a provider must not approve themselves. The policy
--      above still lets them edit their own row; this pins only the deciding field.
--      Coercion (not an error) on INSERT keeps registration working.
create or replace function public.lsp_guard_provider_verification()
returns trigger language plpgsql security invoker
set search_path = pg_catalog, public as $$
declare
  api_role text := current_user;
  trusted  constant text[] := array['postgres','supabase_admin','supabase_storage_admin','supabase_auth_admin','service_role'];
begin
  if api_role = any (trusted) then
    return new;
  end if;
  if api_role <> 'authenticated' then
    raise exception 'lsp_write_denied: role % may not write public.provider_profiles', api_role
      using errcode = '42501';
  end if;
  if public.lsp_is_admin() then
    return new;                                        -- admin verification decision
  end if;

  if tg_op = 'INSERT' then
    if new.verification_status in ('approved','verified') then
      new.verification_status := 'pending';
    end if;
    return new;
  end if;

  if new.verification_status is distinct from old.verification_status then
    raise log 'lsp_guard_provider_verification: blocked % -> % for %',
      old.verification_status, new.verification_status, new.user_id;
    new.verification_status := old.verification_status;
  end if;
  return new;
end $$;

drop trigger if exists lsp_guard_provider_verification on public.provider_profiles;
create trigger lsp_guard_provider_verification before insert or update on public.provider_profiles
  for each row execute function public.lsp_guard_provider_verification();

-- B4.5 Document guard. Without it a provider can mark their own document
--      'approved' (the policy is FOR ALL), which makes admin review meaningless.
--      PRESERVED for a provider: uploads, metadata edits, any non-privileged
--      status value, and any edit to a document that is not approved/verified.
--      PINNED: status itself, provider_id (ownership), and — on an already
--      approved/verified document — any substantive edit, which resets status to
--      'pending' so changed evidence is reviewed again.
--      The diff is taken over the whole row as jsonb, so it needs no column names
--      and cannot fail on a schema difference; only 'status' and 'updated_at' are
--      excluded (removing a key that does not exist is a no-op). The reset path
--      returns immediately, so the later status pin cannot undo it.
--      Admin and trusted roles return before the pin, so an admin may reassign
--      ownership and set any status — that is the intended review path.
create or replace function public.lsp_guard_document_status()
returns trigger language plpgsql security invoker
set search_path = pg_catalog, public as $$
declare
  api_role text := current_user;
  trusted  constant text[] := array['postgres','supabase_admin','supabase_storage_admin','supabase_auth_admin','service_role'];
begin
  if api_role = any (trusted) then
    return new;
  end if;
  if api_role <> 'authenticated' then
    raise exception 'lsp_write_denied: role % may not write public.provider_documents', api_role
      using errcode = '42501';
  end if;
  if public.lsp_is_admin() then
    return new;
  end if;

  if tg_op = 'INSERT' then
    if new.status is null or new.status in ('approved','verified','rejected') then
      new.status := 'pending';                         -- no self-approval on upload
    end if;
    return new;
  end if;

  new.provider_id := old.provider_id;                  -- ownership is immutable

  if old.status in ('approved','verified')
     and (to_jsonb(new) - 'status' - 'updated_at')
         is distinct from (to_jsonb(old) - 'status' - 'updated_at') then
    new.status := 'pending';                           -- evidence changed: re-review
    raise log 'lsp_guard_document_status: document % reset to pending after edit', old.id;
    return new;
  end if;

  if new.status is distinct from old.status then
    raise log 'lsp_guard_document_status: blocked % -> % for document %',
      old.status, new.status, old.id;
    new.status := old.status;
  end if;
  return new;
end $$;

drop trigger if exists lsp_guard_document_status on public.provider_documents;
create trigger lsp_guard_document_status before insert or update on public.provider_documents
  for each row execute function public.lsp_guard_document_status();

-- B5. OPTIONAL hardening — review before enabling. Supabase grants CREATE on
--     schema public by default; B2/B3 already defend via pinned search_path and
--     schema-qualified names, so this is defence in depth.
-- revoke create on schema public from anon, authenticated;

-- B6. DOCUMENTED, NOT CHANGED — public.services. Current live definition:
--       create policy lsp_services_write on public.services for all
--         to authenticated using (true) with check (true);
--     Any signed-in user can insert, rewrite or delete catalogue rows. It does not
--     expose bookings, profiles, payments or documents. Owner-scoping is
--     impossible on the live table (no provider_id column; allow-authorized-writes
--     only adds it when missing, and the live project does not have it), and
--     provider catalogue work lives in provider_skills, which is owner-scoped.
--     SECURE FUTURE DESIGN (later phase, after both pre-conditions hold):
--       drop policy if exists lsp_services_write on public.services;
--       create policy lsp_services_read on public.services for select
--         to authenticated using (true);
--       create policy lsp_services_admin_write on public.services for all
--         to authenticated using (public.lsp_is_admin())
--         with check (public.lsp_is_admin());
--     PRE-CONDITIONS: (a) A8/A12 show the permissive policy is still live;
--     (b) a repository check proves no customer or provider flow writes
--     `services`. If (b) cannot be proven, add provider_id and scope writes with
--     provider_id = auth.uid() — a schema change needing its own approval.

commit;
