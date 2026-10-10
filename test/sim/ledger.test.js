// TEST FIXTURE — NOT MARKET DATA. Ledger tests over a temp DB with synthetic minute rows.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createSessionPortfolios, applyFill, markToMarket, portfolioSummary, getPortfolio, getPosition, PORTFOLIO_IDS, DEFAULT_STARTING_CASH_U } from '../../server/sim/ledger.js';
import { verifyChain } from '../../server/journal.js';
import { setupScenario, openTestDb, addMinute, at, FIXTURE_DS, MINUTE, journalRows } from './helpers/fixture.js';

const fakeFill = (o) => ({ qty: 100, priceU: 5000, feesU: 0, ts: at(10, 0), assumptions: { model: 'iex-conservative-minute-v1', label: 'TEST FIXTURE — NOT MARKET DATA' }, observed: { label: 'TEST FIXTURE — NOT MARKET DATA' }, ...o });
const ord = (o) => ({ id: 'ord_test', portfolio_id: 'sandbox', instrument_id: 'FIXA', sym: 'FIXA', kind: 'equity', side: 'buy', role: 'manual', agent_id: null, ...o });

test('createSessionPortfolios creates 7 portfolios with configurable starting cash; idempotent', () => {
  const s = openTestDb('ledger-create');
  try {
    const rows = createSessionPortfolios(s.db, 'S1');
    assert.deepEqual(rows.map((r) => r.id), [...PORTFOLIO_IDS]);
    assert.equal(rows.length, 7);
    assert.deepEqual(rows.map((r) => r.id), ['cowboy-micro', 'pragmatist-micro', 'tightwad-micro', 'cowboy-large', 'pragmatist-large', 'tightwad-large', 'sandbox']);
    const sb = rows.find((r) => r.id === 'sandbox');
    assert.deepEqual([sb.kind, sb.lens, sb.segment], ['sandbox', null, null]);
    assert.ok(rows.every((r) => r.cash === DEFAULT_STARTING_CASH_U && r.starting_cash === 100_000_000 && r.day_start_equity === r.cash));
    const again = createSessionPortfolios(s.db, 'S1', { startingCashU: 5 });
    assert.equal(again.length, 7, 'idempotent: existing portfolios untouched');
    assert.equal(again[0].cash, DEFAULT_STARTING_CASH_U);

    const custom = createSessionPortfolios(s.db, 'S2', { startingCashU: { sandbox: 2_500_000, 'cowboy-micro': 50_000_000 } });
    assert.equal(custom.find((r) => r.id === 'sandbox').cash, 2_500_000);
    assert.equal(custom.find((r) => r.id === 'cowboy-micro').cash, 50_000_000);
    assert.equal(custom.find((r) => r.id === 'tightwad-large').cash, DEFAULT_STARTING_CASH_U);
    assert.throws(() => createSessionPortfolios(s.db, 'S3', { startingCashU: { nope: 1 } }), /unknown portfolio id/);
    assert.throws(() => createSessionPortfolios(s.db, 'S4', { startingCashU: -1 }), /positive integer/);
    assert.throws(() => createSessionPortfolios(s.db, 'S5', { startingCashU: 1.5 }), /positive integer/);
    assert.ok(verifyChain(s.db).ok);
  } finally { s.cleanup(); }
});

test('applyFill: buy then partial sell updates cash, cost basis pro-rata, realized P&L, fees; fills row is estimated', () => {
  const s = setupScenario('ledger-apply');
  try {
    const { db, session_id } = s;
    const b = applyFill(db, { session_id, order: ord({}), fill: fakeFill({ qty: 300, priceU: 5000, feesU: 0 }) });
    assert.equal(b.cashU, 100_000_000 - 1_500_000);
    assert.equal(b.positionQty, 300);
    assert.equal(getPosition(db, session_id, 'sandbox', 'FIXA').cost_basis, 1_500_000);

    const sell = applyFill(db, { session_id, order: ord({ id: 'ord_s', side: 'sell' }), fill: fakeFill({ qty: 100, priceU: 6000, feesU: 30, ts: at(10, 5) }) });
    // proceeds 600,000 - 30 ; cost removed 1,500,000 x 100/300 = 500,000 ; realized = 99,970
    assert.equal(sell.realizedDeltaU, 99_970);
    assert.equal(sell.positionQty, 200);
    assert.equal(getPosition(db, session_id, 'sandbox', 'FIXA').cost_basis, 1_000_000);
    const pf = getPortfolio(db, session_id, 'sandbox');
    assert.equal(pf.cash, 100_000_000 - 1_500_000 + 599_970);
    assert.equal(pf.realized_pnl, 99_970);
    assert.equal(pf.fees_paid, 30);

    const close = applyFill(db, { session_id, order: ord({ id: 'ord_c', side: 'sell' }), fill: fakeFill({ qty: 200, priceU: 4000, feesU: 10, ts: at(10, 6) }) });
    assert.equal(close.realizedDeltaU, 800_000 - 10 - 1_000_000);
    assert.equal(getPosition(db, session_id, 'sandbox', 'FIXA'), null, 'closed position row removed');

    const fills = db.prepare('SELECT * FROM fills WHERE session_id = ? ORDER BY ts').all(session_id);
    assert.equal(fills.length, 3);
    assert.ok(fills.every((f) => f.estimated === 1 && f.model === 'iex-conservative-minute-v1'));
    assert.ok(JSON.parse(fills[0].assumptions_json).observed);
    const fe = journalRows(db, session_id).filter((r) => r.type === 'FILL_ESTIMATED');
    assert.equal(fe.length, 3);
    assert.equal(fe[0].payload.estimated, true);
    assert.match(fe[0].payload.note, /ESTIMATED PAPER FILL/);
    assert.ok(verifyChain(db).ok);
  } finally { s.cleanup(); }
});

test('applyFill invariants: overspend and oversell throw and leave no partial writes', () => {
  const s = setupScenario('ledger-invariants', { startingCashU: { sandbox: 1_000_000 } });
  try {
    const { db, session_id } = s;
    const before = journalRows(db, session_id).length;
    assert.throws(() => applyFill(db, { session_id, order: ord({}), fill: fakeFill({ qty: 300, priceU: 5000 }) }), /INVARIANT_CASH_NEGATIVE/);
    assert.equal(getPortfolio(db, session_id, 'sandbox').cash, 1_000_000);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM fills').get().n, 0);
    assert.equal(journalRows(db, session_id).length, before, 'journal entry rolled back with the failed fill');

    applyFill(db, { session_id, order: ord({}), fill: fakeFill({ qty: 100, priceU: 5000 }) });
    assert.throws(() => applyFill(db, { session_id, order: ord({ side: 'sell' }), fill: fakeFill({ qty: 101, priceU: 5000 }) }), /INVARIANT_OVERSELL/);
    assert.throws(() => applyFill(db, { session_id, order: ord({ side: 'sell', instrument_id: 'FIXZ', sym: 'FIXZ' }), fill: fakeFill({ qty: 1 }) }), /INVARIANT_OVERSELL/, 'selling something not held is a short sale');
    assert.equal(getPosition(db, session_id, 'sandbox', 'FIXA').qty, 100);
    assert.throws(() => applyFill(db, { session_id, order: ord({}), fill: fakeFill({ qty: 1.5 }) }), /positive integer/);
    assert.ok(verifyChain(db).ok);
  } finally { s.cleanup(); }
});

test('markToMarket uses the IEX bid as-of (no look-ahead), falls back to last trade, else UNMARKED', () => {
  const s = setupScenario('ledger-mtm');
  try {
    const { db, session_id } = s;
    addMinute(db, FIXTURE_DS, 'FIXA', at(10, 0), { bid: 5000, ask: 5100, trades: { o: 5050, h: 5050, l: 5050, c: 5050, v: 100, n: 1 } });
    addMinute(db, FIXTURE_DS, 'FIXA', at(10, 1), { bid: 5500, ask: 5600 });
    addMinute(db, FIXTURE_DS, 'FIXB', at(10, 0), { noQuote: true, trades: { o: 2000, h: 2000, l: 2000, c: 2000, v: 10, n: 1 } });
    applyFill(db, { session_id, order: ord({}), fill: fakeFill({ qty: 100, priceU: 5100 }) });
    applyFill(db, { session_id, order: ord({ id: 'b', instrument_id: 'FIXB', sym: 'FIXB' }), fill: fakeFill({ qty: 10, priceU: 2000 }) });
    applyFill(db, { session_id, order: ord({ id: 'c', instrument_id: 'FIXC', sym: 'FIXC' }), fill: fakeFill({ qty: 10, priceU: 3000 }) });

    const m1 = markToMarket(db, FIXTURE_DS, session_id, 'sandbox', at(10, 1));
    const a1 = m1.positions.find((p) => p.sym === 'FIXA');
    assert.deepEqual([a1.markU, a1.markBasis], [5000, 'IEX_BID'], 'the 10:01 row is not knowable until 10:02');
    assert.equal(a1.valueU, 500_000);
    assert.equal(a1.unrealizedU, 500_000 - 510_000);
    const a2 = markToMarket(db, FIXTURE_DS, session_id, 'sandbox', at(10, 2)).positions.find((p) => p.sym === 'FIXA');
    assert.equal(a2.markU, 5500);
    const b = m1.positions.find((p) => p.sym === 'FIXB');
    assert.deepEqual([b.markU, b.markBasis], [2000, 'LAST_TRADE_NO_BID']);
    const c = m1.positions.find((p) => p.sym === 'FIXC');
    assert.deepEqual([c.markU, c.markBasis, c.valueU], [null, 'UNMARKED', null]);
    assert.equal(m1.unmarkedCount, 1);

    const sum = portfolioSummary(db, FIXTURE_DS, session_id, 'sandbox', at(10, 2));
    assert.equal(sum.cashU, 100_000_000 - 510_000 - 20_000 - 30_000);
    assert.equal(sum.equityU, sum.cashU + 550_000 + 20_000, 'unmarked position counted at 0 (conservative)');
    assert.equal(sum.equityBasis, 'CONSERVATIVE_UNMARKED_POSITIONS_AT_ZERO');
    assert.equal(sum.positions.length, 3);
    assert.deepEqual(sum.openOrders, []);
    for (const k of ['portfolio', 'cashU', 'equityU', 'unrealizedU', 'realizedU', 'feesU', 'positions', 'openOrders']) assert.ok(k in sum, k);

    const none = markToMarket(db, null, session_id, 'sandbox', at(10, 2));
    assert.ok(none.positions.every((p) => p.markBasis === 'UNMARKED' && p.status === 'NO_VERIFIED_DATA'));
  } finally { s.cleanup(); }
});
