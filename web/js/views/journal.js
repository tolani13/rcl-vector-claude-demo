// #/journal — append-only, hash-chained audit journal: chain verification status, filters (session scope, portfolio,
// agent, type, hide agent scans), labelled cards on phones / table on desktop with a one-line human summary per entry,
// expandable payloads, "load older" paging.
// Session scope and scan hiding are server-side (GET /api/journal session_id=current|all, exclude_type=AGENT_SCAN), so a
// page of rows is never mostly hidden scans. A server without exclude_type falls back to hiding scans on each page.
// The journal never asks for hindsight=1: rows of other sessions after the replay clock stay hidden by the server.
import { h, replace } from '../dom.js';
import * as api from '../api.js';
import { card, pageHeader, statusBlock, loading, rtable, field, select, errorBlock, badge, isUnknownParam } from '../components.js';
import { rowsOf } from './common.js';
import { journalRowSummary } from '../summaries.js';
import { obj, num, isNum, parseMaybeJson, fmtEt, fmtInt, shortHash, PORTFOLIO_IDS, portfolioLabel, LENSES, SEGMENT_LABELS, DASH } from '../format.js';

// Event types written by the server (exact names: the API filters with an exact match). Types seen in loaded rows are
// appended to the filter at runtime.
export const KNOWN_TYPES = Object.freeze(['INTENT_PROPOSED', 'POLICY_ACCEPT', 'POLICY_DENY', 'ORDER_SUBMITTED', 'ORDER_CANCELLED', 'ORDER_REPLACED',
  'ORDER_REJECTED', 'FILL_ESTIMATED', 'FILL_WITHHELD', 'STOP_TRIGGERED', 'OCO_SAME_MINUTE_AMBIGUITY', 'AGENT_SCAN', 'AGENT_STATE_CHANGED',
  'AGENT_BLOCKED', 'AGENT_FAULT', 'STRATEGY_CHANGED', 'KILL_SWITCH_ENGAGED', 'KILL_SWITCH_EFFECTS', 'KILL_SWITCH_RELEASED', 'REPLAY_RESET',
  'MODEL_ASSESSMENT', 'MODEL_TEST']);
// Agent ids follow docs/CONTRACTS.md §3 (configuration, not market data).
const AGENT_IDS = LENSES.flatMap((l) => ['micro', 'large'].map((s) => [`agent-${l.id}-${s}`, `${l.label} · ${SEGMENT_LABELS[s]}`]));

export const SESSION_SCOPES = Object.freeze([['current', 'Current replay session'], ['all', 'All sessions (prior sessions flagged)']]);

/**
 * Query parameters for GET /api/journal. session is 'current' (default) or 'all'. exclude_type=AGENT_SCAN is sent when
 * scans are hidden, no type filter is set and the server supports it (serverExclude); an explicit type filter already
 * selects one type. hindsight is never requested.
 */
export function journalParams({ portfolio_id, agent_id, type, limit, before, session = 'current', hideScans = false, serverExclude = true } = {}) {
  const p = { portfolio_id, agent_id, type, limit, before, session_id: session === 'all' ? 'all' : 'current' };
  if (hideScans && serverExclude && !type) p.exclude_type = 'AGENT_SCAN';
  return p;
}

/** Row flags from the server: prior_session (row of another replay session) and hindsight (after the clock; never requested). */
export function rowFlags(r, currentSessionId) {
  const o = r && typeof r === 'object' ? r : {};
  const prior = o.prior_session === true || (o.prior_session === undefined && !!currentSessionId && !!o.session_id && o.session_id !== currentSessionId);
  return { prior, hindsight: o.hindsight === true };
}

/** Rows to display: AGENT_SCAN rows are hidden when asked (unless the type filter selects them explicitly). */
export function visibleRows(rows, { hideScans, type }) {
  if (!hideScans || type === 'AGENT_SCAN') return { shown: rows, hidden: 0 };
  const shown = rows.filter((r) => r?.type !== 'AGENT_SCAN');
  return { shown, hidden: rows.length - shown.length };
}

export function render(root, { route }) {
  let alive = true;
  let tok = 0;
  let rows = [];
  let chain = null;
  let meta = null;            // scope / note / current_session_id of the last response
  let serverExclude = true;   // false once the server rejected exclude_type (older API): hide scans per page instead
  const q = route.query;
  const seenTypes = new Set(KNOWN_TYPES);
  const phone = typeof matchMedia === 'function' && matchMedia('(max-width: 767px)').matches;
  const sSel = select(SESSION_SCOPES, q.session_id === 'all' ? 'all' : 'current');
  const pSel = select([['', 'All portfolios'], ...PORTFOLIO_IDS.map((id) => [id, portfolioLabel(id)])], PORTFOLIO_IDS.includes(q.portfolio_id) ? q.portfolio_id : '');
  const aSel = select([['', 'All agents and humans'], ...AGENT_IDS], AGENT_IDS.some(([id]) => id === q.agent_id) ? q.agent_id : '');
  const typeSel = select([['', 'All types'], ...KNOWN_TYPES.map((t) => [t, t])], typeof q.type === 'string' && /^[A-Z][A-Z0-9_]{0,59}$/.test(q.type) ? q.type : '');
  if (typeSel.value !== (q.type || '') && q.type && /^[A-Z][A-Z0-9_]{0,59}$/.test(q.type)) { typeSel.append(h('option', { value: q.type }, q.type)); typeSel.value = q.type; }
  const limitSel = select([['50', '50'], ['100', '100'], ['200', '200']], '100');
  // Agent scans are most of the journal while a replay runs; hide them by default on phones.
  const hideScans = h('input', { type: 'checkbox', checked: phone && q.type !== 'AGENT_SCAN' });
  const chainBody = h('div');
  const body = h('div', null, loading('journal'));
  const more = h('div', { class: 'btn-row' });

  const filters = h('form', { class: 'form-grid two', on: { submit: (e) => { e.preventDefault(); fetchRows(false); } } },
    field('Replay session', sSel, { hint: 'Current = this replay session only. All = every session; entries of prior sessions are flagged, and entries after the current replay clock stay hidden.' }),
    field('Portfolio', pSel, { hint: 'Control events (kill switch, replay, model tests) belong to no portfolio: choose All portfolios to see them.' }),
    field('Agent', aSel), field('Event type', typeSel), field('Rows per page', limitSel),
    h('div', { class: 'field' }, h('label', { class: 'check' }, hideScans, ' Hide agent scans (AGENT_SCAN)')),
    h('div', { class: 'field' }, h('span', { class: 'lbl', 'aria-hidden': 'true' }, ' '), h('button', { type: 'submit', class: 'btn' }, 'Apply filters')));
  for (const el of [sSel, pSel, aSel, typeSel, limitSel, hideScans]) el.addEventListener('change', () => fetchRows(false));

  root.append(
    pageHeader('Journal', { sub: 'Every attempted action, policy decision, estimated fill and control change — append-only and hash-chained.' }),
    h('div', { class: 'stack' },
      card({ title: 'Chain integrity' }, chainBody),
      // On phones the filter form starts collapsed so the entries are on the first screen; wider screens show it open.
      card({ title: 'Filters' }, h('details', { class: 'filters-disclosure', open: !phone }, h('summary', null, 'Session, portfolio, agent and type filters'), filters)),
      card({ title: 'Entries (newest first)' }, body, more)));

  function drawChain() {
    const c = obj(chain);
    if (!c) { replace(chainBody, statusBlock('NOT VERIFIED', 'The API did not return a chain verification result.', null, { tone: 'warn' })); return; }
    replace(chainBody, c.ok
      ? statusBlock('CHAIN_VERIFIED', `Hash chain verified over ${isNum(num(c.checked)) ? num(c.checked).toLocaleString('en-US') : 'all'} entries.`, 'Each entry hashes the previous entry; UPDATE/DELETE are blocked by the store.', { tone: 'ok' })
      : statusBlock('CHAIN_BROKEN', `Hash chain verification FAILED${isNum(num(c.brokenAt)) ? ` at sequence ${num(c.brokenAt)}` : ''}.`, 'Entries from that point cannot be trusted as an unaltered record.', { tone: 'bad' }));
  }

  function scopeLine() {
    const m = obj(meta) || {};
    const cur = typeof m.current_session_id === 'string' ? m.current_session_id : null;
    const scope = m.scope === 'all' ? 'All replay sessions' : m.scope === 'current' || m.scope === undefined ? 'Current replay session' : `Session ${m.scope}`;
    const parts = [`${scope}${cur ? ` (current: ${cur})` : ''}.`];
    if (hideScans.checked && !typeSel.value) {
      parts.push(serverExclude ? 'Agent scans (AGENT_SCAN) are excluded by the server; untick “Hide agent scans” to include them.'
        : 'This server cannot exclude agent scans, so they are hidden on each loaded page instead.');
    }
    return h('div', { class: 'scope-line' },
      h('p', { class: 'small muted' }, parts.join(' ')),
      typeof m.note === 'string' ? h('p', { class: 'small note' }, m.note) : null);
  }

  function draw() {
    const cur = obj(meta)?.current_session_id ?? null;
    // Client-side hiding stays on as a fallback (a server without exclude_type) and is a no-op when the server excluded scans.
    const { shown, hidden } = visibleRows(rows, { hideScans: hideScans.checked, type: typeSel.value });
    const priorCount = shown.filter((r) => rowFlags(r, cur).prior).length;
    replace(body,
      scopeLine(),
      hidden ? h('p', { class: 'small muted' }, `${fmtInt(hidden)} agent scan entr${hidden === 1 ? 'y' : 'ies'} hidden on this page (untick “Hide agent scans” to show them).`) : null,
      priorCount ? h('p', { class: 'small muted' }, `${fmtInt(priorCount)} entr${priorCount === 1 ? 'y is' : 'ies are'} from prior replay sessions (marked PRIOR SESSION).`) : null,
      rtable([
        { label: 'Event', head: true, render: (r) => {
          const sum = journalRowSummary(r);
          const f = rowFlags(r, cur);
          return h('span', null, h('span', { class: 'sym' }, String(r.type ?? DASH)),
            f.prior || f.hindsight ? h('span', { class: 'badges row-flags' },
              f.prior ? badge('PRIOR SESSION', { tone: 'warn', title: `Written in replay session ${r.session_id ?? 'unknown'}, not the current one` }) : null,
              f.hindsight ? badge('HINDSIGHT', { tone: 'bad', title: 'Replay time after the current replay clock (another session)' }) : null) : null,
            h('span', { class: 'sub' }, `#${r.seq ?? DASH} · ${r.actor ?? 'unknown actor'}${f.prior && r.session_id ? ` · session ${r.session_id}` : ''}`),
            sum ? h('span', { class: 'sub summary' }, sum) : null);
        } },
        { label: 'Replay time', render: (r) => (isNum(num(r.ts_sim)) ? fmtEt(num(r.ts_sim), { date: true, seconds: true }) : 'no replay clock') },
        { label: 'Wall time', render: (r) => (isNum(num(r.ts_wall)) ? fmtEt(num(r.ts_wall), { date: true, seconds: true }) : DASH) },
        { label: 'Portfolio', render: (r) => (r.portfolio_id ? portfolioLabel(r.portfolio_id) : 'none (control event)') },
        { label: 'Agent', render: (r) => r.agent_id ?? DASH },
        { label: 'Ref', render: (r) => (r.ref_id ? h('span', { class: 'hash' }, String(r.ref_id)) : DASH) },
        { label: 'Hash', render: (r) => h('span', { class: 'hash', title: String(r.hash ?? '') }, shortHash(r.hash)) },
        { label: 'Payload', full: true, render: (r) => {
          const p = r.payload !== undefined ? r.payload : parseMaybeJson(r.payload_json);
          if (p === null || p === undefined) return h('span', { class: 'muted' }, 'empty');
          const text = JSON.stringify(p, null, 2);
          return h('details', null, h('summary', null, `Raw payload (${text.length.toLocaleString('en-US')} chars)`), h('pre', { class: 'payload' }, text));
        } },
      ], shown, {
      caption: 'Journal entries',
      empty: hidden ? 'Only agent scans on this page; they are hidden.'
        : sSel.value === 'current' ? 'No journal entries in the current replay session match these filters (choose All sessions to include earlier sessions).'
          : 'No journal entries match these filters.',
    }));
    replace(more, rows.length && rows.length % Number(limitSel.value) === 0
      ? h('button', { type: 'button', class: 'btn', on: { click: () => fetchRows(true) } }, 'Load older entries')
      : rows.length ? h('span', { class: 'small muted' }, 'End of results.') : null);
  }

  async function fetchRows(older) {
    const my = ++tok;
    if (!older) replace(body, loading('journal'));
    const seqs = rows.map((r) => num(r.seq)).filter(isNum);
    const before = older && seqs.length ? Math.min(...seqs) : undefined;
    const params = () => journalParams({ portfolio_id: pSel.value, agent_id: aSel.value, type: typeSel.value, limit: limitSel.value, before,
      session: sSel.value, hideScans: hideScans.checked, serverExclude });
    let res = await api.get(`/api/journal${api.qs(params())}`);
    if (!alive || my !== tok) return;
    if (serverExclude && isUnknownParam(res, 'exclude_type')) {
      // Older API: no server-side exclusion. Remember that and hide scans per page instead.
      serverExclude = false;
      res = await api.get(`/api/journal${api.qs(params())}`);
      if (!alive || my !== tok) return;
    }
    if (!res.ok) { replace(body, errorBlock(res, 'Journal')); replace(chainBody, statusBlock('NOT VERIFIED', 'Chain status unavailable.', null, { tone: 'warn' })); replace(more); return; }
    const got = rowsOf(res.data).filter((r) => obj(r));
    rows = older ? [...rows, ...got] : got;
    meta = obj(res.data) ?? meta;
    chain = obj(res.data)?.chain ?? chain;
    for (const r of got) if (typeof r.type === 'string' && !seenTypes.has(r.type)) { seenTypes.add(r.type); typeSel.append(h('option', { value: r.type }, r.type)); }
    drawChain();
    draw();
  }

  fetchRows(false);
  return {
    onStatus(_s, info) { if (info.sessionChanged) fetchRows(false); },
    destroy() { alive = false; },
  };
}
