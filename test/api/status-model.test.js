// TEST FIXTURE — NOT MARKET DATA. GET /api/status additions: model.kind (incl. 'ollama'), model.running / inFlight /
// lastAssessmentRun while a human assessment run, a model test or an agent lens call is in flight (with as-of visibility
// across resets), replay coverage (complete / coverage_end / truncated) for complete and partial datasets, the async
// assessment mode, and the per-call agent assessor. The model is an in-process MOCK whose answers the test releases one
// call at a time.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { tempDb, seedFixture, startTestServer, FIX_DS, SYM, at, MINUTE } from './helpers.js';
import { makeMockProvider, lensOf, lensOutput, okResult } from '../intel/helpers.js';
import { buildEvidencePacket } from '../../server/intel/assessments.js';
import { providerKind, endpointFamily } from '../../server/api/context.js';
import { createAgentAssessor } from '../../server/index.js';
import { fmtEt } from '../../server/util/time.js';

let t;
let srv;
let api;
let mock;
const waiting = []; // resolvers of model calls held by the test
let holdCalls = true;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, what, tries = 400) {
  for (let i = 0; i < tries; i++) {
    const v = await fn();
    if (v) return v;
    await sleep(5);
  }
  throw new Error(`timed out waiting for ${what}`);
}
/** Release the oldest held model call. */
async function releaseOne() {
  await until(() => waiting.length > 0, 'a held model call');
  waiting.shift()();
}

function answer(req, db) {
  const lens = lensOf(req.system);
  if (!lens) return okResult({ ok: true, note: 'TEST MOCK connectivity' });
  const clock = db.prepare('SELECT clock FROM replay_state WHERE id = 1').get().clock;
  const ids = buildEvidencePacket(db, FIX_DS, SYM, clock, { persist: false }).evidenceIds;
  return okResult(lensOutput(lens, ids, { stance: 'watch' }));
}

before(async () => {
  t = tempDb('status-model');
  seedFixture(t.db);
  mock = makeMockProvider(async (req) => {
    const out = answer(req, t.db);
    if (holdCalls) await new Promise((r) => waiting.push(r));
    return out;
  });
  srv = await startTestServer(t.db, {}, { provider: mock });
  api = srv.client;
});
after(async () => {
  holdCalls = false;
  while (waiting.length) waiting.shift()();
  await srv?.close();
  t?.cleanup();
});

const status = async () => (await api.get('/api/status')).json;

test('providerKind names the adapter that makes the calls; endpointFamily flags an Ollama server behind the /v1 adapter', () => {
  // model.kind is never rewritten: the native adapter sets num_ctx per request, the /v1 adapter cannot.
  assert.equal(providerKind({ kind: 'openai-compatible', endpointLabel: 'http://127.0.0.1:11434/v1' }), 'openai-compatible');
  assert.equal(endpointFamily({ kind: 'openai-compatible', endpointLabel: 'http://127.0.0.1:11434/v1' }), 'ollama');
  assert.equal(providerKind({ kind: 'openai-compatible', endpointLabel: 'http://localhost:1234/v1' }), 'openai-compatible');
  assert.equal(endpointFamily({ kind: 'openai-compatible', endpointLabel: 'http://localhost:1234/v1' }), null);
  assert.equal(endpointFamily({ kind: 'openai-compatible', endpointLabel: 'not a url' }), null);
  assert.equal(providerKind({ kind: 'ollama' }), 'ollama');
  assert.equal(endpointFamily({ kind: 'ollama' }), 'ollama');
  assert.equal(providerKind({ kind: 'anthropic' }), 'anthropic');
  assert.equal(endpointFamily({ kind: 'anthropic' }), null);
  assert.equal(providerKind({ kind: 'none' }), 'none');
  assert.equal(providerKind(null), 'none');
  assert.equal(endpointFamily(null), null);
});

test('status: model kind, nothing running at rest, and coverage of a complete dataset', async () => {
  const s = await status();
  assert.equal(s.model.status, 'CONNECTED');
  assert.equal(s.model.kind, 'mock');
  assert.equal(s.model.running, false);
  assert.deepEqual(s.model.inFlight, { assessment: null, modelTest: null, agentCalls: 0 });
  assert.equal(s.model.lastAssessmentRun, null);
  assert.equal(s.replay.complete, true);
  assert.equal(s.replay.coverage_end, null);
  assert.equal(s.replay.truncated, false);
  assert.equal(s.replay.beyondCoverage, false);
  assert.equal(s.data.dataset.complete, true);
  assert.equal(s.data.dataset.coverage_end, null);
  assert.doesNotMatch(s.data.modeDetail, /PARTIAL/);
});

test('async assessment run: 202 at once, progress lens by lens in /api/status, outcome in lastAssessmentRun', async () => {
  const r = await api.post('/api/assessments/run', { sym: SYM, confirm: true, async: true });
  assert.equal(r.status, 202, r.text);
  assert.equal(r.json.decision, 'ACCEPTED');
  assert.equal(r.json.status, 'RUNNING');
  assert.match(r.json.run_id, /^arun_/);
  const s0 = await status();
  assert.equal(s0.model.running, true);
  assert.equal(s0.model.inFlight.assessment.run_id, r.json.run_id);
  assert.equal(s0.model.inFlight.assessment.sym, SYM);
  assert.equal(s0.model.inFlight.assessment.asOf, s0.replay.clock);
  assert.equal(s0.model.inFlight.assessment.mode, 'async');
  assert.equal(s0.model.inFlight.assessment.lensesTotal, 3);
  assert.equal(s0.model.inFlight.assessment.lensesDone, 0);
  assert.equal((await api.get('/api/model')).json.running, true, '/api/model shows the same activity');
  const busy = await api.post('/api/assessments/run', { sym: SYM, confirm: true });
  assert.equal(busy.status, 429);
  assert.equal(busy.json.error.code, 'ASSESSMENT_BUSY');

  await releaseOne();
  await until(async () => (await status()).model.inFlight.assessment?.lensesDone === 1, 'lens 1 stored');
  assert.equal((await api.get(`/api/assessments?sym=${SYM}`)).json.rows.length, 1, 'each lens is readable as soon as it is stored');
  await releaseOne();
  await releaseOne();
  const done = await until(async () => { const s = await status(); return s.model.running ? null : s; }, 'run finished');
  assert.equal(done.model.inFlight.assessment, null);
  const last = done.model.lastAssessmentRun;
  assert.equal(last.run_id, r.json.run_id);
  assert.equal(last.status, 'COMPLETED');
  assert.deepEqual(Object.keys(last.stances).sort(), ['cowboy', 'pragmatist', 'tightwad']);
  assert.equal(last.assessment_ids.length, 3);
  assert.equal(last.decision, 'OK');
  assert.deepEqual(last.lensErrorKinds, { cowboy: null, pragmatist: null, tightwad: null });
  assert.ok(last.finishedAt >= last.startedAt);
  assert.equal((await api.get(`/api/assessments?sym=${SYM}`)).json.rows.length, 3);
  assert.equal(srv.ctx.busy.assess, false);
});

test('synchronous run (default) answers when done; status shows it running meanwhile', async () => {
  const pending = api.post('/api/assessments/run', { sym: SYM, confirm: true });
  const s = await until(async () => { const x = await status(); return x.model.inFlight.assessment ? x : null; }, 'sync run visible');
  assert.equal(s.model.running, true);
  assert.equal(s.model.inFlight.assessment.mode, 'sync');
  for (let i = 0; i < 3; i++) await releaseOne();
  const r = await pending;
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.status, 'COMPLETED');
  assert.equal(r.json.results.length, 3);
  assert.equal(r.json.decision, 'OK');
  assert.ok(r.json.results.every((x) => 'errorKind' in x && x.errorKind === null), 'per-lens errorKind is passed through');
  assert.equal((await status()).model.lastAssessmentRun.mode, 'sync');
});

test('a model test in flight is shown as running', async () => {
  srv.ctx.lastModelTestWall = 0; // test-only: skip the 10 s rate limit
  const pending = api.post('/api/model/test', { confirm: true });
  const s = await until(async () => { const x = await status(); return x.model.inFlight.modelTest ? x : null; }, 'model test visible');
  assert.equal(s.model.running, true);
  await releaseOne();
  assert.equal((await pending).status, 200);
  assert.equal((await status()).model.inFlight.modelTest, null);
});

test('after a reset, a previous session\'s run is shown without its symbol, as-of or outcome', async () => {
  const r = await api.post('/api/assessments/run', { sym: SYM, confirm: true, async: true });
  assert.equal(r.status, 202, r.text);
  const reset = await api.post('/api/replay/reset', {});
  assert.equal(reset.status, 200, reset.text);
  const s = await status();
  assert.equal(s.model.running, true);
  assert.equal(s.model.inFlight.assessment.previousSession, true);
  assert.ok(!('sym' in s.model.inFlight.assessment) && !('asOf' in s.model.inFlight.assessment));
  for (let i = 0; i < 3; i++) await releaseOne();
  const done = await until(async () => { const x = await status(); return x.model.running ? null : x; }, 'previous-session run finished');
  assert.equal(done.model.lastAssessmentRun, null, 'the outcome belongs to the previous session');
  assert.equal(srv.ctx.lastAssessmentRun.status, 'COMPLETED');
});

test('the agent assessor resolves the provider per call and counts calls in flight', async () => {
  let current = { id: 'none', kind: 'none', model: null };
  const ctx = { db: t.db, provider: () => current, modelRuns: { assessment: null, modelTest: null, agentCalls: 0 } };
  const { assess, model } = createAgentAssessor(ctx);
  assert.equal(model.status, 'DISCONNECTED', 'no provider: model-mode agents are blocked before any call');
  const st = (await status()).replay;
  const opts = { ds: st.ds, clock: st.clock, session_id: st.session_id };
  assert.equal((await assess(SYM, 'cowboy', opts)).status, 'MODEL_DISCONNECTED');
  // The provider is configured after boot (e.g. the model config file changed): the next call uses it.
  current = mock;
  assert.equal(model.status, 'CONFIGURED');
  const before = mock.calls.length;
  const pending = assess(SYM, 'cowboy', opts);
  await until(() => ctx.modelRuns.agentCalls === 1 && waiting.length > 0, 'agent call in flight');
  await releaseOne();
  const r = await pending;
  assert.equal(r.status, 'OK', JSON.stringify(r).slice(0, 300));
  assert.equal(mock.calls.length - before, 1);
  assert.equal(ctx.modelRuns.agentCalls, 0);
  // And removed again: back to MODEL_DISCONNECTED without a restart.
  current = { id: 'none', kind: 'none', model: null };
  assert.equal(model.status, 'DISCONNECTED');
  assert.equal((await assess(SYM, 'cowboy', opts)).status, 'MODEL_DISCONNECTED');
});

test('partial dataset: complete:false, coverage_end and a PARTIAL mode detail; truncated follows the session end', async () => {
  const p = tempDb('status-partial');
  seedFixture(p.db);
  const end = at(10, 0);
  p.db.prepare("UPDATE datasets SET status = 'partial', ingested_at = ?, quality_json = ? WHERE id = ?")
    .run(Date.now() + 7, JSON.stringify({ label: 'TEST FIXTURE — NOT MARKET DATA', coverage_end_ms: end }), FIX_DS);
  const s2 = await startTestServer(p.db);
  try {
    const s = (await s2.client.get('/api/status')).json;
    assert.equal(s.data.mode, 'HISTORICAL_REAL');
    assert.equal(s.replay.complete, false);
    assert.equal(s.replay.coverage_end, end);
    assert.equal(s.data.dataset.complete, false);
    assert.equal(s.data.dataset.coverage_end, end);
    assert.equal(s.replay.truncated, s.replay.t_end < at(16, 0));
    assert.equal(s.replay.beyondCoverage, false);
    assert.equal(s.replay.session_close, at(16, 0));
    if (s.replay.truncated) {
      assert.equal(s.replay.t_end, end, 'the engine ends the replay at the coverage end');
      assert.match(s.replay.truncation_note, /DATASET_TRUNCATED/);
      assert.match(s.data.modeDetail, /the replay session is truncated there/);
    }
    assert.ok(s.data.modeDetail.includes(`PARTIAL dataset: stored data ends at ${fmtEt(end)}`), s.data.modeDetail);
    if (!s.replay.truncated) {
      // The engine does not truncate the session: once the clock passes the coverage end, the status says so.
      const step = await s2.client.post('/api/replay/step', { minutes: 31 });
      assert.equal(step.status, 200, step.text);
      const after = (await s2.client.get('/api/status')).json;
      assert.equal(after.replay.clock, end + MINUTE);
      assert.equal(after.replay.beyondCoverage, true);
    }
  } finally {
    await s2.close();
    p.cleanup();
  }
});
