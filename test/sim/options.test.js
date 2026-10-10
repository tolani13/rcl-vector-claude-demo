// TEST FIXTURE — NOT MARKET DATA. Paper long-put tests (docs/CONTRACTS.md section 2 "Options").
//
// Every contract, premium, quote and underlying price here is a synthetic test value: the underlying is the fixture
// symbol FIXP, the trade date is 2099-01-05 and the "verified provider" quotes are hand-written objects whose provider
// field is the fixture label. This build has NO options provider; these tests exercise the arithmetic and the engine
// path (order -> fill -> ledger multiplier 100 -> mark -> cash-value expiration) and the operational rejection
// NO_VERIFIED_OPTIONS_DATA. Writes receipts/journal-samples/fixture-sim-long-put-example.json.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  validateContract, premiumCost, expirationValue, longPutOutcome, validateOptionsQuote, checkOperationalOptionOrder,
  evaluateOptionOrder, optionsStatus, OPTIONS_STATUS, OPTIONS_MULTIPLIER,
} from '../../server/sim/options.js';
import { defaultCostModel } from '../../server/sim/fills.js';
import { submitOrder, processMinute, getOrder } from '../../server/sim/orders.js';
import { getPortfolio, getPosition, markToMarket, portfolioSummary, settleLongPutAtExpiration } from '../../server/sim/ledger.js';
import { evaluate, buildGateContext, journalDecision } from '../../server/policy/gate.js';
import { lastTradeAsOf } from '../../server/data/marketdata.js';
import { verifyChain } from '../../server/journal.js';
import { setupScenario, addMinute, at, FIXTURE_DS, FIXTURE_LABEL, MINUTE, journalRows, writeJournalSample } from './helpers/fixture.js';

// TEST FIXTURE contract: FIXP $4.00 put expiring on the fixture trade date (0DTE so the expiration can be replayed).
const CONTRACT = Object.freeze({ occ: 'FIXP990105P00004000', underlying: 'FIXP', expiry: '2099-01-05', strike: 40_000, right: 'P', multiplier: 100 });
const MICRO = defaultCostModel('micro'); // 50 bps slippage, commission 0 (labelled assumptions)

/** A hand-written "verified provider" quote — TEST FIXTURE, not an options market observation. */
function fixtureQuote(over = {}) {
  return {
    status: 'SUPPORTED_VERIFIED', provider: FIXTURE_LABEL, dataset: 'test-fixture-options-2099-01-05', source_url: null,
    contract: { ...CONTRACT }, bid: 4500, ask: 4700, bidSize: 20, askSize: 10, quoteTs: at(10, 0) - 30_000, ...over,
  };
}

/** Fixture provider: returns a quote only when it is knowable at asOf (quoteTs <= asOf). */
function fixtureProvider(over = {}, lagMs = 20_000) {
  const calls = [];
  return {
    calls,
    quoteAsOf(contract, asOf) {
      calls.push({ occ: contract?.occ, asOf });
      const q = fixtureQuote({ quoteTs: asOf - lagMs, ...over });
      return q.quoteTs <= asOf ? q : null;
    },
  };
}

const optOrder = (over = {}) => ({ id: 'ord_fixture', side: 'buy', type: 'market', qty: 3, filled_qty: 0, limit_px: null, instrument_id: CONTRACT.occ, kind: 'option', ...over });
const CLOCK = at(10, 1);

// ---------------------------------------------------------------------------------------------------------------
// Contract validation

test('validateContract: OCC round-trip for a long put; calls, bad multiplier/strike and mismatches are rejected', () => {
  const ok = validateContract({ ...CONTRACT });
  assert.equal(ok.ok, true, ok.errors.join('; '));
  assert.deepEqual(ok.contract, { ...CONTRACT });
  assert.equal(validateContract({ ...CONTRACT, occ: 'FIXP  990105P00004000' }).contract.occ, CONTRACT.occ, 'padded OCC normalized');
  const bad = (over, re) => {
    const r = validateContract({ ...CONTRACT, ...over });
    assert.equal(r.ok, false, JSON.stringify(over));
    assert.ok(r.errors.some((e) => re.test(e)), `${JSON.stringify(over)} -> ${r.errors.join('; ')}`);
  };
  bad({ right: 'C', occ: 'FIXP990105C00004000' }, /long puts only/);
  bad({ multiplier: 10 }, /multiplier must be 100/);
  bad({ strike: 40_005 }, /multiple of 10 u/);
  bad({ occ: 'FIXQ990105P00004000' }, /root does not match/);
  bad({ expiry: '2099-01-06' }, /expiry does not match/);
  bad({ strike: 50_000 }, /strike does not match/);
  bad({ expiry: '2099-02-30' }, /valid YYYY-MM-DD/);
  bad({ occ: 'not-an-occ' }, /OCC option symbol/);
  bad({ extra: 1 }, /unknown contract field: extra/);
  assert.equal(validateContract(null).ok, false);
  assert.equal(validateContract([]).ok, false);
});

// ---------------------------------------------------------------------------------------------------------------
// Arithmetic: premium x 100, capped loss, expiration value

test('premiumCost: premium x 100 x contracts + fees; max loss = everything paid', () => {
  const c = premiumCost({ premiumU: 4800, contracts: 3 });
  assert.deepEqual(c, { premiumU: 4800, contracts: 3, multiplier: 100, premiumTotalU: 1_440_000, feesU: 0, totalCostU: 1_440_000, maxLossU: 1_440_000 });
  const f = premiumCost({ premiumU: 4800, contracts: 3, feesU: 25 });
  assert.equal(f.totalCostU, 1_440_025);
  assert.equal(f.maxLossU, f.totalCostU);
  for (const bad of [{ premiumU: 0, contracts: 1 }, { premiumU: 1.5, contracts: 1 }, { premiumU: 4800, contracts: 0 }, { premiumU: 4800, contracts: 2.5 }, { premiumU: 4800, contracts: 1, feesU: -1 }]) {
    assert.throws(() => premiumCost(bad), RangeError, JSON.stringify(bad));
  }
});

test('expirationValue = max(0, K - S) x 100 x contracts (cash-value model)', () => {
  assert.equal(expirationValue(CONTRACT, 36_000, 3), 1_200_000, '(40,000 - 36,000) x 100 x 3');
  assert.equal(expirationValue(CONTRACT, 40_000, 3), 0, 'at the strike: worthless');
  assert.equal(expirationValue(CONTRACT, 50_000, 3), 0, 'above the strike: worthless, never negative');
  assert.equal(expirationValue(CONTRACT, 0, 1), 4_000_000, 'underlying at zero: full strike value');
  assert.throws(() => expirationValue(CONTRACT, -1), RangeError);
  assert.throws(() => expirationValue(CONTRACT, Number.NaN), RangeError);
});

test('longPutOutcome: loss is capped at the premium paid incl. fees; breakeven rounds against the holder', () => {
  const above = longPutOutcome(CONTRACT, { premiumU: 4800, contracts: 3 }, 45_000);
  assert.deepEqual([above.expirationValueU, above.pnlU, above.maxLossU, above.worstCasePnlU], [0, -1_440_000, 1_440_000, -1_440_000]);
  assert.equal(above.pnlU, above.worstCasePnlU, 'S >= K: the worst case is attained');
  const zero = longPutOutcome(CONTRACT, { premiumU: 4800, contracts: 3, feesU: 500 }, 0);
  assert.equal(zero.worstCasePnlU, -1_440_500);
  assert.ok(zero.pnlU >= zero.worstCasePnlU && zero.pnlU === 4_000_000 * 3 - 1_440_500, 'S = 0: P&L is above the worst case');
  assert.match(above.settlementModel, /CASH_VALUE_AT_EXPIRATION/);
  const itm = longPutOutcome(CONTRACT, { premiumU: 4800, contracts: 3 }, 36_000);
  assert.deepEqual([itm.expirationValueU, itm.pnlU], [1_200_000, -240_000]);
  const deep = longPutOutcome(CONTRACT, { premiumU: 4800, contracts: 3 }, 30_000);
  assert.deepEqual([deep.expirationValueU, deep.pnlU], [3_000_000, 1_560_000]);
  assert.equal(itm.breakevenUnderlyingU, 35_200, 'K - premium (no fees)');
  // With fees of 301 u over 300 share-equivalents the breakeven is lowered by ceil(301 / 300) = 2 u.
  const fee = longPutOutcome(CONTRACT, { premiumU: 4800, contracts: 3, feesU: 301 }, 35_198);
  assert.equal(fee.breakevenUnderlyingU, 35_198);
  assert.ok(fee.pnlU >= 0, 'at the breakeven the holder does not lose');
  assert.ok(longPutOutcome(CONTRACT, { premiumU: 4800, contracts: 3, feesU: 301 }, 35_199).pnlU < 0, 'one u above it the holder loses');
  for (let s = 0; s <= 80_000; s += 2_500) {
    const o = longPutOutcome(CONTRACT, { premiumU: 4800, contracts: 3, feesU: 301 }, s);
    assert.ok(o.pnlU >= -o.maxLossU, `S=${s}: loss never exceeds premium + fees`);
  }
});

// ---------------------------------------------------------------------------------------------------------------
// Verified-quote validation and the operational gate

test('validateOptionsQuote: only a verified, matching, two-sided, knowable and fresh quote passes', () => {
  const v = (q, o = {}) => validateOptionsQuote(q, { clock: CLOCK, occ: CONTRACT.occ, ...o });
  assert.equal(v(fixtureQuote()).ok, true);
  assert.equal(v(null).reason, OPTIONS_STATUS);
  assert.equal(v(fixtureQuote({ status: 'UNVERIFIED' })).reason, OPTIONS_STATUS);
  assert.equal(v(fixtureQuote({ provider: ' ' })).reason, 'OPTIONS_QUOTE_NO_PROVIDER');
  assert.equal(v(fixtureQuote({ contract: { ...CONTRACT, right: 'C' } })).reason, 'OPTIONS_QUOTE_CONTRACT_INVALID');
  assert.equal(v(fixtureQuote(), { occ: 'FIXP990105P00003000' }).reason, 'OPTIONS_QUOTE_CONTRACT_MISMATCH');
  assert.equal(v(fixtureQuote({ bid: 0 })).reason, 'OPTIONS_QUOTE_NOT_TWO_SIDED');
  assert.equal(v(fixtureQuote({ bid: 4800, ask: 4700 })).reason, 'OPTIONS_QUOTE_NOT_TWO_SIDED');
  assert.equal(v(fixtureQuote({ quoteTs: undefined })).reason, 'OPTIONS_QUOTE_NO_TIMESTAMP');
  assert.equal(v(fixtureQuote(), { clock: undefined }).reason, 'OPTIONS_QUOTE_NO_CLOCK');
  assert.equal(v(fixtureQuote({ quoteTs: CLOCK + 1 })).reason, 'OPTIONS_QUOTE_FROM_FUTURE', 'no look-ahead');
  assert.equal(v(fixtureQuote({ quoteTs: CLOCK - 5 * MINUTE - 1 })).reason, 'OPTIONS_QUOTE_STALE');
});

test('operational rejection: no verified provider quote -> NO_VERIFIED_OPTIONS_DATA (status, gate, engine)', () => {
  const st = optionsStatus();
  assert.equal(st.status, OPTIONS_STATUS);
  assert.equal(OPTIONS_STATUS, 'NO_VERIFIED_OPTIONS_DATA');
  assert.deepEqual(st.supported, { instrument: 'long put', short: false, calls: false, margin: false });
  assert.ok(st.notImplemented.some((x) => /options quote provider/.test(x)), 'states that no provider is wired');
  assert.ok(st.notImplemented.some((x) => /expiration settlement/.test(x)), 'states that automatic expiration is not wired');
  const spec = { contract: { ...CONTRACT }, sym: 'FIXP' };
  assert.equal(checkOperationalOptionOrder(spec, { clock: CLOCK }).code, OPTIONS_STATUS);
  assert.equal(checkOperationalOptionOrder({ ...spec, contract: { ...CONTRACT, multiplier: 10 } }, { clock: CLOCK, optionsQuote: fixtureQuote() }).code, 'OPTIONS_CONTRACT_INVALID');
  assert.equal(checkOperationalOptionOrder({ ...spec, sym: 'FIXQ' }, { clock: CLOCK, optionsQuote: fixtureQuote() }).code, 'OPTIONS_UNDERLYING_MISMATCH');
  assert.equal(checkOperationalOptionOrder(spec, { clock: CLOCK, optionsQuote: fixtureQuote({ quoteTs: CLOCK + 1 }) }).code, 'OPTIONS_QUOTE_FROM_FUTURE');
  assert.equal(checkOperationalOptionOrder(spec, { clock: CLOCK, optionsQuote: fixtureQuote() }).ok, true);
  // The fill function refuses without a verified quote too.
  assert.deepEqual([evaluateOptionOrder(optOrder(), null, MICRO, { clock: CLOCK, cashU: 1e8 }).action, evaluateOptionOrder(optOrder(), null, MICRO, { clock: CLOCK }).reason],
    ['unfillable', OPTIONS_STATUS]);
});

// ---------------------------------------------------------------------------------------------------------------
// evaluateOptionOrder (pure)

test('evaluateOptionOrder: buy pays ask + slippage rounded UP to a whole cent; sell takes bid - slippage rounded DOWN', () => {
  const b = evaluateOptionOrder(optOrder(), fixtureQuote(), MICRO, { clock: CLOCK, cashU: 100_000_000 });
  assert.equal(b.action, 'fill');
  assert.equal(b.priceU, 4800, 'ceil(4700 x 1.005) = 4724 -> next whole cent 4800');
  assert.deepEqual([b.qty, b.multiplier, b.feesU], [3, OPTIONS_MULTIPLIER, 0]);
  assert.deepEqual([b.assumptions.priceBasis, b.assumptions.basePriceU, b.assumptions.estimated, b.assumptions.notExchangeExecution], ['VERIFIED_PROVIDER_ASK', 4700, true, true]);
  assert.match(b.assumptions.settlementModel, /exercise\/assignment not modelled/);
  assert.equal(b.observed.provider, FIXTURE_LABEL);
  const s = evaluateOptionOrder(optOrder({ side: 'sell', qty: 2 }), fixtureQuote(), MICRO, { clock: CLOCK, positionQty: 3 });
  assert.equal(s.priceU, 4400, 'floor(4500 x 0.995) = 4477 -> whole cent down 4400');
  assert.equal(s.qty, 2);
  assert.equal(s.feesU, 25, 'SEC fee ceil(4400 x 2 x 100 x 27.8 / 1e6) = ceil(24.464); no TAF on options in this model');
});

test('evaluateOptionOrder: limit, displayed size, cash (x100), spend cap and position caps', () => {
  const ctx = { clock: CLOCK, cashU: 100_000_000 };
  assert.deepEqual(evaluateOptionOrder(optOrder({ type: 'limit', limit_px: 4600 }), fixtureQuote(), MICRO, ctx), { action: 'none', note: 'LIMIT_NOT_REACHED' });
  assert.equal(evaluateOptionOrder(optOrder({ type: 'limit', limit_px: 4750 }), fixtureQuote(), MICRO, ctx).priceU, 4750, 'limit clamps the slipped price');
  assert.equal(evaluateOptionOrder(optOrder({ type: 'limit', limit_px: undefined }), fixtureQuote(), MICRO, ctx).reason, 'LIMIT_PRICE_INVALID');
  assert.deepEqual(evaluateOptionOrder(optOrder({ side: 'sell', type: 'limit', limit_px: 4600 }), fixtureQuote(), MICRO, { ...ctx, positionQty: 3 }), { action: 'none', note: 'LIMIT_NOT_REACHED' });
  assert.equal(evaluateOptionOrder(optOrder({ qty: 15 }), fixtureQuote(), MICRO, ctx).qty, 10, 'capped at the displayed ask contracts');
  assert.equal(evaluateOptionOrder(optOrder({ qty: 15, filled_qty: 14 }), fixtureQuote(), MICRO, ctx).qty, 1, 'only the remainder');
  assert.equal(evaluateOptionOrder(optOrder(), fixtureQuote(), MICRO, { clock: CLOCK, cashU: 1_000_000 }).qty, 2, 'floor(1,000,000 / (4800 x 100))');
  assert.equal(evaluateOptionOrder(optOrder(), fixtureQuote(), MICRO, { clock: CLOCK, cashU: 400_000 }).reason, 'INSUFFICIENT_CASH_AT_ESTIMATED_PRICE');
  const cap = evaluateOptionOrder(optOrder(), fixtureQuote(), MICRO, { ...ctx, maxSpendU: 500_000 });
  assert.deepEqual([cap.qty, cap.assumptions.spendCap.maxSpendU], [1, 500_000]);
  const capped = evaluateOptionOrder(optOrder(), fixtureQuote(), MICRO, { ...ctx, maxSpendU: 400_000 });
  assert.deepEqual([capped.reason, capped.spendCapReached], ['SPEND_CAP_AT_ESTIMATED_PRICE', true]);
  assert.equal(evaluateOptionOrder(optOrder({ side: 'sell', qty: 5 }), fixtureQuote(), MICRO, { clock: CLOCK, positionQty: 2 }).qty, 2, 'sell capped at contracts held');
  assert.equal(evaluateOptionOrder(optOrder({ side: 'sell' }), fixtureQuote(), MICRO, { clock: CLOCK, positionQty: 0 }).reason, 'NO_POSITION_HELD');
  assert.equal(evaluateOptionOrder(optOrder(), fixtureQuote({ askSize: 0 }), MICRO, ctx).reason, 'ZERO_DISPLAYED_SIZE');
  assert.equal(evaluateOptionOrder(optOrder({ type: 'stop' }), fixtureQuote(), MICRO, ctx).reason, 'UNSUPPORTED_OPTION_ORDER_TYPE:stop');
  assert.deepEqual(evaluateOptionOrder(optOrder({ filled_qty: 3 }), fixtureQuote(), MICRO, ctx), { action: 'none', note: 'NOTHING_REMAINING' });
});

test('evaluateOptionOrder: quotes rejected by validateOptionsQuote are unfillable with the matching reason', () => {
  const r = (q) => evaluateOptionOrder(optOrder(), q, MICRO, { clock: CLOCK, cashU: 100_000_000 });
  assert.equal(r(fixtureQuote({ quoteTs: CLOCK + 1 })).reason, 'OPTIONS_QUOTE_FROM_FUTURE');
  assert.equal(r(fixtureQuote({ quoteTs: CLOCK - 6 * MINUTE })).reason, 'OPTIONS_QUOTE_STALE');
  assert.equal(r(fixtureQuote({ ask: 0 })).reason, 'OPTIONS_QUOTE_NOT_TWO_SIDED');
  assert.equal(r(fixtureQuote({ contract: { ...CONTRACT, occ: 'FIXP990105P00003000', strike: 30_000 } })).reason, 'OPTIONS_QUOTE_CONTRACT_MISMATCH');
  assert.equal(r(fixtureQuote({ status: 'DELAYED' })).reason, OPTIONS_STATUS);
});

// ---------------------------------------------------------------------------------------------------------------
// Full paper lifecycle on fixture data: rejection, buy-to-open, mark, expiration value.

/** TEST FIXTURE underlying tape for FIXP: ~$3.50 in the morning, last print $3.60 at 15:59. */
function seedUnderlying(db) {
  for (let t = at(9, 58); t <= at(10, 5); t += MINUTE) {
    addMinute(db, FIXTURE_DS, 'FIXP', t, { bid: 34_990, ask: 35_010, trades: { o: 35_000, h: 35_000, l: 35_000, c: 35_000, v: 500, n: 2 } });
  }
  addMinute(db, FIXTURE_DS, 'FIXP', at(11, 59), { bid: 33_990, ask: 34_010, trades: { o: 34_000, h: 34_000, l: 34_000, c: 34_000, v: 500, n: 2 } });
  addMinute(db, FIXTURE_DS, 'FIXP', at(15, 59), { bid: 35_990, ask: 36_010, trades: { o: 36_000, h: 36_000, l: 36_000, c: 36_000, v: 500, n: 2 } });
}

function optionIntent(clock, over = {}) {
  return {
    id: `int_fixture_${clock}`, source: 'human', agent_id: null, portfolio_id: 'sandbox', strategy_id: null, action: 'open',
    instrument: { kind: 'option', sym: 'FIXP', contract: { ...CONTRACT } }, side: 'buy', qty: 3, order_type: 'market',
    rationale: `${FIXTURE_LABEL}: long-put lifecycle example`, evidence_refs: [], quote_ts: clock - 30_000, created_ts: clock, expires_ts: clock + MINUTE, ...over,
  };
}

const optionSpec = (over = {}) => ({ portfolio_id: 'sandbox', sym: 'FIXP', kind: 'option', contract: { ...CONTRACT }, side: 'buy', type: 'market', qty: 3, actor: 'human', ...over });

test('long-put lifecycle (TEST FIXTURE): rejected without a verified quote, buy-to-open x100, mark at the bid, cash-value expiration', () => {
  const s = setupScenario('long-put');
  try {
    const { db, session_id } = s;
    seedUnderlying(db);
    const rows = (type) => journalRows(db, session_id).filter((r) => r.type === type);

    // 1) Operational rejection: no verified provider quote.
    const gNo = evaluate(optionIntent(at(10, 0)), buildGateContext(db, { session_id, ds: FIXTURE_DS, clock: at(10, 0), intent: optionIntent(at(10, 0)), confirm: true }));
    assert.equal(gNo.decision, 'DENIED');
    assert.ok(gNo.reasons.some((x) => x.code === OPTIONS_STATUS));
    assert.equal(gNo.checks.find((c) => c.rule === 'instrument_allowed').code, OPTIONS_STATUS);
    journalDecision(db, { session_id, ts_sim: at(10, 0), intent: optionIntent(at(10, 0)), result: gNo });
    const rej = submitOrder(db, s.ctx(at(10, 0)), optionSpec());
    assert.deepEqual([rej.ok, rej.code, rej.order.status], [false, OPTIONS_STATUS, 'rejected']);
    assert.equal(rows('ORDER_REJECTED')[0].payload.quote.status, OPTIONS_STATUS);

    // 2) With a (fixture) verified quote the gate accepts and the engine accepts the buy-to-open.
    const q0 = fixtureQuote();
    const gOk = evaluate(optionIntent(at(10, 0)), buildGateContext(db, { session_id, ds: FIXTURE_DS, clock: at(10, 0), intent: optionIntent(at(10, 0)), confirm: true, optionsQuote: q0 }));
    assert.equal(gOk.decision, 'ACCEPTED', JSON.stringify(gOk.reasons));
    assert.deepEqual([gOk.estimate.priceU, gOk.estimate.qty, gOk.estimate.multiplier, gOk.estimate.costU], [4800, 3, 100, 1_440_000]);
    journalDecision(db, { session_id, ts_sim: at(10, 0), intent: optionIntent(at(10, 0)), result: gOk });
    const r = submitOrder(db, s.ctx(at(10, 0)), optionSpec({ optionsQuote: q0 }));
    assert.equal(r.ok, true, JSON.stringify(r.errors));
    assert.deepEqual([r.order.instrument_id, r.order.kind, r.order.status], [CONTRACT.occ, 'option', 'working']);
    assert.deepEqual(JSON.parse(r.order.meta_json).contract, { ...CONTRACT });

    // 3) The replay engine passes no optionsProvider: the order is withheld, never filled from nothing.
    const m0 = processMinute(db, s.ctx(at(10, 1)), at(10, 0));
    assert.deepEqual(m0.withheld, [{ order_id: r.order.id, reason: OPTIONS_STATUS }]);
    assert.equal(m0.fills.length, 0);

    // 4) With a fixture provider the fill goes through the ledger with multiplier 100.
    const provider = fixtureProvider();
    const m1 = processMinute(db, s.ctx(at(10, 2), { optionsProvider: provider }), at(10, 1));
    assert.equal(m1.fills.length, 1);
    assert.deepEqual(provider.calls, [{ occ: CONTRACT.occ, asOf: at(10, 2) }], 'quote requested as of the end of the evaluated minute');
    const fill = rows('FILL_ESTIMATED')[0].payload;
    assert.deepEqual([fill.qty, fill.priceU, fill.multiplier, fill.grossU, fill.feesU, fill.kind, fill.instrument_id], [3, 4800, 100, 1_440_000, 0, 'option', CONTRACT.occ]);
    assert.deepEqual([fill.cashBeforeU, fill.cashAfterU], [100_000_000, 98_560_000]);
    assert.equal(getOrder(db, r.order.id).status, 'filled');
    const pos = getPosition(db, session_id, 'sandbox', CONTRACT.occ);
    assert.deepEqual([pos.kind, pos.qty, pos.multiplier, pos.cost_basis], ['option', 3, 100, 1_440_000]);
    const cost = premiumCost({ premiumU: fill.priceU, contracts: fill.qty, feesU: fill.feesU });
    assert.equal(cost.totalCostU, 100_000_000 - getPortfolio(db, session_id, 'sandbox').cash, 'ledger debit = premium x 100 x contracts + fees');

    // 5) Mark: at the verified provider bid; without a provider the position is UNMARKED (never invented).
    const markProvider = fixtureProvider({ bid: 6000, ask: 6200 }, 10_000);
    const mark = markToMarket(db, FIXTURE_DS, session_id, 'sandbox', at(12, 0), { optionsProvider: markProvider });
    const mp = mark.positions[0];
    assert.deepEqual([mp.markU, mp.markBasis, mp.valueU, mp.unrealizedU, mp.status], [6000, 'VERIFIED_OPTIONS_BID', 1_800_000, 360_000, 'MARKED']);
    const unmarked = markToMarket(db, FIXTURE_DS, session_id, 'sandbox', at(12, 0)).positions[0];
    assert.deepEqual([unmarked.markBasis, unmarked.status, unmarked.valueU], ['UNMARKED', OPTIONS_STATUS, null]);
    const sum = portfolioSummary(db, FIXTURE_DS, session_id, 'sandbox', at(12, 0), { optionsProvider: markProvider });
    assert.equal(sum.equityU, 98_560_000 + 1_800_000);
    assert.equal(portfolioSummary(db, FIXTURE_DS, session_id, 'sandbox', at(12, 0)).equityBasis, 'CONSERVATIVE_UNMARKED_POSITIONS_AT_ZERO');

    // 6) Expiration (cash value) at 16:00 ET on the expiry date, from the last underlying print knowable at the clock.
    const early = settleLongPutAtExpiration(db, { session_id, portfolio_id: 'sandbox', instrument_id: CONTRACT.occ, clock: at(15, 59), underlying: { priceU: 36_000, knowableTs: at(15, 59), basis: 'TEST' } });
    assert.equal(early.code, 'OPTION_NOT_EXPIRED');
    const future = settleLongPutAtExpiration(db, { session_id, portfolio_id: 'sandbox', instrument_id: CONTRACT.occ, clock: at(16, 0), underlying: { priceU: 36_000, knowableTs: at(16, 1), basis: 'TEST' } });
    assert.equal(future.code, 'UNDERLYING_FROM_FUTURE', 'no look-ahead for the settlement price');
    const lt = lastTradeAsOf(db, FIXTURE_DS, 'FIXP', at(16, 0));
    assert.deepEqual([lt.priceU, lt.knowableAt], [36_000, at(16, 0)]);
    const settled = settleLongPutAtExpiration(db, {
      session_id, portfolio_id: 'sandbox', instrument_id: CONTRACT.occ, clock: at(16, 0),
      underlying: { priceU: lt.priceU, knowableTs: lt.knowableAt, basis: 'LAST_IEX_TRADE_AS_OF (TEST FIXTURE)', source: { ds: FIXTURE_DS, sym: 'FIXP', minuteT: lt.minuteT } },
    });
    assert.equal(settled.ok, true, JSON.stringify(settled));
    const outcome = longPutOutcome(CONTRACT, { premiumU: 4800, contracts: 3 }, 36_000);
    assert.deepEqual([settled.expirationValueU, settled.realizedDeltaU, settled.cashU], [outcome.expirationValueU, outcome.pnlU, 99_760_000]);
    assert.equal(getPosition(db, session_id, 'sandbox', CONTRACT.occ), null, 'position closed');
    const pf = getPortfolio(db, session_id, 'sandbox');
    assert.deepEqual([pf.cash, pf.realized_pnl], [99_760_000, -240_000]);
    const exp = rows('OPTION_EXPIRED')[0];
    assert.equal(exp.actor, 'engine');
    assert.deepEqual([exp.payload.intrinsicPerShareU, exp.payload.expirationValueU, exp.payload.contracts], [4000, 1_200_000, 3]);
    assert.match(exp.payload.settlementModel, /CASH_VALUE_AT_EXPIRATION/);
    assert.equal(settleLongPutAtExpiration(db, { session_id, portfolio_id: 'sandbox', instrument_id: CONTRACT.occ, clock: at(16, 0), underlying: { priceU: 36_000, knowableTs: at(16, 0) } }).code, 'NO_OPTION_POSITION');
    assert.ok(verifyChain(db).ok);

    writeJournalSample(db, 'long-put-example', {
      session_id,
      covers: ['operational rejection NO_VERIFIED_OPTIONS_DATA (gate + engine + withheld fill)', 'buy-to-open long put (premium x 100)', 'mark at a verified-provider bid', 'expiration value (cash-value model)'],
      description: `${FIXTURE_LABEL}. A paper long-put lifecycle on a synthetic contract (FIXP 2099-01-05 $4.00 put). Without a verified options provider quote the gate DENIES (NO_VERIFIED_OPTIONS_DATA), the engine REJECTS the order, and an accepted order is WITHHELD when no provider is wired (as in this build's replay). With a hand-written fixture "verified" quote the buy-to-open fills 3 contracts at $0.48 (ask $0.47 + 50 bps, rounded up to a cent) for $144.00 (premium x 100 x 3), the position is marked at a fixture bid, and at 16:00 ET the cash value max(0, K - S) x 100 x 3 = $120.00 is credited (S = last fixture print $3.60): realized P&L -$24.00, never worse than the premium paid.`,
      extra: {
        contract: { ...CONTRACT },
        fixtureQuotes: { atEntry: q0, atMark: markProvider.quoteAsOf(CONTRACT, at(12, 0)) },
        arithmetic: {
          premiumCost: cost,
          outcomeAtSettlementPrice: outcome,
          outcomeIfUnderlyingAboveStrike: longPutOutcome(CONTRACT, { premiumU: 4800, contracts: 3 }, 45_000),
        },
        mark: { asOf: at(12, 0), position: mp, withoutProvider: unmarked },
        settlement: settled,
        optionsStatusInThisBuild: optionsStatus(),
      },
    });
  } finally { s.cleanup(); }
});

test('long put expiring above the strike: the loss equals the premium paid (capped), nothing more', () => {
  const s = setupScenario('long-put-otm');
  try {
    const { db, session_id } = s;
    seedUnderlying(db);
    const r = submitOrder(db, s.ctx(at(10, 0)), optionSpec({ qty: 2, optionsQuote: fixtureQuote() }));
    assert.equal(r.ok, true);
    processMinute(db, s.ctx(at(10, 1), { optionsProvider: fixtureProvider() }), at(10, 0));
    assert.equal(getPosition(db, session_id, 'sandbox', CONTRACT.occ).qty, 2);
    const paid = 100_000_000 - getPortfolio(db, session_id, 'sandbox').cash;
    assert.equal(paid, 960_000, '2 x 4800 x 100');
    const out = settleLongPutAtExpiration(db, { session_id, portfolio_id: 'sandbox', instrument_id: CONTRACT.occ, clock: at(16, 0), underlying: { priceU: 45_000, knowableTs: at(16, 0), basis: 'TEST FIXTURE' } });
    assert.deepEqual([out.ok, out.expirationValueU, out.realizedDeltaU], [true, 0, -paid]);
    assert.equal(getPortfolio(db, session_id, 'sandbox').cash, 100_000_000 - paid);
    assert.ok(verifyChain(db).ok);
  } finally { s.cleanup(); }
});
