// Paper long-put support (docs/CONTRACTS.md section 2, "Options"). LONG PUTS ONLY: no calls, no short options,
// no margin, no uncovered options, no real options orders.
//
// This build has NO options data provider, so the operational status is NO_VERIFIED_OPTIONS_DATA and every
// operational options order is rejected unless the caller supplies a quote object produced by a real, verified
// options provider (shape: see validateOptionsQuote). The arithmetic below (premium cost, capped loss,
// expiration value) and the engine path (orders.processMinute with an injected optionsProvider -> ledger.applyFill
// with multiplier 100, ledger.settleLongPutAtExpiration) are exercised only with TEST FIXTURE contracts in
// test/sim/options.test.js. The replay engine passes no optionsProvider and never calls the expiration settlement,
// so the verified path is not reachable in this build (see optionsStatus().notImplemented).
//
// Expiration is modelled as CASH VALUE at expiration: max(0, K - S) x multiplier. Real equity options are
// physically settled; exercise/assignment mechanics are NOT modelled.
import { roundToTick } from '../util/money.js';
import { MINUTE } from '../util/time.js';
import { computeFees, OMITTED_EFFECTS } from './fills.js';

export const OPTIONS_STATUS = 'NO_VERIFIED_OPTIONS_DATA';
export const OPTIONS_MULTIPLIER = 100;
export const OPTIONS_FILL_MODEL_ID = 'verified-options-quote-conservative-v1';

/** Operational options status for /api/options/status. */
export function optionsStatus() {
  return {
    status: OPTIONS_STATUS,
    detail: 'No verified options contracts/quotes provider is configured. Operational options orders are rejected. '
      + 'Long-put arithmetic (premium x 100, capped premium loss, expiration value) and the paper buy/expiration path are tested '
      + 'with TEST FIXTURE contracts only (test/sim/options.test.js). Not implemented in the replay: an options quote provider '
      + 'and automatic expiration settlement.',
    supported: { instrument: 'long put', short: false, calls: false, margin: false },
    notImplemented: [
      'options quote provider: the replay engine passes no optionsProvider, so a verified options order can never fill in this build',
      'automatic expiration settlement: the replay engine never calls ledger.settleLongPutAtExpiration',
      'exercise/assignment and physical settlement (expiration is modelled as cash value max(0, K - S) x 100)',
    ],
  };
}

const OCC_RE = /^([A-Z][A-Z0-9.]{0,5})\s*(\d{2})(\d{2})(\d{2})([CP])(\d{8})$/;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

function validDate(s) {
  const m = DATE_RE.exec(s ?? '');
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3];
}

/**
 * Validate a long-put contract description. `strike` is in u (1e-4 USD) and must be representable in OCC
 * thousandths of a dollar (multiple of 10 u). Returns the normalized contract with a compact OCC symbol.
 * @param {{occ:string, underlying:string, expiry:string, strike:number, right:'P', multiplier:100}} c
 */
export function validateContract(c) {
  const errors = [];
  if (!c || typeof c !== 'object' || Array.isArray(c)) return { ok: false, errors: ['contract must be an object'], contract: null };
  const allowed = new Set(['occ', 'underlying', 'expiry', 'strike', 'right', 'multiplier']);
  for (const k of Object.keys(c)) if (!allowed.has(k)) errors.push(`unknown contract field: ${k}`);
  if (typeof c.underlying !== 'string' || !/^[A-Z][A-Z0-9.]{0,5}$/.test(c.underlying)) errors.push('underlying must be an OCC root symbol (1-6 chars, A-Z0-9.)');
  if (!validDate(c.expiry)) errors.push('expiry must be a valid YYYY-MM-DD date');
  if (!Number.isSafeInteger(c.strike) || c.strike <= 0) errors.push('strike must be a positive integer number of u');
  else if (c.strike % 10 !== 0) errors.push('strike must be a multiple of 10 u ($0.001, OCC precision)');
  if (c.right !== 'P') errors.push("right must be 'P' (long puts only; calls are not supported)");
  if (c.multiplier !== OPTIONS_MULTIPLIER) errors.push('multiplier must be 100');
  const m = OCC_RE.exec(typeof c.occ === 'string' ? c.occ : '');
  if (!m) errors.push('occ must be an OCC option symbol: ROOT + YYMMDD + P + 8-digit strike x1000');
  else if (errors.length === 0) {
    const [, root, yy, mm, dd, right, strikeMilli] = m;
    if (root !== c.underlying) errors.push('occ root does not match underlying');
    if (`20${yy}-${mm}-${dd}` !== c.expiry) errors.push('occ expiry does not match expiry');
    if (right !== c.right) errors.push('occ right does not match right');
    if (Number(strikeMilli) * 10 !== c.strike) errors.push('occ strike does not match strike');
  }
  if (errors.length) return { ok: false, errors, contract: null };
  return {
    ok: true, errors: [],
    contract: { occ: c.occ.replace(/\s+/g, ''), underlying: c.underlying, expiry: c.expiry, strike: c.strike, right: 'P', multiplier: OPTIONS_MULTIPLIER },
  };
}

/**
 * Cost of buying `contracts` long puts at `premiumU` per share-equivalent. Max loss = everything paid.
 * @returns {{premiumU, contracts, multiplier, premiumTotalU, feesU, totalCostU, maxLossU}}
 */
export function premiumCost({ premiumU, contracts, multiplier = OPTIONS_MULTIPLIER, feesU = 0 }) {
  if (!Number.isSafeInteger(premiumU) || premiumU <= 0) throw new RangeError('premiumU must be a positive integer number of u');
  if (!Number.isSafeInteger(contracts) || contracts <= 0) throw new RangeError('contracts must be a positive integer');
  if (!Number.isSafeInteger(feesU) || feesU < 0) throw new RangeError('feesU must be a non-negative integer');
  const premiumTotalU = premiumU * multiplier * contracts;
  const totalCostU = premiumTotalU + feesU;
  return { premiumU, contracts, multiplier, premiumTotalU, feesU, totalCostU, maxLossU: totalCostU };
}

/** Cash value at expiration of `contracts` long puts: max(0, K - S) x multiplier x contracts (u). */
export function expirationValue(contract, underlyingPriceU, contracts = 1) {
  if (!Number.isFinite(underlyingPriceU) || underlyingPriceU < 0) throw new RangeError('underlyingPriceU must be >= 0');
  const mult = contract.multiplier ?? OPTIONS_MULTIPLIER;
  return Math.max(0, contract.strike - underlyingPriceU) * mult * contracts;
}

/**
 * Outcome of holding long puts to expiration (cash-value model). Loss is capped at the premium paid incl. fees.
 */
export function longPutOutcome(contract, { premiumU, contracts, feesU = 0 }, underlyingPriceU) {
  const cost = premiumCost({ premiumU, contracts, multiplier: contract.multiplier ?? OPTIONS_MULTIPLIER, feesU });
  const valueU = expirationValue(contract, underlyingPriceU, contracts);
  const pnlU = valueU - cost.totalCostU;
  return {
    expirationValueU: valueU, totalCostU: cost.totalCostU, pnlU, maxLossU: cost.maxLossU,
    // Worst case for a long put (underlying at or above the strike): the whole premium plus fees is lost.
    worstCasePnlU: -cost.totalCostU,
    breakevenUnderlyingU: contract.strike - premiumU - Math.ceil(feesU / ((contract.multiplier ?? OPTIONS_MULTIPLIER) * contracts)),
    settlementModel: 'CASH_VALUE_AT_EXPIRATION (real options are physically settled; exercise/assignment not modelled)',
  };
}

/**
 * Validate a quote object from a VERIFIED options provider. Required shape:
 *   { status:'SUPPORTED_VERIFIED', provider:string, source_url?:string, dataset?:string,
 *     contract:{occ, underlying, expiry, strike, right:'P', multiplier:100},
 *     bid:int u, ask:int u, bidSize:int (contracts), askSize:int (contracts), quoteTs:ms UTC }
 * The quote must match the order's contract, be knowable at the clock (quoteTs <= clock), be two-sided and fresh.
 */
export function validateOptionsQuote(q, { clock, occ = null, maxQuoteAgeMs = 5 * MINUTE } = {}) {
  if (!q || typeof q !== 'object') return { ok: false, reason: OPTIONS_STATUS };
  if (q.status !== 'SUPPORTED_VERIFIED') return { ok: false, reason: OPTIONS_STATUS };
  if (typeof q.provider !== 'string' || !q.provider.trim()) return { ok: false, reason: 'OPTIONS_QUOTE_NO_PROVIDER' };
  const vc = validateContract(q.contract);
  if (!vc.ok) return { ok: false, reason: 'OPTIONS_QUOTE_CONTRACT_INVALID', errors: vc.errors };
  if (occ && vc.contract.occ !== String(occ).replace(/\s+/g, '')) return { ok: false, reason: 'OPTIONS_QUOTE_CONTRACT_MISMATCH' };
  if (!Number.isSafeInteger(q.bid) || !Number.isSafeInteger(q.ask) || q.bid <= 0 || q.ask <= 0 || q.ask < q.bid) return { ok: false, reason: 'OPTIONS_QUOTE_NOT_TWO_SIDED' };
  if (!Number.isFinite(q.quoteTs)) return { ok: false, reason: 'OPTIONS_QUOTE_NO_TIMESTAMP' };
  if (!Number.isFinite(clock)) return { ok: false, reason: 'OPTIONS_QUOTE_NO_CLOCK' };
  if (q.quoteTs > clock) return { ok: false, reason: 'OPTIONS_QUOTE_FROM_FUTURE' };
  if (clock - q.quoteTs > maxQuoteAgeMs) return { ok: false, reason: 'OPTIONS_QUOTE_STALE' };
  return { ok: true, contract: vc.contract };
}

/**
 * Gate for operational options orders. Without a verified provider quote -> NO_VERIFIED_OPTIONS_DATA.
 * Long puts only: opening is a BUY; a SELL may only close contracts already held (checked by the order engine).
 */
export function checkOperationalOptionOrder(spec, { clock, optionsQuote = null } = {}) {
  if (!optionsQuote) return { ok: false, code: OPTIONS_STATUS, errors: ['no verified options provider returned this contract and an as-of quote'] };
  const vc = validateContract(spec.contract);
  if (!vc.ok) return { ok: false, code: 'OPTIONS_CONTRACT_INVALID', errors: vc.errors };
  const vq = validateOptionsQuote(optionsQuote, { clock, occ: vc.contract.occ });
  if (!vq.ok) return { ok: false, code: vq.reason === OPTIONS_STATUS ? OPTIONS_STATUS : vq.reason, errors: vq.errors ?? [vq.reason] };
  if (spec.sym && spec.sym !== vc.contract.underlying) return { ok: false, code: 'OPTIONS_UNDERLYING_MISMATCH', errors: ['sym must equal the contract underlying'] };
  return { ok: true, contract: vc.contract, quote: optionsQuote };
}

/**
 * Conservative fill estimate for an option order against a verified provider quote (pure).
 * Buys pay the ask (+ slippage), sells receive the bid (- slippage), rounded to whole cents against the trader
 * (penny-increment assumption). Quantity capped at displayed contracts; buys reduced to what cash affords.
 */
export function evaluateOptionOrder(order, quote, costModel, ctx = {}) {
  const clock = ctx.clock;
  const vq = validateOptionsQuote(quote, { clock, occ: order.instrument_id });
  const observed = { provider: quote?.provider ?? null, source_url: quote?.source_url ?? null, dataset: quote?.dataset ?? null, occ: order.instrument_id, bid: quote?.bid ?? null, ask: quote?.ask ?? null, bidSize: quote?.bidSize ?? null, askSize: quote?.askSize ?? null, quoteTs: quote?.quoteTs ?? null };
  if (!vq.ok) return { action: 'unfillable', reason: vq.reason, observed };
  const remaining = order.qty - (order.filled_qty ?? 0);
  if (!(remaining > 0)) return { action: 'none', note: 'NOTHING_REMAINING' };
  const side = order.side;
  if (order.type !== 'market' && order.type !== 'limit') return { action: 'unfillable', reason: `UNSUPPORTED_OPTION_ORDER_TYPE:${order.type}`, observed };
  if (order.type === 'limit' && !Number.isSafeInteger(order.limit_px)) return { action: 'unfillable', reason: 'LIMIT_PRICE_INVALID', observed };
  const bps = costModel.slippageBps ?? 0;
  const base = side === 'buy' ? quote.ask : quote.bid;
  const raw = side === 'buy' ? Math.ceil(base * (1 + bps / 10000)) : Math.floor(base * (1 - bps / 10000));
  let priceU = side === 'buy' ? Math.ceil(raw / 100) * 100 : Math.floor(raw / 100) * 100;
  if (order.type === 'limit') {
    if (side === 'buy' ? quote.ask > order.limit_px : quote.bid < order.limit_px) return { action: 'none', note: 'LIMIT_NOT_REACHED' };
    priceU = side === 'buy' ? Math.min(priceU, order.limit_px) : Math.max(priceU, order.limit_px);
  }
  priceU = roundToTick(priceU, side);
  if (!Number.isSafeInteger(priceU) || priceU <= 0) return { action: 'unfillable', reason: 'NO_VALID_TICK_PRICE', observed };
  const displayed = side === 'buy' ? quote.askSize : quote.bidSize;
  if (!(displayed > 0)) return { action: 'unfillable', reason: 'ZERO_DISPLAYED_SIZE', observed };
  let qty = Math.min(remaining, displayed);
  if (side === 'sell') qty = Math.min(qty, Math.max(0, ctx.positionQty ?? 0));
  if (qty <= 0) return { action: 'unfillable', reason: 'NO_POSITION_HELD', observed };
  const feeOpts = { multiplier: OPTIONS_MULTIPLIER, firstFill: (order.filled_qty ?? 0) === 0, kind: 'option' };
  let fees = computeFees(side, qty, priceU, costModel, feeOpts);
  const hasSpendCap = side === 'buy' && Number.isFinite(ctx.maxSpendU);
  if (hasSpendCap) {
    const room = ctx.maxSpendU - Math.max(0, ctx.spentU ?? 0) - fees.commissionU;
    const capQty = room > 0 ? Math.floor(room / (priceU * OPTIONS_MULTIPLIER)) : 0;
    if (capQty < qty) {
      qty = Math.max(0, capQty);
      if (qty <= 0) return { action: 'unfillable', reason: 'SPEND_CAP_AT_ESTIMATED_PRICE', spendCapReached: true, observed };
      fees = computeFees(side, qty, priceU, costModel, feeOpts);
    }
  }
  if (side === 'buy' && qty * priceU * OPTIONS_MULTIPLIER + fees.totalU > (ctx.cashU ?? 0)) {
    qty = Math.min(qty, Math.floor(((ctx.cashU ?? 0) - fees.commissionU) / (priceU * OPTIONS_MULTIPLIER)));
    if (qty <= 0) return { action: 'unfillable', reason: 'INSUFFICIENT_CASH_AT_ESTIMATED_PRICE', observed };
    fees = computeFees(side, qty, priceU, costModel, feeOpts);
  }
  return {
    action: 'fill', qty, priceU, feesU: fees.totalU, multiplier: OPTIONS_MULTIPLIER,
    assumptions: {
      model: OPTIONS_FILL_MODEL_ID, estimated: true, notExchangeExecution: true,
      priceBasis: side === 'buy' ? 'VERIFIED_PROVIDER_ASK' : 'VERIFIED_PROVIDER_BID', basePriceU: base, slippageBps: bps,
      tickRule: 'WHOLE_CENT_AGAINST_TRADER (penny-increment assumption)', fees: { ...fees, rounding: 'EACH_COMPONENT_UP_TO_WHOLE_U' },
      displayedSizeUsed: displayed, multiplier: OPTIONS_MULTIPLIER,
      ...(hasSpendCap ? { spendCap: { maxSpendU: ctx.maxSpendU, spentBeforeU: Math.max(0, ctx.spentU ?? 0) } } : {}),
      settlementModel: 'CASH_VALUE_AT_EXPIRATION; exercise/assignment not modelled',
      omitted: [...OMITTED_EFFECTS, 'per-contract options exchange/ORF/TAF fees'],
    },
    observed,
  };
}
