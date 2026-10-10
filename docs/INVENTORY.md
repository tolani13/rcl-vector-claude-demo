# Implementation inventory

*Rewritten in review round 2 (docs area, 2026-10-09 around 17:45 UTC); model rows updated by the orchestrator after the final live runs (2026-10-09 ~23:30 UTC), after the other round-2 areas had stopped changing server code. Interfaces are in `docs/CONTRACTS.md`; what is still not implemented is listed in its §10. Status words:*

* **COMPLETE**: built, with tests or receipts on real data where real data exists.
* **PARTIAL**: built, with a stated gap.
* **MISSING**: not built.
* **BLOCKED BY DATA**: built as far as possible; a real source or credential is missing. See `docs/LIMITATIONS_FROM_REVIEW.md` §1.
* **FUTURE**: out of scope by design.

## Practical acceptance criteria (frozen prompt v1.3, items 1–8)

| # | Criterion | Status | Evidence | Gaps |
|---|---|---|---|---|
| 1 | Starts locally, with explicit instructions; honest empty or disconnected states; mobile-first layouts verified at phone and desktop sizes | COMPLETE | `docs/SETUP.md`; `test/api/empty.test.js`; `docs/UI_CHECKS.md` and `docs/MOBILE_QA.md` (phone and desktop route checks, the phone buy/sell flow and the narrow replay/assessment view) | The README is written by the orchestrator. The browser check was Chromium only, and web files changed again in round 2 after the last recorded UI check. |
| 2 | Dashboard: penny/microcap vs large-cap views, opportunities, source status, timestamps, price/return series | COMPLETE | Overview segment switch (Penny / micro, Under 5 USD, Large-cap); `server/research/scanner.js` and `test/data/scanner.test.js` (common-equity-like rows first, `THIN_BASELINE` relVol kept out of the score); opportunities `windowMin=5|15|30|60` and `instruments=all|common|non_common`; `#/sources` and `GET /api/sources`; as-of labels on every row; `web/js/charts.js` | Days/weeks horizons are BLOCKED BY DATA (one ingested day). Market cap is not verified for any segment. |
| 3 | Paper lab: six lens × segment portfolios plus a sandbox; configurable seed money; real simulated orders, whole shares, cash, positions, P&L and a durable journal; overspend and oversell rejected; no impossible fills; handwritten example kept exploratory | COMPLETE | `test/sim/{orders,fills,ledger,gate,options}.test.js`; `test/agents/lifecycle.test.js`; `receipts/journal-samples/real-*.json` and `fixture-*.json` (incl. `fixture-sim-spend-cap.json`, `fixture-sim-displayed-size-consumed.json`, `fixture-sim-bracket-clamp-after-manual-sell.json`); reset with `startingCashU` (Replay view); `FILL_WITHHELD` when no credible fill exists; the Lab's modify form uses `POST /api/orders/:id/replace`; `docs/OPEN_QUESTIONS.md` | The six lens presets made 0 entries on the real day; only the handwritten-notes preset (`agent-cowboy-micro`) traded. The real-data receipts were regenerated with the final 22-rule gate (LIMITATIONS §2). |
| 4 | Replay of a real, sourced, as-of timeline; no look-ahead; repeatable reset; one real signal/failure comparison | COMPLETE (one day) | `receipts/ingest-iex-tops-2026-10-07.json`; `test/agents/replay.test.js` (no-look-ahead runner and differential tests, deterministic reset) and `test/agents/reset.test.js`; `receipts/research-study-2026-10-07.json` (retrospective +22 %/15-min study, labelled hindsight, withheld until the replay reaches the close) | Only one IEX day (2026-10-07) is ingested. |
| 5 | Reconnaissance view: company and sector, dated catalysts/media, leadership and financing or honest unknowns, three investor perspectives | PARTIAL / BLOCKED BY DATA | `server/research/dossier.js` and `test/data/dossier.test.js`: identity (Nasdaq Trader; post-dated, so shown only as a labelled current directory), market, halts, FINRA short volume, plus per-section `BLOCKED` / `UNAVAILABLE_NOT_VERIFIED` (sector, analyst views). Evidence packets (v3) state the same unknowns. Three-lens panel with cited evidence opened through `GET /api/evidence?ids=`. Real runs of the current prompt path on the real 10:30 ET packet: `receipts/model-smoke-ollama.json` (qwen3:8b, native Ollama; all 3 lenses valid, 2 after one bounded repair: Cowboy consider_entry, Pragmatist consider_entry, Tightwad avoid), an HTTP-API run shown in `receipts/ui-model-connected/lens-panel-*.png` (Pragmatist left `INVALID_OUTPUT`, shown honestly), and the `model_confirm` agent run `receipts/e2e-model-confirm-ollama-2026-10-07.json`. | **BLOCKED BY DATA:** filings and sector (`SEC_USER_AGENT`); media (GDELT HTTP 429). **Unavailable:** leadership and analyst views. **Model quality:** a small local model; outputs are validated but not fact-checked (the `NUMBERS UNVERIFIED` cross-check flags misquotes). Paid providers were not called. |
| 6 | Documented extensibility; at least one authentic ingestion path, a real request-capable model adapter, and a working paper-order loop over verified historical quotes | COMPLETE | `docs/ARCHITECTURE.md` §7; IEX, FRED, FINRA and symbol-directory receipts; three model adapters (Anthropic SDK, OpenAI-compatible, native Ollama with per-request context); the Ollama smoke receipt; `receipts/journal-samples/real-*.json` | Live/delayed feed mode is **BLOCKED** (credentials). `POST /api/feeds/verify` and `POST /api/options/verify` exist, but the Alpaca/Polygon adapters have never run against genuine data, and there is no UI button for them. |
| 7 | Safety and integrity: paper-only enforced in the backend, validation, no hardcoded secrets, honest status vocabulary, bounded cost | COMPLETE | `server/policy/gate.js` (`PAPER_ONLY` constant; 22 deny-by-default rules incl. `target_order_matches` and `protective_exit_required`); `test/sim/gate.test.js`; `test/api/guards.test.js` (CSRF, body limits, strict validation, host allow-list, secret scrubbing); model call budgets (60 per session, 300 per rolling 24 h; calls refused before any response are not counted; a dropped connection after sending is); hindsight guard on model training cutoffs | Dilution and delisting checks are BLOCKED BY DATA (SEC). There is no split adjustment. No authentication beyond the loopback bind and the remote-mode token. |
| 8 | Build, source, README/setup, tests and their results, inventory, known limitations, architecture report | PARTIAL until the README exists | This file; `docs/SETUP.md`; `docs/LIMITATIONS_FROM_REVIEW.md`; `docs/ARCHITECTURE.md`; `docs/CONTRACTS.md`; `docs/UI_CHECKS.md`; `docs/MOBILE_QA.md`; `npm test` | `receipts/npm-test-2026-10-09.txt` records the round-2 integration run after the last code change: 433/433 passed. `receipts/ui-check.json` 320/320; `receipts/e2e-real-replay-2026-10-07.json` regenerated. The README is not written yet. |

## Mobile-first and brand requirements

| Requirement | Status | Evidence |
|---|---|---|
| 360×780, 390×844, 430×932 and 1440×900; bottom tabs on phones; ~44 px targets; 16 px body and form text; no page overflow; status labels visible | COMPLETE (re-check after round-2 web changes) | `docs/UI_CHECKS.md`, `docs/MOBILE_QA.md`. Secondary labels go down to 12 px, which is recorded as an observation. |
| Documented phone buy and sell flow, and a narrow replay/assessment view | COMPLETE | `docs/ui-checks/2026-10-09/real-flow-*` and `real-narrow-*` |
| Supplied RCL assets used, or a fallback explained | COMPLETE (an external logo change is pending an owner decision) | The header, favicon and About page use `web/assets/RCL_Copper_Steel_{Mark,Full}.svg`; see `docs/RCL-Logo-Source.md`. The supplied Convergence SVGs remain unchanged in `web/assets/`. |

## Agentic acceptance proof (frozen prompt v1.3, line 43)

| Item | Status | Tests | Journal samples (`receipts/journal-samples/`) |
|---|---|---|---|
| Autonomous paper buy | COMPLETE | `test/agents/lifecycle.test.js` | `fixture-agents-autonomous-buy.json`; `real-autonomous-buy.json` (agent-cowboy-micro) |
| Attached stop | COMPLETE | `test/agents/lifecycle.test.js`, `test/sim/orders.test.js` | Bracket children in both autonomous-buy samples; `fixture-sim-bracket-protective-exit.json` |
| Triggered stop with a worse-than-stop modelled fill | COMPLETE (fixture); real data shows only a placement-triggered stop | `test/agents/lifecycle.test.js`, `test/sim/fills.test.js` | `fixture-agents-triggered-stop.json`. `real-triggered-stop.json` is labelled PLACEMENT-TRIGGERED: the GIPR stop sat 1,964 bps above the IEX bid when it went live (OPEN_QUESTIONS #4), so no price-move-triggered stop occurred on real data. |
| Take-profit | COMPLETE (fixture only) | `test/agents/lifecycle.test.js` | `fixture-agents-take-profit.json`. None filled on the real day. |
| Cancellation | COMPLETE | `test/agents/lifecycle.test.js`, `test/sim/orders.test.js` | `fixture-agents-cancellation.json`; `real-cancellation.json` |
| Rejection on budget | COMPLETE | `test/agents/lifecycle.test.js`, `test/sim/gate.test.js` | `fixture-agents-budget-rejection.json`; `real-budget-rejection.json` |
| Rejection on stale quotes | COMPLETE | `test/agents/lifecycle.test.js`, `test/sim/gate.test.js` | `fixture-agents-stale-quote-rejection.json`; `real-stale-quote-rejection.json` |
| Global kill switch | COMPLETE | `test/agents/controls.test.js` | `fixture-agents-kill-switch.json`; `real-kill-switch.json` |
| One paper long-put contract example | COMPLETE (TEST FIXTURE only; operational path BLOCKED BY DATA) | `test/sim/options.test.js` | `fixture-sim-long-put-example.json`. There is no as-of options provider, and orders get 409 `NO_VERIFIED_OPTIONS_DATA`. |
| Independent model-adapter output tests using mocks | COMPLETE | `test/intel/{model-provider,openai-compatible,ollama,anthropic,assessments,lens-guards,evidence}.test.js` | Not applicable. Real runs: `receipts/model-smoke-ollama.json` and `receipts/e2e-model-confirm-ollama-2026-10-07.json` (LIMITATIONS §4). |

## Out of scope by design

| Item | Status |
|---|---|
| Live broker or any real order path | FUTURE. It would need separate owner authorization, a dry-run gate, idempotency, a hard kill switch and monitoring. |
| Shorts, calls, margin, naked options | FUTURE. Only long puts are supported, and those only as fixtures. |
