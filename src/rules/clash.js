/**
 * Clash rules (handoff Part 3.3). Hard rules: a clashing request cannot be sent.
 *
 * Owner decision, 20 Nov 2026: clashes are counted PER DAY. If one person is away for
 * any part of a day (full day, half day, late, early, going out, roster Sunday), the
 * other person in the rule cannot be away on that day at all, even at a different time.
 *
 * Rules are data (the Rules sheet). The owner can edit or switch them in Settings.
 */
(function (root) {
  'use strict';
  var Cal = (typeof require !== 'undefined') ? require('./calendar.js') : root.GJCalendar;

  var DEFAULT_RULES = [
    { id: 'C1', on: true, label: 'Sales', members: ['Neha', 'Vikas', 'Harsh'], minPresent: 2,
      rosterSundayException: [1, 2],               // C1-Sun: roster alone may leave only Neha
      emergencyIfAllPresent: ['Bhawna', 'Pooja'] }, // C1-E: 2 of Sales away only if both are present
    { id: 'C2', on: true, label: 'Calls', members: ['Bhawna', 'Pooja'], minPresent: 1 },
    { id: 'C3', on: true, label: 'Repairing', members: ['Raunak', 'Manish'], minPresent: 1 },
    { id: 'C4', on: true, label: 'Repair pool', members: ['Raunak', 'Manish', 'Muskan'], minPresent: 2 }
  ];

  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function niceDate(d) { return (+d.slice(8)) + ' ' + MONTHS[+d.slice(5, 7) - 1]; }

  /**
   * Who is away on a date.
   * people: { name: { sundayOff, noClash } }
   * away:   [{ person, date }]  - APPROVED away entries only (pending requests block no one).
   * Returns { name: 'roster' | 'request' }
   */
  function awayOn(date, people, away) {
    var out = {};
    Object.keys(people).forEach(function (name) {
      if (Cal.isRosterOff(people[name], date)) out[name] = 'roster';
    });
    (away || []).forEach(function (a) {
      if (a.date === date && !out[a.person]) out[a.person] = 'request';
    });
    return out;
  }

  /** Is a rule broken on a date, given who is away? Used for requests and for later re-checks. */
  function ruleBroken(rule, date, awayMap) {
    var awayMembers = rule.members.filter(function (m) { return awayMap[m]; });
    var present = rule.members.length - awayMembers.length;
    if (present >= rule.minPresent) return null;
    var n = Cal.nthSunday(date);
    var rosterOnly = awayMembers.every(function (m) { return awayMap[m] === 'roster'; });
    if (rosterOnly && rule.rosterSundayException && rule.rosterSundayException.indexOf(n) !== -1) return null;
    return { awayMembers: awayMembers, present: present };
  }

  /**
   * Check a new or edited request.
   * request: { person, dates: ['YYYY-MM-DD', ...], extremeEmergency?: boolean }
   * Returns { ok, blocks: [{ rule, date, message }], needsAakash, extremeEmergencyPossible }
   */
  function checkRequest(request, people, away, rules) {
    rules = rules || DEFAULT_RULES;
    var me = people[request.person];
    var result = { ok: true, blocks: [], needsAakash: false, extremeEmergencyPossible: false };
    if (me && me.noClash) return result; // Muskan and Anita are never blocked by these rules
    var others = (away || []).filter(function (a) { return a.person !== request.person; });

    request.dates.forEach(function (date) {
      if (Cal.isRosterOff(me || {}, date)) return; // already off by roster; the request adds nothing
      var map = awayOn(date, people, others);
      map[request.person] = 'request';
      rules.forEach(function (rule) {
        if (!rule.on || rule.members.indexOf(request.person) === -1) return;
        var broken = ruleBroken(rule, date, map);
        if (!broken) return;

        var canBeEmergency = !!rule.emergencyIfAllPresent &&
          broken.present === rule.minPresent - 1 && broken.present >= 1 &&
          rule.emergencyIfAllPresent.every(function (m) { return !map[m]; });
        if (canBeEmergency && request.extremeEmergency) { result.needsAakash = true; return; }
        if (canBeEmergency) result.extremeEmergencyPossible = true;

        var who = broken.awayMembers.filter(function (m) { return m !== request.person; });
        // The applicant sees only the clash, never the other person's reason.
        var message = 'Not allowed: ' + who.join(' and ') + (who.length > 1 ? ' are' : ' is') +
          ' off on ' + niceDate(date) + ' — ' + rule.label + ' needs ' + rule.minPresent +
          ' of ' + rule.members.join(', ') + ' present.';
        result.blocks.push({ rule: rule.id, date: date, message: message });
        result.ok = false;
      });
    });
    return result;
  }

  var api = { DEFAULT_RULES: DEFAULT_RULES, awayOn: awayOn, ruleBroken: ruleBroken, checkRequest: checkRequest };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.GJClash = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
