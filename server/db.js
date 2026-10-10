// VECTOR persistent store (node:sqlite, built into Node >= 22.13).
//
// Units (see server/util/money.js):
//   prices and money are INTEGER "u" = 1e-4 USD (IEX native fixed-point). $1.22 => 12200.
//   timestamps are INTEGER milliseconds since Unix epoch, UTC. Display converts to America/New_York.
//
// Integrity:
//   journal and evidence are append-only (UPDATE/DELETE raise via triggers) and the journal is hash-chained.
//   Market tables are written only by ingestion scripts; the app reads them through server/data/marketdata.js,
//   which enforces as-of (no look-ahead) access.
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_DB_PATH = path.resolve(here, '..', 'data', 'vector.db');

export const SCHEMA_VERSION = 1;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);

-- Every ingested source batch. Provenance lives here and is referenced by ds id from data rows.
CREATE TABLE IF NOT EXISTS datasets (
  id TEXT PRIMARY KEY,                 -- e.g. 'iex-tops-2026-10-07'
  kind TEXT NOT NULL,                  -- market_ticks | macro | symbol_directory | short_volume | filings | import
  provider TEXT NOT NULL,              -- human-readable provider + product
  venue_coverage TEXT,                 -- what market(s)/venues are covered and what is NOT
  entitlement TEXT,                    -- licence / terms / attribution summary
  source_url TEXT,
  source_id TEXT,
  trade_date TEXT,                     -- YYYY-MM-DD (market data) or NULL
  event_time_start INTEGER,            -- ms UTC, earliest observation event time
  event_time_end INTEGER,              -- ms UTC, latest observation event time
  published_at INTEGER,                -- ms UTC when the provider made it available, if known
  ingested_at INTEGER NOT NULL,        -- ms UTC
  latency_note TEXT,                   -- e.g. 'historical file published after T+1'
  adjustments TEXT,                    -- e.g. 'raw unadjusted exchange prices'
  sha256 TEXT,                         -- of the bytes received from the provider
  bytes INTEGER,
  expected_bytes INTEGER,
  status TEXT NOT NULL,                -- complete | partial | failed
  quality_json TEXT,                   -- integrity / quality checks
  attribution TEXT,
  notes TEXT
);

-- One row per (dataset, symbol, minute) in which the symbol had any message. Quote state carries forward
-- across minutes without rows. All prices in u (1e-4 USD).
CREATE TABLE IF NOT EXISTS m1 (
  ds TEXT NOT NULL,
  sym TEXT NOT NULL,
  t INTEGER NOT NULL,                  -- minute start, ms UTC; the row becomes knowable at t + 60000
  o INTEGER, h INTEGER, l INTEGER, c INTEGER,   -- trade OHLC (NULL when no trades in minute)
  v INTEGER NOT NULL DEFAULT 0,        -- traded shares (IEX only)
  n INTEGER NOT NULL DEFAULT 0,        -- trade count
  pv REAL NOT NULL DEFAULT 0,          -- sum(price_u * size) for VWAP
  bv INTEGER NOT NULL DEFAULT 0,       -- inferred buyer-initiated volume (trade >= prevailing IEX ask)
  sv INTEGER NOT NULL DEFAULT 0,       -- inferred seller-initiated volume (trade <= prevailing IEX bid)
  xv INTEGER NOT NULL DEFAULT 0,       -- unclassified volume (inside spread / no two-sided quote)
  ev INTEGER NOT NULL DEFAULT 0,       -- extended-hours-flagged volume
  ov INTEGER NOT NULL DEFAULT 0,       -- odd-lot-flagged volume
  bid INTEGER, ask INTEGER, bsz INTEGER, asz INTEGER,  -- IEX top-of-book prevailing at minute end (0/NULL = side absent)
  qts INTEGER,                         -- ms UTC of the last quote update at/before minute end
  min_bid INTEGER, max_bid INTEGER, min_ask INTEGER, max_ask INTEGER,  -- extremes over two-sided states during minute (incl. carried-in state)
  max_spr INTEGER,                     -- widest two-sided spread during minute
  nq INTEGER NOT NULL DEFAULT 0,       -- quote updates in minute
  unavail INTEGER NOT NULL DEFAULT 0,  -- 1 if IEX flagged symbol unavailable (halted/paused) at any point in minute
  halted INTEGER NOT NULL DEFAULT 0,   -- 1 if trading status != Trading or operational halt at any point in minute
  qsess INTEGER NOT NULL DEFAULT 0,    -- 1 if quote market-session flag indicated pre/post-market at minute end
  PRIMARY KEY (ds, sym, t)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS m1_ds_t ON m1(ds, t);

-- Trading-status / halt / short-sale-test events, with exchange timestamps.
CREATE TABLE IF NOT EXISTS status_events (
  ds TEXT NOT NULL, sym TEXT NOT NULL, ts INTEGER NOT NULL, kind TEXT NOT NULL, code TEXT, reason TEXT
);
CREATE INDEX IF NOT EXISTS status_events_ds_sym_ts ON status_events(ds, sym, ts);

-- RETROSPECTIVE full-day ingestion statistics, used ONLY to decide what to store and for retrospective
-- research views. NEVER exposed to agents or as-of views (would leak future information).
CREATE TABLE IF NOT EXISTS ingest_symbol_stats (
  ds TEXT NOT NULL, sym TEXT NOT NULL,
  first_ts INTEGER, last_ts INTEGER, min_px INTEGER, max_px INTEGER, trades INTEGER, volume INTEGER, quotes INTEGER,
  stored_reason TEXT,
  PRIMARY KEY (ds, sym)
);

-- Reference symbol directory (Nasdaq Trader SymbolDirectory etc.).
CREATE TABLE IF NOT EXISTS ref_symbols (
  ds TEXT NOT NULL, sym TEXT NOT NULL, name TEXT, exchange TEXT, market_category TEXT,
  financial_status TEXT, test_issue INTEGER, etf INTEGER, round_lot INTEGER, file_creation_time TEXT,
  PRIMARY KEY (ds, sym)
);

-- Macro / economic series (e.g. FRED).
CREATE TABLE IF NOT EXISTS macro_series (
  series TEXT PRIMARY KEY, ds TEXT NOT NULL, title TEXT, units TEXT, frequency TEXT,
  publication_lag_days INTEGER NOT NULL DEFAULT 1, notes TEXT
);
CREATE TABLE IF NOT EXISTS macro_obs (
  series TEXT NOT NULL, date TEXT NOT NULL, value REAL, ds TEXT NOT NULL,
  PRIMARY KEY (series, date)
);

-- FINRA Reg SHO daily short-sale volume (FINRA-reported off-exchange trades; NOT consolidated volume).
CREATE TABLE IF NOT EXISTS short_volume (
  date TEXT NOT NULL, sym TEXT NOT NULL, short_vol REAL, short_exempt_vol REAL, total_vol REAL, markets TEXT, ds TEXT NOT NULL,
  PRIMARY KEY (date, sym)
);

-- SEC EDGAR filings (config-gated ingestion).
CREATE TABLE IF NOT EXISTS filings (
  accession TEXT PRIMARY KEY, cik TEXT NOT NULL, sym TEXT, form TEXT, filing_date TEXT,
  acceptance_ts INTEGER,               -- ms UTC of EDGAR acceptance = earliest public knowability
  primary_doc TEXT, url TEXT, ds TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS company_facts (
  cik TEXT NOT NULL, sym TEXT, concept TEXT NOT NULL, unit TEXT, value REAL, period_end TEXT,
  filed TEXT, form TEXT, accession TEXT NOT NULL, ds TEXT NOT NULL,
  PRIMARY KEY (cik, concept, period_end, accession)
);

-- Append-only evidence store. Model output never rewrites evidence.
CREATE TABLE IF NOT EXISTS evidence (
  id TEXT PRIMARY KEY,
  sym TEXT, kind TEXT NOT NULL, title TEXT NOT NULL, body_json TEXT NOT NULL,
  provider TEXT NOT NULL, ds TEXT, source_url TEXT, source_id TEXT,
  event_ts INTEGER,                    -- when the underlying event happened
  knowable_ts INTEGER NOT NULL,        -- earliest time it was publicly knowable (as-of gate uses this)
  ingested_ts INTEGER NOT NULL,        -- wall-clock ingestion time
  created_wall INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS evidence_sym_knowable ON evidence(sym, knowable_ts);
CREATE TRIGGER IF NOT EXISTS evidence_no_update BEFORE UPDATE ON evidence BEGIN SELECT RAISE(ABORT, 'evidence is append-only'); END;
CREATE TRIGGER IF NOT EXISTS evidence_no_delete BEFORE DELETE ON evidence BEGIN SELECT RAISE(ABORT, 'evidence is append-only'); END;

-- Replay session (single active session; id=1). Reset creates a new session_id; old journal rows remain.
CREATE TABLE IF NOT EXISTS replay_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  session_id TEXT NOT NULL,
  ds TEXT,                             -- market dataset being replayed (NULL = NO VERIFIED DATA)
  t_start INTEGER, t_end INTEGER,      -- replay window (ms UTC)
  clock INTEGER,                       -- current replay time; everything with knowable time <= clock is visible
  playing INTEGER NOT NULL DEFAULT 0,
  step_ms INTEGER NOT NULL DEFAULT 60000,
  tick_wall_ms INTEGER NOT NULL DEFAULT 1500,
  created_wall INTEGER NOT NULL, updated_wall INTEGER NOT NULL
);

-- Global controls (kill switch etc.). Key/value JSON.
CREATE TABLE IF NOT EXISTS controls (k TEXT PRIMARY KEY, v TEXT NOT NULL, updated_wall INTEGER NOT NULL);

-- Paper portfolios. Money in u. session_id scopes a portfolio to a replay session.
CREATE TABLE IF NOT EXISTS portfolios (
  id TEXT NOT NULL, session_id TEXT NOT NULL,
  name TEXT NOT NULL, lens TEXT, segment TEXT, kind TEXT NOT NULL,      -- kind: agent | sandbox
  starting_cash INTEGER NOT NULL, cash INTEGER NOT NULL,
  realized_pnl INTEGER NOT NULL DEFAULT 0, fees_paid INTEGER NOT NULL DEFAULT 0,
  day_start_equity INTEGER,            -- for daily loss cap
  created_wall INTEGER NOT NULL,
  PRIMARY KEY (id, session_id)
);

CREATE TABLE IF NOT EXISTS positions (
  session_id TEXT NOT NULL, portfolio_id TEXT NOT NULL, instrument_id TEXT NOT NULL,
  sym TEXT NOT NULL,                   -- underlying symbol
  kind TEXT NOT NULL,                  -- equity | option
  qty INTEGER NOT NULL,                -- shares, or contracts for options
  multiplier INTEGER NOT NULL DEFAULT 1,
  cost_basis INTEGER NOT NULL,         -- total u paid incl. fees for the open qty
  opened_ts INTEGER NOT NULL, updated_ts INTEGER NOT NULL,
  meta_json TEXT,
  PRIMARY KEY (session_id, portfolio_id, instrument_id)
);

CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL, portfolio_id TEXT NOT NULL,
  agent_id TEXT, intent_id TEXT, parent_id TEXT, oco_group TEXT,
  instrument_id TEXT NOT NULL, sym TEXT NOT NULL, kind TEXT NOT NULL,   -- equity | option
  side TEXT NOT NULL,                  -- buy | sell   (sell never exceeds held qty: no shorting)
  type TEXT NOT NULL,                  -- market | limit | stop | stop_limit
  role TEXT NOT NULL,                  -- entry | stop_loss | take_profit | time_exit | exit | manual
  qty INTEGER NOT NULL, filled_qty INTEGER NOT NULL DEFAULT 0,
  limit_px INTEGER, stop_px INTEGER,
  status TEXT NOT NULL,                -- pending_parent | working | triggered | partially_filled | filled | cancelled | expired | rejected | unfillable
  protective INTEGER NOT NULL DEFAULT 0,
  created_ts INTEGER NOT NULL,         -- replay clock when submitted
  updated_ts INTEGER NOT NULL,
  expires_ts INTEGER,
  triggered_ts INTEGER,
  reason TEXT,
  meta_json TEXT
);
CREATE INDEX IF NOT EXISTS orders_session_status ON orders(session_id, status);

CREATE TABLE IF NOT EXISTS fills (
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL, order_id TEXT NOT NULL, portfolio_id TEXT NOT NULL,
  instrument_id TEXT NOT NULL, sym TEXT NOT NULL, side TEXT NOT NULL,
  qty INTEGER NOT NULL, price INTEGER NOT NULL, fees INTEGER NOT NULL,
  ts INTEGER NOT NULL,                 -- replay clock (minute in which the estimated fill occurs)
  model TEXT NOT NULL,                 -- fill model id, e.g. 'iex-worst-in-minute-v1'
  assumptions_json TEXT NOT NULL,      -- explicit assumptions and the observed quote/trade data used
  estimated INTEGER NOT NULL DEFAULT 1 -- always 1: paper fills are estimates, never exchange executions
);

-- Agents (one per lens x segment portfolio). Authority lives in grants_json and is checked by the policy gate.
CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  portfolio_id TEXT NOT NULL, lens TEXT NOT NULL, segment TEXT NOT NULL,
  state TEXT NOT NULL,                 -- PAUSED | RUNNING | FAULTED | BLOCKED | STOPPED
  state_reason TEXT,
  strategy_json TEXT NOT NULL,
  grants_json TEXT NOT NULL,
  last_ok_json TEXT, last_fail_json TEXT,
  updated_wall INTEGER NOT NULL
);

-- Typed trade intents (proposals) and the deterministic policy decision on each.
CREATE TABLE IF NOT EXISTS intents (
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL, agent_id TEXT, portfolio_id TEXT NOT NULL,
  ts INTEGER NOT NULL, source TEXT NOT NULL,          -- rules | model | human
  intent_json TEXT NOT NULL,
  decision TEXT NOT NULL,              -- ACCEPTED | DENIED
  reasons_json TEXT NOT NULL,
  order_ids_json TEXT
);

-- LLM risk-lens assessments (only ever produced by a real configured ModelProvider; mocks live in tests).
CREATE TABLE IF NOT EXISTS assessments (
  id TEXT PRIMARY KEY, session_id TEXT, sym TEXT NOT NULL, lens TEXT NOT NULL,
  provider TEXT NOT NULL, model TEXT NOT NULL,
  as_of INTEGER NOT NULL,              -- evidence cut-off (replay clock)
  created_wall INTEGER NOT NULL,
  evidence_ids_json TEXT NOT NULL,
  packet_sha256 TEXT NOT NULL,         -- hash of the exact evidence packet sent
  status TEXT NOT NULL,                -- OK | INVALID_OUTPUT | REFUSED | ERROR
  output_json TEXT,
  error TEXT,
  latency_ms INTEGER, tokens_in INTEGER, tokens_out INTEGER
);

-- Local call log for model presets (config/model-presets.json limits: per-minute rate and daily cap). No content.
CREATE TABLE IF NOT EXISTS model_preset_calls (id INTEGER PRIMARY KEY AUTOINCREMENT, preset_id TEXT NOT NULL, wall INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS model_preset_calls_by ON model_preset_calls(preset_id, wall);

-- REAL_ACCOUNT data class (docs/CONTRACTS.md section 4b): the owner's own brokerage accounts, read-only via SnapTrade.
-- Private: stored only in these tables, served only to loopback peers, never market data (not HISTORICAL_REAL), never
-- an input to paper-account logic, never sent to a model provider whose preset does not declare trains_on_prompts false.
-- Amounts are the broker's decimals in the row's currency (not the u fixed-point used for paper money).
CREATE TABLE IF NOT EXISTS real_sync_runs (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL DEFAULT 'SNAPTRADE' CHECK (source = 'SNAPTRADE'),
  data_class TEXT NOT NULL DEFAULT 'REAL_ACCOUNT' CHECK (data_class = 'REAL_ACCOUNT'),
  started_wall INTEGER NOT NULL,
  fetched_at INTEGER,                  -- wall ms when the last response of the sync arrived (NULL on failure)
  status TEXT NOT NULL,                -- OK | PARTIAL | FAILED
  error_code TEXT,
  counts_json TEXT
);
CREATE TABLE IF NOT EXISTS real_accounts (
  sync_id TEXT NOT NULL, account_id TEXT NOT NULL, name TEXT, number_masked TEXT, institution TEXT, raw_type TEXT, status TEXT,
  total_value REAL, currency TEXT,
  source TEXT NOT NULL DEFAULT 'SNAPTRADE' CHECK (source = 'SNAPTRADE'),
  data_class TEXT NOT NULL DEFAULT 'REAL_ACCOUNT' CHECK (data_class = 'REAL_ACCOUNT'),
  fetched_at INTEGER NOT NULL,
  PRIMARY KEY (sync_id, account_id)
);
CREATE TABLE IF NOT EXISTS real_balances (
  sync_id TEXT NOT NULL, account_id TEXT NOT NULL, currency TEXT, cash REAL, buying_power REAL,
  source TEXT NOT NULL DEFAULT 'SNAPTRADE' CHECK (source = 'SNAPTRADE'),
  data_class TEXT NOT NULL DEFAULT 'REAL_ACCOUNT' CHECK (data_class = 'REAL_ACCOUNT'),
  fetched_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS real_positions (
  sync_id TEXT NOT NULL, account_id TEXT NOT NULL, symbol TEXT, description TEXT, kind TEXT,
  units REAL, price REAL, cost_basis REAL, currency TEXT, cash_equivalent INTEGER,
  source TEXT NOT NULL DEFAULT 'SNAPTRADE' CHECK (source = 'SNAPTRADE'),
  data_class TEXT NOT NULL DEFAULT 'REAL_ACCOUNT' CHECK (data_class = 'REAL_ACCOUNT'),
  fetched_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS real_transactions (
  sync_id TEXT NOT NULL, account_id TEXT NOT NULL, activity_id TEXT, type TEXT, trade_date TEXT, settlement_date TEXT,
  symbol TEXT, description TEXT, units REAL, price REAL, amount REAL, fee REAL, currency TEXT,
  source TEXT NOT NULL DEFAULT 'SNAPTRADE' CHECK (source = 'SNAPTRADE'),
  data_class TEXT NOT NULL DEFAULT 'REAL_ACCOUNT' CHECK (data_class = 'REAL_ACCOUNT'),
  fetched_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS real_positions_sync ON real_positions(sync_id, account_id);
CREATE INDEX IF NOT EXISTS real_transactions_sync ON real_transactions(sync_id, account_id);

-- Append-only, hash-chained audit journal for every attempted action, rejection, fill, control change.
CREATE TABLE IF NOT EXISTS journal (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT,
  ts_sim INTEGER,                      -- replay clock at the time of the action (NULL if none)
  ts_wall INTEGER NOT NULL,
  portfolio_id TEXT, agent_id TEXT,
  actor TEXT NOT NULL,                 -- agent | human | policy | engine | system | model
  type TEXT NOT NULL,                  -- e.g. INTENT_PROPOSED, POLICY_DENY, ORDER_SUBMITTED, FILL_ESTIMATED, STOP_TRIGGERED, KILL_SWITCH ...
  ref_id TEXT,
  payload_json TEXT NOT NULL,
  prev_hash TEXT NOT NULL,
  hash TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS journal_session ON journal(session_id, seq);
CREATE TRIGGER IF NOT EXISTS journal_no_update BEFORE UPDATE ON journal BEGIN SELECT RAISE(ABORT, 'journal is append-only'); END;
CREATE TRIGGER IF NOT EXISTS journal_no_delete BEFORE DELETE ON journal BEGIN SELECT RAISE(ABORT, 'journal is append-only'); END;
`;

const cache = new Map();

/** Open (and migrate) a database. Pass ':memory:' or a temp path in tests. */
export function openDb(dbPath = process.env.VECTOR_DB || DEFAULT_DB_PATH) {
  if (cache.has(dbPath)) return cache.get(dbPath);
  if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  db.exec(SCHEMA);
  // connections-v1: assessments made with REAL_ACCOUNT context are flagged (their model text is never stored; they are
  // counted against the call caps but never listed by paper views). Added in place for existing databases.
  if (!db.prepare('PRAGMA table_info(assessments)').all().some((c) => c.name === 'real_ctx')) {
    db.exec('ALTER TABLE assessments ADD COLUMN real_ctx INTEGER NOT NULL DEFAULT 0');
  }
  db.prepare('INSERT OR IGNORE INTO meta(k, v) VALUES (?, ?)').run('schema_version', String(SCHEMA_VERSION));
  cache.set(dbPath, db);
  return db;
}

export function closeDb(dbPath) {
  const db = cache.get(dbPath);
  if (db) { db.close(); cache.delete(dbPath); }
}

/** Run fn inside a transaction (BEGIN IMMEDIATE ... COMMIT / ROLLBACK). */
export function tx(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* already rolled back */ }
    throw e;
  }
}
