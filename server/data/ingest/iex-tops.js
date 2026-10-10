// IEX Exchange HIST "TOPS 1.6" ingestion.
//
// Source: IEX historical data (https://iextrading.com/trading/market-data/), free with attribution:
//   "Data provided for free by IEX. By accessing or using IEX Historical Data, you agree to the IEX Historical
//    Data Terms of Use." (https://www.iex.io/legal/hist-data-terms)
// Coverage: IEX exchange only. IEX top-of-book is NOT the NBBO and IEX volume is a small share of consolidated
// volume. IEX states the data is a reference point, not a basis for trading decisions.
//
// File format: gzip(pcapng) -> Ethernet/IPv4/UDP -> IEX-TP v1 segments -> TOPS 1.6 messages (little-endian).
// We stream, never storing the multi-GB file, and aggregate per symbol per minute:
//   trade OHLCV, VWAP numerator, inferred aggressor volume (quote rule vs prevailing IEX BBO), quote state at
//   minute end, two-sided quote extremes within the minute, halt/availability flags.
//
// Trade breaks ('B'): IEX can break (cancel) an earlier trade. A break that arrives in the SAME minute as its trade is
// removed from that minute's aggregates before the row is written (the row is only knowable at minute end, so nothing
// leaks). A break that arrives in a later minute cannot be applied retroactively without leaking it into a row that was
// knowable earlier, so it is recorded as a status_events row (kind 'trade_break', ts = break time) and consumers apply it
// from its break time on (marketdata.tradeBreaksAsOf / fillMinute / windowAggregatesAsOf).
//
// Partial (truncated) days: quality.coverage_end_ms is the start of the minute containing the last received message;
// that minute and everything after it were not fully observed, so rows from it on are flagged unavail = 1 and
// marketdata.js serves no quotes or fills past it.
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { Readable } from 'node:stream';
import { tx } from '../../db.js';
import { MINUTE } from '../../util/time.js';
import { STORAGE_MAX_PRICE_U, largeCapList, BENCHMARKS, KNOWN_TEST_SYMBOLS } from '../universe.js';

export const IEX_ATTRIBUTION = 'Data provided for free by IEX. By accessing or using IEX Historical Data, you agree to the IEX Historical Data Terms of Use (https://www.iex.io/legal/hist-data-terms).';
export const IEX_COVERAGE = 'IEX Exchange only (top-of-book quotes and trades on IEX). Not consolidated: IEX BBO is not the NBBO and IEX volume is a fraction of total U.S. volume. OTC securities not covered.';

const TWO32 = 4294967296;

// ---- symbol key: pack 8 ASCII chars into a 48-bit integer (6 bits/char) for fast Map lookups ----
const CODE = new Int8Array(128).fill(-1);
(() => {
  const chars = ' ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.+-=^#*/$';
  for (let i = 0; i < chars.length; i++) CODE[chars.charCodeAt(i)] = i;
})();

function symKey(b, o) {
  let k = 0;
  for (let i = 0; i < 8; i++) {
    const c = b[o + i];
    const code = c < 128 ? CODE[c] : -1;
    if (code < 0) return -1;
    k = k * 64 + code;
  }
  return k;
}

const readTsMs = (b, o) => Math.floor((b.readUInt32LE(o + 4) * TWO32 + b.readUInt32LE(o)) / 1e6);
const readPx = (b, o) => b.readInt32LE(o + 4) * TWO32 + b.readUInt32LE(o);
const readU64 = (b, o) => b.readUInt32LE(o + 4) * TWO32 + b.readUInt32LE(o);
// Recent trade ids kept per symbol so a later-minute break can name the minute (and classification) of its trade.
const RECENT_TRADE_IDS = 64;

class SymState {
  constructor(sym) {
    this.sym = sym;
    this.bid = 0; this.ask = 0; this.bsz = 0; this.asz = 0; this.qts = null;
    this.avail = true; this.sess = 0; this.status = 'T'; this.opHalt = false; this.isTest = false;
    this.mt = -1; this.touched = false;
    this.recent = new Map(); // trade id -> [minute, cls, flags] for the last RECENT_TRADE_IDS trades
    // day stats (retrospective only)
    this.firstTs = null; this.lastTs = null; this.minPx = Infinity; this.maxPx = -Infinity;
    this.trades = 0; this.volume = 0; this.quotes = 0;
    this.resetBucket();
  }
  resetBucket() {
    this.o = null; this.h = null; this.l = null; this.c = null;
    this.v = 0; this.n = 0; this.pv = 0; this.bv = 0; this.sv = 0; this.xv = 0; this.ev = 0; this.ov = 0;
    this.nq = 0; this.minBid = null; this.maxBid = null; this.minAsk = null; this.maxAsk = null; this.maxSpr = null;
    this.btrades = []; // [id, px, size, flags, cls] for trades in the current minute (same-minute break removal)
    this.unavail = this.avail ? 0 : 1;
    this.halted = (this.status !== 'T' || this.opHalt) ? 1 : 0;
    this.noteQuoteExtremes();
  }
  noteQuoteExtremes() {
    if (this.bid > 0 && this.ask > 0) {
      if (this.minBid === null || this.bid < this.minBid) this.minBid = this.bid;
      if (this.maxBid === null || this.bid > this.maxBid) this.maxBid = this.bid;
      if (this.minAsk === null || this.ask < this.minAsk) this.minAsk = this.ask;
      if (this.maxAsk === null || this.ask > this.maxAsk) this.maxAsk = this.ask;
      const spr = this.ask - this.bid;
      if (this.maxSpr === null || spr > this.maxSpr) this.maxSpr = spr;
    }
  }
  notePx(px) {
    if (px < this.minPx) this.minPx = px;
    if (px > this.maxPx) this.maxPx = px;
  }
  /** Add one trade to the current minute's aggregates. cls: 'b' buyer- / 's' seller-initiated / 'x' unclassified. */
  addTrade(px, size, flags, cls) {
    if (this.o === null) { this.o = px; this.h = px; this.l = px; }
    if (px > this.h) this.h = px;
    if (px < this.l) this.l = px;
    this.c = px;
    this.v += size; this.n++; this.pv += px * size;
    if (flags & 0x40) this.ev += size;
    if (flags & 0x20) this.ov += size;
    if (cls === 'b') this.bv += size; else if (cls === 's') this.sv += size; else this.xv += size;
  }
  /** Rebuild the current minute's trade aggregates from btrades (after a same-minute trade break). */
  rebuildTrades() {
    this.o = null; this.h = null; this.l = null; this.c = null;
    this.v = 0; this.n = 0; this.pv = 0; this.bv = 0; this.sv = 0; this.xv = 0; this.ev = 0; this.ov = 0;
    for (const [, px, size, flags, cls] of this.btrades) this.addTrade(px, size, flags, cls);
  }
}

/**
 * Stateful TOPS aggregator. Feed IEX-TP payloads via onSegment(buf, offset, length).
 * emitRows(rows) is called with arrays of m1 rows; emitStatus(evts) with status events.
 */
export class TopsAggregator {
  constructor({ emitRows, batchSize = 20000 }) {
    this.emitRows = emitRows;
    this.batchSize = batchSize;
    this.byKey = new Map();
    this.byStr = new Map();
    this.rows = [];
    this.status = [];
    this.counts = Object.create(null);
    this.packets = 0;
    this.segments = 0;
    this.seqGaps = [];
    this.nextSeq = null;
    this.firstSend = null; this.lastSend = null;
    this.systemEvents = [];
    this.lastMsgMs = null;
    this.tradeBreaks = 0;
    this.breaksApplied = 0;      // same-minute breaks removed from the minute aggregates
    this.breaksUnapplied = 0;    // later-minute breaks recorded as status events (trade minute known)
    this.breaksUnmatched = 0;    // breaks whose trade id was not among the recent trades (trade minute unknown)
  }

  state(b, o) {
    const k = symKey(b, o);
    let s;
    if (k >= 0) {
      s = this.byKey.get(k);
      if (!s) { s = new SymState(b.toString('latin1', o, o + 8).trimEnd()); this.byKey.set(k, s); }
    } else {
      const str = b.toString('latin1', o, o + 8).trimEnd();
      s = this.byStr.get(str);
      if (!s) { s = new SymState(str); this.byStr.set(str, s); }
    }
    return s;
  }

  roll(s, ms) {
    const m = ms - (ms % MINUTE);
    if (s.mt !== m) {
      if (s.touched) this.flush(s);
      s.mt = m; s.touched = false;
      s.resetBucket();
    }
    s.touched = true;
  }

  flush(s) {
    this.rows.push([s.sym, s.mt, s.o, s.h, s.l, s.c, s.v, s.n, s.pv, s.bv, s.sv, s.xv, s.ev, s.ov,
      s.bid || null, s.ask || null, s.bsz || null, s.asz || null, s.qts,
      s.minBid, s.maxBid, s.minAsk, s.maxAsk, s.maxSpr, s.nq, s.unavail, s.halted, s.sess]);
    if (this.rows.length >= this.batchSize) { this.emitRows(this.rows); this.rows = []; }
  }

  /** Process one IEX-TP segment located at b[off .. off+len). */
  onSegment(b, off, len) {
    if (len < 40) return;
    this.segments++;
    const msgCount = b.readUInt16LE(off + 14);
    const firstSeq = b.readUInt32LE(off + 28) * TWO32 + b.readUInt32LE(off + 24);
    const sendMs = readTsMs(b, off + 32);
    if (this.firstSend === null) this.firstSend = sendMs;
    this.lastSend = sendMs;
    if (msgCount > 0) {
      if (this.nextSeq !== null && firstSeq !== this.nextSeq) {
        if (this.seqGaps.length < 1000) this.seqGaps.push({ expected: this.nextSeq, got: firstSeq, at: sendMs });
      }
      this.nextSeq = firstSeq + msgCount;
    }
    let m = off + 40;
    const end = off + len;
    for (let i = 0; i < msgCount && m + 2 <= end; i++) {
      const mlen = b.readUInt16LE(m);
      const p = m + 2;
      m = p + mlen;
      if (m > end) break;
      this.onMessage(b, p, mlen);
    }
  }

  onMessage(b, p, mlen) {
    const type = b[p];
    switch (type) {
      case 0x51: { // 'Q' Quote Update (42 bytes)
        this.counts.Q = (this.counts.Q || 0) + 1;
        if (mlen < 42) return;
        const ms = readTsMs(b, p + 2);
        const s = this.state(b, p + 10);
        this.roll(s, ms);
        const flags = b[p + 1];
        s.bsz = b.readUInt32LE(p + 18);
        s.bid = readPx(b, p + 22);
        s.ask = readPx(b, p + 30);
        s.asz = b.readUInt32LE(p + 38);
        s.avail = (flags & 0x80) === 0;
        s.sess = (flags & 0x40) ? 1 : 0;
        s.qts = ms;
        s.nq++;
        s.quotes++;
        if (!s.avail) s.unavail = 1;
        s.noteQuoteExtremes();
        if (s.bid > 0 && s.ask > 0 && s.ask >= s.bid) s.notePx(Math.round((s.bid + s.ask) / 2));
        this.lastMsgMs = ms;
        return;
      }
      case 0x54: { // 'T' Trade Report (38 bytes)
        this.counts.T = (this.counts.T || 0) + 1;
        if (mlen < 38) return;
        const ms = readTsMs(b, p + 2);
        const s = this.state(b, p + 10);
        this.roll(s, ms);
        const flags = b[p + 1];
        const size = b.readUInt32LE(p + 18);
        const px = readPx(b, p + 22);
        const id = readU64(b, p + 30);
        // Quote rule vs prevailing IEX BBO (Lee-Ready without tick test). IEX midpoint executions stay unclassified.
        let cls = 'x';
        if (s.bid > 0 && s.ask > 0 && s.ask > s.bid) cls = px >= s.ask ? 'b' : px <= s.bid ? 's' : 'x';
        s.addTrade(px, size, flags, cls);
        s.btrades.push([id, px, size, flags, cls]);
        s.recent.set(id, [s.mt, cls, flags]);
        if (s.recent.size > RECENT_TRADE_IDS) s.recent.delete(s.recent.keys().next().value);
        if (s.firstTs === null) s.firstTs = ms;
        s.lastTs = ms;
        s.trades++; s.volume += size;
        s.notePx(px);
        this.lastMsgMs = ms;
        return;
      }
      case 0x48: { // 'H' Trading Status
        this.counts.H = (this.counts.H || 0) + 1;
        const ms = readTsMs(b, p + 2);
        const s = this.state(b, p + 10);
        this.roll(s, ms);
        const st = String.fromCharCode(b[p + 1]);
        s.status = st;
        if (st !== 'T') s.halted = 1;
        const reason = b.toString('latin1', p + 18, p + 22).trim();
        this.status.push([s.sym, ms, 'trading_status', st, reason]);
        return;
      }
      case 0x4f: { // 'O' Operational Halt Status
        this.counts.O = (this.counts.O || 0) + 1;
        const ms = readTsMs(b, p + 2);
        const s = this.state(b, p + 10);
        this.roll(s, ms);
        const st = String.fromCharCode(b[p + 1]);
        s.opHalt = st === 'O';
        if (s.opHalt) s.halted = 1;
        this.status.push([s.sym, ms, 'operational_halt', st, null]);
        return;
      }
      case 0x50: { // 'P' Short Sale Price Test Status
        this.counts.P = (this.counts.P || 0) + 1;
        const ms = readTsMs(b, p + 2);
        const s = this.state(b, p + 10);
        const st = b[p + 1];
        if (st === 1) this.status.push([s.sym, ms, 'short_sale_test', '1', String.fromCharCode(b[p + 18] || 32).trim() || null]);
        return;
      }
      case 0x44: { // 'D' Security Directory (IEX-listed only)
        this.counts.D = (this.counts.D || 0) + 1;
        const s = this.state(b, p + 10);
        if (b[p + 1] & 0x80) s.isTest = true;
        return;
      }
      case 0x42: { // 'B' Trade Break (same layout as 'T'; names the broken trade by id)
        this.counts.B = (this.counts.B || 0) + 1;
        this.tradeBreaks++;
        if (mlen < 38) return;
        const ms = readTsMs(b, p + 2);
        const s = this.state(b, p + 10);
        const size = b.readUInt32LE(p + 18);
        const px = readPx(b, p + 22);
        const id = readU64(b, p + 30);
        const m = ms - (ms % MINUTE);
        let applied = false;
        let tradeMinute = null;
        let cls = null;
        let flags = null;
        if (s.mt === m) {
          const i = s.btrades.findIndex((x) => x[0] === id);
          if (i >= 0) {
            [, , , flags, cls] = s.btrades[i];
            s.btrades.splice(i, 1);
            s.rebuildTrades();
            s.trades--; s.volume -= size;
            applied = true;
            tradeMinute = m;
          }
        }
        if (!applied) {
          const r = s.recent.get(id);
          if (r) [tradeMinute, cls, flags] = r;
        }
        if (applied) this.breaksApplied++; else if (tradeMinute !== null) this.breaksUnapplied++; else this.breaksUnmatched++;
        this.status.push([s.sym, ms, 'trade_break', String(id), JSON.stringify({
          px, size, trade_minute: tradeMinute, applied, cls,
          ext: flags === null ? null : (flags & 0x40) !== 0, odd: flags === null ? null : (flags & 0x20) !== 0,
        })]);
        return;
      }
      case 0x53: { // 'S' System Event
        this.counts.S = (this.counts.S || 0) + 1;
        this.systemEvents.push({ event: String.fromCharCode(b[p + 1]), ts: readTsMs(b, p + 2) });
        return;
      }
      default: {
        const t = String.fromCharCode(type);
        this.counts[t] = (this.counts[t] || 0) + 1;
      }
    }
  }

  finish() {
    for (const s of this.allStates()) if (s.touched) { this.flush(s); s.touched = false; }
    if (this.rows.length) { this.emitRows(this.rows); this.rows = []; }
  }

  *allStates() {
    yield* this.byKey.values();
    yield* this.byStr.values();
  }
}

/**
 * pcapng block reader over a stream of decompressed chunks. Calls onPacket(buf, off, len) with the UDP payload.
 */
export class PcapNgReader {
  constructor(onPayload) {
    this.onPayload = onPayload;
    this.left = null;
    this.linkTypes = [];
    this.blocks = 0;
    this.packets = 0;
    this.badBlocks = 0;
  }
  push(chunk) {
    let b = this.left ? Buffer.concat([this.left, chunk]) : chunk;
    let off = 0;
    while (off + 12 <= b.length) {
      const bt = b.readUInt32LE(off);
      const bl = b.readUInt32LE(off + 4);
      if (bl < 12 || bl % 4 !== 0) { this.badBlocks++; throw new Error(`corrupt pcapng block length ${bl} at block ${this.blocks}`); }
      if (off + bl > b.length) break;
      this.blocks++;
      if (bt === 0x00000001) {
        this.linkTypes.push(b.readUInt16LE(off + 8));
      } else if (bt === 0x00000006) {
        const ifId = b.readUInt32LE(off + 8);
        const cap = b.readUInt32LE(off + 20);
        const p = off + 28;
        const link = this.linkTypes[ifId] ?? 1;
        let pl;
        let plen;
        if (link === 1) { // Ethernet
          let eth = 14;
          let etype = b.readUInt16BE(p + 12);
          if (etype === 0x8100) { eth = 18; etype = b.readUInt16BE(p + 16); } // VLAN
          if (etype !== 0x0800) { off += bl; continue; }
          const ihl = (b[p + eth] & 0x0f) * 4;
          if (b[p + eth + 9] !== 17) { off += bl; continue; } // UDP only
          const udpLen = b.readUInt16BE(p + eth + ihl + 4);
          pl = p + eth + ihl + 8;
          plen = Math.min(udpLen - 8, cap - (eth + ihl + 8));
        } else if (link === 101) { // raw IPv4
          const ihl = (b[p] & 0x0f) * 4;
          pl = p + ihl + 8;
          plen = cap - ihl - 8;
        } else {
          off += bl; continue;
        }
        this.packets++;
        if (plen > 0) this.onPayload(b, pl, plen);
      }
      off += bl;
    }
    this.left = off < b.length ? Buffer.from(b.subarray(off)) : null;
  }
}

/**
 * Resumable HTTP byte stream: on a network error, reissues the request with a Range header starting at the
 * number of bytes already received and keeps feeding the same decompressor. Yields Buffers.
 */
export async function* resumableHttpBytes(url, { maxRetries = 8, onRetry, onResponse } = {}) {
  let received = 0;
  let attempt = 0;
  for (;;) {
    try {
      const headers = received > 0 ? { Range: `bytes=${received}-` } : {};
      const res = await fetch(url, { headers });
      if (received > 0 && res.status !== 206) throw new Error(`resume failed: HTTP ${res.status}`);
      if (received === 0 && res.status !== 200) throw new Error(`HTTP ${res.status}`);
      onResponse?.({ status: res.status, headers: res.headers, resumed: received > 0 });
      for await (const chunk of Readable.fromWeb(res.body)) {
        received += chunk.length;
        yield chunk;
      }
      return;
    } catch (e) {
      if (++attempt > maxRetries) throw e;
      onRetry?.({ attempt, received, error: String(e.message || e) });
      await new Promise((r) => setTimeout(r, Math.min(30000, 1000 * 2 ** attempt)));
    }
  }
}

export async function lookupHistLink(dateCompact) {
  const res = await fetch(`https://iextrading.com/api/1.0/hist?date=${dateCompact}`);
  if (!res.ok) throw new Error(`IEX HIST index HTTP ${res.status}`);
  const arr = await res.json();
  const f = Array.isArray(arr) ? arr.find((x) => x.feed === 'TOPS') : null;
  if (!f) throw new Error(`No TOPS file listed by IEX for ${dateCompact}`);
  return f;
}

const INSERT_M1 = `INSERT OR REPLACE INTO m1 (ds, sym, t, o, h, l, c, v, n, pv, bv, sv, xv, ev, ov, bid, ask, bsz, asz, qts,
  min_bid, max_bid, min_ask, max_ask, max_spr, nq, unavail, halted, qsess)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

/**
 * Ingest one IEX TOPS trading day into the database.
 * @param {object} o
 * @param {import('node:sqlite').DatabaseSync} o.db
 * @param {string} o.date  YYYY-MM-DD
 * @param {string} [o.url] provider URL (looked up from the IEX HIST index if omitted and no file given)
 * @param {string} [o.file] local .pcap.gz path instead of downloading
 * @param {number} [o.expectedBytes]
 * @param {boolean} [o.allowPartial] accept a truncated stream (test/sample use); dataset status becomes 'partial'
 * @param {(p:object)=>void} [o.onProgress]
 */
export async function ingestIexTops({ db, date, url, file, expectedBytes, allowPartial = false, onProgress }) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('date must be YYYY-MM-DD');
  const ds = `iex-tops-${date}${allowPartial ? '-partial' : ''}`;
  const compact = date.replaceAll('-', '');
  let link = url;
  let histEntry = null;
  if (!file && !link) {
    const f = await lookupHistLink(compact);
    histEntry = { date: f.date ?? null, feed: f.feed ?? null, version: f.version ?? null, protocol: f.protocol ?? null, size: f.size ?? null, link: f.link ?? null };
    link = f.link;
    expectedBytes = expectedBytes ?? Number(f.size);
  }
  let httpMeta = null;
  const startedWall = Date.now();
  const hash = crypto.createHash('sha256');
  let compressedBytes = 0;
  let retries = [];

  db.prepare('DELETE FROM m1 WHERE ds = ?').run(ds);
  db.prepare('DELETE FROM status_events WHERE ds = ?').run(ds);
  db.prepare('DELETE FROM ingest_symbol_stats WHERE ds = ?').run(ds);
  db.prepare('DELETE FROM datasets WHERE id = ?').run(ds);

  const ins = db.prepare(INSERT_M1);
  let rowsWritten = 0;
  const emitRows = (rows) => {
    tx(db, () => { for (const r of rows) ins.run(ds, ...r); });
    rowsWritten += rows.length;
  };
  const agg = new TopsAggregator({ emitRows });
  const reader = new PcapNgReader((b, off, len) => agg.onSegment(b, off, len));

  const source = file
    ? fs.createReadStream(file, { highWaterMark: 1 << 20 })
    : Readable.from(resumableHttpBytes(link, {
      onRetry: (r) => { retries.push(r); onProgress?.({ phase: 'retry', ...r }); },
      onResponse: (r) => {
        if (httpMeta) return;
        httpMeta = { status: r.status, lastModified: r.headers.get('last-modified'), etag: r.headers.get('etag'), contentLength: r.headers.get('content-length') };
      },
    }));
  const gunzip = zlib.createGunzip({ chunkSize: 1 << 20 });
  let truncated = false;
  let streamError = null;

  const tap = async function* (src) {
    for await (const chunk of src) {
      hash.update(chunk);
      compressedBytes += chunk.length;
      yield chunk;
    }
  };
  const compressed = Readable.from(tap(source));
  compressed.on('error', (e) => gunzip.destroy(e));
  compressed.pipe(gunzip);

  let lastReport = 0;
  try {
    for await (const chunk of gunzip) {
      reader.push(chunk);
      const now = Date.now();
      if (now - lastReport > 5000) {
        lastReport = now;
        onProgress?.({
          phase: 'stream', compressedBytes, expectedBytes, rowsWritten, packets: reader.packets,
          exchangeTime: agg.lastMsgMs, mbps: compressedBytes / 1e6 / ((now - startedWall) / 1000),
          symbols: agg.byKey.size + agg.byStr.size,
        });
      }
    }
  } catch (e) {
    if (allowPartial && /unexpected end of file|premature/i.test(String(e.message))) truncated = true;
    else streamError = e;
  }
  if (streamError) {
    db.prepare(`INSERT INTO datasets (id, kind, provider, venue_coverage, entitlement, source_url, trade_date, ingested_at, status, quality_json, attribution, notes, bytes, expected_bytes)
      VALUES (?, 'market_ticks', ?, ?, ?, ?, ?, ?, 'failed', ?, ?, ?, ?, ?)`).run(
      ds, 'IEX Exchange HIST — TOPS 1.6', IEX_COVERAGE, 'Free; IEX Historical Data Terms of Use; attribution required', link || file || null, date,
      Date.now(), JSON.stringify({ error: String(streamError.message || streamError), retries }), IEX_ATTRIBUTION, 'Ingestion failed; no rows retained.', compressedBytes, expectedBytes ?? null);
    db.prepare('DELETE FROM m1 WHERE ds = ?').run(ds);
    throw streamError;
  }
  if (!file && !allowPartial && expectedBytes && compressedBytes !== expectedBytes) {
    truncated = true;
  }
  agg.finish();

  // ---- decide what to keep (storage filter only; never exposed to as-of logic) ----
  const largeCaps = new Set(largeCapList());
  const benches = new Set(BENCHMARKS);
  const keep = new Map();
  const stats = [];
  for (const s of agg.allStates()) {
    let reason = null;
    const isTest = s.isTest || KNOWN_TEST_SYMBOLS.has(s.sym);
    if (!isTest) {
      if (largeCaps.has(s.sym)) reason = 'largecap_reference_list';
      else if (benches.has(s.sym)) reason = 'benchmark_etf';
      else if (s.minPx !== Infinity && s.minPx < STORAGE_MAX_PRICE_U) reason = 'observed_price_below_storage_threshold';
    }
    if (reason) keep.set(s.sym, reason);
    stats.push([s.sym, s.firstTs, s.lastTs, s.minPx === Infinity ? null : s.minPx, s.maxPx === -Infinity ? null : s.maxPx,
      s.trades, s.volume, s.quotes, isTest ? 'excluded_test_symbol' : reason]);
  }
  tx(db, () => {
    const insS = db.prepare(`INSERT OR REPLACE INTO ingest_symbol_stats (ds, sym, first_ts, last_ts, min_px, max_px, trades, volume, quotes, stored_reason)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const r of stats) insS.run(ds, ...r);
    db.exec('CREATE TEMP TABLE IF NOT EXISTS keep_syms (sym TEXT PRIMARY KEY)');
    db.exec('DELETE FROM keep_syms');
    const insK = db.prepare('INSERT INTO keep_syms (sym) VALUES (?)');
    for (const sym of keep.keys()) insK.run(sym);
    db.prepare('DELETE FROM m1 WHERE ds = ? AND sym NOT IN (SELECT sym FROM keep_syms)').run(ds);
    const insE = db.prepare('INSERT INTO status_events (ds, sym, ts, kind, code, reason) VALUES (?, ?, ?, ?, ?, ?)');
    for (const e of agg.status) if (keep.has(e[0])) insE.run(ds, ...e);
  });

  const sysTimes = Object.fromEntries(agg.systemEvents.map((e) => [e.event, e.ts]));
  const status = truncated || !('C' in sysTimes) ? 'partial' : 'complete';
  // Partial day: the minute containing the last received message was cut part-way through, and nothing after it was
  // observed. Coverage ends at that minute's start; rows from it on are flagged unavailable (never a complete aggregate).
  const lastMs = Math.max(agg.lastMsgMs ?? -Infinity, agg.lastSend ?? -Infinity);
  const coverageEnd = status === 'partial' ? (Number.isFinite(lastMs) ? lastMs - (lastMs % MINUTE) : null) : null;
  let rowsAfterCoverage = 0;
  if (status === 'partial' && coverageEnd !== null) {
    rowsAfterCoverage = Number(db.prepare('UPDATE m1 SET unavail = 1 WHERE ds = ? AND t >= ?').run(ds, coverageEnd).changes);
  }
  const kept = db.prepare('SELECT COUNT(*) n, MIN(t) t0, MAX(t) t1 FROM m1 WHERE ds = ?').get(ds);
  // Publication time: the HIST file's HTTP Last-Modified (when the provider last wrote the file), else unknown.
  const lmMs = httpMeta?.lastModified ? Date.parse(httpMeta.lastModified) : NaN;
  const publishedAt = Number.isFinite(lmMs) ? lmMs : null;
  const quality = {
    messages_by_type: agg.counts,
    pcap_blocks: reader.blocks, packets: reader.packets, iex_tp_segments: agg.segments,
    sequence_gaps: agg.seqGaps.length, sequence_gap_samples: agg.seqGaps.slice(0, 20),
    trade_breaks: {
      seen: agg.tradeBreaks, applied_same_minute: agg.breaksApplied, recorded_unapplied: agg.breaksUnapplied, unmatched_trade_id: agg.breaksUnmatched,
      note: 'Same-minute breaks are removed from that minute\'s aggregates; later breaks are stored as status_events kind trade_break and applied from the break time on by marketdata.js.',
    },
    first_send_ms: agg.firstSend, last_send_ms: agg.lastSend,
    system_events: sysTimes,  // O=start msgs, S=start system hrs, R=start regular mkt, M=end regular mkt, E=end system hrs, C=end msgs
    symbols_seen: agg.byKey.size + agg.byStr.size, symbols_stored: keep.size,
    rows_written_before_filter: rowsWritten, rows_retained: kept.n,
    compressed_bytes: compressedBytes, expected_bytes: expectedBytes ?? null,
    bytes_match_index: expectedBytes ? compressedBytes === expectedBytes : null,
    truncated, retries,
    ended_with_C_event: 'C' in sysTimes,
    coverage_end_ms: coverageEnd, rows_flagged_after_coverage_end: rowsAfterCoverage,
    coverage_end_basis: status === 'partial' ? 'start of the minute containing the last received message (that minute and later were not fully observed)' : null,
    publication: {
      published_at: publishedAt,
      basis: publishedAt !== null ? 'HTTP Last-Modified of the HIST file at download' : file ? 'local file: provider publication time unknown' : 'no Last-Modified header: provider publication time unknown',
      http: httpMeta, hist_index_entry: histEntry,
    },
    wall_seconds: Math.round((Date.now() - startedWall) / 1000),
  };
  db.prepare(`INSERT INTO datasets (id, kind, provider, venue_coverage, entitlement, source_url, source_id, trade_date, event_time_start,
      event_time_end, published_at, ingested_at, latency_note, adjustments, sha256, bytes, expected_bytes, status, quality_json, attribution, notes)
    VALUES (?, 'market_ticks', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    ds, 'IEX Exchange HIST — TOPS 1.6 (IEX-TP v1)', IEX_COVERAGE,
    'Free historical data under the IEX Historical Data Terms of Use; attribution required; reference use only',
    link || `file:${file}`, `TOPS1.6/${compact}`, date, kept.t0 ?? null, kept.t1 != null ? kept.t1 + MINUTE : null, publishedAt, Date.now(),
    'Historical file published by IEX after the trading day; replayed with as-of gating (no live latency).',
    'Raw unadjusted exchange prices (no split/dividend adjustment). Corporate actions on the replay day are not adjusted.',
    hash.digest('hex'), compressedBytes, expectedBytes ?? null, status, JSON.stringify(quality), IEX_ATTRIBUTION,
    `Stored symbols: price < $${STORAGE_MAX_PRICE_U / 1e4} observed at any time (storage superset), large-cap reference list, benchmark ETFs. `
      + 'As-of reads reveal a stored symbol only from its first sub-threshold observation (server/data/marketdata.js symbolVisibleAsOf).');
  return { ds, status, quality };
}
