// Nasdaq Trader Symbol Directory ingestion (nasdaqlisted.txt + otherlisted.txt; pipe-delimited, footer line
// "File Creation Time: MMDDYYYYHH:MM").
//
// IMPORTANT: the directory is a CURRENT snapshot as of the fetch. For a replay of an earlier date it is
// post-dated: names, listing exchange, ETF flag and especially Financial Status (deficient / delinquent /
// bankrupt) describe the security at fetch time, not at the replay instant, and symbols delisted since the replay
// date are absent (survivorship). Consumers must not use these temporal fields as as-of evidence; the dossier
// marks them post-dated.
import { tx } from '../../db.js';
import { sha256Hex } from '../../util/ids.js';
import { etToUtc } from '../../util/time.js';
import { SOURCES, recordDataset, fetchBytes, stampId } from '../sources.js';

export const SYMDIR_BASE = 'https://www.nasdaqtrader.com/dynamic/SymDir';

// Code meanings per the Nasdaq Trader Symbol Directory definitions page.
export const MARKET_CATEGORY = Object.freeze({
  Q: 'NASDAQ Global Select Market', G: 'NASDAQ Global Market', S: 'NASDAQ Capital Market',
});
export const FINANCIAL_STATUS = Object.freeze({
  N: 'Normal (default): issuer is NOT deficient, delinquent, or bankrupt',
  D: 'Deficient: issuer failed to meet NASDAQ continued listing requirements',
  E: 'Delinquent: issuer missed a regulatory filing deadline',
  Q: 'Bankrupt: issuer has filed for bankruptcy',
  G: 'Deficient and Bankrupt',
  H: 'Deficient and Delinquent',
  J: 'Delinquent and Bankrupt',
  K: 'Deficient, Delinquent, and Bankrupt',
});
export const OTHER_EXCHANGE = Object.freeze({
  A: 'NYSE American', N: 'NYSE', P: 'NYSE Arca', Z: 'Cboe BZX', V: 'IEX',
});

export const SYMDIR_POSTDATED_NOTE = 'CURRENT directory as of its File Creation Time; for any replay instant before that time it is POST-DATED. '
  + 'Temporal fields (financial_status, ETF flag, name, exchange, round lot) describe the security at fetch time and must NOT be used as as-of evidence for earlier instants. '
  + 'Securities delisted between the replay date and the fetch are absent (survivorship bias).';

/** Parse "File Creation Time: MMDDYYYYHH:MM" (Eastern time assumed) -> {raw, ms}. */
export function parseFileCreationTime(raw) {
  const m = /(\d{2})(\d{2})(\d{4})(\d{2}):(\d{2})/.exec(String(raw || ''));
  if (!m) return { raw: raw ?? null, ms: null };
  const [, mo, d, y, h, mi] = m;
  return { raw: `${mo}${d}${y}${h}:${mi}`, ms: etToUtc(`${y}-${mo}-${d}`, +h, +mi), iso_et: `${y}-${mo}-${d} ${h}:${mi} ET` };
}

/**
 * Parse one directory file. kind: 'nasdaq' (nasdaqlisted.txt) | 'other' (otherlisted.txt).
 * @returns {{rows:object[], checks:object, fileCreationTime:{raw, ms}}}
 */
export function parseSymDir(text, kind) {
  const lines = String(text).replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.trim() !== '');
  const header = (lines[0] || '').split('|').map((s) => s.trim());
  const col = (name) => header.indexOf(name);
  const symCol = kind === 'nasdaq' ? col('Symbol') : col('ACT Symbol');
  const need = kind === 'nasdaq'
    ? ['Symbol', 'Security Name', 'Market Category', 'Test Issue', 'Financial Status', 'Round Lot Size', 'ETF']
    : ['ACT Symbol', 'Security Name', 'Exchange', 'ETF', 'Round Lot Size', 'Test Issue'];
  const missingCols = need.filter((n) => col(n) < 0);
  const footerIdx = lines.findIndex((l) => l.startsWith('File Creation Time'));
  const fct = footerIdx >= 0 ? parseFileCreationTime(lines[footerIdx].split('|')[0].replace('File Creation Time:', '').trim()) : { raw: null, ms: null };
  const body = lines.slice(1, footerIdx >= 0 ? footerIdx : undefined);
  const rows = [];
  const seen = new Set();
  const issues = { wrong_field_count: 0, bad_symbol: 0, duplicates: 0, bad_yn: 0, unknown_codes: 0, bad_round_lot: 0 };
  const unknownCodes = new Set();
  const yn = (v) => (v === 'Y' ? 1 : v === 'N' ? 0 : null);
  if (!missingCols.length) {
    for (const line of body) {
      const f = line.split('|');
      if (f.length !== header.length) { issues.wrong_field_count++; continue; }
      const sym = f[symCol].trim();
      if (!/^[A-Z0-9.$\-+=^#*/]{1,12}$/.test(sym)) { issues.bad_symbol++; continue; }
      if (seen.has(sym)) { issues.duplicates++; continue; }
      seen.add(sym);
      const test = yn(f[col('Test Issue')].trim());
      const etf = yn(f[col('ETF')].trim());
      if (test === null || (etf === null && f[col('ETF')].trim() !== '')) issues.bad_yn++;
      const rl = Number(f[col('Round Lot Size')].trim());
      if (!Number.isInteger(rl) || rl <= 0) issues.bad_round_lot++;
      let exchange;
      let marketCategory = null;
      let financialStatus = null;
      if (kind === 'nasdaq') {
        exchange = 'NASDAQ';
        marketCategory = f[col('Market Category')].trim() || null;
        financialStatus = f[col('Financial Status')].trim() || null;
        if (marketCategory && !MARKET_CATEGORY[marketCategory]) { issues.unknown_codes++; unknownCodes.add(`category:${marketCategory}`); }
        if (financialStatus && !FINANCIAL_STATUS[financialStatus]) { issues.unknown_codes++; unknownCodes.add(`status:${financialStatus}`); }
      } else {
        const code = f[col('Exchange')].trim();
        exchange = OTHER_EXCHANGE[code] || `UNKNOWN(${code})`;
        if (!OTHER_EXCHANGE[code]) { issues.unknown_codes++; unknownCodes.add(`exchange:${code}`); }
      }
      rows.push({
        sym, name: f[col('Security Name')].trim(), exchange, market_category: marketCategory, financial_status: financialStatus,
        test_issue: test, etf, round_lot: Number.isInteger(rl) && rl > 0 ? rl : null, file_creation_time: fct.raw,
      });
    }
  }
  return {
    rows, fileCreationTime: fct,
    checks: {
      header_ok: missingCols.length === 0, missing_columns: missingCols, footer_present: footerIdx >= 0, footer_parsed: fct.ms !== null,
      file_creation_time_raw: fct.raw, file_creation_time_et: fct.iso_et ?? null, data_lines: body.length, rows_parsed: rows.length,
      ...issues, unknown_code_samples: [...unknownCodes].slice(0, 10),
    },
  };
}

/**
 * Fetch both directory files and store ref_symbols under one dataset (kind 'symbol_directory').
 * The batch is stored only if both files pass the structural checks.
 */
export async function ingestSymDir({ db, baseUrl = SYMDIR_BASE, fetchImpl, now = Date.now } = {}) {
  const ingestedAt = now();
  const ds = `nasdaq-symdir-${stampId(ingestedAt)}`;
  const files = { nasdaq: 'nasdaqlisted.txt', other: 'otherlisted.txt' };
  const quality = { files: {} };
  const parsed = {};
  const bytes = [];
  for (const [kind, name] of Object.entries(files)) {
    const url = `${baseUrl}/${name}`;
    const r = await fetchBytes(url, { fetchImpl });
    const q = { url, http_status: r.status, bytes: r.bytes.length, sha256: r.sha256, error: r.error };
    if (r.ok) {
      bytes.push(r.bytes);
      const p = parseSymDir(r.bytes.toString('latin1'), kind);
      Object.assign(q, p.checks);
      q.ok = p.checks.header_ok && p.checks.footer_present && p.checks.wrong_field_count === 0 && p.checks.rows_parsed > 0 && p.checks.duplicates === 0;
      parsed[kind] = p;
    } else q.ok = false;
    quality.files[name] = q;
  }
  const allOk = Object.values(quality.files).every((f) => f.ok);
  // A symbol present in both files would violate the (ds, sym) key; count it rather than silently overwrite.
  let crossDup = 0;
  let rowsStored = 0;
  if (allOk) {
    const seen = new Set(parsed.nasdaq.rows.map((r) => r.sym));
    tx(db, () => {
      const ins = db.prepare(`INSERT INTO ref_symbols (ds, sym, name, exchange, market_category, financial_status, test_issue, etf, round_lot, file_creation_time)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      for (const r of parsed.nasdaq.rows) { ins.run(ds, r.sym, r.name, r.exchange, r.market_category, r.financial_status, r.test_issue, r.etf, r.round_lot, r.file_creation_time); rowsStored++; }
      for (const r of parsed.other.rows) {
        if (seen.has(r.sym)) { crossDup++; continue; }
        ins.run(ds, r.sym, r.name, r.exchange, r.market_category, r.financial_status, r.test_issue, r.etf, r.round_lot, r.file_creation_time);
        rowsStored++;
      }
    });
  }
  const fctMs = [parsed.nasdaq?.fileCreationTime.ms, parsed.other?.fileCreationTime.ms].filter((x) => x != null);
  quality.cross_file_duplicates_skipped = crossDup;
  quality.rows_stored = rowsStored;
  quality.sha256_basis = 'sha256 over nasdaqlisted.txt bytes followed by otherlisted.txt bytes; per-file sha256 under files';
  const status = allOk ? 'complete' : 'failed';
  const meta = SOURCES['nasdaq-symdir'];
  recordDataset(db, {
    id: ds, kind: 'symbol_directory', provider: meta.provider, venue_coverage: meta.coverage, entitlement: meta.entitlement,
    source_url: `${baseUrl}/{nasdaqlisted.txt,otherlisted.txt}`, source_id: 'SymDir',
    event_time_start: fctMs.length ? Math.min(...fctMs) : null, event_time_end: fctMs.length ? Math.max(...fctMs) : null,
    published_at: fctMs.length ? Math.max(...fctMs) : null, ingested_at: ingestedAt,
    latency_note: 'Snapshot published by Nasdaq Trader (File Creation Time in footer, Eastern time assumed); reflects the directory at that instant only.',
    adjustments: 'None. Codes stored raw (market_category, financial_status); exchange decoded from the otherlisted Exchange code.',
    sha256: bytes.length ? sha256Hex(Buffer.concat(bytes)) : null, bytes: bytes.reduce((s, b) => s + b.length, 0),
    status, quality, attribution: meta.attribution,
    notes: allOk ? SYMDIR_POSTDATED_NOTE : `Ingestion failed checks; nothing stored. ${SYMDIR_POSTDATED_NOTE}`,
  });
  return { ds, status, rowsStored, quality };
}

/**
 * IEX symbology -> Nasdaq Trader ACT symbology (otherlisted.txt "ACT Symbol"): warrant '+' -> '.W', right '^' -> '.R',
 * unit '=' -> '.U', preferred '-X' -> '$X'. Returns null when the symbol has no IEX-specific suffix.
 * (Verified against the stored directory: e.g. IEX BBAI+ = ACT BBAI.W, IEX AHT-F = ACT AHT$F, IEX OCAC^ = ACT OCAC.R.)
 */
export function iexToActSymbol(sym) {
  const s = String(sym || '');
  const out = s.replace(/\+$/, '.W').replace(/\^$/, '.R').replace(/=$/, '.U').replace(/-([A-Z0-9]*)$/, '$$$1');
  return out !== s ? out : null;
}

// ---- security type (identity metadata from the directory name; heuristic) -----------------------------------------
// Ordered patterns; the EARLIEST match in the security descriptor wins (ties: the longer match), so
// "Units, each consisting of one share and one-half of one warrant" is a unit and "Common Units" of an LP is common.
const TYPE_PATTERNS = [
  ['adr', /american depositary|\bADSs?\b|\bADRs?\b/i],
  ['common', /partnership units?|units? of beneficial interest|beneficial unit|depositary units?|common units?/i],
  ['unit', /\bunits?\b/i],
  ['warrant', /\bwarrants?\b/i],
  ['right', /\brights?\b/i],
  ['preferred', /preferred|preference shares?|\bcumulative\b|\bperpetual\b/i],
  ['debt', /\b(senior |subordinated )?notes?\b|\bdebentures?\b|\bbonds? due\b/i],
  ['common', /\bcommon\b|\bordinary\b|\bclass [a-z]\b|\bshares?\b|\bstock\b/i],
];
/** Types that are not common-equity-like; the scanner ranks them after common stock by default (never hides them). */
export const NON_COMMON_TYPES = Object.freeze(new Set(['etf', 'preferred', 'warrant', 'right', 'unit', 'debt', 'other']));

/**
 * Security type for a symbol: common | adr | etf | preferred | warrant | right | unit | debt | other | unknown.
 * Basis: directory ETF flag, else a heuristic on the directory security name (the descriptor after the last " - " when
 * present), else the IEX symbol suffix. The directory is a post-dated snapshot; callers label it as such.
 * @param {{sym:string, name?:string|null, etf?:number|boolean|null}} r
 */
export function classifySecurity({ sym, name = null, etf = null }) {
  if (etf === 1 || etf === true) return { type: 'etf', basis: 'directory ETF flag' };
  if (name) {
    const parts = String(name).split(' - ');
    const desc = parts.length > 1 ? parts.slice(1).join(' - ') : String(name);
    if (/\bETFs?\b|\bETNs?\b|exchange[- ]traded/i.test(desc)) return { type: 'etf', basis: 'directory name heuristic' };
    let best = null;
    for (const [type, re] of TYPE_PATTERNS) {
      const m = re.exec(desc);
      if (m && (!best || m.index < best.index || (m.index === best.index && m[0].length > best.len))) best = { type, index: m.index, len: m[0].length };
    }
    return { type: best ? best.type : 'unknown', basis: 'directory name heuristic' };
  }
  const s = String(sym || '');
  if (/\+$/.test(s)) return { type: 'warrant', basis: 'IEX symbol suffix' };
  if (/\^$/.test(s)) return { type: 'right', basis: 'IEX symbol suffix' };
  if (/=$/.test(s)) return { type: 'unit', basis: 'IEX symbol suffix' };
  if (/-[A-Z0-9]*$/.test(s)) return { type: 'preferred', basis: 'IEX symbol suffix' };
  if (/#$/.test(s)) return { type: 'other', basis: 'IEX symbol suffix (when-issued)' };
  return { type: 'unknown', basis: 'not in the stored directory' };
}

/**
 * Latest stored directory row for a symbol (identity lookup; post-dated relative to any earlier replay). Tries the
 * symbol as given, then its ACT spelling (iexToActSymbol); `matchedAs` records which one matched.
 */
export function latestRefSymbol(db, sym) {
  const q = db.prepare(`SELECT r.*, d.ingested_at, d.published_at FROM ref_symbols r JOIN datasets d ON d.id = r.ds
    WHERE r.sym = ? AND d.kind = 'symbol_directory' AND d.status = 'complete' ORDER BY d.ingested_at DESC LIMIT 1`);
  const exact = q.get(sym);
  if (exact) return { ...exact, matchedAs: sym };
  const act = iexToActSymbol(sym);
  const mapped = act ? q.get(act) : null;
  return mapped ? { ...mapped, matchedAs: act } : null;
}

/** Id of the newest complete directory dataset, or null. */
export function latestSymDirDataset(db) {
  const r = db.prepare(`SELECT id FROM datasets WHERE kind = 'symbol_directory' AND status = 'complete' ORDER BY ingested_at DESC LIMIT 1`).get();
  return r ? r.id : null;
}

/**
 * Newest complete directory snapshot with its publication time: {ds, publishedMs, fileCreationEt, ingestedAt}.
 * publishedMs is the file creation time from the footer (datasets.published_at), else the ingest time.
 */
export function latestSymDirSnapshot(db) {
  const r = db.prepare(`SELECT d.id, d.published_at, d.ingested_at, (SELECT file_creation_time FROM ref_symbols WHERE ds = d.id LIMIT 1) fct
    FROM datasets d WHERE d.kind = 'symbol_directory' AND d.status = 'complete' ORDER BY d.ingested_at DESC LIMIT 1`).get();
  if (!r) return null;
  const fct = parseFileCreationTime(r.fct);
  return { ds: r.id, publishedMs: r.published_at ?? fct.ms ?? r.ingested_at, fileCreationEt: fct.iso_et ?? null, ingestedAt: r.ingested_at };
}
