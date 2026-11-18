import { supabase, isSupabaseConfigured } from './supabaseClient.js';
import { ensureProfile, getProfile, createProviderProfile } from './api.js';

export async function getSession() {
  if (!supabase) return null;
  const { data } = await supabase.auth.getSession();
  return data?.session || null;
}

export async function signIn(email, password) {
  if (!supabase) throw new Error('Supabase is not configured.');
  const { data, error } = await supabase.auth.signInWithPassword({
    email: String(email || '').trim(),
    password,
  });
  if (error) throw error;
  return data;
}

export async function signUp({ email, password, fullName, phone, city, role }) {
  if (!supabase) throw new Error('Supabase is not configured.');
  const { data, error } = await supabase.auth.signUp({
    email: String(email || '').trim(),
    password,
    options: {
      data: { full_name: fullName, phone, city, role },
      emailRedirectTo: window.location.origin,
    },
  });
  if (error) throw error;

  const session = data.session;
  if (session?.user) {
    await ensureProfile({
      id: session.user.id,
      email: session.user.email,
      role,
      fullName,
      phone,
      city,
    });
  }
  return { user: data.user, session, needsConfirmation: !session };
}

export async function registerProviderAccount(account, providerDetails) {
  const result = await signUp({ ...account, role: 'provider' });
  if (result.session?.user) {
    await createProviderProfile({ userId: result.session.user.id, ...providerDetails });
  }
  return result;
}

export async function signOut() {
  if (!supabase) return;
  await supabase.auth.signOut();
}

export async function loadIdentity() {
  const session = await getSession();
  if (!session) return { session: null, profile: null, role: null };

  const metadata = session.user.user_metadata || {};
  let profile = await getProfile(session.user.id);

  if (!profile) {
    await ensureProfile({
      id: session.user.id,
      email: session.user.email,
      role: metadata.role || 'customer',
      fullName: metadata.full_name,
      phone: metadata.phone,
      city: metadata.city,
    }).catch((error) => console.warn('[LSP] profile bootstrap failed:', error.message));
    profile = await getProfile(session.user.id);
  }

  const role = String(profile?.role || metadata.role || 'customer').toLowerCase();
  return { session, profile, role };
}

export function friendlyError(error) {
  const message = String(error?.message || error || 'Something went wrong.');
  const code = error?.code || '';
  if (/Invalid login credentials/i.test(message)) return 'Email or password is incorrect.';
  if (/Email not confirmed/i.test(message)) {
    return 'This email address is not confirmed yet. Open the confirmation link sent to your inbox, or disable "Confirm email" in Supabase Authentication settings for the demo.';
  }
  if (/User already registered/i.test(message)) {
    return 'An account already exists with this email. Try signing in instead.';
  }
  if (/Password should be at least/i.test(message)) {
    return 'Choose a password with at least 6 characters.';
  }
  if (code === '23505' || /duplicate key/i.test(message)) {
    return 'A record with these details already exists.';
  }
  if (code === '42501' || /row-level security|permission denied/i.test(message)) {
    return 'The database blocked this action. Apply the policies in supabase/schema.sql for this project.';
  }
  if (code === '23503' || /foreign key/i.test(message)) {
    return 'This record is linked to missing data (for example a deleted profile). Please refresh and try again.';
  }
  if (/Failed to fetch|NetworkError|Load failed/i.test(message)) {
    return 'Could not reach the database. Check your internet connection and try again.';
  }
  return message;
}
