// TEST FIXTURE / MOCK. Native Ollama adapter (POST /api/chat, GET /api/tags, GET /api/ps) against a local node:http
// stub server. No real Ollama server and no external network are used. Model names, token counts and lens outputs
// below are TEST FIXTURE values, not market data and not real model output.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {
  createOllamaProvider, normalizeOllamaBaseUrl, sameOllamaModel, OLLAMA_DEFAULT_BASE_URL, OLLAMA_DEFAULT_NUM_CTX,
} from '../../server/intel/providers/ollama.js';
import { estimatePromptTokens, minPromptTokens, MIN_OUTPUT_RESERVE_TOKENS } from '../../server/intel/providers/openai-compatible.js';
import { getProvider, status as providerStatus, resolveModelConfig } from '../../server/intel/model-provider.js';
import { runLensAssessments, buildEvidencePacket, hindsightCheck } from '../../server/intel/assessments.js';
import { LENS_OUTPUT_SCHEMA, systemPromptFor } from '../../server/intel/prompts.js';
import {
  ROOT, tempDb, seedFixture, lensOf, lensOutput, FIX_DS, FIX_SYM, FIX_ASOF, MOCK_TRAINING_CUTOFF,
} from './helpers.js';
import path from 'node:path';

const MODEL = 'test-fixture-model:8b';
const NOFILE = path.join(ROOT, 'data', 'test-intel-no-such-config.json');

let server;
let base;
let chat;          // (body, res) => void : /api/chat handler
let tags;          // () => [status, obj]
let ps;            // () => [status, obj]
const seen = [];

const json = (res, status, obj) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(typeof obj === 'string' ? obj : JSON.stringify(obj)); };
const defaults = () => {
  tags = () => [200, { models: [{ name: MODEL, model: MODEL }, { name: 'other-fixture:latest', model: 'other-fixture:latest' }] }];
  ps = () => [200, { models: [] }];
  chat = (body, res) => json(res, 200, reply(JSON.stringify(lensOutput('tightwad', ['ev_1']))));
};

before(async () => {
  server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : null;
      seen.push({ method: req.method, url: req.url, headers: req.headers, body });
      if (req.method === 'GET' && req.url === '/api/tags') { const [s, o] = tags(); return json(res, s, o); }
      if (req.method === 'GET' && req.url === '/api/ps') { const [s, o] = ps(); return json(res, s, o); }
      if (req.method === 'POST' && req.url === '/api/chat') return chat(body, res);
      return json(res, 404, { error: 'not found (TEST STUB)' });
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  defaults();
});
after(async () => {
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
});

/** A native /api/chat reply (TEST FIXTURE). */
function reply(content, extra = {}) {
  return {
    model: MODEL, created_at: '2026-01-05T15:30:00Z', message: { role: 'assistant', content },
    done: true, done_reason: 'stop', prompt_eval_count: 2500, eval_count: 400, ...extra,
  };
}
const SYSTEM = systemPromptFor('tightwad');
const USER = 'TEST FIXTURE packet '.repeat(200);
const mk = (cfg = {}) => createOllamaProvider({ baseUrl: base, model: MODEL, ...cfg });
const call = (p, extra = {}) => p.complete({ system: SYSTEM, user: USER, schema: LENS_OUTPUT_SCHEMA, schemaName: 'vector_lens_assessment', ...extra });
const chats = () => seen.filter((r) => r.url === '/api/chat');

test('request shape: /api/chat with format=<schema>, stream:false and options.num_ctx (default 16384); <think> is stripped', async () => {
  defaults();
  const valid = lensOutput('tightwad', ['ev_1']);
  chat = (body, res) => json(res, 200, reply(`<think>\nreasoning with {"braces": 1}\n</think>\n${JSON.stringify(valid)}`));
  seen.length = 0;
  const p = mk();
  assert.equal(p.kind, 'ollama');
  assert.equal(p.numCtx, OLLAMA_DEFAULT_NUM_CTX);
  assert.equal(OLLAMA_DEFAULT_NUM_CTX, 16384);
  const r = await call(p, { maxTokens: 3000 });
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(r.json, valid);
  assert.deepEqual(r.usage, { in: 2500, out: 400 });
  assert.equal(r.servedModel, MODEL);
  assert.equal(r.errorKind, null);
  const req = chats()[0];
  assert.equal(req.method, 'POST');
  assert.equal(req.body.model, MODEL);
  assert.deepEqual(req.body.messages, [{ role: 'system', content: SYSTEM }, { role: 'user', content: USER }]);
  assert.deepEqual(req.body.format, JSON.parse(JSON.stringify(LENS_OUTPUT_SCHEMA)));
  assert.equal(req.body.stream, false);
  assert.equal(req.body.options.num_ctx, 16384);
  assert.equal(req.body.options.num_predict, 3000);
  assert.equal(req.body.options.temperature, undefined);
  assert.equal(req.headers.authorization, undefined, 'Ollama adapter never sends credentials');
  // Configured num_ctx and temperature travel in options; num_predict is clamped to what the context leaves.
  seen.length = 0;
  const estIn = estimatePromptTokens(SYSTEM, USER);
  const small = mk({ numCtx: estIn + MIN_OUTPUT_RESERVE_TOKENS + 100, temperature: 0.2 });
  chat = (body, res) => json(res, 200, reply(JSON.stringify(valid), { prompt_eval_count: minPromptTokens(SYSTEM, USER) + 10, eval_count: 50 }));
  const r2 = await call(small, { maxTokens: 16000 });
  assert.equal(r2.ok, true, r2.error);
  assert.equal(chats()[0].body.options.num_ctx, estIn + MIN_OUTPUT_RESERVE_TOKENS + 100);
  assert.equal(chats()[0].body.options.num_predict, MIN_OUTPUT_RESERVE_TOKENS + 100);
  assert.equal(chats()[0].body.options.temperature, 0.2);
});

test('CONTEXT_OVERFLOW: a packet that does not fit num_ctx is refused before any request (errorKind CONFIG)', async () => {
  defaults();
  seen.length = 0;
  const r = await call(mk({ numCtx: 2048 }));
  assert.equal(r.ok, false);
  assert.equal(r.errorKind, 'CONFIG');
  assert.match(r.error, /^CONTEXT_OVERFLOW: .*num_ctx 2048.*not sent.*VECTOR_OLLAMA_NUM_CTX/);
  assert.equal(chats().length, 0, 'nothing may be sent when the prompt cannot fit');
});

test('context checks after the call: truncation, context shift (incl. a clamped num_ctx seen in /api/ps), done_reason length', async () => {
  defaults();
  const valid = JSON.stringify(lensOutput('tightwad', ['ev_1']));
  // Prompt evaluated far below its minimum plausible size: the server truncated it.
  chat = (body, res) => json(res, 200, reply(valid, { prompt_eval_count: 30, eval_count: 10 }));
  const trunc = await call(mk());
  assert.equal(trunc.ok, false);
  assert.equal(trunc.errorKind, 'INVALID_OUTPUT');
  assert.match(trunc.error, /^CONTEXT_TRUNCATED: Ollama reported 30 prompt tokens/);
  assert.equal(trunc.rawText, valid, 'raw text is kept for the audit trail');
  // prompt + output reached num_ctx.
  chat = (body, res) => json(res, 200, reply(valid, { prompt_eval_count: 4000, eval_count: 12384 }));
  const shift = await call(mk());
  assert.equal(shift.errorKind, 'INVALID_OUTPUT');
  assert.match(shift.error, /^CONTEXT_EXHAUSTED: 4000 prompt \+ 12384 output tokens reached the 16384-token context/);
  // Ollama clamped the requested 16384 to 8192 (reported by /api/ps): 4000 + 4500 already exhausts it.
  ps = () => [200, { models: [{ name: MODEL, model: MODEL, context_length: 8192, size_vram: 1 }] }];
  chat = (body, res) => json(res, 200, reply(valid, { prompt_eval_count: 4000, eval_count: 4500 }));
  const clamped = await call(mk());
  assert.equal(clamped.errorKind, 'INVALID_OUTPUT');
  assert.match(clamped.error, /reached the 8192-token context \[Ollama \/api\/ps reports 8192 loaded context; the requested num_ctx 16384 was clamped\]/);
  // Same usage with the full context confirmed by /api/ps is fine.
  ps = () => [200, { models: [{ name: MODEL, model: MODEL, context_length: 16384 }] }];
  assert.equal((await call(mk())).ok, true);
  ps = () => [200, { models: [] }];
  chat = (body, res) => json(res, 200, reply(valid, { done_reason: 'length' }));
  const len = await call(mk());
  assert.equal(len.errorKind, 'INVALID_OUTPUT');
  assert.match(len.error, /^TRUNCATED: done_reason length/);
  chat = (body, res) => json(res, 200, reply(valid, { done: false, done_reason: null }));
  assert.match((await call(mk())).error, /^TRUNCATED: response not done/);
});

test('invalid content is INVALID_OUTPUT: bad JSON, schema violation, unterminated reasoning, empty answer', async () => {
  defaults();
  chat = (body, res) => json(res, 200, reply('not json at all'));
  const bad = await call(mk());
  assert.equal(bad.errorKind, 'INVALID_OUTPUT');
  assert.match(bad.error, /^INVALID_JSON/);
  chat = (body, res) => json(res, 200, reply(JSON.stringify({ lens: 'tightwad' })));
  const schema = await call(mk());
  assert.equal(schema.errorKind, 'INVALID_OUTPUT');
  assert.match(schema.error, /^SCHEMA_INVALID: .*required/);
  assert.deepEqual(schema.json, { lens: 'tightwad' });
  chat = (body, res) => json(res, 200, reply('<think>still thinking when the budget ran out'));
  assert.match((await call(mk())).error, /^EMPTY_OUTPUT/);
  chat = (body, res) => json(res, 200, reply(''));
  assert.match((await call(mk())).error, /^EMPTY_OUTPUT/);
  // A literal "<think>" inside a JSON string value is never cut.
  const tricky = lensOutput('tightwad', ['ev_1'], { thesis: 'TEST MOCK text mentioning <think> literally [ev_1]' });
  chat = (body, res) => json(res, 200, reply(JSON.stringify(tricky)));
  const ok = await call(mk());
  assert.equal(ok.ok, true, ok.error);
  assert.equal(ok.json.thesis, tricky.thesis);
  // A separate message.thinking field is ignored, never parsed as the answer.
  chat = (body, res) => json(res, 200, { ...reply(JSON.stringify(tricky)), message: { role: 'assistant', content: JSON.stringify(tricky), thinking: '{"lens":"cowboy"}' } });
  assert.equal((await call(mk())).json.lens, 'tightwad');
});

test('HTTP and transport errors map to typed error kinds', async () => {
  defaults();
  chat = (body, res) => json(res, 404, { error: `model "${MODEL}" not found, try pulling it first` });
  const nf = await call(mk());
  assert.equal(nf.errorKind, 'CONFIG');
  assert.match(nf.error, /^HTTP 404: model ".*" not found.*ollama pull/);
  chat = (body, res) => json(res, 500, { error: 'TEST STUB: model requires more system memory' });
  const e500 = await call(mk());
  assert.equal(e500.errorKind, 'HTTP');
  assert.match(e500.error, /HTTP 500: TEST STUB: model requires more system memory/);
  chat = (body, res) => json(res, 400, { error: 'invalid format' });
  assert.equal((await call(mk())).errorKind, 'BAD_REQUEST');
  chat = (body, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<html>not json</html>'); };
  assert.equal((await call(mk())).errorKind, 'PROTOCOL');
  chat = (body, res) => json(res, 200, { model: MODEL, done: true });
  const noMsg = await call(mk());
  assert.equal(noMsg.errorKind, 'PROTOCOL');
  assert.match(noMsg.error, /message\.content/);
  // Per-call timeout aborts the request.
  chat = () => { /* never answers */ };
  const slow = await call(mk(), { timeoutMs: 100 });
  assert.equal(slow.errorKind, 'TIMEOUT');
  assert.match(slow.error, /no response within 100 ms/);
  // Nothing listening: NETWORK.
  const dead = createOllamaProvider({ baseUrl: 'http://127.0.0.1:9', model: MODEL });
  const net = await call(dead);
  assert.equal(net.errorKind, 'NETWORK');
  defaults();
});

test('status: /api/tags + /api/ps -> CONNECTED / FAULT / DISCONNECTED; cached with a fresh bypass; never throws', async () => {
  defaults();
  const p = mk();
  const s = await p.status();
  assert.equal(s.status, 'CONNECTED', s.detail);
  assert.equal(s.contextTokens, 16384);
  assert.deepEqual(s.warnings, []);
  assert.match(s.detail, /every request sets num_ctx 16384; not loaded/);
  // Loaded with a different context: Ollama will reload it with num_ctx on the next request.
  ps = () => [200, { models: [{ name: MODEL, model: MODEL, context_length: 4096 }] }];
  const loaded = await mk().status();
  assert.match(loaded.detail, /loaded now with context 4096 \(Ollama reloads it with num_ctx 16384 on the next request\)/);
  // Cached for 15 s; {fresh:true} re-probes.
  tags = () => [200, { models: [] }];
  assert.equal((await p.status()).status, 'CONNECTED', 'cached value within the TTL');
  const fresh = await p.status({ fresh: true });
  assert.equal(fresh.status, 'FAULT');
  assert.match(fresh.detail, /not pulled on this Ollama server.*ollama pull test-fixture-model:8b/);
  tags = () => [500, { error: 'boom' }];
  assert.match((await mk().status()).detail, /GET \/api\/tags returned HTTP 500/);
  tags = () => [200, '{"unexpected": true}'];
  assert.match((await mk().status()).detail, /did not return an Ollama model list/);
  // An untagged configured name matches "<name>:latest".
  tags = () => [200, { models: [{ name: 'plain-fixture:latest', model: 'plain-fixture:latest' }] }];
  assert.equal((await mk({ model: 'plain-fixture' }).status()).status, 'CONNECTED');
  defaults();
  // Small num_ctx: CONNECTED with a warning.
  const warn = await mk({ numCtx: 8192 }).status();
  assert.equal(warn.status, 'CONNECTED');
  assert.match(warn.warnings[0], /num_ctx 8192 is below the 16384 recommended/);
  // Unreachable / unconfigured.
  const dead = await createOllamaProvider({ baseUrl: 'http://127.0.0.1:9', model: MODEL }).status();
  assert.equal(dead.status, 'DISCONNECTED');
  assert.match(dead.detail, /Ollama unreachable/);
  const noModel = createOllamaProvider({ baseUrl: base });
  assert.equal((await noModel.status()).status, 'DISCONNECTED');
  const cfgErr = await call(noModel);
  assert.equal(cfgErr.errorKind, 'CONFIG');
  assert.match(cfgErr.error, /VECTOR_OLLAMA_MODEL/);
  const throwing = createOllamaProvider({ baseUrl: base, model: MODEL }, { fetch: () => { throw new Error('TEST boom'); } });
  assert.equal((await throwing.status()).status, 'DISCONNECTED');
});

test('base URL normalisation and model-name matching', () => {
  assert.equal(normalizeOllamaBaseUrl('http://127.0.0.1:11434/'), 'http://127.0.0.1:11434');
  assert.equal(normalizeOllamaBaseUrl('http://127.0.0.1:11434/v1'), 'http://127.0.0.1:11434');
  assert.equal(normalizeOllamaBaseUrl('http://127.0.0.1:11434/api/'), 'http://127.0.0.1:11434');
  assert.equal(normalizeOllamaBaseUrl('https://gpu.example.test/ollama?x=1#y'), 'https://gpu.example.test/ollama');
  assert.throws(() => normalizeOllamaBaseUrl('http://user:pw@127.0.0.1:11434'), /credentials/);
  assert.throws(() => normalizeOllamaBaseUrl('ftp://127.0.0.1'), /http/);
  assert.throws(() => normalizeOllamaBaseUrl(''), /not set/);
  assert.equal(OLLAMA_DEFAULT_BASE_URL, 'http://127.0.0.1:11434');
  assert.equal(createOllamaProvider({ model: MODEL }).endpointLabel, 'http://127.0.0.1:11434');
  assert.ok(sameOllamaModel('qwen-fixture:latest', 'qwen-fixture'));
  assert.ok(sameOllamaModel('qwen-fixture', 'qwen-fixture:latest'));
  assert.ok(!sameOllamaModel('qwen-fixture:8b', 'qwen-fixture'));
  assert.ok(!sameOllamaModel(null, 'x'));
});

test('cap-relevant error kinds: CONNECT only when the connection is refused before any response; a body dropped mid-read is NETWORK', async () => {
  // A port nothing listens on (bound, then released): ECONNREFUSED before any request byte reached a server.
  const probe = http.createServer();
  await new Promise((r) => probe.listen(0, '127.0.0.1', r));
  const closedPort = probe.address().port;
  await new Promise((r) => probe.close(r));
  const refused = await call(createOllamaProvider({ baseUrl: `http://127.0.0.1:${closedPort}`, model: MODEL }));
  assert.equal(refused.errorKind, 'CONNECT');
  assert.match(refused.error, /ECONNREFUSED/);
  // Headers arrive, then the connection drops while the body is read: the model may already have answered.
  defaults();
  chat = (body, res) => {
    res.writeHead(200, { 'content-type': 'application/json', 'content-length': '5000' });
    res.write('{"model":"test-fixture-model:8b","message":');
    setTimeout(() => res.socket.destroy(), 20);
  };
  const dropped = await call(mk());
  assert.equal(dropped.errorKind, 'NETWORK');
  assert.match(dropped.error, /response body read failed/);
  defaults();
});

test('ollama.timeoutMs is the per-call timeout of lens calls (not the global default) and is reported as limits.timeoutMs', async () => {
  const t = tempDb();
  const orig = AbortSignal.timeout;
  const timeouts = [];
  try {
    seedFixture(t.db);
    const packet = buildEvidencePacket(t.db, FIX_DS, FIX_SYM, FIX_ASOF, { persist: false });
    defaults();
    chat = (body, res) => {
      const lens = lensOf(body.messages[0].content);
      json(res, 200, reply(JSON.stringify(lensOutput(lens, packet.evidenceIds)), { prompt_eval_count: Math.ceil((body.messages[0].content.length + body.messages[1].content.length) / 4) }));
    };
    const env = { VECTOR_MODEL_PROVIDER: 'ollama', VECTOR_OLLAMA_BASE_URL: base, VECTOR_OLLAMA_MODEL: MODEL };
    const p = getProvider({ trainingCutoff: MOCK_TRAINING_CUTOFF, ollama: { timeoutMs: 600_000 } }, {}, { env, file: NOFILE });
    assert.equal(p.defaultTimeoutMs, 600_000);
    assert.equal(p.config.timeoutMs, 120_000, 'the global default is unchanged');
    AbortSignal.timeout = (ms) => { timeouts.push(ms); return orig.call(AbortSignal, ms); };
    const res = await runLensAssessments(t.db, p, { session_id: 'ollama-timeout', ds: FIX_DS, sym: FIX_SYM, asOf: FIX_ASOF, packet, lenses: ['tightwad'] });
    AbortSignal.timeout = orig;
    assert.equal(res.status, 'COMPLETED');
    assert.ok(timeouts.includes(600_000), `the /api/chat call used the ollama timeout (saw ${timeouts.join(', ')})`);
    assert.ok(!timeouts.includes(120_000), 'never the global 120 s default');
    const s = await providerStatus({ ollama: { timeoutMs: 600_000 } }, {}, { env, file: NOFILE });
    assert.equal(s.limits.timeoutMs, 600_000);
  } finally {
    AbortSignal.timeout = orig;
    t.cleanup();
    defaults();
  }
});

test('selection: VECTOR_MODEL_PROVIDER=ollama with VECTOR_OLLAMA_* settings; num_ctx default, override and validation', async () => {
  const env = { VECTOR_MODEL_PROVIDER: 'ollama', VECTOR_OLLAMA_BASE_URL: base, VECTOR_OLLAMA_MODEL: MODEL };
  const c = resolveModelConfig({}, { env, file: NOFILE });
  assert.equal(c.providerValid, true);
  assert.deepEqual({ ...c.ollama }, { baseUrl: base, model: MODEL, numCtx: 16384, temperature: null, timeoutMs: c.timeoutMs });
  assert.equal(resolveModelConfig({}, { env: { VECTOR_MODEL_PROVIDER: 'ollama' }, file: NOFILE }).ollama.baseUrl, 'http://127.0.0.1:11434');
  assert.equal(resolveModelConfig({}, { env: { ...env, VECTOR_OLLAMA_NUM_CTX: '32768' }, file: NOFILE }).ollama.numCtx, 32768);
  const bad = resolveModelConfig({}, { env: { ...env, VECTOR_OLLAMA_NUM_CTX: 'lots' }, file: NOFILE });
  assert.equal(bad.ollama.numCtx, 16384);
  assert.ok(bad.warnings.some((w) => /ollama\.numCtx/.test(w)));
  assert.equal(resolveModelConfig({ ollama: { numCtx: 24576 } }, { env, file: NOFILE }).ollama.numCtx, 24576);
  const p = getProvider({}, {}, { env: { ...env, VECTOR_OLLAMA_NUM_CTX: '20000' }, file: NOFILE });
  assert.equal(p.kind, 'ollama');
  assert.equal(p.model, MODEL);
  assert.equal(p.numCtx, 20000);
  assert.equal(p.config.provider, 'ollama');
  // status() reports the requested context as the effective limit.
  defaults();
  const s = await providerStatus({}, {}, { env, file: NOFILE });
  assert.equal(s.status, 'CONNECTED', s.detail);
  assert.equal(s.provider, 'ollama');
  assert.equal(s.limits.contextTokens, 16384);
  // Unknown training cutoff for a local model: the hindsight guard treats it as unsafe until configured.
  assert.equal(hindsightCheck(p, '2026-10-07').code, 'MODEL_TRAINING_CUTOFF_UNKNOWN');
  const withCutoff = getProvider({ trainingCutoff: MOCK_TRAINING_CUTOFF }, {}, { env, file: NOFILE });
  assert.equal(withCutoff.config.trainingCutoff, MOCK_TRAINING_CUTOFF);
  assert.equal(hindsightCheck(withCutoff, '2026-10-07').ok, true);
  // Unknown provider kinds list ollama as an option.
  const unknown = await providerStatus({}, null, { env: { VECTOR_MODEL_PROVIDER: 'olama' }, file: NOFILE });
  assert.equal(unknown.status, 'FAULT');
  assert.match(unknown.detail, /anthropic \| openai-compatible \| ollama \| none/);
});

test('end to end: three independent lens calls through the native Ollama adapter on one fixture packet', async () => {
  const t = tempDb();
  try {
    seedFixture(t.db);
    const packet = buildEvidencePacket(t.db, FIX_DS, FIX_SYM, FIX_ASOF, { persist: false });
    defaults();
    chat = (body, res) => {
      const lens = lensOf(body.messages[0].content);
      json(res, 200, reply(`<think>TEST MOCK reasoning</think>${JSON.stringify(lensOutput(lens, packet.evidenceIds))}`, { prompt_eval_count: Math.ceil((body.messages[0].content.length + body.messages[1].content.length) / 4), eval_count: 500 }));
    };
    seen.length = 0;
    const p = getProvider({ trainingCutoff: MOCK_TRAINING_CUTOFF }, {}, {
      env: { VECTOR_MODEL_PROVIDER: 'ollama', VECTOR_OLLAMA_BASE_URL: base, VECTOR_OLLAMA_MODEL: MODEL }, file: NOFILE,
    });
    const res = await runLensAssessments(t.db, p, { session_id: 'ollama-e2e', ds: FIX_DS, sym: FIX_SYM, asOf: FIX_ASOF, packet });
    assert.equal(res.status, 'COMPLETED');
    assert.deepEqual(res.results.map((r) => [r.lens, r.status, r.errorKind]), [['cowboy', 'OK', null], ['pragmatist', 'OK', null], ['tightwad', 'OK', null]]);
    const calls = chats();
    assert.equal(calls.length, 3);
    assert.equal(new Set(calls.map((c) => c.body.messages[1].content)).size, 1, 'identical packet for every lens');
    assert.equal(new Set(calls.map((c) => c.body.messages[0].content)).size, 3, 'distinct lens system prompts');
    for (const c of calls) {
      assert.equal(c.body.options.num_ctx, 16384);
      assert.equal(c.body.stream, false);
      assert.ok(c.body.format && c.body.format.properties.lens);
    }
    const rows = t.db.prepare("SELECT provider, model, status FROM assessments WHERE session_id = 'ollama-e2e'").all();
    assert.equal(rows.length, 3);
    assert.ok(rows.every((r) => r.provider === 'ollama' && r.model === MODEL && r.status === 'OK'));
  } finally {
    t.cleanup();
  }
});
