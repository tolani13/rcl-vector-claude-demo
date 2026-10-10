// TEST FIXTURE — NOT MARKET DATA. IEX TOPS 1.6 ingestion over a tiny SYNTHETIC pcapng built in this file: invented
// symbols, prices, sizes and trade ids, framed exactly like the HIST format (pcapng -> raw IPv4/UDP -> IEX-TP -> TOPS).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { ingestIexTops } from '../../server/data/ingest/iex-tops.js';
import { tradeBreaksAsOf, fillMinute, windowAggregatesAsOf, coverageEndMs, barsAsOf } from '../../server/data/marketdata.js';
import { etToUtc, MINUTE } from '../../server/util/time.js';
import { tempDb, stubServer } from './helpers.js';

const DATE = '2026-10-07';
const at = (h, m, s = 0) => etToUtc(DATE, h, m, s);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// ---- synthetic TOPS 1.6 writer (layouts per the IEX TOPS 1.6 specification) ----
const sym8 = (s) => Buffer.from(s.padEnd(8, ' '), 'latin1');
function base(type, flags, ms, sym, len) {
  const b = Buffer.alloc(len);
  b[0] = type.charCodeAt(0); b[1] = flags;
  b.writeBigUInt64LE(BigInt(ms) * 1_000_000n, 2);
  if (sym) sym8(sym).copy(b, 10);
  return b;
}
const quote = (ms, sym, bid, ask, size = 1000) => { const b = base('Q', 0, ms, sym, 42); b.writeUInt32LE(size, 18); b.writeBigInt64LE(BigInt(bid), 22); b.writeBigInt64LE(BigInt(ask), 30); b.writeUInt32LE(size, 38); return b; };
const trade = (type, ms, sym, px, size, id) => { const b = base(type, 0, ms, sym, 38); b.writeUInt32LE(size, 18); b.writeBigInt64LE(BigInt(px), 22); b.writeBigUInt64LE(BigInt(id), 30); return b; };
const system = (ms, ev) => base('S', ev.charCodeAt(0), ms, null, 10);

function segment(msgs, seq, sendMs) {
  const body = Buffer.concat(msgs.flatMap((m) => { const l = Buffer.alloc(2); l.writeUInt16LE(m.length); return [l, m]; }));
  const h = Buffer.alloc(40);
  h[0] = 1; h.writeUInt16LE(0x8003, 2); h.writeUInt16LE(body.length, 12); h.writeUInt16LE(msgs.length, 14);
  h.writeBigUInt64LE(BigInt(seq), 24); h.writeBigUInt64LE(BigInt(sendMs) * 1_000_000n, 32);
  return Buffer.concat([h, body]);
}
function block(type, body) {
  const pad = (4 - (body.length % 4)) % 4;
  const len = 12 + body.length + pad;
  const b = Buffer.alloc(len);
  b.writeUInt32LE(type, 0); b.writeUInt32LE(len, 4); body.copy(b, 8); b.writeUInt32LE(len, len - 4);
  return b;
}
/** gzip(pcapng) with one raw-IPv4 interface and one packet per segment. segments: [{msgs, sendMs}] */
function buildPcapGz(segments) {
  const shb = Buffer.alloc(16); shb.writeUInt32LE(0x1a2b3c4d, 0); shb.writeUInt16LE(1, 4); shb.writeBigInt64LE(-1n, 8);
  const idb = Buffer.alloc(8); idb.writeUInt16LE(101, 0); idb.writeUInt32LE(65535, 4);
  const parts = [block(0x0a0d0d0a, shb), block(1, idb)];
  let seq = 1;
  for (const s of segments) {
    const seg = segment(s.msgs, seq, s.sendMs);
    seq += s.msgs.length;
    const ip = Buffer.alloc(20); ip[0] = 0x45; ip[9] = 17;
    const udp = Buffer.alloc(8); udp.writeUInt16BE(8 + seg.length, 4);
    const data = Buffer.concat([ip, udp, seg]);
    const epb = Buffer.alloc(20); epb.writeUInt32LE(0, 0); epb.writeUInt32LE(data.length, 12); epb.writeUInt32LE(data.length, 16);
    parts.push(block(6, Buffer.concat([epb, data])));
  }
  return zlib.gzipSync(Buffer.concat(parts));
}

// Invented tape: TFIXA (< $5, stored) with one same-minute and one later-minute trade break; TFIXH ($10, not stored).
function tape({ withEndEvent }) {
  const segs = [
    { sendMs: at(9, 30, 1), msgs: [system(at(9, 30, 0), 'R'), quote(at(9, 30, 5), 'TFIXA', 4900, 5100), quote(at(9, 30, 5), 'TFIXH', 99_900, 100_100)] },
    { sendMs: at(9, 30, 20), msgs: [trade('T', at(9, 30, 10), 'TFIXA', 5000, 100, 1), trade('T', at(9, 30, 20), 'TFIXA', 1000, 5000, 2), trade('T', at(9, 30, 20), 'TFIXH', 100_000, 10, 3)] },
    { sendMs: at(9, 30, 40), msgs: [trade('B', at(9, 30, 40), 'TFIXA', 1000, 5000, 2)] },                 // same minute: removed
    { sendMs: at(9, 31, 50), msgs: [trade('T', at(9, 31, 10), 'TFIXA', 5200, 200, 4), trade('T', at(9, 31, 50), 'TFIXA', 2000, 300, 5)] },
    { sendMs: at(9, 32, 15), msgs: [trade('B', at(9, 32, 15), 'TFIXA', 2000, 300, 5)] },                  // later minute: recorded
    { sendMs: at(9, 32, 30), msgs: [trade('T', at(9, 32, 30), 'TFIXA', 5100, 100, 6)] },
  ];
  if (withEndEvent) segs.push({ sendMs: at(20, 0, 1), msgs: [system(at(20, 0, 0), 'C')] });
  return buildPcapGz(segs);
}

function tmpFile(bytes) {
  const f = path.join(root, 'data', `test-iex-${process.pid}-${crypto.randomBytes(4).toString('hex')}.pcap.gz`);
  fs.writeFileSync(f, bytes);
  return f;
}

test('trade breaks: same-minute breaks leave the aggregates; later breaks are recorded and applied from their break time', async () => {
  const { db, cleanup } = tempDb();
  const file = tmpFile(tape({ withEndEvent: false }));
  try {
    const r = await ingestIexTops({ db, date: DATE, file });
    const ds = r.ds;
    assert.deepEqual(r.quality.trade_breaks.seen, 2);
    assert.equal(r.quality.trade_breaks.applied_same_minute, 1);
    assert.equal(r.quality.trade_breaks.recorded_unapplied, 1);
    assert.equal(r.quality.symbols_stored, 1, 'TFIXH ($10) is not stored');
    const row = (t) => db.prepare('SELECT * FROM m1 WHERE ds = ? AND sym = ? AND t = ?').get(ds, 'TFIXA', t);
    const m30 = row(at(9, 30));
    assert.deepEqual([m30.o, m30.h, m30.l, m30.c, m30.v, m30.n], [5000, 5000, 5000, 5000, 100, 1], 'broken $0.10 print removed from its own minute');
    assert.equal(m30.xv, 100);
    const m31 = row(at(9, 31));
    assert.deepEqual([m31.l, m31.v, m31.n], [2000, 500, 2], 'a later break cannot be applied retroactively to a row knowable at 09:32');
    const ev = db.prepare("SELECT ts, code, reason FROM status_events WHERE ds = ? AND kind = 'trade_break' ORDER BY ts").all(ds);
    assert.equal(ev.length, 2);
    assert.deepEqual(JSON.parse(ev[1].reason), { px: 2000, size: 300, trade_minute: at(9, 31), applied: false, cls: 's', ext: false, odd: false });

    assert.equal(tradeBreaksAsOf(db, ds, 'TFIXA', at(9, 32)).length, 1);
    const later = tradeBreaksAsOf(db, ds, 'TFIXA', at(9, 32, 15));
    assert.equal(later.length, 2);
    assert.deepEqual([later[1].tradeId, later[1].tradeMinuteT, later[1].appliedToMinute], ['5', at(9, 31), false]);

    // Fill evaluation of the 09:31 minute at 09:32: the break is not yet knowable, so the trade evidence stands.
    assert.equal(fillMinute(db, ds, 'TFIXA', at(9, 31), at(9, 32)).trades.l, 2000);
    // Once the break is knowable the minute's trade extremes are withheld (quote evidence only).
    const fm = fillMinute(db, ds, 'TFIXA', at(9, 31), at(9, 32, 30));
    assert.equal(fm.trades, null);
    assert.equal(fm.tradesWithheld, 'TRADE_BREAK');
    assert.equal(fm.tradeBreaks[0].size, 300);

    // Partial (no 'C' end event): coverage ends at the start of the minute holding the last message (09:32).
    assert.equal(r.status, 'partial');
    assert.equal(r.quality.coverage_end_ms, at(9, 32));
    assert.equal(coverageEndMs(db, ds), at(9, 32));
    assert.equal(row(at(9, 32)).unavail, 1, 'the cut minute is flagged unavailable');
    assert.equal(barsAsOf(db, ds, 'TFIXA', at(9, 40)).at(-1).t, at(9, 31));

    // Signals: volume of the broken 09:31 trade is excluded once the break is knowable.
    const before = windowAggregatesAsOf(db, ds, at(9, 32), { windowMin: 15, sessionOpen: at(9, 30) })[0];
    assert.equal(Number(before.wv), 600);
    const agg = windowAggregatesAsOf(db, ds, at(9, 33), { windowMin: 15, sessionOpen: at(9, 30) })[0];
    assert.equal(Number(agg.wv), 300);
    assert.equal(Number(agg.wsv), 0, 'seller-classified broken volume removed');
    assert.equal(agg.brokenTrades, 1);

    const d = db.prepare('SELECT published_at, quality_json FROM datasets WHERE id = ?').get(ds);
    assert.equal(d.published_at, null, 'local file: provider publication time unknown');
    assert.match(JSON.parse(d.quality_json).publication.basis, /local file/);
  } finally { fs.rmSync(file, { force: true }); cleanup(); }
});

test('download path: publication time from the HIST file Last-Modified; a day ending with C is complete', async () => {
  const bytes = tape({ withEndEvent: true });
  const lastModified = 'Thu, 08 Oct 2026 06:12:00 GMT';
  const srv = await stubServer({ '/hist/tops.pcap.gz': { body: bytes, contentType: 'application/octet-stream', headers: { 'Last-Modified': lastModified } } });
  const { db, cleanup } = tempDb();
  try {
    const r = await ingestIexTops({ db, date: DATE, url: `${srv.url}/hist/tops.pcap.gz`, expectedBytes: bytes.length });
    assert.equal(r.status, 'complete');
    assert.equal(r.quality.coverage_end_ms, null);
    assert.equal(r.quality.bytes_match_index, true);
    const d = db.prepare('SELECT published_at, source_url, quality_json FROM datasets WHERE id = ?').get(r.ds);
    assert.equal(d.published_at, Date.parse(lastModified));
    assert.equal(JSON.parse(d.quality_json).publication.basis, 'HTTP Last-Modified of the HIST file at download');
    assert.equal(db.prepare('SELECT COUNT(*) n FROM m1 WHERE ds = ? AND unavail = 1').get(r.ds).n, 0);
    assert.ok(MINUTE > 0);
  } finally { cleanup(); await srv.close(); }
});
