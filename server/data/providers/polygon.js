// Polygon.io REST adapter (request-capable; read-only market-data endpoints).
//
// UNVERIFIED — never invoked against genuine data in this build: no Polygon key was available, so this adapter
// has only been exercised against a local stub server in test/.
//
// Key comes ONLY from the server environment: POLYGON_API_KEY (sent as an Authorization: Bearer header so it never
// appears in URLs or logs). Optional POLYGON_BASE_URL. Entitlement (real-time vs 15-minute delayed vs end-of-day)
// depends on the Polygon plan; VECTOR does not assume one.
import { usdToU } from '../../util/money.js';

export const POLYGON_VERIFICATION = 'UNVERIFIED — never invoked against genuine data in this build';

const DEFAULT_BASE = 'https://api.polygon.io';
const SYM_RE = /^[A-Z][A-Z0-9.\-]{0,9}$/;
const OCC_RE = /^[A-Z]{1,6}\d{6}[CP]\d{8}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const toU = (x) => (typeof x === 'number' && Number.isFinite(x) && x > 0 ? usdToU(x) : null);
// Polygon timestamps: SIP nanoseconds for quotes; milliseconds for aggregates.
const nsToMs = (ns) => (typeof ns === 'number' && Number.isFinite(ns) ? Math.floor(ns / 1e6) : null);

export function polygonMeta() {
  return {
    id: 'polygon', name: 'Polygon.io REST API',
    coverage: 'Consolidated U.S. stocks (SIP) and OPRA options as entitled by the Polygon plan; real-time vs 15-minute delayed depends on plan.',
    entitlement: 'Requires a Polygon.io API key; plan determines real-time vs delayed data and options access. Polygon terms apply.',
    attribution: 'Market data via Polygon.io (https://polygon.io/).',
    setup: 'Set POLYGON_API_KEY in the server environment (optional POLYGON_BASE_URL). The key is never sent to the browser.',
  };
}

export function createPolygonAdapter({ env = process.env, fetchImpl = globalThis.fetch, timeoutMs = 10_000 } = {}) {
  const key = env.POLYGON_API_KEY || '';
  const base = (env.POLYGON_BASE_URL || DEFAULT_BASE).replace(/\/+$/, '');
  const configured = Boolean(key);
  const meta = polygonMeta();

  const notConfigured = () => ({
    ok: false, status: 'NOT_CONFIGURED', dataStatus: 'NO_VERIFIED_DATA', provider: 'polygon',
    detail: 'Polygon credentials are not configured (POLYGON_API_KEY).',
  });

  async function get(pathAndQuery) {
    let res;
    try {
      res = await fetchImpl(`${base}${pathAndQuery}`, {
        headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      return { ok: false, status: 'PROVIDER_FAULT', dataStatus: 'PROVIDER_FAULT', provider: 'polygon', detail: `network error: ${e?.message || e}` };
    }
    const text = await res.text();
    if (!res.ok) return { ok: false, status: 'PROVIDER_FAULT', dataStatus: 'PROVIDER_FAULT', provider: 'polygon', httpStatus: res.status, detail: `HTTP ${res.status}: ${text.slice(0, 200)}` };
    try {
      const json = JSON.parse(text);
      if (json && (json.status === 'ERROR' || json.status === 'NOT_AUTHORIZED')) {
        return { ok: false, status: 'PROVIDER_FAULT', dataStatus: 'PROVIDER_FAULT', provider: 'polygon', detail: `${json.status}: ${String(json.error || json.message || '').slice(0, 200)}` };
      }
      return { ok: true, json, receivedAt: Date.now() };
    } catch {
      return { ok: false, status: 'PROVIDER_FAULT', dataStatus: 'PROVIDER_FAULT', provider: 'polygon', detail: 'response was not JSON' };
    }
  }

  return {
    id: 'polygon', name: meta.name, configured, verification: POLYGON_VERIFICATION,

    /** Latest consolidated NBBO for a stock (sizes as returned by the provider; see Polygon docs for units). */
    async latestQuote(sym) {
      if (!configured) return notConfigured();
      if (!SYM_RE.test(sym || '')) throw new TypeError('invalid symbol');
      const r = await get(`/v2/last/nbbo/${encodeURIComponent(sym)}`);
      if (!r.ok) return r;
      const q = r.json.results;
      if (!q) return { ok: false, status: 'NO_VERIFIED_DATA', dataStatus: 'NO_VERIFIED_DATA', provider: 'polygon', detail: 'no results in response' };
      return {
        ok: true, status: 'OK', provider: 'polygon', verification: POLYGON_VERIFICATION, receivedAt: r.receivedAt,
        quote: { sym, bid: toU(q.p), ask: toU(q.P), bidSize: q.s ?? null, askSize: q.S ?? null, quoteTs: nsToMs(q.t), bidExchange: q.x ?? null, askExchange: q.X ?? null },
      };
    },

    /** Aggregate bars. timespan 'minute' | 'day'; from/to YYYY-MM-DD; unadjusted by default. */
    async bars(sym, { multiplier = 1, timespan = 'minute', from, to, adjusted = false, limit = 50000 } = {}) {
      if (!configured) return notConfigured();
      if (!SYM_RE.test(sym || '')) throw new TypeError('invalid symbol');
      if (!DATE_RE.test(from || '') || !DATE_RE.test(to || '')) throw new TypeError('from/to must be YYYY-MM-DD');
      const qs = new URLSearchParams({ adjusted: String(Boolean(adjusted)), sort: 'asc', limit: String(Math.min(50000, Math.max(1, limit | 0))) });
      const r = await get(`/v2/aggs/ticker/${encodeURIComponent(sym)}/range/${multiplier | 0}/${encodeURIComponent(timespan)}/${from}/${to}?${qs}`);
      if (!r.ok) return r;
      const bars = (r.json.results || []).map((b) => ({ t: b.t, o: toU(b.o), h: toU(b.h), l: toU(b.l), c: toU(b.c), v: b.v ?? 0, n: b.n ?? null, vwap: toU(b.vw) }));
      return { ok: true, status: 'OK', provider: 'polygon', verification: POLYGON_VERIFICATION, sym, timespan, adjusted: Boolean(adjusted), bars };
    },

    /** Options contract reference data (puts by default). asOf YYYY-MM-DD returns contracts that existed then. */
    async optionContracts(underlying, { type = 'put', expirationGte, expirationLte, asOfDate, limit = 250 } = {}) {
      if (!configured) return notConfigured();
      if (!SYM_RE.test(underlying || '')) throw new TypeError('invalid underlying');
      const qs = new URLSearchParams({ underlying_ticker: underlying, contract_type: type, limit: String(Math.min(1000, Math.max(1, limit | 0))) });
      if (expirationGte) qs.set('expiration_date.gte', expirationGte);
      if (expirationLte) qs.set('expiration_date.lte', expirationLte);
      if (asOfDate) qs.set('as_of', asOfDate);
      const r = await get(`/v3/reference/options/contracts?${qs}`);
      if (!r.ok) return r;
      const contracts = (r.json.results || []).map((c) => ({
        occ: String(c.ticker || '').replace(/^O:/, ''), providerSymbol: c.ticker, underlying: c.underlying_ticker, expiry: c.expiration_date,
        strikeU: toU(Number(c.strike_price)), right: c.contract_type === 'put' ? 'P' : c.contract_type === 'call' ? 'C' : null,
        multiplier: Number(c.shares_per_contract) || null, style: c.exercise_style ?? null,
      })).filter((c) => OCC_RE.test(c.occ));
      return { ok: true, status: 'OK', provider: 'polygon', verification: POLYGON_VERIFICATION, underlying, contracts, nextUrl: r.json.next_url ? 'present' : null };
    },

    /** Latest option quote at or before atMs (ms UTC; defaults to latest). */
    async optionQuote(occ, { atMs = null } = {}) {
      if (!configured) return notConfigured();
      if (!OCC_RE.test(occ || '')) throw new TypeError('invalid OCC symbol');
      const qs = new URLSearchParams({ order: 'desc', sort: 'timestamp', limit: '1' });
      if (atMs != null) qs.set('timestamp.lte', String(Math.floor(atMs) * 1e6));
      const r = await get(`/v3/quotes/${encodeURIComponent('O:' + occ)}?${qs}`);
      if (!r.ok) return r;
      const q = (r.json.results || [])[0];
      if (!q) return { ok: false, status: 'NO_VERIFIED_DATA', dataStatus: 'NO_VERIFIED_OPTIONS_DATA', provider: 'polygon', detail: 'no quote returned' };
      return {
        ok: true, status: 'OK', provider: 'polygon', verification: POLYGON_VERIFICATION,
        quote: { occ, bid: toU(q.bid_price), ask: toU(q.ask_price), bidSize: q.bid_size ?? null, askSize: q.ask_size ?? null, quoteTs: nsToMs(q.sip_timestamp) },
      };
    },
  };
}
