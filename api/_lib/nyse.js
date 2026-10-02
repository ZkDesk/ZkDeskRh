// NYSE regular session: weekdays 09:30-16:00 America/New_York, closed on exchange holidays, 13:00
// close on early-close days. Holidays and early closes follow the NYSE rules (Rule 7.2), so no yearly
// data file is needed; unscheduled closures (national days of mourning, emergencies) go in CLOSED.
// Feeds Marker.setMarketOpen (api/cron/tick.js), which sets the desk's epoch interval, liquidation
// price band and off-hours floor: a holiday counts as off-hours, the conservative setting.

const OPEN = 9 * 60 + 30;
const CLOSE = 16 * 60;
const EARLY_CLOSE = 13 * 60;
/** Unscheduled full-day closures, 'YYYY-MM-DD' (New York date). */
export const CLOSED = new Set([]);

const iso = (y, m, d) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
const weekday = (y, m, d) => new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0 Sunday … 6 Saturday
/** The n-th (1-based) given weekday of a month; n = -1 for the last. */
function nth(y, m, wd, n) {
  if (n > 0) return 1 + ((wd - weekday(y, m, 1) + 7) % 7) + (n - 1) * 7;
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return last - ((weekday(y, m, last) - wd + 7) % 7);
}
/** Easter Sunday (Gregorian, anonymous algorithm). */
function easter(y) {
  const a = y % 19, b = Math.floor(y / 100), c = y % 100, d = Math.floor(b / 4), e = b % 4;
  const f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  return [month, ((h + l - 7 * m + 114) % 31) + 1];
}
/** A fixed-date holiday on a weekend moves to Friday (Saturday) or Monday (Sunday). */
function observed(y, m, d) {
  const wd = weekday(y, m, d);
  const t = new Date(Date.UTC(y, m - 1, d + (wd === 6 ? -1 : wd === 0 ? 1 : 0)));
  return iso(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
}

/** New Year's Day: a Sunday one moves to Monday; a Saturday one is not observed (NYSE rule). */
function newYear(y) {
  const wd = weekday(y, 1, 1);
  return wd === 6 ? [] : [iso(y, 1, wd === 0 ? 2 : 1)];
}

const cache = new Map();
/** {holidays: Set, earlyCloses: Set} of 'YYYY-MM-DD' for a year. */
export function calendar(y) {
  if (cache.has(y)) return cache.get(y);
  const [em, ed] = easter(y);
  const goodFriday = new Date(Date.UTC(y, em - 1, ed - 2));
  const thanksgiving = nth(y, 11, 4, 4);
  const holidays = new Set([
    ...newYear(y),
    iso(y, 1, nth(y, 1, 1, 3)), // Martin Luther King Jr. Day
    iso(y, 2, nth(y, 2, 1, 3)), // Washington's Birthday
    iso(y, goodFriday.getUTCMonth() + 1, goodFriday.getUTCDate()),
    iso(y, 5, nth(y, 5, 1, -1)), // Memorial Day
    ...(y >= 2022 ? [observed(y, 6, 19)] : []), // Juneteenth
    observed(y, 7, 4),
    iso(y, 9, nth(y, 9, 1, 1)), // Labor Day
    iso(y, 11, thanksgiving),
    observed(y, 12, 25),
  ].filter((day) => day.startsWith(`${y}-`)));
  const weekdayNotHoliday = (m, d) => ![0, 6].includes(weekday(y, m, d)) && !holidays.has(iso(y, m, d));
  const earlyCloses = new Set([
    iso(y, 11, thanksgiving + 1), // day after Thanksgiving
    ...(weekdayNotHoliday(12, 24) ? [iso(y, 12, 24)] : []), // Christmas Eve
    ...(weekdayNotHoliday(7, 3) ? [iso(y, 7, 3)] : []), // the day before Independence Day
  ]);
  const out = { holidays, earlyCloses };
  cache.set(y, out);
  return out;
}

/** True while the NYSE regular session is open at `date`. */
export function marketOpenAt(date = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(date).map((x) => [x.type, x.value]));
  if (['Sat', 'Sun'].includes(p.weekday)) return false;
  const day = `${p.year}-${p.month}-${p.day}`;
  const { holidays, earlyCloses } = calendar(Number(p.year));
  if (holidays.has(day) || CLOSED.has(day)) return false;
  const minutes = Number(p.hour) * 60 + Number(p.minute);
  return minutes >= OPEN && minutes < (earlyCloses.has(day) ? EARLY_CLOSE : CLOSE);
}
