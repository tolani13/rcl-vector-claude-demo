// As-of market data access. THE ONLY READ PATH for market observations used by agents, assessments and
// as-of UI views. Invariant: a minute row for [t, t+60s) becomes knowable at t + 60s, so every function
// that takes `asOf` returns only rows with t + MINUTE <= asOf. Status events are knowable at their exchange ts.
//
// Two further as-of guards live here so that no caller can bypass them:
//  * Stored-universe visibility. IEX ingestion keeps a symbol for the WHOLE day when it was observed below
//    STORAGE_MAX_PRICE_U at any time (plus the large-cap / benchmark lists), so merely having data would reveal that a
//    $5-6 name will trade below $5 later. A stored symbol becomes visible only once its first sub-threshold
//    observation lies in a completed minute (see storedVisibleFrom); before that, barsAsOf / quoteAsOf / lastTradeAsOf /
//    closeAtOrBefore / statusAsOf answer exactly as for a symbol that was never stored. universeAsOf and
//    windowAggregatesAsOf are not gated per symbol: universe membership (latest as-of price below the tier) already
//    implies visibility, and callers must restrict aggregates to universe symbols.
//  * Partial (truncated) datasets. Market state after the dataset's coverage end was never observed: quotes are not
//    carried past it and fill minutes after it are unavailable (see coverageEndMs).
//  * Trade breaks. A break in the same minute as its trade is removed at ingest. A later break is a status event
//    applied from its break time on: fillMinute withholds that minute's trade extremes once the break is knowable, and
//    windowAggregatesAsOf subtracts the broken volume (see tradeBreaksAsOf).
//
// Retrospective (hindsight) reads live in server/research/retrospective.js and are labelled as such.
import { MINUTE, etToUtc } from '../util/time.js';
import { PRICE_TIERS, largeCapList, BENCHMARKS, STORAGE_MAX_PRICE_U } from './universe.js';
import { macroKnowableTs, macroReleaseRule, vintageStatus } from './macroCalendar.js';

function assertAsOf(asOf) {
  if (!Number.isFinite(asOf)) throw new TypeError('asOf (ms UTC) is required for market data access');
}

// Prepared-statement cache for the hot per-symbol guard queries.
const stmtCache = new WeakMap();
function stmt(db, sql) {
  let m = stmtCache.get(db);
  if (!m) { m = new Map(); stmtCache.set(db, m); }
  let s = m.get(sql);
  if (!s) { s = db.prepare(sql); m.set(sql, s); }
  return s;
}

const coverageCache = new Map();
/** Coverage end (ms UTC, a minute boundary) of a PARTIAL dataset. */
function partialCoverageEnd(db, ds, d) {
  const key = `${ds}|${d.ingested_at}`;
  if (coverageCache.has(key)) return coverageCache.get(key);
  let q = null;
  try { q = JSON.parse(stmt(db, 'SELECT quality_json FROM datasets WHERE id = ?').get(ds)?.quality_json || 'null'); } catch { q = null; }
  let end;
  if (Number.isFinite(q?.coverage_end_ms)) end = q.coverage_end_ms;
  // Legacy partial datasets: the minute containing the last received segment was cut part-way through.
  else if (Number.isFinite(q?.last_send_ms)) end = Math.floor(q.last_send_ms / MINUTE) * MINUTE;
  else if (Number.isFinite(d.event_time_end)) end = d.event_time_end - MINUTE;
  else end = -Infinity;
  if (coverageCache.size > 64) coverageCache.clear();
  coverageCache.set(key, end);
  return end;
}

function dsInfo(db, ds) {
  const d = stmt(db, 'SELECT kind, status, ingested_at, event_time_end FROM datasets WHERE id = ?').get(ds);
  if (!d) return { kind: null, status: null, coverageEnd: null };
  return { kind: d.kind, status: d.status, coverageEnd: d.kind === 'market_ticks' && d.status === 'partial' ? partialCoverageEnd(db, ds, d) : null };
}

/**
 * For a PARTIAL (truncated) market dataset: the end of the last fully observed minute (ms UTC). Market state after it
 * was never observed. null for complete datasets.
 */
export function coverageEndMs(db, ds) {
  return dsInfo(db, ds).coverageEnd;
}

/** Datasets that can be replayed (market ticks), newest first. Partial datasets carry complete:false + coverage_end. */
export function listMarketDatasets(db) {
  return db.prepare(`SELECT id, provider, venue_coverage, entitlement, source_url, trade_date, event_time_start, event_time_end,
      published_at, ingested_at, sha256, bytes, expected_bytes, status, attribution, quality_json
    FROM datasets WHERE kind = 'market_ticks' AND status IN ('complete', 'partial') ORDER BY trade_date DESC`).all()
    .map((d) => ({
      ...d, quality: d.quality_json ? JSON.parse(d.quality_json) : null, quality_json: undefined,
      complete: d.status === 'complete', coverage_end: d.status === 'partial' ? coverageEndMs(db, d.id) : null,
    }));
}

export function getDataset(db, ds) {
  const d = db.prepare('SELECT * FROM datasets WHERE id = ?').get(ds);
  if (!d) return null;
  return { ...d, quality: d.quality_json ? JSON.parse(d.quality_json) : null, quality_json: undefined };
}

/** Regular-session replay window for a market dataset (09:30–16:00 ET on its trade date). */
export function sessionWindow(db, ds) {
  const d = getDataset(db, ds);
  if (!d || !d.trade_date) return null;
  return { open: etToUtc(d.trade_date, 9, 30), close: etToUtc(d.trade_date, 16, 0), tradeDate: d.trade_date };
}

/**
 * End of the replay of a market dataset (ms UTC): the 16:00 ET close, or — for a PARTIAL dataset — its coverage end
 * aligned down to a whole replay minute when that is earlier (the open when the coverage end is unknown or at/before the
 * open: no session minute was observed). Same rule as replay/engine.js replayWindow / getState. null without a window.
 */
export function replayEndMs(db, ds) {
  const win = sessionWindow(db, ds);
  if (!win) return null;
  const info = dsInfo(db, ds);
  if (info.kind !== 'market_ticks' || info.status !== 'partial') return win.close;
  const cov = info.coverageEnd;
  if (!Number.isFinite(cov)) return win.open;
  const aligned = win.open + Math.floor((cov - win.open) / MINUTE) * MINUTE;
  return Math.max(win.open, Math.min(win.close, aligned));
}

/** sessionWindow plus the replay end (`close` capped at replayEndMs; `sessionClose` keeps 16:00 ET), or null. */
export function replayWindowOf(db, ds) {
  const win = sessionWindow(db, ds);
  if (!win) return null;
  const end = replayEndMs(db, ds) ?? win.close;
  return { ...win, close: Math.min(win.close, end), sessionClose: win.close, truncated: end < win.close };
}

// ---- stored-universe visibility ---------------------------------------------------------------------------------

export const NOT_IN_STORED_UNIVERSE_NOTE = 'NOT_IN_STORED_UNIVERSE_AS_OF: IEX data is retained only for symbols observed below '
  + `$${STORAGE_MAX_PRICE_U / 1e4} by the replay clock, plus the configured large-cap and benchmark reference lists.`;

/**
 * Minute start (ms UTC) from which a stored symbol may be revealed, 0 for reference-list symbols and non-market
 * datasets (CSV imports are explicit user selections), or null when no qualifying observation exists.
 * Qualifying = first minute with an IEX trade low below the storage threshold, or a two-sided end-of-minute IEX
 * midpoint below it. This is a subset of the ingest rule (which also sees intra-minute quote midpoints), so it is never
 * earlier than the first sub-threshold observation that caused the symbol to be stored.
 */
export function storedVisibleFrom(db, ds, sym, info = dsInfo(db, ds)) {
  if (info.kind && info.kind !== 'market_ticks') return 0;
  if (BENCHMARKS.includes(sym) || largeCapList().includes(sym)) return 0;
  const r = stmt(db, 'SELECT t FROM m1 WHERE ds = ? AND sym = ? AND (l < ? OR (bid > 0 AND ask >= bid AND bid + ask < ?)) ORDER BY t LIMIT 1')
    .get(ds, sym, STORAGE_MAX_PRICE_U, 2 * STORAGE_MAX_PRICE_U - 1);
  return r ? r.t : null;
}

/** True when sym's stored data may be revealed at asOf (its first qualifying minute is complete). */
export function symbolVisibleAsOf(db, ds, sym, asOf, info = dsInfo(db, ds)) {
  assertAsOf(asOf);
  const from = storedVisibleFrom(db, ds, sym, info);
  return from !== null && from + MINUTE <= asOf;
}

/** Upper bound (inclusive) for minute starts readable at asOf, honouring a partial dataset's coverage end. */
function lastMinuteStart(asOf, info) {
  return Math.min(asOf, info.coverageEnd ?? Infinity) - MINUTE;
}

const ROW_COLS = 'sym, t, o, h, l, c, v, n, pv, bv, sv, xv, ev, ov, bid, ask, bsz, asz, qts, min_bid, max_bid, min_ask, max_ask, max_spr, nq, unavail, halted, qsess';

/** Completed minute rows for sym with from <= t and t + 60s <= asOf, ascending. [] when sym is not visible at asOf. */
export function barsAsOf(db, ds, sym, asOf, { from = null, limit = 2000 } = {}) {
  assertAsOf(asOf);
  const info = dsInfo(db, ds);
  if (!symbolVisibleAsOf(db, ds, sym, asOf, info)) return [];
  const lo = from ?? 0;
  return db.prepare(`SELECT ${ROW_COLS} FROM m1 WHERE ds = ? AND sym = ? AND t >= ? AND t <= ? ORDER BY t ASC LIMIT ?`)
    .all(ds, sym, lo, lastMinuteStart(asOf, info), limit);
}

const UNKNOWN_STATUS = Object.freeze({ tradingStatus: null, tradingStatusTs: null, reason: null, operationalHalt: false, halted: false, known: false });

/** Latest halt/trading status for sym as of asOf (from exchange status events). */
export function statusAsOf(db, ds, sym, asOf, info = dsInfo(db, ds)) {
  assertAsOf(asOf);
  if (!symbolVisibleAsOf(db, ds, sym, asOf, info)) return { ...UNKNOWN_STATUS };
  const ts = stmt(db, `SELECT ts, code, reason FROM status_events WHERE ds = ? AND sym = ? AND kind = 'trading_status' AND ts <= ? ORDER BY ts DESC LIMIT 1`).get(ds, sym, asOf);
  const op = stmt(db, `SELECT ts, code FROM status_events WHERE ds = ? AND sym = ? AND kind = 'operational_halt' AND ts <= ? ORDER BY ts DESC LIMIT 1`).get(ds, sym, asOf);
  const tradingStatus = ts ? ts.code : null;     // T trading, H halted, P paused, O order acceptance period
  const opHalted = op ? op.code === 'O' : false;
  return {
    tradingStatus, tradingStatusTs: ts ? ts.ts : null, reason: ts ? ts.reason : null,
    operationalHalt: opHalted,
    halted: opHalted || (tradingStatus !== null && tradingStatus !== 'T'),
    known: !!ts,
  };
}

/**
 * Prevailing IEX top-of-book at asOf (end state of the latest completed minute row).
 * Returns null if no quote has been observed yet, if sym is not visible at asOf, or if asOf is past a partial
 * dataset's coverage end (the market state after the truncation was never observed).
 */
export function quoteAsOf(db, ds, sym, asOf) {
  assertAsOf(asOf);
  const info = dsInfo(db, ds);
  if (info.coverageEnd !== null && asOf > info.coverageEnd) return null;
  if (!symbolVisibleAsOf(db, ds, sym, asOf, info)) return null;
  const r = stmt(db, `SELECT t, bid, ask, bsz, asz, qts, unavail, halted, qsess FROM m1
    WHERE ds = ? AND sym = ? AND t <= ? AND qts IS NOT NULL ORDER BY t DESC LIMIT 1`).get(ds, sym, asOf - MINUTE);
  if (!r) return null;
  const st = statusAsOf(db, ds, sym, asOf, info);
  const twoSided = (r.bid ?? 0) > 0 && (r.ask ?? 0) > 0 && r.ask >= r.bid;
  return {
    sym, bid: r.bid || null, ask: r.ask || null, bidSize: r.bsz || 0, askSize: r.asz || 0,
    quoteTs: r.qts, ageMs: asOf - r.qts, twoSided,
    spreadU: twoSided ? r.ask - r.bid : null,
    spreadBps: twoSided ? Math.round(((r.ask - r.bid) / ((r.ask + r.bid) / 2)) * 10000) : null,
    mid: twoSided ? Math.round((r.ask + r.bid) / 2) : null,
    halted: st.halted, tradingStatus: st.tradingStatus, extendedSession: r.qsess === 1,
    source: { ds, venue: 'IEX', minuteRowT: r.t },
  };
}

/** Last IEX trade price at or before asOf (from completed minutes). null when sym is not visible at asOf. */
export function lastTradeAsOf(db, ds, sym, asOf) {
  assertAsOf(asOf);
  const info = dsInfo(db, ds);
  if (!symbolVisibleAsOf(db, ds, sym, asOf, info)) return null;
  const r = stmt(db, 'SELECT t, c FROM m1 WHERE ds = ? AND sym = ? AND t <= ? AND c IS NOT NULL ORDER BY t DESC LIMIT 1')
    .get(ds, sym, lastMinuteStart(asOf, info));
  return r ? { priceU: r.c, minuteT: r.t, knowableAt: r.t + MINUTE } : null;
}

/** Unapplied trade breaks for trades in minute t of sym, knowable at clock (break ts <= clock). */
function knowableBreaksForMinute(db, ds, sym, t, clock) {
  return stmt(db, `SELECT ts, code, reason FROM status_events WHERE ds = ? AND sym = ? AND kind = 'trade_break' AND ts <= ? ORDER BY ts`)
    .all(ds, sym, clock)
    .map((e) => { let r = {}; try { r = JSON.parse(e.reason || '{}'); } catch { r = {}; } return { ts: e.ts, tradeId: e.code, ...r }; })
    .filter((b) => b.applied !== true && b.trade_minute === t);
}

/**
 * Data for the fill engine to evaluate working orders during minute [t, t+60s). Must only be called once that
 * minute has completed (t + 60s <= clock). Carries quote state forward when the symbol had no messages — except past a
 * partial dataset's coverage end, where the minute is reported unavailable (nothing observed, so no carried quote).
 * When a later IEX trade break for a trade in this minute is already knowable at clock, the minute's trade aggregates
 * (h/l/v, used for stop triggers and trade-through fills) still contain the broken print and cannot be corrected, so
 * `trades` is withheld (null, tradesWithheld 'TRADE_BREAK') and only quote evidence remains.
 */
export function fillMinute(db, ds, sym, t, clock) {
  assertAsOf(clock);
  if (t + MINUTE > clock) throw new Error(`look-ahead blocked: minute ${t} not complete at clock ${clock}`);
  const info = dsInfo(db, ds);
  const row = db.prepare(`SELECT ${ROW_COLS} FROM m1 WHERE ds = ? AND sym = ? AND t = ?`).get(ds, sym, t);
  const prev = db.prepare(`SELECT bid, ask, bsz, asz, qts FROM m1 WHERE ds = ? AND sym = ? AND t < ? AND qts IS NOT NULL ORDER BY t DESC LIMIT 1`).get(ds, sym, t);
  const startQuote = prev ? { bid: prev.bid || null, ask: prev.ask || null, bidSize: prev.bsz || 0, askSize: prev.asz || 0, quoteTs: prev.qts } : null;
  const st = statusAsOf(db, ds, sym, t + MINUTE - 1, info);
  if (info.coverageEnd !== null && t + MINUTE > info.coverageEnd) {
    return {
      sym, t, hasRow: false, trades: null, startQuote, endQuote: null,
      minBid: null, maxBid: null, minAsk: null, maxAsk: null,
      halted: st.halted, unavailable: true, coverageEnd: info.coverageEnd,
      note: 'DATASET_TRUNCATED: minute is after the partial dataset coverage end; market state was not observed',
    };
  }
  if (!row) {
    const two = startQuote && startQuote.bid > 0 && startQuote.ask > 0;
    return {
      sym, t, hasRow: false, trades: null, startQuote, endQuote: startQuote,
      minBid: two ? startQuote.bid : null, maxBid: two ? startQuote.bid : null,
      minAsk: two ? startQuote.ask : null, maxAsk: two ? startQuote.ask : null,
      halted: st.halted, unavailable: false,
    };
  }
  const breaks = row.n > 0 ? knowableBreaksForMinute(db, ds, sym, t, clock) : [];
  return {
    sym, t, hasRow: true,
    trades: row.n > 0 && !breaks.length ? { o: row.o, h: row.h, l: row.l, c: row.c, v: row.v, n: row.n, vwap: row.v ? Math.round(row.pv / row.v) : null } : null,
    ...(breaks.length ? { tradesWithheld: 'TRADE_BREAK', tradeBreaks: breaks.map((b) => ({ ts: b.ts, tradeId: b.tradeId, priceU: b.px ?? null, size: b.size ?? null })) } : {}),
    startQuote,
    endQuote: row.qts != null ? { bid: row.bid || null, ask: row.ask || null, bidSize: row.bsz || 0, askSize: row.asz || 0, quoteTs: row.qts } : startQuote,
    minBid: row.min_bid, maxBid: row.max_bid, minAsk: row.min_ask, maxAsk: row.max_ask,
    halted: row.halted === 1 || st.halted, unavailable: row.unavail === 1,
  };
}

/**
 * IEX trade-break events for sym knowable at asOf (exchange ts <= asOf), oldest first. Each names the broken trade's
 * id, price/size and (when known) the minute whose stored aggregates still include it. A break inside the same minute
 * as its trade is already removed from that minute's aggregates at ingest (appliedToMinute true); others are NOT, and
 * consumers (e.g. trade-through fill evidence) must ignore that minute's trade extremes from the break time on.
 * Datasets ingested before break recording show only a count (datasets.quality.trade_breaks_seen_not_applied).
 */
export function tradeBreaksAsOf(db, ds, sym, asOf, { from = 0 } = {}) {
  assertAsOf(asOf);
  if (!symbolVisibleAsOf(db, ds, sym, asOf)) return [];
  return db.prepare(`SELECT ts, code, reason FROM status_events WHERE ds = ? AND sym = ? AND kind = 'trade_break' AND ts >= ? AND ts <= ? ORDER BY ts ASC LIMIT 1000`)
    .all(ds, sym, from, asOf)
    .map((e) => {
      let r = {};
      try { r = JSON.parse(e.reason || '{}'); } catch { r = {}; }
      return { ts: e.ts, tradeId: e.code, priceU: r.px ?? null, size: r.size ?? null, tradeMinuteT: r.trade_minute ?? null, appliedToMinute: r.applied === true };
    });
}

/**
 * As-of universe for a segment. micro => symbols whose latest observed IEX trade price (as-of) is below the
 * penny tier; large => configured large-cap reference list (stored symbols only). Returns [{sym, priceU, minuteT}].
 */
export function universeAsOf(db, ds, asOf, segment) {
  assertAsOf(asOf);
  const cutoff = lastMinuteStart(asOf, dsInfo(db, ds));
  const latest = db.prepare(`SELECT m.sym, m.c, m.t FROM m1 m JOIN (
      SELECT sym, MAX(t) mt FROM m1 WHERE ds = ? AND t <= ? AND c IS NOT NULL GROUP BY sym
    ) x ON x.sym = m.sym AND x.mt = m.t WHERE m.ds = ?`).all(ds, cutoff, ds);
  if (segment === 'large') {
    const set = new Set(largeCapList());
    return latest.filter((r) => set.has(r.sym)).map((r) => ({ sym: r.sym, priceU: r.c, minuteT: r.t }));
  }
  const max = segment === 'low' ? PRICE_TIERS.low.maxPriceU : PRICE_TIERS.penny.maxPriceU;
  const excluded = new Set([...largeCapList(), ...BENCHMARKS]);
  return latest.filter((r) => r.c < max && !excluded.has(r.sym)).map((r) => ({ sym: r.sym, priceU: r.c, minuteT: r.t }));
}

/**
 * Window aggregates for many symbols at once (for scanning), using only completed minutes:
 *   window [asOf - windowMin, asOf) and session-to-date [sessionOpen, asOf).
 * Not gated per symbol: restrict the result to universeAsOf symbols (which are visible by construction).
 * Volumes and trade counts exclude trades whose (later-minute) IEX break is knowable at asOf; window high/low cannot
 * be corrected for such a break and are reported as stored (brokenTrades counts the corrections).
 */
export function windowAggregatesAsOf(db, ds, asOf, { windowMin = 15, sessionOpen, syms = null } = {}) {
  assertAsOf(asOf);
  const cutoff = lastMinuteStart(asOf, dsInfo(db, ds));
  const wStart = asOf - windowMin * MINUTE;
  const rows = db.prepare(`SELECT sym,
      SUM(CASE WHEN t >= ? THEN v ELSE 0 END) wv,
      SUM(CASE WHEN t >= ? THEN bv ELSE 0 END) wbv,
      SUM(CASE WHEN t >= ? THEN sv ELSE 0 END) wsv,
      SUM(CASE WHEN t >= ? THEN n ELSE 0 END) wn,
      SUM(v) sv_total, SUM(n) sn_total,
      COUNT(DISTINCT CASE WHEN n > 0 THEN t END) active_minutes,
      MAX(CASE WHEN t >= ? THEN h END) wh, MIN(CASE WHEN t >= ? THEN l END) wl
    FROM m1 WHERE ds = ? AND +t >= ? AND +t <= ? GROUP BY sym`).all(wStart, wStart, wStart, wStart, wStart, wStart, ds, sessionOpen, cutoff);
  // `+t` is a planner hint (results unchanged): scan the (ds, sym, t) primary key instead of the m1_ds_t index with a
  // per-row lookup into the WITHOUT ROWID table; measured on a full IEX day at 15:45 ET: ~1170 ms -> ~95 ms.
  const filter = syms ? new Set(syms) : null;
  const out = rows.filter((r) => !filter || filter.has(r.sym));
  const breaks = db.prepare(`SELECT sym, reason FROM status_events WHERE ds = ? AND kind = 'trade_break' AND ts <= ?`).all(ds, asOf);
  if (breaks.length) {
    const bySym = new Map(out.map((r) => [r.sym, r]));
    for (const e of breaks) {
      const r = bySym.get(e.sym);
      if (!r) continue;
      let b = {};
      try { b = JSON.parse(e.reason || '{}'); } catch { b = {}; }
      const tm = b.trade_minute;
      const size = Number(b.size) || 0;
      if (b.applied === true || !Number.isFinite(tm) || tm < sessionOpen || tm > cutoff) continue;
      r.sv_total = Math.max(0, r.sv_total - size);
      r.sn_total = Math.max(0, r.sn_total - 1);
      if (tm >= wStart) {
        r.wv = Math.max(0, r.wv - size);
        r.wn = Math.max(0, r.wn - 1);
        if (b.cls === 'b') r.wbv = Math.max(0, r.wbv - size);
        else if (b.cls === 's') r.wsv = Math.max(0, r.wsv - size);
      }
      r.brokenTrades = (r.brokenTrades || 0) + 1;
    }
  }
  return out;
}

/** Price (last trade close) of the latest completed minute starting at or before tInclusive, as of asOf. */
export function closeAtOrBefore(db, ds, sym, tInclusive, asOf) {
  assertAsOf(asOf);
  const info = dsInfo(db, ds);
  if (!symbolVisibleAsOf(db, ds, sym, asOf, info)) return null;
  const bound = Math.min(tInclusive, lastMinuteStart(asOf, info));
  const r = stmt(db, 'SELECT t, c FROM m1 WHERE ds = ? AND sym = ? AND t <= ? AND c IS NOT NULL ORDER BY t DESC LIMIT 1').get(ds, sym, bound);
  return r ? { priceU: r.c, minuteT: r.t } : null;
}

// ---- relative volume (shared definition) ---------------------------------------------------------------------------

export const RELVOL_MIN_BASELINE_MIN = 15;
export const RELVOL_DEFINITION = 'relVol = (window volume / window minutes) / (volume of the regular-session minutes BEFORE the window / '
  + `number of those elapsed minutes); null when that baseline is shorter than ${RELVOL_MIN_BASELINE_MIN} minutes or has zero volume. IEX-only, same day.`;
// A baseline below this many IEX shares gives an unstable ratio. The shared value is still defined (see above); the
// scanner flags it THIN_BASELINE and leaves it out of its score, and agents treat it as unavailable
// (server/agents/strategies.js RELVOL_MIN_BASELINE_SHARES, same value). EXPLORATORY DEFAULT — NOT VALIDATED.
export const RELVOL_THIN_BASELINE_SHARES = 1000;

/** {relVol, flag}: relative volume per RELVOL_DEFINITION, or relVol null with the reason flag. */
export function relativeVolumeInfo({ windowVolume, windowMin, baselineVolume, baselineMin }) {
  if (!(windowMin > 0) || !Number.isFinite(windowVolume)) return { relVol: null, flag: 'NO_WINDOW' };
  if (!(baselineMin >= RELVOL_MIN_BASELINE_MIN)) return { relVol: null, flag: 'BASELINE_TOO_SHORT' };
  if (!(baselineVolume > 0)) return { relVol: null, flag: 'NO_BASELINE_VOLUME' };
  return { relVol: (windowVolume / windowMin) / (baselineVolume / baselineMin), flag: null };
}

/** Relative volume per RELVOL_DEFINITION, or null when the baseline is insufficient. */
export function relativeVolume(o) {
  return relativeVolumeInfo(o).relVol;
}

// ---- macro ----------------------------------------------------------------------------------------------------------

/**
 * Macro observations knowable as of asOf. Each observation carries knowable_ts from its series' release rule
 * (server/data/macroCalendar.js: weekly-released series are gated on their weekly release, not observation date + lag).
 * Revisable series whose stored latest vintage may include revisions published after asOf are withheld
 * (vintage.withheld true, observations [] and latest null), so they never reach as-of views or evidence packets.
 */
export function macroAsOf(db, asOf) {
  assertAsOf(asOf);
  const series = db.prepare('SELECT * FROM macro_series').all();
  const asOfDate = new Date(asOf).toISOString().slice(0, 10);
  return series.map((s) => {
    const lag = s.publication_lag_days ?? 1;
    const rule = macroReleaseRule(s.series, lag);
    const fetchedAt = db.prepare('SELECT ingested_at FROM datasets WHERE id = ?').get(s.ds)?.ingested_at ?? null;
    const vintage = vintageStatus(s.series, fetchedAt, asOf);
    // An observation is never knowable before its own date, so rows dated after asOf's date are skipped in SQL.
    const knowable = vintage.withheld ? [] : db.prepare('SELECT date, value FROM macro_obs WHERE series = ? AND value IS NOT NULL AND date <= ? ORDER BY date DESC LIMIT 400').all(s.series, asOfDate)
      .map((o) => ({ date: o.date, value: o.value, knowable_ts: macroKnowableTs(s.series, o.date, lag) }))
      .filter((o) => o.knowable_ts <= asOf);
    const obs = knowable.slice(0, 260).reverse();
    return {
      ...s, asOfDate, release_rule: rule.id, knowable_rule: rule.text, vintage,
      observations: obs, latest: obs.length ? obs[obs.length - 1] : null,
    };
  });
}
