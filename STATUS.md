# VECTOR: repo status and handoff (2026-10-09, about 20:00 EDT)

**This is a handoff document for the next Claude session.** It was verified the same evening by three independent read-only checks (repo/test/data state, a backlog compared against the code, and a claim audit). Start with §1 and §8. Treat everything in `docs/` as reference material, and note the errata in §7.

## 1. Snapshot

| Item | State |
|---|---|
| **Location** | **`C:\AI_Projects\Claude\vector-claude`** (moved 2026-10-09; copied, not moved, from the temporary session folder). `..\deliverables\` sits alongside it, and the clean shipped DB is at `data\vector.db`. Keep the repo at a short path: on Windows, every DB-backed test fails with `unable to open database file` at about 250 characters or more (MAX_PATH). |
| **Git** | `master` has the first commit **`3d749b2` "VECTOR MVP: initial import"** (438 files). `ui-polish-v1` (UI polish) was merged into `master` (`179eb4a`). Branch **`connections-v1`** adds read-only SnapTrade real accounts and free/local model presets (see `docs/HANDOFF-LOG.md`). There is no remote. `.gitignore` excludes `data/*.db*`, `*.log`, `node_modules/` and `.env`. |
| **Tests** | **436/436 pass.** That is 47 `*.test.js` files, about 20 s, `npm test`. The receipt is `receipts/npm-test-2026-10-09.txt`, re-verified on an identical copy. Running `npm test` **rewrites** `receipts/journal-samples/fixture-*.json`, changing only the timestamps and session ids. |
| **Packaged copies** | `..\deliverables\vector-claude-source-2026-10-09.zip` (26.4 MB) is byte-identical to the working tree, excluding `data/`, `node_modules` and `.git`. `vector-claude-data-2026-10-07.zip` (12.8 MB) holds the shipped `vector.db`. Both SHA-256s match `SHA256SUMS.txt`. That file carries size notes and CRLF line endings, so `sha256sum -c` cannot parse it, although the hashes are correct. |
| **Runtime** | Node ≥ 22.13 (built with v25.2.1). There are **no runtime dependencies**: only built-in `node:sqlite`, `node:test`, `fetch`, `WebSocket` and `zlib`. The one optional dependency is `@anthropic-ai/sdk` 0.132.1, which is installed in `node_modules`. There is no `.env` file. |
| **Size** | `server/`: 54 files, 15.1k lines. `web/`: 30 files, 6.6k lines (vanilla ES modules, no build step). `test/`: 58 files, 12.8k lines. `scripts/`: 7 files. `docs/`: 11 `.md` files. `receipts/`: 140 files. |
| **Data** | `data/vector.db` is 56 MB and contains real sourced rows only (§3). `data/vector-prelim.db` (417 MB) holds superseded pre-review sessions; it is gitignored and not shipped. It can be deleted once nobody needs it for audit. |
| **Servers** | Nothing of VECTOR's is running. **Port 8790 belongs to an unrelated project (`node src\server.js`). Never touch it.** Dev entry: `npm start` on `127.0.0.1:8787`. |

## 2. What VECTOR is (one paragraph)

VECTOR is a paper-only research and **agent-operated paper-trading lab** under the Recursive Chaos Labs brand. It was built to the frozen prompt v1.3 (`docs/SHARED_BUILD_PROMPT_v1.3_as_received.md`), whose core rule is that **only the seed money is fictional**. The data path runs like this:

1. Real IEX tick data is streamed once and reduced to per-minute bars that keep top-of-book, worst-in-minute quotes, halts and inferred aggressor volume.
2. Every read goes through `server/data/marketdata.js` *as of* the replay clock. A minute becomes knowable at its end.
3. Agents run user-editable rule strategies. In `model_confirm` or `model` mode those strategies need a real LLM.
4. Every proposal is a typed intent. It passes a **deny-by-default 22-rule policy gate** (`server/policy/`), then a bracket/OCO/stop/limit engine with a **conservative fill model** (`iex-conservative-minute-v1`; fills priced at the worst IEX quote in the minute). Every action is written to an **append-only, hash-chained journal**.
5. The Cowboy, Pragmatist and Tightwad lenses are three **independent** LLM calls on the same evidence packet. Each answer is validated strictly, with one bounded repair, and no lens votes or averages with another.
6. The UI is mobile-first, using RCL brand tokens.

Architecture and its rationale are in `docs/ARCHITECTURE.md`; the binding interfaces are in `docs/CONTRACTS.md`.

Module map:
- `server/data` (ingest, as-of reads, providers)
- `server/sim` (fills, orders, ledger, options)
- `server/policy` (gate, config)
- `server/agents` (strategies, runner, intents)
- `server/replay` (engine)
- `server/intel` (model providers, evidence, assessments, prompts)
- `server/research` (scanner, dossier, retrospective)
- `server/api` (HTTP)
- `web/` (single-page app)

## 3. Data that is in the shipped DB

| Source | Rows | Notes |
|---|---|---|
| IEX HIST TOPS 1.6, **2026-10-07** | 291,203 minute rows; 2,161 symbols; 4,839 status events | 9,985,168,752 bytes, matching IEX's index; SHA-256 `bb405b68…`; 0 sequence gaps. Covers IEX only (not the NBBO). It predates trade-break event rows and has `published_at` NULL (backlog E1). |
| FRED (10 series) | 74,190 observations | Latest vintage; a per-series release calendar decides when each value is knowable. Revisable values are withheld. |
| Nasdaq Trader symbol directory | 13,293 | Fetched 2026-10-09, after the replay date. It **never** reaches model evidence; the UI shows it labelled as post-dated. |
| FINRA Reg SHO, 2026-09-30 to 2026-10-07 | 74,193 | Off-exchange volume only. A day's file is knowable from 18:00 ET. |
| GDELT | 2 failed dataset rows | HTTP 429 every time (`PROVIDER_FAULT`). |
| SEC EDGAR | 0 | **BLOCKED**: `SEC_USER_AGENT` is not set. |

**Nothing is live.** Everything above is `HISTORICAL_REAL`. Live and delayed feeds show `NO_VERIFIED_DATA`, and options show `NO_VERIFIED_OPTIONS_DATA`.

## 4. Verified results on real data

Paper estimates from one day; nothing here is validated.

- **Agents (all agent-sourced).** On real data there was an autonomous buy, an attached stop, a *placement-triggered* stop with a worse-than-stop fill, 5 `SPREAD_TOO_WIDE` gate denials, and the kill switch stopping every agent. Source: `receipts/e2e-real-replay-2026-10-07.json` and `receipts/journal-samples/real-*.json`.
  - The **cancellation, budget rejection and stale-quote rejection on real data were human sandbox intents** placed by the end-to-end driver; their samples say so. Agent versions of these exist only on fixtures.
  - Take-profit and the long put are proven only on labelled TEST FIXTURE data.
- **Presets.** Five of the lens presets made **0 entries**. The micro presets cap the spread at 400–1,000 bps, while IEX-only spreads at sub-$1 had a median of about 2,660 bps (p25 1,460, p90 3,400). Only the handwritten-notes preset traded. The preset for `cowboy-micro` itself was never run on real data, because that agent was running the handwritten preset.
- **Real local model** (Ollama `qwen3:8b`, zero cost).
  - **Smoke run.** On TOPP at 10:30 ET the stances were Cowboy and Pragmatist `consider_entry`, Tightwad `avoid`. That took 5 calls, because two lenses were repaired once. Source: `receipts/model-smoke-ollama.json`.
  - **`model_confirm` run.** The real Cowboy lens confirmed all 6 rules entries. The gate still denied 5 for spread and accepted 1, which filled and was then stopped out. Source: `receipts/e2e-model-confirm-ollama-2026-10-07.json`.
  - **UI run.** A separate HTTP-API run, shown in `receipts/ui-model-connected/lens-panel-*.png`, left Pragmatist at `INVALID_OUTPUT`. **That run has no JSON receipt** (see §7).
  - Paid APIs were never called. The Anthropic request shape has never been sent to the real API.
- **Retrospective study** (hindsight, clearly labelled). There were 6 penny-tier +22 %/15-min signals: 1 continued and 4 reversed. The handwritten rule entered 4 and was stopped out on all 4 (−$61.39 on $198.96). The figures re-run identically on the current code. Source: `receipts/research-study-2026-10-07.json`, which was produced by a script that is not in the repo (§7).
- **UI checks.**
  - With the model disconnected: 320/320 assertions and 55 screenshots, including the phone buy/sell flow (`receipts/ui-check.json`).
  - With the model connected: 288/288 assertions (`receipts/ui-check-model-connected.json`).
  - Viewports: 360, 390, 430 and 1440 px, Chromium only.

## 5. How to run

```bash
npm start                 # 127.0.0.1:8787; boot pauses all agents (no implicit authority)
npm test
npm run ingest:iex -- --date YYYY-MM-DD      # ~10 GB streamed per day, ~10 min
npm run ui-check -- --base http://127.0.0.1:<port>   # refuses 8787 unless --allow-shared; always refuses 8790
```

**Shipped data.** Extract `..\deliverables\vector-claude-data-2026-10-07.zip` to `data/vector.db`. A git clone of this repo has **no data**: `data/*.db` is gitignored. Run experiments on a `VACUUM INTO` copy (`VECTOR_DB=data/<copy>.db`) so the shipped DB stays clean.

**Real model at zero cost:**

```bash
VECTOR_MODEL_PROVIDER=ollama VECTOR_OLLAMA_MODEL=qwen3:8b VECTOR_MODEL_TRAINING_CUTOFF=2025-04-29 npm start
```

The cutoff value is an upper bound taken from the Qwen3 release post date. The hindsight guard blocks any model whose cutoff is unknown.

All environment variables are listed in `docs/SETUP.md`.

## 6. Open items

### 6a. Owner decisions (need the human)

1. **Handwritten preset's stop at the entry ask** (`docs/OPEN_QUESTIONS.md` #4 / C). The stop sits above the IEX bid, so it triggers on its first minute every time. Options:
   - trigger at min(entry, bid − 1 tick);
   - arm the stop only once the bid reaches the entry;
   - trigger on the last trade;
   - remove the gate exemption.
2. **Preset spread caps versus IEX-only spreads.** Loosen them (risk: tuning to one day with hindsight), wait for a licensed NBBO feed, or accept zero trades.
3. **Price filter** (#10). The < $1 filter on the latest trade excludes the owner's own $1.22 example.
4. **Other handwritten-notes ambiguities** (#1–3, #5, #6):
   - take-profit at 2.5× or 3.5×;
   - whether the $50 cap is hard;
   - what the time exit is measured from;
   - what "intent" means.
5. **Policy questions:**
   - whether bracket children count toward `order_rate_per_min` (A);
   - a small-cap band (B);
   - whether time exits should be engine-owned;
   - per-portfolio policy overrides and grant revocation.
6. **Logo. Owner-approved 2026-10-09.** The copper-and-steel crops of the brand-board PNG stay. Since ui-polish-v1 they ship as small PNG rasters (`web/assets/RCL_Copper_Steel_Mark_{32,40,64,80,96,120}.png`, `RCL_Copper_Steel_Full_814x502.png`; E11 done). The supplied Convergence SVGs remain unmodified in `web/assets/`.
7. **Independence and visibility.** The public Netlify preview (https://rcl-vector-claude-preview.netlify.app) is **owner-approved 2026-10-09** for a demo. On 2026-10-10, at the owner's request, it was updated to the static `web/` of `3dc8e53`, labelled "Static preview · no live data". It has no API, so it shows no data. The owner-continuity vault and Notion closeout for this build were **deliberately not written**, to avoid sharing results while the two-builder comparison runs. Decide when to write them.
8. **Repo hygiene.** Approve a first commit, a branch and a remote.

### 6b. Blocked (needs a credential or data source)

| Item | Unblocker |
|---|---|
| SEC filings, financing/dilution, shares outstanding (market-cap segments), insider data | `SEC_USER_AGENT="<name> <email>"`, then `npm run ingest:sec -- --symbols …`. Sector also needs SIC parsing (E4). |
| Live/delayed quotes; a live paper mode | Alpaca or Polygon keys. Only a wall-clock verify route exists (`POST /api/feeds/verify`). A **live paper mode** (wall-clock bars, as-of = now) is large engineering after that. |
| Consolidated NBBO and volume | A licensed SIP feed. This is the main reason agents do not trade. |
| Options (operational long put) | An entitled as-of OPRA source. Two gaps remain after that: the engine passes no `optionsProvider`, and expiration settlement is never called automatically. |
| Media and analyst views | GDELT was rate-limited (429), and no licensed news or opinion feed exists. |
| Paid models | `ANTHROPIC_API_KEY` or `VECTOR_OPENAI_API_KEY`, plus spend authority **and `VECTOR_ALLOW_PAID=1`** (the $0 guard blocks every non-free preset and the legacy `anthropic` provider without it). Run `POST /api/model/test` first. |
| Real accounts (SnapTrade, read-only; connections-v1) | Owner enters SnapTrade Personal keys in `.env`: `VECTOR_SNAPTRADE_CLIENT_ID`, `VECTOR_SNAPTRADE_CONSUMER_KEY` (see `docs/SETUP.md` "Real accounts"). Until then every real screen is `BLOCKED: SNAPTRADE_NOT_CONFIGURED`. Code, signing, storage and the Real accounts view are built and tested against a mock only; never run against SnapTrade itself. |
| Free API model presets (connections-v1) | `ollama-local` / `lmstudio-local` need nothing (local, $0). `groq`, `openrouter-free`, `gemini-flash-free` need the owner's free keys (`VECTOR_GROQ_API_KEY`, `VECTOR_OPENROUTER_API_KEY`, `VECTOR_GEMINI_API_KEY`); tested against a mock only. `gemini-3.8-flash` has no published cutoff, so its assessments stay `BLOCKED: MODEL_TRAINING_CUTOFF_UNKNOWN` until one is documented. Limits in `config/model-presets.json` are upper bounds; set them to your account's values. |
| Point-in-time macro (ALFRED); corporate actions and splits | Not built; no source exists. |

### 6c. Engineering backlog (buildable now, in priority order)

| # | Item | Where |
|---|---|---|
| E1 | **Ingest more real IEX days, and re-ingest 2026-10-07** to get trade-break rows and `published_at`. With one day, take-profit and a price-move stop are never seen and the study covers a single day. Run on a DB copy, then promote it. | `npm run ingest:iex` |
| E9 | A failed feed check leaves a stale `LIVE_VERIFIED`. Clear `verified.live` on the no-provider and `!r.ok` paths. | `server/data/providers/index.js:92,95`; test in `test/api/feeds-verify.test.js` |
| E5 | GDELT media fetch has **no caller**, although the docs say "on demand from the dossier". Add `scripts/ingest-gdelt.js` and/or `POST /api/media/fetch` with a dossier button, or fix the docs. | `server/data/ingest/gdelt.js:147` |
| E4 | Evidence packets ignore stored filings, share counts and media. Add them as v4 items, each knowable at SEC acceptance or GDELT first-seen time; add SIC parsing. | `server/intel/assessments.js:367-396`, `server/data/ingest/sec-edgar.js` |
| E3 | Flag re-replays of a day whose outcome was already seen: `datasetPreviouslyReplayed` on reset, a status chip, `hindsight_exposed` meta. | `server/replay/engine.js`, `api/status.js`, `web/js/status-strip.js`, `lab.js` |
| E2 | Cross-day context (needs E1): a `priorSessionsAsOf` helper; days/weeks horizons in the scanner and packets, labelled unadjusted. | `server/data/marketdata.js`, `research/scanner.js`, `api/market.js:20` |
| E6 | A `bracket_coherent` gate rule: take-profit above entry and ask, stop below entry. Bump `POLICY_VERSION` to 3. | `server/policy/{config,gate}.js`; reuse `checkBracketCoherence` from `intel/prompts.js` |
| E7 | Engine-owned time exit, or a management-only pass for BLOCKED/FAULTED agents (needs owner decision 5). | `server/sim/orders.js` or `server/agents/runner.js` |
| E8 | Abort in-flight model calls on kill or pause (`AbortSignal.any`). | `server/controls.js`, then runner, then assessments, then providers |
| E10 | Extend the UI check: kill dialog, strategy editor, limit/stop orders, modify, long-put ticket, landscape, reduced motion, contrast. Safari or a real phone needs the owner. | `scripts/ui-check.mjs` |
| E11 | **DONE (ui-polish-v1).** 5.26 MB of SVG became 506 KB of PNG (1x/2x/3x marks, native-size lockup). PSNR is ∞ dB for the lockup at 1x and 30–38 dB for the marks (Chrome resampling). WebP is not shipped, because `server/api/static.js` does not serve `.webp`; that one line needs separate approval. | `web/assets/`, `docs/RCL-Logo-Source.md`, `receipts/ui-polish-v1/logo/` |
| E12 | Agents should skip warrants, rights and units before the gate (`ISSUE_TYPE_DENIED`), so the gate does not keep denying them. | `server/agents/strategies.js:791` |
| E13 | Fill records should carry `tradesWithheld` / `tradeBreaks` (relevant after E1). | `server/sim/fills.js:124` |
| E14 | Sources view: verify buttons; show each dataset's `published_at`. | `web/js/views/sources.js` |
| E15 | Per-portfolio policy overrides and grant revocation (after owner decision 5). | `server/db.js`, `controls.js`, `policy/*`, `PUT /api/agents/:id/grants` |

**Polish:**
- The dossier's no-session response omits `sector` and `analystViews` (`api/market.js:147`).
- The scanner still ranks rows flagged `QUOTE_STALE`.
- `runner.js:648` should re-probe the provider with `{fresh:true}`.
- Model agents should be blocked once `CALL_CAP_REACHED`, not log every step.
- The strategy editor offers the at-entry stop to every strategy, but only the handwritten preset can use it (`web/js/strategy-schema.js:40`).
- The `REPLACE_INCREASES_BUY_EXPOSURE` pre-check in `api/trading.js:300-316` is redundant.
- `symbol()` in `api/http.js:7` rejects IEX-suffixed symbols. This is intentional; decide whether to keep it.
- The pause and kill dialogs should say that time exits are suspended.

**Already fixed; do not redo:** everything in the two review rounds' "fixed" lists. This covers 22-rule gate hardening, kill/reset state, partial-dataset truncation, the evidence and feed routes, the native Ollama adapter, bounded repair, the hindsight guard, journal scoping, and the web features (repair UI, lens badges, PARTIAL chip, session selector).

## 7. Errata: docs and receipts known to be wrong or stale (fix early)

1. `docs/INVENTORY.md`:
   - **line 22** (row 8) still says "PARTIAL until the README exists", 433/433 and "README not written". It should say COMPLETE, 436/436, README exists.
   - **line 3**: the timestamp should read about 19:35 UTC.
   - **lines 15 and 28**: the "re-check web" notes are stale.
   - **line 30**: the logo is "pending", which contradicts `docs/RCL-Logo-Source.md`, README and ARCHITECTURE.
   - **line 29**: cites the round-1 captures. The current flow evidence is `receipts/ui/flow-390x844-*` and `narrow-360x780-*`.
2. `docs/SETUP.md:132` says 433 tests; the correct figure is **436**.
3. "Six lens presets made 0 entries" in `docs/INVENTORY.md:17` and `docs/LIMITATIONS_FROM_REVIEW.md:27` should read **five**. README line 73 is correct.
4. README ("agent lifecycle on real data") and `INVENTORY.md:40-42` present the real cancellation, budget and stale-quote samples as agentic. They were **human sandbox intents** (see §4).
5. `docs/ARCHITECTURE.md`:
   - §9 (lines 105–127) describes the superseded `docs/ui-checks/ui-check.mjs`. Point it at `scripts/ui-check.mjs`, `receipts/ui-check.json` and `docs/MOBILE_QA.md`.
   - Line 23 says penny spreads were "1,500–6,000 bps". Measured on the shipped DB: median 2,660, p90 3,400.
6. ~~`docs/UI_CHECKS.md:64,96` strip rows~~ **Fixed in ui-polish-v1.** Both QA docs now give the current measurements: 3 rows / 102 px at 360–390 px with 16 px chips, 2 rows at 430 px and on tablets, 1 row on desktop.
7. `docs/LIMITATIONS_FROM_REVIEW.md:3` gives the wrong check time. `:67` says "three lens calls"; it was 5 calls including the 2 repairs.
8. Receipts:
   - `receipts/ui-check.json`, `ui-check-model-connected.json` and the `real-*` samples were run on **deleted** DB copies, and only some of them say so. Add `database` notes.
   - `receipts/ui-model-connected/lens-panel-*.png` has no JSON receipt for the API assessment run it shows.
   - `receipts/research-study-2026-10-07.json` was produced by a script that is not in the repo. Add `scripts/research-study.js` and regenerate.
   - `receipts/ingest-iex-tops-2026-10-07.json` lacks `generated_at`, `command` and `node` fields.
   - The GDELT probe receipt does not include its 429 attempt log. That log exists only in the DB's dataset quality JSON.
9. These claims cannot be verified from the repo: the review statistics (140 findings / 83 medium+), Codex's "owner request", and the 2026-08-20 pull date of the qwen3 weights.

## 8. Ground rules for whoever continues

- **Data truth is the product.**
  - Never put a literal market observation in `server/`, `web/` or `scripts/`.
  - Fixtures live only in `test/` and are labelled `TEST FIXTURE — NOT MARKET DATA`.
  - When data is missing, show an explicit status (`NO_VERIFIED_DATA`, `BLOCKED`, `PROVIDER_FAULT`, `MODEL DISCONNECTED / ASSESSMENT NOT RUN`).
- **As-of discipline.** All agent, assessment and as-of view reads go through `server/data/marketdata.js` with the replay clock. Hindsight belongs only in `server/research/retrospective.js`, labelled RETROSPECTIVE.
- **Paper only.** There is no live-broker path; do not add one without separate owner authorization. The gate is deny-by-default, and the model never bypasses it.
- **Keep `docs/CONTRACTS.md` the binding spec.** Update it in the same change as any interface change. `docs/OPEN_QUESTIONS.md` and `HANDWRITTEN_AMBIGUITIES` in `strategies.js` are kept in sync by a test.
- **Protect the shipped DB.**
  - Experiment on `VACUUM INTO` copies.
  - `data/vector.db` and `evidence` / `journal` are append-only (DB triggers).
  - Never call paid APIs without owner credentials and an explicit go-ahead.
- **Two-builder experiment.** Do not read or copy the Codex build. Do not write results into the shared vault until the owner says the comparison is complete.

## 9. Suggested first moves for the next session

1. ~~Move the repo to a short permanent path and make the first commit.~~ Done 2026-10-09 (`C:\AI_Projects\Claude\vector-claude`, `3d749b2`). Put later `npm test` receipt rewrites in separate commits.
2. Fix the §7 errata (docs only, about 30 minutes), then E9 (a small bug fix with a test).
3. Get owner decisions 1, 2 and 6, and `SEC_USER_AGENT`.
4. E1: ingest 3–5 more IEX days on a DB copy, re-ingest 2026-10-07, re-run the e2e and study receipts, and promote the copy.
5. Then E5 → E4 (richer lens evidence), E3 → E2 (cross-day context), E6, E10 and E11.
