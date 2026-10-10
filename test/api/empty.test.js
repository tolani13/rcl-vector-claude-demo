// TEST FIXTURE — NOT MARKET DATA. With an empty database the server still starts and every view reports an explicit
// NO_VERIFIED_DATA / BLOCKED / ASSESSMENT_NOT_RUN status instead of placeholder values.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { tempDb, startTestServer } from './helpers.js';

let t;
let srv;
let api;

before(async () => {
  t = tempDb('empty');
  srv = await startTestServer(t.db);
  api = srv.client;
});
after(async () => { await srv?.close(); t?.cleanup(); });

test('status: NO_VERIFIED_DATA data mode and replay, paper-only, model disconnected, options unverified', async () => {
  const s = (await api.get('/api/status')).json;
  assert.equal(s.data.mode, 'NO_VERIFIED_DATA');
  assert.equal(s.data.dataset, null);
  assert.equal(s.replay.status, 'NO_VERIFIED_DATA');
  assert.equal(s.replay.ds, null);
  assert.equal(s.replay.clock, null);
  assert.equal(s.app.paperOnly, true);
  assert.equal(s.model.status, 'DISCONNECTED');
  assert.equal(s.options.status, 'NO_VERIFIED_OPTIONS_DATA');
  assert.equal(s.kill.engaged, false);
  assert.equal(s.agents.length, 6);
});

test('as-of views return explicit statuses and empty rows, never placeholders', async () => {
  const expectEmpty = async (p, status = 'NO_VERIFIED_DATA') => {
    const r = await api.get(p);
    assert.equal(r.status, 200, `${p}: ${r.text}`);
    assert.equal(r.json.status, status, p);
    return r.json;
  };
  assert.deepEqual((await expectEmpty('/api/market/universe?segment=micro')).rows, []);
  assert.deepEqual((await expectEmpty('/api/research/opportunities?segment=large')).rows, []);
  assert.deepEqual((await expectEmpty('/api/market/bars?sym=TFXA')).rows, []);
  assert.deepEqual((await expectEmpty('/api/market/benchmark')).series, []);
  assert.deepEqual((await expectEmpty('/api/macro')).series, []);
  assert.deepEqual((await expectEmpty('/api/research/study', 'BLOCKED')).rows, []);
  assert.deepEqual((await expectEmpty('/api/assessments?sym=TFXA', 'ASSESSMENT_NOT_RUN')).rows, []);
  const d = (await api.get('/api/research/dossier?sym=TFXA')).json;
  assert.equal(d.identity.status, 'NO_VERIFIED_DATA');
  assert.ok(d.unavailable.length >= 8);
  const sources = (await api.get('/api/sources')).json;
  assert.ok(sources.length >= 9);
  assert.ok(sources.every((x) => ['NO_VERIFIED_DATA', 'BLOCKED', 'PROVIDER_FAULT'].includes(x.status)), JSON.stringify(sources.map((x) => [x.id, x.status])));
  const pf = (await api.get('/api/portfolios')).json;
  assert.equal(pf.status, 'NO_VERIFIED_DATA');
  assert.equal(pf.rows.length, 7); // seed money exists; no market data does
});

test('mutations that need market data are refused with 409 NO_VERIFIED_DATA', async () => {
  const step = await api.post('/api/replay/step', { minutes: 1 });
  assert.equal(step.status, 409);
  assert.equal(step.json.error.code, 'NO_VERIFIED_DATA');
  const play = await api.post('/api/replay/play', {});
  assert.equal(play.status, 409);
  const order = await api.post('/api/orders', { action: 'open', instrument: { kind: 'equity', sym: 'TFXA' }, side: 'buy', order_type: 'market', qty: 1, confirm: true });
  assert.equal(order.status, 409);
  assert.equal(order.json.error.code, 'NO_VERIFIED_DATA');
  const reset = await api.post('/api/replay/reset', {});
  assert.equal(reset.status, 200);
  assert.equal(reset.json.state.status, 'NO_VERIFIED_DATA');
});
