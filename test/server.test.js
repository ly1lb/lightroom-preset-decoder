import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { createApp } from '../server/server.js';

async function startServer(options = {}) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'lpd-'));
  const app = createApp({ dataDir, cookieSecure: false, ...options });
  const server = http.createServer(app.handler);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base,
    async close() {
      await new Promise((r) => server.close(r));
      await rm(dataDir, { recursive: true, force: true });
    },
  };
}

function client(base) {
  let cookie = '';
  return async (pathname, { method = 'GET', body, headers = {} } = {}) => {
    const res = await fetch(base + pathname, {
      method,
      redirect: 'manual',
      headers: {
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(cookie ? { Cookie: cookie } : {}),
        ...headers,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0].endsWith('=') ? '' : set.split(';')[0];
    return res;
  };
}

const XMP = '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/" crs:Exposure2012="+1.00"/></rdf:RDF></x:xmpmeta>';

test('register, session, presets and logout', async () => {
  const srv = await startServer();
  try {
    const req = client(srv.base);

    let res = await req('/app');
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), '/login');

    res = await req('/api/presets');
    assert.equal(res.status, 401);

    res = await req('/api/auth/register', { method: 'POST', body: { email: 'Foto@Example.com', password: 'short' } });
    assert.equal(res.status, 400);

    res = await req('/api/auth/register', { method: 'POST', body: { email: 'Foto@Example.com', password: 'slaptas123' } });
    assert.equal(res.status, 201);
    assert.match(res.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/);
    assert.equal((await res.json()).user.email, 'foto@example.com');

    res = await req('/app');
    assert.equal(res.status, 200);
    assert.match(await res.text(), /Preset Decoder/);

    res = await req('/api/presets', { method: 'POST', body: { name: 'Vasara', xmp: XMP, lrtemplate: 's = {}' } });
    assert.equal(res.status, 201);
    const { preset } = await res.json();

    res = await req('/api/presets');
    const { presets } = await res.json();
    assert.equal(presets.length, 1);
    assert.equal(presets[0].xmp, undefined);

    res = await req(`/api/presets/${preset.id}.xmp`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-disposition'), /Vasara\.xmp/);
    assert.equal(await res.text(), XMP);

    // Another user cannot see it.
    const other = client(srv.base);
    await other('/api/auth/register', { method: 'POST', body: { email: 'kitas@example.com', password: 'slaptas123' } });
    res = await other(`/api/presets/${preset.id}.xmp`);
    assert.equal(res.status, 404);

    res = await req(`/api/presets/${preset.id}`, { method: 'DELETE' });
    assert.equal(res.status, 200);

    res = await req('/api/auth/logout', { method: 'POST', body: {} });
    assert.equal(res.status, 200);
    res = await req('/api/auth/me');
    assert.equal(res.status, 401);
  } finally {
    await srv.close();
  }
});

test('login errors, duplicate accounts and cross-origin requests', async () => {
  const srv = await startServer();
  try {
    const req = client(srv.base);
    await req('/api/auth/register', { method: 'POST', body: { email: 'a@b.lt', password: 'slaptas123' } });

    let res = await req('/api/auth/register', { method: 'POST', body: { email: 'A@B.lt', password: 'slaptas123' } });
    assert.equal(res.status, 409);

    res = await req('/api/auth/login', { method: 'POST', body: { email: 'a@b.lt', password: 'neteisingas' } });
    assert.equal(res.status, 401);

    res = await req('/api/auth/login', { method: 'POST', body: { email: 'a@b.lt', password: 'slaptas123' }, headers: { Origin: 'https://evil.example' } });
    assert.equal(res.status, 403);

    res = await req('/api/auth/login', { method: 'POST', body: { email: 'a@b.lt', password: 'slaptas123' } });
    assert.equal(res.status, 200);

    res = await req('/api/auth/password', { method: 'POST', body: { currentPassword: 'slaptas123', newPassword: 'naujas12345' } });
    assert.equal(res.status, 200);
    res = await client(srv.base)('/api/auth/login', { method: 'POST', body: { email: 'a@b.lt', password: 'naujas12345' } });
    assert.equal(res.status, 200);
  } finally {
    await srv.close();
  }
});

test('login is rate limited', async () => {
  const srv = await startServer();
  try {
    const req = client(srv.base);
    let res;
    for (let i = 0; i < 11; i++) {
      res = await req('/api/auth/login', { method: 'POST', body: { email: 'x@y.lt', password: 'blogas-slaptazodis' } });
    }
    assert.equal(res.status, 429);
  } finally {
    await srv.close();
  }
});

test('registration can be disabled and static files are safe', async () => {
  const srv = await startServer({ allowRegistration: false });
  try {
    const req = client(srv.base);
    let res = await req('/api/auth/register', { method: 'POST', body: { email: 'a@b.lt', password: 'slaptas123' } });
    assert.equal(res.status, 403);
    res = await req('/js/preset.js');
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-security-policy'), /default-src 'self'/);
    res = await req('/%2e%2e/package.json');
    assert.equal(res.status, 404);
    res = await req('/app.html');
    assert.equal(res.status, 404);
  } finally {
    await srv.close();
  }
});
