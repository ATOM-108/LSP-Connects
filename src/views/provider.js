import {
  getProviderForUser,
  loadProviderDirectory,
  listProviderServices,
  listProviderSkills,
  addProviderService,
  removeProviderService,
  addProviderSkill,
  removeProviderSkill,
  updateProviderProfile,
  setProviderAvailability,
  updateProfile,
  listBookingsFor,
  getBooking,
  updateBookingStatus,
  listCategories,
} from '../lib/api.js';
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

async function requireProvider(ctx) {
  const provider = ctx.provider || (await getProviderForUser(userId(ctx)));
  return provider;
}

function sortByCreated(rows) {
  return [...rows].sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
}

async function providerBookings(ctx, provider) {
  if (!provider) return { bookings: [], nameById: new Map() };
  const [bookings, directory] = await Promise.all([
    listBookingsFor({ providerUserId: userId(ctx), providerProfileId: provider.id }),
    loadProviderDirectory().catch(() => ({ profileById: new Map() })),
  ]);
  const nameById = new Map();
  directory.profileById?.forEach((profile, key) => nameById.set(String(key), profile));
  return { bookings, nameById };
}

function customerName(nameById, booking) {
  const profile = nameById.get(String(booking.customerId));
  return profile?.fullName || 'Customer';
}

function providerMissing(provider) {
  return {
    title: 'Provider profile not ready',
    html: emptyState({
      icon: 'storefront',
      title: 'Create your provider profile',
      message:
        'Your account exists, but no provider_profiles row is linked to it yet. Add your business details so customers can find and book you.',
      action: '<a class="btn primary" href="#/provider/profile">Set up provider profile</a>',
    }),
  };
}

/* ---------------------------------------------------------------- dashboard */

export async function renderDashboard(ctx) {
  const provider = await requireProvider(ctx);
  if (!provider) return providerMissing(ctx);

  const { bookings, nameById } = await providerBookings(ctx, provider);
  const pending = bookings.filter((booking) => booking.status === 'pending');
  const active = bookings.filter((booking) => ['accepted', 'in_progress'].includes(booking.status));
  const completed = bookings.filter((booking) => booking.status === 'completed');
  const recent = sortByCreated(bookings).slice(0, 5);
  const businessName = provider.businessName || ctx.identity.profile?.fullName || 'Provider';

  return {
    title: 'Provider dashboard',
    html: `
      <div class="page-head">
        <div>
          <div class="eyebrow">Provider dashboard</div>
          <h1>${esc(businessName)}</h1>
          <p>Incoming customer bookings for your provider profile, loaded from Supabase.</p>
        </div>
        <div class="btn-row">
          <button class="btn ghost" data-action="reload">${icon('refresh')} Refresh</button>
          <button class="btn ${provider.isAvailable ? 'primary' : 'ghost'}" data-action="toggle-availability">
            ${icon(provider.isAvailable ? 'toggle_on' : 'toggle_off')}
            ${provider.isAvailable ? 'Available for work' : 'Not available'}
          </button>
        </div>
      </div>

      ${pending.length ? alertBox('warn', `You have ${pending.length} booking request${pending.length === 1 ? '' : 's'} waiting for a response.`) : ''}

      <div class="grid cols-4 mb-2">
        <div class="card stat"><span class="value">${pending.length}</span><span class="label">New requests</span></div>
        <div class="card stat"><span class="value">${active.length}</span><span class="label">Active jobs</span></div>
        <div class="card stat"><span class="value">${completed.length}</span><span class="label">Completed</span></div>
        <div class="card stat"><span class="value">${bookings.length}</span><span class="label">All bookings</span></div>
      </div>

      <div class="split">
        <section class="card">
          <div class="card-head">
            <h3>Latest bookings</h3>
            <a class="btn ghost sm" href="#/provider/bookings">View all</a>
          </div>
          ${
            recent.length
              ? `<div class="list">${recent
                  .map(
                    (booking) => `<a class="list-row" href="#/provider/bookings/${esc(booking.id)}">
                      <span class="icon-tile">${icon('assignment')}</span>
                      <span class="grow">
                        <span class="title">${esc(customerName(nameById, booking))}</span>
                        <span class="sub truncate">${esc(
                          booking.date ? formatDate(booking.date) : 'Date to confirm',
                        )} · ${esc(formatTime(booking.time))} · ${esc(booking.address || '—')}</span>
                      </span>
                      ${statusBadge(booking.status)}
                    </a>`,
                  )
                  .join('')}</div>`
              : emptyState({
                  icon: 'inbox',
                  title: 'No bookings yet',
                  message:
                    'When a customer books your profile, the request appears here immediately. Make sure your profile is complete and available.',
                })
          }
        </section>

        <aside class="stack">
          <div class="card">
            <div class="card-head"><h3>Profile</h3><a class="btn ghost sm" href="#/provider/profile">Edit</a></div>
            <div class="row" style="gap:12px">
              <span class="avatar" style="width:44px;height:44px;font-size:15px">${esc(initials(businessName))}</span>
              <div>
                <b>${esc(businessName)}</b>
                <div class="tiny muted">${esc(provider.categoryName || 'Category not set')}</div>
              </div>
            </div>
            <dl class="kv mt-2">
              <dt>Phone</dt><dd>${esc(ctx.identity.profile?.phone || 'Not set')}</dd>
              <dt>City</dt><dd>${esc(provider.city || 'Not set')}</dd>
              <dt>Rate</dt><dd>${esc(formatMoney(provider.hourlyRate))}</dd>
              <dt>Status</dt><dd><span class="badge ${provider.isAvailable ? 'completed' : 'neutral'}">${
                provider.isAvailable ? 'available' : 'unavailable'
              }</span></dd>
            </dl>
          </div>
          <div class="card">
            <div class="card-head"><h3>Services</h3><a class="btn ghost sm" href="#/provider/services">Manage</a></div>
            <p class="tiny muted mb-0">Add your services and skills so customers can pick the right job before booking.</p>
          </div>
        </aside>
      </div>`,
    bind(root) {
      root.querySelector('[data-action="reload"]')?.addEventListener('click', () => ctx.refresh());
      root.querySelector('[data-action="toggle-availability"]')?.addEventListener('click', async (event) => {
        const button = event.currentTarget;
        setBusy(button, true, 'Saving…');
        try {
          await setProviderAvailability(provider.id, !provider.isAvailable);
          toast(provider.isAvailable ? 'You are now marked unavailable.' : 'You are now available for work.');
          ctx.refresh();
        } catch (error) {
          toast(friendlyError(error), 'error');
          setBusy(button, false);
        }
      });
    },
  };
}

/* ----------------------------------------------------------------- bookings */

export async function renderBookings(ctx) {
  const provider = await requireProvider(ctx);
  if (!provider) return providerMissing(ctx);

  const { bookings, nameById } = await providerBookings(ctx, provider);
  const filter = ctx.query.get('status') || 'all';
  const filtered = sortByCreated(bookings).filter((booking) => filter === 'all' || booking.status === filter);

  const tabs = ['all', 'pending', 'accepted', 'in_progress', 'completed', 'rejected']
    .map(
      (key) =>
        `<a class="chip ${filter === key ? 'active' : ''}" href="#/provider/bookings?status=${key}">${
          key === 'all' ? 'All' : key.replace('_', ' ')
        } ${key === 'all' ? bookings.length : bookings.filter((b) => b.status === key).length}</a>`,
    )
    .join('');

  return {
    title: 'Bookings',
    html: `
      <div class="page-head">
        <div>
          <div class="eyebrow">Customer requests</div>
          <h1>Bookings</h1>
          <p>These are the exact records customers created — accept, reject or progress them here.</p>
        </div>
        <button class="btn ghost" data-action="reload">${icon('refresh')} Refresh</button>
      </div>
      <div class="row mb-2">${tabs}</div>
      ${
        filtered.length
          ? `<div class="list">${filtered
              .map(
                (booking) => `<a class="list-row" href="#/provider/bookings/${esc(booking.id)}">
                  <span class="icon-tile">${icon('assignment')}</span>
                  <span class="grow">
                    <span class="title">${esc(customerName(nameById, booking))}</span>
                    <span class="sub truncate">${esc(
                      booking.date ? formatDate(booking.date) : 'Date to confirm',
                    )} · ${esc(formatTime(booking.time))} · ${esc(booking.address || '—')}</span>
                  </span>
                  ${statusBadge(booking.status)}
                  ${icon('chevron_right')}
                </a>`,
              )
              .join('')}</div>`
          : emptyState({
              icon: 'inbox',
              title: filter === 'all' ? 'No bookings yet' : `No ${filter.replace('_', ' ')} bookings`,
              message:
                filter === 'all'
                  ? 'Customer bookings will appear here as soon as they are created against your provider profile.'
                  : 'Try another filter to see your other bookings.',
              action: filter === 'all' ? '' : '<a class="btn ghost" href="#/provider/bookings">Show all bookings</a>',
            })
      }`,
    bind(root) {
      root.querySelector('[data-action="reload"]')?.addEventListener('click', () => ctx.refresh());
    },
  };
}

const NEXT_ACTIONS = {
  pending: [
    { status: 'accepted', label: 'Accept booking', iconName: 'task_alt', kind: 'primary' },
    { status: 'rejected', label: 'Reject booking', iconName: 'cancel', kind: 'danger' },
  ],
  accepted: [{ status: 'in_progress', label: 'Start job', iconName: 'play_arrow', kind: 'primary' }],
  in_progress: [{ status: 'completed', label: 'Mark completed', iconName: 'verified', kind: 'primary' }],
};

export async function renderBookingDetail(ctx) {
  const provider = await requireProvider(ctx);
  if (!provider) return providerMissing(ctx);

  const bookingId = ctx.params[0];
  const [booking, directory] = await Promise.all([
    getBooking(bookingId),
    loadProviderDirectory().catch(() => ({ profileById: new Map() })),
  ]);

  const belongs =
    booking &&
    (String(booking.providerId) === String(provider.id) || String(booking.providerId) === String(userId(ctx)));

  if (!booking || !belongs) {
    return {
      title: 'Booking not found',
      html: emptyState({
        icon: 'search_off',
        title: 'Booking not available',
        message: 'This booking does not belong to your provider profile.',
        action: '<a class="btn primary" href="#/provider/bookings">Back to bookings</a>',
      }),
    };
  }

  const customer = directory.profileById?.get(String(booking.customerId));
  const actions = NEXT_ACTIONS[booking.status] || [];

  return {
    title: 'Booking details',
    html: `
      <div class="page-head">
        <div>
          <div class="eyebrow">Booking ${esc(String(booking.id).slice(0, 8))}</div>
          <h1>${esc(customer?.fullName || 'Customer request')}</h1>
          <p>Received ${esc(booking.createdAt ? formatDate(booking.createdAt) : 'just now')} · status updates save to Supabase.</p>
        </div>
        <div class="btn-row">
          <button class="btn ghost" data-action="reload">${icon('refresh')} Refresh</button>
          <a class="btn ghost" href="#/provider/bookings">${icon('arrow_back')} All bookings</a>
        </div>
      </div>

      <div class="split">
        <section class="stack">
          <div class="card">
            <div class="card-head"><h3>Job details</h3>${statusBadge(booking.status)}</div>
            <dl class="kv">
              <dt>Service date</dt><dd>${esc(booking.date ? formatDate(booking.date) : 'Not set')}</dd>
              <dt>Preferred time</dt><dd>${esc(formatTime(booking.time))}</dd>
              <dt>Service address</dt><dd>${esc(booking.address || 'Not set')}</dd>
              <dt>Problem description</dt><dd>${esc(booking.description || 'No description provided')}</dd>
              <dt>Agreed amount</dt><dd>${esc(formatMoney(booking.amount))}</dd>
            </dl>
          </div>

          <div class="card">
            <h3>Update this booking</h3>
            <div id="action-error"></div>
            ${
              actions.length
                ? `<div class="btn-row">${actions
                    .map(
                      (action) =>
                        `<button class="btn ${action.kind}" data-status="${action.status}">${icon(action.iconName)} ${
                          action.label
                        }</button>`,
                    )
                    .join('')}</div>
                    <p class="tiny faint mt-2 mb-0">Accepting updates the existing booking record — the customer sees the new status immediately.</p>`
                : `<p class="tiny muted mb-0">This booking is ${esc(
                    booking.status,
                  )}. No further action is needed.</p>`
            }
          </div>
        </section>

        <aside class="card">
          <h3>Customer</h3>
          <div class="row" style="gap:12px">
            <span class="avatar" style="width:42px;height:42px">${esc(initials(customer?.fullName || 'Customer'))}</span>
            <div>
              <b>${esc(customer?.fullName || 'Customer')}</b>
              <div class="tiny muted">${esc(customer?.city || 'Location not shared')}</div>
            </div>
          </div>
          <dl class="kv mt-2">
            <dt>Phone</dt><dd>${esc(customer?.phone || 'Not shared')}</dd>
            <dt>Email</dt><dd>${esc(customer?.email || 'Not shared')}</dd>
          </dl>
          <p class="tiny faint mt-2 mb-0">Customer contact details come from the profiles table.</p>
        </aside>
      </div>`,
    bind(root) {
      root.querySelector('[data-action="reload"]')?.addEventListener('click', () => ctx.refresh());
      const errorBox = root.querySelector('#action-error');
      let busy = false;

      root.querySelectorAll('[data-status]').forEach((button) => {
        button.addEventListener('click', async () => {
          if (busy) return;
          const status = button.dataset.status;
          let extra = {};

          if (status === 'rejected') {
            const confirmed = await confirmDialog({
              title: 'Reject this booking?',
              message: 'The customer will see the booking marked as rejected.',
              confirmText: 'Reject booking',
              cancelText: 'Keep booking',
              danger: true,
              withReason: true,
              reasonLabel: 'Reason (optional)',
            });
            if (!confirmed) return;
            extra = { rejection_reason: confirmed.reason || 'Provider unavailable for this request.' };
          }
          if (status === 'completed') {
            const confirmed = await confirmDialog({
              title: 'Mark this job completed?',
              message: 'This closes the job and updates the customer’s tracking view.',
              confirmText: 'Mark completed',
              cancelText: 'Not yet',
            });
            if (!confirmed) return;
          }

          busy = true;
          errorBox.innerHTML = '';
          setBusy(button, true, 'Saving…');
          try {
            const updated = await updateBookingStatus(booking.id, status, extra);
            if (!updated) throw new Error('The booking was not updated.');
            toast(`Booking marked ${status.replace('_', ' ')}.`);
            ctx.refresh();
          } catch (error) {
            errorBox.innerHTML = alertBox('error', friendlyError(error));
            toast('Status change failed.', 'error');
            busy = false;
            setBusy(button, false);
          }
        });
      });
    },
  };
}

/* --------------------------------------------------------- services & skills */

export async function renderServices(ctx) {
  const provider = await requireProvider(ctx);
  if (!provider) return providerMissing(ctx);

  const [services, skills] = await Promise.all([
    listProviderServices(provider.id),
    listProviderSkills(provider.id),
  ]);

  return {
    title: 'Services & skills',
    html: `
      <div class="page-head">
        <div>
          <div class="eyebrow">What you offer</div>
          <h1>Services & skills</h1>
          <p>Customers see these when they open your provider profile and when they book you.</p>
        </div>
        <button class="btn ghost" data-action="reload">${icon('refresh')} Refresh</button>
      </div>
      <div class="split">
        <section class="card">
          <h3>Your services</h3>
          ${
            services.length
              ? `<div class="list">${services
                  .map(
                    (service) => `<div class="list-row">
                      <span class="icon-tile">${icon('design_services')}</span>
                      <span class="grow">
                        <span class="title">${esc(service.title)}</span>
                        <span class="sub tiny truncate">${esc(service.description || 'No description')}</span>
                      </span>
                      <b class="tiny">${esc(formatMoney(service.price))}</b>
                      <button class="btn danger sm" data-remove-service="${esc(service.id)}">${icon('delete')}</button>
                    </div>`,
                  )
                  .join('')}</div>`
              : '<p class="tiny muted mb-0">No services listed yet. Add your first service below.</p>'
          }
          <form id="service-form" class="mt-2" novalidate>
            <div id="service-error"></div>
            <div class="field">
              <label for="title">Service title</label>
              <input class="input" id="title" name="title" placeholder="e.g. Leak repair" required />
            </div>
            <div class="form-row">
              <div class="field">
                <label for="price">Price</label>
                <input class="input" id="price" name="price" type="number" min="0" step="0.01" placeholder="45" />
              </div>
              <div class="field">
                <label for="description">Short description</label>
                <input class="input" id="description" name="description" placeholder="What is included" />
              </div>
            </div>
            <button class="btn primary" type="submit" data-submit>${icon('add')} Add service</button>
          </form>
        </section>

        <aside class="card">
          <h3>Skills</h3>
          ${
            skills.length
              ? `<div class="row">${skills
                  .map(
                    (skill) => `<span class="badge neutral">${esc(skill.name)}
                      <button class="btn ghost sm" data-remove-skill="${esc(skill.id)}" title="Remove">${icon(
                        'close',
                      )}</button></span>`,
                  )
                  .join('')}</div>`
              : '<p class="tiny muted">No skills listed yet.</p>'
          }
          <form id="skill-form" class="mt-2" novalidate>
            <div class="field">
              <label for="skill">Add a skill</label>
              <input class="input" id="skill" name="skill" placeholder="e.g. Pipe fitting" />
            </div>
            <button class="btn ghost" type="submit" data-submit>${icon('add')} Add skill</button>
          </form>
        </aside>
      </div>`,
    bind(root) {
      root.querySelector('[data-action="reload"]')?.addEventListener('click', () => ctx.refresh());

      root.addEventListener('click', async (event) => {
        const removeService = event.target.closest('[data-remove-service]');
        if (removeService) {
          const confirmed = await confirmDialog({
            title: 'Remove this service?',
            message: 'Existing bookings keep their details. Customers will no longer see this service.',
            confirmText: 'Remove',
            danger: true,
          });
          if (!confirmed) return;
          try {
            await removeProviderService(removeService.dataset.removeService);
            toast('Service removed.');
            ctx.refresh();
          } catch (error) {
            toast(friendlyError(error), 'error');
          }
          return;
        }
        const removeSkill = event.target.closest('[data-remove-skill]');
        if (removeSkill) {
          try {
            await removeProviderSkill(removeSkill.dataset.removeSkill);
            toast('Skill removed.');
            ctx.refresh();
          } catch (error) {
            toast(friendlyError(error), 'error');
          }
        }
      });

      const serviceForm = root.querySelector('#service-form');
      serviceForm.addEventListener('submit', async (event) => {
        event.preventDefault();
        const errorBox = root.querySelector('#service-error');
        errorBox.innerHTML = '';
        const title = serviceForm.title.value.trim();
        if (!title) {
          errorBox.innerHTML = alertBox('error', 'Enter a service title.');
          return;
        }
        const button = serviceForm.querySelector('[data-submit]');
        setBusy(button, true, 'Adding…');
        try {
          await addProviderService(provider.id, {
            title,
            price: serviceForm.price.value,
            description: serviceForm.description.value.trim(),
          });
          toast('Service added.');
          ctx.refresh();
        } catch (error) {
          errorBox.innerHTML = alertBox('error', friendlyError(error));
          setBusy(button, false);
        }
      });

      const skillForm = root.querySelector('#skill-form');
      skillForm.addEventListener('submit', async (event) => {
        event.preventDefault();
        const name = skillForm.skill.value.trim();
        if (!name) return;
        const button = skillForm.querySelector('[data-submit]');
        setBusy(button, true, 'Adding…');
        try {
          await addProviderSkill(provider.id, name);
          toast('Skill added.');
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
  const provider = await requireProvider(ctx);
  const profile = ctx.identity.profile;
  const categories = await listCategories().catch(() => []);

  return {
    title: 'Provider profile',
    html: `
      <div class="page-head">
        <div>
          <div class="eyebrow">Public profile</div>
          <h1>Provider profile</h1>
          <p>Customers see this information when they browse providers.</p>
        </div>
      </div>
      <div class="split">
        <form class="card" id="provider-form" novalidate>
          <div id="provider-error"></div>
          <div class="form-row">
            <div class="field">
              <label for="fullName">Your name</label>
              <input class="input" id="fullName" name="fullName" value="${esc(profile?.fullName || '')}" required />
            </div>
            <div class="field">
              <label for="phone">Phone number</label>
              <input class="input" id="phone" name="phone" value="${esc(profile?.phone || '')}" />
            </div>
          </div>
          <div class="field">
            <label for="businessName">Business / trading name</label>
            <input class="input" id="businessName" name="businessName" value="${esc(provider?.businessName || '')}" required />
          </div>
          <div class="form-row">
            <div class="field">
              <label for="categoryId">Service category</label>
              <select class="input" id="categoryId" name="categoryId">
                <option value="">Select a category</option>
                ${categories
                  .map(
                    (category) =>
                      `<option value="${esc(category.id)}" ${
                        String(provider?.categoryId) === String(category.id) ? 'selected' : ''
                      }>${esc(category.name)}</option>`,
                  )
                  .join('')}
              </select>
            </div>
            <div class="field">
              <label for="city">Service area / city</label>
              <input class="input" id="city" name="city" value="${esc(provider?.city || '')}" />
            </div>
          </div>
          <div class="form-row">
            <div class="field">
              <label for="yearsExperience">Years of experience</label>
              <input class="input" id="yearsExperience" name="yearsExperience" type="number" min="0" max="60"
                value="${esc(provider?.yearsExperience ?? '')}" />
            </div>
            <div class="field">
              <label for="hourlyRate">Hourly rate</label>
              <input class="input" id="hourlyRate" name="hourlyRate" type="number" min="0" step="0.01"
                value="${esc(provider?.hourlyRate ?? '')}" />
            </div>
          </div>
          <div class="field">
            <label for="bio">About your service</label>
            <textarea class="input" id="bio" name="bio" placeholder="Describe your experience and what you offer">${esc(
              provider?.bio || '',
            )}</textarea>
          </div>
          <button class="btn primary" type="submit" data-submit>${icon('save')} Save provider profile</button>
        </form>

        <aside class="card">
          <h3>How customers see you</h3>
          <div class="row" style="gap:12px">
            <span class="avatar" style="width:44px;height:44px">${esc(
              initials(provider?.businessName || profile?.fullName || 'Provider'),
            )}</span>
            <div>
              <b>${esc(provider?.businessName || 'Business name not set')}</b>
              <div class="tiny muted">${esc(provider?.categoryName || 'Category not set')}</div>
            </div>
          </div>
          <dl class="kv mt-2">
            <dt>Rate</dt><dd>${esc(formatMoney(provider?.hourlyRate))}</dd>
            <dt>City</dt><dd>${esc(provider?.city || 'Not set')}</dd>
            <dt>Availability</dt><dd><span class="badge ${
              provider?.isAvailable ? 'completed' : 'neutral'
            }">${provider?.isAvailable ? 'available' : 'unavailable'}</span></dd>
          </dl>
          ${
            provider
              ? ''
              : alertBox(
                  'warn',
                  'No provider profile exists for this account yet. Saving this form creates the provider_profiles row.',
                )
          }
        </aside>
      </div>`,
    bind(root) {
      const form = root.querySelector('#provider-form');
      const errorBox = root.querySelector('#provider-error');
      form.addEventListener('submit', async (event) => {
        event.preventDefault();
        errorBox.innerHTML = '';
        const fullName = form.fullName.value.trim();
        const businessName = form.businessName.value.trim();
        if (!fullName || !businessName) {
          errorBox.innerHTML = alertBox('error', 'Your name and business name are required.');
          return;
        }

        const button = form.querySelector('[data-submit]');
        setBusy(button, true, 'Saving…');
        try {
          await updateProfile(userId(ctx), {
            full_name: fullName,
            phone: form.phone.value.trim(),
            city: form.city.value.trim(),
            email: profile?.email || ctx.identity.session?.user?.email || '',
          });

          const payload = {
            business_name: businessName,
            service_category_id: form.categoryId.value || null,
            city: form.city.value.trim(),
            years_experience: form.yearsExperience.value === '' ? null : Number(form.yearsExperience.value),
            hourly_rate: form.hourlyRate.value === '' ? null : Number(form.hourlyRate.value),
            bio: form.bio.value.trim(),
          };

          if (provider) {
            await updateProviderProfile(provider.id, payload);
          } else {
            const { createProviderProfile } = await import('../lib/api.js');
            await createProviderProfile({
              userId: userId(ctx),
              businessName,
              categoryId: form.categoryId.value || null,
              yearsExperience: form.yearsExperience.value,
              city: form.city.value.trim(),
              hourlyRate: form.hourlyRate.value,
              bio: form.bio.value.trim(),
            });
          }

          toast('Provider profile saved.');
          await ctx.reloadIdentity();
          ctx.refresh();
        } catch (error) {
          errorBox.innerHTML = alertBox('error', friendlyError(error));
          setBusy(button, false);
        }
      });
    },
  };
}

/* -------------------------------------------------------------- availability */

export async function renderAvailability(ctx) {
  const provider = await requireProvider(ctx);
  if (!provider) return providerMissing(ctx);

  const { bookings, nameById } = await providerBookings(ctx, provider);
  const upcoming = bookings
    .filter((booking) => ['pending', 'accepted', 'in_progress'].includes(booking.status))
    .sort((a, b) => String(a.date || '').localeCompare(String(b.date || '')));

  return {
    title: 'Availability',
    html: `
      <div class="page-head">
        <div>
          <div class="eyebrow">Manage availability</div>
          <h1>Availability</h1>
          <p>Control whether new customers can book you, and review the jobs you have committed to.</p>
        </div>
        <button class="btn ghost" data-action="reload">${icon('refresh')} Refresh</button>
      </div>
      <div class="split">
        <section class="card">
          <h3>Booking availability</h3>
          <div class="row" style="justify-content:space-between;align-items:center;gap:16px">
            <div>
              <b>${provider.isAvailable ? 'Available for new bookings' : 'Not accepting new bookings'}</b>
              <p class="tiny muted mb-0">${
                provider.isAvailable
                  ? 'Your profile shows as available to customers.'
                  : 'Customers still see your profile, marked as busy.'
              }</p>
            </div>
            <button class="btn ${provider.isAvailable ? 'danger' : 'primary'}" data-action="toggle">
              ${icon(provider.isAvailable ? 'toggle_off' : 'toggle_on')}
              ${provider.isAvailable ? 'Set unavailable' : 'Set available'}
            </button>
          </div>
        </section>

        <aside class="card">
          <h3>Committed jobs</h3>
          ${
            upcoming.length
              ? `<div class="list">${upcoming
                  .slice(0, 6)
                  .map(
                    (booking) => `<a class="list-row" href="#/provider/bookings/${esc(booking.id)}">
                      <span class="grow">
                        <span class="title tiny">${esc(formatDate(booking.date))} · ${esc(formatTime(booking.time))}</span>
                        <span class="sub tiny truncate">${esc(customerName(nameById, booking))}</span>
                      </span>
                      ${statusBadge(booking.status)}
                    </a>`,
                  )
                  .join('')}</div>`
              : '<p class="tiny muted mb-0">No committed jobs yet.</p>'
          }
        </aside>
      </div>`,
    bind(root) {
      root.querySelector('[data-action="reload"]')?.addEventListener('click', () => ctx.refresh());
      root.querySelector('[data-action="toggle"]')?.addEventListener('click', async (event) => {
        const button = event.currentTarget;
        setBusy(button, true, 'Saving…');
        try {
          await setProviderAvailability(provider.id, !provider.isAvailable);
          toast('Availability updated.');
          ctx.refresh();
        } catch (error) {
          toast(friendlyError(error), 'error');
          setBusy(button, false);
        }
      });
    },
  };
}
