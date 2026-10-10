// Research dossier for one symbol AS OF the replay clock (GET /api/research/dossier?sym=).
//
// Every section is either real stored data that was knowable at asOf, or an explicit status from the contract
// vocabulary with the reason. Nothing is filled in: no invented issuer facts, leadership, catalysts or media.
//   identity     Nasdaq Trader directory. HISTORICAL_REAL only when the snapshot was published at or before asOf;
//                a later (post-dated) snapshot gives NO_VERIFIED_DATA and its fields go to identity.currentDirectory,
//                labelled as not as-of evidence.
//   market       IEX quotes/trades via marketdata.js (as-of; a stored symbol is revealed only once its first
//                sub-$5 observation is knowable, so data availability is not a hindsight signal)
//   halts        IEX trading-status / operational-halt / short-sale-test events with ts <= asOf (same visibility gate)
//   shortVolume  FINRA Reg SHO rows knowable at 18:00 ET of their trade date (assumption)
//   filings      SEC EDGAR filings with acceptance <= asOf, or BLOCKED when SEC access is not configured
//   financing    shares-outstanding facts (dilution) knowable <= asOf, else UNAVAILABLE_NOT_VERIFIED
//   leadership   UNAVAILABLE_NOT_VERIFIED (no verified leadership source in this build)
//   sector       BLOCKED without SEC EDGAR access (SIC codes), else UNAVAILABLE_NOT_VERIFIED (SIC not ingested)
//   analystViews UNAVAILABLE_NOT_VERIFIED (no licensed analyst/commentator source; never inferred or invented)
//   media        GDELT metadata evidence with knowable_ts <= asOf, else NO_VERIFIED_DATA (connection NOT_CONNECTED)
//   assessments  stored model assessments with as_of <= asOf (never generated here)
import { MINUTE } from '../util/time.js';
import { getDataset, sessionWindow, quoteAsOf, lastTradeAsOf, barsAsOf, statusAsOf, symbolVisibleAsOf, NOT_IN_STORED_UNIVERSE_NOTE } from '../data/marketdata.js';
import {
  latestRefSymbol, MARKET_CATEGORY, FINANCIAL_STATUS, parseFileCreationTime, SYMDIR_POSTDATED_NOTE, classifySecurity, iexToActSymbol,
} from '../data/ingest/nasdaq-symdir.js';
import { shortVolumeAsOf, FINRA_SCOPE_NOTE } from '../data/ingest/finra-regsho.js';
import { filingsAsOf, sharesOutstandingAsOf, secConfig } from '../data/ingest/sec-edgar.js';
import { mediaAsOf } from '../data/ingest/gdelt.js';

// IEX symbology: '.' class, '-' preferred, '+' warrant, '^' right, '=' unit, '#' when-issued; ACT '$' preferred.
const SYM_RE = /^[A-Z][A-Z0-9.\-$+^=#]{0,11}$/;
export const SECTIONS = Object.freeze(['identity', 'market', 'halts', 'shortVolume', 'filings', 'financing', 'leadership', 'sector', 'analystViews', 'media', 'assessments']);
export const CURRENT_DIRECTORY_LABEL = 'CURRENT DIRECTORY — FETCHED AFTER REPLAY DATE — NOT AS-OF EVIDENCE';

function hasGoodDataset(db, kind) {
  return !!db.prepare(`SELECT 1 FROM datasets WHERE kind = ? AND status IN ('complete', 'partial') LIMIT 1`).get(kind);
}

function identitySection(db, sym, asOf) {
  const r = latestRefSymbol(db, sym);
  if (!r) {
    const act = iexToActSymbol(sym);
    return {
      status: 'NO_VERIFIED_DATA', sym,
      reason: hasGoodDataset(db, 'symbol_directory')
        ? `Symbol not present in the stored Nasdaq Trader directory snapshot${act ? ` (also looked up as ${act}, its ACT spelling)` : ''}. The snapshot was fetched after the replay date, so its absence says nothing reliable about listings as of asOf.`
        : 'Symbol directory not ingested (run: npm run ingest:symdir).',
      securityType: { ...classifySecurity({ sym }), postDated: null },
    };
  }
  const fct = parseFileCreationTime(r.file_creation_time);
  const snapshotMs = fct.ms ?? r.published_at ?? r.ingested_at;
  const postDated = snapshotMs > asOf;
  const snapshot = { fileCreationTimeRaw: fct.raw, fileCreationTimeEt: fct.iso_et ?? null, fileCreationMs: fct.ms, ingestedAt: r.ingested_at, postDated };
  const fields = {
    name: r.name, exchange: r.exchange, matchedAs: r.matchedAs !== sym ? r.matchedAs : undefined,
    marketCategory: r.market_category ? { code: r.market_category, meaning: MARKET_CATEGORY[r.market_category] ?? 'unknown code' } : null,
    testIssue: r.test_issue === 1, etf: r.etf === null ? null : r.etf === 1, roundLot: r.round_lot,
    securityType: { ...classifySecurity({ sym, name: r.name, etf: r.etf }), postDated },
  };
  const financialStatus = r.financial_status ? { code: r.financial_status, meaning: FINANCIAL_STATUS[r.financial_status] ?? 'unknown code' } : null;
  if (postDated) {
    return {
      status: 'NO_VERIFIED_DATA', sym, source: 'Nasdaq Trader Symbol Directory', ds: r.ds,
      reason: `No as-of identity source: the only stored Nasdaq Trader directory snapshot was created ${fct.iso_et ?? 'at an unknown time'}, after the replay clock.`,
      currentDirectory: {
        label: CURRENT_DIRECTORY_LABEL, ...fields,
        financialStatus: financialStatus ? { ...financialStatus, usableAsOfEvidence: false, warning: 'Status at the post-dated snapshot time; it may not have applied at asOf.' } : null,
        snapshot, note: SYMDIR_POSTDATED_NOTE,
      },
    };
  }
  return {
    status: 'HISTORICAL_REAL', sym, source: 'Nasdaq Trader Symbol Directory', ds: r.ds, ...fields,
    financialStatus: financialStatus ? { ...financialStatus, postDated: false, usableAsOfEvidence: true, warning: null } : null,
    snapshot, note: 'Directory snapshot published at or before asOf.',
  };
}

function marketSection(db, ds, sym, asOf) {
  const d = ds ? getDataset(db, ds) : null;
  const session = d ? sessionWindow(db, ds) : null;
  if (!d || !session) return { status: 'NO_VERIFIED_DATA', reason: 'No replayable market dataset selected.' };
  const quote = quoteAsOf(db, ds, sym, asOf);
  const last = lastTradeAsOf(db, ds, sym, asOf);
  const bars = barsAsOf(db, ds, sym, asOf, { from: session.open, limit: 1000 });
  if (!quote && !last && !bars.length) {
    return { status: 'NO_VERIFIED_DATA', ds, reason: NOT_IN_STORED_UNIVERSE_NOTE };
  }
  let v = 0; let pv = 0; let n = 0; let hi = null; let lo = null; let bv = 0; let sv = 0;
  for (const b of bars) {
    v += b.v; pv += b.pv; n += b.n; bv += b.bv; sv += b.sv;
    if (b.h != null) { hi = hi === null ? b.h : Math.max(hi, b.h); lo = lo === null ? b.l : Math.min(lo, b.l); }
  }
  return {
    status: 'HISTORICAL_REAL', ds, venue: 'IEX', coverage: d.venue_coverage, attribution: d.attribution,
    quote, lastTrade: last,
    sessionToDate: {
      from: session.open, minutes: bars.length, iexVolume: v, trades: n, highU: hi, lowU: lo,
      vwapU: v > 0 ? Math.round(pv / v) : null,
      inferredBuyShare: bv + sv > 0 ? bv / (bv + sv) : null,
      note: 'IEX-only, regular session to asOf. inferredBuyShare = quote-rule classification vs IEX BBO (not intent).',
    },
    recentBars: bars.slice(-30).map((b) => ({ t: b.t, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v, bv: b.bv, sv: b.sv, xv: b.xv })),
  };
}

function haltsSection(db, ds, sym, asOf) {
  if (!ds) return { status: 'NO_VERIFIED_DATA', reason: 'No replayable market dataset selected.' };
  // Same stored-universe visibility gate as every marketdata read: a never-stored and a not-yet-visible symbol look alike.
  if (!symbolVisibleAsOf(db, ds, sym, asOf)) return { status: 'NO_VERIFIED_DATA', ds, reason: NOT_IN_STORED_UNIVERSE_NOTE };
  // As-of gate: exchange timestamp <= asOf. (marketdata.js exposes only the latest status; this list is the same
  // gate applied to the full event history. Proposed contract addition: marketdata.statusEventsAsOf.)
  const events = db.prepare(`SELECT ts, kind, code, reason FROM status_events WHERE ds = ? AND sym = ? AND ts <= ?
    AND kind IN ('trading_status', 'operational_halt', 'short_sale_test') ORDER BY ts ASC LIMIT 500`).all(ds, sym, asOf);
  const current = statusAsOf(db, ds, sym, asOf);
  return {
    status: 'HISTORICAL_REAL', ds, current,
    events,
    haltEvents: events.filter((e) => (e.kind === 'trading_status' && e.code !== 'T') || (e.kind === 'operational_halt' && e.code === 'O')).length,
    note: 'IEX trading-status (T trading, H halted, P paused, O order acceptance), operational-halt and short-sale-test events, by exchange timestamp.',
  };
}

function shortVolumeSection(db, sym, asOf) {
  if (!hasGoodDataset(db, 'short_volume')) return { status: 'NO_VERIFIED_DATA', reason: 'FINRA Reg SHO files not ingested (run: npm run ingest:finra).', scope: FINRA_SCOPE_NOTE };
  const rows = shortVolumeAsOf(db, sym, asOf);
  if (!rows.length) return { status: 'NO_VERIFIED_DATA', reason: 'No FINRA Reg SHO row for this symbol knowable at asOf (rows become knowable 18:00 ET on their trade date).', scope: FINRA_SCOPE_NOTE };
  return { status: 'HISTORICAL_REAL', scope: FINRA_SCOPE_NOTE, rows };
}

function filingsSection(db, sym, asOf) {
  const cfg = secConfig();
  if (!hasGoodDataset(db, 'filings')) {
    return cfg.configured
      ? { status: 'NO_VERIFIED_DATA', reason: 'SEC EDGAR configured but not yet ingested (run: npm run ingest:sec -- --symbols SYM).' }
      : { status: 'BLOCKED', reason: `SEC EDGAR access not configured: ${cfg.reason}.`, setup: cfg.setup };
  }
  const rows = filingsAsOf(db, sym, asOf);
  if (!rows.length) return { status: 'NO_VERIFIED_DATA', reason: 'No SEC filings for this symbol accepted at or before asOf in the stored data.' };
  return {
    status: 'HISTORICAL_REAL', knowability: 'EDGAR acceptance time (wall clock read as ET; conservative)', rows,
    symbolMapping: 'Ticker-to-CIK association from the CURRENT SEC company_tickers.json at ingest time (post-dated relative to earlier replays; ticker reuse/changes since the replay date are not reflected).',
    mapping: rows[0]?.symbolMapping ?? null,
  };
}

function financingSection(db, sym, asOf) {
  const facts = hasGoodDataset(db, 'filings') ? sharesOutstandingAsOf(db, sym, asOf) : [];
  if (!facts.length) {
    return {
      status: 'UNAVAILABLE_NOT_VERIFIED',
      reason: secConfig().configured ? 'No dei:EntityCommonStockSharesOutstanding facts knowable at asOf.' : 'SEC EDGAR access not configured (BLOCKED); no verified financing/dilution source.',
    };
  }
  const first = facts[0];
  const latest = facts.at(-1);
  return {
    status: 'HISTORICAL_REAL', concept: 'dei:EntityCommonStockSharesOutstanding',
    latest: { value: latest.value, periodEnd: latest.period_end, form: latest.form, accession: latest.accession, knowable_ts: latest.knowable_ts },
    changeSinceFirstPct: first.value > 0 ? Math.round((latest.value / first.value - 1) * 10000) / 100 : null,
    series: facts.map((f) => ({ value: f.value, periodEnd: f.period_end, form: f.form, filed: f.filed, accession: f.accession, knowable_ts: f.knowable_ts })),
    note: 'Cover-page shares outstanding as reported; increases indicate possible dilution but are not proof of an offering.',
  };
}

function sectorSection() {
  const cfg = secConfig();
  if (!cfg.configured) {
    return { status: 'BLOCKED', reason: `Sector/industry (SEC SIC code) requires SEC EDGAR access: ${cfg.reason}.`, setup: cfg.setup };
  }
  return { status: 'UNAVAILABLE_NOT_VERIFIED', reason: 'SEC EDGAR is configured but SIC codes are not ingested in this build; no sector/industry classification is inferred.' };
}

const ANALYST_VIEWS = Object.freeze({
  status: 'UNAVAILABLE_NOT_VERIFIED',
  reason: 'No licensed analyst/commentator source is connected; analyst views are never inferred or invented. GDELT media metadata (media section) is not analyst opinion.',
});

function mediaSection(db, sym, asOf) {
  const anyMedia = db.prepare(`SELECT status, notes FROM datasets WHERE kind = 'media' AND id LIKE ? ORDER BY ingested_at DESC LIMIT 1`).get(`gdelt-${sym}-%`);
  const rows = mediaAsOf(db, sym, asOf);
  if (rows.length) {
    return {
      status: 'HISTORICAL_REAL', provider: 'GDELT DOC 2.0 (metadata only)',
      items: rows.map((r) => ({ id: r.id, title: r.title, url: r.source_url, domain: r.body.domain, language: r.body.language, seendate: r.body.seendate, knowable_ts: r.knowable_ts })),
      note: 'Titles and links only; knowable_ts = GDELT first-seen time. Coverage is not exhaustive; absence is not evidence of no news.',
    };
  }
  if (!anyMedia) return { status: 'NO_VERIFIED_DATA', connection: 'NOT_CONNECTED', reason: 'No media metadata fetched for this symbol (GDELT is on demand).' };
  if (anyMedia.status === 'failed') return { status: 'PROVIDER_FAULT', reason: anyMedia.notes };
  return { status: 'NO_VERIFIED_DATA', reason: 'GDELT returned no articles knowable at or before asOf.' };
}

function assessmentsSection(db, sym, asOf) {
  const rows = db.prepare(`SELECT id, session_id, lens, provider, model, as_of, created_wall, evidence_ids_json, packet_sha256, status, output_json, error
      FROM assessments WHERE sym = ? AND as_of <= ? AND real_ctx = 0 ORDER BY as_of DESC, created_wall DESC LIMIT 30`).all(sym, asOf);
  if (!rows.length) return { status: 'ASSESSMENT_NOT_RUN', reason: 'No stored model assessment for this symbol at or before asOf.' };
  return {
    status: 'STORED',
    rows: rows.map((r) => ({
      id: r.id, lens: r.lens, provider: r.provider, model: r.model, as_of: r.as_of, created_wall: r.created_wall, status: r.status,
      evidenceIds: JSON.parse(r.evidence_ids_json || '[]'), packetSha256: r.packet_sha256,
      output: r.output_json ? JSON.parse(r.output_json) : null, error: r.error,
    })),
  };
}

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string|null} ds  market dataset being replayed
 * @param {string} sym
 * @param {number} asOf  replay clock ms UTC
 */
export function dossier(db, ds, sym, asOf) {
  if (!Number.isFinite(asOf)) throw new TypeError('asOf (ms UTC) is required');
  if (typeof sym !== 'string' || !SYM_RE.test(sym)) throw new TypeError('invalid symbol');
  const out = {
    sym, asOf, ds: ds ?? null,
    identity: identitySection(db, sym, asOf),
    market: marketSection(db, ds, sym, asOf),
    halts: haltsSection(db, ds, sym, asOf),
    shortVolume: shortVolumeSection(db, sym, asOf),
    filings: filingsSection(db, sym, asOf),
    financing: financingSection(db, sym, asOf),
    leadership: { status: 'UNAVAILABLE_NOT_VERIFIED', reason: 'No verified issuer leadership/officer source is connected in this build.' },
    sector: sectorSection(),
    analystViews: { ...ANALYST_VIEWS },
    media: mediaSection(db, sym, asOf),
    assessments: assessmentsSection(db, sym, asOf),
  };
  const ok = new Set(['HISTORICAL_REAL', 'STORED']);
  out.unavailable = SECTIONS
    .filter((k) => !ok.has(out[k].status))
    .map((k) => ({ section: k, status: out[k].status, reason: out[k].reason ?? null }));
  out.asOfNote = `All sections gated to knowable time <= asOf (minute rows at t + ${MINUTE / 1000} s). `
    + 'Identity is HISTORICAL_REAL only from a directory snapshot published by asOf; a post-dated snapshot appears only under identity.currentDirectory.';
  return out;
}
