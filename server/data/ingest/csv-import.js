// User-supplied historical bar import (minute or daily) with a mandatory provenance manifest.
//
// Mere upload does not establish authenticity: every accepted import is stored as dataset kind 'import' with
// status IMPORTED_UNVERIFIED. Imported rows go into m1 under their own dataset id with ALL QUOTE COLUMNS NULL
// (bid/ask/sizes/quote extremes), so the fill engine sees no two-sided quote and marks any order against them
// unfillable — imported bars can be charted and studied, never used to manufacture paper fills.
// Trade count is unknown (0) unless supplied; aggressor volume is unclassified (xv = v).
//
// Timestamp handling:
//   * minute bars: 'bar_start' t = timestamp; 'bar_end' t = timestamp - 60 s. Row knowable at t + 60 s.
//   * daily bars: stored as ONE row in the minute ending 20:00 ET of the bar's date (t = 19:59 ET), so a daily bar
//     only becomes knowable after the extended session ends. It is a daily aggregate, not minute data.
// Any failed hard check rejects the whole file: nothing is stored, and the attempt is recorded under its OWN dataset id
// (import-attempt-<symbol>-<file sha>-<manifest sha>-<time>, status 'failed'), never over an existing import.
//
// Provenance is part of an import's identity. The dataset id is import-<symbol>-<file sha256 prefix>; re-importing the
// same bytes with the same manifest is an idempotent no-op, and re-importing them with a DIFFERENT manifest is refused
// (status ALREADY_IMPORTED) so an accepted import's provider / licence / source URL can never be silently replaced.
import { tx } from '../../db.js';
import { sha256Hex, stableStringify } from '../../util/ids.js';
import { MINUTE, etToUtc, etParts } from '../../util/time.js';
import { SOURCES, recordDataset, stampId } from '../sources.js';

const REQUIRED_MANIFEST = ['provider', 'source_url', 'licence', 'retrieved_at', 'timezone', 'timestamp_semantics', 'symbol', 'fields'];
const OPTIONAL_MANIFEST = ['interval', 'adjustments', 'notes'];
const REQUIRED_FIELDS = ['time', 'open', 'high', 'low', 'close', 'volume'];
const OPTIONAL_FIELDS = ['trades', 'vwap'];
export const MAX_IMPORT_ROWS = 500_000;

/** Validate a manifest. Returns {ok, errors[], manifest} with retrieved_at parsed to retrievedAtMs. */
export function validateManifest(m) {
  const errors = [];
  if (!m || typeof m !== 'object' || Array.isArray(m)) return { ok: false, errors: ['manifest must be an object'] };
  for (const k of Object.keys(m)) if (!REQUIRED_MANIFEST.includes(k) && !OPTIONAL_MANIFEST.includes(k)) errors.push(`unknown manifest key: ${k}`);
  for (const k of REQUIRED_MANIFEST) if (m[k] === undefined || m[k] === null || m[k] === '') errors.push(`manifest.${k} is required`);
  const str = (k, max = 500) => { if (m[k] !== undefined && (typeof m[k] !== 'string' || m[k].length > max)) errors.push(`manifest.${k} must be a string <= ${max} chars`); };
  ['provider', 'licence', 'timezone', 'symbol', 'source_url', 'retrieved_at'].forEach((k) => str(k));
  str('adjustments', 1000); str('notes', 2000);
  let url = null;
  try { url = new URL(m.source_url); } catch { /* reported below */ }
  if (m.source_url && (!url || !/^https?:$/.test(url.protocol))) errors.push('manifest.source_url must be an http(s) URL identifying the original provider');
  const retrievedAtMs = typeof m.retrieved_at === 'string' && /(Z|[+-]\d{2}:?\d{2})$/.test(m.retrieved_at) ? Date.parse(m.retrieved_at) : NaN;
  if (m.retrieved_at && !Number.isFinite(retrievedAtMs)) errors.push('manifest.retrieved_at must be an ISO-8601 timestamp with a UTC offset (e.g. 2026-10-08T21:00:00Z)');
  if (m.timezone) { try { new Intl.DateTimeFormat('en-US', { timeZone: m.timezone }); } catch { errors.push(`manifest.timezone is not a valid IANA time zone: ${m.timezone}`); } }
  if (m.timestamp_semantics && !['bar_start', 'bar_end'].includes(m.timestamp_semantics)) errors.push("manifest.timestamp_semantics must be 'bar_start' or 'bar_end'");
  if (m.symbol && !/^[A-Z][A-Z0-9.\-]{0,9}$/.test(m.symbol)) errors.push('manifest.symbol must be an uppercase ticker');
  const interval = m.interval ?? '1m';
  if (!['1m', '1d'].includes(interval)) errors.push("manifest.interval must be '1m' or '1d'");
  if (m.fields !== undefined) {
    if (!m.fields || typeof m.fields !== 'object' || Array.isArray(m.fields)) errors.push('manifest.fields must map canonical names to CSV column names');
    else {
      for (const f of REQUIRED_FIELDS) if (typeof m.fields[f] !== 'string' || !m.fields[f]) errors.push(`manifest.fields.${f} (CSV column name) is required`);
      for (const k of Object.keys(m.fields)) if (!REQUIRED_FIELDS.includes(k) && !OPTIONAL_FIELDS.includes(k)) errors.push(`unknown manifest.fields key: ${k}`);
    }
  }
  return { ok: errors.length === 0, errors, manifest: { ...m, interval, retrievedAtMs } };
}

/** Minimal RFC 4180 CSV parser (quoted fields, doubled quotes, CRLF). */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let q = false;
  const s = String(text).replace(/^﻿/, '');
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (q) {
      if (ch === '"') { if (s[i + 1] === '"') { field += '"'; i++; } else q = false; } else field += ch;
    } else if (ch === '"' && field === '') q = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && s[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else field += ch;
  }
  if (field !== '' || row.length) { row.push(field); if (row.length > 1 || row[0] !== '') rows.push(row); }
  return rows;
}

/** Wall-clock time in an IANA zone -> ms UTC (two-pass offset correction, DST-safe like etToUtc). */
export function zonedToUtc(y, mo, d, h, mi, s, timeZone) {
  const fmt = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const target = Date.UTC(y, mo - 1, d, h, mi, s);
  let guess = target;
  for (let i = 0; i < 2; i++) {
    const p = Object.fromEntries(fmt.formatToParts(new Date(guess)).map((x) => [x.type, x.value]));
    guess += target - Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  }
  return guess;
}

/** Parse one timestamp cell. Returns {ms, dateOnly} or null. */
export function parseTimestamp(cell, timeZone) {
  const v = String(cell).trim();
  if (/^\d{13}$/.test(v)) return { ms: Number(v), dateOnly: false };
  if (/^\d{10}$/.test(v)) return { ms: Number(v) * 1000, dateOnly: false };
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) {
    const [y, mo, d] = v.split('-').map(Number);
    return { ms: zonedToUtc(y, mo, d, 0, 0, 0, timeZone), dateOnly: true, date: v };
  }
  if (/[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/.test(v)) {
    const ms = Date.parse(v.replace(' ', 'T'));
    return Number.isFinite(ms) ? { ms, dateOnly: false } : null;
  }
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(v);
  if (m) return { ms: zonedToUtc(+m[1], +m[2], +m[3], +m[4], +m[5], +(m[6] || 0), timeZone), dateOnly: false };
  return null;
}

/** Decimal price string -> u (1e-4 USD). Returns {u, rounded} or null when not a positive finite number. */
function priceToU(cell) {
  const x = Number(String(cell).trim());
  if (!Number.isFinite(x) || String(cell).trim() === '') return null;
  const raw = x * 10_000;
  const u = Math.round(raw);
  return { u, rounded: Math.abs(raw - u) > 1e-6 };
}

const ymdEt = (ms) => { const p = etParts(ms); return `${p.y}-${String(p.mo).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`; };

/**
 * Validate and import a CSV of bars.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{manifest:object, csv:string|Buffer, now?:()=>number}} o
 * @returns {{ok:boolean, status:string, ds:string|null, rows:number, errors:string[], quality:object}}
 */
export function importCsvBars(db, { manifest, csv, now = Date.now }) {
  const v = validateManifest(manifest);
  if (!v.ok) return { ok: false, status: 'REJECTED', ds: null, rows: 0, errors: v.errors, quality: null };
  const m = v.manifest;
  const bytes = Buffer.isBuffer(csv) ? csv : Buffer.from(String(csv ?? ''), 'utf8');
  const fileSha = sha256Hex(bytes);
  const manifestSha = sha256Hex(stableStringify(manifest));
  const ds = `import-${m.symbol}-${fileSha.slice(0, 12)}`;
  const nowMs = now();
  const table = parseCsv(bytes.toString('utf8'));
  const errors = [];
  const header = (table[0] || []).map((h) => h.trim());
  const idx = {};
  for (const [canon, colName] of Object.entries(m.fields)) {
    idx[canon] = header.indexOf(colName);
    if (idx[canon] < 0) errors.push(`CSV header has no column "${colName}" (manifest.fields.${canon})`);
  }
  const body = table.slice(1);
  if (!body.length) errors.push('CSV has no data rows');
  if (body.length > MAX_IMPORT_ROWS) errors.push(`CSV has ${body.length} rows; limit is ${MAX_IMPORT_ROWS}`);

  const c = { parse_errors: 0, wrong_field_count: 0, non_positive_price: 0, negative_volume: 0, ohlc_inconsistent: 0, non_monotonic: 0,
    duplicates: 0, future_timestamps: 0, after_retrieved_at: 0, misaligned_minute: 0, rounded_prices: 0, non_integer_volume: 0, zero_volume_rows: 0 };
  const samples = [];
  const note = (k, i, detail) => { c[k]++; if (samples.length < 20) samples.push({ check: k, line: i + 2, detail }); };
  const out = [];
  if (!errors.length) {
    let prevT = null;
    const seenT = new Set();
    body.forEach((cells, i) => {
      if (cells.length !== header.length) { note('wrong_field_count', i, `${cells.length} fields`); return; }
      const ts = parseTimestamp(cells[idx.time], m.timezone);
      const P = ['open', 'high', 'low', 'close'].map((k) => priceToU(cells[idx[k]]));
      const volRaw = Number(String(cells[idx.volume]).trim());
      if (!ts || P.some((p) => p === null) || !Number.isFinite(volRaw) || String(cells[idx.volume]).trim() === '') { note('parse_errors', i, cells.join(',').slice(0, 120)); return; }
      let t;
      if (m.interval === '1m') {
        if (ts.dateOnly) { note('parse_errors', i, 'date-only timestamp in a minute-bar file'); return; }
        t = m.timestamp_semantics === 'bar_end' ? ts.ms - MINUTE : ts.ms;
        if (t % MINUTE !== 0) { note('misaligned_minute', i, new Date(t).toISOString()); return; }
      } else {
        const date = ts.dateOnly ? ts.date : ymdEt(m.timestamp_semantics === 'bar_end' ? ts.ms - 1 : ts.ms);
        t = etToUtc(date, 19, 59);
      }
      const [o, h, l, cl] = P.map((p) => p.u);
      if (P.some((p) => p.rounded)) c.rounded_prices++;
      if ([o, h, l, cl].some((x) => x <= 0)) { note('non_positive_price', i, `${o},${h},${l},${cl}`); return; }
      if (volRaw < 0) { note('negative_volume', i, String(volRaw)); return; }
      if (!Number.isInteger(volRaw)) c.non_integer_volume++;
      if (volRaw === 0) c.zero_volume_rows++;
      if (h < Math.max(o, cl, l) || l > Math.min(o, cl, h)) { note('ohlc_inconsistent', i, `o=${o} h=${h} l=${l} c=${cl}`); return; }
      const knowable = t + MINUTE;
      if (knowable > nowMs) { note('future_timestamps', i, new Date(t).toISOString()); return; }
      if (knowable > m.retrievedAtMs) { note('after_retrieved_at', i, `bar knowable ${new Date(knowable).toISOString()} after retrieved_at`); return; }
      if (seenT.has(t)) { note('duplicates', i, new Date(t).toISOString()); return; }
      if (prevT !== null && t < prevT) { note('non_monotonic', i, new Date(t).toISOString()); return; }
      seenT.add(t);
      prevT = t;
      const n = idx.trades >= 0 && idx.trades !== undefined ? Math.max(0, Math.trunc(Number(cells[idx.trades]) || 0)) : 0;
      const vw = idx.vwap >= 0 && idx.vwap !== undefined ? priceToU(cells[idx.vwap]) : null;
      const vol = Math.round(volRaw);
      out.push({ t, o, h, l, c: cl, v: vol, n, pv: vw && vw.u > 0 ? vw.u * vol : 0 });
    });
  }
  const hard = ['parse_errors', 'wrong_field_count', 'non_positive_price', 'negative_volume', 'ohlc_inconsistent', 'non_monotonic', 'duplicates', 'future_timestamps', 'after_retrieved_at', 'misaligned_minute'];
  for (const k of hard) if (c[k] > 0) errors.push(`${c[k]} row(s) failed check ${k}`);
  const quality = {
    checks: c, check_samples: samples, hard_checks: hard, rows_in_file: body.length, rows_stored: errors.length ? 0 : out.length,
    file_sha256: fileSha, manifest_sha256: manifestSha, manifest: { ...manifest },
    interval: m.interval, timestamp_semantics: m.timestamp_semantics, timezone: m.timezone,
    quote_columns: 'NULL — no quotes imported; orders against this dataset are unfillable by the fill engine',
    authenticity: 'IMPORTED_UNVERIFIED — provenance declared by the importer, not verified by VECTOR',
  };
  const meta = SOURCES['csv-import'];
  const base = {
    id: ds, kind: 'import', provider: `${m.provider} (user-supplied import, unverified)`,
    venue_coverage: `As declared by importer; venue coverage unknown. Symbol ${m.symbol}, ${m.interval === '1d' ? 'daily' : 'minute'} bars, no quotes.`,
    entitlement: `Declared licence: ${m.licence}`, source_url: m.source_url, source_id: `manifest:${manifestSha.slice(0, 16)}`,
    ingested_at: nowMs, published_at: null, latency_note: `Retrieved by importer at ${m.retrieved_at} (declared).`,
    adjustments: m.adjustments ? `Declared: ${m.adjustments}` : 'Not declared (assume unknown adjustment state).',
    sha256: fileSha, bytes: bytes.length, attribution: `As declared: ${m.provider} — ${m.source_url}`,
  };
  const existing = db.prepare('SELECT status, source_id FROM datasets WHERE id = ?').get(ds);
  if (errors.length) {
    const stem = `import-attempt-${m.symbol}-${fileSha.slice(0, 12)}-${manifestSha.slice(0, 12)}-${stampId(nowMs)}`;
    let n = 1;
    while (db.prepare('SELECT 1 FROM datasets WHERE id = ?').get(n === 1 ? stem : `${stem}-${n}`)) n++;
    const attempt = n === 1 ? stem : `${stem}-${n}`;
    recordDataset(db, {
      ...base, id: attempt, status: 'failed', quality: { ...quality, errors, rows_stored: 0, existing_dataset: existing ? ds : null },
      notes: `Import REJECTED: ${errors.join('; ')}${existing ? ` (existing dataset ${ds} left unchanged)` : ''}`,
    }, { replace: false });
    return { ok: false, status: 'REJECTED', ds: attempt, rows: 0, errors, quality };
  }
  if (existing && existing.status === 'IMPORTED_UNVERIFIED') {
    if (existing.source_id === base.source_id) {
      const rows = db.prepare('SELECT COUNT(*) n FROM m1 WHERE ds = ?').get(ds).n;
      return { ok: true, status: 'IMPORTED_UNVERIFIED', ds, rows, errors: [], quality, alreadyImported: true,
        note: 'Same file and manifest already imported; nothing changed.' };
    }
    const msg = `These exact bytes were already imported as ${ds} with a different manifest (${existing.source_id}); `
      + 'the recorded provenance is not replaced. Correct the manifest of the original import out of band, or import different bytes.';
    return { ok: false, status: 'ALREADY_IMPORTED', ds, rows: 0, errors: [msg], quality };
  }
  const dates = new Set(out.map((r) => ymdEt(r.t)));
  tx(db, () => {
    db.prepare('DELETE FROM m1 WHERE ds = ?').run(ds);
    const ins = db.prepare(`INSERT INTO m1 (ds, sym, t, o, h, l, c, v, n, pv, bv, sv, xv, ev, ov, bid, ask, bsz, asz, qts, min_bid, max_bid, min_ask, max_ask, max_spr, nq, unavail, halted, qsess)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, 0, 0, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 0, 0, 0, 0)`);
    for (const r of out) ins.run(ds, m.symbol, r.t, r.o, r.h, r.l, r.c, r.v, r.n, r.pv, r.v);
    recordDataset(db, {
      ...base, status: 'IMPORTED_UNVERIFIED', trade_date: dates.size === 1 ? [...dates][0] : null,
      event_time_start: out[0].t, event_time_end: out.at(-1).t + MINUTE, quality,
      notes: `${meta.name}: IMPORTED_UNVERIFIED — mere upload does not establish authenticity. Quote columns are NULL, so the fill engine marks orders unfillable (no two-sided quote). `
        + `Trade count ${m.fields.trades ? 'from file' : 'unknown (stored 0)'}; aggressor volume unclassified. ${m.interval === '1d' ? 'Daily bars stored at the minute ending 20:00 ET (knowable after the extended session).' : ''}`,
    });
  });
  return { ok: true, status: 'IMPORTED_UNVERIFIED', ds, rows: out.length, errors: [], quality };
}
