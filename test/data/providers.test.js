// TEST FIXTURE — NOT MARKET DATA. Alpaca / Polygon adapters against a LOCAL stub server with invented quotes,
// contracts and fake credentials. Nothing here contacts a real provider.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createAlpacaAdapter } from '../../server/data/providers/alpaca.js';
import { createPolygonAdapter } from '../../server/data/providers/polygon.js';
import { feedStatus, verifyLiveFeed, verifyOptionsFeed, resetVerification, setFeedVerifyControl, OPTIONS_VERIFY_SCOPE } from '../../server/data/providers/index.js';
import { stubServer } from './helpers.js';

const T0 = Date.UTC(2026, 9, 7, 14, 30);
const OCC = 'TFIXA261120P00000500';
const FAKE = { ALPACA_API_KEY_ID: 'fixture-key-id', ALPACA_API_SECRET_KEY: 'fixture-secret-value' };

async function alpacaStub() {
  return stubServer({
    '/v2/stocks/TFIXA/quotes/latest': { contentType: 'application/json', body: { symbol: 'TFIXA', quote: { t: new Date(T0).toISOString(), ap: 0.52, as: 300, bp: 0.51, bs: 200, ax: 'V', bx: 'V', c: ['R'], z: 'C' } } },
    '/v2/stocks/TFIXA/bars': { contentType: 'application/json', body: { symbol: 'TFIXA', bars: [{ t: new Date(T0).toISOString(), o: 0.5, h: 0.53, l: 0.49, c: 0.52, v: 1200, n: 7, vw: 0.515 }], next_page_token: null } },
    '/v2/options/contracts': { contentType: 'application/json', body: { option_contracts: [{ symbol: OCC, underlying_symbol: 'TFIXA', expiration_date: '2026-11-20', strike_price: '0.5', type: 'put', size: '100', style: 'american', tradable: true, status: 'active' }] } },
    '/v1beta1/options/quotes/latest': { contentType: 'application/json', body: { quotes: { [OCC]: { t: new Date(T0).toISOString(), ap: 0.1, as: 10, bp: 0.05, bs: 5 } } } },
    '/v2/stocks/TFIXB/quotes/latest': { status: 401, contentType: 'application/json', body: { message: 'forbidden' } },
  });
}

test('no credentials: NOT_CONFIGURED / NO_VERIFIED_DATA and feed status says so', async () => {
  resetVerification();
  const a = createAlpacaAdapter({ env: {} });
  const p = createPolygonAdapter({ env: {} });
  assert.equal(a.configured, false);
  const r = await a.latestQuote('TFIXA');
  assert.equal(r.status, 'NOT_CONFIGURED');
  assert.equal(r.dataStatus, 'NO_VERIFIED_DATA');
  assert.equal((await p.optionContracts('TFIXA')).status, 'NOT_CONFIGURED');
  const fs = feedStatus({});
  assert.equal(fs.live.status, 'NO_VERIFIED_DATA');
  assert.equal(fs.options.status, 'NO_VERIFIED_OPTIONS_DATA');
  assert.deepEqual(fs.providers.map((x) => x.status), ['NOT_CONFIGURED', 'NOT_CONFIGURED']);
  assert.ok(fs.providers.every((x) => /UNVERIFIED — never invoked against genuine data in this build/.test(x.verification)));
});

test('alpaca adapter (stub): headers, normalisation to u, options, and fault handling', async () => {
  const srv = await alpacaStub();
  try {
    const env = { ...FAKE, ALPACA_DATA_BASE_URL: srv.url, ALPACA_TRADING_BASE_URL: srv.url };
    const a = createAlpacaAdapter({ env });
    const q = await a.latestQuote('TFIXA');
    assert.equal(q.status, 'OK');
    assert.deepEqual([q.quote.bid, q.quote.ask, q.quote.quoteTs], [5100, 5200, T0]);
    assert.equal(srv.requests[0].headers['apca-api-key-id'], 'fixture-key-id');
    assert.equal(srv.requests[0].query.feed, 'iex');
    const b = await a.bars('TFIXA', { start: new Date(T0).toISOString() });
    assert.deepEqual(b.bars[0], { t: T0, o: 5000, h: 5300, l: 4900, c: 5200, v: 1200, n: 7, vwap: 5150 });
    const c = await a.optionContracts('TFIXA', { expirationGte: '2026-10-08' });
    assert.equal(c.contracts[0].occ, OCC);
    assert.equal(c.contracts[0].right, 'P');
    assert.equal(c.contracts[0].strikeU, 5000);
    assert.equal(c.contracts[0].multiplier, 100);
    const oq = await a.optionQuotes([OCC]);
    assert.deepEqual([oq.quotes[0].bid, oq.quotes[0].ask], [500, 1000]);
    const f = await a.latestQuote('TFIXB');
    assert.equal(f.status, 'PROVIDER_FAULT');
    assert.equal(f.httpStatus, 401);
    assert.ok(!JSON.stringify(f).includes('fixture-secret-value'), 'secret never echoed');
    await assert.rejects(() => a.latestQuote('bad sym'), TypeError);
  } finally { await srv.close(); }
});

test('polygon adapter (stub): bearer auth, ns timestamps, contracts and option quote', async () => {
  const ns = T0 * 1e6;
  const srv = await stubServer({
    '/v2/last/nbbo/TFIXA': { contentType: 'application/json', body: { status: 'OK', results: { T: 'TFIXA', p: 0.51, s: 2, P: 0.52, S: 3, t: ns } } },
    '/v3/reference/options/contracts': { contentType: 'application/json', body: { results: [{ ticker: `O:${OCC}`, underlying_ticker: 'TFIXA', contract_type: 'put', expiration_date: '2026-11-20', strike_price: 0.5, shares_per_contract: 100, exercise_style: 'american' }] } },
    [`/v3/quotes/O%3A${OCC}`]: { contentType: 'application/json', body: { results: [{ bid_price: 0.05, ask_price: 0.1, bid_size: 5, ask_size: 10, sip_timestamp: ns }] } },
    '/v2/aggs/ticker/TFIXA/range/1/minute/2026-10-07/2026-10-07': { contentType: 'application/json', body: { results: [{ t: T0, o: 0.5, h: 0.53, l: 0.49, c: 0.52, v: 1200, n: 7, vw: 0.515 }] } },
  });
  try {
    const p = createPolygonAdapter({ env: { POLYGON_API_KEY: 'fixture-polygon-key', POLYGON_BASE_URL: srv.url } });
    const q = await p.latestQuote('TFIXA');
    assert.deepEqual([q.quote.bid, q.quote.ask, q.quote.quoteTs], [5100, 5200, T0]);
    assert.equal(srv.requests[0].headers.authorization, 'Bearer fixture-polygon-key');
    assert.ok(!srv.requests[0].query.apiKey, 'key never placed in the URL');
    const c = await p.optionContracts('TFIXA', { asOfDate: '2026-10-07' });
    assert.equal(c.contracts[0].occ, OCC);
    const oq = await p.optionQuote(OCC);
    assert.deepEqual([oq.quote.bid, oq.quote.ask, oq.quote.quoteTs], [500, 1000, T0]);
    const b = await p.bars('TFIXA', { from: '2026-10-07', to: '2026-10-07' });
    assert.equal(b.bars[0].c, 5200);
    assert.equal(srv.requests.at(-1).query.adjusted, 'false');
  } finally { await srv.close(); }
});

test('verification: fresh quote => LIVE_VERIFIED; stale => NO_VERIFIED_DATA; options need OPRA quotes (in-process, status only)', async () => {
  resetVerification();
  setFeedVerifyControl(null);
  const srv = await alpacaStub();
  try {
    const env = { ...FAKE, ALPACA_DATA_BASE_URL: srv.url, ALPACA_TRADING_BASE_URL: srv.url };
    assert.equal(feedStatus(env).live.status, 'NO_VERIFIED_DATA', 'configured is not verified');
    // No control is registered: the text says verification is MISSING instead of naming a control that does not exist.
    assert.match(feedStatus(env).live.detail, /MISSING: no API route or script runs feed verification/);
    assert.doesNotMatch(feedStatus(env).live.detail, /\(run feed verification\)/);
    setFeedVerifyControl('Sources › Verify market feed (POST /api/feeds/verify)');
    assert.match(feedStatus(env).live.detail, /Run feed verification: Sources › Verify market feed/);
    setFeedVerifyControl(null);
    const stale = await verifyLiveFeed({ env, sym: 'TFIXA', now: () => T0 + 3_600_000 });
    assert.equal(stale.status, 'NO_VERIFIED_DATA');
    const fresh = await verifyLiveFeed({ env, sym: 'TFIXA', now: () => T0 + 30_000 });
    assert.equal(fresh.status, 'LIVE_VERIFIED');
    assert.match(fresh.detail, /IEX-only/);
    assert.equal(feedStatus(env).live.status, 'LIVE_VERIFIED');
    assert.equal(feedStatus({}).live.status, 'NO_VERIFIED_DATA', 'verification does not survive losing the credentials');
    const delayed = await verifyLiveFeed({ env: { ...env, ALPACA_DATA_FEED: 'delayed_sip' }, sym: 'TFIXA', now: () => T0 + 900_000 });
    assert.equal(delayed.status, 'DELAYED_REAL');
    // Default Alpaca option feed is 'indicative' (not OPRA): never SUPPORTED_VERIFIED.
    const ind = await verifyOptionsFeed({ env, underlying: 'TFIXA' });
    assert.equal(ind.status, 'NO_VERIFIED_OPTIONS_DATA');
    assert.equal(ind.indicative, true);
    assert.equal(ind.quoteFeed, 'indicative');
    assert.equal(srv.requests.at(-1).query.feed, 'indicative');
    assert.equal(feedStatus(env).options.status, 'NO_VERIFIED_OPTIONS_DATA');
    // An OPRA feed verifies, as wall-clock status only.
    const o = await verifyOptionsFeed({ env: { ...env, ALPACA_OPTIONS_FEED: 'opra' }, underlying: 'TFIXA' });
    assert.equal(o.status, 'SUPPORTED_VERIFIED');
    assert.equal(o.quoteFeed, 'opra');
    assert.equal(o.scope, OPTIONS_VERIFY_SCOPE);
    assert.match(OPTIONS_VERIFY_SCOPE, /does not enable replay options fills/);
    const st = feedStatus(env).options;
    assert.equal(st.status, 'SUPPORTED_VERIFIED');
    assert.equal(st.scope, OPTIONS_VERIFY_SCOPE);
    // A later indicative-only verification withdraws it.
    await verifyOptionsFeed({ env, underlying: 'TFIXA' });
    assert.equal(feedStatus(env).options.status, 'NO_VERIFIED_OPTIONS_DATA');
  } finally { resetVerification(); setFeedVerifyControl(null); await srv.close(); }
});
