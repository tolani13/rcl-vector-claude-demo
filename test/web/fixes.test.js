// Regression tests for the web review fixes (DOM-free logic behind each behavioural fix).
// TEST FIXTURE — NOT MARKET DATA: every symbol, price, time and count below is invented to exercise software behaviour.
// Symbols use IEX test-symbol shapes; strategies are the server's own exploratory presets (configuration).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as api from '../../web/js/api.js';
import {
  fmtRelVol, securityTypeFromName, fillEnumText, segmentPref, stateReasonText, reasonLabel, skipLabel, SEGMENT_LABELS,
} from '../../web/js/format.js';
import { fmtByKey } from '../../web/js/components.js';
import { preserveFocus } from '../../web/js/dom.js';
import { isRouteHash, parseHash } from '../../web/js/router.js';
import { estimateOrder } from '../../web/js/estimate.js';
import { tickAnchor, timeTicks, spreadLabels, endLabelNames } from '../../web/js/charts.js';
import {
  isFailNewer, lastAction, lastActionLine, actionSummaryText, scanWhy, scanWhyText, journalRowSummary, studyAccess, assessmentAge,
} from '../../web/js/summaries.js';
import {
  applyStrategyEdits, formatFieldValue, fieldLabel, flattenStrategy, skipThresholdText, toUiValue, getPath, STRATEGY_FIELDS,
} from '../../web/js/strategy-schema.js';
import { normOpp } from '../../web/js/views/common.js';
import { reviewIsStale, replaceBody, fillProvenance, labelsFor } from '../../web/js/views/lab.js';
import { pageRows, modelState, PAGE_SIZE } from '../../web/js/views/research.js';
import { normAgent, presetsFor, presetList, strategyDiff, strategyValueText } from '../../web/js/views/agents.js';
import { visibleRows, KNOWN_TYPES } from '../../web/js/views/journal.js';
import { PRESETS, validateStrategy } from '../../server/agents/strategies.js';

const FIXTURE = 'TEST FIXTURE — NOT MARKET DATA';
const T0 = Date.UTC(2026, 0, 2, 14, 30); // invented session open
const MIN = 60000;

// ---------------------------------------------------------------- api.js per-call timeouts

function stubFetch(delayMs, body = { ok: true }) {
  const calls = [];
  globalThis.fetch = (path, init) => new Promise((resolve, reject) => {
    calls.push({ path, init });
    const t = setTimeout(() => resolve(new Response(JSON.stringify(body), { status: 200 })), delayMs);
    init?.signal?.addEventListener('abort', () => { clearTimeout(t); reject(new DOMException('aborted', 'AbortError')); });
  });
  return calls;
}

test('api.request honours a per-call timeoutMs and reports a client timeout as CLIENT_TIMEOUT, not API_UNREACHABLE', async (t) => {
  const real = globalThis.fetch;
  t.after(() => { globalThis.fetch = real; });
  stubFetch(80);
  const short = await api.post('/api/replay/step', { minutes: 60 }, { timeoutMs: 20 });
  assert.equal(short.ok, false);
  assert.equal(short.timedOut, true);
  assert.equal(short.unreachable, false);
  assert.equal(short.error.code, 'CLIENT_TIMEOUT');
  const long = await api.post('/api/replay/step', { minutes: 60 }, { timeoutMs: 500 });
  assert.equal(long.ok, true, 'a call slower than a short timeout succeeds with a longer per-call timeout');
  const none = await api.get('/api/status', { timeoutMs: 0 });
  assert.equal(none.ok, true, 'timeoutMs 0 disables the client abort');
  globalThis.fetch = () => Promise.reject(new TypeError('network down'));
  const down = await api.get('/api/status');
  assert.equal(down.unreachable, true);
  assert.equal(down.error.code, 'API_UNREACHABLE');
});

test('client timeouts are sized from the server bounds of long operations', () => {
  assert.equal(api.TIMEOUT_MS, 12000);
  assert.ok(api.stepTimeoutMs(60) >= 30000 + 60 * 400, '60-minute step allows > 400 ms per minute');
  assert.ok(api.MODEL_TEST_TIMEOUT_MS > 30000, 'model test outlasts the 30 s server probe');
  assert.equal(api.assessTimeoutMs({ timeoutMs: 120000 }), 3 * 125000 + 15000);
  assert.equal(api.assessTimeoutMs(null), 3 * 125000 + 15000, 'unknown limits fall back to the 120 s default per call');
});

// ---------------------------------------------------------------- last successful / failed action (runner shapes)

// TEST FIXTURE — NOT MARKET DATA (shapes written by server/agents/runner.js)
const lastOk = { ts_sim: T0 + 21 * MIN, wall: 1000, kind: 'entry', action: 'open', sym: 'ZVZZT', order_ids: ['o1', 'o2'] };
const lastFail = { ts_sim: T0 + 270 * MIN, wall: 2000, stage: 'policy', kind: 'entry', action: 'open', sym: 'ZWZZT', code: 'SPREAD_TOO_WIDE',
  reasons: [{ code: 'SPREAD_TOO_WIDE', detail: 'spread 2353 bps > max 1500 bps' }, { code: 'QUOTE_STALE', detail: 'age' }] };

test('the most recent action is decided by ts_sim, ties by wall, never by missing legacy fields', () => {
  assert.equal(isFailNewer(lastFail, lastOk), true);
  assert.equal(isFailNewer({ ...lastFail, ts_sim: T0 }, lastOk), false);
  assert.equal(isFailNewer({ ...lastFail, ts_sim: lastOk.ts_sim, wall: 999 }, lastOk), false, 'same replay minute: earlier wall loses');
  assert.equal(isFailNewer({ ...lastFail, ts_sim: lastOk.ts_sim, wall: 1001 }, lastOk), true, 'same replay minute: later wall wins');
  assert.equal(isFailNewer({ stage: 'fault', code: 'X', ts_sim: null, wall: 5000 }, lastOk), true, 'missing ts_sim falls back to wall');
  assert.equal(lastAction({ last_ok: lastOk, last_fail: lastFail }).ok, false);
  assert.match(lastActionLine({ last_ok: lastOk, last_fail: lastFail }), /^last action failed: SPREAD_TOO_WIDE on ZWZZT at \d\d:\d\d ET$/);
  assert.match(lastActionLine({ last_ok: lastOk, last_fail: { ...lastFail, ts_sim: T0 } }), /^last action ok: entry open ZVZZT/);
  assert.equal(lastActionLine({}), 'no actions yet');
});

test('action summaries include symbol, code and the first reason (policy deny, order failure, block, ok)', () => {
  const deny = actionSummaryText(lastFail);
  for (const s of ['ZWZZT', 'SPREAD_TOO_WIDE', 'spread 2353 bps > max 1500 bps', '(+1 more)', 'POLICY']) assert.ok(deny.includes(s), `${deny} has ${s}`);
  const orderFail = actionSummaryText({ ts_sim: T0, stage: 'order', sym: 'ZXZZT', code: 'ORDER_REJECTED', errors: ['qty exceeds displayed size'] });
  assert.match(orderFail, /ZXZZT.*ORDER_REJECTED: qty exceeds displayed size/);
  assert.match(actionSummaryText({ stage: 'model', code: 'MODEL_DISCONNECTED', detail: 'no provider' }), /MODEL MODEL_DISCONNECTED: no provider/);
  assert.match(actionSummaryText({ stage: 'blocked', code: 'KILL_SWITCH_ENGAGED', detail: 'kill switch' }), /KILL_SWITCH_ENGAGED: kill switch/);
  assert.match(actionSummaryText(lastOk), /entry open ZVZZT · 2 orders$/);
  assert.equal(actionSummaryText(null), 'none recorded');
});

// ---------------------------------------------------------------- "why no trades"

test('scan summaries explain zero entries from the server scan_summary (entry-window skips reported separately)', () => {
  // TEST FIXTURE — NOT MARKET DATA
  const ss = { scans: 389, entriesPlanned: 0, intentsProposed: 0, policyAccepted: 0, skipped: { OUTSIDE_ENTRY_WINDOW: 9000, SPREAD_ABOVE_MAX: 450, RET_BELOW_MIN: 570, RELVOL_BELOW_MIN: 370, HALTED: 1 }, nearMisses: { SPREAD_ABOVE_MAX: 12 }, policyDenied: {} };
  const w = scanWhy(ss);
  assert.deepEqual(w.top.map(([c]) => c), ['RET_BELOW_MIN', 'SPREAD_ABOVE_MAX', 'RELVOL_BELOW_MIN']);
  assert.equal(w.outsideWindow, 9000);
  const text = scanWhyText(ss);
  assert.match(text, /^0 entries planned in 389 scans/);
  assert.ok(text.includes(`${skipLabel('SPREAD_ABOVE_MAX')} (450)`));
  assert.ok(!text.includes('entry window closed ('), 'OUTSIDE_ENTRY_WINDOW is not presented as a filter');
  assert.match(scanWhyText({ scans: 0 }), /No scans in this replay session yet/);
  assert.match(scanWhyText(null), /no replay session/);
  const tw = PRESETS['tightwad-micro'];
  assert.equal(skipThresholdText('SPREAD_ABOVE_MAX', tw), `strategy: Max IEX spread ${formatFieldValue('entry.maxSpreadBps', tw.entry.maxSpreadBps)}`);
  assert.equal(skipThresholdText('HALTED', tw), null);
});

test('journal rows get a one-line human summary', () => {
  // TEST FIXTURE — NOT MARKET DATA
  const scan = journalRowSummary({ type: 'AGENT_SCAN', payload: { universe: 398, active: 63, scanned: 63, planned: [], positions: [], skipped: { OUTSIDE_ENTRY_WINDOW: 63, SPREAD_ABOVE_MAX: 45, RET_BELOW_MIN: 57 } } });
  assert.match(scan, /scanned 63 of 398 \(active 63\) · 0 planned · 0 positions · entry window closed · top failed checks: RET_BELOW_MIN 57, SPREAD_ABOVE_MAX 45/);
  assert.match(journalRowSummary({ type: 'FILL_ESTIMATED', payload_json: JSON.stringify({ side: 'sell', qty: 18, sym: 'ZVZZT', priceU: 5126 }) }), /^SELL 18 ZVZZT @ \$0\.5126 \(estimated paper fill\)$/);
  assert.match(journalRowSummary({ type: 'POLICY_DENY', payload: { decision: 'DENIED', reasons: [{ code: 'SPREAD_TOO_WIDE', detail: 'too wide' }] } }), /^DENIED: SPREAD_TOO_WIDE — too wide$/);
  assert.equal(journalRowSummary({ type: 'X', payload: null }), null);
  const rows = [{ type: 'AGENT_SCAN' }, { type: 'POLICY_DENY' }, { type: 'AGENT_SCAN' }];
  assert.deepEqual(visibleRows(rows, { hideScans: true, type: '' }), { shown: [{ type: 'POLICY_DENY' }], hidden: 2 });
  assert.equal(visibleRows(rows, { hideScans: true, type: 'AGENT_SCAN' }).shown.length, 3, 'an explicit AGENT_SCAN filter shows scans');
  assert.ok(!KNOWN_TYPES.includes('KILL_SWITCH'), 'no filter option that can never match');
  for (const t of ['KILL_SWITCH_ENGAGED', 'KILL_SWITCH_EFFECTS', 'KILL_SWITCH_RELEASED']) assert.ok(KNOWN_TYPES.includes(t));
});

// ---------------------------------------------------------------- hindsight lock, staleness

test('the retrospective study is locked until the replay clock reaches the session close', () => {
  const t1 = T0 + 390 * MIN;
  assert.equal(studyAccess({ ds: 'TEST-FIXTURE', clock: T0, t_end: t1 }).locked, true);
  assert.equal(studyAccess({ ds: 'TEST-FIXTURE', clock: t1 - 1, t_end: t1 }).locked, true);
  assert.equal(studyAccess({ ds: 'TEST-FIXTURE', clock: t1, t_end: t1 }).locked, false);
  assert.equal(studyAccess({ ds: 'TEST-FIXTURE', status: 'SESSION_CLOSED', clock: T0, t_end: t1 }).locked, false);
  assert.equal(studyAccess({ ds: 'TEST-FIXTURE', clock: null, t_end: t1 }).locked, true, 'unknown clock stays locked');
  assert.equal(studyAccess({ ds: null }).locked, false, 'no dataset: nothing to reveal (server answers BLOCKED)');
});

test('stored assessments show their age against the replay clock', () => {
  assert.equal(assessmentAge(T0, T0 + 10 * MIN).stale, false);
  const old = assessmentAge(T0, T0 + 330 * MIN);
  assert.equal(old.stale, true);
  assert.match(old.text, /^5h 30m before the replay clock$/);
  assert.equal(assessmentAge(null, T0).text, 'age unknown');
});

test('model state distinguishes "not configured" from a configured provider that is FAULT/DISCONNECTED', () => {
  assert.deepEqual(modelState({ status: 'DISCONNECTED', provider: 'none' }), { status: 'DISCONNECTED', configured: false, connected: false, provider: 'none', detail: null });
  const f = modelState({ status: 'FAULT', provider: 'anthropic', detail: 'SDK not installed' });
  assert.equal(f.configured, true);
  assert.equal(f.detail, 'SDK not installed');
  assert.equal(modelState({ status: 'CONNECTED', provider: 'openai-compatible' }).connected, true);
});

// ---------------------------------------------------------------- order ticket / replace / fills

test('an order review expires when the replay clock or session moves', () => {
  const ctx = { clock: T0 + 47 * MIN, session: 'sess_fixture' };
  assert.equal(reviewIsStale(ctx, { clock: T0 + 47 * MIN, session_id: 'sess_fixture' }), false);
  assert.equal(reviewIsStale(ctx, { clock: T0 + 48 * MIN, session_id: 'sess_fixture' }), true);
  assert.equal(reviewIsStale(ctx, { clock: T0 + 47 * MIN, session_id: 'other' }), true);
  assert.equal(reviewIsStale(null, { clock: 1 }), false);
});

test('replace requests carry only the changed terms and the confirmation', () => {
  // TEST FIXTURE — NOT MARKET DATA
  const o = { id: 'ord_fx2', side: 'buy', type: 'stop_limit', qty: 300, limit_px: 3100, stop_px: 3000 };
  assert.equal(replaceBody(o, { qty: 300, limitU: 3100, stopU: 3000 }), null);
  assert.deepEqual(replaceBody(o, { qty: 200, limitU: 3100, stopU: 3000 }), { qty: 200, confirm: true });
  assert.deepEqual(replaceBody(o, { qty: 300, limitU: 3050, stopU: 2990 }), { limit_px_u: 3050, stop_px_u: 2990, confirm: true });
});

test('fill provenance exposes the observed IEX data and labels never leak the "U" unit suffix', () => {
  // TEST FIXTURE — NOT MARKET DATA
  const observed = { minuteT: T0, startQuote: { bid: 5080, ask: 5090 }, minBid: 5070, trades: { l: 5070 } };
  const assumptions = { basePriceU: 5100, priceBasis: 'WORST_IN_MINUTE', fees: { secFeeU: 3, tafU: 2, totalU: 5, someNewU: 1 } };
  assert.deepEqual(fillProvenance({ assumptions, observed }), { assumptions, observed });
  assert.deepEqual(fillProvenance({ assumptions_json: JSON.stringify({ assumptions, observed }) }), { assumptions, observed }, 'stored wrapper shape');
  const labels = labelsFor(assumptions.fees, { secFeeU: 'SEC fee', tafU: 'FINRA TAF', totalU: 'Total fees' });
  assert.ok(Object.values(labels).every((l) => !/ U$/.test(l)), JSON.stringify(labels));
  assert.equal(labels.someNewU, 'Some New');
  assert.equal(fillEnumText('WORST_IN_MINUTE'), 'Worst price observed in the minute');
  assert.match(fillEnumText('STOP_SELL_TRIGGERED_FILL_AT_MIN(STOP, WORST_BID)'), /^Stop triggered: filled at the lower of the stop and the worst bid/);
  assert.equal(fillEnumText('SOME_NEW_RULE'), 'Some new rule');
});

test('sell estimates warn when the quantity exceeds the displayed IEX bid size', () => {
  // TEST FIXTURE — NOT MARKET DATA
  const quote = { bid: 5000, ask: 5100, bidSize: 100, askSize: 800, twoSided: true, ageMs: 1000, note: FIXTURE };
  const e = estimateOrder({ side: 'sell', orderType: 'market', qty: 500, quote, segment: 'micro', heldQty: 500 });
  assert.ok(e.warnings.some((w) => /displayed IEX bid size/.test(w)));
  const ok = estimateOrder({ side: 'sell', orderType: 'market', qty: 100, quote, segment: 'micro', heldQty: 500 });
  assert.ok(!ok.warnings.some((w) => /displayed IEX bid size/.test(w)));
});

// ---------------------------------------------------------------- strategy editor schema (validated by the server)

test('strategy edits convert owner units and can set or clear thresholds whose value is null', () => {
  const hw = structuredClone(PRESETS['handwritten-notes-example']);
  assert.equal(hw.entry.maxSpreadBps, null);
  const r = applyStrategyEdits(hw, { 'entry.maxSpreadBps': { value: '1500' }, 'entry.maxQuoteAgeMs': { value: '120' }, 'entry.maxPriceU': { value: '1' } });
  assert.deepEqual(r.errors, []);
  assert.equal(r.next.entry.maxSpreadBps, 1500);
  assert.equal(r.next.entry.maxQuoteAgeMs, 120000, 'seconds -> ms');
  assert.equal(r.next.entry.maxPriceU, 10000, 'one dollar -> 10000 u');
  assert.equal(validateStrategy(r.next).ok, true, JSON.stringify(validateStrategy(r.next).errors));

  const tw = structuredClone(PRESETS['tightwad-micro']);
  const r2 = applyStrategyEdits(tw, { 'entry.minBuyShare': { value: '65' }, 'entry.maxSpreadBps': { none: true }, 'exits.takeProfit': { none: true } });
  assert.deepEqual(r2.errors, []);
  assert.equal(r2.next.entry.minBuyShare, 0.65, 'percent -> fraction');
  assert.equal(r2.next.entry.maxSpreadBps, null, 'value -> no limit');
  assert.equal(r2.next.exits.takeProfit, null);
  assert.equal(validateStrategy(r2.next).ok, true, JSON.stringify(validateStrategy(r2.next).errors));

  const bad = applyStrategyEdits(tw, { 'entry.maxSpreadBps': { value: '' }, 'signal.windowMin': { value: '2.5' } });
  assert.equal(bad.errors.length, 2);
  assert.equal(applyStrategyEdits(tw, {}).changes.length, 0, 'unchanged values round-trip exactly');
  // Submitting the editor unchanged (every field filled from the current value, as the form does) changes nothing.
  for (const [id, preset] of Object.entries(PRESETS)) {
    const edits = {};
    for (const f of STRATEGY_FIELDS) {
      const v = getPath(preset, f.path);
      if (v === undefined) continue;
      if (f.kind === 'group') edits[f.path] = { none: v === null };
      else if (f.kind === 'bool') edits[f.path] = { value: !!v };
      else if (f.kind === 'enum') edits[f.path] = { value: v };
      else edits[f.path] = v === null ? { none: true } : { value: String(toUiValue(f, v)) };
    }
    const round = applyStrategyEdits(preset, edits);
    assert.deepEqual(round.errors, [], `${id} has no editor errors`);
    assert.deepEqual(round.changes, [], `${id} round-trips unchanged`);
    assert.equal(validateStrategy(round.next).ok, true);
  }
  assert.equal(fieldLabel('entry.maxQuoteAgeMs'), 'Max quote age (sec)');
  assert.equal(formatFieldValue('entry.maxPriceU', 10000), '$1.00');
  assert.equal(formatFieldValue('entry.minVolumeW', null), 'no limit');
  assert.ok(flattenStrategy(hw).some(([p]) => p === 'exits.takeProfit.alternative.multiple'), 'nested fields flatten to dotted paths');
});

test('presets offered to an agent match its segment; diffs and value text are readable', () => {
  const list = presetList(PRESETS);
  assert.equal(list.length, Object.keys(PRESETS).length);
  const micro = presetsFor(PRESETS, 'micro').map((p) => p.id);
  assert.ok(micro.includes('handwritten-notes-example'));
  assert.ok(presetsFor(PRESETS, 'large').every((p) => p.segment === 'large'));
  const diff = strategyDiff(PRESETS['tightwad-micro'], PRESETS['handwritten-notes-example']);
  assert.ok(diff.some(([p]) => p === 'entry.minRetPct'));
  assert.ok(!diff.some(([p]) => ['notes', 'label', 'name', 'id'].includes(p)), 'documentation fields are not listed as changes');
  assert.equal(strategyValueText('entry.maxPriceU', 10000), '$1.00');
  assert.match(strategyValueText('exits.takeProfit', { basis: 'pct_gain', pct: 20 }), /Take-profit basis Percent gain, Take-profit gain 20%/);
  const a = normAgent({ id: 'agent-cowboy-micro', strategy: PRESETS['cowboy-micro'], scan_summary: { scans: 3 } });
  assert.equal(a.scan_summary.scans, 3);
});

// ---------------------------------------------------------------- formatting, routing, charts, focus

test('extreme relative volume is capped for display, never altered', () => {
  assert.equal(fmtRelVol(42841.67), '>999×');
  assert.equal(fmtRelVol(999), '999×');
  assert.equal(fmtRelVol(2.345), '2.35×');
  assert.equal(fmtRelVol(null), '—');
  const o = normOpp({ sym: 'ZVZZT', name: `${FIXTURE} issuer - Warrant`, score: 12.5, metrics: { relVol: 42841.67, tradesW: 1, reasons: ['QUOTE_STALE'] } });
  assert.equal(o.relVol, 42841.67, 'the data keeps the exact value');
  assert.equal(o.tradesW, 1);
  assert.equal(o.score, 12.5);
  assert.equal(o.secType.code, 'WARRANT');
  assert.equal(securityTypeFromName(`${FIXTURE} issuer - Units`).code, 'UNIT');
  assert.equal(securityTypeFromName(`${FIXTURE} issuer - Rights`).code, 'RIGHT');
  assert.equal(securityTypeFromName(`${FIXTURE} issuer Common Stock`), null);
  assert.equal(reasonLabel('QUOTE_STALE'), 'Stale quote');
});

test('epoch-millisecond fields format as ET timestamps; durations and fractions stay readable', () => {
  const t = Date.UTC(2026, 9, 8, 1, 31); // invented instant
  assert.match(fmtByKey('fileCreationMs', t), /^2026-10-07 21:31:00 ET$/);
  assert.match(fmtByKey('openMs', t), /ET$/);
  assert.equal(fmtByKey('maxQuoteAgeMs', 300000), '5m 0s');
  assert.equal(fmtByKey('latency_ms', 950), '950 ms');
  assert.equal(fmtByKey('shortRatio', 0.0453), '4.53%');
});

test('segments: a labelled low-price small-cap proxy is offered and stored preferences are validated', () => {
  assert.deepEqual(Object.keys(SEGMENT_LABELS), ['micro', 'low', 'large']);
  assert.match(SEGMENT_LABELS.low, /proxy/);
  assert.equal(segmentPref('low'), 'low');
  assert.equal(segmentPref('bogus'), 'micro');
  assert.equal(segmentPref(undefined), 'micro');
});

test('agent state reasons are explained in plain language', () => {
  assert.match(stateReasonText('authority not implicitly resumed after restart'), /^Paused after a server restart/);
  assert.equal(stateReasonText('KILL_SWITCH_ENGAGED'), 'KILL_SWITCH_ENGAGED');
  assert.equal(stateReasonText(null), null);
});

test('the skip link fragment is not a route', () => {
  assert.equal(isRouteHash('#main'), false);
  assert.equal(isRouteHash('#/lab'), true);
  assert.equal(isRouteHash(''), true);
  assert.equal(parseHash('#/lab?sym=ZVZZT').view, 'lab');
});

test('chart axes: edge labels are anchored inside the plot, at least four time ticks, distinct end labels', () => {
  assert.equal(tickAnchor(320, 56, 325), 'end');
  assert.equal(tickAnchor(60, 56, 325), 'start');
  assert.equal(tickAnchor(200, 56, 325), 'middle');
  // ui-polish-v1: legibility first. A phone-width axis keeps >= 3 time references with labels >= 64 px apart (they
  // touched at 13 px before); a wider axis still gets >= 4.
  const phoneTicks = timeTicks(T0, T0 + 390 * MIN, 260);
  assert.ok(phoneTicks.length >= 3, 'a phone-width session axis has >= 3 labels');
  assert.ok(260 / phoneTicks.length >= 64, 'phone-width labels are at least ~64 px apart');
  assert.ok(timeTicks(T0, T0 + 75 * MIN, 300).length * 64 <= 300, 'a 75-minute phone axis does not crowd its labels');
  assert.ok(timeTicks(T0, T0 + 390 * MIN, 1000).length >= 4, 'a wide session axis has >= 4 labels');
  const ys = spreadLabels([100, 101, 102, 300], 13, 10, 400);
  const sorted = [...ys].sort((a, b) => a - b);
  for (let i = 1; i < sorted.length; i++) assert.ok(sorted[i] - sorted[i - 1] >= 13 - 1e-9, 'labels never overlap');
  assert.deepEqual(endLabelNames(['ZVZZT', 'ZWZZT']), ['ZVZZT', 'ZWZZT']);
  const long = endLabelNames(['FIXTURE-BENCH-A', 'FIXTURE-BENCH-B']);
  assert.equal(new Set(long).size, 2);
});

test('preserveFocus moves focus to the re-rendered control with the same data-focus-key', () => {
  const live = new Set();
  const mk = (key) => {
    const el = { key, getAttribute: (n) => (n === 'data-focus-key' ? key : null), get isConnected() { return live.has(el); }, focus() { globalThis.document.activeElement = el; } };
    return el;
  };
  const oldBtn = mk('step-5');
  live.add(oldBtn);
  let newBtn = null;
  const container = { contains: (el) => live.has(el), querySelectorAll: () => [...live] };
  const prev = globalThis.document;
  globalThis.document = { activeElement: oldBtn };
  try {
    preserveFocus(container, () => { live.delete(oldBtn); newBtn = mk('step-5'); live.add(mk('other')); live.add(newBtn); });
    assert.equal(globalThis.document.activeElement, newBtn);
  } finally {
    globalThis.document = prev;
  }
});

test('research list pages through rows in rank order', () => {
  const rows = Array.from({ length: 60 }, (_, i) => ({ sym: `Z${String.fromCharCode(65 + (i % 26))}ZZT`, name: `${FIXTURE} ${i}` }));
  const p = pageRows(rows, '', PAGE_SIZE);
  assert.equal(p.shown.length, PAGE_SIZE);
  assert.equal(p.shown[0], rows[0]);
  assert.equal(p.matching, 60);
  assert.equal(pageRows(rows, '', PAGE_SIZE * 3).shown.length, 60);
  assert.equal(pageRows(rows, 'zazzt', PAGE_SIZE).matching, 3);
});

test('billable model calls send the confirmation the server requires and a long client timeout', async () => {
  const fs = await import('node:fs');
  const src = (f) => fs.readFileSync(new URL(`../../web/js/views/${f}`, import.meta.url), 'utf8');
  assert.match(src('research.js'), /api\.post\('\/api\/assessments\/run', \{ sym, confirm: true \}, \{ timeoutMs \}\)/);
  assert.match(src('sources.js'), /api\.post\('\/api\/model\/test', \{ confirm: true \}, \{ timeoutMs: api\.MODEL_TEST_TIMEOUT_MS \}\)/);
  assert.match(src('replay.js'), /timeoutMs: api\.stepTimeoutMs\(/);
});
