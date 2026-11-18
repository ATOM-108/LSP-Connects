import { defineConfig, loadEnv } from 'vite';

// Supabase values are injected at build time from the environment so the browser
// bundle only ever contains the public anon key (never a service-role key).
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const url = env.VITE_SUPABASE_URL || env.SUPABASE_URL || '';
  const anonKey = env.VITE_SUPABASE_ANON_KEY || env.SUPABASE_ANON_KEY || '';

  return {
    define: {
      __LSP_SUPABASE_URL__: JSON.stringify(url),
      __LSP_SUPABASE_ANON_KEY__: JSON.stringify(anonKey),
    },
    build: {
      outDir: 'dist',
      sourcemap: false,
      chunkSizeWarningLimit: 900,
    },
    server: {
      host: '0.0.0.0',
      port: 3000,
    },
    preview: {
      host: '0.0.0.0',
      port: 3000,
    },
  };
});
