// TEST FIXTURE / MOCK. OpenAI-compatible adapter against a local node:http test server (no external network).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {
  createOpenAICompatibleProvider, stripThink, normalizeBaseUrl, estimatePromptTokens, minPromptTokens, MIN_OUTPUT_RESERVE_TOKENS, OLLAMA_DEFAULT_CONTEXT,
} from '../../server/intel/providers/openai-compatible.js';
import { LENS_OUTPUT_SCHEMA, systemPromptFor } from '../../server/intel/prompts.js';
import { lensOutput } from './helpers.js';

let server;
let base;
let handler;
const seen = [];

before(async () => {
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, headers: req.headers, body: body ? JSON.parse(body) : null });
      handler(req, res, body);
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}/v1`;
});
after(async () => {
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
});

const json = (res, status, obj) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
const completion = (content, extra = {}) => ({
  id: 'chatcmpl-test', object: 'chat.completion', model: 'test-model',
  choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop', ...extra }],
  usage: { prompt_tokens: 900, completion_tokens: 200 },
});
const SYSTEM = systemPromptFor('tightwad');
const USER = 'TEST FIXTURE packet';
const mk = (cfg = {}) => createOpenAICompatibleProvider({ baseUrl: base, model: 'test-model', ...cfg });
const call = (p, extra = {}) => p.complete({ system: SYSTEM, user: USER, schema: LENS_OUTPUT_SCHEMA, schemaName: 'vector_lens_assessment', ...extra });

test('parses <think>-wrapped JSON and sends a strict json_schema response_format', async () => {
  const valid = lensOutput('tightwad', ['ev_1']);
  handler = (req, res) => json(res, 200, completion(`<think>\nLet me reason {"not": "the answer"}\n</think>\n\n${JSON.stringify(valid)}`));
  seen.length = 0;
  const r = await call(mk({ apiKey: 'test-key-not-real' }));
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(r.json, valid);
  assert.deepEqual(r.usage, { in: 900, out: 200 });
  const req = seen[0];
  assert.equal(req.method, 'POST');
  assert.equal(req.url, '/v1/chat/completions');
  assert.equal(req.headers.authorization, 'Bearer test-key-not-real');
  assert.equal(req.body.model, 'test-model');
  assert.deepEqual(req.body.messages, [{ role: 'system', content: SYSTEM }, { role: 'user', content: USER }]);
  assert.deepEqual(req.body.response_format, {
    type: 'json_schema', json_schema: { name: 'vector_lens_assessment', schema: JSON.parse(JSON.stringify(LENS_OUTPUT_SCHEMA)), strict: true },
  });
  assert.equal(req.body.stream, false);
  // No key configured -> no Authorization header.
  seen.length = 0;
  await call(mk());
  assert.equal(seen[0].headers.authorization, undefined);
});

test('HTTP errors map to typed error kinds without leaking the key', async () => {
  handler = (req, res) => json(res, 500, { error: { message: 'internal test failure' } });
  const r500 = await call(mk({ apiKey: 'secret-test-key' }));
  assert.equal(r500.ok, false);
  assert.equal(r500.errorKind, 'HTTP');
  assert.match(r500.error, /HTTP 500/);
  assert.ok(!r500.error.includes('secret-test-key'));
  handler = (req, res) => json(res, 401, { error: { message: 'bad key' } });
  assert.equal((await call(mk())).errorKind, 'AUTH');
  handler = (req, res) => json(res, 429, { error: { message: 'slow down' } });
  assert.equal((await call(mk())).errorKind, 'RATE_LIMIT');
  handler = (req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<html>not json</html>'); };
  assert.equal((await call(mk())).errorKind, 'PROTOCOL');
});

test('invalid content, schema violations, truncation and refusals', async () => {
  handler = (req, res) => json(res, 200, completion('<think>only reasoning</think> sorry, no JSON here'));
  const bad = await call(mk());
  assert.equal(bad.errorKind, 'INVALID_OUTPUT');
  assert.match(bad.error, /INVALID_JSON/);
  handler = (req, res) => json(res, 200, completion('{"lens":"tightwad","stance":"maybe"}'));
  const schemaBad = await call(mk());
  assert.equal(schemaBad.errorKind, 'INVALID_OUTPUT');
  assert.match(schemaBad.error, /SCHEMA_INVALID/);
  handler = (req, res) => json(res, 200, completion('{"lens":"tigh', { finish_reason: 'length' }));
  assert.match((await call(mk())).error, /TRUNCATED/);
  handler = (req, res) => json(res, 200, { choices: [{ index: 0, message: { role: 'assistant', content: null, refusal: 'TEST MOCK refusal' }, finish_reason: 'stop' }] });
  const ref = await call(mk());
  assert.equal(ref.errorKind, 'REFUSAL');
  assert.equal(ref.refusal.explanation, 'TEST MOCK refusal');
});

test('per-call timeout aborts the request', async () => {
  handler = (req, res) => { setTimeout(() => { if (!res.writableEnded) json(res, 200, completion('{}')); }, 2000); };
  const t0 = Date.now();
  const r = await call(mk(), { timeoutMs: 150 });
  assert.equal(r.errorKind, 'TIMEOUT');
  assert.ok(Date.now() - t0 < 1500);
});

test('status: GET /models -> CONNECTED / FAULT / DISCONNECTED (never throws)', async () => {
  handler = (req, res) => json(res, 200, { object: 'list', data: [{ id: 'test-model' }, { id: 'other' }] });
  seen.length = 0;
  const ok = await mk().status();
  assert.equal(ok.status, 'CONNECTED');
  assert.equal(seen[0].method, 'GET');
  assert.equal(seen[0].url, '/v1/models');
  assert.equal((await mk({ model: 'missing-model' }).status()).status, 'FAULT');
  handler = (req, res) => json(res, 401, {});
  assert.equal((await mk().status()).status, 'FAULT');
  // Nothing listening on this port.
  const tmp = http.createServer();
  await new Promise((r) => tmp.listen(0, '127.0.0.1', r));
  const deadPort = tmp.address().port;
  await new Promise((r) => tmp.close(r));
  const dead = await createOpenAICompatibleProvider({ baseUrl: `http://127.0.0.1:${deadPort}/v1`, model: 'm' }).status();
  assert.equal(dead.status, 'DISCONNECTED');
  assert.equal((await createOpenAICompatibleProvider({}).status()).status, 'DISCONNECTED');
  const unconfigured = await createOpenAICompatibleProvider({}).complete({ system: 's', user: 'u', schema: {} });
  assert.equal(unconfigured.errorKind, 'CONFIG');
  const throwingFetch = createOpenAICompatibleProvider({ baseUrl: base, model: 'm' }, { fetch: () => { throw new Error('boom'); } });
  assert.equal((await throwingFetch.status()).status, 'DISCONNECTED');
});

test('stripThink and base URL normalisation', () => {
  assert.equal(stripThink('<think>a</think>{"x":1}'), '{"x":1}');
  assert.equal(stripThink('<THINK>\nmulti\nline\n</THINK>\n {"x":1} '), '{"x":1}');
  assert.equal(stripThink('reasoning without opener</think>{"x":1}'), '{"x":1}');
  assert.equal(stripThink('{"x":1}<think>unterminated'), '{"x":1}');
  assert.equal(stripThink('```json\n{"x":1}\n```'), '{"x":1}');
  // A literal tag inside a JSON string value is never cut (valid JSON is returned unchanged).
  assert.equal(stripThink('{"thesis":"model said <think> in text","x":1}'), '{"thesis":"model said <think> in text","x":1}');
  assert.equal(stripThink('{"counter_thesis":"ends with </think> here"}'), '{"counter_thesis":"ends with </think> here"}');
  assert.equal(stripThink('<think>plan</think>{"t":"quote <think> and </think>"}'), '{"t":"quote <think> and </think>"}');
  assert.equal(stripThink('<think>never closed'), '');
  assert.equal(normalizeBaseUrl('http://127.0.0.1:11434/v1/'), 'http://127.0.0.1:11434/v1');
  assert.throws(() => normalizeBaseUrl('ftp://x'), /http/);
  assert.throws(() => normalizeBaseUrl('http://user:pw@host/v1'), /credentials/);
});

// ---- Context window guards (fake fetch; TEST MOCK). ----
function fakeFetch(handlerFn) {
  const calls = [];
  const f = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method ?? 'GET', body: init.body ? JSON.parse(init.body) : null });
    const { status = 200, body } = await handlerFn(String(url), init, calls.length);
    return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) };
  };
  f.calls = calls;
  return f;
}
const BIG_USER = `TEST FIXTURE packet ${'x'.repeat(12_000)}`; // ~5.5k estimated prompt tokens with the lens system prompt
const reply = (prompt_tokens, completion_tokens, content = JSON.stringify(lensOutput('tightwad', ['ev_1']))) => ({
  model: 'test-model', choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }], usage: { prompt_tokens, completion_tokens },
});

test('context: an over-long prompt is refused before any request (CONTEXT_OVERFLOW, errorKind CONFIG)', async () => {
  const f = fakeFetch(() => ({ body: reply(10, 10) }));
  const p = createOpenAICompatibleProvider({ baseUrl: 'http://127.0.0.1:9/v1', model: 'test-model', contextTokens: 4096 }, { fetch: f });
  const est = estimatePromptTokens(SYSTEM, BIG_USER);
  assert.ok(est + MIN_OUTPUT_RESERVE_TOKENS > 4096);
  const r = await p.complete({ system: SYSTEM, user: BIG_USER, schema: LENS_OUTPUT_SCHEMA });
  assert.equal(r.ok, false);
  assert.equal(r.errorKind, 'CONFIG');
  assert.match(r.error, /^CONTEXT_OVERFLOW: ~\d+ estimated prompt tokens/);
  assert.match(r.error, /OLLAMA_CONTEXT_LENGTH/);
  assert.equal(f.calls.length, 0, 'no request may be sent');
});

test('context: max_tokens is clamped to what the context leaves; truncation and context shift are INVALID_OUTPUT', async () => {
  const est = estimatePromptTokens(SYSTEM, BIG_USER);
  const minIn = minPromptTokens(SYSTEM, BIG_USER);
  // Fits in 16384: the request carries max_tokens = context - estimate, not 16000.
  let f = fakeFetch(() => ({ body: reply(est - 200, 900) }));
  let p = createOpenAICompatibleProvider({ baseUrl: 'http://127.0.0.1:9/v1', model: 'test-model', contextTokens: 16384 }, { fetch: f });
  const ok = await p.complete({ system: SYSTEM, user: BIG_USER, schema: LENS_OUTPUT_SCHEMA, maxTokens: 16000 });
  assert.equal(ok.ok, true, ok.error);
  assert.equal(f.calls[0].body.max_tokens, 16384 - est);
  // The server evaluated far fewer prompt tokens than the prompt has: it silently truncated the start (the rules).
  f = fakeFetch(() => ({ body: reply(Math.floor(minIn / 2), 900) }));
  p = createOpenAICompatibleProvider({ baseUrl: 'http://127.0.0.1:9/v1', model: 'test-model', contextTokens: 16384 }, { fetch: f });
  const trunc = await p.complete({ system: SYSTEM, user: BIG_USER, schema: LENS_OUTPUT_SCHEMA });
  assert.equal(trunc.ok, false);
  assert.equal(trunc.errorKind, 'INVALID_OUTPUT');
  assert.match(trunc.error, /^CONTEXT_TRUNCATED: endpoint reported \d+ prompt tokens/);
  assert.equal(trunc.json, null, 'a truncated answer is never parsed into output');
  // Prompt + output reached the context (the receipt's cowboy case: 2463 + 3048 >= 4096).
  f = fakeFetch(() => ({ body: reply(2463, 3048) }));
  p = createOpenAICompatibleProvider({ baseUrl: 'http://127.0.0.1:9/v1', model: 'test-model', contextTokens: 4096 }, { fetch: f });
  const shifted = await p.complete({ system: 'TEST FIXTURE short system prompt', user: 'TEST FIXTURE short packet', schema: LENS_OUTPUT_SCHEMA });
  assert.equal(shifted.errorKind, 'INVALID_OUTPUT');
  assert.match(shifted.error, /^CONTEXT_EXHAUSTED: 2463 prompt \+ 3048 output tokens reached the 4096-token context/);
  // Without a known context (hosted API, nothing configured) no context checks apply.
  f = fakeFetch(() => ({ body: reply(5, 5) }));
  p = createOpenAICompatibleProvider({ baseUrl: 'http://127.0.0.1:9/v1', model: 'test-model' }, { fetch: f });
  assert.equal((await p.complete({ system: SYSTEM, user: BIG_USER, schema: LENS_OUTPUT_SCHEMA })).ok, true);
  assert.equal(f.calls[0].body.max_tokens, 16000);
});

test('context: an Ollama endpoint reports its loaded runtime context via /api/ps (default 4096 when not loaded)', async () => {
  const OLLAMA = 'http://127.0.0.1:11434/v1';
  let loaded = { models: [{ name: 'qwen3:8b', model: 'qwen3:8b', context_length: 16384 }] };
  const f = fakeFetch((url) => {
    if (url.endsWith('/api/ps')) return { body: loaded };
    if (url.endsWith('/models')) return { body: { object: 'list', data: [{ id: 'qwen3:8b' }] } };
    return { body: reply(estimatePromptTokens(SYSTEM, BIG_USER) - 300, 800) };
  });
  let t0 = 0;
  const p = createOpenAICompatibleProvider({ baseUrl: OLLAMA, model: 'qwen3:8b' }, { fetch: f, now: () => t0 });
  assert.deepEqual(await p.effectiveContext(), { tokens: 16384, source: 'Ollama /api/ps (loaded runtime context)' });
  const r = await p.complete({ system: SYSTEM, user: BIG_USER, schema: LENS_OUTPUT_SCHEMA });
  assert.equal(r.ok, true, r.error);
  // Not loaded: assume the Ollama default (4096) and refuse the large prompt.
  loaded = { models: [] };
  t0 += 60_000; // past the cache TTL
  assert.equal((await p.effectiveContext()).tokens, OLLAMA_DEFAULT_CONTEXT);
  const refused = await p.complete({ system: SYSTEM, user: BIG_USER, schema: LENS_OUTPUT_SCHEMA });
  assert.match(refused.error, /^CONTEXT_OVERFLOW/);
  // status() surfaces the effective context and warns when it is below the recommended size.
  const s = await p.status();
  assert.equal(s.status, 'CONNECTED');
  assert.equal(s.contextTokens, 4096);
  assert.ok(s.warnings.some((w) => /below the 16384 recommended/.test(w)));
  // A configured context wins over probing.
  const fixed = createOpenAICompatibleProvider({ baseUrl: OLLAMA, model: 'qwen3:8b', contextTokens: 32768 }, { fetch: f });
  assert.equal((await fixed.effectiveContext()).tokens, 32768);
});

test('token parameter: max_completion_tokens for api.openai.com, max_tokens for local servers, configurable', async () => {
  const f = fakeFetch(() => ({ body: reply(5, 5) }));
  const openai = createOpenAICompatibleProvider({ baseUrl: 'https://api.openai.com/v1', model: 'test-model', apiKey: 'test-key-not-real' }, { fetch: f });
  assert.equal(openai.tokenParam, 'max_completion_tokens');
  await openai.complete({ system: 's', user: 'u', schema: LENS_OUTPUT_SCHEMA, maxTokens: 1234 });
  assert.equal(f.calls[0].body.max_completion_tokens, 1234);
  assert.equal('max_tokens' in f.calls[0].body, false);
  const local = createOpenAICompatibleProvider({ baseUrl: 'http://127.0.0.1:1234/v1', model: 'test-model' }, { fetch: f });
  assert.equal(local.tokenParam, 'max_tokens');
  const forced = createOpenAICompatibleProvider({ baseUrl: 'http://127.0.0.1:1234/v1', model: 'test-model', tokenParam: 'max_completion_tokens' }, { fetch: f });
  assert.equal(forced.tokenParam, 'max_completion_tokens');
});

test('status is cached; status({fresh:true}) re-probes the endpoint', async () => {
  handler = (req, res) => json(res, 200, { object: 'list', data: [{ id: 'test-model' }] });
  const p = mk();
  assert.equal((await p.status()).status, 'CONNECTED');
  seen.length = 0;
  handler = (req, res) => json(res, 200, { object: 'list', data: [] });
  assert.equal((await p.status()).status, 'CONNECTED', 'cached within the TTL');
  assert.equal(seen.length, 0, 'no request while cached');
  const fresh = await p.status({ fresh: true });
  assert.equal(fresh.status, 'FAULT');
  assert.match(fresh.detail, /not listed/);
  assert.equal(seen.length, 1);
});
