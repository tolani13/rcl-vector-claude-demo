// TEST FIXTURE — NOT MARKET DATA. Symbol-directory parsing/ingestion with invented symbols and names.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSymDir, ingestSymDir, parseFileCreationTime, latestRefSymbol } from '../../server/data/ingest/nasdaq-symdir.js';
import { etToUtc } from '../../server/util/time.js';
import { tempDb, stubServer } from './helpers.js';

const nasdaqTxt = [
  'Symbol|Security Name|Market Category|Test Issue|Financial Status|Round Lot Size|ETF|NextShares',
  'TFIXA|Testfixture Alpha Labs Inc. - Common Stock|S|N|D|100|N|N',
  'TFIXB|Testfixture Beta Fund|G|N|N|100|Y|N',
  'TFIXZ|Testfixture Zeta Test Issue|Q|Y|N|100|N|N',
  'File Creation Time: 1008202618:05|||||||',
].join('\r\n');
const otherTxt = [
  'ACT Symbol|Security Name|Exchange|CQS Symbol|ETF|Round Lot Size|Test Issue|NASDAQ Symbol',
  'TFIXC|Testfixture Gamma Corp Common Stock|N|TFIXC|N|100|N|TFIXC',
  'TFIXD|Testfixture Delta Trust|P|TFIXD|Y|100|N|TFIXD',
  'File Creation Time: 1008202618:05|||||||',
].join('\r\n');

test('parseFileCreationTime reads MMDDYYYYHH:MM as Eastern time', () => {
  const p = parseFileCreationTime('1008202618:05');
  assert.equal(p.ms, etToUtc('2026-10-08', 18, 5));
  assert.equal(p.iso_et, '2026-10-08 18:05 ET');
  assert.equal(parseFileCreationTime('garbage').ms, null);
});

test('parseSymDir decodes both files and validates structure', () => {
  const n = parseSymDir(nasdaqTxt, 'nasdaq');
  assert.equal(n.checks.header_ok, true);
  assert.equal(n.checks.footer_present, true);
  assert.equal(n.rows.length, 3);
  const a = n.rows.find((r) => r.sym === 'TFIXA');
  assert.equal(a.exchange, 'NASDAQ');
  assert.equal(a.market_category, 'S');
  assert.equal(a.financial_status, 'D');
  assert.equal(a.test_issue, 0);
  assert.equal(n.rows.find((r) => r.sym === 'TFIXZ').test_issue, 1);
  assert.equal(n.rows.find((r) => r.sym === 'TFIXB').etf, 1);
  const o = parseSymDir(otherTxt, 'other');
  assert.equal(o.rows.find((r) => r.sym === 'TFIXC').exchange, 'NYSE');
  assert.equal(o.rows.find((r) => r.sym === 'TFIXD').exchange, 'NYSE Arca');
  const broken = parseSymDir('Symbol|Security Name\nX|Y\n', 'nasdaq');
  assert.equal(broken.checks.header_ok, false);
});

test('ingestSymDir stores one post-dated snapshot dataset', async () => {
  const srv = await stubServer({ '/SymDir/nasdaqlisted.txt': { body: nasdaqTxt }, '/SymDir/otherlisted.txt': { body: otherTxt } });
  const { db, cleanup } = tempDb();
  try {
    const r = await ingestSymDir({ db, baseUrl: `${srv.url}/SymDir` });
    assert.equal(r.status, 'complete');
    assert.equal(r.rowsStored, 5);
    const d = db.prepare('SELECT * FROM datasets WHERE id = ?').get(r.ds);
    assert.equal(d.kind, 'symbol_directory');
    assert.match(d.notes, /CURRENT directory as of its File Creation Time/);
    assert.match(d.notes, /POST-DATED/);
    assert.doesNotMatch(d.notes, /2026-10-07/, 'no hard-coded replay date');
    assert.match(d.notes, /must NOT be used as as-of evidence/);
    assert.equal(d.published_at, etToUtc('2026-10-08', 18, 5));
    const ref = latestRefSymbol(db, 'TFIXA');
    assert.equal(ref.name, 'Testfixture Alpha Labs Inc. - Common Stock');
    assert.equal(ref.file_creation_time, '1008202618:05');
  } finally { cleanup(); await srv.close(); }
});

test('ingestSymDir rejects a file without footer and stores nothing', async () => {
  const srv = await stubServer({ '/SymDir/nasdaqlisted.txt': { body: nasdaqTxt.split('\r\n').slice(0, -1).join('\n') }, '/SymDir/otherlisted.txt': { body: otherTxt } });
  const { db, cleanup } = tempDb();
  try {
    const r = await ingestSymDir({ db, baseUrl: `${srv.url}/SymDir` });
    assert.equal(r.status, 'failed');
    assert.equal(db.prepare('SELECT COUNT(*) n FROM ref_symbols').get().n, 0);
    assert.equal(latestRefSymbol(db, 'TFIXA'), null);
  } finally { cleanup(); await srv.close(); }
});
