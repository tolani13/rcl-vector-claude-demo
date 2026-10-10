// Default policy configuration for the deterministic policy gate (docs/CONTRACTS.md section 5).
//
// Every number here is an EXPLORATORY DEFAULT — NOT VALIDATED. They are configuration, not market facts, and
// they are shown to the user. The gate is deny-by-default: every rule in REQUIRED_RULES must be present in a
// portfolio's policy; a missing rule denies with RULE_MISSING:<name>.
import { defaultCostModel } from '../sim/fills.js';

export const POLICY_LABEL = 'EXPLORATORY DEFAULTS — NOT VALIDATED';
// v2: target_order_matches and protective_exit_required added; risk-increasing buy modifies pass the entry rules;
// open-buy reservations are priced conservatively (RESERVATION_UNKNOWN); warrants/rights/units denied by symbol pattern;
// unresolvable agent evidence refs denied (EVIDENCE_UNRESOLVED).
export const POLICY_VERSION = 2;

/** Issue types (derived from the symbol pattern, gate.issueTypeFromSymbol) whose entries symbol_allowed denies by default. */
export const DEFAULT_DENY_ISSUE_TYPES = Object.freeze(['warrant', 'right', 'unit']);

/**
 * Strategies whose at-entry stop is a documented open question (docs/OPEN_QUESTIONS.md #4, ambiguity id 'stop-at-entry'):
 * for these, protective_exit_required records "stop at/above the as-of bid" as INFORMATIONAL instead of denying, so the
 * owner's handwritten example still runs as documented. Every other agent entry needs a stop strictly below the bid.
 */
export const DOCUMENTED_STOP_AT_ENTRY_STRATEGIES = Object.freeze(['handwritten-notes-example']);

/** Every rule the gate evaluates, in evaluation order. All must exist in every policy config. */
export const REQUIRED_RULES = Object.freeze([
  'paper_only',
  'kill_switch',
  'agent_authority',
  'human_confirmed',
  'target_order_matches',
  'instrument_allowed',
  'symbol_allowed',
  'max_trade_spend_usd',
  'cash_sufficient',
  'no_short',
  'daily_loss_cap_usd',
  'max_open_positions',
  'max_position_pct_equity',
  'protective_exit_required',
  'order_rate_per_min',
  'market_hours',
  'quote_fresh',
  'max_spread_bps',
  'min_displayed_size',
  'intent_not_expired',
  'evidence_not_future',
  'tick_valid',
]);

// Lens appetites. Cowboy = aggressive, Pragmatist = moderate, Tightwad = very conservative.
const LENS_LIMITS = {
  cowboy: {
    maxTradeSpendUsd: { micro: 1000, large: 2000 }, dailyLossCapUsd: 1500, maxOpenPositions: 8, maxPositionPctEquity: 25,
    orderRatePerMin: 6, maxSpreadBps: { micro: 1500, large: 50 }, maxQuoteAgeMs: { micro: 300_000, large: 60_000 }, minDisplayedSize: { micro: 100, large: 100 },
  },
  pragmatist: {
    maxTradeSpendUsd: { micro: 500, large: 1000 }, dailyLossCapUsd: 750, maxOpenPositions: 5, maxPositionPctEquity: 15,
    orderRatePerMin: 4, maxSpreadBps: { micro: 800, large: 30 }, maxQuoteAgeMs: { micro: 180_000, large: 60_000 }, minDisplayedSize: { micro: 500, large: 100 },
  },
  tightwad: {
    maxTradeSpendUsd: { micro: 250, large: 500 }, dailyLossCapUsd: 300, maxOpenPositions: 3, maxPositionPctEquity: 8,
    orderRatePerMin: 2, maxSpreadBps: { micro: 400, large: 15 }, maxQuoteAgeMs: { micro: 120_000, large: 30_000 }, minDisplayedSize: { micro: 1000, large: 200 },
  },
};

const SANDBOX_LIMITS = {
  maxTradeSpendUsd: 2500, dailyLossCapUsd: 2500, maxOpenPositions: 10, maxPositionPctEquity: 50, orderRatePerMin: 10,
  maxSpreadBps: defaultCostModel('micro').maxSpreadBps, maxQuoteAgeMs: defaultCostModel('micro').maxQuoteAgeMs, minDisplayedSize: 1,
};

function buildRules({ agentsAllowed, humanTradingAllowed, requireSegmentUniverse, spend, dailyLoss, maxOpen, maxPct, rate, spread, quoteAge, minSize }) {
  return {
    paper_only: { value: true, note: 'Constant. There is no live-broker path in this build.' },
    kill_switch: { humanCancelAllowed: true, note: 'While engaged, every intent is denied except human cancels.' },
    agent_authority: { allowAgents: agentsAllowed, requireState: 'RUNNING', requireGrant: true, note: 'Agent must be RUNNING and hold a grant for this portfolio + action.' },
    human_confirmed: { requireConfirm: true, humanTradingAllowed, note: 'Human orders need confirm===true; humans trade only the sandbox (cancels allowed anywhere).' },
    target_order_matches: {
      value: true,
      note: 'A modify/cancel must name an order of this replay session and portfolio with the same symbol, instrument kind and side '
        + '(agents: their own order); otherwise TARGET_ORDER_MISMATCH.',
    },
    instrument_allowed: { equity: true, option: 'ONLY_IF_VERIFIED_OPTIONS_DATA', note: 'Long puts only, and only with a verified options provider quote.' },
    symbol_allowed: {
      requireSegmentUniverse, allow: [], deny: [], blockTestSymbols: true, denyIssueTypes: [...DEFAULT_DENY_ISSUE_TYPES],
      note: 'Entries and risk-increasing buy modifies: must be in the segment universe as-of the replay clock; warrants, rights and units '
        + '(issue type from the symbol pattern only: IEX suffix + ^ =, ACT .W/.R/.U, Nasdaq 5-letter W/R/U; never the post-dated directory) are denied.',
    },
    max_trade_spend_usd: { value: spend, note: 'Estimated cost incl. slippage and fees.' },
    cash_sufficient: {
      includeSlippageAndFees: true, reserveOpenBuyOrders: true,
      note: 'Cash minus a conservative reservation for every other open buy: limit price; else max(stop, as-of IEX ask) + slippage and the recorded '
        + 'submission/gate estimate (the larger); fees included; never more than the order\'s spend cap; no price and no cap => RESERVATION_UNKNOWN.',
    },
    no_short: { value: true, note: 'Sell qty may never exceed held qty.' },
    daily_loss_cap_usd: { value: dailyLoss, note: 'Blocks new entries and risk-increasing buy modifies once (day-start equity - current equity) reaches the cap.' },
    max_open_positions: { value: maxOpen },
    max_position_pct_equity: { value: maxPct, note: 'Held value + pending buys in the same symbol (reserved like cash_sufficient) + this order, as % of equity.' },
    protective_exit_required: {
      value: true, informationalStrategyIds: [...DOCUMENTED_STOP_AT_ENTRY_STRATEGIES],
      note: 'Agent equity entries must attach a valid-tick stop_loss_px_u strictly below the as-of IEX bid (PROTECTIVE_EXIT_MISSING / '
        + 'STOP_AT_OR_ABOVE_BID). Exception: the documented handwritten-notes example (at-entry stop, docs/OPEN_QUESTIONS.md #4) is recorded '
        + 'as informational, not denied. Human sandbox orders and long puts (loss capped at the premium) are not applicable.',
    },
    order_rate_per_min: { value: rate, note: 'Risk-increasing intents only; counts every order created in the portfolio in the last minute (bracket children included). Exits and cancels are never rate-limited.' },
    market_hours: { regularSessionOnly: true, note: 'Regular session 09:30-16:00 ET only (early closes not modelled).' },
    quote_fresh: { maxQuoteAgeMs: quoteAge, requireTwoSided: true, rejectHalted: true },
    max_spread_bps: { value: spread, note: 'Applied to risk-increasing intents; exits are not trapped by spread filters.' },
    min_displayed_size: { value: minSize, note: 'Displayed IEX ask size (shares) required for entries.' },
    intent_not_expired: { value: true },
    evidence_not_future: {
      value: true,
      note: 'All intent timestamps and every resolvable evidence ref must be <= replay clock; agent (rules/model) refs that cannot be resolved '
        + 'to stored evidence or a stored IEX minute are denied (EVIDENCE_UNRESOLVED). Human intents may omit or leave refs unresolved.',
    },
    tick_valid: { rule: 'REG_NMS_612' },
  };
}

function agentPolicy(lens, segment) {
  const L = LENS_LIMITS[lens];
  return {
    id: `policy:${lens}-${segment}`, version: POLICY_VERSION, label: POLICY_LABEL, portfolio_id: `${lens}-${segment}`, lens, segment,
    rules: buildRules({
      agentsAllowed: true, humanTradingAllowed: false, requireSegmentUniverse: true,
      spend: L.maxTradeSpendUsd[segment], dailyLoss: L.dailyLossCapUsd, maxOpen: L.maxOpenPositions, maxPct: L.maxPositionPctEquity,
      rate: L.orderRatePerMin, spread: L.maxSpreadBps[segment], quoteAge: L.maxQuoteAgeMs[segment], minSize: L.minDisplayedSize[segment],
    }),
  };
}

function sandboxPolicy() {
  const S = SANDBOX_LIMITS;
  return {
    id: 'policy:sandbox', version: POLICY_VERSION, label: POLICY_LABEL, portfolio_id: 'sandbox', lens: null, segment: null,
    rules: buildRules({
      agentsAllowed: false, humanTradingAllowed: true, requireSegmentUniverse: false,
      spend: S.maxTradeSpendUsd, dailyLoss: S.dailyLossCapUsd, maxOpen: S.maxOpenPositions, maxPct: S.maxPositionPctEquity,
      rate: S.orderRatePerMin, spread: S.maxSpreadBps, quoteAge: S.maxQuoteAgeMs, minSize: S.minDisplayedSize,
    }),
  };
}

function deepFreeze(o) {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o)) deepFreeze(v);
  }
  return o;
}

/** Frozen default policies keyed by portfolio id (six agent portfolios + sandbox). */
export const DEFAULT_POLICIES = deepFreeze(Object.fromEntries([
  ...['micro', 'large'].flatMap((seg) => ['cowboy', 'pragmatist', 'tightwad'].map((lens) => [`${lens}-${seg}`, agentPolicy(lens, seg)])),
  ['sandbox', sandboxPolicy()],
]));

/** A fresh, mutable copy of the default policy for a portfolio id, or null if the id is unknown (=> gate denies). */
export function defaultPolicyFor(portfolioId) {
  const p = DEFAULT_POLICIES[portfolioId];
  return p ? structuredClone(p) : null;
}

/** All default policies as a plain mutable object (for display / export). */
export function allDefaultPolicies() {
  return structuredClone(DEFAULT_POLICIES);
}
