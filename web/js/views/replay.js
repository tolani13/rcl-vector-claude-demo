// #/replay — historical replay controls (server-side clock): dataset, play/pause, step 1/5/15/60 min, reset with
// starting funds (agents keep their current strategies unless "Restore preset strategies" is ticked), progress through
// the session, and the RETROSPECTIVE signal/failure study (hindsight data, never
// visible to agents). The study is LOCKED while a replay of the same day is in progress (clock before the close), so
// later outcomes cannot steer sandbox orders or strategy edits made during the replay.
import { h, replace, announce } from '../dom.js';
import * as api from '../api.js';
import { card, pageHeader, statusBlock, loading, badge, kv, field, select, confirmBox, decisionResult, rtable, renderSection, metric, signed } from '../components.js';
import { pokeStatus, refreshStatus } from '../store.js';
import { datasetInfo } from '../status-strip.js';
import { studyAccess, datasetCoverage } from '../summaries.js';
import { rowsOf, makeLoader } from './common.js';
import {
  arr, obj, num, isNum, fmtEt, fmtUsdU, fmtPct, fmtPriceU, fmtBps, fmtFracPct, fmtRelVol, fmtShares, fmtInt, fmtNum, usdToU, humanizeKey,
  humanizeCode, DASH,
} from '../format.js';

const RETRO_LABEL = 'RETROSPECTIVE — uses data after each signal; never visible to agents';
const DEFAULT_STARTING_USD = 10000; // documented default seed money per portfolio (docs/CONTRACTS.md §3); fictional
const STEPS = [1, 5, 15, 60];
const OUTCOME_TONE = { continued: 'ok', stalled: 'warn', reversed: 'bad' };

// POST /api/replay/reset field that reverts every agent to its EXPLORATORY preset (server/api/replay.js postReset).
// Omitted = the server's default: each agent's current validated strategy is carried into the new session.
export const RESET_PRESETS_FIELD = 'restorePresets';

/** Body for POST /api/replay/reset. The presets flag is sent only when the human ticked it. */
export function resetRequestBody({ ds, startingCashU, restorePresets = false }) {
  return { ds, startingCashU, ...(restorePresets ? { [RESET_PRESETS_FIELD]: true } : {}) };
}

/**
 * What the reset did to agent strategies, from the response's strategies[] ({agent_id, strategy_source, state, note}).
 * fallbacks = agents whose stored strategy could not be carried (preset applied instead, with the server's reason).
 */
export function strategyOutcome(data) {
  const list = arr(obj(data)?.strategies).filter((x) => obj(x));
  const restored = obj(data)?.[RESET_PRESETS_FIELD] === true;
  const carried = list.filter((x) => x.strategy_source === 'carried').length;
  const preset = list.filter((x) => x.strategy_source === 'preset').length;
  const fallbacks = restored ? [] : list.filter((x) => x.strategy_source === 'preset' && typeof x.note === 'string' && /not reusable/i.test(x.note))
    .map((x) => ({ agent_id: String(x.agent_id ?? ''), note: x.note }));
  const stopped = list.filter((x) => x.state === 'STOPPED').length;
  return { total: list.length, carried, preset, restored, fallbacks, stopped };
}

function strategyOutcomeLine(data) {
  const o = strategyOutcome(data);
  if (!o.total) return null;
  const head = o.restored
    ? `Agent strategies: all ${fmtInt(o.total)} reverted to their EXPLORATORY presets.`
    : `Agent strategies: ${fmtInt(o.carried)} carried into the new session, ${fmtInt(o.preset)} on the preset.`;
  return h('div', { class: 'small note' }, h('p', null, head),
    o.stopped ? h('p', { class: 'warn-text' }, `The kill switch is engaged: ${fmtInt(o.stopped)} agent${o.stopped === 1 ? ' stays' : 's stay'} STOPPED until it is released and a human starts each one.`) : null,
    o.fallbacks.length ? h('ul', null, o.fallbacks.map((f) => h('li', null, `${f.agent_id}: ${f.note}`))) : null);
}

export function render(root, { store }) {
  let alive = true;
  let busy = false;          // a replay request from this view is in flight
  let pendingTimeout = false; // a step timed out client-side; the server may still be working
  const load = makeLoader(() => alive);
  const clockBody = h('div');
  const result = h('div', { role: 'status', 'aria-live': 'polite', tabindex: '-1' });
  const resetBody = h('div', null, loading('datasets'));
  const studyBody = h('div', null, loading('replay status'));
  let datasets = [];
  let studyShownFor = null;

  // Controls are built once and updated in place, so status polls never destroy a focused button.
  const playBtn = h('button', { type: 'button', class: 'btn btn-primary' }, 'Play');
  const stepBtns = STEPS.map((m) => h('button', { type: 'button', class: 'btn', 'aria-label': `Step ${m} minute${m > 1 ? 's' : ''}` }, `+${m}m`));
  const playNote = h('p', { class: 'small muted', hidden: true }, 'Stepping is disabled while playing. Status refreshes about every 3 s.');
  const busyNote = h('p', { class: 'small note', hidden: true, role: 'status' }, 'The server is processing a replay step (it runs every agent for each minute)…');
  const controlsBody = h('div', null, h('div', { class: 'divider' }), h('div', { class: 'btn-row stretch' }, playBtn, ...stepBtns), playNote, busyNote);
  playBtn.addEventListener('click', () => {
    const r = obj(store.status?.replay) || {};
    mutate(r.playing ? '/api/replay/pause' : '/api/replay/play', {}, r.playing ? 'Replay paused.' : 'Replay playing.');
  });
  stepBtns.forEach((b, i) => b.addEventListener('click', () => mutate('/api/replay/step', { minutes: STEPS[i] }, `Stepped ${STEPS[i]} min.`, { timeoutMs: api.stepTimeoutMs(STEPS[i]) })));

  root.append(
    pageHeader('Replay', { sub: 'Advance a real, sourced historical session minute by minute. The clock runs on the server; agents only see what was knowable at the clock.' }),
    h('div', { class: 'grid grid-12' },
      card({ title: 'Session clock', cls: 'span-7' }, clockBody, controlsBody, result),
      card({ title: 'Reset session', cls: 'span-5' }, resetBody),
      card({ title: 'Signal / failure study', cls: 'span-12' }, h('div', { class: 'label-banner retro' }, RETRO_LABEL), studyBody)));

  function drawClock() {
    const st = store.status;
    const hadFocus = controlsBody.contains(document.activeElement) ? document.activeElement : null;
    if (!st) {
      replace(clockBody, statusBlock(['NO_VERIFIED_DATA', 'API UNREACHABLE'], 'Replay state is unknown while the API is unreachable.'));
      controlsBody.hidden = true;
      return;
    }
    controlsBody.hidden = false;
    const r = obj(st.replay) || {};
    const ds = datasetInfo(st);
    const t0 = num(r.t_start);
    const t1 = num(r.t_end);
    const c = num(r.clock);
    const hasSession = !!ds.id && isNum(t0) && isNum(t1) && isNum(c);
    const pct = hasSession ? Math.max(0, Math.min(100, ((c - t0) / (t1 - t0)) * 100)) : 0;
    const bar = h('span');
    bar.style.width = `${pct.toFixed(1)}%`;
    const done = hasSession && c >= t1;
    const cov = datasetCoverage(st);
    replace(clockBody,
      hasSession
        ? h('div', { class: 'stack' },
          h('div', null,
            h('div', { class: 'clock-big' }, fmtEt(c, { seconds: false })),
            h('div', { class: 'note' }, r.playing ? h('span', null, h('span', { class: 'play-dot', 'aria-hidden': 'true' }), 'Playing (server-side)') : done ? 'Session complete' : 'Paused')),
          h('div', { class: 'progress', role: 'progressbar', 'aria-label': 'Session progress', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': pct.toFixed(0), 'aria-valuetext': `${pct.toFixed(0)}% of the regular session` }, bar),
          kv({
            Dataset: ds.id,
            'Trade date': ds.tradeDate ?? DASH,
            'Session window': `${fmtEt(t0)} – ${fmtEt(t1)}`,
            Elapsed: `${Math.round((c - t0) / 60000)} of ${Math.round((t1 - t0) / 60000)} minutes`,
            'Data mode': st.data?.mode ?? 'NO_VERIFIED_DATA',
            ...(cov.partial ? {
              'Dataset coverage': h('span', { class: 'stack tight' },
                h('span', null, badge(cov.endMs !== null ? `PARTIAL — market data ends ${fmtEt(cov.endMs)}` : 'PARTIAL DATASET', { tone: 'warn' })),
                cov.beyond ? h('span', { class: 'small warn-text' }, 'The replay clock is past the coverage end: no market state was observed here (no quotes, no fills).') : null,
                cov.detail ? h('span', { class: 'small note' }, cov.detail) : null),
            } : {}),
            'Session id': r.session_id ?? DASH,
            'Play speed': isNum(num(r.tick_wall_ms)) ? `one replay minute every ${fmtNum(num(r.tick_wall_ms) / 1000, 1)} s of real time` : DASH,
          }))
        : statusBlock('NO_VERIFIED_DATA', 'No replay session with a verified market dataset.', 'Ingest a dataset (e.g. npm run ingest:iex -- --date YYYY-MM-DD) and reset a session below.'));

    const serverBusy = !!r.busy;
    // Busy states use aria-disabled so a focused control keeps focus; structural states use the real disabled flag.
    const blocked = busy || serverBusy;
    playBtn.textContent = r.playing ? 'Pause' : 'Play';
    playBtn.disabled = !hasSession || (done && !r.playing);
    for (const b of stepBtns) b.disabled = !hasSession || done || !!r.playing;
    for (const b of [playBtn, ...stepBtns]) b.setAttribute('aria-disabled', String(b.disabled || blocked));
    playNote.hidden = !r.playing;
    busyNote.hidden = !blocked;
    if (hadFocus && hadFocus.disabled) (playBtn.disabled ? result : playBtn).focus({ preventScroll: true });
  }

  async function mutate(path, body, okMsg, opts) {
    if (busy || store.status?.replay?.busy) { announce('A replay request is already being processed.'); return; }
    busy = true;
    drawClock();
    const isStep = path.endsWith('/step');
    replace(result, isStep ? loading(`replay step of ${body.minutes} min (the server runs every agent for each minute)`) : null);
    const res = await api.post(path, body, opts);
    busy = false;
    if (!alive) return;
    if (res.timedOut) {
      pendingTimeout = true;
      replace(result, decisionResult(res));
      announce('No response yet; the server may still be processing the step. Status will refresh.');
      waitForServerIdle();
    } else {
      replace(result, res.ok ? null : decisionResult(res));
      announce(res.ok ? okMsg : `Replay request failed: ${res.error?.message ?? ''}`);
    }
    await pokeStatus();
  }

  /** After a client timeout, poll status (bounded) until the server reports the step finished. */
  async function waitForServerIdle() {
    const until = Date.now() + 180000;
    while (alive && pendingTimeout && Date.now() < until) {
      await new Promise((r) => setTimeout(r, 4000));
      if (!alive) return;
      await refreshStatus();
      if (!store.status?.replay?.busy) break;
    }
  }

  // ---------------------------------------------------------------- reset
  function drawReset() {
    const st = store.status;
    const current = st?.replay?.ds ?? datasetInfo(st).id ?? null;
    const opts = datasets.map((d) => [d.id, `${d.id}${d.status ? ` · ${d.status}` : ''}`]);
    if (current && !opts.some(([id]) => id === current)) opts.unshift([current, `${current} (current)`]);
    if (!opts.length) {
      replace(resetBody, statusBlock('NO_VERIFIED_DATA', 'No replayable market dataset is registered.',
        'Ingest the IEX HIST TOPS file for a trade date on the server: npm run ingest:iex -- --date YYYY-MM-DD (see Data sources).'));
      return;
    }
    const dsSel = select(opts, current ?? opts[0][0]);
    const cashIn = h('input', { type: 'number', min: '1', step: '1', inputmode: 'numeric', value: String(DEFAULT_STARTING_USD) });
    const presetsChk = h('input', { type: 'checkbox', 'aria-describedby': 'reset-presets-hint' });
    const err = h('div', { class: 'err', role: 'alert' });
    const area = h('div');
    const out = h('div', { role: 'status', 'aria-live': 'polite' });
    const form = h('form', { class: 'stack', novalidate: true },
      field('Market dataset', dsSel),
      field('Starting funds per portfolio (USD, simulated)', cashIn, { hint: 'Seed money is the only fictional input. Applies to all six agent portfolios and the sandbox.' }),
      h('div', { class: 'field' },
        h('label', { class: 'check' }, presetsChk, ' Restore preset strategies'),
        h('div', { class: 'hint', id: 'reset-presets-hint' }, 'Unticked (default): each agent keeps its current strategy, so an edited strategy can be re-run on the same day. Ticked: all six agents revert to their EXPLORATORY presets.')),
      err, h('div', { class: 'btn-row' }, h('button', { type: 'submit', class: 'btn', disabled: !st }, 'Reset session…')), area, out);
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const usd = Number(cashIn.value);
      if (!Number.isFinite(usd) || usd < 1 || usd > 1e9) { err.textContent = 'Enter a starting amount between 1 and 1,000,000,000 USD.'; cashIn.setAttribute('aria-invalid', 'true'); return; }
      err.textContent = ''; cashIn.removeAttribute('aria-invalid');
      const startingCashU = usdToU(usd);
      const restorePresets = presetsChk.checked;
      replace(area, confirmBox({
        title: 'Start a new replay session?',
        body: h('div', { class: 'small' },
          h('p', null, `Creates a new session on ${dsSel.value}: seven portfolios with ${fmtUsdU(startingCashU)} simulated cash each, all agents PAUSED, clock at the session open. Previous journal entries are kept. The retrospective study stays locked until the new session reaches the close.`),
          h('p', null, restorePresets
            ? h('strong', null, 'Agent strategies: every agent reverts to its EXPLORATORY preset (current edits are not carried).')
            : 'Agent strategies: each agent keeps its current strategy (carried by default); one that no longer validates falls back to its preset.')),
        confirmLabel: 'Reset session',
        onConfirm: async () => {
          const res = await api.post('/api/replay/reset', resetRequestBody({ ds: dsSel.value, startingCashU, restorePresets }));
          if (!alive) return;
          replace(area); replace(out, decisionResult(res), res.ok ? strategyOutcomeLine(res.data) : null);
          announce(res.ok ? 'New replay session started.' : `Reset failed: ${res.error?.message ?? ''}`);
          await pokeStatus(); // the study redraws from the new status (locked at the open)
        },
        onCancel: () => replace(area),
      }));
    });
    replace(resetBody, form);
  }

  const loadDatasets = () => load('ds', '/api/sources', null, 'Sources', (d) => {
    // A market source lists its ingested datasets; the dataset id (not the source id) is what /api/replay/reset takes.
    datasets = rowsOf(d, 'sources').filter((s) => s && (s.kind === 'market_ticks' || s.kind === 'market' || s.replayable === true))
      .flatMap((s) => (Array.isArray(s.datasets) && s.datasets.length
        ? s.datasets.filter((x) => x && typeof x.id === 'string' && ['complete', 'partial'].includes(x.status)).map((x) => ({ id: x.id, status: x.status }))
        : (s.replayable === true ? [{ id: s.id, status: s.status }] : [])));
    drawReset();
  }).then((res) => { if (res && !res.ok) { datasets = []; drawReset(); if (!store.status) replace(resetBody, statusBlock(['API UNREACHABLE'], 'Datasets could not be loaded.', res.error?.message)); } });

  // ---------------------------------------------------------------- retrospective study (locked until the close)
  function drawStudy() {
    const st = store.status;
    if (!st) {
      studyShownFor = null;
      replace(studyBody, statusBlock(['NOT LOADED'], 'Waiting for the replay status before deciding whether the retrospective study may be shown.', null, { tone: 'warn' }));
      return;
    }
    const r = obj(st.replay) || {};
    const acc = studyAccess(r);
    if (acc.locked) {
      studyShownFor = null;
      replace(studyBody, statusBlock(['LOCKED UNTIL SESSION CLOSE'],
        'The retrospective study is hidden while this replay day is in progress.',
        `It shows what happened AFTER each signal (continued / reversed, best and worst excursion, session-close return) — hindsight that would contaminate sandbox orders and strategy edits made during the replay. It unlocks when the replay clock reaches the session close${isNum(acc.closesAt) ? ` (${fmtEt(acc.closesAt)})` : ''}; step or play to the close to review it.`,
        { tone: 'warn' }));
      return;
    }
    const key = `${r.session_id ?? 'none'}|${r.ds ?? 'none'}`;
    if (studyShownFor === key) return;
    studyShownFor = key;
    loadStudy(true);
  }

  const loadStudy = (showLoading) => load('study', '/api/research/study', studyBody, 'Retrospective study', (d) => {
    replace(studyBody, renderStudy(d));
  }, { showLoading });

  drawClock();
  drawStudy();
  loadDatasets();

  return {
    onStatus(_s, info) {
      drawClock();
      if (pendingTimeout && !store.status?.replay?.busy) {
        pendingTimeout = false;
        replace(result, h('p', { class: 'small note' }, `The server finished the step; the replay clock is now ${fmtEt(store.status?.replay?.clock)}.`));
      }
      drawStudy();
      if (info.sessionChanged || info.firstLoad) loadDatasets();
    },
    destroy() { alive = false; },
  };
}

// ---------------------------------------------------------------- study rendering (pure DOM builders)

const COUNT_LABELS = {
  signals: 'Signals', continued: 'Continued', stalled: 'Stalled', reversed: 'Reversed', symbolsScanned: 'Symbols scanned',
  no_trades_after_signal: 'No trades after signal', no_session_after_signal: 'No session left after signal',
};

function outcomeBadge(v) {
  return typeof v === 'string' ? badge(v.toUpperCase(), { tone: OUTCOME_TONE[v] || 'neutral' }) : h('span', { class: 'muted' }, DASH);
}
const pctCell = (v) => (isNum(num(v)) ? signed(num(v), fmtPct(num(v))) : h('span', { class: 'muted' }, DASH));

function countsStrip(counts) {
  const c = obj(counts) || {};
  const main = ['signals', 'continued', 'stalled', 'reversed'].filter((k) => k in c);
  const extra = Object.keys(c).filter((k) => !main.includes(k) && isNum(num(c[k])) && (k === 'symbolsScanned' || num(c[k]) > 0));
  return h('div', { class: 'counts-strip' },
    [...main, ...extra].map((k) => metric(COUNT_LABELS[k] ?? humanizeKey(k), fmtInt(c[k]))));
}

function signalTable(rows) {
  return rtable([
    { label: 'Signal', head: true, render: (r) => h('span', null, h('span', { class: 'sym' }, String(r.sym ?? DASH)), h('span', { class: 'sub' }, `signal ${r.signalEt ?? DASH}`)) },
    { label: 'Outcome', render: (r) => outcomeBadge(r.outcome) },
    { label: 'Window return', num: true, render: (r) => pctCell(r.retWPct) },
    { label: 'Outcome return', num: true, render: (r) => pctCell(r.classRetPct) },
    { label: 'Best (MFE)', num: true, render: (r) => pctCell(r.mfePct) },
    { label: 'Worst (MAE)', num: true, render: (r) => pctCell(r.maePct) },
    { label: 'Session close', num: true, render: (r) => pctCell(r.sessionCloseRetPct) },
    { label: 'Signal price', num: true, render: (r) => fmtPriceU(num(r.signalPriceU)) },
    { label: 'IEX spread', num: true, render: (r) => fmtBps(r.spreadBps) },
    { label: 'Rel. volume', num: true, render: (r) => h('span', { title: isNum(num(r.relVol)) ? String(r.relVol) : null }, fmtRelVol(r.relVol)) },
    { label: 'Inferred buy share', num: true, render: (r) => (isNum(num(r.buyShare)) ? fmtFracPct(num(r.buyShare), { sign: false }) : 'n/a') },
    { label: 'Window volume', num: true, render: (r) => fmtShares(r.volumeW) },
    { label: 'Later horizons', full: true, render: (r) => {
      const hz = obj(r.horizons);
      if (!hz || !Object.keys(hz).length) return h('span', { class: 'muted' }, DASH);
      return h('span', null, Object.entries(hz).map(([m, x]) => `+${m} min ${fmtPct(num(obj(x)?.retPct))}`).join(' · '));
    } },
  ], arr(rows), { caption: 'Signals and their later outcomes (retrospective)', empty: 'No qualifying signals in this dataset.' });
}

function pairSide(title, x, cls) {
  const o = obj(x) || {};
  return h('div', { class: 'pair-side' },
    h('h4', null, title, ' · ', String(o.sym ?? DASH), ' ', cls ? outcomeBadge(cls) : null),
    kv({ 'Signal time': o.signalEt ?? DASH, 'Outcome return': fmtPct(num(o.classRetPct)), 'Best (MFE)': fmtPct(num(o.mfePct)), 'Worst (MAE)': fmtPct(num(o.maePct)) }));
}

function featureTable(a, b) {
  const fa = obj(obj(a)?.features) || {};
  const fb = obj(obj(b)?.features) || {};
  const keys = [...new Set([...Object.keys(fa), ...Object.keys(fb)])];
  const fmt = (k, v) => (v === null || v === undefined ? 'n/a' : k === 'ret_w' || k === 'accel' || k === 'buyShare' ? fmtFracPct(v) : k === 'spreadBps' ? fmtBps(v) : fmtNum(v, 3));
  return rtable([
    { label: 'Feature at signal', head: true, render: (k) => humanizeKey(k) },
    { label: 'Breakout', num: true, render: (k) => fmt(k, fa[k]) },
    { label: 'Matched failure', num: true, render: (k) => fmt(k, fb[k]) },
  ], keys, { caption: 'Signal-time features compared' });
}

function matchedPairs(m) {
  const o = obj(m);
  const pairs = arr(o?.pairs);
  if (!pairs.length) return statusBlock('NONE RETURNED', 'No breakout / failure pairs could be matched.', 'Matching needs at least one continued and one failed signal with enough shared features.');
  return h('div', { class: 'stack' }, pairs.slice(0, 10).map((p) => h('div', { class: 'stack' },
    h('div', { class: 'pair-grid' }, pairSide('Breakout', p.breakout, 'continued'), pairSide('Matched failure', p.matchedFailure, p.matchedFailure?.class)),
    h('p', { class: 'small muted' }, `Distance ${fmtNum(num(p.distance), 3)} over ${fmtInt(p.featuresCompared)} shared features (z-scored). Descriptive only.`),
    h('details', null, h('summary', null, 'Feature-by-feature comparison'), featureTable(p.breakout, p.matchedFailure)))));
}

function ruleVariants(rule) {
  const o = obj(rule);
  if (!o) return null;
  const variants = arr(o.variants);
  return h('div', { class: 'stack' },
    o.label ? h('div', { class: 'label-banner' }, String(o.label)) : null,
    variants.length ? rtable([
      { label: 'Variant', head: true, render: (v) => h('span', null, h('span', { class: 'sym' }, String(v.id ?? DASH)), v.id && v.id === o.default ? h('span', { class: 'sub' }, 'default reading') : null) },
      { label: 'Stop', render: (v) => humanizeCode(v.stopMode) },
      { label: 'Take-profit', num: true, render: (v) => (isNum(num(v.tpMult)) ? `${fmtNum(num(v.tpMult), 2)}× entry` : DASH) },
      { label: 'Time exit', render: (v) => (v.timeExit ? 'yes' : 'no') },
      { label: 'Entered', num: true, render: (v) => `${fmtInt(obj(v.summary)?.entered)} of ${fmtInt(obj(v.summary)?.signals)}` },
      { label: 'Win / loss / flat', num: true, render: (v) => { const s = obj(v.summary) || {}; return `${fmtInt(s.winners)} / ${fmtInt(s.losers)} / ${fmtInt(s.flat)}`; } },
      { label: 'Worse-than-stop fills', num: true, render: (v) => fmtInt(obj(v.summary)?.worseThanStopFills) },
      { label: 'Immediate stop triggers', num: true, render: (v) => fmtInt(obj(v.summary)?.immediateStopTriggers) },
      { label: 'Total P&L (est.)', num: true, render: (v) => { const u = num(obj(v.summary)?.totalPnlU); return isNum(u) ? signed(u, fmtUsdU(u, { sign: true })) : DASH; } },
      { label: 'Total cost', num: true, render: (v) => fmtUsdU(num(obj(v.summary)?.totalCostU)) },
    ], variants, { caption: 'Handwritten-rule variants (estimated paper fills)' }) : null,
    obj(o.interpretation) ? h('details', null, h('summary', null, 'Rule interpretation'), kv(o.interpretation)) : null,
    obj(o.fillModel) ? h('p', { class: 'small muted' }, `Fill model: ${o.fillModel.id ?? DASH}${o.fillModel.source ? ` (${o.fillModel.source})` : ''}.`) : null);
}

/** The retrospective study laid out for reading: counts and the signal table first; method and provenance collapsed. */
export function renderStudy(d) {
  const o = obj(d);
  if (!o) return Array.isArray(d) ? signalTable(d) : renderSection(d, { what: 'The retrospective study' });
  const status = typeof o.status === 'string' ? o.status : null;
  const rows = arr(o.rows ?? o.cases ?? o.signals);
  if (status !== 'HISTORICAL_REAL' || (!rows.length && !obj(o.counts))) {
    return statusBlock([o.code || o.reason || status || 'BLOCKED'], typeof o.detail === 'string' ? o.detail : 'No retrospective study is available.',
      typeof o.note === 'string' ? o.note : 'BLOCKED BY DATA until a replayable dataset with qualifying signals is ingested; no historical case is fabricated.');
  }
  const m = obj(o.matched);
  const ex = obj(o.exploratory);
  const limitations = arr(o.limitations);
  return h('div', { class: 'stack' },
    h('div', { class: 'badges' }, badge(status), o.tier ? badge(`tier ${o.tier}`, { tone: 'neutral' }) : null,
      isNum(num(o.thresholdPct)) ? badge(`signal ≥ +${fmtNum(num(o.thresholdPct), 2)}%`, { tone: 'neutral' }) : null),
    typeof o.note === 'string' ? h('p', { class: 'small note' }, o.note) : null,
    limitations.length ? h('p', { class: 'small muted' }, String(limitations[0])) : null,
    obj(o.counts) ? countsStrip(o.counts) : null,
    h('h3', { class: 'section-title' }, 'Signals and outcomes'),
    signalTable(rows),
    h('h3', { class: 'section-title' }, 'Breakout vs matched failure'),
    matchedPairs(m),
    obj(o.handwrittenRule) ? [h('h3', { class: 'section-title' }, 'Handwritten 50-USD example — variants'), ruleVariants(o.handwrittenRule)] : null,
    ex ? h('details', null, h('summary', null, `Exploratory variant${ex.label ? ` — ${ex.label}` : ''}`),
      h('div', { class: 'stack' }, ex.reason ? h('p', { class: 'small note' }, String(ex.reason)) : null, obj(ex.counts) ? countsStrip(ex.counts) : null, signalTable(arr(ex.rows)))) : null,
    h('details', null, h('summary', null, 'Method'),
      h('div', { class: 'stack' },
        obj(o.definitions) ? kv(o.definitions) : null,
        limitations.length ? h('ul', { class: 'small note' }, limitations.map((t) => h('li', null, String(t)))) : null,
        m?.method ? h('p', { class: 'small note' }, `Matching: ${m.method}`) : null)),
    h('details', null, h('summary', null, 'Provenance'),
      kv({
        Dataset: o.ds ?? obj(o.dataset)?.id ?? DASH,
        Provider: obj(o.dataset)?.provider ?? DASH,
        'Dataset sha256': obj(o.dataset)?.sha256 ?? DASH,
        Coverage: obj(o.dataset)?.coverage ?? DASH,
        'Trade date': obj(o.session)?.tradeDate ?? DASH,
        'Session': obj(o.session) ? `${o.session.open ?? DASH} – ${o.session.close ?? DASH}` : DASH,
        'Computed in': isNum(num(obj(o.timing)?.ms)) ? `${fmtInt(o.timing.ms)} ms` : DASH,
      })));
}
