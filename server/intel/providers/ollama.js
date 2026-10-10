// Native Ollama ModelProvider adapter (POST {base}/api/chat over fetch, no SDK).
//
// Why a native adapter: Ollama's OpenAI-compatible /v1 endpoint cannot set the context window, so a default install
// (4096 tokens) silently truncates VECTOR evidence packets unless the operator restarts the server with
// OLLAMA_CONTEXT_LENGTH. The native endpoint accepts options.num_ctx per request, so VECTOR asks for the context it
// needs (VECTOR_OLLAMA_NUM_CTX, default 16384) and the user's Ollama server is not reconfigured. Ollama loads (or
// reloads) the model with that context; it may clamp the value (e.g. to the model's trained maximum), which the
// post-call check below detects through GET /api/ps.
//
// Same envelope, validation and context checks as the OpenAI-compatible adapter:
//   * request {model, messages:[system, user], format:<JSON schema>, stream:false, options:{num_ctx, num_predict[, temperature]}};
//   * before calling, a conservative prompt estimate that does not fit num_ctx with an output reserve is refused as
//     CONTEXT_OVERFLOW (errorKind CONFIG) and nothing is sent; num_predict is clamped to what the context leaves;
//   * after calling, a reported prompt size below the minimum plausible size (truncation), prompt + output at or above
//     the context Ollama actually loaded (context shift), done_reason "length" or done:false is INVALID_OUTPUT, never OK;
//   * <think>…</think> reasoning is removed with stripThink (a literal "<think>" inside a JSON string is never cut) and
//     the answer is strictly JSON-parsed and schema-validated. A separate message.thinking field is never parsed.
// status(): GET /api/tags (is the model pulled?) and GET /api/ps (is it loaded, with which context?), 3 s each.
// Ollama has no API key; a base URL with embedded credentials is rejected.
import { validateSchema } from '../prompts.js';
import {
  stripThink, estimatePromptTokens, minPromptTokens, MIN_OUTPUT_RESERVE_TOKENS, RECOMMENDED_CONTEXT_TOKENS,
} from './openai-compatible.js';

export const OLLAMA_DEFAULT_BASE_URL = 'http://127.0.0.1:11434';
export const OLLAMA_DEFAULT_NUM_CTX = RECOMMENDED_CONTEXT_TOKENS; // 16384
export const OLLAMA_MAX_NUM_CTX = 1_048_576;                     // sanity bound for configuration values
const STATUS_TIMEOUT_MS = 3_000;
const STATUS_TTL_MS = 15_000;
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_TOKENS = 16_000;

const CONTEXT_ADVICE = `raise VECTOR_OLLAMA_NUM_CTX (or ollama.numCtx in the model config file; the server does not need to be restarted), or use a model whose trained context is at least ${RECOMMENDED_CONTEXT_TOKENS} tokens`;

function excerpt(s, n = 300) {
  const t = String(s ?? '');
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

/**
 * Validate and normalise an Ollama base URL (http/https, no credentials, no query, no trailing slash). A trailing
 * "/v1" (OpenAI-compatible path) or "/api" is removed: the native endpoints live at {base}/api/... Throws on invalid input.
 */
export function normalizeOllamaBaseUrl(raw) {
  if (typeof raw !== 'string' || !raw.trim()) throw new Error('Ollama base URL is not set (VECTOR_OLLAMA_BASE_URL)');
  let u;
  try { u = new URL(raw.trim()); } catch { throw new Error('Ollama base URL is not a valid URL'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('Ollama base URL must be http(s)');
  if (u.username || u.password) throw new Error('Ollama base URL must not embed credentials');
  const p = u.pathname.replace(/\/+$/, '').replace(/\/(?:v1|api)$/i, '');
  return `${u.origin}${p}`;
}

/** Ollama names an untagged model "<name>:latest". */
export function sameOllamaModel(name, model) {
  if (typeof name !== 'string' || typeof model !== 'string') return false;
  const tag = (s) => (s.includes(':') ? s : `${s}:latest`);
  return tag(name) === tag(model);
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
  if (status === 404) return 'CONFIG'; // Ollama: model not found (not pulled) or wrong base path
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

const intOrNull = (x) => (Number.isInteger(x) && x >= 0 ? x : null);

/** The "error" string of an Ollama error body, else a bounded excerpt of the body. */
function errorText(text) {
  try {
    const e = JSON.parse(text)?.error;
    if (typeof e === 'string' && e) return excerpt(e, 200);
  } catch { /* not JSON */ }
  return excerpt(text, 200);
}

/**
 * @param {{baseUrl?:string, model?:string, numCtx?:number, timeoutMs?:number, maxTokens?:number, temperature?:number}} cfg
 * @param {{fetch?:typeof fetch, now?:()=>number}} deps
 */
export function createOllamaProvider(cfg = {}, deps = {}) {
  const fetchImpl = deps.fetch || globalThis.fetch;
  const now = deps.now || Date.now;
  let base = null;
  let configError = null;
  try { base = normalizeOllamaBaseUrl(cfg.baseUrl ?? OLLAMA_DEFAULT_BASE_URL); } catch (e) { configError = e.message; }
  const model = typeof cfg.model === 'string' && cfg.model.trim() ? cfg.model.trim() : null;
  if (!configError && !model) configError = 'model is not set (VECTOR_OLLAMA_MODEL)';
  const numCtx = Number.isInteger(cfg.numCtx) && cfg.numCtx > 0 && cfg.numCtx <= OLLAMA_MAX_NUM_CTX ? cfg.numCtx : OLLAMA_DEFAULT_NUM_CTX;
  const defaultTimeoutMs = Number.isInteger(cfg.timeoutMs) && cfg.timeoutMs > 0 ? cfg.timeoutMs : DEFAULT_TIMEOUT_MS;
  const defaultMaxTokens = Number.isInteger(cfg.maxTokens) && cfg.maxTokens > 0 ? cfg.maxTokens : DEFAULT_MAX_TOKENS;
  const temperature = typeof cfg.temperature === 'number' && Number.isFinite(cfg.temperature) ? cfg.temperature : null;
  let statusCache = null;

  const headers = (json) => ({ ...(json ? { 'content-type': 'application/json' } : {}), accept: 'application/json' });

  async function getJson(pathname) {
    const res = await fetchImpl(`${base}${pathname}`, { method: 'GET', headers: headers(false), signal: AbortSignal.timeout(STATUS_TIMEOUT_MS) });
    const text = await res.text();
    return { res, text };
  }

  /**
   * What GET /api/ps says about this model right now. Never throws.
   * @returns {Promise<{reachable:boolean, loaded:boolean, contextLength:number|null}>}
   */
  async function loadedInfo() {
    try {
      const { res, text } = await getJson('/api/ps');
      if (!res.ok) return { reachable: false, loaded: false, contextLength: null };
      const data = JSON.parse(text);
      const m = (Array.isArray(data?.models) ? data.models : []).find((x) => [x?.name, x?.model].some((n) => sameOllamaModel(n, model)));
      if (!m) return { reachable: true, loaded: false, contextLength: null };
      return { reachable: true, loaded: true, contextLength: Number.isInteger(m.context_length) && m.context_length > 0 ? m.context_length : null };
    } catch {
      return { reachable: false, loaded: false, contextLength: null };
    }
  }

  /** The context every request asks for (options.num_ctx). */
  async function effectiveContext() {
    return { tokens: numCtx, source: 'requested per call (options.num_ctx; VECTOR_OLLAMA_NUM_CTX)' };
  }

  /**
   * The context Ollama actually serves for this model after a call: num_ctx, or less when /api/ps reports a smaller
   * loaded context (Ollama clamped the request). Never throws.
   */
  async function servedContext() {
    const ps = await loadedInfo();
    if (ps.loaded && ps.contextLength !== null && ps.contextLength < numCtx) {
      return { tokens: ps.contextLength, source: `Ollama /api/ps reports ${ps.contextLength} loaded context; the requested num_ctx ${numCtx} was clamped` };
    }
    if (ps.loaded && ps.contextLength !== null) return { tokens: numCtx, source: `num_ctx ${numCtx} (confirmed by /api/ps: ${ps.contextLength})` };
    return { tokens: numCtx, source: `num_ctx ${numCtx} (requested; not confirmed by /api/ps)` };
  }

  async function complete({ system, user, schema, maxTokens, timeoutMs } = {}) {
    const t0 = now();
    const lat = () => now() - t0;
    if (configError) return result({ error: configError, errorKind: 'CONFIG' });
    if (typeof system !== 'string' || typeof user !== 'string' || !schema) {
      return result({ error: 'complete() requires system, user and schema', errorKind: 'CONFIG' });
    }
    const tMs = Number.isInteger(timeoutMs) && timeoutMs > 0 ? timeoutMs : defaultTimeoutMs;
    const estIn = estimatePromptTokens(system, user);
    // A configuration problem (num_ctx too small for this packet), not a model answer: errorKind CONFIG, nothing sent.
    if (estIn + MIN_OUTPUT_RESERVE_TOKENS > numCtx) {
      return result({
        error: `CONTEXT_OVERFLOW: ~${estIn} estimated prompt tokens + ${MIN_OUTPUT_RESERVE_TOKENS} output reserve exceed num_ctx ${numCtx} [requested per call (VECTOR_OLLAMA_NUM_CTX)]; not sent. To fix: ${CONTEXT_ADVICE}.`,
        errorKind: 'CONFIG', latencyMs: lat(),
      });
    }
    const requested = Number.isInteger(maxTokens) && maxTokens > 0 ? maxTokens : defaultMaxTokens;
    const numPredict = Math.min(requested, numCtx - estIn);
    const body = {
      model,
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      format: schema,
      stream: false,
      options: { num_ctx: numCtx, num_predict: numPredict, ...(temperature !== null ? { temperature } : {}) },
    };
    let res;
    let text;
    try {
      res = await fetchImpl(`${base}/api/chat`, { method: 'POST', headers: headers(true), body: JSON.stringify(body), signal: AbortSignal.timeout(tMs) });
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
      const kind = httpKind(res.status);
      const hint = res.status === 404 ? ` (is the model pulled? run: ollama pull ${model})` : '';
      return result({ error: `HTTP ${res.status}: ${errorText(text)}${hint}`, errorKind: kind, latencyMs: lat() });
    }
    let data;
    try { data = JSON.parse(text); } catch {
      return result({ error: 'endpoint returned non-JSON response', errorKind: 'PROTOCOL', latencyMs: lat() });
    }
    if (typeof data?.error === 'string' && data.error) {
      return result({ error: `Ollama error: ${excerpt(data.error, 200)}`, errorKind: 'PROTOCOL', latencyMs: lat() });
    }
    const usage = { in: intOrNull(data?.prompt_eval_count), out: intOrNull(data?.eval_count) };
    const servedModel = typeof data?.model === 'string' && data.model ? data.model : model;
    const base2 = { usage, latencyMs: lat(), servedModel };
    const msg = data?.message;
    if (!msg || typeof msg.content !== 'string') return result({ ...base2, error: 'response has no message.content', errorKind: 'PROTOCOL' });
    const rawText = msg.content;
    const withRaw = { ...base2, rawText };
    // Context checks come before any parsing: a truncated or context-shifted answer is never stored as OK.
    if (usage.in !== null) {
      const minIn = minPromptTokens(system, user);
      if (usage.in < minIn) {
        return result({ ...withRaw, error: `CONTEXT_TRUNCATED: Ollama reported ${usage.in} prompt tokens, below the ~${minIn} minimum for this prompt (~${estIn} estimated); the prompt was most likely truncated, so the answer cannot be trusted. To fix: ${CONTEXT_ADVICE}.`, errorKind: 'INVALID_OUTPUT' });
      }
      if (usage.out !== null) {
        const ctx = await servedContext();
        if (usage.in + usage.out >= ctx.tokens) {
          return result({ ...withRaw, error: `CONTEXT_EXHAUSTED: ${usage.in} prompt + ${usage.out} output tokens reached the ${ctx.tokens}-token context [${ctx.source}] (Ollama shifts or drops context at this point). To fix: ${CONTEXT_ADVICE}.`, errorKind: 'INVALID_OUTPUT' });
        }
      }
    }
    if (data.done_reason === 'length') return result({ ...withRaw, error: 'TRUNCATED: done_reason length', errorKind: 'INVALID_OUTPUT' });
    if (data.done === false) return result({ ...withRaw, error: 'TRUNCATED: response not done', errorKind: 'INVALID_OUTPUT' });
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

  /**
   * Never throws. GET /api/tags (model pulled?) then GET /api/ps (loaded context), 3 s each. Cached for 15 s;
   * {fresh:true} bypasses the cache.
   */
  async function status({ fresh = false } = {}) {
    if (!fresh && statusCache && now() - statusCache.at < STATUS_TTL_MS) return statusCache.value;
    let value;
    try {
      if (configError) {
        value = { status: 'DISCONNECTED', detail: `Ollama not configured: ${configError}` };
      } else {
        let tags = null;
        try {
          tags = await getJson('/api/tags');
        } catch (e) {
          value = fetchErrorKind(e) === 'TIMEOUT'
            ? { status: 'DISCONNECTED', detail: `no response from ${base}/api/tags within ${STATUS_TIMEOUT_MS} ms` }
            : { status: 'DISCONNECTED', detail: `Ollama unreachable at ${base} (${excerpt(e?.cause?.code || e?.message, 80)})` };
        }
        if (!value) {
          if (!tags.res.ok) {
            value = { status: 'FAULT', detail: `GET /api/tags returned HTTP ${tags.res.status}` };
          } else {
            let names = null;
            try {
              const data = JSON.parse(tags.text);
              names = Array.isArray(data?.models) ? data.models.flatMap((m) => [m?.name, m?.model]).filter((x) => typeof x === 'string') : null;
            } catch { names = null; }
            if (names === null) value = { status: 'FAULT', detail: 'GET /api/tags did not return an Ollama model list' };
            else if (!names.some((n) => sameOllamaModel(n, model))) {
              value = { status: 'FAULT', detail: `model "${model}" is not pulled on this Ollama server (${new Set(names).size} model names listed); run: ollama pull ${model}` };
            } else {
              const ps = await loadedInfo();
              const loaded = ps.loaded
                ? `loaded now with context ${ps.contextLength ?? 'unknown'}${ps.contextLength !== null && ps.contextLength !== numCtx ? ` (Ollama reloads it with num_ctx ${numCtx} on the next request)` : ''}`
                : 'not loaded (Ollama loads it on the first request)';
              value = {
                status: 'CONNECTED',
                detail: `Ollama reachable at ${base}; model ${model} available; every request sets num_ctx ${numCtx}; ${loaded}`,
                contextTokens: numCtx,
                warnings: numCtx < RECOMMENDED_CONTEXT_TOKENS
                  ? [`num_ctx ${numCtx} is below the ${RECOMMENDED_CONTEXT_TOKENS} recommended for VECTOR evidence packets (~5k prompt tokens plus reasoning output); assessments that do not fit are refused as CONTEXT_OVERFLOW. To fix: ${CONTEXT_ADVICE}.`]
                  : [],
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
    id: 'ollama',
    kind: 'ollama',
    model,
    endpointLabel: base,
    numCtx,
    /** Per-call timeout when the caller passes none (ollama.timeoutMs, else VECTOR_MODEL_TIMEOUT_MS). */
    defaultTimeoutMs,
    status,
    complete,
    effectiveContext,
    servedContext,
  };
}
