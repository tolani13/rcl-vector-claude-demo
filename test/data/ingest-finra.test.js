// TEST FIXTURE — NOT MARKET DATA. FINRA Reg SHO parsing/ingestion with invented symbols and volumes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { tradingDatesBefore, parseRegSho, ingestRegSho, shortVolumeAsOf, finraKnowableTs } from '../../server/data/ingest/finra-regsho.js';
import { etToUtc } from '../../server/util/time.js';
import { tempDb, stubServer } from './helpers.js';

const file = (compact) => [
  'Date|Symbol|ShortVolume|ShortExemptVolume|TotalVolume|Market',
  `${compact}|TFIXA|1200|10|3000|B,Q,N`,
  `${compact}|TFIXB|50.5|0|100.25|Q`,
].join('\n');

test('tradingDatesBefore: five weekdays before the date plus the date', () => {
  assert.deepEqual(tradingDatesBefore('2026-10-07', 5), ['2026-09-30', '2026-10-01', '2026-10-02', '2026-10-05', '2026-10-06', '2026-10-07']);
});

test('parseRegSho validates header, date and numbers', () => {
  const p = parseRegSho(file('20261006'), '2026-10-06');
  assert.equal(p.checks.header_ok, true);
  assert.equal(p.rows.length, 2);
  assert.equal(p.rows[1].short_vol, 50.5);
  const wrong = parseRegSho(file('20261005'), '2026-10-06');
  assert.equal(wrong.checks.wrong_date, 2);
  assert.equal(wrong.rows.length, 0);
});

test('ingestRegSho stores available dates, records missing ones, and as-of gates at 18:00 ET', async () => {
  const srv = await stubServer({
    '/daily/CNMSshvol20261006.txt': { body: file('20261006') },
    '/daily/CNMSshvol20261007.txt': { body: file('20261007') },
    '/daily/CNMSshvol20261005.txt': { status: 403, body: 'AccessDenied' },
  });
  const { db, cleanup } = tempDb();
  try {
    const res = await ingestRegSho({ db, dates: ['2026-10-05', '2026-10-06', '2026-10-07'], baseUrl: `${srv.url}/daily` });
    assert.deepEqual(res.map((r) => r.status), ['failed', 'complete', 'complete']);
    const d = db.prepare("SELECT * FROM datasets WHERE id = 'finra-regsho-cnms-2026-10-06'").get();
    assert.equal(d.kind, 'short_volume');
    assert.equal(d.published_at, etToUtc('2026-10-06', 18, 0));
    assert.match(d.notes, /off-exchange/);
    assert.match(d.notes, /not consolidated volume/);
    assert.equal(db.prepare("SELECT status FROM datasets WHERE id = 'finra-regsho-cnms-2026-10-05'").get().status, 'failed');

    assert.equal(finraKnowableTs('2026-10-07'), etToUtc('2026-10-07', 18, 0));
    const before = shortVolumeAsOf(db, 'TFIXA', etToUtc('2026-10-07', 17, 59));
    assert.deepEqual(before.map((r) => r.date), ['2026-10-06'], '2026-10-07 row not yet knowable at 17:59 ET');
    const after = shortVolumeAsOf(db, 'TFIXA', etToUtc('2026-10-07', 18, 0));
    assert.deepEqual(after.map((r) => r.date), ['2026-10-07', '2026-10-06']);
    assert.equal(after[0].shortRatio, 0.4);
  } finally { cleanup(); await srv.close(); }
});
