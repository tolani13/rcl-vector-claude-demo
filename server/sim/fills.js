// Fill model `iex-conservative-minute-v1` (docs/CONTRACTS.md section 2). PURE functions: no I/O, no clock.
//
// A paper fill is an ESTIMATE derived from IEX top-of-book plus IEX trades aggregated per minute
// (server/data/marketdata.js fillMinute()). It is never an exchange execution. "Conservative" means:
//   1. take the worst price observed inside the minute (incl. the carried-in quote state),
//   2. apply slippage against the trader (money.applyBps),
//   3. round to a valid Reg NMS Rule 612 tick against the trader (money.roundToTick),
//   4. cap quantity at the displayed IEX size at the start of the minute (on the order's side), less what earlier
//      fills of the same portfolio/side already took from it in this minute (ctx.consumed). A strict trade-through
//      limit fill is capped at min(that displayed size, the minute's IEX volume): the shares that printed through
//      the limit cannot be separated from the minute aggregate, so the displayed size is the conservative proxy,
//   5. round every fee UP to a whole u,
//   6. refuse to model a fill (`unfillable`) when the data cannot support one (halt, no two-sided quote,
//      stale quote, zero displayed size) instead of manufacturing execution evidence,
//   7. never let a buy spend more than the order's spend cap (ctx.maxSpendU, from the policy's max_trade_spend_usd
//      and/or the intent budget) at the estimated fill price.
// Every fill carries `assumptions` (model, price basis, slippage, fees, size used, omitted effects) and
// `observed` (the exact minute data used) so the journal can show provenance.
import { applyBps, roundToTick, isValidTick } from '../util/money.js';
import { MINUTE } from '../util/time.js';
import { largeCapList } from '../data/universe.js';

export const FILL_MODEL_ID = 'iex-conservative-minute-v1';

/** Effects the model does not capture. Always listed on every fill's assumptions. */
export const OMITTED_EFFECTS = Object.freeze([
  'queue position at IEX',
  'hidden and odd-lot liquidity',
  'NBBO vs IEX BBO differences (IEX top-of-book only)',
  'liquidity and prices on other venues',
  'partial-fill dynamics inside the minute',
  'market impact beyond the slippage assumption',
  'borrow/locate (never needed: no shorting)',
  'corporate actions on the replay day',
  'options exercise/assignment',
  'IEX trade breaks arriving after the trade minute are not removed from that minute; once a break is knowable, the trade evidence of that minute is withheld',
]);

const SEGMENT_DEFAULTS = Object.freeze({
  micro: { slippageBps: 50, maxQuoteAgeMs: 300_000, maxSpreadBps: 1500 },
  large: { slippageBps: 5, maxQuoteAgeMs: 60_000, maxSpreadBps: 50 },
});

/**
 * Default cost model for a segment ('micro' | 'large'). Any other value (sandbox, null) gets the micro values,
 * which carry the larger (more conservative) slippage. Every value is an overridable, labelled assumption.
 */
export function defaultCostModel(segment) {
  const seg = segment === 'large' ? 'large' : 'micro';
  const d = SEGMENT_DEFAULTS[seg];
  return {
    model: FILL_MODEL_ID,
    segment: seg,
    requestedSegment: segment ?? null,
    label: 'EXPLORATORY ASSUMPTIONS — NOT VALIDATED',
    priceBasis: 'WORST_IN_MINUTE',
    slippageBps: d.slippageBps,
    commissionPerOrderU: 0,
    secFeeRatePerMillionUsd: 27.8,
    tafPerShareU: 1.66,
    tafCapU: 83_000,
    maxQuoteAgeMs: d.maxQuoteAgeMs,
    maxSpreadBps: d.maxSpreadBps,
    displayedSizeCap: true,
    notes: {
      secFee: 'SEC Section 31 fee on sells: $27.80 per $1M of proceeds — assumption; verify the current SEC rate.',
      taf: 'FINRA TAF on equity sells: $0.000166/share capped at $8.30 — assumption; verify the current FINRA rate.',
      commission: 'Commission charged once per order, on its first fill.',
      options: 'Options: only commission + SEC fee are modelled; per-contract ORF/TAF/exchange fees are not.',
    },
  };
}

/**
 * Cost-model segment used for a portfolio and symbol. Agent portfolios use their own segment. The manual sandbox
 * (segment null) uses 'large' for symbols on the configured large-cap list and 'micro' for everything else, so the
 * gate estimate and the fill engine apply the same assumptions to the same symbol. `sym` null => micro.
 */
export function costSegmentFor(portfolioSegment, sym) {
  if (portfolioSegment === 'micro' || portfolioSegment === 'large') return portfolioSegment;
  return typeof sym === 'string' && largeCapList().includes(sym) ? 'large' : 'micro';
}

/** Spread of a quote in bps of the mid, or null when not two-sided. */
function spreadBpsOf(q) {
  if (!q || !(q.bid > 0) || !(q.ask > 0) || q.ask < q.bid) return null;
  return Math.round(((q.ask - q.bid) / ((q.ask + q.bid) / 2)) * 10000);
}

// ---- helpers -------------------------------------------------------------------------------------------------

function ceilDivBig(a, b) {
  return (a + b - 1n) / b;
}

/** Price after slippage (against the trader) rounded to a valid tick (against the trader). */
export function slippedPrice(baseU, side, slippageBps) {
  return roundToTick(applyBps(baseU, slippageBps, side), side);
}

/**
 * Fees for a fill, each component rounded UP to whole u. SEC fee and TAF apply to sells only.
 * @returns {{commissionU:number, secFeeU:number, tafU:number, totalU:number}}
 */
export function computeFees(side, qty, priceU, costModel, { multiplier = 1, firstFill = true, kind = 'equity' } = {}) {
  const commissionU = firstFill ? Math.max(0, Math.ceil(costModel.commissionPerOrderU ?? 0)) : 0;
  let secFeeU = 0;
  let tafU = 0;
  if (side === 'sell' && qty > 0) {
    // Exact integer arithmetic: fee_u = ceil(notional_u * rate / 1e6), rate scaled by 1e6 to stay integral.
    const notionalU = BigInt(priceU) * BigInt(qty) * BigInt(multiplier);
    const rateScaled = BigInt(Math.round((costModel.secFeeRatePerMillionUsd ?? 0) * 1e6));
    secFeeU = Number(ceilDivBig(notionalU * rateScaled, 1_000_000_000_000n));
    if (kind === 'equity') {
      const tafScaled = BigInt(Math.round((costModel.tafPerShareU ?? 0) * 1e6));
      tafU = Number(ceilDivBig(BigInt(qty) * tafScaled, 1_000_000n));
      if (Number.isFinite(costModel.tafCapU)) tafU = Math.min(tafU, costModel.tafCapU);
    }
  }
  return { commissionU, secFeeU, tafU, totalU: commissionU + secFeeU + tafU };
}

/** The exact market observations a decision used (journal provenance). */
export function observedFromMinute(minute, ctx = {}) {
  return {
    ds: ctx.ds ?? minute.ds ?? null,
    venue: 'IEX',
    sym: minute.sym,
    minuteT: minute.t,
    hasRow: !!minute.hasRow,
    startQuote: minute.startQuote ?? null,
    endQuote: minute.endQuote ?? null,
    minBid: minute.minBid ?? null,
    maxBid: minute.maxBid ?? null,
    minAsk: minute.minAsk ?? null,
    maxAsk: minute.maxAsk ?? null,
    trades: minute.trades ?? null,
    halted: !!minute.halted,
    unavailable: !!minute.unavailable,
  };
}

const pos = (x) => Number.isFinite(x) && x > 0;

function isStopType(type) {
  return type === 'stop' || type === 'stop_limit';
}

/** Did a stop with trigger S trigger in this minute? (sell: price fell to S; buy: price rose to S) */
export function stopTriggered(order, minute) {
  const S = order.stop_px;
  const tr = minute.trades;
  const sq = minute.startQuote;
  if (order.side === 'sell') {
    return (minute.minBid != null && minute.minBid > 0 && minute.minBid <= S)
      || (!!tr && tr.l != null && tr.l <= S)
      || (!!sq && pos(sq.bid) && sq.bid <= S);
  }
  return (minute.maxAsk != null && minute.maxAsk > 0 && minute.maxAsk >= S)
    || (!!tr && tr.h != null && tr.h >= S)
    || (!!sq && pos(sq.ask) && sq.ask >= S);
}

/** Why the minute cannot support a credible fill, or null. */
function dataProblem(minute, costModel) {
  if (minute.halted) return 'HALTED';
  if (minute.unavailable) return 'UNAVAILABLE';
  const twoSidedInMinute = pos(minute.minBid) && pos(minute.maxBid) && pos(minute.minAsk) && pos(minute.maxAsk);
  const dq = minute.endQuote ?? minute.startQuote;
  const twoSidedAtDecision = !!dq && pos(dq.bid) && pos(dq.ask) && dq.ask >= dq.bid;
  if (!twoSidedInMinute || !twoSidedAtDecision) return 'NO_TWO_SIDED_QUOTE';
  if (Number.isFinite(costModel.maxQuoteAgeMs) && Number.isFinite(dq.quoteTs)) {
    const ageMs = minute.t + MINUTE - dq.quoteTs;
    if (ageMs > costModel.maxQuoteAgeMs) return 'STALE_QUOTE';
  }
  return null;
}

/**
 * Evaluate one working order against one completed minute.
 * @param {object} order   orders row shape: {side, type, qty, filled_qty, limit_px, stop_px, status, triggered_ts, kind}
 * @param {object} minute  marketdata.fillMinute() result
 * @param {object} costModel defaultCostModel() shape (overridable)
 * @param {{cashU:number, positionQty:number, ds?:string, multiplier?:number,
 *          consumed?:{DISPLAYED?:number, TRADE_THROUGH?:number}, maxSpendU?:number, spentU?:number}} ctx
 *   consumed: shares earlier fills (same portfolio, symbol and side) already took this minute per size source;
 *   maxSpendU / spentU: the buy order's spend cap and what its earlier fills already spent (qty*price*mult + fees).
 * @returns {{action:'none', note?:string}
 *   | {action:'trigger'}
 *   | {action:'fill', qty:number, priceU:number, feesU:number, triggered?:boolean, worseThanStop?:boolean, slippageFromStopU?:number, assumptions:object, observed:object}
 *   | {action:'unfillable', reason:string, triggered?:boolean, spendCapReached?:boolean, observed:object}}
 *   `unfillable` may carry `triggered:true` when a stop's trigger condition was observed in the same minute but no
 *   fill could be modelled (the order then stays `triggered` and is retried next minute as a market order).
 *   `worseThanStop` (stop orders only) means the market GAPPED through the stop (the base price before slippage, or
 *   the quote the minute started from, was beyond S); the distance of the fill from S including slippage is reported
 *   separately as `slippageFromStopU`.
 */
export function evaluateOrder(order, minute, costModel, ctx = {}) {
  const cm = costModel || defaultCostModel(null);
  const observed = observedFromMinute(minute, ctx);
  const remaining = order.qty - (order.filled_qty ?? 0);
  if (!(remaining > 0)) return { action: 'none', note: 'NOTHING_REMAINING' };
  const side = order.side;
  const type = order.type;
  const multiplier = ctx.multiplier ?? 1;
  const positionQty = Math.max(0, ctx.positionQty ?? 0);
  if (side === 'sell' && positionQty <= 0) return { action: 'unfillable', reason: 'NO_POSITION_HELD', observed };

  // Stop trigger is evaluated from whatever was observed, even when no fill can be modelled.
  const wasTriggered = order.status === 'triggered' || order.triggered_ts != null;
  const triggeredNow = isStopType(type) && !wasTriggered ? stopTriggered(order, minute) : false;
  const trig = triggeredNow ? { triggered: true } : {};

  const problem = dataProblem(minute, cm);
  if (problem) return { action: 'unfillable', reason: problem, ...trig, observed };
  if (isStopType(type) && !wasTriggered && !triggeredNow) return { action: 'none', note: 'STOP_NOT_TRIGGERED' };

  const sq = minute.startQuote;
  const tr = minute.trades;
  const bps = cm.slippageBps ?? 0;
  const p = (base) => slippedPrice(base, side, bps);
  const limitL = order.limit_px;
  const stopS = order.stop_px;

  // ---- price + size-source selection --------------------------------------------------------------
  let rule;
  let basePriceU;
  let priceU;
  let sizeSource; // 'DISPLAYED' (quote-based fill) | 'TRADE_THROUGH' (minute IEX volume)
  const effType = type === 'stop' && (wasTriggered || triggeredNow) ? 'market_from_stop'
    : type === 'stop_limit' ? 'limit_from_stop' : type;
  // On the stop-limit trigger minute only the quote rule is used: intra-minute trade order is unknown, so a
  // trade above/below L may have happened before the trigger.
  const quoteRuleOnly = type === 'stop_limit' && triggeredNow;

  if (effType === 'market') {
    basePriceU = side === 'buy' ? minute.maxAsk : minute.minBid;
    priceU = p(basePriceU);
    rule = side === 'buy' ? 'MARKET_BUY_WORST_ASK_IN_MINUTE' : 'MARKET_SELL_WORST_BID_IN_MINUTE';
    sizeSource = 'DISPLAYED';
  } else if (effType === 'market_from_stop') {
    if (side === 'sell') {
      basePriceU = triggeredNow ? Math.min(stopS, minute.minBid) : minute.minBid;
      rule = triggeredNow ? 'STOP_SELL_TRIGGERED_FILL_AT_MIN(STOP, WORST_BID)' : 'TRIGGERED_STOP_SELL_RETRY_AS_MARKET_WORST_BID';
    } else {
      basePriceU = triggeredNow ? Math.max(stopS, minute.maxAsk) : minute.maxAsk;
      rule = triggeredNow ? 'STOP_BUY_TRIGGERED_FILL_AT_MAX(STOP, WORST_ASK)' : 'TRIGGERED_STOP_BUY_RETRY_AS_MARKET_WORST_ASK';
    }
    priceU = p(basePriceU);
    sizeSource = 'DISPLAYED';
  } else if (effType === 'limit' || effType === 'limit_from_stop') {
    if (side === 'buy') {
      if (minute.maxAsk <= limitL) {
        basePriceU = minute.maxAsk;
        priceU = Math.min(limitL, p(basePriceU));
        rule = 'LIMIT_BUY_WORST_ASK_AT_OR_BELOW_LIMIT';
        sizeSource = 'DISPLAYED';
      } else if (!quoteRuleOnly && tr && tr.l != null && tr.l < limitL) {
        basePriceU = limitL;
        priceU = limitL;
        rule = 'LIMIT_BUY_STRICT_TRADE_THROUGH_FILL_AT_LIMIT';
        sizeSource = 'TRADE_THROUGH';
      } else {
        return triggeredNow ? { action: 'trigger' } : { action: 'none', note: 'LIMIT_NOT_REACHED' };
      }
    } else {
      if (minute.minBid >= limitL) {
        basePriceU = minute.minBid;
        priceU = Math.max(limitL, p(basePriceU));
        rule = 'LIMIT_SELL_WORST_BID_AT_OR_ABOVE_LIMIT';
        sizeSource = 'DISPLAYED';
      } else if (!quoteRuleOnly && tr && tr.h != null && tr.h > limitL) {
        basePriceU = limitL;
        priceU = limitL;
        rule = 'LIMIT_SELL_STRICT_TRADE_THROUGH_FILL_AT_LIMIT';
        sizeSource = 'TRADE_THROUGH';
      } else {
        return triggeredNow ? { action: 'trigger' } : { action: 'none', note: 'LIMIT_NOT_REACHED' };
      }
    }
    if (type === 'stop_limit') rule = `STOP_LIMIT_${rule}`;
  } else {
    return { action: 'unfillable', reason: `UNSUPPORTED_ORDER_TYPE:${type}`, ...trig, observed };
  }

  if (!isValidTick(priceU)) return { action: 'unfillable', reason: 'NO_VALID_TICK_PRICE', ...trig, observed };

  // ---- quantity ----------------------------------------------------------------------------------
  const qtyLimitedBy = [];
  let qty = remaining;
  let displayedSizeUsed = null;
  let sizeAtMinuteStart = null;
  let consumedEarlier = 0;
  let tradeThroughSizeProxy;
  if (cm.displayedSizeCap !== false) {
    if (!sq) return { action: 'unfillable', reason: 'NO_DISPLAYED_SIZE_AT_MINUTE_START', ...trig, observed };
    const displayed = side === 'buy' ? (sq.askSize || 0) : (sq.bidSize || 0);
    if (sizeSource === 'DISPLAYED') {
      sizeAtMinuteStart = displayed;
    } else {
      // Trade-through: the shares that printed below/above L cannot be separated from the minute aggregate, so the
      // conservative proxy is min(displayed size on the order's side at the minute start, minute IEX volume).
      sizeAtMinuteStart = Math.min(displayed, tr?.v || 0);
      tradeThroughSizeProxy = 'min(startQuote displayed size on order side, minute IEX volume)';
    }
    if (sizeAtMinuteStart <= 0) return { action: 'unfillable', reason: 'ZERO_DISPLAYED_SIZE', ...trig, observed };
    consumedEarlier = Math.max(0, ctx.consumed?.[sizeSource] ?? 0);
    displayedSizeUsed = Math.max(0, sizeAtMinuteStart - consumedEarlier);
    if (displayedSizeUsed <= 0) {
      return { action: 'unfillable', reason: sizeSource === 'DISPLAYED' ? 'DISPLAYED_SIZE_CONSUMED_THIS_MINUTE' : 'TRADE_THROUGH_SIZE_CONSUMED_THIS_MINUTE', ...trig, observed };
    }
    if (displayedSizeUsed < qty) {
      qty = displayedSizeUsed;
      if (consumedEarlier > 0) qtyLimitedBy.push('DISPLAYED_SIZE_REMAINING');
      else qtyLimitedBy.push(sizeSource === 'DISPLAYED' ? 'DISPLAYED_SIZE' : 'TRADE_THROUGH_DISPLAYED_SIZE_PROXY');
    }
  }
  if (side === 'sell' && positionQty < qty) { qty = positionQty; qtyLimitedBy.push('POSITION_HELD'); }

  const firstFill = (order.filled_qty ?? 0) === 0;
  const feeOpts = { multiplier, firstFill, kind: order.kind ?? 'equity' };
  let fees = computeFees(side, qty, priceU, cm, feeOpts);
  const hasSpendCap = side === 'buy' && Number.isFinite(ctx.maxSpendU);
  if (hasSpendCap) {
    // Spend cap at the estimated fill price: never more than maxSpendU in total over all fills of this order.
    const room = ctx.maxSpendU - Math.max(0, ctx.spentU ?? 0) - fees.commissionU;
    const capQty = room > 0 ? Math.floor(room / (priceU * multiplier)) : 0;
    if (capQty < qty) {
      qty = Math.max(0, capQty);
      qtyLimitedBy.push('SPEND_CAP');
      if (qty <= 0) return { action: 'unfillable', reason: 'SPEND_CAP_AT_ESTIMATED_PRICE', spendCapReached: true, ...trig, observed };
      fees = computeFees(side, qty, priceU, cm, feeOpts);
    }
  }
  let affordabilityReduced = false;
  if (side === 'buy') {
    const cashU = ctx.cashU ?? 0;
    if (qty * priceU * multiplier + fees.totalU > cashU) {
      // Buy-side fees are commission only (fixed per order), so the largest affordable whole qty is direct.
      const affordable = Math.floor((cashU - fees.commissionU) / (priceU * multiplier));
      qty = Math.max(0, Math.min(qty, affordable));
      affordabilityReduced = true;
      qtyLimitedBy.push('CASH_AT_ESTIMATED_PRICE');
      if (qty <= 0) return { action: 'unfillable', reason: 'INSUFFICIENT_CASH_AT_ESTIMATED_PRICE', ...trig, observed };
      fees = computeFees(side, qty, priceU, cm, feeOpts);
    }
  }

  // Spread vs the cost model's maxSpreadBps: recorded (and flagged) so a fill at a spread the slippage assumption was
  // not set for is visible in the journal. The policy gate's max_spread_bps decides admission at submission time.
  const spreadAtStartBps = spreadBpsOf(sq);
  const spreadAtEndBps = spreadBpsOf(minute.endQuote ?? sq);
  const worstSpread = Math.max(spreadAtStartBps ?? -Infinity, spreadAtEndBps ?? -Infinity);
  const warnings = [];
  if (Number.isFinite(cm.maxSpreadBps) && Number.isFinite(worstSpread) && worstSpread > cm.maxSpreadBps) warnings.push('SPREAD_ABOVE_COST_MODEL_MAX');

  const res = {
    action: 'fill',
    qty,
    priceU,
    feesU: fees.totalU,
    assumptions: {
      model: FILL_MODEL_ID,
      estimated: true,
      notExchangeExecution: true,
      segment: cm.segment ?? null,
      requestedSegment: cm.requestedSegment ?? null,
      priceBasis: cm.priceBasis ?? 'WORST_IN_MINUTE',
      rule,
      basePriceU,
      slippageBps: bps,
      tickRule: 'REG_NMS_612_ROUNDED_AGAINST_TRADER',
      fees: {
        ...fees,
        rounding: 'EACH_COMPONENT_UP_TO_WHOLE_U',
        commissionPerOrderU: cm.commissionPerOrderU ?? 0,
        secFeeRatePerMillionUsd: cm.secFeeRatePerMillionUsd ?? 0,
        tafPerShareU: cm.tafPerShareU ?? 0,
        tafCapU: cm.tafCapU ?? null,
      },
      displayedSizeCap: cm.displayedSizeCap !== false,
      sizeSource,
      displayedSizeUsed,
      displayedSizeAtMinuteStart: sizeAtMinuteStart,
      consumedEarlierThisMinute: consumedEarlier,
      ...(tradeThroughSizeProxy ? { tradeThroughSizeProxy, minuteVolume: tr?.v ?? null } : {}),
      qtyRequested: remaining,
      qtyLimitedBy,
      affordabilityReduced,
      ...(hasSpendCap ? { spendCap: { maxSpendU: ctx.maxSpendU, spentBeforeU: Math.max(0, ctx.spentU ?? 0) } } : {}),
      multiplier,
      maxQuoteAgeMs: cm.maxQuoteAgeMs ?? null,
      maxSpreadBps: cm.maxSpreadBps ?? null,
      spreadAtStartBps,
      spreadAtEndBps,
      warnings,
      omitted: [...OMITTED_EFFECTS],
    },
    observed,
  };
  if (isStopType(type)) {
    if (triggeredNow) res.triggered = true;
    if (type === 'stop') {
      // Gap = the market itself was beyond S: the base price before slippage, or the quote the minute started from
      // (a stop that was already through the market when it became eligible). Slippage alone is not a gap.
      res.worseThanStop = side === 'sell'
        ? basePriceU < stopS || (pos(sq?.bid) && sq.bid < stopS)
        : basePriceU > stopS || (pos(sq?.ask) && sq.ask > stopS);
      res.slippageFromStopU = side === 'sell' ? stopS - priceU : priceU - stopS;
    }
    // stop_limit: executes as a limit at or better than L, so "worse than stop" is not meaningful; omitted.
  }
  return res;
}
