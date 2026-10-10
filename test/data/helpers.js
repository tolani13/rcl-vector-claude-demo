// TEST FIXTURE — NOT MARKET DATA.
// Shared helpers for test/data: temporary databases, a local node:http stub server, and fixture-row writers.
// Every symbol, price and volume written by these helpers is invented for software testing only.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { openDb, closeDb } from '../../server/db.js';
import { etToUtc } from '../../server/util/time.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export const FIXTURE_LABEL = 'TEST FIXTURE — NOT MARKET DATA';

/** Open a fresh temp DB under data/test-data-*.db; returns {db, file, cleanup}. */
export function tempDb() {
  const file = path.join(root, 'data', `test-data-${process.pid}-${crypto.randomBytes(4).toString('hex')}.db`);
  const db = openDb(file);
  return {
    db, file,
    cleanup() {
      closeDb(file);
      for (const s of ['', '-wal', '-shm']) { try { fs.rmSync(file + s, { force: true }); } catch { /* ignore */ } }
    },
  };
}

/**
 * Local stub HTTP server. routes: { '/path': handler | {status, body, headers} } — path matched without query.
 * handler(req, res, url) may write anything. Records every request in `requests`.
 */
export async function stubServer(routes) {
  const requests = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    requests.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), headers: req.headers, at: Date.now() });
    const r = routes[url.pathname];
    if (typeof r === 'function') return r(req, res, url);
    if (!r) { res.writeHead(404, { 'content-type': 'text/plain' }); return res.end('not found'); }
    res.writeHead(r.status ?? 200, { 'content-type': r.contentType ?? 'text/plain', ...(r.headers || {}) });
    res.end(typeof r.body === 'string' || Buffer.isBuffer(r.body) ? r.body : JSON.stringify(r.body));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`, requests,
    close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); }),
  };
}

/** Fake clock for rate-limit tests: sleep() advances now() instantly and records the requested waits. */
export function fakeClock(start = 1_000_000) {
  let t = start;
  const sleeps = [];
  return { now: () => t, sleep: async (ms) => { sleeps.push(ms); t += ms; }, advance: (ms) => { t += ms; }, sleeps };
}

// ---- market fixtures (TEST FIXTURE — NOT MARKET DATA) ---------------------------------------------------------

export const FIXTURE_DATE = '2026-01-15';
export const FIXTURE_DS = 'fixture-ticks-2026-01-15';
export const et = (h, m) => etToUtc(FIXTURE_DATE, h, m);

export function insertMarketDataset(db, ds = FIXTURE_DS, date = FIXTURE_DATE) {
  db.prepare(`INSERT OR REPLACE INTO datasets (id, kind, provider, trade_date, ingested_at, status, notes)
    VALUES (?, 'market_ticks', ?, ?, ?, 'complete', ?)`).run(ds, `${FIXTURE_LABEL} (fixture provider)`, date, Date.now(), FIXTURE_LABEL);
}

/**
 * Insert one fixture minute row. price/bid/ask in u. Trade OHLC defaults to `price` for all four.
 * opts: {o,h,l,c,v,n,bv,sv,bid,ask,bsz,asz,noTrades,halted}
 */
export function insertMinute(db, sym, t, price, opts = {}, ds = FIXTURE_DS) {
  const noTrades = opts.noTrades === true;
  const o = noTrades ? null : opts.o ?? price;
  const c = noTrades ? null : opts.c ?? price;
  const h = noTrades ? null : opts.h ?? Math.max(o, c);
  const l = noTrades ? null : opts.l ?? Math.min(o, c);
  const v = noTrades ? 0 : opts.v ?? 1000;
  const n = noTrades ? 0 : opts.n ?? 3;
  const bid = opts.bid ?? (price - 10);
  const ask = opts.ask ?? (price + 10);
  db.prepare(`INSERT OR REPLACE INTO m1 (ds, sym, t, o, h, l, c, v, n, pv, bv, sv, xv, ev, ov, bid, ask, bsz, asz, qts, min_bid, max_bid, min_ask, max_ask, max_spr, nq, unavail, halted, qsess)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0, ?, 0)`).run(
    ds, sym, t, o, h, l, c, v, n, noTrades ? 0 : (c ?? 0) * v, opts.bv ?? 0, opts.sv ?? 0, Math.max(0, v - (opts.bv ?? 0) - (opts.sv ?? 0)),
    bid, ask, opts.bsz ?? 5000, opts.asz ?? 5000, t + 30_000,
    opts.minBid ?? bid, opts.maxBid ?? bid, opts.minAsk ?? ask, opts.maxAsk ?? ask, ask - bid, opts.halted ? 1 : 0);
}
