// TEST FIXTURE / MOCK. Provider selection, config hygiene and never-throwing status.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  getProvider, status, resolveModelConfig, loadModelConfigFile, isSecretLikeKey, validIsoDate, KNOWN_TRAINING_CUTOFFS,
} from '../../server/intel/model-provider.js';
import { ROOT } from './helpers.js';

const tmpFiles = [];
after(() => { for (const f of tmpFiles) fs.rmSync(f, { force: true }); });
function configFile(obj) {
  const f = path.join(ROOT, 'data', `test-intel-model-config-${crypto.randomBytes(4).toString('hex')}.json`);
  fs.writeFileSync(f, typeof obj === 'string' ? obj : JSON.stringify(obj));
  tmpFiles.push(f);
  return f;
}
const NOFILE = path.join(ROOT, 'data', 'test-intel-no-such-config.json');
const fakeSdkMissing = { loadSdk: async () => { throw Object.assign(new Error('missing'), { code: 'ERR_MODULE_NOT_FOUND' }); } };

test('default is none -> DISCONNECTED; complete() never produces output', async () => {
  const p = getProvider({}, null, { env: {}, file: NOFILE });
  assert.equal(p.kind, 'none');
  const s = await status({}, null, { env: {}, file: NOFILE });
  assert.equal(s.status, 'DISCONNECTED');
  assert.match(s.detail, /MODEL DISCONNECTED \/ ASSESSMENT NOT RUN/);
  assert.equal(s.limits.maxCallsPerSession, 60);
  const r = await p.complete({ system: 's', user: 'u', schema: {} });
  assert.equal(r.ok, false);
  assert.equal(r.json, null);
  assert.equal(r.error, 'MODEL_DISCONNECTED');
});

test('unknown provider kind -> FAULT', async () => {
  const s = await status({}, null, { env: { VECTOR_MODEL_PROVIDER: 'magic' }, file: NOFILE });
  assert.equal(s.status, 'FAULT');
  assert.match(s.detail, /unknown VECTOR_MODEL_PROVIDER/);
});

test('anthropic selection: default model, env override, SDK-missing FAULT', async () => {
  const p = getProvider({}, fakeSdkMissing, { env: { VECTOR_MODEL_PROVIDER: 'anthropic' }, file: NOFILE });
  assert.equal(p.kind, 'anthropic');
  assert.equal(p.model, 'claude-opus-5-5');
  const p2 = getProvider({}, fakeSdkMissing, { env: { VECTOR_MODEL_PROVIDER: 'anthropic', VECTOR_ANTHROPIC_MODEL: 'claude-sonnet-5-5' }, file: NOFILE });
  assert.equal(p2.model, 'claude-sonnet-5-5');
  const s = await status({}, fakeSdkMissing, { env: { VECTOR_MODEL_PROVIDER: 'anthropic' }, file: NOFILE });
  assert.equal(s.status, 'FAULT');
  assert.match(s.detail, /SDK not installed: run npm install/);
});

test('config file supplies non-secret settings; secret-like fields are ignored; env overrides file', () => {
  const f = configFile({
    provider: 'openai-compatible', maxCallsPerSession: 12, timeoutMs: 300000,
    openaiCompatible: { baseUrl: 'http://127.0.0.1:9/v1', model: 'file-model', apiKey: 'should-be-ignored' },
    anthropic: { model: 'claude-opus-5-5', token: 'nope' },
  });
  const loaded = loadModelConfigFile(f);
  assert.equal(loaded.loaded, true);
  assert.equal(loaded.config.openaiCompatible.apiKey, undefined);
  assert.equal(loaded.config.anthropic.token, undefined);
  assert.equal(loaded.warnings.length, 2);
  const c = resolveModelConfig({}, { env: {}, file: f });
  assert.equal(c.provider, 'openai-compatible');
  assert.equal(c.maxCallsPerSession, 12);
  assert.equal(c.openaiCompatible.model, 'file-model');
  assert.equal(c.openaiCompatible.timeoutMs, 300000);
  assert.ok(!JSON.stringify(c).includes('should-be-ignored'));
  const c2 = resolveModelConfig({}, { env: { VECTOR_OPENAI_MODEL: 'env-model', VECTOR_MAX_MODEL_CALLS_PER_SESSION: '7' }, file: f });
  assert.equal(c2.openaiCompatible.model, 'env-model');
  assert.equal(c2.maxCallsPerSession, 7);
  const c3 = resolveModelConfig({ maxCallsPerSession: 3 }, { env: { VECTOR_MAX_MODEL_CALLS_PER_SESSION: '7' }, file: f });
  assert.equal(c3.maxCallsPerSession, 3);
  // Invalid numbers fall back to defaults with a warning; invalid JSON file is ignored.
  const c4 = resolveModelConfig({}, { env: { VECTOR_MAX_MODEL_CALLS_PER_SESSION: '-1' }, file: NOFILE });
  assert.equal(c4.maxCallsPerSession, 60);
  assert.ok(c4.warnings.some((w) => /maxCallsPerSession/.test(w)));
  const broken = loadModelConfigFile(configFile('{not json'));
  assert.equal(broken.loaded, false);
  assert.ok(broken.warnings.length);
});

test('openai-compatible selection reads the key from env only; status never throws', async () => {
  const p = getProvider({}, { fetch: () => { throw new Error('boom'); } }, {
    env: { VECTOR_MODEL_PROVIDER: 'openai-compatible', VECTOR_OPENAI_BASE_URL: 'http://127.0.0.1:9/v1', VECTOR_OPENAI_MODEL: 'm', VECTOR_OPENAI_API_KEY: 'k-test' },
    file: NOFILE,
  });
  assert.equal(p.kind, 'openai-compatible');
  assert.equal(p.endpointLabel, 'http://127.0.0.1:9/v1');
  assert.ok(!JSON.stringify(p.config).includes('k-test'));
  const s = await status({}, { fetch: () => { throw new Error('boom'); } }, {
    env: { VECTOR_MODEL_PROVIDER: 'openai-compatible', VECTOR_OPENAI_BASE_URL: 'http://127.0.0.1:9/v1', VECTOR_OPENAI_MODEL: 'm' }, file: NOFILE,
  });
  assert.ok(['DISCONNECTED', 'FAULT'].includes(s.status));
  const unconfigured = await status({}, null, { env: { VECTOR_MODEL_PROVIDER: 'openai-compatible' }, file: NOFILE });
  assert.equal(unconfigured.status, 'DISCONNECTED');
  assert.match(unconfigured.detail, /VECTOR_OPENAI_BASE_URL/);
});

test('product hygiene: server/intel has no mock provider and never imports from test/', () => {
  const dir = path.join(ROOT, 'server', 'intel');
  const files = [];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (p.endsWith('.js')) files.push(p); } };
  walk(dir);
  assert.ok(files.length >= 6);
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    assert.ok(!/from\s+['"][^'"]*\btest\//.test(src), `${f} imports from test/`);
    assert.ok(!/import\(\s*['"][^'"]*\btest\//.test(src), `${f} dynamically imports from test/`);
    assert.ok(!/kind:\s*['"]mock['"]/.test(src), `${f} defines a mock provider`);
  }
});

test('secret detection matches whole words: maxTokens / contextTokens / tokenParam are settings, keys and tokens are not', () => {
  for (const k of ['apiKey', 'api_key', 'apikey', 'API-KEY', 'token', 'accessToken', 'auth_token', 'secret', 'clientSecret', 'password', 'authorization', 'bearer', 'credentials', 'privateKey']) {
    assert.equal(isSecretLikeKey(k), true, k);
  }
  for (const k of ['maxTokens', 'max_tokens', 'contextTokens', 'tokenParam', 'model', 'baseUrl', 'timeoutMs', 'trainingCutoff']) {
    assert.equal(isSecretLikeKey(k), false, k);
  }
  const f = configFile({ provider: 'openai-compatible', maxTokens: 4000, openaiCompatible: { baseUrl: 'http://127.0.0.1:9/v1', model: 'm', contextTokens: 16384, tokenParam: 'max_completion_tokens' } });
  const c = resolveModelConfig({}, { env: {}, file: f });
  assert.equal(c.maxTokens, 4000);
  assert.equal(c.openaiCompatible.contextTokens, 16384);
  assert.equal(c.openaiCompatible.tokenParam, 'max_completion_tokens');
  assert.deepEqual(c.warnings, []);
  // The resolved values reach the adapter.
  const p = getProvider({}, { fetch: () => { throw new Error('no network in tests'); } }, { env: {}, file: f });
  assert.equal(p.tokenParam, 'max_completion_tokens');
  // Env overrides; invalid values are ignored with a warning.
  const c2 = resolveModelConfig({}, { env: { VECTOR_OPENAI_CONTEXT_TOKENS: 'big', VECTOR_OPENAI_TOKEN_PARAM: 'max_tok' }, file: f });
  assert.ok(c2.warnings.some((w) => /contextTokens/.test(w)) && c2.warnings.some((w) => /tokenParam/.test(w)));
  assert.equal(resolveModelConfig({}, { env: { VECTOR_OPENAI_CONTEXT_TOKENS: '8192' }, file: f }).openaiCompatible.contextTokens, 8192);
});

test('training cutoff: built-in for known models, configurable, unknown stays unknown; exposed by status()', async () => {
  const anth = resolveModelConfig({}, { env: { VECTOR_MODEL_PROVIDER: 'anthropic' }, file: NOFILE });
  assert.equal(anth.trainingCutoff, KNOWN_TRAINING_CUTOFFS['claude-opus-5-5']);
  assert.equal(anth.trainingCutoffSource, 'built-in');
  assert.equal(anth.cutoffMarginDays, 90);
  assert.equal(anth.allowPreCutoffReplay, false);
  const local = resolveModelConfig({}, { env: { VECTOR_MODEL_PROVIDER: 'openai-compatible', VECTOR_OPENAI_MODEL: 'qwen3:8b' }, file: NOFILE });
  assert.equal(local.trainingCutoff, null, 'an unlisted model has an UNKNOWN cutoff, never an assumed one');
  const set = resolveModelConfig({}, {
    env: { VECTOR_MODEL_PROVIDER: 'openai-compatible', VECTOR_OPENAI_MODEL: 'qwen3:8b', VECTOR_MODEL_TRAINING_CUTOFF: '2025-03-31', VECTOR_MODEL_CUTOFF_MARGIN_DAYS: '120', VECTOR_ALLOW_PRE_CUTOFF_REPLAY: '1' },
    file: NOFILE,
  });
  assert.deepEqual([set.trainingCutoff, set.trainingCutoffSource, set.cutoffMarginDays, set.allowPreCutoffReplay], ['2025-03-31', 'configured', 120, true]);
  const bad = resolveModelConfig({ trainingCutoff: '2025-02-30' }, { env: {}, file: NOFILE });
  assert.equal(bad.trainingCutoff, null);
  assert.ok(bad.warnings.some((w) => /trainingCutoff/.test(w)));
  assert.equal(validIsoDate('2025-02-28'), '2025-02-28');
  assert.equal(validIsoDate('2025-13-01'), null);
  const s = await status({}, fakeSdkMissing, { env: { VECTOR_MODEL_PROVIDER: 'anthropic' }, file: NOFILE });
  assert.deepEqual(s.hindsight, { trainingCutoff: KNOWN_TRAINING_CUTOFFS['claude-opus-5-5'], source: 'built-in', marginDays: 90, allowPreCutoffReplay: false });
  assert.equal(s.limits.maxCallsPerDay, 300);
});

test('config file reads are cached by size/mtime and pick up edits without a restart', async () => {
  const f = configFile({ provider: 'openai-compatible', maxCallsPerSession: 5, openaiCompatible: { baseUrl: 'http://127.0.0.1:9/v1', model: 'm' } });
  assert.equal(resolveModelConfig({}, { env: {}, file: f }).maxCallsPerSession, 5);
  const a = loadModelConfigFile(f);
  a.config.maxCallsPerSession = 999; // callers get copies; the cache cannot be mutated through them
  assert.equal(loadModelConfigFile(f).config.maxCallsPerSession, 5);
  fs.writeFileSync(f, JSON.stringify({ provider: 'openai-compatible', maxCallsPerSession: 17, openaiCompatible: { baseUrl: 'http://127.0.0.1:9/v1', model: 'model-two' } }));
  const c = resolveModelConfig({}, { env: {}, file: f });
  assert.equal(c.maxCallsPerSession, 17);
  assert.equal(c.openaiCompatible.model, 'model-two');
  assert.equal(getProvider({}, null, { env: {}, file: f }).model, 'model-two', 'getProvider re-resolves after an edit');
  fs.rmSync(f);
  assert.equal(loadModelConfigFile(f).loaded, false);
  assert.equal(getProvider({}, null, { env: {}, file: f }).kind, 'none');
});
