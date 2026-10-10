// SnapTrade, READ-ONLY (docs/CONTRACTS.md section 4b). The owner's own brokerage accounts through SnapTrade Personal
// (free, personal use). Data class REAL_ACCOUNT, source SNAPTRADE: never market data, never paper-account input.
//
// What this module can send is the closed list READ_ONLY_OPERATIONS below: one Connection Portal link (connectionType
// is fixed to 'read', data access only) and four GET reads (accounts, balances, positions, activities). Any other
// method or path is refused before a request is built. No connection refresh call is wired either: SnapTrade says
// manual refreshes may be billed, and the owner's budget is $0, so a sync reads SnapTrade's cached daily data.
//
// Authentication (SnapTrade docs: Personal vs Commercial, Authentication Methods, Request Signatures):
//   * Personal API keys: query clientId + timestamp, header Signature; userId/userSecret are omitted and no user is
//     registered (SnapTrade: "Do not call Register user" for Personal keys).
//   * Optional VECTOR_SNAPTRADE_USER_ID + VECTOR_SNAPTRADE_USER_SECRET are added to user-scoped calls only when BOTH are
//     set (for an account whose dashboard issued them). This module never registers users.
//   * Signature = base64(HMAC-SHA256(consumerKey, canonical JSON {content, path, query})), keys sorted at every level,
//     no whitespace; content is the JSON body or null; path includes the /api/v1 prefix; query is the raw query string.
// Secrets (client id, consumer key, user secret) come from the server environment only. They are never logged, never
// returned, and never placed in an error message: errors name the operation, never the URL (whose query holds them).
import crypto from 'node:crypto';

export const SNAPTRADE_DEFAULT_BASE_URL = 'https://api.snaptrade.com/api/v1';
export const SOURCE = 'SNAPTRADE';
export const DATA_CLASS = 'REAL_ACCOUNT';
export const REAL_LABEL = 'REAL ACCOUNT — READ ONLY';
export const SNAPTRADE_ENV = Object.freeze({
  clientId: 'VECTOR_SNAPTRADE_CLIENT_ID',
  consumerKey: 'VECTOR_SNAPTRADE_CONSUMER_KEY',
  userId: 'VECTOR_SNAPTRADE_USER_ID',
  userSecret: 'VECTOR_SNAPTRADE_USER_SECRET',
});
/** Environment variables whose values are secrets (presence is reported, values never). */
export const SNAPTRADE_SECRET_ENV_VARS = Object.freeze([SNAPTRADE_ENV.clientId, SNAPTRADE_ENV.consumerKey, SNAPTRADE_ENV.userId, SNAPTRADE_ENV.userSecret]);

/** A secret and the encoded forms it can take in a URL (percent-encoding, form encoding). */
export function secretForms(s) {
  if (typeof s !== 'string' || !s) return [];
  const forms = new Set([s, s.trim(), encodeURIComponent(s.trim()), new URLSearchParams({ x: s.trim() }).toString().slice(2)]);
  return [...forms].filter((f) => f.length >= 4);
}
export const PORTAL_LINK_TTL_SECONDS = 300; // SnapTrade: the returned Connection Portal URL expires in 5 minutes
const DEFAULT_TIMEOUT_MS = 20_000;
const ACTIVITY_PAGE_LIMIT = 1000;           // SnapTrade maximum per request
const MAX_ACTIVITY_PAGES = 3;               // per account per sync (Personal: 10 requests/min per account)
const ACCOUNT_ID = '[A-Za-z0-9-]{1,64}';

/** The complete set of SnapTrade operations VECTOR can send. Read-only by construction. */
export const READ_ONLY_OPERATIONS = Object.freeze([
  Object.freeze({ name: 'connectionPortalLink', method: 'POST', path: /^\/snapTrade\/login$/, userScoped: true }),
  Object.freeze({ name: 'listAccounts', method: 'GET', path: /^\/accounts$/, userScoped: true }),
  Object.freeze({ name: 'accountBalances', method: 'GET', path: new RegExp(`^/accounts/${ACCOUNT_ID}/balances$`), userScoped: true }),
  Object.freeze({ name: 'accountPositions', method: 'GET', path: new RegExp(`^/accounts/${ACCOUNT_ID}/positions(/all)?$`), userScoped: true }),
  Object.freeze({ name: 'accountActivities', method: 'GET', path: new RegExp(`^/accounts/${ACCOUNT_ID}/activities$`), userScoped: true }),
]);

export class SnapTradeError extends Error {
  constructor(code, message, { httpStatus = null, op = null } = {}) {
    super(message);
    this.name = 'SnapTradeError';
    this.code = code;
    this.httpStatus = httpStatus;
    this.op = op;
  }
}

/** Canonical JSON: object keys sorted at every level, no whitespace (SnapTrade request signatures). */
export function canonicalJson(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return `[${v.map((x) => canonicalJson(x === undefined ? null : x)).join(',')}]`;
  const keys = Object.keys(v).filter((k) => v[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(v[k])}`).join(',')}}`;
}

/**
 * SnapTrade request signature.
 * @param {{consumerKey:string, path:string, query:string, content:object|null}} o  path includes the /api/v1 prefix
 */
export function signRequest({ consumerKey, path, query, content }) {
  const body = content && typeof content === 'object' && Object.keys(content).length ? content : null;
  const payload = canonicalJson({ content: body, path, query });
  return crypto.createHmac('sha256', consumerKey).update(payload, 'utf8').digest('base64');
}

/** Which SnapTrade variables are set (presence only) and whether the module can run. */
export function snaptradeConfig(env = process.env) {
  const has = (k) => typeof env[k] === 'string' && env[k].trim() !== '';
  const present = Object.fromEntries(Object.values(SNAPTRADE_ENV).map((k) => [k, has(k)]));
  const missing = [SNAPTRADE_ENV.clientId, SNAPTRADE_ENV.consumerKey].filter((k) => !present[k]);
  const userPair = present[SNAPTRADE_ENV.userId] && present[SNAPTRADE_ENV.userSecret];
  const halfPair = present[SNAPTRADE_ENV.userId] !== present[SNAPTRADE_ENV.userSecret];
  let baseUrl = SNAPTRADE_DEFAULT_BASE_URL;
  let baseError = null;
  if (has('VECTOR_SNAPTRADE_BASE_URL')) {
    try {
      const u = new URL(env.VECTOR_SNAPTRADE_BASE_URL.trim());
      const loop = ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname);
      if (u.username || u.password || u.search || u.hash) baseError = 'VECTOR_SNAPTRADE_BASE_URL must not contain credentials, a query or a fragment';
      else if (u.protocol !== 'https:' && !(u.protocol === 'http:' && loop)) baseError = 'VECTOR_SNAPTRADE_BASE_URL must be https (http only for a loopback test server)';
      else baseUrl = u.toString().replace(/\/+$/, '');
    } catch { baseError = 'VECTOR_SNAPTRADE_BASE_URL is not a valid URL'; }
  }
  return {
    configured: missing.length === 0 && !baseError && !halfPair,
    missing, present, baseUrl, baseError,
    mode: userPair ? 'personal-with-user-credentials' : 'personal',
    userCredentialsIncomplete: halfPair,
  };
}

function scrub(text, secrets) {
  let t = String(text ?? '');
  for (const s of secrets) for (const f of secretForms(s)) t = t.split(f).join('[REDACTED]');
  return t;
}

/**
 * Create a read-only SnapTrade client. Never logs. Throws SnapTradeError (code SNAPTRADE_NOT_CONFIGURED when keys are
 * missing) from its operations; the error text never contains a secret or a URL.
 * @param {{env?:object, fetchImpl?:typeof fetch, now?:()=>number, timeoutMs?:number}} o
 */
export function createSnapTradeClient({ env = process.env, fetchImpl = globalThis.fetch, now = Date.now, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const cfg = snaptradeConfig(env);
  const secrets = SNAPTRADE_SECRET_ENV_VARS.map((k) => env[k]).filter(Boolean);
  const basePath = (() => { try { return new URL(cfg.baseUrl).pathname.replace(/\/+$/, ''); } catch { return ''; } })();

  async function call(opName, { method, path, query = {}, body = null }) {
    if (!cfg.configured) {
      const why = cfg.baseError ?? (cfg.userCredentialsIncomplete
        ? `set both ${SNAPTRADE_ENV.userId} and ${SNAPTRADE_ENV.userSecret}, or neither (Personal keys need neither)`
        : `missing ${cfg.missing.join(', ')}`);
      throw new SnapTradeError('SNAPTRADE_NOT_CONFIGURED', `BLOCKED: SNAPTRADE_NOT_CONFIGURED — ${why}`, { op: opName });
    }
    const op = READ_ONLY_OPERATIONS.find((o) => o.name === opName);
    if (!op || op.method !== method || !op.path.test(path)) {
      throw new SnapTradeError('SNAPTRADE_OPERATION_REFUSED', `operation ${String(opName).slice(0, 40)} is not one of VECTOR's read-only SnapTrade operations`, { op: opName });
    }
    const qp = new URLSearchParams();
    qp.set('clientId', env[SNAPTRADE_ENV.clientId].trim());
    qp.set('timestamp', String(Math.floor(now() / 1000)));
    if (op.userScoped && cfg.mode === 'personal-with-user-credentials') {
      qp.set('userId', env[SNAPTRADE_ENV.userId].trim());
      qp.set('userSecret', env[SNAPTRADE_ENV.userSecret].trim());
    }
    for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null && v !== '') qp.set(k, String(v));
    const queryString = qp.toString();
    const content = body && Object.keys(body).length ? body : null;
    const signature = signRequest({ consumerKey: env[SNAPTRADE_ENV.consumerKey].trim(), path: `${basePath}${path}`, query: queryString, content });
    const headers = { accept: 'application/json', Signature: signature };
    if (content) headers['content-type'] = 'application/json';
    let res;
    let text;
    try {
      res = await fetchImpl(`${cfg.baseUrl}${path}?${queryString}`, {
        method, headers, body: content ? canonicalJson(content) : undefined, redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
      });
      text = await res.text();
    } catch (e) {
      const timeout = e?.name === 'TimeoutError' || e?.name === 'AbortError';
      throw new SnapTradeError(timeout ? 'SNAPTRADE_TIMEOUT' : 'SNAPTRADE_UNREACHABLE',
        timeout ? `SnapTrade ${opName} did not answer within ${timeoutMs} ms` : `SnapTrade ${opName} could not be reached (${/^[A-Z][A-Z0-9_]{1,40}$/.test(String(e?.cause?.code ?? '')) ? e.cause.code : 'network error'})`, { op: opName });
    }
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    if (!res.ok) {
      const detail = scrub(typeof json?.detail === 'string' ? json.detail : typeof json?.message === 'string' ? json.message : '', secrets).slice(0, 200);
      const code = res.status === 401 || res.status === 403 ? 'SNAPTRADE_AUTH_REJECTED' : res.status === 429 ? 'SNAPTRADE_RATE_LIMITED' : `SNAPTRADE_HTTP_${res.status}`;
      throw new SnapTradeError(code, `SnapTrade ${opName} returned HTTP ${res.status}${detail ? `: ${detail}` : ''}`, { httpStatus: res.status, op: opName });
    }
    if (json === null) throw new SnapTradeError('SNAPTRADE_BAD_RESPONSE', `SnapTrade ${opName} did not return JSON`, { op: opName });
    return json;
  }

  const acct = (id) => {
    const s = String(id ?? '');
    if (!new RegExp(`^${ACCOUNT_ID}$`).test(s)) throw new SnapTradeError('SNAPTRADE_BAD_RESPONSE', 'SnapTrade returned an account id VECTOR cannot use');
    return encodeURIComponent(s);
  };

  return {
    config: cfg,
    /** Connection Portal link (data access only). The owner opens it and logs in to the brokerage at SnapTrade. */
    async connectionPortalLink() {
      const j = await call('connectionPortalLink', { method: 'POST', path: '/snapTrade/login', body: { connectionType: 'read' } });
      const url = typeof j?.redirectURI === 'string' ? j.redirectURI : null;
      let ok = false;
      try { ok = !!url && new URL(url).protocol === 'https:'; } catch { ok = false; }
      if (!ok) throw new SnapTradeError('SNAPTRADE_BAD_RESPONSE', 'SnapTrade did not return an https Connection Portal link', { op: 'connectionPortalLink' });
      return { redirectURI: url, expiresInSeconds: PORTAL_LINK_TTL_SECONDS, connectionType: 'read' };
    },
    listAccounts: () => call('listAccounts', { method: 'GET', path: '/accounts' }),
    accountBalances: (id) => call('accountBalances', { method: 'GET', path: `/accounts/${acct(id)}/balances` }),
    /** Positions: the documented "List all account positions" path, then the older per-account path on HTTP 404. */
    async accountPositions(id) {
      try {
        return await call('accountPositions', { method: 'GET', path: `/accounts/${acct(id)}/positions/all` });
      } catch (e) {
        if (e?.httpStatus !== 404) throw e;
        return call('accountPositions', { method: 'GET', path: `/accounts/${acct(id)}/positions` });
      }
    },
    /** Activities (transactions), paginated (max 1000 per page, at most MAX_ACTIVITY_PAGES pages per sync). */
    async accountActivities(id, { startDate = null, endDate = null } = {}) {
      const rows = [];
      let total = null;
      for (let page = 0; page < MAX_ACTIVITY_PAGES; page++) {
        const j = await call('accountActivities', {
          method: 'GET', path: `/accounts/${acct(id)}/activities`, query: { startDate, endDate, offset: page * ACTIVITY_PAGE_LIMIT, limit: ACTIVITY_PAGE_LIMIT },
        });
        const data = Array.isArray(j) ? j : Array.isArray(j?.data) ? j.data : [];
        rows.push(...data);
        total = Number.isInteger(j?.pagination?.total) ? j.pagination.total : null;
        if (Array.isArray(j) || data.length < ACTIVITY_PAGE_LIMIT || (total !== null && rows.length >= total)) return { rows, total, truncated: false };
      }
      return { rows, total, truncated: true };
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Normalisers (SnapTrade payload -> REAL_ACCOUNT rows). Both the classic and the newer response shapes are accepted.

const num = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'string' ? Number(v) : v;
  return Number.isFinite(n) ? n : null;
};
const str = (v, n = 200) => (typeof v === 'string' && v ? v.slice(0, n) : null);
const code = (c) => (typeof c === 'string' ? c.slice(0, 12) : str(c?.code, 12));

/** Account number masked to its last four characters. */
export function maskAccountNumber(n) {
  const s = typeof n === 'string' ? n.replace(/\s+/g, '') : '';
  if (!s) return null;
  return s.length <= 4 ? `••${s.slice(-2)}` : `••••${s.slice(-4)}`;
}

export function normalizeAccounts(payload) {
  const list = Array.isArray(payload) ? payload : Array.isArray(payload?.results) ? payload.results : [];
  return list.filter((a) => a && typeof a.id === 'string').map((a) => ({
    account_id: a.id.slice(0, 64),
    name: str(a.name ?? a.display_name, 120),
    number_masked: maskAccountNumber(a.number ?? a.masked_account_number ?? null),
    institution: str(a.institution_name ?? a.institution_id, 120),
    raw_type: str(a.raw_type, 60),
    status: str(a.status, 20),
    total_value: num(a.balance?.total?.amount ?? a.net_value?.amount),
    currency: code(a.balance?.total?.currency ?? a.net_value?.currency),
  }));
}

export function normalizeBalances(payload) {
  const list = Array.isArray(payload) ? payload : Array.isArray(payload?.results) ? payload.results : [];
  return list.filter(Boolean).map((b) => ({ currency: code(b.currency), cash: num(b.cash), buying_power: num(b.buying_power) }));
}

export function normalizePositions(payload) {
  const list = Array.isArray(payload) ? payload : Array.isArray(payload?.results) ? payload.results : [];
  return list.filter(Boolean).map((p) => {
    const inst = p.instrument ?? null;
    const sym = inst ? inst : p.symbol?.symbol ?? p.symbol ?? null;
    const units = num(p.units ?? p.fractional_units);
    const avg = num(p.average_purchase_price);
    return {
      symbol: str(typeof sym === 'string' ? sym : sym?.symbol ?? sym?.raw_symbol, 32),
      description: str(sym?.description, 160),
      kind: str(inst?.kind ?? sym?.type?.code ?? sym?.type, 24),
      units,
      price: num(p.price),
      cost_basis: num(p.cost_basis) ?? (avg !== null && units !== null ? avg * units : null),
      currency: code(p.currency ?? sym?.currency),
      cash_equivalent: p.cash_equivalent === true ? 1 : 0,
    };
  });
}

export function normalizeActivities(rows) {
  return (Array.isArray(rows) ? rows : []).filter(Boolean).map((t) => ({
    activity_id: str(t.id, 80),
    type: str(t.type, 40),
    trade_date: str(t.trade_date, 40),
    settlement_date: str(t.settlement_date, 40),
    symbol: str(t.symbol?.symbol ?? t.symbol?.raw_symbol ?? (typeof t.symbol === 'string' ? t.symbol : null), 32),
    description: str(t.description, 200),
    units: num(t.units),
    price: num(t.price),
    amount: num(t.amount),
    fee: num(t.fee),
    currency: code(t.currency),
  }));
}
