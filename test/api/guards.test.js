// TEST FIXTURE — NOT MARKET DATA. HTTP guards: CSRF, content type, origin, host allow-list, body limit, strict
// validation, error envelope, static serving (CSP, no traversal), and no secrets in /api/status or /api/model.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { tempDb, seedFixture, startTestServer, FIX_DS } from './helpers.js';
import { loadConfig } from '../../server/config.js';

let t;
let srv;
let api;

// TEST FIXTURE secret-looking values: they must never appear in any response body.
const FAKE_KEYS = {
  ANTHROPIC_API_KEY: 'sk-ant-TESTFIXTURE-not-a-real-key-0001',
  ANTHROPIC_AUTH_TOKEN: 'TESTFIXTURE-anthropic-auth-token-0004',
  VECTOR_OPENAI_API_KEY: 'TESTFIXTURE-openai-not-a-real-key-0002',
  POLYGON_API_KEY: 'TESTFIXTURE-polygon-not-a-real-key-0003',
};

before(async () => {
  t = tempDb('guards');
  seedFixture(t.db);
  srv = await startTestServer(t.db, {
    ...FAKE_KEYS,
    VECTOR_MODEL_PROVIDER: 'openai-compatible',
    VECTOR_OPENAI_BASE_URL: 'http://127.0.0.1:9/v1', // nothing listens on the discard port: status -> DISCONNECTED
    VECTOR_OPENAI_MODEL: 'test-fixture-model',
  });
  api = srv.client;
});
after(async () => { await srv?.close(); t?.cleanup(); });

const assertEnvelope = (r, status, code) => {
  assert.equal(r.status, status, r.text);
  assert.equal(typeof r.json?.error?.message, 'string');
  if (code) assert.equal(r.json.error.code, code);
  assert.ok(!/\bat .+\.js:\d+/.test(r.text), 'no stack traces in error bodies');
};

test('config refuses non-loopback hosts unless VECTOR_ALLOW_REMOTE=1, and validates the port', () => {
  assert.throws(() => loadConfig({ VECTOR_HOST: '0.0.0.0' }), /VECTOR_ALLOW_REMOTE/);
  assert.equal(loadConfig({ VECTOR_HOST: '0.0.0.0', VECTOR_ALLOW_REMOTE: '1' }).host, '0.0.0.0');
  assert.equal(loadConfig({}).host, '127.0.0.1');
  assert.equal(loadConfig({}).port, 8787);
  assert.throws(() => loadConfig({ VECTOR_PORT: 'abc' }), /VECTOR_PORT/);
  assert.throws(() => loadConfig({ VECTOR_STARTING_CASH_USD: '-5' }), /STARTING_CASH/);
  const c = loadConfig({ ...FAKE_KEYS });
  assert.ok(!JSON.stringify(c).includes(FAKE_KEYS.ANTHROPIC_API_KEY), 'config never holds secret values');
  assert.equal(c.secretsPresent.ANTHROPIC_API_KEY, true);
});

test('CSRF guard: mutations need X-Vector-Client: web and application/json; cross-origin is refused', async () => {
  assertEnvelope(await api.post('/api/kill', { protective_policy: 'KEEP_PROTECTIVE' }, { 'x-vector-client': '' }), 403, 'CSRF_GUARD');
  assertEnvelope(await api.post('/api/kill', { protective_policy: 'KEEP_PROTECTIVE' }, { 'x-vector-client': 'curl' }), 403, 'CSRF_GUARD');
  assertEnvelope(await api.post('/api/kill', 'protective_policy=KEEP_PROTECTIVE', { 'content-type': 'application/x-www-form-urlencoded' }), 415, 'UNSUPPORTED_MEDIA_TYPE');
  assertEnvelope(await api.post('/api/kill', '{}', { 'content-type': 'text/plain' }), 415, 'UNSUPPORTED_MEDIA_TYPE');
  assertEnvelope(await api.post('/api/kill', {}, { origin: 'http://evil.example' }), 403, 'ORIGIN_MISMATCH');
  assertEnvelope(await api.post('/api/kill', {}, { 'sec-fetch-site': 'cross-site' }), 403, 'ORIGIN_MISMATCH');
  // Nothing above changed state.
  assert.equal((await api.get('/api/status')).json.kill.engaged, false);
  const k = t.db.prepare("SELECT COUNT(*) n FROM journal WHERE type = 'KILL_SWITCH_ENGAGED'").get().n;
  assert.equal(k, 0);
});

test('body limit, malformed JSON and non-object bodies are rejected with the error envelope', async () => {
  assertEnvelope(await api.post('/api/replay/step', `{"minutes":1,"pad":"${'x'.repeat(70 * 1024)}"}`), 413, 'BODY_TOO_LARGE');
  assertEnvelope(await api.post('/api/replay/step', '{"minutes":'), 400, 'BAD_JSON');
  assertEnvelope(await api.post('/api/replay/step', '[1,2]'), 400, 'BODY_NOT_OBJECT');
});

test('deeply nested or oversized-structure bodies get 400 (not a 500 stack overflow)', async () => {
  const deep = `{"action":"open","instrument":{"kind":"equity","sym":"TFXA"},"side":"buy","order_type":"market","qty":1,"confirm":true,"evidence_refs":${'['.repeat(12_000)}${']'.repeat(12_000)}}`;
  assert.ok(deep.length < 64 * 1024);
  assertEnvelope(await api.post('/api/orders', deep), 400, 'BODY_TOO_DEEP');
  const opt = `{"contract":{"occ":${'['.repeat(12_000)}${']'.repeat(12_000)}},"contracts":1,"limit_px_u":1}`;
  assertEnvelope(await api.post('/api/options/orders', opt), 400, 'BODY_TOO_DEEP');
  assertEnvelope(await api.post('/api/orders', `{"evidence_refs":[${Array(20_001).fill('0').join(',')}]}`), 400, 'BODY_TOO_COMPLEX');
  assert.ok(!srv.logs.some((l) => /RangeError/.test(l)), 'no stack overflow reached the handlers');
});

test('query keys that collide with Object.prototype members are rejected like any unknown key', async () => {
  for (const k of ['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'valueOf']) {
    assertEnvelope(await api.get(`/api/journal?${k}=1`), 400, 'UNKNOWN_FIELD');
  }
  assert.equal((await api.get('/api/journal?limit=1')).status, 200);
});

test('strict validation: symbols, enums, integer bounds, unknown fields, unknown routes and methods', async () => {
  assertEnvelope(await api.get('/api/market/bars?sym=bad$sym'), 400, 'SYMBOL_INVALID');
  assertEnvelope(await api.get('/api/market/bars'), 400, 'SYMBOL_INVALID');
  assertEnvelope(await api.get('/api/market/bars?sym=TFXA&extra=1'), 400, 'UNKNOWN_FIELD');
  assertEnvelope(await api.get('/api/research/opportunities?segment=giant'), 400, 'ENUM_INVALID');
  assertEnvelope(await api.get('/api/journal?limit=0'), 400, 'INT_INVALID');
  assertEnvelope(await api.get('/api/journal?limit=5000'), 400, 'INT_INVALID');
  assertEnvelope(await api.get('/api/journal?type=drop%20table'), 400, 'TYPE_INVALID');
  assertEnvelope(await api.post('/api/replay/step', { minutes: 0 }), 400, 'INT_INVALID');
  assertEnvelope(await api.post('/api/replay/step', { minutes: 1.5 }), 400, 'INT_INVALID');
  assertEnvelope(await api.post('/api/replay/step', { minutes: 391 }), 400, 'INT_INVALID');
  assertEnvelope(await api.post('/api/kill', { protective_policy: 'SOMETIMES' }), 400, 'ENUM_INVALID');
  assertEnvelope(await api.post('/api/orders', { action: 'open', instrument: { kind: 'equity', sym: 'TFXA' }, side: 'buy', order_type: 'market', qty: 1, confirm: true, sneaky: 1 }), 400, 'UNKNOWN_FIELD');
  assertEnvelope(await api.post('/api/orders', { action: 'open', instrument: { kind: 'equity', sym: 'tfxa!' }, side: 'buy', order_type: 'market', qty: 1, confirm: true }), 400, 'SYMBOL_INVALID');
  assertEnvelope(await api.post('/api/orders', { action: 'open', instrument: { kind: 'equity', sym: 'TFXA' }, side: 'buy', order_type: 'market', qty: 1.5, confirm: true }), 400, 'INTENT_INVALID');
  assertEnvelope(await api.post('/api/orders', { source: 'rules', action: 'open', instrument: { kind: 'equity', sym: 'TFXA' }, side: 'buy', order_type: 'market', qty: 1, confirm: true }), 400, 'SOURCE_INVALID');
  assertEnvelope(await api.post('/api/orders', { action: 'open', instrument: { kind: 'equity', sym: 'TFXA' }, side: 'buy', order_type: 'market', qty: 1, confirm: 'yes' }), 400, 'BOOL_INVALID');
  assertEnvelope(await api.post('/api/replay/reset', { ds: 'no such ds!' }), 400, 'ID_INVALID');
  assertEnvelope(await api.post('/api/replay/reset', { ds: 'missing-dataset' }), 404, 'DATASET_NOT_FOUND');
  assertEnvelope(await api.post('/api/agents/agent-nobody-micro/start', {}), 404, 'AGENT_NOT_FOUND');
  assertEnvelope(await api.put('/api/agents/agent-cowboy-micro/strategy', { strategy: { id: 'x' } }), 422, 'STRATEGY_INVALID');
  assertEnvelope(await api.get('/api/portfolios/not-a-portfolio'), 404, 'PORTFOLIO_NOT_FOUND');
  assertEnvelope(await api.get('/api/nope'), 404, 'NOT_FOUND');
  const m = await api.raw('DELETE', '/api/status');
  assertEnvelope(m, 405, 'METHOD_NOT_ALLOWED');
  assert.equal(m.headers.get('allow'), 'GET');
  // Rejected order requests are still journaled as attempts.
  assert.ok(t.db.prepare("SELECT COUNT(*) n FROM journal WHERE type = 'ORDER_REJECTED'").get().n >= 1);
});

test('host allow-list blocks DNS-rebinding style requests', async () => {
  const http = await import('node:http');
  const port = new URL(srv.url).port;
  const status = await new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/api/status', headers: { host: 'evil.example' } }, (res) => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject);
    req.end();
  });
  assert.equal(status, 421);
});

test('static files: index with CSP + no-store, JS content type, no traversal, no dotfiles', async () => {
  const idx = await api.get('/');
  assert.equal(idx.status, 200);
  assert.match(idx.headers.get('content-type'), /^text\/html/);
  assert.equal(idx.headers.get('cache-control'), 'no-store');
  assert.match(idx.headers.get('content-security-policy'), /default-src 'self'/);
  assert.equal(idx.headers.get('x-content-type-options'), 'nosniff');
  const js = await api.get('/js/app.js');
  assert.equal(js.status, 200);
  assert.match(js.headers.get('content-type'), /^text\/javascript/);
  for (const p of ['/../package.json', '/%2e%2e/package.json', '/js/%2e%2e/%2e%2e/package.json', '/..%5cpackage.json', '/.gitignore', '/js/']) {
    const r = await api.get(p);
    assert.ok(r.status === 404 || r.status === 400, `${p} -> ${r.status}`);
    assert.ok(!r.text.includes('"vector-rcl"'), `${p} leaked package.json`);
  }
  assert.equal((await api.raw('POST', '/index.html', {}, {})).status, 405);
});

test('no secrets in /api/status, /api/model or /api/sources; presence flags only', async () => {
  for (const p of ['/api/status', '/api/model', '/api/sources', '/api/options/status']) {
    const r = await api.get(p);
    assert.equal(r.status, 200, p);
    for (const v of Object.values(FAKE_KEYS)) assert.ok(!r.text.includes(v), `${p} leaked a secret value`);
  }
  const m = (await api.get('/api/model')).json;
  assert.equal(m.keysPresent.ANTHROPIC_API_KEY, true);
  assert.equal(m.keysPresent.VECTOR_OPENAI_API_KEY, true);
  assert.equal(m.keysPresent.ANTHROPIC_AUTH_TOKEN, true);
  assert.ok(srv.ctx.secrets.includes(FAKE_KEYS.ANTHROPIC_AUTH_TOKEN), 'the auth token is scrubbed from responses');
  assert.equal(m.provider, 'openai-compatible');
  assert.notEqual(m.status, 'CONNECTED'); // nothing is listening; never assumed connected
  const s = (await api.get('/api/status')).json;
  assert.equal(s.app.paperOnly, true);
  assert.equal(s.app.liveBroker, 'NONE — out of MVP scope');
  assert.equal(s.data.mode, 'HISTORICAL_REAL'); // boot reset picked the (fixture) market dataset
  assert.equal(s.data.dataset.id, FIX_DS);
  assert.equal(s.data.live.status, 'NO_VERIFIED_DATA');
  assert.equal(s.options.status, 'NO_VERIFIED_OPTIONS_DATA');
});

test('response scrubbing replaces configured secret values and URL credentials even if a handler leaked them', async () => {
  const { sendJson } = await import('../../server/api/http.js');
  let written = '';
  const res = { writeHead() {}, end(b) { written = b.toString(); } };
  sendJson(res, 200, { a: `key=${FAKE_KEYS.POLYGON_API_KEY}`, u: 'https://user:pw@example.invalid/x' }, { secrets: Object.values(FAKE_KEYS) });
  assert.ok(!written.includes(FAKE_KEYS.POLYGON_API_KEY));
  assert.ok(!written.includes('user:pw'));
  assert.match(written, /\[REDACTED\]/);
});
