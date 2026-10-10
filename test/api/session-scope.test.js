// TEST FIXTURE — NOT MARKET DATA. Session scoping and hindsight over a synthetic tape: the journal defaults to the current
// replay session and hides other sessions' rows recorded after the clock; the retrospective study is withheld until the
// close; stored assessments are scoped to the current session (API and dossier); a reset carries user-edited strategies
// unless restorePresets; the boot-time reset is attributed to 'system'; opportunity horizons; agent activity summaries;
// incremental journal chain verification.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { tempDb, seedFixture, startTestServer, SYM, at, MINUTE } from './helpers.js';
import { append } from '../../server/journal.js';

let t;
let srv;
let api;

before(async () => {
  t = tempDb('scope');
  seedFixture(t.db);
  srv = await startTestServer(t.db);
  api = srv.client;
});
after(async () => { await srv?.close(); t?.cleanup(); });

const buy = (extra = {}) => ({ action: 'open', instrument: { kind: 'equity', sym: SYM }, side: 'buy', order_type: 'market', qty: 100, rationale: 'TEST FIXTURE order', confirm: true, ...extra });
const status = async () => (await api.get('/api/status')).json;

test('the boot-time initial reset is journaled with actor system, not human', () => {
  const r = t.db.prepare("SELECT actor FROM journal WHERE type = 'REPLAY_RESET' ORDER BY seq LIMIT 1").get();
  assert.equal(r.actor, 'system');
  assert.equal(srv.bootSummary.initialReset.initiatedBy, 'system');
});

test('journal: default scope is the current session; other sessions after the clock are hidden unless hindsight=1', async () => {
  const sesA = (await status()).replay.session_id;
  assert.equal((await api.post('/api/orders', buy())).status, 201);
  const stepped = await api.post('/api/replay/step', { minutes: 30 });
  assert.equal(stepped.status, 200, stepped.text);
  assert.ok(stepped.json.fills >= 1);
  const aMax = t.db.prepare('SELECT MAX(ts_sim) m FROM journal WHERE session_id = ?').get(sesA).m;
  assert.ok(aMax >= at(10, 0));

  const rs = await api.post('/api/replay/reset', {});
  assert.equal(rs.status, 200, rs.text);
  const st = await status();
  const sesB = st.replay.session_id;
  assert.notEqual(sesB, sesA);
  assert.equal(st.replay.clock, at(9, 30));

  const def = (await api.get('/api/journal?limit=1000')).json;
  assert.equal(def.scope, 'current');
  assert.equal(def.current_session_id, sesB);
  assert.ok(def.rows.length > 0);
  assert.ok(def.rows.every((r) => r.session_id === sesB), 'default view holds only the current session');
  assert.ok(def.rows.every((r) => r.ts_sim === null || r.ts_sim <= st.replay.clock));
  const fills = (await api.get('/api/journal?type=FILL_ESTIMATED')).json;
  assert.equal(fills.rows.length, 0, "the previous run's fills are not in the default view");

  const all = (await api.get('/api/journal?session_id=all&limit=1000')).json;
  assert.equal(all.scope, 'all');
  assert.equal(all.hindsight, false);
  assert.ok(all.rows.some((r) => r.session_id === sesA), 'prior-session rows up to the clock remain visible');
  assert.ok(!all.rows.some((r) => r.session_id !== sesB && r.ts_sim !== null && r.ts_sim > st.replay.clock), 'no later-in-day rows of a prior run');
  assert.ok(all.rows.filter((r) => r.session_id === sesA).every((r) => r.prior_session === true && r.hindsight === false));

  const explicit = (await api.get(`/api/journal?session_id=${sesA}&type=FILL_ESTIMATED`)).json;
  assert.equal(explicit.rows.length, 0, 'an explicit prior-session request is capped at the clock too');

  const hs = (await api.get(`/api/journal?session_id=all&hindsight=1&type=FILL_ESTIMATED`)).json;
  assert.equal(hs.hindsight, true);
  assert.match(hs.label, /^HINDSIGHT/);
  assert.ok(hs.rows.length >= 1);
  assert.ok(hs.rows.every((r) => r.session_id === sesA && r.prior_session && r.hindsight === true));
});

test('journal chain verification is incremental after the first check; verify=full re-hashes everything', async () => {
  const a = (await api.get('/api/journal?limit=1')).json.chain;
  assert.equal(a.ok, true);
  assert.equal((await api.post('/api/orders', buy({ confirm: false }))).status, 409); // journals INTENT_PROPOSED + POLICY_DENY
  const b =(await api.get('/api/journal?limit=1')).json.chain;
  assert.equal(b.ok, true);
  assert.equal(b.mode, 'incremental');
  assert.ok(b.newlyChecked >= 1 && b.newlyChecked < b.checked);
  const total = t.db.prepare('SELECT COUNT(*) n FROM journal').get().n;
  assert.equal(b.checked, total);
  const f = (await api.get('/api/journal?limit=1&verify=full')).json.chain;
  assert.equal(f.mode, 'full');
  assert.equal(f.ok, true);
  assert.equal(f.checked, total);
});

test('stored assessments: only the current session, in /api/assessments and in the dossier', async () => {
  const st = await status();
  const insert = t.db.prepare(`INSERT INTO assessments (id, session_id, sym, lens, provider, model, as_of, created_wall, evidence_ids_json, packet_sha256, status, output_json)
    VALUES (?, ?, ?, 'cowboy', 'TEST FIXTURE provider', 'TEST FIXTURE model', ?, ?, '[]', ?, 'OK', '{}')`);
  insert.run('asm_test_fixture_prior', 'ses_test_fixture_prior', SYM, at(9, 30), Date.now(), '1'.repeat(64));
  let d = (await api.get(`/api/research/dossier?sym=${SYM}`)).json;
  assert.equal(d.assessments.status, 'ASSESSMENT_NOT_RUN');
  assert.ok(d.unavailable.some((u) => u.section === 'assessments'));
  assert.equal((await api.get(`/api/assessments?sym=${SYM}`)).json.status, 'ASSESSMENT_NOT_RUN');

  insert.run('asm_test_fixture_current', st.replay.session_id, SYM, st.replay.clock, Date.now(), '2'.repeat(64));
  insert.run('asm_test_fixture_future', st.replay.session_id, SYM, st.replay.clock + 10 * MINUTE, Date.now(), '3'.repeat(64));
  d = (await api.get(`/api/research/dossier?sym=${SYM}`)).json;
  assert.equal(d.assessments.status, 'STORED');
  assert.deepEqual(d.assessments.rows.map((r) => r.id), ['asm_test_fixture_current']);
  assert.equal(d.assessments.rows[0].packet_sha256, '2'.repeat(64));
  assert.ok(!d.unavailable.some((u) => u.section === 'assessments'));
  const list = (await api.get(`/api/assessments?sym=${SYM}`)).json;
  assert.deepEqual(list.rows.map((r) => r.id), ['asm_test_fixture_current']);
});

test('opportunities accept minute horizons 5/15/30/60 only; days/weeks are BLOCKED BY DATA', async () => {
  const o = (await api.get('/api/research/opportunities?segment=micro&windowMin=60')).json;
  assert.equal(o.windowMin, 60);
  assert.equal(o.horizons.selected, 60);
  assert.match(o.horizons.daysWeeks, /^BLOCKED BY DATA/);
  assert.equal((await api.get('/api/research/opportunities?segment=micro')).json.windowMin, 15);
  const bad = await api.get('/api/research/opportunities?windowMin=7');
  assert.equal(bad.status, 400);
  assert.equal(bad.json.error.code, 'ENUM_INVALID');
});

test('opportunities take an instruments filter (all | common | non_common) that partitions the ranked rows', async () => {
  const all = (await api.get('/api/research/opportunities?segment=micro')).json;
  const common = (await api.get('/api/research/opportunities?segment=micro&instruments=common')).json;
  const non = (await api.get('/api/research/opportunities?segment=micro&instruments=non_common')).json;
  assert.deepEqual([all.instruments, common.instruments, non.instruments], ['all', 'common', 'non_common']);
  assert.equal(common.rows.length + non.rows.length, all.rows.length);
  assert.ok(common.rows.every((r) => r.nonCommon === false) && non.rows.every((r) => r.nonCommon === true));
  assert.ok('nameSource' in all);
  const u = (await api.get('/api/market/universe?segment=micro')).json;
  assert.ok(u.rows.every((r) => 'securityType' in r && 'namePostDated' in r && 'nonCommon' in r));
  const bad = await api.get('/api/research/opportunities?instruments=warrants');
  assert.equal(bad.status, 400);
  assert.equal(bad.json.error.code, 'ENUM_INVALID');
});

test('agent activity summarises skip reasons and gate denials for the current session only', async () => {
  const st = await status();
  // TEST FIXTURE journal rows standing in for agent scans.
  for (const sid of [st.replay.session_id, 'ses_test_fixture_prior']) {
    append(t.db, {
      session_id: sid, ts_sim: st.replay.clock, portfolio_id: 'tightwad-micro', agent_id: 'agent-tightwad-micro', actor: 'agent', type: 'AGENT_SCAN',
      payload: { universe: 3, scanned: 3, skipped: { SPREAD_ABOVE_MAX: 3, RET_BELOW_MIN: 1 }, topCandidates: [], planned: [], label: 'TEST FIXTURE' },
    });
  }
  const r = await api.get('/api/agents/activity');
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.session_id, st.replay.session_id);
  assert.equal(r.json.rows.length, 6);
  const tw = r.json.rows.find((x) => x.agent_id === 'agent-tightwad-micro');
  assert.equal(tw.scans, 1, 'rows of other sessions are not counted');
  assert.deepEqual(tw.skipped[0], { code: 'SPREAD_ABOVE_MAX', n: 3, meaning: 'IEX spread above entry.maxSpreadBps' });
  assert.match(tw.explanation, /No entries in 1 scans.*SPREAD_ABOVE_MAX x3/);
  const one = (await api.get('/api/agents/activity?agent_id=agent-tightwad-micro')).json;
  assert.equal(one.rows.length, 1);
  assert.equal((await api.get('/api/agents/activity?agent_id=agent-nobody-micro')).status, 404);
});

test('reset carries user-edited strategies by default; restorePresets reverts them; both are journaled', async () => {
  const presets = (await api.get('/api/agents')).json.presets;
  const edited = structuredClone(presets['tightwad-micro']);
  edited.entry.maxSpreadBps = 3000;
  assert.equal((await api.put('/api/agents/agent-tightwad-micro/strategy', { strategy: edited })).status, 200);

  const r1 = await api.post('/api/replay/reset', {});
  assert.equal(r1.status, 200, r1.text);
  assert.equal(r1.json.restorePresets, false);
  const s1 = r1.json.strategies.find((x) => x.agent_id === 'agent-tightwad-micro');
  assert.equal(s1.strategy_source, 'carried');
  assert.equal(s1.matchesPreset, false);
  let agent = (await api.get('/api/agents')).json.rows.find((a) => a.id === 'agent-tightwad-micro');
  assert.equal(agent.strategy.entry.maxSpreadBps, 3000);
  assert.equal(agent.state, 'PAUSED');
  // The engine applies the one reset rule and journals it (REPLAY_RESET by 'human', with each agent's strategy source).
  const rr1 = t.db.prepare("SELECT actor, payload_json FROM journal WHERE type = 'REPLAY_RESET' AND session_id = ?").get(r1.json.session_id);
  assert.equal(rr1.actor, 'human');
  assert.equal(JSON.parse(rr1.payload_json).restorePresets, false);
  assert.equal(JSON.parse(rr1.payload_json).agents.find((x) => x.id === 'agent-tightwad-micro').strategy_source, 'carried');

  const r2 = await api.post('/api/replay/reset', { restorePresets: true });
  assert.equal(r2.status, 200, r2.text);
  const s2 = r2.json.strategies.find((x) => x.agent_id === 'agent-tightwad-micro');
  assert.equal(s2.strategy_source, 'preset');
  assert.equal(s2.matchesPreset, true);
  agent = (await api.get('/api/agents')).json.rows.find((a) => a.id === 'agent-tightwad-micro');
  assert.equal(agent.strategy.entry.maxSpreadBps, presets['tightwad-micro'].entry.maxSpreadBps);
  const changed = t.db.prepare("SELECT payload_json FROM journal WHERE type = 'STRATEGY_CHANGED' AND session_id = ? AND agent_id = 'agent-tightwad-micro'").get(r2.json.session_id);
  assert.equal(JSON.parse(changed.payload_json).reason, 'REPLAY_RESET', 'the revert is journaled per agent');
  assert.equal((await api.post('/api/replay/reset', { restorePresets: 'yes' })).status, 400);
});

test('a reset while the kill switch is engaged keeps every agent STOPPED and says so', async () => {
  assert.equal((await api.post('/api/kill', { protective_policy: 'KEEP_PROTECTIVE' })).status, 200);
  try {
    const r = await api.post('/api/replay/reset', {});
    assert.equal(r.status, 200, r.text);
    assert.ok(r.json.strategies.every((x) => x.state === 'STOPPED'));
    assert.match(r.json.note, /kill switch is engaged: all agents stay STOPPED/);
    assert.ok((await status()).agents.every((a) => a.state === 'STOPPED'));
  } finally {
    assert.equal((await api.post('/api/kill/release', {})).status, 200);
  }
});

test('the retrospective study for the replayed dataset is withheld until the replay clock reaches the close', async () => {
  const st = await status();
  assert.ok(st.replay.clock < st.replay.t_end);
  for (const p of ['/api/research/study', '/api/research/study?tier=low&full=1']) {
    const s = (await api.get(p)).json;
    assert.equal(s.status, 'BLOCKED');
    assert.equal(s.reason, 'WITHHELD_UNTIL_CLOSE');
    assert.equal(s.availableAtMs, st.replay.t_end);
    assert.deepEqual(s.rows, []);
  }
  const minutes = Math.round((st.replay.t_end - st.replay.clock) / MINUTE);
  const r = await api.post('/api/replay/step', { minutes });
  assert.equal(r.status, 200, r.text);
  assert.equal((await status()).replay.clock, st.replay.t_end);
  const s = (await api.get('/api/research/study')).json;
  assert.notEqual(s.reason, 'WITHHELD_UNTIL_CLOSE');
  assert.equal(s.label, 'RETROSPECTIVE — uses data after each signal; never visible to agents');
});
