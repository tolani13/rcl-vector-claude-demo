// TEST FIXTURE — NOT MARKET DATA.
// Shared helpers for test/intel: temp databases, a fictional market fixture and a MOCK model provider.
// Everything here exists only to exercise software behaviour. The symbol, prices, volumes, series and directory
// entries below are invented for tests, are labelled as such, and must never be used by product code
// (server/ never imports from test/).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { openDb, closeDb } from '../../server/db.js';
import { etToUtc, MINUTE } from '../../server/util/time.js';

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(here, '..', '..');

export const FIXTURE_LABEL = 'TEST FIXTURE — NOT MARKET DATA';
export const FIX_DS = 'test-fixture-intel-ds';
export const FIX_SYM = 'QQFIX';                    // fictional symbol (TEST FIXTURE)
export const FIX_DATE = '2026-01-05';
export const FIX_OPEN = etToUtc(FIX_DATE, 9, 30);
export const FIX_ASOF = etToUtc(FIX_DATE, 10, 30);
export const FIX_SYMDIR_PUBLISHED = etToUtc('2026-01-04', 21, 30); // fixture directory File Creation Time (TEST FIXTURE)
// TEST MOCK training cutoff: the fixture trade date (2026-01-05) is more than the 90-day margin after it.
export const MOCK_TRAINING_CUTOFF = '2025-06-30';

/** Fresh temp DB under data/test-intel-*.db; call cleanup() when done. */
export function tempDb() {
  const p = path.join(ROOT, 'data', `test-intel-${process.pid}-${crypto.randomBytes(4).toString('hex')}.db`);
  const db = openDb(p);
  return {
    db, path: p,
    cleanup() {
      closeDb(p);
      for (const suffix of ['', '-wal', '-shm']) { try { fs.rmSync(p + suffix, { force: true }); } catch { /* ignore */ } }
    },
  };
}

/**
 * Seed a fictional market day (TEST FIXTURE — NOT MARKET DATA). Prices in u (1e-4 USD).
 * Minutes 09:30..10:29 trend gently upward; minutes 10:30..10:31 contain a huge FUTURE spike and a FUTURE halt that
 * must never be visible at FIX_ASOF (10:30 ET).
 * opts.symdirPublished: File Creation Time of the fixture symbol directory (default: the evening before the trade date).
 */
export function seedFixture(db, { symdirPublished = FIX_SYMDIR_PUBLISHED } = {}) {
  const now = Date.now();
  db.prepare(`INSERT INTO datasets (id, kind, provider, venue_coverage, entitlement, source_url, trade_date, ingested_at, status, notes)
    VALUES (?, 'market_ticks', ?, ?, ?, NULL, ?, ?, 'complete', ?)`)
    .run(FIX_DS, `${FIXTURE_LABEL} (fake provider)`, `${FIXTURE_LABEL}: single fake venue`, FIXTURE_LABEL, FIX_DATE, now, FIXTURE_LABEL);
  const ins = db.prepare(`INSERT INTO m1 (ds, sym, t, o, h, l, c, v, n, pv, bv, sv, xv, bid, ask, bsz, asz, qts, min_bid, max_bid, min_ask, max_ask, max_spr, nq, halted, unavail)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  // One pre-market minute at 09:25.
  const pre = etToUtc(FIX_DATE, 9, 25);
  ins.run(FIX_DS, FIX_SYM, pre, 4000, 4000, 4000, 4000, 500, 2, 4000 * 500, 0, 0, 500, 3990, 4010, 1000, 1000, pre + 30_000, 3990, 3990, 4010, 4010, 20, 3, 0, 0);
  // Regular session 09:30..10:29: price 0.4000 + 10u per minute, volume 1000/min (2000/min after 10:15).
  for (let i = 0; i < 60; i++) {
    const t = FIX_OPEN + i * MINUTE;
    const c = 4000 + 10 * i;
    const v = i >= 45 ? 2000 : 1000;
    ins.run(FIX_DS, FIX_SYM, t, c - 5, c + 5, c - 10, c, v, 10, c * v, Math.round(v * 0.6), Math.round(v * 0.2), Math.round(v * 0.2),
      c - 10, c + 10, 1500, 1200, t + 50_000, c - 15, c - 10, c + 10, c + 15, 30, 4, 0, 0);
  }
  // FUTURE relative to FIX_ASOF: a 10x spike at 10:30 and a halt at 10:31.
  for (let i = 60; i < 62; i++) {
    const t = FIX_OPEN + i * MINUTE;
    ins.run(FIX_DS, FIX_SYM, t, 45000, 50000, 45000, 50000, 99999, 500, 50000 * 99999, 99999, 0, 0,
      49990, 50010, 10, 10, t + 10_000, 49990, 49990, 50010, 50010, 20, 9, i === 61 ? 1 : 0, 0);
  }
  db.prepare(`INSERT INTO status_events (ds, sym, ts, kind, code, reason) VALUES (?, ?, ?, 'trading_status', ?, ?)`)
    .run(FIX_DS, FIX_SYM, etToUtc(FIX_DATE, 7, 0), 'T', '');
  db.prepare(`INSERT INTO status_events (ds, sym, ts, kind, code, reason) VALUES (?, ?, ?, 'trading_status', ?, ?)`)
    .run(FIX_DS, FIX_SYM, etToUtc(FIX_DATE, 10, 30, 30), 'H', 'FUTURE TEST HALT');

  // Reference directory (financial_status is temporal and must be excluded from packets). Published (File Creation
  // Time) the evening BEFORE the fixture trade date, so it is a legitimate as-of source at FIX_ASOF.
  db.prepare(`INSERT INTO datasets (id, kind, provider, published_at, ingested_at, status, notes) VALUES ('test-fixture-symdir', 'symbol_directory', ?, ?, ?, 'complete', ?)`)
    .run(`${FIXTURE_LABEL} (fake directory)`, symdirPublished, now, FIXTURE_LABEL);
  db.prepare(`INSERT INTO ref_symbols (ds, sym, name, exchange, market_category, financial_status, test_issue, etf, round_lot)
    VALUES ('test-fixture-symdir', ?, 'Fixture Corp (TEST FIXTURE)', 'TESTX', 'S', 'D', 0, 0, 100)`).run(FIX_SYM);

  // FINRA-style short volume: one row before the trade date (allowed) and one ON it (must be excluded).
  db.prepare(`INSERT INTO datasets (id, kind, provider, ingested_at, status, notes) VALUES ('test-fixture-shortvol', 'short_volume', ?, ?, 'complete', ?)`)
    .run(`${FIXTURE_LABEL} (fake short volume)`, now, FIXTURE_LABEL);
  const sv = db.prepare(`INSERT INTO short_volume (date, sym, short_vol, short_exempt_vol, total_vol, markets, ds) VALUES (?, ?, ?, ?, ?, 'TEST', 'test-fixture-shortvol')`);
  sv.run('2026-01-02', FIX_SYM, 100, 0, 400);
  sv.run(FIX_DATE, FIX_SYM, 777, 0, 999);

  // Macro: one observation knowable before as-of, one knowable after (date + 1 lag day).
  db.prepare(`INSERT INTO datasets (id, kind, provider, ingested_at, status, notes) VALUES ('test-fixture-macro', 'macro', ?, ?, 'complete', ?)`)
    .run(`${FIXTURE_LABEL} (fake macro)`, now, FIXTURE_LABEL);
  db.prepare(`INSERT INTO macro_series (series, ds, title, units, frequency, publication_lag_days) VALUES ('TESTSERIES', 'test-fixture-macro', 'Test series (TEST FIXTURE)', 'index', 'daily', 1)`).run();
  db.prepare(`INSERT INTO macro_obs (series, date, value, ds) VALUES ('TESTSERIES', '2026-01-02', 1.5, 'test-fixture-macro')`).run();
  db.prepare(`INSERT INTO macro_obs (series, date, value, ds) VALUES ('TESTSERIES', '2026-01-05', 9.9, 'test-fixture-macro')`).run();
}

/**
 * A second fictional symbol with a few regular-session minutes but NO symbol-directory row (TEST FIXTURE — NOT MARKET
 * DATA). Used to check that a missing directory row does not change what a post-dated-directory packet says.
 */
export const FIX_SYM_NODIR = 'QQABS';
export function seedNoDirSymbol(db) {
  const ins = db.prepare(`INSERT INTO m1 (ds, sym, t, o, h, l, c, v, n, pv, bv, sv, xv, bid, ask, bsz, asz, qts, min_bid, max_bid, min_ask, max_ask, max_spr, nq, halted, unavail)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  for (let i = 0; i < 40; i++) {
    const t = FIX_OPEN + i * MINUTE;
    ins.run(FIX_DS, FIX_SYM_NODIR, t, 2000, 2005, 1995, 2000, 300, 3, 2000 * 300, 100, 100, 100, 1990, 2010, 500, 500, t + 30_000, 1990, 1990, 2010, 2010, 20, 2, 0, 0);
  }
}

/**
 * MOCK model provider (TEST FIXTURE / MOCK — never used by product code).
 * respond(req, callNo) returns a ModelProvider complete() result. Its config declares a TEST training cutoff so the
 * hindsight guard lets fixture replays run; pass config to override.
 */
export function makeMockProvider(respond, { model = 'mock-model (TEST MOCK)', config = { trainingCutoff: MOCK_TRAINING_CUTOFF, trainingCutoffSource: 'TEST MOCK' } } = {}) {
  const calls = [];
  return {
    id: 'mock-test', kind: 'mock', model, endpointLabel: 'in-process TEST MOCK', calls, config,
    async status() { return { status: 'CONNECTED', detail: 'TEST MOCK' }; },
    async complete(req) {
      calls.push(JSON.parse(JSON.stringify(req)));
      return respond(req, calls.length);
    },
  };
}

/** The lens id named in a system prompt. */
export function lensOf(system) {
  const m = /lens id "([a-z]+)"/.exec(system);
  return m ? m[1] : null;
}

/** A schema-valid lens output (TEST FIXTURE). */
export function lensOutput(lens, evidenceIds, overrides = {}) {
  return {
    lens,
    stance: 'watch',
    thesis: `TEST MOCK thesis for ${lens} [${evidenceIds[0]}]`,
    counter_thesis: 'TEST MOCK counter-thesis',
    exposure: 'TEST MOCK exposure',
    liquidity_and_spread: 'TEST MOCK liquidity',
    unknowns: ['TEST MOCK unknown'],
    evidence_refs: [evidenceIds[0]],
    confidence: { level: 'low', calibration_note: 'TEST MOCK calibration' },
    proposed_intent: null,
    ...overrides,
  };
}

export function okResult(json) {
  return { ok: true, json, rawText: JSON.stringify(json), refusal: null, usage: { in: 100, out: 50 }, latencyMs: 5, error: null, errorKind: null };
}
