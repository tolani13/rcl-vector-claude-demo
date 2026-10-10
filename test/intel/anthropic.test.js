// TEST FIXTURE / MOCK. Anthropic adapter tests with an injected FAKE SDK module and FAKE client.
// The real Anthropic API is never called from tests.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createAnthropicProvider, buildAnthropicRequest, classifyAnthropicError, anthropicCallBudgetMs } from '../../server/intel/providers/anthropic.js';
import { LENS_OUTPUT_SCHEMA, systemPromptFor } from '../../server/intel/prompts.js';
import { runLensAssessments, buildEvidencePacket, listAssessments } from '../../server/intel/assessments.js';
import { list as journalList } from '../../server/journal.js';
import { tempDb, seedFixture, lensOf, lensOutput, FIX_DS, FIX_SYM, FIX_ASOF, MOCK_TRAINING_CUTOFF } from './helpers.js';

// ---- Fake SDK (mirrors the class hierarchy of @anthropic-ai/sdk errors) — TEST MOCK ----
class AnthropicError extends Error {}
class APIError extends AnthropicError { constructor(status, message) { super(message); this.status = status; } }
class APIUserAbortError extends APIError { constructor() { super(undefined, 'aborted'); } }
class APIConnectionError extends APIError { constructor(m = 'Connection error.') { super(undefined, m); } }
class APIConnectionTimeoutError extends APIConnectionError { constructor() { super('Request timed out.'); } }
class BadRequestError extends APIError {}
class AuthenticationError extends APIError {}
class PermissionDeniedError extends APIError {}
class NotFoundError extends APIError {}
class RateLimitError extends APIError {}
class FakeAnthropic { constructor(opts) { this.opts = opts; } }
Object.assign(FakeAnthropic, {
  AnthropicError, APIError, APIUserAbortError, APIConnectionError, APIConnectionTimeoutError, BadRequestError,
  AuthenticationError, PermissionDeniedError, NotFoundError, RateLimitError,
});
const fakeSdk = { default: FakeAnthropic };

function fakeClient(respond) {
  const calls = [];
  return {
    calls,
    beta: { messages: { create: async (params, opts) => { calls.push({ params: JSON.parse(JSON.stringify(params)), opts }); return respond(params, calls.length); } } },
    models: { retrieve: async (id) => ({ id, type: 'model' }) },
  };
}

function provider(client, cfg = {}) {
  return createAnthropicProvider(cfg, { loadSdk: async () => fakeSdk, clientFactory: () => client });
}

const msg = (text, extra = {}) => ({
  id: 'msg_test', type: 'message', role: 'assistant', model: 'claude-opus-5-5', stop_reason: 'end_turn', stop_details: null,
  content: [{ type: 'thinking', thinking: '' }, { type: 'text', text }], usage: { input_tokens: 1200, output_tokens: 300 }, ...extra,
});

const SCHEMA = LENS_OUTPUT_SCHEMA;
const SYSTEM = systemPromptFor('pragmatist');
const USER = 'TEST FIXTURE packet text';

test('builds the exact request shape (model, betas, fallbacks, adaptive thinking, effort, json_schema)', async () => {
  const valid = lensOutput('pragmatist', ['ev_x']);
  const client = fakeClient(() => msg(JSON.stringify(valid)));
  const p = provider(client);
  assert.equal(p.model, 'claude-opus-5-5');
  const r = await p.complete({ system: SYSTEM, user: USER, schema: SCHEMA, timeoutMs: 1234 });
  assert.equal(r.ok, true);
  assert.deepEqual(r.json, valid);
  assert.deepEqual(r.usage, { in: 1200, out: 300 });
  assert.equal(client.calls.length, 1);
  assert.deepEqual(client.calls[0].params, {
    model: 'claude-opus-5-5',
    max_tokens: 16000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    thinking: { type: 'adaptive' },
    output_config: { effort: 'medium', format: { type: 'json_schema', schema: JSON.parse(JSON.stringify(SCHEMA)) } },
    system: SYSTEM,
    messages: [{ role: 'user', content: USER }],
  });
  // The per-call budget scales with max_tokens (a long adaptive-thinking turn is not aborted as TIMEOUT):
  // max(1234 ms, 60 s + 25 ms x 16000) = 460 s.
  assert.equal(client.calls[0].opts.timeout, 460_000);
  assert.equal(anthropicCallBudgetMs(16000, 1234), 460_000);
  assert.equal(anthropicCallBudgetMs(1000, 600_000), 600_000, 'a larger configured timeout is kept');
  assert.equal(p.callBudgetMs(16000, 1234), 460_000);
  assert.ok(client.calls[0].opts.signal instanceof AbortSignal);
  assert.deepEqual(buildAnthropicRequest({ model: 'm', maxTokens: 1, effort: 'medium', system: 's', user: 'u', schema: { type: 'object' } }).messages, [{ role: 'user', content: 'u' }]);
  // Model override via config (model-provider passes VECTOR_ANTHROPIC_MODEL here).
  const p2 = provider(fakeClient(() => msg(JSON.stringify(valid))), { model: 'claude-sonnet-5-5' });
  assert.equal(p2.model, 'claude-sonnet-5-5');
});

test('uses the streaming API (finalMessage) when the SDK offers it', async () => {
  const valid = lensOutput('pragmatist', ['ev_x']);
  const client = fakeClient(() => { throw new Error('create must not be used when stream exists'); });
  const streamed = [];
  client.beta.messages.stream = (params, opts) => {
    streamed.push({ params: JSON.parse(JSON.stringify(params)), opts });
    return { finalMessage: async () => msg(JSON.stringify(valid)) };
  };
  const r = await provider(client).complete({ system: SYSTEM, user: USER, schema: SCHEMA, maxTokens: 4000, timeoutMs: 1000 });
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(r.json, valid);
  assert.equal(client.calls.length, 0);
  assert.equal(streamed.length, 1);
  assert.deepEqual(streamed[0].params, buildAnthropicRequest({ model: 'claude-opus-5-5', maxTokens: 4000, effort: 'medium', system: SYSTEM, user: USER, schema: JSON.parse(JSON.stringify(SCHEMA)) }));
  assert.equal(streamed[0].opts.timeout, 60_000 + 4000 * 25);
  assert.ok(streamed[0].opts.signal instanceof AbortSignal);
  // Errors thrown by finalMessage() are classified like create() errors.
  client.beta.messages.stream = () => ({ finalMessage: async () => { throw new RateLimitError(429, 'slow down'); } });
  assert.equal((await provider(client).complete({ system: SYSTEM, user: USER, schema: SCHEMA })).errorKind, 'RATE_LIMIT');
});

test('refusal is detected from stop_reason before content is read', async () => {
  const refused = {
    id: 'msg_ref', type: 'message', model: 'claude-opus-5-5', stop_reason: 'refusal',
    stop_details: { type: 'refusal', category: 'cyber', explanation: 'TEST MOCK explanation' },
    usage: { input_tokens: 10, output_tokens: 0 },
    get content() { throw new Error('content must not be read for a refusal'); },
  };
  const r = await provider(fakeClient(() => refused)).complete({ system: SYSTEM, user: USER, schema: SCHEMA });
  assert.equal(r.ok, false);
  assert.equal(r.errorKind, 'REFUSAL');
  assert.deepEqual(r.refusal, { category: 'cyber', explanation: 'TEST MOCK explanation' });
  // stop_details may be absent.
  const r2 = await provider(fakeClient(() => ({ stop_reason: 'refusal', content: [] }))).complete({ system: SYSTEM, user: USER, schema: SCHEMA });
  assert.deepEqual(r2.refusal, { category: null, explanation: null });
});

test('invalid JSON, schema violations and truncation are INVALID_OUTPUT', async () => {
  const bad = await provider(fakeClient(() => msg('{"lens": "pragmatist",'))).complete({ system: SYSTEM, user: USER, schema: SCHEMA });
  assert.equal(bad.errorKind, 'INVALID_OUTPUT');
  assert.match(bad.error, /INVALID_JSON/);
  const wrong = await provider(fakeClient(() => msg('{"lens":"pragmatist"}'))).complete({ system: SYSTEM, user: USER, schema: SCHEMA });
  assert.equal(wrong.errorKind, 'INVALID_OUTPUT');
  assert.match(wrong.error, /SCHEMA_INVALID/);
  const trunc = await provider(fakeClient(() => msg('{"lens"', { stop_reason: 'max_tokens' }))).complete({ system: SYSTEM, user: USER, schema: SCHEMA });
  assert.equal(trunc.errorKind, 'INVALID_OUTPUT');
  assert.match(trunc.error, /TRUNCATED/);
});

test('typed SDK errors are classified by class, not by message text', async () => {
  const cases = [
    [new AuthenticationError(401, 'rate limit exceeded (misleading text)'), 'AUTH'],
    [new RateLimitError(429, 'authentication (misleading text)'), 'RATE_LIMIT'],
    [new APIError(500, 'overloaded'), 'HTTP'],
    [new BadRequestError(400, 'bad'), 'BAD_REQUEST'],
    [new APIConnectionTimeoutError(), 'TIMEOUT'],
    [new APIConnectionError(), 'NETWORK'],
    [new Error('rate limit authentication'), 'UNKNOWN'],
  ];
  for (const [err, kind] of cases) {
    const r = await provider(fakeClient(() => { throw err; })).complete({ system: SYSTEM, user: USER, schema: SCHEMA });
    assert.equal(r.ok, false);
    assert.equal(r.errorKind, kind, `${err.constructor.name} -> ${kind}`);
    assert.equal(classifyAnthropicError(FakeAnthropic, err).kind, kind);
  }
});

test('missing SDK -> FAULT "SDK not installed" (status never throws)', async () => {
  const notFound = Object.assign(new Error("Cannot find package '@anthropic-ai/sdk'"), { code: 'ERR_MODULE_NOT_FOUND' });
  const p = createAnthropicProvider({}, { loadSdk: async () => { throw notFound; } });
  const s = await p.status();
  assert.equal(s.status, 'FAULT');
  assert.match(s.detail, /SDK not installed: run npm install/);
  const r = await p.complete({ system: SYSTEM, user: USER, schema: SCHEMA });
  assert.equal(r.errorKind, 'SDK_MISSING');
});

test('status: CONNECTED via free model lookup; auth failure FAULT; unreachable DISCONNECTED', async () => {
  assert.equal((await provider(fakeClient(() => null)).status()).status, 'CONNECTED');
  const authFail = fakeClient(() => null);
  authFail.models.retrieve = async () => { throw new AuthenticationError(401, 'x'); };
  assert.equal((await provider(authFail).status()).status, 'FAULT');
  const offline = fakeClient(() => null);
  offline.models.retrieve = async () => { throw new APIConnectionError(); };
  assert.equal((await provider(offline).status()).status, 'DISCONNECTED');
  const noCreds = createAnthropicProvider({}, { loadSdk: async () => fakeSdk, clientFactory: () => { throw new AnthropicError('no credentials'); } });
  assert.equal((await noCreds.status()).status, 'DISCONNECTED');
});

test('end-to-end: three lens assessments through the Anthropic adapter (fake client)', async () => {
  const t = tempDb();
  try {
    seedFixture(t.db);
    const packet = buildEvidencePacket(t.db, FIX_DS, FIX_SYM, FIX_ASOF);
    const client = fakeClient((params) => {
      const lens = lensOf(params.system);
      if (lens === 'tightwad') return { stop_reason: 'refusal', stop_details: { type: 'refusal', category: null, explanation: 'TEST' }, model: 'claude-opus-5-5', usage: {} };
      return msg(JSON.stringify(lensOutput(lens, packet.evidenceIds)), lens === 'pragmatist' ? { model: 'claude-opus-5', content: [{ type: 'fallback', from: { model: 'claude-opus-5-5' }, to: { model: 'claude-opus-5' } }, { type: 'text', text: JSON.stringify(lensOutput(lens, packet.evidenceIds)) }] } : {});
    });
    const p = provider(client);
    // The fixture trade date (2026-01-05) is before claude-opus-5-5's built-in cutoff, so that run is BLOCKED (hindsight).
    const blocked = await runLensAssessments(t.db, p, { session_id: 'anth-blocked', ds: FIX_DS, sym: FIX_SYM, asOf: FIX_ASOF });
    assert.equal(blocked.status, 'BLOCKED');
    assert.equal(blocked.code, 'REPLAY_BEFORE_MODEL_CUTOFF');
    assert.equal(client.calls.length, 0);
    p.config = { trainingCutoff: MOCK_TRAINING_CUTOFF, trainingCutoffSource: 'TEST MOCK' };
    const res = await runLensAssessments(t.db, p, { session_id: 'anth', ds: FIX_DS, sym: FIX_SYM, asOf: FIX_ASOF });
    assert.deepEqual(res.results.map((r) => r.status), ['OK', 'OK', 'REFUSED']);
    assert.equal(new Set(client.calls.map((c) => c.params.messages[0].content)).size, 1);
    const prag = res.results.find((r) => r.lens === 'pragmatist');
    assert.equal(prag.fallbackUsed, true);
    assert.equal(prag.model, 'claude-opus-5', 'the model that actually served the turn is recorded');
    assert.equal(prag.requestedModel, 'claude-opus-5-5');
    // Fallback use, requested and served model are persisted in the audit trail (journal + stored-assessment audit).
    const j = journalList(t.db, { session_id: 'anth', type: 'MODEL_ASSESSMENT' }).find((r) => r.ref_id === prag.assessment_id);
    assert.equal(j.payload.fallback_used, true);
    assert.equal(j.payload.requested_model, 'claude-opus-5-5');
    assert.equal(j.payload.served_model, 'claude-opus-5');
    const audit = listAssessments(t.db, { sym: FIX_SYM, session_id: 'anth' }).find((r) => r.id === prag.assessment_id).audit;
    assert.deepEqual([audit.fallback_used, audit.requested_model, audit.served_model], [true, 'claude-opus-5-5', 'claude-opus-5']);
    const cow = journalList(t.db, { session_id: 'anth', type: 'MODEL_ASSESSMENT' }).find((r) => r.payload.lens === 'cowboy');
    assert.equal(cow.payload.fallback_used, false);
    const rows = t.db.prepare("SELECT lens, provider, model, status FROM assessments WHERE session_id = 'anth' ORDER BY lens").all();
    assert.deepEqual(rows.map((r) => [r.lens, r.provider, r.status]), [['cowboy', 'anthropic', 'OK'], ['pragmatist', 'anthropic', 'OK'], ['tightwad', 'anthropic', 'REFUSED']]);
  } finally {
    t.cleanup();
  }
});

test('status is cached; status({fresh:true}) bypasses the cache', async () => {
  const c = fakeClient(() => null);
  let lookups = 0;
  c.models.retrieve = async (id) => { lookups++; return { id, type: 'model' }; };
  const p = provider(c);
  assert.equal((await p.status()).status, 'CONNECTED');
  assert.equal((await p.status()).status, 'CONNECTED');
  assert.equal(lookups, 1, 'second call served from the cache');
  c.models.retrieve = async () => { lookups++; throw new APIConnectionError(); };
  assert.equal((await p.status()).status, 'CONNECTED', 'still cached');
  assert.equal((await p.status({ fresh: true })).status, 'DISCONNECTED');
  assert.equal(lookups, 2);
});
