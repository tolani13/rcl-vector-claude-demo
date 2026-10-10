// TEST FIXTURE — NOT MARKET DATA. POST /api/feeds/verify and POST /api/options/verify against an injected in-process
// fetch stub (no network): human-only (CSRF guard), strict keys, 409 NO_VERIFIED_DATA without a provider, single-flight,
// 30 s cooldown, FEED_VERIFY journaled without secrets or prices, and nothing reaches the replay. The quotes, contracts
// and credentials below are invented.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { tempDb, seedFixture, startTestServer, SYM } from './helpers.js';
import { resetVerification, setFeedVerifyControl, OPTIONS_VERIFY_SCOPE } from '../../server/data/providers/index.js';

const FAKE = { ALPACA_API_KEY_ID: 'TESTFIXTURE-alpaca-key-id-0001', ALPACA_API_SECRET_KEY: 'TESTFIXTURE-alpaca-secret-0002' };
const STUB = 'http://alpaca-stub.invalid';
const OCC = 'TFXA991218P00000500';      // invented OCC symbol (TEST FIXTURE)
const BID = 0.4987;                      // invented quote values (TEST FIXTURE); they must never appear in a response
const ASK = 0.5013;

let none;   // server with no market-data provider
let alp;    // server with fake Alpaca credentials and the stub fetch
let alpOpra;
let tNone;
let tAlp;
let tOpra;
const requests = [];
let hold = null; // when set, the stub waits for this promise before answering (single-flight test)

function stubFetch({ optionsFeedOverride = null } = {}) {
  return async (url, init = {}) => {
    const u = new URL(url);
    requests.push({ path: u.pathname, query: Object.fromEntries(u.searchParams), headers: init.headers ?? {} });
    if (hold) await hold;
    const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    if (u.pathname === `/v2/stocks/${SYM}/quotes/latest`) {
      return json({ symbol: SYM, quote: { t: new Date(Date.now() - 5_000).toISOString(), bp: BID, ap: ASK, bs: 100, as: 100, bx: 'V', ax: 'V', c: ['R'], z: 'C' } });
    }
    if (u.pathname === '/v2/stocks/TFXB/quotes/latest') {
      // A provider error whose text echoes the secret (TEST FIXTURE): it must be scrubbed everywhere.
      return json({ message: `forbidden for key ${FAKE.ALPACA_API_SECRET_KEY} token=${FAKE.ALPACA_API_KEY_ID}` }, 401);
    }
    if (u.pathname === '/v2/options/contracts') {
      return json({ option_contracts: [{ symbol: OCC, underlying_symbol: SYM, expiration_date: '2099-12-18', strike_price: '0.5', type: 'put', size: '100', style: 'american', tradable: true, status: 'active' }] });
    }
    if (u.pathname === '/v1beta1/options/quotes/latest') {
      const feed = optionsFeedOverride ?? u.searchParams.get('feed');
      return json({ quotes: { [OCC]: { t: new Date(Date.now() - 5_000).toISOString(), bp: 0.0411, ap: 0.0733, bs: 5, as: 5 } }, feed });
    }
    return json({ message: 'not found (TEST FIXTURE stub)' }, 404);
  };
}

before(async () => {
  resetVerification();
  tNone = tempDb('feeds-none');
  seedFixture(tNone.db);
  none = await startTestServer(tNone.db);
  tAlp = tempDb('feeds-alpaca');
  seedFixture(tAlp.db);
  alp = await startTestServer(tAlp.db, { ...FAKE, ALPACA_DATA_BASE_URL: STUB, ALPACA_TRADING_BASE_URL: STUB }, { fetchImpl: stubFetch() });
  tOpra = tempDb('feeds-opra');
  seedFixture(tOpra.db);
  alpOpra = await startTestServer(tOpra.db, { ...FAKE, ALPACA_DATA_BASE_URL: STUB, ALPACA_TRADING_BASE_URL: STUB, ALPACA_OPTIONS_FEED: 'opra' }, { fetchImpl: stubFetch() });
});
after(async () => {
  resetVerification();
  setFeedVerifyControl(null);
  for (const s of [none, alp, alpOpra]) await s?.close();
  for (const d of [tNone, tAlp, tOpra]) d?.cleanup();
});

const cool = (srv) => { srv.ctx.feedVerifyLast = { live: 0, options: 0 }; }; // test-only: skip the 30 s cooldown
const feedRows = (db) => db.prepare("SELECT payload_json FROM journal WHERE type = 'FEED_VERIFY' ORDER BY seq").all().map((r) => JSON.parse(r.payload_json));
const noSecrets = (text) => { for (const v of Object.values(FAKE)) assert.ok(!text.includes(v), 'secret value leaked'); };
const noPrices = (text) => { for (const v of [String(BID), String(ASK), '4987', '5013', '0.0411', '0.0733', OCC]) assert.ok(!text.includes(v), `price/contract value ${v} leaked`); };

test('without a configured provider both routes answer 409 NO_VERIFIED_DATA, make no request, and journal the refusal', async () => {
  const n0 = requests.length;
  const live = await none.client.post('/api/feeds/verify', { sym: SYM });
  assert.equal(live.status, 409, live.text);
  assert.equal(live.json.error.code, 'NO_VERIFIED_DATA');
  const opt = await none.client.post('/api/options/verify', { underlying: SYM });
  assert.equal(opt.status, 409, opt.text);
  assert.equal(opt.json.error.code, 'NO_VERIFIED_DATA');
  assert.equal(requests.length, n0);
  const rows = feedRows(tNone.db);
  assert.deepEqual(rows.map((r) => [r.kind, r.decision, r.code, r.requestMade]), [['live', 'REFUSED', 'NO_VERIFIED_DATA', false], ['options', 'REFUSED', 'NO_VERIFIED_DATA', false]]);
  const s = (await none.client.get('/api/status')).json;
  assert.equal(s.data.live.status, 'NO_VERIFIED_DATA');
});

test('human-only and strict: CSRF guard, unknown keys, symbol and provider validation, unconfigured provider', async () => {
  const api = alp.client;
  const csrf = await api.post('/api/feeds/verify', { sym: SYM }, { 'x-vector-client': '' });
  assert.equal(csrf.status, 403);
  assert.equal(csrf.json.error.code, 'CSRF_GUARD');
  const csrfOpt = await api.post('/api/options/verify', { underlying: SYM }, { origin: 'http://evil.example' });
  assert.equal(csrfOpt.status, 403);
  const cases = [
    ['/api/feeds/verify', { sym: SYM, extra: 1 }, 400, 'UNKNOWN_FIELD'],
    ['/api/feeds/verify', {}, 400, 'SYMBOL_INVALID'],
    ['/api/feeds/verify', { sym: 'bad sym!' }, 400, 'SYMBOL_INVALID'],
    ['/api/feeds/verify', { sym: SYM, provider: 'nope' }, 400, 'ENUM_INVALID'],
    ['/api/options/verify', { underlying: SYM, sym: SYM }, 400, 'UNKNOWN_FIELD'],
    ['/api/options/verify', { underlying: 'x y' }, 400, 'SYMBOL_INVALID'],
    ['/api/feeds/verify', { sym: SYM, provider: 'polygon' }, 409, 'NO_VERIFIED_DATA'],
  ];
  const n0 = requests.length;
  for (const [p, body, status, code] of cases) {
    const r = await api.post(p, body);
    assert.equal(r.status, status, `${p} ${JSON.stringify(body)}: ${r.text}`);
    assert.equal(r.json.error.code, code);
  }
  assert.equal(requests.length, n0, 'no provider request for refused input');
  assert.equal((await api.raw('GET', '/api/feeds/verify')).status, 405);
});

test('live verification: one request, LIVE_VERIFIED in memory, prices withheld, journaled without secrets; 30 s cooldown', async () => {
  cool(alp);
  const api = alp.client;
  const n0 = requests.length;
  const r = await api.post('/api/feeds/verify', { sym: SYM });
  assert.equal(r.status, 200, r.text);
  assert.equal(requests.length - n0, 1);
  assert.equal(requests.at(-1).headers['APCA-API-KEY-ID'], FAKE.ALPACA_API_KEY_ID, 'the stub saw the server-side key');
  assert.equal(r.json.decision, 'VERIFIED');
  assert.equal(r.json.status, 'LIVE_VERIFIED');
  assert.equal(r.json.provider, 'alpaca');
  assert.equal(r.json.quote.twoSided, true);
  assert.ok(r.json.quote.ageMs >= 0 && r.json.quote.ageMs < 120_000);
  assert.equal(r.json.pricesWithheld, true);
  assert.match(r.json.scope, /^WALL_CLOCK_STATUS_ONLY/);
  noPrices(r.text);
  noSecrets(r.text);
  const s = (await api.get('/api/status')).json;
  assert.equal(s.data.live.status, 'LIVE_VERIFIED');
  assert.equal(s.data.mode, 'HISTORICAL_REAL', 'the replay still runs on the stored dataset');
  const row = feedRows(tAlp.db).at(-1);
  assert.equal(row.kind, 'live');
  assert.equal(row.status, 'LIVE_VERIFIED');
  assert.equal(row.pricesStored, false);
  const journalText = JSON.stringify(feedRows(tAlp.db));
  noSecrets(journalText);
  noPrices(journalText);

  const again = await api.post('/api/feeds/verify', { sym: SYM });
  assert.equal(again.status, 429);
  assert.equal(again.json.error.code, 'FEED_VERIFY_RATE_LIMITED');
  assert.ok(again.json.retryAfterMs > 0 && again.json.retryAfterMs <= 30_000);
  assert.equal(requests.length - n0, 1, 'no request during the cooldown');
});

test('a provider error is reported and journaled with its secrets scrubbed', async () => {
  cool(alp);
  const r = await alp.client.post('/api/feeds/verify', { sym: 'TFXB' });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.decision, 'NOT_VERIFIED');
  assert.equal(r.json.status, 'PROVIDER_FAULT');
  assert.match(r.json.detail, /HTTP 401/);
  assert.match(r.json.detail, /\[REDACTED\]/);
  noSecrets(r.text);
  const row = feedRows(tAlp.db).at(-1);
  assert.equal(row.status, 'PROVIDER_FAULT');
  assert.match(row.detail, /\[REDACTED\]/);
  noSecrets(JSON.stringify(row));
});

test('single-flight across both routes: a second verification while one runs is refused', async () => {
  cool(alp);
  let release;
  hold = new Promise((r) => { release = r; });
  try {
    const first = alp.client.post('/api/feeds/verify', { sym: SYM });
    for (let i = 0; i < 200 && !alp.ctx.busy.feedVerify; i++) await new Promise((r) => setTimeout(r, 5));
    assert.equal(alp.ctx.busy.feedVerify, true);
    const second = await alp.client.post('/api/options/verify', { underlying: SYM });
    assert.equal(second.status, 429, second.text);
    assert.equal(second.json.error.code, 'FEED_VERIFY_BUSY');
    release();
    assert.equal((await first).status, 200);
  } finally {
    hold = null;
    release?.();
  }
  assert.equal(alp.ctx.busy.feedVerify, false);
});

test('options verification is status only: indicative quotes do not verify, OPRA does, and replay options orders stay refused', async () => {
  cool(alp);
  const ind = await alp.client.post('/api/options/verify', { underlying: SYM });
  assert.equal(ind.status, 200, ind.text);
  assert.equal(ind.json.decision, 'NOT_VERIFIED');
  assert.equal(ind.json.status, 'NO_VERIFIED_OPTIONS_DATA');
  assert.equal(ind.json.indicative, true);
  assert.equal(ind.json.contractFound, true);
  noPrices(ind.text);

  const opra = await alpOpra.client.post('/api/options/verify', { underlying: SYM });
  assert.equal(opra.status, 200, opra.text);
  assert.equal(opra.json.decision, 'VERIFIED');
  assert.equal(opra.json.status, 'SUPPORTED_VERIFIED');
  assert.equal(opra.json.scope, OPTIONS_VERIFY_SCOPE);
  assert.equal(opra.json.twoSidedQuote, true);
  assert.match(opra.json.replayOptionsOrders, /NO_VERIFIED_OPTIONS_DATA/);
  noPrices(opra.text);
  noSecrets(opra.text);
  const os = (await alpOpra.client.get('/api/options/status')).json;
  assert.equal(os.status, 'SUPPORTED_VERIFIED', 'wall-clock status is shown');
  assert.match(os.operationalOrders, /^REJECTED/);
  // Never wired into the replay: an operational long-put order is still refused (no as-of option quote).
  const order = await alpOpra.client.post('/api/options/orders', {
    contract: { occ: OCC, underlying: SYM, expiry: '2099-12-18', strike_u: 5000, right: 'P', multiplier: 100 }, contracts: 1, limit_px_u: 500, confirm: true,
  });
  assert.equal(order.status, 409, order.text);
  assert.equal(order.json.error.code, 'NO_VERIFIED_OPTIONS_DATA');
  assert.equal(tOpra.db.prepare("SELECT COUNT(*) n FROM orders WHERE kind = 'option'").get().n, 0);
  const rows = feedRows(tOpra.db);
  assert.equal(rows.at(-1).kind, 'options');
  noPrices(JSON.stringify(rows));
});

test('the live status text points at the verification control once the routes exist', async () => {
  // A configured but unverified provider (fresh in-memory state) names the control instead of MISSING.
  resetVerification();
  const s = (await alp.client.get('/api/status')).json;
  assert.equal(s.data.live.status, 'NO_VERIFIED_DATA');
  assert.match(s.data.live.detail, /Run feed verification: Sources › Verify market feed \(POST \/api\/feeds\/verify\)/);
});
