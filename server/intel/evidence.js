// Append-only evidence store helpers (table `evidence`, see server/db.js; UPDATE/DELETE are blocked by triggers).
//
// Ids are content-addressed: the same evidence (same symbol, kind, body, provenance and knowable time) always gets
// the same id, so rebuilding an identical evidence packet is idempotent and never rewrites an existing row.
// As-of rule: an item is visible at time T only if knowable_ts <= T.
import { sha256Hex, stableStringify } from '../util/ids.js';

const REQUIRED_STRINGS = ['kind', 'title', 'provider'];

function contentOf(rec) {
  return {
    sym: rec.sym ?? null,
    kind: rec.kind,
    title: rec.title,
    body: rec.body,
    provider: rec.provider,
    ds: rec.ds ?? null,
    source_url: rec.source_url ?? null,
    source_id: rec.source_id ?? null,
    event_ts: rec.event_ts ?? null,
    knowable_ts: rec.knowable_ts,
  };
}

/** Deterministic id for an evidence record (sha256 of its content, excluding wall-clock ingestion times). */
export function evidenceId(rec) {
  return `ev_${sha256Hex(stableStringify(contentOf(rec))).slice(0, 24)}`;
}

function validate(rec) {
  if (!rec || typeof rec !== 'object') throw new TypeError('evidence record must be an object');
  for (const k of REQUIRED_STRINGS) {
    if (typeof rec[k] !== 'string' || !rec[k].trim()) throw new TypeError(`evidence.${k} must be a non-empty string`);
  }
  if (!Number.isInteger(rec.knowable_ts)) throw new TypeError('evidence.knowable_ts (integer ms UTC) is required');
  if (rec.event_ts !== undefined && rec.event_ts !== null && !Number.isInteger(rec.event_ts)) throw new TypeError('evidence.event_ts must be an integer or null');
  if (rec.sym !== undefined && rec.sym !== null && typeof rec.sym !== 'string') throw new TypeError('evidence.sym must be a string or null');
  if (rec.body === undefined || rec.body === null || typeof rec.body !== 'object') throw new TypeError('evidence.body must be an object');
}

/**
 * Insert one evidence record (append-only). Returns {id, inserted}; inserted=false when identical content
 * already exists (same id). Never updates an existing row.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{sym?:string|null, kind:string, title:string, body:object, provider:string, ds?:string|null,
 *          source_url?:string|null, source_id?:string|null, event_ts?:number|null, knowable_ts:number}} rec
 */
export function insertEvidence(db, rec, { now = Date.now() } = {}) {
  validate(rec);
  const c = contentOf(rec);
  const id = evidenceId(rec);
  const bodyJson = stableStringify(c.body);
  const r = db.prepare(`INSERT OR IGNORE INTO evidence (id, sym, kind, title, body_json, provider, ds, source_url, source_id,
      event_ts, knowable_ts, ingested_ts, created_wall) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, c.sym, c.kind, c.title, bodyJson, c.provider, c.ds, c.source_url, c.source_id, c.event_ts, c.knowable_ts, now, now);
  if (r.changes === 0) {
    // Same id already stored: it must be the same content (content-addressed). Anything else is a hash collision
    // or tampering and must not be silently accepted.
    const existing = db.prepare('SELECT body_json, knowable_ts, kind FROM evidence WHERE id = ?').get(id);
    if (!existing || existing.body_json !== bodyJson || existing.knowable_ts !== c.knowable_ts || existing.kind !== c.kind) {
      throw new Error(`evidence id collision for ${id}`);
    }
    return { id, inserted: false };
  }
  return { id, inserted: true };
}

function rowOut(r) {
  return { ...r, body: JSON.parse(r.body_json), body_json: undefined };
}

// Provenance guard for as-of reads. Rows are append-only, so a row whose knowable_ts claims a time BEFORE its source
// dataset was published (e.g. symbol identity once stamped at the replay clock from a directory fetched later) cannot be
// corrected in place; as-of reads exclude it instead. Market tick datasets are exempt: their knowable time is per row.
const PROVENANCE_OK = `NOT (d.kind IS NOT NULL AND d.kind <> 'market_ticks' AND d.published_at IS NOT NULL AND e.knowable_ts < d.published_at)`;

/**
 * Evidence knowable at or before asOf for a symbol. Never returns knowable_ts > asOf, nor a row stamped knowable before
 * its source dataset's publication time.
 * includeGlobal: also return market-wide items stored with sym NULL (e.g. macro observations).
 */
export function listAsOf(db, sym, asOf, { includeGlobal = true, kinds = null, limit = 500 } = {}) {
  if (!Number.isFinite(asOf)) throw new TypeError('asOf (ms UTC) is required');
  const where = ['e.knowable_ts <= ?', PROVENANCE_OK];
  const args = [asOf];
  if (sym === null || sym === undefined) where.push('e.sym IS NULL');
  else if (includeGlobal) { where.push('(e.sym = ? OR e.sym IS NULL)'); args.push(sym); }
  else { where.push('e.sym = ?'); args.push(sym); }
  if (Array.isArray(kinds) && kinds.length) {
    where.push(`e.kind IN (${kinds.map(() => '?').join(', ')})`);
    args.push(...kinds);
  }
  args.push(Math.min(Math.max(1, limit | 0), 5000));
  return db.prepare(`SELECT e.* FROM evidence e LEFT JOIN datasets d ON d.id = e.ds WHERE ${where.join(' AND ')}
      ORDER BY e.knowable_ts DESC, e.id ASC LIMIT ?`)
    .all(...args).map(rowOut);
}

/**
 * Fetch evidence rows by id (in the given order). With asOf, rows knowable after asOf, and rows stamped knowable
 * before their source dataset's publication time, are omitted. Without asOf (audit), every stored row is returned.
 */
export function getEvidence(db, ids, { asOf = null } = {}) {
  const stmt = db.prepare(`SELECT e.*, (CASE WHEN ${PROVENANCE_OK} THEN 1 ELSE 0 END) AS provenance_ok
      FROM evidence e LEFT JOIN datasets d ON d.id = e.ds WHERE e.id = ?`);
  const out = [];
  for (const id of ids) {
    const r = stmt.get(id);
    if (!r) continue;
    const { provenance_ok: provOk, ...row } = r;
    if (asOf !== null && (row.knowable_ts > asOf || provOk !== 1)) continue;
    out.push(rowOut(row));
  }
  return out;
}

/** Evidence ids as minted by evidenceId(). */
export const EVIDENCE_ID_RE = /^ev_[0-9a-f]{24}$/;
export const EVIDENCE_IDS_MAX = 40;

/**
 * As-of lookup by id for API/UI use (e.g. GET /api/evidence?ids=): returns ONLY rows knowable at or before asOf whose
 * provenance is consistent (see getEvidence), de-duplicated, in request order. An id that does not exist and an id that
 * exists but becomes knowable after asOf are indistinguishable (both are simply absent), so the lookup leaks nothing about
 * later evidence. Wall-clock storage times (ingested_ts, created_wall) are not returned.
 * Throws TypeError for a missing/non-finite asOf or a malformed id, RangeError for more than EVIDENCE_IDS_MAX ids
 * (callers map both to HTTP 400).
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string[]} ids
 * @param {number} asOf  replay clock, ms UTC (required)
 * @returns {{id, sym, kind, title, body, provider, ds, source_url, source_id, event_ts, knowable_ts}[]}
 */
export function getEvidenceByIds(db, ids, asOf) {
  if (!Number.isFinite(asOf)) throw new TypeError('asOf (ms UTC) is required');
  if (!Array.isArray(ids)) throw new TypeError('ids must be an array of evidence ids');
  const unique = [...new Set(ids)];
  if (unique.length > EVIDENCE_IDS_MAX) throw new RangeError(`at most ${EVIDENCE_IDS_MAX} evidence ids per request`);
  for (const id of unique) {
    if (typeof id !== 'string' || !EVIDENCE_ID_RE.test(id)) throw new TypeError(`invalid evidence id "${String(id).slice(0, 40)}"`);
  }
  return getEvidence(db, unique, { asOf }).map((r) => ({
    id: r.id, sym: r.sym ?? null, kind: r.kind, title: r.title, body: r.body, provider: r.provider, ds: r.ds ?? null,
    source_url: r.source_url ?? null, source_id: r.source_id ?? null, event_ts: r.event_ts ?? null, knowable_ts: r.knowable_ts,
  }));
}
