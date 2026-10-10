// TEST FIXTURE — NOT MARKET DATA. Human controls over agent authority on synthetic minute rows: global kill switch
// (KEEP_PROTECTIVE / CANCEL_ALL), start refused while engaged, release keeps agents STOPPED, restart pauses RUNNING
// agents, pause keeps protective orders, model_confirm/model decision modes with a disconnected or mocked assessor,
// and fault isolation. Mock assessors here are TEST FIXTURES, not model output.
import test from 'node:test';
import assert from 'node:assert/strict';
import { reset, step, getState, bootRecover } from '../../server/replay/engine.js';
import {
  startAgent, resumeAgent, pauseAgent, engageKill, releaseKill, getAgent, getKillState, pauseAllOnBoot, setAgentStrategy, BOOT_PAUSE_REASON,
} from '../../server/controls.js';
import { runAgentsStep } from '../../server/agents/runner.js';
import { getPosition } from '../../server/sim/ledger.js';
import { DatabaseSync } from 'node:sqlite';
import { PRESETS } from '../../server/agents/strategies.js';
import { agentScanSummary } from '../../server/controls.js';
import {
  at, setupDb, jumpTape, flat, addMinute, testStrategy, rowsOfType, ordersOf, writeJournalSample, FIXTURE_LABEL,
} from './helpers/fixture.js';

const AGENT = 'agent-cowboy-micro';
const PF = 'cowboy-micro';

function scenario(name, tape, strategy = testStrategy(), { start = true } = {}) {
  const t = setupDb(name, tape);
  const r = reset(t.db, { strategies: { [AGENT]: strategy } });
  assert.equal(r.ok, true, JSON.stringify(r));
  if (start) assert.equal(startAgent(t.db, AGENT, { by: 'test' }).ok, true);
  return { ...t, session_id: r.session_id };
}

async function stepN(db, n, extra = {}) {
  const r = await step(db, { minutes: n, ...extra });
  assert.equal(r.ok, true, JSON.stringify(r));
  return r;
}

/** FIXA fills at 09:48; FIXE's entry is withheld every minute (halted rows) so it stays pending. TEST FIXTURE. */
function killTape(db) {
  jumpTape(db, 'FIXA');
  jumpTape(db, 'FIXE', {
    after(d, sym) {
      flat(d, sym, at(9, 48), at(9, 59), 5800, () => ({ halted: true }));
      flat(d, sym, at(10, 0), at(10, 30), 5800);
    },
  });
}

test('global kill switch (KEEP_PROTECTIVE): pending entries cancelled, protective kept, agents STOPPED, start refused while engaged', async () => {
  const t = scenario('kill', killTape);
  try {
    assert.equal(startAgent(t.db, 'agent-tightwad-micro', { by: 'test' }).ok, true, 'a second agent is RUNNING too');
    await stepN(t.db, 19); // clock 09:49: FIXA filled, FIXE withheld (halted)
    assert.equal(getPosition(t.db, t.session_id, PF, 'FIXA').qty, 171);
    const fixeEntry = ordersOf(t.db, t.session_id, "AND sym = 'FIXE' AND role = 'entry'")[0];
    assert.equal(fixeEntry.status, 'working');
    assert.ok(rowsOfType(t.db, t.session_id, 'FILL_WITHHELD').some((r) => r.ref_id === fixeEntry.id && r.payload.reason === 'HALTED'));
    const protective = ordersOf(t.db, t.session_id, "AND sym = 'FIXA' AND protective = 1");
    assert.equal(protective.length, 2);
    assert.ok(protective.every((o) => o.status === 'working'));

    const k = engageKill(t.db, { by: 'test-operator', protective_policy: 'KEEP_PROTECTIVE', reason: 'test' });
    assert.equal(k.ok, true);
    assert.equal(getKillState(t.db).engaged, true);
    assert.equal(getKillState(t.db).protective_policy, 'KEEP_PROTECTIVE');
    const fixe = ordersOf(t.db, t.session_id, "AND sym = 'FIXE'");
    assert.ok(fixe.every((o) => o.status === 'cancelled'), 'pending entry + its pending bracket children cancelled');
    assert.ok(k.cancelled.includes(fixeEntry.id));
    assert.deepEqual(new Set(k.kept), new Set(protective.map((o) => o.id)));
    assert.ok(ordersOf(t.db, t.session_id, "AND sym = 'FIXA' AND protective = 1").every((o) => o.status === 'working'), 'protective orders keep working');
    for (const id of ['agent-cowboy-micro', 'agent-tightwad-micro', 'agent-pragmatist-large']) {
      assert.equal(getAgent(t.db, id).state, 'STOPPED');
      assert.equal(getAgent(t.db, id).state_reason, 'KILL_SWITCH_ENGAGED');
    }
    const refused = startAgent(t.db, AGENT, { by: 'test' });
    assert.equal(refused.ok, false);
    assert.equal(refused.code, 'KILL_SWITCH_ENGAGED');
    assert.equal(resumeAgent(t.db, AGENT, { by: 'test' }).code, 'KILL_SWITCH_ENGAGED');
    assert.equal(rowsOfType(t.db, t.session_id, 'AGENT_CONTROL_REFUSED').length, 2);

    // The clock keeps advancing; protective orders are still evaluated; no agent acts.
    const scansBefore = rowsOfType(t.db, t.session_id, 'AGENT_SCAN').length;
    await stepN(t.db, 2);
    assert.equal(rowsOfType(t.db, t.session_id, 'AGENT_SCAN').length, scansBefore, 'no agent scans while the kill switch is engaged');
    assert.ok(ordersOf(t.db, t.session_id, "AND sym = 'FIXA' AND protective = 1").every((o) => o.status === 'working'));
    // Even a direct runner call with a RUNNING agent row cannot act while engaged.
    const direct = await runAgentsStep(t.db, { session_id: t.session_id, ds: getState(t.db).ds, clock: getState(t.db).clock });
    assert.equal(direct.status, 'KILL_SWITCH_ENGAGED');

    const rel = releaseKill(t.db, { by: 'test-operator' });
    assert.equal(rel.ok, true);
    assert.equal(getKillState(t.db).engaged, false);
    assert.equal(getAgent(t.db, AGENT).state, 'STOPPED', 'release does not resume authority');
    assert.equal(startAgent(t.db, AGENT, { by: 'test' }).ok, true);
    assert.equal(getAgent(t.db, AGENT).state, 'RUNNING');
    const types = rowsOfType(t.db, t.session_id, 'KILL_SWITCH_ENGAGED');
    assert.equal(types.length, 1);
    assert.equal(rowsOfType(t.db, t.session_id, 'KILL_SWITCH_RELEASED').length, 1);
    writeJournalSample(t.db, 'kill-switch', {
      session_id: t.session_id, covers: ['global kill switch', 'KEEP_PROTECTIVE', 'start refused while engaged', 'release keeps agents STOPPED'],
      description: 'Kill switch engaged with KEEP_PROTECTIVE while one entry is filled (stop + take-profit working) and another is pending: the pending entry and its bracket are cancelled, protective orders keep working, every agent is STOPPED, starts are refused while engaged, and after release agents stay STOPPED until started individually.',
    });
  } finally { t.cleanup(); }
});

test('global kill switch (CANCEL_ALL) also cancels protective orders', async () => {
  const t = scenario('killall', killTape);
  try {
    await stepN(t.db, 19);
    const k = engageKill(t.db, { by: 'test-operator', protective_policy: 'CANCEL_ALL' });
    assert.equal(k.ok, true);
    assert.ok(ordersOf(t.db, t.session_id).every((o) => !['working', 'pending_parent', 'triggered', 'partially_filled'].includes(o.status)));
    assert.equal(k.kept.length, 0);
    assert.equal(getPosition(t.db, t.session_id, PF, 'FIXA').qty, 171, 'the position itself is not liquidated by the kill switch');
    assert.equal(engageKill(t.db, { protective_policy: 'NOPE' }).code, 'PROTECTIVE_POLICY_INVALID');
    releaseKill(t.db, { by: 'test' });
  } finally { t.cleanup(); }
});

test('restart: RUNNING agents become PAUSED (authority not implicitly resumed); play flag cleared', async () => {
  const t = scenario('boot', (db) => jumpTape(db, 'FIXA'));
  try {
    assert.equal(startAgent(t.db, 'agent-cowboy-large', { by: 'test' }).ok, true);
    t.db.prepare('UPDATE replay_state SET playing = 1').run(); // as if the process died while playing
    const r = bootRecover(t.db);
    assert.deepEqual(r.pausedAgents.sort(), ['agent-cowboy-large', 'agent-cowboy-micro']);
    for (const id of r.pausedAgents) {
      const a = getAgent(t.db, id);
      assert.equal(a.state, 'PAUSED');
      assert.equal(a.state_reason, BOOT_PAUSE_REASON);
    }
    assert.equal(t.db.prepare('SELECT playing FROM replay_state').get().playing, 0);
    assert.equal(getState(t.db).playing, false);
    assert.equal(rowsOfType(t.db, t.session_id, 'AGENTS_PAUSED_ON_BOOT').length, 1);
    assert.deepEqual(pauseAllOnBoot(t.db).paused, [], 'idempotent');
    // Paused agents do not act.
    await stepN(t.db, 20);
    assert.equal(rowsOfType(t.db, t.session_id, 'INTENT_PROPOSED').length, 0);
  } finally { t.cleanup(); }
});

test('pause stops new entries but keeps protective orders working; pending entries are cancelled', async () => {
  const t = scenario('pause', killTape);
  try {
    await stepN(t.db, 19);
    const p = pauseAgent(t.db, AGENT, { by: 'test' });
    assert.equal(p.ok, true);
    assert.equal(getAgent(t.db, AGENT).state, 'PAUSED');
    assert.ok(ordersOf(t.db, t.session_id, "AND sym = 'FIXE'").every((o) => o.status === 'cancelled'));
    assert.ok(ordersOf(t.db, t.session_id, "AND sym = 'FIXA' AND protective = 1").every((o) => o.status === 'working'));
    const n = rowsOfType(t.db, t.session_id, 'INTENT_PROPOSED').length;
    await stepN(t.db, 3);
    assert.equal(rowsOfType(t.db, t.session_id, 'INTENT_PROPOSED').length, n);
    assert.ok(ordersOf(t.db, t.session_id, "AND sym = 'FIXA' AND protective = 1").every((o) => o.status === 'working'));
  } finally { t.cleanup(); }
});

test('model_confirm with NO assessor: agent BLOCKED (MODEL_DISCONNECTED) and nothing is proposed', async () => {
  const t = scenario('modelnone', (db) => jumpTape(db, 'FIXA'), testStrategy({ decisionMode: 'model_confirm' }));
  try {
    await stepN(t.db, 20);
    const a = getAgent(t.db, AGENT);
    assert.equal(a.state, 'BLOCKED');
    assert.equal(a.state_reason, 'MODEL_DISCONNECTED');
    assert.equal(a.last_fail.code, 'MODEL_DISCONNECTED');
    assert.equal(rowsOfType(t.db, t.session_id, 'AGENT_BLOCKED').length, 1);
    assert.equal(rowsOfType(t.db, t.session_id, 'INTENT_PROPOSED').length, 0);
    assert.equal(ordersOf(t.db, t.session_id).length, 0);
    writeJournalSample(t.db, 'model-disconnected', {
      session_id: t.session_id, covers: ['model_confirm agent with no connected model is BLOCKED (MODEL_DISCONNECTED)'],
      description: 'An agent whose strategy requires model confirmation is started with no model configured: it is set BLOCKED with reason MODEL_DISCONNECTED and proposes nothing.',
    });
  } finally { t.cleanup(); }
});

test('model_confirm with an assessor that reports MODEL_DISCONNECTED: BLOCKED at the first candidate, no orders', async () => {
  const t = scenario('modeldisc', (db) => jumpTape(db, 'FIXA'), testStrategy({ decisionMode: 'model_confirm' }));
  try {
    const calls = [];
    const assess = async (sym, lens) => { calls.push([sym, lens]); return { status: 'MODEL_DISCONNECTED' }; };
    await stepN(t.db, 17, { assess });
    assert.equal(getAgent(t.db, AGENT).state, 'RUNNING', 'no candidate yet, no model call yet');
    await stepN(t.db, 3, { assess });
    assert.deepEqual(calls, [['FIXA', 'cowboy']]);
    assert.equal(getAgent(t.db, AGENT).state, 'BLOCKED');
    assert.equal(getAgent(t.db, AGENT).state_reason, 'MODEL_DISCONNECTED');
    assert.equal(rowsOfType(t.db, t.session_id, 'INTENT_PROPOSED').length, 0);
    assert.equal(ordersOf(t.db, t.session_id).length, 0);
  } finally { t.cleanup(); }
});

test('model_confirm when the hindsight guard refuses the replay date: BLOCKED once with that code, no repeated calls, no orders', async () => {
  const t = scenario('hindsight', (db) => jumpTape(db, 'FIXA'), testStrategy({ decisionMode: 'model_confirm' }));
  try {
    const calls = [];
    const assess = async (sym, lens) => { calls.push([sym, lens]); return { status: 'BLOCKED', code: 'MODEL_TRAINING_CUTOFF_UNKNOWN', detail: 'TEST FIXTURE: training cutoff unknown' }; };
    await stepN(t.db, 25, { assess });
    assert.deepEqual(calls, [['FIXA', 'cowboy']], 'one refused call, then the agent is BLOCKED');
    assert.equal(getAgent(t.db, AGENT).state, 'BLOCKED');
    assert.equal(getAgent(t.db, AGENT).state_reason, 'MODEL_TRAINING_CUTOFF_UNKNOWN');
    assert.equal(rowsOfType(t.db, t.session_id, 'AGENT_BLOCKED').length, 1);
    assert.equal(ordersOf(t.db, t.session_id).length, 0);
  } finally { t.cleanup(); }
});

/** TEST FIXTURE mock lens assessment (not model output). */
function mockAssessment(lens, stance, proposed = null) {
  return {
    status: 'OK', assessment_id: `asmt_test_${stance}`,
    output: {
      lens, stance, thesis: FIXTURE_LABEL, counter_thesis: FIXTURE_LABEL, exposure: FIXTURE_LABEL, liquidity_and_spread: FIXTURE_LABEL,
      unknowns: [FIXTURE_LABEL], evidence_refs: ['ev_test'], confidence: { level: 'low', calibration_note: FIXTURE_LABEL }, proposed_intent: proposed,
    },
  };
}

test('model_confirm with a connected (mock) assessor: consider_entry confirms the rules entry, avoid blocks it', async () => {
  const yes = scenario('confirmyes', (db) => jumpTape(db, 'FIXA'), testStrategy({ decisionMode: 'model_confirm' }));
  try {
    await stepN(yes.db, 18, { assess: async (sym, lens) => mockAssessment(lens, 'consider_entry') });
    const mc = rowsOfType(yes.db, yes.session_id, 'MODEL_CONFIRMATION');
    assert.equal(mc.length, 1);
    assert.equal(mc[0].payload.confirmed, true);
    const [prop] = rowsOfType(yes.db, yes.session_id, 'INTENT_PROPOSED');
    assert.equal(prop.payload.model.stance, 'consider_entry');
    assert.equal(prop.payload.intent.source, 'rules', 'model_confirm: rules propose, the model only confirms');
    assert.equal(rowsOfType(yes.db, yes.session_id, 'ORDER_SUBMITTED').length, 3);
  } finally { yes.cleanup(); }
  const no = scenario('confirmno', (db) => jumpTape(db, 'FIXA'), testStrategy({ decisionMode: 'model_confirm' }));
  try {
    await stepN(no.db, 18, { assess: async (sym, lens) => mockAssessment(lens, 'avoid') });
    assert.equal(rowsOfType(no.db, no.session_id, 'MODEL_CONFIRMATION')[0].payload.confirmed, false);
    assert.equal(rowsOfType(no.db, no.session_id, 'INTENT_PROPOSED').length, 0);
    assert.equal(ordersOf(no.db, no.session_id).length, 0);
    assert.equal(getAgent(no.db, AGENT).state, 'RUNNING');
  } finally { no.cleanup(); }
});

/** TEST FIXTURE evidence row (the evidence store is where model evidence refs must resolve). Not market data. */
function seedEvidence(db, id, knowable_ts, sym = 'FIXA') {
  db.prepare(`INSERT INTO evidence (id, sym, kind, title, body_json, provider, ds, source_url, source_id, event_ts, knowable_ts, ingested_ts, created_wall)
    VALUES (?, ?, 'test_fixture', ?, ?, ?, NULL, NULL, NULL, ?, ?, ?, ?)`).run(id, sym, FIXTURE_LABEL, JSON.stringify({ label: FIXTURE_LABEL }), FIXTURE_LABEL,
    knowable_ts, knowable_ts, Date.now(), Date.now());
}

/** TEST FIXTURE model proposal (USD). */
function proposal(over = {}) {
  return {
    action: 'open', side: 'buy', order_type: 'limit', budget_usd: 50, qty: null, limit_px_usd: 0.59, stop_px_usd: null,
    stop_loss_px_usd: 0.52, take_profit_px_usd: 0.7, time_exit_min: null, expires_in_min: 5, rationale: FIXTURE_LABEL, evidence_refs: ['ev_test'], ...over,
  };
}

test('model mode: a (mock) lens proposed_intent becomes a model-sourced TradeIntent, clamped to the strategy envelope, that still passes the gate', async () => {
  const t = scenario('modelmode', (db) => { jumpTape(db, 'FIXA'); seedEvidence(db, 'ev_test', at(9, 40)); }, testStrategy({ decisionMode: 'model' }));
  try {
    // TEST FIXTURE proposal: limit 0.59, stop 0.52 (looser than the strategy's 10% stop at 0.5229), take-profit 0.70, $50 budget.
    await stepN(t.db, 18, { assess: async (sym, lens) => mockAssessment(lens, 'consider_entry', proposal()) });
    const [prop] = rowsOfType(t.db, t.session_id, 'INTENT_PROPOSED');
    assert.equal(prop.payload.intent.source, 'model');
    assert.equal(prop.payload.intent.agent_id, AGENT);
    assert.equal(prop.payload.intent.limit_px_u, 5900);
    assert.deepEqual(prop.payload.intent.attach, { stop_loss_px_u: 5229, take_profit_px_u: 7000 }, 'the model may tighten the stop, never loosen it');
    assert.ok(prop.payload.detail.envelope.clamped.some((c) => /looser than the strategy stop/.test(c)));
    const [accept] = rowsOfType(t.db, t.session_id, 'POLICY_ACCEPT');
    assert.ok(accept);
    assert.match(accept.payload.checks.find((c) => c.rule === 'evidence_not_future').detail, /1\/1 evidence refs resolved/);
    const entry = ordersOf(t.db, t.session_id, "AND role = 'entry'")[0];
    assert.equal(entry.qty, Math.floor(500_000 / 5900), 'qty sized from min(model budget, strategy budget)');
    assert.equal(entry.limit_px, 5900);
  } finally { t.cleanup(); }
});

test('model mode envelope: budget above the strategy, no stop-loss, only a time exit => clamped to the strategy budget with a protective stop below the bid', async () => {
  const t = scenario('modelenv', (db) => { jumpTape(db, 'FIXA'); seedEvidence(db, 'ev_test', at(9, 40)); }, testStrategy({ decisionMode: 'model' }));
  try {
    const p = proposal({ order_type: 'market', limit_px_usd: null, budget_usd: 900, stop_loss_px_usd: null, take_profit_px_usd: null, time_exit_min: 3 });
    await stepN(t.db, 19, { assess: async (sym, lens) => mockAssessment(lens, 'consider_entry', p) });
    const [prop] = rowsOfType(t.db, t.session_id, 'INTENT_PROPOSED');
    const it = prop.payload.intent;
    assert.equal(it.budget_usd, 100, 'strategy budget $100, not the model $900');
    assert.equal(it.attach.stop_loss_px_u, 5229, 'strategy stop attached');
    assert.ok(it.attach.stop_loss_px_u < prop.payload.signal.quote.bid);
    assert.equal(it.attach.take_profit_px_u, 8134, 'strategy take-profit when the model gives none');
    assert.equal(it.attach.time_exit_min, 3);
    const [accept] = rowsOfType(t.db, t.session_id, 'POLICY_ACCEPT');
    assert.ok(accept.payload.estimate.costU <= 1_000_000, `estimated cost ${accept.payload.estimate.costU} u <= $100`);
    const stop = ordersOf(t.db, t.session_id, "AND role = 'stop_loss'")[0];
    assert.equal(stop.stop_px, 5229);
    assert.equal(stop.status, 'working', 'entry filled; the protective stop is working');

    // A model stop at/above the bid is replaced; a stop entry type is outside the envelope.
    const bad = scenario('modelenv2', (db) => { jumpTape(db, 'FIXA'); seedEvidence(db, 'ev_test', at(9, 40)); }, testStrategy({ decisionMode: 'model' }));
    try {
      await stepN(bad.db, 18, { assess: async (sym, lens) => mockAssessment(lens, 'consider_entry', proposal({ order_type: 'stop', stop_px_usd: 0.6, limit_px_usd: null })) });
      const mc = rowsOfType(bad.db, bad.session_id, 'MODEL_CONFIRMATION')[0];
      assert.equal(mc.payload.confirmed, false);
      assert.match(mc.payload.note, /outside the strategy envelope/);
      assert.equal(ordersOf(bad.db, bad.session_id).length, 0);
      assert.equal(getAgent(bad.db, AGENT).last_fail.code, 'MODEL_PROPOSAL_INVALID', 'an invalid model proposal is recorded as the last failure');
    } finally { bad.cleanup(); }
  } finally { t.cleanup(); }
});

test('model mode envelope: a passive limit below the ask takes the strategy exits from the limit, so the stop stays below the entry limit', async () => {
  // TEST FIXTURE: at 09:48 the IEX ask is 0.5810 / bid 0.5790. The model proposes a limit at 0.45 with a stop at 0.40.
  const t = scenario('modellimit', (db) => { jumpTape(db, 'FIXA'); seedEvidence(db, 'ev_test', at(9, 40)); }, testStrategy({ decisionMode: 'model' }));
  try {
    await stepN(t.db, 18, { assess: async (sym, lens) => mockAssessment(lens, 'consider_entry', proposal({ limit_px_usd: 0.45, stop_loss_px_usd: 0.4 })) });
    const [prop] = rowsOfType(t.db, t.session_id, 'INTENT_PROPOSED');
    const it = prop.payload.intent;
    assert.equal(it.limit_px_u, 4500);
    assert.equal(prop.payload.detail.envelope.entryRefU, 4500, 'entry reference = the limit, not the 0.5810 ask');
    assert.equal(it.attach.stop_loss_px_u, 4050, 'strategy 10% stop from the limit (looser model stop 0.40 replaced)');
    assert.ok(it.attach.stop_loss_px_u < it.limit_px_u);
    const [accept] = rowsOfType(t.db, t.session_id, 'POLICY_ACCEPT');
    assert.match(accept.payload.checks.find((c) => c.rule === 'protective_exit_required').detail, /< entry limit \$0\.4500/);
  } finally { t.cleanup(); }
  // A model stop between the limit and the bid is never kept: it would be marketable as soon as the limit fills.
  const mid = scenario('modellimit2', (db) => { jumpTape(db, 'FIXA'); seedEvidence(db, 'ev_test', at(9, 40)); }, testStrategy({ decisionMode: 'model' }));
  try {
    await stepN(mid.db, 18, { assess: async (sym, lens) => mockAssessment(lens, 'consider_entry', proposal({ limit_px_usd: 0.45, stop_loss_px_usd: 0.5 })) });
    const [prop] = rowsOfType(mid.db, mid.session_id, 'INTENT_PROPOSED');
    assert.equal(prop.payload.intent.attach.stop_loss_px_u, 4050);
    assert.ok(prop.payload.detail.envelope.clamped.some((c) => /at\/above the entry limit/.test(c)));
  } finally { mid.cleanup(); }
});

test('model mode evidence: unknown evidence ids are rejected before gating; refs knowable after the clock are denied by the gate', async () => {
  const unknown = scenario('evunknown', (db) => jumpTape(db, 'FIXA'), testStrategy({ decisionMode: 'model' }));
  try {
    await stepN(unknown.db, 18, { assess: async (sym, lens) => mockAssessment(lens, 'consider_entry', proposal({ evidence_refs: ['ev_not_in_store'] })) });
    const mc = rowsOfType(unknown.db, unknown.session_id, 'MODEL_CONFIRMATION')[0];
    assert.equal(mc.payload.confirmed, false);
    assert.match(mc.payload.note, /do not resolve to stored evidence or a stored IEX minute/);
    assert.equal(rowsOfType(unknown.db, unknown.session_id, 'INTENT_PROPOSED').length, 0);
    assert.equal(getAgent(unknown.db, AGENT).last_fail.code, 'MODEL_EVIDENCE_UNRESOLVED');
  } finally { unknown.cleanup(); }
  const future = scenario('evfuture', (db) => { jumpTape(db, 'FIXA'); seedEvidence(db, 'ev_future', at(9, 48) + 1); }, testStrategy({ decisionMode: 'model' }));
  try {
    await stepN(future.db, 18, { assess: async (sym, lens) => mockAssessment(lens, 'consider_entry', proposal({ evidence_refs: ['ev_future'] })) });
    const [deny] = rowsOfType(future.db, future.session_id, 'POLICY_DENY');
    assert.ok(deny, 'denied by the gate');
    assert.ok(deny.payload.reasons.some((r) => r.code === 'EVIDENCE_FROM_FUTURE'), JSON.stringify(deny.payload.reasons));
    assert.equal(ordersOf(future.db, future.session_id).length, 0);
  } finally { future.cleanup(); }
});

test('an exception in one agent FAULTs only that agent; the step and other agents continue', async () => {
  const t = scenario('fault', (db) => jumpTape(db, 'FIXA'));
  try {
    assert.equal(startAgent(t.db, 'agent-pragmatist-micro', { by: 'test' }).ok, true);
    t.db.prepare("UPDATE agents SET strategy_json = '{not json' WHERE id = 'agent-pragmatist-micro'").run();
    const r = await step(t.db, { minutes: 18 });
    assert.equal(r.ok, true);
    assert.equal(r.faults, 1);
    const bad = getAgent(t.db, 'agent-pragmatist-micro');
    assert.equal(bad.state, 'FAULTED');
    assert.match(bad.state_reason, /STRATEGY_UNPARSEABLE/);
    assert.equal(rowsOfType(t.db, t.session_id, 'AGENT_FAULT').length, 1);
    assert.equal(getAgent(t.db, AGENT).state, 'RUNNING');
    assert.equal(rowsOfType(t.db, t.session_id, 'ORDER_SUBMITTED').length, 3, 'the healthy agent still traded');
  } finally { t.cleanup(); }
});

test('setAgentStrategy validates (stop-loss required, segment must match) and journals STRATEGY_CHANGED', () => {
  const t = scenario('strategy', (db) => jumpTape(db, 'FIXA'), testStrategy(), { start: false });
  try {
    const noStop = { ...testStrategy(), exits: { ...testStrategy().exits, stopLoss: null } };
    assert.equal(setAgentStrategy(t.db, AGENT, noStop).code, 'STRATEGY_INVALID');
    const large = testStrategy({ segment: 'large' });
    assert.equal(setAgentStrategy(t.db, AGENT, large).code, 'STRATEGY_SEGMENT_MISMATCH');
    const ok = setAgentStrategy(t.db, AGENT, testStrategy({ id: 'test:changed' }), { by: 'test' });
    assert.equal(ok.ok, true);
    assert.equal(getAgent(t.db, AGENT).strategy.id, 'test:changed');
    assert.equal(getAgent(t.db, AGENT).strategy.label, 'EXPLORATORY DEFAULTS — NOT VALIDATED');
    assert.equal(rowsOfType(t.db, t.session_id, 'STRATEGY_CHANGED').length, 1);
    assert.equal(startAgent(t.db, 'agent-nope').code, 'AGENT_NOT_FOUND');
  } finally { t.cleanup(); }
});


// ---- paused-state / authority regressions (TEST FIXTURE tapes) ------------------------------------------------------

/**
 * TEST FIXTURE: standard jump at 09:47, then the ask runs above a 5810 limit (no fill) until 09:59 and comes back to
 * 5800 from 10:00 (a still-working 5810 buy limit would fill then).
 */
function runawayTape(db, sym) {
  jumpTape(db, sym, {
    after(d, s) {
      addMinute(d, s, at(9, 48), { trades: { o: 6200, h: 6250, l: 6150, c: 6200, v: 800, n: 4 }, bid: 6190, ask: 6210,
        minBid: 5790, maxBid: 6190, minAsk: 5810, maxAsk: 6210 });
      flat(d, s, at(9, 49), at(9, 59), 6200);
      flat(d, s, at(10, 0), at(10, 30), 5800);
    },
  });
}

/** TEST FIXTURE: flat 0.5000 until 09:49, a jump to 0.5800 in the 09:50 minute (knowable 09:51), flat after. */
function lateJumpTape(db, sym) {
  flat(db, sym, at(9, 30), at(9, 49), 5000, () => ({ bv: 300, sv: 300 }));
  addMinute(db, sym, at(9, 50), { trades: { o: 5000, h: 5800, l: 5000, c: 5800, v: 5000, n: 20 }, bid: 5790, ask: 5810,
    minBid: 4990, maxBid: 5790, minAsk: 5010, maxAsk: 5810, bv: 3000, sv: 500 });
  flat(db, sym, at(9, 51), at(10, 30), 5800);
}

const limitStrategy = (over = {}) => testStrategy({ entry: { orderType: 'limit', limitOffsetBps: 0 }, ...over });
const buyFills = (db, sid, sym) => rowsOfType(db, sid, 'FILL_ESTIMATED').filter((r) => r.payload.sym === sym && r.payload.side === 'buy');

test('control: without supervision changes the runaway limit entry would fill at 10:00 (TEST FIXTURE baseline)', async () => {
  const t = scenario('runaway-control', (db) => runawayTape(db, 'FIXC'), limitStrategy({ management: { cancelEntryAfterMin: null } }));
  try {
    await stepN(t.db, 40); // clock 10:10
    assert.equal(buyFills(t.db, t.session_id, 'FIXC').length, 1, 'the resting 5810 limit fills once the ask returns');
  } finally { t.cleanup(); }
});

test('restart: pending entries of RUNNING agents are cancelled on boot (no fill without a supervising agent); protective orders keep working', async () => {
  const t = scenario('bootcancel', killTape);
  try {
    await stepN(t.db, 19); // clock 09:49: FIXA filled with stop + TP working; FIXE entry held pending (halted rows)
    const fixeEntry = ordersOf(t.db, t.session_id, "AND sym = 'FIXE' AND role = 'entry'")[0];
    assert.equal(fixeEntry.status, 'working');
    assert.equal(ordersOf(t.db, t.session_id, "AND sym = 'FIXA' AND protective = 1 AND status = 'working'").length, 2);
    const r = bootRecover(t.db);
    assert.deepEqual(r.pausedAgents, [AGENT]);
    assert.ok(r.cancelledPendingEntries[AGENT].includes(fixeEntry.id));
    assert.ok(ordersOf(t.db, t.session_id, "AND sym = 'FIXE'").every((o) => o.status === 'cancelled'), 'entry + pending bracket cancelled');
    const canc = rowsOfType(t.db, t.session_id, 'ORDER_CANCELLED').find((x) => x.ref_id === fixeEntry.id);
    assert.equal(canc.actor, 'system');
    assert.equal(canc.payload.reason, 'AGENTS_PAUSED_ON_BOOT');
    assert.ok(ordersOf(t.db, t.session_id, "AND sym = 'FIXA' AND protective = 1").every((o) => o.status === 'working'), 'protective orders keep working');
    const boot = rowsOfType(t.db, t.session_id, 'AGENTS_PAUSED_ON_BOOT')[0];
    assert.ok(boot.payload.cancelledPendingEntries[AGENT].includes(fixeEntry.id));
    await stepN(t.db, 20); // past 10:00, when FIXE becomes fillable
    assert.equal(getPosition(t.db, t.session_id, PF, 'FIXE'), null, 'no FIXE fill');
    assert.equal(getAgent(t.db, AGENT).state, 'PAUSED');
    assert.deepEqual(bootRecover(t.db).pausedAgents, [], 'idempotent');
    writeJournalSample(t.db, 'boot-pause-cancels-entries', {
      session_id: t.session_id, covers: ['restart: RUNNING agents PAUSED', 'pending entries cancelled on boot (actor system)', 'protective orders keep working'],
      description: 'A simulated restart while one position is protected (stop + take-profit working) and another entry is still pending: the agent is PAUSED, its pending entry and bracket are cancelled by the system (AGENTS_PAUSED_ON_BOOT), protective orders keep working, and the entry never fills later.',
    });
  } finally { t.cleanup(); }
});

test('model_confirm: a model outage BLOCKS the agent and cancels its pending entry, which then never fills', async () => {
  const t = scenario('blockcancel', (db) => runawayTape(db, 'FIXC'), limitStrategy({ decisionMode: 'model_confirm' }));
  try {
    await stepN(t.db, 18, { assess: async (sym, lens) => mockAssessment(lens, 'consider_entry') }); // 09:48: limit entry confirmed
    const entry = ordersOf(t.db, t.session_id, "AND role = 'entry'")[0];
    assert.equal(entry.status, 'working');
    await stepN(t.db, 1, { assess: async (sym, lens) => mockAssessment(lens, 'consider_entry'), model: { status: 'DISCONNECTED' } }); // 09:49
    const a = getAgent(t.db, AGENT);
    assert.equal(a.state, 'BLOCKED');
    assert.equal(a.state_reason, 'MODEL_DISCONNECTED');
    assert.ok(ordersOf(t.db, t.session_id).every((o) => o.status === 'cancelled'), 'entry + pending bracket cancelled');
    const canc = rowsOfType(t.db, t.session_id, 'ORDER_CANCELLED').find((x) => x.ref_id === entry.id);
    assert.equal(canc.actor, 'system');
    assert.equal(canc.payload.reason, 'AGENT_BLOCKED:MODEL_DISCONNECTED');
    const [blocked] = rowsOfType(t.db, t.session_id, 'AGENT_BLOCKED');
    assert.ok(blocked.payload.cancelledPendingEntries.includes(entry.id));
    await stepN(t.db, 21); // 10:10
    assert.equal(buyFills(t.db, t.session_id, 'FIXC').length, 0, 'no unsupervised fill when the price returns');
  } finally { t.cleanup(); }
});

test('model_confirm: when the assessor reports MODEL_DISCONNECTED mid-step, rule-based management still runs before BLOCKED', async () => {
  const t = scenario('blockmgmt', (db) => { runawayTape(db, 'FIXA'); lateJumpTape(db, 'FIXB'); }, limitStrategy({ decisionMode: 'model_confirm' }));
  try {
    const calls = [];
    const assess = async (sym, lens) => { calls.push(sym); return calls.length === 1 ? mockAssessment(lens, 'consider_entry') : { status: 'MODEL_DISCONNECTED', detail: 'test fixture outage' }; };
    await stepN(t.db, 21, { assess }); // 09:48 FIXA limit entry; 09:51 plan = [cancel_stale_entry FIXA, entry FIXB]
    assert.deepEqual(calls, ['FIXA', 'FIXB']);
    const fixa = ordersOf(t.db, t.session_id, "AND sym = 'FIXA' AND role = 'entry'")[0];
    assert.equal(fixa.status, 'cancelled');
    const canc = rowsOfType(t.db, t.session_id, 'ORDER_CANCELLED').find((x) => x.ref_id === fixa.id);
    assert.equal(canc.actor, 'agent', 'the stale-entry cancel was proposed and gated while the model was down');
    assert.equal(ordersOf(t.db, t.session_id, "AND sym = 'FIXB'").length, 0, 'no entry without the model');
    assert.equal(getAgent(t.db, AGENT).state, 'BLOCKED');
    const [blocked] = rowsOfType(t.db, t.session_id, 'AGENT_BLOCKED');
    assert.deepEqual(blocked.payload.managementActions.map((x) => [x.kind, x.sym, x.decision]), [['cancel_stale_entry', 'FIXA', 'ACCEPTED']]);
  } finally { t.cleanup(); }
});

test('FAULTED agent: its pending entry is cancelled (actor system), so it never fills unsupervised', async () => {
  const t = scenario('faultcancel', (db) => runawayTape(db, 'FIXC'), limitStrategy());
  try {
    await stepN(t.db, 18);
    const entry = ordersOf(t.db, t.session_id, "AND role = 'entry'")[0];
    assert.equal(entry.status, 'working');
    t.db.prepare("UPDATE agents SET strategy_json = '{not json' WHERE id = ?").run(AGENT);
    const r = await step(t.db, { minutes: 1 });
    assert.equal(r.faults, 1);
    assert.equal(getAgent(t.db, AGENT).state, 'FAULTED');
    const canc = rowsOfType(t.db, t.session_id, 'ORDER_CANCELLED').find((x) => x.ref_id === entry.id);
    assert.equal(canc.actor, 'system');
    assert.equal(canc.payload.reason, 'AGENT_FAULTED');
    assert.ok(rowsOfType(t.db, t.session_id, 'AGENT_FAULT')[0].payload.cancelledPendingEntries.includes(entry.id));
    await stepN(t.db, 21);
    assert.equal(buyFills(t.db, t.session_id, 'FIXC').length, 0);
  } finally { t.cleanup(); }
});

/** TEST FIXTURE: four symbols jumping at 09:47 => four entry candidates at 09:48. */
const fourJumps = (db) => { for (const s of ['FIXA', 'FIXB', 'FIXC', 'FIXD']) jumpTape(db, s); };
const fourCandidates = (mode) => testStrategy({ decisionMode: mode, management: { maxCandidatesPerStep: 4, maxModelCallsPerStep: 4, maxOrdersPerStep: 12 } });

test('kill switch engaged during a model call: remaining model calls are not made and the result is discarded', async () => {
  const t = scenario('killmodel', fourJumps, fourCandidates('model_confirm'));
  try {
    const calls = [];
    const assess = async (sym, lens) => { calls.push(sym); if (calls.length === 1) engageKill(t.db, { by: 'test-operator' }); return mockAssessment(lens, 'consider_entry'); };
    const r = await stepN(t.db, 18, { assess });
    assert.equal(calls.length, 1, 'no model calls after the kill');
    const killSeq = t.db.prepare("SELECT seq FROM journal WHERE type = 'KILL_SWITCH_ENGAGED'").get().seq;
    const after = t.db.prepare("SELECT payload_json FROM journal WHERE type = 'MODEL_CONFIRMATION' AND seq > ?").all(killSeq).map((x) => JSON.parse(x.payload_json));
    assert.ok(after.every((p) => p.confirmed === false));
    assert.ok(after.some((p) => p.discarded === true));
    const notRun = after.find((p) => p.status === 'NOT_RUN_KILL_SWITCH');
    assert.equal(notRun.remaining, 3);
    assert.equal(rowsOfType(t.db, t.session_id, 'INTENT_PROPOSED').length, 0);
    assert.equal(ordersOf(t.db, t.session_id).length, 0);
    assert.equal(r.ok, true);
    assert.equal(reset(t.db, {}).ok, true, 'the step is not left busy');
  } finally { releaseKill(t.db, { by: 'test' }); t.cleanup(); }
});

test('agent paused during a model call: remaining calls are not made and nothing is proposed', async () => {
  const t = scenario('pausemodel', fourJumps, fourCandidates('model_confirm'));
  try {
    const calls = [];
    const assess = async (sym, lens) => { calls.push(sym); if (calls.length === 1) pauseAgent(t.db, AGENT, { by: 'test' }); return mockAssessment(lens, 'consider_entry'); };
    await stepN(t.db, 18, { assess });
    assert.equal(calls.length, 1);
    assert.ok(rowsOfType(t.db, t.session_id, 'MODEL_CONFIRMATION').some((x) => x.payload.status === 'NOT_RUN_AGENT_NOT_RUNNING' && x.payload.remaining === 3));
    assert.equal(rowsOfType(t.db, t.session_id, 'INTENT_PROPOSED').length, 0);
    assert.equal(getAgent(t.db, AGENT).state, 'PAUSED');
  } finally { t.cleanup(); }
});

test('time exits are agent-monitored rules: pause journals TIME_EXIT_SUSPENDED, nothing fires while paused, a missed deadline is evaluated after resume', async () => {
  const strategy = testStrategy({ exits: { timeExit: { minutes: 3, bandPct: null } } });
  const t = scenario('tesuspend', (db) => jumpTape(db, 'FIXT'), strategy);
  try {
    await stepN(t.db, 20); // 09:50: filled in the 09:48 minute; deadline 09:52
    assert.equal(pauseAgent(t.db, AGENT, { by: 'test' }).ok, true);
    assert.match(getAgent(t.db, AGENT).state_reason, /time exits are suspended/);
    const [sus] = rowsOfType(t.db, t.session_id, 'TIME_EXIT_SUSPENDED');
    assert.equal(sus.payload.to, 'PAUSED');
    assert.deepEqual(sus.payload.positions.map((p) => [p.sym, p.deadline, p.minutes]), [['FIXT', at(9, 52), 3]]);
    await stepN(t.db, 5); // 09:55, past the deadline
    assert.equal(ordersOf(t.db, t.session_id, "AND role = 'time_exit'").length, 0, 'not evaluated while paused');
    assert.equal(resumeAgent(t.db, AGENT, { by: 'test' }).ok, true);
    await stepN(t.db, 1); // 09:56
    const te = rowsOfType(t.db, t.session_id, 'INTENT_PROPOSED').find((p) => p.payload.kind === 'time_exit');
    assert.ok(te, 'missed deadline evaluated at the first step after resume');
    assert.equal(te.payload.detail.lateByMin, 4);
    writeJournalSample(t.db, 'time-exit-suspended', {
      session_id: t.session_id, covers: ['paused-state policy for time exits (suspended, journaled)', 'late time exit after resume'],
      description: 'A position with a 3-minute unconditional time exit: the agent is paused before the deadline (TIME_EXIT_SUSPENDED is journaled; stop/take-profit keep working), nothing fires while paused, and after the human resumes it the missed deadline is evaluated at the first step (lateByMin 4).',
    });
  } finally { t.cleanup(); }
});

test('kill switch (KEEP_PROTECTIVE) journals the suspended time-exit rules of RUNNING agents', async () => {
  const t = scenario('tekill', (db) => jumpTape(db, 'FIXT'), testStrategy({ exits: { timeExit: { minutes: 3, bandPct: 5 } } }));
  try {
    await stepN(t.db, 20);
    const k = engageKill(t.db, { by: 'test-operator', protective_policy: 'KEEP_PROTECTIVE' });
    assert.equal(k.ok, true);
    const [sus] = rowsOfType(t.db, t.session_id, 'TIME_EXIT_SUSPENDED');
    assert.equal(sus.payload.to, 'STOPPED');
    assert.equal(sus.payload.protective_policy, 'KEEP_PROTECTIVE');
    assert.deepEqual(rowsOfType(t.db, t.session_id, 'KILL_SWITCH_EFFECTS')[0].payload.timeExitsSuspended, { [AGENT]: ['FIXT'] });
    assert.match(rowsOfType(t.db, t.session_id, 'KILL_SWITCH_ENGAGED')[0].payload.effects, /time-exit RULES are agent-monitored/);
  } finally { releaseKill(t.db, { by: 'test' }); t.cleanup(); }
});

test('strategy PUT is strict: unknown fields at any level are rejected and nothing is stored or journaled; every preset round-trips', () => {
  const t = scenario('strictput', (db) => jumpTape(db, 'FIXA'), testStrategy(), { start: false });
  try {
    const before = getAgent(t.db, AGENT).strategy;
    const base = testStrategy({ id: 'test:typo' });
    const typo = { ...base, exits: { ...base.exits, timeexit: { minutes: 5 } }, entry: { ...base.entry, maxSpreadBP: 50 }, junk: 'x'.repeat(50_000) };
    const r = setAgentStrategy(t.db, AGENT, typo, { by: 'test' });
    assert.equal(r.code, 'STRATEGY_INVALID');
    for (const f of ['unknown field: exits.timeexit', 'unknown field: entry.maxSpreadBP', 'unknown field: junk']) assert.ok(r.errors.includes(f), f);
    assert.deepEqual(getAgent(t.db, AGENT).strategy, before, 'stored strategy unchanged');
    assert.equal(rowsOfType(t.db, t.session_id, 'STRATEGY_CHANGED').length, 0, 'no journal row for a rejected PUT');
    for (const [key, p] of Object.entries(PRESETS)) {
      const id = p.segment === 'large' ? 'agent-cowboy-large' : AGENT;
      assert.equal(setAgentStrategy(t.db, id, structuredClone(p), { by: 'test' }).ok, true, key);
      const stored = getAgent(t.db, id).strategy;
      assert.equal(setAgentStrategy(t.db, id, structuredClone(stored), { by: 'test' }).ok, true, `${key} round-trips (UI edit form sends the stored object back)`);
    }
  } finally { t.cleanup(); }
});

test('scan summary: cumulative skip reasons and near misses explain why there were no trades; incremental = fresh recompute', async () => {
  const t = scenario('scansummary', (db) => { jumpTape(db, 'FIXA'); jumpTape(db, 'FIXB', { base: 4000, jump: 4400 }); }, testStrategy({ entry: { minRetPct: 50 } }));
  try {
    await stepN(t.db, 10);
    assert.equal(agentScanSummary(t.db, AGENT).scans, 10);
    await stepN(t.db, 15);
    const s = getAgent(t.db, AGENT).scan_summary;
    assert.equal(s.session_id, t.session_id);
    assert.equal(s.scans, 25);
    assert.equal(s.entriesPlanned, 0);
    assert.equal(s.intentsProposed, 0);
    assert.ok(s.skipped.RET_BELOW_MIN > 0);
    assert.ok(s.nearMisses.RET_BELOW_MIN > 0, 'the 16% / 10% moves fail only the +50% return rule');
    assert.match(s.note, /nearMisses/);
    const scans = rowsOfType(t.db, t.session_id, 'AGENT_SCAN').filter((r) => r.agent_id === AGENT);
    const total = scans.reduce((n, r) => n + (r.payload.skipped.RET_BELOW_MIN ?? 0), 0);
    assert.equal(s.skipped.RET_BELOW_MIN, total);
    const fresh = new DatabaseSync(t.path, { readOnly: true }); // different handle => no cached state
    try { assert.deepEqual(agentScanSummary(fresh, AGENT, t.session_id), s); } finally { fresh.close(); }
    assert.equal(agentScanSummary(t.db, 'agent-tightwad-large').scans, 0, 'an agent that never ran has an empty summary');
  } finally { t.cleanup(); }
});
