// TEST FIXTURE. Hosted-demo mode (VECTOR_DEPLOYMENT=hosted-demo behind a hosting proxy): a fixed access token from
// VECTOR_REMOTE_TOKEN (survives restarts, never printed), default-port Host names (https proxies send no port), the UI's
// deployment label, and real accounts staying refused. The host name, origin, token and peer below are invented.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { tempDb, seedFixture, startTestServer } from './helpers.js';
import { allowedHosts, createHandler } from '../../server/index.js';
import { loadConfig } from '../../server/config.js';

const HOST = 'vector-demo.example.test';
const TOKEN = 'TESTFIXTURE_fixed-demo-token_0123456789';
const PEER = '203.0.113.7'; // the hosting proxy's address as the server sees it
let t;
let srv;

before(async () => {
  t = tempDb('hosted');
  seedFixture(t.db);
  srv = await startTestServer(t.db, {
    VECTOR_ALLOW_REMOTE: '1', VECTOR_ALLOWED_HOSTS: `${HOST}:443`, VECTOR_ALLOWED_ORIGINS: `https://${HOST}`,
    VECTOR_REMOTE_TOKEN: TOKEN, VECTOR_DEPLOYMENT: 'hosted-demo',
  });
});
after(async () => { await srv?.close(); t?.cleanup(); });

function req({ url = '/api/status', cookie, headers = {} } = {}) {
  return { url, method: 'GET', headers: { host: HOST, ...(cookie ? { cookie } : {}), ...headers }, socket: { remoteAddress: PEER }, resume() {} };
}
function res() {
  const r = {
    status: null, headers: {}, body: '', headersSent: false,
    writeHead(s, h) { r.status = s; Object.assign(r.headers, h ?? {}); r.headersSent = true; return r; },
    setHeader(k, v) { r.headers[k] = v; }, end(b) { if (b) r.body += b.toString(); }, destroy() {},
  };
  return r;
}

test('config: VECTOR_REMOTE_TOKEN and VECTOR_DEPLOYMENT are validated; hosted-demo needs remote mode', () => {
  assert.throws(() => loadConfig({ VECTOR_ALLOW_REMOTE: '1', VECTOR_REMOTE_TOKEN: 'short' }), /VECTOR_REMOTE_TOKEN must be/);
  assert.throws(() => loadConfig({ VECTOR_REMOTE_TOKEN: TOKEN }), /only used with VECTOR_ALLOW_REMOTE=1/);
  assert.throws(() => loadConfig({ VECTOR_DEPLOYMENT: 'hosted-demo' }), /requires VECTOR_ALLOW_REMOTE=1/);
  assert.throws(() => loadConfig({ VECTOR_DEPLOYMENT: 'public' }), /VECTOR_DEPLOYMENT must be/);
  assert.equal(loadConfig({}).app.deployment, 'local');
  try { loadConfig({ VECTOR_ALLOW_REMOTE: '1', VECTOR_REMOTE_TOKEN: 'short' }); } catch (e) { assert.ok(!e.message.includes('short'), 'the value is not shown'); }
});

test('allow-list: a :443 / :80 entry also accepts the bare host name (default ports are omitted from Host)', () => {
  const h = allowedHosts(10000, { allowRemote: true, host: '0.0.0.0', allowedHosts: [`${HOST}:443`] }, {});
  assert.ok(h.has(HOST) && h.has(`${HOST}:443`));
  assert.ok(!allowedHosts(10000, { allowRemote: true, host: '0.0.0.0', allowedHosts: [`${HOST}:8443`] }, {}).has(HOST));
});

test('hosted demo: the fixed token works through the proxy, is never printed or echoed; real accounts stay refused', async () => {
  assert.equal(srv.remoteToken, TOKEN);
  const handle = createHandler(srv.ctx, { log: () => {} });
  let r = res();
  await handle(req(), r);
  assert.equal(r.status, 401, 'no token, no access');
  r = res();
  await handle(req({ url: `/?k=${TOKEN}` }), r);
  assert.equal(r.status, 303);
  r = res();
  await handle(req({ cookie: `vector_k=${TOKEN}` }), r);
  assert.equal(r.status, 200);
  const st = JSON.parse(r.body);
  assert.equal(st.app.deployment, 'hosted-demo');
  assert.ok(!r.body.includes(TOKEN));
  r = res();
  await handle(req({ url: '/api/real/status', cookie: `vector_k=${TOKEN}` }), r);
  assert.equal(r.status, 403);
  assert.equal(JSON.parse(r.body).error.code, 'REAL_DATA_LOOPBACK_ONLY');
  assert.ok(!srv.logs.join('\n').includes(TOKEN), 'the fixed token is not logged');
});

test('UI label: hosted-demo, static preview and local are told apart', async () => {
  globalThis.location = { hostname: HOST };
  const { deployNote } = await import('../../web/js/deploy-note.js');
  assert.match(deployNote({ apiReachable: true, deployment: 'hosted-demo' }).short, /^Hosted demo/);
  assert.match(deployNote({ apiReachable: null }).short, /^Static preview/);
  assert.match(deployNote({ apiReachable: true, deployment: 'local' }).short, /^Local MVP/);
  delete globalThis.location;
});
