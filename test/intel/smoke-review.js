// Deterministic reviewer notes for live model smoke receipts (used by test/intel/live-smoke-ollama.js).
//
// These checks read a lens output against the evidence packet it was given and record observations a human reviewer
// should look at. They never change a status and they are not a fact check: "OK" from runLensAssessments means
// schema-, evidence-id- and bracket-coherence-valid only. Test tooling only; product code never imports this file.

// A price: optional "$", digits, not a percentage (the lookahead also stops backtracking into "12%" -> "1").
const NUM = String.raw`\$?(\d+(?:\.\d+)?)(?![\d.]*\s*%)`;
// The gap between label and number may not contain another statistic word (so "15m low and session high 0.25"
// does not pin 0.25 on the 15m low).
const GAP = String.raw`(?:(?!\b(?:high|low|vwap)\b)[^0-9\n]){0,24}?`;
// "<window> <statistic> ... <number>", e.g. "15m low of $0.185", "session VWAP 0.2101", "premarket high: 0.25".
const LABEL_RE = new RegExp(String.raw`\b(15[-\s]?(?:m|min|mins|minute|minutes)|regular[-\s]session|session|intraday|day's|pre[-\s]?market)\s+(high|low|vwap)\b${GAP}${NUM}`, 'gi');
const BUY_CLAIM_RE = /\b(buy(?:ing|er)?[-\s](?:pressure|side pressure|initiated pressure|dominance|dominated)|strong (?:buying|demand)|buyers? (?:in control|dominate|dominating))\b/gi;
const NEGATION_RE = /\b(no|not|lack(?:s|ing)?|without|absence|little|weak|limited|minimal)\b[^.;\n]{0,24}$/i;
const ROUND_TRIP_RE = /\b(round[-\s]?trip|spread cost|cross(?:ing)? the spread|round_trip_cross_cost_pct|spread_pct_of_mid|spread_bps)\b/i;
const CONTEXT_WARN_SHARE = 0.9;

const bodyOf = (items, kind) => items.find((it) => it.kind === kind)?.body ?? items.find((it) => it.kind === kind)?.data ?? null;
const isNum = (x) => typeof x === 'number' && Number.isFinite(x);

/** Named packet values a window label can refer to (null when the packet has no such value). */
export function packetWindowValues(items) {
  const px = bodyOf(items, 'market_price') ?? {};
  const vol = bodyOf(items, 'market_volume') ?? {};
  const q = bodyOf(items, 'market_quote') ?? {};
  const rs = px.regular_session ?? {};
  const r15 = px.recent_15m ?? {};
  const pre = px.premarket ?? {};
  return {
    'regular_session.session_high_usd': rs.session_high_usd ?? null,
    'regular_session.session_low_usd': rs.session_low_usd ?? null,
    'regular_session.session_vwap_usd': vol.regular_session?.session_vwap_usd ?? null,
    'recent_15m.recent_15m_high_usd': r15.recent_15m_high_usd ?? null,
    'recent_15m.recent_15m_low_usd': r15.recent_15m_low_usd ?? null,
    'premarket.premarket_high_usd': pre.premarket_high_usd ?? null,
    'premarket.premarket_low_usd': pre.premarket_low_usd ?? null,
    last_trade_usd: px.last_trade_usd ?? null,
    bid_usd: q.bid_usd ?? null,
    ask_usd: q.ask_usd ?? null,
  };
}

function fieldFor(windowRaw, stat) {
  const w = windowRaw.toLowerCase();
  const win = /15/.test(w) ? '15m' : /pre/.test(w) ? 'premarket' : 'session';
  const s = stat.toLowerCase();
  if (win === '15m') return s === 'vwap' ? null : `recent_15m.recent_15m_${s}_usd`;
  if (win === 'premarket') return s === 'vwap' ? null : `premarket.premarket_${s}_usd`;
  return `regular_session.session_${s}_usd`;
}

const matches = (value, raw) => {
  const decimals = raw.includes('.') ? raw.split('.')[1].length : 0;
  return isNum(value) && Math.abs(value - Number(raw)) <= 0.5 * 10 ** -decimals + 1e-9;
};

/**
 * Window-label consistency: a number introduced as e.g. "15m low" must be the packet's recent_15m low, not the session
 * low. Returns observation strings.
 */
export function windowLabelIssues(text, items) {
  const vals = packetWindowValues(items);
  const out = [];
  for (const m of String(text ?? '').matchAll(LABEL_RE)) {
    const [phrase, windowRaw, stat, raw] = m;
    const field = fieldFor(windowRaw, stat);
    const quoted = phrase.trim().replace(/\s+/g, ' ');
    if (field === null) {
      out.push(`"${quoted}": the packet has no ${stat.toUpperCase()} for that window (only regular_session.session_vwap_usd)`);
      continue;
    }
    if (vals[field] === null || vals[field] === undefined) {
      out.push(`"${quoted}": the packet has no ${field}`);
      continue;
    }
    if (matches(vals[field], raw)) continue;
    const others = Object.entries(vals).filter(([k, v]) => k !== field && matches(v, raw)).map(([k]) => k);
    out.push(others.length
      ? `"${quoted}" is mislabelled: ${raw} is ${others.join(' / ')}, while ${field} is ${vals[field]}`
      : `"${quoted}" does not match ${field} (${vals[field]})`);
  }
  return out;
}

/** Buying-pressure language versus the packet's inferred buy shares (IEX-only quote-rule inference). */
export function buyPressureIssues(texts, items) {
  const ag = bodyOf(items, 'market_aggressor_inferred');
  const joined = texts.filter((t) => typeof t === 'string').join(' \n ');
  // A claim, not a denial: "no buying pressure" / "lack of buy pressure" are not flagged.
  const m = [...joined.matchAll(BUY_CLAIM_RE)].find((x) => !NEGATION_RE.test(joined.slice(Math.max(0, x.index - 40), x.index)));
  if (!m) return [];
  const sess = ag?.regular_session?.buy_share ?? null;
  const rec = ag?.recent_15m?.buy_share ?? null;
  const shares = [sess, rec].filter(isNum);
  if (!shares.length) return [`claims "${m[0]}" but the packet's inferred buy_share is null (too little classified IEX volume)`];
  if (Math.max(...shares) <= 0.55) return [`claims "${m[0]}" while the inferred buy_share is ${sess ?? 'null'} (session) / ${rec ?? 'null'} (recent 15m): not a clear buyer majority, and the inference is IEX-only`];
  return [];
}

/**
 * Reviewer notes for one lens result of runLensAssessments.
 * @param {object} r        per-lens result ({lens, status, output, error, usage, verification, intent})
 * @param {object[]} items  packet items ({kind, body})
 * @param {{tokens:number|null}} context  the context window the call was served with (null = unknown)
 */
export function reviewLens(r, items, context = { tokens: null }) {
  const obs = [];
  if (r.status !== 'OK') obs.push(`not usable: ${r.status}${r.error ? ` - ${String(r.error).slice(0, 300)}` : ''}`);
  const used = isNum(r.usage?.in) && isNum(r.usage?.out) ? r.usage.in + r.usage.out : null;
  let contextUse = null;
  if (used !== null && isNum(context?.tokens) && context.tokens > 0) {
    contextUse = { prompt_tokens: r.usage.in, output_tokens: r.usage.out, context_tokens: context.tokens, share: Math.round((used / context.tokens) * 1000) / 1000 };
    if (used >= context.tokens) obs.push(`context exhausted: ${r.usage.in} + ${r.usage.out} tokens >= ${context.tokens}`);
    else if (used >= CONTEXT_WARN_SHARE * context.tokens) obs.push(`context nearly exhausted: ${used} of ${context.tokens} tokens`);
  }
  const out = r.output;
  if (out) {
    const texts = [out.thesis, out.counter_thesis, out.exposure, out.liquidity_and_spread, ...(out.unknowns ?? []), out.confidence?.calibration_note, out.proposed_intent?.rationale];
    for (const t of texts) obs.push(...windowLabelIssues(t, items));
    obs.push(...buyPressureIssues(texts, items));
    for (const u of r.verification?.unmatched ?? []) obs.push(`number not found in the packet: ${u.value} (${u.field})`);
    for (const f of r.verification?.flags ?? []) obs.push(f);
    if (out.proposed_intent && !ROUND_TRIP_RE.test(`${out.exposure ?? ''}`)) obs.push('proposes an entry but exposure does not account for the round-trip spread cost (prompt rule 9)');
    if (r.intent?.status === 'INVALID') obs.push(`intent draft INVALID: ${(r.intent.errors ?? []).join('; ').slice(0, 300)}`);
  }
  return { lens: r.lens, status: r.status, stance: out?.stance ?? null, context_use: contextUse, observations: [...new Set(obs)] };
}

/** Reviewer-notes block for a smoke receipt. human: parsed --reviewer-notes JSON, or null. */
export function reviewerNotes(results, items, context, human = null) {
  return {
    generated_by: 'test/intel/smoke-review.js (deterministic checks; a reading aid, not a fact check)',
    status_semantics: 'Per-lens OK = schema-, evidence-id- and bracket-coherence-valid; NOT fact-checked. Read each output against packet_user_message.',
    context: context ?? null,
    per_lens: (results ?? []).map((r) => reviewLens(r, items, context ?? { tokens: null })),
    human: human ?? { status: 'NOT_REVIEWED', note: 'No human review attached (pass --reviewer-notes <file.json> to attach one).' },
  };
}
