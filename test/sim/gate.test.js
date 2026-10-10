// TEST FIXTURE — NOT MARKET DATA. Policy gate tests (docs/CONTRACTS.md section 5): deterministic, deny-by-default.
//
// Pure tests build the gate context by hand (synthetic FIX* symbols, 2099 trade date). DB tests use temp databases with
// hand-written minute rows to check buildGateContext collects its facts as-of the replay clock.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluate, buildGateContext, journalDecision, readKillState, symbolInSegmentAsOf, issueTypeFromSymbol, resolveEvidenceRefs, PAPER_ONLY,
} from '../../server/policy/gate.js';
import { REQUIRED_RULES, DEFAULT_POLICIES, POLICY_VERSION, defaultPolicyFor } from '../../server/policy/config.js';
import { submitOrder, processMinute } from '../../server/sim/orders.js';
import { defaultCostModel } from '../../server/sim/fills.js';
import { validateIntent } from '../../server/agents/intents.js';
import { PRESETS } from '../../server/agents/strategies.js';
import { verifyChain } from '../../server/journal.js';
import { setupScenario, addMinute, addAgent, at, FIXTURE_DS, FIXTURE_LABEL, MINUTE, journalRows } from './helpers/fixture.js';

const CLOCK = at(10, 0);
const SYM = 'FIXG';
const SES = 'ses_fixture';

function quote(over = {}) {
  return { sym: SYM, bid: 4990, ask: 5000, bidSize: 1000, askSize: 1000, quoteTs: CLOCK - 30_000, ageMs: 30_000, twoSided: true, spreadBps: 20, halted: false, tradingStatus: 'T', ...over };
}

/** Human sandbox market buy of 100 FIXG (TEST FIXTURE intent). */
function humanIntent(over = {}) {
  return {
    id: 'int_fixture_human', source: 'human', agent_id: null, portfolio_id: 'sandbox', strategy_id: null, action: 'open',
    instrument: { kind: 'equity', sym: SYM }, side: 'buy', qty: 100, order_type: 'market', rationale: FIXTURE_LABEL,
    evidence_refs: [], quote_ts: CLOCK - 30_000, created_ts: CLOCK, expires_ts: CLOCK + MINUTE, ...over,
  };
}

/** Agent (rules) intent; an entry carries a protective stop below the fixture bid (4990 u) unless `attach` is given. */
function agentIntent(over = {}) {
  const it = humanIntent({ id: 'int_fixture_agent', source: 'rules', agent_id: 'agent-fixture', portfolio_id: 'pragmatist-micro', strategy_id: 'fixture-strategy', qty: 50, ...over });
  if (it.action === 'open' && !('attach' in over)) it.attach = { stop_loss_px_u: 4500 };
  return it;
}

const CASH = { cashU: 100_000_000, equityU: 100_000_000, dayStartEquityU: 100_000_000 };

function gctx(over = {}) {
  return {
    clock: CLOCK, session_id: SES, policy: defaultPolicyFor('sandbox'), portfolio: { id: 'sandbox', kind: 'sandbox', segment: null, ...CASH },
    positions: [], openOrders: [], agent: null, kill: { engaged: false }, quote: quote(), universe: null, recentOrderCount: 0,
    confirm: true, session: { open: at(9, 30), close: at(16, 0) }, optionsQuote: null, optionsVerified: false, evidenceIndex: null, ...over,
  };
}

/** TEST FIXTURE order row as buildGateContext loads it (target of a modify/cancel). */
function order(over = {}) {
  return {
    id: 'ord_fixture', portfolio_id: 'sandbox', session_id: SES, agent_id: null, sym: SYM, kind: 'equity', side: 'buy', type: 'limit', role: 'entry',
    status: 'working', qty: 100, filled_qty: 0, limit_px: 4800, stop_px: null, parent_id: null, meta: null, ...over,
  };
}

function agentCtx(over = {}) {
  return gctx({
    policy: defaultPolicyFor('pragmatist-micro'), portfolio: { id: 'pragmatist-micro', kind: 'agent', segment: 'micro', ...CASH },
    agent: { id: 'agent-fixture', portfolio_id: 'pragmatist-micro', state: 'RUNNING', grants: { portfolios: ['pragmatist-micro'], actions: ['open', 'close', 'modify', 'cancel'], instruments: ['equity'] } },
    universe: new Set([SYM]), confirm: false, ...over,
  });
}

const codes = (r) => r.reasons.map((x) => x.code);
const check = (r, rule) => r.checks.find((c) => c.rule === rule);
function denies(r, rule, code, why = '') {
  assert.equal(r.decision, 'DENIED', `${rule}: expected DENIED ${why}`);
  const c = check(r, rule);
  assert.equal(c.pass, false, `${rule} should fail ${why}: ${JSON.stringify(c)}`);
  assert.equal(c.code, code, `${rule} ${why}: ${c.detail}`);
  assert.ok(codes(r).includes(code));
}
function deepFreeze(o) {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) { Object.freeze(o); for (const v of Object.values(o)) deepFreeze(v); }
  return o;
}

// ---------------------------------------------------------------------------------------------------------------
// Baseline, determinism, deny-by-default

test('baseline: a confirmed human sandbox buy is ACCEPTED with a check for every required rule and an as-of estimate', () => {
  const r = evaluate(humanIntent(), gctx());
  assert.equal(r.decision, 'ACCEPTED', JSON.stringify(r.reasons));
  assert.deepEqual(r.checks.map((c) => c.rule), ['intent_valid', ...REQUIRED_RULES]);
  assert.ok(r.checks.every((c) => c.pass));
  assert.equal(check(r, 'agent_authority').applicable, false, 'human intent: human_confirmed applies instead');
  assert.deepEqual(
    [r.estimate.priceU, r.estimate.qty, r.estimate.costU, r.estimate.slippageBps, r.estimate.segment, r.estimate.spendCapU, r.estimate.basis, r.estimate.asOfEstimateOnly],
    [5025, 100, 502_500, 50, 'micro', 25_000_000, 'IEX_ASK_PLUS_SLIPPAGE', true],
  );
  assert.equal(PAPER_ONLY, true);
  assert.deepEqual(r.policy, { id: 'policy:sandbox', label: 'EXPLORATORY DEFAULTS — NOT VALIDATED' });
});

test('evaluate is pure and deterministic: frozen inputs, identical results', () => {
  const it = deepFreeze(humanIntent());
  const ctx = deepFreeze(gctx({ openOrders: [{ id: 'o1', side: 'buy', qty: 10, filled_qty: 0, limit_px: 4000, kind: 'equity', sym: SYM, role: 'entry' }] }));
  const a = evaluate(it, ctx);
  const b = evaluate(it, ctx);
  assert.deepEqual(a, b);
  assert.equal(a.decision, 'ACCEPTED');
});

test('deny-by-default: a missing rule denies RULE_MISSING:<name>; no policy denies every rule', () => {
  const p = defaultPolicyFor('sandbox');
  delete p.rules.max_spread_bps;
  const r = evaluate(humanIntent(), gctx({ policy: p }));
  assert.equal(r.decision, 'DENIED');
  assert.deepEqual(codes(r), ['RULE_MISSING:max_spread_bps']);
  assert.equal(r.checks.length, REQUIRED_RULES.length + 1, 'other rules still evaluated and listed');
  const none = evaluate(humanIntent(), gctx({ policy: null }));
  assert.equal(none.decision, 'DENIED');
  assert.deepEqual(codes(none), REQUIRED_RULES.map((n) => `RULE_MISSING:${n}`));
  assert.equal(defaultPolicyFor('no-such-portfolio'), null, 'unknown portfolio => no policy => deny');
});

test('any thrown error denies GATE_ERROR and every rule is still reported (not evaluated)', () => {
  const p = defaultPolicyFor('sandbox');
  p.rules.max_trade_spend_usd.value = 'lots';
  const r = evaluate(humanIntent(), gctx({ policy: p }));
  assert.equal(r.decision, 'DENIED');
  assert.deepEqual(codes(r), ['GATE_ERROR']);
  assert.match(r.reasons[0].detail, /max_trade_spend_usd\.value/);
  for (const rule of REQUIRED_RULES) assert.ok(check(r, rule), `check listed for ${rule}`);
  assert.ok(r.checks.filter((c) => c.evaluated === false).every((c) => /NOT_EVALUATED: gate error/.test(c.detail)));
  assert.deepEqual(codes(evaluate(humanIntent(), gctx({ clock: undefined }))), ['GATE_ERROR'], 'no replay clock');
  assert.deepEqual(codes(evaluate(humanIntent(), null)), ['GATE_ERROR'], 'no context');
  assert.deepEqual(codes(evaluate(humanIntent({ portfolio_id: 'cowboy-micro' }), gctx())), ['GATE_ERROR'], 'context for another portfolio');
});

test('an invalid intent is denied INTENT_INVALID before any rule runs', () => {
  const r = evaluate({ ...humanIntent(), surprise: true }, gctx());
  assert.equal(r.decision, 'DENIED');
  assert.deepEqual(codes(r), ['INTENT_INVALID']);
  assert.equal(r.estimate, null);
  assert.ok(REQUIRED_RULES.every((n) => check(r, n).evaluated === false));
  assert.deepEqual(codes(evaluate(humanIntent({ action: 'open', side: 'sell' }), gctx())), ['INTENT_INVALID'], 'no shorting: open must be a buy');
});

// ---------------------------------------------------------------------------------------------------------------
// Authority: paper only, kill switch, agents, humans

test('paper_only: anything but true denies PAPER_ONLY_VIOLATION', () => {
  const p = defaultPolicyFor('sandbox');
  p.rules.paper_only.value = false;
  denies(evaluate(humanIntent(), gctx({ policy: p })), 'paper_only', 'PAPER_ONLY_VIOLATION');
});

test('kill switch: engaged denies everything except a human cancel; unknown state denies', () => {
  const kill = { engaged: true, by: 'human' };
  denies(evaluate(humanIntent(), gctx({ kill })), 'kill_switch', 'KILL_SWITCH_ENGAGED');
  const cancel = humanIntent({ action: 'cancel', side: 'buy', target_order_id: 'ord_fixture', qty: undefined });
  const hc = evaluate(cancel, gctx({ kill, targetOrder: order() }));
  assert.equal(hc.decision, 'ACCEPTED', JSON.stringify(hc.reasons));
  assert.match(check(hc, 'kill_switch').detail, /human cancel permitted/);
  const agentOrder = order({ portfolio_id: 'pragmatist-micro', agent_id: 'agent-fixture' });
  denies(evaluate(agentIntent({ action: 'cancel', side: 'buy', target_order_id: 'ord_fixture', qty: undefined }), agentCtx({ kill, targetOrder: agentOrder })), 'kill_switch', 'KILL_SWITCH_ENGAGED');
  denies(evaluate(agentIntent({ action: 'close', side: 'sell' }), agentCtx({ kill, positions: [{ instrument_id: SYM, sym: SYM, kind: 'equity', qty: 50 }] })), 'kill_switch', 'KILL_SWITCH_ENGAGED');
  denies(evaluate(humanIntent(), gctx({ kill: undefined })), 'kill_switch', 'KILL_STATE_UNKNOWN');
});

test('agent_authority: RUNNING agent with a grant for this portfolio and action; anything else denies', () => {
  assert.equal(evaluate(agentIntent(), agentCtx()).decision, 'ACCEPTED', JSON.stringify(evaluate(agentIntent(), agentCtx()).reasons));
  const a = agentCtx().agent;
  denies(evaluate(agentIntent(), agentCtx({ agent: { ...a, state: 'PAUSED' } })), 'agent_authority', 'AGENT_NOT_RUNNING');
  denies(evaluate(agentIntent(), agentCtx({ agent: null })), 'agent_authority', 'AGENT_UNKNOWN');
  denies(evaluate(agentIntent(), agentCtx({ agent: { ...a, id: 'agent-other' } })), 'agent_authority', 'AGENT_MISMATCH');
  denies(evaluate(agentIntent(), agentCtx({ agent: { ...a, portfolio_id: 'cowboy-micro' } })), 'agent_authority', 'AGENT_PORTFOLIO_MISMATCH');
  denies(evaluate(agentIntent(), agentCtx({ agent: { ...a, grants: { portfolios: ['pragmatist-micro'], actions: ['close'] } } })), 'agent_authority', 'AGENT_GRANT_MISSING');
  denies(evaluate(agentIntent(), agentCtx({ agent: { ...a, grants: null } })), 'agent_authority', 'AGENT_GRANT_MISSING');
  // Agents may never act on the manual sandbox.
  denies(evaluate(agentIntent({ portfolio_id: 'sandbox' }), gctx({ agent: { ...a, portfolio_id: 'sandbox' } })), 'agent_authority', 'AGENT_NOT_PERMITTED_ON_PORTFOLIO');
});

test('human_confirmed: confirm:true is required; humans trade only the sandbox but may cancel anywhere', () => {
  denies(evaluate(humanIntent(), gctx({ confirm: false })), 'human_confirmed', 'HUMAN_NOT_CONFIRMED');
  const agentPf = { policy: defaultPolicyFor('pragmatist-micro'), portfolio: { id: 'pragmatist-micro', kind: 'agent', segment: 'micro', ...CASH }, universe: new Set([SYM]) };
  denies(evaluate(humanIntent({ portfolio_id: 'pragmatist-micro' }), gctx(agentPf)), 'human_confirmed', 'HUMAN_TRADING_SANDBOX_ONLY');
  const cancel = evaluate(humanIntent({ portfolio_id: 'pragmatist-micro', action: 'cancel', target_order_id: 'ord_fixture', qty: undefined }),
    gctx({ ...agentPf, targetOrder: order({ portfolio_id: 'pragmatist-micro', agent_id: 'agent-fixture' }) }));
  assert.equal(check(cancel, 'human_confirmed').pass, true);
  assert.equal(cancel.decision, 'ACCEPTED', JSON.stringify(cancel.reasons));
});

// ---------------------------------------------------------------------------------------------------------------
// Instruments and symbols

test('instrument_allowed: options only with a verified options quote (NO_VERIFIED_OPTIONS_DATA otherwise)', () => {
  const contract = { occ: 'FIXP990105P00004000', underlying: 'FIXP', expiry: '2099-01-05', strike: 40_000, right: 'P', multiplier: 100 };
  const opt = humanIntent({ instrument: { kind: 'option', sym: 'FIXP', contract }, qty: 1 });
  const r = evaluate(opt, gctx({ quote: null }));
  denies(r, 'instrument_allowed', 'NO_VERIFIED_OPTIONS_DATA');
  assert.equal(check(r, 'quote_fresh').code, 'NO_VERIFIED_OPTIONS_DATA');
  const p = defaultPolicyFor('sandbox');
  p.rules.instrument_allowed.equity = false;
  denies(evaluate(humanIntent(), gctx({ policy: p })), 'instrument_allowed', 'INSTRUMENT_NOT_ALLOWED');
});

test('symbol_allowed: test symbols always refused; deny/allow lists and the as-of segment universe apply to entries only', () => {
  denies(evaluate(humanIntent({ instrument: { kind: 'equity', sym: 'ZVZZT' } }), gctx({ quote: quote({ sym: 'ZVZZT' }) })), 'symbol_allowed', 'SYMBOL_IS_TEST_ISSUE');
  const p = defaultPolicyFor('sandbox');
  p.rules.symbol_allowed.deny = [SYM];
  denies(evaluate(humanIntent(), gctx({ policy: p })), 'symbol_allowed', 'SYMBOL_DENIED');
  const p2 = defaultPolicyFor('sandbox');
  p2.rules.symbol_allowed.allow = ['FIXZ'];
  denies(evaluate(humanIntent(), gctx({ policy: p2 })), 'symbol_allowed', 'SYMBOL_NOT_ALLOWED');
  denies(evaluate(agentIntent(), agentCtx({ universe: new Set(['FIXZ']) })), 'symbol_allowed', 'SYMBOL_NOT_IN_SEGMENT');
  denies(evaluate(agentIntent(), agentCtx({ universe: null })), 'symbol_allowed', 'UNIVERSE_UNAVAILABLE');
  // An exit is never trapped by the universe filters.
  const exit = evaluate(agentIntent({ action: 'close', side: 'sell' }), agentCtx({ universe: new Set(), positions: [{ instrument_id: SYM, sym: SYM, kind: 'equity', qty: 50 }] }));
  assert.equal(check(exit, 'symbol_allowed').pass, true);
  assert.equal(exit.decision, 'ACCEPTED', JSON.stringify(exit.reasons));
});

// ---------------------------------------------------------------------------------------------------------------
// Money: spend cap, cash, shorting, loss cap, concentration

test('max_trade_spend_usd: estimated cost incl. slippage + fees vs the policy cap and the intent budget', () => {
  denies(evaluate(humanIntent({ qty: 5000 }), gctx()), 'max_trade_spend_usd', 'BUDGET_EXCEEDED');
  const sized = evaluate(humanIntent({ qty: undefined, budget_usd: 1000 }), gctx());
  assert.equal(sized.decision, 'ACCEPTED');
  assert.deepEqual([sized.estimate.qty, sized.estimate.costU, sized.estimate.sizedFromBudget, sized.estimate.spendCapU], [1990, 9_999_750, true, 10_000_000],
    'floor($1,000 / 0.5025) shares; spendCapU = min(budget, policy cap) is what the caller should store as meta.maxSpendU');
  denies(evaluate(humanIntent({ qty: 300, budget_usd: 1000 }), gctx({ quote: quote({ ask: 50_000, bid: 49_990 }) })), 'max_trade_spend_usd', 'BUDGET_EXCEEDED');
  denies(evaluate(humanIntent({ qty: undefined, budget_usd: 0.1 }), gctx()), 'max_trade_spend_usd', 'BUDGET_EXCEEDED');
  denies(evaluate(humanIntent(), gctx({ quote: null })), 'max_trade_spend_usd', 'NO_PRICE_ESTIMATE');
  const lim = evaluate(humanIntent({ order_type: 'limit', limit_px_u: 4800 }), gctx());
  assert.deepEqual([lim.estimate.priceU, lim.estimate.basis], [4800, 'LIMIT_PRICE (max payable)']);
  const stop = evaluate(humanIntent({ order_type: 'stop', stop_px_u: 5200 }), gctx());
  assert.deepEqual([stop.estimate.priceU, stop.estimate.basis], [5226, 'MAX(STOP, IEX_ASK)_PLUS_SLIPPAGE']);
});

test('cash_sufficient: cost vs cash minus what open buys can still spend (capped by their spend cap)', () => {
  denies(evaluate(humanIntent(), gctx({ portfolio: { id: 'sandbox', kind: 'sandbox', segment: null, ...CASH, cashU: 400_000 } })), 'cash_sufficient', 'INSUFFICIENT_CASH');
  const pf = { id: 'sandbox', kind: 'sandbox', segment: null, ...CASH, cashU: 1_000_000 };
  // An open limit buy reserves remaining x limit: 110 x 5000 = 550,000 leaves 450,000 < 502,500; 90 x 5000 leaves 550,000.
  const limitBuy = { id: 'o1', side: 'buy', qty: 110, filled_qty: 0, limit_px: 5000, kind: 'equity', sym: 'FIXH', role: 'entry' };
  denies(evaluate(humanIntent(), gctx({ portfolio: pf, openOrders: [limitBuy] })), 'cash_sufficient', 'INSUFFICIENT_CASH');
  assert.equal(evaluate(humanIntent(), gctx({ portfolio: pf, openOrders: [{ ...limitBuy, qty: 130, filled_qty: 40 }] })).decision, 'ACCEPTED', 'only the unfilled 90 are reserved');
  // A market buy on another symbol reserves remaining x its submission estimate, never more than its spend cap.
  const mkt = { id: 'o2', side: 'buy', qty: 150, filled_qty: 0, limit_px: null, stop_px: null, kind: 'equity', sym: 'FIXH', role: 'entry', meta: { submitEstimate: { priceU: 5025 }, maxSpendU: 25_000_000 } };
  denies(evaluate(humanIntent(), gctx({ portfolio: pf, openOrders: [mkt] })), 'cash_sufficient', 'INSUFFICIENT_CASH');
  assert.match(check(evaluate(humanIntent(), gctx({ portfolio: pf, openOrders: [mkt] })), 'cash_sufficient').detail, /reserved \$75\.3750/);
  const capped = evaluate(humanIntent(), gctx({ portfolio: pf, openOrders: [{ ...mkt, meta: { ...mkt.meta, maxSpendU: 100_000 } }] }));
  assert.equal(check(capped, 'cash_sufficient').pass, true, check(capped, 'cash_sufficient').detail);
  // The order being modified is not counted against itself.
  assert.equal(check(evaluate(humanIntent({ action: 'modify', target_order_id: 'o2' }), gctx({ portfolio: pf, openOrders: [mkt] })), 'cash_sufficient').pass, true);
  // An open option market buy on the same underlying is never priced from the equity quote; with no estimate it
  // reserves its whole spend cap.
  const optBuy = { id: 'o3', side: 'buy', qty: 2, filled_qty: 0, limit_px: null, stop_px: null, kind: 'option', sym: SYM, role: 'entry', meta: { maxSpendU: 600_000 } };
  denies(evaluate(humanIntent(), gctx({ portfolio: pf, openOrders: [optBuy] })), 'cash_sufficient', 'INSUFFICIENT_CASH');
  assert.match(check(evaluate(humanIntent(), gctx({ portfolio: pf, openOrders: [optBuy] })), 'cash_sufficient').detail, /reserved \$60\.0000/);
});

test('no_short: a sell may never exceed the shares held', () => {
  const close = humanIntent({ action: 'close', side: 'sell', qty: 100 });
  denies(evaluate(close, gctx()), 'no_short', 'SHORT_SALE_NOT_ALLOWED');
  const pos = [{ instrument_id: SYM, sym: SYM, kind: 'equity', qty: 60 }];
  denies(evaluate(close, gctx({ positions: pos })), 'no_short', 'SHORT_SALE_NOT_ALLOWED');
  assert.equal(evaluate(humanIntent({ action: 'close', side: 'sell', qty: 60 }), gctx({ positions: pos })).decision, 'ACCEPTED');
  assert.match(check(evaluate(humanIntent({ action: 'close', side: 'sell', qty: undefined }), gctx({ positions: pos })), 'no_short').detail, /sell 60 <= held 60/, 'qty omitted => the held qty');
  const p = defaultPolicyFor('sandbox');
  p.rules.no_short.value = false;
  assert.deepEqual(codes(evaluate(close, gctx({ policy: p, positions: pos }))), ['GATE_ERROR'], 'no_short cannot be switched off');
});

test('no_short: a pending bracket child may be edited before its entry fills; a working sell may not exceed held', () => {
  const modify = humanIntent({ action: 'modify', side: 'sell', order_type: 'stop', qty: 100, stop_px_u: 4500, target_order_id: 'ord_fixture_child' });
  const pending = { id: 'ord_fixture_child', portfolio_id: 'sandbox', session_id: 'ses_fixture', sym: SYM, side: 'sell', status: 'pending_parent', qty: 100, filled_qty: 0, parent_id: 'ord_fixture_entry' };
  assert.equal(check(evaluate(modify, gctx({ targetOrder: pending })), 'no_short').applicable, false, 'pending child: sized at activation');
  denies(evaluate(modify, gctx({ targetOrder: { ...pending, status: 'working' } })), 'no_short', 'SHORT_SALE_NOT_ALLOWED');
  denies(evaluate(modify, gctx({ targetOrder: { ...pending, portfolio_id: 'pragmatist-micro' } })), 'no_short', 'SHORT_SALE_NOT_ALLOWED');
  denies(evaluate(modify, gctx({ targetOrder: null })), 'no_short', 'SHORT_SALE_NOT_ALLOWED');
});

test('fail closed: NaN or missing numeric facts deny instead of passing a comparison', () => {
  denies(evaluate(humanIntent(), gctx({ quote: quote({ ageMs: undefined }) })), 'quote_fresh', 'QUOTE_STALE');
  denies(evaluate(humanIntent(), gctx({ quote: quote({ quoteTs: Number.NaN }) })), 'quote_fresh', 'QUOTE_FROM_FUTURE');
  denies(evaluate(humanIntent(), gctx({ quote: quote({ spreadBps: Number.NaN }) })), 'max_spread_bps', 'SPREAD_TOO_WIDE');
  const pos = [{ instrument_id: SYM, sym: SYM, kind: 'equity', qty: Number.NaN }];
  denies(evaluate(humanIntent({ action: 'close', side: 'sell', qty: 10 }), gctx({ positions: pos })), 'no_short', 'SHORT_SALE_NOT_ALLOWED');
  const nanPos = [{ instrument_id: SYM, sym: SYM, kind: 'equity', qty: 10, valueU: Number.NaN }];
  denies(evaluate(humanIntent(), gctx({ positions: nanPos })), 'max_position_pct_equity', 'MAX_POSITION_PCT_EQUITY');
});

test('daily loss cap, open positions and position size block new entries only', () => {
  const lossPf = { id: 'sandbox', kind: 'sandbox', segment: null, ...CASH, equityU: 75_000_000 };
  denies(evaluate(humanIntent(), gctx({ portfolio: lossPf })), 'daily_loss_cap_usd', 'DAILY_LOSS_CAP_REACHED');
  const pos = [{ instrument_id: SYM, sym: SYM, kind: 'equity', qty: 10 }];
  assert.equal(check(evaluate(humanIntent({ action: 'close', side: 'sell', qty: 10 }), gctx({ portfolio: lossPf, positions: pos })), 'daily_loss_cap_usd').applicable, false, 'exits are never blocked');
  denies(evaluate(humanIntent(), gctx({ portfolio: { id: 'sandbox', kind: 'sandbox', segment: null, ...CASH, equityU: undefined } })), 'daily_loss_cap_usd', 'EQUITY_UNKNOWN');
  const ten = Array.from({ length: 10 }, (_, i) => ({ instrument_id: `FIX${i}`, sym: `FIX${i}`, kind: 'equity', qty: 1 }));
  denies(evaluate(humanIntent(), gctx({ positions: ten })), 'max_open_positions', 'MAX_OPEN_POSITIONS');
  assert.equal(check(evaluate(humanIntent(), gctx({ positions: [...ten.slice(0, 9), { instrument_id: SYM, sym: SYM, kind: 'equity', qty: 1 }] })), 'max_open_positions').pass, true, 'adding to an existing position');
  const small = { id: 'sandbox', kind: 'sandbox', segment: null, ...CASH, equityU: 900_000, dayStartEquityU: 900_000 };
  denies(evaluate(humanIntent(), gctx({ portfolio: small })), 'max_position_pct_equity', 'MAX_POSITION_PCT_EQUITY');
});

// ---------------------------------------------------------------------------------------------------------------
// Market facts: rate, hours, quote, spread, size; intent timing; ticks

test('order_rate_per_min: counts orders in the last minute; a human cancel is exempt', () => {
  const pos = [{ instrument_id: SYM, sym: SYM, kind: 'equity', qty: 10 }];
  assert.equal(check(evaluate(humanIntent({ action: 'close', side: 'sell', qty: 10 }), gctx({ positions: pos, recentOrderCount: 99 })), 'order_rate_per_min').applicable, false, 'exits are never rate-limited');
  denies(evaluate(humanIntent(), gctx({ recentOrderCount: 10 })), 'order_rate_per_min', 'ORDER_RATE_EXCEEDED');
  denies(evaluate(humanIntent(), gctx({ recentOrderCount: null })), 'order_rate_per_min', 'ORDER_RATE_UNKNOWN');
  assert.equal(check(evaluate(humanIntent({ action: 'cancel', target_order_id: 'ord_fixture', qty: undefined }), gctx({ recentOrderCount: 99 })), 'order_rate_per_min').applicable, false);
});

test('market_hours: regular session only (09:30-16:00 ET); cancels allowed any time', () => {
  const pre = at(9, 29);
  denies(evaluate(humanIntent({ quote_ts: pre - 1, created_ts: pre, expires_ts: pre + MINUTE }), gctx({ clock: pre, quote: quote({ quoteTs: pre - 1, ageMs: 1 }) })), 'market_hours', 'MARKET_CLOSED');
  const post = at(16, 0);
  denies(evaluate(humanIntent({ quote_ts: post - 1, created_ts: post, expires_ts: post + MINUTE }), gctx({ clock: post, quote: quote({ quoteTs: post - 1, ageMs: 1 }) })), 'market_hours', 'MARKET_CLOSED');
  const c = evaluate(humanIntent({ action: 'cancel', target_order_id: 'ord_fixture', qty: undefined, quote_ts: post - 1, created_ts: post, expires_ts: post + MINUTE }), gctx({ clock: post, targetOrder: order() }));
  assert.equal(c.decision, 'ACCEPTED', JSON.stringify(c.reasons));
  // A truncated replay (PARTIAL dataset) ends at its coverage end: nothing new after it, cancels still allowed.
  const truncated = { open: at(9, 30), close: at(10, 0), sessionClose: at(16, 0), truncated: true };
  const late = evaluate(humanIntent(), gctx({ session: truncated }));
  denies(late, 'market_hours', 'MARKET_CLOSED');
  assert.match(check(late, 'market_hours').detail, /coverage end/);
  const early = at(9, 59);
  assert.equal(check(evaluate(humanIntent({ quote_ts: early - 1, created_ts: early, expires_ts: early + MINUTE }), gctx({ clock: early, session: truncated, quote: quote({ quoteTs: early - 1, ageMs: 1 }) })), 'market_hours').pass, true);
  assert.equal(evaluate(humanIntent({ action: 'cancel', target_order_id: 'ord_fixture', qty: undefined }), gctx({ session: truncated, targetOrder: order() })).decision, 'ACCEPTED');
});

test('quote_fresh: needs an observed, two-sided, unhalted, knowable and fresh IEX quote', () => {
  denies(evaluate(humanIntent(), gctx({ quote: null })), 'quote_fresh', 'NO_VERIFIED_DATA');
  denies(evaluate(humanIntent(), gctx({ quote: quote({ halted: true, tradingStatus: 'H' }) })), 'quote_fresh', 'HALTED');
  denies(evaluate(humanIntent(), gctx({ quote: quote({ twoSided: false, bid: null, spreadBps: null }) })), 'quote_fresh', 'QUOTE_NOT_TWO_SIDED');
  denies(evaluate(humanIntent(), gctx({ quote: quote({ quoteTs: CLOCK + 1, ageMs: -1 }) })), 'quote_fresh', 'QUOTE_FROM_FUTURE');
  denies(evaluate(humanIntent(), gctx({ quote: quote({ ageMs: 300_001 }) })), 'quote_fresh', 'QUOTE_STALE');
});

test('max_spread_bps and min_displayed_size apply to risk-increasing intents; exits are not trapped', () => {
  denies(evaluate(humanIntent(), gctx({ quote: quote({ spreadBps: 1501 }) })), 'max_spread_bps', 'SPREAD_TOO_WIDE');
  denies(evaluate(agentIntent(), agentCtx({ quote: quote({ spreadBps: 801 }) })), 'max_spread_bps', 'SPREAD_TOO_WIDE');
  denies(evaluate(agentIntent(), agentCtx({ quote: quote({ askSize: 499 }) })), 'min_displayed_size', 'DISPLAYED_SIZE_TOO_SMALL');
  const pos = [{ instrument_id: SYM, sym: SYM, kind: 'equity', qty: 50 }];
  const exit = evaluate(agentIntent({ action: 'close', side: 'sell' }), agentCtx({ positions: pos, quote: quote({ spreadBps: 5000, askSize: 1 }) }));
  assert.equal(exit.decision, 'ACCEPTED', JSON.stringify(exit.reasons));
});

test('intent_not_expired and evidence_not_future: nothing after the replay clock', () => {
  denies(evaluate(humanIntent({ created_ts: CLOCK - MINUTE, quote_ts: CLOCK - MINUTE, expires_ts: CLOCK }), gctx()), 'intent_not_expired', 'INTENT_EXPIRED');
  denies(evaluate(humanIntent({ created_ts: CLOCK + 1, expires_ts: CLOCK + MINUTE }), gctx()), 'evidence_not_future', 'EVIDENCE_FROM_FUTURE');
  const refs = ['ev:fixture-1', 'ev:fixture-2'];
  const late = evaluate(humanIntent({ evidence_refs: refs }), gctx({ evidenceIndex: new Map([['ev:fixture-1', CLOCK - 1], ['ev:fixture-2', CLOCK + MINUTE]]) }));
  denies(late, 'evidence_not_future', 'EVIDENCE_FROM_FUTURE');
  const okRefs = evaluate(humanIntent({ evidence_refs: refs }), gctx({ evidenceIndex: { 'ev:fixture-1': CLOCK - 1 } }));
  assert.match(check(okRefs, 'evidence_not_future').detail, /1\/2 evidence refs resolved/);
});

test('tick_valid: every price must be a Reg NMS 612 tick', () => {
  denies(evaluate(humanIntent({ order_type: 'limit', limit_px_u: 50_005 }), gctx()), 'tick_valid', 'TICK_INVALID');
  denies(evaluate(humanIntent({ attach: { stop_loss_px_u: 45_005, take_profit_px_u: 60_000 } }), gctx({ quote: quote({ bid: 49_990, ask: 50_000 }) })), 'tick_valid', 'TICK_INVALID');
  assert.equal(check(evaluate(humanIntent({ order_type: 'limit', limit_px_u: 4999 }), gctx()), 'tick_valid').pass, true, 'sub-penny allowed below $1');
});

// ---------------------------------------------------------------------------------------------------------------
// Round 2: gate integrity (modifies, reservations, issue types, evidence, protective exits)

test('every default policy carries every required rule (incl. target_order_matches, protective_exit_required): nothing fails RULE_MISSING', () => {
  assert.ok(REQUIRED_RULES.includes('target_order_matches') && REQUIRED_RULES.includes('protective_exit_required'));
  assert.equal(POLICY_VERSION, 2);
  for (const [pid, p] of Object.entries(DEFAULT_POLICIES)) {
    for (const r of REQUIRED_RULES) assert.ok(p.rules[r], `${pid} has ${r}`);
    assert.equal(p.version, POLICY_VERSION, pid);
    assert.deepEqual(p.rules.symbol_allowed.denyIssueTypes, ['warrant', 'right', 'unit'], pid);
    assert.deepEqual(p.rules.protective_exit_required.informationalStrategyIds, ['handwritten-notes-example'], pid);
  }
});

test('target_order_matches: a modify/cancel must name an order of this session + portfolio with the same symbol, kind and side', () => {
  const cancel = (over = {}) => humanIntent({ action: 'cancel', target_order_id: 'ord_fixture', qty: undefined, ...over });
  assert.equal(evaluate(cancel(), gctx({ targetOrder: order() })).decision, 'ACCEPTED');
  denies(evaluate(cancel(), gctx({ targetOrder: null })), 'target_order_matches', 'TARGET_ORDER_MISMATCH');
  denies(evaluate(cancel(), gctx()), 'target_order_matches', 'TARGET_ORDER_MISMATCH');
  for (const [what, t] of [
    ['sym', order({ sym: 'FIXH' })], ['side', order({ side: 'sell' })], ['portfolio', order({ portfolio_id: 'cowboy-micro' })],
    ['session', order({ session_id: 'ses_other' })], ['kind', order({ kind: 'option' })], ['id', order({ id: 'ord_other' })],
  ]) {
    const r = evaluate(cancel(), gctx({ targetOrder: t }));
    denies(r, 'target_order_matches', 'TARGET_ORDER_MISMATCH');
    assert.match(check(r, 'target_order_matches').detail, new RegExp(what), what);
  }
  // A context without the replay session id cannot prove the order belongs to this session (deny by default).
  denies(evaluate(cancel(), gctx({ session_id: undefined, targetOrder: order() })), 'target_order_matches', 'TARGET_ORDER_MISMATCH');
  // Agents act only on their own orders; a human may cancel any order of the portfolio.
  const mine = order({ portfolio_id: 'pragmatist-micro', agent_id: 'agent-fixture' });
  const agentCancel = agentIntent({ action: 'cancel', target_order_id: 'ord_fixture', qty: undefined });
  assert.equal(evaluate(agentCancel, agentCtx({ targetOrder: mine })).decision, 'ACCEPTED');
  denies(evaluate(agentCancel, agentCtx({ targetOrder: { ...mine, agent_id: 'agent-other' } })), 'target_order_matches', 'TARGET_ORDER_MISMATCH');
  denies(evaluate(agentCancel, agentCtx({ targetOrder: { ...mine, agent_id: null } })), 'target_order_matches', 'TARGET_ORDER_MISMATCH');
  assert.equal(check(evaluate(humanIntent(), gctx()), 'target_order_matches').applicable, false, 'entries: not applicable');
  // A modify must declare the target's real order type (it is priced and applied as that type); a cancel's type is unused.
  const stopBuy = order({ type: 'stop', limit_px: null, stop_px: 10_000, qty: 100 });
  const asMarket = humanIntent({ action: 'modify', order_type: 'market', target_order_id: 'ord_fixture', qty: 250 });
  const r1 = evaluate(asMarket, gctx({ targetOrder: stopBuy }));
  denies(r1, 'target_order_matches', 'TARGET_ORDER_MISMATCH');
  assert.match(check(r1, 'target_order_matches').detail, /order type stop != market/);
  // Even so, the estimate prices the order as the stop it is: max(stop 10000, ask 5000) + 50 bps slippage on a whole-cent tick.
  assert.equal(r1.estimate.priceU, 10_100);
  assert.equal(r1.estimate.basis, 'MAX(STOP, IEX_ASK)_PLUS_SLIPPAGE');
  const asStop = evaluate(humanIntent({ action: 'modify', order_type: 'stop', stop_px_u: 10_000, target_order_id: 'ord_fixture', qty: 250 }), gctx({ targetOrder: stopBuy }));
  assert.equal(check(asStop, 'target_order_matches').pass, true);
  assert.equal(asStop.estimate.priceU, 10_100);
  assert.equal(evaluate(cancel({ order_type: 'market' }), gctx({ targetOrder: order() })).decision, 'ACCEPTED', 'a cancel\'s declared type is not compared');
  const p = defaultPolicyFor('sandbox');
  p.rules.target_order_matches.value = false;
  assert.deepEqual(codes(evaluate(cancel(), gctx({ policy: p, targetOrder: order() }))), ['GATE_ERROR'], 'cannot be switched off');
});

test('risk-increasing buy modifies pass daily_loss_cap_usd, max_position_pct_equity and symbol_allowed; reductions do not', () => {
  // Working limit buy: 100 sh @ 4800 u, 30 filled => 70 remaining (the API gates a replace on the remaining qty).
  const target = order({ qty: 100, filled_qty: 30, limit_px: 4800 });
  const modify = (over = {}) => humanIntent({ action: 'modify', order_type: 'limit', target_order_id: 'ord_fixture', qty: 70, limit_px_u: 4800, ...over });
  const lossPf = { id: 'sandbox', kind: 'sandbox', segment: null, ...CASH, equityU: 75_000_000 };
  // Same terms or less: not an increase => the entry-only rules are not applicable, even with the loss cap reached.
  for (const it of [modify(), modify({ qty: 50 }), modify({ limit_px_u: 4700 })]) {
    const r = evaluate(it, gctx({ portfolio: lossPf, targetOrder: target }));
    assert.equal(r.decision, 'ACCEPTED', JSON.stringify(r.reasons));
    for (const rule of ['daily_loss_cap_usd', 'max_position_pct_equity']) assert.equal(check(r, rule).applicable, false, rule);
  }
  // More shares, a higher limit, a moved stop trigger, or an unknown target: the entry rules apply.
  for (const it of [modify({ qty: 71 }), modify({ limit_px_u: 4900 })]) {
    denies(evaluate(it, gctx({ portfolio: lossPf, targetOrder: target })), 'daily_loss_cap_usd', 'DAILY_LOSS_CAP_REACHED');
  }
  const stopTarget = order({ type: 'stop', limit_px: null, stop_px: 5200 });
  const stopMod = humanIntent({ action: 'modify', order_type: 'stop', target_order_id: 'ord_fixture', qty: 100, stop_px_u: 5100 });
  denies(evaluate(stopMod, gctx({ portfolio: lossPf, targetOrder: stopTarget })), 'daily_loss_cap_usd', 'DAILY_LOSS_CAP_REACHED');
  assert.equal(check(evaluate({ ...stopMod, stop_px_u: 5200 }, gctx({ portfolio: lossPf, targetOrder: stopTarget })), 'daily_loss_cap_usd').applicable, false);
  const unknown = evaluate(modify({ qty: 10 }), gctx({ portfolio: lossPf, targetOrder: null }));
  denies(unknown, 'target_order_matches', 'TARGET_ORDER_MISMATCH');
  denies(unknown, 'daily_loss_cap_usd', 'DAILY_LOSS_CAP_REACHED');
  // max_position_pct_equity on an increase: 2,000 sh x 4900 u = $980 of $1,000 equity.
  const small = { id: 'sandbox', kind: 'sandbox', segment: null, cashU: 100_000_000, equityU: 10_000_000, dayStartEquityU: 10_000_000 };
  denies(evaluate(modify({ qty: 2000, limit_px_u: 4900 }), gctx({ portfolio: small, targetOrder: target })), 'max_position_pct_equity', 'MAX_POSITION_PCT_EQUITY');
  // symbol_allowed on an increase: deny list and the agent segment universe apply; a reduction is never trapped.
  const p = defaultPolicyFor('sandbox');
  p.rules.symbol_allowed.deny = [SYM];
  denies(evaluate(modify({ qty: 80 }), gctx({ policy: p, targetOrder: target })), 'symbol_allowed', 'SYMBOL_DENIED');
  assert.equal(evaluate(modify({ qty: 60 }), gctx({ policy: p, targetOrder: target })).decision, 'ACCEPTED');
  const agentTarget = order({ portfolio_id: 'pragmatist-micro', agent_id: 'agent-fixture', qty: 50, limit_px: 4800 });
  const agentMod = agentIntent({ action: 'modify', order_type: 'limit', target_order_id: 'ord_fixture', qty: 60, limit_px_u: 4800 });
  denies(evaluate(agentMod, agentCtx({ universe: new Set(), targetOrder: agentTarget })), 'symbol_allowed', 'SYMBOL_NOT_IN_SEGMENT');
  assert.equal(evaluate({ ...agentMod, qty: 40 }, agentCtx({ universe: new Set(), targetOrder: agentTarget })).decision, 'ACCEPTED');
  // A modify that omits qty is estimated at the target's remaining qty (70 x 4900 u).
  const noQty = evaluate(modify({ qty: undefined, limit_px_u: 4900 }), gctx({ targetOrder: target }));
  assert.equal(noQty.estimate.qty, 70);
  assert.equal(noQty.estimate.costU, 70 * 4900);
});

test('cash_sufficient reserves conservatively for every other open buy (fees included, never $0); unknown => RESERVATION_UNKNOWN', () => {
  const pf = { id: 'sandbox', kind: 'sandbox', segment: null, ...CASH, cashU: 1_000_000 };
  const reservedOf = (r) => Number(/reserved \$([0-9.]+)/.exec(check(r, 'cash_sufficient').detail)[1]);
  const mkt = { id: 'o9', side: 'buy', qty: 100, filled_qty: 0, limit_px: null, stop_px: null, kind: 'equity', sym: 'FIXH', role: 'entry', meta: null };
  // No limit, no quote, no recorded estimate, no spend cap: unknown, so the new buy is denied rather than reserving $0.
  const unknown = evaluate(humanIntent(), gctx({ portfolio: pf, openOrders: [mkt] }));
  denies(unknown, 'cash_sufficient', 'RESERVATION_UNKNOWN');
  assert.match(check(unknown, 'cash_sufficient').detail, /o9/);
  // An as-of quote for the other symbol prices it: max(stop, ask) + 50 bps micro slippage = 10,050 u, rounded UP to the
  // $0.01 tick = 10,100 u x 100 = $101.
  const q = quote({ sym: 'FIXH', bid: 9990, ask: 10_000 });
  assert.equal(reservedOf(evaluate(humanIntent(), gctx({ portfolio: pf, openOrders: [mkt], openOrderQuotes: { FIXH: q } }))), 101);
  // A stop buy reserves at max(stop, ask) + slippage: 10,500 -> 10,553 -> 10,600 u (rounded up to the tick).
  assert.equal(reservedOf(evaluate(humanIntent(), gctx({ portfolio: pf, openOrders: [{ ...mkt, stop_px: 10_500 }], openOrderQuotes: { FIXH: q } }))), 106);
  // The recorded estimate is used when it is larger than the as-of quote (or when there is no quote).
  const est = { ...mkt, meta: { gate_estimate: { priceU: 12_000 } } };
  assert.equal(reservedOf(evaluate(humanIntent(), gctx({ portfolio: pf, openOrders: [est], openOrderQuotes: { FIXH: q } }))), 120);
  assert.equal(reservedOf(evaluate(humanIntent(), gctx({ portfolio: pf, openOrders: [{ ...mkt, meta: { submitEstimate: { priceU: 9000 } } }], openOrderQuotes: { FIXH: q } }))), 101);
  assert.equal(reservedOf(evaluate(humanIntent(), gctx({ portfolio: pf, openOrders: [{ ...mkt, meta: { submitEstimate: { priceU: 9000 } } }] }))), 90);
  // Fees are part of the reservation (TEST FIXTURE cost model with a $1 commission per order).
  const cm = { ...defaultCostModel('micro'), commissionPerOrderU: 10_000 };
  const limitBuy = { ...mkt, limit_px: 5000, qty: 10 };
  assert.equal(reservedOf(evaluate(humanIntent(), gctx({ portfolio: pf, openOrders: [limitBuy], costModel: cm }))), 6, '10 x 5000 u + $1 commission');
  assert.equal(reservedOf(evaluate(humanIntent(), gctx({ portfolio: pf, openOrders: [{ ...limitBuy, qty: 20, filled_qty: 10 }], costModel: cm }))), 5,
    'commission already charged on the first fill');
  // The reservation can never be switched off.
  const p = defaultPolicyFor('sandbox');
  p.rules.cash_sufficient.reserveOpenBuyOrders = false;
  assert.deepEqual(codes(evaluate(humanIntent(), gctx({ policy: p }))), ['GATE_ERROR']);
  // A NaN quantity is unknown, not zero.
  denies(evaluate(humanIntent(), gctx({ portfolio: pf, openOrders: [{ ...limitBuy, qty: Number.NaN }] })), 'cash_sufficient', 'RESERVATION_UNKNOWN');
});

test('max_position_pct_equity counts pending buys in the same symbol (priced like cash_sufficient), excluding the order being modified', () => {
  const pf = { id: 'sandbox', kind: 'sandbox', segment: null, cashU: 100_000_000, equityU: 10_000_000, dayStartEquityU: 10_000_000 };
  // This buy: 100 x 5025 u = 502,500 u (5.025%). A pending 900 x 5000 u limit buy in FIXG adds 45% => 50.025% > 50%.
  const pending = { id: 'o1', side: 'buy', qty: 900, filled_qty: 0, limit_px: 5000, stop_px: null, kind: 'equity', sym: SYM, role: 'entry', meta: null };
  const r = evaluate(humanIntent(), gctx({ portfolio: pf, openOrders: [pending] }));
  denies(r, 'max_position_pct_equity', 'MAX_POSITION_PCT_EQUITY');
  assert.match(check(r, 'max_position_pct_equity').detail, /held \$0\.0000 \+ pending buys \$450\.0000 \(1 order\(s\)\) \+ this \$50\.2500/);
  assert.equal(check(evaluate(humanIntent(), gctx({ portfolio: pf, openOrders: [{ ...pending, filled_qty: 10 }] })), 'max_position_pct_equity').pass, true, 'only the unfilled part is pending');
  assert.equal(check(evaluate(humanIntent(), gctx({ portfolio: pf, openOrders: [{ ...pending, sym: 'FIXH' }] })), 'max_position_pct_equity').pass, true, 'other symbols are not this position');
  // A same-symbol market buy with no two-sided quote, no recorded estimate and no spend cap cannot be priced.
  const noQuote = gctx({ portfolio: pf, openOrders: [{ ...pending, limit_px: null }], quote: quote({ twoSided: false, bid: null, spreadBps: null }) });
  denies(evaluate(humanIntent({ order_type: 'limit', limit_px_u: 5000 }), noQuote), 'max_position_pct_equity', 'RESERVATION_UNKNOWN');
  // A modify replaces its own order: the target is not counted twice.
  const mod = humanIntent({ action: 'modify', order_type: 'limit', target_order_id: 'o1', qty: 1010, limit_px_u: 5000 });
  const target = order({ id: 'o1', qty: 900, limit_px: 5000 });
  const mr = evaluate(mod, gctx({ portfolio: pf, openOrders: [pending], targetOrder: target }));
  denies(mr, 'max_position_pct_equity', 'MAX_POSITION_PCT_EQUITY');
  assert.match(check(mr, 'max_position_pct_equity').detail, /pending buys \$0\.0000 \(0 order\(s\)\) \+ this \$505\.0000/);
});

test('symbol_allowed denies warrants, rights and units by SYMBOL pattern (configurable); exits are never trapped', () => {
  assert.deepEqual(issueTypeFromSymbol('BBAI+'), { type: 'warrant', basis: "IEX symbol suffix '+'" });
  assert.equal(issueTypeFromSymbol('NE+A').type, 'warrant');
  assert.equal(issueTypeFromSymbol('OCAC^').type, 'right');
  assert.equal(issueTypeFromSymbol('AIIA=').type, 'unit');
  assert.equal(issueTypeFromSymbol('FIXGW').type, 'warrant');
  assert.equal(issueTypeFromSymbol('FIXGR').type, 'right');
  assert.equal(issueTypeFromSymbol('FIXGU').type, 'unit');
  assert.equal(issueTypeFromSymbol('FIX.WS').type, 'warrant');
  assert.equal(issueTypeFromSymbol('FIX.U').type, 'unit');
  assert.equal(issueTypeFromSymbol('FIX.RT').type, 'right');
  for (const s of [SYM, 'BRK.B', 'AHT-F', 'FIXW', 'MKC.V']) assert.equal(issueTypeFromSymbol(s), null, s);
  // IEX-suffixed symbols are valid intents (the gate decides, the proposer does not fail).
  assert.equal(validateIntent(humanIntent({ instrument: { kind: 'equity', sym: 'BBAI+' } })).ok, true);
  assert.equal(validateIntent(humanIntent({ instrument: { kind: 'equity', sym: 'BBAI+ABC' } })).ok, false);
  for (const sym of ['BBAI+', 'OCAC^', 'AIIA=', 'FIXGW', 'FIXGR', 'FIXGU', 'FIX.WS']) {
    const r = evaluate(humanIntent({ instrument: { kind: 'equity', sym } }), gctx({ quote: quote({ sym }) }));
    denies(r, 'symbol_allowed', 'SYMBOL_ISSUE_TYPE_DENIED');
    assert.match(check(r, 'symbol_allowed').detail, /by its symbol pattern/);
  }
  denies(evaluate(agentIntent({ instrument: { kind: 'equity', sym: 'FIXGW' } }), agentCtx({ universe: new Set(['FIXGW']), quote: quote({ sym: 'FIXGW' }) })), 'symbol_allowed', 'SYMBOL_ISSUE_TYPE_DENIED');
  const exit = evaluate(humanIntent({ action: 'close', side: 'sell', qty: 10, instrument: { kind: 'equity', sym: 'FIXGW' } }),
    gctx({ quote: quote({ sym: 'FIXGW' }), positions: [{ instrument_id: 'FIXGW', sym: 'FIXGW', kind: 'equity', qty: 10 }] }));
  assert.equal(exit.decision, 'ACCEPTED', JSON.stringify(exit.reasons));
  const p = defaultPolicyFor('sandbox');
  p.rules.symbol_allowed.denyIssueTypes = ['right'];
  assert.equal(check(evaluate(humanIntent({ instrument: { kind: 'equity', sym: 'FIXGW' } }), gctx({ policy: p, quote: quote({ sym: 'FIXGW' }) })), 'symbol_allowed').pass, true, 'warrants allowed by config');
  denies(evaluate(humanIntent({ instrument: { kind: 'equity', sym: 'FIXGR' } }), gctx({ policy: p, quote: quote({ sym: 'FIXGR' }) })), 'symbol_allowed', 'SYMBOL_ISSUE_TYPE_DENIED');
  const absent = defaultPolicyFor('sandbox');
  delete absent.rules.symbol_allowed.denyIssueTypes;
  denies(evaluate(humanIntent({ instrument: { kind: 'equity', sym: 'FIXGU' } }), gctx({ policy: absent, quote: quote({ sym: 'FIXGU' }) })), 'symbol_allowed', 'SYMBOL_ISSUE_TYPE_DENIED');
  const bad = defaultPolicyFor('sandbox');
  bad.rules.symbol_allowed.denyIssueTypes = 'warrant';
  assert.deepEqual(codes(evaluate(humanIntent(), gctx({ policy: bad }))), ['GATE_ERROR']);
});

test('evidence_not_future: agent refs that do not resolve are denied EVIDENCE_UNRESOLVED; human refs may be free-form or omitted', () => {
  const idx = new Map([['ev_fixture_past', CLOCK - MINUTE], ['ev_fixture_future', CLOCK + 1]]);
  const model = (refs) => agentIntent({ source: 'model', evidence_refs: refs });
  denies(evaluate(model(['ev_fixture_past', 'ev_not_stored']), agentCtx({ evidenceIndex: idx })), 'evidence_not_future', 'EVIDENCE_UNRESOLVED');
  denies(evaluate(model(['ev_not_stored']), agentCtx({ evidenceIndex: null })), 'evidence_not_future', 'EVIDENCE_UNRESOLVED');
  denies(evaluate(agentIntent({ evidence_refs: ['iex-m1:somewhere:FIXG:1'] }), agentCtx()), 'evidence_not_future', 'EVIDENCE_UNRESOLVED');
  denies(evaluate(model(['ev_fixture_future']), agentCtx({ evidenceIndex: idx })), 'evidence_not_future', 'EVIDENCE_FROM_FUTURE');
  const okModel = evaluate(model(['ev_fixture_past']), agentCtx({ evidenceIndex: idx }));
  assert.equal(okModel.decision, 'ACCEPTED', JSON.stringify(okModel.reasons));
  assert.match(check(okModel, 'evidence_not_future').detail, /1\/1 evidence refs resolved/);
  assert.equal(evaluate(model([]), agentCtx()).decision, 'ACCEPTED', 'no refs: nothing to resolve');
  const human = evaluate(humanIntent({ evidence_refs: ['my own note'] }), gctx());
  assert.equal(human.decision, 'ACCEPTED', JSON.stringify(human.reasons));
  assert.match(check(human, 'evidence_not_future').detail, /0\/1 evidence refs resolved .*1 unresolved human ref/);
});

test('protective_exit_required: agent entries need a valid-tick stop strictly below the as-of IEX bid; the documented handwritten example is informational', () => {
  // Fixture bid 4990 u.
  assert.equal(check(evaluate(agentIntent(), agentCtx()), 'protective_exit_required').pass, true);
  denies(evaluate(agentIntent({ attach: undefined }), agentCtx()), 'protective_exit_required', 'PROTECTIVE_EXIT_MISSING');
  denies(evaluate(agentIntent({ attach: { take_profit_px_u: 6000 } }), agentCtx()), 'protective_exit_required', 'PROTECTIVE_EXIT_MISSING');
  for (const stop of [4990, 5000]) {
    const r = evaluate(agentIntent({ attach: { stop_loss_px_u: stop } }), agentCtx());
    denies(r, 'protective_exit_required', 'STOP_AT_OR_ABOVE_BID');
  }
  // >= $1.00 a stop must be on a whole-cent tick.
  const hi = agentCtx({ quote: quote({ bid: 49_990, ask: 50_000 }) });
  denies(evaluate(agentIntent({ qty: 5, attach: { stop_loss_px_u: 45_005 } }), hi), 'protective_exit_required', 'PROTECTIVE_EXIT_MISSING');
  assert.equal(check(evaluate(agentIntent({ qty: 5, attach: { stop_loss_px_u: 45_000 } }), hi), 'protective_exit_required').pass, true);
  denies(evaluate(agentIntent(), agentCtx({ quote: quote({ twoSided: false, bid: null }) })), 'protective_exit_required', 'QUOTE_NOT_TWO_SIDED');
  // A limit entry pays at most its limit: a stop at/above it (even below the bid) is marketable once the limit fills.
  const passive = (stop) => agentIntent({ order_type: 'limit', limit_px_u: 4500, attach: { stop_loss_px_u: stop } });
  denies(evaluate(passive(4500), agentCtx()), 'protective_exit_required', 'STOP_AT_OR_ABOVE_ENTRY_LIMIT');
  denies(evaluate(passive(4700), agentCtx()), 'protective_exit_required', 'STOP_AT_OR_ABOVE_ENTRY_LIMIT');
  assert.equal(check(evaluate(passive(4400), agentCtx()), 'protective_exit_required').pass, true);
  // Not applicable: human orders (brackets optional), exits, cancels.
  assert.equal(check(evaluate(humanIntent(), gctx()), 'protective_exit_required').applicable, false);
  const pos = [{ instrument_id: SYM, sym: SYM, kind: 'equity', qty: 50 }];
  assert.equal(check(evaluate(agentIntent({ action: 'close', side: 'sell' }), agentCtx({ positions: pos })), 'protective_exit_required').applicable, false);

  // The handwritten-notes example (stop AT the entry ask, docs/OPEN_QUESTIONS.md #4): recorded, not denied.
  const hwStrategy = { id: 'handwritten-notes-example', stopLossBasis: 'at_entry_ref', ambiguityIds: ['take-profit-250', 'stop-at-entry'] };
  const hwAgent = { ...agentCtx().agent, strategy: hwStrategy };
  const hwIntent = agentIntent({ strategy_id: 'handwritten-notes-example', attach: { stop_loss_px_u: 5000 } });
  const hw = evaluate(hwIntent, agentCtx({ agent: hwAgent }));
  assert.equal(hw.decision, 'ACCEPTED', JSON.stringify(hw.reasons));
  const c = check(hw, 'protective_exit_required');
  assert.deepEqual([c.pass, c.informational, c.stopVsBidBps], [true, true, 20]);
  assert.match(c.detail, /INFORMATIONAL .*OPEN_QUESTIONS\.md #4.*20 bps above/);
  // The exception is narrow: the intent's strategy must be the agent's stored strategy, with the at-entry stop and the
  // documented ambiguity, and listed in the policy.
  for (const [why, ctxOver, itOver] of [
    ['other strategy id', { agent: { ...hwAgent, strategy: { ...hwStrategy, id: 'my-copy' } } }, { strategy_id: 'my-copy' }],
    ['intent claims the example, agent runs another', { agent: { ...hwAgent, strategy: { ...hwStrategy, id: 'fixture-strategy' } } }, {}],
    ['stop basis below entry', { agent: { ...hwAgent, strategy: { ...hwStrategy, stopLossBasis: 'pct_below_entry_ref' } } }, {}],
    ['ambiguity not documented', { agent: { ...hwAgent, strategy: { ...hwStrategy, ambiguityIds: [] } } }, {}],
    ['no stored strategy', { agent: { ...hwAgent, strategy: null } }, {}],
  ]) {
    denies(evaluate({ ...hwIntent, ...itOver }, agentCtx(ctxOver)), 'protective_exit_required', 'STOP_AT_OR_ABOVE_BID', why);
  }
  const p = defaultPolicyFor('pragmatist-micro');
  p.rules.protective_exit_required.informationalStrategyIds = [];
  denies(evaluate(hwIntent, agentCtx({ policy: p, agent: hwAgent })), 'protective_exit_required', 'STOP_AT_OR_ABOVE_BID');
  // Even the documented example must attach a stop.
  denies(evaluate({ ...hwIntent, attach: { take_profit_px_u: 12_500 } }, agentCtx({ agent: hwAgent })), 'protective_exit_required', 'PROTECTIVE_EXIT_MISSING');
  const off = defaultPolicyFor('pragmatist-micro');
  off.rules.protective_exit_required.value = false;
  assert.deepEqual(codes(evaluate(agentIntent(), agentCtx({ policy: off }))), ['GATE_ERROR'], 'cannot be switched off');
});

// ---------------------------------------------------------------------------------------------------------------
// buildGateContext: facts from the database as of the replay clock

test('buildGateContext: quote, orders, kill state and agent come from the DB as of the clock; decisions are journaled', () => {
  const s = setupScenario('gate-context');
  try {
    const { db, session_id } = s;
    for (let t = at(9, 58); t <= at(9, 59); t += MINUTE) addMinute(db, FIXTURE_DS, SYM, t, { bid: 4990, ask: 5000, trades: { o: 4990, h: 4990, l: 4990, c: 4990, v: 100, n: 1 } });
    // TEST FIXTURE: a minute that is NOT complete at 10:00 must never be visible (no look-ahead).
    addMinute(db, FIXTURE_DS, SYM, at(10, 0), { bid: 9990, ask: 10_000, trades: { o: 9990, h: 9990, l: 9990, c: 9990, v: 100, n: 1 } });
    const g = buildGateContext(db, { session_id, ds: FIXTURE_DS, clock: CLOCK, intent: humanIntent(), confirm: true });
    assert.deepEqual([g.quote.bid, g.quote.ask, g.quote.source.minuteRowT], [4990, 5000, at(9, 59)]);
    assert.ok(g.quote.quoteTs <= CLOCK);
    assert.deepEqual(g.kill, { engaged: false, at: null, by: null, protective_policy: null, source: 'default (no control row)' });
    assert.equal(g.recentOrderCount, 0);
    assert.deepEqual([g.portfolio.cashU, g.portfolio.kind, g.session.open], [100_000_000, 'sandbox', at(9, 30)]);
    assert.equal(g.costModel.segment, 'micro');
    const ok = evaluate(humanIntent(), g);
    assert.equal(ok.decision, 'ACCEPTED', JSON.stringify(ok.reasons));
    journalDecision(db, { session_id, ts_sim: CLOCK, intent: humanIntent(), result: ok });

    // Orders created in the last minute count toward the rate limit.
    submitOrder(db, s.ctx(CLOCK), { portfolio_id: 'sandbox', sym: SYM, side: 'buy', type: 'limit', limit_px: 4000, qty: 10, actor: 'human' });
    assert.equal(buildGateContext(db, { session_id, ds: FIXTURE_DS, clock: CLOCK, intent: humanIntent() }).recentOrderCount, 1);
    assert.equal(buildGateContext(db, { session_id, ds: FIXTURE_DS, clock: CLOCK + MINUTE, intent: humanIntent() }).recentOrderCount, 0);
    // Bracket children are orders on the book and count toward the rate (an entry with two exits = 3).
    const br = submitOrder(db, s.ctx(CLOCK), { portfolio_id: 'sandbox', sym: SYM, side: 'buy', type: 'limit', limit_px: 4000, qty: 10, actor: 'human', attach: { stop_loss_px_u: 3500, take_profit_px_u: 6000 } });
    assert.equal(br.ok, true, JSON.stringify(br.errors));
    assert.equal(br.children.length, 2);
    assert.equal(buildGateContext(db, { session_id, ds: FIXTURE_DS, clock: CLOCK, intent: humanIntent() }).recentOrderCount, 4);
    // A modify names its target order; the gate sees it (same session and portfolio only).
    const child = br.children.find((c) => c.role === 'stop_loss');
    const mod = humanIntent({ action: 'modify', side: 'sell', order_type: 'stop', qty: 10, stop_px_u: 3600, target_order_id: child.id });
    const gm = buildGateContext(db, { session_id, ds: FIXTURE_DS, clock: CLOCK, intent: mod, confirm: true });
    assert.deepEqual([gm.targetOrder.id, gm.targetOrder.status], [child.id, 'pending_parent']);
    assert.equal(check(evaluate(mod, gm), 'no_short').applicable, false);
    assert.equal(buildGateContext(db, { session_id: 'ses_other', ds: FIXTURE_DS, clock: CLOCK, intent: mod }).targetOrder, null);

    // Kill switch from the controls table.
    db.prepare('INSERT INTO controls (k, v, updated_wall) VALUES (?, ?, ?)').run('kill_switch', JSON.stringify({ engaged: true, by: 'human', at: CLOCK }), Date.now());
    assert.equal(readKillState(db).engaged, true);
    const killed = evaluate(humanIntent(), buildGateContext(db, { session_id, ds: FIXTURE_DS, clock: CLOCK, intent: humanIntent(), confirm: true }));
    denies(killed, 'kill_switch', 'KILL_SWITCH_ENGAGED');
    journalDecision(db, { session_id, ts_sim: CLOCK, intent: humanIntent(), result: killed });
    db.prepare('DELETE FROM controls').run();

    // Agent row: state and grants are read from the agents table.
    addAgent(db, { id: 'agent-fixture', portfolio_id: 'pragmatist-micro', lens: 'pragmatist', segment: 'micro', state: 'PAUSED' });
    const ga = buildGateContext(db, { session_id, ds: FIXTURE_DS, clock: CLOCK, intent: agentIntent() });
    assert.deepEqual([ga.agent.state, ga.agent.grants.portfolios], ['PAUSED', ['pragmatist-micro']]);
    assert.ok(ga.universe.has(SYM), 'FIXG observed below the penny tier as of the clock => in the micro universe');
    denies(evaluate(agentIntent(), ga), 'agent_authority', 'AGENT_NOT_RUNNING');

    const rows = journalRows(db, session_id).filter((r) => r.type === 'POLICY_ACCEPT' || r.type === 'POLICY_DENY');
    assert.deepEqual(rows.map((r) => [r.type, r.actor]), [['POLICY_ACCEPT', 'policy'], ['POLICY_DENY', 'policy']]);
    assert.equal(rows[0].payload.checks.length, REQUIRED_RULES.length + 1);
    assert.deepEqual(rows[1].payload.reasons.map((x) => x.code), ['KILL_SWITCH_ENGAGED']);
    assert.ok(verifyChain(db).ok);
  } finally { s.cleanup(); }
});

test('buildGateContext (round 2): as-of quotes for open buys, full target order, stored strategy facts, default evidence resolver', () => {
  const s = setupScenario('gate-context-r2');
  try {
    const { db, session_id } = s;
    for (let t = at(9, 57); t <= at(9, 59); t += MINUTE) {
      addMinute(db, FIXTURE_DS, SYM, t, { bid: 4990, ask: 5000, trades: { o: 4990, h: 4990, l: 4990, c: 4990, v: 100, n: 1 } });
      addMinute(db, FIXTURE_DS, 'FIXH', t, { bid: 9990, ask: 10_000, trades: { o: 9990, h: 9990, l: 9990, c: 9990, v: 100, n: 1 } });
    }
    // TEST FIXTURE: the 10:00 minute is not complete at 10:00 and must never price anything.
    addMinute(db, FIXTURE_DS, 'FIXH', at(10, 0), { bid: 99_000, ask: 100_000, trades: { o: 99_000, h: 99_000, l: 99_000, c: 99_000, v: 100, n: 1 } });

    // An open market buy on FIXH: the gate reserves max(as-of ask 10,000 u + 50 bps -> 10,100 u, its submission estimate).
    const fixh = submitOrder(db, s.ctx(at(9, 59)), { portfolio_id: 'sandbox', sym: 'FIXH', side: 'buy', type: 'market', qty: 100, actor: 'human' });
    assert.equal(fixh.ok, true, JSON.stringify(fixh.errors));
    const g = buildGateContext(db, { session_id, ds: FIXTURE_DS, clock: CLOCK, intent: humanIntent(), confirm: true });
    assert.equal(g.session_id, session_id);
    assert.deepEqual([g.openOrderQuotes.FIXH.ask, g.openOrderQuotes.FIXH.source.minuteRowT], [10_000, at(9, 59)], 'as-of quote, never the incomplete 10:00 minute');
    assert.equal(g.openOrders[0].meta.submitEstimate.priceU, 10_100);
    const r = evaluate(humanIntent(), g);
    assert.equal(r.decision, 'ACCEPTED', JSON.stringify(r.reasons));
    assert.match(check(r, 'cash_sufficient').detail, /reserved \$101\.0000 for 1 open buy/);

    // A modify of that order sees the full stored row (limit/stop/meta/agent) and is not counted against itself.
    const mod = humanIntent({ action: 'modify', order_type: 'market', target_order_id: fixh.order.id, qty: 100, instrument: { kind: 'equity', sym: 'FIXH' }, quote_ts: CLOCK - 30_000 });
    const gm = buildGateContext(db, { session_id, ds: FIXTURE_DS, clock: CLOCK, intent: mod, confirm: true });
    assert.deepEqual([gm.targetOrder.id, gm.targetOrder.session_id, gm.targetOrder.kind, gm.targetOrder.type, gm.targetOrder.agent_id, gm.targetOrder.limit_px],
      [fixh.order.id, session_id, 'equity', 'market', null, null]);
    assert.equal(gm.targetOrder.meta.submitEstimate.priceU, 10_100);
    const rm = evaluate(mod, gm);
    assert.equal(check(rm, 'target_order_matches').pass, true, check(rm, 'target_order_matches').detail);
    assert.match(check(rm, 'cash_sufficient').detail, /reserved \$0\.0000 for 0 open buy/);
    denies(evaluate({ ...mod, instrument: { kind: 'equity', sym: SYM } }, buildGateContext(db, { session_id, ds: FIXTURE_DS, clock: CLOCK, intent: { ...mod, instrument: { kind: 'equity', sym: SYM } }, confirm: true })),
      'target_order_matches', 'TARGET_ORDER_MISMATCH');

    // Issue type comes from the symbol only: a (post-dated) directory row calling FIXG a warrant changes nothing.
    db.prepare(`INSERT INTO ref_symbols (ds, sym, name, exchange, market_category, financial_status, test_issue, etf, round_lot, file_creation_time)
      VALUES ('test-fixture-symdir', ?, ?, 'Q', 'S', 'N', 0, 0, 100, NULL)`).run(SYM, `${FIXTURE_LABEL} Corp - Warrants`);
    assert.equal(check(evaluate(humanIntent(), buildGateContext(db, { session_id, ds: FIXTURE_DS, clock: CLOCK, intent: humanIntent(), confirm: true })), 'symbol_allowed').pass, true);

    // Default evidence resolver: a stored IEX minute (knowable at t + 60 s), a stored evidence row, and an evidence row
    // stamped knowable before its dataset was published (resolved at the publication time). Unknown refs stay unresolved.
    db.prepare(`INSERT INTO datasets (id, kind, provider, trade_date, published_at, ingested_at, status) VALUES ('test-fixture-filings', 'filings', ?, NULL, ?, ?, 'complete')`)
      .run(FIXTURE_LABEL, CLOCK + 5 * MINUTE, Date.now());
    const ev = db.prepare(`INSERT INTO evidence (id, sym, kind, title, body_json, provider, ds, event_ts, knowable_ts, ingested_ts, created_wall)
      VALUES (?, ?, 'test_fixture', ?, '{}', ?, ?, ?, ?, ?, ?)`);
    ev.run('ev_fixture_ok', SYM, FIXTURE_LABEL, FIXTURE_LABEL, null, CLOCK - MINUTE, CLOCK - MINUTE, Date.now(), Date.now());
    ev.run('ev_fixture_postdated', SYM, FIXTURE_LABEL, FIXTURE_LABEL, 'test-fixture-filings', CLOCK - MINUTE, CLOCK - MINUTE, Date.now(), Date.now());
    const m1Ok = `iex-m1:${FIXTURE_DS}:${SYM}:${at(9, 58)}`;
    const m1Missing = `iex-m1:${FIXTURE_DS}:${SYM}:${at(9, 40)}`;
    const m1Incomplete = `iex-m1:${FIXTURE_DS}:FIXH:${at(10, 0)}`;
    const idx = resolveEvidenceRefs(db, [m1Ok, m1Missing, m1Incomplete, 'ev_fixture_ok', 'ev_fixture_postdated', 'ev_fixture_missing']);
    assert.deepEqual(Object.fromEntries(idx), {
      [m1Ok]: at(9, 59), [m1Incomplete]: at(10, 1), ev_fixture_ok: CLOCK - MINUTE, ev_fixture_postdated: CLOCK + 5 * MINUTE,
    });
    addAgent(db, { id: 'agent-fixture', portfolio_id: 'pragmatist-micro', lens: 'pragmatist', segment: 'micro', state: 'RUNNING' });
    const gate = (it) => evaluate(it, buildGateContext(db, { session_id, ds: FIXTURE_DS, clock: CLOCK, intent: it }));
    const model = (refs) => agentIntent({ source: 'model', evidence_refs: refs });
    assert.equal(gate(model([m1Ok, 'ev_fixture_ok'])).decision, 'ACCEPTED', JSON.stringify(gate(model([m1Ok, 'ev_fixture_ok'])).reasons));
    denies(gate(model([m1Ok, m1Missing])), 'evidence_not_future', 'EVIDENCE_UNRESOLVED');
    denies(gate(model(['ev_fixture_postdated'])), 'evidence_not_future', 'EVIDENCE_FROM_FUTURE');
    denies(gate(model([m1Incomplete])), 'evidence_not_future', 'EVIDENCE_FROM_FUTURE');
    // A caller-supplied index (runner / API helper) is merged, never trusted over the gate: the later knowable time wins.
    const lenient = new Map([['ev_fixture_postdated', CLOCK - MINUTE], ['caller-only-ref', CLOCK - MINUTE]]);
    const gl = buildGateContext(db, { session_id, ds: FIXTURE_DS, clock: CLOCK, intent: model(['ev_fixture_postdated']), evidenceIndex: lenient });
    assert.equal(gl.evidenceIndex.get('ev_fixture_postdated'), CLOCK + 5 * MINUTE);
    denies(evaluate(model(['ev_fixture_postdated']), gl), 'evidence_not_future', 'EVIDENCE_FROM_FUTURE');
    // A ref only the caller resolves is never counted as resolved (agents: EVIDENCE_UNRESOLVED) — e.g. a runner-style index
    // mapping an iex-m1 minute that is not stored to t + 60 s.
    const gc = buildGateContext(db, { session_id, ds: FIXTURE_DS, clock: CLOCK, intent: model(['caller-only-ref']), evidenceIndex: lenient });
    assert.equal(gc.evidenceIndex.has('caller-only-ref'), false, 'a ref only the caller resolves is not resolved');
    assert.equal(gc.callerOnlyEvidence.get('caller-only-ref'), CLOCK - MINUTE);
    denies(evaluate(model(['caller-only-ref']), gc), 'evidence_not_future', 'EVIDENCE_UNRESOLVED');
    const runnerStyle = new Map([[m1Missing, at(9, 41)]]);
    const gmiss = buildGateContext(db, { session_id, ds: FIXTURE_DS, clock: CLOCK, intent: agentIntent({ action: "close", side: "sell", evidence_refs: [m1Missing] }), evidenceIndex: runnerStyle });
    denies(evaluate(agentIntent({ action: 'close', side: 'sell', evidence_refs: [m1Missing] }), gmiss), 'evidence_not_future', 'EVIDENCE_UNRESOLVED');
    // ...but a caller-known time after the clock still denies (a human citing a minute that is not stored yet).
    const future = new Map([['caller-future-ref', CLOCK + MINUTE]]);
    const human = humanIntent({ evidence_refs: ['caller-future-ref'] });
    denies(evaluate(human, buildGateContext(db, { session_id, ds: FIXTURE_DS, clock: CLOCK, intent: human, evidenceIndex: future })), 'evidence_not_future', 'EVIDENCE_FROM_FUTURE');

    // Stored strategy facts: the handwritten preset's at-entry stop is informational; the same stop under another strategy is denied.
    const hw = PRESETS['handwritten-notes-example'];
    addAgent(db, { id: 'agent-fixture', portfolio_id: 'pragmatist-micro', lens: 'pragmatist', segment: 'micro', state: 'RUNNING', strategy: hw });
    const hwIntent = agentIntent({ strategy_id: hw.id, attach: { stop_loss_px_u: 5000, take_profit_px_u: 12_500 }, evidence_refs: [m1Ok] });
    const ghw = buildGateContext(db, { session_id, ds: FIXTURE_DS, clock: CLOCK, intent: hwIntent });
    assert.deepEqual(ghw.agent.strategy, { id: 'handwritten-notes-example', stopLossBasis: 'at_entry_ref',
      ambiguityIds: ['take-profit-250', 'budget-50-vs-42-shares', 'stop-at-entry', 'stagnation-exit-reference', 'price-tier-vs-example', 'velocity-intent-volume'] });
    const rhw = evaluate(hwIntent, ghw);
    assert.equal(rhw.decision, 'ACCEPTED', JSON.stringify(rhw.reasons));
    assert.equal(check(rhw, 'protective_exit_required').informational, true);
    addAgent(db, { id: 'agent-fixture', portfolio_id: 'pragmatist-micro', lens: 'pragmatist', segment: 'micro', state: 'RUNNING', strategy: PRESETS['pragmatist-micro'] });
    denies(gate(hwIntent), 'protective_exit_required', 'STOP_AT_OR_ABOVE_BID');
  } finally { s.cleanup(); }
});

test('symbolInSegmentAsOf: membership uses only trades knowable at the clock', () => {
  const s = setupScenario('gate-segment');
  try {
    addMinute(s.db, FIXTURE_DS, SYM, at(10, 0), { bid: 4990, ask: 5000, trades: { o: 4990, h: 4990, l: 4990, c: 4990, v: 100, n: 1 } });
    assert.equal(symbolInSegmentAsOf(s.db, FIXTURE_DS, SYM, at(10, 0), 'micro'), false, 'the 10:00 minute is not complete at 10:00');
    assert.equal(symbolInSegmentAsOf(s.db, FIXTURE_DS, SYM, at(10, 1), 'micro'), true);
    assert.equal(symbolInSegmentAsOf(s.db, FIXTURE_DS, SYM, at(10, 1), 'large'), false);
  } finally { s.cleanup(); }
});

test('sandbox cost model is chosen per symbol and the gate estimate uses the same slippage as the fill', () => {
  const prev = process.env.VECTOR_LARGECAP_LIST;
  process.env.VECTOR_LARGECAP_LIST = 'FIXL'; // TEST FIXTURE configuration
  const s = setupScenario('gate-cost-segment');
  try {
    const { db, session_id } = s;
    for (let t = at(9, 58); t <= at(10, 0); t += MINUTE) {
      addMinute(db, FIXTURE_DS, 'FIXL', t, { bid: 199_900, ask: 200_000, trades: { o: 199_900, h: 199_900, l: 199_900, c: 199_900, v: 100, n: 1 } });
      addMinute(db, FIXTURE_DS, SYM, t, { bid: 4990, ask: 5000, trades: { o: 4990, h: 4990, l: 4990, c: 4990, v: 100, n: 1 } });
    }
    for (const [sym, seg, bps, qty] of [['FIXL', 'large', 5, 5], [SYM, 'micro', 50, 100]]) {
      const it = humanIntent({ instrument: { kind: 'equity', sym }, qty });
      const g = buildGateContext(db, { session_id, ds: FIXTURE_DS, clock: CLOCK, intent: it, confirm: true });
      assert.equal(g.costModel.segment, seg, sym);
      const r = evaluate(it, g);
      assert.equal(r.decision, 'ACCEPTED', JSON.stringify(r.reasons));
      assert.deepEqual([r.estimate.segment, r.estimate.slippageBps], [seg, bps]);
      const o = submitOrder(db, s.ctx(CLOCK), { portfolio_id: 'sandbox', sym, side: 'buy', type: 'market', qty, actor: 'human' });
      assert.equal(o.ok, true);
      processMinute(db, s.ctx(CLOCK + MINUTE), CLOCK);
      const f = journalRows(db, session_id).find((x) => x.type === 'FILL_ESTIMATED' && x.payload.order_id === o.order.id).payload;
      assert.deepEqual([f.assumptions.segment, f.assumptions.slippageBps], [seg, r.estimate.slippageBps], `${sym}: gate estimate and fill use the same cost model`);
      assert.equal(f.priceU, r.estimate.priceU, `${sym}: flat fixture minute => the fill price equals the as-of estimate`);
    }
  } finally {
    s.cleanup();
    if (prev === undefined) delete process.env.VECTOR_LARGECAP_LIST; else process.env.VECTOR_LARGECAP_LIST = prev;
  }
});
