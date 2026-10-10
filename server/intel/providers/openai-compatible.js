// OpenAI-compatible ModelProvider adapter (Chat Completions over fetch, no SDK).
// Works with local servers (Ollama http://127.0.0.1:11434/v1, LM Studio http://127.0.0.1:1234/v1) and with hosted
// OpenAI-compatible APIs. The API key (optional for local servers) comes from the environment only and is never
// included in errors, labels or receipts.
//
// Context window. Local servers silently truncate a prompt that exceeds their context (Ollama keeps the tail and drops
// the start, where the system prompt and hard rules are) and still answer HTTP 200. So:
//   * the effective context comes from config (VECTOR_OPENAI_CONTEXT_TOKENS), else for an Ollama endpoint from
//     GET /api/ps (the loaded runtime context, not the model's trained maximum), else Ollama's default of 4096;
//   * before calling, a conservative prompt-size estimate that does not fit (with an output reserve) is refused as
//     CONTEXT_OVERFLOW (errorKind CONFIG) without calling, and max_tokens is clamped to what is left;
//   * after calling, a reported prompt size far below the minimum plausible size (truncation) or prompt+output at or
//     above the context (context shift) is INVALID_OUTPUT, never OK.
// Ollama's /v1 endpoint cannot set num_ctx: run the server with OLLAMA_CONTEXT_LENGTH=16384 (or a Modelfile
// `PARAMETER num_ctx 16384`) and set VECTOR_OPENAI_CONTEXT_TOKENS to the same value - or use the native Ollama adapter
// (VECTOR_MODEL_PROVIDER=ollama, providers/ollama.js), which sets num_ctx per request.
import { validateSchema } from '../prompts.js';

const STATUS_TIMEOUT_MS = 3_000;
const STATUS_TTL_MS = 15_000;
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_TOKENS = 16_000;
export const OLLAMA_DEFAULT_CONTEXT = 4096;
export const MIN_OUTPUT_RESERVE_TOKENS = 2048;      // reasoning models (qwen3) spent ~1.5k-3k output tokens on thinking
export const EST_CHARS_PER_TOKEN = 2.8;             // conservative (high) estimate; measured ~2.96 chars/token on packets
export const MIN_CHARS_PER_TOKEN_BOUND = 5.0;       // no tokenizer packs this JSON-heavy text denser than ~5 chars/token
export const RECOMMENDED_CONTEXT_TOKENS = 16384;
const TEMPLATE_OVERHEAD_TOKENS = 64;

/** Conservative (over-)estimate of the prompt's token count. */
export function estimatePromptTokens(system, user) {
  return Math.ceil((String(system ?? '').length + String(user ?? '').length) / EST_CHARS_PER_TOKEN) + TEMPLATE_OVERHEAD_TOKENS;
}

/** Lower bound on the prompt's token count: a server reporting fewer evaluated prompt tokens has truncated it. */
export function minPromptTokens(system, user) {
  return Math.floor((String(system ?? '').length + String(user ?? '').length) / MIN_CHARS_PER_TOKEN_BOUND);
}

function isOllamaBase(base) {
  try { return new URL(base).port === '11434'; } catch { return false; }
}

function defaultTokenParam(base) {
  try {
    const h = new URL(base).hostname.toLowerCase();
    return h === 'api.openai.com' || h.endsWith('.openai.com') ? 'max_completion_tokens' : 'max_tokens';
  } catch { return 'max_tokens'; }
}

const CONTEXT_ADVICE = `raise the server context (Ollama: OLLAMA_CONTEXT_LENGTH=${RECOMMENDED_CONTEXT_TOKENS} or Modelfile PARAMETER num_ctx) and set VECTOR_OPENAI_CONTEXT_TOKENS to match; for Ollama, VECTOR_MODEL_PROVIDER=ollama sets num_ctx per request instead`;

function excerpt(s, n = 300) {
  const t = String(s ?? '');
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

/** Validate and normalise a base URL (http/https, no credentials, no trailing slash). Throws on invalid input. */
export function normalizeBaseUrl(raw) {
  if (typeof raw !== 'string' || !raw.trim()) throw new Error('base URL is not set (VECTOR_OPENAI_BASE_URL)');
  let u;
  try { u = new URL(raw.trim()); } catch { throw new Error('base URL is not a valid URL'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('base URL must be http(s)');
  if (u.username || u.password) throw new Error('base URL must not embed credentials; use VECTOR_OPENAI_API_KEY');
  u.search = '';
  u.hash = '';
  return u.toString().replace(/\/+$/, '');
}

const parses = (s) => { try { JSON.parse(s); return true; } catch { return false; } };
const unfence = (s) => { const m = s.match(/^```(?:json)?\s*\n([\s\S]*?)\n?```$/i); return m ? m[1].trim() : s; };

/**
 * Remove reasoning wrappers some local models emit inline (<think>…</think>), plus a single surrounding Markdown
 * code fence. Text that is already valid JSON is returned unchanged (a literal "<think>" inside a JSON string value is
 * never cut). Only a LEADING reasoning block, an orphan closing tag before the answer, or an unterminated block AFTER
 * a complete JSON answer is removed. The result is still strictly JSON-parsed and schema-validated by the caller.
 */
export function stripThink(text) {
  let out = String(text ?? '').trim();
  if (parses(out)) return out;
  for (let m = /^<think>[\s\S]*?<\/think>/i.exec(out); m; m = /^<think>[\s\S]*?<\/think>/i.exec(out)) out = out.slice(m[0].length).trim();
  if (!out.startsWith('{') && !out.startsWith('```')) {
    const close = out.toLowerCase().indexOf('</think>'); // orphan closing tag: the template consumed the opener
    if (close >= 0) out = out.slice(close + '</think>'.length).trim();
  }
  out = unfence(out);
  if (parses(out)) return out;
  const lower = out.toLowerCase();
  for (let i = lower.indexOf('<think>'); i >= 0; i = lower.indexOf('<think>', i + 1)) {
    const head = unfence(out.slice(0, i).trim()); // unterminated reasoning block after a complete answer
    if (head && parses(head)) return head;
  }
  if (/^<think>/i.test(out)) return ''; // reasoning that never closed: no answer
  return out;
}

function result(fields) {
  return {
    ok: false, json: null, rawText: null, refusal: null, usage: { in: null, out: null }, latencyMs: 0,
    error: null, errorKind: null, servedModel: null, fallbackUsed: false, ...fields,
  };
}

function httpKind(status) {
  if (status === 401 || status === 403) return 'AUTH';
  if (status === 429) return 'RATE_LIMIT';
  if (status === 404) return 'CONFIG';
  if (status === 400 || status === 422) return 'BAD_REQUEST';
  return 'HTTP';
}

// Connection-establishment failures: fetch rejected before any request bytes could reach the endpoint.
const CONNECT_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT']);

/**
 * Kind of a fetch() / body-read failure. TIMEOUT for an abort; CONNECT only when fetch() itself rejected before any
 * response with a connection-establishment cause (nothing was sent, so nothing was generated or billed); every other
 * failure — incl. a connection dropped while the response body was read — is NETWORK: the endpoint may already have
 * produced (and billed) the completion, so it counts against the call caps.
 */
function fetchErrorKind(e, { beforeResponse = false } = {}) {
  if (e?.name === 'TimeoutError' || e?.name === 'AbortError') return 'TIMEOUT';
  const code = e?.cause?.code ?? e?.code;
  if (beforeResponse && CONNECT_CODES.has(code)) return 'CONNECT';
  return 'NETWORK';
}

/**
 * @param {{baseUrl?:string, model?:string, apiKey?:string|null, timeoutMs?:number, maxTokens?:number, temperature?:number,
 *          contextTokens?:number|null, tokenParam?:'max_tokens'|'max_completion_tokens'|null}} cfg
 * @param {{fetch?:typeof fetch, now?:()=>number}} deps
 */
export function createOpenAICompatibleProvider(cfg = {}, deps = {}) {
  const fetchImpl = deps.fetch || globalThis.fetch;
  const now = deps.now || Date.now;
  let base = null;
  let configError = null;
  try { base = normalizeBaseUrl(cfg.baseUrl); } catch (e) { configError = e.message; }
  const model = typeof cfg.model === 'string' && cfg.model.trim() ? cfg.model.trim() : null;
  if (!configError && !model) configError = 'model is not set (VECTOR_OPENAI_MODEL)';
  const apiKey = typeof cfg.apiKey === 'string' && cfg.apiKey ? cfg.apiKey : null;
  const defaultTimeoutMs = Number.isInteger(cfg.timeoutMs) && cfg.timeoutMs > 0 ? cfg.timeoutMs : DEFAULT_TIMEOUT_MS;
  const defaultMaxTokens = Number.isInteger(cfg.maxTokens) && cfg.maxTokens > 0 ? cfg.maxTokens : DEFAULT_MAX_TOKENS;
  const temperature = typeof cfg.temperature === 'number' && Number.isFinite(cfg.temperature) ? cfg.temperature : null;
  const configuredContext = Number.isInteger(cfg.contextTokens) && cfg.contextTokens > 0 ? cfg.contextTokens : null;
  const ollama = base ? isOllamaBase(base) : false;
  // OpenAI's reasoning models reject max_tokens; local servers expect it.
  const tokenParam = cfg.tokenParam === 'max_tokens' || cfg.tokenParam === 'max_completion_tokens' ? cfg.tokenParam : defaultTokenParam(base);
  let statusCache = null;
  let psCache = null;

  const headers = (json) => ({
    ...(json ? { 'content-type': 'application/json' } : {}),
    accept: 'application/json',
    ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
  });

  /**
   * Effective context window {tokens, source}; tokens null = unknown (hosted APIs reject over-long prompts with an
   * error instead of truncating). Never throws.
   */
  async function effectiveContext({ fresh = false } = {}) {
    if (configuredContext) return { tokens: configuredContext, source: 'configured (VECTOR_OPENAI_CONTEXT_TOKENS)' };
    if (!ollama) return { tokens: null, source: 'unknown (not configured)' };
    if (!fresh && psCache && now() - psCache.at < STATUS_TTL_MS) return psCache.value;
    let value = { tokens: OLLAMA_DEFAULT_CONTEXT, source: `Ollama default assumed (${OLLAMA_DEFAULT_CONTEXT}); model not loaded or /api/ps unavailable` };
    try {
      const res = await fetchImpl(new URL('/api/ps', base).href, { method: 'GET', headers: headers(false), signal: AbortSignal.timeout(STATUS_TIMEOUT_MS) });
      if (res.ok) {
        const data = JSON.parse(await res.text());
        const m = (Array.isArray(data?.models) ? data.models : []).find((x) => [x?.name, x?.model].some((n) => n === model || n === `${model}:latest`));
        if (Number.isInteger(m?.context_length) && m.context_length > 0) value = { tokens: m.context_length, source: 'Ollama /api/ps (loaded runtime context)' };
      }
    } catch { /* keep the conservative default */ }
    psCache = { at: now(), value };
    return value;
  }

  async function complete({ system, user, schema, schemaName = 'vector_output', maxTokens, timeoutMs } = {}) {
    const t0 = now();
    const lat = () => now() - t0;
    if (configError) return result({ error: configError, errorKind: 'CONFIG' });
    if (typeof system !== 'string' || typeof user !== 'string' || !schema) {
      return result({ error: 'complete() requires system, user and schema', errorKind: 'CONFIG' });
    }
    const tMs = Number.isInteger(timeoutMs) && timeoutMs > 0 ? timeoutMs : defaultTimeoutMs;
    const ctx = await effectiveContext();
    const estIn = estimatePromptTokens(system, user);
    let outTokens = Number.isInteger(maxTokens) && maxTokens > 0 ? maxTokens : defaultMaxTokens;
    if (ctx.tokens) {
      // A configuration problem (the served context is too small), not a model answer: errorKind CONFIG, so callers
      // treat it like any other unusable configuration (the agent runner blocks instead of retrying every minute).
      if (estIn + MIN_OUTPUT_RESERVE_TOKENS > ctx.tokens) {
        return result({
          error: `CONTEXT_OVERFLOW: ~${estIn} estimated prompt tokens + ${MIN_OUTPUT_RESERVE_TOKENS} output reserve exceed the context of ${ctx.tokens} tokens [${ctx.source}]; not sent. To fix: ${CONTEXT_ADVICE}.`,
          errorKind: 'CONFIG', latencyMs: lat(),
        });
      }
      outTokens = Math.min(outTokens, ctx.tokens - estIn);
    }
    const body = {
      model,
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      response_format: { type: 'json_schema', json_schema: { name: schemaName, schema, strict: true } },
      [tokenParam]: outTokens,
      stream: false,
      ...(temperature !== null ? { temperature } : {}),
    };
    let res;
    let text;
    try {
      const signal = AbortSignal.timeout(tMs);
      res = await fetchImpl(`${base}/chat/completions`, { method: 'POST', headers: headers(true), body: JSON.stringify(body), signal });
    } catch (e) {
      const kind = fetchErrorKind(e, { beforeResponse: true });
      return result({
        error: kind === 'TIMEOUT' ? `no response within ${tMs} ms` : `request failed: ${excerpt(e?.cause?.code || e?.message, 120)}`,
        errorKind: kind, latencyMs: lat(),
      });
    }
    try {
      text = await res.text();
    } catch (e) {
      // The endpoint answered (headers arrived): the completion may already be generated, so this is never CONNECT.
      const kind = fetchErrorKind(e);
      return result({
        error: kind === 'TIMEOUT' ? `response body not complete within ${tMs} ms` : `response body read failed: ${excerpt(e?.cause?.code || e?.message, 120)}`,
        errorKind: kind, latencyMs: lat(),
      });
    }
    if (!res.ok) {
      return result({ error: `HTTP ${res.status}: ${excerpt(text, 200)}`, errorKind: httpKind(res.status), latencyMs: lat() });
    }
    let data;
    try { data = JSON.parse(text); } catch {
      return result({ error: 'endpoint returned non-JSON response', errorKind: 'PROTOCOL', latencyMs: lat() });
    }
    const usage = { in: data?.usage?.prompt_tokens ?? null, out: data?.usage?.completion_tokens ?? null };
    const servedModel = typeof data?.model === 'string' ? data.model : model;
    const choice = Array.isArray(data?.choices) ? data.choices[0] : null;
    const msg = choice?.message;
    const base2 = { usage, latencyMs: lat(), servedModel };
    if (!msg) return result({ ...base2, error: 'response has no choices[0].message', errorKind: 'PROTOCOL' });
    // Refusals are checked before content is used.
    if (typeof msg.refusal === 'string' && msg.refusal) {
      return result({ ...base2, refusal: { category: null, explanation: excerpt(msg.refusal, 1000) }, error: 'REFUSED', errorKind: 'REFUSAL' });
    }
    if (choice.finish_reason === 'content_filter') {
      return result({ ...base2, refusal: { category: 'content_filter', explanation: null }, error: 'REFUSED', errorKind: 'REFUSAL' });
    }
    const rawText = typeof msg.content === 'string'
      ? msg.content
      : Array.isArray(msg.content) ? msg.content.filter((p) => p?.type === 'text').map((p) => p.text).join('') : '';
    const withRaw = { ...base2, rawText };
    // Context checks come before any parsing: a truncated or context-shifted answer is never stored as OK.
    if (ctx.tokens && Number.isFinite(usage.in)) {
      const minIn = minPromptTokens(system, user);
      if (usage.in < minIn) {
        return result({ ...withRaw, error: `CONTEXT_TRUNCATED: endpoint reported ${usage.in} prompt tokens, below the ~${minIn} minimum for this prompt (~${estIn} estimated); the server most likely truncated the prompt (or counted only uncached tokens), so the answer cannot be trusted. To fix: ${CONTEXT_ADVICE}.`, errorKind: 'INVALID_OUTPUT' });
      }
      if (Number.isFinite(usage.out) && usage.in + usage.out >= ctx.tokens) {
        return result({ ...withRaw, error: `CONTEXT_EXHAUSTED: ${usage.in} prompt + ${usage.out} output tokens reached the ${ctx.tokens}-token context (the server shifts or drops context at this point). To fix: ${CONTEXT_ADVICE}.`, errorKind: 'INVALID_OUTPUT' });
      }
    }
    if (choice.finish_reason === 'length') return result({ ...withRaw, error: 'TRUNCATED: finish_reason length', errorKind: 'INVALID_OUTPUT' });
    const cleaned = stripThink(rawText);
    if (!cleaned) return result({ ...withRaw, error: 'EMPTY_OUTPUT', errorKind: 'INVALID_OUTPUT' });
    let json;
    try { json = JSON.parse(cleaned); } catch (e) {
      return result({ ...withRaw, error: `INVALID_JSON: ${excerpt(e.message, 160)}`, errorKind: 'INVALID_OUTPUT' });
    }
    const errs = validateSchema(json, schema);
    if (errs.length) return result({ ...withRaw, json, error: `SCHEMA_INVALID: ${errs.slice(0, 10).join('; ')}`, errorKind: 'INVALID_OUTPUT' });
    return result({ ...withRaw, ok: true, json });
  }

  /** Never throws. GET {base}/models within 3 s and confirm the configured model is listed. Cached for 15 s; {fresh:true} bypasses the cache. */
  async function status({ fresh = false } = {}) {
    if (!fresh && statusCache && now() - statusCache.at < STATUS_TTL_MS) return statusCache.value;
    let value;
    try {
      if (configError) {
        value = { status: 'DISCONNECTED', detail: `OpenAI-compatible endpoint not configured: ${configError}` };
      } else {
        let res;
        let text;
        try {
          res = await fetchImpl(`${base}/models`, { method: 'GET', headers: headers(false), signal: AbortSignal.timeout(STATUS_TIMEOUT_MS) });
          text = await res.text();
        } catch (e) {
          value = fetchErrorKind(e) === 'TIMEOUT'
            ? { status: 'DISCONNECTED', detail: `no response from ${base}/models within ${STATUS_TIMEOUT_MS} ms` }
            : { status: 'DISCONNECTED', detail: `endpoint unreachable (${excerpt(e?.cause?.code || e?.message, 80)})` };
        }
        if (!value) {
          if (!res.ok) {
            value = { status: 'FAULT', detail: res.status === 401 || res.status === 403 ? `authentication rejected (HTTP ${res.status})` : `GET /models returned HTTP ${res.status}` };
          } else {
            let ids = null;
            try {
              const data = JSON.parse(text);
              ids = Array.isArray(data?.data) ? data.data.map((m) => m?.id).filter((x) => typeof x === 'string') : null;
            } catch { ids = null; }
            if (ids === null) value = { status: 'FAULT', detail: 'GET /models did not return an OpenAI-style model list' };
            else if (!ids.includes(model) && !ids.includes(`models/${model}`)) value = { status: 'FAULT', detail: `model "${model}" is not listed by the endpoint (${ids.length} models listed)` };
            else {
              const ctx = await effectiveContext({ fresh });
              const small = ctx.tokens && ctx.tokens < RECOMMENDED_CONTEXT_TOKENS;
              value = {
                status: 'CONNECTED',
                detail: `endpoint reachable; model ${model} listed; context ${ctx.tokens ?? 'unknown'} tokens [${ctx.source}]`,
                contextTokens: ctx.tokens,
                warnings: small ? [`context ${ctx.tokens} tokens is below the ${RECOMMENDED_CONTEXT_TOKENS} recommended for VECTOR evidence packets (~5k prompt tokens plus reasoning output); assessments that do not fit are refused as CONTEXT_OVERFLOW. To fix: ${CONTEXT_ADVICE}.`] : [],
              };
            }
          }
        }
      }
    } catch (e) {
      value = { status: 'FAULT', detail: `status check failed: ${excerpt(e?.message)}` };
    }
    statusCache = { at: now(), value };
    return value;
  }

  return {
    id: 'openai-compatible',
    kind: 'openai-compatible',
    model,
    endpointLabel: base,
    tokenParam,
    /** Per-call timeout when the caller passes none (openaiCompatible.timeoutMs, else VECTOR_MODEL_TIMEOUT_MS). */
    defaultTimeoutMs,
    status,
    complete,
    effectiveContext,
  };
}
