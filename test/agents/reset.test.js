// TEST FIXTURE — NOT MARKET DATA. Replay reset semantics on synthetic minute rows: strategy edits are kept by default
// (restorePresets reverts them; an explicit strategies map is a complete specification), per-agent STRATEGY_CHANGED /
// AGENT_STATE_CHANGED rows where a reset changes something, agents stay STOPPED across a reset while the kill switch
// is engaged, partial datasets end the replay at their coverage end (DATASET_INCOMPLETE when it is at/before the
// open), and the model assessor resolves its provider on every call. Provider stubs here are TEST FIXTURES, not models.
import test from 'node:test';
import assert from 'node:assert/strict';
import { reset, step, play, getState, RESET_KILL_REASON, RESET_PAUSED_REASON } from '../../server/replay/engine.js';
import {
  startAgent, resumeAgent, getAgent, listAgents, setAgentStrategy, engageKill, releaseKill, getKillState, KILL_KEY,
} from '../../server/controls.js';
import { createLensAssessor } from '../../server/agents/runner.js';
import { submitOrder, getOrder } from '../../server/sim/orders.js';
import { PRESETS, validateStrategy } from '../../server/agents/strategies.js';
import { etToUtc } from '../../server/util/time.js';
import {
  at, MINUTE, setupDb, seedFixtureDataset, markPartial, jumpTape, testStrategy, rowsOfType, FIXTURE_DS, FIXTURE_LABEL,
} from './helpers/fixture.js';

const AGENT = 'agent-cowboy-micro';
const TW = 'agent-tightwad-micro';
const preset = (pid) => validateStrategy(PRESETS[pid]).strategy;
const pick = (o, keys) => Object.fromEntries(keys.map((k) => [k, o[k]]));

/** A user edit of the tightwad-micro preset (TEST FIXTURE threshold). */
function editedTightwad() {
  const s = structuredClone(preset('tightwad-micro'));
  s.id = 'test:tightwad-micro-edited';
  s.entry.maxSpreadBps = 3000;
  return s;
}

test('reset keeps strategy edits by default; restorePresets reverts them; per-agent STRATEGY_CHANGED / AGENT_STATE_CHANGED only where they change', () => {
  const t = setupDb('reset-keep', (db) => jumpTape(db, 'FIXA'));
  try {
    const r1 = reset(t.db, {});
    assert.equal(r1.ok, true);
    assert.equal(r1.strategies.length, 6);
    assert.ok(r1.strategies.every((x) => x.strategy_source === 'preset' && x.matchesPreset && x.note === 'no existing agent (first session)'));
    assert.equal(rowsOfType(t.db, r1.session_id, 'STRATEGY_CHANGED').length, 0, 'first session: agents are created, nothing changed');
    assert.equal(rowsOfType(t.db, r1.session_id, 'AGENT_STATE_CHANGED').length, 0);

    const edited = editedTightwad();
    assert.equal(setAgentStrategy(t.db, TW, edited, { by: 'test' }).ok, true);
    assert.equal(startAgent(t.db, AGENT, { by: 'test' }).ok, true);

    // Default: the edit survives the reset; the RUNNING agent is PAUSED and that change is journaled.
    const r2 = reset(t.db, {});
    assert.equal(r2.ok, true);
    assert.equal(getAgent(t.db, TW).strategy.id, edited.id);
    assert.equal(getAgent(t.db, TW).strategy.entry.maxSpreadBps, 3000);
    assert.deepEqual(pick(r2.strategies.find((x) => x.agent_id === TW), ['strategy_source', 'matchesPreset', 'strategyChanged', 'state', 'previousState']),
      { strategy_source: 'carried', matchesPreset: false, strategyChanged: false, state: 'PAUSED', previousState: 'PAUSED' });
    assert.equal(rowsOfType(t.db, r2.session_id, 'STRATEGY_CHANGED').length, 0, 'a carried strategy is unchanged: no row');
    const sc = rowsOfType(t.db, r2.session_id, 'AGENT_STATE_CHANGED');
    assert.equal(sc.length, 1, 'only the agent whose state changed');
    assert.equal(sc[0].agent_id, AGENT);
    assert.equal(sc[0].actor, 'human');
    assert.deepEqual(sc[0].payload, { from: 'RUNNING', to: 'PAUSED', reason: RESET_PAUSED_REASON, by: 'human', replayReset: true, previous_session_id: r1.session_id });
    assert.equal(getAgent(t.db, AGENT).state, 'PAUSED');
    const [rr2] = rowsOfType(t.db, r2.session_id, 'REPLAY_RESET');
    assert.ok(rr2.seq < sc[0].seq, 'REPLAY_RESET opens the session journal; per-agent rows follow');
    assert.equal(rr2.payload.restorePresets, false);
    assert.equal(rr2.payload.killSwitchEngaged, false);
    assert.deepEqual(pick(rr2.payload.agents.find((a) => a.id === TW), ['state', 'previousState', 'strategy_id', 'strategy_source', 'strategyChanged']),
      { state: 'PAUSED', previousState: 'PAUSED', strategy_id: edited.id, strategy_source: 'carried', strategyChanged: false });

    // restorePresets: the edited agent reverts (journaled); unchanged agents get no row; PAUSED -> PAUSED is no change.
    const r3 = reset(t.db, { restorePresets: true });
    assert.equal(r3.ok, true);
    assert.deepEqual(getAgent(t.db, TW).strategy, preset('tightwad-micro'));
    const changed = rowsOfType(t.db, r3.session_id, 'STRATEGY_CHANGED');
    assert.equal(changed.length, 1, 'only the edited agent changed strategy');
    assert.equal(changed[0].agent_id, TW);
    assert.equal(changed[0].actor, 'human');
    assert.deepEqual(pick(changed[0].payload, ['by', 'from', 'to', 'reason', 'source', 'decisionMode', 'previous_session_id']),
      { by: 'human', from: edited.id, to: PRESETS['tightwad-micro'].id, reason: 'REPLAY_RESET', source: 'preset', decisionMode: 'rules', previous_session_id: r2.session_id });
    assert.deepEqual(changed[0].payload.strategy, preset('tightwad-micro'));
    assert.equal(rowsOfType(t.db, r3.session_id, 'AGENT_STATE_CHANGED').length, 0);
    assert.equal(rowsOfType(t.db, r3.session_id, 'REPLAY_RESET')[0].payload.restorePresets, true);

    // A supplied strategies map is a complete specification (agents it does not name get presets)...
    assert.equal(setAgentStrategy(t.db, TW, edited, { by: 'test' }).ok, true);
    const r4 = reset(t.db, { strategies: { [AGENT]: testStrategy() } });
    assert.equal(r4.ok, true);
    assert.equal(getAgent(t.db, AGENT).strategy.id, 'test:cowboy-micro');
    assert.equal(getAgent(t.db, TW).strategy.id, PRESETS['tightwad-micro'].id);
    assert.match(r4.strategies.find((x) => x.agent_id === TW).note, /not named in the strategies map/);
    assert.equal(r4.strategies.find((x) => x.agent_id === AGENT).strategy_source, 'override');
    // ...unless restorePresets:false, which keeps the agents the map does not name.
    assert.equal(setAgentStrategy(t.db, TW, edited, { by: 'test' }).ok, true);
    const r5 = reset(t.db, { strategies: { [AGENT]: testStrategy() }, restorePresets: false });
    assert.equal(getAgent(t.db, TW).strategy.id, edited.id);
    assert.equal(r5.strategies.find((x) => x.agent_id === TW).strategy_source, 'carried');
    assert.equal(rowsOfType(t.db, r5.session_id, 'STRATEGY_CHANGED').length, 0, 'same override and same carried strategy: nothing changed');

    // A stored strategy that no longer parses falls back to the preset: recorded, journaled, not fatal.
    t.db.prepare('UPDATE agents SET strategy_json = ? WHERE id = ?').run('{"id":"broken"', TW);
    const r6 = reset(t.db, {});
    assert.equal(r6.ok, true);
    const a6 = r6.strategies.find((x) => x.agent_id === TW);
    assert.equal(a6.strategy_source, 'preset');
    assert.match(a6.note, /not reusable \(stored strategy is not valid JSON\)/);
    const [chg6] = rowsOfType(t.db, r6.session_id, 'STRATEGY_CHANGED');
    assert.equal(chg6.agent_id, TW);
    assert.equal(chg6.payload.from, null);
    assert.equal(getAgent(t.db, AGENT).strategy.id, 'test:cowboy-micro', 'a valid override from an earlier reset is carried');

    // Invalid options change nothing.
    const sid = getState(t.db).session_id;
    assert.equal(reset(t.db, { restorePresets: 'yes' }).code, 'RESTORE_PRESETS_INVALID');
    assert.equal(reset(t.db, { strategies: [] }).code, 'STRATEGY_INVALID');
    assert.equal(reset(t.db, { strategies: { [AGENT]: { ...testStrategy(), segment: 'large' } } }).code, 'STRATEGY_SEGMENT_MISMATCH');
    assert.equal(getState(t.db).session_id, sid);
  } finally { t.cleanup(); }
});

test('reset while the kill switch is engaged: agents stay STOPPED (reason persisted), start is refused until release; changes are journaled per agent', () => {
  const t = setupDb('reset-kill', (db) => jumpTape(db, 'FIXA'));
  try {
    assert.equal(reset(t.db, {}).ok, true);
    assert.equal(startAgent(t.db, AGENT, { by: 'test' }).ok, true);
    assert.equal(engageKill(t.db, { by: 'test-operator', reason: FIXTURE_LABEL }).ok, true);
    assert.ok(listAgents(t.db).every((a) => a.state === 'STOPPED'));

    const r = reset(t.db, {});
    assert.equal(r.ok, true);
    assert.equal(RESET_KILL_REASON, 'KILL_SWITCH_ENGAGED (persisted across replay reset)');
    for (const a of listAgents(t.db)) {
      assert.equal(a.state, 'STOPPED', a.id);
      assert.equal(a.state_reason, RESET_KILL_REASON, a.id);
    }
    assert.ok(r.strategies.every((x) => x.state === 'STOPPED' && x.previousState === 'STOPPED'));
    assert.equal(rowsOfType(t.db, r.session_id, 'AGENT_STATE_CHANGED').length, 0, 'STOPPED -> STOPPED is not a change');
    const [rr] = rowsOfType(t.db, r.session_id, 'REPLAY_RESET');
    assert.equal(rr.payload.killSwitchEngaged, true);
    assert.ok(rr.payload.agents.every((a) => a.state === 'STOPPED'));
    assert.match(rr.payload.note, /kill switch is engaged/);
    const refused = startAgent(t.db, AGENT, { by: 'test' });
    assert.equal(refused.ok, false);
    assert.equal(refused.code, 'KILL_SWITCH_ENGAGED');

    // Agents left PAUSED while engaged (what an older reset did) are moved to STOPPED, one journal row each.
    t.db.prepare("UPDATE agents SET state = 'PAUSED', state_reason = ?").run(RESET_PAUSED_REASON);
    const r2 = reset(t.db, { actor: 'system' });
    assert.equal(r2.ok, true);
    const sc = rowsOfType(t.db, r2.session_id, 'AGENT_STATE_CHANGED');
    assert.equal(sc.length, 6);
    for (const row of sc) {
      assert.equal(row.actor, 'system');
      assert.deepEqual(pick(row.payload, ['from', 'to', 'reason', 'by']), { from: 'PAUSED', to: 'STOPPED', reason: RESET_KILL_REASON, by: 'system' });
    }
    assert.ok(listAgents(t.db).every((a) => a.state === 'STOPPED'));

    // Release does not resume authority; the next reset starts agents PAUSED (journaled) and a human can start them.
    assert.equal(releaseKill(t.db, { by: 'test-operator' }).ok, true);
    assert.equal(getAgent(t.db, AGENT).state, 'STOPPED');
    const r3 = reset(t.db, {});
    assert.ok(listAgents(t.db).every((a) => a.state === 'PAUSED' && a.state_reason === RESET_PAUSED_REASON));
    const back = rowsOfType(t.db, r3.session_id, 'AGENT_STATE_CHANGED');
    assert.equal(back.length, 6);
    assert.ok(back.every((x) => x.payload.from === 'STOPPED' && x.payload.to === 'PAUSED'));
    assert.equal(startAgent(t.db, AGENT, { by: 'test' }).ok, true);
  } finally {
    if (getKillState(t.db).engaged) releaseKill(t.db, { by: 'test' });
    t.cleanup();
  }
});

test('reset with an unreadable kill-switch row fails closed: agents STOPPED', () => {
  const t = setupDb('reset-kill-unreadable', (db) => jumpTape(db, 'FIXA'));
  try {
    assert.equal(reset(t.db, {}).ok, true);
    t.db.prepare('INSERT INTO controls (k, v, updated_wall) VALUES (?, ?, 0) ON CONFLICT(k) DO UPDATE SET v = excluded.v').run(KILL_KEY, '{not json');
    const r = reset(t.db, {});
    assert.equal(r.ok, true);
    assert.ok(listAgents(t.db).every((a) => a.state === 'STOPPED' && /KILL_SWITCH_STATE_UNREADABLE/.test(a.state_reason)));
    const [rr] = rowsOfType(t.db, r.session_id, 'REPLAY_RESET');
    assert.equal(rr.payload.killSwitchStateUnreadable, true);
    assert.equal(rowsOfType(t.db, r.session_id, 'AGENT_STATE_CHANGED').length, 6);
  } finally { t.cleanup(); }
});

test('partial dataset: the replay ends at the coverage end (truncated); REPLAY_RESET, getState and REPLAY_SESSION_CLOSED record it; nothing advances past it', async () => {
  const t = setupDb('partial', (db) => jumpTape(db, 'FIXA'));
  try {
    markPartial(t.db, at(10, 0) + 30_000); // TEST FIXTURE coverage end mid-minute: the replay ends at the last whole minute
    const r = reset(t.db, {});
    assert.equal(r.ok, true, JSON.stringify(r));
    const st = r.state;
    assert.equal(st.t_start, at(9, 30));
    assert.equal(st.t_end, at(10, 0));
    assert.equal(st.session_close, at(16, 0));
    assert.equal(st.coverage_end, at(10, 0) + 30_000);
    assert.equal(st.truncated, true);
    assert.equal(st.minutesRemaining, 30);
    assert.equal(st.dataset.complete, false);
    assert.equal(st.dataset.coverage_end, at(10, 0) + 30_000);
    assert.match(st.truncation_note, /DATASET_TRUNCATED/);
    assert.equal(t.db.prepare('SELECT t_end FROM replay_state WHERE id = 1').get().t_end, at(10, 0), 'the recorded window is truncated');
    const [rr] = rowsOfType(t.db, r.session_id, 'REPLAY_RESET');
    assert.deepEqual(pick(rr.payload, ['t_start', 't_end', 'session_close', 'coverage_end', 'truncated']),
      { t_start: at(9, 30), t_end: at(10, 0), session_close: at(16, 0), coverage_end: at(10, 0) + 30_000, truncated: true });
    assert.match(rr.payload.note, /PARTIAL DATASET/);

    const s = await step(t.db, { minutes: 390 });
    assert.equal(s.ok, true);
    assert.equal(s.closed, true);
    assert.equal(s.minutes, 30);
    assert.equal(s.to, at(10, 0));
    const end = getState(t.db);
    assert.equal(end.status, 'SESSION_CLOSED');
    assert.equal(end.minutesRemaining, 0);
    const [closed] = rowsOfType(t.db, r.session_id, 'REPLAY_SESSION_CLOSED');
    assert.equal(closed.ts_sim, at(10, 0));
    assert.deepEqual(pick(closed.payload, ['t_end', 'session_close', 'coverage_end', 'truncated']),
      { t_end: at(10, 0), session_close: at(16, 0), coverage_end: at(10, 0) + 30_000, truncated: true });
    assert.match(closed.payload.note, /coverage end/);
    assert.equal((await step(t.db, { minutes: 1 })).code, 'SESSION_CLOSED');
    assert.equal(play(t.db, {}).code, 'SESSION_CLOSED');

    // Coverage after the close: the full session replays and nothing is truncated.
    markPartial(t.db, at(16, 0) + 5 * MINUTE);
    const late = reset(t.db, { ds: FIXTURE_DS });
    assert.equal(late.ok, true);
    assert.equal(late.state.t_end, at(16, 0));
    assert.equal(late.state.truncated, false);
    assert.equal(late.state.coverage_end, at(16, 0) + 5 * MINUTE);
    assert.equal(rowsOfType(t.db, late.session_id, 'REPLAY_RESET')[0].payload.truncated, false);
  } finally { t.cleanup(); }
});

test('truncated replay: DAY orders expire at the replay end (not 16:00), none is accepted after it, and REPLAY_SESSION_CLOSED says what expired', async () => {
  const t = setupDb('partial-expiry', (db) => jumpTape(db, 'FIXA'));
  try {
    markPartial(t.db, at(10, 0) + 30_000); // TEST FIXTURE coverage end: the replay ends at 10:00
    const r = reset(t.db, {});
    assert.equal(r.state.t_end, at(10, 0));
    assert.equal((await step(t.db, { minutes: 5 })).ok, true);
    const octx = () => ({ session_id: r.session_id, ds: FIXTURE_DS, clock: getState(t.db).clock });
    // A TEST FIXTURE sandbox limit buy far below the market: it stays working until the replay end.
    const o = submitOrder(t.db, octx(), { portfolio_id: 'sandbox', sym: 'FIXA', side: 'buy', type: 'limit', qty: 10, limit_px: 1000, actor: 'human' });
    assert.equal(o.ok, true, JSON.stringify(o.errors));
    assert.equal(o.order.expires_ts, at(10, 0), 'DAY expiry capped at the replay end');
    assert.equal(JSON.parse(o.order.meta_json).expiryBasis, 'REPLAY_END_TRUNCATED');
    const s = await step(t.db, { minutes: 390 });
    assert.equal(s.closed, true);
    const after = getOrder(t.db, o.order.id);
    assert.equal(after.status, 'expired');
    assert.equal(after.reason, 'DAY_ORDER_EXPIRED_AT_REPLAY_END');
    assert.equal(after.updated_ts, at(10, 0));
    const [exp] = rowsOfType(t.db, r.session_id, 'ORDER_EXPIRED').filter((x) => x.ref_id === o.order.id);
    assert.match(exp.payload.reason, /replay end \(10:00 ET\).*PARTIAL dataset's coverage end/);
    assert.doesNotMatch(exp.payload.reason, /16:00 ET\)$/);
    const [closed] = rowsOfType(t.db, r.session_id, 'REPLAY_SESSION_CLOSED');
    assert.deepEqual(closed.payload.expiredAtClose, [o.order.id]);
    assert.equal(closed.payload.expiredCount, 1);
    assert.deepEqual(closed.payload.forcedExpiredAtReplayEnd, []);
    assert.match(closed.payload.note, /1 open order\(s\) expired in the final minute/);
    assert.equal(t.db.prepare(`SELECT COUNT(*) n FROM orders WHERE session_id = ? AND status IN ('working', 'pending_parent', 'triggered', 'partially_filled')`).get(r.session_id).n, 0);
    // Nothing is accepted at/after the replay end.
    const late = submitOrder(t.db, octx(), { portfolio_id: 'sandbox', sym: 'FIXA', side: 'buy', type: 'limit', qty: 10, limit_px: 1000, actor: 'human' });
    assert.equal(late.ok, false);
    assert.equal(late.code, 'SESSION_CLOSED');
    assert.match(late.errors[0].detail, /coverage end/);
  } finally { t.cleanup(); }
});

test('a session later found PARTIAL: orders recorded with a 16:00 expiry are expired at the replay end (REPLAY_END_TRUNCATED), with a truthful close note', async () => {
  const t = setupDb('legacy-expiry', (db) => jumpTape(db, 'FIXA'));
  try {
    const r = reset(t.db, {});
    assert.equal((await step(t.db, { minutes: 5 })).ok, true);
    const o = submitOrder(t.db, { session_id: r.session_id, ds: FIXTURE_DS, clock: getState(t.db).clock },
      { portfolio_id: 'sandbox', sym: 'FIXA', side: 'buy', type: 'limit', qty: 10, limit_px: 1000, actor: 'human' });
    assert.equal(o.order.expires_ts, at(16, 0));
    markPartial(t.db, at(9, 45)); // TEST FIXTURE: the dataset turns out to be partial after the order was placed
    const s = await step(t.db, { minutes: 60 });
    assert.equal(s.closed, true);
    const after = getOrder(t.db, o.order.id);
    assert.equal(after.status, 'expired');
    assert.equal(after.reason, 'REPLAY_END_TRUNCATED');
    assert.equal(after.updated_ts, at(9, 45), 'expired at the replay end, never at the later 16:00 close');
    const [closed] = rowsOfType(t.db, r.session_id, 'REPLAY_SESSION_CLOSED');
    assert.deepEqual(closed.payload.forcedExpiredAtReplayEnd, [o.order.id]);
    assert.match(closed.payload.note, /1 open order\(s\) expired in the final minute \(1 of them recorded with a later expiry/);
  } finally { t.cleanup(); }
});

test('truncated replay: agents measure their entry window from the replay end (no entry inside noEntryLastMin of it)', async () => {
  const t = setupDb('partial-agent', (db) => jumpTape(db, 'FIXA'));
  try {
    markPartial(t.db, at(9, 50)); // TEST FIXTURE: replay ends 09:50; the fixture jump would trigger an entry at 09:48
    const r = reset(t.db, { strategies: { [AGENT]: testStrategy({ entry: { noEntryLastMin: 15 } }) } });
    assert.equal(startAgent(t.db, AGENT, { by: 'test' }).ok, true);
    const s = await step(t.db, { minutes: 390 });
    assert.equal(s.closed, true);
    assert.equal(rowsOfType(t.db, r.session_id, 'INTENT_PROPOSED').length, 0, 'no entry 2 minutes before the replay end');
    const scans = rowsOfType(t.db, r.session_id, 'AGENT_SCAN');
    assert.ok(scans.some((x) => (x.payload.skipped?.OUTSIDE_ENTRY_WINDOW ?? 0) > 0));
    assert.equal(t.db.prepare('SELECT COUNT(*) n FROM orders WHERE session_id = ?').get(r.session_id).n, 0);
  } finally { t.cleanup(); }
  // Control: the same tape and strategy on a complete dataset enters at 09:48.
  const c = setupDb('partial-agent-control', (db) => jumpTape(db, 'FIXA'));
  try {
    const r = reset(c.db, { strategies: { [AGENT]: testStrategy({ entry: { noEntryLastMin: 15 } }) } });
    assert.equal(startAgent(c.db, AGENT, { by: 'test' }).ok, true);
    assert.equal((await step(c.db, { minutes: 20 })).ok, true);
    assert.equal(rowsOfType(c.db, r.session_id, 'INTENT_PROPOSED').length, 1);
  } finally { c.cleanup(); }
});

test('partial dataset whose data ends at/before the open: an explicit reset is refused (DATASET_INCOMPLETE); the default reset skips it', () => {
  const t = setupDb('incomplete', (db) => jumpTape(db, 'FIXA'));
  try {
    const before = reset(t.db, {});
    assert.equal(before.ok, true);
    const NEWER = 'test-fixture-agents-2099-01-06'; // TEST FIXTURE dataset row, no minute rows
    seedFixtureDataset(t.db, { id: NEWER, tradeDate: '2099-01-06' });
    const newerOpen = etToUtc('2099-01-06', 9, 30);
    markPartial(t.db, newerOpen, { id: NEWER });

    const x = reset(t.db, { ds: NEWER });
    assert.equal(x.ok, false);
    assert.equal(x.code, 'DATASET_INCOMPLETE');
    assert.equal(x.coverage_end, newerOpen);
    assert.match(x.message, /at or before the 09:30 ET open/);
    assert.equal(getState(t.db).session_id, before.session_id, 'a refused reset changes nothing');

    const d = reset(t.db, {});
    assert.equal(d.ok, true);
    assert.equal(d.state.ds, FIXTURE_DS, 'the newest dataset is unreplayable: the newest replayable one is used');
    const [rr] = rowsOfType(t.db, d.session_id, 'REPLAY_RESET');
    assert.deepEqual(rr.payload.skippedDatasets.map((s) => pick(s, ['id', 'code', 'coverage_end'])), [{ id: NEWER, code: 'DATASET_INCOMPLETE', coverage_end: newerOpen }]);

    markPartial(t.db, null, { id: NEWER }); // coverage end unknown
    const unknown = reset(t.db, { ds: NEWER });
    assert.equal(unknown.code, 'DATASET_INCOMPLETE');
    assert.match(unknown.message, /coverage end is unknown/);

    markPartial(t.db, at(9, 0)); // now every dataset ends before its open
    const none = reset(t.db, {});
    assert.equal(none.ok, false);
    assert.equal(none.code, 'DATASET_INCOMPLETE');
    assert.equal(getState(t.db).session_id, d.session_id);
  } finally { t.cleanup(); }
});

test('a session recorded before truncation existed is capped at the coverage end by getState, so step() stops there', async () => {
  const t = setupDb('legacy-partial', (db) => jumpTape(db, 'FIXA'));
  try {
    const r = reset(t.db, {});
    assert.equal(r.state.t_end, at(16, 0));
    markPartial(t.db, at(9, 45)); // TEST FIXTURE: the dataset turns out to be partial after the session was recorded
    const st = getState(t.db);
    assert.equal(st.t_end, at(9, 45));
    assert.equal(st.truncated, true);
    assert.equal(t.db.prepare('SELECT t_end FROM replay_state WHERE id = 1').get().t_end, at(16, 0), 'the stored row is not rewritten');
    const s = await step(t.db, { minutes: 60 });
    assert.equal(s.ok, true);
    assert.equal(s.to, at(9, 45));
    assert.equal(s.closed, true);
  } finally { t.cleanup(); }
});

// ---- model assessor resolved per call -----------------------------------------------------------------------------

/** TEST FIXTURE provider stubs (not models). */
const noneProvider = () => ({ id: 'none', kind: 'none', model: null, status: async () => ({ status: 'DISCONNECTED', detail: 'No model provider configured (TEST FIXTURE)' }), complete: async () => { throw new Error('must not be called'); } });
function downProvider() {
  const p = { id: 'stub-down', kind: 'openai-compatible', model: 'stub (TEST FIXTURE)', statusCalls: 0,
    status: async () => { p.statusCalls++; return { status: 'DISCONNECTED', detail: 'stub endpoint down (TEST FIXTURE)' }; },
    complete: async () => { throw new Error('must not be called'); } };
  return p;
}
function refusingProvider() {
  const p = {
    id: 'stub-refused', kind: 'openai-compatible', model: 'stub (TEST FIXTURE)', statusCalls: 0, completeCalls: 0,
    config: { trainingCutoff: '2020-01-01', trainingCutoffSource: 'TEST FIXTURE' },
    status: async () => { p.statusCalls++; return { status: 'CONNECTED', detail: 'TEST FIXTURE stub' }; },
    complete: async () => { p.completeCalls++; return { ok: false, refusal: null, errorKind: 'NETWORK', error: 'connect ECONNREFUSED 127.0.0.1:9 (TEST FIXTURE)', usage: {}, latencyMs: 1 }; },
  };
  return p;
}

test('createLensAssessor with a resolver: a provider configured, changed or removed after wiring takes effect at the next call', async () => {
  const t = setupDb('assessor-resolve', (db) => jumpTape(db, 'FIXA'));
  try {
    const ctx = { ds: FIXTURE_DS, clock: at(9, 48), session_id: null };
    let current = null;
    const assess = createLensAssessor(t.db, () => current, { statusTtlMs: 3_600_000 });
    assert.equal(assess.isConfigured(), false);
    let r = await assess('FIXA', 'cowboy', ctx);
    assert.equal(r.status, 'MODEL_DISCONNECTED');
    assert.match(r.detail, /no model provider configured/);

    current = noneProvider();
    assert.equal(assess.isConfigured(), false);
    r = await assess('FIXA', 'cowboy', ctx);
    assert.equal(r.status, 'MODEL_DISCONNECTED');
    assert.match(r.detail, /No model provider configured \(TEST FIXTURE\)/);

    const down = downProvider();
    current = down;
    assert.equal(assess.isConfigured(), true);
    r = await assess('FIXA', 'cowboy', ctx);
    assert.equal(r.status, 'MODEL_DISCONNECTED');
    assert.match(r.detail, /provider DISCONNECTED/);
    await assess('FIXA', 'cowboy', ctx);
    assert.equal(down.statusCalls, 1, 'status cached within the TTL for the same provider');
    const down2 = downProvider();
    current = down2;
    await assess('FIXA', 'cowboy', ctx);
    assert.equal(down2.statusCalls, 1, 'a changed provider is probed at once despite the TTL');
    current = down;
    await assess('FIXA', 'cowboy', ctx);
    assert.equal(down.statusCalls, 2, 'switching back discards the other provider\'s cached status');

    const net = refusingProvider();
    current = net;
    r = await assess('FIXA', 'cowboy', ctx);
    assert.equal(r.status, 'MODEL_DISCONNECTED');
    assert.match(r.detail, /NETWORK/);
    assert.equal(net.completeCalls, 1, 'the newly configured provider was called');

    const broken = createLensAssessor(t.db, () => { throw new Error('config unreadable (TEST FIXTURE)'); });
    assert.equal(broken.isConfigured(), false);
    r = await broken('FIXA', 'cowboy', ctx);
    assert.equal(r.status, 'MODEL_DISCONNECTED');
    assert.match(r.detail, /provider resolution failed: config unreadable/);
  } finally { t.cleanup(); }
});

test('model_confirm agent with a per-call assessor: BLOCKED at once while no provider is configured; after one is configured and the agent resumed, the same assessor uses it', async () => {
  const t = setupDb('assessor-runner', (db) => jumpTape(db, 'FIXA'));
  try {
    const r = reset(t.db, { strategies: { [AGENT]: testStrategy({ decisionMode: 'model_confirm' }) } });
    assert.equal(startAgent(t.db, AGENT, { by: 'test' }).ok, true);
    let current = noneProvider();
    const assess = createLensAssessor(t.db, () => current, { statusTtlMs: 3_600_000 });
    assert.equal((await step(t.db, { minutes: 1, assess })).ok, true);
    assert.equal(getAgent(t.db, AGENT).state, 'BLOCKED');
    assert.equal(getAgent(t.db, AGENT).state_reason, 'MODEL_DISCONNECTED');
    const [b1] = rowsOfType(t.db, r.session_id, 'AGENT_BLOCKED');
    assert.equal(b1.ts_sim, at(9, 31), 'blocked at the first step, before any candidate (as with no assessor wired)');

    const net = refusingProvider();
    current = net;
    assert.equal(resumeAgent(t.db, AGENT, { by: 'test' }).ok, true);
    assert.equal((await step(t.db, { minutes: 20, assess })).ok, true);
    assert.equal(net.completeCalls, 1, 'the provider configured after wiring was consulted at the first candidate');
    const blocked = rowsOfType(t.db, r.session_id, 'AGENT_BLOCKED');
    assert.equal(blocked.length, 2);
    assert.equal(blocked[1].ts_sim, at(9, 48));
    assert.match(blocked[1].payload.detail, /NETWORK/);
  } finally { t.cleanup(); }
});
