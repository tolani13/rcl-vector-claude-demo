// TEST FIXTURE / MOCK. Model presets through the API: POST /api/model/test for EACH preset (existing route, mock model
// endpoints, no network), the $0 guard and missing-key BLOCKED answers, the per-lens selection with the experiment pin,
// and key presence (never values) in GET /api/model/presets and GET /api/model.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { tempDb, seedFixture, startTestServer } from './helpers.js';
import { makeModelFetch } from '../intel/preset-helpers.js';
import { resetPresetCaches } from '../../server/intel/providers/presets.js';

const KEYS = { VECTOR_GROQ_API_KEY: 'test-fixture-groq-key-000000', VECTOR_OPENROUTER_API_KEY: 'test-fixture-openrouter-key-0', VECTOR_GEMINI_API_KEY: 'test-fixture-gemini-key-00000' };
const MODELS = ['qwen3:8b', 'lm-fixture', 'openai/gpt-oss-20b', 'openai/gpt-oss-20b:free', 'gemini-3.8-flash'];
const cleanups = [];
after(async () => { for (const c of cleanups.reverse()) await c(); });

async function server(name, env = {}) {
  resetPresetCaches();
  const t = tempDb(name);
  seedFixture(t.db);
  const mf = makeModelFetch({ models: MODELS });
  const s = await startTestServer(t.db, env, { modelFetch: mf.fetchImpl });
  cleanups.push(async () => { await s.close(); t.cleanup(); });
  return { t, s, api: s.client, mf };
}

for (const [preset, model] of [['ollama-local', null], ['lmstudio-local', 'lm-fixture'], ['groq', null], ['openrouter-free', null], ['gemini-flash-free', null]]) {
  test(`POST /api/model/test {preset: ${preset}} -> OK with the model name, journaled, $0 preset`, async () => {
    const { api, t, mf } = await server(`preset-${preset}`, KEYS);
    const body = { preset, ...(model ? { model } : {}) };
    assert.equal((await api.post('/api/model/test', body)).json.error.code, 'CONFIRMATION_REQUIRED');
    const r = await api.post('/api/model/test', { ...body, confirm: true });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.decision, 'OK');
    assert.equal(r.json.preset, preset);
    assert.ok(r.json.model, 'model name reported');
    assert.equal(mf.calls.filter((c) => /\/(chat\/completions|api\/chat)$/.test(c.path)).length, 1, 'exactly one request');
    const j = t.db.prepare("SELECT payload_json FROM journal WHERE type = 'MODEL_TEST'").all();
    assert.equal(j.length, 1);
    assert.equal(t.db.prepare('SELECT COUNT(*) n FROM model_preset_calls WHERE preset_id = ?').get(preset).n, 1, 'counted against the local limit');
  });
}

test('POST /api/model/test: a paid preset is BLOCKED by the $0 guard; a free API preset without its key is BLOCKED: NO_API_KEY', async () => {
  const { api, mf } = await server('preset-blocked', { ANTHROPIC_API_KEY: 'test-fixture-anthropic-key-0' });
  const paid = await api.post('/api/model/test', { preset: 'anthropic', confirm: true });
  assert.equal(paid.status, 409);
  assert.equal(paid.json.error.code, 'PAID_PROVIDER_BLOCKED');
  assert.match(paid.json.error.message, /BLOCKED: PAID_PROVIDER_BLOCKED .*VECTOR_ALLOW_PAID=1/);
  const nokey = await api.post('/api/model/test', { preset: 'groq', confirm: true });
  assert.equal(nokey.status, 409);
  assert.equal(nokey.json.error.code, 'NO_API_KEY');
  assert.match(nokey.json.error.message, /VECTOR_GROQ_API_KEY/);
  assert.equal((await api.post('/api/model/test', { preset: 'nope', confirm: true })).json.error.code, 'PRESET_UNKNOWN');
  assert.equal(mf.calls.length, 0, 'nothing was sent');
});

test('legacy VECTOR_MODEL_PROVIDER=anthropic is BLOCKED by the $0 guard at the server boundary', async () => {
  const { api } = await server('preset-legacy-paid', { VECTOR_MODEL_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'test-fixture-anthropic-key-0' });
  const m = await api.get('/api/model');
  assert.equal(m.json.status, 'FAULT');
  assert.equal(m.json.blocked, 'PAID_PROVIDER_BLOCKED');
  assert.equal((await api.post('/api/model/test', { confirm: true })).json.error.code, 'PAID_PROVIDER_BLOCKED');
});

test('selection: PUT saves per-lens choices and the experiment pin; GET reflects it; keys are presence flags only', async () => {
  const { api, t } = await server('preset-selection', KEYS);
  const cat = await api.get('/api/model/presets');
  assert.equal(cat.status, 200);
  assert.deepEqual(cat.json.catalog.errors, []);
  assert.equal(cat.json.defaultPreset, 'ollama-local');
  assert.equal(cat.json.selection.source, 'legacy');
  const groq = cat.json.presets.find((p) => p.id === 'groq');
  assert.equal(groq.key_present, true);
  assert.equal(groq.cost, 'free');
  for (const v of Object.values(KEYS)) assert.ok(!cat.text.includes(v), 'no key value in the response');

  const mixed = await api.put('/api/model/selection', { default: { preset: 'ollama-local', model: 'qwen3:8b' }, lenses: { tightwad: { preset: 'groq' } }, pinAllLenses: false });
  assert.equal(mixed.status, 200, mixed.text);
  assert.equal(mixed.json.selection.lenses.tightwad.preset, 'groq');
  assert.equal(mixed.json.selection.lenses.cowboy.preset, 'ollama-local');
  assert.equal(mixed.json.selection.sameModelAllLenses, false);

  const pinned = await api.put('/api/model/selection', { default: { preset: 'ollama-local', model: 'qwen3:8b' }, lenses: { tightwad: { preset: 'groq' } }, pinAllLenses: true });
  assert.equal(pinned.json.selection.pinAllLenses, true);
  assert.equal(pinned.json.selection.sameModelAllLenses, true);
  for (const l of ['cowboy', 'pragmatist', 'tightwad']) {
    assert.equal(pinned.json.selection.lenses[l].preset, 'ollama-local');
    assert.equal(pinned.json.selection.lenses[l].model, 'qwen3:8b');
    assert.equal(pinned.json.selection.lenses[l].training_cutoff, '2025-04-29');
    assert.equal(pinned.json.selection.lenses[l].trains_on_prompts, false);
  }
  const model = await api.get('/api/model');
  assert.equal(model.json.preset, 'ollama-local');
  assert.equal(model.json.selection.source, 'stored');
  assert.equal(t.db.prepare("SELECT COUNT(*) n FROM journal WHERE type = 'MODEL_SELECTION_CHANGED'").get().n, 2);

  assert.equal((await api.put('/api/model/selection', { default: { preset: 'nope' } })).json.error.code, 'PRESET_UNKNOWN');
  assert.equal((await api.put('/api/model/selection', { default: { preset: 'groq', apiKey: 'x' } })).json.error.code, 'SELECTION_INVALID');
  const cleared = await api.put('/api/model/selection', { clear: true });
  assert.equal(cleared.json.selection.source, 'legacy');
});
