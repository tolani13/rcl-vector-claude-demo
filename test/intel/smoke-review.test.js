// TEST FIXTURE — NOT MARKET DATA. Deterministic reviewer notes used by the live smoke receipt (test tooling only).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { windowLabelIssues, buyPressureIssues, reviewLens, reviewerNotes, packetWindowValues } from './smoke-review.js';
import { lensOutput } from './helpers.js';

// Invented packet items (TEST FIXTURE values, shaped like buildEvidencePacket items).
const ITEMS = [
  { kind: 'market_quote', body: { bid_usd: 0.2, ask_usd: 0.206, spread_bps: 294 } },
  {
    kind: 'market_price',
    body: {
      last_trade_usd: 0.203,
      regular_session: { session_high_usd: 0.25, session_low_usd: 0.185 },
      recent_15m: { recent_15m_high_usd: 0.21, recent_15m_low_usd: 0.198 },
      premarket: { status: 'NO_PREMARKET_TRADES' },
    },
  },
  { kind: 'market_volume', body: { regular_session: { session_vwap_usd: 0.2101 } } },
  { kind: 'market_aggressor_inferred', body: { regular_session: { buy_share: 0.52 }, recent_15m: { buy_share: null } } },
];

test('window labels: a session value quoted as a 15-minute value is flagged; correct labels pass', () => {
  assert.deepEqual(windowLabelIssues('The 15m low of $0.198 held and the session high was 0.25.', ITEMS), []);
  const mis = windowLabelIssues('Price bounced off the 15m low of 0.185.', ITEMS);
  assert.equal(mis.length, 1);
  assert.match(mis[0], /"15m low of 0\.185" is mislabelled: 0\.185 is regular_session\.session_low_usd, while recent_15m\.recent_15m_low_usd is 0\.198/);
  // The packet has no 15-minute VWAP at all.
  assert.match(windowLabelIssues('15-minute VWAP 0.2101 is support', ITEMS)[0], /no VWAP for that window/);
  // Missing premarket values.
  assert.match(windowLabelIssues('premarket high 0.30', ITEMS)[0], /packet has no premarket\.premarket_high_usd/);
  // A number that matches nothing.
  assert.match(windowLabelIssues('session low: 0.17', ITEMS)[0], /does not match regular_session\.session_low_usd \(0\.185\)/);
  // A following statistic word ends the gap; percentages are not prices.
  assert.deepEqual(windowLabelIssues('15m low and the session high 0.25', ITEMS), []);
  assert.deepEqual(windowLabelIssues('session high 12% above the open', ITEMS), []);
  assert.equal(packetWindowValues(ITEMS)['regular_session.session_vwap_usd'], 0.2101);
});

test('buying-pressure claims are checked against the inferred buy share; denials are not flagged', () => {
  assert.match(buyPressureIssues(['Strong buying pressure into the close.'], ITEMS)[0], /buy_share is 0\.52 \(session\) \/ null \(recent 15m\)/);
  assert.deepEqual(buyPressureIssues(['There is no buying pressure here.'], ITEMS), []);
  assert.deepEqual(buyPressureIssues(['Volume rose.'], ITEMS), []);
  const strong = ITEMS.map((it) => (it.kind === 'market_aggressor_inferred' ? { ...it, body: { regular_session: { buy_share: 0.8 }, recent_15m: { buy_share: 0.7 } } } : it));
  assert.deepEqual(buyPressureIssues(['buy pressure dominates'], strong), []);
  const none = ITEMS.filter((it) => it.kind !== 'market_aggressor_inferred');
  assert.match(buyPressureIssues(['buyer pressure'], none)[0], /buy_share is null/);
});

test('reviewLens / reviewerNotes: context headroom, number cross-check, spread claims, round-trip cost, invalid intents', () => {
  const output = lensOutput('cowboy', ['ev_a'], {
    stance: 'consider_entry',
    thesis: 'Bounce from the 15m low of 0.185 [ev_a]',
    exposure: 'Risk 20 paper dollars to the stop.',
    proposed_intent: { rationale: 'TEST MOCK', evidence_refs: ['ev_a'] },
  });
  const r = {
    lens: 'cowboy', status: 'OK', output, error: null, usage: { in: 4000, out: 3500 },
    verification: { unmatched: [{ field: '$.exposure', value: '20' }], flags: ["describes the spread as tight/narrow while the packet's IEX spread is 294 bps"] },
    intent: { status: 'INVALID', errors: ['TEST MOCK error'] },
  };
  const rev = reviewLens(r, ITEMS, { tokens: 8192 });
  assert.equal(rev.stance, 'consider_entry');
  assert.deepEqual(rev.context_use, { prompt_tokens: 4000, output_tokens: 3500, context_tokens: 8192, share: 0.916 });
  const text = rev.observations.join('\n');
  assert.match(text, /context nearly exhausted: 7500 of 8192 tokens/);
  assert.match(text, /"15m low of 0\.185" is mislabelled/);
  assert.match(text, /number not found in the packet: 20 \(\$\.exposure\)/);
  assert.match(text, /tight\/narrow while the packet's IEX spread is 294 bps/);
  assert.match(text, /does not account for the round-trip spread cost/);
  assert.match(text, /intent draft INVALID: TEST MOCK error/);
  // Exhausted context and failed lenses.
  const bad = reviewLens({ lens: 'tightwad', status: 'INVALID_OUTPUT', output: null, error: 'CONTEXT_EXHAUSTED: TEST MOCK', usage: { in: 4000, out: 4192 } }, ITEMS, { tokens: 8192 });
  assert.deepEqual(bad.observations, ['not usable: INVALID_OUTPUT - CONTEXT_EXHAUSTED: TEST MOCK', 'context exhausted: 4000 + 4192 tokens >= 8192']);
  const notes = reviewerNotes([r], ITEMS, { tokens: 8192, source: 'TEST' });
  assert.match(notes.status_semantics, /NOT fact-checked/);
  assert.equal(notes.human.status, 'NOT_REVIEWED');
  assert.equal(notes.per_lens.length, 1);
  assert.deepEqual(reviewerNotes([], ITEMS, null, { reviewer: 'TEST', notes: ['x'] }).human, { reviewer: 'TEST', notes: ['x'] });
});
