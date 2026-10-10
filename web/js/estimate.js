// Pre-submit cost ESTIMATE for the sandbox order ticket (pure; unit-tested in test/web).
//
// This mirrors the documented default cost model of fill model `iex-conservative-minute-v1`
// (docs/CONTRACTS.md §2). The constants below are configuration ASSUMPTIONS (slippage, fee rates), not market
// observations. The only market input is the as-of IEX quote returned by the API. The server's policy gate and
// fill engine are authoritative; the real estimated fill uses the WORST price within the next minute, which can
// be worse than this preview.
import { isNum } from './format.js';

export const COST_MODEL_DEFAULTS = Object.freeze({
  micro: { slippageBps: 50, maxSpreadBps: 1500, maxQuoteAgeMs: 300000 },
  large: { slippageBps: 5, maxSpreadBps: 50, maxQuoteAgeMs: 60000 },
  commissionPerOrderU: 0,
  secFeeRatePerMillionUsd: 27.8,   // sells only; assumption — verify the current SEC Section 31 rate
  tafPerShareU: 1.66,              // sells only; assumption
  tafCapU: 83000,                  // per-trade TAF cap (assumption)
});

const U_PER_USD = 10000;

/** Reg NMS Rule 612: at or above one dollar prices must be whole cents (100 u); below one dollar any u (1e-4 USD) is valid. */
export function isValidTick(priceU) {
  if (!Number.isInteger(priceU) || priceU <= 0) return false;
  return priceU >= U_PER_USD ? priceU % 100 === 0 : true;
}
export function roundToTick(priceU, side) {
  if (priceU < U_PER_USD) return side === 'buy' ? Math.ceil(priceU) : Math.floor(priceU);
  return side === 'buy' ? Math.ceil(priceU / 100) * 100 : Math.floor(priceU / 100) * 100;
}
/** Apply slippage in bps against the trader (buy up, sell down), then round to a valid tick against the trader. */
export function slip(priceU, bps, side) {
  const raw = priceU * (1 + (side === 'buy' ? bps : -bps) / 10000);
  return roundToTick(side === 'buy' ? Math.ceil(raw) : Math.floor(raw), side);
}

/** Regulatory sell-side fees in u (rounded UP to whole u), per the documented assumptions. */
export function sellFeesU(qty, priceU, cm = COST_MODEL_DEFAULTS) {
  const notionalU = qty * priceU;
  const sec = Math.ceil((notionalU * cm.secFeeRatePerMillionUsd) / 1e6);
  const taf = Math.min(Math.ceil(qty * cm.tafPerShareU), cm.tafCapU);
  return { sec, taf, commission: cm.commissionPerOrderU, total: sec + taf + cm.commissionPerOrderU };
}

/**
 * @param {{side:'buy'|'sell', orderType:'market'|'limit'|'stop'|'stop_limit', qty?:number, budgetU?:number,
 *          limitU?:number, stopU?:number, quote?:object|null, segment?:'micro'|'large', cashU?:number|null, heldQty?:number|null}} o
 * @returns {{ok:boolean, status:string, side, priceU?, qty?, notionalU?, fees?, totalU?, slippageBps, basis, warnings:string[]}}
 */
export function estimateOrder(o) {
  const seg = o.segment === 'large' ? 'large' : 'micro';
  const cm = COST_MODEL_DEFAULTS;
  const bps = cm[seg].slippageBps;
  const warnings = [];
  const side = o.side === 'sell' ? 'sell' : 'buy';
  const q = o.quote && typeof o.quote === 'object' ? o.quote : null;
  const bid = q && isNum(q.bid) && q.bid > 0 ? q.bid : null;
  const ask = q && isNum(q.ask) && q.ask > 0 ? q.ask : null;
  const twoSided = !!(q && (q.twoSided ?? (bid !== null && ask !== null && ask >= bid)));
  const base = { side, slippageBps: bps, segment: seg, warnings };

  if (!q || !twoSided) {
    return { ...base, ok: false, status: 'NO_VERIFIED_DATA', basis: 'No two-sided IEX quote as of the replay clock — cost cannot be estimated. The policy gate will deny (quote_fresh) and no fill will be modelled.' };
  }
  if (q.halted) warnings.push('Symbol is halted/paused as of the replay clock: the gate denies and no fill is modelled while halted.');
  if (isNum(q.ageMs) && q.ageMs > cm[seg].maxQuoteAgeMs) warnings.push(`Quote age exceeds the ${seg} default limit (quote_fresh will deny).`);
  if (isNum(q.spreadBps) && q.spreadBps > cm[seg].maxSpreadBps) warnings.push(`Spread exceeds the ${seg} default limit (max_spread_bps will deny).`);

  // Reference price per order type (what the fill model would most plausibly use, conservatively).
  let priceU;
  let basis;
  const L = isNum(o.limitU) ? o.limitU : null;
  const S = isNum(o.stopU) ? o.stopU : null;
  if (o.orderType === 'market') {
    priceU = side === 'buy' ? slip(ask, bps, 'buy') : slip(bid, bps, 'sell');
    basis = side === 'buy' ? `IEX ask + ${bps} bps slippage` : `IEX bid − ${bps} bps slippage`;
  } else if (o.orderType === 'limit') {
    if (L === null) return { ...base, ok: false, status: 'INVALID', basis: 'Limit price required.' };
    if (side === 'buy') {
      const p = slip(ask, bps, 'buy');
      priceU = ask <= L ? Math.min(L, p) : L;
      basis = ask <= L ? 'Marketable limit: min(limit, ask + slippage)' : 'Resting limit: fills only if the ask reaches the limit or trades print through it';
      if (ask > L) warnings.push('Limit is below the current ask; the order may not fill.');
    } else {
      const p = slip(bid, bps, 'sell');
      priceU = bid >= L ? Math.max(L, p) : L;
      basis = bid >= L ? 'Marketable limit: max(limit, bid − slippage)' : 'Resting limit: fills only if the bid reaches the limit or trades print through it';
      if (bid < L) warnings.push('Limit is above the current bid; the order may not fill.');
    }
  } else if (o.orderType === 'stop' || o.orderType === 'stop_limit') {
    if (S === null) return { ...base, ok: false, status: 'INVALID', basis: 'Stop price required.' };
    if (o.orderType === 'stop_limit' && L === null) return { ...base, ok: false, status: 'INVALID', basis: 'Limit price required for stop-limit.' };
    priceU = o.orderType === 'stop_limit' ? L : slip(S, bps, side);
    basis = o.orderType === 'stop_limit' ? 'Stop-limit: after trigger behaves as a limit at the limit price (may not fill)'
      : `Stop: after trigger becomes a market order; estimate at stop ${side === 'buy' ? '+' : '−'} slippage. Gaps fill WORSE than the stop.`;
  } else {
    return { ...base, ok: false, status: 'INVALID', basis: 'Unknown order type.' };
  }

  // Quantity: explicit shares, or the largest whole-share quantity a $ budget buys at the estimated price.
  let qty = Number.isInteger(o.qty) && o.qty > 0 ? o.qty : null;
  if (qty === null && side === 'buy' && isNum(o.budgetU) && o.budgetU > 0) {
    qty = Math.floor(o.budgetU / priceU);
    if (qty < 1) return { ...base, ok: false, status: 'INSUFFICIENT_BUDGET', priceU, basis: 'Budget is below one share at the estimated price.' };
  }
  if (qty === null) return { ...base, ok: false, status: 'INVALID', priceU, basis: 'Whole-share quantity (or a $ budget for buys) is required.' };

  if (side === 'buy' && isNum(q.askSize) && q.askSize > 0 && qty > q.askSize) {
    warnings.push('Quantity exceeds displayed IEX ask size; the conservative fill model caps a minute fill at displayed size (partial fills possible).');
  }
  if (side === 'sell' && isNum(q.bidSize) && q.bidSize > 0 && qty > q.bidSize) {
    warnings.push('Quantity exceeds displayed IEX bid size; the conservative fill model caps a minute fill at displayed size (partial fills likely, so proceeds may arrive over several minutes or not at all).');
  }
  if (side === 'sell' && isNum(o.heldQty) && qty > o.heldQty) warnings.push('Sell quantity exceeds shares held — no shorting; the gate will deny (no_short).');

  const notionalU = qty * priceU;
  const fees = side === 'sell' ? sellFeesU(qty, priceU, cm) : { sec: 0, taf: 0, commission: cm.commissionPerOrderU, total: cm.commissionPerOrderU };
  const totalU = side === 'buy' ? notionalU + fees.total : notionalU - fees.total;
  if (side === 'buy' && isNum(o.cashU) && totalU > o.cashU) warnings.push('Estimated cost exceeds available sandbox cash; the gate will deny (cash_sufficient).');

  return { ...base, ok: true, status: 'ESTIMATE', priceU, qty, notionalU, fees, totalU, basis, quoteTs: q.quoteTs ?? null };
}
