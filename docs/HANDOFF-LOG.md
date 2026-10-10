# Handoff log

## 2026-10-09: repo move, first commit, ui-polish-v1 (Claude, Opus 5.5)

**Path.** The repo was copied, not moved, from the temporary session folder to `C:\AI_Projects\Claude\vector-claude`. `..\deliverables\` was copied alongside it, and the clean shipped DB from the data archive was placed at `data\vector.db` (SHA-256 `6d152444…d959`, matching the archive). The superseded 417 MB `vector-prelim.db` was not copied. `npm test` at the new path: **436/436 pass**.

**First commit.** `3d749b2` "VECTOR MVP: initial import" on `master`, 438 files, with the DBs and logs ignored. All work since is on branch **`ui-polish-v1`**.

**Polish pass.** Impeccable (installed v4.3.1, Operate / product mode) ran an audit across every view, using the detector plus the rendered views at 360–1920 px. The work followed the dataviz chart rules and validated the palette with `scripts/validate-palette.js`. The polish started 21:28 EDT and finished well inside the 2-hour cap.

### Impeccable audit

Health score: **13/20 before → 19/20 after.** The 1-point gap is Accessibility: there is no automated colour-contrast audit yet.

| Finding (detector or visual) | Status |
|---|---|
| Hover state at 3.4:1: bone text on copper (`a.btn-primary`, skip link) | Fixed. Obsidian ink on hover. |
| 0.06em tracking on body text (motto) | Fixed |
| Chips cramped top/bottom | Fixed. Real 4 px inset. |
| 3 px coloured side stripe on the selected portfolio card; 2 px border-left on the current side-nav item | Fixed. Full border plus raised surface; current nav item shown by surface and a copper icon. |
| Pulsing "running" dots (Replay play state, strip "model running"). **They imply live data on a historical replay.** | Fixed. Static dot next to a text label. |
| Copper glow used as the scroll-edge cue | Fixed. Neutral edge fade. |
| `transition: width` on the progress bar (layout property) | Fixed. Removed. |
| **Data-truth labels at 13 px on phones** (chips, badges, label banners), below the owner's 16 px rule | Fixed. 16 px on phones with tighter tracking. The phone strip is now 3 rows at 360–390 px, by design. |
| Overflow: 768×1024 `#/research` (`.opt-row` two max-content columns) | Fixed (red→green below) |
| Sidebar logo link under 44 px on tablets | Fixed. `min-height: 44px`. |
| 12-column grid squeezed charts at 1024 landscape (axis labels collided) | Fixed. The 12-column split starts at 1280. 768–1279 uses 2 columns with wide panels full width; collections use `auto-fit`/`auto-fill` with `minmax()`. |
| 1920: content hugged the left edge | Fixed. Main clamps to 1360 px and is centred; strip chips align with it. |
| Overview: secondary panels trailed far below a long list; the right column was half empty | Fixed. A rail holds Benchmark, Timestamps, Sources and Agents (one column at ≥ 1280, tiles below that). |
| Agents on phone about 9,000 px; Journal filters fill the first screens | Fixed. Strategy key settings are in a disclosure; the EXPLORATORY DEFAULTS banner, name and description stay visible. Journal filters are collapsed on phones. |
| Phone segment control wrapped "Penny / micro" onto two lines | Fixed. Buttons size to their content. |
| Browser surfaces at defaults | Fixed. `::selection`, scrollbar colours, caret and accent colour come from the palette. |
| Bottom tab bar let page text show through | Fixed. Opaque. |
| Off-brand chart blue `#86A9D1` and a status colour used as a series | Fixed by the chart pass (below) |
| No PRODUCT.md / DESIGN.md | Deferred. Offer `/impeccable init` and `/impeccable document` in a later unit. |
| Charts rebuild on every replay tick, so keyboard focus on a chart is lost while playing | Deferred. Needs a view refactor (render diffing). |

The detector reported 9 findings at baseline, 1 after the fix batch (the skip-link hover) and **0** after that was fixed.

### Charts (dataviz rules)

- **Price/volume:** now **two stacked single-axis panels** sharing one time axis; it was effectively one plot with two scales. Volume bars use 2 px surface gaps and 4 px rounded data-ends anchored to the baseline.
- **Benchmark:** **copper small multiples**, one panel per ETF on the same y-scale, each labelled with its name and latest value. The RCL ramps cannot produce a passing 4-series categorical palette: copper is the only chromatic brand hue, while steel and bone have chroma ≈ 0. Per constraint 1, no hue was invented. The best the ramps allow is a 2-slot copper pair; it is documented but not shipped.
- **Marks and text:** 2 px lines, 8 px end markers with a surface ring, recessive grid and axes. All text uses text tokens.
- **Interaction:** a crosshair and tooltip on hover, keyboard stepping (slider semantics), and a **Table view** under every chart that scrolls inside its own box.
- **Inferred buyer/seller volume:** uses `--up`/`--down` as **status** colours, always with ▲/▼ glyphs and labels.
- **Missing minutes:** lines now break there instead of interpolating, matching the existing note that nothing is interpolated.
- **Print:** a light step set is validated on bone and used under `@media print`. `forced-colors` rules were added.

### Palette validator (`scripts/validate-palette.js`, copied from the dataviz skill)

| Palette | Dark (`#181818`) | Light / print (`#F5F3EE`) |
|---|---|---|
| Categorical: `#B87333` (1 slot) | ALL CHECKS PASS | ALL CHECKS PASS |
| Status/diverging: buyer `#8DB596` / seller `#D2756A` / unclassified `#696969` (dark); `#6A9174` / `#A95047` / `#484848` (light) | CVD WARN 7.4 (deutan), normal-vision 17.7 PASS, contrast PASS. Lightness-band and chroma-floor rows FAIL. | CVD 8.0 PASS, normal-vision 18.0 PASS, contrast PASS. Lightness-band and chroma-floor rows FAIL. |

Two notes on the status/diverging rows:
- **The lightness-band and chroma-floor FAILs don't apply.** The validator's own output says "scope: categorical palettes only". By the owner's rules, gain/loss-type polarity is status/diverging, never categorical, and the diverging midpoint is grey by design.
- **The CVD WARN is mitigated by:**
  - ▲/▼ glyphs plus labels in the legend, tooltip and table header;
  - a fixed stack order;
  - 2 px segment gaps;
  - the table view.

Full output: `receipts/ui-polish-v1/palette-{dark,light}.txt`.

### Widths covered (`scripts/ui-check.mjs`, now with a build-failing overflow tripwire)

Previously 360/390/430/1440. **Now** 360×780, 390×844, 430×932, **768×1024, 1024×1366, 1024×768, 1440×900 and 1920×1080**, across 10 routes plus the phone buy/sell flow and the narrow replay/assessment flow.

- **Full run:** **768/768 assertions, 95 screenshots, exit 0**, with 160/160 tripwire checks (`receipts/ui-check.json`).
- **Red→green:** 768×1024 `#/research` on `3d749b2` exits **3** (page widened to 818 px). The same check exits **0** after the fix (`receipts/ui-polish-v1/tripwire-{red,green}.json`).

### E11 done

The two 2.6 MB SVG crops (5.26 MB) became 506 KB of PNG: marks at 32/40/64/80/96/120 px and the lockup at its native 814×502. Results:
- The lockup is pixel-identical at 1x.
- The marks score 30–38 dB PSNR against the old render. At 3x Chrome's scaling is identical, so the remaining difference is Chrome's own resampling.
- WebP is not shipped, because the static server has no `.webp` MIME type. A candidate file is in `receipts/ui-polish-v1/logo/webp-candidate/`. Details: `docs/RCL-Logo-Source.md`.

### Verification

- `npm test`: **437/437** (one new logo-raster test).
- The UI check, tripwire and screenshots are listed above.
- Before/after screenshots: `receipts/ui-polish-v1/{before,after}/` (viewport) and `{before-clean,after-full}/` (full page).
- **Independent check** (a fresh subagent that had not seen the work):
  - **PASS:** every data-truth label is still visible on the same screens, at 16 px on phones (68 label elements at 390×844).
  - **PASS:** no chart text uses a series or status colour.
  - **PASS:** the logo is the same artwork and crop (lockup PSNR ∞; marks 37–44 dB).
  - **Two minor defects found, fixed once, re-checked PASS:**
    - Phone axis labels were 1.2 px apart; they are now 54–58 px apart. The phone axis keeps about 3 references, and the unit test was updated to this rule.
    - Status-code badges broke mid-word at 16 px; they now break only after underscores (`<wbr>`, textContent unchanged), and `.metrics` tiles have a minimum of 11rem.
  - **Pre-existing, not changed:** a long URL overflows its dashed box at 768 `#/sources`, and an env-var name does the same at 360 Research. Some prose mentions of "estimated" are 13–15 px captions, not label tokens.

- **Merge record:** `ui-polish-v1` merged into `master` as `179eb4a` (--no-ff) at 2026-10-10T02:51:03Z.

## 2026-10-09: connections-v1 (Claude, Opus 5.5)

Branch **`connections-v1`** from `master` `c5eb4e2`. Started 22:52 EDT (3-hour cap). Scope: read-only SnapTrade real accounts, plus local and free-API model presets at $0.

**SnapTrade, read-only.** The module is `server/data/providers/snaptrade.js`, built on built-in `fetch` and `node:crypto` HMAC-SHA256 signing. It adds no dependency and does not use the SDK.
- **Operations.** The closed list `READ_ONLY_OPERATIONS` is all the module can send:
  - one Connection Portal link, `POST /snapTrade/login` with `connectionType` fixed to `read`;
  - four GETs: accounts, balances, positions (`/positions/all`, then `/positions` on 404), and activities (paged, 365-day window).
- **Not wired:**
  - SnapTrade's connection-refresh call, which its docs say may be billed;
  - user registration. Per SnapTrade's Personal-key docs, Personal keys must not call Register user and need no `userId`/`userSecret`. Optional `VECTOR_SNAPTRADE_USER_ID` and `VECTOR_SNAPTRADE_USER_SECRET` are sent only when both are set.
- **Storage.** Rows go to their own `real_*` tables, CHECK-constrained to `source='SNAPTRADE'` and `data_class='REAL_ACCOUNT'`, with `fetched_at` and masked account numbers.
- **Routes.** `/api/real/{status,connect,sync,accounts,transactions}` are loopback-peer only, refused in remote mode or when proxy headers are present. No order, trade or cancel route exists, and any such path returns 404.
- **Not configured.** Without keys the status is `BLOCKED: SNAPTRADE_NOT_CONFIGURED`.
- **UI.** A new **Real accounts** view, labelled `REAL ACCOUNT — READ ONLY`, with no trade controls.

**Model presets.**
- **Catalog.** `config/model-presets.json`, loaded by `server/intel/providers/presets.js`, reuses the existing adapters (no fork):
  - `ollama-local` (the default) and `lmstudio-local`;
  - free API: `groq`, `openrouter-free` (`:free` ids only) and `gemini-flash-free` (Gemini's official OpenAI-compatible endpoint);
  - `anthropic` (paid).
- **Per preset:** cost, trains_on_prompts with its source URL, per-model training cutoffs, local per-minute and daily limits, and docs URLs.
- **Guards:**
  - the $0 guard, which also covers the legacy `VECTOR_MODEL_PROVIDER` path;
  - key isolation: each preset's key goes only to its own endpoint;
  - `LOCAL_RATE_LIMIT`;
  - a refusal for Ollama cloud models on the local preset.
- **Lens selection.** Each lens can use its own preset, or one model can be pinned for all three lenses (env or `PUT /api/model/selection`). The settings card is in Data sources. `POST /api/model/test {preset, model}` tests any preset.
- **Privacy gate.** `includeRealAccount` on an assessment is refused with 403 `REAL_DATA_PRIVACY_BLOCK` unless every lens's preset declares `trains_on_prompts: false`. The check also runs inside the runner. Real context is appended as non-evidence text, and no paper intent is derived from it.
- **Timeouts.** Local presets carry `timeout_ms: 300000`. The first live run showed qwen3:8b exceeding the 120 s default on two lenses.

**trains_on_prompts (from each provider's own pages, read 2026-10-09).**

| Preset | Value | Source |
|---|---|---|
| ollama-local | false | https://docs.ollama.com/faq |
| lmstudio-local | false | https://lmstudio.ai/docs/app/offline |
| groq | unknown: the official data page covers retention, not training | https://console.groq.com/docs/your-data |
| openrouter-free | unknown: depends on the routed provider and the account setting | https://openrouter.ai/docs/features/privacy-and-logging |
| gemini-flash-free | **true** for free-tier content | https://ai.google.dev/gemini-api/terms |
| anthropic (paid) | unknown, not re-verified | https://www.anthropic.com/legal/commercial-terms |

**Verification.**
- `npm test`: **473/473** (`receipts/connections-v1/npm-test.txt`; 36 new tests).
- **Adversarial checks** (`receipts/connections-v1/adversarial.txt`), each refused as expected:
  - (a) the grep finds no SnapTrade trading call, and 24 `/api/real/*order*|*trade*` probes all return 404;
  - (b) the sentinel secrets appear 0 times across responses, logs and every DB table, on the success path, a 401 that echoes the credentials, and a network failure;
  - (c) `REAL_DATA_PRIVACY_BLOCK` is returned for groq (unknown), gemini (true) and one-lens-on-groq, with 0 model requests; local passes the gate;
  - (d) `PAID_PROVIDER_BLOCKED` is returned for the anthropic preset and the legacy `VECTOR_MODEL_PROVIDER=anthropic`;
  - (e) `web/` contains no data files, SnapTrade host or secrets; the static server answers 404 for config, server and DB paths; no `.db` or `.env` is tracked.
- **UI tripwire:** routes real, sources and more at all 8 sizes, **216/216**, with 0 of 48 tripwire failures (`receipts/connections-v1/ui-check.json`).
- **Live smoke at $0 through the preset path** (`scripts/preset-smoke.mjs`, VACUUM INTO copy, clean environment):
  - **Run 1** (120 s default timeout): `POST /api/model/test {preset:ollama-local, model:qwen3:8b}` returned **OK** in 14.2 s. The pinned three-lens run on TOPP at 10:30 ET came back **PARTIAL**: cowboy and pragmatist hit **TIMEOUT**, tightwad OK. Kept as `preset-smoke-ollama-run1-timeout120s.json`.
  - **Run 2** (preset `timeout_ms` 300000): the model test returned **OK** in 7.5 s; the three-lens run returned **decision OK**, all three lenses OK (cowboy consider_entry, pragmatist avoid, tightwad avoid) in 297 s. Cowboy was OK after one bounded repair (first answer SEMANTIC_INVALID: a stop price on a limit order). Every lens ran on `preset:ollama-local` with `qwen3:8b` and training cutoff 2025-04-29 from the preset catalog (`receipts/connections-v1/preset-smoke-ollama.json`). Cost: $0.
- **Independent check:** a fresh subagent re-ran (a), (b) and (c) itself and read the diff.
  - **First pass:** (a) PASS (120/120 probes 404, no SnapTrade trading call); (b) PASS for the classified secrets; (c) PASS, including bypass attempts; no order path. It found six issues:
    1. model text derived from real holdings was stored and served by non-loopback routes;
    2. percent-encoded secrets were not scrubbed;
    3. `VECTOR_SNAPTRADE_USER_ID` was not treated as a secret;
    4. preset keys echoed by an endpoint reached the journal;
    5. an anthropic-adapter catalog entry could declare `local:true`;
    6. sync errors were always withheld.
  - **One fix round:**
    - real-context rows are flagged `real_ctx` (column added in place), stored without model text and never listed; real-context runs are synchronous only;
    - secrets are scrubbed in raw and URL-encoded form, and network errors show only a code;
    - the user id is a secret;
    - `scrubResult` removes a provider's key from results on the preset and legacy paths;
    - an anthropic preset must be `local:false`;
    - `SnapTradeError` messages are shown.
  - **One re-check:** all six PASS; A and C repeated, PASS; no new problems; 69/69 targeted tests.
  - **Still open (low, catalog trust):** a hand-edited catalog can declare an anthropic preset `cost:'free', trains_on_prompts:false`. Proposed one-line fix, not applied (fix budget used): `validatePreset` requires `cost:'paid'` and `trains_on_prompts !== false` for `adapter:'anthropic'`.
- A model test after the fixes also returned OK (`preset-smoke-ollama-postfix-modeltest.json`).

**Not done / owner.**
- Nothing ran against SnapTrade itself; the real link waits for the owner's keys.
- Free API presets were tested only against mocks; they need the owner's free keys.
- `gemini-3.8-flash` has no published knowledge cutoff, so its assessments stay `BLOCKED: MODEL_TRAINING_CUTOFF_UNKNOWN`.
- The Groq and Gemini free-tier numeric limits are not published per account on their docs pages. The values in the catalog are conservative upper bounds; the owner should set them from the account pages.

- **Merge record:** `connections-v1` merged into `master` as `430da72` (--no-ff) at 2026-10-10T03:52:57Z.

## 2026-10-10: static preview label and Netlify update (Claude, Opus 5.5)

- **Owner request:** update the public preview at https://rcl-vector-claude-preview.netlify.app. Before deploying, the owner chose to fix the deployment label.
- **Label:** `web/js/deploy-note.js`. The sidebar, More and About say **"Static preview · no live data"** when the page is not on a loopback host and no VECTOR API has answered. On the local server they keep "Local MVP · not publicly deployed".
- **Commits:** branch `preview-label` (`d63d803`) merged into `master` as `3dc8e53` (--no-ff). `npm test` passed; the web tests passed 63/63.
- **Deploy:** Netlify deploy `6ac9bfbf44ae06d4c106f6bf`. It contains only the 39 tracked `web/` files from `3dc8e53` (`git archive`), staged outside the repo, plus a one-line `netlify.toml` (`publish = "."`). No data, receipts, server code, config or keys were included.
- **Verified live:** the label reads "Static preview · no live data". Real accounts shows `REAL_DATA_LOOPBACK_ONLY` and requests nothing. Every data view shows "API unreachable", by design: a static host has no VECTOR server.
