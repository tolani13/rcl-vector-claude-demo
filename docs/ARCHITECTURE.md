# VECTOR: architecture and the reasoning behind it

*Claude builder, independent build, 2026-10-08/09. These are design choices with their trade-offs. They are not claims about markets.*

## 1. The constraint that shaped everything

Frozen prompt v1.3 allows only one fictional input, the seed money. Every price, quote, symbol, filing and article has to be real and traceable. Under that rule the hard problem is not the UI. It is getting authentic quotes, meaning bid and ask, not just trades, with exchange timestamps, with no paid keys, no account creation, and no bypassed restrictions. Honest paper fills need quotes. A fill estimated from trade prices alone cannot model the spread.

Free sources I probed on 2026-10-08:

| Source | Result | Decision |
|---|---|---|
| Stooq CSV | JavaScript proof-of-work bot wall | **Not used.** Getting past it would mean circumventing the provider. |
| Yahoo / Cboe / Nasdaq website JSON | Unofficial website endpoints whose terms restrict automated use | **Not used.** |
| **IEX Exchange HIST (TOPS 1.6)** | Official free historical files. Terms allow use with attribution. Each file holds a full trading day of IEX top-of-book quotes and trades with nanosecond exchange timestamps. | **Primary market source.** |
| FRED `fredgraph.csv` | Official public download, no key needed | Macro context |
| Nasdaq Trader SymbolDirectory | Official public files | Issuer identity |
| FINRA Reg SHO daily files | Official public files | Off-exchange volume and short-volume context |
| SEC EDGAR | Fair-access policy requires a User-Agent with a contact e-mail | Built, **BLOCKED** until the owner sets `SEC_USER_AGENT`. I would not invent a contact. |
| GDELT DOC API | Returned HTTP 429 from this network every time | Built, reports **PROVIDER_FAULT** |
| Local Ollama (qwen3:8b) | Running on the owner's machine, no cost | Used for the **real** three-lens model run |

IEX's own caveat applies and is shown in the UI. The data covers IEX only. The IEX BBO is not the NBBO, IEX carries a small share of U.S. volume, and the data is "a reference point only". VECTOR treats that as a limitation to state, not hide. One consequence is the lab's most important finding on the replay day: IEX-only spreads on sub-$1 names were usually 1,500 to 6,000 bps, so conservative policy gates blocked most penny-stock entries. Getting more realistic microcap fills would take a licensed NBBO feed. The adapter path for one already exists (`server/data/providers/`).

## 2. Data pipeline: stream, verify, aggregate, never store the firehose

One IEX day (2026-10-07) arrives as a 9.99 GB `pcapng.gz` file: 282 M quote updates and 6.8 M trades. `server/data/ingest/iex-tops.js` streams it once and never writes it to disk.

* **Integrity first.** The pipeline computes a SHA-256 of the received bytes and checks the byte count against IEX's index (it matched exactly). It also checks IEX-TP sequence continuity (0 gaps), confirms the system events from start to end of messages are present, and resumes on network drops with HTTP Range requests that keep feeding the same decompressor.
* **Minute aggregation that keeps what fills need.** For each symbol and each minute it keeps trade OHLCV, a VWAP numerator, the prevailing quote at minute end with its timestamp, the *min/max bid and ask over the minute* (including the carried-in state), halt/availability flags, and inferred aggressor volume. The aggressor rule compares each trade to the IEX BBO prevailing at that trade: at or above the ask counts as buyer-initiated, at or below the bid as seller-initiated, and anything inside the spread stays unclassified. That is about 291 k rows instead of 289 M messages, with enough detail to price a fill at the *worst* quote seen in the minute.
* **No look-ahead in storage selection.** TOPS has no prior close for non-IEX-listed names, so price tiers are computed *as of* the replay clock. The stored set is every symbol whose observed price was *ever* below $5 that day, plus a configured large-cap list and benchmark ETFs. That set is a superset of every as-of tier with a threshold at or below $5, so the storage filter cannot leak future information into an agent's universe. The full-day statistics behind it sit in `ingest_symbol_stats`, which is labelled retrospective-only and never read by as-of code.

## 3. Time: one read path with an explicit knowability rule

`server/data/marketdata.js` is the only path through which agents, assessments and as-of views read market data. A minute row `[t, t+60 s)` becomes knowable at `t + 60 s`, every function takes `asOf` explicitly, and `fillMinute()` throws if asked about a minute that has not completed. Evidence rows carry `event_ts`, `knowable_ts` and `ingested_ts`, and lookups filter on `knowable_ts <= asOf`. Other sources get conservative publication-lag rules:

* FRED: a per-series release calendar (`server/data/macroCalendar.js`). Revisable series whose stored latest vintage may postdate the clock are withheld.
* FINRA: a day's file is knowable from 18:00 ET.
* The symbol directory: a snapshot is used as evidence only if its File Creation Time is at or before the replay clock. The one ingested here was created after the replay date, so it **never reaches model evidence**. The dossier shows it labelled as post-dated, and scanner names from it carry `namePostDated`.
* Stored-symbol visibility: a stored symbol appears in as-of views only after its first sub-$5 minute becomes knowable. Whole-day storage therefore never turns "has data" into a hindsight signal.

The retrospective research study is the one place hindsight is allowed. It answers whether the +22 %/15-minute idea from the handwritten notes "worked" that day. It lives apart in `server/research/retrospective.js` and is labelled *RETROSPECTIVE — never visible to agents*.

## 4. Authority: proposal, deterministic gate, simulated execution

The prompt separates *LLM assessment*, *strategy decision* and *deterministic execution authority*. VECTOR makes each of them a different module with a typed boundary between it and the next:

```
strategy (user rules)  ─┐
LLM lens (optional)  ───┼─► TradeIntent (typed, validated, expiring) ─► policy gate (deny-by-default, 22 rules)
human sandbox ticket ───┘                                                   │ ACCEPTED
                                                                            ▼
                         ledger ◄── fill model (iex-conservative-minute-v1) ◄── orders engine (bracket/OCO/stop/limit)
                            │
                            └──► append-only, hash-chained journal (every attempt, denial, fill, withheld fill, control change)
```

* **Intents, not instructions.** Model output is parsed into a `TradeIntent` schema that rejects unknown fields and requires integer fixed-point prices, an expiry and evidence references. Free text is never executed.
* **Deny by default.** The policy config must contain each of the 22 rules (`REQUIRED_RULES`, incl. `target_order_matches` and `protective_exit_required`). A missing rule produces `RULE_MISSING:<name>` and a thrown error produces `GATE_ERROR`. No authority comes from a restart: on boot every RUNNING agent is set to PAUSED. Retries and agreement between lenses grant nothing either.
* **Human control.** The kill switch cancels every open non-protective order of the session and stops every agent. Protective exits follow an explicit policy: `KEEP_PROTECTIVE` by default, or `CANCEL_ALL`. Agents stay stopped after release until a human resumes them one by one.
* **Conservative fills, or none.** A market buy fills at the worst two-sided IEX ask in the evaluation minute plus slippage, capped at the displayed size and reduced to what the account can afford. A stop that gaps fills worse than its stop price. When a minute is halted, has no two-sided quote or shows zero size, the engine records `FILL_WITHHELD` and fabricates no execution. Every fill row stores its model id, its assumptions, the observed quote/trade data it used, and `estimated = 1`.
* **Money is integer fixed-point** at 1 u = $0.0001, which is IEX's native precision. Tick validity follows Reg NMS Rule 612.

Agents run **user-configurable rule strategies**: velocity + intent presets for each lens and segment, plus the handwritten-notes example. These are deterministic and labelled *EXPLORATORY DEFAULTS — NOT VALIDATED*, and they are never presented as AI. Two modes put a real model in the loop. `model_confirm` requires the lens to concur before a rules entry goes ahead. `model` lets the lens propose the intent. In both, a missing model sets the agent to `BLOCKED: MODEL_DISCONNECTED`; neither falls back silently to rules.

## 5. Intelligence: a real adapter, independent lenses, nothing fake in operation

`ModelProvider` has three real adapters:

* Anthropic, through the official `@anthropic-ai/sdk`. It defaults to `claude-opus-5-5` with adaptive thinking, a JSON-schema output format, server-side refusal fallback, and refusal handling before any content is read.
* OpenAI-compatible, covering OpenAI, LM Studio and Ollama's `/v1` route (which uses the Ollama server's own context setting).
* Native Ollama (`/api/chat`), which sends `num_ctx` (`VECTOR_OLLAMA_NUM_CTX`, default 16384) with every request.

Cowboy, Pragmatist and Tightwad receive the *identical* evidence packet; its SHA-256 is stored on every assessment. Each lens is a separate call and never sees another lens's output. Outputs are validated and stored separately, with no averaging and no voting. The mock provider exists only inside `test/`. With no provider configured the UI shows **MODEL DISCONNECTED / ASSESSMENT NOT RUN**, and no rule logic stands in for it.

A model's memory is a look-ahead channel too. A model trained after the replay date may simply remember what happened next. Assessments are therefore `BLOCKED` unless the model's documented training cutoff (`VECTOR_MODEL_TRAINING_CUTOFF`, or a built-in value) falls safely before the replay date. Local servers silently truncate prompts that exceed their context window, so a packet that does not fit is refused rather than sent. `docs/SETUP.md` gives the settings.

## 6. Runtime and stack

* **Node ≥ 22.13 with no runtime dependencies.** It uses built-in `node:sqlite`, `node:test`, global `fetch`/`WebSocket` and `zlib`. The Anthropic SDK is optional and dynamically imported. The reasons are reproducibility, a small supply-chain surface, and an offline UI.
* **The replay engine runs server-side.** It keeps a persistent clock, allows one step at a time, and plays from a server timer, so agents and protective orders keep advancing with no browser tab open.
* **The front end is vanilla ES modules with no build step.** It loads no external network resources and runs under a same-origin CSP. It is mobile-first: phones get a bottom tab bar with ≥ 44 px targets, 16 px body and form text, and safe-area insets; desktops get a sidebar. Section 9 has the measured results.
* **Branding.** RCL brand tokens (obsidian, copper, steel, bone, graphite) are defined on `:root`, taken from the supplied brand board. At the owner's request, the header, favicon and About page show the original copper-and-steel artwork. `web/assets/RCL_Copper_Steel_{Mark,Full}.svg` are viewports onto the unmodified `RCL_Brand_Identity_Board.png` (see `docs/RCL-Logo-Source.md`). The supplied Convergence SVGs ship unchanged in `web/assets/`.
* **Security.** The server binds to loopback only unless explicitly overridden. `VECTOR_ALLOW_REMOTE=1` permits LAN use behind a per-launch `?k=<token>` URL. It has a host allow-list, a custom-header CSRF guard on mutations, 64 KB body limits, strict validation, and an error envelope that never contains stacks or secrets. Secrets come only from server-side environment variables.

## 7. Extensibility (what plugs in where)

| Future capability | Seam |
|---|---|
| Licensed live/delayed quotes (NBBO), entitlement and latency display | `server/data/providers/{alpaca,polygon}.js` (request-capable, **unverified**: never run against real data here) feeding `providers/index.js` status |
| Real options chains → long-put trading | `server/sim/options.js` contract validation and payoff; gate rule `instrument_allowed` opens only with a verified provider quote |
| SEC filings, dilution and insider activity | `server/data/ingest/sec-edgar.js` (acceptance timestamps = knowability) |
| Media velocity | `gdelt.js` metadata-only adapter; licensed news APIs would slot in as further evidence kinds |
| Global event → exposure → company graph | `evidence` store (append-only, knowable_ts) as the node and provenance layer; a graph table keyed on evidence ids is the next step |
| More replay days | `npm run ingest:iex -- --date YYYY-MM-DD` (~10 GB streamed per day) |
| Future live broker | Not implemented by design. It would need separate owner authorization, a dry-run gate, idempotency, a hard kill switch and monitoring. |

## 8. What I would do next

1. Ingest several more IEX days so the signal study has cross-day, out-of-sample evidence.
2. Connect a licensed NBBO and options feed, then re-run the lab with honest NBBO spreads.
3. Configure SEC EDGAR for the filings and dilution layer.
4. Add a calibration harness that compares model-lens stances with later outcomes, on days *after* the prompts were frozen.

## 9. Responsive verification

A beautiful desktop-only demo fails acceptance, so the layouts are measured rather than eyeballed.

`docs/ui-checks/ui-check.mjs` drives headless Chrome or Edge over the DevTools protocol, using Node's built-in `WebSocket` with no new dependency. It covers every route at 360×780, 390×844, 430×932 and 1440×900, and records:

* horizontal overflow
* navigation pattern
* status-strip rows
* the smallest control
* font sizes
* label visibility
* a screenshot

It then runs the phone sandbox BUY → confirm → step → fill → SELL → fill → journal flow, a policy rejection, and a narrow replay/three-lens view, all with real taps.

There are three runs:

* real data, on a disposable copy of the database
* `test/web/check-server.mjs --mode fixture`, with every image stamped "TEST FIXTURE — NOT MARKET DATA"
* `--mode unreachable`, which shows the honest empty states

The 2026-10-09 results, re-run commands and observations are in `docs/UI_CHECKS.md`.

Related documents:

* `docs/SETUP.md`: setup, ingestion and models
* `docs/INVENTORY.md`: what works, what is partial, what is blocked
* `docs/LIMITATIONS_FROM_REVIEW.md`: blocked items and known limitations
* `docs/OPEN_QUESTIONS.md`: the owner's open questions
* `docs/CONTRACTS.md`: interfaces
