// #/research — ranked opportunity list (paged; segment, return-window horizon and instrument switches); #/research/SYM —
// symbol dossier: IEX minute price/volume with inferred aggressor volume, as-of quote, identity, halts, short volume,
// filings/financing/leadership/media (honest UNAVAILABLE/BLOCKED statuses), and the THREE-LENS assessment panel
// (independent model outputs from ONE run, never averaged; audit badges for hindsight risk, fallback model and the
// draft-intent verdict; cited evidence opened on demand via GET /api/evidence?ids=, as of the replay clock).
import { h, replace, nextId, announce, prefersReducedMotion, preserveFocus } from '../dom.js';
import * as api from '../api.js';
import {
  card, pageHeader, segmentSwitch, choiceGroup, statusBlock, errorBlock, loading, badge, kv, renderValue, renderSection, confirmBox, decisionResult, field,
  isUnknownParam,
} from '../components.js';
import { priceVolumeChart } from '../charts.js';
import { setPref, refreshStatus } from '../store.js';
import { normalizeSym } from '../router.js';
import { assessmentAge, assessmentAudit, evidenceLookupIds, evidenceResult, modelActivity } from '../summaries.js';
import {
  opportunityTable, rowsOf, asOfText, makeLoader, rankingNote, methodNote, SIGNAL_LABEL, METRIC_NOTES,
  HORIZON_MINUTES, INSTRUMENT_CHOICES, INSTRUMENT_TEXT, oppParams, windowPref, instrumentsPref, instrumentNote,
} from './common.js';
import {
  arr, obj, num, isNum, parseMaybeJson, fmtEt, fmtPriceU, fmtBps, fmtAge, fmtInt, shortHash, segmentPref, LENSES, SEGMENT_LABELS, SEGMENT_NOTES, DASH,
} from '../format.js';

export const PAGE_SIZE = 25;
const ASSESS_POLL_MS = 5000;

export function render(root, ctx) {
  const { route } = ctx;
  if (route.invalidSym) {
    root.append(pageHeader('Research'), statusBlock('INVALID SYMBOL', `“${route.invalidSym}” is not a valid ticker format.`, 'Use 1–10 characters: letters, digits, “.” or “-”, starting with a letter.'));
    return listView(root, ctx, { skipHeader: true });
  }
  return route.sym ? dossierView(root, ctx, route.sym) : listView(root, ctx);
}

/** Rows to show for a filter and page size: {shown, total, matching}. Rows arrive in rank order. */
export function pageRows(rows, query, pageSize) {
  const q = String(query || '').trim().toUpperCase();
  const matching = q ? rows.filter((r) => String(r?.sym ?? '').toUpperCase().includes(q) || String(r?.name ?? '').toUpperCase().includes(q)) : rows;
  return { shown: matching.slice(0, pageSize), matching: matching.length, total: rows.length };
}

// ---------------------------------------------------------------- list

function listView(root, { store }, { skipHeader = false } = {}) {
  let seg = segmentPref(store.prefs.segment);
  let windowMin = windowPref(store.prefs.windowMin);
  let instruments = instrumentsPref(store.prefs.instruments);
  const unsupported = {}; // ranking options this server rejected (UNKNOWN_FIELD): hidden, defaults used
  let alive = true;
  let rows = [];
  let meta = null;
  let pageSize = PAGE_SIZE;
  const load = makeLoader(() => alive);
  const body = h('div', null, loading('opportunities'));
  const filter = h('input', { type: 'search', autocomplete: 'off', spellcheck: 'false', autocapitalize: 'characters', enterkeyhint: 'search' });
  const jump = h('input', { type: 'text', autocomplete: 'off', spellcheck: 'false', autocapitalize: 'characters', maxlength: '10', enterkeyhint: 'go' });
  const jumpErr = h('div', { class: 'err', role: 'alert' });
  const title = h('span', null, `Ranked by signal · ${SEGMENT_LABELS[seg]}`);

  filter.addEventListener('input', () => { pageSize = PAGE_SIZE; draw(); });
  const jumpForm = h('form', { class: 'form-grid two', on: { submit: (e) => {
    e.preventDefault();
    const sym = normalizeSym(jump.value);
    if (!sym) { jumpErr.textContent = 'Enter a valid ticker (letters/digits, “.” or “-”, max 10).'; jump.setAttribute('aria-invalid', 'true'); return; }
    location.hash = `#/research/${encodeURIComponent(sym)}`;
  } } },
  field('Open a symbol dossier', jump, { hint: 'Any symbol; data is shown only if the API has verified records for it.' }),
  h('div', { class: 'field' }, h('span', { class: 'lbl', 'aria-hidden': 'true' }, ' '), h('button', { type: 'submit', class: 'btn' }, 'Open dossier'), jumpErr));

  const horizonSw = choiceGroup('Return window (ranking horizon)', HORIZON_MINUTES.map((m) => [m, `${m} min`, `Rank on the ${m}-minute return window`]), windowMin,
    (v) => { windowMin = windowPref(v); pageSize = PAGE_SIZE; setPref('windowMin', windowMin); fetchRows(true); });
  const instrSw = choiceGroup('Instruments', INSTRUMENT_CHOICES, instruments,
    (v) => { instruments = instrumentsPref(v); pageSize = PAGE_SIZE; setPref('instruments', instruments); fetchRows(true); });

  if (!skipHeader) root.append(pageHeader('Research', { sub: 'Opportunity list and symbol dossiers (as of the replay clock)' }));
  root.append(h('div', { class: 'stack' },
    segmentSwitch(seg, (v) => { seg = v; pageSize = PAGE_SIZE; setPref('segment', v); title.textContent = `Ranked by signal · ${SEGMENT_LABELS[seg]}`; fetchRows(true); }),
    h('div', { class: 'opt-row' }, horizonSw, instrSw),
    card({ title }, h('div', { class: 'label-banner' }, SIGNAL_LABEL), field('Filter by symbol or name', filter), h('div', { class: 'divider' }), body),
    card({ title: 'Dossier lookup' }, jumpForm)));

  function draw() {
    if (!meta) return;
    const { shown, matching, total } = pageRows(rows, filter.value, pageSize);
    const metaWindow = num(meta.windowMin);
    const metaInstr = typeof meta.instruments === 'string' ? meta.instruments : (unsupported.instruments ? null : instruments);
    const instrLine = metaInstr ? instrumentNote(meta, metaInstr) : null;
    const daysWeeks = typeof obj(meta.horizons)?.daysWeeks === 'string' ? meta.horizons.daysWeeks : null;
    const more = matching > shown.length
      ? h('button', { type: 'button', class: 'btn btn-ghost link-row', 'data-focus-key': 'more-rows', on: { click: () => { pageSize += PAGE_SIZE; preserveFocus(body, draw); } } },
        `Show ${Math.min(PAGE_SIZE, matching - shown.length)} more (showing ${shown.length} of ${matching})`)
      : null;
    replace(body,
      h('p', { class: 'note small' }, [asOfText(meta.asOf), isNum(metaWindow) ? `returns are ${metaWindow}-min window returns` : null,
        metaInstr ? INSTRUMENT_TEXT[metaInstr] ?? metaInstr : null,
        `showing ${shown.length} of ${matching} matching (${total} ranked)`].filter(Boolean).join(' · ')),
      instrLine ? h('p', { class: 'small muted' }, instrLine) : null,
      methodNote(meta.note, 'research-list'),
      SEGMENT_NOTES[seg] ? h('p', { class: 'small muted' }, SEGMENT_NOTES[seg]) : null,
      daysWeeks ? h('p', { class: 'small muted' }, daysWeeks) : null,
      rows.length ? opportunityTable(shown, { windowMin: metaWindow })
        : statusBlock(typeof meta.status === 'string' ? meta.status : 'NO_VERIFIED_DATA', 'No ranked symbols for this segment as of the replay clock.',
          typeof meta.detail === 'string' ? meta.detail : 'Requires an ingested market dataset and an active replay session.'),
      more,
      h('details', null, h('summary', null, 'How to read these metrics'), h('ul', { class: 'small note' }, METRIC_NOTES.map((t) => h('li', null, t)))),
      rankingNote(meta));
  }

  const fetchRows = (showLoading) => load('rows', `/api/research/opportunities${api.qs(oppParams({ segment: seg, windowMin, instruments, unsupported }))}`, body, 'Opportunities', (d) => {
    meta = obj(d) || {};
    rows = rowsOf(d);
    draw(); // keeps pageSize, so a clock tick during playback does not collapse the list
  }, { showLoading }).then((res) => {
    // An older API without these options: hide the switch it rejected and show the server default instead.
    let retry = false;
    for (const [k, sw] of [['windowMin', horizonSw], ['instruments', instrSw]]) {
      if (!unsupported[k] && isUnknownParam(res, k)) { unsupported[k] = true; sw.hidden = true; retry = true; }
    }
    if (retry && alive) fetchRows(true);
  });
  fetchRows(false);

  return {
    onStatus(_s, info) { if (info.clockChanged || info.sessionChanged) fetchRows(false); },
    destroy() { alive = false; },
  };
}

// ---------------------------------------------------------------- dossier

/**
 * Dossier subtitle name: the as-of identity name, or the post-dated current-directory name labelled as such
 * (identity.currentDirectory is never as-of evidence), else "Name not verified".
 */
export function dossierName(identity) {
  const i = obj(identity);
  if (typeof i?.name === 'string' && i.name) return i.name;
  const cur = obj(i?.currentDirectory);
  if (typeof cur?.name === 'string' && cur.name) return `${cur.name} (current directory, post-dated)`;
  return 'Name not verified';
}

/** Model status for the lens panel: what to say when the model is not CONNECTED. */
export function modelState(model) {
  const m = obj(model) || {};
  const status = typeof m.status === 'string' ? m.status : 'UNKNOWN';
  const configured = !!m.provider && m.provider !== 'none';
  return { status, configured, connected: status === 'CONNECTED', provider: m.provider ?? null, detail: typeof m.detail === 'string' ? m.detail : null };
}

function dossierView(root, { store }, sym) {
  let alive = true;
  let chart = null;
  const load = makeLoader(() => alive);
  const sub = h('span', null, 'Loading dossier…');
  const chartBody = h('div', null, loading('minute bars'));
  const quoteBody = h('div', null, loading('quote'));
  const lensPanel = h('div', null, loading('assessments'));
  const sections = {
    identity: h('div', null, loading('identity')),
    halts: h('div', null, loading('halts')),
    shortVolume: h('div', null, loading('short volume')),
    filings: h('div', null, loading('filings')),
    financing: h('div', null, loading('financing')),
    leadership: h('div', null, loading('leadership')),
    sector: h('div', null, loading('sector and industry')),
    analystViews: h('div', null, loading('analyst views')),
    media: h('div', null, loading('media')),
  };
  const sectionSig = {};
  const unavailBody = h('div');
  let unavailSig = null;
  const chartMeta = h('span');
  let assessments = null;
  let assessErr = null;
  let lastModelSig = JSON.stringify(store.status?.model ?? null);
  let runPending = null; // {sinceWall, until} while a run may still be in progress on the server
  let serverAssessing = modelActivity(store.status?.model).assess; // status.model.running reports an assessment in flight
  // Cited-evidence disclosures survive lens-panel redraws: open state and fetched results are kept per assessment id.
  const evidenceCache = new Map(); // key -> {status:'loading'|'ok'|'unavailable'|'error', result?, res?}
  const evidenceOpen = new Set();  // disclosure keys the user opened (lens-level and item-level)

  // Stable lens-panel parts: the run controls are built once, so a status poll never wipes an open confirmation.
  const lensBody = h('div');
  const runResult = h('div', { 'aria-live': 'polite' });
  const runBtn = h('button', { type: 'button', class: 'btn btn-primary', disabled: !modelState(store.status?.model).connected }, 'Run three-lens assessment');
  const runArea = h('div', { class: 'stack' });

  root.append(
    pageHeader(sym, {
      sub,
      crumb: h('a', { class: 'crumb', href: '#/research' }, '‹ Research'),
      actions: [h('a', { class: 'btn btn-primary', href: `#/lab?sym=${encodeURIComponent(sym)}` }, 'Paper-trade in Lab')],
    }),
    h('div', { class: 'grid grid-12' },
      card({ title: 'Price & volume · IEX minutes', meta: chartMeta, cls: 'span-8' }, chartBody),
      card({ title: 'Quote as of replay clock', cls: 'span-4' }, quoteBody),
      card({ title: 'Three-lens assessment', cls: 'span-12' },
        h('p', { class: 'note small' }, 'Each lens receives the same time-bounded evidence packet in a separate call; no lens sees another’s output. Disagreement is preserved — there is no averaging or voting. Assessments are model interpretations, not recommendations, and never execute trades.'),
        lensBody, h('div', { class: 'divider' }), h('div', { class: 'btn-row' }, runBtn), lensPanel, runArea, runResult),
      card({ title: 'Identity', cls: 'span-6' }, sections.identity),
      card({ title: 'Halts & trading status', cls: 'span-6' }, sections.halts),
      card({ title: 'Short volume (FINRA Reg SHO)', cls: 'span-6' }, sections.shortVolume,
        h('p', { class: 'small muted' }, 'FINRA daily short-sale volume covers FINRA-reported off-exchange trades only — not consolidated volume, not short interest.')),
      card({ title: 'Filings (SEC EDGAR)', cls: 'span-6' }, sections.filings),
      card({ title: 'Financing & dilution', cls: 'span-6' }, sections.financing),
      card({ title: 'Leadership', cls: 'span-6' }, sections.leadership),
      card({ title: 'Sector & industry', cls: 'span-6' }, sections.sector),
      card({ title: 'Analyst & commentator views', cls: 'span-6' }, sections.analystViews),
      card({ title: 'Media & publications', cls: 'span-12' }, sections.media),
      card({ title: 'Unavailable / not verified', cls: 'span-12' }, unavailBody)));

  const loadBars = () => load('bars', `/api/market/bars${api.qs({ sym })}`, chartBody, 'Minute bars', (d) => {
    chart?.destroy?.();
    chart = null;
    const rows = arr(d?.rows).map((r) => ({ t: num(r?.t), o: num(r?.o), h: num(r?.h), l: num(r?.l), c: num(r?.c), v: num(r?.v), bv: num(r?.bv), sv: num(r?.sv), xv: num(r?.xv) }))
      .filter((r) => isNum(r.t));
    replace(chartMeta, typeof d?.status === 'string' ? badge(d.status) : null);
    if (!rows.length) {
      replace(chartBody, statusBlock(typeof d?.status === 'string' && d.status !== 'HISTORICAL_REAL' ? d.status : 'NO_VERIFIED_DATA',
        `No IEX minute bars for ${sym} as of the replay clock — nothing is plotted.`,
        'Bars appear only for symbols in the ingested dataset, and only once each minute has completed on the replay clock.'));
    } else {
      const host = h('div');
      // Keep the chart's height while it is redrawn so the page does not jump during playback.
      const keep = chartBody.offsetHeight;
      if (keep > 0) chartBody.style.minHeight = `${keep}px`;
      replace(chartBody, h('p', { class: 'note small' }, asOfText(d?.asOf)), host,
        h('p', { class: 'small muted' }, 'Aggressor side is INFERRED by the quote rule against the prevailing IEX BBO (trade ≥ ask = buyer-initiated, ≤ bid = seller-initiated, otherwise unclassified). IEX-only volume; volume alone is not intent.'));
      chart = priceVolumeChart(host, rows, { ariaLabel: `${sym} IEX minute close and volume` });
      chartBody.style.minHeight = '';
    }
    renderQuote(obj(d?.quote), d?.asOf);
  }, {});

  function renderQuote(q, asOf) {
    if (!q) {
      replace(quoteBody, statusBlock('NO_VERIFIED_DATA', `No IEX quote observed for ${sym} as of the replay clock.`, 'The policy gate denies orders without a fresh two-sided quote.'));
      return;
    }
    replace(quoteBody,
      h('div', { class: 'badges' }, q.twoSided ? badge('TWO-SIDED', { tone: 'ok' }) : badge('NOT TWO-SIDED', { tone: 'warn' }),
        q.halted ? badge('HALTED', { tone: 'bad' }) : null, q.extendedSession ? badge('EXTENDED SESSION', { tone: 'warn' }) : null),
      h('div', { class: 'metrics' },
        h('div', { class: 'metric' }, h('div', { class: 'metric-k' }, 'Bid'), h('div', { class: 'metric-v' }, fmtPriceU(num(q.bid))), h('div', { class: 'metric-s' }, `size ${fmtInt(q.bidSize)}`)),
        h('div', { class: 'metric' }, h('div', { class: 'metric-k' }, 'Ask'), h('div', { class: 'metric-v' }, fmtPriceU(num(q.ask))), h('div', { class: 'metric-s' }, `size ${fmtInt(q.askSize)}`)),
        h('div', { class: 'metric' }, h('div', { class: 'metric-k' }, 'Spread'), h('div', { class: 'metric-v' }, fmtBps(q.spreadBps)), h('div', { class: 'metric-s' }, fmtPriceU(num(q.spreadU))))),
      kv({
        'Quote time': isNum(q.quoteTs) ? fmtEt(q.quoteTs, { date: true, seconds: true }) : DASH,
        'Quote age at clock': fmtAge(q.ageMs),
        'Trading status': q.tradingStatus === 'T' ? 'Trading (T)' : q.tradingStatus === 'H' ? 'Halted (H)' : q.tradingStatus === 'P' ? 'Paused (P)' : (q.tradingStatus ?? 'not reported'),
        Venue: obj(q.source)?.venue ? `${obj(q.source).venue} only (not NBBO)` : 'IEX only (not NBBO)',
        Dataset: obj(q.source)?.ds ?? DASH,
      }),
      h('p', { class: 'small muted' }, `IEX top-of-book only (not NBBO). ${asOfText(asOf)}.`));
  }

  const loadDossier = () => load('dossier', `/api/research/dossier${api.qs({ sym })}`, null, 'Dossier', (d) => {
    const o = obj(d) || {};
    const identity = obj(o.identity);
    sub.textContent = [dossierName(identity), asOfText(o.asOf)].join(' · ');
    const names = { identity: 'Identity', halts: 'Halts & trading status', shortVolume: 'Short volume', filings: 'Filings', financing: 'Financing', leadership: 'Leadership',
      sector: 'Sector & industry', analystViews: 'Analyst & commentator views', media: 'Media' };
    // Sections are re-rendered only when their content changed (no flicker, open disclosures stay open while playing).
    for (const [k, el] of Object.entries(sections)) {
      const sig = JSON.stringify(o[k] ?? null);
      if (sig === sectionSig[k]) continue;
      sectionSig[k] = sig;
      replace(el, renderSection(o[k], { what: names[k] }));
    }
    const un = arr(o.unavailable);
    const usig = JSON.stringify(un);
    if (usig !== unavailSig) {
      unavailSig = usig;
      replace(unavailBody, un.length
        ? h('ul', { class: 'kv-list' }, un.map((u) => {
          const x = obj(u);
          return h('li', null, x
            ? h('div', { class: 'stack' }, h('div', { class: 'badges' }, badge(x.status ?? 'UNAVAILABLE_NOT_VERIFIED'), h('strong', null, String(x.field ?? x.section ?? x.name ?? ''))),
              x.reason || x.detail ? h('span', { class: 'small note' }, String(x.reason ?? x.detail)) : null,
              x.setup ? h('span', { class: 'small muted' }, String(x.setup)) : null)
            : h('span', null, badge('UNAVAILABLE_NOT_VERIFIED'), ' ', String(u)));
        }))
        : h('p', { class: 'note' }, 'The API listed no unavailable fields.'));
    }
    if (assessments === null && o.assessments !== undefined) { assessments = o.assessments; drawLenses(); }
  }).then((res) => {
    if (res && !res.ok) {
      sub.textContent = 'Dossier unavailable';
      for (const k of Object.keys(sections)) sectionSig[k] = null;
      unavailSig = null;
      for (const el of Object.values(sections)) replace(el, statusBlock(res.unreachable ? ['NO_VERIFIED_DATA', 'API UNREACHABLE'] : [res.error?.code || 'ERROR'], 'Not loaded.', res.error?.message));
      replace(unavailBody, statusBlock('UNAVAILABLE_NOT_VERIFIED', 'Dossier not loaded.'));
    }
  });

  const loadAssessments = () => load('assess', `/api/assessments${api.qs({ sym })}`, null, 'Assessments', (d) => { assessments = d; assessErr = null; drawLenses(); })
    .then((res) => { if (res && !res.ok) { assessErr = res; if (assessments === null) assessments = { status: res.error?.code }; drawLenses(); } return res; });

  // ---- three-lens panel
  function drawLenses() {
    const ms = modelState(store.status?.model);
    const modelStatus = store.status ? ms.status : 'UNKNOWN';
    const by = normAssessments(assessments);
    const top = obj(assessments);
    const clock = num(store.status?.replay?.clock);
    const sessionId = store.status?.replay?.session_id ?? null;
    const stored = LENSES.map((l) => by[l.id]).filter(Boolean);
    const storedOk = stored.filter((a) => !a.status || a.status === 'OK');
    serverAssessing = modelActivity(store.status?.model).assess;
    runBtn.disabled = !ms.connected || !!runPending || serverAssessing;
    const prevScroll = lensBody.querySelector('.lenses')?.scrollLeft ?? 0;

    preserveFocus(lensBody, () => {
      const carousel = h('div', { class: 'lenses', role: 'group', 'aria-label': 'Three independent risk-lens assessments', tabindex: '0' });
      const tabs = h('div', { class: 'seg full lens-tabs', role: 'group', 'aria-label': 'Jump to lens' });
      const dots = h('div', { class: 'lens-dots', 'aria-hidden': 'true' });
      LENSES.forEach((lens, i) => {
        carousel.append(lensCard(lens, by[lens.id] || null, { modelStatus, ms, top, clock, sessionId, runHasOthers: stored.length > 0, evidence: evidenceBlock }));
        tabs.append(h('button', { type: 'button', 'aria-pressed': String(i === 0), 'data-focus-key': `lens-${lens.id}`, on: { click: () => {
          const cardEl = carousel.children[i];
          carousel.scrollTo({ left: cardEl.offsetLeft - carousel.offsetLeft, behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
        } } }, lens.label));
        dots.append(h('span', { class: i === 0 ? 'on' : null }));
      });
      const syncTabs = () => {
        const first = carousel.children[0];
        if (!first) return;
        const step = first.getBoundingClientRect().width + 10;
        const idx = Math.max(0, Math.min(LENSES.length - 1, Math.round(carousel.scrollLeft / step)));
        [...tabs.children].forEach((b, i) => b.setAttribute('aria-pressed', String(i === idx)));
        [...dots.children].forEach((d, i) => d.classList.toggle('on', i === idx));
      };
      carousel.addEventListener('scroll', syncTabs, { passive: true });

      let banner = null;
      if (!ms.connected && storedOk.length) {
        const oldest = Math.min(...storedOk.map((a) => num(a.as_of)).filter(isNum));
        banner = statusBlock([`MODEL ${modelStatus}`],
          `Showing ${storedOk.length} stored assessment${storedOk.length === 1 ? '' : 's'}${isNum(oldest) ? ` from ${fmtEt(oldest, { date: true })}` : ''}; new runs are disabled until the model is connected.`,
          ms.detail ? `Model detail: ${ms.detail}` : null, { tone: 'warn' });
      } else if (!ms.connected && modelStatus !== 'UNKNOWN') {
        banner = ms.configured
          ? h('div', { class: 'state t-warn' },
            h('div', { class: 'badges' }, badge('MODEL DISCONNECTED / ASSESSMENT NOT RUN', { tone: 'warn' }), badge(modelStatus)),
            h('p', { class: 'detail' }, `The configured provider (${ms.provider}) reports ${modelStatus}${ms.detail ? `: ${ms.detail}` : '.'} Check it with Data sources › Test model connection.`))
          : h('div', { class: 'state t-warn' },
            h('div', { class: 'badges' }, badge('MODEL DISCONNECTED / ASSESSMENT NOT RUN', { tone: 'warn' })),
            h('p', { class: 'detail' }, 'Model-driven assessments are disabled because no model provider is configured. On the server set VECTOR_MODEL_PROVIDER=anthropic with ANTHROPIC_API_KEY (optional VECTOR_ANTHROPIC_MODEL), VECTOR_MODEL_PROVIDER=ollama with VECTOR_OLLAMA_MODEL (native Ollama; VECTOR_OLLAMA_NUM_CTX, default 16384, is sent with every request), or VECTOR_MODEL_PROVIDER=openai-compatible with VECTOR_OPENAI_BASE_URL (and VECTOR_OPENAI_API_KEY if required). Restart the server, then use Data sources › Test model connection. Calls are capped by VECTOR_MAX_MODEL_CALLS_PER_SESSION.'));
      }
      replace(lensBody,
        assessErr ? statusBlock(assessErr.unreachable ? ['API UNREACHABLE'] : [assessErr.error?.code || 'ERROR'], 'Assessments could not be loaded.', assessErr.error?.message) : null,
        banner, tabs, carousel, dots);
      carousel.scrollLeft = prevScroll;
      syncTabs();
    });
    const prog = modelActivity(store.status?.model).assessment;
    const progText = prog && !prog.previousSession && isNum(prog.lensesDone) && isNum(prog.lensesTotal)
      ? `${fmtInt(prog.lensesDone)} of ${fmtInt(prog.lensesTotal)} lenses stored${isNum(prog.elapsedMs) ? ` · ${fmtAge(prog.elapsedMs)} elapsed` : ''}${prog.sym && prog.sym !== sym ? ` · symbol ${prog.sym}` : ''}.`
      : null;
    replace(lensPanel, runPending
      ? statusBlock(['ASSESSMENT RUNNING'], 'The three model calls are running on the server; each lens appears here when it is stored.', progText ?? 'This page checks for new results every few seconds.', { tone: 'warn' })
      : serverAssessing
        ? statusBlock(['ASSESSMENT RUNNING'], 'An assessment run is in progress on the server (reported by the server status); new runs are disabled until it finishes.', progText ?? 'Results for this symbol appear here once they are stored.', { tone: 'warn' })
        : null);
  }

  // ---- cited evidence (GET /api/evidence?ids=, as of the replay clock; graceful when the endpoint is missing)
  const evKey = (a) => String(a?.id ?? `${a?.lens}|${a?.as_of}|${a?.created_wall}`).replace(/[^A-Za-z0-9_|.-]/g, '_');

  function repaintEvidence(key) {
    const host = [...lensBody.querySelectorAll('[data-ev-key]')].find((el) => el.getAttribute('data-ev-key') === key);
    if (host && host._paint) host._paint();
  }

  async function fetchEvidence(key, ids) {
    evidenceCache.set(key, { status: 'loading' });
    repaintEvidence(key);
    const res = await api.get(`/api/evidence${api.qs({ ids: ids.join(',') })}`);
    if (!alive) return;
    if (res.ok) evidenceCache.set(key, { status: 'ok', result: evidenceResult(res.data, ids, { clock: num(store.status?.replay?.clock) }) });
    else evidenceCache.set(key, { status: res.status === 404 ? 'unavailable' : 'error', res });
    repaintEvidence(key);
  }

  function evidenceItem(key, e) {
    const ik = `${key}#${e.id}`;
    const d = h('details', { class: 'ev-item', open: evidenceOpen.has(ik) },
      h('summary', null, `${e.kind ?? 'evidence'} · ${e.title ?? e.id}`),
      h('div', { class: 'stack tight' },
        kv({
          Id: h('span', { class: 'hash' }, String(e.id)),
          Kind: e.kind ?? DASH,
          Provider: e.provider ?? DASH,
          'Event time': isNum(num(e.event_ts)) ? fmtEt(num(e.event_ts), { date: true, seconds: true }) : DASH,
          'Knowable at': isNum(num(e.knowable_ts)) ? fmtEt(num(e.knowable_ts), { date: true, seconds: true }) : DASH,
          Dataset: e.ds ?? DASH,
          Source: e.source_url ?? e.source_id ?? DASH,
        }),
        e.body !== undefined && e.body !== null ? h('div', null, h('h5', { class: 'ev-h' }, 'Body (as stored)'), renderValue(e.body, 'body')) : null));
    d.addEventListener('toggle', () => { if (d.open) evidenceOpen.add(ik); else evidenceOpen.delete(ik); });
    return d;
  }

  function evidenceContent(key, entry, { ids, invalid, notLookedUp }) {
    const extra = [
      invalid.length ? h('p', { class: 'small muted' }, `${fmtInt(invalid.length)} cited reference${invalid.length === 1 ? ' is' : 's are'} not an evidence id: ${invalid.slice(0, 5).join(', ')}`) : null,
      notLookedUp ? h('p', { class: 'small muted' }, `${fmtInt(notLookedUp)} more cited id${notLookedUp === 1 ? '' : 's'} not looked up (at most ${ids.length} per request).`) : null,
    ];
    if (!ids.length) return [h('p', { class: 'small muted' }, 'This lens cited no evidence ids.'), extra];
    if (!entry || entry.status === 'loading') return [loading('cited evidence'), extra];
    if (entry.status === 'unavailable') {
      return [statusBlock(['NOT AVAILABLE'], 'Evidence lookup is not available on this server (GET /api/evidence returned 404).',
        `${entry.res?.error?.message ? `${entry.res.error.message}. ` : ''}The cited ids are listed above; the evidence packet's sha256 is in the card footer.`, { tone: 'warn' }), extra];
    }
    if (entry.status === 'error') {
      return [errorBlock(entry.res, 'Cited evidence'),
        h('button', { type: 'button', class: 'btn btn-ghost', on: { click: () => fetchEvidence(key, ids) } }, 'Retry evidence lookup'), extra];
    }
    const r = entry.result;
    return [
      r.items.length ? h('div', { class: 'ev-list' }, r.items.map((e) => evidenceItem(key, e))) : null,
      r.missing.length ? statusBlock(['NOT RETURNED'], `${fmtInt(r.missing.length)} cited id${r.missing.length === 1 ? ' was' : 's were'} not returned: not stored, or not knowable at the replay clock.`, r.missing.join(', '), { tone: 'warn' }) : null,
      r.withheld.length ? statusBlock(['WITHHELD'], `${fmtInt(r.withheld.length)} item${r.withheld.length === 1 ? '' : 's'} carried a knowable time after the replay clock and ${r.withheld.length === 1 ? 'is' : 'are'} not shown.`, r.withheld.join(', '), { tone: 'warn' }) : null,
      extra,
    ];
  }

  /** Disclosure listing a lens's cited evidence ids; opening it fetches the items (once) as of the replay clock. */
  function evidenceBlock(a, refs) {
    const key = evKey(a);
    const look = evidenceLookupIds(refs);
    const bodyEl = h('div', { class: 'ev-body' });
    const d = h('details', { class: 'evidence', 'data-ev-key': key, open: evidenceOpen.has(key) },
      h('summary', null, `Show cited evidence (${look.ids.length})`), bodyEl);
    d._paint = () => replace(bodyEl, evidenceContent(key, evidenceCache.get(key), look));
    d.addEventListener('toggle', () => {
      if (!d.open) { evidenceOpen.delete(key); return; }
      evidenceOpen.add(key);
      if (look.ids.length && !evidenceCache.has(key)) fetchEvidence(key, look.ids);
    });
    d._paint();
    if (d.open && look.ids.length && !evidenceCache.has(key)) queueMicrotask(() => fetchEvidence(key, look.ids));
    return d;
  }

  runBtn.addEventListener('click', () => {
    const clock = store.status?.replay?.clock;
    replace(runArea, confirmBox({
      title: `Run assessments for ${sym}?`,
      body: h('p', null, `Makes three separate model calls (Cowboy, Pragmatist, Tightwad), each with the same evidence packet knowable at ${isNum(clock) ? fmtEt(clock, { date: true }) : 'the replay clock'}. Provider usage may cost money and is capped server-side. A run can take several minutes.`),
      confirmLabel: 'Run 3 model calls',
      onConfirm: async () => {
        const sinceWall = Date.now();
        replace(runResult, loading('the assessment run'));
        const model = await api.get('/api/model');
        const timeoutMs = api.assessTimeoutMs(model.ok ? obj(model.data)?.limits : null);
        // Preferred: a background run (202 + run id) followed through GET /api/status model.inFlight / lastAssessmentRun.
        let res = await api.post('/api/assessments/run', { sym, confirm: true, async: true });
        if (!alive) return;
        if (isUnknownParam(res, 'async')) {
          // Older API without background runs: wait for the synchronous answer (bounded by the provider timeouts).
          replace(runResult, loading('assessments (three sequential model calls; this can take several minutes)'));
          res = await api.post('/api/assessments/run', { sym, confirm: true }, { timeoutMs });
          if (!alive) return;
        }
        replace(runArea);
        const runId = res.ok && res.status === 202 && typeof obj(res.data)?.run_id === 'string' ? res.data.run_id : null;
        if (runId) {
          replace(runResult, null);
          announce(`Assessment run for ${sym} started on the server.`);
          pollForRun(sinceWall, timeoutMs, runId);
          return;
        }
        if (res.timedOut || res.error?.code === 'ASSESSMENT_BUSY') {
          // The server keeps working after the browser stops waiting: show it as running and poll for the stored rows.
          replace(runResult, decisionResult(res));
          announce('The assessment run is still in progress on the server.');
          pollForRun(sinceWall, timeoutMs);
          return;
        }
        replace(runResult, decisionResult(res));
        announce(res.ok ? `Assessments for ${sym} finished.` : `Assessment run failed: ${res.error?.message || ''}`);
        loadAssessments();
      },
      onCancel: () => replace(runArea),
    }));
  });

  /** The server's recorded outcome of a run (model.lastAssessmentRun), as a status block. */
  function runOutcomeBlock(last) {
    if (last.status === 'COMPLETED') {
      const ls = obj(last.lensStatuses) || {};
      const kinds = obj(last.lensErrorKinds) || {};
      const entries = Object.entries(ls);
      const okCount = entries.filter(([, v]) => v === 'OK').length;
      // OK only when every lens produced a valid result; NOT_RUN lenses were never called (not a model answer).
      const lensText = (k, v) => (kinds[k] === 'NOT_RUN' ? `${k} not called` : `${k} ${v}${kinds[k] && kinds[k] !== v ? ` (${kinds[k]})` : ''}`);
      if (entries.length && okCount === entries.length) return statusBlock(['OK'], `Assessments for ${sym} finished on the server.`, null, { tone: 'ok' });
      const label = okCount === 0 ? 'NO OUTPUT' : 'LENS ERRORS';
      return statusBlock([label], okCount === 0 ? `The run for ${sym} finished without a valid lens result.` : `The run for ${sym} finished; some lenses did not produce a valid result.`,
        entries.length ? `Lens results: ${entries.map(([k, v]) => lensText(k, v)).join(', ')}.` : null, { tone: okCount === 0 ? 'bad' : 'warn' });
    }
    return statusBlock([String(last.code || last.status || 'ASSESSMENT_NOT_RUN')], 'The assessment run did not complete.',
      typeof last.detail === 'string' ? last.detail : null, { tone: last.status === 'ERROR' ? 'bad' : 'warn' });
  }

  /**
   * Follow a run until the server reports its outcome (runId: model.lastAssessmentRun.run_id), rows created after the
   * click exist for all three lenses, the server's running flag clears, or a bounded deadline passes.
   */
  async function pollForRun(sinceWall, timeoutMs, runId = null) {
    runPending = { sinceWall, until: Date.now() + Math.max(timeoutMs, 60000), runId };
    drawLenses();
    let sawRunning = false;
    let outcome = null;
    while (alive && runPending && Date.now() < runPending.until) {
      await new Promise((r) => setTimeout(r, ASSESS_POLL_MS));
      if (!alive) return;
      await refreshStatus(); // model.running / inFlight progress / lastAssessmentRun
      if (!alive) return;
      const res = await loadAssessments();
      const act = modelActivity(store.status?.model);
      if (runId && act.last?.run_id === runId && !(act.assessment?.runId === runId)) { outcome = act.last; break; }
      const by = normAssessments(assessments);
      if (res?.ok && LENSES.every((l) => num(by[l.id]?.created_wall) >= sinceWall) && !act.assess) break;
      if (act.assess) sawRunning = true;
      else if (sawRunning) { await loadAssessments(); break; }
    }
    if (!alive) return;
    const done = LENSES.every((l) => num(normAssessments(assessments)[l.id]?.created_wall) >= sinceWall);
    runPending = null;
    replace(runResult, outcome ? runOutcomeBlock(outcome) : done
      ? statusBlock(['OK'], `Assessments for ${sym} finished on the server.`, null, { tone: 'ok' })
      : statusBlock(['NOT CONFIRMED'], 'No complete set of new assessments appeared in time.', 'Check the Journal (MODEL_ASSESSMENT) before running again — each run makes three model calls.', { tone: 'warn' }));
    announce(outcome ? (outcome.status === 'COMPLETED' ? `Assessments for ${sym} finished.` : `Assessment run did not complete: ${outcome.code ?? outcome.status}.`)
      : done ? `Assessments for ${sym} finished.` : 'Assessment results were not confirmed.');
    drawLenses();
  }

  loadBars();
  loadDossier();
  loadAssessments();

  return {
    onStatus(st, info) {
      if (info.clockChanged || info.sessionChanged) { loadBars(); loadDossier(); }
      const msig = JSON.stringify(st.status?.model ?? null);
      const wasAssessing = serverAssessing;
      const nowAssessing = modelActivity(st.status?.model).assess;
      if (info.sessionChanged) { evidenceCache.clear(); evidenceOpen.clear(); }
      if (info.sessionChanged || info.firstLoad || (wasAssessing && !nowAssessing)) loadAssessments(); // a server-side run just ended
      else if ((msig !== lastModelSig || info.clockChanged) && assessments !== null) drawLenses(); // model status / staleness badges
      lastModelSig = msig;
    },
    destroy() { alive = false; chart?.destroy?.(); },
  };
}

/** Run identity of a stored assessment: the three lenses of one run share the evidence packet and as-of time. */
export const runKeyOf = (a) => `${a?.packet_sha256 ?? ''}|${num(a?.as_of) ?? ''}`;

/**
 * Assessments per lens from ONE run — the run of the newest stored row — so lenses of different runs (different
 * packets or as-of times) are never shown side by side. Accepts [...rows], {rows|assessments:[...]}, {cowboy:{...}, ...}.
 */
export function normAssessments(x) {
  let list = [];
  if (Array.isArray(x)) list = x;
  else if (obj(x)) {
    if (Array.isArray(x.rows)) list = x.rows;
    else if (Array.isArray(x.assessments)) list = x.assessments;
    else list = LENSES.map((l) => (obj(x[l.id]) ? { lens: l.id, ...x[l.id] } : null)).filter(Boolean);
  }
  const rows = [];
  for (const a of list) {
    const o = obj(a);
    if (!o) continue;
    const output = obj(o.output) || obj(parseMaybeJson(o.output_json));
    const lens = o.lens ?? output?.lens;
    if (!LENSES.some((l) => l.id === lens)) continue;
    rows.push({ ...o, lens, output, _ts: num(o.created_wall) ?? num(o.as_of) ?? 0, _run: runKeyOf(o) });
  }
  let newest = null;
  for (const r of rows) if (!newest || r._ts > newest._ts) newest = r;
  const by = {};
  for (const r of rows) {
    if (r._run !== newest._run) continue;
    if (!by[r.lens] || r._ts >= by[r.lens]._ts) by[r.lens] = r;
  }
  return by;
}

const STANCE_TONE = { consider_entry: 'copper', watch: 'neutral', avoid: 'bad', insufficient_evidence: 'warn' };

function blk(title, content, extra) {
  return h('div', { class: 'blk' }, h('h4', null, title, extra ? [' ', extra] : null), content);
}

/** Audit badges + explanations recorded with a stored assessment (shown only when the server recorded them). */
function auditBlock(a) {
  const au = assessmentAudit(a);
  const v = au.verification;
  const unverified = v && (v.unmatched.length || v.flags.length);
  const badges = [
    au.hindsight ? badge('HINDSIGHT RISK', { tone: 'bad', solid: true, title: 'The model may remember what happened after the replay date' }) : null,
    au.fallback ? badge('SERVED BY FALLBACK', { tone: 'warn', title: `Requested ${au.fallback.requested ?? 'unknown'}; served ${au.fallback.served ?? 'unknown'}` }) : null,
    au.draft ? badge(au.draft.status === 'VALID' ? 'DRAFT VALID' : 'DRAFT INVALID', { tone: au.draft.status === 'VALID' ? 'ok' : 'bad', title: 'Proposed intent checked like an agent intent; proposal only, never executed' }) : null,
    unverified ? badge('NUMBERS UNVERIFIED', { tone: 'warn', title: 'Some numbers in the model text match no value in the evidence packet' }) : null,
  ].filter(Boolean);
  if (!badges.length) return { badges: null, notes: null, au };
  const hs = au.hindsight;
  const notes = [
    hs ? h('p', { class: 'small warn-text' }, `Hindsight risk${hs.code ? ` (${hs.code})` : ''}: model training cutoff ${hs.cutoff ?? 'unknown'}${hs.source ? ` (${hs.source})` : ''}`
      + `${hs.tradeDate ? ` vs replay date ${hs.tradeDate}` : ''}. The model may remember what happened next, so this is not an as-of judgement.`) : null,
    au.fallback ? h('p', { class: 'small note' }, `Served by a fallback model: requested ${au.fallback.requested ?? 'unknown'}, served ${au.fallback.served ?? 'unknown'}.`) : null,
  ].filter(Boolean);
  return { badges: h('div', { class: 'badges' }, badges), notes: notes.length ? h('div', { class: 'audit-notes' }, notes) : null, au };
}

function draftBlock(au) {
  const d = au.draft;
  if (!d) return null;
  return h('div', { class: 'stack tight' },
    h('p', { class: 'small note' }, d.status === 'VALID'
      ? 'Draft verdict: VALID — the proposal passes the same intent validation as an agent intent. Proposal only, not executed.'
      : 'Draft verdict: INVALID — the proposal fails intent validation. Proposal only, not executed.'),
    d.errors.length ? h('ul', { class: 'small' }, d.errors.slice(0, 12).map((e) => h('li', { class: 'mono' }, e))) : null,
    d.intent ? h('details', null, h('summary', null, d.status === 'VALID' ? 'Validated draft intent (proposal only, not executed)' : 'Draft intent as checked (proposal only, not executed)'), kv(d.intent)) : null);
}

function verificationBlock(v) {
  if (!v) return null;
  const n = v.unmatched.length;
  return h('details', null,
    h('summary', null, `Number cross-check: ${n ? `${fmtInt(n)} unmatched` : 'all matched'}${isNum(v.numbersChecked) ? ` (${fmtInt(v.numbersChecked)} checked)` : ''}${v.flags.length ? ` · ${fmtInt(v.flags.length)} flag${v.flags.length === 1 ? '' : 's'}` : ''}`),
    h('div', { class: 'stack tight' },
      h('p', { class: 'small muted' }, 'Model text, numbers unverified: values below appear in the text but match no value in the evidence packet (numbers the model derived itself also appear). A consistency aid, not a fact check.'),
      v.flags.length ? h('ul', { class: 'small' }, v.flags.map((f) => h('li', null, f))) : null,
      n ? h('ul', { class: 'small' }, v.unmatched.slice(0, 20).map((x) => h('li', null, `${x.field ? `${x.field}: ` : ''}${x.value}`))) : null));
}

function lensCard(lens, a, { modelStatus, ms, top, clock, sessionId, runHasOthers, evidence }) {
  const id = nextId('lens');
  const el = h('article', { class: 'lens', 'data-lens': lens.id, 'aria-labelledby': id },
    h('div', null, h('h3', { id }, lens.label), h('div', { class: 'lens-sub' }, `${lens.sub} lens`)));
  // Native append() would stringify null children as "null": drop them.
  const add = (...xs) => el.append(...xs.flat().filter(Boolean));
  if (!a) {
    const topStatus = typeof top?.status === 'string' && top.status !== 'STORED' ? top.status : null;
    let detail = 'No model provider is configured on the server; no assessment exists for this lens.';
    if (modelStatus === 'UNKNOWN') detail = 'Model status unknown (API unreachable).';
    else if (ms.configured) detail = `The configured provider (${ms.provider}) reports ${modelStatus}${ms.detail ? `: ${ms.detail}` : ''}. No assessment exists for this lens yet.`;
    if (runHasOthers) {
      add(statusBlock('ASSESSMENT_NOT_RUN', 'No result for this lens in the latest run.', 'Lenses are shown from one run only (same evidence packet and as-of time); this lens has no stored row in it.'));
      return el;
    }
    add(!ms.connected
      ? statusBlock(['MODEL_DISCONNECTED', 'ASSESSMENT_NOT_RUN'], 'MODEL DISCONNECTED / ASSESSMENT NOT RUN', detail)
      : statusBlock(topStatus || 'ASSESSMENT_NOT_RUN', 'No assessment has been run for this symbol in this session.', 'Use “Run three-lens assessment” below.'));
    return el;
  }
  const age = assessmentAge(a.as_of, clock);
  const otherSession = sessionId && a.session_id && a.session_id !== sessionId;
  add(h('div', { class: 'badges' },
    badge(`AS OF ${isNum(num(a.as_of)) ? fmtEt(num(a.as_of)) : DASH}`, { tone: age.stale ? 'warn' : 'neutral', title: 'Replay time of the evidence packet' }),
    h('span', { class: ['small', age.stale ? 'warn-text' : 'muted'] }, age.text),
    otherSession ? badge('OTHER SESSION', { tone: 'warn' }) : null));
  const audit = auditBlock(a);
  add(audit.badges, audit.notes);
  if (a.status && a.status !== 'OK') {
    const kind = typeof obj(a.audit)?.error_kind === 'string' ? a.audit.error_kind : typeof a.errorKind === 'string' ? a.errorKind : null;
    add(kind === 'NOT_RUN'
      ? statusBlock(['NOT CALLED'], `The ${lens.label} lens was not called in this run.`, a.error ? String(a.error) : null, { tone: 'warn' })
      : statusBlock([a.status, kind && kind !== a.status ? kind : null], `The ${lens.label} assessment did not produce a valid result.`, a.error ? String(a.error) : null));
  } else {
    const o = a.output || {};
    const conf = obj(o.confidence) || {};
    const listOf = (xs, mono) => (arr(xs).length ? h('ul', null, arr(xs).map((x) => h('li', { class: mono ? 'mono' : null }, typeof x === 'string' ? x : JSON.stringify(x)))) : h('p', { class: 'muted' }, 'none listed'));
    const refs = arr(o.evidence_refs);
    add(
      h('div', { class: 'badges' }, badge(String(o.stance ?? 'NO STANCE').toUpperCase().replace(/_/g, ' '), { tone: STANCE_TONE[o.stance] || 'neutral' }),
        badge(`Confidence ${String(conf.level ?? 'n/a')}`, { tone: 'neutral' })),
      blk('Thesis', h('p', null, String(o.thesis ?? 'not provided'))),
      blk('Counter-thesis', h('p', null, String(o.counter_thesis ?? 'not provided'))),
      o.exposure ? blk('Exposure', h('p', null, String(o.exposure))) : null,
      o.liquidity_and_spread ? blk('Liquidity & spread', h('p', null, String(o.liquidity_and_spread))) : null,
      blk('Unknowns', listOf(o.unknowns)),
      blk(`Evidence refs (${refs.length})`, h('div', null, listOf(refs, true),
        refs.length ? h('p', { class: 'small muted' }, 'Ids of items in the as-of evidence packet (its sha256 is in the footer).') : null,
        refs.length && evidence ? evidence(a, refs) : null)),
      verificationBlock(audit.au.verification),
      blk('Confidence calibration', h('p', null, String(conf.calibration_note ?? 'not provided'))),
      blk('Proposed intent', obj(o.proposed_intent)
        ? h('div', { class: 'stack tight' }, h('p', { class: 'small note' }, 'Proposal only — not executed.'), kv(o.proposed_intent), draftBlock(audit.au))
        : h('p', { class: 'muted' }, 'none — no trade proposed'),
        obj(o.proposed_intent) && age.stale ? badge(`STALE — PRICES FROM ${fmtEt(num(a.as_of))}`, { tone: 'warn' }) : null));
  }
  add(h('div', { class: 'lens-foot' },
    [`Provider ${a.provider ?? DASH}`, `model ${a.model ?? DASH}`, `as of ${isNum(num(a.as_of)) ? fmtEt(num(a.as_of), { date: true }) : DASH}`,
      a.packet_sha256 ? `packet ${shortHash(a.packet_sha256)}` : null, isNum(num(a.latency_ms)) ? `${fmtInt(a.latency_ms)} ms` : null,
      arr(parseMaybeJson(a.evidence_ids_json) ?? a.evidence_ids).length ? `${arr(parseMaybeJson(a.evidence_ids_json) ?? a.evidence_ids).length} evidence items` : null]
      .filter(Boolean).join(' · ')));
  return el;
}
