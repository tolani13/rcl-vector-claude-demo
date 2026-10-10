// TEST FIXTURE — NOT MARKET DATA. Remote mode (VECTOR_ALLOW_REMOTE=1) keeps the DNS-rebinding guard: the Host allow-list
// and the Origin allow-list stay on (Origin is never compared with the request's own Host), extra names/origins must be
// configured explicitly, and a non-loopback peer needs the per-launch token cookie. The server still binds 127.0.0.1
// here; non-loopback peers are simulated by calling the request handler with a mock socket address.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { tempDb, seedFixture, startTestServer } from './helpers.js';
import { allowedHosts, originAllowed, createHandler, isLoopbackAddress } from '../../server/index.js';
import { loadConfig } from '../../server/config.js';

let t;
let srv;
let port;

before(async () => {
  t = tempDb('remote');
  seedFixture(t.db);
  srv = await startTestServer(t.db, {
    VECTOR_ALLOW_REMOTE: '1',
    VECTOR_ALLOWED_HOSTS: 'vector-test.local', // TEST FIXTURE name
    VECTOR_ALLOWED_ORIGINS: 'https://vector-test.example', // TEST FIXTURE origin
  });
  port = Number(new URL(srv.url).port);
});
after(async () => { await srv?.close(); t?.cleanup(); });

function raw({ method = 'GET', path = '/api/status', host, headers = {}, body }) {
  return new Promise((resolve, reject) => {
    const h = { host: host ?? `127.0.0.1:${port}`, ...headers };
    if (body !== undefined) Object.assign(h, { 'content-type': 'application/json', 'x-vector-client': 'web' });
    const req = http.request({ host: '127.0.0.1', port, method, path, headers: h }, (res) => {
      let text = '';
      res.on('data', (c) => { text += c; });
      res.on('end', () => { let json = null; try { json = JSON.parse(text); } catch { /* static */ } resolve({ status: res.statusCode, json, headers: res.headers }); });
    });
    req.on('error', reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

test('allow-lists: loopback names always; interface IP literals and configured names only in remote mode', () => {
  const ifaces = { eth0: [{ family: 'IPv4', address: '192.0.2.10' }, { family: 'IPv6', address: 'fe80::1%eth0' }] }; // TEST FIXTURE addresses
  const local = allowedHosts(8787, { allowRemote: false }, ifaces);
  assert.ok(local.has('127.0.0.1:8787') && local.has('localhost:8787') && local.has('[::1]:8787'));
  assert.ok(!local.has('192.0.2.10:8787'));
  const remote = allowedHosts(8787, { allowRemote: true, host: '0.0.0.0', allowedHosts: ['vector-test.local', 'other.test:9000'] }, ifaces);
  for (const h of ['192.0.2.10:8787', '[fe80::1]:8787', 'vector-test.local:8787', 'other.test:9000']) assert.ok(remote.has(h), h);
  assert.ok(!remote.has('attacker.example:8787'));

  assert.equal(originAllowed('http://192.0.2.10:8787', remote), true);
  assert.equal(originAllowed('http://attacker.example:8787', remote), false);
  assert.equal(originAllowed('https://192.0.2.10:8787', remote), false, 'https only when listed explicitly');
  assert.equal(originAllowed('https://vector-test.example', remote, { allowedOrigins: ['https://vector-test.example'] }), true);
  assert.equal(originAllowed('null', remote), false);
  assert.equal(isLoopbackAddress('::ffff:127.0.0.1'), true);
  assert.equal(isLoopbackAddress('192.0.2.10'), false);

  assert.throws(() => loadConfig({ VECTOR_ALLOWED_HOSTS: 'bad host!' }), /VECTOR_ALLOWED_HOSTS/);
  assert.throws(() => loadConfig({ VECTOR_ALLOWED_ORIGINS: 'https://x.example/path' }), /VECTOR_ALLOWED_ORIGINS/);
});

test('remote mode: a rebinding Host is refused (421) on reads and mutations; nothing changes', async () => {
  const evil = `attacker.example:${port}`;
  assert.equal((await raw({ host: evil })).status, 421);
  const k = await raw({ method: 'POST', path: '/api/kill', host: evil, headers: { origin: `http://${evil}`, 'sec-fetch-site': 'same-origin' }, body: { protective_policy: 'KEEP_PROTECTIVE' } });
  assert.equal(k.status, 421);
  assert.equal(k.json.error.code, 'HOST_NOT_ALLOWED');
  const p = await raw({ method: 'POST', path: '/api/replay/pause', host: evil, headers: { origin: `http://${evil}` }, body: {} });
  assert.equal(p.status, 421);
  assert.equal((await raw({})).json.kill.engaged, false);
  assert.equal(t.db.prepare("SELECT COUNT(*) n FROM journal WHERE type = 'KILL_SWITCH_ENGAGED'").get().n, 0);
});

test('remote mode: loopback and configured hosts are answered; Origin must be on the allow-list, never echoed from Host', async () => {
  assert.equal((await raw({})).status, 200);
  assert.equal((await raw({ host: `vector-test.local:${port}` })).status, 200);
  const ok = await raw({ method: 'POST', path: '/api/replay/pause', host: `vector-test.local:${port}`, headers: { origin: `http://vector-test.local:${port}` }, body: {} });
  assert.equal(ok.status, 200);
  const cross = await raw({ method: 'POST', path: '/api/replay/pause', headers: { origin: `http://attacker.example:${port}` }, body: {} });
  assert.equal(cross.status, 403);
  assert.equal(cross.json.error.code, 'ORIGIN_MISMATCH');
  const httpsUnlisted = await raw({ method: 'POST', path: '/api/replay/pause', headers: { origin: `https://127.0.0.1:${port}` }, body: {} });
  assert.equal(httpsUnlisted.status, 403);
  const httpsListed = await raw({ method: 'POST', path: '/api/replay/pause', headers: { origin: 'https://vector-test.example' }, body: {} });
  assert.equal(httpsListed.status, 200);
});

function mockReq({ url = '/api/status', host, remoteAddress, cookie }) {
  return { url, method: 'GET', headers: { host: host ?? `127.0.0.1:${port}`, ...(cookie ? { cookie } : {}) }, socket: { remoteAddress }, resume() {} };
}
function mockRes() {
  const r = {
    status: null, headers: {}, body: '', headersSent: false,
    writeHead(s, h) { r.status = s; Object.assign(r.headers, h ?? {}); r.headersSent = true; return r; },
    setHeader(k, v) { r.headers[k] = v; },
    end(b) { if (b) r.body += b.toString(); },
    destroy() {},
  };
  return r;
}

test('remote mode: a non-loopback peer needs the per-launch token cookie; the token is never echoed in a body', async () => {
  const handle = createHandler(srv.ctx, { log: () => {} });
  const token = srv.remoteToken;
  assert.ok(typeof token === 'string' && token.length >= 20);
  const peer = '192.0.2.50'; // TEST FIXTURE peer address

  let res = mockRes();
  await handle(mockReq({ remoteAddress: peer }), res);
  assert.equal(res.status, 401);
  assert.equal(JSON.parse(res.body).error.code, 'REMOTE_TOKEN_REQUIRED');

  res = mockRes();
  await handle(mockReq({ url: '/?k=wrong-token', remoteAddress: peer }), res);
  assert.equal(res.status, 401);

  res = mockRes();
  await handle(mockReq({ url: `/?k=${token}`, remoteAddress: peer }), res);
  assert.equal(res.status, 303);
  assert.match(res.headers['set-cookie'], /^vector_k=.+; HttpOnly; SameSite=Strict; Path=\/$/);

  res = mockRes();
  await handle(mockReq({ remoteAddress: peer, cookie: `vector_k=${token}` }), res);
  assert.equal(res.status, 200);
  assert.ok(!res.body.includes(token));

  res = mockRes();
  await handle(mockReq({ remoteAddress: peer, host: `attacker.example:${port}`, cookie: `vector_k=${token}` }), res);
  assert.equal(res.status, 421, 'the token does not lift the Host allow-list');

  res = mockRes();
  await handle(mockReq({ remoteAddress: '127.0.0.1' }), res);
  assert.equal(res.status, 200, 'loopback peers need no token');
});
