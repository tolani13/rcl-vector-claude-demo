// TEST FIXTURE — NOT MARKET DATA.
//
// Helpers for test/api: temp databases under data/test-api-*.db, a synthetic minute tape, and an HTTP client for a
// server started on an ephemeral 127.0.0.1 port. Every symbol (TFX*), price, size and date here is invented to exercise
// software behaviour; the trade date is in 2099 so it cannot be mistaken for a real observation. Product code never
// imports this file.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { openDb, closeDb } from '../../server/db.js';
import { etToUtc, MINUTE } from '../../server/util/time.js';
import { startServer } from '../../server/index.js';

export const FIXTURE_LABEL = 'TEST FIXTURE — NOT MARKET DATA';
export const FIX_DATE = '2099-01-06';
export const FIX_DS = 'test-fixture-api-2099-01-06';
export const SYM = 'TFXA';        // liquid synthetic penny symbol (TEST FIXTURE)
export const STALE = 'TFXS';      // synthetic symbol whose only quote is long before the open (TEST FIXTURE)
export { MINUTE };

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(here, '..', '..');

export const at = (hh, mm) => etToUtc(FIX_DATE, hh, mm);

/** Temp DB path + cleanup. */
export function tempDb(name) {
  const p = path.join(ROOT, 'data', `test-api-${name}-${process.pid}-${crypto.randomBytes(3).toString('hex')}.db`);
  const db = openDb(p);
  return {
    db, path: p,
    cleanup() {
      closeDb(p);
      for (const s of ['', '-wal', '-shm']) fs.rmSync(p + s, { force: true });
    },
  };
}

function row(db, sym, t, { px, bid, ask, bsz = 5000, asz = 5000, qts = t + 30_000, v = 1000, n = 5 }) {
  db.prepare(`INSERT OR REPLACE INTO m1 (ds, sym, t, o, h, l, c, v, n, pv, bv, sv, xv, ev, ov, bid, ask, bsz, asz, qts,
      min_bid, max_bid, min_ask, max_ask, max_spr, nq, unavail, halted, qsess)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0, 0, 0)`).run(
    FIX_DS, sym, t, px, px, px, px, v, n, px * v, Math.round(v * 0.4), Math.round(v * 0.4), v - 2 * Math.round(v * 0.4),
    bid, ask, bsz, asz, qts, bid, bid, ask, ask, ask - bid);
}

/** Seed the synthetic dataset (TEST FIXTURE): TFXA flat at 0.5000 with a 0.4990 x 0.5010 quote 09:00-11:00; TFXS one pre-open row. */
export function seedFixture(db) {
  db.prepare(`INSERT OR REPLACE INTO datasets (id, kind, provider, venue_coverage, entitlement, source_url, trade_date, ingested_at, status, quality_json, attribution, notes)
    VALUES (?, 'market_ticks', ?, ?, ?, NULL, ?, ?, 'complete', ?, ?, ?)`).run(
    FIX_DS, FIXTURE_LABEL, FIXTURE_LABEL, FIXTURE_LABEL, FIX_DATE, Date.now(), JSON.stringify({ label: FIXTURE_LABEL, rows_stored: 122 }), FIXTURE_LABEL,
    `${FIXTURE_LABEL}: synthetic minute rows for API tests only.`);
  for (let t = at(9, 0); t <= at(11, 0); t += MINUTE) row(db, SYM, t, { px: 5000, bid: 4990, ask: 5010 });
  row(db, STALE, at(9, 20), { px: 7000, bid: 6990, ask: 7010 });
  return FIX_DS;
}

/** Start a server on 127.0.0.1:0 against `db` with an isolated environment (no model provider, no keys unless given). */
export async function startTestServer(db, envExtra = {}, opts = {}) {
  const env = { VECTOR_PORT: '0', VECTOR_HOST: '127.0.0.1', VECTOR_MODEL_PROVIDER: 'none', VECTOR_MODEL_CONFIG: path.join(ROOT, 'data', 'test-api-no-model-config.json'), ...envExtra };
  const logs = [];
  const s = await startServer({ env, db, log: (m) => logs.push(m), ...opts });
  return { ...s, logs, client: client(s.url) };
}

/** Minimal HTTP client; mutations send the headers the web app sends unless overridden. */
export function client(base) {
  const call = async (method, p, body, headers = {}) => {
    const init = { method, headers: { accept: 'application/json', ...headers } };
    if (method !== 'GET' && method !== 'HEAD') {
      init.headers = { 'content-type': 'application/json', 'x-vector-client': 'web', ...init.headers, ...headers };
      init.body = typeof body === 'string' ? body : JSON.stringify(body ?? {});
    }
    const res = await fetch(base + p, init);
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON (static) */ }
    return { status: res.status, headers: res.headers, json, text };
  };
  return {
    get: (p, h) => call('GET', p, undefined, h),
    post: (p, b, h) => call('POST', p, b, h),
    put: (p, b, h) => call('PUT', p, b, h),
    raw: call,
  };
}
