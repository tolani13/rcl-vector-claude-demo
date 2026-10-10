// Hand-rolled SVG charts. They render ONLY series returned by the API; with no points the caller shows an explicit
// empty state instead (see hasPoints). Charts are drawn at the container's measured pixel width (re-drawn on resize)
// so axis text stays crisp and nothing overflows the page horizontally.
//
// Chart rules (ui-polish-v1 dataviz pass; colours and chrome live in web/charts.css, scoped to the .viz host):
//  - One y-axis per plot, never two y-scales on one plot. Price and volume are two stacked panels sharing the x-axis.
//  - Colour follows the entity, never its rank after filtering. The RCL brand ramps have one chromatic hue (copper),
//    which passes the categorical checks for at most two distinct series, so a multi-series line chart is drawn as
//    small multiples: one copper line per panel in the caller's (server's configured) order, every panel on the same
//    y-scale, each panel labelled with its series name (identity is text, not hue).
//  - Status/polarity colours (--up/--down) are reserved: inferred buyer/seller volume always carries a sign glyph and
//    its label. Text never wears a series colour.
//  - Thin marks (2px lines, 8px markers with a 2px surface ring, 2px surface gap between touching fills when bars are
//    wide enough, rounded data-ends anchored to the baseline), recessive solid hairline grid and axes. Lines break
//    across missing minutes; a point with no drawn neighbour is a dot. Nothing is interpolated.
//  - Hover by default: a crosshair snaps to the nearest minute and one tooltip lists every series there. The plot is a
//    keyboard slider (arrow keys, Page Up/Down, Home/End). Every chart has a "Table view" of the same rows, scrolling
//    inside its own container.
import { h, s, clear, watchScrollable } from './dom.js';
import { isNum, fmtEt, fmtEtHm, fmtPriceU, fmtShares, DASH } from './format.js';

const MIN = 60000;

function niceTicks(min, max, count = 4) {
  if (!(max > min)) {
    const d = Math.abs(min) * 0.05 || 1;
    min -= d; max += d;
  }
  const raw = (max - min) / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const n = raw / mag;
  const step = (n < 1.5 ? 1 : n < 3 ? 2 : n < 7 ? 5 : 10) * mag;
  const lo = Math.floor(min / step) * step;
  const hi = Math.ceil(max / step) * step;
  const ticks = [];
  for (let v = lo; v <= hi + step / 2; v += step) ticks.push(+v.toFixed(10));
  return { lo, hi: hi === lo ? lo + step : hi, ticks };
}

/** Nice ticks that leave at least `minGap` px between tick labels on a plot `plotH` px tall. */
function fitTicks(min, max, plotH, minGap) {
  for (let count = Math.max(1, Math.floor(plotH / minGap)); ; count--) {
    const yt = niceTicks(min, max, count);
    if (count <= 1 || (yt.ticks.length - 1) * minGap <= plotH) return yt;
  }
}

export function timeTicks(t0, t1, plotW) {
  const want = Math.max(4, Math.floor(plotW / 72)); // ~72 px per 'HH:MM' label at 13 px, edge-anchored labels included
  const steps = [1, 2, 5, 10, 15, 30, 60, 120, 240];
  const at = (step) => {
    const out = [];
    for (let t = Math.ceil(t0 / (step * MIN)) * step * MIN; t <= t1; t += step * MIN) out.push(t);
    return out;
  };
  // The coarsest step that fits `want` labels; if that leaves fewer than 4 labels, use the next finer step only when
  // its labels still fit (so phone axes keep about 3 well-spaced references instead of touching labels).
  let i = steps.findIndex((st) => at(st).length <= want);
  if (i < 0) i = steps.length - 1;
  // ...but only when those finer labels still fit (~64 px each), so phone axes never print touching labels.
  if (i > 0 && at(steps[i]).length < 4 && at(steps[i - 1]).length * 64 <= plotW) i -= 1;
  return at(steps[i]);
}

/** Anchor for an x-axis label so labels at the plot edges are not clipped by the SVG viewport. */
export function tickAnchor(x, left, right, pad = 18) {
  if (x >= right - pad) return 'end';
  if (x <= left + pad) return 'start';
  return 'middle';
}

/** Spread label y positions so they never overlap (min gap px), keeping them inside [top, bottom]. */
export function spreadLabels(ys, gap, top, bottom) {
  const idx = ys.map((y, i) => [y, i]).sort((a, b) => a[0] - b[0]);
  const out = new Array(ys.length);
  let prev = -Infinity;
  for (const [y, i] of idx) { const v = Math.max(y, prev + gap, top); out[i] = v; prev = v; }
  // push back up from the bottom if needed
  let next = Infinity;
  for (let k = idx.length - 1; k >= 0; k--) { const i = idx[k][1]; out[i] = Math.min(out[i], next - gap, bottom); next = out[i]; }
  return out;
}

/** Short, distinct labels (<= max chars): the prefix when prefixes are unique, otherwise the suffix. */
export function endLabelNames(names, max = 6) {
  const pre = names.map((n) => String(n).slice(0, max));
  if (new Set(pre).size === pre.length) return pre;
  const suf = names.map((n) => String(n).slice(-max));
  return new Set(suf).size === suf.length ? suf : names.map((n, i) => `${String(n).slice(0, Math.max(1, max - 2))}${i + 1}`);
}

function observeWidth(el, draw) {
  let last = 0;
  const run = () => {
    const w = Math.floor(el.clientWidth);
    if (w > 0 && w !== last) { last = w; draw(w); }
  };
  // Draw immediately when already in the document (reading clientWidth forces layout, so this also works in a
  // background tab where animation frames are throttled); the observer handles later resizes and late attachment.
  run();
  if (typeof ResizeObserver === 'undefined') return () => {};
  const ro = new ResizeObserver(run);
  ro.observe(el);
  return () => ro.disconnect();
}

function nearestIdx(points, t) {
  let lo = 0;
  let hi = points.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (points[mid].t <= t) lo = mid; else hi = mid;
  }
  return Math.abs(points[lo].t - t) <= Math.abs(points[hi].t - t) ? lo : hi;
}

export function hasPoints(series) {
  return Array.isArray(series) && series.some((x) => Array.isArray(x.points) && x.points.some((p) => isNum(p.t) && isNum(p.y)));
}

// ---------------------------------------------------------------------------------------------- shared chart parts

const px = (v) => Math.round(v) + 0.5; // crisp 1px hairlines
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/**
 * Path for a series that breaks wherever consecutive points are more than `maxGap` ms apart, so nothing is drawn
 * across missing minutes; `lone` lists the points left with no drawn neighbour (the caller marks them with a dot).
 */
function gappedPath(pts, maxGap, xOf, yOf) {
  let d = '';
  const lone = [];
  pts.forEach((p, i) => {
    const joinPrev = i > 0 && p.t - pts[i - 1].t <= maxGap;
    const joinNext = i < pts.length - 1 && pts[i + 1].t - p.t <= maxGap;
    d += `${joinPrev ? 'L' : 'M'}${xOf(p).toFixed(1)},${yOf(p).toFixed(1)}`;
    if (!joinPrev && !joinNext && i < pts.length - 1) lone.push(p);
  });
  return { d, lone };
}

/** Legend / tooltip key that mirrors the mark: a short stroke for lines, a tick for ranges, a box for bars. */
function key(kind, cls) {
  return h('span', { class: `key ${kind} ${cls}`, 'aria-hidden': 'true' });
}
function legendItem(kind, cls, text, glyph) {
  return h('span', null, key(kind, cls), glyph ? h('span', { class: 'glyph', 'aria-hidden': 'true' }, glyph) : null, text);
}

/**
 * Tooltip inside the chart box, built from text nodes only. Mouse and keyboard: it floats beside the crosshair at the
 * top of the plot. Touch: it docks just below the plot, so the finger never hides it and it never hides the data.
 */
function tooltip(box) {
  const el = h('div', { class: 'chart-tip', 'aria-hidden': 'true', hidden: true });
  box.append(el);
  return {
    el,
    show(x, head, rows, { dock = false } = {}) {
      clear(el).append(h('div', { class: 'tip-h' }, head),
        h('div', { class: 'tip-rows' }, rows.map((r) => (r.note
          ? h('div', { class: 'tip-note' }, r.note)
          : h('div', { class: 'tip-row' },
            r.kind ? key(r.kind, r.cls) : h('span', { class: 'key none', 'aria-hidden': 'true' }),
            h('span', { class: 'tip-v' }, r.v),
            h('span', { class: 'tip-n' }, r.glyph ? h('span', { class: 'glyph', 'aria-hidden': 'true' }, r.glyph) : null, r.n))))));
      el.hidden = false;
      const bw = box.clientWidth;
      const w = el.offsetWidth;
      let left = dock ? x - w / 2 : x + 14;
      if (!dock && left + w > bw - 2) left = x - 14 - w;
      el.style.left = `${clamp(left, 2, Math.max(2, bw - w - 2))}px`;
      el.style.top = dock ? `${box.clientHeight + 6}px` : '4px';
      el.classList.toggle('docked', dock);
    },
    hide() { el.hidden = true; },
  };
}

/**
 * Make the chart box a keyboard slider over `count` positions. onIndex(i) draws the hover state for position i;
 * valueText(i) is what assistive technology reads. Pointer hover reuses the same onIndex via the returned `set`.
 */
function scrubber(box, { label, count, valueText, onIndex, onLeave }) {
  let idx = null;
  box.tabIndex = 0;
  box.setAttribute('role', 'slider');
  box.setAttribute('aria-label', `${label}. Use the arrow keys to step through the data.`);
  box.setAttribute('aria-valuemin', '0');
  box.setAttribute('aria-valuemax', String(Math.max(0, count - 1)));
  const sync = (i) => { box.setAttribute('aria-valuenow', String(i)); box.setAttribute('aria-valuetext', valueText(i)); };
  sync(Math.max(0, count - 1));
  const set = (i) => { idx = clamp(i, 0, count - 1); sync(idx); onIndex(idx); };
  const steps = { ArrowLeft: -1, ArrowDown: -1, ArrowRight: 1, ArrowUp: 1, PageDown: -10, PageUp: 10 };
  box.addEventListener('keydown', (ev) => {
    if (ev.key in steps) set((idx ?? count - 1) + steps[ev.key]);
    else if (ev.key === 'Home') set(0);
    else if (ev.key === 'End') set(count - 1);
    else if (ev.key === 'Escape') { onLeave(); return; } else return;
    ev.preventDefault();
  });
  box.addEventListener('focus', () => { if (box.matches(':focus-visible')) set(idx ?? count - 1); });
  box.addEventListener('blur', onLeave);
  return { set };
}

// Table views are rebuilt with their chart on every replay tick; remember which ones are open (and where they were
// scrolled) so playback does not snap them shut.
const tableState = new Map();

/** <details> "Table view" twin of a chart. build() returns the <table>; it runs only while the details is open. */
function tableView(stateKey, build) {
  const st = tableState.get(stateKey) || { open: false, top: 0, left: 0 };
  const scroller = h('div', { class: 'scroll-x chart-table-scroll', tabindex: '0', role: 'region', 'aria-label': 'Chart data table' });
  const det = h('details', { class: 'chart-table' }, h('summary', null, 'Table view'), scroller,
    h('div', { class: 'scroll-hint', 'aria-hidden': 'true' }, 'Scroll sideways for more columns →'));
  let built = false;
  let unwatch = () => {};
  const fill = () => {
    if (built) return;
    built = true;
    scroller.append(build());
    const restore = () => { scroller.scrollTop = st.top; scroller.scrollLeft = st.left; if (scroller.isConnected) unwatch = watchScrollable(scroller); };
    if (scroller.isConnected) restore(); else requestAnimationFrame(restore);
  };
  det.addEventListener('toggle', () => { st.open = det.open; tableState.set(stateKey, st); if (det.open) fill(); });
  scroller.addEventListener('scroll', () => { st.top = scroller.scrollTop; st.left = scroller.scrollLeft; tableState.set(stateKey, st); }, { passive: true });
  if (st.open) { det.open = true; fill(); }
  return { el: det, destroy: () => unwatch() };
}

/** head: column labels (strings or [glyph, text]); rows: arrays of cell text, first cell is the row header. */
function dataTable(caption, head, rows) {
  const cell = (c) => (Array.isArray(c) ? [h('span', { class: 'glyph', 'aria-hidden': 'true' }, c[0]), c[1]] : c);
  return h('table', { class: 'chart-table-t' },
    h('caption', { class: 'sr-only' }, caption),
    h('thead', null, h('tr', null, head.map((c, i) => h('th', { scope: 'col', class: i ? 'n' : null }, cell(c))))),
    h('tbody', null, rows.map((r) => h('tr', null, r.map((v, i) => (i ? h('td', { class: 'n' }, v) : h('th', { scope: 'row' }, v)))))));
}

// ---------------------------------------------------------------------------------------------- line chart

/**
 * Line chart. series: [{name, points:[{t, y}]}]; t = ms UTC, y = number (e.g. return %).
 * One series: a single plot (its panel label names it; no legend box). Two or more: small multiples, one panel per
 * series in the caller's order, all on the same x- and y-scales.
 * opts: { height (single-series total height), yFmt, zero, ariaLabel }
 */
export function lineChart(host, series, opts = {}) {
  // Panels keep the caller's order (the server's configured order). A series with no points is skipped without
  // reordering the rest, and every panel wears the same slot-1 copper, so a missing series never repaints another.
  const clean = series
    .map((x, i) => ({ name: String(x.name ?? `Series ${i + 1}`), points: (x.points || []).filter((p) => isNum(p.t) && isNum(p.y)).sort((a, b) => a.t - b.t) }))
    .filter((x) => x.points.length);
  const yFmt = opts.yFmt || ((v) => String(v));
  const label = opts.ariaLabel || 'Line chart';
  host.classList.add('viz');
  if (!clean.length) return { destroy() {} };
  const multi = clean.length > 1;
  const byT = clean.map((x) => new Map(x.points.map((p) => [p.t, p.y])));
  const keys = [...new Set(clean.flatMap((x) => x.points.map((p) => p.t)))].sort((a, b) => a - b).map((t) => ({ t }));
  const last = (x) => x.points[x.points.length - 1];

  const box = h('div', { class: 'chart' });
  const legend = multi
    ? h('div', { class: 'legend' }, legendItem('line', 'k-s1', 'One panel per series, same y-scale'), opts.zero ? legendItem('line', 'k-zero', 'Zero') : null)
    : null;
  const summary = clean.map((x) => `${x.name} ${yFmt(last(x).y)} at ${fmtEt(last(x).t)}`).join('; ');
  const table = tableView(`line:${label}`, () => dataTable(label, ['Time (ET)', ...clean.map((x) => x.name)],
    keys.map(({ t }) => [fmtEtHm(t), ...byT.map((m) => (m.has(t) ? yFmt(m.get(t)) : DASH))])));
  host.append(box, legend, table.el, h('p', { class: 'sr-only' }, `${label}. Latest: ${summary}.`));

  const tip = tooltip(box);
  const valueText = (i) => `${fmtEt(keys[i].t)}: ${clean.map((x, k) => `${x.name} ${byT[k].has(keys[i].t) ? yFmt(byT[k].get(keys[i].t)) : 'no point'}`).join(', ')}`;
  let geo = null; // current draw's geometry and hover elements
  let hoverCol = 0; // column the pointer is in (two-column layouts); keyboard scrubbing reuses the last one
  let touch = false; // last input was a touch: dock the tooltip below the plot
  const showAt = (i, col) => {
    if (!geo) return;
    const t = keys[i].t;
    clean.forEach((x, k) => {
      const p = geo.panels[k];
      const cx = geo.X(t, p.col);
      p.cursor.setAttribute('x1', cx); p.cursor.setAttribute('x2', cx); p.cursor.setAttribute('visibility', 'visible');
      if (byT[k].has(t)) {
        p.dot.setAttribute('cx', cx); p.dot.setAttribute('cy', geo.Y(byT[k].get(t), p.row)); p.dot.setAttribute('visibility', 'visible');
      } else p.dot.setAttribute('visibility', 'hidden');
    });
    tip.show(geo.X(t, col ?? 0), fmtEt(t), clean.map((x, k) => ({ kind: 'line', cls: 'k-s1', v: byT[k].has(t) ? yFmt(byT[k].get(t)) : DASH, n: x.name })), { dock: touch });
  };
  const hide = () => {
    tip.hide();
    if (geo) for (const p of geo.panels) { p.cursor.setAttribute('visibility', 'hidden'); p.dot.setAttribute('visibility', 'hidden'); }
  };
  box.addEventListener('keydown', () => { touch = false; });
  const scrub = scrubber(box, { label, count: keys.length, valueText, onIndex: (i) => showAt(i, hoverCol), onLeave: hide });

  const draw = (width) => {
    const W = Math.max(240, width);
    const phone = W < 480;
    const cols = multi && W >= 720 ? 2 : 1;
    const rows = Math.ceil(clean.length / cols);
    const m = { t: 4, r: 12, b: 24, l: 56 };
    const labelH = 30; // panel label row (label baseline 13px above the plot, clear of the top tick label)
    const gapY = multi ? 16 : 0;
    const colGap = 24;
    const plotH = multi ? (phone ? 64 : 76) : Math.max(80, (opts.height || (phone ? 190 : 230)) - m.t - labelH - m.b);
    const panelW = (W - cols * (m.l + m.r) - (cols - 1) * colGap) / cols;
    const stride = m.l + panelW + m.r + colGap;
    const H = m.t + rows * (labelH + plotH) + (rows - 1) * gapY + m.b;
    const all = clean.flatMap((x) => x.points);
    let t0 = keys[0].t;
    let t1 = keys[keys.length - 1].t;
    if (t1 === t0) { t0 -= MIN; t1 += MIN; }
    let y0 = Math.min(...all.map((p) => p.y));
    let y1 = Math.max(...all.map((p) => p.y));
    if (opts.zero) { y0 = Math.min(0, y0); y1 = Math.max(0, y1); }
    const yt = fitTicks(y0, y1, plotH, 22);
    // Break a line where a series skips more than 1.5 of its usual steps (e.g. a minute with no IEX trade).
    const steps = keys.slice(1).map((k, i) => k.t - keys[i].t).filter((d) => d > 0);
    const maxGap = steps.length ? Math.min(...steps) * 1.5 : Infinity;
    const left = (col) => col * stride + m.l;
    const top = (row) => m.t + row * (labelH + plotH + gapY) + labelH;
    const X = (t, col) => left(col) + ((t - t0) / (t1 - t0)) * panelW;
    const Y = (v, row) => top(row) + (1 - (v - yt.lo) / (yt.hi - yt.lo)) * plotH;

    const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: 'img', 'aria-label': label });
    const panels = clean.map((x, k) => {
      const col = k % cols;
      const row = Math.floor(k / cols);
      const x0 = left(col);
      const g = s('g', null);
      for (const v of yt.ticks) {
        g.append(s('line', { class: 'v-grid', x1: x0, x2: x0 + panelW, y1: px(Y(v, row)), y2: px(Y(v, row)) }),
          s('text', { class: 'v-tick', x: x0 - 6, y: Y(v, row) + 4, 'text-anchor': 'end' }, yFmt(v)));
      }
      if (opts.zero && yt.lo <= 0 && yt.hi >= 0) g.append(s('line', { class: 'v-zero', x1: x0, x2: x0 + panelW, y1: px(Y(0, row)), y2: px(Y(0, row)) }));
      // Panel label: the series name (identity) and its latest value — direct labels in text tokens, not series colour.
      const ly = top(row) - 13;
      g.append(s('text', { class: 'v-plabel', x: x0 - m.l, y: ly }, x.name),
        s('text', { class: 'v-pvalue', x: x0 + panelW, y: ly, 'text-anchor': 'end' }, `latest ${yFmt(last(x).y)}`));
      if (k + cols >= clean.length) { // last panel in its column carries the shared time axis
        for (const t of timeTicks(t0, t1, panelW)) g.append(s('text', { class: 'v-tick', x: X(t, col), y: top(row) + plotH + 17, 'text-anchor': tickAnchor(X(t, col), x0, x0 + panelW) }, fmtEtHm(t)));
      }
      const path = gappedPath(x.points, maxGap, (p) => X(p.t, col), (p) => Y(p.y, row));
      const lp = last(x);
      const cursor = s('line', { class: 'v-cursor', y1: top(row), y2: top(row) + plotH, x1: 0, x2: 0, visibility: 'hidden' });
      const dot = s('circle', { class: 'v-hdot', r: 4, cx: 0, cy: 0, visibility: 'hidden' });
      g.append(cursor, s('path', { class: 'v-line v-s1', d: path.d }), ...path.lone.map((q) => s('circle', { class: 'v-lone', r: 4, cx: X(q.t, col), cy: Y(q.y, row) })),
        s('circle', { class: 'v-end', r: 4, cx: X(lp.t, col), cy: Y(lp.y, row) }), dot);
      svg.append(g);
      return { col, row, cursor, dot };
    });
    // One hit layer over every panel: the pointer only has to be near a minute, never on the 2px line.
    const overlay = s('rect', { class: 'v-overlay', x: 0, y: 0, width: W, height: H });
    svg.append(overlay);
    const fromPointer = (ev) => {
      const r = svg.getBoundingClientRect();
      const sx = ((ev.clientX - r.left) / r.width) * W;
      hoverCol = clamp(Math.floor(sx / stride), 0, cols - 1);
      touch = ev.pointerType === 'touch';
      scrub.set(nearestIdx(keys, t0 + ((sx - left(hoverCol)) / panelW) * (t1 - t0)));
    };
    overlay.addEventListener('pointermove', fromPointer);
    overlay.addEventListener('pointerdown', fromPointer);
    overlay.addEventListener('pointerleave', hide);
    geo = { X, Y, panels };
    if (hoverCol >= cols) hoverCol = 0;
    clear(box).append(svg, tip.el);
  };
  const stop = observeWidth(box, draw);
  return { destroy() { stop(); table.destroy(); } };
}

// ---------------------------------------------------------------------------------------------- price + volume

/**
 * Minute price + inferred-aggressor volume from /api/market/bars rows: [{t,o,h,l,c,v,bv,sv,xv}] (prices in u).
 * Two stacked panels sharing the x-axis, each with its own single y-axis: price (close line from IEX trades and the
 * per-minute high–low range) and volume (stacked: buyer-initiated (inferred), seller-initiated (inferred),
 * unclassified). Minutes without trades leave gaps — nothing is interpolated.
 */
export function priceVolumeChart(host, rows, opts = {}) {
  const data = rows.filter((r) => isNum(r.t)).sort((a, b) => a.t - b.t);
  const label = opts.ariaLabel || 'Price and volume chart';
  host.classList.add('viz');
  const readout = h('div', { class: 'chart-readout', 'aria-hidden': 'true' });
  const box = h('div', { class: 'chart' });
  const legend = h('div', { class: 'legend' },
    legendItem('line', 'k-s1', 'Close (IEX trades)'),
    legendItem('tick', 'k-wick', 'High–low range'),
    legendItem('box', 'k-buy', 'Buyer-initiated (inferred)', '▲'),
    legendItem('box', 'k-sell', 'Seller-initiated (inferred)', '▼'),
    legendItem('box', 'k-neutral', 'Unclassified'));
  const priced = data.filter((r) => isNum(r.c));
  const lastP = priced[priced.length - 1];
  const totalV = data.reduce((a, r) => a + (isNum(r.v) ? r.v : 0), 0);
  const parts = (r) => {
    const b = isNum(r.bv) ? r.bv : 0;
    const sv = isNum(r.sv) ? r.sv : 0;
    let x = isNum(r.xv) ? r.xv : 0;
    if (!b && !sv && !x && isNum(r.v)) x = r.v; // no classification supplied: show as unclassified
    return [b, sv, x];
  };
  const table = tableView(`pv:${label}`, () => dataTable(label,
    ['Time (ET)', 'Open', 'High', 'Low', 'Close', 'Volume', ['▲', 'Buyer-initiated (inferred)'], ['▼', 'Seller-initiated (inferred)'], 'Unclassified'],
    data.map((r) => { const [b, sv, x] = parts(r); return [fmtEtHm(r.t), fmtPriceU(r.o), fmtPriceU(r.h), fmtPriceU(r.l), fmtPriceU(r.c), fmtShares(r.v), fmtShares(b), fmtShares(sv), fmtShares(x)]; })));
  host.append(readout, box, legend, table.el,
    h('p', { class: 'sr-only' }, `${label}: ${data.length} minutes, ${priced.length} with trades; last close ${lastP ? fmtPriceU(lastP.c) : 'none'}; IEX volume ${fmtShares(totalV)} shares.`));
  readout.textContent = lastP ? `Last trade minute ${fmtEt(lastP.t)} · close ${fmtPriceU(lastP.c)} · IEX volume (shown range) ${fmtShares(totalV)}` : 'No IEX trades in the shown range';
  if (!data.length) return { destroy() { table.destroy(); } };

  const tip = tooltip(box);
  const tipRows = (r) => {
    if (!isNum(r.c)) return [{ note: 'No IEX trades this minute (quote updates only)' }];
    const [b, sv, x] = parts(r);
    return [
      { kind: 'line', cls: 'k-s1', v: fmtPriceU(r.c), n: 'Close' },
      { v: fmtPriceU(r.o), n: 'Open' },
      { kind: 'tick', cls: 'k-wick', v: fmtPriceU(r.h), n: 'High' },
      { kind: 'tick', cls: 'k-wick', v: fmtPriceU(r.l), n: 'Low' },
      { v: fmtShares(r.v), n: 'Volume (IEX)' },
      { kind: 'box', cls: 'k-buy', v: fmtShares(b), n: 'Buyer-initiated (inferred)', glyph: '▲' },
      { kind: 'box', cls: 'k-sell', v: fmtShares(sv), n: 'Seller-initiated (inferred)', glyph: '▼' },
      { kind: 'box', cls: 'k-neutral', v: fmtShares(x), n: 'Unclassified' },
    ];
  };
  const valueText = (i) => {
    const r = data[i];
    if (!isNum(r.c)) return `${fmtEt(r.t)}: no IEX trades this minute (quote updates only)`;
    const [b, sv, x] = parts(r);
    return `${fmtEt(r.t)}: open ${fmtPriceU(r.o)}, high ${fmtPriceU(r.h)}, low ${fmtPriceU(r.l)}, close ${fmtPriceU(r.c)}; volume ${fmtShares(r.v)} (buyer-initiated, inferred ${fmtShares(b)}; seller-initiated, inferred ${fmtShares(sv)}; unclassified ${fmtShares(x)})`;
  };
  let geo = null;
  let touch = false; // last input was a touch: dock the tooltip below the plot
  const showAt = (i) => {
    if (!geo) return;
    const r = data[i];
    const x0 = geo.X(r.t);
    const cx = x0 + geo.slot / 2;
    for (const w of geo.hover) { w.setAttribute('x', x0); w.setAttribute('width', Math.max(1, geo.slot)); w.setAttribute('visibility', 'visible'); }
    for (const c of geo.cursors) { c.setAttribute('x1', cx); c.setAttribute('x2', cx); c.setAttribute('visibility', 'visible'); }
    if (isNum(r.c) && geo.Y) { geo.dot.setAttribute('cx', cx); geo.dot.setAttribute('cy', geo.Y(r.c)); geo.dot.setAttribute('visibility', 'visible'); } else geo.dot.setAttribute('visibility', 'hidden');
    tip.show(cx, fmtEt(r.t), tipRows(r), { dock: touch });
  };
  const hide = () => {
    tip.hide();
    if (geo) for (const el of [...geo.hover, geo.dot, ...geo.cursors]) el.setAttribute('visibility', 'hidden');
  };
  box.addEventListener('keydown', () => { touch = false; });
  const scrub = scrubber(box, { label, count: data.length, valueText, onIndex: showAt, onLeave: hide });

  const draw = (width) => {
    const W = Math.max(240, width);
    const phone = W < 480;
    const m = { t: 4, r: 12, b: 24, l: 62 };
    const labelH = 30;
    const ph1 = phone ? 150 : 190;
    const ph2 = phone ? 72 : 84;
    const gapY = 16;
    const top1 = m.t + labelH;
    const top2 = top1 + ph1 + gapY + labelH;
    const H = top2 + ph2 + m.b;
    const pw = W - m.l - m.r;
    const t0 = data[0].t;
    const t1 = data[data.length - 1].t + MIN;
    const slot = pw / Math.max(1, (t1 - t0) / MIN);
    const gapX = slot >= 5 ? 2 : slot >= 3 ? 1 : 0; // 2px surface gap between neighbouring bars when they are wide enough
    const bw = Math.min(24, Math.max(0.6, slot - gapX));
    const X = (t) => m.l + ((t - t0) / (t1 - t0)) * pw;
    const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: 'img', 'aria-label': label });
    // The hovered minute's column lifts in both panels (a faint wash behind the marks).
    const hover = [[top1, ph1], [top2, ph2]].map(([y, hh]) => s('rect', { class: 'v-hover', x: 0, y, width: 1, height: hh, visibility: 'hidden' }));
    svg.append(...hover);

    // Price panel (one y-axis: price).
    const gP = s('g', null, s('text', { class: 'v-plabel', x: 0, y: top1 - 13 }, 'Price (IEX trades)'));
    const lows = data.map((r) => (isNum(r.l) ? r.l : r.c)).filter(isNum);
    const highs = data.map((r) => (isNum(r.h) ? r.h : r.c)).filter(isNum);
    let Y = null;
    if (lows.length) {
      const yt = fitTicks(Math.min(...lows), Math.max(...highs), ph1, 30);
      Y = (v) => top1 + (1 - (v - yt.lo) / (yt.hi - yt.lo)) * ph1;
      for (const v of yt.ticks) {
        gP.append(s('line', { class: 'v-grid', x1: m.l, x2: W - m.r, y1: px(Y(v)), y2: px(Y(v)) }),
          s('text', { class: 'v-tick', x: m.l - 6, y: Y(v) + 4, 'text-anchor': 'end' }, fmtPriceU(Math.round(v))));
      }
      for (const r of data) {
        if (isNum(r.h) && isNum(r.l)) {
          const cx = px(X(r.t) + slot / 2);
          gP.append(s('line', { class: 'v-wick', x1: cx, x2: cx, y1: Y(r.h), y2: Math.max(Y(r.l), Y(r.h) + 1) }));
        }
      }
      // Minutes without trades (and minutes absent from the data) leave gaps; a close with no traded neighbour is a dot.
      const path = gappedPath(priced, MIN * 1.5, (r) => X(r.t) + slot / 2, (r) => Y(r.c));
      if (path.d) gP.append(s('path', { class: 'v-line v-s1', d: path.d }));
      for (const r of path.lone) gP.append(s('circle', { class: 'v-lone', r: 4, cx: X(r.t) + slot / 2, cy: Y(r.c) }));
      if (lastP) gP.append(s('circle', { class: 'v-end', r: 4, cx: X(lastP.t) + slot / 2, cy: Y(lastP.c) }));
    } else {
      gP.append(s('line', { class: 'v-axis', x1: m.l, x2: W - m.r, y1: px(top1 + ph1), y2: px(top1 + ph1) }),
        s('text', { class: 'v-empty', x: m.l + pw / 2, y: top1 + ph1 / 2, 'text-anchor': 'middle' }, 'No IEX trades in range — no price line drawn'));
    }
    svg.append(gP);

    // Volume panel (one y-axis: shares).
    const vmax = Math.max(1, ...data.map((r) => parts(r).reduce((a, b) => a + b, 0)));
    const vt = fitTicks(0, vmax, ph2, 20);
    const VY = (v) => top2 + ph2 - (v / vt.hi) * ph2;
    const gV = s('g', null, s('text', { class: 'v-plabel', x: 0, y: top2 - 13 }, 'Volume (IEX shares)'));
    for (const v of vt.ticks) {
      gV.append(s('line', { class: v === 0 ? 'v-axis' : 'v-grid', x1: m.l, x2: W - m.r, y1: px(VY(v)), y2: px(VY(v)) }),
        s('text', { class: 'v-tick', x: m.l - 6, y: VY(v) + 4, 'text-anchor': 'end' }, fmtShares(v)));
    }
    for (const r of data) {
      const segs = parts(r).map((val, k) => [val, ['v-buy', 'v-sell', 'v-neutral'][k]]).filter(([val]) => val > 0);
      const x0 = X(r.t) + (slot - bw) / 2;
      let base = 0;
      segs.forEach(([val, cls], k) => {
        let yb = VY(base);
        const yTop = VY(base + val);
        base += val;
        // 2px surface gap between stacked segments (skipped where it would erase a hairline-thin segment).
        if (k > 0 && gapX && yb - yTop > 4) yb -= 2;
        const hgt = Math.max(0.5, yb - yTop);
        const rad = k === segs.length - 1 ? Math.min(4, bw / 2, hgt) : 0; // rounded data-end, square at the baseline
        if (rad >= 1) {
          gV.append(s('path', { class: cls, d: `M${x0},${yb}V${yTop + rad}A${rad},${rad} 0 0 1 ${x0 + rad},${yTop}H${x0 + bw - rad}A${rad},${rad} 0 0 1 ${x0 + bw},${yTop + rad}V${yb}Z` }));
        } else {
          gV.append(s('rect', { class: cls, x: x0, width: bw, y: yb - hgt, height: hgt }));
        }
      });
    }
    for (const t of timeTicks(t0, t1, pw)) gV.append(s('text', { class: 'v-tick', x: X(t), y: H - 7, 'text-anchor': tickAnchor(X(t), m.l, W - m.r) }, fmtEtHm(t)));
    svg.append(gV);

    const cursors = [[top1, top1 + ph1], [top2, top2 + ph2]].map(([a, b]) => s('line', { class: 'v-cursor', x1: 0, x2: 0, y1: a, y2: b, visibility: 'hidden' }));
    const dot = s('circle', { class: 'v-hdot', r: 4, cx: 0, cy: 0, visibility: 'hidden' });
    // The hit layer spans both panels: every minute's whole column is its hover target, not just the painted bar.
    const overlay = s('rect', { class: 'v-overlay', x: 0, y: 0, width: W, height: H });
    svg.append(...cursors, dot, overlay);
    const fromPointer = (ev) => {
      const rc = svg.getBoundingClientRect();
      const sx = ((ev.clientX - rc.left) / rc.width) * W;
      touch = ev.pointerType === 'touch';
      scrub.set(nearestIdx(data, t0 + ((sx - m.l) / pw) * (t1 - t0) - MIN / 2));
    };
    overlay.addEventListener('pointermove', fromPointer);
    overlay.addEventListener('pointerdown', fromPointer);
    overlay.addEventListener('pointerleave', hide);
    geo = { X, Y, slot, hover, cursors, dot };
    clear(box).append(svg, tip.el);
  };
  const stop = observeWidth(box, draw);
  return { destroy() { stop(); table.destroy(); } };
}

// ---------------------------------------------------------------------------------------------- sparkline

/**
 * Tiny trend glyph for macro observations (no axes; the caller prints the latest value + date beside it). Drawn in the
 * de-emphasis ink with the latest observation marked by an accent dot, per the stat-tile trend contract.
 */
export function sparkline(values, label) {
  const v = values.filter(isNum);
  if (v.length < 2) return null;
  const W = 120;
  const H = 32;
  const pad = 6;
  const lo = Math.min(...v);
  const hi = Math.max(...v);
  const xy = v.map((y, i) => [pad + (i / (v.length - 1)) * (W - 2 * pad), hi === lo ? H / 2 : H - pad - ((y - lo) / (hi - lo)) * (H - 2 * pad)]);
  const [ex, ey] = xy[xy.length - 1];
  // The end dot is a zero-length round-capped stroke with a non-scaling width, so it stays round at any box aspect.
  return s('svg', { class: 'spark viz', viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'none', role: 'img', 'aria-label': label || 'Sparkline' },
    s('polyline', { class: 'v-spark-line', points: xy.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ') }),
    s('line', { class: 'v-spark-ring', x1: ex, x2: ex, y1: ey, y2: ey }),
    s('line', { class: 'v-spark-end', x1: ex, x2: ex, y1: ey, y2: ey }));
}
