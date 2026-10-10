// TEST FIXTURE — NOT MARKET DATA. SEC EDGAR adapter against a LOCAL stub server only (no SEC request is ever made).
// CIKs, accession numbers, forms and share counts below are invented.
import test from 'node:test';
import assert from 'node:assert/strict';
import { secConfig, parseAcceptance, ingestSecEdgar, createSecClient, filingsAsOf, sharesOutstandingAsOf, secSymbolMapping } from '../../server/data/ingest/sec-edgar.js';
import { etToUtc } from '../../server/util/time.js';
import { tempDb, stubServer, fakeClock } from './helpers.js';

const UA = 'VECTOR test-suite fixture-contact@example.invalid';

test('secConfig is BLOCKED without a contact e-mail and never invents one', () => {
  const none = secConfig({});
  assert.equal(none.status, 'BLOCKED');
  assert.match(none.setup, /SEC_USER_AGENT/);
  assert.match(none.setup, /fair-access/);
  assert.equal(secConfig({ SEC_USER_AGENT: 'just a name' }).status, 'BLOCKED');
  assert.equal(secConfig({ SEC_USER_AGENT: UA }).status, 'CONFIGURED');
});

test('ingestSecEdgar returns BLOCKED and makes no request when unconfigured', async () => {
  let calls = 0;
  const { db, cleanup } = tempDb();
  try {
    const r = await ingestSecEdgar({ db, symbols: ['TFIXA'], env: {}, clientOptions: { fetchImpl: async () => { calls++; throw new Error('must not be called'); } } });
    assert.equal(r.status, 'BLOCKED');
    assert.equal(calls, 0);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM datasets WHERE kind = 'filings'").get().n, 0);
  } finally { cleanup(); }
});

test('parseAcceptance reads the wall clock as Eastern time (conservative)', () => {
  assert.equal(parseAcceptance('2026-10-06T16:05:12.000Z'), etToUtc('2026-10-06', 16, 5, 12));
  assert.ok(parseAcceptance('2026-10-06T16:05:12.000Z') > Date.parse('2026-10-06T16:05:12.000Z'), 'ET reading is later than the UTC reading');
  assert.equal(parseAcceptance(''), null);
});

test('rate limiter spaces requests >= 250 ms (fake clock)', async () => {
  const srv = await stubServer({ '/x': { body: '{}', contentType: 'application/json' } });
  try {
    const clock = fakeClock();
    const c = createSecClient({ userAgent: UA, now: clock.now, sleep: clock.sleep });
    for (let i = 0; i < 4; i++) await c.getJson(`${srv.url}/x`);
    const starts = c.log.map((e) => e.startedAt);
    for (let i = 1; i < starts.length; i++) assert.ok(starts[i] - starts[i - 1] >= 250, `gap ${starts[i] - starts[i - 1]}`);
    assert.ok(srv.requests.every((r) => r.headers['user-agent'] === UA));
  } finally { await srv.close(); }
});

test('ingestSecEdgar (stub) stores filings with acceptance times and shares facts; as-of gating works', async () => {
  const sub = {
    cik: '9999001', name: 'Testfixture Alpha Labs', tickers: ['TFIXA'],
    filings: { recent: {
      accessionNumber: ['0009999001-26-000003', '0009999001-26-000002', '0009999001-26-000001'],
      filingDate: ['2026-10-08', '2026-10-06', '2026-08-14'],
      acceptanceDateTime: ['2026-10-08T07:00:00.000Z', '2026-10-06T16:30:00.000Z', ''],
      form: ['8-K', '424B5', '10-Q'],
      primaryDocument: ['a8k.htm', 'p424.htm', 'q10.htm'],
    } },
  };
  const facts = { cik: 9999001, facts: { dei: { EntityCommonStockSharesOutstanding: { units: { shares: [
    { end: '2026-08-01', val: 10000000, accn: '0009999001-26-000001', form: '10-Q', filed: '2026-08-14' },
    { end: '2026-10-01', val: 15000000, accn: '0009999001-26-000003', form: '8-K', filed: '2026-10-08' },
  ] } } } } };
  const srv = await stubServer({
    '/files/company_tickers.json': { body: { 0: { cik_str: 9999001, ticker: 'TFIXA', title: 'Testfixture Alpha Labs' }, 1: { cik_str: 9999002, ticker: 'TFIXB', title: 'Testfixture Beta' } }, contentType: 'application/json' },
    '/submissions/CIK0009999001.json': { body: sub, contentType: 'application/json' },
    '/api/xbrl/companyfacts/CIK0009999001.json': { body: facts, contentType: 'application/json' },
    '/submissions/CIK0009999002.json': { body: { cik: '9999002', filings: { recent: { accessionNumber: [] } } }, contentType: 'application/json' },
  });
  const { db, cleanup } = tempDb();
  try {
    const r = await ingestSecEdgar({
      db, symbols: ['TFIXA', 'TFIXB', 'TFIXQ'], env: { SEC_USER_AGENT: UA },
      clientOptions: { wwwBase: srv.url, dataBase: srv.url, minIntervalMs: 0 },
    });
    assert.equal(r.status, 'partial');
    assert.equal(r.perSymbol.TFIXQ.status, 'NO_CIK');
    assert.match(r.perSymbol.TFIXB.companyFactsError, /NO_COMPANY_FACTS/);
    assert.equal(r.filings, 3);
    assert.equal(r.facts, 2);
    const d = db.prepare('SELECT * FROM datasets WHERE id = ?').get(r.ds);
    assert.equal(d.kind, 'filings');
    assert.match(d.sha256, /^[0-9a-f]{64}$/);
    const f = db.prepare("SELECT * FROM filings WHERE accession = '0009999001-26-000002'").get();
    assert.equal(f.acceptance_ts, etToUtc('2026-10-06', 16, 30));
    assert.match(f.url, /Archives\/edgar\/data\/9999001\/000999900126000002\/p424\.htm$/);

    const asOf = etToUtc('2026-10-07', 10, 30);
    const fl = filingsAsOf(db, 'TFIXA', asOf);
    assert.deepEqual(fl.map((x) => x.form), ['424B5', '10-Q'], '8-K accepted 2026-10-08 is not knowable');
    assert.equal(fl[1].knowableBasis, 'FILING_DATE_22_00_ET_UPPER_BOUND');
    const so = sharesOutstandingAsOf(db, 'TFIXA', asOf);
    assert.deepEqual(so.map((x) => x.value), [10000000]);
    assert.equal(sharesOutstandingAsOf(db, 'TFIXA', etToUtc('2026-10-08', 8, 0)).length, 2);
  } finally { cleanup(); await srv.close(); }
});

test('two tickers sharing one CIK both resolve to its filings and facts; the mapping is stored and labelled post-dated', async () => {
  // TEST FIXTURE — NOT MARKET DATA: one invented issuer with two invented share-class tickers.
  const sub = {
    cik: '9999005', name: 'Testfixture Dual Class Holdings', tickers: ['TFXDA', 'TFXDB'],
    filings: { recent: {
      accessionNumber: ['0009999005-26-000002', '0009999005-26-000001'], filingDate: ['2026-10-06', '2026-08-14'],
      acceptanceDateTime: ['2026-10-06T16:30:00.000Z', '2026-08-14T08:00:00.000Z'], form: ['8-K', '10-Q'], primaryDocument: ['a.htm', 'b.htm'],
    } },
  };
  const facts = { cik: 9999005, facts: { dei: { EntityCommonStockSharesOutstanding: { units: { shares: [
    { end: '2026-08-01', val: 2000000, accn: '0009999005-26-000001', form: '10-Q', filed: '2026-08-14' },
  ] } } } } };
  const srv = await stubServer({
    '/files/company_tickers.json': { body: { 0: { cik_str: 9999005, ticker: 'TFXDA', title: 'Testfixture Dual Class Holdings' }, 1: { cik_str: 9999005, ticker: 'TFXDB', title: 'Testfixture Dual Class Holdings' } }, contentType: 'application/json' },
    '/submissions/CIK0009999005.json': { body: sub, contentType: 'application/json' },
    '/api/xbrl/companyfacts/CIK0009999005.json': { body: facts, contentType: 'application/json' },
  });
  const { db, cleanup } = tempDb();
  try {
    const ingestedAt = etToUtc('2026-10-09', 12, 0);
    const r = await ingestSecEdgar({
      db, symbols: ['TFXDA', 'TFXDB'], env: { SEC_USER_AGENT: UA }, now: () => ingestedAt,
      clientOptions: { wwwBase: srv.url, dataBase: srv.url, minIntervalMs: 0 },
    });
    assert.equal(r.status, 'complete');
    assert.equal(srv.requests.filter((q) => q.path === '/submissions/CIK0009999005.json').length, 1, 'one request per CIK');
    assert.deepEqual(r.perSymbol.TFXDB.sharedCikWith, ['TFXDA']);
    const asOf = etToUtc('2026-10-07', 10, 30);
    for (const sym of ['TFXDA', 'TFXDB']) {
      const fl = filingsAsOf(db, sym, asOf);
      assert.deepEqual(fl.map((x) => x.form), ['8-K', '10-Q'], `${sym} sees the issuer's filings`);
      assert.equal(fl[0].symbolMapping.cik, '0009999005');
      assert.equal(fl[0].symbolMapping.postDated, true, 'mapping fetched after asOf is labelled post-dated');
      assert.deepEqual(sharesOutstandingAsOf(db, sym, asOf).map((x) => x.value), [2000000]);
    }
    assert.equal(secSymbolMapping(db, 'TFXDA', etToUtc('2026-10-10', 9, 0)).postDated, false);
    assert.equal(secSymbolMapping(db, 'TFXZZ', asOf), null);
    assert.equal(filingsAsOf(db, 'TFXZZ', asOf).length, 0);
  } finally { cleanup(); await srv.close(); }
});
