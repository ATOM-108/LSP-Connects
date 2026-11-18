-- ============================================================================
-- LSP Connect — DEMO ACCOUNTS (customer + service provider)
-- ============================================================================
-- Run this ONCE in the Supabase dashboard: SQL Editor -> paste -> Run.
--
-- WHY THIS EXISTS
--   The project has "Confirm email" switched ON, and the built-in mailer is
--   rate-limited (429 "email rate limit exceeded"). A normal sign-up therefore
--   returns no session, so nobody can log in to demonstrate the app.
--
--   This script creates the two accounts directly in auth.users with
--   email_confirmed_at already set, so they can log in immediately — no email
--   is sent and no project setting has to be changed.
--
-- SAFETY
--   * purely ADDITIVE: no DROP, DELETE or TRUNCATE anywhere;
--   * idempotent: re-running it is safe;
--   * if an account with one of these emails already exists (for example from an
--     earlier sign-up attempt), the script ADOPTS that row — it reuses its id and
--     just confirms it and resets the password. Nothing is deleted;
--   * the public-schema columns used below were verified against the live
--     database (provider_profiles, profiles, service_categories, provider_skills).
--
-- ACCOUNTS CREATED
--   Customer : demo.customer@lspconnect.app  /  Demo@2026
--   Provider : demo.provider@lspconnect.app  /  Demo@2026
--
--   The provider also gets a provider_profiles row AND a provider_skills row, so
--   it appears in the customer's browse list and can receive bookings.
-- ============================================================================

do $$
declare
  v_cust_email text := 'demo.customer@lspconnect.app';
  v_prov_email text := 'demo.provider@lspconnect.app';
  v_password   text := 'Demo@2026';
  v_customer   uuid;
  v_provider   uuid;
  v_category   uuid;
  v_id_expr    text;      -- auth.identities.id is uuid on newer projects, text on older ones
  v_has_provider_id boolean;
begin
  -- --------------------------------------------------------------------------
  -- 0. Adopt existing accounts with these emails, otherwise use fixed ids
  -- --------------------------------------------------------------------------
  select id into v_customer from auth.users where lower(email) = v_cust_email limit 1;
  select id into v_provider from auth.users where lower(email) = v_prov_email limit 1;

  if v_customer is null then
    v_customer := '11111111-1111-4111-8111-111111111111';
  end if;
  if v_provider is null then
    v_provider := '22222222-2222-4222-8222-222222222222';
  end if;

  -- Reuse an existing service category; create one only if the table is empty.
  select id into v_category
  from public.service_categories
  order by created_at nulls last
  limit 1;

  if v_category is null then
    insert into public.service_categories (name, description, is_active)
    values ('Plumbing & Home Repair', 'Demo service category', true)
    returning id into v_category;
  end if;

  -- --------------------------------------------------------------------------
  -- 1. Auth users, already confirmed
  -- --------------------------------------------------------------------------
  insert into auth.users (
    instance_id, id, aud, role, email, encrypted_password,
    email_confirmed_at, created_at, updated_at,
    raw_app_meta_data, raw_user_meta_data,
    confirmation_token, recovery_token, email_change_token_new, email_change
  )
  values
    (
      '00000000-0000-0000-0000-000000000000', v_customer, 'authenticated', 'authenticated',
      v_cust_email,
      extensions.crypt(v_password, extensions.gen_salt('bf')),
      now(), now(), now(),
      '{"provider":"email","providers":["email"]}'::jsonb,
      jsonb_build_object('full_name', 'Demo Customer', 'role', 'customer'),
      '', '', '', ''
    ),
    (
      '00000000-0000-0000-0000-000000000000', v_provider, 'authenticated', 'authenticated',
      v_prov_email,
      extensions.crypt(v_password, extensions.gen_salt('bf')),
      now(), now(), now(),
      '{"provider":"email","providers":["email"]}'::jsonb,
      jsonb_build_object('full_name', 'Demo Provider', 'role', 'provider'),
      '', '', '', ''
    )
  on conflict (id) do update set
    encrypted_password = excluded.encrypted_password,
    email_confirmed_at  = coalesce(auth.users.email_confirmed_at, now()),
    updated_at          = now();

  -- --------------------------------------------------------------------------
  -- 2. Email identities (required for password sign-in)
  --    Dynamic SQL so this works whether auth.identities.id is uuid or text,
  --    and whether or not the provider_id column exists on this project.
  -- --------------------------------------------------------------------------
  select exists (
    select 1 from information_schema.columns
    where table_schema = 'auth' and table_name = 'identities' and column_name = 'provider_id'
  ) into v_has_provider_id;

  select case when data_type = 'text' then 'gen_random_uuid()::text' else 'gen_random_uuid()' end
  into v_id_expr
  from information_schema.columns
  where table_schema = 'auth' and table_name = 'identities' and column_name = 'id';

  v_id_expr := coalesce(v_id_expr, 'gen_random_uuid()');

  if v_has_provider_id then
    execute format($f$
      insert into auth.identities
        (id, user_id, provider_id, provider, identity_data, last_sign_in_at, created_at, updated_at)
      values
        (%s, %L, 'email', 'email', jsonb_build_object('sub', %L, 'email', %L), now(), now(), now()),
        (%s, %L, 'email', 'email', jsonb_build_object('sub', %L, 'email', %L), now(), now(), now())
      on conflict do nothing
    $f$, v_id_expr, v_customer, v_customer::text, v_cust_email,
          v_id_expr, v_provider, v_provider::text, v_prov_email);
  else
    execute format($f$
      insert into auth.identities
        (id, user_id, provider, identity_data, last_sign_in_at, created_at, updated_at)
      values
        (%s, %L, 'email', jsonb_build_object('sub', %L, 'email', %L), now(), now(), now()),
        (%s, %L, 'email', jsonb_build_object('sub', %L, 'email', %L), now(), now(), now())
      on conflict do nothing
    $f$, v_id_expr, v_customer, v_customer::text, v_cust_email,
          v_id_expr, v_provider, v_provider::text, v_prov_email);
  end if;

  -- --------------------------------------------------------------------------
  -- 3. Profiles (the app reads these for names, phones and roles)
  -- --------------------------------------------------------------------------
  insert into public.profiles (id, email, role, full_name, phone)
  values
    (v_customer, v_cust_email, 'customer', 'Demo Customer', '+254700000001'),
    (v_provider, v_prov_email, 'provider', 'Demo Provider', '+254700000002')
  on conflict (id) do update set
    email     = excluded.email,
    role      = excluded.role,
    full_name = excluded.full_name;

  -- --------------------------------------------------------------------------
  -- 4. Provider profile (this row is what makes the provider appear in browse)
  -- --------------------------------------------------------------------------
  insert into public.provider_profiles
    (user_id, business_name, city, is_available, verification_status, experience_years)
  values
    (v_provider, 'Demo Plumbing Co', 'Nairobi', true, 'verified', 5)
  on conflict (user_id) do update set
    business_name = excluded.business_name,
    city          = excluded.city,
    is_available  = true;

  -- --------------------------------------------------------------------------
  -- 5. Link the provider to the category so category browsing finds it
  -- --------------------------------------------------------------------------
  insert into public.provider_skills (provider_id, category_id)
  select v_provider, v_category
  where not exists (
    select 1 from public.provider_skills
    where provider_id = v_provider and category_id = v_category
  );

  raise notice 'Demo accounts ready: % and %', v_cust_email, v_prov_email;
end $$;

-- ============================================================================
-- VERIFY — both rows should show confirmed = true and identities > 0
-- ============================================================================
select
  u.email,
  u.email_confirmed_at is not null as confirmed,
  (select count(*) from auth.identities i where i.user_id = u.id) as identities,
  p.role,
  pp.business_name
from auth.users u
left join public.profiles p on p.id = u.id
left join public.provider_profiles pp on pp.user_id = u.id
where lower(u.email) in ('demo.customer@lspconnect.app', 'demo.provider@lspconnect.app');
