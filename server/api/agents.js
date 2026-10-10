// Agent authority controls and the global kill switch (docs/CONTRACTS.md sections 7 and 9). The HTTP layer only
// validates and forwards to server/controls.js, which journals every change; the policy gate enforces authority on
// every intent regardless of what these endpoints do.
import {
  listAgents, getAgent, startAgent, pauseAgent, resumeAgent, setAgentStrategy, engageKill, releaseKill, getKillState, PROTECTIVE_POLICIES,
} from '../controls.js';
import { STRATEGY_LABEL, PRESETS } from '../agents/strategies.js';
import { ApiError, badRequest, conflict, notFound, onlyKeys, query, id as idOf, oneOf, bool, text } from './http.js';

const AGENT_ID_RE = /^agent-[a-z]+-[a-z]+$/;

function agentId(params) {
  const v = idOf(params.id, 'agent id');
  if (!AGENT_ID_RE.test(v)) throw notFound('AGENT_NOT_FOUND', `agent ${v} not found`);
  return v;
}

/** Map a controls.js refusal {ok:false, code, message} to an HTTP error. */
function refusal(r) {
  if (r.code === 'AGENT_NOT_FOUND') return notFound(r.code, r.message);
  if (r.code === 'STRATEGY_INVALID' || r.code === 'STRATEGY_SEGMENT_MISMATCH' || r.code === 'PROTECTIVE_POLICY_INVALID') {
    return new ApiError(422, r.code, String(r.message ?? r.code).slice(0, 1000), r.errors ? { errors: r.errors } : null);
  }
  return conflict(r.code, String(r.message ?? r.code).slice(0, 1000));
}

/** GET /api/agents */
export function getAgents(ctx, _req, { url }) {
  query(url, []);
  return {
    label: STRATEGY_LABEL,
    kill: getKillState(ctx.db),
    presets: PRESETS, // every preset is labelled EXPLORATORY DEFAULTS — NOT VALIDATED
    note: 'Agents propose typed paper-order intents under explicit strategies; the deterministic policy gate decides. Authority is never resumed implicitly after a restart.',
    rows: listAgents(ctx.db).map((a) => ({ ...a, decisionMode: a.strategy?.decisionMode ?? null })),
  };
}

// Entry-filter skip codes journaled in AGENT_SCAN.skipped (server/agents/strategies.js entryRejections / planActions),
// mapped to the strategy field that decides them, so "why no trades" can be read without opening the journal.
const SKIP_GLOSSARY = Object.freeze({
  RET_BELOW_MIN: 'window return below entry.minRetPct',
  ACCEL_BELOW_MIN: 'acceleration below entry.minAccelPct',
  RELVOL_BELOW_MIN: 'relative volume below entry.minRelVol',
  RELVOL_UNAVAILABLE: 'relative volume unavailable: baseline under 15 min, no baseline volume, or under 1,000 IEX shares (entry.minRelVol set)',
  BUYSHARE_BELOW_MIN: 'inferred buy share below entry.minBuyShare',
  BUYSHARE_UNAVAILABLE: 'inferred buy share unavailable (entry.requireBuyShare)',
  TRADES_BELOW_MIN: 'trades in window below entry.minTradesW',
  VOLUME_BELOW_MIN: 'volume in window below entry.minVolumeW',
  SPREAD_ABOVE_MAX: 'IEX spread above entry.maxSpreadBps',
  QUOTE_OLDER_THAN_STRATEGY_MAX: 'IEX quote older than entry.maxQuoteAgeMs',
  PRICE_BELOW_MIN: 'price below entry.minPriceU',
  PRICE_AT_OR_ABOVE_MAX: 'price at/above entry.maxPriceU',
  ALREADY_HOLDING: 'already holding the symbol',
  ENTRY_ALREADY_OPEN: 'an entry order is already working',
  MAX_ENTRIES_PER_SYMBOL: 'management.maxEntriesPerSymbol reached',
  REENTRY_COOLDOWN: 'management.reentryCooldownMin after an exit',
  OUTSIDE_ENTRY_WINDOW: 'outside the entry window (session start / entry.noEntryLastMin)',
  INSUFFICIENT_DATA: 'not enough completed minutes for the signal window',
  HALTED: 'symbol halted / paused',
  STALE_REFERENCE: 'reference price for the window is stale',
  BUDGET_BELOW_ONE_SHARE: 'budget cannot buy one share',
  STOP_BELOW_MIN_TICK: 'computed stop below the minimum tick',
  STOP_AT_OR_ABOVE_BID: 'computed stop at/above the bid',
  TIME_EXIT_NO_LEVEL: 'time exit band set but no reference trade level',
});

const countInto = (map, key, n = 1) => { map[key] = (map[key] ?? 0) + n; };
const sortedCounts = (map) => Object.entries(map).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).map(([code, n]) => ({ code, n, meaning: SKIP_GLOSSARY[code] ?? null }));

/**
 * GET /api/agents/activity?agent_id= — per-agent scan / skip-reason / intent summary for the CURRENT replay session,
 * aggregated from the journal (AGENT_SCAN.skipped counts, POLICY decisions) and the orders/fills tables.
 */
export function getAgentActivity(ctx, _req, { url }) {
  const q = query(url, ['agent_id']);
  const only = q.agent_id ? agentId({ id: q.agent_id }) : null;
  const st = ctx.replay();
  const agents = listAgents(ctx.db).filter((a) => !only || a.id === only);
  if (only && !agents.length) throw notFound('AGENT_NOT_FOUND', `agent ${only} not found`);
  if (!st.session_id) return { session_id: null, asOf: null, status: 'NO_SESSION', rows: [] };
  const sid = st.session_id;
  const acc = new Map(agents.map((a) => [a.id, {
    agent_id: a.id, portfolio_id: a.portfolio_id, state: a.state, strategy_id: a.strategy?.id ?? null, decisionMode: a.strategy?.decisionMode ?? null,
    scans: 0, firstScanTs: null, lastScanTs: null, last: null, scansWithCandidates: 0, skipped: {}, planned: {},
    intents: { proposed: 0, accepted: 0, denied: 0 }, denyReasons: {}, entryOrders: 0, fills: 0, blocked: 0, faults: 0,
  }]));
  for (const r of ctx.db.prepare(`SELECT agent_id, type, ts_sim, payload_json FROM journal WHERE session_id = ? AND type IN ('AGENT_SCAN', 'AGENT_BLOCKED', 'AGENT_FAULT')
      AND agent_id IS NOT NULL ORDER BY seq`).iterate(sid)) {
    const a = acc.get(r.agent_id);
    if (!a) continue;
    if (r.type === 'AGENT_BLOCKED') { a.blocked++; continue; }
    if (r.type === 'AGENT_FAULT') { a.faults++; continue; }
    let p;
    try { p = JSON.parse(r.payload_json); } catch { continue; }
    a.scans++;
    a.firstScanTs ??= r.ts_sim;
    a.lastScanTs = r.ts_sim;
    a.last = { universe: p.universe ?? null, active: p.active ?? null, scanned: p.scanned ?? null, monitored: p.monitored ?? null, strategy_id: p.strategy_id ?? null, windowMin: p.windowMin ?? null };
    if (Array.isArray(p.topCandidates) && p.topCandidates.length) a.scansWithCandidates++;
    for (const [code, n] of Object.entries(p.skipped ?? {})) if (Number.isFinite(n)) countInto(a.skipped, code, n);
    for (const x of Array.isArray(p.planned) ? p.planned : []) if (typeof x?.kind === 'string') countInto(a.planned, x.kind);
  }
  for (const r of ctx.db.prepare("SELECT agent_id, decision, reasons_json FROM intents WHERE session_id = ? AND agent_id IS NOT NULL").iterate(sid)) {
    const a = acc.get(r.agent_id);
    if (!a) continue;
    a.intents.proposed++;
    if (r.decision === 'ACCEPTED') a.intents.accepted++;
    else {
      a.intents.denied++;
      let reasons = [];
      try { reasons = JSON.parse(r.reasons_json) || []; } catch { reasons = []; }
      for (const x of reasons) if (typeof x?.code === 'string') countInto(a.denyReasons, x.code);
    }
  }
  for (const r of ctx.db.prepare("SELECT agent_id, COUNT(*) n FROM orders WHERE session_id = ? AND agent_id IS NOT NULL AND role = 'entry' AND status != 'rejected' GROUP BY agent_id").all(sid)) {
    if (acc.has(r.agent_id)) acc.get(r.agent_id).entryOrders = Number(r.n);
  }
  for (const r of ctx.db.prepare('SELECT o.agent_id, COUNT(*) n FROM fills f JOIN orders o ON o.id = f.order_id WHERE f.session_id = ? AND o.agent_id IS NOT NULL GROUP BY o.agent_id').all(sid)) {
    if (acc.has(r.agent_id)) acc.get(r.agent_id).fills = Number(r.n);
  }
  const rows = [...acc.values()].map((a) => {
    const skipped = sortedCounts(a.skipped);
    let explanation;
    if (!a.scans) explanation = a.state === 'RUNNING' ? 'RUNNING but no scan recorded yet (scans happen as the replay advances inside the session).' : `No scans in this session: the agent is ${a.state}; it scans only while RUNNING and the replay advances.`;
    else if (!a.entryOrders) {
      const top = skipped.slice(0, 3).map((s) => `${s.code} x${s.n}${s.meaning ? ` (${s.meaning})` : ''}`).join('; ');
      const denied = sortedCounts(a.denyReasons).slice(0, 3).map((s) => `${s.code} x${s.n}`).join('; ');
      explanation = `No entries in ${a.scans} scans.${top ? ` Most frequent entry-filter skips: ${top}.` : ''}${denied ? ` Policy-gate denials: ${denied}.` : ''}`
        + ' A candidate can fail several filters in one scan, so counts overlap.';
    } else explanation = `${a.entryOrders} entry order(s) and ${a.fills} estimated fill(s) in ${a.scans} scans.`;
    return {
      ...a, skipped, denyReasons: sortedCounts(a.denyReasons).map(({ code, n }) => ({ code, n })), explanation,
    };
  });
  return {
    session_id: sid, asOf: st.clock ?? null, label: 'AGENT ACTIVITY — current replay session (journal aggregates; signal metrics, not recommendations)',
    note: 'skipped = entry-filter rejections counted per candidate per scan (AGENT_SCAN); intents = proposals and policy-gate decisions; entryOrders excludes rejected orders.',
    rows,
  };
}

/** POST /api/agents/:id/(start|pause|resume) */
export function postAgentAction(verb) {
  return (ctx, _req, { params, body }) => {
    onlyKeys(body, verb === 'pause' ? ['cancel_pending_entries', 'confirm'] : ['confirm']);
    const aid = agentId(params);
    let r;
    if (verb === 'start') r = startAgent(ctx.db, aid, { by: 'human' });
    else if (verb === 'resume') r = resumeAgent(ctx.db, aid, { by: 'human' });
    else r = pauseAgent(ctx.db, aid, { by: 'human', cancel_pending_entries: bool(body.cancel_pending_entries, 'cancel_pending_entries', { optional: true, dflt: true }) });
    if (!r.ok) throw refusal(r);
    return { decision: 'OK', action: verb, unchanged: !!r.unchanged, agent: r.agent, cancelled: r.cancelled ?? [] };
  };
}

/** PUT /api/agents/:id/strategy {strategy} — validated; segment must match the agent; takes effect next replay minute. */
export function putStrategy(ctx, _req, { params, body }) {
  onlyKeys(body, ['strategy', 'confirm']);
  const aid = agentId(params);
  if (!getAgent(ctx.db, aid)) throw notFound('AGENT_NOT_FOUND', `agent ${aid} not found`);
  if (!body.strategy || typeof body.strategy !== 'object' || Array.isArray(body.strategy)) throw badRequest('STRATEGY_REQUIRED', 'body.strategy must be a strategy object');
  const r = setAgentStrategy(ctx.db, aid, body.strategy, { by: 'human' });
  if (!r.ok) throw refusal(r);
  return { decision: 'OK', agent: r.agent, label: STRATEGY_LABEL };
}

/** POST /api/kill {protective_policy, reason?} */
export function postKill(ctx, _req, { body }) {
  onlyKeys(body, ['protective_policy', 'reason', 'confirm']);
  const protective_policy = oneOf(body.protective_policy, PROTECTIVE_POLICIES, 'protective_policy', { optional: true, dflt: 'KEEP_PROTECTIVE' });
  const reason = text(body.reason, 300, 'reason', { optional: true, dflt: null });
  const r = engageKill(ctx.db, { by: 'human', protective_policy, reason });
  if (!r.ok) throw refusal(r);
  return { decision: 'OK', status: 'ENGAGED', kill: r.kill, cancelled: r.cancelled, keptProtective: r.kept, agentsStopped: r.agentsStopped, alreadyEngaged: r.alreadyEngaged };
}

/** POST /api/kill/release — agents stay STOPPED until each is started by a human. */
export function postKillRelease(ctx, _req, { body }) {
  onlyKeys(body, ['confirm']);
  const r = releaseKill(ctx.db, { by: 'human' });
  if (!r.ok) throw refusal(r);
  return { decision: 'OK', status: 'RELEASED', kill: r.kill, alreadyReleased: !!r.alreadyReleased, note: 'Agents remain STOPPED; start each one individually.' };
}
