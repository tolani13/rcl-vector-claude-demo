// Live smoke test of the model PRESET path at $0 (connections-v1): local Ollama through the `ollama-local` preset,
// pinned for all three lenses, against a VACUUM INTO copy of the shipped DB (the shipped DB is never written).
//
//   node --disable-warning=ExperimentalWarning scripts/preset-smoke.mjs [--model qwen3:8b] [--sym TOPP]
//        [--step-minutes 60] [--assess] [--source-db data/vector.db] [--out receipts/connections-v1/preset-smoke-ollama.json]
//
// The server runs in-process on an ephemeral 127.0.0.1 port with a CLEAN environment (no API keys from the caller's
// environment are passed). Steps: GET /api/model/presets, GET /api/model, POST /api/model/test {preset, model}; with
// --assess also a pinned three-lens assessment run (async, polled) on the replay clock after --step-minutes.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { startServer } from '../server/index.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 && i + 1 < args.length ? args[i + 1] : d; };
const has = (k) => args.includes(`--${k}`);
const model = opt('model', 'qwen3:8b');
const sym = opt('sym', 'TOPP');
const stepMinutes = Number(opt('step-minutes', '60'));
const sourceDb = path.resolve(ROOT, opt('source-db', 'data/vector.db'));
const out = path.resolve(ROOT, opt('out', 'receipts/connections-v1/preset-smoke-ollama.json'));

const copy = path.join(ROOT, 'data', `preset-smoke-${process.pid}-${crypto.randomBytes(3).toString('hex')}.db`);
const src = new DatabaseSync(sourceDb, { readOnly: true });
src.exec(`VACUUM INTO '${copy.replace(/'/g, "''")}'`);
src.close();

const env = {
  VECTOR_PORT: '0', VECTOR_HOST: '127.0.0.1', VECTOR_DB: copy,
  VECTOR_MODEL_CONFIG: path.join(ROOT, 'data', 'preset-smoke-no-model-config.json'),
  VECTOR_MODEL_PRESET: 'ollama-local', VECTOR_MODEL_PRESET_MODEL: model, VECTOR_MODEL_PIN_ALL_LENSES: '1',
};
const receipt = {
  kind: 'connections-v1 preset smoke (live, $0, local Ollama)', generated_at: new Date().toISOString(),
  command: `node scripts/preset-smoke.mjs ${args.join(' ')}`.trim(), node: process.version,
  git_head: (() => { try { return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim(); } catch { return null; } })(),
  environment: { ...env, VECTOR_DB: 'VACUUM INTO copy of data/vector.db (deleted after the run)' },
  cost: '$0: local model through the ollama-local preset (cost free, trains_on_prompts false)',
  steps: {},
};
const logs = [];
const s = await startServer({ env, log: (m) => logs.push(m) });
const call = async (method, p, body) => {
  const init = { method, headers: { accept: 'application/json' } };
  if (method !== 'GET') { init.headers['content-type'] = 'application/json'; init.headers['x-vector-client'] = 'web'; init.body = JSON.stringify(body ?? {}); }
  const r = await fetch(s.url + p, init);
  return { status: r.status, json: await r.json() };
};
try {
  const presets = await call('GET', '/api/model/presets');
  receipt.steps.presets = { status: presets.status, selection: presets.json.selection, preset: presets.json.presets.find((p) => p.id === 'ollama-local') };
  const m = await call('GET', '/api/model');
  receipt.steps.model = { status: m.json.status, provider: m.json.provider, preset: m.json.preset, model: m.json.model, detail: m.json.detail, hindsight: m.json.limits ? undefined : undefined };
  const t0 = Date.now();
  const test = await call('POST', '/api/model/test', { preset: 'ollama-local', model, confirm: true });
  receipt.steps.model_test = { http: test.status, wall_ms: Date.now() - t0, ...test.json };
  if (has('assess')) {
    if (stepMinutes > 0) receipt.steps.replay_step = (await call('POST', '/api/replay/step', { minutes: stepMinutes })).json?.clock ?? null;
    const run = await call('POST', '/api/assessments/run', { sym, confirm: true, async: true });
    receipt.steps.assessment_request = { http: run.status, ...run.json };
    if (run.status === 202) {
      const deadline = Date.now() + 20 * 60_000;
      let last = null;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 5000));
        const st = await call('GET', '/api/status');
        last = st.json?.model?.lastAssessmentRun;
        if (last && last.run_id === run.json.run_id) break;
      }
      receipt.steps.assessment_outcome = last;
      const rows = await call('GET', `/api/assessments?sym=${encodeURIComponent(sym)}&limit=20`);
      receipt.steps.assessments = (rows.json?.rows ?? []).map((r) => ({
        id: r.id, lens: r.lens, status: r.status, provider: r.provider, model: r.model, latency_ms: r.latency_ms,
        stance: r.output?.stance ?? null, error: r.error ? String(r.error).slice(0, 200) : null, audit: r.audit ?? null,
      }));
    }
  }
} finally {
  await s.close();
  for (const sfx of ['', '-wal', '-shm']) fs.rmSync(copy + sfx, { force: true });
}
receipt.server_log_lines = logs.length;
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, `${JSON.stringify(receipt, null, 2)}\n`);
console.log(JSON.stringify({ out: path.relative(ROOT, out), model_test: receipt.steps.model_test?.decision, outcome: receipt.steps.assessment_outcome?.status ?? null }));
