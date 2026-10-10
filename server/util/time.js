// Time helpers. Storage is ms UTC; U.S. equity session logic uses America/New_York.
export const MINUTE = 60_000;
export const ET = 'America/New_York';

const partsFmt = new Intl.DateTimeFormat('en-US', {
  timeZone: ET, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit',
});

/** Wall-clock parts in New York for a UTC ms timestamp. */
export function etParts(ms) {
  const p = Object.fromEntries(partsFmt.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return { y: +p.year, mo: +p.month, d: +p.day, h: +p.hour, mi: +p.minute, s: +p.second };
}

/** Minutes after midnight, New York time. */
export function etMinuteOfDay(ms) {
  const p = etParts(ms);
  return p.h * 60 + p.mi;
}

/** UTC ms for a New York wall-clock time on a YYYY-MM-DD date (handles EST/EDT). */
export function etToUtc(dateStr, hh, mm = 0, ss = 0) {
  const [y, mo, d] = dateStr.split('-').map(Number);
  // Start from a UTC guess, then correct by the observed New York offset (two passes cover DST edges).
  let guess = Date.UTC(y, mo - 1, d, hh, mm, ss);
  for (let i = 0; i < 2; i++) {
    const p = etParts(guess);
    const asUtc = Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s);
    guess += Date.UTC(y, mo - 1, d, hh, mm, ss) - asUtc;
  }
  return guess;
}

export function fmtEt(ms, { seconds = false, date = false } = {}) {
  if (ms === null || ms === undefined) return '—';
  const p = etParts(ms);
  const pad = (n) => String(n).padStart(2, '0');
  const time = `${pad(p.h)}:${pad(p.mi)}${seconds ? ':' + pad(p.s) : ''}`;
  return date ? `${p.y}-${pad(p.mo)}-${pad(p.d)} ${time} ET` : `${time} ET`;
}

/** Regular U.S. equity session 09:30–16:00 ET (early closes are not modelled; see docs/LIMITATIONS.md). */
export function isRegularSession(ms) {
  const m = etMinuteOfDay(ms);
  return m >= 9 * 60 + 30 && m < 16 * 60;
}

export function floorMinute(ms) {
  return Math.floor(ms / MINUTE) * MINUTE;
}
