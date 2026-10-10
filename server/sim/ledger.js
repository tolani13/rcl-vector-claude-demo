// Paper ledger (docs/CONTRACTS.md section 3). Cash, positions, realized P&L and fees for the seven paper
// portfolios of a replay session. Only the seed money is fictional; every fill applied here is an ESTIMATE
// produced by server/sim/fills.js from observed IEX data, and is stored with `estimated = 1`.
//
// Invariants (enforced, throw): cash never < 0, position qty never < 0, sell qty <= held.
import { tx } from '../db.js';
import { append } from '../journal.js';
import { newId } from '../util/ids.js';
import { usdToU } from '../util/money.js';
import { etToUtc } from '../util/time.js';
import { quoteAsOf, lastTradeAsOf } from '../data/marketdata.js';
import { FILL_MODEL_ID } from './fills.js';
import { validateOptionsQuote, validateContract, expirationValue, OPTIONS_STATUS } from './options.js';

export const DEFAULT_STARTING_CASH_U = usdToU(10_000);

const LENSES = [['cowboy', 'Cowboy'], ['pragmatist', 'Pragmatist'], ['tightwad', 'Tightwad']];
const SEGMENTS = [['micro', 'Microcap'], ['large', 'Large-cap']];

/** The seven portfolio definitions: six lens x segment agent portfolios plus the manual sandbox. */
export const PORTFOLIO_DEFS = Object.freeze([
  ...SEGMENTS.flatMap(([seg, segLabel]) => LENSES.map(([lens, lensLabel]) => Object.freeze({
    id: `${lens}-${seg}`, name: `${lensLabel} · ${segLabel}`, lens, segment: seg, kind: 'agent',
  }))),
  Object.freeze({ id: 'sandbox', name: 'Manual sandbox', lens: null, segment: null, kind: 'sandbox' }),
]);
export const PORTFOLIO_IDS = Object.freeze(PORTFOLIO_DEFS.map((d) => d.id));

const OPEN_ORDER_STATUSES = ['pending_parent', 'working', 'triggered', 'partially_filled'];

/** Equity instrument ids are the symbol; option instrument ids are the compact OCC symbol. */
export function instrumentId(kind, symOrOcc) {
  return kind === 'option' ? String(symOrOcc).replace(/\s+/g, '') : String(symOrOcc);
}

/**
 * Run fn atomically. Uses BEGIN IMMEDIATE when no transaction is open, otherwise a SAVEPOINT so callers
 * (e.g. orders.processMinute) can compose ledger writes inside their own transaction.
 */
let spSeq = 0;
export function atomic(db, fn) {
  if (!db.isTransaction) return tx(db, fn);
  const sp = `sp_${++spSeq}`;
  db.exec(`SAVEPOINT ${sp}`);
  try {
    const r = fn();
    db.exec(`RELEASE ${sp}`);
    return r;
  } catch (e) {
    try { db.exec(`ROLLBACK TO ${sp}`); db.exec(`RELEASE ${sp}`); } catch { /* outer rollback will clean up */ }
    throw e;
  }
}

function assertCash(u, what) {
  if (!Number.isSafeInteger(u) || u <= 0) throw new RangeError(`${what} must be a positive integer number of u (1e-4 USD)`);
}

/**
 * Create the seven portfolios for a session. Idempotent: existing portfolios are left untouched.
 * @param {{startingCashU?: number|Record<string, number>, clock?: number|null}} opts
 *   startingCashU: one value for all portfolios, or a map by portfolio id (missing ids get the default $10,000).
 */
export function createSessionPortfolios(db, session_id, { startingCashU = DEFAULT_STARTING_CASH_U, clock = null } = {}) {
  if (!session_id || typeof session_id !== 'string') throw new TypeError('session_id is required');
  const byId = {};
  if (typeof startingCashU === 'number') {
    for (const id of PORTFOLIO_IDS) byId[id] = startingCashU;
  } else if (startingCashU && typeof startingCashU === 'object') {
    for (const k of Object.keys(startingCashU)) if (!PORTFOLIO_IDS.includes(k)) throw new RangeError(`unknown portfolio id in startingCashU: ${k}`);
    for (const id of PORTFOLIO_IDS) byId[id] = startingCashU[id] ?? DEFAULT_STARTING_CASH_U;
  } else {
    throw new TypeError('startingCashU must be a number or a map by portfolio id');
  }
  for (const id of PORTFOLIO_IDS) assertCash(byId[id], `startingCashU[${id}]`);

  return atomic(db, () => {
    const exists = db.prepare('SELECT 1 FROM portfolios WHERE id = ? AND session_id = ?');
    const ins = db.prepare(`INSERT INTO portfolios (id, session_id, name, lens, segment, kind, starting_cash, cash, realized_pnl, fees_paid, day_start_equity, created_wall)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?)`);
    const now = Date.now();
    for (const d of PORTFOLIO_DEFS) {
      if (exists.get(d.id, session_id)) continue;
      const cash = byId[d.id];
      ins.run(d.id, session_id, d.name, d.lens, d.segment, d.kind, cash, cash, cash, now);
      append(db, {
        session_id, ts_sim: clock, portfolio_id: d.id, actor: 'system', type: 'PORTFOLIO_CREATED', ref_id: d.id,
        payload: { name: d.name, lens: d.lens, segment: d.segment, kind: d.kind, startingCashU: cash, note: 'Seed money is simulated; it is the only fictional input.' },
      });
    }
    return listPortfolios(db, session_id);
  });
}

export function listPortfolios(db, session_id) {
  return db.prepare('SELECT * FROM portfolios WHERE session_id = ? ORDER BY rowid').all(session_id);
}

export function getPortfolio(db, session_id, portfolio_id) {
  return db.prepare('SELECT * FROM portfolios WHERE session_id = ? AND id = ?').get(session_id, portfolio_id) ?? null;
}

export function getPosition(db, session_id, portfolio_id, instrument_id) {
  return db.prepare('SELECT * FROM positions WHERE session_id = ? AND portfolio_id = ? AND instrument_id = ?')
    .get(session_id, portfolio_id, instrument_id) ?? null;
}

export function listPositions(db, session_id, portfolio_id) {
  return db.prepare('SELECT * FROM positions WHERE session_id = ? AND portfolio_id = ? AND qty > 0 ORDER BY opened_ts, instrument_id')
    .all(session_id, portfolio_id);
}

export function listOpenOrders(db, session_id, portfolio_id) {
  return db.prepare(`SELECT * FROM orders WHERE session_id = ? AND portfolio_id = ? AND status IN (${OPEN_ORDER_STATUSES.map(() => '?').join(',')})
    ORDER BY created_ts, rowid`).all(session_id, portfolio_id, ...OPEN_ORDER_STATUSES);
}

function parseJson(v) {
  try { return v ? JSON.parse(v) : null; } catch { return null; }
}

/** round(a * b / c) for non-negative integers, exact (BigInt). */
function mulDivRound(a, b, c) {
  const n = BigInt(a) * BigInt(b);
  const d = BigInt(c);
  return Number((2n * n + d) / (2n * d));
}

/**
 * Apply one estimated fill to the ledger, atomically with the fills row and the FILL_ESTIMATED journal entry.
 * @param {{session_id:string, order:object, fill:{qty:number, priceU:number, feesU:number, ts?:number, multiplier?:number,
 *          assumptions:object, observed:object, triggered?:boolean, worseThanStop?:boolean}, journalExtra?:object, ts_sim?:number}} a
 * @returns {{fillId:string, cashU:number, positionQty:number, costBasisU:number, realizedDeltaU:number}}
 */
export function applyFill(db, { session_id, order, fill, journalExtra = {}, ts_sim = null }) {
  if (!order || !fill) throw new TypeError('order and fill are required');
  const { qty, priceU, feesU } = fill;
  if (!Number.isSafeInteger(qty) || qty <= 0) throw new RangeError('fill qty must be a positive integer');
  if (!Number.isSafeInteger(priceU) || priceU <= 0) throw new RangeError('fill price must be a positive integer number of u');
  if (!Number.isSafeInteger(feesU) || feesU < 0) throw new RangeError('fill fees must be a non-negative integer number of u');
  if (order.side !== 'buy' && order.side !== 'sell') throw new RangeError(`invalid side ${order.side}`);
  const multiplier = fill.multiplier ?? (order.kind === 'option' ? 100 : 1);
  const ts = fill.ts ?? fill.observed?.minuteT ?? ts_sim;
  if (!Number.isFinite(ts)) throw new TypeError('fill ts (replay minute) is required');

  return atomic(db, () => {
    const pf = getPortfolio(db, session_id, order.portfolio_id);
    if (!pf) throw new Error(`portfolio ${order.portfolio_id} not found in session ${session_id}`);
    const instrument = order.instrument_id ?? instrumentId(order.kind ?? 'equity', order.sym);
    const posRow = getPosition(db, session_id, order.portfolio_id, instrument);
    const heldQty = posRow ? posRow.qty : 0;
    const heldCost = posRow ? posRow.cost_basis : 0;
    const grossU = qty * priceU * multiplier;
    if (!Number.isSafeInteger(grossU)) throw new RangeError('fill notional exceeds safe integer range');

    let cashAfter;
    let qtyAfter;
    let costAfter;
    let realizedDeltaU = 0;
    let costRemovedU = 0;
    if (order.side === 'buy') {
      const costU = grossU + feesU;
      cashAfter = pf.cash - costU;
      if (cashAfter < 0) throw new Error(`INVARIANT_CASH_NEGATIVE: buy costs ${costU} u but cash is ${pf.cash} u`);
      qtyAfter = heldQty + qty;
      costAfter = heldCost + costU;
    } else {
      if (qty > heldQty) throw new Error(`INVARIANT_OVERSELL: sell ${qty} exceeds held ${heldQty} (no shorting)`);
      const proceedsU = grossU - feesU;
      costRemovedU = qty === heldQty ? heldCost : mulDivRound(heldCost, qty, heldQty);
      realizedDeltaU = proceedsU - costRemovedU;
      cashAfter = pf.cash + proceedsU;
      if (cashAfter < 0) throw new Error(`INVARIANT_CASH_NEGATIVE: sell fees exceed cash (cash ${pf.cash} u, proceeds ${proceedsU} u)`);
      qtyAfter = heldQty - qty;
      costAfter = heldCost - costRemovedU;
    }
    if (qtyAfter < 0) throw new Error('INVARIANT_QTY_NEGATIVE');

    db.prepare('UPDATE portfolios SET cash = ?, realized_pnl = realized_pnl + ?, fees_paid = fees_paid + ? WHERE id = ? AND session_id = ?')
      .run(cashAfter, realizedDeltaU, feesU, order.portfolio_id, session_id);
    if (qtyAfter === 0) {
      db.prepare('DELETE FROM positions WHERE session_id = ? AND portfolio_id = ? AND instrument_id = ?').run(session_id, order.portfolio_id, instrument);
    } else if (posRow) {
      db.prepare('UPDATE positions SET qty = ?, cost_basis = ?, updated_ts = ? WHERE session_id = ? AND portfolio_id = ? AND instrument_id = ?')
        .run(qtyAfter, costAfter, ts, session_id, order.portfolio_id, instrument);
    } else {
      db.prepare(`INSERT INTO positions (session_id, portfolio_id, instrument_id, sym, kind, qty, multiplier, cost_basis, opened_ts, updated_ts, meta_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(session_id, order.portfolio_id, instrument, order.sym, order.kind ?? 'equity',
        qtyAfter, multiplier, costAfter, ts, ts, order.kind === 'option' && order.meta_json ? order.meta_json : null);
    }

    const fillId = newId('fill');
    const model = fill.assumptions?.model ?? FILL_MODEL_ID;
    db.prepare(`INSERT INTO fills (id, session_id, order_id, portfolio_id, instrument_id, sym, side, qty, price, fees, ts, model, assumptions_json, estimated)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`).run(fillId, session_id, order.id, order.portfolio_id, instrument, order.sym, order.side,
      qty, priceU, feesU, ts, model, JSON.stringify({ assumptions: fill.assumptions ?? null, observed: fill.observed ?? null }));

    append(db, {
      session_id, ts_sim: ts_sim ?? ts, portfolio_id: order.portfolio_id, agent_id: order.agent_id ?? null, actor: 'engine', type: 'FILL_ESTIMATED', ref_id: fillId,
      payload: {
        fill_id: fillId, order_id: order.id, sym: order.sym, instrument_id: instrument, kind: order.kind ?? 'equity', side: order.side, role: order.role ?? null,
        qty, priceU, feesU, multiplier, grossU, minuteT: ts, model, estimated: true,
        note: 'ESTIMATED PAPER FILL — not an exchange execution',
        triggered: fill.triggered ?? undefined, worseThanStop: fill.worseThanStop ?? undefined,
        cashBeforeU: pf.cash, cashAfterU: cashAfter, positionQtyBefore: heldQty, positionQtyAfter: qtyAfter,
        costBasisRemovedU: order.side === 'sell' ? costRemovedU : undefined, realizedDeltaU,
        assumptions: fill.assumptions ?? null, observed: fill.observed ?? null,
        ...journalExtra,
      },
    });
    return { fillId, cashU: cashAfter, positionQty: qtyAfter, costBasisU: costAfter, realizedDeltaU };
  });
}

/**
 * Mark open positions as of `asOf` (replay clock). Equity longs are marked at the IEX BID as-of (conservative);
 * with no two-sided quote: last IEX trade (`LAST_TRADE_NO_BID`); with neither: `UNMARKED` and value null.
 * Options: marked at the BID of a verified options provider quote knowable at asOf (opts.optionsProvider.quoteAsOf);
 * without one (always, in this build's replay) -> `UNMARKED` with status NO_VERIFIED_OPTIONS_DATA.
 */
export function markToMarket(db, ds, session_id, portfolio_id, asOf, { optionsProvider = null } = {}) {
  const rows = listPositions(db, session_id, portfolio_id);
  const positions = rows.map((p) => {
    const base = {
      instrument_id: p.instrument_id, sym: p.sym, kind: p.kind, qty: p.qty, multiplier: p.multiplier,
      costBasisU: p.cost_basis, openedTs: p.opened_ts,
    };
    const unmarked = (status) => ({ ...base, markU: null, markBasis: 'UNMARKED', status, valueU: null, unrealizedU: null, quote: null });
    if (p.kind === 'option') {
      const contract = parseJson(p.meta_json)?.contract ?? null;
      const q = contract && Number.isFinite(asOf) && optionsProvider?.quoteAsOf ? optionsProvider.quoteAsOf(contract, asOf) : null;
      if (!q || !validateOptionsQuote(q, { clock: asOf, occ: p.instrument_id }).ok) return unmarked(OPTIONS_STATUS);
      const valueU = q.bid * p.qty * p.multiplier;
      return {
        ...base, markU: q.bid, markBasis: 'VERIFIED_OPTIONS_BID', markTs: q.quoteTs, status: 'MARKED', valueU, unrealizedU: valueU - p.cost_basis,
        quote: { provider: q.provider, dataset: q.dataset ?? null, bid: q.bid, ask: q.ask, bidSize: q.bidSize, askSize: q.askSize, quoteTs: q.quoteTs },
      };
    }
    if (!ds || !Number.isFinite(asOf)) return unmarked('NO_VERIFIED_DATA');
    const q = quoteAsOf(db, ds, p.sym, asOf);
    let markU = null;
    let markBasis = 'UNMARKED';
    let markTs = null;
    if (q && q.twoSided && q.bid > 0) {
      markU = q.bid; markBasis = 'IEX_BID'; markTs = q.quoteTs;
    } else {
      const lt = lastTradeAsOf(db, ds, p.sym, asOf);
      if (lt) { markU = lt.priceU; markBasis = 'LAST_TRADE_NO_BID'; markTs = lt.knowableAt; }
    }
    if (markU == null) return unmarked('NO_VERIFIED_DATA');
    const valueU = markU * p.qty * p.multiplier;
    return {
      ...base, markU, markBasis, markTs, status: q?.halted ? 'HALTED' : 'MARKED', valueU, unrealizedU: valueU - p.cost_basis,
      quote: q ? { bid: q.bid, ask: q.ask, bidSize: q.bidSize, askSize: q.askSize, quoteTs: q.quoteTs, ageMs: q.ageMs, twoSided: q.twoSided, halted: q.halted, source: q.source } : null,
    };
  });
  const marked = positions.filter((p) => p.valueU != null);
  return {
    asOf, ds: ds ?? null, portfolio_id,
    positions,
    marketValueU: marked.reduce((s, p) => s + p.valueU, 0),
    unrealizedU: marked.reduce((s, p) => s + p.unrealizedU, 0),
    unmarkedCount: positions.length - marked.length,
  };
}

/**
 * Portfolio summary as of `asOf`. equityU = cash + marked position values; UNMARKED positions contribute 0
 * (conservative for long-only books) and `equityBasis` says so.
 */
export function portfolioSummary(db, ds, session_id, portfolio_id, asOf, opts = {}) {
  const pf = getPortfolio(db, session_id, portfolio_id);
  if (!pf) return null;
  const mtm = markToMarket(db, ds, session_id, portfolio_id, asOf, opts);
  return {
    portfolio: { id: pf.id, session_id: pf.session_id, name: pf.name, lens: pf.lens, segment: pf.segment, kind: pf.kind, startingCashU: pf.starting_cash, dayStartEquityU: pf.day_start_equity },
    asOf,
    cashU: pf.cash,
    equityU: pf.cash + mtm.marketValueU,
    equityBasis: mtm.unmarkedCount > 0 ? 'CONSERVATIVE_UNMARKED_POSITIONS_AT_ZERO' : 'CASH_PLUS_IEX_BID_MARKS',
    unrealizedU: mtm.unrealizedU,
    realizedU: pf.realized_pnl,
    feesU: pf.fees_paid,
    unmarkedCount: mtm.unmarkedCount,
    positions: mtm.positions,
    openOrders: listOpenOrders(db, session_id, portfolio_id).map((o) => ({ ...o, meta: o.meta_json ? JSON.parse(o.meta_json) : null, meta_json: undefined })),
  };
}

/**
 * Settle a long-put position at expiration under the CASH-VALUE model: credits max(0, K - S) x 100 x contracts,
 * realizes value - cost basis, closes the position and journals OPTION_EXPIRED (actor engine). Real equity options are
 * physically settled; exercise/assignment are NOT modelled. Allowed only at/after 16:00 ET on the contract's expiry
 * date, with an underlying price knowable at the clock. The replay engine does not call this in this build.
 * @param {{session_id:string, portfolio_id:string, instrument_id:string, clock:number,
 *          underlying:{priceU:number, knowableTs:number, basis:string, source?:object}}} a
 * @returns {{ok:true, expirationValueU:number, realizedDeltaU:number, cashU:number} | {ok:false, code:string, detail:string}}
 */
export function settleLongPutAtExpiration(db, { session_id, portfolio_id, instrument_id, clock, underlying }) {
  const no = (code, detail) => ({ ok: false, code, detail });
  if (!Number.isFinite(clock)) return no('CLOCK_REQUIRED', 'replay clock required');
  return atomic(db, () => {
    const pos = getPosition(db, session_id, portfolio_id, instrument_id);
    if (!pos || pos.kind !== 'option' || !(pos.qty > 0)) return no('NO_OPTION_POSITION', `no open option position ${instrument_id}`);
    const vc = validateContract(parseJson(pos.meta_json)?.contract);
    if (!vc.ok) return no('OPTIONS_CONTRACT_INVALID', vc.errors.join('; '));
    const contract = vc.contract;
    const expiresAt = etToUtc(contract.expiry, 16, 0);
    if (clock < expiresAt) return no('OPTION_NOT_EXPIRED', `contract expires at ${expiresAt}; clock ${clock}`);
    if (!underlying || !Number.isSafeInteger(underlying.priceU) || underlying.priceU <= 0) return no('UNDERLYING_PRICE_REQUIRED', 'an observed underlying price (integer u) is required');
    if (!Number.isFinite(underlying.knowableTs) || underlying.knowableTs > clock) return no('UNDERLYING_FROM_FUTURE', 'underlying price must be knowable at the clock');
    const pf = getPortfolio(db, session_id, portfolio_id);
    const valueU = expirationValue(contract, underlying.priceU, pos.qty);
    const realizedDeltaU = valueU - pos.cost_basis;
    const cashAfter = pf.cash + valueU;
    db.prepare('UPDATE portfolios SET cash = ?, realized_pnl = realized_pnl + ? WHERE id = ? AND session_id = ?').run(cashAfter, realizedDeltaU, portfolio_id, session_id);
    db.prepare('DELETE FROM positions WHERE session_id = ? AND portfolio_id = ? AND instrument_id = ?').run(session_id, portfolio_id, instrument_id);
    append(db, {
      session_id, ts_sim: clock, portfolio_id, agent_id: null, actor: 'engine', type: 'OPTION_EXPIRED', ref_id: instrument_id,
      payload: {
        instrument_id, contract, contracts: pos.qty, multiplier: pos.multiplier,
        underlyingPriceU: underlying.priceU, underlyingBasis: underlying.basis ?? null, underlyingKnowableTs: underlying.knowableTs, underlyingSource: underlying.source ?? null,
        intrinsicPerShareU: Math.max(0, contract.strike - underlying.priceU), expirationValueU: valueU, costBasisU: pos.cost_basis, realizedDeltaU,
        cashBeforeU: pf.cash, cashAfterU: cashAfter, expiresAt,
        settlementModel: 'CASH_VALUE_AT_EXPIRATION (real options are physically settled; exercise/assignment not modelled)',
        note: 'Loss is capped at the premium paid incl. fees: expiration value is never negative.',
      },
    });
    return { ok: true, expirationValueU: valueU, realizedDeltaU, cashU: cashAfter, contracts: pos.qty };
  });
}
