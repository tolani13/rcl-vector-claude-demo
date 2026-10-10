// HTTP plumbing for the JSON API: error envelope, body reading (size-capped, depth-capped, JSON object only), response
// writing with secret scrubbing, strict input validators, and a bounded body summary for journaling refused requests.
// Errors are always {error:{code, message}} (plus optional structured fields such as reasons/errors); stack traces and
// secrets never reach a response.
import { sha256Hex, stableStringify } from '../util/ids.js';

export const SYM_RE = /^[A-Z][A-Z0-9.\-]{0,9}$/;
export const ID_RE = /^[A-Za-z0-9_\-:.]{1,80}$/;
export const MAX_BODY_DEPTH = 32;
export const MAX_BODY_NODES = 20_000;

/** An error that maps to an HTTP status and the API error envelope. `extra` is merged into the body. */
export class ApiError extends Error {
  constructor(status, code, message, extra = null) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

/** A handler result with an explicit HTTP status (plain objects returned by handlers are sent as 200). */
export class Reply {
  constructor(status, body) {
    this.status = status;
    this.body = body;
  }
}
export const created = (body) => new Reply(201, body);

export const badRequest = (code, message, extra) => new ApiError(400, code, message, extra);
export const conflict = (code, message, extra) => new ApiError(409, code, message, extra);
export const notFound = (code, message, extra) => new ApiError(404, code, message, extra);

const JSON_HEADERS = Object.freeze({
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
});

/**
 * Serialise and send a JSON body. Defence in depth: any configured secret value and any credentials embedded in a URL
 * (scheme://user:pass@host) are replaced before the body leaves the server.
 */
export function sendJson(res, status, body, { secrets = [], method = 'GET' } = {}) {
  let text = JSON.stringify(body ?? null);
  for (const s of secrets) if (text.includes(s)) text = text.split(s).join('[REDACTED]');
  text = text.replace(/(https?:\/\/)[^/\s"@]+@/gi, '$1[REDACTED]@');
  const buf = Buffer.from(text, 'utf8');
  res.writeHead(status, { ...JSON_HEADERS, 'content-length': buf.length });
  res.end(method === 'HEAD' ? undefined : buf);
}

export function errorBody(code, message, extra = null) {
  return { ...(extra || {}), error: { code: String(code), message: String(message ?? '') } };
}

/**
 * Read a JSON object body. Requires `content-type: application/json` and at most maxBytes bytes.
 * @returns {Promise<object>}
 */
export function readJsonBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > maxBytes) {
      req.resume();
      reject(new ApiError(413, 'BODY_TOO_LARGE', `request body exceeds ${maxBytes} bytes`));
      return;
    }
    const chunks = [];
    let size = 0;
    let done = false;
    req.on('data', (c) => {
      if (done) return;
      size += c.length;
      if (size > maxBytes) {
        done = true;
        req.resume();
        reject(new ApiError(413, 'BODY_TOO_LARGE', `request body exceeds ${maxBytes} bytes`));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (done) return;
      done = true;
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text.trim()) { resolve({}); return; }
      let v;
      try { v = JSON.parse(text); } catch {
        reject(badRequest('BAD_JSON', 'request body is not valid JSON'));
        return;
      }
      if (!v || typeof v !== 'object' || Array.isArray(v)) { reject(badRequest('BODY_NOT_OBJECT', 'request body must be a JSON object')); return; }
      const shape = jsonShapeError(v);
      if (shape) { reject(badRequest(shape.code, `request body ${shape.detail}`)); return; }
      resolve(v);
    });
    req.on('error', () => { if (!done) { done = true; reject(badRequest('BODY_READ_ERROR', 'request body could not be read')); } });
  });
}

/**
 * Iterative structure check of a parsed body (no recursion, so hostile nesting cannot overflow the stack here or in
 * later recursive code such as structuredClone / stableStringify). Returns null or {code, detail}.
 */
export function jsonShapeError(v, { maxDepth = MAX_BODY_DEPTH, maxNodes = MAX_BODY_NODES } = {}) {
  const stack = [[v, 1]];
  let nodes = 0;
  while (stack.length) {
    const [x, depth] = stack.pop();
    if (++nodes > maxNodes) return { code: 'BODY_TOO_COMPLEX', detail: `has more than ${maxNodes} JSON values` };
    if (x === null || typeof x !== 'object') continue;
    if (depth > maxDepth) return { code: 'BODY_TOO_DEEP', detail: `is nested deeper than ${maxDepth} levels` };
    for (const c of Array.isArray(x) ? x : Object.values(x)) stack.push([c, depth + 1]);
  }
  return null;
}

const SUMMARY_MAX_CHARS = 4000;

/**
 * Bounded, journal-safe summary of a request body (used when a refused request is journaled): keys with truncated
 * scalars, nested values reduced to their sizes beyond one level, plus the size and sha256 of the full canonical JSON.
 * The journal is append-only, so a refused request must never be copied into it verbatim.
 */
export function summarizeBody(body) {
  if (body === null || body === undefined) return null;
  let canonical;
  try { canonical = stableStringify(body); } catch { canonical = null; }
  const scalar = (v) => {
    if (typeof v === 'string') return v.length > 100 ? `${v.slice(0, 100)}… [${v.length} chars]` : v;
    if (typeof v === 'number') return Number.isFinite(v) ? v : String(v);
    return v; // boolean | null
  };
  const shallow = (v) => {
    if (v === null || typeof v !== 'object') return scalar(v);
    return Array.isArray(v) ? `[array of ${v.length}]` : `[object with ${Object.keys(v).length} keys]`;
  };
  const level1 = (v) => {
    if (v === null || typeof v !== 'object') return scalar(v);
    if (Array.isArray(v)) return v.length <= 5 ? v.map(shallow) : [...v.slice(0, 5).map(shallow), `… +${v.length - 5} more`];
    const keys = Object.keys(v);
    const out = Object.fromEntries(keys.slice(0, 12).map((k) => [k.slice(0, 40), shallow(v[k])]));
    if (keys.length > 12) out['…'] = `+${keys.length - 12} more keys`;
    return out;
  };
  let fields;
  if (typeof body !== 'object') fields = shallow(body);
  else {
    const keys = Object.keys(body);
    fields = Object.fromEntries(keys.slice(0, 24).map((k) => [k.slice(0, 40), level1(body[k])]));
    if (keys.length > 24) fields['…'] = `+${keys.length - 24} more keys`;
    if (JSON.stringify(fields).length > SUMMARY_MAX_CHARS) fields = Object.fromEntries(keys.slice(0, 24).map((k) => [k.slice(0, 40), shallow(body[k])]));
  }
  return { fields, bytes: canonical === null ? null : Buffer.byteLength(canonical, 'utf8'), sha256: canonical === null ? null : sha256Hex(canonical),
    note: 'bounded summary of the refused request (full body not stored; sha256 of its canonical JSON)' };
}

// ---------------------------------------------------------------------------------------------------------------
// Validators. Each throws ApiError(400) with a precise code/message; each returns the normalised value.

const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Reject keys outside `allowed` (strict bodies and query strings). */
export function onlyKeys(obj, allowed, where = 'body') {
  if (!isPlain(obj)) throw badRequest('BODY_NOT_OBJECT', `${where} must be an object`);
  const bad = Object.keys(obj).filter((k) => !allowed.includes(k));
  if (bad.length) throw badRequest('UNKNOWN_FIELD', `unknown ${where} field(s): ${bad.slice(0, 5).map((k) => k.slice(0, 40)).join(', ')}`);
  return obj;
}

export function symbol(v, name = 'sym') {
  if (typeof v !== 'string') throw badRequest('SYMBOL_INVALID', `${name} is required`);
  const s = v.trim().toUpperCase();
  if (!SYM_RE.test(s)) throw badRequest('SYMBOL_INVALID', `${name} must match ^[A-Z][A-Z0-9.-]{0,9}$`);
  return s;
}

export function id(v, name = 'id') {
  if (typeof v !== 'string' || !ID_RE.test(v)) throw badRequest('ID_INVALID', `${name} must match ^[A-Za-z0-9_-:.]{1,80}$`);
  return v;
}

export function oneOf(v, values, name, { optional = false, dflt } = {}) {
  if (v === undefined || v === null || v === '') {
    if (optional) return dflt;
    throw badRequest('ENUM_INVALID', `${name} is required (one of ${values.join(' | ')})`);
  }
  if (!values.includes(v)) throw badRequest('ENUM_INVALID', `${name} must be one of ${values.join(' | ')}`);
  return v;
}

/** Integer within [min, max]. Accepts numeric strings (query parameters). */
export function intIn(v, min, max, name, { optional = false, dflt } = {}) {
  if (v === undefined || v === null || v === '') {
    if (optional) return dflt;
    throw badRequest('INT_INVALID', `${name} is required (integer ${min}..${max})`);
  }
  const n = typeof v === 'string' && /^-?\d+$/.test(v.trim()) ? Number(v) : v;
  if (!Number.isSafeInteger(n) || n < min || n > max) throw badRequest('INT_INVALID', `${name} must be an integer ${min}..${max}`);
  return n;
}

export function bool(v, name, { optional = false, dflt } = {}) {
  if (v === undefined) {
    if (optional) return dflt;
    throw badRequest('BOOL_INVALID', `${name} is required (true | false)`);
  }
  if (typeof v !== 'boolean') throw badRequest('BOOL_INVALID', `${name} must be a boolean`);
  return v;
}

export function text(v, max, name, { optional = false, dflt = null } = {}) {
  if (v === undefined || v === null) {
    if (optional) return dflt;
    throw badRequest('TEXT_INVALID', `${name} is required`);
  }
  if (typeof v !== 'string' || v.length > max) throw badRequest('TEXT_INVALID', `${name} must be a string of at most ${max} characters`);
  return v;
}

/**
 * Query string -> prototype-free object (first value wins), with an allow-list. A null prototype plus Object.hasOwn
 * means names such as __proto__ / constructor / toString are ordinary keys and are rejected as UNKNOWN_FIELD.
 */
export function query(url, allowed) {
  const q = Object.create(null);
  for (const [k, v] of url.searchParams) if (!Object.hasOwn(q, k)) q[k] = v;
  return onlyKeys(q, allowed, 'query');
}
