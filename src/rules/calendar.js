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
    if (person.sundayOff === 'every') return true;
    return Array.isArray(person.sundayOff) && person.sundayOff.indexOf(n) !== -1;
  }

  function rosterSundaysInMonth(person, key) {
    var out = [];
    for (var i = 1; i <= daysInMonth(key); i++) {
      var d = key + '-' + (i < 10 ? '0' + i : i);
      if (isRosterOff(person, d)) out.push(d);
    }
    return out;
  }

  function dateRange(from, to) {
    var out = [];
    for (var d = from; d <= to; d = addDays(d, 1)) out.push(d);
    return out;
  }

  var api = { addDays: addDays, weekday: weekday, monthKey: monthKey, daysInMonth: daysInMonth,
    nthSunday: nthSunday, isRosterOff: isRosterOff, rosterSundaysInMonth: rosterSundaysInMonth, dateRange: dateRange };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.GJCalendar = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
