// TEST FIXTURE — NOT MARKET DATA. Lens-output guards: proposal semantics and bracket coherence, inline citations,
// the number cross-check, the hindsight (training-cutoff) guard and the global model-call budget. All prices, quotes
// and proposals below are invented for tests; providers are in-process MOCKS.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  runLensAssessments, buildEvidencePacket, validateProposalDraft, listAssessments, hindsightCheck, modelCallBudget,
} from '../../server/intel/assessments.js';
import {
  checkLensSemantics, checkBracketCoherence, crossCheckNumbers, isValidTickUsd, PROPOSED_INTENT_SCHEMA, systemPromptFor, PACKET_REMINDER,
} from '../../server/intel/prompts.js';
import { list as journalList, append as journalAppend, verifyChain } from '../../server/journal.js';
import {
  tempDb, seedFixture, makeMockProvider, lensOf, lensOutput, okResult, FIX_DS, FIX_SYM, FIX_ASOF, FIX_DATE,
} from './helpers.js';

let t;
let packet;
before(() => { t = tempDb(); seedFixture(t.db); packet = buildEvidencePacket(t.db, FIX_DS, FIX_SYM, FIX_ASOF); });
after(() => t.cleanup());

const run = (provider, extra = {}) => runLensAssessments(t.db, provider, { session_id: extra.session_id ?? `g-${Math.random()}`, ds: FIX_DS, sym: FIX_SYM, asOf: FIX_ASOF, ...extra });

// TEST FIXTURE proposal shaped like the receipt's qwen3:8b Cowboy proposal (order_type limit with the protective stop
// copied into stop_px_usd, and both qty and budget_usd). Values are invented.
const RECEIPT_SHAPE = Object.freeze({
  action: 'open', side: 'buy', order_type: 'limit', budget_usd: 24, qty: 100, limit_px_usd: 0.238, stop_px_usd: 0.2345,
  stop_loss_px_usd: 0.2345, take_profit_px_usd: 0.2455, time_exit_min: null, expires_in_min: 15,
  rationale: 'TEST FIXTURE rationale', evidence_refs: ['ev_a'],
});
const PENNY_QUOTE = Object.freeze({ bid_usd: 0.235, ask_usd: 0.242 }); // TEST FIXTURE quote
const entry = (p) => ({ ...lensOutput('cowboy', ['ev_a']), stance: 'consider_entry', proposed_intent: { ...RECEIPT_SHAPE, stop_px_usd: null, ...p } });
const sem = (out, quote = PENNY_QUOTE) => checkLensSemantics(out, { lens: 'cowboy', evidenceIds: ['ev_a', 'ev_b'], quote });

test('stop_px_usd on a limit/market order is rejected with a clear reason; the fixed proposal validates', () => {
  const errs = sem(entry({ stop_px_usd: 0.2345 }));
  assert.equal(errs.length, 1, errs.join(' | '));
  assert.match(errs[0], /stop_px_usd: must be null for order_type limit .*protective stop belongs in stop_loss_px_usd/);
  assert.deepEqual(sem(entry({})), []);
  // qty and budget_usd together are allowed (qty is the size, budget_usd caps the cost).
  const v = validateProposalDraft({ ...RECEIPT_SHAPE, stop_px_usd: null }, { lens: 'cowboy', segment: 'micro', sym: 'QQFIX', asOf: FIX_ASOF, quoteTs: FIX_ASOF - 1000 });
  assert.equal(v.status, 'VALID', v.errors.join('; '));
  assert.equal(v.intent.qty, 100);
  assert.equal(v.intent.budget_usd, 24);
  // limit_px_usd on market/stop orders is rejected too; stop/stop_limit need their trigger.
  assert.ok(sem(entry({ order_type: 'market' })).some((e) => /limit_px_usd: must be null for order_type market/.test(e)));
  assert.ok(sem(entry({ order_type: 'stop', limit_px_usd: null })).some((e) => /stop_px_usd: required for stop/.test(e)));
  // The schema documents the field matrix for the model.
  assert.match(PROPOSED_INTENT_SCHEMA.properties.stop_px_usd.description, /MUST be null for market and limit/);
  assert.match(PROPOSED_INTENT_SCHEMA.properties.stop_loss_px_usd.description, /Protective exit stop/);
  assert.match(systemPromptFor('cowboy'), /stop_px_usd is never the protective stop/);
  assert.match(systemPromptFor('cowboy'), /whole cents/);
});

test('Reg NMS ticks: whole cents at or above $1, up to 4 decimals below', () => {
  assert.equal(isValidTickUsd(1.23), true);
  assert.equal(isValidTickUsd(1.234), false);
  assert.equal(isValidTickUsd(0.2345), true);
  assert.equal(isValidTickUsd(0.23456), false);
  const errs = sem(entry({ limit_px_usd: 1.234, stop_loss_px_usd: 1.2, take_profit_px_usd: 1.3 }), { bid_usd: 1.22, ask_usd: 1.24 });
  assert.ok(errs.some((e) => /limit_px_usd: 1.234 is not a valid price tick/.test(e)), errs.join(' | '));
});

test('bracket coherence against the packet quote: incoherent stops and targets are INVALID_OUTPUT material', () => {
  // Protective stop at/above the bid would trigger in the first minute.
  assert.ok(sem(entry({ stop_loss_px_usd: 0.235 })).some((e) => /below the current IEX bid 0.235/.test(e)));
  // Target below the bid / entry.
  const tpLow = sem(entry({ take_profit_px_usd: 0.23 }));
  assert.ok(tpLow.some((e) => /take_profit_px_usd 0.23 must be above the current IEX bid/.test(e)));
  assert.ok(tpLow.some((e) => /take_profit_px_usd 0.23 must be above the entry reference price 0.238/.test(e)));
  // IEX-penny wide spread: stop below the limit but at/above the bid is still incoherent.
  const wide = { bid_usd: 0.2, ask_usd: 0.26 };
  const wideErrs = sem(entry({ limit_px_usd: 0.26, stop_loss_px_usd: 0.21, take_profit_px_usd: 0.3 }), wide);
  assert.ok(wideErrs.some((e) => /stop_loss_px_usd 0.21 must be below the current IEX bid 0.2/.test(e)), wideErrs.join(' | '));
  // A limit far through the ask and a buy-stop trigger below the ask.
  assert.ok(sem(entry({ limit_px_usd: 0.3, take_profit_px_usd: 0.35 })).some((e) => /more than 10% above the current IEX ask/.test(e)));
  assert.ok(sem(entry({ order_type: 'stop', limit_px_usd: null, stop_px_usd: 0.24 })).some((e) => /buy-stop entry trigger\) must be at or above the current IEX ask/.test(e)));
  // Coherent bracket: stop < bid < ask < target.
  assert.deepEqual(sem(entry({ stop_loss_px_usd: 0.22, take_profit_px_usd: 0.27 })), []);
  assert.deepEqual(checkBracketCoherence({ order_type: 'market', stop_loss_px_usd: 0.22, take_profit_px_usd: 0.27, limit_px_usd: null, stop_px_usd: null }, PENNY_QUOTE), []);
  // Without a quote, self-coherence still applies (stop above target).
  assert.ok(checkBracketCoherence({ order_type: 'limit', limit_px_usd: 0.24, stop_loss_px_usd: 0.3, take_profit_px_usd: 0.1 }).length >= 2);
});

test('rule 8 parity: a time-exit-only proposal is rejected; empty calibration and high-confidence abstentions too', () => {
  const timeOnly = sem(entry({ stop_loss_px_usd: null, take_profit_px_usd: null, time_exit_min: 30 }));
  assert.ok(timeOnly.some((e) => /stop_loss_px_usd: required/.test(e)));
  assert.deepEqual(sem(entry({ take_profit_px_usd: null, time_exit_min: 30, stop_loss_px_usd: 0.22 })), []);
  const base = lensOutput('cowboy', ['ev_a']);
  assert.ok(sem({ ...base, confidence: { level: 'low', calibration_note: '   ' } }).some((e) => /calibration_note: empty/.test(e)));
  assert.ok(sem({ ...base, stance: 'insufficient_evidence', confidence: { level: 'high', calibration_note: 'x' } }).some((e) => /contradicts stance insufficient_evidence/.test(e)));
});

test('inline citations in the text must be packet ids that are also listed in evidence_refs', () => {
  const base = lensOutput('cowboy', ['ev_a']);
  const fake = sem({ ...base, thesis: 'Momentum [ev_FAKE] and price $9.99 [ev_a]' });
  assert.ok(fake.some((e) => /\$\.thesis: cites "ev_FAKE" inline, which is not an id in the evidence packet/.test(e)), fake.join(' | '));
  const unlisted = sem({ ...base, counter_thesis: 'But see [ev_b]' });
  assert.ok(unlisted.some((e) => /cites ev_b inline but it is missing from evidence_refs/.test(e)));
  assert.deepEqual(sem({ ...base, evidence_refs: ['ev_a', 'ev_b'], counter_thesis: 'But see [ev_b]' }), []);
  // Words that merely contain "ev_" are not citations.
  assert.deepEqual(sem({ ...base, exposure: 'prev_close is not in the packet' }), []);
});

test('end to end: incoherent or mis-cited outputs are stored as INVALID_OUTPUT, never OK', async () => {
  const q = packet.packet.items.find((i) => i.kind === 'market_quote').body; // fixture bid 0.458 / ask 0.46
  const ref = packet.evidenceIds[0];
  const mock = makeMockProvider((req) => {
    const lens = lensOf(req.system);
    if (lens === 'cowboy') {
      return okResult(lensOutput(lens, packet.evidenceIds, {
        stance: 'consider_entry',
        proposed_intent: { ...RECEIPT_SHAPE, stop_px_usd: null, limit_px_usd: q.ask_usd, stop_loss_px_usd: q.bid_usd, take_profit_px_usd: 0.5, qty: null, evidence_refs: [ref] },
      }));
    }
    if (lens === 'pragmatist') return okResult(lensOutput(lens, packet.evidenceIds, { thesis: `cites [ev_000000000000000000000000] and [${ref}]` }));
    return okResult(lensOutput(lens, packet.evidenceIds));
  });
  const res = await run(mock, { session_id: 'guards-e2e' });
  const by = Object.fromEntries(res.results.map((r) => [r.lens, r]));
  assert.equal(by.cowboy.status, 'INVALID_OUTPUT');
  assert.match(by.cowboy.error, /SEMANTIC_INVALID: .*must be below the current IEX bid 0.458/);
  assert.equal(by.cowboy.intent.status, 'NONE');
  assert.equal(by.pragmatist.status, 'INVALID_OUTPUT');
  assert.match(by.pragmatist.error, /inline, which is not an id in the evidence packet/);
  assert.equal(by.tightwad.status, 'OK');
});

test('number cross-check: misquoted numbers and "tight" claims on wide spreads are flagged, not rewritten', async () => {
  // Unit: a packet-shaped TEST FIXTURE object.
  const fixturePacket = {
    meta: { sym: 'QQFIX', as_of_et: '2026-01-05 10:30 ET' },
    items: [
      { kind: 'market_quote', body: { bid_usd: 0.235, ask_usd: 0.242, spread_usd: 0.007, spread_bps: 294, spread_pct_of_mid: 2.936 } },
      { kind: 'market_price', body: { regular_session: { session_low_usd: 0.185, session_high_usd: 0.25 } } },
      { kind: 'market_aggressor_inferred', body: { recent_15m: { buy_share: 0.522, classified_share_of_volume: 0.339 } } },
      { kind: 'market_volume', body: { recent: { window_min: 15 } } },
    ],
    unavailable: [],
  };
  const out = lensOutput('pragmatist', ['ev_a'], {
    thesis: 'The bid 0.235 sits near the low 0.185; buy share 52.2% on 33.9% classified volume; 15m low 0.1999.',
    liquidity_and_spread: 'Spread: 0.007 USD (tight), about 2.9% round trip.',
  });
  const v = crossCheckNumbers(out, fixturePacket);
  assert.equal(v.checked, true);
  // 0.1999 is in no packet field (a 15-minute low is not in the packet); 0.007 / 2.9% / 52.2% / 33.9% / 15 all match.
  assert.deepEqual(v.unmatched.map((u) => u.value), ['0.1999']);
  assert.ok(v.unmatched.every((u) => u.field.startsWith('$.')));
  assert.ok(v.flags.some((f) => /tight\/narrow while the packet's IEX spread is 294 bps/.test(f)));
  assert.match(v.note, /not a fact check/);

  // End to end: the verification travels with the result, the journal and the stored-assessment audit.
  const mock = makeMockProvider((req) => okResult(lensOutput(lensOf(req.system), packet.evidenceIds, { thesis: `Price is near 0.123, see [${packet.evidenceIds[0]}]` })));
  const res = await run(mock, { session_id: 'guards-xcheck', lenses: ['tightwad'] });
  const r = res.results[0];
  assert.equal(r.status, 'OK');
  assert.deepEqual(r.verification.unmatched, [{ field: '$.thesis', value: '0.123' }]);
  const j = journalList(t.db, { session_id: 'guards-xcheck', type: 'MODEL_ASSESSMENT' })[0];
  assert.deepEqual(j.payload.verification.unmatched, r.verification.unmatched);
  const listed = listAssessments(t.db, { sym: FIX_SYM, session_id: 'guards-xcheck' })[0];
  assert.deepEqual(listed.audit.verification.unmatched, r.verification.unmatched);
  assert.equal(listed.output.thesis, `Price is near 0.123, see [${packet.evidenceIds[0]}]`, 'model text is stored unchanged');
  // Hard rules are repeated at the end of the user message.
  assert.ok(packet.userMessage.endsWith(PACKET_REMINDER));
});

test('hindsight guard: a replay before or near the model training cutoff is BLOCKED without any call', async () => {
  const respond = (req) => okResult(lensOutput(lensOf(req.system), packet.evidenceIds));
  // Fixture trade date 2026-01-05 is before this TEST cutoff.
  const pre = makeMockProvider(respond, { config: { trainingCutoff: '2026-06-30', trainingCutoffSource: 'TEST MOCK' } });
  const res = await run(pre, { session_id: 'hs-pre' });
  assert.equal(res.status, 'BLOCKED');
  assert.equal(res.code, 'REPLAY_BEFORE_MODEL_CUTOFF');
  assert.equal(res.note, 'ASSESSMENT_NOT_RUN');
  assert.match(res.detail, /may remember what happened next/);
  assert.equal(pre.calls.length, 0, 'provider.complete must never be called');
  assert.equal(t.db.prepare("SELECT COUNT(*) n FROM assessments WHERE session_id = 'hs-pre'").get().n, 0);
  const blocked = journalList(t.db, { session_id: 'hs-pre', type: 'MODEL_CALL_BLOCKED' });
  assert.equal(blocked.length, 1);
  assert.equal(blocked[0].actor, 'system');
  assert.equal(blocked[0].payload.code, 'REPLAY_BEFORE_MODEL_CUTOFF');
  // Unknown cutoff is not safe.
  const unknown = makeMockProvider(respond, { config: {} });
  const u = await run(unknown, { session_id: 'hs-unknown' });
  assert.equal(u.status, 'BLOCKED');
  assert.equal(u.code, 'MODEL_TRAINING_CUTOFF_UNKNOWN');
  assert.equal(unknown.calls.length, 0);
  // Explicit operator override runs, but every result and journal row is stamped hindsight_risk.
  const allowed = makeMockProvider(respond, { config: { trainingCutoff: '2026-06-30', allowPreCutoffReplay: true } });
  const a = await run(allowed, { session_id: 'hs-allowed' });
  assert.equal(a.status, 'COMPLETED');
  assert.equal(a.hindsight.hindsight_risk, true);
  assert.ok(a.results.every((r) => r.hindsight?.hindsight_risk === true && r.hindsight.model_training_cutoff === '2026-06-30'));
  assert.ok(journalList(t.db, { session_id: 'hs-allowed', type: 'MODEL_ASSESSMENT' }).every((j) => j.payload.hindsight?.hindsight_risk === true));
  assert.ok(listAssessments(t.db, { sym: FIX_SYM, session_id: 'hs-allowed' }).every((r) => r.audit.hindsight?.hindsight_risk === true));
  // A clean run (cutoff well before the trade date) carries no stamp.
  const clean = await run(makeMockProvider(respond), { session_id: 'hs-clean', lenses: ['cowboy'] });
  assert.equal(clean.status, 'COMPLETED');
  assert.equal(clean.hindsight, null);
  assert.equal(verifyChain(t.db).ok, true);
});

test('hindsightCheck: built-in and configured cutoffs, safety margin', () => {
  const opus = { model: 'claude-opus-5-5', config: {} };
  assert.equal(hindsightCheck(opus, '2026-10-07').ok, true);       // built-in 2026-06-30 + 90 days = 2026-09-28
  assert.equal(hindsightCheck(opus, '2026-10-07').source, 'built-in');
  const near = hindsightCheck(opus, '2026-09-01');
  assert.equal(near.ok, false);
  assert.equal(near.code, 'REPLAY_BEFORE_MODEL_CUTOFF');
  assert.equal(near.safeAfter, '2026-09-28');
  assert.equal(hindsightCheck({ model: 'x', config: { trainingCutoff: '2025-10-01' } }, FIX_DATE).ok, true);
  assert.equal(hindsightCheck({ model: 'x', config: { trainingCutoff: '2025-10-01', cutoffMarginDays: 120 } }, FIX_DATE).ok, false);
  assert.equal(hindsightCheck({ model: 'x', config: { trainingCutoff: 'not-a-date' } }, FIX_DATE).code, 'MODEL_TRAINING_CUTOFF_UNKNOWN');
  assert.equal(hindsightCheck(null, FIX_DATE).ok, false);
});

test('global model-call budget: rolling 24 h across sessions; resets do not refill it; model tests count', async () => {
  const b = tempDb();
  try {
    seedFixture(b.db);
    const pk = buildEvidencePacket(b.db, FIX_DS, FIX_SYM, FIX_ASOF);
    const mock = makeMockProvider((req) => okResult(lensOutput(lensOf(req.system), pk.evidenceIds)));
    const go = (session_id, extra = {}) => runLensAssessments(b.db, mock, { session_id, ds: FIX_DS, sym: FIX_SYM, asOf: FIX_ASOF, maxCallsPerDay: 5, ...extra });
    assert.equal((await go('day-a')).status, 'COMPLETED');
    // A new replay session (as after POST /api/replay/reset) does not get a fresh allowance.
    const second = await go('day-b');
    assert.equal(second.status, 'CALL_CAP_REACHED');
    assert.equal(second.scope, 'rolling_24h');
    assert.match(second.detail, /3\/5 calls in the last 24 h across all sessions/);
    assert.equal(mock.calls.length, 3);
    assert.equal(journalList(b.db, { session_id: 'day-b', type: 'MODEL_CALL_CAP_REACHED' })[0].payload.scope, 'rolling_24h');
    // Two more still fit; then the budget is exhausted.
    assert.equal((await go('day-c', { lenses: ['cowboy', 'tightwad'] })).status, 'COMPLETED');
    assert.equal((await go('day-d', { lenses: ['cowboy'] })).status, 'CALL_CAP_REACHED');
    // Explicit model tests (journaled MODEL_TEST) count against the same budget.
    const before = modelCallBudget(b.db, null, { maxCallsPerDay: 10 });
    assert.equal(before.used, 5);
    journalAppend(b.db, { actor: 'human', type: 'MODEL_TEST', payload: { decision: 'OK', note: 'TEST FIXTURE' } });
    const afterTest = modelCallBudget(b.db, null, { maxCallsPerDay: 10 });
    assert.equal(afterTest.used, 6);
    assert.equal(afterTest.remaining, 4);
    // The window rolls: a day later nothing counts. The provider's configured cap is honoured.
    assert.equal(modelCallBudget(b.db, null, { now: Date.now() + 25 * 3_600_000 }).used, 0);
    assert.equal(modelCallBudget(b.db, { config: { maxCallsPerDay: 7 } }).cap, 7);
  } finally {
    b.cleanup();
  }
});
