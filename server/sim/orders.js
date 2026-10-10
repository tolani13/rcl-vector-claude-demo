// Paper orders engine (docs/CONTRACTS.md section 4). Server-side and clock-driven: orders advance only when the
// replay engine calls processMinute(t) after minute [t, t+60s) has completed. No browser involvement.
//
// Semantics:
//   * An order submitted at clock C is first eligible in minute [C, C+60s) (created_ts <= t).
//   * Fills are estimates from server/sim/fills.js and are applied through server/sim/ledger.js.
//   * Bracket children (stop_loss / take_profit attached to an entry) are `pending_parent` until the entry
//     fills, then become `working` with qty = the shares the bracket still holds (entry filled qty minus shares
//     its children already sold, never more than the position). Any qty increase from an entry fill in minute t
//     applies from minute t+1: each bracket is evaluated as one unit with its exits FIRST (children and their OCO
//     group before the entry), so a child never sells shares the entry bought in the same minute (no intra-minute
//     sequencing information exists).
//   * Once a protective child of a bracket executes (fully or partially), the bracket is exiting: the entry's
//     unfilled remainder is cancelled (ORDER_CANCELLED, reason PARENT_REMAINDER_CANCELLED_AFTER_PROTECTIVE_EXIT),
//     so no later entry fill can leave shares without a protective order.
//   * After every sell fill the open bracket children on that instrument are clamped to the shares still held
//     (BRACKET_CHILD_QTY_UPDATED); when nothing is held, every open sell on it is cancelled (POSITION_CLOSED).
//   * OCO: if two siblings would both execute in the same minute the STOP executes first (conservative) and
//     OCO_SAME_MINUTE_AMBIGUITY is journaled; the other sibling's would-be fill is discarded.
//   * Displayed size (and the trade-through size proxy) is consumed per minute, per portfolio, symbol and side:
//     a second order of the same portfolio in the same minute only gets what earlier fills left. The seven
//     portfolios are independent counterfactual books: each sees the full IEX displayed size.
//   * Buys carry a spend cap (meta.maxSpendU = min(policy max_trade_spend_usd, budget_usd of the stored intent named by
//     spec.intent_id, caller-supplied meta.maxSpendU)). A fill never takes the order's total spend above it; once the
//     cap binds, the unfilled remainder is cancelled (SPEND_CAP_REACHED) instead of waiting for a cheaper price.
//   * Unfillable minutes journal FILL_WITHHELD and never manufacture a fill; the order stays working (a
//     triggered stop stays `triggered` and is retried next minute as a market order) until it expires.
//   * DAY orders expire at the replay end: the session close (16:00 ET), or a PARTIAL dataset's coverage end when it is
//     earlier (marketdata.replayWindowOf); no order is accepted at/after that end. A caller-supplied expires_ts is
//     floored to the minute: an order is only eligible for minutes [t, t+60s) with t + 60s <= expires_ts.
//     meta.expiryBasis records which (SESSION_CLOSE | REPLAY_END_TRUNCATED | REQUESTED); ORDER_EXPIRED states it.
//   * Ties between orders created at the same replay clock are broken by insertion order (rowid), never by the
//     random id, so the same inputs give the same bookkeeping.
//   * Every state change is journaled with quote provenance.
import { append } from '../journal.js';
import { newId } from '../util/ids.js';
import { isValidTick, usdToU } from '../util/money.js';
import { MINUTE, fmtEt } from '../util/time.js';
import { fillMinute, quoteAsOf, replayWindowOf } from '../data/marketdata.js';
import { evaluateOrder, defaultCostModel, observedFromMinute, costSegmentFor, slippedPrice } from './fills.js';
import { applyFill, atomic, getPortfolio, getPosition, instrumentId } from './ledger.js';
import { checkOperationalOptionOrder, evaluateOptionOrder, OPTIONS_STATUS, OPTIONS_MULTIPLIER } from './options.js';
import { defaultPolicyFor } from '../policy/config.js';

export const OPEN_STATUSES = Object.freeze(['pending_parent', 'working', 'triggered', 'partially_filled']);
const EVALUABLE = ['working', 'triggered', 'partially_filled'];
const SIDES = new Set(['buy', 'sell']);
const TYPES = new Set(['market', 'limit', 'stop', 'stop_limit']);
const ROLES = new Set(['entry', 'stop_loss', 'take_profit', 'time_exit', 'exit', 'manual']);
const PROTECTIVE_ROLES = new Set(['stop_loss', 'take_profit', 'time_exit']);
const ACTORS = new Set(['agent', 'human', 'engine', 'system', 'policy']);
// Same symbol syntax as intents.js: IEX issue-type suffixes (+ ^ = #) are valid symbols; whether such an issue may be
// traded is policy (gate symbol_allowed.denyIssueTypes), not syntax.
const SYM_RE = /^[A-Z][A-Z0-9.\-]{0,9}(?:[+^=#][A-Z0-9]{0,2})?$/;
const SPEC_KEYS = new Set(['portfolio_id', 'agent_id', 'intent_id', 'parent_id', 'oco_group', 'sym', 'kind', 'side', 'type', 'role',
  'qty', 'limit_px', 'stop_px', 'tif', 'expires_ts', 'attach', 'actor', 'reason', 'meta', 'contract', 'optionsQuote', 'protective']);
const ATTACH_KEYS = new Set(['stop_loss_px_u', 'take_profit_px_u', 'time_exit_min', 'time_exit_band_bps']);

// Allowed side/type combinations per role (long-only book: every exit is a sell).
const ROLE_RULES = {
  entry: { sides: ['buy'], types: ['market', 'limit', 'stop', 'stop_limit'] },
  stop_loss: { sides: ['sell'], types: ['stop', 'stop_limit'] },
  take_profit: { sides: ['sell'], types: ['limit'] },
  time_exit: { sides: ['sell'], types: ['market', 'limit'] },
  exit: { sides: ['sell'], types: ['market', 'limit', 'stop', 'stop_limit'] },
  manual: { sides: ['buy', 'sell'], types: ['market', 'limit', 'stop', 'stop_limit'] },
};

const err = (code, detail) => ({ code, detail });

export function getOrder(db, orderId) {
  return db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId) ?? null;
}

function parseMeta(o) {
  try { return o.meta_json ? JSON.parse(o.meta_json) : {}; } catch { return {}; }
}

/** Compact IEX quote provenance for journal payloads (as-of the replay clock). */
export function quoteProvenance(db, ds, sym, clock) {
  if (!ds) return { status: 'NO_VERIFIED_DATA', ds: null };
  if (!Number.isFinite(clock)) return { status: 'NO_VERIFIED_DATA', ds, detail: 'no replay clock' };
  const q = quoteAsOf(db, ds, sym, clock);
  if (!q) return { status: 'NO_VERIFIED_DATA', ds, sym, asOf: clock };
  return {
    status: 'OBSERVED', ds, venue: 'IEX', sym, asOf: clock, bid: q.bid, ask: q.ask, bidSize: q.bidSize, askSize: q.askSize,
    quoteTs: q.quoteTs, ageMs: q.ageMs, twoSided: q.twoSided, spreadBps: q.spreadBps, halted: q.halted, minuteRowT: q.source.minuteRowT,
  };
}

function optionsProvenance(q) {
  if (!q) return { status: OPTIONS_STATUS };
  return { status: q.status, provider: q.provider, source_url: q.source_url ?? null, dataset: q.dataset ?? null, bid: q.bid, ask: q.ask, bidSize: q.bidSize, askSize: q.askSize, quoteTs: q.quoteTs };
}

function actorOf(spec) {
  if (spec.actor) return spec.actor;
  return spec.agent_id ? 'agent' : 'human';
}

/**
 * Cost model for an order: explicit overrides first; agent portfolios use their segment; the sandbox (segment null)
 * resolves per symbol with fills.costSegmentFor (large-cap list => large, else micro), the same rule the gate uses.
 * Option orders stay on the micro (more conservative) values.
 */
export function costModelFor(ctx, pf, sym = null, kind = 'equity') {
  const m = ctx?.costModels || {};
  if (m[pf.id]) return m[pf.id];
  if (pf.segment) return m[pf.segment] ?? defaultCostModel(pf.segment);
  return m.sandbox ?? defaultCostModel(costSegmentFor(null, kind === 'option' ? null : sym));
}

/**
 * Is a sell stop already marketable against the as-of IEX bid? Returns null for anything but a sell stop/stop-limit.
 * A stop at or above the bid triggers on its first evaluated minute (cost = spread + slippage + fees), so the
 * condition is journaled rather than silently accepted.
 */
function stopVsBid(o, quote, stage) {
  if (o.side !== 'sell' || (o.type !== 'stop' && o.type !== 'stop_limit') || !Number.isSafeInteger(o.stop_px)) return null;
  if (!quote || quote.status !== 'OBSERVED' || !quote.twoSided || !(quote.bid > 0)) {
    return { stopAtOrAboveBid: null, detail: 'no two-sided as-of IEX quote to compare the stop with' };
  }
  const atOrAbove = o.stop_px >= quote.bid;
  return {
    stopAtOrAboveBid: atOrAbove, stopPxU: o.stop_px, bidU: quote.bid, stopVsBidBps: Math.round(((o.stop_px - quote.bid) / quote.bid) * 10000),
    ...(atOrAbove ? { warning: `STOP_MARKETABLE_AT_${stage}`, note: 'stop is at/above the as-of IEX bid: expected to trigger on its first evaluated minute' } : {}),
  };
}

function orderSummary(o) {
  return {
    order_id: o.id, parent_id: o.parent_id, oco_group: o.oco_group, intent_id: o.intent_id, sym: o.sym, instrument_id: o.instrument_id, kind: o.kind,
    side: o.side, type: o.type, role: o.role, qty: o.qty, filled_qty: o.filled_qty, limit_px: o.limit_px, stop_px: o.stop_px,
    status: o.status, protective: o.protective === 1, created_ts: o.created_ts, expires_ts: o.expires_ts, triggered_ts: o.triggered_ts,
  };
}

/** Structural validation of an order spec (no DB access). Returns a list of {code, detail}. */
export function validateOrderSpec(spec) {
  const errors = [];
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) return [err('SPEC_INVALID', 'order spec must be an object')];
  for (const k of Object.keys(spec)) if (!SPEC_KEYS.has(k)) errors.push(err('UNKNOWN_FIELD', `unknown order field: ${k}`));
  if (typeof spec.portfolio_id !== 'string' || !spec.portfolio_id) errors.push(err('PORTFOLIO_REQUIRED', 'portfolio_id is required'));
  const kind = spec.kind ?? 'equity';
  if (kind !== 'equity' && kind !== 'option') errors.push(err('KIND_INVALID', 'kind must be equity or option'));
  if (typeof spec.sym !== 'string' || !SYM_RE.test(spec.sym)) errors.push(err('SYMBOL_INVALID', 'sym must match ^[A-Z][A-Z0-9.-]{0,9} with an optional IEX suffix [+^=#][A-Z0-9]{0,2}'));
  if (!SIDES.has(spec.side)) errors.push(err('SIDE_INVALID', 'side must be buy or sell'));
  if (!TYPES.has(spec.type)) errors.push(err('TYPE_INVALID', 'type must be market, limit, stop or stop_limit'));
  const role = spec.role ?? (spec.side === 'buy' ? 'entry' : 'exit');
  if (!ROLES.has(role)) errors.push(err('ROLE_INVALID', `role must be one of ${[...ROLES].join(', ')}`));
  else if (SIDES.has(spec.side) && TYPES.has(spec.type)) {
    const rr = ROLE_RULES[role];
    if (!rr.sides.includes(spec.side)) errors.push(err('SIDE_ROLE_COMBO_INVALID', `role ${role} requires side ${rr.sides.join('|')} (no shorting)`));
    if (!rr.types.includes(spec.type)) errors.push(err('TYPE_ROLE_COMBO_INVALID', `role ${role} requires type ${rr.types.join('|')}`));
  }
  if (spec.protective !== undefined && spec.protective !== PROTECTIVE_ROLES.has(role)) {
    errors.push(err('PROTECTIVE_FLAG_INVALID', 'protective is derived from role (stop_loss/take_profit/time_exit) and cannot be overridden'));
  }
  if (!Number.isSafeInteger(spec.qty) || spec.qty <= 0) errors.push(err('QTY_INVALID', 'qty must be a positive integer (whole shares/contracts)'));
  const needLimit = spec.type === 'limit' || spec.type === 'stop_limit';
  const needStop = spec.type === 'stop' || spec.type === 'stop_limit';
  if (needLimit) { if (!isValidTick(spec.limit_px)) errors.push(err('TICK_INVALID', 'limit_px must be a valid Reg NMS 612 tick (integer u)')); }
  else if (spec.limit_px != null) errors.push(err('LIMIT_NOT_ALLOWED', `limit_px not allowed for ${spec.type} orders`));
  if (needStop) { if (!isValidTick(spec.stop_px)) errors.push(err('TICK_INVALID', 'stop_px must be a valid Reg NMS 612 tick (integer u)')); }
  else if (spec.stop_px != null) errors.push(err('STOP_NOT_ALLOWED', `stop_px not allowed for ${spec.type} orders`));
  if (spec.tif !== undefined && spec.tif !== 'DAY') errors.push(err('TIF_INVALID', "only tif 'DAY' is supported"));
  if (spec.expires_ts != null && !Number.isSafeInteger(spec.expires_ts)) errors.push(err('EXPIRY_INVALID', 'expires_ts must be integer ms'));
  if (spec.actor !== undefined && !ACTORS.has(spec.actor)) errors.push(err('ACTOR_INVALID', 'invalid actor'));
  if (spec.oco_group != null && (typeof spec.oco_group !== 'string' || !/^[A-Za-z0-9_\-:.]{1,80}$/.test(spec.oco_group))) errors.push(err('OCO_INVALID', 'oco_group must be a short id string'));
  if (spec.attach != null) {
    const a = spec.attach;
    if (typeof a !== 'object' || Array.isArray(a)) errors.push(err('ATTACH_INVALID', 'attach must be an object'));
    else {
      for (const k of Object.keys(a)) if (!ATTACH_KEYS.has(k)) errors.push(err('UNKNOWN_FIELD', `unknown attach field: ${k}`));
      if (spec.side !== 'buy' || role !== 'entry') errors.push(err('ATTACH_INVALID', 'attach is only allowed on buy entry orders'));
      if (spec.parent_id) errors.push(err('ATTACH_INVALID', 'a bracket child cannot carry attach'));
      if (a.stop_loss_px_u != null && !isValidTick(a.stop_loss_px_u)) errors.push(err('TICK_INVALID', 'attach.stop_loss_px_u must be a valid tick'));
      if (a.take_profit_px_u != null && !isValidTick(a.take_profit_px_u)) errors.push(err('TICK_INVALID', 'attach.take_profit_px_u must be a valid tick'));
      if (a.stop_loss_px_u != null && a.take_profit_px_u != null && a.stop_loss_px_u >= a.take_profit_px_u) errors.push(err('ATTACH_INVALID', 'stop loss must be below take profit'));
      if (a.time_exit_min != null && (!Number.isSafeInteger(a.time_exit_min) || a.time_exit_min < 1 || a.time_exit_min > 390)) errors.push(err('ATTACH_INVALID', 'time_exit_min must be an integer 1..390'));
      if (a.time_exit_band_bps != null && (!Number.isSafeInteger(a.time_exit_band_bps) || a.time_exit_band_bps < 0 || a.time_exit_band_bps > 10000)) errors.push(err('ATTACH_INVALID', 'time_exit_band_bps must be an integer 0..10000'));
    }
  }
  if (kind === 'option' && spec.type !== 'market' && spec.type !== 'limit') errors.push(err('TYPE_INVALID', 'option orders must be market or limit'));
  if (spec.meta != null && (typeof spec.meta !== 'object' || Array.isArray(spec.meta))) errors.push(err('META_INVALID', 'meta must be an object'));
  else if (spec.meta?.maxSpendU !== undefined) {
    if (!Number.isSafeInteger(spec.meta.maxSpendU) || spec.meta.maxSpendU <= 0) errors.push(err('META_INVALID', 'meta.maxSpendU must be a positive integer number of u'));
    else if (spec.side !== 'buy') errors.push(err('META_INVALID', 'meta.maxSpendU applies to buy orders only'));
  }
  return errors;
}

/**
 * budget_usd of the stored intent this order executes (intents row written by the runner / API before submission),
 * in u; null when there is no such intent in this session/portfolio or it carries no budget.
 */
function intentBudgetU(db, ctx, spec) {
  if (typeof spec.intent_id !== 'string' || !spec.intent_id) return null;
  const row = db.prepare('SELECT session_id, portfolio_id, intent_json FROM intents WHERE id = ?').get(spec.intent_id);
  if (!row || row.session_id !== ctx.session_id || row.portfolio_id !== spec.portfolio_id) return null;
  try {
    const b = JSON.parse(row.intent_json)?.budget_usd;
    return typeof b === 'number' && Number.isFinite(b) && b > 0 ? usdToU(b) : null;
  } catch { return null; }
}

/**
 * Spend cap for a buy: min(portfolio policy max_trade_spend_usd, the executed intent's budget_usd, caller
 * meta.maxSpendU). Recorded on the order and enforced at fill time (fills.evaluateOrder ctx.maxSpendU). null when none exists.
 */
function spendCapFor(spec, budgetU = null) {
  if (spec.side !== 'buy') return null;
  const candidates = [];
  const capUsd = defaultPolicyFor(spec.portfolio_id)?.rules?.max_trade_spend_usd?.value;
  if (Number.isFinite(capUsd) && capUsd > 0) candidates.push({ maxSpendU: usdToU(capUsd), source: 'policy:max_trade_spend_usd' });
  if (Number.isSafeInteger(budgetU) && budgetU > 0) candidates.push({ maxSpendU: budgetU, source: 'intent:budget_usd' });
  if (Number.isSafeInteger(spec.meta?.maxSpendU)) candidates.push({ maxSpendU: spec.meta.maxSpendU, source: 'caller:meta.maxSpendU' });
  if (!candidates.length) return null;
  const min = candidates.reduce((a, b) => (b.maxSpendU < a.maxSpendU ? b : a));
  return { maxSpendU: min.maxSpendU, source: min.source, candidates };
}

/** Price the order is expected to pay per share/contract as of submission (gate cash reservation for open buys). */
function submitEstimate(spec, quote, cm) {
  if (spec.side !== 'buy' || (spec.kind ?? 'equity') !== 'equity') return null;
  if (spec.type === 'limit' || spec.type === 'stop_limit') return { priceU: spec.limit_px, basis: 'LIMIT_PRICE (max payable)' };
  if (!quote || quote.status !== 'OBSERVED' || !quote.twoSided || !(quote.ask > 0)) return null;
  if (spec.type === 'stop') return { priceU: slippedPrice(Math.max(spec.stop_px, quote.ask), 'buy', cm.slippageBps ?? 0), basis: 'MAX(STOP, IEX_ASK)_PLUS_SLIPPAGE', asOf: quote.asOf };
  return { priceU: slippedPrice(quote.ask, 'buy', cm.slippageBps ?? 0), basis: 'IEX_ASK_PLUS_SLIPPAGE', asOf: quote.asOf };
}

function insertOrder(db, o) {
  db.prepare(`INSERT INTO orders (id, session_id, portfolio_id, agent_id, intent_id, parent_id, oco_group, instrument_id, sym, kind, side, type, role,
      qty, filled_qty, limit_px, stop_px, status, protective, created_ts, updated_ts, expires_ts, triggered_ts, reason, meta_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`).run(
    o.id, o.session_id, o.portfolio_id, o.agent_id ?? null, o.intent_id ?? null, o.parent_id ?? null, o.oco_group ?? null, o.instrument_id, o.sym,
    o.kind, o.side, o.type, o.role, o.qty, o.limit_px ?? null, o.stop_px ?? null, o.status, o.protective ? 1 : 0, o.created_ts, o.created_ts,
    o.expires_ts ?? null, o.reason ?? null, o.meta ? JSON.stringify(o.meta) : null);
  return getOrder(db, o.id);
}

function journalOrder(db, ctx, o, type, extra = {}, actor = 'engine') {
  append(db, {
    session_id: ctx.session_id, ts_sim: ctx.clock ?? null, portfolio_id: o.portfolio_id, agent_id: o.agent_id ?? null, actor, type, ref_id: o.id,
    payload: { ...orderSummary(o), ...extra },
  });
}

/**
 * Submit an order (and, with `attach`, its bracket children).
 * @param {{session_id:string, ds:string|null, clock:number, costModels?:object}} ctx
 * @param {object} spec {portfolio_id, agent_id?, intent_id?, parent_id?, oco_group?, sym, kind?, side, type, role?, qty,
 *   limit_px?, stop_px?, tif?:'DAY', expires_ts?, attach?:{stop_loss_px_u?, take_profit_px_u?, time_exit_min?, time_exit_band_bps?},
 *   actor?, reason?, meta?, contract? (options), optionsQuote? (verified provider quote, options)}
 * @returns {{ok:true, order:object, children:object[]} | {ok:false, code:string, errors:{code,detail}[], order?:object}}
 */
export function submitOrder(db, ctx, spec) {
  const errors = validateOrderSpec(spec);
  const actor = ACTORS.has(spec?.actor) ? spec.actor : (spec?.agent_id ? 'agent' : 'human');
  if (!ctx || !ctx.session_id || !Number.isFinite(ctx.clock)) errors.push(err('CONTEXT_INVALID', 'ctx.session_id and ctx.clock are required'));
  if (errors.length) {
    append(db, {
      session_id: ctx?.session_id ?? null, ts_sim: ctx?.clock ?? null, portfolio_id: typeof spec?.portfolio_id === 'string' ? spec.portfolio_id : null,
      agent_id: typeof spec?.agent_id === 'string' ? spec.agent_id : null, actor, type: 'ORDER_REJECTED', ref_id: null,
      payload: { stage: 'validation', errors, spec: sanitizeSpec(spec) },
    });
    return { ok: false, code: errors[0].code, errors };
  }

  return atomic(db, () => {
    const kind = spec.kind ?? 'equity';
    const role = spec.role ?? (spec.side === 'buy' ? 'entry' : 'exit');
    const biz = [];
    const pf = getPortfolio(db, ctx.session_id, spec.portfolio_id);
    if (!pf) biz.push(err('PORTFOLIO_NOT_FOUND', `portfolio ${spec.portfolio_id} not found in session`));
    if (!ctx.ds) biz.push(err('NO_VERIFIED_DATA', 'no verified market dataset is loaded; orders cannot be evaluated'));
    // DAY orders live until the replay END: the 16:00 ET close, or a PARTIAL dataset's coverage end when earlier (no
    // later minute can ever be evaluated, so an order must neither be accepted after it nor outlive it).
    const win = ctx.ds ? replayWindowOf(db, ctx.ds) : null;
    if (ctx.ds && !win) biz.push(err('NO_VERIFIED_DATA', `dataset ${ctx.ds} has no trade date / session window`));
    if (win && ctx.clock >= win.close) {
      biz.push(err('SESSION_CLOSED', win.truncated
        ? `the replay has ended at the PARTIAL dataset's coverage end (${fmtEt(win.close)}, before the 16:00 ET close); no later minute can be evaluated`
        : 'the replay session has closed; DAY orders cannot be submitted'));
    }

    let instrument = instrumentId(kind, spec.sym);
    let optionCheck = null;
    if (kind === 'option') {
      optionCheck = checkOperationalOptionOrder(spec, { clock: ctx.clock, optionsQuote: spec.optionsQuote ?? null });
      if (!optionCheck.ok) biz.push(err(optionCheck.code, (optionCheck.errors || []).join('; ')));
      else instrument = instrumentId('option', optionCheck.contract.occ);
    }

    let parent = null;
    if (spec.parent_id) {
      parent = getOrder(db, spec.parent_id);
      if (!parent || parent.session_id !== ctx.session_id || parent.portfolio_id !== spec.portfolio_id) biz.push(err('PARENT_NOT_FOUND', 'parent order not found in this portfolio/session'));
      else if (!OPEN_STATUSES.includes(parent.status) && parent.status !== 'filled') biz.push(err('PARENT_NOT_OPEN', `parent is ${parent.status}`));
      else if (parent.side !== 'buy' || spec.side !== 'sell') biz.push(err('PARENT_INVALID', 'bracket children must be sells attached to a buy entry'));
      else if (spec.qty > parent.qty) biz.push(err('QTY_EXCEEDS_PARENT', 'child qty cannot exceed parent qty'));
    }
    const pending = !!parent && parent.filled_qty === 0;
    if (spec.side === 'sell' && !pending && pf) {
      const held = getPosition(db, ctx.session_id, spec.portfolio_id, instrument)?.qty ?? 0;
      if (spec.qty > held) biz.push(err('NO_SHORT_SELL_EXCEEDS_HELD', `sell qty ${spec.qty} exceeds held ${held} (no shorting)`));
    }
    let expires = win ? win.close : null;
    let expiryBasis = win ? (win.truncated ? 'REPLAY_END_TRUNCATED' : 'SESSION_CLOSE') : null;
    // Minute granularity: an order is only evaluated for whole minutes [t, t+60s) with t + 60s <= expires_ts.
    if (spec.expires_ts != null && expires != null) {
      const requested = Math.floor(spec.expires_ts / MINUTE) * MINUTE;
      if (requested < expires) { expires = requested; expiryBasis = 'REQUESTED'; }
    }
    if (expires != null && expires <= ctx.clock) biz.push(err('EXPIRY_IN_PAST', 'order would already be expired (expiry floored to the minute)'));

    const quote = kind === 'option' ? optionsProvenance(spec.optionsQuote) : quoteProvenance(db, ctx.ds, spec.sym, ctx.clock);
    const base = {
      session_id: ctx.session_id, portfolio_id: spec.portfolio_id, agent_id: spec.agent_id ?? null, intent_id: spec.intent_id ?? null,
      parent_id: spec.parent_id ?? null, oco_group: spec.oco_group ?? null, instrument_id: instrument, sym: spec.sym, kind,
      side: spec.side, type: spec.type, role, qty: spec.qty, limit_px: spec.limit_px ?? null, stop_px: spec.stop_px ?? null,
      protective: PROTECTIVE_ROLES.has(role), created_ts: ctx.clock, expires_ts: expires,
    };
    const meta = { ...(spec.meta ?? {}), tif: 'DAY', ...(expiryBasis ? { expiryBasis } : {}) };
    if (spec.attach?.time_exit_min != null) meta.time_exit = { minutes: spec.attach.time_exit_min, band_bps: spec.attach.time_exit_band_bps ?? null, note: 'monitored by the agent runner' };
    if (optionCheck?.ok) meta.contract = optionCheck.contract;
    const spendCap = spendCapFor(spec, spec.side === 'buy' ? intentBudgetU(db, ctx, spec) : null);
    if (spendCap) { meta.maxSpendU = spendCap.maxSpendU; meta.spendCap = spendCap; }
    if (pf) {
      const est = submitEstimate(spec, quote, costModelFor(ctx, pf, spec.sym, kind));
      if (est) meta.submitEstimate = est;
    }
    if (spec.expires_ts != null) meta.requestedExpiresTs = spec.expires_ts;

    if (biz.length) {
      if (!pf) {
        append(db, { session_id: ctx.session_id, ts_sim: ctx.clock, portfolio_id: spec.portfolio_id, agent_id: spec.agent_id ?? null, actor, type: 'ORDER_REJECTED', ref_id: null,
          payload: { stage: 'business', errors: biz, spec: sanitizeSpec(spec), quote } });
        return { ok: false, code: biz[0].code, errors: biz };
      }
      const rejected = insertOrder(db, { ...base, id: newId('ord'), status: 'rejected', reason: biz.map((e) => e.code).join(','), meta });
      journalOrder(db, ctx, rejected, 'ORDER_REJECTED', { stage: 'business', errors: biz, quote }, actor);
      return { ok: false, code: biz[0].code, errors: biz, order: rejected };
    }

    const order = insertOrder(db, { ...base, id: newId('ord'), status: pending ? 'pending_parent' : 'working', reason: spec.reason ?? null, meta });
    const stopCheck = stopVsBid(order, quote, 'SUBMIT');
    journalOrder(db, ctx, order, 'ORDER_SUBMITTED', {
      quote, reason: spec.reason ?? null, estimatedOnly: true, paperOnly: true,
      ...(spendCap ? { spendCap } : {}), ...(stopCheck ? { stopCheck } : {}),
    }, actor);

    const children = [];
    const a = spec.attach;
    if (a && (a.stop_loss_px_u != null || a.take_profit_px_u != null)) {
      const both = a.stop_loss_px_u != null && a.take_profit_px_u != null;
      const oco = both ? `oco_${order.id}` : null;
      const mk = (role2, type, px) => {
        const child = insertOrder(db, {
          ...base, id: newId('ord'), parent_id: order.id, oco_group: oco, side: 'sell', type, role: role2,
          limit_px: type === 'limit' ? px : null, stop_px: type === 'stop' ? px : null, protective: true, qty: spec.qty,
          status: 'pending_parent', reason: 'bracket child: activates when the entry fills', meta: { tif: 'DAY', bracket: true, ...(expiryBasis ? { expiryBasis } : {}) },
        });
        const childStopCheck = stopVsBid(child, quote, 'SUBMIT');
        journalOrder(db, ctx, child, 'ORDER_SUBMITTED', {
          quote, bracketChildOf: order.id, note: 'pending_parent until the entry fills; qty then = shares the bracket holds',
          ...(childStopCheck ? { stopCheck: childStopCheck } : {}),
        }, actor);
        children.push(child);
      };
      if (a.stop_loss_px_u != null) mk('stop_loss', 'stop', a.stop_loss_px_u);
      if (a.take_profit_px_u != null) mk('take_profit', 'limit', a.take_profit_px_u);
    }
    return { ok: true, order, children };
  });
}

function sanitizeSpec(spec) {
  if (!spec || typeof spec !== 'object') return null;
  const { optionsQuote, ...rest } = spec;
  return { ...rest, optionsQuote: optionsQuote ? optionsProvenance(optionsQuote) : undefined };
}

/**
 * Cancel an open order (working / pending_parent / triggered / partially_filled). Pending bracket children of a
 * cancelled entry are cancelled too.
 * @param {{by?:'human'|'agent'|'engine'|'system'|'policy', reason?:string, agent_id?:string|null, portfolio_id?:string}} opts
 */
export function cancelOrder(db, ctx, orderId, { by = 'human', reason = null, agent_id = null, portfolio_id = null } = {}) {
  const actor = ACTORS.has(by) ? by : 'human';
  return atomic(db, () => {
    const o = getOrder(db, orderId);
    const refuse = (code, detail) => {
      append(db, { session_id: ctx.session_id, ts_sim: ctx.clock ?? null, portfolio_id: o?.portfolio_id ?? portfolio_id, agent_id: agent_id ?? o?.agent_id ?? null,
        actor, type: 'ORDER_CANCEL_REJECTED', ref_id: orderId ?? null, payload: { code, detail, order_id: orderId ?? null, status: o?.status ?? null } });
      return { ok: false, code, errors: [err(code, detail)] };
    };
    if (!o || o.session_id !== ctx.session_id) return refuse('ORDER_NOT_FOUND', 'order not found in this session');
    if (portfolio_id && o.portfolio_id !== portfolio_id) return refuse('ORDER_PORTFOLIO_MISMATCH', 'order belongs to another portfolio');
    if (!OPEN_STATUSES.includes(o.status)) return refuse('ORDER_NOT_CANCELLABLE', `order is ${o.status}`);
    const ts = ctx.clock ?? o.updated_ts;
    db.prepare("UPDATE orders SET status = 'cancelled', updated_ts = ?, reason = ? WHERE id = ?").run(ts, `CANCELLED_BY_${actor.toUpperCase()}${reason ? ': ' + reason : ''}`, o.id);
    const after = getOrder(db, o.id);
    const quote = o.kind === 'option' ? { status: OPTIONS_STATUS } : quoteProvenance(db, ctx.ds, o.sym, ctx.clock);
    append(db, { session_id: ctx.session_id, ts_sim: ctx.clock ?? null, portfolio_id: o.portfolio_id, agent_id: agent_id ?? o.agent_id ?? null, actor,
      type: 'ORDER_CANCELLED', ref_id: o.id, payload: { ...orderSummary(after), previousStatus: o.status, by: actor, reason, quote } });
    const cascaded = [];
    for (const c of db.prepare("SELECT * FROM orders WHERE parent_id = ? AND status = 'pending_parent' ORDER BY created_ts, rowid").all(o.id)) {
      db.prepare("UPDATE orders SET status = 'cancelled', updated_ts = ?, reason = 'PARENT_CANCELLED' WHERE id = ?").run(ts, c.id);
      journalOrder(db, ctx, getOrder(db, c.id), 'ORDER_CANCELLED', { previousStatus: c.status, by: actor, reason: 'PARENT_CANCELLED', quote }, actor);
      cascaded.push(c.id);
    }
    return { ok: true, order: after, cascaded };
  });
}

/**
 * Amend a working / pending_parent order in place (same id). Only prices and qty may change; the new terms
 * apply from the next evaluated minute. Journals ORDER_REPLACED with before/after.
 */
export function replaceOrder(db, ctx, orderId, { stop_px, limit_px, qty, by = 'human', reason = null, agent_id = null, portfolio_id = null } = {}) {
  const actor = ACTORS.has(by) ? by : 'human';
  return atomic(db, () => {
    const o = getOrder(db, orderId);
    const refuse = (code, detail) => {
      append(db, { session_id: ctx.session_id, ts_sim: ctx.clock ?? null, portfolio_id: o?.portfolio_id ?? portfolio_id, agent_id: agent_id ?? o?.agent_id ?? null,
        actor, type: 'ORDER_REPLACE_REJECTED', ref_id: orderId ?? null, payload: { code, detail, order_id: orderId ?? null, requested: { stop_px, limit_px, qty } } });
      return { ok: false, code, errors: [err(code, detail)] };
    };
    if (!o || o.session_id !== ctx.session_id) return refuse('ORDER_NOT_FOUND', 'order not found in this session');
    if (portfolio_id && o.portfolio_id !== portfolio_id) return refuse('ORDER_PORTFOLIO_MISMATCH', 'order belongs to another portfolio');
    if (o.status !== 'working' && o.status !== 'pending_parent') return refuse('ORDER_NOT_REPLACEABLE', `order is ${o.status}; only working/pending_parent orders can be replaced`);
    if (stop_px === undefined && limit_px === undefined && qty === undefined) return refuse('NOTHING_TO_REPLACE', 'no new terms given');
    const next = { stop_px: o.stop_px, limit_px: o.limit_px, qty: o.qty };
    if (stop_px !== undefined) {
      if (o.type !== 'stop' && o.type !== 'stop_limit') return refuse('STOP_NOT_ALLOWED', `stop_px not allowed for ${o.type}`);
      if (!isValidTick(stop_px)) return refuse('TICK_INVALID', 'stop_px must be a valid Reg NMS 612 tick');
      next.stop_px = stop_px;
    }
    if (limit_px !== undefined) {
      if (o.type !== 'limit' && o.type !== 'stop_limit') return refuse('LIMIT_NOT_ALLOWED', `limit_px not allowed for ${o.type}`);
      if (!isValidTick(limit_px)) return refuse('TICK_INVALID', 'limit_px must be a valid Reg NMS 612 tick');
      next.limit_px = limit_px;
    }
    if (qty !== undefined) {
      if (!Number.isSafeInteger(qty) || qty <= 0) return refuse('QTY_INVALID', 'qty must be a positive integer');
      if (qty < o.filled_qty) return refuse('QTY_BELOW_FILLED', 'qty cannot go below the filled qty');
      if (o.side === 'sell' && o.status === 'working') {
        const held = getPosition(db, ctx.session_id, o.portfolio_id, o.instrument_id)?.qty ?? 0;
        if (qty - o.filled_qty > held) return refuse('NO_SHORT_SELL_EXCEEDS_HELD', `remaining sell qty exceeds held ${held}`);
      }
      if (o.parent_id) {
        const p = getOrder(db, o.parent_id);
        if (p && qty > p.qty) return refuse('QTY_EXCEEDS_PARENT', 'child qty cannot exceed parent qty');
      }
      next.qty = qty;
    }
    db.prepare('UPDATE orders SET stop_px = ?, limit_px = ?, qty = ?, updated_ts = ?, reason = ? WHERE id = ?')
      .run(next.stop_px, next.limit_px, next.qty, ctx.clock ?? o.updated_ts, reason ? `REPLACED: ${reason}` : 'REPLACED', o.id);
    const quote = o.kind === 'option' ? { status: OPTIONS_STATUS } : quoteProvenance(db, ctx.ds, o.sym, ctx.clock);
    // A pending entry's qty change carries to its pending bracket children (each change journaled).
    const cascaded = [];
    if (next.qty !== o.qty) {
      for (const c of db.prepare("SELECT * FROM orders WHERE parent_id = ? AND status = 'pending_parent' ORDER BY created_ts, rowid").all(o.id)) {
        if (c.qty === next.qty) continue;
        db.prepare('UPDATE orders SET qty = ?, updated_ts = ? WHERE id = ?').run(next.qty, ctx.clock ?? c.updated_ts, c.id);
        journalOrder(db, ctx, getOrder(db, c.id), 'BRACKET_CHILD_QTY_UPDATED',
          { parent_id: o.id, previousQty: c.qty, cascadedFrom: o.id, cause: 'PARENT_REPLACED', by: actor, reason, quote }, actor);
        cascaded.push({ order_id: c.id, before: c.qty, after: next.qty });
      }
    }
    const after = getOrder(db, o.id);
    const stopCheck = stopVsBid(after, quote, 'REPLACE');
    append(db, { session_id: ctx.session_id, ts_sim: ctx.clock ?? null, portfolio_id: o.portfolio_id, agent_id: agent_id ?? o.agent_id ?? null, actor,
      type: 'ORDER_REPLACED', ref_id: o.id, payload: {
        ...orderSummary(after), before: { stop_px: o.stop_px, limit_px: o.limit_px, qty: o.qty }, after: next, by: actor, reason, quote, cascaded,
        ...(stopCheck ? { stopCheck } : {}),
      } });
    return { ok: true, order: after, cascaded };
  });
}

/** Expire every open order (incl. pending bracket children) whose expires_ts <= atTs. */
export function expireOrders(db, ctx, atTs) {
  return atomic(db, () => expireDue(db, ctx, atTs));
}

/** What an order's expiry was, from meta.expiryBasis (orders older than that field: compared with the 16:00 close). */
function expiryOf(db, ctx, o) {
  const basis = parseMeta(o).expiryBasis;
  const at = o.expires_ts;
  const when = Number.isFinite(at) ? `${fmtEt(at)}` : 'its expiry';
  if (basis === 'REPLAY_END_TRUNCATED') {
    return { code: 'DAY_ORDER_EXPIRED_AT_REPLAY_END', text: `DAY order expired at the replay end (${when}): the PARTIAL dataset's coverage end, before the 16:00 ET close` };
  }
  if (basis === 'REQUESTED') return { code: 'ORDER_EXPIRED_AT_REQUESTED_EXPIRY', text: `order expired at its requested expiry (${when})` };
  if (basis === 'SESSION_CLOSE') return { code: 'DAY_ORDER_EXPIRED_AT_SESSION_CLOSE', text: 'DAY order expired at session close (16:00 ET)' };
  const close = ctx.ds ? replayWindowOf(db, ctx.ds)?.sessionClose : null;
  return Number.isFinite(close) && at < close
    ? { code: 'ORDER_EXPIRED_AT_REQUESTED_EXPIRY', text: `order expired at its expiry (${when}), before the 16:00 ET close` }
    : { code: 'DAY_ORDER_EXPIRED_AT_SESSION_CLOSE', text: 'DAY order expired at session close (16:00 ET)' };
}

function expireDue(db, ctx, atTs) {
  const due = db.prepare(`SELECT * FROM orders WHERE session_id = ? AND status IN (${OPEN_STATUSES.map(() => '?').join(',')})
    AND expires_ts IS NOT NULL AND expires_ts <= ? ORDER BY created_ts, rowid`).all(ctx.session_id, ...OPEN_STATUSES, atTs);
  const out = [];
  for (const o of due) {
    const lastWithheld = o.reason && o.reason.startsWith('WITHHELD:') ? o.reason.slice(9) : null;
    const exp = expiryOf(db, ctx, o);
    db.prepare("UPDATE orders SET status = 'expired', updated_ts = ?, reason = ? WHERE id = ?")
      .run(atTs, lastWithheld ? `EXPIRED_AFTER_UNFILLABLE:${lastWithheld}` : exp.code, o.id);
    journalOrder(db, { ...ctx, clock: ctx.clock ?? atTs }, getOrder(db, o.id), 'ORDER_EXPIRED',
      { previousStatus: o.status, reason: exp.text, expiryCode: exp.code, lastWithheldReason: lastWithheld, unfilledQty: o.qty - o.filled_qty });
    out.push(o.id);
  }
  return out;
}

/**
 * Replay end: expire EVERY order of the session still open at `atTs`, whatever its recorded expires_ts (e.g. an order
 * placed with a 16:00 ET expiry in a session whose dataset later turned out to be PARTIAL). No later minute can be
 * evaluated, so leaving it 'working' would misstate the book. updated_ts = atTs (never the later 16:00 close).
 * @returns {string[]} expired order ids
 */
export function expireOpenAtReplayEnd(db, ctx, atTs, { reasonCode = 'REPLAY_END_TRUNCATED', detail = null } = {}) {
  return atomic(db, () => {
    const open = db.prepare(`SELECT * FROM orders WHERE session_id = ? AND status IN (${OPEN_STATUSES.map(() => '?').join(',')})
      ORDER BY created_ts, rowid`).all(ctx.session_id, ...OPEN_STATUSES);
    const out = [];
    for (const o of open) {
      const lastWithheld = o.reason && o.reason.startsWith('WITHHELD:') ? o.reason.slice(9) : null;
      db.prepare("UPDATE orders SET status = 'expired', updated_ts = ?, reason = ? WHERE id = ?")
        .run(atTs, lastWithheld ? `EXPIRED_AFTER_UNFILLABLE:${lastWithheld}` : reasonCode, o.id);
      journalOrder(db, { ...ctx, clock: ctx.clock ?? atTs }, getOrder(db, o.id), 'ORDER_EXPIRED', {
        previousStatus: o.status, expiryCode: reasonCode, recordedExpiresTs: o.expires_ts, lastWithheldReason: lastWithheld, unfilledQty: o.qty - o.filled_qty,
        reason: detail ?? `expired at the replay end (${fmtEt(atTs)}): no later minute can be evaluated; its recorded expiry was ${Number.isFinite(o.expires_ts) ? `${fmtEt(o.expires_ts)}` : 'unset'}`,
      });
      out.push(o.id);
    }
    return out;
  });
}

/**
 * Processing order for one minute: each bracket (entry + its children) is one unit, placed where its first order
 * appears in the (created_ts, rowid) snapshot, with the children (exits) BEFORE the entry. So a child never sells
 * shares the entry bought in the same minute, and a child that executes cancels the entry remainder before the
 * entry is evaluated. Deterministic for identical inputs.
 */
function exitsFirstOrder(snapshot) {
  const units = new Map();
  for (const o of snapshot) {
    const key = o.parent_id ?? o.id;
    let u = units.get(key);
    if (!u) { u = { exits: [], entry: null }; units.set(key, u); }
    if (o.parent_id) u.exits.push(o); else u.entry = o;
  }
  const out = [];
  for (const u of units.values()) { out.push(...u.exits); if (u.entry) out.push(u.entry); }
  return out;
}

const consumedKey = (o) => `${o.portfolio_id}|${o.instrument_id}|${o.side}`;

/**
 * Evaluate every eligible order for completed minute [t, t+60s) and apply the results. Must be called with
 * ctx.clock >= t + 60s (fillMinute enforces no look-ahead). One transaction per minute.
 * @param {{session_id:string, ds:string|null, clock:number, costModels?:object,
 *          optionsProvider?:{quoteAsOf(contract:object, asOf:number):object|null}}} ctx
 */
export function processMinute(db, ctx, t) {
  const summary = { t, clock: ctx.clock, evaluated: 0, fills: [], triggered: [], withheld: [], expired: [], cancelled: [], activated: [], ambiguities: [] };
  if (!ctx.ds) return { ...summary, status: 'NO_VERIFIED_DATA' };
  if (!Number.isSafeInteger(t) || t % MINUTE !== 0) throw new RangeError('t must be a minute-aligned ms timestamp');
  if (!(t + MINUTE <= ctx.clock)) throw new Error(`look-ahead blocked: minute ${t} not complete at clock ${ctx.clock}`);

  return atomic(db, () => {
    // Orders whose expiry is at/before the start of this minute are not eligible for it.
    summary.expired.push(...expireDue(db, ctx, t));
    const snapshot = db.prepare(`SELECT * FROM orders WHERE session_id = ? AND status IN ('working', 'triggered', 'partially_filled')
      AND created_ts <= ? ORDER BY created_ts, rowid`).all(ctx.session_id, t);
    const minutes = new Map();
    const ms = {
      minuteFor(sym) {
        if (!minutes.has(sym)) minutes.set(sym, fillMinute(db, ctx.ds, sym, t, ctx.clock));
        return minutes.get(sym);
      },
      // Displayed size / trade-through proxy already taken this minute, per portfolio|instrument|side and size source.
      consumed: new Map(),
    };
    const done = new Set();
    for (const o of exitsFirstOrder(snapshot)) {
      if (done.has(o.id)) continue;
      if (o.oco_group) {
        const group = snapshot.filter((x) => x.oco_group === o.oco_group);
        group.forEach((x) => done.add(x.id));
        processOcoGroup(db, ctx, t, group.map((x) => x.id), ms, summary);
      } else {
        done.add(o.id);
        const fresh = getOrder(db, o.id);
        if (!EVALUABLE.includes(fresh.status)) continue;
        const ev = evaluateOne(db, ctx, t, fresh, ms, summary);
        if (ev) applyResult(db, ctx, t, fresh, ev, summary, ms);
      }
    }
    // After the last minute before expiry (e.g. 15:59-16:00) open DAY orders cannot be evaluated again.
    summary.expired.push(...expireDue(db, ctx, t + MINUTE));
    return summary;
  });
}

/** What this order's earlier fills already spent (qty * price * multiplier + fees), u. */
function spentOn(db, order) {
  const r = db.prepare('SELECT COALESCE(SUM(qty * price), 0) AS gross, COALESCE(SUM(fees), 0) AS fees FROM fills WHERE order_id = ?').get(order.id);
  return r.gross * (order.kind === 'option' ? OPTIONS_MULTIPLIER : 1) + r.fees;
}

/** Evaluate without applying. Returns {result, observed, pf, cm} or null when the order was closed out instead. */
function evaluateOne(db, ctx, t, order, ms, summary) {
  summary.evaluated++;
  const pf = getPortfolio(db, ctx.session_id, order.portfolio_id);
  const cm = costModelFor(ctx, pf, order.sym, order.kind);
  const posQty = getPosition(db, ctx.session_id, order.portfolio_id, order.instrument_id)?.qty ?? 0;
  if (order.side === 'sell' && posQty <= 0) {
    // Nothing left to protect/sell (position closed elsewhere): cancel rather than evaluate a short sale.
    db.prepare("UPDATE orders SET status = 'cancelled', updated_ts = ?, reason = 'POSITION_CLOSED' WHERE id = ?").run(ctx.clock, order.id);
    journalOrder(db, ctx, getOrder(db, order.id), 'ORDER_CANCELLED', { previousStatus: order.status, by: 'engine', reason: 'POSITION_CLOSED (no shares held; no shorting)', minuteT: t });
    summary.cancelled.push(order.id);
    return null;
  }
  const meta = parseMeta(order);
  const spend = order.side === 'buy' && Number.isSafeInteger(meta.maxSpendU) ? { maxSpendU: meta.maxSpendU, spentU: spentOn(db, order) } : {};
  if (order.kind === 'option') {
    const q = ctx.optionsProvider?.quoteAsOf ? ctx.optionsProvider.quoteAsOf(meta.contract, t + MINUTE) : null;
    if (!q) return { result: { action: 'unfillable', reason: OPTIONS_STATUS, observed: { status: OPTIONS_STATUS, minuteT: t } }, cm, pf };
    const result = evaluateOptionOrder(order, q, cm, { cashU: pf.cash, positionQty: posQty, clock: t + MINUTE, ...spend });
    return { result, cm, pf };
  }
  const minute = ms.minuteFor(order.sym);
  const consumed = ms.consumed.get(consumedKey(order)) ?? {};
  const result = evaluateOrder(order, minute, cm, { cashU: pf.cash, positionQty: posQty, ds: ctx.ds, consumed, ...spend });
  return { result, observed: result.observed ?? observedFromMinute(minute, { ds: ctx.ds }), cm, pf };
}

function markTriggered(db, ctx, t, order, observed, summary) {
  if (order.triggered_ts != null) return;
  db.prepare("UPDATE orders SET status = CASE WHEN filled_qty > 0 THEN status ELSE 'triggered' END, triggered_ts = ?, updated_ts = ? WHERE id = ?")
    .run(t, ctx.clock, order.id);
  order.triggered_ts = t;
  journalOrder(db, ctx, getOrder(db, order.id), 'STOP_TRIGGERED', {
    minuteT: t, stop_px: order.stop_px, observed,
    note: order.type === 'stop' ? 'stop became a market order; fill estimated in the same minute when data allows' : 'stop-limit became a limit order',
  });
  summary.triggered.push(order.id);
}

/**
 * Engine cancellation of an open order's unfilled remainder (journaled ORDER_CANCELLED, actor engine). Pending bracket
 * children of a cancelled entry are cancelled too (PARENT_CANCELLED).
 */
function cancelByEngine(db, ctx, t, o, reason, extra, summary) {
  db.prepare("UPDATE orders SET status = 'cancelled', updated_ts = ?, reason = ? WHERE id = ?").run(ctx.clock, reason, o.id);
  journalOrder(db, ctx, getOrder(db, o.id), 'ORDER_CANCELLED', { previousStatus: o.status, by: 'engine', reason, minuteT: t, unfilledQty: o.qty - o.filled_qty, ...extra });
  summary.cancelled.push(o.id);
  for (const c of db.prepare("SELECT * FROM orders WHERE parent_id = ? AND status = 'pending_parent' ORDER BY created_ts, rowid").all(o.id)) {
    db.prepare("UPDATE orders SET status = 'cancelled', updated_ts = ?, reason = 'PARENT_CANCELLED' WHERE id = ?").run(ctx.clock, c.id);
    journalOrder(db, ctx, getOrder(db, c.id), 'ORDER_CANCELLED', { previousStatus: c.status, by: 'engine', reason: 'PARENT_CANCELLED', parent_id: o.id, minuteT: t });
    summary.cancelled.push(c.id);
  }
}

function applyResult(db, ctx, t, order, ev, summary, ms = null) {
  const r = ev.result;
  const observed = r.observed ?? ev.observed ?? null;
  if (r.action === 'none') return null;
  if (r.action === 'trigger') { markTriggered(db, ctx, t, order, observed, summary); return null; }
  if (r.action === 'unfillable') {
    if (r.triggered) markTriggered(db, ctx, t, order, observed, summary);
    if (r.reason === 'NO_POSITION_HELD') return null; // handled by POSITION_CLOSED cancellation
    if (r.spendCapReached) {
      // Waiting for a cheaper price would turn the order into an implicit limit order: cancel the remainder instead.
      cancelByEngine(db, ctx, t, getOrder(db, order.id), 'SPEND_CAP_REACHED', {
        detail: 'no whole share/contract fits under the order spend cap at the estimated fill price', spendCapReason: r.reason, observed,
      }, summary);
      return null;
    }
    db.prepare('UPDATE orders SET reason = ?, updated_ts = ? WHERE id = ?').run(`WITHHELD:${r.reason}`, ctx.clock, order.id);
    const after = getOrder(db, order.id);
    journalOrder(db, ctx, after, 'FILL_WITHHELD', {
      minuteT: t, reason: r.reason, observed, note: 'UNFILLABLE this minute — no fill manufactured; order stays open until it fills, is cancelled or expires',
      retryNextMinute: after.status === 'triggered' ? 'as market order' : 'yes',
    });
    summary.withheld.push({ order_id: order.id, reason: r.reason });
    return null;
  }
  if (r.action !== 'fill') throw new Error(`unknown evaluation action ${r.action}`);
  if (r.triggered) markTriggered(db, ctx, t, order, observed, summary);
  const filledAfter = order.filled_qty + r.qty;
  const statusAfter = filledAfter >= order.qty ? 'filled' : 'partially_filled';
  const applied = applyFill(db, {
    session_id: ctx.session_id, order, ts_sim: ctx.clock,
    fill: { qty: r.qty, priceU: r.priceU, feesU: r.feesU, ts: t, multiplier: r.multiplier, assumptions: r.assumptions, observed, triggered: r.triggered, worseThanStop: r.worseThanStop },
    journalExtra: { orderStatusAfter: statusAfter, orderFilledQtyAfter: filledAfter, orderQty: order.qty, ...(r.slippageFromStopU !== undefined ? { slippageFromStopU: r.slippageFromStopU } : {}) },
  });
  db.prepare('UPDATE orders SET filled_qty = ?, status = ?, updated_ts = ?, reason = ? WHERE id = ?')
    .run(filledAfter, statusAfter, ctx.clock, statusAfter === 'filled' ? 'FILLED (estimated)' : 'PARTIALLY_FILLED (estimated)', order.id);
  summary.fills.push({ order_id: order.id, fill_id: applied.fillId, qty: r.qty, priceU: r.priceU, feesU: r.feesU, worseThanStop: r.worseThanStop ?? false });
  const src = r.assumptions?.sizeSource;
  if (ms && src) {
    const k = consumedKey(order);
    const c = ms.consumed.get(k) ?? {};
    ms.consumed.set(k, { ...c, [src]: (c[src] ?? 0) + r.qty });
  }
  if (order.side === 'buy') {
    activateChildren(db, ctx, t, order.id, filledAfter, summary);
    if (statusAfter !== 'filled' && r.assumptions?.qtyLimitedBy?.includes('SPEND_CAP')) {
      cancelByEngine(db, ctx, t, getOrder(db, order.id), 'SPEND_CAP_REACHED', {
        detail: 'the spend cap bound this fill; the remainder is cancelled rather than waiting for a cheaper price', spendCap: r.assumptions.spendCap ?? null,
      }, summary);
    }
  } else {
    clampSellsToHeld(db, ctx, t, order, summary);
    if (order.parent_id && PROTECTIVE_ROLES.has(order.role)) cancelParentRemainder(db, ctx, t, order, summary);
  }
  return { filledAfter, statusAfter };
}

/** A protective child executed: the bracket is exiting, so the entry's unfilled remainder is cancelled. */
function cancelParentRemainder(db, ctx, t, child, summary) {
  const p = getOrder(db, child.parent_id);
  if (!p || !OPEN_STATUSES.includes(p.status)) return;
  cancelByEngine(db, ctx, t, p, 'PARENT_REMAINDER_CANCELLED_AFTER_PROTECTIVE_EXIT', {
    child_order_id: child.id, child_role: child.role,
    note: 'a protective child of this bracket executed; later entry fills would have no protective order, so the entry remainder is cancelled',
  }, summary);
}

/**
 * After a sell fill: open bracket children on the instrument are clamped to the shares still held (journaled
 * BRACKET_CHILD_QTY_UPDATED); with nothing held every open sell on it is cancelled (POSITION_CLOSED) in the same
 * minute. OCO siblings of the filled order are left to settleSiblings.
 */
function clampSellsToHeld(db, ctx, t, cause, summary) {
  const held = getPosition(db, ctx.session_id, cause.portfolio_id, cause.instrument_id)?.qty ?? 0;
  const rows = db.prepare(`SELECT * FROM orders WHERE session_id = ? AND portfolio_id = ? AND instrument_id = ? AND side = 'sell'
    AND status IN ('working', 'triggered', 'partially_filled') ORDER BY created_ts, rowid`).all(ctx.session_id, cause.portfolio_id, cause.instrument_id);
  for (const o of rows) {
    if (o.id !== cause.id && cause.oco_group && o.oco_group === cause.oco_group) continue;
    if (held <= 0) {
      cancelByEngine(db, ctx, t, o, 'POSITION_CLOSED', { cause_order_id: cause.id, detail: 'no shares held after this sell fill (no shorting)' }, summary);
      continue;
    }
    if (!o.parent_id || o.protective !== 1) continue;
    if (o.qty - o.filled_qty > held) {
      db.prepare('UPDATE orders SET qty = ?, updated_ts = ? WHERE id = ?').run(o.filled_qty + held, ctx.clock, o.id);
      journalOrder(db, ctx, getOrder(db, o.id), 'BRACKET_CHILD_QTY_UPDATED', {
        parent_id: o.parent_id, previousQty: o.qty, heldAfter: held, cause_order_id: cause.id, cause: 'POSITION_REDUCED', minuteT: t,
      });
    }
  }
}

/**
 * Bracket children follow the shares the bracket still holds: entry filled qty minus what the children already sold,
 * never more than the position. Pending children become working (eligible from the NEXT minute).
 */
function activateChildren(db, ctx, t, parentId, parentFilled, summary) {
  const kids = db.prepare('SELECT * FROM orders WHERE parent_id = ? ORDER BY created_ts, rowid').all(parentId);
  if (!kids.length) return;
  const parent = getOrder(db, parentId);
  const soldByBracket = kids.reduce((s, c) => s + (c.filled_qty || 0), 0);
  const held = getPosition(db, ctx.session_id, parent.portfolio_id, parent.instrument_id)?.qty ?? 0;
  const protectQty = Math.max(0, Math.min(parentFilled - soldByBracket, held));
  let quote;
  for (const c of kids) {
    if (!OPEN_STATUSES.includes(c.status)) continue;
    const qty = c.filled_qty + protectQty;
    if (c.status === 'pending_parent') {
      if (quote === undefined) quote = c.kind === 'option' ? null : quoteProvenance(db, ctx.ds, c.sym, ctx.clock);
      const stopCheck = stopVsBid(c, quote, 'ACTIVATION');
      db.prepare("UPDATE orders SET status = 'working', qty = ?, updated_ts = ? , reason = 'BRACKET_ACTIVATED' WHERE id = ?").run(qty, ctx.clock, c.id);
      journalOrder(db, ctx, getOrder(db, c.id), 'BRACKET_CHILD_ACTIVATED', {
        parent_id: parentId, parentFilledQty: parentFilled, protectedQty: protectQty, minuteT: t, eligibleFromMinute: t + MINUTE,
        ...(stopCheck ? { stopCheck, quote } : {}),
      });
      summary.activated.push(c.id);
    } else if (c.qty !== qty) {
      db.prepare('UPDATE orders SET qty = ?, updated_ts = ? WHERE id = ?').run(qty, ctx.clock, c.id);
      journalOrder(db, ctx, getOrder(db, c.id), 'BRACKET_CHILD_QTY_UPDATED', {
        parent_id: parentId, parentFilledQty: parentFilled, previousQty: c.qty, soldByBracket, heldAfter: held, minuteT: t, eligibleFromMinute: t + MINUTE,
      });
    }
  }
}

const isStopish = (o) => o.type === 'stop' || o.type === 'stop_limit' || o.role === 'stop_loss';

function processOcoGroup(db, ctx, t, ids, ms, summary) {
  const members = ids.map((id) => getOrder(db, id)).filter((o) => o && EVALUABLE.includes(o.status));
  if (!members.length) return;
  const evals = [];
  for (const o of members) {
    const ev = evaluateOne(db, ctx, t, o, ms, summary);
    if (ev) evals.push({ order: o, ev });
  }
  const fills = evals.filter((e) => e.ev.result.action === 'fill');
  const stopActive = evals.filter((e) => isStopish(e.order) && (e.ev.result.action === 'fill' || e.ev.result.action === 'trigger'
    || (e.ev.result.action === 'unfillable' && e.ev.result.triggered)));
  const otherFills = fills.filter((e) => !isStopish(e.order));
  const ambiguous = fills.length >= 2 || (stopActive.length > 0 && otherFills.length > 0);

  let toApply = evals;
  if (ambiguous) {
    const chosen = stopActive[0] ?? fills.find((e) => isStopish(e.order)) ?? fills[0];
    const discarded = evals.filter((e) => e !== chosen && e.ev.result.action === 'fill');
    append(db, {
      session_id: ctx.session_id, ts_sim: ctx.clock, portfolio_id: chosen.order.portfolio_id, agent_id: chosen.order.agent_id ?? null, actor: 'engine',
      type: 'OCO_SAME_MINUTE_AMBIGUITY', ref_id: chosen.order.oco_group,
      payload: {
        oco_group: chosen.order.oco_group, minuteT: t, resolution: 'STOP_LOSS_FIRST_CONSERVATIVE',
        note: 'Both OCO siblings could have executed in the same minute; intra-minute order is unknown, so the stop is assumed to execute first.',
        chosen_order_id: chosen.order.id,
        candidates: evals.map((e) => ({ order_id: e.order.id, role: e.order.role, type: e.order.type, action: e.ev.result.action,
          priceU: e.ev.result.priceU ?? null, qty: e.ev.result.qty ?? null, triggered: e.ev.result.triggered ?? false, reason: e.ev.result.reason ?? null })),
        discarded_fills: discarded.map((e) => e.order.id),
        observed: chosen.ev.result.observed ?? chosen.ev.observed ?? null,
      },
    });
    summary.ambiguities.push(chosen.order.oco_group);
    // Siblings' would-be fills are discarded; non-fill outcomes (withheld etc.) are still journaled.
    toApply = evals.filter((e) => e === chosen || e.ev.result.action !== 'fill');
  }
  for (const e of toApply) {
    const cur = getOrder(db, e.order.id);
    if (!EVALUABLE.includes(cur.status)) continue;
    const out = applyResult(db, ctx, t, cur, e.ev, summary, ms);
    if (out) settleSiblings(db, ctx, t, cur, out, summary);
  }
}

/**
 * After an OCO member fills: fully filled -> cancel siblings; partially -> shrink siblings to the member's remaining
 * qty and never above the shares still held (a sibling with nothing left to cover is cancelled).
 */
function settleSiblings(db, ctx, t, member, out, summary) {
  const m = getOrder(db, member.id);
  const remaining = OPEN_STATUSES.includes(m.status) ? m.qty - m.filled_qty : 0;
  const held = getPosition(db, ctx.session_id, m.portfolio_id, m.instrument_id)?.qty ?? 0;
  const sibs = db.prepare(`SELECT * FROM orders WHERE oco_group = ? AND id != ? AND status IN (${OPEN_STATUSES.map(() => '?').join(',')}) ORDER BY created_ts, rowid`)
    .all(member.oco_group, member.id, ...OPEN_STATUSES);
  for (const s of sibs) {
    const newQty = s.filled_qty + Math.max(0, Math.min(s.qty - s.filled_qty, remaining, held));
    if (out.statusAfter === 'filled' || newQty <= s.filled_qty) {
      const reason = out.statusAfter !== 'filled' && held <= 0 ? 'POSITION_CLOSED' : 'OCO_SIBLING_FILLED';
      db.prepare("UPDATE orders SET status = 'cancelled', updated_ts = ?, reason = ? WHERE id = ?").run(ctx.clock, reason, s.id);
      journalOrder(db, ctx, getOrder(db, s.id), 'ORDER_CANCELLED', { previousStatus: s.status, by: 'engine', reason, sibling_order_id: member.id, minuteT: t });
      summary.cancelled.push(s.id);
    } else if (newQty !== s.qty) {
      db.prepare('UPDATE orders SET qty = ?, updated_ts = ? WHERE id = ?').run(newQty, ctx.clock, s.id);
      journalOrder(db, ctx, getOrder(db, s.id), 'OCO_SIBLING_REDUCED', { previousQty: s.qty, sibling_order_id: member.id, heldAfter: held, minuteT: t });
    }
  }
}
