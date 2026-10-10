#!/usr/bin/env node
// LIVE RUN (explicit action, zero cost): one agent in decisionMode 'model_confirm' replays the real IEX day; every rules
// entry it plans must be confirmed by a REAL local model (Ollama, Cowboy lens) before the policy gate sees it.
// NOT part of the automated suite. data/vector.db is never written: a disposable VACUUM INTO copy is used and deleted.
//
//   node --disable-warning=ExperimentalWarning test/intel/live-model-confirm-ollama.js \
//        --training-cutoff YYYY-MM-DD [--model qwen3:8b] [--num-ctx 16384] [--agent agent-cowboy-micro]
//        [--preset handwritten-notes-example] [--ds iex-tops-2026-10-07] [--out receipts/e2e-model-confirm-ollama-2026-10-07.json]
//        [--reviewer-notes notes.json]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = process.argv.slice(2);
const opt = (k, d = null) => { const i = args.indexOf(`--${k}`); return i >= 0 ? (args[i + 1] ?? d) : d; };
const cutoff = opt('training-cutoff', process.env.VECTOR_MODEL_TRAINING_CUTOFF ?? null);
if (!cutoff) { console.error('--training-cutoff is required (documented cutoff or a documented upper bound; never guessed)'); process.exit(2); }
const model = opt('model', 'qwen3:8b');
const agentId = opt('agent', 'agent-cowboy-micro');
const presetId = opt('preset', 'handwritten-notes-example');
const ds = opt('ds', 'iex-tops-2026-10-07');
const out = path.resolve(ROOT, opt('out', 'receipts/e2e-model-confirm-ollama-2026-10-07.json'));
const reviewerNotes = opt('reviewer-notes') ? JSON.parse(fs.readFileSync(opt('reviewer-notes'), 'utf8')) : null;

// Configure the real provider BEFORE importing server modules (they read the environment when resolving it).
Object.assign(process.env, {
  VECTOR_MODEL_PROVIDER: 'ollama', VECTOR_OLLAMA_MODEL: model, VECTOR_OLLAMA_NUM_CTX: opt('num-ctx', '16384'),
  VECTOR_MODEL_TRAINING_CUTOFF: cutoff, VECTOR_MODEL_TIMEOUT_MS: opt('timeout-ms', '300000'),
});

const src = path.join(ROOT, 'data', 'vector.db');
const copy = path.join(ROOT, 'data', `mc-copy-${Date.now()}.db`);
{ const ro = new DatabaseSync(src, { readOnly: true }); ro.exec(`VACUUM INTO '${copy.replaceAll("'", "''")}'`); ro.close(); }

const { openDb, closeDb } = await import('../../server/db.js');
const engine = await import('../../server/replay/engine.js');
const controls = await import('../../server/controls.js');
const { createLensAssessor } = await import('../../server/agents/runner.js');
const { getProvider } = await import('../../server/intel/model-provider.js');
const { PRESETS } = await import('../../server/agents/strategies.js');
const { verifyChain } = await import('../../server/journal.js');
const { fmtEt } = await import('../../server/util/time.js');

const db = openDb(copy);
const t0 = Date.now();
let receipt;
try {
  const provider = getProvider();
  const providerStatus = await provider.status();
  console.log('provider', providerStatus.status, providerStatus.detail);
  engine.setAgentContext({ assess: createLensAssessor(db, provider), model: { status: 'CONFIGURED' } });
  const strategy = { ...structuredClone(PRESETS[presetId]), decisionMode: 'model_confirm' };
  const rs = engine.reset(db, { ds, strategies: { [agentId]: strategy }, actor: 'human' });
  if (!rs.ok) throw new Error(`reset failed: ${rs.code} ${rs.message}`);
  const st = controls.startAgent(db, agentId, { by: 'human' });
  console.log('start', JSON.stringify(st).slice(0, 200));
  let steps = 0;
  for (;;) {
    const r = await engine.step(db, { minutes: 1 });
    steps++;
    if (!r.ok) { console.log('stop:', r.code); break; }
    if (r.intents || r.fills || r.blocked) console.log(`${fmtEt(r.state.clock)} intents=${r.intents} accepted=${r.accepted} denied=${r.denied} fills=${r.fills} blocked=${r.blocked}`);
    if (r.closed) break;
  }
  const sid = engine.getState(db).session_id;
  const rows = db.prepare(`SELECT seq, ts_sim, actor, type, agent_id, ref_id, payload_json FROM journal WHERE session_id = ? AND type IN
      ('MODEL_CONFIRMATION','MODEL_ASSESSMENT','MODEL_CALL_BLOCKED','INTENT_PROPOSED','POLICY_ACCEPT','POLICY_DENY','ORDER_SUBMITTED','FILL_ESTIMATED','STOP_TRIGGERED','AGENT_BLOCKED','AGENT_FAULT')
      ORDER BY seq`).all(sid).map((r) => ({ ...r, ts_et: r.ts_sim ? fmtEt(r.ts_sim, { date: true }) : null, payload: JSON.parse(r.payload_json), payload_json: undefined }));
  const assessments = db.prepare('SELECT id, sym, lens, model, as_of, status, error, latency_ms, output_json FROM assessments WHERE session_id = ? ORDER BY created_wall').all(sid)
    .map((a) => ({ ...a, as_of_et: fmtEt(a.as_of, { date: true }), output: a.output_json ? JSON.parse(a.output_json) : null, output_json: undefined }));
  const count = (t) => rows.filter((r) => r.type === t).length;
  receipt = {
    label: 'REAL IEX HISTORICAL DATA (iex-tops-2026-10-07) + REAL LOCAL MODEL (Ollama) — PAPER FILLS ARE ESTIMATES; model outputs are not fact-checked and not recommendations',
    command: `node test/intel/live-model-confirm-ollama.js --training-cutoff ${cutoff} --model ${model} --agent ${agentId} --preset ${presetId}`,
    database: 'disposable VACUUM INTO copy of data/vector.db (deleted after the run)',
    generated_at: new Date().toISOString(), wall_seconds: Math.round((Date.now() - t0) / 1000),
    provider: { kind: 'ollama', model, status: providerStatus, training_cutoff_configured: cutoff },
    reviewer_notes: reviewerNotes,
    agent: { id: agentId, strategy_id: presetId, decisionMode: 'model_confirm', note: 'Rules plan the entry; the Cowboy lens of a real model must answer consider_entry on the as-of evidence packet before the deterministic policy gate evaluates the intent.' },
    session_id: sid, steps,
    counts: {
      model_confirmations: count('MODEL_CONFIRMATION'), model_assessment_rows: count('MODEL_ASSESSMENT'), intents: count('INTENT_PROPOSED'),
      policy_accept: count('POLICY_ACCEPT'), policy_deny: count('POLICY_DENY'), orders: count('ORDER_SUBMITTED'), fills: count('FILL_ESTIMATED'),
      agent_blocked: count('AGENT_BLOCKED'), agent_fault: count('AGENT_FAULT'),
    },
    assessments, journal: rows, chain: verifyChain(db),
  };
} finally {
  closeDb(copy);
  for (const f of [copy, `${copy}-wal`, `${copy}-shm`]) { try { fs.unlinkSync(f); } catch { /* absent */ } }
}
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify(receipt, null, 2));
console.log('counts', JSON.stringify(receipt.counts));
console.log('receipt:', out);
