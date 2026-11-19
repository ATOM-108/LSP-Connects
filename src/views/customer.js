import {
  loadProviderDirectory,
  listProviderServices,
  listProviderSkills,
  listAddresses,
  addAddress,
  deleteAddress,
  setDefaultAddress,
  updateProfile,
  listBookingsFor,
  getBooking,
  createBooking,
  updateBookingStatus,
} from '../lib/api.js';
import { addressLine, normalizeBookingType } from '../lib/rows.js';
import { friendlyError } from '../lib/auth.js';
import {
  esc,
  icon,
  alertBox,
  emptyState,
  formatDate,
  formatTime,
  formatMoney,
  statusBadge,
  setBusy,
  toast,
  confirmDialog,
  initials,
} from '../ui.js';

const userId = (ctx) => ctx.identity.session?.user?.id || '';

function providerLabel(provider) {
  return provider?.businessName || provider?.profile?.fullName || 'Service provider';
}

function sortByCreated(rows) {
  return [...rows].sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
}

function bookingRow(booking, providerName) {
  return `<a class="list-row" href="#/customer/bookings/${esc(booking.id)}">
    <span class="icon-tile">${icon('event_note')}</span>
    <span class="grow">
      <span class="title">${esc(providerName || 'Service provider')}</span>
      <span class="sub truncate">${esc(booking.date ? formatDate(booking.date) : 'Date to confirm')} ·
        ${esc(formatTime(booking.time))} · ${esc(booking.address || 'Address to confirm')}</span>
    </span>
    ${statusBadge(booking.status)}
  </a>`;
}

/* ---------------------------------------------------------------- dashboard */

export async function renderDashboard(ctx) {
  const id = userId(ctx);
  const profile = ctx.identity.profile;
  const [bookings, addresses, directory] = await Promise.all([
    listBookingsFor({ customerId: id }).catch(() => []),
    listAddresses(id).catch(() => []),
    loadProviderDirectory().catch(() => ({ providers: [] })),
  ]);

  const nameById = new Map(directory.providers.map((provider) => [String(provider.id), providerLabel(provider)]));
  const nameFor = (booking) => nameById.get(String(booking.providerId)) || 'Service provider';
  const pending = bookings.filter((booking) => booking.status === 'pending').length;
  const active = bookings.filter((booking) => ['accepted', 'in_progress'].includes(booking.status)).length;
  const completed = bookings.filter((booking) => booking.status === 'completed').length;
  const recent = sortByCreated(bookings).slice(0, 4);
  const displayName = profile?.fullName || ctx.identity.session?.user?.email || 'there';
  const missingProfile = !profile?.phone || !profile?.city;

  return {
    title: 'Customer dashboard',
    html: `
      <div class="page-head">
        <div>
          <div class="eyebrow">Customer dashboard</div>
          <h1>Hello, ${esc(String(displayName).split(' ')[0])}</h1>
          <p>Your bookings are loaded from the shared bookings table in Supabase.</p>
        </div>
        <div class="btn-row">
          <a class="btn primary" href="#/customer/browse">${icon('add')} Book a service</a>
          <button class="btn ghost" data-action="reload">${icon('refresh')} Refresh</button>
        </div>
      </div>

      ${missingProfile ? alertBox('warn', 'Add your phone number and city in your profile so providers can reach you.') : ''}

      <div class="grid cols-4 mb-2">
        <div class="card stat"><span class="value">${bookings.length}</span><span class="label">Total bookings</span></div>
        <div class="card stat"><span class="value">${pending}</span><span class="label">Awaiting provider</span></div>
        <div class="card stat"><span class="value">${active}</span><span class="label">Active jobs</span></div>
        <div class="card stat"><span class="value">${completed}</span><span class="label">Completed</span></div>
      </div>

      <div class="split">
        <section class="card">
          <div class="card-head">
            <h3>Recent bookings</h3>
            <a class="btn ghost sm" href="#/customer/bookings">View all</a>
          </div>
          ${
            recent.length
              ? `<div class="list">${recent.map((booking) => bookingRow(booking, nameFor(booking))).join('')}</div>`
              : emptyState({
                  icon: 'event_busy',
                  title: 'No bookings yet',
                  message: 'Browse a service category, choose a provider and send your first booking.',
                  action: '<a class="btn primary" href="#/customer/browse">Browse services</a>',
                })
          }
        </section>

        <aside class="stack">
          <div class="card">
            <div class="card-head"><h3>Your profile</h3><a class="btn ghost sm" href="#/customer/profile">Edit</a></div>
            <div class="row" style="gap:12px">
              <span class="avatar" style="width:44px;height:44px;font-size:15px">${esc(initials(profile?.fullName || displayName))}</span>
              <div>
                <b>${esc(profile?.fullName || 'Name not set')}</b>
                <div class="tiny muted">${esc(profile?.email || ctx.identity.session?.user?.email || '')}</div>
              </div>
            </div>
            <dl class="kv mt-2">
              <dt>Phone</dt><dd>${esc(profile?.phone || 'Not set')}</dd>
              <dt>City</dt><dd>${esc(profile?.city || 'Not set')}</dd>
              <dt>Role</dt><dd>${esc(ctx.identity.role)}</dd>
            </dl>
          </div>
          <div class="card">
            <div class="card-head"><h3>Saved addresses</h3><a class="btn ghost sm" href="#/customer/addresses">Manage</a></div>
            ${
              addresses.length
                ? `<div class="list">${addresses
                    .slice(0, 3)
                    .map(
                      (address) => `<div class="list-row" style="padding:10px 12px">
                        <span class="icon-tile" style="width:32px;height:32px;border-radius:9px">${icon('location_on')}</span>
                        <span class="grow"><span class="title tiny">${esc(address.label)}${address.isDefault ? ' · default' : ''}</span>
                        <span class="sub tiny truncate">${esc(addressLine(address) || 'No details')}</span></span>
                      </div>`,
                    )
                    .join('')}</div>`
                : `<p class="tiny muted mb-0">No saved addresses yet. You can add one when booking.</p>`
            }
          </div>
        </aside>
      </div>`,
    bind(root) {
      root.querySelector('[data-action="reload"]')?.addEventListener('click', () => ctx.refresh());
    },
  };
}

/* ------------------------------------------------------------------- browse */

export async function renderBrowse(ctx) {
  const directory = await loadProviderDirectory();
  const counts = new Map();
  directory.providers.forEach((provider) => {
    const key = String(provider.categoryId || provider.categoryName || 'other');
    counts.set(key, (counts.get(key) || 0) + 1);
  });

  let categories = directory.categories;
  if (!categories.length) {
    categories = [...new Set(directory.providers.map((provider) => provider.categoryName).filter(Boolean))].map(
      (name) => ({ id: '', name }),
    );
  }

  const cards = categories
    .map((category) => {
      const count = counts.get(String(category.id || category.name)) || 0;
      const href = category.id
        ? `#/customer/providers?category=${encodeURIComponent(category.id)}`
        : `#/customer/providers?categoryName=${encodeURIComponent(category.name)}`;
      return `<a class="card interactive" href="${href}">
        <span class="icon-tile">${icon('handyman')}</span>
        <h3 class="mt-2">${esc(category.name)}</h3>
        <p class="muted tiny mb-0">${esc(category.description || 'Verified local professionals')}</p>
        <div class="row mt-2"><span class="badge neutral">${count} provider${count === 1 ? '' : 's'}</span>
        <span class="tiny" style="color:var(--primary);margin-left:auto">View ${icon('arrow_forward')}</span></div>
      </a>`;
    })
    .join('');

  return {
    title: 'Browse services',
    html: `
      <div class="page-head">
        <div>
          <div class="eyebrow">Step 2 · Choose a category</div>
          <h1>Browse service categories</h1>
          <p>Categories and providers are read from your Supabase tables.</p>
        </div>
        <a class="btn ghost" href="#/customer/providers">${icon('groups')} All providers</a>
      </div>
      ${
        cards
          ? `<div class="grid auto">${cards}</div>`
          : emptyState({
              icon: 'category',
              title: 'No service categories yet',
              message:
                'Add rows to the service_categories table (the setup SQL in supabase/schema.sql seeds common categories), then refresh.',
              action: '<button class="btn primary" data-action="reload">Refresh</button>',
            })
      }`,
    bind(root) {
      root.querySelector('[data-action="reload"]')?.addEventListener('click', () => ctx.refresh());
    },
  };
}

/* ---------------------------------------------------------------- providers */

export async function renderProviders(ctx) {
  const directory = await loadProviderDirectory();
  const categoryId = ctx.query.get('category') || '';
  const categoryName = ctx.query.get('categoryName') || '';
  const activeCategory = directory.categories.find((category) => String(category.id) === String(categoryId));

  let providers = directory.providers;
  if (categoryId) providers = providers.filter((provider) => String(provider.categoryId) === String(categoryId));
  if (categoryName)
    providers = providers.filter(
      (provider) => String(provider.categoryName || '').toLowerCase() === categoryName.toLowerCase(),
    );

  const heading = activeCategory?.name || categoryName || 'All service providers';

  const cards = providers
    .map(
      (provider) => `
      <article class="card interactive" data-provider data-search="${esc(
        `${providerLabel(provider)} ${provider.city} ${provider.categoryName} ${provider.bio}`.toLowerCase(),
      )}">
        <div class="row" style="align-items:flex-start">
          <span class="avatar" style="width:44px;height:44px;font-size:15px">${esc(initials(providerLabel(provider)))}</span>
          <div class="grow">
            <h3 class="mb-0">${esc(providerLabel(provider))}</h3>
            <div class="tiny muted">${esc(provider.categoryName || 'General services')}${
              provider.city ? ` · ${esc(provider.city)}` : ''
            }</div>
          </div>
          <span class="badge ${provider.isAvailable ? 'completed' : 'neutral'}">${
            provider.isAvailable ? 'Available' : 'Busy'
          }</span>
        </div>
        <p class="muted tiny mt-2">${esc((provider.bio || 'No bio provided yet.').slice(0, 130))}${
          (provider.bio || '').length > 130 ? '…' : ''
        }</p>
        <div class="row tiny muted">
          <span>${icon('payments')} ${esc(formatMoney(provider.hourlyRate))}</span>
          ${provider.yearsExperience ? `<span>${icon('workspace_premium')} ${esc(provider.yearsExperience)} yrs</span>` : ''}
          ${provider.rating ? `<span>${icon('star')} ${esc(provider.rating)}</span>` : ''}
        </div>
        <div class="btn-row mt-2">
          <a class="btn primary sm" href="#/customer/book/${esc(provider.id)}">Book this provider</a>
          <a class="btn ghost sm" href="#/customer/providers/${esc(provider.id)}">View profile</a>
        </div>
      </article>`,
    )
    .join('');

  return {
    title: heading,
    html: `
      <div class="page-head">
        <div>
          <div class="eyebrow">Step 3 · Select a provider</div>
          <h1>${esc(heading)}</h1>
          <p>${providers.length} provider${providers.length === 1 ? '' : 's'} found. Select one to continue.</p>
        </div>
        <a class="btn ghost" href="#/customer/browse">${icon('arrow_back')} Categories</a>
      </div>
      <div class="field" style="max-width:420px">
        <label for="provider-search">Search providers</label>
        <input class="input" id="provider-search" placeholder="Search by name, city or skill" />
      </div>
      <div id="provider-list">${
        cards
          ? `<div class="grid auto">${cards}</div>`
          : emptyState({
              icon: 'person_search',
              title: 'No providers in this category yet',
              message:
                'Ask a provider to register with this category, or add a provider profile in Supabase. Customers can only book real provider profiles.',
              action: '<a class="btn ghost" href="#/customer/browse">Back to categories</a>',
            })
      }</div>`,
    bind(root) {
      const search = root.querySelector('#provider-search');
      search?.addEventListener('input', () => {
        const term = search.value.trim().toLowerCase();
        root.querySelectorAll('[data-provider]').forEach((card) => {
          card.classList.toggle('hide', term.length > 0 && !card.dataset.search.includes(term));
        });
      });
    },
  };
}

/* --------------------------------------------------------- provider details */

export async function renderProviderDetail(ctx) {
  const providerId = ctx.params[0];
  const directory = await loadProviderDirectory();
  const provider = directory.providers.find((item) => String(item.id) === String(providerId));
  if (!provider) {
    return {
      title: 'Provider not found',
      html: emptyState({
        icon: 'search_off',
        title: 'Provider not found',
        message: 'This provider profile is no longer available.',
        action: '<a class="btn primary" href="#/customer/browse">Browse services</a>',
      }),
    };
  }

  const [services, skills] = await Promise.all([
    listProviderServices(provider.id).catch(() => []),
    listProviderSkills(provider.id).catch(() => []),
  ]);

  const serviceList = services.length
    ? `<div class="list">${services
        .map(
          (service) => `<div class="list-row">
            <span class="icon-tile">${icon('design_services')}</span>
            <span class="grow"><span class="title">${esc(service.title)}</span>
            <span class="sub tiny truncate">${esc(service.description || 'No description')}</span></span>
            <b class="tiny">${esc(formatMoney(service.price))}</b>
          </div>`,
        )
        .join('')}</div>`
    : `<p class="tiny muted mb-0">This provider has not listed individual services yet — describe your job when booking.</p>`;

  return {
    title: providerLabel(provider),
    html: `
      <div class="page-head">
        <div>
          <div class="eyebrow">Provider profile</div>
          <h1>${esc(providerLabel(provider))}</h1>
          <p>${esc(provider.categoryName || 'General services')}${provider.city ? ` · ${esc(provider.city)}` : ''}</p>
        </div>
        <div class="btn-row">
          <a class="btn ghost" href="#/customer/providers">${icon('arrow_back')} Back</a>
          <a class="btn primary" href="#/customer/book/${esc(provider.id)}">${icon('event')} Book this provider</a>
        </div>
      </div>

      <div class="split">
        <section class="card">
          <h3>About</h3>
          <p class="muted">${esc(provider.bio || 'This provider has not added a bio yet.')}</p>
          <dl class="kv mt-2">
            <dt>Status</dt><dd><span class="badge ${provider.isAvailable ? 'completed' : 'neutral'}">${
              provider.isAvailable ? 'Available for bookings' : 'Currently unavailable'
            }</span></dd>
            <dt>Experience</dt><dd>${provider.yearsExperience ? `${esc(provider.yearsExperience)} years` : 'Not specified'}</dd>
            <dt>Hourly rate</dt><dd>${esc(formatMoney(provider.hourlyRate))}</dd>
            <dt>Service area</dt><dd>${esc(provider.city || 'Not specified')}</dd>
            <dt>Contact</dt><dd>${esc(provider.profile?.phone || 'Shared after booking')}</dd>
            <dt>Email</dt><dd>${esc(provider.profile?.email || 'Shared after booking')}</dd>
          </dl>
        </section>

        <aside class="stack">
          <div class="card">
            <h3>Skills</h3>
            ${
              skills.length
                ? `<div class="row">${skills
                    .map((skill) => `<span class="badge neutral">${esc(skill.name)}</span>`)
                    .join('')}</div>`
                : '<p class="tiny muted mb-0">No skills listed yet.</p>'
            }
          </div>
          <div class="card">
            <h3>Listed services</h3>
            ${serviceList}
          </div>
        </aside>
      </div>`,
  };
}

/* ------------------------------------------------------------- booking form */

export async function renderBookingForm(ctx) {
  const providerId = ctx.params[0];
  const id = userId(ctx);
  const [directory, addresses] = await Promise.all([
    loadProviderDirectory(),
    listAddresses(id).catch(() => []),
  ]);
  const provider = directory.providers.find((item) => String(item.id) === String(providerId));
  if (!provider) {
    return {
      title: 'Provider not found',
      html: emptyState({
        icon: 'search_off',
        title: 'Provider not found',
        message: 'Choose another provider to continue.',
        action: '<a class="btn primary" href="#/customer/providers">Browse providers</a>',
      }),
    };
  }

  const services = await listProviderServices(provider.id).catch(() => []);
  const defaultAddress = addresses.find((address) => address.isDefault) || addresses[0];
  const today = new Date().toISOString().slice(0, 10);
  // ?type=quick (or any quick/urgent wording) opens the form on Quick Service.
  const initialType = normalizeBookingType(ctx.query.get('type') || '');

  return {
    title: `Book ${providerLabel(provider)}`,
    html: `
      <div class="page-head">
        <div>
          <div class="eyebrow">Step 4 · Booking details</div>
          <h1>Book ${esc(providerLabel(provider))}</h1>
          <p>This creates one booking record that the provider will see in their dashboard.</p>
        </div>
        <a class="btn ghost" href="#/customer/providers/${esc(provider.id)}">${icon('arrow_back')} Provider profile</a>
      </div>

      <div class="split">
        <form class="card" id="booking-form" novalidate>
          <div id="booking-error"></div>
          <div class="form-row">
            <div class="field">
              <label for="date">Service date</label>
              <input class="input" id="date" name="date" type="date" min="${today}" required />
            </div>
            <div class="field">
              <label for="time">Preferred time</label>
              <input class="input" id="time" name="time" type="time" required />
            </div>
          </div>

          <div class="field">
            <label for="bookingType">Booking type</label>
            <select class="input" id="bookingType" name="bookingType">
              <option value="Regular" ${initialType === 'Regular' ? 'selected' : ''}>Regular — scheduled date and time</option>
              <option value="Quick Service" ${initialType === 'Quick Service' ? 'selected' : ''}>Quick Service — same-day request</option>
            </select>
            <span class="hint">Quick Service requests are sent to the provider immediately.</span>
          </div>

          ${
            services.length
              ? `<div class="field">
                  <label for="serviceId">Service (optional)</label>
                  <select class="input" id="serviceId" name="serviceId">
                    <option value="">General ${esc(provider.categoryName || 'service')}</option>
                    ${services
                      .map(
                        (service) =>
                          `<option value="${esc(service.id)}" data-price="${esc(service.price ?? '')}">${esc(
                            service.title,
                          )}${service.price ? ` — ${esc(formatMoney(service.price))}` : ''}</option>`,
                      )
                      .join('')}
                  </select>
                </div>`
              : ''
          }

          <div class="field">
            <label for="addressSelect">Service address</label>
            <select class="input" id="addressSelect" name="addressSelect">
              ${addresses
                .map(
                  (address) =>
                    `<option value="${esc(addressLine(address))}" ${
                      defaultAddress && address.id === defaultAddress.id ? 'selected' : ''
                    }>${esc(address.label)} — ${esc(addressLine(address))}</option>`,
                )
                .join('')}
              <option value="__new" ${addresses.length ? '' : 'selected'}>Enter a different address…</option>
            </select>
            <span class="hint">Manage saved addresses from <a href="#/customer/addresses" style="color:var(--primary)">Addresses</a>.</span>
          </div>

          <div class="field ${addresses.length ? 'hide' : ''}" id="custom-address-field">
            <label for="customAddress">Full service address</label>
            <input class="input" id="customAddress" name="customAddress" placeholder="Street, building, city" />
          </div>

          <div class="field">
            <label for="description">Describe the problem</label>
            <textarea class="input" id="description" name="description" required
              placeholder="e.g. Kitchen sink is leaking under the cabinet and the tap drips constantly."></textarea>
          </div>

          <div class="btn-row">
            <button class="btn primary" type="submit" data-submit>${icon('check_circle')} Confirm booking</button>
            <a class="btn ghost" href="#/customer/providers">Cancel</a>
          </div>
        </form>

        <aside class="card">
          <h3>Booking summary</h3>
          <div class="row" style="gap:12px">
            <span class="avatar" style="width:42px;height:42px">${esc(initials(providerLabel(provider)))}</span>
            <div>
              <b>${esc(providerLabel(provider))}</b>
              <div class="tiny muted">${esc(provider.categoryName || 'General services')}</div>
            </div>
          </div>
          <dl class="kv mt-2">
            <dt>Rate</dt><dd>${esc(formatMoney(provider.hourlyRate))}</dd>
            <dt>Service area</dt><dd>${esc(provider.city || 'Not specified')}</dd>
            <dt>Status on send</dt><dd><span class="badge pending">pending</span></dd>
          </dl>
          <p class="tiny faint mt-2 mb-0">The provider accepts or rejects this request. You will see the same
          booking record update in your booking history.</p>
        </aside>
      </div>`,
    bind(root) {
      const form = root.querySelector('#booking-form');
      const errorBox = root.querySelector('#booking-error');
      const addressSelect = form.addressSelect;
      const customField = root.querySelector('#custom-address-field');
      const customAddress = form.customAddress;
      let submitting = false;

      addressSelect?.addEventListener('change', () => {
        const isCustom = addressSelect.value === '__new';
        customField.classList.toggle('hide', !isCustom);
        if (isCustom) customAddress?.focus();
      });

      form.addEventListener('submit', async (event) => {
        event.preventDefault();
        if (submitting) return;
        errorBox.innerHTML = '';

        const date = form.date.value;
        const time = form.time.value;
        const description = form.description.value.trim();
        const address =
          addressSelect?.value === '__new' || !addressSelect
            ? (customAddress?.value || '').trim()
            : addressSelect.value;

        if (!date || !time) {
          errorBox.innerHTML = alertBox('error', 'Choose the service date and preferred time.');
          return;
        }
        if (!address) {
          errorBox.innerHTML = alertBox('error', 'Enter the service address.');
          return;
        }
        if (description.length < 10) {
          errorBox.innerHTML = alertBox('error', 'Describe the problem in at least 10 characters.');
          return;
        }

        const bookingType = normalizeBookingType(form.bookingType?.value || initialType);
        const serviceSelect = form.serviceId;
        const selectedService = services.find((service) => String(service.id) === String(serviceSelect?.value));
        const button = form.querySelector('[data-submit]');
        submitting = true;
        setBusy(button, true, 'Sending booking…');

        try {
          const booking = await createBooking({
            customerId: id,
            providerUserId: provider.userId,
            providerProfileId: provider.id,
            serviceId: selectedService?.id || null,
            categoryId: provider.categoryId || null,
            date,
            time,
            address,
            description,
            bookingType,
            amount: selectedService?.price ?? null,
          });

          if (!booking?.id) throw new Error('The booking was not created. Please try again.');
          toast('Booking sent to the provider.');
          ctx.navigate(`/customer/bookings/${booking.id}`);
        } catch (error) {
          errorBox.innerHTML = alertBox('error', friendlyError(error));
          toast('Booking was not created.', 'error');
          submitting = false;
          setBusy(button, false);
        }
      });
    },
  };
}

/* ---------------------------------------------------------------- bookings */

export async function renderBookings(ctx) {
  const id = userId(ctx);
  const [bookings, directory] = await Promise.all([
    listBookingsFor({ customerId: id }),
    loadProviderDirectory().catch(() => ({ providers: [] })),
  ]);
  const nameById = new Map(directory.providers.map((provider) => [String(provider.id), providerLabel(provider)]));
  const filter = ctx.query.get('status') || 'all';
  const filtered = sortByCreated(bookings).filter((booking) => filter === 'all' || booking.status === filter);

  const tabs = ['all', 'pending', 'accepted', 'in_progress', 'completed', 'rejected']
    .map(
      (key) =>
        `<a class="chip ${filter === key ? 'active' : ''}" href="#/customer/bookings?status=${key}">${
          key === 'all' ? 'All' : key.replace('_', ' ')
        } ${key === 'all' ? bookings.length : bookings.filter((b) => b.status === key).length}</a>`,
    )
    .join('');

  return {
    title: 'My bookings',
    html: `
      <div class="page-head">
        <div>
          <div class="eyebrow">Booking history</div>
          <h1>My bookings</h1>
          <p>Every row below is the same record your provider sees and updates.</p>
        </div>
        <div class="btn-row">
          <button class="btn ghost" data-action="reload">${icon('refresh')} Refresh</button>
          <a class="btn primary" href="#/customer/browse">${icon('add')} New booking</a>
        </div>
      </div>
      <div class="row mb-2">${tabs}</div>
      ${
        filtered.length
          ? `<div class="list">${filtered
              .map(
                (booking) => `<a class="list-row" href="#/customer/bookings/${esc(booking.id)}">
                  <span class="icon-tile">${icon('event_note')}</span>
                  <span class="grow">
                    <span class="title">${esc(nameById.get(String(booking.providerId)) || 'Service provider')}</span>
                    <span class="sub truncate">${esc(booking.date ? formatDate(booking.date) : 'Date to confirm')} ·
                      ${esc(formatTime(booking.time))} · ${esc(booking.address || '—')}</span>
                  </span>
                  ${statusBadge(booking.status)}
                  ${icon('chevron_right')}
                </a>`,
              )
              .join('')}</div>`
          : emptyState({
              icon: 'receipt_long',
              title: filter === 'all' ? 'No bookings yet' : `No ${filter.replace('_', ' ')} bookings`,
              message:
                filter === 'all'
                  ? 'Browse a category, pick a provider and create your first booking.'
                  : 'Try a different filter to see your other bookings.',
              action:
                filter === 'all'
                  ? '<a class="btn primary" href="#/customer/browse">Browse services</a>'
                  : '<a class="btn ghost" href="#/customer/bookings">Show all bookings</a>',
            })
      }`,
    bind(root) {
      root.querySelector('[data-action="reload"]')?.addEventListener('click', () => ctx.refresh());
    },
  };
}

const TIMELINE = [
  { key: 'pending', label: 'Booking sent', iconName: 'send' },
  { key: 'accepted', label: 'Provider accepted', iconName: 'task_alt' },
  { key: 'in_progress', label: 'Job in progress', iconName: 'engineering' },
  { key: 'completed', label: 'Job completed', iconName: 'verified' },
];

function timelineHtml(booking) {
  if (['rejected', 'cancelled'].includes(booking.status)) {
    return `<div class="alert ${booking.status === 'rejected' ? 'error' : 'warn'}">
      ${icon(booking.status === 'rejected' ? 'cancel' : 'block')}
      <div><b>Booking ${esc(booking.status)}.</b>${
        booking.rejectionReason ? ` ${esc(booking.rejectionReason)}` : ''
      }</div></div>`;
  }
  const index = TIMELINE.findIndex((step) => step.key === booking.status);
  return `<ul class="timeline">${TIMELINE.map((step, position) => {
    const stateClass = position < index ? 'done' : position === index ? 'current' : '';
    return `<li class="${stateClass}">
      <span class="marker">${icon(position <= index ? 'check' : step.iconName)}</span>
      <span><b>${esc(step.label)}</b>
      <span class="tiny muted" style="display:block">${
        position === index ? 'Current status' : position < index ? 'Completed' : 'Waiting'
      }</span></span>
    </li>`;
  }).join('')}</ul>`;
}

export async function renderBookingDetail(ctx) {
  const bookingId = ctx.params[0];
  const id = userId(ctx);
  const [booking, directory] = await Promise.all([
    getBooking(bookingId),
    loadProviderDirectory().catch(() => ({ providers: [] })),
  ]);

  if (!booking || String(booking.customerId) !== String(id)) {
    return {
      title: 'Booking not found',
      html: emptyState({
        icon: 'receipt_long',
        title: 'Booking not found',
        message: 'This booking does not exist or belongs to another account.',
        action: '<a class="btn primary" href="#/customer/bookings">Back to my bookings</a>',
      }),
    };
  }

  const provider = directory.providers.find((item) => String(item.id) === String(booking.providerId));
  const canCancel = ['pending', 'accepted'].includes(booking.status);

  return {
    title: 'Booking details',
    html: `
      <div class="page-head">
        <div>
          <div class="eyebrow">Booking confirmation</div>
          <h1>Booking ${esc(String(booking.id).slice(0, 8))}</h1>
          <p>Created ${esc(booking.createdAt ? formatDate(booking.createdAt) : 'just now')} · shared with your provider.</p>
        </div>
        <div class="btn-row">
          <button class="btn ghost" data-action="reload">${icon('refresh')} Refresh</button>
          <a class="btn ghost" href="#/customer/bookings">${icon('arrow_back')} All bookings</a>
        </div>
      </div>

      <div class="split">
        <section class="stack">
          <div class="card">
            <div class="card-head"><h3>Job details</h3>${statusBadge(booking.status)}</div>
            <dl class="kv">
              <dt>Date</dt><dd>${esc(booking.date ? formatDate(booking.date) : 'Not set')}</dd>
              <dt>Time</dt><dd>${esc(formatTime(booking.time))}</dd>
              <dt>Address</dt><dd>${esc(booking.address || 'Not set')}</dd>
              <dt>Problem</dt><dd>${esc(booking.description || 'No description provided')}</dd>
              <dt>Amount</dt><dd>${esc(formatMoney(booking.amount))}</dd>
            </dl>
          </div>
          <div class="card">
            <h3>Progress</h3>
            ${timelineHtml(booking)}
          </div>
          ${
            canCancel
              ? `<div class="card">
                  <h3>Need to change something?</h3>
                  <p class="tiny muted">Cancel this request if your plans changed. The provider sees the update immediately.</p>
                  <button class="btn danger sm" data-action="cancel">${icon('cancel')} Cancel booking</button>
                </div>`
              : ''
          }
        </section>

        <aside class="card">
          <h3>Your provider</h3>
          ${
            provider
              ? `<div class="row" style="gap:12px">
                  <span class="avatar" style="width:42px;height:42px">${esc(initials(providerLabel(provider)))}</span>
                  <div><b>${esc(providerLabel(provider))}</b>
                  <div class="tiny muted">${esc(provider.categoryName || 'General services')}</div></div>
                </div>
                <dl class="kv mt-2">
                  <dt>Phone</dt><dd>${esc(provider.profile?.phone || 'Not provided')}</dd>
                  <dt>Email</dt><dd>${esc(provider.profile?.email || 'Not provided')}</dd>
                  <dt>Service area</dt><dd>${esc(provider.city || 'Not specified')}</dd>
                </dl>
                <a class="btn ghost sm block mt-2" href="#/customer/providers/${esc(provider.id)}">View provider profile</a>`
              : `<p class="tiny muted">Provider profile is no longer available, but your booking record is kept.</p>`
          }
        </aside>
      </div>`,
    bind(root) {
      root.querySelector('[data-action="reload"]')?.addEventListener('click', () => ctx.refresh());
      root.querySelector('[data-action="cancel"]')?.addEventListener('click', async (event) => {
        const confirmed = await confirmDialog({
          title: 'Cancel this booking?',
          message: 'The provider will see the booking marked as cancelled.',
          confirmText: 'Cancel booking',
          cancelText: 'Keep booking',
          danger: true,
        });
        if (!confirmed) return;
        const button = event.currentTarget;
        setBusy(button, true, 'Cancelling…');
        try {
          await updateBookingStatus(booking.id, 'cancelled');
          toast('Booking cancelled.');
          ctx.refresh();
        } catch (error) {
          toast(friendlyError(error), 'error');
          setBusy(button, false);
        }
      });
    },
  };
}

/* ------------------------------------------------------------------ profile */

export async function renderProfile(ctx) {
  const profile = ctx.identity.profile;
  const session = ctx.identity.session;

  return {
    title: 'My profile',
    html: `
      <div class="page-head">
        <div>
          <div class="eyebrow">Account</div>
          <h1>My profile</h1>
          <p>These details are stored in the profiles table and shown to providers you book.</p>
        </div>
      </div>
      <div class="split">
        <form class="card" id="profile-form" novalidate>
          <div id="profile-error"></div>
          <div class="field">
            <label for="fullName">Full name</label>
            <input class="input" id="fullName" name="fullName" value="${esc(profile?.fullName || '')}" required />
          </div>
          <div class="field">
            <label for="email">Email address</label>
            <input class="input" id="email" value="${esc(profile?.email || session?.user?.email || '')}" disabled />
            <span class="hint">Your login email is managed by Supabase Authentication.</span>
          </div>
          <div class="form-row">
            <div class="field">
              <label for="phone">Phone number</label>
              <input class="input" id="phone" name="phone" value="${esc(profile?.phone || '')}" placeholder="+254 700 000 000" />
            </div>
            <div class="field">
              <label for="city">City</label>
              <input class="input" id="city" name="city" value="${esc(profile?.city || '')}" placeholder="e.g. Nairobi" />
            </div>
          </div>
          <button class="btn primary" type="submit" data-submit>${icon('save')} Save profile</button>
        </form>

        <aside class="card">
          <h3>Account summary</h3>
          <dl class="kv">
            <dt>Role</dt><dd><span class="badge neutral">${esc(ctx.identity.role)}</span></dd>
            <dt>User ID</dt><dd class="mono">${esc(session?.user?.id || '—')}</dd>
            <dt>Last sign-in</dt><dd>${esc(session?.user?.last_sign_in_at ? formatDate(session.user.last_sign_in_at) : '—')}</dd>
          </dl>
          <p class="tiny faint mt-2 mb-0">Signing out and back in reloads these values from Supabase, so your profile persists.</p>
        </aside>
      </div>`,
    bind(root) {
      const form = root.querySelector('#profile-form');
      const errorBox = root.querySelector('#profile-error');
      form.addEventListener('submit', async (event) => {
        event.preventDefault();
        errorBox.innerHTML = '';
        const fullName = form.fullName.value.trim();
        if (!fullName) {
          errorBox.innerHTML = alertBox('error', 'Enter your full name.');
          return;
        }
        const button = form.querySelector('[data-submit]');
        setBusy(button, true, 'Saving…');
        try {
          await updateProfile(userId(ctx), {
            full_name: fullName,
            phone: form.phone.value.trim(),
            city: form.city.value.trim(),
            email: profile?.email || session?.user?.email || '',
          });
          toast('Profile saved.');
          await ctx.refresh();
        } catch (error) {
          errorBox.innerHTML = alertBox('error', friendlyError(error));
          setBusy(button, false);
        }
      });
    },
  };
}

/* ---------------------------------------------------------------- addresses */

export async function renderAddresses(ctx) {
  const id = userId(ctx);
  const addresses = await listAddresses(id);

  const rows = addresses
    .map(
      (address) => `<div class="list-row" data-address="${esc(address.id)}">
        <span class="icon-tile">${icon('location_on')}</span>
        <span class="grow">
          <span class="title">${esc(address.label)} ${address.isDefault ? '<span class="badge completed">default</span>' : ''}</span>
          <span class="sub">${esc(addressLine(address) || 'No details')}</span>
        </span>
        ${
          address.isDefault
            ? ''
            : `<button class="btn ghost sm" data-action="default" data-id="${esc(address.id)}">Make default</button>`
        }
        <button class="btn danger sm" data-action="delete" data-id="${esc(address.id)}">${icon('delete')}</button>
      </div>`,
    )
    .join('');

  return {
    title: 'Saved addresses',
    html: `
      <div class="page-head">
        <div>
          <div class="eyebrow">Booking preferences</div>
          <h1>Saved addresses</h1>
          <p>Reuse these addresses when you create a booking.</p>
        </div>
        <button class="btn ghost" data-action="reload">${icon('refresh')} Refresh</button>
      </div>
      <div class="split">
        <section class="card">
          <h3>Your addresses</h3>
          ${
            rows
              ? `<div class="list">${rows}</div>`
              : emptyState({
                  icon: 'location_off',
                  title: 'No saved addresses',
                  message: 'Add your home or office address to speed up future bookings.',
                })
          }
        </section>
        <form class="card" id="address-form" novalidate>
          <h3>Add an address</h3>
          <div id="address-error"></div>
          <div class="field">
            <label for="label">Label</label>
            <input class="input" id="label" name="label" placeholder="Home, Office…" />
          </div>
          <div class="field">
            <label for="line">Address line</label>
            <input class="input" id="line" name="line" placeholder="Street, building, apartment" required />
          </div>
          <div class="form-row">
            <div class="field">
              <label for="city">City</label>
              <input class="input" id="city" name="city" />
            </div>
            <div class="field">
              <label for="postalCode">Postal code</label>
              <input class="input" id="postalCode" name="postalCode" />
            </div>
          </div>
          <div class="field">
            <label for="state">State / county</label>
            <input class="input" id="state" name="state" />
          </div>
          <label class="row tiny muted" style="gap:8px">
            <input type="checkbox" name="isDefault" /> Set as default address
          </label>
          <button class="btn primary block mt-2" type="submit" data-submit>${icon('add')} Save address</button>
        </form>
      </div>`,
    bind(root) {
      root.querySelector('[data-action="reload"]')?.addEventListener('click', () => ctx.refresh());

      root.addEventListener('click', async (event) => {
        const button = event.target.closest('[data-action="delete"]');
        if (button) {
          const confirmed = await confirmDialog({
            title: 'Delete this address?',
            message: 'Bookings already created keep their service address.',
            confirmText: 'Delete',
            danger: true,
          });
          if (!confirmed) return;
          setBusy(button, true, '');
          try {
            await deleteAddress(button.dataset.id);
            toast('Address deleted.');
            ctx.refresh();
          } catch (error) {
            toast(friendlyError(error), 'error');
            setBusy(button, false);
          }
          return;
        }
        const makeDefault = event.target.closest('[data-action="default"]');
        if (makeDefault) {
          setBusy(makeDefault, true, '');
          try {
            await setDefaultAddress(id, makeDefault.dataset.id);
            toast('Default address updated.');
            ctx.refresh();
          } catch (error) {
            toast(friendlyError(error), 'error');
            setBusy(makeDefault, false);
          }
        }
      });

      const form = root.querySelector('#address-form');
      const errorBox = root.querySelector('#address-error');
      form.addEventListener('submit', async (event) => {
        event.preventDefault();
        errorBox.innerHTML = '';
        const line = form.line.value.trim();
        if (!line) {
          errorBox.innerHTML = alertBox('error', 'Enter the address line.');
          return;
        }
        const button = form.querySelector('[data-submit]');
        setBusy(button, true, 'Saving…');
        try {
          await addAddress(id, {
            label: form.label.value.trim() || 'Home',
            line,
            city: form.city.value.trim(),
            state: form.state.value.trim(),
            postalCode: form.postalCode.value.trim(),
            isDefault: form.isDefault.checked,
          });
          toast('Address saved.');
          ctx.refresh();
        } catch (error) {
          errorBox.innerHTML = alertBox('error', friendlyError(error));
          setBusy(button, false);
        }
      });
    },
  };
}
