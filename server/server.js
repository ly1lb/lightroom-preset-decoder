// HTTP server: static front-end, email/password auth and a per-user preset library.
// Photos are analysed entirely in the browser and are never uploaded.
import http from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JsonStore } from './store.js';
import { Auth, AuthError, RateLimiter, SESSION_MAX_AGE_S } from './auth.js';
import { PresetLibrary, PresetError } from './presets.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC_DIR = path.join(ROOT, 'public');
const COOKIE = 'lpd_session';
const MAX_BODY = 10 * 1024 * 1024;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

const SECURITY_HEADERS = {
  'Content-Security-Policy':
    "default-src 'self'; img-src 'self' blob: data:; style-src 'self' 'unsafe-inline'; " +
    "script-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
};

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    const key = part.slice(0, idx).trim();
    if (key) out[key] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

function isSecure(req, options) {
  if (options.cookieSecure !== undefined) return options.cookieSecure;
  return req.socket.encrypted || req.headers['x-forwarded-proto'] === 'https';
}

function sessionCookie(req, options, token, maxAge) {
  const parts = [`${COOKIE}=${token}`, 'Path=/', 'HttpOnly', 'SameSite=Strict', `Max-Age=${maxAge}`];
  if (isSecure(req, options)) parts.push('Secure');
  return parts.join('; ');
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, { ...SECURITY_HEADERS, ...headers });
  res.end(body);
}

function sendJson(res, status, data, headers = {}) {
  send(res, status, JSON.stringify(data), {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  });
}

function redirect(res, location) {
  send(res, 302, '', { Location: location, 'Cache-Control': 'no-store' });
}

async function readJson(req) {
  const type = req.headers['content-type'] || '';
  if (!type.startsWith('application/json')) throw new HttpError(415, 'Tikimasi JSON.');
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new HttpError(413, 'Užklausa per didelė.');
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch {
    throw new HttpError(400, 'Netinkamas JSON.');
  }
}

// Reject cross-site state-changing requests (defence in depth on top of SameSite).
function checkOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return;
  let host;
  try {
    host = new URL(origin).host;
  } catch {
    throw new HttpError(403, 'Netinkama kilmė.');
  }
  const expected = req.headers['x-forwarded-host'] || req.headers.host;
  if (host !== expected) throw new HttpError(403, 'Netinkama kilmė.');
}

async function serveStatic(res, relPath) {
  const filePath = path.normalize(path.join(PUBLIC_DIR, relPath));
  if (!filePath.startsWith(PUBLIC_DIR + path.sep)) return send(res, 404, 'Not found');
  let data;
  try {
    data = await fs.readFile(filePath);
  } catch {
    return send(res, 404, 'Not found', { 'Content-Type': 'text/plain; charset=utf-8' });
  }
  const type = MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
  const cache = type.startsWith('text/html') ? 'no-store' : 'no-cache';
  send(res, 200, data, { 'Content-Type': type, 'Cache-Control': cache });
}

function safeFileName(name, ext) {
  const base = String(name).replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim() || 'preset';
  return `${base}${ext}`;
}

export function createApp(options = {}) {
  const dataDir = options.dataDir || process.env.DATA_DIR || path.join(ROOT, 'data');
  const store = new JsonStore(dataDir);
  const allowRegistration =
    options.allowRegistration ?? (process.env.ALLOW_REGISTRATION ?? 'true') !== 'false';
  const auth = new Auth(store, { allowRegistration });
  const library = new PresetLibrary(store);
  const limiter = new RateLimiter();
  const cookieSecure =
    options.cookieSecure ?? (process.env.COOKIE_SECURE ? process.env.COOKIE_SECURE === 'true' : undefined);
  const opts = { cookieSecure };

  async function currentUser(req) {
    const token = parseCookies(req.headers.cookie)[COOKIE];
    return { token, user: await auth.userForToken(token) };
  }

  async function requireUser(req) {
    const { user } = await currentUser(req);
    if (!user) throw new HttpError(401, 'Reikia prisijungti.');
    return user;
  }

  async function handleApi(req, res, url) {
    const { pathname } = url;
    const method = req.method;
    if (method !== 'GET' && method !== 'HEAD') checkOrigin(req);

    if (pathname === '/api/auth/config' && method === 'GET') {
      return sendJson(res, 200, { allowRegistration });
    }

    if (pathname === '/api/auth/register' && method === 'POST') {
      const body = await readJson(req);
      await auth.register(body.email, body.password);
      const { user, token } = await auth.login(body.email, body.password);
      return sendJson(res, 201, { user }, { 'Set-Cookie': sessionCookie(req, opts, token, SESSION_MAX_AGE_S) });
    }

    if (pathname === '/api/auth/login' && method === 'POST') {
      const body = await readJson(req);
      const key = `${req.socket.remoteAddress}|${String(body.email ?? '').toLowerCase()}`;
      if (limiter.isBlocked(key)) {
        throw new HttpError(429, 'Per daug nesėkmingų bandymų. Pabandykite po 15 minučių.');
      }
      try {
        const { user, token } = await auth.login(body.email, body.password);
        limiter.reset(key);
        return sendJson(res, 200, { user }, { 'Set-Cookie': sessionCookie(req, opts, token, SESSION_MAX_AGE_S) });
      } catch (err) {
        if (err instanceof AuthError && err.status === 401) limiter.fail(key);
        throw err;
      }
    }

    if (pathname === '/api/auth/logout' && method === 'POST') {
      const { token } = await currentUser(req);
      await auth.logout(token);
      return sendJson(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie(req, opts, '', 0) });
    }

    if (pathname === '/api/auth/me' && method === 'GET') {
      const user = await requireUser(req);
      return sendJson(res, 200, { user });
    }

    if (pathname === '/api/auth/password' && method === 'POST') {
      const user = await requireUser(req);
      const body = await readJson(req);
      const token = await auth.changePassword(user.id, body.currentPassword, body.newPassword);
      return sendJson(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie(req, opts, token, SESSION_MAX_AGE_S) });
    }

    if (pathname === '/api/presets' && method === 'GET') {
      const user = await requireUser(req);
      return sendJson(res, 200, { presets: await library.list(user.id) });
    }

    if (pathname === '/api/presets' && method === 'POST') {
      const user = await requireUser(req);
      const preset = await library.add(user.id, await readJson(req));
      return sendJson(res, 201, { preset });
    }

    const match = pathname.match(/^\/api\/presets\/([0-9a-f-]{36})(\.xmp|\.lrtemplate)?$/);
    if (match) {
      const user = await requireUser(req);
      const [, id, ext] = match;
      if (method === 'DELETE' && !ext) {
        const removed = await library.remove(user.id, id);
        if (!removed) throw new HttpError(404, 'Presetas nerastas.');
        return sendJson(res, 200, { ok: true });
      }
      if (method === 'GET') {
        const preset = await library.get(user.id, id);
        if (!preset) throw new HttpError(404, 'Presetas nerastas.');
        if (!ext) {
          const { xmp, lrtemplate, ...meta } = preset;
          return sendJson(res, 200, { preset: meta });
        }
        const body = ext === '.xmp' ? preset.xmp : preset.lrtemplate;
        if (!body) throw new HttpError(404, 'Šis formatas neišsaugotas.');
        const fileName = safeFileName(preset.name, ext);
        return send(res, 200, body, {
          'Content-Type': ext === '.xmp' ? 'application/rdf+xml; charset=utf-8' : 'text/plain; charset=utf-8',
          'Content-Disposition': `attachment; filename="preset${ext}"; filename*=UTF-8''${encodeURIComponent(fileName)}`,
          'Cache-Control': 'no-store',
        });
      }
    }

    throw new HttpError(404, 'Nerasta.');
  }

  async function handler(req, res) {
    const url = new URL(req.url, 'http://localhost');
    try {
      if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
      if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed');

      if (url.pathname === '/') {
        const { user } = await currentUser(req);
        return redirect(res, user ? '/app' : '/login');
      }
      if (url.pathname === '/login') {
        const { user } = await currentUser(req);
        if (user) return redirect(res, '/app');
        return serveStatic(res, 'login.html');
      }
      if (url.pathname === '/app') {
        const { user } = await currentUser(req);
        if (!user) return redirect(res, '/login');
        return serveStatic(res, 'app.html');
      }
      if (url.pathname.endsWith('.html')) return send(res, 404, 'Not found');
      let rel;
      try {
        rel = decodeURIComponent(url.pathname);
      } catch {
        return send(res, 400, 'Bad request');
      }
      return serveStatic(res, rel);
    } catch (err) {
      const status = err instanceof HttpError || err instanceof AuthError || err instanceof PresetError ? err.status : 500;
      if (status === 500) console.error(err);
      if (url.pathname.startsWith('/api/')) {
        return sendJson(res, status, { error: status === 500 ? 'Serverio klaida.' : err.message });
      }
      return send(res, status, status === 500 ? 'Server error' : err.message);
    }
  }

  return { handler, auth, library, store };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const { handler } = createApp();
  const port = Number(process.env.PORT) || 3000;
  const host = process.env.HOST || '0.0.0.0';
  http.createServer(handler).listen(port, host, () => {
    console.log(`Lightroom Preset Decoder: http://localhost:${port}`);
  });
}
