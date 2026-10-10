#!/usr/bin/env node
// Usage: SEC_USER_AGENT="<name> <contact e-mail>" npm run ingest:sec -- --symbols SYM1,SYM2 [--db path]
// Without SEC_USER_AGENT this prints BLOCKED with setup instructions, makes no request, and records the BLOCKED
// outcome in receipts/ingest-sec.json. A User-Agent or contact is never invented.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../server/db.js';
import { ingestSecEdgar, secConfig } from '../server/data/ingest/sec-edgar.js';

// ---- receipt helpers (kept inline so each script is self-contained) ----
const args = process.argv.slice(2);
function opt(k, d = null) { const i = args.indexOf(`--${k}`); return i >= 0 ? (args[i + 1] ?? true) : d; }
const receiptDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'receipts');
function datasetReceipt(db, id) {
  const d = db.prepare('SELECT * FROM datasets WHERE id = ?').get(id);
  if (!d) return null;
  const r = { ...d, quality: d.quality_json ? JSON.parse(d.quality_json) : null };
  delete r.quality_json;
  return r;
}
function writeReceipt(name, body) {
  fs.mkdirSync(receiptDir, { recursive: true });
  const file = path.join(receiptDir, name);
  fs.writeFileSync(file, JSON.stringify({ generated_at: new Date().toISOString(), node: process.version, ...body }, null, 2));
  return file;
}

const cfg = secConfig();
if (!cfg.configured) {
  console.error(`BLOCKED: ${cfg.reason}\n\n${cfg.setup}`);
  const out = writeReceipt('ingest-sec.json', { command: 'node scripts/ingest-sec.js', status: 'BLOCKED', reason: cfg.reason, setup: cfg.setup, requests_made: 0 });
  console.error(`\nReceipt: ${out}`);
  process.exit(3);
}
const symbols = opt('symbols') ? String(opt('symbols')).split(',') : [];
if (!symbols.length) { console.error('Usage: npm run ingest:sec -- --symbols SYM1,SYM2'); process.exit(2); }
const db = openDb(opt('db') || undefined);
const t0 = Date.now();
const res = await ingestSecEdgar({ db, symbols });
for (const [sym, s] of Object.entries(res.perSymbol || {})) console.log(`${sym.padEnd(8)} ${JSON.stringify(s)}`);
const out = writeReceipt('ingest-sec.json', { command: `node scripts/ingest-sec.js --symbols ${symbols.join(',')}`, wall_ms: Date.now() - t0, status: res.status, dataset: res.ds ? datasetReceipt(db, res.ds) : null });
console.log(`Done: status=${res.status} filings=${res.filings ?? 0} facts=${res.facts ?? 0}\nReceipt: ${out}`);
