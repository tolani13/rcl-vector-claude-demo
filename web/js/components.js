// Shared UI building blocks. Every renderer is defensive: any API field may be missing, and a missing datum is
// shown as an explicit status (docs/CONTRACTS.md vocabulary), never as an invented value.
import { h, nextId, watchScrollable } from './dom.js';
import {
  DASH, isNum, num, obj, statusTone, isStatusCode, humanizeKey, fmtEt, fmtPriceU, fmtUsdU, fmtBps, fmtPct, fmtFracPct, fmtNum, fmtInt,
  fmtAge, SEGMENT_LABELS, SEGMENT_SHORT, STATUS_HELP,
} from './format.js';

export function badge(code, { tone, title, solid } = {}) {
  const text = code === null || code === undefined || code === '' ? 'UNKNOWN' : String(code);
  // Status codes (NO_VERIFIED_OPTIONS_DATA...) get a break opportunity after each underscore, so a narrow box wraps
  // them between words instead of mid-word; <wbr> adds no characters, so textContent is unchanged.
  const parts = text.split('_').flatMap((seg, i, all) => (i < all.length - 1 ? [`${seg}_`, h('wbr')] : [seg]));
  return h('span', { class: ['badge', `b-${tone || statusTone(text)}`, solid && 'b-solid'], title: title ?? STATUS_HELP[text] }, ...parts);
}

export function pageHeader(title, { sub, crumb, actions } = {}) {
  return h('div', { class: 'page-h' },
    h('div', null,
      crumb || null,
      h('h1', { tabindex: '-1', 'data-focus': 'title' }, title),
      sub ? h('div', { class: 'sub' }, sub) : null),
    actions ? h('div', { class: 'btn-row' }, actions) : null);
}

export function card({ title, meta, actions, cls, big } = {}, ...body) {
  const id = nextId('card');
  return h('section', { class: ['card', cls], 'aria-labelledby': id },
    h('header', { class: 'card-h' },
      h('h2', { id, class: big ? 'big' : null }, title),
      meta ? h('div', { class: 'card-meta' }, meta) : null,
      actions ? h('div', { class: 'card-actions' }, actions) : null),
    ...body);
}

/** Explicit status block. `codes` may be a string or array of status strings. */
export function statusBlock(codes, message, detail, { tone } = {}) {
  const list = (Array.isArray(codes) ? codes : [codes]).filter(Boolean);
  const t = tone || (list.length ? statusTone(list[0]) : 'neutral');
  return h('div', { class: ['state', `t-${t}`], role: 'status' },
    list.length ? h('div', { class: 'badges' }, list.map((c) => badge(c))) : null,
    message ? h('p', null, message) : null,
    detail ? h('p', { class: 'detail' }, detail) : null);
}

/**
 * Did the server reject a query/body field it does not know (HTTP 400 UNKNOWN_FIELD)? With `name`, only when the
 * message names that field. Used to fall back gracefully when an optional API parameter is not supported.
 */
export function isUnknownParam(res, name) {
  const e = res?.error;
  if (!res || res.ok || res.status !== 400 || !e || e.code !== 'UNKNOWN_FIELD') return false;
  return name ? new RegExp(`\\b${String(name).replace(/[^A-Za-z0-9_]/g, '')}\\b`).test(String(e.message ?? '')) : true;
}

/** Render an api.js error result honestly. `what` names the thing that could not be loaded. */
export function errorBlock(res, what) {
  const e = res?.error || { code: 'ERROR', message: 'Unknown error' };
  if (res?.timedOut || e.code === 'CLIENT_TIMEOUT') {
    return statusBlock(['NO RESPONSE YET'], `${what} did not arrive in time.`, 'The server may still be working; this view retries on the next status refresh. Nothing is displayed in place of the missing data.', { tone: 'warn' });
  }
  if (res?.unreachable || e.code === 'API_UNREACHABLE') {
    return statusBlock(['NO_VERIFIED_DATA', 'API UNREACHABLE'], `${what} could not be loaded: the VECTOR API is not responding.`,
      'Start the local server (npm start) and reload. Nothing is displayed in place of the missing data.', { tone: 'bad' });
  }
  if (res?.status === 404) {
    return statusBlock([e.code || 'HTTP_404'], `${what}: endpoint or record not found.`, e.message);
  }
  if (isUnknownParam(res)) {
    return statusBlock([e.code], `${what}: this server does not accept one of the requested options.`, e.message, { tone: 'warn' });
  }
  return statusBlock([e.code || 'ERROR'], `${what} could not be loaded.`, e.message, { tone: 'bad' });
}

export function loading(what) {
  return h('div', { class: 'loading', role: 'status' }, `Loading ${what}…`);
}

export function metric(label, value, { sub, cls, title } = {}) {
  return h('div', { class: 'metric', title },
    h('div', { class: 'metric-k' }, label),
    h('div', { class: ['metric-v', cls] }, value),
    sub ? h('div', { class: 'metric-s' }, sub) : null);
}

/** Labelled segment switch (micro | low | large); short text on the button, the full label as its title. */
export function segmentSwitch(current, onChange, { label = 'Market segment' } = {}) {
  const wrap = h('div', { class: 'seg full', role: 'group', 'aria-label': label });
  const buttons = Object.entries(SEGMENT_LABELS).map(([id, full]) => h('button', {
    type: 'button', 'aria-pressed': String(id === current), dataset: { seg: id }, title: full, 'aria-label': full,
    on: {
      click: () => {
        for (const b of buttons) b.setAttribute('aria-pressed', String(b === btnFor(id)));
        onChange(id);
      },
    },
  }, SEGMENT_SHORT[id] ?? full));
  const btnFor = (id) => buttons.find((b) => b.dataset.seg === id);
  wrap.append(...buttons);
  return wrap;
}

/**
 * Visibly labelled single-choice button group (aria-pressed; >= 44 px buttons, full width on phones).
 * options: [[value, text, title?]]. The group label gives the buttons their context, so the visible text stays the
 * accessible name. Returns the wrapper; wrapper.setValue(v) updates the pressed state without calling onChange.
 */
export function choiceGroup(label, options, current, onChange, { hint } = {}) {
  const id = nextId('grp');
  const hintId = hint ? `${id}-hint` : null;
  const buttons = options.map(([v, text, title]) => h('button', {
    type: 'button', 'aria-pressed': String(String(v) === String(current)), dataset: { v: String(v) }, title: title || null,
  }, text));
  const setValue = (v) => { for (const b of buttons) b.setAttribute('aria-pressed', String(b.dataset.v === String(v))); };
  for (const b of buttons) {
    b.addEventListener('click', () => {
      if (b.getAttribute('aria-pressed') === 'true') return;
      setValue(b.dataset.v);
      onChange(b.dataset.v);
    });
  }
  const wrap = h('div', { class: 'field choice' },
    h('span', { class: 'lbl', id }, label),
    h('div', { class: 'seg full', role: 'group', 'aria-labelledby': id, 'aria-describedby': hintId }, buttons),
    hint ? h('div', { class: 'hint', id: hintId }, hint) : null);
  wrap.setValue = setValue;
  return wrap;
}

// ---------------------------------------------------------------- generic value / section rendering

const TS_KEY = /(^t$|^ts$|_ts$|Ts$|_at$|At$|^asOf$|as_of$|_wall$|Wall$|^clock$|^t_start$|^t_end$|time_start$|time_end$)/;
// Prices are integer u (1e-4 USD) per docs/CONTRACTS.md; formatted with sub-penny precision below one dollar.
const PRICE_KEY = /^(bid|ask|mid|o|h|l|c|vwap|price|mark|limit_px|stop_px|min_bid|max_bid|min_ask|max_ask|minBid|maxBid|minAsk|maxAsk|spreadU)$|(px_u|PxU|PriceU|priceU|markU)$/;
// Durations / instants in milliseconds (instants are told apart by magnitude, see fmtByKey).
const MS_KEY = /(ageMs|_ms|Ms)$/;
// Fractions 0..1 shown as percent (e.g. FINRA short ratio, inferred buy share, classified share).
const FRACTION_KEY = /(ratio|Ratio|[sS]hare)$/;
// Money amounts in u.
const U_KEY = /(U$|_u$|^cost_basis$|^cash$|^starting_cash$|^realized_pnl$|^fees_paid$|^fees$|^proceeds$)/;

/** Format a scalar API value by its key name (units per docs/CONTRACTS.md). */
export function fmtByKey(key, v) {
  if (v === null || v === undefined) return DASH;
  if (typeof v === 'boolean') return v ? 'yes' : 'no';
  const k = String(key || '');
  if (isNum(v)) {
    // Epoch milliseconds (any ms-suffixed or timestamp-named key holding a value after 1973) are instants, not durations.
    if ((TS_KEY.test(k) || MS_KEY.test(k)) && v > 1e11) return fmtEt(v, { date: true, seconds: true });
    if (PRICE_KEY.test(k)) return fmtPriceU(v);
    if (U_KEY.test(k)) return fmtUsdU(v);
    if (MS_KEY.test(k)) return v < 60000 ? `${fmtInt(v)} ms` : fmtAge(v);
    if (FRACTION_KEY.test(k) && v >= 0 && v <= 1) return fmtFracPct(v, { sign: false });
    if (/bps|Bps/.test(k)) return fmtBps(v);
    if (/pct|Pct/.test(k)) return fmtPct(v);
    if (Number.isInteger(v)) return fmtInt(v);
    return fmtNum(v, 4);
  }
  return String(v);
}

function linkOrText(v) {
  if (typeof v === 'string' && /^https?:\/\/[^\s]+$/.test(v)) {
    return h('a', { href: v, target: '_blank', rel: 'noopener noreferrer' }, v);
  }
  return String(v);
}

/** Render any API value (scalar/array/object) as readable, escaped DOM. */
export function renderValue(v, key, depth = 0) {
  if (v === null || v === undefined) return h('span', { class: 'muted', title: 'not provided' }, DASH);
  if (typeof v === 'object' && typeof v.nodeType === 'number') return v; // an already-built DOM node (e.g. a badge or hash span)
  if (typeof v === 'string') {
    if (isStatusCode(v) && v.length <= 40) return badge(v);
    if (/sha256|hash/i.test(String(key || ''))) return h('span', { class: 'hash' }, v);
    return linkOrText(v);
  }
  if (typeof v !== 'object') return fmtByKey(key, v);
  if (Array.isArray(v)) {
    if (!v.length) return h('span', { class: 'muted' }, 'none');
    if (v.every((x) => x === null || typeof x !== 'object')) return v.map((x) => (typeof x === 'string' ? x : fmtByKey(key, x))).join(', ');
    if (depth >= 3) return rawJson(v);
    const shown = v.slice(0, 50);
    return h('ul', { class: 'kv-list' },
      shown.map((x) => h('li', null, renderValue(x, key, depth + 1))),
      v.length > shown.length ? h('li', { class: 'muted' }, `${v.length - shown.length} more not shown`) : null);
  }
  if (depth >= 3) return rawJson(v);
  return kv(v, { depth: depth + 1 });
}

/** Deeply nested values collapse into a disclosure with a horizontally scrollable JSON block (never a squeezed column). */
function rawJson(v) {
  const n = Array.isArray(v) ? `${v.length} item${v.length === 1 ? '' : 's'}` : `${Object.keys(v).length} field${Object.keys(v).length === 1 ? '' : 's'}`;
  return h('details', { class: 'raw-json' }, h('summary', null, `Raw JSON (${n})`), h('pre', { class: 'payload' }, JSON.stringify(v, null, 2)));
}

/** Definition list of an object's fields. `labels` overrides key names; `skip` hides keys. */
export function kv(o, { labels = {}, skip = [], depth = 0, order } = {}) {
  const entries = Object.entries(o || {}).filter(([k, v]) => !skip.includes(k) && v !== undefined);
  if (order) entries.sort((a, b) => (order.indexOf(a[0]) + 1 || 999) - (order.indexOf(b[0]) + 1 || 999));
  if (!entries.length) return h('span', { class: 'muted' }, 'none');
  return h('dl', { class: 'kv' }, entries.map(([k, v]) => h('div', null,
    h('dt', null, labels[k] || humanizeKey(k)),
    h('dd', null, renderValue(v, k, depth)))));
}

/**
 * Render a dossier-style section whose shape is not fixed by the contract. Accepts:
 *   null/undefined -> UNAVAILABLE_NOT_VERIFIED; a status string; {status, detail|reason|message, ...fields};
 *   an array of records (empty -> "NONE RETURNED", which is not evidence of absence).
 */
export function renderSection(value, { what = 'This section' } = {}) {
  if (value === null || value === undefined) {
    return statusBlock('UNAVAILABLE_NOT_VERIFIED', `${what} was not provided by the API.`, 'Shown as unavailable rather than inferred.');
  }
  if (typeof value === 'string') {
    return isStatusCode(value) ? statusBlock(value, `${what}: ${value.replace(/_/g, ' ').toLowerCase()}.`) : h('p', null, value);
  }
  if (Array.isArray(value)) {
    if (!value.length) {
      return statusBlock('NONE RETURNED', `The API returned no records for ${what.toLowerCase()} as of the replay clock.`,
        'Absence of records is not evidence of absence — coverage depends on which sources are ingested (see Data sources).');
    }
    return renderValue(value, what);
  }
  const o = obj(value);
  const status = typeof o.status === 'string' ? o.status : null;
  const note = o.detail || o.reason || o.message || o.note || null;
  const rest = Object.fromEntries(Object.entries(o).filter(([k]) => !['status', 'detail', 'reason', 'message', 'note'].includes(k)));
  return h('div', { class: 'stack' },
    status ? h('div', { class: 'badges' }, badge(status)) : null,
    note ? h('p', { class: 'note' }, String(note)) : null,
    Object.keys(rest).length ? kv(rest) : (status || note ? null : h('span', { class: 'muted' }, 'empty')));
}

// ---------------------------------------------------------------- responsive table (cards on phones)

/**
 * columns: [{key, label, num?, head?, full?, render(row) -> node|string}]
 * On phones each row becomes a labelled card (CSS uses data-label); on desktop a real table.
 */
export function rtable(columns, rows, { caption, empty = 'No rows.', cls } = {}) {
  if (!rows.length) return statusBlock('NONE RETURNED', empty);
  const table = h('table', { class: ['rtable', cls], role: 'table' },
    caption ? h('caption', { class: 'sr-only' }, caption) : null,
    h('thead', null, h('tr', { role: 'row' }, columns.map((c) => h('th', { scope: 'col', role: 'columnheader', class: [c.num && 'n', c.cls] }, c.label)))),
    h('tbody', null, rows.map((r) => h('tr', { role: 'row' }, columns.map((c) => {
      const v = c.render ? c.render(r) : fmtByKey(c.key, r[c.key]);
      // c.cls: 'sec' = hidden on phones (shown in the row's phone-only details), 'ph' = phone-only column.
      return h('td', { role: 'cell', 'data-label': c.label, class: [c.num && 'n', c.head && 'head', c.full && 'full', c.cls] }, v ?? DASH);
    })))));
  const wrap = h('div', { class: 'scroll-x' }, table);
  const out = h('div', null, wrap, h('div', { class: 'scroll-hint', 'aria-hidden': 'true' }, 'Scroll sideways for more columns →'));
  queueMicrotask(() => { if (wrap.isConnected) watchScrollable(wrap); else requestAnimationFrame(() => watchScrollable(wrap)); });
  return out;
}

/** Signed value with arrow + up/down class (never colour alone). */
export function signed(value, formatted) {
  const v = num(value);
  if (v === null) return h('span', { class: 'muted' }, DASH);
  const d = v > 0 ? 'up' : v < 0 ? 'down' : 'flat';
  const a = d === 'up' ? '▲' : d === 'down' ? '▼' : '■';
  return h('span', { class: d }, h('span', { 'aria-hidden': 'true' }, `${a} `), formatted ?? String(v));
}

// ---------------------------------------------------------------- form helpers

export function field(label, control, { hint, error, id } = {}) {
  const cid = id || control.id || nextId('f');
  control.id = cid;
  const hintId = hint ? `${cid}-hint` : null;
  if (hintId) control.setAttribute('aria-describedby', hintId);
  return h('div', { class: 'field' },
    h('label', { for: cid }, label),
    control,
    hint ? h('div', { class: 'hint', id: hintId }, hint) : null,
    error ? h('div', { class: 'err' }, error) : null);
}

export function select(options, value, attrs = {}) {
  return h('select', attrs, options.map((o) => {
    const [v, t] = Array.isArray(o) ? o : [o, o];
    return h('option', { value: v, selected: String(v) === String(value) }, t);
  }));
}

/**
 * Inline two-step confirmation: renders a confirm box with the summary and Confirm/Cancel buttons.
 * Returns the element; onConfirm may be async and its result is not awaited by the caller.
 */
export function confirmBox({ title, body, confirmLabel = 'Confirm', danger = false, onConfirm, onCancel }) {
  const confirmBtn = h('button', { type: 'button', class: ['btn', danger ? 'btn-danger solid' : 'btn-primary'] }, confirmLabel);
  const cancelBtn = h('button', { type: 'button', class: 'btn btn-ghost' }, 'Cancel');
  const box = h('div', { class: ['confirm-box', !danger && 'copper'], role: 'group', 'aria-label': title },
    h('strong', null, title),
    body,
    h('div', { class: 'btn-row stretch' }, confirmBtn, cancelBtn));
  confirmBtn.addEventListener('click', async () => {
    confirmBtn.disabled = true; cancelBtn.disabled = true;
    try { await onConfirm(); } finally { confirmBtn.disabled = false; cancelBtn.disabled = false; }
  });
  cancelBtn.addEventListener('click', () => onCancel && onCancel());
  queueMicrotask(() => confirmBtn.focus());
  return box;
}

/** Render a mutation result ({decision, reasons, checks} or api error) for aria-live regions. */
export function decisionResult(res) {
  if (!res.ok) {
    const e = res.error || {};
    const d = obj(res.data) || {};
    const reasons = Array.isArray(d.reasons) ? d.reasons : null;
    if (res.timedOut || e.code === 'CLIENT_TIMEOUT') {
      return h('div', { class: 'result pending' },
        h('div', { class: 'badges' }, badge('NO RESPONSE YET', { tone: 'warn' })),
        h('p', null, e.message || 'No response yet — the server may still be working.'));
    }
    return h('div', { class: 'result denied' },
      h('div', { class: 'badges' }, res.unreachable || e.code === 'API_UNREACHABLE' ? badge('API UNREACHABLE') : badge(d.decision || e.code || 'ERROR')),
      h('p', null, e.message || 'Request failed.'),
      reasons ? reasonList(reasons) : null);
  }
  const d = obj(res.data) || {};
  const decision = d.decision || d.status || 'OK';
  const accepted = decision === 'ACCEPTED' || decision === 'OK';
  return h('div', { class: ['result', accepted ? 'accepted' : 'denied'] },
    h('div', { class: 'badges' }, badge(decision)),
    Array.isArray(d.reasons) && d.reasons.length ? reasonList(d.reasons) : null,
    Array.isArray(d.checks) && d.checks.length ? h('details', null, h('summary', null, `Policy checks (${d.checks.length})`), checkList(d.checks)) : null,
    (() => {
      const rest = Object.fromEntries(Object.entries(d).filter(([k]) => !['decision', 'reasons', 'checks', 'status'].includes(k)));
      return Object.keys(rest).length ? h('details', null, h('summary', null, 'Response details'), kv(rest)) : null;
    })());
}

export function reasonList(reasons) {
  return h('ul', { class: 'reasons' }, reasons.map((r) => {
    const o = obj(r) || { code: String(r) };
    return h('li', null, badge(o.code || 'REASON', { tone: 'bad' }), h('span', null, o.detail ? String(o.detail) : ''));
  }));
}

export function checkList(checks) {
  return h('ul', { class: 'checks' }, checks.map((c) => {
    const o = obj(c) || {};
    return h('li', null,
      h('span', { class: o.pass ? 'up' : 'down' }, o.pass ? '✓ pass' : '✕ fail'),
      h('span', { class: 'mono' }, String(o.rule ?? '')),
      o.detail ? h('span', { class: 'muted' }, typeof o.detail === 'string' ? o.detail : JSON.stringify(o.detail)) : null);
  }));
}
