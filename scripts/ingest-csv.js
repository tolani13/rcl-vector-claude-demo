#!/usr/bin/env node
// Usage: node scripts/ingest-csv.js --manifest manifest.json --csv bars.csv [--db path] [--receipt path|none]
// Imports user-supplied historical bars from local files through the same validator as POST /api/import/csv
// (server/data/ingest/csv-import.js), without the 64 KB HTTP body cap: the limits are MAX_IMPORT_ROWS rows and a
// MAX_FILE_BYTES file size. Every accepted import is IMPORTED_UNVERIFIED (mere upload does not establish authenticity).
// Writes receipts/ingest-csv.json unless --receipt none. Exit code 0 = imported (or identical re-import), 1 = rejected.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../server/db.js';
import { importCsvBars, MAX_IMPORT_ROWS } from '../server/data/ingest/csv-import.js';

const MAX_FILE_BYTES = 64 * 1024 * 1024;

// ---- receipt helpers (kept inline so each script is self-contained) ----
const args = process.argv.slice(2);
function opt(k, d = null) { const i = args.indexOf(`--${k}`); return i >= 0 ? (args[i + 1] ?? true) : d; }
const receiptDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'receipts');
function datasetReceipt(db, id) {
  const d = id ? db.prepare('SELECT * FROM datasets WHERE id = ?').get(id) : null;
  if (!d) return null;
  const r = { ...d, quality: d.quality_json ? JSON.parse(d.quality_json) : null };
  delete r.quality_json;
  return r;
}
function writeReceipt(target, body) {
  const file = target ? path.resolve(target) : path.join(receiptDir, 'ingest-csv.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ generated_at: new Date().toISOString(), node: process.version, ...body }, null, 2));
  return file;
}
function fail(msg) { console.error(msg); process.exit(1); }

const manifestPath = opt('manifest');
const csvPath = opt('csv');
if (typeof manifestPath !== 'string' || typeof csvPath !== 'string') fail('usage: node scripts/ingest-csv.js --manifest manifest.json --csv bars.csv [--db path] [--receipt path|none]');
for (const f of [manifestPath, csvPath]) {
  let st;
  try { st = fs.statSync(f); } catch { fail(`cannot read ${f}`); }
  if (!st.isFile()) fail(`${f} is not a file`);
  if (st.size > MAX_FILE_BYTES) fail(`${f} is ${st.size} bytes; limit is ${MAX_FILE_BYTES} (split the file)`);
}
let manifest;
try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); } catch (e) { fail(`manifest is not valid JSON: ${e.message}`); }
const csv = fs.readFileSync(csvPath);

const db = openDb(typeof opt('db') === 'string' ? opt('db') : undefined);
const t0 = Date.now();
const r = importCsvBars(db, { manifest, csv });
console.log(`${r.status} ds=${r.ds ?? '-'} rows=${r.rows}${r.alreadyImported ? ' (identical re-import; nothing changed)' : ''} (row limit ${MAX_IMPORT_ROWS})`);
for (const e of r.errors) console.log(`  - ${e}`);
const receipt = opt('receipt');
if (receipt !== 'none') {
  const out = writeReceipt(typeof receipt === 'string' ? receipt : null, {
    command: `node scripts/ingest-csv.js --manifest ${path.basename(manifestPath)} --csv ${path.basename(csvPath)}`,
    wall_ms: Date.now() - t0, result: { ok: r.ok, status: r.status, ds: r.ds, rows: r.rows, errors: r.errors }, dataset: datasetReceipt(db, r.ds),
  });
  console.log(`Receipt: ${out}`);
}
process.exit(r.ok ? 0 : 1);
