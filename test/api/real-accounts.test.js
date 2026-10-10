// TEST FIXTURE / MOCK — NOT REAL ACCOUNT DATA. SnapTrade read-only real accounts against an in-process MOCK SnapTrade
// (it verifies VECTOR's request signatures independently). Every account, symbol (TFXR), amount and date below is
// invented. Adversarial checks from the connections-v1 brief:
//   (a) no trading: no SnapTrade order/trade/cancel call exists in server/ or web/, and /api/real/*order*|*trade* is 404;
//   (b) no secret leaks: sentinel secrets never appear in responses, logs, the journal or any DB table (success + errors);
//   (e) public build: the static server and web/ carry no real-account route, data or secret.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { tempDb, seedFixture, startTestServer, ROOT } from './helpers.js';
import { ROUTES } from '../../server/api/routes.js';
import { requireLoopback } from '../../server/api/real.js';
import {
  createSnapTradeClient, signRequest, canonicalJson, READ_ONLY_OPERATIONS, maskAccountNumber, SNAPTRADE_DEFAULT_BASE_URL,
} from '../../server/data/providers/snaptrade.js';

const LABEL = 'REAL ACCOUNT — READ ONLY';
const ACC = '0f9e8d7c-6b5a-4c3d-9e2f-1a2b3c4d5e6f'; // TEST FIXTURE account id
// Sentinel secrets (TEST FIXTURE): unique strings that must never appear anywhere VECTOR writes or answers.
const SENTINELS = {
  VECTOR_SNAPTRADE_CLIENT_ID: 'SENTINEL-CLIENTID-7f3a91c2',
  VECTOR_SNAPTRADE_CONSUMER_KEY: 'SENTINEL-CONSUMERKEY-b84e0d55',
  VECTOR_SNAPTRADE_USER_SECRET: 'SENTINEL-USERSECRET-c19a6e3f',
  VECTOR_GROQ_API_KEY: 'SENTINEL-GROQKEY-5d2b7a90',
  VECTOR_OPENROUTER_API_KEY: 'SENTINEL-OPENROUTERKEY-e6f1c3a8',
  VECTOR_GEMINI_API_KEY: 'SENTINEL-GEMINIKEY-a4c8e2b6',
};
const cleanups = [];
after(async () => { for (const c of cleanups.reverse()) await c(); });

/** In-process MOCK SnapTrade. mode: ok | auth_error | server_error | network. */
function mockSnapTrade({ consumerKey = SENTINELS.VECTOR_SNAPTRADE_CONSUMER_KEY, mode = 'ok' } = {}) {
  const calls = [];
  const json = (status, obj) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(String(url));
    calls.push({ method: init.method, path: u.pathname, query: Object.fromEntries(u.searchParams), body: init.body ?? null });
    if (mode === 'network') throw Object.assign(new TypeError(`fetch failed for ${url}`), { cause: { code: 'ECONNREFUSED' } });
    // Independent signature check: the payload string is assembled by hand (keys already in sorted order).
    const payload = `{"content":${init.body ?? 'null'},"path":${JSON.stringify(u.pathname)},"query":${JSON.stringify(u.search.slice(1))}}`;
    const expected = crypto.createHmac('sha256', consumerKey).update(payload, 'utf8').digest('base64');
    // Error bodies deliberately echo the caller's credentials, the way a careless upstream might.
    if (init.headers?.Signature !== expected) return json(401, { detail: `bad signature for clientId ${u.searchParams.get('clientId')}`, status_code: 401 });
    if (mode === 'auth_error') return json(401, { detail: `Invalid clientId ${u.searchParams.get('clientId')} or consumerKey ${consumerKey}`, status_code: 401 });
    if (mode === 'server_error') return json(500, { detail: `upstream failure (userSecret=${u.searchParams.get('userSecret')})` });
    const p = u.pathname.replace(/^\/api\/v1/, '');
    if (init.method === 'POST' && p === '/snapTrade/login') return json(200, { redirectURI: 'https://app.snaptrade.example/portal?token=TEST-FIXTURE', sessionId: 'TEST-FIXTURE-SESSION' });
    if (init.method !== 'GET') return json(405, { detail: 'TEST MOCK: method not allowed' });
    if (p === '/accounts') {
      return json(200, [{ id: ACC, name: 'TEST FIXTURE brokerage account', number: 'TESTFIX00004321', institution_name: 'TEST FIXTURE BROKER', status: 'open', raw_type: 'TEST', balance: { total: { amount: 1234.5, currency: 'USD' } } }]);
    }
    if (p === `/accounts/${ACC}/balances`) return json(200, [{ currency: { id: 'x', code: 'USD', name: 'US Dollar' }, cash: 100.25, buying_power: 100.25 }]);
    if (p === `/accounts/${ACC}/positions/all`) return json(404, { detail: 'TEST MOCK: not on this mock' });
    if (p === `/accounts/${ACC}/positions`) return json(200, [{ symbol: { symbol: { symbol: 'TFXR', description: 'TEST FIXTURE REAL HOLDING', currency: { code: 'USD' } } }, units: 3, price: 10.5, average_purchase_price: 9 }]);
    if (p === `/accounts/${ACC}/activities`) {
      return json(200, { data: [{ id: 'tx-fixture-1', type: 'BUY', trade_date: '2099-01-02T00:00:00Z', settlement_date: '2099-01-04T00:00:00Z', symbol: { symbol: 'TFXR' }, units: 3, price: 9, amount: -27, fee: 0, currency: { code: 'USD' }, description: 'TEST FIXTURE BUY' }], pagination: { offset: 0, limit: 1000, total: 1 } });
    }
    return json(404, { detail: 'TEST MOCK: unknown path' });
  };
  return { fetchImpl, calls };
}

async function server(name, env = {}, opts = {}) {
  const t = tempDb(name);
  seedFixture(t.db);
  const s = await startTestServer(t.db, env, opts);
  cleanups.push(async () => { await s.close(); t.cleanup(); });
  return { t, s, api: s.client };
}

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out); else out.push(p);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------- (a)

// SnapTrade's trading surface (endpoint paths and SDK operation names), searched across ALL of server/ and web/. The paper
// engine's own order functions (server/sim, api/trading.js: paper only) are not SnapTrade calls and do not match these.
const SNAPTRADE_TRADING_PATTERNS = [
  /snapTrade\/trade/i, /\/trade\/(place|impact|replace|cancel)/i, /\/accounts\/[^'"`\s]*\/orders/,
  /\bplace(Force|Mleg|Crypto|Bracket|Checked)Order\b/, /\bcancelUserAccountOrder\b/, /\bgetOrderImpact\b/, /\bTrading_/,
  /trade-if-available/, /connectionType\s*:\s*['"`]trade/,
];
// The real-account path itself may not contain ANY order-placing, cancelling or trade-route code at all.
const REAL_PATH_FILES = ['server/data/providers/snaptrade.js', 'server/data/real-accounts.js', 'server/api/real.js', 'web/js/views/real.js'];
const REAL_PATH_PATTERNS = [/\b(place|cancel|replace|submit|preview)[A-Za-z]*Order/i, /['"`/]orders?['"`/?]/i, /\/trade\b/i, /\bBuy\b|\bSell\b/];

test('(a) no trading: no SnapTrade order, trade or cancel call exists anywhere in server/ or web/', () => {
  const files = [...walk(path.join(ROOT, 'server')), ...walk(path.join(ROOT, 'web'))].filter((f) => /\.(m?js|html)$/.test(f));
  const hits = [];
  for (const f of files) {
    const text = fs.readFileSync(f, 'utf8');
    for (const re of SNAPTRADE_TRADING_PATTERNS) if (re.test(text)) hits.push(`${path.relative(ROOT, f)} ~ ${re}`);
  }
  for (const rel of REAL_PATH_FILES) {
    const text = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    for (const re of REAL_PATH_PATTERNS) if (re.test(text)) hits.push(`${rel} ~ ${re}`);
  }
  assert.deepEqual(hits, [], 'grep for SnapTrade trading calls returns nothing');
  // The grep is not vacuous: it flags planted trading code (TEST FIXTURE snippets, never shipped).
  const planted = ["client.placeForceOrder({ accountId })", "fetch(`${base}/trade/place`)", "path: `/accounts/${id}/orders/cancel`", "connectionType: 'trade'", "body: { connectionType: 'trade-if-available' }"];
  for (const snippet of planted) assert.ok(SNAPTRADE_TRADING_PATTERNS.some((re) => re.test(snippet)), `pattern set catches: ${snippet}`);
  for (const snippet of ["['POST', '/api/real/orders', h]", 'async placeOrder() {}', "h('button', null, 'Buy')"]) assert.ok(REAL_PATH_PATTERNS.some((re) => re.test(snippet)), `real-path set catches: ${snippet}`);
  // The client's whole surface: one read-only portal link and four GET reads.
  assert.deepEqual(READ_ONLY_OPERATIONS.map((o) => `${o.method} ${o.name}`),
    ['POST connectionPortalLink', 'GET listAccounts', 'GET accountBalances', 'GET accountPositions', 'GET accountActivities']);
  const c = createSnapTradeClient({ env: {} });
  assert.deepEqual(Object.keys(c).sort(), ['accountActivities', 'accountBalances', 'accountPositions', 'config', 'connectionPortalLink', 'listAccounts']);
  // No /api/real/ route mentions orders, trades or cancels.
  const real = ROUTES.filter((r) => r.path.startsWith('/api/real/'));
  assert.equal(real.length, 5);
  assert.deepEqual(real.filter((r) => /order|trade|cancel/i.test(r.path)), []);
});

test('(a) no trading: every /api/real/ path containing order or trade answers 404 for every method', async () => {
  const { api } = await server('real-a', SENTINELS, { snaptradeFetch: mockSnapTrade().fetchImpl });
  const paths = ['/api/real/orders', '/api/real/order', '/api/real/trade', '/api/real/trades', '/api/real/trade/place', '/api/real/order/impact',
    `/api/real/accounts/${ACC}/orders`, `/api/real/orders/${ACC}/cancel`, '/api/real/cancel', '/api/real/accounts/orders'];
  const seen = [];
  for (const p of paths) {
    for (const m of ['GET', 'POST', 'PUT', 'DELETE']) {
      const r = await api.raw(m, p, m === 'GET' || m === 'DELETE' ? undefined : {});
      seen.push(`${m} ${p} -> ${r.status}`);
      assert.equal(r.status, 404, `${m} ${p}`);
    }
  }
  assert.equal(seen.length, 40);
});

// ------------------------------------------------------------------------------------------------- signing + not configured

test('signing: HMAC-SHA256 over sorted canonical JSON {content, path, query}, base64 (matches a hand-built payload)', () => {
  assert.equal(canonicalJson({ b: 1, a: { d: [2, { z: 1, y: 2 }], c: null } }), '{"a":{"c":null,"d":[2,{"y":2,"z":1}]},"b":1}');
  const sig = signRequest({ consumerKey: 'TEST-FIXTURE-KEY', path: '/api/v1/accounts', query: 'clientId=TESTCLIENT&timestamp=4070908800', content: null });
  const manual = crypto.createHmac('sha256', 'TEST-FIXTURE-KEY').update('{"content":null,"path":"/api/v1/accounts","query":"clientId=TESTCLIENT&timestamp=4070908800"}').digest('base64');
  assert.equal(sig, manual);
  assert.equal(signRequest({ consumerKey: 'k', path: '/p', query: 'q', content: {} }), signRequest({ consumerKey: 'k', path: '/p', query: 'q', content: null }), 'an empty body signs as null');
  assert.equal(SNAPTRADE_DEFAULT_BASE_URL, 'https://api.snaptrade.com/api/v1');
  assert.equal(maskAccountNumber('TESTFIX00004321'), '••••4321');
});

test('not configured: BLOCKED: SNAPTRADE_NOT_CONFIGURED everywhere, nothing faked, no request made', async () => {
  const mock = mockSnapTrade();
  const { api } = await server('real-blocked', {}, { snaptradeFetch: mock.fetchImpl });
  const st = await api.get('/api/real/status');
  assert.equal(st.status, 200);
  assert.equal(st.json.status, 'BLOCKED');
  assert.equal(st.json.code, 'SNAPTRADE_NOT_CONFIGURED');
  assert.equal(st.json.uiText, 'BLOCKED: SNAPTRADE_NOT_CONFIGURED');
  assert.equal(st.json.label, LABEL);
  const acc = await api.get('/api/real/accounts');
  assert.equal(acc.json.status, 'BLOCKED');
  assert.equal(acc.json.snapshot, null);
  const sync = await api.post('/api/real/sync', { confirm: true });
  assert.equal(sync.status, 409);
  assert.equal(sync.json.error.code, 'SNAPTRADE_NOT_CONFIGURED');
  assert.equal((await api.post('/api/real/connect', {})).json.error.code, 'SNAPTRADE_NOT_CONFIGURED');
  assert.equal(mock.calls.length, 0);
});

// -------------------------------------------------------------------------------------- mocked sync + (b) secret leaks

test('mocked SnapTrade: Personal-key connect + sync store REAL_ACCOUNT rows; paper accounts and the journal are untouched; (b) no sentinel leaks', async () => {
  const mock = mockSnapTrade();
  const env = { ...SENTINELS };
  delete env.VECTOR_SNAPTRADE_USER_SECRET; // Personal key: no user credentials
  const { t, s, api } = await server('real-ok', env, { snaptradeFetch: mock.fetchImpl });
  const texts = [];
  const keep = (r) => { texts.push(r.text); return r; };
  const paperBefore = keep(await api.get('/api/portfolios')).text;
  const journalBefore = t.db.prepare('SELECT COUNT(*) n FROM journal').get().n;

  const conn = keep(await api.post('/api/real/connect', {}));
  assert.equal(conn.status, 200, conn.text);
  assert.equal(conn.json.connectionType, 'read');
  assert.equal(conn.json.expiresInSeconds, 300);
  assert.match(conn.json.redirectURI, /^https:\/\//);
  const login = mock.calls.find((c) => c.path === '/api/v1/snapTrade/login');
  assert.deepEqual(JSON.parse(login.body), { connectionType: 'read' });

  assert.equal(keep(await api.post('/api/real/sync', {})).json.error.code, 'CONFIRMATION_REQUIRED');
  const sync = keep(await api.post('/api/real/sync', { confirm: true }));
  assert.equal(sync.status, 200, sync.text);
  assert.deepEqual({ ...sync.json.counts, activity_window_days: undefined, transactions_truncated: undefined }, { accounts: 1, balances: 1, positions: 1, transactions: 1, activity_window_days: undefined, transactions_truncated: undefined });
  assert.equal(sync.json.data_class, 'REAL_ACCOUNT');
  assert.equal(sync.json.source, 'SNAPTRADE');
  // Personal mode: clientId + timestamp only, never user credentials; every call was a read.
  for (const c of mock.calls) {
    assert.ok(c.query.clientId && c.query.timestamp, c.path);
    assert.equal(c.query.userId, undefined);
    assert.equal(c.query.userSecret, undefined);
    assert.ok(c.method === 'GET' || c.path === '/api/v1/snapTrade/login', `${c.method} ${c.path}`);
  }
  assert.ok(mock.calls.some((c) => c.path.endsWith('/positions')), 'positions fall back to the per-account path on 404');
  const cool = keep(await api.post('/api/real/sync', { confirm: true }));
  assert.equal(cool.status, 429);
  assert.equal(cool.json.error.code, 'REAL_SYNC_COOLDOWN');

  const acc = keep(await api.get('/api/real/accounts'));
  assert.equal(acc.json.label, LABEL);
  assert.equal(acc.json.status, 'SYNCED');
  const a = acc.json.snapshot.accounts[0];
  assert.equal(a.number_masked, '••••4321');
  assert.equal(a.positions[0].symbol, 'TFXR');
  assert.equal(a.positions[0].market_value, 31.5);
  assert.equal(a.positions[0].cost_basis, 27);
  const tx = keep(await api.get('/api/real/transactions?limit=10'));
  assert.equal(tx.json.rows.length, 1);
  assert.equal(tx.json.rows[0].type, 'BUY');
  keep(await api.get('/api/real/status'));
  keep(await api.get('/api/model/presets'));
  keep(await api.get('/api/model'));
  keep(await api.get('/api/status'));
  keep(await api.get('/api/journal?limit=200'));

  // Real holdings never feed paper-account logic; a sync writes no journal row.
  assert.equal(keep(await api.get('/api/portfolios')).text, paperBefore);
  assert.equal(t.db.prepare('SELECT COUNT(*) n FROM journal').get().n, journalBefore);
  for (const tbl of ['real_accounts', 'real_balances', 'real_positions', 'real_transactions', 'real_sync_runs']) {
    const r = t.db.prepare(`SELECT COUNT(*) n, MIN(data_class) dc, MIN(source) src FROM ${tbl}`).get();
    assert.ok(r.n >= 1, tbl);
    assert.equal(r.dc, 'REAL_ACCOUNT', tbl);
    assert.equal(r.src, 'SNAPTRADE', tbl);
  }
  assert.equal(t.db.prepare("SELECT COUNT(*) n FROM positions WHERE sym = 'TFXR'").get().n, 0, 'no paper position from a real holding');
  assertNoSentinels([...texts, ...s.logs, dumpDb(t.db)], 'success path');
});

test('(b) no secret leaks on error paths: upstream 401 echoing the credentials, upstream 500, network failure', async () => {
  for (const mode of ['auth_error', 'server_error', 'network']) {
    const mock = mockSnapTrade({ mode });
    const { t, s, api } = await server(`real-${mode}`, { ...SENTINELS, VECTOR_SNAPTRADE_USER_ID: 'TEST-FIXTURE-USER' }, { snaptradeFetch: mock.fetchImpl });
    const texts = [];
    const r = await api.post('/api/real/sync', { confirm: true });
    texts.push(r.text);
    assert.equal(r.status, 502, `${mode}: ${r.text}`);
    assert.match(r.json.error.code, /^SNAPTRADE_/);
    assert.match(r.json.error.message, /^SnapTrade \w+ (returned HTTP \d+|could not be reached)/, 'the owner sees what failed (secret-free text)');
    const c = await api.post('/api/real/connect', {});
    texts.push(c.text);
    assert.equal(c.status, 502);
    texts.push((await api.get('/api/real/status')).text);
    assert.equal(JSON.parse(texts[2]).lastSync.status, 'FAILED');
    if (mode !== 'network') {
      // With user credentials set, they were sent (to the mock) - and still never echoed back by VECTOR.
      assert.equal(mock.calls[0].query.userSecret, SENTINELS.VECTOR_SNAPTRADE_USER_SECRET);
    }
    assertNoSentinels([...texts, ...s.logs, dumpDb(t.db)], mode);
  }
});

test('(b) percent-encoded secrets are scrubbed too (an upstream echoing the request URL)', async () => {
  const env = { VECTOR_SNAPTRADE_CLIENT_ID: 'Sent+Client/Id=9z', VECTOR_SNAPTRADE_CONSUMER_KEY: 'TEST-FIXTURE-CONSUMER', VECTOR_SNAPTRADE_USER_ID: 'TEST-FIXTURE-USER', VECTOR_SNAPTRADE_USER_SECRET: 'Sent+User/Secret==' };
  const echo = async (url) => new Response(JSON.stringify({ detail: `rejected ${url}` }), { status: 401, headers: { 'content-type': 'application/json' } });
  const c = createSnapTradeClient({ env, fetchImpl: echo });
  await assert.rejects(c.listAccounts(), (e) => {
    for (const v of [env.VECTOR_SNAPTRADE_CLIENT_ID, env.VECTOR_SNAPTRADE_USER_SECRET, env.VECTOR_SNAPTRADE_USER_ID]) {
      for (const f of [v, encodeURIComponent(v), new URLSearchParams({ x: v }).toString().slice(2)]) assert.ok(!e.message.includes(f), `no ${f} in: ${e.message}`);
    }
    return true;
  });
  const thrower = async (url) => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: `bad ${url}` } }); };
  await assert.rejects(createSnapTradeClient({ env, fetchImpl: thrower }).listAccounts(), (e) => e.code === 'SNAPTRADE_UNREACHABLE' && !/Sent|https?:/.test(e.message));
});

test('(b) client errors never carry a secret or a URL, even when the upstream echoes them', async () => {
  const c = createSnapTradeClient({ env: { ...SENTINELS, VECTOR_SNAPTRADE_USER_ID: 'TEST-FIXTURE-USER' }, fetchImpl: mockSnapTrade({ mode: 'auth_error' }).fetchImpl });
  await assert.rejects(c.listAccounts(), (e) => {
    assert.equal(e.code, 'SNAPTRADE_AUTH_REJECTED');
    assertNoSentinels([e.message, e.stack ?? ''], 'error object');
    assert.doesNotMatch(e.message, /https?:\/\//);
    return true;
  });
});

function dumpDb(db) {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT IN ('m1')").all().map((r) => r.name);
  return JSON.stringify(Object.fromEntries(tables.map((n) => [n, db.prepare(`SELECT * FROM "${n}"`).all()])));
}

function assertNoSentinels(texts, where) {
  const blob = texts.join('\n');
  const hits = Object.entries(SENTINELS).filter(([, v]) => blob.includes(v)).map(([k]) => k);
  assert.deepEqual(hits, [], `${where}: sentinel secrets found`);
}

// ------------------------------------------------------------------------------------------------ loopback + (e) public

test('real-account routes answer only a loopback peer of a loopback-bound server, never through a proxy', () => {
  const ctx = { config: { allowRemote: false } };
  const req = (addr, headers = {}) => ({ socket: { remoteAddress: addr }, headers });
  assert.doesNotThrow(() => requireLoopback(ctx, req('127.0.0.1')));
  assert.doesNotThrow(() => requireLoopback(ctx, req('::1')));
  for (const [c, r] of [[ctx, req('192.168.1.20')], [ctx, req('127.0.0.1', { 'x-forwarded-for': '203.0.113.9' })], [ctx, req('127.0.0.1', { forwarded: 'for=203.0.113.9' })], [{ config: { allowRemote: true } }, req('127.0.0.1')]]) {
    assert.throws(() => requireLoopback(c, r), (e) => e.status === 403 && e.code === 'REAL_DATA_LOOPBACK_ONLY');
  }
});

test('(e) public build: web/ holds no real-account data, secrets or SnapTrade API host; the static server serves only web/', async () => {
  const files = walk(path.join(ROOT, 'web'));
  assert.deepEqual(files.filter((f) => /\.(json|csv|db|sqlite|env)$/i.test(f)).map((f) => path.relative(ROOT, f)), [], 'no data files in the static build');
  const hits = [];
  for (const f of files.filter((x) => /\.(m?js|html|css|svg)$/.test(x))) {
    const text = fs.readFileSync(f, 'utf8');
    if (/api\.snaptrade\.com/.test(text)) hits.push(`${f}: SnapTrade API host`);
    if (/TFXR|TEST FIXTURE REAL/.test(text)) hits.push(`${f}: fixture holding`);
    for (const v of Object.values(SENTINELS)) if (text.includes(v)) hits.push(`${f}: sentinel`);
  }
  assert.deepEqual(hits, []);
  // The Real accounts view checks the host before any request: on a non-loopback host (a static preview) it asks nothing.
  const view = fs.readFileSync(path.join(ROOT, 'web', 'js', 'views', 'real.js'), 'utf8');
  const guard = view.indexOf('if (!LOOPBACK.has(location.hostname))');
  assert.ok(guard > 0 && guard < view.indexOf("api.get('/api/real/"), 'loopback guard precedes every /api/real request');
  // The static handler never serves server code, config or data.
  const { api } = await server('real-e', SENTINELS, { snaptradeFetch: mockSnapTrade().fetchImpl });
  for (const p of ['/server/api/real.js', '/config/model-presets.json', '/data/vector.db', '/../data/vector.db', '/.env']) {
    const r = await api.get(p);
    assert.notEqual(r.status, 200, p);
  }
  // Real-account data lives in the gitignored DB; no DB or .env is tracked.
  const ignore = fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8');
  assert.match(ignore, /^data\/\*\.db$/m);
  assert.match(ignore, /^\.env$/m);
  let tracked = null;
  try { tracked = execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' }); } catch { tracked = null; }
  if (tracked !== null) assert.deepEqual(tracked.split('\n').filter((f) => /\.db$|(^|\/)\.env$/.test(f)), []);
});
