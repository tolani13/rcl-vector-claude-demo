// Strategy editor schema (pure, DOM-free; unit-tested in test/web). Mirrors validateStrategy() in
// server/agents/strategies.js: type, unit, nullability, range and enum per field, so the editor can set thresholds
// whose current value is null ("no limit") and shows owner units (USD, seconds, percent) instead of engineering units
// (1e-4 USD "u", milliseconds, 0..1 fractions). The server validates again; nothing here is authoritative.
// Every value is CONFIGURATION — strategies stay EXPLORATORY DEFAULTS — NOT VALIDATED.
import { isNum, obj, fmtUsdU, fmtNum, U_PER_USD } from './format.js';

const usdIn = { toUi: (u) => u / U_PER_USD, fromUi: (usd) => Math.round(usd * U_PER_USD) };
const secIn = { toUi: (ms) => ms / 1000, fromUi: (s) => Math.round(s * 1000) };
const pctIn = { toUi: (f) => Math.round(f * 10000) / 100, fromUi: (p) => Math.round(p * 100) / 10000 };

/**
 * kind: int | number | bool | enum | group (a nullable sub-object such as exits.takeProfit).
 * min/max are in UI units; minEx/maxEx are exclusive bounds. showIf(next) hides a field (and drops its key on save).
 */
export const STRATEGY_FIELDS = Object.freeze([
  { path: 'decisionMode', kind: 'enum', label: 'Decision mode', options: [['rules', 'rules — deterministic strategy rules'], ['model_confirm', 'model_confirm — rules propose, model must confirm'], ['model', 'model — model proposes typed intents']] },

  { path: 'signal.windowMin', kind: 'int', label: 'Signal window', unit: 'min', min: 2, max: 120 },
  { path: 'signal.minHistoryMin', kind: 'int', label: 'Session history needed before relative volume', unit: 'min', min: 0, max: 390 },
  { path: 'signal.minClassifiedShares', kind: 'int', label: 'Min classified shares for inferred buy share', unit: 'shares', min: 0 },

  { path: 'entry.minRetPct', kind: 'number', label: 'Min window return', unit: '%' },
  { path: 'entry.minAccelPct', kind: 'number', label: 'Min acceleration', unit: '%', nullable: true },
  { path: 'entry.minRelVol', kind: 'number', label: 'Min relative volume', unit: '×', nullable: true, min: 0 },
  { path: 'entry.minBuyShare', kind: 'number', label: 'Min inferred buy share', unit: '%', nullable: true, min: 0, max: 100, ...pctIn },
  { path: 'entry.requireBuyShare', kind: 'bool', label: 'Require a computable inferred buy share' },
  { path: 'entry.minTradesW', kind: 'int', label: 'Min trades in window', unit: 'trades', min: 0 },
  { path: 'entry.minVolumeW', kind: 'int', label: 'Min window volume', unit: 'shares', nullable: true, min: 0 },
  { path: 'entry.maxSpreadBps', kind: 'number', label: 'Max IEX spread', unit: 'bps', nullable: true, minEx: 0 },
  { path: 'entry.maxQuoteAgeMs', kind: 'number', label: 'Max quote age', unit: 'sec', nullable: true, minEx: 0, ...secIn },
  { path: 'entry.minPriceU', kind: 'number', label: 'Min price', unit: 'USD', nullable: true, minEx: 0, step: '0.0001', ...usdIn },
  { path: 'entry.maxPriceU', kind: 'number', label: 'Max price (exclusive)', unit: 'USD', nullable: true, minEx: 0, step: '0.0001', ...usdIn },
  { path: 'entry.orderType', kind: 'enum', label: 'Entry order type', options: [['market', 'Market'], ['limit', 'Limit']] },
  { path: 'entry.limitOffsetBps', kind: 'int', label: 'Limit offset above ask', unit: 'bps', min: 0, max: 1000 },
  { path: 'entry.budgetUsd', kind: 'number', label: 'Budget per entry', unit: 'USD', minEx: 0, max: 1000000, step: '0.01' },
  { path: 'entry.capQtyToDisplayedAsk', kind: 'bool', label: 'Cap quantity at the displayed ask size' },
  { path: 'entry.noEntryLastMin', kind: 'int', label: 'No new entries in the last', unit: 'min', min: 0, max: 390 },

  { path: 'exits.stopLoss.basis', kind: 'enum', label: 'Stop-loss basis', options: [['pct_below_entry_ref', 'Percent below the entry reference'], ['at_entry_ref', 'At the entry reference price']] },
  { path: 'exits.stopLoss.pct', kind: 'number', label: 'Stop-loss distance', unit: '%', minEx: 0, maxEx: 100, dflt: 5, showIf: (s) => s?.exits?.stopLoss?.basis === 'pct_below_entry_ref' },
  { path: 'exits.takeProfit', kind: 'group', label: 'Take-profit', noneLabel: 'No take-profit', dflt: { basis: 'pct_gain', pct: 20 } },
  { path: 'exits.takeProfit.basis', kind: 'enum', label: 'Take-profit basis', group: 'exits.takeProfit', options: [['pct_gain', 'Percent gain'], ['multiple_of_entry', 'Multiple of the entry reference']] },
  { path: 'exits.takeProfit.pct', kind: 'number', label: 'Take-profit gain', unit: '%', group: 'exits.takeProfit', minEx: 0, max: 10000, dflt: 20, showIf: (s) => s?.exits?.takeProfit?.basis === 'pct_gain' },
  { path: 'exits.takeProfit.multiple', kind: 'number', label: 'Take-profit multiple', unit: '×', group: 'exits.takeProfit', minEx: 1, max: 100, dflt: 2, showIf: (s) => s?.exits?.takeProfit?.basis === 'multiple_of_entry' },
  { path: 'exits.timeExit', kind: 'group', label: 'Time exit', noneLabel: 'No time exit', dflt: { minutes: 30, bandPct: null } },
  { path: 'exits.timeExit.minutes', kind: 'int', label: 'Time exit after', unit: 'min', group: 'exits.timeExit', min: 1, max: 390, dflt: 30 },
  { path: 'exits.timeExit.bandPct', kind: 'number', label: 'Only if price stayed within ±', unit: '%', group: 'exits.timeExit', nullable: true, noneLabel: 'Unconditional', min: 0, max: 100 },
  { path: 'exits.breakevenAtGainPct', kind: 'number', label: 'Move stop to breakeven at gain', unit: '%', nullable: true, minEx: 0 },

  { path: 'management.cancelEntryAfterMin', kind: 'int', label: 'Cancel unfilled entry after', unit: 'min', nullable: true, noneLabel: 'Never', min: 1, max: 390 },
  { path: 'management.maxScanSymbols', kind: 'int', label: 'Max symbols scanned per minute', min: 1, max: 2000 },
  { path: 'management.maxCandidatesPerStep', kind: 'int', label: 'Max candidates per minute', min: 1, max: 50 },
  { path: 'management.maxOrdersPerStep', kind: 'int', label: 'Max orders per minute', min: 1, max: 50 },
  { path: 'management.maxEntriesPerSymbol', kind: 'int', label: 'Max entries per symbol', min: 1, max: 100 },
  { path: 'management.reentryCooldownMin', kind: 'int', label: 'Re-entry cooldown', unit: 'min', min: 0, max: 390 },
  { path: 'management.intentTtlSec', kind: 'int', label: 'Intent time-to-live', unit: 'sec', min: 5, max: 900 },
  { path: 'management.maxModelCallsPerStep', kind: 'int', label: 'Max model calls per minute', min: 0, max: 20 },
]);

/** Fields shown read-only (identity of the agent/portfolio and documentation). */
export const READONLY_PATHS = Object.freeze(['id', 'version', 'label', 'name', 'lens', 'segment', 'description', 'notes', 'ambiguities', 'exits.takeProfit.alternative']);

const FIELD_BY_PATH = new Map(STRATEGY_FIELDS.map((f) => [f.path, f]));
export const fieldFor = (path) => FIELD_BY_PATH.get(path) ?? null;

export function getPath(o, path) {
  let cur = o;
  for (const k of path.split('.')) {
    if (cur === null || cur === undefined || typeof cur !== 'object') return undefined;
    cur = cur[k];
  }
  return cur;
}
function setPath(o, path, v) {
  const keys = path.split('.');
  let cur = o;
  for (const k of keys.slice(0, -1)) {
    if (!obj(cur[k])) cur[k] = {};
    cur = cur[k];
  }
  cur[keys[keys.length - 1]] = v;
}
function deletePath(o, path) {
  const keys = path.split('.');
  const parent = getPath(o, keys.slice(0, -1).join('.')) ?? (keys.length === 1 ? o : undefined);
  if (obj(parent)) delete parent[keys[keys.length - 1]];
}

/** Server value -> editor value (UI units); null stays null. */
export function toUiValue(field, v) {
  if (v === null || v === undefined) return null;
  if ((field.kind === 'number' || field.kind === 'int') && isNum(v)) return field.toUi ? field.toUi(v) : v;
  return v;
}

/** Display text of a strategy value with its unit (for summaries). */
export function formatFieldValue(path, v) {
  const f = fieldFor(path);
  if (v === null || v === undefined) return f?.nullable || f?.kind === 'group' ? (f.noneLabel ?? 'no limit') : 'not set';
  if (typeof v === 'boolean') return v ? 'yes' : 'no';
  if (!f) return typeof v === 'number' ? fmtNum(v, 4) : String(v);
  if (f.kind === 'enum') return (f.options.find(([k]) => k === v)?.[1]) ?? String(v);
  if (isNum(v)) {
    if (f.unit === 'USD' && f.toUi) return fmtUsdU(v);
    if (f.unit === 'USD') return fmtUsdU(Math.round(v * U_PER_USD));
    const ui = toUiValue(f, v);
    return `${fmtNum(ui, 4)}${f.unit ? (f.unit === '%' || f.unit === '×' ? f.unit : ` ${f.unit}`) : ''}`;
  }
  return String(v);
}

/** Label with unit suffix, e.g. "Max quote age (sec)". */
export function fieldLabel(path) {
  const f = fieldFor(path);
  if (!f) return null;
  return f.unit ? `${f.label} (${f.unit})` : f.label;
}

function parseNumber(field, raw) {
  const s = String(raw ?? '').trim();
  if (s === '') return { error: `${field.label} needs a value${field.nullable ? ' (or tick “' + (field.noneLabel ?? 'No limit') + '”)' : ''}` };
  const n = Number(s);
  if (!Number.isFinite(n)) return { error: `${field.label} must be a number` };
  if (isNum(field.min) && n < field.min) return { error: `${field.label} must be ≥ ${field.min}` };
  if (isNum(field.max) && n > field.max) return { error: `${field.label} must be ≤ ${field.max}` };
  if (isNum(field.minEx) && n <= field.minEx) return { error: `${field.label} must be > ${field.minEx}` };
  if (isNum(field.maxEx) && n >= field.maxEx) return { error: `${field.label} must be < ${field.maxEx}` };
  const v = field.fromUi ? field.fromUi(n) : n;
  if (field.kind === 'int' && !Number.isSafeInteger(v)) return { error: `${field.label} must be a whole number` };
  return { value: v };
}

/**
 * Apply editor values to a copy of the strategy.
 * @param {object} strategy  current strategy (server shape)
 * @param {Record<string, {value?: string|boolean, none?: boolean}>} edits  keyed by field path; missing paths unchanged
 * @returns {{next: object, changes: [string, any, any][], errors: string[]}}
 */
export function applyStrategyEdits(strategy, edits) {
  const next = structuredClone(strategy);
  const errors = [];
  const e = edits || {};
  // 1) nullable groups first, so children know whether their group exists
  for (const f of STRATEGY_FIELDS.filter((x) => x.kind === 'group')) {
    const ed = e[f.path];
    if (!ed) continue;
    const cur = getPath(next, f.path);
    if (ed.none) { if (cur !== null && cur !== undefined) setPath(next, f.path, null); }
    else if (!obj(cur)) setPath(next, f.path, structuredClone(f.dflt));
  }
  // 2) enums and booleans (they decide which numeric fields are shown)
  for (const f of STRATEGY_FIELDS.filter((x) => x.kind === 'enum' || x.kind === 'bool')) {
    const ed = e[f.path];
    if (!ed || (f.group && !obj(getPath(next, f.group)))) continue;
    if (f.kind === 'bool') { setPath(next, f.path, !!ed.value); continue; }
    if (!f.options.some(([k]) => k === ed.value)) { errors.push(`${f.label}: choose one of the listed options`); continue; }
    // The handwritten preset's "alternative reading" belongs to its original take-profit basis only.
    if (f.path === 'exits.takeProfit.basis' && ed.value !== getPath(strategy, f.path)) deletePath(next, 'exits.takeProfit.alternative');
    setPath(next, f.path, ed.value);
  }
  // 3) numbers
  for (const f of STRATEGY_FIELDS.filter((x) => x.kind === 'number' || x.kind === 'int')) {
    if (f.group && !obj(getPath(next, f.group))) continue;
    if (f.showIf && !f.showIf(next)) { deletePath(next, f.path); continue; }
    const ed = e[f.path];
    if (!ed) {
      if (f.showIf && getPath(next, f.path) === undefined && f.dflt !== undefined) setPath(next, f.path, f.dflt);
      continue;
    }
    if (f.nullable && ed.none) { setPath(next, f.path, null); continue; }
    const r = parseNumber(f, ed.value);
    if (r.error) { errors.push(r.error); continue; }
    setPath(next, f.path, r.value);
  }
  const changes = [];
  const walk = (a, b, prefix) => {
    const keys = new Set([...Object.keys(obj(a) || {}), ...Object.keys(obj(b) || {})]);
    for (const k of keys) {
      const p = prefix ? `${prefix}.${k}` : k;
      const x = obj(a)?.[k];
      const y = obj(b)?.[k];
      if (obj(x) && obj(y) && !fieldFor(p)) walk(x, y, p);
      else if (obj(x) && obj(y) && fieldFor(p)?.kind === 'group') walk(x, y, p);
      else if (JSON.stringify(x) !== JSON.stringify(y)) changes.push([p, x === undefined ? null : x, y === undefined ? null : y]);
    }
  };
  walk(strategy, next, '');
  return { next, changes, errors };
}

/**
 * Flatten a strategy into [path, value] rows for the read-only summary (nested objects become dotted paths, so no
 * nested key/value grids are needed on phones). Primitive arrays stay leaf values; arrays of objects stay as values.
 */
export function flattenStrategy(s, prefix = '') {
  const out = [];
  for (const [k, v] of Object.entries(obj(s) || {})) {
    const p = prefix ? `${prefix}.${k}` : k;
    if (obj(v)) out.push(...flattenStrategy(v, p));
    else out.push([p, v]);
  }
  return out;
}

/** Agent-scan skip codes -> the strategy field that decides them (server/agents/strategies.js entryRejections). */
export const SKIP_PATHS = Object.freeze({
  RET_BELOW_MIN: 'entry.minRetPct',
  ACCEL_BELOW_MIN: 'entry.minAccelPct',
  RELVOL_BELOW_MIN: 'entry.minRelVol',
  RELVOL_UNAVAILABLE: 'entry.minRelVol',
  BUYSHARE_BELOW_MIN: 'entry.minBuyShare',
  BUYSHARE_UNAVAILABLE: 'entry.requireBuyShare',
  TRADES_BELOW_MIN: 'entry.minTradesW',
  VOLUME_BELOW_MIN: 'entry.minVolumeW',
  SPREAD_ABOVE_MAX: 'entry.maxSpreadBps',
  QUOTE_OLDER_THAN_STRATEGY_MAX: 'entry.maxQuoteAgeMs',
  PRICE_BELOW_MIN: 'entry.minPriceU',
  PRICE_AT_OR_ABOVE_MAX: 'entry.maxPriceU',
  OUTSIDE_ENTRY_WINDOW: 'entry.noEntryLastMin',
});

/** "strategy: Max IEX spread 400 bps" for a skip code, from the agent's own strategy; null when not threshold-driven. */
export function skipThresholdText(code, strategy) {
  const path = SKIP_PATHS[code];
  if (!path) return null;
  const v = getPath(strategy, path);
  if (v === undefined) return null;
  return `strategy: ${fieldFor(path)?.label ?? path} ${formatFieldValue(path, v)}`;
}
