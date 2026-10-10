// As-of market and research views (docs/CONTRACTS.md section 9). Every market read uses the replay clock as asOf through
// server/data/marketdata.js (directly or via the scanner / dossier), so no response ever contains a minute that was not
// complete at the clock. The retrospective study is the one deliberate exception: it is labelled RETROSPECTIVE, uses
// data after each signal, is never visible to agents, and is withheld (BLOCKED / WITHHELD_UNTIL_CLOSE) for the dataset
// being replayed until the replay clock reaches the session close, so the human sandbox cannot trade on hindsight.
import { etToUtc, fmtEt } from '../util/time.js';
import { sessionWindow, barsAsOf, quoteAsOf, lastTradeAsOf, macroAsOf } from '../data/marketdata.js';
import { BENCHMARKS, SEGMENTS, PRICE_TIERS } from '../data/universe.js';
import { scanAsOf, SCANNER_LABEL, INSTRUMENT_FILTERS } from '../research/scanner.js';
import { dossier } from '../research/dossier.js';
import { historicalSignalStudy, RETRO_LABEL } from '../research/retrospective.js';
import { listAssessments } from '../intel/assessments.js';
import { memoScan } from './context.js';
import { query, oneOf, intIn, symbol } from './http.js';

const SEGMENT_VALUES = ['micro', 'large', 'low'];
const WINDOW_VALUES = ['5', '15', '30', '60'];
const DEFAULT_WINDOW_MIN = 15;
const NO_SESSION_DETAIL = 'No replay session with a verified market dataset. Ingest a dataset (npm run ingest:iex -- --date YYYY-MM-DD) and reset the replay.';
const MULTI_DAY_HORIZONS = 'BLOCKED BY DATA: days/weeks horizons need several ingested trading days; the as-of scanner ranks within the replay day only.';

/** {ds, clock, open, close, tradeDate} for the active replay, or null when there is no verified dataset/clock. */
function asOfCtx(ctx) {
  const st = ctx.replay();
  if (!st.ds || !Number.isFinite(st.clock)) return null;
  const win = sessionWindow(ctx.db, st.ds);
  if (!win) return null;
  return { ds: st.ds, clock: st.clock, session_id: st.session_id, ...win };
}

function scanFor(ctx, a, segment, windowMin = DEFAULT_WINDOW_MIN, instruments = 'all') {
  return memoScan(ctx, `${a.ds}|${a.clock}|${segment}|${windowMin}|${instruments}`, () => scanAsOf(ctx.db, a.ds, a.clock, { segment, windowMin, instruments }));
}

function segmentNote(segment) {
  if (segment === 'low') return `${PRICE_TIERS.low.label}: ${PRICE_TIERS.low.description}. Market cap not verified.`;
  return SEGMENTS[segment]?.note ?? '';
}

/** GET /api/market/universe?segment= — the as-of segment universe with names (when a symbol directory is ingested). */
export function getUniverse(ctx, _req, { url }) {
  const q = query(url, ['segment', 'limit']);
  const segment = oneOf(q.segment, SEGMENT_VALUES, 'segment', { optional: true, dflt: 'micro' });
  const limit = intIn(q.limit, 1, 5000, 'limit', { optional: true, dflt: null });
  const a = asOfCtx(ctx);
  if (!a) return { asOf: null, segment, status: 'NO_VERIFIED_DATA', detail: NO_SESSION_DETAIL, note: segmentNote(segment), rows: [] };
  const scan = scanFor(ctx, a, segment);
  const rows = [...scan.rows].sort((x, y) => (x.sym < y.sym ? -1 : x.sym > y.sym ? 1 : 0))
    .map((r) => ({ sym: r.sym, name: r.name, namePostDated: r.namePostDated ?? null, securityType: r.securityType ?? null, nonCommon: r.nonCommon ?? null,
      priceU: r.priceU, minuteT: r.minuteT, quote: r.quote, metrics: r.metrics }));
  return {
    asOf: a.clock, ds: a.ds, segment, status: scan.status, label: SCANNER_LABEL, nameSource: scan.nameSource ?? null,
    note: `${segmentNote(segment)} ${scan.note ?? ''}`.trim(), counts: scan.counts,
    rows: limit ? rows.slice(0, limit) : rows,
  };
}

/** GET /api/research/opportunities?segment=&windowMin=5|15|30|60 — universe rows ranked by the transparent signal score. */
export function getOpportunities(ctx, _req, { url }) {
  const q = query(url, ['segment', 'limit', 'windowMin', 'instruments']);
  const segment = oneOf(q.segment, SEGMENT_VALUES, 'segment', { optional: true, dflt: 'micro' });
  const limit = intIn(q.limit, 1, 5000, 'limit', { optional: true, dflt: null });
  const windowMin = Number(oneOf(q.windowMin, WINDOW_VALUES, 'windowMin', { optional: true, dflt: String(DEFAULT_WINDOW_MIN) }));
  const instruments = oneOf(q.instruments, INSTRUMENT_FILTERS, 'instruments', { optional: true, dflt: 'all' });
  const horizons = { minutes: WINDOW_VALUES.map(Number), selected: windowMin, daysWeeks: MULTI_DAY_HORIZONS };
  const a = asOfCtx(ctx);
  if (!a) return { asOf: null, segment, windowMin, horizons, label: SCANNER_LABEL, status: 'NO_VERIFIED_DATA', detail: NO_SESSION_DETAIL, rows: [] };
  const scan = scanFor(ctx, a, segment, windowMin, instruments);
  return {
    asOf: a.clock, ds: a.ds, segment, instruments, label: SCANNER_LABEL, status: scan.status, nameSource: scan.nameSource ?? null,
    note: `${segmentNote(segment)} ${scan.note ?? ''}`.trim(),
    scoreFormula: scan.scoreFormula, weights: scan.weights, windowMin: scan.windowMin, horizons, counts: scan.counts, timing: scan.timing,
    rows: (limit ? scan.rows.slice(0, limit) : scan.rows).map((r, i) => ({ rank: i + 1, ...r })),
  };
}

/** GET /api/market/bars?sym= — completed IEX minutes up to the replay clock (never beyond) plus the as-of quote. */
export function getBars(ctx, _req, { url }) {
  const q = query(url, ['sym', 'from']);
  const sym = symbol(q.sym);
  const from = oneOf(q.from, ['open', 'premarket'], 'from', { optional: true, dflt: 'open' });
  const a = asOfCtx(ctx);
  if (!a) return { asOf: null, sym, rows: [], quote: null, status: 'NO_VERIFIED_DATA', detail: NO_SESSION_DETAIL };
  const lo = from === 'premarket' ? etToUtc(a.tradeDate, 4, 0) : a.open;
  const rows = barsAsOf(ctx.db, a.ds, sym, a.clock, { from: lo, limit: 1000 }).map((r) => ({
    t: r.t, o: r.o, h: r.h, l: r.l, c: r.c, v: r.v, n: r.n, bv: r.bv, sv: r.sv, xv: r.xv,
    vwapU: r.v ? Math.round(r.pv / r.v) : null, halted: r.halted === 1,
  }));
  const quote = quoteAsOf(ctx.db, a.ds, sym, a.clock);
  const last = lastTradeAsOf(ctx.db, a.ds, sym, a.clock);
  return {
    asOf: a.clock, sym, ds: a.ds, session: { open: a.open, close: a.close, tradeDate: a.tradeDate }, from,
    status: rows.length || quote ? 'HISTORICAL_REAL' : 'NO_VERIFIED_DATA',
    detail: rows.length || quote ? null : `No IEX observations for ${sym} knowable at the replay clock in dataset ${a.ds}.`,
    note: 'IEX-only minute aggregates (not consolidated). A minute [t, t+60 s) is shown only once complete at the replay clock. bv/sv are INFERRED aggressor volumes (quote rule vs IEX BBO).',
    rows, quote, lastTrade: last,
  };
}

/** GET /api/market/benchmark — benchmark ETF returns since the session open, as-of the clock (IEX-only prices). */
export function getBenchmark(ctx, _req, { url }) {
  query(url, []);
  const a = asOfCtx(ctx);
  if (!a) return { asOf: null, status: 'NO_VERIFIED_DATA', detail: NO_SESSION_DETAIL, series: [] };
  const series = BENCHMARKS.map((sym) => {
    const rows = barsAsOf(ctx.db, a.ds, sym, a.clock, { from: a.open, limit: 1000 });
    const first = rows.find((r) => r.o != null && r.o > 0);
    if (!first) return { sym, status: 'NO_VERIFIED_DATA', basePriceU: null, baseMinuteT: null, points: [] };
    const base = first.o;
    const points = rows.filter((r) => r.c != null && r.t >= first.t)
      .map((r) => ({ t: r.t, retPct: Math.round(((r.c / base) - 1) * 1e6) / 1e4, priceU: r.c }));
    return { sym, status: 'HISTORICAL_REAL', basePriceU: base, baseMinuteT: first.t, points };
  });
  return {
    asOf: a.clock, ds: a.ds, label: 'IEX-ONLY PRICES — same-venue reference, not consolidated',
    status: series.some((s) => s.points.length) ? 'HISTORICAL_REAL' : 'NO_VERIFIED_DATA',
    note: 'Return % since each ETF\'s first IEX trade of the regular session (that minute\'s open), using completed minutes only. Benchmarks are a configured list, not a market-cap claim.',
    series,
  };
}

/** GET /api/macro — macro observations knowable at the replay clock (publication lag applied). */
export function getMacro(ctx, _req, { url }) {
  query(url, []);
  const st = ctx.replay();
  if (!Number.isFinite(st.clock)) return { asOf: null, status: 'NO_VERIFIED_DATA', detail: NO_SESSION_DETAIL, series: [] };
  const series = macroAsOf(ctx.db, st.clock);
  if (!series.length) {
    return { asOf: st.clock, status: 'NO_VERIFIED_DATA', detail: 'No macro series ingested. Run npm run ingest:fred on a machine with internet access.', series: [] };
  }
  return {
    asOf: st.clock, status: 'HISTORICAL_REAL',
    vintage: 'LATEST_VINTAGE_NOT_POINT_IN_TIME',
    vintageNote: 'Values are FRED\'s latest vintage, not the vintage published as of the replay clock: a value shown may include revisions published after the replay date.',
    note: 'FRED latest-vintage observations, shown only after observation date + publication lag <= replay clock. Revisions (vintages) are not modelled.',
    series,
  };
}

/** GET /api/research/dossier?sym= */
export function getDossier(ctx, _req, { url }) {
  const q = query(url, ['sym']);
  const sym = symbol(q.sym);
  const st = ctx.replay();
  if (!Number.isFinite(st.clock)) {
    const na = { status: 'NO_VERIFIED_DATA', reason: NO_SESSION_DETAIL };
    const sections = ['identity', 'market', 'halts', 'shortVolume', 'filings', 'financing', 'leadership', 'media', 'assessments'];
    return {
      sym, asOf: null, ds: null, ...Object.fromEntries(sections.map((k) => [k, na])),
      unavailable: sections.map((k) => ({ section: k, status: 'NO_VERIFIED_DATA', reason: NO_SESSION_DETAIL })),
    };
  }
  const d = dossier(ctx.db, st.ds, sym, st.clock, { session_id: st.session_id });
  // Stored assessments are scoped to the CURRENT replay session (rows of other sessions or smoke runs never appear in
  // the live view), knowable at the clock. Computed here so the scope does not depend on dossier.js's own query.
  d.assessments = sessionAssessments(ctx.db, sym, st.session_id, st.clock);
  d.unavailable = (d.unavailable ?? []).filter((u) => u.section !== 'assessments');
  if (d.assessments.status !== 'STORED') d.unavailable.push({ section: 'assessments', status: d.assessments.status, reason: d.assessments.reason });
  return d;
}

function sessionAssessments(db, sym, session_id, clock) {
  const rows = session_id ? listAssessments(db, { sym, session_id, limit: 300 }).filter((a) => a.as_of <= clock).slice(0, 30) : [];
  if (!rows.length) return { status: 'ASSESSMENT_NOT_RUN', scope: 'current replay session', reason: 'No stored model assessment for this symbol in this replay session at or before the replay clock.' };
  return {
    status: 'STORED', scope: 'current replay session', session_id,
    rows: rows.map((r) => ({
      id: r.id, session_id: r.session_id, lens: r.lens, provider: r.provider, model: r.model, as_of: r.as_of, created_wall: r.created_wall, status: r.status,
      evidenceIds: r.evidence_ids, packetSha256: r.packet_sha256, packet_sha256: r.packet_sha256, output: r.output, error: r.error ?? null,
    })),
  };
}

const r2 = (x) => (x === null || x === undefined || !Number.isFinite(x) ? null : Math.round(x * 100) / 100);

function compactEvents(events) {
  return events.map((e) => ({
    sym: e.sym, signalEt: e.signal.E_et, retWPct: r2(e.signal.ret_w * 100), outcome: e.outcome.class, classRetPct: e.outcome.classRetPct,
    mfePct: e.outcome.mfePct, maePct: e.outcome.maePct, sessionCloseRetPct: e.outcome.sessionCloseRetPct, spreadBps: e.signal.spreadBps,
    relVol: r2(e.signal.relVol), buyShare: r2(e.signal.buyShare), volumeW: e.signal.volumeW, signalPriceU: e.signal.priceU, signalTs: e.signal.E,
    horizons: e.outcome.horizons,
  }));
}

function compactRule(rule) {
  if (!rule) return null;
  return {
    label: rule.label, default: rule.default, interpretation: rule.interpretation, fillModel: { id: rule.fillModel?.id, source: rule.fillModel?.source },
    variants: rule.variants.map((v) => ({ id: v.id, stopMode: v.stopMode, tpMult: v.tpMult, timeExit: v.timeExit, summary: v.summary })),
  };
}

function compactRun(run) {
  return {
    thresholdPct: run.thresholdPct, counts: run.counts, rows: compactEvents(run.events),
    matched: run.matched ? { method: run.matched.method, features: run.matched.features, pairs: (run.matched.pairs || []).slice(0, 50) } : null,
    handwrittenRule: compactRule(run.handwrittenRule),
  };
}

/** GET /api/research/study?tier=penny|low&full=1 — RETROSPECTIVE signal/failure study (cached per dataset + params). */
export function getStudy(ctx, _req, { url }) {
  const q = query(url, ['tier', 'full']);
  const tier = oneOf(q.tier, ['penny', 'low'], 'tier', { optional: true, dflt: 'penny' });
  const full = oneOf(q.full, ['0', '1', 'true', 'false'], 'full', { optional: true, dflt: '0' });
  const st = ctx.replay();
  if (!st.ds) {
    return { label: RETRO_LABEL, status: 'BLOCKED', detail: `BLOCKED BY DATA: ${NO_SESSION_DETAIL} No historical case is fabricated.`, rows: [] };
  }
  if (Number.isFinite(st.clock) && Number.isFinite(st.t_end) && st.clock < st.t_end) {
    // Applies to full=1 too: the study describes outcomes after each signal on the very day being replayed.
    return {
      label: RETRO_LABEL, status: 'BLOCKED', reason: 'WITHHELD_UNTIL_CLOSE', ds: st.ds, tier, asOf: st.clock,
      availableAtMs: st.t_end, availableAtEt: fmtEt(st.t_end, { date: true }),
      detail: 'WITHHELD UNTIL CLOSE: the hindsight study for the dataset being replayed uses data after each signal, so it is shown only once the replay clock reaches the session close.',
      rows: [],
    };
  }
  const s = historicalSignalStudy(ctx.db, st.ds, { tier });
  if (full === '1' || full === 'true') return s;
  if (s.status !== 'HISTORICAL_REAL') return { label: RETRO_LABEL, status: s.status, detail: s.note ?? null, ds: st.ds, rows: [] };
  const primary = compactRun(s.primary);
  return {
    label: RETRO_LABEL, status: s.status, ds: s.ds, tier,
    note: 'Hindsight study over the whole replay day: uses data AFTER each signal and is never visible to agents or as-of views. Add ?full=1 for every fill and pair.',
    dataset: s.dataset,
    session: { tradeDate: s.session.tradeDate, open: fmtEt(s.session.open, { date: true }), close: fmtEt(s.session.close, { date: true }), openMs: s.session.open, closeMs: s.session.close },
    definitions: s.definitions, limitations: s.limitations,
    thresholdPct: primary.thresholdPct, counts: primary.counts,
    rows: primary.rows,
    matched: primary.matched,
    handwrittenRule: primary.handwrittenRule,
    exploratory: s.exploratory ? { label: s.exploratory.label, reason: s.exploratory.reason, ...compactRun(s.exploratory) } : null,
    timing: s.timing,
  };
}
