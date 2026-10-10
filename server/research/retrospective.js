// RETROSPECTIVE signal / failure study over stored IEX replay data.
//
// RETROSPECTIVE — uses data after each signal; never visible to agents. This module is the designated hindsight
// reader (see server/data/marketdata.js header): it reads whole-day m1 rows directly to find signals and to measure
// what happened AFTER them. Nothing here may be exposed to agents, assessments or as-of views.
//
// Method (all prices are IEX trade prices; IEX is a fraction of consolidated volume):
//   * signal: first regular-session minute end E at which the W-minute IEX trade return >= threshold, with the whole
//     window inside the regular session and >= minTradesInWindow IEX trades in the window. Signal time E is the
//     knowable time (the minute row ending at E becomes visible at E).
//   * tier: by the reference price (last trade at or before window start) — PRICE_TIERS from universe.js.
//   * signal-time metrics use only minutes ending <= E; outcomes use minutes after E (hindsight).
//   * classification at the longest horizon (or the session close if beyond it): continued / stalled / reversed.
//   * matched comparisons: each continued event is paired with the nearest failed (stalled or reversed) event of
//     the same tier by standardised signal-time features.
//   * the handwritten $50 example rule set is replayed with the contract fill model (server/sim/fills.js
//     evaluateOrder on marketdata.fillMinute minutes) — estimated paper fills, never executions.
import { MINUTE, etToUtc, fmtEt } from '../util/time.js';
import { usdToU, roundToTick } from '../util/money.js';
import { PRICE_TIERS, largeCapList, BENCHMARKS, KNOWN_TEST_SYMBOLS } from '../data/universe.js';
import { getDataset, sessionWindow, fillMinute, quoteAsOf, relativeVolume, RELVOL_DEFINITION } from '../data/marketdata.js';
import { evaluateOrder, defaultCostModel, slippedPrice, FILL_MODEL_ID } from '../sim/fills.js';

export const RETRO_LABEL = 'RETROSPECTIVE — uses data after each signal; never visible to agents';
export const EXPLORATORY_LABEL = 'EXPLORATORY LOWER THRESHOLD — not the handwritten +22% rule; shown because the primary threshold produced too few events';

const DEFAULTS = Object.freeze({
  windowMin: 15, thresholdPct: 22, tier: 'penny', horizonMin: [15, 30, 60], minTradesInWindow: 2,
  continuePct: 5, reversePct: -5, minClassifiedShares: 1000,
  rule: { budgetUsd: 50, entryWindowMin: 5, tpMultipliers: [2.5, 3.5], timeExitMin: 15, timeExitBandPct: 10 },
});

const cache = new Map();

// ---------------------------------------------------------------------------------------------------------------
// Per-symbol dense minute arrays over 04:00–20:00 ET (hindsight: whole day loaded).

function buildSeries(rows, dayStart, N) {
  const close = new Float64Array(N).fill(NaN);
  const hi = new Float64Array(N).fill(NaN);
  const lo = new Float64Array(N).fill(NaN);
  const lastTradeIdx = new Int32Array(N).fill(-1);
  const bid = new Float64Array(N).fill(NaN);
  const ask = new Float64Array(N).fill(NaN);
  const qts = new Float64Array(N).fill(NaN);
  const cumV = new Float64Array(N + 1);
  const cumN = new Float64Array(N + 1);
  const cumBV = new Float64Array(N + 1);
  const cumSV = new Float64Array(N + 1);
  const rowHalted = new Uint8Array(N);
  const byIdx = new Array(N);
  for (const r of rows) {
    const i = (r.t - dayStart) / MINUTE;
    if (i >= 0 && i < N && Number.isInteger(i)) byIdx[i] = r;
  }
  let c = NaN; let lt = -1; let b = NaN; let a = NaN; let q = NaN;
  for (let i = 0; i < N; i++) {
    const r = byIdx[i];
    let v = 0; let n = 0; let bv = 0; let sv = 0;
    if (r) {
      if (r.n > 0 && r.c != null) { c = r.c; lt = i; hi[i] = r.h; lo[i] = r.l; }
      if (r.qts != null) { b = r.bid || NaN; a = r.ask || NaN; q = r.qts; }
      v = r.v; n = r.n; bv = r.bv; sv = r.sv;
      rowHalted[i] = r.halted || r.unavail ? 1 : 0;
    }
    close[i] = c; lastTradeIdx[i] = lt; bid[i] = b; ask[i] = a; qts[i] = q;
    cumV[i + 1] = cumV[i] + v; cumN[i + 1] = cumN[i] + n; cumBV[i + 1] = cumBV[i] + bv; cumSV[i + 1] = cumSV[i] + sv;
  }
  return { close, hi, lo, lastTradeIdx, bid, ask, qts, cumV, cumN, cumBV, cumSV, rowHalted };
}

function haltedAt(events, ts) {
  if (!events) return false;
  let tsCode = null; let op = false;
  for (const e of events) {
    if (e.ts > ts) break;
    if (e.kind === 'trading_status') tsCode = e.code;
    else if (e.kind === 'operational_halt') op = e.code === 'O';
  }
  return op || (tsCode !== null && tsCode !== 'T');
}

/** First qualifying signal for one symbol, with signal-time metrics and hindsight outcomes. */
function analyzeSymbol(sym, s, g, o, statusEvents) {
  const W = o.windowMin;
  const thr = o.thresholdPct / 100;
  const tierMax = PRICE_TIERS[o.tier].maxPriceU;
  for (let i = g.openIdx + W - 1; i < g.closeIdx; i++) {
    const ref = s.close[i - W];
    const cur = s.close[i];
    if (!(ref > 0) || !(cur > 0) || ref >= tierMax) continue;
    const tradesW = s.cumN[i + 1] - s.cumN[i + 1 - W];
    if (tradesW < o.minTradesInWindow) continue;
    const ret = cur / ref - 1;
    if (ret < thr) continue;

    // ---- signal-time metrics (minutes ending <= E only) ----
    const E = g.dayStart + (i + 1) * MINUTE;
    const mid = s.close[i - Math.floor(W / 2)];
    const volumeW = s.cumV[i + 1] - s.cumV[i + 1 - W];
    const bv = s.cumBV[i + 1] - s.cumBV[i + 1 - W];
    const sv = s.cumSV[i + 1] - s.cumSV[i + 1 - W];
    const baselineMin = i + 1 - W - g.openIdx;
    const baseVol = s.cumV[i + 1 - W] - s.cumV[g.openIdx];
    const relVol = relativeVolume({ windowVolume: volumeW, windowMin: W, baselineVolume: baseVol, baselineMin });
    const twoSided = s.bid[i] > 0 && s.ask[i] > 0 && s.ask[i] >= s.bid[i];
    const signal = {
      E, E_et: fmtEt(E), minutesSinceOpen: (E - g.open) / MINUTE,
      refPriceU: ref, refTradeMinuteT: s.lastTradeIdx[i - W] >= 0 ? g.dayStart + s.lastTradeIdx[i - W] * MINUTE : null,
      priceU: cur, ret_w: ret, accel: mid > 0 ? (cur / mid - 1) - (mid / ref - 1) : null,
      volumeW, tradesW, relVol,
      buyShare: bv + sv >= o.minClassifiedShares ? bv / (bv + sv) : null,
      classifiedShare: volumeW > 0 ? (bv + sv) / volumeW : null,
      bidU: twoSided ? s.bid[i] : null, askU: twoSided ? s.ask[i] : null,
      spreadBps: twoSided ? Math.round(((s.ask[i] - s.bid[i]) / ((s.ask[i] + s.bid[i]) / 2)) * 10000) : null,
      quoteAgeMs: Number.isFinite(s.qts[i]) ? E - s.qts[i] : null,
      halted: haltedAt(statusEvents, E) || s.rowHalted[i] === 1,
    };

    // ---- hindsight outcomes ----
    const last = g.closeIdx - 1;
    const horizons = {};
    for (const h of o.horizonMin) {
      const j = i + h;
      horizons[h] = j <= last
        ? { retPct: pct(s.close[j] / cur - 1), priceU: s.close[j], tradesInHorizon: s.cumN[j + 1] - s.cumN[i + 1] }
        : { retPct: null, note: 'BEYOND_SESSION_CLOSE' };
    }
    let maxH = -Infinity; let minL = Infinity; let tMax = null; let tMin = null;
    for (let k = i + 1; k <= last; k++) {
      if (s.hi[k] > maxH) { maxH = s.hi[k]; tMax = k; }
      if (s.lo[k] < minL) { minL = s.lo[k]; tMin = k; }
    }
    const tradesAfter = s.cumN[last + 1] - s.cumN[i + 1];
    const closeRet = s.close[last] / cur - 1;
    const hMax = Math.max(...o.horizonMin);
    const classRet = horizons[hMax].retPct ?? pct(closeRet);
    // Nothing observable after the signal (last session minute, or no IEX trades afterwards): not classifiable.
    const cls = i >= last ? 'no_session_after_signal' : tradesAfter === 0 ? 'no_trades_after_signal'
      : classRet >= o.continuePct ? 'continued' : classRet <= o.reversePct ? 'reversed' : 'stalled';
    return {
      sym, tier: o.tier, signal,
      outcome: {
        horizons, tradesAfter,
        mfePct: tradesAfter > 0 ? pct(maxH / cur - 1) : null, mfeAtEt: tMax !== null ? fmtEt(g.dayStart + (tMax + 1) * MINUTE) : null,
        maePct: tradesAfter > 0 ? pct(minL / cur - 1) : null, maeAtEt: tMin !== null ? fmtEt(g.dayStart + (tMin + 1) * MINUTE) : null,
        sessionCloseRetPct: pct(closeRet), sessionClosePriceU: s.close[last],
        classifiedOn: horizons[hMax].retPct !== null ? `${hMax}m` : 'session_close', classRetPct: classRet, class: cls,
      },
    };
  }
  return null;
}

const pct = (x) => (Number.isFinite(x) ? Math.round(x * 10000) / 100 : null);

// ---------------------------------------------------------------------------------------------------------------
// Matched comparisons (signal-time features only).

const FEATURES = [
  ['ret_w', (s) => s.ret_w],
  ['accel', (s) => s.accel],
  ['logVolumeW', (s) => Math.log10(1 + s.volumeW)],
  ['logRelVol', (s) => (s.relVol > 0 ? Math.log2(s.relVol) : null)],
  ['buyShare', (s) => s.buyShare],
  ['spreadBps', (s) => s.spreadBps],
  ['minutesSinceOpen', (s) => s.minutesSinceOpen],
];

function matchEvents(events) {
  const stats = FEATURES.map(([, f]) => {
    const xs = events.map((e) => f(e.signal)).filter((x) => x !== null && Number.isFinite(x));
    const m = xs.reduce((a, b) => a + b, 0) / (xs.length || 1);
    const sd = Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length || 1)) || 1;
    return { m, sd };
  });
  const z = (e) => FEATURES.map(([, f], k) => { const x = f(e.signal); return x === null || !Number.isFinite(x) ? null : (x - stats[k].m) / stats[k].sd; });
  const cont = events.filter((e) => e.outcome.class === 'continued');
  const failed = events.filter((e) => e.outcome.class === 'stalled' || e.outcome.class === 'reversed');
  const pairs = [];
  for (const c of cont) {
    const zc = z(c);
    let best = null;
    for (const f of failed) {
      if (f.tier !== c.tier) continue;
      const zf = z(f);
      let ss = 0; let used = 0;
      zc.forEach((x, k) => { if (x !== null && zf[k] !== null) { ss += (x - zf[k]) ** 2; used++; } });
      if (used < 3) continue;
      const d = Math.sqrt(ss / used);
      if (!best || d < best.d) best = { f, d, used };
    }
    const feat = (e) => Object.fromEntries(FEATURES.map(([k, f]) => [k, round4(f(e.signal))]));
    pairs.push(best ? {
      breakout: { sym: c.sym, signalEt: c.signal.E_et, features: feat(c), classRetPct: c.outcome.classRetPct, mfePct: c.outcome.mfePct, maePct: c.outcome.maePct },
      matchedFailure: { sym: best.f.sym, signalEt: best.f.signal.E_et, class: best.f.outcome.class, features: feat(best.f), classRetPct: best.f.outcome.classRetPct, mfePct: best.f.outcome.mfePct, maePct: best.f.outcome.maePct },
      distance: round4(best.d), featuresCompared: best.used,
    } : { breakout: { sym: c.sym, signalEt: c.signal.E_et }, matchedFailure: null, note: 'NO_COMPARABLE_FAILURE_IN_TIER' });
  }
  const mean = (arr, f) => { const xs = arr.map((e) => f(e.signal)).filter((x) => x !== null && Number.isFinite(x)); return xs.length ? round4(xs.reduce((a, b) => a + b, 0) / xs.length) : null; };
  const groupMeans = Object.fromEntries(['continued', 'failed'].map((g) => {
    const arr = g === 'continued' ? cont : failed;
    return [g, { n: arr.length, ...Object.fromEntries(FEATURES.map(([k, f]) => [k, mean(arr, f)])) }];
  }));
  return {
    method: 'Nearest neighbour (with replacement) among failed (stalled|reversed) events of the same tier; Euclidean distance over z-scored signal-time features shared by both events (>= 3 required). Descriptive only; no statistical significance claimed.',
    features: FEATURES.map(([k]) => k), pairs, groupMeans,
  };
}

const round4 = (x) => (x === null || x === undefined || !Number.isFinite(x) ? null : Math.round(x * 10000) / 10000);

// ---------------------------------------------------------------------------------------------------------------
// Handwritten $50 example rule set, replayed with the contract fill model.

function simulateHandwritten(db, ds, ev, g, cm, variant, r) {
  const sym = ev.sym;
  const E = ev.signal.E;
  const notes = [];
  const q = quoteAsOf(db, ds, sym, E);
  if (!q || !q.twoSided) return { entered: false, reason: 'NO_TWO_SIDED_QUOTE_AT_SIGNAL' };
  if (q.halted) return { entered: false, reason: 'HALTED_AT_SIGNAL' };
  const budgetU = usdToU(r.budgetUsd);
  const estPx = slippedPrice(q.ask, 'buy', cm.slippageBps);
  const qty0 = Math.floor(budgetU / estPx);
  if (qty0 < 1) return { entered: false, reason: 'BUDGET_BELOW_ONE_SHARE', estPriceU: estPx };

  let cashU = budgetU;
  let pos = 0;
  let costU = 0;
  let proceedsU = 0;
  let feesU = 0;
  const entry = { side: 'buy', type: 'market', kind: 'equity', qty: qty0, filled_qty: 0, status: 'working' };
  const fills = [];
  let firstFillIdx = null;
  let stop = null; let tp = null; let tx = null; let stopMkt = null;
  let exitReason = null;
  const firstIdx = (E - g.dayStart) / MINUTE;     // minute [E, E+60s) is the first eligible minute
  const last = g.closeIdx - 1;
  if (firstIdx > last) return { entered: false, reason: 'SIGNAL_AT_SESSION_CLOSE_NO_ENTRY_MINUTE' };
  const unfillableEntry = [];
  for (let k = firstIdx; k <= last; k++) {
    const t = g.dayStart + k * MINUTE;
    const minute = fillMinute(db, ds, sym, t, t + MINUTE);
    // 1) protective children (activated in an earlier minute) — stop first (conservative OCO ordering)
    if (pos > 0 && stop) {
      // Alternative interpretation: "if it dips, sell" = an IEX trade at/below the buy level in a completed minute
      // causes a market SELL from the next minute. The dip is assumed to precede any take-profit in that minute.
      if (variant.stopMode === 'last_trade' && !stop.done && minute.trades && minute.trades.l != null && minute.trades.l <= stop.stop_px) {
        if (tp && !tp.done) {
          const alt = evaluateOrder({ ...tp, qty: tp.filled_qty + pos }, minute, cm, { cashU, positionQty: pos, ds });
          if (alt.action === 'fill') notes.push(`OCO_SAME_MINUTE_AMBIGUITY at ${fmtEt(t)}: take-profit could also have filled; dip assumed first`);
          tp.done = true;
        }
        stop.done = true;
        stopMkt = { role: 'stop_loss', side: 'sell', type: 'market', kind: 'equity', qty: pos, filled_qty: 0, status: 'working', activeFrom: k + 1, stopPx: stop.stop_px };
        notes.push(`LAST_TRADE_STOP: IEX trade at/below ${stop.stop_px} u in minute ${fmtEt(t)}; market sell from ${fmtEt(t + MINUTE)}`);
      }
      const children = variant.stopMode === 'last_trade' ? [stopMkt, tp, tx] : [stop, tp, tx];
      for (const child of children.filter(Boolean)) {
        if (pos <= 0 || child.done || (child.activeFrom != null && child.activeFrom > k)) continue;
        child.qty = child.filled_qty + pos;     // working qty tracks the position still held
        const res = evaluateOrder(child, minute, cm, { cashU, positionQty: pos, ds });
        if (res.triggered && child.type === 'stop' && child.status !== 'triggered') { child.status = 'triggered'; child.triggered_ts = t; }
        if (res.action === 'fill') {
          pos -= res.qty; proceedsU += res.qty * res.priceU - res.feesU; feesU += res.feesU; child.filled_qty += res.qty;
          const immediate = child.role === 'stop_loss' && child.type === 'stop' && k === firstFillIdx + 1 && !!minute.startQuote && minute.startQuote.bid > 0 && minute.startQuote.bid <= child.stop_px;
          const worse = res.worseThanStop ?? (child.stopPx != null ? res.priceU < child.stopPx : null);
          fills.push({ role: child.role, t, et: fmtEt(t), qty: res.qty, priceU: res.priceU, feesU: res.feesU, worseThanStop: worse, rule: res.assumptions.rule,
            ...(immediate ? { immediateTrigger: 'IEX bid at the start of the first protective minute was already at/below the buy-level stop' } : {}) });
          if (pos <= 0) {
            exitReason = child.role;
            const other = [stop, tp].find((x) => x && x !== child && !x.done && x.role !== child.role);
            if (child.role === 'stop_loss' && other) {
              const alt = evaluateOrder({ ...other, qty: res.qty }, minute, cm, { cashU, positionQty: res.qty, ds });
              if (alt.action === 'fill') notes.push(`OCO_SAME_MINUTE_AMBIGUITY at ${fmtEt(t)}: take-profit would also have filled; stop assumed first`);
            }
          }
        }
      }
      if (pos <= 0) break;
    }
    // 2) time exit decision at the end of the 15th minute after the first entry fill
    if (variant.timeExit && pos > 0 && firstFillIdx !== null && !tx && k === firstFillIdx + r.timeExitMin) {
      const P = costU / Math.max(1, fills.filter((f) => f.role === 'entry').reduce((s, f) => s + f.qty, 0));
      let hiU = -Infinity; let loU = Infinity;
      for (let m = firstFillIdx + 1; m <= k; m++) {
        const fm = fillMinute(db, ds, sym, g.dayStart + m * MINUTE, g.dayStart + (m + 1) * MINUTE);
        if (fm.trades) { hiU = Math.max(hiU, fm.trades.h); loU = Math.min(loU, fm.trades.l); }
      }
      const band = r.timeExitBandPct / 100;
      const inBand = hiU === -Infinity || (hiU <= P * (1 + band) && loU >= P * (1 - band));
      if (inBand) {
        tx = { role: 'time_exit', side: 'sell', type: 'market', kind: 'equity', qty: pos, filled_qty: 0, status: 'working' };
        if (stop) stop.done = true;
        if (tp) tp.done = true;
        if (stopMkt) stopMkt.done = true;
        notes.push(`TIME_EXIT submitted at ${fmtEt(t + MINUTE)}: trades stayed within ±${r.timeExitBandPct}% of entry for ${r.timeExitMin} min`);
      }
    }
    // 3) entry (market buy) while inside the entry window
    if (entry.filled_qty < entry.qty && k < firstIdx + r.entryWindowMin) {
      const res = evaluateOrder(entry, minute, cm, { cashU, positionQty: pos, ds });
      if (res.action === 'fill') {
        entry.filled_qty += res.qty; pos += res.qty;
        const c = res.qty * res.priceU + res.feesU;
        cashU -= c; costU += c; feesU += res.feesU;
        fills.push({ role: 'entry', t, et: fmtEt(t), qty: res.qty, priceU: res.priceU, feesU: res.feesU, rule: res.assumptions.rule, qtyLimitedBy: res.assumptions.qtyLimitedBy });
        if (firstFillIdx === null) {
          firstFillIdx = k;
          const P = res.priceU;
          // "Stop at buy level": stop trigger at the entry fill price (rounded down to a valid tick).
          stop = { role: 'stop_loss', side: 'sell', type: 'stop', kind: 'equity', qty: pos, filled_qty: 0, stop_px: roundToTick(P, 'sell'), status: 'working', triggered_ts: null };
          tp = { role: 'take_profit', side: 'sell', type: 'limit', kind: 'equity', qty: pos, filled_qty: 0, limit_px: roundToTick(Math.round(P * variant.tpMult), 'buy'), status: 'working' };
        }
      } else if (res.action === 'unfillable') unfillableEntry.push({ et: fmtEt(t), reason: res.reason });
    }
    if (firstFillIdx === null && k >= firstIdx + r.entryWindowMin - 1) {
      return { entered: false, reason: 'ENTRY_NOT_FILLED_WITHIN_WINDOW', unfillable: unfillableEntry.slice(0, 5) };
    }
  }
  if (firstFillIdx === null) return { entered: false, reason: 'ENTRY_NOT_FILLED_BEFORE_CLOSE', unfillable: unfillableEntry.slice(0, 5) };
  const entryQty = entry.filled_qty;
  let markU = null; let markBasis = null;
  if (pos > 0) {
    exitReason = 'OPEN_AT_SESSION_CLOSE';
    const qc = quoteAsOf(db, ds, sym, g.close);
    if (qc && qc.bid) { markU = qc.bid * pos; markBasis = 'IEX_BID_AT_CLOSE'; } else markBasis = 'UNMARKED';
  }
  const pnlU = markBasis === 'UNMARKED' ? null : proceedsU + (markU ?? 0) - costU;
  return {
    entered: true, entryQty, avgEntryPriceU: Math.round((costU - fills.filter((f) => f.role === 'entry').reduce((s, f) => s + f.feesU, 0)) / entryQty),
    stopPxU: stop?.stop_px ?? null, takeProfitPxU: tp?.limit_px ?? null, costU, proceedsU, feesU, exitReason,
    openQtyAtClose: pos, markBasis, pnlU, pnlPct: pnlU === null ? null : pct(pnlU / costU), fills, notes,
    worseThanStop: fills.some((f) => f.worseThanStop === true),
    immediateStopTrigger: fills.some((f) => !!f.immediateTrigger),
    spreadBpsAtSignal: q.spreadBps,
  };
}

function summariseRule(results) {
  const entered = results.filter((x) => x.sim.entered);
  const pnl = entered.map((x) => x.sim.pnlU).filter((x) => x !== null);
  const byExit = {};
  for (const x of entered) byExit[x.sim.exitReason] = (byExit[x.sim.exitReason] || 0) + 1;
  const notEntered = {};
  for (const x of results.filter((y) => !y.sim.entered)) notEntered[x.sim.reason] = (notEntered[x.sim.reason] || 0) + 1;
  return {
    signals: results.length, entered: entered.length, notEntered, exits: byExit,
    worseThanStopFills: entered.filter((x) => x.sim.worseThanStop).length,
    immediateStopTriggers: entered.filter((x) => x.sim.immediateStopTrigger).length,
    totalPnlU: pnl.reduce((a, b) => a + b, 0), meanPnlU: pnl.length ? Math.round(pnl.reduce((a, b) => a + b, 0) / pnl.length) : null,
    winners: pnl.filter((x) => x > 0).length, losers: pnl.filter((x) => x < 0).length, flat: pnl.filter((x) => x === 0).length,
    totalCostU: entered.reduce((s, x) => s + x.sim.costU, 0),
  };
}

// ---------------------------------------------------------------------------------------------------------------

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} ds  market dataset id
 * @param {{windowMin?:number, thresholdPct?:number, tier?:'penny'|'low', horizonMin?:number[], minTradesInWindow?:number,
 *          continuePct?:number, reversePct?:number, rule?:object, exploratoryThresholdPct?:number, minEventsForPrimary?:number,
 *          includeRule?:boolean}} [opts]
 */
export function historicalSignalStudy(db, ds, opts = {}) {
  const o = { ...DEFAULTS, ...opts, rule: { ...DEFAULTS.rule, ...(opts.rule || {}) } };
  if (!PRICE_TIERS[o.tier]) throw new RangeError('tier must be penny | low');
  const key = JSON.stringify([ds, o]);
  if (cache.has(key)) return cache.get(key);
  const started = performance.now();
  const d = ds ? getDataset(db, ds) : null;
  const session = d ? sessionWindow(db, ds) : null;
  const base = { label: RETRO_LABEL, ds, params: { ...o, tierDefinition: PRICE_TIERS[o.tier] } };
  if (!d || d.kind !== 'market_ticks' || !session) {
    return { ...base, status: 'NO_VERIFIED_DATA', note: 'No stored market dataset; nothing to study (BLOCKED BY DATA).', events: [] };
  }
  const g = { dayStart: etToUtc(session.tradeDate, 4, 0), N: 16 * 60, open: session.open, close: session.close };
  g.openIdx = (g.open - g.dayStart) / MINUTE;
  g.closeIdx = (g.close - g.dayStart) / MINUTE;

  const exclude = new Set([...largeCapList(), ...BENCHMARKS, ...KNOWN_TEST_SYMBOLS]);
  const tierMax = PRICE_TIERS[o.tier].maxPriceU;
  const statusBySym = new Map();
  for (const e of db.prepare('SELECT sym, ts, kind, code FROM status_events WHERE ds = ? ORDER BY sym, ts').iterate(ds)) {
    let a = statusBySym.get(e.sym);
    if (!a) { a = []; statusBySym.set(e.sym, a); }
    a.push(e);
  }

  const run = (thresholdPct) => {
    const oo = { ...o, thresholdPct };
    const events = [];
    let symbolsScanned = 0;
    let cur = null; let rows = []; let minC = Infinity;
    const flush = () => {
      if (cur && !exclude.has(cur) && minC < tierMax) {
        symbolsScanned++;
        const ev = analyzeSymbol(cur, buildSeries(rows, g.dayStart, g.N), g, oo, statusBySym.get(cur));
        if (ev) events.push(ev);
      }
      rows = []; minC = Infinity;
    };
    for (const r of db.prepare('SELECT sym, t, h, l, c, v, n, bv, sv, bid, ask, qts, halted, unavail FROM m1 WHERE ds = ? ORDER BY sym, t').iterate(ds)) {
      if (r.sym !== cur) { flush(); cur = r.sym; }
      rows.push(r);
      if (r.c != null && r.c < minC) minC = r.c;
    }
    flush();
    events.sort((a, b) => a.signal.E - b.signal.E || (a.sym < b.sym ? -1 : 1));
    const counts = { symbolsScanned, signals: events.length, continued: 0, stalled: 0, reversed: 0, no_trades_after_signal: 0, no_session_after_signal: 0 };
    for (const e of events) counts[e.outcome.class]++;
    let rule = null;
    if (o.includeRule !== false) {
      const cm = defaultCostModel('micro');
      const variants = [];
      for (const stopMode of ['contract_stop', 'last_trade']) {
        for (const tpMult of o.rule.tpMultipliers) {
          for (const timeExit of [true, false]) variants.push({ id: `${stopMode === 'last_trade' ? 'lastTradeStop' : 'stop'}-tp${tpMult}x${timeExit ? '+timeExit' : ''}`, stopMode, tpMult, timeExit });
        }
      }
      rule = {
        label: 'HANDWRITTEN $50 EXAMPLE — EXPLORATORY, NOT VALIDATED; estimated paper fills, never exchange executions',
        fillModel: { source: 'server/sim/fills.js evaluateOrder on marketdata.fillMinute minutes', id: FILL_MODEL_ID, costModel: cm },
        interpretation: {
          trigger: `+${thresholdPct}% IEX trade return over ${o.windowMin} min (signal time = knowable time E)`,
          entry: `market BUY submitted at E for floor($${o.rule.budgetUsd} / slipped ask at E) shares; eligible from minute [E, E+60s); retried up to ${o.rule.entryWindowMin} minutes, then abandoned`,
          stop: 'stop SELL at the entry fill price ("sell @ buy level"); a stop cannot guarantee that price — modelled fill may be worse than the stop. '
            + 'contract_stop = fills.js stop semantics (triggers when the IEX bid or a trade reaches the stop). Because the entry fill is the worst ask plus slippage, '
            + 'the starting bid of the next minute is always at or below a buy-level stop, so contract_stop variants always trigger in the first protective minute. '
            + 'last_trade (ALTERNATIVE INTERPRETATION of "if dips — sell") = an IEX trade at/below the buy level in a completed minute triggers a market SELL from the next minute.',
          takeProfit: 'limit SELL at entry × multiplier: 2.5× = "250% of purchase price" (default, more conservative), 3.5× = "250% gain"; both shown',
          timeExit: `ambiguous note "if not +/-10% for 15 min — sell @ current level" interpreted as: if all IEX trades in the ${o.rule.timeExitMin} minutes after the entry fill stayed within ±${o.rule.timeExitBandPct}% of entry, submit a market SELL (stop/TP cancelled); variants with and without it shown`,
          oco: 'stop evaluated before take-profit within a minute (conservative); same-minute ambiguity noted',
          sessionEnd: 'DAY orders expire at 16:00 ET; a position still open is marked to the IEX bid at close (unrealised)',
          spreadGate: 'the policy-gate spread cap is NOT applied here (the handwritten rule has none); spread at signal is reported',
        },
        default: 'stop-tp2.5x+timeExit',
        variants: variants.map((v) => {
          const results = events.map((ev) => ({ sym: ev.sym, signalEt: ev.signal.E_et, sim: simulateHandwritten(db, ds, ev, g, cm, v, o.rule) }));
          return { ...v, summary: summariseRule(results), results };
        }),
      };
    }
    return { thresholdPct, counts, events, matched: matchEvents(events), handwrittenRule: rule };
  };

  const primary = run(o.thresholdPct);
  let exploratory = null;
  const minEvents = o.minEventsForPrimary ?? 5;
  if (primary.events.length < minEvents && (o.exploratoryThresholdPct ?? 10) < o.thresholdPct) {
    exploratory = { label: EXPLORATORY_LABEL, reason: `primary threshold produced ${primary.events.length} event(s) (< ${minEvents})`, ...run(o.exploratoryThresholdPct ?? 10) };
  }
  const out = {
    ...base, status: 'HISTORICAL_REAL',
    session: { tradeDate: session.tradeDate, open: session.open, close: session.close },
    dataset: { id: d.id, provider: d.provider, sha256: d.sha256, status: d.status, coverage: d.venue_coverage },
    definitions: {
      signal: `first minute end E in the regular session where IEX last-trade return over the previous ${o.windowMin} min >= threshold, window fully inside the session, >= ${o.minTradesInWindow} IEX trades in window`,
      tier: `reference price (last IEX trade at or before window start, may be pre-market) < ${PRICE_TIERS[o.tier].maxPriceU / 1e4} USD`,
      classification: `return at ${Math.max(...o.horizonMin)} min after E (or session close if beyond): >= +${o.continuePct}% continued; <= ${o.reversePct}% reversed; otherwise stalled. failed = stalled | reversed. EXPLORATORY THRESHOLDS.`,
      excursions: 'MFE/MAE: max IEX trade high / min trade low after E through 15:59 ET, relative to the signal price',
      relVol: RELVOL_DEFINITION,
      buyShare: 'inferred aggressor share (quote rule vs IEX BBO; IEX-only); null when classified volume < minClassifiedShares',
    },
    limitations: [
      'Single trading day of IEX-only data: no prior close, no multi-day baseline, no consolidated volume; IEX BBO is not the NBBO.',
      'Survivorship/selection: stored symbols are those observed below $5 at any time on the day (storage superset).',
      'Small samples; descriptive only — no statistical significance, no claim of predictive value.',
      'Trade breaks seen in the feed were not applied; corporate actions on the day are not adjusted.',
    ],
    primary, exploratory,
    timing: { ms: Math.round(performance.now() - started) },
  };
  cache.set(key, out);
  return out;
}

/** Forget cached studies (tests). */
export function clearStudyCache() { cache.clear(); }
