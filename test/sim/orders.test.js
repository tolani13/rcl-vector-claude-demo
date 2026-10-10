// TEST FIXTURE — NOT MARKET DATA. Orders engine tests (docs/CONTRACTS.md sections 2 and 4) over temp DBs with
// hand-written synthetic minute rows (FIX* symbols, 2099 trade date). Writes receipts/journal-samples/fixture-sim-*.json.
import test from 'node:test';
import assert from 'node:assert/strict';
import { submitOrder, cancelOrder, replaceOrder, processMinute, expireOrders, getOrder, validateOrderSpec } from '../../server/sim/orders.js';
import { getPosition, getPortfolio, listOpenOrders } from '../../server/sim/ledger.js';
import { verifyChain } from '../../server/journal.js';
import { setupScenario, addMinute, at, FIXTURE_DS, MINUTE, journalRows, writeJournalSample } from './helpers/fixture.js';

const SYM = 'FIXB';

/** Synthetic flat minutes from..to (inclusive): quote bid/ask with sizes; one small print at the bid. */
function flat(db, sym, from, to, { bid = 4990, ask = 5000, bsz = 1000, asz = 1000, extra = {} } = {}) {
  for (let t = from; t <= to; t += MINUTE) {
    addMinute(db, FIXTURE_DS, sym, t, { bid, ask, bsz, asz, trades: { o: bid, h: bid, l: bid, c: bid, v: 100, n: 1 }, ...extra });
  }
}

/** Process each completed minute from..to (inclusive) at clock t + 60 s. */
function run(s, from, to) {
  const out = [];
  for (let t = from; t <= to; t += MINUTE) out.push(processMinute(s.db, s.ctx(t + MINUTE), t));
  return out;
}

const rowsOf = (s, type) => journalRows(s.db, s.session_id).filter((r) => r.type === type);
const fillsOf = (s, orderId) => rowsOf(s, 'FILL_ESTIMATED').filter((r) => r.payload.order_id === orderId);
const held = (s, pf = 'sandbox', sym = SYM) => getPosition(s.db, s.session_id, pf, sym)?.qty ?? 0;
const buy = (extra) => ({ portfolio_id: 'sandbox', sym: SYM, side: 'buy', type: 'market', qty: 100, actor: 'human', ...extra });

/** Open protective qty (remaining) of the open sell orders on SYM. */
function openProtectiveQty(s) {
  return listOpenOrders(s.db, s.session_id, 'sandbox').filter((o) => o.side === 'sell' && o.protective === 1)
    .map((o) => o.qty - o.filled_qty);
}

// ---------------------------------------------------------------------------------------------------------------
// Bracket: partial entry, then the stop fills -> entry remainder cancelled; deterministic across runs.

function bracketPartialEntryStop(name) {
  const s = setupScenario(name);
  const { db } = s;
  // TEST FIXTURE tape: displayed ask size 100 (so a 500-share market entry fills 100 per minute); the bid gaps to 4400 at 10:01.
  flat(db, SYM, at(9, 58), at(10, 0), { asz: 100 });
  addMinute(db, FIXTURE_DS, SYM, at(10, 1), { bid: 4400, ask: 4410, bsz: 1000, asz: 100, minBid: 4400, maxBid: 4990, minAsk: 4410, maxAsk: 5000,
    trades: { o: 4900, h: 4900, l: 4400, c: 4400, v: 2000, n: 10 } });
  flat(db, SYM, at(10, 2), at(10, 6), { bid: 4400, ask: 4410, asz: 100 });
  const r = submitOrder(db, s.ctx(at(10, 0)), buy({ qty: 500, attach: { stop_loss_px_u: 4500, take_profit_px_u: 6000 } }));
  assert.equal(r.ok, true, JSON.stringify(r));
  run(s, at(10, 0), at(10, 6));
  const [stop, tp] = r.children;
  return { s, entry: getOrder(db, r.order.id), stop: getOrder(db, stop.id), tp: getOrder(db, tp.id) };
}

test('bracket: after the stop fills, a partially filled entry is cancelled (no unprotected later buys)', () => {
  const { s, entry, stop, tp } = bracketPartialEntryStop('bracket-stop');
  try {
    assert.deepEqual([entry.status, entry.filled_qty, entry.reason], ['cancelled', 100, 'PARENT_REMAINDER_CANCELLED_AFTER_PROTECTIVE_EXIT']);
    assert.deepEqual([stop.status, stop.filled_qty, stop.qty], ['filled', 100, 100]);
    assert.deepEqual([tp.status, tp.reason], ['cancelled', 'OCO_SIBLING_FILLED']);
    assert.equal(held(s), 0, 'final position = shares bought before the stop (100) minus the stop sale');
    assert.deepEqual(openProtectiveQty(s), [], 'nothing held, nothing protective left open');
    assert.equal(fillsOf(s, entry.id).length, 1, 'the entry bought only in the 10:00 minute');
    const canc = rowsOf(s, 'ORDER_CANCELLED').find((x) => x.ref_id === entry.id);
    assert.equal(canc.actor, 'engine');
    assert.equal(canc.payload.reason, 'PARENT_REMAINDER_CANCELLED_AFTER_PROTECTIVE_EXIT');
    assert.equal(canc.payload.child_order_id, stop.id);
    assert.equal(canc.payload.unfilledQty, 400);
    assert.equal(canc.payload.minuteT, at(10, 1));
    const sf = fillsOf(s, stop.id)[0];
    assert.equal(sf.payload.qty, 100);
    assert.equal(sf.payload.priceU, 4378, 'p(min(S 4500, minBid 4400)) = floor(4400 x 0.995)');
    assert.equal(sf.payload.worseThanStop, true, 'the bid gapped through the stop');
    assert.ok(verifyChain(s.db).ok);
    writeJournalSample(s.db, 'bracket-protective-exit', {
      session_id: s.session_id,
      covers: ['partial bracket entry', 'triggered stop (gap)', 'entry remainder cancelled after protective exit', 'OCO sibling cancel'],
      description: 'Market entry of 500 with an attached stop/take-profit; displayed ask size 100 fills it 100 at a time. The bid gaps through the stop at 10:01: the stop sells the 100 held, the take-profit is cancelled (OCO) and the entry remainder (400) is cancelled with PARENT_REMAINDER_CANCELLED_AFTER_PROTECTIVE_EXIT, so no later entry fill is left without a protective order.',
    });
  } finally { s.cleanup(); }
});

test('bracket outcome is identical across repeated runs (no random tie-break)', () => {
  const sig = [];
  const realNow = Date.now;
  for (let i = 0; i < 12; i++) {
    // Force every order id into the same millisecond so only the random suffix differs.
    Date.now = () => 4_070_000_000_000;
    let res;
    try { res = bracketPartialEntryStop(`bracket-det-${i}`); } finally { Date.now = realNow; }
    try {
      const { s, entry, stop, tp } = res;
      const types = journalRows(s.db, s.session_id).map((r) => r.type).join(',');
      sig.push(JSON.stringify({ o: [entry, stop, tp].map((o) => [o.role, o.status, o.qty, o.filled_qty, o.reason]), held: held(s), types }));
    } finally { res.s.cleanup(); }
  }
  assert.equal(new Set(sig).size, 1, 'every run gives the same orders, position and journal sequence');
});

test('a bracket child never sells shares the entry bought in the same minute; growth applies from the next minute', () => {
  const s = setupScenario('bracket-same-minute');
  try {
    const { db } = s;
    flat(db, SYM, at(9, 58), at(10, 1), { asz: 100 });
    // TEST FIXTURE: at 10:02 a print trades through the take-profit (6000); the quote rule does not fill (minBid carried in).
    addMinute(db, FIXTURE_DS, SYM, at(10, 2), { bid: 6050, ask: 6060, bsz: 1000, asz: 100, minBid: 4990, maxBid: 6050, minAsk: 5000, maxAsk: 6060,
      trades: { o: 5100, h: 6100, l: 5100, c: 6050, v: 5000, n: 20 } });
    flat(db, SYM, at(10, 3), at(10, 5), { bid: 6050, ask: 6060, asz: 100 });
    const r = submitOrder(db, s.ctx(at(10, 0)), buy({ qty: 500, attach: { stop_loss_px_u: 4500, take_profit_px_u: 6000 } }));
    const [stop, tp] = r.children;
    run(s, at(10, 0), at(10, 1));
    // 10:00 bought 100 (children activated at 100); 10:01: children evaluated first (no fill), then the entry bought 100 more.
    assert.equal(held(s), 200);
    const upd = rowsOf(s, 'BRACKET_CHILD_QTY_UPDATED').filter((x) => x.payload.minuteT === at(10, 1));
    assert.equal(upd.length, 2);
    assert.ok(upd.every((x) => x.payload.previousQty === 100 && x.payload.qty === 200 && x.payload.eligibleFromMinute === at(10, 2)));
    run(s, at(10, 2), at(10, 5));
    const tf = fillsOf(s, tp.id);
    assert.equal(tf.length, 1);
    assert.equal(tf[0].payload.qty, 200, 'sells the shares held at the minute start, nothing bought in the 10:02 minute');
    assert.equal(tf[0].payload.priceU, 6000);
    assert.equal(fillsOf(s, r.order.id).length, 2, 'entry filled at 10:00 and 10:01 only; cancelled before it was evaluated at 10:02');
    assert.equal(getOrder(db, r.order.id).reason, 'PARENT_REMAINDER_CANCELLED_AFTER_PROTECTIVE_EXIT');
    assert.equal(getOrder(db, stop.id).status, 'cancelled');
    assert.equal(held(s), 0);
    assert.ok(verifyChain(db).ok);
  } finally { s.cleanup(); }
});

test('partial take-profit: entry remainder cancelled; open protective qty never exceeds the position', () => {
  const s = setupScenario('bracket-tp-partial');
  try {
    const { db } = s;
    flat(db, SYM, at(9, 58), at(10, 0), { asz: 300 });
    // 10:01: the bid jumps above the take-profit but only 120 shares are displayed on the bid at the minute start.
    addMinute(db, FIXTURE_DS, SYM, at(10, 1), { bid: 6100, ask: 6110, bsz: 120, asz: 300, minBid: 6100, maxBid: 6100, minAsk: 6110, maxAsk: 6110,
      trades: { o: 6100, h: 6100, l: 6100, c: 6100, v: 500, n: 3 } });
    flat(db, SYM, at(10, 2), at(10, 3), { bid: 5500, ask: 5510, bsz: 1000, asz: 300 });
    // The 10:00 row is the carried-in quote for 10:01: give it a 120-share bid.
    addMinute(db, FIXTURE_DS, SYM, at(10, 0), { bid: 4990, ask: 5000, bsz: 120, asz: 300, trades: { o: 4990, h: 4990, l: 4990, c: 4990, v: 100, n: 1 } });
    const r = submitOrder(db, s.ctx(at(10, 0)), buy({ qty: 600, attach: { stop_loss_px_u: 4500, take_profit_px_u: 6000 } }));
    const [stop, tp] = r.children;
    run(s, at(10, 0), at(10, 1));
    assert.equal(fillsOf(s, tp.id)[0].payload.qty, 120, 'limited by the displayed bid size');
    assert.equal(getOrder(db, r.order.id).status, 'cancelled', 'entry remainder cancelled after the protective partial fill');
    assert.equal(held(s), 180);
    for (const q of openProtectiveQty(s)) assert.ok(q <= held(s), `open protective remaining ${q} <= held ${held(s)}`);
    assert.equal(getOrder(db, stop.id).qty - getOrder(db, stop.id).filled_qty, 180);
    run(s, at(10, 2), at(10, 3));
    for (const q of openProtectiveQty(s)) assert.ok(q <= held(s));
    assert.ok(verifyChain(db).ok);
  } finally { s.cleanup(); }
});

test('single-child bracket (stop only, no OCO group) also cancels the entry remainder', () => {
  const s = setupScenario('bracket-single');
  try {
    const { db } = s;
    flat(db, SYM, at(9, 58), at(10, 0), { asz: 100 });
    addMinute(db, FIXTURE_DS, SYM, at(10, 1), { bid: 4400, ask: 4410, asz: 100, minBid: 4400, maxBid: 4990, minAsk: 4410, maxAsk: 5000,
      trades: { o: 4900, h: 4900, l: 4400, c: 4400, v: 2000, n: 10 } });
    flat(db, SYM, at(10, 2), at(10, 3), { bid: 4400, ask: 4410, asz: 100 });
    const r = submitOrder(db, s.ctx(at(10, 0)), buy({ qty: 500, attach: { stop_loss_px_u: 4500 } }));
    assert.equal(r.children.length, 1);
    assert.equal(r.children[0].oco_group, null);
    run(s, at(10, 0), at(10, 3));
    assert.equal(getOrder(db, r.children[0].id).status, 'filled');
    const e = getOrder(db, r.order.id);
    assert.deepEqual([e.status, e.filled_qty, e.reason], ['cancelled', 100, 'PARENT_REMAINDER_CANCELLED_AFTER_PROTECTIVE_EXIT']);
    assert.equal(held(s), 0);
  } finally { s.cleanup(); }
});

// ---------------------------------------------------------------------------------------------------------------
// Other exits shrink the bracket children in the same minute.

test('a manual sell clamps the bracket children to the shares held; the stop then sells only those', () => {
  const s = setupScenario('bracket-clamp');
  try {
    const { db } = s;
    flat(db, SYM, at(9, 58), at(10, 1));
    addMinute(db, FIXTURE_DS, SYM, at(10, 2), { bid: 4400, ask: 4410, minBid: 4400, maxBid: 4990, minAsk: 4410, maxAsk: 5000,
      trades: { o: 4900, h: 4900, l: 4400, c: 4400, v: 2000, n: 10 } });
    flat(db, SYM, at(10, 3), at(10, 4), { bid: 4400, ask: 4410 });
    const r = submitOrder(db, s.ctx(at(10, 0)), buy({ attach: { stop_loss_px_u: 4500, take_profit_px_u: 6000 } }));
    const [stop, tp] = r.children;
    run(s, at(10, 0), at(10, 0));
    assert.equal(held(s), 100);
    const sell = submitOrder(db, s.ctx(at(10, 1)), { portfolio_id: 'sandbox', sym: SYM, side: 'sell', type: 'market', role: 'exit', qty: 60, actor: 'human' });
    assert.equal(sell.ok, true);
    run(s, at(10, 1), at(10, 1));
    assert.equal(held(s), 40);
    for (const id of [stop.id, tp.id]) {
      const o = getOrder(db, id);
      assert.deepEqual([o.status, o.qty, o.filled_qty], ['working', 40, 0], 'clamped in the same minute');
    }
    const upd = rowsOf(s, 'BRACKET_CHILD_QTY_UPDATED').filter((x) => x.payload.cause === 'POSITION_REDUCED');
    assert.equal(upd.length, 2);
    assert.ok(upd.every((x) => x.payload.previousQty === 100 && x.payload.heldAfter === 40 && x.payload.cause_order_id === sell.order.id));
    // Same-minute re-buy of 50 while the stop fires: the stop sells only the 40 it protects; the new shares stay.
    const rebuy = submitOrder(db, s.ctx(at(10, 2)), buy({ qty: 50, role: 'manual' }));
    assert.equal(rebuy.ok, true);
    run(s, at(10, 2), at(10, 4));
    const so = getOrder(db, stop.id);
    assert.deepEqual([so.status, so.filled_qty, so.qty], ['filled', 40, 40]);
    assert.deepEqual([getOrder(db, tp.id).status, getOrder(db, tp.id).reason], ['cancelled', 'OCO_SIBLING_FILLED']);
    assert.equal(held(s), 50, 'the re-bought shares are not sold by the old stop');
    assert.ok(verifyChain(db).ok);
    writeJournalSample(db, 'bracket-clamp-after-manual-sell', {
      session_id: s.session_id, covers: ['bracket children clamped to the position after a manual sell', 'triggered stop', 'OCO sibling cancel'],
      description: 'A 100-share bracket entry fills; a manual sell of 60 clamps the stop-loss and take-profit to the 40 shares still held in the same minute (BRACKET_CHILD_QTY_UPDATED). A later gap triggers the stop, which sells exactly 40; a same-minute re-buy of 50 is not touched by the old stop.',
    });
  } finally { s.cleanup(); }
});

// ---------------------------------------------------------------------------------------------------------------
// replaceOrder journals cascaded child qty changes.

test('replace: a pending entry qty change journals BRACKET_CHILD_QTY_UPDATED per child', () => {
  const s = setupScenario('replace-cascade');
  try {
    const { db } = s;
    flat(db, SYM, at(9, 58), at(10, 2));
    const r = submitOrder(db, s.ctx(at(10, 0)), buy({ type: 'limit', limit_px: 4000, attach: { stop_loss_px_u: 3500, take_profit_px_u: 6000 } }));
    assert.equal(r.ok, true);
    const rep = replaceOrder(db, s.ctx(at(10, 1)), r.order.id, { qty: 300, by: 'human', reason: 'size up' });
    assert.equal(rep.ok, true);
    assert.equal(rep.cascaded.length, 2);
    const upd = rowsOf(s, 'BRACKET_CHILD_QTY_UPDATED');
    assert.equal(upd.length, 2);
    for (const u of upd) {
      assert.equal(u.payload.previousQty, 100);
      assert.equal(u.payload.qty, 300);
      assert.equal(u.payload.cascadedFrom, r.order.id);
      assert.equal(u.actor, 'human');
    }
    const replaced = rowsOf(s, 'ORDER_REPLACED')[0];
    assert.deepEqual(replaced.payload.cascaded.map((c) => c.order_id).sort(), r.children.map((c) => c.id).sort());
    const before = rowsOf(s, 'BRACKET_CHILD_QTY_UPDATED').length;
    assert.equal(replaceOrder(db, s.ctx(at(10, 2)), r.order.id, { limit_px: 4100 }).ok, true);
    assert.equal(rowsOf(s, 'BRACKET_CHILD_QTY_UPDATED').length, before, 'a price-only replace writes no child rows');
    assert.ok(verifyChain(db).ok);
    writeJournalSample(db, 'replace-cascade', {
      session_id: s.session_id, covers: ['order replace', 'cascaded bracket child qty journaled'],
      description: 'A pending limit entry with an attached stop/take-profit is replaced from 100 to 300 shares; each pending child gets a BRACKET_CHILD_QTY_UPDATED row (previousQty 100, cascadedFrom the entry) and the ORDER_REPLACED row lists them.',
    });
  } finally { s.cleanup(); }
});

// ---------------------------------------------------------------------------------------------------------------
// Displayed size is consumed per minute, per portfolio/symbol/side.

test('displayed size: four same-minute buys share one displayed ask size; portfolios are independent books', () => {
  const s = setupScenario('displayed-size');
  try {
    const { db } = s;
    flat(db, SYM, at(9, 58), at(10, 4), { asz: 300 });
    const ids = [];
    for (let i = 0; i < 4; i++) ids.push(submitOrder(db, s.ctx(at(10, 0)), buy({ qty: 300, role: 'manual' })).order.id);
    const other = submitOrder(db, s.ctx(at(10, 0)), { portfolio_id: 'pragmatist-micro', sym: SYM, side: 'buy', type: 'market', qty: 300, actor: 'system' });
    assert.equal(other.ok, true);
    const [m0] = run(s, at(10, 0), at(10, 0));
    assert.equal(held(s), 300, 'exactly the displayed size in the 10:00 minute');
    assert.equal(getOrder(db, ids[0]).status, 'filled', 'first submitted gets the displayed size');
    const wh = m0.withheld.filter((w) => ids.includes(w.order_id));
    assert.deepEqual(wh.map((w) => w.reason), Array(3).fill('DISPLAYED_SIZE_CONSUMED_THIS_MINUTE'));
    assert.equal(held(s, 'pragmatist-micro'), 300, 'another portfolio sees the full displayed size (independent counterfactual book)');
    const fe = fillsOf(s, ids[0])[0];
    assert.equal(fe.payload.assumptions.displayedSizeAtMinuteStart, 300);
    run(s, at(10, 1), at(10, 1));
    assert.equal(held(s), 600);
    assert.equal(getOrder(db, ids[1]).status, 'filled', 'the next minute fills the next order');
    assert.ok(verifyChain(db).ok);
    writeJournalSample(db, 'displayed-size-consumed', {
      session_id: s.session_id, covers: ['displayed size consumed per minute', 'FILL_WITHHELD DISPLAYED_SIZE_CONSUMED_THIS_MINUTE', 'independent portfolios'],
      description: 'Four 300-share sandbox market buys in one minute with 300 shares displayed: the first fills 300, the other three are withheld (DISPLAYED_SIZE_CONSUMED_THIS_MINUTE) and fill one per later minute. A pragmatist-micro buy in the same minute still sees the full displayed size (portfolios are independent counterfactual books).',
    });
  } finally { s.cleanup(); }
});

test('trade-through size is consumed too: a second same-minute limit buy gets nothing from the same prints', () => {
  const s = setupScenario('trade-through-size');
  try {
    const { db } = s;
    flat(db, SYM, at(9, 58), at(9, 59), { bid: 5090, ask: 5100, asz: 300 });
    addMinute(db, FIXTURE_DS, SYM, at(10, 0), { bid: 5090, ask: 5100, asz: 300, trades: { o: 5050, h: 5100, l: 4990, c: 5050, v: 1200, n: 4 } });
    const a = submitOrder(db, s.ctx(at(10, 0)), buy({ type: 'limit', limit_px: 5000, qty: 1000 })).order.id;
    const b = submitOrder(db, s.ctx(at(10, 0)), buy({ type: 'limit', limit_px: 5000, qty: 1000, role: 'manual' })).order.id;
    const [m] = run(s, at(10, 0), at(10, 0));
    const fa = fillsOf(s, a)[0];
    assert.equal(fa.payload.qty, 300, 'min(displayed ask 300, minute volume 1200)');
    assert.equal(fa.payload.assumptions.sizeSource, 'TRADE_THROUGH');
    assert.deepEqual(m.withheld.find((w) => w.order_id === b)?.reason, 'TRADE_THROUGH_SIZE_CONSUMED_THIS_MINUTE');
  } finally { s.cleanup(); }
});

// ---------------------------------------------------------------------------------------------------------------
// Spend cap at fill time.

test('spend cap: a market buy cannot spend more than the policy max_trade_spend_usd when the ask jumps', () => {
  const s = setupScenario('spend-cap');
  try {
    const { db } = s;
    flat(db, SYM, at(9, 58), at(9, 59), { asz: 10_000 });
    // TEST FIXTURE: inside the 10:00 minute the ask jumps from 5000 to 6000.
    addMinute(db, FIXTURE_DS, SYM, at(10, 0), { bid: 5990, ask: 6000, asz: 10_000, minBid: 4990, maxBid: 5990, minAsk: 5000, maxAsk: 6000,
      trades: { o: 5000, h: 6000, l: 5000, c: 6000, v: 9000, n: 30 } });
    flat(db, SYM, at(10, 1), at(10, 2), { bid: 4990, ask: 5000, asz: 10_000 });
    // Sized by the gate as 4975 sh at ~5025 u (<= $2,500); the sandbox policy cap is $2,500.
    const r = submitOrder(db, s.ctx(at(10, 0)), buy({ qty: 4975 }));
    assert.equal(r.ok, true);
    const meta = JSON.parse(r.order.meta_json);
    assert.equal(meta.maxSpendU, 25_000_000);
    assert.equal(meta.spendCap.source, 'policy:max_trade_spend_usd');
    assert.deepEqual(meta.submitEstimate, { priceU: 5025, basis: 'IEX_ASK_PLUS_SLIPPAGE', asOf: at(10, 0) });
    assert.equal(rowsOf(s, 'ORDER_SUBMITTED')[0].payload.spendCap.maxSpendU, 25_000_000);
    run(s, at(10, 0), at(10, 2));
    const f = fillsOf(s, r.order.id);
    assert.equal(f.length, 1);
    assert.equal(f[0].payload.priceU, 6030);
    assert.equal(f[0].payload.qty, 4145, 'floor(25,000,000 / 6030)');
    assert.ok(f[0].payload.assumptions.qtyLimitedBy.includes('SPEND_CAP'));
    const spent = f.reduce((a, x) => a + x.payload.grossU + x.payload.feesU, 0);
    assert.ok(spent <= 25_000_000, `spent ${spent} u <= $2,500`);
    const o = getOrder(db, r.order.id);
    assert.deepEqual([o.status, o.reason], ['cancelled', 'SPEND_CAP_REACHED'], 'remainder cancelled instead of becoming an implicit limit order');
    // A tighter caller cap (e.g. the intent budget) wins.
    const r2 = submitOrder(db, s.ctx(at(10, 1)), buy({ qty: 500, meta: { maxSpendU: 1_000_000 } }));
    assert.equal(JSON.parse(r2.order.meta_json).maxSpendU, 1_000_000);
    assert.equal(JSON.parse(r2.order.meta_json).spendCap.source, 'caller:meta.maxSpendU');
    run(s, at(10, 1), at(10, 1));
    assert.equal(fillsOf(s, r2.order.id)[0].payload.qty, 199, 'floor(1,000,000 / 5025)');
    assert.ok(verifyChain(db).ok);
    writeJournalSample(db, 'spend-cap', {
      session_id: s.session_id, covers: ['spend cap enforced at fill time', 'remainder cancelled SPEND_CAP_REACHED'],
      description: 'A sandbox market buy sized at the as-of ask (4975 sh, ~$2,500) meets a minute whose worst ask is 20% higher. The fill is capped at the $2,500 max_trade_spend_usd (4145 sh at 6030 u) and the remainder is cancelled (SPEND_CAP_REACHED) rather than overspending or waiting for a cheaper price.',
    });
  } finally { s.cleanup(); }
});

test('spend cap: the budget_usd of the stored intent an order executes is enforced at fill time', () => {
  const s = setupScenario('spend-cap-intent');
  try {
    const { db } = s;
    flat(db, SYM, at(9, 58), at(9, 59), { asz: 10_000 });
    addMinute(db, FIXTURE_DS, SYM, at(10, 0), { bid: 5990, ask: 6000, asz: 10_000, minBid: 4990, maxBid: 5990, minAsk: 5000, maxAsk: 6000,
      trades: { o: 5000, h: 6000, l: 5000, c: 6000, v: 9000, n: 30 } });
    const addIntent = (id, session_id, budget_usd) => db.prepare(`INSERT INTO intents (id, session_id, agent_id, portfolio_id, ts, source, intent_json, decision, reasons_json, order_ids_json)
      VALUES (?, ?, NULL, 'sandbox', ?, 'human', ?, 'ACCEPTED', '[]', NULL)`).run(id, session_id, at(10, 0), JSON.stringify({ id, budget_usd, label: 'TEST FIXTURE — NOT MARKET DATA' }));
    addIntent('int_fixture_budget', s.session_id, 1000);
    addIntent('int_fixture_other_session', 'some-other-session', 10);
    // Sized by the gate at the as-of ask: floor($1,000 / 0.5025) = 1990 shares.
    const r = submitOrder(db, s.ctx(at(10, 0)), buy({ qty: 1990, intent_id: 'int_fixture_budget' }));
    const meta = JSON.parse(r.order.meta_json);
    assert.deepEqual([meta.maxSpendU, meta.spendCap.source], [10_000_000, 'intent:budget_usd']);
    assert.equal(JSON.parse(submitOrder(db, s.ctx(at(10, 0)), buy({ qty: 10, intent_id: 'int_fixture_other_session' })).order.meta_json).spendCap.source,
      'policy:max_trade_spend_usd', 'an intent from another session is ignored');
    run(s, at(10, 0), at(10, 0));
    const f = fillsOf(s, r.order.id)[0].payload;
    assert.equal(f.qty, 1658, 'floor(10,000,000 / 6030): the $1,000 intent budget, not the $2,500 policy cap');
    assert.ok(f.grossU + f.feesU <= 10_000_000);
    assert.equal(getOrder(db, r.order.id).reason, 'SPEND_CAP_REACHED');
  } finally { s.cleanup(); }
});

test('validation: meta.maxSpendU must be a positive integer on a buy', () => {
  assert.ok(validateOrderSpec({ ...buy({}), meta: { maxSpendU: 0 } }).some((e) => e.code === 'META_INVALID'));
  assert.ok(validateOrderSpec({ ...buy({}), meta: { maxSpendU: 1.5 } }).some((e) => e.code === 'META_INVALID'));
  assert.ok(validateOrderSpec({ portfolio_id: 'sandbox', sym: SYM, side: 'sell', type: 'market', qty: 1, meta: { maxSpendU: 100 } }).some((e) => e.code === 'META_INVALID'));
  assert.deepEqual(validateOrderSpec({ ...buy({}), meta: { maxSpendU: 100 } }), []);
});

// ---------------------------------------------------------------------------------------------------------------
// Sandbox cost model per symbol.

test('sandbox fills use the large-cap cost model for large-cap-list symbols and micro otherwise', () => {
  const prev = process.env.VECTOR_LARGECAP_LIST;
  process.env.VECTOR_LARGECAP_LIST = 'FIXL'; // TEST FIXTURE configuration: FIXL is the only "large-cap" symbol
  const s = setupScenario('sandbox-segment');
  try {
    const { db } = s;
    flat(db, 'FIXL', at(9, 58), at(10, 0), { bid: 199_900, ask: 200_000 });
    flat(db, SYM, at(9, 58), at(10, 0));
    const l = submitOrder(db, s.ctx(at(10, 0)), { portfolio_id: 'sandbox', sym: 'FIXL', side: 'buy', type: 'market', qty: 10, actor: 'human' });
    const m = submitOrder(db, s.ctx(at(10, 0)), buy({ qty: 10, role: 'manual' }));
    run(s, at(10, 0), at(10, 0));
    const fl = fillsOf(s, l.order.id)[0].payload;
    assert.equal(fl.priceU, 200_100, 'ask + 5 bps = 200,100 u (valid penny tick)');
    assert.deepEqual([fl.assumptions.segment, fl.assumptions.slippageBps, fl.assumptions.requestedSegment], ['large', 5, 'large']);
    const fm = fillsOf(s, m.order.id)[0].payload;
    assert.equal(fm.priceU, 5025, 'ask + 50 bps');
    assert.deepEqual([fm.assumptions.segment, fm.assumptions.slippageBps], ['micro', 50]);
  } finally {
    s.cleanup();
    if (prev === undefined) delete process.env.VECTOR_LARGECAP_LIST; else process.env.VECTOR_LARGECAP_LIST = prev;
  }
});

// ---------------------------------------------------------------------------------------------------------------
// Sell stops at/above the bid are journaled.

test('a sell stop at/above the as-of bid is journaled as marketable and triggers on its first eligible minute', () => {
  const s = setupScenario('stop-marketable');
  try {
    const { db } = s;
    flat(db, SYM, at(9, 58), at(10, 3));
    // Bracket with the stop at the ask reference (5000 >= bid 4990): flagged at activation.
    const r = submitOrder(db, s.ctx(at(10, 0)), buy({ attach: { stop_loss_px_u: 5000 } }));
    const subChild = rowsOf(s, 'ORDER_SUBMITTED').find((x) => x.ref_id === r.children[0].id);
    assert.equal(subChild.payload.stopCheck.stopAtOrAboveBid, true);
    run(s, at(10, 0), at(10, 0));
    const act = rowsOf(s, 'BRACKET_CHILD_ACTIVATED')[0];
    assert.equal(act.payload.stopCheck.stopAtOrAboveBid, true);
    assert.equal(act.payload.stopCheck.warning, 'STOP_MARKETABLE_AT_ACTIVATION');
    assert.equal(act.payload.stopCheck.bidU, 4990);
    run(s, at(10, 1), at(10, 1));
    const trig = rowsOf(s, 'STOP_TRIGGERED');
    assert.equal(trig.length, 1);
    assert.equal(trig[0].payload.minuteT, at(10, 1), 'first eligible minute');
    const sf = fillsOf(s, r.children[0].id)[0].payload;
    assert.equal(sf.priceU, 4965, 'p(min(S 5000, minBid 4990)) = floor(4990 x 0.995)');
    assert.equal(sf.worseThanStop, true, 'the stop was already through the market');
    // Plain sell stop submitted at the bid: flagged at submission.
    submitOrder(db, s.ctx(at(10, 2)), buy({ role: 'manual' }));
    run(s, at(10, 2), at(10, 2));
    const st = submitOrder(db, s.ctx(at(10, 3)), { portfolio_id: 'sandbox', sym: SYM, side: 'sell', type: 'stop', stop_px: 4990, role: 'exit', qty: 100, actor: 'human' });
    assert.equal(st.ok, true);
    const sub = rowsOf(s, 'ORDER_SUBMITTED').find((x) => x.ref_id === st.order.id);
    assert.deepEqual([sub.payload.stopCheck.stopAtOrAboveBid, sub.payload.stopCheck.warning, sub.payload.stopCheck.stopVsBidBps], [true, 'STOP_MARKETABLE_AT_SUBMIT', 0]);
    // A replace below the bid is journaled as not marketable.
    const rep = replaceOrder(db, s.ctx(at(10, 3)), st.order.id, { stop_px: 4500 });
    assert.equal(rep.ok, true);
    assert.equal(rowsOf(s, 'ORDER_REPLACED').at(-1).payload.stopCheck.stopAtOrAboveBid, false);
    assert.ok(verifyChain(db).ok);
    writeJournalSample(db, 'stop-marketable-at-placement', {
      session_id: s.session_id, covers: ['stop placed at/above the bid (placement-triggered stop)', 'STOP_MARKETABLE_AT_ACTIVATION / _AT_SUBMIT warnings'],
      description: 'An attached stop at the ask reference (5000) is above the as-of IEX bid (4990): the activation row carries stopCheck.stopAtOrAboveBid=true and the stop triggers on its first evaluated minute because of where it was placed, not because the price moved.',
    });
  } finally { s.cleanup(); }
});

// ---------------------------------------------------------------------------------------------------------------
// Expiry granularity and deterministic tie-breaks.

test('expires_ts is floored to the minute: an order is never evaluated on data after its expiry', () => {
  const s = setupScenario('expiry-floor');
  try {
    const { db } = s;
    flat(db, SYM, at(9, 58), at(10, 3));
    const past = submitOrder(db, s.ctx(at(10, 0)), buy({ type: 'limit', limit_px: 4000, expires_ts: at(10, 0) + 30_000 }));
    assert.deepEqual([past.ok, past.code], [false, 'EXPIRY_IN_PAST'], 'cannot cover a whole minute');
    const r = submitOrder(db, s.ctx(at(10, 0)), buy({ type: 'limit', limit_px: 4000, expires_ts: at(10, 1) + 30_000 }));
    assert.equal(r.ok, true);
    assert.equal(r.order.expires_ts, at(10, 1), 'eligible for the 10:00 minute only');
    assert.equal(JSON.parse(r.order.meta_json).requestedExpiresTs, at(10, 1) + 30_000);
    const [m0] = run(s, at(10, 0), at(10, 0));
    assert.deepEqual(m0.expired, [r.order.id], 'expired at the end of its last whole minute');
  } finally { s.cleanup(); }
});

test('same-clock orders are processed in submission order (rowid), even when their ids share a millisecond', () => {
  const realNow = Date.now;
  for (let i = 0; i < 20; i++) {
    const s = setupScenario(`tiebreak-${i}`, { startingCashU: { sandbox: 600_000 } });
    try {
      flat(s.db, SYM, at(9, 58), at(10, 0));
      Date.now = () => 4_070_000_000_000;
      let a; let b;
      try {
        a = submitOrder(s.db, s.ctx(at(10, 0)), buy({}));
        b = submitOrder(s.db, s.ctx(at(10, 0)), buy({ role: 'manual' }));
      } finally { Date.now = realNow; }
      assert.equal(a.order.id.slice(0, 12), b.order.id.slice(0, 12), 'same time prefix: only the random suffix differs');
      run(s, at(10, 0), at(10, 0));
      assert.equal(getOrder(s.db, a.order.id).filled_qty, 100, 'the first-submitted order gets the cash');
      assert.equal(getOrder(s.db, b.order.id).filled_qty, 19, 'floor(97,500 / 5025)');
      assert.deepEqual(listOpenOrders(s.db, s.session_id, 'sandbox').map((o) => o.id), [b.order.id]);
    } finally { s.cleanup(); }
  }
});

test('cancel cascades to pending children; expireOrders expires open orders at close', () => {
  const s = setupScenario('cancel-expire');
  try {
    const { db } = s;
    flat(db, SYM, at(9, 58), at(10, 1));
    const r = submitOrder(db, s.ctx(at(10, 0)), buy({ type: 'limit', limit_px: 4000, attach: { stop_loss_px_u: 3500, take_profit_px_u: 6000 } }));
    const c = cancelOrder(db, s.ctx(at(10, 1)), r.order.id, { by: 'human', reason: 'test' });
    assert.equal(c.ok, true);
    assert.deepEqual(c.cascaded.sort(), r.children.map((x) => x.id).sort());
    assert.ok(r.children.every((x) => getOrder(db, x.id).reason === 'PARENT_CANCELLED'));
    const w = submitOrder(db, s.ctx(at(10, 1)), buy({ type: 'limit', limit_px: 4000, role: 'manual' }));
    expireOrders(db, s.ctx(at(16, 0)), at(16, 0));
    assert.equal(getPortfolio(db, s.session_id, 'sandbox').cash, 100_000_000);
    assert.equal(getOrder(db, w.order.id).status, 'expired');
  } finally { s.cleanup(); }
});

// ---------------------------------------------------------------------------------------------------------------
// Submission validation and business rejections (section 4).

test('submitOrder: structural and business rejections are journaled and never create a working order', () => {
  const s = setupScenario('submit-reject');
  try {
    const { db } = s;
    flat(db, SYM, at(9, 58), at(10, 0));
    const v = (spec) => submitOrder(db, s.ctx(at(10, 0)), spec);
    assert.equal(v(buy({ type: 'limit', limit_px: 50_005 })).code, 'TICK_INVALID', 'sub-penny limit above $1');
    assert.equal(v(buy({ qty: 1.5 })).code, 'QTY_INVALID');
    assert.equal(v(buy({ role: 'stop_loss' })).code, 'SIDE_ROLE_COMBO_INVALID', 'a stop-loss is a sell (no shorting)');
    assert.equal(v({ ...buy({}), side: 'sell', role: 'take_profit', type: 'stop', stop_px: 4000 }).code, 'TYPE_ROLE_COMBO_INVALID');
    assert.equal(v(buy({ protective: true })).code, 'PROTECTIVE_FLAG_INVALID');
    assert.equal(v(buy({ surprise: 1 })).code, 'UNKNOWN_FIELD');
    assert.equal(v(buy({ type: 'market', limit_px: 5000 })).code, 'LIMIT_NOT_ALLOWED');
    assert.equal(v(buy({ attach: { stop_loss_px_u: 6000, take_profit_px_u: 5000 } })).code, 'ATTACH_INVALID', 'stop must be below take-profit');
    assert.equal(v(buy({ tif: 'GTC' })).code, 'TIF_INVALID');
    const validation = rowsOf(s, 'ORDER_REJECTED');
    assert.ok(validation.length >= 9 && validation.every((r) => r.payload.stage === 'validation' && r.ref_id === null));
    // Business rules: no shorting, session closed, no verified data, unknown portfolio, missing context.
    const short = v({ portfolio_id: 'sandbox', sym: SYM, side: 'sell', type: 'market', qty: 10, actor: 'human' });
    assert.deepEqual([short.code, short.order.status], ['NO_SHORT_SELL_EXCEEDS_HELD', 'rejected']);
    assert.equal(rowsOf(s, 'ORDER_REJECTED').at(-1).payload.stage, 'business');
    assert.equal(submitOrder(db, s.ctx(at(16, 0)), buy({})).code, 'SESSION_CLOSED');
    assert.equal(submitOrder(db, { ...s.ctx(at(10, 0)), ds: null }, buy({})).code, 'NO_VERIFIED_DATA');
    assert.equal(v(buy({ portfolio_id: 'no-such-portfolio' })).code, 'PORTFOLIO_NOT_FOUND');
    assert.equal(submitOrder(db, { session_id: s.session_id, ds: FIXTURE_DS }, buy({})).code, 'CONTEXT_INVALID');
    assert.deepEqual(listOpenOrders(db, s.session_id, 'sandbox'), [], 'nothing working');
    assert.ok(verifyChain(db).ok);
  } finally { s.cleanup(); }
});

test('cancel/replace refusals are journaled; processMinute refuses look-ahead and unaligned minutes', () => {
  const s = setupScenario('refusals');
  try {
    const { db } = s;
    flat(db, SYM, at(9, 58), at(10, 1));
    const r = submitOrder(db, s.ctx(at(10, 0)), buy({}));
    run(s, at(10, 0), at(10, 0));
    assert.equal(getOrder(db, r.order.id).status, 'filled');
    assert.equal(cancelOrder(db, s.ctx(at(10, 1)), r.order.id).code, 'ORDER_NOT_CANCELLABLE');
    assert.equal(cancelOrder(db, s.ctx(at(10, 1)), 'ord_missing').code, 'ORDER_NOT_FOUND');
    assert.equal(replaceOrder(db, s.ctx(at(10, 1)), r.order.id, { qty: 50 }).code, 'ORDER_NOT_REPLACEABLE');
    const w = submitOrder(db, s.ctx(at(10, 1)), buy({ type: 'limit', limit_px: 4000, role: 'manual' }));
    assert.equal(cancelOrder(db, s.ctx(at(10, 1)), w.order.id, { portfolio_id: 'cowboy-micro' }).code, 'ORDER_PORTFOLIO_MISMATCH');
    assert.equal(replaceOrder(db, s.ctx(at(10, 1)), w.order.id, {}).code, 'NOTHING_TO_REPLACE');
    assert.equal(replaceOrder(db, s.ctx(at(10, 1)), w.order.id, { stop_px: 3000 }).code, 'STOP_NOT_ALLOWED');
    assert.equal(replaceOrder(db, s.ctx(at(10, 1)), w.order.id, { limit_px: 40_005 }).code, 'TICK_INVALID');
    assert.equal(rowsOf(s, 'ORDER_CANCEL_REJECTED').length, 3);
    assert.equal(rowsOf(s, 'ORDER_REPLACE_REJECTED').length, 4);
    assert.throws(() => processMinute(db, s.ctx(at(10, 1) + MINUTE - 1), at(10, 1)), /look-ahead blocked/);
    assert.throws(() => processMinute(db, s.ctx(at(10, 3)), at(10, 1) + 1), RangeError);
    assert.equal(processMinute(db, { ...s.ctx(at(10, 2)), ds: null }, at(10, 1)).status, 'NO_VERIFIED_DATA');
  } finally { s.cleanup(); }
});

// ---------------------------------------------------------------------------------------------------------------
// OCO same-minute ambiguity and unfillable minutes (section 2).

test('OCO: when stop and take-profit could both execute in one minute, the stop executes and the ambiguity is journaled', () => {
  const s = setupScenario('oco-ambiguity');
  try {
    const { db } = s;
    flat(db, SYM, at(9, 58), at(10, 0));
    // TEST FIXTURE minute: the bid falls through the stop AND a print trades above the take-profit.
    addMinute(db, FIXTURE_DS, SYM, at(10, 1), { bid: 4400, ask: 4410, minBid: 4400, maxBid: 4990, minAsk: 4410, maxAsk: 5000,
      trades: { o: 5000, h: 6100, l: 4400, c: 4400, v: 3000, n: 12 } });
    flat(db, SYM, at(10, 2), at(10, 2), { bid: 4400, ask: 4410 });
    const r = submitOrder(db, s.ctx(at(10, 0)), buy({ attach: { stop_loss_px_u: 4500, take_profit_px_u: 6000 } }));
    const [stop, tp] = r.children;
    const [, m1] = run(s, at(10, 0), at(10, 2));
    assert.deepEqual(m1.ambiguities, [`oco_${r.order.id}`]);
    const amb = rowsOf(s, 'OCO_SAME_MINUTE_AMBIGUITY')[0];
    assert.deepEqual([amb.actor, amb.payload.resolution, amb.payload.chosen_order_id, amb.payload.discarded_fills], ['engine', 'STOP_LOSS_FIRST_CONSERVATIVE', stop.id, [tp.id]]);
    assert.equal(fillsOf(s, stop.id)[0].payload.priceU, 4378);
    assert.equal(fillsOf(s, tp.id).length, 0, 'the take-profit fill is discarded, not applied');
    assert.deepEqual([getOrder(db, tp.id).status, getOrder(db, tp.id).reason], ['cancelled', 'OCO_SIBLING_FILLED']);
    assert.equal(held(s), 0);
    assert.ok(verifyChain(db).ok);
    writeJournalSample(db, 'oco-same-minute-ambiguity', {
      session_id: s.session_id, covers: ['OCO_SAME_MINUTE_AMBIGUITY (stop-loss first, conservative)', 'triggered stop worse than stop'],
      description: 'A filled 100-share bracket meets a minute in which the bid falls through the stop (4500) and a print trades above the take-profit (6000). Intra-minute order is unknown, so the stop is assumed to execute first: it sells 100 at 4378, the take-profit fill is discarded and the sibling is cancelled.',
    });
  } finally { s.cleanup(); }
});

test('unfillable minute: a stop triggered while halted is withheld (no fill manufactured) and retried next minute as a market sell', () => {
  const s = setupScenario('halted-stop');
  try {
    const { db } = s;
    flat(db, SYM, at(9, 58), at(10, 0));
    addMinute(db, FIXTURE_DS, SYM, at(10, 1), { bid: 4400, ask: 4410, minBid: 4400, maxBid: 4990, minAsk: 4410, maxAsk: 5000, halted: true,
      trades: { o: 4900, h: 4900, l: 4400, c: 4400, v: 500, n: 3 } });
    addMinute(db, FIXTURE_DS, SYM, at(10, 2), { bid: 4300, ask: 4310, minBid: 4300, maxBid: 4400, minAsk: 4310, maxAsk: 4410, trades: { o: 4300, h: 4300, l: 4300, c: 4300, v: 500, n: 3 } });
    const r = submitOrder(db, s.ctx(at(10, 0)), buy({ attach: { stop_loss_px_u: 4500 } }));
    const stop = r.children[0];
    const [, m1] = run(s, at(10, 0), at(10, 1));
    assert.deepEqual(m1.withheld, [{ order_id: stop.id, reason: 'HALTED' }]);
    assert.deepEqual(m1.triggered, [stop.id]);
    assert.equal(getOrder(db, stop.id).status, 'triggered');
    const wh = rowsOf(s, 'FILL_WITHHELD')[0];
    assert.deepEqual([wh.payload.reason, wh.payload.retryNextMinute], ['HALTED', 'as market order']);
    assert.equal(fillsOf(s, stop.id).length, 0);
    run(s, at(10, 2), at(10, 2));
    const f = fillsOf(s, stop.id)[0].payload;
    assert.equal(f.assumptions.rule, 'TRIGGERED_STOP_SELL_RETRY_AS_MARKET_WORST_BID');
    assert.equal(f.priceU, 4278, 'floor(4300 x 0.995): the worst bid of the retry minute');
    assert.equal(held(s), 0);
    assert.ok(verifyChain(db).ok);
    writeJournalSample(db, 'halted-stop-withheld', {
      session_id: s.session_id, covers: ['FILL_WITHHELD (HALTED) - no fill manufactured', 'triggered stop retried as market sell'],
      description: 'A stop-loss triggers in a halted minute: the trigger is journaled (STOP_TRIGGERED) but the fill is withheld (FILL_WITHHELD HALTED). The next minute the triggered stop is retried as a market sell at the worst bid of that minute minus slippage.',
    });
  } finally { s.cleanup(); }
});

test('an order that never became fillable expires at the close with the last withheld reason', () => {
  const s = setupScenario('expire-withheld');
  try {
    const { db } = s;
    flat(db, SYM, at(15, 57), at(15, 57));
    addMinute(db, FIXTURE_DS, SYM, at(15, 58), { halted: true, bid: 4990, ask: 5000 });
    addMinute(db, FIXTURE_DS, SYM, at(15, 59), { halted: true, bid: 4990, ask: 5000 });
    const r = submitOrder(db, s.ctx(at(15, 58)), buy({}));
    const [, last] = run(s, at(15, 58), at(15, 59));
    assert.deepEqual(last.expired, [r.order.id]);
    const o = getOrder(db, r.order.id);
    assert.deepEqual([o.status, o.reason], ['expired', 'EXPIRED_AFTER_UNFILLABLE:HALTED']);
    const ex = rowsOf(s, 'ORDER_EXPIRED')[0];
    assert.deepEqual([ex.payload.lastWithheldReason, ex.payload.unfilledQty], ['HALTED', 100]);
  } finally { s.cleanup(); }
});
