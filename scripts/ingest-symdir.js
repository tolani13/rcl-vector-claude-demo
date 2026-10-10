#!/usr/bin/env node
// Usage: npm run ingest:symdir [-- --db path]
// Downloads the Nasdaq Trader symbol directory (nasdaqlisted.txt + otherlisted.txt) into ref_symbols and writes
// receipts/ingest-symdir.json. The directory is CURRENT as of the fetch (post-dated relative to earlier replays).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../server/db.js';
import { ingestSymDir } from '../server/data/ingest/nasdaq-symdir.js';

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

const db = openDb(opt('db') || undefined);
const t0 = Date.now();
const res = await ingestSymDir({ db });
for (const [name, f] of Object.entries(res.quality.files)) {
  console.log(`${name.padEnd(17)} ${f.ok ? 'ok    ' : 'FAILED'} http=${f.http_status} rows=${f.rows_parsed ?? 0} created=${f.file_creation_time_et ?? '-'}${f.error ? ' error=' + f.error : ''}`);
}
const out = writeReceipt('ingest-symdir.json', { command: 'node scripts/ingest-symdir.js', wall_ms: Date.now() - t0, dataset: datasetReceipt(db, res.ds) });
console.log(`Done: ${res.ds} status=${res.status} rows=${res.rowsStored}\nReceipt: ${out}`);
