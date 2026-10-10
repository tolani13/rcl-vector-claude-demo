// TEST FIXTURE — NOT MARKET DATA. Stored-universe visibility (data availability must not be a hindsight signal) and
// partial (truncated) datasets. Every symbol, price and volume below is invented.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  barsAsOf, quoteAsOf, lastTradeAsOf, statusAsOf, closeAtOrBefore, symbolVisibleAsOf, storedVisibleFrom, fillMinute,
  coverageEndMs, listMarketDatasets, NOT_IN_STORED_UNIVERSE_NOTE,
} from '../../server/data/marketdata.js';
import { dossier } from '../../server/research/dossier.js';
import { buildEvidencePacket } from '../../server/intel/assessments.js';
import { listSources } from '../../server/data/sources.js';
import { evaluateOrder, defaultCostModel } from '../../server/sim/fills.js';
import { MINUTE } from '../../server/util/time.js';
import { tempDb, insertMarketDataset, insertMinute, FIXTURE_DS, FIXTURE_LABEL, et } from './helpers.js';

function seed(db) {
  insertMarketDataset(db);
  for (let k = 0; k < 150; k++) {
    const t = et(9, 30) + k * MINUTE;
    // TFIXV: $5.50 until 10:59, $4.90 from 11:00 (stored only because it later went below $5).
    insertMinute(db, 'TFIXV', t, t < et(11, 0) ? 55_000 : 49_000, { v: 200 });
    // TFIXQ: trades at $5.20, but its IEX midpoint is below $5 from 10:00 (quote rule).
    insertMinute(db, 'TFIXQ', t, 52_000, t < et(10, 0) ? {} : { bid: 48_000, ask: 51_000 });
  }
  db.prepare('INSERT INTO status_events (ds, sym, ts, kind, code, reason) VALUES (?, ?, ?, ?, ?, ?)').run(FIXTURE_DS, 'TFIXV', et(9, 45), 'trading_status', 'H', 'LUDP');
}

test('a stored symbol is invisible until its first sub-$5 observation is knowable, and then looks like any stored symbol', () => {
  const { db, cleanup } = tempDb();
  try {
    seed(db);
    assert.equal(storedVisibleFrom(db, FIXTURE_DS, 'TFIXV'), et(11, 0));
    assert.equal(storedVisibleFrom(db, FIXTURE_DS, 'TFIXQ'), et(10, 0));
    const ten = et(10, 0);
    // At 10:00 TFIXV answers exactly like a never-stored symbol (TFIXN).
    for (const sym of ['TFIXV', 'TFIXN']) {
      assert.equal(symbolVisibleAsOf(db, FIXTURE_DS, sym, ten), false);
      assert.deepEqual(barsAsOf(db, FIXTURE_DS, sym, ten), []);
      assert.equal(quoteAsOf(db, FIXTURE_DS, sym, ten), null);
      assert.equal(lastTradeAsOf(db, FIXTURE_DS, sym, ten), null);
      assert.equal(closeAtOrBefore(db, FIXTURE_DS, sym, ten, ten), null);
      assert.equal(statusAsOf(db, FIXTURE_DS, sym, ten).known, false);
      const d = dossier(db, FIXTURE_DS, sym, ten);
      assert.equal(d.market.status, 'NO_VERIFIED_DATA');
      assert.equal(d.market.reason, NOT_IN_STORED_UNIVERSE_NOTE);
      assert.equal(d.halts.status, 'NO_VERIFIED_DATA');
      assert.equal(d.halts.reason, NOT_IN_STORED_UNIVERSE_NOTE);
      assert.equal(buildEvidencePacket(db, FIXTURE_DS, sym, ten, { persist: false }).status, 'NO_VERIFIED_DATA');
    }
    // 11:00 row is knowable at 11:01: not yet at 11:00:59, visible from 11:01, with its earlier history.
    assert.equal(symbolVisibleAsOf(db, FIXTURE_DS, 'TFIXV', et(11, 1) - 1), false);
    const late = et(11, 2);
    const bars = barsAsOf(db, FIXTURE_DS, 'TFIXV', late);
    assert.equal(bars.length, 92, '09:30 .. 11:01 once visible');
    assert.equal(bars[0].t, et(9, 30));
    assert.equal(lastTradeAsOf(db, FIXTURE_DS, 'TFIXV', late).priceU, 49_000);
    assert.equal(quoteAsOf(db, FIXTURE_DS, 'TFIXV', late).bid, 48_990);
    const d = dossier(db, FIXTURE_DS, 'TFIXV', late);
    assert.equal(d.market.status, 'HISTORICAL_REAL');
    assert.equal(d.halts.status, 'HISTORICAL_REAL');
    assert.equal(d.halts.events.length, 1);
    assert.equal(buildEvidencePacket(db, FIXTURE_DS, 'TFIXV', late, { persist: false }).status, 'OK');
    // A sub-$5 IEX midpoint qualifies too.
    assert.equal(symbolVisibleAsOf(db, FIXTURE_DS, 'TFIXQ', et(10, 1)), true);
    assert.equal(symbolVisibleAsOf(db, FIXTURE_DS, 'TFIXQ', et(10, 0)), false);
  } finally { cleanup(); }
});

test('reference-list symbols are visible from the session start at any price', () => {
  const { db, cleanup } = tempDb();
  const prev = process.env.VECTOR_LARGECAP_LIST;
  try {
    process.env.VECTOR_LARGECAP_LIST = 'TFIXL';
    insertMarketDataset(db);
    for (let k = 0; k < 10; k++) insertMinute(db, 'TFIXL', et(9, 30) + k * MINUTE, 1_500_000);
    assert.equal(storedVisibleFrom(db, FIXTURE_DS, 'TFIXL'), 0);
    assert.equal(barsAsOf(db, FIXTURE_DS, 'TFIXL', et(9, 35)).length, 5);
  } finally {
    if (prev === undefined) delete process.env.VECTOR_LARGECAP_LIST; else process.env.VECTOR_LARGECAP_LIST = prev;
    cleanup();
  }
});

test('partial dataset: no quote, bar or fill past the coverage end; labelled incomplete', () => {
  const { db, cleanup } = tempDb();
  try {
    insertMarketDataset(db);
    // Truncated at 11:02:xx: coverage ends at 11:02 (that minute was cut part-way through).
    db.prepare("UPDATE datasets SET status = 'partial', quality_json = ? WHERE id = ?").run(JSON.stringify({ coverage_end_ms: et(11, 2), truncated: true }), FIXTURE_DS);
    for (let k = 0; k <= 92; k++) insertMinute(db, 'TFIXA', et(9, 30) + k * MINUTE, 5000, { v: 100 });
    assert.equal(coverageEndMs(db, FIXTURE_DS), et(11, 2));
    const ds = listMarketDatasets(db).find((d) => d.id === FIXTURE_DS);
    assert.equal(ds.complete, false);
    assert.equal(ds.coverage_end, et(11, 2));

    assert.equal(quoteAsOf(db, FIXTURE_DS, 'TFIXA', et(11, 2)).source.minuteRowT, et(11, 1), 'last fully observed minute');
    assert.equal(quoteAsOf(db, FIXTURE_DS, 'TFIXA', et(11, 3)), null, 'old quote is not served after the truncation');
    assert.equal(barsAsOf(db, FIXTURE_DS, 'TFIXA', et(12, 0)).at(-1).t, et(11, 1));
    assert.equal(lastTradeAsOf(db, FIXTURE_DS, 'TFIXA', et(12, 0)).minuteT, et(11, 1));

    const ok = fillMinute(db, FIXTURE_DS, 'TFIXA', et(11, 1), et(11, 2));
    assert.equal(ok.unavailable, false);
    for (const t of [et(11, 2), et(11, 5)]) {
      const m = fillMinute(db, FIXTURE_DS, 'TFIXA', t, t + MINUTE);
      assert.equal(m.unavailable, true);
      assert.equal(m.endQuote, null);
      assert.match(m.note, /DATASET_TRUNCATED/);
      const order = { side: 'buy', type: 'market', qty: 10, filled_qty: 0, status: 'working', kind: 'equity' };
      const r = evaluateOrder(order, m, defaultCostModel('micro'), { cashU: 1e9, positionQty: 0, ds: FIXTURE_DS });
      assert.equal(r.action, 'unfillable');
      assert.equal(r.reason, 'UNAVAILABLE');
    }
    const src = listSources(db, { env: {} }).find((s) => s.id === 'iex-hist');
    assert.equal(src.status, 'HISTORICAL_REAL');
    assert.equal(src.complete, false);
    assert.match(src.notes, /PARTIAL — dataset fixture-ticks-2026-01-15 is truncated/);
    assert.equal(src.datasets[0].coverage_end, et(11, 2));
  } finally { cleanup(); }
});

test('partial dataset without a recorded coverage end falls back to the last received segment (legacy rows)', () => {
  const { db, cleanup } = tempDb();
  try {
    insertMarketDataset(db, 'fixture-legacy-partial');
    db.prepare("UPDATE datasets SET status = 'partial', provider = ?, quality_json = ? WHERE id = ?")
      .run(FIXTURE_LABEL, JSON.stringify({ last_send_ms: et(10, 15) + 42_000 }), 'fixture-legacy-partial');
    assert.equal(coverageEndMs(db, 'fixture-legacy-partial'), et(10, 15));
    insertMarketDataset(db, 'fixture-complete');
    assert.equal(coverageEndMs(db, 'fixture-complete'), null);
  } finally { cleanup(); }
});
