// TEST FIXTURE — NOT MARKET DATA. Agent trade lifecycle on synthetic minute rows (FIX* symbols, 2099 trade date):
// autonomous buy with attached stop + take-profit, triggered stop with a worse-than-stop fill, take-profit fill,
// stale-entry cancellation, breakeven stop modification, time exit, budget and stale-quote rejections.
// Writes receipts/journal-samples/fixture-agents-*.json.
import test from 'node:test';
import assert from 'node:assert/strict';
import { reset, step } from '../../server/replay/engine.js';
import { startAgent, getAgent } from '../../server/controls.js';
import { verifyChain } from '../../server/journal.js';
import { getPosition, getPortfolio } from '../../server/sim/ledger.js';
import {
  at, MINUTE, setupDb, jumpTape, flat, addMinute, testStrategy, journalRows, rowsOfType, ordersOf, writeJournalSample,
} from './helpers/fixture.js';

const AGENT = 'agent-cowboy-micro';
const PF = 'cowboy-micro';

/** Fresh DB + reset + one RUNNING agent with the given (TEST FIXTURE) strategy. */
function scenario(name, tape, strategy = testStrategy()) {
  const t = setupDb(name, tape);
  const r = reset(t.db, { strategies: { [AGENT]: strategy } });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.state.clock, at(9, 30));
  const s = startAgent(t.db, AGENT, { by: 'test' });
  assert.equal(s.ok, true, JSON.stringify(s));
  return { ...t, session_id: r.session_id };
}

async function stepTo(db, clock) {
  const st = db.prepare('SELECT clock FROM replay_state WHERE id = 1').get();
  const n = Math.round((clock - st.clock) / MINUTE);
  assert.ok(n >= 1, 'stepTo must move forward');
  const r = await step(db, { minutes: n });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.to, clock);
  return r;
}

// Synthetic arithmetic for the standard jump tape (TEST FIXTURE values):
//   decision at 09:48 on the 09:47 minute: ask 5810 u; market estimate = ceil(5810 * 1.005) = 5840 u; $100 budget => 171 sh
//   stop 10% below the ask reference = floor(5229.0) = 5229; take-profit +40% = ceil(8134.0) = 8134.
const EXPECT = { qty: 171, estPx: 5840, stop: 5229, take: 8134 };

test('autonomous paper buy by a RUNNING rules agent, with attached stop-loss and take-profit', async () => {
  const t = scenario('buy', (db) => jumpTape(db, 'FIXA'));
  try {
    await stepTo(t.db, at(9, 47));
    assert.equal(rowsOfType(t.db, t.session_id, 'INTENT_PROPOSED').length, 0, 'the 09:47 jump is not knowable at clock 09:47 (no look-ahead)');
    assert.ok(rowsOfType(t.db, t.session_id, 'AGENT_SCAN').length >= 16, 'the agent scanned every minute');

    await stepTo(t.db, at(9, 48));
    const [prop] = rowsOfType(t.db, t.session_id, 'INTENT_PROPOSED');
    assert.ok(prop, 'agent proposed an intent without any human click');
    assert.equal(prop.ts_sim, at(9, 48));
    assert.equal(prop.actor, 'agent');
    assert.equal(prop.payload.kind, 'entry');
    const it = prop.payload.intent;
    assert.equal(it.source, 'rules');
    assert.equal(it.action, 'open');
    assert.equal(it.instrument.sym, 'FIXA');
    assert.equal(it.qty, EXPECT.qty);
    assert.deepEqual(it.attach, { stop_loss_px_u: EXPECT.stop, take_profit_px_u: EXPECT.take });
    assert.ok(it.quote_ts <= at(9, 48) && it.created_ts === at(9, 48));
    assert.match(it.rationale, /EXPLORATORY DEFAULTS — NOT VALIDATED/);
    assert.match(it.rationale, /trigger, not a guaranteed price/);

    const [acc] = rowsOfType(t.db, t.session_id, 'POLICY_ACCEPT');
    assert.equal(acc.ref_id, it.id);
    assert.ok(acc.payload.checks.every((c) => c.pass), 'every gate rule passed');
    assert.equal(rowsOfType(t.db, t.session_id, 'POLICY_DENY').length, 0);

    const subs = rowsOfType(t.db, t.session_id, 'ORDER_SUBMITTED');
    assert.equal(subs.length, 3, 'entry + stop-loss child + take-profit child');
    assert.ok(subs.every((s) => s.actor === 'agent' && s.agent_id === AGENT));
    const orders = ordersOf(t.db, t.session_id);
    const entry = orders.find((o) => o.role === 'entry');
    const stop = orders.find((o) => o.role === 'stop_loss');
    const tp = orders.find((o) => o.role === 'take_profit');
    assert.equal(entry.status, 'working');
    assert.equal(entry.intent_id, it.id);
    const ge = JSON.parse(entry.meta_json).gate_estimate;
    assert.deepEqual(ge, { priceU: acc.payload.estimate.priceU, qty: acc.payload.estimate.qty, costU: acc.payload.estimate.costU,
      basis: acc.payload.estimate.basis, slippageBps: acc.payload.estimate.slippageBps }, 'agent orders record the gate estimate they were accepted on (as human orders do)');
    assert.equal(stop.status, 'pending_parent');
    assert.equal(stop.stop_px, EXPECT.stop);
    assert.equal(stop.protective, 1);
    assert.equal(tp.limit_px, EXPECT.take);
    assert.equal(stop.oco_group, tp.oco_group);
    const intentRow = t.db.prepare('SELECT * FROM intents WHERE id = ?').get(it.id);
    assert.equal(intentRow.decision, 'ACCEPTED');
    assert.deepEqual(JSON.parse(intentRow.order_ids_json).sort(), [entry.id, stop.id, tp.id].sort());

    await stepTo(t.db, at(9, 49));
    const [fill] = rowsOfType(t.db, t.session_id, 'FILL_ESTIMATED');
    assert.equal(fill.payload.role, 'entry');
    assert.equal(fill.payload.qty, EXPECT.qty);
    assert.equal(fill.payload.priceU, EXPECT.estPx, 'worst ask in the minute + 50 bps slippage, rounded against the trader');
    assert.equal(fill.payload.estimated, true);
    assert.equal(rowsOfType(t.db, t.session_id, 'BRACKET_CHILD_ACTIVATED').length, 2);
    assert.equal(getPosition(t.db, t.session_id, PF, 'FIXA').qty, EXPECT.qty);
    assert.ok(ordersOf(t.db, t.session_id, "AND protective = 1").every((o) => o.status === 'working'));
    const ag = getAgent(t.db, AGENT);
    assert.equal(ag.state, 'RUNNING');
    assert.equal(ag.last_ok.kind, 'entry');
    assert.equal(rowsOfType(t.db, t.session_id, 'INTENT_PROPOSED').length, 1, 'no duplicate entry while holding the symbol');
    assert.deepEqual(verifyChain(t.db).ok, true);
    writeJournalSample(t.db, 'autonomous-buy', {
      session_id: t.session_id, covers: ['autonomous buy', 'attached stop-loss', 'attached take-profit'],
      description: 'RUNNING rules agent scans each replay minute, proposes a typed entry intent with attached stop-loss and take-profit, passes the policy gate, submits without a human click; the entry fills (estimated) and the bracket children activate.',
    });
  } finally { t.cleanup(); }
});

test('triggered stop: gap below the stop gives a modelled worse-than-stop fill and cancels the OCO take-profit', async () => {
  const t = scenario('stop', (db) => jumpTape(db, 'FIXA', {
    after(d, sym) {
      flat(d, sym, at(9, 48), at(9, 49), 5800);
      // TEST FIXTURE gap: the bid falls from 5790 to 4490 inside the 09:50 minute (carried-in state included in min/max).
      addMinute(d, sym, at(9, 50), { trades: { o: 4600, h: 4600, l: 4500, c: 4500, v: 2000, n: 10 }, bid: 4490, ask: 4510,
        minBid: 4490, maxBid: 5790, minAsk: 4510, maxAsk: 5810 });
      flat(d, sym, at(9, 51), at(10, 30), 4500);
    },
  }));
  try {
    await stepTo(t.db, at(9, 51));
    const trig = rowsOfType(t.db, t.session_id, 'STOP_TRIGGERED');
    assert.equal(trig.length, 1);
    assert.equal(trig[0].payload.stop_px, EXPECT.stop);
    const fills = rowsOfType(t.db, t.session_id, 'FILL_ESTIMATED');
    const sf = fills.find((f) => f.payload.role === 'stop_loss');
    assert.ok(sf, 'stop filled');
    // floor(4490 * 0.995) = 4467 < stop 5229: the stop is a trigger, not a guaranteed price.
    assert.equal(sf.payload.priceU, 4467);
    assert.equal(sf.payload.worseThanStop, true);
    assert.equal(sf.payload.qty, EXPECT.qty);
    assert.equal(getPosition(t.db, t.session_id, PF, 'FIXA'), null);
    const tp = ordersOf(t.db, t.session_id, "AND role = 'take_profit'")[0];
    assert.equal(tp.status, 'cancelled');
    assert.equal(tp.reason, 'OCO_SIBLING_FILLED');
    assert.ok(getPortfolio(t.db, t.session_id, PF).realized_pnl < 0);
    await stepTo(t.db, at(9, 55));
    assert.equal(rowsOfType(t.db, t.session_id, 'INTENT_PROPOSED').length, 1, 'no re-entry (max entries per symbol / cooldown)');
    writeJournalSample(t.db, 'triggered-stop', {
      session_id: t.session_id, covers: ['triggered stop', 'worse-than-stop modelled fill', 'OCO sibling cancel'],
      description: 'After an autonomous entry, the bid gaps below the attached stop within one minute; the stop triggers and the estimated fill is at the worst bid less slippage (worseThanStop=true); the take-profit sibling is cancelled.',
    });
  } finally { t.cleanup(); }
});

test('take-profit: a print above the limit fills the attached take-profit and cancels the stop', async () => {
  const t = scenario('tp', (db) => jumpTape(db, 'FIXA', {
    after(d, sym) {
      flat(d, sym, at(9, 48), at(9, 49), 5800);
      addMinute(d, sym, at(9, 50), { trades: { o: 8200, h: 8500, l: 8200, c: 8400, v: 1500, n: 10 }, bid: 8390, ask: 8410,
        minBid: 5790, maxBid: 8390, minAsk: 5810, maxAsk: 8410 });
      flat(d, sym, at(9, 51), at(10, 30), 8400);
    },
  }));
  try {
    await stepTo(t.db, at(9, 51));
    const tf = rowsOfType(t.db, t.session_id, 'FILL_ESTIMATED').find((f) => f.payload.role === 'take_profit');
    assert.ok(tf, 'take-profit filled');
    assert.equal(tf.payload.priceU, EXPECT.take, 'strict trade-through fills at the limit price');
    assert.equal(tf.payload.qty, EXPECT.qty);
    assert.ok(tf.payload.feesU > 0, 'sell-side SEC fee + TAF estimated');
    const stop = ordersOf(t.db, t.session_id, "AND role = 'stop_loss'")[0];
    assert.equal(stop.status, 'cancelled');
    assert.equal(getPosition(t.db, t.session_id, PF, 'FIXA'), null);
    assert.ok(getPortfolio(t.db, t.session_id, PF).realized_pnl > 0);
    writeJournalSample(t.db, 'take-profit', {
      session_id: t.session_id, covers: ['take-profit fill', 'OCO sibling cancel'],
      description: 'After an autonomous entry, a later minute trades through the attached take-profit limit; the take-profit fills at the limit (estimated) and the stop-loss sibling is cancelled.',
    });
  } finally { t.cleanup(); }
});

test('agent cancels a stale unfilled entry after N minutes (cascade cancels its pending bracket)', async () => {
  const strategy = testStrategy({ entry: { orderType: 'limit', limitOffsetBps: 0 }, management: { cancelEntryAfterMin: 2 } });
  const t = scenario('cancel', (db) => jumpTape(db, 'FIXC', {
    after(d, sym) {
      // TEST FIXTURE: the ask moves above the limit (5810) and no trade prints below it -> the limit never fills.
      addMinute(d, sym, at(9, 48), { trades: { o: 6200, h: 6250, l: 6150, c: 6200, v: 800, n: 4 }, bid: 6190, ask: 6210,
        minBid: 5790, maxBid: 6190, minAsk: 5810, maxAsk: 6210 });
      flat(d, sym, at(9, 49), at(10, 30), 6200);
    },
  }), strategy);
  try {
    await stepTo(t.db, at(9, 48));
    const entry = ordersOf(t.db, t.session_id, "AND role = 'entry'")[0];
    assert.equal(entry.type, 'limit');
    assert.equal(entry.limit_px, 5810);
    await stepTo(t.db, at(9, 49));
    assert.equal(ordersOf(t.db, t.session_id, "AND role = 'entry'")[0].status, 'working', 'limit not reached');
    await stepTo(t.db, at(9, 50));
    const props = rowsOfType(t.db, t.session_id, 'INTENT_PROPOSED');
    const cancelProp = props.find((p) => p.payload.kind === 'cancel_stale_entry');
    assert.ok(cancelProp, 'agent proposed the cancel');
    assert.equal(cancelProp.ts_sim, at(9, 50));
    assert.equal(cancelProp.payload.intent.target_order_id, entry.id);
    assert.ok(rowsOfType(t.db, t.session_id, 'POLICY_ACCEPT').some((r) => r.ref_id === cancelProp.payload.intent.id));
    const canc = rowsOfType(t.db, t.session_id, 'ORDER_CANCELLED');
    const ec = canc.find((r) => r.ref_id === entry.id);
    assert.equal(ec.actor, 'agent');
    assert.equal(ec.payload.by, 'agent');
    const after = ordersOf(t.db, t.session_id);
    assert.ok(after.every((o) => o.status === 'cancelled'), 'entry and both pending bracket children cancelled');
    await stepTo(t.db, at(9, 53));
    assert.equal(ordersOf(t.db, t.session_id, "AND role = 'entry'").length, 1, 'no immediate re-entry (max entries per symbol)');
    writeJournalSample(t.db, 'cancellation', {
      session_id: t.session_id, covers: ['agent cancellation of a stale unfilled entry', 'cascade cancel of pending bracket children'],
      description: 'A marketable-limit entry is not reached; after cancelEntryAfterMin the agent proposes a typed cancel intent, the gate accepts it and the orders engine cancels the entry and its pending bracket.',
    });
  } finally { t.cleanup(); }
});

test('agent modifies its protective stop (trail to breakeven) via replaceOrder', async () => {
  const strategy = testStrategy({ exits: { breakevenAtGainPct: 5 } });
  const t = scenario('modify', (db) => jumpTape(db, 'FIXD', {
    after(d, sym) {
      flat(d, sym, at(9, 48), at(9, 48), 5800);
      flat(d, sym, at(9, 49), at(10, 30), 6200);
    },
  }), strategy);
  try {
    await stepTo(t.db, at(9, 50));
    const mod = rowsOfType(t.db, t.session_id, 'INTENT_PROPOSED').find((p) => p.payload.kind === 'trail_stop_breakeven');
    assert.ok(mod, 'agent proposed the stop modification');
    assert.equal(mod.payload.intent.action, 'modify');
    assert.equal(mod.payload.intent.stop_px_u, 5840, 'breakeven = average cost per share incl. fees, ticked up');
    const rep = rowsOfType(t.db, t.session_id, 'ORDER_REPLACED');
    assert.equal(rep.length, 1);
    assert.equal(rep[0].actor, 'agent');
    assert.deepEqual(rep[0].payload.before.stop_px, EXPECT.stop);
    assert.deepEqual(rep[0].payload.after.stop_px, 5840);
    const stop = ordersOf(t.db, t.session_id, "AND role = 'stop_loss'")[0];
    assert.equal(stop.stop_px, 5840);
    assert.equal(stop.status, 'working');
    await stepTo(t.db, at(9, 53));
    assert.equal(rowsOfType(t.db, t.session_id, 'ORDER_REPLACED').length, 1, 'trailed once');
    writeJournalSample(t.db, 'stop-modification', {
      session_id: t.session_id, covers: ['agent modification of a protective stop (trail to breakeven)'],
      description: 'Once the as-of IEX bid exceeds average cost by the configured gain, the agent proposes a typed modify intent; the gate accepts it and replaceOrder moves the working stop to breakeven (still a trigger, not a guaranteed price).',
    });
  } finally { t.cleanup(); }
});

test('time exit: stagnant position is closed at market after N minutes (role time_exit)', async () => {
  const strategy = testStrategy({ exits: { timeExit: { minutes: 3, bandPct: 5 } } });
  const t = scenario('timeexit', (db) => jumpTape(db, 'FIXT'), strategy);
  try {
    await stepTo(t.db, at(9, 51));
    assert.equal(rowsOfType(t.db, t.session_id, 'INTENT_PROPOSED').filter((p) => p.payload.kind === 'time_exit').length, 0, 'not before the deadline');
    // entry filled in the 09:48 minute (known 09:49); deadline = 09:49 + 3 min = 09:52.
    await stepTo(t.db, at(9, 52));
    const te = rowsOfType(t.db, t.session_id, 'INTENT_PROPOSED').find((p) => p.payload.kind === 'time_exit');
    assert.ok(te);
    assert.equal(te.ts_sim, at(9, 52));
    assert.equal(te.payload.intent.action, 'close');
    assert.equal(te.payload.intent.qty, EXPECT.qty);
    const exitOrder = ordersOf(t.db, t.session_id, "AND role = 'time_exit'")[0];
    assert.equal(exitOrder.protective, 1);
    await stepTo(t.db, at(9, 54));
    const f = rowsOfType(t.db, t.session_id, 'FILL_ESTIMATED').find((x) => x.payload.role === 'time_exit');
    assert.ok(f, 'time exit filled (estimated)');
    assert.equal(getPosition(t.db, t.session_id, PF, 'FIXT'), null);
    assert.ok(ordersOf(t.db, t.session_id, 'AND protective = 1').every((o) => o.status !== 'working'), 'no protective order left working on a flat position');
  } finally { t.cleanup(); }
});

test('rejection on budget: the gate denies an entry whose estimated cost exceeds max_trade_spend_usd', async () => {
  const strategy = testStrategy({ entry: { budgetUsd: 5000 } });
  const t = scenario('budget', (db) => jumpTape(db, 'FIXB', { asz: 100_000 }), strategy);
  try {
    await stepTo(t.db, at(9, 48));
    const [deny] = rowsOfType(t.db, t.session_id, 'POLICY_DENY');
    assert.ok(deny, 'denied');
    const codes = deny.payload.reasons.map((r) => r.code);
    assert.ok(codes.includes('BUDGET_EXCEEDED'), codes.join(','));
    assert.equal(deny.actor, 'policy');
    assert.equal(rowsOfType(t.db, t.session_id, 'ORDER_SUBMITTED').length, 0);
    assert.equal(ordersOf(t.db, t.session_id).length, 0);
    const row = t.db.prepare('SELECT * FROM intents WHERE id = ?').get(deny.ref_id);
    assert.equal(row.decision, 'DENIED');
    const ag = getAgent(t.db, AGENT);
    assert.equal(ag.last_fail.code, 'BUDGET_EXCEEDED');
    assert.equal(ag.last_fail.stage, 'policy');
    writeJournalSample(t.db, 'budget-rejection', {
      session_id: t.session_id, covers: ['rejection on budget'],
      description: 'A (test) strategy budget of $5,000 exceeds the cowboy-micro policy max_trade_spend_usd ($1,000): the deterministic gate denies with BUDGET_EXCEEDED and nothing is submitted.',
    });
  } finally { t.cleanup(); }
});

test('rejection on stale quotes: the gate denies when the as-of IEX quote is older than maxQuoteAgeMs', async () => {
  const strategy = testStrategy({ entry: { maxQuoteAgeMs: null } }); // leave quote freshness to the gate
  const staleQts = at(9, 41) + 10_000;
  const t = scenario('stale', (db) => {
    flat(db, 'FIXS', at(9, 30), at(9, 40), 5000);
    // TEST FIXTURE: trades continue but the IEX quote stops updating after 09:41:10.
    flat(db, 'FIXS', at(9, 41), at(9, 46), 5000, () => ({ qts: staleQts, bid: 4990, ask: 5010 }));
    addMinute(db, 'FIXS', at(9, 47), { trades: { o: 5000, h: 5800, l: 5000, c: 5800, v: 4000, n: 15 }, bid: 4990, ask: 5010, qts: staleQts });
    flat(db, 'FIXS', at(9, 48), at(10, 30), 5800, () => ({ qts: staleQts, bid: 4990, ask: 5010 }));
  }, strategy);
  try {
    await stepTo(t.db, at(9, 48));
    const [deny] = rowsOfType(t.db, t.session_id, 'POLICY_DENY');
    assert.ok(deny, 'denied');
    const codes = deny.payload.reasons.map((r) => r.code);
    assert.ok(codes.includes('QUOTE_STALE'), codes.join(','));
    const qf = deny.payload.checks.find((c) => c.rule === 'quote_fresh');
    assert.equal(qf.pass, false);
    assert.equal(ordersOf(t.db, t.session_id).length, 0);
    assert.equal(getAgent(t.db, AGENT).last_fail.code, 'QUOTE_STALE');
    writeJournalSample(t.db, 'stale-quote-rejection', {
      session_id: t.session_id, covers: ['rejection on stale quotes'],
      description: 'The window-return signal fires but the as-of IEX quote has not updated for more than the cowboy-micro quote_fresh limit (300 s); the gate denies with QUOTE_STALE and nothing is submitted.',
    });
  } finally { t.cleanup(); }
});

test('journal chain stays valid across a whole lifecycle scenario', async () => {
  const t = scenario('chain', (db) => jumpTape(db, 'FIXA'));
  try {
    await stepTo(t.db, at(10, 0));
    const v = verifyChain(t.db);
    assert.equal(v.ok, true);
    assert.ok(journalRows(t.db, t.session_id).length > 30);
  } finally { t.cleanup(); }
});
