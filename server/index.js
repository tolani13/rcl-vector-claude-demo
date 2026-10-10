// VECTOR server entry point: node:http, the static web app from web/, and the JSON API (docs/CONTRACTS.md section 9).
//
//   npm start                      -> http://127.0.0.1:8787 (env: see server/config.js)
//
// Request handling:
//   * Host header allow-list in EVERY mode — DNS-rebinding guard: loopback names on the bound port, plus (with
//     VECTOR_ALLOW_REMOTE=1) the machine's interface IP literals and the bound address, plus VECTOR_ALLOWED_HOSTS.
//     A rebinding attack needs the attacker's own host name in the Host header, which is never on the list.
//   * VECTOR_ALLOW_REMOTE=1: a request from a non-loopback peer must carry the per-launch token cookie (obtained once per
//     device by opening the `/?k=<token>` URL printed at startup; HttpOnly, SameSite=Strict). No token -> 401.
//   * /api/*: strict routes; POST/PUT require `X-Vector-Client: web` and `Content-Type: application/json` (CSRF guard;
//     a cross-site form or simple request cannot set either), an Origin on the allow-list when one is sent (never
//     compared with the request's own Host), and a JSON object body <= 64 KB, nested <= 32 levels. Errors are
//     {error:{code, message}} without stack traces or secrets; response bodies are scrubbed of configured secret values
//     as defence in depth.
//   * everything else: static files (server/api/static.js) with a same-origin Content-Security-Policy.
// Boot: open the DB, stop any stale play state and pause RUNNING agents (authority is never implicitly resumed),
// create an initial replay session on the newest market dataset if none exists (or a NO_VERIFIED_DATA session),
// wire the agents' model assessor (the provider is resolved per call, so a model configured, changed or removed after
// boot is honoured), and start nothing automatically.
import http from 'node:http';
import os from 'node:os';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { openDb, closeDb } from './db.js';
import { append } from './journal.js';
import { loadConfig, describeConfig, ConfigError } from './config.js';
import { bootRecover, reset, pause, setAgentContext, getState } from './replay/engine.js';
import { createLensAssessor } from './agents/runner.js';
import { createContext } from './api/context.js';
import { match } from './api/routes.js';
import { serveStatic } from './api/static.js';
import { ApiError, Reply, sendJson, errorBody, readJsonBody } from './api/http.js';
import { setFeedVerifyControl } from './data/providers/index.js';
import { FEED_VERIFY_CONTROL } from './api/feeds.js';

const MAX_URL_LENGTH = 4096;
const TOKEN_COOKIE = 'vector_k';

/**
 * Host header values this server answers to (lowercased host:port; bare names too when the port is 80).
 * @param {number} port bound port
 * @param {{allowRemote?:boolean, host?:string, allowedHosts?:string[]}} [config]
 * @param {object} [interfaces] os.networkInterfaces() result (injectable for tests)
 */
export function allowedHosts(port, config = {}, interfaces = null) {
  const hosts = new Set();
  const add = (h) => {
    const v = String(h).toLowerCase();
    hosts.add(`${v}:${port}`);
    if (port === 80) hosts.add(v);
  };
  for (const h of ['127.0.0.1', 'localhost', '[::1]']) add(h);
  if (config.allowRemote) {
    for (const list of Object.values(interfaces ?? os.networkInterfaces())) {
      for (const a of list ?? []) {
        const v6 = a.family === 'IPv6' || a.family === 6;
        add(v6 ? `[${String(a.address).split('%')[0]}]` : a.address);
      }
    }
    if (config.host && config.host !== '0.0.0.0' && config.host !== '::') add(config.host.includes(':') ? `[${config.host}]` : config.host);
  }
  for (const e of config.allowedHosts ?? []) {
    if (/:\d{1,5}$/.test(e)) {
      hosts.add(e);
      // A default port is omitted from the Host header (e.g. https behind a hosting proxy): accept the bare name too.
      const m = /^(.*):(80|443)$/.exec(e);
      if (m) hosts.add(m[1]);
    } else add(e);
  }
  return hosts;
}

/** True when an Origin header may perform mutations: an http:// origin on an allowed Host, or an explicitly listed origin. */
export function originAllowed(origin, hosts, config = {}) {
  let u;
  try { u = new URL(origin); } catch { return false; }
  if (u.origin === 'null') return false;
  if ((config.allowedOrigins ?? []).includes(u.origin.toLowerCase())) return true;
  return u.protocol === 'http:' && hosts.has(u.host.toLowerCase());
}

/** Loopback peer (IPv4 127/8, ::1, IPv4-mapped 127/8). */
export function isLoopbackAddress(addr) {
  const a = String(addr ?? '');
  return a === '::1' || /^127\./.test(a) || /^::ffff:127\./i.test(a);
}

function cookieValue(req, name) {
  for (const part of String(req.headers.cookie ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

function sameSecret(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/**
 * Build the request handler for a context. The handler never throws.
 * @param {ReturnType<typeof createContext>} ctx
 * @param {{log?:(msg:string)=>void}} [opts]
 */
export function createHandler(ctx, { log = (m) => console.error(m) } = {}) {
  const { config } = ctx;
  return async function handle(req, res) {
    const send = (status, body) => sendJson(res, status, body, { secrets: ctx.secrets, method: req.method });
    try {
      if ((req.url ?? '').length > MAX_URL_LENGTH) { send(414, errorBody('URI_TOO_LONG', 'request URL is too long')); return; }
      const hosts = ctx.allowedHosts ?? (ctx.port != null ? allowedHosts(ctx.port, config) : null);
      if (hosts) {
        const host = String(req.headers.host ?? '').toLowerCase();
        if (!hosts.has(host)) {
          send(421, errorBody('HOST_NOT_ALLOWED', config.allowRemote
            ? 'this server answers only to loopback names, local interface IP addresses and VECTOR_ALLOWED_HOSTS'
            : 'this server answers only to loopback host names'));
          return;
        }
      }
      let url;
      try { url = new URL(req.url, 'http://localhost'); } catch { send(400, errorBody('BAD_URL', 'malformed request URL')); return; }
      const pathname = url.pathname;
      const isApi = pathname.startsWith('/api/') || pathname === '/api';
      if (ctx.remoteToken && !isLoopbackAddress(req.socket?.remoteAddress)) {
        const k = url.searchParams.get('k');
        if (k !== null && !isApi && (req.method === 'GET' || req.method === 'HEAD') && sameSecret(k, ctx.remoteToken)) {
          res.writeHead(303, {
            location: '/', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer',
            'set-cookie': `${TOKEN_COOKIE}=${ctx.remoteToken}; HttpOnly; SameSite=Strict; Path=/`,
          });
          res.end();
          return;
        }
        if (!sameSecret(cookieValue(req, TOKEN_COOKIE), ctx.remoteToken)) {
          req.resume();
          send(401, errorBody('REMOTE_TOKEN_REQUIRED', 'remote access needs the per-launch token: open the ?k=<token> URL printed when the server started'));
          return;
        }
      }
      if (!isApi) { serveStatic(config.webRoot, req, res, pathname); return; }

      const m = match(req.method, pathname);
      if (!m) { send(404, errorBody('NOT_FOUND', `no API route ${pathname.slice(0, 120)}`)); return; }
      if (m.methodNotAllowed) {
        res.setHeader('allow', m.allow.join(', '));
        send(405, errorBody('METHOD_NOT_ALLOWED', `use ${m.allow.join(' | ')}`));
        return;
      }
      let body = {};
      if (req.method === 'POST' || req.method === 'PUT') {
        if (req.headers['x-vector-client'] !== 'web') {
          req.resume();
          send(403, errorBody('CSRF_GUARD', 'mutations require the header X-Vector-Client: web'));
          return;
        }
        const ct = String(req.headers['content-type'] ?? '').toLowerCase();
        if (!/^application\/json(\s*;.*)?$/.test(ct)) {
          req.resume();
          send(415, errorBody('UNSUPPORTED_MEDIA_TYPE', 'mutations require Content-Type: application/json'));
          return;
        }
        const origin = req.headers.origin;
        const originOk = origin === undefined || (hosts
          ? originAllowed(origin, hosts, config)
          : origin === `http://${req.headers.host}`);
        if (!originOk) {
          req.resume();
          send(403, errorBody('ORIGIN_MISMATCH', 'cross-origin mutations are refused'));
          return;
        }
        if (req.headers['sec-fetch-site'] === 'cross-site') {
          req.resume();
          send(403, errorBody('ORIGIN_MISMATCH', 'cross-site mutations are refused'));
          return;
        }
        body = await readJsonBody(req, config.maxBodyBytes);
      }
      const out = await m.route.handler(ctx, req, { url, params: m.params, body });
      if (out instanceof Reply) send(out.status, out.body);
      else send(200, out);
    } catch (e) {
      if (e instanceof ApiError) {
        send(e.status, errorBody(e.code, e.message, e.extra));
        return;
      }
      // Unexpected: log server-side (message + stack), answer with a generic envelope.
      log(`[vector] ${req.method} ${String(req.url).slice(0, 200)} -> 500: ${e?.stack ?? e}`);
      if (!res.headersSent) send(500, errorBody('INTERNAL_ERROR', 'internal server error (details are in the server log)'));
      else res.destroy();
    }
  };
}

const providerConfigured = (p) => !!(p && p.kind !== 'none' && typeof p.complete === 'function');

/**
 * Wire the agent runner's model assessor. The provider is resolved on every call (ctx.provider() follows the
 * environment and the model config file), so the assessor never keeps a provider from boot. While no provider is
 * configured, `model.status` reads DISCONNECTED and model-mode agents are blocked MODEL_DISCONNECTED before any call;
 * when one is configured, each lens call goes through runner.createLensAssessor (CONNECTED check, caps, hindsight
 * guard). Agent lens calls in flight are counted for GET /api/status (model.running).
 * @param {{db:object, provider:()=>object|null, modelRuns:{agentCalls:number}}} ctx
 * @returns {{assess:Function, model:{readonly status:'CONFIGURED'|'DISCONNECTED'}}}
 */
export function createAgentAssessor(ctx) {
  // One assessor per lens: with model presets a lens may use its own provider (or all three share a pinned one).
  const perLens = new Map(); // lens -> {provider, assessor}
  const assess = async (sym, lens, ...rest) => {
    const p = ctx.provider(lens);
    let hit = perLens.get(lens);
    if (!hit || hit.provider !== p) { hit = { provider: p, assessor: createLensAssessor(ctx.db, p) }; perLens.set(lens, hit); }
    ctx.modelRuns.agentCalls++;
    try { return await hit.assessor(sym, lens, ...rest); } finally { ctx.modelRuns.agentCalls--; }
  };
  const model = { get status() { return providerConfigured(ctx.provider()) ? 'CONFIGURED' : 'DISCONNECTED'; } };
  return { assess, model };
}

/** Install createAgentAssessor(ctx) as the replay engine's agent context; returns whether a provider is configured now. */
export function wireAgentAssessor(ctx) {
  setAgentContext(createAgentAssessor(ctx));
  return providerConfigured(ctx.provider());
}

/**
 * Boot-time recovery and initial state. Returns a summary (also journaled as SERVER_START).
 * Starts nothing: the replay is not played and every agent is PAUSED/STOPPED until a human acts.
 */
export function boot(ctx) {
  const { db, config } = ctx;
  const rec = bootRecover(db);
  let initialReset = null;
  if (!db.prepare('SELECT 1 FROM replay_state WHERE id = 1').get()) {
    // A system action, not a human one: engine.reset journals REPLAY_RESET with actor 'system', and SERVER_START below
    // records the reason.
    const r = reset(db, { startingCashU: config.startingCashU, actor: 'system' });
    initialReset = r.ok
      ? { session_id: r.session_id, status: r.state.status, ds: r.state.ds, initiatedBy: 'system', reason: 'automatic at boot: no replay session existed' }
      : { error: r.code, message: r.message };
  }
  const modelConfigured = wireAgentAssessor(ctx);
  const st = getState(db);
  const summary = {
    version: config.app.version, paperOnly: true, liveBroker: config.app.liveBroker, host: config.host,
    modelProvider: (() => { const p = ctx.provider(); return p?.preset?.id ? `preset ${p.preset.id} (${p.model ?? 'no model'})${p.blockedCode ? ` BLOCKED: ${p.blockedCode}` : ''}` : p?.blockedCode ? `${config.model.provider} BLOCKED: ${p.blockedCode}` : config.model.provider; })(), modelAssessorWired: modelConfigured, modelAssessor: 'provider resolved per call',
    pausedAgentsOnBoot: rec.pausedAgents, initialReset,
    replay: { status: st.status, session_id: st.session_id, ds: st.ds, clock: st.clock },
    note: 'Server started. Replay play state is not restored and agent authority is not implicitly resumed.',
  };
  append(db, { session_id: st.session_id, ts_sim: st.clock, actor: 'system', type: 'SERVER_START', ref_id: null, payload: summary });
  return summary;
}

/**
 * Create and start a server. Used by `npm start` and by tests (port 0, temp DB, injected env/provider/fetch).
 * @param {{env?:object, db?:object, provider?:object|null, fetchImpl?:Function, log?:Function, installSignalHandlers?:boolean}} [o]
 * @returns {Promise<{server:http.Server, url:string, ctx:object, bootSummary:object, close:()=>Promise<void>}>}
 */
export async function startServer({ env = process.env, db = null, provider = null, fetchImpl = undefined, modelFetch = undefined, snaptradeFetch = undefined, log = (m) => console.error(m), installSignalHandlers = false } = {}) {
  const config = loadConfig(env);
  const ownDb = !db;
  const database = db ?? openDb(config.dbPath);
  const ctx = createContext({ db: database, config, env, provider, fetchImpl, modelFetch, snaptradeFetch });
  ctx.log = log;
  if (config.allowRemote) {
    ctx.remoteTokenFixed = !!env.VECTOR_REMOTE_TOKEN;
    ctx.remoteToken = env.VECTOR_REMOTE_TOKEN || crypto.randomBytes(18).toString('base64url');
    ctx.secrets = [...ctx.secrets, ctx.remoteToken]; // never echoed in a response body
  }
  const bootSummary = boot(ctx);
  const server = http.createServer(createHandler(ctx, { log }));
  server.keepAliveTimeout = 5000;
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, config.host, () => { server.off('error', reject); resolve(); });
  });
  ctx.port = server.address().port;
  ctx.allowedHosts = allowedHosts(ctx.port, config);
  // The feed-verification routes now exist and are reachable: status text may point at them.
  setFeedVerifyControl(FEED_VERIFY_CONTROL);
  const hostForUrl = config.host.includes(':') ? `[${config.host}]` : config.host;
  const url = `http://${hostForUrl}:${ctx.port}`;

  let closing = null;
  const close = () => {
    if (closing) return closing;
    closing = (async () => {
      pause(database, { reason: 'server shutdown' });
      await new Promise((resolve) => { server.close(() => resolve()); server.closeIdleConnections?.(); setTimeout(resolve, 3000).unref(); });
      // Let an in-flight replay step finish its current minute (and a running assessment / feed check its current call,
      // bounded) before the database closes.
      for (let i = 0; i < 150 && (ctx.busy.step || ctx.busy.assess || ctx.busy.feedVerify || getState(database).busy); i++) await new Promise((r) => setTimeout(r, 100));
      try {
        const st = getState(database);
        append(database, { session_id: st.session_id, ts_sim: st.clock, actor: 'system', type: 'SERVER_STOP', ref_id: null, payload: { note: 'graceful shutdown; play stopped' } });
      } catch { /* database may already be unusable */ }
      if (ownDb) closeDb(config.dbPath);
    })();
    return closing;
  };

  if (installSignalHandlers) {
    const onSignal = (sig) => {
      log(`[vector] ${sig} received; shutting down`);
      close().then(() => process.exit(0), () => process.exit(1));
    };
    process.once('SIGINT', onSignal);
    process.once('SIGTERM', onSignal);
  }
  return { server, url, ctx, bootSummary, close, remoteToken: ctx.remoteToken ?? null };
}

async function main() {
  try {
    const { url, ctx, bootSummary } = await startServer({ installSignalHandlers: true, log: (m) => console.error(m) });
    console.log(`VECTOR (Recursive Chaos Labs) — PAPER ONLY, no live trading. Listening on ${url}`);
    console.log(`[vector] ${describeConfig(ctx.config)}`);
    console.log(`[vector] replay ${bootSummary.replay.status} session=${bootSummary.replay.session_id} ds=${bootSummary.replay.ds ?? 'none'}; `
      + `agents paused on boot: ${bootSummary.pausedAgentsOnBoot.length}; model provider: ${bootSummary.modelProvider}`);
    if (ctx.remoteToken) {
      const port = ctx.port;
      const lan = [...ctx.allowedHosts].filter((h) => !/^(127\.0\.0\.1|localhost|\[::1\])(:|$)/.test(h) && h.endsWith(`:${port}`));
      console.log('[vector] REMOTE ACCESS ENABLED (VECTOR_ALLOW_REMOTE=1). Anyone holding the token URL has full control of this paper lab.');
      if (ctx.remoteTokenFixed) console.log('[vector] access token: the fixed VECTOR_REMOTE_TOKEN (not printed); open <this server>/?k=<that token> once per device.');
      else console.log(`[vector] open once per device: ${lan.length ? lan.map((h) => `http://${h}/?k=${ctx.remoteToken}`).join('  ') : `http://<this-machine>:${port}/?k=${ctx.remoteToken}`}`);
    }
  } catch (e) {
    if (e instanceof ConfigError) console.error(`[vector] configuration error: ${e.message}`);
    else console.error(`[vector] failed to start: ${e?.message ?? e}`);
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
