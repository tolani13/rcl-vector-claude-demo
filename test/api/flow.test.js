// TEST FIXTURE — NOT MARKET DATA. End-to-end API flows over a synthetic tape: sandbox order lifecycle through the policy
// gate and orders engine, cancel/replace, kill switch, agent controls, replay step/play/pause, as-of views, journal
// chain, options refusal, CSV import, model-disconnected refusals and boot-time authority pause.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { tempDb, seedFixture, startTestServer, FIX_DS, SYM, STALE, at, MINUTE } from './helpers.js';

let t;
let srv;
let api;

before(async () => {
  t = tempDb('flow');
  seedFixture(t.db);
  srv = await startTestServer(t.db);
  api = srv.client;
});
after(async () => { await srv?.close(); t?.cleanup(); });

const buy = (extra = {}) => ({ action: 'open', instrument: { kind: 'equity', sym: SYM }, side: 'buy', order_type: 'market', qty: 100, rationale: 'TEST FIXTURE order', ...extra });
const types = (session) => t.db.prepare('SELECT type FROM journal WHERE session_id = ? ORDER BY seq').all(session).map((r) => r.type);

test('boot created a session on the fixture dataset with all agents PAUSED and nothing playing', async () => {
  const s = (await api.get('/api/status')).json;
  assert.equal(s.replay.ds, FIX_DS);
  assert.equal(s.replay.clock, at(9, 30));
  assert.equal(s.replay.playing, false);
  assert.equal(s.agents.length, 6);
  assert.ok(s.agents.every((a) => a.state === 'PAUSED'));
  assert.equal(s.model.status, 'DISCONNECTED');
  assert.equal(srv.bootSummary.initialReset.ds, FIX_DS);
});

test('sandbox order: confirm required -> accepted -> estimated fill after one replay step -> sell', async () => {
  const sid = (await api.get('/api/status')).json.replay.session_id;
  // 1. Without confirm the gate denies (human_confirmed) and the attempt is journaled.
  const noConfirm = await api.post('/api/orders', buy());
  assert.equal(noConfirm.status, 409);
  assert.equal(noConfirm.json.error.code, 'HUMAN_NOT_CONFIRMED');
  assert.equal(noConfirm.json.decision, 'DENIED');
  assert.ok(noConfirm.json.checks.some((c) => c.rule === 'human_confirmed' && c.pass === false));
  // 2. With confirm: accepted and working, no fill yet (fills only after the next completed minute).
  const ok = await api.post('/api/orders', { ...buy(), confirm: true });
  assert.equal(ok.status, 201, ok.text);
  assert.equal(ok.json.decision, 'ACCEPTED');
  assert.equal(ok.json.order.status, 'working');
  assert.equal(ok.json.order.portfolio_id, 'sandbox');
  let pf = (await api.get('/api/portfolios/sandbox')).json;
  assert.equal(pf.positions.length, 0);
  assert.equal(pf.openOrders.length, 1);
  // 3. Step one minute: the order is evaluated against the completed 09:30 minute -> estimated fill.
  const st = await api.post('/api/replay/step', { minutes: 1 });
  assert.equal(st.status, 200, st.text);
  assert.equal(st.json.fills, 1);
  assert.equal(st.json.to, at(9, 31));
  pf = (await api.get('/api/portfolios/sandbox')).json;
  assert.equal(pf.positions.length, 1);
  assert.equal(pf.positions[0].qty, 100);
  assert.equal(pf.positions[0].markBasis, 'IEX_BID');
  assert.equal(pf.fills.length, 1);
  assert.equal(pf.fills[0].estimated, true);
  assert.equal(pf.fills[0].label, 'ESTIMATED PAPER FILL');
  assert.ok(pf.fills[0].price > 5010, 'buy fill = worst ask + slippage (TEST FIXTURE tape)');
  assert.ok(pf.cashU < pf.portfolio.startingCashU);
  // 4. Sell what is held (no shorting: selling more is denied).
  const over = await api.post('/api/orders', { action: 'close', instrument: { kind: 'equity', sym: SYM }, side: 'sell', order_type: 'market', qty: 101, confirm: true });
  assert.equal(over.status, 409);
  assert.equal(over.json.error.code, 'SHORT_SALE_NOT_ALLOWED');
  const sell = await api.post('/api/orders', { action: 'close', instrument: { kind: 'equity', sym: SYM }, side: 'sell', order_type: 'market', qty: 100, confirm: true });
  assert.equal(sell.status, 201, sell.text);
  await api.post('/api/replay/step', { minutes: 1 });
  pf = (await api.get('/api/portfolios/sandbox')).json;
  assert.equal(pf.positions.length, 0);
  assert.equal(pf.fills.length, 2);
  assert.ok(pf.realizedU < 0, 'round trip across the spread with slippage and fees loses money');
  const ty = types(sid);
  for (const k of ['INTENT_PROPOSED', 'POLICY_DENY', 'POLICY_ACCEPT', 'ORDER_SUBMITTED', 'FILL_ESTIMATED', 'MARK_TO_MARKET']) assert.ok(ty.includes(k), `journal has ${k}`);
  const intents = t.db.prepare("SELECT decision FROM intents WHERE session_id = ? AND source = 'human'").all(sid).map((r) => r.decision);
  assert.deepEqual(intents, ['DENIED', 'ACCEPTED', 'DENIED', 'ACCEPTED']);
});

test('budget and stale-quote denials come from the policy gate', async () => {
  const big = await api.post('/api/orders', { ...buy({ qty: 600_000 }), confirm: true });
  assert.equal(big.status, 409);
  assert.ok(big.json.reasons.some((r) => r.code === 'BUDGET_EXCEEDED'));
  const stale = await api.post('/api/orders', { ...buy({ instrument: { kind: 'equity', sym: STALE } }), confirm: true });
  assert.equal(stale.status, 409);
  assert.ok(stale.json.reasons.some((r) => r.code === 'QUOTE_STALE'), JSON.stringify(stale.json.reasons));
});

test('cancel and replace require confirm and go through the gate', async () => {
  const lim = await api.post('/api/orders', { ...buy({ order_type: 'limit', limit_px_u: 2500, qty: 10 }), confirm: true });
  assert.equal(lim.status, 201, lim.text);
  const id = lim.json.order.id;
  const rep = await api.post(`/api/orders/${id}/replace`, { limit_px_u: 2400, qty: 8, confirm: true });
  assert.equal(rep.status, 200, rep.text);
  assert.equal(rep.json.order.limit_px, 2400);
  assert.equal(rep.json.order.qty, 8);
  assert.equal((await api.post(`/api/orders/${id}/replace`, { stop_px_u: 2600, confirm: true })).status, 400);
  const noConf = await api.post(`/api/orders/${id}/cancel`, {});
  assert.equal(noConf.status, 409);
  assert.equal(noConf.json.error.code, 'HUMAN_NOT_CONFIRMED');
  const c = await api.post(`/api/orders/${id}/cancel`, { confirm: true });
  assert.equal(c.status, 200, c.text);
  assert.equal(c.json.order.status, 'cancelled');
  const again = await api.post(`/api/orders/${id}/cancel`, { confirm: true });
  assert.equal(again.status, 409);
  assert.equal(again.json.error.code, 'ORDER_NOT_CANCELLABLE');
  assert.equal((await api.post('/api/orders/ord_doesnotexist/cancel', { confirm: true })).status, 404);
});

test('the stop of a pending bracket child can be edited before its entry fills (no_short is not applicable yet)', async () => {
  const br = await api.post('/api/orders', { ...buy({ order_type: 'limit', limit_px_u: 2500, qty: 10, attach: { stop_loss_px_u: 2000 } }), confirm: true });
  assert.equal(br.status, 201, br.text);
  const child = t.db.prepare("SELECT id, status FROM orders WHERE parent_id = ? AND role = 'stop_loss'").get(br.json.order.id);
  assert.equal(child.status, 'pending_parent');
  const rep = await api.post(`/api/orders/${child.id}/replace`, { stop_px_u: 2100, confirm: true });
  assert.equal(rep.status, 200, rep.text);
  assert.equal(rep.json.order.stop_px, 2100);
  assert.equal(rep.json.checks.find((c) => c.rule === 'no_short').applicable, false);
  assert.equal((await api.post(`/api/orders/${br.json.order.id}/cancel`, { confirm: true })).status, 200);
});

test('a replace that adds buy exposure is refused (entry rules do not run for modifies); the order is unchanged and the attempt journaled', async () => {
  const lim = await api.post('/api/orders', { ...buy({ order_type: 'limit', limit_px_u: 2500, qty: 10 }), confirm: true });
  assert.equal(lim.status, 201, lim.text);
  const id = lim.json.order.id;
  for (const terms of [{ limit_px_u: 2600 }, { qty: 4800 }, { qty: 11, limit_px_u: 2400 }]) {
    const r = await api.post(`/api/orders/${id}/replace`, { ...terms, confirm: true });
    assert.equal(r.status, 409, r.text);
    assert.equal(r.json.error.code, 'REPLACE_INCREASES_BUY_EXPOSURE');
  }
  const o = t.db.prepare('SELECT qty, limit_px, status FROM orders WHERE id = ?').get(id);
  assert.deepEqual({ ...o }, { qty: 10, limit_px: 2500, status: 'working' });
  const rows = t.db.prepare("SELECT payload_json FROM journal WHERE type = 'ORDER_REJECTED' AND ref_id = ?").all(id).map((r) => JSON.parse(r.payload_json));
  assert.equal(rows.length, 3);
  assert.ok(rows.every((p) => p.code === 'REPLACE_INCREASES_BUY_EXPOSURE' && p.request.sha256));
  assert.equal((await api.post(`/api/orders/${id}/cancel`, { confirm: true })).status, 200);
});

test('sandbox orders: unknown portfolio -> 404, time exits refused, future evidence denied, segment cost model recorded', async () => {
  const unknown = await api.post('/api/orders', { ...buy(), portfolio_id: 'sandbx', confirm: true });
  assert.equal(unknown.status, 404, unknown.text);
  assert.equal(unknown.json.error.code, 'PORTFOLIO_NOT_FOUND');
  assert.equal(t.db.prepare("SELECT COUNT(*) n FROM intents WHERE portfolio_id = 'sandbx'").get().n, 0, 'no intent row for a portfolio that does not exist');
  const optUnknown = await api.post('/api/options/orders', {
    portfolio_id: 'nope', contract: { occ: 'TFXA991218P00000500', underlying: 'TFXA', expiry: '2099-12-18', strike_u: 5000, right: 'P', multiplier: 100 }, contracts: 1, limit_px_u: 100, confirm: true,
  });
  assert.equal(optUnknown.status, 404);

  const te = await api.post('/api/orders', { ...buy({ attach: { time_exit_min: 2 } }), confirm: true });
  assert.equal(te.status, 400, te.text);
  assert.equal(te.json.error.code, 'TIME_EXIT_NOT_SUPPORTED');
  const teRow = t.db.prepare("SELECT payload_json FROM journal WHERE type = 'ORDER_REJECTED' ORDER BY seq DESC LIMIT 1").get();
  assert.equal(JSON.parse(teRow.payload_json).code, 'TIME_EXIT_NOT_SUPPORTED');

  const clock = (await api.get('/api/status')).json.replay.clock;
  // TEST FIXTURE refs: the minute starting at the clock is not complete until clock + 60 s.
  const future = await api.post('/api/orders', { ...buy({ evidence_refs: [`iex-m1:${FIX_DS}:${SYM}:${clock}`] }), confirm: true });
  assert.equal(future.status, 409, future.text);
  assert.ok(future.json.reasons.some((r) => r.code === 'EVIDENCE_FROM_FUTURE'), JSON.stringify(future.json.reasons));
  const past = await api.post('/api/orders', { ...buy({ order_type: 'limit', limit_px_u: 2500, qty: 10, evidence_refs: [`iex-m1:${FIX_DS}:${SYM}:${clock - MINUTE}`] }), confirm: true });
  assert.equal(past.status, 201, past.text);
  assert.ok(past.json.checks.some((c) => c.rule === 'evidence_not_future' && c.pass && /1\/1 evidence refs resolved/.test(c.detail)));
  assert.equal(past.json.order.meta.cost_segment, 'micro');
  assert.equal(past.json.order.meta.gate_estimate.priceU, 2500);
  assert.equal((await api.post(`/api/orders/${past.json.order.id}/cancel`, { confirm: true })).status, 200);

  // A symbol on the configured large-cap list is gated with the large-cap cost model (same rule as the Lab estimate).
  const prev = process.env.VECTOR_LARGECAP_LIST;
  process.env.VECTOR_LARGECAP_LIST = SYM; // TEST FIXTURE list
  try {
    const large = await api.post('/api/orders', { ...buy({ order_type: 'limit', limit_px_u: 2500, qty: 10 }), confirm: true });
    assert.equal(large.status, 201, large.text);
    assert.equal(large.json.order.meta.cost_segment, 'large');
    const mkt = await api.post('/api/orders', { ...buy({ qty: 10 }), confirm: true });
    assert.equal(mkt.status, 201, mkt.text);
    const { defaultCostModel } = await import('../../server/sim/fills.js');
    assert.equal(mkt.json.estimate.slippageBps, defaultCostModel('large').slippageBps);
    for (const o of [large, mkt]) assert.equal((await api.post(`/api/orders/${o.json.order.id}/cancel`, { confirm: true })).status, 200);
  } finally {
    if (prev === undefined) delete process.env.VECTOR_LARGECAP_LIST; else process.env.VECTOR_LARGECAP_LIST = prev;
  }
  const sbx = (await api.get('/api/portfolios/sandbox')).json;
  assert.ok(sbx.costModels.micro && sbx.costModels.large);
});

test('refused order bodies are journaled as a bounded summary, never verbatim', async () => {
  const junk = Array.from({ length: 300 }, (_, i) => `TEST-FIXTURE-REF-${i}-${'x'.repeat(180)}`);
  const r = await api.post('/api/orders', { ...buy({ qty: 1.5, evidence_refs: junk }), confirm: true });
  assert.equal(r.status, 400, r.text);
  const row = t.db.prepare("SELECT payload_json FROM journal WHERE type = 'ORDER_REJECTED' ORDER BY seq DESC LIMIT 1").get();
  assert.ok(row.payload_json.length < 5000, `journal row is bounded (${row.payload_json.length} chars)`);
  const p = JSON.parse(row.payload_json);
  assert.equal(p.code, 'INTENT_INVALID');
  assert.match(p.request.sha256, /^[0-9a-f]{64}$/);
  assert.ok(p.request.bytes > 50_000);
  assert.ok(!row.payload_json.includes('TEST-FIXTURE-REF-299'));
});


test('kill switch: engage stops agents, refuses starts and new orders; release keeps agents STOPPED until started', async () => {
  assert.equal((await api.post('/api/agents/agent-cowboy-micro/start', {})).status, 200);
  const pending = await api.post('/api/orders', { ...buy({ order_type: 'limit', limit_px_u: 2500, qty: 10 }), confirm: true });
  assert.equal(pending.status, 201);
  const k = await api.post('/api/kill', { protective_policy: 'KEEP_PROTECTIVE', reason: 'TEST FIXTURE drill' });
  assert.equal(k.status, 200, k.text);
  assert.equal(k.json.kill.engaged, true);
  assert.ok(k.json.cancelled.includes(pending.json.order.id), 'pending non-protective orders are cancelled');
  assert.equal(k.json.agentsStopped.length, 6);
  const st = (await api.get('/api/status')).json;
  assert.equal(st.kill.engaged, true);
  assert.ok(st.agents.every((a) => a.state === 'STOPPED'));
  const refused = await api.post('/api/agents/agent-cowboy-micro/start', {});
  assert.equal(refused.status, 409);
  assert.equal(refused.json.error.code, 'KILL_SWITCH_ENGAGED');
  const order = await api.post('/api/orders', { ...buy(), confirm: true });
  assert.equal(order.status, 409);
  assert.equal(order.json.error.code, 'KILL_SWITCH_ENGAGED');
  const rel = await api.post('/api/kill/release', {});
  assert.equal(rel.status, 200);
  assert.equal(rel.json.kill.engaged, false);
  assert.ok((await api.get('/api/agents')).json.rows.every((a) => a.state === 'STOPPED'));
  const start = await api.post('/api/agents/agent-cowboy-micro/start', {});
  assert.equal(start.status, 200);
  assert.equal(start.json.agent.state, 'RUNNING');
  const pause = await api.post('/api/agents/agent-cowboy-micro/pause', {});
  assert.equal(pause.json.agent.state, 'PAUSED');
});

test('a sandbox sell stop is a protective stop_loss: KEEP_PROTECTIVE keeps it, CANCEL_ALL cancels it', async () => {
  const b = await api.post('/api/orders', { ...buy({ qty: 100 }), confirm: true });
  assert.equal(b.status, 201, b.text);
  assert.equal((await api.post('/api/replay/step', { minutes: 1 })).json.fills, 1);
  const stop = await api.post('/api/orders', { action: 'close', instrument: { kind: 'equity', sym: SYM }, side: 'sell', order_type: 'stop', stop_px_u: 4000, qty: 100, confirm: true });
  assert.equal(stop.status, 201, stop.text);
  assert.equal(stop.json.order.role, 'stop_loss');
  assert.equal(stop.json.order.protective, true);
  const exit = await api.post('/api/orders', { action: 'close', instrument: { kind: 'equity', sym: SYM }, side: 'sell', order_type: 'limit', limit_px_u: 9000, qty: 100, confirm: true });
  assert.equal(exit.status, 201, exit.text);
  assert.equal(exit.json.order.role, 'exit');
  const k = await api.post('/api/kill', { protective_policy: 'KEEP_PROTECTIVE', reason: 'TEST FIXTURE drill' });
  assert.equal(k.status, 200, k.text);
  assert.ok(k.json.keptProtective.includes(stop.json.order.id), 'the human stop-loss keeps working');
  assert.ok(k.json.cancelled.includes(exit.json.order.id), 'a plain exit limit is not protective');
  assert.equal((await api.post('/api/kill/release', {})).status, 200);
  const k2 = await api.post('/api/kill', { protective_policy: 'CANCEL_ALL', reason: 'TEST FIXTURE drill' });
  assert.equal(k2.status, 200, k2.text);
  assert.ok(k2.json.cancelled.includes(stop.json.order.id));
  assert.equal((await api.post('/api/kill/release', {})).status, 200);
  const sell = await api.post('/api/orders', { action: 'close', instrument: { kind: 'equity', sym: SYM }, side: 'sell', order_type: 'market', qty: 100, confirm: true });
  assert.equal(sell.status, 201, sell.text);
  await api.post('/api/replay/step', { minutes: 1 });
  assert.equal((await api.get('/api/portfolios/sandbox')).json.positions.length, 0);
});

test('strategy update is validated and journaled; presets are exposed with the exploratory label', async () => {
  const a = (await api.get('/api/agents')).json;
  assert.equal(a.label, 'EXPLORATORY DEFAULTS — NOT VALIDATED');
  const hw = a.presets['handwritten-notes-example'];
  assert.equal(hw.segment, 'micro');
  const ok = await api.put('/api/agents/agent-tightwad-micro/strategy', { strategy: hw });
  assert.equal(ok.status, 200, ok.text);
  assert.equal(ok.json.agent.strategy.id, 'handwritten-notes-example');
  const mismatch = await api.put('/api/agents/agent-tightwad-large/strategy', { strategy: hw });
  assert.equal(mismatch.status, 422);
  assert.equal(mismatch.json.error.code, 'STRATEGY_SEGMENT_MISMATCH');
  assert.ok(t.db.prepare("SELECT COUNT(*) n FROM journal WHERE type = 'STRATEGY_CHANGED'").get().n >= 1);
});

test('as-of views never show minutes beyond the replay clock', async () => {
  const s = (await api.get('/api/status')).json;
  const bars = (await api.get(`/api/market/bars?sym=${SYM}`)).json;
  assert.equal(bars.status, 'HISTORICAL_REAL');
  assert.ok(bars.rows.length > 0);
  assert.ok(bars.rows.every((r) => r.t + MINUTE <= s.replay.clock), 'every bar complete at the clock');
  assert.ok(bars.quote.quoteTs <= s.replay.clock);
  const opp = (await api.get('/api/research/opportunities?segment=micro')).json;
  assert.equal(opp.label, 'SIGNAL METRICS — NOT RECOMMENDATIONS');
  assert.equal(opp.asOf, s.replay.clock);
  assert.ok(opp.rows.some((r) => r.sym === SYM));
  const uni = (await api.get('/api/market/universe?segment=micro')).json;
  assert.ok(uni.rows.every((r) => r.minuteT + MINUTE <= s.replay.clock));
  const d = (await api.get(`/api/research/dossier?sym=${SYM}`)).json;
  assert.equal(d.asOf, s.replay.clock);
  assert.ok(Array.isArray(d.unavailable));
  const bench = (await api.get('/api/market/benchmark')).json;
  assert.equal(bench.status, 'NO_VERIFIED_DATA'); // no benchmark ETF rows in the fixture: nothing plotted, nothing invented
  assert.ok(bench.series.every((x) => x.points.length === 0));
  const macro = (await api.get('/api/macro')).json;
  assert.equal(macro.status, 'NO_VERIFIED_DATA');
  const study = (await api.get('/api/research/study')).json;
  assert.equal(study.label, 'RETROSPECTIVE — uses data after each signal; never visible to agents');
});

test('replay play/pause runs server-side and refuses manual steps while playing', async () => {
  const before = (await api.get('/api/status')).json.replay.clock;
  const p = await api.post('/api/replay/play', { tick_wall_ms: 250 });
  assert.equal(p.status, 200, p.text);
  assert.equal(p.json.state.playing, true);
  const blocked = await api.post('/api/replay/step', { minutes: 1 });
  assert.equal(blocked.status, 409);
  assert.equal(blocked.json.error.code, 'REPLAY_PLAYING');
  await new Promise((r) => setTimeout(r, 900));
  const ps = await api.post('/api/replay/pause', {});
  assert.equal(ps.json.state.playing, false);
  const after = (await api.get('/api/status')).json.replay.clock;
  assert.ok(after > before, 'the clock advanced without any browser');
  assert.equal((await api.post('/api/replay/play', { tick_wall_ms: 10 })).status, 400);
});

test('journal returns rows newest-first with a verified hash chain and filters', async () => {
  const j = (await api.get('/api/journal?limit=50&portfolio_id=sandbox')).json;
  assert.equal(j.chain.ok, true);
  assert.ok(j.chain.checked > 10);
  assert.ok(j.rows.length > 0 && j.rows.every((r) => r.portfolio_id === 'sandbox'));
  assert.ok(j.rows[0].seq > j.rows.at(-1).seq);
  assert.equal(typeof j.rows[0].payload, 'object');
  const older = (await api.get(`/api/journal?limit=5&before=${j.rows.at(-1).seq}`)).json;
  assert.ok(older.rows.every((r) => r.seq < j.rows.at(-1).seq));
  const fills = (await api.get('/api/journal?type=FILL_ESTIMATED&session_id=current')).json;
  assert.ok(fills.rows.length >= 2 && fills.rows.every((r) => r.type === 'FILL_ESTIMATED'));
});

test('long puts are refused with NO_VERIFIED_OPTIONS_DATA (journaled through the gate); model actions need a connected model', async () => {
  const o = await api.post('/api/options/orders', {
    portfolio_id: 'sandbox', contract: { occ: 'TFXA991218P00000500', underlying: 'TFXA', expiry: '2099-12-18', strike_u: 5000, right: 'P', multiplier: 100 },
    contracts: 1, order_type: 'limit', limit_px_u: 100, confirm: true,
  });
  assert.equal(o.status, 409, o.text);
  assert.equal(o.json.error.code, 'NO_VERIFIED_OPTIONS_DATA');
  assert.ok(o.json.reasons.some((r) => r.code === 'NO_VERIFIED_OPTIONS_DATA'));
  assert.equal((await api.get('/api/options/status')).json.status, 'NO_VERIFIED_OPTIONS_DATA');
  const m = await api.post('/api/model/test', {});
  assert.equal(m.status, 409);
  assert.equal(m.json.error.code, 'MODEL_DISCONNECTED');
  const a = await api.post('/api/assessments/run', { sym: SYM });
  assert.equal(a.status, 409);
  assert.equal(a.json.error.code, 'MODEL_DISCONNECTED');
  const list = (await api.get(`/api/assessments?sym=${SYM}`)).json;
  assert.equal(list.status, 'ASSESSMENT_NOT_RUN');
});

test('assessments of other sessions (e.g. a smoke run) never appear in the live session; portfolios are labelled PAPER', async () => {
  // TEST FIXTURE row: an assessment stored by another session, knowable before the clock.
  t.db.prepare(`INSERT INTO assessments (id, session_id, sym, lens, provider, model, as_of, created_wall, evidence_ids_json, packet_sha256, status, output_json)
    VALUES ('asm_test_fixture_other', 'ses_test_fixture_other', ?, 'cowboy', 'TEST FIXTURE provider', 'TEST FIXTURE model', ?, ?, '[]', ?, 'OK', '{}')`)
    .run(SYM, at(9, 30), Date.now(), '0'.repeat(64));
  const list = (await api.get(`/api/assessments?sym=${SYM}`)).json;
  assert.equal(list.status, 'ASSESSMENT_NOT_RUN');
  assert.deepEqual(list.rows, []);
  assert.equal(list.scope, 'current replay session');
  const pf = (await api.get('/api/portfolios')).json;
  assert.equal(pf.status, 'PAPER');
  assert.equal(pf.marksStatus, 'HISTORICAL_REAL');
  assert.match(pf.label, /^PAPER PORTFOLIOS/);
  const macro = (await api.get('/api/macro')).json;
  assert.equal(macro.status, 'NO_VERIFIED_DATA');
});

test('CSV import stores IMPORTED_UNVERIFIED data and rejects files that fail checks', async () => {
  // TEST FIXTURE — NOT MARKET DATA: fictional symbol, invented prices, .invalid provider URL, a past date.
  const manifest = {
    provider: 'TEST FIXTURE provider', source_url: 'https://example.invalid/fixture.csv', licence: 'TEST FIXTURE', retrieved_at: '2021-03-02T00:00:00Z',
    timezone: 'UTC', timestamp_semantics: 'bar_start', symbol: 'TFXC', fields: { time: 'time', open: 'o', high: 'h', low: 'l', close: 'c', volume: 'v' },
  };
  const csv = 'time,o,h,l,c,v\n2021-03-01T15:00:00Z,1.00,1.10,0.90,1.05,100\n2021-03-01T15:01:00Z,1.05,1.06,1.00,1.01,200\n';
  const ok = await api.post('/api/import/csv', { manifest, csv });
  assert.equal(ok.status, 201, ok.text);
  assert.equal(ok.json.status, 'IMPORTED_UNVERIFIED');
  assert.equal(ok.json.rows, 2);
  const bad = await api.post('/api/import/csv', { manifest, csv: 'time,o,h,l,c,v\n2021-03-01T15:00:00Z,1.00,0.50,0.90,1.05,100\n' });
  assert.equal(bad.status, 422);
  assert.equal(bad.json.error.code, 'IMPORT_REJECTED');
  // The same bytes again: identical manifest -> 200-class no-op; a different manifest -> 409 ALREADY_IMPORTED (provenance kept).
  const same = await api.post('/api/import/csv', { manifest, csv });
  assert.equal(same.status, 201, same.text);
  assert.equal(same.json.alreadyImported, true);
  const relabel = await api.post('/api/import/csv', { manifest: { ...manifest, provider: 'TEST FIXTURE other provider' }, csv });
  assert.equal(relabel.status, 409, relabel.text);
  assert.equal(relabel.json.error.code, 'ALREADY_IMPORTED');
  const src = (await api.get('/api/sources')).json.find((x) => x.id === 'csv-import');
  assert.equal(src.status, 'IMPORTED_UNVERIFIED');
});

test('restart: RUNNING agents come back PAUSED (authority not implicitly resumed) and the clock persists', async () => {
  assert.equal((await api.post('/api/agents/agent-pragmatist-large/start', {})).status, 200);
  const clock = (await api.get('/api/status')).json.replay.clock;
  await srv.close();
  srv = await startTestServer(t.db);
  api = srv.client;
  const s = (await api.get('/api/status')).json;
  assert.equal(s.replay.clock, clock);
  const a = s.agents.find((x) => x.id === 'agent-pragmatist-large');
  assert.equal(a.state, 'PAUSED');
  assert.equal(a.state_reason, 'authority not implicitly resumed after restart');
  assert.deepEqual(srv.bootSummary.pausedAgentsOnBoot, ['agent-pragmatist-large']);
  assert.equal(srv.bootSummary.initialReset, null, 'an existing session is kept, not reset');
});
