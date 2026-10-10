// User-supplied CSV bar import and the (always-refused) operational long-put order path.
//
// CSV: mere upload never establishes authenticity. Accepted files are stored as IMPORTED_UNVERIFIED with NULL quote
// columns (server/data/ingest/csv-import.js), so they can be charted/studied but never produce paper fills, and they
// are not replayable market datasets.
// Options: a long-put order needs a verified options quote AS OF THE REPLAY CLOCK. No historical options provider is
// connected in this build, so every operational options order is answered 409 NO_VERIFIED_OPTIONS_DATA. The request is
// still turned into a typed intent and passed through the policy gate so the attempt and its denial are journaled.
import { importCsvBars } from '../data/ingest/csv-import.js';
import { feedStatus } from '../data/providers/index.js';
import { append } from '../journal.js';
import { OPTIONS_STATUS } from '../sim/options.js';
import { PORTFOLIO_IDS } from '../sim/ledger.js';
import { gateHumanIntent, journalHumanRefusal } from './trading.js';
import { ApiError, badRequest, conflict, created, notFound, onlyKeys, intIn, bool, text, id as idOf, summarizeBody } from './http.js';

/** POST /api/import/csv {manifest, csv} */
export function postImportCsv(ctx, _req, { body }) {
  onlyKeys(body, ['manifest', 'csv', 'confirm']);
  if (!body.manifest || typeof body.manifest !== 'object' || Array.isArray(body.manifest)) throw badRequest('MANIFEST_REQUIRED', 'manifest (provenance object) is required');
  if (typeof body.csv !== 'string' || !body.csv.length) throw badRequest('CSV_REQUIRED', 'csv (file text) is required');
  const r = importCsvBars(ctx.db, { manifest: body.manifest, csv: body.csv });
  const st = ctx.replay();
  append(ctx.db, {
    session_id: st.session_id, ts_sim: st.clock, actor: 'human', type: r.ok ? 'CSV_IMPORTED' : 'CSV_IMPORT_REJECTED', ref_id: r.ds ?? null,
    payload: { status: r.status, ds: r.ds, rows: r.rows, errors: (r.errors || []).slice(0, 20), file_sha256: r.quality?.file_sha256 ?? null },
  });
  if (!r.ok && r.status === 'ALREADY_IMPORTED') {
    throw new ApiError(409, 'ALREADY_IMPORTED', String((r.errors || [])[0] ?? 'these bytes were already imported with a different manifest').slice(0, 1000),
      { status: 'ALREADY_IMPORTED', ds: r.ds, errors: r.errors });
  }
  if (!r.ok) {
    throw new ApiError(422, 'IMPORT_REJECTED', `Import rejected: ${(r.errors || []).slice(0, 5).join('; ')}`.slice(0, 1000),
      { status: 'REJECTED', ds: r.ds, errors: r.errors, quality: r.quality });
  }
  return created({
    decision: 'OK', status: r.status, ds: r.ds, rows: r.rows, quality: r.quality,
    ...(r.alreadyImported ? { alreadyImported: true, alreadyImportedNote: r.note } : {}),
    note: 'IMPORTED_UNVERIFIED — provenance is declared by the importer, not verified. No quotes are imported, so these bars can never produce paper fills.',
  });
}

const CONTRACT_KEYS = ['occ', 'underlying', 'expiry', 'strike_u', 'strike', 'right', 'multiplier'];

/** POST /api/options/orders — long puts only; 409 NO_VERIFIED_OPTIONS_DATA unless a verified as-of options quote exists. */
export function postOptionsOrder(ctx, _req, { body }) {
  onlyKeys(body, ['portfolio_id', 'contract', 'contracts', 'order_type', 'limit_px_u', 'confirm', 'rationale']);
  const portfolio_id = body.portfolio_id === undefined ? 'sandbox' : idOf(body.portfolio_id, 'portfolio_id');
  if (!PORTFOLIO_IDS.includes(portfolio_id)) {
    journalHumanRefusal(ctx, ctx.replay(), { code: 'PORTFOLIO_NOT_FOUND', detail: `unknown portfolio ${portfolio_id} (options order)`, body });
    throw notFound('PORTFOLIO_NOT_FOUND', `unknown portfolio ${portfolio_id} (humans place orders in 'sandbox')`);
  }
  const confirm = bool(body.confirm, 'confirm', { optional: true, dflt: false });
  const contracts = intIn(body.contracts, 1, 1000, 'contracts');
  const limit = intIn(body.limit_px_u, 1, 1e10, 'limit_px_u');
  if (body.order_type !== undefined && body.order_type !== 'limit') throw badRequest('ORDER_TYPE_INVALID', "long puts are limit orders only (order_type 'limit')");
  if (!body.contract || typeof body.contract !== 'object' || Array.isArray(body.contract)) throw badRequest('CONTRACT_REQUIRED', 'contract {occ, underlying, expiry, strike_u, right:"P", multiplier:100} is required');
  onlyKeys(body.contract, CONTRACT_KEYS, 'contract');
  const c = body.contract;
  const contract = { occ: c.occ, underlying: c.underlying, expiry: c.expiry, strike: c.strike_u ?? c.strike, right: c.right, multiplier: c.multiplier };
  const rationale = text(body.rationale, 2000, 'rationale', { optional: true, dflt: 'Human long-put paper order' }) || 'Human long-put paper order';
  const feed = feedStatus(ctx.env).options;
  const detail = 'No verified options quote is available as of the replay clock (no historical options provider is connected). '
    + 'Operational options orders are rejected rather than simulated on fabricated premiums.';

  const st = ctx.replay();
  if (!st.session_id || !st.ds || !Number.isFinite(st.clock)) {
    append(ctx.db, { session_id: st.session_id, ts_sim: st.clock, portfolio_id, actor: 'human', type: 'ORDER_REJECTED', ref_id: null,
      payload: { stage: 'options', code: OPTIONS_STATUS, detail, request: summarizeBody(body) } });
    throw conflict(OPTIONS_STATUS, detail, { decision: 'DENIED', optionsStatus: feed.status });
  }
  const proposal = {
    action: 'open', instrument: { kind: 'option', sym: typeof c.underlying === 'string' ? c.underlying : '', contract }, side: 'buy',
    qty: contracts, order_type: 'limit', limit_px_u: limit, rationale, evidence_refs: [],
  };
  // Journals INTENT_PROPOSED + POLICY_DENY (instrument_allowed: NO_VERIFIED_OPTIONS_DATA); 400 if the contract is malformed.
  const { intent, gate } = gateHumanIntent(ctx, { proposal, portfolio_id, confirm, requestBody: body });
  throw conflict(OPTIONS_STATUS, detail, {
    decision: 'DENIED', optionsStatus: feed.status, intent_id: intent.id,
    reasons: gate.decision === 'DENIED' ? gate.reasons : [{ code: OPTIONS_STATUS, detail }],
    checks: gate.checks,
  });
}
