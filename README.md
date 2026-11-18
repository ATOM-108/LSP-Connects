# LSP Connect

A functional service-booking platform built on **Vite + Supabase**. Customers find
providers and create bookings; the assigned provider receives the same booking row
and moves it through acceptance and completion; the customer sees every status
change. Admin is a small read-only demonstration module.

## Quick start

```bash
npm install
npm run dev      # http://localhost:3000
npm run build    # static build into dist/
npm start        # serves dist/ and writes config.js from the environment
```

## Environment

| Variable             | Where            | Purpose                                   |
| -------------------- | ---------------- | ----------------------------------------- |
| `SUPABASE_URL`        | Settings env     | Supabase project URL                      |
| `SUPABASE_ANON_KEY`   | Settings env     | Public anon key (never a service-role key) |

`server.mjs` writes `window.__LSP_CONFIG__` into `dist/config.js` at container
start, so credentials come from the hosting environment and are never baked into
the image or the repository. Local `npm run dev` reads the same variables through
`vite.config.js`.

## Supabase setup (one time, non-destructive)

1. Open **SQL Editor** in your Supabase project and run `supabase/schema.sql`.
   It only creates what is missing (`if not exists`), adds missing columns, and
   replaces only the policies named `lsp_*`. It never drops tables or rows.
   Two additive writes happen: `provider_profiles.user_id` is filled from `id`
   where empty, and the standard service categories are inserted when missing.
2. Open **Authentication → Providers → Email** and turn **Confirm email** off
   (or confirm each demo account from its inbox). Without this, registration
   returns no session and nobody can log in.
3. (Optional) Create an admin account, then set its role:
   `update public.profiles set role = 'admin' where email = '<your admin email>';`
   Public registration in the app can only create `customer` or `provider`.

## Demo accounts

`scripts/live-check.mjs` creates two legitimate Supabase Auth accounts and runs the
whole customer → provider booking round trip against the real database:

```bash
node scripts/live-check.mjs
```

| Role     | Email                                | Password          |
| -------- | ------------------------------------ | ----------------- |
| Customer | `lspconnect.demo.customer@gmail.com`  | `LspConnect#2026` |
| Provider | `lspconnect.demo.provider@gmail.com`  | `LspConnect#2026` |

Override with `DEMO_CUSTOMER_EMAIL`, `DEMO_PROVIDER_EMAIL` and `DEMO_PASSWORD`.

## Workflows

**Customer:** register → profile → browse categories → provider list and profile →
choose a date, time, address and description → confirm → the booking row is
inserted → confirmation page → history and live status tracking → saved addresses.

**Provider:** register → provider profile (business name, category, rate,
availability) → services and skills → dashboard lists the assigned bookings →
open a booking → accept, reject (with reason) or update the job status → history.

Both modules read the **same** `bookings` row. Status updates are written to the
existing record, and the customer view also subscribes to Supabase Realtime with a
manual **Refresh** button as a fallback.

## Layout

```
index.html          app shell
src/main.mjs        router, session, role guards
src/lib/            supabase client, data layer, auth helpers
src/views/          landing, auth, customer, provider, admin screens
src/styles.css      LSP Connect dark theme (orange accent, Inter, Material icons)
supabase/schema.sql schema and RLS policies
scripts/live-check.mjs  end-to-end database verification
public/screens/     original 35-screen design reference (kept for the report)
```

## Known limitation

`picomatch@4.0.7` (transitive through Vite, build-time only) has an open ReDoS
advisory with no fixed release yet. It is not shipped to the browser bundle.

## Demo accounts without waiting for email

If **Confirm email** is enabled in Supabase (Authentication → Providers → Email), a
normal sign-up returns no session, so nobody can log in to demonstrate the app.

Run `supabase/demo-accounts.sql` once in the Supabase **SQL Editor**. It creates two
accounts that are already confirmed, so they log in immediately — no email is sent
and no project setting has to change:

| Role | Email | Password |
| --- | --- | --- |
| Customer | `demo.customer@lspconnect.app` | `Demo@2026` |
| Provider | `demo.provider@lspconnect.app` | `Demo@2026` |

The script is additive and idempotent: no `DROP`/`DELETE`/`TRUNCATE`, and re-running
it is safe. The provider also gets a `provider_profiles` row and a `provider_skills`
row so it appears in category browsing and can receive bookings.

To demo the full flow: sign in as the customer, browse the category, open the demo
provider and book it; then sign in as the provider in a second browser (or private
window), accept the booking, and refresh the customer view to see the new status.
