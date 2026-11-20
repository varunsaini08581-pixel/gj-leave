/**
 * Date helpers. Dates are 'YYYY-MM-DD' strings in shop time (Asia/Kolkata).
 * All maths is done in UTC on the date parts, so no timezone or DST drift.
 */
(function (root) {
  'use strict';

  function parts(d) { var a = d.split('-'); return { y: +a[0], m: +a[1], d: +a[2] }; }
  function toUTC(d) { var p = parts(d); return Date.UTC(p.y, p.m - 1, p.d); }
  function fmt(ms) { return new Date(ms).toISOString().slice(0, 10); }
  function addDays(d, n) { return fmt(toUTC(d) + n * 86400000); }
  function weekday(d) { return new Date(toUTC(d)).getUTCDay(); } // 0 = Sunday
  function monthKey(d) { return d.slice(0, 7); }
  function daysInMonth(key) { var a = key.split('-'); return new Date(Date.UTC(+a[0], +a[1], 0)).getUTCDate(); }

  /** 1..5 when the date is the nth Sunday of its month, else 0. */
  function nthSunday(d) {
    if (weekday(d) !== 0) return 0;
    return Math.floor((parts(d).d - 1) / 7) + 1;
  }

  /** person.sundayOff: 'every' | [1,2] | [3,4] | [] . A 5th Sunday is working for all except 'every'. */
  function isRosterOff(person, d) {
    var n = nthSunday(d);
    if (!n) return false;
    var off = asOn(person, d).sundayOff;
    if (off === 'every') return true;
    return Array.isArray(off) && off.indexOf(n) !== -1;
  }
  /**
   * A person's Sunday roster and active state as they were on a day. person.history holds what was
   * true "until" a date whenever Settings changed it: [{ until, sundayOff, active }], oldest first.
   * A change in Settings therefore never re-judges days that are already gone.
   */
  function asOn(person, d) {
    var h = person && person.history;
    if (Array.isArray(h)) for (var i = 0; i < h.length; i++) if (h[i] && d <= h[i].until) return h[i];
    return person || {};
  }
  function wasActive(person, d) { return asOn(person, d).active !== false; }

  function rosterSundaysInMonth(person, key) {
    var out = [];
    for (var i = 1; i <= daysInMonth(key); i++) {
      var d = key + '-' + (i < 10 ? '0' + i : i);
      if (isRosterOff(person, d)) out.push(d);
    }
    return out;
  }

  /** A real calendar date in YYYY-MM-DD form ('2026-11-31' and free text are refused). */
  function isDate(d) {
    if (typeof d !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(d)) return false;
    var p = parts(d);
    if (p.y < 2020 || p.y > 2100 || p.m < 1 || p.m > 12 || p.d < 1) return false;
    return fmt(Date.UTC(p.y, p.m - 1, p.d)) === d;
  }
  function isTime(t) { return typeof t === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(t); }

  function dateRange(from, to) {
    var out = [];
    for (var d = from; d <= to; d = addDays(d, 1)) out.push(d);
    return out;
  }

  var api = { asOn: asOn, wasActive: wasActive, isDate: isDate, isTime: isTime, addDays: addDays, weekday: weekday, monthKey: monthKey, daysInMonth: daysInMonth,
    nthSunday: nthSunday, isRosterOff: isRosterOff, rosterSundaysInMonth: rosterSundaysInMonth, dateRange: dateRange };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.GJCalendar = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
