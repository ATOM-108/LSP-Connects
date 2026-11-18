import { supabase, isSupabaseConfigured } from './supabaseClient.js';
import {
  normalizeProfile,
  normalizeProvider,
  normalizeCategory,
  normalizeService,
  normalizeAddress,
  normalizeSkill,
  normalizeBooking,
  bookingBelongsToCustomer,
  bookingBelongsToProvider,
  pick,
} from './rows.js';

export class DataError extends Error {
  constructor(table, error) {
    super(error?.message || `Database error on ${table}`);
    this.name = 'DataError';
    this.table = table;
    this.code = error?.code;
    this.details = error?.details;
    this.hint = error?.hint;
  }
}

function client() {
  if (!isSupabaseConfigured || !supabase) {
    throw new Error('Supabase is not configured. Add SUPABASE_URL and SUPABASE_ANON_KEY.');
  }
  return supabase;
}

const MISSING_COLUMN_PATTERNS = [
  /Could not find the '([^']+)' column/i,
  /column "([^"]+)" of relation "[^"]+" does not exist/i,
  /column ([a-zA-Z0-9_]+) does not exist/i,
];

function missingColumn(error) {
  if (!error) return null;
  if (error.code !== 'PGRST204' && error.code !== '42703') return null;
  for (const pattern of MISSING_COLUMN_PATTERNS) {
    const match = pattern.exec(error.message || '');
    if (match) return match[1];
  }
  return null;
}

function isDuplicate(error) {
  return error?.code === '23505' || /duplicate key/i.test(error?.message || '');
}

function isPermission(error) {
  return error?.code === '42501' || /row-level security|permission denied/i.test(error?.message || '');
}

function isForeignKey(error) {
  return error?.code === '23503' || /foreign key/i.test(error?.message || '');
}

function isInvalidUuid(error) {
  return error?.code === '22P02' || /invalid input syntax for type uuid/i.test(error?.message || '');
}

// Read every row of a table. Row Level Security still limits what the signed-in
// user may see; filtering and sorting happen in the browser so the app keeps
// working even when a column name differs from the assumed one.
export async function fetchAll(table) {
  const { data, error } = await client().from(table).select('*');
  if (error) throw new DataError(table, error);
  return Array.isArray(data) ? data : [];
}

async function safeFetchAll(table) {
  try {
    return await fetchAll(table);
  } catch (error) {
    console.warn(`[LSP] could not read ${table}:`, error.message);
    return [];
  }
}

export async function insertRow(table, payload) {
  const body = { ...payload };
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const { data, error } = await client().from(table).insert(body).select();
    if (!error) {
      const rows = Array.isArray(data) ? data : data ? [data] : [];
      return rows[0] || body;
    }
    const column = missingColumn(error);
    if (column && Object.prototype.hasOwnProperty.call(body, column)) {
      delete body[column];
      continue;
    }
    if (isInvalidUuid(error) && Object.prototype.hasOwnProperty.call(body, 'id')) {
      delete body.id;
      continue;
    }
    if (error.code === 'PGRST116') return body;
    if (isPermission(error) && body.id) {
      // Insert may have succeeded while the read-back was denied.
      const existing = await fetchAll(table).catch(() => []);
      const found = existing.find((row) => String(row.id) === String(body.id));
      if (found) return found;
    }
    throw new DataError(table, error);
  }
  throw new DataError(table, { message: 'Too many unknown columns in payload.' });
}

export async function updateRow(table, id, patch) {
  const body = { ...patch };
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const { data, error } = await client().from(table).update(body).eq('id', id).select();
    if (!error) {
      const rows = Array.isArray(data) ? data : data ? [data] : [];
      return rows[0] || null;
    }
    const column = missingColumn(error);
    if (column && Object.prototype.hasOwnProperty.call(body, column)) {
      delete body[column];
      continue;
    }
    if (error.code === 'PGRST116') return null;
    throw new DataError(table, error);
  }
  throw new DataError(table, { message: 'Too many unknown columns in payload.' });
}

export async function deleteRow(table, id) {
  const { error } = await client().from(table).delete().eq('id', id);
  if (error) throw new DataError(table, error);
}

/* ------------------------------------------------------------------ profiles */

export async function getProfile(userId) {
  if (!userId) return null;
  try {
    const { data, error } = await client().from('profiles').select('*').eq('id', userId).maybeSingle();
    if (error) throw error;
    return normalizeProfile(data);
  } catch (error) {
    console.warn('[LSP] profile read failed:', error.message);
    return null;
  }
}

export async function ensureProfile({ id, email, role, fullName, phone, city }) {
  const payload = {
    id,
    email,
    role,
    full_name: fullName || '',
    phone: phone || '',
    city: city || '',
  };
  try {
    const row = await insertRow('profiles', payload);
    return normalizeProfile(row);
  } catch (error) {
    if (isDuplicate(error)) {
      try {
        const row = await updateRow('profiles', id, payload);
        return normalizeProfile(row || payload);
      } catch (updateError) {
        console.warn('[LSP] profile update after duplicate failed:', updateError.message);
        return null;
      }
    }
    if (isPermission(error)) {
      // A database trigger may create the profile row; read it back instead.
      return getProfile(id);
    }
    throw error;
  }
}

export async function updateProfile(userId, patch) {
  const row = await updateRow('profiles', userId, patch);
  if (!row) throw new Error('Your profile could not be updated.');
  return normalizeProfile(row);
}

/* ---------------------------------------------------------------- categories */

export async function listCategories() {
  const rows = await safeFetchAll('service_categories');
  return rows.map(normalizeCategory).filter((row) => row && row.id);
}

/* ----------------------------------------------------------------- providers */

export async function loadProviderDirectory() {
  const [providerRows, profileRows, categoryRows] = await Promise.all([
    fetchAll('provider_profiles'),
    safeFetchAll('profiles'),
    safeFetchAll('service_categories'),
  ]);

  const categories = categoryRows.map(normalizeCategory).filter(Boolean);
  const categoryById = new Map(categories.map((category) => [String(category.id), category]));
  const profileById = new Map(profileRows.map((row) => [String(row.id), normalizeProfile(row)]));

  const providers = providerRows
    .map(normalizeProvider)
    .filter(Boolean)
    .map((provider) => {
      const profile = profileById.get(String(provider.userId)) || null;
      return {
        ...provider,
        profile,
        categoryName: categoryById.get(String(provider.categoryId))?.name || '',
        displayName: provider.businessName || profile?.fullName || 'Service provider',
      };
    });

  return { providers, categories, profileById };
}

export async function getProviderById(providerId) {
  const { providers } = await loadProviderDirectory();
  return providers.find((provider) => String(provider.id) === String(providerId)) || null;
}

export async function getProviderForUser(userId) {
  if (!userId) return null;
  const { providers } = await loadProviderDirectory();
  return (
    providers.find((provider) => String(provider.userId) === String(userId)) ||
    providers.find((provider) => String(provider.id) === String(userId)) ||
    null
  );
}

export async function createProviderProfile({
  userId,
  businessName,
  categoryId,
  yearsExperience,
  city,
  hourlyRate,
  bio,
}) {
  const payload = {
    user_id: userId,
    business_name: businessName || '',
    service_category_id: categoryId || null,
    years_experience: yearsExperience === '' || yearsExperience === null ? null : Number(yearsExperience),
    city: city || '',
    hourly_rate: hourlyRate === '' || hourlyRate === null ? null : Number(hourlyRate),
    bio: bio || '',
    is_available: true,
    verification_status: 'pending',
  };

  try {
    return normalizeProvider(await insertRow('provider_profiles', { ...payload, id: userId }));
  } catch (error) {
    if (isDuplicate(error)) {
      try {
        return normalizeProvider(await updateRow('provider_profiles', userId, payload));
      } catch (updateError) {
        console.warn('[LSP] provider profile update failed:', updateError.message);
      }
    }
    if (isInvalidUuid(error)) {
      return normalizeProvider(await insertRow('provider_profiles', payload));
    }
    throw error;
  }
}

export async function updateProviderProfile(providerId, patch) {
  const row = await updateRow('provider_profiles', providerId, patch);
  if (!row) throw new Error('Your provider profile could not be updated.');
  return normalizeProvider(row);
}

export async function setProviderAvailability(providerId, isAvailable) {
  return updateProviderProfile(providerId, { is_available: Boolean(isAvailable) });
}

/* ------------------------------------------------------- provider services */

export async function listProviderServices(providerId) {
  const rows = await safeFetchAll('services');
  return rows
    .map(normalizeService)
    .filter((service) => service && String(service.providerId) === String(providerId));
}

export async function addProviderService(providerId, { title, price, description }) {
  return normalizeService(
    await insertRow('services', {
      provider_id: providerId,
      title,
      price: price === '' || price === null ? null : Number(price),
      description: description || '',
      is_active: true,
    }),
  );
}

export async function removeProviderService(serviceId) {
  await deleteRow('services', serviceId);
}

/* --------------------------------------------------------- provider skills */

export async function listProviderSkills(providerId) {
  const rows = await safeFetchAll('provider_skills');
  return rows
    .map(normalizeSkill)
    .filter((skill) => skill && String(skill.providerId) === String(providerId));
}

export async function addProviderSkill(providerId, name) {
  return normalizeSkill(
    await insertRow('provider_skills', {
      provider_id: providerId,
      skill_name: name,
    }),
  );
}

export async function removeProviderSkill(skillId) {
  await deleteRow('provider_skills', skillId);
}

/* ---------------------------------------------------------------- addresses */

export async function listAddresses(customerId) {
  const rows = await safeFetchAll('customer_addresses');
  return rows
    .map(normalizeAddress)
    .filter((address) => address && String(address.customerId) === String(customerId));
}

export async function addAddress(customerId, { label, line, city, state, postalCode, isDefault }) {
  return normalizeAddress(
    await insertRow('customer_addresses', {
      customer_id: customerId,
      label: label || 'Home',
      address_line: line,
      city: city || '',
      state: state || '',
      postal_code: postalCode || '',
      is_default: Boolean(isDefault),
    }),
  );
}

export async function setDefaultAddress(customerId, addressId) {
  const addresses = await listAddresses(customerId);
  await Promise.all(
    addresses
      .filter((address) => String(address.id) !== String(addressId))
      .map((address) => updateRow('customer_addresses', address.id, { is_default: false }).catch(() => null)),
  );
  await updateRow('customer_addresses', addressId, { is_default: true });
}

export async function deleteAddress(addressId) {
  await deleteRow('customer_addresses', addressId);
}

/* ----------------------------------------------------------------- bookings */

export async function listBookingsFor({ customerId, providerUserId, providerProfileId } = {}) {
  const rows = await fetchAll('bookings');
  const bookings = rows.map(normalizeBooking).filter(Boolean);
  if (customerId) return bookings.filter((booking) => bookingBelongsToCustomer(booking, customerId));
  return bookings.filter((booking) =>
    bookingBelongsToProvider(booking, { userId: providerUserId, profileId: providerProfileId }),
  );
}

export async function getBooking(bookingId) {
  const rows = await fetchAll('bookings');
  return normalizeBooking(rows.find((row) => String(row.id) === String(bookingId)) || null);
}

export async function createBooking(input) {
  const clientToken =
    typeof crypto !== 'undefined' && crypto.randomUUID
      ? crypto.randomUUID()
      : `token-${Date.now()}-${Math.random().toString(36).slice(2)}`;

  const base = {
    id: typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : undefined,
    client_token: clientToken,
    customer_id: input.customerId,
    service_id: input.serviceId || null,
    category_id: input.categoryId || null,
    scheduled_date: input.date,
    scheduled_time: input.time,
    service_address: input.address,
    description: input.description,
    status: 'pending',
    amount: input.amount === '' || input.amount === undefined ? null : input.amount,
    created_at: new Date().toISOString(),
  };

  // provider_id may reference either the provider profile row or the auth user.
  const variants = [
    {
      provider_id: input.providerUserId,
      provider_user_id: input.providerUserId,
      provider_profile_id: input.providerProfileId,
    },
    { provider_id: input.providerUserId, provider_user_id: input.providerUserId },
    { provider_id: input.providerProfileId },
    { provider_id: input.providerUserId },
  ];

  let lastError;
  for (const variant of variants) {
    try {
      const row = await insertRow('bookings', { ...base, ...variant });
      return normalizeBooking(row);
    } catch (error) {
      lastError = error;
      if (!isForeignKey(error)) throw error;
    }
  }
  throw lastError;
}

export async function updateBookingStatus(bookingId, status, extra = {}) {
  const row = await updateRow('bookings', bookingId, {
    status,
    updated_at: new Date().toISOString(),
    ...extra,
  });
  if (!row) {
    throw new Error(
      'The booking could not be updated. Your account may not have permission to change this booking.',
    );
  }
  return normalizeBooking(row);
}

/* -------------------------------------------------------------- realtime feed */

export function watchBookings(onChange) {
  if (!supabase) return () => {};
  let channel;
  try {
    channel = supabase
      .channel(`lsp-bookings-${Math.random().toString(36).slice(2)}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'bookings' }, (payload) => {
        onChange(payload);
      })
      .subscribe();
  } catch (error) {
    console.warn('[LSP] realtime unavailable:', error.message);
    return () => {};
  }
  return () => {
    try {
      supabase.removeChannel(channel);
    } catch {
      /* ignore */
    }
  };
}

/* ---------------------------------------------------------------- admin demo */

export async function loadAdminSnapshot() {
  const [profiles, providers, bookings, categories] = await Promise.all([
    safeFetchAll('profiles'),
    safeFetchAll('provider_profiles'),
    safeFetchAll('bookings'),
    safeFetchAll('service_categories'),
  ]);
  return {
    profiles: profiles.map(normalizeProfile),
    providers: providers.map(normalizeProvider),
    bookings: bookings.map(normalizeBooking).filter(Boolean),
    categories: categories.map(normalizeCategory),
  };
}

export { pick };
