// node api/nyse.test.mjs — the NYSE session calendar against the exchange's published holidays and
// early closes, and the session boundaries in New York time (both DST offsets).
import assert from 'node:assert/strict';
import { calendar, marketOpenAt } from './_lib/nyse.js';

// NYSE published holiday and early-close calendars.
const published = {
  2025: {
    holidays: ['2025-01-01', '2025-01-20', '2025-02-17', '2025-04-18', '2025-05-26', '2025-06-19', '2025-07-04', '2025-09-01', '2025-11-27', '2025-12-25'],
    early: ['2025-07-03', '2025-11-28', '2025-12-24'],
  },
  2026: {
    holidays: ['2026-01-01', '2026-01-19', '2026-02-16', '2026-04-03', '2026-05-25', '2026-06-19', '2026-07-03', '2026-09-07', '2026-11-26', '2026-12-25'],
    early: ['2026-11-27', '2026-12-24'],
  },
  2027: {
    holidays: ['2027-01-01', '2027-01-18', '2027-02-15', '2027-03-26', '2027-05-31', '2027-06-18', '2027-07-05', '2027-09-06', '2027-11-25', '2027-12-24'],
    early: ['2027-11-26'],
  },
};
for (const [year, { holidays, early }] of Object.entries(published)) {
  const c = calendar(Number(year));
  assert.deepEqual([...c.holidays].sort(), holidays, `${year} holidays`);
  assert.deepEqual([...c.earlyCloses].sort(), early, `${year} early closes`);
}
// A Saturday New Year's Day is not observed on the Friday before (2022, 2028); a Sunday one moves to Monday (2023).
assert.ok(!calendar(2027).holidays.has('2027-12-31'));
assert.ok(!calendar(2028).holidays.has('2028-01-01') && !calendar(2028).holidays.has('2027-12-31'));
assert.ok(calendar(2023).holidays.has('2023-01-02'));
assert.ok(calendar(2028).earlyCloses.has('2028-07-03'), 'Monday before a Tuesday July 4th closes early');

const at = (s) => new Date(s);
// Regular session, winter (UTC-5) and summer (UTC-4).
assert.equal(marketOpenAt(at('2026-01-13T14:29:00Z')), false, '09:29 EST');
assert.equal(marketOpenAt(at('2026-01-13T14:30:00Z')), true, '09:30 EST');
assert.equal(marketOpenAt(at('2026-01-13T20:59:00Z')), true, '15:59 EST');
assert.equal(marketOpenAt(at('2026-01-13T21:00:00Z')), false, '16:00 EST');
assert.equal(marketOpenAt(at('2026-07-14T13:30:00Z')), true, '09:30 EDT');
assert.equal(marketOpenAt(at('2026-07-14T20:00:00Z')), false, '16:00 EDT');
// Weekends and holidays are closed all day.
assert.equal(marketOpenAt(at('2026-10-03T15:00:00Z')), false, 'Saturday');
assert.equal(marketOpenAt(at('2026-11-26T16:00:00Z')), false, 'Thanksgiving');
assert.equal(marketOpenAt(at('2026-07-03T15:00:00Z')), false, 'Independence Day observed on Friday');
assert.equal(marketOpenAt(at('2026-04-03T15:00:00Z')), false, 'Good Friday');
// Early closes end at 13:00.
assert.equal(marketOpenAt(at('2026-11-27T17:59:00Z')), true, '12:59 the day after Thanksgiving');
assert.equal(marketOpenAt(at('2026-11-27T18:00:00Z')), false, '13:00 the day after Thanksgiving');
assert.equal(marketOpenAt(at('2026-12-24T19:00:00Z')), false, '14:00 on Christmas Eve');

console.log('NYSE calendar checks passed: 2025-2027 published holidays and early closes, observance rules, session boundaries in EST and EDT');
