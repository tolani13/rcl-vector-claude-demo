// FRED macro-series ingestion (fredgraph.csv, no API key).
//
// Values are the LATEST VINTAGE published by FRED at fetch time. Past observations may have been revised after
// they were first published (mainly CPIAUCSL / UNRATE / FEDFUNDS / DTWEXBGS); ALFRED real-time vintages are NOT
// ingested, so marketdata.macroAsOf withholds those revisable series whenever a revision could fall between the replay
// clock and the fetch (macroCalendar.vintageStatus).
//
// Knowability is NOT "observation date + N days" for every series: observation frequency is not release cadence.
// DCOILWTICO (EIA spot prices) and DTWEXBGS (Fed H.10) have daily observations but are PUBLISHED WEEKLY, and the H.15
// rates are posted the next business day. Each observation is gated by its series release rule in
// server/data/macroCalendar.js (macroKnowableTs). publication_lag_days is stored as a LOWER BOUND (the shortest
// possible lag) so legacy consumers that recompute "date + lag" never get a time later than the real gate.
//
// Series definitions below are configuration (ids, descriptive labels, units, lags, release cadence) — not observations.
import { tx } from '../../db.js';
import { sha256Hex } from '../../util/ids.js';
import { SOURCES, recordDataset, fetchBytes, stampId } from '../sources.js';
import { macroReleaseRule } from '../macroCalendar.js';

export const FRED_BASE = 'https://fred.stlouisfed.org/graph/fredgraph.csv';

// lag = publication_lag_days, a LOWER BOUND in calendar days; the gate is the release rule (macroCalendar.js).
export const FRED_SERIES = Object.freeze([
  { id: 'DGS10', title: '10-year U.S. Treasury constant-maturity yield', units: 'Percent', frequency: 'Daily (H.15, posted next business day)', lag: 1, source: 'Board of Governors of the Federal Reserve System (H.15)' },
  { id: 'DGS2', title: '2-year U.S. Treasury constant-maturity yield', units: 'Percent', frequency: 'Daily (H.15, posted next business day)', lag: 1, source: 'Board of Governors of the Federal Reserve System (H.15)' },
  { id: 'T10Y2Y', title: '10-year minus 2-year Treasury constant-maturity spread', units: 'Percent', frequency: 'Daily (derived from H.15, posted next business day)', lag: 1, source: 'Federal Reserve Bank of St. Louis (derived from H.15)' },
  { id: 'VIXCLS', title: 'Cboe Volatility Index (VIX), daily close', units: 'Index', frequency: 'Daily', lag: 2, source: 'Chicago Board Options Exchange (copyrighted)' },
  { id: 'SP500', title: 'S&P 500 index level, daily close', units: 'Index level (not a total return)', frequency: 'Daily', lag: 2, source: 'S&P Dow Jones Indices LLC (licensed; FRED shows limited history)' },
  { id: 'DCOILWTICO', title: 'WTI crude oil spot price, Cushing OK', units: 'U.S. dollars per barrel', frequency: 'Daily observations, released weekly (EIA, Wednesdays)', lag: 2, source: 'U.S. Energy Information Administration' },
  { id: 'DTWEXBGS', title: 'Nominal broad U.S. dollar index', units: 'Index (Jan 2006 = 100)', frequency: 'Daily observations, released weekly (Fed H.10, Mondays)', lag: 3, source: 'Board of Governors of the Federal Reserve System (H.10)' },
  { id: 'FEDFUNDS', title: 'Effective federal funds rate, monthly average', units: 'Percent', frequency: 'Monthly', lag: 33, source: 'Board of Governors of the Federal Reserve System' },
  { id: 'CPIAUCSL', title: 'CPI for all urban consumers, all items, U.S. city average (SA)', units: 'Index (1982-84 = 100), seasonally adjusted', frequency: 'Monthly', lag: 50, source: 'U.S. Bureau of Labor Statistics' },
  { id: 'UNRATE', title: 'Civilian unemployment rate (SA)', units: 'Percent, seasonally adjusted', frequency: 'Monthly', lag: 40, source: 'U.S. Bureau of Labor Statistics' },
]);

const VINTAGE_NOTE = 'LATEST VINTAGE at fetch time — values may have been revised after first publication; ALFRED real-time vintages are not ingested. '
  + 'Revisable series (CPIAUCSL, UNRATE, FEDFUNDS, DTWEXBGS) are withheld from as-of views when a revision could fall between the replay clock and the fetch. '
  + 'Knowability follows each series release rule (server/data/macroCalendar.js), not a flat lag.';
const SERIES_NOTES = {
  DCOILWTICO: 'Daily observations published WEEKLY by EIA (usually Wednesday; Thursday after a Monday federal holiday). An observation is knowable only after its weekly release.',
  DTWEXBGS: 'Daily observations published WEEKLY in the Fed H.10 release (Monday ~16:15 ET for the prior Mon-Fri week). An observation is knowable only after that release. Revised when trade weights change.',
  SP500: 'Index level only (price index, not total return). © S&P Dow Jones Indices LLC; FRED displays a limited recent history under licence.',
  VIXCLS: 'Copyrighted by Cboe; displayed via FRED for reference.',
  FEDFUNDS: 'Monthly average; observation date is the first day of the month it averages. Lag 33 days is a conservative publication assumption.',
  CPIAUCSL: 'Monthly; observation date is the first day of the reference month. Lag 50 days is a conservative publication assumption (BLS releases mid-following-month).',
  UNRATE: 'Monthly; observation date is the first day of the reference month. Lag 40 days is a conservative publication assumption (BLS releases early following month).',
};

/**
 * Parse a fredgraph.csv body. '.' (FRED's missing marker) becomes value null.
 * @returns {{header:string[], rows:{date:string, value:number|null}[], checks:object}}
 */
export function parseFredCsv(text, seriesId) {
  const lines = String(text).replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.trim() !== '');
  const header = (lines[0] || '').split(',').map((s) => s.trim());
  const headerOk = header.length === 2 && /^(observation_date|DATE)$/i.test(header[0]) && header[1].toUpperCase() === String(seriesId).toUpperCase();
  const rows = [];
  let invalid = 0;
  let missing = 0;
  let nonMonotonic = 0;
  let duplicates = 0;
  const invalidSamples = [];
  let prev = null;
  for (const line of lines.slice(1)) {
    const [d, v, ...rest] = line.split(',').map((s) => s.trim());
    if (rest.length || !/^\d{4}-\d{2}-\d{2}$/.test(d || '') || Number.isNaN(Date.parse(d + 'T00:00:00Z'))) {
      invalid++;
      if (invalidSamples.length < 5) invalidSamples.push(line.slice(0, 80));
      continue;
    }
    let value;
    if (v === '.' || v === '') { value = null; missing++; } else {
      value = Number(v);
      if (!Number.isFinite(value) || !/^-?\d+(\.\d+)?([eE][-+]?\d+)?$/.test(v)) {
        invalid++;
        if (invalidSamples.length < 5) invalidSamples.push(line.slice(0, 80));
        continue;
      }
    }
    if (prev !== null) {
      if (d === prev) duplicates++;
      else if (d < prev) nonMonotonic++;
    }
    prev = d;
    rows.push({ date: d, value });
  }
  const numeric = rows.filter((r) => r.value !== null).length;
  return {
    header, rows,
    checks: {
      header_ok: headerOk, rows_total: rows.length, rows_numeric: numeric, rows_missing_dot: missing, rows_invalid: invalid,
      invalid_samples: invalidSamples, dates_strictly_increasing: nonMonotonic === 0 && duplicates === 0,
      non_monotonic: nonMonotonic, duplicate_dates: duplicates,
      first_date: rows[0]?.date ?? null, last_date: rows.at(-1)?.date ?? null,
      last_numeric_date: [...rows].reverse().find((r) => r.value !== null)?.date ?? null,
    },
  };
}

/**
 * Download and store FRED series. One `datasets` row per batch (kind 'macro'); per-series sha256 and checks in
 * quality_json. A series that fails any check is NOT stored (its previous batch, if any, is kept).
 * @param {object} o
 * @param {import('node:sqlite').DatabaseSync} o.db
 * @param {string[]} [o.series] series ids (default: all configured)
 * @param {string} [o.baseUrl] override for tests (local stub server)
 * @param {number} [o.minRows] minimum numeric observations required per series
 */
export async function ingestFred({ db, series = FRED_SERIES.map((s) => s.id), baseUrl = FRED_BASE, fetchImpl, minRows = 12, now = Date.now } = {}) {
  const defs = series.map((id) => {
    const d = FRED_SERIES.find((s) => s.id === id);
    if (!d) throw new Error(`unknown FRED series ${id}`);
    return d;
  });
  const ingestedAt = now();
  const ds = `fred-${stampId(ingestedAt)}`;
  const perSeries = {};
  const parsed = [];
  const allBytes = [];
  for (const def of defs) {
    const url = `${baseUrl}?id=${encodeURIComponent(def.id)}`;
    const r = await fetchBytes(url, { fetchImpl });
    const entry = { url, http_status: r.status, bytes: r.bytes.length, sha256: r.sha256, error: r.error };
    if (r.ok) {
      allBytes.push(r.bytes);
      const p = parseFredCsv(r.bytes.toString('utf8'), def.id);
      Object.assign(entry, p.checks);
      entry.row_count_ok = p.checks.rows_numeric >= minRows;
      entry.ok = p.checks.header_ok && p.checks.rows_invalid === 0 && p.checks.dates_strictly_increasing && entry.row_count_ok;
      if (!entry.ok) entry.error = entry.error || 'quality checks failed; series not stored';
      else parsed.push({ def, rows: p.rows });
    } else {
      entry.ok = false;
    }
    perSeries[def.id] = entry;
  }

  let rowsStored = 0;
  let t0 = null;
  let t1 = null;
  tx(db, () => {
    const upS = db.prepare(`INSERT OR REPLACE INTO macro_series (series, ds, title, units, frequency, publication_lag_days, notes) VALUES (?, ?, ?, ?, ?, ?, ?)`);
    const delO = db.prepare('DELETE FROM macro_obs WHERE series = ?');
    const insO = db.prepare('INSERT INTO macro_obs (series, date, value, ds) VALUES (?, ?, ?, ?)');
    for (const { def, rows } of parsed) {
      const notes = [VINTAGE_NOTE, `Original source: ${def.source}.`, `Knowable: ${macroReleaseRule(def.id, def.lag).text}.`, SERIES_NOTES[def.id]].filter(Boolean).join(' ');
      upS.run(def.id, ds, def.title, def.units, def.frequency, def.lag, notes);
      delO.run(def.id);
      for (const r of rows) insO.run(def.id, r.date, r.value, ds);
      rowsStored += rows.length;
      const a = Date.parse(rows[0].date + 'T00:00:00Z');
      const b = Date.parse(rows.at(-1).date + 'T00:00:00Z');
      if (t0 === null || a < t0) t0 = a;
      if (t1 === null || b > t1) t1 = b;
    }
  });

  const okCount = Object.values(perSeries).filter((s) => s.ok).length;
  const status = okCount === defs.length ? 'complete' : okCount > 0 ? 'partial' : 'failed';
  const combined = Buffer.concat(allBytes);
  const meta = SOURCES.fred;
  recordDataset(db, {
    id: ds, kind: 'macro', provider: meta.provider, venue_coverage: meta.coverage, entitlement: meta.entitlement,
    source_url: `${baseUrl}?id=<SERIES>`, source_id: defs.map((d) => d.id).join(','),
    event_time_start: t0, event_time_end: t1, ingested_at: ingestedAt,
    latency_note: 'Per-series release rules (server/data/macroCalendar.js): DGS10/DGS2/T10Y2Y next Fed business day 16:30 ET (H.15); '
      + 'DTWEXBGS weekly, Monday after the observation week 16:30 ET (H.10); DCOILWTICO weekly, end of the first Wednesday after the observation (Thursday in Monday-holiday weeks) (EIA); '
      + 'VIXCLS/SP500 observation date + 2 days; FEDFUNDS + 33, UNRATE + 40, CPIAUCSL + 50 days (00:00 ET).',
    adjustments: VINTAGE_NOTE,
    sha256: allBytes.length ? sha256Hex(combined) : null, bytes: combined.length,
    status, quality: { series: perSeries, series_ok: okCount, series_requested: defs.length, rows_stored: rowsStored, sha256_basis: 'sha256 over the concatenated response bodies of successfully fetched series, in request order; per-series sha256 listed under series' },
    attribution: meta.attribution,
    notes: `${VINTAGE_NOTE} '.' parsed as missing (stored as NULL). ${okCount}/${defs.length} series stored.`,
  });
  return { ds, status, series: perSeries, rowsStored };
}
