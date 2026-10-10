// TEST FIXTURE — NOT MARKET DATA. Macro release-calendar knowability and the vintage guard. Cases are derived from
// dates only, or use invented observation values that are labelled as fixtures.
import test from 'node:test';
import assert from 'node:assert/strict';
import { macroKnowableTs, macroReleaseRule, federalHolidays, nextBusinessDay, vintageStatus } from '../../server/data/macroCalendar.js';
import { macroAsOf } from '../../server/data/marketdata.js';
import { recordDataset } from '../../server/data/sources.js';
import { buildEvidencePacket } from '../../server/intel/assessments.js';
import { etToUtc, MINUTE } from '../../server/util/time.js';
import { tempDb, insertMarketDataset, insertMinute, FIXTURE_LABEL } from './helpers.js';

const DAY = 86_400_000;
const legacy = (date, lag) => Date.parse(`${date}T00:00:00Z`) + lag * DAY;

test('federal holidays and business days (5 U.S.C. 6103, observed dates)', () => {
  const h = federalHolidays(2026);
  for (const d of ['2026-01-01', '2026-01-19', '2026-02-16', '2026-05-25', '2026-06-19', '2026-07-03', '2026-09-07', '2026-10-12', '2026-11-11', '2026-11-26', '2026-12-25']) {
    assert.ok(h.has(d), `${d} is a 2026 federal holiday (observed)`);
  }
  assert.equal(h.has('2026-07-04'), false, 'Saturday July 4 is observed on Friday July 3');
  assert.equal(nextBusinessDay('2026-10-09'), '2026-10-13', 'Friday -> Tuesday across Columbus Day');
  assert.equal(nextBusinessDay('2026-10-05'), '2026-10-06');
});

test('DCOILWTICO (EIA, weekly Wednesday release): a Monday observation is not knowable on the Wednesday morning', () => {
  const lag = 2;
  // Observation Mon 2026-10-05 is published in the Wednesday 2026-10-07 batch: knowable only at the END of that day.
  const k = macroKnowableTs('DCOILWTICO', '2026-10-05', lag);
  assert.equal(k, etToUtc('2026-10-08', 0, 0));
  assert.ok(k > etToUtc('2026-10-07', 9, 31), 'not knowable at 09:31 ET on the release Wednesday');
  assert.ok(k > etToUtc('2026-10-07', 13, 17), 'not knowable at the 13:17 ET FRED update either (conservative end of day)');
  assert.ok(k > legacy('2026-10-05', lag), 'later than the old flat 2-day lag');
  // Tuesday observation: released the next day (Wednesday). Wednesday observation: released a week later.
  assert.equal(macroKnowableTs('DCOILWTICO', '2026-09-29', lag), etToUtc('2026-10-01', 0, 0));
  assert.equal(macroKnowableTs('DCOILWTICO', '2026-09-30', lag), etToUtc('2026-10-08', 0, 0));
  // Columbus Day week (Mon 2026-10-12 holiday): the release moves to Thursday 2026-10-15.
  assert.equal(macroKnowableTs('DCOILWTICO', '2026-10-07', lag), etToUtc('2026-10-16', 0, 0));
  assert.match(macroReleaseRule('DCOILWTICO', lag).text, /weekly/);
});

test('DTWEXBGS (Fed H.10, weekly Monday release): a Tuesday observation is not knowable that Friday', () => {
  const lag = 3;
  const k = macroKnowableTs('DTWEXBGS', '2026-09-29', lag);
  assert.equal(k, etToUtc('2026-10-05', 16, 30));
  assert.ok(k > etToUtc('2026-10-02', 23, 59));
  assert.equal(macroKnowableTs('DTWEXBGS', '2026-10-02', lag), etToUtc('2026-10-05', 16, 30), 'Friday obs -> following Monday 16:30 ET');
  // Week of 2026-10-05: the Monday after is Columbus Day, so H.10 is posted Tuesday 2026-10-13.
  assert.equal(macroKnowableTs('DTWEXBGS', '2026-10-06', lag), etToUtc('2026-10-13', 16, 30));
});

test('H.15 rates: next Fed business day 16:30 ET; a Friday observation is not knowable on the holiday Monday', () => {
  const k = macroKnowableTs('DGS10', '2026-10-09', 1);
  assert.equal(k, etToUtc('2026-10-13', 16, 30));
  assert.ok(k > etToUtc('2026-10-12', 23, 59), 'Columbus Day Monday');
  assert.equal(macroKnowableTs('T10Y2Y', '2026-10-05', 1), etToUtc('2026-10-06', 16, 30));
});

test('calendar-lag series and the lower bound: never earlier than observation date (UTC midnight) + stored lag', () => {
  assert.equal(macroKnowableTs('VIXCLS', '2026-10-05', 2), etToUtc('2026-10-07', 0, 0));
  assert.equal(macroKnowableTs('UNRATE', '2026-08-01', 40), etToUtc('2026-09-10', 0, 0));
  for (const [series, lag] of [['DGS10', 1], ['DGS2', 1], ['T10Y2Y', 1], ['VIXCLS', 2], ['SP500', 2], ['DCOILWTICO', 2], ['DTWEXBGS', 3], ['FEDFUNDS', 33], ['CPIAUCSL', 50], ['UNRATE', 40]]) {
    for (let i = 0; i < 400; i += 3) {
      const date = new Date(Date.UTC(2025, 0, 1) + i * DAY).toISOString().slice(0, 10);
      assert.ok(macroKnowableTs(series, date, lag) >= legacy(date, lag), `${series} ${date}`);
    }
  }
  assert.throws(() => macroKnowableTs('DGS10', '2026/10/05', 1), TypeError);
});

// ---- integration over invented observations ---------------------------------------------------------------------

const TRADE_DATE = '2026-10-07';
const MDS = 'fixture-ticks-2026-10-07';

function seedMacro(db, { fetchedAt }) {
  recordDataset(db, { id: 'fred-fixture', kind: 'macro', provider: `${FIXTURE_LABEL} (macro fixture)`, status: 'complete', ingested_at: fetchedAt });
  const s = db.prepare('INSERT INTO macro_series (series, ds, title, units, frequency, publication_lag_days, notes) VALUES (?, ?, ?, ?, ?, ?, ?)');
  s.run('DCOILWTICO', 'fred-fixture', 'Fixture weekly-released series', 'fixture units', 'Daily observations, released weekly', 2, FIXTURE_LABEL);
  s.run('CPIAUCSL', 'fred-fixture', 'Fixture revisable monthly series', 'fixture units', 'Monthly', 50, FIXTURE_LABEL);
  const o = db.prepare("INSERT INTO macro_obs (series, date, value, ds) VALUES (?, ?, ?, 'fred-fixture')");
  // Tue 2026-09-29 .. Tue 2026-10-06 (weekdays), invented values 1..6.
  ['2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02', '2026-10-05', '2026-10-06'].forEach((d, i) => o.run('DCOILWTICO', d, i + 1));
  ['2026-06-01', '2026-07-01', '2026-08-01'].forEach((d, i) => o.run('CPIAUCSL', d, 100 + i));
}

test('macroAsOf: weekly-released observations stay hidden until their release; knowable_ts is the release time', () => {
  const { db, cleanup } = tempDb();
  try {
    seedMacro(db, { fetchedAt: etToUtc('2026-10-09', 10, 0) });
    const at = (date, h, m) => macroAsOf(db, etToUtc(date, h, m)).find((s) => s.series === 'DCOILWTICO');
    const morning = at(TRADE_DATE, 9, 31);
    assert.equal(morning.release_rule, 'EIA_WEEKLY_WEDNESDAY');
    assert.equal(morning.latest.date, '2026-09-29', 'Wed 09-30 .. Mon 10-05 are not published before the 10-07 release');
    assert.equal(morning.latest.knowable_ts, etToUtc('2026-10-01', 0, 0));
    assert.equal(at(TRADE_DATE, 16, 0).latest.date, '2026-09-29', 'still hidden during the release day');
    const next = at('2026-10-08', 0, 0);
    assert.equal(next.latest.date, '2026-10-06');
    assert.equal(next.latest.knowable_ts, etToUtc('2026-10-08', 0, 0));
    for (const [d, h, m] of [[TRADE_DATE, 9, 31], ['2026-10-01', 0, 0], ['2026-10-08', 0, 0], ['2026-10-20', 12, 0]]) {
      const asOf = etToUtc(d, h, m);
      for (const s of macroAsOf(db, asOf)) for (const ob of s.observations) assert.ok(ob.knowable_ts <= asOf, `${s.series} ${ob.date} knowable ${ob.knowable_ts} > ${asOf}`);
    }
  } finally { cleanup(); }
});

test('evidence packet: macro item is the released observation with the release-time knowable_ts; revisable series fetched long after asOf are withheld', () => {
  const { db, cleanup } = tempDb();
  try {
    // CPIAUCSL fetched 2026-12-15: more than 20 days after the 10-07 replay, so a later revision cannot be ruled out.
    seedMacro(db, { fetchedAt: etToUtc('2026-12-15', 10, 0) });
    insertMarketDataset(db, MDS, TRADE_DATE);
    const open = etToUtc(TRADE_DATE, 9, 30);
    for (let k = 0; k < 10; k++) insertMinute(db, 'TFIXA', open + k * MINUTE, 5000 + k, {}, MDS);
    const asOf = etToUtc(TRADE_DATE, 9, 41);
    const p = buildEvidencePacket(db, MDS, 'TFIXA', asOf, { persist: false });
    assert.equal(p.status, 'OK', p.detail);
    const macro = p.packet.items.filter((i) => i.kind === 'macro_observation');
    const oil = macro.find((i) => i.body.series === 'DCOILWTICO');
    assert.equal(oil.body.date, '2026-09-29');
    assert.equal(oil.knowable_ts, etToUtc('2026-10-01', 0, 0));
    assert.equal(macro.some((i) => i.body.series === 'CPIAUCSL'), false, 'revisable series withheld');
    const cpi = macroAsOf(db, asOf).find((s) => s.series === 'CPIAUCSL');
    assert.equal(cpi.vintage.withheld, true);
    assert.equal(cpi.vintage.status, 'LATEST_VINTAGE_UNVERIFIED');
    assert.deepEqual(cpi.observations, []);
  } finally { cleanup(); }
});

test('vintageStatus: revisable series withheld across long gaps or a Jan/Feb revision window; never-revised series kept', () => {
  const asOf = etToUtc('2026-10-07', 12, 0);
  assert.equal(vintageStatus('DGS10', asOf + 400 * DAY, asOf).withheld, false);
  assert.equal(vintageStatus('CPIAUCSL', asOf + 2 * DAY, asOf).withheld, false, 'short gap outside Jan/Feb');
  assert.equal(vintageStatus('CPIAUCSL', asOf + 30 * DAY, asOf).withheld, true, 'gap > 20 days');
  assert.equal(vintageStatus('CPIAUCSL', asOf - DAY, asOf).withheld, false, 'fetched before asOf');
  assert.equal(vintageStatus('UNRATE', null, asOf).withheld, true, 'unknown fetch time');
  const jan = etToUtc('2026-01-28', 12, 0);
  assert.equal(vintageStatus('UNRATE', jan + 5 * DAY, jan).withheld, true, 'spans the seasonal-revision window');
});
