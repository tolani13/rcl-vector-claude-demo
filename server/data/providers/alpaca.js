// Alpaca Market Data adapter (request-capable; read-only market data endpoints).
//
// UNVERIFIED — never invoked against genuine data in this build: no Alpaca credentials were available, so this
// adapter has only been exercised against a local stub server in test/. It never calls any order endpoint;
// VECTOR has no live-broker path.
//
// Keys come ONLY from the server environment: ALPACA_API_KEY_ID / ALPACA_API_SECRET_KEY.
// Optional: ALPACA_DATA_FEED ('iex' default = IEX-only real-time; 'sip' requires a paid entitlement;
// 'delayed_sip' = 15-minute delayed consolidated), ALPACA_DATA_BASE_URL, ALPACA_TRADING_BASE_URL (options
// contract reference data lives on the trading API host; paper host by default).
import { usdToU } from '../../util/money.js';

export const ALPACA_VERIFICATION = 'UNVERIFIED — never invoked against genuine data in this build';

const DEFAULT_DATA = 'https://data.alpaca.markets';
const DEFAULT_TRADING = 'https://paper-api.alpaca.markets';
const SYM_RE = /^[A-Z][A-Z0-9.\-]{0,9}$/;
const OCC_RE = /^[A-Z]{1,6}\d{6}[CP]\d{8}$/;

const toU = (x) => (typeof x === 'number' && Number.isFinite(x) && x > 0 ? usdToU(x) : null);
const tsMs = (s) => { const t = Date.parse(s); return Number.isFinite(t) ? t : null; };

export function alpacaMeta(env = process.env) {
  const feed = (env.ALPACA_DATA_FEED || 'iex').toLowerCase();
  return {
    id: 'alpaca', name: 'Alpaca Market Data API',
    coverage: feed === 'iex'
      ? 'Feed "iex": IEX-only real-time quotes/trades (not consolidated, not NBBO). Options: indicative feed unless entitled to OPRA.'
      : feed === 'delayed_sip' ? 'Feed "delayed_sip": consolidated SIP delayed 15 minutes.' : `Feed "${feed}": as entitled on the Alpaca account.`,
    entitlement: 'Requires an Alpaca account and API keys; data subscription determines feed (IEX free / SIP paid). Alpaca terms apply.',
    attribution: 'Market data via Alpaca (https://alpaca.markets/).',
    setup: 'Set ALPACA_API_KEY_ID and ALPACA_API_SECRET_KEY in the server environment (optional ALPACA_DATA_FEED=iex|sip|delayed_sip). Keys are never sent to the browser.',
    feed,
  };
}

/**
 * @param {{env?:object, fetchImpl?:Function, timeoutMs?:number}} [o]  env defaults to process.env (tests pass an object)
 */
export function createAlpacaAdapter({ env = process.env, fetchImpl = globalThis.fetch, timeoutMs = 10_000 } = {}) {
  const keyId = env.ALPACA_API_KEY_ID || '';
  const secret = env.ALPACA_API_SECRET_KEY || '';
  const meta = alpacaMeta(env);
  const dataBase = (env.ALPACA_DATA_BASE_URL || DEFAULT_DATA).replace(/\/+$/, '');
  const tradingBase = (env.ALPACA_TRADING_BASE_URL || DEFAULT_TRADING).replace(/\/+$/, '');
  const configured = Boolean(keyId && secret);

  const notConfigured = () => ({
    ok: false, status: 'NOT_CONFIGURED', dataStatus: 'NO_VERIFIED_DATA', provider: 'alpaca',
    detail: 'Alpaca credentials are not configured (ALPACA_API_KEY_ID / ALPACA_API_SECRET_KEY).',
  });

  async function get(base, pathAndQuery) {
    const url = `${base}${pathAndQuery}`;
    let res;
    try {
      res = await fetchImpl(url, {
        headers: { 'APCA-API-KEY-ID': keyId, 'APCA-API-SECRET-KEY': secret, Accept: 'application/json' },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      return { ok: false, status: 'PROVIDER_FAULT', dataStatus: 'PROVIDER_FAULT', provider: 'alpaca', detail: `network error: ${e?.message || e}` };
    }
    const text = await res.text();
    if (!res.ok) {
      // Never echo credentials; the response body from Alpaca does not contain them.
      return { ok: false, status: 'PROVIDER_FAULT', dataStatus: 'PROVIDER_FAULT', provider: 'alpaca', httpStatus: res.status, detail: `HTTP ${res.status}: ${text.slice(0, 200)}` };
    }
    try {
      return { ok: true, json: JSON.parse(text), receivedAt: Date.now() };
    } catch {
      return { ok: false, status: 'PROVIDER_FAULT', dataStatus: 'PROVIDER_FAULT', provider: 'alpaca', detail: 'response was not JSON' };
    }
  }

  const symOk = (sym) => typeof sym === 'string' && SYM_RE.test(sym);

  return {
    id: 'alpaca', name: meta.name, configured, feed: meta.feed, verification: ALPACA_VERIFICATION,

    /** Latest quote for a stock. Prices returned in u. */
    async latestQuote(sym) {
      if (!configured) return notConfigured();
      if (!symOk(sym)) throw new TypeError('invalid symbol');
      const r = await get(dataBase, `/v2/stocks/${encodeURIComponent(sym)}/quotes/latest?feed=${encodeURIComponent(meta.feed)}`);
      if (!r.ok) return r;
      const q = r.json && r.json.quote;
      if (!q) return { ok: false, status: 'NO_VERIFIED_DATA', dataStatus: 'NO_VERIFIED_DATA', provider: 'alpaca', detail: 'no quote in response' };
      return {
        ok: true, status: 'OK', provider: 'alpaca', feed: meta.feed, verification: ALPACA_VERIFICATION, receivedAt: r.receivedAt,
        quote: {
          sym, bid: toU(q.bp), ask: toU(q.ap), bidSize: q.bs ?? null, askSize: q.as ?? null, quoteTs: tsMs(q.t),
          bidExchange: q.bx ?? null, askExchange: q.ax ?? null, conditions: q.c ?? [], tape: q.z ?? null,
        },
      };
    },

    /** Historical/recent bars. timeframe e.g. '1Min' | '1Day'. start/end ISO strings. */
    async bars(sym, { timeframe = '1Min', start, end, limit = 1000, adjustment = 'raw' } = {}) {
      if (!configured) return notConfigured();
      if (!symOk(sym)) throw new TypeError('invalid symbol');
      const qs = new URLSearchParams({ timeframe, limit: String(Math.min(10000, Math.max(1, limit | 0))), adjustment, feed: meta.feed });
      if (start) qs.set('start', start);
      if (end) qs.set('end', end);
      const r = await get(dataBase, `/v2/stocks/${encodeURIComponent(sym)}/bars?${qs}`);
      if (!r.ok) return r;
      const bars = (r.json.bars || []).map((b) => ({
        t: tsMs(b.t), o: toU(b.o), h: toU(b.h), l: toU(b.l), c: toU(b.c), v: b.v ?? 0, n: b.n ?? null, vwap: toU(b.vw),
      }));
      return { ok: true, status: 'OK', provider: 'alpaca', feed: meta.feed, verification: ALPACA_VERIFICATION, sym, timeframe, adjustment, bars, nextPageToken: r.json.next_page_token ?? null };
    },

    /** Option contracts (reference data) for an underlying; type 'put' by default (long-put support). */
    async optionContracts(underlying, { type = 'put', expirationGte, expirationLte, limit = 100 } = {}) {
      if (!configured) return notConfigured();
      if (!symOk(underlying)) throw new TypeError('invalid underlying');
      const qs = new URLSearchParams({ underlying_symbols: underlying, type, limit: String(Math.min(1000, Math.max(1, limit | 0))) });
      if (expirationGte) qs.set('expiration_date_gte', expirationGte);
      if (expirationLte) qs.set('expiration_date_lte', expirationLte);
      const r = await get(tradingBase, `/v2/options/contracts?${qs}`);
      if (!r.ok) return r;
      const contracts = (r.json.option_contracts || []).map((c) => ({
        occ: c.symbol, underlying: c.underlying_symbol, expiry: c.expiration_date,
        strikeU: toU(Number(c.strike_price)), right: c.type === 'put' ? 'P' : c.type === 'call' ? 'C' : null,
        multiplier: Number(c.size) || null, style: c.style ?? null, tradable: c.tradable ?? null, status: c.status ?? null,
      })).filter((c) => OCC_RE.test(c.occ || ''));
      return { ok: true, status: 'OK', provider: 'alpaca', verification: ALPACA_VERIFICATION, underlying, contracts, nextPageToken: r.json.next_page_token ?? null };
    },

    /** Latest option quotes for OCC symbols. */
    async optionQuotes(occSymbols, { feed = env.ALPACA_OPTIONS_FEED || 'indicative' } = {}) {
      if (!configured) return notConfigured();
      const list = [].concat(occSymbols || []);
      if (!list.length || list.some((s) => !OCC_RE.test(s))) throw new TypeError('invalid OCC symbol(s)');
      const r = await get(dataBase, `/v1beta1/options/quotes/latest?symbols=${encodeURIComponent(list.join(','))}&feed=${encodeURIComponent(feed)}`);
      if (!r.ok) return r;
      const quotes = Object.entries(r.json.quotes || {}).map(([occ, q]) => ({
        occ, bid: toU(q.bp), ask: toU(q.ap), bidSize: q.bs ?? null, askSize: q.as ?? null, quoteTs: tsMs(q.t),
      }));
      return { ok: true, status: 'OK', provider: 'alpaca', feed, verification: ALPACA_VERIFICATION, quotes };
    },
  };
}
