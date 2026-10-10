// TEST FIXTURE — NOT MARKET DATA. Scanner metrics over invented minute rows for invented symbols.
import test from 'node:test';
import assert from 'node:assert/strict';
import { scanAsOf, SCANNER_LABEL } from '../../server/research/scanner.js';
import { classifySecurity, iexToActSymbol } from '../../server/data/ingest/nasdaq-symdir.js';
import { recordDataset } from '../../server/data/sources.js';
import { MINUTE, etToUtc } from '../../server/util/time.js';
import { tempDb, insertMarketDataset, insertMinute, FIXTURE_DS, FIXTURE_LABEL, et } from './helpers.js';

function seed(db) {
  insertMarketDataset(db);
  const open = et(9, 30);
  for (let k = 0; k < 60; k++) {
    const t = open + k * MINUTE;
    // TFIXA: flat 0.50 for 45 min, then +0.01/min with 3x volume, all buyer-initiated (fixture).
    if (k < 45) insertMinute(db, 'TFIXA', t, 5000, { v: 1000 });
    else insertMinute(db, 'TFIXA', t, 5000 + (k - 44) * 100, { v: 3000, bv: 3000 });
    // TFIXB: flat, unclassified volume.
    insertMinute(db, 'TFIXB', t, 4000, { v: 1000 });
    // TFIXC: trades only during the first 30 minutes, then quote-only rows.
    insertMinute(db, 'TFIXC', t, 3000, k < 30 ? { v: 500 } : { noTrades: true });
    // TFIXL: configured large-cap reference symbol for the segment test.
    insertMinute(db, 'TFIXL', t, 1_500_000, { v: 100, bid: 1_499_900, ask: 1_500_100 });
  }
  // A row that only becomes knowable after the scan clock (10:31) — must not influence a 10:30 scan.
  insertMinute(db, 'TFIXB', et(10, 30), 9000, { v: 999_999, bv: 999_999 });
}

test('scanAsOf computes transparent metrics as of the clock and ranks by score', () => {
  const { db, cleanup } = tempDb();
  try {
    seed(db);
    const asOf = et(10, 30);
    const r = scanAsOf(db, FIXTURE_DS, asOf, { segment: 'micro' });
    assert.equal(r.label, SCANNER_LABEL);
    assert.equal(r.status, 'HISTORICAL_REAL');
    assert.match(r.scoreFormula, /EXPLORATORY WEIGHTS/);
    assert.deepEqual(r.rows.map((x) => x.sym), ['TFIXA', 'TFIXB', 'TFIXC']);
    const a = r.rows[0];
    assert.equal(a.priceU, 6500);
    assert.ok(Math.abs(a.metrics.ret_w - 0.3) < 1e-9, `ret_w ${a.metrics.ret_w}`);
    assert.ok(Math.abs(a.metrics.relVol - 3) < 1e-9, `relVol ${a.metrics.relVol}`);
    assert.equal(a.metrics.buyShare, 1);
    assert.equal(a.metrics.volumeW, 45000);
    // accel = (6500/5800 - 1) - (5800/5000 - 1): second-half return minus first-half return (mid = 10:22 close).
    assert.ok(Math.abs(a.metrics.accel - ((6500 / 5800 - 1) - (5800 / 5000 - 1))) < 1e-9, `accel ${a.metrics.accel}`);
    assert.equal(a.metrics.insufficient, false);
    assert.ok(a.score > 0);
    const b = r.rows[1];
    assert.equal(b.priceU, 4000, 'future row ignored');
    assert.equal(b.metrics.ret_w, 0);
    assert.equal(b.metrics.buyShare, null, 'no classified volume => null, never inferred');
    assert.ok(b.metrics.reasons.includes('LOW_CLASSIFIED_VOLUME'));
    const c = r.rows[2];
    assert.equal(c.metrics.insufficient, true);
    assert.equal(c.score, null);
    assert.ok(c.metrics.reasons.includes('NO_TRADES_IN_WINDOW'));
    assert.ok(r.timing.ms >= 0);
  } finally { cleanup(); }
});

test('early in the session relVol is withheld; large segment uses the configured list; unknown ds => NO_VERIFIED_DATA', () => {
  const { db, cleanup } = tempDb();
  const prev = process.env.VECTOR_LARGECAP_LIST;
  try {
    seed(db);
    const early = scanAsOf(db, FIXTURE_DS, et(9, 50), { segment: 'micro' });
    const a = early.rows.find((x) => x.sym === 'TFIXA');
    assert.equal(a.metrics.relVol, null);
    assert.ok(a.metrics.reasons.includes('BASELINE_TOO_SHORT'));
    process.env.VECTOR_LARGECAP_LIST = 'TFIXL';
    const large = scanAsOf(db, FIXTURE_DS, et(10, 30), { segment: 'large' });
    assert.deepEqual(large.rows.map((x) => x.sym), ['TFIXL']);
    assert.equal(scanAsOf(db, 'no-such-ds', et(10, 30)).status, 'NO_VERIFIED_DATA');
    assert.throws(() => scanAsOf(db, FIXTURE_DS, undefined), TypeError);
  } finally {
    if (prev === undefined) delete process.env.VECTOR_LARGECAP_LIST; else process.env.VECTOR_LARGECAP_LIST = prev;
    cleanup();
  }
});

test('security type from the directory name: non-common instruments rank after common stock, are flagged, and are filterable (never silently hidden)', () => {
  const { db, cleanup } = tempDb();
  try {
    insertMarketDataset(db);
    const open = et(9, 30);
    for (let k = 0; k < 60; k++) {
      const t = open + k * MINUTE;
      // TFIXW+ (warrant): a huge invented jump that would top the score; TFIXC (common): a smaller move.
      insertMinute(db, 'TFIXW+', t, k < 45 ? 500 : 500 + (k - 44) * 100, { v: 2000, bv: k < 45 ? 0 : 2000 });
      insertMinute(db, 'TFIXC', t, k < 45 ? 5000 : 5000 + (k - 44) * 20, { v: 2000, bv: k < 45 ? 0 : 2000 });
      insertMinute(db, 'TFIXU', t, 9000, { v: 2000 });
    }
    // Directory snapshot created AFTER the scan clock: names are display labels flagged post-dated.
    recordDataset(db, { id: 'symdir-fixture', kind: 'symbol_directory', provider: FIXTURE_LABEL, status: 'complete', published_at: etToUtc('2026-01-20', 18, 0), ingested_at: Date.UTC(2026, 0, 21) });
    const ins = db.prepare(`INSERT INTO ref_symbols (ds, sym, name, exchange, etf, test_issue, round_lot, file_creation_time) VALUES ('symdir-fixture', ?, ?, 'NYSE American', 0, 0, 100, '0120202618:00')`);
    ins.run('TFIXW.W', 'Testfixture Wings Corp. Warrants, each exercisable for one share');
    ins.run('TFIXC', 'Testfixture Common Co. - Class A Common Stock');
    ins.run('TFIXU', 'Testfixture Acquisition Corp. - Units, each consisting of one share and one-half of one warrant');
    const asOf = et(10, 30);
    const r = scanAsOf(db, FIXTURE_DS, asOf, { segment: 'micro' });
    assert.deepEqual(r.rows.map((x) => x.sym), ['TFIXC', 'TFIXW+', 'TFIXU'], 'common first, then non-common by score');
    const w = r.rows.find((x) => x.sym === 'TFIXW+');
    assert.ok(w.score > r.rows[0].score, 'the warrant scores higher but does not dominate the default ranking');
    assert.equal(w.securityType.type, 'warrant');
    assert.equal(w.nonCommon, true);
    assert.equal(r.rows.find((x) => x.sym === 'TFIXU').securityType.type, 'unit');
    assert.equal(r.rows[0].securityType.type, 'common');
    assert.equal(r.counts.nonCommon, 2);
    // Names come from a post-dated snapshot: flagged on every row and at scan level.
    assert.equal(w.name, 'Testfixture Wings Corp. Warrants, each exercisable for one share');
    assert.equal(w.namePostDated, true);
    assert.equal(r.nameSource.postDated, true);
    assert.match(r.nameSource.note, /AFTER the replay clock/);
    // Filters expose, never silently drop.
    const common = scanAsOf(db, FIXTURE_DS, asOf, { segment: 'micro', instruments: 'common' });
    assert.deepEqual(common.rows.map((x) => x.sym), ['TFIXC']);
    assert.equal(common.counts.filteredOut, 2);
    assert.deepEqual(scanAsOf(db, FIXTURE_DS, asOf, { segment: 'micro', instruments: 'non_common' }).rows.map((x) => x.sym), ['TFIXW+', 'TFIXU']);
    assert.throws(() => scanAsOf(db, FIXTURE_DS, asOf, { instruments: 'warrants' }), RangeError);
  } finally { cleanup(); }
});

test('classifySecurity and IEX -> ACT symbology', () => {
  assert.equal(classifySecurity({ sym: 'X', name: 'Fixture Inc. - Common Stock' }).type, 'common');
  assert.equal(classifySecurity({ sym: 'X', name: 'Fixture Fund', etf: 1 }).type, 'etf');
  assert.equal(classifySecurity({ sym: 'X', name: 'Fixture Corp. - Rights' }).type, 'right');
  assert.equal(classifySecurity({ sym: 'X', name: 'Fixture Corp. - 8.25% Series A Cumulative Preferred Stock' }).type, 'preferred');
  assert.equal(classifySecurity({ sym: 'X', name: 'Fixture Partners L.P. - Common Units representing Limited Partner Interests' }).type, 'common');
  assert.equal(classifySecurity({ sym: 'X', name: 'Fixture Holdings - American Depositary Shares' }).type, 'adr');
  assert.equal(classifySecurity({ sym: 'TFIXW+' }).type, 'warrant');
  assert.equal(classifySecurity({ sym: 'TFIXR^' }).type, 'right');
  assert.equal(classifySecurity({ sym: 'TFIXP-A' }).type, 'preferred');
  assert.equal(iexToActSymbol('TFIXW+'), 'TFIXW.W');
  assert.equal(iexToActSymbol('TFIXP-A'), 'TFIXP$A');
  assert.equal(iexToActSymbol('TFIXR^'), 'TFIXR.R');
  assert.equal(iexToActSymbol('TFIXC'), null);
});

test('relVol: null below a 15-minute or zero-volume baseline; a thin (< 1,000 share) baseline is shown flagged and not scored', () => {
  const { db, cleanup } = tempDb();
  try {
    insertMarketDataset(db);
    const open = et(9, 30);
    for (let k = 0; k < 60; k++) {
      const t = open + k * MINUTE;
      // TFIXT: 1 share per minute for 15 minutes, then 5,000 per minute (invented); TFIXZ: no volume before the window.
      insertMinute(db, 'TFIXT', t, 5000, { v: k < 15 ? 1 : 5000 });
      if (k >= 45) insertMinute(db, 'TFIXZ', t, 4000, { v: 500 });
      else insertMinute(db, 'TFIXZ', t, 4000, { noTrades: true });
    }
    const r = scanAsOf(db, FIXTURE_DS, et(10, 0), { segment: 'micro' });
    const t = r.rows.find((x) => x.sym === 'TFIXT');
    assert.equal(t.metrics.relVolBasis.baselineVolume, 15);
    assert.equal(t.metrics.relVolBasis.baselineMin, 15);
    assert.ok(t.metrics.relVol > 1000, 'the shared definition still yields a (huge) value');
    assert.equal(t.metrics.relVolBasis.thinBaseline, true);
    assert.ok(t.metrics.reasons.includes('THIN_BASELINE'));
    assert.equal(t.scoreParts.relVol, 0, 'a thin baseline contributes nothing to the score');
    const z = scanAsOf(db, FIXTURE_DS, et(10, 30), { segment: 'micro' }).rows.find((x) => x.sym === 'TFIXZ');
    assert.equal(z.metrics.relVol, null);
    assert.ok(z.metrics.reasons.includes('NO_BASELINE_VOLUME'));
  } finally { cleanup(); }
});
