// Macro-series release calendar: the earliest time each stored FRED observation was publicly knowable.
//
// Observation frequency is not release cadence. DCOILWTICO (EIA spot prices) and DTWEXBGS (Fed H.10) have DAILY
// observations but are PUBLISHED WEEKLY, so "observation date + N days" would expose a value days before it was
// released. Each configured series therefore has a release rule (configuration, not observations):
//   H15_NEXT_BUSINESS_DAY  DGS10, DGS2, T10Y2Y: next Federal Reserve business day after the observation (weekends and
//                          federal holidays skipped), 16:30 ET (H.15 daily update is posted ~16:15 ET).
//   H10_WEEKLY_MONDAY      DTWEXBGS: the Monday after the observation's Mon–Fri week (next business day when that Monday
//                          is a federal holiday), 16:30 ET (H.10 is posted ~16:15 ET).
//   EIA_WEEKLY_WEDNESDAY   DCOILWTICO: the first Wednesday strictly after the observation (Thursday when a federal holiday
//                          falls Mon–Wed of that week), knowable at the END of that day ET (next day 00:00 ET).
//   CALENDAR_LAG           everything else: observation date + publication_lag_days, at 00:00 ET.
// These are conservative interim rules; ALFRED first-release dates (realtime_start) are not ingested (see fred.js).
// macroKnowableTs() is never earlier than "observation date (UTC midnight) + stored publication_lag_days", so a consumer
// that still recomputes that legacy formula always gets a time at or before the gate used here.
import { etToUtc } from '../util/time.js';

const DAY = 86_400_000;

const noonUtc = (date) => Date.parse(`${date}T12:00:00Z`);
const ymd = (ms) => new Date(ms).toISOString().slice(0, 10);
export const addDays = (date, n) => ymd(noonUtc(date) + n * DAY);
const dow = (date) => new Date(noonUtc(date)).getUTCDay(); // 0 Sun .. 6 Sat

function nthWeekday(y, month, weekday, n) {
  // n >= 1: nth weekday of the month; n = -1: last one.
  if (n > 0) {
    const first = new Date(Date.UTC(y, month - 1, 1, 12)).getUTCDay();
    return ymd(Date.UTC(y, month - 1, 1 + ((weekday - first + 7) % 7) + (n - 1) * 7, 12));
  }
  const lastDay = new Date(Date.UTC(y, month, 0, 12));
  return ymd(lastDay.getTime() - ((lastDay.getUTCDay() - weekday + 7) % 7) * DAY);
}

function observed(date) {
  const d = dow(date);
  return d === 6 ? addDays(date, -1) : d === 0 ? addDays(date, 1) : date;
}

const holidayCache = new Map();
/** U.S. federal holidays (5 U.S.C. 6103) for a year, as observed dates. Saturday holidays count on the Friday before
 *  (conservative: some agencies still publish that Friday). Juneteenth from 2021. */
export function federalHolidays(year) {
  if (holidayCache.has(year)) return holidayCache.get(year);
  const p = (m, d) => `${year}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  const list = [
    observed(p(1, 1)), nthWeekday(year, 1, 1, 3), nthWeekday(year, 2, 1, 3), nthWeekday(year, 5, 1, -1),
    ...(year >= 2021 ? [observed(p(6, 19))] : []), observed(p(7, 4)), nthWeekday(year, 9, 1, 1), nthWeekday(year, 10, 1, 2),
    observed(p(11, 11)), nthWeekday(year, 11, 4, 4), observed(p(12, 25)),
  ];
  const nextNewYear = observed(`${year + 1}-01-01`);
  if (nextNewYear.startsWith(String(year))) list.push(nextNewYear); // Jan 1 on a Saturday is observed Dec 31
  const set = new Set(list);
  holidayCache.set(year, set);
  return set;
}

export function isFederalHoliday(date) {
  return federalHolidays(Number(date.slice(0, 4))).has(date);
}

export function isBusinessDay(date) {
  const d = dow(date);
  return d !== 0 && d !== 6 && !isFederalHoliday(date);
}

/** First business day strictly after date. */
export function nextBusinessDay(date) {
  let d = addDays(date, 1);
  while (!isBusinessDay(d)) d = addDays(d, 1);
  return d;
}

export const RELEASE_RULES = Object.freeze({
  H15_NEXT_BUSINESS_DAY: 'next Federal Reserve business day after the observation date (weekends and federal holidays skipped), 16:30 ET (H.15 daily update ~16:15 ET)',
  H10_WEEKLY_MONDAY: 'released weekly: the Monday after the observation\'s Mon–Fri week (next business day if that Monday is a federal holiday), 16:30 ET (H.10 ~16:15 ET)',
  EIA_WEEKLY_WEDNESDAY: 'released weekly: the first Wednesday strictly after the observation date (Thursday when a federal holiday falls Mon–Wed of that week), knowable at the end of that day ET',
  CALENDAR_LAG: 'observation date + publication-lag days, at 00:00 ET',
});

/** Release rule per configured series id (configuration). Unknown ids fall back to CALENDAR_LAG. */
export const SERIES_RELEASE_RULE = Object.freeze({
  DGS10: 'H15_NEXT_BUSINESS_DAY', DGS2: 'H15_NEXT_BUSINESS_DAY', T10Y2Y: 'H15_NEXT_BUSINESS_DAY',
  DTWEXBGS: 'H10_WEEKLY_MONDAY', DCOILWTICO: 'EIA_WEEKLY_WEDNESDAY',
});

/** {id, text} describing how an observation of `series` becomes knowable. */
export function macroReleaseRule(series, lagDays = 1) {
  const id = SERIES_RELEASE_RULE[series] || 'CALENDAR_LAG';
  const text = id === 'CALENDAR_LAG' ? `observation date + ${lagDays} publication-lag day(s), at 00:00 ET` : RELEASE_RULES[id];
  return { id, text: `${text}; never earlier than observation date + ${lagDays} day(s) (stored lag)` };
}

function ruleTs(series, date, lagDays) {
  switch (SERIES_RELEASE_RULE[series]) {
    case 'H15_NEXT_BUSINESS_DAY':
      return etToUtc(nextBusinessDay(date), 16, 30);
    case 'H10_WEEKLY_MONDAY': {
      const d = dow(date);
      const friday = addDays(date, d === 6 ? -1 : d === 0 ? 5 : 5 - d);
      let release = addDays(friday, 3);
      while (!isBusinessDay(release)) release = addDays(release, 1);
      return etToUtc(release, 16, 30);
    }
    case 'EIA_WEEKLY_WEDNESDAY': {
      const wed = addDays(date, ((3 - dow(date) + 7) % 7) || 7);
      const holidayWeek = [-2, -1, 0].some((k) => isFederalHoliday(addDays(wed, k)));
      let release = holidayWeek ? addDays(wed, 1) : wed;
      while (!isBusinessDay(release)) release = addDays(release, 1);
      return etToUtc(addDays(release, 1), 0, 0);
    }
    default:
      return etToUtc(addDays(date, lagDays), 0, 0);
  }
}

/**
 * Earliest ms UTC at which the observation (series, YYYY-MM-DD) was publicly knowable under its release rule.
 * @param {string} series  FRED series id
 * @param {string} date    observation date
 * @param {number} [lagDays]  stored macro_series.publication_lag_days (lower bound; CALENDAR_LAG uses it directly)
 */
export function macroKnowableTs(series, date, lagDays = 1) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date))) throw new TypeError(`invalid observation date ${date}`);
  const lag = Number.isFinite(lagDays) ? lagDays : 1;
  return Math.max(ruleTs(series, date, lag), Date.parse(`${date}T00:00:00Z`) + lag * DAY);
}

// ---- vintage (revision) guard -----------------------------------------------------------------------------------
// Stored values are the LATEST vintage at fetch time. For series that are revised after first publication, a replay
// clock far before the fetch could show a value that was revised later. Without ALFRED vintages the honest fallback is
// to withhold those series whenever a revision could fall between the replay clock and the fetch.
export const REVISABLE_SERIES = Object.freeze(new Set(['CPIAUCSL', 'UNRATE', 'FEDFUNDS', 'DTWEXBGS']));
export const VINTAGE_SAFE_GAP_DAYS = 20;

/**
 * @param {string} series
 * @param {number|null} fetchedAt  ms UTC when the stored vintage was fetched (datasets.ingested_at)
 * @param {number} asOf
 * @returns {{status:'LATEST_VINTAGE'|'LATEST_VINTAGE_UNVERIFIED', revisable:boolean, fetchedAt:number|null, withheld:boolean, note:string}}
 */
export function vintageStatus(series, fetchedAt, asOf) {
  const revisable = REVISABLE_SERIES.has(series);
  const base = { revisable, fetchedAt: fetchedAt ?? null };
  if (!revisable) {
    return { ...base, status: 'LATEST_VINTAGE', withheld: false, note: 'Latest vintage at fetch time; this series is not normally revised after first publication.' };
  }
  if (!Number.isFinite(fetchedAt)) {
    return { ...base, status: 'LATEST_VINTAGE_UNVERIFIED', withheld: true, note: 'Fetch time unknown, so a later revision cannot be ruled out; withheld from as-of views.' };
  }
  if (fetchedAt <= asOf) {
    return { ...base, status: 'LATEST_VINTAGE', withheld: false, note: 'Fetched before the as-of time; any revision in the stored values was already published.' };
  }
  const gapDays = (fetchedAt - asOf) / DAY;
  let spansSeasonalRevision = false;
  for (let d = ymd(asOf); gapDays <= VINTAGE_SAFE_GAP_DAYS && d <= ymd(fetchedAt); d = addDays(d, 1)) {
    const m = Number(d.slice(5, 7));
    if (m === 1 || m === 2) { spansSeasonalRevision = true; break; }
  }
  if (gapDays > VINTAGE_SAFE_GAP_DAYS || spansSeasonalRevision) {
    return {
      ...base, status: 'LATEST_VINTAGE_UNVERIFIED', withheld: true,
      note: `Revisable series fetched ${Math.round(gapDays)} day(s) after the as-of time${spansSeasonalRevision ? ' across a January/February seasonal-revision window' : ''}; `
        + 'the stored latest-vintage values may include revisions published after the as-of time (ALFRED vintages not ingested). Withheld from as-of views and evidence packets.',
    };
  }
  return {
    ...base, status: 'LATEST_VINTAGE', withheld: false,
    note: `Revisable series, but fetched only ${Math.round(gapDays * 10) / 10} day(s) after the as-of time (<= ${VINTAGE_SAFE_GAP_DAYS} days, outside the Jan/Feb seasonal-revision window); latest vintage treated as the as-of value.`,
  };
}
