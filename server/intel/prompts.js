// Risk-lens prompts and the lens output contract (CONTRACTS.md section 8).
//
// Three lenses (Cowboy / Pragmatist / Tightwad) receive the SAME evidence packet as the user message; only the
// system prompt differs. Nothing here contains market observations: the evidence packet is assembled at run time
// from the as-of store (server/intel/assessments.js).
//
// This module also owns a small JSON-Schema validator used by both provider adapters and by assessments.js, so the
// providers can validate without importing model-provider.js (avoids an import cycle).

import { stableStringify } from '../util/ids.js';
import { isValidTick, U_PER_USD } from '../util/money.js';

export const LENSES = Object.freeze(['cowboy', 'pragmatist', 'tightwad']);
export const STANCES = Object.freeze(['consider_entry', 'watch', 'avoid', 'insufficient_evidence']);
export const CONFIDENCE_LEVELS = Object.freeze(['low', 'medium', 'high']);
export const LENS_SCHEMA_NAME = 'vector_lens_assessment';

// `description` is accepted by both providers' structured-output modes and ignored by validateSchema().
const nullable = (schema, description) => ({ anyOf: [schema, { type: 'null' }], ...(description ? { description } : {}) });

// Model proposals are typed long-only ENTRY drafts. Prices are USD per share (models handle decimals better than
// 1e-4 fixed point); assessments.js converts them to u and runs them through validateIntent.
// The provider-facing schema deliberately avoids numeric/string-length keywords (several structured-output
// implementations reject them); those limits are enforced afterwards by checkLensSemantics().
export const PROPOSED_INTENT_SCHEMA = Object.freeze({
  type: 'object',
  properties: {
    action: { type: 'string', enum: ['open'] },
    side: { type: 'string', enum: ['buy'] },
    order_type: { type: 'string', enum: ['market', 'limit', 'stop', 'stop_limit'] },
    budget_usd: nullable({ type: 'number' }, 'Simulated paper dollars. Give qty, budget_usd, or both; with both, qty is the size and budget_usd is a hard cap on total cost.'),
    qty: nullable({ type: 'integer' }, 'Whole shares. Give qty, budget_usd, or both; with both, qty is the size and budget_usd is a hard cap on total cost.'),
    limit_px_usd: nullable({ type: 'number' }, 'Limit price; only for order_type limit or stop_limit. MUST be null for market and stop.'),
    stop_px_usd: nullable({ type: 'number' }, 'Entry TRIGGER price (buy stop, at or above the current ask); only for order_type stop or stop_limit. MUST be null for market and limit. This is NOT the protective stop.'),
    stop_loss_px_usd: nullable({ type: 'number' }, 'Protective exit stop: below the entry price and below the current bid. Required for every entry.'),
    take_profit_px_usd: nullable({ type: 'number' }, 'Profit-taking exit: above the entry price and above the current bid. Give this or time_exit_min (or both).'),
    time_exit_min: nullable({ type: 'integer' }, 'Exit after this many minutes in the position (1-390). Give this or take_profit_px_usd (or both).'),
    expires_in_min: { type: 'integer', description: 'Minutes the unfilled entry stays working (1-60).' },
    rationale: { type: 'string' },
    evidence_refs: { type: 'array', items: { type: 'string' } },
  },
  required: ['action', 'side', 'order_type', 'budget_usd', 'qty', 'limit_px_usd', 'stop_px_usd', 'stop_loss_px_usd',
    'take_profit_px_usd', 'time_exit_min', 'expires_in_min', 'rationale', 'evidence_refs'],
  additionalProperties: false,
});

export const LENS_OUTPUT_SCHEMA = Object.freeze({
  type: 'object',
  properties: {
    lens: { type: 'string', enum: [...LENSES] },
    stance: { type: 'string', enum: [...STANCES] },
    thesis: { type: 'string' },
    counter_thesis: { type: 'string' },
    exposure: { type: 'string' },
    liquidity_and_spread: { type: 'string' },
    unknowns: { type: 'array', items: { type: 'string' } },
    evidence_refs: { type: 'array', items: { type: 'string' } },
    confidence: {
      type: 'object',
      properties: {
        level: { type: 'string', enum: [...CONFIDENCE_LEVELS] },
        calibration_note: { type: 'string' },
      },
      required: ['level', 'calibration_note'],
      additionalProperties: false,
    },
    proposed_intent: nullable(PROPOSED_INTENT_SCHEMA),
  },
  required: ['lens', 'stance', 'thesis', 'counter_thesis', 'exposure', 'liquidity_and_spread', 'unknowns',
    'evidence_refs', 'confidence', 'proposed_intent'],
  additionalProperties: false,
});

// ---------------------------------------------------------------------------------------------------------------
// Minimal JSON-Schema validator (the subset used by VECTOR schemas): type (string or array), enum, const,
// properties, required, additionalProperties (false or schema), items, anyOf, minLength/maxLength, minimum/maximum,
// minItems/maxItems. Returns an array of "path: problem" strings (empty = valid).

function typeOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'number') return Number.isFinite(v) ? 'number' : 'non-finite';
  return typeof v;
}

function matchesType(v, t) {
  if (t === 'integer') return Number.isInteger(v);
  if (t === 'number') return typeof v === 'number' && Number.isFinite(v);
  return typeOf(v) === t;
}

export function validateSchema(value, schema, path = '$', errors = []) {
  if (!schema || typeof schema !== 'object') return errors;
  if (schema.anyOf) {
    const ok = schema.anyOf.some((s) => validateSchema(value, s, path, []).length === 0);
    if (!ok) {
      // Report the branch errors of the closest non-null branch to keep messages useful.
      const branch = schema.anyOf.find((s) => s.type !== 'null') || schema.anyOf[0];
      const sub = validateSchema(value, branch, path, []);
      errors.push(...(sub.length ? sub : [`${path}: does not match any allowed shape`]));
    }
    return errors;
  }
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((t) => matchesType(value, t))) {
      errors.push(`${path}: expected ${types.join('|')}, got ${typeOf(value)}`);
      return errors;
    }
  }
  if (schema.const !== undefined && value !== schema.const) errors.push(`${path}: must equal ${JSON.stringify(schema.const)}`);
  if (schema.enum && !schema.enum.includes(value)) errors.push(`${path}: must be one of ${schema.enum.join(', ')}`);
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) errors.push(`${path}: shorter than ${schema.minLength}`);
    if (schema.maxLength !== undefined && value.length > schema.maxLength) errors.push(`${path}: longer than ${schema.maxLength}`);
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${path}: below minimum ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) errors.push(`${path}: above maximum ${schema.maximum}`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) errors.push(`${path}: fewer than ${schema.minItems} items`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems) errors.push(`${path}: more than ${schema.maxItems} items`);
    if (schema.items) value.forEach((v, i) => validateSchema(v, schema.items, `${path}[${i}]`, errors));
  }
  if (typeOf(value) === 'object') {
    const props = schema.properties || {};
    for (const k of schema.required || []) {
      if (!Object.prototype.hasOwnProperty.call(value, k)) errors.push(`${path}.${k}: required`);
    }
    for (const [k, v] of Object.entries(value)) {
      if (props[k]) validateSchema(v, props[k], `${path}.${k}`, errors);
      else if (schema.additionalProperties === false) errors.push(`${path}.${k}: unexpected property`);
      else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
        validateSchema(v, schema.additionalProperties, `${path}.${k}`, errors);
      }
    }
  }
  return errors;
}

// ---------------------------------------------------------------------------------------------------------------
// Semantic checks that a schema cannot express. A lens output that fails these is INVALID_OUTPUT, never OK.

export const TEXT_LIMIT = 4000;
const RATIONALE_LIMIT = 2000;
const MAX_LIST = 40;
const MAX_EXPIRY_MIN = 60;
const MAX_TIME_EXIT_MIN = 390;
const PRICE_KEYS = ['limit_px_usd', 'stop_px_usd', 'stop_loss_px_usd', 'take_profit_px_usd'];
export const MAX_LIMIT_ABOVE_ASK = 0.10; // a buy limit more than 10% through the ask is treated as incoherent
const EVIDENCE_TOKEN_RE = /\bev_[A-Za-z0-9]+/g;

const posNum = (x) => (typeof x === 'number' && Number.isFinite(x) && x > 0 ? x : null);

/** Reg NMS tick rule on a USD price: whole cents at or above $1.00, at most 4 decimals below. */
export function isValidTickUsd(x) {
  if (!posNum(x)) return false;
  const u = x * U_PER_USD;
  const r = Math.round(u);
  return Math.abs(u - r) < 1e-6 && isValidTick(r);
}

/** [path, text] for every free-text field of a lens output (used for inline-citation and number checks). */
function textFields(out) {
  const f = ['thesis', 'counter_thesis', 'exposure', 'liquidity_and_spread'].map((k) => [`$.${k}`, out?.[k]]);
  (out?.unknowns ?? []).forEach((u, i) => f.push([`$.unknowns[${i}]`, u]));
  f.push(['$.confidence.calibration_note', out?.confidence?.calibration_note]);
  if (out?.proposed_intent) f.push(['$.proposed_intent.rationale', out.proposed_intent.rationale]);
  return f.filter(([, t]) => typeof t === 'string' && t);
}

/**
 * Price coherence of an entry proposal (USD) against itself and, when given, the packet's prevailing IEX quote
 * ({bid_usd, ask_usd}). Incoherent brackets (a protective stop at/above the bid triggers in the first minute; a target
 * at/below the entry or bid is not a target) are rejected rather than left for the fill engine to book as a loss.
 * @returns {string[]} problems
 */
export function checkBracketCoherence(p, quote = null) {
  const errs = [];
  if (!p) return errs;
  const bid = posNum(quote?.bid_usd);
  const ask = posNum(quote?.ask_usd);
  const sl = posNum(p.stop_loss_px_usd);
  const tp = posNum(p.take_profit_px_usd);
  const lim = posNum(p.limit_px_usd);
  const stp = posNum(p.stop_px_usd);
  // Entry reference: the worst price the entry may pay (limit for limit/stop_limit, max(stop, ask) for stop, ask for market).
  const ref = p.order_type === 'market' ? ask
    : p.order_type === 'stop' ? (stp !== null && ask !== null ? Math.max(stp, ask) : stp)
      : lim;
  if (sl !== null && ref !== null && !(sl < ref)) errs.push(`stop_loss_px_usd ${sl} must be below the entry reference price ${ref}`);
  if (tp !== null && ref !== null && !(tp > ref)) errs.push(`take_profit_px_usd ${tp} must be above the entry reference price ${ref}`);
  if (sl !== null && tp !== null && !(sl < tp)) errs.push(`stop_loss_px_usd ${sl} must be below take_profit_px_usd ${tp}`);
  if (bid !== null) {
    if (sl !== null && !(sl < bid)) errs.push(`stop_loss_px_usd ${sl} must be below the current IEX bid ${bid} (otherwise the protective stop triggers immediately)`);
    if (tp !== null && !(tp > bid)) errs.push(`take_profit_px_usd ${tp} must be above the current IEX bid ${bid}`);
  }
  if (ask !== null) {
    if ((p.order_type === 'limit' || p.order_type === 'stop_limit') && lim !== null && lim > ask * (1 + MAX_LIMIT_ABOVE_ASK)) {
      errs.push(`limit_px_usd ${lim} is more than ${MAX_LIMIT_ABOVE_ASK * 100}% above the current IEX ask ${ask}`);
    }
    if ((p.order_type === 'stop' || p.order_type === 'stop_limit') && stp !== null && !(stp >= ask)) {
      errs.push(`stop_px_usd ${stp} (buy-stop entry trigger) must be at or above the current IEX ask ${ask}`);
    }
  }
  return errs.map((e) => `$.proposed_intent: ${e}`);
}

/**
 * @param {object} out           parsed model JSON
 * @param {{lens:string, evidenceIds:string[], quote?:{bid_usd?:number|null, ask_usd?:number|null}|null}} ctx
 *        quote: the packet's market_quote body, used for bracket coherence (omitted = self-coherence only)
 * @returns {string[]} problems (empty = valid)
 */
export function checkLensSemantics(out, { lens, evidenceIds, quote = null }) {
  const errs = validateSchema(out, LENS_OUTPUT_SCHEMA);
  if (errs.length) return errs;
  const known = new Set(evidenceIds);
  if (out.lens !== lens) errs.push(`$.lens: expected "${lens}", got "${out.lens}"`);
  for (const k of ['thesis', 'counter_thesis', 'exposure', 'liquidity_and_spread']) {
    if (!out[k].trim()) errs.push(`$.${k}: empty`);
    if (out[k].length > TEXT_LIMIT) errs.push(`$.${k}: longer than ${TEXT_LIMIT} chars`);
  }
  if (!out.confidence.calibration_note.trim()) errs.push('$.confidence.calibration_note: empty');
  if (out.confidence.calibration_note.length > TEXT_LIMIT) errs.push('$.confidence.calibration_note: too long');
  if (out.confidence.level === 'high' && out.stance === 'insufficient_evidence') errs.push('$.confidence.level: "high" contradicts stance insufficient_evidence');
  if (out.unknowns.length > MAX_LIST) errs.push(`$.unknowns: more than ${MAX_LIST} items`);
  if (out.evidence_refs.length > MAX_LIST) errs.push(`$.evidence_refs: more than ${MAX_LIST} items`);
  out.unknowns.forEach((u, i) => { if (u.length > TEXT_LIMIT) errs.push(`$.unknowns[${i}]: too long`); });
  for (const ref of out.evidence_refs) if (!known.has(ref)) errs.push(`$.evidence_refs: "${String(ref).slice(0, 80)}" is not an id in the evidence packet`);
  if (out.stance !== 'insufficient_evidence' && out.evidence_refs.length === 0) {
    errs.push('$.evidence_refs: a stance other than insufficient_evidence must cite at least one evidence id');
  }
  // Inline citations ([ev_...] in the text) must be real packet ids and listed in evidence_refs.
  const listed = new Set([...out.evidence_refs, ...(out.proposed_intent?.evidence_refs ?? [])]);
  const inline = new Set();
  for (const [path, text] of textFields(out)) {
    for (const m of text.matchAll(EVIDENCE_TOKEN_RE)) {
      const id = m[0];
      if (!known.has(id)) inline.add(`${path}: cites "${id.slice(0, 40)}" inline, which is not an id in the evidence packet`);
      else if (!listed.has(id)) inline.add(`${path}: cites ${id} inline but it is missing from evidence_refs`);
    }
  }
  errs.push(...inline);
  const p = out.proposed_intent;
  if (p !== null) {
    if (out.stance !== 'consider_entry') errs.push('$.proposed_intent: only allowed with stance consider_entry');
    if (p.evidence_refs.length === 0) errs.push('$.proposed_intent.evidence_refs: must cite at least one evidence id');
    for (const ref of p.evidence_refs) if (!known.has(ref)) errs.push(`$.proposed_intent.evidence_refs: "${String(ref).slice(0, 80)}" is not in the packet`);
    if (!p.rationale.trim()) errs.push('$.proposed_intent.rationale: empty');
    if (p.rationale.length > RATIONALE_LIMIT) errs.push(`$.proposed_intent.rationale: longer than ${RATIONALE_LIMIT} chars`);
    if (p.budget_usd === null && p.qty === null) errs.push('$.proposed_intent: needs budget_usd or qty');
    if (p.budget_usd !== null && !(p.budget_usd > 0)) errs.push('$.proposed_intent.budget_usd: must be > 0');
    if (p.qty !== null && !(p.qty > 0)) errs.push('$.proposed_intent.qty: must be > 0');
    for (const k of PRICE_KEYS) {
      if (p[k] !== null && !(p[k] > 0)) errs.push(`$.proposed_intent.${k}: must be > 0`);
      else if (p[k] !== null && !isValidTickUsd(p[k])) errs.push(`$.proposed_intent.${k}: ${p[k]} is not a valid price tick (whole cents at or above $1.00, at most 4 decimals below $1.00)`);
    }
    const usesLimit = p.order_type === 'limit' || p.order_type === 'stop_limit';
    const usesStop = p.order_type === 'stop' || p.order_type === 'stop_limit';
    if (usesLimit && p.limit_px_usd === null) errs.push('$.proposed_intent.limit_px_usd: required for limit/stop_limit');
    if (usesStop && p.stop_px_usd === null) errs.push('$.proposed_intent.stop_px_usd: required for stop/stop_limit');
    if (!usesLimit && p.limit_px_usd !== null) errs.push(`$.proposed_intent.limit_px_usd: must be null for order_type ${p.order_type}`);
    if (!usesStop && p.stop_px_usd !== null) {
      errs.push(`$.proposed_intent.stop_px_usd: must be null for order_type ${p.order_type} (stop_px_usd is the entry trigger of a stop/stop_limit order; the protective stop belongs in stop_loss_px_usd)`);
    }
    // Rule 8: every entry has a protective stop AND a take-profit or time exit.
    if (p.stop_loss_px_usd === null) errs.push('$.proposed_intent.stop_loss_px_usd: required (every entry needs a protective stop below the entry)');
    if (p.take_profit_px_usd === null && p.time_exit_min === null) errs.push('$.proposed_intent: needs take_profit_px_usd or time_exit_min in addition to the stop');
    if (!(p.expires_in_min >= 1 && p.expires_in_min <= MAX_EXPIRY_MIN)) errs.push(`$.proposed_intent.expires_in_min: must be 1..${MAX_EXPIRY_MIN}`);
    if (p.time_exit_min !== null && !(p.time_exit_min >= 1 && p.time_exit_min <= MAX_TIME_EXIT_MIN)) errs.push(`$.proposed_intent.time_exit_min: must be 1..${MAX_TIME_EXIT_MIN}`);
    errs.push(...checkBracketCoherence(p, quote));
  }
  return errs;
}

// ---------------------------------------------------------------------------------------------------------------
// Deterministic number cross-check. It does NOT fail or rewrite an assessment: it records which numbers in the model's
// free text match no value in the packet (within the rounding the text shows, also as fraction<->percent conversions),
// so a reader can see that "OK" means schema- and id-valid, not fact-checked.

const NUMBER_RE = /(?<![\w.])(\d{1,3}(?:,\d{3})+|\d+)(\.\d+)?/g;
const MAX_UNMATCHED = 40;
const SPREAD_CLAIM_RE = /\b(tight|narrow)\b/i;
export const WIDE_SPREAD_BPS = 100;

function numbersIn(text) {
  const out = [];
  for (const m of String(text).replace(EVIDENCE_TOKEN_RE, ' ').matchAll(NUMBER_RE)) {
    const raw = m[0];
    const value = Number(raw.replace(/,/g, ''));
    if (Number.isFinite(value)) out.push({ raw, value, decimals: m[2] ? m[2].length - 1 : 0 });
  }
  return out;
}

function collectValues(node, acc) {
  if (typeof node === 'number' && Number.isFinite(node)) acc.push(Math.abs(node));
  else if (typeof node === 'string') for (const n of numbersIn(node)) acc.push(n.value);
  else if (Array.isArray(node)) node.forEach((v) => collectValues(v, acc));
  else if (node && typeof node === 'object') Object.values(node).forEach((v) => collectValues(v, acc));
  return acc;
}

/**
 * @param {object} output  validated lens output
 * @param {{meta:object, items:{body?:object, data?:object, title?:string}[], unavailable?:object[]}} packet
 * @returns {{checked:true, numbers_checked:number, unmatched:{field:string, value:string}[], flags:string[], note:string}}
 */
export function crossCheckNumbers(output, packet) {
  const known = [];
  collectValues(packet?.meta, known);
  for (const it of packet?.items ?? []) { collectValues(it.body ?? it.data, known); collectValues(it.title, known); }
  collectValues(packet?.unavailable, known);
  // The lens's own proposal values are its choices, not claims about the packet.
  if (output?.proposed_intent) collectValues(Object.fromEntries(Object.entries(output.proposed_intent).filter(([k]) => k !== 'rationale' && k !== 'evidence_refs')), known);
  const candidates = known.flatMap((v) => [v, v * 100, v / 100]);
  const unmatched = [];
  let checked = 0;
  for (const [field, text] of textFields(output)) {
    for (const n of numbersIn(text)) {
      if (n.decimals === 0 && n.value <= 10) continue; // small counts/ordinals are too ambiguous to check
      checked++;
      const tol = 0.5 * 10 ** -n.decimals + 1e-9;
      if (!candidates.some((c) => Math.abs(c - n.value) <= tol) && unmatched.length < MAX_UNMATCHED) unmatched.push({ field, value: n.raw });
    }
  }
  const flags = [];
  const q = (packet?.items ?? []).find((it) => it.kind === 'market_quote');
  const bps = q ? (q.body ?? q.data)?.spread_bps : null;
  if (Number.isFinite(bps) && bps >= WIDE_SPREAD_BPS && SPREAD_CLAIM_RE.test(`${output?.liquidity_and_spread ?? ''} ${output?.thesis ?? ''}`)) {
    flags.push(`describes the spread as tight/narrow while the packet's IEX spread is ${bps} bps`);
  }
  return {
    checked: true, numbers_checked: checked, unmatched, flags,
    note: 'Numbers in the model text that match no packet value (within the rounding shown, including fraction/percent conversions). '
      + 'Numbers the model derived itself also appear here. This is a consistency aid, not a fact check; integers 0-10 are not checked.',
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Prompts. The shared rules are repeated verbatim in every lens prompt so each call is self-contained.

const SHARED_RULES = `You work inside VECTOR, a PAPER-ONLY research and simulated-trading laboratory. No real money moves and nothing you write is executed directly: any order you propose is a typed paper proposal that a separate deterministic policy gate may reject.

Hard rules:
1. Use ONLY the evidence packet in the user message. It is your entire world. Do not use anything you remember about this symbol, company, sector, news, filings, analysts or past prices, and never invent facts, news, catalysts, analyst views, prices or volumes.
2. Cite evidence by the exact item "id" values (they start with "ev_"). Put every id you relied on in evidence_refs. Never cite an id that is not in the packet.
3. The market data is IEX-ONLY: one exchange's top-of-book quote (not the consolidated NBBO) and the trades executed on IEX, which are a small share of total volume. Buy/sell aggressor shares are inferred by a quote rule, not observed intent. Volume alone is not buying intent.
4. Everything in the packet was published at or before the as-of time (macro values are the latest vintage at fetch time and may include later revisions; see each macro item's vintage_caveat). You cannot know what happens later; do not predict it as fact.
5. List material unknowns (for example filings, news, share count, float, dilution, other venues' volume) in unknowns whenever the packet does not contain them.
6. If the packet cannot support a view, use stance "insufficient_evidence" with proposed_intent null.
7. Calibrate confidence: "high" only when several independent evidence items agree and the key unknowns are minor; most single-venue intraday packets warrant "low" or "medium". Explain in calibration_note.
8. proposed_intent is null unless stance is "consider_entry". It is a long BUY entry only (no shorting), prices in USD per share, budget_usd in simulated paper dollars. Price fields by order_type: market = limit_px_usd null and stop_px_usd null; limit = limit_px_usd set, stop_px_usd null; stop = stop_px_usd set (the entry TRIGGER, at or above the current ask), limit_px_usd null; stop_limit = both set. stop_px_usd is never the protective stop. Every entry needs stop_loss_px_usd (the protective exit, below the entry price and below the current bid) plus take_profit_px_usd (above the entry price and the current bid) or time_exit_min. Size with qty (whole shares), budget_usd, or both (then qty is the size and budget_usd caps the total cost). Prices at or above $1.00 must be whole cents; prices below $1.00 may use up to 4 decimals. expires_in_min is 1-60.
9. Quote every number with the exact field name and window it has in the packet (for example regular_session.session_low_usd is the regular-session low, not a 15-minute low; session_vwap_usd is the session VWAP). Never relabel a value to another window; if a window you want is not in the packet, say it is not available. State spread cost with spread_bps / spread_pct_of_mid / round_trip_cross_cost_pct, and in exposure subtract the round-trip cost from both the target and the stop distance.

Output fields (one JSON object, nothing else):
- lens: your lens id.
- stance: consider_entry | watch | avoid | insufficient_evidence.
- thesis: the case for your stance from your lens, citing ids like [ev_...].
- counter_thesis: the strongest case against your own thesis.
- exposure: what a paper position would put at risk (size, worst-case loss including spread and slippage, exit plan), or why you take none.
- liquidity_and_spread: spread, displayed size, trade frequency, and whether a paper fill could be credibly estimated.
- unknowns: material facts missing from the packet.
- evidence_refs: ids you relied on.
- confidence: {level: low|medium|high, calibration_note}.
- proposed_intent: null or the typed entry proposal.`;

const LENS_TEXT = {
  cowboy: `You are COWBOY, the aggressive risk lens (lens id "cowboy").
Your job: find the MAXIMUM PLAUSIBLE UPSIDE the evidence actually supports - price velocity, acceleration, volume expansion versus the early-session baseline, buyer-initiated pressure - and say how far it could run if the move continues.
You accept volatility, but your risk is ALWAYS bounded: any entry you propose names a hard stop below entry, a take-profit or a time exit, and a budget you would accept losing. Prefer explicit exits over hope. If the move looks exhausted, stale, halted or untradeable at the spread, say so - aggressive is not reckless.`,
  pragmatist: `You are PRAGMATIST, the moderate, risk-adjusted lens (lens id "pragmatist").
Your job: weigh reward against what it costs to get in and out - spread, slippage, displayed size, trade frequency - and against the business context: financing needs, dilution, valuation and share structure. When the packet has no financing, filing or valuation evidence, say so plainly in unknowns and let that lower your confidence; do not fill the gap from memory.
State the specific, observable conditions under which you would act (for example a tighter spread or confirmation of volume) and size any proposal to the observed liquidity, preferring limit orders.`,
  tightwad: `You are TIGHTWAD, the very conservative capital-preservation lens (lens id "tightwad").
Your first question is: "Would I risk even $5 on this?" Default to "avoid" or "watch" unless the evidence is unusually clean.
Focus on what can go wrong: worst-case execution (wide or one-sided quotes, thin displayed size, stale quotes, halts, a stop gapping through), dilution and financing risk, and manipulation or promotion patterns common in low-priced stocks. Enumerate concrete reasons to abstain. If you ever propose an entry, it is tiny, uses a limit order and a tight stop, and you say exactly why it clears your bar.`,
};

/** System prompt for one lens. Throws on an unknown lens. */
export function systemPromptFor(lens) {
  if (!LENS_TEXT[lens]) throw new Error(`unknown lens "${lens}"`);
  return `${LENS_TEXT[lens]}\n\n${SHARED_RULES}`;
}

// Repeated at the END of the user message as defence in depth: servers that silently truncate an over-long prompt
// (e.g. Ollama at its context limit) keep the tail. This is not a substitute for the provider's context checks.
export const PACKET_REMINDER = 'REMINDER (hard rules): use ONLY this packet and never invent facts, news, prices or volumes; '
  + 'cite only the "id" values above and list every id you use in evidence_refs; the data is IEX-only (not the consolidated NBBO); '
  + 'quote numbers with their exact field and window; any proposed entry needs stop_loss_px_usd below the current bid plus '
  + 'take_profit_px_usd or time_exit_min, and stop_px_usd only for stop/stop_limit orders; reply with one JSON object only.';

/**
 * The user message: a deterministic rendering of the evidence packet. It is identical for every lens, so the
 * sha256 of this exact text is the packet hash stored on each assessment row.
 * @param {{meta:object, items:object[], unavailable:object[]}} modelView
 */
export function renderPacketMessage(modelView) {
  const hasMacro = modelView.items.some((it) => it.kind === 'macro_observation');
  const lines = [
    'VECTOR EVIDENCE PACKET - the ONLY information you may use.',
    'Every item was published/knowable at or before the as-of time below; nothing later exists for you. Cite items by "id".',
    ...(hasMacro ? ['Exception: macro_observation values are the LATEST FRED vintage at fetch time and may include revisions made after the as-of time (see each vintage_caveat).'] : []),
    '',
    `META ${stableStringify(modelView.meta)}`,
    '',
    'ITEMS (one JSON object per line):',
    ...modelView.items.map((it) => stableStringify(it)),
    '',
    'NOT AVAILABLE (treat as unknown, do not guess):',
    ...(modelView.unavailable.length ? modelView.unavailable.map((u) => stableStringify(u)) : ['(none listed)']),
    '',
    `Task: give your lens assessment of ${modelView.meta.sym} as of ${modelView.meta.as_of_et} as one JSON object.`,
    PACKET_REMINDER,
  ];
  return lines.join('\n');
}
