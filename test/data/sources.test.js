// TEST FIXTURE — NOT MARKET DATA. listSources status derivation from invented dataset rows.
import test from 'node:test';
import assert from 'node:assert/strict';
import { listSources, recordDataset, fetchBytes, DATA_STATUS } from '../../server/data/sources.js';
import { sha256Hex } from '../../server/util/ids.js';
import { tempDb, stubServer, FIXTURE_LABEL } from './helpers.js';

const CONTRACT_STATUSES = new Set(Object.values(DATA_STATUS));

test('empty database: honest statuses for every source', () => {
  const { db, cleanup } = tempDb();
  try {
    const s = listSources(db, { env: {} });
    const by = Object.fromEntries(s.map((x) => [x.id, x]));
    assert.deepEqual(Object.keys(by).sort(), ['alpaca', 'csv-import', 'finra-regsho', 'fred', 'gdelt', 'iex-hist', 'nasdaq-symdir', 'polygon', 'sec-edgar']);
    for (const x of s) {
      assert.ok(CONTRACT_STATUSES.has(x.status), `${x.id}: ${x.status}`);
      for (const k of ['id', 'name', 'kind', 'status', 'provider', 'coverage', 'entitlement', 'attribution', 'last_event_ts', 'ingested_at', 'sha256', 'rows', 'setup', 'notes']) assert.ok(k in x, `${x.id} missing ${k}`);
      assert.ok(x.setup && x.setup.length > 10, `${x.id} has setup instructions`);
    }
    assert.equal(by['iex-hist'].status, 'NO_VERIFIED_DATA');
    assert.equal(by['sec-edgar'].status, 'BLOCKED');
    assert.match(by['sec-edgar'].notes, /SEC_USER_AGENT/);
    assert.equal(by.alpaca.status, 'NO_VERIFIED_DATA');
    assert.match(by.polygon.notes, /UNVERIFIED — never invoked against genuine data/);
    assert.equal(listSources(db, { env: { SEC_USER_AGENT: 'Fixture fixture@example.invalid' } }).find((x) => x.id === 'sec-edgar').status, 'NO_VERIFIED_DATA');
  } finally { cleanup(); }
});

test('statuses follow stored datasets: good, failed, imported', () => {
  const { db, cleanup } = tempDb();
  try {
    recordDataset(db, { id: 'fred-fixture', kind: 'macro', provider: FIXTURE_LABEL, status: 'complete', sha256: 'a'.repeat(64), event_time_end: 1000, quality: { rows_stored: 42 } });
    recordDataset(db, { id: 'gdelt-TFIXA-fixture', kind: 'media', provider: FIXTURE_LABEL, status: 'failed', notes: 'PROVIDER_FAULT: HTTP 429', quality: { rows_stored: 0 } });
    recordDataset(db, { id: 'import-TFIXA-fixture', kind: 'import', provider: FIXTURE_LABEL, status: 'IMPORTED_UNVERIFIED', quality: { rows_stored: 3 } });
    recordDataset(db, { id: 'finra-a', kind: 'short_volume', provider: FIXTURE_LABEL, status: 'complete', event_time_end: 5, quality: { rows_stored: 10 } });
    recordDataset(db, { id: 'finra-b', kind: 'short_volume', provider: FIXTURE_LABEL, status: 'failed', quality: { rows_stored: 0 } });
    const by = Object.fromEntries(listSources(db, { env: {} }).map((x) => [x.id, x]));
    assert.equal(by.fred.status, 'HISTORICAL_REAL');
    assert.equal(by.fred.rows, 42);
    assert.equal(by.fred.sha256, 'a'.repeat(64));
    assert.equal(by.fred.last_event_ts, 1000);
    assert.equal(by.gdelt.status, 'PROVIDER_FAULT');
    assert.match(by.gdelt.notes, /429/);
    assert.equal(by['csv-import'].status, 'IMPORTED_UNVERIFIED');
    assert.equal(by['finra-regsho'].status, 'HISTORICAL_REAL');
    assert.equal(by['finra-regsho'].rows, 10);
  } finally { cleanup(); }
});

test('market datasets report their provider publication time, or say it is unknown', () => {
  const { db, cleanup } = tempDb();
  try {
    recordDataset(db, { id: 'iex-fixture-a', kind: 'market_ticks', provider: FIXTURE_LABEL, status: 'complete', ingested_at: 2000, quality: { rows_retained: 5 } });
    let iex = listSources(db, { env: {} }).find((x) => x.id === 'iex-hist');
    assert.equal(iex.published_at, null);
    assert.match(iex.notes, /Provider publication time not recorded for iex-fixture-a/);
    recordDataset(db, { id: 'iex-fixture-b', kind: 'market_ticks', provider: FIXTURE_LABEL, status: 'complete', published_at: 1500, ingested_at: 3000, quality: { rows_retained: 5 } });
    iex = listSources(db, { env: {} }).find((x) => x.id === 'iex-hist');
    assert.equal(iex.published_at, 1500);
    assert.equal(iex.datasets.find((d) => d.id === 'iex-fixture-b').published_at, 1500);
  } finally { cleanup(); }
});

test('fetchBytes returns exact bytes + sha256 and never throws on failure', async () => {
  const srv = await stubServer({ '/ok': { body: 'hello' }, '/bad': { status: 503, body: 'x' } });
  try {
    const ok = await fetchBytes(`${srv.url}/ok`);
    assert.equal(ok.ok, true);
    assert.equal(ok.sha256, sha256Hex('hello'));
    const bad = await fetchBytes(`${srv.url}/bad`);
    assert.equal(bad.ok, false);
    assert.equal(bad.status, 503);
    const dead = await fetchBytes('http://127.0.0.1:1/never', { timeoutMs: 2000 });
    assert.equal(dead.ok, false);
    assert.equal(dead.status, 0);
  } finally { await srv.close(); }
});
