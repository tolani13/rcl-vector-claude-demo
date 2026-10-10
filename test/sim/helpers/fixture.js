// TEST FIXTURE — NOT MARKET DATA.
//
// Helpers for test/sim: temp databases, a fixture dataset row and hand-written m1 minute rows. Every number,
// symbol and date produced here is a synthetic test value used only to exercise the simulator's arithmetic and
// state machine. Symbols are prefixed FIX* and the trade date is in 2099 so they cannot be mistaken for real
// observations. Product code never imports this file.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { openDb, closeDb } from '../../../server/db.js';
import { etToUtc, MINUTE } from '../../../server/util/time.js';
import { verifyChain } from '../../../server/journal.js';
import { createSessionPortfolios } from '../../../server/sim/ledger.js';

export const FIXTURE_LABEL = 'TEST FIXTURE — NOT MARKET DATA';
export const FIXTURE_DATE = '2099-01-05';
export const FIXTURE_DS = 'test-fixture-sim-2099-01-05';
export { MINUTE };

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(here, '..', '..', '..');
export const SAMPLES_DIR = path.join(ROOT, 'receipts', 'journal-samples');

/** New temp DB under data/test-sim-*.db. Call cleanup() when done. */
export function openTestDb(name) {
  const p = path.join(ROOT, 'data', `test-sim-${name}-${process.pid}-${crypto.randomBytes(3).toString('hex')}.db`);
  const db = openDb(p);
  return {
    db, path: p,
    cleanup() {
      closeDb(p);
      for (const s of ['', '-wal', '-shm']) fs.rmSync(p + s, { force: true });
    },
  };
}

/** UTC ms for an ET wall-clock time on the fixture date. */
export function at(hh, mm) {
  return etToUtc(FIXTURE_DATE, hh, mm);
}

/** Insert the fixture dataset row (provider = TEST FIXTURE — NOT MARKET DATA). */
export function seedFixtureDataset(db, { id = FIXTURE_DS, tradeDate = FIXTURE_DATE } = {}) {
  db.prepare(`INSERT OR REPLACE INTO datasets (id, kind, provider, venue_coverage, entitlement, source_url, trade_date, ingested_at, status, quality_json, attribution, notes)
    VALUES (?, 'market_ticks', ?, ?, ?, NULL, ?, ?, 'complete', ?, ?, ?)`).run(
    id, FIXTURE_LABEL, FIXTURE_LABEL, FIXTURE_LABEL, tradeDate, Date.now(), JSON.stringify({ label: FIXTURE_LABEL }), FIXTURE_LABEL,
    `${FIXTURE_LABEL}: synthetic minute rows for simulator tests only.`);
  return id;
}

/**
 * Insert one synthetic m1 row. r = { bid, ask, bsz, asz, qts, minBid, maxBid, minAsk, maxAsk,
 *   trades:{o,h,l,c,v,n}|null, halted, unavail, noQuote }
 * min/max default to the end-of-minute quote; pass them explicitly to model intra-minute movement
 * (they must include the carried-in quote state, as the real ingestion does).
 */
export function addMinute(db, ds, sym, t, r = {}) {
  const tr = r.trades ?? null;
  const noQuote = r.noQuote === true;
  const bid = noQuote ? null : r.bid ?? null;
  const ask = noQuote ? null : r.ask ?? null;
  const two = bid > 0 && ask > 0;
  db.prepare(`INSERT OR REPLACE INTO m1 (ds, sym, t, o, h, l, c, v, n, pv, bv, sv, xv, ev, ov, bid, ask, bsz, asz, qts,
      min_bid, max_bid, min_ask, max_ask, max_spr, nq, unavail, halted, qsess)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, 0, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`).run(
    ds, sym, t,
    tr ? tr.o : null, tr ? tr.h : null, tr ? tr.l : null, tr ? tr.c : null, tr ? tr.v : 0, tr ? tr.n : 0, tr ? tr.c * tr.v : 0, tr ? tr.v : 0,
    bid, ask, noQuote ? null : r.bsz ?? 1000, noQuote ? null : r.asz ?? 1000, noQuote ? null : r.qts ?? t + 30_000,
    noQuote || !two ? r.minBid ?? null : r.minBid ?? bid, noQuote || !two ? r.maxBid ?? null : r.maxBid ?? bid,
    noQuote || !two ? r.minAsk ?? null : r.minAsk ?? ask, noQuote || !two ? r.maxAsk ?? null : r.maxAsk ?? ask,
    two ? ask - bid : null, noQuote ? 0 : 1, r.unavail ? 1 : 0, r.halted ? 1 : 0);
}

/** Temp DB + fixture dataset + the seven portfolios for one session. */
export function setupScenario(name, { startingCashU } = {}) {
  const t = openTestDb(name);
  seedFixtureDataset(t.db);
  const session_id = `test-sim-${name}`;
  createSessionPortfolios(t.db, session_id, { ...(startingCashU !== undefined ? { startingCashU } : {}), clock: at(9, 30) });
  const ctx = (clock, extra = {}) => ({ session_id, ds: FIXTURE_DS, clock, ...extra });
  return { ...t, session_id, ctx };
}

/** Journal rows for a session, oldest first, payload parsed. */
export function journalRows(db, session_id) {
  return db.prepare('SELECT * FROM journal WHERE session_id = ? ORDER BY seq').all(session_id)
    .map((r) => ({ ...r, payload: JSON.parse(r.payload_json), payload_json: undefined }));
}

export function journalTypes(db, session_id) {
  return journalRows(db, session_id).map((r) => r.type);
}

/** Insert an agent row (test only). `strategy` defaults to a label-only placeholder. */
export function addAgent(db, { id, portfolio_id, lens, segment, state = 'RUNNING', grants, strategy }) {
  db.prepare(`INSERT OR REPLACE INTO agents (id, portfolio_id, lens, segment, state, state_reason, strategy_json, grants_json, updated_wall)
    VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?)`).run(id, portfolio_id, lens, segment, state, JSON.stringify(strategy ?? { label: FIXTURE_LABEL }),
    JSON.stringify(grants ?? { portfolios: [portfolio_id], actions: ['open', 'close', 'modify', 'cancel'], instruments: ['equity'] }), Date.now());
}

/** Write the session's journal to receipts/journal-samples/fixture-sim-<name>.json ("label" is the first field). */
export function writeJournalSample(db, name, { session_id, description, extra = {} }) {
  const rows = journalRows(db, session_id).map(({ payload_json, ...r }) => r);
  const out = {
    label: FIXTURE_LABEL,
    scenario: name,
    description,
    generatedBy: 'node --test test/sim (fixture scenario; synthetic data, not market observations)',
    generatedAt: new Date().toISOString(),
    dataset: { id: FIXTURE_DS, provider: FIXTURE_LABEL, tradeDate: FIXTURE_DATE },
    chain: verifyChain(db),
    ...extra,
    rows,
  };
  fs.mkdirSync(SAMPLES_DIR, { recursive: true });
  const file = path.join(SAMPLES_DIR, `fixture-sim-${name}.json`);
  fs.writeFileSync(file, JSON.stringify(out, null, 2) + '\n');
  return file;
}
