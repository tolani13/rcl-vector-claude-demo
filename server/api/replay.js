// Replay controls (docs/CONTRACTS.md sections 7 and 9). The clock lives on the server (server/replay/engine.js); these
// endpoints only reset / step / play / pause it. A multi-minute API step advances one engine minute at a time and yields
// to the event loop between minutes, so status polls stay responsive; it is refused while the server-side timer plays.
// Reset strategy rule (one rule, owned by engine.reset; restorePresets maps 1:1): each agent keeps its current validated
// strategy, or gets its EXPLORATORY preset when restorePresets is true (or the stored one is not reusable). The engine
// journals REPLAY_RESET plus per-agent STRATEGY_CHANGED / AGENT_STATE_CHANGED rows, keeps agents STOPPED while the kill
// switch is engaged, and ends a PARTIAL dataset's replay at its coverage end (or refuses it: DATASET_INCOMPLETE).
import { reset, step, play, pause } from '../replay/engine.js';
import { ApiError, badRequest, conflict, onlyKeys, intIn, bool, ID_RE } from './http.js';

const SUM_FIELDS = ['minutes', 'fills', 'triggered', 'withheld', 'expired', 'ambiguities', 'agentSteps', 'intents', 'accepted', 'denied', 'faults', 'blocked'];

function stepError(r) {
  if (r.code === 'MINUTES_INVALID') return badRequest(r.code, r.message);
  if (r.code === 'ENGINE_FAULT') return new ApiError(500, r.code, `replay engine fault: ${String(r.message ?? '').slice(0, 300)}`);
  return conflict(r.code, r.message ?? r.code);
}

const pct = (arr, p) => {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};

/**
 * POST /api/replay/reset {ds?, startingCashU?, restorePresets?} — new session: seven portfolios, six agents PAUSED (STOPPED
 * while the kill switch is engaged), clock at the open. Agents keep their current strategies unless restorePresets is true.
 */
export function postReset(ctx, _req, { body }) {
  onlyKeys(body, ['ds', 'startingCashU', 'restorePresets', 'confirm']);
  if (body.ds !== undefined && body.ds !== null && (typeof body.ds !== 'string' || !ID_RE.test(body.ds))) throw badRequest('ID_INVALID', 'ds must be a dataset id');
  const startingCashU = intIn(body.startingCashU, 10_000, 10_000_000_000_000, 'startingCashU (u = 1e-4 USD; $1..$1e9)', { optional: true, dflt: ctx.config.startingCashU });
  const restorePresets = bool(body.restorePresets, 'restorePresets', { optional: true, dflt: false });
  if (ctx.busy.step) throw conflict('REPLAY_BUSY', 'a replay step is in progress');
  const r = reset(ctx.db, { ds: body.ds ?? null, startingCashU, restorePresets, actor: 'human' });
  if (!r.ok) {
    if (r.code === 'DATASET_NOT_FOUND') throw new ApiError(404, r.code, r.message);
    if (r.code === 'STRATEGY_INVALID' || r.code === 'STRATEGY_SEGMENT_MISMATCH') throw new ApiError(422, r.code, r.message);
    if (r.code === 'RESTORE_PRESETS_INVALID') throw badRequest(r.code, r.message);
    throw conflict(r.code, r.message, 'coverage_end' in r ? { coverage_end: r.coverage_end } : null);
  }
  const strategies = Array.isArray(r.strategies) ? r.strategies : [];
  const stopped = strategies.some((x) => x.state === 'STOPPED');
  const start = stopped
    ? 'The kill switch is engaged: all agents stay STOPPED until it is released and a human starts each one.'
    : 'All agents start PAUSED; a human must start each one.';
  return {
    decision: 'OK', session_id: r.session_id, state: r.state, startingCashU, restorePresets, strategies,
    note: r.state.status === 'NO_VERIFIED_DATA'
      ? 'No replayable market dataset: the session exists but cannot advance (NO_VERIFIED_DATA).'
      : `New session. ${start} Seed money is the only simulated input. ${restorePresets ? 'Agent strategies reverted to EXPLORATORY presets.' : 'Agents keep their current strategies.'}${r.state.truncation_note ? ` ${r.state.truncation_note}` : ''}`,
  };
}

/** POST /api/replay/step {minutes 1..390} */
export async function postStep(ctx, _req, { body }) {
  onlyKeys(body, ['minutes']);
  const minutes = intIn(body.minutes, 1, 390, 'minutes', { optional: true, dflt: 1 });
  const st = ctx.replay();
  if (st.playing) throw conflict('REPLAY_PLAYING', 'the replay is playing on the server; pause it before stepping manually');
  if (ctx.busy.step || st.busy) throw conflict('REPLAY_BUSY', 'a replay step is already in progress');
  ctx.busy.step = true;
  const t0 = performance.now();
  const perMinuteMs = [];
  const out = Object.fromEntries(SUM_FIELDS.map((k) => [k, 0]));
  let from = null;
  let to = st.clock;
  let closed = false;
  let stoppedEarly = null;
  try {
    for (let i = 0; i < minutes; i++) {
      const m0 = performance.now();
      const r = await step(ctx.db, { minutes: 1 });
      perMinuteMs.push(Math.round(performance.now() - m0));
      if (!r.ok) {
        if (i === 0) throw stepError(r);
        stoppedEarly = { code: r.code, message: r.message ?? null };
        break;
      }
      if (from === null) from = r.from;
      to = r.to;
      for (const k of SUM_FIELDS) out[k] += r[k] ?? 0;
      if (r.closed) { closed = true; break; }
      if (i + 1 < minutes) await new Promise((res) => setImmediate(res));
    }
  } finally {
    ctx.busy.step = false;
  }
  return {
    decision: 'OK', from, to, ...out, closed, stoppedEarly, state: ctx.replay(),
    timing: { ms: Math.round(performance.now() - t0), perMinuteMs: { p50: pct(perMinuteMs, 50), p95: pct(perMinuteMs, 95), max: perMinuteMs.length ? Math.max(...perMinuteMs) : null } },
  };
}

/** POST /api/replay/play {tick_wall_ms?} — server-side timer; continues without any browser. */
export function postPlay(ctx, _req, { body }) {
  onlyKeys(body, ['tick_wall_ms']);
  const tick = intIn(body.tick_wall_ms, 250, 60_000, 'tick_wall_ms', { optional: true, dflt: ctx.config.tickWallMs ?? undefined });
  if (ctx.busy.step) throw conflict('REPLAY_BUSY', 'a manual replay step is in progress');
  const r = play(ctx.db, tick === undefined ? {} : { tick_wall_ms: tick });
  if (!r.ok) throw r.code === 'TICK_INVALID' ? badRequest(r.code, r.message) : conflict(r.code, r.message);
  return { decision: 'OK', state: r.state };
}

/** POST /api/replay/pause */
export function postPause(ctx, _req, { body }) {
  onlyKeys(body, []);
  const r = pause(ctx.db, { reason: 'paused by human' });
  return { decision: 'OK', state: r.state };
}
