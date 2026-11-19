// Pure helpers that turn Supabase rows into stable app objects.
// The existing project schema is not guaranteed to use one naming style, so reads
// accept the common aliases and writes retry without unknown columns (see api.js).

export function pick(row, ...keys) {
  if (!row) return undefined;
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(row, key)) {
      const value = row[key];
      if (value !== null && value !== undefined && value !== '') return value;
    }
  }
  return undefined;
}

export function parseBool(value, fallback = false) {
  if (value === true || value === false) return value;
  if (value === null || value === undefined || value === '') return fallback;
  const text = String(value).toLowerCase();
  if (['true', 't', 'yes', 'y', '1', 'available', 'online', 'active'].includes(text)) return true;
  if (['false', 'f', 'no', 'n', '0', 'unavailable', 'offline', 'inactive'].includes(text)) return false;
  return fallback;
}

export function normalizeStatus(value) {
  const text = String(value || 'pending').toLowerCase().replace(/[\s-]+/g, '_');
  const map = {
    new: 'pending',
    requested: 'pending',
    pending: 'pending',
    awaiting: 'pending',
    confirmed: 'accepted',
    approved: 'accepted',
    accept: 'accepted',
    accepted: 'accepted',
    ongoing: 'in_progress',
    started: 'in_progress',
    in_progress: 'in_progress',
    working: 'in_progress',
    complete: 'completed',
    completed: 'completed',
    done: 'completed',
    finished: 'completed',
    rejected: 'rejected',
    declined: 'rejected',
    cancelled: 'cancelled',
    canceled: 'cancelled',
  };
  return map[text] || text;
}

export const BOOKING_TYPES = {
  regular: 'Regular',
  quick: 'Quick Service',
};

// The bookings table requires a booking type (TEXT NOT NULL, no default), so the
// value written must always be one of the two canonical options the UI offers.
export function normalizeBookingType(value) {
  const text = String(value || '').trim().toLowerCase();
  if (!text) return BOOKING_TYPES.regular;
  if (/(quick|urgent|asap|immediate|emergency|now)/.test(text)) return BOOKING_TYPES.quick;
  return BOOKING_TYPES.regular;
}

export const STATUS_META = {
  pending: { label: 'Pending', tone: 'warn', step: 1 },
  accepted: { label: 'Accepted', tone: 'info', step: 2 },
  in_progress: { label: 'In progress', tone: 'info', step: 3 },
  completed: { label: 'Completed', tone: 'ok', step: 4 },
  rejected: { label: 'Rejected', tone: 'bad', step: 0 },
  cancelled: { label: 'Cancelled', tone: 'muted', step: 0 },
};

export function statusMeta(status) {
  return STATUS_META[normalizeStatus(status)] || { label: String(status || 'Unknown'), tone: 'muted', step: 0 };
}

export function normalizeProfile(row) {
  if (!row) return null;
  return {
    id: row.id,
    fullName: pick(row, 'full_name', 'fullName', 'name', 'display_name', 'username') || '',
    email: pick(row, 'email', 'email_address') || '',
    phone: pick(row, 'phone', 'phone_number', 'mobile', 'mobile_number', 'contact_number') || '',
    city: pick(row, 'city', 'town', 'location', 'service_area') || '',
    role: String(pick(row, 'role', 'user_role', 'account_type') || 'customer').toLowerCase(),
    raw: row,
  };
}

export function normalizeCategory(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: pick(row, 'name', 'category_name', 'title', 'label') || 'Service',
    description: pick(row, 'description', 'details', 'summary') || '',
    basePrice: pick(row, 'base_price', 'standard_rate', 'rate', 'price') ?? null,
    raw: row,
  };
}

export function normalizeProvider(row) {
  if (!row) return null;
  const userId = pick(row, 'user_id', 'profile_id', 'provider_id', 'provider_user_id') || row.id;
  return {
    // provider_profiles is keyed by user_id in this database, so fall back to it.
    id: row.id ?? userId,
    userId,
    businessName: pick(row, 'business_name', 'businessName', 'company_name', 'display_name', 'full_name', 'name') || '',
    bio: pick(row, 'bio', 'about', 'description', 'summary') || '',
    yearsExperience: pick(row, 'years_experience', 'experience_years', 'experience') ?? null,
    hourlyRate: pick(row, 'hourly_rate', 'hourlyRate', 'rate', 'base_rate', 'standard_rate') ?? null,
    city: pick(row, 'city', 'service_area', 'location', 'town') || '',
    categoryId: pick(row, 'service_category_id', 'category_id', 'primary_category_id') ?? null,
    isAvailable: parseBool(pick(row, 'is_available', 'isAvailable', 'available', 'availability'), true),
    verificationStatus: pick(row, 'verification_status', 'verification', 'status') || '',
    rating: pick(row, 'rating', 'average_rating', 'rating_average') ?? null,
    totalJobs: pick(row, 'total_jobs', 'completed_jobs', 'jobs_completed', 'total_reviews') ?? null,
    raw: row,
  };
}

export function normalizeService(row) {
  if (!row) return null;
  return {
    id: row.id,
    providerId: pick(row, 'provider_id', 'provider_profile_id', 'provider_user_id', 'user_id') ?? null,
    categoryId: pick(row, 'service_category_id', 'category_id') ?? null,
    title: pick(row, 'title', 'service_name', 'name') || 'Service',
    description: pick(row, 'description', 'details') || '',
    price: pick(row, 'price', 'rate', 'amount', 'base_price') ?? null,
    isActive: parseBool(pick(row, 'is_active', 'active'), true),
    raw: row,
  };
}

export function normalizeAddress(row) {
  if (!row) return null;
  return {
    id: row.id,
    customerId: pick(row, 'customer_id', 'profile_id', 'user_id') ?? null,
    label: pick(row, 'label', 'address_label', 'type', 'title') || 'Address',
    line: pick(row, 'address_line', 'address', 'line1', 'street', 'full_address') || '',
    city: pick(row, 'city', 'town') || '',
    state: pick(row, 'state', 'province') || '',
    postalCode: pick(row, 'postal_code', 'zip', 'zip_code', 'pincode') || '',
    isDefault: parseBool(pick(row, 'is_default', 'default'), false),
    raw: row,
  };
}

export function normalizeSkill(row) {
  if (!row) return null;
  return {
    id: row.id,
    providerId: pick(row, 'provider_id', 'provider_profile_id', 'user_id') ?? null,
    name: pick(row, 'skill_name', 'name', 'skill', 'title') || '',
    raw: row,
  };
}

export function normalizeBooking(row) {
  if (!row) return null;
  const rawStatus = pick(row, 'status', 'booking_status', 'state') || 'pending';
  return {
    id: row.id,
    customerId: pick(row, 'customer_id', 'customer_profile_id') ?? null,
    providerId: pick(row, 'provider_id', 'provider_profile_id', 'service_provider_id') ?? null,
    providerUserId: pick(row, 'provider_user_id') ?? null,
    serviceId: pick(row, 'service_id') ?? null,
    categoryId: pick(row, 'service_category_id', 'category_id') ?? null,
    date: pick(row, 'scheduled_date', 'booking_date', 'service_date', 'date', 'preferred_date') || '',
    time: pick(row, 'scheduled_time', 'booking_time', 'service_time', 'time', 'preferred_time') || '',
    address: pick(row, 'service_address', 'address', 'address_line', 'location', 'address_text') || '',
    description: pick(row, 'description', 'problem_description', 'notes', 'issue_description', 'details') || '',
    amount: pick(row, 'amount', 'total_amount', 'price', 'estimated_amount', 'quoted_amount') ?? null,
    bookingType: pick(row, 'booking_type', 'bookingType', 'booking_mode') || '',
    status: normalizeStatus(rawStatus),
    rawStatus,
    rejectionReason: pick(row, 'rejection_reason', 'reject_reason', 'cancellation_reason', 'status_reason') || '',
    createdAt: pick(row, 'created_at', 'inserted_at', 'created') || '',
    raw: row,
  };
}

export function bookingBelongsToCustomer(booking, customerId) {
  return Boolean(booking && customerId) && String(booking.customerId) === String(customerId);
}

export function bookingBelongsToProvider(booking, { userId, profileId } = {}) {
  if (!booking) return false;
  const candidates = [booking.providerId, booking.providerUserId].filter(Boolean).map(String);
  return [userId, profileId].filter(Boolean).map(String).some((id) => candidates.includes(id));
}

export function addressLine(address) {
  if (!address) return '';
  return [address.line, address.city, address.state, address.postalCode].filter(Boolean).join(', ');
}
