// Three-lens model assessments and the evidence lookup (docs/CONTRACTS.md sections 8 and 9). Runs ONLY when a real
// configured model provider reports CONNECTED; otherwise 409 MODEL_DISCONNECTED ("MODEL DISCONNECTED / ASSESSMENT NOT
// RUN"). Runs are human-initiated (confirm:true is required server-side because each run makes three possibly billed
// calls), single-flight, and capped per replay session by runLensAssessments (VECTOR_MAX_MODEL_CALLS_PER_SESSION).
// The evidence packet is built as of the replay clock; stored assessments are listed only for the CURRENT replay
// session and only when as_of <= clock (rows of other sessions or smoke runs never appear in the live view).
//
// Progress of a run (the three lens calls are sequential and each may take up to the provider timeout):
//   * default (synchronous): the POST answers when all three lenses are stored. While it runs, GET /api/status shows
//     model.running = true and model.inFlight.assessment {sym, asOf, startedAt, elapsedMs, lensesDone, lensesTotal}.
//   * {async:true}: the POST answers 202 at once with the run id; follow it with the same status fields, read each lens
//     from GET /api/assessments?sym= as it is stored, and the outcome from model.lastAssessmentRun.
// Evidence lookup: GET /api/evidence?ids= returns only evidence knowable at or before the replay clock.
import * as evidenceStore from '../intel/evidence.js';
import { LENSES } from '../intel/prompts.js';
import { realDataPrivacyCheck } from '../intel/providers/presets.js';
import { holdingForSymbol, REAL_LABEL } from '../data/real-accounts.js';
import { requireLoopback } from './real.js';
import { runLensAssessments, listAssessments } from '../intel/assessments.js';
import { append } from '../journal.js';
import { newId } from '../util/ids.js';
import { ApiError, Reply, badRequest, conflict, onlyKeys, query, symbol, intIn, bool } from './http.js';

const LENSES_PER_RUN = 3;

function runError(r) {
  if (r.status === 'MODEL_DISCONNECTED') return conflict('MODEL_DISCONNECTED', 'MODEL DISCONNECTED / ASSESSMENT NOT RUN');
  if (r.code === 'REAL_DATA_PRIVACY_BLOCK') return new ApiError(403, 'REAL_DATA_PRIVACY_BLOCK', `ASSESSMENT_NOT_RUN: ${r.detail}`, { blocked: r.blocked ?? [] });
  if (r.status === 'CALL_CAP_REACHED') {
    return new ApiError(429, 'CALL_CAP_REACHED', String(r.scope ?? '').startsWith('preset_') ? `${r.detail}; ASSESSMENT_NOT_RUN` : r.scope === 'rolling_24h'
      ? `${r.detail ?? `global model-call budget reached (${r.used}/${r.cap}, rolling 24 h)`}; ASSESSMENT_NOT_RUN`
      : `model call cap reached for this session (${r.used}/${r.cap}); ASSESSMENT_NOT_RUN`, { cap: r.cap, used: r.used, scope: r.scope ?? 'session' });
  }
  return conflict(r.status, `ASSESSMENT_NOT_RUN: ${String(r.detail ?? r.note ?? r.status).slice(0, 300)}`);
}

/** Run-level verdict from the per-lens statuses: OK only when every lens produced a valid result. */
function runDecision(results) {
  const okCount = results.filter((x) => x.status === 'OK').length;
  return okCount === results.length ? 'OK' : okCount === 0 ? 'NO_OUTPUT' : 'PARTIAL';
}

function resultBody(r) {
  return {
    decision: runDecision(r.results), status: r.status, sym: r.sym, ds: r.ds, asOf: r.asOf, session_id: r.session_id, provider: r.provider,
    providers: r.providers ?? null, realAccountContext: r.realAccountContext === true,
    packet_sha256: r.packet_sha256, evidence_ids: r.evidence_ids, stances: r.stances,
    note: 'Three independent lens calls on the same as-of evidence packet; disagreement is preserved (no averaging or voting). Assessments never execute trades.',
    results: r.results.map((x) => ({
      lens: x.lens, assessment_id: x.assessment_id, status: x.status, errorKind: x.errorKind ?? null, output: x.output, error: x.error, refusal: x.refusal,
      model: x.model, requestedModel: x.requestedModel ?? null, preset: x.preset ?? null, latencyMs: x.latencyMs, usage: x.usage, fallbackUsed: x.fallbackUsed, intentDraft: x.intent,
      verification: x.verification ?? null, hindsight: x.hindsight ?? null,
    })),
  };
}

/** The owner's real holding in `sym` as a labelled, non-evidence context block (REAL_ACCOUNT data class). */
function realAccountContextText(h) {
  const head = `${REAL_LABEL} CONTEXT (data class REAL_ACCOUNT, source SNAPTRADE, fetched ${new Date(h.fetched_at).toISOString()}). `
    + 'This is the owner\'s own brokerage holding, read-only. It is NOT market data and NOT evidence: do not cite it as an evidence id.';
  return h.units
    ? `${head}\nThe owner holds ${h.units} units of ${h.sym} across ${h.accounts} real account(s)${Number.isFinite(h.cost_basis) ? `, total cost basis ${h.cost_basis} ${h.currencies.join('/') || ''}`.trim() : ''}.`
    : `${head}\nThe owner holds no position in ${h.sym} in the synced real accounts.`;
}

/**
 * POST /api/assessments/run {sym, confirm:true, async?, includeRealAccount?} — see the header for synchronous vs async
 * progress. Each lens uses its selected provider (presets: per-lens or one pinned model). includeRealAccount adds the
 * owner's REAL_ACCOUNT holding in sym; it is refused with 403 REAL_DATA_PRIVACY_BLOCK unless every lens provider
 * declares trains_on_prompts false (checked before anything else is read or sent), and only for a loopback peer.
 * Pre-checks (dataset, model CONNECTED, confirmation, single-flight) always answer synchronously.
 */
export async function postAssessmentsRun(ctx, req, { body }) {
  onlyKeys(body, ['sym', 'confirm', 'async', 'includeRealAccount']);
  const sym = symbol(body.sym);
  const confirm = bool(body.confirm, 'confirm', { optional: true, dflt: false });
  const background = bool(body.async, 'async', { optional: true, dflt: false });
  const includeReal = bool(body.includeRealAccount, 'includeRealAccount', { optional: true, dflt: false });
  // A real-context result is returned only in this response (nothing derived from it is stored or listed later).
  if (includeReal && background) throw badRequest('REAL_CONTEXT_SYNC_ONLY', 'includeRealAccount runs are synchronous only: their results are returned in this response and never stored for later listing');
  const providers = ctx.lensProviders([...LENSES]);
  let realAccountContext = null;
  if (includeReal) {
    requireLoopback(ctx, req);
    const gate = realDataPrivacyCheck(providers, ctx.env);
    if (!gate.ok) {
      throw new ApiError(403, 'REAL_DATA_PRIVACY_BLOCK', `ASSESSMENT_NOT_RUN: real-account data is only sent to model providers whose preset declares trains_on_prompts false (${gate.blocked.map((b) => `${b.lens}: ${b.preset ?? b.provider} trains_on_prompts=${b.trains_on_prompts}`).join('; ')}). Use a local preset, or list the preset in VECTOR_REAL_DATA_ALLOW_PRESETS.`, { blocked: gate.blocked });
    }
    const h = holdingForSymbol(ctx.db, sym);
    if (!h) throw conflict('REAL_ACCOUNT_NOT_SYNCED', 'No successful real-account sync yet: open Real accounts and Sync first.');
    realAccountContext = realAccountContextText(h);
  }
  const st = ctx.replay();
  if (!st.session_id || !st.ds || !Number.isFinite(st.clock)) throw conflict('NO_VERIFIED_DATA', 'No replay session with a verified market dataset; nothing to assess.');
  const m = await ctx.modelStatus();
  if (m.status !== 'CONNECTED') {
    throw conflict('MODEL_DISCONNECTED', `MODEL DISCONNECTED / ASSESSMENT NOT RUN — model status ${m.status}: ${String(m.detail ?? '').slice(0, 300)}`, { modelStatus: m.status });
  }
  if (confirm !== true) {
    throw conflict('CONFIRMATION_REQUIRED', 'An assessment run makes three model calls that the provider may bill; resend with confirm:true after the user confirms. ASSESSMENT_NOT_RUN');
  }
  if (ctx.busy.assess) throw new ApiError(429, 'ASSESSMENT_BUSY', 'an assessment run is already in progress (see GET /api/status model.inFlight.assessment)');
  ctx.busy.assess = true;
  const run = {
    run_id: newId('arun'), sym, asOf: st.clock, session_id: st.session_id, mode: background ? 'async' : 'sync',
    startedAt: Date.now(), lensesTotal: LENSES_PER_RUN,
  };
  ctx.modelRuns.assessment = run;
  const finish = (outcome) => {
    ctx.lastAssessmentRun = {
      run_id: run.run_id, sym, asOf: run.asOf, session_id: run.session_id, mode: run.mode, startedAt: run.startedAt, finishedAt: Date.now(), ...outcome,
    };
    if (ctx.modelRuns.assessment === run) ctx.modelRuns.assessment = null;
    ctx.busy.assess = false;
  };
  let exec;
  try {
    append(ctx.db, {
      session_id: st.session_id, ts_sim: st.clock, actor: 'human', type: 'ASSESSMENT_RUN_REQUESTED', ref_id: run.run_id,
      payload: {
        sym, asOf: st.clock, confirmed: true, async: background, provider: m.provider ?? null, model: m.model ?? null, real_account_context: includeReal,
        lenses: Object.fromEntries(Object.entries(providers).map(([l, p]) => [l, { provider: p.id ?? p.kind, preset: p.preset?.id ?? null, model: p.model ?? null }])),
        note: 'Human-confirmed three-lens assessment run.',
      },
    });
    exec = runLensAssessments(ctx.db, ctx.provider(), { session_id: st.session_id, ds: st.ds, sym, asOf: st.clock, providers, realAccountContext, env: ctx.env });
  } catch (e) {
    finish({ status: 'ERROR', code: 'INTERNAL_ERROR', detail: 'the run could not start' });
    throw e;
  }
  const settled = exec.then(
    (r) => {
      if (r.status === 'COMPLETED') {
        finish({
          status: 'COMPLETED', decision: runDecision(r.results), stances: r.stances, assessment_ids: r.results.map((x) => x.assessment_id),
          lensStatuses: Object.fromEntries(r.results.map((x) => [x.lens, x.status])),
          // NOT_RUN = never called (short-circuit after an unreachable endpoint), distinct from a real per-lens ERROR.
          lensErrorKinds: Object.fromEntries(r.results.map((x) => [x.lens, x.errorKind ?? null])),
        });
        return { ok: true, body: resultBody(r) };
      }
      const err = runError(r);
      finish({ status: 'NOT_RUN', code: err.code, detail: String(err.message).slice(0, 300) });
      return { ok: false, error: err };
    },
    (e) => {
      finish({ status: 'ERROR', code: 'INTERNAL_ERROR', detail: `assessment run failed: ${String(e?.message ?? e).slice(0, 200)}` });
      return { ok: false, error: e };
    },
  );
  if (background) {
    settled.then((s) => {
      if (!s.ok && !(s.error instanceof ApiError)) ctx.log?.(`[vector] async assessment run ${run.run_id} failed: ${s.error?.stack ?? s.error}`);
    });
    return new Reply(202, {
      decision: 'ACCEPTED', status: 'RUNNING', run_id: run.run_id, sym, asOf: run.asOf, session_id: run.session_id, lensesTotal: LENSES_PER_RUN,
      progress: 'GET /api/status: model.running and model.inFlight.assessment (lensesDone of lensesTotal) while it runs; model.lastAssessmentRun holds the outcome. Each stored lens appears in GET /api/assessments?sym= as it completes.',
      note: 'Three independent lens calls on the same as-of evidence packet, run in the background. Assessments never execute trades.',
    });
  }
  const s = await settled;
  if (!s.ok) throw s.error;
  return s.body;
}

/** GET /api/assessments?sym= — stored assessments of the current replay session knowable at the clock (as_of <= clock), newest first. */
export async function getAssessments(ctx, _req, { url }) {
  const q = query(url, ['sym', 'limit']);
  const sym = symbol(q.sym);
  const limit = intIn(q.limit, 1, 300, 'limit', { optional: true, dflt: 30 });
  const st = ctx.replay();
  const m = await ctx.modelStatus();
  const rows = st.session_id && Number.isFinite(st.clock)
    ? listAssessments(ctx.db, { sym, session_id: st.session_id, limit: 300 }).filter((a) => a.as_of <= st.clock).slice(0, limit)
    : [];
  const connected = m.status === 'CONNECTED';
  let note;
  if (rows.length) {
    note = connected
      ? 'Model interpretations of timestamped evidence from this replay session, not recommendations.'
      : 'Stored assessments below were produced earlier in this replay session; new runs are disabled (MODEL DISCONNECTED). Model interpretations, not recommendations.';
  } else note = connected ? 'ASSESSMENT_NOT_RUN for this symbol in this replay session as of the replay clock.' : 'MODEL DISCONNECTED / ASSESSMENT NOT RUN';
  return {
    sym, asOf: st.clock ?? null, session_id: st.session_id ?? null, scope: 'current replay session',
    status: rows.length ? 'STORED' : 'ASSESSMENT_NOT_RUN',
    model: { status: m.status, provider: m.provider, model: m.model },
    note,
    rows,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Evidence lookup

export const EVIDENCE_ID_RE = /^ev_[0-9a-f]{24}$/;
export const MAX_EVIDENCE_IDS = 50;

/**
 * Evidence rows by id, as of the replay clock. Uses the intel store's as-of reader getEvidenceByIds(db, ids, asOf)
 * (knowable_ts <= clock plus the store's provenance guard: a row stamped knowable before its source dataset was
 * published is withheld), in chunks of its per-call maximum; falls back to getEvidence(db, ids, {asOf}) with the same
 * filter. knowable_ts is re-checked here as defence in depth.
 */
function evidenceAsOf(db, ids, clock) {
  if (!Number.isFinite(clock)) return [];
  const byIds = typeof evidenceStore.getEvidenceByIds === 'function' ? evidenceStore.getEvidenceByIds : null;
  const chunk = byIds && Number.isSafeInteger(evidenceStore.EVIDENCE_IDS_MAX) && evidenceStore.EVIDENCE_IDS_MAX > 0 ? evidenceStore.EVIDENCE_IDS_MAX : ids.length;
  const rows = [];
  for (let i = 0; i < ids.length; i += chunk) {
    const part = ids.slice(i, i + chunk);
    rows.push(...(byIds ? byIds(db, part, clock) : evidenceStore.getEvidence(db, part, { asOf: clock })));
  }
  return rows.filter((r) => r && typeof r.id === 'string' && Number.isFinite(r.knowable_ts) && r.knowable_ts <= clock);
}

/**
 * GET /api/evidence?ids=ev_a,ev_b — up to 50 evidence-store ids (each ^ev_[0-9a-f]{24}$). Returns only rows knowable at
 * or before the replay clock, in request order. Ids that do not exist and ids not yet knowable are reported together
 * in `unavailable`, so the answer never reveals that later evidence exists. Wall-clock ingestion times are omitted.
 */
export function getEvidenceByIdsRoute(ctx, _req, { url }) {
  const q = query(url, ['ids']);
  if (typeof q.ids !== 'string' || !q.ids.trim()) throw badRequest('IDS_REQUIRED', `ids is required: a comma-separated list of up to ${MAX_EVIDENCE_IDS} evidence ids`);
  const raw = q.ids.split(',').map((s) => s.trim());
  if (raw.length > MAX_EVIDENCE_IDS) throw badRequest('IDS_TOO_MANY', `at most ${MAX_EVIDENCE_IDS} evidence ids per request`);
  for (const s of raw) {
    if (!EVIDENCE_ID_RE.test(s)) throw badRequest('ID_INVALID', 'each evidence id must match ^ev_[0-9a-f]{24}$');
  }
  const ids = [...new Set(raw)];
  const st = ctx.replay();
  if (!st.session_id || !Number.isFinite(st.clock)) {
    return {
      asOf: null, session_id: st.session_id ?? null, status: 'NO_SESSION', requested: ids.length, rows: [], unavailable: ids,
      note: 'No replay session with a clock: evidence is shown only as of the replay clock.',
    };
  }
  const found = new Map(evidenceAsOf(ctx.db, ids, st.clock).map((r) => [r.id, r]));
  const rows = ids.filter((id) => found.has(id)).map((id) => {
    const r = found.get(id);
    return {
      id: r.id, sym: r.sym ?? null, kind: r.kind, title: r.title, body: r.body ?? null, provider: r.provider ?? null, ds: r.ds ?? null,
      source_url: r.source_url ?? null, source_id: r.source_id ?? null, event_ts: r.event_ts ?? null, knowable_ts: r.knowable_ts,
    };
  });
  const unavailable = ids.filter((id) => !found.has(id));
  return {
    asOf: st.clock, session_id: st.session_id, status: rows.length ? 'OK' : 'NOT_FOUND', requested: ids.length, rows, unavailable,
    note: 'Evidence knowable at or before the replay clock only. Ids listed in `unavailable` do not exist or are not knowable yet (the two cases are not distinguished).',
  };
}
