// TEST FIXTURE — NOT MARKET DATA.
//
// Helpers for test/agents: temp databases, a fixture dataset row and hand-written m1 minute rows. Every number, symbol
// and date produced here is a synthetic test value used only to exercise the agent runner, strategies, controls and
// replay engine. Symbols are prefixed FIX* and the trade date is in 2099 so they cannot be mistaken for real
// observations. Product code never imports this file.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { openDb, closeDb } from '../../../server/db.js';
import { etToUtc, MINUTE } from '../../../server/util/time.js';
import { verifyChain } from '../../../server/journal.js';
import { deriveStrategy } from '../../../server/agents/strategies.js';

export const FIXTURE_LABEL = 'TEST FIXTURE — NOT MARKET DATA';
export const FIXTURE_DATE = '2099-01-05';
export const FIXTURE_DS = 'test-fixture-agents-2099-01-05';
export { MINUTE };

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(here, '..', '..', '..');
export const SAMPLES_DIR = path.join(ROOT, 'receipts', 'journal-samples');

/** New temp DB under data/test-agents-*.db. Call cleanup() when done. */
export function openTestDb(name) {
  const p = path.join(ROOT, 'data', `test-agents-${name}-${process.pid}-${crypto.randomBytes(3).toString('hex')}.db`);
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
    `${FIXTURE_LABEL}: synthetic minute rows for agent tests only.`);
  return id;
}

let partialSeq = 0;

/**
 * Mark a fixture dataset PARTIAL (TEST FIXTURE): quality.coverage_end_ms = coverageEndMs (omit / null => coverage end
 * unknown). ingested_at gets a fresh value so marketdata's per-process coverage cache never reuses another test's entry.
 */
export function markPartial(db, coverageEndMs, { id = FIXTURE_DS } = {}) {
  const quality = { label: FIXTURE_LABEL, truncated: true, ...(Number.isFinite(coverageEndMs) ? { coverage_end_ms: coverageEndMs } : {}) };
  db.prepare("UPDATE datasets SET status = 'partial', quality_json = ?, ingested_at = ?, event_time_end = NULL WHERE id = ?")
    .run(JSON.stringify(quality), Date.now() + (++partialSeq), id);
  return id;
}

/**
 * Insert one synthetic m1 row (TEST FIXTURE). r = { px (trade price: o=h=l=c), trades:{o,h,l,c,v,n}, v, n, bv, sv,
 *   bid, ask, bsz, asz, qts, minBid, maxBid, minAsk, maxAsk, halted, unavail, noQuote }
 * Defaults: bid/ask = px -/+ 10 u, sizes 1000, qts = t + 30 s, min/max = end-of-minute quote.
 */
export function addMinute(db, sym, t, r = {}) {
  const px = r.px ?? null;
  const tr = r.trades ?? (px !== null ? { o: px, h: px, l: px, c: px, v: r.v ?? 1000, n: r.n ?? 5 } : null);
  const noQuote = r.noQuote === true;
  const bid = noQuote ? null : r.bid ?? (px !== null ? px - 10 : null);
  const ask = noQuote ? null : r.ask ?? (px !== null ? px + 10 : null);
  const two = bid > 0 && ask > 0;
  const v = tr ? tr.v : 0;
  const bv = r.bv ?? 0;
  const sv = r.sv ?? 0;
  db.prepare(`INSERT OR REPLACE INTO m1 (ds, sym, t, o, h, l, c, v, n, pv, bv, sv, xv, ev, ov, bid, ask, bsz, asz, qts,
      min_bid, max_bid, min_ask, max_ask, max_spr, nq, unavail, halted, qsess)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`).run(
    FIXTURE_DS, sym, t,
    tr ? tr.o : null, tr ? tr.h : null, tr ? tr.l : null, tr ? tr.c : null, v, tr ? tr.n : 0, tr ? tr.c * v : 0, bv, sv, Math.max(0, v - bv - sv),
    bid, ask, noQuote ? null : r.bsz ?? 1000, noQuote ? null : r.asz ?? 1000, noQuote ? null : r.qts ?? t + 30_000,
    two ? r.minBid ?? bid : null, two ? r.maxBid ?? bid : null, two ? r.minAsk ?? ask : null, two ? r.maxAsk ?? ask : null,
    two ? ask - bid : null, noQuote ? 0 : 1, r.unavail ? 1 : 0, r.halted ? 1 : 0);
}

/** Flat synthetic tape from..to (inclusive minute starts) at price px. extra(t) may override fields per minute. */
export function flat(db, sym, from, to, px, extra = () => ({})) {
  for (let t = from; t <= to; t += MINUTE) addMinute(db, sym, t, { px, ...extra(t) });
}

/**
 * The standard "jump" tape used by most scenarios (TEST FIXTURE): flat 0.5000 (5000 u) from 09:30 to 09:46, a jump to
 * 0.5800 in the 09:47 minute, then whatever `after` writes from 09:48 on (default: flat 5800 to 10:30).
 */
export function jumpTape(db, sym, { after = null, base = 5000, jump = 5800, ...rowOpts } = {}) {
  flat(db, sym, at(9, 30), at(9, 46), base, () => ({ bv: 300, sv: 300, ...rowOpts }));
  addMinute(db, sym, at(9, 47), { trades: { o: base, h: jump, l: base, c: jump, v: 5000, n: 20 }, bid: jump - 10, ask: jump + 10,
    minBid: base - 10, maxBid: jump - 10, minAsk: base + 10, maxAsk: jump + 10, bv: 3000, sv: 500, ...rowOpts });
  if (after) after(db, sym);
  else flat(db, sym, at(9, 48), at(10, 30), jump, () => rowOpts);
}

/**
 * Test strategy derived from the cowboy-micro preset with fixture-friendly thresholds (TEST FIXTURE values; the
 * preset itself is not changed): 5-minute window, +10% return trigger, market entry, $100 budget, 10% stop, +40% TP.
 */
export function testStrategy(overrides = {}) {
  const base = {
    signal: { windowMin: 5, minHistoryMin: 5, minClassifiedShares: 1000 },
    entry: { minRetPct: 10, minAccelPct: null, minRelVol: null, minBuyShare: null, requireBuyShare: false, minTradesW: 1, maxSpreadBps: 1000,
      maxQuoteAgeMs: 300_000, budgetUsd: 100, orderType: 'market', limitOffsetBps: 0 },
    exits: { stopLoss: { basis: 'pct_below_entry_ref', pct: 10 }, takeProfit: { basis: 'pct_gain', pct: 40 }, timeExit: null, breakevenAtGainPct: null },
    management: { cancelEntryAfterMin: 3, maxEntriesPerSymbol: 1, reentryCooldownMin: 30, maxCandidatesPerStep: 3 },
  };
  const merged = deriveStrategy('cowboy-micro', base);
  return deriveStrategy(merged, { id: 'test:cowboy-micro', ...overrides });
}

/** Temp DB with the fixture dataset; `tape(db)` writes the minute rows. */
export function setupDb(name, tape) {
  const t = openTestDb(name);
  seedFixtureDataset(t.db);
  if (tape) tape(t.db);
  return t;
}

/** Journal rows for a session, oldest first, payload parsed. */
export function journalRows(db, session_id) {
  return db.prepare('SELECT * FROM journal WHERE session_id = ? ORDER BY seq').all(session_id)
    .map((r) => ({ ...r, payload: JSON.parse(r.payload_json), payload_json: undefined }));
}

export function rowsOfType(db, session_id, type) {
  return journalRows(db, session_id).filter((r) => r.type === type);
}

export function ordersOf(db, session_id, extra = '') {
  return db.prepare(`SELECT * FROM orders WHERE session_id = ? ${extra} ORDER BY created_ts, role, id`).all(session_id);
}

/**
 * Normalized decision sequence: every agent/policy/order/fill journal row with ids, hashes and wall times removed.
 * Two runs over the same dataset with the same strategies must produce identical sequences.
 *
 * Agent, policy and submission rows are compared in EXACT order. Rows the orders engine writes while processing one
 * minute (actor 'engine', same ts_sim, consecutive) are compared as a canonical set: server/sim/orders.js breaks ties
 * between orders created at the same clock by their random id, so their bookkeeping rows may permute between runs
 * (each portfolio's outcome is unaffected). Reported to the orders.js owner (tie-break by rowid would fix it).
 */
export function decisionSequence(db, session_id) {
  const rows = rawDecisionSequence(db, session_id);
  const out = [];
  for (let i = 0; i < rows.length;) {
    if (rows[i].actor !== 'engine') { out.push(rows[i]); i++; continue; }
    let j = i;
    while (j < rows.length && rows[j].actor === 'engine' && rows[j].ts_sim === rows[i].ts_sim) j++;
    out.push(...rows.slice(i, j).map((r) => [JSON.stringify(r), r]).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).map((x) => x[1]));
    i = j;
  }
  return out;
}

function rawDecisionSequence(db, session_id) {
  const KEEP = new Set(['AGENT_SCAN', 'INTENT_PROPOSED', 'POLICY_ACCEPT', 'POLICY_DENY', 'ORDER_SUBMITTED', 'ORDER_REJECTED', 'ORDER_CANCELLED',
    'ORDER_REPLACED', 'FILL_ESTIMATED', 'FILL_WITHHELD', 'STOP_TRIGGERED', 'BRACKET_CHILD_ACTIVATED', 'ORDER_EXPIRED', 'AGENT_FAULT', 'AGENT_BLOCKED',
    'MODEL_CONFIRMATION', 'MARK_TO_MARKET']);
  return journalRows(db, session_id).filter((r) => KEEP.has(r.type)).map((r) => {
    const p = r.payload;
    const base = { type: r.type, ts_sim: r.ts_sim, agent_id: r.agent_id, portfolio_id: r.portfolio_id, actor: r.actor };
    switch (r.type) {
      case 'AGENT_SCAN': return { ...base, scanned: p.scanned, planned: p.planned, skipped: p.skipped, top: p.topCandidates };
      case 'INTENT_PROPOSED': { const { id, ...intent } = p.intent; return { ...base, kind: p.kind, intent }; }
      case 'POLICY_ACCEPT': case 'POLICY_DENY': return { ...base, decision: p.decision, reasons: p.reasons.map((x) => x.code), estimate: p.estimate };
      case 'FILL_ESTIMATED': return { ...base, sym: p.sym, side: p.side, role: p.role, qty: p.qty, priceU: p.priceU, feesU: p.feesU, worseThanStop: p.worseThanStop ?? null };
      case 'MARK_TO_MARKET': return { ...base, portfolios: p.portfolios };
      default: return { ...base, sym: p.sym ?? null, side: p.side ?? null, role: p.role ?? null, type2: p.type ?? null, qty: p.qty ?? null, status: p.status ?? null,
        limit_px: p.limit_px ?? null, stop_px: p.stop_px ?? null, reason: p.reason ?? null };
    }
  });
}

/** Write the session's journal to receipts/journal-samples/fixture-agents-<name>.json ("label" is the first field). */
export function writeJournalSample(db, name, { session_id, description, covers, extra = {} }) {
  const rows = journalRows(db, session_id).map(({ payload_json, ...r }) => r);
  const out = {
    label: FIXTURE_LABEL,
    scenario: name,
    covers,
    description,
    generatedBy: 'node --test test/agents (fixture scenario; synthetic data, not market observations)',
    generatedAt: new Date().toISOString(),
    dataset: { id: FIXTURE_DS, provider: FIXTURE_LABEL, tradeDate: FIXTURE_DATE },
    chain: verifyChain(db),
    ...extra,
    rows,
  };
  fs.mkdirSync(SAMPLES_DIR, { recursive: true });
  const file = path.join(SAMPLES_DIR, `fixture-agents-${name}.json`);
  fs.writeFileSync(file, JSON.stringify(out, null, 2) + '\n');
  return file;
}
