#!/usr/bin/env node
// LIVE SMOKE (explicit test action, zero cost): real IEX evidence packet -> three independent lens assessments against
// a LOCAL Ollama server. No paid API is called. NOT part of the automated suite (the name does not end in .test.js).
//
//   node --disable-warning=ExperimentalWarning test/intel/live-smoke-ollama.js
//        [--provider ollama|openai-compatible] [--base URL] [--model qwen3:8b] [--num-ctx 16384] [--context N]
//        --training-cutoff YYYY-MM-DD
//        [--ds iex-tops-2026-10-07] [--date 2026-10-07] [--hh 10 --mm 30] [--sym SYM]
//        [--source-db data/vector.db] [--db <existing copy>] [--keep-copy]
//        [--reviewer-notes notes.json] [--out receipts/model-smoke-ollama.json]
//
// --provider        ollama (default): native POST /api/chat with options.num_ctx, so the packet fits WITHOUT
//                   reconfiguring the Ollama server (base default http://127.0.0.1:11434).
//                   openai-compatible: Ollama's /v1 endpoint (base default http://127.0.0.1:11434/v1); its context
//                   cannot be set per request (see --context).
// --num-ctx N       ollama only: context requested per call (default VECTOR_OLLAMA_NUM_CTX, else 16384).
// --context N       openai-compatible only: the context the server actually serves (OLLAMA_CONTEXT_LENGTH); default
//                   VECTOR_OPENAI_CONTEXT_TOKENS, else probed from /api/ps (4096 when the model is not loaded).
// --training-cutoff the model's DOCUMENTED training cutoff (default VECTOR_MODEL_TRAINING_CUTOFF). Never guess it: without
//                   one the hindsight guard BLOCKS the run (MODEL_TRAINING_CUTOFF_UNKNOWN), which the receipt records.
// Database safety   data/vector.db is NEVER written. By default the source database is opened read-only, copied with
//                   VACUUM INTO to a disposable data/smoke-copy-*.db, the run writes evidence/assessment/journal rows
//                   only into that copy, and the copy is deleted afterwards (--keep-copy keeps it). --db uses an existing
//                   copy instead and refuses data/vector.db itself.
// Receipt           provider status, effective/served context, packet text and hash, hindsight_guard (the guard's
//                   verdict for this model and trade date, computed even when the run is blocked), per-lens results
//                   with number cross-checks, and reviewer_notes (deterministic observations from smoke-review.js plus
//                   an optional human review from --reviewer-notes). Per-lens OK means schema-, evidence-id- and
//                   bracket-coherence-valid, NOT fact-checked. Failures are recorded honestly.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { openDb, closeDb } from '../../server/db.js';
import { etToUtc, fmtEt } from '../../server/util/time.js';
import { sessionWindow, universeAsOf, windowAggregatesAsOf, getDataset } from '../../server/data/marketdata.js';
import { getProvider, validIsoDate } from '../../server/intel/model-provider.js';
import { buildEvidencePacket, runLensAssessments, hindsightCheck, PACKET_VERSION } from '../../server/intel/assessments.js';
import { reviewerNotes } from './smoke-review.js';
import { ROOT } from './helpers.js';

const args = process.argv.slice(2);
const has = (k) => args.includes(`--${k}`);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 && i + 1 < args.length ? args[i + 1] : d; };
const MAIN_DB = path.join(ROOT, 'data', 'vector.db');
const posIntArg = (name, raw) => {
  if (raw === undefined || raw === null || raw === '') return null;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`--${name} must be a positive integer (got "${raw}")`);
  return n;
};
const canon = (p) => {
  let r;
  try { r = fs.realpathSync.native(p); } catch { r = path.resolve(p); }
  return process.platform === 'win32' ? r.toLowerCase() : r;
};

const providerKind = opt('provider', 'ollama');
const base = opt('base', providerKind === 'ollama' ? 'http://127.0.0.1:11434' : 'http://127.0.0.1:11434/v1');
const model = opt('model', 'qwen3:8b');
const ds = opt('ds', 'iex-tops-2026-10-07');
const date = opt('date', '2026-10-07');
const asOf = etToUtc(date, Number(opt('hh', 10)), Number(opt('mm', 30)));
const timeoutMs = 300_000;
const receiptPath = path.resolve(ROOT, opt('out', path.join('receipts', 'model-smoke-ollama.json')));
const sourceDb = path.resolve(ROOT, opt('source-db', path.join('data', 'vector.db')));
const dbArg = opt('db', null);
const keepCopy = has('keep-copy');
const cutoffArg = opt('training-cutoff', process.env.VECTOR_MODEL_TRAINING_CUTOFF) ?? null;
const reviewerNotesPath = opt('reviewer-notes', null);

const receipt = {
  kind: 'LIVE SMOKE — local Ollama model, zero cost; paper-only research output, not a recommendation',
  generated_at: new Date().toISOString(),
  provider: providerKind, model, endpoint: base,
  ds, asOf, asOf_et: fmtEt(asOf, { date: true }), packet_version: PACKET_VERSION,
  status_semantics: 'Per-lens OK = schema-, evidence-id- and bracket-coherence-valid; NOT fact-checked (see each lens verification and reviewer_notes).',
};
function write() {
  fs.mkdirSync(path.dirname(receiptPath), { recursive: true });
  fs.writeFileSync(receiptPath, JSON.stringify(receipt, null, 2));
  console.log(`receipt: ${receiptPath}`);
}

let dbPath = null;
let copyPath = null;
try {
  // ---- argument validation (before touching any database) ----
  if (!['ollama', 'openai-compatible'].includes(providerKind)) throw new Error(`--provider must be ollama or openai-compatible (got "${providerKind}")`);
  const numCtx = providerKind === 'ollama' ? posIntArg('num-ctx', opt('num-ctx', process.env.VECTOR_OLLAMA_NUM_CTX)) : null;
  const contextTokens = providerKind === 'openai-compatible' ? posIntArg('context', opt('context', process.env.VECTOR_OPENAI_CONTEXT_TOKENS)) : null;
  if (providerKind === 'ollama' && has('context')) throw new Error('--context applies to --provider openai-compatible; use --num-ctx with --provider ollama');
  if (providerKind === 'openai-compatible' && has('num-ctx')) throw new Error('--num-ctx applies to --provider ollama (the /v1 endpoint cannot set the context); use --context');
  const trainingCutoff = cutoffArg === null ? null : validIsoDate(String(cutoffArg));
  if (cutoffArg !== null && !trainingCutoff) throw new Error(`--training-cutoff must be a YYYY-MM-DD date (got "${cutoffArg}")`);
  let human = null;
  if (reviewerNotesPath) human = JSON.parse(fs.readFileSync(path.resolve(ROOT, reviewerNotesPath), 'utf8'));
  receipt.training_cutoff = {
    value: trainingCutoff,
    source: trainingCutoff ? (has('training-cutoff') ? 'operator-supplied for this run (--training-cutoff)' : 'operator-supplied (VECTOR_MODEL_TRAINING_CUTOFF)') : null,
  };

  // ---- database: never data/vector.db itself ----
  if (dbArg) {
    dbPath = path.resolve(ROOT, dbArg);
    if (canon(dbPath) === canon(MAIN_DB)) throw new Error('refusing --db data/vector.db: this smoke writes rows; pass a VACUUM INTO copy, or omit --db to let the script make and delete one');
    if (!fs.existsSync(dbPath)) throw new Error(`--db ${dbArg} does not exist`);
    receipt.db = { mode: 'existing copy (--db)', path: path.relative(ROOT, dbPath) };
  } else {
    if (!fs.existsSync(sourceDb)) throw new Error(`source database ${sourceDb} not found`);
    if (canon(sourceDb) === canon(MAIN_DB)) {
      // Do not copy data/vector.db while the IEX ingestion may still be writing it.
      const log = path.join(ROOT, 'data', 'ingest-iex.log');
      const tail = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split(/\r?\n/).pop() : '';
      if (fs.existsSync(log) && tail !== 'exit 0') throw new Error(`IEX ingestion not finished (log tail: "${tail}")`);
    }
    copyPath = path.join(ROOT, 'data', `smoke-copy-${process.pid}-${crypto.randomBytes(4).toString('hex')}.db`);
    receipt.db = {
      mode: 'disposable copy', source: path.relative(ROOT, sourceDb), source_opened: 'read-only (never written)',
      copy: path.relative(ROOT, copyPath), copy_ms: null, copy_deleted: null,
    };
    const t0 = Date.now();
    const src = new DatabaseSync(sourceDb, { readOnly: true });
    try { src.exec(`VACUUM INTO '${copyPath.replace(/'/g, "''")}'`); } finally { src.close(); }
    receipt.db.copy_ms = Date.now() - t0;
    dbPath = copyPath;
  }

  const db = openDb(dbPath);
  const dataset = getDataset(db, ds);
  if (!dataset) throw new Error(`dataset ${ds} not found`);
  receipt.dataset = { id: ds, provider: dataset.provider, status: dataset.status, sha256: dataset.sha256, source_url: dataset.source_url };

  // Symbol selection uses only as-of information: the penny-tier symbol with the most IEX trades since the open.
  let sym = opt('sym', null);
  if (!sym) {
    const win = sessionWindow(db, ds);
    const micro = universeAsOf(db, ds, asOf, 'micro').map((r) => r.sym);
    const agg = windowAggregatesAsOf(db, ds, asOf, { windowMin: 15, sessionOpen: win.open, syms: micro }).sort((a, b) => b.sn_total - a.sn_total);
    if (!agg.length) throw new Error('no penny-tier symbol with activity as of the as-of time');
    sym = agg[0].sym;
    receipt.selection = {
      method: 'as-of only: penny-tier universe (latest IEX price < $1.00 as of asOf), ranked by IEX trade count from 09:30 ET to asOf',
      universe_size: micro.length,
      top5_by_trades: agg.slice(0, 5).map((r) => ({ sym: r.sym, trades: r.sn_total, volume: r.sv_total })),
    };
  } else {
    receipt.selection = { method: 'given on the command line' };
  }
  receipt.sym = sym;

  const overrides = providerKind === 'ollama'
    ? { provider: 'ollama', timeoutMs, ollama: { baseUrl: base, model, timeoutMs, ...(numCtx ? { numCtx } : {}) } }
    : { provider: 'openai-compatible', timeoutMs, openaiCompatible: { baseUrl: base, model, timeoutMs, ...(contextTokens ? { contextTokens } : {}) } };
  const provider = getProvider({ ...overrides, ...(trainingCutoff ? { trainingCutoff } : {}) }, null, {
    env: {
      VECTOR_MAX_MODEL_CALLS_PER_SESSION: process.env.VECTOR_MAX_MODEL_CALLS_PER_SESSION, VECTOR_MAX_MODEL_CALLS_PER_DAY: process.env.VECTOR_MAX_MODEL_CALLS_PER_DAY,
      VECTOR_MODEL_CONFIG: process.env.VECTOR_MODEL_CONFIG,
    },
  });
  // What the hindsight guard will actually use (a model config file may also supply a cutoff).
  receipt.training_cutoff.effective = provider.config?.trainingCutoff ?? null;
  receipt.training_cutoff.effective_source = provider.config?.trainingCutoffSource ?? null;
  receipt.provider_status = await provider.status({ fresh: true });
  receipt.effective_context = typeof provider.effectiveContext === 'function' ? await provider.effectiveContext() : null;
  receipt.provider_config_warnings = provider.config?.warnings ?? [];
  if (providerKind === 'ollama') receipt.num_ctx_requested = provider.numCtx;
  console.log('provider status:', receipt.provider_status);

  const packet = buildEvidencePacket(db, ds, sym, asOf);
  if (packet.status !== 'OK') throw new Error(`evidence packet ${packet.status}: ${packet.detail}`);
  receipt.packet_sha256 = packet.sha256;
  receipt.evidence_ids = packet.evidenceIds;
  receipt.evidence_items = packet.packet.items.map((it) => ({ id: it.id, kind: it.kind, title: it.title, provider: it.provider, knowable_ts: it.knowable_ts, event_ts: it.event_ts ?? null }));
  receipt.unavailable = packet.packet.unavailable;
  receipt.packet_user_message = packet.userMessage; // sha256 of this exact text == packet_sha256

  // The guard's verdict for this model and replay date, recorded whether or not the run is allowed.
  const tradeDate = packet.packet.meta.trade_date;
  receipt.hindsight_guard = { trade_date: tradeDate, model: provider.model ?? null, ...hindsightCheck(provider, tradeDate) };
  console.log(`hindsight guard: ${receipt.hindsight_guard.ok ? 'ALLOWED' : 'BLOCKED'} (${receipt.hindsight_guard.code ?? 'safe'}) ${receipt.hindsight_guard.detail}`);

  const session_id = `smoke-ollama-${new Date().toISOString().slice(0, 19).replace(/[:T-]/g, '')}`;
  receipt.session_id = session_id;
  const t0 = Date.now();
  console.log(`running 3 lenses on ${sym} as of ${receipt.asOf_et} (timeout ${timeoutMs} ms per call)…`);
  const res = await runLensAssessments(db, provider, { session_id, ds, sym, asOf, packet, timeoutMs });
  receipt.wall_ms = Date.now() - t0;
  receipt.run_status = res.status;
  if (res.status !== 'COMPLETED') receipt.run_detail = { code: res.code ?? null, scope: res.scope ?? null, note: res.note ?? null, detail: res.detail ?? null };
  receipt.hindsight = res.hindsight ?? null;
  receipt.stances = res.stances ?? null;
  receipt.lenses = (res.results || []).map((r) => ({
    lens: r.lens, status: r.status, error_kind: r.errorKind ?? null, assessment_id: r.assessment_id, served_model: r.model,
    latency_ms: r.latencyMs, usage: r.usage, output: r.output, error: r.error, raw_excerpt: r.rawExcerpt ?? null,
    intent: r.intent, verification: r.verification ?? null, requested_model: r.requestedModel ?? null, fallback_used: r.fallbackUsed ?? null,
    attempts: r.attempts ?? 1, repair_of: r.repairOf ?? null, first_attempt_error: r.firstAttemptError ?? null,
  }));
  // The context the calls were actually served with (Ollama may clamp num_ctx; /api/ps shows the loaded value).
  let served = null;
  if (typeof provider.servedContext === 'function') served = await provider.servedContext();
  else if (receipt.effective_context?.tokens) served = receipt.effective_context;
  receipt.served_context = served;
  try {
    receipt.ollama_ps = await (await fetch(new URL('/api/ps', base).href, { signal: AbortSignal.timeout(3000) })).json();
  } catch (e) {
    receipt.ollama_ps = { error: String(e?.message ?? e) };
  }
  receipt.reviewer_notes = reviewerNotes(res.results ?? [], packet.packet.items, served, human);
  if (res.status !== 'COMPLETED') receipt.reviewer_notes.run = `run not completed: ${res.status}${res.code ? ` (${res.code})` : ''}; no lens output to review`;
  for (const l of receipt.lenses) console.log(`${l.lens}: ${l.status} ${l.output?.stance ?? ''} ${l.latency_ms ?? '-'} ms ${l.error ?? ''}`);
  for (const n of receipt.reviewer_notes.per_lens) for (const o of n.observations) console.log(`  review ${n.lens}: ${o}`);
} catch (e) {
  receipt.run_status = receipt.run_status ?? 'SMOKE_FAILED';
  receipt.failure = String(e?.stack ?? e).slice(0, 2000);
  console.error(e);
  process.exitCode = 1;
} finally {
  if (dbPath) closeDb(dbPath);
  if (copyPath) {
    if (keepCopy) {
      receipt.db.copy_deleted = false;
      receipt.db.note = 'kept by --keep-copy; delete it (and -wal/-shm) when done';
    } else {
      for (const suffix of ['', '-wal', '-shm']) { try { fs.rmSync(copyPath + suffix, { force: true }); } catch { /* reported below */ } }
      receipt.db.copy_deleted = !fs.existsSync(copyPath);
    }
  }
  write();
}
