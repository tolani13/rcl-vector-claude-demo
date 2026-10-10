# Mobile and desktop UI QA

## Current run: ui-polish-v1 (2026-10-09, recorded 02:00:53 UTC on 2026-10-10)

`receipts/ui-check.json` and `receipts/ui/*.png` now hold the ui-polish-v1 run.
- Command: `node scripts/ui-check.mjs --base http://127.0.0.1:8799 --prepare-ds iex-tops-2026-10-07 --prepare-to 10:45`.
- Server: a disposable `VACUUM INTO` copy of `data/vector.db`, deleted afterwards.
- Result: **768/768 assertions passed, 95 screenshots, exit 0.**

| | |
|---|---|
| Sizes (new in this run) | Phones 360×780, 390×844, 430×932 (touch, `mobile:true`, dsf 2). Tablets 768×1024 and 1024×1366 portrait, 1024×768 landscape (touch, dsf 2). Desktops 1440×900 and 1920×1080 (dsf 1). The tablet band and 1920 are new. |
| Routes | `#/overview`, `#/research`, `#/research/<SYM>` (chosen at run time), `#/lab`, `#/agents`, `#/replay`, `#/journal`, `#/sources`, `#/about`, `#/more`. That is 80 route checks. |
| Flows | Phone sandbox BUY then SELL at 390×844, with confirmation, gate result and estimated fill. Narrow replay play/pause plus the three-lens panel at 360×780. Both completed. |

### Overflow tripwire (build-failing)

`overflow_tripwire` and `overflow_tripwire_expanded` run on every size and route. The expanded check runs again after opening every `<details>`. Each one fails when:
- `documentElement.scrollWidth` or `body.scrollWidth` exceeds the root's visible width;
- the layout viewport is wider than the emulated width (in mobile emulation, overflow widens the layout viewport, so a plain `scrollWidth > innerWidth` test can't fire);
- the visual scale is not 1.

Any tripwire failure makes the script exit **3**, which wins over 1. It prints the widest offending elements and where the overflow enters.
- This run: **160/160 tripwire checks passed.**
- **Red→green:**
  - **Before** (commit `3d749b2`, `receipts/ui-polish-v1/tripwire-red.json`): 768×1024 `#/research` overflowed to 818 px, entering at `div.field.choice` inside `.opt-row` (two `max-content` grid columns beside the tablet sidebar). The run exited 3.
  - **After** (`tripwire-green.json`): 10/10 passed, exit 0. The fix makes `.opt-row` a wrapping flex row.

### Measurements (this run)

| Viewport | Status strip | Primary navigation | Notes |
|---|---|---|---|
| 360×780 | 3 rows, 102 px | bottom tabs ≥ 44 px | Data-truth chips render at 16 px on phones (owner rule), which needs a third row at 360–390 px. |
| 390×844 | 3 rows, 102 px | bottom tabs ≥ 44 px | |
| 430×932 | 2 rows, 68 px | bottom tabs ≥ 44 px | |
| 768×1024 | 2 rows, 86 px | sidebar, all targets ≥ 44 px (the logo link is now 44 px) | |
| 1024×1366 / 1024×768 | 2 rows, 62 px | sidebar, all targets ≥ 44 px | Below 1280 px the 12-column grid collapses to 2 columns, so panels don't squeeze charts. |
| 1440×900 / 1920×1080 | 1 row | sidebar | Content clamps to 1360 px and is centred. |

The strip assertion is now `status_strip_rows`: at most **3 rows on phones** (16 px chips) and 2 on tablets. Body text is ≥ 16 px and form controls ≥ 16 px at every size. There are no uncaught errors and no render artifacts.

Before and after screenshots for Overview, Replay, Agents and Journal at 390 and 1440 are in `receipts/ui-polish-v1/before|after/` (viewport) and `before-clean|after-full/` (full page). Overflow at every new width before the polish: `receipts/ui-polish-v1/overflow-baseline.json` and `before/ui-check-baseline.json`.

**Not covered (unchanged):** WebKit/Safari, a physical phone, `prefers-reduced-motion` rendering, forced-colors rendering, and an automated colour-contrast audit.

---

*The sections below describe the earlier 4-size run (18:27 UTC, before ui-polish-v1). They are kept for history; the measurements above supersede them.*


This page summarises the run recorded in `receipts/ui-check.json`, with screenshots in `receipts/ui/`. Nothing here goes beyond what that receipt records. Every fill in the screenshots is an **ESTIMATED PAPER FILL** in a paper-only lab: real stored IEX data, simulated seed money, no exchange.

## The run

| | |
|---|---|
| Script | `scripts/ui-check.mjs` (also `npm run ui-check -- --base <url>`). No dependencies: it drives headless Chrome or Edge over the DevTools protocol with Node's global `WebSocket`. It is not part of `npm test`. |
| Recorded | 2026-10-09, 18:27:07 to 18:27:55 UTC (review round 2 integration pass, after the last code change) |
| Browser | Chrome 156.0.8078.12, `--headless=new`, temporary profile, DevTools on a free port |
| Server | `http://127.0.0.1:8795` (`VECTOR_PORT=8795`). It ran on `data/qa-copy.db`, a `VACUUM INTO` copy of `data/vector.db` that was deleted afterwards. `data/vector.db` and the shared 8787 server were not touched. |
| Data | `iex-tops-2026-10-07` (IEX HIST TOPS, SHA-256 `bb405b68…0e458256`), data mode `HISTORICAL_REAL` |
| Replay | The script reset the replay to that dataset and stepped it to 10:45 ET before the checks (`--prepare-ds iex-tops-2026-10-07 --prepare-to 10:45`). Session `ses_mv1arxc8adc637086d`; all agents PAUSED. |
| Model, kill switch | Model `DISCONNECTED` (no provider configured on this server). Kill switch off. |
| Symbols | Chosen at run time from `/api/research/opportunities`, never hard-coded. The dossier route used `CAN`, the top-ranked micro row with a score that is not flagged non-common. The trade flow used `NVDA`: in the large segment it was the most active row with a two-sided IEX quote ≤ 60 s old, spread ≤ 50 bps (1 bps here) and ≥ 20 trades in the scan window. |

## Sizes and routes

| Viewport | Emulation |
|---|---|
| 360×780, 390×844, 430×932 | Touch phone: `Emulation.setDeviceMetricsOverride` with `mobile: true` and `deviceScaleFactor: 2`, plus touch emulation |
| 1440×900 | Desktop: `mobile: false`, `deviceScaleFactor: 1` |

Device-metrics emulation is used because `--window-size` is not reliable below about 500 px in headless Chrome.

The routes were `#/overview`, `#/research`, `#/research/CAN`, `#/lab`, `#/agents`, `#/replay`, `#/journal`, `#/sources`, `#/about` and `#/more`. Each route was loaded fresh at each size, and the script waited until no loading placeholder was left. That makes 40 route checks, each with a viewport PNG at `receipts/ui/<size>-<route>.png`, for example `receipts/ui/390x844-research-CAN.png`.

## Assertions

The run made **320 assertions and all 320 passed** (`summary` in the receipt).

| Assertion | Applies to | Count | Result |
|---|---|---|---|
| `no_horizontal_overflow`: `scrollWidth ≤ innerWidth`, `scrollWidth ≤ clientWidth`, visual scale 1, and `innerWidth` equal to the emulated width | every route at every size, every flow screenshot | 40 + 10 + 4 | pass |
| `status_strip_complete`: data mode, PAPER ONLY, model and kill-switch chips present, non-empty and fully on screen (chips are found by their `data-chip` hook, so a PARTIAL dataset's phone key `PARTIAL` is not misread as a missing data chip) | every route at every size | 40 | pass |
| `bottom_nav_44px`: bottom nav visible, at least 5 links, each ≥ 44 px tall | phones | 30 | pass |
| `status_strip_two_rows`: status strip wraps to at most 2 rows | phones | 30 | pass |
| `form_controls_16px`: inputs, selects and textareas ≥ 16 px | phone routes that have form controls | 18 | pass |
| `desktop_sidebar_visible`: sidebar shown and bottom nav hidden | 1440×900 | 10 | pass |
| `body_font_16px`: computed body font-size ≥ 16 px | every route at every size | 40 | pass |
| `no_render_artifacts`: no `[object Object]`, `undefined` or `NaN` in the main text | every route at every size | 40 | pass |
| `no_uncaught_errors`: no uncaught exception or `console.error` while the route loaded | every route at every size | 40 | pass |
| Flow assertions other than overflow (listed below) | phone and narrow flows | 18 | pass |

Measured values in the receipt (`routes[].metrics`):

| Viewport | Largest `scrollWidth` | Status strip | Bottom-nav links | Body / smallest form font |
|---|---|---|---|---|
| 360×780 | 360 | 2 rows, 55 px | 5 links, 72×58 px | 16 / 16 px |
| 390×844 | 390 | 2 rows, 55 px | 5 links, 78×58 px | 16 / 16 px |
| 430×932 | 430 | 2 rows, 55 px | 5 links, 86×58 px | 16 / 16 px |
| 1440×900 | 1440 (clientWidth 1425, i.e. 15 px vertical scrollbar) | 1 row, 44 px | none (sidebar) | 16 / 16 px |

The phone strip read `DATA HISTORICAL_REAL · REPLAY 10:45 ET · PAPER ONLY · MODEL DISCONNECTED · KILL OFF`. The desktop strip adds `SET iex-tops-2026-10-07` and shows the long labels `PAPER ONLY — NO LIVE TRADING` and `KILL SWITCH OFF`.

## Phone sandbox BUY and SELL (390×844)

The flow uses the real UI: CDP mouse events on the rendered controls and typed text. The quantity was `floor($400 / as-of IEX ask $237.81)` capped at 100 shares, which gives 1 share.

| # | Screenshot | What it shows (from the receipt) |
|---|---|---|
| 1 | `receipts/ui/flow-390x844-01-buy-review.png` | "Review paper order" with PAPER ONLY and UI ESTIMATE, BUY 1 sh NVDA · MARKET, and the as-of IEX quote (bid $237.78 × 720 / ask $237.81 × 420) |
| 2 | `receipts/ui/flow-390x844-02-buy-confirm.png` | The confirmation step: "BUY 1 sh NVDA · MARKET · estimated total cost $237.93" with the button "Confirm BUY 1 NVDA ≈ $237.93" on screen above the bottom nav |
| 3 | `receipts/ui/flow-390x844-03-buy-gate-result.png` | "POLICY GATE DECISION · BUY 1 SH NVDA · MARKET", `ACCEPTED`, "Policy checks (23)" (`intent_valid` plus the 22 required rules) |
| 4 | `receipts/ui/flow-390x844-04-buy-replay-step.png` | The Replay view after "Step 1 minute": 10:45 → 10:46 ET |
| 5 | `receipts/ui/flow-390x844-05-buy-fill.png` | "BUY NVDA ESTIMATED PAPER FILL", 1 at $238.01, minute 10:45 ET, fill model `iex-conservative-minute-v1` |
| 6 | `receipts/ui/flow-390x844-06-sell-review.png` | SELL 1 sh NVDA · MARKET review (bid $237.72 × 140 / ask $237.74 × 600) |
| 7 | `receipts/ui/flow-390x844-07-sell-confirm.png` | "SELL 1 sh NVDA · MARKET · estimated net proceeds $237.59" and "Confirm SELL 1 NVDA ≈ $237.59" |
| 8 | `receipts/ui/flow-390x844-08-sell-gate-result.png` | Policy gate decision `ACCEPTED` |
| 9 | `receipts/ui/flow-390x844-09-sell-replay-step.png` | Replay stepped 10:46 → 10:47 ET |
| 10 | `receipts/ui/flow-390x844-10-sell-fill.png` | "SELL NVDA ESTIMATED PAPER FILL", 1 at $237.47, fees $0.0069, minute 10:46 ET |
| 11 | `receipts/ui/flow-390x844-11-journal.png` | The Journal view with `CHAIN_VERIFIED` (hash chain verified over 2,525 entries of the copy) |

The flow assertions all passed:

* For both BUY and SELL: `*_confirmation_step_shown`, `*_confirm_button_on_screen`, `*_gate_result_shown`, `*_accepted_by_policy_gate` and `*_replay_stepped`.
* `*_estimated_fill`, checked through `GET /api/portfolios/sandbox`. Both fills came after one replay minute: BUY at 2,380,100 u, SELL at 2,374,700 u (u = 1e-4 USD).
* `flow_completed`.
* `tap_targets_44px_uncovered`: every tapped control was at least 44 px tall and not covered by another element. The quantity field and Review button were 324×44, Confirm 143×60, Step 1 minute 158×44 and the Sell segment 157×44.

## Narrow replay and assessment panel (360×780)

| Screenshot | What it shows |
|---|---|
| `receipts/ui/narrow-360x780-01-replay-paused.png` | Replay view, paused at 10:47 ET |
| `receipts/ui/narrow-360x780-02-replay-playing.png` | After tapping Play: the strip reads `REPLAY 10:49 ET ▶`, and the server reported `replay.playing = true` |
| `receipts/ui/narrow-360x780-03-replay-paused-again.png` | After Pause: the server reported `replay.playing = false` at 10:49 ET |
| `receipts/ui/narrow-360x780-04-assessment-panel.png` | The `#/research/CAN` three-lens assessment panel, 328 px wide (x 16..344), in the honest state `MODEL DISCONNECTED / ASSESSMENT NOT RUN` |

Passed: `replay_playing_after_play`, `replay_paused_after_pause`, `assessment_panel_shown`, `flow_completed`, and no overflow on any of the four screenshots.

## Defects found by looking at the screenshots, and fixed

These came from the round-1 runs on the same setup; the round-2 run above found no new failure (320/320 again) and no visual defect in the screenshots reviewed (Sources, the narrow assessment panel with the new native-Ollama setup text). `scripts/ui-check.mjs` was changed only to locate strip chips by `data-chip`.

1. **Script bug, not a UI defect.** The desktop overflow assertion compared `clientWidth` with 1440. The 15 px desktop scrollbar made 9 desktop routes "fail" with `scrollWidth 1425 = clientWidth 1425`, which is not overflow. The assertion now requires `innerWidth` to equal the emulated width.
2. **Phone Overview and Research showed no ranked row on the first screen.** A 10-line method note sat above the list. The server's note is now in a "Method and caveats" disclosure (`methodNote` in `web/js/views/common.js`). It is collapsed below 600 px and open from 600 px up, and an opened or closed choice survives clock-tick re-renders. The as-of time, window, row counts and the `SIGNAL METRICS — NOT RECOMMENDATIONS` banner stay visible (see `390x844-research.png` and `1440x900-research.png`).
3. **Data sources tile clipped a long token at 430 px.** `ALPACA_API_KEY_ID/ALPACA_A…` was cut off. `.metric-s` now wraps long tokens (`overflow-wrap: anywhere` in `web/styles.css`; see `430x932-sources.png`).
4. **"1 shares"** in the order review. It now reads "1 share" (`web/js/views/lab.js`).
5. **The flow's confirm screenshot did not show the Confirm button**, because the review is taller than a phone screen. The script now captures the review and the confirm controls separately and asserts that the button is on screen.

Separately, in the integration pass before this run, the kill-switch option cards on `#/agents` were fixed so the title and description no longer run together ("Keep protective exitsStop all agents…"): `.radio-card .t, .radio-card .d { display: block; }`. See `360x780-agents.png`.

## What this run does not cover

* Only Chromium (Chrome 156) was used. There was no WebKit/iOS Safari, no Firefox and no physical device, so real safe-area insets and Safari form zoom were not observed.
* Landscape, `prefers-reduced-motion` and colour contrast were not checked.
* Route screenshots capture the viewport only, not the full page.
* Only body and form-control text are asserted at ≥ 16 px. Secondary text (chips, captions, table labels) is smaller and is not asserted.
* Not exercised: a connected model (this server had none), the kill-switch confirmation, the strategy editor, the long-put ticket (no verified options data), a limit/stop order, the order modify control, and the API-unreachable state. `docs/UI_CHECKS.md` covers the unreachable and fixture layouts from an earlier pass, with its own script under `docs/ui-checks/`.

## Re-running

From the repository root. Never point the script at port 8790. It refuses 8787 (the shared server) unless `--allow-shared` is passed, because it places sandbox paper orders and moves the replay clock.

```bash
node --disable-warning=ExperimentalWarning -e "const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync('data/vector.db',{readOnly:true});d.exec(\"VACUUM INTO 'data/qa-copy.db'\");d.close()"
VECTOR_PORT=8795 VECTOR_DB=data/qa-copy.db npm start                       # separate terminal
node scripts/ui-check.mjs --base http://127.0.0.1:8795 --prepare-ds iex-tops-2026-10-07 --prepare-to 10:45
# then stop the server and delete data/qa-copy.db* (including -wal / -shm)
```

Options:

* `--browser <path>` selects the browser. The default is Chrome, then Edge, at their standard Windows paths.
* `--flows 0` runs the route checks only.
* `--research-sym` and `--trade-sym` override the symbols chosen at run time.
* `--out-dir` and `--report` change where the screenshots and the JSON go.

The exit code is 0 when every assertion passed, 1 when any failed, and 2 when the script refused to run.

## Addendum: model connected (real local model), 2026-10-09

The route checks were run a second time with a real model connected. The server ran on port 8797 against a disposable copy of the database, with `VECTOR_MODEL_PROVIDER=ollama` and qwen3:8b. The replay was at 10:30 ET, and a three-lens assessment of TOPP had been run through `POST /api/assessments/run`.

* Command: `node scripts/ui-check.mjs --base http://127.0.0.1:8797 --flows 0 --research-sym TOPP --out-dir receipts/ui-model-connected --report receipts/ui-check-model-connected.json`
* Result: **288/288 assertions passed, 40 screenshots**, with the status strip reading `MODEL CONNECTED`.
* Full-element captures of the three-lens panel: `receipts/ui-model-connected/lens-panel-390x844.png` (stacked cards on a phone) and `lens-panel-1440x900.png` (side by side). They show Cowboy *consider entry* with a VALID draft intent, Pragmatist `INVALID_OUTPUT` with the validator reason, and Tightwad *avoid*. Each card has its NUMBERS UNVERIFIED cross-check and a provenance footer (provider, model, as-of time, packet hash, latency, evidence count).
