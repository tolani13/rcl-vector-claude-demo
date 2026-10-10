// Same-origin JSON client for the VECTOR API (docs/CONTRACTS.md §9). Never throws: every call resolves to
// { ok, status, data, error:{code, message}|null, unreachable, timedOut }. Mutations always send the required headers.
//
// Timeouts: ordinary reads give up after TIMEOUT_MS. Long server operations (multi-minute replay steps, model tests,
// three-lens assessments) pass a per-call { timeoutMs } sized from the server's own bounds; timeoutMs = 0 disables the
// client abort. A client-side timeout is reported as CLIENT_TIMEOUT (unreachable:false, timedOut:true) — the request
// may still be running on the server — never as API_UNREACHABLE, which is reserved for real network failures.
export const TIMEOUT_MS = 12000;
const MUTATION_HEADERS = Object.freeze({ 'Content-Type': 'application/json', 'X-Vector-Client': 'web' });

export const CLIENT_TIMEOUT_MESSAGE = 'No response yet — the server may still be working on this request. Status will refresh; check the result before retrying.';

export async function request(method, path, body, { timeoutMs = TIMEOUT_MS } = {}) {
  if (typeof path !== 'string' || !path.startsWith('/api/')) {
    return { ok: false, status: 0, data: null, unreachable: false, timedOut: false, error: { code: 'CLIENT_ERROR', message: 'Invalid API path' } };
  }
  const ms = Number.isFinite(timeoutMs) && timeoutMs >= 0 ? timeoutMs : TIMEOUT_MS;
  const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
  let timedOut = false;
  const timer = ctrl && ms > 0 ? setTimeout(() => { timedOut = true; ctrl.abort(); }, ms) : null;
  const init = { method, credentials: 'same-origin', cache: 'no-store', signal: ctrl?.signal, headers: { Accept: 'application/json' } };
  if (method !== 'GET') {
    init.headers = { ...init.headers, ...MUTATION_HEADERS };
    init.body = JSON.stringify(body ?? {});
  }
  let res;
  try {
    res = await fetch(path, init);
  } catch {
    clearTimeout(timer);
    if (timedOut) {
      return { ok: false, status: 0, data: null, unreachable: false, timedOut: true, error: { code: 'CLIENT_TIMEOUT', message: CLIENT_TIMEOUT_MESSAGE } };
    }
    return { ok: false, status: 0, data: null, unreachable: true, timedOut: false, error: { code: 'API_UNREACHABLE', message: 'The VECTOR API could not be reached.' } };
  }
  let text = '';
  try {
    text = await res.text();
  } catch {
    clearTimeout(timer);
    if (timedOut) return { ok: false, status: res.status, data: null, unreachable: false, timedOut: true, error: { code: 'CLIENT_TIMEOUT', message: CLIENT_TIMEOUT_MESSAGE } };
  }
  clearTimeout(timer);
  let data = null;
  let parsed = false;
  if (text) {
    try { data = JSON.parse(text); parsed = true; } catch { /* non-JSON body */ }
  }
  if (res.ok) {
    if (!parsed) return { ok: false, status: res.status, data: null, unreachable: false, timedOut: false, error: { code: 'BAD_RESPONSE', message: 'The API returned a non-JSON response.' } };
    return { ok: true, status: res.status, data, unreachable: false, timedOut: false, error: null };
  }
  const apiErr = parsed && data && typeof data.error === 'object' && data.error ? data.error : null;
  // A gateway/static server without the API behind it: treat as unreachable rather than as an API verdict.
  const gateway = !apiErr && [502, 503, 504].includes(res.status);
  return {
    ok: false, status: res.status, data: parsed ? data : null, unreachable: gateway, timedOut: false,
    error: apiErr
      ? { code: String(apiErr.code || `HTTP_${res.status}`), message: String(apiErr.message || res.statusText || 'Request failed') }
      : { code: gateway ? 'API_UNREACHABLE' : `HTTP_${res.status}`, message: gateway ? `The VECTOR API is not available (HTTP ${res.status}).` : (res.statusText || 'Request failed') },
  };
}

export const get = (path, opts) => request('GET', path, undefined, opts);
export const post = (path, body, opts) => request('POST', path, body, opts);
export const put = (path, body, opts) => request('PUT', path, body, opts);

/** Build a query string from defined, non-empty params. */
export function qs(params) {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(params || {})) if (v !== undefined && v !== null && v !== '') u.set(k, String(v));
  const s = u.toString();
  return s ? `?${s}` : '';
}

// ---------------------------------------------------------------- client timeouts for long server operations

/** POST /api/replay/step: measured ~230-245 ms of server work per stepped minute with six agents; 500 ms/min + 30 s margin. */
export function stepTimeoutMs(minutes) {
  const m = Number.isFinite(minutes) && minutes > 0 ? minutes : 1;
  return 30000 + 500 * m;
}

/** POST /api/model/test: the server's probe is bounded at 30 s; give the client clear headroom. */
export const MODEL_TEST_TIMEOUT_MS = 45000;

/**
 * POST /api/assessments/run makes three sequential model calls, each bounded by the provider's timeoutMs
 * (GET /api/model -> limits.timeoutMs; 120 s by default). Bounded, never infinite.
 */
export function assessTimeoutMs(limits) {
  const per = Number.isFinite(limits?.timeoutMs) && limits.timeoutMs > 0 ? limits.timeoutMs : 120000;
  return 3 * (per + 5000) + 15000;
}
