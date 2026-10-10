// Static file serving for the single-page web app (web/). GET/HEAD only, a fixed content-type allow-list, no directory
// listing, no dotfiles, and path traversal is rejected after decoding and normalisation. index.html is served with
// Cache-Control: no-store; every page response carries a same-origin Content-Security-Policy (the web code uses no
// inline scripts or style attributes).
import fs from 'node:fs';
import path from 'node:path';

const TYPES = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.txt': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2',
});

export const CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; "
  + "object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

const SECURITY_HEADERS = Object.freeze({
  'content-security-policy': CSP,
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
  'cross-origin-opener-policy': 'same-origin',
});

function plain(res, status, msg, method) {
  const buf = Buffer.from(msg, 'utf8');
  res.writeHead(status, { ...SECURITY_HEADERS, 'content-type': 'text/plain; charset=utf-8', 'content-length': buf.length, 'cache-control': 'no-store' });
  res.end(method === 'HEAD' ? undefined : buf);
}

/**
 * Serve a file from webRoot. Returns nothing; always ends the response.
 * @param {string} webRoot absolute path of the web/ directory
 */
export function serveStatic(webRoot, req, res, pathname) {
  const method = req.method;
  if (method !== 'GET' && method !== 'HEAD') {
    res.setHeader('allow', 'GET, HEAD');
    plain(res, 405, 'Method Not Allowed', method);
    return;
  }
  let rel;
  try { rel = decodeURIComponent(pathname); } catch { plain(res, 400, 'Bad Request', method); return; }
  if (rel.includes('\0') || rel.includes('\\')) { plain(res, 400, 'Bad Request', method); return; }
  if (rel === '/' || rel === '') rel = '/index.html';
  const parts = rel.split('/').filter(Boolean);
  if (parts.some((p) => p === '..' || p.startsWith('.'))) { plain(res, 404, 'Not Found', method); return; }
  const root = path.resolve(webRoot);
  const file = path.resolve(root, ...parts);
  if (file !== root && !file.startsWith(root + path.sep)) { plain(res, 404, 'Not Found', method); return; }
  const type = TYPES[path.extname(file).toLowerCase()];
  if (!type) { plain(res, 404, 'Not Found', method); return; }
  let st;
  try { st = fs.statSync(file); } catch { plain(res, 404, 'Not Found', method); return; }
  if (!st.isFile()) { plain(res, 404, 'Not Found', method); return; }
  const isIndex = path.basename(file) === 'index.html';
  res.writeHead(200, {
    ...SECURITY_HEADERS,
    'content-type': type,
    'content-length': st.size,
    'cache-control': isIndex ? 'no-store' : 'no-cache',
  });
  if (method === 'HEAD') { res.end(); return; }
  fs.createReadStream(file).on('error', () => res.destroy()).pipe(res);
}
