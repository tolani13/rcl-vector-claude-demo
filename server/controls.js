// Human controls over agent authority (docs/CONTRACTS.md section 7): global kill switch, per-agent start / pause /
// resume, strategy changes, and the boot-time rule that authority is never implicitly resumed after a restart.
//
// Kill switch state lives in the `controls` table under key `kill_switch` (JSON {engaged, at, at_sim, by,
// protective_policy, reason}); the policy gate reads the same row (gate.readKillState) and denies every intent except
// human cancels while it is engaged.
//   engageKill  cancels every open NON-protective order of the current replay session (agent entries/exits and sandbox
//               orders alike; pending bracket children of a cancelled entry cascade), applies the protective policy
//               (KEEP_PROTECTIVE: working stop-loss / take-profit orders, and already-submitted time-exit orders, keep
//                working; CANCEL_ALL: they are cancelled too) and sets every agent STOPPED.
//   releaseKill clears the switch; agents stay STOPPED until a human starts each one individually.
// Pause keeps protective orders working (paused-state protective policy KEEP_PROTECTIVE) and, by default, cancels the
// agent's own pending entry orders so no NEW exposure is opened while paused. Boot pause, BLOCKED and FAULTED (runner)
// always cancel the agent's pending entries: no entry fills without a supervising RUNNING agent.
// Time exits are agent-monitored RULES (entry meta.time_exit), not standing orders: they are evaluated only while the
// agent is RUNNING. Every transition out of RUNNING journals TIME_EXIT_SUSPENDED for the positions it leaves without
// that rule; a deadline missed meanwhile is evaluated at the first step after a human resumes the agent.
import { append } from './journal.js';
import { readKillState, KILL_CONTROL_KEYS } from './policy/gate.js';
import { atomic } from './sim/ledger.js';
import { cancelOrder, getOrder } from './sim/orders.js';
import { validateStrategy } from './agents/strategies.js';
import { MINUTE } from './util/time.js';

export const KILL_KEY = KILL_CONTROL_KEYS[0];
export const PROTECTIVE_POLICIES = Object.freeze(['KEEP_PROTECTIVE', 'CANCEL_ALL']);
export const AGENT_STATES = Object.freeze(['PAUSED', 'RUNNING', 'FAULTED', 'BLOCKED', 'STOPPED']);
export const BOOT_PAUSE_REASON = 'authority not implicitly resumed after restart';

const OPEN = ['pending_parent', 'working', 'triggered', 'partially_filled'];

/** Current replay context {session_id, ds, clock} (or nulls when no session exists). */
function replayCtx(db) {
  const r = db.prepare('SELECT session_id, ds, clock FROM replay_state WHERE id = 1').get();
  return { session_id: r?.session_id ?? null, ds: r?.ds ?? null, clock: r?.clock ?? null };
}

const actorFor = (by) => (by === 'system' ? 'system' : 'human');
const byLabel = (by) => String(by ?? 'human').slice(0, 80);

function parseJson(s) {
  try { return s ? JSON.parse(s) : null; } catch { return null; }
}

/** Agent row with parsed JSON fields (plus this session's cumulative scan summary), or null. */
export function getAgent(db, id) {
  const a = db.prepare('SELECT * FROM agents WHERE id = ?').get(id);
  if (!a) return null;
  return {
    id: a.id, portfolio_id: a.portfolio_id, lens: a.lens, segment: a.segment, state: a.state, state_reason: a.state_reason,
    strategy: parseJson(a.strategy_json), grants: parseJson(a.grants_json), last_ok: parseJson(a.last_ok_json), last_fail: parseJson(a.last_fail_json),
    updated_wall: a.updated_wall,
    scan_summary: agentScanSummary(db, a.id),
  };
}

// ---- "why no trades": cumulative per-agent scan summary -------------------------------------------------------
//
// Aggregated from the append-only journal (AGENT_SCAN skipped / nearMisses counts, model confirmations, gate
// decisions) for the current replay session. The journal is the source of truth; the per-(db, session, agent) cache
// only remembers the last journal seq already folded in, so each call reads just the rows appended since.
const SCAN_SUMMARY_TYPES = ['AGENT_SCAN', 'INTENT_PROPOSED', 'POLICY_ACCEPT', 'POLICY_DENY', 'MODEL_CONFIRMATION'];
const scanSummaryCache = new WeakMap();
const SCAN_SUMMARY_NOTE = 'Cumulative for this replay session. skipped = symbol-minute entry-rule rejections by reason (one symbol can fail several '
  + 'rules in the same minute); nearMisses = symbol-minutes that failed exactly ONE threshold rule (that rule); policyDenied = gate denial '
  + 'reasons. Thresholds are EXPLORATORY DEFAULTS — NOT VALIDATED; counts are not recommendations.';

function emptyScanSummary(session_id) {
  return { session_id, scans: 0, firstScanTs: null, lastScanTs: null, symbolMinutesScanned: 0, candidates: 0, entriesPlanned: 0,
    skipped: {}, nearMisses: {}, modelNotConfirmed: 0, intentsProposed: 0, policyAccepted: 0, policyDenied: {} };
}

const bump = (o, k, n = 1) => { if (Number.isFinite(n) && n) o[k] = (o[k] ?? 0) + n; };
const sortedCounts = (o) => Object.fromEntries(Object.entries(o).sort((a, b) => (b[1] - a[1]) || (a[0] < b[0] ? -1 : 1)));

function foldScanRow(s, r) {
  const p = parseJson(r.payload_json) ?? {};
  switch (r.type) {
    case 'AGENT_SCAN':
      s.scans++;
      if (s.firstScanTs === null) s.firstScanTs = r.ts_sim;
      s.lastScanTs = r.ts_sim;
      s.symbolMinutesScanned += Number(p.scanned) || 0;
      s.candidates += Number.isFinite(p.candidates) ? p.candidates : (Array.isArray(p.topCandidates) ? p.topCandidates.length : 0);
      s.entriesPlanned += Array.isArray(p.planned) ? p.planned.filter((x) => x?.kind === 'entry').length : 0;
      for (const [k, n] of Object.entries(p.skipped ?? {})) bump(s.skipped, k, Number(n));
      for (const [k, n] of Object.entries(p.nearMisses ?? {})) bump(s.nearMisses, k, Number(n));
      break;
    case 'MODEL_CONFIRMATION': if (p.confirmed !== true) s.modelNotConfirmed++; break;
    case 'INTENT_PROPOSED': s.intentsProposed++; break;
    case 'POLICY_ACCEPT': s.policyAccepted++; break;
    case 'POLICY_DENY': bump(s.policyDenied, String(p.reasons?.[0]?.code ?? 'DENIED')); break;
    default: break;
  }
}

/**
 * Cumulative scan summary for one agent in a replay session (default: the current one), or null without a session.
 * @returns {{session_id, scans, firstScanTs, lastScanTs, symbolMinutesScanned, candidates, entriesPlanned, skipped, nearMisses,
 *   modelNotConfirmed, intentsProposed, policyAccepted, policyDenied, note}|null}
 */
export function agentScanSummary(db, agentId, session_id = replayCtx(db).session_id) {
  if (!session_id) return null;
  let bySession = scanSummaryCache.get(db);
  if (!bySession) { bySession = new Map(); scanSummaryCache.set(db, bySession); }
  const key = `${session_id}|${agentId}`;
  const prev = bySession.get(key) ?? { hi: 0, s: emptyScanSummary(session_id) };
  const hi = Number(db.prepare('SELECT MAX(seq) m FROM journal WHERE session_id = ?').get(session_id)?.m ?? 0);
  let cur = prev;
  if (hi > prev.hi) {
    const s = structuredClone(prev.s);
    const rows = db.prepare(`SELECT type, ts_sim, payload_json FROM journal WHERE session_id = ? AND seq > ? AND seq <= ? AND agent_id = ?
      AND type IN (${SCAN_SUMMARY_TYPES.map(() => '?').join(',')}) ORDER BY seq`).all(session_id, prev.hi, hi, agentId, ...SCAN_SUMMARY_TYPES);
    for (const r of rows) foldScanRow(s, r);
    cur = { hi, s };
    // Rows written inside an open transaction may still roll back: only cache committed state.
    if (!db.isTransaction) bySession.set(key, cur);
  }
  return { ...cur.s, skipped: sortedCounts(cur.s.skipped), nearMisses: sortedCounts(cur.s.nearMisses), policyDenied: sortedCounts(cur.s.policyDenied), note: SCAN_SUMMARY_NOTE };
}

// ---- shared paused-state helpers ---------------------------------------------------------------------------------

/**
 * Cancel an agent's open entry orders in the replay session (pending bracket children cascade; a partially filled
 * entry has only its remainder cancelled and its activated protective children keep working). Returns cancelled ids.
 * @param {{session_id:string|null, ds:string|null, clock:number|null}} rc
 */
export function cancelAgentPendingEntries(db, rc, agentId, { by = 'system', reason }) {
  if (!rc?.session_id) return [];
  const octx = { session_id: rc.session_id, ds: rc.ds, clock: rc.clock };
  const entries = db.prepare(`SELECT id FROM orders WHERE session_id = ? AND agent_id = ? AND role = 'entry' AND status IN (${OPEN.map(() => '?').join(',')})
    ORDER BY created_ts, rowid`).all(rc.session_id, agentId, ...OPEN);
  const cancelled = [];
  for (const o of entries) {
    if (!OPEN.includes(getOrder(db, o.id)?.status)) continue;
    const r = cancelOrder(db, octx, o.id, { by: actorFor(by), reason });
    if (r.ok) cancelled.push(o.id, ...(r.cascaded || []));
  }
  return cancelled;
}

/**
 * Held positions of the agent's portfolio whose entry carries a time-exit rule that has not been submitted yet
 * (no working time_exit / exit order). Same entry lookup and deadline as the runner (first fill + 1 min + N min).
 */
export function pendingTimeExits(db, rc, agent) {
  if (!rc?.session_id || !agent?.portfolio_id) return [];
  const out = [];
  const lastEntry = db.prepare(`SELECT id, meta_json FROM orders WHERE session_id = ? AND portfolio_id = ? AND sym = ? AND role = 'entry'
    AND filled_qty > 0 ORDER BY created_ts DESC, rowid DESC LIMIT 1`);
  const exitWorking = db.prepare(`SELECT 1 FROM orders WHERE session_id = ? AND portfolio_id = ? AND sym = ? AND role IN ('time_exit', 'exit')
    AND status IN (${OPEN.map(() => '?').join(',')}) LIMIT 1`);
  const firstFill = db.prepare('SELECT MIN(ts) t0 FROM fills WHERE order_id = ?');
  for (const p of db.prepare("SELECT sym, qty FROM positions WHERE session_id = ? AND portfolio_id = ? AND kind = 'equity' AND qty > 0 ORDER BY sym")
    .all(rc.session_id, agent.portfolio_id)) {
    const o = lastEntry.get(rc.session_id, agent.portfolio_id, p.sym);
    const te = o ? parseJson(o.meta_json)?.time_exit : null;
    if (!te || !Number.isSafeInteger(te.minutes)) continue;
    if (exitWorking.get(rc.session_id, agent.portfolio_id, p.sym, ...OPEN)) continue;
    const t0 = firstFill.get(o.id)?.t0;
    const firstFillT = t0 === null || t0 === undefined ? null : Number(t0);
    out.push({ sym: p.sym, qty: Number(p.qty), entry_order_id: o.id, minutes: te.minutes, band_bps: te.band_bps ?? null, firstFillT,
      deadline: firstFillT === null ? null : firstFillT + MINUTE + te.minutes * MINUTE });
  }
  return out;
}

/** Journal TIME_EXIT_SUSPENDED when an agent leaves RUNNING with positions whose time-exit rule is still pending. */
export function journalTimeExitSuspension(db, rc, agent, { to, reason, actor = 'system', protective_policy = 'KEEP_PROTECTIVE' }) {
  const positions = pendingTimeExits(db, rc, agent);
  if (!positions.length) return positions;
  append(db, {
    session_id: rc.session_id, ts_sim: rc.clock, portfolio_id: agent.portfolio_id, agent_id: agent.id, actor, type: 'TIME_EXIT_SUSPENDED', ref_id: agent.id,
    payload: {
      to, reason, protective_policy, positions,
      note: 'Time exits are agent-monitored rules, not standing orders: they are NOT evaluated while the agent is not RUNNING. '
        + (protective_policy === 'CANCEL_ALL' ? 'CANCEL_ALL also cancelled the stop-loss / take-profit orders: these positions have no working exit order. '
          : 'Working stop-loss / take-profit orders are unaffected. ')
        + 'After a human resumes the agent, a missed deadline is evaluated at the first step (sell at market if the last IEX trade is within the band; detail.lateByMin).',
    },
  });
  return positions;
}

export function listAgents(db) {
  return db.prepare('SELECT id FROM agents ORDER BY id').all().map((r) => getAgent(db, r.id));
}

/** Kill switch state (absent row => never engaged). */
export function getKillState(db) {
  return readKillState(db);
}

function setState(db, agent, to, reason, by, extra = {}) {
  const rc = replayCtx(db);
  db.prepare('UPDATE agents SET state = ?, state_reason = ?, updated_wall = ? WHERE id = ?').run(to, reason, Date.now(), agent.id);
  append(db, {
    session_id: rc.session_id, ts_sim: rc.clock, portfolio_id: agent.portfolio_id, agent_id: agent.id, actor: actorFor(by), type: 'AGENT_STATE_CHANGED', ref_id: agent.id,
    payload: { from: agent.state, to, reason, by: byLabel(by), ...extra },
  });
}

function writeKill(db, value) {
  db.prepare('INSERT INTO controls (k, v, updated_wall) VALUES (?, ?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v, updated_wall = excluded.updated_wall')
    .run(KILL_KEY, JSON.stringify(value), Date.now());
}

/**
 * Engage the global kill switch.
 * @param {{by?:string, protective_policy?:'KEEP_PROTECTIVE'|'CANCEL_ALL', reason?:string|null}} opts
 * @returns {{ok:true, kill:object, cancelled:string[], kept:string[], agentsStopped:string[], alreadyEngaged:boolean} | {ok:false, code:string}}
 */
export function engageKill(db, { by = 'human', protective_policy = 'KEEP_PROTECTIVE', reason = null } = {}) {
  if (!PROTECTIVE_POLICIES.includes(protective_policy)) return { ok: false, code: 'PROTECTIVE_POLICY_INVALID', message: `protective_policy must be ${PROTECTIVE_POLICIES.join(' | ')}` };
  const actor = actorFor(by);
  return atomic(db, () => {
    const prev = readKillState(db);
    const rc = replayCtx(db);
    const state = { engaged: true, at: Date.now(), at_sim: rc.clock, by: byLabel(by), protective_policy, reason: reason ? String(reason).slice(0, 300) : null };
    writeKill(db, state);
    append(db, {
      session_id: rc.session_id, ts_sim: rc.clock, actor, type: 'KILL_SWITCH_ENGAGED', ref_id: KILL_KEY,
      payload: {
        ...state, alreadyEngaged: prev.engaged,
        effects: protective_policy === 'KEEP_PROTECTIVE'
          ? 'cancel all open non-protective orders; keep working protective orders (stop-loss / take-profit, and already-submitted time-exit orders); '
            + 'set all agents STOPPED (pending time-exit RULES are agent-monitored and are suspended while STOPPED: TIME_EXIT_SUSPENDED)'
          : 'cancel ALL open orders including protective ones; set all agents STOPPED (pending time-exit rules suspended: TIME_EXIT_SUSPENDED)',
      },
    });

    const cancelled = [];
    const kept = [];
    if (rc.session_id) {
      const octx = { session_id: rc.session_id, ds: rc.ds, clock: rc.clock };
      const open = db.prepare(`SELECT id, protective FROM orders WHERE session_id = ? AND status IN (${OPEN.map(() => '?').join(',')}) ORDER BY created_ts, rowid`)
        .all(rc.session_id, ...OPEN);
      for (const o of open) {
        const cur = getOrder(db, o.id);
        if (!cur || !OPEN.includes(cur.status)) continue; // already cancelled by a cascade
        if (cur.protective === 1 && protective_policy === 'KEEP_PROTECTIVE') {
          // A pending bracket child of a cancelled entry protects nothing; it is cancelled by the cascade below.
          kept.push(cur.id);
          continue;
        }
        const r = cancelOrder(db, octx, cur.id, { by: actor, reason: 'KILL_SWITCH_ENGAGED' });
        if (r.ok) cancelled.push(cur.id, ...(r.cascaded || []));
      }
    }
    const stillKept = kept.filter((id) => OPEN.includes(getOrder(db, id)?.status));

    const agentsStopped = [];
    const timeExitsSuspended = {};
    for (const a of db.prepare("SELECT * FROM agents WHERE state != 'STOPPED' ORDER BY id").all()) {
      setState(db, a, 'STOPPED', 'KILL_SWITCH_ENGAGED', by, { protective_policy });
      agentsStopped.push(a.id);
      // RUNNING agents lose their time-exit monitoring now; under CANCEL_ALL every agent's positions also lose stop/TP.
      if (a.state === 'RUNNING' || protective_policy === 'CANCEL_ALL') {
        const te = journalTimeExitSuspension(db, rc, a, { to: 'STOPPED', reason: 'KILL_SWITCH_ENGAGED', actor, protective_policy });
        if (te.length) timeExitsSuspended[a.id] = te.map((x) => x.sym);
      }
    }
    append(db, {
      session_id: rc.session_id, ts_sim: rc.clock, actor, type: 'KILL_SWITCH_EFFECTS', ref_id: KILL_KEY,
      payload: { protective_policy, cancelled, keptProtective: stillKept, agentsStopped, timeExitsSuspended, note: 'Agents stay STOPPED after release until a human starts each one.' },
    });
    return { ok: true, kill: readKillState(db), cancelled, kept: stillKept, agentsStopped, alreadyEngaged: prev.engaged };
  });
}

/** Release the kill switch. Agents remain STOPPED until individually started. */
export function releaseKill(db, { by = 'human' } = {}) {
  return atomic(db, () => {
    const prev = readKillState(db);
    if (!prev.engaged) return { ok: true, alreadyReleased: true, kill: prev };
    const rc = replayCtx(db);
    writeKill(db, { engaged: false, at: prev.at, by: prev.by, protective_policy: prev.protective_policy, released_at: Date.now(), released_at_sim: rc.clock, released_by: byLabel(by) });
    append(db, {
      session_id: rc.session_id, ts_sim: rc.clock, actor: actorFor(by), type: 'KILL_SWITCH_RELEASED', ref_id: KILL_KEY,
      payload: { by: byLabel(by), engagedAt: prev.at, note: 'Agents remain STOPPED; each must be started individually by a human.' },
    });
    return { ok: true, kill: readKillState(db) };
  });
}

function refuse(db, agent, code, message, by, action) {
  const rc = replayCtx(db);
  append(db, {
    session_id: rc.session_id, ts_sim: rc.clock, portfolio_id: agent?.portfolio_id ?? null, agent_id: agent?.id ?? null, actor: actorFor(by),
    type: 'AGENT_CONTROL_REFUSED', ref_id: agent?.id ?? null, payload: { action, code, message, state: agent?.state ?? null },
  });
  return { ok: false, code, message };
}

/**
 * Start (or resume) an agent: -> RUNNING. Refused while the kill switch is engaged, when the strategy is invalid, or
 * when the agent's portfolio does not exist in the current replay session.
 */
export function startAgent(db, id, { by = 'human', action = 'start' } = {}) {
  const row = db.prepare('SELECT * FROM agents WHERE id = ?').get(id);
  if (!row) return { ok: false, code: 'AGENT_NOT_FOUND', message: `agent ${id} not found` };
  if (readKillState(db).engaged) return refuse(db, row, 'KILL_SWITCH_ENGAGED', 'kill switch engaged: agents cannot be started until it is released', by, action);
  if (row.state === 'RUNNING') return { ok: true, unchanged: true, agent: getAgent(db, id) };
  const v = validateStrategy(parseJson(row.strategy_json));
  if (!v.ok) return refuse(db, row, 'STRATEGY_INVALID', v.errors.slice(0, 5).join('; '), by, action);
  const rc = replayCtx(db);
  if (!rc.session_id || !db.prepare('SELECT 1 FROM portfolios WHERE id = ? AND session_id = ?').get(row.portfolio_id, rc.session_id)) {
    return refuse(db, row, 'NO_REPLAY_SESSION', 'no replay session with this agent\'s portfolio; reset the replay first', by, action);
  }
  setState(db, row, 'RUNNING', `${action === 'resume' ? 'resumed' : 'started'} by ${byLabel(by)}`, by, { action });
  return { ok: true, agent: getAgent(db, id) };
}

/** Resume = start (same checks). Kept separate for the API verb and journal wording. */
export function resumeAgent(db, id, { by = 'human' } = {}) {
  return startAgent(db, id, { by, action: 'resume' });
}

/**
 * Pause an agent: -> PAUSED. New entries stop; protective stop-loss / take-profit orders keep working (KEEP_PROTECTIVE);
 * pending time-exit rules are suspended until resume (TIME_EXIT_SUSPENDED). By default the agent's own pending entry
 * orders are cancelled so no new exposure opens while paused.
 */
export function pauseAgent(db, id, { by = 'human', cancel_pending_entries = true } = {}) {
  const row = db.prepare('SELECT * FROM agents WHERE id = ?').get(id);
  if (!row) return { ok: false, code: 'AGENT_NOT_FOUND', message: `agent ${id} not found` };
  if (row.state === 'PAUSED') return { ok: true, unchanged: true, agent: getAgent(db, id), cancelled: [] };
  return atomic(db, () => {
    const rc = replayCtx(db);
    const cancelled = cancel_pending_entries ? cancelAgentPendingEntries(db, rc, id, { by, reason: 'AGENT_PAUSED' }) : [];
    setState(db, row, 'PAUSED', `paused by ${byLabel(by)}; stop-loss / take-profit orders keep working (KEEP_PROTECTIVE); time exits are suspended until resume`,
      by, { cancelledPendingEntries: cancelled });
    if (row.state === 'RUNNING') journalTimeExitSuspension(db, rc, row, { to: 'PAUSED', reason: 'AGENT_PAUSED', actor: actorFor(by) });
    return { ok: true, agent: getAgent(db, id), cancelled };
  });
}

/**
 * On server start: every RUNNING agent becomes PAUSED (authority is not implicitly resumed after a restart) and its
 * pending entry orders are cancelled (a restart must not let an entry fill with no supervising agent; protective
 * orders keep working). Pending entries of BLOCKED / FAULTED agents are cancelled too (no supervisor either). PAUSED
 * agents are left as a human paused them. Idempotent.
 */
export function pauseAllOnBoot(db) {
  const running = db.prepare("SELECT * FROM agents WHERE state = 'RUNNING' ORDER BY id").all();
  const unsupervised = db.prepare("SELECT * FROM agents WHERE state IN ('BLOCKED', 'FAULTED') ORDER BY id").all();
  const rc = replayCtx(db);
  const hasEntries = (a) => rc.session_id && db.prepare(`SELECT 1 FROM orders WHERE session_id = ? AND agent_id = ? AND role = 'entry'
    AND status IN (${OPEN.map(() => '?').join(',')}) LIMIT 1`).get(rc.session_id, a.id, ...OPEN);
  if (!running.length && !unsupervised.some(hasEntries)) return { ok: true, paused: [], cancelled: {} };
  return atomic(db, () => {
    const cancelled = {};
    for (const a of running) {
      const ids = cancelAgentPendingEntries(db, rc, a.id, { by: 'system', reason: 'AGENTS_PAUSED_ON_BOOT' });
      if (ids.length) cancelled[a.id] = ids;
      setState(db, a, 'PAUSED', BOOT_PAUSE_REASON, 'system', { boot: true, cancelledPendingEntries: ids });
      journalTimeExitSuspension(db, rc, a, { to: 'PAUSED', reason: 'AGENTS_PAUSED_ON_BOOT' });
    }
    for (const a of unsupervised) {
      const ids = cancelAgentPendingEntries(db, rc, a.id, { by: 'system', reason: `BOOT_UNSUPERVISED_ENTRY:${a.state}` });
      if (ids.length) cancelled[a.id] = ids;
    }
    append(db, { session_id: rc.session_id, ts_sim: rc.clock, actor: 'system', type: 'AGENTS_PAUSED_ON_BOOT', ref_id: null,
      payload: { agents: running.map((a) => a.id), reason: BOOT_PAUSE_REASON, cancelledPendingEntries: cancelled,
        note: 'Pending entry orders of agents without a RUNNING supervisor were cancelled; protective stop-loss / take-profit orders keep working.' } });
    return { ok: true, paused: running.map((a) => a.id), cancelled };
  });
}

/**
 * Replace an agent's strategy (validated; segment must match the agent; label forced to EXPLORATORY). Takes effect at
 * the next replay step.
 */
export function setAgentStrategy(db, id, strategy, { by = 'human' } = {}) {
  const row = db.prepare('SELECT * FROM agents WHERE id = ?').get(id);
  if (!row) return { ok: false, code: 'AGENT_NOT_FOUND', message: `agent ${id} not found` };
  const v = validateStrategy(strategy);
  if (!v.ok) return { ok: false, code: 'STRATEGY_INVALID', message: v.errors.join('; '), errors: v.errors };
  if (v.strategy.segment !== row.segment) return { ok: false, code: 'STRATEGY_SEGMENT_MISMATCH', message: `strategy segment ${v.strategy.segment} != agent segment ${row.segment}` };
  const rc = replayCtx(db);
  return atomic(db, () => {
    const prev = parseJson(row.strategy_json);
    db.prepare('UPDATE agents SET strategy_json = ?, updated_wall = ? WHERE id = ?').run(JSON.stringify(v.strategy), Date.now(), id);
    append(db, { session_id: rc.session_id, ts_sim: rc.clock, portfolio_id: row.portfolio_id, agent_id: id, actor: actorFor(by), type: 'STRATEGY_CHANGED', ref_id: id,
      payload: { by: byLabel(by), from: prev?.id ?? null, to: v.strategy.id, label: v.strategy.label, decisionMode: v.strategy.decisionMode, strategy: v.strategy } });
    return { ok: true, agent: getAgent(db, id) };
  });
}
