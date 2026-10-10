# Responsive UI checks: desktop and phone

> **Superseded for real-data runs.** The current matrix (8 sizes including the tablet band and 1920, plus the build-failing overflow tripwire) is in `docs/MOBILE_QA.md` → "Current run: ui-polish-v1". The current matrix (8 sizes including the tablet band and 1920, plus the build-failing overflow tripwire) is in `docs/MOBILE_QA.md` → "Current run: ui-polish-v1". The current matrix (8 sizes including the tablet band and 1920, plus the build-failing overflow tripwire) is in `docs/MOBILE_QA.md` → "Current run: ui-polish-v1". The current matrix (8 sizes including the tablet band and 1920, plus the build-failing overflow tripwire) is in `docs/MOBILE_QA.md` → "Current run: ui-polish-v1". After all fixes landed, the repeatable check moved to `scripts/ui-check.mjs`, which writes `receipts/ui-check.json` and `receipts/ui/*.png`. Its latest run is summarised in `docs/MOBILE_QA.md`. This page and `docs/ui-checks/` remain as the earlier mid-fix snapshot, including the fixture and API-unreachable layouts that the new run does not cover.

*Recorded 2026-10-09 between 15:56 and 16:05 UTC with headless Chrome 156.0.8078.12. Frozen prompt v1.3 asks for "documented desktop-and-mobile screenshot/interaction checks, including a phone-sized buy and sell flow and a narrow-width replay/assessment view". This page indexes that evidence.*

## Where the evidence is

| File | What it holds |
|---|---|
| `docs/ui-checks/ui-check.mjs` | The check script. It drives a locally installed Chrome or Edge over the DevTools protocol using Node's built-in `WebSocket`. It has no npm dependency and is not part of `npm test`. |
| `docs/ui-checks/2026-10-09/results-real.json` | Metrics for 11 routes × 4 viewports on real data, plus both interaction flows. Each result records its screenshot name. |
| `docs/ui-checks/2026-10-09/results-fixture.json` | The same route metrics against `test/web/check-server.mjs --mode fixture`. |
| `docs/ui-checks/2026-10-09/results-unreachable.json` | The same route metrics with every `/api/*` returning 503. |
| `docs/ui-checks/2026-10-09/*.jpg` | 129 screenshots: `real-*`, `real-flow-*`, `real-narrow-*`, `fixture-*`, `unreachable-*`. |

Each results file also records the browser version, the server's `/api/status` summary (data mode, dataset id and SHA-256, replay clock, model and options status), and a SHA-256 prefix for every file under `web/`. Those hashes show exactly which front end was checked. Re-run the check after any change under `web/`.

**This receipt is a snapshot from the middle of the fix pass.** Other fix areas were still editing `web/` while it was recorded. Within minutes of the run, eight files no longer matched the recorded hashes: `styles.css`, `js/estimate.js`, and `js/views/{journal,lab,overview,replay,research,sources}.js`. Re-run the three commands under "Re-running" once those edits have landed, and replace this directory before publishing.

The receipt sits under `docs/` because `receipts/` was outside the docs fix area. It can be copied to `receipts/ui-checks-2026-10-09/` unchanged.

## How each run was set up

| Run | Server | Data shown |
|---|---|---|
| `real` | `npm start` code on port 8795 (`VECTOR_PORT`), pointed at a `VACUUM INTO` copy of `data/vector.db`. The copy was deleted afterwards. The replay was reset and stepped to 10:30 ET. The model provider pointed at the local Ollama server (`qwen3:8b`), so the strip shows `MODEL CONNECTED`. | Real IEX HIST TOPS for 2026-10-07 (`iex-tops-2026-10-07`, SHA-256 `bb405b68…`). Every fill is an `ESTIMATED PAPER FILL`. |
| `fixture` | `node test/web/check-server.mjs --port 5192 --mode fixture` | TEST FIXTURE values only. The strip reads `DATA IMPORTED_UNVERIFIED` and `SET TEST-FIXTURE-NOT-MARKET-DATA`. The script also stamps every `fixture-*` image with a yellow "TEST FIXTURE — NOT MARKET DATA" banner after measuring, so no image can pass for a market outcome. |
| `unreachable` | `node test/web/check-server.mjs --port 5191 --mode unreachable` | Nothing. This run shows the honest empty layouts: `API UNREACHABLE`, `NO_VERIFIED_DATA`, `MODEL UNKNOWN`, `KILL SWITCH UNKNOWN`. |

The routes checked are `#/overview`, `#/research`, `#/research/<SYM>`, `#/lab`, `#/lab?p=sandbox`, `#/agents`, `#/replay`, `#/journal`, `#/sources`, `#/about` and `#/more`. The viewports are 360×780, 390×844 and 430×932, emulated as touch phones, plus 1440×900 desktop.

## What is measured, and what counts as a failure

For every route at every viewport the script records:

* page-level horizontal overflow (`scrollWidth − clientWidth`), and the first elements that stick out
* whether the bottom tab bar (phones) or the sidebar (desktop) is visible
* the status strip's height and how many rows it wraps to
* the smallest hit box among visible controls, and the controls under 44 px
* the computed font size of the body, of form controls, and of every text-bearing element
* whether the data-status, replay-clock and `PAPER ONLY` chips are fully on screen
* console errors

A route **fails** if any of these hold:

* it overflows horizontally by more than 1 px
* the phone tab bar or desktop sidebar is missing
* body or form-control text is under 16 px
* a status, clock or no-live-trade label is off screen. In unreachable mode, where no clock exists, the strip must instead say `API UNREACHABLE`.

Phone controls under 44 px are recorded as **minor**. Desktop controls are pointer targets, so they are reported but not judged.

## Results

| Run | Route checks | Pass | Fail | Minor | Console errors |
|---|---|---|---|---|---|
| real | 44 | 44 | 0 | 0 | 0 |
| fixture | 44 | 44 | 0 | 0 | 0 |
| unreachable | 44 | 44 | 0 | 0 | 0 |

| Viewport | Overflow | Navigation | Smallest control | Body / form text | Status strip (real; fixture and unreachable) |
|---|---|---|---|---|---|
| 360×780 | 0 px on every route | bottom tab bar | 44 px | 16 / 16 px | (mid-fix snapshot) 2 rows, 55 px; 3 rows, 83 px when the model chip reads DISCONNECTED or UNKNOWN. **Current (ui-polish-v1): 3 rows, 102 px; chips are 16 px on phones by owner rule.** |
| 390×844 | 0 px | bottom tab bar | 44 px | 16 / 16 px | 2 rows, 55 px |
| 430×932 | 0 px | bottom tab bar | 44 px | 16 / 16 px | 2 rows, 55 px |
| 1440×900 | 0 px | sidebar | 40 px (sidebar lockup link) | 16 / 16 px | 1 row, 44 px; 2 rows in fixture mode, where the long dataset id wraps |

### Phone sandbox buy and sell flow

The flow ran at 390×844 and again at 360×780, using real taps (CDP mouse events) and typed input. The ticket was `BAC`, 5 shares, on real 10:30 ET quotes. Screenshots are `real-flow-<viewport>-NN-<step>.jpg`.

1. **`01-ticket`**: the sandbox ticket, prefilled.
2. **`02-buy-review`**: the review panel. It shows the as-of IEX bid and ask with sizes, quote age, spread, estimated price, fees and the sandbox's cost model. A confirm button and an Edit button follow.
3. **`03-buy-gate-decision`**: Confirm BUY, then `POLICY GATE DECISION ACCEPTED` with the 21 policy checks collapsed.
4. **`04-replay-step-after-buy`**: the Replay view's "Step 1 minute" control. The script checked through `/api/status` that the clock moved by exactly one minute.
5. **`05-buy-fill`**: the `ESTIMATED PAPER FILL` card, with the fill model `iex-conservative-minute-v1`.
6. **`06-sell-review`, `07-sell-gate-decision`, `08-sell-fill`**: the same sequence for the SELL.
7. **`09-policy-rejection`**: a 100-share BUY. It returns `DENIED` with `BUDGET_EXCEEDED` (estimated cost over the $2,500 sandbox max trade spend) and `MAX_POSITION_PCT_EQUITY`.
8. **`10-journal`**: the journal with `CHAIN_VERIFIED`.

Across all 14 taps per flow, no target was smaller than 44 px or covered by another element, and the page never overflowed horizontally.

### Narrow replay and assessment view

The flow ran at 360×780 and 390×844. Screenshots are `real-narrow-<viewport>-*.jpg`.

* **Replay controls:** paused, then Play (the strip shows `REPLAY 10:3x ET ▶`; stepping is disabled while playing), then Pause.
* **Three-lens panel:** captured for `BAC` and `TOPP`. Each lens shows `ASSESSMENT_NOT_RUN` and offers "Run three-lens assessment". Every screenshot therefore shows the honest not-run state; none shows model output.

The server did refuse an assessment request sent during this pass with `BLOCKED`, because the training cutoff of `qwen3:8b` is unknown. The guard requires `VECTOR_MODEL_TRAINING_CUTOFF` to be set to the model's documented cutoff, and no cutoff was invented for this check. That refusal came back as an API response; it is not pictured in any screenshot.

## Observations that are not failures under the rules above

1. **Secondary text below 16 px.** Body and form text are 16 px everywhere. However, 81–87 % of text-bearing elements on phone routes are smaller: chips, labels, captions and helper text, down to 12 px (11.4 px on desktop). The prompt's 16 px rule covers body and form text, so these are recorded but not failed.
2. **Status strip height on phones.** *Current (ui-polish-v1, `receipts/ui-check.json`):* 3 rows / 102 px at 360 and 390 px, 2 rows / 68 px at 430 px, 2 rows on tablets and 1 row on desktop. The data-truth chips are 16 px on phones by owner rule. The assertion is `status_strip_rows` (max 3 on phones, 2 on tablets). *(Mid-fix snapshot, kept for history: 3 rows / 83 px at 360 px when the model chip read DISCONNECTED, otherwise 2 rows.)*
3. **Kill-switch option text runs together** on `#/agents`. Each radio card's title and description are adjacent inline spans with no separator. They therefore render, and are read by screen readers, as "Keep protective exitsStop all agents…" (see `real-agents-360x780.jpg`). The fix belongs in `web/styles.css`: `.radio-card .t, .radio-card .d { display: block; }`.
4. **Desktop lockup link** in the sidebar is 40 px tall. It is a pointer target, so this is reported only.

## What this pass did not cover

* Only Chromium was used. There was no WebKit/iOS Safari run and no physical phone, so Safari auto-zoom and real safe-area insets were not observed.
* `prefers-reduced-motion` and landscape orientation were not checked.
* These states were not exercised: an open agent strategy editor, the kill-switch confirmation dialog, the long-put ticket, and a playing replay left running for long periods.
* Full-page captures exist only at 390×844 (`*-390x844-full.jpg`). The other images capture the viewport.

## Re-running

Run from the repository root. Never use the orchestrator's port 8787 or the unrelated port 8790 for a mutating run.

```bash
# 1. Real data, on a disposable copy of the database (flows place sandbox orders and move the replay clock)
node --disable-warning=ExperimentalWarning -e "const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync('data/vector.db',{readOnly:true});d.exec(\"VACUUM INTO 'data/review-uicheck.db'\");d.close()"
VECTOR_PORT=8795 VECTOR_DB=data/review-uicheck.db npm start          # separate terminal
#    In the UI (or via POST /api/replay/reset then /api/replay/step {"minutes":60}), reset and step to 10:30 ET, then:
node docs/ui-checks/ui-check.mjs --base http://127.0.0.1:8795 --out docs/ui-checks/<date> --label real --flows 1 --sym BAC --lens-sym TOPP

# 2. Populated fixture layouts (every image stamped TEST FIXTURE — NOT MARKET DATA)
node test/web/check-server.mjs --port 5192 --mode fixture             # separate terminal
node docs/ui-checks/ui-check.mjs --base http://127.0.0.1:5192 --out docs/ui-checks/<date> --label fixture --sym ZVZZT --shots 390x844,1440x900 --full ""

# 3. Honest empty layouts with the API down
node test/web/check-server.mjs --port 5191 --mode unreachable         # separate terminal
node docs/ui-checks/ui-check.mjs --base http://127.0.0.1:5191 --out docs/ui-checks/<date> --label unreachable --shots 390x844,1440x900 --full ""

# Afterwards: stop the servers you started and delete data/review-uicheck.db*
```

Options:

* `--chrome <path>` selects the browser binary. The default is Chrome, then Edge, at their standard Windows paths.
* `--cdp-port` selects the DevTools port. The default is 9333.
* `--allow-mutation 1` is required before `--flows 1` will run against port 8787.
