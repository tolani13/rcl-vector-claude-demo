// VECTOR front-end bootstrap: hash routing, navigation state, status polling.
import { parseHash, tabFor, TITLES, isRouteHash } from './router.js';
import { store, subscribe, startPolling } from './store.js';
import { renderStatusStrip } from './status-strip.js';
import { clear } from './dom.js';
import { statusBlock } from './components.js';
import { deployNote } from './deploy-note.js';
import * as overview from './views/overview.js';
import * as research from './views/research.js';
import * as lab from './views/lab.js';
import * as agents from './views/agents.js';
import * as replay from './views/replay.js';
import * as journal from './views/journal.js';
import * as sources from './views/sources.js';
import * as about from './views/about.js';
import * as more from './views/more.js';
import * as real from './views/real.js';

const VIEWS = { overview, research, lab, agents, replay, journal, sources, about, more, real };
const main = document.getElementById('main');
const strip = document.getElementById('status-strip');
let current = null;
let firstRoute = true;
let lastRouteHash = '#/overview';

// Skip link: move focus to <main> without touching the hash (hash routing would treat "#main" as a page).
document.querySelector('a.skip')?.addEventListener('click', (e) => {
  e.preventDefault();
  main.focus({ preventScroll: true });
  main.scrollIntoView({ block: 'start' });
});

function updateNav(view) {
  for (const a of document.querySelectorAll('[data-nav]')) {
    if (a.dataset.nav === view) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  }
  const tab = tabFor(view);
  for (const a of document.querySelectorAll('[data-tab]')) {
    if (a.dataset.tab === tab) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  }
}

function route() {
  if (!isRouteHash(location.hash)) {
    // An in-page fragment (e.g. a bare "#main"): keep the current view, restore the route hash, focus the target.
    const target = document.getElementById(decodeURIComponent(location.hash.slice(1)));
    history.replaceState(null, '', lastRouteHash);
    if (current || !firstRoute) { (target || main).focus?.({ preventScroll: false }); return; }
  }
  if (!location.hash || location.hash === '#' || location.hash === '#/') {
    history.replaceState(null, '', '#/overview');
  }
  lastRouteHash = location.hash;
  const r = parseHash(location.hash);
  try { current?.destroy?.(); } catch (e) { console.error(e); }
  current = null;
  clear(main);
  updateNav(r.view);
  document.title = `${r.sym ? r.sym + ' · ' : ''}${TITLES[r.view]} · VECTOR`;
  if (r.notFound) {
    main.append(statusBlock('NOT FOUND', 'That page does not exist. Showing the overview instead.'));
  }
  try {
    current = VIEWS[r.view].render(main, { route: r, store }) || null;
  } catch (e) {
    console.error(e);
    main.append(statusBlock('ERROR', 'This view failed to render.', String(e && e.message ? e.message : e), { tone: 'bad' }));
  }
  const focusTarget = current?.focusTarget ?? null;
  if (focusTarget && focusTarget.isConnected) {
    // A view can hand focus to a specific element (e.g. the prefilled order ticket opened from a dossier).
    focusTarget.focus({ preventScroll: true });
    focusTarget.scrollIntoView({ block: 'start' });
  } else if (!firstRoute) {
    window.scrollTo(0, 0);
    const title = main.querySelector('[data-focus="title"]');
    (title || main).focus({ preventScroll: true });
  }
  firstRoute = false;
}

/** Sidebar deployment line: "Static preview" when this copy of the UI has no VECTOR API behind it. */
function drawDeployNote(st) {
  const text = deployNote({ apiReachable: st?.status ? true : null, deployment: st?.status?.app?.deployment ?? null }).short;
  for (const el of document.querySelectorAll('[data-deploy-note]')) if (el.textContent !== text) el.textContent = text;
}

subscribe((st, info) => {
  renderStatusStrip(strip, st);
  drawDeployNote(st);
  try { current?.onStatus?.(st, info); } catch (e) { console.error(e); }
});

window.addEventListener('hashchange', route);
renderStatusStrip(strip, store);
drawDeployNote(store);
route();
startPolling();

// A marker so manual/automated checks can confirm the whole module graph loaded.
document.documentElement.dataset.vector = 'ready';
