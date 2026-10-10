// Append-only, hash-chained audit journal. Every attempted action, rejection, estimated fill and control
// change goes through append(). The DB triggers forbid UPDATE/DELETE; verifyChain() detects tampering.
import { sha256Hex, stableStringify } from './util/ids.js';

const GENESIS = '0'.repeat(64);

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{session_id?:string|null, ts_sim?:number|null, portfolio_id?:string|null, agent_id?:string|null,
 *          actor:'agent'|'human'|'policy'|'engine'|'system'|'model', type:string, ref_id?:string|null, payload?:object}} e
 * @returns {{seq:number, hash:string}}
 */
export function append(db, e) {
  if (!e || !e.actor || !e.type) throw new Error('journal entry requires actor and type');
  const prev = db.prepare('SELECT hash FROM journal ORDER BY seq DESC LIMIT 1').get();
  const prev_hash = prev ? prev.hash : GENESIS;
  const row = {
    session_id: e.session_id ?? null,
    ts_sim: e.ts_sim ?? null,
    ts_wall: e.ts_wall ?? Date.now(),
    portfolio_id: e.portfolio_id ?? null,
    agent_id: e.agent_id ?? null,
    actor: e.actor,
    type: e.type,
    ref_id: e.ref_id ?? null,
    payload_json: stableStringify(e.payload ?? {}),
  };
  const hash = sha256Hex(prev_hash + stableStringify(row));
  const r = db.prepare(`INSERT INTO journal (session_id, ts_sim, ts_wall, portfolio_id, agent_id, actor, type, ref_id, payload_json, prev_hash, hash)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    row.session_id, row.ts_sim, row.ts_wall, row.portfolio_id, row.agent_id, row.actor, row.type, row.ref_id, row.payload_json, prev_hash, hash);
  return { seq: Number(r.lastInsertRowid), hash };
}

/** Walk the chain from (afterSeq, prevHash). Returns {ok, checked, brokenAt, lastSeq, lastHash}. */
function walk(db, afterSeq, prevHash) {
  let prev = prevHash;
  let checked = 0;
  let lastSeq = afterSeq;
  for (const r of db.prepare('SELECT * FROM journal WHERE seq > ? ORDER BY seq ASC').iterate(afterSeq)) {
    const row = {
      session_id: r.session_id, ts_sim: r.ts_sim, ts_wall: r.ts_wall, portfolio_id: r.portfolio_id, agent_id: r.agent_id,
      actor: r.actor, type: r.type, ref_id: r.ref_id, payload_json: r.payload_json,
    };
    if (r.prev_hash !== prev || sha256Hex(prev + stableStringify(row)) !== r.hash) return { ok: false, checked, brokenAt: r.seq, lastSeq, lastHash: prev };
    prev = r.hash;
    lastSeq = r.seq;
    checked++;
  }
  return { ok: true, checked, brokenAt: null, lastSeq, lastHash: prev };
}

/** Recompute the whole chain. Returns {ok, checked, brokenAt}. */
export function verifyChain(db) {
  const r = walk(db, 0, GENESIS);
  return { ok: r.ok, checked: r.checked, brokenAt: r.brokenAt };
}

/**
 * Verify only the rows appended after a checkpoint {seq, hash, checked} from an earlier successful verification,
 * linking them to the verified prefix. Falls back to a full walk when there is no checkpoint or the checkpoint row no
 * longer carries the recorded hash. Rows before the checkpoint are not re-hashed (the DB triggers forbid UPDATE /
 * DELETE; a full re-verification is available on demand).
 * @returns {{ok:boolean, checked:number, brokenAt:number|null, lastSeq:number, lastHash:string, newlyChecked:number, mode:'full'|'incremental'}}
 */
export function verifyChainFrom(db, checkpoint = null) {
  if (checkpoint && Number.isSafeInteger(checkpoint.seq) && checkpoint.seq > 0) {
    const row = db.prepare('SELECT hash FROM journal WHERE seq = ?').get(checkpoint.seq);
    if (row && row.hash === checkpoint.hash) {
      const r = walk(db, checkpoint.seq, checkpoint.hash);
      return { ...r, checked: checkpoint.checked + r.checked, newlyChecked: r.checked, mode: 'incremental' };
    }
  }
  const r = walk(db, 0, GENESIS);
  return { ...r, newlyChecked: r.checked, mode: 'full' };
}

/**
 * Journal rows, newest first. `visible_at` {session_id, clock} hides rows of OTHER replay sessions whose replay time is
 * after `clock` (a prior run of the same or a later day would otherwise reveal data beyond the current replay clock).
 * `exclude_types` (array of event types) drops those types in SQL, so a page of `limit` rows is not filled with them.
 * Values are bound parameters; callers validate their shape.
 */
export function list(db, { session_id = null, portfolio_id = null, agent_id = null, type = null, exclude_types = null, limit = 200, before = null, visible_at = null } = {}) {
  const where = [];
  const args = [];
  if (session_id) { where.push('session_id = ?'); args.push(session_id); }
  if (visible_at && Number.isFinite(visible_at.clock)) {
    where.push('(session_id IS ? OR ts_sim IS NULL OR ts_sim <= ?)');
    args.push(visible_at.session_id ?? null, visible_at.clock);
  }
  if (portfolio_id) { where.push('portfolio_id = ?'); args.push(portfolio_id); }
  if (agent_id) { where.push('agent_id = ?'); args.push(agent_id); }
  if (type) { where.push('type = ?'); args.push(type); }
  if (Array.isArray(exclude_types) && exclude_types.length) {
    where.push(`type NOT IN (${exclude_types.map(() => '?').join(', ')})`);
    args.push(...exclude_types.map(String));
  }
  if (before) { where.push('seq < ?'); args.push(before); }
  const sql = `SELECT * FROM journal ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY seq DESC LIMIT ?`;
  args.push(Math.min(Math.max(1, limit | 0), 1000));
  return db.prepare(sql).all(...args).map((r) => ({ ...r, payload: JSON.parse(r.payload_json) }));
}
