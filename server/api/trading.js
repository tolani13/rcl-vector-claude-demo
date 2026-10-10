// Paper portfolios, human (sandbox) orders, cancel/replace and the journal (docs/CONTRACTS.md section 9).
//
// Every human order action becomes a typed TradeIntent (source 'human', trusted envelope built here from the replay
// clock) and passes the same deterministic policy gate as agent intents (human_confirmed requires confirm === true;
// humans place orders in the sandbox only, cancels are allowed anywhere). Every attempt is journaled: INTENT_PROPOSED,
// POLICY_ACCEPT / POLICY_DENY, then the orders engine's ORDER_SUBMITTED / ORDER_CANCELLED / ORDER_REPLACED / ORDER_REJECTED.
// Accepted orders are evaluated by the orders engine only after the next replay minute completes (estimated fills).
// Sandbox equity orders are gated with the segment-appropriate cost model (configured large-cap list -> large, else
// micro; the same rule as the Lab estimate) and record that segment and the gate estimate on the order.
import { MINUTE } from '../util/time.js';
import { newId } from '../util/ids.js';
import { append, list as journalList, verifyChainFrom } from '../journal.js';
import { quoteAsOf } from '../data/marketdata.js';
import { largeCapList } from '../data/universe.js';
import { intentFromProposal } from '../agents/intents.js';
import { evaluate, buildGateContext, journalDecision } from '../policy/gate.js';
import { defaultPolicyFor } from '../policy/config.js';
import { defaultCostModel } from '../sim/fills.js';
import { listPortfolios, portfolioSummary, PORTFOLIO_IDS } from '../sim/ledger.js';
import { submitOrder, cancelOrder, replaceOrder, getOrder } from '../sim/orders.js';
import {
  ApiError, badRequest, conflict, notFound, created, onlyKeys, query, id as idOf, oneOf, intIn, bool, text, symbol, summarizeBody, ID_RE, SYM_RE,
} from './http.js';

const HUMAN_INTENT_TTL_MS = 5 * MINUTE;
const NO_SESSION = 'No replay session exists; reset the replay first.';
const NO_DATA = 'No verified market dataset is loaded; orders cannot be evaluated (NO_VERIFIED_DATA).';

function parseJson(s) {
  try { return s ? JSON.parse(s) : null; } catch { return null; }
}

/** Active replay with a verified dataset and a clock, or an ApiError (409). */
function activeReplay(ctx) {
  const st = ctx.replay();
  if (!st.session_id) throw conflict('NO_SESSION', NO_SESSION);
  if (!st.ds || !Number.isFinite(st.clock)) throw conflict('NO_VERIFIED_DATA', NO_DATA);
  return st;
}

/** Journal a refused human request. The request is stored as a bounded summary (the journal is append-only). */
export function journalHumanRefusal(ctx, st, { portfolio_id = null, code, detail, body, ref_id = null }) {
  append(ctx.db, {
    session_id: st?.session_id ?? null, ts_sim: st?.clock ?? null, portfolio_id, actor: 'human', type: 'ORDER_REJECTED', ref_id,
    payload: { stage: 'api_validation', code, detail: String(detail).slice(0, 1000), request: summarizeBody(body) },
  });
}

/** Cost-model segment for a human sandbox equity order: the configured large-cap list -> 'large', else 'micro'. */
export function sandboxCostSegment(sym) {
  return largeCapList().includes(sym) ? 'large' : 'micro';
}

const M1_REF_RE = /^iex-m1:.+:[A-Z][A-Z0-9.\-]{0,9}:(\d{1,15})$/;

/**
 * Knowable times of the evidence refs an intent cites, for the gate's evidence_not_future rule: 'iex-m1:<ds>:<sym>:<t>'
 * (an IEX minute, knowable once complete at t + 60 s) or an evidence-store id (knowable_ts). Unknown refs are omitted.
 */
function evidenceIndexFor(db, refs) {
  if (!Array.isArray(refs) || !refs.length) return null;
  const idx = new Map();
  const stmt = db.prepare('SELECT knowable_ts FROM evidence WHERE id = ?');
  for (const ref of refs.slice(0, 50)) {
    if (typeof ref !== 'string' || !ref || ref.length > 200) continue;
    const m = M1_REF_RE.exec(ref);
    if (m) { idx.set(ref, Number(m[1]) + MINUTE); continue; }
    const r = stmt.get(ref);
    if (r) idx.set(ref, r.knowable_ts);
  }
  return idx;
}

/**
 * Build a human TradeIntent from a proposal, run it through the policy gate and journal everything.
 * @returns {{st:object, intent:object, gate:object}}
 */
export function gateHumanIntent(ctx, { proposal, portfolio_id, confirm, requestBody }) {
  const { db } = ctx;
  const st = activeReplay(ctx);
  const clock = st.clock;
  const sym = proposal?.instrument?.sym;
  const isEquity = proposal?.instrument?.kind === 'equity';
  const symOk = typeof sym === 'string' && SYM_RE.test(sym);
  const q = isEquity && symOk ? quoteAsOf(db, st.ds, sym, clock) : null;
  const v = intentFromProposal(proposal, {
    id: newId('int'), source: 'human', agent_id: null, portfolio_id, strategy_id: null,
    quote_ts: q && q.quoteTs <= clock ? q.quoteTs : clock, created_ts: clock, expires_ts: clock + HUMAN_INTENT_TTL_MS,
  });
  if (!v.ok) {
    journalHumanRefusal(ctx, st, { portfolio_id, code: 'INTENT_INVALID', detail: v.errors.join('; '), body: requestBody });
    throw badRequest('INTENT_INVALID', v.errors.slice(0, 8).join('; '), { errors: v.errors });
  }
  const intent = v.intent;
  append(db, {
    session_id: st.session_id, ts_sim: clock, portfolio_id, agent_id: null, actor: 'human', type: 'INTENT_PROPOSED', ref_id: intent.id,
    payload: { kind: `human_${intent.action}`, source: 'human', confirm: confirm === true, intent, note: 'Human paper-order request; the deterministic policy gate decides.' },
  });
  const costSegment = portfolio_id === 'sandbox' && isEquity && symOk ? sandboxCostSegment(sym) : null;
  const gctx = buildGateContext(db, {
    session_id: st.session_id, ds: st.ds, clock, intent, confirm: confirm === true, ...(isEquity ? { quote: q } : {}),
    ...(costSegment ? { costModel: defaultCostModel(costSegment) } : {}),
    evidenceIndex: evidenceIndexFor(db, intent.evidence_refs),
  });
  const gate = evaluate(intent, gctx);
  journalDecision(db, { session_id: st.session_id, ts_sim: clock, intent, result: gate, intent_id: intent.id });
  db.prepare(`INSERT INTO intents (id, session_id, agent_id, portfolio_id, ts, source, intent_json, decision, reasons_json, order_ids_json)
    VALUES (?, ?, NULL, ?, ?, 'human', ?, ?, ?, NULL)`).run(intent.id, st.session_id, portfolio_id, clock, JSON.stringify(intent), gate.decision, JSON.stringify(gate.reasons));
  return { st, intent, gate, costSegment };
}

function setIntentOrders(db, intentId, ids) {
  db.prepare('UPDATE intents SET order_ids_json = ? WHERE id = ?').run(JSON.stringify(ids), intentId);
}

function denied(gate, intent) {
  const first = gate.reasons[0] ?? { code: 'DENIED', detail: 'policy gate denied the intent' };
  return new ApiError(409, first.code, `Policy gate DENIED: ${gate.reasons.map((r) => `${r.code} (${r.detail})`).join('; ')}`.slice(0, 1000), {
    decision: 'DENIED', intent_id: intent.id, reasons: gate.reasons, checks: gate.checks, estimate: gate.estimate, policy: gate.policy,
  });
}

function orderView(o) {
  if (!o) return null;
  const { meta_json, ...rest } = o;
  return { ...rest, protective: o.protective === 1, meta: parseJson(meta_json) };
}

// ---------------------------------------------------------------------------------------------------------------
// Portfolios

function summaryView(s) {
  if (!s) return null;
  return { ...s, pnlU: s.equityU - s.portfolio.startingCashU, openOrders: s.openOrders };
}

/** GET /api/portfolios — all seven portfolios of the current session, marked at the IEX bid as of the replay clock. */
export function getPortfolios(ctx, _req, { url }) {
  query(url, []);
  const st = ctx.replay();
  if (!st.session_id) return { session_id: null, asOf: null, status: 'NO_SESSION', detail: NO_SESSION, rows: [] };
  const rows = listPortfolios(ctx.db, st.session_id).map((p) => summaryView(portfolioSummary(ctx.db, st.ds, st.session_id, p.id, st.clock)));
  // The portfolios are paper artifacts: `status` says so; `marksStatus` (data vocabulary) describes the quotes used for marks.
  return {
    session_id: st.session_id, ds: st.ds, asOf: st.clock, status: st.ds ? 'PAPER' : 'NO_VERIFIED_DATA',
    marksStatus: st.ds ? 'HISTORICAL_REAL' : 'NO_VERIFIED_DATA',
    label: 'PAPER PORTFOLIOS — simulated seed money; ESTIMATED PAPER FILLS; positions marked at HISTORICAL_REAL IEX quotes as of the replay clock',
    note: 'Seed money is simulated. Positions are marked at the IEX bid as of the replay clock; every fill is an ESTIMATED PAPER FILL.',
    rows,
  };
}

/** GET /api/portfolios/:id — summary, recent estimated fills, cost model and policy limits. */
export function getPortfolio(ctx, _req, { url, params }) {
  query(url, []);
  const pid = idOf(params.id, 'portfolio id');
  if (!PORTFOLIO_IDS.includes(pid)) throw notFound('PORTFOLIO_NOT_FOUND', `unknown portfolio ${pid}`);
  const st = ctx.replay();
  if (!st.session_id) throw notFound('NO_SESSION', NO_SESSION);
  const s = portfolioSummary(ctx.db, st.ds, st.session_id, pid, st.clock);
  if (!s) throw notFound('PORTFOLIO_NOT_FOUND', `portfolio ${pid} not found in session ${st.session_id}`);
  const fills = ctx.db.prepare(`SELECT f.*, o.role, o.type AS order_type FROM fills f LEFT JOIN orders o ON o.id = f.order_id
    WHERE f.session_id = ? AND f.portfolio_id = ? ORDER BY f.ts DESC, f.rowid DESC LIMIT 200`).all(st.session_id, pid)
    .map(({ assumptions_json, ...f }) => {
      const a = parseJson(assumptions_json) || {};
      return { ...f, estimated: f.estimated === 1, label: 'ESTIMATED PAPER FILL', assumptions: a.assumptions ?? null, observed: a.observed ?? null };
    });
  const recentOrders = ctx.db.prepare(`SELECT * FROM orders WHERE session_id = ? AND portfolio_id = ? ORDER BY created_ts DESC, rowid DESC LIMIT 100`)
    .all(st.session_id, pid).map(orderView);
  const sandbox = s.portfolio.kind === 'sandbox';
  return {
    ...summaryView(s), session_id: st.session_id, ds: st.ds,
    fills, recentOrders,
    costModel: defaultCostModel(s.portfolio.segment),
    ...(sandbox ? {
      costModels: { micro: defaultCostModel('micro'), large: defaultCostModel('large') },
      costModelRule: 'Sandbox orders are gated with the large-cap cost model when the symbol is on the configured large-cap list, otherwise the micro-cap model (the segment is recorded on each order as meta.cost_segment).',
    } : {}),
    policy: defaultPolicyFor(pid),
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Orders

const ORDER_KEYS = ['source', 'portfolio_id', 'action', 'instrument', 'side', 'qty', 'budget_usd', 'order_type', 'limit_px_u', 'stop_px_u',
  'attach', 'rationale', 'evidence_refs', 'confirm'];

/** POST /api/orders — human sandbox paper order (requires confirm:true; decided by the policy gate). */
export function postOrder(ctx, _req, { body }) {
  onlyKeys(body, ORDER_KEYS);
  if (body.source !== undefined && body.source !== 'human') throw badRequest('SOURCE_INVALID', "source must be 'human' (agents act only through the runner)");
  const portfolio_id = body.portfolio_id === undefined ? 'sandbox' : idOf(body.portfolio_id, 'portfolio_id');
  if (!PORTFOLIO_IDS.includes(portfolio_id)) {
    journalHumanRefusal(ctx, ctx.replay(), { code: 'PORTFOLIO_NOT_FOUND', detail: `unknown portfolio ${portfolio_id}`, body });
    throw notFound('PORTFOLIO_NOT_FOUND', `unknown portfolio ${portfolio_id} (humans place orders in 'sandbox')`);
  }
  const a = body.attach;
  if (a && typeof a === 'object' && !Array.isArray(a) && (a.time_exit_min != null || a.time_exit_band_bps != null)) {
    // Time exits are executed by the agent runner; nothing monitors a human sandbox position, so they are refused.
    const detail = 'attach.time_exit_min / time_exit_band_bps are not supported for human sandbox orders (no agent monitors the position); use a stop-loss / take-profit bracket or place the exit yourself';
    journalHumanRefusal(ctx, ctx.replay(), { portfolio_id, code: 'TIME_EXIT_NOT_SUPPORTED', detail, body });
    throw badRequest('TIME_EXIT_NOT_SUPPORTED', detail);
  }
  const action = oneOf(body.action, ['open', 'close'], 'action');
  const confirm = bool(body.confirm, 'confirm', { optional: true, dflt: false });
  if (!body.instrument || typeof body.instrument !== 'object' || Array.isArray(body.instrument)) throw badRequest('INSTRUMENT_INVALID', 'instrument {kind:"equity", sym} is required');
  onlyKeys(body.instrument, ['kind', 'sym'], 'instrument');
  if (body.instrument.kind !== 'equity') throw badRequest('INSTRUMENT_INVALID', 'only equity orders are accepted here (long puts: POST /api/options/orders)');
  const sym = symbol(body.instrument.sym, 'instrument.sym');
  if (action === 'close' && body.qty === undefined) throw badRequest('QTY_REQUIRED', 'a sell (close) needs qty in whole shares');
  const rationale = text(body.rationale, 2000, 'rationale', { optional: true, dflt: 'Human sandbox paper order' }) || 'Human sandbox paper order';
  const proposal = {
    action, instrument: { kind: 'equity', sym }, side: body.side, order_type: body.order_type, rationale,
    evidence_refs: body.evidence_refs === undefined ? [] : body.evidence_refs,
  };
  for (const k of ['qty', 'budget_usd', 'limit_px_u', 'stop_px_u', 'attach']) if (body[k] !== undefined && body[k] !== null) proposal[k] = body[k];

  const { st, intent, gate, costSegment } = gateHumanIntent(ctx, { proposal, portfolio_id, confirm, requestBody: body });
  if (gate.decision !== 'ACCEPTED') throw denied(gate, intent);

  const qty = intent.qty ?? gate.estimate?.qty;
  const octx = { session_id: st.session_id, ds: st.ds, clock: st.clock };
  // A sell stop / stop-limit protects a held long, so it is a protective stop_loss (kept by a KEEP_PROTECTIVE kill);
  // other sells are plain exits.
  const isStop = intent.order_type === 'stop' || intent.order_type === 'stop_limit';
  const role = intent.side === 'buy' ? 'entry' : isStop ? 'stop_loss' : 'exit';
  const e = gate.estimate;
  const meta = {
    source: 'human', confirmed: true,
    ...(costSegment ? { cost_segment: costSegment } : {}),
    ...(e ? { gate_estimate: { priceU: e.priceU, qty: e.qty, costU: e.costU, basis: e.basis, slippageBps: e.slippageBps } } : {}),
  };
  const r = submitOrder(ctx.db, octx, {
    portfolio_id, intent_id: intent.id, sym, kind: 'equity', side: intent.side, type: intent.order_type,
    role, qty, limit_px: intent.limit_px_u, stop_px: intent.stop_px_u,
    attach: intent.attach, actor: 'human', reason: intent.rationale.slice(0, 300), meta,
  });
  if (!r.ok) {
    setIntentOrders(ctx.db, intent.id, r.order ? [r.order.id] : []);
    throw conflict(r.code, `Order engine rejected the accepted intent: ${(r.errors || []).map((e) => `${e.code} (${e.detail})`).join('; ')}`.slice(0, 1000),
      { decision: 'REJECTED_BY_ORDER_ENGINE', intent_id: intent.id, errors: r.errors, reasons: (r.errors || []).map((e) => ({ code: e.code, detail: e.detail })) });
  }
  const ids = [r.order.id, ...r.children.map((c) => c.id)];
  setIntentOrders(ctx.db, intent.id, ids);
  return created({
    decision: 'ACCEPTED', intent_id: intent.id, order: orderView(r.order), children: r.children.map(orderView),
    estimate: gate.estimate, reasons: [], checks: gate.checks, policy: gate.policy,
    note: 'Accepted paper order. It is evaluated after the next completed replay minute; any fill is an ESTIMATED PAPER FILL, or is withheld (UNFILLABLE) when it cannot be credibly modelled.',
  });
}

function ownSessionOrder(ctx, st, orderId) {
  const o = getOrder(ctx.db, orderId);
  if (!o || o.session_id !== st.session_id) throw notFound('ORDER_NOT_FOUND', `order ${orderId} not found in the current session`);
  return o;
}

function instrumentOf(o) {
  const meta = parseJson(o.meta_json) || {};
  return o.kind === 'option' ? { kind: 'option', sym: o.sym, contract: meta.contract } : { kind: 'equity', sym: o.sym };
}

/** POST /api/orders/:id/cancel — human cancel (allowed for any portfolio, also while the kill switch is engaged). */
export function postCancel(ctx, _req, { params, body }) {
  onlyKeys(body, ['confirm', 'reason']);
  const orderId = idOf(params.id, 'order id');
  const confirm = bool(body.confirm, 'confirm', { optional: true, dflt: false });
  const reason = text(body.reason, 300, 'reason', { optional: true, dflt: null });
  const st = activeReplay(ctx);
  const o = ownSessionOrder(ctx, st, orderId);
  const proposal = {
    action: 'cancel', instrument: instrumentOf(o), side: o.side, order_type: o.type, target_order_id: o.id,
    rationale: reason || 'Human cancel request', evidence_refs: [],
  };
  const { intent, gate } = gateHumanIntent(ctx, { proposal, portfolio_id: o.portfolio_id, confirm, requestBody: body });
  if (gate.decision !== 'ACCEPTED') throw denied(gate, intent);
  const r = cancelOrder(ctx.db, { session_id: st.session_id, ds: st.ds, clock: st.clock }, o.id, { by: 'human', reason: reason || 'human cancel' });
  if (!r.ok) {
    setIntentOrders(ctx.db, intent.id, []);
    throw conflict(r.code, (r.errors || []).map((e) => e.detail).join('; ') || r.code, { decision: 'REJECTED_BY_ORDER_ENGINE', intent_id: intent.id });
  }
  setIntentOrders(ctx.db, intent.id, [o.id, ...(r.cascaded || [])]);
  return { decision: 'ACCEPTED', intent_id: intent.id, order: orderView(r.order), cascaded: r.cascaded || [], checks: gate.checks };
}

/** POST /api/orders/:id/replace — amend prices/qty of a working or pending sandbox order (same id). */
export function postReplace(ctx, _req, { params, body }) {
  onlyKeys(body, ['confirm', 'reason', 'limit_px_u', 'stop_px_u', 'qty']);
  const orderId = idOf(params.id, 'order id');
  const confirm = bool(body.confirm, 'confirm', { optional: true, dflt: false });
  const reason = text(body.reason, 300, 'reason', { optional: true, dflt: null });
  if (body.limit_px_u === undefined && body.stop_px_u === undefined && body.qty === undefined) throw badRequest('NOTHING_TO_REPLACE', 'give limit_px_u, stop_px_u and/or qty');
  if (body.qty !== undefined) intIn(body.qty, 1, 1e12, 'qty');
  if (body.limit_px_u !== undefined) intIn(body.limit_px_u, 1, 1e12, 'limit_px_u');
  if (body.stop_px_u !== undefined) intIn(body.stop_px_u, 1, 1e12, 'stop_px_u');
  const st = activeReplay(ctx);
  const o = ownSessionOrder(ctx, st, orderId);
  const needLimit = o.type === 'limit' || o.type === 'stop_limit';
  const needStop = o.type === 'stop' || o.type === 'stop_limit';
  if (body.limit_px_u !== undefined && !needLimit) throw badRequest('LIMIT_NOT_ALLOWED', `limit_px_u not allowed for a ${o.type} order`);
  if (body.stop_px_u !== undefined && !needStop) throw badRequest('STOP_NOT_ALLOWED', `stop_px_u not allowed for a ${o.type} order`);
  // The gate evaluates a replace as 'modify', and its entry-only rules (daily loss cap, max position % of equity,
  // segment universe) do not run for modifies. A replace that adds buy exposure — more shares, a higher limit, or a
  // moved stop trigger on a buy — is therefore refused here: cancel and place a new order so every entry rule applies.
  // Reductions (lower qty / lower limit) and all sell-side replaces go through the gate as before.
  if (o.side === 'buy') {
    const grows = [];
    if (body.qty !== undefined && body.qty > o.qty) grows.push(`qty ${o.qty} -> ${body.qty}`);
    if (body.limit_px_u !== undefined && body.limit_px_u > o.limit_px) grows.push(`limit ${o.limit_px} u -> ${body.limit_px_u} u`);
    if (body.stop_px_u !== undefined && body.stop_px_u !== o.stop_px) grows.push(`stop trigger ${o.stop_px} u -> ${body.stop_px_u} u`);
    if (grows.length) {
      const detail = `replace would increase buy exposure (${grows.join(', ')}); entry rules are not evaluated for modifies — cancel this order and place a new one`;
      journalHumanRefusal(ctx, st, { portfolio_id: o.portfolio_id, code: 'REPLACE_INCREASES_BUY_EXPOSURE', detail, body, ref_id: o.id });
      throw conflict('REPLACE_INCREASES_BUY_EXPOSURE', detail, { decision: 'REFUSED', order_id: o.id });
    }
  }
  // Order qty is the total including what already filled; the gate judges what is still to trade (the remaining qty),
  // so a partly filled sell is checked against the shares still held. The engine refuses qty below filled_qty.
  const proposal = {
    action: 'modify', instrument: instrumentOf(o), side: o.side, order_type: o.type, target_order_id: o.id,
    qty: Math.max(1, (body.qty ?? o.qty) - (o.filled_qty ?? 0)), rationale: reason || 'Human replace request', evidence_refs: [],
    ...(needLimit ? { limit_px_u: body.limit_px_u ?? o.limit_px } : {}),
    ...(needStop ? { stop_px_u: body.stop_px_u ?? o.stop_px } : {}),
  };
  const { intent, gate } = gateHumanIntent(ctx, { proposal, portfolio_id: o.portfolio_id, confirm, requestBody: body });
  if (gate.decision !== 'ACCEPTED') throw denied(gate, intent);
  const terms = {};
  if (body.limit_px_u !== undefined) terms.limit_px = body.limit_px_u;
  if (body.stop_px_u !== undefined) terms.stop_px = body.stop_px_u;
  if (body.qty !== undefined) terms.qty = body.qty;
  const r = replaceOrder(ctx.db, { session_id: st.session_id, ds: st.ds, clock: st.clock }, o.id, { ...terms, by: 'human', reason: reason || 'human replace' });
  if (!r.ok) {
    setIntentOrders(ctx.db, intent.id, []);
    throw conflict(r.code, (r.errors || []).map((e) => e.detail).join('; ') || r.code, { decision: 'REJECTED_BY_ORDER_ENGINE', intent_id: intent.id });
  }
  setIntentOrders(ctx.db, intent.id, [o.id]);
  return { decision: 'ACCEPTED', intent_id: intent.id, order: orderView(r.order), checks: gate.checks };
}

// ---------------------------------------------------------------------------------------------------------------
// Journal

const HINDSIGHT_LABEL = 'HINDSIGHT — includes rows of other replay sessions recorded after the current replay clock (later fills, marks and quotes)';

const EVENT_TYPE_RE = /^[A-Z][A-Z0-9_]{0,59}$/;
export const MAX_EXCLUDE_TYPES = 20;

/** exclude_type=A,B,... -> deduplicated array of UPPER_SNAKE event types (at most MAX_EXCLUDE_TYPES), or null. */
function excludeTypes(raw) {
  if (raw === undefined || raw === '') return null;
  const items = String(raw).split(',').map((s) => s.trim());
  if (items.length > MAX_EXCLUDE_TYPES) throw badRequest('EXCLUDE_TYPE_INVALID', `exclude_type takes at most ${MAX_EXCLUDE_TYPES} event types`);
  for (const s of items) {
    if (!EVENT_TYPE_RE.test(s)) throw badRequest('EXCLUDE_TYPE_INVALID', 'exclude_type must be a comma-separated list of UPPER_SNAKE event types');
  }
  return [...new Set(items)];
}

/**
 * GET /api/journal?portfolio_id&agent_id&type&exclude_type&limit&before&session_id&hindsight&verify — newest first, plus
 * chain verification.
 *   session_id: 'current' (default) | 'all' | an id. Rows of OTHER sessions whose ts_sim is after the current replay clock are
 *   hidden (they would reveal later data for the replay in progress) unless hindsight=1, which returns them flagged.
 *   exclude_type: comma-separated event types (each ^[A-Z][A-Z0-9_]{0,59}$, at most 20) dropped server-side, e.g.
 *   AGENT_SCAN,MARK_TO_MARKET, so `limit` counts only the rows the caller wants.
 *   verify: 'incremental' (default; re-hash rows appended since the last verification in this process) | 'full'.
 *   Filters never change verification: the chain is always checked over the whole journal.
 */
export function getJournal(ctx, _req, { url }) {
  const q = query(url, ['portfolio_id', 'agent_id', 'type', 'exclude_type', 'limit', 'before', 'session_id', 'hindsight', 'verify']);
  const st = ctx.replay();
  const hindsight = ['1', 'true'].includes(oneOf(q.hindsight, ['0', '1', 'true', 'false'], 'hindsight', { optional: true, dflt: '0' }));
  const verify = oneOf(q.verify, ['incremental', 'full'], 'verify', { optional: true, dflt: 'incremental' });
  const filters = {
    portfolio_id: q.portfolio_id ? idOf(q.portfolio_id, 'portfolio_id') : null,
    agent_id: q.agent_id ? idOf(q.agent_id, 'agent_id') : null,
    type: null,
    exclude_types: excludeTypes(q.exclude_type),
    limit: intIn(q.limit, 1, 1000, 'limit', { optional: true, dflt: 100 }),
    before: intIn(q.before, 1, Number.MAX_SAFE_INTEGER, 'before', { optional: true, dflt: null }),
    session_id: null,
  };
  if (q.type) {
    if (!EVENT_TYPE_RE.test(q.type)) throw badRequest('TYPE_INVALID', 'type must be an UPPER_SNAKE event type');
    filters.type = q.type;
  }
  let scope = 'current';
  if (q.session_id === undefined || q.session_id === '' || q.session_id === 'current') filters.session_id = st.session_id;
  else if (q.session_id === 'all') scope = 'all';
  else {
    if (!ID_RE.test(q.session_id)) throw badRequest('ID_INVALID', 'session_id must be an id, "current" or "all"');
    filters.session_id = q.session_id;
    scope = q.session_id === st.session_id ? 'current' : q.session_id;
  }
  const clock = Number.isFinite(st.clock) ? st.clock : null;
  const visible_at = clock !== null && !hindsight ? { session_id: st.session_id, clock } : null;
  const noCurrent = scope === 'current' && !st.session_id;
  const rows = noCurrent ? [] : journalList(ctx.db, { ...filters, visible_at }).map(({ payload_json, ...r }) => ({
    ...r,
    prior_session: r.session_id !== st.session_id,
    hindsight: r.session_id !== st.session_id && clock !== null && r.ts_sim !== null && r.ts_sim > clock,
  }));
  const t0 = performance.now();
  const v = verifyChainFrom(ctx.db, verify === 'full' ? null : ctx.chainCheckpoint);
  ctx.chainCheckpoint = v.ok ? { seq: v.lastSeq, hash: v.lastHash, checked: v.checked } : null;
  return {
    current_session_id: st.session_id, asOf: clock, scope, filters, hindsight,
    ...(hindsight ? { label: HINDSIGHT_LABEL } : {}),
    note: hindsight
      ? 'hindsight=1: rows of other sessions after the current replay clock are included and flagged hindsight:true.'
      : `Scope ${scope}. Rows of other replay sessions with replay time after the current clock are hidden (add hindsight=1 to include them, flagged).`,
    rows,
    chain: {
      ok: v.ok, checked: v.checked, brokenAt: v.brokenAt, mode: v.mode, newlyChecked: v.newlyChecked,
      verifiedMs: Math.round(performance.now() - t0), scope: 'full journal (all sessions)',
      note: v.mode === 'incremental'
        ? 'Rows appended since the last verification in this server process were re-hashed and linked to the verified prefix; verify=full re-hashes every row.'
        : 'Every row was re-hashed from the genesis hash.',
    },
  };
}
