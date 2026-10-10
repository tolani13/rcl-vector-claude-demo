// Anthropic ModelProvider adapter (official @anthropic-ai/sdk, dynamically imported so the app runs without it).
//
// Credentials come ONLY from the environment / SDK credential resolution (ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN or
// an `ant auth login` profile). Nothing here reads or stores a key. Tests inject a fake SDK module + client through
// `deps`; the real API is never called from the test suite.
import { validateSchema } from '../prompts.js';

export const ANTHROPIC_DEFAULT_MODEL = 'claude-opus-5-5';
export const ANTHROPIC_FALLBACK_BETA = 'server-side-fallback-2026-07-01';
export const ANTHROPIC_DEFAULT_MAX_TOKENS = 16000;
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const STATUS_TTL_MS = 30_000;
const STATUS_TIMEOUT_MS = 5_000;
// A turn that thinks up to max_tokens takes time proportional to max_tokens. The per-call budget is the configured
// timeout, raised when needed to 60 s + 25 ms per allowed output token (~40 tokens/s), so a long adaptive-thinking
// turn is not aborted (and billed) as TIMEOUT. 16,000 tokens -> 460 s.
const BUDGET_BASE_MS = 60_000;
const BUDGET_MS_PER_TOKEN = 25;

/** Wall-clock budget for one call (ms): max(timeoutMs, 60 s + 25 ms x maxTokens). */
export function anthropicCallBudgetMs(maxTokens, timeoutMs) {
  const t = Number.isInteger(timeoutMs) && timeoutMs > 0 ? timeoutMs : 120_000;
  const m = Number.isInteger(maxTokens) && maxTokens > 0 ? maxTokens : ANTHROPIC_DEFAULT_MAX_TOKENS;
  return Math.max(t, BUDGET_BASE_MS + m * BUDGET_MS_PER_TOKEN);
}

const defaultLoadSdk = () => import('@anthropic-ai/sdk');

/** The exact Messages request VECTOR sends (exported so tests can assert the shape). */
export function buildAnthropicRequest({ model, maxTokens, effort, system, user, schema }) {
  return {
    model,
    max_tokens: maxTokens,
    betas: [ANTHROPIC_FALLBACK_BETA],
    fallbacks: 'default',
    thinking: { type: 'adaptive' },
    output_config: { effort, format: { type: 'json_schema', schema } },
    system,
    messages: [{ role: 'user', content: user }],
  };
}

function excerpt(s, n = 300) {
  const t = String(s ?? '');
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

/**
 * Map an SDK error to {kind, message} using the SDK's typed error classes (most specific first), never by
 * matching message text.
 */
export function classifyAnthropicError(Anthropic, err) {
  const is = (name) => typeof Anthropic?.[name] === 'function' && err instanceof Anthropic[name];
  const status = typeof err?.status === 'number' ? err.status : null;
  const msg = excerpt(err?.message);
  if (is('APIUserAbortError') || is('APIConnectionTimeoutError')) return { kind: 'TIMEOUT', message: `request timed out or was aborted: ${msg}` };
  if (is('AuthenticationError')) return { kind: 'AUTH', message: `authentication failed (${status ?? 401})` };
  if (is('PermissionDeniedError')) return { kind: 'AUTH', message: `permission denied (${status ?? 403})` };
  if (is('RateLimitError')) return { kind: 'RATE_LIMIT', message: `rate limited (${status ?? 429})` };
  if (is('NotFoundError')) return { kind: 'CONFIG', message: `not found (${status ?? 404}): ${msg}` };
  if (is('BadRequestError')) return { kind: 'BAD_REQUEST', message: `bad request (${status ?? 400}): ${msg}` };
  if (is('APIConnectionError')) return { kind: 'NETWORK', message: `connection error: ${msg}` };
  if (is('APIError')) return { kind: 'HTTP', message: `API error${status ? ` ${status}` : ''}: ${msg}` };
  if (is('AnthropicError')) return { kind: 'CONFIG', message: `SDK error: ${msg}` };
  // AbortSignal.timeout() rejects with a DOMException named TimeoutError if the SDK lets it through.
  if (err?.name === 'TimeoutError' || err?.name === 'AbortError') return { kind: 'TIMEOUT', message: 'request timed out' };
  return { kind: 'UNKNOWN', message: msg || 'unknown error' };
}

function result(fields) {
  return {
    ok: false, json: null, rawText: null, refusal: null, usage: { in: null, out: null }, latencyMs: 0,
    error: null, errorKind: null, servedModel: null, fallbackUsed: false, ...fields,
  };
}

/**
 * @param {{model?:string, effort?:string, maxTokens?:number, timeoutMs?:number, maxRetries?:number}} cfg
 * @param {{loadSdk?:()=>Promise<object>, clientFactory?:(Anthropic:Function)=>object, now?:()=>number}} deps
 */
export function createAnthropicProvider(cfg = {}, deps = {}) {
  const model = cfg.model || ANTHROPIC_DEFAULT_MODEL;
  const effort = EFFORTS.includes(cfg.effort) ? cfg.effort : 'medium';
  const defaultMaxTokens = Number.isInteger(cfg.maxTokens) && cfg.maxTokens > 0 ? cfg.maxTokens : ANTHROPIC_DEFAULT_MAX_TOKENS;
  const defaultTimeoutMs = Number.isInteger(cfg.timeoutMs) && cfg.timeoutMs > 0 ? cfg.timeoutMs : 120_000;
  const maxRetries = Number.isInteger(cfg.maxRetries) && cfg.maxRetries >= 0 ? cfg.maxRetries : 1;
  const loadSdk = deps.loadSdk || defaultLoadSdk;
  const now = deps.now || Date.now;
  let sdkPromise = null;
  let statusCache = null;

  /** Resolve {Anthropic, client}. Rejects with {kind, message}. */
  function getSdk() {
    if (!sdkPromise) {
      sdkPromise = (async () => {
        let mod;
        try {
          mod = await loadSdk();
        } catch (e) {
          const missing = e?.code === 'ERR_MODULE_NOT_FOUND' || e?.code === 'MODULE_NOT_FOUND';
          throw { kind: 'SDK_MISSING', message: missing ? 'SDK not installed: run npm install' : `SDK failed to load: ${excerpt(e?.message)}` };
        }
        const Anthropic = mod?.default ?? mod?.Anthropic;
        if (typeof Anthropic !== 'function') throw { kind: 'SDK_MISSING', message: 'SDK not installed: run npm install (no Anthropic export found)' };
        let client;
        try {
          // No apiKey argument: the SDK resolves credentials from the environment / profile.
          client = deps.clientFactory ? deps.clientFactory(Anthropic) : new Anthropic({ maxRetries });
        } catch (e) {
          const c = classifyAnthropicError(Anthropic, e);
          throw { kind: c.kind === 'CONFIG' ? 'NO_CREDENTIALS' : c.kind, message: `client could not be created (credentials are read from ANTHROPIC_API_KEY or an SDK profile): ${c.message}` };
        }
        return { Anthropic, client };
      })();
      // Do not cache failures: installing the SDK or exporting a key later should take effect.
      sdkPromise.catch(() => { sdkPromise = null; });
    }
    return sdkPromise;
  }

  async function complete({ system, user, schema, maxTokens, timeoutMs } = {}) {
    const t0 = now();
    const lat = () => now() - t0;
    if (typeof system !== 'string' || typeof user !== 'string' || !schema) {
      return result({ error: 'complete() requires system, user and schema', errorKind: 'CONFIG', latencyMs: lat() });
    }
    let sdk;
    try {
      sdk = await getSdk();
    } catch (e) {
      return result({ error: e.message, errorKind: e.kind, latencyMs: lat() });
    }
    const mTok = Number.isInteger(maxTokens) && maxTokens > 0 ? maxTokens : defaultMaxTokens;
    const budgetMs = anthropicCallBudgetMs(mTok, Number.isInteger(timeoutMs) && timeoutMs > 0 ? timeoutMs : defaultTimeoutMs);
    const params = buildAnthropicRequest({ model, maxTokens: mTok, effort, system, user, schema });
    const opts = { timeout: budgetMs, maxRetries, signal: AbortSignal.timeout(budgetMs) };
    let resp;
    try {
      // Streaming (finalMessage) is the SDK's recommendation for high max_tokens: no long idle HTTP request.
      const api = sdk.client.beta.messages;
      resp = typeof api.stream === 'function' ? await api.stream(params, opts).finalMessage() : await api.create(params, opts);
    } catch (err) {
      const c = classifyAnthropicError(sdk.Anthropic, err);
      return result({ error: c.message, errorKind: c.kind, latencyMs: lat() });
    }
    return interpret(resp, schema, lat());
  }

  function interpret(resp, schema, latencyMs) {
    const usage = { in: resp?.usage?.input_tokens ?? null, out: resp?.usage?.output_tokens ?? null };
    const servedModel = resp?.model ?? model;
    const base = { usage, latencyMs, servedModel };
    // Refusal is checked BEFORE content is read: a refused turn's content is not an answer.
    if (resp?.stop_reason === 'refusal') {
      const d = resp.stop_details ?? null;
      return result({
        ...base,
        refusal: { category: d?.category ?? null, explanation: d?.explanation ?? null },
        error: 'REFUSED', errorKind: 'REFUSAL',
      });
    }
    const content = Array.isArray(resp?.content) ? resp.content : [];
    const fallbackUsed = content.some((b) => b?.type === 'fallback')
      || (resp?.usage?.iterations ?? []).some((i) => i?.type === 'fallback_message');
    const rawText = content.filter((b) => b?.type === 'text').map((b) => b.text).join('');
    const withRaw = { ...base, rawText, fallbackUsed };
    if (resp?.stop_reason === 'max_tokens') return result({ ...withRaw, error: 'TRUNCATED: stop_reason max_tokens', errorKind: 'INVALID_OUTPUT' });
    if (!rawText.trim()) return result({ ...withRaw, error: `EMPTY_OUTPUT (stop_reason ${resp?.stop_reason ?? 'unknown'})`, errorKind: 'INVALID_OUTPUT' });
    let json;
    try {
      json = JSON.parse(rawText);
    } catch (e) {
      return result({ ...withRaw, error: `INVALID_JSON: ${excerpt(e.message, 160)}`, errorKind: 'INVALID_OUTPUT' });
    }
    const errs = validateSchema(json, schema);
    if (errs.length) return result({ ...withRaw, json, error: `SCHEMA_INVALID: ${errs.slice(0, 10).join('; ')}`, errorKind: 'INVALID_OUTPUT' });
    return result({ ...withRaw, ok: true, json });
  }

  /**
   * Never throws. CONNECTED only after the SDK confirmed the model with the resolved credentials (free metadata call).
   * Cached for 30 s; {fresh:true} bypasses the cache.
   */
  async function status({ fresh = false } = {}) {
    if (!fresh && statusCache && now() - statusCache.at < STATUS_TTL_MS) return statusCache.value;
    let value;
    try {
      let sdk;
      try {
        sdk = await getSdk();
      } catch (e) {
        value = e.kind === 'NO_CREDENTIALS'
          ? { status: 'DISCONNECTED', detail: `No Anthropic credentials resolved: set ANTHROPIC_API_KEY (server-side) or run \`ant auth login\`. ${e.message}` }
          : { status: 'FAULT', detail: e.message };
      }
      if (sdk) {
        try {
          await sdk.client.models.retrieve(model, { timeout: STATUS_TIMEOUT_MS, maxRetries: 0 });
          value = { status: 'CONNECTED', detail: `Anthropic API reachable; model ${model} available` };
        } catch (err) {
          const c = classifyAnthropicError(sdk.Anthropic, err);
          if (c.kind === 'NETWORK' || c.kind === 'TIMEOUT') value = { status: 'DISCONNECTED', detail: `Anthropic API unreachable: ${c.message}` };
          else if (c.kind === 'CONFIG' && err?.status !== 404) value = { status: 'DISCONNECTED', detail: `No Anthropic credentials resolved: ${c.message}` };
          else value = { status: 'FAULT', detail: c.message };
        }
      }
    } catch (e) {
      value = { status: 'FAULT', detail: `status check failed: ${excerpt(e?.message)}` };
    }
    statusCache = { at: now(), value };
    return value;
  }

  return {
    id: 'anthropic',
    kind: 'anthropic',
    model,
    effort,
    endpointLabel: 'Anthropic Messages API (SDK default endpoint)',
    status,
    complete,
    /** Per-call timeout when the caller passes none (VECTOR_MODEL_TIMEOUT_MS). */
    defaultTimeoutMs,
    /** The wall-clock budget complete() allows itself; callers align their outer guard with it. */
    callBudgetMs: (mTok, tMs) => anthropicCallBudgetMs(mTok ?? defaultMaxTokens, tMs ?? defaultTimeoutMs),
  };
}
