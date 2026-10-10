// Per-server application context shared by the API handlers: the database, the validated configuration, the
// environment (model/provider adapters read it; tests inject their own), the model provider, small caches, the
// API-level single-flight flags and the in-flight model work shown by GET /api/status (model.running).
import { status as modelProviderStatus, DEFAULTS as MODEL_DEFAULTS } from '../intel/model-provider.js';
import { resolveLensProvider, createPresetProvider, loadPresets } from '../intel/providers/presets.js';
import { secretForms } from '../data/providers/snaptrade.js';
import { getState } from '../replay/engine.js';
import { secretValues, sanitizeUrl } from '../config.js';

const MODEL_STATUS_TIMEOUT_MS = 4000;

/**
 * The ADAPTER that makes the model calls: 'anthropic' | 'openai-compatible' | 'ollama' | 'none' (an injected test
 * provider reports its own kind). Never rewritten: 'ollama' means the native adapter (options.num_ctx sent with every
 * request); an OpenAI-compatible endpoint that happens to be an Ollama server stays 'openai-compatible' (it cannot set
 * num_ctx per request) and is flagged by endpointFamily() instead.
 */
export function providerKind(p) {
  if (!p) return 'none';
  return typeof p.kind === 'string' && p.kind ? p.kind : 'none';
}

/**
 * Which server family the endpoint belongs to, independent of the adapter: 'ollama' for the native adapter and for an
 * OpenAI-compatible endpoint on Ollama's port 11434 (the adapter's own context-probe rule); otherwise null (unknown /
 * not applicable). Reported as model.endpointFamily so the /v1 route on Ollama can be told apart from the native one.
 */
export function endpointFamily(p) {
  if (!p) return null;
  if (p.kind === 'ollama' || p.flavor === 'ollama' || p.ollama === true) return 'ollama';
  if (p.kind === 'openai-compatible') {
    try { if (new URL(String(p.endpointLabel ?? p.config?.openaiCompatible?.baseUrl ?? '')).port === '11434') return 'ollama'; } catch { /* not a URL */ }
  }
  return null;
}

/**
 * @param {{db:import('node:sqlite').DatabaseSync, config:object, env?:object, provider?:object|null}} o
 *   provider: optional ModelProvider override (tests inject a mock; product code never passes one).
 */
export function createContext({ db, config, env = process.env, provider = null, fetchImpl = undefined, modelFetch = undefined, snaptradeFetch = undefined }) {
  // Test-only transport injection (product code passes neither): model presets' HTTP and SnapTrade's HTTP.
  const modelDeps = typeof modelFetch === 'function' ? { fetch: modelFetch } : null;
  const ctx = {
    db, config, env,
    // Configured secret values (scrubbed from every response): the fixed list plus every preset's key_env.
    // Each in raw and URL-encoded form (an upstream may echo a request URL).
    secrets: [...new Set([...secretValues(env), ...[...loadPresets({ env }).presets.values()].map((p) => (p.key_env ? env[p.key_env] : null)).filter((v) => typeof v === 'string' && v.length >= 8)]
      .flatMap((v) => secretForms(v)))],
    providerOverride: provider,
    fetchImpl,                  // market-data adapters' fetch (tests inject a stub; undefined = global fetch)
    snaptradeFetch,             // SnapTrade client's fetch (tests inject a mock server; undefined = global fetch)
    scanCache: new Map(),       // key ds|clock|segment -> scan result (as-of results are immutable for a given clock)
    busy: { step: false, assess: false, modelTest: false, feedVerify: false, realSync: false },
    lastRealSyncWall: 0,
    lastModelTestWall: 0,
    feedVerifyLast: { live: 0, options: 0 }, // wall ms of the last feed / options verification (cooldown)
    chainCheckpoint: null,      // {seq, hash, checked} of the last journal row verified in this process (GET /api/journal)
    // In-flight model work (GET /api/status model.running): the human assessment run, the explicit model test, and lens
    // calls made by agents during replay steps. lastAssessmentRun = outcome of the most recent human run.
    modelRuns: { assessment: null, modelTest: null, agentCalls: 0 },
    lastAssessmentRun: null,

    /**
     * The ModelProvider for a lens (or the default when lens is omitted): the stored/env preset selection when there
     * is one (per-lens overrides, or one pinned model for all lenses), else the legacy VECTOR_MODEL_PROVIDER provider.
     * The $0 guard applies to both (a non-free provider is a BLOCKED provider unless VECTOR_ALLOW_PAID=1).
     */
    provider(lens = null) {
      return ctx.providerOverride ?? resolveLensProvider({ db: ctx.db, env: ctx.env, lens, deps: modelDeps });
    },

    /** Providers for the given lenses, keyed by lens. */
    lensProviders(lenses) {
      return Object.fromEntries(lenses.map((l) => [l, ctx.provider(l)]));
    },

    /** A provider for an explicit {preset, model} choice (settings "Test"); the same guards apply. */
    presetProvider(choice) {
      return ctx.providerOverride ?? createPresetProvider(choice, { db: ctx.db, env: ctx.env, deps: modelDeps });
    },

    /** Model status for /api/status and /api/model. Never throws; bounded by a short timeout. */
    async modelStatus() {
      const p = ctx.provider();
      const run = async () => {
        if (ctx.providerOverride) {
          const s = await p.status();
          return { status: s?.status ?? 'FAULT', provider: p.id ?? p.kind, model: p.model ?? null, endpoint: p.endpointLabel ?? null, detail: String(s?.detail ?? ''), warnings: [], limits: null };
        }
        if (p.preset || p.blockedCode) {
          // Preset (or a $0-guard BLOCKED) provider: its own status plus the same limits/hindsight fields.
          const s = await p.status();
          const c = p.config ?? {};
          return {
            status: ['CONNECTED', 'DISCONNECTED', 'FAULT'].includes(s?.status) ? s.status : 'FAULT', provider: p.id, model: p.model ?? null,
            endpoint: p.endpointLabel ?? null, detail: String(s?.detail ?? ''), code: s?.code ?? p.blockedCode ?? null,
            warnings: Array.isArray(s?.warnings) ? s.warnings.map(String) : [],
            limits: {
              maxCallsPerSession: c.maxCallsPerSession ?? MODEL_DEFAULTS.maxCallsPerSession, maxCallsPerDay: c.maxCallsPerDay ?? MODEL_DEFAULTS.maxCallsPerDay,
              timeoutMs: Number.isInteger(p.defaultTimeoutMs) && p.defaultTimeoutMs > 0 ? p.defaultTimeoutMs : c.timeoutMs ?? MODEL_DEFAULTS.timeoutMs,
              maxTokens: c.maxTokens ?? MODEL_DEFAULTS.maxTokens, contextTokens: Number.isInteger(s?.contextTokens) ? s.contextTokens : null,
            },
            hindsight: { trainingCutoff: c.trainingCutoff ?? null, source: c.trainingCutoffSource ?? null, marginDays: c.cutoffMarginDays ?? MODEL_DEFAULTS.cutoffMarginDays, allowPreCutoffReplay: c.allowPreCutoffReplay === true },
            preset: p.preset?.id ?? null, privacy: p.privacy ?? null,
          };
        }
        return modelProviderStatus({}, null, { env: ctx.env });
      };
      let timer;
      const timeout = new Promise((resolve) => {
        timer = setTimeout(() => resolve({
          status: 'DISCONNECTED', provider: p.config?.provider ?? p.id ?? 'unknown', model: p.model ?? null, endpoint: p.endpointLabel ?? null,
          detail: `model status check did not complete within ${MODEL_STATUS_TIMEOUT_MS} ms`, warnings: [], limits: null,
        }), MODEL_STATUS_TIMEOUT_MS);
      });
      try {
        const s = await Promise.race([run(), timeout]);
        return { ...s, endpoint: sanitizeUrl(s.endpoint ?? null), kind: providerKind(p), endpointFamily: endpointFamily(p) };
      } catch (e) {
        return { status: 'FAULT', provider: p.id ?? 'unknown', model: p.model ?? null, endpoint: null, detail: `status check failed: ${String(e?.message ?? e).slice(0, 200)}`, warnings: [], limits: null, kind: providerKind(p), endpointFamily: endpointFamily(p) };
      } finally {
        clearTimeout(timer);
      }
    },

    /** Replay state (engine.getState) — session, dataset, clock. */
    replay() {
      return getState(ctx.db);
    },

    /**
     * Model work in flight, for GET /api/status and GET /api/model. Only details of the CURRENT replay session at or
     * before its clock are shown: a run started before a reset (whose as-of may lie after the new clock) is reported
     * as running without its symbol, time or outcome.
     * @param {{session_id:string|null, clock:number|null}} st replay state
     */
    modelActivity(st = ctx.replay()) {
      const visible = (r) => r && r.session_id === st.session_id && Number.isFinite(st.clock) && r.asOf <= st.clock;
      const a = ctx.modelRuns.assessment;
      let assessment = null;
      if (a) {
        if (visible(a)) {
          let done = 0;
          try {
            done = Number(ctx.db.prepare('SELECT COUNT(*) n FROM assessments WHERE session_id IS ? AND sym = ? AND as_of = ? AND created_wall >= ?')
              .get(a.session_id, a.sym, a.asOf, a.startedAt).n);
          } catch { done = 0; }
          assessment = {
            run_id: a.run_id, sym: a.sym, asOf: a.asOf, mode: a.mode, startedAt: a.startedAt, elapsedMs: Date.now() - a.startedAt,
            lensesDone: Math.min(done, a.lensesTotal), lensesTotal: a.lensesTotal,
          };
        } else assessment = { run_id: a.run_id, previousSession: true, startedAt: a.startedAt, elapsedMs: Date.now() - a.startedAt, note: 'started in a previous replay session; details withheld' };
      }
      const t = ctx.modelRuns.modelTest;
      const modelTest = t ? { startedAt: t.startedAt, elapsedMs: Date.now() - t.startedAt } : null;
      const agentCalls = ctx.modelRuns.agentCalls;
      const last = ctx.lastAssessmentRun;
      return {
        running: !!(assessment || modelTest || agentCalls > 0),
        inFlight: { assessment, modelTest, agentCalls },
        lastAssessmentRun: visible(last) ? last : null,
      };
    },
  };
  return ctx;
}

/** Bounded memo for as-of scans: results depend only on (ds, clock, segment), which are immutable inputs. */
export function memoScan(ctx, key, compute) {
  if (ctx.scanCache.has(key)) return ctx.scanCache.get(key);
  const v = compute();
  ctx.scanCache.set(key, v);
  while (ctx.scanCache.size > 8) ctx.scanCache.delete(ctx.scanCache.keys().next().value);
  return v;
}
