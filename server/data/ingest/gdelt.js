// GDELT DOC 2.0 media METADATA (on demand): title, URL, domain, language, source country, first-seen time.
// No article text is fetched or stored. Results are appended to the evidence store with
// knowable_ts = GDELT seendate (when GDELT first saw the article — the earliest time VECTOR can claim it was
// publicly visible; the publisher's own timestamp is unknown).
//
// As-of: the query window end is clamped to <= asOf, and any returned article with seendate > asOf is dropped.
// Rate limit: >= 6 s between requests (GDELT asks for no more than one request every 5 s). HTTP 429 triggers
// exponential backoff within a bounded attempt budget; exhausting it is reported as PROVIDER_FAULT.
//
// Query phrase: built from the company name in the newest Nasdaq Trader directory snapshot. When that snapshot was
// created after asOf (post-dated) the phrase may reflect a later rename; the dataset quality and every stored article
// record queryNameSource {ds, fileCreationEt, postDated}. Article gating by seendate is unaffected.
import { tx } from '../../db.js';
import { sha256Hex } from '../../util/ids.js';
import { SOURCES, recordDataset, fetchBytes, stampId } from '../sources.js';
import { latestRefSymbol, parseFileCreationTime } from './nasdaq-symdir.js';

export const GDELT_BASE = 'https://api.gdeltproject.org/api/v2/doc/doc';
export const GDELT_MIN_INTERVAL_MS = 6_000;

// Module-level limiter shared by every caller in this process.
const limiter = { last: -Infinity };

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** ms UTC -> GDELT YYYYMMDDHHMMSS (UTC). */
export function gdeltStamp(ms) {
  return new Date(ms).toISOString().replace(/[-:T]/g, '').slice(0, 14);
}

/** GDELT seendate "YYYYMMDDTHHMMSSZ" -> ms UTC. */
export function parseSeenDate(s) {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(String(s || ''));
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) : null;
}

/**
 * Turn a directory security name into a GDELT phrase query, e.g. "Example Holdings Inc. - Common Stock" ->
 * '"Example Holdings"'. Returns null when the remaining name is too short to be a meaningful phrase.
 */
export function companyQuery(securityName) {
  if (!securityName) return null;
  let n = String(securityName).split(' - ')[0];
  n = n.replace(/\b(Class [A-Z]|Common Stock|Ordinary Shares?|American Depositary Shares?|Depositary Shares?|Units?|Warrants?|Rights?)\b.*$/i, '');
  // Drop legal-form suffixes only; keep words like "Holdings"/"Group" that make the phrase more specific.
  n = n.replace(/[,.]/g, ' ').replace(/\b(Inc|Incorporated|Corp|Corporation|Co|Company|Ltd|Limited|plc|PLC|LLC|L\s?P|N\s?V|S\s?A|AG|SE)\b/g, ' ');
  n = n.replace(/[^A-Za-z0-9&' -]/g, ' ').replace(/\s+/g, ' ').trim();
  if (n.length < 5 || !/[A-Za-z]{3}/.test(n)) return null;
  return `"${n}"`;
}

/**
 * One rate-limited artlist query.
 * @returns {Promise<{status:string, httpStatus:number|null, attempts:object[], articles:object[], dropped:number, bytes:Buffer|null, sha256:string|null, url:string, detail:string}>}
 */
export async function gdeltArtList({ query, startMs, endMs, asOf, maxRecords = 75, baseUrl = GDELT_BASE, fetchImpl,
  maxAttempts = 2, backoffMs = 20_000, minIntervalMs = GDELT_MIN_INTERVAL_MS, now = Date.now, sleep = defaultSleep } = {}) {
  if (!query || typeof query !== 'string') throw new TypeError('query is required');
  if (!Number.isFinite(asOf)) throw new TypeError('asOf (ms UTC) is required');
  const end = Math.min(endMs ?? asOf, asOf);
  if (!Number.isFinite(startMs) || startMs >= end) throw new RangeError('startMs must be before min(endMs, asOf)');
  const qs = new URLSearchParams({
    query, mode: 'artlist', format: 'json', sort: 'datedesc', maxrecords: String(Math.min(250, Math.max(1, maxRecords | 0))),
    startdatetime: gdeltStamp(startMs), enddatetime: gdeltStamp(end),
  });
  const url = `${baseUrl}?${qs}`;
  const attempts = [];
  let r = null;
  for (let i = 0; i < maxAttempts; i++) {
    const wait = limiter.last + minIntervalMs - now();
    if (wait > 0) await sleep(wait);
    limiter.last = now();
    r = await fetchBytes(url, { fetchImpl, timeoutMs: 30_000 });
    attempts.push({ at: new Date(limiter.last).toISOString(), httpStatus: r.status, bytes: r.bytes.length, error: r.error, retryAfter: r.headers.retryAfter ?? null });
    if (r.status !== 429 && r.status < 500 && r.status !== 0) break;
    if (i + 1 < maxAttempts) {
      // Respect Retry-After when present; otherwise exponential backoff.
      const ra = Number(r.headers.retryAfter);
      await sleep(Number.isFinite(ra) && ra > 0 ? ra * 1000 : backoffMs * 2 ** i);
    }
  }
  const base = { url, attempts, query, window: { start: startMs, end }, httpStatus: r.status || null, bytes: r.ok ? r.bytes : null, sha256: r.ok ? r.sha256 : null };
  if (!r.ok) {
    return { ...base, status: 'PROVIDER_FAULT', articles: [], dropped: 0, detail: r.status === 429 ? `HTTP 429 Too Many Requests after ${attempts.length} attempt(s)` : `request failed: ${r.error}` };
  }
  const text = r.bytes.toString('utf8');
  let json;
  try { json = JSON.parse(text); } catch {
    // GDELT reports query errors as a 200 text/html message.
    return { ...base, status: 'PROVIDER_FAULT', articles: [], dropped: 0, detail: `non-JSON response: ${text.slice(0, 160).replace(/\s+/g, ' ')}` };
  }
  let dropped = 0;
  const articles = [];
  for (const a of Array.isArray(json.articles) ? json.articles : []) {
    const seen = parseSeenDate(a.seendate);
    if (!a.url || !a.title || seen === null || seen > end) { dropped++; continue; }
    articles.push({ url: String(a.url), title: String(a.title).slice(0, 500), domain: a.domain ?? null, language: a.language ?? null, sourcecountry: a.sourcecountry ?? null, seendate: a.seendate, seen_ts: seen });
  }
  return { ...base, status: articles.length ? 'HISTORICAL_REAL' : 'NO_VERIFIED_DATA', articles, dropped, detail: articles.length ? `${articles.length} article(s)` : 'query returned no articles in window' };
}

/**
 * Persist a gdeltArtList result: one datasets row (kind 'media') and one append-only evidence row per article.
 * Evidence ids are deterministic (sym + url) so repeated fetches never duplicate an article.
 */
export function storeGdeltResult(db, { sym, result, now = Date.now, queryNameSource = null }) {
  const ingestedAt = now();
  const ds = `gdelt-${sym}-${stampId(ingestedAt)}`;
  const meta = SOURCES.gdelt;
  let inserted = 0;
  if (result.articles.length) {
    tx(db, () => {
      const ins = db.prepare(`INSERT OR IGNORE INTO evidence (id, sym, kind, title, body_json, provider, ds, source_url, source_id, event_ts, knowable_ts, ingested_ts, created_wall)
        VALUES (?, ?, 'media', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      for (const a of result.articles) {
        const id = `ev_gdelt_${sha256Hex(`${sym}|${a.url}`).slice(0, 24)}`;
        const body = { url: a.url, domain: a.domain, language: a.language, sourcecountry: a.sourcecountry, seendate: a.seendate, query: result.query,
          ...(queryNameSource ? { queryNameSource } : {}),
          note: 'Metadata only; knowable_ts = GDELT first-seen time; publisher timestamp unknown; article text not stored.' };
        const r = ins.run(id, sym, a.title, JSON.stringify(body), meta.provider, ds, a.url, a.url, a.seen_ts, a.seen_ts, ingestedAt, ingestedAt);
        inserted += Number(r.changes);
      }
    });
  }
  const seen = result.articles.map((a) => a.seen_ts);
  recordDataset(db, {
    id: ds, kind: 'media', provider: meta.provider, venue_coverage: meta.coverage, entitlement: meta.entitlement,
    source_url: result.url, source_id: result.query, event_time_start: seen.length ? Math.min(...seen) : null,
    event_time_end: seen.length ? Math.max(...seen) : null, ingested_at: ingestedAt,
    latency_note: 'knowable_ts = GDELT seendate (first time GDELT observed the URL).',
    sha256: result.sha256, bytes: result.bytes ? result.bytes.length : 0,
    status: result.status === 'PROVIDER_FAULT' ? 'failed' : 'complete',
    quality: {
      http_status: result.httpStatus, attempts: result.attempts, articles: result.articles.length, dropped_after_window_or_invalid: result.dropped, rows_stored: inserted, window: result.window,
      error: result.status === 'PROVIDER_FAULT' ? result.detail : null, query_name_source: queryNameSource,
    },
    attribution: meta.attribution,
    notes: (result.status === 'PROVIDER_FAULT' ? `PROVIDER_FAULT: ${result.detail}` : `${result.articles.length} article(s) for ${result.query}; ${inserted} new evidence row(s).`)
      + (queryNameSource?.postDated ? ` Query phrase built from a company name in a directory snapshot created ${queryNameSource.fileCreationEt ?? 'at an unknown time'}, after the as-of time (post-dated name).` : ''),
  });
  return { ds, inserted };
}

/**
 * Fetch media metadata for a stored symbol using its directory company name, window [asOf - windowDays, asOf].
 */
export async function fetchMediaForSymbol(db, { sym, asOf, windowDays = 7, name = null, ...opts }) {
  const ref = name ? { name } : latestRefSymbol(db, sym);
  let queryNameSource;
  if (name) queryNameSource = { source: 'caller-supplied name', ds: null, fileCreationEt: null, postDated: null };
  else if (ref) {
    const fct = parseFileCreationTime(ref.file_creation_time);
    const createdMs = ref.published_at ?? fct.ms ?? ref.ingested_at;
    queryNameSource = { source: 'Nasdaq Trader Symbol Directory', ds: ref.ds, matchedAs: ref.matchedAs, fileCreationEt: fct.iso_et ?? null, createdMs, postDated: createdMs > asOf };
  }
  const query = companyQuery(ref?.name);
  if (!query) return { status: 'NO_VERIFIED_DATA', sym, detail: ref ? `company name "${ref.name}" too short/ambiguous for a phrase query` : 'symbol not in the stored symbol directory' };
  const result = await gdeltArtList({ query, startMs: asOf - windowDays * 86_400_000, endMs: asOf, asOf, ...opts });
  const stored = storeGdeltResult(db, { sym, result, queryNameSource });
  return { status: result.status, sym, query, queryNameSource, detail: result.detail, httpStatus: result.httpStatus, attempts: result.attempts, articles: result.articles.length, ...stored };
}

/** Media evidence for sym knowable at asOf (newest first). */
export function mediaAsOf(db, sym, asOf, { limit = 50 } = {}) {
  if (!Number.isFinite(asOf)) throw new TypeError('asOf (ms UTC) is required');
  return db.prepare(`SELECT id, sym, title, body_json, provider, ds, source_url, event_ts, knowable_ts, ingested_ts FROM evidence
      WHERE sym = ? AND kind = 'media' AND knowable_ts <= ? ORDER BY knowable_ts DESC LIMIT ?`).all(sym, asOf, limit)
    .map((r) => ({ ...r, body: JSON.parse(r.body_json), body_json: undefined }));
}

/** Test helper: reset the process-wide limiter. */
export function _resetGdeltLimiter() { limiter.last = -Infinity; }
