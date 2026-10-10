// Persistent compact status strip (every view, phone and desktop). Tapping it opens the Sources view.
// Shows: data mode, a PARTIAL chip when the replay dataset is incomplete/truncated, dataset + trade date, replay clock
// (ET), PAPER ONLY badge, model status (with a running marker while a model call is in flight on the server), and the
// kill-switch state. On phones the strip is limited to the essential chips in at most two rows (short labels; the
// dataset chip is hidden there but stays in the strip's accessible label and on the Replay / Overview / Data sources views).
import { h, replace } from './dom.js';
import { fmtEt, fmtEtDate, fmtLocalTime, statusTone, obj } from './format.js';
import { datasetCoverage, modelActivity } from './summaries.js';

/** Text that differs by width: [long, short] renders both and CSS shows one; a string renders as is. */
function txt(t) {
  return Array.isArray(t) ? [h('span', { class: 'lg' }, t[0]), h('span', { class: 'sm', 'aria-hidden': 'true' }, t[1])] : t;
}

/** id becomes data-chip, a stable hook for checks (the visible key can differ by width, e.g. Data / Partial). */
function chip(k, v, tone, { stale, title, opt, cls, id } = {}) {
  return h('span', { class: ['chip', tone && `t-${tone}`, stale && 'stale', opt && 'opt', cls], title, dataset: { chip: id } },
    k ? h('span', { class: 'chip-k' }, txt(k)) : null,
    h('span', { class: 'chip-v' }, txt(v)));
}

/** Dataset label + trade date from whatever shape /api/status gives (string id or object). */
export function datasetInfo(status) {
  const d = status?.data?.dataset;
  const r = status?.replay || {};
  const o = obj(d);
  const fromData = o ? (o.id ?? o.ds ?? null) : (typeof d === 'string' && d ? d : null);
  const id = fromData ?? r.ds ?? null;
  const tradeDate = (o && o.trade_date) || (typeof r.t_start === 'number' ? fmtEtDate(r.t_start) : null);
  return { id, tradeDate };
}

const PAPER = ['PAPER ONLY — NO LIVE TRADING', 'PAPER ONLY'];

export function renderStatusStrip(el, store) {
  const st = store.status;
  const err = store.error;
  const stale = !!(err && st);
  const chips = [];
  const labels = [];

  if (err) {
    const code = err.code === 'API_UNREACHABLE' ? 'API UNREACHABLE' : err.code === 'CLIENT_TIMEOUT' ? 'NO RESPONSE YET' : err.code;
    chips.push(chip(null, code, err.code === 'CLIENT_TIMEOUT' ? 'warn' : 'solid-bad', { title: `${err.message}${store.lastOkWall ? ` — last good status ${fmtLocalTime(store.lastOkWall)}` : ''}` }));
    labels.push(code);
  }
  if (!st) {
    chips.push(chip('Data', 'NO_VERIFIED_DATA', 'warn', { title: 'No verified status from the API', id: 'data' }));
    chips.push(chip(null, PAPER, 'copper', { id: 'paper' }));
    chips.push(chip('Model', 'UNKNOWN', null, { id: 'model' }));
    chips.push(chip(['Kill switch', 'Kill'], 'UNKNOWN', null, { id: 'kill' }));
    labels.push('data NO_VERIFIED_DATA', 'paper only, no live trading', 'model status unknown', 'kill switch unknown');
  } else {
    const mode = st.data?.mode || 'NO_VERIFIED_DATA';
    const cov = datasetCoverage(st);
    const ends = cov.partial && cov.endMs !== null ? fmtEt(cov.endMs) : null;
    const partialTitle = cov.partial
      ? (cov.detail || `The replay dataset is incomplete${ends ? `: market data ends at ${ends}` : ''}; minutes after the coverage end have no data.`)
      : null;
    // Phones keep two rows: the PARTIAL marker becomes the data chip's key there ("PARTIAL HISTORICAL_REAL"); the
    // separate chip with the coverage end is shown from 768 px up (the end time is also on the Replay view).
    chips.push(chip(cov.partial ? ['Data', 'Partial'] : 'Data', mode, statusTone(mode), {
      stale, cls: cov.partial ? 'partial-k' : null, id: 'data',
      title: [partialTitle, st.data?.live?.detail].filter(Boolean).join(' · ') || undefined,
    }));
    let partialLabel = null;
    if (cov.partial) {
      chips.push(chip(null, ends ? `PARTIAL — data ends ${ends}` : 'PARTIAL DATASET', 'warn', { stale, opt: true, cls: 'partial', title: partialTitle, id: 'partial' }));
      partialLabel = `partial dataset${ends ? `, data ends ${ends}` : ''}`;
    }
    const ds = datasetInfo(st);
    const r = st.replay || {};
    const clock = typeof r.clock === 'number' ? fmtEt(r.clock) : 'NOT SET';
    chips.push(chip('Replay', `${clock}${r.playing ? ' ▶' : ''}`, r.playing ? 'ok' : null, { stale, title: r.playing ? 'Replay playing (server-side)' : 'Replay paused', id: 'replay' }));
    chips.push(chip('Set', ds.id ? `${ds.id}${ds.tradeDate && !String(ds.id).includes(ds.tradeDate) ? ` · ${ds.tradeDate}` : ''}` : 'NO DATASET', ds.id ? null : 'warn', { stale, opt: true, id: 'dataset' }));
    chips.push(chip(null, PAPER, 'copper', { id: 'paper' }));
    const ms = st.model?.status || 'DISCONNECTED';
    const act = modelActivity(st.model);
    const running = act.running ? `${act.kinds.length ? act.kinds.join(' + ') : 'model call'} running on the server` : null;
    chips.push(chip('Model', act.running ? [`${ms} · RUNNING`, 'RUNNING'] : ms, statusTone(ms), {
      stale, cls: act.running ? 'running' : null, id: 'model',
      title: [running, st.model?.provider, st.model?.model, st.model?.detail].filter(Boolean).join(' · ') || undefined,
    }));
    const engaged = !!st.kill?.engaged;
    chips.push(chip(['Kill switch', 'Kill'], engaged ? 'ENGAGED' : 'OFF', engaged ? 'solid-bad' : null, { stale, id: 'kill' }));
    labels.push(`data ${mode}`, ...(partialLabel ? [partialLabel] : []), `replay clock ${clock}${r.playing ? ' playing' : ''}`, `dataset ${ds.id || 'none'}${ds.tradeDate ? ` trade date ${ds.tradeDate}` : ''}`,
      'paper only, no live trading', `model ${ms}${running ? `, ${running}` : ''}`, `kill switch ${engaged ? 'engaged' : 'off'}`);
  }
  chips.push(h('span', { class: 'strip-go', 'aria-hidden': 'true' }, 'Sources ›'));
  replace(el, chips);
  el.setAttribute('aria-label', `System status: ${labels.join(', ')}${stale ? ' (stale)' : ''}. Open data sources.`);
  measureStrip(el);
}

/** Publish the sticky strip's height as --strip-h so scroll-padding keeps focused targets clear of it. */
function measureStrip(el) {
  const wrap = el.closest ? el.closest('.status-wrap') : null;
  if (!wrap || typeof requestAnimationFrame !== 'function') return;
  requestAnimationFrame(() => {
    const hgt = Math.ceil(wrap.getBoundingClientRect().height);
    if (hgt > 0) document.documentElement.style.setProperty('--strip-h', `${hgt}px`);
  });
}
