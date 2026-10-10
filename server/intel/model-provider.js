// ModelProvider selection and configuration (CONTRACTS.md section 8).
//
// Provider kind comes from VECTOR_MODEL_PROVIDER = anthropic | openai-compatible | ollama | none (default none).
//   ollama: native Ollama API (POST /api/chat) at VECTOR_OLLAMA_BASE_URL (default http://127.0.0.1:11434) with model
//   VECTOR_OLLAMA_MODEL; every request sets options.num_ctx = VECTOR_OLLAMA_NUM_CTX (default 16384), so long evidence
//   packets fit without reconfiguring the Ollama server (its /v1 OpenAI-compatible endpoint cannot set the context).
// Non-secret settings may also live in a server-side JSON file (data/model-config.json, or VECTOR_MODEL_CONFIG).
// Secrets are read ONLY from the environment (ANTHROPIC_API_KEY via the SDK, VECTOR_OPENAI_API_KEY); any
// secret-looking field in the config file is ignored and reported as a warning.
//
// Precedence: explicit getProvider(config) argument > environment > config file > defaults.
// There is deliberately NO mock provider in server/: with nothing configured the provider is kind "none", which
// reports DISCONNECTED and never produces output (UI: "MODEL DISCONNECTED / ASSESSMENT NOT RUN").
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stableStringify } from '../util/ids.js';
import { createAnthropicProvider, ANTHROPIC_DEFAULT_MODEL, ANTHROPIC_DEFAULT_MAX_TOKENS } from './providers/anthropic.js';
import { createOpenAICompatibleProvider } from './providers/openai-compatible.js';
import { createOllamaProvider, OLLAMA_DEFAULT_BASE_URL, OLLAMA_DEFAULT_NUM_CTX, OLLAMA_MAX_NUM_CTX } from './providers/ollama.js';

const here = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_MODEL_CONFIG_PATH = path.resolve(here, '..', '..', 'data', 'model-config.json');
export const PROVIDER_KINDS = Object.freeze(['anthropic', 'openai-compatible', 'ollama', 'none']);
export const DEFAULTS = Object.freeze({
  timeoutMs: 120_000,
  maxTokens: ANTHROPIC_DEFAULT_MAX_TOKENS,
  maxCallsPerSession: 60,
  maxCallsPerDay: 300,       // rolling 24 h wall-clock budget across ALL replay sessions (resets do not refill it)
  cutoffMarginDays: 90,      // replay dates within this many days after a model's training cutoff are hindsight-risky
});

/**
 * Documented training cutoffs for known models (YYYY-MM-DD, an upper bound). Operators override or supply one with
 * VECTOR_MODEL_TRAINING_CUTOFF or `trainingCutoff` in the config file. A model not listed has an UNKNOWN cutoff, which
 * is treated as unsafe for replay (assessments are BLOCKED until a cutoff is configured).
 */
export const KNOWN_TRAINING_CUTOFFS = Object.freeze({
  'claude-opus-5-5': '2026-06-30',
});

// Whole-word secret detection: a key is secret-like when any camelCase/snake_case word is a credential word, or its
// last word is key/token/apikey. "maxTokens" / "contextTokens" (last word "tokens") are NOT secrets.
const SECRET_WORDS = new Set(['secret', 'password', 'passwd', 'authorization', 'bearer', 'credential', 'credentials']);
const SECRET_LAST_WORDS = new Set(['key', 'apikey', 'token']);
export function isSecretLikeKey(k) {
  const words = String(k).replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  if (!words.length) return false;
  return words.some((w) => SECRET_WORDS.has(w)) || SECRET_LAST_WORDS.has(words[words.length - 1]);
}

/** Remove secret-looking keys (recursively); returns {clean, removed[]} */
function stripSecrets(obj, prefix = '') {
  const removed = [];
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return { clean: obj, removed };
  const clean = {};
  for (const [k, v] of Object.entries(obj)) {
    const p = prefix ? `${prefix}.${k}` : k;
    if (isSecretLikeKey(k)) { removed.push(p); continue; }
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const sub = stripSecrets(v, p);
      clean[k] = sub.clean;
      removed.push(...sub.removed);
    } else clean[k] = v;
  }
  return { clean, removed };
}

const fileCache = new Map(); // path -> {sig, value}: re-read only when size/mtime change (status polls stay cheap)

/**
 * Read the optional server-side config file. Never throws. The parsed result is cached per path and reused while the
 * file's size and modification time are unchanged.
 * @returns {{path:string, loaded:boolean, config:object, warnings:string[]}}
 */
export function loadModelConfigFile(file = process.env.VECTOR_MODEL_CONFIG || DEFAULT_MODEL_CONFIG_PATH) {
  let sig;
  try {
    const st = fs.statSync(file);
    sig = `${st.size}:${st.mtimeMs}`;
  } catch (e) {
    fileCache.delete(file);
    const out = { path: file, loaded: false, config: {}, warnings: [] };
    if (e?.code !== 'ENOENT') out.warnings.push(`model config file unreadable (${e?.code || 'error'})`);
    return out;
  }
  const hit = fileCache.get(file);
  if (hit && hit.sig === sig) return structuredClone(hit.value);
  const value = readModelConfigFile(file);
  fileCache.set(file, { sig, value });
  return structuredClone(value);
}

function readModelConfigFile(file) {
  const out = { path: file, loaded: false, config: {}, warnings: [] };
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e?.code !== 'ENOENT') out.warnings.push(`model config file unreadable (${e?.code || 'error'})`);
    return out;
  }
  let parsed;
  try { parsed = JSON.parse(text); } catch {
    out.warnings.push('model config file is not valid JSON; ignored');
    return out;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    out.warnings.push('model config file must contain a JSON object; ignored');
    return out;
  }
  const { clean, removed } = stripSecrets(parsed);
  for (const r of removed) out.warnings.push(`ignored secret-like field "${r}" in model config file (keys come from environment variables only)`);
  out.loaded = true;
  out.config = clean;
  return out;
}

function posInt(v) {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  return Number.isInteger(n) && n > 0 ? n : null;
}

function pick(...vals) {
  for (const v of vals) if (v !== undefined && v !== null && v !== '') return v;
  return undefined;
}

/** 'YYYY-MM-DD' if s is a real calendar date, else null. */
export function validIsoDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const d = new Date(`${s}T00:00:00Z`);
  return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === s ? s : null;
}

const truthy = (v) => v === true || (typeof v === 'string' && /^(1|true|yes)$/i.test(v.trim()));

/**
 * Resolve the effective (secret-free) configuration.
 * @param {object} overrides  same shape as the config file: {provider, timeoutMs, maxTokens, maxCallsPerSession,
 *                            maxCallsPerDay, trainingCutoff, cutoffMarginDays, allowPreCutoffReplay,
 *                            anthropic:{model, effort},
 *                            openaiCompatible:{baseUrl, model, temperature, timeoutMs, contextTokens, tokenParam},
 *                            ollama:{baseUrl, model, numCtx, temperature, timeoutMs}}
 * @param {{env?:object, file?:string}} opts
 */
export function resolveModelConfig(overrides = {}, { env = process.env, file } = {}) {
  const f = loadModelConfigFile(file ?? env.VECTOR_MODEL_CONFIG ?? DEFAULT_MODEL_CONFIG_PATH);
  const fc = f.config;
  const o = overrides || {};
  const warnings = [...f.warnings];
  const num = (name, ...vals) => {
    for (const v of vals) {
      if (v === undefined || v === null || v === '') continue;
      const n = posInt(v);
      if (n !== null) return n;
      warnings.push(`${name}: ignored non-positive-integer value`);
    }
    return DEFAULTS[name];
  };
  const providerRaw = String(pick(o.provider, env.VECTOR_MODEL_PROVIDER, fc.provider, 'none')).trim().toLowerCase();
  const oa = o.anthropic || {};
  const fa = fc.anthropic || {};
  const oo = o.openaiCompatible || {};
  const fo = fc.openaiCompatible || {};
  const timeoutMs = num('timeoutMs', o.timeoutMs, env.VECTOR_MODEL_TIMEOUT_MS, fc.timeoutMs);
  const anthropic = {
    model: pick(oa.model, env.VECTOR_ANTHROPIC_MODEL, fa.model, ANTHROPIC_DEFAULT_MODEL),
    effort: pick(oa.effort, fa.effort, 'medium'),
  };
  const contextRaw = pick(oo.contextTokens, env.VECTOR_OPENAI_CONTEXT_TOKENS, fo.contextTokens);
  if (contextRaw !== undefined && posInt(contextRaw) === null) warnings.push('openaiCompatible.contextTokens: ignored non-positive-integer value');
  const tokenParamRaw = pick(oo.tokenParam, env.VECTOR_OPENAI_TOKEN_PARAM, fo.tokenParam);
  const tokenParam = ['max_tokens', 'max_completion_tokens'].includes(tokenParamRaw) ? tokenParamRaw : null;
  if (tokenParamRaw !== undefined && !tokenParam) warnings.push('openaiCompatible.tokenParam: must be max_tokens or max_completion_tokens; ignored');
  const openaiCompatible = {
    baseUrl: pick(oo.baseUrl, env.VECTOR_OPENAI_BASE_URL, fo.baseUrl) ?? null,
    model: pick(oo.model, env.VECTOR_OPENAI_MODEL, fo.model) ?? null,
    temperature: typeof pick(oo.temperature, fo.temperature) === 'number' ? pick(oo.temperature, fo.temperature) : null,
    timeoutMs: posInt(pick(oo.timeoutMs, fo.timeoutMs)) ?? timeoutMs,
    contextTokens: posInt(contextRaw) ?? null,
    tokenParam,
  };
  const ol = o.ollama || {};
  const fl = fc.ollama || {};
  const numCtxRaw = pick(ol.numCtx, env.VECTOR_OLLAMA_NUM_CTX, fl.numCtx);
  const numCtxVal = posInt(numCtxRaw);
  const numCtxOk = numCtxVal !== null && numCtxVal <= OLLAMA_MAX_NUM_CTX;
  if (numCtxRaw !== undefined && !numCtxOk) warnings.push(`ollama.numCtx: must be a positive integer <= ${OLLAMA_MAX_NUM_CTX}; using ${OLLAMA_DEFAULT_NUM_CTX}`);
  const ollama = {
    baseUrl: pick(ol.baseUrl, env.VECTOR_OLLAMA_BASE_URL, fl.baseUrl) ?? OLLAMA_DEFAULT_BASE_URL,
    model: pick(ol.model, env.VECTOR_OLLAMA_MODEL, fl.model) ?? null,
    numCtx: numCtxOk ? numCtxVal : OLLAMA_DEFAULT_NUM_CTX,
    temperature: typeof pick(ol.temperature, fl.temperature) === 'number' ? pick(ol.temperature, fl.temperature) : null,
    timeoutMs: posInt(pick(ol.timeoutMs, fl.timeoutMs)) ?? timeoutMs,
  };
  // Training cutoff of the model that will actually be called (hindsight guard, see assessments.js hindsightCheck).
  const activeModel = providerRaw === 'anthropic' ? anthropic.model
    : providerRaw === 'openai-compatible' ? openaiCompatible.model
      : providerRaw === 'ollama' ? ollama.model : null;
  const cutoffRaw = pick(o.trainingCutoff, env.VECTOR_MODEL_TRAINING_CUTOFF, fc.trainingCutoff);
  const cutoffExplicit = cutoffRaw === undefined ? null : validIsoDate(String(cutoffRaw));
  if (cutoffRaw !== undefined && !cutoffExplicit) warnings.push('trainingCutoff: must be a YYYY-MM-DD date; ignored');
  const cutoffBuiltIn = activeModel ? KNOWN_TRAINING_CUTOFFS[activeModel] ?? null : null;
  const marginRaw = pick(o.cutoffMarginDays, env.VECTOR_MODEL_CUTOFF_MARGIN_DAYS, fc.cutoffMarginDays);
  const marginNum = typeof marginRaw === 'string' && marginRaw.trim() !== '' ? Number(marginRaw) : marginRaw;
  const cutoffMarginDays = Number.isInteger(marginNum) && marginNum >= 0 ? marginNum : DEFAULTS.cutoffMarginDays;
  if (marginRaw !== undefined && cutoffMarginDays !== marginNum) warnings.push('cutoffMarginDays: ignored non-negative-integer value');
  return {
    provider: providerRaw,
    providerValid: PROVIDER_KINDS.includes(providerRaw),
    timeoutMs,
    maxTokens: num('maxTokens', o.maxTokens, env.VECTOR_MODEL_MAX_TOKENS, fc.maxTokens),
    maxCallsPerSession: num('maxCallsPerSession', o.maxCallsPerSession, env.VECTOR_MAX_MODEL_CALLS_PER_SESSION, fc.maxCallsPerSession),
    maxCallsPerDay: num('maxCallsPerDay', o.maxCallsPerDay, env.VECTOR_MAX_MODEL_CALLS_PER_DAY, fc.maxCallsPerDay),
    trainingCutoff: cutoffExplicit ?? cutoffBuiltIn,
    trainingCutoffSource: cutoffExplicit ? 'configured' : cutoffBuiltIn ? 'built-in' : null,
    cutoffMarginDays,
    allowPreCutoffReplay: truthy(pick(o.allowPreCutoffReplay, env.VECTOR_ALLOW_PRE_CUTOFF_REPLAY, fc.allowPreCutoffReplay)),
    anthropic,
    openaiCompatible,
    ollama,
    configFile: { path: f.path, loaded: f.loaded },
    warnings,
  };
}

function disconnectedProvider(kind, detail, statusValue = 'DISCONNECTED') {
  return {
    id: kind,
    kind: 'none',
    model: null,
    endpointLabel: null,
    async status() { return { status: statusValue, detail }; },
    async complete() {
      return {
        ok: false, json: null, rawText: null, refusal: null, usage: { in: 0, out: 0 }, latencyMs: 0,
        error: statusValue === 'FAULT' ? `PROVIDER_CONFIG_FAULT: ${detail}` : 'MODEL_DISCONNECTED',
        errorKind: statusValue === 'FAULT' ? 'CONFIG' : 'DISCONNECTED', servedModel: null, fallbackUsed: false,
      };
    },
  };
}

const cache = new Map();

/**
 * Build (or reuse) the configured provider. Never throws.
 * @param {object} config  overrides (see resolveModelConfig)
 * @param {object} deps    adapter dependencies (tests inject fakes: {loadSdk, clientFactory, fetch})
 * @returns provider {id, kind, model, endpointLabel, status(), complete()} plus {config} (secret-free)
 */
export function getProvider(config = {}, deps = null, { env = process.env, file } = {}) {
  let resolved;
  try {
    resolved = resolveModelConfig(config, { env, file });
  } catch (e) {
    return disconnectedProvider('none', `model configuration error: ${e?.message}`, 'FAULT');
  }
  // The env-held key is part of the cache identity only as a presence flag, never its value.
  const key = stableStringify({ resolved, openaiKey: !!env.VECTOR_OPENAI_API_KEY });
  if (!deps && cache.has(key)) return cache.get(key);
  let provider;
  if (!resolved.providerValid) {
    provider = disconnectedProvider('none', `unknown VECTOR_MODEL_PROVIDER "${resolved.provider}" (use anthropic | openai-compatible | ollama | none)`, 'FAULT');
  } else if (resolved.provider === 'anthropic') {
    provider = createAnthropicProvider({
      model: resolved.anthropic.model, effort: resolved.anthropic.effort, maxTokens: resolved.maxTokens, timeoutMs: resolved.timeoutMs,
    }, deps || {});
  } else if (resolved.provider === 'openai-compatible') {
    provider = createOpenAICompatibleProvider({
      baseUrl: resolved.openaiCompatible.baseUrl, model: resolved.openaiCompatible.model,
      apiKey: env.VECTOR_OPENAI_API_KEY || null, timeoutMs: resolved.openaiCompatible.timeoutMs,
      maxTokens: resolved.maxTokens, temperature: resolved.openaiCompatible.temperature,
      contextTokens: resolved.openaiCompatible.contextTokens, tokenParam: resolved.openaiCompatible.tokenParam,
    }, deps || {});
  } else if (resolved.provider === 'ollama') {
    provider = createOllamaProvider({
      baseUrl: resolved.ollama.baseUrl, model: resolved.ollama.model, numCtx: resolved.ollama.numCtx,
      timeoutMs: resolved.ollama.timeoutMs, maxTokens: resolved.maxTokens, temperature: resolved.ollama.temperature,
    }, deps || {});
  } else {
    provider = disconnectedProvider('none', 'No model provider configured (VECTOR_MODEL_PROVIDER=none). MODEL DISCONNECTED / ASSESSMENT NOT RUN.');
  }
  provider.config = resolved;
  if (!deps) cache.set(key, provider);
  return provider;
}

/**
 * Status for /api/status and /api/model. Never throws.
 * @returns {Promise<{status:'CONNECTED'|'DISCONNECTED'|'FAULT', provider:string, model:string|null, endpoint:string|null,
 *           detail:string, warnings:string[], limits:{maxCallsPerSession:number, maxCallsPerDay:number, timeoutMs:number,
 *           maxTokens:number, contextTokens:number|null}, hindsight:{trainingCutoff:string|null, source:string|null,
 *           marginDays:number, allowPreCutoffReplay:boolean}}>}
 */
export async function status(config = {}, deps = null, opts = {}) {
  let provider = null;
  try {
    provider = getProvider(config, deps, opts);
    const s = await provider.status();
    const ok = s && ['CONNECTED', 'DISCONNECTED', 'FAULT'].includes(s.status);
    const c = provider.config ?? {};
    return {
      status: ok ? s.status : 'FAULT',
      provider: c.provider ?? provider.id,
      model: provider.model ?? null,
      endpoint: provider.endpointLabel ?? null,
      detail: ok ? String(s.detail ?? '') : 'provider returned an invalid status',
      warnings: [...(c.warnings ?? []), ...(ok && Array.isArray(s.warnings) ? s.warnings.map(String) : [])],
      limits: {
        maxCallsPerSession: c.maxCallsPerSession ?? DEFAULTS.maxCallsPerSession,
        maxCallsPerDay: c.maxCallsPerDay ?? DEFAULTS.maxCallsPerDay,
        // The timeout lens calls actually use: the adapter's own (e.g. ollama.timeoutMs), else the global value.
        timeoutMs: Number.isInteger(provider.defaultTimeoutMs) && provider.defaultTimeoutMs > 0 ? provider.defaultTimeoutMs : c.timeoutMs ?? DEFAULTS.timeoutMs,
        maxTokens: c.maxTokens ?? DEFAULTS.maxTokens,
        contextTokens: ok && Number.isInteger(s.contextTokens) ? s.contextTokens
          : c.provider === 'ollama' ? c.ollama?.numCtx ?? null : c.openaiCompatible?.contextTokens ?? null,
      },
      hindsight: {
        trainingCutoff: c.trainingCutoff ?? null, source: c.trainingCutoffSource ?? null,
        marginDays: c.cutoffMarginDays ?? DEFAULTS.cutoffMarginDays, allowPreCutoffReplay: c.allowPreCutoffReplay === true,
      },
    };
  } catch (e) {
    return {
      status: 'FAULT', provider: provider?.id ?? 'unknown', model: provider?.model ?? null, endpoint: provider?.endpointLabel ?? null,
      detail: `status check failed: ${String(e?.message ?? e).slice(0, 200)}`, warnings: [],
      limits: { ...DEFAULTS },
    };
  }
}

/** Test/maintenance helper: forget cached providers (e.g. after env changes). */
export function resetProviderCache() {
  cache.clear();
}
