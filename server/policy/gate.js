// Deterministic, deny-by-default policy gate (docs/CONTRACTS.md section 5).
//
// evaluate(intent, gctx) is a PURE function of the intent and the facts in gctx: it never reads the database
// or the wall clock. buildGateContext() collects those facts from the database as-of the replay clock.
// Deny-by-default:
//   * every rule in REQUIRED_RULES must exist in gctx.policy.rules -> otherwise DENY `RULE_MISSING:<name>`,
//   * any failed rule -> DENY,
//   * any thrown error -> DENY `GATE_ERROR`,
//   * unknown/absent facts (no quote, no kill state, no agent grant, ...) fail the rule that needs them.
// The result always lists a check for every rule (rules not reached are reported as not evaluated).
import { isValidTick, usdToU } from '../util/money.js';
import { MINUTE, isRegularSession } from '../util/time.js';
import { append } from '../journal.js';
import { quoteAsOf, lastTradeAsOf, replayWindowOf } from '../data/marketdata.js';
import { PRICE_TIERS, largeCapList, BENCHMARKS, KNOWN_TEST_SYMBOLS } from '../data/universe.js';
import { computeFees, slippedPrice, defaultCostModel, costSegmentFor } from '../sim/fills.js';
import { portfolioSummary } from '../sim/ledger.js';
import { validateOptionsQuote, OPTIONS_STATUS, OPTIONS_MULTIPLIER } from '../sim/options.js';
import { validateIntent } from '../agents/intents.js';
import { REQUIRED_RULES, DEFAULT_DENY_ISSUE_TYPES, defaultPolicyFor } from './config.js';

/** Constant. There is no setting that changes it. */
export const PAPER_ONLY = true;

/** controls-table keys read for the kill switch state (JSON {engaged, at, by, protective_policy}). */
export const KILL_CONTROL_KEYS = Object.freeze(['kill_switch', 'kill']);

const ok = (detail) => ({ pass: true, detail });
const fail = (code, detail) => ({ pass: false, code, detail });
const na = (why) => ({ pass: true, detail: `not applicable: ${why}`, applicable: false });

const isEntry = (it) => it.action === 'open';
const isRiskIncreasing = (it) => it.action === 'open' || (it.action === 'modify' && it.side === 'buy');
const isHumanCancel = (it) => it.source === 'human' && it.action === 'cancel';
const fmt$ = (u) => `$${(u / 10000).toFixed(4)}`;

/**
 * A buy modify that can add exposure: more shares than the target still has to buy, a higher (or new) limit, or a moved
 * stop trigger. An unknown target counts as increasing (target_order_matches denies it anyway). `qty` is compared with
 * the target's REMAINING qty (the API gates a replace on what is still to trade); a caller that sends the total qty
 * is judged as increasing, which only applies more rules.
 */
function isBuyIncrease(it, f) {
  if (it.action !== 'modify' || it.side !== 'buy') return false;
  const t = f.targetOrder;
  if (!t) return true;
  const remaining = t.qty - (t.filled_qty ?? 0);
  if (it.qty !== undefined && !(it.qty <= remaining)) return true;
  if (it.limit_px_u !== undefined && !(t.limit_px != null && it.limit_px_u <= t.limit_px)) return true;
  if (it.stop_px_u !== undefined && it.stop_px_u !== t.stop_px) return true;
  return false;
}

/** Rules that guard new exposure apply to entries and to risk-increasing buy modifies alike. */
const addsExposure = (it, f) => isEntry(it) || isBuyIncrease(it, f);

const ISSUE_SUFFIX = { '+': 'warrant', '^': 'right', '=': 'unit', '#': 'when_issued' };
const FIFTH_LETTER = { W: 'warrant', R: 'right', U: 'unit' };

/**
 * Issue type implied by the SYMBOL alone — never by the (post-dated) symbol directory. Returns {type, basis} or null when
 * the pattern says nothing. Patterns: IEX symbology suffix '+' warrant, '^' right, '=' unit, '#' when-issued (BBAI+, NE+A,
 * OCAC^, AIIA=); ACT/CQS dot suffix .W/.WS/.WT warrant, .R/.RT right, .U unit; a Nasdaq 5-letter symbol whose fifth
 * letter is W (warrant), R (right) or U (unit). A heuristic used as a policy input (symbol_allowed.denyIssueTypes).
 */
export function issueTypeFromSymbol(sym) {
  const s = String(sym ?? '');
  let m = /([+^=#])[A-Z0-9]{0,2}$/.exec(s);
  if (m && m.index > 0) return { type: ISSUE_SUFFIX[m[1]], basis: `IEX symbol suffix '${m[1]}'` };
  if ((m = /\.(WS|WT|W)(\.?[A-Z])?$/.exec(s))) return { type: 'warrant', basis: `symbol suffix '.${m[1]}'` };
  if ((m = /\.(RT|R)$/.exec(s))) return { type: 'right', basis: `symbol suffix '.${m[1]}'` };
  if (/\.U$/.test(s)) return { type: 'unit', basis: "symbol suffix '.U'" };
  if ((m = /^[A-Z]{4}([WRU])$/.exec(s))) return { type: FIFTH_LETTER[m[1]], basis: `Nasdaq 5-letter symbol with fifth letter '${m[1]}'` };
  return null;
}

function heldQty(it, f) {
  const key = it.instrument.kind === 'option' ? String(it.instrument.contract?.occ ?? '').replace(/\s+/g, '') : it.instrument.sym;
  const p = (f.positions || []).find((x) => x.instrument_id === key || (it.instrument.kind === 'equity' && x.kind !== 'option' && x.sym === key));
  return p ? p.qty : 0;
}

/** Cost model the fill engine will apply to this instrument (sandbox: per symbol, see fills.costSegmentFor). */
function costModelOf(f, kind, sym) {
  return f.costModel || defaultCostModel(costSegmentFor(f.portfolio?.segment ?? null, kind === 'option' ? null : sym));
}

/**
 * Price/qty/cost estimate for a buy intent AS OF the clock: ask + slippage for market orders, the limit for limit
 * orders, max(stop, ask) + slippage for stops. It is NOT a worst case: a market or stop order fills on the next
 * minute's worst ask, which can be higher. What bounds the real spend is the order's spend cap, enforced at fill
 * time by the order engine (orders meta.maxSpendU; `spendCapU` here is the cap the caller should pass).
 */
function estimateBuy(it, f, rules) {
  const cm = costModelOf(f, it.instrument.kind, it.instrument.sym);
  const bps = cm.slippageBps ?? 0;
  const mult = it.instrument.kind === 'option' ? OPTIONS_MULTIPLIER : 1;
  // A modify is priced as the order it changes: the target's real type with the effective terms (new value, else the
  // target's), never the order_type the intent declares (target_order_matches also denies a type mismatch).
  const t = it.action === 'modify' ? f.targetOrder : null;
  const type = t?.type ?? it.order_type;
  const limitPx = it.limit_px_u ?? t?.limit_px ?? undefined;
  const stopPx = it.stop_px_u ?? t?.stop_px ?? undefined;
  let priceU = null;
  let basis;
  if (it.instrument.kind === 'option') {
    const q = f.optionsQuote;
    if (q && q.ask > 0) { priceU = type === 'limit' ? limitPx : Math.ceil(Math.ceil(q.ask * (1 + bps / 10000)) / 100) * 100; basis = 'VERIFIED_OPTIONS_ASK_PLUS_SLIPPAGE'; }
  } else {
    const q = f.quote;
    const ask = q && q.twoSided ? q.ask : null;
    switch (type) {
      case 'market': if (ask) { priceU = slippedPrice(ask, 'buy', bps); basis = 'IEX_ASK_PLUS_SLIPPAGE'; } break;
      case 'limit': case 'stop_limit': priceU = limitPx; basis = 'LIMIT_PRICE (max payable)'; break;
      case 'stop': if (Number.isFinite(stopPx)) { priceU = slippedPrice(Math.max(stopPx, ask ?? 0), 'buy', bps); basis = 'MAX(STOP, IEX_ASK)_PLUS_SLIPPAGE'; } break;
      default: break;
    }
  }
  if (!priceU) return null;
  const commission = computeFees('buy', 1, priceU, cm, { multiplier: mult }).commissionU;
  const caps = [];
  if (it.budget_usd !== undefined) caps.push(usdToU(it.budget_usd));
  if (Number.isFinite(rules?.max_trade_spend_usd?.value)) caps.push(usdToU(rules.max_trade_spend_usd.value));
  const spendCapU = caps.length ? Math.min(...caps) : null;
  let qty = it.qty;
  // A modify that leaves qty unchanged keeps the target's remaining qty.
  if (qty === undefined && it.action === 'modify' && f.targetOrder) qty = Math.max(0, f.targetOrder.qty - (f.targetOrder.filled_qty ?? 0));
  let sizedFromBudget = false;
  if (qty === undefined) {
    if (spendCapU === null) return null;
    qty = Math.floor((spendCapU - commission) / (priceU * mult));
    sizedFromBudget = true;
  }
  const fees = computeFees('buy', Math.max(qty, 0), priceU, cm, { multiplier: mult, kind: it.instrument.kind });
  return {
    priceU, qty, multiplier: mult, feesU: fees.totalU, costU: Math.max(qty, 0) * priceU * mult + fees.totalU, basis, sizedFromBudget, slippageBps: bps,
    segment: cm.segment ?? null, spendCapU, asOfEstimateOnly: true,
  };
}

/**
 * Conservative cash one open buy order can still spend: remaining x price x multiplier + fees. Price = the limit (the
 * most a limit / stop-limit buy pays); otherwise the LARGER of max(stop, as-of IEX ask) + slippage (the intent's quote or
 * gctx.openOrderQuotes for other symbols; slippage = the larger of the gate and the order's own segment model) and the
 * estimate recorded on the order (meta.gate_estimate / meta.submitEstimate, floored at the stop). Never more than the
 * order's spend cap (meta.maxSpendU: the fill engine keeps total spend incl. commission within it). With no price the
 * whole spend cap is reserved; with neither, the reservation is unknown (amountU null) — never $0.
 * @returns {{amountU:number|null, basis:string}}
 */
function openBuyReservation(f, o) {
  const rem = o.qty - (o.filled_qty ?? 0);
  if (!Number.isFinite(rem)) return { amountU: null, basis: 'REMAINING_QTY_UNKNOWN' };
  if (rem <= 0) return { amountU: 0, basis: 'NOTHING_REMAINING' };
  const kind = o.kind ?? 'equity';
  const mult = kind === 'option' ? OPTIONS_MULTIPLIER : 1;
  let px = null;
  let basis = null;
  if (Number.isSafeInteger(o.limit_px) && o.limit_px > 0) {
    px = o.limit_px;
    basis = 'LIMIT_PRICE';
  } else {
    const candidates = [];
    if (kind !== 'option') {
      const q = f.quote && f.quote.sym === o.sym ? f.quote : (f.openOrderQuotes?.[o.sym] ?? null);
      if (q && q.twoSided && q.ask > 0) {
        const bps = Math.max(f.costModel?.slippageBps ?? 0, defaultCostModel(costSegmentFor(f.portfolio?.segment ?? null, o.sym)).slippageBps ?? 0);
        candidates.push([slippedPrice(Math.max(o.stop_px ?? 0, q.ask), 'buy', bps), 'MAX(STOP, AS_OF_IEX_ASK)_PLUS_SLIPPAGE']);
      }
    }
    for (const k of ['gate_estimate', 'submitEstimate']) {
      const e = o.meta?.[k];
      if (Number.isSafeInteger(e?.priceU) && e.priceU > 0) candidates.push([Math.max(e.priceU, o.stop_px ?? 0), `meta.${k}`]);
    }
    for (const [p, b] of candidates) if (px === null || p > px) { px = p; basis = b; }
  }
  const cap = Number.isSafeInteger(o.meta?.maxSpendU) && o.meta.maxSpendU > 0 ? o.meta.maxSpendU : null;
  if (px === null) return cap !== null ? { amountU: cap, basis: 'SPEND_CAP (no price estimate)' } : { amountU: null, basis: 'RESERVATION_UNKNOWN' };
  const cm = costModelOf(f, kind, o.sym);
  const feesU = computeFees('buy', rem, px, cm, { multiplier: mult, firstFill: (o.filled_qty ?? 0) === 0, kind }).totalU;
  const amountU = rem * px * mult + feesU;
  if (!Number.isFinite(amountU)) return { amountU: null, basis: 'RESERVATION_UNKNOWN' };
  return cap !== null && cap < amountU ? { amountU: cap, basis: `${basis} (capped at the spend cap)` } : { amountU, basis };
}

/**
 * Reservation for the open buys of the portfolio (optionally only one symbol + kind), excluding `excludeId` (the order a
 * modify replaces). `unknown` lists orders whose reservation cannot be priced.
 */
function reserveOpenBuys(f, { excludeId = null, sym = null, kind = null } = {}) {
  let totalU = 0;
  let orders = 0;
  const unknown = [];
  for (const o of f.openOrders || []) {
    if (o.side !== 'buy' || (excludeId !== null && o.id === excludeId)) continue;
    if (sym !== null && (o.sym !== sym || (o.kind ?? 'equity') !== kind)) continue;
    const r = openBuyReservation(f, o);
    if (r.amountU === null) { unknown.push(o.id); continue; }
    if (r.amountU > 0) { totalU += r.amountU; orders++; }
  }
  return { totalU, orders, unknown };
}

/** Knowable time of each resolvable evidence ref, as a Map. */
function evidenceMap(f) {
  if (!f.evidenceIndex) return new Map();
  return f.evidenceIndex instanceof Map ? f.evidenceIndex : new Map(Object.entries(f.evidenceIndex));
}

// ---- rules: (cfg, intent, facts, state) -> {pass, code?, detail} ----------------------------------------

const RULES = {
  paper_only(cfg) {
    if (cfg.value !== true || PAPER_ONLY !== true) return fail('PAPER_ONLY_VIOLATION', 'paper_only must be true; no live-broker path exists');
    return ok('paper-only constant; estimated fills only');
  },

  kill_switch(cfg, it, f) {
    if (!f.kill || typeof f.kill.engaged !== 'boolean') return fail('KILL_STATE_UNKNOWN', 'kill-switch state not supplied');
    if (!f.kill.engaged) return ok('kill switch released');
    if (isHumanCancel(it) && cfg.humanCancelAllowed === true) return ok('kill switch ENGAGED; human cancel permitted');
    return fail('KILL_SWITCH_ENGAGED', `kill switch engaged${f.kill.by ? ' by ' + f.kill.by : ''}; only human cancels are permitted`);
  },

  agent_authority(cfg, it, f) {
    if (it.source === 'human') return na('human intent (human_confirmed applies)');
    if (cfg.allowAgents !== true) return fail('AGENT_NOT_PERMITTED_ON_PORTFOLIO', `agents may not act on portfolio ${it.portfolio_id}`);
    const a = f.agent;
    if (!a) return fail('AGENT_UNKNOWN', `agent ${it.agent_id} not found`);
    if (a.id !== it.agent_id) return fail('AGENT_MISMATCH', 'intent agent_id does not match the acting agent');
    if (a.portfolio_id !== it.portfolio_id) return fail('AGENT_PORTFOLIO_MISMATCH', `agent ${a.id} is assigned to ${a.portfolio_id}, not ${it.portfolio_id}`);
    if (a.state !== (cfg.requireState ?? 'RUNNING')) return fail('AGENT_NOT_RUNNING', `agent state is ${a.state}; authority requires ${cfg.requireState ?? 'RUNNING'}`);
    if (cfg.requireGrant !== false) {
      const g = a.grants;
      if (!g || !Array.isArray(g.portfolios) || !Array.isArray(g.actions)) return fail('AGENT_GRANT_MISSING', 'agent has no grant {portfolios[], actions[]}');
      if (!g.portfolios.includes(it.portfolio_id)) return fail('AGENT_GRANT_MISSING', `no grant for portfolio ${it.portfolio_id}`);
      if (!g.actions.includes(it.action)) return fail('AGENT_GRANT_MISSING', `no grant for action ${it.action}`);
      const instruments = Array.isArray(g.instruments) ? g.instruments : ['equity'];
      if (!instruments.includes(it.instrument.kind)) return fail('AGENT_GRANT_MISSING', `no grant for instrument ${it.instrument.kind}`);
    }
    return ok(`agent ${a.id} RUNNING with grant for ${it.portfolio_id}/${it.action}`);
  },

  human_confirmed(cfg, it, f) {
    if (it.source !== 'human') return na('agent intent (agent_authority applies)');
    if (cfg.requireConfirm !== false && f.confirm !== true) return fail('HUMAN_NOT_CONFIRMED', 'human orders require explicit confirm:true');
    if (it.action !== 'cancel' && (cfg.humanTradingAllowed !== true || f.portfolio?.kind !== 'sandbox')) {
      return fail('HUMAN_TRADING_SANDBOX_ONLY', 'humans place orders only in the manual sandbox (cancels allowed anywhere)');
    }
    return ok('human confirmed');
  },

  target_order_matches(cfg, it, f) {
    if (cfg.value !== true) throw new TypeError('target_order_matches.value must be true');
    if (it.action !== 'modify' && it.action !== 'cancel') return na('not a modify/cancel');
    const t = f.targetOrder;
    if (!t) return fail('TARGET_ORDER_MISMATCH', `target order ${it.target_order_id} not found in this replay session and portfolio`);
    const diff = [];
    if (t.id !== it.target_order_id) diff.push(`id ${t.id}`);
    if (!(f.session_id != null && t.session_id === f.session_id)) diff.push(`session ${t.session_id ?? 'unknown'} (replay session ${f.session_id ?? 'unknown'})`);
    if (t.portfolio_id !== it.portfolio_id) diff.push(`portfolio ${t.portfolio_id}`);
    if (t.sym !== it.instrument.sym) diff.push(`sym ${t.sym} != ${it.instrument.sym}`);
    if ((t.kind ?? 'equity') !== it.instrument.kind) diff.push(`kind ${t.kind ?? 'equity'} != ${it.instrument.kind}`);
    if (t.side !== it.side) diff.push(`side ${t.side} != ${it.side}`);
    // A modify is priced and applied as the target's real order type, so a different declared type is refused (a cancel's
    // declared type is not used for anything and is not compared).
    if (it.action === 'modify' && t.type !== it.order_type) diff.push(`order type ${t.type} != ${it.order_type}`);
    if (it.source !== 'human' && t.agent_id !== it.agent_id) diff.push(`order belongs to ${t.agent_id ? `agent ${t.agent_id}` : 'a human'}, not ${it.agent_id}`);
    if (diff.length) return fail('TARGET_ORDER_MISMATCH', `target order ${it.target_order_id}: ${diff.join('; ')}`);
    return ok(`target ${t.id} (${t.status}) matches session, portfolio, ${t.sym} ${t.kind ?? 'equity'} ${t.side}${it.action === 'modify' ? ` ${t.type}` : ''}`);
  },

  instrument_allowed(cfg, it, f) {
    if (it.instrument.kind === 'equity') return cfg.equity === true ? ok('equity allowed') : fail('INSTRUMENT_NOT_ALLOWED', 'equity disabled by policy');
    if (cfg.option !== 'ONLY_IF_VERIFIED_OPTIONS_DATA') return fail('INSTRUMENT_NOT_ALLOWED', 'options disabled by policy');
    if (f.optionsVerified !== true) return fail(OPTIONS_STATUS, 'no verified options provider returned this contract and an as-of quote');
    return ok('long put with verified options quote');
  },

  symbol_allowed(cfg, it, f) {
    const sym = it.instrument.sym;
    if (cfg.blockTestSymbols !== false && KNOWN_TEST_SYMBOLS.has(sym)) return fail('SYMBOL_IS_TEST_ISSUE', `${sym} is an exchange test symbol`);
    const increase = isBuyIncrease(it, f);
    if (!isEntry(it) && !increase) return ok('exit / non-increasing modify / cancel: universe filters not applied (never trap a position)');
    if (!Array.isArray(cfg.deny) || !Array.isArray(cfg.allow)) throw new TypeError('symbol_allowed.allow/deny must be arrays');
    const denyTypes = cfg.denyIssueTypes === undefined ? DEFAULT_DENY_ISSUE_TYPES : cfg.denyIssueTypes;
    if (!Array.isArray(denyTypes)) throw new TypeError('symbol_allowed.denyIssueTypes must be an array');
    if (cfg.deny.includes(sym)) return fail('SYMBOL_DENIED', `${sym} is on the deny list`);
    if (cfg.allow.length && !cfg.allow.includes(sym)) return fail('SYMBOL_NOT_ALLOWED', `${sym} is not on the allow list`);
    const issue = issueTypeFromSymbol(sym);
    if (issue && denyTypes.includes(issue.type)) {
      return fail('SYMBOL_ISSUE_TYPE_DENIED', `${sym} is a ${issue.type} by its symbol pattern (${issue.basis}); entries in ${denyTypes.join(' / ')} are denied by policy`);
    }
    if (cfg.requireSegmentUniverse) {
      if (!f.universe) return fail('UNIVERSE_UNAVAILABLE', 'segment universe as-of clock not available');
      const has = f.universe instanceof Set ? f.universe.has(sym) : Array.isArray(f.universe) && f.universe.includes(sym);
      if (!has) return fail('SYMBOL_NOT_IN_SEGMENT', `${sym} is not in the ${f.portfolio?.segment} universe as-of the replay clock`);
    }
    return ok(`${sym} allowed${increase ? ' (risk-increasing buy modify: entry filters applied)' : ''}`);
  },

  max_trade_spend_usd(cfg, it, f, st) {
    if (!Number.isFinite(cfg.value) || cfg.value <= 0) throw new TypeError('max_trade_spend_usd.value must be a positive number');
    if (it.side !== 'buy' || it.action === 'cancel') return na('not a buy');
    if (!st.estimate) return fail('NO_PRICE_ESTIMATE', 'cannot estimate cost (no two-sided quote / price)');
    const e = st.estimate;
    if (!(e.qty >= 1)) return fail('BUDGET_EXCEEDED', `budget cannot buy one whole ${it.instrument.kind === 'option' ? 'contract' : 'share'} at ${fmt$(e.priceU)}`);
    const capU = usdToU(cfg.value);
    if (!(e.costU <= capU)) return fail('BUDGET_EXCEEDED', `estimated cost ${fmt$(e.costU)} exceeds max trade spend ${fmt$(capU)}`);
    if (it.budget_usd !== undefined && !(e.costU <= usdToU(it.budget_usd))) return fail('BUDGET_EXCEEDED', `estimated cost ${fmt$(e.costU)} exceeds intent budget $${it.budget_usd}`);
    return ok(`estimated cost ${fmt$(e.costU)} (${e.qty} x ${fmt$(e.priceU)} + fees ${fmt$(e.feesU)}) <= ${fmt$(capU)}`);
  },

  cash_sufficient(cfg, it, f, st) {
    if (cfg.reserveOpenBuyOrders !== undefined && cfg.reserveOpenBuyOrders !== true) throw new TypeError('cash_sufficient.reserveOpenBuyOrders cannot be disabled');
    if (it.side !== 'buy' || it.action === 'cancel') return na('not a buy');
    if (!st.estimate) return fail('NO_PRICE_ESTIMATE', 'cannot estimate cost');
    if (!Number.isFinite(f.portfolio?.cashU)) return fail('CASH_UNKNOWN', 'portfolio cash not supplied');
    const r = reserveOpenBuys(f, { excludeId: it.target_order_id ?? null });
    if (r.unknown.length) {
      return fail('RESERVATION_UNKNOWN', `cannot price the cash committed to open buy order(s) ${r.unknown.slice(0, 5).join(', ')} `
        + '(no limit, no as-of quote, no recorded estimate, no spend cap); denied rather than reserving $0');
    }
    const avail = f.portfolio.cashU - r.totalU;
    const tail = `(cash ${fmt$(f.portfolio.cashU)} - reserved ${fmt$(r.totalU)} for ${r.orders} open buy order(s), fees included)`;
    if (!(st.estimate.costU <= avail)) return fail('INSUFFICIENT_CASH', `estimated cost ${fmt$(st.estimate.costU)} exceeds available cash ${fmt$(avail)} ${tail}`);
    return ok(`available cash ${fmt$(avail)} covers ${fmt$(st.estimate.costU)} ${tail}`);
  },

  no_short(cfg, it, f) {
    if (cfg.value !== true) throw new TypeError('no_short.value must be true');
    if (it.side !== 'sell' || it.action === 'cancel') return na('not a sell');
    // A pending bracket child sells nothing until its entry fills, and the engine sizes it to the shares the bracket
    // holds at activation (server/sim/orders.js), so editing its price or qty cannot create a short.
    const t = f.targetOrder;
    if (it.action === 'modify' && t && t.status === 'pending_parent' && t.side === 'sell' && t.portfolio_id === it.portfolio_id) {
      return na('pending bracket child: sized to the shares held when its entry fills');
    }
    const held = heldQty(it, f);
    const qty = it.qty ?? held;
    if (!(held > 0)) return fail('SHORT_SALE_NOT_ALLOWED', `no ${it.instrument.sym} held; shorting is not permitted`);
    if (!(qty <= held)) return fail('SHORT_SALE_NOT_ALLOWED', `sell qty ${qty} exceeds held ${held}`);
    return ok(`sell ${qty} <= held ${held}`);
  },

  daily_loss_cap_usd(cfg, it, f) {
    if (!Number.isFinite(cfg.value) || cfg.value <= 0) throw new TypeError('daily_loss_cap_usd.value must be a positive number');
    if (!addsExposure(it, f)) return na('only blocks new entries and risk-increasing buy modifies');
    const p = f.portfolio;
    if (!Number.isFinite(p?.equityU) || !Number.isFinite(p?.dayStartEquityU)) return fail('EQUITY_UNKNOWN', 'day-start or current equity unknown');
    const lossU = p.dayStartEquityU - p.equityU;
    const capU = usdToU(cfg.value);
    if (lossU >= capU) return fail('DAILY_LOSS_CAP_REACHED', `day loss ${fmt$(lossU)} >= cap ${fmt$(capU)}`);
    return ok(`day P&L ${fmt$(-lossU)}; cap ${fmt$(capU)}`);
  },

  max_open_positions(cfg, it, f) {
    if (!Number.isSafeInteger(cfg.value) || cfg.value < 0) throw new TypeError('max_open_positions.value must be an integer');
    if (!isEntry(it)) return na('not an entry');
    const syms = new Set((f.positions || []).filter((p) => p.qty > 0).map((p) => p.sym));
    for (const o of f.openOrders || []) if (o.side === 'buy' && o.role === 'entry') syms.add(o.sym);
    if (syms.has(it.instrument.sym)) return ok(`adds to existing ${it.instrument.sym} exposure (${syms.size}/${cfg.value})`);
    if (syms.size + 1 > cfg.value) return fail('MAX_OPEN_POSITIONS', `${syms.size} open/pending positions; max ${cfg.value}`);
    return ok(`${syms.size + 1}/${cfg.value} positions after entry`);
  },

  max_position_pct_equity(cfg, it, f, st) {
    if (!Number.isFinite(cfg.value) || cfg.value <= 0) throw new TypeError('max_position_pct_equity.value must be a positive number');
    if (!addsExposure(it, f)) return na('not an entry or a risk-increasing buy modify');
    if (!st.estimate) return fail('NO_PRICE_ESTIMATE', 'cannot estimate cost');
    const eq = f.portfolio?.equityU;
    if (!Number.isFinite(eq) || eq <= 0) return fail('EQUITY_UNKNOWN', 'current equity unknown');
    const { sym, kind } = it.instrument;
    const held = (f.positions || []).filter((p) => p.sym === sym && p.kind === kind)
      .reduce((s, p) => s + (p.valueU ?? p.costBasisU ?? 0), 0);
    const pending = reserveOpenBuys(f, { excludeId: it.target_order_id ?? null, sym, kind });
    if (pending.unknown.length) return fail('RESERVATION_UNKNOWN', `cannot price pending ${sym} buy order(s) ${pending.unknown.slice(0, 5).join(', ')}; denied rather than counting them as $0`);
    const pct = ((held + pending.totalU + st.estimate.costU) / eq) * 100;
    const parts = `held ${fmt$(held)} + pending buys ${fmt$(pending.totalU)} (${pending.orders} order(s)) + this ${fmt$(st.estimate.costU)}`;
    if (!(pct <= cfg.value)) return fail('MAX_POSITION_PCT_EQUITY', `position would be ${pct.toFixed(2)}% of equity (${parts}); max ${cfg.value}%`);
    return ok(`position ${pct.toFixed(2)}% of equity (${parts}) <= ${cfg.value}%`);
  },

  protective_exit_required(cfg, it, f) {
    if (cfg.value !== true) throw new TypeError('protective_exit_required.value must be true');
    const documentedIds = cfg.informationalStrategyIds ?? [];
    if (!Array.isArray(documentedIds)) throw new TypeError('protective_exit_required.informationalStrategyIds must be an array');
    if (it.source === 'human') return na('human intent (sandbox brackets are optional)');
    if (!isEntry(it)) return na('not an entry');
    if (it.instrument.kind === 'option') return na('long put: the maximum loss is the premium paid (max_trade_spend_usd); brackets are not supported for options');
    const sl = it.attach?.stop_loss_px_u;
    if (sl === undefined) return fail('PROTECTIVE_EXIT_MISSING', 'agent entries must attach a protective stop (attach.stop_loss_px_u)');
    if (!isValidTick(sl)) return fail('PROTECTIVE_EXIT_MISSING', `attach.stop_loss_px_u=${sl} u is not a valid Reg NMS 612 tick`);
    const q = f.quote;
    if (!q || !q.twoSided || !(q.bid > 0)) return fail('QUOTE_NOT_TWO_SIDED', 'no two-sided as-of IEX quote: the protective stop cannot be checked against the bid');
    const s = f.agent?.strategy;
    const documented = documentedIds.includes(it.strategy_id) && !!s && s.id === it.strategy_id && s.stopLossBasis === 'at_entry_ref'
      && Array.isArray(s.ambiguityIds) && s.ambiguityIds.includes('stop-at-entry');
    // A limit / stop-limit entry pays at most its limit: a stop at/above it is already marketable when the bracket
    // activates (the documented at-entry stop may sit AT the entry price, not above it).
    if (it.limit_px_u !== undefined && (documented ? sl > it.limit_px_u : sl >= it.limit_px_u)) {
      return fail('STOP_AT_OR_ABOVE_ENTRY_LIMIT', `stop ${fmt$(sl)} is at/above the entry limit ${fmt$(it.limit_px_u)}: if the limit fills, the stop is already marketable at activation`);
    }
    const vsBidBps = Math.round(((sl - q.bid) / q.bid) * 10_000);
    if (sl < q.bid) return ok(`stop ${fmt$(sl)} < as-of IEX bid ${fmt$(q.bid)} (${-vsBidBps} bps below)${it.limit_px_u !== undefined ? ` and < entry limit ${fmt$(it.limit_px_u)}` : ''}`);
    if (documented) {
      return {
        pass: true, informational: true, stopVsBidBps: vsBidBps,
        detail: `INFORMATIONAL (docs/OPEN_QUESTIONS.md #4, ambiguity stop-at-entry): stop ${fmt$(sl)} is at/above the as-of IEX bid ${fmt$(q.bid)} `
          + `(${vsBidBps} bps above) and is expected to trigger on its first evaluated minute (spread-induced loss); not denied because `
          + `${it.strategy_id} is the documented handwritten-notes example`,
      };
    }
    return fail('STOP_AT_OR_ABOVE_BID', `stop ${fmt$(sl)} is at/above the as-of IEX bid ${fmt$(q.bid)} (${vsBidBps} bps above): it would trigger on its first evaluated minute`);
  },

  order_rate_per_min(cfg, it, f) {
    if (!Number.isSafeInteger(cfg.value) || cfg.value < 0) throw new TypeError('order_rate_per_min.value must be an integer');
    if (isHumanCancel(it)) return na('human cancel');
    if (!isRiskIncreasing(it)) return na('risk-reducing intent (exits and cancels are never rate-limited)');
    if (!Number.isSafeInteger(f.recentOrderCount)) return fail('ORDER_RATE_UNKNOWN', 'recent order count not supplied');
    if (f.recentOrderCount + 1 > cfg.value) return fail('ORDER_RATE_EXCEEDED', `${f.recentOrderCount} orders in the last minute; max ${cfg.value}/min`);
    return ok(`${f.recentOrderCount + 1}/${cfg.value} orders this minute`);
  },

  market_hours(cfg, it, f) {
    if (it.action === 'cancel') return na('cancels are allowed at any time');
    if (cfg.regularSessionOnly !== true) throw new TypeError('market_hours.regularSessionOnly must be true (extended hours not supported)');
    const c = f.clock;
    const inSession = isRegularSession(c) && (!f.session || (c >= f.session.open && c < f.session.close));
    if (!inSession) {
      if (f.session?.truncated && c >= f.session.close && isRegularSession(c)) {
        return fail('MARKET_CLOSED', "the replay has ended at the PARTIAL dataset's coverage end (before the 16:00 ET close); no later minute can be evaluated");
      }
      return fail('MARKET_CLOSED', 'outside the regular session (09:30-16:00 ET)');
    }
    return ok(f.session?.truncated ? 'regular session, before the replay end (PARTIAL dataset coverage end)' : 'regular session');
  },

  quote_fresh(cfg, it, f) {
    if (it.action === 'cancel') return na('cancel');
    if (!Number.isFinite(cfg.maxQuoteAgeMs)) throw new TypeError('quote_fresh.maxQuoteAgeMs must be a number');
    if (it.instrument.kind === 'option') {
      const q = f.optionsQuote;
      if (!q || f.optionsVerified !== true) return fail(OPTIONS_STATUS, 'no verified options quote');
      const age = f.clock - q.quoteTs;
      if (!(age <= cfg.maxQuoteAgeMs)) return fail('QUOTE_STALE', `options quote age ${Math.round(age / 1000)}s > ${cfg.maxQuoteAgeMs / 1000}s`);
      return ok(`options quote age ${Math.round(age / 1000)}s`);
    }
    const q = f.quote;
    if (!q) return fail('NO_VERIFIED_DATA', 'no IEX quote observed as-of the replay clock');
    if (cfg.rejectHalted !== false && q.halted) return fail('HALTED', `${q.sym} halted/paused (status ${q.tradingStatus})`);
    if (cfg.requireTwoSided !== false && !q.twoSided) return fail('QUOTE_NOT_TWO_SIDED', 'IEX quote is not two-sided');
    if (!(q.quoteTs <= f.clock)) return fail('QUOTE_FROM_FUTURE', 'quote timestamp is after the replay clock');
    if (!(q.ageMs <= cfg.maxQuoteAgeMs)) return fail('QUOTE_STALE', `quote age ${Math.round(q.ageMs / 1000)}s > max ${cfg.maxQuoteAgeMs / 1000}s`);
    return ok(`quote age ${Math.round(q.ageMs / 1000)}s <= ${cfg.maxQuoteAgeMs / 1000}s`);
  },

  max_spread_bps(cfg, it, f) {
    if (!Number.isFinite(cfg.value) || cfg.value <= 0) throw new TypeError('max_spread_bps.value must be a positive number');
    if (!isRiskIncreasing(it)) return na('risk-reducing intent (exits are not trapped by spread filters)');
    let spread;
    if (it.instrument.kind === 'option') {
      const q = f.optionsQuote;
      if (!q || !(q.bid > 0) || !(q.ask > 0)) return fail(OPTIONS_STATUS, 'no verified options quote');
      spread = Math.round(((q.ask - q.bid) / ((q.ask + q.bid) / 2)) * 10000);
    } else {
      if (!f.quote || !f.quote.twoSided || f.quote.spreadBps == null) return fail('QUOTE_NOT_TWO_SIDED', 'no two-sided quote to measure spread');
      spread = f.quote.spreadBps;
    }
    if (!(spread <= cfg.value)) return fail('SPREAD_TOO_WIDE', `spread ${spread} bps > max ${cfg.value} bps`);
    return ok(`spread ${spread} bps <= ${cfg.value} bps`);
  },

  min_displayed_size(cfg, it, f) {
    if (!Number.isFinite(cfg.value) || cfg.value < 0) throw new TypeError('min_displayed_size.value must be a number');
    if (!isRiskIncreasing(it)) return na('risk-reducing intent');
    const size = it.instrument.kind === 'option' ? f.optionsQuote?.askSize : f.quote?.askSize;
    if (!Number.isFinite(size)) return fail('NO_DISPLAYED_SIZE', 'displayed ask size unknown');
    if (!(size >= cfg.value)) return fail('DISPLAYED_SIZE_TOO_SMALL', `displayed ask size ${size} < ${cfg.value}`);
    return ok(`displayed ask size ${size} >= ${cfg.value}`);
  },

  intent_not_expired(cfg, it, f) {
    if (cfg.value !== true) throw new TypeError('intent_not_expired.value must be true');
    if (!(it.expires_ts > f.clock)) return fail('INTENT_EXPIRED', `intent expired at ${it.expires_ts} (clock ${f.clock})`);
    return ok(`expires in ${Math.round((it.expires_ts - f.clock) / 1000)}s`);
  },

  evidence_not_future(cfg, it, f) {
    if (cfg.value !== true) throw new TypeError('evidence_not_future.value must be true');
    for (const k of ['quote_ts', 'created_ts']) {
      if (!(it[k] <= f.clock)) return fail('EVIDENCE_FROM_FUTURE', `${k} ${it[k]} is after the replay clock ${f.clock}`);
    }
    const idx = evidenceMap(f);
    const callerOnly = f.callerOnlyEvidence instanceof Map ? f.callerOnlyEvidence : new Map();
    let resolved = 0;
    const unresolved = [];
    for (const ref of it.evidence_refs) {
      if (!idx.has(ref)) {
        // A ref only the caller could resolve is never counted as resolved, but a caller-known future time still denies.
        const k = callerOnly.get(ref);
        if (Number.isFinite(k) && !(k <= f.clock)) return fail('EVIDENCE_FROM_FUTURE', `evidence ${ref} knowable at ${k} > clock ${f.clock} (caller index)`);
        unresolved.push(ref);
        continue;
      }
      resolved++;
      if (!(idx.get(ref) <= f.clock)) return fail('EVIDENCE_FROM_FUTURE', `evidence ${ref} knowable at ${idx.get(ref)} > clock ${f.clock}`);
    }
    // Agent (rules / model) intents must cite only evidence that resolves; a human may cite free-form refs or none.
    if (unresolved.length && it.source !== 'human') {
      return fail('EVIDENCE_UNRESOLVED', `${unresolved.length}/${it.evidence_refs.length} ${it.source} evidence ref(s) cannot be resolved to stored evidence `
        + `or a stored IEX minute knowable <= clock: ${unresolved.slice(0, 5).join(', ')}`);
    }
    return ok(`intent timestamps <= clock; ${resolved}/${it.evidence_refs.length} evidence refs resolved and knowable`
      + (unresolved.length ? ` (${unresolved.length} unresolved human ref(s) not used as evidence)` : ''));
  },

  tick_valid(cfg, it) {
    if (cfg.rule !== 'REG_NMS_612') throw new TypeError("tick_valid.rule must be 'REG_NMS_612'");
    const px = [['limit_px_u', it.limit_px_u], ['stop_px_u', it.stop_px_u], ['attach.stop_loss_px_u', it.attach?.stop_loss_px_u], ['attach.take_profit_px_u', it.attach?.take_profit_px_u]];
    for (const [k, v] of px) if (v !== undefined && !isValidTick(v)) return fail('TICK_INVALID', `${k}=${v} u is not a valid Reg NMS 612 tick`);
    return ok('all prices on valid ticks');
  },
};

/**
 * Evaluate an intent against the policy. Pure and deterministic.
 * @param {object} intent TradeIntent (validated here again)
 * @param {object} gctx facts: {clock, session_id, policy, portfolio:{id, kind, segment, cashU, equityU, dayStartEquityU}, positions[],
 *   openOrders[] (with meta), openOrderQuotes?:{[sym]: quote|null} (as-of quotes for open market/stop buys),
 *   agent:{id, portfolio_id, state, grants, strategy?:{id, stopLossBasis, ambiguityIds[]}|null}|null, kill:{engaged:boolean, by?},
 *   quote (quoteAsOf shape)|null, universe:Set|string[]|null, recentOrderCount:int, costModel, confirm?:boolean, session?:{open, close},
 *   optionsQuote?, optionsVerified?:boolean, evidenceIndex?:Map|object (ref -> knowable ms), callerOnlyEvidence?:Map (refs only a
 *   caller resolved: checked for EVIDENCE_FROM_FUTURE, never counted as resolved),
 *   targetOrder?:{id, portfolio_id, session_id, agent_id, sym, kind, side, type, role, status, qty, filled_qty, limit_px, stop_px, parent_id, meta}|null}
 * @returns {{decision:'ACCEPTED'|'DENIED', reasons:{code, detail}[], checks:{rule, pass, detail, code?, applicable?, evaluated?}[], estimate:object|null, policy:{id, label}|null}}
 */
export function evaluate(intent, gctx) {
  const checks = [];
  const reasons = [];
  let estimate = null;
  let policyRef = null;
  const notEvaluated = (why) => {
    for (const r of REQUIRED_RULES) if (!checks.some((c) => c.rule === r)) checks.push({ rule: r, pass: false, evaluated: false, detail: `NOT_EVALUATED: ${why}` });
  };
  try {
    const v = validateIntent(intent);
    checks.push({ rule: 'intent_valid', pass: v.ok, detail: v.ok ? 'strict schema ok' : v.errors.join('; ') });
    if (!v.ok) {
      reasons.push({ code: 'INTENT_INVALID', detail: v.errors.join('; ') });
      notEvaluated('intent invalid');
      return { decision: 'DENIED', reasons, checks, estimate: null, policy: null };
    }
    const it = v.intent;
    if (!gctx || typeof gctx !== 'object') throw new TypeError('gate context is required');
    if (!Number.isFinite(gctx.clock)) throw new TypeError('gctx.clock (replay clock) is required');
    const policy = gctx.policy;
    policyRef = policy ? { id: policy.id ?? null, label: policy.label ?? null } : null;
    const rules = policy && typeof policy === 'object' ? policy.rules : undefined;
    if (it.portfolio_id !== gctx.portfolio?.id) throw new Error('gate context portfolio does not match the intent portfolio');
    const state = { estimate: null };
    if (it.side === 'buy' && it.action !== 'cancel') state.estimate = estimateBuy(it, gctx, rules);
    estimate = state.estimate;
    for (const name of REQUIRED_RULES) {
      const cfg = rules ? rules[name] : undefined;
      if (cfg === undefined || cfg === null) {
        checks.push({ rule: name, pass: false, code: `RULE_MISSING:${name}`, detail: 'rule missing from policy config (deny-by-default)' });
        reasons.push({ code: `RULE_MISSING:${name}`, detail: 'rule missing from policy config (deny-by-default)' });
        continue;
      }
      const r = RULES[name](cfg, it, gctx, state);
      checks.push({ rule: name, ...r });
      if (!r.pass) reasons.push({ code: r.code, detail: r.detail });
    }
  } catch (e) {
    const detail = String(e && e.message ? e.message : e).slice(0, 300);
    reasons.push({ code: 'GATE_ERROR', detail });
    notEvaluated('gate error');
    return { decision: 'DENIED', reasons, checks, estimate, policy: policyRef };
  }
  return { decision: reasons.length === 0 ? 'ACCEPTED' : 'DENIED', reasons, checks, estimate, policy: policyRef };
}

/**
 * Same membership rule as marketdata.universeAsOf, for one symbol: micro = latest observed IEX trade (as-of)
 * below the penny tier and not a large-cap/benchmark; large = on the configured large-cap list with a trade as-of.
 */
export function symbolInSegmentAsOf(db, ds, sym, asOf, segment) {
  const lt = lastTradeAsOf(db, ds, sym, asOf);
  if (!lt) return false;
  const large = new Set(largeCapList());
  if (segment === 'large') return large.has(sym);
  const max = segment === 'low' ? PRICE_TIERS.low.maxPriceU : PRICE_TIERS.penny.maxPriceU;
  return lt.priceU < max && !large.has(sym) && !BENCHMARKS.includes(sym);
}

/** Kill-switch state from the controls table (absent row = never engaged). */
export function readKillState(db) {
  for (const k of KILL_CONTROL_KEYS) {
    const r = db.prepare('SELECT v FROM controls WHERE k = ?').get(k);
    if (r) {
      const v = JSON.parse(r.v);
      return { engaged: v.engaged === true, at: v.at ?? null, by: v.by ?? null, protective_policy: v.protective_policy ?? null, source: k };
    }
  }
  return { engaged: false, at: null, by: null, protective_policy: null, source: 'default (no control row)' };
}

const M1_REF_RE = /^iex-m1:([^:]{1,80}):([A-Z][A-Z0-9.\-+^=#]{0,11}):(\d{1,15})$/;

/**
 * Resolve evidence refs to the time each became knowable (the gate's default resolver; callers may pass their own index):
 *   `iex-m1:<ds>:<SYM>:<t>` -> t + 60 s, only when that IEX minute row is stored (a minute is knowable once complete);
 *   an evidence-store id -> knowable_ts, or the source dataset's publication time when the row claims to be knowable
 *   before its dataset was published (the same provenance rule as intel/evidence.js as-of reads).
 * Refs that resolve to nothing are left out (evidence_not_future denies them for agent intents: EVIDENCE_UNRESOLVED).
 * @returns {Map<string, number>}
 */
export function resolveEvidenceRefs(db, refs) {
  const index = new Map();
  if (!Array.isArray(refs) || !refs.length) return index;
  const m1 = db.prepare('SELECT 1 AS ok FROM m1 WHERE ds = ? AND sym = ? AND t = ?');
  const ev = db.prepare('SELECT e.knowable_ts, d.kind, d.published_at FROM evidence e LEFT JOIN datasets d ON d.id = e.ds WHERE e.id = ?');
  for (const ref of refs.slice(0, 50)) {
    if (typeof ref !== 'string' || !ref || ref.length > 200 || index.has(ref)) continue;
    const m = M1_REF_RE.exec(ref);
    if (m) {
      const t = Number(m[3]);
      if (Number.isSafeInteger(t) && m1.get(m[1], m[2], t)) index.set(ref, t + MINUTE);
      continue;
    }
    const r = ev.get(ref);
    if (!r) continue;
    const k = Number(r.knowable_ts);
    const pub = r.published_at == null ? null : Number(r.published_at);
    const postDated = r.kind != null && r.kind !== 'market_ticks' && pub !== null && k < pub;
    index.set(ref, postDated ? pub : k);
  }
  return index;
}

/**
 * The gate's own resolution merged with a caller-supplied index (e.g. the API helper). Only refs the GATE resolved count
 * as resolved; a caller can only make them knowable LATER (the later time wins), never earlier than the gate's
 * provenance rule allows, and never resolve a ref the gate cannot (e.g. an `iex-m1` minute that is not stored). Refs
 * only the caller resolved are returned separately: evidence_not_future still denies them when their caller-known time
 * is after the clock, but counts them as unresolved (agent intents: EVIDENCE_UNRESOLVED).
 * @returns {{index:Map<string, number>, callerOnly:Map<string, number>}}
 */
function mergeEvidenceIndexes(own, given) {
  const index = new Map(own);
  const callerOnly = new Map();
  if (given == null) return { index, callerOnly };
  const entries = given instanceof Map ? given.entries() : Object.entries(given);
  for (const [ref, k] of entries) {
    const n = Number(k);
    if (index.has(ref)) index.set(ref, Number.isFinite(n) ? Math.max(index.get(ref), n) : index.get(ref));
    else callerOnly.set(ref, n);
  }
  return { index, callerOnly };
}

/** Compact view of an agent's stored strategy (the facts protective_exit_required needs), or null. */
function strategyFacts(json) {
  let s;
  try { s = JSON.parse(json); } catch { return null; }
  if (!s || typeof s !== 'object' || Array.isArray(s)) return null;
  return {
    id: typeof s.id === 'string' ? s.id : null,
    stopLossBasis: typeof s.exits?.stopLoss?.basis === 'string' ? s.exits.stopLoss.basis : null,
    ambiguityIds: Array.isArray(s.ambiguities) ? s.ambiguities.map((a) => a?.id).filter((x) => typeof x === 'string') : [],
  };
}

function parseMeta(json) {
  try { return json ? JSON.parse(json) : null; } catch { return null; }
}

/**
 * Collect gate facts from the database as-of the replay clock. Any override passed in opts wins, except evidenceIndex:
 * the refs are always resolved with resolveEvidenceRefs; a caller index can only delay refs the gate resolved (later
 * knowable time wins) and never resolves one the gate cannot (see mergeEvidenceIndexes).
 * @param {{session_id:string, ds:string|null, clock:number, intent:object, confirm?:boolean, policy?:object, costModel?:object,
 *          universe?:Set<string>|string[], kill?:object, optionsQuote?:object, evidenceIndex?:Map|object|null, quote?:object|null,
 *          targetOrder?:object|null}} o
 */
export function buildGateContext(db, o) {
  const { session_id, ds, clock, intent } = o;
  const pid = intent?.portfolio_id;
  const summary = pid ? portfolioSummary(db, ds, session_id, pid, clock) : null;
  const portfolio = summary ? { ...summary.portfolio, cashU: summary.cashU, equityU: summary.equityU, equityBasis: summary.equityBasis } : null;
  let agent = null;
  if (intent?.agent_id) {
    const a = db.prepare('SELECT * FROM agents WHERE id = ?').get(intent.agent_id);
    if (a) {
      let grants = null;
      try { grants = JSON.parse(a.grants_json); } catch { grants = null; }
      agent = { id: a.id, portfolio_id: a.portfolio_id, state: a.state, grants, strategy: strategyFacts(a.strategy_json) };
    }
  }
  const sym = intent?.instrument?.sym;
  const asOfOk = ds && Number.isFinite(clock);
  const quote = o.quote !== undefined ? o.quote : (asOfOk && sym ? quoteAsOf(db, ds, sym, clock) : null);
  let universe = o.universe ?? null;
  if (!universe && asOfOk && sym && portfolio?.segment) {
    universe = new Set(symbolInSegmentAsOf(db, ds, sym, clock, portfolio.segment) ? [sym] : []);
  }
  const recentOrderCount = pid ? db.prepare('SELECT COUNT(*) n FROM orders WHERE session_id = ? AND portfolio_id = ? AND created_ts > ? AND created_ts <= ?')
    .get(session_id, pid, clock - MINUTE, clock).n : null;
  // The order a modify/cancel targets (same session and portfolio only): target_order_matches, isBuyIncrease, no_short.
  let targetOrder = null;
  if (intent?.target_order_id && pid) {
    const r = db.prepare(`SELECT id, portfolio_id, session_id, agent_id, sym, kind, side, type, role, status, qty, filled_qty, limit_px, stop_px, parent_id, meta_json
      FROM orders WHERE id = ? AND session_id = ? AND portfolio_id = ?`).get(intent.target_order_id, session_id, pid);
    if (r) {
      const { meta_json: metaJson, ...rest } = r;
      targetOrder = { ...rest, meta: parseMeta(metaJson) };
    }
  }
  const openOrders = summary ? summary.openOrders : [];
  // As-of quotes for the open market / stop buys, so cash_sufficient can reserve what they may still pay.
  const openOrderQuotes = Object.create(null);
  if (asOfOk) {
    for (const ord of openOrders) {
      if (ord.side !== 'buy' || ord.kind === 'option' || ord.limit_px != null || ord.sym in openOrderQuotes) continue;
      openOrderQuotes[ord.sym] = ord.sym === sym && quote !== undefined ? quote : quoteAsOf(db, ds, ord.sym, clock);
    }
  }
  const evidence = mergeEvidenceIndexes(resolveEvidenceRefs(db, intent?.evidence_refs), o.evidenceIndex);
  let optionsVerified = false;
  if (o.optionsQuote && intent?.instrument?.kind === 'option') {
    optionsVerified = validateOptionsQuote(o.optionsQuote, { clock, occ: intent.instrument.contract?.occ }).ok;
  }
  return {
    clock,
    session_id: session_id ?? null,
    policy: o.policy !== undefined ? o.policy : defaultPolicyFor(pid),
    portfolio,
    positions: summary ? summary.positions : [],
    openOrders,
    openOrderQuotes,
    agent,
    kill: o.kill ?? readKillState(db),
    quote,
    universe,
    recentOrderCount: Number.isSafeInteger(recentOrderCount) ? recentOrderCount : null,
    // Same rule as the fill engine (orders.costModelFor): agent portfolios by segment, sandbox per symbol.
    costModel: o.costModel ?? defaultCostModel(costSegmentFor(portfolio?.segment ?? null, intent?.instrument?.kind === 'option' ? null : sym)),
    confirm: o.confirm === true,
    // The replay window: close = the replay end (a PARTIAL dataset's coverage end when before 16:00 ET; truncated:true).
    session: ds ? replayWindowOf(db, ds) : null,
    optionsQuote: o.optionsQuote ?? null,
    optionsVerified,
    evidenceIndex: evidence.index,
    callerOnlyEvidence: evidence.callerOnly,
    targetOrder: o.targetOrder !== undefined ? o.targetOrder : targetOrder,
  };
}

/** Journal a gate decision (POLICY_ACCEPT / POLICY_DENY) with the full check list. */
export function journalDecision(db, { session_id, ts_sim, intent, result, intent_id = null }) {
  return append(db, {
    session_id, ts_sim, portfolio_id: intent?.portfolio_id ?? null, agent_id: intent?.agent_id ?? null, actor: 'policy',
    type: result.decision === 'ACCEPTED' ? 'POLICY_ACCEPT' : 'POLICY_DENY', ref_id: intent_id ?? intent?.id ?? null,
    payload: { decision: result.decision, reasons: result.reasons, checks: result.checks, estimate: result.estimate, policy: result.policy, intent },
  });
}
