// TEST FIXTURE — NOT MARKET DATA. Pure unit tests for the fill model iex-conservative-minute-v1.
// Minute objects below are hand-written synthetic values shaped like marketdata.fillMinute() output.
import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateOrder, defaultCostModel, computeFees, slippedPrice, costSegmentFor, FILL_MODEL_ID, OMITTED_EFFECTS } from '../../server/sim/fills.js';
import { isValidTick } from '../../server/util/money.js';
import { largeCapList } from '../../server/data/universe.js';

const T = 4_070_000_000_000; // synthetic minute start (ms), minute-aligned
const micro = defaultCostModel('micro');
const large = defaultCostModel('large');
const RICH = { cashU: 1_000_000_000, positionQty: 0, ds: 'fixture' };

function minute(over = {}) {
  return {
    sym: 'FIXA', t: T, hasRow: true,
    trades: { o: 5100, h: 5200, l: 5050, c: 5200, v: 4000, n: 12, vwap: 5150 },
    startQuote: { bid: 5000, ask: 5100, bidSize: 800, askSize: 300, quoteTs: T - 30_000 },
    endQuote: { bid: 5100, ask: 5200, bidSize: 900, askSize: 400, quoteTs: T + 40_000 },
    minBid: 5000, maxBid: 5100, minAsk: 5100, maxAsk: 5200,
    halted: false, unavailable: false,
    ...over,
  };
}
const order = (o) => ({ id: 'o1', side: 'buy', type: 'market', qty: 500, filled_qty: 0, limit_px: null, stop_px: null, status: 'working', triggered_ts: null, kind: 'equity', ...o });

test('defaultCostModel matches the contract values', () => {
  assert.equal(micro.priceBasis, 'WORST_IN_MINUTE');
  assert.equal(micro.slippageBps, 50);
  assert.equal(large.slippageBps, 5);
  assert.equal(micro.maxQuoteAgeMs, 300_000);
  assert.equal(large.maxQuoteAgeMs, 60_000);
  assert.equal(micro.maxSpreadBps, 1500);
  assert.equal(large.maxSpreadBps, 50);
  assert.equal(micro.secFeeRatePerMillionUsd, 27.8);
  assert.equal(micro.tafPerShareU, 1.66);
  assert.equal(micro.tafCapU, 83_000);
  assert.equal(micro.commissionPerOrderU, 0);
  assert.equal(micro.displayedSizeCap, true);
  assert.equal(defaultCostModel(null).slippageBps, 50, 'sandbox/unknown segment gets the conservative micro slippage');
});

test('market BUY fills at worst ask in minute + slippage, capped at displayed ask size', () => {
  const r = evaluateOrder(order({}), minute(), micro, RICH);
  assert.equal(r.action, 'fill');
  // worst ask 5200 u; +50 bps rounded up = 5226 u (< $1 so 1 u ticks)
  assert.equal(r.priceU, 5226);
  assert.equal(r.qty, 300, 'capped at startQuote.askSize');
  assert.equal(r.feesU, 0, 'buys pay commission only (0 by default)');
  assert.equal(r.assumptions.model, FILL_MODEL_ID);
  assert.equal(r.assumptions.priceBasis, 'WORST_IN_MINUTE');
  assert.equal(r.assumptions.basePriceU, 5200);
  assert.equal(r.assumptions.displayedSizeUsed, 300);
  assert.deepEqual(r.assumptions.qtyLimitedBy, ['DISPLAYED_SIZE']);
  assert.deepEqual(r.assumptions.omitted, [...OMITTED_EFFECTS]);
  assert.equal(r.assumptions.estimated, true);
  assert.equal(r.observed.maxAsk, 5200);
  assert.equal(r.observed.minuteT, T);
  assert.deepEqual(r.observed.startQuote, minute().startQuote);
});

test('prices >= $1 are rounded to a valid penny tick against the trader (Reg NMS 612)', () => {
  const m = minute({
    startQuote: { bid: 12_000, ask: 12_100, bidSize: 500, askSize: 500, quoteTs: T - 1000 },
    endQuote: { bid: 12_100, ask: 12_150, bidSize: 500, askSize: 500, quoteTs: T + 1000 },
    minBid: 12_000, maxBid: 12_100, minAsk: 12_100, maxAsk: 12_150,
  });
  const buy = evaluateOrder(order({ qty: 10 }), m, micro, RICH);
  assert.equal(buy.priceU, 12_300, '$1.215 +50bps = $1.2211 -> $1.23');
  assert.ok(isValidTick(buy.priceU));
  const sell = evaluateOrder(order({ side: 'sell', qty: 10 }), m, micro, { ...RICH, positionQty: 10 });
  assert.equal(sell.priceU, 11_900, '$1.20 -50bps = $1.194 -> $1.19');
  assert.ok(isValidTick(sell.priceU));
});

test('affordability: buy qty reduced to the largest affordable whole qty', () => {
  const r = evaluateOrder(order({}), minute(), micro, { cashU: 1_000_000, positionQty: 0 });
  assert.equal(r.action, 'fill');
  assert.equal(r.qty, 191, 'floor(1,000,000 / 5226)');
  assert.ok(r.qty * r.priceU + r.feesU <= 1_000_000);
  assert.equal(r.assumptions.affordabilityReduced, true);
  assert.ok(r.assumptions.qtyLimitedBy.includes('CASH_AT_ESTIMATED_PRICE'));
  const none = evaluateOrder(order({}), minute(), micro, { cashU: 5000, positionQty: 0 });
  assert.deepEqual([none.action, none.reason], ['unfillable', 'INSUFFICIENT_CASH_AT_ESTIMATED_PRICE']);
});

test('market SELL fills at worst bid - slippage; SEC fee and TAF rounded up', () => {
  const r = evaluateOrder(order({ side: 'sell', qty: 300 }), minute(), micro, { ...RICH, positionQty: 1000 });
  assert.equal(r.action, 'fill');
  assert.equal(r.priceU, 4975, 'floor(5000 * 0.995)');
  assert.equal(r.qty, 300);
  // notional 1,492,500 u x 27.8 / 1e6 = 41.49 -> 42 u ; TAF 300 x 1.66 = 498 u
  assert.equal(r.assumptions.fees.secFeeU, 42);
  assert.equal(r.assumptions.fees.tafU, 498);
  assert.equal(r.feesU, 540);
  // never sells more than held
  const capped = evaluateOrder(order({ side: 'sell', qty: 300 }), minute(), micro, { ...RICH, positionQty: 120 });
  assert.equal(capped.qty, 120);
  const noPos = evaluateOrder(order({ side: 'sell', qty: 300 }), minute(), micro, { ...RICH, positionQty: 0 });
  assert.deepEqual([noPos.action, noPos.reason], ['unfillable', 'NO_POSITION_HELD']);
});

test('fees: TAF cap, commission once per order, all components rounded up', () => {
  const f = computeFees('sell', 100_000, 5000, micro);
  assert.equal(f.tafU, 83_000, 'TAF capped at $8.30');
  const cm = { ...micro, commissionPerOrderU: 12_345.2 };
  assert.equal(computeFees('buy', 10, 5000, cm, { firstFill: true }).commissionU, 12_346);
  assert.equal(computeFees('buy', 10, 5000, cm, { firstFill: false }).commissionU, 0);
  assert.equal(computeFees('buy', 10, 5000, micro).secFeeU, 0, 'no SEC fee on buys');
  assert.equal(computeFees('sell', 1, 1, micro).secFeeU, 1, 'tiny fee still rounds up to 1 u');
});

test('unfillable: halted, unavailable, no two-sided quote, stale quote, zero displayed size, no start quote', () => {
  const o = order({});
  const cases = [
    [minute({ halted: true }), 'HALTED'],
    [minute({ unavailable: true }), 'UNAVAILABLE'],
    [minute({ minBid: null, maxBid: null }), 'NO_TWO_SIDED_QUOTE'],
    [minute({ endQuote: { bid: 0, ask: 5200, bidSize: 0, askSize: 100, quoteTs: T + 1000 } }), 'NO_TWO_SIDED_QUOTE'],
    [minute({ endQuote: { bid: 5100, ask: 5200, bidSize: 100, askSize: 100, quoteTs: T - 400_000 } }), 'STALE_QUOTE'],
    [minute({ startQuote: { bid: 5000, ask: 5100, bidSize: 800, askSize: 0, quoteTs: T - 1000 } }), 'ZERO_DISPLAYED_SIZE'],
    [minute({ startQuote: null }), 'NO_DISPLAYED_SIZE_AT_MINUTE_START'],
  ];
  for (const [m, reason] of cases) {
    const r = evaluateOrder(o, m, micro, RICH);
    assert.equal(r.action, 'unfillable', reason);
    assert.equal(r.reason, reason);
    assert.ok(r.observed, 'unfillable results carry the observed data for FILL_WITHHELD provenance');
    assert.equal(r.qty, undefined, 'never manufactures a fill');
  }
});

test('limit BUY: quote rule, strict trade-through at L, and no fill when trade equals L', () => {
  const quote = evaluateOrder(order({ type: 'limit', limit_px: 5200 }), minute({ maxAsk: 5180, minAsk: 5100 }), micro, RICH);
  assert.equal(quote.action, 'fill');
  assert.equal(quote.priceU, 5200, 'min(L, p(maxAsk)=5206)');
  assert.equal(quote.assumptions.rule, 'LIMIT_BUY_WORST_ASK_AT_OR_BELOW_LIMIT');

  const tt = evaluateOrder(order({ type: 'limit', limit_px: 5000, qty: 5000 }), minute({ trades: { o: 5050, h: 5100, l: 4990, c: 5050, v: 1200, n: 4 } }), micro, RICH);
  assert.equal(tt.action, 'fill');
  assert.equal(tt.priceU, 5000, 'trade-through fills exactly at L');
  assert.equal(tt.qty, 300, 'trade-through qty capped at min(startQuote askSize 300, minute IEX volume 1200)');
  assert.equal(tt.assumptions.sizeSource, 'TRADE_THROUGH');
  assert.deepEqual(tt.assumptions.qtyLimitedBy, ['TRADE_THROUGH_DISPLAYED_SIZE_PROXY']);
  assert.equal(tt.assumptions.minuteVolume, 1200);
  assert.equal(tt.assumptions.tradeThroughSizeProxy, 'min(startQuote displayed size on order side, minute IEX volume)');

  const touch = evaluateOrder(order({ type: 'limit', limit_px: 5000 }), minute({ trades: { o: 5050, h: 5100, l: 5000, c: 5050, v: 1200, n: 4 } }), micro, RICH);
  assert.deepEqual(touch, { action: 'none', note: 'LIMIT_NOT_REACHED' }, 'a trade AT the limit is not a trade-through');
});

test('limit SELL (take-profit): quote rule fills at max(L, p(minBid)); strict trade-through fills at L', () => {
  const m = minute({ startQuote: { bid: 6100, ask: 6200, bidSize: 700, askSize: 700, quoteTs: T - 1000 }, endQuote: { bid: 6100, ask: 6200, bidSize: 700, askSize: 700, quoteTs: T + 1000 }, minBid: 6050, maxBid: 6100, minAsk: 6150, maxAsk: 6200 });
  const r = evaluateOrder(order({ side: 'sell', type: 'limit', limit_px: 6000, qty: 500 }), m, micro, { ...RICH, positionQty: 500 });
  assert.equal(r.action, 'fill');
  assert.equal(r.priceU, 6019, 'max(6000, floor(6050 x 0.995) = 6019)');
  assert.equal(r.qty, 500);
  const tt = evaluateOrder(order({ side: 'sell', type: 'limit', limit_px: 6000, qty: 500 }), minute({ trades: { o: 5900, h: 6100, l: 5900, c: 6000, v: 300, n: 3 } }), micro, { ...RICH, positionQty: 500 });
  assert.equal(tt.priceU, 6000);
  assert.equal(tt.qty, 300, 'min(bidSize 800, minute volume 300)');
  assert.equal(tt.assumptions.sizeSource, 'TRADE_THROUGH');
  assert.deepEqual(tt.assumptions.qtyLimitedBy, ['TRADE_THROUGH_DISPLAYED_SIZE_PROXY']);
});

test('regression: a trade-through limit fill is never sized by the whole minute volume (tiny displayed size, huge volume)', () => {
  // TEST FIXTURE: 150,000-share limit buy @ 5000; the ask stays above L, one print at 4999; minute volume 200,000; displayed ask 100.
  const m = minute({
    trades: { o: 5100, h: 5150, l: 4999, c: 5100, v: 200_000, n: 50 },
    startQuote: { bid: 5050, ask: 5100, bidSize: 900, askSize: 100, quoteTs: T - 1000 },
    endQuote: { bid: 5050, ask: 5150, bidSize: 900, askSize: 100, quoteTs: T + 1000 },
    minBid: 5050, maxBid: 5050, minAsk: 5100, maxAsk: 5150,
  });
  const r = evaluateOrder(order({ type: 'limit', limit_px: 5000, qty: 150_000 }), m, micro, RICH);
  assert.equal(r.action, 'fill');
  assert.equal(r.priceU, 5000);
  assert.equal(r.qty, 100, 'capped at the displayed ask size, not the 200,000-share minute volume');
  assert.equal(r.assumptions.displayedSizeUsed, 100);
  // A take-profit on a single print above L does not sell the whole position when the displayed bid is small.
  const tpMin = minute({
    trades: { o: 5900, h: 6001, l: 5900, c: 5950, v: 50_000, n: 3 },
    startQuote: { bid: 5900, ask: 5950, bidSize: 200, askSize: 900, quoteTs: T - 1000 },
    endQuote: { bid: 5900, ask: 5950, bidSize: 200, askSize: 900, quoteTs: T + 1000 },
    minBid: 5900, maxBid: 5900, minAsk: 5950, maxAsk: 5950,
  });
  const tp = evaluateOrder(order({ side: 'sell', type: 'limit', limit_px: 6000, qty: 5000 }), tpMin, micro, { ...RICH, positionQty: 5000 });
  assert.equal(tp.action, 'fill');
  assert.equal(tp.qty, 200, 'take-profit capped at the displayed bid size');
  assert.equal(tp.priceU, 6000);
});

test('displayed size already consumed this minute is not reused (ctx.consumed)', () => {
  const r = evaluateOrder(order({ qty: 300 }), minute(), micro, { ...RICH, consumed: { DISPLAYED: 200 } });
  assert.equal(r.action, 'fill');
  assert.equal(r.qty, 100, 'askSize 300 - 200 already taken');
  assert.deepEqual(r.assumptions.qtyLimitedBy, ['DISPLAYED_SIZE_REMAINING']);
  assert.equal(r.assumptions.displayedSizeAtMinuteStart, 300);
  assert.equal(r.assumptions.consumedEarlierThisMinute, 200);
  const none = evaluateOrder(order({ qty: 300 }), minute(), micro, { ...RICH, consumed: { DISPLAYED: 300 } });
  assert.deepEqual([none.action, none.reason], ['unfillable', 'DISPLAYED_SIZE_CONSUMED_THIS_MINUTE']);
  // Trade-through consumption is tracked separately from displayed-quote consumption.
  const ttm = minute({ trades: { o: 5050, h: 5100, l: 4990, c: 5050, v: 1200, n: 4 } });
  const tt = evaluateOrder(order({ type: 'limit', limit_px: 5000, qty: 1000 }), ttm, micro, { ...RICH, consumed: { DISPLAYED: 300, TRADE_THROUGH: 300 } });
  assert.deepEqual([tt.action, tt.reason], ['unfillable', 'TRADE_THROUGH_SIZE_CONSUMED_THIS_MINUTE']);
});

test('spend cap: a market buy never spends more than ctx.maxSpendU at the estimated fill price', () => {
  // TEST FIXTURE: gate estimate 4975 sh at ~5025 u (<= $2,500); the next minute's worst ask jumps to 6000.
  const m = minute({
    startQuote: { bid: 4990, ask: 5000, bidSize: 10_000, askSize: 10_000, quoteTs: T - 1000 },
    endQuote: { bid: 5990, ask: 6000, bidSize: 10_000, askSize: 10_000, quoteTs: T + 1000 },
    minBid: 4990, maxBid: 5990, minAsk: 5000, maxAsk: 6000,
  });
  const r = evaluateOrder(order({ qty: 4975 }), m, micro, { ...RICH, maxSpendU: 25_000_000, spentU: 0 });
  assert.equal(r.action, 'fill');
  assert.equal(r.priceU, 6030);
  assert.equal(r.qty, 4145, 'floor(25,000,000 / 6030)');
  assert.ok(r.qty * r.priceU + r.feesU <= 25_000_000);
  assert.ok(r.assumptions.qtyLimitedBy.includes('SPEND_CAP'));
  assert.deepEqual(r.assumptions.spendCap, { maxSpendU: 25_000_000, spentBeforeU: 0 });
  // Earlier fills count against the cap.
  const partial = evaluateOrder(order({ qty: 4975, filled_qty: 4000 }), m, micro, { ...RICH, maxSpendU: 25_000_000, spentU: 20_000_000 });
  assert.equal(partial.qty, 829, 'floor(5,000,000 / 6030)');
  const none = evaluateOrder(order({ qty: 4975, filled_qty: 4145 }), m, micro, { ...RICH, maxSpendU: 25_000_000, spentU: 24_994_350 });
  assert.deepEqual([none.action, none.reason, none.spendCapReached], ['unfillable', 'SPEND_CAP_AT_ESTIMATED_PRICE', true]);
  // Sells are never capped by the spend cap.
  const sell = evaluateOrder(order({ side: 'sell', qty: 300 }), minute(), micro, { ...RICH, positionQty: 300, maxSpendU: 1 });
  assert.equal(sell.qty, 300);
});

test('worseThanStop means a gap through the stop, not ordinary slippage; slippage from S is reported separately', () => {
  // TEST FIXTURE: the bid touches the stop exactly (no gap).
  const touch = minute({
    trades: { o: 20_100, h: 20_100, l: 20_050, c: 20_050, v: 500, n: 3 },
    startQuote: { bid: 20_100, ask: 20_200, bidSize: 500, askSize: 500, quoteTs: T - 1000 },
    endQuote: { bid: 20_000, ask: 20_100, bidSize: 500, askSize: 500, quoteTs: T + 1000 },
    minBid: 20_000, maxBid: 20_100, minAsk: 20_100, maxAsk: 20_200,
  });
  const r = evaluateOrder(order({ side: 'sell', type: 'stop', stop_px: 20_000, qty: 100 }), touch, large, { ...RICH, positionQty: 100 });
  assert.equal(r.action, 'fill');
  assert.equal(r.priceU, 19_900, 'p(20000) with 5 bps = 19,990 -> penny tick down 19,900');
  assert.equal(r.worseThanStop, false, 'no gap: the bid only touched the stop');
  assert.equal(r.slippageFromStopU, 100);
  // Stop-limit fills are limit executions at/above L: no worseThanStop flag.
  const sl = evaluateOrder(order({ side: 'sell', type: 'stop_limit', stop_px: 4800, limit_px: 4700, qty: 100 }),
    minute({ minBid: 4750, trades: { o: 4800, h: 4800, l: 4760, c: 4760, v: 50, n: 1 } }), micro, { ...RICH, positionQty: 100 });
  assert.equal(sl.action, 'fill');
  assert.equal(sl.worseThanStop, undefined);
});

test('fill assumptions record the cost-model segment and flag a spread above the cost model maxSpreadBps', () => {
  const wide = minute({
    startQuote: { bid: 4000, ask: 5100, bidSize: 800, askSize: 300, quoteTs: T - 30_000 },
    minBid: 4000, maxBid: 5100, minAsk: 5100, maxAsk: 5200,
  });
  const r = evaluateOrder(order({}), wide, micro, RICH);
  assert.equal(r.action, 'fill');
  assert.equal(r.assumptions.segment, 'micro');
  assert.equal(r.assumptions.maxSpreadBps, 1500);
  assert.ok(r.assumptions.spreadAtStartBps > 1500);
  assert.deepEqual(r.assumptions.warnings, ['SPREAD_ABOVE_COST_MODEL_MAX']);
  const ok = evaluateOrder(order({}), minute(), micro, RICH);
  assert.deepEqual(ok.assumptions.warnings, []);
});

test('costSegmentFor: agent portfolios keep their segment; the sandbox picks large for large-cap list symbols', () => {
  assert.equal(costSegmentFor('large', 'FIXA'), 'large');
  const listed = largeCapList()[0]; // configured reference list (configuration, not market data)
  assert.equal(costSegmentFor(null, listed), 'large');
  assert.equal(costSegmentFor('micro', listed), 'micro');
  assert.equal(costSegmentFor(null, 'FIXA'), 'micro');
  assert.equal(costSegmentFor(null, null), 'micro');
});

test('stop SELL triggers on a gap and fills WORSE than the stop', () => {
  const gap = minute({
    trades: { o: 4100, h: 4150, l: 4050, c: 4100, v: 9000, n: 30 },
    startQuote: { bid: 4900, ask: 5000, bidSize: 2000, askSize: 2000, quoteTs: T - 1000 },
    endQuote: { bid: 4050, ask: 4150, bidSize: 2000, askSize: 2000, quoteTs: T + 50_000 },
    minBid: 4000, maxBid: 4900, minAsk: 4100, maxAsk: 5000,
  });
  const r = evaluateOrder(order({ side: 'sell', type: 'stop', stop_px: 4800, qty: 300 }), gap, micro, { ...RICH, positionQty: 300 });
  assert.equal(r.action, 'fill');
  assert.equal(r.triggered, true);
  assert.equal(r.priceU, 3980, 'p(min(4800, minBid 4000)) = floor(4000 x 0.995)');
  assert.equal(r.worseThanStop, true);
  assert.equal(r.assumptions.rule, 'STOP_SELL_TRIGGERED_FILL_AT_MIN(STOP, WORST_BID)');
  const quiet = evaluateOrder(order({ side: 'sell', type: 'stop', stop_px: 4800, qty: 300 }), minute({ minBid: 4850, trades: { o: 4900, h: 4950, l: 4820, c: 4900, v: 10, n: 1 } }), micro, { ...RICH, positionQty: 300 });
  assert.deepEqual(quiet, { action: 'none', note: 'STOP_NOT_TRIGGERED' });
});

test('stop SELL on a halted minute: trigger observed, fill withheld; next minute retried as market sell', () => {
  const halted = minute({ halted: true, trades: { o: 4900, h: 4900, l: 4700, c: 4700, v: 100, n: 2 } });
  const o = order({ side: 'sell', type: 'stop', stop_px: 4800, qty: 300 });
  const r1 = evaluateOrder(o, halted, micro, { ...RICH, positionQty: 300 });
  assert.deepEqual([r1.action, r1.reason, r1.triggered], ['unfillable', 'HALTED', true]);
  const next = minute({ t: T + 60_000, startQuote: { bid: 4500, ask: 4600, bidSize: 1000, askSize: 1000, quoteTs: T + 59_000 }, endQuote: { bid: 4500, ask: 4600, bidSize: 1000, askSize: 1000, quoteTs: T + 70_000 }, minBid: 4500, maxBid: 4500, minAsk: 4600, maxAsk: 4600 });
  const r2 = evaluateOrder({ ...o, status: 'triggered', triggered_ts: T }, next, micro, { ...RICH, positionQty: 300 });
  assert.equal(r2.action, 'fill');
  assert.equal(r2.priceU, 4477, 'retried as market: floor(4500 x 0.995)');
  assert.equal(r2.worseThanStop, true);
  assert.equal(r2.triggered, undefined, 'already triggered earlier');
});

test('stop-limit SELL: limit after trigger; trigger minute uses the quote rule only', () => {
  const o = order({ side: 'sell', type: 'stop_limit', stop_px: 4800, limit_px: 4700, qty: 100 });
  const fills = evaluateOrder(o, minute({ minBid: 4750, trades: { o: 4800, h: 4800, l: 4760, c: 4760, v: 50, n: 1 } }), micro, { ...RICH, positionQty: 100 });
  assert.equal(fills.action, 'fill');
  assert.equal(fills.priceU, 4726, 'max(4700, floor(4750 x 0.995))');
  assert.equal(fills.triggered, true);
  const trig = evaluateOrder(o, minute({ minBid: 4600, trades: { o: 4900, h: 4900, l: 4600, c: 4650, v: 50, n: 2 } }), micro, { ...RICH, positionQty: 100 });
  assert.deepEqual(trig, { action: 'trigger' }, 'trade above L may have printed before the trigger: no trade-through fill on trigger minute');
});

test('stop BUY mirrors the stop SELL logic', () => {
  const r = evaluateOrder(order({ side: 'buy', type: 'stop', stop_px: 5500, qty: 100 }), minute({ maxAsk: 5600 }), micro, RICH);
  assert.equal(r.action, 'fill');
  assert.equal(r.priceU, 5628, 'p(max(5500, 5600)) = ceil(5600 x 1.005)');
  assert.equal(r.worseThanStop, true);
  const none = evaluateOrder(order({ side: 'buy', type: 'stop', stop_px: 5500, qty: 100 }), minute(), micro, RICH);
  assert.deepEqual(none, { action: 'none', note: 'STOP_NOT_TRIGGERED' });
});

test('slippedPrice rounds against the trader on both sides', () => {
  assert.equal(slippedPrice(5000, 'buy', 50), 5025);
  assert.equal(slippedPrice(5000, 'sell', 50), 4975);
  assert.equal(slippedPrice(10_000, 'buy', 5), 10_100, '$1.0005 -> $1.01 (penny tick, rounded up)');
  assert.equal(slippedPrice(10_000, 'sell', 5), 9995, 'below $1 after slippage: 1 u ticks');
});
