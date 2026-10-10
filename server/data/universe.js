// Universe / segment definitions. These are CONFIGURATION, not market facts.
//
// Price tiers are computed AS-OF the replay clock from observed IEX prices (no prior close is available in
// IEX TOPS for non-IEX-listed securities). Market capitalisation is NOT verified in this build unless SEC
// EDGAR shares-outstanding facts are ingested; the UI says so.

export const PRICE_TIERS = Object.freeze({
  penny: { label: 'Penny tier', maxPriceU: 10_000, description: 'Latest observed IEX price < $1.00 (as-of replay clock)' },
  low: { label: 'Low-priced tier', maxPriceU: 50_000, description: 'Latest observed IEX price < $5.00 (as-of replay clock)' },
});

// Large-cap reference list: a user-editable configuration of well-known large issuers used for the
// "major market" comparison segment. Membership is an assumption, not a verified market-cap screen.
const DEFAULT_LARGE_CAP = ['AAPL', 'MSFT', 'NVDA', 'AMZN', 'GOOGL', 'META', 'TSLA', 'AVGO', 'JPM', 'V',
  'WMT', 'XOM', 'UNH', 'MA', 'COST', 'HD', 'PG', 'JNJ', 'BAC', 'ORCL'];

export function largeCapList() {
  const env = process.env.VECTOR_LARGECAP_LIST;
  if (env) return env.split(',').map((s) => s.trim().toUpperCase()).filter((s) => /^[A-Z][A-Z0-9.\-]{0,9}$/.test(s));
  return DEFAULT_LARGE_CAP;
}

// Broad-market benchmark ETFs (IEX-traded ETF prices; used only as a same-venue benchmark reference).
export const BENCHMARKS = Object.freeze(['SPY', 'QQQ', 'IWM', 'DIA']);

// IEX / industry test symbols that must never be treated as real issuers.
export const KNOWN_TEST_SYMBOLS = new Set(['ZEXIT', 'ZIEXT', 'ZXIET', 'ZVZZT', 'ZWZZT', 'ZXZZT', 'ZJZZT', 'ZBZX', 'ZTEST', 'ZVV', 'NTEST', 'ATEST', 'PTEST', 'CBO', 'CBX', 'IGZ']);

// Storage threshold: store every symbol whose observed price was ever below this during the day.
// This is a storage superset of any as-of tier (penny/low) so it cannot leak future information into the
// as-of universe: a symbol qualifies for an as-of tier only from the moment its observed price is below the tier.
// Reads outside the universe (bars, quotes, dossier, evidence) are gated separately in server/data/marketdata.js: a
// stored symbol is revealed only once its first sub-threshold observation is knowable (symbolVisibleAsOf), so whole-day
// storage does not turn "has data" into a hindsight signal. Retrospective studies remain conditioned on "ever below $5
// that day" (a documented selection bias of the stored set).
export const STORAGE_MAX_PRICE_U = PRICE_TIERS.low.maxPriceU;

export const SEGMENTS = Object.freeze({
  micro: { id: 'micro', label: 'Penny / microcap', tier: 'penny', note: 'Price-tier proxy for microcap. Market cap not verified.' },
  large: { id: 'large', label: 'Large-cap', tier: null, note: 'Configured large-cap reference list. Market cap not verified.' },
});
