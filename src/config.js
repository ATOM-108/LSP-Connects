// Runtime configuration.
// 1. window.__LSP_CONFIG__ (written at container start from SUPABASE_URL / SUPABASE_ANON_KEY)
// 2. build-time VITE_* / SUPABASE_* values injected by Vite
const runtimeConfig = (typeof window !== 'undefined' && window.__LSP_CONFIG__) || {};

export const SUPABASE_URL =
  runtimeConfig.supabaseUrl ||
  (typeof __LSP_SUPABASE_URL__ !== 'undefined' ? __LSP_SUPABASE_URL__ : '') ||
  '';

export const SUPABASE_ANON_KEY =
  runtimeConfig.supabaseAnonKey ||
  (typeof __LSP_SUPABASE_ANON_KEY__ !== 'undefined' ? __LSP_SUPABASE_ANON_KEY__ : '') ||
  '';

export const isSupabaseConfigured = Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);
