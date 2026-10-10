#!/usr/bin/env node
// END-TO-END DRIVER (manual; not a unit test and not run by `npm test`). It contains no market data: every symbol, price
// and quote it uses is read at run time from a RUNNING VECTOR server over HTTP, which replays a REAL stored IEX dataset.
//
// Usage (server already running, e.g. `npm start`):
//   node --disable-warning=ExperimentalWarning test/api/e2e-real-replay.mjs --base http://127.0.0.1:8787 \
//        --ds iex-tops-2026-10-07 --db data/vector.db --chunk 13 [--out receipts/e2e-real-replay-2026-10-07.json] [--samples receipts/journal-samples]
//        [--db-copy-of data/vector.db]   (the server's --db is a disposable VACUUM INTO copy of that database; recorded in the receipt)
//
// Scenario: reset the replay (default seed money), give agent-cowboy-micro the documented `handwritten-notes-example`
// preset (all other agents keep their lens presets; all six run in `rules` mode), start all six agents, step the regular
// session in chunks, place sandbox orders through the API (an unconfirmed attempt, an over-budget order, a stale-quote
// order, a limit order that is then cancelled, a market BUY with an attached 2% stop/take-profit bracket whose stop is then
// raised one tick via /replace), engage the kill switch mid-session (KEEP_PROTECTIVE) while that bracket is working,
// attempt a start and an order while engaged, release it, restart the agents, sell the sandbox position (if the bracket
// has not closed it), run to the close, then collect portfolios, journal statistics and samples.
// Journal statistics/samples are read from the database READ-ONLY after the HTTP run (the API has no aggregate endpoint).
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const args = process.argv.slice(2);
const opt = (k, d = null) => { const i = args.indexOf(`--${k}`); return i >= 0 ? (args[i + 1] ?? d) : d; };
const BASE = opt('base', 'http://127.0.0.1:8787');
const DS = opt('ds', 'iex-tops-2026-10-07');
const DB = opt('db', 'data/vector.db');
const CHUNK = Number(opt('chunk', '13'));
const OUT = opt('out', null);
const SAMPLES = opt('samples', null);
const DB_COPY_OF = opt('db-copy-of', null);
const LABEL = 'REAL IEX HISTORICAL DATA — PAPER FILLS ARE ESTIMATES (not exchange executions); seed money is simulated';

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const HEADERS = { 'content-type': 'application/json', 'x-vector-client': 'web', accept: 'application/json' };
async function call(method, p, body) {
  const t0 = performance.now();
  const res = await fetch(BASE + p, { method, headers: method === 'GET' ? { accept: 'application/json' } : HEADERS, body: method === 'GET' ? undefined : JSON.stringify(body ?? {}) });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* keep text */ }
  return { status: res.status, json, ms: Math.round(performance.now() - t0) };
}
const get = (p) => call('GET', p);
const post = (p, b) => call('POST', p, b);
const put = (p, b) => call('PUT', p, b);
const etTime = (ms) => (ms == null ? null : new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour12: false, hour: '2-digit', minute: '2-digit' }).format(new Date(ms)));

const run = { label: LABEL, base: BASE, ds: DS, startedAt: new Date().toISOString(), steps: [], actions: [], latency: [], errors: [] };
const action = (name, req, res, extra = {}) => {
  const a = { name, at: run.clock ?? null, atEt: etTime(run.clock), status: res.status, ms: res.ms, request: req ?? null,
    response: res.json && typeof res.json === 'object' ? summarize(res.json) : res.json, ...extra };
  run.actions.push(a);
  log(name, res.status, res.json?.error?.code ?? res.json?.decision ?? '');
  return res;
};
function summarize(j) {
  const { checks, state, ...rest } = j;
  const out = { ...rest };
  if (checks) out.failedChecks = checks.filter((c) => c.pass === false).map((c) => ({ rule: c.rule, code: c.code, detail: c.detail }));
  if (state) out.state = { status: state.status, clock: state.clock, playing: state.playing };
  return out;
}

async function sampleLatency(tag) {
  for (const p of ['/api/status', '/api/research/opportunities?segment=micro', '/api/research/opportunities?segment=large', '/api/portfolios']) {
    const r = await get(p);
    run.latency.push({ tag, path: p, status: r.status, ms: r.ms, rows: Array.isArray(r.json?.rows) ? r.json.rows.length : undefined });
  }
}

async function stepChunk(minutes) {
  const t0 = performance.now();
  const r = await post('/api/replay/step', { minutes });
  const wall = Math.round(performance.now() - t0);
  if (r.status !== 200) { run.errors.push({ stage: 'step', status: r.status, error: r.json?.error }); log('step failed', r.status, r.json?.error); return null; }
  const j = r.json;
  run.clock = j.to;
  run.steps.push({ from: j.from, to: j.to, fromEt: etTime(j.from), toEt: etTime(j.to), minutes: j.minutes, wallMs: wall, perMinuteMs: j.timing.perMinuteMs,
    fills: j.fills, triggered: j.triggered, withheld: j.withheld, expired: j.expired, intents: j.intents, accepted: j.accepted, denied: j.denied,
    faults: j.faults, blocked: j.blocked, closed: j.closed });
  log(`step ${etTime(j.from)}->${etTime(j.to)} ${wall} ms fills=${j.fills} intents=${j.intents} acc=${j.accepted} den=${j.denied} trig=${j.triggered} withheld=${j.withheld}`);
  return j;
}

async function startAll(tag) {
  for (const a of AGENTS) action(`agent-start:${a}:${tag}`, null, await post(`/api/agents/${a}/start`, {}));
}

// Sandbox candidate: fresh two-sided quote with a narrow spread, chosen at run time from the as-of scanner rows.
async function pickLiquid() {
  for (const seg of ['large', 'micro']) {
    const r = await get(`/api/research/opportunities?segment=${seg}`);
    const rows = (r.json?.rows ?? []).filter((x) => x.quote?.twoSided && !x.quote.halted && x.quote.ageMs < 60_000 && x.quote.spreadBps != null && x.quote.spreadBps <= 100 && x.quote.askSize > 0);
    rows.sort((a, b) => b.metrics.volumeW - a.metrics.volumeW);
    if (rows.length) return { sym: rows[0].sym, segment: seg, quote: rows[0].quote };
  }
  return null;
}
async function pickStale() {
  for (const seg of ['micro', 'low']) {
    const r = await get(`/api/research/opportunities?segment=${seg}`);
    const row = (r.json?.rows ?? []).find((x) => x.quote?.twoSided && !x.quote.halted && x.quote.ageMs > 300_000);
    if (row) return { sym: row.sym, segment: seg, quote: row.quote };
  }
  return null;
}

let AGENTS = [];

async function main() {
  const st0 = await get('/api/status');
  if (st0.status !== 200) throw new Error(`server not reachable at ${BASE}: ${st0.status}`);
  run.serverStatusBefore = { data: st0.json.data.mode, model: st0.json.model, kill: st0.json.kill, options: st0.json.options };
  if (st0.json.kill.engaged) action('kill-release-preexisting', {}, await post('/api/kill/release', {}));

  const reset = action('replay-reset', { ds: DS }, await post('/api/replay/reset', { ds: DS }));
  if (reset.status !== 200) throw new Error('reset failed');
  run.session_id = reset.json.session_id;
  run.clock = reset.json.state.clock;
  const ag = (await get('/api/agents')).json;
  AGENTS = ag.rows.map((a) => a.id).sort();
  const hw = ag.presets['handwritten-notes-example'];
  action('strategy:agent-cowboy-micro:handwritten-notes-example', { strategy_id: hw.id }, await put('/api/agents/agent-cowboy-micro/strategy', { strategy: hw }));
  run.strategies = (await get('/api/agents')).json.rows.map((a) => ({ id: a.id, strategy_id: a.strategy.id, decisionMode: a.strategy.decisionMode, label: a.strategy.label }));
  await startAll('session-start');
  await sampleLatency('open');

  let liquid = null;
  let killDone = false;
  let sold = false;
  let amended = false;
  let buyAt = null;
  for (let i = 0; i < 40; i++) {
    const j = await stepChunk(CHUNK);
    if (!j || j.closed || j.state.status === 'SESSION_CLOSED') break;
    const minute = Math.round((j.to - reset.json.state.t_start) / 60_000);
    if (!liquid && minute >= 26) {
      // Sandbox orders on real as-of quotes.
      liquid = await pickLiquid();
      run.sandboxSymbol = liquid;
      if (liquid) {
        const base = { action: 'open', instrument: { kind: 'equity', sym: liquid.sym }, side: 'buy', order_type: 'market', rationale: 'E2E sandbox order (paper only)' };
        action('sandbox-buy-unconfirmed', { ...base, budget_usd: 1000 }, await post('/api/orders', { ...base, budget_usd: 1000 }));
        const overQty = Math.ceil((3000 * 10_000) / liquid.quote.ask);
        action('sandbox-buy-over-budget', { ...base, qty: overQty, confirm: true }, await post('/api/orders', { ...base, qty: overQty, confirm: true }));
        // Half the as-of bid, on a valid Reg NMS 612 tick (whole cents at or above one dollar): it will not fill.
        const half = Math.floor(liquid.quote.bid / 2);
        const farLimit = Math.max(1, half >= 10_000 ? Math.floor(half / 100) * 100 : half);
        const lim = action('sandbox-limit-buy-far-below', { ...base, order_type: 'limit', limit_px_u: farLimit, qty: 1, confirm: true },
          await post('/api/orders', { ...base, order_type: 'limit', limit_px_u: farLimit, qty: 1, confirm: true }));
        if (lim.status === 201) {
          action('sandbox-cancel-unconfirmed', {}, await post(`/api/orders/${lim.json.order.id}/cancel`, {}));
          action('sandbox-cancel', { confirm: true }, await post(`/api/orders/${lim.json.order.id}/cancel`, { confirm: true, reason: 'E2E human cancel' }));
        }
        // Market BUY with an attached OCO bracket 2% either side of the as-of quote (valid ticks), so protective orders
        // exist while the kill switch is engaged later.
        const tickDown = (u) => (u >= 10_000 ? Math.floor(u / 100) * 100 : Math.floor(u));
        const tickUp = (u) => (u >= 10_000 ? Math.ceil(u / 100) * 100 : Math.ceil(u));
        const attach = { stop_loss_px_u: tickDown(liquid.quote.bid * 0.98), take_profit_px_u: tickUp(liquid.quote.ask * 1.02) };
        const b = action('sandbox-market-buy-with-bracket', { ...base, budget_usd: 1000, attach, confirm: true }, await post('/api/orders', { ...base, budget_usd: 1000, attach, confirm: true }));
        if (b.status === 201) buyAt = j.to;
      }
      const stale = await pickStale();
      run.staleSymbol = stale ? { sym: stale.sym, segment: stale.segment, quoteAgeMs: stale.quote.ageMs } : null;
      if (stale) {
        const body = { action: 'open', instrument: { kind: 'equity', sym: stale.sym }, side: 'buy', order_type: 'market', qty: 10, confirm: true, rationale: 'E2E stale-quote check' };
        action('sandbox-buy-stale-quote', body, await post('/api/orders', body));
      }
    }
    if (buyAt && !amended && j.to > buyAt) {
      // Human stop modification on the working protective stop (same order id; journaled ORDER_REPLACED).
      const pf = (await get('/api/portfolios/sandbox')).json;
      const stop = pf.openOrders.find((o) => o.role === 'stop_loss' && o.status === 'working');
      if (stop) {
        const next = stop.stop_px + (stop.stop_px >= 10_000 ? 100 : 1);
        action('sandbox-replace-stop', { stop_px_u: next, confirm: true }, await post(`/api/orders/${stop.id}/replace`, { stop_px_u: next, confirm: true, reason: 'E2E raise stop by one tick' }));
      }
      amended = true;
    }
    if (buyAt && killDone && !sold) {
      const pf = (await get('/api/portfolios/sandbox')).json;
      const pos = pf.positions.find((p) => p.sym === liquid.sym);
      run.sandboxPositionAfterKill = pos ? { qty: pos.qty, markU: pos.markU, workingProtective: pf.openOrders.filter((o) => o.protective).map((o) => ({ id: o.id, role: o.role, status: o.status })) } : null;
      if (pos) {
        const body = { action: 'close', instrument: { kind: 'equity', sym: liquid.sym }, side: 'sell', order_type: 'market', qty: pos.qty, confirm: true, rationale: 'E2E sandbox sell' };
        action('sandbox-market-sell', body, await post('/api/orders', body));
      }
      sold = true;
    }
    if (!killDone && minute >= 143) {
      await sampleLatency('midday');
      const k = action('kill-engage', { protective_policy: 'KEEP_PROTECTIVE' }, await post('/api/kill', { protective_policy: 'KEEP_PROTECTIVE', reason: 'E2E mid-session drill' }));
      run.killEffects = k.json ? { cancelled: k.json.cancelled, keptProtective: k.json.keptProtective, agentsStopped: k.json.agentsStopped } : null;
      action('agent-start-while-killed', null, await post('/api/agents/agent-cowboy-micro/start', {}));
      if (liquid) action('sandbox-buy-while-killed', null, await post('/api/orders', { action: 'open', instrument: { kind: 'equity', sym: liquid.sym }, side: 'buy', order_type: 'market', qty: 1, confirm: true }));
      const kj = await stepChunk(CHUNK); // protective orders keep being evaluated while agents are STOPPED
      if (!kj) break;
      action('kill-release', {}, await post('/api/kill/release', {}));
      run.agentsAfterRelease = (await get('/api/agents')).json.rows.map((a) => ({ id: a.id, state: a.state }));
      await startAll('after-kill-release');
      killDone = true;
    }
  }
  await sampleLatency('close');
  const stEnd = (await get('/api/status')).json;
  run.finalReplay = stEnd.replay;
  run.agentsFinal = stEnd.agents;
  const pf = (await get('/api/portfolios')).json;
  run.portfolios = pf.rows.map((p) => ({
    id: p.portfolio.id, name: p.portfolio.name, startingCashU: p.portfolio.startingCashU, cashU: p.cashU, equityU: p.equityU, pnlU: p.pnlU,
    realizedU: p.realizedU, unrealizedU: p.unrealizedU, feesU: p.feesU, equityBasis: p.equityBasis,
    positions: p.positions.map((x) => ({ sym: x.sym, qty: x.qty, markU: x.markU, markBasis: x.markBasis, valueU: x.valueU })), openOrders: p.openOrders.length,
  }));
  const jr = (await get('/api/journal?limit=1')).json;
  run.chain = jr.chain;
  const study = await get('/api/research/study');
  run.studyCheck = { status: study.status, ms: study.ms, label: study.json?.label, counts: study.json?.counts };
  run.finishedAt = new Date().toISOString();
}

// ---------------------------------------------------------------------------------------------------------------
// Journal statistics and samples (read-only DB access after the HTTP run).
function collect() {
  const db = new DatabaseSync(DB, { readOnly: true });
  const rows = db.prepare('SELECT * FROM journal WHERE session_id = ? ORDER BY seq').all(run.session_id)
    .map(({ payload_json, ...r }) => ({ ...r, payload: JSON.parse(payload_json) }));
  const counts = {};
  for (const r of rows) counts[r.type] = (counts[r.type] || 0) + 1;
  const denyCodes = {};
  for (const r of rows.filter((x) => x.type === 'POLICY_DENY')) for (const c of r.payload.reasons ?? []) denyCodes[c.code] = (denyCodes[c.code] || 0) + 1;
  const orders = db.prepare('SELECT * FROM orders WHERE session_id = ?').all(run.session_id);
  const fills = db.prepare('SELECT f.*, o.role, o.agent_id FROM fills f JOIN orders o ON o.id = f.order_id WHERE f.session_id = ?').all(run.session_id);
  const intents = db.prepare('SELECT source, decision, COUNT(*) n FROM intents WHERE session_id = ? GROUP BY source, decision').all(run.session_id);
  db.close();

  const orderById = new Map(orders.map((o) => [o.id, o]));
  // All journal rows that belong to one order family (entry, its bracket children, their intents and fills).
  const family = (orderId) => {
    const ids = new Set([orderId]);
    const o = orderById.get(orderId);
    if (o?.parent_id) ids.add(o.parent_id);
    for (const x of orders) if (ids.has(x.parent_id)) ids.add(x.id);
    for (const id of [...ids]) { const oo = orderById.get(id); if (oo?.intent_id) ids.add(oo.intent_id); }
    // cancel / modify intents that targeted one of these orders (their proposal and policy rows)
    for (const r of rows) if (r.type === 'INTENT_PROPOSED' && ids.has(r.payload?.intent?.target_order_id)) ids.add(r.ref_id);
    return rows.filter((r) => ids.has(r.ref_id) || ids.has(r.payload?.order_id) || ids.has(r.payload?.oco_group?.replace(/^oco_/, '')) || (r.payload?.intent && ids.has(r.payload.intent.id)));
  };
  const firstFill = (pred) => rows.find((r) => r.type === 'FILL_ESTIMATED' && pred(r));
  const samples = {};
  let stopTriggeredByMove = false;
  const add = (key, covers, description, picked) => { if (picked && picked.length) samples[key] = { covers, description, rows: picked }; };

  const agentEntry = firstFill((r) => r.agent_id && r.payload.role === 'entry');
  if (agentEntry) {
    const fam = family(agentEntry.payload.order_id);
    const lastActivation = Math.max(agentEntry.seq, ...fam.filter((r) => r.type === 'BRACKET_CHILD_ACTIVATED').map((r) => r.seq));
    add('autonomous-buy', ['autonomous paper buy', 'attached stop (bracket children)'],
      'First agent entry that filled: proposal -> policy accept -> entry + bracket children submitted by the agent -> estimated fill -> children activated.',
      fam.filter((r) => r.seq <= lastActivation));
  }
  const replaced = rows.find((r) => r.type === 'ORDER_REPLACED');
  if (replaced) add('stop-modification', ['modify a working stop (replace)'], `ORDER_REPLACED by ${replaced.actor} through a gated modify intent.`, family(replaced.ref_id).filter((r) => r.seq <= replaced.seq));
  // The engine journals stopCheck (stop vs the as-of IEX bid) when a sell stop goes live (submit / bracket activation /
  // replace). Prefer a stop that sat BELOW the bid when it went live, i.e. one triggered by a later price move; a stop
  // placed at or above the bid triggers on its first evaluated minute because of where it was placed (OPEN_QUESTIONS #4).
  const lastStopCheck = (fill) => {
    let sc;
    for (const r of rows) {
      if (r.seq >= fill.seq) break;
      if ((r.ref_id === fill.payload.order_id || r.payload?.order_id === fill.payload.order_id) && r.payload?.stopCheck) sc = r.payload.stopCheck;
    }
    return sc ?? null;
  };
  const stopFills = rows.filter((r) => r.type === 'FILL_ESTIMATED' && r.payload.role === 'stop_loss');
  const belowBid = (r) => lastStopCheck(r)?.stopAtOrAboveBid === false;
  const stopFill = stopFills.find((r) => belowBid(r) && r.payload.worseThanStop === true) ?? stopFills.find(belowBid) ?? stopFills[0];
  if (stopFill) {
    const sc = lastStopCheck(stopFill);
    const byPlacement = !belowBid(stopFill);
    stopTriggeredByMove = !byPlacement;
    add('triggered-stop', [byPlacement ? 'placement-triggered stop (stop at/above bid at activation)' : 'triggered stop', ...(stopFill.payload.worseThanStop ? ['worse-than-stop modelled fill'] : [])],
      byPlacement
        ? `PLACEMENT-TRIGGERED STOP: the stop was at or above the as-of IEX bid when it went live (stopCheck ${sc ? `${sc.stopVsBidBps ?? '?'} bps vs bid` : 'not recorded'}), so it triggered on its first evaluated minute because of where it was placed, not because the price moved. No stop placed below the bid triggered in this run. Filled (estimated) at the worst observed bid less slippage; OCO sibling cancelled.`
        : `Stop-loss child placed ${Math.abs(sc.stopVsBidBps ?? 0)} bps below the as-of IEX bid when it went live, then triggered by a later price move and filled (estimated) at the worst observed bid less slippage; OCO sibling cancelled.`,
      family(stopFill.payload.order_id));
  }
  const tpFill = firstFill((r) => r.payload.role === 'take_profit');
  if (tpFill) add('take-profit', ['take-profit'], 'Take-profit child filled (estimated).', family(tpFill.payload.order_id));
  const timeExit = firstFill((r) => r.payload.role === 'time_exit');
  if (timeExit) add('time-exit', ['time exit'], 'Agent time exit filled.', family(timeExit.payload.order_id));
  const agentCancel = rows.find((r) => r.type === 'ORDER_CANCELLED' && r.actor === 'agent');
  const humanCancel = rows.find((r) => r.type === 'ORDER_CANCELLED' && r.actor === 'human' && r.payload.reason !== 'KILL_SWITCH_ENGAGED');
  if (agentCancel || humanCancel) add('cancellation', ['cancellation'], `${agentCancel ? 'Agent' : 'Human sandbox'} cancellation through a gated cancel intent.`, family((agentCancel ?? humanCancel).ref_id));
  const deny = (code) => rows.find((r) => r.type === 'POLICY_DENY' && (r.payload.reasons ?? []).some((x) => x.code === code));
  const withIntent = (r) => (r ? rows.filter((x) => (x.ref_id === r.ref_id) || (x.type === 'INTENT_PROPOSED' && x.payload.intent?.id === r.ref_id)) : []);
  const budget = deny('BUDGET_EXCEEDED');
  add('budget-rejection', ['rejection on budget'], `POLICY_DENY BUDGET_EXCEEDED (${budget?.agent_id ? 'agent' : 'human sandbox'} intent); nothing submitted.`, withIntent(budget));
  const stale = deny('QUOTE_STALE');
  add('stale-quote-rejection', ['rejection on stale quote'], `POLICY_DENY QUOTE_STALE (${stale?.agent_id ? 'agent' : 'human sandbox'} intent); nothing submitted.`, withIntent(stale));
  const spread = deny('SPREAD_TOO_WIDE');
  add('spread-rejection', ['spread/liquidity gate'], 'POLICY_DENY SPREAD_TOO_WIDE on an agent entry.', withIntent(spread));
  const unconf = deny('HUMAN_NOT_CONFIRMED');
  add('human-confirm-required', ['explicit human confirmation'], 'A sandbox order without confirm:true is denied by the gate.', withIntent(unconf));
  const kill = rows.filter((r) => ['KILL_SWITCH_ENGAGED', 'KILL_SWITCH_EFFECTS', 'AGENT_CONTROL_REFUSED', 'KILL_SWITCH_RELEASED'].includes(r.type)
    || (r.type === 'AGENT_STATE_CHANGED' && ['KILL_SWITCH_ENGAGED'].includes(r.payload.reason))
    || (r.type === 'ORDER_CANCELLED' && r.payload.reason === 'KILL_SWITCH_ENGAGED')
    || (r.type === 'POLICY_DENY' && (r.payload.reasons ?? []).some((x) => x.code === 'KILL_SWITCH_ENGAGED')));
  const killEffects = kill.find((r) => r.type === 'KILL_SWITCH_EFFECTS')?.payload;
  add('kill-switch', ['global kill switch'], `Kill switch engaged mid-session (KEEP_PROTECTIVE): agents STOPPED, ${killEffects?.cancelled?.length ?? 0} open non-protective order(s) cancelled, `
    + `${killEffects?.keptProtective?.length ?? 0} protective order(s) kept working, agent start and a new order refused while engaged, then released.`, kill);
  const sandboxFills = rows.filter((r) => r.type === 'FILL_ESTIMATED' && r.portfolio_id === 'sandbox');
  if (sandboxFills.length) add('sandbox-buy-sell', ['human sandbox buy and sell'], 'Human sandbox market BUY and SELL fills (estimated).', sandboxFills.flatMap((f) => family(f.payload.order_id)).filter((r, i, a) => a.findIndex((x) => x.seq === r.seq) === i));

  const fillSummary = fills.map((f) => ({ portfolio_id: f.portfolio_id, agent_id: f.agent_id, sym: f.sym, side: f.side, role: f.role, qty: f.qty, priceU: f.price, feesU: f.fees, ts: f.ts, tsEt: etTime(f.ts) }));
  return {
    counts, denyCodes, intents,
    orders: { total: orders.length, byStatus: orders.reduce((m, o) => ({ ...m, [o.status]: (m[o.status] || 0) + 1 }), {}), byRole: orders.reduce((m, o) => ({ ...m, [o.role]: (m[o.role] || 0) + 1 }), {}) },
    fills: fillSummary, samples, stopTriggeredByMove,
    worseThanStopFills: rows.filter((r) => r.type === 'FILL_ESTIMATED' && r.payload.worseThanStop === true).length,
    journalRowsThisSession: rows.length,
  };
}

/** Honest reading notes for the receipt (partly derived from this run). */
export function caveats(r, stats) {
  const killCancelled = r.killEffects?.cancelled?.length ?? 0;
  return [
    'Market data: stored IEX HIST TOPS for the replay date (IEX-only top of book and trades; not NBBO, not consolidated volume). Nothing here is live.',
    'Every fill is an ESTIMATED PAPER FILL (fill model iex-conservative-minute-v1: worst price in the minute, slippage, fees rounded up). No order reached an exchange.',
    'agent-cowboy-micro ran the documented handwritten-notes-example preset (EXPLORATORY, not tuned for this run); the other five agents ran their lens presets. All six used decisionMode rules. '
      + 'The lens presets proposed no entries on this dataset; their AGENT_SCAN rows record why (per-reason skip counts).',
    'The unconfirmed, over-budget, stale-quote, far-below limit + cancel, bracketed BUY, stop replace and SELL orders were human sandbox orders placed by this driver to exercise the policy gate and orders engine on real as-of quotes; symbols were picked at run time from the as-of scanner.',
    `Kill switch drill (KEEP_PROTECTIVE): ${killCancelled} open non-protective order(s) existed to cancel; the sandbox bracket's protective orders were kept working. Cancellation of pending entries by the kill switch is shown in the fixture sample receipts/journal-samples/fixture-agents-kill-switch.json.`,
    stats.samples['take-profit'] ? 'A take-profit filled on real data.' : 'No take-profit filled on real data in this run; take-profit is evidenced only by the fixture sample receipts/journal-samples/fixture-agents-take-profit.json.',
    'Long puts: no options data provider is wired into the replay and expiration settlement is never called automatically; operational options orders are rejected (409 NO_VERIFIED_OPTIONS_DATA). The long-put lifecycle (premium x 100, mark, cash-value expiration) is evidenced only with TEST FIXTURE contracts: test/sim/options.test.js and receipts/journal-samples/fixture-sim-long-put-example.json. Model assessments: no model provider configured (MODEL DISCONNECTED) — mock-provider tests only.',
    stats.stopTriggeredByMove ? 'Triggered stop: the sample stop was below the as-of IEX bid when it went live and was triggered by a later price move.' : (stats.samples['triggered-stop'] ? 'Triggered stop: every stop that triggered in this run was at or above the as-of IEX bid when it went live (placement-triggered, see OPEN_QUESTIONS #4), so no price-move-triggered stop occurred on real data; the acceptance item records false.' : 'No stop-loss triggered in this run.'),
    DB_COPY_OF
      ? `The server ran at ${BASE} on ${DB}, a disposable VACUUM INTO copy of ${DB_COPY_OF} made for this run (the original was opened read-only and never written; the copy was deleted afterwards, so this receipt cannot be re-read against it); journal statistics and samples were read from the copy read-only after the run. The chain field is the server's own verification (GET /api/journal).`
      : `The server ran at ${BASE} on database ${DB}; journal statistics and samples were read from that database read-only after the run. The chain field is the server's own verification (GET /api/journal).`,
  ];
}

function writeOutputs(stats) {
  const steps = run.steps;
  const perChunk = steps.map((s) => s.wallMs);
  const pm = steps.map((s) => s.perMinuteMs);
  const acceptance = [
    ['autonomous paper buy', !!stats.samples['autonomous-buy']],
    ['attached stop', !!stats.samples['autonomous-buy'] && stats.counts.BRACKET_CHILD_ACTIVATED > 0],
    ['triggered stop (stop below the bid when live, then a price move)', stats.stopTriggeredByMove === true],
    ['placement-triggered stop (stop at/above the bid when live)', !!stats.samples['triggered-stop'] && stats.stopTriggeredByMove !== true],
    ['worse-than-stop modelled fill', stats.worseThanStopFills > 0],
    ['take-profit', !!stats.samples['take-profit']],
    ['stop modification (replace)', !!stats.samples['stop-modification']],
    ['cancellation', !!stats.samples.cancellation],
    ['rejection on budget', !!stats.samples['budget-rejection']],
    ['rejection on stale quote', !!stats.samples['stale-quote-rejection']],
    ['global kill switch', !!stats.samples['kill-switch']],
    ['long put', false],
    ['model-adapter assessments', false],
  ].map(([item, onReal]) => ({ item, occurredOnRealData: onReal }));
  const receipt = {
    label: LABEL,
    command: `node --disable-warning=ExperimentalWarning test/api/e2e-real-replay.mjs --base ${BASE} --ds ${DS} --db ${DB} --chunk ${CHUNK}${DB_COPY_OF ? ` --db-copy-of ${DB_COPY_OF}` : ''}`,
    ...(DB_COPY_OF ? { database: { path: DB, copyOf: DB_COPY_OF, method: 'VACUUM INTO from a read-only open of the original', disposable: true, deletedAfterRun: true } } : {}),
    caveats: caveats(run, stats),
    ...run,
    acceptance,
    timing: {
      chunks: steps.length, minutes: steps.reduce((s, x) => s + x.minutes, 0), chunkWallMs: { min: Math.min(...perChunk), max: Math.max(...perChunk), total: perChunk.reduce((s, x) => s + x, 0) },
      perMinuteMsP50Max: Math.max(...pm.map((x) => x.p50 ?? 0)), perMinuteMsP95Max: Math.max(...pm.map((x) => x.p95 ?? 0)), perMinuteMsMax: Math.max(...pm.map((x) => x.max ?? 0)),
    },
    journal: { counts: stats.counts, policyDenyReasonCodes: stats.denyCodes, rowsThisSession: stats.journalRowsThisSession, chain: run.chain },
    intents: stats.intents, orders: stats.orders, fills: stats.fills,
    samplesWritten: Object.keys(stats.samples).map((k) => `receipts/journal-samples/real-${k}.json`),
  };
  if (OUT) { fs.mkdirSync(path.dirname(OUT), { recursive: true }); fs.writeFileSync(OUT, JSON.stringify(receipt, null, 2) + '\n'); log('wrote', OUT); }
  if (SAMPLES) {
    fs.mkdirSync(SAMPLES, { recursive: true });
    for (const [k, s] of Object.entries(stats.samples)) {
      const file = path.join(SAMPLES, `real-${k}.json`);
      fs.writeFileSync(file, JSON.stringify({ label: LABEL, scenario: k, covers: s.covers, description: s.description, dataset: DS, session_id: run.session_id,
        generatedBy: receipt.command, generatedAt: new Date().toISOString(), chain: run.chain, rows: s.rows }, null, 2) + '\n');
    }
    log('wrote', Object.keys(stats.samples).length, 'samples to', SAMPLES);
  }
  return receipt;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(() => {
    const stats = collect();
    const r = writeOutputs(stats);
    log('acceptance', JSON.stringify(r.acceptance));
    log('journal counts', JSON.stringify(stats.counts));
  }).catch((e) => { console.error(e); run.errors.push({ fatal: String(e?.message ?? e) }); process.exitCode = 1; });
}
