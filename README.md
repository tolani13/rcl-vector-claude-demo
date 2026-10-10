# VECTOR: a research and paper-trading lab from Recursive Chaos Labs

*Refining Chaos Into Clarity.*

VECTOR is a research tool and an **agent-operated paper-trading lab** for U.S. penny/microcap stocks compared with
large caps. **Only the seed money is fictional.** Every symbol, quote, trade, halt, macro value and reference record in
the product comes from a real, cited source, and each one carries a timestamp and a SHA-256 receipt. Fills are
**estimates** based on observed quotes. There is **no live-broker code path**. Built independently by Claude
(Anthropic) from the frozen prompt v1.3, 2026-10-08/09.

> **Is any data live?** No. Everything in the shipped database is **HISTORICAL_REAL**: the IEX Exchange session for
> 2026-10-07, replayed as of each moment, plus FRED, the Nasdaq Trader symbol directory and FINRA Reg SHO files.
> Live/delayed feeds and options data are **NO_VERIFIED_DATA** until you add credentials. Any "LIVE" label requires a
> verified provider; the code never applies it without one.

## Quick start

```bash
npm start
```

Then open http://127.0.0.1:8787. The server listens on loopback only. You need Node ≥ 22.13; the build was tested with Node 25.2. There are no runtime dependencies.

* **With the shipped `data/vector.db`** (in the data archive), the app opens on the real 2026-10-07 replay. Start an agent under **Agents**, then press **Play** or **+15m** under **Replay**.
* **Starting from an empty database**, the UI shows honest `NO_VERIFIED_DATA` states. To rebuild the data from the real sources (no keys needed):

```bash
npm run ingest:iex -- --date 2026-10-07
```

```bash
npm run ingest:fred
```

```bash
npm run ingest:symdir
```

```bash
npm run ingest:finra
```

* **To run the tests:**

```bash
npm test
```

* **For real model assessments at zero cost** with a local Ollama (PowerShell shown; see `docs/SETUP.md` for bash, Anthropic, LM Studio and OpenAI):

```powershell
$env:VECTOR_MODEL_PROVIDER="ollama"; $env:VECTOR_OLLAMA_MODEL="qwen3:8b"; $env:VECTOR_MODEL_TRAINING_CUTOFF="2025-04-29"; npm start
```

The training cutoff feeds the hindsight guard. The guard refuses to let a model judge a replay day it might remember. For qwen3:8b the value 2025-04-29 is a documented *upper bound*: it is the date of the Qwen3 release post, which states no cutoff.

## What's in the box

| Area | What it does | Where |
|---|---|---|
| Real market replay | Streams IEX HIST TOPS 1.6 for one day: 9.99 GB, byte count matched to IEX's index, SHA-256 recorded, 0 sequence gaps. That is 282 M quotes and 6.8 M trades, reduced to per-minute bars that keep top-of-book, worst-in-minute quotes, halts and inferred aggressor volume. Every read is **as of** the replay clock: a minute becomes knowable at its end. | `server/data/ingest/iex-tops.js`, `server/data/marketdata.js` |
| Dashboard | Penny/microcap, under-$5 and large-cap views; opportunity rows labelled *SIGNAL METRICS — NOT RECOMMENDATIONS*; benchmark returns; macro panel; data timestamps and source status on every screen | `#/overview` |
| Research dossier | As-of price/volume chart with inferred buyer/seller volume, halts, FINRA short volume, and honest `BLOCKED` / `UNAVAILABLE_NOT_VERIFIED` sections (filings, leadership, sector, analyst views) | `#/research/SYM` |
| Three risk lenses | Cowboy, Pragmatist and Tightwad each get the **identical** time-bounded evidence packet in **separate** real model calls. The outputs are validated and stored apart; there is no voting or averaging. With no model configured the UI says *MODEL DISCONNECTED / ASSESSMENT NOT RUN*. | `server/intel/*` |
| Agentic paper lab | Six lens × segment agents plus a human sandbox. Agents run user-editable rule strategies, either plain `rules` or `model_confirm` / `model` (which need a real model). Every proposal is a typed intent, checked by a **deny-by-default 22-rule policy gate**, then simulated by a bracket/OCO/stop/limit engine with a **conservative fill model**. Agents scan, enter, attach stops and take-profits, trail, cancel and time-exit. | `server/agents/*`, `server/policy/*`, `server/sim/*` |
| Human control | Pause/resume each agent; strategy editor; **global kill switch** (cancels pending entries, stops all agents, explicit protective-exit policy); a restart never re-grants authority | `#/agents` |
| Audit | Append-only, hash-chained journal of every attempt, denial, estimated fill, withheld fill and control change, enforced by DB triggers | `#/journal`, `server/journal.js` |
| Replay | Server-side clock (works with no browser open), play/step/reset, deterministic resets, and a *RETROSPECTIVE* signal/failure study that unlocks only at the close | `#/replay` |
| Mobile | Dedicated phone layouts at 360/390/430 px: bottom tabs, 44 px targets, 16 px text, no horizontal overflow, explicit buy/sell confirmation | `docs/MOBILE_QA.md` |

## What the real day showed (paper estimates; one day; not validated)

* **IEX-only penny spreads are the binding constraint.** The median spread at the moment of a +22 %/15-min signal was about 2,600 bps. Five of the six presets made no entries, because their spread, return and volume rules never passed together. The UI shows the per-reason counts behind each "why no trades".
* **The handwritten-notes example**, kept as an exploratory preset with every ambiguity documented in `docs/OPEN_QUESTIONS.md`, was run in the retrospective study with hindsight clearly labelled. There were 6 penny-tier signals, of which 1 continued and 4 reversed. The rule entered 4 and **stopped out all 4 on the first minute with worse-than-stop fills**, for −$61.39 of paper money on $198.96 deployed. The reason: the at-entry stop sits above the IEX bid. That is owner question #4.
* **Agent lifecycle on real data** (`receipts/e2e-real-replay-2026-10-07.json`): an autonomous buy, attached stop, stop modification, cancellation, budget and stale-quote rejections, kill switch and a sandbox buy/sell all happened on real quotes. The real-data stop was *placement-triggered*. Take-profit and the long put are proven only with labelled test fixtures.
* **Real model (local qwen3:8b, zero cost).**
  * On TOPP's real 10:30 ET evidence packet the three independent lenses answered Cowboy *consider_entry*, Pragmatist *consider_entry* and Tightwad *avoid*. Two of them needed one bounded repair after the validator rejected their first JSON. See `receipts/model-smoke-ollama.json`.
  * In `model_confirm` mode an agent's six rules entries were all confirmed by the real Cowboy lens. The deterministic gate still **denied five** (`SPREAD_TOO_WIDE`, IEX spreads of 2,167–2,981 bps) and accepted one, which filled and then stopped out. A model's agreement grants no authority. See `receipts/e2e-model-confirm-ollama-2026-10-07.json`.
  * Model output is validated but **not** fact-checked. Misquoted numbers are flagged as NUMBERS UNVERIFIED, and invalid answers stay `INVALID_OUTPUT` (`receipts/ui-model-connected/lens-panel-*.png`).
  * Paid APIs (Anthropic, OpenAI) were never called.

## Proof ("no proof, no run")

| Receipt | What it proves |
|---|---|
| `receipts/npm-test-2026-10-09.txt` | Full test suite: **436/436 pass** (final code) |
| `receipts/ingest-*.json` | Every real ingestion: source URL, bytes, SHA-256, quality checks; BLOCKED and PROVIDER_FAULT recorded honestly |
| `receipts/e2e-real-replay-2026-10-07.json` + `receipts/journal-samples/real-*.json` | Full-session agent replay on real data, with journal samples for each acceptance item |
| `receipts/journal-samples/fixture-*.json` | The same items on labelled TEST FIXTURE data, including take-profit, the long-put example and kill-switch cancellation of pending entries |
| `receipts/model-smoke-ollama.json`, `receipts/e2e-model-confirm-ollama-2026-10-07.json` | Real model calls on real evidence, with packet hash, evidence ids, validation results and reviewer notes |
| `receipts/research-study-2026-10-07.json` | Retrospective +22 %/15-min signal/failure study with matched comparisons |
| `receipts/ui-check.json` + `receipts/ui/*.png` | Scripted checks at 360/390/430/1440 px across 10 routes, plus the phone buy/sell flow and the narrow replay/assessment flow (`npm run ui-check -- --base …`) |

## Documentation

* `docs/ARCHITECTURE.md`: the independent architectural reasoning, meaning why IEX, how as-of works, and the authority chain
* `docs/INVENTORY.md`: working / partial / missing / blocked, item by item against the prompt
* `docs/LIMITATIONS_FROM_REVIEW.md`: known limitations and blocked items
* `docs/SETUP.md`: every environment variable, ingestion command and model option
* `docs/CONTRACTS.md`: the binding interface spec of the current code
* `docs/OPEN_QUESTIONS.md`: the handwritten notes' ambiguities, preserved rather than decided
* `docs/MOBILE_QA.md`: the phone and desktop verification

## Integrity notes

* **Data attribution.** "Data provided for free by IEX. By accessing or using IEX Historical Data, you agree to the IEX Historical Data Terms of Use." IEX data covers IEX only and is "a reference point only". FRED, Nasdaq Trader and FINRA data are used as published. Check each provider's terms before redistributing the database.
* **Build process.** The code was built and adversarially reviewed by Claude subagents in two review rounds. Seven reviewers produced 140 findings, and skeptics verified the 83 rated medium or higher before they were fixed. A third‑party agent, the competing builder Codex, according to its shared-vault note, edited this workspace on 2026-10-09 at the owner's stated request. It replaced the header/About logo with crops of the supplied brand-board PNG; see `docs/RCL-Logo-Source.md`. The four supplied Convergence SVGs are untouched.
* This MVP is a local build. Nothing here modifies the public RCL website.
