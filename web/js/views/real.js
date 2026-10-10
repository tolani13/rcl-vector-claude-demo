// #/real — the owner's own brokerage accounts through SnapTrade, READ ONLY (docs/CONTRACTS.md section 4b).
// Every screen here carries "REAL ACCOUNT — READ ONLY". There are no order, trade or cancel controls: the server has
// no such route under /api/real/ and the SnapTrade client can only read. Real holdings never feed the paper lab.
// The API answers only on the loopback server; on any other host (e.g. a static preview) nothing is requested.
import { h, replace, announce } from '../dom.js';
import * as api from '../api.js';
import { card, pageHeader, statusBlock, loading, badge, rtable, confirmBox, decisionResult, errorBlock } from '../components.js';
import { arr, obj, isNum, fmtNum, fmtInt, DASH } from '../format.js';

export const REAL_LABEL = 'REAL ACCOUNT — READ ONLY';
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

const banner = () => h('div', { class: 'label-banner real' }, REAL_LABEL);
const money = (v, cur) => (isNum(v) ? `${fmtNum(v, 2)}${cur ? ` ${cur}` : ''}` : DASH);
const qty = (v) => (isNum(v) ? (Number.isInteger(v) ? fmtInt(v) : fmtNum(v, 4)) : DASH);
const fmtWall = (ms) => (isNum(ms) ? new Date(ms).toLocaleString() : DASH);

function setupSteps(st) {
  const present = obj(st?.variablesPresent) || {};
  const row = (k, note) => h('li', null, h('code', null, k), ' ', present[k] ? badge('SET', { tone: 'ok' }) : badge('NOT SET', { tone: 'warn' }), note ? h('span', { class: 'small muted' }, ` ${note}`) : null);
  return h('div', { class: 'stack' },
    h('div', { class: 'divider' }),
    h('p', { class: 'small' }, 'You enter the keys, in the server environment only (the .env file, which git ignores), never in this page or a chat:'),
    h('ol', { class: 'small' },
      h('li', null, 'Create a free SnapTrade Personal account in the SnapTrade dashboard, verify your email, turn on two-factor authentication, and create your Personal client ID and consumer key.'),
      h('li', null, 'Add them to .env, then restart VECTOR:',
        h('ul', null,
          row('VECTOR_SNAPTRADE_CLIENT_ID'),
          row('VECTOR_SNAPTRADE_CONSUMER_KEY'),
          row('VECTOR_SNAPTRADE_USER_SECRET', '(only if SnapTrade issued you a user id and secret; Personal keys need neither)'))),
      h('li', null, 'Come back here, choose Connect, and log in to your brokerage at SnapTrade (data access only). Then Sync.')));
}

export function render(root) {
  root.append(pageHeader('Real accounts', { sub: 'Your own brokerage accounts through SnapTrade. Read only — VECTOR never places orders on them, and they never feed the paper lab.' }));
  if (!LOOPBACK.has(location.hostname)) {
    root.append(banner(), statusBlock(['REAL_DATA_LOOPBACK_ONLY'], 'Real-account data is served only by the local VECTOR server on this machine.',
      'This page is not available on this host (for example a static preview). Nothing was requested.', { tone: 'warn' }));
    return {};
  }
  const statusBody = h('div', null, loading('real-account status'));
  const actionOut = h('div', { 'aria-live': 'polite' });
  const accountsBody = h('div', null, loading('accounts'));
  const txBody = h('div', null, loading('transactions'));
  const connectBtn = h('button', { type: 'button', class: 'btn', disabled: true }, 'Connect a brokerage…');
  const syncBtn = h('button', { type: 'button', class: 'btn', disabled: true }, 'Sync now…');
  let alive = true;

  const loadAll = async () => {
    const [s, a, t] = await Promise.all([api.get('/api/real/status'), api.get('/api/real/accounts'), api.get('/api/real/transactions?limit=100')]);
    if (!alive) return;
    drawStatus(s);
    drawAccounts(a);
    drawTransactions(t);
  };

  function drawStatus(res) {
    if (!res.ok) { replace(statusBody, errorBlock(res, 'Real-account status')); connectBtn.disabled = true; syncBtn.disabled = true; return; }
    const st = obj(res.data) || {};
    const blocked = st.status === 'BLOCKED';
    connectBtn.disabled = blocked;
    syncBtn.disabled = blocked;
    const last = obj(st.lastSync);
    const ok = obj(st.lastSuccessfulSync);
    replace(statusBody,
      blocked
        ? statusBlock(['BLOCKED', st.code || 'SNAPTRADE_NOT_CONFIGURED'], 'SnapTrade is not configured, so nothing is shown. No data is faked.', st.detail)
        : h('div', { class: 'badges' }, badge('READY', { tone: 'ok' }), badge('READ ONLY', { tone: 'copper' }), badge(st.mode === 'personal' ? 'PERSONAL KEY' : 'PERSONAL KEY + USER')),
      h('dl', { class: 'kv' },
        h('dt', null, 'Last successful sync'), h('dd', null, ok ? `${fmtWall(ok.fetched_at)} · ${fmtInt(ok.counts?.accounts ?? 0)} accounts` : 'never'),
        h('dt', null, 'Last attempt'), h('dd', null, last ? `${fmtWall(last.started_wall)} · ${last.status}${last.error_code ? ` (${last.error_code})` : ''}` : 'none'),
        h('dt', null, 'Source'), h('dd', null, 'SnapTrade cached data (refreshed by SnapTrade about once a day; no paid refresh is used)')),
      blocked ? setupSteps(st) : null);
  }

  function drawAccounts(res) {
    if (!res.ok) { replace(accountsBody, errorBlock(res, 'Real accounts')); return; }
    const d = obj(res.data) || {};
    const snap = obj(d.snapshot);
    if (!snap) {
      replace(accountsBody, statusBlock([d.status || 'NOT_SYNCED'], d.status === 'BLOCKED' ? 'Configure SnapTrade first (see above).' : 'No successful sync yet. Connect a brokerage, then Sync.'));
      return;
    }
    const accounts = arr(snap.accounts);
    replace(accountsBody,
      h('p', { class: 'small muted' }, `Fetched ${fmtWall(snap.fetched_at)} · source ${snap.source} · data class ${snap.data_class}. Not market data.`),
      accounts.length ? accounts.map((a) => h('div', { class: 'real-account' },
        h('h3', { class: 'section-title' }, `${a.name || 'Account'} · ${a.institution || 'institution unknown'} · ${a.number_masked || DASH}`),
        h('div', { class: 'badges' }, badge(a.status ? String(a.status).toUpperCase() : 'STATUS UNKNOWN', { tone: 'neutral' }), a.raw_type ? badge(String(a.raw_type).toUpperCase(), { tone: 'neutral' }) : null),
        h('p', { class: 'small' }, `Total value: ${money(a.total_value, a.currency)}`),
        rtable([
          { label: 'Currency', head: true, render: (b) => b.currency || DASH },
          { label: 'Cash', num: true, render: (b) => money(b.cash) },
          { label: 'Buying power', num: true, render: (b) => money(b.buying_power) },
        ], arr(a.balances), { caption: 'Balances', empty: 'No balances returned.' }),
        rtable([
          { label: 'Symbol', head: true, render: (p) => h('span', null, h('span', { class: 'sym' }, p.symbol || DASH), h('span', { class: 'sub' }, p.description || p.kind || '')) },
          { label: 'Units', num: true, render: (p) => qty(p.units) },
          { label: 'Price', num: true, render: (p) => money(p.price) },
          { label: 'Market value', num: true, render: (p) => money(p.market_value) },
          { label: 'Cost basis', num: true, render: (p) => money(p.cost_basis) },
          { label: 'Currency', render: (p) => p.currency || DASH },
        ], arr(a.positions), { caption: 'Positions', empty: 'No positions returned.' })))
        : statusBlock('NONE RETURNED', 'SnapTrade returned no accounts.'));
  }

  function drawTransactions(res) {
    if (!res.ok) { replace(txBody, errorBlock(res, 'Real-account transactions')); return; }
    const d = obj(res.data) || {};
    if (d.status !== 'SYNCED') { replace(txBody, statusBlock(['NOT_SYNCED'], 'No transactions until the first successful sync.')); return; }
    replace(txBody, rtable([
      { label: 'Date', head: true, render: (t) => (t.trade_date ? String(t.trade_date).slice(0, 10) : DASH) },
      { label: 'Type', render: (t) => t.type || DASH },
      { label: 'Symbol', render: (t) => t.symbol || DASH },
      { label: 'Units', num: true, render: (t) => qty(t.units) },
      { label: 'Price', num: true, render: (t) => money(t.price) },
      { label: 'Amount', num: true, render: (t) => money(t.amount, t.currency) },
      { label: 'Description', cls: 'sec', render: (t) => t.description || DASH },
    ], arr(d.rows), { caption: 'Transactions', empty: 'No transactions in the synced window.' }));
  }

  connectBtn.addEventListener('click', async () => {
    connectBtn.disabled = true;
    replace(actionOut, loading('a SnapTrade connection link'));
    const res = await api.post('/api/real/connect', {});
    connectBtn.disabled = false;
    if (!res.ok) { replace(actionOut, decisionResult(res)); return; }
    const link = typeof res.data?.redirectURI === 'string' && res.data.redirectURI.startsWith('https://') ? res.data.redirectURI : null;
    replace(actionOut, link
      ? h('div', { class: 'result accepted' },
        h('div', { class: 'badges' }, badge('LINK READY', { tone: 'ok' }), badge('DATA ACCESS ONLY', { tone: 'copper' })),
        h('p', null, h('a', { class: 'btn btn-primary', href: link, target: '_blank', rel: 'noopener noreferrer' }, 'Open the SnapTrade connection portal')),
        h('p', { class: 'small muted' }, 'Log in to your brokerage there. The link expires in 5 minutes. Come back and Sync when done.'))
      : statusBlock(['PROVIDER_FAULT'], 'SnapTrade did not return a usable link.'));
  });

  syncBtn.addEventListener('click', () => {
    replace(actionOut, confirmBox({
      title: 'Sync your real accounts now?',
      body: h('p', { class: 'small' }, 'Reads accounts, balances, positions and up to a year of transactions from SnapTrade. Read only; nothing is placed or changed at your broker. Stored only in this machine\'s VECTOR database.'),
      confirmLabel: 'Sync',
      onConfirm: async () => {
        replace(actionOut, loading('sync (up to a minute)'));
        const res = await api.post('/api/real/sync', { confirm: true }, { timeoutMs: 90_000 });
        replace(actionOut, decisionResult(res));
        announce(res.ok ? 'Real accounts synced.' : `Sync failed: ${res.error?.message ?? ''}`);
        await loadAll();
      },
      onCancel: () => replace(actionOut),
    }));
  });

  root.append(
    banner(),
    h('div', { class: 'grid' },
      card({ title: 'SnapTrade connection', cls: 'span-12' }, statusBody, h('div', { class: 'btn-row' }, connectBtn, syncBtn), actionOut),
      card({ title: 'Accounts, balances and positions', cls: 'span-12' }, banner(), accountsBody),
      card({ title: 'Transactions (latest sync)', cls: 'span-12' }, banner(), txBody)));
  loadAll();
  return { destroy() { alive = false; } };
}
