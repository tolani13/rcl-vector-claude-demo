// TEST FIXTURE — NOT MARKET DATA. Replay engine on synthetic minute rows: NO_VERIFIED_DATA state, input validation,
// single-flight mutex, persistent clock, deterministic reset (identical decision sequences), no look-ahead at the
// runner level (spy on every m1 row read + differential store), session close, server-side play/pause.
import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { reset, step, play, pause, getState, AGENT_DEFS } from '../../server/replay/engine.js';
import { startAgent, getAgent, listAgents } from '../../server/controls.js';
import { runAgentsStep, createLensAssessor } from '../../server/agents/runner.js';
import { processMinute } from '../../server/sim/orders.js';
import { listPortfolios } from '../../server/sim/ledger.js';
import { PRESETS } from '../../server/agents/strategies.js';
import {
  at, MINUTE, setupDb, openTestDb, jumpTape, flat, addMinute, testStrategy, rowsOfType, ordersOf, decisionSequence, FIXTURE_DS,
} from './helpers/fixture.js';

const AGENT = 'agent-cowboy-micro';

test('reset with no market dataset: NO_VERIFIED_DATA, portfolios + six PAUSED agents, step/play refused', async () => {
  const t = openTestDb('nodata');
  try {
    const r = reset(t.db, {});
    assert.equal(r.ok, true);
    assert.equal(r.state.status, 'NO_VERIFIED_DATA');
    assert.equal(r.state.ds, null);
    assert.equal(r.state.clock, null);
    assert.equal(listPortfolios(t.db, r.session_id).length, 7);
    const agents = listAgents(t.db);
    assert.equal(agents.length, 6);
    for (const a of agents) {
      assert.equal(a.state, 'PAUSED');
      assert.equal(a.strategy.id, PRESETS[a.portfolio_id].id);
      assert.deepEqual(a.grants, { portfolios: [a.portfolio_id], actions: ['open', 'close', 'modify', 'cancel'], instruments: ['equity'] });
    }
    assert.deepEqual(agents.map((a) => a.id).sort(), AGENT_DEFS.map((d) => d.id).sort());
    assert.equal((await step(t.db, { minutes: 1 })).code, 'NO_VERIFIED_DATA');
    assert.equal(play(t.db, {}).code, 'NO_VERIFIED_DATA');
    assert.equal(reset(t.db, { ds: 'iex-nope' }).code, 'DATASET_NOT_FOUND');
    const [rr] = rowsOfType(t.db, r.session_id, 'REPLAY_RESET');
    assert.equal(rr.payload.status, 'NO_VERIFIED_DATA');
  } finally { t.cleanup(); }
});

test('reset picks the dataset session window; step validates minutes, persists the clock and is single-flight', async () => {
  const t = setupDb('engine', (db) => jumpTape(db, 'FIXA'));
  try {
    const r = reset(t.db, {});
    assert.equal(r.state.ds, FIXTURE_DS);
    assert.equal(r.state.t_start, at(9, 30));
    assert.equal(r.state.t_end, at(16, 0));
    assert.equal(r.state.clock, at(9, 30));
    assert.equal(r.state.status, 'READY');
    for (const bad of [0, 391, 1.5, '2']) assert.equal((await step(t.db, { minutes: bad })).code, 'MINUTES_INVALID');
    const p1 = step(t.db, { minutes: 3 });
    const busy = await step(t.db, { minutes: 1 });
    assert.equal(busy.code, 'REPLAY_BUSY');
    assert.equal(reset(t.db, {}).code, 'REPLAY_BUSY');
    const r1 = await p1;
    assert.equal(r1.ok, true);
    assert.equal(r1.to, at(9, 33));
    assert.equal(t.db.prepare('SELECT clock FROM replay_state WHERE id = 1').get().clock, at(9, 33), 'clock persisted');
    assert.equal(getState(t.db).minutesElapsed, 3);
    assert.equal(getState(t.db).busy, false);
  } finally { t.cleanup(); }
});

/** Two agents (TEST FIXTURE strategies), two symbols, a buy + stop and a rate-limit denial: a non-trivial decision path. */
function detTape(db) {
  jumpTape(db, 'FIXA', {
    after(d, sym) {
      flat(d, sym, at(9, 48), at(9, 49), 5800);
      addMinute(d, sym, at(9, 50), { trades: { o: 4600, h: 4600, l: 4500, c: 4500, v: 2000, n: 10 }, bid: 4490, ask: 4510, minBid: 4490, maxBid: 5790, minAsk: 4510, maxAsk: 5810 });
      flat(d, sym, at(9, 51), at(10, 30), 4500);
    },
  });
  jumpTape(db, 'FIXE');
}

async function runSession(db) {
  const r = reset(db, { strategies: { [AGENT]: testStrategy(), 'agent-tightwad-micro': testStrategy({ id: 'test:tightwad-micro' }) } });
  assert.equal(r.ok, true);
  assert.equal(startAgent(db, AGENT, { by: 'test' }).ok, true);
  assert.equal(startAgent(db, 'agent-tightwad-micro', { by: 'test' }).ok, true);
  const s = await step(db, { minutes: 25 });
  assert.equal(s.ok, true);
  return r.session_id;
}

test('deterministic reset: same dataset + same strategies => identical decision sequence', async () => {
  const t = setupDb('determinism', detTape);
  try {
    const a = await runSession(t.db);
    const b = await runSession(t.db);
    assert.notEqual(a, b, 'a new session id per reset');
    const seqA = decisionSequence(t.db, a);
    const seqB = decisionSequence(t.db, b);
    assert.ok(seqA.length > 60, `non-trivial sequence (${seqA.length})`);
    for (const type of ['INTENT_PROPOSED', 'POLICY_ACCEPT', 'POLICY_DENY', 'FILL_ESTIMATED', 'STOP_TRIGGERED']) {
      assert.ok(seqA.some((x) => x.type === type), `sequence contains ${type}`);
    }
    assert.deepEqual(seqB, seqA);
    // Different strategies diverge (the comparison is sensitive).
    const r = reset(t.db, { strategies: { [AGENT]: testStrategy({ entry: { budgetUsd: 60 } }) } });
    startAgent(t.db, AGENT, { by: 'test' });
    await step(t.db, { minutes: 25 });
    assert.notDeepEqual(decisionSequence(t.db, r.session_id), seqA);
  } finally { t.cleanup(); }
});

/** Wrap a DatabaseSync so every row returned from an m1 query is checked against the replay clock. */
function spyDb(db, clock, seen) {
  const wrapStmt = (sql, st) => new Proxy(st, {
    get(s, p) {
      const v = s[p];
      if (typeof v !== 'function') return v;
      if (p !== 'get' && p !== 'all') return v.bind(s);
      return (...args) => {
        const out = v.apply(s, args);
        if (/\bm1\b/.test(sql)) {
          for (const row of p === 'all' ? out : out ? [out] : []) {
            if (Number.isFinite(row.t)) { seen.rows++; if (row.t + MINUTE > clock) seen.violations.push({ sql: sql.slice(0, 120), t: row.t }); }
            if (Number.isFinite(row.qts) && row.qts > clock) seen.violations.push({ sql: sql.slice(0, 120), qts: row.qts });
          }
        }
        return out;
      };
    },
  });
  return new Proxy(db, {
    get(target, prop) {
      if (prop === 'prepare') return (sql) => wrapStmt(sql, target.prepare(sql));
      const v = target[prop];
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
}

test('no look-ahead in the runner: every m1 row it (and the gate/orders it calls) reads is complete at the clock', async () => {
  // TEST FIXTURE: the store already contains a dramatic "future" from 09:48 on.
  const t = setupDb('spy', (db) => jumpTape(db, 'FIXA', { after(d, sym) { flat(d, sym, at(9, 48), at(10, 30), 9000); } }));
  try {
    const r = reset(t.db, { strategies: { [AGENT]: testStrategy() } });
    startAgent(t.db, AGENT, { by: 'test' });
    await step(t.db, { minutes: 17 }); // clock 09:47; the engine's own agent runs happened here
    // Hand-drive the next minute exactly as the engine does, but run the agents through the spy.
    const clock = at(9, 48);
    processMinute(t.db, { session_id: r.session_id, ds: FIXTURE_DS, clock }, clock - MINUTE);
    t.db.prepare('UPDATE replay_state SET clock = ? WHERE id = 1').run(clock);
    const seen = { rows: 0, violations: [] };
    const res = await runAgentsStep(spyDb(t.db, clock, seen), { session_id: r.session_id, ds: FIXTURE_DS, clock });
    assert.equal(res.status, 'OK');
    assert.ok(seen.rows > 5, `the spy observed m1 reads (${seen.rows})`);
    assert.deepEqual(seen.violations, []);
    const entry = ordersOf(t.db, r.session_id, "AND role = 'entry'")[0];
    assert.ok(entry, 'the agent still decided (on knowable data only)');
    assert.equal(entry.qty, 171, 'sized from the 09:47 ask (5810), not the future 9000 tape');
  } finally { t.cleanup(); }
});

test('no look-ahead (differential): decisions up to clock C are identical with and without minutes >= C in the store', async () => {
  const full = setupDb('diff-full', (db) => jumpTape(db, 'FIXA', { after(d, sym) { flat(d, sym, at(9, 48), at(10, 30), 9000); } }));
  const cut = setupDb('diff-cut', (db) => jumpTape(db, 'FIXA', { after() {} }));
  try {
    const seqs = [];
    for (const t of [full, cut]) {
      const r = reset(t.db, { strategies: { [AGENT]: testStrategy() } });
      startAgent(t.db, AGENT, { by: 'test' });
      assert.equal((await step(t.db, { minutes: 18 })).ok, true); // clock 09:48: the agent decides at 09:48
      seqs.push(decisionSequence(t.db, r.session_id));
    }
    assert.ok(seqs[0].some((x) => x.type === 'INTENT_PROPOSED'));
    assert.deepEqual(seqs[0], seqs[1]);
  } finally { full.cleanup(); cut.cleanup(); }
});

test('session close: DAY orders expire, play stops, further steps are refused; agents do not act at the close', async () => {
  const t = setupDb('close', (db) => jumpTape(db, 'FIXA', { after(d, sym) { flat(d, sym, at(9, 48), at(15, 59), 5800); } }));
  try {
    reset(t.db, { strategies: { [AGENT]: testStrategy() } });
    startAgent(t.db, AGENT, { by: 'test' });
    const st0 = getState(t.db);
    const r = await step(t.db, { minutes: 390 });
    assert.equal(r.ok, true);
    assert.equal(r.closed, true);
    assert.equal(r.to, at(16, 0));
    assert.equal(getState(t.db).status, 'SESSION_CLOSED');
    const sid = st0.session_id;
    assert.equal(rowsOfType(t.db, sid, 'REPLAY_SESSION_CLOSED').length, 1);
    const open = ordersOf(t.db, sid, "AND status IN ('pending_parent','working','triggered','partially_filled')");
    assert.equal(open.length, 0, 'no order left open after the close');
    assert.ok(ordersOf(t.db, sid, "AND status = 'expired'").length >= 2, 'the working bracket expired at 16:00');
    assert.equal(rowsOfType(t.db, sid, 'AGENT_SCAN').filter((x) => x.ts_sim >= at(16, 0)).length, 0);
    assert.equal((await step(t.db, { minutes: 1 })).code, 'SESSION_CLOSED');
    assert.equal(play(t.db, {}).code, 'SESSION_CLOSED');
    assert.equal(getAgent(t.db, AGENT).state, 'RUNNING');
  } finally { t.cleanup(); }
});

test('play/pause: a server-side timer advances the persistent clock without any browser; pause stops it', async () => {
  const t = setupDb('play', (db) => jumpTape(db, 'FIXA'));
  try {
    const r = reset(t.db, {});
    assert.equal(play(t.db, { tick_wall_ms: 10 }).code, 'TICK_INVALID');
    const p = play(t.db, { tick_wall_ms: 250 });
    assert.equal(p.ok, true);
    assert.equal(getState(t.db).playing, true);
    assert.equal(t.db.prepare('SELECT playing FROM replay_state').get().playing, 1);
    await sleep(1200);
    const ps = pause(t.db);
    assert.equal(ps.ok, true);
    assert.equal(ps.state.playing, false);
    const advanced = (ps.state.clock - at(9, 30)) / MINUTE;
    assert.ok(advanced >= 2, `clock advanced ${advanced} minutes`);
    await sleep(400);
    assert.equal(getState(t.db).clock, ps.state.clock, 'paused: no further ticks');
    assert.equal(rowsOfType(t.db, r.session_id, 'REPLAY_PLAY').length, 1);
    assert.equal(rowsOfType(t.db, r.session_id, 'REPLAY_PAUSE').length, 1);
  } finally { pause(t.db); t.cleanup(); }
});

test('createLensAssessor: no provider / disconnected provider => MODEL_DISCONNECTED (no fake assessment)', async () => {
  const t = setupDb('assessor', (db) => jumpTape(db, 'FIXA'));
  try {
    assert.equal((await createLensAssessor(t.db, null)('FIXA', 'cowboy', { ds: FIXTURE_DS, clock: at(9, 48) })).status, 'MODEL_DISCONNECTED');
    assert.equal((await createLensAssessor(t.db, { kind: 'none' })('FIXA', 'cowboy', { ds: FIXTURE_DS, clock: at(9, 48) })).status, 'MODEL_DISCONNECTED');
    // TEST FIXTURE provider stub whose endpoint is down.
    const down = { id: 'stub', kind: 'openai-compatible', model: 'stub', status: async () => ({ status: 'DISCONNECTED', detail: 'stub endpoint down' }), complete: async () => { throw new Error('must not be called'); } };
    const r = await createLensAssessor(t.db, down)('FIXA', 'cowboy', { ds: FIXTURE_DS, clock: at(9, 48) });
    assert.equal(r.status, 'MODEL_DISCONNECTED');
    assert.match(r.detail, /DISCONNECTED/);
  } finally { t.cleanup(); }
});

/** TEST FIXTURE provider stub: status() says CONNECTED; complete() returns whatever `next()` says. Not a model. */
function stubProvider(next) {
  const p = {
    id: 'stub-test', kind: 'openai-compatible', model: 'stub (TEST FIXTURE)', statusCalls: 0, completeCalls: 0,
    config: { trainingCutoff: '2020-01-01', trainingCutoffSource: 'TEST FIXTURE' },
    status: async () => { p.statusCalls++; return { status: 'CONNECTED', detail: 'TEST FIXTURE stub' }; },
    complete: async () => { p.completeCalls++; return next(p.completeCalls); },
  };
  return p;
}
const refused = () => ({ ok: false, refusal: null, errorKind: 'NETWORK', error: 'connect ECONNREFUSED 127.0.0.1:9 (TEST FIXTURE)', usage: {}, latencyMs: 1 });

test('createLensAssessor: a call that never reached a model (NETWORK) is MODEL_DISCONNECTED and re-probes status; TIMEOUT re-probes too', async () => {
  const t = setupDb('assessor-net', (db) => jumpTape(db, 'FIXA'));
  try {
    const ctx = { ds: FIXTURE_DS, clock: at(9, 48), session_id: null };
    const p = stubProvider(() => refused());
    const assess = createLensAssessor(t.db, p, { statusTtlMs: 3_600_000 });
    const r1 = await assess('FIXA', 'cowboy', ctx);
    assert.equal(r1.status, 'MODEL_DISCONNECTED');
    assert.match(r1.detail, /NETWORK/);
    assert.equal(p.statusCalls, 1);
    await assess('FIXA', 'cowboy', ctx);
    assert.equal(p.statusCalls, 2, 'the cached CONNECTED status was invalidated by the NETWORK failure');
    const q = stubProvider(() => ({ ok: false, refusal: null, errorKind: 'TIMEOUT', error: 'timed out (TEST FIXTURE)', usage: {}, latencyMs: 1 }));
    const assessT = createLensAssessor(t.db, q, { statusTtlMs: 3_600_000 });
    const r2 = await assessT('FIXA', 'cowboy', ctx);
    assert.equal(r2.status, 'ERROR', 'a timeout reached the endpoint: an unusable assessment, not a disconnect');
    await assessT('FIXA', 'cowboy', ctx);
    assert.equal(q.statusCalls, 2, 'TIMEOUT invalidates the status cache');
  } finally { t.cleanup(); }
});

test('model_confirm agent with an endpoint that refuses connections: BLOCKED MODEL_DISCONNECTED after one attempt (no burnt call budget, no orders)', async () => {
  const t = setupDb('assessor-block', (db) => jumpTape(db, 'FIXA'));
  try {
    const r = reset(t.db, { strategies: { [AGENT]: testStrategy({ decisionMode: 'model_confirm' }) } });
    assert.equal(startAgent(t.db, AGENT, { by: 'test' }).ok, true);
    const p = stubProvider(() => refused());
    const s = await step(t.db, { minutes: 25, assess: createLensAssessor(t.db, p, { statusTtlMs: 3_600_000 }) });
    assert.equal(s.ok, true);
    const a = getAgent(t.db, AGENT);
    assert.equal(a.state, 'BLOCKED');
    assert.equal(a.state_reason, 'MODEL_DISCONNECTED');
    const [blocked] = rowsOfType(t.db, r.session_id, 'AGENT_BLOCKED');
    assert.equal(blocked.ts_sim, at(9, 48));
    assert.match(blocked.payload.detail, /NETWORK/);
    assert.equal(p.completeCalls, 1, 'one connection attempt, then the agent stopped calling');
    assert.equal(t.db.prepare('SELECT COUNT(*) n FROM assessments WHERE session_id = ?').get(r.session_id).n, 1, 'one audit row, not a cap-full of ERROR rows');
    assert.equal(rowsOfType(t.db, r.session_id, 'MODEL_CALL_CAP_REACHED').length, 0);
    assert.equal(rowsOfType(t.db, r.session_id, 'INTENT_PROPOSED').length, 0);
    assert.equal(ordersOf(t.db, r.session_id).length, 0);
  } finally { t.cleanup(); }
});

test('reset journals who asked: human by default, system for the boot-time reset; other actors are refused', () => {
  const t = setupDb('reset-actor', (db) => jumpTape(db, 'FIXA'));
  try {
    const h = reset(t.db, {});
    assert.equal(rowsOfType(t.db, h.session_id, 'REPLAY_RESET')[0].actor, 'human');
    const s = reset(t.db, { actor: 'system' });
    assert.equal(rowsOfType(t.db, s.session_id, 'REPLAY_RESET')[0].actor, 'system');
    const bad = reset(t.db, { actor: 'agent' });
    assert.equal(bad.ok, false);
    assert.equal(bad.code, 'ACTOR_INVALID');
    assert.equal(getState(t.db).session_id, s.session_id, 'a refused reset changes nothing');
  } finally { t.cleanup(); }
});
