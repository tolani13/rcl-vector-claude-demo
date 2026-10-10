// Fixed-point money. 1 u = 1e-4 USD (IEX native price precision). All arithmetic on integers.
export const U_PER_USD = 10000;

export function usdToU(usd) {
  if (typeof usd !== 'number' || !Number.isFinite(usd)) throw new TypeError('usd must be a finite number');
  return Math.round(usd * U_PER_USD);
}

export function uToUsd(u) {
  return u / U_PER_USD;
}

export function fmtUsd(u, { sign = false } = {}) {
  if (u === null || u === undefined) return '—';
  const usd = u / U_PER_USD;
  const abs = Math.abs(usd);
  const digits = abs !== 0 && abs < 1 ? 4 : 2;
  const s = abs.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
  const pre = usd < 0 ? '-' : sign && usd > 0 ? '+' : '';
  return `${pre}$${s}`;
}

/** Multiply a price in u by a share/contract quantity -> total u (exact integer). */
export function notional(priceU, qty, multiplier = 1) {
  return priceU * qty * multiplier;
}

/** Apply basis points to a price, rounding AGAINST the trader (conservative). side: 'buy' rounds up, 'sell' rounds down. */
export function applyBps(priceU, bps, side) {
  const raw = priceU * (1 + (side === 'buy' ? bps : -bps) / 10000);
  return side === 'buy' ? Math.ceil(raw) : Math.floor(raw);
}

/**
 * Reg NMS Rule 612 minimum quoting increment: prices >= $1.00 must be in $0.01 (100 u) increments,
 * prices < $1.00 may use $0.0001 (1 u). Returns true if priceU is a valid order price.
 */
export function isValidTick(priceU) {
  if (!Number.isInteger(priceU) || priceU <= 0) return false;
  return priceU >= U_PER_USD ? priceU % 100 === 0 : true;
}

/** Round a price to a valid tick in the conservative direction for the given side. */
export function roundToTick(priceU, side) {
  if (priceU < U_PER_USD) return side === 'buy' ? Math.ceil(priceU) : Math.floor(priceU);
  return side === 'buy' ? Math.ceil(priceU / 100) * 100 : Math.floor(priceU / 100) * 100;
}
