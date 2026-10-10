// Real accounts, READ-ONLY (docs/CONTRACTS.md sections 4b and 9). Every route here is GET or a read-only POST
// (portal link, sync); there is no order, trade or cancel route under /api/real/, and SnapTrade itself is reached only
// through the closed READ_ONLY_OPERATIONS list. Real-account data is private: these routes answer only to a loopback
// peer of a loopback-bound server with no proxy headers (never in VECTOR_ALLOW_REMOTE mode, never from a static build).
import { createSnapTradeClient, snaptradeConfig, READ_ONLY_OPERATIONS, REAL_LABEL, SOURCE, DATA_CLASS, SNAPTRADE_ENV } from '../data/providers/snaptrade.js';
import { syncRealAccounts, lastSyncRuns, latestSnapshot, latestTransactions } from '../data/real-accounts.js';
import { ApiError, conflict, onlyKeys, bool, query, intIn } from './http.js';

export const SYNC_COOLDOWN_MS = 60_000; // SnapTrade asks for >= 15 s between polls per account; a sync makes several

const isLoopbackPeer = (addr) => { const a = String(addr ?? ''); return a === '::1' || /^127\./.test(a) || /^::ffff:127\./i.test(a); };
const PROXY_HEADERS = ['x-forwarded-for', 'forwarded', 'x-real-ip', 'x-forwarded-host', 'cf-connecting-ip'];

/** Refuse unless this is the owner's own machine talking to a loopback-only server. */
export function requireLoopback(ctx, req) {
  const proxied = PROXY_HEADERS.some((h) => req?.headers?.[h] !== undefined);
  if (ctx.config?.allowRemote || !isLoopbackPeer(req?.socket?.remoteAddress) || proxied) {
    throw new ApiError(403, 'REAL_DATA_LOOPBACK_ONLY', `${REAL_LABEL}: real-account data is served only by the loopback server to this machine (not in VECTOR_ALLOW_REMOTE mode, not through a proxy, not in a static build).`);
  }
}

function client(ctx) {
  return createSnapTradeClient({ env: ctx.env, fetchImpl: ctx.snaptradeFetch ?? globalThis.fetch });
}

function statusBody(ctx) {
  const cfg = snaptradeConfig(ctx.env);
  const runs = lastSyncRuns(ctx.db);
  const blocked = !cfg.configured;
  return {
    label: REAL_LABEL, readOnly: true, source: SOURCE, data_class: DATA_CLASS,
    status: blocked ? 'BLOCKED' : 'READY',
    code: blocked ? 'SNAPTRADE_NOT_CONFIGURED' : null,
    uiText: blocked ? 'BLOCKED: SNAPTRADE_NOT_CONFIGURED' : null,
    detail: blocked
      ? (cfg.baseError ?? (cfg.userCredentialsIncomplete ? `set both ${SNAPTRADE_ENV.userId} and ${SNAPTRADE_ENV.userSecret}, or neither` : `missing ${cfg.missing.join(', ')} in the server environment`))
      : `SnapTrade ${cfg.mode === 'personal' ? 'Personal API key' : 'Personal key with user credentials'}; data access only`,
    mode: cfg.mode,
    variablesPresent: cfg.present,
    operations: READ_ONLY_OPERATIONS.map((o) => `${o.method} ${o.name}`),
    lastSync: runs.last, lastSuccessfulSync: runs.lastOk,
    note: 'Read-only. VECTOR places no orders on real accounts; real holdings never feed paper accounts or agents.',
  };
}

/** GET /api/real/status */
export function getRealStatus(ctx, req) {
  requireLoopback(ctx, req);
  return statusBody(ctx);
}

/** POST /api/real/connect {} — a short-lived SnapTrade Connection Portal link (connectionType read). */
export async function postRealConnect(ctx, req, { body }) {
  requireLoopback(ctx, req);
  onlyKeys(body, []);
  if (!snaptradeConfig(ctx.env).configured) throw conflict('SNAPTRADE_NOT_CONFIGURED', `BLOCKED: SNAPTRADE_NOT_CONFIGURED — ${statusBody(ctx).detail}`);
  try {
    const link = await client(ctx).connectionPortalLink();
    return { label: REAL_LABEL, ...link, note: 'Open the link and log in to your brokerage at SnapTrade (data access only). Then return and Sync. The link expires in 5 minutes.' };
  } catch (e) {
    throw new ApiError(502, e?.code ?? 'SNAPTRADE_FAILED', String(e?.message ?? 'SnapTrade request failed').slice(0, 300));
  }
}

/** POST /api/real/sync {confirm:true} — fetch accounts, balances, positions, transactions (SnapTrade cached data). */
export async function postRealSync(ctx, req, { body }) {
  requireLoopback(ctx, req);
  onlyKeys(body, ['confirm']);
  if (bool(body.confirm, 'confirm', { optional: true, dflt: false }) !== true) {
    throw conflict('CONFIRMATION_REQUIRED', 'A sync reads your real brokerage accounts through SnapTrade; resend with confirm:true.');
  }
  if (!snaptradeConfig(ctx.env).configured) throw conflict('SNAPTRADE_NOT_CONFIGURED', `BLOCKED: SNAPTRADE_NOT_CONFIGURED — ${statusBody(ctx).detail}`);
  if (ctx.busy.realSync) throw new ApiError(429, 'REAL_SYNC_BUSY', 'a real-account sync is already running');
  const wait = (ctx.lastRealSyncWall ?? 0) + SYNC_COOLDOWN_MS - Date.now();
  if (wait > 0) throw new ApiError(429, 'REAL_SYNC_COOLDOWN', `wait ${Math.ceil(wait / 1000)} s before syncing again`);
  ctx.busy.realSync = true;
  ctx.lastRealSyncWall = Date.now();
  try {
    const r = await syncRealAccounts(ctx.db, client(ctx), { env: ctx.env });
    if (r.status !== 'OK') throw new ApiError(502, r.error_code, r.error ?? 'sync failed');
    return { label: REAL_LABEL, status: 'OK', sync_id: r.sync_id, fetched_at: r.fetched_at, counts: r.counts, source: SOURCE, data_class: DATA_CLASS };
  } finally {
    ctx.busy.realSync = false;
  }
}

/** GET /api/real/accounts — the latest successful snapshot: accounts with balances and positions. */
export function getRealAccounts(ctx, req) {
  requireLoopback(ctx, req);
  const snap = latestSnapshot(ctx.db);
  const st = statusBody(ctx);
  return {
    label: REAL_LABEL, readOnly: true, status: snap ? 'SYNCED' : st.status === 'BLOCKED' ? 'BLOCKED' : 'NOT_SYNCED', code: st.code,
    source: SOURCE, data_class: DATA_CLASS, snapshot: snap,
    note: snap ? `As of SnapTrade's cached data fetched ${new Date(snap.fetched_at).toISOString()}. Not market data; never used by paper accounts.` : 'No successful sync yet.',
  };
}

/** GET /api/real/transactions?account=&limit= — transactions from the latest successful sync, newest first. */
export function getRealTransactions(ctx, req, { url }) {
  requireLoopback(ctx, req);
  const q = query(url, ['account', 'limit']);
  const limit = intIn(q.limit, 1, 1000, 'limit', { optional: true, dflt: 100 });
  const account = q.account === undefined ? null : String(q.account);
  if (account !== null && !/^[A-Za-z0-9-]{1,64}$/.test(account)) throw new ApiError(400, 'ACCOUNT_INVALID', 'account must be a SnapTrade account id');
  const t = latestTransactions(ctx.db, { accountId: account, limit });
  return { label: REAL_LABEL, readOnly: true, status: t ? 'SYNCED' : 'NOT_SYNCED', source: SOURCE, data_class: DATA_CLASS, ...(t ?? { rows: [] }) };
}
