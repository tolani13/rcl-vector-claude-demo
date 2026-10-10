#!/usr/bin/env node
// Usage: npm run ingest:finra [-- --dates 2026-10-06,2026-10-07] [--db path]
// Default dates: the 5 weekdays before 2026-10-07 plus 2026-10-07 (the replay date).
// Writes receipts/ingest-finra.json.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../server/db.js';
import { ingestRegSho, tradingDatesBefore } from '../server/data/ingest/finra-regsho.js';

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

const REPLAY_DATE = '2026-10-07';
const dates = opt('dates') ? String(opt('dates')).split(',').map((s) => s.trim()) : tradingDatesBefore(REPLAY_DATE, 5);
for (const d of dates) if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) { console.error(`bad date ${d}; use YYYY-MM-DD`); process.exit(2); }
const db = openDb(opt('db') || undefined);
const t0 = Date.now();
const results = await ingestRegSho({ db, dates });
for (const r of results) console.log(`${r.date} ${r.status.padEnd(8)} http=${r.quality.http_status} rows=${r.rowsStored}${r.quality.error ? ' error=' + r.quality.error : ''}`);
const out = writeReceipt('ingest-finra.json', {
  command: `node scripts/ingest-finra.js${opt('dates') ? ' --dates ' + opt('dates') : ''}`, wall_ms: Date.now() - t0, dates,
  datasets: results.map((r) => datasetReceipt(db, r.ds)),
});
console.log(`Done: ${results.filter((r) => r.status === 'complete').length}/${results.length} dates stored\nReceipt: ${out}`);
