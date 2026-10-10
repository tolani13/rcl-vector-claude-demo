// Human-run verification of the configured live market-data feed and options feed (docs/CONTRACTS.md section 9).
//
//   POST /api/feeds/verify   {sym, provider?}         one latest-quote request -> LIVE_VERIFIED | DELAYED_REAL | NO_VERIFIED_DATA | PROVIDER_FAULT
//   POST /api/options/verify {underlying, provider?}  contracts + one option quote -> SUPPORTED_VERIFIED | NO_VERIFIED_OPTIONS_DATA
//
// Human-only: like every mutation, the request must pass the CSRF guard (X-Vector-Client: web, application/json,
// same-origin), and agents have no route to it. Single-flight across both routes, a 30 s cooldown per route, strict
// keys. With no provider configured (or the named provider not configured) the answer is 409 NO_VERIFIED_DATA and no
// request is made.
//
// Scope: WALL-CLOCK STATUS ONLY. The result is kept in memory by server/data/providers (status text for /api/status and
// /api/sources) and NEVER reaches the replay: no order, fill, mark, agent, assessment or evidence packet reads it, and
// options orders in the replay stay NO_VERIFIED_OPTIONS_DATA. Quote prices and contract terms are withheld from the
// response and the journal: a quote taken now is later than the replay clock, so its values must not reach the
// replay's views. Each attempt is journaled as FEED_VERIFY (no keys, no prices; provider error text is scrubbed).
import { feedStatus, verifyLiveFeed, verifyOptionsFeed, OPTIONS_VERIFY_SCOPE } from '../data/providers/index.js';
import { append } from '../journal.js';
import { ApiError, conflict, onlyKeys, symbol, oneOf } from './http.js';

export const FEED_VERIFY_COOLDOWN_MS = 30_000;
export const FEED_VERIFY_CONTROL = 'Sources › Verify market feed (POST /api/feeds/verify)';
export const FEED_PROVIDERS = Object.freeze(['alpaca', 'polygon']);
const LIVE_SCOPE = 'WALL_CLOCK_STATUS_ONLY: proves the configured feed returns current data now; never used by the replay, agents, assessments or fills';
const PRICES_WITHHELD = 'Quote prices and contract terms are withheld: they are later than the replay clock and must not reach the replay views.';

/** Remove configured secret values, URL credentials and key-like query parameters from provider text. */
export function scrubText(text, secrets = [], max = 300) {
  let t = String(text ?? '');
  for (const s of secrets) if (s && t.includes(s)) t = t.split(s).join('[REDACTED]');
  t = t.replace(/(https?:\/\/)[^/\s"@]+@/gi, '$1[REDACTED]@')
    .replace(/((?:api[_-]?key|apikey|token|secret|key_id|password)=)[^&\s"']+/gi, '$1[REDACTED]');
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

/** Validate, check configuration, single-flight and cooldown; returns the provider to prefer (or null). */
function preflight(ctx, kind, providerRaw) {
  const preferred = oneOf(providerRaw, FEED_PROVIDERS, 'provider', { optional: true, dflt: null });
  const configured = feedStatus(ctx.env).providers.filter((p) => p.configured).map((p) => p.id);
  const st = ctx.replay();
  if (!configured.length || (preferred && !configured.includes(preferred))) {
    const detail = preferred && configured.length
      ? `market-data provider ${preferred} is not configured (configured: ${configured.join(', ')})`
      : 'no market-data provider is configured (set ALPACA_API_KEY_ID + ALPACA_API_SECRET_KEY or POLYGON_API_KEY in the server environment and restart)';
    append(ctx.db, {
      session_id: st.session_id, ts_sim: st.clock, actor: 'human', type: 'FEED_VERIFY', ref_id: null,
      payload: { kind, decision: 'REFUSED', code: 'NO_VERIFIED_DATA', provider: preferred, detail, requestMade: false },
    });
    throw conflict('NO_VERIFIED_DATA', `NO_VERIFIED_DATA: ${detail}`, { kind, configured });
  }
  if (ctx.busy.feedVerify) throw new ApiError(429, 'FEED_VERIFY_BUSY', 'a feed verification is already running');
  const wait = (ctx.feedVerifyLast[kind] ?? 0) + FEED_VERIFY_COOLDOWN_MS - Date.now();
  if (wait > 0) throw new ApiError(429, 'FEED_VERIFY_RATE_LIMITED', `wait ${Math.ceil(wait / 1000)} s before verifying again`, { retryAfterMs: wait });
  return { preferred, st };
}

async function runVerification(ctx, kind, fn) {
  ctx.busy.feedVerify = true;
  ctx.feedVerifyLast[kind] = Date.now();
  try {
    return await fn();
  } catch (e) {
    return { status: kind === 'options' ? 'NO_VERIFIED_OPTIONS_DATA' : 'PROVIDER_FAULT', detail: `verification failed: ${String(e?.message ?? e).slice(0, 200)}` };
  } finally {
    ctx.busy.feedVerify = false;
  }
}

/** POST /api/feeds/verify {sym, provider?} */
export async function postFeedVerify(ctx, _req, { body }) {
  onlyKeys(body, ['sym', 'provider']);
  const sym = symbol(body.sym);
  const { preferred, st } = preflight(ctx, 'live', body.provider);
  const r = await runVerification(ctx, 'live', () => verifyLiveFeed({ env: ctx.env, fetchImpl: ctx.fetchImpl, sym, preferred }));
  const q = r.quote ?? null;
  const quote = q ? { twoSided: !!(q.bid && q.ask), quoteTs: Number.isFinite(q.quoteTs) ? q.quoteTs : null, ageMs: Number.isFinite(q.quoteTs) ? Date.now() - q.quoteTs : null } : null;
  const detail = scrubText(r.detail, ctx.secrets);
  const verified = r.status === 'LIVE_VERIFIED' || r.status === 'DELAYED_REAL';
  append(ctx.db, {
    session_id: st.session_id, ts_sim: st.clock, actor: 'human', type: 'FEED_VERIFY', ref_id: null,
    payload: { kind: 'live', decision: verified ? 'VERIFIED' : 'NOT_VERIFIED', status: r.status, provider: r.provider ?? preferred, sym, detail, quote, requestMade: true, scope: LIVE_SCOPE, pricesStored: false },
  });
  const live = feedStatus(ctx.env).live;
  return {
    decision: verified ? 'VERIFIED' : 'NOT_VERIFIED', kind: 'live', sym, provider: r.provider ?? preferred, status: r.status, detail, quote,
    feed: { status: live.status, provider: live.provider ?? null, detail: live.detail },
    scope: LIVE_SCOPE, pricesWithheld: true, cooldownMs: FEED_VERIFY_COOLDOWN_MS,
    note: `Wall-clock verification of the configured feed, kept in memory for status display until the server restarts. ${PRICES_WITHHELD}`,
  };
}

/** POST /api/options/verify {underlying, provider?} */
export async function postOptionsVerify(ctx, _req, { body }) {
  onlyKeys(body, ['underlying', 'provider']);
  const underlying = symbol(body.underlying, 'underlying');
  const { preferred, st } = preflight(ctx, 'options', body.provider);
  const r = await runVerification(ctx, 'options', () => verifyOptionsFeed({ env: ctx.env, fetchImpl: ctx.fetchImpl, underlying, preferred }));
  const detail = scrubText(r.detail ?? (r.status === 'SUPPORTED_VERIFIED' ? `contracts and an OPRA quote returned by ${r.provider}` : ''), ctx.secrets);
  const verified = r.status === 'SUPPORTED_VERIFIED';
  const result = {
    contractFound: !!r.contract, twoSidedQuote: !!(r.quote?.bid && r.quote?.ask), quoteFeed: r.quoteFeed ?? null, indicative: !!r.indicative,
  };
  append(ctx.db, {
    session_id: st.session_id, ts_sim: st.clock, actor: 'human', type: 'FEED_VERIFY', ref_id: null,
    payload: { kind: 'options', decision: verified ? 'VERIFIED' : 'NOT_VERIFIED', status: r.status, provider: r.provider ?? preferred, underlying, detail, ...result, requestMade: true, scope: OPTIONS_VERIFY_SCOPE, pricesStored: false },
  });
  const opt = feedStatus(ctx.env).options;
  return {
    decision: verified ? 'VERIFIED' : 'NOT_VERIFIED', kind: 'options', underlying, provider: r.provider ?? preferred, status: r.status, detail, ...result,
    feed: { status: opt.status, provider: opt.provider ?? null, detail: opt.detail },
    scope: OPTIONS_VERIFY_SCOPE, pricesWithheld: true, cooldownMs: FEED_VERIFY_COOLDOWN_MS,
    replayOptionsOrders: 'REJECTED — NO_VERIFIED_OPTIONS_DATA: this check is wall-clock status only; the replay has no as-of historical option quotes.',
    note: `Wall-clock verification of the configured options feed, kept in memory for status display until the server restarts. ${PRICES_WITHHELD}`,
  };
}
