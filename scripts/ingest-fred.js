#!/usr/bin/env node
// Usage: npm run ingest:fred [-- --series DGS10,UNRATE] [--db path]
// Downloads FRED fredgraph.csv series, stores macro_series/macro_obs, writes receipts/ingest-fred.json.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../server/db.js';
import { ingestFred, FRED_SERIES } from '../server/data/ingest/fred.js';

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

const series = opt('series') ? String(opt('series')).split(',').map((s) => s.trim().toUpperCase()) : FRED_SERIES.map((s) => s.id);
const db = openDb(opt('db') || undefined);
const t0 = Date.now();
const res = await ingestFred({ db, series });
for (const [id, s] of Object.entries(res.series)) {
  console.log(`${id.padEnd(11)} ${s.ok ? 'ok    ' : 'FAILED'} http=${s.http_status} rows=${s.rows_total ?? 0} numeric=${s.rows_numeric ?? 0} missing('.')=${s.rows_missing_dot ?? 0} last=${s.last_numeric_date ?? '-'}${s.error ? ' error=' + s.error : ''}`);
}
const out = writeReceipt('ingest-fred.json', { command: `node scripts/ingest-fred.js${opt('series') ? ' --series ' + opt('series') : ''}`, wall_ms: Date.now() - t0, dataset: datasetReceipt(db, res.ds) });
console.log(`Done: ${res.ds} status=${res.status} rows=${res.rowsStored}\nReceipt: ${out}`);
