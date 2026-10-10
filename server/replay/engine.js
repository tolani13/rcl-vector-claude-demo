// Replay engine (docs/CONTRACTS.md section 7). Advances a persistent replay clock over a REAL ingested market dataset,
// server-side (never tied to a browser tab). The clock lives in replay_state (id = 1) and survives restarts; a running
// play timer does not (bootRecover() marks the replay not-playing and pauses RUNNING agents).
//
// Per replay minute (clock C -> C + 60 s):
//   1. orders.processMinute(C)      evaluate working orders against the now-complete minute [C, C+60s)
//   2. persist clock = C + 60 s
//   3. mark-to-market               portfolios with positions marked at the IEX bid as-of the new clock (journal MARK_TO_MARKET)
//   4. runAgentsStep(new clock)     RUNNING agents monitor / scan / decide / gate / submit (only before the close)
//   5. at the replay end            every open order expires (orders.js caps DAY expiry at the replay end; anything still
//                                   open is expired by expireOpenAtReplayEnd), play stops, REPLAY_SESSION_CLOSED records
//                                   what actually expired.
// step() is single-flight: a concurrent call is refused with REPLAY_BUSY (a play tick that finds a step in flight
// is skipped). Determinism: the same dataset + the same strategies + the same agent controls produce the same
// sequence of decisions (only ids and wall-clock fields differ).
//
// Partial (truncated) datasets: the replay ends at min(16:00 close, coverage end) because market state after the
// coverage end was never observed; a partial dataset whose data ends at/before the open is refused (DATASET_INCOMPLETE).
// Reset keeps each agent's current validated strategy unless restorePresets (see reset()), journals per-agent
// STRATEGY_CHANGED / AGENT_STATE_CHANGED where they change, and leaves agents STOPPED while the kill switch is engaged.
import { MINUTE, etToUtc, fmtEt } from '../util/time.js';
import { newId, sha256Hex, stableStringify } from '../util/ids.js';
import { append } from '../journal.js';
import { listMarketDatasets, getDataset, sessionWindow, coverageEndMs } from '../data/marketdata.js';
import { createSessionPortfolios, listPortfolios, markToMarket, atomic } from '../sim/ledger.js';
import { processMinute, expireOrders, expireOpenAtReplayEnd } from '../sim/orders.js';
import { runAgentsStep } from '../agents/runner.js';
import { PRESETS, validateStrategy, STRATEGY_LABEL } from '../agents/strategies.js';
import { pauseAllOnBoot, getKillState } from '../controls.js';

export const DEFAULT_TICK_WALL_MS = 1500;
export const MIN_TICK_WALL_MS = 250;
export const MAX_TICK_WALL_MS = 60_000;
export const MAX_STEP_MINUTES = 390;

/** The six agents created on every reset: one per lens x segment portfolio. */
export const AGENT_DEFS = Object.freeze(['micro', 'large'].flatMap((segment) => ['cowboy', 'pragmatist', 'tightwad'].map((lens) => Object.freeze({
  id: `agent-${lens}-${segment}`, portfolio_id: `${lens}-${segment}`, lens, segment,
}))));

const DEFAULT_GRANT_ACTIONS = Object.freeze(['open', 'close', 'modify', 'cancel']);

/** State reasons written by reset(): agents start PAUSED, or stay STOPPED while the kill switch is engaged. */
export const RESET_PAUSED_REASON = 'replay reset: agents start PAUSED; a human must start each one';
export const RESET_KILL_REASON = 'KILL_SWITCH_ENGAGED (persisted across replay reset)';

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const fingerprint = (s) => sha256Hex(stableStringify(s));

function parseJson(s) {
  try { return s ? JSON.parse(s) : null; } catch { return null; }
}

/** End of the last whole replay minute (counted from `open`) at or before `ms`. */
const alignToMinute = (open, ms) => open + Math.floor((ms - open) / MINUTE) * MINUTE;

/**
 * Replay window of a market dataset: the regular session (09:30–16:00 ET), ended early at a PARTIAL dataset's
 * coverage end (aligned down to a whole replay minute) because market state after it was never observed.
 * @returns {{open:number, close:number, t_end:number, coverage_end:number|null, truncated:boolean} | {error:string, message:string, coverage_end?:number|null}}
 */
function replayWindow(db, d) {
  const win = sessionWindow(db, d.id);
  if (!win) return { error: 'NO_VERIFIED_DATA', message: `dataset ${d.id} has no trade date / session window` };
  if (d.status !== 'partial') return { open: win.open, close: win.close, t_end: win.close, coverage_end: null, truncated: false };
  const cov = coverageEndMs(db, d.id);
  if (!Number.isFinite(cov)) {
    return { error: 'DATASET_INCOMPLETE', coverage_end: null,
      message: `dataset ${d.id} is partial and its coverage end is unknown: no part of the session can be shown to have been observed` };
  }
  const aligned = alignToMinute(win.open, cov);
  if (aligned <= win.open) {
    return { error: 'DATASET_INCOMPLETE', coverage_end: cov,
      message: `dataset ${d.id} is partial: its data ends ${fmtEt(cov, { date: true })}, at or before the 09:30 ET open; no session minute was observed` };
  }
  const t_end = Math.min(win.close, aligned);
  return { open: win.open, close: win.close, t_end, coverage_end: cov, truncated: t_end < win.close };
}

// Module state: one replay per process.
const mod = {
  inFlight: null,            // promise of the running step (single-flight mutex)
  timer: null, timerDb: null, // server-side play timer
  agentCtx: {},              // defaults for step()/play(): {assess, model, costModels, limits}
  lastTickError: null,
};

/** Defaults passed to the agent runner by step()/play() when not given per call (e.g. a configured model assessor). */
export function setAgentContext({ assess, model, costModels, limits } = {}) {
  mod.agentCtx = { assess, model, costModels, limits };
}

/**
 * Replay state for the API. `playing` reflects the live server-side timer, not a stale DB flag.
 * t_end is the replay end: the 16:00 ET close, or a PARTIAL dataset's coverage end when that is earlier (truncated:
 * true; session_close keeps the regular close). A session recorded before truncation existed is capped the same way
 * here, so step()/play() never advance past the coverage end.
 */
export function getState(db) {
  const r = db.prepare('SELECT * FROM replay_state WHERE id = 1').get();
  const playing = !!(mod.timer && mod.timerDb === db);
  if (!r) {
    return { status: 'NO_SESSION', session_id: null, ds: null, t_start: null, t_end: null, clock: null, playing: false,
      tick_wall_ms: DEFAULT_TICK_WALL_MS, step_ms: MINUTE, busy: !!mod.inFlight, dataset: null, lastTickError: mod.lastTickError,
      session_close: null, coverage_end: null, truncated: false };
  }
  const d = r.ds ? getDataset(db, r.ds) : null;
  const sessionClose = d?.trade_date ? etToUtc(d.trade_date, 16, 0) : null;
  const partial = d?.status === 'partial';
  const cov = partial ? coverageEndMs(db, r.ds) : null;
  let tEnd = r.t_end;
  if (partial && Number.isFinite(r.t_start) && Number.isFinite(r.t_end)) {
    // Unknown coverage => nothing in the session is shown to have been observed: the replay cannot advance.
    tEnd = Math.max(r.t_start, Math.min(r.t_end, Number.isFinite(cov) ? alignToMinute(r.t_start, cov) : r.t_start));
  }
  const coverageEnd = Number.isFinite(cov) ? cov : null;
  const truncated = !!(r.ds && partial && Number.isFinite(tEnd) && Number.isFinite(sessionClose) && tEnd < sessionClose);
  const status = !r.ds ? 'NO_VERIFIED_DATA' : r.clock >= tEnd ? 'SESSION_CLOSED' : 'READY';
  return {
    status, session_id: r.session_id, ds: r.ds, t_start: r.t_start, t_end: tEnd, clock: r.clock, playing,
    tick_wall_ms: r.tick_wall_ms, step_ms: r.step_ms,
    minutesElapsed: r.ds ? Math.round((r.clock - r.t_start) / MINUTE) : null,
    minutesRemaining: r.ds ? Math.max(0, Math.round((tEnd - r.clock) / MINUTE)) : null,
    busy: !!mod.inFlight,
    dataset: d ? { id: d.id, provider: d.provider, trade_date: d.trade_date, status: d.status, venue_coverage: d.venue_coverage, complete: d.status === 'complete', coverage_end: coverageEnd } : null,
    session_close: r.ds ? sessionClose : null, coverage_end: coverageEnd, truncated,
    ...(truncated ? { truncation_note: `DATASET_TRUNCATED: the dataset's data ends ${fmtEt(coverageEnd ?? tEnd, { date: true })}; the replay ends there instead of the 16:00 ET close (market state after it was never observed).` } : {}),
    lastTickError: mod.lastTickError,
  };
}

function stopTimer(db) {
  if (mod.timer) { clearInterval(mod.timer); mod.timer = null; mod.timerDb = null; }
  try { db.prepare('UPDATE replay_state SET playing = 0, updated_wall = ? WHERE id = 1').run(Date.now()); } catch { /* no state row yet */ }
}

/**
 * Strategies for the new session, one per agent, plus what changed against the stored agent rows.
 * Per agent: an explicit `strategies` entry (keyed by agent id or portfolio id) wins; otherwise the agent's current
 * stored strategy is carried when it still validates and targets the agent's segment, unless `restorePresets`;
 * otherwise its EXPLORATORY preset.
 * @returns {{ok:true, plan:object[]} | {ok:false, code:string, message:string}}
 */
function planStrategies(db, strategies, restorePresets, revertNote) {
  const existing = new Map(db.prepare('SELECT id, state, state_reason, strategy_json FROM agents').all().map((r) => [r.id, r]));
  const plan = [];
  for (const def of AGENT_DEFS) {
    const old = existing.get(def.id) ?? null;
    const oldParsed = old ? parseJson(old.strategy_json) : null;
    const oldV = oldParsed ? validateStrategy(oldParsed) : null;
    const override = strategies?.[def.id] ?? strategies?.[def.portfolio_id];
    let source;
    let candidate;
    let note = null;
    if (override !== undefined) {
      source = 'override';
      candidate = override;
    } else if (old && !restorePresets) {
      if (oldV?.ok && oldV.strategy.segment === def.segment) {
        source = 'carried';
        candidate = oldV.strategy;
      } else {
        source = 'preset';
        candidate = PRESETS[def.portfolio_id];
        note = `stored strategy not reusable (${oldV?.ok ? `segment ${oldV.strategy.segment} != ${def.segment}` : (oldV?.errors ?? ['stored strategy is not valid JSON']).slice(0, 3).join('; ')}); preset applied`;
      }
    } else {
      source = 'preset';
      candidate = PRESETS[def.portfolio_id];
      note = old ? revertNote : 'no existing agent (first session)';
    }
    const v = validateStrategy(candidate);
    if (!v.ok) return { ok: false, code: 'STRATEGY_INVALID', message: `${def.id}: ${v.errors.slice(0, 5).join('; ')}` };
    if (v.strategy.segment !== def.segment) return { ok: false, code: 'STRATEGY_SEGMENT_MISMATCH', message: `${def.id}: strategy segment ${v.strategy.segment}` };
    const preset = validateStrategy(PRESETS[def.portfolio_id]);
    const sha = fingerprint(v.strategy);
    // Compare normalized forms: a stored strategy that validates to the same object is unchanged.
    const fromKey = oldV?.ok ? stableStringify(oldV.strategy) : old ? `raw:${old.strategy_json}` : null;
    plan.push({
      def, old, strategy: v.strategy, source, note, sha,
      matchesPreset: preset.ok && fingerprint(preset.strategy) === sha,
      fromId: oldV?.ok ? oldV.strategy.id : (typeof oldParsed?.id === 'string' ? oldParsed.id.slice(0, 120) : null),
      strategyChanged: !!old && fromKey !== stableStringify(v.strategy),
    });
  }
  return { ok: true, plan };
}

/**
 * Start a new replay session.
 * @param {{ds?:string|null, startingCashU?:number|Record<string,number>, strategies?:Record<string,object>|null,
 *          restorePresets?:boolean, actor?:'human'|'system'}} opts
 *   ds: market dataset id. Default: the newest replayable market dataset (a partial one whose data ends at/before the
 *     open is skipped and listed in REPLAY_RESET.skippedDatasets); none at all => ds null, status NO_VERIFIED_DATA.
 *     An explicit partial dataset whose data ends at/before the open is refused (DATASET_INCOMPLETE). A partial
 *     dataset's replay ends at min(16:00 close, coverage end): REPLAY_RESET records coverage_end and truncated.
 *   strategies / restorePresets — ONE rule for every caller (the HTTP flag of the same name maps 1:1):
 *     each agent gets its entry in `strategies` (keyed by agent id or portfolio id) when present; otherwise its
 *     current stored strategy is KEPT when it validates for its segment, unless restorePresets is true; otherwise its
 *     EXPLORATORY preset. restorePresets defaults to false when `strategies` is omitted (strategy edits survive a
 *     reset) and to true when a `strategies` map is supplied (the map is then a complete specification: agents it
 *     does not name get presets; pass restorePresets:false to keep their current strategies instead).
 *   actor: who requested the reset, journaled on REPLAY_RESET and the per-agent rows ('human' = API/UI; 'system' =
 *     boot-time initial reset).
 * Agents start PAUSED — or STOPPED (reason RESET_KILL_REASON) while the kill switch is engaged, because a reset
 * never re-arms authority the kill switch removed. Each existing agent whose strategy or state changes gets a
 * STRATEGY_CHANGED / AGENT_STATE_CHANGED row (reason REPLAY_RESET) in the new session's journal.
 * @returns {{ok:true, state:object, session_id:string, strategies:object[]} | {ok:false, code:string, message:string}}
 *   strategies: per agent {agent_id, strategy_id, strategy_source:'override'|'carried'|'preset', strategy_sha256,
 *   matchesPreset, strategyChanged, state, previousState, note?}.
 */
export function reset(db, { ds = null, startingCashU, strategies = null, restorePresets, actor = 'human' } = {}) {
  if (mod.inFlight) return { ok: false, code: 'REPLAY_BUSY', message: 'a replay step is in progress' };
  if (actor !== 'human' && actor !== 'system') return { ok: false, code: 'ACTOR_INVALID', message: "actor must be 'human' | 'system'" };
  if (restorePresets !== undefined && typeof restorePresets !== 'boolean') return { ok: false, code: 'RESTORE_PRESETS_INVALID', message: 'restorePresets must be a boolean' };
  if (strategies !== null && strategies !== undefined && !isPlainObject(strategies)) {
    return { ok: false, code: 'STRATEGY_INVALID', message: 'strategies must be an object keyed by agent id or portfolio id' };
  }
  const hasMap = strategies !== null && strategies !== undefined;
  const revert = restorePresets ?? hasMap;

  const datasets = listMarketDatasets(db);
  let chosen = null;
  let win = null;
  const skippedDatasets = [];
  if (ds !== null && ds !== undefined) {
    chosen = datasets.find((d) => d.id === ds) ?? null;
    if (!chosen) return { ok: false, code: 'DATASET_NOT_FOUND', message: `no replayable market dataset with id ${String(ds).slice(0, 80)}` };
    win = replayWindow(db, chosen);
    if (win.error) return { ok: false, code: win.error, message: win.message, ...('coverage_end' in win ? { coverage_end: win.coverage_end } : {}) };
  } else {
    for (const d of datasets) {
      const w = replayWindow(db, d);
      if (!w.error) { chosen = d; win = w; break; }
      skippedDatasets.push({ id: d.id, code: w.error, coverage_end: w.coverage_end ?? null, message: w.message });
    }
    if (!chosen && skippedDatasets.length) {
      return { ok: false, code: skippedDatasets[0].code, message: `no replayable market dataset: ${skippedDatasets.map((s) => s.message).join(' | ').slice(0, 600)}` };
    }
  }

  const sp = planStrategies(db, strategies, revert,
    restorePresets === true ? 'restorePresets requested: preset applied' : 'not named in the strategies map (a supplied map is a complete specification): preset applied');
  if (!sp.ok) return sp;
  // Fail closed: an unreadable kill-switch row keeps agents STOPPED (the gate denies on an unknown state too).
  let kill;
  try { kill = getKillState(db); } catch { kill = { engaged: true, unreadable: true }; }
  const toState = kill.engaged ? 'STOPPED' : 'PAUSED';
  const toReason = kill.unreadable ? 'KILL_SWITCH_STATE_UNREADABLE (agents kept STOPPED across replay reset)'
    : kill.engaged ? RESET_KILL_REASON : RESET_PAUSED_REASON;

  stopTimer(db);
  mod.lastTickError = null;
  const session_id = newId('ses');
  const prev = db.prepare('SELECT session_id, tick_wall_ms FROM replay_state WHERE id = 1').get();
  const previous_session_id = prev?.session_id ?? null;
  const tick = prev?.tick_wall_ms ?? DEFAULT_TICK_WALL_MS;
  const now = Date.now();
  const open = win ? win.open : null;
  const tEnd = win ? win.t_end : null;
  const applied = sp.plan.map((p) => ({
    agent_id: p.def.id, strategy_id: p.strategy.id, strategy_source: p.source, strategy_sha256: p.sha, matchesPreset: p.matchesPreset,
    strategyChanged: p.strategyChanged, state: toState, previousState: p.old?.state ?? null, ...(p.note ? { note: p.note.slice(0, 300) } : {}),
  }));
  atomic(db, () => {
    createSessionPortfolios(db, session_id, { ...(startingCashU !== undefined ? { startingCashU } : {}), clock: open });
    const up = db.prepare(`INSERT INTO agents (id, portfolio_id, lens, segment, state, state_reason, strategy_json, grants_json, last_ok_json, last_fail_json, updated_wall)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?)
      ON CONFLICT(id) DO UPDATE SET portfolio_id = excluded.portfolio_id, lens = excluded.lens, segment = excluded.segment, state = excluded.state,
        state_reason = excluded.state_reason, strategy_json = excluded.strategy_json, grants_json = excluded.grants_json,
        last_ok_json = NULL, last_fail_json = NULL, updated_wall = excluded.updated_wall`);
    for (const p of sp.plan) {
      const grants = { portfolios: [p.def.portfolio_id], actions: [...DEFAULT_GRANT_ACTIONS], instruments: ['equity'] };
      up.run(p.def.id, p.def.portfolio_id, p.def.lens, p.def.segment, toState, toReason, JSON.stringify(p.strategy), JSON.stringify(grants), now);
    }
    db.prepare(`INSERT INTO replay_state (id, session_id, ds, t_start, t_end, clock, playing, step_ms, tick_wall_ms, created_wall, updated_wall)
      VALUES (1, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET session_id = excluded.session_id, ds = excluded.ds, t_start = excluded.t_start, t_end = excluded.t_end,
        clock = excluded.clock, playing = 0, step_ms = excluded.step_ms, tick_wall_ms = excluded.tick_wall_ms,
        created_wall = excluded.created_wall, updated_wall = excluded.updated_wall`)
      .run(session_id, chosen ? chosen.id : null, open, tEnd, open, MINUTE, tick, now, now);
    const truncationNote = win?.truncated
      ? ` PARTIAL DATASET: its data ends ${fmtEt(win.coverage_end, { date: true })}, so the replay ends at ${fmtEt(tEnd)} instead of the 16:00 ET close (market state after it was never observed).`
      : '';
    append(db, {
      session_id, ts_sim: open, actor, type: 'REPLAY_RESET', ref_id: session_id,
      payload: {
        ds: chosen ? chosen.id : null, status: chosen ? 'READY' : 'NO_VERIFIED_DATA',
        dataset: chosen ? { id: chosen.id, provider: chosen.provider, trade_date: chosen.trade_date, status: chosen.status, sha256: chosen.sha256 ?? null } : null,
        t_start: open, t_end: tEnd, session_close: win ? win.close : null,
        coverage_end: win ? win.coverage_end : null, truncated: !!win?.truncated,
        previous_session_id,
        restorePresets: revert, killSwitchEngaged: kill.engaged, ...(kill.unreadable ? { killSwitchStateUnreadable: true } : {}),
        ...(skippedDatasets.length ? { skippedDatasets } : {}),
        agents: sp.plan.map((p) => ({
          id: p.def.id, portfolio_id: p.def.portfolio_id, state: toState, previousState: p.old?.state ?? null, strategy_id: p.strategy.id,
          strategy_source: p.source, strategyChanged: p.strategyChanged, decisionMode: p.strategy.decisionMode, label: STRATEGY_LABEL,
        })),
        note: (chosen ? 'New session: seed money is the only simulated input; the replay reveals only what was knowable at the clock.'
          : 'No replayable market dataset is ingested: NO_VERIFIED_DATA. Ingest a real dataset (npm run ingest:iex) and reset again.')
          + truncationNote
          + (kill.unreadable ? ' The kill-switch state is unreadable: every agent is kept STOPPED (fail closed).'
            : kill.engaged ? ' The kill switch is engaged: every agent stays STOPPED until it is released and a human starts each one.' : ''),
      },
    });
    // Per-agent rows (new session's journal) for each existing agent whose strategy or state the reset changed.
    for (const p of sp.plan) {
      if (!p.old) continue;
      if (p.strategyChanged) {
        append(db, {
          session_id, ts_sim: open, portfolio_id: p.def.portfolio_id, agent_id: p.def.id, actor, type: 'STRATEGY_CHANGED', ref_id: p.def.id,
          payload: { by: actor, from: p.fromId, to: p.strategy.id, reason: 'REPLAY_RESET', source: p.source, label: p.strategy.label,
            decisionMode: p.strategy.decisionMode, strategy: p.strategy, previous_session_id, ...(p.note ? { note: p.note.slice(0, 300) } : {}) },
        });
      }
      if (p.old.state !== toState) {
        append(db, {
          session_id, ts_sim: open, portfolio_id: p.def.portfolio_id, agent_id: p.def.id, actor, type: 'AGENT_STATE_CHANGED', ref_id: p.def.id,
          payload: { from: p.old.state, to: toState, reason: toReason, by: actor, replayReset: true, previous_session_id },
        });
      }
    }
  });
  return { ok: true, session_id, state: getState(db), strategies: applied };
}

/** Mark portfolios that hold positions at the IEX bid as-of `clock` and journal one compact MARK_TO_MARKET row. */
function markAll(db, st, clock) {
  const rows = [];
  for (const p of listPortfolios(db, st.session_id)) {
    if (!db.prepare('SELECT 1 FROM positions WHERE session_id = ? AND portfolio_id = ? AND qty > 0 LIMIT 1').get(st.session_id, p.id)) continue;
    const m = markToMarket(db, st.ds, st.session_id, p.id, clock);
    rows.push({
      portfolio_id: p.id, cashU: p.cash, equityU: p.cash + m.marketValueU, unrealizedU: m.unrealizedU, realizedU: p.realized_pnl, unmarked: m.unmarkedCount,
      positions: m.positions.map((x) => ({ sym: x.sym, qty: x.qty, markU: x.markU, markBasis: x.markBasis })),
    });
  }
  if (rows.length) {
    append(db, { session_id: st.session_id, ts_sim: clock, actor: 'engine', type: 'MARK_TO_MARKET', ref_id: null,
      payload: { asOf: clock, basis: 'IEX bid as-of (conservative for longs); LAST_TRADE_NO_BID / UNMARKED fallbacks; unmarked positions count as 0 equity', portfolios: rows } });
  }
  return rows;
}

async function doStep(db, minutes, x) {
  const st = getState(db);
  if (!st.session_id) return { ok: false, code: 'NO_SESSION', message: 'no replay session; reset first' };
  if (!st.ds) return { ok: false, code: 'NO_VERIFIED_DATA', message: 'no replayable market dataset; the replay cannot advance' };
  if (st.clock >= st.t_end) return { ok: false, code: 'SESSION_CLOSED', message: 'the replay session has reached the close', state: st };
  const out = { ok: true, from: st.clock, to: st.clock, minutes: 0, fills: 0, triggered: 0, withheld: 0, expired: 0, ambiguities: 0,
    agentSteps: 0, intents: 0, accepted: 0, denied: 0, faults: 0, blocked: 0, closed: false };
  let clock = st.clock;
  for (let i = 0; i < minutes && clock < st.t_end; i++) {
    const next = clock + MINUTE;
    const octx = { session_id: st.session_id, ds: st.ds, clock: next, costModels: x.costModels };
    let pm;
    try {
      pm = processMinute(db, octx, next - MINUTE);
    } catch (e) {
      const detail = String(e?.message ?? e).slice(0, 300);
      append(db, { session_id: st.session_id, ts_sim: clock, actor: 'engine', type: 'ENGINE_FAULT', ref_id: null, payload: { stage: 'processMinute', minuteT: next - MINUTE, detail } });
      stopTimer(db);
      return { ...out, ok: false, code: 'ENGINE_FAULT', message: detail, to: clock, state: getState(db) };
    }
    db.prepare('UPDATE replay_state SET clock = ?, updated_wall = ? WHERE id = 1 AND session_id = ?').run(next, Date.now(), st.session_id);
    clock = next;
    out.minutes++;
    out.fills += pm.fills.length; out.triggered += pm.triggered.length; out.withheld += pm.withheld.length;
    out.expired += pm.expired.length; out.ambiguities += pm.ambiguities.length;
    markAll(db, st, next);
    if (next < st.t_end) {
      const ar = await runAgentsStep(db, { session_id: st.session_id, ds: st.ds, clock: next, t_end: st.t_end, assess: x.assess, model: x.model, costModels: x.costModels, limits: x.limits });
      out.agentSteps++;
      for (const a of ar.agents) {
        if (a.status === 'FAULTED') out.faults++;
        if (a.status === 'BLOCKED') out.blocked++;
        for (const r of a.results || []) { out.intents++; if (r.decision === 'ACCEPTED') out.accepted++; else out.denied++; }
      }
    } else {
      // Orders due at the end (normally already expired by the final processMinute), then every order still open: no
      // later minute can be evaluated (e.g. orders recorded with a 16:00 ET expiry in a session later found PARTIAL).
      const exp = expireOrders(db, octx, st.t_end);
      const forced = expireOpenAtReplayEnd(db, octx, st.t_end, { reasonCode: st.truncated ? 'REPLAY_END_TRUNCATED' : 'REPLAY_END' });
      out.expired += exp.length + forced.length;
      const expiredAtEnd = [...pm.expired, ...exp, ...forced];
      const n = expiredAtEnd.length;
      const what = n === 0 ? 'no open orders remained to expire'
        : `${n} open order(s) expired in the final minute${forced.length ? ` (${forced.length} of them recorded with a later expiry and expired here because no later minute can be evaluated)` : ''}`;
      append(db, { session_id: st.session_id, ts_sim: next, actor: 'engine', type: 'REPLAY_SESSION_CLOSED', ref_id: st.session_id,
        payload: {
          t_end: st.t_end, session_close: st.session_close, coverage_end: st.coverage_end, truncated: st.truncated,
          expiredAtClose: expiredAtEnd, expiredCount: n, forcedExpiredAtReplayEnd: forced,
          note: st.truncated
            ? `Replay end reached at the PARTIAL dataset's coverage end (before the 16:00 ET close): no later market state was observed; ${what}; play stopped.`
            : `Session close reached: ${what}; play stopped.`,
        } });
      out.closed = true;
      stopTimer(db);
    }
  }
  out.to = clock;
  return { ...out, state: getState(db) };
}

/**
 * Advance the replay by `minutes` (1..390), single-flight.
 * @param {{minutes?:number, assess?:Function, model?:object, costModels?:object, limits?:object}} opts
 */
export async function step(db, { minutes = 1, ...ctx } = {}) {
  if (!Number.isSafeInteger(minutes) || minutes < 1 || minutes > MAX_STEP_MINUTES) {
    return { ok: false, code: 'MINUTES_INVALID', message: `minutes must be an integer 1..${MAX_STEP_MINUTES}` };
  }
  if (mod.inFlight) return { ok: false, code: 'REPLAY_BUSY', message: 'a replay step is already in progress' };
  const x = { ...mod.agentCtx, ...Object.fromEntries(Object.entries(ctx).filter(([, v]) => v !== undefined)) };
  const run = doStep(db, minutes, x);
  mod.inFlight = run;
  try { return await run; } finally { mod.inFlight = null; }
}

async function tick(db) {
  if (mod.inFlight) return; // single-flight: skip this tick, the next one retries
  try {
    const r = await step(db, { minutes: 1 });
    if (!r.ok) { mod.lastTickError = { code: r.code, message: r.message ?? null, at: Date.now() }; pause(db, { reason: `step failed: ${r.code}` }); }
    else if (r.closed) pause(db, { reason: 'session close reached' });
  } catch (e) {
    mod.lastTickError = { code: 'TICK_EXCEPTION', message: String(e?.message ?? e).slice(0, 300), at: Date.now() };
    pause(db, { reason: 'tick exception' });
  }
}

/** Start server-side play: one replay minute every tick_wall_ms of wall time. */
export function play(db, { tick_wall_ms, assess, model, costModels, limits } = {}) {
  const st = getState(db);
  if (!st.session_id) return { ok: false, code: 'NO_SESSION', message: 'no replay session; reset first' };
  if (!st.ds) return { ok: false, code: 'NO_VERIFIED_DATA', message: 'no replayable market dataset' };
  if (st.clock >= st.t_end) return { ok: false, code: 'SESSION_CLOSED', message: 'the replay session has reached the close' };
  const ms = tick_wall_ms ?? st.tick_wall_ms ?? DEFAULT_TICK_WALL_MS;
  if (!Number.isSafeInteger(ms) || ms < MIN_TICK_WALL_MS || ms > MAX_TICK_WALL_MS) {
    return { ok: false, code: 'TICK_INVALID', message: `tick_wall_ms must be an integer ${MIN_TICK_WALL_MS}..${MAX_TICK_WALL_MS}` };
  }
  if (assess !== undefined || model !== undefined || costModels !== undefined || limits !== undefined) {
    setAgentContext({ assess: assess ?? mod.agentCtx.assess, model: model ?? mod.agentCtx.model, costModels: costModels ?? mod.agentCtx.costModels, limits: limits ?? mod.agentCtx.limits });
  }
  if (mod.timer) { clearInterval(mod.timer); mod.timer = null; }
  mod.lastTickError = null;
  mod.timerDb = db;
  mod.timer = setInterval(() => { void tick(db); }, ms);
  mod.timer.unref?.();
  db.prepare('UPDATE replay_state SET playing = 1, tick_wall_ms = ?, updated_wall = ? WHERE id = 1').run(ms, Date.now());
  append(db, { session_id: st.session_id, ts_sim: st.clock, actor: 'human', type: 'REPLAY_PLAY', ref_id: st.session_id, payload: { tick_wall_ms: ms } });
  return { ok: true, state: getState(db) };
}

/** Stop server-side play (idempotent). */
export function pause(db, { reason = 'paused by human' } = {}) {
  const was = !!mod.timer;
  stopTimer(db);
  if (was) {
    const st = getState(db);
    append(db, { session_id: st.session_id, ts_sim: st.clock, actor: reason === 'paused by human' ? 'human' : 'engine', type: 'REPLAY_PAUSE', ref_id: st.session_id, payload: { reason } });
  }
  return { ok: true, state: getState(db) };
}

/**
 * Server start: the play timer did not survive the restart, agent authority is not implicitly resumed, and pending
 * entry orders of agents left without a RUNNING supervisor are cancelled (protective orders keep working).
 */
export function bootRecover(db) {
  stopTimer(db);
  const agents = pauseAllOnBoot(db);
  return { ok: true, state: getState(db), pausedAgents: agents.paused, cancelledPendingEntries: agents.cancelled ?? {} };
}
