# Setup, ingestion and model configuration

*This is the detailed reference behind the README's quick start. The canonical variable lists live in the header comments of `server/config.js` and `server/intel/model-provider.js`. If this page and the code disagree, the code wins. Last checked against the code on 2026-10-09.*

## Prerequisites

* Node.js 22.13 or later, as set by `engines` in `package.json`. The build and receipts used Node v25.2.1.
* There are no runtime dependencies. The app uses the built-in `node:sqlite`, `node:test`, `fetch`, `WebSocket` and `zlib`.
* `npm install` is needed only for the optional `@anthropic-ai/sdk`, which is used when `VECTOR_MODEL_PROVIDER=anthropic`.

## Start

```bash
npm start                      # http://127.0.0.1:8787  (loopback only)
```

With no data ingested, the UI starts in honest empty states:

* `NO_VERIFIED_DATA` for the data mode and the replay
* `MODEL DISCONNECTED / ASSESSMENT NOT RUN` for assessments
* `NO_VERIFIED_OPTIONS_DATA` for options

The strip always shows `PAPER ONLY — NO LIVE TRADING`. On boot every RUNNING agent is set to PAUSED, and a human must start each one again.

## Environment variables

All variables are optional. Secret values are read only from the server environment. They are reported as presence flags and are never logged or returned.

| Variable | Purpose |
|---|---|
| `VECTOR_HOST` | Bind address. Default `127.0.0.1`. Non-loopback addresses are refused unless `VECTOR_ALLOW_REMOTE=1` is set. |
| `VECTOR_ALLOW_REMOTE=1` | Allows a LAN bind, for phone testing. The Host allow-list stays on. Non-loopback clients must first open the per-launch `?k=<token>` URL that is printed at startup. Anyone with that URL controls this paper lab. |
| `VECTOR_ALLOWED_HOSTS`, `VECTOR_ALLOWED_ORIGINS` | Extra Host names, or browser origins for mutations (for example a tailnet name or an HTTPS reverse proxy). |
| `VECTOR_PORT` | Default `8787`. |
| `VECTOR_DB` | SQLite path. Default `data/vector.db`. |
| `VECTOR_STARTING_CASH_USD` | Simulated seed money per portfolio for boot-time resets. Default `10000`. A reset from the UI can set it per session. |
| `VECTOR_TICK_WALL_MS` | Wall-clock milliseconds per replay minute while playing. Engine default 1500. |
| `VECTOR_LARGECAP_LIST` | Comma-separated replacement for the configured 20-name large-cap reference list (also decides the sandbox cost model per symbol). |
| `VECTOR_MODEL_PROVIDER` | `anthropic`, `openai-compatible`, `ollama` or `none` (default `none`). |
| `VECTOR_ANTHROPIC_MODEL` | Default `claude-opus-5-5`. |
| `VECTOR_OLLAMA_BASE_URL`, `VECTOR_OLLAMA_MODEL` | Native Ollama adapter (`VECTOR_MODEL_PROVIDER=ollama`). Base default `http://127.0.0.1:11434`; the model is required. |
| `VECTOR_OLLAMA_NUM_CTX` | Context window the Ollama adapter requests on every call (`options.num_ctx`). Default 16384. The Ollama server does not need to be reconfigured. |
| `VECTOR_OPENAI_BASE_URL`, `VECTOR_OPENAI_MODEL` | Endpoint and model for the OpenAI-compatible adapter (LM Studio, OpenAI, or Ollama's `/v1`). |
| `VECTOR_OPENAI_CONTEXT_TOKENS` | OpenAI-compatible adapter: the server's real context window. Prompts that do not fit are refused rather than silently truncated. |
| `VECTOR_OPENAI_TOKEN_PARAM` | `max_tokens` or `max_completion_tokens`. By default `max_completion_tokens` is used for `*.openai.com` and `max_tokens` elsewhere. |
| `VECTOR_MODEL_TRAINING_CUTOFF` | The model's *documented* training cutoff, as `YYYY-MM-DD`. An assessment is `BLOCKED` when the replay date falls before the cutoff, or within `VECTOR_MODEL_CUTOFF_MARGIN_DAYS` after it (default 90). A model with no known cutoff is blocked until one is configured. Built-in: `claude-opus-5-5` = 2026-06-30. |
| `VECTOR_ALLOW_PRE_CUTOFF_REPLAY` | `1` lets a hindsight-risky run go ahead anyway. Every result is then stamped `hindsight_risk`. Leave it unset unless you accept that the model may remember the replay day. |
| `VECTOR_MODEL_TIMEOUT_MS`, `VECTOR_MODEL_MAX_TOKENS` | Per-call timeout (default 120000) and output-token limit (default 16000). An adapter timeout set in the model config file (`ollama.timeoutMs`, `openaiCompatible.timeoutMs`) takes precedence for that adapter's lens calls and is what `GET /api/model` reports as `limits.timeoutMs`. |
| `VECTOR_MODEL_REPAIR_ATTEMPTS` | Re-asks per lens after an `INVALID_OUTPUT` answer. Default 1, maximum 2, and `0` disables re-asks. A re-ask contains only that lens's own rejected answer and the validator errors. The rejected attempt is kept as an audit row, and every re-ask counts against both call budgets. |
| `VECTOR_MAX_MODEL_CALLS_PER_SESSION`, `VECTOR_MAX_MODEL_CALLS_PER_DAY` | Call budgets. The defaults are 60 calls per replay session and 300 per rolling 24 hours across all sessions (lens calls plus model tests). Calls that never reached a model (connection refused or host not found before any response, disconnected, missing SDK or credentials, configuration) do not count. A connection that drops after the request was sent (`NETWORK`) does count, because the endpoint may already have produced the answer. |
| `VECTOR_MODEL_CONFIG` | Optional JSON file for the non-secret model settings. Default `data/model-config.json`. It is re-read when it changes and the provider is resolved again on every call, so an edit to this file needs no restart. Environment variables need a restart. |
| `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` (secret) | Anthropic credentials, resolved by the SDK. |
| `VECTOR_OPENAI_API_KEY` (secret) | Optional for local servers. |
| `VECTOR_MODEL_PRESET`, `VECTOR_MODEL_PRESET_MODEL` | Use a named preset from `config/model-presets.json` (see "Model presets" below) instead of `VECTOR_MODEL_PROVIDER`. A selection saved in the UI (Data sources → Model presets) takes precedence. |
| `VECTOR_MODEL_LENS_COWBOY`, `VECTOR_MODEL_LENS_PRAGMATIST`, `VECTOR_MODEL_LENS_TIGHTWAD` | Per-lens override, `preset` or `preset@model` (for example `groq@openai/gpt-oss-20b`). |
| `VECTOR_MODEL_PIN_ALL_LENSES=1` | Experiment setting: all three lenses use the default preset and model (ignores the per-lens overrides). |
| `VECTOR_ALLOW_PAID=1` | Lifts the $0 guard. Without it, any preset whose `cost` is not `free` (and `VECTOR_MODEL_PROVIDER=anthropic` or a non-local endpoint) is `BLOCKED: PAID_PROVIDER_BLOCKED`. |
| `VECTOR_REAL_DATA_ALLOW_PRESETS` | Comma-separated preset ids the owner explicitly allows to receive real-account data although they do not declare `trains_on_prompts: false`. Default: none. |
| `VECTOR_MODEL_PRESETS` | Path of the preset catalog. Default `config/model-presets.json`. |
| `VECTOR_GROQ_API_KEY`, `VECTOR_OPENROUTER_API_KEY`, `VECTOR_GEMINI_API_KEY` (secret) | Keys for the free API presets. Server environment only. |
| `VECTOR_SNAPTRADE_CLIENT_ID`, `VECTOR_SNAPTRADE_CONSUMER_KEY` (secret) | SnapTrade Personal keys for read-only real accounts (see "Real accounts" below). |
| `VECTOR_SNAPTRADE_USER_ID`, `VECTOR_SNAPTRADE_USER_SECRET` (secret) | Only if SnapTrade issued you a user id and secret. Personal keys need neither. Set both or neither. |
| `VECTOR_SNAPTRADE_ACTIVITY_DAYS`, `VECTOR_SNAPTRADE_BASE_URL` | Transaction window per sync (default 365 days) and API base (default `https://api.snaptrade.com/api/v1`). |
| `ALPACA_API_KEY_ID`, `ALPACA_API_SECRET_KEY`, `POLYGON_API_KEY` (secret) | Live/delayed quote adapters. These are **unverified**: they have never run against genuine data in this build. Once configured, check them from the server with `POST /api/feeds/verify` (see below). |
| `ALPACA_DATA_FEED`, `ALPACA_OPTIONS_FEED`, `ALPACA_DATA_BASE_URL`, `ALPACA_TRADING_BASE_URL`, `POLYGON_BASE_URL` | Non-secret adapter settings. `ALPACA_OPTIONS_FEED=opra` is needed for an options check to count as verified; the default `indicative` feed never verifies. |
| `SEC_USER_AGENT` | Required by `npm run ingest:sec`. Give a name plus a contact e-mail, per SEC fair-access policy. VECTOR never invents one. |

## Ingesting real data

Every script accepts `--db <path>` and writes a receipt to `receipts/`.

| Command | Source | Receipt and outcome on 2026-10-09 |
|---|---|---|
| `npm run ingest:iex -- --date 2026-10-07` (local file: add `--file x.pcap.gz [--partial]`) | IEX HIST TOPS 1.6, streamed and never stored, about 10 GB per day | `receipts/ingest-iex-tops-2026-10-07.json`. 9,985,168,752 bytes, matching IEX's index exactly; SHA-256 `bb405b68…`; 0 sequence gaps; 2,161 symbols stored; 291,203 minute rows; 555 s. |
| `npm run ingest:fred [-- --series DGS10,UNRATE]` | FRED `fredgraph.csv`, no key | `receipts/ingest-fred.json`. 10 series, latest vintage (revisable). |
| `npm run ingest:symdir` | Nasdaq Trader symbol directory, no key | `receipts/ingest-symdir.json`. Fetched 2026-10-09 05:23 UTC, *after* the replay date. |
| `npm run ingest:finra [-- --dates 2026-09-30,2026-10-01]` | FINRA Reg SHO daily files, no key | `receipts/ingest-finra.json`. Six trade dates, 2026-09-30 to 2026-10-07. |
| `SEC_USER_AGENT="<name> <e-mail>" npm run ingest:sec -- --symbols SYM1,SYM2` | SEC EDGAR | `receipts/ingest-sec.json`. **BLOCKED**: `SEC_USER_AGENT` was not set, so 0 requests were made. |
| GDELT has no command. It runs on demand from the research dossier, at no more than 1 request every 6 s. | GDELT DOC 2.0, metadata only | `receipts/ingest-gdelt-probe.json`. **PROVIDER_FAULT**: HTTP 429 on every attempt. |
| `POST /api/import/csv` with a provenance manifest | Your own file | The status stays `IMPORTED_UNVERIFIED`. An upload does not establish authenticity. |

In PowerShell, set variables with `$env:SEC_USER_AGENT = "<name> <e-mail>"` before running the command.

## Connecting a model

The lenses share one evidence packet but run as separate calls. With no provider the UI says `MODEL DISCONNECTED / ASSESSMENT NOT RUN`, and no rule logic stands in for the model. Every run asks for an explicit confirmation, because a provider may bill for its three calls.

**Local Ollama, native adapter** (zero cost; recommended for Ollama). The adapter calls Ollama's own `/api/chat` and asks for the context window on every request, so a default Ollama install works without restarting it with a larger context.

```bash
VECTOR_MODEL_PROVIDER=ollama \
VECTOR_OLLAMA_MODEL=qwen3:8b \
VECTOR_OLLAMA_NUM_CTX=16384 \
VECTOR_MODEL_TRAINING_CUTOFF=<the model's documented cutoff, YYYY-MM-DD> \
npm start
```

`VECTOR_OLLAMA_BASE_URL` defaults to `http://127.0.0.1:11434`. Ollama may load the model with less context than requested, for example when the model's trained maximum is lower. The adapter reads the loaded context back from `/api/ps` and refuses any answer that ran past it, rather than accepting a truncated one. A slow local model (for example on CPU) can get a longer per-call timeout with `{"ollama": {"timeoutMs": 600000}}` in the model config file.

**Local Ollama through the OpenAI-compatible adapter.** This is the setup behind `receipts/model-smoke-ollama.json`; see the qualification in `docs/LIMITATIONS_FROM_REVIEW.md` §4. Ollama's `/v1` endpoint cannot set the context per request, so the Ollama server itself must be started with enough context:

```bash
# Ollama side
OLLAMA_CONTEXT_LENGTH=16384 ollama serve
# VECTOR side
VECTOR_MODEL_PROVIDER=openai-compatible \
VECTOR_OPENAI_BASE_URL=http://127.0.0.1:11434/v1 \
VECTOR_OPENAI_MODEL=qwen3:8b \
VECTOR_OPENAI_CONTEXT_TOKENS=16384 \
VECTOR_MODEL_TRAINING_CUTOFF=<the model's documented cutoff, YYYY-MM-DD> \
npm start
```

With either adapter, a model without `VECTOR_MODEL_TRAINING_CUTOFF` shows `CONNECTED`, but every assessment run is refused with `BLOCKED`. The reason is that the model's training cutoff is unknown, so it might remember what happened after the replay date. This was observed with `qwen3:8b` on 2026-10-09. Do not enter a guess: use the cutoff the model vendor documents.

A run can also be started in the background with `{"sym": "...", "confirm": true, "async": true}` on `POST /api/assessments/run`. Progress then shows in `GET /api/status` under `model.running` and `model.inFlight.assessment`.

**Anthropic.** Paid, so refused by the $0 guard unless the owner sets `VECTOR_ALLOW_PAID=1`. Run `npm install` for the optional SDK, then:

```bash
VECTOR_ALLOW_PAID=1 VECTOR_MODEL_PROVIDER=anthropic ANTHROPIC_API_KEY=<key> npm start     # model default: claude-opus-5-5
```

### Model presets (local and free API, $0)

`config/model-presets.json` names configurations of the same adapters. Each preset declares `cost`, `trains_on_prompts` (from the provider's own terms, with the source URL), per-model `training_cutoff` for the hindsight guard, and a local `limits` block (requests per minute and per day) that VECTOR enforces before any call. Free-tier terms and limits change: edit the file (or point `VECTOR_MODEL_PRESETS` at a copy) when they do. Keys never go in the file.

| Preset | Endpoint | Key variable | cost | trains_on_prompts (source) | Local limit |
|---|---|---|---|---|---|
| `ollama-local` (default) | native Ollama, `http://127.0.0.1:11434` | none | free | false (docs.ollama.com/faq) | 30/min, 2000/day |
| `lmstudio-local` | LM Studio, `http://127.0.0.1:1234/v1` | none | free | false (lmstudio.ai/docs/app/offline) | 30/min, 2000/day |
| `groq` | `https://api.groq.com/openai/v1` | `VECTOR_GROQ_API_KEY` | free | unknown (console.groq.com/docs/your-data) | 30/min, 1000/day |
| `openrouter-free` | `https://openrouter.ai/api/v1`, model ids ending `:free` only | `VECTOR_OPENROUTER_API_KEY` | free | unknown (openrouter.ai/docs/features/privacy-and-logging) | 20/min, 50/day |
| `gemini-flash-free` | Gemini's OpenAI-compatible endpoint `https://generativelanguage.googleapis.com/v1beta/openai` | `VECTOR_GEMINI_API_KEY` | free | **true** (ai.google.dev/gemini-api/terms) | 5/min, 100/day |
| `anthropic` | SDK default | `ANTHROPIC_API_KEY` | paid (blocked) | unknown | 10/min, 300/day |

Use one from the environment, or pick per lens in the UI (Data sources → Model presets) and press **Test** next to a row:

```bash
VECTOR_MODEL_PRESET=ollama-local VECTOR_MODEL_PRESET_MODEL=qwen3:8b npm start             # local, $0
VECTOR_MODEL_PRESET=groq VECTOR_GROQ_API_KEY=<your key> npm start                          # default model openai/gpt-oss-20b
VECTOR_MODEL_PRESET=openrouter-free VECTOR_OPENROUTER_API_KEY=<your key> npm start         # default openai/gpt-oss-20b:free
VECTOR_MODEL_PRESET=gemini-flash-free VECTOR_GEMINI_API_KEY=<your key> npm start           # default gemini-3.8-flash
```

A free API preset without its key shows `BLOCKED: NO_API_KEY`. A model with no catalog cutoff (for example `gemini-3.8-flash`, whose page lists none) is `BLOCKED: MODEL_TRAINING_CUTOFF_UNKNOWN` for assessments until a documented cutoff is added to the catalog or set as `trainingCutoff` in the selection.

**Pin one model for the experiment.** To keep the eight-account comparison fair, give all three lenses the same model: tick "Experiment: pin the default model for all three lenses" and Save, or start with `VECTOR_MODEL_PIN_ALL_LENSES=1` (plus `VECTOR_MODEL_PRESET` / `VECTOR_MODEL_PRESET_MODEL`). The settings card then shows `SAME MODEL FOR ALL THREE LENSES`, and `GET /api/model` reports `selection.sameModelAllLenses: true`.

## Real accounts (SnapTrade, read-only)

VECTOR can show your own brokerage accounts, read-only, through SnapTrade Personal (free, personal use). It never places, changes or cancels an order there; the Real accounts view has no trade controls, and real holdings never feed the paper lab. The data stays in the local database and is served only to this machine.

You, the owner, enter the keys. Never paste them into a chat, the browser or a file that git tracks:

1. Create a SnapTrade Personal account in the SnapTrade dashboard, verify your email, turn on two-factor authentication, and create your Personal client ID and consumer key.
2. Put them in `.env` (gitignored) and start VECTOR with it, for example `node --env-file=.env server/index.js`:
   ```
   VECTOR_SNAPTRADE_CLIENT_ID=<your Personal client ID>
   VECTOR_SNAPTRADE_CONSUMER_KEY=<your Personal consumer key>
   ```
   Personal keys need no user id or secret, and VECTOR registers no user. Add `VECTOR_SNAPTRADE_USER_ID` and `VECTOR_SNAPTRADE_USER_SECRET` only if SnapTrade issued them to you.
3. Open **Real accounts**, choose **Connect a brokerage…**, open the portal link (valid 5 minutes; data access only) and log in to your brokerage at SnapTrade.
4. Back in VECTOR, choose **Sync now…**. Balances, positions and up to a year of transactions appear under `REAL ACCOUNT — READ ONLY`.

SnapTrade refreshes its cached data about once a day. VECTOR does not call SnapTrade's manual refresh, which may be billed. Without keys every real-account screen shows `BLOCKED: SNAPTRADE_NOT_CONFIGURED` and nothing is faked. To send real holdings to a model, add `includeRealAccount: true` to `POST /api/assessments/run`. This only works when every lens uses a preset that declares `trains_on_prompts: false` (the local presets); otherwise it is refused with `REAL_DATA_PRIVACY_BLOCK`.

## Replay

The Replay view controls the session:

* **Reset** (`POST /api/replay/reset`) chooses the dataset and seed money and creates the six agent portfolios plus the sandbox.
  * All agents start PAUSED. While the kill switch is engaged they stay STOPPED instead.
  * Each agent keeps its current strategy, so an edited strategy can be re-run on the same day. Send `restorePresets: true` to go back to the exploratory presets.
  * A partial (truncated) dataset is replayed only up to the end of its data, not to 16:00 ET. One whose data ends at or before the open is refused (`DATASET_INCOMPLETE`). Orders expire at that replay end, no order is accepted after it, and agents stop opening entries `noEntryLastMin` before it.
* **Step** moves forward by +1, +5, +15 or +60 minutes. **Play** and **Pause** start and stop a server-side timer, so the replay advances with no browser open.

As-of rule: a minute `[t, t+60 s)` becomes knowable at `t + 60 s`. Agents, assessments and as-of views never see data past the replay clock. The retrospective study is withheld (`WITHHELD_UNTIL_CLOSE`) until the replay clock reaches the session close.

## Checking a live or options feed

With Alpaca or Polygon credentials in the server environment, `POST /api/feeds/verify {"sym": "AAPL"}` makes one latest-quote request and `POST /api/options/verify {"underlying": "AAPL"}` asks for put contracts and one option quote. Both are human-only, run one at a time, allow one check per 30 s, and answer 409 `NO_VERIFIED_DATA` when no provider is configured. The result is wall-clock status only. It is kept in memory and reported by `GET /api/status` (`data.live`, `options`) and `GET /api/sources` until the server restarts. It never reaches the replay: replay options orders stay `NO_VERIFIED_OPTIONS_DATA`. Quote prices are not returned or stored. The web UI has no button for these checks in this build; call the API directly (mutations need the `X-Vector-Client: web` header and `Content-Type: application/json`).

## Tests and checks

* `npm test` runs every `test/**/*.test.js` with `node:test` (471 tests passed on 2026-10-09 after connections-v1; `receipts/connections-v1/npm-test.txt`). The tests use temporary databases under `data/test-*`. They regenerate the TEST FIXTURE journal samples in `receipts/journal-samples/fixture-*.json`. Record the run as a receipt; the README cites the current pass count.
* `node test/intel/live-smoke-ollama.js --training-cutoff <documented YYYY-MM-DD>` is the zero-cost live model smoke against a local Ollama (native adapter by default, `--num-ctx 16384`). It runs on a disposable `VACUUM INTO` copy of the database, never writes `data/vector.db`, and writes `receipts/model-smoke-ollama.json` with reviewer notes. It is not part of `npm test`.
* `node test/api/e2e-real-replay.mjs --base <url> --ds iex-tops-2026-10-07 --db <same db as the server>` is the real-data end-to-end driver behind `receipts/e2e-real-replay-2026-10-07.json` and the `real-*` journal samples. It resets and plays the replay session of the server it drives, places sandbox orders and engages the kill switch.
* `node scripts/preset-smoke.mjs [--model qwen3:8b] [--assess]` is the zero-cost live smoke of the **preset path**: an in-process server on a `VACUUM INTO` copy with `VECTOR_MODEL_PRESET=ollama-local` pinned for all lenses and a clean environment (no keys passed). It writes `receipts/connections-v1/preset-smoke-ollama.json`.
* `node scripts/connections-adversarial.mjs` prints the connections-v1 adversarial checks (no trading, no secret leaks, privacy gate, $0 guard, public build) against mocks; output in `receipts/connections-v1/adversarial.txt`.
* `node scripts/ui-check.mjs --base <url> [--prepare-ds <ds> --prepare-to HH:MM]` (also `npm run ui-check -- --base <url>`) is the repeatable phone and desktop UI check. It refuses port 8787 unless `--allow-shared` is passed and always refuses 8790. It writes `receipts/ui-check.json` and `receipts/ui/*.png`; see `docs/MOBILE_QA.md`. The older `docs/ui-checks/ui-check.mjs` and `docs/UI_CHECKS.md` record the mid-fix fixture and API-unreachable runs.
* `npm run ingest:csv -- --manifest m.json --csv bars.csv` imports a CSV over the 64 KB HTTP body limit. It uses the same validator as `POST /api/import/csv`, and the data stays `IMPORTED_UNVERIFIED`.
* `node test/web/check-server.mjs --port <p> --mode fixture|unreachable` is a static server for layout checks. Fixture mode serves TEST FIXTURE API responses. Unreachable mode returns 503 for every `/api/*`. It is not part of the product.
