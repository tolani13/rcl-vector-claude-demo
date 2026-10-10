// Server configuration from the environment (docs/CONTRACTS.md section 9). Pure: loadConfig(env) never reads secrets
// into its result. Secret-bearing variables (API keys) are reported only as presence flags, and secretValues(env)
// exists solely so the HTTP layer can scrub them from any response body as defence in depth.
//
// Variables (all optional):
//   VECTOR_HOST            bind address, default 127.0.0.1. Non-loopback addresses (e.g. 0.0.0.0) are refused unless
//                          VECTOR_ALLOW_REMOTE=1.
//   VECTOR_ALLOW_REMOTE=1  allow a non-loopback bind (e.g. phone testing on the LAN). The Host allow-list (DNS-rebinding
//                          guard) stays on: the server answers to loopback names, the machine's interface IP literals and
//                          VECTOR_ALLOWED_HOSTS only. Requests from a non-loopback peer additionally need the per-launch
//                          token: open the `?k=<token>` URL printed at startup once per device (sets an HttpOnly,
//                          SameSite=Strict cookie). Anyone who has that URL has full control of this paper lab.
//   VECTOR_ALLOWED_HOSTS   comma-separated extra Host names, `name` or `name:port` (e.g. a mDNS / tailnet name; IPv6 in
//                          brackets). Names must be listed explicitly; IP literals of local interfaces are added in remote mode.
//   VECTOR_ALLOWED_ORIGINS comma-separated extra browser origins accepted on mutations, e.g. https://vector.example.ts.net
//                          for an HTTPS reverse proxy / tunnel (otherwise only http:// origins on an allowed Host pass).
//   VECTOR_PORT            default 8787 (0 = ephemeral, used by tests)
//   VECTOR_REMOTE_TOKEN    (secret) remote mode only: a FIXED access token (24-128 chars of A-Z a-z 0-9 _ -) instead of
//                          a new random one per launch, so a hosted demo's link survives restarts and sleeps. Never printed.
//   VECTOR_DEPLOYMENT      local (default) | hosted-demo: how the UI describes this server (see web/js/deploy-note.js).
//   VECTOR_DB              SQLite path, default data/vector.db (read by server/db.js)
//   VECTOR_STARTING_CASH_USD  simulated seed money per portfolio for boot-time resets, default 10000
//   VECTOR_TICK_WALL_MS    default wall-clock ms per replay minute when playing (engine default 1500)
//   Model: VECTOR_MODEL_PROVIDER, VECTOR_ANTHROPIC_MODEL, VECTOR_OPENAI_BASE_URL, VECTOR_OPENAI_MODEL,
//          VECTOR_MAX_MODEL_CALLS_PER_SESSION, VECTOR_MODEL_TIMEOUT_MS (resolved by server/intel/model-provider.js)
//   Model presets: VECTOR_MODEL_PRESET, VECTOR_MODEL_PRESET_MODEL, VECTOR_MODEL_LENS_<LENS>, VECTOR_MODEL_PIN_ALL_LENSES,
//          VECTOR_MODEL_PRESETS (catalog path), VECTOR_ALLOW_PAID=1 (lifts the $0 guard), VECTOR_REAL_DATA_ALLOW_PRESETS
//   SnapTrade (read-only): VECTOR_SNAPTRADE_BASE_URL, VECTOR_SNAPTRADE_ACTIVITY_DAYS, VECTOR_SNAPTRADE_USER_ID
//   Secrets (never logged or returned): ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN (both resolved by the Anthropic SDK),
//          VECTOR_OPENAI_API_KEY, ALPACA_API_KEY_ID, ALPACA_API_SECRET_KEY, POLYGON_API_KEY, VECTOR_GROQ_API_KEY,
//          VECTOR_OPENROUTER_API_KEY, VECTOR_GEMINI_API_KEY, VECTOR_SNAPTRADE_CLIENT_ID, VECTOR_SNAPTRADE_CONSUMER_KEY,
//          VECTOR_SNAPTRADE_USER_SECRET.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_DB_PATH } from './db.js';
import { usdToU } from './util/money.js';

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(here, '..');
export const WEB_ROOT = path.join(ROOT, 'web');

export const DEFAULT_HOST = '127.0.0.1';
export const DEFAULT_PORT = 8787;
export const DEFAULT_STARTING_CASH_USD = 10_000;
export const MAX_BODY_BYTES = 64 * 1024;

/** Environment variables whose VALUES are secrets. Only their presence is ever reported. */
export const SECRET_ENV_VARS = Object.freeze(['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'VECTOR_OPENAI_API_KEY', 'ALPACA_API_KEY_ID', 'ALPACA_API_SECRET_KEY', 'POLYGON_API_KEY',
  // Model preset keys (config/model-presets.json key_env; any other key_env named there is scrubbed too, see api/context.js)
  'VECTOR_GROQ_API_KEY', 'VECTOR_OPENROUTER_API_KEY', 'VECTOR_GEMINI_API_KEY',
  // SnapTrade (read-only real accounts, server/data/providers/snaptrade.js)
  'VECTOR_SNAPTRADE_CLIENT_ID', 'VECTOR_SNAPTRADE_CONSUMER_KEY', 'VECTOR_SNAPTRADE_USER_ID', 'VECTOR_SNAPTRADE_USER_SECRET',
  // Remote access (hosted demo)
  'VECTOR_REMOTE_TOKEN']);
export const DEPLOYMENTS = Object.freeze(['local', 'hosted-demo']);
const REMOTE_TOKEN_RE = /^[A-Za-z0-9_-]{24,128}$/;

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1']);
const HOSTNAME_RE = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;
const IPV6_LITERAL_RE = /^\[[0-9a-f:.]{2,45}\]$/;

/** Parse VECTOR_ALLOWED_HOSTS: `name`, `name:port`, `[v6]` or `[v6]:port`, lowercased. */
function parseAllowedHosts(raw) {
  if (raw === undefined || raw === null || !String(raw).trim()) return [];
  return String(raw).split(',').map((s) => s.trim().toLowerCase()).filter(Boolean).map((entry) => {
    const m = /^(\[[^\]]+\]|[^:]+)(?::(\d{1,5}))?$/.exec(entry);
    const ok = m && (HOSTNAME_RE.test(m[1]) || IPV6_LITERAL_RE.test(m[1])) && (m[2] === undefined || Number(m[2]) <= 65535);
    if (!ok) throw new ConfigError(`VECTOR_ALLOWED_HOSTS entry "${entry.slice(0, 80)}" must be a host name or host:port (IPv6 in brackets)`);
    return entry;
  });
}

/** Parse VECTOR_ALLOWED_ORIGINS: exact origins (scheme://host[:port], no path), normalised by URL. */
function parseAllowedOrigins(raw) {
  if (raw === undefined || raw === null || !String(raw).trim()) return [];
  return String(raw).split(',').map((s) => s.trim()).filter(Boolean).map((entry) => {
    let u = null;
    try { u = new URL(entry); } catch { u = null; }
    const plain = u && (u.protocol === 'http:' || u.protocol === 'https:') && !u.username && !u.password && u.pathname === '/' && !u.search && !u.hash;
    if (!plain) throw new ConfigError(`VECTOR_ALLOWED_ORIGINS entry "${entry.slice(0, 80)}" must be an origin like https://host[:port] (no path)`);
    return u.origin.toLowerCase();
  });
}

export class ConfigError extends Error {
  constructor(message) { super(message); this.code = 'CONFIG_INVALID'; }
}

function appVersion() {
  try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version ?? '0.0.0'; } catch { return '0.0.0'; }
}

/** Remove credentials and query strings from a URL before it is displayed. Non-URLs are returned unchanged. */
export function sanitizeUrl(raw) {
  if (typeof raw !== 'string' || !raw) return raw ?? null;
  try {
    const u = new URL(raw);
    u.username = ''; u.password = ''; u.search = ''; u.hash = '';
    return u.toString().replace(/\/$/, '');
  } catch { return raw; }
}

/**
 * Parse and validate the server configuration. Throws ConfigError on invalid values (the server refuses to start).
 * @param {Record<string,string|undefined>} env
 */
export function loadConfig(env = process.env) {
  const host = (env.VECTOR_HOST ?? DEFAULT_HOST).trim() || DEFAULT_HOST;
  const allowRemote = env.VECTOR_ALLOW_REMOTE === '1';
  if (!LOOPBACK.has(host) && !allowRemote) {
    throw new ConfigError(`VECTOR_HOST=${host} is not a loopback address. VECTOR serves 127.0.0.1 only by default. Set `
      + 'VECTOR_ALLOW_REMOTE=1 to bind elsewhere (e.g. 0.0.0.0 for phone testing): the Host allow-list stays on, and other '
      + 'devices need the per-launch token URL printed at startup; anyone holding that URL has full control of the lab.');
  }
  const allowedHosts = parseAllowedHosts(env.VECTOR_ALLOWED_HOSTS);
  const allowedOrigins = parseAllowedOrigins(env.VECTOR_ALLOWED_ORIGINS);
  const portRaw = env.VECTOR_PORT ?? String(DEFAULT_PORT);
  const port = Number(portRaw);
  if (!Number.isInteger(port) || port < 0 || port > 65535 || String(portRaw).trim() === '') throw new ConfigError(`VECTOR_PORT must be an integer 0..65535 (got "${portRaw}")`);

  const cashRaw = env.VECTOR_STARTING_CASH_USD ?? String(DEFAULT_STARTING_CASH_USD);
  const cashUsd = Number(cashRaw);
  if (!Number.isFinite(cashUsd) || cashUsd < 1 || cashUsd > 1e9) throw new ConfigError(`VECTOR_STARTING_CASH_USD must be a number 1..1000000000 (got "${cashRaw}")`);

  const remoteTokenRaw = env.VECTOR_REMOTE_TOKEN;
  if (remoteTokenRaw !== undefined && remoteTokenRaw !== '' && !REMOTE_TOKEN_RE.test(remoteTokenRaw)) {
    throw new ConfigError('VECTOR_REMOTE_TOKEN must be 24-128 characters of A-Z a-z 0-9 _ - (the value is not shown)');
  }
  if (remoteTokenRaw && !allowRemote) throw new ConfigError('VECTOR_REMOTE_TOKEN is only used with VECTOR_ALLOW_REMOTE=1');
  const deployment = (env.VECTOR_DEPLOYMENT ?? 'local').trim() || 'local';
  if (!DEPLOYMENTS.includes(deployment)) throw new ConfigError(`VECTOR_DEPLOYMENT must be one of ${DEPLOYMENTS.join(' | ')}`);
  if (deployment === 'hosted-demo' && !allowRemote) throw new ConfigError('VECTOR_DEPLOYMENT=hosted-demo requires VECTOR_ALLOW_REMOTE=1 (token-protected access)');

  let tickWallMs = null;
  if (env.VECTOR_TICK_WALL_MS !== undefined && env.VECTOR_TICK_WALL_MS !== '') {
    tickWallMs = Number(env.VECTOR_TICK_WALL_MS);
    if (!Number.isInteger(tickWallMs) || tickWallMs < 250 || tickWallMs > 60_000) throw new ConfigError('VECTOR_TICK_WALL_MS must be an integer 250..60000');
  }

  return Object.freeze({
    app: Object.freeze({
      name: 'VECTOR', brand: 'Recursive Chaos Labs', motto: 'Refining Chaos Into Clarity', version: appVersion(),
      paperOnly: true, liveBroker: 'NONE — out of MVP scope', deployment,
    }),
    host, port, allowRemote,
    allowedHosts: Object.freeze(allowedHosts), allowedOrigins: Object.freeze(allowedOrigins),
    dbPath: env.VECTOR_DB || DEFAULT_DB_PATH,
    webRoot: WEB_ROOT,
    startingCashU: usdToU(cashUsd),
    tickWallMs,
    maxBodyBytes: MAX_BODY_BYTES,
    model: Object.freeze({
      provider: (env.VECTOR_MODEL_PROVIDER || 'none').trim().toLowerCase(),
      anthropicModel: env.VECTOR_ANTHROPIC_MODEL || null,
      openaiBaseUrl: sanitizeUrl(env.VECTOR_OPENAI_BASE_URL || null),
      openaiModel: env.VECTOR_OPENAI_MODEL || null,
      maxCallsPerSession: env.VECTOR_MAX_MODEL_CALLS_PER_SESSION || null,
    }),
    secretsPresent: Object.freeze(Object.fromEntries(SECRET_ENV_VARS.map((k) => [k, !!env[k]]))),
  });
}

/** Secret values currently set in env (for response scrubbing only; never serialised). Short values are ignored. */
export function secretValues(env = process.env) {
  return SECRET_ENV_VARS.map((k) => env[k]).filter((v) => typeof v === 'string' && v.length >= 8);
}

/** One-line, secret-free startup summary. */
export function describeConfig(cfg) {
  const keys = Object.entries(cfg.secretsPresent).filter(([, v]) => v).map(([k]) => k);
  return `host=${cfg.host} port=${cfg.port} db=${cfg.dbPath} model=${cfg.model.provider} `
    + `keys-present=[${keys.join(',') || 'none'}] startingCash=$${cfg.startingCashU / 10_000} paperOnly=true`
    + (cfg.allowRemote ? ` remote=ON (token required for non-loopback peers) allowedHosts=[${cfg.allowedHosts.join(',')}]` : '');
}
