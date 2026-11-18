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

// Update a row by a column other than `id` (provider_profiles is keyed by user_id).
async function updateRowBy(table, column, value, patch) {
  const body = { ...patch };
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const { data, error } = await client().from(table).update(body).eq(column, value).select();
    if (!error) {
      const rows = Array.isArray(data) ? data : data ? [data] : [];
      return rows[0] || null;
    }
    const unknown = missingColumn(error);
    if (unknown && Object.prototype.hasOwnProperty.call(body, unknown)) {
      delete body[unknown];
      continue;
    }
    if (error.code === 'PGRST116') return null;
    throw new DataError(table, error);
  }
  throw new DataError(table, { message: 'Too many unknown columns in payload.' });
}

// The existing bookings table may not have structured date/time columns. Probe once
// so a request is either stored in real columns or kept in the description text.
let scheduleColumns = null;
async function supportsBookingSchedule() {
  if (scheduleColumns !== null) return scheduleColumns;
  try {
    const { error } = await client().from('bookings').select('scheduled_date').limit(1);
    scheduleColumns = !error;
  } catch {
    scheduleColumns = false;
  }
  return scheduleColumns;
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
  // provider_profiles is keyed by user_id in this database; unknown columns are
  // dropped automatically by insertRow so the profile still saves.
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
    return normalizeProvider(await insertRow('provider_profiles', payload));
  } catch (error) {
    if (isDuplicate(error)) {
      try {
        return normalizeProvider(await updateRowBy('provider_profiles', 'user_id', userId, payload));
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
  const row =
    (await updateRowBy('provider_profiles', 'user_id', providerId, patch)) ||
    (await updateRowBy('provider_profiles', 'id', providerId, patch).catch(() => null));
  if (!row) throw new Error('Your provider profile could not be updated.');
  return normalizeProvider(row);
}

export async function setProviderAvailability(providerId, isAvailable) {
  return updateProviderProfile(providerId, { is_available: Boolean(isAvailable) });
}

/* ------------------------------------------------------- provider services */

// `services` is a shared catalogue in this database (it has no provider column),
// so a provider sees the catalogue entries that match the categories they offer.
export async function listProviderServices(providerId) {
  const [serviceRows, skills] = await Promise.all([
    safeFetchAll('services'),
    listProviderSkills(providerId),
  ]);
  const offered = new Set(skills.map((skill) => String(skill.categoryId || '')).filter(Boolean));
  return serviceRows
    .map(normalizeService)
    .filter((service) => service && service.isActive !== false)
    .filter((service) => !offered.size || offered.has(String(service.categoryId || '')));
}

export async function addProviderService(providerId, { title, description }) {
  return normalizeService(
    await insertRow('services', {
      name: title,
      description: description || '',
      is_active: true,
    }),
  );
}

export async function removeProviderService(serviceId) {
  await deleteRow('services', serviceId);
}

/* --------------------------------------------------------- provider skills */

// provider_skills links a provider to a service category in this database.
export async function listProviderSkills(providerId) {
  const [rows, categories] = await Promise.all([
    safeFetchAll('provider_skills'),
    safeFetchAll('service_categories'),
  ]);
  const nameById = new Map(categories.map((category) => [String(category.id), category.name]));
  return rows
    .filter((row) => String(row.provider_id ?? row.user_id ?? '') === String(providerId))
    .map((row) => ({
      id: row.id ?? row.category_id,
      providerId,
      categoryId: row.category_id ?? null,
      name:
        nameById.get(String(row.category_id)) ||
        pick(row, 'skill_name', 'name', 'skill', 'title') ||
        'Skill',
      raw: row,
    }));
}

export async function addProviderSkill(providerId, name) {
  const categories = await safeFetchAll('service_categories');
  const wanted = String(name || '').trim().toLowerCase();
  const match =
    categories.find((category) => String(category.name || '').toLowerCase() === wanted) ||
    categories.find((category) => String(category.name || '').toLowerCase().includes(wanted));
  if (!match) {
    throw new Error('Choose one of the listed service categories to add as a skill.');
  }
  const row = await insertRow('provider_skills', {
    provider_id: providerId,
    category_id: match.id,
  });
  return { id: row.id ?? match.id, providerId, categoryId: match.id, name: match.name, raw: row };
}

export async function removeProviderSkill(skillId) {
  const { error } = await client().from('provider_skills').delete().eq('category_id', skillId);
  if (error) throw new DataError('provider_skills', error);
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

  // The existing bookings table stores the problem in `issue_description`. When it
  // has no date/time columns the requested slot is kept in that text so nothing the
  // customer entered is ever lost.
  const hasSchedule = await supportsBookingSchedule();
  const requestedSlot = [input.date, input.time].filter(Boolean).join(' at ');
  const descriptionText = [input.description, hasSchedule || !requestedSlot ? '' : `Requested: ${requestedSlot}`]
    .filter(Boolean)
    .join('\n\n');

  const base = {
    // Supply an id so the insert also works when the table has no column default.
    id: clientToken,
    client_token: clientToken,
    customer_id: input.customerId,
    service_id: input.serviceId || null,
    category_id: input.categoryId || null,
    service_address: input.address,
    issue_description: descriptionText,
    status: 'pending',
  };
  if (hasSchedule) {
    base.scheduled_date = input.date;
    base.scheduled_time = input.time;
  }

  // provider_id may reference the provider's auth user id or the profile row.
  const variants = [
    { provider_id: input.providerUserId },
    { provider_id: input.providerProfileId },
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
