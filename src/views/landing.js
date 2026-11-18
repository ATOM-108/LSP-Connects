import { listCategories, loadProviderDirectory } from '../lib/api.js';
import { esc, icon } from '../ui.js';

export async function render(ctx) {
  const { identity } = ctx;
  const signedIn = Boolean(identity.session);

  let categories = [];
  let providerCount = 0;
  try {
    const [cats, directory] = await Promise.all([listCategories(), loadProviderDirectory()]);
    categories = cats;
    providerCount = directory.providers.length;
    if (!categories.length) {
      categories = [
        ...new Set(
          directory.providers.map((provider) => provider.categoryName).filter(Boolean),
        ),
      ].map((name) => ({ id: '', name }));
    }
  } catch (error) {
    console.warn('[LSP] landing data failed:', error.message);
  }

  const categoryCards = categories
    .slice(0, 6)
    .map(
      (category) => `
      <a class="card interactive" href="#/customer/browse">
        <span class="icon-tile">${icon('home_repair_service')}</span>
        <h3 class="mt-2">${esc(category.name)}</h3>
        <p class="muted tiny mb-0">${esc(category.description || 'Verified local professionals')}</p>
      </a>`,
    )
    .join('');

  return {
    title: 'Home',
    html: `
      <section class="hero">
        <div>
          <div class="eyebrow">Local service marketplace</div>
          <h1>Book trusted local professionals in minutes.</h1>
          <p class="lead">LSP Connect links customers with verified service providers — plumbing, electrical,
          cleaning, repairs and more. One booking record, shared by both sides, updated live.</p>
          <div class="btn-row mt-2">
            ${
              signedIn
                ? `<a class="btn primary" href="#${identity.role === 'provider' ? '/provider' : identity.role === 'admin' ? '/admin' : '/customer'}">Continue to dashboard ${icon('arrow_forward')}</a>`
                : `<a class="btn primary" href="#/login/customer">${icon('person')} Customer sign in</a>
                   <a class="btn ghost" href="#/login/provider">${icon('handyman')} Provider sign in</a>`
            }
          </div>
          <p class="tiny faint mt-2">${providerCount} provider profile${providerCount === 1 ? '' : 's'} registered ·
          ${categories.length} service categor${categories.length === 1 ? 'y' : 'ies'}</p>
        </div>
        <div class="grid" style="gap:12px">
          <a class="role-card" href="#/register/customer">
            ${icon('person_add')}
            <b>I need a service</b>
            <span>Create a customer account, browse providers and book a job.</span>
          </a>
          <a class="role-card" href="#/register/provider">
            ${icon('engineering')}
            <b>I provide services</b>
            <span>Create a provider account, publish your services and accept jobs.</span>
          </a>
          <a class="role-card" href="#/login/admin">
            ${icon('admin_panel_settings')}
            <b>Admin demo</b>
            <span>Read-only overview of platform activity for demonstration.</span>
          </a>
        </div>
      </section>

      <section class="mt-3">
        <div class="page-head">
          <div>
            <h2>How LSP Connect works</h2>
            <p>Every step below is backed by the same Supabase record.</p>
          </div>
        </div>
        <div class="grid cols-3">
          <div class="card">
            <span class="icon-tile">${icon('search')}</span>
            <h3 class="mt-2">1. Find a provider</h3>
            <p class="muted mb-0">Browse a category and compare providers by city, rate and availability.</p>
          </div>
          <div class="card">
            <span class="icon-tile">${icon('event')}</span>
            <h3 class="mt-2">2. Send a booking</h3>
            <p class="muted mb-0">Pick a date, time and address, describe the problem and confirm.</p>
          </div>
          <div class="card">
            <span class="icon-tile">${icon('task_alt')}</span>
            <h3 class="mt-2">3. Track the job</h3>
            <p class="muted mb-0">The provider accepts or rejects it, and the status updates for both sides.</p>
          </div>
        </div>
      </section>

      ${
        categoryCards
          ? `<section class="mt-3">
              <h2>Service categories</h2>
              <p class="muted">Sign in as a customer to browse providers in each category.</p>
              <div class="grid auto">${categoryCards}</div>
            </section>`
          : ''
      }
    `,
  };
}
