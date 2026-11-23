-- ============================================================================
-- LSP CONNECT — PHASE 0: ADMIN SECURITY FOUNDATION
-- STATUS: PROPOSAL ONLY — REVISION 6 — NOT APPLIED — NOTHING EXECUTED
--
-- REVISION 6 CHANGES (this review round)
--   1. Section C syntax defects fixed. Section C as delivered in revision 5
--      contained four real errors, all introduced while transcribing it:
--        - 'scheman'        -> 'schemaname'  (C3)
--        - 'acl_default'    -> 'acldefault'  (C5; correct spelling has no underscore)
--        - 'coallesce'      -> 'coalesce'    (C7, both queries)
--        - zero-argument aggregate calls   -> count(*)  (C2, C4, C7, C8)
--      Also fixed in Section D: the rollback named a trigger that does not exist
--      ('lsp_guard_profiles_role' instead of 'lsp_guard_profile_role') and
--      contained the misspelling 'grant exceute'. Every statement below has been
--      re-read for valid PostgreSQL; C5 also no longer casts grantee 0 to regrole,
--      which would have raised for PUBLIC.
--   2. S5 redesigned with a positive control, so a 42501 can only be attributed to
--      the trigger: the test role receives real table privileges, EXECUTE on the
--      function the live policy calls, and the JWT subject of the target row, and
--      it must first succeed on a benign column update (proving grants and RLS let
--      the row through). Only then is the role change attempted.
--   3. D.2 now separates persisted data changes from attempts the guard rejected
--      in memory, and states for every object whether A0/A0b/A0c can restore it.
--   4. C8 validates the count instead of asserting it: GROUP BY ROLLUP prints the
--      per-kind counts and the total (11 created), and C8b lists the 3 replaced
--      helpers that are deliberately NOT part of the 11 and NOT dropped.
--   5. The four known exposures are preserved verbatim in the limitations list.
--   6. Nothing executed, no authentication setting changed, no account created,
--      no frontend file touched, nothing deployed.
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
--     Save this output; Section D restores only what is recorded here: body,
--     owner, ACL, configuration flags and the SECURITY DEFINER bit.
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

-- A0b. CAPTURE BEFORE MIGRATING — POLICIES. permissive, roles, cmd, qual and
--      with_check together are everything needed to recreate a policy exactly.
select tablename, policyname, permissive, roles, cmd, qual, with_check
from pg_policies
where schemaname = 'public' and policyname like 'lsp\_%'
order by tablename, policyname;

-- A0c. CAPTURE BEFORE MIGRATING — TRIGGERS on the three tables this migration
--      touches, including tgenabled. A pre-existing trigger whose name this
--      migration reuses must be restored from this output.
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

-- A3. Role distribution and the NULL/invalid totals.
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
--       and excludes only 'status' and 'updated_at'. The live table created by
--       allow-authorized-writes.sql has id, provider_id, document_type, file_url,
--       status, created_at — no updated_at, so removing that key is a no-op.
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
-- ============================================================================

begin;

-- B0. OBJECT INVENTORY — everything this migration creates, and therefore
--     everything Section D must undo. C8 re-derives this from the catalogue.
--       CREATED  3 triggers   lsp_guard_profile_role         on public.profiles
--                             lsp_guard_provider_verification on public.provider_profiles
--                             lsp_guard_document_status       on public.provider_documents
--       CREATED  3 functions  the three guard functions above
--       CREATED  4 policies   lsp_providers_insert, lsp_providers_update,
--                             lsp_profiles_insert, lsp_documents_owner
--       CREATED  1 constraint profiles_role_allowed
--                             = 11 created objects (C8 validates this total)
--       REPLACED 3 functions  lsp_role, lsp_is_admin, lsp_provider_ids
--                             (may pre-exist; A0 captured their previous bodies)
--     The 3 replaced helpers are deliberately NOT part of the 11 and are NOT
--     dropped by D.1 — many policies call them. C8b reports them separately.

-- B1. Role vocabulary. profiles.role is plain text with no constraint (there is
--     no app_role enum). NOT VALID scans nothing, rejects nothing and rewrites
--     nothing on apply, but is enforced for every later INSERT/UPDATE. A CHECK
--     passes on NULL, so B3 handles NULL for new rows. Consequence: a legacy row
--     holding an out-of-range value becomes un-editable (23514) until you fix it
--     deliberately. A9 lists those rows first; none is modified here.
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

-- B3. ROLE ESCALATION GUARD (public.profiles).
--     RLS is row-scoped, never column-scoped: no policy can stop a self-update of
--     {"role":"admin"}. Only a BEFORE trigger sees old and new values.
--
--     THE GATE: trusted is an ALLOWLIST of the roles Supabase actually uses for
--     privileged paths. Everything else must be 'authenticated' with a real JWT
--     subject, or it is rejected with 42501.
--
--     Why current_user and not a request header: PostgREST sets the session role
--     from the *signed* JWT `role` claim, so current_user cannot be forged from a
--     browser. `authenticator` is the login role PostgREST switches away from
--     before running any statement — it never executes DML itself, and if it did,
--     it is absent from the allowlist and is not 'authenticated', so it is
--     rejected. The same holds for any custom or future role: absent from the
--     allowlist means denied, which is the fail-closed polarity an earlier
--     revision lacked.
--
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
--     notifications and the provider_profiles SELECT policy are NOT touched.
--     B4.0 provider_profiles INSERT on the real key (user_id; there is no id
--     column). Re-creating it is a no-op where the live policy is already correct
--     and repairs a database where only the schema.sql variant was attempted (that
--     one references a non-existent `id` and therefore creates no policy at all).
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
--      DELIBERATE TIGHTENING, flagged for review: the live policy reads
--        provider_id = auth.uid() or lsp_is_admin()
--      so any signed-in user — including one with no provider_profiles row — can
--      create a document row stamped with their own uid. lsp_provider_ids()
--      requires an actual provider_profiles row, which is the correct ownership
--      test. If your provider registration uploads a document BEFORE creating
--      provider_profiles, use the live predicate instead:
--        using (provider_id = (select auth.uid()) or public.lsp_is_admin())
--        with check (provider_id = (select auth.uid()) or public.lsp_is_admin())
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

-- B4.5 DOCUMENT GUARD. Without it a provider can mark their own document
--      'approved' (the policy is FOR ALL), which makes admin review meaningless.
--      PRESERVED: uploads, metadata edits (document_type, file_url) on documents
--      that are pending/rejected, any non-privileged status, and the whole admin
--      path — the admin check returns before any pinning.
--      PINNED: status itself, provider_id (ownership is immutable), and — on an
--      already approved/verified document — any substantive edit, which resets
--      status to 'pending' so changed evidence is reviewed again.
--      The diff is taken over the whole row as jsonb, so it needs no column names
--      and cannot fail on a schema difference; only 'status' and 'updated_at' are
--      excluded, and removing a key that does not exist is a no-op. The live table
--      has no updated_at (see A11b). Order matters: the reset returns early, so the
--      later status pin cannot undo it.
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
--     impossible on the live table (no provider_id column), and provider
--     catalogue work lives in provider_skills, which is already owner-scoped.
--     SECURE FUTURE DESIGN (later phase, after both pre-conditions hold):
--       drop policy if exists lsp_services_write on public.services;
--       create policy lsp_services_read on public.services for select
--         to authenticated using (true);
--       create policy lsp_services_admin_write on public.services for all
--         to authenticated using (public.lsp_is_admin())
--         with check (public.lsp_is_admin());
--     PRE-CONDITIONS: (a) A8 shows the permissive policy is still live;
--     (b) a repository check proves no customer or provider flow writes
--     `services`. If (b) cannot be proven, add provider_id and scope writes with
--     provider_id = auth.uid() — a schema change needing its own approval.

commit;


-- ============================================================================
-- SECTION C — POST-MIGRATION VERIFICATION (READ-ONLY)
-- ----------------------------------------------------------------------------
-- Every statement below was re-read for valid PostgreSQL. Aggregates are all
-- count(*); the catalogue columns are schemaname / tablename / policyname; the
-- ACL helper is acldefault (no underscore); coalesce is spelled coalesce.
-- No statement in this section writes, and none raises, so the whole batch runs
-- even when a check fails.
-- ============================================================================

-- C1. Helpers: SECURITY DEFINER, pinned search_path, owned by the profiles owner.
select p.proname,
       p.proowner::regrole as owner,
       p.prosecdef as security_definer,
       p.proconfig as pinned_settings,
       (p.proowner = (select relowner from pg_class
                      where oid = 'public.profiles'::regclass)) as owner_matches_profiles
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname like 'lsp\_%'
order by p.proname;

-- C2. Guard triggers: exactly THREE — the same three Section D.1 drops.
select count(*) as guard_triggers,
       count(*) = 3 as matches_rollback
from pg_trigger t
join pg_class c on c.oid = t.tgrelid
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and t.tgname like 'lsp\_guard%';
-- expect: guard_triggers = 3, matches_rollback = true

-- C2b. No lsp_* trigger anywhere except the three guarded tables. Expect 0 rows:
--      a row here means B created something D.1 does not undo.
select c.relname as table_name, t.tgname
from pg_trigger t
join pg_class c on c.oid = t.tgrelid
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and t.tgname like 'lsp\_%'
  and c.relname not in ('profiles','provider_profiles','provider_documents')
order by c.relname, t.tgname;

-- C3. Recreated policies have the expected shape; the provider ones must use user_id.
select tablename, policyname, cmd, roles, qual, with_check
from pg_policies
where schemaname = 'public'
  and policyname in ('lsp_providers_insert','lsp_providers_update',
                     'lsp_profiles_insert','lsp_documents_owner')
order by policyname;

-- C4. ADMIN REPORT ONLY. Phase 0 neither creates nor requires an admin account;
--     ZERO admins is a valid Phase 0 result and this never fails.
select count(*) filter (where role = 'admin') as admin_accounts,
       count(*) as total_profiles
from public.profiles;

select id, email from public.profiles
where role = 'admin' order by email;

-- C5. Effective EXECUTE privilege, PUBLIC and inheritance included.
--     grantee 0 is PUBLIC and cannot be cast to regrole, so it is labelled here.
select p.proname,
       case when a.grantee = 0 then 'PUBLIC'
            else pg_get_userbyid(a.grantee) end as grantee,
       a.privilege_type
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
cross join lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
where n.nspname = 'public' and p.proname like 'lsp\_%'
order by 1, 2;

select has_function_privilege('anon','public.lsp_is_admin()','EXECUTE') as anon_can_execute,
       has_function_privilege('authenticated','public.lsp_is_admin()','EXECUTE') as auth_can_execute;
-- expect: anon_can_execute = false, auth_can_execute = true

-- C6. Constraint present and still NOT VALID (no row scanned or rewritten).
select conname, convalidated, pg_get_constraintdef(oid) as definition
from pg_constraint where conname = 'profiles_role_allowed';

-- C7. Distributions must equal A3/A11: this migration modifies no existing row.
select coalesce(role, '(null)') as role, count(*) as accounts
from public.profiles group by role order by accounts desc;

select coalesce(status, '(null)') as status, count(*) as documents
from public.provider_documents group by status order by documents desc;

-- C8. OBJECT INVENTORY from the catalogue — per-kind counts plus a TOTAL row
--     produced by GROUP BY ROLLUP. Expect trigger 3, guard function 3, policy 4,
--     constraint 1, TOTAL 11. The CTE mirrors B0 exactly; if B ever creates an
--     object this CTE does not select, the TOTAL will exceed 11 and the
--     discrepancy is visible instead of silent.
with created as (
  select 'trigger' as kind, t.tgname as name, c.relname as on_object
  from pg_trigger t
  join pg_class c on c.oid = t.tgrelid
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and t.tgname like 'lsp\_guard%'
  union all
  select 'guard function', p.proname, '(function)'
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname like 'lsp\_guard%'
  union all
  select 'policy', policyname, tablename
  from pg_policies
  where schemaname = 'public'
    and policyname in ('lsp_providers_insert','lsp_providers_update',
                       'lsp_profiles_insert','lsp_documents_owner')
  union all
  select 'constraint', conname, 'public.profiles'
  from pg_constraint
  where conname = 'profiles_role_allowed'
)
select coalesce(kind, 'TOTAL') as kind, count(*) as objects
from created
group by rollup (kind)
order by kind nulls last;

-- C8b. The 3 REPLACED helpers — deliberately outside the 11 and NOT dropped by
--      D.1, because policies call them. These are restored from A0, not removed.
select p.proname as replaced_helper,
       p.proowner::regrole as owner,
       p.prosecdef as security_definer,
       p.proconfig as pinned_settings
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in ('lsp_role','lsp_is_admin','lsp_provider_ids')
order by 1;


-- ============================================================================
-- SECTION D — ROLLBACK (only if a real regression appears)
-- ----------------------------------------------------------------------------
-- THIS IS NOT AUTOMATIC. It restores what A0/A0b/A0c recorded and nothing else.
-- Without that saved output, D.1 can remove the new objects but cannot put the
-- old ones back. Every line is a comment until you deliberately uncomment it.
-- ============================================================================

-- D.1  RESTORE. Fill in R1-R4 from A0/A0b, then uncomment the whole block.
-- ----------------------------------------------------------------------------
-- begin;
--
-- drop trigger if exists lsp_guard_document_status       on public.provider_documents;
-- drop trigger if exists lsp_guard_provider_verification on public.provider_profiles;
-- drop trigger if exists lsp_guard_profile_role          on public.profiles;
--
-- drop function if exists public.lsp_guard_document_status();
-- drop function if exists public.lsp_guard_provider_verification();
-- drop function if exists public.lsp_guard_profile_role();
--
-- alter table public.profiles drop constraint if exists profiles_role_allowed;
--
-- drop policy if exists lsp_profiles_insert  on public.profiles;
-- drop policy if exists lsp_providers_insert on public.provider_profiles;
-- drop policy if exists lsp_providers_update on public.provider_profiles;
-- drop policy if exists lsp_documents_owner  on public.provider_documents;
--
-- -- R1 <paste the four CREATE POLICY statements reconstructed from A0b:
-- --      tablename, policyname, permissive, roles, cmd, qual, with_check>
--
-- -- R2 <paste the CREATE OR REPLACE FUNCTION statements for lsp_role,
-- --      lsp_is_admin and lsp_provider_ids captured by A0>
--
-- -- R3 <for each of the three, restore the owner recorded by A0:
-- --      alter function public.lsp_role() owner to <owner-from-A0>;>
--
-- -- R4 <restore the ACL recorded by A0's acl column, e.g.
-- --      grant execute on function public.lsp_is_admin() to authenticated;>
--
-- -- commit;
--
-- The three helpers are never dropped: many policies call them, and dropping
-- them would break every policy that references them.

-- D.2  OBJECT-BY-OBJECT RESTORE MAP.
-- ----------------------------------------------------------------------------
-- Column 4 distinguishes an ATTEMPT the guard rejected in memory (nothing was
-- written, so there is nothing to restore) from a PERSISTED change (a different
-- value is now stored and rollback does not put the old one back).
--
--  1. lsp_guard_profile_role trigger           created  | no data       | drop
--     -> recoverable: n/a, it did not exist before.
--  2. lsp_guard_provider_verification trigger   created  | no data       | drop
--     -> recoverable: n/a.
--  3. lsp_guard_document_status trigger         created  | no data       | drop
--     -> recoverable: n/a.
--  4. The three guard functions                 created  | no data       | drop
--     -> recoverable: n/a.
--  5. profiles_role_allowed constraint          created  | no data       | drop
--     -> recoverable: n/a; no row was scanned or rewritten.
--  6. lsp_profiles_insert policy                replaced | no data       | drop + R1
--     -> recoverable: YES, exactly, from A0b.
--  7. lsp_providers_insert policy               replaced | no data       | drop + R1
--     -> recoverable: YES, exactly, from A0b.
--  8. lsp_providers_update policy               replaced | no data       | drop + R1
--     -> recoverable: YES, exactly, from A0b.
--  9. lsp_documents_owner policy                replaced | no data       | drop + R1
--     -> recoverable: YES, exactly, from A0b.
-- 10. lsp_role body                            replaced | no data       | R2
--     -> recoverable: YES from A0's definition column.
-- 11. lsp_is_admin body                        replaced | no data       | R2
--     -> recoverable: YES from A0.
-- 12. lsp_provider_ids body                    replaced | no data       | R2
--     -> recoverable: YES from A0.
-- 13. Helper ownership                         possibly changed | no data | R3
--     -> recoverable: YES from A0's owner column; needs the same SET ROLE
--        privilege B2.1 required.
-- 14. Helper EXECUTE grants/revokes            changed  | no data       | R4
--     -> recoverable: YES from A0's acl column.
-- 15. profiles.role values                     ATTEMPT BLOCKED | NOT persisted
--     -> the trigger rewrites new.role back to old.role before the row is
--        written, so the stored value never changed. Nothing to restore.
-- 16. provider_profiles.verification_status    ATTEMPT BLOCKED on UPDATE |
--     NOT persisted -> same in-memory pin. On INSERT the coercion DOES persist:
--     a row that claimed 'approved' is stored as 'pending' (item 18).
-- 17. provider_documents.provider_id           ATTEMPT BLOCKED | NOT persisted
--     -> new.provider_id := old.provider_id, so no ownership change reaches disk.
--     Nothing to restore.
-- 18. PERSISTED DATA CHANGES — NOT reversible, logged only:
--       (a) provider_profiles.verification_status written as 'pending' where the
--           client asked for 'approved'/'verified' on INSERT;
--       (b) provider_documents.status written as 'pending' on INSERT where the
--           client asked for approved/verified/rejected;
--       (c) provider_documents.status reset to 'pending' when the provider edited
--           an already approved/verified document.
--     The raise log lines are the only record of which rows were affected.

-- D.3  NOT AT RISK.
--   No row is deleted, no column or table is dropped, no policy is weakened, and
--   the migration itself modifies no existing profile or document row.


-- ============================================================================
-- END OF PROPOSAL — NOTHING EXECUTED
-- ============================================================================
