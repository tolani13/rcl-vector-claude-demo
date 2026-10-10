// TEST FIXTURE — NOT MARKET DATA. GET /api/evidence?ids= (as-of the replay clock, provenance-guarded, strict ids) and
// GET /api/journal exclude_type (server-side type exclusion; chain verification stays incremental). Every evidence row
// here is an invented record labelled TEST FIXTURE on the synthetic 2099 tape.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { tempDb, seedFixture, startTestServer, SYM, at, FIXTURE_LABEL } from './helpers.js';
import { insertEvidence } from '../../server/intel/evidence.js';
import { append } from '../../server/journal.js';

let t;
let srv;
let api;
const ev = {};

function fixtureEvidence(name, knowable_ts, extra = {}) {
  return insertEvidence(t.db, {
    sym: SYM, kind: 'test_fixture', title: `${FIXTURE_LABEL}: ${name}`, provider: FIXTURE_LABEL,
    body: { label: FIXTURE_LABEL, name }, knowable_ts, event_ts: knowable_ts, ...extra,
  }).id;
}

before(async () => {
  t = tempDb('evidence');
  seedFixture(t.db);
  // A reference dataset published at 09:15 ET (TEST FIXTURE); a row from it stamped knowable at 09:00 breaks provenance.
  t.db.prepare(`INSERT INTO datasets (id, kind, provider, published_at, ingested_at, status, notes) VALUES ('test-fixture-api-refdir', 'symbol_directory', ?, ?, ?, 'complete', ?)`)
    .run(FIXTURE_LABEL, at(9, 15), Date.now(), FIXTURE_LABEL);
  ev.past = fixtureEvidence('knowable 09:00', at(9, 0));
  ev.future = fixtureEvidence('knowable 10:00', at(10, 0));
  ev.badProvenance = fixtureEvidence('stamped before its source was published', at(9, 0), { ds: 'test-fixture-api-refdir' });
  srv = await startTestServer(t.db);
  api = srv.client;
});
after(async () => { await srv?.close(); t?.cleanup(); });

const UNKNOWN = `ev_${'0'.repeat(24)}`;
const evidence = async (ids) => api.get(`/api/evidence?ids=${ids.join(',')}`);

test('evidence ids are validated strictly: required, ^ev_[0-9a-f]{24}$, at most 50, no unknown keys', async () => {
  const bad = async (p, code) => {
    const r = await api.get(p);
    assert.equal(r.status, 400, r.text);
    assert.equal(r.json.error.code, code);
  };
  await bad('/api/evidence', 'IDS_REQUIRED');
  await bad('/api/evidence?ids=', 'IDS_REQUIRED');
  await bad('/api/evidence?ids=ev_xyz', 'ID_INVALID');
  await bad(`/api/evidence?ids=${ev.past},`, 'ID_INVALID');
  await bad(`/api/evidence?ids=${ev.past.toUpperCase()}`, 'ID_INVALID');
  await bad(`/api/evidence?ids=${encodeURIComponent("ev_' OR 1=1 --")}`, 'ID_INVALID');
  await bad(`/api/evidence?ids=${Array(51).fill(UNKNOWN).join(',')}`, 'IDS_TOO_MANY');
  await bad(`/api/evidence?ids=${ev.past}&sym=${SYM}`, 'UNKNOWN_FIELD');
  assert.equal((await api.get(`/api/evidence?ids=${Array(50).fill(UNKNOWN).join(',')}`)).status, 200, '50 ids are accepted');
  // 50 distinct ids (beyond the intel reader's per-call maximum): looked up in chunks; the known id is found at the end.
  const many = [...Array.from({ length: 49 }, (_, i) => `ev_${(i + 1).toString(16).padStart(24, '0')}`), ev.past];
  const r = await api.get(`/api/evidence?ids=${many.join(',')}`);
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.requested, 50);
  assert.deepEqual(r.json.rows.map((x) => x.id), [ev.past]);
  assert.equal(r.json.unavailable.length, 49);
});

test('only evidence knowable at or before the replay clock is returned; later and unknown ids are indistinguishable', async () => {
  const st = (await api.get('/api/status')).json.replay;
  assert.equal(st.clock, at(9, 30));
  const r = await evidence([ev.future, UNKNOWN, ev.past, ev.badProvenance, ev.past]);
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.asOf, st.clock);
  assert.equal(r.json.session_id, st.session_id);
  assert.equal(r.json.requested, 4, 'duplicates collapse');
  assert.deepEqual(r.json.rows.map((x) => x.id), [ev.past]);
  assert.deepEqual(r.json.unavailable, [ev.future, UNKNOWN, ev.badProvenance], 'future, unknown and provenance-violating ids are reported alike');
  const row = r.json.rows[0];
  assert.equal(row.kind, 'test_fixture');
  assert.equal(row.body.label, FIXTURE_LABEL);
  assert.ok(row.knowable_ts <= st.clock);
  assert.ok(!('ingested_ts' in row) && !('created_wall' in row), 'wall-clock ingestion times are not part of the as-of view');
  assert.ok(!r.text.includes('knowable 10:00'), 'nothing of the later row leaks');
});

test('evidence becomes visible once the clock reaches its knowable time and is hidden again after a reset', async () => {
  const s = await api.post('/api/replay/step', { minutes: 30 });
  assert.equal(s.status, 200, s.text);
  assert.equal(s.json.to, at(10, 0));
  const later = (await evidence([ev.past, ev.future])).json;
  assert.deepEqual(later.rows.map((x) => x.id), [ev.past, ev.future]);
  assert.ok(later.rows.every((x) => x.knowable_ts <= at(10, 0)));
  assert.equal((await api.post('/api/replay/reset', {})).status, 200);
  const again = (await evidence([ev.past, ev.future])).json;
  assert.equal(again.asOf, at(9, 30));
  assert.deepEqual(again.rows.map((x) => x.id), [ev.past]);
  assert.deepEqual(again.unavailable, [ev.future]);
});

test('journal exclude_type drops types server-side, so the page holds only wanted rows; chain verification stays incremental', async () => {
  const st = (await api.get('/api/status')).json.replay;
  for (let i = 0; i < 40; i++) {
    append(t.db, { session_id: st.session_id, ts_sim: st.clock, actor: 'engine', type: 'TEST_FIXTURE_NOISE', ref_id: null, payload: { label: FIXTURE_LABEL, i } });
  }
  append(t.db, { session_id: st.session_id, ts_sim: st.clock, actor: 'engine', type: 'TEST_FIXTURE_OTHER', ref_id: null, payload: { label: FIXTURE_LABEL } });
  append(t.db, { session_id: st.session_id, ts_sim: st.clock, actor: 'engine', type: 'TEST_FIXTURE_NOISE', ref_id: null, payload: { label: FIXTURE_LABEL, last: true } });

  const plain = (await api.get('/api/journal?limit=5')).json;
  assert.ok(plain.rows.filter((r) => r.type === 'TEST_FIXTURE_NOISE').length >= 4, 'without the filter the page is mostly noise');

  const first = await api.get('/api/journal?limit=5&exclude_type=TEST_FIXTURE_NOISE');
  assert.equal(first.status, 200, first.text);
  assert.equal(first.json.rows.length, 5);
  assert.ok(first.json.rows.every((r) => r.type !== 'TEST_FIXTURE_NOISE'));
  assert.equal(first.json.rows[0].type, 'TEST_FIXTURE_OTHER', 'newest wanted row first');
  assert.deepEqual(first.json.filters.exclude_types, ['TEST_FIXTURE_NOISE']);
  assert.equal(first.json.chain.ok, true);

  const two = (await api.get('/api/journal?limit=1000&exclude_type=TEST_FIXTURE_NOISE,TEST_FIXTURE_OTHER,TEST_FIXTURE_NOISE')).json;
  assert.deepEqual(two.filters.exclude_types, ['TEST_FIXTURE_NOISE', 'TEST_FIXTURE_OTHER'], 'deduplicated');
  assert.ok(two.rows.length > 0);
  assert.ok(two.rows.every((r) => r.type !== 'TEST_FIXTURE_NOISE' && r.type !== 'TEST_FIXTURE_OTHER'));
  assert.equal(two.chain.mode, 'incremental', 'filters do not change how the chain is verified');
  assert.equal(two.chain.ok, true);
  const total = t.db.prepare('SELECT COUNT(*) n FROM journal').get().n;
  assert.equal(two.chain.checked, total, 'the whole journal is covered, not only the filtered rows');

  // exclude_type combines with type and with the session scope.
  const typed = (await api.get('/api/journal?type=TEST_FIXTURE_OTHER&exclude_type=TEST_FIXTURE_NOISE')).json;
  assert.deepEqual(typed.rows.map((r) => r.type), ['TEST_FIXTURE_OTHER']);
  const all = (await api.get('/api/journal?session_id=all&limit=1000&exclude_type=TEST_FIXTURE_NOISE')).json;
  assert.equal(all.scope, 'all');
  assert.ok(all.rows.every((r) => r.type !== 'TEST_FIXTURE_NOISE'));

  const bad = async (v) => {
    const r = await api.get(`/api/journal?exclude_type=${encodeURIComponent(v)}`);
    assert.equal(r.status, 400, `${v}: ${r.text}`);
    assert.equal(r.json.error.code, 'EXCLUDE_TYPE_INVALID');
  };
  await bad('agent_scan');
  await bad('AGENT_SCAN,,MARK_TO_MARKET');
  await bad("AGENT_SCAN') OR 1=1 --");
  await bad(`A${'B'.repeat(60)}`);
  await bad(Array.from({ length: 21 }, (_, i) => `TYPE_${i}`).join(','));
  assert.equal((await api.get(`/api/journal?exclude_type=${Array.from({ length: 20 }, (_, i) => `TYPE_${i}`).join(',')}`)).status, 200, '20 types are accepted');
});
