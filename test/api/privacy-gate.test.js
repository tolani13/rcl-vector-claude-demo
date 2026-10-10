// TEST FIXTURE / MOCK — NOT REAL ACCOUNT DATA. (c) Privacy gate: an assessment that includes real-account data is
// refused with REAL_DATA_PRIVACY_BLOCK unless every lens's provider declares trains_on_prompts false - before anything
// real is read or any model is called. Also: the runner's own defence-in-depth check, and that an allowed (local) run
// carries the REAL_ACCOUNT context as non-evidence text and never derives a paper intent from it.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { tempDb, seedFixture, startTestServer, SYM } from './helpers.js';
import { makeModelFetch } from '../intel/preset-helpers.js';
import * as intel from '../intel/helpers.js';
import { runLensAssessments, listAssessments } from '../../server/intel/assessments.js';
import { resetPresetCaches } from '../../server/intel/providers/presets.js';

const KEYS = { VECTOR_GROQ_API_KEY: 'test-fixture-groq-key-000000', VECTOR_GEMINI_API_KEY: 'test-fixture-gemini-key-00000', VECTOR_OPENROUTER_API_KEY: 'test-fixture-openrouter-key-0' };
const cleanups = [];
after(async () => { for (const c of cleanups.reverse()) await c(); });

async function server(name, env) {
  resetPresetCaches();
  const t = tempDb(name);
  seedFixture(t.db);
  const mf = makeModelFetch();
  const s = await startTestServer(t.db, { ...KEYS, ...env }, { modelFetch: mf.fetchImpl });
  cleanups.push(async () => { await s.close(); t.cleanup(); });
  return { t, api: s.client, mf };
}

const run = (api) => api.post('/api/assessments/run', { sym: SYM, confirm: true, includeRealAccount: true });
const sentToModel = (mf) => mf.calls.filter((c) => /\/(chat\/completions|api\/chat)$/.test(c.path)).length;

for (const [label, env, expectBlocked] of [
  ['groq (trains_on_prompts unknown)', { VECTOR_MODEL_PRESET: 'groq' }, ['cowboy', 'pragmatist', 'tightwad']],
  ['gemini free (trains_on_prompts true)', { VECTOR_MODEL_PRESET: 'gemini-flash-free' }, ['cowboy', 'pragmatist', 'tightwad']],
  ['openrouter :free (unknown), pinned for all lenses', { VECTOR_MODEL_PRESET: 'openrouter-free', VECTOR_MODEL_PIN_ALL_LENSES: '1' }, ['cowboy', 'pragmatist', 'tightwad']],
  ['local default with ONE lens on groq', { VECTOR_MODEL_PRESET: 'ollama-local', VECTOR_MODEL_LENS_TIGHTWAD: 'groq' }, ['tightwad']],
]) {
  test(`(c) privacy gate: ${label} -> 403 REAL_DATA_PRIVACY_BLOCK, nothing sent`, async () => {
    const { api, mf, t } = await server('privacy', env);
    const journalBefore = t.db.prepare('SELECT COUNT(*) n FROM journal').get().n;
    const r = await run(api);
    assert.equal(r.status, 403, r.text);
    assert.equal(r.json.error.code, 'REAL_DATA_PRIVACY_BLOCK');
    assert.deepEqual(r.json.blocked.map((b) => b.lens), expectBlocked);
    assert.equal(sentToModel(mf), 0, 'no model call');
    assert.equal(t.db.prepare('SELECT COUNT(*) n FROM journal').get().n, journalBefore, 'refused before any run was journaled');
  });
}

test('(c) privacy gate passes for local presets (trains_on_prompts false) and for an owner-listed preset', async () => {
  const local = await server('privacy-local', { VECTOR_MODEL_PRESET: 'ollama-local' });
  const r = await run(local.api);
  assert.notEqual(r.status, 403, r.text);
  assert.equal(r.json.error.code, 'REAL_ACCOUNT_NOT_SYNCED', 'next check: no real sync yet');
  const listed = await server('privacy-listed', { VECTOR_MODEL_PRESET: 'groq', VECTOR_REAL_DATA_ALLOW_PRESETS: 'groq' });
  assert.equal((await run(listed.api)).json.error.code, 'REAL_ACCOUNT_NOT_SYNCED');
  // Real-context runs are synchronous only (their result is returned once and never stored for later listing).
  const bg = await local.api.post('/api/assessments/run', { sym: SYM, confirm: true, includeRealAccount: true, async: true });
  assert.equal(bg.status, 400);
  assert.equal(bg.json.error.code, 'REAL_CONTEXT_SYNC_ONLY');
  // Without includeRealAccount the gate does not apply (a normal assessment request on a free API preset).
  const normal = await listed.api.post('/api/assessments/run', { sym: SYM, confirm: false });
  assert.notEqual(normal.json?.error?.code, 'REAL_DATA_PRIVACY_BLOCK');
});

test('(c) defence in depth: runLensAssessments itself refuses real context for a provider without declared privacy', async () => {
  const t = intel.tempDb();
  try {
    intel.seedFixture(t.db);
    const mock = intel.makeMockProvider(() => { throw new Error('must not be called'); });
    const r = await runLensAssessments(t.db, mock, { ds: intel.FIX_DS, sym: intel.FIX_SYM, asOf: intel.FIX_ASOF, realAccountContext: 'REAL ACCOUNT — READ ONLY CONTEXT (TEST FIXTURE)' });
    assert.equal(r.status, 'BLOCKED');
    assert.equal(r.code, 'REAL_DATA_PRIVACY_BLOCK');
    assert.equal(mock.calls.length, 0);
  } finally { t.cleanup(); }
});

test('allowed (local) run: REAL_ACCOUNT context is appended as non-evidence text, and no intent draft is derived', async () => {
  const t = intel.tempDb();
  try {
    intel.seedFixture(t.db);
    const ctxText = 'REAL ACCOUNT — READ ONLY CONTEXT (data class REAL_ACCOUNT; TEST FIXTURE): the owner holds 3 units.';
    let packetIds = null;
    const mock = intel.makeMockProvider((req) => {
      const lens = intel.lensOf(req.system);
      packetIds ??= [...req.user.matchAll(/ev_[0-9a-f]{24}/g)].map((m) => m[0]);
      return intel.okResult(intel.lensOutput(lens, packetIds));
    });
    const local = Object.assign(Object.create(mock), { privacy: { trains_on_prompts: false, local: true } });
    const r = await runLensAssessments(t.db, local, {
      ds: intel.FIX_DS, sym: intel.FIX_SYM, asOf: intel.FIX_ASOF, realAccountContext: ctxText,
      providers: { cowboy: local, pragmatist: local, tightwad: local },
    });
    assert.equal(r.status, 'COMPLETED', JSON.stringify(r).slice(0, 300));
    assert.equal(r.realAccountContext, true);
    assert.equal(mock.calls.length, 3);
    for (const c of mock.calls) assert.ok(c.user.endsWith(ctxText), 'context appended after the packet');
    for (const x of r.results) assert.equal(x.intent.status, 'NONE', 'no paper intent from a real-context run');
    const ev = t.db.prepare("SELECT COUNT(*) n FROM evidence WHERE body_json LIKE '%REAL ACCOUNT%' OR title LIKE '%REAL ACCOUNT%'").get().n;
    assert.equal(ev, 0, 'real context never stored as evidence');
    const j = t.db.prepare("SELECT payload_json FROM journal WHERE type = 'MODEL_ASSESSMENT'").all().map((x) => JSON.parse(x.payload_json));
    assert.ok(j.length === 3 && j.every((p) => p.real_account_context === true));
    // Nothing the model wrote from real holdings is stored or listed: rows are flagged, text-free and hidden from paper views.
    assert.ok(j.every((p) => p.raw_excerpt === null && p.verification === null));
    const rows = t.db.prepare('SELECT output_json, real_ctx FROM assessments').all();
    assert.ok(rows.length === 3 && rows.every((x) => x.output_json === null && x.real_ctx === 1));
    assert.ok(r.results.every((x) => x.output && x.output.stance), 'the caller still receives the full result');
    assert.deepEqual(listAssessments(t.db, { sym: intel.FIX_SYM }), [], 'not listed by paper views');
    assert.equal(JSON.stringify(t.db.prepare("SELECT payload_json FROM journal WHERE type = 'MODEL_ASSESSMENT'").all()).includes('TEST MOCK thesis'), false);
  } finally { t.cleanup(); }
});
