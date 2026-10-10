// TEST FIXTURE — NOT MARKET DATA. FRED ingestion against a local stub server; values below are invented.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseFredCsv, ingestFred } from '../../server/data/ingest/fred.js';
import { macroAsOf } from '../../server/data/marketdata.js';
import { sha256Hex } from '../../server/util/ids.js';
import { tempDb, stubServer } from './helpers.js';

// 14 invented daily rows with two '.' (missing) markers.
const dailyCsv = ['observation_date,DGS10', ...Array.from({ length: 14 }, (_, i) => {
  const d = new Date(Date.UTC(2026, 8, 1 + i)).toISOString().slice(0, 10);
  return `${d},${i === 3 || i === 9 ? '.' : (1 + i / 100).toFixed(2)}`;
})].join('\n') + '\n';
const monthlyCsv = ['observation_date,UNRATE', ...Array.from({ length: 13 }, (_, i) => `${new Date(Date.UTC(2025, i, 1)).toISOString().slice(0, 10)},${(5 + i / 10).toFixed(1)}`)].join('\n');

test('parseFredCsv: missing marker, header and monotonic checks', () => {
  const p = parseFredCsv(dailyCsv, 'DGS10');
  assert.equal(p.checks.header_ok, true);
  assert.equal(p.checks.rows_total, 14);
  assert.equal(p.checks.rows_missing_dot, 2);
  assert.equal(p.rows[3].value, null);
  assert.equal(p.checks.dates_strictly_increasing, true);
  assert.equal(p.checks.rows_invalid, 0);
  const legacy = parseFredCsv('DATE,DGS10\n2026-01-02,1.5\n', 'DGS10');
  assert.equal(legacy.checks.header_ok, true, 'legacy DATE header accepted');
  const bad = parseFredCsv('observation_date,DGS10\n2026-01-03,1\n2026-01-02,2\n2026-01-02,3\n2026-01-04,abc\n', 'DGS10');
  assert.equal(bad.checks.dates_strictly_increasing, false);
  assert.equal(bad.checks.non_monotonic, 1);
  assert.equal(bad.checks.duplicate_dates, 1);
  assert.equal(bad.checks.rows_invalid, 1);
  assert.equal(parseFredCsv('observation_date,DGS2\n', 'DGS10').checks.header_ok, false);
});

test('ingestFred: stores passing series, rejects failing ones, records provenance', async () => {
  const srv = await stubServer({
    '/fredgraph.csv': (req, res, url) => {
      const id = url.searchParams.get('id');
      if (id === 'DGS10') { res.writeHead(200); return res.end(dailyCsv); }
      if (id === 'UNRATE') { res.writeHead(200); return res.end(monthlyCsv); }
      if (id === 'SP500') { res.writeHead(200); return res.end('observation_date,WRONG\n2026-01-01,1\n'); }
      res.writeHead(500); res.end('err');
    },
  });
  const { db, cleanup } = tempDb();
  try {
    const r = await ingestFred({ db, series: ['DGS10', 'UNRATE', 'SP500', 'VIXCLS'], baseUrl: `${srv.url}/fredgraph.csv` });
    assert.equal(r.status, 'partial');
    assert.equal(r.series.DGS10.ok, true);
    assert.equal(r.series.UNRATE.ok, true);
    assert.equal(r.series.SP500.ok, false, 'header mismatch rejected');
    assert.equal(r.series.VIXCLS.ok, false, 'HTTP 500 rejected');
    assert.equal(r.series.DGS10.sha256, sha256Hex(dailyCsv));
    const ser = db.prepare('SELECT * FROM macro_series ORDER BY series').all();
    assert.deepEqual(ser.map((s) => s.series), ['DGS10', 'UNRATE']);
    // publication_lag_days is a LOWER BOUND; DGS10 is gated by its H.15 next-business-day release rule.
    assert.equal(ser.find((s) => s.series === 'DGS10').publication_lag_days, 1);
    assert.equal(ser.find((s) => s.series === 'UNRATE').publication_lag_days, 40);
    assert.match(ser[0].notes, /LATEST VINTAGE/);
    assert.match(ser[0].notes, /next Federal Reserve business day/);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM macro_obs WHERE series = 'DGS10' AND value IS NULL").get().n, 2);
    const d = db.prepare('SELECT * FROM datasets WHERE id = ?').get(r.ds);
    assert.equal(d.kind, 'macro');
    assert.equal(d.status, 'partial');
    assert.match(d.sha256, /^[0-9a-f]{64}$/);
    assert.match(d.attribution, /FRED/);
    const q = JSON.parse(d.quality_json);
    assert.equal(q.rows_stored, 14 + 13);
    // as-of: the Monday 2026-09-14 observation is posted Tuesday 16:30 ET, so it is not knowable at 08:00 ET Tuesday.
    const m = macroAsOf(db, Date.parse('2026-09-15T12:00:00Z')).find((s) => s.series === 'DGS10');
    assert.equal(m.latest.date, '2026-09-13');
    assert.equal(m.release_rule, 'H15_NEXT_BUSINESS_DAY');
    assert.equal(macroAsOf(db, Date.parse('2026-09-15T21:00:00Z')).find((s) => s.series === 'DGS10').latest.date, '2026-09-14');
    assert.match(d.latency_note, /DCOILWTICO weekly/);
  } finally { cleanup(); await srv.close(); }
});

test('ingestFred: network failure yields failed dataset and stores nothing', async () => {
  const srv = await stubServer({});
  const { db, cleanup } = tempDb();
  try {
    const r = await ingestFred({ db, series: ['DGS2'], baseUrl: `${srv.url}/nope.csv` });
    assert.equal(r.status, 'failed');
    assert.equal(db.prepare('SELECT COUNT(*) n FROM macro_obs').get().n, 0);
    assert.equal(db.prepare('SELECT status FROM datasets WHERE id = ?').get(r.ds).status, 'failed');
  } finally { cleanup(); await srv.close(); }
});
