// Shared client state: the latest /api/status snapshot plus per-viewer UI preferences.
// Polls /api/status every ~3 s while the server-side replay is playing, every 15 s otherwise, 10 s while the API
// is unreachable, and not at all while the tab is hidden. (Replay advances server-side; the browser only observes.)
import { get } from './api.js';

const listeners = new Set();
const PREF_KEY = 'vector.prefs.v1';

function loadPrefs() {
  if (typeof window === 'undefined') return {}; // imported outside a browser (unit tests)
  try { return JSON.parse(window.localStorage.getItem(PREF_KEY) || '{}') || {}; } catch { return {}; }
}

export const store = {
  status: null,          // last successful /api/status body
  error: null,           // last error {code, message} or null
  lastOkWall: null,
  lastTryWall: null,
  prefs: loadPrefs(),    // { segment, portfolio }
};

export function setPref(k, v) {
  store.prefs = { ...store.prefs, [k]: v };
  try { window.localStorage.setItem(PREF_KEY, JSON.stringify(store.prefs)); } catch { /* storage unavailable: preference is per-page only */ }
}

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function emit(info) {
  for (const fn of listeners) {
    try { fn(store, info); } catch (e) { console.error('status listener failed', e); }
  }
}

let timer = null;
let inflight = null;

export async function refreshStatus() {
  if (inflight) return inflight;
  inflight = (async () => {
    store.lastTryWall = Date.now();
    const res = await get('/api/status');
    const prev = store.status;
    if (res.ok && res.data && typeof res.data === 'object') {
      store.status = res.data;
      store.error = null;
      store.lastOkWall = Date.now();
    } else {
      store.error = res.error || { code: 'API_UNREACHABLE', message: 'Status unavailable' };
    }
    const cur = store.status;
    emit({
      ok: res.ok,
      clockChanged: (prev?.replay?.clock ?? null) !== (cur?.replay?.clock ?? null),
      sessionChanged: (prev?.replay?.session_id ?? null) !== (cur?.replay?.session_id ?? null),
      firstLoad: !prev && !!cur,
    });
  })();
  try { await inflight; } finally { inflight = null; }
  schedule();
}

function schedule() {
  clearTimeout(timer);
  if (typeof document !== 'undefined' && document.hidden) return;
  const ms = store.error ? 10000 : store.status?.replay?.playing ? 3000 : 15000;
  timer = setTimeout(refreshStatus, ms);
}

export function startPolling() {
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) clearTimeout(timer);
    else refreshStatus();
  });
  refreshStatus();
}

/** Call after any mutation that changes server state (replay step/play, kill switch, agent control). */
export const pokeStatus = () => refreshStatus();
