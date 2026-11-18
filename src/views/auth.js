import { signIn, signUp, registerProviderAccount, friendlyError } from '../lib/auth.js';
import { listCategories } from '../lib/api.js';
import { dashboardFor } from '../main.js';
import { esc, icon, alertBox, setBusy, toast } from '../ui.js';

const ROLE_COPY = {
  customer: {
    title: 'Customer access',
    lead: 'Sign in to browse providers and manage your bookings.',
    registerTitle: 'Create your customer account',
    icon: 'person',
  },
  provider: {
    title: 'Service provider access',
    lead: 'Sign in to receive and manage customer bookings.',
    registerTitle: 'Create your provider account',
    icon: 'handyman',
  },
  admin: {
    title: 'Administrator access',
    lead: 'Demo overview of platform activity. Administrator accounts are provisioned in Supabase only.',
    registerTitle: 'Administrator registration is disabled',
    icon: 'admin_panel_settings',
  },
};

function authTabs(role, mode) {
  return `<div class="auth-tabs">
    <a class="btn ghost sm" style="flex:1" href="#/login/${esc(role)}">Sign in</a>
    ${
      role === 'admin'
        ? `<span class="btn sm" style="flex:1;opacity:.5;cursor:not-allowed">Register</span>`
        : `<a class="btn ${mode === 'register' ? 'primary' : 'ghost'} sm" style="flex:1" href="#/register/${esc(role)}">Register</a>`
    }
  </div>`;
}

export async function renderLogin(ctx) {
  const role = ctx.params[0] || 'customer';
  const copy = ROLE_COPY[role] || ROLE_COPY.customer;

  return {
    title: `${copy.title}`,
    html: `
      <div class="auth-wrap">
        <div class="card auth-card">
          <div class="eyebrow">${esc(role)} portal</div>
          <h1>${esc(copy.title)}</h1>
          <p class="muted">${esc(copy.lead)}</p>
          ${authTabs(role, 'login')}
          <div id="auth-error"></div>
          <form id="login-form" novalidate>
            <div class="field">
              <label for="email">Email address</label>
              <input class="input" id="email" name="email" type="email" autocomplete="email"
                placeholder="you@example.com" required />
            </div>
            <div class="field">
              <label for="password">Password</label>
              <input class="input" id="password" name="password" type="password"
                autocomplete="current-password" placeholder="Your password" required />
            </div>
            <button class="btn primary block" type="submit" data-submit>${icon('login')} Sign in</button>
          </form>
          <p class="tiny faint mt-2 mb-0">
            ${
              role === 'admin'
                ? 'Admin demo accounts must already exist with the admin role in the profiles table.'
                : `New here? <a href="#/register/${esc(role)}" style="color:var(--primary)">Create a ${esc(role)} account</a>.`
            }
          </p>
        </div>
      </div>`,
    bind(root) {
      const form = root.querySelector('#login-form');
      const errorBox = root.querySelector('#auth-error');
      form.addEventListener('submit', async (event) => {
        event.preventDefault();
        errorBox.innerHTML = '';
        const button = form.querySelector('[data-submit]');
        const email = form.email.value.trim();
        const password = form.password.value;
        if (!email || !password) {
          errorBox.innerHTML = alertBox('error', 'Enter your email address and password.');
          return;
        }
        setBusy(button, true, 'Signing in…');
        try {
          await signIn(email, password);
          await ctx.reloadIdentity();
          const actualRole = ctx.state.identity.role;

          if (role === 'admin' && actualRole !== 'admin') {
            errorBox.innerHTML = alertBox(
              'error',
              'This account is not an administrator. Sign in through the customer or provider portal.',
            );
            return;
          }
          if (role !== 'admin' && actualRole === 'admin') {
            toast('Signed in as administrator.');
            ctx.navigate('/admin');
            return;
          }
          if (role !== 'admin' && actualRole !== role) {
            toast(`This account is registered as a ${actualRole}.`, 'error');
            ctx.navigate(dashboardFor(actualRole));
            return;
          }
          toast('Signed in successfully.');
          ctx.navigate(dashboardFor(actualRole));
        } catch (error) {
          errorBox.innerHTML = alertBox('error', friendlyError(error));
        } finally {
          setBusy(button, false);
        }
      });
    },
  };
}

export async function renderRegister(ctx) {
  const role = ctx.params[0] === 'provider' ? 'provider' : 'customer';
  const isProvider = role === 'provider';
  let categories = [];
  try {
    categories = await listCategories();
  } catch {
    categories = [];
  }

  const categoryOptions = categories
    .map((category) => `<option value="${esc(category.id)}">${esc(category.name)}</option>`)
    .join('');

  return {
    title: `Register as ${role}`,
    html: `
      <div class="auth-wrap">
        <div class="card auth-card" style="width:min(640px,100%)">
          <div class="eyebrow">${esc(role)} registration</div>
          <h1>${esc(ROLE_COPY[role].registerTitle)}</h1>
          <p class="muted">Your account is created in Supabase Authentication and your details are saved to the
          profiles table${isProvider ? ' and provider_profiles table' : ''}.</p>
          ${authTabs(role, 'register')}
          <div id="register-error"></div>
          <div id="register-info"></div>
          <form id="register-form" novalidate>
            <div class="form-row">
              <div class="field">
                <label for="fullName">Full name</label>
                <input class="input" id="fullName" name="fullName" autocomplete="name" placeholder="e.g. Amina Yusuf" required />
              </div>
              <div class="field">
                <label for="phone">Phone number</label>
                <input class="input" id="phone" name="phone" autocomplete="tel" placeholder="+254 700 000 000" />
              </div>
            </div>
            <div class="field">
              <label for="email">Email address</label>
              <input class="input" id="email" name="email" type="email" autocomplete="email" placeholder="you@example.com" required />
            </div>
            <div class="form-row">
              <div class="field">
                <label for="city">City / service area</label>
                <input class="input" id="city" name="city" autocomplete="address-level2" placeholder="e.g. Nairobi" />
              </div>
              <div class="field">
                <label for="password">Password</label>
                <input class="input" id="password" name="password" type="password" autocomplete="new-password"
                  placeholder="At least 6 characters" minlength="6" required />
              </div>
            </div>

            ${
              isProvider
                ? `<div class="card tight" style="background:var(--bg-elev);margin-bottom:16px">
                    <h3>Business details</h3>
                    <p class="tiny faint">Stored in provider_profiles so customers can find and book you.</p>
                    <div class="field">
                      <label for="businessName">Business / trading name</label>
                      <input class="input" id="businessName" name="businessName" placeholder="e.g. Bright Spark Electricals" />
                    </div>
                    <div class="form-row">
                      <div class="field">
                        <label for="categoryId">Primary service category</label>
                        <select class="input" id="categoryId" name="categoryId">
                          <option value="">Select a category</option>
                          ${categoryOptions}
                        </select>
                      </div>
                      <div class="field">
                        <label for="yearsExperience">Years of experience</label>
                        <input class="input" id="yearsExperience" name="yearsExperience" type="number" min="0" max="60" placeholder="e.g. 5" />
                      </div>
                    </div>
                    <div class="field">
                      <label for="hourlyRate">Hourly rate (optional)</label>
                      <input class="input" id="hourlyRate" name="hourlyRate" type="number" min="0" step="0.01" placeholder="e.g. 25" />
                    </div>
                    <div class="field mb-0">
                      <label for="bio">Short bio</label>
                      <textarea class="input" id="bio" name="bio" placeholder="Describe the services you offer and the areas you cover."></textarea>
                    </div>
                  </div>`
                : ''
            }

            <button class="btn primary block" type="submit" data-submit>
              ${icon('person_add')} Create ${esc(role)} account
            </button>
          </form>
          <p class="tiny faint mt-2 mb-0">Already registered?
            <a href="#/login/${esc(role)}" style="color:var(--primary)">Sign in instead</a>.
          </p>
        </div>
      </div>`,
    bind(root) {
      const form = root.querySelector('#register-form');
      const errorBox = root.querySelector('#register-error');
      const infoBox = root.querySelector('#register-info');

      form.addEventListener('submit', async (event) => {
        event.preventDefault();
        errorBox.innerHTML = '';
        infoBox.innerHTML = '';
        const button = form.querySelector('[data-submit]');
        const values = {
          fullName: form.fullName.value.trim(),
          email: form.email.value.trim(),
          phone: form.phone.value.trim(),
          city: form.city.value.trim(),
          password: form.password.value,
        };

        if (!values.fullName) {
          errorBox.innerHTML = alertBox('error', 'Enter your full name.');
          return;
        }
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(values.email)) {
          errorBox.innerHTML = alertBox('error', 'Enter a valid email address.');
          return;
        }
        if (values.password.length < 6) {
          errorBox.innerHTML = alertBox('error', 'Choose a password with at least 6 characters.');
          return;
        }

        setBusy(button, true, 'Creating account…');
        try {
          const account = {
            email: values.email,
            password: values.password,
            fullName: values.fullName,
            phone: values.phone,
            city: values.city,
            role,
          };

          let result;
          if (isProvider) {
            result = await registerProviderAccount(account, {
              businessName: form.businessName?.value.trim() || values.fullName,
              categoryId: form.categoryId?.value || null,
              yearsExperience: form.yearsExperience?.value || null,
              city: values.city,
              hourlyRate: form.hourlyRate?.value || null,
              bio: form.bio?.value.trim() || '',
            });
          } else {
            result = await signUp(account);
          }

          if (result.needsConfirmation) {
            infoBox.innerHTML = alertBox(
              'warn',
              'Account created. Supabase requires email confirmation: open the confirmation link sent to ' +
                values.email +
                ', then sign in. (For the demo, an administrator can disable "Confirm email" in Supabase → Authentication → Providers → Email.)',
            );
            toast('Check your inbox to confirm your email.', 'success', 6000);
            form.querySelector('[data-submit]').disabled = true;
            return;
          }

          await ctx.reloadIdentity();
          toast('Account created. Welcome to LSP Connect!');
          ctx.navigate(dashboardFor(role));
        } catch (error) {
          errorBox.innerHTML = alertBox('error', friendlyError(error));
        } finally {
          setBusy(button, false);
        }
      });
    },
  };
}
