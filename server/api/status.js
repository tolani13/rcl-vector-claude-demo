// System status, data sources, model provider status / explicit test, and options status (docs/CONTRACTS.md section 9).
// Nothing here assumes a status: data mode derives from the replay's stored dataset, live/options status from
// server/data/providers (NO_VERIFIED_DATA / NO_VERIFIED_OPTIONS_DATA unless verified in this process), model status
// from the configured ModelProvider. Secret values are never read here; only presence flags are reported.
import { getDataset, coverageEndMs, sessionWindow } from '../data/marketdata.js';
import { listSources } from '../data/sources.js';
import { feedStatus } from '../data/providers/index.js';
import { optionsStatus } from '../sim/options.js';
import { getKillState, listAgents } from '../controls.js';
import { append } from '../journal.js';
import { conflict, ApiError, onlyKeys, bool, badRequest, oneOf } from './http.js';
import { loadPresets, selectionSummary } from '../intel/providers/presets.js';
import { LENSES } from '../intel/prompts.js';
import { modelCallBudget, countedCallsUsed } from '../intel/assessments.js';
import { fmtEt } from '../util/time.js';

const MODEL_TEST_MIN_INTERVAL_MS = 10_000;

const finiteOrNull = (v) => (Number.isFinite(v) ? v : null);

/** Data mode for the status strip: HISTORICAL_REAL only when the replay runs on a stored real market dataset. */
export function dataMode(db, ds) {
  if (!ds) return { mode: 'NO_VERIFIED_DATA', dataset: null };
  const d = getDataset(db, ds);
  if (!d) return { mode: 'NO_VERIFIED_DATA', dataset: null };
  const mode = d.kind === 'market_ticks' && (d.status === 'complete' || d.status === 'partial') ? 'HISTORICAL_REAL'
    : d.kind === 'import' ? 'IMPORTED_UNVERIFIED' : 'NO_VERIFIED_DATA';
  const partial = d.kind === 'market_ticks' && d.status === 'partial';
  return {
    mode,
    dataset: {
      id: d.id, kind: d.kind, provider: d.provider, trade_date: d.trade_date, status: d.status, sha256: d.sha256,
      venue_coverage: d.venue_coverage, entitlement: d.entitlement, attribution: d.attribution,
      event_time_start: d.event_time_start, event_time_end: d.event_time_end, ingested_at: d.ingested_at,
      complete: d.kind === 'market_ticks' ? d.status === 'complete' : null,
      coverage_end: partial ? finiteOrNull(coverageEndMs(db, ds)) : null,
    },
  };
}

/**
 * Coverage of the replay's dataset. Prefers the engine's own fields (replay state coverage_end / truncated / complete);
 * otherwise derives them from the dataset: complete = status 'complete'; coverage_end = end of the last fully observed
 * minute of a partial dataset; truncated = the session ends before the regular close (t_end < 16:00 ET);
 * beyondCoverage = the clock is past the observed data (no market state exists there).
 */
export function replayCoverage(db, st) {
  if (!st?.ds) return { complete: null, coverage_end: null, truncated: false, beyondCoverage: false };
  const d = getDataset(db, st.ds);
  const complete = typeof st.complete === 'boolean' ? st.complete
    : typeof st.dataset?.complete === 'boolean' ? st.dataset.complete
      : d ? d.status === 'complete' : null;
  const engineEnd = st.coverage_end !== undefined ? st.coverage_end : st.dataset?.coverage_end;
  const coverage_end = engineEnd !== undefined ? finiteOrNull(engineEnd) : d?.status === 'partial' ? finiteOrNull(coverageEndMs(db, st.ds)) : null;
  const win = sessionWindow(db, st.ds);
  const truncated = typeof st.truncated === 'boolean' ? st.truncated : !!(win && Number.isFinite(st.t_end) && st.t_end < win.close);
  return { complete, coverage_end, truncated, beyondCoverage: coverage_end !== null && Number.isFinite(st.clock) && st.clock > coverage_end };
}

function modeDetail(dm, cov) {
  if (dm.mode !== 'HISTORICAL_REAL') return 'No verified market dataset is loaded for the replay. Ingest one (npm run ingest:iex -- --date YYYY-MM-DD) and reset the replay.';
  const base = 'Replay of a stored, sourced historical IEX dataset. Not live; agents see only what was knowable at the replay clock.';
  if (cov.complete !== false) return base;
  const end = cov.coverage_end !== null ? fmtEt(cov.coverage_end) : 'an unknown time';
  return `${base} PARTIAL dataset: stored data ends at ${end}${cov.truncated ? '; the replay session is truncated there' : '; market state after it was never observed (no quotes, no fills)'}.`;
}

function agentRow(a) {
  return {
    id: a.id, portfolio_id: a.portfolio_id, lens: a.lens, segment: a.segment, state: a.state, state_reason: a.state_reason,
    last_ok: a.last_ok, last_fail: a.last_fail, decisionMode: a.strategy?.decisionMode ?? null, strategy_id: a.strategy?.id ?? null,
  };
}

/** GET /api/status */
export async function getStatus(ctx) {
  const { db } = ctx;
  const st = ctx.replay();
  const dm = dataMode(db, st.ds);
  const feeds = feedStatus(ctx.env);
  const model = await ctx.modelStatus();
  const kill = getKillState(db);
  const cov = replayCoverage(db, st);
  const activity = ctx.modelActivity(st);
  return {
    app: ctx.config.app,
    data: {
      mode: dm.mode,
      modeDetail: modeDetail(dm, cov),
      dataset: dm.dataset,
      live: { status: feeds.live.status, detail: feeds.live.detail, provider: feeds.live.provider ?? null, lastQuoteTs: feeds.live.lastQuoteTs ?? null },
    },
    replay: {
      status: st.status, session_id: st.session_id, ds: st.ds, t_start: st.t_start, t_end: st.t_end, clock: st.clock,
      playing: st.playing, tick_wall_ms: st.tick_wall_ms, minutesElapsed: st.minutesElapsed ?? null, minutesRemaining: st.minutesRemaining ?? null,
      busy: !!(st.busy || ctx.busy.step), lastTickError: st.lastTickError ?? null,
      complete: cov.complete, coverage_end: cov.coverage_end, truncated: cov.truncated, beyondCoverage: cov.beyondCoverage,
      session_close: st.session_close ?? null, truncation_note: st.truncation_note ?? null,
    },
    model: {
      status: model.status, provider: model.provider, kind: model.kind ?? 'none', endpointFamily: model.endpointFamily ?? null, model: model.model, detail: model.detail,
      running: activity.running, inFlight: activity.inFlight, lastAssessmentRun: activity.lastAssessmentRun,
    },
    options: { status: feeds.options.status, detail: feeds.options.detail },
    kill: { engaged: kill.engaged, at: kill.at, by: kill.by, protective_policy: kill.protective_policy },
    agents: listAgents(db).map(agentRow),
    serverTime: Date.now(),
  };
}

/** GET /api/sources */
export function getSources(ctx) {
  return listSources(ctx.db, { env: ctx.env });
}

/** GET /api/model — provider status and limits; key presence flags only (never values). */
export async function getModel(ctx) {
  const m = await ctx.modelStatus();
  const st = ctx.replay();
  // The number the per-session cap enforces (calls that never reached a model are audit rows only), plus the raw count.
  const used = st.session_id ? countedCallsUsed(ctx.db, st.session_id) : 0;
  const rows = st.session_id ? ctx.db.prepare('SELECT COUNT(*) n FROM assessments WHERE session_id = ?').get(st.session_id).n : 0;
  return {
    status: m.status, provider: m.provider, kind: m.kind, endpointFamily: m.endpointFamily ?? null, model: m.model, endpoint: m.endpoint, detail: m.detail,
    configured: m.kind !== 'none',
    warnings: m.warnings ?? [],
    limits: m.limits ?? null,
    callsUsedThisSession: Number(used),
    auditRowsThisSession: Number(rows),
    budget: modelCallBudget(ctx.db, ctx.provider()),
    ...ctx.modelActivity(st),
    keysPresent: { ANTHROPIC_API_KEY: !!ctx.env.ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN: !!ctx.env.ANTHROPIC_AUTH_TOKEN, VECTOR_OPENAI_API_KEY: !!ctx.env.VECTOR_OPENAI_API_KEY },
    preset: ctx.provider()?.preset?.id ?? null,
    blocked: ctx.provider()?.blockedCode ?? null,
    selection: selectionSummary(ctx.db, ctx.env),
    uiText: m.status === 'CONNECTED' ? null : 'MODEL DISCONNECTED / ASSESSMENT NOT RUN',
    setup: [
      'VECTOR_MODEL_PROVIDER=anthropic plus ANTHROPIC_API_KEY (server environment); optional VECTOR_ANTHROPIC_MODEL',
      'or VECTOR_MODEL_PROVIDER=openai-compatible plus VECTOR_OPENAI_BASE_URL and VECTOR_OPENAI_MODEL (VECTOR_OPENAI_API_KEY if the endpoint needs one; an Ollama /v1 endpoint uses the server\'s own context, 4096 tokens unless OLLAMA_CONTEXT_LENGTH is raised)',
      'or VECTOR_MODEL_PROVIDER=ollama plus VECTOR_OLLAMA_MODEL (native Ollama API; VECTOR_OLLAMA_BASE_URL default http://127.0.0.1:11434; VECTOR_OLLAMA_NUM_CTX default 16384 is sent as options.num_ctx on every request, so the Ollama server needs no OLLAMA_CONTEXT_LENGTH change)',
      'or a named preset (config/model-presets.json; GET /api/model/presets): VECTOR_MODEL_PRESET=ollama-local|lmstudio-local|groq|openrouter-free|gemini-flash-free plus VECTOR_MODEL_PRESET_MODEL; per lens VECTOR_MODEL_LENS_<LENS>=preset@model; VECTOR_MODEL_PIN_ALL_LENSES=1 pins one model for all three lenses. Presets whose cost is not free are refused unless VECTOR_ALLOW_PAID=1.',
      'VECTOR_MAX_MODEL_CALLS_PER_SESSION caps model calls per replay session (default 60); VECTOR_MAX_MODEL_CALLS_PER_DAY caps lens calls plus model tests across all sessions in a rolling 24 h window (default 300). Restart the server after changing the environment.',
    ],
  };
}

// Provider-facing schema: no string-length / numeric keywords (Anthropic structured outputs and several
// OpenAI-compatible servers reject them); the note length is enforced after parsing instead.
export const TEST_SCHEMA = Object.freeze({
  type: 'object', additionalProperties: false, required: ['ok', 'note'],
  properties: { ok: { type: 'boolean' }, note: { type: 'string' } },
});
const TEST_NOTE_MAX = 200;

/**
 * POST /api/model/test {confirm:true} — explicit, human-confirmed connectivity test: ONE small structured-output request
 * (the provider may bill it). Single-flight and rate-limited; journaled as MODEL_TEST (no secrets, no prompt content
 * beyond the fixed probe).
 */
export async function postModelTest(ctx, _req, { body }) {
  onlyKeys(body, ['confirm', 'preset', 'model', 'lens']);
  const confirm = bool(body.confirm, 'confirm', { optional: true, dflt: false });
  // Which provider: an explicit preset (+ model) from the settings selector, a lens's selected provider, or the default.
  let p;
  if (body.preset !== undefined) {
    if (typeof body.preset !== 'string' || !loadPresets({ env: ctx.env }).presets.has(body.preset)) throw badRequest('PRESET_UNKNOWN', 'preset must be an id from GET /api/model/presets');
    if (body.model !== undefined && body.model !== null && (typeof body.model !== 'string' || body.model.length > 128)) throw badRequest('MODEL_INVALID', 'model must be a model id string');
    p = ctx.presetProvider({ preset: body.preset, model: body.model || null });
  } else {
    if (body.model !== undefined) throw badRequest('MODEL_WITHOUT_PRESET', 'model is only accepted together with preset');
    const lens = body.lens === undefined ? null : oneOf(body.lens, LENSES, 'lens');
    p = ctx.provider(lens);
  }
  if (p?.blockedCode) {
    const s = await p.status();
    throw conflict(p.blockedCode, String(s?.detail ?? `BLOCKED: ${p.blockedCode}`).slice(0, 400), { preset: p.preset?.id ?? null, model: p.model ?? null });
  }
  if (!p || p.kind === 'none' || typeof p.complete !== 'function') {
    throw conflict('MODEL_DISCONNECTED', 'No model provider is configured (VECTOR_MODEL_PROVIDER=none): MODEL DISCONNECTED / ASSESSMENT NOT RUN.');
  }
  if (confirm !== true) throw conflict('CONFIRMATION_REQUIRED', 'The model test sends one request that the provider may bill; resend with confirm:true after the user confirms.');
  if (ctx.busy.modelTest) throw new ApiError(429, 'MODEL_TEST_BUSY', 'a model test is already running');
  const budget = modelCallBudget(ctx.db, p);
  if (budget.remaining < 1) throw new ApiError(429, 'CALL_CAP_REACHED', `global model-call budget reached (${budget.used}/${budget.cap}, ${budget.window})`);
  const wait = ctx.lastModelTestWall + MODEL_TEST_MIN_INTERVAL_MS - Date.now();
  if (wait > 0) throw new ApiError(429, 'MODEL_TEST_RATE_LIMITED', `wait ${Math.ceil(wait / 1000)} s before testing again`);
  ctx.busy.modelTest = true;
  ctx.lastModelTestWall = Date.now();
  ctx.modelRuns.modelTest = { startedAt: ctx.lastModelTestWall };
  try {
    const r = await p.complete({
      system: 'You are a connectivity probe for a paper-trading research tool. Reply only with the requested JSON.',
      user: 'Return {"ok": true, "note": "connectivity test"}.',
      schema: TEST_SCHEMA, schemaName: 'vector_connectivity_test', maxTokens: 1024, timeoutMs: 30_000,
    });
    const answered = !!(r?.ok && r.json && r.json.ok === true);
    const noteOk = answered && typeof r.json.note === 'string' && r.json.note.length <= TEST_NOTE_MAX;
    const ok = answered && noteOk;
    const disconnected = ['CONNECT', 'NETWORK', 'TIMEOUT', 'DISCONNECTED', 'NO_CREDENTIALS', 'SDK_MISSING'].includes(r?.errorKind);
    const error = ok ? null : answered ? `invalid output: note must be a string of at most ${TEST_NOTE_MAX} characters` : String(r?.error ?? 'no valid structured response');
    const out = {
      decision: ok ? 'OK' : 'FAILED',
      modelStatus: ok ? 'CONNECTED' : disconnected ? 'DISCONNECTED' : 'FAULT',
      provider: p.config?.provider ?? p.id, preset: p.preset?.id ?? null, model: r?.servedModel ?? p.model ?? null,
      latencyMs: r?.latencyMs ?? null, usage: r?.usage ?? null, fallbackUsed: !!r?.fallbackUsed,
      error: error === null ? null : error.slice(0, 300), errorKind: ok ? null : answered ? 'INVALID_OUTPUT' : r?.errorKind ?? null,
      refused: !!r?.refusal, confirmed: true,
      note: 'Explicit connectivity test: one small request. It is not an assessment and produces no market output.',
    };
    const st = ctx.replay();
    append(ctx.db, { session_id: st.session_id, ts_sim: st.clock, actor: 'human', type: 'MODEL_TEST', ref_id: null, payload: out });
    return out;
  } finally {
    ctx.busy.modelTest = false;
    ctx.modelRuns.modelTest = null;
  }
}

/** GET /api/options/status */
export function getOptionsStatus(ctx) {
  const feed = feedStatus(ctx.env).options;
  const base = optionsStatus();
  const verified = feed.status === 'SUPPORTED_VERIFIED';
  return {
    status: feed.status,
    detail: verified ? feed.detail : base.detail,
    provider: feed.provider ?? null,
    supported: base.supported,
    operationalOrders: 'REJECTED — a historical replay needs an options quote as-of the replay clock; no historical options provider is connected in this build.',
    required: [
      'An entitled options data provider returning real listed put contracts (OCC symbol, underlying, expiry, strike, right P, multiplier 100).',
      'Time-stamped contract quotes (bid/ask with sizes) as of the replay clock for premium and a conservative fill estimate.',
      'The underlying\'s observed price for mark-to-market and the expiration payoff max(0, K - S) x 100.',
    ],
  };
}
