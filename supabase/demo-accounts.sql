-- ============================================================================
-- LSP Connect — DEMO ACCOUNTS (customer + service provider)
-- ============================================================================
-- Run this ONCE in the Supabase dashboard: SQL Editor -> paste -> Run.
--
-- WHY THIS EXISTS
--   The project has "Confirm email" switched ON, and the built-in mailer is
--   rate-limited (429 "email rate limit exceeded"). That means a normal sign-up
--   returns no session, so no one can log in to demonstrate the app.
--
--   This script creates the two accounts directly in auth.users with
--   email_confirmed_at already set, so they can log in immediately — no email
--   is sent and no setting has to be changed.
--
--   It is purely ADDITIVE and idempotent:
--     * no DROP, DELETE or TRUNCATE anywhere;
--     * existing rows are only UPDATED in place for these two fixed ids;
--     * re-running it is safe.
--
-- ACCOUNTS CREATED
--   Customer : demo.customer@lspconnect.app  /  Demo@2026
--   Provider : demo.provider@lspconnect.app  /  Demo@2026
--
--   The provider is given a provider_profiles row AND a provider_skills row so
--   it appears in the customer's browse list and can receive bookings.
-- ============================================================================

do $$
declare
  v_customer uuid := '11111111-1111-4111-8111-111111111111';
  v_provider uuid := '22222222-2222-4222-8222-222222222222';
  v_password text := 'Demo@2026';
  v_category uuid;
begin
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
      'demo.customer@lspconnect.app',
      extensions.crypt(v_password, extensions.gen_salt('bf')),
      now(), now(), now(),
      '{"provider":"email","providers":["email"]}'::jsonb,
      jsonb_build_object('full_name', 'Demo Customer', 'role', 'customer'),
      '', '', '', ''
    ),
    (
      '00000000-0000-0000-0000-000000000000', v_provider, 'authenticated', 'authenticated',
      'demo.provider@lspconnect.app',
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
  -- 2. Email identities (needed for password sign-in)
  -- --------------------------------------------------------------------------
  insert into auth.identities (id, user_id, provider_id, provider, identity_data, last_sign_in_at, created_at, updated_at)
  values
    (gen_random_uuid(), v_customer, 'email', 'email',
     jsonb_build_object('sub', v_customer::text, 'email', 'demo.customer@lspconnect.app'),
     now(), now(), now()),
    (gen_random_uuid(), v_provider, 'email', 'email',
     jsonb_build_object('sub', v_provider::text, 'email', 'demo.provider@lspconnect.app'),
     now(), now(), now())
  on conflict do nothing;

  -- --------------------------------------------------------------------------
  -- 3. Profiles (the app reads these for names, phones and roles)
  -- --------------------------------------------------------------------------
  insert into public.profiles (id, email, role, full_name, phone)
  values
    (v_customer, 'demo.customer@lspconnect.app', 'customer', 'Demo Customer', '+254700000001'),
    (v_provider, 'demo.provider@lspconnect.app', 'provider', 'Demo Provider', '+254700000002')
  on conflict (id) do update set
    email     = excluded.email,
    role      = excluded.role,
    full_name = excluded.full_name;

  -- --------------------------------------------------------------------------
  -- 4. Provider profile (this row is what makes the provider appear in browse)
  -- --------------------------------------------------------------------------
  insert into public.provider_profiles (user_id, business_name, city, is_available, verification_status, experience_years)
  values (v_provider, 'Demo Plumbing Co', 'Nairobi', true, 'verified', 5)
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
end $$;

-- ============================================================================
-- VERIFY — both rows should show confirmed = true
-- ============================================================================
select
  u.email,
  u.email_confirmed_at is not null as confirmed,
  p.role,
  pp.business_name
from auth.users u
left join public.profiles p on p.id = u.id
left join public.provider_profiles pp on pp.user_id = u.id
where u.id in ('11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222');
