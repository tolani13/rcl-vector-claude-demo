// Round-2 web features (DOM-free logic): journal session scope + server-side scan exclusion, replay reset strategy
// option, PARTIAL dataset / model-running status, assessment audit badges, cited-evidence lookup, one-run lens panel,
// opportunity horizon / instrument options and server security types.
// TEST FIXTURE — NOT MARKET DATA: every symbol, id, time and value below is invented to exercise software behaviour.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { journalParams, rowFlags, SESSION_SCOPES } from '../../web/js/views/journal.js';
import { resetRequestBody, strategyOutcome, RESET_PRESETS_FIELD } from '../../web/js/views/replay.js';
import { normAssessments, runKeyOf, dossierName } from '../../web/js/views/research.js';
import {
  oppParams, windowPref, instrumentsPref, instrumentNote, nameText, normOpp, HORIZON_MINUTES, DEFAULT_WINDOW_MIN, INSTRUMENT_CHOICES,
} from '../../web/js/views/common.js';
import { isUnknownParam } from '../../web/js/components.js';
import {
  datasetCoverage, modelActivity, assessmentAudit, evidenceLookupIds, evidenceResult, EVIDENCE_LOOKUP_MAX,
} from '../../web/js/summaries.js';
import { securityTypeOf } from '../../web/js/format.js';
import { INSTRUMENT_FILTERS } from '../../server/research/scanner.js';

const FIXTURE = 'TEST FIXTURE — NOT MARKET DATA';
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');
const T0 = Date.UTC(2026, 0, 2, 14, 30); // invented session open
const MIN = 60000;
const ev = (n) => `ev_${String(n).repeat(24).slice(0, 24)}`; // valid evidence-id shape, invented

// ---------------------------------------------------------------- journal

test('journal query: session scope is explicit and scans are excluded server-side only when no type is selected', () => {
  assert.deepEqual(SESSION_SCOPES.map(([v]) => v), ['current', 'all']);
  assert.equal(journalParams({}).session_id, 'current');
  assert.equal(journalParams({ session: 'all' }).session_id, 'all');
  assert.equal(journalParams({ session: 'anything-else' }).session_id, 'current', 'unknown scope falls back to the current session');
  assert.equal(journalParams({ hideScans: true }).exclude_type, 'AGENT_SCAN');
  assert.equal(journalParams({ hideScans: false }).exclude_type, undefined);
  assert.equal(journalParams({ hideScans: true, type: 'AGENT_SCAN' }).exclude_type, undefined, 'an explicit AGENT_SCAN filter shows scans');
  assert.equal(journalParams({ hideScans: true, type: 'POLICY_DENY' }).exclude_type, undefined, 'a type filter already selects one type');
  assert.equal(journalParams({ hideScans: true, serverExclude: false }).exclude_type, undefined, 'older API: no exclude_type sent');
  assert.equal(journalParams({ hideScans: true }).hindsight, undefined, 'hindsight is never requested');
  const p = journalParams({ portfolio_id: 'sandbox', limit: '50', before: 120 });
  assert.equal(p.portfolio_id, 'sandbox');
  assert.equal(p.before, 120);
});

test('journal rows: prior-session and hindsight flags come from the server (session id as fallback)', () => {
  assert.deepEqual(rowFlags({ prior_session: true, hindsight: false }, 'sess_a'), { prior: true, hindsight: false });
  assert.deepEqual(rowFlags({ prior_session: false, session_id: 'sess_b' }, 'sess_a'), { prior: false, hindsight: false }, 'the server flag wins');
  assert.deepEqual(rowFlags({ session_id: 'sess_b' }, 'sess_a'), { prior: true, hindsight: false });
  assert.deepEqual(rowFlags({ session_id: 'sess_a' }, 'sess_a'), { prior: false, hindsight: false });
  assert.deepEqual(rowFlags({ session_id: 'sess_b' }, null), { prior: false, hindsight: false }, 'unknown current session: no guess');
  assert.equal(rowFlags({ hindsight: true }, 'sess_a').hindsight, true);
  assert.deepEqual(rowFlags(null, 'sess_a'), { prior: false, hindsight: false });
});

test('an older API that rejects an optional parameter is detected precisely (400 UNKNOWN_FIELD naming it)', () => {
  const res = (status, code, message) => ({ ok: false, status, error: { code, message } });
  assert.equal(isUnknownParam(res(400, 'UNKNOWN_FIELD', 'unknown query field(s): exclude_type'), 'exclude_type'), true);
  assert.equal(isUnknownParam(res(400, 'UNKNOWN_FIELD', 'unknown query field(s): windowMin, instruments'), 'instruments'), true);
  assert.equal(isUnknownParam(res(400, 'UNKNOWN_FIELD', 'unknown query field(s): windowMin'), 'instruments'), false);
  assert.equal(isUnknownParam(res(400, 'TYPE_INVALID', 'exclude_type bad'), 'exclude_type'), false);
  assert.equal(isUnknownParam(res(404, 'UNKNOWN_FIELD', 'exclude_type'), 'exclude_type'), false);
  assert.equal(isUnknownParam({ ok: true, status: 200 }, 'exclude_type'), false);
  assert.equal(isUnknownParam(null), false);
});

// ---------------------------------------------------------------- replay reset

test('replay reset: strategies are carried unless "Restore preset strategies" is ticked', () => {
  assert.deepEqual(resetRequestBody({ ds: 'ds_fixture', startingCashU: 100000000 }), { ds: 'ds_fixture', startingCashU: 100000000 });
  assert.deepEqual(resetRequestBody({ ds: 'ds_fixture', startingCashU: 100000000, restorePresets: true }),
    { ds: 'ds_fixture', startingCashU: 100000000, [RESET_PRESETS_FIELD]: true });
});

test('replay reset: the presets field is one the server postReset accepts (contract with server/api/replay.js)', () => {
  const src = fs.readFileSync(path.join(root, 'server', 'api', 'replay.js'), 'utf8');
  const m = src.match(/export function postReset[\s\S]*?onlyKeys\(body,\s*\[([^\]]*)\]/);
  assert.ok(m, 'postReset validates its body keys with onlyKeys');
  const keys = [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
  assert.ok(keys.includes(RESET_PRESETS_FIELD), `postReset accepts ${RESET_PRESETS_FIELD} (accepted: ${keys.join(', ')})`);
  assert.ok(keys.includes('ds') && keys.includes('startingCashU'));
});

test('replay reset: the outcome line counts carried / preset strategies and lists fallbacks with the server reason', () => {
  const data = { [RESET_PRESETS_FIELD]: false, strategies: [
    { agent_id: 'agent-cowboy-micro', strategy_source: 'carried' },
    { agent_id: 'agent-tightwad-large', strategy_source: 'preset', note: `stored strategy not reusable (segment micro != large); preset applied (${FIXTURE})` },
    { agent_id: 'agent-pragmatist-micro', strategy_source: 'preset', note: 'no existing agent (first session)' },
  ] };
  const o = strategyOutcome(data);
  assert.equal(o.total, 3);
  assert.equal(o.carried, 1);
  assert.equal(o.preset, 2);
  assert.deepEqual(o.fallbacks.map((f) => f.agent_id), ['agent-tightwad-large'], 'a first-session preset is not a fallback');
  const restored = strategyOutcome({ [RESET_PRESETS_FIELD]: true, strategies: [{ agent_id: 'a', strategy_source: 'preset', note: 'restorePresets requested' }] });
  assert.equal(restored.restored, true);
  assert.equal(restored.fallbacks.length, 0);
  assert.equal(strategyOutcome(null).total, 0);
});

// ---------------------------------------------------------------- status strip

test('PARTIAL dataset: replay/data complete:false, truncated or a partial dataset status; the end time only when reported', () => {
  const end = T0 + 191 * MIN;
  // GET /api/status shape: replay.{complete, coverage_end, truncated, beyondCoverage, truncation_note} + data.dataset.{status, complete, coverage_end}
  const st = {
    data: { mode: 'HISTORICAL_REAL', modeDetail: `PARTIAL dataset (${FIXTURE})`, dataset: { status: 'partial', complete: false, coverage_end: end } },
    replay: { complete: false, coverage_end: end, truncated: true, beyondCoverage: false, truncation_note: `DATASET_TRUNCATED (${FIXTURE})` },
  };
  assert.deepEqual(datasetCoverage(st), { partial: true, truncated: true, endMs: end, beyond: false, detail: `DATASET_TRUNCATED (${FIXTURE})` });
  assert.equal(datasetCoverage({ ...st, replay: { ...st.replay, beyondCoverage: true } }).beyond, true);
  assert.deepEqual(datasetCoverage({ data: { mode: 'HISTORICAL_REAL', complete: false, coverage_end: end } }),
    { partial: true, truncated: false, endMs: end, beyond: false, detail: null });
  assert.equal(datasetCoverage({ data: { dataset: { complete: false, coverage_end: end } } }).endMs, end, 'dataset coverage end when the replay has none');
  assert.deepEqual(datasetCoverage({ data: { dataset: { status: 'partial' } } }), { partial: true, truncated: false, endMs: null, beyond: false, detail: null });
  const ok = datasetCoverage({
    data: { mode: 'HISTORICAL_REAL', modeDetail: 'complete replay', dataset: { status: 'complete', complete: true, coverage_end: null } },
    replay: { complete: true, coverage_end: null, truncated: false, beyondCoverage: false, truncation_note: null },
  });
  assert.deepEqual(ok, { partial: false, truncated: false, endMs: null, beyond: false, detail: null }, 'a complete dataset shows no PARTIAL chip and no end time');
  assert.equal(datasetCoverage(null).partial, false);
});

test('model running: status.model.running plus inFlight progress and the last run outcome', () => {
  const base = { assessment: null, last: null };
  assert.deepEqual(modelActivity({ running: true }), { running: true, kinds: [], assess: false, ...base });
  assert.deepEqual(modelActivity({ running: false, inFlight: { assessment: null, modelTest: null, agentCalls: 0 } }), { running: false, kinds: [], assess: false, ...base });
  const a = modelActivity({ running: true, inFlight: { assessment: { run_id: 'arun_fx', sym: 'ZVZZT', asOf: T0, mode: 'async', startedAt: 1, elapsedMs: 42000, lensesDone: 1, lensesTotal: 3 }, modelTest: null, agentCalls: 2 } });
  assert.deepEqual(a.kinds, ['assessment', 'agent model call']);
  assert.equal(a.assess, true);
  assert.deepEqual(a.assessment, { runId: 'arun_fx', sym: 'ZVZZT', lensesDone: 1, lensesTotal: 3, elapsedMs: 42000, previousSession: false });
  const prev = modelActivity({ running: true, inFlight: { assessment: { run_id: 'arun_old', previousSession: true, startedAt: 1, elapsedMs: 5 }, modelTest: null, agentCalls: 0 } });
  assert.equal(prev.assessment.previousSession, true);
  assert.equal(prev.assessment.sym, null, 'a run from a previous session has no visible details');
  assert.deepEqual(modelActivity({ running: true, inFlight: { assessment: null, modelTest: { startedAt: 1, elapsedMs: 2 }, agentCalls: 0 } }).kinds, ['model test']);
  const last = { run_id: 'arun_fx', status: 'NOT_RUN', code: 'CALL_CAP_REACHED', detail: FIXTURE };
  assert.deepEqual(modelActivity({ running: false, lastAssessmentRun: last }).last, last);
  // other accepted shapes
  assert.deepEqual(modelActivity({ running: { assess: true, modelTest: false } }).kinds, ['assessment']);
  assert.equal(modelActivity({ running: 2 }).running, true);
  assert.equal(modelActivity({ running: 0 }).running, false);
  assert.equal(modelActivity({ status: 'CONNECTED' }).running, false, 'absent field: not running');
  assert.equal(modelActivity(null).running, false);
});

test('assessment runs start in the background (async) and fall back to the synchronous call on an older API', () => {
  const src = fs.readFileSync(path.join(root, 'web', 'js', 'views', 'research.js'), 'utf8');
  assert.match(src, /api\.post\('\/api\/assessments\/run', \{ sym, confirm: true, async: true \}\)/);
  assert.match(src, /isUnknownParam\(res, 'async'\)/);
  const intel = fs.readFileSync(path.join(root, 'server', 'api', 'intel.js'), 'utf8');
  assert.match(intel, /onlyKeys\(body, \[[^\]]*'async'[^\]]*\]\)/, 'the server accepts async on POST /api/assessments/run');
});

// ---------------------------------------------------------------- assessment audit

test('assessment audit: hindsight risk, fallback, draft verdict and number check are read, never inferred', () => {
  const a = { audit: {
    hindsight: { hindsight_risk: true, code: 'REPLAY_BEFORE_MODEL_CUTOFF', model_training_cutoff: '2026-03-01', cutoff_source: 'configured', margin_days: 30, trade_date: '2026-01-02' },
    fallback_used: true, requested_model: 'fixture-model-a', served_model: 'fixture-model-b',
    intent_status: 'INVALID', intent_errors: ['stop_loss_px_u must be below the bid'], intent_draft: { side: 'buy', qty: 10 },
    verification: { checked: true, numbers_checked: 7, unmatched: [{ field: 'thesis', value: '0.4321' }], flags: [`tight spread claim (${FIXTURE})`] },
  } };
  const au = assessmentAudit(a);
  assert.deepEqual(au.hindsight, { code: 'REPLAY_BEFORE_MODEL_CUTOFF', cutoff: '2026-03-01', source: 'configured', tradeDate: '2026-01-02', marginDays: 30 });
  assert.deepEqual(au.fallback, { requested: 'fixture-model-a', served: 'fixture-model-b' });
  assert.equal(au.draft.status, 'INVALID');
  assert.deepEqual(au.draft.errors, ['stop_loss_px_u must be below the bid']);
  assert.deepEqual(au.draft.intent, { side: 'buy', qty: 10 });
  assert.equal(au.verification.numbersChecked, 7);
  assert.deepEqual(au.verification.unmatched, [{ field: 'thesis', value: '0.4321' }]);
  assert.equal(au.verification.flags.length, 1);

  const none = assessmentAudit({ audit: { hindsight: null, fallback_used: false, intent_status: 'NONE', verification: null } });
  assert.deepEqual(none, { hindsight: null, fallback: null, draft: null, verification: null });
  assert.deepEqual(assessmentAudit({}), { hindsight: null, fallback: null, draft: null, verification: null }, 'no audit recorded: no badges');
  assert.equal(assessmentAudit({ audit: { hindsight: { hindsight_risk: false } } }).hindsight, null);

  // POST /api/assessments/run result shape (camelCase, intent object)
  const run = assessmentAudit({ fallbackUsed: true, requestedModel: 'fixture-model-a', model: 'fixture-model-b', intent: { status: 'VALID', intent: { side: 'buy' }, errors: [] },
    hindsight: { hindsight_risk: true, code: 'MODEL_TRAINING_CUTOFF_UNKNOWN' } });
  assert.deepEqual(run.fallback, { requested: 'fixture-model-a', served: 'fixture-model-b' });
  assert.equal(run.draft.status, 'VALID');
  assert.equal(run.hindsight.cutoff, null, 'unknown cutoff stays unknown');
});

// ---------------------------------------------------------------- evidence lookup

test('evidence lookup ids: valid ids only, de-duplicated, capped like the server', () => {
  const r = evidenceLookupIds([ev(1), ev(1), 'not-an-id', ev(2), 42]);
  assert.deepEqual(r.ids, [ev(1), ev(2)]);
  assert.deepEqual(r.invalid, ['not-an-id', '42']);
  assert.equal(r.notLookedUp, 0);
  const many = Array.from({ length: EVIDENCE_LOOKUP_MAX + 5 }, (_, i) => `ev_${i.toString(16).padStart(24, '0')}`);
  const c = evidenceLookupIds(many);
  assert.equal(c.ids.length, EVIDENCE_LOOKUP_MAX);
  assert.equal(c.notLookedUp, 5);
  assert.deepEqual(evidenceLookupIds(null).ids, []);
});

test('evidence result: requested order, missing ids, and nothing knowable after the replay clock is displayed', () => {
  const clock = T0 + 30 * MIN;
  const rows = [
    { id: ev(2), kind: 'market_quote', title: FIXTURE, knowable_ts: T0 + 10 * MIN, body_json: '{"bid_usd":0.5}' },
    { id: ev(1), kind: 'macro_observation', title: FIXTURE, knowable_ts: T0 + 5 * MIN, body: { value: 4.3 } },
    { id: ev(3), kind: 'market_quote', title: FIXTURE, knowable_ts: T0 + 45 * MIN, body: {} },
    { id: ev(5), kind: 'not requested', knowable_ts: T0 },
  ];
  const r = evidenceResult({ rows }, [ev(1), ev(2), ev(3), ev(4)], { clock });
  assert.deepEqual(r.items.map((e) => e.id), [ev(1), ev(2)], 'requested order; unrequested rows dropped');
  assert.deepEqual(r.items[1].body, { bid_usd: 0.5 }, 'body_json parsed');
  assert.deepEqual(r.withheld, [ev(3)], 'knowable after the clock: withheld, not shown');
  assert.deepEqual(r.missing, [ev(4)]);
  assert.deepEqual(evidenceResult([{ id: ev(1), knowable_ts: null }], [ev(1)], { clock }).withheld, [ev(1)], 'no knowable time while a clock is set: withheld');
  assert.deepEqual(evidenceResult({ items: [{ id: ev(1), knowable_ts: T0 }] }, [ev(1)], { clock }).items.length, 1, '{items:[...]} shape');
  assert.deepEqual(evidenceResult({ evidence: [{ id: ev(1) }] }, [ev(1)]).items.length, 1, 'no clock: server filtering only');
  assert.deepEqual(evidenceResult(null, [ev(1)]).missing, [ev(1)]);
});

// ---------------------------------------------------------------- lens panel: one run only

test('lens panel shows one run: the newest row decides the run; lenses of other runs never mix in', () => {
  const runA = { packet_sha256: 'a'.repeat(64), as_of: T0 + 10 * MIN };
  const runB = { packet_sha256: 'b'.repeat(64), as_of: T0 + 40 * MIN };
  const by = normAssessments([
    { ...runA, lens: 'cowboy', status: 'OK', created_wall: 1, output: { stance: 'watch' } },
    { ...runA, lens: 'pragmatist', status: 'OK', created_wall: 2, output: { stance: 'avoid' } },
    { ...runA, lens: 'tightwad', status: 'OK', created_wall: 3, output: { stance: 'avoid' } },
    { ...runB, lens: 'cowboy', status: 'OK', created_wall: 10, output: { stance: 'consider_entry' } },
    { ...runB, lens: 'pragmatist', status: 'ERROR', created_wall: 11 },
  ]);
  assert.deepEqual(Object.keys(by).sort(), ['cowboy', 'pragmatist'], 'run B has no tightwad row: it is not filled in from run A');
  assert.equal(by.cowboy.output.stance, 'consider_entry');
  assert.equal(by.pragmatist.status, 'ERROR');
  assert.equal(runKeyOf(by.cowboy), runKeyOf(by.pragmatist));
  assert.notEqual(runKeyOf(runA), runKeyOf(runB));
  assert.deepEqual(normAssessments([]), {});
});

// ---------------------------------------------------------------- opportunity options

test('opportunity options: horizon and instruments match the server and are sent only when not the default', () => {
  const marketSrc = fs.readFileSync(path.join(root, 'server', 'api', 'market.js'), 'utf8');
  const wv = marketSrc.match(/const WINDOW_VALUES = \[([^\]]*)\]/);
  assert.ok(wv, 'server/api/market.js declares WINDOW_VALUES');
  assert.deepEqual([...wv[1].matchAll(/'(\d+)'/g)].map((x) => Number(x[1])), [...HORIZON_MINUTES]);
  assert.match(marketSrc, new RegExp(`DEFAULT_WINDOW_MIN = ${DEFAULT_WINDOW_MIN};`));
  assert.deepEqual(INSTRUMENT_CHOICES.map(([id]) => id), [...INSTRUMENT_FILTERS]);

  assert.equal(windowPref('30'), 30);
  assert.equal(windowPref(7), DEFAULT_WINDOW_MIN);
  assert.equal(windowPref(undefined), DEFAULT_WINDOW_MIN);
  assert.equal(instrumentsPref('non_common'), 'non_common');
  assert.equal(instrumentsPref('warrants'), 'all');
  assert.deepEqual(oppParams({ segment: 'micro' }), { segment: 'micro', limit: undefined });
  assert.deepEqual(oppParams({ segment: 'micro', limit: 8, windowMin: 60, instruments: 'common' }), { segment: 'micro', limit: 8, windowMin: 60, instruments: 'common' });
  assert.deepEqual(oppParams({ segment: 'large', windowMin: 15, instruments: 'all' }), { segment: 'large', limit: undefined }, 'defaults are not sent');
  assert.deepEqual(oppParams({ segment: 'micro', windowMin: 60, instruments: 'common', unsupported: { windowMin: true, instruments: true } }),
    { segment: 'micro', limit: undefined }, 'options the server rejected are dropped');
});

test('instrument note reads the server counts; nothing is said without them', () => {
  assert.match(instrumentNote({ counts: { nonCommon: 3, filteredOut: 0 } }, 'all'), /^3 non-common instruments .* rank after common stock\.$/);
  assert.match(instrumentNote({ counts: { nonCommon: 3, filteredOut: 3 } }, 'common'), /^3 symbols hidden by the instrument filter \(common stock only\)\.$/);
  assert.equal(instrumentNote({ counts: { nonCommon: 0 } }, 'all'), null);
  assert.equal(instrumentNote({}, 'common'), null);
});

test('security type: the server classification wins; common stock gets no badge; names fall back to the heuristic', () => {
  assert.equal(securityTypeOf({ securityType: { type: 'warrant', basis: 'IEX symbol suffix' } }).code, 'WARRANT');
  assert.match(securityTypeOf({ securityType: { type: 'unit', basis: 'directory name heuristic', postDated: true } }).basis, /published after the replay clock/);
  assert.equal(securityTypeOf({ name: `${FIXTURE} issuer - Warrant`, securityType: { type: 'common' } }), null, 'server says common: no badge');
  assert.equal(securityTypeOf({ securityType: { type: 'unknown' } }), null);
  assert.equal(securityTypeOf({ name: `${FIXTURE} issuer - Rights` }).code, 'RIGHT', 'no server type: name heuristic');
  assert.equal(securityTypeOf(null), null);
  const o = normOpp({ sym: 'ZVZZT', name: `${FIXTURE} issuer`, namePostDated: true, securityType: { type: 'preferred', basis: 'directory name heuristic' } });
  assert.equal(o.secType.code, 'PREFERRED');
  assert.equal(o.namePostDated, true);
  assert.equal(nameText(o), `${FIXTURE} issuer (post-dated name)`);
  assert.equal(nameText({ name: null }), 'Name not verified');
  assert.equal(nameText({ name: 'x', namePostDated: false }), 'x');
});

test('dossier name: as-of identity name, else the post-dated current-directory name labelled as such', () => {
  assert.equal(dossierName({ status: 'HISTORICAL_REAL', name: 'TEST FIXTURE issuer' }), 'TEST FIXTURE issuer');
  assert.equal(dossierName({ status: 'NO_VERIFIED_DATA', currentDirectory: { name: 'TEST FIXTURE issuer' } }), 'TEST FIXTURE issuer (current directory, post-dated)');
  assert.equal(dossierName({ status: 'NO_VERIFIED_DATA' }), 'Name not verified');
  assert.equal(dossierName(null), 'Name not verified');
});
