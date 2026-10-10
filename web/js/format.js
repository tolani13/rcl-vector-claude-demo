// Pure formatting helpers (no DOM). Mirrors the server's units: prices/money are integer u = 1e-4 USD,
// timestamps are ms UTC and are displayed in America/New_York. Missing values format as an em dash; callers
// are responsible for showing an explicit status when a whole datum is unavailable.
export const U_PER_USD = 10000;
export const ET = 'America/New_York';
export const DASH = '—';

export const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
/** Coerce numeric strings from the API to numbers; anything else -> null. */
export function num(x) {
  if (isNum(x)) return x;
  if (typeof x === 'string' && x.trim() !== '' && Number.isFinite(Number(x))) return Number(x);
  return null;
}
export const arr = (x) => (Array.isArray(x) ? x : []);
export const obj = (x) => (x && typeof x === 'object' && !Array.isArray(x) ? x : null);

/** Parse a JSON string field defensively (e.g. payload_json); returns the value or null. */
export function parseMaybeJson(x) {
  if (typeof x !== 'string') return x ?? null;
  try { return JSON.parse(x); } catch { return null; }
}

/** Money in u -> dollar string with grouping; 4 decimals below one dollar (like the server's fmtUsd). */
export function fmtUsdU(u, { sign = false } = {}) {
  if (!isNum(u)) return DASH;
  const usd = u / U_PER_USD;
  const abs = Math.abs(usd);
  const digits = abs !== 0 && abs < 1 ? 4 : 2;
  const s = abs.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
  const pre = usd < 0 ? '-' : sign && usd > 0 ? '+' : '';
  return `${pre}$${s}`;
}

/** Price in u -> 4 decimals below one dollar (sub-penny ticks are valid there), 2 decimals otherwise. */
export function fmtPriceU(u) {
  if (!isNum(u)) return DASH;
  const usd = u / U_PER_USD;
  const digits = Math.abs(usd) < 1 ? 4 : 2;
  return `${usd < 0 ? '-' : ''}$${Math.abs(usd).toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
}

export function usdToU(usd) {
  const n = num(usd);
  return n === null ? null : Math.round(n * U_PER_USD);
}

const partsFmt = new Intl.DateTimeFormat('en-US', {
  timeZone: ET, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit',
});
function etParts(ms) {
  const p = Object.fromEntries(partsFmt.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return { y: p.year, mo: p.month, d: p.day, h: p.hour, mi: p.minute, s: p.second };
}

/** ms UTC -> "09:31 ET" / "2026-10-07 09:31:05 ET". */
export function fmtEt(ms, { seconds = false, date = false } = {}) {
  const n = num(ms);
  if (n === null) return DASH;
  const p = etParts(n);
  const time = `${p.h}:${p.mi}${seconds ? ':' + p.s : ''}`;
  return date ? `${p.y}-${p.mo}-${p.d} ${time} ET` : `${time} ET`;
}
export function fmtEtDate(ms) {
  const n = num(ms);
  if (n === null) return DASH;
  const p = etParts(n);
  return `${p.y}-${p.mo}-${p.d}`;
}
/** Short ET time for chart axes: "09:30". */
export function fmtEtHm(ms) {
  const n = num(ms);
  if (n === null) return '';
  const p = etParts(n);
  return `${p.h}:${p.mi}`;
}
/** Browser-local wall-clock time, used only for "fetched at" receipts. */
export function fmtLocalTime(ms) {
  const n = num(ms);
  if (n === null) return DASH;
  return new Date(n).toLocaleTimeString('en-US', { hour12: false }) + ' local';
}

export function fmtInt(n) {
  const v = num(n);
  return v === null ? DASH : Math.round(v).toLocaleString('en-US');
}
export function fmtNum(n, digits = 2) {
  const v = num(n);
  if (v === null) return DASH;
  return v.toLocaleString('en-US', { maximumFractionDigits: digits });
}
/** Share counts: 1,234 / 12.3K / 4.56M. */
export function fmtShares(n) {
  const v = num(n);
  if (v === null) return DASH;
  const a = Math.abs(v);
  if (a >= 1e9) return `${(v / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `${(v / 1e6).toFixed(2)}M`;
  if (a >= 1e4) return `${(v / 1e3).toFixed(1)}K`;
  return Math.round(v).toLocaleString('en-US');
}

/** Percent value (already in percent units) -> "+1.23%". */
export function fmtPct(pct, { digits = 2, sign = true } = {}) {
  const v = num(pct);
  if (v === null) return DASH;
  const s = Math.abs(v).toFixed(digits);
  const pre = v < 0 ? '−' : sign && v > 0 ? '+' : '';
  return `${pre}${s}%`;
}
/** Fraction (0.0123) -> "+1.23%". */
export function fmtFracPct(f, opts) {
  const v = num(f);
  return v === null ? DASH : fmtPct(v * 100, opts);
}
export function fmtBps(b) {
  const v = num(b);
  return v === null ? DASH : `${Math.round(v).toLocaleString('en-US')} bps`;
}
export function fmtRatio(x) {
  const v = num(x);
  return v === null ? DASH : `${v.toFixed(2)}×`;
}
/**
 * Relative volume for display. Same-day baselines can be tiny (a few shares), which yields ratios in the tens of
 * thousands; those are shown as ">999×" (callers put the exact value in a title attribute). The data is not altered.
 */
export const REL_VOL_DISPLAY_CAP = 999;
export function fmtRelVol(x) {
  const v = num(x);
  if (v === null) return DASH;
  if (v > REL_VOL_DISPLAY_CAP) return `>${REL_VOL_DISPLAY_CAP}×`;
  return v >= 100 ? `${Math.round(v)}×` : `${v.toFixed(2)}×`;
}
export function fmtAge(ms) {
  const v = num(ms);
  if (v === null) return DASH;
  if (v < 0) return 'future (rejected)';
  const s = Math.round(v / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

/** Direction helpers: colour is never the only cue — always pair with the arrow/sign. */
export function direction(x) {
  const v = num(x);
  if (v === null || v === 0) return 'flat';
  return v > 0 ? 'up' : 'down';
}
export function arrow(x) {
  const d = direction(x);
  return d === 'up' ? '▲' : d === 'down' ? '▼' : '■';
}

export function shortHash(h, n = 12) {
  return typeof h === 'string' && h.length > n ? `${h.slice(0, n)}…` : (h ?? DASH);
}

export function humanizeKey(k) {
  const s = String(k)
    .replace(/_json$/, '')
    .replace(/([a-z0-9])([A-Z])/g, (_, a, b) => `${a} ${b}`)
    .replace(/[_-]+/g, ' ')
    .trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// ---------------------------------------------------------------- status vocabulary (docs/CONTRACTS.md)
export const DATA_STATUSES = ['LIVE_VERIFIED', 'DELAYED_REAL', 'HISTORICAL_REAL', 'IMPORTED_UNVERIFIED', 'NO_VERIFIED_DATA', 'PROVIDER_FAULT', 'BLOCKED'];
export const OTHER_STATUSES = ['MODEL_DISCONNECTED', 'ASSESSMENT_NOT_RUN', 'NO_VERIFIED_OPTIONS_DATA', 'UNAVAILABLE_NOT_VERIFIED', 'SUPPORTED_VERIFIED',
  'CONNECTED', 'DISCONNECTED', 'FAULT', 'PAUSED', 'RUNNING', 'FAULTED', 'STOPPED', 'ACCEPTED', 'DENIED',
  'OK', 'INVALID_OUTPUT', 'REFUSED', 'ERROR', 'UNMARKED', 'LAST_TRADE_NO_BID', 'IEX_BID', 'UNFILLABLE'];
const STATUS_SET = new Set([...DATA_STATUSES, ...OTHER_STATUSES]);
export function isStatusCode(s) {
  return typeof s === 'string' && (STATUS_SET.has(s) || /^[A-Z][A-Z0-9]*(_[A-Z0-9]+)+$/.test(s));
}

const TONES = {
  ok: ['LIVE_VERIFIED', 'HISTORICAL_REAL', 'DELAYED_REAL', 'CONNECTED', 'RUNNING', 'ACCEPTED', 'OK', 'SUPPORTED_VERIFIED',
    'complete', 'filled', 'IEX_BID', 'consider_entry', 'CHAIN_VERIFIED'],
  warn: ['IMPORTED_UNVERIFIED', 'NO_VERIFIED_DATA', 'DISCONNECTED', 'MODEL_DISCONNECTED', 'ASSESSMENT_NOT_RUN', 'NO_VERIFIED_OPTIONS_DATA',
    'PAUSED', 'partial', 'LAST_TRADE_NO_BID', 'insufficient_evidence', 'working', 'pending_parent', 'triggered', 'partially_filled',
    'INVALID_OUTPUT', 'REFUSED', 'BLOCKED', 'watch'],
  bad: ['PROVIDER_FAULT', 'FAULT', 'FAULTED', 'STOPPED', 'DENIED', 'ERROR', 'failed', 'rejected', 'unfillable', 'UNFILLABLE', 'UNMARKED',
    'API_UNREACHABLE', 'API UNREACHABLE', 'avoid', 'CHAIN_BROKEN', 'KILL SWITCH ENGAGED'],
  neutral: ['UNAVAILABLE_NOT_VERIFIED', 'cancelled', 'expired', 'NONE RETURNED'],
};
/** Plain-language explanations shown as tooltips next to status codes (the codes themselves stay visible). */
export const STATUS_HELP = Object.freeze({
  HISTORICAL_REAL: 'Replay of stored, sourced historical data — not live.',
  LIVE_VERIFIED: 'Live data from an entitled, verified feed.',
  DELAYED_REAL: 'Real data from a verified feed, delayed.',
  IMPORTED_UNVERIFIED: 'Imported by a user; provenance not verified.',
  NO_VERIFIED_DATA: 'No verified data source covers this item — nothing is shown in its place.',
  PROVIDER_FAULT: 'The data provider returned an error.',
  BLOCKED: 'Blocked: a required configuration or entitlement is missing.',
  UNAVAILABLE_NOT_VERIFIED: 'Not available from any verified source.',
  IEX_BID: 'Marked at the IEX bid as of the replay clock.',
  LAST_TRADE_NO_BID: 'No two-sided IEX quote: marked at the last IEX trade instead of the bid.',
  UNMARKED: 'Neither a bid nor a trade is available; excluded from equity.',
  NO_VERIFIED_OPTIONS_DATA: 'No verified options data provider; options orders are disabled.',
  MODEL_DISCONNECTED: 'No model provider is connected; model-driven features are disabled.',
});

const TONE_OF = new Map(Object.entries(TONES).flatMap(([tone, list]) => list.map((c) => [c, tone])));
/** Visual tone for a status string: ok | warn | bad | neutral | copper. */
export function statusTone(code) {
  if (typeof code !== 'string') return 'neutral';
  return TONE_OF.get(code) || TONE_OF.get(code.toUpperCase()) || 'neutral';
}

export const LENSES = Object.freeze([
  { id: 'cowboy', label: 'Cowboy', sub: 'Aggressive' },
  { id: 'pragmatist', label: 'Pragmatist', sub: 'Moderate' },
  { id: 'tightwad', label: 'Tightwad', sub: 'Very conservative' },
]);
// Order matters: segment switches render in this order. 'low' is the server's under-5-USD price tier, offered as a
// labelled small-cap PROXY (it includes the penny tier; market cap is not verified — no shares-outstanding data).
export const SEGMENT_LABELS = Object.freeze({ micro: 'Penny / microcap', low: 'Under 5 USD · small-cap proxy', large: 'Large-cap' });
/** Short labels for the segment switch buttons (phone width); the full label is the button title. */
export const SEGMENT_SHORT = Object.freeze({ micro: 'Penny / micro', low: 'Under 5 USD', large: 'Large-cap' });
export const SEGMENT_NOTES = Object.freeze({
  low: 'Under-5-USD price tier used as a small-cap proxy: it includes the penny tier, and market cap is NOT verified (no shares-outstanding data is ingested).',
});
/** A stored segment preference, or 'micro'. */
export function segmentPref(v) {
  return typeof v === 'string' && Object.hasOwn(SEGMENT_LABELS, v) ? v : 'micro';
}

// ---------------------------------------------------------------- plain-language labels for machine codes

/** Turn an UPPER_SNAKE code into a readable phrase ("SPREAD_ABOVE_MAX" -> "Spread above max"). */
export function humanizeCode(code) {
  const s = String(code ?? '').replace(/_+/g, ' ').trim().toLowerCase();
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : DASH;
}

/** Scanner data-quality reasons (server/research/scanner.js). */
export const REASON_LABELS = Object.freeze({
  QUOTE_STALE: 'Stale quote',
  LOW_CLASSIFIED_VOLUME: 'Low classified volume',
  NO_TRADES_IN_WINDOW: 'No trades in window',
  NO_REFERENCE_PRICE: 'No reference price',
  BASELINE_TOO_SHORT: 'Baseline too short',
  NO_BASELINE_VOLUME: 'No baseline volume',
  NO_QUOTE: 'No quote',
  ONE_SIDED_QUOTE: 'One-sided quote',
  HALTED: 'Halted',
  BEFORE_REGULAR_SESSION: 'Before regular session',
});
export const reasonLabel = (code) => REASON_LABELS[code] ?? humanizeCode(code);

/** Agent scan skip codes (server/agents/strategies.js entryRejections / planActions). */
export const SKIP_LABELS = Object.freeze({
  OUTSIDE_ENTRY_WINDOW: 'entry window closed',
  RET_BELOW_MIN: 'window return below strategy minimum',
  ACCEL_BELOW_MIN: 'acceleration below minimum',
  RELVOL_BELOW_MIN: 'relative volume below minimum',
  RELVOL_UNAVAILABLE: 'relative volume not computable',
  BUYSHARE_BELOW_MIN: 'inferred buy share below minimum',
  BUYSHARE_UNAVAILABLE: 'inferred buy share not computable',
  TRADES_BELOW_MIN: 'too few trades in window',
  VOLUME_BELOW_MIN: 'window volume below minimum',
  SPREAD_ABOVE_MAX: 'IEX spread wider than strategy maximum',
  QUOTE_OLDER_THAN_STRATEGY_MAX: 'quote older than strategy maximum',
  PRICE_BELOW_MIN: 'price below strategy minimum',
  PRICE_AT_OR_ABOVE_MAX: 'price at or above strategy maximum',
  INSUFFICIENT_DATA: 'insufficient data',
  HALTED: 'halted',
  STALE_REFERENCE: 'stale reference price',
  ALREADY_HOLDING: 'already holding',
  ENTRY_ALREADY_OPEN: 'entry order already open',
  MAX_ENTRIES_PER_SYMBOL: 'max entries per symbol reached',
  REENTRY_COOLDOWN: 're-entry cooldown',
  BUDGET_BELOW_ONE_SHARE: 'budget below one share',
  STOP_BELOW_MIN_TICK: 'stop below minimum tick',
  STOP_AT_OR_ABOVE_BID: 'stop at or above bid',
});
export const skipLabel = (code) => SKIP_LABELS[code] ?? humanizeCode(code).toLowerCase();

/** Plain-language agent state reasons (codes and phrases written by server/controls.js and the runner). */
const STATE_REASON_TEXT = [
  [/authority not implicitly resumed after restart/i, 'Paused after a server restart — authority is never resumed automatically. Press Resume (or Start) to grant it again.'],
];
export function stateReasonText(r) {
  if (r === null || r === undefined || r === '') return null;
  const s = String(r);
  for (const [re, text] of STATE_REASON_TEXT) if (re.test(s)) return text;
  return s;
}

/**
 * Security type inferred from the listed issue name (Nasdaq Trader symbol directory). The directory was fetched after
 * the replay date, so this is descriptive metadata, never an as-of fact. Returns {code, label} or null (common stock /
 * unknown).
 */
export function securityTypeFromName(name) {
  if (typeof name !== 'string' || !name) return null;
  if (/\bwarrants?\b/i.test(name)) return { code: 'WARRANT', label: 'Warrant' };
  if (/\brights?\b/i.test(name)) return { code: 'RIGHT', label: 'Right' };
  if (/\bunits?\b/i.test(name)) return { code: 'UNIT', label: 'Unit' };
  if (/\bpreferred\b|\bpfd\b/i.test(name)) return { code: 'PREFERRED', label: 'Preferred' };
  if (/\bdepositary\b/i.test(name) || /\bAD[RS]\b/.test(name)) return { code: 'ADR', label: 'ADR / ADS' };
  if (/\bnotes? due\b|\bdebentures?\b|\bsenior notes?\b/i.test(name)) return { code: 'DEBT', label: 'Debt' };
  return null;
}
export const SECURITY_TYPE_NOTE = 'Security type inferred from the listed issue name in the Nasdaq Trader symbol directory (fetched after the replay date); descriptive only, not an as-of fact.';

// Server classification (scanner rows' securityType.type, server/data/ingest/nasdaq-symdir.js classifySecurity).
// Common-equity-like types (common, unknown) get no badge.
const SERVER_SECURITY_TYPES = Object.freeze({
  adr: { code: 'ADR', label: 'ADR / ADS' }, etf: { code: 'ETF', label: 'ETF / ETN' }, preferred: { code: 'PREFERRED', label: 'Preferred' },
  warrant: { code: 'WARRANT', label: 'Warrant' }, right: { code: 'RIGHT', label: 'Right' }, unit: { code: 'UNIT', label: 'Unit' },
  debt: { code: 'DEBT', label: 'Debt' }, other: { code: 'OTHER', label: 'Other instrument' },
});

/**
 * Security-type badge for a scanner row: the server's classification when the row carries one (the same one the
 * instruments filter uses), else the name heuristic. {code, label, basis} or null (common stock / unclassified).
 */
export function securityTypeOf(row) {
  const st = row && typeof row.securityType === 'object' && row.securityType ? row.securityType : null;
  if (st && typeof st.type === 'string') {
    const t = SERVER_SECURITY_TYPES[st.type];
    if (!t) return null;
    const basis = typeof st.basis === 'string' ? st.basis : null;
    return { ...t, basis: `${basis ? `Server classification (${basis})` : 'Server classification'}${st.postDated ? '; directory snapshot published after the replay clock' : ''}. Descriptive only, not an as-of fact.` };
  }
  return securityTypeFromName(typeof row?.name === 'string' ? row.name : null);
}

/** Readable fill-model enums (server/sim/fills.js). Unknown values fall back to a humanized phrase. */
const FILL_ENUM_TEXT = {
  WORST_IN_MINUTE: 'Worst price observed in the minute',
  REG_NMS_612_ROUNDED_AGAINST_TRADER: 'Rounded to a valid tick, against the trader (Reg NMS Rule 612)',
  EACH_COMPONENT_UP_TO_WHOLE_U: 'Each fee component rounded up to the next 1/100 cent',
  DISPLAYED: 'Displayed IEX quote size',
  TRADE_THROUGH: 'IEX volume traded through the price in the minute',
  DISPLAYED_SIZE: 'displayed size',
  MINUTE_IEX_VOLUME: 'IEX volume in the minute',
  POSITION_HELD: 'shares held',
  CASH_AT_ESTIMATED_PRICE: 'cash at the estimated price',
  MARKET_BUY_WORST_ASK_IN_MINUTE: 'Market buy: highest ask observed in the minute, plus slippage',
  MARKET_SELL_WORST_BID_IN_MINUTE: 'Market sell: lowest bid observed in the minute, less slippage',
  'STOP_SELL_TRIGGERED_FILL_AT_MIN(STOP, WORST_BID)': 'Stop triggered: filled at the lower of the stop and the worst bid in the minute, less slippage',
  'STOP_BUY_TRIGGERED_FILL_AT_MAX(STOP, WORST_ASK)': 'Stop triggered: filled at the higher of the stop and the worst ask in the minute, plus slippage',
  TRIGGERED_STOP_SELL_RETRY_AS_MARKET_WORST_BID: 'Previously triggered stop retried as a market sell at the worst bid',
  TRIGGERED_STOP_BUY_RETRY_AS_MARKET_WORST_ASK: 'Previously triggered stop retried as a market buy at the worst ask',
  LIMIT_BUY_WORST_ASK_AT_OR_BELOW_LIMIT: 'Limit buy: worst ask in the minute at or below the limit',
  LIMIT_BUY_STRICT_TRADE_THROUGH_FILL_AT_LIMIT: 'Limit buy: trades printed strictly through the limit; filled at the limit',
  LIMIT_SELL_WORST_BID_AT_OR_ABOVE_LIMIT: 'Limit sell: worst bid in the minute at or above the limit',
  LIMIT_SELL_STRICT_TRADE_THROUGH_FILL_AT_LIMIT: 'Limit sell: trades printed strictly through the limit; filled at the limit',
};
export function fillEnumText(v) {
  if (typeof v !== 'string') return v;
  if (FILL_ENUM_TEXT[v]) return FILL_ENUM_TEXT[v];
  if (v.startsWith('STOP_LIMIT_') && FILL_ENUM_TEXT[v.slice(11)]) return `Stop-limit (after trigger) — ${FILL_ENUM_TEXT[v.slice(11)]}`;
  return /^[A-Z][A-Z0-9_()., ]+$/.test(v) ? humanizeCode(v) : v;
}

/** Portfolio ids fixed by docs/CONTRACTS.md §3 (configuration, not market data). */
export const PORTFOLIO_IDS = Object.freeze(['cowboy-micro', 'pragmatist-micro', 'tightwad-micro', 'cowboy-large', 'pragmatist-large', 'tightwad-large', 'sandbox']);
export function portfolioLabel(id, name) {
  if (name) return name;
  if (id === 'sandbox') return 'Sandbox (human)';
  const [lens, seg] = String(id || '').split('-');
  const l = LENSES.find((x) => x.id === lens);
  return l ? `${l.label} · ${seg === 'large' ? 'Large-cap' : seg === 'micro' ? 'Microcap' : seg}` : String(id ?? DASH);
}
