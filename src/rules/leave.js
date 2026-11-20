/**
 * Leave rules (handoff Part 3.4): notice type, monthly quota, "would be deducted"
 * estimate and who decides. Pure functions. The system never pays or deducts.
 */
(function (root) {
  'use strict';
  var Cal = (typeof require !== 'undefined') ? require('./calendar.js') : root.GJCalendar;

  var CFG = {
    freeLeaves: 5,            // per calendar month, includes roster Sundays and emergencies
    maxEmergencies: 2,        // inside the 5
    // Owner, 20 Nov 2026: the 3rd, 4th, 5th... emergency in a month is a violation. It is NOT
    // counted as a free leave: each such day is 1 day's salary "would be deducted", plus +1 violation.
    regularNoticeHours: 36,
    emergencyNoticeHours: 3,
    autoNoticeHours: 48,
    autoMaxDays: 2,
    specialAboveDays: 3       // more than 3 days in a row = Aakash AND Varun
  };

  /** submittedAt and dutyStartAt are server-time epoch milliseconds. */
  function noticeType(submittedAt, dutyStartAt, cfg) {
    cfg = cfg || CFG;
    var hours = (dutyStartAt - submittedAt) / 3600000;
    if (hours >= cfg.regularNoticeHours) return 'Regular';
    if (hours >= cfg.emergencyNoticeHours) return 'Emergency';
    return 'Unannounced'; // less than 3 hours, or after duty start = violation
  }

  /**
   * Month quota for one person.
   * leaveDays: [{ date, amount: 1 | 0.5, penaltyEmergency?: true }] approved leave in that month
   *   (roster Sundays NOT included here; they are added automatically and never counted twice).
   * penaltyEmergency = a day of the 3rd/4th/5th... emergency: never free, always 1 day cut.
   */
  function monthQuota(person, monthKey, leaveDays, cfg) {
    cfg = cfg || CFG;
    var sundays = Cal.rosterSundaysInMonth(person, monthKey);
    var taken = 0, penaltyDays = 0;
    (leaveDays || []).forEach(function (l) {
      if (Cal.monthKey(l.date) !== monthKey) return;
      if (sundays.indexOf(l.date) !== -1) return;
      if (l.penaltyEmergency) penaltyDays += l.amount; else taken += l.amount;
    });
    var total = sundays.length + taken;
    var above = Math.max(0, total - cfg.freeLeaves);
    var dayRate = person.salary ? person.salary / 30 : 0;
    return {
      rosterSundays: sundays.length,
      leavesTaken: taken,
      total: total,                       // counted inside the 5
      left: Math.max(0, cfg.freeLeaves - total),
      daysAboveQuota: above,
      penaltyEmergencyDays: penaltyDays,  // outside the 5, always cut
      daysCut: above + penaltyDays,
      dayRate: dayRate,
      wouldBeDeducted: Math.round((above + penaltyDays) * dayRate) // estimate only
    };
  }

  /**
   * Emergencies in a month. emergencyCount = Emergency requests that month, in order.
   * Each one beyond the limit gives +1 violation; its days are flagged penaltyEmergency for monthQuota.
   */
  function emergencyStatus(emergencyCount, cfg) {
    cfg = cfg || CFG;
    var beyond = Math.max(0, emergencyCount - cfg.maxEmergencies);
    return { emergencies: emergencyCount, left: Math.max(0, cfg.maxEmergencies - emergencyCount), violations: beyond };
  }
  /** Is the nth emergency of the month (1-based) a penalty emergency? */
  function isPenaltyEmergency(n, cfg) { return n > (cfg || CFG).maxEmergencies; }

  /**
   * Restrictions (blackout periods, handoff Part 3.6).
   * restrictions: [{ id, from, to, note, rule: 'no-leave' | 'violation', appliesTo: [names] | null, on }]
   * appliesTo null = default = all staff except Anita and Muskan (people with noClash).
   * 'violation' rule (owner, 20 Nov 2026): leave is allowed but counts as +1 violation. No money penalty.
   * Returns { blocked, violations, hits: [...] }. Only Varun can override a block.
   */
  function checkRestrictions(personName, person, dates, restrictions) {
    var out = { blocked: false, violations: 0, hits: [] };
    (restrictions || []).forEach(function (r) {
      if (r.on === false) return;
      var applies = r.appliesTo ? r.appliesTo.indexOf(personName) !== -1 : !person.noClash;
      if (!applies) return;
      var inside = dates.filter(function (d) { return d >= r.from && d <= r.to; });
      if (!inside.length) return;
      if (r.rule === 'violation') {
        out.violations += 1; // one violation per request per restriction
        out.hits.push({ id: r.id, dates: inside, rule: 'violation', message: 'Restricted period (' + r.note + '): leave here counts as 1 violation.' });
      } else {
        out.blocked = true;
        out.hits.push({ id: r.id, dates: inside, rule: 'no-leave', message: 'Not allowed: no leave during this period (' + r.note + ').' });
      }
    });
    return out;
  }

  /**
   * Length of the consecutive run a request belongs to.
   * Consecutive days are one run even if split into several requests.
   * Roster Sundays inside a run do not add to its length (and do not break it).
   */
  function runLength(person, requestDates, existingLeaveDates) {
    var set = {};
    requestDates.concat(existingLeaveDates || []).forEach(function (d) { set[d] = true; });
    var sorted = requestDates.slice().sort();
    var count = 0, seen = {};
    function walk(start, step) {
      for (var d = start; ; d = Cal.addDays(d, step)) {
        if (Cal.isRosterOff(person, d)) continue;
        if (!set[d]) return;
        if (!seen[d]) { seen[d] = true; count += 1; }
      }
    }
    walk(sorted[0], -1);
    walk(sorted[0], 1);
    return count;
  }

  /**
   * Who decides. Returns { decision, reasons[] }.
   * decision: 'blocked' | 'recorded' | 'auto' | 'aakash' | 'special' | 'varun'
   * input: { person, days, run, noticeHours, type, clash, restricted, quotaAfter, violationsThisMonth }
   */
  function route(input, cfg) {
    cfg = cfg || CFG;
    var p = input.person, reasons = [];
    if (input.clash && !input.clash.ok) return { decision: 'blocked', reasons: input.clash.blocks.map(function (b) { return b.message; }) };
    if (input.restricted) return { decision: 'blocked', reasons: ['Not allowed: leave is restricted on these dates.'] };
    if (p.noApproval) return { decision: 'recorded', reasons: ['No approval needed. Recorded only.'] };
    if (p.isManager) return { decision: 'varun', reasons: ['Approved by Varun.'] };
    if (input.run > cfg.specialAboveDays) return { decision: 'special', reasons: ['More than 3 days in a row: needs Aakash and Varun.'] };
    if (input.run === 3) reasons.push('3 days in a row.');
    if (input.days > cfg.autoMaxDays && input.run < 3) reasons.push('More than 2 days.');
    if (input.type !== 'Regular') reasons.push(input.type + ' leave.');
    else if (input.noticeHours < cfg.autoNoticeHours) reasons.push('Notice is less than 48 hours.');
    if (input.quotaAfter > cfg.freeLeaves) reasons.push('Above the 5 free leaves this month.');
    if (input.violationsThisMonth > 0) reasons.push('A violation is recorded this month.');
    if (input.clash && input.clash.needsAakash) reasons.push('Extreme emergency: 2 of Sales away.');
    if (p.alwaysAakash) reasons.push('Approved by Aakash.');
    if (reasons.length) return { decision: 'aakash', reasons: reasons };
    return { decision: 'auto', reasons: ['Will be auto-approved.'] };
  }

  var api = { CFG: CFG, noticeType: noticeType, monthQuota: monthQuota, runLength: runLength, route: route,
    emergencyStatus: emergencyStatus, isPenaltyEmergency: isPenaltyEmergency, checkRestrictions: checkRestrictions };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.GJLeave = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
