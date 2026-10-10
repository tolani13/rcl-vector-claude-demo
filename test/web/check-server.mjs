// Local-only static server for the front-end's manual/browser layout checks. NOT part of the product.
//
//   node test/web/check-server.mjs --port 5181 --mode unreachable   # every /api/* -> 503 (API down)
//   node test/web/check-server.mjs --port 5182 --mode fixture       # /api/* -> TEST FIXTURE responses
//   Fixture options (all off by default): --partial 1 (status reports a truncated dataset), --model-running 1 (status
//   reports an assessment in flight), --evidence 404 (GET /api/evidence missing), --old-api 1 (journal rejects
//   exclude_type and opportunities reject windowMin/instruments with 400 UNKNOWN_FIELD, like an older server),
//   --model-connected 1 (a fixture provider reports CONNECTED, so the async assessment-run flow can be exercised).
//
// TEST FIXTURE — NOT MARKET DATA. Fixture mode exists only to exercise rendering of populated layouts in a browser.
// All symbols are IEX test-symbol shapes, every number is generated, and the dataset is named
// TEST-FIXTURE-NOT-MARKET-DATA so the status strip makes the origin obvious. Product code never imports this file.
// Response SHAPES follow the real server (server/api/*.js); strategies are the server's own exploratory presets
// (configuration, not market data).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PRESETS } from '../../server/agents/strategies.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(here, '..', '..', 'web');
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const port = Number(opt('port', '5181'));
const mode = opt('mode', 'unreachable');
const PARTIAL = opt('partial', '0') === '1';
const MODEL_RUNNING = opt('model-running', '0') === '1';
const EVIDENCE_404 = opt('evidence', '') === '404';
const OLD_API = opt('old-api', '0') === '1';
const MODEL_CONNECTED = opt('model-connected', '0') === '1'; // a fixture provider that reports CONNECTED (no real model behind it)
const unknownField = (name) => ({ __status: 400, error: { code: 'UNKNOWN_FIELD', message: `unknown query field(s): ${name}` } });
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png' };
const LABEL = 'TEST FIXTURE — NOT MARKET DATA';
const RETRO = 'RETROSPECTIVE — uses data after each signal; never visible to agents';

// ---------------------------------------------------------------- fixture state (generated, deterministic)
let seed = 7;
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
const MIN = 60000;
const t0 = Date.UTC(2026, 0, 2, 14, 30); // fixed fake session window
const t1 = t0 + 390 * MIN;
const wall0 = Date.UTC(2026, 0, 3, 12, 0);
const clone = (x) => JSON.parse(JSON.stringify(x));
const fx = {
  run: null, lastRun: null, // fixture assessment run (async 202), followed through /api/status model.inFlight / lastAssessmentRun
  clock: t0 + 47 * MIN, playing: false, session: 'sess_fixture', kill: { engaged: false, at: null, by: null, protective_policy: null },
  agents: ['cowboy', 'pragmatist', 'tightwad'].flatMap((lens) => ['micro', 'large'].map((segment) => ({
    id: `agent-${lens}-${segment}`, portfolio_id: `${lens}-${segment}`, lens, segment, state: 'PAUSED', state_reason: 'authority not implicitly resumed after restart',
    strategy: clone(PRESETS[`${lens}-${segment}`]),
    // Shapes written by server/agents/runner.js: last_ok {ts_sim, wall, kind, action, sym, order_ids}; last_fail {ts_sim, wall, stage, code, sym, reasons}.
    last_ok: lens === 'cowboy' ? { ts_sim: t0 + 21 * MIN, wall: wall0, kind: 'entry', action: 'open', sym: 'ZVZZT', order_ids: ['ord_fx_a', 'ord_fx_b'], intent_id: 'int_fx1' } : null,
    last_fail: lens === 'cowboy' ? { ts_sim: t0 + 31 * MIN, wall: wall0 + 1000, stage: 'policy', kind: 'entry', action: 'open', sym: 'ZWZZT', code: 'SPREAD_TOO_WIDE', reasons: [{ code: 'SPREAD_TOO_WIDE', detail: `spread 2353 bps > max 1500 bps (${LABEL})` }] } : null,
    scan_summary: {
      session_id: 'sess_fixture', scans: 47, firstScanTs: t0 + MIN, lastScanTs: t0 + 47 * MIN, symbolMinutesScanned: 2961, candidates: lens === 'cowboy' ? 3 : 0, entriesPlanned: lens === 'cowboy' ? 1 : 0,
      skipped: { RET_BELOW_MIN: 2540, SPREAD_ABOVE_MAX: 1210, RELVOL_BELOW_MIN: 980, OUTSIDE_ENTRY_WINDOW: 630, BUYSHARE_UNAVAILABLE: 410 },
      nearMisses: { SPREAD_ABOVE_MAX: 12, RET_BELOW_MIN: 9 }, modelNotConfirmed: 0, intentsProposed: lens === 'cowboy' ? 2 : 0, policyAccepted: lens === 'cowboy' ? 1 : 0,
      policyDenied: lens === 'cowboy' ? { SPREAD_TOO_WIDE: 1 } : {}, note: LABEL,
    },
  }))),
};
const SYMS = ['ZVZZT', 'ZWZZT', 'ZXZZT', 'ZJZZT', 'ZTEST', 'ZBZX', 'ZEXIT', 'ZIEXT', 'ZXIET', 'NTEST'];
function bars(sym) {
  seed = sym.split('').reduce((a, c) => a + c.charCodeAt(0), 11);
  let p = 2000 + Math.floor(rnd() * 6000);
  const rows = [];
  for (let t = t0; t + MIN <= fx.clock; t += MIN) {
    if (rnd() < 0.15) { rows.push({ t, o: null, h: null, l: null, c: null, v: 0, bv: 0, sv: 0, xv: 0 }); continue; }
    const o = p; p = Math.max(100, Math.round(p * (1 + (rnd() - 0.48) * 0.02)));
    const hi = Math.max(o, p) + Math.round(rnd() * 30); const lo = Math.min(o, p) - Math.round(rnd() * 30);
    const v = Math.round(rnd() * 40000); const bv = Math.round(v * rnd() * 0.6); const sv = Math.round((v - bv) * rnd());
    rows.push({ t, o, h: hi, l: lo, c: p, v, bv, sv, xv: v - bv - sv });
  }
  return rows;
}
const quoteOf = (sym) => { const b = bars(sym).filter((r) => r.c); const c = b.length ? b[b.length - 1].c : 5000; return { sym, bid: c - 10, ask: c + 10, bidSize: 1200, askSize: 900, quoteTs: fx.clock - 20000, ageMs: 20000, twoSided: true, spreadU: 20, spreadBps: Math.round(20 / c * 10000), mid: c, halted: false, tradingStatus: 'T', extendedSession: false, source: { ds: 'TEST-FIXTURE-NOT-MARKET-DATA', venue: 'IEX', minuteRowT: fx.clock - MIN } }; };
const NAMES = ['issuer', 'issuer - Warrant', 'issuer - Units', 'issuer', 'issuer - Rights'];
const TYPES_FX = ['common', 'warrant', 'unit', 'common', 'right'];
const opp = (sym, i) => ({ rank: i + 1, sym, name: `${LABEL} ${NAMES[i % NAMES.length]} ${i + 1}`, priceU: quoteOf(sym).mid, minuteT: fx.clock - MIN, quote: quoteOf(sym),
  namePostDated: true, securityType: { type: TYPES_FX[i % TYPES_FX.length], basis: 'directory name heuristic', postDated: true }, nonCommon: TYPES_FX[i % TYPES_FX.length] !== 'common',
  score: i % 3 === 2 ? null : 90 - i * 7.5,
  metrics: { ret_w: (rnd() - 0.3) * 0.4, accel: (rnd() - 0.5) * 0.05, relVol: i === 1 ? 42841.67 : rnd() * 6, buyShare: i % 3 === 2 ? null : rnd(), classifiedShare: rnd(), volumeW: Math.round(rnd() * 900000), tradesW: i === 0 ? 1 : Math.round(rnd() * 60),
    spreadBps: 40 + Math.round(rnd() * 400), quoteAgeMs: Math.round(rnd() * 90000), halted: i === 4, insufficient: i % 3 === 2, reasons: i % 3 === 2 ? ['LOW_CLASSIFIED_VOLUME'] : i === 0 ? ['QUOTE_STALE'] : [] } });
const portfolio = (id) => ({ portfolio: { id, name: null, lens: id.split('-')[0], segment: id.split('-')[1] ?? null, kind: id === 'sandbox' ? 'sandbox' : 'agent', starting_cash: 100000000 },
  cashU: 100000000 - (id === 'sandbox' ? 2563000 : 0), equityU: id === 'sandbox' ? 99890000 : 100000000, unrealizedU: id === 'sandbox' ? -110000 : 0, realizedU: 0, feesU: 0,
  positions: id === 'sandbox' ? [{ sym: 'ZVZZT', kind: 'equity', qty: 500, cost_basis: 2563000, markU: 4904, markBasis: 'IEX_BID', valueU: 2452000, unrealizedU: -111000 }] : [],
  openOrders: id === 'sandbox' ? [
    { id: 'ord_fx1', portfolio_id: 'sandbox', sym: 'ZVZZT', side: 'sell', type: 'stop', role: 'stop_loss', qty: 500, filled_qty: 0, stop_px: 4500, status: 'working', protective: 1, created_ts: t0 + 20 * MIN },
    { id: 'ord_fx2', portfolio_id: 'sandbox', sym: 'ZXZZT', side: 'buy', type: 'limit', role: 'entry', qty: 300, filled_qty: 0, limit_px: 3100, status: 'working', protective: 0, created_ts: t0 + 40 * MIN },
  ] : [],
  fills: id === 'sandbox' ? [{ id: 'fill_fx1', sym: 'ZVZZT', side: 'buy', qty: 500, price: 5126, fees: 0, ts: t0 + 19 * MIN, model: 'iex-conservative-minute-v1', estimated: true,
    assumptions: { model: 'iex-conservative-minute-v1', note: LABEL, priceBasis: 'WORST_IN_MINUTE', rule: 'MARKET_BUY_WORST_ASK_IN_MINUTE', basePriceU: 5100, slippageBps: 50, tickRule: 'REG_NMS_612_ROUNDED_AGAINST_TRADER',
      fees: { commissionU: 0, secFeeU: 0, tafU: 0, totalU: 0, rounding: 'EACH_COMPONENT_UP_TO_WHOLE_U', tafPerShareU: 1.66, tafCapU: 83000 }, sizeSource: 'DISPLAYED', omitted: ['queue position', 'hidden liquidity'] },
    observed: { ds: 'TEST-FIXTURE-NOT-MARKET-DATA', venue: 'IEX', sym: 'ZVZZT', minuteT: t0 + 19 * MIN, hasRow: true, startQuote: { bid: 5080, ask: 5090, bidSize: 900, askSize: 700, quoteTs: t0 + 19 * MIN - 50 },
      endQuote: { bid: 5090, ask: 5100, bidSize: 1000, askSize: 800, quoteTs: t0 + 20 * MIN - 400 }, minBid: 5070, maxBid: 5090, minAsk: 5085, maxAsk: 5100, trades: { o: 5085, h: 5100, l: 5070, c: 5095, v: 12000, n: 31, vwap: 5089 }, halted: false, unavailable: false } }] : [] });
const EV_IDS = ['ev_' + 'a1'.repeat(12), 'ev_' + 'b2'.repeat(12)]; // fixture evidence ids (valid id shape, invented content)
const PIDS = ['cowboy-micro', 'pragmatist-micro', 'tightwad-micro', 'cowboy-large', 'pragmatist-large', 'tightwad-large', 'sandbox'];

function study() {
  if (fx.clock < t1) {
    return { label: RETRO, status: 'BLOCKED', reason: 'WITHHELD_UNTIL_CLOSE', ds: 'TEST-FIXTURE-NOT-MARKET-DATA', availableAtMs: t1, detail: `WITHHELD UNTIL CLOSE (${LABEL})`, rows: [] };
  }
  seed = 41;
  const outcomes = ['continued', 'reversed', 'reversed', 'stalled', 'reversed', 'reversed'];
  const rows = SYMS.slice(0, 6).map((sym, i) => ({ sym, signalEt: `${10 + i}:0${i} ET`, retWPct: 22 + i, outcome: outcomes[i], classRetPct: (rnd() - 0.6) * 30, mfePct: rnd() * 20, maePct: -rnd() * 25,
    sessionCloseRetPct: (rnd() - 0.6) * 30, spreadBps: 1500 + Math.round(rnd() * 3000), relVol: i === 2 ? 12000 : rnd() * 9, buyShare: i % 2 ? null : rnd(), volumeW: Math.round(rnd() * 40000), signalPriceU: 4000 + i * 100,
    horizons: { 5: { retPct: rnd() * 5 }, 15: { retPct: rnd() * 5 }, 30: { retPct: -rnd() * 5 } } }));
  const side = (r) => ({ sym: r.sym, signalEt: r.signalEt, class: r.outcome, classRetPct: r.classRetPct, mfePct: r.mfePct, maePct: r.maePct, features: { ret_w: 0.22, accel: 0.05, spreadBps: r.spreadBps, buyShare: r.buyShare, relVol: r.relVol } });
  return {
    label: RETRO, status: 'HISTORICAL_REAL', ds: 'TEST-FIXTURE-NOT-MARKET-DATA', tier: 'penny', note: LABEL,
    dataset: { id: 'TEST-FIXTURE-NOT-MARKET-DATA', provider: LABEL, sha256: 'f'.repeat(64), coverage: LABEL },
    session: { tradeDate: '2026-01-02', open: '2026-01-02 09:30 ET', close: '2026-01-02 16:00 ET', openMs: t0, closeMs: t1 },
    definitions: { signal: `${LABEL}: first minute with a 15-min return at or above the threshold`, classification: 'continued / stalled / reversed at +60 min' },
    limitations: [`${LABEL}: single generated day.`, 'Descriptive only.'],
    thresholdPct: 22, counts: { symbolsScanned: 417, signals: 6, continued: 1, stalled: 1, reversed: 4, no_session_after_signal: 1 },
    rows,
    matched: { method: 'nearest neighbour on z-scored signal features (fixture)', pairs: [{ breakout: side(rows[0]), matchedFailure: side(rows[1]), distance: 0.82, featuresCompared: 5 }] },
    handwrittenRule: { label: `EXPLORATORY — ${LABEL}`, default: 'tp2.5', interpretation: { stop: 'at entry reference', budget: 'hard cap including slippage and fees' }, fillModel: { id: 'iex-conservative-minute-v1', source: 'server/sim/fills.js' },
      variants: [{ id: 'tp2.5', stopMode: 'AT_ENTRY_REF', tpMult: 2.5, timeExit: true, summary: { signals: 6, entered: 2, winners: 0, losers: 2, flat: 0, totalPnlU: -21000, totalCostU: 990000, worseThanStopFills: 1, immediateStopTriggers: 2 } },
        { id: 'tp3.5', stopMode: 'AT_ENTRY_REF', tpMult: 3.5, timeExit: true, summary: { signals: 6, entered: 2, winners: 0, losers: 2, flat: 0, totalPnlU: -21000, totalCostU: 990000, worseThanStopFills: 1, immediateStopTriggers: 2 } }] },
    exploratory: null, timing: { ms: 1234 },
  };
}

function journalRows() {
  return Array.from({ length: 24 }, (_, i) => {
    const scan = i % 3 !== 2;
    return { seq: 200 - i, session_id: fx.session, ts_sim: fx.clock - i * MIN, ts_wall: wall0 + i, portfolio_id: scan ? 'tightwad-micro' : (i % 2 ? 'sandbox' : null),
      agent_id: scan ? 'agent-tightwad-micro' : null, actor: scan ? 'agent' : 'policy', type: scan ? 'AGENT_SCAN' : (i % 2 ? 'POLICY_DENY' : 'KILL_SWITCH_ENGAGED'), ref_id: `ref_${i}`,
      payload: scan
        ? { note: LABEL, universe: 398, active: 63, scanned: 63, planned: [], positions: [], skipped: { RET_BELOW_MIN: 57, SPREAD_ABOVE_MAX: 45, RELVOL_BELOW_MIN: 37 }, windowMin: 15 }
        : { note: LABEL, decision: 'DENIED', reasons: [{ code: 'QUOTE_STALE', detail: 'age > max' }], protective_policy: 'KEEP_PROTECTIVE' },
      prev_hash: 'a'.repeat(64), hash: `${i}`.repeat(64).slice(0, 64) };
  });
}

function fixture(method, url, body) {
  const u = new URL(url, 'http://x');
  const p = u.pathname;
  if (method === 'GET' && p === '/api/status' && fx.run && Date.now() - fx.run.startedAt > 6000) {
    // The fixture's async assessment run "finishes" ~6 s after it started, with a NOT_RUN outcome (no model behind it).
    fx.lastRun = { run_id: fx.run.run_id, sym: fx.run.sym, asOf: fx.clock, session_id: fx.session, mode: 'async', startedAt: fx.run.startedAt, finishedAt: Date.now(),
      status: 'NOT_RUN', code: 'CALL_CAP_REACHED', detail: `model call cap reached for this session (${LABEL}); ASSESSMENT_NOT_RUN` };
    fx.run = null;
  }
  // Shapes follow server/api/status.js: coverage on replay.* and data.dataset.*, model.running + inFlight + lastAssessmentRun.
  if (method === 'GET' && p === '/api/status') return { app: { name: 'VECTOR', brand: 'Recursive Chaos Labs', motto: 'Refining Chaos Into Clarity.', version: '0.1.0-fixture', paperOnly: true, liveBroker: 'NONE — out of MVP scope' },
    data: { mode: 'IMPORTED_UNVERIFIED', modeDetail: PARTIAL ? `PARTIAL dataset: stored data ends at the coverage end (${LABEL}).` : LABEL,
      dataset: { id: 'TEST-FIXTURE-NOT-MARKET-DATA', trade_date: '2026-01-02', status: PARTIAL ? 'partial' : 'complete', complete: !PARTIAL, coverage_end: PARTIAL ? t0 + 191 * MIN : null },
      live: { status: 'NO_VERIFIED_DATA', detail: LABEL } },
    replay: { status: fx.clock >= t1 ? 'SESSION_CLOSED' : 'READY', session_id: fx.session, ds: 'TEST-FIXTURE-NOT-MARKET-DATA', t_start: t0, t_end: t1, clock: fx.clock, playing: fx.playing, tick_wall_ms: 1500, busy: false,
      complete: !PARTIAL, coverage_end: PARTIAL ? t0 + 191 * MIN : null, truncated: PARTIAL, beyondCoverage: PARTIAL && fx.clock > t0 + 191 * MIN,
      truncation_note: PARTIAL ? `DATASET_TRUNCATED: the dataset's data ends at the coverage end (${LABEL}).` : null },
    model: { status: MODEL_CONNECTED ? 'CONNECTED' : 'DISCONNECTED', provider: MODEL_CONNECTED ? 'fixture' : 'none', model: MODEL_CONNECTED ? 'fixture-model' : null, detail: MODEL_CONNECTED ? LABEL : 'VECTOR_MODEL_PROVIDER not set', running: MODEL_RUNNING || !!fx.run,
      inFlight: {
        assessment: fx.run ? { run_id: fx.run.run_id, sym: fx.run.sym, asOf: fx.clock, mode: 'async', startedAt: fx.run.startedAt, elapsedMs: Date.now() - fx.run.startedAt, lensesDone: 1, lensesTotal: 3 }
          : MODEL_RUNNING ? { run_id: 'arun_fixture', sym: 'ZWZZT', asOf: fx.clock, mode: 'async', startedAt: wall0, elapsedMs: 42000, lensesDone: 1, lensesTotal: 3 } : null,
        modelTest: null, agentCalls: 0 },
      lastAssessmentRun: fx.lastRun },
    options: { status: 'NO_VERIFIED_OPTIONS_DATA', detail: 'No options provider configured' },
    kill: fx.kill, agents: fx.agents.map(({ strategy, scan_summary, ...a }) => ({ ...a, decisionMode: strategy.decisionMode, strategy_id: strategy.id })) };
  if (method === 'GET' && p === '/api/sources') return [
    { id: 'TEST-FIXTURE-NOT-MARKET-DATA', name: `IEX HIST TOPS (${LABEL})`, kind: 'market_ticks', status: 'IMPORTED_UNVERIFIED', provider: 'fixture generator', coverage: 'IEX only (fixture)', entitlement: 'test only', attribution: `Attribution text placeholder for layout check — ${LABEL}`, last_event_ts: t1, ingested_at: t1 + 3600000, sha256: 'f'.repeat(64), rows: 123456, setup: 'npm run ingest:iex -- --date YYYY-MM-DD', notes: LABEL, datasets: [{ id: 'TEST-FIXTURE-NOT-MARKET-DATA', status: 'complete' }] },
    { id: 'sec-edgar', name: 'SEC EDGAR filings', kind: 'filings', status: 'BLOCKED', provider: 'SEC', coverage: null, entitlement: 'public', attribution: null, last_event_ts: null, ingested_at: null, sha256: null, rows: 0, setup: 'Set SEC_USER_AGENT', notes: LABEL },
    { id: 'fred', name: 'FRED macro', kind: 'macro', status: 'NO_VERIFIED_DATA', provider: 'FRED', setup: 'npm run ingest:fred', notes: LABEL },
  ];
  if (method === 'GET' && (p === '/api/research/opportunities' || p === '/api/market/universe')) {
    if (OLD_API && (u.searchParams.has('windowMin') || u.searchParams.has('instruments'))) return unknownField(u.searchParams.has('windowMin') ? 'windowMin' : 'instruments');
    const large = u.searchParams.get('segment') === 'large';
    const windowMin = Number(u.searchParams.get('windowMin') || 15);
    const instruments = u.searchParams.get('instruments') || 'all';
    seed = (large ? 99 : 5) + windowMin;
    const ranked = (large ? SYMS.slice(6) : SYMS.slice(0, 9)).map(opp).sort((a, b) => Number(a.nonCommon) - Number(b.nonCommon)).map((r, i) => ({ ...r, rank: i + 1 }));
    const all = instruments === 'all' ? ranked : ranked.filter((r) => (instruments === 'common' ? !r.nonCommon : r.nonCommon));
    const limit = Number(u.searchParams.get('limit')) || null;
    return { asOf: fx.clock, segment: u.searchParams.get('segment'), status: 'IMPORTED_UNVERIFIED', note: `Price-tier proxy. ${LABEL}`, label: 'SIGNAL METRICS — NOT RECOMMENDATIONS',
      windowMin, ...(OLD_API ? {} : { instruments, horizons: { minutes: [5, 15, 30, 60], selected: windowMin, daysWeeks: `BLOCKED BY DATA: days/weeks horizons need several ingested trading days (${LABEL}).` } }),
      scoreFormula: `score = weighted signal terms (${LABEL})`, weights: { retPct: 1, accelPct: 0.5, relVolLog2: 10, buyShareTilt: 20, spreadPer100Bps: -1 },
      counts: { universe: ranked.length, scored: all.filter((r) => r.score !== null).length, insufficient: all.filter((r) => r.score === null).length,
        nonCommon: ranked.filter((r) => r.nonCommon).length, filteredOut: ranked.length - all.length, returned: all.length },
      rows: limit ? all.slice(0, limit) : all };
  }
  if (method === 'GET' && p === '/api/market/bars') { const sym = u.searchParams.get('sym'); return SYMS.includes(sym) ? { asOf: fx.clock, sym, rows: bars(sym), quote: quoteOf(sym), status: 'IMPORTED_UNVERIFIED' } : { asOf: fx.clock, sym, rows: [], quote: null, status: 'NO_VERIFIED_DATA' }; }
  if (method === 'GET' && p === '/api/market/benchmark') {
    return { asOf: fx.clock, series: ['FIXTURE-BENCH-A', 'FIXTURE-BENCH-B', 'FIXTURE-BENCH-C', 'FIXTURE-BENCH-D'].map((name, k) => { seed = 3 + k; let r = 0; const pts = []; for (let t = t0 + MIN; t <= fx.clock; t += MIN) { r += (rnd() - 0.5) * 0.08; pts.push({ t, retPct: +r.toFixed(3) }); } return { sym: name, points: pts }; }), note: LABEL };
  }
  if (method === 'GET' && p === '/api/macro') { seed = 21; return { asOf: fx.clock, status: 'HISTORICAL_REAL', vintageNote: `Latest vintage, not point-in-time (${LABEL}).`, series: [{ series: 'FIXTURE_SERIES', title: `Macro series (${LABEL})`, units: 'pct', frequency: 'daily', publication_lag_days: 1, vintage: { status: 'LATEST_VINTAGE', withheld: false, revisable: true, fetchedAt: t1 + 86400000 }, observations: Array.from({ length: 40 }, (_, i) => ({ date: `2025-11-${String((i % 28) + 1).padStart(2, '0')}`, value: 4 + rnd() })), latest: { date: '2025-12-31', value: 4.31 } }] }; }
  if (method === 'GET' && p === '/api/research/dossier') { const sym = u.searchParams.get('sym'); return { sym, asOf: fx.clock, identity: { name: `${LABEL} issuer`, exchange: 'TEST', status: 'IMPORTED_UNVERIFIED', test_issue: true, fileCreationMs: t1 + 7200000 }, market: {}, halts: [{ ts: t0 + 12 * MIN, kind: 'trading_status', code: 'H', reason: 'fixture halt' }, { ts: t0 + 17 * MIN, kind: 'trading_status', code: 'T', reason: 'resumed' }], shortVolume: 'UNAVAILABLE_NOT_VERIFIED', filings: { status: 'BLOCKED', detail: 'SEC_USER_AGENT not configured' }, financing: null, leadership: [], media: { status: 'UNAVAILABLE_NOT_VERIFIED', detail: 'No licensed media source' }, unavailable: [{ field: 'financing', status: 'UNAVAILABLE_NOT_VERIFIED', reason: 'Requires SEC EDGAR ingestion' }, 'media'] }; }
  if (method === 'GET' && p === '/api/assessments') {
    // ZVZZT has three stored (older) assessments so the stored-while-disconnected layout and staleness badges can be checked.
    if (u.searchParams.get('sym') !== 'ZVZZT') return { status: 'ASSESSMENT_NOT_RUN', model: { status: 'DISCONNECTED', provider: 'none' }, rows: [] };
    const audit = (i) => ({
      intent_status: i === 0 ? 'INVALID' : 'NONE', intent_errors: i === 0 ? [`stop_loss_px_u must be below the as-of bid (${LABEL})`] : [],
      intent_draft: i === 0 ? { side: 'buy', qty: 10, type: 'limit', limit_px_u: 2100, agent_id: 'draft:cowboy', note: LABEL } : null,
      requested_model: 'fixture-model', served_model: i === 1 ? 'fixture-fallback-model' : 'fixture-model', fallback_used: i === 1,
      verification: { checked: true, numbers_checked: 6, unmatched: i === 2 ? [{ field: 'thesis', value: '0.4321' }] : [], flags: i === 2 ? [`describes the spread as tight (${LABEL})`] : [], note: LABEL },
      hindsight: i === 0 ? { hindsight_risk: true, code: 'MODEL_TRAINING_CUTOFF_UNKNOWN', model_training_cutoff: null, cutoff_source: null, margin_days: 30, trade_date: '2026-01-02' } : null,
    });
    const rows = ['cowboy', 'pragmatist', 'tightwad'].map((lens, i) => ({ id: `as_fx${i}`, session_id: fx.session, sym: 'ZVZZT', lens, status: 'OK', provider: 'fixture', model: i === 1 ? 'fixture-fallback-model' : 'fixture-model',
      as_of: t0 + 10 * MIN, created_wall: wall0 + i, packet_sha256: 'e'.repeat(64), latency_ms: 1000 + i, evidence_ids: EV_IDS,
      output: { lens, stance: ['consider_entry', 'watch', 'avoid'][i], thesis: `${LABEL} thesis`, counter_thesis: `${LABEL} counter-thesis`, unknowns: ['fixture unknown'],
        evidence_refs: i === 2 ? [...EV_IDS, 'ev_' + '0'.repeat(24)] : EV_IDS, confidence: { level: 'low', calibration_note: LABEL }, proposed_intent: i === 0 ? { side: 'buy', qty: 10, order_type: 'limit', limit_px_u: 2100 } : null },
      audit: audit(i) }));
    return { status: 'STORED', model: { status: 'DISCONNECTED', provider: 'none' }, rows };
  }
  if (method === 'GET' && p === '/api/evidence') {
    if (EVIDENCE_404) return null;
    const ids = String(u.searchParams.get('ids') || '').split(',').filter(Boolean);
    return { asOf: fx.clock, status: 'OK', requested: ids.length, unavailable: ids.filter((id) => !EV_IDS.includes(id)), rows: ids.filter((id) => EV_IDS.includes(id)).map((id, k) => ({
      id, sym: k === 1 ? null : 'ZVZZT', kind: k === 1 ? 'macro_observation' : 'market_quote', title: `${LABEL} evidence item ${k + 1}`, provider: 'fixture generator', ds: 'TEST-FIXTURE-NOT-MARKET-DATA',
      source_url: null, source_id: null, event_ts: t0 + (9 - k) * MIN, knowable_ts: t0 + (10 - k) * MIN,
      body: k === 1 ? { series: 'FIXTURE_SERIES', value: 4.31, vintage_caveat: LABEL } : { bid_usd: 0.4990, ask_usd: 0.5010, spread_bps: 40, note: LABEL } })) };
  }
  if (method === 'GET' && p === '/api/portfolios') return PIDS.map(portfolio);
  if (method === 'GET' && p.startsWith('/api/portfolios/')) return portfolio(decodeURIComponent(p.split('/').pop()));
  if (method === 'GET' && p === '/api/agents') return { label: 'EXPLORATORY DEFAULTS — NOT VALIDATED', presets: PRESETS, rows: fx.agents.map((a) => ({ ...a, decisionMode: a.strategy.decisionMode })) };
  if (method === 'GET' && p === '/api/journal') {
    if (OLD_API && u.searchParams.has('exclude_type')) return unknownField('exclude_type');
    const type = u.searchParams.get('type');
    const exclude = String(u.searchParams.get('exclude_type') || '').split(',').filter(Boolean);
    const scope = u.searchParams.get('session_id') === 'all' ? 'all' : 'current';
    const prior = scope === 'all' ? journalRows().slice(0, 6).map((r, i) => ({ ...r, seq: 40 - i, session_id: 'sess_fixture_prior', ts_sim: t0 + (20 - i) * MIN, hash: `p${i}`.repeat(32).slice(0, 64) })) : [];
    const rows = [...journalRows(), ...prior].filter((r) => (!type || r.type === type) && !exclude.includes(r.type))
      .map((r) => ({ ...r, prior_session: r.session_id !== fx.session, hindsight: false }));
    return { current_session_id: fx.session, asOf: fx.clock, scope, hindsight: false, note: `Scope ${scope}. Rows of other replay sessions with replay time after the current clock are hidden (${LABEL}).`,
      rows, chain: { ok: true, checked: 200, brokenAt: null } };
  }
  if (method === 'GET' && p === '/api/options/status') return { status: 'NO_VERIFIED_OPTIONS_DATA', detail: 'No options provider configured' };
  if (method === 'GET' && p === '/api/research/study') return study();
  if (method === 'GET' && p === '/api/model') return { status: 'DISCONNECTED', provider: 'none', limits: null, callsUsedThisSession: 0 };
  if (method === 'POST' && p === '/api/assessments/run') {
    if (OLD_API && body && 'async' in body) return unknownField('async');
    if (body?.confirm !== true) return { __status: 409, error: { code: 'CONFIRMATION_REQUIRED', message: LABEL } };
    if (fx.run) return { __status: 429, error: { code: 'ASSESSMENT_BUSY', message: 'an assessment run is already in progress' } };
    if (!body?.async) return { __status: 409, error: { code: 'MODEL_DISCONNECTED', message: `MODEL DISCONNECTED / ASSESSMENT NOT RUN (${LABEL})` } };
    fx.run = { run_id: `arun_fx_${Date.now()}`, sym: body.sym, startedAt: Date.now() };
    return { __status: 202, decision: 'ACCEPTED', status: 'RUNNING', run_id: fx.run.run_id, sym: body.sym, asOf: fx.clock, lensesTotal: 3, note: LABEL };
  }
  if (method === 'POST' && p === '/api/replay/reset') {
    fx.clock = t0;
    const restore = body?.restorePresets === true;
    return { decision: 'OK', session_id: fx.session, restorePresets: restore, startingCashU: body?.startingCashU ?? null, note: LABEL,
      strategies: fx.agents.map((a, i) => ({ agent_id: a.id, strategy_id: a.strategy.id ?? null, strategy_source: restore || i === 5 ? 'preset' : 'carried',
        ...(restore ? { note: 'restorePresets requested' } : i === 5 ? { note: `stored strategy not reusable (fixture); preset applied (${LABEL})` } : {}) })) };
  }
  if (method === 'POST' && p === '/api/replay/step') { fx.clock = Math.min(t1, fx.clock + (Number(body?.minutes) || 1) * MIN); return { decision: 'OK', clock: fx.clock }; }
  if (method === 'POST' && p === '/api/replay/play') { fx.playing = true; return { decision: 'OK' }; }
  if (method === 'POST' && p === '/api/replay/pause') { fx.playing = false; return { decision: 'OK' }; }
  if (method === 'POST' && p === '/api/kill') { fx.kill = { engaged: true, at: fx.clock, by: 'human', protective_policy: body?.protective_policy }; return { decision: 'OK' }; }
  if (method === 'POST' && p === '/api/kill/release') { fx.kill = { engaged: false, at: null, by: null, protective_policy: null }; return { decision: 'OK' }; }
  if (method === 'POST' && p === '/api/orders') return { decision: 'DENIED', reasons: [{ code: 'TEST_FIXTURE', detail: `${LABEL}: no policy gate behind this check server` }], checks: [{ rule: 'paper_only', pass: true }, { rule: 'quote_fresh', pass: false, detail: 'fixture' }], echo: body };
  if (method === 'POST' && /^\/api\/orders\/[^/]+\/(cancel|replace)$/.test(p)) return { decision: 'ACCEPTED', note: LABEL, echo: body };
  if (method === 'PUT' && /^\/api\/agents\/[^/]+\/strategy$/.test(p)) {
    const a = fx.agents.find((x) => x.id === decodeURIComponent(p.split('/')[3]));
    if (a && body?.strategy) a.strategy = body.strategy;
    return { decision: 'OK', label: 'EXPLORATORY DEFAULTS — NOT VALIDATED' };
  }
  return null;
}

const server = http.createServer((req, res) => {
  const url = req.url || '/';
  if (url.startsWith('/api/')) {
    if (mode !== 'fixture') { res.writeHead(503, { 'Content-Type': 'text/plain' }); res.end('API not running (static check server)'); return; }
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      let body = null;
      try { body = raw ? JSON.parse(raw) : null; } catch { /* ignore */ }
      if (req.method !== 'GET' && req.headers['x-vector-client'] !== 'web') { res.writeHead(403, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { code: 'MISSING_CLIENT_HEADER', message: 'X-Vector-Client: web required' } })); return; }
      const out = fixture(req.method, url, body);
      if (out === null) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { code: 'NOT_FOUND', message: 'fixture route not implemented' } })); return; }
      if (out && out.__status) { const { __status, ...rest } = out; res.writeHead(__status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(rest)); return; }
      if (fx.playing && url.startsWith('/api/status')) fx.clock = Math.min(t1, fx.clock + MIN);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(out));
    });
    return;
  }
  const rel = decodeURIComponent(url.split('?')[0]).replace(/^\/+/, '') || 'index.html';
  const file = path.resolve(webRoot, rel);
  if (!file.startsWith(webRoot) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end('not found'); return; }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
  fs.createReadStream(file).pipe(res);
});
server.listen(port, '127.0.0.1', () => console.log(`check server (${mode}) on http://127.0.0.1:${port}/`));
