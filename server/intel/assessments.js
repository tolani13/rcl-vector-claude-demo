// Evidence packets and independent risk-lens assessments (CONTRACTS.md section 8).
//
// buildEvidencePacket() assembles ONLY knowable, sourced items for (ds, sym, asOf):
//   * as-of market statistics read through server/data/marketdata.js (IEX-only),
//   * macro observations from macroAsOf() when ingested,
//   * FINRA daily short-sale volume rows dated before the replay trade date when ingested,
//   * symbol identity (name / exchange / ETF flag) ONLY from a symbol-directory snapshot published at or before asOf
//     (knowable at its File Creation Time). A post-dated snapshot never reaches a packet, and the packet then says
//     nothing about whether the symbol is in it (its absence would leak later delistings).
// Explicit unknowns are listed under "unavailable" (sector/industry, analyst views, filings/news/financing, other venues),
// so a model is told what it does NOT have instead of filling the gap from memory.
// Each item is persisted to the append-only evidence store with a content-addressed id.
//
// runLensAssessments() sends the identical packet to Cowboy, Pragmatist and Tightwad in SEPARATE calls (no lens
// sees another's output), validates each output, stores one assessments row per lens and never averages or votes.
// An assessment is research output, not authority: a proposed_intent becomes at most a TradeIntent DRAFT that must
// still pass the deterministic policy gate elsewhere. Nothing here submits orders.
//
// Hindsight guard: a model can remember what happened after a replay date that falls before (or shortly after) its
// training cutoff. Runs are BLOCKED (REPLAY_BEFORE_MODEL_CUTOFF / MODEL_TRAINING_CUTOFF_UNKNOWN) unless the operator
// explicitly allows it (VECTOR_ALLOW_PRE_CUTOFF_REPLAY=1), in which case every result is stamped hindsight_risk.
import { MINUTE, etToUtc, fmtEt } from '../util/time.js';
import { sha256Hex, newId } from '../util/ids.js';
import { uToUsd, usdToU } from '../util/money.js';
import {
  getDataset, sessionWindow, barsAsOf, quoteAsOf, lastTradeAsOf, statusAsOf, closeAtOrBefore, macroAsOf,
  symbolVisibleAsOf, NOT_IN_STORED_UNIVERSE_NOTE,
} from '../data/marketdata.js';
import { secConfig } from '../data/ingest/sec-edgar.js';
import { KNOWN_TEST_SYMBOLS, largeCapList } from '../data/universe.js';
import { append as journalAppend } from '../journal.js';
import { intentFromProposal, PROPOSAL_KEYS } from '../agents/intents.js';
import { insertEvidence, evidenceId } from './evidence.js';
import {
  LENSES, LENS_OUTPUT_SCHEMA, LENS_SCHEMA_NAME, systemPromptFor, renderPacketMessage, checkLensSemantics, crossCheckNumbers,
} from './prompts.js';
import { KNOWN_TRAINING_CUTOFFS, DEFAULTS as MODEL_DEFAULTS, validIsoDate } from './model-provider.js';
import { realDataPrivacyCheck } from './providers/presets.js';

// v3: explicit sector_industry / analyst_views unknowns, filings_news_financing (was filings_news_analysts), and the
// NOT_IN_STORED_UNIVERSE_AS_OF wording for symbols not visible at the as-of time.
export const PACKET_VERSION = 'vector-evidence-packet-v3';
export const RETURN_WINDOWS_MIN = Object.freeze([5, 15, 60]);
export const EARLY_BASELINE_MIN = 30;     // 09:30–10:00 ET
export const RECENT_WINDOW_MIN = 15;
export const MIN_CLASSIFIED_SHARES = 1000; // below this, an inferred buy share is reported as null
const SYM_RE = /^[A-Z][A-Z0-9.+=^-]{0,11}$/;
const AGGRESSOR_CAVEAT = 'Inferred aggressor share (quote rule vs IEX BBO; IEX-only). Trades at/above the prevailing IEX ask '
  + 'count as buyer-initiated, at/below the IEX bid as seller-initiated; trades inside the spread or without a two-sided quote '
  + 'are unclassified. This is an inference about IEX executions only, not observed intent; volume alone is not buying intent.';
const FINRA_PUBLISH_HOUR_ET = 18;         // FINRA Reg SHO daily files are published by ~6 p.m. ET on the trade date

const usd = (u) => (u === null || u === undefined ? null : uToUsd(u));
const round = (x, d = 2) => (x === null || !Number.isFinite(x) ? null : Math.round(x * 10 ** d) / 10 ** d);
const etTime = (ms) => fmtEt(ms, { seconds: true });

// ---------------------------------------------------------------------------------------------------------------
// Evidence packet

function sum(rows, k) { return rows.reduce((a, r) => a + (r[k] || 0), 0); }

/**
 * Market statistics as of asOf. Derived summaries are stamped knowable_ts = asOf: a statement such as
 * "no quote change since 10:19" is itself only knowable at asOf, so stamping it earlier would leak.
 * event_ts carries the latest underlying observation time.
 */
function marketItems(db, ds, dataset, sym, asOf, win) {
  const items = [];
  const unavailable = [];
  const prov = { provider: dataset.provider, ds, source_url: dataset.source_url ?? null, source_id: dataset.source_id ?? null };
  const bars = barsAsOf(db, ds, sym, asOf, { limit: 2000 });
  const lastBarT = bars.length ? bars[bars.length - 1].t : null;
  const quote = quoteAsOf(db, ds, sym, asOf);
  const last = lastTradeAsOf(db, ds, sym, asOf);
  const st = statusAsOf(db, ds, sym, asOf);
  const recentFrom = asOf - RECENT_WINDOW_MIN * MINUTE;
  const recent = bars.filter((b) => b.t >= recentFrom);
  const session = bars.filter((b) => b.t >= win.open && b.t < win.close);
  const pre = bars.filter((b) => b.t < win.open);

  if (!bars.length) {
    // Not visible = not (yet) in the stored universe at asOf. The wording says only what the as-of view knows; it does
    // not reveal whether the symbol is stored later in the day.
    let visible = false;
    try { visible = symbolVisibleAsOf(db, ds, sym, asOf); } catch { visible = false; }
    unavailable.push({
      kind: 'market', status: 'NO_VERIFIED_DATA',
      detail: visible ? `no completed IEX minute for ${sym} in ${ds} as of ${fmtEt(asOf)}` : `${sym}: ${NOT_IN_STORED_UNIVERSE_NOTE}`,
    });
    return { items, unavailable };
  }

  // 1. Prevailing IEX top-of-book + recent spread behaviour.
  if (quote) {
    const maxSpr = recent.reduce((m, b) => (b.max_spr !== null && b.max_spr !== undefined ? Math.max(m, b.max_spr) : m), -1);
    // Crossing the spread on entry (at the ask) and exit (at the bid) costs one full spread relative to the mid.
    const sprPct = quote.twoSided && quote.mid > 0 && Number.isFinite(quote.spreadU) ? round((quote.spreadU / quote.mid) * 100, 3) : null;
    items.push({
      ...prov, sym, kind: 'market_quote', title: `IEX top-of-book for ${sym} as of ${fmtEt(asOf)}`,
      event_ts: quote.quoteTs, knowable_ts: asOf,
      body: {
        venue: 'IEX (BBO only, not the consolidated NBBO)',
        bid_usd: usd(quote.bid), ask_usd: usd(quote.ask), bid_size: quote.bidSize, ask_size: quote.askSize,
        two_sided: quote.twoSided, spread_usd: usd(quote.spreadU), spread_bps: quote.spreadBps, mid_usd: usd(quote.mid),
        spread_pct_of_mid: sprPct, round_trip_cross_cost_pct: sprPct,
        quote_time_et: etTime(quote.quoteTs), quote_age_sec: Math.round(quote.ageMs / 1000),
        halted: quote.halted, extended_session_quote: quote.extendedSession,
        recent_15m: { max_two_sided_spread_usd: maxSpr >= 0 ? usd(maxSpr) : null, quote_updates: sum(recent, 'nq') },
      },
    });
  } else {
    unavailable.push({ kind: 'market_quote', status: 'NO_VERIFIED_DATA', detail: 'no IEX quote observed as of the as-of time' });
  }

  // 2. Last trade, intraday returns and ranges.
  if (last) {
    const firstSession = session.find((b) => b.c !== null && b.o !== null);
    const returns = RETURN_WINDOWS_MIN.map((w) => {
      const ref = closeAtOrBefore(db, ds, sym, asOf - MINUTE - w * MINUTE, asOf);
      if (!ref) return { window_min: w, status: 'NO_VERIFIED_DATA' };
      return {
        window_min: w, ref_usd: usd(ref.priceU), ref_minute_et: fmtEt(ref.minuteT),
        ret_pct: round(((last.priceU - ref.priceU) / ref.priceU) * 100, 2),
        ref_before_regular_session: ref.minuteT < win.open,
        last_trade_older_than_window: last.minuteT <= asOf - MINUTE - w * MINUTE,
      };
    });
    // Self-describing names (session_ / recent_15m_ / premarket_) so a reader cannot mistake the window of a high/low.
    const hiLo = (rows, prefix) => {
      const h = rows.filter((b) => b.h !== null).map((b) => b.h);
      const l = rows.filter((b) => b.l !== null).map((b) => b.l);
      return h.length ? { [`${prefix}_high_usd`]: usd(Math.max(...h)), [`${prefix}_low_usd`]: usd(Math.min(...l)) } : null;
    };
    const recentSess = recent.filter((b) => b.t >= win.open);
    items.push({
      ...prov, sym, kind: 'market_price', title: `IEX last trade and intraday returns for ${sym} as of ${fmtEt(asOf)}`,
      event_ts: last.minuteT, knowable_ts: asOf,
      body: {
        venue: 'IEX trades only',
        last_trade_usd: usd(last.priceU), last_trade_minute_et: fmtEt(last.minuteT),
        returns,
        regular_session: firstSession
          ? { first_trade_usd: usd(firstSession.o), first_trade_minute_et: fmtEt(firstSession.t),
            ret_since_first_trade_pct: round(((last.priceU - firstSession.o) / firstSession.o) * 100, 2), ...hiLo(session, 'session') }
          : { status: asOf <= win.open ? 'NOT_OPEN_YET' : 'NO_REGULAR_SESSION_TRADES_YET' },
        recent_15m: hiLo(recentSess, 'recent_15m') ?? { status: 'NO_REGULAR_SESSION_TRADES_IN_LAST_15_MIN' },
        premarket: pre.some((b) => b.n > 0) ? hiLo(pre, 'premarket') : { status: 'NO_PREMARKET_TRADES' },
      },
    });
  } else {
    unavailable.push({ kind: 'market_price', status: 'NO_VERIFIED_DATA', detail: 'no IEX trade observed as of the as-of time' });
  }

  // 3. Volume: session-to-date versus the early-session baseline (IEX executions only).
  const elapsedMin = Math.max(0, Math.min((Math.min(asOf, win.close) - win.open) / MINUTE, 390));
  const sessV = sum(session, 'v');
  const sessPv = session.reduce((a, b) => a + (b.pv || 0), 0);
  const baselineEnd = win.open + EARLY_BASELINE_MIN * MINUTE;
  let early = { status: 'NOT_YET_AVAILABLE', detail: `needs the first ${EARLY_BASELINE_MIN} regular-session minutes` };
  let recentPerMin = null;
  if (asOf >= baselineEnd) {
    const eb = session.filter((b) => b.t < baselineEnd);
    early = { window_et: `${fmtEt(win.open)}-${fmtEt(baselineEnd)}`, per_min_volume: round(sum(eb, 'v') / EARLY_BASELINE_MIN, 1), trades: sum(eb, 'n') };
  }
  if (asOf > win.open) {
    const recSess = recent.filter((b) => b.t >= win.open);
    const minutes = Math.min(RECENT_WINDOW_MIN, elapsedMin);
    recentPerMin = minutes > 0 ? round(sum(recSess, 'v') / minutes, 1) : null;
  }
  items.push({
    ...prov, sym, kind: 'market_volume', title: `IEX volume for ${sym}, session to date vs early baseline, as of ${fmtEt(asOf)}`,
    event_ts: lastBarT, knowable_ts: asOf,
    body: {
      scope: 'IEX executions only - a small share of consolidated volume',
      regular_session: {
        minutes_elapsed: elapsedMin, volume: sessV, trades: sum(session, 'n'),
        active_minutes: session.filter((b) => b.n > 0).length, session_vwap_usd: sessV > 0 ? round(uToUsd(sessPv / sessV), 4) : null,
      },
      premarket: { volume: sum(pre, 'v'), trades: sum(pre, 'n') },
      early_baseline: early,
      recent: { window_min: RECENT_WINDOW_MIN, per_min_volume: recentPerMin, trades: sum(recent.filter((b) => b.t >= win.open), 'n') },
      recent_vs_early_ratio: early.per_min_volume > 0 && recentPerMin !== null ? round(recentPerMin / early.per_min_volume, 2) : null,
      recent_overlaps_baseline: asOf - RECENT_WINDOW_MIN * MINUTE < baselineEnd,
    },
  });

  // 4. Inferred aggressor shares, always with their caveat.
  const aggr = (rows) => {
    const bv = sum(rows, 'bv'); const sv = sum(rows, 'sv'); const xv = sum(rows, 'xv');
    const classified = bv + sv;
    const total = bv + sv + xv;
    return {
      buyer_initiated: bv, seller_initiated: sv, unclassified: xv,
      buy_share: classified >= MIN_CLASSIFIED_SHARES ? round(bv / classified, 3) : null,
      classified_share_of_volume: total > 0 ? round(classified / total, 3) : null,
    };
  };
  items.push({
    ...prov, sym, kind: 'market_aggressor_inferred', title: `Inferred aggressor shares for ${sym} (IEX-only) as of ${fmtEt(asOf)}`,
    event_ts: lastBarT, knowable_ts: asOf,
    body: {
      caveat: AGGRESSOR_CAVEAT, min_classified_shares_for_share: MIN_CLASSIFIED_SHARES,
      regular_session: aggr(session), recent_15m: aggr(recent.filter((b) => b.t >= win.open)), premarket: aggr(pre),
    },
  });

  // 5. Trading status / halts (IEX trading-status messages + per-minute halt flags), as of asOf.
  const haltMinutes = bars.filter((b) => b.halted === 1 || b.unavail === 1).map((b) => b.t);
  items.push({
    ...prov, sym, kind: 'market_trading_status', title: `IEX trading status and halts for ${sym} as of ${fmtEt(asOf)}`,
    event_ts: st.tradingStatusTs ?? (haltMinutes.length ? haltMinutes[haltMinutes.length - 1] : null), knowable_ts: asOf,
    body: {
      source: 'IEX trading-status / operational-halt messages; other venues not covered',
      status_known: st.known, trading_status_code: st.tradingStatus, status_time_et: st.tradingStatusTs ? etTime(st.tradingStatusTs) : null,
      reason: st.reason ?? null, halted_now: st.halted, operational_halt_now: st.operationalHalt,
      halted_or_unavailable_minutes: haltMinutes.length,
      halted_or_unavailable_minutes_et: haltMinutes.slice(-20).map((t) => fmtEt(t)),
      code_legend: 'T trading, H halted, P paused, O order-acceptance period',
    },
  });
  return { items, unavailable };
}

function macroItems(db, asOf) {
  const items = [];
  let series = [];
  try { series = macroAsOf(db, asOf); } catch { series = []; }
  const withObs = series.filter((s) => s.latest);
  if (!withObs.length) {
    return { items, unavailable: [{ kind: 'macro', status: 'NO_VERIFIED_DATA', detail: 'no macro observations ingested/knowable as of the as-of time' }] };
  }
  const unavailable = [];
  for (const s of withObs) {
    const ds = getDataset(db, s.ds);
    const lagDays = s.publication_lag_days ?? 1;
    const obs = s.observations;
    const prev = obs.length > 1 ? obs[obs.length - 2] : null;
    const legacyKnowable = Date.parse(`${s.latest.date}T00:00:00Z`) + lagDays * 86_400_000;
    // The data layer's release-calendar time is authoritative when present (it is never earlier than the legacy rule),
    // and nothing is knowable before its source dataset was published (when that time is recorded).
    const released = Number.isSafeInteger(s.latest.knowable_ts) ? Math.max(s.latest.knowable_ts, legacyKnowable) : legacyKnowable;
    const knowable = Number.isSafeInteger(ds?.published_at) ? Math.max(released, ds.published_at) : released;
    if (knowable > asOf) {
      unavailable.push({ kind: 'macro_observation', status: 'NO_VERIFIED_DATA', detail: `${s.series}: source dataset ${s.ds} was published after the as-of time` });
      continue;
    }
    const fetchedAt = s.vintage?.fetchedAt ?? ds?.ingested_at ?? null;
    items.push({
      sym: null, kind: 'macro_observation', title: `${s.title || s.series} (${s.series}) observation ${s.latest.date}`,
      provider: ds?.provider || 'macro series (provider not recorded)', ds: s.ds, source_url: ds?.source_url ?? null, source_id: s.series,
      event_ts: Date.parse(`${s.latest.date}T00:00:00Z`),
      knowable_ts: knowable,
      body: {
        series: s.series, title: s.title ?? null, units: s.units ?? null, frequency: s.frequency ?? null,
        date: s.latest.date, value: s.latest.value, previous: prev ? { date: prev.date, value: prev.value } : null,
        knowable_rule: s.knowable_rule ?? `observation date + ${lagDays} publication-lag day(s) (series configuration)`,
        // Stored values are the latest FRED vintage at fetch time, not the first print (ALFRED vintages not ingested).
        value_vintage: 'LATEST_AT_FETCH',
        vintage_caveat: `Latest FRED vintage at fetch time (fetched ${Number.isFinite(fetchedAt) ? fmtEt(fetchedAt, { date: true }) : 'at an unrecorded time'}); `
          + 'the value may differ from the first-published figure; ALFRED real-time vintages are not used.',
      },
    });
  }
  return { items, unavailable };
}

function shortVolumeItems(db, sym, tradeDate, asOf) {
  let rows = [];
  try {
    rows = db.prepare('SELECT date, sym, short_vol, short_exempt_vol, total_vol, markets, ds FROM short_volume WHERE sym = ? AND date < ? ORDER BY date DESC LIMIT 5')
      .all(sym, tradeDate);
  } catch { rows = []; }
  // Knowable at 18:00 ET on the trade date (assumed publication), or at the file's recorded publication time if later.
  const dsCache = new Map();
  const dsOf = (id) => { if (!dsCache.has(id)) dsCache.set(id, getDataset(db, id)); return dsCache.get(id); };
  const knowableOf = (r) => Math.max(etToUtc(r.date, FINRA_PUBLISH_HOUR_ET, 0), Number.isFinite(dsOf(r.ds)?.published_at) ? dsOf(r.ds).published_at : 0);
  rows = rows.filter((r) => knowableOf(r) <= asOf);
  if (!rows.length) {
    return { items: [], unavailable: [{ kind: 'finra_short_volume', status: 'NO_VERIFIED_DATA', detail: `no FINRA daily short-sale volume rows for ${sym} dated before ${tradeDate}` }] };
  }
  const ds = dsOf(rows[0].ds);
  const knowable = Math.max(...rows.map(knowableOf));
  return {
    items: [{
      sym, kind: 'finra_short_volume', title: `FINRA daily short-sale volume for ${sym}, ${rows.length} day(s) before ${tradeDate}`,
      provider: ds?.provider || 'FINRA Reg SHO daily short sale volume', ds: rows[0].ds, source_url: ds?.source_url ?? null, source_id: null,
      event_ts: etToUtc(rows[0].date, 16, 0), knowable_ts: knowable,
      body: {
        caveat: 'FINRA-reported off-exchange (TRF/ADF/ORF) short-sale volume only; not consolidated volume and not short interest.',
        rows: rows.map((r) => ({
          date: r.date, short_vol: r.short_vol, short_exempt_vol: r.short_exempt_vol, total_vol: r.total_vol,
          short_ratio: r.total_vol > 0 ? round(r.short_vol / r.total_vol, 3) : null, markets: r.markets ?? null,
        })),
      },
    }],
    unavailable: [],
  };
}

// Identical for every symbol, whether or not it appears in a post-dated snapshot: its absence would leak delistings.
const IDENTITY_POSTDATED = Object.freeze({
  kind: 'symbol_identity', status: 'UNAVAILABLE_NOT_VERIFIED',
  detail: 'no symbol-directory snapshot published at or before the as-of time is ingested; identity (name, exchange, ETF flag) omitted to avoid look-ahead',
});

/**
 * Symbol identity from the newest COMPLETE symbol-directory snapshot published at or before asOf (published_at = the
 * snapshot's File Creation Time; ingested_at is a conservative fallback when it is unknown). The item is knowable at
 * that time, never at asOf. The snapshot is chosen first and the symbol looked up in it afterwards, so a post-dated
 * snapshot is never consulted for this symbol at all.
 */
function identityItems(db, sym, asOf) {
  let snap = null;
  try {
    snap = db.prepare(`SELECT id, provider, source_url, COALESCE(published_at, ingested_at) AS knowable FROM datasets
      WHERE kind = 'symbol_directory' AND status = 'complete' AND COALESCE(published_at, ingested_at) <= ?
      ORDER BY COALESCE(published_at, ingested_at) DESC, id DESC LIMIT 1`).get(asOf);
  } catch { snap = null; }
  if (!snap) return { items: [], unavailable: [{ ...IDENTITY_POSTDATED }] };
  const created = fmtEt(snap.knowable, { date: true });
  let r = null;
  try { r = db.prepare('SELECT name, exchange, etf FROM ref_symbols WHERE ds = ? AND sym = ?').get(snap.id, sym); } catch { r = null; }
  if (!r) {
    return {
      items: [],
      unavailable: [{
        kind: 'symbol_identity', status: 'NO_VERIFIED_DATA',
        detail: `not found in the symbol directory dated ${created}; symbology may differ (IEX suffixes for warrants, rights and preferreds vs the directory's format)`,
      }],
    };
  }
  return {
    items: [{
      sym, kind: 'symbol_identity', title: `Symbol directory identity for ${sym} (snapshot ${created})`,
      provider: snap.provider || 'symbol directory', ds: snap.id, source_url: snap.source_url ?? null, source_id: null,
      event_ts: snap.knowable, knowable_ts: snap.knowable,
      body: {
        name: r.name ?? null, exchange: r.exchange ?? null, etf: r.etf === null || r.etf === undefined ? null : r.etf === 1,
        snapshot_created_et: created,
        temporal_policy: `Directory snapshot created ${created}, at or before the as-of time; fields describe the security at that instant. `
          + 'Temporal status fields (financial status, round lot) are excluded.',
      },
    }],
    unavailable: [],
  };
}

/**
 * Defensive as-of guard run on every packet: nothing knowable after asOf may enter it. The second check does not trust
 * the item builders: an item may never claim to be knowable before its source dataset was published (market tick
 * datasets are exempt because their knowable time is per minute row, enforced by marketdata.js). Throws on violation.
 */
export function assertPacketAsOf(db, records, asOf) {
  for (const r of records) {
    if (!(r.knowable_ts <= asOf)) throw new Error(`as-of violation: ${r.kind} knowable at ${r.knowable_ts} > ${asOf}`);
    const src = r.ds ? getDataset(db, r.ds) : null;
    if (src && src.kind !== 'market_ticks' && Number.isFinite(src.published_at) && r.knowable_ts < src.published_at) {
      throw new Error(`as-of violation: ${r.kind} stamped knowable at ${r.knowable_ts}, before its source ${r.ds} was published (${src.published_at})`);
    }
  }
}

/**
 * Explicit unknowns every packet carries. Sector/industry would come from SEC SIC codes: BLOCKED when SEC EDGAR access
 * is not configured (SEC_USER_AGENT), otherwise NO_VERIFIED_DATA because SIC codes are not ingested in this build.
 * Analyst views have no connected licensed source at all, so they are UNAVAILABLE_NOT_VERIFIED regardless of SEC.
 */
export function packetUnknowns(env = process.env) {
  const sec = secConfig(env);
  return [
    sec.configured
      ? { kind: 'sector_industry', status: 'NO_VERIFIED_DATA', detail: 'SEC EDGAR is configured but SIC codes are not ingested in this build; no sector or industry classification is included or inferred' }
      : { kind: 'sector_industry', status: 'BLOCKED', detail: `sector/industry (SEC SIC code) requires SEC EDGAR access, which is not configured (${sec.reason}); no classification is included or inferred` },
    { kind: 'analyst_views', status: 'UNAVAILABLE_NOT_VERIFIED', detail: 'no licensed analyst or commentator source is connected; analyst views, ratings and price targets are not included and must not be inferred' },
    { kind: 'filings_news_financing', status: 'NO_VERIFIED_DATA', detail: 'no SEC filings, news, financing or dilution evidence is included in this packet' },
    { kind: 'other_venues', status: 'NO_VERIFIED_DATA', detail: 'quotes/trades from venues other than IEX are not available' },
  ];
}

/**
 * Build (and by default persist) the evidence packet for one symbol as of asOf.
 * @returns {{status:'OK', sym, ds, asOf, packet, evidenceIds:string[], userMessage:string, sha256:string}
 *          | {status:'NO_VERIFIED_DATA'|'BLOCKED', sym, ds, asOf, detail:string}}
 */
export function buildEvidencePacket(db, ds, sym, asOf, { persist = true, now = Date.now(), env = process.env } = {}) {
  if (!Number.isFinite(asOf)) throw new TypeError('asOf (ms UTC) is required');
  const S = typeof sym === 'string' ? sym.trim().toUpperCase() : '';
  if (!SYM_RE.test(S)) throw new TypeError('invalid symbol');
  if (KNOWN_TEST_SYMBOLS.has(S)) return { status: 'BLOCKED', sym: S, ds, asOf, detail: `${S} is an exchange test symbol, not a real issuer` };
  const dataset = ds ? getDataset(db, ds) : null;
  if (!dataset || dataset.kind !== 'market_ticks') return { status: 'NO_VERIFIED_DATA', sym: S, ds, asOf, detail: `market dataset "${ds}" not found` };
  const win = sessionWindow(db, ds);
  if (!win) return { status: 'NO_VERIFIED_DATA', sym: S, ds, asOf, detail: `market dataset "${ds}" has no trade date` };

  const m = marketItems(db, ds, dataset, S, asOf, win);
  if (!m.items.length) return { status: 'NO_VERIFIED_DATA', sym: S, ds, asOf, detail: m.unavailable.map((u) => u.detail).join('; ') };
  const parts = [m, identityItems(db, S, asOf), shortVolumeItems(db, S, win.tradeDate, asOf), macroItems(db, asOf)];
  const records = parts.flatMap((p) => p.items);
  const unavailable = [...parts.flatMap((p) => p.unavailable), ...packetUnknowns(env)];
  assertPacketAsOf(db, records, asOf);

  // persist:false (previews) still yields the ids the store would assign, because ids are content-addressed.
  const items = records.map((r) => ({ ...r, id: persist ? insertEvidence(db, r, { now }).id : evidenceId(r) }));
  const phase = asOf <= win.open ? 'pre-market' : asOf <= win.close ? 'regular session' : 'post-market';
  const meta = {
    packet_version: PACKET_VERSION, sym: S, as_of_et: fmtEt(asOf, { date: true }), as_of_ms: asOf, trade_date: win.tradeDate,
    session_phase: phase, market_data: `${dataset.provider} (dataset ${ds}, status ${dataset.status})`,
    market_coverage: String(dataset.venue_coverage ?? 'IEX only').slice(0, 300),
    units: 'prices USD per share (converted from IEX 1e-4 fixed point); volumes in shares; IEX-only unless an item says otherwise',
    paper_only: true,
  };
  const modelView = {
    meta,
    items: items.map((it) => ({ id: it.id, kind: it.kind, title: it.title, knowable_at: fmtEt(it.knowable_ts, { date: true }), data: it.body })),
    unavailable,
  };
  const userMessage = renderPacketMessage(modelView);
  return {
    status: 'OK', sym: S, ds, asOf,
    packet: { meta, items, unavailable },
    evidenceIds: items.map((it) => it.id),
    userMessage,
    sha256: sha256Hex(userMessage),
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Lens assessments

const inflight = new Map(); // session key -> reserved model calls not yet stored
const DAY_MS = 86_400_000;

function sessionKey(session_id) { return session_id ?? '__no_session__'; }

/**
 * Provider error kinds meaning the request never reached a model (nothing was generated or billed). Rows with these
 * errors stay in the audit trail but do not count against the call caps. CONNECT = fetch() rejected before any response
 * with a connection-establishment cause (ECONNREFUSED / ENOTFOUND / EAI_AGAIN / UND_ERR_CONNECT_TIMEOUT). NETWORK is NOT
 * here: a connection dropped while the response body was read (or an SDK connection error after a retry) may follow a
 * completion the endpoint already produced and billed, so it counts.
 */
export const NOT_SENT_ERROR_KINDS = Object.freeze(['CONNECT', 'DISCONNECTED', 'SDK_MISSING', 'NO_CREDENTIALS', 'CONFIG', 'LOCAL_RATE_LIMIT']);
// Failures that will repeat for every remaining lens of the same run: the run stops calling after the first one.
const SHORT_CIRCUIT_ERROR_KINDS = Object.freeze(['CONNECT', 'NETWORK', 'DISCONNECTED', 'SDK_MISSING', 'NO_CREDENTIALS', 'LOCAL_RATE_LIMIT']);
// Stored error strings start with "<errorKind>: " (classify()).
const COUNTED = `NOT (status = 'ERROR' AND (${NOT_SENT_ERROR_KINDS.map(() => 'error LIKE ?').join(' OR ')}))`;
const COUNTED_ARGS = NOT_SENT_ERROR_KINDS.map((k) => `${k}:%`);

/**
 * Lens calls that count against VECTOR_MAX_MODEL_CALLS_PER_SESSION for a session (rows whose error kind is in
 * NOT_SENT_ERROR_KINDS are audit-only). Exported so /api/model reports the same number the cap enforces.
 */
export function countedCallsUsed(db, session_id) {
  return callsUsed(db, session_id);
}

function callsUsed(db, session_id) {
  const r = session_id === null || session_id === undefined
    ? db.prepare(`SELECT COUNT(*) n FROM assessments WHERE session_id IS NULL AND ${COUNTED}`).get(...COUNTED_ARGS)
    : db.prepare(`SELECT COUNT(*) n FROM assessments WHERE session_id = ? AND ${COUNTED}`).get(session_id, ...COUNTED_ARGS);
  return r.n;
}

/** Model calls in the rolling 24 h wall-clock window across ALL sessions: lens calls plus explicit model tests. */
function callsUsedLast24h(db, now = Date.now()) {
  const since = now - DAY_MS;
  const a = db.prepare(`SELECT COUNT(*) n FROM assessments WHERE created_wall >= ? AND ${COUNTED}`).get(since, ...COUNTED_ARGS).n;
  let t = 0;
  try { t = db.prepare("SELECT COUNT(*) n FROM journal WHERE type = 'MODEL_TEST' AND ts_wall >= ?").get(since).n; } catch { t = 0; }
  return a + t;
}

const inflightTotal = () => [...inflight.values()].reduce((s, n) => s + n, 0);

function envInt(name, dflt) {
  const v = Number(process.env[name]);
  return Number.isInteger(v) && v > 0 ? v : dflt;
}

/**
 * Global model-call budget (rolling 24 h, wall clock, all replay sessions; a replay reset does not refill it).
 * Exported for /api/model and /api/model/test.
 * @returns {{cap:number, used:number, inflight:number, remaining:number, window:string}}
 */
export function modelCallBudget(db, provider = null, { now = Date.now(), maxCallsPerDay } = {}) {
  const cap = maxCallsPerDay ?? provider?.config?.maxCallsPerDay ?? envInt('VECTOR_MAX_MODEL_CALLS_PER_DAY', MODEL_DEFAULTS.maxCallsPerDay);
  const used = callsUsedLast24h(db, now);
  const busy = inflightTotal();
  return { cap, used, inflight: busy, remaining: Math.max(0, cap - used - busy), window: 'rolling 24 h (wall clock), all replay sessions; lens calls + model tests' };
}

const addDaysIso = (date, n) => new Date(Date.parse(`${date}T12:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);

/**
 * Hindsight check: may this provider's model judge a replay of `tradeDate` without remembering what happened next?
 * Safe only when tradeDate is more than cutoffMarginDays after the model's training cutoff. An unknown cutoff is NOT
 * safe. allowPreCutoffReplay lets a risky run proceed, but every result is stamped hindsight_risk.
 * @returns {{ok:boolean, risk:boolean, code:string|null, trainingCutoff:string|null, source:string|null, marginDays:number,
 *           safeAfter:string|null, allowOverride:boolean, detail:string}}
 */
export function hindsightCheck(provider, tradeDate) {
  const cfg = provider?.config ?? {};
  const configured = validIsoDate(cfg.trainingCutoff);
  const builtIn = KNOWN_TRAINING_CUTOFFS[provider?.model] ?? null;
  const trainingCutoff = configured ?? builtIn;
  const source = configured ? (cfg.trainingCutoffSource ?? 'configured') : builtIn ? 'built-in' : null;
  const marginDays = Number.isInteger(cfg.cutoffMarginDays) && cfg.cutoffMarginDays >= 0 ? cfg.cutoffMarginDays : MODEL_DEFAULTS.cutoffMarginDays;
  const allowOverride = cfg.allowPreCutoffReplay === true;
  const model = provider?.model ?? 'unknown model';
  if (!trainingCutoff) {
    return {
      ok: allowOverride, risk: true, code: 'MODEL_TRAINING_CUTOFF_UNKNOWN', trainingCutoff: null, source: null, marginDays, safeAfter: null, allowOverride,
      detail: `The training cutoff of ${model} is unknown, so it cannot be ruled out that the model remembers what happened after ${tradeDate}. `
        + 'Set VECTOR_MODEL_TRAINING_CUTOFF=YYYY-MM-DD (or trainingCutoff in the model config file) to the model\'s documented cutoff.',
    };
  }
  const safeAfter = addDaysIso(trainingCutoff, marginDays);
  if (!(typeof tradeDate === 'string' && tradeDate > safeAfter)) {
    return {
      ok: allowOverride, risk: true, code: 'REPLAY_BEFORE_MODEL_CUTOFF', trainingCutoff, source, marginDays, safeAfter, allowOverride,
      detail: `Replay date ${tradeDate} is before or within ${marginDays} days after the training cutoff of ${model} (${trainingCutoff}, ${source}). `
        + 'The model may remember what happened next, so its assessment would not be an as-of judgement.',
    };
  }
  return { ok: true, risk: false, code: null, trainingCutoff, source, marginDays, safeAfter, allowOverride, detail: `replay date ${tradeDate} is after ${safeAfter}` };
}

async function withTimeout(promise, ms) {
  let timer;
  const t = new Promise((_, rej) => { timer = setTimeout(() => rej(Object.assign(new Error(`model call exceeded ${ms} ms`), { code: 'VECTOR_TIMEOUT' })), ms); });
  try { return await Promise.race([promise, t]); } finally { clearTimeout(timer); }
}

const stripUndefined = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));

/**
 * Convert a validated lens proposal (USD) into a TradeIntent draft (u, CONTRACTS.md section 6). Pure function.
 * The draft is a typed proposal only; it is never executed here.
 */
export function proposalToIntentDraft(p, { lens, segment, sym, asOf, quoteTs }) {
  const u = (x) => (x === null || x === undefined ? undefined : usdToU(x));
  const attach = stripUndefined({ stop_loss_px_u: u(p.stop_loss_px_usd), take_profit_px_u: u(p.take_profit_px_usd), time_exit_min: p.time_exit_min ?? undefined });
  return stripUndefined({
    source: 'model',
    agent_id: null,
    portfolio_id: `${lens}-${segment}`,
    strategy_id: null,
    action: 'open',
    instrument: { kind: 'equity', sym },
    side: 'buy',
    qty: p.qty ?? undefined,
    budget_usd: p.budget_usd ?? undefined,
    order_type: p.order_type,
    limit_px_u: u(p.limit_px_usd),
    stop_px_u: u(p.stop_px_usd),
    attach: Object.keys(attach).length ? attach : undefined,
    rationale: p.rationale,
    evidence_refs: [...p.evidence_refs],
    quote_ts: quoteTs ?? null,
    created_ts: asOf,
    expires_ts: asOf + p.expires_in_min * MINUTE,
  });
}

/**
 * Validate a lens proposal as a TradeIntent exactly the way the agent runner does (intentFromProposal with a trusted
 * envelope). The envelope's agent id is the placeholder `draft:<lens>`: a manual assessment has no agent, and a null
 * agent_id would make every draft fail for a reason unrelated to the proposal. quote_ts is the packet's market_quote
 * time; without one the draft fails validation for that real reason. Pure function.
 * @returns {{status:'VALID'|'INVALID', intent:object, errors:string[]}}
 */
export function validateProposalDraft(p, { lens, segment, sym, asOf, quoteTs }) {
  const draft = proposalToIntentDraft(p, { lens, segment, sym, asOf, quoteTs });
  const proposal = Object.fromEntries(PROPOSAL_KEYS.filter((k) => draft[k] !== undefined).map((k) => [k, draft[k]]));
  const envelope = {
    source: 'model', agent_id: `draft:${lens}`, portfolio_id: draft.portfolio_id, strategy_id: null,
    quote_ts: Number.isSafeInteger(quoteTs) && quoteTs <= asOf ? quoteTs : null, created_ts: asOf, expires_ts: draft.expires_ts,
  };
  let r;
  try { r = intentFromProposal(proposal, envelope); } catch (e) { r = { ok: false, errors: [`intent validation threw: ${String(e?.message).slice(0, 200)}`] }; }
  return r.ok
    ? { status: 'VALID', intent: r.intent, errors: [] }
    : { status: 'INVALID', intent: { ...proposal, ...envelope }, errors: (r.errors ?? ['validation failed']).map(String) };
}

function intentFor(output, ctx) {
  if (!output || output.proposed_intent === null) return { status: 'NONE', intent: null, errors: [] };
  return validateProposalDraft(output.proposed_intent, ctx);
}

function classify(res, lens, evidenceIds, quote) {
  if (res.refusal) {
    const r = res.refusal;
    return { status: 'REFUSED', output: null, error: `REFUSED${r.category ? ` (${r.category})` : ''}${r.explanation ? `: ${String(r.explanation).slice(0, 500)}` : ''}` };
  }
  if (!res.ok) {
    const status = res.errorKind === 'INVALID_OUTPUT' ? 'INVALID_OUTPUT' : 'ERROR';
    return { status, output: null, error: `${res.errorKind || 'ERROR'}: ${String(res.error ?? 'unknown').slice(0, 1000)}` };
  }
  const problems = checkLensSemantics(res.json, { lens, evidenceIds, quote });
  if (problems.length) return { status: 'INVALID_OUTPUT', output: null, error: `SEMANTIC_INVALID: ${problems.slice(0, 12).join('; ')}` };
  return { status: 'OK', output: res.json, error: null };
}

/** Repair attempts per lens after INVALID_OUTPUT: opts, then provider config, then VECTOR_MODEL_REPAIR_ATTEMPTS (default 1, max 2). */
function repairAttemptsFor(opts, cfg) {
  const envRaw = Number(process.env.VECTOR_MODEL_REPAIR_ATTEMPTS);
  const v = opts.repairAttempts ?? cfg.repairAttempts ?? (Number.isInteger(envRaw) && envRaw >= 0 ? envRaw : 1);
  return Number.isInteger(v) ? Math.max(0, Math.min(2, v)) : 1;
}

/**
 * The same packet plus this lens's OWN rejected answer and validator errors, so the model edits only the flagged fields
 * instead of regenerating. Never includes another lens's output.
 */
function repairMessage(userMessage, error, previousRaw) {
  const prev = typeof previousRaw === 'string' && previousRaw.trim() ? `\nYour rejected answer was:\n${previousRaw.slice(0, 6000)}\n` : '';
  return `${userMessage}\n\n---\nVALIDATOR FEEDBACK (repair attempt). Your previous JSON answer for this same packet was rejected `
    + `and is NOT stored as an assessment.${prev}\nProblems found:\n${String(error ?? '').slice(0, 1500)}\n`
    + 'Return ONE corrected JSON object: keep everything that was valid and change only what the problems require. '
    + 'Every rule above still applies. Use only the evidence in this packet; do not add facts.';
}

/**
 * Run the requested lenses independently on one identical evidence packet.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {object} provider  ModelProvider (server/intel/model-provider.js getProvider())
 * @param {{session_id?:string|null, ds:string, sym:string, asOf:number, lenses?:string[], segment?:'micro'|'large',
 *          timeoutMs?:number, maxTokens?:number, maxCalls?:number, maxCallsPerDay?:number, packet?:object,
 *          env?:object, providers?:Record<string,object>, realAccountContext?:string|null}} opts
 *          env: decides the packet's SEC-dependent unknowns (default process.env).
 *          providers: per-lens ModelProviders (presets: one lens may use another model; pinAllLenses gives all three
 *          the same one); lenses not listed use `provider`. Every lens provider must be usable and pass the hindsight
 *          guard and its preset's local limits, or nothing is called (lenses are compared on the same packet).
 *          realAccountContext: the owner's REAL_ACCOUNT holding text, appended to the message (never stored as
 *          evidence); refused with BLOCKED REAL_DATA_PRIVACY_BLOCK unless every lens provider declares
 *          trains_on_prompts false; intent drafts are never derived from such a run.
 * @returns {Promise<object>} {status, ..., results:[per-lens]}; status is COMPLETED, MODEL_DISCONNECTED, FAULT (provider
 *          configuration fault, detail says why), CALL_CAP_REACHED (scope 'session' or 'rolling_24h'), NO_VERIFIED_DATA or
 *          BLOCKED (code REPLAY_BEFORE_MODEL_CUTOFF | MODEL_TRAINING_CUTOFF_UNKNOWN). Per-lens statuses: OK | INVALID_OUTPUT |
 *          REFUSED | ERROR, each with errorKind (null when OK). After a failure that would repeat for every lens
 *          (CONNECT, NETWORK, DISCONNECTED, SDK_MISSING, NO_CREDENTIALS) the remaining lenses are not called: they are
 *          reported as ERROR with errorKind NOT_RUN and assessment_id null, and no row is stored for them.
 *          "OK" means schema-, id- and coherence-valid; each result also carries a number cross-check (verification).
 */
export async function runLensAssessments(db, provider, opts = {}) {
  const { session_id = null, ds, asOf } = opts;
  const lenses = opts.lenses ?? [...LENSES];
  if (!Array.isArray(lenses) || !lenses.length || new Set(lenses).size !== lenses.length || lenses.some((l) => !LENSES.includes(l))) {
    throw new TypeError(`lenses must be a non-empty unique subset of ${LENSES.join(', ')}`);
  }
  // Per-lens providers (presets); the run-level `provider` covers any lens not listed.
  const lensProv = Object.fromEntries(lenses.map((l) => [l, opts.providers?.[l] ?? provider]));
  const usable = (p) => !!(p && p.kind !== 'none' && typeof p.complete === 'function');
  const unusableLens = lenses.find((l) => !usable(lensProv[l]));
  const cfg = provider?.config || {};
  // Per-provider timeout first (e.g. ollama.timeoutMs for a slow local model), then the global VECTOR_MODEL_TIMEOUT_MS.
  const timeoutFor = (p) => opts.timeoutMs ?? (Number.isInteger(p?.defaultTimeoutMs) && p.defaultTimeoutMs > 0 ? p.defaultTimeoutMs : undefined)
    ?? p?.config?.timeoutMs ?? envInt('VECTOR_MODEL_TIMEOUT_MS', 120_000);
  const maxTokens = opts.maxTokens ?? cfg.maxTokens ?? envInt('VECTOR_MODEL_MAX_TOKENS', 16_000);
  const cap = opts.maxCalls ?? cfg.maxCallsPerSession ?? envInt('VECTOR_MAX_MODEL_CALLS_PER_SESSION', 60);
  const graceMs = opts.timeoutGraceMs ?? 5_000; // outer guard in case a provider ignores its own timeout
  // A provider may allow itself more than timeoutMs (e.g. the Anthropic adapter scales with max_tokens); align with it.
  const callBudgetFor = (p) => (typeof p?.callBudgetMs === 'function' ? p.callBudgetMs(maxTokens, timeoutFor(p)) : timeoutFor(p));

  if (unusableLens !== undefined) {
    const unusable = lensProv[unusableLens];
    // A provider that reports FAULT (e.g. an unknown VECTOR_MODEL_PROVIDER) is a configuration fault, not a disconnect.
    let st = null;
    try { st = typeof unusable?.status === 'function' ? await unusable.status() : null; } catch { st = null; }
    if (st?.status === 'FAULT') {
      return { status: 'FAULT', note: 'ASSESSMENT_NOT_RUN', detail: String(st.detail ?? 'model provider fault').slice(0, 300), sym: opts.sym, asOf, results: [] };
    }
    return { status: 'MODEL_DISCONNECTED', note: 'MODEL DISCONNECTED / ASSESSMENT NOT RUN', sym: opts.sym, asOf, results: [] };
  }
  const realCtx = typeof opts.realAccountContext === 'string' && opts.realAccountContext ? opts.realAccountContext : null;
  if (realCtx) {
    const gate = realDataPrivacyCheck(lensProv, opts.env ?? process.env);
    if (!gate.ok) {
      return { status: 'BLOCKED', code: 'REAL_DATA_PRIVACY_BLOCK', note: 'ASSESSMENT_NOT_RUN', detail: 'real-account data is only sent to providers whose preset declares trains_on_prompts false', blocked: gate.blocked, sym: opts.sym, asOf, results: [] };
    }
  }
  const built = opts.packet ?? buildEvidencePacket(db, ds, opts.sym, asOf, { env: opts.env ?? process.env });
  if (built.status !== 'OK') return { status: built.status, note: 'ASSESSMENT_NOT_RUN', detail: built.detail, sym: built.sym, asOf, results: [] };
  const { sym, evidenceIds, sha256 } = built;
  // The REAL_ACCOUNT context is appended after the packet: it is not evidence (no id, not in the packet hash or store).
  const userMessage = realCtx ? `${built.userMessage}\n\n${realCtx}` : built.userMessage;
  if (opts.packet) {
    if (built.asOf !== asOf || built.ds !== ds || built.sym !== String(opts.sym ?? '').trim().toUpperCase()) {
      throw new Error('supplied packet does not match the requested ds/sym/asOf');
    }
    // A preview packet (persist:false) must be stored before assessments reference its ids; inserts are idempotent.
    for (const it of built.packet.items) {
      if (insertEvidence(db, it).id !== it.id) throw new Error(`packet evidence id mismatch for ${it.kind}`);
    }
  }

  // Hindsight guard (before any call or cap reservation).
  const tradeDate = built.packet.meta.trade_date;
  const hsByLens = {};
  for (const l of lenses) {
    const lp = lensProv[l];
    const hs = hindsightCheck(lp, tradeDate);
    hsByLens[l] = hs.risk
      ? { hindsight_risk: true, code: hs.code, model_training_cutoff: hs.trainingCutoff, cutoff_source: hs.source, margin_days: hs.marginDays, trade_date: tradeDate }
      : null;
    if (!hs.ok) {
      journalAppend(db, {
        session_id, ts_sim: asOf, actor: 'system', type: 'MODEL_CALL_BLOCKED', ref_id: null,
        payload: { sym, lens: l, code: hs.code, model: lp.model ?? null, preset: lp.preset?.id ?? null, trade_date: tradeDate, training_cutoff: hs.trainingCutoff, cutoff_source: hs.source, margin_days: hs.marginDays, detail: hs.detail },
      });
      return { status: 'BLOCKED', code: hs.code, note: 'ASSESSMENT_NOT_RUN', detail: hs.detail, lens: l, sym, asOf, trade_date: tradeDate, training_cutoff: hs.trainingCutoff, results: [] };
    }
  }
  const hindsight = hsByLens[lenses[0]] ?? null;

  // Preset local limits (config/model-presets.json): all-or-nothing, like the call caps.
  const needByPreset = new Map();
  for (const l of lenses) {
    const lp = lensProv[l];
    if (typeof lp.localBudget === 'function') needByPreset.set(lp.id, { p: lp, n: (needByPreset.get(lp.id)?.n ?? 0) + 1 });
  }
  for (const { p, n } of needByPreset.values()) {
    const b = p.localBudget();
    if (b.perMinute.remaining < n || b.perDay.remaining < n) {
      const scope = b.perMinute.remaining < n ? 'preset_per_minute' : 'preset_per_day';
      const lim = scope === 'preset_per_minute' ? b.perMinute : b.perDay;
      journalAppend(db, { session_id, ts_sim: asOf, actor: 'system', type: 'MODEL_CALL_CAP_REACHED', ref_id: null, payload: { sym, scope, preset: p.preset?.id ?? p.id, cap: lim.cap, used: lim.used, requested: n } });
      return {
        status: 'CALL_CAP_REACHED', scope, note: 'ASSESSMENT_NOT_RUN', cap: lim.cap, used: lim.used, sym, asOf, results: [],
        detail: `preset ${p.preset?.id ?? p.id} local limit: ${lim.used}/${lim.cap} requests ${scope === 'preset_per_minute' ? 'in the last minute' : 'in the last 24 h'} (config/model-presets.json)`,
      };
    }
  }

  // Call caps: all-or-nothing so the lenses are always compared on the same packet. Reservations cover concurrent runs.
  const key = sessionKey(session_id);
  const used = callsUsed(db, session_id) + (inflight.get(key) || 0);
  if (used + lenses.length > cap) {
    journalAppend(db, { session_id, ts_sim: asOf, actor: 'system', type: 'MODEL_CALL_CAP_REACHED', ref_id: null, payload: { sym, scope: 'session', cap, used, requested: lenses.length } });
    return { status: 'CALL_CAP_REACHED', scope: 'session', note: 'ASSESSMENT_NOT_RUN', cap, used, sym, asOf, results: [] };
  }
  const day = modelCallBudget(db, provider, { maxCallsPerDay: opts.maxCallsPerDay });
  if (day.used + day.inflight + lenses.length > day.cap) {
    const dayUsed = day.used + day.inflight;
    journalAppend(db, { session_id, ts_sim: asOf, actor: 'system', type: 'MODEL_CALL_CAP_REACHED', ref_id: null, payload: { sym, scope: 'rolling_24h', cap: day.cap, used: dayUsed, requested: lenses.length } });
    return {
      status: 'CALL_CAP_REACHED', scope: 'rolling_24h', note: 'ASSESSMENT_NOT_RUN', cap: day.cap, used: dayUsed, sym, asOf, results: [],
      detail: `global model-call budget reached: ${dayUsed}/${day.cap} calls in the last 24 h across all sessions (VECTOR_MAX_MODEL_CALLS_PER_DAY)`,
    };
  }
  inflight.set(key, (inflight.get(key) || 0) + lenses.length);

  const segment = opts.segment ?? (largeCapList().includes(sym) ? 'large' : 'micro');
  const quoteItem = built.packet.items.find((it) => it.kind === 'market_quote');
  const quote = quoteItem ? { bid_usd: quoteItem.body.bid_usd ?? null, ask_usd: quoteItem.body.ask_usd ?? null } : null;
  const results = [];
  const stopKinds = new Map(); // provider id -> error kind, after a failure that would repeat for that provider's remaining lenses
  // Bounded repair: a lens whose output fails validation (INVALID_OUTPUT) is re-asked at most `repairAttempts` times with
  // ONLY its own validator errors appended. The rejected attempt stays stored as an INVALID_OUTPUT audit row; a repair is
  // a real call and counts against both caps (it is skipped when no budget is left). Lenses stay independent.
  const repairAttempts = repairAttemptsFor(opts, cfg);
  let lensesStarted = 0;
  const repairBudgetOk = () => {
    const unrun = lenses.length - lensesStarted;               // reserved calls of this run not yet made
    const others = (inflight.get(key) || 0) - lenses.length;    // reservations of concurrent runs in this session
    if (callsUsed(db, session_id) + others + unrun + 1 > cap) return false;
    const d = modelCallBudget(db, provider, { maxCallsPerDay: opts.maxCallsPerDay });
    return d.used + (d.inflight - lenses.length) + unrun + 1 <= d.cap;
  };
  try {
    for (const lens of lenses) {
      const lp = lensProv[lens];
      const lpId = lp.id || lp.kind;
      const lensHindsight = hsByLens[lens] ?? null;
      const stopKind = stopKinds.get(lpId) ?? null;
      if (stopKind) {
        results.push({
          lens, assessment_id: null, status: 'ERROR', errorKind: 'NOT_RUN', output: null, refusal: null,
          error: `NOT_RUN: not called after a ${stopKind} failure earlier in this run (the endpoint was unreachable or the connection failed; the next call would fail the same way)`,
          intent: { status: 'NONE', intent: null, errors: [] }, model: lp.model || 'unknown', requestedModel: lp.model || 'unknown',
          rawExcerpt: null, fallbackUsed: false, latencyMs: null, usage: null, verification: null, hindsight: lensHindsight, preset: lp.preset?.id ?? null,
        });
        continue;
      }
      lensesStarted++;
      // Each call is built from the packet and this lens's system prompt only - never from another lens's output.
      const system = systemPromptFor(lens);
      let attempt = 0;
      let repairOf = null;
      let firstError = null;
      let user = userMessage;
      for (;;) {
      let res;
      try {
        res = await withTimeout(lp.complete({ system, user, schema: LENS_OUTPUT_SCHEMA, schemaName: LENS_SCHEMA_NAME, maxTokens, timeoutMs: timeoutFor(lp) }), callBudgetFor(lp) + graceMs);
      } catch (e) {
        res = { ok: false, refusal: null, error: e?.code === 'VECTOR_TIMEOUT' ? e.message : `provider threw: ${String(e?.message ?? e).slice(0, 300)}`, errorKind: e?.code === 'VECTOR_TIMEOUT' ? 'TIMEOUT' : 'PROVIDER_EXCEPTION', usage: {}, latencyMs: null };
      }
      const c = classify(res || {}, lens, evidenceIds, quote);
      // Real holdings never feed paper-account logic: a run with REAL_ACCOUNT context derives no intent draft.
      const intent = c.status === 'OK' && !realCtx
        ? intentFor(c.output, { lens, segment, sym, asOf, quoteTs: quoteItem?.event_ts ?? null })
        : { status: 'NONE', intent: null, errors: [] };
      // "OK" is schema/id/coherence-valid, not fact-checked: record which numbers in the text match no packet value.
      const verification = c.status === 'OK' ? crossCheckNumbers(c.output, built.packet) : null;
      const id = newId('asmt');
      // For non-OK outcomes keep a bounded excerpt of what the model actually returned (audit evidence, never shown as OK).
      const rawExcerpt = c.status !== 'OK' && typeof res?.rawText === 'string' && res.rawText ? res.rawText.slice(0, 4000) : null;
      const requestedModel = lp.model || 'unknown';
      const model = res?.servedModel || requestedModel;
      const fallbackUsed = !!res?.fallbackUsed;
      const errorKind = c.status === 'OK' ? null : c.status === 'REFUSED' ? 'REFUSAL' : (res?.errorKind ?? (c.status === 'INVALID_OUTPUT' ? 'INVALID_OUTPUT' : 'ERROR'));
      if (c.status === 'ERROR' && SHORT_CIRCUIT_ERROR_KINDS.includes(errorKind)) stopKinds.set(lpId, errorKind);
      // REAL_ACCOUNT context: the model's text may restate the owner's holdings, so none of it is stored (output, error
      // text, raw excerpt, number cross-check); the row keeps status, timing and the flag for the caps and the audit. The
      // full result is returned only to the loopback caller of this run.
      const storedError = realCtx && c.error ? `${errorKind ?? 'ERROR'}: (withheld: real-account context)` : c.error;
      db.prepare(`INSERT INTO assessments (id, session_id, sym, lens, provider, model, as_of, created_wall, evidence_ids_json, packet_sha256,
          status, output_json, error, latency_ms, tokens_in, tokens_out, real_ctx) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(id, session_id, sym, lens, lpId, model, asOf, Date.now(), JSON.stringify(evidenceIds), sha256,
          c.status, c.output && !realCtx ? JSON.stringify(c.output) : null, storedError, Number.isFinite(res?.latencyMs) ? Math.round(res.latencyMs) : null,
          Number.isFinite(res?.usage?.in) ? res.usage.in : null, Number.isFinite(res?.usage?.out) ? res.usage.out : null, realCtx ? 1 : 0);
      journalAppend(db, {
        session_id, ts_sim: asOf, actor: 'model', type: 'MODEL_ASSESSMENT', ref_id: id,
        payload: {
          sym, lens, status: c.status, provider: lpId, preset: lp.preset?.id ?? null, model, requested_model: requestedModel, served_model: res?.servedModel ?? null,
          real_account_context: !!realCtx,
          fallback_used: fallbackUsed, packet_sha256: sha256, packet_version: PACKET_VERSION, error_kind: errorKind,
          stance: c.output?.stance ?? null, error: storedError, raw_excerpt: realCtx ? null : rawExcerpt, intent_status: intent.status, intent_draft: intent.intent, intent_errors: intent.errors,
          verification: realCtx ? null : verification, hindsight: lensHindsight, attempt, repair_of: repairOf,
        },
      });
      if (c.status === 'INVALID_OUTPUT' && attempt < repairAttempts && repairBudgetOk()) {
        if (firstError === null) firstError = c.error;
        repairOf = id;
        attempt++;
        user = repairMessage(userMessage, c.error, res?.rawText);
        continue;
      }
      results.push({
        lens, assessment_id: id, status: c.status, errorKind, output: c.output, error: c.error, refusal: res?.refusal ?? null,
        intent, model, requestedModel, rawExcerpt, fallbackUsed, latencyMs: res?.latencyMs ?? null, usage: res?.usage ?? null,
        verification, hindsight: lensHindsight, attempts: attempt + 1, repairOf, firstAttemptError: firstError, preset: lp.preset?.id ?? null,
      });
      break;
      }
    }
  } finally {
    const left = (inflight.get(key) || 0) - lenses.length;
    if (left > 0) inflight.set(key, left); else inflight.delete(key);
  }
  // Disagreement is preserved as-is: each lens's stance is reported separately; there is no average, vote or consensus.
  return {
    status: 'COMPLETED', sym, ds, asOf, session_id, packet_sha256: sha256, evidence_ids: evidenceIds,
    provider: provider?.id || provider?.kind || lensProv[lenses[0]].id, hindsight, realAccountContext: !!realCtx,
    providers: Object.fromEntries(lenses.map((l) => [l, { provider: lensProv[l].id || lensProv[l].kind, preset: lensProv[l].preset?.id ?? null, model: lensProv[l].model ?? null }])),
    stances: Object.fromEntries(results.map((r) => [r.lens, r.output?.stance ?? null])),
    results,
  };
}

/**
 * Audit fields recorded with each assessment in its MODEL_ASSESSMENT journal entry (the assessments table has no
 * columns for them): intent verdict, requested vs served model, fallback use, number cross-check, hindsight stamp.
 */
function auditFor(db, rows) {
  const out = new Map();
  const bySession = new Map();
  for (const r of rows) {
    const k = r.session_id ?? null;
    if (!bySession.has(k)) bySession.set(k, new Set());
    bySession.get(k).add(r.id);
  }
  for (const [sid, ids] of bySession) {
    const q = sid === null
      ? db.prepare("SELECT ref_id, payload_json FROM journal WHERE session_id IS NULL AND type = 'MODEL_ASSESSMENT'").all()
      : db.prepare("SELECT ref_id, payload_json FROM journal WHERE session_id = ? AND type = 'MODEL_ASSESSMENT'").all(sid);
    for (const j of q) {
      if (!ids.has(j.ref_id)) continue;
      let p;
      try { p = JSON.parse(j.payload_json); } catch { continue; }
      out.set(j.ref_id, {
        intent_status: p.intent_status ?? null, intent_errors: p.intent_errors ?? [], intent_draft: p.intent_draft ?? null,
        requested_model: p.requested_model ?? null, served_model: p.served_model ?? p.model ?? null, fallback_used: p.fallback_used ?? null,
        verification: p.verification ?? null, hindsight: p.hindsight ?? null, packet_version: p.packet_version ?? null,
        error_kind: p.error_kind ?? null,
      });
    }
  }
  return out;
}

/** Stored assessments for a symbol (newest first), with parsed output and audit fields. For /api/assessments. */
export function listAssessments(db, { sym, session_id = null, limit = 30 } = {}) {
  const where = ['sym = ?', 'real_ctx = 0']; // REAL_ACCOUNT-context runs are never listed in paper views
  const args = [sym];
  if (session_id) { where.push('session_id = ?'); args.push(session_id); }
  args.push(Math.min(Math.max(1, limit | 0), 300));
  const rows = db.prepare(`SELECT * FROM assessments WHERE ${where.join(' AND ')} ORDER BY created_wall DESC, id DESC LIMIT ?`).all(...args);
  const audit = auditFor(db, rows);
  return rows.map((r) => ({
    ...r,
    evidence_ids: JSON.parse(r.evidence_ids_json),
    output: r.output_json ? JSON.parse(r.output_json) : null,
    audit: audit.get(r.id) ?? null,
    evidence_ids_json: undefined, output_json: undefined,
  }));
}
