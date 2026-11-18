import { loadAdminSnapshot } from '../lib/api.js';
import { esc, icon, formatDate, statusBadge, emptyState } from '../ui.js';

// Admin is intentionally a read-only demonstration module: it shows live counts
// from the same tables the customer and provider modules use, nothing more.
export async function render(ctx) {
  let snapshot = { profiles: [], providers: [], bookings: [], categories: [] };
  let loadError = '';
  try {
    snapshot = await loadAdminSnapshot();
  } catch (error) {
    loadError = error.message || 'Could not load the overview.';
  }

  const { profiles, providers, bookings, categories } = snapshot;
  const customers = profiles.filter((profile) => profile?.role === 'customer');
  const pending = bookings.filter((booking) => booking.status === 'pending');
  const recent = [...bookings]
    .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0))
    .slice(0, 8);

  return {
    title: 'Admin overview',
    html: `
      <div class="page-head">
        <div>
          <div class="eyebrow">Admin demonstration</div>
          <h1>Platform overview</h1>
          <p>Read-only counts from the live Supabase tables used by customers and providers.</p>
        </div>
        <button class="btn ghost" data-action="reload">${icon('refresh')} Refresh</button>
      </div>

      ${
        loadError
          ? `<div class="alert error">${icon('warning')}<div><b>Overview unavailable.</b> ${esc(loadError)}
              <div class="tiny">Admin read access depends on the RLS policies in supabase/schema.sql.</div></div></div>`
          : ''
      }

      <div class="grid cols-4 mb-2">
        <div class="card stat"><span class="value">${profiles.length}</span><span class="label">Registered accounts</span></div>
        <div class="card stat"><span class="value">${customers.length}</span><span class="label">Customers</span></div>
        <div class="card stat"><span class="value">${providers.length}</span><span class="label">Provider profiles</span></div>
        <div class="card stat"><span class="value">${bookings.length}</span><span class="label">Bookings</span></div>
      </div>

      <div class="split">
        <section class="card">
          <div class="card-head"><h3>Latest bookings</h3><span class="badge pending">${pending.length} pending</span></div>
          ${
            recent.length
              ? `<div class="table-wrap"><table class="table">
                  <thead><tr><th>Booking</th><th>Date</th><th>Status</th></tr></thead>
                  <tbody>${recent
                    .map(
                      (booking) => `<tr>
                        <td class="mono tiny">${esc(String(booking.id).slice(0, 8))}</td>
                        <td class="tiny">${esc(booking.date ? formatDate(booking.date) : '—')}</td>
                        <td>${statusBadge(booking.status)}</td>
                      </tr>`,
                    )
                    .join('')}</tbody>
                </table></div>`
              : emptyState({
                  icon: 'table_rows',
                  title: 'No bookings yet',
                  message: 'Bookings created by customers appear here for the demonstration.',
                })
          }
        </section>

        <aside class="stack">
          <div class="card">
            <h3>Service categories</h3>
            ${
              categories.length
                ? `<div class="row">${categories
                    .map((category) => `<span class="badge neutral">${esc(category.name)}</span>`)
                    .join('')}</div>`
                : '<p class="tiny muted mb-0">No categories found.</p>'
            }
          </div>
          <div class="card">
            <h3>Scope</h3>
            <p class="tiny muted mb-0">This module is a demonstration overview only. Administration of
            users, providers and bookings is handled directly in the Supabase dashboard for the project
            submission.</p>
          </div>
        </aside>
      </div>`,
    bind(root) {
      root.querySelector('[data-action="reload"]')?.addEventListener('click', () => ctx.refresh());
    },
  };
}
