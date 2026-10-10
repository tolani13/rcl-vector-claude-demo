// Model presets (docs/CONTRACTS.md section 8a): named, secret-free configurations of the EXISTING adapters
// (openai-compatible, native ollama, anthropic) - no adapter is forked. The catalog lives in config/model-presets.json
// (or VECTOR_MODEL_PRESETS), because free-tier terms and limits change; this file only loads, validates and applies it.
//
// Every preset declares: cost ('free' | 'paid' | 'unknown'), trains_on_prompts (true | false | 'unknown', with the
// provider's own source URL), a per-model training_cutoff map (for the hindsight guard), local limits
// (requests_per_minute, requests_per_day) and its docs URL. Keys are never in the catalog: key_env names the server
// environment variable that holds one, and only its presence is ever reported.
//
// Guards applied here, before any call:
//   * $0 guard: a preset whose cost is not 'free' is refused (BLOCKED: PAID_PROVIDER_BLOCKED) unless VECTOR_ALLOW_PAID=1.
//     The legacy single-provider path (VECTOR_MODEL_PROVIDER) gets the same guard through an implicit preset:
//     anthropic is paid; an ollama / openai-compatible endpoint is free only on a loopback address.
//   * local rate limit and daily cap per preset (model_preset_calls table; LOCAL_RATE_LIMIT, nothing sent).
//   * model rules: OpenRouter needs a ':free' model id; a local preset refuses Ollama cloud models (they leave the machine).
// Selection: one default {preset, model}, optional per-lens overrides, and pinAllLenses (the experiment setting: one
// model for all three lenses). Stored in the controls table (PUT /api/model/selection) or taken from the environment
// (VECTOR_MODEL_PRESET, VECTOR_MODEL_PRESET_MODEL, VECTOR_MODEL_LENS_<LENS>=preset@model, VECTOR_MODEL_PIN_ALL_LENSES=1).
// With neither, the legacy VECTOR_MODEL_PROVIDER path is used unchanged (default none: MODEL DISCONNECTED).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getProvider, isSecretLikeKey, validIsoDate, KNOWN_TRAINING_CUTOFFS } from '../model-provider.js';
import { LENSES } from '../prompts.js';

const here = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_PRESETS_PATH = path.resolve(here, '..', '..', '..', 'config', 'model-presets.json');
export const PRESET_ADAPTERS = Object.freeze(['ollama', 'openai-compatible', 'anthropic']);
export const PRESET_COSTS = Object.freeze(['free', 'paid', 'unknown']);
export const DEFAULT_PRESET_ID = 'ollama-local';
export const SELECTION_KEY = 'model_selection';
const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;
const ID_RE = /^[a-z0-9][a-z0-9-]{1,40}$/;
const ENV_NAME_RE = /^[A-Z][A-Z0-9_]{2,60}$/;
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,127}$/;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

const allowPaid = (env) => String(env?.VECTOR_ALLOW_PAID ?? '').trim() === '1';

function isLoopbackUrl(raw) {
  try { return LOOPBACK_HOSTS.has(new URL(raw).hostname.toLowerCase()); } catch { return false; }
}
const isHttpsUrl = (s) => { try { return new URL(s).protocol === 'https:'; } catch { return false; } };

/** True when an Ollama model name refers to a cloud-hosted model (it would leave the machine). */
export function isOllamaCloudModel(model) {
  return /(^|[:\-])cloud$/i.test(String(model ?? '').trim());
}

/**
 * Validate one catalog entry. Returns a list of problems (empty when valid).
 * @param {object} p
 */
export function validatePreset(p) {
  const errs = [];
  if (!p || typeof p !== 'object' || Array.isArray(p)) return ['preset must be an object'];
  const where = typeof p.id === 'string' ? p.id : '(no id)';
  const bad = (m) => errs.push(`${where}: ${m}`);
  const secretKeys = [];
  const walk = (o, pre = '') => {
    for (const [k, v] of Object.entries(o)) {
      if (isSecretLikeKey(k)) secretKeys.push(pre + k);
      if (v && typeof v === 'object' && !Array.isArray(v)) walk(v, `${pre}${k}.`);
    }
  };
  walk(p);
  if (secretKeys.length) bad(`secret-like field(s) ${secretKeys.join(', ')}: keys belong in server environment variables (key_env)`);
  if (!ID_RE.test(String(p.id ?? ''))) bad('id must match ^[a-z0-9][a-z0-9-]{1,40}$');
  if (!PRESET_ADAPTERS.includes(p.adapter)) bad(`adapter must be one of ${PRESET_ADAPTERS.join(', ')}`);
  if (!PRESET_COSTS.includes(p.cost)) bad(`cost is required and must be one of ${PRESET_COSTS.join(', ')}`);
  if (![true, false, 'unknown'].includes(p.trains_on_prompts)) bad('trains_on_prompts must be true, false or "unknown"');
  if (typeof p.trains_on_prompts_source !== 'string' || !isHttpsUrl(p.trains_on_prompts_source)) bad('trains_on_prompts_source must be the provider\'s https URL');
  if (typeof p.docs_url !== 'string' || !isHttpsUrl(p.docs_url)) bad('docs_url must be an https URL');
  if (typeof p.local !== 'boolean') bad('local must be true or false');
  if (p.adapter === 'anthropic') {
    if (p.base_url !== null && p.base_url !== undefined) bad('anthropic presets use the SDK endpoint (base_url null)');
    if (p.local !== false) bad('an anthropic preset is a remote API: local must be false');
  } else {
    let u = null;
    try { u = new URL(String(p.base_url)); } catch { u = null; }
    if (!u || !['http:', 'https:'].includes(u.protocol) || u.username || u.password || u.search) bad('base_url must be an http(s) URL without credentials or query');
    else if (p.local === true && !isLoopbackUrl(p.base_url)) bad('a local preset must use a loopback base_url');
    else if (p.local === false && u.protocol !== 'https:') bad('a remote preset must use https');
  }
  if (p.local === true && p.trains_on_prompts !== false) bad('a local preset must declare trains_on_prompts false');
  if (p.key_env !== null && !(typeof p.key_env === 'string' && ENV_NAME_RE.test(p.key_env))) bad('key_env must be null or an environment variable name');
  if (p.default_model !== null && p.default_model !== undefined && !MODEL_RE.test(String(p.default_model))) bad('default_model is not a valid model id');
  if (p.model_suffix_required !== undefined && !(typeof p.model_suffix_required === 'string' && p.model_suffix_required.length <= 16)) bad('model_suffix_required must be a short string');
  const lim = p.limits;
  if (!lim || !Number.isInteger(lim.requests_per_minute) || lim.requests_per_minute < 1 || !Number.isInteger(lim.requests_per_day) || lim.requests_per_day < 1) {
    bad('limits.requests_per_minute and limits.requests_per_day are required positive integers');
  }
  const tc = p.training_cutoff ?? {};
  if (typeof tc !== 'object' || Array.isArray(tc)) bad('training_cutoff must be an object of model -> {date, source}');
  else {
    for (const [m, v] of Object.entries(tc)) {
      if (!validIsoDate(v?.date)) bad(`training_cutoff["${m}"].date must be YYYY-MM-DD`);
      if (typeof v?.source !== 'string' || !v.source) bad(`training_cutoff["${m}"].source is required`);
    }
  }
  for (const k of ['num_ctx', 'context_tokens']) {
    if (p[k] !== undefined && p[k] !== null && !(Number.isInteger(p[k]) && p[k] > 0 && p[k] <= 1_048_576)) bad(`${k} must be a positive integer`);
  }
  if (p.timeout_ms !== undefined && p.timeout_ms !== null && !(Number.isInteger(p.timeout_ms) && p.timeout_ms >= 1000 && p.timeout_ms <= 900_000)) bad('timeout_ms must be an integer 1000..900000');
  return errs;
}

const catalogCache = new Map(); // path -> {sig, value}

/**
 * Load and validate the preset catalog. Never throws. Invalid entries are excluded and reported in `errors`.
 * @returns {{path:string, loaded:boolean, presets:Map<string,object>, errors:string[]}}
 */
export function loadPresets({ env = process.env, file } = {}) {
  const p = file ?? env.VECTOR_MODEL_PRESETS ?? DEFAULT_PRESETS_PATH;
  let sig;
  try { const st = fs.statSync(p); sig = `${st.size}:${st.mtimeMs}`; } catch {
    return { path: p, loaded: false, presets: new Map(), errors: [`preset catalog not found (${path.basename(p)})`] };
  }
  const hit = catalogCache.get(p);
  if (hit && hit.sig === sig) return hit.value;
  const value = { path: p, loaded: false, presets: new Map(), errors: [] };
  try {
    const doc = JSON.parse(fs.readFileSync(p, 'utf8'));
    const list = Array.isArray(doc?.presets) ? doc.presets : null;
    if (!list) value.errors.push('preset catalog must contain a "presets" array');
    else {
      for (const entry of list) {
        const errs = validatePreset(entry);
        if (errs.length) { value.errors.push(...errs); continue; }
        if (value.presets.has(entry.id)) { value.errors.push(`${entry.id}: duplicate id`); continue; }
        value.presets.set(entry.id, Object.freeze(structuredClone(entry)));
      }
      value.loaded = true;
    }
  } catch (e) {
    value.errors.push(`preset catalog unreadable or invalid JSON (${e?.code ?? 'parse error'})`);
  }
  catalogCache.set(p, { sig, value });
  return value;
}

/** Secret-free view of a preset for the API and UI (key presence only). */
export function presetPublic(p, env = process.env) {
  return {
    id: p.id, label: p.label ?? p.id, adapter: p.adapter, base_url: p.base_url ?? null, local: p.local, cost: p.cost,
    trains_on_prompts: p.trains_on_prompts, trains_on_prompts_source: p.trains_on_prompts_source, trains_on_prompts_note: p.trains_on_prompts_note ?? null,
    docs_url: p.docs_url, limits_url: p.limits_url ?? null, any_model: p.any_model !== false, default_model: p.default_model ?? null,
    model_suffix_required: p.model_suffix_required ?? null, timeout_ms: p.timeout_ms ?? null,
    training_cutoff: structuredClone(p.training_cutoff ?? {}), limits: structuredClone(p.limits),
    key_env: p.key_env ?? null, key_present: p.key_env ? !!env[p.key_env] : null,
    allowed_by_cost_guard: p.cost === 'free' || allowPaid(env),
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Selection

function parseChoice(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  const s = raw.trim();
  const at = s.indexOf('@');
  return at < 0 ? { preset: s, model: null } : { preset: s.slice(0, at), model: s.slice(at + 1) || null };
}

/** Selection from the environment, or null when no preset variable is set. */
export function selectionFromEnv(env = process.env) {
  const lenses = {};
  for (const l of LENSES) {
    const c = parseChoice(env[`VECTOR_MODEL_LENS_${l.toUpperCase()}`]);
    if (c) lenses[l] = c;
  }
  const preset = typeof env.VECTOR_MODEL_PRESET === 'string' && env.VECTOR_MODEL_PRESET.trim() ? env.VECTOR_MODEL_PRESET.trim() : null;
  if (!preset && !Object.keys(lenses).length) return null;
  return {
    default: { preset: preset ?? DEFAULT_PRESET_ID, model: env.VECTOR_MODEL_PRESET_MODEL?.trim() || null },
    lenses, pinAllLenses: String(env.VECTOR_MODEL_PIN_ALL_LENSES ?? '').trim() === '1',
  };
}

export class SelectionError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

function normChoice(c, presets, where) {
  if (c === null || c === undefined) return null;
  if (typeof c !== 'object' || Array.isArray(c)) throw new SelectionError('SELECTION_INVALID', `${where} must be {preset, model?}`);
  const extra = Object.keys(c).filter((k) => !['preset', 'model', 'trainingCutoff'].includes(k));
  if (extra.length) throw new SelectionError('SELECTION_INVALID', `${where}: unknown field(s) ${extra.join(', ')}`);
  const preset = String(c.preset ?? '');
  if (!presets.has(preset)) throw new SelectionError('PRESET_UNKNOWN', `${where}: unknown preset "${preset.slice(0, 40)}"`);
  const model = c.model === null || c.model === undefined || c.model === '' ? null : String(c.model);
  if (model !== null && !MODEL_RE.test(model)) throw new SelectionError('SELECTION_INVALID', `${where}: model id has invalid characters`);
  const out = { preset, model };
  if (c.trainingCutoff !== undefined && c.trainingCutoff !== null) {
    if (!validIsoDate(c.trainingCutoff)) throw new SelectionError('SELECTION_INVALID', `${where}: trainingCutoff must be YYYY-MM-DD`);
    out.trainingCutoff = c.trainingCutoff;
  }
  return out;
}

/** Validate and normalise a selection; throws SelectionError. */
export function normalizeSelection(sel, presets) {
  if (!sel || typeof sel !== 'object' || Array.isArray(sel)) throw new SelectionError('SELECTION_INVALID', 'selection must be an object');
  const extra = Object.keys(sel).filter((k) => !['default', 'lenses', 'pinAllLenses'].includes(k));
  if (extra.length) throw new SelectionError('SELECTION_INVALID', `unknown field(s) ${extra.join(', ')}`);
  const def = normChoice(sel.default ?? { preset: DEFAULT_PRESET_ID }, presets, 'default');
  const lenses = {};
  const rawL = sel.lenses ?? {};
  if (typeof rawL !== 'object' || Array.isArray(rawL)) throw new SelectionError('SELECTION_INVALID', 'lenses must be an object');
  for (const [k, v] of Object.entries(rawL)) {
    if (!LENSES.includes(k)) throw new SelectionError('SELECTION_INVALID', `unknown lens "${String(k).slice(0, 20)}" (use ${LENSES.join(', ')})`);
    const c = normChoice(v, presets, `lenses.${k}`);
    if (c) lenses[k] = c;
  }
  if (sel.pinAllLenses !== undefined && typeof sel.pinAllLenses !== 'boolean') throw new SelectionError('SELECTION_INVALID', 'pinAllLenses must be true or false');
  return { default: def, lenses, pinAllLenses: sel.pinAllLenses === true };
}

function readStored(db) {
  if (!db) return null;
  try {
    const r = db.prepare('SELECT v FROM controls WHERE k = ?').get(SELECTION_KEY);
    return r ? JSON.parse(r.v) : null;
  } catch { return null; }
}

/** The effective selection and where it came from: stored (UI) > environment > null (legacy single provider). */
export function getSelection(db, env = process.env) {
  const stored = readStored(db);
  if (stored && stored.cleared !== true) return { source: 'stored', selection: stored };
  const fromEnv = selectionFromEnv(env);
  return fromEnv ? { source: 'env', selection: fromEnv } : { source: 'legacy', selection: null };
}

/** Persist a normalised selection (or clear it with null). Non-secret: preset ids, model names, owner cutoffs. */
export function saveSelection(db, selection) {
  const v = JSON.stringify(selection ?? { cleared: true });
  db.prepare('INSERT INTO controls (k, v, updated_wall) VALUES (?, ?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v, updated_wall = excluded.updated_wall')
    .run(SELECTION_KEY, v, Date.now());
}

/** The {preset, model} a lens uses: the pinned default for every lens when pinAllLenses, else the lens override. */
export function choiceForLens(selection, lens) {
  if (!selection) return null;
  if (selection.pinAllLenses || !lens) return selection.default;
  return selection.lenses?.[lens] ?? selection.default;
}

// ---------------------------------------------------------------------------------------------------------------
// Providers

function blockedProvider({ id, model = null, status, code, detail, privacy = null, preset = null }) {
  const text = `${code ? `BLOCKED: ${code} — ` : ''}${detail}`;
  return {
    id, kind: 'none', model, endpointLabel: null, blockedCode: code ?? null, preset, privacy,
    config: { provider: id, preset: preset?.id ?? null },
    async status() { return { status, detail: text, code: code ?? null }; },
    async complete() {
      return {
        ok: false, json: null, rawText: null, refusal: null, usage: { in: 0, out: 0 }, latencyMs: 0, servedModel: null, fallbackUsed: false,
        error: `${status === 'FAULT' ? 'CONFIG' : 'DISCONNECTED'}: ${text}`, errorKind: status === 'FAULT' ? 'CONFIG' : 'DISCONNECTED',
      };
    },
  };
}

const memCalls = new Map(); // preset id -> wall ms[] (only when no db is given, e.g. unit tests)

function callsSince(db, presetId, since) {
  if (!db) return (memCalls.get(presetId) ?? []).filter((t) => t >= since).length;
  return db.prepare('SELECT COUNT(*) n FROM model_preset_calls WHERE preset_id = ? AND wall >= ?').get(presetId, since).n;
}

function recordCall(db, presetId, wall) {
  if (!db) { memCalls.set(presetId, [...(memCalls.get(presetId) ?? []).filter((t) => t >= wall - DAY_MS), wall]); return; }
  db.prepare('INSERT INTO model_preset_calls (preset_id, wall) VALUES (?, ?)').run(presetId, wall);
}

/** Local per-preset budget: requests in the last minute and the last 24 h against the catalog limits. */
export function presetBudget(db, preset, now = Date.now()) {
  const m = callsSince(db, preset.id, now - MINUTE_MS);
  const d = callsSince(db, preset.id, now - DAY_MS);
  return {
    perMinute: { cap: preset.limits.requests_per_minute, used: m, remaining: Math.max(0, preset.limits.requests_per_minute - m) },
    perDay: { cap: preset.limits.requests_per_day, used: d, remaining: Math.max(0, preset.limits.requests_per_day - d) },
    source: preset.limits.source ?? null,
  };
}

/** Training cutoff for a model under a preset: owner-set (selection) > catalog > built-in > unknown. */
export function cutoffFor(preset, model, choice = {}) {
  if (validIsoDate(choice.trainingCutoff)) return { date: choice.trainingCutoff, source: 'owner-set in the model selection' };
  const c = preset.training_cutoff?.[model];
  if (c && validIsoDate(c.date)) return { date: c.date, source: `preset ${preset.id}: ${c.source}` };
  if (KNOWN_TRAINING_CUTOFFS[model]) return { date: KNOWN_TRAINING_CUTOFFS[model], source: 'built-in' };
  return { date: null, source: null };
}

/** Remove secret values (raw and URL-encoded) from a provider result's text fields before anything stores them. */
export function scrubResult(res, secrets) {
  const forms = secrets.filter((s) => typeof s === 'string' && s.length >= 8)
    .flatMap((s) => [s, encodeURIComponent(s), new URLSearchParams({ x: s }).toString().slice(2)]);
  if (!res || typeof res !== 'object' || !forms.length) return res;
  const clean = (v) => {
    if (typeof v !== 'string') return v;
    let t = v;
    for (const f of forms) t = t.split(f).join('[REDACTED]');
    return t;
  };
  const out = { ...res, error: clean(res.error), rawText: clean(res.rawText) };
  if (res.refusal && typeof res.refusal === 'object') out.refusal = { ...res.refusal, explanation: clean(res.refusal.explanation) };
  return out;
}

const LEGACY_SECRET_VARS = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'VECTOR_OPENAI_API_KEY'];

const providerCache = new Map();

/**
 * Build the provider for one {preset, model} choice. Never throws. Applies the $0 guard, model rules, key presence,
 * and wraps complete() with the preset's local rate limit and daily cap.
 * @param {{preset:string, model?:string|null, trainingCutoff?:string}} choice
 * @param {{db?:object, env?:object, deps?:object|null, presets?:Map, file?:string}} o
 */
export function createPresetProvider(choice, { db = null, env = process.env, deps = null, presets = null, file } = {}) {
  const catalog = presets ?? loadPresets({ env, file }).presets;
  const preset = catalog.get(choice?.preset);
  const pid = `preset:${choice?.preset ?? 'none'}`;
  if (!preset) return blockedProvider({ id: pid, status: 'FAULT', code: 'PRESET_UNKNOWN', detail: `unknown model preset "${String(choice?.preset ?? '').slice(0, 40)}" (see config/model-presets.json)` });
  const privacy = { trains_on_prompts: preset.trains_on_prompts, source: preset.trains_on_prompts_source, local: preset.local };
  const pub = presetPublic(preset, env);
  const model = choice.model ?? preset.default_model ?? null;
  const base = { id: `preset:${preset.id}`, model, privacy, preset: pub };
  // $0 guard first: nothing about a paid preset is started, probed or called.
  if (preset.cost !== 'free' && !allowPaid(env)) {
    return blockedProvider({ ...base, status: 'FAULT', code: 'PAID_PROVIDER_BLOCKED', detail: `preset ${preset.id} declares cost "${preset.cost}"; VECTOR's budget is $0. Set VECTOR_ALLOW_PAID=1 in the server environment to allow it.` });
  }
  if (!model) return blockedProvider({ ...base, status: 'DISCONNECTED', code: 'MODEL_NOT_SET', detail: `preset ${preset.id} has no default model: name one in the model selection` });
  if (!MODEL_RE.test(model)) return blockedProvider({ ...base, status: 'FAULT', code: 'MODEL_INVALID', detail: 'model id has invalid characters' });
  if (preset.model_suffix_required && !model.endsWith(preset.model_suffix_required)) {
    return blockedProvider({ ...base, status: 'FAULT', code: 'PRESET_MODEL_NOT_FREE', detail: `preset ${preset.id} only allows model ids ending in "${preset.model_suffix_required}" (free variants)` });
  }
  if (preset.any_model === false && !preset.training_cutoff?.[model]) {
    return blockedProvider({ ...base, status: 'FAULT', code: 'PRESET_MODEL_NOT_LISTED', detail: `preset ${preset.id} allows only its listed models` });
  }
  if (preset.local && preset.adapter === 'ollama' && isOllamaCloudModel(model)) {
    return blockedProvider({ ...base, status: 'FAULT', code: 'LOCAL_PRESET_CLOUD_MODEL', detail: `"${model}" is an Ollama cloud model: prompts would leave this machine, so the local preset refuses it` });
  }
  const key = preset.key_env ? env[preset.key_env] : null;
  if (preset.key_env && !key) {
    return blockedProvider({ ...base, status: 'DISCONNECTED', code: 'NO_API_KEY', detail: `set ${preset.key_env} in the server environment (never in the browser or a file in git), then restart` });
  }
  const cutoff = cutoffFor(preset, model, choice);
  const cacheKey = JSON.stringify([preset, model, cutoff, !!key, allowPaid(env), env.VECTOR_MODEL_TIMEOUT_MS ?? null, env.VECTOR_MODEL_MAX_TOKENS ?? null, env.VECTOR_MODEL_CONFIG ?? null, !!db]);
  if (!deps && providerCache.has(cacheKey) && providerCache.get(cacheKey).db === db) return providerCache.get(cacheKey).provider;

  // The inner provider is the existing adapter, configured from the preset. The environment passed to it carries only
  // this preset's key (as VECTOR_OPENAI_API_KEY for the OpenAI-compatible adapter), so a key never reaches another
  // endpoint; the legacy global cutoff variable is removed because the cutoff is decided per model above.
  const innerEnv = { ...env, VECTOR_OPENAI_API_KEY: preset.adapter === 'openai-compatible' ? (key ?? '') : '', VECTOR_MODEL_TRAINING_CUTOFF: '' };
  const overrides = preset.adapter === 'ollama'
    ? { provider: 'ollama', ollama: { baseUrl: preset.base_url, model, ...(preset.num_ctx ? { numCtx: preset.num_ctx } : {}), ...(preset.timeout_ms ? { timeoutMs: preset.timeout_ms } : {}) } }
    : preset.adapter === 'openai-compatible'
      ? { provider: 'openai-compatible', openaiCompatible: { baseUrl: preset.base_url, model, ...(preset.context_tokens ? { contextTokens: preset.context_tokens } : {}), ...(preset.timeout_ms ? { timeoutMs: preset.timeout_ms } : {}) } }
      : { provider: 'anthropic', anthropic: { model } };
  const inner = getProvider(overrides, deps, { env: innerEnv, file });
  const config = { ...(inner.config ?? {}), trainingCutoff: cutoff.date, trainingCutoffSource: cutoff.source, preset: preset.id };

  const provider = {
    id: `preset:${preset.id}`,
    kind: inner.kind,
    model: inner.model ?? model,
    endpointLabel: inner.endpointLabel ?? null,
    defaultTimeoutMs: inner.defaultTimeoutMs,
    ...(typeof inner.callBudgetMs === 'function' ? { callBudgetMs: (...a) => inner.callBudgetMs(...a) } : {}),
    ...(inner.flavor ? { flavor: inner.flavor } : {}),
    preset: pub,
    privacy,
    config,
    /** Local rate-limit state for this preset (no network). */
    localBudget: (now = Date.now()) => presetBudget(db, preset, now),
    async status() { return inner.status(); },
    async complete(req) {
      const now = Date.now();
      const b = presetBudget(db, preset, now);
      if (b.perMinute.remaining < 1 || b.perDay.remaining < 1) {
        const which = b.perMinute.remaining < 1 ? `${b.perMinute.used}/${b.perMinute.cap} requests in the last minute` : `${b.perDay.used}/${b.perDay.cap} requests in the last 24 h`;
        return {
          ok: false, json: null, rawText: null, refusal: null, usage: { in: 0, out: 0 }, latencyMs: 0, servedModel: null, fallbackUsed: false,
          errorKind: 'LOCAL_RATE_LIMIT', error: `LOCAL_RATE_LIMIT: preset ${preset.id} reached its local limit (${which}; config/model-presets.json). Nothing was sent.`,
        };
      }
      recordCall(db, preset.id, now);
      return scrubResult(await inner.complete(req), [key]);
    },
  };
  if (!deps) providerCache.set(cacheKey, { db, provider });
  return provider;
}

/**
 * The implicit preset of a legacy (VECTOR_MODEL_PROVIDER) provider, for the $0 guard and the privacy gate.
 * anthropic: paid, trains unknown. ollama / openai-compatible: free and not training only on a loopback endpoint.
 */
export function legacyPresetFor(provider) {
  const c = provider?.config ?? {};
  const kind = c.provider ?? provider?.kind ?? 'none';
  if (kind === 'anthropic') return { id: 'legacy:anthropic', cost: 'paid', trains_on_prompts: 'unknown', local: false, source: null };
  if (kind === 'ollama' || kind === 'openai-compatible') {
    const baseUrl = kind === 'ollama' ? c.ollama?.baseUrl : c.openaiCompatible?.baseUrl;
    const local = isLoopbackUrl(baseUrl) && !(kind === 'ollama' && isOllamaCloudModel(c.ollama?.model));
    return { id: `legacy:${kind}`, cost: local ? 'free' : 'unknown', trains_on_prompts: local ? false : 'unknown', local, source: local ? 'loopback endpoint (local model)' : null };
  }
  return { id: 'legacy:none', cost: 'free', trains_on_prompts: false, local: true, source: null };
}

const guarded = new WeakMap(); // legacy provider -> {paid:boolean, wrapped} (stable identity for callers that cache by provider)

/**
 * Apply the $0 guard to a legacy provider. Returns a stable wrapper carrying `privacy` (the shared cached adapter is
 * never mutated), or a BLOCKED provider when the implicit preset is not free and VECTOR_ALLOW_PAID is not set.
 */
export function guardLegacy(provider, env = process.env) {
  const imp = legacyPresetFor(provider);
  const privacy = { trains_on_prompts: imp.trains_on_prompts, source: imp.source, local: imp.local };
  const blocked = provider?.kind !== 'none' && imp.cost !== 'free' && !allowPaid(env);
  const hit = provider && typeof provider === 'object' ? guarded.get(provider) : null;
  if (hit && hit.blocked === blocked) return hit.wrapped;
  const wrapped = blocked
    ? blockedProvider({
      id: provider?.id ?? imp.id, model: provider?.model ?? null, status: 'FAULT', code: 'PAID_PROVIDER_BLOCKED', privacy,
      detail: `VECTOR_MODEL_PROVIDER=${imp.id.replace('legacy:', '')} is ${imp.cost === 'paid' ? 'a paid provider' : 'a non-local endpoint with no free preset'}; VECTOR's budget is $0. Use a free preset (VECTOR_MODEL_PRESET) or set VECTOR_ALLOW_PAID=1.`,
    })
    : Object.assign(Object.create(provider), {
      privacy,
      // Same key scrub as presets: an endpoint echoing its key never reaches an assessment row or the journal.
      async complete(req) { return scrubResult(await provider.complete(req), LEGACY_SECRET_VARS.map((k) => env[k])); },
    });
  if (provider && typeof provider === 'object') guarded.set(provider, { blocked, wrapped });
  return wrapped;
}

/**
 * Resolve the provider for a lens (or the default when lens is null) from the effective selection.
 * @param {{db?:object, env?:object, lens?:string|null, deps?:object|null, file?:string}} o
 */
export function resolveLensProvider({ db = null, env = process.env, lens = null, deps = null, file } = {}) {
  const { selection } = getSelection(db, env);
  if (!selection) return guardLegacy(getProvider({}, deps, { env }), env);
  let sel;
  const presets = loadPresets({ env, file }).presets;
  try { sel = normalizeSelection(selection, presets); } catch (e) {
    return blockedProvider({ id: 'preset:invalid', status: 'FAULT', code: e.code ?? 'SELECTION_INVALID', detail: `model selection invalid: ${e.message}` });
  }
  return createPresetProvider(choiceForLens(sel, lens), { db, env, deps, presets, file });
}

/** Secret-free summary of the selection and what each lens would use (no network). */
export function selectionSummary(db, env = process.env) {
  const { source, selection } = getSelection(db, env);
  const lensRows = {};
  for (const l of LENSES) {
    const p = resolveLensProvider({ db, env, lens: l });
    lensRows[l] = {
      provider: p.id, kind: p.kind, model: p.model ?? null, preset: p.preset?.id ?? null, cost: p.preset?.cost ?? null,
      trains_on_prompts: p.privacy?.trains_on_prompts ?? 'unknown', training_cutoff: p.config?.trainingCutoff ?? null,
      blocked: p.blockedCode ?? null,
    };
  }
  let normalized = null;
  if (selection) {
    try { normalized = normalizeSelection(selection, loadPresets({ env }).presets); } catch { normalized = null; }
  }
  const models = new Set(Object.values(lensRows).map((r) => `${r.provider}|${r.model}`));
  return {
    source, selection: normalized, pinAllLenses: normalized?.pinAllLenses === true,
    sameModelAllLenses: models.size === 1, lenses: lensRows, allowPaid: allowPaid(env),
  };
}

/**
 * Privacy gate for real-account data (CONTRACTS section 8a): every lens provider must declare trains_on_prompts false,
 * unless the owner lists the preset in VECTOR_REAL_DATA_ALLOW_PRESETS (comma-separated ids).
 * @param {Record<string, object>} providersByLens
 */
export function realDataPrivacyCheck(providersByLens, env = process.env) {
  const allow = new Set(String(env.VECTOR_REAL_DATA_ALLOW_PRESETS ?? '').split(',').map((s) => s.trim()).filter(Boolean));
  const blocked = [];
  for (const [lens, p] of Object.entries(providersByLens)) {
    const trains = p?.privacy?.trains_on_prompts ?? 'unknown';
    const presetId = p?.preset?.id ?? null;
    if (trains === false || (presetId && allow.has(presetId))) continue;
    blocked.push({ lens, provider: p?.id ?? 'unknown', preset: presetId, trains_on_prompts: trains });
  }
  return { ok: blocked.length === 0, blocked };
}

/** Test helper: forget cached preset providers and catalogs. */
export function resetPresetCaches() {
  providerCache.clear();
  catalogCache.clear();
  memCalls.clear();
}
