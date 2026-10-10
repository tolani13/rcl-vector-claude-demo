// TEST FIXTURE — NOT MARKET DATA. Strategy presets, validation, sizing arithmetic, as-of signals and pure proposals.
// Prices below are synthetic test values (u = 1e-4 USD); the 12200 u case reproduces the handwritten notes' own
// arithmetic example, not an observed price.
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  PRESETS, STRATEGY_LABEL, HANDWRITTEN_AMBIGUITIES, validateStrategy, deriveStrategy, computeSignals, planActions, proposeIntents,
  sizeEntry, exitPrices, BUY_SHARE_LABEL, sessionVolumesAsOf, relVolFrom, RELVOL_MIN_BASELINE_SHARES, SIGNAL_NOTES, documentedStopAtEntry,
} from '../../server/agents/strategies.js';
import { validateIntent } from '../../server/agents/intents.js';
import { defaultCostModel } from '../../server/sim/fills.js';
import { scanAsOf } from '../../server/research/scanner.js';
import { at, MINUTE, setupDb, jumpTape, flat, testStrategy, FIXTURE_DS } from './helpers/fixture.js';

test('presets: six lens x segment presets plus the handwritten example, all valid and labelled EXPLORATORY', () => {
  const keys = Object.keys(PRESETS).sort();
  assert.deepEqual(keys, ['cowboy-large', 'cowboy-micro', 'handwritten-notes-example', 'pragmatist-large', 'pragmatist-micro', 'tightwad-large', 'tightwad-micro']);
  for (const [k, p] of Object.entries(PRESETS)) {
    assert.equal(p.label, STRATEGY_LABEL, k);
    assert.equal(p.label, 'EXPLORATORY DEFAULTS — NOT VALIDATED');
    const v = validateStrategy(p);
    assert.equal(v.ok, true, `${k}: ${v.errors.join('; ')}`);
    assert.ok(p.exits.stopLoss, `${k} has a bounded-risk stop`);
    assert.equal(p.decisionMode, 'rules');
    assert.ok(Object.isFrozen(p));
    if (k !== 'handwritten-notes-example') assert.equal(`${p.lens}-${p.segment}`, k);
  }
  // Lens ordering: tightwad is the most conservative on budget, stop width and spread tolerance.
  for (const seg of ['micro', 'large']) {
    const [c, p, t] = ['cowboy', 'pragmatist', 'tightwad'].map((l) => PRESETS[`${l}-${seg}`]);
    assert.ok(c.entry.budgetUsd > p.entry.budgetUsd && p.entry.budgetUsd > t.entry.budgetUsd);
    assert.ok(c.exits.stopLoss.pct > p.exits.stopLoss.pct && p.exits.stopLoss.pct > t.exits.stopLoss.pct);
    assert.ok(c.entry.maxSpreadBps > p.entry.maxSpreadBps && p.entry.maxSpreadBps > t.entry.maxSpreadBps);
  }
});

test('handwritten example: $50 hard cap incl. slippage+fees (40 sh, not 42), stop at entry, both 250% readings shown', () => {
  const hw = PRESETS['handwritten-notes-example'];
  assert.equal(hw.entry.budgetUsd, 50);
  assert.equal(hw.entry.minRetPct, 22);
  assert.equal(hw.signal.windowMin, 15);
  assert.equal(hw.exits.stopLoss.basis, 'at_entry_ref');
  assert.equal(hw.exits.takeProfit.multiple, 2.5, 'default = the more conservative 250%-of-price reading');
  assert.equal(hw.exits.takeProfit.alternative.multiple, 3.5, '250% gain reading kept for display');
  assert.deepEqual(hw.exits.timeExit, { minutes: 15, bandPct: 10 });
  const ids = HANDWRITTEN_AMBIGUITIES.map((a) => a.id);
  for (const id of ['take-profit-250', 'budget-50-vs-42-shares', 'stop-at-entry', 'stagnation-exit-reference', 'velocity-intent-volume', 'price-tier-vs-example']) assert.ok(ids.includes(id), id);
  // The notes' own arithmetic example: ask $1.22 (12200 u).
  const size = sizeEntry(hw, { ask: 12200, bid: 12100, askSize: 5000, bidSize: 5000, quoteTs: 1 }, defaultCostModel('micro'));
  assert.equal(size.estPx, 12300, '1.22 * 1.005 = 1.2261 -> ticked up to $1.23');
  assert.equal(size.qty, 40);
  assert.ok(size.estCostU <= 500_000);
  assert.ok(42 * 12200 > 500_000, '42 x $1.22 = $51.24 breaches the cap');
  const px = exitPrices(hw, 12200);
  assert.equal(px.stop, 12200, 'stop trigger at the entry reference');
  assert.equal(px.take, 30500, '2.5x');
  assert.equal(px.takeAlt, 42700, '3.5x (250% gain) shown, not used');
});

test('validateStrategy rejects unbounded risk, bad labels, unknown modes; deriveStrategy merges and keeps the label', () => {
  const base = PRESETS['cowboy-micro'];
  assert.equal(validateStrategy({ ...base, exits: { ...base.exits, stopLoss: null } }).ok, false);
  assert.equal(validateStrategy({ ...base, label: 'VALIDATED' }).ok, false);
  assert.equal(validateStrategy({ ...base, decisionMode: 'yolo' }).ok, false);
  assert.equal(validateStrategy({ ...base, segment: 'otc' }).ok, false);
  assert.equal(validateStrategy({ ...base, entry: { ...base.entry, budgetUsd: -1 } }).ok, false);
  assert.equal(validateStrategy({ ...base, management: { ...base.management, maxOrdersPerStep: 0 } }).ok, false);
  const d = deriveStrategy('cowboy-micro', { entry: { budgetUsd: 75 } });
  assert.equal(d.id, 'custom:cowboy-micro');
  assert.equal(d.entry.budgetUsd, 75);
  assert.equal(d.entry.minRetPct, base.entry.minRetPct, 'unchanged fields kept');
  assert.equal(d.label, STRATEGY_LABEL);
  assert.throws(() => deriveStrategy('cowboy-micro', { entry: { orderType: 'iceberg' } }), /invalid strategy/);
  assert.throws(() => deriveStrategy('nope', {}), /unknown base/);
});

test('computeSignals: window return, acceleration, relVol (INSUFFICIENT before min history), inferred buy share', () => {
  const t = setupDb('signals', (db) => jumpTape(db, 'FIXA'));
  try {
    const cfg = { windowMin: 5, minHistoryMin: 5, minClassifiedShares: 1000 };
    const [s] = computeSignals(t.db, FIXTURE_DS, at(9, 48), ['FIXA'], cfg);
    assert.equal(s.priceU, 5800);
    assert.equal(s.refPriceU, 5000);
    assert.equal(s.refMinuteT, at(9, 42));
    assert.ok(Math.abs(s.ret_w - 0.16) < 1e-12);
    assert.ok(Math.abs(s.accel - 0.16) < 1e-12, 'all of the move is in the recent half-window');
    // relVol baseline (window excluded) = 22000 - 9000 = 13000 sh over 18 - 5 = 13 min: shorter than the shared 15-minute
    // minimum (server/data/marketdata.js) => null, with the baseline shown.
    assert.equal(s.relVol, null);
    assert.ok(s.reasons.includes('BASELINE_TOO_SHORT'));
    assert.equal(s.baselineMin, 13);
    assert.equal(s.baselineVolume, 13000);
    // At 09:52: window [09:47, 09:52) = 5000 + 4x1000 = 9000 sh over 5 min; baseline [09:30, 09:47) = 17000 sh over 17 min
    // -> 1800/min vs 1000/min = 1.8.
    const [later] = computeSignals(t.db, FIXTURE_DS, at(9, 52), ['FIXA'], cfg);
    assert.ok(Math.abs(later.relVol - 1.8) < 1e-12, `relVol ${later.relVol}`);
    assert.equal(later.baselineMin, 17);
    assert.equal(later.baselineVolume, 17000);
    // classified: buyer-initiated 4x300 + 3000 = 4200, seller-initiated 4x300 + 500 = 1700
    assert.ok(Math.abs(s.buyShare - 4200 / 5900) < 1e-12);
    assert.equal(s.buyShareLabel, BUY_SHARE_LABEL);
    assert.ok(Math.abs(s.classifiedShare - 5900 / 9000) < 1e-12);
    assert.equal(s.volumeW, 9000);
    assert.equal(s.spreadBps, Math.round((20 / 5800) * 10000));
    assert.equal(s.quoteAgeMs, 30_000);
    assert.equal(s.halted, false);
    assert.equal(s.insufficient, false);

    const [strict] = computeSignals(t.db, FIXTURE_DS, at(9, 48), ['FIXA'], { ...cfg, minClassifiedShares: 10_000 });
    assert.equal(strict.buyShare, null, 'too little classified volume -> null, never a guess');
    assert.ok(strict.reasons.includes('LOW_CLASSIFIED_VOLUME'));

    const [early] = computeSignals(t.db, FIXTURE_DS, at(9, 33), ['FIXA'], cfg);
    assert.equal(early.relVol, null);
    assert.ok(early.reasons.includes('RELVOL_INSUFFICIENT_HISTORY'));
    const [open] = computeSignals(t.db, FIXTURE_DS, at(9, 30), ['FIXA'], cfg);
    assert.equal(open.insufficient, true);
    assert.ok(open.reasons.includes('BEFORE_REGULAR_SESSION'));
    const [none] = computeSignals(t.db, FIXTURE_DS, at(9, 48), ['FIXZ'], cfg);
    assert.equal(none.insufficient, true);
    assert.ok(none.reasons.includes('NO_QUOTE'));
    assert.equal(computeSignals(t.db, null, at(9, 48), ['FIXA'], cfg)[0].reasons[0], 'NO_VERIFIED_DATA');
  } finally { t.cleanup(); }
});

test('no look-ahead: computeSignals at clock C is identical whether or not minutes >= C exist in the store', () => {
  // TEST FIXTURE: the "future" store has a dramatic move from 09:48 on that would change every metric if visible.
  const full = setupDb('la-full', (db) => jumpTape(db, 'FIXA', {
    after(d, sym) { jumpTapeFuture(d, sym); },
  }));
  const cut = setupDb('la-cut', (db) => jumpTape(db, 'FIXA', { after() {} }));
  try {
    for (const clock of [at(9, 40), at(9, 47), at(9, 48)]) {
      const cfg = { windowMin: 5, minHistoryMin: 5, minClassifiedShares: 1000 };
      const a = computeSignals(full.db, FIXTURE_DS, clock, ['FIXA'], cfg);
      const b = computeSignals(cut.db, FIXTURE_DS, clock, ['FIXA'], cfg);
      assert.deepEqual(a, b, `signals at ${new Date(clock).toISOString()} must not depend on later minutes`);
    }
    const [at47] = computeSignals(full.db, FIXTURE_DS, at(9, 47), ['FIXA'], { windowMin: 5, minHistoryMin: 5 });
    assert.equal(at47.ret_w, 0, 'the 09:47 jump is not knowable until 09:48');
  } finally { full.cleanup(); cut.cleanup(); }
});

test('incremental session-to-date volume equals a full as-of recompute (and never includes incomplete minutes)', () => {
  const t = setupDb('sessvol', (db) => { jumpTape(db, 'FIXA'); jumpTape(db, 'FIXB', { base: 4000, jump: 4400 }); });
  try {
    for (const c of [at(9, 31), at(9, 35), at(9, 47), at(9, 48), at(10, 5)]) sessionVolumesAsOf(t.db, FIXTURE_DS, c, at(9, 30));
    const inc = sessionVolumesAsOf(t.db, FIXTURE_DS, at(10, 6), at(9, 30));
    const fresh = new DatabaseSync(t.path, { readOnly: true }); // a different handle => no cached state
    try {
      const full = sessionVolumesAsOf(fresh, FIXTURE_DS, at(10, 6), at(9, 30));
      assert.deepEqual([...inc.entries()].sort(), [...full.entries()].sort());
      assert.equal(full.get('FIXA'), 17 * 1000 + 5000 + 18 * 1000, '09:30..10:05 complete minutes only');
    } finally { fresh.close(); }
    // Going backwards (a new session) recomputes from scratch.
    assert.equal(sessionVolumesAsOf(t.db, FIXTURE_DS, at(9, 48), at(9, 30)).get('FIXA'), 22_000);
  } finally { t.cleanup(); }
});

/** TEST FIXTURE future minutes: a run to 0.9000 (would trip every threshold if it leaked). */
function jumpTapeFuture(db, sym) {
  for (let t = at(9, 48); t <= at(10, 30); t += MINUTE) {
    db.prepare(`INSERT OR REPLACE INTO m1 (ds, sym, t, o, h, l, c, v, n, pv, bv, sv, xv, bid, ask, bsz, asz, qts, min_bid, max_bid, min_ask, max_ask, max_spr, nq)
      VALUES (?, ?, ?, 9000, 9000, 9000, 9000, 50000, 50, 450000000, 40000, 1000, 9000, 8990, 9010, 1000, 1000, ?, 8990, 8990, 9010, 9010, 20, 1)`)
      .run(FIXTURE_DS, sym, t, t + 30_000);
  }
}

test('planActions is pure and produces valid rules intents; filters are explained in `skipped`', () => {
  const s = testStrategy();
  const sig = {
    sym: 'FIXA', asOf: at(9, 48), windowMin: 5, priceU: 5800, priceMinuteT: at(9, 47), refPriceU: 5000, refMinuteT: at(9, 42), midPriceU: 5000, midMinuteT: at(9, 45),
    ret_w: 0.16, accel: 0.16, relVol: 1.5, buyShare: 0.7, classifiedShare: 0.6, volumeW: 9000, tradesW: 40, sessionVolume: 22000, elapsedMin: 18,
    spreadBps: 34, quoteAgeMs: 30_000, halted: false, insufficient: false, reasons: [],
    quote: { bid: 5790, ask: 5810, bidSize: 1000, askSize: 1000, quoteTs: at(9, 47) + 30_000, twoSided: true, minuteRowT: at(9, 47) },
  };
  const state = {
    agent: { id: 'agent-cowboy-micro', portfolio_id: 'cowboy-micro' }, ds: FIXTURE_DS, session: { open: at(9, 30), close: at(16, 0) },
    costModel: defaultCostModel('micro'), positions: [], openOrders: [], entryInfo: {}, entriesBySym: {}, lastExitTsBySym: {},
  };
  const frozen = structuredClone({ s, sig, state });
  const plan = planActions(s, [sig], state, at(9, 48));
  assert.deepEqual({ s, sig, state }, frozen, 'inputs untouched');
  assert.equal(plan.actions.length, 1);
  const [it] = proposeIntents(s, [sig], state, at(9, 48));
  assert.equal(validateIntent(it).ok, true);
  assert.equal(it.source, 'rules');
  assert.equal(it.strategy_id, s.id);
  assert.equal(it.qty, 171);
  assert.ok(it.evidence_refs.every((r) => r.startsWith(`iex-m1:${FIXTURE_DS}:FIXA:`)));
  // Already holding / cooldown / late session / spread are filters with reasons.
  const holding = planActions(s, [sig], { ...state, positions: [{ sym: 'FIXA', kind: 'equity', qty: 10, costBasisU: 58_400 }] }, at(9, 48));
  assert.equal(holding.actions.filter((a) => a.kind === 'entry').length, 0);
  assert.equal(holding.skipped.ALREADY_HOLDING, 1);
  const late = planActions(s, [sig], state, at(15, 50));
  assert.equal(late.skipped.OUTSIDE_ENTRY_WINDOW, 1);
  const cool = planActions(s, [sig], { ...state, lastExitTsBySym: { FIXA: at(9, 40) } }, at(9, 48));
  assert.equal(cool.skipped.REENTRY_COOLDOWN, 1);
  const wide = planActions(s, [{ ...sig, spreadBps: 2000 }], state, at(9, 48));
  assert.equal(wide.skipped.SPREAD_ABOVE_MAX, 1);
  const halted = planActions(s, [{ ...sig, halted: true }], state, at(9, 48));
  assert.equal(halted.skipped.HALTED, 1);
  const needBuy = deriveStrategy(s, { entry: { minBuyShare: 0.6, requireBuyShare: true } });
  assert.equal(planActions(needBuy, [{ ...sig, buyShare: null }], state, at(9, 48)).skipped.BUYSHARE_UNAVAILABLE, 1);
});

test('relVol: one definition with the scanner (window excluded from its baseline), no elapsed/W ceiling, thin baselines are unavailable', () => {
  // The old agent formula (window included in its own baseline) could never exceed elapsed/W: 2.0 at elapsed 30, W 15.
  const tenX = relVolFrom({ windowVol: 15 * 10_000, windowMin: 15, sessionVolToDate: 15 * 1000 + 15 * 10_000, elapsedMin: 30 });
  assert.equal(tenX.flag, null);
  assert.ok(Math.abs(tenX.relVol - 10) < 1e-12, `a 10x window rate reads 10, not <= 2 (${tenX.relVol})`);
  assert.equal(tenX.baselineMin, 15);
  assert.equal(tenX.baselineVol, 15_000);
  const short = relVolFrom({ windowVol: 9000, windowMin: 15, sessionVolToDate: 20_000, elapsedMin: 29 });
  assert.deepEqual([short.relVol, short.flag, short.baselineMin], [null, 'BASELINE_TOO_SHORT', 14]);
  assert.equal(relVolFrom({ windowVol: 500, windowMin: 15, sessionVolToDate: 500, elapsedMin: 40 }).flag, 'NO_BASELINE_VOLUME');
  // 3 baseline shares and 200 window shares: the scanner shows ~889x (THIN_BASELINE); agents do not gate on it.
  const thin = relVolFrom({ windowVol: 200, windowMin: 15, sessionVolToDate: 203, elapsedMin: 30 });
  assert.deepEqual([thin.relVol, thin.flag, thin.baselineVol], [null, 'BASELINE_VOLUME_TOO_SMALL', 3]);
  assert.equal(RELVOL_MIN_BASELINE_SHARES, 1000);
  assert.ok(SIGNAL_NOTES.some((n) => /BEFORE the window/.test(n) && /BASELINE_VOLUME_TOO_SMALL/.test(n)));

  // Parity on a TEST FIXTURE tape: the same number as the opportunity scanner at the same clock and window.
  const t = setupDb('relvol-parity', (db) => {
    jumpTape(db, 'FIXA');
    flat(db, 'FIXB', at(9, 30), at(9, 44), 4000, () => ({ v: 1 }));
    flat(db, 'FIXB', at(9, 45), at(10, 30), 4000, () => ({ v: 5000 }));
  });
  try {
    const clock = at(10, 0);
    const scan = scanAsOf(t.db, FIXTURE_DS, clock, { segment: 'micro', windowMin: 15 });
    const bySym = new Map(scan.rows.map((r) => [r.sym, r.metrics]));
    const [a, b] = computeSignals(t.db, FIXTURE_DS, clock, ['FIXA', 'FIXB'], { windowMin: 15, minHistoryMin: 30, minClassifiedShares: 1000 });
    // FIXA: window [09:45, 10:00) = 2x1000 + 5000 + 12x1000 = 19000 sh; baseline [09:30, 09:45) = 15000 sh over 15 min.
    assert.ok(Math.abs(a.relVol - (19_000 / 15) / (15_000 / 15)) < 1e-12, `agent relVol ${a.relVol}`);
    assert.equal(a.relVol, bySym.get('FIXA').relVol, 'agent relVol === scanner relVol');
    assert.equal(a.baselineMin, bySym.get('FIXA').relVolBasis.baselineMin);
    assert.equal(a.baselineVolume, bySym.get('FIXA').relVolBasis.baselineVolume);
    // FIXB: 15 baseline shares. Same baseline on both paths; the agent withholds the value (BASELINE_VOLUME_TOO_SMALL).
    assert.equal(b.baselineVolume, 15);
    assert.equal(b.baselineVolume, bySym.get('FIXB').relVolBasis.baselineVolume);
    assert.equal(b.relVol, null);
    assert.ok(b.reasons.includes('BASELINE_VOLUME_TOO_SMALL'));
    assert.ok(bySym.get('FIXB').relVol > 1000, 'the scanner reports the thin-baseline value (flagged), agents do not trade on it');
  } finally { t.cleanup(); }
});

test('handwritten preset: the stop at the entry ask is at/above the IEX bid; the entry is proposed (owner decision pending) with the consequence disclosed', () => {
  const hw = PRESETS['handwritten-notes-example'];
  // TEST FIXTURE signal: +25% over 15 min, two-sided IEX quote bid 0.5790 / ask 0.5810.
  const sig = {
    sym: 'FIXH', asOf: at(10, 0), windowMin: 15, priceU: 5800, priceMinuteT: at(9, 59), refPriceU: 4640, refMinuteT: at(9, 44), midPriceU: 5000, midMinuteT: at(9, 52),
    ret_w: 0.25, accel: 0.1, relVol: null, baselineMin: 15, baselineVolume: 15_000, buyShare: null, classifiedShare: 0, volumeW: 20_000, tradesW: 30,
    sessionVolume: 35_000, elapsedMin: 30, spreadBps: 34, quoteAgeMs: 30_000, halted: false, insufficient: false, reasons: [],
    quote: { bid: 5790, ask: 5810, bidSize: 1000, askSize: 1000, quoteTs: at(9, 59) + 30_000, twoSided: true, minuteRowT: at(9, 59) },
  };
  const state = {
    agent: { id: 'agent-cowboy-micro', portfolio_id: 'cowboy-micro' }, ds: FIXTURE_DS, session: { open: at(9, 30), close: at(16, 0) },
    costModel: defaultCostModel('micro'), positions: [], openOrders: [], entryInfo: {}, entriesBySym: {}, lastExitTsBySym: {},
  };
  assert.ok(exitPrices(hw, sig.quote.ask).stop >= sig.quote.bid, 'stop at the ask is at/above the bid');
  const plan = planActions(hw, [sig], state, at(10, 0));
  const entry = plan.actions.find((a) => a.kind === 'entry');
  assert.ok(entry, 'not skipped: OPEN_QUESTIONS #4 is still open');
  assert.equal(entry.detail.stopU, 5810);
  assert.equal(entry.detail.bidU, 5790);
  assert.equal(entry.detail.stopAtOrAboveBid, true);
  assert.equal(entry.detail.stopVsBidBps, Math.round((20 / 5790) * 10_000));
  assert.match(entry.intent.rationale, /WARNING: stop \$0\.5810 is at\/above the as-of IEX bid \$0\.5790 \(35 bps above\)/);
  assert.match(entry.intent.rationale, /first evaluated minute after activation/);
  assert.match(entry.intent.rationale, /spread-induced/);
  assert.equal(entry.intent.attach.stop_loss_px_u, 5810);
  assert.equal(validateIntent(entry.intent).ok, true);
  assert.match(HANDWRITTEN_AMBIGUITIES.find((a) => a.id === 'stop-at-entry').default, /first evaluated minute/);

  // Any other stop basis that lands at/above the bid is skipped, never proposed.
  const tight = deriveStrategy(testStrategy(), { exits: { stopLoss: { basis: 'pct_below_entry_ref', pct: 0.1 } } });
  const skipped = planActions(tight, [{ ...sig, ret_w: 0.25 }], state, at(10, 0));
  assert.equal(skipped.actions.filter((a) => a.kind === 'entry').length, 0);
  assert.equal(skipped.skipped.STOP_AT_OR_ABOVE_BID, 1);
  // The at-entry exception is the documented example only (the gate denies any other at_entry_ref stop at/above the bid):
  // a renamed copy, or another strategy switched to 'at_entry_ref', skips instead of proposing a denied entry each minute.
  assert.equal(documentedStopAtEntry(hw), true);
  const copy = deriveStrategy(hw, { id: 'my-handwritten-copy' });
  const atRef = deriveStrategy(testStrategy(), { exits: { stopLoss: { basis: 'at_entry_ref' } } });
  for (const [why, s] of [['renamed copy', copy], ['other strategy at_entry_ref', atRef], ['no stop-at-entry ambiguity', deriveStrategy(hw, { id: hw.id, ambiguities: [] })]]) {
    assert.equal(documentedStopAtEntry(s), false, why);
    const p = planActions(s, [sig], state, at(10, 0));
    assert.equal(p.actions.filter((a) => a.kind === 'entry').length, 0, why);
    assert.equal(p.skipped.STOP_AT_OR_ABOVE_BID, 1, why);
  }
  // A stop below the bid carries no warning.
  const normal = planActions(testStrategy(), [sig], state, at(10, 0)).actions.find((a) => a.kind === 'entry');
  assert.equal(normal.detail.stopAtOrAboveBid, false);
  assert.doesNotMatch(normal.intent.rationale, /WARNING/);
});

test('docs/OPEN_QUESTIONS.md lists every HANDWRITTEN_AMBIGUITIES code id, and no stale ones', () => {
  const md = fs.readFileSync(new URL('../../docs/OPEN_QUESTIONS.md', import.meta.url), 'utf8');
  const table = md.slice(md.indexOf('| Row | Code id |'));
  const documented = [...table.matchAll(/^\| [\d, ]+ \| `([a-z0-9-]+)` \|\r?$/gm)].map((m) => m[1]);
  const code = HANDWRITTEN_AMBIGUITIES.map((a) => a.id);
  assert.deepEqual([...documented].sort(), [...code].sort());
});
