// TEST FIXTURE — NOT MARKET DATA. Bounded repair of INVALID_OUTPUT lens answers: one re-ask with only the lens's own
// validator errors, the rejected attempt kept as an audit row, independence and caps preserved. Providers are MOCKS.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { runLensAssessments, buildEvidencePacket, listAssessments } from '../../server/intel/assessments.js';
import { tempDb, seedFixture, makeMockProvider, lensOf, lensOutput, okResult, FIX_DS, FIX_SYM, FIX_ASOF } from './helpers.js';

let t;
let ids;
before(() => { t = tempDb(); seedFixture(t.db); ids = buildEvidencePacket(t.db, FIX_DS, FIX_SYM, FIX_ASOF).evidenceIds; });
after(() => t.cleanup());

const run = (provider, extra = {}) => runLensAssessments(t.db, provider, { session_id: extra.session_id ?? `r-${Math.random()}`, ds: FIX_DS, sym: FIX_SYM, asOf: FIX_ASOF, ...extra });
// A mis-cited answer (unknown evidence id) is INVALID_OUTPUT material.
const bad = (lens) => okResult({ ...lensOutput(lens, ids), evidence_refs: ['ev_000000000000000000000000'] });

test('an invalid first answer is re-asked once with its own validator errors; the repaired answer is OK', async () => {
  const seen = [];
  const provider = makeMockProvider(({ system, user }) => {
    const lens = lensOf(system);
    seen.push({ lens, repair: user.includes('VALIDATOR FEEDBACK'), user });
    const first = seen.filter((s) => s.lens === lens).length === 1;
    return lens === 'cowboy' && first ? bad(lens) : okResult(lensOutput(lens, ids));
  });
  const sid = 'repair-1';
  const r = await run(provider, { session_id: sid });
  const by = Object.fromEntries(r.results.map((x) => [x.lens, x]));
  assert.equal(by.cowboy.status, 'OK');
  assert.equal(by.cowboy.attempts, 2);
  assert.ok(by.cowboy.repairOf, 'repaired result points at the rejected attempt');
  assert.match(by.cowboy.firstAttemptError, /SEMANTIC_INVALID/);
  assert.equal(by.pragmatist.attempts, 1);
  assert.equal(by.tightwad.attempts, 1);
  // Only the cowboy repair call carried feedback, and it never contained another lens's output.
  const repairs = seen.filter((s) => s.repair);
  assert.deepEqual(repairs.map((s) => s.lens), ['cowboy']);
  // The repair carries the lens's own rejected answer (so the model edits it) plus its validator errors.
  assert.ok(repairs[0].user.includes('ev_000000000000000000000000'), 'rejected answer included');
  assert.match(repairs[0].user, /Problems found:\nSEMANTIC_INVALID/);
  const rows = listAssessments(t.db, { sym: FIX_SYM, session_id: sid });
  assert.equal(rows.length, 4, 'three lenses + one stored rejected attempt');
  assert.equal(rows.filter((x) => x.status === 'INVALID_OUTPUT').length, 1);
});

test('repair stops after the bound and the final status stays INVALID_OUTPUT', async () => {
  const provider = makeMockProvider(({ system }) => (lensOf(system) === 'tightwad' ? bad('tightwad') : okResult(lensOutput(lensOf(system), ids))));
  const r = await run(provider, { session_id: 'repair-2', repairAttempts: 1 });
  const tw = r.results.find((x) => x.lens === 'tightwad');
  assert.equal(tw.status, 'INVALID_OUTPUT');
  assert.equal(tw.attempts, 2);
});

test('repairAttempts 0 disables repair; no budget means no repair', async () => {
  const provider = makeMockProvider(({ system }) => bad(lensOf(system)));
  const r0 = await run(provider, { session_id: 'repair-3', repairAttempts: 0 });
  assert.ok(r0.results.every((x) => x.attempts === 1 && x.status === 'INVALID_OUTPUT'));
  // Cap of exactly 3 calls: the three first attempts fit, no repair may exceed it.
  const r1 = await run(provider, { session_id: 'repair-4', maxCalls: 3, repairAttempts: 2 });
  assert.ok(r1.results.every((x) => x.attempts === 1));
  assert.equal(listAssessments(t.db, { sym: FIX_SYM, session_id: 'repair-4' }).length, 3);
});
