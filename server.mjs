// Minimal static file server for the built SPA.
// It writes window.__LSP_CONFIG__ at start-up so Supabase credentials come from
// the hosting environment at runtime and are never baked into the image.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const DIST = path.resolve('dist');
const PORT = Number(process.env.PORT || 3000);
const HOST = '0.0.0.0';

const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || '';
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY || '';

fs.writeFileSync(
  path.join(DIST, 'config.js'),
  `window.__LSP_CONFIG__ = ${JSON.stringify({ supabaseUrl, supabaseAnonKey })};\n`,
);
console.log(
  `[lsp-connect] runtime config written (supabase configured: ${Boolean(supabaseUrl && supabaseAnonKey)})`,
);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

function send(response, status, body, headers = {}) {
  response.writeHead(status, {
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'X-Frame-Options': 'SAMEORIGIN',
    ...headers,
  });
  response.end(body);
}

const server = http.createServer((request, response) => {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    send(response, 405, 'Method Not Allowed');
    return;
  }

  let pathname;
  try {
    pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
  } catch {
    send(response, 400, 'Bad Request');
    return;
  }

  // config.js is regenerated on every start; never serve a cached copy
  const cacheControl = pathname.startsWith('/assets/')
    ? 'public, max-age=31536000, immutable'
    : 'no-cache';

  const resolveFile = (candidate) => {
    const resolved = path.resolve(DIST, '.' + candidate);
    if (!resolved.startsWith(DIST)) return null; // path traversal guard
    return fs.existsSync(resolved) && fs.statSync(resolved).isFile() ? resolved : null;
  };

  let file = resolveFile(pathname);
  if (!file) file = resolveFile('/index.html'); // SPA fallback

  try {
    const body = fs.readFileSync(file);
    const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
    send(response, 200, request.method === 'HEAD' ? '' : body, {
      'Content-Type': type,
      'Cache-Control': cacheControl,
    });
  } catch (error) {
    console.error('[lsp-connect] failed to serve', pathname, error.message);
    send(response, 500, 'Internal Server Error');
  }
});

server.listen(PORT, HOST, () => console.log(`[lsp-connect] listening on http://${HOST}:${PORT}`));
