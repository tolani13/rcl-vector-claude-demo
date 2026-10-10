// #/lab — paper-trading lab: portfolio switcher (6 lens × segment portfolios + sandbox), cash/equity/P&L,
// positions marked at the IEX bid (with mark basis), working orders with cancel and (sandbox) modify, ESTIMATED PAPER
// FILLs with their assumptions and the observed IEX data behind them, the sandbox order ticket (review step with
// estimated cost incl. slippage/fees -> confirm -> policy gate decision), and the long-put section (disabled unless a
// verified options provider exists).
import { h, replace, announce, preserveFocus, prefersReducedMotion } from '../dom.js';
import * as api from '../api.js';
import {
  card, pageHeader, statusBlock, loading, badge, kv, rtable, field, select, confirmBox, decisionResult, metric, signed,
} from '../components.js';
import { setPref } from '../store.js';
import { normalizeSym } from '../router.js';
import { estimateOrder, isValidTick, COST_MODEL_DEFAULTS } from '../estimate.js';
import { rowsOf, makeLoader } from './common.js';
import {
  arr, obj, num, isNum, parseMaybeJson, fmtUsdU, fmtPriceU, fmtEt, fmtInt, fmtAge, fmtBps, usdToU, humanizeKey, fillEnumText, PORTFOLIO_IDS,
  portfolioLabel, U_PER_USD, DASH,
} from '../format.js';

const CANCELLABLE = new Set(['working', 'pending_parent', 'triggered', 'partially_filled']);

/** Normalise a portfolio list item or portfolioSummary() result (docs/CONTRACTS.md §3). */
export function normPortfolio(x) {
  const p = obj(x?.portfolio) || obj(x) || {};
  const id = p.id ?? x?.id ?? null;
  const startingU = num(p.starting_cash ?? p.startingCashU ?? x?.startingCashU);
  const equityU = num(x?.equityU ?? p.equityU);
  return {
    id, name: p.name ?? null, lens: p.lens ?? null, segment: p.segment ?? null, kind: p.kind ?? null,
    startingU,
    cashU: num(x?.cashU ?? p.cashU ?? p.cash),
    equityU,
    unrealizedU: num(x?.unrealizedU ?? p.unrealizedU),
    realizedU: num(x?.realizedU ?? p.realizedU ?? p.realized_pnl),
    feesU: num(x?.feesU ?? p.feesU ?? p.fees_paid),
    pnlU: isNum(equityU) && isNum(startingU) ? equityU - startingU : null,
    positions: arr(x?.positions).map(normPosition),
    orders: arr(x?.openOrders ?? x?.orders),
    fills: arr(x?.fills ?? x?.recentFills),
  };
}

function normPosition(r) {
  const o = obj(r) || {};
  return {
    sym: o.sym ?? null, kind: o.kind ?? 'equity', qty: num(o.qty),
    costU: num(o.cost_basis ?? o.costBasisU ?? o.costU),
    markU: num(o.markU ?? o.mark ?? o.markPriceU),
    markBasis: o.markBasis ?? o.mark_basis ?? null,
    valueU: num(o.valueU ?? o.marketValueU ?? o.value),
    unrealizedU: num(o.unrealizedU ?? o.unrealized),
  };
}

/** Did the replay move since an order review was built? (Then its quote and estimate are out of date.) */
export function reviewIsStale(reviewCtx, replay) {
  if (!reviewCtx) return false;
  const r = obj(replay) || {};
  return (r.clock ?? null) !== reviewCtx.clock || (r.session_id ?? null) !== reviewCtx.session;
}

/** Body for POST /api/orders/:id/replace from a modify form: only changed terms, or null when nothing changed. */
export function replaceBody(order, { qty, limitU, stopU }) {
  const body = {};
  if (isNum(qty) && qty !== num(order.qty)) body.qty = qty;
  if (isNum(limitU) && limitU !== num(order.limit_px)) body.limit_px_u = limitU;
  if (isNum(stopU) && stopU !== num(order.stop_px)) body.stop_px_u = stopU;
  return Object.keys(body).length ? { ...body, confirm: true } : null;
}

// ---------------------------------------------------------------- fill provenance (assumptions + observed IEX data)

const ASSUMPTION_LABELS = {
  model: 'Fill model', priceBasis: 'Price basis', rule: 'Fill rule', basePriceU: 'Base price before slippage', slippageBps: 'Slippage',
  tickRule: 'Tick rounding', displayedSizeCap: 'Capped at displayed size', sizeSource: 'Size source', displayedSizeUsed: 'Displayed size used (shares)',
  qtyRequested: 'Quantity requested', qtyLimitedBy: 'Quantity limited by', affordabilityReduced: 'Reduced to what cash affords', multiplier: 'Multiplier',
  maxQuoteAgeMs: 'Max quote age', omitted: 'Not modelled', estimated: 'Estimated', notExchangeExecution: 'Not an exchange execution',
};
const FEE_LABELS = {
  commissionU: 'Commission', secFeeU: 'SEC fee', tafU: 'FINRA TAF', totalU: 'Total fees', rounding: 'Rounding', commissionPerOrderU: 'Commission per order',
  secFeeRatePerMillionUsd: 'SEC fee rate (USD per million USD sold)', tafPerShareU: 'TAF per share', tafCapU: 'TAF cap per trade',
};
/** Labels for every key of o: curated where known, otherwise humanized without the engineering "U" (1e-4 USD) suffix. */
export function labelsFor(o, curated) {
  return Object.fromEntries(Object.keys(o || {}).map((k) => [k, curated[k] ?? humanizeKey(k).replace(/\s+U$/, '')]));
}
const plainEnums = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k,
  typeof v === 'string' ? fillEnumText(v) : Array.isArray(v) ? v.map((x) => (typeof x === 'string' ? fillEnumText(x) : x)) : v]));

function quoteText(q) {
  const o = obj(q);
  if (!o) return 'no IEX quote in effect';
  return `bid ${fmtPriceU(num(o.bid))} × ${fmtInt(o.bidSize)} / ask ${fmtPriceU(num(o.ask))} × ${fmtInt(o.askSize)}${isNum(num(o.quoteTs)) ? ` (quoted ${fmtEt(num(o.quoteTs), { seconds: true })})` : ''}`;
}

/** The fill's two provenance blocks: observed IEX data for the minute, then the model assumptions. */
export function fillProvenance(f) {
  let a = obj(f?.assumptions);
  let o = obj(f?.observed);
  if (!a && !o) {
    const w = obj(parseMaybeJson(f?.assumptions_json));
    a = obj(w?.assumptions) ?? (w && !('observed' in w) ? w : null);
    o = obj(w?.observed);
  }
  return { assumptions: a, observed: o };
}

function fillDetails(f) {
  const { assumptions: a, observed: o } = fillProvenance(f);
  if (!a && !o) return h('span', { class: 'muted' }, 'not provided');
  const t = obj(o?.trades);
  const side = String(f.side ?? '').toLowerCase();
  const price = num(f.price ?? f.priceU);
  const compare = o && isNum(price)
    ? side === 'sell'
      ? `Estimated price ${fmtPriceU(price)} vs lowest observed IEX bid ${fmtPriceU(num(o.minBid))} in the minute.`
      : `Estimated price ${fmtPriceU(price)} vs highest observed IEX ask ${fmtPriceU(num(o.maxAsk))} in the minute.`
    : null;
  return h('details', { 'data-key': `fill-${f.id ?? `${f.sym}-${f.ts}`}` }, h('summary', null, 'Assumptions & observed data'),
    h('div', { class: 'stack' },
      compare ? h('p', { class: 'small note' }, compare) : null,
      h('h4', { class: 'section-title' }, `Observed IEX data${isNum(num(o?.minuteT)) ? ` · minute ${fmtEt(num(o.minuteT))}` : ''}`),
      o ? kv({
        'Quote at minute start': quoteText(o.startQuote),
        'Quote at minute end': quoteText(o.endQuote),
        'Lowest / highest bid': `${fmtPriceU(num(o.minBid))} / ${fmtPriceU(num(o.maxBid))}`,
        'Lowest / highest ask': `${fmtPriceU(num(o.minAsk))} / ${fmtPriceU(num(o.maxAsk))}`,
        'IEX trades in minute': t
          ? `open ${fmtPriceU(num(t.o))} · high ${fmtPriceU(num(t.h))} · low ${fmtPriceU(num(t.l))} · close ${fmtPriceU(num(t.c))} · volume ${fmtInt(t.v)} shares · ${fmtInt(t.n)} trades · VWAP ${fmtPriceU(num(t.vwap))}`
          : 'no IEX trades in the minute',
        Venue: `${o.venue ?? 'IEX'} only (not NBBO)`,
        Dataset: o.ds ?? DASH,
        ...(o.halted ? { Halted: 'yes' } : {}),
        ...(o.unavailable ? { 'Data unavailable': 'yes' } : {}),
      }) : h('p', { class: 'small muted' }, 'Observed data not provided by the API for this fill.'),
      h('h4', { class: 'section-title' }, 'Model assumptions'),
      a ? kv(plainEnums(Object.fromEntries(Object.entries(a).filter(([k]) => k !== 'fees'))), { labels: labelsFor(a, ASSUMPTION_LABELS) }) : h('p', { class: 'small muted' }, 'Assumptions not provided.'),
      obj(a?.fees) ? [h('h4', { class: 'section-title' }, 'Fees (assumed rates)'), kv(plainEnums(a.fees), { labels: labelsFor(a.fees, FEE_LABELS) })] : null));
}

export function render(root, { route, store }) {
  let alive = true;
  const load = makeLoader(() => alive);
  const preSym = normalizeSym(route.query.sym || '') || '';
  const qp = route.query.p;
  // Opening the Lab from a dossier ("Paper-trade in Lab") shows the sandbox, where the order would go.
  let selected = preSym ? 'sandbox' : PORTFOLIO_IDS.includes(qp) ? qp : PORTFOLIO_IDS.includes(store.prefs.portfolio) ? store.prefs.portfolio : 'sandbox';
  let list = [];
  let sandboxSummary = null;
  let switchSig = null;

  const switchBody = h('div');
  const compareBody = h('div', null, loading('portfolios'));
  const detailTitle = h('span', null, portfolioLabel(selected));
  const detailBody = h('div', null, loading('portfolio'));
  const opsResult = h('div', { role: 'status', 'aria-live': 'polite', tabindex: '-1', class: 'ticket-result' });
  const optionsBody = h('div', null, loading('options status'));
  const tk = ticket();
  const ticketCard = card({ title: preSym ? `Sandbox order ticket · ${preSym}` : 'Sandbox order ticket', cls: 'span-7' }, tk.el);
  const ticketHeading = ticketCard.querySelector('h2');
  ticketHeading?.setAttribute('tabindex', '-1');
  const optionsCard = card({ title: 'Put options · long puts only', cls: 'span-5' }, optionsBody);
  const portfoliosCard = card({ title: 'Portfolios', cls: 'span-12' }, switchBody, compareBody);
  const detailCard = card({ title: detailTitle, cls: 'span-12', big: true }, opsResult, detailBody);

  root.append(
    pageHeader('Paper lab', { sub: 'Simulated seed money only. Every fill is an ESTIMATED PAPER FILL — never an exchange execution.' }),
    // With a prefilled symbol the ticket comes first, so nothing above it shifts while portfolios load.
    h('div', { class: 'grid grid-12' }, preSym ? [ticketCard, optionsCard, portfoliosCard, detailCard] : [portfoliosCard, detailCard, ticketCard, optionsCard]));

  const reveal = (el, block = 'start') => el?.scrollIntoView?.({ block, behavior: prefersReducedMotion() ? 'auto' : 'smooth' });

  // ---------------------------------------------------------------- switcher + comparison (re-rendered only on change)
  function drawSwitch() {
    const ids = list.length ? list.map((p) => p.id).filter(Boolean) : PORTFOLIO_IDS;
    const opts = ids.map((id) => [id, portfolioLabel(id, list.find((p) => p.id === id)?.name)]);
    const sig = JSON.stringify([opts, selected]);
    if (sig === switchSig) return;
    switchSig = sig;
    preserveFocus(switchBody, () => {
      const sel = select(opts, selected, { 'data-focus-key': 'portfolio-select' });
      sel.addEventListener('change', () => choose(sel.value));
      replace(switchBody, field('Portfolio', sel, { hint: 'Six lens × segment agent portfolios plus the human sandbox.' }));
    });
  }

  function choose(id) {
    selected = id;
    setPref('portfolio', id);
    detailTitle.textContent = portfolioLabel(id, list.find((p) => p.id === id)?.name);
    drawSwitch();
    drawCompare();
    loadDetail(true);
  }

  function drawCompare() {
    if (!list.length) return;
    preserveFocus(compareBody, () => replace(compareBody, h('div', { class: 'portfolio-grid', role: 'group', 'aria-label': 'Compare portfolios' }, list.map((p) => h('button', {
      type: 'button', class: 'pcard', 'aria-pressed': String(p.id === selected), 'data-focus-key': `pcard-${p.id}`, on: { click: () => choose(p.id) },
    },
    h('span', { class: 't' }, portfolioLabel(p.id, p.name)),
    h('span', { class: 's' }, `Equity ${isNum(p.equityU) ? fmtUsdU(p.equityU) : 'UNMARKED'}`),
    h('span', { class: 's' }, `Cash ${fmtUsdU(p.cashU)}`),
    h('span', { class: 'small' }, 'P&L ', isNum(p.pnlU) ? signed(p.pnlU, fmtUsdU(p.pnlU, { sign: true })) : h('span', { class: 'muted' }, 'n/a')))))));
  }

  const loadList = () => load('list', '/api/portfolios', list.length ? null : compareBody, 'Portfolios', (d) => {
    list = rowsOf(d, 'portfolios').map(normPortfolio).filter((p) => p.id);
    if (!list.length) {
      replace(compareBody, statusBlock('NONE RETURNED', 'No paper portfolios exist yet.', 'Start a replay session (Replay › Reset) to create the six agent portfolios and the sandbox with simulated seed money.'));
    } else {
      if (!list.some((p) => p.id === selected)) selected = list.some((p) => p.id === 'sandbox') ? 'sandbox' : list[0].id;
      drawCompare();
    }
    drawSwitch();
  });

  // ---------------------------------------------------------------- selected portfolio detail
  /** An open confirmation or modify form in the detail card must not be wiped by a clock-tick refresh. */
  const detailBusy = () => !!detailBody.querySelector('.confirm-box, form.modify-form');

  const loadDetail = (showLoading) => load('detail', `/api/portfolios/${encodeURIComponent(selected)}`, detailBody, 'Portfolio', (d) => {
    if (!showLoading && detailBusy()) return;
    const p = normPortfolio(d);
    if (p.id === 'sandbox' || selected === 'sandbox') sandboxSummary = p;
    const openKeys = new Set([...detailBody.querySelectorAll('details[open][data-key]')].map((x) => x.dataset.key));
    preserveFocus(detailBody, () => replace(detailBody,
      h('div', { class: 'metrics m5' },
        metric('Cash', fmtUsdU(p.cashU)),
        metric('Equity (marked)', isNum(p.equityU) ? fmtUsdU(p.equityU) : 'UNMARKED', { sub: 'positions valued at the IEX bid as of the replay clock' }),
        metric('P&L vs start', isNum(p.pnlU) ? signed(p.pnlU, fmtUsdU(p.pnlU, { sign: true })) : 'n/a', { sub: `start ${fmtUsdU(p.startingU)}` }),
        metric('Realized', isNum(p.realizedU) ? signed(p.realizedU, fmtUsdU(p.realizedU, { sign: true })) : DASH),
        metric('Fees paid', fmtUsdU(p.feesU), { sub: 'estimated' })),
      h('h3', { class: 'section-title' }, 'Positions'),
      positionsTable(p.positions),
      h('p', { class: 'small muted' }, 'Marks use the IEX bid as of the replay clock (conservative for longs). LAST_TRADE_NO_BID = no two-sided quote, marked at the last IEX trade. UNMARKED = neither available; excluded from equity.'),
      h('h3', { class: 'section-title' }, 'Working orders'),
      ordersTable(p.orders.filter((o) => CANCELLABLE.has(o?.status) || !o?.status)),
      h('h3', { class: 'section-title' }, 'Estimated paper fills'),
      fillsTable(p.fills)));
    for (const el of detailBody.querySelectorAll('details[data-key]')) if (openKeys.has(el.dataset.key)) el.open = true;
  }, { showLoading });

  function positionsTable(rows) {
    return rtable([
      { label: 'Symbol', head: true, render: (r) => h('a', { class: 'row-link', href: `#/research/${encodeURIComponent(r.sym ?? '')}` }, h('span', { class: 'sym' }, r.sym ?? DASH), h('span', { class: 'sub' }, r.kind)) },
      { label: 'Qty', num: true, render: (r) => fmtInt(r.qty) },
      { label: 'Cost basis', num: true, render: (r) => fmtUsdU(r.costU) },
      { label: 'Mark', num: true, render: (r) => fmtPriceU(r.markU) },
      { label: 'Mark basis', render: (r) => badge(r.markBasis ?? 'UNMARKED') },
      { label: 'Value', num: true, render: (r) => (isNum(r.valueU) ? fmtUsdU(r.valueU) : 'UNMARKED') },
      { label: 'Unrealized', num: true, render: (r) => (isNum(r.unrealizedU) ? signed(r.unrealizedU, fmtUsdU(r.unrealizedU, { sign: true })) : DASH) },
    ], rows, { caption: 'Positions', empty: 'No open positions.' });
  }

  function ordersTable(rows) {
    return rtable([
      { label: 'Order', head: true, render: (o) => h('span', null, h('span', { class: 'sym' }, `${String(o.side ?? '').toUpperCase()} ${o.sym ?? DASH}`),
        h('span', { class: 'sub' }, [o.type, o.role, o.protective ? 'protective' : null].filter(Boolean).join(' · '))) },
      { label: 'Qty (filled)', num: true, render: (o) => `${fmtInt(o.qty)} (${fmtInt(o.filled_qty ?? 0)})` },
      { label: 'Limit', num: true, render: (o) => fmtPriceU(num(o.limit_px)) },
      { label: 'Stop', num: true, render: (o) => fmtPriceU(num(o.stop_px)) },
      { label: 'Status', render: (o) => badge(o.status ?? 'UNKNOWN') },
      { label: 'Submitted', render: (o) => fmtEt(num(o.created_ts)) },
      { label: 'Action', full: true, render: (o) => orderActions(o) },
    ], rows, { caption: 'Working orders', empty: 'No working orders.' });
  }

  function showOps(...nodes) {
    replace(opsResult, ...nodes);
    opsResult.focus({ preventScroll: true });
    reveal(opsResult, 'nearest');
  }

  function orderActions(o) {
    const slot = h('div');
    const reset = () => replace(slot, buttons());
    function buttons() {
      if (!o.id || !CANCELLABLE.has(o.status)) return h('span', { class: 'muted' }, 'not cancellable');
      const cancel = h('button', { type: 'button', class: 'btn btn-danger', 'data-focus-key': `cancel-${o.id}` }, 'Cancel…');
      cancel.addEventListener('click', () => replace(slot, confirmBox({
        title: `Cancel ${String(o.side ?? '').toUpperCase()} ${o.sym ?? ''} ${o.type ?? ''} order?`,
        body: h('p', { class: 'small' }, o.protective ? 'This is a PROTECTIVE order (stop-loss / take-profit / time exit). Cancelling leaves the position unprotected.' : 'The order stops working immediately. This is journaled.'),
        confirmLabel: 'Cancel order', danger: true,
        onConfirm: async () => {
          const res = await api.post(`/api/orders/${encodeURIComponent(o.id)}/cancel`, { confirm: true }); // confirmed in the dialog above
          if (!alive) return;
          reset();
          showOps(h('h3', { class: 'section-title' }, 'Cancel request'), decisionResult(res));
          announce(res.ok ? 'Order cancelled.' : `Cancel failed: ${res.error?.message ?? ''}`);
          loadDetail(false); loadList();
        },
        onCancel: reset,
      })));
      const out = [cancel];
      if ((o.portfolio_id ?? selected) === 'sandbox') {
        const mod = h('button', { type: 'button', class: 'btn', 'data-focus-key': `modify-${o.id}` }, 'Modify…');
        mod.addEventListener('click', () => { replace(slot, modifyForm(o, reset)); slot.querySelector('input')?.focus(); });
        out.unshift(mod);
      }
      return h('div', { class: 'btn-row' }, out);
    }
    reset();
    return slot;
  }

  /** Inline replace form for a working sandbox order (quantity, limit and/or stop), with a confirmation step. */
  function modifyForm(o, done) {
    const needLimit = o.type === 'limit' || o.type === 'stop_limit';
    const needStop = o.type === 'stop' || o.type === 'stop_limit';
    const usdText = (u) => (isNum(num(u)) ? String(num(u) / U_PER_USD) : '');
    const qtyIn = h('input', { type: 'number', min: '1', step: '1', inputmode: 'numeric', value: String(num(o.qty) ?? '') });
    const limitIn = needLimit ? h('input', { type: 'number', min: '0', step: 'any', inputmode: 'decimal', value: usdText(o.limit_px) }) : null;
    const stopIn = needStop ? h('input', { type: 'number', min: '0', step: 'any', inputmode: 'decimal', value: usdText(o.stop_px) }) : null;
    const err = h('div', { class: 'err', role: 'alert' });
    const area = h('div');
    const back = h('button', { type: 'button', class: 'btn btn-ghost', on: { click: done } }, 'Back');
    const form = h('form', { class: 'stack modify-form', novalidate: true },
      h('strong', null, `Modify ${String(o.side ?? '').toUpperCase()} ${o.sym ?? ''} ${String(o.type ?? '').replace('_', '-')} order`),
      h('div', { class: 'form-grid two' },
        field('Total quantity (shares)', qtyIn, { hint: `Already filled: ${fmtInt(o.filled_qty ?? 0)}.` }),
        limitIn ? field('Limit price (USD)', limitIn) : null,
        stopIn ? field('Stop trigger (USD)', stopIn) : null),
      h('p', { class: 'small muted' }, o.side === 'buy'
        ? 'Buy orders can only be reduced here (smaller quantity or lower limit; a buy stop trigger cannot move). To add exposure, cancel and place a new order so every entry rule applies.'
        : 'Sell-side changes pass the same policy gate. Prices: whole cents at or above one dollar, up to 4 decimals below (Reg NMS Rule 612).'),
      err, h('div', { class: 'btn-row' }, h('button', { type: 'submit', class: 'btn btn-primary' }, 'Review changes…'), back), area);
    const priceOf = (input, label, errs) => {
      if (!input) return null;
      const u = usdToU(input.value.trim());
      if (u === null || u <= 0) { errs.push(`${label} must be a positive price.`); return null; }
      if (!isValidTick(u)) { errs.push(`${label}: invalid tick (whole cents at or above one dollar; at most 4 decimals below).`); return null; }
      return u;
    };
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const errs = [];
      const qty = Number(qtyIn.value);
      if (!Number.isInteger(qty) || qty < 1) errs.push('Quantity must be a whole number of shares ≥ 1.');
      const limitU = priceOf(limitIn, 'Limit price', errs);
      const stopU = priceOf(stopIn, 'Stop trigger', errs);
      err.textContent = errs.join(' ');
      if (errs.length) return;
      const body = replaceBody(o, { qty, limitU, stopU });
      if (!body) { err.textContent = 'No changes.'; return; }
      const lines = [
        body.qty !== undefined ? `Quantity ${fmtInt(o.qty)} → ${fmtInt(body.qty)}` : null,
        body.limit_px_u !== undefined ? `Limit ${fmtPriceU(num(o.limit_px))} → ${fmtPriceU(body.limit_px_u)}` : null,
        body.stop_px_u !== undefined ? `Stop trigger ${fmtPriceU(num(o.stop_px))} → ${fmtPriceU(body.stop_px_u)}` : null,
      ].filter(Boolean);
      replace(area, confirmBox({
        title: `Replace this ${String(o.side ?? '').toUpperCase()} ${o.sym ?? ''} order?`,
        body: h('div', { class: 'stack' }, h('ul', { class: 'small' }, lines.map((t) => h('li', null, t))),
          h('p', { class: 'small muted' }, 'The policy gate evaluates the change as a modify; the result and the journal entry (ORDER_REPLACED) appear above.')),
        confirmLabel: 'Replace order',
        onConfirm: async () => {
          const res = await api.post(`/api/orders/${encodeURIComponent(o.id)}/replace`, body);
          if (!alive) return;
          done();
          showOps(h('h3', { class: 'section-title' }, 'Modify request'), decisionResult(res));
          announce(res.ok ? 'Order replaced.' : `Replace not accepted: ${res.error?.message ?? ''}`);
          loadDetail(false); loadList();
        },
        onCancel: () => replace(area),
      }));
    });
    return form;
  }

  function fillsTable(rows) {
    return rtable([
      { label: 'Fill', head: true, render: (f) => h('span', null, h('span', { class: 'sym' }, `${String(f.side ?? '').toUpperCase()} ${f.sym ?? DASH}`), ' ', badge('ESTIMATED PAPER FILL', { tone: 'copper' })) },
      { label: 'Qty', num: true, render: (f) => fmtInt(f.qty) },
      { label: 'Est. price', num: true, render: (f) => fmtPriceU(num(f.price ?? f.priceU)) },
      { label: 'Est. fees', num: true, render: (f) => fmtUsdU(num(f.fees ?? f.feesU)) },
      { label: 'Minute', render: (f) => fmtEt(num(f.ts)) },
      { label: 'Fill model', render: (f) => h('span', { class: 'mono' }, String(f.model ?? DASH)) },
      { label: 'Assumptions', full: true, render: fillDetails },
    ], rows, { caption: 'Estimated paper fills', empty: 'No estimated fills in this session.' });
  }

  // ---------------------------------------------------------------- sandbox order ticket
  function ticket() {
    let side = 'buy';
    let sizeMode = 'shares';
    let reviewCtx = null;   // {clock, session} the shown review was built at
    let reviewTok = 0;      // bumps on every review start / invalidation, so a late review result is discarded
    let submitting = false;
    const errs = {};
    const symIn = h('input', { type: 'text', value: preSym, autocomplete: 'off', spellcheck: 'false', autocapitalize: 'characters', maxlength: '10', required: true, enterkeyhint: 'next' });
    const qtyIn = h('input', { type: 'number', min: '1', step: '1', inputmode: 'numeric' });
    const budgetIn = h('input', { type: 'number', min: '0', step: '0.01', inputmode: 'decimal' });
    const typeSel = select([['market', 'Market'], ['limit', 'Limit'], ['stop', 'Stop'], ['stop_limit', 'Stop-limit']], 'market');
    const limitIn = h('input', { type: 'number', min: '0', step: 'any', inputmode: 'decimal' });
    const stopIn = h('input', { type: 'number', min: '0', step: 'any', inputmode: 'decimal' });
    const slIn = h('input', { type: 'number', min: '0', step: 'any', inputmode: 'decimal' });
    const tpIn = h('input', { type: 'number', min: '0', step: 'any', inputmode: 'decimal' });
    const rationaleIn = h('textarea', { maxlength: '2000' });
    const errBox = h('div', { class: 'err', role: 'alert', tabindex: '-1' });
    const reviewArea = h('div');
    const resultArea = h('div', { role: 'status', 'aria-live': 'polite', class: 'ticket-result' });

    const clearReview = () => { reviewTok++; reviewCtx = null; replace(reviewArea); };
    const segBtn = (val, text, onPick) => h('button', { type: 'button', 'aria-pressed': 'false', dataset: { v: val }, on: { click: () => onPick(val) } }, text);
    const sideSeg = h('div', { class: 'seg full', role: 'group', 'aria-label': 'Side' });
    const sizeSeg = h('div', { class: 'seg full', role: 'group', 'aria-label': 'Size by' });
    sideSeg.append(segBtn('buy', 'Buy', (v) => { side = v; sync(); }), segBtn('sell', 'Sell', (v) => { side = v; sync(); }));
    sizeSeg.append(segBtn('shares', 'Shares', (v) => { sizeMode = v; sync(); }), segBtn('budget', 'USD budget', (v) => { sizeMode = v; sync(); }));
    const qtyField = field('Quantity (whole shares)', qtyIn);
    const budgetField = field('Budget (USD)', budgetIn, { hint: 'Buys the largest whole-share quantity at the estimated price.' });
    const limitField = field('Limit price (USD)', limitIn, { hint: 'At or above one dollar: whole cents. Below one dollar: up to 4 decimals (Reg NMS Rule 612).' });
    const stopField = field('Stop price (USD)', stopIn);
    const attachSet = h('fieldset', null, h('legend', null, 'Attach exits (optional, buy entries only)'),
      h('div', { class: 'form-grid two' }, field('Stop-loss price (USD)', slIn), field('Take-profit price (USD)', tpIn)),
      h('p', { class: 'small muted' }, 'Attached exits become working once the entry fills (OCO). Stop fills are modelled at the worst observed price — a gap fills worse than the stop.'));

    function sync() {
      if (side === 'sell') sizeMode = 'shares';
      for (const b of sideSeg.children) b.setAttribute('aria-pressed', String(b.dataset.v === side));
      for (const b of sizeSeg.children) {
        b.setAttribute('aria-pressed', String(b.dataset.v === sizeMode));
        b.disabled = side === 'sell' && b.dataset.v === 'budget';
      }
      qtyField.hidden = sizeMode !== 'shares';
      budgetField.hidden = sizeMode !== 'budget';
      const t = typeSel.value;
      limitField.hidden = !(t === 'limit' || t === 'stop_limit');
      stopField.hidden = !(t === 'stop' || t === 'stop_limit');
      attachSet.hidden = side !== 'buy';
      if (!submitting) clearReview();
    }
    typeSel.addEventListener('change', sync);
    for (const el of [symIn, qtyIn, budgetIn, limitIn, stopIn, slIn, tpIn]) el.addEventListener('input', () => { el.removeAttribute('aria-invalid'); if (!submitting) clearReview(); });

    function priceU(input, label, required) {
      const raw = input.value.trim();
      if (!raw) { if (required) errs[label] = `${label} is required.`; return null; }
      const u = usdToU(raw);
      if (u === null || u <= 0) { errs[label] = `${label} must be a positive price.`; input.setAttribute('aria-invalid', 'true'); return null; }
      if (!isValidTick(u)) { errs[label] = `${label}: invalid tick (at or above one dollar use whole cents; below one dollar at most 4 decimals).`; input.setAttribute('aria-invalid', 'true'); return null; }
      return u;
    }

    function validate() {
      for (const k of Object.keys(errs)) delete errs[k];
      const sym = normalizeSym(symIn.value);
      if (!sym) { errs.Symbol = 'Enter a valid ticker symbol.'; symIn.setAttribute('aria-invalid', 'true'); }
      const t = typeSel.value;
      let qty = null;
      let budgetUsd = null;
      if (sizeMode === 'shares') {
        qty = Number(qtyIn.value);
        if (!Number.isInteger(qty) || qty < 1) { errs.Quantity = 'Quantity must be a whole number of shares ≥ 1.'; qtyIn.setAttribute('aria-invalid', 'true'); qty = null; }
      } else {
        budgetUsd = Number(budgetIn.value);
        if (!isNum(budgetUsd) || budgetUsd <= 0) { errs.Budget = 'Budget must be a positive USD amount.'; budgetIn.setAttribute('aria-invalid', 'true'); budgetUsd = null; }
      }
      const limitU = (t === 'limit' || t === 'stop_limit') ? priceU(limitIn, 'Limit price', true) : null;
      const stopU = (t === 'stop' || t === 'stop_limit') ? priceU(stopIn, 'Stop price', true) : null;
      const slU = side === 'buy' ? priceU(slIn, 'Stop-loss', false) : null;
      const tpU = side === 'buy' ? priceU(tpIn, 'Take-profit', false) : null;
      if (isNum(slU) && isNum(tpU) && slU >= tpU) errs.Exits = 'Stop-loss must be below take-profit.';
      const rationale = rationaleIn.value.trim();
      const ok = Object.keys(errs).length === 0;
      errBox.textContent = ok ? '' : Object.values(errs).join(' ');
      if (!ok) return { ok };
      const spec = {
        source: 'human', portfolio_id: 'sandbox', action: side === 'buy' ? 'open' : 'close',
        instrument: { kind: 'equity', sym }, side, order_type: t,
        rationale: rationale || 'Human sandbox paper order', evidence_refs: [],
      };
      if (qty !== null) spec.qty = qty; else spec.budget_usd = budgetUsd;
      if (limitU !== null) spec.limit_px_u = limitU;
      if (stopU !== null) spec.stop_px_u = stopU;
      if (slU !== null || tpU !== null) spec.attach = { ...(slU !== null ? { stop_loss_px_u: slU } : {}), ...(tpU !== null ? { take_profit_px_u: tpU } : {}) };
      return { ok, spec, sym, t, qty, budgetU: budgetUsd !== null ? usdToU(budgetUsd) : null, limitU, stopU };
    }

    /** The clock moved: the shown review is out of date (never confirmable). */
    function markStale() {
      reviewTok++;
      reviewCtx = null;
      const again = h('button', { type: 'button', class: 'btn btn-primary' }, 'Review again');
      again.addEventListener('click', review);
      replace(reviewArea, h('div', { class: 'review' },
        statusBlock(['REVIEW OUT OF DATE'], 'The replay clock moved since this review, so its quote and estimate are out of date.',
          `Nothing was submitted. Review again to see the current as-of quote.${store.status?.replay?.playing ? ' The replay is playing, so the clock moves every few seconds: pause it (Replay) to review and confirm against a fixed quote.' : ''}`, { tone: 'warn' }),
        h('div', { class: 'btn-row' }, again)));
      announce('The replay clock moved; review the order again.');
    }

    async function review() {
      replace(resultArea);
      const v = validate();
      if (!v.ok) { errBox.focus?.(); announce(errBox.textContent); return; }
      const tok = ++reviewTok;
      const ctx = { clock: store.status?.replay?.clock ?? null, session: store.status?.replay?.session_id ?? null };
      replace(reviewArea, loading('as-of quote and sandbox cash'));
      const [bars, sb, large] = await Promise.all([
        api.get(`/api/market/bars${api.qs({ sym: v.sym })}`),
        api.get('/api/portfolios/sandbox'),
        api.get(`/api/market/universe${api.qs({ segment: 'large' })}`),
      ]);
      if (!alive || tok !== reviewTok) return;
      if (reviewIsStale(ctx, store.status?.replay)) { markStale(); return; }
      reviewCtx = ctx;
      const quote = bars.ok ? obj(bars.data?.quote) : null;
      const sbx = sb.ok ? normPortfolio(sb.data) : sandboxSummary;
      const held = sbx ? (sbx.positions.find((p) => p.sym === v.sym && p.kind !== 'option')?.qty ?? 0) : null;
      const segment = large.ok && rowsOf(large.data).some((r) => r?.sym === v.sym) ? 'large' : 'micro';
      const est = estimateOrder({ side, orderType: v.t, qty: v.qty ?? undefined, budgetU: v.budgetU ?? undefined, limitU: v.limitU ?? undefined, stopU: v.stopU ?? undefined, quote, segment, cashU: sbx?.cashU ?? null, heldQty: held });
      const SIDE = side === 'buy' ? 'BUY' : 'SELL';
      const orderLine = `${SIDE} ${v.qty !== null ? `${fmtInt(v.qty)} sh` : `${fmtUsdU(v.budgetU)} budget`} ${v.sym} · ${v.t.replace('_', '-').toUpperCase()}`
        + `${isNum(v.limitU) ? ` limit ${fmtPriceU(v.limitU)}` : ''}${isNum(v.stopU) ? ` stop ${fmtPriceU(v.stopU)}` : ''}`;
      const totalLabel = side === 'buy' ? 'Estimated total cost' : 'Estimated net proceeds';
      const confirmText = `Confirm ${SIDE} ${est.ok ? fmtInt(est.qty) : (v.qty !== null ? fmtInt(v.qty) : '')} ${v.sym}${est.ok ? ` ≈ ${fmtUsdU(est.totalU)}` : ''}`.replace(/\s+/g, ' ');
      const submitBtn = h('button', { type: 'button', class: ['btn', side === 'buy' ? 'btn-primary' : 'btn-sell'] }, confirmText);
      const editBtn = h('button', { type: 'button', class: 'btn btn-ghost', on: { click: () => { clearReview(); symIn.focus(); } } }, 'Edit');
      submitBtn.addEventListener('click', async () => {
        if (reviewIsStale(reviewCtx, store.status?.replay)) { markStale(); return; }
        submitting = true;
        submitBtn.disabled = true; editBtn.disabled = true;
        replace(resultArea, loading('policy gate decision'));
        const res = await api.post('/api/orders', { ...v.spec, confirm: true });
        submitting = false;
        if (!alive) return;
        const accepted = res.ok && (res.data?.decision ?? 'ACCEPTED') === 'ACCEPTED';
        const gateDecided = res.ok || typeof res.data?.decision === 'string';
        const heading = h('h3', { class: 'section-title', tabindex: '-1' }, gateDecided ? `Policy gate decision · ${orderLine}` : 'Not submitted — no gate decision');
        // Render the decision first, then collapse the review into a one-line summary, then move focus and the viewport
        // to the decision (on a phone the collapse would otherwise leave the result above the fold).
        replace(resultArea, heading, decisionResult(res),
          accepted ? h('p', { class: 'small note' }, 'Accepted orders are evaluated after the next completed replay minute. Any fill is an ESTIMATED PAPER FILL using the worst observed price in that minute; if no credible fill can be modelled it is withheld (UNFILLABLE).') : null);
        reviewTok++; reviewCtx = null;
        replace(reviewArea, h('p', { class: 'small muted' }, `Submitted: ${orderLine}.`));
        heading.focus({ preventScroll: true });
        reveal(resultArea);
        announce(res.ok ? `Order ${res.data?.decision ?? 'submitted'}.` : `Order not accepted: ${res.error?.message ?? ''}`);
        await Promise.all([selected === 'sandbox' ? loadDetail(false) : null, loadList()]);
        if (alive) resultArea.scrollIntoView?.({ block: 'nearest' });
      });
      const q = quote || {};
      const qTs = num(q.quoteTs);
      const ageAtReview = isNum(qTs) && isNum(num(ctx.clock)) ? num(ctx.clock) - qTs : num(q.ageMs);
      const reviewHeading = h('h3', { tabindex: '-1' }, 'Review paper order');
      replace(reviewArea, h('div', { class: 'review', role: 'group', 'aria-label': 'Review paper order' },
        reviewHeading,
        h('div', { class: 'badges' }, badge('PAPER ONLY', { tone: 'copper' }), badge(est.ok ? 'UI ESTIMATE' : est.status)),
        kv({
          Portfolio: 'Sandbox (human)',
          Order: orderLine,
          'IEX quote (as-of)': quote ? `bid ${fmtPriceU(num(q.bid))} × ${fmtInt(q.bidSize)} / ask ${fmtPriceU(num(q.ask))} × ${fmtInt(q.askSize)}` : 'NO_VERIFIED_DATA',
          'Quote time · age at review': quote ? `${fmtEt(qTs, { seconds: true })} · ${fmtAge(ageAtReview)} before the replay clock (${isNum(num(ctx.clock)) ? fmtEt(num(ctx.clock), { seconds: true }) : DASH})` : DASH,
          Spread: quote ? fmtBps(q.spreadBps) : DASH,
          'Estimated price': est.ok ? fmtPriceU(est.priceU) : DASH,
          Quantity: est.ok ? `${fmtInt(est.qty)} share${est.qty === 1 ? '' : 's'}` : DASH,
          Notional: est.ok ? fmtUsdU(est.notionalU) : DASH,
          'Estimated fees': est.ok ? `${fmtUsdU(est.fees.total)} (SEC ${fmtUsdU(est.fees.sec)}, TAF ${fmtUsdU(est.fees.taf)}, commission ${fmtUsdU(est.fees.commission)})` : DASH,
          [totalLabel]: est.ok ? fmtUsdU(est.totalU) : DASH,
          'Sandbox cash': sbx ? fmtUsdU(sbx.cashU) : 'unknown (portfolio not loaded)',
          'Shares held': held === null ? 'unknown' : fmtInt(held),
          'Cost model': `${est.segment} defaults · slippage ${COST_MODEL_DEFAULTS[est.segment].slippageBps} bps`,
          Basis: est.basis,
        }),
        est.warnings.length ? h('ul', { class: 'reasons' }, est.warnings.map((w) => h('li', null, badge('CHECK', { tone: 'warn' }), h('span', null, w)))) : null,
        h('p', { class: 'small muted' }, 'This is a client-side estimate from the as-of IEX quote and the documented default cost model (fee rates are assumptions). The deterministic policy gate decides; the fill engine uses the worst price within the next completed minute, which can be worse. If the replay clock moves before you confirm, this review expires.'),
        // The order and its estimated total sit right above the buttons, so the confirm step never hides what is confirmed.
        h('p', { class: 'confirm-line' }, `${orderLine} · ${totalLabel.toLowerCase()} ${est.ok ? fmtUsdU(est.totalU) : 'not estimated'}`),
        h('div', { class: 'btn-row stretch' }, submitBtn, editBtn)));
      reviewHeading.focus({ preventScroll: true });
      reveal(reviewArea);
    }

    const form = h('form', { class: 'ticket', novalidate: true, on: { submit: (e) => { e.preventDefault(); review(); } } },
      h('p', { class: 'small note' }, 'Human orders go to the Sandbox portfolio only and pass the same deterministic policy gate as agents (with human confirmation). No shorting; whole shares only.'),
      field('Symbol', symIn),
      h('div', { class: 'field' }, h('span', { class: 'lbl' }, 'Side'), sideSeg),
      h('div', { class: 'field' }, h('span', { class: 'lbl' }, 'Size by'), sizeSeg),
      qtyField, budgetField,
      field('Order type', typeSel),
      limitField, stopField, attachSet,
      field('Rationale (optional, journaled)', rationaleIn),
      errBox,
      h('div', { class: 'btn-row stretch' }, h('button', { type: 'submit', class: 'btn btn-primary' }, 'Review order…')),
      reviewArea, resultArea);
    sync();
    return {
      el: form,
      onClock() {
        if (submitting) return;
        if (reviewCtx && reviewIsStale(reviewCtx, store.status?.replay)) markStale();
        else if (!reviewCtx && reviewArea.querySelector('.loading')) markStale();
      },
    };
  }

  // ---------------------------------------------------------------- long puts
  const loadOptions = () => load('options', '/api/options/status', optionsBody, 'Options status', (d) => {
    const status = typeof d?.status === 'string' ? d.status : 'NO_VERIFIED_OPTIONS_DATA';
    const verified = status === 'SUPPORTED_VERIFIED';
    const inputs = {
      underlying: h('input', { type: 'text', autocapitalize: 'characters', maxlength: '10' }),
      occ: h('input', { type: 'text', autocapitalize: 'characters', maxlength: '21' }),
      expiry: h('input', { type: 'date' }),
      strike: h('input', { type: 'number', min: '0', step: 'any', inputmode: 'decimal' }),
      contracts: h('input', { type: 'number', min: '1', step: '1', inputmode: 'numeric' }),
      premium: h('input', { type: 'number', min: '0', step: 'any', inputmode: 'decimal' }),
    };
    const out = h('div', { role: 'status', 'aria-live': 'polite', tabindex: '-1', class: 'ticket-result' });
    const submit = h('button', { type: 'submit', class: 'btn btn-primary', disabled: !verified }, 'Review long put…');
    const fs = h('fieldset', { disabled: !verified },
      h('legend', null, 'Long put ticket (buy to open)'),
      h('div', { class: 'form-grid two' },
        field('Underlying', inputs.underlying), field('OCC contract symbol', inputs.occ),
        field('Expiry', inputs.expiry), field('Strike (USD)', inputs.strike),
        field('Contracts (×100 shares)', inputs.contracts), field('Limit premium (USD/share)', inputs.premium)));
    const form = h('form', { class: 'stack', novalidate: true, on: { submit: (e) => {
      e.preventDefault();
      if (!verified) return;
      const contracts = Number(inputs.contracts.value);
      const body = {
        portfolio_id: 'sandbox',
        contract: { occ: inputs.occ.value.trim().toUpperCase(), underlying: normalizeSym(inputs.underlying.value), expiry: inputs.expiry.value, strike_u: usdToU(inputs.strike.value), right: 'P', multiplier: 100 },
        contracts, order_type: 'limit', limit_px_u: usdToU(inputs.premium.value), confirm: true,
      };
      const maxLoss = isNum(body.limit_px_u) && Number.isInteger(contracts) ? body.limit_px_u * 100 * contracts : null;
      replace(out, confirmBox({
        title: 'Submit long put paper order?',
        body: h('p', null, `Maximum loss is the premium paid${isNum(maxLoss) ? ` (${fmtUsdU(maxLoss)} plus fees)` : ''}. Expiration is modelled as cash value max(0, K − S) × 100; exercise/assignment are not modelled.`),
        confirmLabel: 'Submit long put',
        onConfirm: async () => {
          const res = await api.post('/api/options/orders', body);
          if (!alive) return;
          replace(out, h('h3', { class: 'section-title' }, 'Policy gate decision'), decisionResult(res));
          out.focus({ preventScroll: true });
          reveal(out, 'nearest');
        },
        onCancel: () => replace(out),
      }));
    } } }, fs, h('div', { class: 'btn-row' }, submit), out);
    replace(optionsBody,
      h('div', { class: 'badges' }, badge(status)),
      typeof d?.detail === 'string' ? h('p', { class: 'note' }, d.detail) : null,
      verified ? null : statusBlock('NO_VERIFIED_OPTIONS_DATA', 'Operational options orders are disabled and would be rejected (409 NO_VERIFIED_OPTIONS_DATA).', null),
      h('h3', { class: 'section-title' }, 'Data required to enable long puts'),
      h('ul', { class: 'small note' },
        h('li', null, 'An entitled options data provider returning real listed contracts: OCC symbol, underlying, expiry, strike, right (P) and the 100-share multiplier, as of the replay clock.'),
        h('li', null, 'Time-stamped contract quotes (bid/ask with sizes) for the premium and a conservative fill estimate.'),
        h('li', null, 'The underlying’s observed price for mark-to-market and expiration payoff.')),
      h('p', { class: 'small muted' }, 'Long puts only: risk is capped at the premium paid plus fees. No naked short options, no margin, no real options orders.'),
      form);
  });

  drawSwitch();
  loadList();
  loadDetail(false);
  loadOptions();

  return {
    // Opened from a dossier with ?sym=: hand focus to the prefilled ticket instead of the page title.
    focusTarget: preSym ? ticketHeading : null,
    onStatus(_s, info) {
      if (info.clockChanged || info.sessionChanged) {
        tk.onClock();
        loadList();
        if (!detailBusy()) loadDetail(false);
      }
    },
    destroy() { alive = false; },
  };
}
