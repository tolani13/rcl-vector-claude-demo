// Typed trade intents (docs/CONTRACTS.md section 6). An intent is a PROPOSAL, never an executable instruction:
// it must pass validateIntent() and then the deterministic policy gate before the order engine sees it.
// Model output is parsed into this exact shape and validated; free-form model text is never executed.
//
// Validation is strict: unknown fields are rejected at every level, prices are integer u (1e-4 USD), quantities
// are whole shares/contracts, and timestamps are integer ms. Whether timestamps are <= the replay clock is checked
// by the gate (evidence_not_future), which knows the clock.
import { validateContract } from '../sim/options.js';

const TOP_KEYS = new Set(['id', 'source', 'agent_id', 'portfolio_id', 'strategy_id', 'action', 'instrument', 'side', 'qty', 'budget_usd',
  'order_type', 'limit_px_u', 'stop_px_u', 'attach', 'target_order_id', 'rationale', 'evidence_refs', 'quote_ts', 'created_ts', 'expires_ts']);
const REQUIRED_KEYS = ['source', 'agent_id', 'portfolio_id', 'strategy_id', 'action', 'instrument', 'side', 'order_type', 'rationale',
  'evidence_refs', 'quote_ts', 'created_ts', 'expires_ts'];
const INSTRUMENT_KEYS = new Set(['kind', 'sym', 'contract']);
const ATTACH_KEYS = new Set(['stop_loss_px_u', 'take_profit_px_u', 'time_exit_min', 'time_exit_band_bps']);
const SOURCES = new Set(['rules', 'model', 'human']);
const ACTIONS = new Set(['open', 'close', 'modify', 'cancel']);
const SIDES = new Set(['buy', 'sell']);
const ORDER_TYPES = new Set(['market', 'limit', 'stop', 'stop_limit']);
const ID_RE = /^[A-Za-z0-9_\-:.]{1,80}$/;
// IEX symbology may end in an issue-type suffix: '+' warrant, '^' right, '=' unit, '#' when-issued (e.g. BBAI+, NE+A,
// AIIA^). Such symbols are stored IEX minutes and can reach a strategy's candidates, so the intent stays VALID and the
// gate decides (symbol_allowed denies warrants/rights/units: SYMBOL_ISSUE_TYPE_DENIED) instead of the proposer failing.
const SYM_RE = /^[A-Z][A-Z0-9.\-]{0,9}(?:[+^=#][A-Z0-9]{0,2})?$/;
const MAX_RATIONALE = 2000;
const MAX_EVIDENCE_REFS = 50;
const MAX_BUDGET_USD = 10_000_000;

/** Fields a model (or rules strategy) may propose. Everything else comes from the trusted envelope. */
export const PROPOSAL_KEYS = Object.freeze(['action', 'instrument', 'side', 'qty', 'budget_usd', 'order_type', 'limit_px_u', 'stop_px_u',
  'attach', 'target_order_id', 'rationale', 'evidence_refs']);

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;
const isPosInt = (v) => Number.isSafeInteger(v) && v > 0;

/**
 * Strictly validate a TradeIntent.
 * @returns {{ok:boolean, errors:string[], intent:object|null}} intent is a normalized deep copy when ok.
 */
export function validateIntent(obj) {
  const errors = [];
  if (!isPlainObject(obj)) return { ok: false, errors: ['intent must be a plain JSON object'], intent: null };
  for (const k of Object.keys(obj)) if (!TOP_KEYS.has(k)) errors.push(`unknown field: ${k}`);
  for (const k of REQUIRED_KEYS) if (!(k in obj)) errors.push(`missing required field: ${k}`);

  if (obj.id !== undefined && (typeof obj.id !== 'string' || !ID_RE.test(obj.id))) errors.push('id must match ^[A-Za-z0-9_-:.]{1,80}$');
  if (!SOURCES.has(obj.source)) errors.push("source must be 'rules', 'model' or 'human'");
  if (obj.source === 'human') {
    if (obj.agent_id !== null) errors.push('agent_id must be null for human intents');
  } else if ('source' in obj && (typeof obj.agent_id !== 'string' || !ID_RE.test(obj.agent_id))) {
    errors.push('agent_id must be an id string for rules/model intents');
  }
  if (typeof obj.portfolio_id !== 'string' || !ID_RE.test(obj.portfolio_id)) errors.push('portfolio_id must be an id string');
  if (obj.strategy_id !== null && (typeof obj.strategy_id !== 'string' || !ID_RE.test(obj.strategy_id))) errors.push('strategy_id must be an id string or null');
  if (!ACTIONS.has(obj.action)) errors.push("action must be 'open', 'close', 'modify' or 'cancel'");
  if (!SIDES.has(obj.side)) errors.push("side must be 'buy' or 'sell'");
  if (!ORDER_TYPES.has(obj.order_type)) errors.push("order_type must be 'market', 'limit', 'stop' or 'stop_limit'");

  // instrument
  let contract = null;
  const ins = obj.instrument;
  if (!isPlainObject(ins)) errors.push('instrument must be an object {kind, sym, contract?}');
  else {
    for (const k of Object.keys(ins)) if (!INSTRUMENT_KEYS.has(k)) errors.push(`unknown instrument field: ${k}`);
    if (ins.kind !== 'equity' && ins.kind !== 'option') errors.push("instrument.kind must be 'equity' or 'option'");
    if (typeof ins.sym !== 'string' || !SYM_RE.test(ins.sym)) errors.push('instrument.sym must match ^[A-Z][A-Z0-9.-]{0,9} with an optional IEX suffix [+^=#][A-Z0-9]{0,2}');
    if (ins.kind === 'option') {
      const vc = validateContract(ins.contract);
      if (!vc.ok) errors.push(...vc.errors.map((e) => `instrument.contract: ${e}`));
      else {
        contract = vc.contract;
        if (ins.sym !== contract.underlying) errors.push('instrument.sym must equal the option underlying');
      }
    } else if (ins.contract !== undefined) errors.push('instrument.contract is only allowed for options');
  }

  // action/side coherence (long-only book: entries buy, exits sell)
  if (obj.action === 'open' && obj.side !== 'buy') errors.push("action 'open' requires side 'buy' (no shorting)");
  if (obj.action === 'close' && obj.side !== 'sell') errors.push("action 'close' requires side 'sell'");
  if ((obj.action === 'modify' || obj.action === 'cancel')) {
    if (typeof obj.target_order_id !== 'string' || !ID_RE.test(obj.target_order_id)) errors.push(`action '${obj.action}' requires target_order_id`);
  } else if (obj.target_order_id !== undefined) errors.push("target_order_id is only allowed for 'modify' and 'cancel'");

  // size
  if (obj.qty !== undefined && !isPosInt(obj.qty)) errors.push('qty must be a positive integer (whole shares/contracts)');
  if (obj.budget_usd !== undefined && (typeof obj.budget_usd !== 'number' || !Number.isFinite(obj.budget_usd) || obj.budget_usd <= 0 || obj.budget_usd > MAX_BUDGET_USD)) {
    errors.push(`budget_usd must be a finite number in (0, ${MAX_BUDGET_USD}]`);
  }
  if (obj.action === 'open' && obj.qty === undefined && obj.budget_usd === undefined) errors.push("action 'open' requires qty or budget_usd");
  if (obj.action === 'close' && obj.budget_usd !== undefined) errors.push("budget_usd is not allowed for 'close'");

  // prices
  const needLimit = obj.order_type === 'limit' || obj.order_type === 'stop_limit';
  const needStop = obj.order_type === 'stop' || obj.order_type === 'stop_limit';
  if (obj.action !== 'cancel') {
    if (needLimit && !isPosInt(obj.limit_px_u)) errors.push(`${obj.order_type} requires limit_px_u (positive integer u)`);
    if (needStop && !isPosInt(obj.stop_px_u)) errors.push(`${obj.order_type} requires stop_px_u (positive integer u)`);
  }
  if (!needLimit && obj.limit_px_u !== undefined) errors.push(`limit_px_u not allowed for ${obj.order_type}`);
  if (!needStop && obj.stop_px_u !== undefined) errors.push(`stop_px_u not allowed for ${obj.order_type}`);
  if (obj.limit_px_u !== undefined && !isPosInt(obj.limit_px_u)) errors.push('limit_px_u must be a positive integer number of u');
  if (obj.stop_px_u !== undefined && !isPosInt(obj.stop_px_u)) errors.push('stop_px_u must be a positive integer number of u');

  // attach (bracket) — entries only
  if (obj.attach !== undefined) {
    const a = obj.attach;
    if (!isPlainObject(a)) errors.push('attach must be an object');
    else {
      for (const k of Object.keys(a)) if (!ATTACH_KEYS.has(k)) errors.push(`unknown attach field: ${k}`);
      if (obj.action !== 'open') errors.push("attach is only allowed for action 'open'");
      if (a.stop_loss_px_u !== undefined && !isPosInt(a.stop_loss_px_u)) errors.push('attach.stop_loss_px_u must be a positive integer number of u');
      if (a.take_profit_px_u !== undefined && !isPosInt(a.take_profit_px_u)) errors.push('attach.take_profit_px_u must be a positive integer number of u');
      if (isPosInt(a.stop_loss_px_u) && isPosInt(a.take_profit_px_u) && a.stop_loss_px_u >= a.take_profit_px_u) errors.push('attach.stop_loss_px_u must be below attach.take_profit_px_u');
      if (a.time_exit_min !== undefined && (!Number.isSafeInteger(a.time_exit_min) || a.time_exit_min < 1 || a.time_exit_min > 390)) errors.push('attach.time_exit_min must be an integer 1..390');
      if (a.time_exit_band_bps !== undefined && (!Number.isSafeInteger(a.time_exit_band_bps) || a.time_exit_band_bps < 0 || a.time_exit_band_bps > 10000)) errors.push('attach.time_exit_band_bps must be an integer 0..10000');
      if (ins?.kind === 'option') errors.push('attach is not supported for options');
    }
  }

  // text + evidence
  if (typeof obj.rationale !== 'string') errors.push('rationale must be a string');
  else if (obj.rationale.length > MAX_RATIONALE) errors.push(`rationale must be <= ${MAX_RATIONALE} characters`);
  if (!Array.isArray(obj.evidence_refs)) errors.push('evidence_refs must be an array of strings');
  else {
    if (obj.evidence_refs.length > MAX_EVIDENCE_REFS) errors.push(`evidence_refs must have <= ${MAX_EVIDENCE_REFS} items`);
    if (obj.evidence_refs.some((r) => typeof r !== 'string' || r.length === 0 || r.length > 200)) errors.push('evidence_refs items must be non-empty strings <= 200 chars');
  }

  // timestamps
  for (const k of ['quote_ts', 'created_ts', 'expires_ts']) {
    if (!Number.isSafeInteger(obj[k]) || obj[k] <= 0) errors.push(`${k} must be an integer ms timestamp`);
  }
  if (Number.isSafeInteger(obj.created_ts) && Number.isSafeInteger(obj.expires_ts) && obj.expires_ts <= obj.created_ts) errors.push('expires_ts must be after created_ts');
  if (Number.isSafeInteger(obj.quote_ts) && Number.isSafeInteger(obj.created_ts) && obj.quote_ts > obj.created_ts) errors.push('quote_ts must be <= created_ts');

  if (errors.length) return { ok: false, errors, intent: null };
  const intent = structuredClone(obj);
  if (contract) intent.instrument.contract = contract;
  return { ok: true, errors: [], intent };
}

/**
 * Build an intent from a proposal (model or rules output) plus a TRUSTED envelope the proposer cannot set:
 * source, agent_id, portfolio_id, strategy_id and timestamps. Unknown proposal fields are rejected.
 * @param {object} proposal  only PROPOSAL_KEYS
 * @param {{source:'rules'|'model'|'human', agent_id:string|null, portfolio_id:string, strategy_id:string|null,
 *          quote_ts:number, created_ts:number, expires_ts:number, id?:string}} envelope
 */
export function intentFromProposal(proposal, envelope) {
  if (!isPlainObject(proposal)) return { ok: false, errors: ['proposal must be a plain JSON object'], intent: null };
  const extra = Object.keys(proposal).filter((k) => !PROPOSAL_KEYS.includes(k));
  if (extra.length) return { ok: false, errors: extra.map((k) => `proposal may not set field: ${k}`), intent: null };
  const { id, source, agent_id, portfolio_id, strategy_id, quote_ts, created_ts, expires_ts } = envelope || {};
  const obj = { ...structuredClone(proposal), source, agent_id, portfolio_id, strategy_id, quote_ts, created_ts, expires_ts };
  if (id !== undefined) obj.id = id;
  return validateIntent(obj);
}

/** JSON schema for model proposals (used with structured-output model calls). Prices are integer u = 1e-4 USD. */
export const PROPOSAL_JSON_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['action', 'instrument', 'side', 'order_type', 'rationale', 'evidence_refs'],
  properties: {
    action: { type: 'string', enum: ['open', 'close', 'modify', 'cancel'] },
    instrument: {
      type: 'object', additionalProperties: false, required: ['kind', 'sym'],
      properties: { kind: { type: 'string', enum: ['equity'] }, sym: { type: 'string' } },
    },
    side: { type: 'string', enum: ['buy', 'sell'] },
    qty: { type: 'integer', minimum: 1 },
    budget_usd: { type: 'number' },
    order_type: { type: 'string', enum: ['market', 'limit', 'stop', 'stop_limit'] },
    limit_px_u: { type: 'integer', minimum: 1 },
    stop_px_u: { type: 'integer', minimum: 1 },
    attach: {
      type: 'object', additionalProperties: false,
      properties: {
        stop_loss_px_u: { type: 'integer', minimum: 1 }, take_profit_px_u: { type: 'integer', minimum: 1 },
        time_exit_min: { type: 'integer', minimum: 1, maximum: 390 }, time_exit_band_bps: { type: 'integer', minimum: 0, maximum: 10000 },
      },
    },
    target_order_id: { type: 'string' },
    rationale: { type: 'string', maxLength: 2000 },
    evidence_refs: { type: 'array', items: { type: 'string' }, maxItems: 50 },
  },
});
