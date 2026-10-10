// TEST FIXTURE — NOT MARKET DATA. Evidence store and evidence-packet as-of behaviour.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  insertEvidence, listAsOf, getEvidence, evidenceId, getEvidenceByIds, EVIDENCE_IDS_MAX,
} from '../../server/intel/evidence.js';
import { buildEvidencePacket, assertPacketAsOf, PACKET_VERSION, packetUnknowns } from '../../server/intel/assessments.js';
import { NOT_IN_STORED_UNIVERSE_NOTE } from '../../server/data/marketdata.js';
import { macroAsOf } from '../../server/data/marketdata.js';
import { etToUtc, MINUTE } from '../../server/util/time.js';
import {
  tempDb, seedFixture, seedNoDirSymbol, FIX_DS, FIX_SYM, FIX_SYM_NODIR, FIX_ASOF, FIX_OPEN, FIX_SYMDIR_PUBLISHED, FIXTURE_LABEL,
} from './helpers.js';

let t;
before(() => { t = tempDb(); seedFixture(t.db); });
after(() => t.cleanup());

const rec = (over = {}) => ({
  sym: FIX_SYM, kind: 'test_note', title: FIXTURE_LABEL, body: { note: FIXTURE_LABEL }, provider: FIXTURE_LABEL,
  ds: FIX_DS, knowable_ts: FIX_ASOF, ...over,
});

test('evidence ids are content-addressed and inserts are idempotent', () => {
  const a = insertEvidence(t.db, rec({ body: { n: 1 } }));
  const b = insertEvidence(t.db, rec({ body: { n: 1 } }));
  const c = insertEvidence(t.db, rec({ body: { n: 2 } }));
  assert.equal(a.id, b.id);
  assert.equal(a.inserted, true);
  assert.equal(b.inserted, false);
  assert.notEqual(a.id, c.id);
  assert.equal(a.id, evidenceId(rec({ body: { n: 1 } })));
});

test('listAsOf never returns evidence knowable after asOf (boundary inclusive)', () => {
  const past = insertEvidence(t.db, rec({ title: 'past', knowable_ts: FIX_ASOF - MINUTE }));
  const exact = insertEvidence(t.db, rec({ title: 'exact', knowable_ts: FIX_ASOF }));
  const future = insertEvidence(t.db, rec({ title: 'future', knowable_ts: FIX_ASOF + 1 }));
  const global = insertEvidence(t.db, rec({ sym: null, title: 'global', knowable_ts: FIX_ASOF - 5 * MINUTE }));
  const rows = listAsOf(t.db, FIX_SYM, FIX_ASOF);
  const ids = rows.map((r) => r.id);
  assert.ok(ids.includes(past.id));
  assert.ok(ids.includes(exact.id));
  assert.ok(ids.includes(global.id));
  assert.ok(!ids.includes(future.id), 'future evidence leaked');
  assert.ok(rows.every((r) => r.knowable_ts <= FIX_ASOF));
  assert.ok(!listAsOf(t.db, FIX_SYM, FIX_ASOF, { includeGlobal: false }).some((r) => r.id === global.id));
  // Later as-of sees it.
  assert.ok(listAsOf(t.db, FIX_SYM, FIX_ASOF + 1).some((r) => r.id === future.id));
  // getEvidence with asOf also filters.
  assert.deepEqual(getEvidence(t.db, [future.id], { asOf: FIX_ASOF }), []);
  assert.equal(getEvidence(t.db, [future.id])[0].body.note, FIXTURE_LABEL);
});

test('evidence is append-only and validated', () => {
  const { id } = insertEvidence(t.db, rec({ title: 'immutable' }));
  assert.throws(() => t.db.prepare("UPDATE evidence SET title = 'x' WHERE id = ?").run(id), /append-only/);
  assert.throws(() => t.db.prepare('DELETE FROM evidence WHERE id = ?').run(id), /append-only/);
  assert.throws(() => insertEvidence(t.db, rec({ knowable_ts: undefined })), /knowable_ts/);
  assert.throws(() => insertEvidence(t.db, rec({ provider: '' })), /provider/);
  assert.throws(() => listAsOf(t.db, FIX_SYM, undefined), /asOf/);
});

test('evidence packet contains only knowable, sourced items (no look-ahead)', () => {
  const p = buildEvidencePacket(t.db, FIX_DS, FIX_SYM, FIX_ASOF);
  assert.equal(p.status, 'OK');
  assert.ok(p.packet.items.length >= 5);
  for (const it of p.packet.items) {
    assert.ok(it.knowable_ts <= FIX_ASOF, `${it.kind} knowable after asOf`);
    assert.ok(it.id.startsWith('ev_'));
    assert.ok(typeof it.provider === 'string' && it.provider.length > 0);
  }
  const kinds = p.packet.items.map((i) => i.kind);
  for (const k of ['market_quote', 'market_price', 'market_volume', 'market_aggressor_inferred', 'market_trading_status', 'symbol_identity', 'finra_short_volume', 'macro_observation']) {
    assert.ok(kinds.includes(k), `missing ${k}`);
  }
  const by = (k) => p.packet.items.find((i) => i.kind === k).body;
  // Last trade is the 10:29 close (0.4590), not the future 10:30 spike (5.00).
  assert.equal(by('market_price').last_trade_usd, 0.459);
  assert.ok(!p.userMessage.includes('99999'), 'future spike volume leaked into packet');
  assert.equal(by('market_quote').bid_usd, 0.458);
  // 5-minute return: 10:24 close 0.4540 -> 0.4590.
  const r5 = by('market_price').returns.find((r) => r.window_min === 5);
  assert.equal(r5.ref_usd, 0.454);
  assert.equal(r5.ret_pct, Math.round(((4590 - 4540) / 4540) * 10000) / 100);
  // Volume vs early baseline: 1000/min in 09:30-10:00, 2000/min in the last 15 minutes.
  const vol = by('market_volume');
  assert.equal(vol.regular_session.volume, 45 * 1000 + 15 * 2000);
  assert.equal(vol.early_baseline.per_min_volume, 1000);
  assert.equal(vol.recent.per_min_volume, 2000);
  assert.equal(vol.recent_vs_early_ratio, 2);
  assert.equal(vol.premarket.volume, 500);
  // Aggressor shares carry their caveat.
  const ag = by('market_aggressor_inferred');
  assert.match(ag.caveat, /inferred aggressor share/i);
  assert.match(ag.caveat, /IEX-only/);
  assert.equal(ag.regular_session.buy_share, 0.75);
  // The future halt (10:30:30) is not visible.
  const st = by('market_trading_status');
  assert.equal(st.halted_now, false);
  assert.equal(st.trading_status_code, 'T');
  assert.equal(st.halted_or_unavailable_minutes, 0);
  assert.ok(!p.userMessage.includes('FUTURE TEST HALT'));
  // Identity comes from a directory published BEFORE asOf and is knowable at its File Creation Time, never at asOf.
  const idItem = p.packet.items.find((i) => i.kind === 'symbol_identity');
  const id = idItem.body;
  assert.deepEqual(Object.keys(id).sort(), ['etf', 'exchange', 'name', 'snapshot_created_et', 'temporal_policy']);
  assert.equal(id.etf, false);
  assert.equal(idItem.knowable_ts, FIX_SYMDIR_PUBLISHED);
  assert.equal(idItem.event_ts, FIX_SYMDIR_PUBLISHED);
  assert.ok(!/assumed unchanged|NON-TEMPORAL/i.test(id.temporal_policy));
  assert.ok(!JSON.stringify(id).includes('financial_status') && !('round_lot' in id), 'temporal status fields must not enter the packet');
  // Short volume only for dates before the trade date.
  const sv = by('finra_short_volume');
  assert.deepEqual(sv.rows.map((r) => r.date), ['2026-01-02']);
  // Macro: the observation knowable after asOf is excluded; the kept one is stamped with the data layer's release time.
  const macro = p.packet.items.filter((i) => i.kind === 'macro_observation');
  assert.equal(macro.length, 1);
  assert.equal(macro[0].body.date, '2026-01-02');
  const latest = macroAsOf(t.db, FIX_ASOF).find((s) => s.series === 'TESTSERIES').latest;
  const legacy = Date.parse('2026-01-03T00:00:00Z');
  assert.equal(macro[0].knowable_ts, Math.max(latest.knowable_ts ?? legacy, legacy));
  assert.ok(macro[0].knowable_ts >= legacy && macro[0].knowable_ts <= FIX_ASOF);
  // Latest-vintage caveat travels with every macro value and the packet header says so.
  assert.equal(macro[0].body.value_vintage, 'LATEST_AT_FETCH');
  assert.match(macro[0].body.vintage_caveat, /may differ from the first-published figure/);
  assert.match(p.userMessage, /LATEST FRED vintage at fetch time and may include revisions/);
  // Derived, self-describing market fields (no window ambiguity).
  const q = by('market_quote');
  assert.equal(q.spread_pct_of_mid, Math.round(((4600 - 4580) / 4590) * 100 * 1000) / 1000);
  assert.equal(q.round_trip_cross_cost_pct, q.spread_pct_of_mid);
  const px = by('market_price');
  assert.equal(px.regular_session.session_high_usd, 0.4595);
  assert.equal(px.regular_session.session_low_usd, 0.399);
  // Recent 15 minutes = minutes 10:15..10:29; the 10:15 bar (close 4450 u) has the lowest low (4440 u).
  assert.equal(px.recent_15m.recent_15m_low_usd, (4000 + 10 * 45 - 10) / 10000);
  assert.equal(px.recent_15m.recent_15m_high_usd, (4000 + 10 * 59 + 5) / 10000);
  assert.ok(!('high_usd' in px.regular_session) && !('vwap_usd' in vol.regular_session));
  assert.ok(Number.isFinite(vol.regular_session.session_vwap_usd));
  assert.equal(p.packet.meta.packet_version, PACKET_VERSION);
  // Hard rules are repeated at the END of the packet (servers that truncate keep the tail).
  assert.match(p.userMessage.split('\n').pop(), /^REMINDER \(hard rules\): use ONLY this packet/);
  // Every item was persisted to the evidence store and is visible as of asOf.
  const stored = new Set(listAsOf(t.db, FIX_SYM, FIX_ASOF).map((r) => r.id));
  for (const eid of p.evidenceIds) assert.ok(stored.has(eid), `evidence ${eid} not persisted`);
  // Derived market summaries are stamped at asOf, so an earlier as-of view cannot see them.
  const earlier = new Set(listAsOf(t.db, FIX_SYM, FIX_ASOF - MINUTE).map((r) => r.id));
  assert.ok(!earlier.has(p.packet.items.find((i) => i.kind === 'market_quote').id));
});

test('symbol identity: a directory published after asOf never reaches the packet, and absence leaks nothing', () => {
  const pd = tempDb();
  try {
    seedFixture(pd.db, { symdirPublished: FIX_ASOF + 1 }); // File Creation Time one ms after the replay clock (TEST FIXTURE)
    seedNoDirSymbol(pd.db);
    const present = buildEvidencePacket(pd.db, FIX_DS, FIX_SYM, FIX_ASOF, { persist: false });
    const absent = buildEvidencePacket(pd.db, FIX_DS, FIX_SYM_NODIR, FIX_ASOF, { persist: false });
    for (const p of [present, absent]) {
      assert.equal(p.status, 'OK');
      assert.ok(!p.packet.items.some((i) => i.kind === 'symbol_identity'), 'post-dated identity entered the packet');
      assert.ok(!p.userMessage.includes('Fixture Corp') && !p.userMessage.includes('TESTX'), 'post-dated directory fields leaked');
      assert.ok(!/not found/i.test(p.userMessage), 'absence from a post-dated directory must not be reported');
    }
    const una = (p) => p.packet.unavailable.filter((u) => u.kind === 'symbol_identity');
    assert.equal(una(present).length, 1);
    assert.equal(una(present)[0].status, 'UNAVAILABLE_NOT_VERIFIED');
    // Byte-identical whether or not the symbol is in the post-dated snapshot.
    assert.equal(JSON.stringify(una(present)), JSON.stringify(una(absent)));
    // Boundary: a directory created exactly at asOf is knowable at asOf.
    const atClock = buildEvidencePacket(pd.db, FIX_DS, FIX_SYM, FIX_ASOF + 1, { persist: false });
    const it = atClock.packet.items.find((i) => i.kind === 'symbol_identity');
    assert.equal(it.knowable_ts, FIX_ASOF + 1);
  } finally {
    pd.cleanup();
  }
});

test('symbol identity: the newest snapshot knowable at asOf is used; a missing symbol is reported neutrally', () => {
  const pd = tempDb();
  try {
    seedFixture(pd.db);
    seedNoDirSymbol(pd.db);
    // A second, POST-dated snapshot with a different name must be ignored at FIX_ASOF (TEST FIXTURE).
    pd.db.prepare(`INSERT INTO datasets (id, kind, provider, published_at, ingested_at, status, notes) VALUES ('test-fixture-symdir-later', 'symbol_directory', ?, ?, ?, 'complete', ?)`)
      .run(`${FIXTURE_LABEL} (later fake directory)`, FIX_ASOF + 86_400_000, Date.now(), FIXTURE_LABEL);
    pd.db.prepare(`INSERT INTO ref_symbols (ds, sym, name, exchange, market_category, financial_status, test_issue, etf, round_lot)
      VALUES ('test-fixture-symdir-later', ?, 'Renamed Corp (TEST FIXTURE)', 'TESTY', 'S', 'N', 0, 0, 100)`).run(FIX_SYM);
    const p = buildEvidencePacket(pd.db, FIX_DS, FIX_SYM, FIX_ASOF, { persist: false });
    const idItem = p.packet.items.find((i) => i.kind === 'symbol_identity');
    assert.equal(idItem.ds, 'test-fixture-symdir');
    assert.equal(idItem.body.name, 'Fixture Corp (TEST FIXTURE)');
    assert.equal(idItem.knowable_ts, FIX_SYMDIR_PUBLISHED);
    assert.ok(!p.userMessage.includes('Renamed Corp'));
    // A day later the newer snapshot is knowable and wins.
    const later = buildEvidencePacket(pd.db, FIX_DS, FIX_SYM, FIX_ASOF + 86_400_000, { persist: false });
    assert.equal(later.packet.items.find((i) => i.kind === 'symbol_identity').body.name, 'Renamed Corp (TEST FIXTURE)');
    // Missing from a legitimately dated directory: neutral wording that mentions symbology, not a delisting.
    const miss = buildEvidencePacket(pd.db, FIX_DS, FIX_SYM_NODIR, FIX_ASOF, { persist: false });
    const u = miss.packet.unavailable.find((x) => x.kind === 'symbol_identity');
    assert.equal(u.status, 'NO_VERIFIED_DATA');
    assert.match(u.detail, /symbology may differ/);
  } finally {
    pd.cleanup();
  }
});

test('provenance guard: nothing may claim to be knowable before its source dataset was published', () => {
  // A legacy-style row stamped at the replay clock although its directory was published later (TEST FIXTURE).
  const pd = tempDb();
  try {
    seedFixture(pd.db, { symdirPublished: FIX_ASOF + 60 * MINUTE });
    const bad = rec({ kind: 'symbol_identity', ds: 'test-fixture-symdir', title: 'legacy identity row (TEST FIXTURE)', knowable_ts: FIX_ASOF });
    const { id } = insertEvidence(pd.db, bad);
    assert.ok(!listAsOf(pd.db, FIX_SYM, FIX_ASOF + 120 * MINUTE).some((r) => r.id === id), 'listAsOf returned a row stamped before its source was published');
    assert.deepEqual(getEvidence(pd.db, [id], { asOf: FIX_ASOF + 120 * MINUTE }), []);
    assert.equal(getEvidence(pd.db, [id]).length, 1, 'audit reads (no asOf) still see the stored row');
    // The packet guard refuses such an item outright, and anything knowable after asOf.
    assert.throws(() => assertPacketAsOf(pd.db, [bad], FIX_ASOF + 120 * MINUTE), /before its source test-fixture-symdir was published/);
    assert.throws(() => assertPacketAsOf(pd.db, [rec({ knowable_ts: FIX_ASOF + 1 })], FIX_ASOF), /as-of violation/);
    assertPacketAsOf(pd.db, [rec({ kind: 'symbol_identity', ds: 'test-fixture-symdir', knowable_ts: FIX_ASOF + 60 * MINUTE })], FIX_ASOF + 60 * MINUTE);
    // A macro dataset with a recorded publication time after asOf contributes nothing at asOf.
    pd.db.prepare("UPDATE datasets SET published_at = ? WHERE id = 'test-fixture-macro'").run(FIX_ASOF + MINUTE);
    const p = buildEvidencePacket(pd.db, FIX_DS, FIX_SYM, FIX_ASOF, { persist: false });
    assert.ok(!p.packet.items.some((i) => i.kind === 'macro_observation'));
    assert.ok(p.packet.unavailable.some((u) => u.kind === 'macro_observation' && /published after the as-of time/.test(u.detail)));
  } finally {
    pd.cleanup();
  }
});

test('packet is deterministic: same inputs give the same hash and ids; persist:false writes nothing', () => {
  const a = buildEvidencePacket(t.db, FIX_DS, FIX_SYM, FIX_ASOF);
  const n = t.db.prepare('SELECT COUNT(*) n FROM evidence').get().n;
  const b = buildEvidencePacket(t.db, FIX_DS, FIX_SYM, FIX_ASOF);
  const c = buildEvidencePacket(t.db, FIX_DS, FIX_SYM, FIX_ASOF, { persist: false });
  assert.equal(a.sha256, b.sha256);
  assert.equal(a.sha256, c.sha256);
  assert.deepEqual(a.evidenceIds, c.evidenceIds);
  assert.equal(t.db.prepare('SELECT COUNT(*) n FROM evidence').get().n, n);
  const later = buildEvidencePacket(t.db, FIX_DS, FIX_SYM, FIX_ASOF + MINUTE, { persist: false });
  assert.notEqual(later.sha256, a.sha256);
});

test('packet status strings when data is missing or the symbol is a test issue', () => {
  assert.equal(buildEvidencePacket(t.db, 'no-such-ds', FIX_SYM, FIX_ASOF).status, 'NO_VERIFIED_DATA');
  assert.equal(buildEvidencePacket(t.db, FIX_DS, 'QQNONE', FIX_ASOF).status, 'NO_VERIFIED_DATA');
  // Before any fixture minute is complete.
  assert.equal(buildEvidencePacket(t.db, FIX_DS, FIX_SYM, etToUtc('2026-01-05', 9, 0)).status, 'NO_VERIFIED_DATA');
  assert.equal(buildEvidencePacket(t.db, FIX_DS, 'ZTEST', FIX_ASOF).status, 'BLOCKED');
  assert.throws(() => buildEvidencePacket(t.db, FIX_DS, 'bad sym!', FIX_ASOF), /invalid symbol/);
  assert.throws(() => buildEvidencePacket(t.db, FIX_DS, FIX_SYM, NaN), /asOf/);
  // Early in the session the baseline is honestly unavailable rather than invented.
  const early = buildEvidencePacket(t.db, FIX_DS, FIX_SYM, FIX_OPEN + 10 * MINUTE, { persist: false });
  assert.equal(early.packet.items.find((i) => i.kind === 'market_volume').body.early_baseline.status, 'NOT_YET_AVAILABLE');
});

test('packet v3 lists sector/industry and analyst views as explicit unknowns (SEC config decides BLOCKED vs NO_VERIFIED_DATA)', () => {
  assert.equal(PACKET_VERSION, 'vector-evidence-packet-v3');
  const kinds = (p) => Object.fromEntries(p.packet.unavailable.map((u) => [u.kind, u]));
  // SEC EDGAR not configured (no SEC_USER_AGENT): sector/industry is BLOCKED.
  const off = buildEvidencePacket(t.db, FIX_DS, FIX_SYM, FIX_ASOF, { persist: false, env: {} });
  const u = kinds(off);
  assert.equal(u.sector_industry.status, 'BLOCKED');
  assert.match(u.sector_industry.detail, /SEC EDGAR access, which is not configured \(SEC_USER_AGENT is not set\)/);
  assert.equal(u.analyst_views.status, 'UNAVAILABLE_NOT_VERIFIED');
  assert.match(u.analyst_views.detail, /must not be inferred/);
  assert.equal(u.filings_news_financing.status, 'NO_VERIFIED_DATA');
  assert.equal(u.other_venues.status, 'NO_VERIFIED_DATA');
  assert.ok(!('filings_news_analysts' in u), 'the v2 combined entry is gone');
  assert.equal(off.packet.meta.packet_version, 'vector-evidence-packet-v3');
  // The model sees the same explicit unknowns.
  assert.match(off.userMessage, /"kind":"sector_industry","status":"BLOCKED"/);
  assert.match(off.userMessage, /"kind":"analyst_views","status":"UNAVAILABLE_NOT_VERIFIED"/);
  // SEC configured (TEST FIXTURE user agent): NO_VERIFIED_DATA, and the user agent never enters the packet.
  const ua = 'VECTOR test suite test-fixture@example.invalid';
  const on = buildEvidencePacket(t.db, FIX_DS, FIX_SYM, FIX_ASOF, { persist: false, env: { SEC_USER_AGENT: ua } });
  assert.equal(kinds(on).sector_industry.status, 'NO_VERIFIED_DATA');
  assert.match(kinds(on).sector_industry.detail, /SIC codes are not ingested/);
  assert.equal(kinds(on).analyst_views.status, 'UNAVAILABLE_NOT_VERIFIED');
  assert.ok(!on.userMessage.includes('test-fixture@example.invalid'));
  // The packet hash records which situation the model was told about.
  assert.notEqual(on.sha256, off.sha256);
  assert.deepEqual(packetUnknowns({}).map((x) => x.kind), ['sector_industry', 'analyst_views', 'filings_news_financing', 'other_venues']);
});

test('a symbol not visible at the as-of time is reported with the NOT_IN_STORED_UNIVERSE wording (nothing about later data)', () => {
  const none = buildEvidencePacket(t.db, FIX_DS, 'QQNONE', FIX_ASOF, { persist: false });
  assert.equal(none.status, 'NO_VERIFIED_DATA');
  assert.equal(none.detail, `QQNONE: ${NOT_IN_STORED_UNIVERSE_NOTE}`);
  assert.match(none.detail, /^QQNONE: NOT_IN_STORED_UNIVERSE_AS_OF: /);
  assert.ok(!/no IEX activity/.test(none.detail));
  // FIX_SYM is stored (it trades below the threshold later today) but has no completed minute at 09:00: the same
  // wording, so the as-of view does not reveal that the symbol appears later.
  const early = buildEvidencePacket(t.db, FIX_DS, FIX_SYM, etToUtc('2026-01-05', 9, 0), { persist: false });
  assert.equal(early.status, 'NO_VERIFIED_DATA');
  assert.equal(early.detail, `${FIX_SYM}: ${NOT_IN_STORED_UNIVERSE_NOTE}`);
});

test('getEvidenceByIds: only rows knowable at or before asOf; unknown and future ids are indistinguishable; strict input', () => {
  const past = insertEvidence(t.db, rec({ title: 'by-id past', knowable_ts: FIX_ASOF - MINUTE }));
  const exact = insertEvidence(t.db, rec({ title: 'by-id exact', knowable_ts: FIX_ASOF }));
  const future = insertEvidence(t.db, rec({ title: 'by-id future', knowable_ts: FIX_ASOF + 1 }));
  const unknown = `ev_${'0'.repeat(24)}`;
  const rows = getEvidenceByIds(t.db, [exact.id, future.id, unknown, past.id, exact.id], FIX_ASOF);
  assert.deepEqual(rows.map((r) => r.id), [exact.id, past.id], 'request order, de-duplicated, future and unknown omitted alike');
  assert.ok(rows.every((r) => r.knowable_ts <= FIX_ASOF));
  assert.deepEqual(Object.keys(rows[0]).sort(), ['body', 'ds', 'event_ts', 'id', 'kind', 'knowable_ts', 'provider', 'source_id', 'source_url', 'sym', 'title']);
  assert.equal(rows[0].body.note, FIXTURE_LABEL);
  assert.ok(!('created_wall' in rows[0]) && !('ingested_ts' in rows[0]), 'wall-clock storage times are not returned');
  // The future row appears once the clock reaches it.
  assert.deepEqual(getEvidenceByIds(t.db, [future.id], FIX_ASOF + 1).map((r) => r.id), [future.id]);
  assert.deepEqual(getEvidenceByIds(t.db, [], FIX_ASOF), []);
  // asOf is mandatory: there is no unfiltered mode.
  assert.throws(() => getEvidenceByIds(t.db, [past.id]), /asOf/);
  assert.throws(() => getEvidenceByIds(t.db, [past.id], null), /asOf/);
  assert.throws(() => getEvidenceByIds(t.db, [past.id], NaN), /asOf/);
  assert.throws(() => getEvidenceByIds(t.db, 'ev_x', FIX_ASOF), /array/);
  assert.throws(() => getEvidenceByIds(t.db, ['ev_NOTHEX'], FIX_ASOF), /invalid evidence id/);
  assert.throws(() => getEvidenceByIds(t.db, ["ev_000000000000000000000000' OR 1=1 --"], FIX_ASOF), /invalid evidence id/);
  assert.throws(() => getEvidenceByIds(t.db, [42], FIX_ASOF), /invalid evidence id/);
  const many = Array.from({ length: EVIDENCE_IDS_MAX + 1 }, (_, i) => `ev_${i.toString(16).padStart(24, '0')}`);
  assert.throws(() => getEvidenceByIds(t.db, many, FIX_ASOF), RangeError);
  assert.equal(getEvidenceByIds(t.db, many.slice(0, EVIDENCE_IDS_MAX), FIX_ASOF).length, 0);
});

test('getEvidenceByIds applies the provenance guard (row stamped before its source was published)', () => {
  const pd = tempDb();
  try {
    seedFixture(pd.db, { symdirPublished: FIX_ASOF + 60 * MINUTE });
    const { id } = insertEvidence(pd.db, rec({ kind: 'symbol_identity', ds: 'test-fixture-symdir', title: 'legacy identity row (TEST FIXTURE)', knowable_ts: FIX_ASOF }));
    assert.deepEqual(getEvidenceByIds(pd.db, [id], FIX_ASOF + 120 * MINUTE), []);
  } finally {
    pd.cleanup();
  }
});
