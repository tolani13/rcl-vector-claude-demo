# Open questions preserved from the owner's notes (not silently decided)

Source: `vector_shared/source-notes/*.jpeg` and `HANDWRITTEN_NOTES_TRANSCRIPTION.md`. VECTOR represents these as an
**exploratory strategy preset** (`handwritten-notes-example`) and as a retrospective study on real data. Nothing below is
treated as validated or as an execution mandate.

| # | Ambiguity in the notes | What VECTOR does by default (simulation only) | Still open for the owner |
|---|---|---|---|
| 1 | "Auto sell @ … 250% gain" vs "auto sell @ 250% of purchase price". A 250% *gain* exits at 3.5× entry; 250% *of price* exits at 2.5× entry. | Shows both. Default take-profit uses the lower, more conservative 2.5× (250% of price) and labels it. | Which did you mean? |
| 2 | Worked example sells at $2.50 after buying at $1.22 (≈ 2.05×, ≈ +105%), matching neither reading. | Recorded as an inconsistency; not used as a rule. | Was $2.50 a rounded target or a different rule? |
| 3 | "$50 dollar limit" vs "42 shares @ $1.22" = $51.24, which breaches a strict $50 cap. | Whole shares are computed so cost **including estimated slippage and fees** never exceeds the cap (e.g. 40 shares, not 42). | Is the cap hard (as modelled) or approximate? |
| 4 | "Set stop order of (current/purchase cost)" / "if dips — sell @ $1.22 prevent loss". | The stop trigger is placed **at the entry reference, which is the decision-time IEX ask**. The IEX bid sits below that ask, so on penny names the stop is usually already at or above the bid when it goes live and triggers on its first evaluated minute. A stop is a *trigger*, not a guaranteed price: the fill model sells at the worst observed bid in the trigger minute minus slippage, so losses below entry are modelled (worse-than-stop fills). The engine journals this as `stopCheck.stopAtOrAboveBid` with `STOP_MARKETABLE_AT_SUBMIT` / `_ACTIVATION`. The policy gate lets this one preset through as informational (question C below); other agent strategies are denied a stop at or above the bid. | Should the stop sit below entry? Options, none built: trigger at min(entry reference, bid − 1 tick); arm the stop only once the bid reaches the entry reference; or trigger on the last trade instead of the bid. |
| 5 | "If not +/-10% for 15 min — sell @ current level": relative to entry, signal price, or a rolling reference? | Optional time-exit rule measured from the **entry fill price**, labelled as an assumption. It is an agent-monitored rule, evaluated only while the agent is RUNNING; it is suspended (`TIME_EXIT_SUSPENDED`) while the agent is paused, stopped, blocked or faulted, and a missed deadline is evaluated after a human resumes the agent. | Which reference was intended? |
| 6 | "Has velocity — Buy/share count", "1.1M shares bought". | Volume is never called buying intent. "Intent" is an *inferred* aggressor share (trade at/above IEX ask vs at/below bid), IEX-only, null when too little volume is classifiable. | Is order-flow aggressor imbalance the intended meaning of "intent"? |
| 7 | "+22% in 15 minutes" trigger. | Exploratory threshold. The retrospective study measures how often it occurred on the replay day and what happened next (continued vs failed), using data after the signal — clearly labelled hindsight. | Thresholds and confidence are not empirically validated. |
| 8 | Broker: "Robinhood" crossed out → "Webull". | No broker integration exists. Live trading is out of MVP scope. | Any future broker adapter needs separate authorization. |
| 9 | "WCS + WMS training + design / need digital twin" (bottom of the earlier page). | Treated as unrelated to VECTOR. | — |
| 10 | The notes target "stocks below $1.00 per share", but the worked example buys at $1.22 after a move up from $1.00. | The < $1.00 filter is applied to the latest as-of IEX trade. That is the same rule the micro-segment universe and the policy gate's `symbol_allowed` check use. So the handwritten preset (`maxPriceU` 10,000 u = $1.00) never proposes the $1.22 entry, and the gate would deny it (`SYMBOL_NOT_IN_SEGMENT`). The owner's own example is therefore structurally excluded. This is recorded, not changed silently. | Should the price filter apply to the pre-move reference price (the $1.00 level) instead of the latest trade? |

Rows 1–6 and 10 are also carried in code as `HANDWRITTEN_AMBIGUITIES` in `server/agents/strategies.js`, and every preset proposal shows them. The ids are:

| Row | Code id |
|---|---|
| 1, 2 | `take-profit-250` |
| 3 | `budget-50-vs-42-shares` |
| 4 | `stop-at-entry` |
| 5 | `stagnation-exit-reference` |
| 6 | `velocity-intent-volume` |
| 10 | `price-tier-vs-example` |

Rows 7–9 have no code id. Keep this list and the code in sync: a new code id needs a row here.

Evidence for row 4 from the replay day: the retrospective study is hindsight, labelled as such and never visible to agents. In it, every entered +22 %/15-min signal hit the at-entry stop in its first evaluated minute, with a worse-than-stop modelled fill:

* 4 of 4 entries in the < $1 tier.
* 10 of 10 entries in the < $5 tier.

The cause is that the IEX bid sits below the ask that was paid; see `receipts/research-study-2026-10-07.json`, `immediateStopTriggers`. This describes one day only. It is not a validated result.

The real-data replay shows the same thing. In `receipts/journal-samples/real-triggered-stop.json` (GIPR, 2026-10-07):

* The entry was submitted with the IEX bid at $0.5990 and the ask at $0.6700. The stop was placed at the ask, $0.6700, 1,185 bps above the bid.
* The entry filled (estimated) at $0.6734. When the stop went live the bid was $0.5600, so the stop was 1,964 bps above it.
* The stop triggered on its first evaluated minute and filled (estimated) at $0.5572, a worse-than-stop fill.

That stop triggered because of where it was placed, not because the price moved. No stop placed below the bid triggered on the real day.

## Policy questions raised in the 2026-10-09 review

These are not in the handwritten notes. VECTOR runs with the stated default and does not decide them silently.

| # | Question | What VECTOR does by default (simulation only) | Still open for the owner |
|---|---|---|---|
| A | Should bracket children count toward `order_rate_per_min`? | They count. The rule counts every order row the portfolio created in the last minute, so a bracket entry with a stop-loss and a take-profit uses 3 of the limit. Exits and cancels are never rate-limited. Excluding children broke a deterministic replay test that depends on the current count, so the change was reverted. | Count children or not? |
| B | A true small-cap segment. | The segment switch offers "Penny / microcap" (< $1.00), "Under 5 USD · small-cap proxy" (< $5.00; it includes the penny tier and is labelled as a proxy) and the configured large-cap list. No market-cap screen exists, because SEC shares outstanding are BLOCKED without `SEC_USER_AGENT`. | Is a $1–$5 band wanted, or a market-cap screen once SEC data is available? |
| C | Should the handwritten example keep its at-entry stop although it sits at or above the bid (#4)? | The gate rule `protective_exit_required` denies any agent entry whose protective stop is at or above the as-of IEX bid, **except** an agent running the documented `handwritten-notes-example`: its stop is recorded as informational, with the distance from the bid, so the example still runs as written and still triggers on its first evaluated minute. Human sandbox orders are not checked. There is no gate rule for a fully coherent bracket (take-profit above the entry, and so on). | Keep the exemption, deny it like the other strategies, or change the stop placement (#4)? |

Other open research questions carried from the concept ledger: historical catalyst timestamps (SEC acceptance times,
news distribution), OTC / non-U.S. / after-hours coverage, expert-opinion predictiveness and baselining, and how to avoid
overfitting, manipulation and microcap survivorship bias. The stored IEX universe, and therefore the retrospective study, is
conditioned on symbols that traded below $5 at some point that day (`server/data/universe.js` `STORAGE_MAX_PRICE_U`). This
is a documented selection bias of the study, not of the as-of views, which reveal a symbol only once its first sub-$5 minute is complete.
