// TEST FIXTURE — NOT MARKET DATA. CSV import validation with invented bars for an invented symbol.
import test from 'node:test';
import assert from 'node:assert/strict';
import { importCsvBars, validateManifest, parseCsv, parseTimestamp } from '../../server/data/ingest/csv-import.js';
import { fillMinute } from '../../server/data/marketdata.js';
import { evaluateOrder, defaultCostModel } from '../../server/sim/fills.js';
import { sha256Hex } from '../../server/util/ids.js';
import { etToUtc } from '../../server/util/time.js';
import { listSources } from '../../server/data/sources.js';
import { tempDb } from './helpers.js';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const manifest = (over = {}) => ({
  provider: 'TEST FIXTURE — NOT MARKET DATA (fixture vendor)', source_url: 'https://vendor.example.invalid/bars',
  licence: 'test fixture only', retrieved_at: '2026-01-20T00:00:00Z', timezone: 'America/New_York',
  timestamp_semantics: 'bar_start', symbol: 'TFIXA',
  fields: { time: 'Time', open: 'Open', high: 'High', low: 'Low', close: 'Close', volume: 'Volume' }, ...over,
});
const good = [
  'Time,Open,High,Low,Close,Volume',
  '2026-01-15 09:30,0.5000,0.5200,0.4900,0.5100,1000',
  '2026-01-15 09:31,0.5100,0.5300,0.5050,0.5250,1500',
  '"2026-01-15 09:32",0.5250,0.5250,0.5000,0.5050,0',
].join('\n');

test('manifest validation is strict', () => {
  assert.equal(validateManifest(manifest()).ok, true);
  const v = validateManifest({ ...manifest(), extra: 1, source_url: 'ftp://x', timestamp_semantics: 'middle', retrieved_at: '2026-01-20' });
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => /unknown manifest key: extra/.test(e)));
  assert.ok(v.errors.some((e) => /source_url/.test(e)));
  assert.ok(v.errors.some((e) => /timestamp_semantics/.test(e)));
  assert.ok(v.errors.some((e) => /retrieved_at/.test(e)));
  const { fields, ...noFields } = manifest();
  assert.ok(validateManifest(noFields).errors.some((e) => /fields is required/.test(e)));
});

test('parsers: quoted CSV and timestamps in a named zone / epoch', () => {
  assert.deepEqual(parseCsv('a,"b,c","d""e"\r\n1,2,3\n'), [['a', 'b,c', 'd"e'], ['1', '2', '3']]);
  assert.equal(parseTimestamp('2026-01-15 09:30', 'America/New_York').ms, etToUtc('2026-01-15', 9, 30));
  assert.equal(parseTimestamp('2026-01-15T14:30:00Z', 'UTC').ms, Date.UTC(2026, 0, 15, 14, 30));
  assert.equal(parseTimestamp('1768487400', 'UTC').ms, 1768487400000);
  assert.equal(parseTimestamp('nonsense', 'UTC'), null);
});

test('valid minute bars import as IMPORTED_UNVERIFIED with NULL quotes; orders against them are unfillable', () => {
  const { db, cleanup } = tempDb();
  try {
    const r = importCsvBars(db, { manifest: manifest(), csv: good, now: () => Date.UTC(2026, 0, 21) });
    assert.equal(r.ok, true, JSON.stringify(r.errors));
    assert.equal(r.status, 'IMPORTED_UNVERIFIED');
    assert.equal(r.rows, 3);
    const d = db.prepare('SELECT * FROM datasets WHERE id = ?').get(r.ds);
    assert.equal(d.kind, 'import');
    assert.equal(d.status, 'IMPORTED_UNVERIFIED');
    assert.equal(d.sha256, sha256Hex(Buffer.from(good)));
    assert.match(d.notes, /mere upload does not establish authenticity/);
    assert.match(d.notes, /unfillable/);
    const rows = db.prepare('SELECT * FROM m1 WHERE ds = ? ORDER BY t').all(r.ds);
    assert.equal(rows[0].t, etToUtc('2026-01-15', 9, 30));
    assert.equal(rows[0].o, 5000);
    assert.equal(rows[1].c, 5250);
    assert.ok(rows.every((x) => x.bid === null && x.ask === null && x.qts === null && x.min_bid === null));
    assert.equal(rows[0].xv, rows[0].v, 'aggressor volume unclassified');
    const t = etToUtc('2026-01-15', 9, 31);
    const m = fillMinute(db, r.ds, 'TFIXA', t, t + 60_000);
    const res = evaluateOrder({ side: 'buy', type: 'market', qty: 10, filled_qty: 0, status: 'working', kind: 'equity' }, m, defaultCostModel('micro'), { cashU: 1_000_000, positionQty: 0 });
    assert.equal(res.action, 'unfillable');
    assert.equal(res.reason, 'NO_TWO_SIDED_QUOTE');
  } finally { cleanup(); }
});

test('bar_end semantics and daily bars are placed so they are never knowable early', () => {
  const { db, cleanup } = tempDb();
  try {
    const r = importCsvBars(db, { manifest: manifest({ timestamp_semantics: 'bar_end' }), csv: good, now: () => Date.UTC(2026, 0, 21) });
    assert.equal(db.prepare('SELECT MIN(t) t FROM m1 WHERE ds = ?').get(r.ds).t, etToUtc('2026-01-15', 9, 29));
    const daily = 'Date,O,H,L,C,V\n2026-01-14,1.00,1.10,0.90,1.05,100000\n2026-01-15,1.05,1.20,1.00,1.10,90000\n';
    const r2 = importCsvBars(db, {
      manifest: manifest({ symbol: 'TFIXB', interval: '1d', fields: { time: 'Date', open: 'O', high: 'H', low: 'L', close: 'C', volume: 'V' } }),
      csv: daily, now: () => Date.UTC(2026, 0, 21),
    });
    assert.equal(r2.ok, true, JSON.stringify(r2.errors));
    const ts = db.prepare('SELECT t FROM m1 WHERE ds = ? ORDER BY t').all(r2.ds).map((x) => x.t);
    assert.deepEqual(ts, [etToUtc('2026-01-14', 19, 59), etToUtc('2026-01-15', 19, 59)], 'daily bar knowable only at 20:00 ET');
  } finally { cleanup(); }
});

test('hard checks reject the whole file and store no rows', () => {
  const cases = {
    ohlc_inconsistent: good.replace('0.5000,0.5200,0.4900,0.5100', '0.5000,0.4800,0.4900,0.5100'),
    duplicates: good.replace('2026-01-15 09:31', '2026-01-15 09:30'),
    non_monotonic: [good.split('\n')[0], good.split('\n')[2], good.split('\n')[1]].join('\n'),
    non_positive_price: good.replace('0.5250,0.5250,0.5000,0.5050', '0.5250,0.5250,0,0.5050'),
    future_timestamps: good.replace('2026-01-15 09:32', '2027-01-15 09:32'),
    misaligned_minute: good.replace('2026-01-15 09:31', '2026-01-15T09:31:30-05:00'),
  };
  for (const [check, csv] of Object.entries(cases)) {
    const { db, cleanup } = tempDb();
    try {
      const r = importCsvBars(db, { manifest: manifest(), csv, now: () => Date.UTC(2026, 0, 21) });
      assert.equal(r.ok, false, check);
      assert.equal(r.status, 'REJECTED');
      assert.ok(r.errors.some((e) => e.includes(check)), `${check}: ${r.errors}`);
      assert.equal(db.prepare('SELECT COUNT(*) n FROM m1').get().n, 0);
      assert.equal(db.prepare('SELECT status FROM datasets WHERE id = ?').get(r.ds).status, 'failed');
    } finally { cleanup(); }
  }
  const { db, cleanup } = tempDb();
  try {
    const r = importCsvBars(db, { manifest: manifest({ retrieved_at: '2026-01-15T14:30:30Z' }), csv: good, now: () => Date.UTC(2026, 0, 21) });
    assert.ok(r.errors.some((e) => e.includes('after_retrieved_at')), 'bars cannot postdate their retrieval');
  } finally { cleanup(); }
});

test('a rejected or differently-manifested re-import never overwrites an accepted import\'s provenance', () => {
  const { db, cleanup } = tempDb();
  try {
    const now = () => Date.UTC(2026, 0, 21);
    const first = importCsvBars(db, { manifest: manifest(), csv: good, now });
    assert.equal(first.ok, true, JSON.stringify(first.errors));
    const before = db.prepare('SELECT * FROM datasets WHERE id = ?').get(first.ds);
    const m1Count = () => db.prepare('SELECT COUNT(*) n FROM m1 WHERE ds = ?').get(first.ds).n;
    assert.equal(m1Count(), 3);

    // Same bytes, a manifest typo (retrieved_at before the bars) and a different provider: rejected.
    const bad = importCsvBars(db, { manifest: manifest({ provider: 'SECOND MANIFEST (fixture)', retrieved_at: '2026-01-15T14:00:00Z' }), csv: good, now });
    assert.equal(bad.ok, false);
    assert.equal(bad.status, 'REJECTED');
    assert.notEqual(bad.ds, first.ds, 'the failed attempt is recorded under its own id');
    assert.match(bad.ds, /^import-attempt-TFIXA-/);
    const after = db.prepare('SELECT * FROM datasets WHERE id = ?').get(first.ds);
    for (const k of ['status', 'provider', 'source_url', 'entitlement', 'source_id', 'sha256', 'ingested_at', 'quality_json']) assert.equal(after[k], before[k], `${k} unchanged`);
    assert.equal(m1Count(), 3, 'stored bars unchanged');
    const attempt = db.prepare('SELECT status, notes FROM datasets WHERE id = ?').get(bad.ds);
    assert.equal(attempt.status, 'failed');
    assert.match(attempt.notes, /left unchanged/);
    const src = listSources(db, { env: {} }).find((x) => x.id === 'csv-import');
    assert.equal(src.status, 'IMPORTED_UNVERIFIED');
    assert.equal(src.rows, 3);

    // Same bytes with a different VALID manifest: refused, provenance unchanged.
    const other = importCsvBars(db, { manifest: manifest({ provider: 'OTHER VENDOR (fixture)', licence: 'other licence' }), csv: good, now });
    assert.equal(other.ok, false);
    assert.equal(other.status, 'ALREADY_IMPORTED');
    assert.equal(db.prepare('SELECT provider FROM datasets WHERE id = ?').get(first.ds).provider, before.provider);

    // Identical re-import: idempotent no-op.
    const same = importCsvBars(db, { manifest: manifest(), csv: good, now });
    assert.equal(same.ok, true);
    assert.equal(same.alreadyImported, true);
    assert.equal(same.rows, 3);
    assert.equal(db.prepare('SELECT ingested_at FROM datasets WHERE id = ?').get(first.ds).ingested_at, before.ingested_at);
  } finally { cleanup(); }
});

test('CLI import (scripts/ingest-csv.js) uses the same validator without the 64 KB HTTP body cap', () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  const tag = `${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  const dir = path.join(root, 'data', `test-csv-cli-${tag}`);
  fs.mkdirSync(dir, { recursive: true });
  const dbFile = path.join(dir, 'cli.db');
  try {
    // TEST FIXTURE — NOT MARKET DATA: ~2,000 invented minute bars (well above 64 KB).
    const lines = ['Time,Open,High,Low,Close,Volume'];
    for (let i = 0; i < 2000; i++) {
      const t = etToUtc('2026-01-05', 4, 0) + i * 60_000;
      lines.push(`${new Date(t).toISOString().replace('.000Z', 'Z')},0.5000,0.5100,0.4900,0.5050,${100 + i}`);
    }
    const csvFile = path.join(dir, 'bars.csv');
    fs.writeFileSync(csvFile, lines.join('\n'));
    assert.ok(fs.statSync(csvFile).size > 64 * 1024);
    const mFile = path.join(dir, 'manifest.json');
    fs.writeFileSync(mFile, JSON.stringify(manifest({ timezone: 'UTC' })));
    const run = (extra = []) => spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(root, 'scripts', 'ingest-csv.js'),
      '--manifest', mFile, '--csv', csvFile, '--db', dbFile, '--receipt', 'none', ...extra], { encoding: 'utf8' });
    const r = run();
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /IMPORTED_UNVERIFIED ds=import-TFIXA-[0-9a-f]{12} rows=2000/);
    const r2 = run();
    assert.equal(r2.status, 0);
    assert.match(r2.stdout, /identical re-import/);
    fs.writeFileSync(mFile, JSON.stringify(manifest({ timezone: 'UTC', retrieved_at: '2026-01-05T09:00:00Z' })));
    const r3 = run();
    assert.equal(r3.status, 1, 'rejected import exits 1');
    assert.match(r3.stdout, /REJECTED/);
    assert.match(r3.stdout, /after_retrieved_at/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
