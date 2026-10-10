// #/sources — every data source with status, coverage, entitlement, attribution, last event time, sha256 and setup;
// system/model/options status; server-side setup instructions; CSV import with a provenance manifest.
import { h, replace, announce } from '../dom.js';
import * as api from '../api.js';
import { card, pageHeader, statusBlock, loading, badge, kv, renderValue, field, select, confirmBox, decisionResult } from '../components.js';
import { refreshStatus } from '../store.js';
import { rowsOf, makeLoader } from './common.js';
import { modelSettings } from './model-settings.js';
import { obj, num, isNum, fmtEt, fmtInt, DASH } from '../format.js';

const IEX_ATTRIBUTION_NOTE = 'IEX historical data, wherever shown in VECTOR, is attributed as required by the IEX Historical Data Terms of Use. The attribution text recorded at ingestion is shown on each IEX source below.';
const IEX_TERMS_URL = 'https://www.iex.io/legal/hist-data-terms';
const MAX_CSV_BYTES = 56 * 1024; // API bodies are limited to 64 KB including the manifest

const code = (t) => h('code', null, t);

const SETUP = [
  {
    title: 'Historical market data — IEX HIST (TOPS)',
    items: [
      ['Ingest one trade date (streams the official multi-GB file and records sha256 + quality checks):', code('npm run ingest:iex -- --date YYYY-MM-DD')],
      ['Shown as HISTORICAL_REAL. Coverage is IEX only: IEX BBO is not the NBBO and IEX volume is a fraction of U.S. volume.', null],
    ],
  },
  {
    title: 'SEC EDGAR filings — SEC_USER_AGENT',
    items: [
      ['The SEC requires a declared User-Agent with contact details. Set it in the server environment, then ingest:', code('SEC_USER_AGENT="Your Name your-email@example.com"')],
      ['', code('npm run ingest:sec')],
      ['Filings are knowable from their EDGAR acceptance time; later amendments never appear before they were filed.', null],
    ],
  },
  {
    title: 'Macro, short volume, symbol directory',
    items: [
      ['FRED macro series (visible only after their publication lag):', code('npm run ingest:fred')],
      ['FINRA Reg SHO daily short-sale volume:', code('npm run ingest:finra')],
      ['Nasdaq Trader symbol directory (issuer names, test-issue flags):', code('npm run ingest:symdir')],
    ],
  },
  {
    title: 'Real-time / delayed feeds — Alpaca, Polygon keys',
    items: [
      ['Keys belong only in the server environment, never in the browser. Alpaca:', code('ALPACA_API_KEY_ID=…  ALPACA_API_SECRET_KEY=…')],
      ['Polygon:', code('POLYGON_API_KEY=…')],
      ['A feed is labelled LIVE_VERIFIED or DELAYED_REAL only when its adapter appears in the source list above with provider, entitlement/latency and the last actual quote time. If no such source is listed, this build has no active real-time adapter and nothing is presented as live.', null],
    ],
  },
  {
    title: 'Model provider (three-lens assessments, model decision modes)',
    items: [
      ['Choose a provider (default none = MODEL DISCONNECTED):', code('VECTOR_MODEL_PROVIDER=anthropic | openai-compatible | ollama | none')],
      ['Anthropic:', code('ANTHROPIC_API_KEY=…   VECTOR_ANTHROPIC_MODEL=claude-opus-5-5')],
      ['Ollama, native API (recommended for local models; num_ctx is sent with every request; VECTOR_OLLAMA_BASE_URL defaults to the local Ollama server on port 11434):', code('VECTOR_MODEL_PROVIDER=ollama   VECTOR_OLLAMA_MODEL=…   VECTOR_OLLAMA_NUM_CTX=16384')],
      ['OpenAI-compatible (OpenAI, LM Studio, or Ollama’s /v1 route — which uses the Ollama server’s own context, 4096 tokens unless OLLAMA_CONTEXT_LENGTH is raised):', code('VECTOR_OPENAI_BASE_URL=http://127.0.0.1:11434/v1   VECTOR_OPENAI_API_KEY=… (optional for local)')],
      ['Or a named preset (config/model-presets.json; choose per lens below in “Model presets”). Local presets are the default and cost nothing; free API presets need their key in the server environment:', code('VECTOR_MODEL_PRESET=ollama-local   VECTOR_MODEL_PRESET_MODEL=qwen3:8b')],
      ['Free API keys (server environment only):', code('VECTOR_GROQ_API_KEY=…   VECTOR_OPENROUTER_API_KEY=…   VECTOR_GEMINI_API_KEY=…')],
      ['Paid presets are refused unless the server sets:', code('VECTOR_ALLOW_PAID=1')],
      ['Cost cap per replay session:', code('VECTOR_MAX_MODEL_CALLS_PER_SESSION=60')],
      ['Restart the server after changing the environment, then use “Test model connection”. No call is made without that explicit action or an assessment run.', null],
    ],
  },
  {
    title: 'Segments',
    items: [
      ['Large-cap reference list (membership is a configured assumption, not a verified market-cap screen):', code('VECTOR_LARGECAP_LIST=SYM1,SYM2,…')],
    ],
  },
];

export function render(root, { store }) {
  let alive = true;
  const load = makeLoader(() => alive);
  const sysBody = h('div');
  const sysNote = h('div');
  const modelExtra = h('div');
  // The model-test controls are built once: status polls redraw only the metrics, so an open confirmation and a test
  // result survive refreshes.
  const testBtn = h('button', { type: 'button', class: 'btn', disabled: true }, 'Test model connection…');
  const testArea = h('div');
  const testOut = h('div', { role: 'status', 'aria-live': 'polite' });
  testBtn.addEventListener('click', () => {
    const m = obj(store.status?.model) || {};
    replace(testArea, confirmBox({
      title: 'Send a test request to the configured model?',
      body: h('p', { class: 'small' }, `Provider ${m.provider ?? 'unknown'}${m.model ? ` · ${m.model}` : ''}. Sends one small request; the provider may bill for it. The server waits up to 30 s for the answer.`),
      confirmLabel: 'Send test request',
      onConfirm: async () => {
        replace(testOut, loading('model test (up to 30 s)'));
        const res = await api.post('/api/model/test', { confirm: true }, { timeoutMs: api.MODEL_TEST_TIMEOUT_MS });
        if (!alive) return;
        replace(testArea); replace(testOut, decisionResult(res));
        announce(res.ok ? `Model test finished: ${res.data?.decision ?? 'done'}.` : `Model test failed: ${res.error?.message ?? ''}`);
        refreshStatus();
      },
      onCancel: () => replace(testArea),
    }));
  });
  const listBody = h('div', null, loading('data sources'));

  root.append(
    pageHeader('Data sources', { sub: 'Provenance for everything VECTOR shows. No source, no data — missing feeds are reported, never simulated.' }),
    h('div', { class: 'grid grid-12' },
      card({ title: 'System status', cls: 'span-12' }, sysBody, h('div', { class: 'btn-row' }, testBtn), sysNote, testArea, testOut, modelExtra),
      card({ title: 'Model presets (per lens)', cls: 'span-12' }, modelSettings()),
      card({ title: 'Registered sources', cls: 'span-12' }, listBody),
      card({ title: 'Required attribution', cls: 'span-6' },
        h('p', { class: 'note' }, IEX_ATTRIBUTION_NOTE),
        h('p', { class: 'small' }, h('a', { class: 'tap', href: IEX_TERMS_URL, target: '_blank', rel: 'noopener noreferrer' }, 'IEX Historical Data Terms of Use'))),
      card({ title: 'Connect real data (server-side setup)', cls: 'span-6' }, setupBlock()),
      card({ title: 'Import historical CSV with manifest', cls: 'span-12' }, csvImport())));

  function drawSystem() {
    const st = store.status;
    if (!st) {
      testBtn.disabled = true;
      replace(sysNote);
      replace(sysBody, statusBlock(['NO_VERIFIED_DATA', 'API UNREACHABLE'], 'The VECTOR API is not responding, so no source can be verified.',
        `Start the local server with npm start and reload.${store.error?.message ? ` (${store.error.message})` : ''}`, { tone: 'bad' }));
      return;
    }
    const app = obj(st.app) || {};
    const m = obj(st.model) || {};
    const live = obj(st.data?.live) || {};
    const opt = obj(st.options) || {};
    const providerConfigured = !!m.provider && m.provider !== 'none';
    testBtn.disabled = !providerConfigured;
    replace(sysNote, providerConfigured ? null : h('p', { class: 'small muted' }, 'No model provider configured — see “Model provider” setup below. Testing is disabled until one is set.'));
    replace(sysBody,
      h('div', { class: 'metrics' },
        h('div', { class: 'metric' }, h('div', { class: 'metric-k' }, 'Data mode'), h('div', { class: 'metric-v' }, badge(st.data?.mode ?? 'NO_VERIFIED_DATA')), h('div', { class: 'metric-s' }, live.detail ? String(live.detail) : 'replay of stored historical data')),
        h('div', { class: 'metric' }, h('div', { class: 'metric-k' }, 'Live feed'), h('div', { class: 'metric-v' }, badge(live.status ?? 'NO_VERIFIED_DATA')), h('div', { class: 'metric-s' }, 'live only when an entitled feed reports it')),
        h('div', { class: 'metric' }, h('div', { class: 'metric-k' }, 'Model'), h('div', { class: 'metric-v' }, badge(m.status ?? 'DISCONNECTED')), h('div', { class: 'metric-s' }, [m.provider, m.model].filter(Boolean).join(' · ') || 'no provider configured')),
        h('div', { class: 'metric' }, h('div', { class: 'metric-k' }, 'Options'), h('div', { class: 'metric-v' }, badge(opt.status ?? 'NO_VERIFIED_OPTIONS_DATA')), h('div', { class: 'metric-s' }, opt.detail ? String(opt.detail) : 'long puts need a verified options provider')),
        h('div', { class: 'metric' }, h('div', { class: 'metric-k' }, 'Trading'), h('div', { class: 'metric-v' }, badge('PAPER ONLY', { tone: 'copper' })), h('div', { class: 'metric-s' }, `live broker: ${app.liveBroker ?? 'none'}`)),
        h('div', { class: 'metric' }, h('div', { class: 'metric-k' }, 'App'), h('div', { class: 'metric-v' }, String(app.name ?? 'VECTOR')), h('div', { class: 'metric-s' }, [app.brand, app.version ? `v${app.version}` : null].filter(Boolean).join(' · ') || DASH))),
      m.detail ? h('p', { class: 'small note' }, `Model detail: ${m.detail}`) : null);
  }

  const loadModel = () => load('model', '/api/model', null, 'Model details', (d) => {
    const o = obj(d);
    replace(modelExtra, o && Object.keys(o).length ? h('details', null, h('summary', null, 'Model provider details'), kv(o)) : null);
  });

  const loadSources = () => load('sources', '/api/sources', listBody, 'Data sources', (d) => {
    const rows = rowsOf(d, 'sources');
    if (!rows.length) {
      replace(listBody, statusBlock('NO_VERIFIED_DATA', 'No data sources are registered on the server.', 'Use the setup instructions below to ingest real data. Nothing is shown until a source exists.'));
      return;
    }
    replace(listBody, h('div', { class: 'grid grid-12' }, rows.map((r) => sourceCard(obj(r) || {}))));
  });

  drawSystem();
  loadSources();
  loadModel();

  return {
    onStatus(_s, info) { drawSystem(); if (info.firstLoad || info.sessionChanged) { loadSources(); loadModel(); } },
    destroy() { alive = false; },
  };
}

function sourceCard(r) {
  const setup = r.setup;
  return card({ title: String(r.name ?? r.id ?? 'Source'), big: true, cls: 'span-6 raised', actions: badge(r.status ?? 'UNKNOWN') },
    kv({
      ID: r.id ?? DASH,
      Kind: r.kind ?? DASH,
      Provider: r.provider ?? DASH,
      Coverage: r.coverage ?? 'not stated',
      Entitlement: r.entitlement ?? 'not stated',
      'Last event (ET)': isNum(num(r.last_event_ts)) ? fmtEt(num(r.last_event_ts), { date: true, seconds: true }) : 'none recorded',
      Ingested: isNum(num(r.ingested_at)) ? fmtEt(num(r.ingested_at), { date: true, seconds: true }) : 'not ingested',
      Rows: isNum(num(r.rows)) ? fmtInt(num(r.rows)) : DASH,
      SHA256: r.sha256 ? h('span', { class: 'hash' }, String(r.sha256)) : 'not recorded',
    }),
    r.attribution ? h('div', { class: 'state' }, h('div', { class: 'badges' }, badge('ATTRIBUTION', { tone: 'copper' })), h('p', { class: 'detail' }, String(r.attribution))) : null,
    setup ? h('details', null, h('summary', null, 'Setup'), typeof setup === 'string' ? h('p', { class: 'small' }, setup) : renderValue(setup, 'setup')) : null,
    r.notes ? h('p', { class: 'small muted' }, String(r.notes)) : null);
}

function setupBlock() {
  return h('div', { class: 'stack' }, SETUP.map((s) => h('details', null, h('summary', null, s.title),
    h('ul', { class: 'small note' }, s.items.map(([t, c]) => h('li', null, t, c ? h('div', null, c) : null))))),
  h('p', { class: 'small muted' }, 'Secrets are read only from the server environment and are never sent to the browser.'));
}

function csvImport() {
  const fileIn = h('input', { type: 'file', accept: '.csv,text/csv' });
  // Manifest fields follow server/data/ingest/csv-import.js (validateManifest): provenance + column mapping.
  const inputs = {
    provider: h('input', { type: 'text', required: true }),
    source_url: h('input', { type: 'url', required: true, inputmode: 'url' }),
    licence: h('input', { type: 'text', required: true }),
    retrieved_at: h('input', { type: 'text', required: true, spellcheck: 'false', placeholder: 'YYYY-MM-DDTHH:MM:SSZ' }),
    symbol: h('input', { type: 'text', required: true, autocapitalize: 'characters', maxlength: '10', spellcheck: 'false' }),
    adjustments: h('input', { type: 'text' }),
    notes: h('textarea', { maxlength: '1000' }),
  };
  const cols = Object.fromEntries(['time', 'open', 'high', 'low', 'close', 'volume', 'trades', 'vwap']
    .map((k) => [k, h('input', { type: 'text', spellcheck: 'false', value: ['trades', 'vwap'].includes(k) ? '' : k })]));
  const tz = select([['America/New_York', 'America/New_York (ET)'], ['UTC', 'UTC']], 'America/New_York');
  const semantics = select([['bar_start', 'Timestamp = bar start'], ['bar_end', 'Timestamp = bar end']], 'bar_start');
  const interval = select([['1m', 'Minute bars'], ['1d', 'Daily bars']], '1m');
  const preview = h('div');
  const err = h('div', { class: 'err', role: 'alert' });
  const area = h('div');
  const out = h('div', { role: 'status', 'aria-live': 'polite' });
  let csvText = null;
  let fileName = null;

  fileIn.addEventListener('change', async () => {
    csvText = null; fileName = null; replace(preview); err.textContent = '';
    const f = fileIn.files && fileIn.files[0];
    if (!f) return;
    if (f.size > MAX_CSV_BYTES) { err.textContent = `File is ${fmtInt(f.size)} bytes; the import endpoint accepts at most ${fmtInt(MAX_CSV_BYTES)} bytes per request.`; return; }
    csvText = await f.text();
    fileName = f.name;
    const lines = csvText.split(/\r?\n/).filter(Boolean);
    replace(preview, h('p', { class: 'small note' }, `${f.name} · ${fmtInt(f.size)} bytes · ${fmtInt(lines.length)} lines. First lines (your file, unverified):`),
      h('pre', { class: 'payload' }, lines.slice(0, 5).join('\n')));
  });

  const form = h('form', { class: 'stack', novalidate: true },
    statusBlock('IMPORTED_UNVERIFIED', 'Upload alone does not establish authenticity.',
      'Imports must contain actual historical records with a documented provider and original timestamps. They are labelled IMPORTED_UNVERIFIED until server-side integrity and quality checks pass, and never displayed as HISTORICAL_REAL or live.'),
    h('div', { class: 'form-grid two' },
      field('CSV file', fileIn, { hint: `Max ${Math.round(MAX_CSV_BYTES / 1024)} KB per request.` }),
      field('Provider (who produced the records)', inputs.provider),
      field('Source URL (original provider)', inputs.source_url),
      field('Licence / entitlement', inputs.licence),
      field('Retrieved at (ISO-8601 with UTC offset)', inputs.retrieved_at, { hint: 'When you downloaded the file; bars knowable after this are rejected.' }),
      field('Symbol (one per file)', inputs.symbol),
      field('Bar interval', interval),
      field('Timestamp timezone', tz),
      field('Timestamp meaning', semantics),
      field('Adjustments (optional)', inputs.adjustments, { hint: 'e.g. raw unadjusted, split-adjusted' })),
    h('fieldset', null, h('legend', null, 'CSV column names'),
      h('div', { class: 'form-grid two' },
        field('Time column', cols.time), field('Open column', cols.open), field('High column', cols.high), field('Low column', cols.low),
        field('Close column', cols.close), field('Volume column', cols.volume),
        field('Trade count column (optional)', cols.trades), field('VWAP column (optional)', cols.vwap))),
    h('div', { class: 'wide' }, field('Notes', inputs.notes)),
    preview, err,
    h('div', { class: 'btn-row' }, h('button', { type: 'submit', class: 'btn' }, 'Review import…')),
    area, out);

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const problems = [];
    if (!csvText) problems.push('Choose a CSV file.');
    if (!inputs.provider.value.trim()) problems.push('Provider is required.');
    if (!inputs.source_url.value.trim()) problems.push('Source URL or identifier is required.');
    if (!inputs.licence.value.trim()) problems.push('Licence / entitlement is required.');
    const retrieved = inputs.retrieved_at.value.trim();
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/.test(retrieved)) problems.push('Retrieved at must be ISO-8601 with a UTC offset, e.g. 2026-10-08T21:00:00Z.');
    const sym = inputs.symbol.value.trim().toUpperCase();
    if (!/^[A-Z][A-Z0-9.\-]{0,9}$/.test(sym)) problems.push('Symbol must be an uppercase ticker.');
    for (const k of ['time', 'open', 'high', 'low', 'close', 'volume']) if (!cols[k].value.trim()) problems.push(`The ${k} column name is required.`);
    err.textContent = problems.join(' ');
    if (problems.length) return;
    const fields = Object.fromEntries(Object.entries(cols).map(([k, el]) => [k, el.value.trim()]).filter(([, v]) => v));
    const manifest = {
      provider: inputs.provider.value.trim(), source_url: inputs.source_url.value.trim(), licence: inputs.licence.value.trim(),
      retrieved_at: retrieved, timezone: tz.value, timestamp_semantics: semantics.value, interval: interval.value, symbol: sym, fields,
      ...(inputs.adjustments.value.trim() ? { adjustments: inputs.adjustments.value.trim() } : {}),
      ...(inputs.notes.value.trim() ? { notes: `${inputs.notes.value.trim()} (file: ${fileName})` } : { notes: `file: ${fileName}` }),
    };
    replace(area, confirmBox({
      title: 'Submit this file for import?',
      body: h('p', { class: 'small' }, `${fileName} from ${manifest.provider}. The server validates it and records it as IMPORTED_UNVERIFIED; it does not become verified market data by being uploaded.`),
      confirmLabel: 'Submit import',
      onConfirm: async () => {
        const res = await api.post('/api/import/csv', { manifest, csv: csvText });
        replace(area); replace(out, decisionResult(res));
        announce(res.ok ? 'Import submitted.' : `Import rejected: ${res.error?.message ?? ''}`);
      },
      onCancel: () => replace(area),
    }));
  });
  return form;
}
