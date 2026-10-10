// REAL_ACCOUNT storage and reads (docs/CONTRACTS.md section 4b). The owner's own brokerage data, read-only via
// SnapTrade, kept ONLY in the real_* tables. Nothing here touches portfolios, orders, the journal or the evidence store:
// real holdings never feed paper-account logic and never become market evidence.
import { tx } from '../db.js';
import { newId } from '../util/ids.js';
import {
  SnapTradeError, SOURCE, DATA_CLASS, REAL_LABEL, normalizeAccounts, normalizeBalances, normalizePositions, normalizeActivities,
} from './providers/snaptrade.js';

export { REAL_LABEL, SOURCE, DATA_CLASS };
const DAY_MS = 86_400_000;

function activityWindow(env, now) {
  const raw = Number(env?.VECTOR_SNAPTRADE_ACTIVITY_DAYS);
  const days = Number.isInteger(raw) && raw >= 1 && raw <= 3650 ? raw : 365;
  return { startDate: new Date(now - days * DAY_MS).toISOString().slice(0, 10), endDate: new Date(now).toISOString().slice(0, 10), days };
}

/**
 * Sync accounts, balances, positions and transactions from SnapTrade into the real_* tables (one snapshot per sync).
 * A failure records a FAILED run with its error code (never a secret) and stores no partial rows.
 * @returns {Promise<{sync_id:string, status:'OK'|'FAILED', error_code:string|null, error:string|null, fetched_at:number|null, counts:object}>}
 */
export async function syncRealAccounts(db, client, { env = process.env, now = Date.now } = {}) {
  const sync_id = newId('rsync');
  const started = now();
  const win = activityWindow(env, started);
  try {
    const accounts = normalizeAccounts(await client.listAccounts());
    const per = [];
    let truncated = false;
    for (const a of accounts) {
      const balances = normalizeBalances(await client.accountBalances(a.account_id));
      const positions = normalizePositions(await client.accountPositions(a.account_id));
      const act = await client.accountActivities(a.account_id, { startDate: win.startDate, endDate: win.endDate });
      truncated = truncated || act.truncated;
      per.push({ a, balances, positions, transactions: normalizeActivities(act.rows) });
    }
    const fetched_at = now();
    const counts = {
      accounts: per.length, balances: per.reduce((s, x) => s + x.balances.length, 0), positions: per.reduce((s, x) => s + x.positions.length, 0),
      transactions: per.reduce((s, x) => s + x.transactions.length, 0), activity_window_days: win.days, transactions_truncated: truncated,
    };
    tx(db, () => {
      db.prepare('INSERT INTO real_sync_runs (id, source, data_class, started_wall, fetched_at, status, error_code, counts_json) VALUES (?, ?, ?, ?, ?, ?, NULL, ?)')
        .run(sync_id, SOURCE, DATA_CLASS, started, fetched_at, 'OK', JSON.stringify(counts));
      const insA = db.prepare(`INSERT INTO real_accounts (sync_id, account_id, name, number_masked, institution, raw_type, status, total_value, currency, source, data_class, fetched_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      const insB = db.prepare('INSERT INTO real_balances (sync_id, account_id, currency, cash, buying_power, source, data_class, fetched_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
      const insP = db.prepare(`INSERT INTO real_positions (sync_id, account_id, symbol, description, kind, units, price, cost_basis, currency, cash_equivalent, source, data_class, fetched_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      const insT = db.prepare(`INSERT INTO real_transactions (sync_id, account_id, activity_id, type, trade_date, settlement_date, symbol, description, units, price, amount, fee, currency, source, data_class, fetched_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      for (const { a, balances, positions, transactions } of per) {
        insA.run(sync_id, a.account_id, a.name, a.number_masked, a.institution, a.raw_type, a.status, a.total_value, a.currency, SOURCE, DATA_CLASS, fetched_at);
        for (const b of balances) insB.run(sync_id, a.account_id, b.currency, b.cash, b.buying_power, SOURCE, DATA_CLASS, fetched_at);
        for (const p of positions) insP.run(sync_id, a.account_id, p.symbol, p.description, p.kind, p.units, p.price, p.cost_basis, p.currency, p.cash_equivalent, SOURCE, DATA_CLASS, fetched_at);
        for (const t of transactions) {
          insT.run(sync_id, a.account_id, t.activity_id, t.type, t.trade_date, t.settlement_date, t.symbol, t.description, t.units, t.price, t.amount, t.fee, t.currency, SOURCE, DATA_CLASS, fetched_at);
        }
      }
    });
    return { sync_id, status: 'OK', error_code: null, error: null, fetched_at, counts };
  } catch (e) {
    const error_code = typeof e?.code === 'string' && /^SNAPTRADE_[A-Z0-9_]+$/.test(e.code) ? e.code : 'SNAPTRADE_SYNC_FAILED';
    db.prepare('INSERT INTO real_sync_runs (id, source, data_class, started_wall, fetched_at, status, error_code, counts_json) VALUES (?, ?, ?, ?, NULL, ?, ?, NULL)')
      .run(sync_id, SOURCE, DATA_CLASS, started, 'FAILED', error_code);
    // The message comes from SnapTradeError (secret-free, URL-free); anything else is replaced by a generic text.
    const error = e instanceof SnapTradeError ? String(e.message).slice(0, 300) : 'sync failed (details withheld)';
    return { sync_id, status: 'FAILED', error_code, error, fetched_at: null, counts: null };
  }
}

/** The most recent sync run (any status) and the most recent successful one. */
export function lastSyncRuns(db) {
  const row = (r) => (r ? { id: r.id, status: r.status, error_code: r.error_code, started_wall: r.started_wall, fetched_at: r.fetched_at, counts: r.counts_json ? JSON.parse(r.counts_json) : null, source: r.source, data_class: r.data_class } : null);
  const last = db.prepare('SELECT * FROM real_sync_runs ORDER BY started_wall DESC, rowid DESC LIMIT 1').get();
  const ok = db.prepare("SELECT * FROM real_sync_runs WHERE status = 'OK' ORDER BY started_wall DESC, rowid DESC LIMIT 1").get();
  return { last: row(last), lastOk: row(ok) };
}

/** Accounts with balances and positions from the latest successful sync (null when there is none). */
export function latestSnapshot(db) {
  const { lastOk } = lastSyncRuns(db);
  if (!lastOk) return null;
  const sid = lastOk.id;
  const accounts = db.prepare('SELECT account_id, name, number_masked, institution, raw_type, status, total_value, currency, fetched_at FROM real_accounts WHERE sync_id = ? ORDER BY institution, name').all(sid);
  const bal = db.prepare('SELECT account_id, currency, cash, buying_power FROM real_balances WHERE sync_id = ?').all(sid);
  const pos = db.prepare('SELECT account_id, symbol, description, kind, units, price, cost_basis, currency, cash_equivalent FROM real_positions WHERE sync_id = ? ORDER BY symbol').all(sid);
  return {
    sync_id: sid, fetched_at: lastOk.fetched_at, source: SOURCE, data_class: DATA_CLASS, counts: lastOk.counts,
    accounts: accounts.map((a) => ({
      ...a,
      balances: bal.filter((b) => b.account_id === a.account_id).map(({ account_id: _x, ...b }) => b),
      positions: pos.filter((p) => p.account_id === a.account_id).map(({ account_id: _x, ...p }) => ({
        ...p, cash_equivalent: p.cash_equivalent === 1, market_value: Number.isFinite(p.units) && Number.isFinite(p.price) ? p.units * p.price : null,
      })),
    })),
  };
}

/** Transactions from the latest successful sync, newest first. */
export function latestTransactions(db, { accountId = null, limit = 100 } = {}) {
  const { lastOk } = lastSyncRuns(db);
  if (!lastOk) return null;
  const rows = accountId
    ? db.prepare('SELECT account_id, activity_id, type, trade_date, settlement_date, symbol, description, units, price, amount, fee, currency FROM real_transactions WHERE sync_id = ? AND account_id = ? ORDER BY trade_date DESC LIMIT ?').all(lastOk.id, accountId, limit)
    : db.prepare('SELECT account_id, activity_id, type, trade_date, settlement_date, symbol, description, units, price, amount, fee, currency FROM real_transactions WHERE sync_id = ? ORDER BY trade_date DESC LIMIT ?').all(lastOk.id, limit);
  return { sync_id: lastOk.id, fetched_at: lastOk.fetched_at, source: SOURCE, data_class: DATA_CLASS, rows };
}

/**
 * The owner's real holding in one symbol (latest successful sync), for an explicitly requested, privacy-gated
 * assessment context. Returns null when no sync exists.
 */
export function holdingForSymbol(db, sym) {
  const { lastOk } = lastSyncRuns(db);
  if (!lastOk) return null;
  const rows = db.prepare('SELECT account_id, units, price, cost_basis, currency FROM real_positions WHERE sync_id = ? AND upper(symbol) = upper(?)').all(lastOk.id, sym);
  const units = rows.reduce((s, r) => s + (Number.isFinite(r.units) ? r.units : 0), 0);
  const cost = rows.every((r) => Number.isFinite(r.cost_basis)) ? rows.reduce((s, r) => s + r.cost_basis, 0) : null;
  return { sym, fetched_at: lastOk.fetched_at, accounts: new Set(rows.map((r) => r.account_id)).size, units, cost_basis: cost, currencies: [...new Set(rows.map((r) => r.currency).filter(Boolean))] };
}
