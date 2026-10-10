// TEST FIXTURE — NOT MARKET DATA. GDELT adapter against a LOCAL stub server. Titles/URLs below are invented and use
// the reserved .invalid TLD.
import test from 'node:test';
import assert from 'node:assert/strict';
import { companyQuery, gdeltStamp, parseSeenDate, gdeltArtList, storeGdeltResult, mediaAsOf, fetchMediaForSymbol, _resetGdeltLimiter } from '../../server/data/ingest/gdelt.js';
import { recordDataset } from '../../server/data/sources.js';
import { tempDb, stubServer, fakeClock, FIXTURE_LABEL } from './helpers.js';

const asOf = Date.UTC(2026, 9, 7, 14, 30); // 10:30 ET
const art = (title, seendate) => ({ url: `https://news.example.invalid/${encodeURIComponent(title)}`, title, seendate, domain: 'news.example.invalid', language: 'English', sourcecountry: 'United States' });

test('helpers: company query, stamps, seendate', () => {
  assert.equal(companyQuery('Testfixture Alpha Labs Inc. - Common Stock'), '"Testfixture Alpha Labs"');
  assert.equal(companyQuery('Testfixture Holdings Corp Class A Ordinary Shares'), '"Testfixture Holdings"');
  assert.equal(companyQuery('AB Inc'), null, 'too short for a phrase query');
  assert.equal(gdeltStamp(asOf), '20261007143000');
  assert.equal(parseSeenDate('20261007T120000Z'), Date.UTC(2026, 9, 7, 12));
  assert.equal(parseSeenDate('bad'), null);
});

test('artlist: window end clamped to asOf, post-asOf articles dropped, evidence stored with knowable_ts = seendate', async () => {
  _resetGdeltLimiter();
  const srv = await stubServer({
    '/doc': { contentType: 'application/json', body: { articles: [art('Fixture headline one', '20261006T090000Z'), art('Fixture headline two', '20261007T143500Z')] } },
  });
  const { db, cleanup } = tempDb();
  try {
    const clock = fakeClock();
    const r = await gdeltArtList({ query: '"Testfixture Alpha Labs"', startMs: asOf - 7 * 86_400_000, endMs: asOf + 3_600_000, asOf, baseUrl: `${srv.url}/doc`, now: clock.now, sleep: clock.sleep });
    assert.equal(srv.requests[0].query.enddatetime, '20261007143000', 'end clamped to asOf');
    assert.equal(srv.requests[0].query.mode, 'artlist');
    assert.equal(r.status, 'HISTORICAL_REAL');
    assert.equal(r.articles.length, 1);
    assert.equal(r.dropped, 1);
    const s = storeGdeltResult(db, { sym: 'TFIXA', result: r });
    assert.equal(s.inserted, 1);
    const again = storeGdeltResult(db, { sym: 'TFIXA', result: r });
    assert.equal(again.inserted, 0, 'deterministic evidence ids: no duplicates');
    const ev = db.prepare("SELECT * FROM evidence WHERE sym = 'TFIXA'").get();
    assert.equal(ev.kind, 'media');
    assert.equal(ev.knowable_ts, Date.UTC(2026, 9, 6, 9));
    assert.equal(mediaAsOf(db, 'TFIXA', Date.UTC(2026, 9, 6, 8)).length, 0, 'not knowable before seendate');
    assert.equal(mediaAsOf(db, 'TFIXA', asOf).length, 1);
    assert.equal(db.prepare('SELECT status FROM datasets WHERE id = ?').get(s.ds).status, 'complete');
  } finally { cleanup(); await srv.close(); }
});

test('HTTP 429 is retried with backoff within the attempt budget, then reported as PROVIDER_FAULT', async () => {
  _resetGdeltLimiter();
  const srv = await stubServer({ '/doc': { status: 429, body: 'Please limit requests to one every 5 seconds' } });
  const { db, cleanup } = tempDb();
  try {
    const clock = fakeClock();
    const r = await gdeltArtList({ query: '"Testfixture Alpha Labs"', startMs: asOf - 86_400_000, asOf, baseUrl: `${srv.url}/doc`, now: clock.now, sleep: clock.sleep, maxAttempts: 2, backoffMs: 20_000 });
    assert.equal(r.status, 'PROVIDER_FAULT');
    assert.equal(srv.requests.length, 2, 'never more than maxAttempts requests');
    assert.match(r.detail, /429/);
    assert.ok(clock.sleeps.includes(20_000), 'backoff applied');
    const s = storeGdeltResult(db, { sym: 'TFIXA', result: r });
    const d = db.prepare('SELECT * FROM datasets WHERE id = ?').get(s.ds);
    assert.equal(d.status, 'failed');
    assert.match(d.notes, /PROVIDER_FAULT/);
  } finally { cleanup(); await srv.close(); }
});

test('rate limit: consecutive requests wait >= 6 s; non-JSON body is PROVIDER_FAULT', async () => {
  _resetGdeltLimiter();
  const srv = await stubServer({ '/doc': { body: 'The specified phrase is too short.' } });
  try {
    const clock = fakeClock();
    const o = { query: '"Testfixture Alpha Labs"', startMs: asOf - 86_400_000, asOf, baseUrl: `${srv.url}/doc`, now: clock.now, sleep: clock.sleep, maxAttempts: 1 };
    const a = await gdeltArtList(o);
    const b = await gdeltArtList(o);
    assert.equal(a.status, 'PROVIDER_FAULT');
    assert.match(a.detail, /non-JSON/);
    assert.equal(b.status, 'PROVIDER_FAULT');
    assert.ok(clock.sleeps.some((ms) => ms >= 6000), `limiter waited: ${clock.sleeps}`);
  } finally { await srv.close(); }
});

test('fetchMediaForSymbol needs a directory name; otherwise NO_VERIFIED_DATA without a request', async () => {
  _resetGdeltLimiter();
  const { db, cleanup } = tempDb();
  try {
    let calls = 0;
    const r = await fetchMediaForSymbol(db, { sym: 'TFIXA', asOf, fetchImpl: async () => { calls++; throw new Error('no'); } });
    assert.equal(r.status, 'NO_VERIFIED_DATA');
    assert.equal(calls, 0);
  } finally { cleanup(); }
});

test('fetchMediaForSymbol records that its query phrase came from a post-dated directory name', async () => {
  _resetGdeltLimiter();
  const srv = await stubServer({ '/doc': { contentType: 'application/json', body: { articles: [art('Fixture headline one', '20261006T090000Z')] } } });
  const { db, cleanup } = tempDb();
  try {
    // Directory snapshot created 2026-10-08 21:31 ET, after the 10:30 ET 2026-10-07 as-of time.
    recordDataset(db, { id: 'symdir-fixture', kind: 'symbol_directory', provider: FIXTURE_LABEL, status: 'complete', published_at: Date.UTC(2026, 9, 9, 1, 31), ingested_at: Date.UTC(2026, 9, 9, 2) });
    db.prepare(`INSERT INTO ref_symbols (ds, sym, name, exchange, etf, test_issue, round_lot, file_creation_time)
      VALUES ('symdir-fixture', 'TFIXA', 'Testfixture Alpha Labs Inc. - Common Stock', 'NASDAQ', 0, 0, 100, '1008202621:31')`).run();
    const clock = fakeClock();
    const r = await fetchMediaForSymbol(db, { sym: 'TFIXA', asOf, baseUrl: `${srv.url}/doc`, now: clock.now, sleep: clock.sleep });
    assert.equal(r.status, 'HISTORICAL_REAL');
    assert.equal(r.query, '"Testfixture Alpha Labs"');
    assert.equal(r.queryNameSource.postDated, true);
    assert.equal(r.queryNameSource.fileCreationEt, '2026-10-08 21:31 ET');
    const d = db.prepare('SELECT quality_json, notes FROM datasets WHERE id = ?').get(r.ds);
    assert.equal(JSON.parse(d.quality_json).query_name_source.postDated, true);
    assert.match(d.notes, /post-dated name/);
    const ev = mediaAsOf(db, 'TFIXA', asOf)[0];
    assert.equal(ev.body.queryNameSource.postDated, true);
  } finally { cleanup(); await srv.close(); }
});
