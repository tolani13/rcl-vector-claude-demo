// Live / delayed market-feed status summary and the request-capable adapters.
//
// Status is never assumed: with no provider configured, live = NO_VERIFIED_DATA and options =
// NO_VERIFIED_OPTIONS_DATA. A configured provider is still NO_VERIFIED_DATA until verifyLiveFeed() /
// verifyOptionsFeed() have received real data from it in THIS server process (results are kept in memory only;
// a restart returns to unverified). Neither adapter was invoked against genuine data in this build.
//
// Reachability: verification needs a caller. Until an API route registers itself with setFeedVerifyControl(), the
// status text says that no control runs it (MISSING) instead of pointing at a control that does not exist.
// Options: SUPPORTED_VERIFIED needs real OPRA quotes. Alpaca's default 'indicative' option feed is not OPRA data, so it
// never verifies. Verification is wall-clock STATUS ONLY: it proves entitlement and contract access now and never
// makes replay options orders fillable (no historical as-of option quote source exists in this build).
import { createAlpacaAdapter, alpacaMeta, ALPACA_VERIFICATION } from './alpaca.js';
import { createPolygonAdapter, polygonMeta, POLYGON_VERIFICATION } from './polygon.js';

// Quote freshness required to call a feed LIVE_VERIFIED (wall-clock age at verification time).
export const LIVE_MAX_AGE_MS = 120_000;

const verified = { live: null, options: null };
let verifyControl = null;

/**
 * Called by the API layer when it exposes feed verification (e.g. 'Sources › Verify market feed (POST /api/feeds/verify)').
 * null (the default) means no control exists and status text says so.
 */
export function setFeedVerifyControl(label) {
  verifyControl = typeof label === 'string' && label.trim() ? label.trim().slice(0, 200) : null;
}

/** Option quote feeds accepted as verified OPRA data, per provider. */
const OPRA_FEEDS = Object.freeze({ alpaca: new Set(['opra']), polygon: null }); // polygon: options quotes are OPRA (plan-entitled)
export const OPTIONS_VERIFY_SCOPE = 'WALL_CLOCK_STATUS_ONLY: proves current entitlement and contract access; does not enable replay options fills (no as-of historical option quotes)';

export function getMarketProviders({ env = process.env, fetchImpl } = {}) {
  return [createAlpacaAdapter({ env, fetchImpl }), createPolygonAdapter({ env, fetchImpl })];
}

/** Summary used by GET /api/status (data.live, options) and GET /api/sources. Synchronous; makes no requests. */
export function feedStatus(env = process.env) {
  const [alp, pol] = getMarketProviders({ env });
  const am = alpacaMeta(env);
  const pm = polygonMeta();
  const providers = [
    { ...am, configured: alp.configured, verification: ALPACA_VERIFICATION },
    { ...pm, configured: pol.configured, verification: POLYGON_VERIFICATION },
  ].map((p) => {
    const v = verified.live && verified.live.provider === p.id ? verified.live : null;
    return {
      id: p.id, name: p.name, configured: p.configured, coverage: p.coverage, entitlement: p.entitlement, attribution: p.attribution,
      setup: p.setup, verification: v ? `verified in this process at ${new Date(v.verifiedAt).toISOString()}` : p.verification,
      status: p.configured ? 'CONFIGURED_UNVERIFIED' : 'NOT_CONFIGURED',
      dataStatus: v ? v.status : 'NO_VERIFIED_DATA',
      lastQuoteTs: v ? v.lastQuoteTs : null,
    };
  });
  const anyConfigured = providers.some((p) => p.configured);
  const live = verified.live && providers.find((p) => p.id === verified.live.provider)?.configured
    ? { status: verified.live.status, provider: verified.live.provider, detail: verified.live.detail, lastQuoteTs: verified.live.lastQuoteTs }
    : {
      status: 'NO_VERIFIED_DATA', provider: null, lastQuoteTs: null,
      detail: anyConfigured
        ? `A market-data provider is configured but has not returned verified data in this process. ${verifyControl
          ? `Run feed verification: ${verifyControl}.`
          : 'MISSING: no API route or script runs feed verification in this build, so the feed stays NO_VERIFIED_DATA.'} Replay uses stored IEX HIST data.`
        : 'No live or delayed market-data feed is configured (set ALPACA_API_KEY_ID/ALPACA_API_SECRET_KEY or POLYGON_API_KEY). Replay uses stored IEX HIST data.',
      verifyControl,
    };
  const options = verified.options && providers.find((p) => p.id === verified.options.provider)?.configured
    ? {
      status: 'SUPPORTED_VERIFIED', provider: verified.options.provider, detail: verified.options.detail, contract: verified.options.contract, quote: verified.options.quote,
      quoteFeed: verified.options.quoteFeed, scope: OPTIONS_VERIFY_SCOPE,
    }
    : {
      status: 'NO_VERIFIED_OPTIONS_DATA', provider: null,
      detail: 'No options provider has returned real contracts and quotes in this process. Operational options orders are rejected.',
    };
  return { live, options, providers };
}

function pickProvider(providers, preferred) {
  const configured = providers.filter((p) => p.configured);
  return configured.find((p) => p.id === preferred) || configured[0] || null;
}

/**
 * Make one real latest-quote request to the first configured provider and classify the feed.
 * LIVE_VERIFIED only if a two-sided quote's timestamp is within LIVE_MAX_AGE_MS of now and the feed is not a
 * delayed entitlement; a delayed entitlement yields DELAYED_REAL; anything else stays NO_VERIFIED_DATA.
 */
export async function verifyLiveFeed({ env = process.env, fetchImpl, sym, preferred = null, now = Date.now } = {}) {
  const p = pickProvider(getMarketProviders({ env, fetchImpl }), preferred);
  if (!p) return { status: 'NO_VERIFIED_DATA', detail: 'no provider configured' };
  if (!sym) throw new TypeError('sym is required for feed verification');
  const r = await p.latestQuote(sym);
  if (!r.ok) return { status: r.dataStatus || 'PROVIDER_FAULT', provider: p.id, detail: r.detail };
  const q = r.quote;
  const age = q.quoteTs != null ? now() - q.quoteTs : null;
  const delayed = p.id === 'alpaca' && p.feed === 'delayed_sip';
  let status = 'NO_VERIFIED_DATA';
  let detail;
  if (!q.bid || !q.ask || q.quoteTs == null) detail = 'provider returned no two-sided timestamped quote';
  else if (delayed) { status = 'DELAYED_REAL'; detail = `delayed entitlement; quote age ${Math.round(age / 1000)} s`; }
  else if (age <= LIVE_MAX_AGE_MS && age >= -5_000) { status = 'LIVE_VERIFIED'; detail = `quote age ${Math.round(age / 1000)} s at verification` + (p.id === 'alpaca' && p.feed === 'iex' ? ' (IEX-only feed, not NBBO)' : ''); }
  else detail = `latest quote is ${Math.round((age ?? 0) / 1000)} s old (market closed or stale) — not verified as live`;
  verified.live = status === 'NO_VERIFIED_DATA' ? null : { provider: p.id, status, detail, lastQuoteTs: q.quoteTs, verifiedAt: now() };
  return { status, provider: p.id, detail, quote: q };
}

/**
 * SUPPORTED_VERIFIED only when a configured provider returns at least one put contract AND a two-sided OPRA quote for
 * it. Alpaca 'indicative' (non-OPRA) quotes yield NO_VERIFIED_OPTIONS_DATA with indicative:true. Status only (see
 * OPTIONS_VERIFY_SCOPE).
 */
export async function verifyOptionsFeed({ env = process.env, fetchImpl, underlying, preferred = null, now = Date.now, expirationGte } = {}) {
  const p = pickProvider(getMarketProviders({ env, fetchImpl }), preferred);
  if (!p) return { status: 'NO_VERIFIED_OPTIONS_DATA', detail: 'no provider configured' };
  const c = await p.optionContracts(underlying, { type: 'put', expirationGte });
  if (!c.ok || !c.contracts.length) return { status: 'NO_VERIFIED_OPTIONS_DATA', provider: p.id, detail: c.detail || 'no put contracts returned' };
  const contract = c.contracts[0];
  let quote = null;
  let quoteFeed = null;
  if (p.id === 'alpaca') {
    const q = await p.optionQuotes([contract.occ]);
    quote = q.ok ? q.quotes.find((x) => x.occ === contract.occ) || null : null;
    quoteFeed = q.ok ? String(q.feed || '').toLowerCase() : null;
  } else {
    const q = await p.optionQuote(contract.occ);
    quote = q.ok ? q.quote : null;
    quoteFeed = q.ok ? 'opra' : null;
  }
  if (!quote || !quote.bid || !quote.ask) {
    verified.options = null;
    return { status: 'NO_VERIFIED_OPTIONS_DATA', provider: p.id, detail: 'contract returned but no two-sided option quote', contract, scope: OPTIONS_VERIFY_SCOPE };
  }
  const opra = OPRA_FEEDS[p.id] ? OPRA_FEEDS[p.id].has(quoteFeed) : quoteFeed === 'opra';
  if (!opra) {
    verified.options = null;
    return {
      status: 'NO_VERIFIED_OPTIONS_DATA', provider: p.id, contract, quote, quoteFeed, indicative: true, scope: OPTIONS_VERIFY_SCOPE,
      detail: `option quote feed "${quoteFeed}" is not OPRA-entitled real quote data (indicative / unverified); set ALPACA_OPTIONS_FEED=opra on an OPRA-entitled account`,
    };
  }
  verified.options = { provider: p.id, contract, quote, quoteFeed, detail: `contracts + OPRA quote returned by ${p.id} (status only; replay options fills stay disabled)`, verifiedAt: now() };
  return { status: 'SUPPORTED_VERIFIED', provider: p.id, contract, quote, quoteFeed, scope: OPTIONS_VERIFY_SCOPE };
}

/** Test/maintenance helper: forget in-memory verification results. */
export function resetVerification() {
  verified.live = null;
  verified.options = null;
}
