// SEC EDGAR ingestion (config-gated): ticker -> CIK map, filings index with acceptance times, and
// dei:EntityCommonStockSharesOutstanding facts for dilution tracking.
//
// Fair access: SEC requires a declared User-Agent with a contact e-mail. Without SEC_USER_AGENT this module returns
// status BLOCKED with setup instructions and makes NO request; it never invents a User-Agent or contact.
// Requests are spaced >= 250 ms apart (<= 4 req/s; SEC's published ceiling is 10 req/s).
//
// Knowability: a filing becomes public at its EDGAR acceptance time. The submissions JSON reports
// acceptanceDateTime with a 'Z' suffix, but EDGAR operates on Eastern time; VECTOR interprets the wall-clock part
// as America/New_York. That is the LATER of the two possible readings, so as-of gating can only be conservative.
// When no acceptance time exists, the filing date's 22:00 ET (EDGAR's latest acceptance hour) is used as an upper bound.
//
// Symbol association: filings and facts belong to a CIK. The ticker -> CIK mapping comes from the CURRENT
// company_tickers.json at ingest time (post-dated relative to earlier replays; later ticker changes or reuse are not
// reflected) and is stored per ingest in sec_symbol_map (ds, sym, cik, mapping_fetched_at). Reads resolve sym -> CIK
// through the newest mapping, so two tickers of one issuer (e.g. two share classes) both see its filings; filings.sym
// and company_facts.sym only record the last ticker ingested and are used only for databases without a mapping.
import { tx } from '../../db.js';
import { sha256Hex } from '../../util/ids.js';
import { etToUtc } from '../../util/time.js';
import { SOURCES, SEC_SETUP, recordDataset, secUserAgentStatus, stampId } from '../sources.js';

export const SEC_WWW = 'https://www.sec.gov';
export const SEC_DATA = 'https://data.sec.gov';
export const SEC_MIN_INTERVAL_MS = 250;
export const SHARES_CONCEPT = 'dei:EntityCommonStockSharesOutstanding';

/** Configuration status. BLOCKED unless SEC_USER_AGENT contains a contact e-mail. */
export function secConfig(env = process.env) {
  const s = secUserAgentStatus(env);
  return s.configured
    ? { status: 'CONFIGURED', configured: true, userAgent: s.userAgent }
    : { status: 'BLOCKED', configured: false, reason: s.reason, setup: SEC_SETUP };
}

/** EDGAR acceptanceDateTime ("YYYY-MM-DDTHH:MM:SS(.sss)Z") -> ms UTC, wall clock read as Eastern time. */
export function parseAcceptance(s) {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})/.exec(String(s || ''));
  if (!m) return null;
  return etToUtc(m[1], +m[2], +m[3], +m[4]);
}

/** Conservative knowable time for a filing/fact with only a date. */
export function filingDateUpperBound(date) {
  return /^\d{4}-\d{2}-\d{2}$/.test(date || '') ? etToUtc(date, 22, 0) : null;
}

const pad10 = (cik) => String(cik).padStart(10, '0');

const MAP_DDL = `CREATE TABLE IF NOT EXISTS sec_symbol_map (
  ds TEXT NOT NULL, sym TEXT NOT NULL, cik TEXT NOT NULL, title TEXT, mapping_fetched_at INTEGER NOT NULL,
  PRIMARY KEY (ds, sym))`;
const hasMapTable = (db) => !!db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'sec_symbol_map'`).get();

/**
 * Newest stored ticker -> CIK mapping for sym, labelled post-dated when it was fetched after asOf. null when the
 * database has no mapping for sym (legacy rows are then matched on filings.sym).
 */
export function secSymbolMapping(db, sym, asOf = null) {
  if (!hasMapTable(db)) return null;
  const r = db.prepare('SELECT ds, cik, title, mapping_fetched_at FROM sec_symbol_map WHERE sym = ? ORDER BY mapping_fetched_at DESC LIMIT 1').get(sym);
  if (!r) return null;
  return {
    source: 'SEC company_tickers.json (current at ingest)', ds: r.ds, cik: r.cik, secTitle: r.title, fetchedAt: r.mapping_fetched_at,
    postDated: Number.isFinite(asOf) ? r.mapping_fetched_at > asOf : null,
  };
}

/**
 * Rate-limited JSON client. `now`/`sleep` are injectable so tests can verify spacing without waiting.
 */
export function createSecClient({ userAgent, wwwBase = SEC_WWW, dataBase = SEC_DATA, minIntervalMs = SEC_MIN_INTERVAL_MS,
  fetchImpl = globalThis.fetch, now = Date.now, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), timeoutMs = 30_000 } = {}) {
  if (!userAgent) throw new Error('SEC client requires a declared User-Agent (SEC_USER_AGENT)');
  let last = -Infinity;
  const log = [];
  async function getJson(url) {
    const wait = last + minIntervalMs - now();
    if (wait > 0) await sleep(wait);
    last = now();
    const startedAt = last;
    let res;
    let bytes = Buffer.alloc(0);
    try {
      res = await fetchImpl(url, { headers: { 'User-Agent': userAgent, Accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs) });
      bytes = Buffer.from(await res.arrayBuffer());
    } catch (e) {
      const entry = { url, startedAt, status: 0, bytes: 0, sha256: null, error: String(e?.message || e) };
      log.push(entry);
      return { ok: false, ...entry };
    }
    const entry = { url, startedAt, status: res.status, bytes: bytes.length, sha256: sha256Hex(bytes), error: res.ok ? null : `HTTP ${res.status}` };
    log.push(entry);
    if (!res.ok) return { ok: false, ...entry, raw: bytes };
    try {
      return { ok: true, ...entry, json: JSON.parse(bytes.toString('utf8')), raw: bytes };
    } catch {
      return { ok: false, ...entry, error: 'response was not JSON', raw: bytes };
    }
  }
  return {
    getJson, log,
    tickers: () => getJson(`${wwwBase}/files/company_tickers.json`),
    submissions: (cik) => getJson(`${dataBase}/submissions/CIK${pad10(cik)}.json`),
    companyFacts: (cik) => getJson(`${dataBase}/api/xbrl/companyfacts/CIK${pad10(cik)}.json`),
  };
}

/** Normalise submissions.filings.recent (parallel arrays) into filing rows. */
export function filingsFromSubmissions(sub, sym, { maxFilings = 200 } = {}) {
  const r = sub?.filings?.recent;
  if (!r || !Array.isArray(r.accessionNumber)) return [];
  const cikInt = String(Number(sub.cik));
  const out = [];
  for (let i = 0; i < r.accessionNumber.length && out.length < maxFilings; i++) {
    const acc = r.accessionNumber[i];
    const doc = r.primaryDocument?.[i] || null;
    out.push({
      accession: acc, cik: pad10(sub.cik), sym, form: r.form?.[i] ?? null, filing_date: r.filingDate?.[i] ?? null,
      acceptance_ts: parseAcceptance(r.acceptanceDateTime?.[i]), primary_doc: doc,
      url: doc ? `${SEC_WWW}/Archives/edgar/data/${cikInt}/${String(acc).replaceAll('-', '')}/${doc}` : null,
    });
  }
  return out;
}

/** dei:EntityCommonStockSharesOutstanding facts from a companyfacts payload. */
export function sharesFacts(cf, sym) {
  const units = cf?.facts?.dei?.EntityCommonStockSharesOutstanding?.units;
  const arr = units?.shares;
  if (!Array.isArray(arr)) return [];
  return arr.filter((f) => Number.isFinite(f.val) && f.accn).map((f) => ({
    cik: pad10(cf.cik), sym, concept: SHARES_CONCEPT, unit: 'shares', value: f.val, period_end: f.end ?? null,
    filed: f.filed ?? null, form: f.form ?? null, accession: f.accn,
  }));
}

/**
 * Ingest filings + shares-outstanding facts for the given symbols.
 * @returns {Promise<{status:'BLOCKED'|'complete'|'partial'|'failed', ds?:string, reason?:string, setup?:string, perSymbol?:object}>}
 */
export async function ingestSecEdgar({ db, symbols, env = process.env, client = null, clientOptions = {}, maxFilings = 200, now = Date.now } = {}) {
  const cfg = secConfig(env);
  if (!cfg.configured) return { status: 'BLOCKED', reason: cfg.reason, setup: cfg.setup };
  const syms = [...new Set((symbols || []).map((s) => String(s).trim().toUpperCase()).filter((s) => /^[A-Z][A-Z0-9.\-]{0,9}$/.test(s)))];
  if (!syms.length) throw new Error('ingestSecEdgar: at least one valid symbol is required');
  const c = client || createSecClient({ userAgent: cfg.userAgent, ...clientOptions });
  const ingestedAt = now();
  const ds = `sec-edgar-${stampId(ingestedAt)}`;
  const raws = [];
  const perSymbol = {};
  const t = await c.tickers();
  if (!t.ok) {
    recordFailed(db, ds, ingestedAt, `company_tickers.json: ${t.error}`, c.log);
    return { status: 'failed', ds, reason: t.error };
  }
  raws.push(t.raw);
  const map = new Map(Object.values(t.json || {}).map((x) => [String(x.ticker).toUpperCase(), { cik: x.cik_str, title: x.title }]));
  const filings = [];
  const facts = [];
  const mappings = [];
  const byCik = new Map(); // one submissions + companyfacts request pair per CIK, even when several tickers share it
  for (const sym of syms) {
    const hit = map.get(sym);
    if (!hit) { perSymbol[sym] = { status: 'NO_CIK', detail: 'symbol not in SEC company_tickers.json' }; continue; }
    const cik = pad10(hit.cik);
    mappings.push({ sym, cik, title: hit.title });
    const entry = { cik, secTitle: hit.title };
    let got = byCik.get(cik);
    if (!got) {
      const s = await c.submissions(hit.cik);
      const cf = await c.companyFacts(hit.cik);
      got = { s, cf };
      byCik.set(cik, got);
      if (s.ok) { raws.push(s.raw); filings.push(...filingsFromSubmissions(s.json, sym, { maxFilings })); }
      if (cf.ok) { raws.push(cf.raw); facts.push(...sharesFacts(cf.json, sym)); }
    } else entry.sharedCikWith = mappings.filter((m) => m.cik === cik && m.sym !== sym).map((m) => m.sym);
    const { s, cf } = got;
    if (s.ok) entry.filings = (s.json?.filings?.recent?.accessionNumber || []).slice(0, maxFilings).length; else entry.submissionsError = s.error;
    if (cf.ok) entry.sharesFacts = sharesFacts(cf.json, sym).length; else entry.companyFactsError = cf.status === 404 ? 'NO_COMPANY_FACTS (HTTP 404)' : cf.error;
    entry.status = s.ok ? 'ok' : 'error';
    perSymbol[sym] = entry;
  }
  tx(db, () => {
    db.exec(MAP_DDL);
    const insM = db.prepare('INSERT OR REPLACE INTO sec_symbol_map (ds, sym, cik, title, mapping_fetched_at) VALUES (?, ?, ?, ?, ?)');
    for (const m of mappings) insM.run(ds, m.sym, m.cik, m.title ?? null, ingestedAt);
    const insF = db.prepare(`INSERT OR REPLACE INTO filings (accession, cik, sym, form, filing_date, acceptance_ts, primary_doc, url, ds) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const f of filings) insF.run(f.accession, f.cik, f.sym, f.form, f.filing_date, f.acceptance_ts, f.primary_doc, f.url, ds);
    const insC = db.prepare(`INSERT OR REPLACE INTO company_facts (cik, sym, concept, unit, value, period_end, filed, form, accession, ds) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const f of facts) insC.run(f.cik, f.sym, f.concept, f.unit, f.value, f.period_end, f.filed, f.form, f.accession, ds);
  });
  const okSyms = Object.values(perSymbol).filter((p) => p.status === 'ok').length;
  const status = okSyms === syms.length ? 'complete' : okSyms > 0 ? 'partial' : 'failed';
  const acc = filings.map((f) => f.acceptance_ts).filter((x) => x != null);
  const meta = SOURCES['sec-edgar'];
  recordDataset(db, {
    id: ds, kind: 'filings', provider: meta.provider, venue_coverage: meta.coverage, entitlement: meta.entitlement,
    source_url: `${SEC_WWW}/files/company_tickers.json; ${SEC_DATA}/submissions/; ${SEC_DATA}/api/xbrl/companyfacts/`, source_id: syms.join(','),
    event_time_start: acc.length ? Math.min(...acc) : null, event_time_end: acc.length ? Math.max(...acc) : null, ingested_at: ingestedAt,
    latency_note: 'Filings knowable at EDGAR acceptance time (wall clock interpreted as ET; conservative). Facts knowable when their filing was accepted. '
      + 'Ticker -> CIK mapping from the current company_tickers.json at ingest (post-dated for earlier replays; stored in sec_symbol_map).',
    adjustments: 'None. Shares outstanding as reported on each filing cover page (dei).',
    sha256: sha256Hex(Buffer.concat(raws)), bytes: raws.reduce((s, b) => s + b.length, 0), status,
    quality: { requests: c.log, per_symbol: perSymbol, filings: filings.length, shares_facts: facts.length, rows_stored: filings.length + facts.length,
      sha256_basis: 'sha256 over all successful response bodies in request order; per-request sha256 under requests' },
    attribution: meta.attribution, notes: `${okSyms}/${syms.length} symbols ingested.`,
  });
  return { status, ds, perSymbol, filings: filings.length, facts: facts.length };
}

function recordFailed(db, ds, ingestedAt, error, log) {
  const meta = SOURCES['sec-edgar'];
  recordDataset(db, {
    id: ds, kind: 'filings', provider: meta.provider, venue_coverage: meta.coverage, entitlement: meta.entitlement,
    source_url: `${SEC_WWW}/files/company_tickers.json`, ingested_at: ingestedAt, status: 'failed',
    quality: { error, requests: log, rows_stored: 0 }, attribution: meta.attribution, notes: `Ingestion failed: ${error}`,
  });
}

/**
 * Filings for sym knowable at asOf (acceptance time, or the conservative filing-date bound), newest first. sym is
 * resolved to its CIK through the newest stored mapping (secSymbolMapping); each row carries that mapping.
 */
export function filingsAsOf(db, sym, asOf, { limit = 50 } = {}) {
  if (!Number.isFinite(asOf)) throw new TypeError('asOf (ms UTC) is required');
  const mapping = secSymbolMapping(db, sym, asOf);
  const rows = mapping
    ? db.prepare('SELECT * FROM filings WHERE cik = ? ORDER BY filing_date DESC LIMIT 1000').all(mapping.cik)
    : db.prepare('SELECT * FROM filings WHERE sym = ? ORDER BY filing_date DESC LIMIT 1000').all(sym);
  return rows
    .map((f) => ({
      ...f,
      knowable_ts: f.acceptance_ts ?? filingDateUpperBound(f.filing_date),
      knowableBasis: f.acceptance_ts != null ? 'EDGAR_ACCEPTANCE_ET' : 'FILING_DATE_22_00_ET_UPPER_BOUND',
      symbolMapping: mapping,
    }))
    .filter((f) => f.knowable_ts != null && f.knowable_ts <= asOf)
    .sort((a, b) => b.knowable_ts - a.knowable_ts)
    .slice(0, limit);
}

/** Shares-outstanding facts knowable at asOf (joined to filing acceptance where available), oldest first. */
export function sharesOutstandingAsOf(db, sym, asOf) {
  if (!Number.isFinite(asOf)) throw new TypeError('asOf (ms UTC) is required');
  const mapping = secSymbolMapping(db, sym, asOf);
  return db.prepare(`SELECT c.*, f.acceptance_ts FROM company_facts c LEFT JOIN filings f ON f.accession = c.accession
      WHERE ${mapping ? 'c.cik' : 'c.sym'} = ? AND c.concept = ? ORDER BY c.period_end ASC`).all(mapping ? mapping.cik : sym, SHARES_CONCEPT)
    .map((r) => ({ ...r, knowable_ts: r.acceptance_ts ?? filingDateUpperBound(r.filed) }))
    .filter((r) => r.knowable_ts != null && r.knowable_ts <= asOf);
}
