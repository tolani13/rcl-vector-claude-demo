#!/usr/bin/env node
// Usage:
//   npm run ingest:iex -- --date 2026-10-07            # stream the official IEX HIST TOPS file for that day
//   npm run ingest:iex -- --date 2026-10-07 --file x.pcap.gz [--partial]   # local copy (e.g. a truncated sample)
// Writes a receipt JSON to receipts/ingest-iex-<date>.json.
import fs from 'node:fs';
import path from 'node:path';
import { openDb } from '../server/db.js';
import { ingestIexTops } from '../server/data/ingest/iex-tops.js';

const args = process.argv.slice(2);
const opt = (k, d = null) => { const i = args.indexOf(`--${k}`); return i >= 0 ? (args[i + 1] ?? true) : d; };
const date = opt('date');
if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
  console.error('Usage: npm run ingest:iex -- --date YYYY-MM-DD [--file path.pcap.gz] [--partial] [--db path]');
  process.exit(2);
}
const db = openDb(opt('db') || undefined);
const t0 = Date.now();
const res = await ingestIexTops({
  db, date, file: opt('file') || undefined, allowPartial: args.includes('--partial'),
  onProgress: (p) => {
    if (p.phase === 'retry') { console.log(`[retry ${p.attempt}] at ${p.received} bytes: ${p.error}`); return; }
    const pct = p.expectedBytes ? ` ${(100 * p.compressedBytes / p.expectedBytes).toFixed(1)}%` : '';
    const et = p.exchangeTime ? new Date(p.exchangeTime).toISOString().slice(11, 19) + 'Z' : '-';
    console.log(`[${Math.round((Date.now() - t0) / 1000)}s]${pct} ${(p.compressedBytes / 1e9).toFixed(2)} GB @ ${p.mbps.toFixed(1)} MB/s | exch ${et} | rows ${p.rowsWritten} | symbols ${p.symbols}`);
  },
});
const receiptDir = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..', 'receipts');
fs.mkdirSync(receiptDir, { recursive: true });
const ds = db.prepare('SELECT * FROM datasets WHERE id = ?').get(res.ds);
const receipt = { ...ds, quality: JSON.parse(ds.quality_json) };
delete receipt.quality_json;
const out = path.join(receiptDir, `ingest-${res.ds}.json`);
fs.writeFileSync(out, JSON.stringify(receipt, null, 2));
console.log(`Done: ${res.ds} status=${res.status} rows=${res.quality.rows_retained} symbols=${res.quality.symbols_stored} sha256=${ds.sha256}`);
console.log(`Receipt: ${out}`);
