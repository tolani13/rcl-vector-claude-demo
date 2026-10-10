import crypto from 'node:crypto';

/** Random, sortable-enough id: prefix + base36 time + random. */
export function newId(prefix) {
  return `${prefix}_${Date.now().toString(36)}${crypto.randomBytes(5).toString('hex')}`;
}

export function sha256Hex(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

/** Deterministic JSON (sorted keys) so hashes of objects are stable. */
export function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}
