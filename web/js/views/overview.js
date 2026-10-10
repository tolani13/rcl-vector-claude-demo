// #/overview — segment switch, opportunities (signal metrics, not recommendations; ranked with the horizon and
// instrument choices made in Research), benchmark return chart, agents, data-source summary, data timestamps, macro
// panel. Re-fetches as-of data when the replay clock moves.
import { h, replace, preserveFocus } from '../dom.js';
import * as api from '../api.js';
import { card, pageHeader, segmentSwitch, statusBlock, errorBlock, loading, badge, kv, isUnknownParam } from '../components.js';
import { lineChart, hasPoints, sparkline } from '../charts.js';
import { setPref } from '../store.js';
import { datasetInfo } from '../status-strip.js';
import {
  opportunityList, rowsOf, asOfText, rankingNote, methodNote, SIGNAL_LABEL, METRIC_NOTES, oppParams, windowPref, instrumentsPref, instrumentNote, INSTRUMENT_TEXT,
  DEFAULT_WINDOW_MIN,
} from './common.js';
import { lastActionLine, lastAction } from '../summaries.js';
import {
  arr, obj, num, isNum, fmtEt, fmtEtDate, fmtPct, fmtNum, fmtInt, fmtLocalTime, statusTone, stateReasonText, segmentPref, SEGMENT_LABELS, SEGMENT_NOTES,
  LENSES, DASH,
} from '../format.js';

const OVERVIEW_ROWS = 8;
const MACRO_REFRESH_MS = 15 * 60000; // macro releases are daily at most: refetch on session change or every 15 replay minutes

export function render(root, { store }) {
  let seg = segmentPref(store.prefs.segment);
  const unsupported = {}; // ranking options this server rejected (UNKNOWN_FIELD)
  let agentsSig = null;
  let macroClock = null;
  let alive = true;
  let benchChart = null;
  const tokens = {};
  const asOf = {};
  const fetchedAt = {};

  const sub = h('span', null);
  const oppBody = h('div', null, loading('opportunities'));
  const benchBody = h('div', null, loading('benchmark series'));
  const agentsBody = h('div');
  const srcBody = h('div', null, loading('data sources'));
  const tsBody = h('div');
  const macroBody = h('div', null, loading('macro series'));
  const oppTitle = h('span', null, `Opportunities · ${SEGMENT_LABELS[seg]}`);

  root.append(
    pageHeader('Overview', { sub }),
    h('div', { class: 'stack' },
      segmentSwitch(seg, (v) => { seg = v; setPref('segment', v); oppTitle.textContent = `Opportunities · ${SEGMENT_LABELS[seg]}`; loadOpps(true); }),
      h('div', { class: 'grid grid-12' },
        card({ title: oppTitle, cls: 'span-7', actions: h('a', { class: 'btn btn-ghost', href: '#/research' }, 'Research ›') }, oppBody),
        // Secondary panels share one rail beside the (long) opportunities list instead of trailing below it.
        h('div', { class: 'rail span-5' },
          card({ title: 'Benchmark returns' }, benchBody),
          card({ title: 'Data timestamps' }, tsBody),
          card({ title: 'Data sources', actions: h('a', { class: 'btn btn-ghost', href: '#/sources' }, 'Details ›') }, srcBody),
          card({ title: 'Agents', actions: h('a', { class: 'btn btn-ghost', href: '#/agents' }, 'Manage ›') }, agentsBody)),
        card({ title: 'Macro (as-of publication lag)', cls: 'span-12' }, macroBody))));

  async function load(key, path, body, what, onData, showLoading) {
    const tok = (tokens[key] = (tokens[key] || 0) + 1);
    if (showLoading) replace(body, loading(what));
    const res = await api.get(typeof path === 'function' ? path() : path);
    if (!alive || tok !== tokens[key]) return null;
    fetchedAt[key] = Date.now();
    if (!res.ok) { replace(body, errorBlock(res, what)); renderTimestamps(); return res; }
    try {
      onData(res.data);
    } catch (e) {
      console.error(e);
      replace(body, statusBlock('ERROR', `${what}: unexpected response shape — not displayed.`, String(e?.message || e), { tone: 'bad' }));
    }
    renderTimestamps();
    return res;
  }

  // Only the top rows are shown here, so only those are requested (the full ranked list lives in Research). The
  // horizon (windowMin) and instrument filter are the ones chosen in Research (shared preferences).
  const oppPath = () => `/api/research/opportunities${api.qs(oppParams({ segment: seg, limit: OVERVIEW_ROWS, windowMin: windowPref(store.prefs.windowMin), instruments: instrumentsPref(store.prefs.instruments), unsupported }))}`;
  const loadOpps = (showLoading) => load('opps', oppPath, oppBody, 'Opportunities', (d) => {
    asOf.opps = num(d?.asOf);
    const rows = rowsOf(d);
    const total = num(d?.counts?.returned ?? d?.counts?.universe);
    const windowMin = num(d?.windowMin);
    const instr = typeof d?.instruments === 'string' ? d.instruments : null;
    const instrLine = instr ? instrumentNote(d, instr) : null;
    replace(oppBody,
      h('div', { class: 'label-banner' }, SIGNAL_LABEL),
      h('p', { class: 'note small' }, [asOfText(d?.asOf), isNum(windowMin) ? `${windowMin}-min window` : null, instr ? INSTRUMENT_TEXT[instr] ?? instr : null,
        (isNum(windowMin) && windowMin !== DEFAULT_WINDOW_MIN) || (instr && instr !== 'all') ? 'ranking options set in Research' : null].filter(Boolean).join(' · ')),
      instrLine ? h('p', { class: 'small muted' }, instrLine) : null,
      methodNote(d?.note, 'overview-opps'),
      SEGMENT_NOTES[seg] ? h('p', { class: 'small muted' }, SEGMENT_NOTES[seg]) : null,
      rows.length
        ? [opportunityList(rows, OVERVIEW_ROWS, { windowMin }),
          isNum(total) && total > rows.length ? h('a', { class: 'btn btn-ghost link-row', href: '#/research' }, `All ${fmtInt(total)} ranked symbols in Research ›`) : null,
          h('details', null, h('summary', null, 'How to read these metrics'), h('ul', { class: 'small note' }, METRIC_NOTES.map((t) => h('li', null, t)))),
          rankingNote(d)]
        : statusBlock(typeof d?.status === 'string' ? d.status : 'NO_VERIFIED_DATA',
          'No ranked symbols for this segment as of the replay clock.',
          typeof d?.detail === 'string' ? d.detail : 'Requires an ingested market dataset and a replay session (Replay → Reset).'));
  }, showLoading).then((res) => {
    let retry = false;
    for (const k of ['windowMin', 'instruments']) if (!unsupported[k] && isUnknownParam(res, k)) { unsupported[k] = true; retry = true; }
    if (retry && alive) loadOpps(true);
  });

  const loadBench = () => load('bench', '/api/market/benchmark', benchBody, 'Benchmark series', (d) => {
    asOf.bench = num(d?.asOf);
    benchChart?.destroy?.();
    benchChart = null;
    const series = arr(d?.series).map((x) => ({
      name: typeof x?.sym === 'string' ? x.sym : (x?.name ?? 'Series'),
      points: arr(x?.points).map((p) => ({ t: num(p?.t), y: num(p?.retPct) })),
    }));
    if (!hasPoints(series)) {
      replace(benchBody, statusBlock(typeof d?.status === 'string' ? d.status : 'NO_VERIFIED_DATA',
        'No benchmark series as of the replay clock — nothing is plotted.',
        typeof d?.detail === 'string' ? d.detail : 'Benchmark returns appear once replayed IEX minutes for the benchmark ETFs are knowable.'));
      return;
    }
    const chartHost = h('div');
    replace(benchBody, h('p', { class: 'note small' }, asOfText(d?.asOf)), chartHost,
      h('p', { class: 'small muted' }, typeof d?.note === 'string' ? d.note : 'Return % vs. each series’ first knowable price in the session. IEX-traded ETF prices, same-venue reference only.'));
    benchChart = lineChart(chartHost, series, { yFmt: (v) => fmtPct(v, { digits: 2 }), zero: true, ariaLabel: 'Benchmark return since session open, percent' });
  });

  const loadSources = () => load('sources', '/api/sources', srcBody, 'Data sources', (d) => {
    const rows = rowsOf(d, 'sources');
    if (!rows.length) {
      replace(srcBody, statusBlock('NO_VERIFIED_DATA', 'No data sources are registered.', 'See Data sources for setup and ingestion instructions.'));
      return;
    }
    const counts = {};
    for (const r of rows) { const st = String(r?.status ?? 'UNKNOWN'); counts[st] = (counts[st] || 0) + 1; }
    replace(srcBody,
      h('div', { class: 'badges' }, Object.entries(counts).map(([k, n]) => badge(`${k} · ${n}`, { tone: statusTone(k) }))),
      h('ul', { class: 'list' }, rows.slice(0, 6).map((r) => h('li', null, h('a', { class: 'list-row', href: '#/sources' },
        h('span', { class: 'l' }, h('span', { class: 't' }, String(r?.name ?? r?.id ?? 'Source')),
          h('span', { class: 's' }, isNum(r?.last_event_ts) ? `Last event ${fmtEt(r.last_event_ts, { date: true })}` : 'No event time recorded')),
        h('span', { class: 'r' }, badge(r?.status)))))),
      rows.length > 6 ? h('p', { class: 'small muted' }, `${rows.length - 6} more in Data sources`) : null);
  });

  const loadMacro = () => load('macro', '/api/macro', macroBody, 'Macro series', (d) => {
    asOf.macro = num(d?.asOf);
    const series = rowsOf(d, 'series');
    if (!series.length) {
      replace(macroBody, statusBlock(typeof d?.status === 'string' ? d.status : 'NO_VERIFIED_DATA', 'No macro series ingested.',
        'Ingest FRED series on the server (npm run ingest:fred). Observations become visible only after their publication lag.'));
      return;
    }
    macroClock = num(store.status?.replay?.clock);
    replace(macroBody,
      h('p', { class: 'note small' }, asOfText(d?.asOf)),
      // FRED values are the latest vintage at fetch time, not point-in-time vintages: say so next to the values.
      typeof d?.vintageNote === 'string' ? h('p', { class: 'small note' }, d.vintageNote) : (typeof d?.note === 'string' ? h('p', { class: 'small note' }, d.note) : null),
      h('ul', { class: 'list' }, series.map((x) => {
        const latest = obj(x?.latest);
        const vin = obj(x?.vintage);
        const values = arr(x?.observations).map((o) => num(o?.value));
        const fetched = isNum(num(vin?.fetchedAt)) ? `fetched ${fmtEtDate(num(vin.fetchedAt))}` : 'fetch time unknown';
        const valueText = latest
          ? `Latest stored vintage: ${fmtNum(latest.value, 4)}${x?.units ? ' ' + x.units : ''} (observation ${latest.date ?? DASH}; ${fetched}${vin?.revisable ? '; may include later revisions' : ''})`
          : vin?.withheld ? 'Withheld: the stored values may include revisions published after the replay clock.' : 'No observation knowable as of the replay clock';
        return h('li', null, h('div', { class: 'list-row' },
          h('span', { class: 'l' },
            h('span', { class: 't' }, String(x?.title ?? x?.series ?? 'Series'), vin?.withheld ? badge(String(vin.status ?? 'WITHHELD'), { tone: 'warn', title: vin.note ? String(vin.note) : undefined }) : null),
            h('span', { class: 's' }, [x?.series, x?.frequency, isNum(x?.publication_lag_days) ? `publication lag ${x.publication_lag_days}d` : null].filter(Boolean).join(' · ')),
            h('span', { class: 's', title: vin?.note ? String(vin.note) : null }, valueText)),
          h('span', { class: 'r' }, sparkline(values, `${x?.title ?? x?.series ?? 'Series'} observations`) || h('span', { class: 'small muted' }, 'too few points'))));
      })));
  });

  function renderAgents() {
    const st = store.status;
    const agents = arr(st?.agents);
    // Re-render only when something shown changed, and keep focus on the same agent row when it does.
    const sig = JSON.stringify([!!st, !!st?.kill?.engaged, agents.map((a) => [a?.id, a?.lens, a?.segment, a?.state, a?.state_reason, a?.last_ok, a?.last_fail])]);
    if (sig === agentsSig) return;
    agentsSig = sig;
    preserveFocus(agentsBody, () => {
      if (!st) { replace(agentsBody, statusBlock('UNKNOWN', 'Agent states are unknown while the API is unreachable.')); return; }
      if (!agents.length) { replace(agentsBody, statusBlock('NONE RETURNED', 'No agents reported by /api/status.')); return; }
      replace(agentsBody,
        st.kill?.engaged ? statusBlock('KILL SWITCH ENGAGED', 'All agent authority is suspended.', null, { tone: 'bad' }) : null,
        h('ul', { class: 'list' }, agents.map((a) => {
          const lens = LENSES.find((l) => l.id === a?.lens);
          const la = lastAction(a);
          return h('li', null, h('a', { class: 'list-row', href: '#/agents', 'data-focus-key': `agent-${a?.id}` },
            h('span', { class: 'l' }, h('span', { class: 't' }, `${lens?.label ?? a?.lens ?? 'Agent'} · ${SEGMENT_LABELS[a?.segment] ?? a?.segment ?? ''}`),
              a?.state_reason ? h('span', { class: 's', title: String(a.state_reason) }, stateReasonText(a.state_reason)) : null,
              h('span', { class: ['s', la && !la.ok ? 'down' : null] }, lastActionLine(a))),
            h('span', { class: 'r' }, badge(a?.state))));
        })));
    });
  }

  function renderTimestamps() {
    const st = store.status;
    const r = st?.replay || {};
    const ds = datasetInfo(st);
    sub.textContent = st
      ? `${isNum(r.clock) ? `Replay clock ${fmtEt(r.clock, { date: true })}` : 'Replay clock not set'} · ${ds.id ? `dataset ${ds.id}` : 'no dataset'}`
      : 'API unreachable — no verified data';
    const rows = {
      'Replay clock (ET)': isNum(r.clock) ? fmtEt(r.clock, { date: true, seconds: true }) : 'NOT SET',
      'Session window': isNum(r.t_start) && isNum(r.t_end) ? `${fmtEt(r.t_start)} – ${fmtEt(r.t_end)}` : 'NOT SET',
      'Trade date': ds.tradeDate || 'NOT SET',
      'Opportunities as of': isNum(asOf.opps) ? fmtEt(asOf.opps, { date: true }) : 'not loaded',
      'Benchmark as of': isNum(asOf.bench) ? fmtEt(asOf.bench, { date: true }) : 'not loaded',
      'Macro as of': isNum(asOf.macro) ? fmtEt(asOf.macro, { date: true }) : 'not loaded',
      'Status received': store.lastOkWall ? fmtLocalTime(store.lastOkWall) : 'never',
    };
    replace(tsBody, kv(rows), h('p', { class: 'small muted' }, 'A minute bar [t, t+60s) is knowable at t+60s; nothing later than the replay clock is shown.'));
  }

  renderAgents();
  renderTimestamps();
  loadOpps(false);
  loadBench();
  loadSources();
  loadMacro();

  return {
    onStatus(_st, info) {
      renderAgents();
      renderTimestamps();
      if (info.clockChanged || info.sessionChanged) { loadOpps(false); loadBench(); }
      const c = num(store.status?.replay?.clock);
      if (info.sessionChanged || (isNum(c) && (!isNum(macroClock) || Math.abs(c - macroClock) >= MACRO_REFRESH_MS))) loadMacro();
      if (info.sessionChanged || info.firstLoad) loadSources();
    },
    destroy() { alive = false; benchChart?.destroy?.(); },
  };
}
