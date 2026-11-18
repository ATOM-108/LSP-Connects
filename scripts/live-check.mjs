// Live end-to-end check against the real Supabase project.
// Creates two legitimate demo accounts (customer + provider), a provider profile
// with a service, then exercises the shared booking record:
//   customer creates booking -> provider sees it -> provider accepts -> customer sees "accepted".
// Usage: node scripts/live-check.mjs
import { createRequire } from 'node:module';

const URL_ = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const KEY = process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY;
if (!URL_ || !KEY) {
  console.error('Missing SUPABASE_URL / SUPABASE_ANON_KEY');
  process.exit(2);
}
globalThis.window = { __LSP_CONFIG__: { supabaseUrl: URL_, supabaseAnonKey: KEY } };

// Node 20 has no global WebSocket; supabase-js requires one at client construction.
// This script never opens a realtime channel, so a no-op stub is enough.
if (typeof globalThis.WebSocket === 'undefined') {
  globalThis.WebSocket = class {
    constructor() {}
    addEventListener() {}
    removeEventListener() {}
    send() {}
    close() {}
  };
}

const { supabase } = await import('../src/lib/supabaseClient.js');
const api = await import('../src/lib/api.js');

const DEMO_PASSWORD = process.env.DEMO_PASSWORD || 'LspConnect#2026';
const customerEmail = process.env.DEMO_CUSTOMER_EMAIL || 'demo.customer@lspconnect.app';
const providerEmail = process.env.DEMO_PROVIDER_EMAIL || 'demo.provider@lspconnect.app';

const results = [];
const record = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' :: ' + detail : ''}`);
};

async function ensureAccount({ email, password, fullName, role, city }) {
  let { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: { data: { full_name: fullName, role, city } },
  });
  if (error && /already|registered|exists/i.test(error.message)) {
    const signIn = await supabase.auth.signInWithPassword({ email, password });
    if (signIn.error) throw new Error(`sign-in failed for ${email}: ${signIn.error.message}`);
    return signIn.data.session;
  }
  if (error) throw new Error(`sign-up failed for ${email}: ${error.message}`);
  if (!data.session) {
    throw new Error(
      `sign-up for ${email} returned no session (email confirmation is enabled in Supabase). ` +
        'Disable Authentication -> Email -> Confirm email for the demo, then re-run.',
    );
  }
  return data.session;
}

try {
  // ---------------------------------------------------------------- customer
  const customerSession = await ensureAccount({
    email: customerEmail,
    password: DEMO_PASSWORD,
    fullName: 'Ama Mensah',
    role: 'customer',
    city: 'Accra',
  });
  record('customer auth session', Boolean(customerSession));
  const customerId = customerSession.user.id;

  const customerProfile = await api.ensureProfile({
    id: customerId,
    email: customerEmail,
    role: 'customer',
    fullName: 'Ama Mensah',
    city: 'Accra',
  });
  record('customer profile row', Boolean(customerProfile?.id), `role=${customerProfile?.role}`);

  const categories = await api.listCategories();
  record('service_categories readable', categories.length > 0, `${categories.length} categories`);
  const category = categories[0] || null;

  // ---------------------------------------------------------------- provider
  await supabase.auth.signOut();
  const providerSession = await ensureAccount({
    email: providerEmail,
    password: DEMO_PASSWORD,
    fullName: 'Kofi Boateng',
    role: 'provider',
    city: 'Accra',
  });
  record('provider auth session', Boolean(providerSession));
  const providerUserId = providerSession.user.id;

  await api.ensureProfile({
    id: providerUserId,
    email: providerEmail,
    role: 'provider',
    fullName: 'Kofi Boateng',
    city: 'Accra',
  });

  let providerProfile = await api.getProviderForUser(providerUserId);
  if (!providerProfile) {
    providerProfile = await api.createProviderProfile(providerUserId, {
      businessName: 'Boateng Home Services',
      categoryId: category?.id || null,
      bio: 'Plumbing and general home repairs across Accra.',
      city: 'Accra',
      yearsExperience: 6,
      hourlyRate: 120,
    });
  }
  record('provider_profiles row', Boolean(providerProfile?.id), `id=${providerProfile?.id}`);

  const services = await api.listProviderServices(providerProfile.id);
  if (!services.length) {
    await api.addProviderService(providerProfile.id, {
      title: 'Leak repair visit',
      description: 'Diagnosis and repair of a single leak.',
      price: 120,
      durationMinutes: 60,
    });
  }
  const providerServices = await api.listProviderServices(providerProfile.id);
  record('provider services', providerServices.length > 0, `${providerServices.length} service(s)`);

  // ------------------------------------------------------------ booking flow
  await supabase.auth.signOut();
  await supabase.auth.signInWithPassword({ email: customerEmail, password: DEMO_PASSWORD });

  const addresses = await api.listAddresses(customerId);
  if (!addresses.length) {
    await api.addAddress(customerId, {
      label: 'Home',
      addressLine: '12 Independence Avenue',
      city: 'Accra',
      state: 'Greater Accra',
      postalCode: 'GA-123-4567',
      isDefault: true,
    });
  }
  const savedAddresses = await api.listAddresses(customerId);
  record('customer_addresses persistence', savedAddresses.length > 0, `${savedAddresses.length} address(es)`);

  const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  const booking = await api.createBooking({
    customerId,
    providerUserId,
    providerProfileId: providerProfile.id,
    serviceId: providerServices[0]?.id || null,
    categoryId: category?.id || null,
    date: tomorrow,
    time: '10:00',
    address: savedAddresses[0]
      ? `${savedAddresses[0].addressLine}, ${savedAddresses[0].city}`
      : '12 Independence Avenue, Accra',
    description: 'Kitchen sink is leaking under the cabinet.',
    amount: providerServices[0]?.price ?? 120,
    clientToken: `live-check-${Date.now()}`,
  });
  record('booking inserted by customer', Boolean(booking?.id), `id=${booking?.id} status=${booking?.status}`);

  const customerBookings = await api.listBookingsFor({ customerId });
  record(
    'customer sees booking in history',
    customerBookings.some((b) => String(b.id) === String(booking.id)),
    `${customerBookings.length} booking(s)`,
  );

  // ------------------------------------------------- provider accepts the job
  await supabase.auth.signOut();
  await supabase.auth.signInWithPassword({ email: providerEmail, password: DEMO_PASSWORD });

  const providerBookings = await api.listBookingsFor({
    providerUserId,
    providerProfileId: providerProfile.id,
  });
  const received = providerBookings.find((b) => String(b.id) === String(booking.id));
  record('provider dashboard receives same booking', Boolean(received), `status=${received?.status}`);

  const detail = await api.getBooking(booking.id);
  record('provider can open booking details', Boolean(detail?.id), `customer=${detail?.customerName || 'n/a'}`);

  await api.updateBookingStatus(booking.id, 'accepted', { providerId: providerUserId });
  const afterAccept = await api.getBooking(booking.id);
  record('provider status update persisted', afterAccept?.status === 'accepted', `status=${afterAccept?.status}`);

  // ------------------------------------------------- customer sees the change
  await supabase.auth.signOut();
  await supabase.auth.signInWithPassword({ email: customerEmail, password: DEMO_PASSWORD });
  const customerView = await api.getBooking(booking.id);
  record(
    'customer sees updated status on same record',
    customerView?.status === 'accepted' && String(customerView.id) === String(booking.id),
    `status=${customerView?.status}`,
  );

  // a second read proves the value is stored, not cached in memory
  const reread = await api.getBooking(booking.id);
  record('status persists across a fresh read', reread?.status === 'accepted', `status=${reread?.status}`);
} catch (error) {
  record('live check completed without exception', false, error.message);
} finally {
  await supabase.auth.signOut();
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) {
    console.log('Failures:');
    for (const f of failed) console.log(` - ${f.name}: ${f.detail}`);
    process.exit(1);
  }
}
