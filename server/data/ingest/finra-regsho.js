// FINRA Reg SHO daily short-sale volume (consolidated NMS file CNMSshvol{YYYYMMDD}.txt).
//
// What it is: short-sale volume in trades REPORTED TO FINRA facilities (TRF / ADF / ORF), i.e. OFF-EXCHANGE
// executions only. It is NOT consolidated volume, NOT exchange short volume and NOT short interest. TotalVolume
// is the FINRA-reported total for the same facilities, so ShortVolume/TotalVolume is a facility-specific ratio.
//
// Knowability (ASSUMPTION, documented): FINRA posts the daily file in the evening of the trade date. VECTOR treats
// a row as knowable from 18:00 America/New_York on its trade date; earlier as-of reads never see it.
import { tx } from '../../db.js';
import { sha256Hex } from '../../util/ids.js';
import { etToUtc } from '../../util/time.js';
import { SOURCES, recordDataset, fetchBytes } from '../sources.js';

export const FINRA_BASE = 'https://cdn.finra.org/equity/regsho/daily';
export const FINRA_KNOWABLE_ET = { h: 18, m: 0 };
export const FINRA_SCOPE_NOTE = 'FINRA-reported off-exchange (TRF/ADF/ORF) volume only — not consolidated volume, not exchange short volume, not short interest. '
  + 'Knowable-time ASSUMPTION: 18:00 ET on the trade date.';

/** ms UTC at which a row for trade date `date` (YYYY-MM-DD) is treated as knowable. */
export function finraKnowableTs(date) {
  return etToUtc(date, FINRA_KNOWABLE_ET.h, FINRA_KNOWABLE_ET.m);
}

/**
 * Weekday trading dates: the `n` weekdays strictly before `date`, then `date` itself (ascending).
 * Exchange holidays are not modelled; a holiday shows up as a missing file (HTTP 403/404) and is recorded as such.
 */
export function tradingDatesBefore(date, n = 5) {
  const out = [date];
  let d = new Date(date + 'T12:00:00Z');
  while (out.length < n + 1) {
    d = new Date(d.getTime() - 86_400_000);
    const wd = d.getUTCDay();
    if (wd !== 0 && wd !== 6) out.unshift(d.toISOString().slice(0, 10));
  }
  return out;
}

/** Parse a CNMSshvol file. Returns rows and structural checks. */
export function parseRegSho(text, expectedDate) {
  const lines = String(text).replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.trim() !== '');
  const header = (lines[0] || '').split('|').map((s) => s.trim());
  const want = ['Date', 'Symbol', 'ShortVolume', 'ShortExemptVolume', 'TotalVolume', 'Market'];
  const headerOk = want.every((w, i) => header[i] === w);
  const compact = expectedDate.replaceAll('-', '');
  const rows = [];
  const seen = new Set();
  const issues = { wrong_date: 0, bad_number: 0, short_gt_total: 0, negative: 0, duplicates: 0, non_data_lines: 0 };
  for (const line of lines.slice(1)) {
    const f = line.split('|');
    if (f.length !== 6) { issues.non_data_lines++; continue; }
    const [d, sym, sv, sev, tv, mkts] = f.map((s) => s.trim());
    if (d !== compact) { issues.wrong_date++; continue; }
    const short = Number(sv);
    const exempt = Number(sev);
    const total = Number(tv);
    if (![short, exempt, total].every(Number.isFinite) || sv === '' || tv === '') { issues.bad_number++; continue; }
    if (short < 0 || exempt < 0 || total < 0) { issues.negative++; continue; }
    if (short > total) issues.short_gt_total++;
    if (seen.has(sym)) { issues.duplicates++; continue; }
    seen.add(sym);
    rows.push({ date: expectedDate, sym, short_vol: short, short_exempt_vol: exempt, total_vol: total, markets: mkts || null });
  }
  return { rows, checks: { header_ok: headerOk, header, data_lines: lines.length - 1, rows_parsed: rows.length, ...issues } };
}

/**
 * Ingest one trade date. Writes one datasets row (kind 'short_volume') whether or not the file was available.
 * Existing rows for the date are replaced only when the new file passes checks.
 */
export async function ingestRegShoDate({ db, date, baseUrl = FINRA_BASE, fetchImpl, now = Date.now } = {}) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) throw new Error('date must be YYYY-MM-DD');
  const url = `${baseUrl}/CNMSshvol${date.replaceAll('-', '')}.txt`;
  const ds = `finra-regsho-cnms-${date}`;
  const r = await fetchBytes(url, { fetchImpl });
  const quality = { url, http_status: r.status, bytes: r.bytes.length, sha256: r.sha256, error: r.error };
  let status = 'failed';
  let rowsStored = 0;
  let notes;
  if (r.ok) {
    const p = parseRegSho(r.bytes.toString('latin1'), date);
    Object.assign(quality, p.checks);
    const ok = p.checks.header_ok && p.checks.rows_parsed > 0 && p.checks.wrong_date === 0 && p.checks.bad_number === 0 && p.checks.duplicates === 0;
    if (ok) {
      tx(db, () => {
        db.prepare('DELETE FROM short_volume WHERE date = ?').run(date);
        const ins = db.prepare('INSERT INTO short_volume (date, sym, short_vol, short_exempt_vol, total_vol, markets, ds) VALUES (?, ?, ?, ?, ?, ?, ?)');
        for (const x of p.rows) ins.run(x.date, x.sym, x.short_vol, x.short_exempt_vol, x.total_vol, x.markets, ds);
      });
      rowsStored = p.rows.length;
      status = 'complete';
      notes = FINRA_SCOPE_NOTE;
    } else notes = `File failed checks; nothing stored. ${FINRA_SCOPE_NOTE}`;
  } else {
    notes = `File not retrieved (${r.error}). A 403/404 usually means a non-trading day or a file not yet published. ${FINRA_SCOPE_NOTE}`;
  }
  quality.rows_stored = rowsStored;
  quality.short_gt_total_note = 'short_gt_total counts rows where ShortVolume > TotalVolume (kept, flagged).';
  const meta = SOURCES['finra-regsho'];
  const knowable = finraKnowableTs(date);
  recordDataset(db, {
    id: ds, kind: 'short_volume', provider: meta.provider, venue_coverage: meta.coverage, entitlement: meta.entitlement,
    source_url: url, source_id: `CNMSshvol${date.replaceAll('-', '')}`, trade_date: date,
    event_time_start: etToUtc(date, 0, 0), event_time_end: etToUtc(date, 20, 0), published_at: knowable, ingested_at: now(),
    latency_note: 'Assumed knowable from 18:00 ET on the trade date (FINRA evening publication; assumption, not a published SLA).',
    adjustments: 'None (raw FINRA values; volumes may be fractional).',
    sha256: r.ok ? sha256Hex(r.bytes) : null, bytes: r.bytes.length, status, quality, attribution: meta.attribution, notes,
  });
  return { ds, date, status, rowsStored, quality };
}

export async function ingestRegSho({ db, dates, baseUrl = FINRA_BASE, fetchImpl, now } = {}) {
  const results = [];
  for (const date of dates) results.push(await ingestRegShoDate({ db, date, baseUrl, fetchImpl, now }));
  return results;
}

/** As-of gated short volume rows for a symbol (newest first). */
export function shortVolumeAsOf(db, sym, asOf, { limit = 20 } = {}) {
  if (!Number.isFinite(asOf)) throw new TypeError('asOf (ms UTC) is required');
  const rows = db.prepare('SELECT date, sym, short_vol, short_exempt_vol, total_vol, markets, ds FROM short_volume WHERE sym = ? ORDER BY date DESC LIMIT 400').all(sym);
  return rows
    .map((r) => ({ ...r, knowable_ts: finraKnowableTs(r.date), shortRatio: r.total_vol > 0 ? r.short_vol / r.total_vol : null }))
    .filter((r) => r.knowable_ts <= asOf)
    .slice(0, limit);
}
