#!/usr/bin/env node
// VECTOR repeatable UI check (phones + desktop). Dependency-free: drives a locally installed Chrome or Edge in headless
// mode over the DevTools protocol, using Node's global WebSocket. Not part of `npm test` (it needs a browser and a
// running server).
//
//   node scripts/ui-check.mjs --base http://127.0.0.1:8795 [--allow-shared] [--browser <path>] [--flows 0]
//        [--sizes <list>] [--routes <list>] [--research-sym SYM] [--trade-sym SYM]
//        [--prepare-ds <dataset id> --prepare-to HH:MM]
//        [--out-dir receipts/ui] [--report receipts/ui-check.json] [--overflow-report <file.json>]
//   node scripts/ui-check.mjs --base http://127.0.0.1:8795 --shots-only --out-dir <dir> [--sizes <list>] [--routes <list>]
//        [--prepare-ds <dataset id> --prepare-to HH:MM] [--report <file.json>]
//   node scripts/ui-check.mjs --help
//
// Size matrix (--sizes takes a comma list of these names, or the groups phones / tablets / desktops / all; default all):
//   phones   360x780, 390x844, 430x932         touch, mobile viewport, deviceScaleFactor 2
//   tablets  768x1024, 1024x1366 (portrait), 1024x768 (landscape)   touch, mobile viewport, deviceScaleFactor 2
//   desktops 1440x900, 1920x1080               mouse, deviceScaleFactor 1
// Routes (--routes takes a comma list, with or without a leading "#/"; default all): overview, research, dossier
// (= research/<symbol chosen at run time>; research/<SYM> picks one), lab, agents, replay, journal, sources, about, more.
// Any other route string is loaded as given (e.g. "lab?p=sandbox").
//
// What it does, for each selected viewport and route: loads the page, waits for data to render, saves a PNG to
// <out-dir>/<size>-<route>.png and records assertions:
//   no_horizontal_overflow   documentElement.scrollWidth <= innerWidth (and <= clientWidth, at visual scale 1)
//   overflow_tripwire        BUILD-FAILING. documentElement.scrollWidth and body.scrollWidth must not exceed
//                            window.innerWidth (nor the root clientWidth beside a desktop scrollbar), and the layout
//                            viewport must not have been widened past the emulated width (visual scale 1). On failure
//                            the offending elements (tag, class, right edge) are reported.
//   overflow_tripwire_expanded  the same tripwire again after opening every <details> element on the page
//   status_strip_complete    data mode, PAPER ONLY, model status and kill-switch chips are visible and fully on screen
//   bottom_nav_44px          (phones) every bottom-nav link is visible and >= 44 px tall
//   tablet_nav_44px          (tablets) the visible primary navigation (sidebar or bottom nav) has >= 5 targets and
//                            every link / button in it is >= 44 x 44 px
//   desktop_sidebar_visible  (desktops) sidebar shown, bottom nav hidden
//   body_font_16px           computed body font-size >= 16 px
//   form_controls_16px       (phones and tablets, when the route has form controls) inputs/selects/textareas >= 16 px
//   status_strip_rows        the status strip wraps to at most 3 rows on phones (16px data-truth chips), 2 on tablets
//   no_render_artifacts      main text has no "[object Object]", "undefined" or "NaN"
//   no_uncaught_errors       no uncaught exception or console.error while the route loaded
// Then (unless --flows 0) it runs, through the real UI with CDP mouse input and typed text:
//   * a PHONE (390x844) sandbox BUY and SELL: fill the ticket, review (screenshot of the confirmation step), confirm
//     (screenshot of the policy gate result), step the replay one minute in the Replay view until the order fills
//     (checked through /api/portfolios/sandbox), then the same for the SELL of the filled quantity;
//   * a narrow (360x780) Replay view (paused, playing, paused again) and the three-lens assessment panel of a dossier.
//   Each flow runs only when its size is among the selected --sizes.
// Every assertion is written to the --report JSON; --overflow-report additionally writes every tripwire check with the
// offending elements of each failure. Exit code 0 = all assertions passed, 1 = some failed (or a fatal error),
// 2 = refused, 3 = the overflow tripwire failed (whatever else failed).
//
// --shots-only captures viewport screenshots of the selected sizes and routes into --out-dir (required) for
// before/after comparisons: no flows and no assertions. It writes <out-dir>/shots-manifest.json (or --report) with
// the server status, a hash of every web/ file and, unasserted, each page's widths.
//
// The flows place paper orders in the sandbox and move the replay clock, so the script refuses the shared development
// server port 8787 unless --allow-shared is given, and always refuses port 8790 (it belongs to another project). Run it
// against your own server on a COPY of the database:
//   node -e "const {DatabaseSync}=require('node:sqlite');new DatabaseSync('data/vector.db',{readOnly:true}).exec(\"VACUUM INTO 'data/qa-copy.db'\")"
//   VECTOR_PORT=8795 VECTOR_DB=data/qa-copy.db npm start
// The script contains no market data: every symbol, price and quantity is read at run time from the server.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

// ------------------------------------------------------------------------------------------------ arguments / safety
const argv = process.argv.slice(2);
const has = (k) => argv.includes(`--${k}`);
const opt = (k, d = null) => { const i = argv.indexOf(`--${k}`); return i >= 0 && argv[i + 1] !== undefined && !argv[i + 1].startsWith('--') ? argv[i + 1] : d; };
function refuse(msg) { console.error(`ui-check: ${msg}`); process.exit(2); }
if (has('help') || argv.includes('-h')) {
  const src = fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n');
  console.log(src.slice(1, src.findIndex((l) => l.startsWith('import '))).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
  process.exit(0);
}

const baseArg = opt('base');
if (!baseArg) refuse('--base <server URL> is required, e.g. --base http://127.0.0.1:8795');
let baseUrl;
try { baseUrl = new URL(baseArg); } catch { refuse(`--base is not a URL: ${baseArg}`); }
if (!/^https?:$/.test(baseUrl.protocol)) refuse('--base must be an http(s) URL');
const basePort = baseUrl.port || (baseUrl.protocol === 'https:' ? '443' : '80');
if (basePort === '8790') refuse('port 8790 belongs to an unrelated project; never point this script at it.');
if (basePort === '8787' && !has('allow-shared')) {
  refuse('port 8787 is the shared development server. This check places sandbox paper orders and moves the replay clock. '
    + 'Start your own server on a database copy (VECTOR_PORT / VECTOR_DB) or pass --allow-shared.');
}
const BASE = baseUrl.origin;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHOTS_ONLY = has('shots-only');
if (SHOTS_ONLY && !opt('out-dir')) refuse('--shots-only needs --out-dir <dir> (it must not overwrite the receipt screenshots in receipts/ui)');
const OUT_DIR = path.resolve(ROOT, opt('out-dir', 'receipts/ui'));
const REPORT = path.resolve(ROOT, opt('report', SHOTS_ONLY ? path.join(OUT_DIR, 'shots-manifest.json') : 'receipts/ui-check.json'));
const OVERFLOW_REPORT = opt('overflow-report') ? path.resolve(ROOT, opt('overflow-report')) : null;
const FLOWS = !SHOTS_ONLY && opt('flows', '1') !== '0';
const BROWSER = opt('browser', ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find((p) => fs.existsSync(p)));
if (!BROWSER || !fs.existsSync(BROWSER)) refuse('no Chrome or Edge found; pass --browser <path to chrome.exe / msedge.exe>');

// kind: 'phone' and 'tablet' are touch devices with a mobile viewport; 'desktop' is a mouse device with scrollbars.
const ALL_VIEWPORTS = [
  { name: '360x780', width: 360, height: 780, kind: 'phone', mobile: true, dsf: 2 },
  { name: '390x844', width: 390, height: 844, kind: 'phone', mobile: true, dsf: 2 },
  { name: '430x932', width: 430, height: 932, kind: 'phone', mobile: true, dsf: 2 },
  { name: '768x1024', width: 768, height: 1024, kind: 'tablet', orientation: 'portrait', mobile: true, dsf: 2 },
  { name: '1024x1366', width: 1024, height: 1366, kind: 'tablet', orientation: 'portrait', mobile: true, dsf: 2 },
  { name: '1024x768', width: 1024, height: 768, kind: 'tablet', orientation: 'landscape', mobile: true, dsf: 2 },
  { name: '1440x900', width: 1440, height: 900, kind: 'desktop', mobile: false, dsf: 1 },
  { name: '1920x1080', width: 1920, height: 1080, kind: 'desktop', mobile: false, dsf: 1 },
];
const STATIC_ROUTES = ['overview', 'research', 'RESEARCH_SYM', 'lab', 'agents', 'replay', 'journal', 'sources', 'about', 'more'];

function parseSizes(spec) {
  if (!spec || spec.trim().toLowerCase() === 'all') return ALL_VIEWPORTS;
  const groups = { phone: 'phone', phones: 'phone', tablet: 'tablet', tablets: 'tablet', desktop: 'desktop', desktops: 'desktop' };
  const picked = new Set();
  for (const tok of spec.split(',').map((s) => s.trim().toLowerCase().replace('×', 'x')).filter(Boolean)) {
    const hit = groups[tok] ? ALL_VIEWPORTS.filter((v) => v.kind === groups[tok]) : ALL_VIEWPORTS.filter((v) => v.name === tok);
    if (!hit.length) refuse(`unknown size "${tok}" in --sizes; known: ${ALL_VIEWPORTS.map((v) => v.name).join(', ')}, or phones / tablets / desktops / all`);
    for (const v of hit) picked.add(v);
  }
  if (!picked.size) refuse('--sizes selected nothing');
  return ALL_VIEWPORTS.filter((v) => picked.has(v));
}
function parseRoutes(spec) {
  if (!spec || spec.trim().toLowerCase() === 'all') return STATIC_ROUTES;
  const out = [];
  for (let tok of spec.split(',').map((s) => s.trim()).filter(Boolean)) {
    tok = tok.replace(/^#?\/?/, '');
    if (/^(dossier|research-sym|RESEARCH_SYM)$/i.test(tok)) tok = 'RESEARCH_SYM';
    if (!tok) continue;
    if (!/^[A-Za-z0-9/?=&._%-]+$/.test(tok)) {
      refuse(`unsupported characters in route "${tok}" in --routes${/^[A-Za-z]:\//.test(tok) ? ' (Git Bash rewrote a "/..." argument into a Windows path: '
        + 'drop the "#/" prefix, e.g. --routes overview,replay, or set MSYS_NO_PATHCONV=1)' : ''}`);
    }
    if (!out.includes(tok)) out.push(tok);
  }
  if (!out.length) refuse('--routes selected nothing');
  return out;
}
const VIEWPORTS = parseSizes(opt('sizes'));
const ROUTES = parseRoutes(opt('routes'));
const FULL_MATRIX = VIEWPORTS.length === ALL_VIEWPORTS.length && ROUTES.length === STATIC_ROUTES.length && STATIC_ROUTES.every((r) => ROUTES.includes(r));
const shotName = (vp, route) => `${vp.name}-${route.replace(/\//g, '-').replace(/[^A-Za-z0-9._-]/g, '-')}.png`;
// The interaction flows are tied to one size each; a flow runs only when that size is selected.
const FLOW_SIZES = { phone: '390x844', narrow: '360x780' };
const flowWanted = (k) => FLOWS && VIEWPORTS.some((v) => v.name === FLOW_SIZES[k]);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

// ------------------------------------------------------------------------------------------------ server API (HTTP)
async function api(method, p, body) {
  const init = { method, headers: { accept: 'application/json' } };
  if (method !== 'GET') {
    init.headers = { ...init.headers, 'content-type': 'application/json', 'x-vector-client': 'web' };
    init.body = JSON.stringify(body ?? {});
  }
  const res = await fetch(BASE + p, init);
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, json, text };
}
const etHm = (ms) => (Number.isFinite(ms) ? new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(ms) : null);
const getStatus = async () => (await api('GET', '/api/status')).json;

/** Optional: reset the replay to a dataset and step to HH:MM ET (agents stay PAUSED). */
async function prepare(ds, toHm) {
  const r = await api('POST', '/api/replay/reset', { ds });
  if (r.status !== 200) throw new Error(`reset failed: ${r.status} ${r.text.slice(0, 200)}`);
  const [hh, mm] = toHm.split(':').map(Number);
  const clockHm = () => { const [h, m] = etHm(r.json.state.clock).split(':').map(Number); return h * 60 + m; };
  let minutes = hh * 60 + mm - clockHm();
  while (minutes > 0) {
    const n = Math.min(minutes, 60);
    const s = await api('POST', '/api/replay/step', { minutes: n });
    if (s.status !== 200) throw new Error(`step failed: ${s.status} ${s.text.slice(0, 200)}`);
    minutes -= n;
  }
  const st = await getStatus();
  return { ds, session_id: st?.replay?.session_id ?? null, clockEt: etHm(st?.replay?.clock) };
}

/** Symbols are chosen at run time from the server's own as-of scanner; nothing is hard-coded. */
async function pickSymbols() {
  const fixedResearch = opt('research-sym');
  const fixedTrade = opt('trade-sym');
  const micro = (await api('GET', '/api/research/opportunities?segment=micro&limit=60')).json;
  const research = fixedResearch ?? (micro?.rows ?? []).find((r) => r.score !== null && !r.nonCommon && r.quote?.twoSided)?.sym ?? micro?.rows?.[0]?.sym ?? null;
  let trade = fixedTrade;
  let tradeBasis = fixedTrade ? 'given with --trade-sym' : null;
  if (!trade) {
    // A liquid, two-sided, fresh quote so a small market order can be estimated-filled in the next minute.
    for (const segment of ['large', 'low', 'micro']) {
      const o = (await api('GET', `/api/research/opportunities?segment=${segment}&limit=200`)).json;
      const ok = (o?.rows ?? []).filter((r) => r.quote?.twoSided && !r.quote.halted && r.quote.ageMs <= 60_000 && r.quote.spreadBps !== null
        && r.quote.spreadBps <= 50 && r.quote.ask > 0 && r.quote.ask <= 3_000_000 && r.quote.askSize >= 100 && (r.metrics?.tradesW ?? 0) >= 20);
      ok.sort((a, b) => (b.metrics.tradesW - a.metrics.tradesW));
      if (ok.length) {
        trade = ok[0].sym;
        tradeBasis = `segment ${segment}: two-sided IEX quote <= 60 s old, spread ${ok[0].quote.spreadBps} bps, ${ok[0].metrics.tradesW} trades in the scan window (most active qualifying row)`;
        break;
      }
    }
  }
  return { research, trade, tradeBasis };
}

// ------------------------------------------------------------------------------------------------ browser / CDP
const freePort = () => new Promise((res, rej) => {
  const s = net.createServer();
  s.on('error', rej);
  s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
});

let ws = null;
let nextId = 0;
const pending = new Map();
const waiters = [];
let pageErrors = [];

function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve, reject, method });
    ws.send(JSON.stringify({ id, method, params }));
  });
}
function waitEvent(method, timeoutMs = 20_000) {
  return new Promise((resolve) => {
    const w = { method, fn: (p) => { clearTimeout(t); resolve(p); } };
    const t = setTimeout(() => { const i = waiters.indexOf(w); if (i >= 0) waiters.splice(i, 1); resolve(null); }, timeoutMs);
    waiters.push(w);
  });
}
async function evaluate(expr) {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(`page evaluate failed: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
  return r.result.value;
}

async function connect(cdpPort) {
  let target = null;
  for (let i = 0; i < 75 && !target; i++) {
    try { target = (await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json()).find((t) => t.type === 'page'); } catch { /* starting */ }
    if (!target) await sleep(200);
  }
  if (!target) throw new Error('the browser DevTools endpoint did not come up');
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('DevTools WebSocket failed')); });
  ws.onmessage = (ev) => {
    const m = JSON.parse(typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString());
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id);
      pending.delete(m.id);
      if (m.error) p.reject(new Error(`${p.method}: ${m.error.message}`)); else p.resolve(m.result);
      return;
    }
    if (!m.method) return;
    if (m.method === 'Runtime.exceptionThrown') pageErrors.push(`uncaught: ${m.params.exceptionDetails?.exception?.description ?? m.params.exceptionDetails?.text ?? 'exception'}`.slice(0, 300));
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') pageErrors.push(`console.error: ${m.params.args.map((a) => a.value ?? a.description).join(' ')}`.slice(0, 300));
    if (m.method === 'Page.javascriptDialogOpening') send('Page.handleJavaScriptDialog', { accept: false }).catch(() => {});
    for (let i = waiters.length - 1; i >= 0; i--) if (waiters[i].method === m.method) waiters.splice(i, 1)[0].fn(m.params);
  };
  await send('Page.enable');
  await send('Runtime.enable');
}

async function setViewport(vp) {
  await send('Emulation.setDeviceMetricsOverride', { width: vp.width, height: vp.height, deviceScaleFactor: vp.dsf, mobile: vp.mobile, screenWidth: vp.width, screenHeight: vp.height });
  await send('Emulation.setTouchEmulationEnabled', vp.mobile ? { enabled: true, maxTouchPoints: 5 } : { enabled: false });
}

/** Wait until the app module graph is ready and no loading placeholder is left in <main> (bounded). */
async function settle(maxMs = 12_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < maxMs) {
    const busy = await evaluate(`document.readyState !== 'complete' || document.documentElement.dataset.vector !== 'ready' || !!document.querySelector('main .loading')`).catch(() => true);
    if (!busy) break;
    await sleep(150);
  }
  await sleep(400);
}

let navSeq = 0;
async function go(route) {
  const loaded = waitEvent('Page.loadEventFired');
  await send('Page.navigate', { url: `${BASE}/?uicheck=${Date.now()}-${++navSeq}#/${route}` });
  await loaded;
  await settle();
}

async function screenshot(file) {
  const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  fs.writeFileSync(path.join(OUT_DIR, file), Buffer.from(r.data, 'base64'));
  return path.relative(ROOT, path.join(OUT_DIR, file)).replace(/\\/g, '/');
}

// ------------------------------------------------------------------------------------------------ in-page measurement
const MEASURE = String.raw`(() => {
  const de = document.documentElement, vw = window.innerWidth, vh = window.innerHeight;
  const cs = (el) => getComputedStyle(el);
  const visible = (el) => { if (!el) return false; const r = el.getBoundingClientRect(); const s = cs(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
  const onScreen = (el) => { const r = el.getBoundingClientRect(); return r.left >= -1 && r.top >= -1 && r.right <= vw + 1 && r.bottom <= vh + 1; };
  const desc = (el) => el.tagName.toLowerCase() + (typeof el.className === 'string' && el.className.trim() ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.') : '');
  // Elements sticking out of the viewport that are not inside a horizontally scrolling / clipping container.
  const clipped = (el) => { for (let p = el.parentElement; p && p !== document.body && p !== de; p = p.parentElement) if (cs(p).overflowX !== 'visible') return true; return false; };
  // Content of a closed <details> keeps a layout box but cannot widen the page: not an offender.
  const hiddenByDetails = (el) => { for (let d = el.closest('details:not([open])'); d; d = d.parentElement && d.parentElement.closest('details:not([open])')) { const s = d.querySelector(':scope > summary'); if (!s || !s.contains(el)) return true; } return false; };
  const offenders = [];
  for (const el of document.body.querySelectorAll('*')) {
    if (offenders.length >= 5) break;
    if (!visible(el) || cs(el).position === 'fixed') continue;
    const r = el.getBoundingClientRect();
    if (r.right > Math.min(vw, de.clientWidth || vw) + 1 && !clipped(el) && !hiddenByDetails(el)) offenders.push(desc(el) + ' right=' + Math.round(r.right));
  }
  const strip = document.getElementById('status-strip');
  const chips = strip ? [...strip.querySelectorAll('.chip')].filter(visible) : [];
  const chipInfo = chips.map((c) => ({ id: c.getAttribute('data-chip') || null, key: (c.querySelector('.chip-k')?.innerText || '').trim(), value: (c.querySelector('.chip-v')?.innerText || '').trim(), onScreen: onScreen(c) }));
  // Prefer the stable data-chip hook (the visible key differs by width, e.g. 'Data' / 'PARTIAL' on phones); fall back to the key text.
  const find = (id, re) => chipInfo.find((c) => c.id === id) || chipInfo.find((c) => re.test(c.key));
  const paper = chipInfo.find((c) => /PAPER ONLY/i.test(c.value));
  // Rows: chip tops clustered with a 4 px tolerance (chips in one row can differ by a fraction of a pixel).
  let rows = 0, rowTop = -Infinity;
  for (const t of chips.map((c) => c.getBoundingClientRect().top).sort((a, b) => a - b)) if (t - rowTop > 4) { rows++; rowTop = t; }
  const tab = document.querySelector('.tabbar');
  const tabLinks = tab && visible(tab) ? [...tab.querySelectorAll('a, button')].map((a) => { const r = a.getBoundingClientRect(); return { text: a.innerText.trim(), w: Math.round(r.width), h: Math.round(r.height), visible: visible(a) }; }) : [];
  const forms = [...document.querySelectorAll('main input:not([type=hidden]):not([type=checkbox]):not([type=radio]), main select, main textarea')].filter(visible);
  const mainText = (document.querySelector('main')?.innerText || '');
  const artifacts = [...new Set((mainText.match(/\[object Object\]|\bundefined\b|\bNaN\b/g) || []))];
  const sidebar = document.querySelector('.sidebar');
  const sideLinks = sidebar && visible(sidebar) ? [...sidebar.querySelectorAll('a, button')].filter(visible).map((a) => { const r = a.getBoundingClientRect();
    return { text: (a.getAttribute('aria-label') || a.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 40), el: desc(a), w: Math.round(r.width), h: Math.round(r.height), visible: true }; }) : [];
  return {
    innerWidth: vw, innerHeight: vh, clientWidth: de.clientWidth, scrollWidth: de.scrollWidth, bodyScrollWidth: document.body.scrollWidth,
    visualScale: window.visualViewport ? Math.round(window.visualViewport.scale * 1000) / 1000 : 1, offenders,
    strip: {
      height: strip ? Math.round(strip.getBoundingClientRect().height) : null, rows, chips: chipInfo,
      dataMode: find('data', /^(Data|Partial)$/i) || null, paperOnly: paper || null, model: find('model', /^Model$/i) || null, kill: find('kill', /^Kill( switch)?$/i) || null,
    },
    tabbar: { visible: tabLinks.length > 0, links: tabLinks, minHeight: tabLinks.length ? Math.min(...tabLinks.map((l) => l.h)) : null },
    sidebarVisible: visible(sidebar),
    sidebar: { visible: visible(sidebar), links: sideLinks, minHeight: sideLinks.length ? Math.min(...sideLinks.map((l) => l.h)) : null },
    bodyFontPx: parseFloat(cs(document.body).fontSize),
    formControls: forms.length, formMinFontPx: forms.length ? Math.min(...forms.map((f) => parseFloat(cs(f).fontSize))) : null,
    artifacts, title: document.title, docHeight: de.scrollHeight,
  };
})()`;

// Overflow tripwire: page-level widths plus every element whose right edge passes the viewport and is not inside a
// clipping / scrolling ancestor (those cannot widen the page). "roots" are offenders whose parent does not overflow
// (where the overflow enters the layout); "widest" are offenders without overflowing descendants, furthest right first.
const TRIPWIRE = String.raw`(() => {
  const de = document.documentElement, body = document.body, vw = window.innerWidth;
  const limit = Math.min(vw, de.clientWidth || vw);
  const sx = window.scrollX || 0;
  const cs = (el) => getComputedStyle(el);
  const cls = (el) => String((typeof el.className === 'string' ? el.className : el.getAttribute('class')) || '').trim().split(/\s+/).filter(Boolean).slice(0, 3).join('.');
  const desc = (el) => el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (cls(el) ? '.' + cls(el) : '');
  const clipped = (el) => { for (let p = el.parentElement; p && p !== body && p !== de; p = p.parentElement) if (cs(p).overflowX !== 'visible') return true; return false; };
  const fixedIn = (el) => { for (let p = el; p && p !== body && p !== de; p = p.parentElement) if (cs(p).position === 'fixed') return true; return false; };
  // Content of a closed <details> keeps a layout box but cannot widen the page: not an offender.
  const hiddenByDetails = (el) => { for (let d = el.closest('details:not([open])'); d; d = d.parentElement && d.parentElement.closest('details:not([open])')) { const s = d.querySelector(':scope > summary'); if (!s || !s.contains(el)) return true; } return false; };
  const over = new Map();
  for (const el of body.querySelectorAll('*')) {
    const r = el.getBoundingClientRect();
    const right = r.right + sx;
    if (right <= limit + 0.5 || clipped(el) || hiddenByDetails(el)) continue;
    let depth = 0; for (let p = el; p && p !== body; p = p.parentElement) depth++;
    const trail = []; for (let p = el.parentElement; p && p !== body && trail.length < 4; p = p.parentElement) trail.unshift(desc(p));
    over.set(el, { el: desc(el), tag: el.tagName.toLowerCase(), cls: String((typeof el.className === 'string' ? el.className : el.getAttribute('class')) || '').trim().replace(/\s+/g, ' ') || null, right: Math.round(right), left: Math.round(r.left + sx),
      width: Math.round(r.width), depth, path: trail.join(' > '), fixed: fixedIn(el), hidden: cs(el).visibility === 'hidden',
      text: String(el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 48) });
  }
  const hasOverChild = new Set();
  for (const el of over.keys()) for (let p = el.parentElement; p && p !== body; p = p.parentElement) if (over.has(p)) hasOverChild.add(p);
  const byRight = (a, b) => (b.right - a.right) || (b.width - a.width) || (b.depth - a.depth);
  const roots = [...over.entries()].filter(([el]) => !over.has(el.parentElement)).map(([, v]) => v).sort(byRight).slice(0, 8);
  const widest = [...over.entries()].filter(([el]) => !hasOverChild.has(el)).map(([, v]) => v).sort(byRight).slice(0, 8);
  return {
    innerWidth: vw, clientWidth: de.clientWidth, scrollWidth: de.scrollWidth, bodyScrollWidth: body.scrollWidth, limit, scrollX: sx,
    visualScale: window.visualViewport ? Math.round(window.visualViewport.scale * 1000) / 1000 : 1,
    details: { total: document.querySelectorAll('details').length, open: document.querySelectorAll('details[open]').length },
    offenderCount: over.size, roots, widest,
  };
})()`;

const results = { assertions: [], routes: [], flows: [], screenshots: [], tripwire: [] };
function assert(group, viewport, route, name, pass, detail) {
  results.assertions.push({ group, viewport, route, name, pass: !!pass, detail });
  return !!pass;
}

const fmtEl = (o) => `${o.el} right=${o.right}${o.fixed ? ' (fixed)' : ''}`;
function judgeTripwire(vp, route, t, name) {
  const r = `#/${route}`;
  const reasons = [];
  if (t.scrollWidth > t.innerWidth) reasons.push(`documentElement.scrollWidth ${t.scrollWidth} > innerWidth ${t.innerWidth}`);
  else if (t.scrollWidth > t.clientWidth) reasons.push(`documentElement.scrollWidth ${t.scrollWidth} > clientWidth ${t.clientWidth} (the root's visible width)`);
  if (t.bodyScrollWidth > t.innerWidth) reasons.push(`body.scrollWidth ${t.bodyScrollWidth} > innerWidth ${t.innerWidth}`);
  else if (t.bodyScrollWidth > t.clientWidth) reasons.push(`body.scrollWidth ${t.bodyScrollWidth} > clientWidth ${t.clientWidth} (the root's visible width)`);
  if (t.innerWidth !== vp.width) reasons.push(`layout viewport is ${t.innerWidth} px wide, emulated ${vp.width} px (content widened it)`);
  if (t.visualScale !== 1) reasons.push(`visual scale ${t.visualScale} (page zoomed out to fit wide content)`);
  const pass = reasons.length === 0;
  const expanded = name === 'overflow_tripwire_expanded';
  const base = `scrollWidth ${t.scrollWidth}, body ${t.bodyScrollWidth}, innerWidth ${t.innerWidth}, clientWidth ${t.clientWidth}${expanded ? `; ${t.details.open}/${t.details.total} <details> open` : ''}`;
  assert('tripwire', vp.name, r, name, pass, pass ? base
    : `${reasons.join('; ')}${expanded ? ` (${t.details.open}/${t.details.total} <details> open)` : ''}; widest: ${t.widest.slice(0, 4).map(fmtEl).join(', ') || 'no element found'}; enters at: ${t.roots.slice(0, 3).map(fmtEl).join(', ') || 'n/a'}`);
  results.tripwire.push({ viewport: vp.name, kind: vp.kind, route: r, check: name, pass, reasons, scrollWidth: t.scrollWidth, bodyScrollWidth: t.bodyScrollWidth,
    innerWidth: t.innerWidth, clientWidth: t.clientWidth, visualScale: t.visualScale, details: t.details, offenderCount: t.offenderCount,
    ...(pass ? {} : { roots: t.roots, widest: t.widest }) });
  return pass;
}

/** Open every <details> on the page (repeatedly, for disclosures rendered inside opened ones) and let it settle. */
async function expandAllDetails() {
  let opened = 0;
  for (let pass = 0; pass < 3; pass++) {
    const n = await evaluate(`(() => { let n = 0; for (const d of document.querySelectorAll('details:not([open])')) { d.open = true; n++; } return n; })()`);
    opened += n;
    if (!n) break;
    await evaluate('new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))');
    await sleep(250);
  }
  const t0 = Date.now();
  while (Date.now() - t0 < 4_000 && await evaluate(`!!document.querySelector('main .loading')`).catch(() => false)) await sleep(150);
  await sleep(200);
  return opened;
}

function judgeRoute(vp, route, m, errors) {
  const r = `#/${route}`;
  const g = 'route';
  assert(g, vp.name, r, 'no_horizontal_overflow',
    m.scrollWidth <= m.innerWidth && m.scrollWidth <= m.clientWidth && m.visualScale === 1 && m.innerWidth === vp.width,
    `scrollWidth ${m.scrollWidth}, innerWidth ${m.innerWidth}, clientWidth ${m.clientWidth}, visual scale ${m.visualScale}${m.offenders.length ? `; sticking out: ${m.offenders.join(', ')}` : ''}`);
  const s = m.strip;
  const chipOk = (c) => !!c && !!c.value && c.onScreen;
  assert(g, vp.name, r, 'status_strip_complete', chipOk(s.dataMode) && chipOk(s.paperOnly) && chipOk(s.model) && chipOk(s.kill),
    `data mode: ${s.dataMode ? `${s.dataMode.value}${s.dataMode.onScreen ? '' : ' (off screen)'}` : 'MISSING'}; paper: ${s.paperOnly ? s.paperOnly.value : 'MISSING'}; `
    + `model: ${s.model ? s.model.value : 'MISSING'}; kill switch: ${s.kill ? s.kill.value : 'MISSING'}`);
  if (vp.kind === 'phone') {
    const links = m.tabbar.links;
    assert(g, vp.name, r, 'bottom_nav_44px', m.tabbar.visible && links.length >= 5 && links.every((l) => l.visible && l.h >= 44),
      m.tabbar.visible ? `${links.length} links; heights ${links.map((l) => `${l.text} ${l.h}px`).join(', ')}` : 'bottom nav not visible');
  } else if (vp.kind === 'tablet') {
    // Touch tablet: whichever primary navigation the layout shows, every target in it must be finger-sized.
    const nav = m.tabbar.visible ? { where: 'bottom nav', links: m.tabbar.links } : m.sidebar.visible ? { where: 'sidebar', links: m.sidebar.links } : null;
    const small = nav ? nav.links.filter((l) => !l.visible || l.h < 44 || l.w < 44) : [];
    assert(g, vp.name, r, 'tablet_nav_44px', !!nav && nav.links.length >= 5 && small.length === 0,
      nav ? `${nav.where}: ${nav.links.length} targets; ${small.length ? `under 44x44 px: ${small.map((l) => `"${l.text}" ${l.el ?? ''} ${l.w}x${l.h}px`).join(', ')}` : `all >= 44x44 px (smallest ${Math.min(...nav.links.map((l) => l.h))}px tall)`}`
        : 'no primary navigation visible (neither sidebar nor bottom nav)');
  }
  if (vp.kind === 'phone' || vp.kind === 'tablet') {
    // Phones carry the data-truth chips at >= 16px (owner rule, ui-polish-v1), which needs up to three rows at 360-430px;
    // tablets keep the two-row budget.
    const maxRows = vp.kind === 'phone' ? 3 : 2;
    assert(g, vp.name, r, 'status_strip_rows', s.rows >= 1 && s.rows <= maxRows, `${s.rows} row(s) (max ${maxRows}), ${s.height}px tall`);
    if (m.formControls > 0) assert(g, vp.name, r, 'form_controls_16px', m.formMinFontPx >= 16, `${m.formControls} form controls; smallest font ${m.formMinFontPx}px`);
  } else {
    assert(g, vp.name, r, 'desktop_sidebar_visible', m.sidebarVisible && !m.tabbar.visible, `sidebar ${m.sidebarVisible ? 'visible' : 'hidden'}; bottom nav ${m.tabbar.visible ? 'visible' : 'hidden'}`);
  }
  assert(g, vp.name, r, 'body_font_16px', m.bodyFontPx >= 16, `body font-size ${m.bodyFontPx}px`);
  assert(g, vp.name, r, 'no_render_artifacts', m.artifacts.length === 0, m.artifacts.length ? `found ${m.artifacts.join(', ')}` : 'none');
  assert(g, vp.name, r, 'no_uncaught_errors', errors.length === 0, errors.length ? errors.slice(0, 3).join(' | ') : 'none');
}

// ------------------------------------------------------------------------------------------------ interaction helpers
const byText = (sel, text) => `() => [...document.querySelectorAll(${JSON.stringify(sel)})].find((e) => e.offsetParent !== null && e.textContent.replace(/\\s+/g, ' ').trim().includes(${JSON.stringify(text)}))`;
const bySel = (sel) => `() => [...document.querySelectorAll(${JSON.stringify(sel)})].find((e) => e.offsetParent !== null)`;

async function centerOf(finder) {
  return evaluate(`(() => { const el = (${finder})(); if (!el) return null; el.scrollIntoView({ block: 'center', inline: 'nearest' });
    const r = el.getBoundingClientRect(); const x = r.left + r.width / 2, y = r.top + r.height / 2; const top = document.elementFromPoint(x, y);
    return { x, y, w: Math.round(r.width), h: Math.round(r.height), disabled: !!el.disabled, covered: !(top && (top === el || el.contains(top))),
      coveredBy: top && top !== el && !el.contains(top) ? top.tagName.toLowerCase() + '.' + (top.className || '') : null }; })()`);
}
async function tap(finder, what, steps) {
  if (!(await centerOf(finder))) throw new Error(`not found: ${what}`);
  await sleep(200);
  const c = await centerOf(finder);
  steps.push({ action: 'tap', what, w: c.w, h: c.h, covered: c.covered, coveredBy: c.coveredBy });
  if (c.disabled) throw new Error(`disabled: ${what}`);
  for (const type of ['mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, x: c.x, y: c.y, button: 'left', clickCount: 1 });
}
async function typeInto(finder, text, what, steps) {
  await tap(finder, what, steps);
  await evaluate(`(() => { const el = (${finder})(); el.focus(); el.value = ''; el.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await send('Input.insertText', { text });
  steps.push({ action: 'type', what, text });
}
async function waitFor(finder, ms = 15_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (await evaluate(`!!(${finder})()`)) return true; await sleep(200); }
  return false;
}
/** Scroll an element to just below the sticky status strip so a screenshot shows the step it documents. */
async function reveal(finder) {
  await evaluate(`(() => { const el = (${finder})(); if (!el) return false; el.scrollIntoView({ block: 'start' });
    const s = document.querySelector('.status-wrap'); window.scrollBy(0, -((s ? Math.max(0, s.getBoundingClientRect().bottom) : 0) + 8)); return true; })()`);
  await sleep(300);
}
const textOf = (finder, max = 700) => evaluate(`(() => { const el = (${finder})(); return el ? el.innerText.replace(/\\s+/g, ' ').trim().slice(0, ${max}) : null; })()`);
const overflowNow = async (vp) => { const m = await evaluate(MEASURE); return { ok: m.scrollWidth <= m.innerWidth && m.scrollWidth <= m.clientWidth && m.visualScale === 1 && m.innerWidth === vp.width, scrollWidth: m.scrollWidth, innerWidth: m.innerWidth }; };

/** Sandbox fills for a symbol, read from the API (the source of truth for whether the paper order filled). */
async function sandboxFills(sym) {
  const p = (await api('GET', '/api/portfolios/sandbox')).json;
  return (p?.fills ?? []).filter((f) => f.sym === sym);
}
async function stepInReplayView(vp, steps) {
  const before = (await getStatus())?.replay?.clock;
  await go('replay');
  await tap(`() => document.querySelector('button[aria-label="Step 1 minute"]')`, 'Replay: Step 1 minute', steps);
  const t0 = Date.now();
  let after = before;
  while (Date.now() - t0 < 30_000) { after = (await getStatus())?.replay?.clock; if (after > before) break; await sleep(300); }
  await settle();
  return { beforeEt: etHm(before), afterEt: etHm(after), advanced: after > before };
}

async function orderFlow(vp, sym, side, qty, n0, flow) {
  const steps = flow.steps;
  const SIDE = side.toUpperCase();
  const shot = async (n, step, note) => {
    const file = await screenshot(`flow-${vp.name}-${String(n).padStart(2, '0')}-${step}.png`);
    const o = await overflowNow(vp);
    flow.screenshots.push({ step, file, note });
    assert('phone-flow', vp.name, `#/lab (${SIDE})`, `${step}: no_horizontal_overflow`, o.ok, `scrollWidth ${o.scrollWidth}, innerWidth ${o.innerWidth}`);
    return file;
  };
  await go(`lab?p=sandbox&sym=${encodeURIComponent(sym)}`);
  if (side === 'sell') await tap(byText('form.ticket .seg button', 'Sell'), 'Side: Sell', steps);
  await typeInto(bySel('form.ticket input[inputmode=numeric]'), String(qty), 'Quantity (whole shares)', steps);
  await tap(byText('form.ticket button[type=submit]', 'Review order'), 'Review order…', steps);
  const reviewed = await waitFor(byText('form.ticket .review button', `Confirm ${SIDE}`));
  const reviewText = await textOf(bySel('form.ticket .review'));
  assert('phone-flow', vp.name, `#/lab (${SIDE})`, `${side}_confirmation_step_shown`, reviewed && /PAPER ONLY/.test(reviewText ?? ''),
    reviewed ? `review panel: ${reviewText?.slice(0, 240)}` : 'no confirm button appeared');
  await reveal(bySel('form.ticket .review'));
  await shot(n0, `${side}-review`, reviewText);
  if (!reviewed) throw new Error(`${side}: review step did not appear`);
  // The confirmation controls: the order line and estimated total sit directly above the Confirm / Edit buttons.
  await reveal(bySel('form.ticket .review .confirm-line'));
  const confirmLine = await textOf(bySel('form.ticket .review .confirm-line'));
  const buttonText = await textOf(byText('form.ticket .review button', `Confirm ${SIDE}`));
  const btnBox = await evaluate(`(() => { const b = (${byText('form.ticket .review button', `Confirm ${SIDE}`)})(); const r = b.getBoundingClientRect(); return { top: Math.round(r.top), bottom: Math.round(r.bottom) }; })()`);
  const tabTop = await evaluate(`(() => { const t = document.querySelector('.tabbar'); return t && t.offsetParent !== null ? Math.round(t.getBoundingClientRect().top) : window.innerHeight; })()`);
  assert('phone-flow', vp.name, `#/lab (${SIDE})`, `${side}_confirm_button_on_screen`, btnBox.top >= 0 && btnBox.bottom <= tabTop,
    `"${buttonText}" at y ${btnBox.top}..${btnBox.bottom}, bottom nav starts at ${tabTop}; confirm line: ${confirmLine}`);
  await shot(n0 + 1, `${side}-confirm`, `${confirmLine} | button: ${buttonText}`);
  await tap(byText('form.ticket .review button', `Confirm ${SIDE}`), `Confirm ${SIDE}`, steps);
  const decided = await waitFor(byText('form.ticket .ticket-result h3', 'gate decision'), 20_000) || await waitFor(byText('form.ticket .ticket-result h3', 'Not submitted'), 2_000);
  const resultText = await textOf(bySel('form.ticket .ticket-result'));
  const accepted = /ACCEPTED/.test(resultText ?? '') && !/DENIED/.test(resultText ?? '');
  assert('phone-flow', vp.name, `#/lab (${SIDE})`, `${side}_gate_result_shown`, decided, `gate result: ${resultText?.slice(0, 240)}`);
  assert('phone-flow', vp.name, `#/lab (${SIDE})`, `${side}_accepted_by_policy_gate`, accepted, accepted ? 'ACCEPTED' : `not accepted: ${resultText?.slice(0, 200)}`);
  await reveal(bySel('form.ticket .ticket-result'));
  await shot(n0 + 2, `${side}-gate-result`, resultText);
  if (!accepted) throw new Error(`${side}: the policy gate did not accept the order`);
  // Step the replay in the Replay view until the order has an estimated fill (bounded).
  const before = (await sandboxFills(sym)).filter((f) => f.side === side).length;
  let filled = null;
  const stepsTaken = [];
  for (let i = 0; i < 4 && !filled; i++) {
    stepsTaken.push(await stepInReplayView(vp, steps));
    const fills = (await sandboxFills(sym)).filter((f) => f.side === side);
    if (fills.length > before) filled = fills[0];
  }
  await shot(n0 + 3, `${side}-replay-step`, `Replay view after stepping: ${stepsTaken.map((s) => `${s.beforeEt} -> ${s.afterEt}`).join(', ')}`);
  assert('phone-flow', vp.name, '#/replay', `${side}_replay_stepped`, stepsTaken.every((s) => s.advanced), stepsTaken.map((s) => `${s.beforeEt} -> ${s.afterEt}`).join(', '));
  assert('phone-flow', vp.name, '/api/portfolios/sandbox', `${side}_estimated_fill`, !!filled,
    filled ? `${SIDE} ${filled.qty} ${sym} estimated fill at ${filled.price ?? filled.priceU} u (${filled.model ?? 'fill model'}) after ${stepsTaken.length} minute(s)` : `no ${side} fill after ${stepsTaken.length} minute(s)`);
  await go(`lab?p=sandbox&sym=${encodeURIComponent(sym)}`);
  const fillsHeading = `() => [...document.querySelectorAll('h3')].find((e) => e.offsetParent !== null && e.textContent.includes('Estimated paper fills'))`;
  await waitFor(fillsHeading, 8_000);
  await reveal(fillsHeading);
  await shot(n0 + 4, `${side}-fill`, await textOf(`() => (${fillsHeading})()?.nextElementSibling`, 500));
  return filled;
}

async function phoneTradeFlow(vp, sym, basis) {
  const flow = { name: 'phone sandbox BUY then SELL', viewport: vp.name, sym, symbolBasis: basis, steps: [], screenshots: [] };
  results.flows.push(flow);
  try {
    const q = (await api('GET', `/api/market/bars?sym=${encodeURIComponent(sym)}`)).json?.quote;
    const askUsd = q?.ask ? q.ask / 10_000 : null;
    const qty = askUsd ? Math.max(1, Math.min(100, Math.floor(400 / askUsd))) : 1;
    flow.qtyBasis = askUsd ? `floor($400 / as-of IEX ask $${askUsd.toFixed(4)}), capped at 100 shares` : '1 share (no as-of ask)';
    const buy = await orderFlow(vp, sym, 'buy', qty, 1, flow);
    flow.buyQty = qty;
    flow.buyFill = buy ? { qty: buy.qty, priceU: buy.price ?? buy.priceU, ts: buy.ts } : null;
    // Sell exactly what the sandbox holds after the buy (a buy can fill in more than one estimated fill).
    const held = ((await api('GET', '/api/portfolios/sandbox')).json?.positions ?? []).find((p) => p.sym === sym && p.kind !== 'option')?.qty ?? 0;
    flow.heldAfterBuy = held;
    const sellQty = held > 0 ? held : qty;
    const sell = await orderFlow(vp, sym, 'sell', sellQty, 6, flow);
    flow.sellFill = sell ? { qty: sell.qty, priceU: sell.price ?? sell.priceU, ts: sell.ts } : null;
    await go('journal');
    const j = await screenshot(`flow-${vp.name}-11-journal.png`);
    flow.screenshots.push({ step: 'journal', file: j, note: await textOf(bySel('main'), 300) });
  } catch (e) {
    flow.error = String(e?.message ?? e);
    assert('phone-flow', vp.name, '#/lab', 'flow_completed', false, flow.error);
    return;
  }
  assert('phone-flow', vp.name, '#/lab', 'flow_completed', true, `BUY and SELL of ${sym} completed through the UI`);
  const targets = flow.steps.filter((s) => s.action === 'tap');
  assert('phone-flow', vp.name, '#/lab', 'tap_targets_44px_uncovered', targets.every((t) => t.h >= 44 && !t.covered),
    targets.map((t) => `${t.what} ${t.w}x${t.h}${t.covered ? ` covered by ${t.coveredBy}` : ''}`).join('; '));
}

async function narrowReplayFlow(vp, sym) {
  const flow = { name: 'narrow replay + three-lens assessment panel', viewport: vp.name, sym, steps: [], screenshots: [] };
  results.flows.push(flow);
  const G = 'narrow-flow';
  const shot = async (step, note, route = '#/replay') => {
    const file = await screenshot(`narrow-${vp.name}-${step}.png`);
    const o = await overflowNow(vp);
    flow.screenshots.push({ step, file, note });
    assert(G, vp.name, route, `${step}: no_horizontal_overflow`, o.ok, `scrollWidth ${o.scrollWidth}, innerWidth ${o.innerWidth}`);
  };
  try {
    await go('replay');
    await shot('01-replay-paused', await textOf(bySel('#status-strip'), 300));
    const play = byText('main button.btn-primary', 'Play');
    await tap(play, 'Replay: Play', flow.steps);
    await sleep(3_500);
    const st1 = await getStatus();
    assert(G, vp.name, '#/replay', 'replay_playing_after_play', st1?.replay?.playing === true, `server replay.playing = ${st1?.replay?.playing}; clock ${etHm(st1?.replay?.clock)} ET`);
    await shot('02-replay-playing', await textOf(bySel('#status-strip'), 300));
    await tap(byText('main button.btn-primary', 'Pause'), 'Replay: Pause', flow.steps);
    await sleep(1_500);
    await settle();
    const st2 = await getStatus();
    assert(G, vp.name, '#/replay', 'replay_paused_after_pause', st2?.replay?.playing === false, `server replay.playing = ${st2?.replay?.playing}; clock ${etHm(st2?.replay?.clock)} ET`);
    await shot('03-replay-paused-again', await textOf(bySel('#status-strip'), 300));
    await go(`research/${encodeURIComponent(sym)}`);
    const panel = `() => [...document.querySelectorAll('section, .card, article')].find((e) => e.offsetParent !== null && /Three-lens assessment/.test(e.querySelector('h2, h3, header')?.textContent || ''))`;
    const found = await waitFor(panel, 10_000);
    const panelText = found ? await textOf(panel, 600) : null;
    const box = found ? await evaluate(`(() => { const r = (${panel})().getBoundingClientRect(); return { left: Math.round(r.left), right: Math.round(r.right), width: Math.round(r.width) }; })()`) : null;
    assert(G, vp.name, `#/research/${sym}`, 'assessment_panel_shown', found && box.left >= 0 && box.right <= vp.width,
      found ? `panel ${box.width}px wide (x ${box.left}..${box.right}); text: ${panelText?.slice(0, 260)}` : 'three-lens assessment panel not found');
    await reveal(panel);
    await shot('04-assessment-panel', panelText, `#/research/${sym}`);
  } catch (e) {
    flow.error = String(e?.message ?? e);
    assert(G, vp.name, '#/replay', 'flow_completed', false, flow.error);
    return;
  }
  assert(G, vp.name, '#/replay', 'flow_completed', true, 'replay paused -> playing -> paused, then the dossier assessment panel');
}

// ------------------------------------------------------------------------------------------------ main
const report = {
  tool: 'scripts/ui-check.mjs', label: 'VECTOR UI check — screenshots of a paper-only lab; every fill shown is an ESTIMATED PAPER FILL',
  mode: SHOTS_ONLY ? 'shots-only (screenshots for before/after comparison; no flows, no assertions)' : 'check',
  base: BASE, startedAt: new Date().toISOString(), browser: null, viewports: VIEWPORTS, routesSelected: ROUTES, serverStatus: null, prepare: null,
  symbols: null, web: {}, ...results,
};

/** Remove only the PNGs this run rewrites (a full-matrix check clears every size/flow PNG, as before). */
function cleanOutDir(routes) {
  const files = fs.readdirSync(OUT_DIR);
  if (FULL_MATRIX && !SHOTS_ONLY) {
    for (const f of files) if (/^(?:\d+x\d+-|flow-|narrow-).+\.png$/.test(f)) fs.rmSync(path.join(OUT_DIR, f));
    return;
  }
  const doomed = new Set(VIEWPORTS.flatMap((vp) => routes.map((r) => shotName(vp, r))));
  const dossierRe = ROUTES.includes('RESEARCH_SYM') ? new RegExp(`^(?:${VIEWPORTS.map((v) => v.name).join('|')})-research-.+\\.png$`) : null;
  const flowRe = [flowWanted('phone') ? `flow-${FLOW_SIZES.phone}-` : null, flowWanted('narrow') ? `narrow-${FLOW_SIZES.narrow}-` : null].filter(Boolean);
  for (const f of files) {
    if (doomed.has(f) || dossierRe?.test(f) || (f.endsWith('.png') && flowRe.some((p) => f.startsWith(p)))) fs.rmSync(path.join(OUT_DIR, f));
  }
}

let browser = null;
let profile = null;
let exitCode = 0;
try {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const st0 = await getStatus().catch(() => null);
  if (!st0) throw new Error(`no VECTOR server answered at ${BASE}/api/status`);
  if (opt('prepare-ds')) report.prepare = await prepare(opt('prepare-ds'), opt('prepare-to', '10:45'));
  const st = await getStatus();
  report.serverStatus = {
    dataMode: st?.data?.mode ?? null, dataset: st?.data?.dataset?.id ?? st?.replay?.ds ?? null, datasetSha256: st?.data?.dataset?.sha256 ?? null,
    replay: st?.replay ? { session_id: st.replay.session_id, clock: st.replay.clock, clockEt: etHm(st.replay.clock), playing: st.replay.playing, status: st.replay.status } : null,
    model: st?.model?.status ?? null, killSwitch: st?.kill?.engaged ?? null,
  };
  // Symbols are needed only by the dossier route and the flows.
  if (ROUTES.includes('RESEARCH_SYM') || flowWanted('phone') || flowWanted('narrow')) {
    report.symbols = await pickSymbols();
    if (!report.symbols.research) throw new Error('no symbol available from /api/research/opportunities (is a replay session with a market dataset active?)');
  }
  const routes = ROUTES.map((r) => (r === 'RESEARCH_SYM' ? `research/${report.symbols.research}` : r));
  cleanOutDir(routes);
  const webRoot = path.join(ROOT, 'web');
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
  for (const f of walk(webRoot).sort()) report.web[path.relative(webRoot, f).replace(/\\/g, '/')] = crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex').slice(0, 16);

  const cdpPort = await freePort();
  profile = fs.mkdtempSync(path.join(os.tmpdir(), 'vector-ui-check-'));
  browser = spawn(BROWSER, ['--headless=new', `--remote-debugging-port=${cdpPort}`, `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
    '--disable-extensions', '--disable-background-networking', '--disable-sync', '--disable-component-update', '--mute-audio', 'about:blank'], { stdio: 'ignore' });
  await connect(cdpPort);
  report.browser = { path: BROWSER, version: (await (await fetch(`http://127.0.0.1:${cdpPort}/json/version`)).json()).Browser };
  log(`browser ${report.browser.version}; server ${BASE} clock ${report.serverStatus.replay?.clockEt} ET; ${SHOTS_ONLY ? 'SHOTS ONLY; ' : ''}sizes ${VIEWPORTS.map((v) => v.name).join(',')}; `
    + `routes ${routes.join(',')}${report.symbols ? `; research ${report.symbols.research}; trade ${report.symbols.trade ?? 'none'}` : ''}`);

  for (const vp of VIEWPORTS) {
    await setViewport(vp);
    for (const route of routes) {
      pageErrors = [];
      await go(route);
      if (SHOTS_ONLY) {
        const file = await screenshot(shotName(vp, route));
        const widths = await evaluate(`({ innerWidth: window.innerWidth, clientWidth: document.documentElement.clientWidth, scrollWidth: document.documentElement.scrollWidth, bodyScrollWidth: document.body.scrollWidth })`);
        results.routes.push({ viewport: vp.name, route: `#/${route}`, screenshot: file, widths, errors: [...pageErrors] });
        results.screenshots.push(file);
        log(`shot ${vp.name} #/${route} -> ${file}`);
        continue;
      }
      const m = await evaluate(MEASURE);
      const file = await screenshot(shotName(vp, route));
      const errors = [...pageErrors];
      const tw = await evaluate(TRIPWIRE);
      const opened = await expandAllDetails();
      const twx = await evaluate(TRIPWIRE);
      const entry = { viewport: vp.name, route: `#/${route}`, screenshot: file, metrics: m, errors, tripwire: { rendered: tw, expanded: { ...twx, opened } } };
      if (pageErrors.length > errors.length) entry.errorsAfterExpanding = pageErrors.slice(errors.length);
      results.routes.push(entry);
      results.screenshots.push(file);
      const n = results.assertions.length;
      judgeRoute(vp, route, m, errors);
      judgeTripwire(vp, route, tw, 'overflow_tripwire');
      judgeTripwire(vp, route, twx, 'overflow_tripwire_expanded');
      const mine = results.assertions.slice(n);
      const failed = mine.filter((a) => !a.pass);
      log(`${failed.length ? 'FAIL' : 'pass'} ${vp.name} #/${route}${failed.length ? ` — ${failed.map((a) => `${a.name}: ${a.detail}`).join(' | ')}` : ''}`);
    }
  }
  if (FLOWS) {
    if (flowWanted('phone')) {
      const phone = ALL_VIEWPORTS.find((v) => v.name === FLOW_SIZES.phone);
      await setViewport(phone);
      if (report.symbols.trade) await phoneTradeFlow(phone, report.symbols.trade, report.symbols.tradeBasis);
      else assert('phone-flow', phone.name, '#/lab', 'flow_completed', false, 'no tradable symbol (two-sided, fresh, tight quote) found at the replay clock');
    } else log(`phone flow skipped: ${FLOW_SIZES.phone} is not among --sizes`);
    if (flowWanted('narrow')) {
      const narrow = ALL_VIEWPORTS.find((v) => v.name === FLOW_SIZES.narrow);
      await setViewport(narrow);
      await narrowReplayFlow(narrow, report.symbols.research);
    } else log(`narrow flow skipped: ${FLOW_SIZES.narrow} is not among --sizes`);
    for (const f of results.flows) for (const s of f.screenshots) results.screenshots.push(s.file);
    if (results.flows.length) log(`flows: ${results.flows.map((f) => `${f.name} ${f.error ? `ERROR ${f.error}` : 'done'}`).join('; ')}`);
  }
} catch (e) {
  report.fatal = String(e?.stack ?? e);
  console.error(e);
  exitCode = 1;
} finally {
  report.finishedAt = new Date().toISOString();
  const failed = results.assertions.filter((a) => !a.pass);
  const twFailed = results.tripwire.filter((t) => !t.pass);
  report.summary = {
    assertions: results.assertions.length, passed: results.assertions.length - failed.length, failed: failed.length,
    routeChecks: results.routes.length, screenshots: results.screenshots.length, flows: results.flows.map((f) => ({ name: f.name, viewport: f.viewport, error: f.error ?? null })),
    tripwire: { checks: results.tripwire.length, failed: twFailed.length, failing: twFailed.map((t) => `${t.viewport} ${t.route} ${t.check}`) },
    failures: failed.map((a) => `${a.viewport} ${a.route} ${a.name}: ${a.detail}`),
  };
  Object.assign(report, results);
  fs.mkdirSync(path.dirname(REPORT), { recursive: true });
  fs.writeFileSync(REPORT, JSON.stringify(report, null, 2) + '\n');
  log(`wrote ${path.relative(ROOT, REPORT)}: ${report.summary.passed}/${report.summary.assertions} assertions passed, ${report.summary.screenshots} screenshots`);
  if (OVERFLOW_REPORT && !SHOTS_ONLY) {
    const pairs = [...new Set(twFailed.map((t) => `${t.viewport} ${t.route}`))];
    fs.mkdirSync(path.dirname(OVERFLOW_REPORT), { recursive: true });
    fs.writeFileSync(OVERFLOW_REPORT, JSON.stringify({
      tool: 'scripts/ui-check.mjs (overflow tripwire)', base: BASE, startedAt: report.startedAt, finishedAt: report.finishedAt, browser: report.browser,
      serverStatus: report.serverStatus, prepare: report.prepare, symbols: report.symbols, web: report.web,
      sizes: VIEWPORTS.map(({ name, kind, mobile, dsf }) => ({ name, kind, mobile, dsf })), routes: results.routes.map((r) => r.route).filter((r, i, a) => a.indexOf(r) === i),
      rule: 'FAIL when documentElement.scrollWidth or body.scrollWidth exceeds window.innerWidth (or the root clientWidth beside a desktop scrollbar), '
        + 'or the layout viewport is wider than the emulated width / visual scale is not 1. overflow_tripwire = as rendered; overflow_tripwire_expanded = '
        + 'after opening every <details>. roots = offending elements whose parent does not overflow (where the overflow enters); widest = offending '
        + 'elements without overflowing descendants, furthest right first. Elements inside an overflow-x clipping/scrolling ancestor are not offenders.',
      fatal: report.fatal ?? null,
      summary: { checks: results.tripwire.length, failed: twFailed.length, failingPairs: pairs.length, pairs },
      failures: twFailed,
      checks: results.tripwire.map(({ roots, widest, ...rest }) => rest),
    }, null, 2) + '\n');
    log(`wrote ${path.relative(ROOT, OVERFLOW_REPORT)}: ${twFailed.length} of ${results.tripwire.length} tripwire checks failed`);
  }
  if (twFailed.length) {
    console.error(`\nOVERFLOW TRIPWIRE FAILED: ${twFailed.length} of ${results.tripwire.length} checks`);
    for (const t of twFailed) {
      console.error(`  ${t.viewport} ${t.route} [${t.check}] ${t.reasons.join('; ')}`);
      for (const o of t.widest.slice(0, 5)) console.error(`      widest    <${o.tag}> class="${o.cls ?? ''}" right=${o.right} width=${o.width}${o.fixed ? ' fixed' : ''}${o.text ? `  "${o.text}"` : ''}`);
      for (const o of t.roots.slice(0, 3)) console.error(`      enters at <${o.tag}> class="${o.cls ?? ''}" right=${o.right} width=${o.width}${o.path ? `  in ${o.path}` : ''}`);
    }
  }
  if (failed.length) exitCode = Math.max(exitCode, 1);
  if (twFailed.length) exitCode = 3;
  try { ws?.close(); } catch { /* closing */ }
  if (browser) browser.kill();
  await sleep(600);
  if (profile) { try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* the browser may still hold the profile briefly */ } }
  process.exit(exitCode);
}
