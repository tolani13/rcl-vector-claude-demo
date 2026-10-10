// Agent strategies (docs/CONTRACTS.md section 7): presets, as-of signals and rule-based TradeIntent proposals.
//
// Everything numeric in this file is CONFIGURATION, never a market observation, and every preset is labelled
// `EXPLORATORY DEFAULTS — NOT VALIDATED`. No threshold here has been empirically validated.
//
//   computeSignals()  reads market data ONLY through server/data/marketdata.js as-of functions, so a signal computed
//                     at replay clock C sees only minute rows with t + 60 s <= C (no look-ahead).
//   planActions()     pure function of (strategy, signals, portfolio state, clock) -> typed TradeIntents (source
//                     'rules'): stale-entry cancels, orphan-protective cancels, breakeven stop modifications, time
//                     exits and new entries with attached stop-loss / take-profit / time exit. A proposal is never
//                     executable by itself: the runner sends every intent through the deterministic policy gate.
//   proposeIntents()  planActions(...).actions mapped to the bare TradeIntents (the contract signature).
//
// Volume alone is never labelled intent. `buyShare` is an INFERRED aggressor share (quote rule vs the prevailing IEX
// BBO; IEX-only) and is null when the classified volume in the window is below cfg.minClassifiedShares.
import { MINUTE } from '../util/time.js';
import { applyBps, roundToTick, usdToU } from '../util/money.js';
import {
  sessionWindow, windowAggregatesAsOf, closeAtOrBefore, lastTradeAsOf, quoteAsOf, relativeVolume, RELVOL_MIN_BASELINE_MIN,
  RELVOL_DEFINITION as SHARED_RELVOL_DEFINITION,
} from '../data/marketdata.js';
import { slippedPrice, computeFees, defaultCostModel } from '../sim/fills.js';
import { intentFromProposal } from './intents.js';
import { DOCUMENTED_STOP_AT_ENTRY_STRATEGIES } from '../policy/config.js';

export const STRATEGY_LABEL = 'EXPLORATORY DEFAULTS — NOT VALIDATED';
export const STRATEGY_VERSION = 1;
export const DECISION_MODES = Object.freeze(['rules', 'model_confirm', 'model']);
export const LENSES = Object.freeze(['cowboy', 'pragmatist', 'tightwad']);
export const SEGMENTS = Object.freeze(['micro', 'large']);
export const BUY_SHARE_LABEL = 'inferred aggressor share (quote rule vs IEX BBO; IEX-only)';
/**
 * Minimum earlier-session (baseline) IEX volume for an agent to use a relVol value (the scanner flags the same
 * threshold THIN_BASELINE but still reports the value). EXPLORATORY DEFAULT — NOT VALIDATED.
 */
export const RELVOL_MIN_BASELINE_SHARES = 1000;
export const RELVOL_DEFINITION = `${SHARED_RELVOL_DEFINITION} One definition shared with the opportunity scanner and the retrospective study `
  + '(server/data/marketdata.js relativeVolume): the window is excluded from its own baseline. Agents report BASELINE_TOO_SHORT / NO_BASELINE_VOLUME '
  + `and additionally treat a baseline of fewer than ${RELVOL_MIN_BASELINE_SHARES} IEX shares as unavailable (BASELINE_VOLUME_TOO_SMALL; the scanner `
  + 'shows that value flagged THIN_BASELINE).';
export const SIGNAL_NOTES = Object.freeze([
  'All metrics are IEX-only: IEX volume is a fraction of consolidated U.S. volume and the IEX BBO is not the NBBO.',
  'ret_w = last IEX trade as-of / last IEX trade before the window start - 1 (fraction).',
  'accel = return over the recent half-window minus the return over the prior half-window (fraction).',
  `relVol = window volume per minute / per-minute volume of the regular-session minutes BEFORE the window (one definition shared with the scanner: `
    + `server/data/marketdata.js relativeVolume). null when that baseline is under ${RELVOL_MIN_BASELINE_MIN} minutes (BASELINE_TOO_SHORT), has no volume `
    + `(NO_BASELINE_VOLUME) or fewer than ${RELVOL_MIN_BASELINE_SHARES} IEX shares (BASELINE_VOLUME_TOO_SMALL), and before minHistoryMin.`,
  `buyShare = ${BUY_SHARE_LABEL}; null when classified window volume < minClassifiedShares. Volume alone is not buying intent.`,
]);

/**
 * Relative volume for agents: the shared marketdata.relativeVolume definition (window rate vs the earlier same-day
 * regular-session rate; the window is NOT part of its own baseline; baseline >= RELVOL_MIN_BASELINE_MIN minutes), plus
 * the agents' thin-baseline rule. Pure. Returns {relVol|null, baselineMin, baselineVol, flag|null}.
 * @param {{windowVol:number, windowMin:number, sessionVolToDate:number, elapsedMin:number, minBaselineVol?:number}} o
 */
export function relVolFrom({ windowVol, windowMin, sessionVolToDate, elapsedMin, minBaselineVol = RELVOL_MIN_BASELINE_SHARES }) {
  const baselineMin = Math.max(0, elapsedMin - windowMin);
  const baselineVol = Math.max(0, sessionVolToDate - windowVol);
  const out = (relVol, flag) => ({ relVol, baselineMin, baselineVol, flag });
  if (baselineMin < RELVOL_MIN_BASELINE_MIN) return out(null, 'BASELINE_TOO_SHORT');
  if (!(baselineVol > 0)) return out(null, 'NO_BASELINE_VOLUME');
  if (baselineVol < minBaselineVol) return out(null, 'BASELINE_VOLUME_TOO_SMALL');
  const relVol = relativeVolume({ windowVolume: windowVol, windowMin, baselineVolume: baselineVol, baselineMin });
  return relVol === null ? out(null, 'NO_BASELINE_VOLUME') : out(relVol, null);
}

const ID_RE = /^[A-Za-z0-9_\-:.]{1,80}$/;
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const clone = (v) => structuredClone(v);

// ---- presets -----------------------------------------------------------------------------------------------------

const COMMON_SIGNAL = { windowMin: 15, minHistoryMin: 30, minClassifiedShares: 1000 };

function lensPreset(lens, segment, p) {
  const name = `${lens[0].toUpperCase()}${lens.slice(1)} · ${segment === 'micro' ? 'Microcap' : 'Large-cap'} momentum (exploratory)`;
  return {
    id: `preset:${lens}-${segment}`, version: STRATEGY_VERSION, label: STRATEGY_LABEL, name, lens, segment,
    decisionMode: 'rules',
    description: p.description,
    signal: { ...COMMON_SIGNAL },
    entry: {
      minRetPct: p.minRetPct, minAccelPct: 0, minRelVol: p.minRelVol, minBuyShare: p.minBuyShare, requireBuyShare: p.requireBuyShare,
      minTradesW: p.minTradesW, minVolumeW: null, maxSpreadBps: p.maxSpreadBps, maxQuoteAgeMs: p.maxQuoteAgeMs,
      minPriceU: null, maxPriceU: null, orderType: p.orderType, limitOffsetBps: p.limitOffsetBps ?? 0,
      budgetUsd: p.budgetUsd, capQtyToDisplayedAsk: true, noEntryLastMin: 15,
    },
    exits: {
      stopLoss: { basis: 'pct_below_entry_ref', pct: p.stopPct },
      takeProfit: { basis: 'pct_gain', pct: p.tpPct },
      timeExit: { minutes: p.timeExitMin, bandPct: p.timeExitBandPct },
      breakevenAtGainPct: p.breakevenPct,
    },
    management: {
      cancelEntryAfterMin: p.cancelEntryAfterMin, maxScanSymbols: 150, maxCandidatesPerStep: 3, maxOrdersPerStep: 4,
      maxEntriesPerSymbol: 1, reentryCooldownMin: 30, intentTtlSec: 60, maxModelCallsPerStep: 2,
    },
    notes: [
      'EXPLORATORY DEFAULTS — NOT VALIDATED. Thresholds are configuration for paper simulation, not tested trading rules.',
      'Entry reference price = the as-of IEX ask at the decision minute; stop/take-profit prices are anchored to it, not to the later estimated fill.',
      'A stop is a trigger, not a guaranteed price: iex-conservative-minute-v1 fills a triggered stop at the worst bid in the minute less slippage (worse-than-stop fills are modelled).',
      'Time exit: at or after N minutes from the entry fill, if the last IEX trade is within +/- band of the entry fill price, sell at market (assumption).',
      ...SIGNAL_NOTES,
    ],
  };
}

const LENS_PARAMS = {
  'cowboy-micro': {
    description: 'Aggressive: fast price velocity with expanding volume; market entry; wide stop, large target.',
    minRetPct: 15, minRelVol: 2, minBuyShare: 0.5, requireBuyShare: false, minTradesW: 5, maxSpreadBps: 1000, maxQuoteAgeMs: 300_000,
    orderType: 'market', budgetUsd: 500, stopPct: 12, tpPct: 40, timeExitMin: 30, timeExitBandPct: 5, breakevenPct: 10, cancelEntryAfterMin: 3,
  },
  'pragmatist-micro': {
    description: 'Moderate: velocity plus volume confirmation and a modest buyer-initiated tilt when classifiable; marketable limit entry.',
    minRetPct: 10, minRelVol: 3, minBuyShare: 0.55, requireBuyShare: false, minTradesW: 8, maxSpreadBps: 600, maxQuoteAgeMs: 180_000,
    orderType: 'limit', limitOffsetBps: 25, budgetUsd: 250, stopPct: 8, tpPct: 25, timeExitMin: 20, timeExitBandPct: 4, breakevenPct: 6, cancelEntryAfterMin: 2,
  },
  'tightwad-micro': {
    description: 'Very conservative: requires classifiable buyer-initiated tilt, tight spread, small budget, limit at the ask, tight stop.',
    minRetPct: 8, minRelVol: 4, minBuyShare: 0.6, requireBuyShare: true, minTradesW: 12, maxSpreadBps: 400, maxQuoteAgeMs: 120_000,
    orderType: 'limit', limitOffsetBps: 0, budgetUsd: 100, stopPct: 5, tpPct: 15, timeExitMin: 15, timeExitBandPct: 3, breakevenPct: 4, cancelEntryAfterMin: 2,
  },
  'cowboy-large': {
    description: 'Aggressive large-cap: short-horizon velocity with volume expansion; market entry.',
    minRetPct: 1.5, minRelVol: 2, minBuyShare: 0.5, requireBuyShare: false, minTradesW: 10, maxSpreadBps: 50, maxQuoteAgeMs: 60_000,
    orderType: 'market', budgetUsd: 1000, stopPct: 2, tpPct: 4, timeExitMin: 30, timeExitBandPct: 0.5, breakevenPct: 1, cancelEntryAfterMin: 3,
  },
  'pragmatist-large': {
    description: 'Moderate large-cap: velocity with volume confirmation; marketable limit entry.',
    minRetPct: 1, minRelVol: 2.5, minBuyShare: 0.55, requireBuyShare: false, minTradesW: 15, maxSpreadBps: 30, maxQuoteAgeMs: 60_000,
    orderType: 'limit', limitOffsetBps: 5, budgetUsd: 500, stopPct: 1.5, tpPct: 3, timeExitMin: 30, timeExitBandPct: 0.4, breakevenPct: 0.75, cancelEntryAfterMin: 2,
  },
  'tightwad-large': {
    description: 'Very conservative large-cap: classifiable buyer tilt required, tight spread, limit at the ask, tight stop.',
    minRetPct: 0.75, minRelVol: 3, minBuyShare: 0.6, requireBuyShare: true, minTradesW: 20, maxSpreadBps: 15, maxQuoteAgeMs: 30_000,
    orderType: 'limit', limitOffsetBps: 0, budgetUsd: 250, stopPct: 1, tpPct: 2, timeExitMin: 20, timeExitBandPct: 0.3, breakevenPct: 0.5, cancelEntryAfterMin: 2,
  },
};

/**
 * Ambiguities in the owner's handwritten notes (vector_shared/HANDWRITTEN_NOTES_TRANSCRIPTION.md, docs/OPEN_QUESTIONS.md).
 * Preserved as open questions; the preset below picks a labelled, conservative simulation default for each.
 */
export const HANDWRITTEN_AMBIGUITIES = Object.freeze([
  Object.freeze({
    id: 'take-profit-250',
    note: '"Auto sell @ ... 250% gain" vs "auto sell @ 250% of purchase price" are not equivalent.',
    readings: { pct_of_price_250: '250% OF purchase price => exit at 2.5x entry', gain_250: '250% GAIN => exit at 3.5x entry' },
    default: 'multiple_of_entry 2.5 (the lower, more conservative target); both prices are shown on every proposal.',
    workedExampleInconsistency: 'The notes sell at $2.50 after buying at $1.22 (about 2.05x, about +105%), matching neither reading; not used as a rule.',
  }),
  Object.freeze({
    id: 'budget-50-vs-42-shares',
    note: '"$50 dollar limit" vs "42 shares @ $1.22" = $51.24, which breaches a strict $50 cap.',
    default: 'Hard cap: whole shares are sized so the estimated cost INCLUDING slippage and fees never exceeds $50 '
      + '(at a $1.22 ask with 50 bps slippage the estimate is $1.23/share => 40 shares = $49.20, not 42).',
  }),
  Object.freeze({
    id: 'stop-at-entry',
    note: '"Set stop order of (current/purchase cost)" / "if dips — sell @ $1.22 prevent loss".',
    default: 'Stop trigger placed AT the entry reference price (the decision-time IEX ask). A stop is a trigger, not a guaranteed price: '
      + 'the fill model sells at the worst observed bid in the trigger minute less slippage, so losses below entry are modelled. '
      + 'Because the bid is below the ask that was paid, a sell stop at the purchase price is usually already at/above the bid and '
      + 'triggers in the first evaluated minute after activation: this preset makes that cost (spread + slippage + fees) visible.',
    open: 'Should the stop sit below entry to reduce churn?',
  }),
  Object.freeze({
    id: 'stagnation-exit-reference',
    note: '"If not +/-10% for 15 min — sell @ current level": reference (entry, signal price or rolling) and timing are ambiguous.',
    default: 'Reference = entry FILL price; level = last IEX trade as-of; checked at every step at/after 15 minutes from the entry fill; '
      + 'exit at market while the level is within +/-10% of the reference. Alternative readings (single check at 15 minutes; rolling reference) are not implemented.',
  }),
  Object.freeze({
    id: 'price-tier-vs-example',
    note: 'Target "stocks below $1.00 per share", but the worked example buys at $1.22 after a move from $1.00.',
    default: 'The < $1.00 filter applies to the latest as-of IEX trade (the same rule as the micro segment universe and the policy '
      + 'gate\'s symbol_allowed check), so an entry at $1.22 would not be proposed and would be denied (SYMBOL_NOT_IN_SEGMENT). Not changed silently.',
    open: 'Should the price filter apply to the pre-move reference price instead?',
  }),
  Object.freeze({
    id: 'velocity-intent-volume',
    note: '"Has velocity — Buy/share count", "1.1M shares bought".',
    default: `Volume is never treated as buying intent. "Intent" is the ${BUY_SHARE_LABEL}, null when too little volume is classifiable. `
      + 'The 1.1M-share example is not used as a threshold: IEX volume is only a fraction of consolidated volume.',
  }),
]);

const HANDWRITTEN_PRESET = {
  id: 'handwritten-notes-example', version: STRATEGY_VERSION, label: STRATEGY_LABEL,
  name: 'Handwritten notes example — $50 cap, +22% in 15 min (exploratory)',
  lens: null, segment: 'micro', decisionMode: 'rules',
  description: 'The owner\'s handwritten example represented as an exploratory rule set for paper simulation only. Not validated, not an execution mandate.',
  signal: { ...COMMON_SIGNAL, windowMin: 15 },
  entry: {
    minRetPct: 22, minAccelPct: null, minRelVol: null, minBuyShare: null, requireBuyShare: false,
    minTradesW: 1, minVolumeW: null, maxSpreadBps: null, maxQuoteAgeMs: null,
    minPriceU: null, maxPriceU: 10_000, orderType: 'market', limitOffsetBps: 0,
    budgetUsd: 50, capQtyToDisplayedAsk: true, noEntryLastMin: 15,
  },
  exits: {
    stopLoss: { basis: 'at_entry_ref' },
    takeProfit: { basis: 'multiple_of_entry', multiple: 2.5, alternative: { basis: 'multiple_of_entry', multiple: 3.5, reading: '250% gain' } },
    timeExit: { minutes: 15, bandPct: 10 },
    breakevenAtGainPct: null,
  },
  management: {
    cancelEntryAfterMin: 3, maxScanSymbols: 150, maxCandidatesPerStep: 1, maxOrdersPerStep: 3,
    maxEntriesPerSymbol: 1, reentryCooldownMin: 30, intentTtlSec: 60, maxModelCallsPerStep: 1,
  },
  ambiguities: HANDWRITTEN_AMBIGUITIES,
  notes: [
    'EXPLORATORY DEFAULTS — NOT VALIDATED. Represents the handwritten example; thresholds are not empirically validated.',
    'Quote/spread freshness is left to the policy gate (maxSpreadBps/maxQuoteAgeMs null here), which is always applied.',
    ...SIGNAL_NOTES,
  ],
};

function deepFreeze(o) {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) { Object.freeze(o); for (const v of Object.values(o)) deepFreeze(v); }
  return o;
}

/** Frozen presets: six lens x segment presets keyed `${lens}-${segment}` plus `handwritten-notes-example`. */
export const PRESETS = deepFreeze({
  ...Object.fromEntries(Object.entries(LENS_PARAMS).map(([key, p]) => {
    const [lens, segment] = key.split('-');
    return [key, lensPreset(lens, segment, p)];
  })),
  'handwritten-notes-example': HANDWRITTEN_PRESET,
});

/** Mutable copy of a preset by key (or null). */
export function presetFor(key) {
  return PRESETS[key] ? clone(PRESETS[key]) : null;
}

// ---- validation ------------------------------------------------------------------------------------------------

const num = (v) => typeof v === 'number' && Number.isFinite(v);
const int = (v) => Number.isSafeInteger(v);

// Strict allow-lists per strategy level (unknown fields are rejected, like server/agents/intents.js).
const KEYS = Object.freeze({
  top: new Set(['id', 'version', 'label', 'name', 'lens', 'segment', 'decisionMode', 'description', 'signal', 'entry', 'exits', 'management', 'notes', 'ambiguities']),
  signal: new Set(['windowMin', 'minHistoryMin', 'minClassifiedShares']),
  entry: new Set(['minRetPct', 'minAccelPct', 'minRelVol', 'minBuyShare', 'requireBuyShare', 'minTradesW', 'minVolumeW', 'maxSpreadBps', 'maxQuoteAgeMs',
    'minPriceU', 'maxPriceU', 'orderType', 'limitOffsetBps', 'budgetUsd', 'capQtyToDisplayedAsk', 'noEntryLastMin']),
  exits: new Set(['stopLoss', 'takeProfit', 'timeExit', 'breakevenAtGainPct']),
  stopLoss: new Set(['basis', 'pct']),
  takeProfit: new Set(['basis', 'pct', 'multiple', 'alternative']),
  takeProfitAlternative: new Set(['basis', 'multiple', 'reading']),
  timeExit: new Set(['minutes', 'bandPct']),
  management: new Set(['cancelEntryAfterMin', 'maxScanSymbols', 'maxCandidatesPerStep', 'maxOrdersPerStep', 'maxEntriesPerSymbol', 'reentryCooldownMin',
    'intentTtlSec', 'maxModelCallsPerStep']),
});
const MAX_NAME = 120;
const MAX_DESCRIPTION = 1000;
const MAX_NOTES = 20;
const MAX_NOTE = 500;
const MAX_AMBIGUITIES = 20;
const MAX_AMBIGUITIES_BYTES = 8192;

/**
 * Validate a strategy object. Returns {ok, errors[], strategy} (strategy is a deep copy with the label enforced).
 * Strategies always carry the EXPLORATORY label and a stop-loss (risk is always bounded). Unknown fields are rejected
 * at every level (a typo such as `exits.timeexit` must not silently drop a setting).
 */
export function validateStrategy(s) {
  const e = [];
  if (!isObj(s)) return { ok: false, errors: ['strategy must be an object'], strategy: null };
  const chk = (cond, msg) => { if (!cond) e.push(msg); };
  const nullOr = (v, f) => v === null || v === undefined || f(v);
  const unknown = (obj, allowed, path) => { if (isObj(obj)) for (const k of Object.keys(obj)) if (!allowed.has(k)) e.push(`unknown field: ${path}${String(k).slice(0, 60)}`); };
  unknown(s, KEYS.top, '');
  unknown(s.signal, KEYS.signal, 'signal.');
  unknown(s.entry, KEYS.entry, 'entry.');
  unknown(s.exits, KEYS.exits, 'exits.');
  unknown(s.exits?.stopLoss, KEYS.stopLoss, 'exits.stopLoss.');
  unknown(s.exits?.takeProfit, KEYS.takeProfit, 'exits.takeProfit.');
  unknown(s.exits?.takeProfit?.alternative, KEYS.takeProfitAlternative, 'exits.takeProfit.alternative.');
  unknown(s.exits?.timeExit, KEYS.timeExit, 'exits.timeExit.');
  unknown(s.management, KEYS.management, 'management.');
  // Descriptive fields are kept (presets, stored rows and the UI round-trip them) but bounded.
  chk(nullOr(s.name, (v) => typeof v === 'string' && v.length <= MAX_NAME), `name must be a string of <= ${MAX_NAME} characters`);
  chk(nullOr(s.description, (v) => typeof v === 'string' && v.length <= MAX_DESCRIPTION), `description must be a string of <= ${MAX_DESCRIPTION} characters`);
  chk(nullOr(s.notes, (v) => Array.isArray(v) && v.length <= MAX_NOTES && v.every((x) => typeof x === 'string' && x.length <= MAX_NOTE)),
    `notes must be an array of <= ${MAX_NOTES} strings of <= ${MAX_NOTE} characters`);
  chk(s.version === undefined || (int(s.version) && s.version > 0), 'version must be a positive integer');
  chk(nullOr(s.ambiguities, (v) => Array.isArray(v) && v.length <= MAX_AMBIGUITIES && v.every(isObj) && JSON.stringify(v).length <= MAX_AMBIGUITIES_BYTES),
    `ambiguities must be an array of <= ${MAX_AMBIGUITIES} objects (<= ${MAX_AMBIGUITIES_BYTES} bytes serialized)`);
  chk(typeof s.id === 'string' && ID_RE.test(s.id), 'id must match ^[A-Za-z0-9_-:.]{1,80}$');
  chk(s.label === undefined || s.label === STRATEGY_LABEL, `label must be "${STRATEGY_LABEL}"`);
  chk(s.lens === null || s.lens === undefined || LENSES.includes(s.lens), 'lens must be cowboy | pragmatist | tightwad | null');
  chk(SEGMENTS.includes(s.segment), 'segment must be micro | large');
  chk(DECISION_MODES.includes(s.decisionMode), `decisionMode must be one of ${DECISION_MODES.join(', ')}`);

  const sg = s.signal;
  if (!isObj(sg)) e.push('signal must be an object');
  else {
    chk(int(sg.windowMin) && sg.windowMin >= 2 && sg.windowMin <= 120, 'signal.windowMin must be an integer 2..120');
    chk(int(sg.minHistoryMin) && sg.minHistoryMin >= 0 && sg.minHistoryMin <= 390, 'signal.minHistoryMin must be an integer 0..390');
    chk(int(sg.minClassifiedShares) && sg.minClassifiedShares >= 0, 'signal.minClassifiedShares must be a non-negative integer');
  }
  const en = s.entry;
  if (!isObj(en)) e.push('entry must be an object');
  else {
    chk(num(en.minRetPct), 'entry.minRetPct must be a number (percent)');
    chk(nullOr(en.minAccelPct, num), 'entry.minAccelPct must be a number or null');
    chk(nullOr(en.minRelVol, (v) => num(v) && v >= 0), 'entry.minRelVol must be >= 0 or null');
    chk(nullOr(en.minBuyShare, (v) => num(v) && v >= 0 && v <= 1), 'entry.minBuyShare must be 0..1 or null');
    chk(typeof en.requireBuyShare === 'boolean', 'entry.requireBuyShare must be boolean');
    chk(int(en.minTradesW) && en.minTradesW >= 0, 'entry.minTradesW must be a non-negative integer');
    chk(nullOr(en.minVolumeW, (v) => int(v) && v >= 0), 'entry.minVolumeW must be a non-negative integer or null');
    chk(nullOr(en.maxSpreadBps, (v) => num(v) && v > 0), 'entry.maxSpreadBps must be > 0 or null');
    chk(nullOr(en.maxQuoteAgeMs, (v) => num(v) && v > 0), 'entry.maxQuoteAgeMs must be > 0 or null');
    chk(nullOr(en.minPriceU, (v) => int(v) && v > 0), 'entry.minPriceU must be a positive integer (u) or null');
    chk(nullOr(en.maxPriceU, (v) => int(v) && v > 0), 'entry.maxPriceU must be a positive integer (u) or null');
    chk(en.orderType === 'market' || en.orderType === 'limit', 'entry.orderType must be market | limit');
    chk(int(en.limitOffsetBps) && en.limitOffsetBps >= 0 && en.limitOffsetBps <= 1000, 'entry.limitOffsetBps must be an integer 0..1000');
    chk(num(en.budgetUsd) && en.budgetUsd > 0 && en.budgetUsd <= 1_000_000, 'entry.budgetUsd must be in (0, 1000000]');
    chk(typeof en.capQtyToDisplayedAsk === 'boolean', 'entry.capQtyToDisplayedAsk must be boolean');
    chk(int(en.noEntryLastMin) && en.noEntryLastMin >= 0 && en.noEntryLastMin <= 390, 'entry.noEntryLastMin must be an integer 0..390');
  }
  const ex = s.exits;
  if (!isObj(ex)) e.push('exits must be an object');
  else {
    const sl = ex.stopLoss;
    if (!isObj(sl)) e.push('exits.stopLoss is required (risk must be bounded)');
    else if (sl.basis === 'pct_below_entry_ref') chk(num(sl.pct) && sl.pct > 0 && sl.pct < 100, 'exits.stopLoss.pct must be in (0, 100)');
    else if (sl.basis !== 'at_entry_ref') e.push('exits.stopLoss.basis must be pct_below_entry_ref | at_entry_ref');
    const tp = ex.takeProfit;
    if (tp !== null && tp !== undefined) {
      if (!isObj(tp)) e.push('exits.takeProfit must be an object or null');
      else if (tp.basis === 'pct_gain') chk(num(tp.pct) && tp.pct > 0 && tp.pct <= 10_000, 'exits.takeProfit.pct must be in (0, 10000]');
      else if (tp.basis === 'multiple_of_entry') chk(num(tp.multiple) && tp.multiple > 1 && tp.multiple <= 100, 'exits.takeProfit.multiple must be in (1, 100]');
      else e.push('exits.takeProfit.basis must be pct_gain | multiple_of_entry');
      const alt = isObj(tp) ? tp.alternative : undefined;
      if (alt !== undefined && alt !== null) {
        // Display-only alternative reading (handwritten notes); never used for orders.
        chk(isObj(alt) && alt.basis === 'multiple_of_entry' && num(alt.multiple) && alt.multiple > 1 && alt.multiple <= 100
          && nullOr(alt.reading, (v) => typeof v === 'string' && v.length <= MAX_NAME),
        'exits.takeProfit.alternative must be {basis:"multiple_of_entry", multiple in (1, 100], reading?: string}');
      }
    }
    const te = ex.timeExit;
    if (te !== null && te !== undefined) {
      if (!isObj(te)) e.push('exits.timeExit must be an object or null');
      else {
        chk(int(te.minutes) && te.minutes >= 1 && te.minutes <= 390, 'exits.timeExit.minutes must be an integer 1..390');
        chk(nullOr(te.bandPct, (v) => num(v) && v >= 0 && v <= 100), 'exits.timeExit.bandPct must be 0..100 or null (null = unconditional)');
      }
    }
    chk(nullOr(ex.breakevenAtGainPct, (v) => num(v) && v > 0), 'exits.breakevenAtGainPct must be > 0 or null');
  }
  const m = s.management;
  if (!isObj(m)) e.push('management must be an object');
  else {
    chk(nullOr(m.cancelEntryAfterMin, (v) => int(v) && v >= 1 && v <= 390), 'management.cancelEntryAfterMin must be an integer 1..390 or null');
    const rng = (k, lo, hi) => chk(int(m[k]) && m[k] >= lo && m[k] <= hi, `management.${k} must be an integer ${lo}..${hi}`);
    rng('maxScanSymbols', 1, 2000); rng('maxCandidatesPerStep', 1, 50); rng('maxOrdersPerStep', 1, 50);
    rng('maxEntriesPerSymbol', 1, 100); rng('reentryCooldownMin', 0, 390); rng('intentTtlSec', 5, 900); rng('maxModelCallsPerStep', 0, 20);
  }
  if (e.length) return { ok: false, errors: e, strategy: null };
  const out = clone(s);
  out.label = STRATEGY_LABEL;
  if (out.lens === undefined) out.lens = null;
  return { ok: true, errors: [], strategy: out };
}

function deepMerge(base, over) {
  if (!isObj(base) || !isObj(over)) return clone(over);
  const out = clone(base);
  for (const [k, v] of Object.entries(over)) out[k] = isObj(v) && isObj(base[k]) ? deepMerge(base[k], v) : clone(v);
  return out;
}

/**
 * A custom strategy derived from a preset (or any strategy) with overrides (plain objects are merged, everything else
 * replaced). The id defaults to `custom:<base>`; the EXPLORATORY label is kept. Throws TypeError when invalid.
 */
export function deriveStrategy(base, overrides = {}) {
  const b = typeof base === 'string' ? PRESETS[base] : base;
  if (!b) throw new TypeError(`unknown base strategy ${base}`);
  const merged = deepMerge(b, overrides);
  if (overrides.id === undefined) merged.id = `custom:${String(b.id).replace(/^preset:/, '')}`;
  const v = validateStrategy(merged);
  if (!v.ok) throw new TypeError(`invalid strategy: ${v.errors.join('; ')}`);
  return v.strategy;
}

// ---- signals ---------------------------------------------------------------------------------------------------

/**
 * WINDOW-ONLY aggregates for all symbols: windowAggregatesAsOf restricted to rows in [max(sessionOpen, asOf - W), asOf),
 * so the SQL scans only the window's minutes (wv, wbv, wsv, wn, wh, wl are exact; the session-to-date columns of these
 * rows cover the window only — use sessionVolumesAsOf() for session totals). Memoized in an optional per-step cache Map.
 * Returns Map sym -> aggregate row.
 */
export function windowAggregatesCached(db, ds, asOf, windowMin, sessionOpen, cache = null) {
  const from = Math.max(sessionOpen, asOf - windowMin * MINUTE);
  const key = `aggs|${ds}|${asOf}|${windowMin}|${from}`;
  if (cache && cache.has(key)) return cache.get(key);
  const m = new Map(windowAggregatesAsOf(db, ds, asOf, { windowMin, sessionOpen: from }).map((a) => [a.sym, a]));
  if (cache) cache.set(key, m);
  return m;
}

// Session-to-date volume per symbol, maintained incrementally per (db, ds, sessionOpen) while the replay clock moves
// forward: each call reads only the minutes completed since the previous call (windowAggregatesAsOf with
// sessionOpen = previous asOf), so a step late in the session does not rescan the whole day. Any backwards or
// unaligned asOf triggers a full as-of recompute. Assumes ingested market rows for a dataset are immutable (they are:
// ingestion writes complete datasets). Every read is as-of: rows with t + 60 s <= asOf only.
const sessionVolCache = new WeakMap();

/** Map sym -> session-to-date IEX volume over completed minutes in [sessionOpen, asOf). */
export function sessionVolumesAsOf(db, ds, asOf, sessionOpen) {
  let byKey = sessionVolCache.get(db);
  if (!byKey) { byKey = new Map(); sessionVolCache.set(db, byKey); }
  const key = `${ds}|${sessionOpen}`;
  const prev = byKey.get(key);
  const aligned = asOf % MINUTE === 0 && sessionOpen % MINUTE === 0;
  if (prev && prev.asOf === asOf) return prev.vol;
  let next;
  if (prev && aligned && asOf > prev.asOf) {
    const vol = new Map(prev.vol);
    for (const r of windowAggregatesAsOf(db, ds, asOf, { windowMin: 1, sessionOpen: Math.max(sessionOpen, prev.asOf) })) {
      vol.set(r.sym, (vol.get(r.sym) ?? 0) + Number(r.sv_total));
    }
    next = { asOf, vol };
  } else {
    next = { asOf, vol: new Map(windowAggregatesAsOf(db, ds, asOf, { windowMin: 1, sessionOpen }).map((r) => [r.sym, Number(r.sv_total)])) };
  }
  if (aligned) byKey.set(key, next);
  return next.vol;
}

function emptySignal(sym, asOf, W, reasons) {
  return {
    sym, asOf, windowMin: W, priceU: null, priceMinuteT: null, refPriceU: null, refMinuteT: null, midPriceU: null, midMinuteT: null,
    ret_w: null, accel: null, relVol: null, baselineMin: null, baselineVolume: null, buyShare: null, buyShareLabel: BUY_SHARE_LABEL, classifiedShare: null, classifiedVolumeW: 0,
    volumeW: 0, tradesW: 0, sessionVolume: 0, elapsedMin: 0, spreadBps: null, quoteAgeMs: null, halted: false, quote: null,
    insufficient: true, reasons,
  };
}

/**
 * Per-symbol signal metrics as of `asOf` (replay clock) using only marketdata.js as-of reads.
 * @param {{windowMin?:number, minHistoryMin?:number, minClassifiedShares?:number, cache?:Map}} cfg
 * @returns {object[]} one entry per unique symbol, in input order:
 *   {sym, priceU, ret_w, accel, relVol, buyShare, classifiedShare, volumeW, spreadBps, quoteAgeMs, halted, insufficient, reasons[],
 *    plus provenance: asOf, windowMin, priceMinuteT, refPriceU, refMinuteT, midPriceU, tradesW, sessionVolume, elapsedMin,
 *    baselineMin, baselineVolume (the relVol baseline, see RELVOL_DEFINITION), quote}
 */
export function computeSignals(db, ds, asOf, syms, cfg = {}) {
  if (!Number.isFinite(asOf)) throw new TypeError('asOf (ms UTC) is required');
  const W = Math.max(2, Math.min(120, (cfg.windowMin ?? COMMON_SIGNAL.windowMin) | 0));
  const H = Math.max(0, (cfg.minHistoryMin ?? COMMON_SIGNAL.minHistoryMin) | 0);
  const minCls = Math.max(0, cfg.minClassifiedShares ?? COMMON_SIGNAL.minClassifiedShares);
  const cache = cfg.cache instanceof Map ? cfg.cache : null;
  const list = [...new Set(syms || [])];
  const session = ds ? sessionWindow(db, ds) : null;
  if (!session) return list.map((sym) => emptySignal(sym, asOf, W, ['NO_VERIFIED_DATA']));

  const aggs = windowAggregatesCached(db, ds, asOf, W, session.open, cache);
  const sessionVol = sessionVolumesAsOf(db, ds, asOf, session.open);
  const elapsedMin = Math.max(0, Math.floor((Math.min(asOf, session.close) - session.open) / MINUTE));
  const tWinStart = asOf - W * MINUTE;            // window = [tWinStart, asOf)
  const tMid = asOf - Math.floor(W / 2) * MINUTE;

  return list.map((sym) => {
    const key = `sig|${ds}|${asOf}|${W}|${H}|${minCls}|${sym}`;
    if (cache && cache.has(key)) return cache.get(key);
    const reasons = [];
    if (asOf <= session.open) reasons.push('BEFORE_REGULAR_SESSION');
    const a = aggs.get(sym) || null;
    const volumeW = a ? Number(a.wv) : 0;
    const tradesW = a ? Number(a.wn) : 0;
    const sessionVolume = sessionVol.get(sym) ?? 0;
    if (tradesW === 0) reasons.push('NO_TRADES_IN_WINDOW');

    const last = lastTradeAsOf(db, ds, sym, asOf);
    // Last trade completed before the window start / before the half-window midpoint (minute starting <= boundary - 60 s).
    const ref = closeAtOrBefore(db, ds, sym, tWinStart - MINUTE, asOf);
    const mid = closeAtOrBefore(db, ds, sym, tMid - MINUTE, asOf);
    if (!last) reasons.push('NO_TRADE_AS_OF');
    if (!ref) reasons.push('NO_REFERENCE_PRICE');
    else {
      if (ref.minuteT < session.open) reasons.push('REFERENCE_FROM_PRE_MARKET');
      // The reference trade is older than one window before the window start: ret_w would span a longer horizon.
      if (tWinStart - (ref.minuteT + MINUTE) > W * MINUTE) reasons.push('STALE_REFERENCE');
    }
    const priceU = last ? last.priceU : null;
    const ret_w = last && ref && ref.priceU > 0 ? priceU / ref.priceU - 1 : null;
    const accel = last && ref && mid && ref.priceU > 0 && mid.priceU > 0 ? (priceU / mid.priceU - 1) - (mid.priceU / ref.priceU - 1) : null;

    // relVol: one shared definition with the scanner (relVolFrom; window excluded from its own baseline).
    const rv = relVolFrom({ windowVol: volumeW, windowMin: W, sessionVolToDate: sessionVolume, elapsedMin });
    let relVol = null;
    if (elapsedMin < H) reasons.push('RELVOL_INSUFFICIENT_HISTORY');
    else if (rv.flag) reasons.push(rv.flag);
    else relVol = rv.relVol;

    const bv = a ? Number(a.wbv) : 0;
    const sv = a ? Number(a.wsv) : 0;
    const classified = bv + sv;
    const classifiedShare = volumeW > 0 ? classified / volumeW : null;
    let buyShare = null;
    if (classified > 0 && classified >= minCls) buyShare = bv / classified;
    else if (volumeW > 0) reasons.push('LOW_CLASSIFIED_VOLUME');

    const q = quoteAsOf(db, ds, sym, asOf);
    if (!q) reasons.push('NO_QUOTE');
    else if (!q.twoSided) reasons.push('ONE_SIDED_QUOTE');
    const halted = q ? q.halted : false;
    if (halted) reasons.push('HALTED');
    const insufficient = tradesW === 0 || !last || !ref || !q || !q.twoSided || asOf <= session.open;
    const sig = {
      sym, asOf, windowMin: W,
      priceU, priceMinuteT: last ? last.minuteT : null,
      refPriceU: ref ? ref.priceU : null, refMinuteT: ref ? ref.minuteT : null,
      midPriceU: mid ? mid.priceU : null, midMinuteT: mid ? mid.minuteT : null,
      ret_w, accel, relVol, baselineMin: rv.baselineMin, baselineVolume: rv.baselineVol,
      buyShare, buyShareLabel: BUY_SHARE_LABEL, classifiedShare, classifiedVolumeW: classified,
      volumeW, tradesW, sessionVolume, elapsedMin,
      spreadBps: q ? q.spreadBps : null, quoteAgeMs: q ? q.ageMs : null, halted,
      quote: q ? { bid: q.bid, ask: q.ask, bidSize: q.bidSize, askSize: q.askSize, quoteTs: q.quoteTs, twoSided: q.twoSided, minuteRowT: q.source.minuteRowT } : null,
      insufficient, reasons,
    };
    if (cache) cache.set(key, sig);
    return sig;
  });
}

// ---- proposals -------------------------------------------------------------------------------------------------

const pct = (x, d = 1) => (x === null || x === undefined ? 'n/a' : `${(x * 100).toFixed(d)}%`);
const usd = (u) => (u === null || u === undefined ? 'n/a' : `$${(u / 10_000).toFixed(4)}`);
const tickDown = (px) => roundToTick(px, 'sell'); // never above the computed level
const tickUp = (px) => roundToTick(px, 'buy');    // never below the computed level

/**
 * Is this the documented at-entry stop (docs/OPEN_QUESTIONS.md #4)? Only a strategy whose id is in
 * policy DOCUMENTED_STOP_AT_ENTRY_STRATEGIES, with stopLoss basis 'at_entry_ref' and the 'stop-at-entry' ambiguity, may
 * place its stop at/above the as-of bid: the gate's protective_exit_required records it as INFORMATIONAL. Any other
 * strategy (incl. a renamed copy or another strategy switched to 'at_entry_ref') is denied STOP_AT_OR_ABOVE_BID by the
 * gate, so planActions / the model envelope skip such entries instead of proposing them every minute.
 */
export function documentedStopAtEntry(strategy) {
  return strategy?.exits?.stopLoss?.basis === 'at_entry_ref' && DOCUMENTED_STOP_AT_ENTRY_STRATEGIES.includes(strategy.id)
    && Array.isArray(strategy.ambiguities) && strategy.ambiguities.some((a) => a?.id === 'stop-at-entry');
}

/** Attached exit prices (integer u) from the entry reference price. */
export function exitPrices(strategy, refU) {
  const sl = strategy.exits.stopLoss;
  const stop = sl.basis === 'at_entry_ref' ? tickDown(refU) : tickDown(refU * (1 - sl.pct / 100));
  const tp = strategy.exits.takeProfit;
  let take = null;
  let takeAlt = null;
  if (tp) {
    take = tp.basis === 'pct_gain' ? tickUp(refU * (1 + tp.pct / 100)) : tickUp(refU * tp.multiple);
    if (tp.alternative && tp.alternative.basis === 'multiple_of_entry') takeAlt = tickUp(refU * tp.alternative.multiple);
  }
  return { stop, take, takeAlt };
}

/** Conservative per-share price estimate and whole-share qty within the budget (mirrors the gate's estimate). */
export function sizeEntry(strategy, quote, costModel) {
  const cm = costModel || defaultCostModel(strategy.segment);
  const en = strategy.entry;
  const limitPx = en.orderType === 'limit' ? tickUp(applyBps(quote.ask, en.limitOffsetBps, 'buy')) : null;
  const estPx = en.orderType === 'limit' ? limitPx : slippedPrice(quote.ask, 'buy', cm.slippageBps ?? 0);
  const commissionU = computeFees('buy', 1, estPx, cm).commissionU;
  const budgetU = usdToU(en.budgetUsd);
  let qty = Math.floor((budgetU - commissionU) / estPx);
  let cappedByDisplayed = false;
  if (en.capQtyToDisplayedAsk && quote.askSize > 0 && qty > quote.askSize) { qty = quote.askSize; cappedByDisplayed = true; }
  const fees = computeFees('buy', Math.max(qty, 0), estPx, cm);
  return { qty, estPx, limitPx, estCostU: Math.max(qty, 0) * estPx + fees.totalU, budgetU, cappedByDisplayed, slippageBps: cm.slippageBps ?? 0 };
}

function toMap(signals) {
  if (signals instanceof Map) return signals;
  return new Map((signals || []).map((s) => [s.sym, s]));
}

function entryRejections(s, sig, ctx) {
  const en = s.entry;
  const r = [];
  if (sig.insufficient) r.push('INSUFFICIENT_DATA');
  if (sig.halted) r.push('HALTED');
  if (sig.reasons.includes('STALE_REFERENCE')) r.push('STALE_REFERENCE');
  if (r.length) return r;
  if (sig.ret_w * 100 < en.minRetPct) r.push('RET_BELOW_MIN');
  if (en.minAccelPct !== null && (sig.accel === null || sig.accel * 100 < en.minAccelPct)) r.push('ACCEL_BELOW_MIN');
  if (en.minRelVol !== null && (sig.relVol === null || sig.relVol < en.minRelVol)) r.push(sig.relVol === null ? 'RELVOL_UNAVAILABLE' : 'RELVOL_BELOW_MIN');
  if (en.minBuyShare !== null) {
    if (sig.buyShare === null) { if (en.requireBuyShare) r.push('BUYSHARE_UNAVAILABLE'); }
    else if (sig.buyShare < en.minBuyShare) r.push('BUYSHARE_BELOW_MIN');
  }
  if (sig.tradesW < en.minTradesW) r.push('TRADES_BELOW_MIN');
  if (en.minVolumeW !== null && sig.volumeW < en.minVolumeW) r.push('VOLUME_BELOW_MIN');
  if (en.maxSpreadBps !== null && (sig.spreadBps === null || sig.spreadBps > en.maxSpreadBps)) r.push('SPREAD_ABOVE_MAX');
  if (en.maxQuoteAgeMs !== null && (sig.quoteAgeMs === null || sig.quoteAgeMs > en.maxQuoteAgeMs)) r.push('QUOTE_OLDER_THAN_STRATEGY_MAX');
  if (en.minPriceU !== null && sig.priceU < en.minPriceU) r.push('PRICE_BELOW_MIN');
  if (en.maxPriceU !== null && sig.priceU >= en.maxPriceU) r.push('PRICE_AT_OR_ABOVE_MAX');
  if (ctx.held.has(sig.sym)) r.push('ALREADY_HOLDING');
  if (ctx.openEntrySyms.has(sig.sym)) r.push('ENTRY_ALREADY_OPEN');
  if ((ctx.entriesBySym[sig.sym] ?? 0) >= s.management.maxEntriesPerSymbol) r.push('MAX_ENTRIES_PER_SYMBOL');
  const lastExit = ctx.lastExitTsBySym[sig.sym];
  if (lastExit !== undefined && ctx.clock < lastExit + MINUTE + s.management.reentryCooldownMin * MINUTE) r.push('REENTRY_COOLDOWN');
  return r;
}

function signalSnapshot(sig) {
  if (!sig) return null;
  const { sym, asOf, windowMin, priceU, priceMinuteT, refPriceU, refMinuteT, ret_w, accel, relVol, baselineMin, baselineVolume, buyShare, classifiedShare,
    volumeW, tradesW, spreadBps, quoteAgeMs, halted, quote, reasons } = sig;
  return { sym, asOf, windowMin, priceU, priceMinuteT, refPriceU, refMinuteT, ret_w, accel, relVol, baselineMin: baselineMin ?? null, baselineVolume: baselineVolume ?? null,
    buyShare, buyShareLabel: BUY_SHARE_LABEL, classifiedShare, volumeW, tradesW, spreadBps, quoteAgeMs, halted, quote, reasons };
}

const fmtInt = (n) => (Number.isFinite(n) ? String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',') : 'n/a');

/** "relVol 4.20 (window 900 sh / 15 min vs baseline 3,200 sh / 75 min)" or the reason it is unavailable. */
export function relVolText(sig) {
  if (sig.relVol === null || sig.relVol === undefined) {
    const why = (sig.reasons || []).find((r) => r.startsWith('BASELINE_') || r === 'NO_BASELINE_VOLUME' || r === 'RELVOL_INSUFFICIENT_HISTORY');
    return `relVol n/a${why ? ` (${why})` : ''}`;
  }
  return `relVol ${sig.relVol.toFixed(2)} (window ${fmtInt(sig.volumeW)} sh / ${sig.windowMin} min vs baseline ${fmtInt(sig.baselineVolume)} sh / ${fmtInt(sig.baselineMin)} min)`;
}

// Entry rejections that describe data quality rather than a threshold (not counted as near misses).
const DATA_REJECTIONS = new Set(['INSUFFICIENT_DATA', 'HALTED', 'STALE_REFERENCE']);

function m1Ref(ds, sym, t) {
  return t === null || t === undefined ? null : `iex-m1:${ds}:${sym}:${t}`;
}

/**
 * Decide this step's actions for one agent. Pure: no I/O.
 * @param {object} strategy validated strategy
 * @param {object[]|Map} signals computeSignals() output (candidates + held symbols)
 * @param {{agent:{id, portfolio_id}, ds:string, session:{open, close}, costModel?:object,
 *          positions:{sym, qty, kind, costBasisU, markU?}[], openOrders:object[],
 *          entryInfo?:Record<string,{order_id, firstFillT:number, avgFillPriceU:number, timeExit:{minutes, band_bps}|null}>,
 *          entriesBySym?:Record<string,number>, lastExitTsBySym?:Record<string,number>}} state
 * @param {number} clock replay clock (ms)
 * @returns {{actions:{kind:string, sym:string, intent:object, signal:object|null, detail:object}[], skipped:Record<string,number>,
 *   nearMisses:Record<string,number>, candidates:object[]}}
 *   kinds: cancel_stale_entry | cancel_orphan_protective | trail_stop_breakeven | time_exit | entry
 *   skipped: entry-rule rejections by reason (a symbol can fail several rules); nearMisses: symbols that failed exactly
 *   one threshold rule, keyed by that rule (explains "why no trades").
 */
export function planActions(strategy, signals, state, clock) {
  const s = strategy;
  const sigs = toMap(signals);
  const agentId = state.agent.id;
  const ds = state.ds;
  const ttl = s.management.intentTtlSec * 1000;
  const env = (quoteTs) => ({
    source: 'rules', agent_id: agentId, portfolio_id: state.agent.portfolio_id, strategy_id: s.id,
    quote_ts: Number.isSafeInteger(quoteTs) && quoteTs > 0 && quoteTs <= clock ? quoteTs : clock, created_ts: clock, expires_ts: clock + ttl,
  });
  const build = (proposal, quoteTs) => {
    const r = intentFromProposal(proposal, env(quoteTs));
    if (!r.ok) throw new Error(`strategy ${s.id} produced an invalid intent: ${r.errors.join('; ')}`);
    return r.intent;
  };
  // Deterministic order (order ids are random, so they are only the last tie-break).
  const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  const own = (state.openOrders || []).filter((o) => o.agent_id === agentId)
    .sort((a, b) => (a.created_ts - b.created_ts) || cmp(a.sym, b.sym) || cmp(a.role, b.role) || cmp(a.side, b.side) || cmp(a.type, b.type) || cmp(a.id, b.id));
  const held = new Map((state.positions || []).filter((p) => (p.kind ?? 'equity') === 'equity' && p.qty > 0).map((p) => [p.sym, p]));
  const actions = [];
  const skipped = {};
  const skip = (code) => { skipped[code] = (skipped[code] ?? 0) + 1; };
  const nearMisses = {};
  const tag = `${s.id} (${STRATEGY_LABEL})`;

  // 1. Stale unfilled entries: cancel after N minutes.
  const cancelAfter = s.management.cancelEntryAfterMin;
  if (cancelAfter) {
    for (const o of own) {
      if (o.role !== 'entry' || !['working', 'partially_filled', 'triggered'].includes(o.status)) continue;
      if (clock - o.created_ts < cancelAfter * MINUTE) continue;
      const sig = sigs.get(o.sym);
      actions.push({
        kind: 'cancel_stale_entry', sym: o.sym, signal: signalSnapshot(sig),
        detail: { order_id: o.id, ageMin: (clock - o.created_ts) / MINUTE, cancelEntryAfterMin: cancelAfter, filled_qty: o.filled_qty, qty: o.qty },
        intent: build({
          action: 'cancel', instrument: { kind: 'equity', sym: o.sym }, side: 'buy', order_type: o.type, target_order_id: o.id,
          rationale: `RULES ${tag}: entry ${o.id} unfilled ${o.qty - o.filled_qty}/${o.qty} sh after ${(clock - o.created_ts) / MINUTE} min (>= ${cancelAfter} min) -> cancel remainder. No quote used.`,
          evidence_refs: [],
        }, sig?.quote?.quoteTs),
      });
    }
  }

  // 2. Orphan protective orders (no shares left to protect): cancel.
  for (const o of own) {
    if (!o.protective || o.side !== 'sell' || !['working', 'triggered'].includes(o.status) || held.has(o.sym)) continue;
    actions.push({
      kind: 'cancel_orphan_protective', sym: o.sym, signal: signalSnapshot(sigs.get(o.sym)), detail: { order_id: o.id, role: o.role },
      intent: build({
        action: 'cancel', instrument: { kind: 'equity', sym: o.sym }, side: 'sell', order_type: o.type, target_order_id: o.id,
        rationale: `RULES ${tag}: protective ${o.role} ${o.id} has no ${o.sym} shares left to protect -> cancel. No quote used.`,
        evidence_refs: [],
      }, sigs.get(o.sym)?.quote?.quoteTs),
    });
  }

  for (const [sym, p] of held) {
    const sig = sigs.get(sym);
    const q = sig?.quote;
    const refs = [m1Ref(ds, sym, q?.minuteRowT), m1Ref(ds, sym, sig?.priceMinuteT)].filter(Boolean);
    const avgCostU = Math.ceil(p.costBasisU / p.qty);
    // 3. Trail the protective stop to breakeven once the as-of IEX bid is >= avg cost x (1 + gain).
    const be = s.exits.breakevenAtGainPct;
    if (be !== null && be !== undefined && q && q.twoSided && q.bid >= avgCostU * (1 + be / 100)) {
      const bePx = tickUp(avgCostU);
      for (const o of own) {
        if (o.sym !== sym || o.role !== 'stop_loss' || o.status !== 'working' || o.type !== 'stop') continue;
        if (!(o.stop_px < bePx) || !(bePx < q.bid)) continue;
        actions.push({
          kind: 'trail_stop_breakeven', sym, signal: signalSnapshot(sig),
          detail: { order_id: o.id, fromStopU: o.stop_px, toStopU: bePx, avgCostU, bidU: q.bid, breakevenAtGainPct: be },
          intent: build({
            action: 'modify', instrument: { kind: 'equity', sym }, side: 'sell', order_type: 'stop', stop_px_u: bePx, target_order_id: o.id,
            rationale: `RULES ${tag}: IEX bid ${usd(q.bid)} >= avg cost ${usd(avgCostU)} x ${(1 + be / 100).toFixed(4)} -> move stop ${usd(o.stop_px)} to breakeven ${usd(bePx)} (trigger, not a guaranteed price).`,
            evidence_refs: refs,
          }, q.quoteTs),
        });
      }
    }
    // 4. Time exit (stagnation): at/after N minutes from the entry fill, sell at market while the last IEX trade is within
    //    +/- band of the entry fill price (band null => unconditional). This is an agent-monitored RULE, not a standing
    //    order: it is evaluated only while the agent is RUNNING (controls.js journals TIME_EXIT_SUSPENDED otherwise); a
    //    deadline missed while not RUNNING is evaluated at the first step after resume (detail.lateByMin).
    const info = state.entryInfo?.[sym];
    if (info && info.timeExit && Number.isFinite(info.firstFillT)) {
      const deadline = info.firstFillT + MINUTE + info.timeExit.minutes * MINUTE;
      const pendingExit = own.some((o) => o.sym === sym && (o.role === 'time_exit' || o.role === 'exit') && ['working', 'triggered', 'partially_filled'].includes(o.status));
      if (clock >= deadline && !pendingExit) {
        const level = sig?.priceU ?? (q?.twoSided ? q.bid : null);
        const band = info.timeExit.band_bps;
        const moveBps = level && info.avgFillPriceU > 0 ? Math.abs(level / info.avgFillPriceU - 1) * 10_000 : null;
        const within = band === null || band === undefined ? true : moveBps !== null && moveBps < band;
        if (level === null && band !== null && band !== undefined) skip('TIME_EXIT_NO_LEVEL');
        else if (within) {
          actions.push({
            kind: 'time_exit', sym, signal: signalSnapshot(sig),
            detail: { deadline, lateByMin: Math.floor((clock - deadline) / MINUTE), minutes: info.timeExit.minutes, band_bps: band ?? null, levelU: level,
              entryFillPriceU: info.avgFillPriceU, moveBps, qty: p.qty, entry_order_id: info.order_id },
            intent: build({
              action: 'close', instrument: { kind: 'equity', sym }, side: 'sell', order_type: 'market', qty: p.qty,
              rationale: `RULES ${tag}: time exit — ${info.timeExit.minutes} min since entry fill; last IEX trade ${usd(level)} vs entry fill ${usd(info.avgFillPriceU)} `
                + `(${moveBps === null ? 'n/a' : (moveBps / 100).toFixed(2) + '%'} move) ${band === null || band === undefined ? 'unconditional' : `within +/-${(band / 100).toFixed(2)}%`} -> sell ${p.qty} at market (estimated fill; may be withheld if unfillable).`,
              evidence_refs: refs,
            }, q?.quoteTs),
          });
        }
      }
    }
  }

  // 5. New entries.
  const entryCtx = {
    clock, held,
    openEntrySyms: new Set(own.filter((o) => o.role === 'entry' && ['working', 'partially_filled', 'triggered', 'pending_parent'].includes(o.status)).map((o) => o.sym)),
    entriesBySym: state.entriesBySym || {}, lastExitTsBySym: state.lastExitTsBySym || {},
  };
  const session = state.session;
  const entryWindowOpen = session && clock > session.open && clock < session.close - s.entry.noEntryLastMin * MINUTE;
  const candidates = [];
  for (const sig of sigs.values()) {
    if (held.has(sig.sym) && sig.insufficient) continue; // monitoring-only symbol
    const rej = entryRejections(s, sig, entryCtx);
    if (!entryWindowOpen) rej.push('OUTSIDE_ENTRY_WINDOW');
    if (rej.length) {
      rej.forEach(skip);
      if (rej.length === 1 && !DATA_REJECTIONS.has(rej[0])) nearMisses[rej[0]] = (nearMisses[rej[0]] ?? 0) + 1;
      continue;
    }
    candidates.push(sig);
  }
  candidates.sort((a, b) => (b.ret_w - a.ret_w) || ((b.relVol ?? -1) - (a.relVol ?? -1)) || (a.sym < b.sym ? -1 : a.sym > b.sym ? 1 : 0));
  for (const sig of candidates.slice(0, s.management.maxCandidatesPerStep)) {
    const q = sig.quote;
    const size = sizeEntry(s, q, state.costModel);
    if (size.qty < 1) { skip('BUDGET_BELOW_ONE_SHARE'); continue; }
    const ref = q.ask;
    const px = exitPrices(s, ref);
    if (px.stop < 1) { skip('STOP_BELOW_MIN_TICK'); continue; }
    const stopAtOrAboveBid = px.stop >= q.bid;
    // The documented handwritten example's 'at_entry_ref' stop ("stop at purchase price") deliberately places the trigger
    // at the decision-time ask; it is NOT skipped (owner decision pending, docs/OPEN_QUESTIONS.md #4; the gate records it
    // as INFORMATIONAL) but the consequence is disclosed below. Every other strategy — including any other 'at_entry_ref'
    // one, which the gate denies STOP_AT_OR_ABOVE_BID — skips the candidate.
    if (stopAtOrAboveBid && !documentedStopAtEntry(s)) { skip('STOP_AT_OR_ABOVE_BID'); continue; }
    const stopVsBidBps = q.bid > 0 ? Math.round(((px.stop - q.bid) / q.bid) * 10_000) : null;
    const attach = { stop_loss_px_u: px.stop };
    if (px.take !== null) attach.take_profit_px_u = px.take;
    const te = s.exits.timeExit;
    if (te) {
      attach.time_exit_min = te.minutes;
      if (te.bandPct !== null && te.bandPct !== undefined) attach.time_exit_band_bps = Math.round(te.bandPct * 100);
    }
    const tpTxt = px.take === null ? 'none'
      : s.exits.takeProfit.basis === 'pct_gain' ? `${usd(px.take)} (+${s.exits.takeProfit.pct}% of ask ref)`
        : `${usd(px.take)} (${s.exits.takeProfit.multiple}x ask ref${px.takeAlt ? `; alternative reading ${s.exits.takeProfit.alternative.reading ?? ''} ${s.exits.takeProfit.alternative.multiple}x = ${usd(px.takeAlt)}, not used` : ''})`;
    const slTxt = s.exits.stopLoss.basis === 'at_entry_ref' ? `${usd(px.stop)} (at entry ref)` : `${usd(px.stop)} (${s.exits.stopLoss.pct}% below ask ref)`;
    const stopWarn = stopAtOrAboveBid
      ? ` WARNING: stop ${usd(px.stop)} is at/above the as-of IEX bid ${usd(q.bid)} (${stopVsBidBps} bps above): expected to trigger on the first evaluated minute after activation `
        + '(spread-induced; modelled loss ~ spread + slippage + fees, not a price move).'
      : '';
    const rationale = `RULES ${tag}: ret_w ${pct(sig.ret_w)} over ${sig.windowMin} min (ref ${usd(sig.refPriceU)} -> last ${usd(sig.priceU)}), accel ${pct(sig.accel)}, `
      + `${relVolText(sig)}, ${BUY_SHARE_LABEL} ${sig.buyShare === null ? 'n/a (insufficient classified volume)' : pct(sig.buyShare)}, `
      + `IEX spread ${sig.spreadBps} bps, quote age ${Math.round(sig.quoteAgeMs / 1000)} s. Buy ${size.qty} sh ${s.entry.orderType}${size.limitPx ? ` @ ${usd(size.limitPx)}` : ''} `
      + `(est ${usd(size.estPx)}/sh incl ${size.slippageBps} bps slippage; est cost ${usd(size.estCostU)} <= budget ${usd(size.budgetU)}${size.cappedByDisplayed ? '; capped to displayed ask size' : ''}). `
      + `Stop ${slTxt} — trigger, not a guaranteed price.${stopWarn} Take-profit ${tpTxt}.${te ? ` Time exit ${te.minutes} min${te.bandPct !== null && te.bandPct !== undefined ? ` if within +/-${te.bandPct}%` : ''}.` : ''} Signal metrics are not recommendations.`;
    const proposal = {
      action: 'open', instrument: { kind: 'equity', sym: sig.sym }, side: 'buy', qty: size.qty, budget_usd: s.entry.budgetUsd,
      order_type: s.entry.orderType, attach, rationale: rationale.slice(0, 2000),
      evidence_refs: [m1Ref(ds, sig.sym, q.minuteRowT), m1Ref(ds, sig.sym, sig.priceMinuteT), m1Ref(ds, sig.sym, sig.refMinuteT)].filter(Boolean),
    };
    if (size.limitPx) proposal.limit_px_u = size.limitPx;
    actions.push({
      kind: 'entry', sym: sig.sym, signal: signalSnapshot(sig),
      detail: {
        refAskU: ref, bidU: q.bid, estPxU: size.estPx, estCostU: size.estCostU, budgetU: size.budgetU, stopU: px.stop, takeProfitU: px.take, takeProfitAltU: px.takeAlt,
        cappedByDisplayed: size.cappedByDisplayed, stopAtOrAboveBid, stopVsBidBps,
      },
      intent: build(proposal, q.quoteTs),
    });
  }
  return { actions, skipped, nearMisses, candidates: candidates.map(signalSnapshot) };
}

/** Contract form: the TradeIntents (source 'rules') a strategy proposes for this step. */
export function proposeIntents(strategy, signals, state, clock) {
  return planActions(strategy, signals, state, clock).actions.map((a) => a.intent);
}
