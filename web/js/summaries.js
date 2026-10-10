// Pure, DOM-free summarisers shared by several views (unit-tested in test/web). They read the shapes the server
// actually writes (server/agents/runner.js last_ok / last_fail, AGENT_SCAN payloads, journal rows) and never invent
// values: anything missing is reported as missing.
import {
  num, obj, arr, isNum, parseMaybeJson, fmtEt, fmtAge, fmtPriceU, fmtInt, humanizeCode, skipLabel,
} from './format.js';

// ---------------------------------------------------------------- agent last successful / failed action

/** {sim, wall} of a last_ok / last_fail record (runner writes ts_sim + wall; legacy shapes used ts / at). */
export function actionTimes(x) {
  const o = obj(x);
  if (!o) return null;
  return { sim: num(o.ts_sim ?? o.ts ?? o.at ?? o.t), wall: num(o.wall) };
}

/**
 * Is the failure more recent than the success? Replay time first; several actions share one replay minute, so ties
 * are broken by the wall-clock write time. When either replay time is missing (faultAgent may write ts_sim:null) the
 * wall times are compared. Replay time is never compared with wall time (wall time is after the replay date). When
 * the order cannot be determined the failure is surfaced rather than hidden.
 */
export function isFailNewer(fail, ok) {
  const f = actionTimes(fail);
  const k = actionTimes(ok);
  if (!f) return false;
  if (!k) return true;
  if (isNum(f.sim) && isNum(k.sim) && f.sim !== k.sim) return f.sim > k.sim;
  if (isNum(f.wall) && isNum(k.wall) && f.wall !== k.wall) return f.wall > k.wall;
  return true;
}

/** The agent's most recent action: {ok:true|false, x} or null when none is recorded. */
export function lastAction(agent) {
  const fail = obj(agent?.last_fail);
  const ok = obj(agent?.last_ok);
  if (!fail && !ok) return null;
  return isFailNewer(fail, ok) ? { ok: false, x: fail } : { ok: true, x: ok };
}

/** Normalised parts of a last_ok / last_fail record for rendering. */
export function actionParts(x) {
  if (x === null || x === undefined) return null;
  if (typeof x === 'string') return { time: null, label: x, sym: null, code: null, stage: null, detail: null, more: 0, orders: 0, intentId: null };
  const o = obj(x);
  if (!o) return { time: null, label: String(x), sym: null, code: null, stage: null, detail: null, more: 0, orders: 0, intentId: null };
  const str = (v) => (typeof v === 'string' && v ? v : null);
  const sym = str(o.sym);
  let label = [str(o.kind), str(o.action), sym].filter(Boolean).join(' ');
  if (!label) label = str(o.type) ?? (str(o.code) ? '' : 'action');
  const reasons = arr(o.reasons);
  const errors = arr(o.errors);
  const first = reasons[0] ?? errors[0];
  let detail = null;
  if (first !== undefined && first !== null) {
    detail = typeof first === 'string' ? first : str(first.detail) ?? str(first.message) ?? str(first.code);
  }
  detail = detail ?? str(o.detail) ?? str(o.reason) ?? str(o.message);
  const n = Math.max(reasons.length, errors.length);
  return {
    time: num(o.ts_sim ?? o.ts ?? o.at ?? o.t), label, sym, code: str(o.code), stage: str(o.stage), detail,
    more: n > 1 ? n - 1 : 0, orders: arr(o.order_ids).length, intentId: str(o.intent_id),
  };
}

/** One-line text: "2026-10-07 14:40 ET · entry open CNEY — POLICY DENIED SPREAD_TOO_WIDE: spread 2353 bps > max 1500 bps". */
export function actionSummaryText(x) {
  const p = actionParts(x);
  if (!p) return 'none recorded';
  const time = isNum(p.time) ? `${fmtEt(p.time, { date: true })} · ` : '';
  const failure = p.code ? ` — ${p.stage ? `${p.stage.toUpperCase()} ` : ''}${p.code}` : '';
  const detail = p.detail && p.detail !== p.code ? `: ${p.detail}` : '';
  const more = p.more ? ` (+${p.more} more)` : '';
  const orders = p.orders ? ` · ${p.orders} order${p.orders > 1 ? 's' : ''}` : '';
  return `${time}${p.label}${failure}${detail}${more}${orders}`.trim();
}

/** Short Overview line: "last action failed: SPREAD_TOO_WIDE on CNEY at 14:40 ET". */
export function lastActionLine(agent) {
  const la = lastAction(agent);
  if (!la) return 'no actions yet';
  const p = actionParts(la.x);
  const when = isNum(p.time) ? ` at ${fmtEt(p.time)}` : '';
  if (!la.ok) return `last action failed: ${p.code ?? p.label ?? 'error'}${p.sym ? ` on ${p.sym}` : ''}${when}`;
  return `last action ok: ${p.label || 'action'}${when}`;
}

// ---------------------------------------------------------------- "why no trades" (server scan_summary)

/** Top N codes by count: [[code, count], ...]. */
export function topSkips(skipped, n = 3) {
  return Object.entries(obj(skipped) || {}).filter(([, c]) => isNum(c) && c > 0).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, n);
}

/**
 * Normalise the cumulative per-agent scan summary that GET /api/agents attaches to each agent (server/controls.js
 * agentScanSummary: AGENT_SCAN skipped / nearMisses counts and gate decisions for the current replay session).
 * OUTSIDE_ENTRY_WINDOW is reported separately: once the entry window closes every candidate is skipped for that
 * reason, which would hide the real entry filters. Counts are symbol-minutes (one symbol can fail several checks).
 */
export function scanWhy(ss) {
  const s = obj(ss);
  if (!s) return null;
  const skipped = obj(s.skipped) || {};
  const filters = Object.fromEntries(Object.entries(skipped).filter(([k]) => k !== 'OUTSIDE_ENTRY_WINDOW'));
  return {
    scans: num(s.scans) ?? 0,
    entriesPlanned: num(s.entriesPlanned) ?? 0,
    intents: num(s.intentsProposed) ?? 0,
    accepted: num(s.policyAccepted) ?? 0,
    outsideWindow: num(skipped.OUTSIDE_ENTRY_WINDOW) ?? 0,
    modelNotConfirmed: num(s.modelNotConfirmed) ?? 0,
    firstTs: num(s.firstScanTs), lastTs: num(s.lastScanTs),
    top: topSkips(filters, 3),
    nearMisses: topSkips(s.nearMisses, 3),
    denied: topSkips(s.policyDenied, 3),
  };
}

/** One-sentence headline for the agent card / overview. */
export function scanWhyText(ss) {
  const w = scanWhy(ss);
  if (!w) return 'No scan summary reported for this agent (no replay session).';
  if (!w.scans) return 'No scans in this replay session yet: the agent scans only while RUNNING and the replay advances inside the regular session.';
  const plural = (n, one, many) => `${fmtInt(n)} ${n === 1 ? one : many}`;
  const head = `${plural(w.entriesPlanned, 'entry', 'entries')} planned in ${plural(w.scans, 'scan', 'scans')}`
    + ` (${plural(w.intents, 'intent', 'intents')} proposed, ${fmtInt(w.accepted)} accepted by the policy gate)`;
  const top = w.top.map(([c, n]) => `${skipLabel(c)} (${fmtInt(n)})`).join('; ');
  return `${head}.${top ? ` Most frequent failed entry checks: ${top}.` : ''}`;
}

// ---------------------------------------------------------------- journal row one-liners

const payloadOf = (r) => obj(r?.payload) ?? obj(parseMaybeJson(r?.payload_json));

/** Human one-line summary of a journal row's payload (raw JSON stays available). Returns null when nothing useful. */
export function journalRowSummary(r) {
  const o = obj(r);
  if (!o) return null;
  const p = payloadOf(o);
  if (!p) return null;
  const type = String(o.type ?? '');
  if (type === 'AGENT_SCAN') {
    const sk = obj(p.skipped) || {};
    const outside = (num(sk.OUTSIDE_ENTRY_WINDOW) ?? 0) > 0;
    const top = topSkips(Object.fromEntries(Object.entries(sk).filter(([k]) => k !== 'OUTSIDE_ENTRY_WINDOW')), 3)
      .map(([c, n]) => `${c} ${fmtInt(n)}`).join(', ');
    const parts = [
      `scanned ${fmtInt(p.scanned)} of ${fmtInt(p.universe)} (active ${fmtInt(p.active)})`,
      `${arr(p.planned).length} planned`,
      `${arr(p.positions).length} position${arr(p.positions).length === 1 ? '' : 's'}`,
    ];
    if (outside) parts.push('entry window closed');
    if (top) parts.push(`top failed checks: ${top} (a symbol can fail several)`);
    return parts.join(' · ');
  }
  if (type === 'FILL_ESTIMATED') {
    return `${String(p.side ?? '').toUpperCase()} ${fmtInt(p.qty)} ${p.sym ?? ''} @ ${fmtPriceU(num(p.priceU))} (estimated paper fill)`.replace(/\s+/g, ' ').trim();
  }
  if (type === 'AGENT_STATE_CHANGED') return `${p.from ?? '?'} → ${p.to ?? '?'}${p.reason ? ` — ${p.reason}` : ''}${p.by ? ` (by ${p.by})` : ''}`;
  if (type === 'STRATEGY_CHANGED') return `strategy ${p.from ?? '?'} → ${p.to ?? '?'}${p.by ? ` (by ${p.by})` : ''}`;
  const reasons = arr(p.reasons);
  if (reasons.length) {
    const codes = reasons.map((x) => (typeof x === 'string' ? x : x?.code)).filter(Boolean);
    const d = obj(reasons[0])?.detail;
    return `${p.decision ? `${p.decision}: ` : ''}${codes.slice(0, 4).join(', ')}${codes.length > 4 ? ` (+${codes.length - 4})` : ''}${d ? ` — ${d}` : ''}`;
  }
  const intent = obj(p.intent) || p;
  const ins = obj(intent.instrument);
  const sym = intent.sym ?? ins?.sym;
  if (sym && (intent.side || intent.qty !== undefined)) {
    return [String(intent.side ?? '').toUpperCase(), isNum(num(intent.qty)) ? fmtInt(intent.qty) : null, sym, intent.order_type ?? intent.type ?? null, p.decision ?? null]
      .filter(Boolean).join(' ');
  }
  if (typeof p.code === 'string') return `${p.code}${typeof p.detail === 'string' ? ` — ${p.detail}` : ''}`;
  if (typeof p.protective_policy === 'string') return `protective policy ${p.protective_policy}`;
  return null;
}

// ---------------------------------------------------------------- retrospective study access

/**
 * The retrospective study uses data AFTER each signal for the whole replay day. While a replay of that day is in
 * progress (clock before the session close) it is locked in the UI, so hindsight cannot steer sandbox orders or
 * strategy edits. Without a dataset there is nothing to reveal (the server answers BLOCKED).
 */
export function studyAccess(replay) {
  const r = obj(replay) || {};
  if (!r.ds) return { locked: false, closesAt: null };
  const c = num(r.clock);
  const t1 = num(r.t_end);
  if (r.status === 'SESSION_CLOSED' || (isNum(c) && isNum(t1) && c >= t1)) return { locked: false, closesAt: t1 };
  return { locked: true, closesAt: t1 };
}

// ---------------------------------------------------------------- staleness of stored model assessments

export const LENS_STALE_MS = 30 * 60000;

/** Age of an assessment's as-of time relative to the replay clock: {ms, stale, text}. */
export function assessmentAge(asOf, clock) {
  const a = num(asOf);
  const c = num(clock);
  if (!isNum(a) || !isNum(c)) return { ms: null, stale: false, text: 'age unknown' };
  const ms = c - a;
  if (ms <= 0) return { ms: 0, stale: false, text: 'current as of the replay clock' };
  return { ms, stale: ms > LENS_STALE_MS, text: `${fmtAge(ms)} before the replay clock` };
}

/** Plain code -> readable phrase, keeping the code (used for decision results). */
export const codePhrase = (c) => `${humanizeCode(c)} (${c})`;

// ---------------------------------------------------------------- status strip: dataset coverage and model activity

/**
 * Is the replay dataset partial / truncated? Reads what GET /api/status reports: replay.complete === false or
 * replay.truncated === true (the engine's coverage of the current session), the same flags on data / data.dataset,
 * or a dataset stored with status 'partial'. endMs is the reported coverage end (replay.coverage_end, else
 * data.dataset.coverage_end), never a guess; beyond = the replay clock is past it (no market state exists there).
 * @returns {{partial:boolean, truncated:boolean, endMs:number|null, beyond:boolean, detail:string|null}}
 */
export function datasetCoverage(status) {
  const r = obj(status?.replay) || {};
  const d = obj(status?.data) || {};
  const ds = obj(d.dataset) || {};
  const truncated = r.truncated === true || d.truncated === true || ds.truncated === true;
  const incomplete = r.complete === false || d.complete === false || ds.complete === false;
  const partial = truncated || incomplete || ds.status === 'partial';
  const end = num(r.coverage_end ?? d.coverage_end ?? ds.coverage_end);
  const detail = [r.truncation_note, d.truncation, partial ? d.modeDetail : null].find((x) => typeof x === 'string' && x.trim()) ?? null;
  return { partial, truncated, endMs: partial && isNum(end) ? end : null, beyond: partial && r.beyondCoverage === true, detail };
}

const RUN_LABELS = Object.freeze({ assess: 'assessment', assessment: 'assessment', assessments: 'assessment', modelTest: 'model test', test: 'model test', agents: 'agent model call', agentCalls: 'agent model call' });

/**
 * Model work in flight on the server, from GET /api/status model.running (boolean; a count or a per-kind object are
 * also accepted) and model.inFlight {assessment, modelTest, agentCalls}. kinds lists what is running when the server
 * says (empty when it only reports a boolean). assessment = the human run's progress; last = model.lastAssessmentRun.
 * @returns {{running:boolean, kinds:string[], assess:boolean, assessment:object|null, last:object|null}}
 */
export function modelActivity(model) {
  const m = obj(model) || {};
  const r = m.running;
  let kinds = [];
  let flagged = false;
  if (r === true) flagged = true;
  else if (isNum(r)) flagged = r > 0;
  else if (typeof r === 'string' && r.trim()) kinds.push(RUN_LABELS[r] ?? humanizeCode(r).toLowerCase());
  else if (obj(r)) kinds.push(...Object.entries(r).filter(([, v]) => v === true || (isNum(v) && v > 0)).map(([k]) => RUN_LABELS[k] ?? humanizeCode(k).toLowerCase()));
  const inf = obj(m.inFlight);
  const a = obj(inf?.assessment);
  if (a) kinds.push('assessment');
  if (obj(inf?.modelTest)) kinds.push('model test');
  if (isNum(num(inf?.agentCalls)) && num(inf.agentCalls) > 0) kinds.push('agent model call');
  kinds = [...new Set(kinds)];
  const assessment = a ? {
    runId: typeof a.run_id === 'string' ? a.run_id : null, sym: typeof a.sym === 'string' ? a.sym : null,
    lensesDone: num(a.lensesDone), lensesTotal: num(a.lensesTotal), elapsedMs: num(a.elapsedMs), previousSession: a.previousSession === true,
  } : null;
  return { running: flagged || kinds.length > 0, kinds, assess: kinds.includes('assessment'), assessment, last: obj(m.lastAssessmentRun) };
}

// ---------------------------------------------------------------- stored assessment audit (hindsight / fallback / draft verdict)

/**
 * Audit facts recorded with a stored assessment (row.audit from GET /api/assessments, or the run result's own fields).
 * Each part is null when the server did not record it — nothing is inferred.
 */
export function assessmentAudit(a) {
  const o = obj(a) || {};
  const au = obj(o.audit) || {};
  const hs = obj(au.hindsight ?? o.hindsight);
  const hindsight = hs && hs.hindsight_risk === true ? {
    code: typeof hs.code === 'string' ? hs.code : null,
    cutoff: typeof hs.model_training_cutoff === 'string' ? hs.model_training_cutoff : null,
    source: typeof hs.cutoff_source === 'string' ? hs.cutoff_source : null,
    tradeDate: typeof hs.trade_date === 'string' ? hs.trade_date : null,
    marginDays: num(hs.margin_days),
  } : null;
  const fb = au.fallback_used ?? o.fallbackUsed ?? o.fallback_used;
  const fallback = fb === true ? { requested: au.requested_model ?? o.requestedModel ?? null, served: au.served_model ?? o.model ?? null } : null;
  const st = au.intent_status ?? obj(o.intent)?.status ?? null;
  const draft = st === 'VALID' || st === 'INVALID' ? {
    status: st,
    errors: arr(au.intent_errors ?? obj(o.intent)?.errors).map(String),
    intent: obj(au.intent_draft ?? obj(o.intent)?.intent),
  } : null;
  const v = obj(au.verification ?? o.verification);
  const verification = v && v.checked === true ? {
    unmatched: arr(v.unmatched).map((x) => (obj(x) ? { field: String(x.field ?? ''), value: String(x.value ?? '') } : { field: '', value: String(x) })),
    flags: arr(v.flags).map(String),
    numbersChecked: num(v.numbers_checked),
    note: typeof v.note === 'string' ? v.note : null,
  } : null;
  return { hindsight, fallback, draft, verification };
}

// ---------------------------------------------------------------- evidence lookup (GET /api/evidence?ids=)

export const EVIDENCE_ID_RE = /^ev_[0-9a-f]{24}$/;
export const EVIDENCE_LOOKUP_MAX = 40;

/** Ids to look up: valid evidence ids only, de-duplicated, at most EVIDENCE_LOOKUP_MAX. */
export function evidenceLookupIds(refs) {
  const valid = [];
  const invalid = [];
  for (const r of arr(refs)) {
    const s = typeof r === 'string' ? r.trim() : '';
    if (EVIDENCE_ID_RE.test(s)) { if (!valid.includes(s)) valid.push(s); } else invalid.push(String(r));
  }
  return { ids: valid.slice(0, EVIDENCE_LOOKUP_MAX), invalid, notLookedUp: Math.max(0, valid.length - EVIDENCE_LOOKUP_MAX) };
}

/**
 * Normalise an evidence lookup response ([...] | {rows|items|evidence:[...]}) against the requested ids.
 * missing = requested ids the server did not return (unknown, or not knowable at the replay clock). As a second line of
 * defence, an item stamped knowable after `clock` (or with no knowable time while a clock is set) is never displayed:
 * it is listed in `withheld` instead.
 */
export function evidenceResult(data, ids, { clock = null } = {}) {
  const o = obj(data);
  const list = Array.isArray(data) ? data : arr(o?.rows ?? o?.items ?? o?.evidence);
  const byId = new Map();
  for (const x of list) {
    const e = obj(x);
    if (e && typeof e.id === 'string' && !byId.has(e.id)) byId.set(e.id, { ...e, body: e.body !== undefined ? e.body : parseMaybeJson(e.body_json) });
  }
  const want = arr(ids);
  const c = num(clock);
  const items = [];
  const withheld = [];
  for (const id of want) {
    const e = byId.get(id);
    if (!e) continue;
    const k = num(e.knowable_ts);
    if (isNum(c) && !(isNum(k) && k <= c)) withheld.push(id); else items.push(e);
  }
  return { items, withheld, missing: want.filter((id) => !byId.has(id)) };
}
