// TEST FIXTURE — NOT MARKET DATA. Retrospective study logic over invented minute rows:
//   TFIXA breaks out (+30% in one minute at 09:55) and keeps rising (continued),
//   TFIXB breaks out at 10:20 and then falls (reversed),
//   TFIXC never moves, TFIXD jumps in the final minute (nothing observable afterwards).
import test from 'node:test';
import assert from 'node:assert/strict';
import { historicalSignalStudy, clearStudyCache, RETRO_LABEL, EXPLORATORY_LABEL } from '../../server/research/retrospective.js';
import { MINUTE } from '../../server/util/time.js';
import { tempDb, insertMarketDataset, insertMinute, FIXTURE_DS, et } from './helpers.js';

function seed(db) {
  insertMarketDataset(db);
  insertMinute(db, 'TFIXA', et(9, 0), 5000);
  const open = et(9, 30);
  for (let k = 0; k < 390; k++) {
    const t = open + k * MINUTE;
    // TFIXA: flat to 09:54, 6500 at 09:55, then +175 u/min until 10:55, then flat.
    const pa = k < 25 ? 5000 : k === 25 ? 6500 : 6500 + Math.min(k - 25, 60) * 175;
    insertMinute(db, 'TFIXA', t, pa);
    // TFIXB: flat 6000 to 10:19, 7800 at 10:20, then falls 38 u/min for 60 min, then flat.
    const pb = k < 50 ? 6000 : k === 50 ? 7800 : 7800 - Math.min(k - 50, 60) * 38;
    insertMinute(db, 'TFIXB', t, pb);
    insertMinute(db, 'TFIXC', t, 7000);
    insertMinute(db, 'TFIXD', t, k < 389 ? 3000 : 4000);
  }
}

test('signals, classification, matching and the handwritten rule (fills.js) on fixture rows', () => {
  clearStudyCache();
  const { db, cleanup } = tempDb();
  try {
    seed(db);
    const r = historicalSignalStudy(db, FIXTURE_DS, { tier: 'penny' });
    assert.equal(r.label, RETRO_LABEL);
    assert.equal(r.status, 'HISTORICAL_REAL');
    const ev = Object.fromEntries(r.primary.events.map((e) => [e.sym, e]));
    assert.deepEqual(Object.keys(ev).sort(), ['TFIXA', 'TFIXB', 'TFIXD']);
    // Signal time is the knowable time: the end of the 09:55 minute.
    assert.equal(ev.TFIXA.signal.E, et(9, 56));
    assert.equal(ev.TFIXA.signal.refPriceU, 5000);
    assert.ok(Math.abs(ev.TFIXA.signal.ret_w - 0.3) < 1e-9);
    assert.equal(ev.TFIXA.signal.relVol, null, 'less than one window of baseline at 09:56');
    assert.equal(ev.TFIXA.outcome.class, 'continued');
    assert.equal(ev.TFIXA.outcome.horizons[60].priceU, 6500 + 60 * 175);
    assert.equal(ev.TFIXB.signal.E, et(10, 21));
    assert.equal(ev.TFIXB.outcome.class, 'reversed');
    assert.ok(ev.TFIXB.outcome.maePct < -25);
    assert.equal(ev.TFIXD.outcome.class, 'no_session_after_signal');
    assert.equal(r.primary.counts.continued, 1);
    assert.equal(r.primary.counts.reversed, 1);

    // Matched comparison: the only failure is paired with the breakout.
    assert.equal(r.primary.matched.pairs.length, 1);
    assert.equal(r.primary.matched.pairs[0].matchedFailure.sym, 'TFIXB');

    // Too few events => an exploratory lower-threshold run is included and labelled.
    assert.ok(r.exploratory);
    assert.equal(r.exploratory.label, EXPLORATORY_LABEL);
    assert.equal(r.exploratory.thresholdPct, 10);

    const rule = r.primary.handwrittenRule;
    assert.match(rule.fillModel.source, /fills\.js evaluateOrder/);
    const byId = Object.fromEntries(rule.variants.map((v) => [v.id, v]));
    // Contract stop at the buy level: the next minute's starting bid is already below it => immediate trigger.
    const a1 = byId['stop-tp2.5x+timeExit'].results.find((x) => x.sym === 'TFIXA').sim;
    assert.equal(a1.entered, true);
    assert.equal(a1.exitReason, 'stop_loss');
    assert.equal(a1.immediateStopTrigger, true);
    assert.equal(a1.worseThanStop, true);
    assert.ok(a1.entryQty * a1.avgEntryPriceU <= 500_000, 'never spends more than $50');
    assert.ok(a1.pnlU < 0);
    // Alternative interpretation (stop on last trade dipping): the steady rise reaches the 2.5x target.
    const a2 = byId['lastTradeStop-tp2.5x+timeExit'].results.find((x) => x.sym === 'TFIXA').sim;
    assert.equal(a2.exitReason, 'take_profit');
    assert.ok(a2.pnlU > 0);
    const a3 = byId['lastTradeStop-tp3.5x+timeExit'].results.find((x) => x.sym === 'TFIXA').sim;
    assert.equal(a3.exitReason, 'OPEN_AT_SESSION_CLOSE');
    assert.equal(a3.markBasis, 'IEX_BID_AT_CLOSE');
    // The reversal is stopped out under both interpretations; the last-minute signal cannot be entered.
    assert.equal(byId['lastTradeStop-tp2.5x+timeExit'].results.find((x) => x.sym === 'TFIXB').sim.exitReason, 'stop_loss');
    assert.equal(byId['stop-tp2.5x+timeExit'].results.find((x) => x.sym === 'TFIXD').sim.reason, 'SIGNAL_AT_SESSION_CLOSE_NO_ENTRY_MINUTE');
  } finally { cleanup(); clearStudyCache(); }
});

test('no market dataset => NO_VERIFIED_DATA (blocked by data, nothing fabricated)', () => {
  clearStudyCache();
  const { db, cleanup } = tempDb();
  try {
    const r = historicalSignalStudy(db, 'no-such-ds');
    assert.equal(r.status, 'NO_VERIFIED_DATA');
    assert.deepEqual(r.events, []);
  } finally { cleanup(); }
});
