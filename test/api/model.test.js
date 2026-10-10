// TEST FIXTURE — NOT MARKET DATA. API wiring for model-driven endpoints with an in-process MOCK provider (test-only;
// product code has no mock provider): connectivity test, three independent lens assessments, as-of listing.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { tempDb, seedFixture, startTestServer, FIX_DS, SYM, at } from './helpers.js';
import { makeMockProvider, lensOf, lensOutput, okResult } from '../intel/helpers.js';
import { buildEvidencePacket } from '../../server/intel/assessments.js';
import { LENS_OUTPUT_SCHEMA } from '../../server/intel/prompts.js';
import { TEST_SCHEMA } from '../../server/api/status.js';

let t;
let srv;
let api;
let mock;
let testNote = 'TEST MOCK connectivity';
const STANCE = { cowboy: 'consider_entry', pragmatist: 'watch', tightwad: 'avoid' };

before(async () => {
  t = tempDb('model');
  seedFixture(t.db);
  mock = makeMockProvider((req) => {
    const lens = lensOf(req.system);
    if (!lens) return okResult({ ok: true, note: testNote });
    const clock = t.db.prepare('SELECT clock FROM replay_state WHERE id = 1').get().clock;
    const ids = buildEvidencePacket(t.db, FIX_DS, SYM, clock, { persist: false }).evidenceIds;
    return okResult(lensOutput(lens, ids, { stance: STANCE[lens] }));
  });
  srv = await startTestServer(t.db, {}, { provider: mock });
  api = srv.client;
});
after(async () => { await srv?.close(); t?.cleanup(); });

// Keywords that Anthropic structured outputs (and several OpenAI-compatible servers) reject in provider-facing schemas.
const FORBIDDEN = ['minLength', 'maxLength', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf'];
function schemaProblems(schema, path = '$') {
  const out = [];
  if (!schema || typeof schema !== 'object') return out;
  if (Array.isArray(schema)) { schema.forEach((s, i) => out.push(...schemaProblems(s, `${path}[${i}]`))); return out; }
  for (const k of FORBIDDEN) if (k in schema) out.push(`${path}.${k}`);
  for (const k of ['minItems', 'maxItems']) if (k in schema && schema[k] > 1) out.push(`${path}.${k}=${schema[k]}`);
  if (schema.type === 'object' && schema.additionalProperties !== false) out.push(`${path}.additionalProperties must be false`);
  for (const [k, v] of Object.entries(schema)) if (v && typeof v === 'object') out.push(...schemaProblems(v, `${path}.${k}`));
  return out;
}

test('provider-facing schemas use no unsupported keywords (string length, numeric bounds, open objects)', () => {
  assert.deepEqual(schemaProblems(TEST_SCHEMA), []);
  assert.deepEqual(schemaProblems(LENS_OUTPUT_SCHEMA), []);
});

test('status reports the injected provider as CONNECTED and the agent assessor is wired at boot', async () => {
  const s = (await api.get('/api/status')).json;
  assert.equal(s.model.status, 'CONNECTED');
  assert.equal(srv.bootSummary.modelAssessorWired, true);
});

test('explicit model test requires confirm:true, makes one small request and is rate-limited', async () => {
  const unconfirmed = await api.post('/api/model/test', {});
  assert.equal(unconfirmed.status, 409);
  assert.equal(unconfirmed.json.error.code, 'CONFIRMATION_REQUIRED');
  assert.equal(mock.calls.length, 0, 'no provider call without confirmation');
  const r = await api.post('/api/model/test', { confirm: true });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.decision, 'OK');
  assert.equal(r.json.modelStatus, 'CONNECTED');
  assert.equal(mock.calls.length, 1);
  assert.deepEqual(schemaProblems(mock.calls[0].schema), [], 'the schema actually sent to the provider');
  const again = await api.post('/api/model/test', { confirm: true });
  assert.equal(again.status, 429);
  assert.equal(again.json.error.code, 'MODEL_TEST_RATE_LIMITED');
  const rows = t.db.prepare("SELECT payload_json FROM journal WHERE type = 'MODEL_TEST'").all();
  assert.equal(rows.length, 1);
  assert.equal(JSON.parse(rows[0].payload_json).confirmed, true);
});

test('model test enforces the note length after parsing (the schema itself carries no maxLength)', async () => {
  srv.ctx.lastModelTestWall = 0; // test-only: skip the 10 s rate limit
  testNote = 'x'.repeat(201);
  try {
    const r = await api.post('/api/model/test', { confirm: true });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.decision, 'FAILED');
    assert.equal(r.json.errorKind, 'INVALID_OUTPUT');
  } finally { testNote = 'TEST MOCK connectivity'; }
});

test('three-lens run: requires confirm, separate calls on one as-of packet, disagreement preserved, stored and listed as-of', async () => {
  const before = mock.calls.length;
  const unconfirmed = await api.post('/api/assessments/run', { sym: SYM });
  assert.equal(unconfirmed.status, 409);
  assert.equal(unconfirmed.json.error.code, 'CONFIRMATION_REQUIRED');
  assert.equal(mock.calls.length, before);
  const r = await api.post('/api/assessments/run', { sym: SYM, confirm: true });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.status, 'COMPLETED');
  assert.equal(mock.calls.length - before, 3);
  assert.deepEqual(r.json.stances, STANCE);
  assert.equal(new Set(r.json.results.map((x) => x.lens)).size, 3);
  const clock = (await api.get('/api/status')).json.replay.clock;
  assert.equal(r.json.asOf, clock);
  assert.equal(t.db.prepare("SELECT COUNT(*) n FROM journal WHERE type = 'ASSESSMENT_RUN_REQUESTED'").get().n, 1);
  // TEST FIXTURE row from another session (e.g. a smoke run): never listed in the live session.
  t.db.prepare(`INSERT INTO assessments (id, session_id, sym, lens, provider, model, as_of, created_wall, evidence_ids_json, packet_sha256, status, output_json)
    VALUES ('asm_test_fixture_smoke', 'smoke-test-fixture', ?, 'cowboy', 'TEST FIXTURE provider', 'TEST FIXTURE model', ?, ?, '[]', ?, 'OK', '{}')`)
    .run(SYM, at(9, 30), Date.now() + 60_000, '1'.repeat(64));
  const list = (await api.get(`/api/assessments?sym=${SYM}`)).json;
  assert.equal(list.status, 'STORED');
  assert.equal(list.rows.length, 3);
  assert.ok(list.rows.every((a) => a.as_of <= clock && a.status === 'OK' && a.session_id === list.session_id));
  assert.equal(t.db.prepare('SELECT COUNT(*) n FROM orders').get().n, 0, 'assessments never execute trades');
});

test('the rolling 24 h model-call budget is reported by GET /api/model and enforced on the model test', async () => {
  const m = (await api.get('/api/model')).json;
  assert.equal(typeof m.budget.cap, 'number');
  assert.equal(m.budget.remaining, Math.max(0, m.budget.cap - m.budget.used - m.budget.inflight));
  const before = mock.calls.length;
  const saved = mock.config.maxCallsPerDay;
  mock.config.maxCallsPerDay = 0;
  try {
    const r = await api.post('/api/model/test', { confirm: true });
    assert.equal(r.status, 429, r.text);
    assert.equal(r.json.error.code, 'CALL_CAP_REACHED');
    assert.equal(mock.calls.length, before, 'no request was sent');
  } finally {
    if (saved === undefined) delete mock.config.maxCallsPerDay; else mock.config.maxCallsPerDay = saved;
  }
});

test('GET /api/model: callsUsedThisSession is the number the cap enforces (audit-only rows excluded); setup lists the native Ollama provider', async () => {
  const st = (await api.get('/api/status')).json.replay;
  const m0 = (await api.get('/api/model')).json;
  // TEST FIXTURE audit rows of this session: a CONFIG (CONTEXT_OVERFLOW, never sent) and a CONNECT failure do not count;
  // a NETWORK failure (the body may have dropped after the model answered) does.
  const ins = t.db.prepare(`INSERT INTO assessments (id, session_id, sym, lens, provider, model, as_of, created_wall, evidence_ids_json, packet_sha256, status, output_json, error)
    VALUES (?, ?, ?, 'cowboy', 'TEST FIXTURE provider', 'TEST FIXTURE model', ?, ?, '[]', ?, 'ERROR', NULL, ?)`);
  ins.run('asm_test_fixture_cfg', st.session_id, SYM, st.clock, Date.now(), '2'.repeat(64), 'CONFIG: CONTEXT_OVERFLOW (TEST FIXTURE)');
  ins.run('asm_test_fixture_conn', st.session_id, SYM, st.clock, Date.now(), '3'.repeat(64), 'CONNECT: request failed: ECONNREFUSED (TEST FIXTURE)');
  ins.run('asm_test_fixture_net', st.session_id, SYM, st.clock, Date.now(), '4'.repeat(64), 'NETWORK: response body read failed (TEST FIXTURE)');
  const m1 = (await api.get('/api/model')).json;
  assert.equal(m1.callsUsedThisSession, m0.callsUsedThisSession + 1, 'only the NETWORK row counts');
  assert.equal(m1.auditRowsThisSession, m0.auditRowsThisSession + 3);
  assert.ok(m1.setup.some((s) => /VECTOR_MODEL_PROVIDER=ollama plus VECTOR_OLLAMA_MODEL/.test(s) && /options\.num_ctx/.test(s)));
  assert.equal(m1.endpointFamily, null);
  t.db.prepare("DELETE FROM assessments WHERE id IN ('asm_test_fixture_cfg', 'asm_test_fixture_conn', 'asm_test_fixture_net')").run();
});
