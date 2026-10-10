# VECTOR internal contracts (build-time spec)

This file is the binding interface spec shared by every module. Code must match it; if a contract must
change, change this file in the same commit.

*Reconciled against the code on 2026-10-09 (review round 2, docs area). Every statement below was checked against the
named source file. Items that reviewers asked for but that are not in the code are listed as MISSING or BLOCKED in §10,
not described as if they existed.*

Stack: Node >= 22.13, ES modules, **no runtime npm dependencies** except the optional `@anthropic-ai/sdk`
(dynamically imported only by the Anthropic adapter). Storage: `node:sqlite` via `server/db.js`. Tests:
`node:test` + `node:assert/strict` under `test/` (`npm test`). Front-end: vanilla ES modules, no build step.

## 0. Non-negotiable data-truth rules (from the frozen prompt v1.3)

* Only seed money is fictional. Never fabricate tickers, prices, quotes, volumes, news, filings, analyst views,
  catalysts, benchmark histories or agent confidence anywhere in product code, product UI, receipts or docs.
* Product code never contains literal market observations. Fixtures/mocks live ONLY in `test/` and are labelled
  `TEST FIXTURE — NOT MARKET DATA`. Product code must not import from `test/`.
* When data is unavailable: return/display an explicit status (`NO_VERIFIED_DATA`, `BLOCKED`, `PROVIDER_FAULT`,
  `MODEL_DISCONNECTED`, `ASSESSMENT_NOT_RUN`, `NO_VERIFIED_OPTIONS_DATA`, `UNAVAILABLE_NOT_VERIFIED`) — never a placeholder value.
* As-of: every agent/assessment/as-of-view read of market data goes through `server/data/marketdata.js` with the
  replay clock as `asOf`. A minute row `[t, t+60s)` is knowable at `t + 60000`. Evidence is knowable at `knowable_ts`.
  A stored symbol is revealed only once its first qualifying (sub-$5) minute is complete (`symbolVisibleAsOf`), so
  "has stored data" is not a hindsight signal. Nothing knowable after the replay clock reaches agents, assessments or
  as-of views; the retrospective study is the single labelled exception and is withheld until the session close (§9).
* Paper fills are estimates (`fills.estimated = 1`), never exchange executions; every fill records its model id and
  explicit assumptions plus the observed quote/trade data used.
* No live-broker code path exists. `paperOnly` is a constant `true`; there is no setting to change it.
* Real brokerage accounts are **read-only** (§4b): data class `REAL_ACCOUNT`, source `SNAPTRADE`. No order, trade or cancel call to SnapTrade
  exists, no such route exists under `/api/real/`, and real holdings never feed paper accounts, agents, the gate or the evidence store.
* $0 budget (§8a): a model preset whose `cost` is not `free` is refused (BLOCKED `PAID_PROVIDER_BLOCKED`) unless the owner sets
  `VECTOR_ALLOW_PAID=1`; the legacy `VECTOR_MODEL_PROVIDER` path gets the same guard.

### Status vocabulary (exact strings, used by API and UI)

Data: `LIVE_VERIFIED` | `DELAYED_REAL` | `HISTORICAL_REAL` | `IMPORTED_UNVERIFIED` | `NO_VERIFIED_DATA` | `PROVIDER_FAULT` | `BLOCKED`
(`server/data/sources.js` `DATA_STATUS`). A truncated (partial) IEX day stays `HISTORICAL_REAL` and is labelled with its coverage end.
Feed provider configuration (`GET /api/sources`, market_feed rows' notes): `NOT_CONFIGURED` | `CONFIGURED_UNVERIFIED`; their data status stays `NO_VERIFIED_DATA` until a human-run verification (`POST /api/feeds/verify`) succeeds in this server process.
Feed verification result: `LIVE_VERIFIED` | `DELAYED_REAL` | `NO_VERIFIED_DATA` | `PROVIDER_FAULT` (live); `SUPPORTED_VERIFIED` | `NO_VERIFIED_OPTIONS_DATA` (options).
Model: `CONNECTED` | `DISCONNECTED` | `FAULT`  (UI text: "MODEL DISCONNECTED / ASSESSMENT NOT RUN"). Provider kind (`/api/status` `model.kind`, the adapter that makes the calls): `anthropic` | `openai-compatible` | `ollama` | `none`; `model.endpointFamily` is `ollama` for the native adapter and for an OpenAI-compatible endpoint on port 11434, else null.
Assessment run (`runLensAssessments`): `COMPLETED` | `MODEL_DISCONNECTED` | `FAULT` (provider configuration fault) | `CALL_CAP_REACHED` (scope `session` | `rolling_24h` | `preset_per_minute` | `preset_per_day`) | `BLOCKED` (code `REPLAY_BEFORE_MODEL_CUTOFF` | `MODEL_TRAINING_CUTOFF_UNKNOWN` | `REAL_DATA_PRIVACY_BLOCK`) | `NO_VERIFIED_DATA`.
Model provider BLOCKED codes (presets, §8a; status text `BLOCKED: <code> — <detail>`): `PAID_PROVIDER_BLOCKED` | `NO_API_KEY` | `MODEL_NOT_SET` | `MODEL_INVALID` | `PRESET_MODEL_NOT_FREE` | `PRESET_MODEL_NOT_LISTED` | `LOCAL_PRESET_CLOUD_MODEL` | `PRESET_UNKNOWN` | `SELECTION_INVALID`. A preset's local limit refuses a call with errorKind `LOCAL_RATE_LIMIT` (nothing sent).
Real accounts (§4b; label exactly `REAL ACCOUNT — READ ONLY`): `BLOCKED` (code `SNAPTRADE_NOT_CONFIGURED`, UI text `BLOCKED: SNAPTRADE_NOT_CONFIGURED`) | `READY` | `SYNCED` | `NOT_SYNCED`; sync runs `OK` | `FAILED` (error code `SNAPTRADE_*`).
Per-lens result: `OK` (schema-, id- and coherence-valid; not fact-checked) | `INVALID_OUTPUT` | `REFUSED` | `ERROR`, each with an `errorKind` (null when OK; `NOT_RUN` for a lens skipped after a failure that never reached a model).
Stored assessments (API/dossier): `STORED` | `ASSESSMENT_NOT_RUN`.
Options: `NO_VERIFIED_OPTIONS_DATA` (operational) | `SUPPORTED_VERIFIED` (only when a real options provider returned contracts + an OPRA quote in this process; wall-clock status only — replay options orders stay `NO_VERIFIED_OPTIONS_DATA`)
Agent state: `PAUSED` | `RUNNING` | `FAULTED` | `BLOCKED` | `STOPPED`
Order status: `pending_parent` | `working` | `triggered` | `partially_filled` | `filled` | `cancelled` | `expired` | `rejected` | `unfillable`
(`unfillable` is a fill-model result, not a stored order status in this build: an unfillable minute journals `FILL_WITHHELD` and the order stays open.)
Replay state (`engine.getState().status`): `NO_SESSION` | `NO_VERIFIED_DATA` | `READY` | `SESSION_CLOSED`. A partial dataset's replay is marked `truncated` (§7).
Portfolios (`GET /api/portfolios`): `status` `PAPER` (or `NO_VERIFIED_DATA` / `NO_SESSION`), `marksStatus` from the data vocabulary.
Position marks: `markBasis` `IEX_BID` | `LAST_TRADE_NO_BID` | `UNMARKED` | `VERIFIED_OPTIONS_BID`; `equityBasis` `CASH_PLUS_IEX_BID_MARKS` | `CONSERVATIVE_UNMARKED_POSITIONS_AT_ZERO`.
Retrospective study: `BLOCKED` with `reason: 'WITHHELD_UNTIL_CLOSE'` while the replay clock is before the session close.

## 1. Units & helpers (already implemented — do not reimplement)

* `server/util/money.js`: prices/money are integer **u = 1e-4 USD**. `usdToU`, `uToUsd`, `fmtUsd`, `notional`,
  `applyBps(priceU, bps, side)` (rounds against trader), `isValidTick` (Reg NMS 612: >= $1 → $0.01 ticks; < $1 → $0.0001),
  `roundToTick(priceU, side)`.
* `server/util/time.js`: `MINUTE`, `etParts`, `etMinuteOfDay`, `etToUtc(dateStr, hh, mm)`, `fmtEt`, `isRegularSession`, `floorMinute`.
* `server/util/ids.js`: `newId(prefix)`, `sha256Hex`, `stableStringify`.
* `server/db.js`: `openDb(path?)`, `closeDb(path)`, `tx(db, fn)`. Schema is authoritative there.
* `server/journal.js`: `append(db, {session_id, ts_sim, portfolio_id, agent_id, actor, type, ref_id, payload})`,
  `verifyChain(db)`, `verifyChainFrom(db, checkpoint)` (incremental from a verified `{seq, hash, checked}`; full walk otherwise),
  `list(db, {session_id, portfolio_id, agent_id, type, exclude_types, limit<=1000, before, visible_at})`. `visible_at: {session_id, clock}` hides
  rows of OTHER sessions whose `ts_sim` is after `clock`; `exclude_types` drops those event types in SQL.
* `server/data/marketdata.js`: `listMarketDatasets` (rows carry `complete` and, for partial datasets, `coverage_end`), `getDataset`,
  `sessionWindow(db, ds) -> {open, close, tradeDate}`, `coverageEndMs(db, ds)`, `symbolVisibleAsOf`, `barsAsOf(db, ds, sym, asOf, {from, limit})`,
  `statusAsOf`, `quoteAsOf(db, ds, sym, asOf)`, `lastTradeAsOf`, `fillMinute(db, ds, sym, t, clock)`, `tradeBreaksAsOf`,
  `universeAsOf(db, ds, asOf, 'micro'|'large'|'low')`, `windowAggregatesAsOf(db, ds, asOf, {windowMin, sessionOpen, syms})`,
  `closeAtOrBefore(db, ds, sym, t, asOf)`, `relativeVolume` / `relativeVolumeInfo` with `RELVOL_DEFINITION`
  (`RELVOL_MIN_BASELINE_MIN` 15, `RELVOL_THIN_BASELINE_SHARES` 1000), `macroAsOf(db, asOf)`.
* `server/data/universe.js`: `PRICE_TIERS` (penny < $1.00, low < $5.00), `largeCapList()` (`VECTOR_LARGECAP_LIST` overrides the
  20-name default), `BENCHMARKS` (SPY, QQQ, IWM, DIA), `SEGMENTS`, `KNOWN_TEST_SYMBOLS`, `STORAGE_MAX_PRICE_U`.

`quoteAsOf` returns `{sym, bid, ask, bidSize, askSize, quoteTs, ageMs, twoSided, spreadU, spreadBps, mid, halted, tradingStatus, extendedSession, source:{ds, venue, minuteRowT}}`
or `null` (no quote yet, symbol not yet visible, or `asOf` past a partial dataset's coverage end).
`fillMinute` returns `{sym, t, hasRow, trades:{o,h,l,c,v,n,vwap}|null, startQuote, endQuote, minBid, maxBid, minAsk, maxAsk, halted, unavailable}`,
plus `tradesWithheld:'TRADE_BREAK'` and `tradeBreaks[]` when a later IEX trade break for a print in minute `t` is knowable at
`clock` (then `trades` is `null`), and `coverageEnd` + `note: 'DATASET_TRUNCATED…'` with `unavailable: true` for minutes after a
partial dataset's coverage end. It throws on look-ahead (`t + 60s > clock`).

## 2. Fill model `iex-conservative-minute-v1` (server/sim/fills.js — pure functions)

Market data is IEX top-of-book + IEX trades aggregated per minute. Decisions happen at minute boundaries (the
replay clock C). An order submitted at clock C is first eligible in minute `[C, C+60s)`, evaluated after that
minute completes. Conservative = assume the worst price observed within the minute.

Cost model (`defaultCostModel(segment)`; all overridable, all shown in UI and recorded on each fill). `segment` `'large'` gives the
large values; anything else (`'micro'`, `null`, sandbox) gives the micro values, and `requestedSegment` records what was asked:
`{ model, segment, requestedSegment, label: 'EXPLORATORY ASSUMPTIONS — NOT VALIDATED', priceBasis: 'WORST_IN_MINUTE',
   slippageBps: micro 50 / large 5, commissionPerOrderU: 0 (charged once per order, on its first fill),
   secFeeRatePerMillionUsd: 27.8 (sells only, assumption — verify current SEC Section 31 rate),
   tafPerShareU: 1.66 (=$0.000166/share, equity sells only), tafCapU: 83000 (= $8.30, assumption),
   maxQuoteAgeMs: micro 300000 / large 60000, maxSpreadBps: micro 1500 / large 50,
   displayedSizeCap: true, notes }`

**Cost-model segment.** `costSegmentFor(portfolioSegment, sym)`: agent portfolios use their own segment; the manual sandbox
(segment `null`) uses `large` for symbols on `largeCapList()` and `micro` otherwise; option orders use `micro`. The same rule is used
by the gate estimate (`gate.buildGateContext` / `costModelOf`), the fill engine (`orders.costModelFor`) and the sandbox API
(`trading.sandboxCostSegment`, recorded as order `meta.cost_segment`).

Fees are rounded UP to whole u, per component (`computeFees(side, qty, priceU, cm, {multiplier, firstFill, kind})`). Omitted effects
(`OMITTED_EFFECTS`, always listed in `assumptions.omitted`): queue position, hidden/odd-lot liquidity, NBBO vs IEX BBO differences,
other venues, partial-fill dynamics inside the minute, market impact beyond slippage, borrow/locate (never needed: no shorting),
corporate actions on the replay day, options exercise/assignment, and IEX trade breaks arriving after the trade minute (the minute's
aggregates are not corrected; once a break is knowable, that minute's trade evidence is withheld).

`evaluateOrder(order, minute, costModel, ctx) -> result` where `minute` is a `fillMinute()` object and
`ctx = { cashU, positionQty, ds?, multiplier?, consumed?:{DISPLAYED?, TRADE_THROUGH?}, maxSpendU?, spentU? }`
(`consumed` = shares earlier fills of the same portfolio, symbol and side already took in this minute, per size source;
`maxSpendU` / `spentU` = the buy order's spend cap and what its earlier fills spent, `qty*price*mult + fees`). Result is one of:
* `{ action: 'none', note }` — `NOTHING_REMAINING`, `STOP_NOT_TRIGGERED`, `LIMIT_NOT_REACHED`
* `{ action: 'trigger' }` — a stop-limit triggered this minute but its limit was not reached (a stop that also fills returns `{action:'fill', triggered:true, ...}`)
* `{ action: 'fill', qty, priceU, feesU, triggered?, worseThanStop?, slippageFromStopU?, assumptions, observed }`
* `{ action: 'unfillable', reason, triggered?, spendCapReached?, observed }` — cannot be credibly modelled this minute. Reasons:
  `HALTED`, `UNAVAILABLE`, `NO_TWO_SIDED_QUOTE`, `STALE_QUOTE` (decision quote older than `maxQuoteAgeMs` at the minute end),
  `NO_POSITION_HELD`, `NO_VALID_TICK_PRICE`, `NO_DISPLAYED_SIZE_AT_MINUTE_START`, `ZERO_DISPLAYED_SIZE`,
  `DISPLAYED_SIZE_CONSUMED_THIS_MINUTE`, `TRADE_THROUGH_SIZE_CONSUMED_THIS_MINUTE`, `SPEND_CAP_AT_ESTIMATED_PRICE`,
  `INSUFFICIENT_CASH_AT_ESTIMATED_PRICE`, `UNSUPPORTED_ORDER_TYPE:<type>`. A stop's trigger is evaluated from whatever was observed,
  so `unfillable` may carry `triggered: true`. Never manufacture a fill.

Data checks, in order: halted → `HALTED`; `unavailable` → `UNAVAILABLE`; no two-sided quote in the minute (all of min/max bid/ask)
or at the decision point (`endQuote ?? startQuote`) → `NO_TWO_SIDED_QUOTE`; `t + 60s − decisionQuote.quoteTs > maxQuoteAgeMs` → `STALE_QUOTE`.

Rules (equity; `p(x)` = `slippedPrice(x, side, slippageBps)` = `applyBps` then `roundToTick`, both against the trader):
* **Market BUY**: base = `maxAsk` (worst two-sided ask in minute incl. carried-in state); price `p(maxAsk)`. **Market SELL**: base = `minBid`; price `p(minBid)`.
* **Limit BUY @L**: if `maxAsk <= L` → price `min(L, p(maxAsk))` (size source DISPLAYED); else if trades exist and `trades.l < L`
  (strict trade-through) → price L (size source TRADE_THROUGH); else none.
* **Limit SELL @L (take-profit)**: if `minBid >= L` → price `max(L, p(minBid))`; else if `trades.h > L` (strict) → price L (TRADE_THROUGH); else none.
* **Stop SELL @S (stop-loss)** triggers if `minBid <= S` or (trades and `trades.l <= S`) or `startQuote.bid <= S`. In the trigger minute it is a
  market sell at `p(min(S, minBid))`; in later minutes (already `triggered`, e.g. after an unfillable trigger minute) at `p(minBid)`.
* **Stop BUY @S** mirrors it: triggers on `maxAsk >= S`, `trades.h >= S` or `startQuote.ask >= S`; price `p(max(S, maxAsk))`, later `p(maxAsk)`.
* **Stop-limit (S, L)**: triggers as a stop, then behaves as a limit @L. In the trigger minute only the quote rule is used (no
  trade-through: the intra-minute order of trade and trigger is unknown); if the limit is not reached the result is `trigger`.
  Fill rules are prefixed `STOP_LIMIT_`.
* **`worseThanStop`** (type `stop` only) means the market GAPPED through the stop: for a sell, the base price before slippage
  `< S` or `startQuote.bid < S` (mirrored for buys). Slippage alone is not a gap. The distance of the fill from S including
  slippage is reported separately as `slippageFromStopU` (`S − priceU` for sells, `priceU − S` for buys). Stop-limits omit both.
* A price that is not a valid tick → `unfillable: NO_VALID_TICK_PRICE`.

Quantity (in this order):
1. `remaining = qty − filled_qty`.
2. Displayed-size cap (`displayedSizeCap !== false`; requires `startQuote`): the displayed size on the order's side at the minute
   start (`askSize` for buys, `bidSize` for sells). For a TRADE_THROUGH fill the size is `min(that displayed size, minute IEX volume)`
   (`tradeThroughSizeProxy`): the prints through the limit cannot be separated from the minute aggregate. Zero → `ZERO_DISPLAYED_SIZE`.
   What earlier fills of the same portfolio, symbol and side already took this minute (`ctx.consumed[sizeSource]`) is subtracted;
   nothing left → `*_CONSUMED_THIS_MINUTE`. `qtyLimitedBy` records `DISPLAYED_SIZE`, `TRADE_THROUGH_DISPLAYED_SIZE_PROXY` or `DISPLAYED_SIZE_REMAINING`.
3. Sells: never more than `positionQty` (`POSITION_HELD`).
4. **Spend cap** (buys with a finite `ctx.maxSpendU`): `capQty = floor((maxSpendU − spentU − commissionU) / (priceU × mult))`; if it binds,
   `qtyLimitedBy` gets `SPEND_CAP`; zero → `unfillable: SPEND_CAP_AT_ESTIMATED_PRICE` with `spendCapReached: true`. A fill never takes the
   order's total spend above `maxSpendU` at the estimated fill price.
5. Cash (buys): if `qty × price × mult + fees > cashU` → the largest affordable whole qty (`CASH_AT_ESTIMATED_PRICE`); zero →
   `unfillable: INSUFFICIENT_CASH_AT_ESTIMATED_PRICE`.

**Spread recording.** Every fill records `maxSpreadBps` (from the cost model), `spreadAtStartBps` and `spreadAtEndBps` (bps of the mid) and
`warnings: ['SPREAD_ABOVE_COST_MODEL_MAX']` when the wider of the two exceeds `maxSpreadBps`. This is a flag, not a refusal: admission
is decided by the gate's `max_spread_bps` rule at submission.

Each fill's `assumptions`: `model, estimated, notExchangeExecution, segment, requestedSegment, priceBasis, rule, basePriceU, slippageBps, tickRule,
fees{commissionU, secFeeU, tafU, totalU, rounding, commissionPerOrderU, secFeeRatePerMillionUsd, tafPerShareU, tafCapU}, displayedSizeCap,
sizeSource, displayedSizeUsed, displayedSizeAtMinuteStart, consumedEarlierThisMinute, tradeThroughSizeProxy?, minuteVolume?, qtyRequested,
qtyLimitedBy[], affordabilityReduced, spendCap?{maxSpendU, spentBeforeU}, multiplier, maxQuoteAgeMs, maxSpreadBps, spreadAtStartBps,
spreadAtEndBps, warnings[], omitted[]`. `observed`: `{ds, venue:'IEX', sym, minuteT, hasRow, startQuote, endQuote, minBid, maxBid, minAsk, maxAsk,
trades, halted, unavailable}`.

**Per-minute displayed-size consumption** (`orders.processMinute`): consumption is tracked per `portfolio_id | instrument_id | side` and per
size source within one minute, so a second order of the same portfolio in the same minute only gets what earlier fills left. The seven
portfolios are independent counterfactual books: each sees the full IEX displayed size.

**Spend cap source** (`orders.submitOrder`): every buy records `meta.maxSpendU = min(portfolio policy max_trade_spend_usd, budget_usd of the stored
intent named by spec.intent_id (same session and portfolio), caller meta.maxSpendU)` plus `meta.spendCap {maxSpendU, source, candidates}`.
When the cap binds on a fill, or no whole share fits under it, the order's unfilled remainder is cancelled (`ORDER_CANCELLED`, reason
`SPEND_CAP_REACHED`) instead of waiting for a cheaper price.

**OCO**: if two OCO siblings would both execute in the same minute (two fills, or an active stop plus another fill), the **stop-loss executes
first** (conservative), the other would-be fill is discarded and `OCO_SAME_MINUTE_AMBIGUITY` is journaled with every candidate.

**Brackets** (`orders.js`): children (stop_loss as `stop`, take_profit as `limit`; OCO group `oco_<entry id>` when both exist) are created
`pending_parent` with the entry's qty. When the entry fills they become `working` with qty = the shares the bracket still holds
(entry filled qty minus what its children already sold, never more than the position), journaled `BRACKET_CHILD_ACTIVATED` with
`eligibleFromMinute = t + 60s` and, for sell stops, a `stopCheck` against the as-of IEX bid. Each bracket is evaluated as one unit with its
exits FIRST, so a qty increase from an entry fill in minute t applies from minute t+1 (`BRACKET_CHILD_QTY_UPDATED`) and a child never sells
shares bought in the same minute. Once a protective child executes (fully or partly), the entry's unfilled remainder is cancelled
(`PARENT_REMAINDER_CANCELLED_AFTER_PROTECTIVE_EXIT`). After every sell fill the open bracket children on that instrument are clamped to the
shares still held (`BRACKET_CHILD_QTY_UPDATED`, cause `POSITION_REDUCED`); with nothing held every open sell on it is cancelled
(`POSITION_CLOSED`). A partially filled OCO member shrinks its siblings (`OCO_SIBLING_REDUCED`); a fully filled one cancels them (`OCO_SIBLING_FILLED`).

**Sell stop vs bid** (`stopCheck`): for a sell stop / stop-limit the engine journals `{stopAtOrAboveBid, stopPxU, bidU, stopVsBidBps}` on
`ORDER_SUBMITTED`, `BRACKET_CHILD_ACTIVATED` and `ORDER_REPLACED`, plus `warning: 'STOP_MARKETABLE_AT_<SUBMIT|ACTIVATION|REPLACE>'` when the stop
is at or above the as-of IEX bid (it will trigger on its first evaluated minute). This is recorded, not refused (OPEN_QUESTIONS #4).

DAY orders expire at session close (16:00 ET). Each fill's journal row (`FILL_ESTIMATED`) carries `assumptions`, `observed`, `triggered`,
`worseThanStop` and, for stops, `slippageFromStopU`.

Options (`server/sim/options.js`): long puts only. `validateContract({occ, underlying, expiry, strike, right:'P', multiplier:100})`;
`premiumCost` = premium × 100 × contracts + fees; max loss = everything paid; `expirationValue(contract, underlyingPriceU, contracts)` =
max(0, K − S) × 100 × contracts (cash value at expiration — real options are physically settled; exercise/assignment NOT modelled);
`longPutOutcome` reports `worstCasePnlU = −totalCostU`. `validateOptionsQuote` accepts only a `SUPPORTED_VERIFIED`, contract-matching,
two-sided, knowable (`quoteTs <= clock`) quote at most 5 minutes old. `evaluateOptionOrder` (model `verified-options-quote-conservative-v1`):
buys pay ask + slippage rounded up to a whole cent, sells take bid − slippage rounded down; limit, displayed contracts, spend cap and cash ×100
apply. Operational options orders are rejected with `NO_VERIFIED_OPTIONS_DATA` unless a real options provider returned the contract and an
as-of quote. Long-put arithmetic, the paper buy, the mark at the bid and cash-value expiration (`ledger.settleLongPutAtExpiration`) are
tested with TEST FIXTURE contracts in `test/sim/options.test.js` (journal sample `receipts/journal-samples/fixture-sim-long-put-example.json`);
no provider is wired into the replay and expiration is never called automatically (`optionsStatus().notImplemented`).

## 3. Ledger (server/sim/ledger.js)

* `PORTFOLIO_DEFS` / `PORTFOLIO_IDS`: `cowboy-micro`, `pragmatist-micro`, `tightwad-micro`, `cowboy-large`, `pragmatist-large`,
  `tightwad-large`, `sandbox` (kind sandbox, lens null, segment null).
* `createSessionPortfolios(db, session_id, {startingCashU, clock})` creates the 7 portfolios (idempotent; journals `PORTFOLIO_CREATED`).
  `startingCashU` may be a number or a map by portfolio id. Default $10,000 each (configurable).
* `applyFill(db, {session_id, order, fill, journalExtra, ts_sim})` updates cash/position/realized P&L/fees atomically with the fill row, journals
  `FILL_ESTIMATED`. BUY: `cash -= qty*price*mult + fees`; position cost_basis += same. SELL: proceeds `qty*price*mult - fees`; realized +=
  proceeds − cost_basis × qty/posQty; cost_basis reduced pro-rata. Invariants enforced (throw): cash never < 0, qty never < 0, sell qty <= held.
* `markToMarket(db, ds, session_id, portfolio_id, asOf, {optionsProvider})` → positions marked at the **IEX bid as-of** (`IEX_BID`, conservative
  for longs); if no two-sided quote: last trade (`LAST_TRADE_NO_BID`); if neither: `UNMARKED`, value null. Options: verified provider bid
  (`VERIFIED_OPTIONS_BID`) or `UNMARKED` / `NO_VERIFIED_OPTIONS_DATA` (always, in the replay).
* `portfolioSummary(db, ds, session_id, portfolio_id, asOf)` → `{portfolio:{id, session_id, name, lens, segment, kind, startingCashU, dayStartEquityU},
  asOf, cashU, equityU, equityBasis, unrealizedU, realizedU, feesU, unmarkedCount, positions[], openOrders[]}`. UNMARKED positions count as 0 equity.
* `settleLongPutAtExpiration(db, {session_id, portfolio_id, instrument_id, clock, underlying})` — cash-value settlement at/after 16:00 ET on
  expiry with an underlying price knowable at the clock; journals `OPTION_EXPIRED`. Not called by the replay engine.

## 4. Orders engine (server/sim/orders.js)

* `submitOrder(db, ctx, spec)` — validates (`validateOrderSpec`: unknown fields, tick size, positive integer qty, side/type/role combos,
  protective flag derived from role, `attach` only on buy entries, `meta.maxSpendU` positive integer on buys only), then business checks
  (portfolio exists, dataset and session window, `SESSION_CLOSED`, `NO_SHORT_SELL_EXCEEDS_HELD`, `PARENT_*`, `EXPIRY_IN_PAST`). Inserts the
  `orders` row (`working`, or `pending_parent` for a child of an unfilled entry), records `meta.tif`, `meta.maxSpendU` / `meta.spendCap`, the
  submission estimate `meta.submitEstimate` (buys), `meta.time_exit` (from `attach.time_exit_min`, monitored by the agent runner) and
  `meta.requestedExpiresTs`; journals `ORDER_SUBMITTED` with quote provenance (and `ORDER_REJECTED` on refusal; a business refusal with a known
  portfolio inserts a `rejected` row).
* Roles: `entry` (buy), `stop_loss` (sell stop/stop_limit), `take_profit` (sell limit), `time_exit` (sell market/limit), `exit` (sell), `manual`.
  `protective` = role in {stop_loss, take_profit, time_exit}. Human sandbox sell stops are submitted as `stop_loss` (protective).
* **`expires_ts` / replay end**: DAY orders expire at the REPLAY END (`marketdata.replayWindowOf`): the 16:00 ET close, or a PARTIAL dataset's
  coverage end (aligned down to a whole minute) when earlier; `submitOrder` refuses `SESSION_CLOSED` at/after that end. A caller-supplied
  `expires_ts` is floored to the minute and capped at the replay end; an order is only evaluated for minutes `[t, t+60s)` with
  `t + 60s <= expires_ts`. `meta.expiryBasis` records `SESSION_CLOSE` | `REPLAY_END_TRUNCATED` | `REQUESTED`, and `ORDER_EXPIRED` states it
  (order reason `DAY_ORDER_EXPIRED_AT_SESSION_CLOSE` | `DAY_ORDER_EXPIRED_AT_REPLAY_END` | `ORDER_EXPIRED_AT_REQUESTED_EXPIRY`, or
  `EXPIRED_AFTER_UNFILLABLE:<last reason>` when the last evaluation was withheld). `expireOpenAtReplayEnd(db, ctx, atTs, {reasonCode})` expires
  every order still open at the replay end whatever its recorded expiry (e.g. a session later found PARTIAL; reason `REPLAY_END_TRUNCATED`,
  `updated_ts = atTs`).
* `cancelOrder(db, ctx, orderId, {by, reason, agent_id, portfolio_id})` — any open status (`pending_parent`/`working`/`triggered`/`partially_filled`);
  pending children cascade (`PARENT_CANCELLED`); refusals journal `ORDER_CANCEL_REJECTED`.
* `replaceOrder(db, ctx, orderId, {stop_px, limit_px, qty, by, reason, agent_id, portfolio_id})` — same id; only `working`/`pending_parent`;
  qty never below `filled_qty`, a working sell's remaining qty never above held, a child never above its parent's qty. A pending entry's qty
  change cascades to its pending children, one `BRACKET_CHILD_QTY_UPDATED` per child (cause `PARENT_REPLACED`). Journals `ORDER_REPLACED` with
  before/after and `stopCheck`; refusals `ORDER_REPLACE_REJECTED`.
* `processMinute(db, ctx, t)` — requires `t` minute-aligned and `t + 60s <= ctx.clock` (look-ahead throws). One transaction per minute: expire due
  orders; snapshot `working`/`triggered`/`partially_filled` orders with `created_ts <= t`; **tie-break `ORDER BY created_ts, rowid`** (insertion
  order, never the random id); evaluate brackets exits-first and OCO groups together; apply fills through the ledger; activate/trim bracket
  children; journal `FILL_WITHHELD` for unfillable minutes, `STOP_TRIGGERED`, cancellations (`POSITION_CLOSED`, `SPEND_CAP_REACHED`, …); expire
  orders that cannot be evaluated again. A sell with nothing held is cancelled `POSITION_CLOSED` rather than evaluated.
* `ctx` = `{ session_id, ds, clock, costModels?, optionsProvider? }` (the replay engine passes no `optionsProvider`).

## 4b. Real accounts — REAL_ACCOUNT data class (server/data/providers/snaptrade.js, server/data/real-accounts.js, server/api/real.js)

The owner's own brokerage accounts through **SnapTrade Personal** (free, personal use), **read-only**. Never market data (never
`HISTORICAL_REAL`), never an input to paper accounts, agents, the policy gate or the evidence store.

* **Client** `createSnapTradeClient({env, fetchImpl})`. The closed list `READ_ONLY_OPERATIONS` is everything it can send:
  `POST /snapTrade/login` (Connection Portal link; body fixed to `{connectionType:'read'}`, data access only; link expires in 300 s),
  `GET /accounts`, `GET /accounts/{id}/balances`, `GET /accounts/{id}/positions/all` (then `/positions` on HTTP 404), and
  `GET /accounts/{id}/activities` (`startDate`, `endDate`, `offset`, `limit` 1000; at most 3 pages per account per sync; window
  `VECTOR_SNAPTRADE_ACTIVITY_DAYS`, default 365). Any other method or path is refused before a request is built. No connection-refresh call is
  wired (SnapTrade says manual refreshes may be billed): a sync reads SnapTrade's cached daily data.
* **Auth.** Base `VECTOR_SNAPTRADE_BASE_URL` (default `https://api.snaptrade.com/api/v1`; https only, http only for a loopback test server).
  Query `clientId` + `timestamp` (Unix seconds); header `Signature` = base64(HMAC-SHA256(consumerKey, canonical JSON
  `{content, path, query}`)), keys sorted at every level, no whitespace, `content` = JSON body or `null` (an empty object signs as `null`),
  `path` includes `/api/v1`, `query` is the raw query string as sent. Personal keys send no `userId`/`userSecret` and register no user;
  `VECTOR_SNAPTRADE_USER_ID` + `VECTOR_SNAPTRADE_USER_SECRET` are added only when both are set. Built-in `fetch` and `node:crypto`; no SDK.
* **Secrets** `VECTOR_SNAPTRADE_CLIENT_ID`, `VECTOR_SNAPTRADE_CONSUMER_KEY`, `VECTOR_SNAPTRADE_USER_ID`, `VECTOR_SNAPTRADE_USER_SECRET`: server
  environment only; presence flags only in responses; scrubbed (raw, percent-encoded and form-encoded) from every response body and every
  SnapTrade error; never in logs, journal rows, receipts, errors (errors name the operation, never the URL; a network error shows only a code
  like `ECONNREFUSED`) or git (`.env` is gitignored).
* **Storage** (one snapshot per sync; every row `source='SNAPTRADE'`, `data_class='REAL_ACCOUNT'` by CHECK constraint, `fetched_at` wall ms):
  `real_sync_runs`, `real_accounts` (account number masked to the last four characters), `real_balances`, `real_positions`,
  `real_transactions`. Amounts are the broker's decimals in the row's currency (not `u`). A failed sync stores a `FAILED` run and no rows. A sync
  writes no journal row. Lives only in the local (gitignored) DB.
* **Serving.** Only to a loopback peer of a loopback-bound server with no proxy headers (`x-forwarded-for`, `forwarded`, `x-real-ip`,
  `x-forwarded-host`, `cf-connecting-ip`): else 403 `REAL_DATA_LOOPBACK_ONLY` (always in `VECTOR_ALLOW_REMOTE` mode). Excluded from any static
  or public build: `web/` holds no real data, and the Real accounts view requests nothing on a non-loopback host.
* **Privacy rule.** Real-account data is never included in model input sent to a provider whose preset does not declare
  `trains_on_prompts: false` (in practice: local presets), unless the owner lists that preset in `VECTOR_REAL_DATA_ALLOW_PRESETS`. Refusal:
  403 / BLOCKED `REAL_DATA_PRIVACY_BLOCK` before anything real is read or sent (§8a, §9).

## 5. Policy gate (server/policy/gate.js) — deterministic, deny-by-default

`evaluate(intent, gctx) -> { decision: 'ACCEPTED'|'DENIED', reasons:[{code, detail}], checks:[{rule, pass, detail, code?, applicable?, evaluated?}], estimate, policy }`.
`evaluate` is pure (no DB, no wall clock). The intent is re-validated first (`intent_valid` check; invalid → `INTENT_INVALID`, every rule reported
not evaluated). Every rule in `REQUIRED_RULES` (`server/policy/config.js`) MUST exist in the policy config; a missing/undefined rule → DENY
`RULE_MISSING:<name>`. Any thrown error → DENY `GATE_ERROR`. Unknown or non-numeric facts fail the rule that needs them.

`REQUIRED_RULES` (`POLICY_VERSION` 2; 22 rules), in evaluation order. "Adds exposure" = an entry (`open`) or a risk-increasing buy modify
(`isBuyIncrease`: more than the target's remaining qty, a higher or new limit, or any change of a buy stop trigger; an unknown target counts as increasing).
1. `paper_only` — always true (`PAPER_ONLY_VIOLATION` otherwise).
2. `kill_switch` — engaged → deny everything except human cancels (`KILL_SWITCH_ENGAGED`; unknown state `KILL_STATE_UNKNOWN`).
3. `agent_authority` — agent intents: the agent is RUNNING and holds a grant for this portfolio, action and instrument kind. Not applicable to humans.
4. `human_confirmed` — human intents need `confirm === true` (`HUMAN_NOT_CONFIRMED`); humans place orders only in the sandbox, cancels anywhere
   (`HUMAN_TRADING_SANDBOX_ONLY`). Not applicable to agents.
5. `target_order_matches` — a modify/cancel must name an order of this replay session and portfolio with the same symbol, instrument kind and side
   (a modify also the same order type: it is priced and applied as the target's type); for agents, their own order (`TARGET_ORDER_MISMATCH`).
6. `instrument_allowed` — equity; option only with a verified as-of options quote (`NO_VERIFIED_OPTIONS_DATA`).
7. `symbol_allowed` — never an exchange test symbol (`SYMBOL_IS_TEST_ISSUE`). For intents that add exposure: allow/deny lists; warrants, rights and
   units are denied by symbol pattern only (`issueTypeFromSymbol`: IEX suffix `+` `^` `=`, ACT `.W`/`.WS`/`.WT`/`.R`/`.RT`/`.U`, Nasdaq 5-letter
   symbols ending W/R/U; never the post-dated directory) → `SYMBOL_ISSUE_TYPE_DENIED`; and the segment universe as-of the clock (`SYMBOL_NOT_IN_SEGMENT`).
8. `max_trade_spend_usd` — estimated cost incl. slippage + fees <= the policy cap and the intent's `budget_usd` (`BUDGET_EXCEEDED`, `NO_PRICE_ESTIMATE`).
9. `cash_sufficient` — estimated cost <= cash minus a conservative reservation for every other open buy: remaining × (the limit; else the larger of
   max(stop, as-of IEX ask) + slippage and the estimate recorded on the order, `meta.gate_estimate` / `meta.submitEstimate`) + fees, never more than
   that order's spend cap; an order with no price reserves its whole spend cap; with neither → `RESERVATION_UNKNOWN` (never $0). The reservation
   cannot be disabled.
10. `no_short` — sell qty <= held (`SHORT_SALE_NOT_ALLOWED`); not applicable to a modify of a pending bracket child (sized at activation, §2).
11. `daily_loss_cap_usd` — blocks intents that add exposure once day-start equity − current equity reaches the cap.
12. `max_open_positions` — entries only; counts held symbols plus pending entry orders.
13. `max_position_pct_equity` — intents that add exposure: (held value + pending buys in the same symbol, reserved as in `cash_sufficient` + this
    order) / equity.
14. `protective_exit_required` — agent equity entries must attach a valid-tick `stop_loss_px_u` strictly below the as-of IEX bid and, for a
    limit / stop-limit entry, strictly below its limit (`PROTECTIVE_EXIT_MISSING`, `STOP_AT_OR_ABOVE_BID`, `STOP_AT_OR_ABOVE_ENTRY_LIMIT`,
    `QUOTE_NOT_TWO_SIDED`). Exception: an agent running the documented `handwritten-notes-example` strategy (at-entry stop, `stop-at-entry`
    ambiguity, OPEN_QUESTIONS #4) passes the bid check with `informational: true` and the stop-vs-bid distance (its stop may sit AT, not above, an
    entry limit). Any other strategy with `stopLoss.basis: 'at_entry_ref'` is denied, so `planActions` skips such entries
    (`STOP_AT_OR_ABOVE_BID`, `strategies.documentedStopAtEntry`). Not applicable to human sandbox orders or long puts.
15. `order_rate_per_min` — risk-increasing intents only; counts every order row created in the portfolio in the last minute, bracket children
    included (OPEN_QUESTIONS A); exits and cancels are never rate-limited.
16. `market_hours` — regular session only, before the replay end (a PARTIAL dataset's coverage end when earlier than 16:00 ET); cancels any time.
17. `quote_fresh` — an observed, two-sided, unhalted IEX quote, not from the future, age <= `maxQuoteAgeMs`.
18. `max_spread_bps` and 19. `min_displayed_size` — risk-increasing intents only.
20. `intent_not_expired`.
21. `evidence_not_future` — `quote_ts` and `created_ts` <= clock; every resolvable evidence ref knowable <= clock (`EVIDENCE_FROM_FUTURE`); for
    agent (rules/model) intents every ref must resolve (`EVIDENCE_UNRESOLVED`); human refs may be free-form or absent.
22. `tick_valid` — every price on a Reg NMS 612 tick.

The buy estimate (`estimateBuy`) is as-of the clock: ask + slippage for market buys, the limit for limit/stop-limit, max(stop, ask) + slippage
for stops — for a modify, the TARGET's order type with the effective terms (new value, else the target's); qty from the intent, the target's remaining qty for a modify that leaves qty unchanged, or sized from `min(budget_usd,
max_trade_spend_usd)`. It is NOT a worst case; the fill-time spend cap (§2) bounds the real spend. `buildGateContext(db, {session_id, ds, clock,
intent, confirm, policy?, costModel?, universe?, kill?, quote?, optionsQuote?, evidenceIndex?, targetOrder?})` collects the facts as-of the clock:
portfolio summary with open orders, as-of quotes for other open market/stop buys (`openOrderQuotes`), the agent with grants and strategy facts
(`{id, stopLossBasis, ambiguityIds}`), kill state, as-of quote, segment membership, recent order count, cost model by `costSegmentFor`, session
window (`replayWindowOf`: close = the replay end), and the target order of a modify/cancel (same session and portfolio). Evidence refs are
always resolved by the gate itself (`resolveEvidenceRefs`: `iex-m1:<ds>:<SYM>:<t>` → `t + 60s` only when that minute row is stored; an
evidence-store id → `knowable_ts`, or its dataset's publication time when the row claims to be knowable earlier). A caller's `evidenceIndex`
can only make a ref the gate resolved knowable LATER; a ref only the caller resolves is never counted as resolved (agents: `EVIDENCE_UNRESOLVED`)
but is still denied `EVIDENCE_FROM_FUTURE` when its caller-known time is after the clock (`gctx.callerOnlyEvidence`). The agent runner passes no
index (it uses `resolveEvidenceRefs` for model refs too).
`journalDecision` writes `POLICY_ACCEPT` / `POLICY_DENY` with every check. Human sandbox orders pass the same gate.

Policies (`DEFAULT_POLICIES`, `defaultPolicyFor(pid)`): one per portfolio, labelled `EXPLORATORY DEFAULTS — NOT VALIDATED`. There is no
per-portfolio override API in this build (§10).

## 6. Intents (server/agents/intents.js)

`TradeIntent` = `{ id?, source:'rules'|'model'|'human', agent_id|null, portfolio_id, strategy_id|null,
  action:'open'|'close'|'modify'|'cancel', instrument:{kind:'equity'|'option', sym, contract?},
  side:'buy'|'sell', qty?:int, budget_usd?:number, order_type:'market'|'limit'|'stop'|'stop_limit',
  limit_px_u?:int, stop_px_u?:int,
  attach?:{ stop_loss_px_u?:int, take_profit_px_u?:int, time_exit_min?:int, time_exit_band_bps?:int },
  target_order_id?:string, rationale:string(<=2000), evidence_refs:string[](<=50), quote_ts:int, created_ts:int, expires_ts:int }`.
`instrument.sym` matches `^[A-Z][A-Z0-9.-]{0,9}` with an optional IEX issue-type suffix `[+^=#][A-Z0-9]{0,2}` (the orders engine uses the
same syntax; the HTTP API's `symbol()` validator accepts only `^[A-Z][A-Z0-9.-]{0,9}$`). Whether such an issue may be traded is policy
(`symbol_allowed`), not syntax.
`validateIntent(obj) -> {ok, errors[], intent}`; unknown fields rejected; `intentFromProposal(proposal, envelope)` combines the proposable fields
(`PROPOSAL_KEYS`) with a trusted envelope (source, ids, timestamps); model output is parsed into this shape and validated; free-form model text is
never executed.

## 7. Strategies & agents

* `server/agents/strategies.js`: `PRESETS` per lens × segment, each labelled `EXPLORATORY DEFAULTS — NOT VALIDATED`, plus the
  `handwritten-notes-example` preset ($50 cap, +22 %/15-min trigger, stop at the entry reference, take-profit ambiguity documented — 250 % gain ⇒
  3.5× vs 250 % of price ⇒ 2.5×; default 2.5× and both shown; time exit 15 min ± 10 %). `HANDWRITTEN_AMBIGUITIES` carries the open questions
  (ids kept in sync with `docs/OPEN_QUESTIONS.md` by a test). `computeSignals(db, ds, asOf, syms, cfg)` → per symbol `{sym, priceU, ret_w, accel, relVol,
  buyShare, classifiedShare, volumeW, spreadBps, quoteAgeMs, halted, insufficient, reasons[]}` plus provenance (`asOf, windowMin, priceMinuteT,
  refPriceU, refMinuteT, midPriceU, tradesW, sessionVolume, elapsedMin, baselineMin, baselineVolume, quote`). `relVol` follows
  `marketdata.RELVOL_DEFINITION` (window excluded from its own baseline; null when the baseline is < 15 min or has no volume); agents additionally
  treat a baseline under 1,000 IEX shares as unavailable (`BASELINE_VOLUME_TOO_SMALL`; the scanner shows that value flagged `THIN_BASELINE`).
  Volume alone is never labelled intent: `buyShare` is "inferred aggressor share (quote rule vs IEX BBO; IEX-only)" and is `null` when classified
  volume < cfg.minClassifiedShares. `planActions(strategy, signals, state, clock)` → `{actions, candidates, skipped, nearMisses}`;
  `proposeIntents(...)` → its TradeIntents (rules source). A preset sell stop at the entry reference that lands at/above the bid is proposed with
  `detail.stopAtOrAboveBid` and a rationale warning; any other stop basis at/above the bid is skipped (`STOP_AT_OR_ABOVE_BID`).
* `server/agents/runner.js`: `runAgentsStep(db, rctx)` for RUNNING agents (agent-id order, bounded by `RUNNER_LIMITS` and each strategy's
  `management`): monitor (stale entries, orphan protective orders, breakeven trails, time exits), scan, decide (`decisionMode`: `rules` |
  `model_confirm` | `model`), gate (with an evidence index), submit; journal `AGENT_SCAN`, `INTENT_PROPOSED`, `POLICY_ACCEPT`/`POLICY_DENY`,
  `ORDER_SUBMITTED`, `MODEL_CONFIRMATION`, `AGENT_BLOCKED`, `AGENT_FAULT`, `AGENT_STEP_CAP`, `RUNNER_FAULT`. Model-sourced entries are clamped to the
  strategy envelope (budget, displayed size, a protective stop never looser than the strategy's and never at/above the bid) before gating; an
  invalid proposal (`MODEL_PROPOSAL_INVALID`) or one citing evidence ids not in the evidence store (`MODEL_EVIDENCE_UNRESOLVED`) is not executed and
  is recorded in the agent's `last_fail`. Accepted agent entries record `meta.gate_estimate` like human orders.
  * `model_confirm`/`model` with no connected model → no entry; this step's rule-based management still goes through the gate; agent `BLOCKED`
    reason `MODEL_DISCONNECTED`. The hindsight guard's refusal blocks the agent with reason `REPLAY_BEFORE_MODEL_CUTOFF` or
    `MODEL_TRAINING_CUTOFF_UNKNOWN`. An exception inside one agent → that agent `FAULTED`; the step continues.
  * `BLOCKED` and `FAULTED` policy: the agent does not run; its pending entry orders are cancelled; protective stop-loss / take-profit orders keep
    working; time exits and breakeven trails are not evaluated (`TIME_EXIT_SUSPENDED`); a human must resume it.
* **Time exits** are agent-monitored RULES (entry `meta.time_exit`), not standing orders: at/after `first fill + 1 min + N min` the runner proposes a
  market sell while the last IEX trade is within ± band of the entry fill price. They are evaluated only while the agent is RUNNING. Every
  transition out of RUNNING (pause, kill switch, boot pause, BLOCKED, FAULTED) journals `TIME_EXIT_SUSPENDED` for the positions it leaves without
  that rule; a deadline missed meanwhile is evaluated at the first step after a human resumes the agent (`detail.lateByMin`). Human sandbox
  orders may not carry `attach.time_exit_min` / `time_exit_band_bps` (400 `TIME_EXIT_NOT_SUPPORTED`), because no agent monitors them.
* `server/controls.js` (re-exported from the runner): `engageKill(db, {by, protective_policy:'KEEP_PROTECTIVE'|'CANCEL_ALL', reason})` cancels every
  open non-protective order of the current session, keeps (KEEP_PROTECTIVE) or cancels (CANCEL_ALL) protective ones, sets every agent `STOPPED`
  and journals `KILL_SWITCH_ENGAGED` + `KILL_SWITCH_EFFECTS`; `releaseKill(db, {by})` (agents stay STOPPED until individually started; starting is
  refused while engaged). `startAgent` / `resumeAgent` / `pauseAgent(…, {cancel_pending_entries = true})` / `setAgentStrategy` (validated; segment
  must match; journaled `STRATEGY_CHANGED`). Paused-state protective policy (default `KEEP_PROTECTIVE`): pausing stops new entries and by default
  cancels the agent's pending entries; protective orders keep working. On server start `pauseAllOnBoot(db)` sets RUNNING → PAUSED (`authority not
  implicitly resumed after restart`) and cancels the pending entries of agents without a RUNNING supervisor (RUNNING, BLOCKED, FAULTED).
* `server/replay/engine.js`: `getState(db)`, `reset(db, {ds, startingCashU, strategies, restorePresets, actor:'human'|'system'})`,
  `step(db, {minutes})` (per minute: clock += 60s → `processMinute(clock − 60s)` → mark → `runAgentsStep` at the new clock), `play/pause`
  (server-side timer, not browser), single-flight mutex. Reaching the replay end stops play, expires every order still open (DAY orders carry
  the replay end as their expiry, §4; anything recorded with a later expiry is expired by `expireOpenAtReplayEnd`) and journals
  `REPLAY_SESSION_CLOSED` with `expiredAtClose` / `expiredCount` / `forcedExpiredAtReplayEnd` and a note built from what actually expired.
  `runAgentsStep` receives `t_end`: agents measure their session end (entry window `noEntryLastMin`, `OUTSIDE_SESSION`) from the replay end.
  * `reset`: new session id; 7 portfolios; 6 agents with grants `{portfolios:[own], actions:[open, close, modify, cancel], instruments:[equity]}`;
    clock = session open. **Strategies** (one rule for every caller): an explicit `strategies` entry (keyed by agent id or portfolio id) wins;
    otherwise the agent's current stored strategy is carried when it validates for its segment, unless `restorePresets`; otherwise its preset.
    `restorePresets` defaults to false without a `strategies` map and to true with one. **State**: agents start `PAUSED`, or stay `STOPPED`
    (reason `KILL_SWITCH_ENGAGED (persisted across replay reset)`) while the kill switch is engaged; an unreadable kill state also keeps them
    STOPPED (fail closed). Journals `REPLAY_RESET` with the given actor (the boot-time initial reset uses `system`; payload includes `t_end`,
    `session_close`, `coverage_end`, `truncated`, `restorePresets`, `killSwitchEngaged`, per-agent strategy source) plus, for each existing agent whose
    strategy or state changed, `STRATEGY_CHANGED` / `AGENT_STATE_CHANGED` (reason `REPLAY_RESET`). Returns `strategies:[{agent_id, strategy_id,
    strategy_source:'override'|'carried'|'preset', strategy_sha256, matchesPreset, strategyChanged, state, previousState, note?}]`.
  * **Partial datasets**: the replay ends at min(16:00 ET close, the dataset's coverage end aligned down to a whole minute) (`t_end`,
    `truncated: true`, `truncation_note`); a partial dataset whose data ends at or before the open, or whose coverage end is unknown, is refused
    `DATASET_INCOMPLETE` (and skipped when choosing the default dataset, listed in `REPLAY_RESET.skippedDatasets`). `getState` applies the same cap to
    sessions recorded earlier and reports `session_close`, `coverage_end`, `truncated` and `dataset.complete`.

## 8. Intelligence (server/intel)

* `model-provider.js`: `getProvider(config)` → provider for `VECTOR_MODEL_PROVIDER` = `anthropic` | `openai-compatible` | `ollama` | `none`
  (default). Any other value → a `FAULT` provider ("unknown VECTOR_MODEL_PROVIDER"). Precedence: explicit config argument > environment > optional
  secret-free JSON file (`VECTOR_MODEL_CONFIG`, default `data/model-config.json`, re-read when its size/mtime change; secret-like keys are ignored
  with a warning) > defaults. Provider: `{ id, kind, model, endpointLabel, config, status({fresh?}): Promise<{status:'CONNECTED'|'DISCONNECTED'|'FAULT',
  detail}>, complete({system, user, schema, schemaName, maxTokens, timeoutMs}) -> Promise<{ok, json, rawText, refusal, usage:{in,out}, latencyMs,
  error, errorKind, servedModel, fallbackUsed}> }`. Status results are cached (Anthropic 30 s, OpenAI-compatible and Ollama 15 s); `{fresh:true}`
  bypasses the cache. No mock provider in `server/`. Tests inject a mock object directly.
* `providers/anthropic.js`: official `@anthropic-ai/sdk` (dynamic import; if absent → FAULT "SDK not installed"), model default
  `claude-opus-5-5` (env `VECTOR_ANTHROPIC_MODEL`). Request (`buildAnthropicRequest`): `{ model, max_tokens, betas:['server-side-fallback-2026-07-01'],
  fallbacks:'default', thinking:{type:'adaptive'}, output_config:{effort, format:{type:'json_schema', schema}}, system, messages }`, sent with
  `client.beta.messages.stream(params).finalMessage()` (falls back to `.create` when the SDK has no `stream`). Check `stop_reason === 'refusal'`
  before reading content; typed SDK errors. Per-call budget `max(timeoutMs, 60 s + 25 ms × max_tokens)`. Key only from `ANTHROPIC_API_KEY` /
  `ANTHROPIC_AUTH_TOKEN` env (or SDK profile).
* `providers/openai-compatible.js`: `fetch(${base}/chat/completions)` with `response_format:{type:'json_schema', json_schema:{name, schema, strict:true}}`;
  base from `VECTOR_OPENAI_BASE_URL` (e.g. `http://127.0.0.1:11434/v1` Ollama, `http://127.0.0.1:1234/v1` LM Studio, `https://api.openai.com/v1`),
  model `VECTOR_OPENAI_MODEL`, key from `VECTOR_OPENAI_API_KEY` (optional for local). The output-token parameter is `max_completion_tokens` for
  `*.openai.com`, else `max_tokens` (`VECTOR_OPENAI_TOKEN_PARAM` overrides). Strip `<think>…</think>` before JSON parse; validate against schema.
  Context window: `VECTOR_OPENAI_CONTEXT_TOKENS`, else for an Ollama endpoint (port 11434) the loaded context from `GET /api/ps`, else Ollama's
  default 4096. A prompt that does not fit with an output reserve is refused `CONTEXT_OVERFLOW` (errorKind `CONFIG`) without calling;
  a reported prompt far smaller than the request (truncation) or prompt + output at/above the context (context shift) is `INVALID_OUTPUT`.
  Ollama's `/v1` endpoint cannot set `num_ctx`; through this adapter the Ollama server must run with `OLLAMA_CONTEXT_LENGTH` (16384 recommended).
* `providers/ollama.js` (`VECTOR_MODEL_PROVIDER=ollama`): native Ollama API, `POST {base}/api/chat` with `{model, messages:[system, user],
  format:<JSON schema>, stream:false, options:{num_ctx, num_predict[, temperature]}}`. Base `VECTOR_OLLAMA_BASE_URL` (default
  `http://127.0.0.1:11434`; a trailing `/v1` or `/api` is removed; embedded credentials are rejected), model `VECTOR_OLLAMA_MODEL` (required),
  `num_ctx` = `VECTOR_OLLAMA_NUM_CTX` (default 16384, at most 1,048,576) on **every** request, so the Ollama server need not be reconfigured.
  Same envelope and checks as the OpenAI-compatible adapter: `CONTEXT_OVERFLOW` refused before sending; a truncated prompt, a context shift against
  the context Ollama actually loaded (`GET /api/ps`), `done_reason: 'length'` or `done: false` → `INVALID_OUTPUT`; `<think>` blocks stripped and a
  separate `message.thinking` field never parsed. `status()` uses `GET /api/tags` (model pulled?) and `GET /api/ps` (loaded, with which context?).
  No API key.
* `assessments.js`: `buildEvidencePacket(db, ds, sym, asOf, {env})` (`vector-evidence-packet-v3`; only knowable evidence: as-of IEX statistics,
  macro observations knowable at asOf, FINRA rows dated before the trade date, symbol identity only from a directory published at or before asOf;
  each item has id, kind, provider, ds, knowable_ts, source_url) → persisted to `evidence` (append-only). Every packet lists explicit unknowns
  (`packetUnknowns`): `sector_industry` (`BLOCKED` without SEC access, else `NO_VERIFIED_DATA`), `analyst_views` (`UNAVAILABLE_NOT_VERIFIED`),
  `filings_news_financing` and `other_venues` (`NO_VERIFIED_DATA`); a symbol not yet visible at asOf is described with
  `NOT_IN_STORED_UNIVERSE_AS_OF`. `runLensAssessments(db, provider,
  {session_id, ds, sym, asOf, lenses})` runs the three lenses **independently** (separate calls, same packet, no lens sees another's output),
  validates each output (schema, semantic and bracket-coherence checks, evidence ids, a numeric cross-check recorded as `verification`), stores
  `assessments` rows, never averages or votes. Lens output schema: `{lens, stance:'consider_entry'|'watch'|'avoid'|'insufficient_evidence', thesis,
  counter_thesis, exposure, liquidity_and_spread, unknowns[], evidence_refs[], confidence:{level:'low'|'medium'|'high', calibration_note},
  proposed_intent|null}`; `proposed_intent` is a long buy entry in USD (`order_type, budget_usd, qty, limit_px_usd, stop_px_usd, stop_loss_px_usd`
  (required), `take_profit_px_usd`, `time_exit_min, expires_in_min, rationale, evidence_refs`) and becomes at most a TradeIntent draft.
  Each per-lens result carries `errorKind`. After a failure that would repeat for every lens (`CONNECT`, `NETWORK`, `DISCONNECTED`,
  `SDK_MISSING`, `NO_CREDENTIALS`) the remaining lenses are not called: they are reported `ERROR` / `NOT_RUN` with `assessment_id: null` and no
  stored row. The per-call timeout is the provider's own (`provider.defaultTimeoutMs`, e.g. `ollama.timeoutMs` in the model config file), else
  `VECTOR_MODEL_TIMEOUT_MS`.
  A provider whose status is `FAULT` (e.g. an unknown provider name) gives run status `FAULT`, not `MODEL_DISCONNECTED`.
  **Bounded repair:** a lens result of `INVALID_OUTPUT` is re-asked up to `repairAttempts` times (opts, provider config, else
  `VECTOR_MODEL_REPAIR_ATTEMPTS`; default 1, maximum 2, 0 disables). The re-ask carries the same packet plus only that lens's own rejected answer and
  its validator errors. Each attempt is stored as its own `assessments` row, and the rejected attempt stays `INVALID_OUTPUT`. A re-ask counts
  against both caps and is skipped when either cap would be exceeded. Per-lens results add `attempts`, `repairOf` (the id of the rejected row) and
  `firstAttemptError`. `MODEL_ASSESSMENT` journal rows add `attempt` and `repair_of`.
* **Hindsight guard** (`hindsightCheck`): an assessment is `BLOCKED` (`MODEL_CALL_BLOCKED` journaled, no call made) when the replay trade date is
  not more than `cutoffMarginDays` (default 90) after the model's training cutoff (`REPLAY_BEFORE_MODEL_CUTOFF`), or when the cutoff is unknown
  (`MODEL_TRAINING_CUTOFF_UNKNOWN`). The cutoff comes from `VECTOR_MODEL_TRAINING_CUTOFF` (YYYY-MM-DD, the vendor's documented cutoff) or the
  built-in table (`claude-opus-5-5` = 2026-06-30). `VECTOR_ALLOW_PRE_CUTOFF_REPLAY=1` lets a risky run proceed with every result stamped
  `hindsight_risk`.
* **Call budgets**: `VECTOR_MAX_MODEL_CALLS_PER_SESSION` (default 60, per replay session) and `VECTOR_MAX_MODEL_CALLS_PER_DAY` (default 300, rolling
  24 h wall clock across all sessions, lens calls plus model tests; a reset does not refill it; `modelCallBudget()`). Both are all-or-nothing per
  run (`CALL_CAP_REACHED`, scope `session` | `rolling_24h`; `MODEL_CALL_CAP_REACHED` journaled). Stored `ERROR` rows whose request never reached a
  model (`NOT_SENT_ERROR_KINDS`: CONNECT, DISCONNECTED, SDK_MISSING, NO_CREDENTIALS, CONFIG) stay in the audit trail but do not count against
  either cap (`countedCallsUsed`). `CONNECT` = `fetch()` rejected before any response with ECONNREFUSED / ENOTFOUND / EAI_AGAIN /
  UND_ERR_CONNECT_TIMEOUT. `NETWORK` (a connection dropped while the response body was read, an Anthropic `APIConnectionError` after a retry, or
  any other transport failure) COUNTS: the endpoint may already have produced and billed the completion. Per-call timeout: the provider's own
  (`ollama.timeoutMs`, `openaiCompatible.timeoutMs`), else `VECTOR_MODEL_TIMEOUT_MS` (default 120000); max tokens `VECTOR_MODEL_MAX_TOKENS`
  (default 16000).
* The agent runner's assessor is wired at boot (`index.wireAgentAssessor`) and resolves the provider on **every** call (`ctx.provider()`), so a
  model configured, changed or removed after boot takes effect without a restart; with no usable provider, model-mode agents are BLOCKED
  `MODEL_DISCONNECTED` before any call. `runner.createLensAssessor(db, provider | () => provider)` caches provider status for 60 s (discarded when
  the provider object changes), and a call that failed without a usable answer from an unreachable endpoint (CONNECT / NETWORK /
  DISCONNECTED / SDK_MISSING / CONFIG) reports `MODEL_DISCONNECTED`. Agent lens calls in flight are counted in `/api/status` `model.inFlight.agentCalls`.

Model environment variables (all optional; secrets only from the environment and never returned):

| Variable | Meaning |
|---|---|
| `VECTOR_MODEL_PROVIDER` | `anthropic` \| `openai-compatible` \| `ollama` \| `none` (default). |
| `VECTOR_ANTHROPIC_MODEL` | Default `claude-opus-5-5`. |
| `VECTOR_OLLAMA_BASE_URL`, `VECTOR_OLLAMA_MODEL` | Native Ollama adapter: base (default `http://127.0.0.1:11434`) and model (required). |
| `VECTOR_OLLAMA_NUM_CTX` | Context requested on every Ollama call (`options.num_ctx`); default 16384, max 1,048,576. |
| `VECTOR_OPENAI_BASE_URL`, `VECTOR_OPENAI_MODEL` | OpenAI-compatible endpoint and model (LM Studio, OpenAI, or Ollama's `/v1`). |
| `VECTOR_OPENAI_CONTEXT_TOKENS` | OpenAI-compatible adapter: the server's real context window; prompts that do not fit are refused, never silently truncated. |
| `VECTOR_OPENAI_TOKEN_PARAM` | `max_tokens` \| `max_completion_tokens` (default by host). |
| `VECTOR_MODEL_TRAINING_CUTOFF` | Documented training cutoff `YYYY-MM-DD` (hindsight guard). |
| `VECTOR_MODEL_CUTOFF_MARGIN_DAYS` | Default 90. |
| `VECTOR_ALLOW_PRE_CUTOFF_REPLAY` | `1`/`true`/`yes` lets a hindsight-risky run proceed, stamped `hindsight_risk`. |
| `VECTOR_MODEL_TIMEOUT_MS`, `VECTOR_MODEL_MAX_TOKENS` | Per-call timeout (120000) and output tokens (16000). |
| `VECTOR_MAX_MODEL_CALLS_PER_SESSION`, `VECTOR_MAX_MODEL_CALLS_PER_DAY` | Call budgets (60 per session; 300 per rolling 24 h). |
| `VECTOR_MODEL_CONFIG` | Path of the optional secret-free JSON config file. |
| `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `VECTOR_OPENAI_API_KEY` | Secrets (presence flags only). |
| `OLLAMA_CONTEXT_LENGTH` | Set on the **Ollama server**, not read by VECTOR. Needed only when Ollama is reached through `openai-compatible` (`/v1` cannot set `num_ctx`); VECTOR measures it via `/api/ps`. |

### 8a. Model presets (server/intel/providers/presets.js, config/model-presets.json)

Named, secret-free configurations of the **existing** adapters (`ollama` native, `openai-compatible`, `anthropic`); no adapter is forked. The
catalog is `config/model-presets.json` (or `VECTOR_MODEL_PRESETS`), because free-tier terms and limits change. Built in: `ollama-local`
(default), `lmstudio-local`, `groq`, `openrouter-free`, `gemini-flash-free` (all `cost: free`) and `anthropic` (`cost: paid`).

Preset schema (validated on load; an invalid entry is excluded and reported in `catalog.errors`):

| Field | Rule |
|---|---|
| `id` | `^[a-z0-9][a-z0-9-]{1,40}$` |
| `adapter` | `ollama` \| `openai-compatible` \| `anthropic` |
| `base_url` | http(s), no credentials or query; loopback when `local: true`; https when `local: false`; `null` for `anthropic` |
| `local` | boolean; a local preset must declare `trains_on_prompts: false`; an `anthropic` preset must be `local: false` |
| `cost` | **required**: `free` \| `paid` \| `unknown` |
| `trains_on_prompts` | `true` \| `false` \| `"unknown"`, from the provider's own terms; `trains_on_prompts_source` (https URL) required; `trains_on_prompts_note` |
| `key_env` | `null` or the name of the server environment variable holding the key (never a key) |
| `docs_url` (https), `limits_url` | provider docs |
| `any_model`, `default_model`, `model_suffix_required` | model rules (`openrouter-free` requires `:free`) |
| `training_cutoff` | `{ "<model>": {date: YYYY-MM-DD, source, note} }` for the hindsight guard |
| `limits` | **required** `{requests_per_minute, requests_per_day, source}`, enforced locally (table `model_preset_calls`) |
| `num_ctx` (ollama), `context_tokens` (openai-compatible) | context passed to the adapter |
| `timeout_ms` | optional per-call timeout for the adapter (1000..900000; local presets use 300000 because a local model can take minutes per lens) |
| any secret-like key (`*key`, `*token`, `secret`, …) | refused |

* **Guards** (`createPresetProvider`, before any call or probe): $0 guard (cost not `free` and no `VECTOR_ALLOW_PAID=1` → BLOCKED
  `PAID_PROVIDER_BLOCKED`); model rules (`PRESET_MODEL_NOT_FREE`, `LOCAL_PRESET_CLOUD_MODEL` for Ollama `*cloud` models); key presence
  (`NO_API_KEY`). Only the preset's own key is passed to its adapter (as `VECTOR_OPENAI_API_KEY` for openai-compatible; empty for local presets).
  Local limits: `complete()` refuses with errorKind `LOCAL_RATE_LIMIT` (nothing sent; not counted as a sent call); `runLensAssessments` checks
  all lenses up front and answers `CALL_CAP_REACHED` (scope `preset_per_minute` | `preset_per_day`).
* **Legacy path.** With no selection, `VECTOR_MODEL_PROVIDER` works as before through an implicit preset: `anthropic` → paid; `ollama` /
  `openai-compatible` → free with `trains_on_prompts:false` only on a loopback endpoint, else cost/trains `unknown` (so blocked by the $0 guard).
* **Hindsight.** Each lens provider's cutoff: owner-set `trainingCutoff` in the selection > the preset's `training_cutoff[model]` > built-in >
  unknown (BLOCKED `MODEL_TRAINING_CUTOFF_UNKNOWN`). `VECTOR_MODEL_TRAINING_CUTOFF` applies only to the legacy path.
* **Selection** (`getSelection`): stored (controls key `model_selection`, set by `PUT /api/model/selection`) > environment
  (`VECTOR_MODEL_PRESET`, `VECTOR_MODEL_PRESET_MODEL`, `VECTOR_MODEL_LENS_<COWBOY|PRAGMATIST|TIGHTWAD>=preset[@model]`,
  `VECTOR_MODEL_PIN_ALL_LENSES=1`) > legacy. Shape `{default:{preset, model?, trainingCutoff?}, lenses:{<lens>?: {...}}, pinAllLenses}`.
  **Experiment pin:** `pinAllLenses:true` gives all three lenses the default's provider (one model for the eight-account comparison).
  `ctx.provider(lens)` resolves per lens for human runs and agents; `runLensAssessments(db, provider, {providers})` takes per-lens providers.
* **Privacy gate** (§4b): `realDataPrivacyCheck(providersByLens, env)` → `{ok, blocked:[{lens, provider, preset, trains_on_prompts}]}`;
  enforced by `POST /api/assessments/run {includeRealAccount:true}` (403) and again inside `runLensAssessments` (`realAccountContext` →
  BLOCKED `REAL_DATA_PRIVACY_BLOCK`). An allowed run appends the REAL_ACCOUNT holding as labelled non-evidence text after the packet (not in the
  packet hash or the evidence store), journals `real_account_context:true`, and derives no intent draft. Nothing the model wrote in such a run
  is stored: its `assessments` rows carry `real_ctx = 1` with `output_json` NULL and the error reduced to its kind, the journal row has no
  `raw_excerpt`, `verification` or error text, and `listAssessments` / the dossier never list `real_ctx` rows. The full result is returned only
  in the (synchronous, loopback-only) response. Provider results are scrubbed of the provider's key (raw and URL-encoded) before anything
  stores them, for presets and the legacy path alike.

Preset environment variables: `VECTOR_MODEL_PRESETS`, `VECTOR_MODEL_PRESET`, `VECTOR_MODEL_PRESET_MODEL`, `VECTOR_MODEL_LENS_<LENS>`,
`VECTOR_MODEL_PIN_ALL_LENSES`, `VECTOR_ALLOW_PAID`, `VECTOR_REAL_DATA_ALLOW_PRESETS`; keys `VECTOR_GROQ_API_KEY`, `VECTOR_OPENROUTER_API_KEY`,
`VECTOR_GEMINI_API_KEY` (secrets; presence flags only).

## 9. HTTP API (server/index.js, server/api/*.js) — JSON

**Binding.** Loopback (`127.0.0.1`) by default; a non-loopback `VECTOR_HOST` is refused unless `VECTOR_ALLOW_REMOTE=1`. Every request's Host
header must be on the allow-list (loopback names on the bound port; in remote mode also the machine's interface IPs and the bound address; plus
`VECTOR_ALLOWED_HOSTS`) → else 421 `HOST_NOT_ALLOWED`. In remote mode a non-loopback peer needs the per-launch token: opening `/?k=<token>`
(printed at startup) sets an HttpOnly, SameSite=Strict cookie (303 redirect); without it → 401 `REMOTE_TOKEN_REQUIRED`.

**Mutations** (POST/PUT) require header `X-Vector-Client: web` (else 403 `CSRF_GUARD`), `Content-Type: application/json` (else 415
`UNSUPPORTED_MEDIA_TYPE`), an `Origin` (when sent) that is an http:// origin on an allowed Host or listed in `VECTOR_ALLOWED_ORIGINS`, and no
`Sec-Fetch-Site: cross-site` (else 403 `ORIGIN_MISMATCH`). Body: a JSON object <= 64 KB (413 `BODY_TOO_LARGE`), nested <= 32 levels and <= 20,000
values (400 `BODY_TOO_DEEP` / `BODY_TOO_COMPLEX`), else 400 `BAD_JSON` / `BODY_NOT_OBJECT`. Strict validation: unknown body or query keys → 400
`UNKNOWN_FIELD`; validators answer 400 `SYMBOL_INVALID`, `ID_INVALID`, `ENUM_INVALID`, `INT_INVALID`, `BOOL_INVALID`, `TEXT_INVALID`.
Other transport errors: 414 `URI_TOO_LONG` (> 4096 chars), 404 `NOT_FOUND` (no API route), 405 `METHOD_NOT_ALLOWED` (with `Allow`), 500
`INTERNAL_ERROR`. GET routes also answer HEAD.

**Errors**: `{error:{code, message}}` plus optional structured fields (e.g. `decision`, `intent_id`, `reasons`, `checks`, `estimate`, `errors`), with
4xx/5xx; never stack traces or secrets (response bodies are scrubbed of configured secret values and URL credentials). A policy-gate denial is 409
with `error.code` = the first reason code and `{decision:'DENIED', intent_id, reasons, checks, estimate, policy}`; an order-engine refusal after an
accepted intent is 409 with `decision:'REJECTED_BY_ORDER_ENGINE'`.

`confirm`: required (`confirm:true`) where stated below; on other mutating routes it is accepted and ignored (the UI sends it after its own dialog).

Status and configuration
* `GET /api/status` → `{ app:{name, brand, motto, version, paperOnly:true, liveBroker:'NONE — out of MVP scope'},
  data:{mode, modeDetail, dataset:{…, complete, coverage_end}, live:{status, detail, provider, lastQuoteTs}},
  replay:{status, session_id, ds, t_start, t_end, clock, playing, tick_wall_ms, minutesElapsed, minutesRemaining, busy, lastTickError,
  complete, coverage_end, truncated, beyondCoverage, session_close, truncation_note},
  model:{status, provider, kind, endpointFamily, model, detail, running, inFlight:{assessment, modelTest, agentCalls}, lastAssessmentRun},
  options:{status, detail}, kill:{engaged, at, by, protective_policy},
  agents:[{id, portfolio_id, lens, segment, state, state_reason, last_ok, last_fail, decisionMode, strategy_id}], serverTime }`.
  `data.mode` is `HISTORICAL_REAL` (stored complete or partial market dataset), `IMPORTED_UNVERIFIED` or `NO_VERIFIED_DATA`; `modeDetail` names a
  partial dataset's coverage end. `model.kind` names the adapter unchanged (an OpenAI-compatible endpoint on Ollama's port 11434 stays
  `openai-compatible`: it cannot set `num_ctx` per request) and `model.endpointFamily` says `ollama` for it. `model.inFlight.assessment`
  (`{run_id, sym, asOf, mode, startedAt, elapsedMs, lensesDone, lensesTotal}`) and `lastAssessmentRun` are shown only for the current replay session
  at or before its clock; a run started before a reset is reported without symbol, time or outcome. `lastAssessmentRun` of a completed run
  carries `decision` (`OK` only when every lens is OK, else `PARTIAL` / `NO_OUTPUT`), `lensStatuses` and `lensErrorKinds` (`NOT_RUN` = never called).
* `GET /api/sources` → `[{id, name, kind, status, provider, coverage, entitlement, attribution, last_event_ts, ingested_at, published_at, sha256, rows,
  setup, notes, datasets:[{id, status, sha256, published_at, ingested_at, rows, complete?, coverage_end?}], complete?}]` (IEX, FRED, symbol directory,
  FINRA, SEC, GDELT, CSV import, then the Alpaca/Polygon feed adapters).
* `POST /api/feeds/verify` `{sym, provider?:'alpaca'|'polygon'}` and `POST /api/options/verify` `{underlying, provider?}` — human-run, WALL-CLOCK
  STATUS ONLY: one latest-quote request (live) or contracts + one option quote (options) to a configured provider. 200 `{decision:'VERIFIED'|
  'NOT_VERIFIED', kind, status, provider, detail, feed, scope, pricesWithheld:true, cooldownMs, note}` (live adds `sym` and `quote:{twoSided, quoteTs,
  ageMs}`; options adds `underlying, contractFound, twoSidedQuote, quoteFeed, indicative, replayOptionsOrders`). Quote prices and contract terms are never
  returned or journaled (they are later than the replay clock). 409 `NO_VERIFIED_DATA` when no (or not the named) provider is configured, no request
  made; 429 `FEED_VERIFY_BUSY` (single-flight across both routes); 429 `FEED_VERIFY_RATE_LIMITED` (30 s per route). Each attempt journals `FEED_VERIFY`
  (no keys, no prices). The result is kept in memory for `/api/status` and `/api/sources` until restart and never reaches the replay: replay options
  orders stay `NO_VERIFIED_OPTIONS_DATA`.
* `GET /api/model` → `{status, provider, kind, endpointFamily, model, endpoint, detail, configured, warnings, limits (timeoutMs = the active
  adapter's own timeout), callsUsedThisSession (the count the per-session cap enforces), auditRowsThisSession (every stored row),
  budget:{cap, used, inflight, remaining, window}, running, inFlight, lastAssessmentRun, keysPresent, uiText, setup, preset, blocked, selection}`
  (`selection` = `selectionSummary`: `{source:'stored'|'env'|'legacy', selection, pinAllLenses, sameModelAllLenses, allowPaid, lenses:{<lens>:
  {provider, kind, model, preset, cost, trains_on_prompts, training_cutoff, blocked}}}`).
* `POST /api/model/test {confirm:true, preset?, model?, lens?}` → one small structured-output request to the given preset (+ model), a lens's
  selected provider, or the default → 200 `{decision:'OK'|'FAILED', modelStatus, provider, preset, model, latencyMs, usage, fallbackUsed, error,
  errorKind, refused, confirmed, note}` (journaled `MODEL_TEST`; counts against the preset's local limit). 409 `<BLOCKED code>` (e.g.
  `PAID_PROVIDER_BLOCKED`, `NO_API_KEY`; checked before confirmation; message `BLOCKED: <code> — <detail>`), 400 `PRESET_UNKNOWN` /
  `MODEL_INVALID` / `MODEL_WITHOUT_PRESET`, 409 `MODEL_DISCONNECTED` (no provider), 409 `CONFIRMATION_REQUIRED`, 429 `MODEL_TEST_BUSY`, 429
  `CALL_CAP_REACHED` (rolling 24 h budget), 429 `MODEL_TEST_RATE_LIMITED` (10 s between tests).
* `GET /api/model/presets` → `{catalog:{loaded, errors}, defaultPreset, allowPaid, presets:[{id, label, adapter, base_url, local, cost,
  trains_on_prompts, trains_on_prompts_source, trains_on_prompts_note, docs_url, limits_url, any_model, default_model, model_suffix_required,
  training_cutoff, limits, key_env, key_present, allowed_by_cost_guard, localBudget:{perMinute, perDay, source}}], selection, note}`.
* `PUT /api/model/selection` `{default:{preset, model?, trainingCutoff?}, lenses?:{cowboy?, pragmatist?, tightwad?}, pinAllLenses?}` or
  `{clear:true}` → 200 `{status:'SAVED', selection}`; 400 `PRESET_UNKNOWN` / `SELECTION_INVALID`. Journals `MODEL_SELECTION_CHANGED`.

Real accounts — READ ONLY (§4b; every body carries `label: 'REAL ACCOUNT — READ ONLY'`; every route answers 403 `REAL_DATA_LOOPBACK_ONLY` to a
non-loopback or proxied peer and in remote mode; **no order, trade or cancel route exists under `/api/real/`** - any such path is 404)
* `GET /api/real/status` → `{label, readOnly:true, source, data_class, status:'BLOCKED'|'READY', code, uiText, detail, mode, variablesPresent,
  operations, lastSync, lastSuccessfulSync, note}`.
* `POST /api/real/connect {}` → `{label, redirectURI, expiresInSeconds:300, connectionType:'read', note}`; 409 `SNAPTRADE_NOT_CONFIGURED`; 502
  `SNAPTRADE_*`.
* `POST /api/real/sync {confirm:true}` → `{label, status:'OK', sync_id, fetched_at, counts, source, data_class}`; 409 `CONFIRMATION_REQUIRED` /
  `SNAPTRADE_NOT_CONFIGURED`; 429 `REAL_SYNC_BUSY` / `REAL_SYNC_COOLDOWN` (60 s); 502 `SNAPTRADE_AUTH_REJECTED` | `SNAPTRADE_RATE_LIMITED` |
  `SNAPTRADE_HTTP_<n>` | `SNAPTRADE_UNREACHABLE` | `SNAPTRADE_TIMEOUT` | `SNAPTRADE_BAD_RESPONSE` (no rows stored).
* `GET /api/real/accounts` → `{label, readOnly, status:'SYNCED'|'NOT_SYNCED'|'BLOCKED', code, source, data_class, snapshot:{sync_id, fetched_at,
  counts, accounts:[{account_id, name, number_masked, institution, raw_type, status, total_value, currency, fetched_at, balances:[{currency,
  cash, buying_power}], positions:[{symbol, description, kind, units, price, cost_basis, currency, cash_equivalent, market_value}]}]}|null, note}`.
* `GET /api/real/transactions?account=&limit=` (limit 1..1000, default 100) → `{label, readOnly, status, source, data_class, sync_id, fetched_at,
  rows:[{account_id, activity_id, type, trade_date, settlement_date, symbol, description, units, price, amount, fee, currency}]}`.
* `GET /api/options/status` → `{status, detail, provider, supported, operationalOrders, required[]}`.

Market and research (as-of the replay clock; with no verified dataset the as-of views answer 200 with `status:'NO_VERIFIED_DATA'` and empty rows, and the study answers `BLOCKED`)
* `GET /api/market/universe?segment=micro|large|low&limit` → `{asOf, ds, segment, status, label, nameSource, note, counts,
  rows:[{sym, name, namePostDated, securityType, nonCommon, priceU, minuteT, quote, metrics}]}`.
* `GET /api/research/opportunities?segment=micro|large|low&limit&windowMin=5|15|30|60&instruments=all|common|non_common` → universe rows ranked by
  the transparent score (common-equity-like rows first), label `SIGNAL METRICS — NOT RECOMMENDATIONS`; also `scoreFormula, weights, windowMin,
  horizons:{minutes, selected, daysWeeks}, counts, timing, nameSource, instruments`.
* `GET /api/market/bars?sym=SYM&from=open|premarket` → `{asOf, sym, ds, session, from, status, detail, note, rows:[{t,o,h,l,c,v,n,bv,sv,xv,vwapU,halted}],
  quote, lastTrade}` (completed minutes only).
* `GET /api/market/benchmark` → `{asOf, ds, label, status, note, series:[{sym, status, basePriceU, baseMinuteT, points:[{t, retPct, priceU}]}]}`.
* `GET /api/macro` → `{asOf, status, vintage:'LATEST_VINTAGE_NOT_POINT_IN_TIME', vintageNote, note, series:[...]}` (only observations knowable at the clock).
* `GET /api/research/dossier?sym=` → `{sym, asOf, ds, identity, market, halts, shortVolume, filings, financing, leadership, sector, analystViews, media,
  assessments, unavailable:[{section, status, reason}], asOfNote}`. Each section is real stored data knowable at the clock or an explicit status
  with a reason. `identity` is `HISTORICAL_REAL` only from a directory snapshot published at or before the clock; a post-dated snapshot appears only
  under `identity.currentDirectory`, labelled `CURRENT DIRECTORY — FETCHED AFTER REPLAY DATE — NOT AS-OF EVIDENCE`. `sector` is `BLOCKED` without SEC
  EDGAR access, else `UNAVAILABLE_NOT_VERIFIED`; `analystViews` is `UNAVAILABLE_NOT_VERIFIED`; `assessments` lists stored rows of the CURRENT replay
  session with `as_of <= clock` (`STORED`) or `ASSESSMENT_NOT_RUN`.
* `GET /api/research/study?tier=penny|low&full=0|1` → retrospective signal/failure study, label `RETROSPECTIVE — uses data after each signal; never
  visible to agents`. **Study lock:** while the replay clock is before the session close of the dataset being replayed (also with `full=1`) the answer is
  `{status:'BLOCKED', reason:'WITHHELD_UNTIL_CLOSE', availableAtMs, availableAtEt, rows:[]}`; with no dataset, `BLOCKED` (BLOCKED BY DATA).

Portfolios, orders and journal
* `GET /api/portfolios` → `{session_id, ds, asOf, status:'PAPER', marksStatus, label, note, rows:[portfolioSummary + pnlU]}` (`status:'NO_SESSION'` with no session).
* `GET /api/portfolios/:id` → portfolioSummary + `{pnlU, session_id, ds, fills (<= 200, each labelled ESTIMATED PAPER FILL with assumptions and observed),
  recentOrders (<= 100), costModel, policy}`; the sandbox also returns `costModels:{micro, large}` and `costModelRule`. 404 `PORTFOLIO_NOT_FOUND` / `NO_SESSION`.
* `POST /api/orders` (sandbox) body `{source?:'human', portfolio_id?:'sandbox', action:'open'|'close', instrument:{kind:'equity', sym}, side, order_type,
  qty?, budget_usd?, limit_px_u?, stop_px_u?, attach?:{stop_loss_px_u?, take_profit_px_u?}, rationale?, evidence_refs?, confirm:true}`. The gate decides;
  201 `{decision:'ACCEPTED', intent_id, order, children, estimate, reasons:[], checks, policy, note}`. Refusals: 400 `INTENT_INVALID` (with `errors`),
  `INSTRUMENT_INVALID`, `QTY_REQUIRED` (a close needs qty), `SOURCE_INVALID`, `TIME_EXIT_NOT_SUPPORTED`; 404 `PORTFOLIO_NOT_FOUND`; 409 `NO_SESSION` /
  `NO_VERIFIED_DATA`; 409 gate denial (`HUMAN_NOT_CONFIRMED` without confirm, `HUMAN_TRADING_SANDBOX_ONLY`, …); 409 order-engine refusal. Orders record
  `meta.source`, `meta.confirmed`, `meta.cost_segment` and `meta.gate_estimate {priceU, qty, costU, basis, slippageBps}`.
* `POST /api/orders/:id/cancel` body `{confirm:true, reason?}` — any portfolio, also while the kill switch is engaged; gated as a human `cancel`
  (`confirm:true` is required by `human_confirmed`) → 200 `{decision:'ACCEPTED', intent_id, order, cascaded, checks}`; 404 `ORDER_NOT_FOUND`; 409 denial / engine refusal.
* `POST /api/orders/:id/replace` body `{confirm:true, reason?, limit_px_u?, stop_px_u?, qty?}` (at least one term; `limit_px_u` only for limit/stop-limit,
  `stop_px_u` only for stop/stop-limit, else 400) → gated as `modify` with the remaining qty → 200 `{decision:'ACCEPTED', intent_id, order, checks}`.
  A buy replace that would add exposure (higher qty, higher limit, or any change of a buy stop trigger) → 409 `REPLACE_INCREASES_BUY_EXPOSURE`
  (cancel and place a new order so every entry rule applies).
* `GET /api/journal?portfolio_id&agent_id&type&exclude_type&limit=1..1000(100)&before&session_id=current|all|<id>&hindsight=0|1&verify=incremental|full`
  → newest first `{current_session_id, asOf, scope, filters, hindsight, label?, note, rows:[{seq, session_id, ts_sim, ts_wall, portfolio_id, agent_id, actor,
  type, ref_id, prev_hash, hash, payload, prior_session, hindsight}], chain:{ok, checked, brokenAt, mode, newlyChecked, verifiedMs, scope, note}}`.
  `session_id` defaults to the current session. Rows of OTHER sessions whose replay time is after the current clock are hidden unless `hindsight=1`,
  which returns them flagged `hindsight:true` with a `HINDSIGHT` label. `type` must be UPPER_SNAKE. `exclude_type` is a comma list of up to 20
  UPPER_SNAKE types dropped in SQL (e.g. `AGENT_SCAN,MARK_TO_MARKET`, so `limit` counts only wanted rows; 400 `EXCLUDE_TYPE_INVALID`). Filters never
  change verification: the chain is always checked over the whole journal (incrementally from the last verified row in this process unless `verify=full`).

Agents and controls
* `GET /api/agents` → `{label, kill, presets, note, rows:[{id, portfolio_id, lens, segment, state, state_reason, strategy, grants, last_ok, last_fail,
  updated_wall, scan_summary, decisionMode}]}`.
* `GET /api/agents/activity?agent_id=` → per-agent "why no trades" summary for the current session: `{session_id, asOf, label, note, rows:[{agent_id,
  portfolio_id, state, strategy_id, decisionMode, scans, firstScanTs, lastScanTs, last, scansWithCandidates, skipped:[{code, n, meaning}], planned,
  intents:{proposed, accepted, denied}, denyReasons:[{code, n}], entryOrders, fills, blocked, faults, explanation}]}`.
* `POST /api/agents/:id/(start|resume)` `{confirm?}`; `POST /api/agents/:id/pause` `{cancel_pending_entries?:true, confirm?}` → `{decision:'OK', action,
  unchanged, agent, cancelled}`. 404 `AGENT_NOT_FOUND`; 409 refusals (e.g. `KILL_SWITCH_ENGAGED`, `NO_REPLAY_SESSION`); 422 `STRATEGY_INVALID`.
* `PUT /api/agents/:id/strategy` `{strategy, confirm?}` → `{decision:'OK', agent, label}`; 400 `STRATEGY_REQUIRED`; 422 `STRATEGY_INVALID` /
  `STRATEGY_SEGMENT_MISMATCH`. Takes effect at the next replay step.
* `POST /api/kill` `{protective_policy?:'KEEP_PROTECTIVE'|'CANCEL_ALL' (default KEEP_PROTECTIVE), reason?, confirm?}` → `{decision:'OK', status:'ENGAGED', kill,
  cancelled, keptProtective, agentsStopped, alreadyEngaged}`. `POST /api/kill/release` `{confirm?}` → `{decision:'OK', status:'RELEASED', kill,
  alreadyReleased, note}` (agents stay STOPPED).

Replay
* `POST /api/replay/reset` `{ds?, startingCashU? (u, 10,000..1e13 = $1..$1e9; default VECTOR_STARTING_CASH_USD), restorePresets?:false, confirm?}` →
  `{decision:'OK', session_id, state, startingCashU, restorePresets, strategies:[{agent_id, strategy_id, strategy_source:'carried'|'preset',
  strategy_sha256, matchesPreset, strategyChanged, state, previousState, note?}], note}`. The engine rule of §7 applies: each agent's current validated
  strategy is carried unless `restorePresets:true`; agents start PAUSED, or STOPPED while the kill switch is engaged; a partial dataset's replay ends at its
  coverage end (`state.truncated`, `state.truncation_note`). Journals `REPLAY_RESET` (actor human) and per-agent `STRATEGY_CHANGED` /
  `AGENT_STATE_CHANGED`. 400 `RESTORE_PRESETS_INVALID`; 404 `DATASET_NOT_FOUND`; 422 `STRATEGY_INVALID` / `STRATEGY_SEGMENT_MISMATCH`; 409
  `DATASET_INCOMPLETE` (with `coverage_end`), `REPLAY_BUSY` and other refusals.
* `POST /api/replay/step` `{minutes?:1..390 (1)}` → `{decision:'OK', from, to, minutes, fills, triggered, withheld, expired, ambiguities, agentSteps,
  intents, accepted, denied, faults, blocked, closed, stoppedEarly, state, timing}`; one engine minute at a time. 400 `MINUTES_INVALID`; 409
  `REPLAY_PLAYING` / `REPLAY_BUSY` / `NO_SESSION` / `NO_VERIFIED_DATA` / `SESSION_CLOSED`; 500 `ENGINE_FAULT`.
* `POST /api/replay/play` `{tick_wall_ms?:250..60000}` → `{decision:'OK', state}` (server-side timer; 400 `TICK_INVALID`, 409 refusals);
  `POST /api/replay/pause` `{}` → `{decision:'OK', state}`.

Assessments, options and import
* `POST /api/assessments/run` `{sym, confirm:true, async?:false, includeRealAccount?:false}` → synchronous: 200 `{decision:'OK'|'PARTIAL'|'NO_OUTPUT', status:'COMPLETED', sym,
  ds, asOf, session_id, provider, providers:{<lens>:{provider, preset, model}}, realAccountContext, packet_sha256, evidence_ids, stances, note, results:[{lens, assessment_id, status, errorKind, output, error,
  refusal, model, requestedModel, preset, latencyMs,
  usage, fallbackUsed, intentDraft, verification, hindsight}]}`. With `async:true`: 202 `{decision:'ACCEPTED', status:'RUNNING', run_id, sym, asOf,
  session_id, lensesTotal, progress, note}` at once; progress via `/api/status` `model.running` / `model.inFlight.assessment`, each stored lens via
  `GET /api/assessments`, the outcome in `model.lastAssessmentRun`. Pre-checks always answer synchronously: 409 `NO_VERIFIED_DATA`; 409
  `MODEL_DISCONNECTED` (checked before confirmation); 409 `CONFIRMATION_REQUIRED`; 429 `ASSESSMENT_BUSY`. Run outcomes (sync): 429 `CALL_CAP_REACHED`
  (`{cap, used, scope}`); 409 `BLOCKED` (hindsight guard), `FAULT` or `NO_VERIFIED_DATA` with message `ASSESSMENT_NOT_RUN: <detail>`. Journals
  `ASSESSMENT_RUN_REQUESTED` (ref = run_id). Each lens uses its selected provider (§8a). `includeRealAccount:true` (loopback peer only, else 403
  `REAL_DATA_LOOPBACK_ONLY`) is checked FIRST: 403 `REAL_DATA_PRIVACY_BLOCK` `{blocked:[{lens, provider, preset, trains_on_prompts}]}` unless every
  lens provider declares `trains_on_prompts:false` (or is listed in `VECTOR_REAL_DATA_ALLOW_PRESETS`); then 409 `REAL_ACCOUNT_NOT_SYNCED` when no
  sync exists; 400 `REAL_CONTEXT_SYNC_ONLY` with `async:true`. 429 `CALL_CAP_REACHED` also covers the preset local limits.
* `GET /api/assessments?sym=&limit=1..300(30)` → `{sym, asOf, session_id, scope:'current replay session', status:'STORED'|'ASSESSMENT_NOT_RUN',
  model:{status, provider, model}, note, rows}` (current session, `as_of <= clock`).
* `GET /api/evidence?ids=ev_…,ev_…` — up to 50 evidence-store ids (each `^ev_[0-9a-f]{24}$`; 400 `IDS_REQUIRED` / `IDS_TOO_MANY` / `ID_INVALID`) →
  `{asOf, session_id, status:'OK'|'NOT_FOUND', requested, rows:[{id, sym, kind, title, body, provider, ds, source_url, source_id, event_ts, knowable_ts}],
  unavailable:[ids], note}`, in request order. Only rows knowable at or before the replay clock with consistent provenance are returned; an id that does
  not exist and one not yet knowable are both listed in `unavailable`, indistinguishably. Wall-clock storage times are omitted. With no session:
  `status:'NO_SESSION'`, no rows.
* `POST /api/options/orders` `{portfolio_id?, contract:{occ, underlying, expiry, strike_u|strike, right, multiplier}, contracts:1..1000,
  order_type?:'limit', limit_px_u, confirm?, rationale?}` → always 409 `NO_VERIFIED_OPTIONS_DATA` in this build (the intent and its gate denial are
  journaled); 400 on malformed input; 404 `PORTFOLIO_NOT_FOUND`.
* `POST /api/import/csv` `{manifest, csv, confirm?}` (same 64 KB body cap; larger files: `npm run ingest:csv`) → 201 `{decision:'OK', status:
  'IMPORTED_UNVERIFIED', ds, rows, quality, alreadyImported?, note}`; 400 `MANIFEST_REQUIRED` / `CSV_REQUIRED`; 409 `ALREADY_IMPORTED` (same bytes
  imported with a different manifest); 422 `IMPORT_REJECTED` (`{status:'REJECTED', ds, errors, quality}`).

Server environment (`server/config.js`; invalid values stop the server with a configuration error): `VECTOR_HOST` (default 127.0.0.1),
`VECTOR_ALLOW_REMOTE=1`, `VECTOR_ALLOWED_HOSTS`, `VECTOR_ALLOWED_ORIGINS`, `VECTOR_PORT` (8787; 0 = ephemeral), `VECTOR_DB` (data/vector.db),
`VECTOR_STARTING_CASH_USD` (10000; 1..1e9), `VECTOR_TICK_WALL_MS` (250..60000; engine default 1500), `VECTOR_LARGECAP_LIST`. Feed adapters:
`ALPACA_API_KEY_ID`, `ALPACA_API_SECRET_KEY`, `ALPACA_DATA_FEED`, `ALPACA_OPTIONS_FEED`, `ALPACA_DATA_BASE_URL`, `ALPACA_TRADING_BASE_URL`,
`POLYGON_API_KEY`, `POLYGON_BASE_URL`. Ingest: `SEC_USER_AGENT`. Model variables: §8.

## 10. Not implemented against this spec (MISSING / BLOCKED)

These were requested by the 2026-10-09 review or by fix areas and are **not** in the code. Nothing above describes them as working.

* MISSING — a gate rule `bracket_coherent` (take-profit above the entry and the ask, stop below the entry reference, limit not far through the
  ask) for every entry including human sandbox brackets. Model proposals get this check in `intel/prompts.js checkBracketCoherence`; agent entries
  get only the stop-below-bid check of `protective_exit_required`; human sandbox brackets get neither (`orders.validateOrderSpec` only requires
  stop < take-profit).
* MISSING — per-portfolio policy overrides and partial grant revocation (no API; policies are the frozen defaults of `server/policy/config.js`).
* MISSING — an engine-owned time exit and a management-only pass for BLOCKED agents. Time exits are agent-monitored rules and are suspended while
  the agent is not RUNNING (§7).
* MISSING — aborting in-flight model HTTP requests on a kill or pause. The remaining calls of the step are not made and late results are discarded.
* MISSING — the trade-break withholding of a minute (`fillMinute` `tradesWithheld` / `tradeBreaks`) is not copied into a fill's `observed`
  provenance; `observed.trades` is simply `null` for such a minute. The omitted effect is listed on every fill (§2).
* MISSING / BLOCKED BY DATA — options quote provider wiring into the replay and automatic expiration settlement (§2). A verified options feed
  (`POST /api/options/verify`) is wall-clock status only and never makes a replay options order fillable; no historical as-of options quote
  source exists.
* BLOCKED BY DATA — SEC filings, financing, sector (no `SEC_USER_AGENT`); licensed analyst views; GDELT media (HTTP 429); live/delayed quotes (no
  credentials: `POST /api/feeds/verify` answers 409 `NO_VERIFIED_DATA` until a provider is configured). See `docs/LIMITATIONS_FROM_REVIEW.md` §1.
