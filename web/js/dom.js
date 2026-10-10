// Tiny DOM builder. All API data enters the page as text nodes or attribute values — never via innerHTML —
// so provider strings cannot inject markup.
const SVG_NS = 'http://www.w3.org/2000/svg';
const PROPS = new Set(['value', 'checked', 'disabled', 'selected', 'indeterminate', 'open', 'hidden', 'readOnly', 'required', 'multiple']);

function apply(el, attrs) {
  if (!attrs) return;
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) {
      if (PROPS.has(k) && v === false) el[k] = false;
      continue;
    }
    if (k === 'class') {
      const c = Array.isArray(v) ? v.filter(Boolean).join(' ') : String(v);
      if (c) el.setAttribute('class', c);
    } else if (k === 'on') {
      for (const [ev, fn] of Object.entries(v)) if (fn) el.addEventListener(ev, fn);
    } else if (k === 'dataset') {
      for (const [dk, dv] of Object.entries(v)) if (dv !== undefined && dv !== null) el.dataset[dk] = String(dv);
    } else if (PROPS.has(k)) {
      el[k] = v;
    } else if (v === true) {
      el.setAttribute(k, '');
    } else {
      el.setAttribute(k, String(v));
    }
  }
}

function appendChildren(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false || c === true) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

/** h('div', {class:'x', on:{click}}, 'text', child, [more]) */
export function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  apply(el, attrs);
  appendChildren(el, children);
  return el;
}

export function s(tag, attrs, ...children) {
  const el = document.createElementNS(SVG_NS, tag);
  if (attrs) for (const [k, v] of Object.entries(attrs)) if (v !== undefined && v !== null && v !== false) el.setAttribute(k, String(v));
  appendChildren(el, children);
  return el;
}

export function clear(el) {
  while (el && el.firstChild) el.removeChild(el.firstChild);
  return el;
}

export function replace(el, ...children) {
  clear(el);
  appendChildren(el, children);
  return el;
}

/** Icon from the sprite in index.html. */
export function icon(name) {
  return s('svg', { class: 'icon', 'aria-hidden': 'true', focusable: 'false' }, s('use', { href: `#i-${name}` }));
}

let uid = 0;
export const nextId = (p = 'v') => `${p}-${++uid}`;

/** Polite screen-reader announcement via the global live region. */
export function announce(msg) {
  const live = document.getElementById('live');
  if (!live) return;
  live.textContent = '';
  setTimeout(() => { live.textContent = String(msg); }, 30);
}

/**
 * Toggle `.is-scrollable` on a horizontally scrolling container so CSS can show an explicit
 * "scroll" hint and edge shadow. Returns a disconnect function.
 */
export function watchScrollable(el) {
  const update = () => el.classList.toggle('is-scrollable', el.scrollWidth > el.clientWidth + 1);
  update();
  if (typeof ResizeObserver === 'undefined') return () => {};
  const ro = new ResizeObserver(update);
  ro.observe(el);
  return () => ro.disconnect();
}

export function prefersReducedMotion() {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/**
 * Run fn() (which re-renders part of `container`) and, if focus was inside the container on an element carrying
 * data-focus-key, move focus back to the re-rendered element with the same key. Status polls re-render views; this
 * keeps keyboard and screen-reader focus from dropping to <body>.
 */
export function preserveFocus(container, fn) {
  const active = typeof document !== 'undefined' ? document.activeElement : null;
  const key = active && container && container.contains(active) ? active.getAttribute?.('data-focus-key') : null;
  const out = fn();
  if (key && !(active.isConnected && container.contains(active))) {
    const next = [...container.querySelectorAll('[data-focus-key]')].find((el) => el.getAttribute('data-focus-key') === key);
    if (next) next.focus({ preventScroll: true });
  }
  return out;
}
