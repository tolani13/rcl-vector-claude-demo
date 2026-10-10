// Unit tests for the DOM-free front-end modules (formatting, routing, pre-submit estimate, response normalisers).
// TEST FIXTURE — NOT MARKET DATA: every quote, price and symbol below is an invented value used only to exercise
// software behaviour. Symbols use IEX-style test-symbol shapes and must never appear in product code.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  fmtUsdU, fmtPriceU, fmtEt, fmtEtDate, fmtPct, fmtFracPct, fmtAge, usdToU, statusTone, isStatusCode, humanizeKey, portfolioLabel, num,
} from '../../web/js/format.js';
import { parseHash, tabFor, normalizeSym } from '../../web/js/router.js';
import { estimateOrder, sellFeesU, isValidTick, roundToTick, slip } from '../../web/js/estimate.js';
import { normOpp, rowsOf } from '../../web/js/views/common.js';
import { normPortfolio } from '../../web/js/views/lab.js';
import { normAgent } from '../../web/js/views/agents.js';
import { normAssessments } from '../../web/js/views/research.js';

const FIXTURE = 'TEST FIXTURE — NOT MARKET DATA';

test('money and price formatting follow u = 1e-4 USD', () => {
  assert.equal(fmtUsdU(12200), '$1.22');
  assert.equal(fmtUsdU(1234), '$0.1234');
  assert.equal(fmtUsdU(-5000000, { sign: true }), '-$500.00');
  assert.equal(fmtUsdU(100000000, { sign: true }), '+$10,000.00');
  assert.equal(fmtUsdU(null), '—');
  assert.equal(fmtPriceU(9999), '$0.9999');
  assert.equal(fmtPriceU(123400), '$12.34');
  assert.equal(usdToU('1.2345'), 12345);
  assert.equal(usdToU('x'), null);
  assert.equal(num('42'), 42);
  assert.equal(num(''), null);
});

test('timestamps render in America/New_York including DST', () => {
  // 2026-10-07 13:30:00Z = 09:30 EDT; 2026-12-01 14:30:00Z = 09:30 EST
  assert.equal(fmtEt(Date.UTC(2026, 9, 7, 13, 30)), '09:30 ET');
  assert.equal(fmtEt(Date.UTC(2026, 11, 1, 14, 30), { date: true, seconds: true }), '2026-12-01 09:30:00 ET');
  assert.equal(fmtEtDate(Date.UTC(2026, 9, 7, 3, 0)), '2026-10-06');
  assert.equal(fmtEt(undefined), '—');
});

test('percent, age and labels', () => {
  assert.equal(fmtPct(1.234), '+1.23%');
  assert.equal(fmtPct(-0.5), '−0.50%');
  assert.equal(fmtFracPct(0.22), '+22.00%');
  assert.equal(fmtAge(42000), '42s');
  assert.equal(fmtAge(192000), '3m 12s');
  assert.equal(humanizeKey('last_event_ts'), 'Last event ts');
  assert.equal(humanizeKey('quoteAgeMs'), 'Quote Age Ms');
  assert.equal(portfolioLabel('cowboy-micro'), 'Cowboy · Microcap');
  assert.equal(portfolioLabel('sandbox'), 'Sandbox (human)');
});

test('status vocabulary tones', () => {
  assert.equal(statusTone('HISTORICAL_REAL'), 'ok');
  assert.equal(statusTone('NO_VERIFIED_DATA'), 'warn');
  assert.equal(statusTone('PROVIDER_FAULT'), 'bad');
  assert.equal(statusTone('UNAVAILABLE_NOT_VERIFIED'), 'neutral');
  assert.ok(isStatusCode('NO_VERIFIED_OPTIONS_DATA'));
  assert.ok(isStatusCode('ACCEPTED'));
  assert.ok(!isStatusCode('Just a sentence'));
});

test('hash router', () => {
  assert.deepEqual(parseHash(''), { view: 'overview', sym: null, invalidSym: null, query: {}, notFound: false });
  assert.equal(parseHash('#/research/zvzzt').sym, 'ZVZZT');
  assert.equal(parseHash('#/research/<script>').invalidSym, '<script>');
  assert.equal(parseHash('#/research/<script>').sym, null);
  assert.deepEqual(parseHash('#/lab?sym=ZVZZT&p=sandbox').query, { sym: 'ZVZZT', p: 'sandbox' });
  assert.equal(parseHash('#/nope').notFound, true);
  assert.equal(parseHash('#/nope').view, 'overview');
  assert.equal(tabFor('agents'), 'more');
  assert.equal(tabFor('journal'), 'journal');
  assert.equal(normalizeSym(' brk.b '), 'BRK.B');
  assert.equal(normalizeSym('1ABC'), null);
});

test('Reg NMS 612 tick helpers', () => {
  assert.ok(isValidTick(12300));      // $1.23
  assert.ok(!isValidTick(12345));     // $1.2345 not allowed >= $1
  assert.ok(isValidTick(1234));       // $0.1234 allowed < $1
  assert.ok(!isValidTick(0));
  assert.equal(roundToTick(12345, 'buy'), 12400);
  assert.equal(roundToTick(12345, 'sell'), 12300);
  assert.equal(slip(10000, 50, 'buy'), 10100);   // $1.00 + 50 bps = $1.005 -> rounded up to $1.01
  assert.equal(slip(5000, 50, 'sell'), 4975);
});

// TEST FIXTURE — NOT MARKET DATA
const quote = { sym: 'ZVZZT', bid: 5000, ask: 5100, bidSize: 1000, askSize: 800, twoSided: true, spreadBps: 198, ageMs: 30000, halted: false, quoteTs: 1, note: FIXTURE };

test('estimate: market buy by budget uses ask + slippage and floors whole shares', () => {
  const e = estimateOrder({ side: 'buy', orderType: 'market', budgetU: 500000, quote, segment: 'micro', cashU: 1000000 });
  assert.equal(e.ok, true);
  assert.equal(e.priceU, slip(5100, 50, 'buy'));           // 5126 u
  assert.equal(e.qty, Math.floor(500000 / e.priceU));
  assert.equal(e.fees.total, 0);
  assert.equal(e.totalU, e.qty * e.priceU);
  assert.deepEqual(e.warnings, []);
});

test('estimate: market sell applies SEC fee and capped TAF (rounded up)', () => {
  const f = sellFeesU(1000, 4975);
  assert.equal(f.sec, Math.ceil((1000 * 4975 * 27.8) / 1e6));
  assert.equal(f.taf, Math.ceil(1000 * 1.66));
  assert.equal(sellFeesU(100000, 10000).taf, 83000, 'TAF cap');
  const e = estimateOrder({ side: 'sell', orderType: 'market', qty: 1000, quote, segment: 'micro', heldQty: 500 });
  assert.equal(e.ok, true);
  assert.equal(e.priceU, 4975);
  assert.equal(e.totalU, 1000 * 4975 - e.fees.total);
  assert.ok(e.warnings.some((w) => /no shorting/.test(w)));
});

test('estimate: refuses to estimate without a two-sided quote', () => {
  assert.equal(estimateOrder({ side: 'buy', orderType: 'market', qty: 10, quote: null }).status, 'NO_VERIFIED_DATA');
  assert.equal(estimateOrder({ side: 'buy', orderType: 'market', qty: 10, quote: { ...quote, bid: null, twoSided: false } }).status, 'NO_VERIFIED_DATA');
});

test('estimate: limits, stops and warnings', () => {
  const lim = estimateOrder({ side: 'buy', orderType: 'limit', limitU: 4900, qty: 10, quote });
  assert.equal(lim.priceU, 4900);
  assert.ok(lim.warnings.some((w) => /may not fill/.test(w)));
  const stop = estimateOrder({ side: 'sell', orderType: 'stop', stopU: 4500, qty: 10, quote });
  assert.equal(stop.priceU, slip(4500, 50, 'sell'));
  assert.match(stop.basis, /WORSE than the stop/);
  assert.equal(estimateOrder({ side: 'buy', orderType: 'stop_limit', stopU: 5200, qty: 1, quote }).status, 'INVALID');
  const poor = estimateOrder({ side: 'buy', orderType: 'market', qty: 1000, quote: { ...quote, halted: true, ageMs: 9e6 }, cashU: 1 });
  assert.ok(poor.warnings.length >= 4, 'halted, stale, size cap, cash');
  assert.equal(estimateOrder({ side: 'buy', orderType: 'market', budgetU: 10, quote }).status, 'INSUFFICIENT_BUDGET');
  assert.equal(estimateOrder({ side: 'buy', orderType: 'market', qty: 1, quote, segment: 'large' }).slippageBps, 5);
});

test('normalisers tolerate missing fields and alternative shapes', () => {
  assert.deepEqual(rowsOf({ rows: [1] }), [1]);
  assert.deepEqual(rowsOf([2]), [2]);
  assert.deepEqual(rowsOf({ portfolios: [3] }, 'portfolios'), [3]);
  assert.deepEqual(rowsOf(null), []);

  // TEST FIXTURE — NOT MARKET DATA
  const o = normOpp({ sym: 'ZXZZT', priceU: 4321, metrics: { ret_w: 0.1, buyShare: null, reasons: ['thin'] }, quote: { spreadBps: 77, ageMs: 5 } });
  assert.equal(o.sym, 'ZXZZT');
  assert.equal(o.spreadBps, 77);
  assert.equal(o.buyShare, null);
  assert.deepEqual(o.reasons, ['thin']);
  assert.equal(normOpp({}).sym, null);

  const p = normPortfolio({ portfolio: { id: 'sandbox', starting_cash: 100000000 }, cashU: 90000000, equityU: 99000000, positions: [{ sym: 'ZXZZT', qty: 10, cost_basis: 50000, markBasis: 'IEX_BID' }] });
  assert.equal(p.id, 'sandbox');
  assert.equal(p.pnlU, -1000000);
  assert.equal(p.positions[0].costU, 50000);
  const bare = normPortfolio({ id: 'cowboy-micro', cash: 5 });
  assert.equal(bare.cashU, 5);
  assert.equal(bare.pnlU, null, 'no equity -> no P&L, never a guess');

  const a = normAgent({ id: 'agent-x', state: 'PAUSED', strategy_json: '{"decisionMode":"rules","maxTradeUsd":1}', last_fail_json: '{"type":"POLICY_DENY"}' });
  assert.equal(a.decisionMode, 'rules');
  assert.equal(a.last_fail.type, 'POLICY_DENY');
  assert.equal(normAgent(null).id, null);

  const by = normAssessments([
    { lens: 'cowboy', status: 'OK', created_wall: 1, output_json: '{"stance":"watch"}' },
    { lens: 'cowboy', status: 'OK', created_wall: 2, output: { stance: 'avoid' } },
    { lens: 'tightwad', status: 'REFUSED' },
    { lens: 'not-a-lens', status: 'OK' },
  ]);
  assert.equal(by.cowboy.output.stance, 'avoid', 'latest per lens wins');
  assert.equal(by.tightwad.status, 'REFUSED');
  assert.equal(by.pragmatist, undefined);
  assert.equal(Object.keys(by).length, 2);
  assert.deepEqual(Object.keys(normAssessments({ pragmatist: { status: 'OK', output: {} } })), ['pragmatist']);
  assert.deepEqual(normAssessments({ status: 'MODEL_DISCONNECTED' }), {});
});
