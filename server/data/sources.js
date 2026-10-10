// Source registry.
//
// 1. SOURCES: provenance metadata (provider, coverage, entitlement, attribution, setup) for every external data
//    source VECTOR knows about. This is configuration text, never market observations.
// 2. recordDataset(): the single writer for `datasets` rows used by every ingestion module except IEX (which
//    predates it and writes its own row with the same columns).
// 3. fetchBytes(): bounded HTTP GET that returns the exact received bytes (so callers can hash them).
// 4. listSources(db): the payload for GET /api/sources — one entry per source with a status from the
//    CONTRACTS.md vocabulary, derived only from what is actually stored / configured.
//
// Model providers (Anthropic / OpenAI-compatible) are reported separately by server/intel and are not listed here.
import { sha256Hex } from '../util/ids.js';
import { IEX_ATTRIBUTION, IEX_COVERAGE } from './ingest/iex-tops.js';
import { feedStatus } from './providers/index.js';
import { coverageEndMs } from './marketdata.js';
import { fmtEt } from '../util/time.js';

/** Contract status vocabulary for data sources (docs/CONTRACTS.md §0). */
export const DATA_STATUS = Object.freeze({
  LIVE_VERIFIED: 'LIVE_VERIFIED', DELAYED_REAL: 'DELAYED_REAL', HISTORICAL_REAL: 'HISTORICAL_REAL',
  IMPORTED_UNVERIFIED: 'IMPORTED_UNVERIFIED', NO_VERIFIED_DATA: 'NO_VERIFIED_DATA', PROVIDER_FAULT: 'PROVIDER_FAULT', BLOCKED: 'BLOCKED',
});

/** SEC fair-access policy: a declared User-Agent with a contact e-mail is required. Never invented here. */
export function secUserAgentStatus(env = process.env) {
  const ua = (env.SEC_USER_AGENT || '').trim();
  const hasEmail = /[^\s@<>]+@[^\s@<>]+\.[A-Za-z]{2,}/.test(ua);
  if (!ua) return { configured: false, userAgent: null, reason: 'SEC_USER_AGENT is not set' };
  if (!hasEmail) return { configured: false, userAgent: null, reason: 'SEC_USER_AGENT does not contain a contact e-mail address' };
  return { configured: true, userAgent: ua, reason: null };
}

export const SEC_SETUP = [
  'SEC EDGAR requires a declared User-Agent that identifies you and includes a contact e-mail (SEC fair-access policy:',
  'https://www.sec.gov/os/accessing-edgar-data). Set it server-side, then run the ingestion for specific symbols:',
  '  PowerShell:  $env:SEC_USER_AGENT = "<Your name or organisation> <your contact e-mail>"',
  '  bash:        export SEC_USER_AGENT="<Your name or organisation> <your contact e-mail>"',
  '  then:        npm run ingest:sec -- --symbols SYM1,SYM2',
  'VECTOR never invents a User-Agent or contact. Requests are limited to <= 4 per second (SEC limit is 10/s).',
].join('\n');

export const SOURCES = Object.freeze({
  'iex-hist': {
    name: 'IEX HIST — TOPS 1.6', kinds: ['market_ticks'], provider: 'IEX Exchange HIST — TOPS 1.6',
    coverage: IEX_COVERAGE,
    entitlement: 'Free historical data under the IEX Historical Data Terms of Use; attribution required; reference use only.',
    attribution: IEX_ATTRIBUTION,
    setup: 'npm run ingest:iex -- --date YYYY-MM-DD   (streams the official IEX HIST TOPS file; ~10 GB compressed per day)',
  },
  fred: {
    name: 'FRED macro series', kinds: ['macro'], provider: 'Federal Reserve Bank of St. Louis — FRED (fredgraph.csv)',
    coverage: 'U.S. macro / market reference series: DGS10, DGS2, T10Y2Y (daily, H.15 posted next business day); VIXCLS, SP500 (daily); '
      + 'DCOILWTICO and DTWEXBGS (daily observations PUBLISHED WEEKLY: EIA Wednesdays, Fed H.10 Mondays); FEDFUNDS, CPIAUCSL, UNRATE (monthly). '
      + 'Each observation is knowable only under its series release rule. Latest vintage only (no ALFRED real-time vintages): revisable series are withheld from as-of views when a revision could postdate the replay clock.',
    entitlement: 'FRED Terms of Use; some series are copyrighted by their original source (e.g. SP500 © S&P Dow Jones Indices LLC, VIXCLS © Cboe) and FRED limits the history it shows for them. Reference/research display with attribution.',
    attribution: 'Source: Federal Reserve Bank of St. Louis, FRED® (https://fred.stlouisfed.org/), with the original source agency credited per series.',
    setup: 'npm run ingest:fred   (no key required)',
  },
  'nasdaq-symdir': {
    name: 'Nasdaq Trader Symbol Directory', kinds: ['symbol_directory'], provider: 'Nasdaq Trader SymbolDirectory (nasdaqlisted.txt + otherlisted.txt)',
    coverage: 'Current U.S. exchange-listed securities (Nasdaq-listed and other-exchange-listed). A snapshot as of the fetch time — NOT a historical, as-of directory. OTC securities not covered.',
    entitlement: 'Publicly posted by Nasdaq Trader for reference; Nasdaq Trader terms of use apply.',
    attribution: 'Source: Nasdaq Trader Symbol Directory (https://www.nasdaqtrader.com/trader.aspx?id=symboldirdefs).',
    setup: 'npm run ingest:symdir   (no key required)',
  },
  'finra-regsho': {
    name: 'FINRA Reg SHO daily short-sale volume', kinds: ['short_volume'], provider: 'FINRA Reg SHO Daily Short Sale Volume — consolidated NMS file (CNMSshvol)',
    coverage: 'FINRA-reported OFF-EXCHANGE trades only (TRF/ADF/ORF facilities). NOT consolidated volume and not short interest. Exchange-executed short sales are not included.',
    entitlement: 'Publicly posted by FINRA; FINRA website terms of use apply.',
    attribution: 'Source: FINRA Reg SHO Daily Short Sale Volume files (https://www.finra.org/finra-data/browse-catalog/short-sale-volume-data).',
    setup: 'npm run ingest:finra -- [--dates YYYY-MM-DD,...]   (no key required)',
  },
  'sec-edgar': {
    name: 'SEC EDGAR filings & company facts', kinds: ['filings'], provider: 'U.S. SEC EDGAR (company_tickers.json, submissions API, XBRL companyfacts API)',
    coverage: 'Filings index (form, acceptance time, primary document) and dei:EntityCommonStockSharesOutstanding for requested symbols that have an SEC CIK.',
    entitlement: 'Public U.S. government data; SEC fair-access policy (declared User-Agent with contact e-mail; request-rate limit).',
    attribution: 'Source: U.S. Securities and Exchange Commission, EDGAR (https://www.sec.gov/edgar).',
    setup: SEC_SETUP,
  },
  gdelt: {
    name: 'GDELT DOC 2.0 media metadata', kinds: ['media'], provider: 'The GDELT Project — DOC 2.0 API (artlist mode)',
    coverage: 'On-demand article METADATA only (title, URL, domain, language, first-seen time) for a company-name query; rolling ~3-month search window; no article text is stored.',
    entitlement: 'GDELT data is open for research use with citation; the linked articles remain the property of their publishers (only links and titles are stored).',
    attribution: 'Source: The GDELT Project (https://www.gdeltproject.org/).',
    setup: 'On demand from the research dossier (rate-limited to 1 request / 6 s). No key required. HTTP 429 is reported as PROVIDER_FAULT.',
  },
  'csv-import': {
    name: 'CSV bar import', kinds: ['import'], provider: 'User-supplied historical bars (manifest required)',
    coverage: 'Whatever the user imports: one symbol per manifest, minute or daily OHLCV bars. No quotes, so imported bars can never produce paper fills.',
    entitlement: 'Declared by the importer in the manifest (licence field). Not verified by VECTOR.',
    attribution: 'As declared in each import manifest.',
    setup: 'POST /api/import/csv with {manifest:{provider, source_url, licence, retrieved_at, timezone, timestamp_semantics, symbol, fields}, csv} (small files), '
      + 'or for larger files locally: node scripts/ingest-csv.js --manifest manifest.json --csv bars.csv (same validator; up to 500,000 rows). '
      + 'Mere upload does not establish authenticity: status stays IMPORTED_UNVERIFIED.',
  },
});

/**
 * Insert (or, by default, replace) one `datasets` row. All provenance columns are explicit; quality is an object.
 * With {replace:false} an existing row with the same id is never overwritten (the insert throws instead).
 * @returns {string} the dataset id
 */
export function recordDataset(db, d, { replace = true } = {}) {
  for (const k of ['id', 'kind', 'provider', 'status']) if (!d[k]) throw new Error(`recordDataset: ${k} is required`);
  db.prepare(`INSERT ${replace ? 'OR REPLACE ' : ''}INTO datasets (id, kind, provider, venue_coverage, entitlement, source_url, source_id, trade_date,
      event_time_start, event_time_end, published_at, ingested_at, latency_note, adjustments, sha256, bytes, expected_bytes, status,
      quality_json, attribution, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    d.id, d.kind, d.provider, d.venue_coverage ?? null, d.entitlement ?? null, d.source_url ?? null, d.source_id ?? null,
    d.trade_date ?? null, d.event_time_start ?? null, d.event_time_end ?? null, d.published_at ?? null, d.ingested_at ?? Date.now(),
    d.latency_note ?? null, d.adjustments ?? null, d.sha256 ?? null, d.bytes ?? null, d.expected_bytes ?? null, d.status,
    d.quality ? JSON.stringify(d.quality) : null, d.attribution ?? null, d.notes ?? null);
  return d.id;
}

/** Compact UTC timestamp for dataset ids, e.g. 20261008T233012Z. */
export function stampId(ms = Date.now()) {
  return new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

/**
 * GET a URL and return the exact received bytes. Never throws for HTTP/network errors; returns {ok:false, error}.
 * @returns {Promise<{ok:boolean, status:number, bytes:Buffer, sha256:string|null, contentType:string|null, headers:object, error:string|null, url:string}>}
 */
export async function fetchBytes(url, { headers = {}, timeoutMs = 30_000, fetchImpl = globalThis.fetch } = {}) {
  try {
    const res = await fetchImpl(url, { headers, signal: AbortSignal.timeout(timeoutMs), redirect: 'follow' });
    const bytes = Buffer.from(await res.arrayBuffer());
    return {
      ok: res.ok, status: res.status, bytes, sha256: sha256Hex(bytes), contentType: res.headers.get('content-type'),
      headers: { retryAfter: res.headers.get('retry-after'), lastModified: res.headers.get('last-modified') },
      error: res.ok ? null : `HTTP ${res.status}`, url,
    };
  } catch (e) {
    return { ok: false, status: 0, bytes: Buffer.alloc(0), sha256: null, contentType: null, headers: {}, error: String(e?.message || e), url };
  }
}

/** Latest dataset row per kind, plus aggregates, for listSources. */
function datasetsFor(db, kinds) {
  const ph = kinds.map(() => '?').join(',');
  return db.prepare(`SELECT id, kind, provider, status, sha256, published_at, ingested_at, event_time_start, event_time_end, quality_json, notes, source_url
    FROM datasets WHERE kind IN (${ph}) ORDER BY ingested_at DESC`).all(...kinds)
    .map((d) => ({ ...d, quality: d.quality_json ? safeJson(d.quality_json) : null, quality_json: undefined }));
}

function safeJson(s) {
  try { return JSON.parse(s); } catch { return null; }
}

const GOOD = new Set(['complete', 'partial']);

function rowsOf(d) {
  const q = d.quality || {};
  return Number(q.rows_stored ?? q.rows_retained ?? 0) || 0;
}

function summarise(db, id, meta, { statusIfGood = DATA_STATUS.HISTORICAL_REAL, goodStatuses = GOOD, rowsFn = null } = {}) {
  const all = datasetsFor(db, meta.kinds);
  const good = all.filter((d) => goodStatuses.has(d.status));
  const latest = all[0] || null;
  let status = DATA_STATUS.NO_VERIFIED_DATA;
  const notes = [];
  if (good.length) status = statusIfGood;
  else if (latest && latest.status === 'failed') status = DATA_STATUS.PROVIDER_FAULT;
  if (latest && latest.status === 'failed') notes.push(`Latest attempt ${latest.id} failed: ${latest.notes || (latest.quality && latest.quality.error) || 'see dataset quality'}`);
  if (good.length && good[0].notes) notes.push(good[0].notes);
  const lastEvent = good.reduce((m, d) => (d.event_time_end != null && (m === null || d.event_time_end > m) ? d.event_time_end : m), null);
  return {
    id, name: meta.name, kind: meta.kinds.join('|'), status, provider: meta.provider, coverage: meta.coverage,
    entitlement: meta.entitlement, attribution: meta.attribution,
    last_event_ts: lastEvent, ingested_at: good[0]?.ingested_at ?? latest?.ingested_at ?? null,
    // Provider publication time of the newest good batch when known (e.g. IEX HIST file Last-Modified); null = unknown.
    published_at: good[0]?.published_at ?? null,
    sha256: good[0]?.sha256 ?? null,
    rows: rowsFn ? rowsFn(good) : good.reduce((s, d) => s + rowsOf(d), 0),
    setup: meta.setup, notes: notes.join(' | ') || null,
    datasets: all.slice(0, 20).map((d) => ({ id: d.id, status: d.status, sha256: d.sha256, published_at: d.published_at ?? null, ingested_at: d.ingested_at, rows: rowsOf(d) })),
  };
}

/** GET /api/sources payload. Never fabricates a status: everything derives from stored datasets or configuration. */
export function listSources(db, { env = process.env } = {}) {
  const out = [];
  const iex = summarise(db, 'iex-hist', SOURCES['iex-hist']);
  // A truncated (partial) day stays HISTORICAL_REAL (the contract enum is fixed) but is labelled with its coverage end.
  for (const d of iex.datasets) {
    d.complete = d.status === 'complete';
    d.coverage_end = d.status === 'partial' ? coverageEndMs(db, d.id) : null;
  }
  const partials = iex.datasets.filter((d) => d.status === 'partial');
  iex.complete = iex.datasets.some((d) => GOOD.has(d.status)) ? partials.length === 0 : null;
  if (partials.length) {
    iex.notes = [...partials.map((d) => `PARTIAL — dataset ${d.id} is truncated; data ends ${Number.isFinite(d.coverage_end) ? fmtEt(d.coverage_end, { date: true }) : 'at an unknown time'}. `
      + 'Quotes are not carried and fills are unavailable after that time.'), iex.notes].filter(Boolean).join(' | ');
  }
  const noPub = iex.datasets.filter((d) => GOOD.has(d.status) && d.published_at == null);
  if (noPub.length) {
    iex.notes = [iex.notes, `Provider publication time not recorded for ${noPub.map((d) => d.id).join(', ')} `
      + '(ingested before the HIST file Last-Modified was captured, or from a local file); event and ingest times only.'].filter(Boolean).join(' | ');
  }
  out.push(iex);
  // FRED and the symbol directory replace rows on re-ingest, so only the newest good batch counts toward rows.
  out.push(summarise(db, 'fred', SOURCES.fred, { rowsFn: (good) => rowsOf(good[0] || {}) }));
  out.push(summarise(db, 'nasdaq-symdir', SOURCES['nasdaq-symdir'], { rowsFn: (good) => rowsOf(good[0] || {}) }));
  out.push(summarise(db, 'finra-regsho', SOURCES['finra-regsho']));

  const sec = summarise(db, 'sec-edgar', SOURCES['sec-edgar']);
  const ua = secUserAgentStatus(env);
  if (sec.status === DATA_STATUS.NO_VERIFIED_DATA && !ua.configured) {
    sec.status = DATA_STATUS.BLOCKED;
    sec.notes = [`BLOCKED: ${ua.reason}. No SEC request is made without a declared contact User-Agent.`, sec.notes].filter(Boolean).join(' | ');
  }
  out.push(sec);

  const gd = summarise(db, 'gdelt', SOURCES.gdelt);
  out.push(gd);
  out.push(summarise(db, 'csv-import', SOURCES['csv-import'], {
    statusIfGood: DATA_STATUS.IMPORTED_UNVERIFIED, goodStatuses: new Set([DATA_STATUS.IMPORTED_UNVERIFIED]),
  }));

  // Request-capable market-data adapters (never invoked against genuine data in this build).
  const feeds = feedStatus(env);
  for (const p of feeds.providers) {
    out.push({
      id: p.id, name: p.name, kind: 'market_feed', status: p.dataStatus, provider: p.name,
      coverage: p.coverage, entitlement: p.entitlement, attribution: p.attribution,
      last_event_ts: p.lastQuoteTs ?? null, published_at: null, ingested_at: null, sha256: null, rows: 0,
      setup: p.setup, notes: `${p.configured ? 'Credentials present (server-side env).' : 'NOT_CONFIGURED.'} ${p.verification}`,
      datasets: [],
    });
  }
  return out;
}
