#!/usr/bin/env node
// VECTOR responsive UI check (desktop + phone). Drives a locally installed Chrome/Edge in headless mode over the
// DevTools protocol using Node's built-in WebSocket: no npm dependency, not part of `npm test`.
//
//   node docs/ui-checks/ui-check.mjs --base http://127.0.0.1:8795 --out docs/ui-checks/2026-10-09 --label real \
//        [--flows 1] [--routes 1] [--sym BAC] [--lens-sym TOPP] [--shots 360x780,390x844,...] [--full 390x844]
//        [--chrome "C:/Program Files/Google/Chrome/Application/chrome.exe"] [--cdp-port 9333]
//
// Point --base at a server running on a COPY of the database: --flows 1 places sandbox paper orders and advances the
// replay clock, so it refuses the default port 8787 unless --allow-mutation 1 is given. Route checks only issue GETs.
// --label is the screenshot prefix; use "unreachable" with `node test/web/check-server.mjs --mode unreachable` to
// record the honest-empty layouts, and "fixture" with `--mode fixture` for populated layouts: every fixture-* image is
// stamped "TEST FIXTURE — NOT MARKET DATA" (--stamp overrides). Run from the repository root (web/ file hashes are
// recorded).
//
// Records, for every route x viewport: horizontal overflow, phone tab bar / desktop sidebar visibility, status
// strip height and row count, the smallest visible interactive control, body / form-control font sizes, whether
// the data-status, replay-clock and no-live-trade labels are on screen, and a screenshot. Then (with --flows 1)
// runs the phone sandbox BUY -> confirm -> step -> fill -> SELL -> confirm -> step -> fill -> journal flow, a
// policy rejection, and a narrow replay play/pause + research three-lens view, with a screenshot per step.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const BASE = opt('base', 'http://127.0.0.1:8795').replace(/\/$/, '');
const OUT = path.resolve(opt('out', 'docs/ui-checks/out'));
const LABEL = opt('label', 'real');
const FLOWS = opt('flows', '0') === '1';
const ROUTE_CHECKS = opt('routes', '1') === '1';
const SYM = opt('sym', 'BAC');
const LENS_SYM = opt('lens-sym', 'TOPP');
const SHOTS = new Set(opt('shots', '360x780,390x844,430x932,1440x900').split(','));
const CHROME = opt('chrome', ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe']
  .find((p) => fs.existsSync(p)));
const PORT = Number(opt('cdp-port', '9333'));
if (FLOWS && /:8787\b/.test(BASE) && opt('allow-mutation', '0') !== '1') {
  console.error('--flows 1 mutates the replay session and sandbox. Run it against your own server on a DB copy (VECTOR_PORT/VECTOR_DB), or pass --allow-mutation 1.');
  process.exit(2);
}
if (!CHROME) { console.error('No Chrome/Edge found; pass --chrome <path>'); process.exit(2); }

const VIEWPORTS = [
  { name: '360x780', width: 360, height: 780, mobile: true },
  { name: '390x844', width: 390, height: 844, mobile: true },
  { name: '430x932', width: 430, height: 932, mobile: true },
  { name: '1440x900', width: 1440, height: 900, mobile: false },
];
const ROUTES = ['overview', 'research', `research/${SYM}`, 'lab', 'lab?p=sandbox', 'agents', 'replay', 'journal', 'sources', 'about', 'more'];
const FULLPAGE = new Set(opt('full', '390x844').split(',').filter(Boolean));

fs.mkdirSync(OUT, { recursive: true });
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'vector-uicheck-'));
const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
  '--disable-extensions', '--disable-background-networking', '--disable-sync', '--mute-audio', 'about:blank',
], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function cdpTarget() {
  for (let i = 0; i < 50; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = list.find((t) => t.type === 'page');
      if (page) return page.webSocketDebuggerUrl;
    } catch { /* not up yet */ }
    await sleep(200);
  }
  throw new Error('Chrome DevTools endpoint did not come up');
}

let ws; let nextId = 0; const pending = new Map(); const listeners = [];
function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve, reject, method });
    ws.send(JSON.stringify({ id, method, params }));
  });
}
function once(method, timeoutMs = 15000) {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), timeoutMs);
    listeners.push({ method, fn: (p) => { clearTimeout(t); resolve(p); } });
  });
}
async function evaluate(expr) {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(`evaluate failed: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
  return r.result.value;
}

const consoleErrors = [];
async function connect() {
  ws = new WebSocket(await cdpTarget());
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  ws.onmessage = (ev) => {
    const m = JSON.parse(typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString());
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id); pending.delete(m.id);
      if (m.error) p.reject(new Error(`${p.method}: ${m.error.message}`)); else p.resolve(m.result);
    } else if (m.method) {
      if (m.method === 'Runtime.exceptionThrown') consoleErrors.push(m.params.exceptionDetails?.exception?.description ?? 'exception');
      if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') consoleErrors.push(m.params.args.map((a) => a.value ?? a.description).join(' '));
      for (let i = listeners.length - 1; i >= 0; i--) if (listeners[i].method === m.method) { const l = listeners.splice(i, 1)[0]; l.fn(m.params); }
    }
  };
  await send('Page.enable'); await send('Runtime.enable');
}

async function setViewport(vp) {
  await send('Emulation.setDeviceMetricsOverride', { width: vp.width, height: vp.height, deviceScaleFactor: 1, mobile: vp.mobile });
  await send('Emulation.setTouchEmulationEnabled', vp.mobile ? { enabled: true, maxTouchPoints: 5 } : { enabled: false });
}

async function settle(maxMs = 8000) {
  const t0 = Date.now();
  while (Date.now() - t0 < maxMs) {
    const busy = await evaluate(`document.readyState !== 'complete' || !!document.querySelector('main .loading')`).catch(() => true);
    if (!busy) break;
    await sleep(150);
  }
  await sleep(500);
}

async function go(route) {
  const loaded = once('Page.loadEventFired');
  await send('Page.navigate', { url: `${BASE}/?r=${Date.now()}#/${route}` });
  await loaded;
  await settle();
}

// Measured in the page. Controls inside the visually-hidden skip link / sr-only are ignored; inline links inside
// running text are reported separately (WCAG 2.5.8 exempts inline targets).
const MEASURE = String.raw`(() => {
  const de = document.documentElement, vw = de.clientWidth, vh = window.innerHeight;
  const cs = (el) => getComputedStyle(el);
  const vis = (el) => { const r = el.getBoundingClientRect(); const s = cs(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' && !el.closest('.sr-only'); };
  const desc = (el) => { const c = (typeof el.className === 'string' && el.className.trim()) ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.') : ''; const t = (el.innerText || el.value || el.getAttribute('aria-label') || '').trim().replace(/\s+/g, ' ').slice(0, 40); return el.tagName.toLowerCase() + c + (t ? ' "' + t + '"' : ''); };
  const clipsX = (el) => { for (let p = el.parentElement; p && p !== document.body && p !== de; p = p.parentElement) { const o = cs(p).overflowX; if (o !== 'visible') return true; } return false; };
  const offenders = [];
  for (const el of document.body.querySelectorAll('*')) {
    if (offenders.length >= 6) break;
    if (!vis(el)) continue;
    const r = el.getBoundingClientRect();
    if (r.right > vw + 1 && !clipsX(el) && cs(el).position !== 'fixed') offenders.push(desc(el) + ' right=' + Math.round(r.right));
  }
  const ctrlSel = 'button, a[href], input:not([type=hidden]), select, textarea, summary, [role=tab], [role=button]';
  const ctrls = [...document.querySelectorAll(ctrlSel)].filter((el) => vis(el) && !el.classList.contains('skip'));
  const inlineLink = (el) => el.tagName === 'A' && cs(el).display === 'inline' && el.parentElement && /^(P|LI|SPAN|TD|DD|SMALL)$/.test(el.parentElement.tagName);
  const hitBox = (el) => { const lab = (el.type === 'radio' || el.type === 'checkbox') ? el.closest('label') : null; return (lab && vis(lab) ? lab : el).getBoundingClientRect(); };
  const sized = ctrls.map((el) => ({ el, r: hitBox(el), inline: inlineLink(el) }));
  const small = sized.filter((x) => !x.inline && (x.r.width < 44 || x.r.height < 44));
  const smallInline = sized.filter((x) => x.inline && (x.r.width < 44 || x.r.height < 44));
  const minTarget = sized.filter((x) => !x.inline).reduce((m, x) => Math.min(m, Math.round(Math.min(x.r.width, x.r.height))), Infinity);
  const formCtrls = [...document.querySelectorAll('input:not([type=hidden]):not([type=checkbox]):not([type=radio]), select, textarea')].filter(vis);
  const formMinFont = formCtrls.reduce((m, el) => Math.min(m, parseFloat(cs(el).fontSize)), Infinity);
  const textEls = [...document.querySelectorAll('main *, .status-strip *, .tabbar *')].filter((el) => vis(el) && [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim()));
  const fonts = textEls.map((el) => parseFloat(cs(el).fontSize));
  const strip = document.querySelector('#status-strip');
  const sr = strip ? strip.getBoundingClientRect() : null;
  const chipTops = strip ? [...new Set([...strip.querySelectorAll('.chip')].filter(vis).map((c) => Math.round(c.getBoundingClientRect().top)))] : [];
  const stripText = strip ? strip.innerText.replace(/\s+/g, ' ').trim() : '';
  const chipOnScreen = (re) => !!strip && [...strip.querySelectorAll('.chip')].some((c) => { const r = c.getBoundingClientRect(); return re.test(c.innerText) && vis(c) && r.left >= -1 && r.right <= vw + 1 && r.top >= -1 && r.bottom <= vh + 1; });
  const tab = document.querySelector('.tabbar'), side = document.querySelector('.sidebar');
  const tabR = tab && vis(tab) ? tab.getBoundingClientRect() : null;
  return {
    clientWidth: vw, scrollWidth: de.scrollWidth, visualViewportScale: window.visualViewport ? Math.round(window.visualViewport.scale * 1000) / 1000 : null, overflowPx: Math.max(0, de.scrollWidth - vw), offenders,
    docHeight: de.scrollHeight,
    tabbarVisible: !!tabR, tabbarHeight: tabR ? Math.round(tabR.height) : null, sidebarVisible: !!(side && vis(side)),
    statusStripHeight: sr ? Math.round(sr.height) : null, statusStripRows: chipTops.length, statusStripText: stripText.slice(0, 220),
    apiUnreachable: /UNREACHABLE/i.test(stripText),
    labels: { dataStatus: chipOnScreen(/HISTORICAL_REAL|HISTORICAL REAL|IMPORTED_UNVERIFIED|NO_VERIFIED_DATA|LIVE|DELAYED|PROVIDER|UNREACHABLE/i), replayClock: chipOnScreen(/Replay/i), noLiveTrade: chipOnScreen(/PAPER ONLY/i) },
    controls: ctrls.length, minTargetPx: Number.isFinite(minTarget) ? minTarget : null,
    under44: small.length, under44Examples: small.slice(0, 6).map((x) => desc(x.el) + ' ' + Math.round(x.r.width) + 'x' + Math.round(x.r.height)),
    inlineLinksUnder44: smallInline.length,
    bodyFontPx: parseFloat(cs(document.body).fontSize), formControls: formCtrls.length, formMinFontPx: Number.isFinite(formMinFont) ? formMinFont : null,
    textMinFontPx: fonts.length ? Math.min(...fonts) : null, textUnder16Share: fonts.length ? Math.round(100 * fonts.filter((f) => f < 16).length / fonts.length) : null,
    textUnder12: fonts.filter((f) => f < 12).length, textMedianFontPx: fonts.length ? [...fonts].sort((a, b) => a - b)[Math.floor(fonts.length / 2)] : null,
    textFontHistogram: fonts.reduce((m, f) => { const k = String(Math.round(f * 10) / 10); m[k] = (m[k] || 0) + 1; return m; }, {}),
  };
})()`;

// Fixture-mode screenshots carry a fixed banner so no image can be mistaken for market data. It is injected after the
// measurement (position:fixed, so it changes no layout metric) and removed again after the capture.
const STAMP = opt('stamp', LABEL === 'fixture' ? 'TEST FIXTURE — NOT MARKET DATA (test/web/check-server.mjs --mode fixture)' : '');
async function shot(name, { full = false, quality = full ? 45 : 60 } = {}) {
  if (STAMP) {
    await evaluate(`(() => { const b = document.createElement('div'); b.id = 'uicheck-stamp'; b.textContent = ${JSON.stringify(STAMP)};
      b.style.cssText = 'position:fixed;left:0;right:0;top:0;z-index:2147483647;padding:6px 8px;font:700 14px/1.3 system-ui,sans-serif;text-align:center;background:#ffd400;color:#000;pointer-events:none';
      document.body.appendChild(b); })()`);
  }
  try { return await capture(name, { full, quality }); } finally {
    if (STAMP) await evaluate(`document.getElementById('uicheck-stamp')?.remove()`).catch(() => {});
  }
}
async function capture(name, { full, quality }) {
  const file = `${name}.jpg`;
  const params = full ? { format: 'jpeg', quality, captureBeyondViewport: true } : { format: 'jpeg', quality };
  if (full) {
    const h = await evaluate('document.documentElement.scrollHeight');
    const w = await evaluate('document.documentElement.clientWidth');
    params.clip = { x: 0, y: 0, width: w, height: Math.min(h, 9000), scale: 1 };
  }
  const r = await send('Page.captureScreenshot', params);
  fs.writeFileSync(path.join(OUT, file), Buffer.from(r.data, 'base64'));
  return file;
}

// MAJOR = acceptance blockers from the prompt's mobile-first section (page-wide horizontal overflow, missing phone/desktop
// navigation, body or form text under 16 px, status / no-live-trade labels not on screen). MINOR = individual phone
// touch targets under 44 px (desktop targets are reported but not judged: they are pointer targets).
function verdict(m) {
  const fails = [];
  const minor = [];
  if (m.overflowPx > 1) fails.push(`horizontal overflow ${m.overflowPx}px`);
  if (m.viewport.mobile && !m.tabbarVisible) fails.push('phone tab bar not visible');
  if (!m.viewport.mobile && !m.sidebarVisible) fails.push('desktop sidebar not visible');
  if (m.bodyFontPx < 16) fails.push(`body font ${m.bodyFontPx}px`);
  if (m.formMinFontPx !== null && m.formMinFontPx < 16) fails.push(`form control font ${m.formMinFontPx}px`);
  // With the API unreachable there is no replay clock to show; the strip must then say API UNREACHABLE instead.
  if (!m.labels.dataStatus || !m.labels.noLiveTrade || (!m.labels.replayClock && !m.apiUnreachable)) fails.push('data-status / replay-clock / no-live-trade label not fully on screen');
  if (m.viewport.mobile && m.under44 > 0) minor.push(`${m.under44} phone control(s) under 44px: ${m.under44Examples.join(', ')}`);
  return { pass: fails.length === 0, fails, minor };
}

// ---------------------------------------------------------------- interaction helpers (real input events)
async function rectOf(finder) {
  return evaluate(`(() => { const el = (${finder})(); if (!el) return null; el.scrollIntoView({ block: 'center', inline: 'nearest' });
    const r = el.getBoundingClientRect(); const x = r.left + r.width / 2, y = r.top + r.height / 2; const top = document.elementFromPoint(x, y);
    const vv = window.visualViewport || { scale: 1, offsetLeft: 0, offsetTop: 0 };
    return { x: (x - vv.offsetLeft) * vv.scale, y: (y - vv.offsetTop) * vv.scale, scale: vv.scale, w: r.width, h: r.height, occluded: !(top && (top === el || el.contains(top))), occluder: top && top !== el && !el.contains(top) ? top.tagName + '.' + top.className : null, disabled: !!el.disabled }; })()`);
}
const byText = (sel, text) => `() => [...document.querySelectorAll(${JSON.stringify(sel)})].find((e) => e.offsetParent !== null && e.textContent.replace(/\\s+/g, ' ').trim().includes(${JSON.stringify(text)}))`;
const bySel = (sel) => `() => document.querySelector(${JSON.stringify(sel)})`;
async function tap(finder, what, log) {
  const r = await rectOf(finder);
  if (!r) throw new Error(`not found: ${what}`);
  await sleep(150);
  const r2 = await rectOf(finder); // after scroll settles
  log.push({ action: 'tap', what, w: Math.round(r2.w), h: Math.round(r2.h), visualViewportScale: Math.round(r2.scale * 1000) / 1000, occluded: r2.occluded, occluder: r2.occluder, disabled: r2.disabled });
  if (r2.disabled) throw new Error(`disabled: ${what}`);
  for (const type of ['mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, x: r2.x, y: r2.y, button: 'left', clickCount: 1 });
}
async function typeInto(finder, text, what, log) {
  await tap(finder, what, log);
  await evaluate(`(() => { const el = (${finder})(); el.select?.(); })()`);
  await send('Input.insertText', { text });
}
async function waitFor(finder, ms = 10000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (await evaluate(`!!(${finder})()`)) return true; await sleep(200); }
  return false;
}
// Scroll an element to just below the sticky status strip so the screenshot shows the step it documents.
async function reveal(finder) {
  await evaluate(`(() => { const el = (${finder})(); if (!el) return false; el.scrollIntoView({ block: 'start' });
    const s = document.querySelector('#status-strip'); window.scrollBy(0, -((s ? Math.max(0, s.getBoundingClientRect().bottom) : 0) + 8)); return true; })()`);
  await sleep(250);
}
const textOf = (finder) => evaluate(`(() => { const el = (${finder})(); return el ? el.innerText.replace(/\\s+/g, ' ').trim().slice(0, 600) : null; })()`);
async function api(method, p, body) {
  const res = await fetch(`${BASE}${p}`, { method, headers: { 'Content-Type': 'application/json', 'X-Vector-Client': 'web' }, body: body ? JSON.stringify(body) : undefined });
  return res.json();
}

const clockEt = async () => { try { const st = await (await fetch(`${BASE}/api/status`)).json(); const c = st?.replay?.clock; return typeof c === 'number' ? new Date(c - 4 * 3600e3).toISOString().slice(11, 16) + ' ET' : null; } catch { return null; } };
async function stepOneMinute(log) {
  const before = await clockEt();
  await go('replay');
  await tap(`() => document.querySelector('button[aria-label="Step 1 minute"]')`, 'Step 1 minute', log);
  await sleep(2500); await settle();
  const after = await clockEt();
  log.push({ action: 'verify', what: 'replay clock after Step 1 minute (from /api/status)', before, after });
  return `clock ${before} -> ${after}`;
}

async function sandboxFlow(vp, steps) {
  const log = [];
  const pfx = `${LABEL}-flow-${vp.name}`;
  const rec = async (step, note, focus) => { if (focus) await reveal(focus); steps.push({ viewport: vp.name, step, note, screenshot: await shot(`${pfx}-${String(steps.filter((s) => s.viewport === vp.name).length + 1).padStart(2, '0')}-${step}`), overflowPx: (await evaluate(MEASURE)).overflowPx }); };
  await go(`lab?p=sandbox&sym=${SYM}`);
  await rec('ticket', `sandbox ticket prefilled with ${SYM}`, bySel('form.ticket'));
  await typeInto(bySel('form.ticket input[type=number][inputmode=numeric]'), '5', 'quantity', log);
  await tap(byText('form.ticket button', 'Review order'), 'Review order…', log);
  await waitFor(byText('form.ticket button', 'Confirm BUY'));
  await rec('buy-review', await textOf(bySel('form.ticket .review')), bySel('form.ticket .review'));
  await tap(byText('form.ticket button', 'Confirm BUY'), 'Confirm BUY paper order', log);
  await waitFor(byText('form.ticket h3', 'Policy gate decision'));
  await sleep(400);
  await rec('buy-gate-decision', await textOf(bySel('form.ticket [role=status]')), bySel('form.ticket [role=status]'));
  const stepNote = await stepOneMinute(log);
  await rec('replay-step-after-buy', `${stepNote}; strip: ${await textOf(bySel('#status-strip'))}`);
  await go(`lab?p=sandbox&sym=${SYM}`);
  await waitFor(byText('main', 'ESTIMATED PAPER FILL'), 6000);
  await evaluate(`(() => { const h = [...document.querySelectorAll('h3')].find((e) => e.textContent.includes('Estimated paper fills')); h?.scrollIntoView({ block: 'start' }); })()`);
  await sleep(300);
  await rec('buy-fill', await textOf(`() => [...document.querySelectorAll('h3')].find((e) => e.textContent.includes('Estimated paper fills'))?.nextElementSibling`), `() => [...document.querySelectorAll('h3')].find((e) => e.textContent.includes('Estimated paper fills'))`);
  await tap(byText('form.ticket .seg button', 'Sell'), 'Side: Sell', log);
  await typeInto(bySel('form.ticket input[type=number][inputmode=numeric]'), '5', 'quantity', log);
  await tap(byText('form.ticket button', 'Review order'), 'Review order…', log);
  await waitFor(byText('form.ticket button', 'Confirm SELL'));
  await rec('sell-review', await textOf(bySel('form.ticket .review')), bySel('form.ticket .review'));
  await tap(byText('form.ticket button', 'Confirm SELL'), 'Confirm SELL paper order', log);
  await waitFor(byText('form.ticket h3', 'Policy gate decision'));
  await sleep(400);
  await rec('sell-gate-decision', await textOf(bySel('form.ticket [role=status]')), bySel('form.ticket [role=status]'));
  const stepNote2 = await stepOneMinute(log);
  await go(`lab?p=sandbox&sym=${SYM}`);
  await evaluate(`(() => { const h = [...document.querySelectorAll('h3')].find((e) => e.textContent.includes('Estimated paper fills')); h?.scrollIntoView({ block: 'start' }); })()`);
  await sleep(300);
  await rec('sell-fill', stepNote2 + '; ' + await textOf(`() => [...document.querySelectorAll('h3')].find((e) => e.textContent.includes('Estimated paper fills'))?.nextElementSibling`), `() => [...document.querySelectorAll('h3')].find((e) => e.textContent.includes('Estimated paper fills'))`);
  // Policy rejection: 100 shares exceeds the sandbox max trade spend ($2,500).
  await typeInto(bySel('form.ticket input[type=number][inputmode=numeric]'), '100', 'quantity', log);
  await tap(byText('form.ticket .seg button', 'Buy'), 'Side: Buy', log);
  await typeInto(bySel('form.ticket input[type=number][inputmode=numeric]'), '100', 'quantity', log);
  await tap(byText('form.ticket button', 'Review order'), 'Review order…', log);
  await waitFor(byText('form.ticket button', 'Confirm BUY'));
  await tap(byText('form.ticket button', 'Confirm BUY'), 'Confirm BUY paper order (over budget)', log);
  await waitFor(byText('form.ticket h3', 'gate decision'));
  await sleep(400);
  await rec('policy-rejection', await textOf(bySel('form.ticket [role=status]')), bySel('form.ticket [role=status]'));
  await go('journal');
  await rec('journal', await textOf(bySel('main')));
  return log;
}

async function narrowFlow(vp, steps) {
  const log = [];
  const pfx = `${LABEL}-narrow-${vp.name}`;
  const rec = async (step, note) => { steps.push({ viewport: vp.name, step, note, screenshot: await shot(`${pfx}-${step}`), overflowPx: (await evaluate(MEASURE)).overflowPx }); };
  await go('replay');
  await rec('replay-paused', await textOf(bySel('#status-strip')));
  await tap(byText('main button.btn-primary', 'Play'), 'Play', log);
  await sleep(4000);
  await rec('replay-playing', await textOf(bySel('#status-strip')));
  await tap(byText('main button.btn-primary', 'Pause'), 'Pause', log);
  await sleep(1500); await settle();
  await rec('replay-paused-again', await textOf(bySel('#status-strip')));
  await go(`research/${SYM}`);
  await evaluate(`(() => { const h = [...document.querySelectorAll('h2, h3, .card-title, header')].find((e) => /Three-lens assessment/.test(e.textContent)); h?.scrollIntoView({ block: 'start' }); })()`);
  await sleep(400);
  const lensText = `() => [...document.querySelectorAll('section, .card')].find((e) => /Three-lens assessment/.test(e.textContent) && e.querySelector('.lenses, .state, [class*=status]'))`;
  const toLens = `(() => { const h = [...document.querySelectorAll('h2, h3, .card-title, header')].find((e) => /Three-lens assessment/.test(e.textContent)); h?.scrollIntoView({ block: 'start' }); })()`;
  await rec(`three-lens-${SYM}`, await textOf(lensText));
  await go(`research/${LENS_SYM}`);
  await evaluate(toLens); await sleep(400);
  await rec(`three-lens-${LENS_SYM}`, await textOf(lensText));
  return log;
}

const results = { label: LABEL, base: BASE, startedAt: new Date().toISOString(), chrome: null, web: {}, routes: [], flows: [], interactions: [], consoleErrors };
try {
  await connect();
  results.chrome = (await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json()).Browser;
  const webRoot = path.resolve('web');
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
  if (fs.existsSync(webRoot)) for (const f of walk(webRoot).sort()) results.web[path.relative(webRoot, f).replace(/\\/g, '/')] = crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex').slice(0, 16);
  try {
    const st = await (await fetch(`${BASE}/api/status`)).json();
    results.serverStatus = { dataMode: st?.data?.mode ?? null, dataset: st?.data?.dataset?.id ?? null, datasetSha256: st?.data?.dataset?.sha256 ?? null,
      replay: st?.replay ? { status: st.replay.status, clock: st.replay.clock, session_id: st.replay.session_id } : null, model: st?.model?.status ?? null, options: st?.options?.status ?? null };
  } catch { results.serverStatus = { unreachable: true }; }
  for (const vp of ROUTE_CHECKS ? VIEWPORTS : []) {
    await setViewport(vp);
    for (const route of ROUTES) {
      await go(route);
      const m = await evaluate(MEASURE);
      m.viewport = vp; m.route = `#/${route}`;
      const base = `${LABEL}-${route.replace(/[/?=&]/g, '_')}-${vp.name}`;
      m.screenshot = SHOTS.has(vp.name) ? await shot(base) : null;
      if (FULLPAGE.has(vp.name)) m.fullPage = await shot(`${base}-full`, { full: true });
      Object.assign(m, verdict(m));
      results.routes.push(m);
      console.log(`${m.pass ? 'PASS' : 'FAIL'} ${vp.name} #/${route} overflow=${m.overflowPx} minTarget=${m.minTargetPx} under44=${m.under44} strip=${m.statusStripHeight}px/${m.statusStripRows}r ${[...m.fails, ...m.minor.map((x) => 'minor: ' + x)].join('; ')}`);
    }
  }
  if (FLOWS) {
    for (const name of ['390x844', '360x780']) {
      const vp = VIEWPORTS.find((v) => v.name === name);
      await setViewport(vp);
      try { results.interactions.push({ viewport: name, flow: 'sandbox-buy-sell', log: await sandboxFlow(vp, results.flows) }); } catch (e) { results.interactions.push({ viewport: name, flow: 'sandbox-buy-sell', error: String(e.message) }); console.log('flow error', name, e.message); }
      try { results.interactions.push({ viewport: name, flow: 'narrow-replay-assessment', log: await narrowFlow(vp, results.flows) }); } catch (e) { results.interactions.push({ viewport: name, flow: 'narrow-replay-assessment', error: String(e.message) }); console.log('flow error', name, e.message); }
    }
  }
} finally {
  results.finishedAt = new Date().toISOString();
  results.summary = { routeChecks: results.routes.length, pass: results.routes.filter((r) => r.pass).length, fail: results.routes.filter((r) => !r.pass).length, withMinor: results.routes.filter((r) => r.minor?.length).length,
    flowsCompleted: results.interactions.filter((i) => !i.error).length, flowErrors: results.interactions.filter((i) => i.error).map((i) => `${i.viewport} ${i.flow}: ${i.error}`) };
  fs.writeFileSync(path.join(OUT, `results-${LABEL}.json`), JSON.stringify(results, null, 2));
  console.log(`wrote ${path.join(OUT, `results-${LABEL}.json`)}`, JSON.stringify(results.summary));
  try { ws?.close(); } catch { /* ignore */ }
  chrome.kill();
  await sleep(500);
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* profile may still be locked */ }
}
