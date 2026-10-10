// TEST FIXTURE — NOT MARKET DATA. Runs test/intel/live-smoke-ollama.js as a child process against a FIXTURE database and
// a node:http STUB of the Ollama API (no real model, no external network). Checks the CLI (--provider ollama --num-ctx,
// --training-cutoff), the receipt (hindsight_guard, reviewer_notes) and database safety: the source database is only
// read (VACUUM INTO a disposable copy that is deleted), and data/vector.db is refused as a write target.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { ROOT, tempDb, seedFixture, lensOf, lensOutput, FIX_DS, FIX_SYM, MOCK_TRAINING_CUTOFF } from './helpers.js';

const SCRIPT = path.join(ROOT, 'test', 'intel', 'live-smoke-ollama.js');
const MODEL = 'test-fixture-model:8b';
let server;
let base;
let fixture;
const chats = [];
const outFiles = [];

before(async () => {
  fixture = tempDb();
  seedFixture(fixture.db);
  fixture.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const send = (obj) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
      if (req.url === '/api/tags') return send({ models: [{ name: MODEL, model: MODEL }] });
      if (req.url === '/api/ps') return send({ models: chats.length ? [{ name: MODEL, model: MODEL, context_length: chats.at(-1).options.num_ctx }] : [] });
      if (req.url === '/api/chat') {
        const body = JSON.parse(raw);
        chats.push(body);
        const [system, user] = [body.messages[0].content, body.messages[1].content];
        const ids = [...new Set(user.match(/ev_[0-9a-f]{24}/g))];
        const out = lensOutput(lensOf(system), ids, { thesis: `TEST MOCK thesis; the 15m low of 0.399 [${ids[0]}]` });
        return send({
          model: MODEL, message: { role: 'assistant', content: `<think>TEST MOCK</think>${JSON.stringify(out)}` }, done: true, done_reason: 'stop',
          prompt_eval_count: Math.ceil((system.length + user.length) / 4), eval_count: 300,
        });
      }
      res.writeHead(404); res.end();
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  fixture.cleanup();
  for (const f of outFiles) fs.rmSync(f, { force: true });
});

function runScript(extra, envOver = {}) {
  const out = path.join(ROOT, 'data', `test-intel-smoke-receipt-${crypto.randomBytes(4).toString('hex')}.json`);
  outFiles.push(out);
  const env = { ...process.env, VECTOR_MODEL_CONFIG: path.join(ROOT, 'data', 'test-intel-no-such-config.json'), ...envOver };
  delete env.VECTOR_MODEL_TRAINING_CUTOFF;
  delete env.VECTOR_OLLAMA_NUM_CTX;
  delete env.VECTOR_OPENAI_CONTEXT_TOKENS;
  const argv = ['--disable-warning=ExperimentalWarning', SCRIPT, '--out', out, ...extra];
  return new Promise((resolve) => {
    execFile(process.execPath, argv, { cwd: ROOT, env, timeout: 60_000 }, (err, stdout, stderr) => {
      let receipt = null;
      try { receipt = JSON.parse(fs.readFileSync(out, 'utf8')); } catch { receipt = null; }
      resolve({ code: err ? err.code ?? 1 : 0, stdout, stderr, receipt });
    });
  });
}

const fixtureArgs = () => ['--provider', 'ollama', '--base', base, '--model', MODEL, '--source-db', fixture.path, '--ds', FIX_DS, '--date', '2026-01-05', '--hh', '10', '--mm', '30', '--sym', FIX_SYM];
const smokeCopies = () => fs.readdirSync(path.join(ROOT, 'data')).filter((f) => /^smoke-copy-/.test(f));

test('--provider ollama --num-ctx N --training-cutoff: three lens calls with num_ctx, receipt with hindsight_guard and reviewer_notes; source DB untouched', async () => {
  const before = smokeCopies();
  chats.length = 0;
  const r = await runScript([...fixtureArgs(), '--num-ctx', '12288', '--training-cutoff', MOCK_TRAINING_CUTOFF]);
  assert.equal(r.code, 0, r.stderr);
  const rc = r.receipt;
  assert.equal(rc.run_status, 'COMPLETED', JSON.stringify(rc.failure ?? rc.run_detail));
  assert.equal(rc.provider, 'ollama');
  assert.equal(rc.num_ctx_requested, 12288);
  assert.equal(chats.length, 3);
  assert.ok(chats.every((c) => c.options.num_ctx === 12288 && c.stream === false && c.format));
  assert.equal(rc.provider_status.status, 'CONNECTED');
  assert.deepEqual(rc.training_cutoff, { value: MOCK_TRAINING_CUTOFF, source: 'operator-supplied for this run (--training-cutoff)', effective: MOCK_TRAINING_CUTOFF, effective_source: 'configured' });
  assert.equal(rc.hindsight_guard.ok, true);
  assert.equal(rc.hindsight_guard.trade_date, '2026-01-05');
  assert.equal(rc.hindsight_guard.trainingCutoff, MOCK_TRAINING_CUTOFF);
  assert.deepEqual(rc.lenses.map((l) => [l.lens, l.status]), [['cowboy', 'OK'], ['pragmatist', 'OK'], ['tightwad', 'OK']]);
  assert.equal(rc.served_context.tokens, 12288);
  // Reviewer notes: deterministic observations per lens (the stub mislabels the session low as a 15m low).
  assert.equal(rc.reviewer_notes.per_lens.length, 3);
  assert.match(rc.reviewer_notes.status_semantics, /NOT fact-checked/);
  assert.equal(rc.reviewer_notes.human.status, 'NOT_REVIEWED');
  assert.ok(rc.reviewer_notes.per_lens.every((n) => n.observations.some((o) => /"15m low of 0\.399" is mislabelled: 0\.399 is regular_session\.session_low_usd/.test(o))));
  assert.ok(rc.reviewer_notes.per_lens.every((n) => n.context_use.context_tokens === 12288));
  // Packet v3 unknowns travel in the receipt.
  assert.ok(rc.unavailable.some((u) => u.kind === 'sector_industry'));
  assert.ok(rc.unavailable.some((u) => u.kind === 'analyst_views'));
  // Database safety: a disposable copy was used and deleted; the source fixture DB got no rows.
  assert.equal(rc.db.mode, 'disposable copy');
  assert.equal(rc.db.source_opened, 'read-only (never written)');
  assert.equal(rc.db.copy_deleted, true);
  assert.deepEqual(smokeCopies(), before);
  assert.equal(fixture.db.prepare('SELECT COUNT(*) n FROM assessments').get().n, 0);
  assert.equal(fixture.db.prepare('SELECT COUNT(*) n FROM evidence').get().n, 0);
});

test('without a training cutoff the run is BLOCKED by the hindsight guard and recorded as such; no model call', async () => {
  chats.length = 0;
  const r = await runScript(fixtureArgs());
  const rc = r.receipt;
  assert.equal(rc.run_status, 'BLOCKED');
  assert.equal(rc.run_detail.code, 'MODEL_TRAINING_CUTOFF_UNKNOWN');
  assert.equal(rc.hindsight_guard.ok, false);
  assert.equal(rc.hindsight_guard.code, 'MODEL_TRAINING_CUTOFF_UNKNOWN');
  assert.equal(rc.training_cutoff.value, null);
  assert.equal(chats.length, 0);
  assert.match(rc.reviewer_notes.run, /run not completed: BLOCKED \(MODEL_TRAINING_CUTOFF_UNKNOWN\)/);
  assert.equal(rc.num_ctx_requested, 16384, 'default num_ctx');
  assert.equal(rc.db.copy_deleted, true);
});

test('refuses data/vector.db as the write target and rejects malformed arguments before touching any database', async () => {
  const main = path.join(ROOT, 'data', 'vector.db');
  const stat = fs.existsSync(main) ? fs.statSync(main) : null;
  const refused = await runScript([...fixtureArgs(), '--db', path.join('data', 'vector.db'), '--training-cutoff', MOCK_TRAINING_CUTOFF]);
  assert.notEqual(refused.code, 0);
  assert.equal(refused.receipt.run_status, 'SMOKE_FAILED');
  assert.match(refused.receipt.failure, /refusing --db data\/vector\.db/);
  if (stat) assert.equal(fs.statSync(main).mtimeMs, stat.mtimeMs, 'data/vector.db was not modified');
  const badCutoff = await runScript([...fixtureArgs(), '--training-cutoff', '2026-13-45']);
  assert.match(badCutoff.receipt.failure, /--training-cutoff must be a YYYY-MM-DD date/);
  assert.equal(badCutoff.receipt.db, undefined, 'no database was opened');
  const badCtx = await runScript([...fixtureArgs(), '--num-ctx', 'big', '--training-cutoff', MOCK_TRAINING_CUTOFF]);
  assert.match(badCtx.receipt.failure, /--num-ctx must be a positive integer/);
  const mixed = await runScript([...fixtureArgs(), '--context', '8192', '--training-cutoff', MOCK_TRAINING_CUTOFF]);
  assert.match(mixed.receipt.failure, /--context applies to --provider openai-compatible/);
  const badProv = await runScript(['--provider', 'anthropic', '--out-of-scope']);
  assert.match(badProv.receipt.failure, /--provider must be ollama or openai-compatible/);
});
