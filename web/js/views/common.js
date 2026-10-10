// Helpers shared by several views: response normalisers and the opportunity row renderers.
import { h, replace } from '../dom.js';
import * as api from '../api.js';
import { badge, rtable, signed, errorBlock, loading, statusBlock, kv } from '../components.js';
import {
  arr, obj, num, isNum, fmtPriceU, fmtEt, fmtFracPct, fmtRelVol, fmtBps, fmtAge, fmtShares, fmtInt, fmtNum, reasonLabel,
  securityTypeOf, SECURITY_TYPE_NOTE, DASH,
} from '../format.js';

export const SIGNAL_LABEL = 'SIGNAL METRICS — NOT RECOMMENDATIONS';

// ---------------------------------------------------------------- ranking options (GET /api/research/opportunities)
// windowMin = the return window the scanner ranks on (server WINDOW_VALUES); instruments = all | common | non_common.
export const HORIZON_MINUTES = Object.freeze([5, 15, 30, 60]);
export const DEFAULT_WINDOW_MIN = 15;
export const INSTRUMENT_CHOICES = Object.freeze([['all', 'All', 'Every instrument; non-common instruments rank after common stock'],
  ['common', 'Common', 'Common stock, ADRs and unclassified symbols only'], ['non_common', 'Non-common', 'Warrants, rights, units, preferreds, ETFs/ETNs and notes only']]);
export const INSTRUMENT_TEXT = Object.freeze({ all: 'all instruments', common: 'common stock only', non_common: 'non-common instruments only' });

/** A stored horizon preference (minutes), or the server default. */
export function windowPref(v) {
  const n = Number(v);
  return HORIZON_MINUTES.includes(n) ? n : DEFAULT_WINDOW_MIN;
}

/** A stored instruments preference, or 'all'. */
export function instrumentsPref(v) {
  return INSTRUMENT_CHOICES.some(([id]) => id === v) ? v : 'all';
}

/**
 * Query for GET /api/research/opportunities. An option is sent only when it differs from the server default and the
 * server has not rejected it (unsupported.windowMin / unsupported.instruments), so an older API still answers.
 */
export function oppParams({ segment, limit, windowMin, instruments, unsupported = {} } = {}) {
  const p = { segment, limit };
  const w = windowPref(windowMin);
  const i = instrumentsPref(instruments);
  if (!unsupported.windowMin && w !== DEFAULT_WINDOW_MIN) p.windowMin = w;
  if (!unsupported.instruments && i !== 'all') p.instruments = i;
  return p;
}

/** One line describing the instrument mix of a ranked list, from the response counts. null when nothing to say. */
export function instrumentNote(d, instruments) {
  const c = obj(obj(d)?.counts) || {};
  const nonCommon = num(c.nonCommon);
  const filteredOut = num(c.filteredOut);
  if (instruments !== 'all' && isNum(filteredOut) && filteredOut > 0) {
    return `${fmtInt(filteredOut)} symbol${filteredOut === 1 ? '' : 's'} hidden by the instrument filter (${INSTRUMENT_TEXT[instruments] ?? instruments}).`;
  }
  if (instruments === 'all' && isNum(nonCommon) && nonCommon > 0) {
    return `${fmtInt(nonCommon)} non-common instrument${nonCommon === 1 ? '' : 's'} (warrants, rights, units, preferreds, ETFs, notes) rank after common stock.`;
  }
  return null;
}
export const BUYSHARE_LABEL = 'Inferred aggressor share (quote rule vs IEX BBO; IEX-only)';

/** Accept `[...]`, `{rows:[...]}` or `{items|data|portfolios|agents|sources:[...]}`. */
export function rowsOf(data, ...keys) {
  if (Array.isArray(data)) return data;
  const o = obj(data);
  if (!o) return [];
  for (const k of ['rows', ...keys, 'items', 'data']) if (Array.isArray(o[k])) return o[k];
  return [];
}

export function asOfText(asOf) {
  return isNum(asOf) ? `As of ${fmtEt(asOf, { date: true })}` : 'As-of time not provided';
}

// The user's open/closed choice per disclosure key survives the clock-tick re-renders of a list.
const methodOpen = new Map();

/**
 * The server's long method / caveat note for a ranked list. Open by default from 600 px up; on phones it starts
 * collapsed (one line) so the first screen shows ranked rows, and the caveats stay one tap away.
 */
export function methodNote(text, key) {
  if (typeof text !== 'string' || !text.trim()) return null;
  const wide = typeof matchMedia === 'function' && matchMedia('(min-width: 600px)').matches;
  const d = h('details', { class: 'method-note', open: methodOpen.has(key) ? methodOpen.get(key) : wide },
    h('summary', null, 'Method and caveats'), h('p', { class: 'note small' }, text));
  d.addEventListener('toggle', () => methodOpen.set(key, d.open));
  return d;
}

/** Normalised opportunity/universe row; metric names follow computeSignals() in docs/CONTRACTS.md §7. */
export function normOpp(r) {
  const m = obj(r?.metrics) || {};
  const q = obj(r?.quote) || {};
  const name = typeof r?.name === 'string' ? r.name : null;
  return {
    sym: typeof r?.sym === 'string' ? r.sym : null,
    name,
    namePostDated: r?.namePostDated === true,
    secType: securityTypeOf(r),
    priceU: num(r?.priceU ?? m.priceU),
    minuteT: num(r?.minuteT),
    retW: num(m.ret_w), accel: num(m.accel), relVol: num(m.relVol),
    buyShare: num(m.buyShare), classifiedShare: num(m.classifiedShare), volumeW: num(m.volumeW), tradesW: num(m.tradesW),
    spreadBps: num(m.spreadBps ?? q.spreadBps), quoteAgeMs: num(m.quoteAgeMs ?? q.ageMs),
    halted: !!(m.halted ?? q.halted), insufficient: !!m.insufficient,
    reasons: arr(m.reasons).map(String),
    rank: num(r?.rank ?? m.rank),
    score: num(r?.score),
  };
}

/** Badges for a row's data-quality state (halted, insufficient, each scanner reason) and inferred security type. */
export function qualityBadges(o, { withType = true } = {}) {
  const out = [];
  if (o.halted) out.push(badge('HALTED', { tone: 'bad' }));
  if (o.insufficient) out.push(badge('INSUFFICIENT DATA', { tone: 'warn' }));
  for (const r of o.reasons) if (r !== 'HALTED') out.push(badge(reasonLabel(r), { tone: 'warn', title: r }));
  if (isNum(o.tradesW) && o.tradesW > 0 && o.tradesW < 5) out.push(badge(`THIN · ${fmtInt(o.tradesW)} TRADE${o.tradesW === 1 ? '' : 'S'}`, { tone: 'warn', title: 'Very few IEX trades in the window: low-evidence metrics' }));
  if (withType && o.secType) out.push(badge(o.secType.label, { tone: 'copper', title: o.secType.basis ?? SECURITY_TYPE_NOTE }));
  return out;
}

/** "Inferred buy 100% of 37% classified · 15 trades" (never a bare buy share). */
export function buyShareText(o) {
  if (o.buyShare === null) return 'insufficient classified volume';
  const cls = isNum(o.classifiedShare) ? ` of ${fmtFracPct(o.classifiedShare, { sign: false })} classified` : '';
  const tr = isNum(o.tradesW) ? ` · ${fmtInt(o.tradesW)} trade${o.tradesW === 1 ? '' : 's'}` : '';
  return `${fmtFracPct(o.buyShare, { sign: false })}${cls}${tr}`;
}

function relVolNode(v) {
  return h('span', { title: isNum(v) ? `relative volume ${v} (same-day baseline; tiny baselines give extreme ratios)` : null }, fmtRelVol(v));
}

const POST_DATED_NAME = 'Name from a symbol directory published after the replay clock: a display label, not as-of evidence.';

/** Display name with an explicit post-dated marker (never shown as an as-of fact). */
export function nameText(o) {
  if (!o?.name) return 'Name not verified';
  return o.namePostDated ? `${o.name} (post-dated name)` : o.name;
}

function symCell(o) {
  return h('a', { class: 'row-link', href: `#/research/${encodeURIComponent(o.sym)}` },
    h('span', { class: 'sym' }, o.sym, o.secType ? h('span', { class: 'type-in-sym' }, ' ', badge(o.secType.label, { tone: 'copper', title: o.secType.basis ?? SECURITY_TYPE_NOTE })) : null),
    h('span', { class: 'sub clamp', title: o.namePostDated ? `${o.name} — ${POST_DATED_NAME}` : (o.name || null) }, nameText(o)));
}

function flags(o) {
  const out = qualityBadges(o, { withType: false });
  // On phones the security-type badge moves here from the (narrow) symbol cell.
  const type = o.secType ? h('span', { class: 'type-in-flags' }, badge(o.secType.label, { tone: 'copper', title: o.secType.basis ?? SECURITY_TYPE_NOTE })) : null;
  return out.length || type ? h('div', { class: 'badges' }, type, out) : h('span', { class: 'muted' }, 'none');
}

const windowLabel = (windowMin) => (isNum(windowMin) ? `${windowMin}-min return` : 'Window return');

/** Full opportunity table (desktop table; compact labelled cards with a per-row details disclosure on phones). */
export function opportunityTable(rawRows, { windowMin } = {}) {
  const rows = rawRows.map(normOpp).filter((o) => o.sym);
  const secondary = (o) => kv({
    Acceleration: fmtFracPct(o.accel),
    'Rel. volume': fmtRelVol(o.relVol),
    'Inferred buy share': buyShareText(o),
    'Window volume': fmtShares(o.volumeW),
    'IEX spread': fmtBps(o.spreadBps),
    'Quote age': fmtAge(o.quoteAgeMs),
    'Last IEX minute': isNum(o.minuteT) ? fmtEt(o.minuteT) : DASH,
    Score: isNum(o.score) ? fmtNum(o.score, 1) : 'not scored',
  });
  return rtable([
    { label: 'Symbol', head: true, render: symCell },
    { label: 'Last IEX price', num: true, render: (o) => h('span', null, fmtPriceU(o.priceU), h('span', { class: 'sub' }, isNum(o.minuteT) ? `minute ${fmtEt(o.minuteT)}` : DASH)) },
    { label: windowLabel(windowMin), num: true, render: (o) => signed(o.retW, fmtFracPct(o.retW)) },
    { label: 'Acceleration', num: true, cls: 'sec', render: (o) => signed(o.accel, fmtFracPct(o.accel)) },
    { label: 'Rel. volume', num: true, cls: 'sec', render: (o) => relVolNode(o.relVol) },
    { label: 'Inferred buy share', num: true, cls: 'sec', render: (o) => (o.buyShare === null ? h('span', { class: 'muted', title: 'Classified volume below the minimum' }, 'insufficient') : h('span', null, fmtFracPct(o.buyShare, { sign: false }), h('span', { class: 'sub' }, isNum(o.classifiedShare) ? `of ${fmtFracPct(o.classifiedShare, { sign: false })} classified` : ''))) },
    { label: 'Trades (window)', num: true, cls: 'sec', render: (o) => fmtInt(o.tradesW) },
    { label: 'Window volume', num: true, cls: 'sec', render: (o) => fmtShares(o.volumeW) },
    { label: 'Spread', num: true, cls: 'sec', render: (o) => fmtBps(o.spreadBps) },
    { label: 'Quote age', num: true, cls: 'sec', render: (o) => fmtAge(o.quoteAgeMs) },
    { label: 'Score', num: true, cls: 'sec', render: (o) => (isNum(o.score) ? fmtNum(o.score, 1) : h('span', { class: 'muted' }, 'not scored')) },
    { label: 'Flags', full: true, cls: 'flags', render: flags },
    { label: 'Details', full: true, cls: 'ph', render: (o) => h('details', null, h('summary', null, 'More metrics'), secondary(o)) },
  ], rows, { caption: 'Opportunities ranked by signal metrics (not recommendations)', empty: 'The API returned no ranked rows for this segment as of the replay clock.', cls: 'opps' });
}

/** Compact list (overview): symbol + flags, labelled metric grid, price and window return. */
export function opportunityList(rawRows, limit = 8, { windowMin } = {}) {
  const rows = rawRows.map(normOpp).filter((o) => o.sym).slice(0, limit);
  return h('ul', { class: 'list' }, rows.map((o) => {
    const badges = qualityBadges(o);
    return h('li', null,
      h('a', { class: 'list-row', href: `#/research/${encodeURIComponent(o.sym)}` },
        h('span', { class: 'l' },
          h('span', { class: 't' }, o.sym),
          badges.length ? h('span', { class: 'badges' }, badges) : null,
          h('span', { class: 's', title: o.namePostDated ? `${o.name} — ${POST_DATED_NAME}` : (o.name || null) }, nameText(o)),
          h('dl', { class: 'mini-kv' },
            h('div', null, h('dt', null, 'Rel. vol'), h('dd', null, relVolNode(o.relVol))),
            h('div', null, h('dt', null, 'Spread'), h('dd', null, fmtBps(o.spreadBps))),
            h('div', null, h('dt', null, 'Quote age'), h('dd', null, fmtAge(o.quoteAgeMs))),
            h('div', null, h('dt', null, 'Score'), h('dd', null, isNum(o.score) ? fmtNum(o.score, 1) : 'n/a')),
            h('div', { class: 'wide' }, h('dt', null, 'Inferred buy'), h('dd', null, buyShareText(o))))),
        h('span', { class: 'r' },
          h('span', { class: 'num' }, fmtPriceU(o.priceU)),
          h('span', { class: 'small' }, signed(o.retW, fmtFracPct(o.retW))),
          h('span', { class: 's' }, isNum(windowMin) ? `${windowMin}-min return` : 'window return'))));
  }));
}

export const METRIC_NOTES = [
  'Window return and acceleration are fractions of price over the scanner window (stated in the column / row label), shown as %.',
  `${BUYSHARE_LABEL}. Volume alone is never labelled intent; the share is blank when classified volume is insufficient, and is shown with the classified fraction and trade count.`,
  'Relative volume uses an earlier same-day baseline; tiny baselines give extreme ratios, shown as ">999×" (exact value in the tooltip).',
  'IEX volume is a fraction of consolidated U.S. volume. Prices are latest completed IEX minutes as of the replay clock.',
  `Security-type badges (Warrant, Unit, Right, …): ${SECURITY_TYPE_NOTE}`,
];

/** "Why ranked here": the server's score formula and weights, verbatim. */
export function rankingNote(d) {
  const o = obj(d) || {};
  if (typeof o.scoreFormula !== 'string' && !obj(o.weights)) return null;
  return h('details', null, h('summary', null, 'Why ranked here (score formula)'),
    h('div', { class: 'stack' },
      typeof o.scoreFormula === 'string' ? h('p', { class: 'small note' }, o.scoreFormula) : null,
      obj(o.weights) ? kv(o.weights, { labels: { retPct: 'Window return %', accelPct: 'Acceleration %', relVolLog2: 'log2 rel. volume', buyShareTilt: 'Buy-share tilt', spreadPer100Bps: 'Spread per 100 bps' } }) : null,
      obj(o.counts) ? h('p', { class: 'small muted' }, `${fmtInt(o.counts.universe)} symbols in the segment · ${fmtInt(o.counts.scored)} scored · ${fmtInt(o.counts.insufficient)} insufficient (not scored).`) : null));
}

/**
 * Loader with stale-response protection: only the latest request per key renders, and nothing renders after
 * the view is destroyed. onData exceptions render an explicit error instead of a half-drawn section.
 */
export function makeLoader(isAlive) {
  const tokens = {};
  return async function load(key, path, body, what, onData, { showLoading = false } = {}) {
    const tok = (tokens[key] = (tokens[key] || 0) + 1);
    if (showLoading && body) replace(body, loading(what));
    const res = await api.get(path);
    if (!isAlive() || tok !== tokens[key]) return null;
    if (!res.ok) {
      if (body) replace(body, errorBlock(res, what));
      return res;
    }
    try {
      onData(res.data);
    } catch (e) {
      console.error(e);
      if (body) replace(body, statusBlock('ERROR', `${what}: unexpected response shape — not displayed.`, String(e?.message || e), { tone: 'bad' }));
    }
    return res;
  };
}
