// As-of opportunity scanner: transparent signal METRICS over the stored IEX replay data.
// Label: SIGNAL METRICS — NOT RECOMMENDATIONS. Every read goes through server/data/marketdata.js with asOf, so a
// scan at clock C sees only minute rows with t + 60 s <= C.
//
// Metrics (all IEX-only; IEX is a fraction of consolidated volume and its BBO is not the NBBO):
//   ret_w   price now / price at window start - 1 (last IEX trades; window = [asOf - W, asOf))
//   accel   (return over the second half of the window) - (return over the first half)
//   relVol  shared definition (marketdata.RELVOL_DEFINITION): window volume per minute / per-minute volume of the
//           regular-session minutes BEFORE the window; null when that baseline is < 15 minutes or has zero volume
//           (reasons BASELINE_TOO_SHORT / NO_BASELINE_VOLUME). A baseline under 1,000 IEX shares is flagged
//           THIN_BASELINE: the value is shown (with relVolBasis) but contributes nothing to the score, so a tiny
//           baseline cannot push a row up the ranking. Agents treat the same baseline as unavailable.
//   buyShare  inferred aggressor share = buyer-initiated / (buyer + seller-initiated) volume, quote rule vs the
//             prevailing IEX BBO; null when classified volume < minClassifiedShares. Volume alone is never intent.
//   classifiedShare  classified / total window volume
//   spreadBps, quoteAgeMs, halted   from the as-of IEX quote
//
// Names and security types come from the newest Nasdaq Trader directory snapshot. When that snapshot was published
// after asOf it is POST-DATED (nameSource.postDated): names are display labels only, never as-of evidence.
// Ranking: common-equity-like rows first (COMMON_FIRST), then non-common instruments (warrants, rights, units,
// preferreds, ETFs, notes), each by score. Nothing is hidden unless the caller sets instruments='common'|'non_common',
// and the scan then reports how many rows the filter removed.
import { MINUTE, fmtEt } from '../util/time.js';
import {
  sessionWindow, universeAsOf, windowAggregatesAsOf, quoteAsOf, closeAtOrBefore, statusAsOf, relativeVolumeInfo, RELVOL_DEFINITION,
  RELVOL_THIN_BASELINE_SHARES,
} from '../data/marketdata.js';
import { latestSymDirSnapshot, iexToActSymbol, classifySecurity, NON_COMMON_TYPES } from '../data/ingest/nasdaq-symdir.js';

export const SCANNER_LABEL = 'SIGNAL METRICS — NOT RECOMMENDATIONS';

// Exploratory, unvalidated weights. Shown with every scan so the ranking is inspectable.
export const SCORE_WEIGHTS = Object.freeze({ retPct: 1, accelPct: 0.5, relVolLog2: 10, buyShareTilt: 20, spreadPer100Bps: -1 });
export const SCORE_FORMULA = 'score = 1*clamp(ret_w%,-50,100) + 0.5*clamp(accel%,-50,50) + 10*log2(clamp(relVol,0.1,64)) + 20*(buyShare-0.5) - spreadBps/100; '
  + 'missing optional terms (relVol, buyShare) and a THIN_BASELINE relVol contribute 0; score is null when the row is insufficient or halted. EXPLORATORY WEIGHTS — NOT VALIDATED.';
export const RANKING_NOTE = 'COMMON_FIRST: common-equity-like rows (common, ADR, unclassified) rank before non-common instruments '
  + '(warrants, rights, units, preferreds, ETFs/ETNs, notes); within each group by score, then window volume. Non-common rows are '
  + 'ranked lower, not hidden (filter with instruments=common|non_common).';
export const INSTRUMENT_FILTERS = Object.freeze(['all', 'common', 'non_common']);

const DEFAULT_MAX_QUOTE_AGE = { micro: 300_000, low: 300_000, large: 60_000 };
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

function directoryLookup(db, asOf) {
  const snap = latestSymDirSnapshot(db);
  if (!snap) {
    return {
      nameSource: { ds: null, postDated: null, note: 'No symbol directory ingested: names and security types from the symbol suffix only.' },
      get: () => null,
    };
  }
  const rows = new Map(db.prepare('SELECT sym, name, etf FROM ref_symbols WHERE ds = ?').all(snap.ds).map((r) => [r.sym, r]));
  const postDated = snap.publishedMs > asOf;
  return {
    nameSource: {
      ds: snap.ds, fileCreationEt: snap.fileCreationEt, publishedMs: snap.publishedMs, postDated,
      note: postDated
        ? `Names and security types come from a Nasdaq Trader directory snapshot created ${snap.fileCreationEt ?? 'at an unknown time'}, AFTER the replay clock: display labels only, not as-of evidence (renames/delistings after the replay date are not reflected).`
        : 'Names and security types come from a directory snapshot published at or before the replay clock.',
    },
    get: (sym) => rows.get(sym) ?? rows.get(iexToActSymbol(sym)) ?? null,
  };
}

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} ds  market dataset id
 * @param {number} asOf  replay clock, ms UTC
 * @param {{segment?:'micro'|'large'|'low', windowMin?:number, minClassifiedShares?:number, maxQuoteAgeMs?:number, limit?:number|null,
 *          instruments?:'all'|'common'|'non_common'}} [o]
 */
export function scanAsOf(db, ds, asOf, { segment = 'micro', windowMin = 15, minClassifiedShares = 1000, maxQuoteAgeMs = null, limit = null, instruments = 'all' } = {}) {
  if (!Number.isFinite(asOf)) throw new TypeError('asOf (ms UTC) is required');
  if (!['micro', 'large', 'low'].includes(segment)) throw new RangeError('segment must be micro | large | low');
  if (!INSTRUMENT_FILTERS.includes(instruments)) throw new RangeError('instruments must be all | common | non_common');
  const W = Math.max(2, Math.min(240, windowMin | 0));
  const started = performance.now();
  const base = {
    label: SCANNER_LABEL, ds, asOf, segment, windowMin: W, scoreFormula: SCORE_FORMULA, weights: SCORE_WEIGHTS,
    relVolDefinition: RELVOL_DEFINITION, ranking: RANKING_NOTE, instrumentFilter: instruments,
  };
  const session = ds ? sessionWindow(db, ds) : null;
  if (!session) return { ...base, status: 'NO_VERIFIED_DATA', note: 'No replayable market dataset.', rows: [], timing: { ms: 0, symbols: 0 } };
  const quoteAgeCap = maxQuoteAgeMs ?? DEFAULT_MAX_QUOTE_AGE[segment];

  const uni = universeAsOf(db, ds, asOf, segment);
  const syms = uni.map((u) => u.sym);
  const aggs = new Map(windowAggregatesAsOf(db, ds, asOf, { windowMin: W, sessionOpen: session.open, syms }).map((a) => [a.sym, a]));
  const dir = directoryLookup(db, asOf);

  const halfMin = Math.floor(W / 2);
  const tWinStart = asOf - W * MINUTE;            // window = [tWinStart, asOf)
  const tMid = asOf - halfMin * MINUTE;
  // Regular-session minutes before the window: [open, tWinStart).
  const baselineMin = Math.max(0, Math.floor((Math.min(tWinStart, session.close) - session.open) / MINUTE));

  const rows = uni.map((u) => {
    const a = aggs.get(u.sym) || null;
    const reasons = [];
    if (asOf <= session.open) reasons.push('BEFORE_REGULAR_SESSION');
    const wn = a ? Number(a.wn) : 0;
    const wv = a ? Number(a.wv) : 0;
    if (wn === 0) reasons.push('NO_TRADES_IN_WINDOW');
    // Last trade completed at or before the window start / midpoint (minute starting <= boundary - 60 s).
    const ref = closeAtOrBefore(db, ds, u.sym, tWinStart - MINUTE, asOf);
    const mid = closeAtOrBefore(db, ds, u.sym, tMid - MINUTE, asOf);
    if (!ref) reasons.push('NO_REFERENCE_PRICE');
    const ret_w = ref && ref.priceU > 0 ? u.priceU / ref.priceU - 1 : null;
    const accel = ref && mid && ref.priceU > 0 && mid.priceU > 0 ? (u.priceU / mid.priceU - 1) - (mid.priceU / ref.priceU - 1) : null;

    const baselineVolume = a ? Math.max(0, Number(a.sv_total) - wv) : 0;
    const { relVol, flag: relVolFlag } = relativeVolumeInfo({ windowVolume: wv, windowMin: W, baselineVolume, baselineMin });
    const thinBaseline = relVol !== null && baselineVolume < RELVOL_THIN_BASELINE_SHARES;
    if (relVolFlag) reasons.push(relVolFlag);
    else if (thinBaseline) reasons.push('THIN_BASELINE');
    const bv = a ? Number(a.wbv) : 0;
    const sv = a ? Number(a.wsv) : 0;
    const classified = bv + sv;
    const classifiedShare = wv > 0 ? classified / wv : null;
    let buyShare = null;
    if (classified >= minClassifiedShares) buyShare = bv / classified;
    else if (wv > 0) reasons.push('LOW_CLASSIFIED_VOLUME');

    const q = quoteAsOf(db, ds, u.sym, asOf);
    const halted = q ? q.halted : statusAsOf(db, ds, u.sym, asOf).halted;
    if (!q) reasons.push('NO_QUOTE');
    else if (!q.twoSided) reasons.push('ONE_SIDED_QUOTE');
    if (q && q.ageMs > quoteAgeCap) reasons.push('QUOTE_STALE');
    if (halted) reasons.push('HALTED');
    const insufficient = wn === 0 || !ref || !q || !q.twoSided || asOf <= session.open;

    let score = null;
    let scoreParts = null;
    if (!insufficient && !halted) {
      scoreParts = {
        ret: SCORE_WEIGHTS.retPct * clamp(ret_w * 100, -50, 100),
        accel: accel === null ? 0 : SCORE_WEIGHTS.accelPct * clamp(accel * 100, -50, 50),
        relVol: relVol === null || thinBaseline ? 0 : SCORE_WEIGHTS.relVolLog2 * Math.log2(clamp(relVol, 0.1, 64)),
        buyShare: buyShare === null ? 0 : SCORE_WEIGHTS.buyShareTilt * (buyShare - 0.5),
        spread: q.spreadBps === null ? 0 : SCORE_WEIGHTS.spreadPer100Bps * (q.spreadBps / 100),
      };
      score = Object.values(scoreParts).reduce((s, x) => s + x, 0);
    }
    const ref0 = dir.get(u.sym);
    const securityType = { ...classifySecurity({ sym: u.sym, name: ref0?.name ?? null, etf: ref0?.etf ?? null }), postDated: ref0 ? dir.nameSource.postDated : null };
    return {
      sym: u.sym, name: ref0?.name ?? null, namePostDated: ref0 ? dir.nameSource.postDated : null,
      securityType, nonCommon: NON_COMMON_TYPES.has(securityType.type),
      priceU: u.priceU, minuteT: u.minuteT,
      quote: q ? { bid: q.bid, ask: q.ask, bidSize: q.bidSize, askSize: q.askSize, quoteTs: q.quoteTs, ageMs: q.ageMs, spreadBps: q.spreadBps, twoSided: q.twoSided, halted: q.halted } : null,
      metrics: {
        ret_w, accel, relVol, relVolBasis: { windowVolume: wv, windowMin: W, baselineVolume, baselineMin, thinBaseline, thinBaselineShares: RELVOL_THIN_BASELINE_SHARES },
        buyShare, classifiedShare, volumeW: wv, tradesW: wn, brokenTradesExcluded: a?.brokenTrades ?? 0,
        spreadBps: q ? q.spreadBps : null, quoteAgeMs: q ? q.ageMs : null, halted, insufficient, reasons,
        refPriceU: ref ? ref.priceU : null, refMinuteT: ref ? ref.minuteT : null,
      },
      score, scoreParts,
    };
  });
  rows.sort((x, y) => (Number(x.nonCommon) - Number(y.nonCommon))
    || (y.score ?? -Infinity) - (x.score ?? -Infinity) || y.metrics.volumeW - x.metrics.volumeW || (x.sym < y.sym ? -1 : 1));
  const kept = instruments === 'all' ? rows : rows.filter((r) => (instruments === 'common' ? !r.nonCommon : r.nonCommon));
  const ms = Math.round(performance.now() - started);
  return {
    ...base, status: 'HISTORICAL_REAL', nameSource: dir.nameSource,
    note: `IEX-only metrics as of the replay clock; ${segment === 'large' ? 'configured large-cap list (market cap not verified)' : 'price-tier proxy universe (market cap not verified)'}. `
      + `relVol baseline = regular-session volume before the window (${baselineMin} min, minimum 15; under ${RELVOL_THIN_BASELINE_SHARES} shares flagged THIN_BASELINE and not scored); quote stale above ${quoteAgeCap / 1000} s. `
      + `Ranked COMMON_FIRST (non-common instruments after common stock, not hidden).${dir.nameSource.postDated ? ` Names: post-dated directory snapshot (${dir.nameSource.fileCreationEt ?? 'unknown time'}), display only.` : ''}`,
    session: { open: session.open, close: session.close, tradeDate: session.tradeDate, asOfEt: fmtEt(asOf) },
    counts: {
      universe: rows.length, scored: rows.filter((r) => r.score !== null).length, insufficient: rows.filter((r) => r.metrics.insufficient).length,
      nonCommon: rows.filter((r) => r.nonCommon).length, filteredOut: rows.length - kept.length, returned: kept.length,
    },
    rows: limit ? kept.slice(0, limit) : kept,
    timing: { ms, symbols: rows.length },
  };
}
