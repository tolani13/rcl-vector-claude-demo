// TEST FIXTURE — NOT MARKET DATA. Independent lens assessments driven by a MOCK provider (test-only).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { runLensAssessments, buildEvidencePacket, proposalToIntentDraft, validateProposalDraft, listAssessments, countedCallsUsed } from '../../server/intel/assessments.js';
import { LENSES, systemPromptFor, checkLensSemantics, LENS_OUTPUT_SCHEMA } from '../../server/intel/prompts.js';
import { getProvider } from '../../server/intel/model-provider.js';
import { list as journalList, verifyChain } from '../../server/journal.js';
import { sha256Hex } from '../../server/util/ids.js';
import { MINUTE } from '../../server/util/time.js';
import {
  tempDb, seedFixture, makeMockProvider, lensOf, lensOutput, okResult, FIX_DS, FIX_SYM, FIX_ASOF,
} from './helpers.js';

let t;
before(() => { t = tempDb(); seedFixture(t.db); });
after(() => t.cleanup());

const run = (provider, extra = {}) => runLensAssessments(t.db, provider, { session_id: extra.session_id ?? `s-${Math.random()}`, ds: FIX_DS, sym: FIX_SYM, asOf: FIX_ASOF, ...extra });
const rowsFor = (session_id) => t.db.prepare('SELECT * FROM assessments WHERE session_id = ? ORDER BY lens').all(session_id);

test('three lenses: separate calls, identical packet, distinct system prompts, no cross-lens leakage', async () => {
  const packet = buildEvidencePacket(t.db, FIX_DS, FIX_SYM, FIX_ASOF);
  const marker = (lens) => `UNIQUE-${lens.toUpperCase()}-OUTPUT-MARKER`;
  const mock = makeMockProvider((req) => {
    const lens = lensOf(req.system);
    return okResult(lensOutput(lens, packet.evidenceIds, { thesis: `${marker(lens)} [${packet.evidenceIds[0]}]` }));
  });
  const res = await run(mock, { session_id: 'indep' });
  assert.equal(res.status, 'COMPLETED');
  assert.equal(mock.calls.length, 3);
  assert.deepEqual(mock.calls.map((c) => lensOf(c.system)), LENSES);
  // Identical user message (the packet) for every lens; its hash is the stored packet hash.
  const users = new Set(mock.calls.map((c) => c.user));
  assert.equal(users.size, 1);
  assert.equal(sha256Hex(mock.calls[0].user), packet.sha256);
  assert.equal(res.packet_sha256, packet.sha256);
  // Distinct lens prompts; same output schema.
  assert.equal(new Set(mock.calls.map((c) => c.system)).size, 3);
  for (const c of mock.calls) assert.deepEqual(c.schema, JSON.parse(JSON.stringify(LENS_OUTPUT_SCHEMA)));
  // No call contains any other lens's output.
  for (const c of mock.calls) {
    for (const l of LENSES) assert.ok(!JSON.stringify(c).includes(marker(l)), `call for ${lensOf(c.system)} saw ${l}'s output`);
  }
  const rows = rowsFor('indep');
  assert.equal(rows.length, 3);
  assert.equal(new Set(rows.map((r) => r.packet_sha256)).size, 1);
  assert.equal(rows[0].packet_sha256, packet.sha256);
  for (const r of rows) assert.deepEqual(JSON.parse(r.evidence_ids_json), packet.evidenceIds);
});

test('lens outputs are stored separately and disagreement is preserved (no averaging or voting)', async () => {
  const packet = buildEvidencePacket(t.db, FIX_DS, FIX_SYM, FIX_ASOF);
  const stance = { cowboy: 'consider_entry', pragmatist: 'watch', tightwad: 'avoid' };
  const level = { cowboy: 'medium', pragmatist: 'low', tightwad: 'high' };
  const mock = makeMockProvider((req) => {
    const lens = lensOf(req.system);
    return okResult(lensOutput(lens, packet.evidenceIds, { stance: stance[lens], confidence: { level: level[lens], calibration_note: 'TEST MOCK' } }));
  });
  const res = await run(mock, { session_id: 'disagree' });
  assert.deepEqual(res.stances, stance);
  for (const k of ['average', 'consensus', 'vote', 'majority', 'aggregate', 'score']) assert.ok(!(k in res), `unexpected aggregate field ${k}`);
  const rows = rowsFor('disagree');
  assert.deepEqual(Object.fromEntries(rows.map((r) => [r.lens, JSON.parse(r.output_json).stance])), stance);
  assert.deepEqual(Object.fromEntries(rows.map((r) => [r.lens, JSON.parse(r.output_json).confidence.level])), level);
  assert.ok(rows.every((r) => r.status === 'OK'));
  const listed = listAssessments(t.db, { sym: FIX_SYM, session_id: 'disagree' });
  assert.equal(listed.length, 3);
  assert.equal(new Set(listed.map((r) => r.output.stance)).size, 3);
  // Each assessment is journaled; the hash chain stays valid.
  assert.equal(journalList(t.db, { session_id: 'disagree', type: 'MODEL_ASSESSMENT' }).length, 3);
  assert.equal(verifyChain(t.db).ok, true);
});

test('invalid model output is INVALID_OUTPUT, never stored as OK', async () => {
  const packet = buildEvidencePacket(t.db, FIX_DS, FIX_SYM, FIX_ASOF);
  const mock = makeMockProvider((req) => {
    const lens = lensOf(req.system);
    if (lens === 'cowboy') return { ok: false, json: null, rawText: '{not json', refusal: null, usage: { in: 1, out: 1 }, latencyMs: 1, error: 'INVALID_JSON: Unexpected token', errorKind: 'INVALID_OUTPUT' };
    if (lens === 'pragmatist') {
      // Provider claims ok but the object violates the lens schema (missing fields, extra field).
      return okResult({ lens, stance: 'watch', thesis: 'x', bogus: true });
    }
    // Tightwad cites an evidence id that is not in the packet (fabricated reference).
    return okResult(lensOutput(lens, packet.evidenceIds, { evidence_refs: ['ev_fabricated000000000000'] }));
  });
  const res = await run(mock, { session_id: 'invalid' });
  assert.deepEqual(res.results.map((r) => r.status), ['INVALID_OUTPUT', 'INVALID_OUTPUT', 'INVALID_OUTPUT']);
  const rows = rowsFor('invalid');
  assert.ok(rows.every((r) => r.status === 'INVALID_OUTPUT' && r.output_json === null && r.error));
  assert.match(rows.find((r) => r.lens === 'tightwad').error, /not an id in the evidence packet/);
  assert.match(rows.find((r) => r.lens === 'pragmatist').error, /unexpected property|required/);
});

test('refusal is REFUSED; provider failures and timeouts are ERROR', async () => {
  const mock = makeMockProvider((req) => {
    const lens = lensOf(req.system);
    if (lens === 'cowboy') return { ok: false, json: null, rawText: null, refusal: { category: 'test_category', explanation: 'TEST MOCK refusal' }, usage: {}, latencyMs: 1, error: 'REFUSED', errorKind: 'REFUSAL' };
    if (lens === 'pragmatist') throw new Error('TEST MOCK provider crash');
    return new Promise(() => {}); // never resolves -> per-call timeout
  });
  const res = await run(mock, { session_id: 'refuse', timeoutMs: 50, timeoutGraceMs: 0 });
  const by = Object.fromEntries(res.results.map((r) => [r.lens, r]));
  assert.equal(by.cowboy.status, 'REFUSED');
  assert.match(by.cowboy.error, /test_category/);
  assert.equal(by.pragmatist.status, 'ERROR');
  assert.match(by.pragmatist.error, /PROVIDER_EXCEPTION/);
  assert.equal(by.tightwad.status, 'ERROR');
  assert.match(by.tightwad.error, /TIMEOUT/);
  assert.ok(rowsFor('refuse').every((r) => r.output_json === null));
});

test('call cap is enforced per session (all-or-nothing per run, no provider call when exceeded)', async () => {
  const packet = buildEvidencePacket(t.db, FIX_DS, FIX_SYM, FIX_ASOF);
  const mock = makeMockProvider((req) => okResult(lensOutput(lensOf(req.system), packet.evidenceIds)));
  const first = await run(mock, { session_id: 'cap', maxCalls: 4 });
  assert.equal(first.status, 'COMPLETED');
  assert.equal(mock.calls.length, 3);
  const second = await run(mock, { session_id: 'cap', maxCalls: 4 });
  assert.equal(second.status, 'CALL_CAP_REACHED');
  assert.equal(second.note, 'ASSESSMENT_NOT_RUN');
  assert.equal(mock.calls.length, 3, 'provider must not be called once the cap would be exceeded');
  assert.equal(rowsFor('cap').length, 3);
  // A single remaining lens still fits.
  const third = await run(mock, { session_id: 'cap', maxCalls: 4, lenses: ['tightwad'] });
  assert.equal(third.status, 'COMPLETED');
  assert.equal(mock.calls.length, 4);
  // Environment cap (default source) is honoured too.
  const prev = process.env.VECTOR_MAX_MODEL_CALLS_PER_SESSION;
  process.env.VECTOR_MAX_MODEL_CALLS_PER_SESSION = '2';
  try {
    const envRun = await run(mock, { session_id: 'cap-env' });
    assert.equal(envRun.status, 'CALL_CAP_REACHED');
    assert.equal(mock.calls.length, 4);
  } finally {
    if (prev === undefined) delete process.env.VECTOR_MAX_MODEL_CALLS_PER_SESSION; else process.env.VECTOR_MAX_MODEL_CALLS_PER_SESSION = prev;
  }
  // Concurrent runs cannot overshoot the cap.
  const slow = makeMockProvider(async (req) => { await new Promise((r) => setTimeout(r, 20)); return okResult(lensOutput(lensOf(req.system), packet.evidenceIds)); });
  const [a, b] = await Promise.all([run(slow, { session_id: 'cap-conc', maxCalls: 3 }), run(slow, { session_id: 'cap-conc', maxCalls: 3 })]);
  assert.deepEqual([a.status, b.status].sort(), ['CALL_CAP_REACHED', 'COMPLETED']);
  assert.equal(rowsFor('cap-conc').length, 3);
});

test('disconnected provider: MODEL_DISCONNECTED, no rows, no calls', async () => {
  const none = getProvider({ provider: 'none' }, null, { env: {}, file: 'nonexistent-model-config.json' });
  const res = await run(none, { session_id: 'none' });
  assert.equal(res.status, 'MODEL_DISCONNECTED');
  assert.match(res.note, /ASSESSMENT NOT RUN/);
  assert.equal(rowsFor('none').length, 0);
  const noData = await run(makeMockProvider(() => { throw new Error('must not be called'); }), { session_id: 'nodata', sym: 'QQNONE' });
  assert.equal(noData.status, 'NO_VERIFIED_DATA');
});

test('proposed_intent becomes a typed TradeIntent draft (u prices) validated like an agent intent', async () => {
  const packet = buildEvidencePacket(t.db, FIX_DS, FIX_SYM, FIX_ASOF);
  const proposal = {
    action: 'open', side: 'buy', order_type: 'limit', budget_usd: 50, qty: null, limit_px_usd: 0.459, stop_px_usd: null,
    stop_loss_px_usd: 0.44, take_profit_px_usd: 0.5, time_exit_min: 30, expires_in_min: 10,
    rationale: 'TEST MOCK rationale', evidence_refs: [packet.evidenceIds[0]],
  };
  const mock = makeMockProvider((req) => {
    const lens = lensOf(req.system);
    return okResult(lensOutput(lens, packet.evidenceIds, lens === 'cowboy' ? { stance: 'consider_entry', proposed_intent: proposal } : {}));
  });
  const res = await run(mock, { session_id: 'intent' });
  const cow = res.results.find((r) => r.lens === 'cowboy');
  assert.equal(cow.status, 'OK');
  // A well-formed proposal validates (the draft envelope carries a placeholder agent id, never null).
  assert.equal(cow.intent.status, 'VALID', JSON.stringify(cow.intent.errors));
  assert.deepEqual(cow.intent.errors, []);
  const draft = cow.intent.intent;
  assert.equal(draft.source, 'model');
  assert.equal(draft.agent_id, 'draft:cowboy');
  assert.equal(draft.portfolio_id, 'cowboy-micro');
  assert.deepEqual(draft.instrument, { kind: 'equity', sym: FIX_SYM });
  assert.equal(draft.limit_px_u, 4590);
  assert.deepEqual(draft.attach, { stop_loss_px_u: 4400, take_profit_px_u: 5000, time_exit_min: 30 });
  assert.equal(draft.created_ts, FIX_ASOF);
  assert.equal(draft.expires_ts, FIX_ASOF + 10 * MINUTE);
  assert.ok(draft.quote_ts <= FIX_ASOF);
  assert.equal(res.results.find((r) => r.lens === 'tightwad').intent.status, 'NONE');
  // The draft is journaled, not submitted: no orders were created.
  assert.equal(t.db.prepare('SELECT COUNT(*) n FROM orders').get().n, 0);
  const j = journalList(t.db, { session_id: 'intent', type: 'MODEL_ASSESSMENT' }).find((r) => r.ref_id === cow.assessment_id);
  assert.equal(j.payload.intent_draft.limit_px_u, 4590);
  assert.equal(j.payload.intent_status, 'VALID');
  // The verdict is returned with stored assessments (GET /api/assessments reads listAssessments).
  const listed = listAssessments(t.db, { sym: FIX_SYM, session_id: 'intent' }).find((r) => r.id === cow.assessment_id);
  assert.equal(listed.audit.intent_status, 'VALID');
  assert.deepEqual(listed.audit.intent_errors, []);
  // A real defect is the ONLY error reported (no bogus agent_id error).
  const bad = validateProposalDraft({ ...proposal, stop_px_usd: 0.44 }, { lens: 'cowboy', segment: 'micro', sym: FIX_SYM, asOf: FIX_ASOF, quoteTs: FIX_ASOF - 1000 });
  assert.equal(bad.status, 'INVALID');
  assert.deepEqual(bad.errors, ['stop_px_u not allowed for limit']);
  // Without an as-of quote time the draft fails for that real reason.
  const noQuote = validateProposalDraft(proposal, { lens: 'cowboy', segment: 'micro', sym: FIX_SYM, asOf: FIX_ASOF, quoteTs: null });
  assert.deepEqual(noQuote.errors, ['quote_ts must be an integer ms timestamp']);
  // Pure conversion: nulls are omitted, not invented.
  const d2 = proposalToIntentDraft({ ...proposal, order_type: 'market', limit_px_usd: null, take_profit_px_usd: null, time_exit_min: null },
    { lens: 'tightwad', segment: 'large', sym: FIX_SYM, asOf: FIX_ASOF, quoteTs: FIX_ASOF - 1000 });
  assert.equal('limit_px_u' in d2, false);
  assert.deepEqual(d2.attach, { stop_loss_px_u: 4400 });
  assert.equal(d2.portfolio_id, 'tightwad-large');
});

test('a supplied preview packet is persisted before use and must match the request', async () => {
  const asOf = FIX_ASOF + 2 * MINUTE; // fresh as-of so nothing is stored yet
  const preview = buildEvidencePacket(t.db, FIX_DS, FIX_SYM, asOf, { persist: false });
  const has = (id) => !!t.db.prepare('SELECT 1 FROM evidence WHERE id = ?').get(id);
  // Evidence ids are content-addressed: as-of-independent items (identity, short volume, macro) may already be stored by
  // earlier tests, so the precondition is that the as-of-specific items are not yet stored.
  assert.ok(preview.evidenceIds.some((id) => !has(id)));
  const mock = makeMockProvider((req) => okResult(lensOutput(lensOf(req.system), preview.evidenceIds)));
  const res = await run(mock, { session_id: 'preview', asOf, packet: preview });
  assert.equal(res.status, 'COMPLETED');
  assert.ok(preview.evidenceIds.every(has), 'evidence referenced by assessments must be stored');
  await assert.rejects(run(mock, { session_id: 'preview2', asOf: FIX_ASOF, packet: preview }), /does not match/);
});

test('semantic checks reject proposals without exits or with a non-entry stance', () => {
  const ids = ['ev_a'];
  const base = lensOutput('cowboy', ids);
  const p = {
    action: 'open', side: 'buy', order_type: 'market', budget_usd: 5, qty: null, limit_px_usd: null, stop_px_usd: null,
    stop_loss_px_usd: null, take_profit_px_usd: null, time_exit_min: null, expires_in_min: 5, rationale: 'r', evidence_refs: ids,
  };
  assert.deepEqual(checkLensSemantics(base, { lens: 'cowboy', evidenceIds: ids }), []);
  const noExits = checkLensSemantics({ ...base, stance: 'consider_entry', proposed_intent: p }, { lens: 'cowboy', evidenceIds: ids });
  assert.ok(noExits.some((e) => /stop_loss_px_usd: required/.test(e)));
  assert.ok(noExits.some((e) => /needs take_profit_px_usd or time_exit_min/.test(e)));
  assert.ok(checkLensSemantics({ ...base, stance: 'watch', proposed_intent: { ...p, stop_loss_px_usd: 1 } }, { lens: 'cowboy', evidenceIds: ids }).some((e) => /only allowed with stance consider_entry/.test(e)));
  assert.ok(checkLensSemantics({ ...base, lens: 'tightwad' }, { lens: 'cowboy', evidenceIds: ids }).some((e) => /\$\.lens/.test(e)));
  assert.ok(checkLensSemantics({ ...base, evidence_refs: [] }, { lens: 'cowboy', evidenceIds: ids }).some((e) => /must cite/.test(e)));
  assert.deepEqual(checkLensSemantics({ ...base, stance: 'insufficient_evidence', evidence_refs: [], thesis: 'TEST MOCK thesis, nothing cited' }, { lens: 'cowboy', evidenceIds: ids }), []);
});

test('lens prompts are distinct and carry the shared evidence rules', () => {
  const prompts = LENSES.map(systemPromptFor);
  assert.equal(new Set(prompts).size, 3);
  assert.match(prompts[0], /MAXIMUM PLAUSIBLE UPSIDE/);
  assert.match(prompts[0], /bounded/);
  assert.match(prompts[1], /risk-adjusted/);
  assert.match(prompts[1], /financing/);
  assert.match(prompts[2], /risk even \$5/);
  assert.match(prompts[2], /reasons to abstain/i);
  for (const s of prompts) {
    assert.match(s, /Use ONLY the evidence packet/);
    assert.match(s, /never invent/i);
    assert.match(s, /insufficient_evidence/);
    assert.match(s, /IEX-ONLY/);
    assert.match(s, /PAPER-ONLY/);
    assert.match(s, /Calibrate confidence/);
    assert.match(s, /unknowns/);
  }
  assert.throws(() => systemPromptFor('oracle'), /unknown lens/);
});

test('a FAULT provider (bad configuration) maps to FAULT, not MODEL_DISCONNECTED; no rows, no calls', async () => {
  const bogus = getProvider({ provider: 'not-a-provider' }, null, { env: {}, file: 'nonexistent-model-config.json' });
  assert.equal(bogus.kind, 'none');
  const res = await run(bogus, { session_id: 'fault' });
  assert.equal(res.status, 'FAULT');
  assert.equal(res.note, 'ASSESSMENT_NOT_RUN');
  assert.match(res.detail, /unknown VECTOR_MODEL_PROVIDER "not-a-provider"/);
  assert.deepEqual(res.results, []);
  assert.equal(rowsFor('fault').length, 0);
  // A provider whose status() throws is still treated as disconnected, never as a crash.
  const broken = { id: 'x', kind: 'none', model: null, async status() { throw new Error('TEST MOCK'); }, async complete() { throw new Error('must not be called'); } };
  assert.equal((await run(broken, { session_id: 'fault2' })).status, 'MODEL_DISCONNECTED');
});

test('per-lens errorKind; failures that never reached a model do not count against the caps; NETWORK short-circuits the run', async () => {
  const packet = buildEvidencePacket(t.db, FIX_DS, FIX_SYM, FIX_ASOF);
  // CONFIG (e.g. CONTEXT_OVERFLOW) on every lens: three audit rows, zero counted calls.
  const overflow = makeMockProvider(() => ({ ok: false, json: null, rawText: null, refusal: null, usage: {}, latencyMs: 0, error: 'CONTEXT_OVERFLOW: TEST MOCK', errorKind: 'CONFIG' }));
  const a = await run(overflow, { session_id: 'notsent', maxCalls: 3 });
  assert.equal(a.status, 'COMPLETED');
  assert.deepEqual(a.results.map((r) => [r.status, r.errorKind]), [['ERROR', 'CONFIG'], ['ERROR', 'CONFIG'], ['ERROR', 'CONFIG']]);
  assert.equal(rowsFor('notsent').length, 3);
  assert.ok(rowsFor('notsent').every((r) => /^CONFIG: CONTEXT_OVERFLOW/.test(r.error)));
  // The cap of 3 is still fully available: a real run goes through.
  const good = makeMockProvider((req) => okResult(lensOutput(lensOf(req.system), packet.evidenceIds)));
  const b = await run(good, { session_id: 'notsent', maxCalls: 3 });
  assert.equal(b.status, 'COMPLETED');
  assert.deepEqual(b.results.map((r) => r.errorKind), [null, null, null]);
  assert.equal(good.calls.length, 3);
  // ...and now it is used up.
  assert.equal((await run(good, { session_id: 'notsent', maxCalls: 3 })).status, 'CALL_CAP_REACHED');
  // NETWORK on the first lens: the remaining lenses are not called and store nothing.
  const down = makeMockProvider(() => ({ ok: false, json: null, rawText: null, refusal: null, usage: {}, latencyMs: 1, error: 'request failed: ECONNREFUSED', errorKind: 'NETWORK' }));
  const c = await run(down, { session_id: 'net' });
  assert.equal(c.status, 'COMPLETED');
  assert.equal(down.calls.length, 1, 'only the first lens was attempted');
  assert.deepEqual(c.results.map((r) => [r.lens, r.status, r.errorKind]), [['cowboy', 'ERROR', 'NETWORK'], ['pragmatist', 'ERROR', 'NOT_RUN'], ['tightwad', 'ERROR', 'NOT_RUN']]);
  assert.match(c.results[1].error, /^NOT_RUN: not called after a NETWORK failure/);
  assert.equal(c.results[1].assessment_id, null);
  assert.equal(rowsFor('net').length, 1);
  // NETWORK may follow a completion the endpoint already produced (e.g. the body dropped mid-read): it COUNTS against the
  // caps; only CONNECT (refused before any response) is audit-only. Both short-circuit the run.
  const dropped = makeMockProvider(() => ({ ok: false, json: null, rawText: null, refusal: null, usage: {}, latencyMs: 1, error: 'response body read failed: terminated', errorKind: 'NETWORK' }));
  const refusedConn = makeMockProvider(() => ({ ok: false, json: null, rawText: null, refusal: null, usage: {}, latencyMs: 1, error: 'request failed: ECONNREFUSED', errorKind: 'CONNECT' }));
  // maxCalls 4: each run reserves 3 lens calls (all-or-nothing); one counted NETWORK row per run => the third run is refused.
  for (let i = 0; i < 3; i++) assert.equal((await run(dropped, { session_id: 'netcount', maxCalls: 4 })).status, i < 2 ? 'COMPLETED' : 'CALL_CAP_REACHED', `run ${i}`);
  assert.equal(rowsFor('netcount').length, 2, 'two counted NETWORK rows');
  for (let i = 0; i < 3; i++) {
    const r = await run(refusedConn, { session_id: 'connfree', maxCalls: 3 });
    assert.equal(r.status, 'COMPLETED', `CONNECT failures never use the cap (run ${i})`);
    assert.deepEqual(r.results.map((x) => x.errorKind), ['CONNECT', 'NOT_RUN', 'NOT_RUN']);
  }
  assert.equal(countedCallsUsed(t.db, 'connfree'), 0);
  assert.equal(countedCallsUsed(t.db, 'netcount'), 2);
  // Other per-lens kinds are reported as-is (refusal, invalid output, timeout).
  const mixed = makeMockProvider((req) => {
    const lens = lensOf(req.system);
    if (lens === 'cowboy') return { ok: false, json: null, rawText: null, refusal: { category: null, explanation: 'TEST MOCK' }, usage: {}, latencyMs: 1, error: 'REFUSED', errorKind: 'REFUSAL' };
    if (lens === 'pragmatist') return okResult(lensOutput(lens, ['ev_not_in_packet']));
    return { ok: false, json: null, rawText: null, refusal: null, usage: {}, latencyMs: 1, error: 'no response', errorKind: 'TIMEOUT' };
  });
  const d = await run(mixed, { session_id: 'mixed', repairAttempts: 0 }); // repair is covered in repair.test.js
  assert.deepEqual(d.results.map((r) => [r.status, r.errorKind]), [['REFUSED', 'REFUSAL'], ['INVALID_OUTPUT', 'INVALID_OUTPUT'], ['ERROR', 'TIMEOUT']]);
  assert.equal(mixed.calls.length, 3);
  // The journal records the kind too.
  const kinds = journalList(t.db, { session_id: 'mixed', type: 'MODEL_ASSESSMENT' }).map((j) => j.payload.error_kind);
  assert.deepEqual(kinds.sort(), ['INVALID_OUTPUT', 'REFUSAL', 'TIMEOUT']);
});
