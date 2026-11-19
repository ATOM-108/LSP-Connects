// Regression test for the bookings.booking_type NOT NULL failure.
// The insert payload must always carry the selected booking type
// ("Regular" or "Quick Service") instead of omitting it or hardcoding one value.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildBookingPayload } from '../src/lib/api.js';
import { normalizeBookingType, BOOKING_TYPES } from '../src/lib/rows.js';

const input = {
  customerId: 'cust-1',
  providerUserId: 'prov-user-1',
  providerProfileId: 'prov-profile-1',
  serviceId: 'svc-1',
  categoryId: 'cat-1',
  date: '2026-11-25',
  time: '10:30',
  address: '12 Main Rd, Durban',
  description: 'Kitchen sink leaks under the cabinet.',
};

test('regular booking sends booking_type "Regular"', () => {
  const payload = buildBookingPayload({ ...input, bookingType: 'Regular' }, { clientToken: 't1' });
  assert.equal(payload.booking_type, 'Regular');
});

test('quick service booking sends booking_type "Quick Service"', () => {
  const payload = buildBookingPayload({ ...input, bookingType: 'Quick Service' }, { clientToken: 't2' });
  assert.equal(payload.booking_type, 'Quick Service');
});

test('booking_type is never null, empty or missing', () => {
  const variants = [
    {},
    { bookingType: '' },
    { bookingType: null },
    { bookingType: undefined },
    { bookingType: 'quick' },
    { bookingType: 'REGULAR' },
    { bookingType: 'asap' },
  ];
  for (const variant of variants) {
    const payload = buildBookingPayload({ ...input, ...variant }, { clientToken: 't3' });
    assert.equal(typeof payload.booking_type, 'string', `missing for ${JSON.stringify(variant)}`);
    assert.ok(payload.booking_type.length > 0);
    assert.ok(
      [BOOKING_TYPES.regular, BOOKING_TYPES.quick].includes(payload.booking_type),
      `unexpected value ${payload.booking_type}`,
    );
  }
});

test('the two UI options map to the two stored values', () => {
  assert.equal(normalizeBookingType('Regular'), 'Regular');
  assert.equal(normalizeBookingType('Quick Service'), 'Quick Service');
  assert.equal(normalizeBookingType('quick'), 'Quick Service');
  assert.equal(normalizeBookingType(''), 'Regular');
  assert.equal(normalizeBookingType(undefined), 'Regular');
});

test('the rest of the booking still reaches Supabase unchanged', () => {
  const payload = buildBookingPayload({ ...input, bookingType: 'Quick Service' }, { clientToken: 't4' });
  assert.equal(payload.id, 't4');
  assert.equal(payload.customer_id, 'cust-1');
  assert.equal(payload.provider_id, undefined, 'provider_id is added per variant');
  assert.equal(payload.service_address, '12 Main Rd, Durban');
  assert.equal(payload.status, 'pending');
  // No structured slot columns: the requested slot is preserved in the description.
  assert.match(payload.issue_description, /Requested: 2026-11-25 at 10:30/);
});

test('structured slot columns are used when the table has them', () => {
  const payload = buildBookingPayload({ ...input, bookingType: 'Regular' }, { hasSchedule: true, clientToken: 't5' });
  assert.equal(payload.scheduled_date, '2026-11-25');
  assert.equal(payload.scheduled_time, '10:30');
  assert.equal(payload.booking_type, 'Regular');
  assert.doesNotMatch(payload.issue_description, /Requested:/);
});
