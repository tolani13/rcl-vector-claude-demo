// Agent runner (docs/CONTRACTS.md section 7). Called by the replay engine once per replay minute, AFTER the orders
// engine has processed the completed minute. Server-side; never tied to a browser tab.
//
// For every RUNNING agent, in agent-id order:
//   1. monitor   positions and the agent's own open orders (time exits, breakeven stop trails, stale entries,
//                orphan protective orders) — see strategies.planActions(),
//   2. scan      the segment universe as-of the replay clock (bounded: activity prefilter, maxScanSymbols),
//   3. decide    decisionMode `rules` | `model_confirm` | `model` (model modes call the injected rctx.assess();
//                no connected model => no entry is proposed: this step's rule-based management actions still go
//                through the gate, then the agent is BLOCKED with reason MODEL_DISCONNECTED and its pending entries
//                are cancelled),
//   4. gate      every TradeIntent through the deterministic policy gate (server/policy/gate.js),
//   5. submit    accepted intents through server/sim/orders.js (submit / replace / cancel).
// Model-sourced entries are clamped to the strategy's risk envelope (budget, displayed size, order type, a protective
// stop that is never looser than the strategy's) before they are gated. The kill switch / a pause during a model call
// stops the remaining calls of that step.
// Journal: AGENT_SCAN, INTENT_PROPOSED, POLICY_ACCEPT / POLICY_DENY (gate), ORDER_SUBMITTED / ORDER_REPLACED /
// ORDER_CANCELLED (orders engine), MODEL_CONFIRMATION, AGENT_BLOCKED, AGENT_FAULT, AGENT_STEP_CAP, TIME_EXIT_SUSPENDED.
// Any exception inside one agent => that agent becomes FAULTED (AGENT_FAULT); the step itself never throws.
import { newId } from '../util/ids.js';
import { append } from '../journal.js';
import { MINUTE } from '../util/time.js';
import { roundToTick, usdToU } from '../util/money.js';
import { replayWindowOf, universeAsOf } from '../data/marketdata.js';
import { defaultCostModel, slippedPrice, computeFees } from '../sim/fills.js';
import { portfolioSummary, getPortfolio, atomic } from '../sim/ledger.js';
import { submitOrder, cancelOrder, replaceOrder, getOrder } from '../sim/orders.js';
import { evaluate, buildGateContext, journalDecision, readKillState, resolveEvidenceRefs } from '../policy/gate.js';
import { intentFromProposal } from './intents.js';
import { computeSignals, planActions, validateStrategy, windowAggregatesCached, exitPrices, documentedStopAtEntry, STRATEGY_LABEL } from './strategies.js';
import { cancelAgentPendingEntries, journalTimeExitSuspension } from '../controls.js';
import { STANCES } from '../intel/prompts.js';
import { proposalToIntentDraft, runLensAssessments } from '../intel/assessments.js';

/** Global per-step bounds (per-agent bounds live in each strategy's `management`). */
export const RUNNER_LIMITS = Object.freeze({ maxAgentsPerStep: 12, maxOrdersPerStep: 24 });

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

class AgentError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

function parseJson(s, fallback = null) {
  try { return s ? JSON.parse(s) : fallback; } catch { return fallback; }
}

function costModelFor(rctx, agent) {
  const m = rctx.costModels || {};
  return m[agent.portfolio_id] ?? m[agent.segment] ?? defaultCostModel(agent.segment);
}

function modelAvailable(rctx) {
  if (typeof rctx.assess !== 'function') return false;
  // An assessor that resolves its provider per call (createLensAssessor) says synchronously whether one is configured.
  if (typeof rctx.assess.isConfigured === 'function') {
    try { if (!rctx.assess.isConfigured()) return false; } catch { return false; }
  }
  const st = rctx.model?.status;
  return !(st === 'DISCONNECTED' || st === 'FAULT');
}

function setLast(db, agentId, field, value) {
  const col = field === 'ok' ? 'last_ok_json' : 'last_fail_json';
  db.prepare(`UPDATE agents SET ${col} = ?, updated_wall = ? WHERE id = ?`).run(JSON.stringify(value), Date.now(), agentId);
}

const replayRc = (rctx) => ({ session_id: rctx.session_id ?? null, ds: rctx.ds ?? null, clock: rctx.clock ?? null });

/**
 * Set a RUNNING agent BLOCKED (e.g. MODEL_DISCONNECTED) and cancel its pending entry orders (no entry may fill without
 * a supervising RUNNING agent). Journals AGENT_BLOCKED. A human pause / kill that happened meanwhile (e.g. during a
 * model call) wins: a non-RUNNING agent is left as it is. `mg` = the management actions already gated this step.
 */
function blockAgent(db, rctx, agent, reason, detail, mg = { results: [], deferred: [] }) {
  const fail = { ts_sim: rctx.clock, wall: Date.now(), stage: 'model', code: reason, detail };
  const rc = replayRc(rctx);
  return atomic(db, () => {
    const r = db.prepare("UPDATE agents SET state = 'BLOCKED', state_reason = ?, last_fail_json = ?, updated_wall = ? WHERE id = ? AND state = 'RUNNING'")
      .run(reason, JSON.stringify(fail), Date.now(), agent.id);
    if (Number(r.changes) === 0) return { agent_id: agent.id, status: 'SKIPPED_NOT_RUNNING', results: mg.results };
    const cancelled = cancelAgentPendingEntries(db, rc, agent.id, { by: 'system', reason: `AGENT_BLOCKED:${reason}` });
    append(db, {
      session_id: rctx.session_id, ts_sim: rctx.clock, portfolio_id: agent.portfolio_id, agent_id: agent.id, actor: 'system', type: 'AGENT_BLOCKED', ref_id: agent.id,
      payload: {
        reason, detail, previousState: agent.state, cancelledPendingEntries: cancelled,
        managementActions: mg.results.map((x) => ({ kind: x.kind, sym: x.sym, decision: x.decision, code: x.code ?? null })),
        note: 'MODEL DISCONNECTED / ASSESSMENT NOT RUN — inference-dependent entry decisions are disabled and no entry was proposed. '
          + 'Rule-based management actions planned this step (stale-entry / orphan cancels, breakeven trails, time exits) were still sent through the policy gate; '
          + 'the agent\'s pending entry orders were cancelled; protective stop-loss / take-profit orders keep working. While BLOCKED the agent does not run, '
          + 'so time exits and breakeven trails are not evaluated (TIME_EXIT_SUSPENDED). A human must resume the agent after a model is connected.',
      },
    });
    journalTimeExitSuspension(db, rc, agent, { to: 'BLOCKED', reason });
    return { agent_id: agent.id, status: 'BLOCKED', reason, cancelled, results: mg.results, deferred: mg.deferred.length };
  });
}

/** Mark an agent FAULTED after an exception and cancel its pending entry orders. Never throws. */
function faultAgent(db, rctx, agent, err) {
  const code = typeof err?.code === 'string' ? err.code : 'AGENT_EXCEPTION';
  const detail = String(err?.message ?? err).slice(0, 300);
  let cancelled = [];
  try {
    const fail = { ts_sim: rctx.clock ?? null, wall: Date.now(), stage: 'fault', code, detail };
    db.prepare("UPDATE agents SET state = 'FAULTED', state_reason = ?, last_fail_json = ?, updated_wall = ? WHERE id = ?")
      .run(`${code}: ${detail}`.slice(0, 300), JSON.stringify(fail), Date.now(), agent.id);
    const rc = replayRc(rctx);
    let cancelError = null;
    try { cancelled = cancelAgentPendingEntries(db, rc, agent.id, { by: 'system', reason: 'AGENT_FAULTED' }); } catch (e) { cancelError = String(e?.message ?? e).slice(0, 200); }
    append(db, {
      session_id: rctx.session_id ?? null, ts_sim: rctx.clock ?? null, portfolio_id: agent.portfolio_id, agent_id: agent.id, actor: 'system',
      type: 'AGENT_FAULT', ref_id: agent.id,
      payload: {
        code, detail, previousState: agent.state, cancelledPendingEntries: cancelled, cancelError,
        note: 'Agent FAULTED; the replay step and other agents continue; its pending entry orders were cancelled; protective stop-loss / take-profit '
          + 'orders keep working; time exits are not evaluated while FAULTED; a human must restart it.',
      },
    });
    if (agent.state === 'RUNNING') {
      try { journalTimeExitSuspension(db, rc, agent, { to: 'FAULTED', reason: code }); } catch { /* best effort */ }
    }
  } catch { /* never crash the step */ }
  return { agent_id: agent.id, status: 'FAULTED', code, detail, cancelled };
}

/** Portfolio + order state an agent decides on (ledger reads, as-of marks). */
function loadAgentState(db, rctx, agent, costModel, session) {
  const { session_id, ds, clock } = rctx;
  const sum = portfolioSummary(db, ds, session_id, agent.portfolio_id, clock);
  const positions = sum.positions.filter((p) => p.kind === 'equity')
    .map((p) => ({ sym: p.sym, kind: p.kind, qty: p.qty, costBasisU: p.costBasisU, markU: p.markU, markBasis: p.markBasis }));
  const openOrders = sum.openOrders.map((o) => ({
    id: o.id, agent_id: o.agent_id, sym: o.sym, kind: o.kind, side: o.side, type: o.type, role: o.role, status: o.status, qty: o.qty,
    filled_qty: o.filled_qty, limit_px: o.limit_px, stop_px: o.stop_px, protective: o.protective === 1, created_ts: o.created_ts,
    parent_id: o.parent_id, oco_group: o.oco_group,
  }));
  const entryInfo = {};
  const lastEntry = db.prepare(`SELECT id, meta_json FROM orders WHERE session_id = ? AND portfolio_id = ? AND sym = ? AND role = 'entry'
    AND filled_qty > 0 ORDER BY created_ts DESC, rowid DESC LIMIT 1`);
  const fillAgg = db.prepare('SELECT MIN(ts) t0, SUM(qty) q, SUM(qty * price) pv FROM fills WHERE order_id = ?');
  for (const p of positions) {
    const o = lastEntry.get(session_id, agent.portfolio_id, p.sym);
    if (!o) continue;
    const f = fillAgg.get(o.id);
    const meta = parseJson(o.meta_json, {});
    entryInfo[p.sym] = {
      order_id: o.id, firstFillT: f?.t0 ?? null, avgFillPriceU: f?.q ? Math.round(Number(f.pv) / Number(f.q)) : null,
      timeExit: meta?.time_exit ? { minutes: meta.time_exit.minutes, band_bps: meta.time_exit.band_bps ?? null } : null,
    };
  }
  const entriesBySym = Object.fromEntries(db.prepare(`SELECT sym, COUNT(*) n FROM orders WHERE session_id = ? AND portfolio_id = ? AND agent_id = ?
    AND role = 'entry' AND status != 'rejected' GROUP BY sym`).all(session_id, agent.portfolio_id, agent.id).map((r) => [r.sym, Number(r.n)]));
  const lastExitTsBySym = Object.fromEntries(db.prepare(`SELECT sym, MAX(ts) t FROM fills WHERE session_id = ? AND portfolio_id = ? AND side = 'sell' GROUP BY sym`)
    .all(session_id, agent.portfolio_id).map((r) => [r.sym, Number(r.t)]));
  return {
    agent: { id: agent.id, portfolio_id: agent.portfolio_id, lens: agent.lens, segment: agent.segment },
    ds, session, costModel, portfolio: { cashU: sum.cashU, equityU: sum.equityU },
    positions, openOrders, entryInfo, entriesBySym, lastExitTsBySym,
  };
}

function universeFor(db, ds, clock, segment, step) {
  if (!step.universes.has(segment)) step.universes.set(segment, universeAsOf(db, ds, clock, segment));
  return step.universes.get(segment);
}

const compactSignal = (s) => s && ({
  sym: s.sym, priceU: s.priceU, ret_w: s.ret_w, accel: s.accel, relVol: s.relVol, baselineMin: s.baselineMin ?? null, baselineVolume: s.baselineVolume ?? null,
  buyShare: s.buyShare, volumeW: s.volumeW, tradesW: s.tradesW, spreadBps: s.spreadBps, quoteAgeMs: s.quoteAgeMs, halted: s.halted,
});

// ---- evidence refs (gate fact: evidence_not_future) ---------------------------------------------------------------
// The gate resolves every ref itself (gate.resolveEvidenceRefs: an `iex-m1:<ds>:<SYM>:<t>` ref only when that minute
// row is stored; an evidence-store id with the dataset-publication provenance rule). The runner uses the same resolver,
// so a ref the gate cannot resolve is never treated as resolved here.

/** Refs of `intent` the gate's resolver cannot resolve (agent intents citing them are denied EVIDENCE_UNRESOLVED). */
function unresolvedRefs(db, intent) {
  const refs = intent?.evidence_refs || [];
  const idx = resolveEvidenceRefs(db, refs);
  return refs.filter((r) => !idx.has(r));
}

/** A validated lens assessment, or the reason it is unusable. */
function checkAssessment(r, lens) {
  if (!isObj(r)) return { ok: false, code: 'ASSESSMENT_INVALID' };
  if (r.status !== 'OK') return { ok: false, code: String(r.status ?? 'ASSESSMENT_INVALID').slice(0, 60) };
  const o = r.output;
  if (!isObj(o) || o.lens !== lens || !STANCES.includes(o.stance)) return { ok: false, code: 'ASSESSMENT_INVALID' };
  return { ok: true };
}

const tickDown = (px) => roundToTick(px, 'sell'); // never above the given level
const tickUp = (px) => roundToTick(px, 'buy');    // never below the given level

/**
 * Model mode: turn a lens proposed_intent (USD) into a model-sourced TradeIntent with a trusted envelope, clamped to the
 * strategy's risk envelope (the model can tighten risk, never loosen it):
 *   order type   strategy.entry.orderType or 'limit' only (no stop entries); limit rounded DOWN to a valid tick,
 *   budget       min(model budget, strategy.entry.budgetUsd); qty <= what that budget buys at a conservative
 *                estimate (limit price, or IEX ask + slippage), and <= the displayed ask size when the strategy caps it,
 *   stop-loss    always attached: max(model stop, strategy stop) — a model stop at/above the IEX bid or looser than the
 *                strategy's is replaced by the strategy's; the same STOP_BELOW_MIN_TICK / STOP_AT_OR_ABOVE_BID rules as
 *                planActions apply,
 *   take-profit  the model's when above the stop, else the strategy's,
 *   time exit    the model's minutes when given, else the strategy's.
 * Returns {ok, errors, intent, envelope:{clamped[], ...}}.
 */
function modelIntent(p, { agent, strategy, sym, clock, quote, costModel }) {
  const fail = (msg) => ({ ok: false, errors: [msg], intent: null, envelope: null });
  if (!quote || !quote.twoSided || !(quote.ask > 0) || !(quote.bid > 0)) return fail('no two-sided as-of IEX quote to bound the model proposal');
  const draft = proposalToIntentDraft(p, { lens: agent.lens, segment: agent.segment, sym, asOf: clock, quoteTs: quote.quoteTs });
  const en = strategy.entry;
  const clamped = [];
  const allowedTypes = [...new Set([en.orderType, 'limit'])];
  if (!allowedTypes.includes(draft.order_type)) return fail(`order_type ${draft.order_type} is outside the strategy envelope (${allowedTypes.join(' | ')})`);
  let limitU;
  if (draft.order_type === 'limit') {
    if (!Number.isSafeInteger(draft.limit_px_u)) return fail('limit order without a limit price');
    limitU = tickDown(draft.limit_px_u);
    if (!(limitU >= 1)) return fail('limit price below one tick');
    if (limitU !== draft.limit_px_u) clamped.push(`limit ${draft.limit_px_u} u rounded down to a valid tick ${limitU} u`);
  }
  const budgetUsd = Math.min(draft.budget_usd ?? Infinity, en.budgetUsd);
  if (draft.budget_usd === undefined || draft.budget_usd > en.budgetUsd) clamped.push(`budget ${draft.budget_usd === undefined ? 'unset' : `$${draft.budget_usd}`} -> strategy budget $${en.budgetUsd}`);
  const cm = costModel || defaultCostModel(strategy.segment);
  const estPx = draft.order_type === 'limit' ? limitU : slippedPrice(quote.ask, 'buy', cm.slippageBps ?? 0);
  const commissionU = computeFees('buy', 1, estPx, cm).commissionU;
  let maxQty = Math.floor((usdToU(budgetUsd) - commissionU) / estPx);
  if (en.capQtyToDisplayedAsk && quote.askSize > 0 && maxQty > quote.askSize) maxQty = quote.askSize;
  if (!(maxQty >= 1)) return fail(`BUDGET_BELOW_ONE_SHARE: $${budgetUsd} at ~${estPx} u/share`);
  const qty = draft.qty === undefined ? maxQty : Math.min(draft.qty, maxQty);
  if (draft.qty !== undefined && draft.qty > maxQty) clamped.push(`qty ${draft.qty} -> ${maxQty} (strategy budget / displayed ask size)`);

  // Entry reference = what the entry can pay: the limit when it is below the ask (a passive limit), else the ask. The
  // strategy's exits are computed from it, so a clamped stop never ends up at/above the entry limit (a limit fill would
  // otherwise activate a stop that is already marketable).
  const entryRefU = limitU !== undefined ? Math.min(quote.ask, limitU) : quote.ask;
  const rules = exitPrices(strategy, entryRefU);
  const atRefOk = documentedStopAtEntry(strategy);
  let stop = rules.stop;
  const modelStop = draft.attach?.stop_loss_px_u;
  if (modelStop === undefined) clamped.push(`no model stop-loss -> strategy stop ${rules.stop} u`);
  else {
    const ms = tickDown(modelStop);
    if (ms >= quote.bid) clamped.push(`model stop ${modelStop} u is at/above the IEX bid ${quote.bid} u -> strategy stop ${rules.stop} u`);
    else if (limitU !== undefined && ms >= limitU) clamped.push(`model stop ${modelStop} u is at/above the entry limit ${limitU} u -> strategy stop ${rules.stop} u`);
    else if (ms > rules.stop) stop = ms;
    else if (ms < rules.stop) clamped.push(`model stop ${modelStop} u is looser than the strategy stop -> ${rules.stop} u`);
  }
  if (!(stop >= 1)) return fail('STOP_BELOW_MIN_TICK');
  if (!atRefOk && stop >= quote.bid) return fail(`STOP_AT_OR_ABOVE_BID: stop ${stop} u >= IEX bid ${quote.bid} u`);
  if (limitU !== undefined && (atRefOk ? stop > limitU : stop >= limitU)) return fail(`STOP_AT_OR_ABOVE_ENTRY_LIMIT: stop ${stop} u >= entry limit ${limitU} u`);
  const attach = { stop_loss_px_u: stop };
  const modelTake = draft.attach?.take_profit_px_u;
  let take = modelTake === undefined ? null : tickUp(modelTake);
  if (take !== null && !(take > stop)) { clamped.push(`model take-profit ${modelTake} u is not above the stop -> strategy take-profit`); take = null; }
  if (take === null && rules.take !== null && rules.take > stop) {
    take = rules.take;
    if (modelTake === undefined) clamped.push(`no model take-profit -> strategy take-profit ${rules.take} u`);
  }
  if (take !== null) attach.take_profit_px_u = take;
  const te = strategy.exits.timeExit;
  if (draft.attach?.time_exit_min !== undefined) attach.time_exit_min = draft.attach.time_exit_min;
  else if (te) {
    attach.time_exit_min = te.minutes;
    if (te.bandPct !== null && te.bandPct !== undefined) attach.time_exit_band_bps = Math.round(te.bandPct * 100);
    clamped.push(`no model time exit -> strategy time exit ${te.minutes} min`);
  }
  const proposal = {
    action: 'open', instrument: { kind: 'equity', sym }, side: 'buy', qty, budget_usd: budgetUsd, order_type: draft.order_type, attach,
    rationale: draft.rationale, evidence_refs: draft.evidence_refs,
  };
  if (limitU !== undefined) proposal.limit_px_u = limitU;
  const v = intentFromProposal(proposal, {
    source: 'model', agent_id: agent.id, portfolio_id: agent.portfolio_id, strategy_id: strategy.id,
    quote_ts: Number.isSafeInteger(quote.quoteTs) && quote.quoteTs <= clock ? quote.quoteTs : clock, created_ts: clock, expires_ts: draft.expires_ts,
  });
  return { ...v, envelope: { clamped, qty, budgetUsd, estPxU: estPx, entryRefU, stopU: stop, takeProfitU: attach.take_profit_px_u ?? null, strategyStopU: rules.stop } };
}

/** Why the agent must stop consulting the model now (kill switch / no longer RUNNING), or null. */
function haltReason(db, agentId) {
  if (readKillState(db).engaged) return 'NOT_RUN_KILL_SWITCH';
  return db.prepare('SELECT state FROM agents WHERE id = ?').get(agentId)?.state === 'RUNNING' ? null : 'NOT_RUN_AGENT_NOT_RUNNING';
}

/**
 * model_confirm: rules propose, the agent's lens must say consider_entry for each entry.
 * model: the lens proposed_intent (if any) replaces the rules entry for that symbol (clamped by modelIntent()).
 * Management actions (cancels, stop trails, time exits) are risk-reducing and stay rule-based: when the model is
 * disconnected they are still returned (`blocked` result) so the runner gates them before blocking the agent.
 * The kill switch / agent state is re-checked before and after every model call: a halt returns {halted} at once.
 */
async function applyModel(db, rctx, agent, strategy, actions, costModel) {
  const out = [];
  let calls = 0;
  const mode = strategy.decisionMode;
  const management = () => actions.filter((x) => x.kind !== 'entry');
  const confirmRow = (ref_id, payload) => append(db, { session_id: rctx.session_id, ts_sim: rctx.clock, portfolio_id: agent.portfolio_id, agent_id: agent.id,
    actor: 'agent', type: 'MODEL_CONFIRMATION', ref_id, payload: { lens: agent.lens, mode, ...payload } });
  const entriesFrom = (i) => actions.slice(i).filter((x) => x.kind === 'entry');
  const notRun = (i, halt) => {
    const rest = entriesFrom(i);
    if (rest.length) {
      confirmRow(null, { sym: rest[0].sym, status: halt, confirmed: false, remaining: rest.length, remainingSyms: rest.slice(0, 20).map((x) => x.sym),
        note: `${halt === 'NOT_RUN_KILL_SWITCH' ? 'kill switch engaged' : 'agent no longer RUNNING'}: the remaining model calls of this step were not made` });
    }
    return { blocked: false, halted: halt, actions: [] };
  };
  for (let i = 0; i < actions.length; i++) {
    const a = actions[i];
    if (a.kind !== 'entry') { out.push(a); continue; }
    if (calls >= strategy.management.maxModelCallsPerStep) {
      confirmRow(null, { sym: a.sym, status: 'NOT_RUN_CALL_BUDGET', confirmed: false, maxModelCallsPerStep: strategy.management.maxModelCallsPerStep });
      continue;
    }
    const halt = haltReason(db, agent.id);
    if (halt) return notRun(i, halt);
    calls++;
    let r;
    try {
      r = await rctx.assess(a.sym, agent.lens, { ds: rctx.ds, clock: rctx.clock, session_id: rctx.session_id, agent_id: agent.id, portfolio_id: agent.portfolio_id });
    } catch (e) {
      r = { status: 'ERROR', error: String(e?.message ?? e).slice(0, 200) };
    }
    const haltAfter = haltReason(db, agent.id);
    if (haltAfter) {
      // Journal what came back honestly, but never act on it.
      confirmRow(r?.assessment_id ?? null, { sym: a.sym, status: String(r?.status ?? 'UNKNOWN').slice(0, 60), stance: isObj(r?.output) ? r.output.stance ?? null : null,
        confirmed: false, discarded: true, assessment_id: r?.assessment_id ?? null,
        note: `result discarded: ${haltAfter === 'NOT_RUN_KILL_SWITCH' ? 'kill switch engaged' : 'agent no longer RUNNING'} during the model call` });
      return notRun(i + 1, haltAfter);
    }
    if (r?.status === 'MODEL_DISCONNECTED') {
      return { blocked: true, reason: 'MODEL_DISCONNECTED', detail: r.detail ?? `assessor returned MODEL_DISCONNECTED for ${a.sym}`, actions: management() };
    }
    // The hindsight guard refuses every call for this replay date (training cutoff too late or unknown): block the agent
    // once with that reason instead of journaling an unusable assessment every minute.
    if (r?.status === 'BLOCKED' && HINDSIGHT_BLOCK_CODES.includes(r.code)) {
      return { blocked: true, reason: r.code, detail: r.detail ?? r.code, actions: management() };
    }
    const chk = checkAssessment(r, agent.lens);
    const stance = chk.ok ? r.output.stance : null;
    let keep = null;
    let note;
    let envelope = null;
    let failCode = chk.ok ? null : chk.code;
    if (!chk.ok) note = `assessment unusable (${chk.code}); no entry`;
    else if (mode === 'model_confirm') {
      if (stance === 'consider_entry') { keep = { ...a, model: { mode, assessment_id: r.assessment_id ?? null, stance } }; note = 'confirmed by lens assessment'; }
      else note = `lens stance ${stance}; rules entry not confirmed`;
    } else {
      const p = r.output.proposed_intent;
      if (stance !== 'consider_entry' || !p) note = `lens stance ${stance}${p ? '' : ', no proposed_intent'}; no entry`;
      else {
        const v = modelIntent(p, { agent, strategy, sym: a.sym, clock: rctx.clock, quote: a.signal?.quote, costModel });
        const unresolved = v.ok ? unresolvedRefs(db, v.intent) : [];
        envelope = v.envelope;
        if (!v.ok) { note = `model proposal invalid: ${v.errors.slice(0, 5).join('; ')}`; failCode = 'MODEL_PROPOSAL_INVALID'; }
        else if (unresolved.length) { note = `model proposal cites evidence refs that do not resolve to stored evidence or a stored IEX minute: ${unresolved.slice(0, 5).join(', ')}; no entry`; failCode = 'MODEL_EVIDENCE_UNRESOLVED'; }
        else {
          keep = {
            kind: 'entry', sym: a.sym, intent: v.intent, signal: a.signal,
            detail: { ...a.detail, modelProposed: true, stopU: v.envelope.stopU, takeProfitU: v.envelope.takeProfitU, estPxU: v.envelope.estPxU, envelope: v.envelope },
            model: { mode, assessment_id: r.assessment_id ?? null, stance },
          };
          note = `model proposal accepted for gating${v.envelope.clamped.length ? ` (strategy envelope applied: ${v.envelope.clamped.join('; ')})` : ''}`;
        }
      }
    }
    confirmRow(r?.assessment_id ?? null, { sym: a.sym, status: chk.ok ? 'OK' : chk.code, stance, confirmed: !!keep, note: String(note).slice(0, 1500), assessment_id: r?.assessment_id ?? null,
      ...(envelope ? { envelope } : {}) });
    if (keep) out.push(keep);
    else if (failCode) setLast(db, agent.id, 'fail', { ts_sim: rctx.clock, wall: Date.now(), stage: 'model', code: failCode, sym: a.sym, detail: String(note).slice(0, 500) });
  }
  return { blocked: false, actions: out };
}

function insertIntentRow(db, rctx, agent, intent, decision, reasons, orderIds) {
  db.prepare(`INSERT INTO intents (id, session_id, agent_id, portfolio_id, ts, source, intent_json, decision, reasons_json, order_ids_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(intent.id, rctx.session_id, agent.id, agent.portfolio_id, rctx.clock, intent.source,
    JSON.stringify(intent), decision, JSON.stringify(reasons), orderIds ? JSON.stringify(orderIds) : null);
}

/** Execute an ACCEPTED intent through the orders engine. Returns {ok, order_ids, code?, errors?}. */
function execute(db, rctx, agent, strategy, action, intent, gate) {
  const octx = { session_id: rctx.session_id, ds: rctx.ds, clock: rctx.clock, costModels: rctx.costModels };
  const reason = `${action.kind} via ${strategy.id}`;
  const own = (id) => {
    const o = getOrder(db, id);
    return o && o.session_id === rctx.session_id && o.agent_id === agent.id && o.portfolio_id === agent.portfolio_id;
  };
  const sym = intent.instrument.sym;
  switch (intent.action) {
    case 'open': {
      const qty = intent.qty ?? gate.estimate?.qty;
      const r = submitOrder(db, octx, {
        portfolio_id: agent.portfolio_id, agent_id: agent.id, intent_id: intent.id, sym, kind: 'equity', side: 'buy', type: intent.order_type,
        role: 'entry', qty, limit_px: intent.limit_px_u, stop_px: intent.stop_px_u, attach: intent.attach, actor: 'agent', reason,
        meta: {
          strategy_id: strategy.id, strategy_label: STRATEGY_LABEL, decisionMode: strategy.decisionMode, source: intent.source,
          // Same audit field as human sandbox orders (server/api/trading.js): the gate estimate this order was accepted on.
          ...(gate.estimate ? { gate_estimate: { priceU: gate.estimate.priceU, qty: gate.estimate.qty, costU: gate.estimate.costU, basis: gate.estimate.basis, slippageBps: gate.estimate.slippageBps } } : {}),
        },
      });
      return r.ok ? { ok: true, order_ids: [r.order.id, ...r.children.map((c) => c.id)] } : { ok: false, code: r.code, errors: r.errors, order_ids: r.order ? [r.order.id] : [] };
    }
    case 'close': {
      const r = submitOrder(db, octx, {
        portfolio_id: agent.portfolio_id, agent_id: agent.id, intent_id: intent.id, sym, kind: 'equity', side: 'sell', type: intent.order_type,
        role: action.kind === 'time_exit' ? 'time_exit' : 'exit', qty: intent.qty, limit_px: intent.limit_px_u, actor: 'agent', reason,
        meta: { strategy_id: strategy.id, strategy_label: STRATEGY_LABEL, decisionMode: strategy.decisionMode, source: intent.source },
      });
      return r.ok ? { ok: true, order_ids: [r.order.id] } : { ok: false, code: r.code, errors: r.errors, order_ids: r.order ? [r.order.id] : [] };
    }
    case 'modify': {
      if (!own(intent.target_order_id)) return { ok: false, code: 'ORDER_NOT_OWNED_BY_AGENT', errors: [], order_ids: [] };
      const terms = {};
      if (intent.stop_px_u !== undefined) terms.stop_px = intent.stop_px_u;
      if (intent.limit_px_u !== undefined) terms.limit_px = intent.limit_px_u;
      if (intent.qty !== undefined) terms.qty = intent.qty;
      const r = replaceOrder(db, octx, intent.target_order_id, { ...terms, by: 'agent', reason, agent_id: agent.id, portfolio_id: agent.portfolio_id });
      return r.ok ? { ok: true, order_ids: [intent.target_order_id] } : { ok: false, code: r.code, errors: r.errors, order_ids: [] };
    }
    case 'cancel': {
      if (!own(intent.target_order_id)) return { ok: false, code: 'ORDER_NOT_OWNED_BY_AGENT', errors: [], order_ids: [] };
      const r = cancelOrder(db, octx, intent.target_order_id, { by: 'agent', reason, agent_id: agent.id, portfolio_id: agent.portfolio_id });
      return r.ok ? { ok: true, order_ids: [intent.target_order_id, ...(r.cascaded || [])] } : { ok: false, code: r.code, errors: r.errors, order_ids: [] };
    }
    default:
      return { ok: false, code: 'ACTION_UNSUPPORTED', errors: [], order_ids: [] };
  }
}

/** Propose -> gate -> (submit). One intent. */
function processAction(db, rctx, agent, strategy, action, costModel) {
  const intent = { ...action.intent, id: newId('int') };
  append(db, {
    session_id: rctx.session_id, ts_sim: rctx.clock, portfolio_id: agent.portfolio_id, agent_id: agent.id, actor: 'agent', type: 'INTENT_PROPOSED', ref_id: intent.id,
    payload: {
      kind: action.kind, source: intent.source, decisionMode: strategy.decisionMode, strategy: { id: strategy.id, label: STRATEGY_LABEL },
      intent, signal: action.signal ?? null, detail: action.detail ?? null, model: action.model ?? null,
      note: 'Typed proposal only — it executes nothing unless the deterministic policy gate accepts it.',
    },
  });
  // buildGateContext resolves the intent's evidence refs itself (stored minutes / provenance-checked evidence rows).
  const gctx = buildGateContext(db, { session_id: rctx.session_id, ds: rctx.ds, clock: rctx.clock, intent, costModel });
  const gate = evaluate(intent, gctx);
  journalDecision(db, { session_id: rctx.session_id, ts_sim: rctx.clock, intent, result: gate, intent_id: intent.id });
  const base = { kind: action.kind, sym: action.sym, intent_id: intent.id, action: intent.action };
  if (gate.decision !== 'ACCEPTED') {
    insertIntentRow(db, rctx, agent, intent, 'DENIED', gate.reasons, null);
    const code = gate.reasons[0]?.code ?? 'DENIED';
    setLast(db, agent.id, 'fail', { ts_sim: rctx.clock, wall: Date.now(), stage: 'policy', ...base, code, reasons: gate.reasons.slice(0, 6) });
    return { ...base, decision: 'DENIED', code, reasons: gate.reasons.map((r) => r.code) };
  }
  insertIntentRow(db, rctx, agent, intent, 'ACCEPTED', [], null);
  const ex = execute(db, rctx, agent, strategy, action, intent, gate);
  db.prepare('UPDATE intents SET order_ids_json = ? WHERE id = ?').run(JSON.stringify(ex.order_ids ?? []), intent.id);
  if (ex.ok) setLast(db, agent.id, 'ok', { ts_sim: rctx.clock, wall: Date.now(), ...base, order_ids: ex.order_ids });
  else setLast(db, agent.id, 'fail', { ts_sim: rctx.clock, wall: Date.now(), stage: 'order', ...base, code: ex.code, errors: (ex.errors || []).slice(0, 6) });
  return { ...base, decision: 'ACCEPTED', executed: ex.ok, code: ex.ok ? null : ex.code, order_ids: ex.order_ids };
}

/** Gate + execute actions in order within the per-agent / global per-step bounds. Returns {results, deferred}. */
function processActions(db, rctx, agent, strategy, actions, costModel, step) {
  const results = [];
  const deferred = [];
  let processed = 0;
  for (const a of actions) {
    if (processed >= strategy.management.maxOrdersPerStep || step.ordersLeft <= 0) { deferred.push({ kind: a.kind, sym: a.sym }); continue; }
    processed++;
    step.ordersLeft--;
    results.push(processAction(db, rctx, agent, strategy, a, costModel));
  }
  if (deferred.length) {
    append(db, { session_id: rctx.session_id, ts_sim: rctx.clock, portfolio_id: agent.portfolio_id, agent_id: agent.id, actor: 'agent', type: 'AGENT_STEP_CAP', ref_id: null,
      payload: { deferred, maxOrdersPerStep: strategy.management.maxOrdersPerStep, globalLeft: step.ordersLeft, note: 'bounded work: remaining actions are re-evaluated next minute' } });
  }
  return { results, deferred };
}

async function runAgent(db, rctx, row, step) {
  const { session_id, ds, clock } = rctx;
  const agent = db.prepare('SELECT * FROM agents WHERE id = ?').get(row.id);
  if (!agent || agent.state !== 'RUNNING') return { agent_id: row.id, status: 'SKIPPED_NOT_RUNNING' };
  const UNPARSEABLE = Symbol('unparseable');
  const raw = parseJson(agent.strategy_json, UNPARSEABLE);
  if (raw === UNPARSEABLE) throw new AgentError('STRATEGY_UNPARSEABLE', 'strategy_json is not valid JSON');
  const v = validateStrategy(raw);
  if (!v.ok) throw new AgentError('STRATEGY_INVALID', v.errors.slice(0, 5).join('; '));
  const strategy = v.strategy;
  if (strategy.segment !== agent.segment) throw new AgentError('STRATEGY_SEGMENT_MISMATCH', `strategy segment ${strategy.segment} != agent segment ${agent.segment}`);
  if (!getPortfolio(db, session_id, agent.portfolio_id)) throw new AgentError('PORTFOLIO_NOT_IN_SESSION', `portfolio ${agent.portfolio_id} not found in session ${session_id}`);
  const session = step.session;
  if (!session) return { agent_id: agent.id, status: 'NO_VERIFIED_DATA' };
  if (clock <= session.open || clock >= session.close) return { agent_id: agent.id, status: 'OUTSIDE_SESSION' };
  const needsModel = strategy.decisionMode !== 'rules';

  const costModel = costModelFor(rctx, agent);
  const state = loadAgentState(db, rctx, agent, costModel, session);

  // Scan: as-of universe -> activity prefilter (window trades/volume) -> bounded signal computation.
  const en = strategy.entry;
  const uni = universeFor(db, ds, clock, agent.segment, step);
  const aggs = windowAggregatesCached(db, ds, clock, strategy.signal.windowMin, session.open, step.cache);
  const active = uni.filter((u) => {
    const a = aggs.get(u.sym);
    return a && Number(a.wn) >= Math.max(1, en.minTradesW) && (en.minVolumeW === null || Number(a.wv) >= en.minVolumeW);
  }).sort((x, y) => (Number(aggs.get(y.sym).wv) - Number(aggs.get(x.sym).wv)) || (x.sym < y.sym ? -1 : x.sym > y.sym ? 1 : 0));
  const scanned = active.slice(0, strategy.management.maxScanSymbols).map((u) => u.sym);
  const ownOpen = state.openOrders.filter((o) => o.agent_id === agent.id);
  const monitored = [...new Set([...state.positions.map((p) => p.sym), ...ownOpen.map((o) => o.sym)])];
  const signals = computeSignals(db, ds, clock, [...new Set([...scanned, ...monitored])], { ...strategy.signal, cache: step.cache });
  const plan = planActions(strategy, signals, state, clock);
  append(db, {
    session_id, ts_sim: clock, portfolio_id: agent.portfolio_id, agent_id: agent.id, actor: 'agent', type: 'AGENT_SCAN', ref_id: null,
    payload: {
      strategy_id: strategy.id, strategy_label: STRATEGY_LABEL, decisionMode: strategy.decisionMode, segment: agent.segment, windowMin: strategy.signal.windowMin,
      universe: uni.length, active: active.length, scanned: scanned.length, monitored: monitored.length,
      positions: state.positions.map((p) => ({ sym: p.sym, qty: p.qty, markU: p.markU, markBasis: p.markBasis })), openOrders: ownOpen.length,
      topCandidates: plan.candidates.slice(0, 5).map(compactSignal), candidates: plan.candidates.length, skipped: plan.skipped, nearMisses: plan.nearMisses,
      planned: plan.actions.map((a) => ({ kind: a.kind, sym: a.sym })),
      note: 'Signal metrics as of the replay clock (IEX-only) — not recommendations. skipped = entry-rule rejections by reason; nearMisses = symbols failing exactly one threshold rule.',
    },
  });

  let actions = plan.actions;
  if (needsModel && !modelAvailable(rctx)) {
    // No model: no entry is proposed, but this step's rule-based management still runs through the gate before BLOCKED.
    const mg = processActions(db, rctx, agent, strategy, actions.filter((a) => a.kind !== 'entry'), costModel, step);
    return blockAgent(db, rctx, agent, 'MODEL_DISCONNECTED', `decisionMode ${strategy.decisionMode} requires a connected model; none is configured/connected`, mg);
  }
  if (needsModel) {
    const m = await applyModel(db, rctx, agent, strategy, actions, costModel);
    if (m.halted) return { agent_id: agent.id, status: m.halted === 'NOT_RUN_KILL_SWITCH' ? 'KILL_SWITCH_ENGAGED' : 'SKIPPED_NOT_RUNNING', halted: m.halted };
    if (m.blocked) {
      const mg = processActions(db, rctx, agent, strategy, m.actions, costModel, step);
      return blockAgent(db, rctx, agent, m.reason ?? 'MODEL_DISCONNECTED', m.detail, mg);
    }
    actions = m.actions;
    // Backstop: the agent may have been paused/stopped/killed while the model was being consulted.
    const now = db.prepare('SELECT state FROM agents WHERE id = ?').get(agent.id);
    if (!now || now.state !== 'RUNNING') return { agent_id: agent.id, status: 'SKIPPED_NOT_RUNNING' };
  }

  const { results, deferred } = processActions(db, rctx, agent, strategy, actions, costModel, step);
  return { agent_id: agent.id, status: 'OK', scanned: scanned.length, planned: plan.actions.length, results, deferred: deferred.length };
}

/**
 * Run one decision step for every RUNNING agent at the replay clock.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{session_id:string, ds:string|null, clock:number, t_end?:number, costModels?:object, limits?:{maxAgentsPerStep?:number, maxOrdersPerStep?:number},
 *          assess?:(sym:string, lens:string, ctx:object)=>Promise<{status:'OK', output:object, assessment_id?:string}|{status:'MODEL_DISCONNECTED'}|{status:string}>,
 *          model?:{status:'CONNECTED'|'DISCONNECTED'|'FAULT'}}} rctx
 * @returns {Promise<{clock:number|null, status:string, agents:object[]}>} never rejects: agent-level errors FAULT that
 *   agent; a runner-level error (e.g. unreadable controls) returns status RUNNER_FAULT and is journaled.
 */
export async function runAgentsStep(db, rctx = {}) {
  const { session_id, ds, clock } = rctx;
  const res = { clock: Number.isFinite(clock) ? clock : null, status: 'OK', agents: [] };
  if (!session_id || !Number.isFinite(clock)) return { ...res, status: 'NO_SESSION' };
  if (!ds) return { ...res, status: 'NO_VERIFIED_DATA' };
  try {
    if (readKillState(db).engaged) return { ...res, status: 'KILL_SWITCH_ENGAGED' };
    const limits = { ...RUNNER_LIMITS, ...(rctx.limits || {}) };
    const agents = db.prepare("SELECT id, portfolio_id, state FROM agents WHERE state = 'RUNNING' ORDER BY id").all().slice(0, limits.maxAgentsPerStep);
    // The agents' session ends at the REPLAY end (a PARTIAL dataset's coverage end when earlier than 16:00 ET): entry
    // windows (noEntryLastMin) and OUTSIDE_SESSION are measured from it, so no entry is opened that can never be managed.
    const win = replayWindowOf(db, ds);
    const end = Number.isFinite(rctx.t_end) ? rctx.t_end : null;
    const session = win && { open: win.open, close: end === null ? win.close : Math.min(win.close, end), tradeDate: win.tradeDate, sessionClose: win.sessionClose };
    const step = { cache: new Map(), universes: new Map(), ordersLeft: limits.maxOrdersPerStep, session };
    for (const a of agents) {
      if (readKillState(db).engaged) { res.status = 'KILL_SWITCH_ENGAGED'; break; }
      try {
        res.agents.push(await runAgent(db, rctx, a, step));
      } catch (e) {
        res.agents.push(faultAgent(db, rctx, db.prepare('SELECT * FROM agents WHERE id = ?').get(a.id) ?? a, e));
      }
    }
    return res;
  } catch (e) {
    const detail = String(e?.message ?? e).slice(0, 300);
    try {
      append(db, { session_id, ts_sim: clock, actor: 'system', type: 'RUNNER_FAULT', ref_id: null,
        payload: { detail, note: 'agent step skipped for this minute; no intents were proposed by the remaining agents' } });
    } catch { /* never crash the step */ }
    return { ...res, status: 'RUNNER_FAULT', detail };
  }
}

// Kill switch / boot controls live in server/controls.js; re-exported here because docs/CONTRACTS.md section 7 lists
// them alongside the runner.
export { engageKill, releaseKill, pauseAllOnBoot } from '../controls.js';

/** Hindsight-guard refusals from runLensAssessments (server/intel/assessments.js hindsightCheck): no call was made. */
export const HINDSIGHT_BLOCK_CODES = Object.freeze(['REPLAY_BEFORE_MODEL_CUTOFF', 'MODEL_TRAINING_CUTOFF_UNKNOWN']);

/** Provider error kinds meaning the call never reached a model: treated as MODEL_DISCONNECTED, not as an assessment. */
export const DISCONNECT_ERROR_KINDS = Object.freeze(['CONNECT', 'NETWORK', 'DISCONNECTED', 'SDK_MISSING', 'CONFIG']);

/** errorKind of a per-lens result: the explicit field when present, else the `KIND: ...` prefix of its error string. */
function resultErrorKind(x) {
  if (typeof x?.errorKind === 'string') return x.errorKind;
  const m = typeof x?.error === 'string' ? /^([A-Z_]+):/.exec(x.error) : null;
  return m ? m[1] : null;
}

const providerUsable = (p) => !!(p && p.kind !== 'none' && typeof p.complete === 'function');

/**
 * Production assessor for model modes: wraps a ModelProvider (server/intel/model-provider.js) and runs ONE lens
 * independently through runLensAssessments. Returns {status:'MODEL_DISCONNECTED'} when no model is connected.
 * `provider` is a ModelProvider or a resolver function `() => ModelProvider` (e.g. `() => ctx.provider()`); a resolver
 * is called on EVERY assessment, so a model configured, changed or removed after boot takes effect at the next call
 * without a restart, and a changed provider object discards the cached status. The returned function also carries
 * `isConfigured()` (synchronous, no network) so the runner can BLOCK a model-mode agent at once when no provider is
 * configured, exactly as when no assessor is wired.
 * Provider status is cached for statusTtlMs (wall time) to avoid probing the endpoint every replay minute; a call that
 * fails without a usable model answer (CONNECT / NETWORK / DISCONNECTED / SDK_MISSING / CONFIG) invalidates that cache and reports
 * MODEL_DISCONNECTED, so the agent is BLOCKED instead of burning model calls against a dead endpoint; a TIMEOUT
 * invalidates the cache so the next call re-probes status.
 */
export function createLensAssessor(db, provider, { statusTtlMs = 60_000 } = {}) {
  let cached = null;
  let lastProvider;
  const resolve = () => {
    if (typeof provider !== 'function') return { prov: provider ?? null, error: null };
    try { return { prov: provider() ?? null, error: null }; } catch (e) { return { prov: null, error: `provider resolution failed: ${String(e?.message ?? e).slice(0, 160)}` }; }
  };
  const assess = async (sym, lens, { ds, clock, session_id = null } = {}) => {
    const { prov, error } = resolve();
    if (prov !== lastProvider) { cached = null; lastProvider = prov; }
    if (!providerUsable(prov)) {
      let detail = error ?? 'no model provider configured';
      if (!error && prov && typeof prov.status === 'function') {
        try { const s = await prov.status(); if (s?.detail) detail = `provider ${s.status ?? 'DISCONNECTED'}: ${s.detail}`; } catch { /* keep the generic detail */ }
      }
      return { status: 'MODEL_DISCONNECTED', detail: detail.slice(0, 200) };
    }
    const now = Date.now();
    if (!cached || now - cached.at > statusTtlMs) {
      let st;
      try { st = await prov.status(); } catch (e) { st = { status: 'FAULT', detail: String(e?.message ?? e).slice(0, 200) }; }
      cached = { at: now, st };
    }
    if (cached.st?.status !== 'CONNECTED') return { status: 'MODEL_DISCONNECTED', detail: `provider ${cached.st?.status ?? 'UNKNOWN'}: ${cached.st?.detail ?? ''}`.slice(0, 200) };
    const r = await runLensAssessments(db, prov, { session_id, ds, sym, asOf: clock, lenses: [lens] });
    if (r.status === 'MODEL_DISCONNECTED') { cached = null; return { status: 'MODEL_DISCONNECTED', detail: r.note ?? 'MODEL_DISCONNECTED' }; }
    if (r.status === 'BLOCKED' && HINDSIGHT_BLOCK_CODES.includes(r.code)) return { status: 'BLOCKED', code: r.code, detail: String(r.detail ?? r.note ?? r.code).slice(0, 300) };
    if (r.status !== 'COMPLETED') return { status: r.status, error: r.note ?? null };
    const x = r.results[0];
    const kind = x.status === 'ERROR' ? resultErrorKind(x) : null;
    if (kind && DISCONNECT_ERROR_KINDS.includes(kind)) {
      cached = null;
      return { status: 'MODEL_DISCONNECTED', detail: `provider ${kind}: ${x.error ?? ''}`.slice(0, 200), assessment_id: x.assessment_id };
    }
    if (kind === 'TIMEOUT') cached = null;
    return { status: x.status, output: x.output, assessment_id: x.assessment_id, error: x.error, intent: x.intent };
  };
  /** True when a usable provider is configured right now (no network call). */
  assess.isConfigured = () => providerUsable(resolve().prov);
  return assess;
}
