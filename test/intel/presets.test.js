// TEST FIXTURE / MOCK. Model presets (server/intel/providers/presets.js, config/model-presets.json): catalog validity,
// the $0 guard, model rules, key isolation, local rate limits, per-lens selection and the pinned experiment setting,
// the hindsight cutoff per model, and the real-data privacy check. No network: a mock fetch answers every endpoint.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  loadPresets, validatePreset, createPresetProvider, guardLegacy, legacyPresetFor, normalizeSelection, choiceForLens,
  resolveLensProvider, realDataPrivacyCheck, resetPresetCaches, selectionFromEnv, cutoffFor, DEFAULT_PRESET_ID,
} from '../../server/intel/providers/presets.js';
import { getProvider } from '../../server/intel/model-provider.js';
import { hindsightCheck } from '../../server/intel/assessments.js';
import { TEST_SCHEMA } from '../../server/api/status.js';
import { ROOT } from './helpers.js';
import { makeModelFetch } from './preset-helpers.js';

const NOFILE = path.join(ROOT, 'data', 'test-intel-no-such-config.json');
const FREE_IDS = ['ollama-local', 'lmstudio-local', 'groq', 'openrouter-free', 'gemini-flash-free'];
const FAKE_KEYS = { VECTOR_GROQ_API_KEY: 'test-fixture-groq-key-000000', VECTOR_OPENROUTER_API_KEY: 'test-fixture-openrouter-key-0', VECTOR_GEMINI_API_KEY: 'test-fixture-gemini-key-00000' };
const baseEnv = (extra = {}) => ({ VECTOR_MODEL_CONFIG: NOFILE, ...extra });
const probe = (p) => p.complete({ system: 'TEST MOCK probe', user: 'Return {"ok": true, "note": "x"}.', schema: TEST_SCHEMA, schemaName: 't', maxTokens: 256, timeoutMs: 5000 });

function tempCatalog(mutate) {
  const doc = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'model-presets.json'), 'utf8'));
  mutate(doc);
  const p = path.join(ROOT, 'data', `test-presets-${process.pid}-${Math.random().toString(16).slice(2)}.json`);
  fs.writeFileSync(p, JSON.stringify(doc));
  return p;
}

beforeEach(() => resetPresetCaches());

test('catalog: loads with no errors; every preset declares cost, trains_on_prompts with an https source, limits, docs and cutoffs', () => {
  const cat = loadPresets({ env: baseEnv() });
  assert.deepEqual(cat.errors, []);
  for (const id of [...FREE_IDS, 'anthropic']) assert.ok(cat.presets.has(id), id);
  for (const id of FREE_IDS) assert.equal(cat.presets.get(id).cost, 'free', id);
  assert.equal(cat.presets.get('anthropic').cost, 'paid');
  for (const p of cat.presets.values()) {
    assert.ok([true, false, 'unknown'].includes(p.trains_on_prompts), p.id);
    assert.match(p.trains_on_prompts_source, /^https:\/\//, p.id);
    assert.match(p.docs_url, /^https:\/\//, p.id);
    assert.ok(p.limits.requests_per_minute > 0 && p.limits.requests_per_day > 0, p.id);
    assert.equal(JSON.stringify(p).match(/"(api_?key|secret|token)"/i), null, `${p.id} holds no secret-like field`);
  }
  // Local presets only: trains_on_prompts false. Remote free presets: as their terms say (Gemini free tier trains).
  assert.equal(cat.presets.get('ollama-local').trains_on_prompts, false);
  assert.equal(cat.presets.get('lmstudio-local').trains_on_prompts, false);
  assert.equal(cat.presets.get('gemini-flash-free').trains_on_prompts, true);
  assert.equal(cat.presets.get('groq').trains_on_prompts, 'unknown');
  assert.equal(cat.presets.get('openrouter-free').trains_on_prompts, 'unknown');
  assert.equal(DEFAULT_PRESET_ID, 'ollama-local');
});

test('validatePreset rejects a missing cost, a secret field, a non-loopback local preset and plain-http remote presets', () => {
  const ok = loadPresets({ env: baseEnv() }).presets.get('groq');
  assert.deepEqual(validatePreset(ok), []);
  const { cost: _c, ...noCost } = ok;
  assert.match(validatePreset(noCost).join(' '), /cost is required/);
  assert.match(validatePreset({ ...ok, api_key: 'x' }).join(' '), /secret-like/);
  assert.match(validatePreset({ ...ok, local: true, trains_on_prompts: false }).join(' '), /loopback/);
  assert.match(validatePreset({ ...ok, base_url: 'http://api.example.test/v1' }).join(' '), /https/);
  assert.match(validatePreset({ ...ok, limits: {} }).join(' '), /limits/);
  const anth = loadPresets({ env: baseEnv() }).presets.get('anthropic');
  assert.match(validatePreset({ ...anth, local: true, cost: 'free', trains_on_prompts: false }).join(' '), /anthropic preset is a remote API/);
});

test('(d) $0 guard: a preset whose cost is not free refuses to start unless VECTOR_ALLOW_PAID=1', async () => {
  const blocked = createPresetProvider({ preset: 'anthropic' }, { env: baseEnv({ ANTHROPIC_API_KEY: 'test-fixture-anthropic-000' }) });
  assert.equal(blocked.blockedCode, 'PAID_PROVIDER_BLOCKED');
  assert.equal(blocked.kind, 'none');
  assert.match((await blocked.status()).detail, /BLOCKED: PAID_PROVIDER_BLOCKED .*VECTOR_ALLOW_PAID=1/);
  const r = await probe(blocked);
  assert.equal(r.ok, false);
  assert.equal(r.errorKind, 'CONFIG');
  // A catalog entry with cost "unknown" is refused the same way.
  const file = tempCatalog((d) => { d.presets.find((p) => p.id === 'groq').cost = 'unknown'; });
  try {
    const g = createPresetProvider({ preset: 'groq' }, { env: baseEnv(FAKE_KEYS), file });
    assert.equal(g.blockedCode, 'PAID_PROVIDER_BLOCKED');
  } finally { fs.rmSync(file, { force: true }); }
  // With the explicit owner switch the paid preset is built (the Anthropic adapter; nothing is called here).
  const allowed = createPresetProvider({ preset: 'anthropic' }, { env: baseEnv({ VECTOR_ALLOW_PAID: '1', ANTHROPIC_API_KEY: 'test-fixture-anthropic-000' }), deps: { loadSdk: async () => { throw Object.assign(new Error('x'), { code: 'ERR_MODULE_NOT_FOUND' }); } } });
  assert.equal(allowed.blockedCode ?? null, null);
  assert.equal(allowed.kind, 'anthropic');
});

test('(d) $0 guard on the legacy VECTOR_MODEL_PROVIDER path: anthropic and non-local endpoints are blocked, loopback is free', () => {
  const anth = guardLegacy(getProvider({}, null, { env: { VECTOR_MODEL_PROVIDER: 'anthropic' }, file: NOFILE }), {});
  assert.equal(anth.blockedCode, 'PAID_PROVIDER_BLOCKED');
  const remote = getProvider({}, null, { env: { VECTOR_MODEL_PROVIDER: 'openai-compatible', VECTOR_OPENAI_BASE_URL: 'https://api.example.test/v1', VECTOR_OPENAI_MODEL: 'm' }, file: NOFILE });
  assert.equal(legacyPresetFor(remote).cost, 'unknown');
  assert.equal(guardLegacy(remote, {}).blockedCode, 'PAID_PROVIDER_BLOCKED');
  assert.equal(guardLegacy(remote, { VECTOR_ALLOW_PAID: '1' }).blockedCode ?? null, null);
  const local = getProvider({}, null, { env: { VECTOR_MODEL_PROVIDER: 'ollama', VECTOR_OLLAMA_MODEL: 'qwen3:8b' }, file: NOFILE });
  const g = guardLegacy(local, {});
  assert.equal(g.blockedCode ?? null, null);
  assert.equal(g.privacy.trains_on_prompts, false);
  assert.equal(guardLegacy(local, {}), g, 'stable wrapper identity (agent assessors cache by provider)');
  const none = guardLegacy(getProvider({}, null, { env: {}, file: NOFILE }), {});
  assert.equal(none.kind, 'none');
  assert.equal(none.blockedCode ?? null, null);
});

test('model rules: OpenRouter needs a :free id; the local Ollama preset refuses cloud models; a missing key is NO_API_KEY', () => {
  const env = baseEnv(FAKE_KEYS);
  assert.equal(createPresetProvider({ preset: 'openrouter-free', model: 'openai/gpt-oss-20b' }, { env }).blockedCode, 'PRESET_MODEL_NOT_FREE');
  assert.equal(createPresetProvider({ preset: 'openrouter-free', model: 'openai/gpt-oss-20b:free' }, { env }).blockedCode ?? null, null);
  assert.equal(createPresetProvider({ preset: 'ollama-local', model: 'gpt-oss:120b-cloud' }, { env }).blockedCode, 'LOCAL_PRESET_CLOUD_MODEL');
  const nokey = createPresetProvider({ preset: 'groq' }, { env: baseEnv() });
  assert.equal(nokey.blockedCode, 'NO_API_KEY');
  assert.equal(nokey.kind, 'none');
  assert.equal(createPresetProvider({ preset: 'lmstudio-local' }, { env }).blockedCode, 'MODEL_NOT_SET');
  assert.equal(createPresetProvider({ preset: 'no-such' }, { env }).blockedCode, 'PRESET_UNKNOWN');
});

test('every free preset answers a probe through the existing adapters; each key goes only to its own endpoint', async () => {
  const { fetchImpl, calls } = makeModelFetch({ models: ['qwen3:8b', 'lm-fixture', 'openai/gpt-oss-20b', 'openai/gpt-oss-20b:free', 'gemini-3.8-flash'] });
  const env = baseEnv(FAKE_KEYS);
  for (const id of FREE_IDS) {
    const p = createPresetProvider({ preset: id, model: id === 'lmstudio-local' ? 'lm-fixture' : null }, { env, deps: { fetch: fetchImpl } });
    assert.equal(p.blockedCode ?? null, null, id);
    assert.equal((await p.status()).status, 'CONNECTED', id);
    const r = await probe(p);
    assert.equal(r.ok, true, `${id}: ${r.error}`);
    assert.equal(p.preset.id, id);
  }
  const keyFor = { 'https://api.groq.com': FAKE_KEYS.VECTOR_GROQ_API_KEY, 'https://openrouter.ai': FAKE_KEYS.VECTOR_OPENROUTER_API_KEY, 'https://generativelanguage.googleapis.com': FAKE_KEYS.VECTOR_GEMINI_API_KEY };
  for (const c of calls) {
    const expected = keyFor[c.origin];
    if (expected) assert.equal(c.authorization, `Bearer ${expected}`, `${c.origin}${c.path}`);
    else assert.equal(c.authorization, null, `local endpoint ${c.origin}${c.path} gets no key`);
  }
  assert.ok(calls.some((c) => c.origin === 'http://127.0.0.1:11434' && c.path === '/api/chat'), 'ollama-local uses the native adapter');
  assert.ok(calls.some((c) => c.origin === 'https://generativelanguage.googleapis.com' && c.path === '/v1beta/openai/chat/completions'), 'Gemini uses its OpenAI-compatible endpoint');
});

test('an endpoint echoing its key in an error never hands the key to the caller (so it cannot reach a row or the journal)', async () => {
  const key = FAKE_KEYS.VECTOR_GROQ_API_KEY;
  const echo = async (url, init = {}) => {
    const auth = Object.entries(init.headers ?? {}).find(([k]) => k.toLowerCase() === 'authorization')?.[1] ?? '';
    return new Response(JSON.stringify({ error: { message: `invalid credentials: ${auth} at ${url}?k=${encodeURIComponent(key)}` } }), { status: 401, headers: { 'content-type': 'application/json' } });
  };
  const p = createPresetProvider({ preset: 'groq' }, { env: baseEnv(FAKE_KEYS), deps: { fetch: echo } });
  const r = await probe(p);
  assert.equal(r.ok, false);
  const text = JSON.stringify(r);
  assert.ok(!text.includes(key) && !text.includes(encodeURIComponent(key)), text.slice(0, 300));
  const legacy = guardLegacy(getProvider({}, { fetch: echo }, { env: { VECTOR_MODEL_PROVIDER: 'openai-compatible', VECTOR_OPENAI_BASE_URL: 'http://127.0.0.1:9/v1', VECTOR_OPENAI_MODEL: 'm', VECTOR_OPENAI_API_KEY: key }, file: NOFILE }), { VECTOR_OPENAI_API_KEY: key });
  assert.ok(!JSON.stringify(await probe(legacy)).includes(key));
});

test('local limits: the preset per-minute limit refuses the next call without sending it (LOCAL_RATE_LIMIT)', async () => {
  const file = tempCatalog((d) => { d.presets.find((p) => p.id === 'groq').limits = { requests_per_minute: 1, requests_per_day: 5, source: 'TEST FIXTURE' }; });
  try {
    const { fetchImpl, calls } = makeModelFetch();
    const p = createPresetProvider({ preset: 'groq' }, { env: baseEnv(FAKE_KEYS), deps: { fetch: fetchImpl }, file });
    assert.equal((await probe(p)).ok, true);
    const sent = calls.filter((c) => c.path.endsWith('/chat/completions')).length;
    const r2 = await probe(p);
    assert.equal(r2.ok, false);
    assert.equal(r2.errorKind, 'LOCAL_RATE_LIMIT');
    assert.match(r2.error, /Nothing was sent/);
    assert.equal(calls.filter((c) => c.path.endsWith('/chat/completions')).length, sent, 'no request left the process');
    assert.equal(p.localBudget().perMinute.remaining, 0);
  } finally { fs.rmSync(file, { force: true }); }
});

test('selection: env and stored forms; per-lens overrides; pinAllLenses gives all three lenses the same provider', () => {
  const presets = loadPresets({ env: baseEnv() }).presets;
  assert.equal(selectionFromEnv({}), null);
  const fromEnv = selectionFromEnv({ VECTOR_MODEL_PRESET: 'ollama-local', VECTOR_MODEL_PRESET_MODEL: 'qwen3:8b', VECTOR_MODEL_LENS_TIGHTWAD: 'groq@openai/gpt-oss-20b' });
  assert.deepEqual(fromEnv.default, { preset: 'ollama-local', model: 'qwen3:8b' });
  assert.deepEqual(fromEnv.lenses.tightwad, { preset: 'groq', model: 'openai/gpt-oss-20b' });
  const sel = normalizeSelection({ ...fromEnv, pinAllLenses: false }, presets);
  assert.equal(choiceForLens(sel, 'tightwad').preset, 'groq');
  assert.equal(choiceForLens(sel, 'cowboy').preset, 'ollama-local');
  const pinned = normalizeSelection({ ...fromEnv, pinAllLenses: true }, presets);
  for (const l of ['cowboy', 'pragmatist', 'tightwad']) assert.deepEqual(choiceForLens(pinned, l), { preset: 'ollama-local', model: 'qwen3:8b' });
  const env = baseEnv({ ...FAKE_KEYS, VECTOR_MODEL_PRESET: 'ollama-local', VECTOR_MODEL_PRESET_MODEL: 'qwen3:8b', VECTOR_MODEL_LENS_TIGHTWAD: 'groq', VECTOR_MODEL_PIN_ALL_LENSES: '1' });
  const ps = ['cowboy', 'pragmatist', 'tightwad'].map((lens) => resolveLensProvider({ env, lens }));
  assert.ok(ps.every((p) => p === ps[0]), 'pinned: one provider object for all lenses');
  assert.throws(() => normalizeSelection({ default: { preset: 'nope' } }, presets), /unknown preset/);
  assert.throws(() => normalizeSelection({ default: { preset: 'groq' }, lenses: { maverick: { preset: 'groq' } } }, presets), /unknown lens/);
});

test('hindsight: a preset model with a catalog cutoff passes; an unknown cutoff blocks until the owner sets one', () => {
  const presets = loadPresets({ env: baseEnv() }).presets;
  assert.equal(cutoffFor(presets.get('ollama-local'), 'qwen3:8b').date, '2025-04-29');
  assert.equal(cutoffFor(presets.get('groq'), 'openai/gpt-oss-20b').date, '2024-06-30');
  const env = baseEnv(FAKE_KEYS);
  const q = createPresetProvider({ preset: 'ollama-local', model: 'qwen3:8b' }, { env });
  assert.equal(hindsightCheck(q, '2026-10-07').ok, true);
  const g = createPresetProvider({ preset: 'gemini-flash-free' }, { env });
  assert.equal(hindsightCheck(g, '2026-10-07').code, 'MODEL_TRAINING_CUTOFF_UNKNOWN');
  const g2 = createPresetProvider({ preset: 'gemini-flash-free', trainingCutoff: '2025-01-31' }, { env });
  assert.equal(hindsightCheck(g2, '2026-10-07').ok, true);
  assert.match(g2.config.trainingCutoffSource, /owner-set/);
});

test('privacy check: only presets declaring trains_on_prompts false may receive real-account data (or owner-listed ones)', () => {
  const env = baseEnv(FAKE_KEYS);
  const local = createPresetProvider({ preset: 'ollama-local' }, { env });
  const groq = createPresetProvider({ preset: 'groq' }, { env });
  const gem = createPresetProvider({ preset: 'gemini-flash-free' }, { env });
  assert.equal(realDataPrivacyCheck({ cowboy: local, pragmatist: local, tightwad: local }, env).ok, true);
  const r = realDataPrivacyCheck({ cowboy: local, pragmatist: gem, tightwad: groq }, env);
  assert.equal(r.ok, false);
  assert.deepEqual(r.blocked.map((b) => [b.lens, b.trains_on_prompts]), [['pragmatist', true], ['tightwad', 'unknown']]);
  assert.equal(realDataPrivacyCheck({ tightwad: groq }, { ...env, VECTOR_REAL_DATA_ALLOW_PRESETS: 'groq' }).ok, true);
  assert.equal(realDataPrivacyCheck({ cowboy: { id: 'mock', kind: 'mock' } }, env).ok, false, 'no declared privacy = unknown = blocked');
});
