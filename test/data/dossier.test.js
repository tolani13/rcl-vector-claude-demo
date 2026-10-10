// TEST FIXTURE — NOT MARKET DATA. Dossier as-of gating over invented rows for an invented symbol.
import test from 'node:test';
import assert from 'node:assert/strict';
import { dossier, CURRENT_DIRECTORY_LABEL, SECTIONS } from '../../server/research/dossier.js';
import { recordDataset } from '../../server/data/sources.js';
import { MINUTE, etToUtc } from '../../server/util/time.js';
import { tempDb, insertMarketDataset, insertMinute, FIXTURE_DS, FIXTURE_LABEL, et } from './helpers.js';

function seed(db) {
  insertMarketDataset(db);
  for (let k = 0; k < 120; k++) insertMinute(db, 'TFIXA', et(9, 30) + k * MINUTE, 5000 + k, { v: 100, bv: 60, sv: 20 });
  const ev = db.prepare('INSERT INTO status_events (ds, sym, ts, kind, code, reason) VALUES (?, ?, ?, ?, ?, ?)');
  ev.run(FIXTURE_DS, 'TFIXA', et(10, 0), 'trading_status', 'H', 'LUDP');
  ev.run(FIXTURE_DS, 'TFIXA', et(10, 5), 'trading_status', 'T', null);
  ev.run(FIXTURE_DS, 'TFIXA', et(11, 0), 'trading_status', 'H', 'LUDP'); // after asOf
  // Directory snapshot fetched AFTER the as-of date.
  recordDataset(db, { id: 'symdir-fixture', kind: 'symbol_directory', provider: FIXTURE_LABEL, status: 'complete', ingested_at: Date.UTC(2026, 0, 21) });
  db.prepare(`INSERT INTO ref_symbols (ds, sym, name, exchange, market_category, financial_status, test_issue, etf, round_lot, file_creation_time)
    VALUES ('symdir-fixture', 'TFIXA', 'Testfixture Alpha Labs Inc. - Common Stock', 'NASDAQ', 'S', 'D', 0, 0, 100, '0120202618:00')`).run();
  recordDataset(db, { id: 'finra-fixture', kind: 'short_volume', provider: FIXTURE_LABEL, status: 'complete' });
  const sv = db.prepare('INSERT INTO short_volume (date, sym, short_vol, short_exempt_vol, total_vol, markets, ds) VALUES (?, ?, ?, ?, ?, ?, ?)');
  sv.run('2026-01-14', 'TFIXA', 100, 0, 400, 'Q', 'finra-fixture');
  sv.run('2026-01-15', 'TFIXA', 300, 0, 600, 'Q', 'finra-fixture'); // knowable 18:00 ET, after asOf
  recordDataset(db, { id: 'gdelt-TFIXA-fixture', kind: 'media', provider: FIXTURE_LABEL, status: 'complete' });
  const e = db.prepare(`INSERT INTO evidence (id, sym, kind, title, body_json, provider, ds, source_url, source_id, event_ts, knowable_ts, ingested_ts, created_wall)
    VALUES (?, 'TFIXA', 'media', ?, ?, ?, 'gdelt-TFIXA-fixture', ?, ?, ?, ?, 1, 1)`);
  e.run('ev-fixture-1', 'Fixture headline (before)', JSON.stringify({ domain: 'news.example.invalid' }), FIXTURE_LABEL, 'https://news.example.invalid/1', 'x1', et(8, 0), et(8, 0));
  e.run('ev-fixture-2', 'Fixture headline (after)', JSON.stringify({ domain: 'news.example.invalid' }), FIXTURE_LABEL, 'https://news.example.invalid/2', 'x2', et(12, 0), et(12, 0));
}

test('dossier gates every section to asOf and reports explicit statuses', () => {
  const { db, cleanup } = tempDb();
  const prevUa = process.env.SEC_USER_AGENT;
  delete process.env.SEC_USER_AGENT;
  try {
    seed(db);
    const asOf = et(10, 30);
    const d = dossier(db, FIXTURE_DS, 'TFIXA', asOf);
    // The only directory snapshot was created 2026-01-20, after the replay clock: no as-of identity.
    assert.equal(d.identity.status, 'NO_VERIFIED_DATA');
    assert.equal(d.identity.sym, 'TFIXA');
    assert.match(d.identity.reason, /after the replay clock/);
    assert.equal(d.identity.financialStatus, undefined, 'no financial status beside the as-of section');
    assert.equal(d.identity.name, undefined, 'no post-dated name at the top level');
    const cur = d.identity.currentDirectory;
    assert.equal(cur.label, CURRENT_DIRECTORY_LABEL);
    assert.equal(cur.name, 'Testfixture Alpha Labs Inc. - Common Stock');
    assert.equal(cur.financialStatus.code, 'D');
    assert.equal(cur.financialStatus.usableAsOfEvidence, false);
    assert.equal(cur.snapshot.fileCreationMs, etToUtc('2026-01-20', 18, 0));
    assert.equal(cur.snapshot.postDated, true);
    assert.equal(cur.securityType.type, 'common');

    assert.equal(d.market.status, 'HISTORICAL_REAL');
    assert.equal(d.market.sessionToDate.minutes, 60, 'only minutes knowable by 10:30');
    assert.equal(d.market.lastTrade.priceU, 5059);
    assert.equal(d.market.sessionToDate.inferredBuyShare, 0.75);

    assert.equal(d.halts.events.length, 2);
    assert.equal(d.halts.haltEvents, 1);
    assert.equal(d.halts.current.halted, false);

    assert.equal(d.shortVolume.status, 'HISTORICAL_REAL');
    assert.deepEqual(d.shortVolume.rows.map((r) => r.date), ['2026-01-14']);

    assert.equal(d.filings.status, 'BLOCKED');
    assert.match(d.filings.setup, /SEC_USER_AGENT/);
    assert.equal(d.financing.status, 'UNAVAILABLE_NOT_VERIFIED');
    assert.equal(d.leadership.status, 'UNAVAILABLE_NOT_VERIFIED');
    assert.equal(d.sector.status, 'BLOCKED', 'SIC codes need SEC EDGAR access');
    assert.match(d.sector.setup, /SEC_USER_AGENT/);
    assert.equal(d.analystViews.status, 'UNAVAILABLE_NOT_VERIFIED');
    assert.match(d.analystViews.reason, /never inferred or invented/);

    assert.equal(d.media.status, 'HISTORICAL_REAL');
    assert.deepEqual(d.media.items.map((m) => m.id), ['ev-fixture-1']);

    assert.equal(d.assessments.status, 'ASSESSMENT_NOT_RUN');
    const sections = d.unavailable.map((u) => u.section).sort();
    assert.deepEqual(sections, ['analystViews', 'assessments', 'filings', 'financing', 'identity', 'leadership', 'sector']);
    assert.equal(d.unavailable.find((u) => u.section === 'sector').status, 'BLOCKED');
    assert.equal(d.unavailable.find((u) => u.section === 'analystViews').status, 'UNAVAILABLE_NOT_VERIFIED');

    // After 18:00 ET the replay-day FINRA row becomes knowable.
    const late = dossier(db, FIXTURE_DS, 'TFIXA', etToUtc('2026-01-15', 18, 0));
    assert.deepEqual(late.shortVolume.rows.map((r) => r.date), ['2026-01-15', '2026-01-14']);
  } finally {
    if (prevUa !== undefined) process.env.SEC_USER_AGENT = prevUa;
    cleanup();
  }
});

test('dossier without any stored sources: nothing invented', () => {
  const { db, cleanup } = tempDb();
  const prevUa = process.env.SEC_USER_AGENT;
  delete process.env.SEC_USER_AGENT;
  try {
    const d = dossier(db, null, 'TFIXZ', et(10, 30));
    assert.equal(d.identity.status, 'NO_VERIFIED_DATA');
    assert.equal(d.market.status, 'NO_VERIFIED_DATA');
    assert.equal(d.shortVolume.status, 'NO_VERIFIED_DATA');
    assert.equal(d.media.status, 'NO_VERIFIED_DATA');
    assert.equal(d.media.connection, 'NOT_CONNECTED');
    assert.equal(d.unavailable.length, SECTIONS.length);
    assert.equal(SECTIONS.length, 11);
    assert.equal(d.sector.status, 'BLOCKED');
    assert.equal(d.analystViews.status, 'UNAVAILABLE_NOT_VERIFIED');
    assert.throws(() => dossier(db, null, 'bad sym', et(10, 30)), TypeError);
  } finally {
    if (prevUa !== undefined) process.env.SEC_USER_AGENT = prevUa;
    cleanup();
  }
});

test('identity is HISTORICAL_REAL only from a snapshot created at or before asOf; IEX suffix symbols resolve to ACT spellings', () => {
  const { db, cleanup } = tempDb();
  try {
    // TEST FIXTURE — NOT MARKET DATA: a directory snapshot created 2026-01-14 18:00 ET, before the 2026-01-15 replay.
    recordDataset(db, { id: 'symdir-fixture-early', kind: 'symbol_directory', provider: FIXTURE_LABEL, status: 'complete', published_at: etToUtc('2026-01-14', 18, 0), ingested_at: etToUtc('2026-01-14', 18, 5) });
    const ins = db.prepare(`INSERT INTO ref_symbols (ds, sym, name, exchange, market_category, financial_status, test_issue, etf, round_lot, file_creation_time)
      VALUES ('symdir-fixture-early', ?, ?, 'NASDAQ', 'S', ?, 0, 0, 100, '0114202618:00')`);
    ins.run('TFIXA', 'Testfixture Alpha Labs Inc. - Common Stock', 'N');
    ins.run('TFIXA.W', 'Testfixture Alpha Labs Inc. - Warrant', null);
    const d = dossier(db, null, 'TFIXA', et(10, 30));
    assert.equal(d.identity.status, 'HISTORICAL_REAL');
    assert.equal(d.identity.name, 'Testfixture Alpha Labs Inc. - Common Stock');
    assert.equal(d.identity.financialStatus.usableAsOfEvidence, true);
    assert.equal(d.identity.currentDirectory, undefined);
    assert.ok(!d.unavailable.some((u) => u.section === 'identity'));
    // IEX '+' (warrant) is accepted and looked up under its ACT spelling.
    const w = dossier(db, null, 'TFIXA+', et(10, 30));
    assert.equal(w.identity.status, 'HISTORICAL_REAL');
    assert.equal(w.identity.matchedAs, 'TFIXA.W');
    assert.equal(w.identity.securityType.type, 'warrant');
    // Before the snapshot existed it is post-dated again.
    const early = dossier(db, null, 'TFIXA', etToUtc('2026-01-14', 12, 0));
    assert.equal(early.identity.status, 'NO_VERIFIED_DATA');
    assert.equal(early.identity.currentDirectory.label, CURRENT_DIRECTORY_LABEL);
  } finally { cleanup(); }
});
