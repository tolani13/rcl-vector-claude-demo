// Hash router (pure). Routes: #/overview, #/research, #/research/SYM, #/lab, #/agents, #/replay, #/journal,
// #/sources, #/about, #/more, #/real. Optional query after '?', e.g. #/lab?sym=ABC&p=sandbox.
export const ROUTES = Object.freeze(['overview', 'research', 'lab', 'agents', 'replay', 'journal', 'sources', 'about', 'more', 'real']);
export const SYM_RE = /^[A-Z][A-Z0-9.\-]{0,9}$/;

export const TITLES = Object.freeze({
  overview: 'Overview', research: 'Research', lab: 'Paper lab', agents: 'Agents', replay: 'Replay',
  journal: 'Journal', sources: 'Data sources', about: 'About', more: 'More', real: 'Real accounts',
});

function safeDecode(s) {
  try { return decodeURIComponent(s); } catch { return s; }
}

/** Normalise a user/URL-supplied symbol; returns null when it is not a plausible ticker string. */
export function normalizeSym(s) {
  if (typeof s !== 'string') return null;
  const c = s.trim().toUpperCase();
  return SYM_RE.test(c) ? c : null;
}

/**
 * Is this location hash an app route ("#/view...")? Anything else non-empty (e.g. "#main" from the skip link or an
 * in-page anchor) is an in-page fragment that must not replace the current view.
 */
export function isRouteHash(hash) {
  const s = String(hash || '');
  return s === '' || s === '#' || s.startsWith('#/');
}

export function parseHash(hash) {
  let s = String(hash || '').replace(/^#/, '');
  if (!s.startsWith('/')) s = '/' + s;
  const qi = s.indexOf('?');
  const pathPart = qi >= 0 ? s.slice(0, qi) : s;
  const queryPart = qi >= 0 ? s.slice(qi + 1) : '';
  const segs = pathPart.split('/').filter(Boolean).map(safeDecode);
  const first = segs[0] || 'overview';
  const known = ROUTES.includes(first);
  const view = known ? first : 'overview';
  const query = {};
  for (const [k, v] of new URLSearchParams(queryPart)) query[k] = v;
  let sym = null;
  let invalidSym = null;
  if (view === 'research' && segs[1]) {
    sym = normalizeSym(segs[1]);
    if (!sym) invalidSym = segs[1].slice(0, 24);
  }
  return { view, sym, invalidSym, query, notFound: !known };
}

/** Which phone tab is highlighted for a view. */
export function tabFor(view) {
  return ['overview', 'research', 'lab', 'journal'].includes(view) ? view : 'more';
}
