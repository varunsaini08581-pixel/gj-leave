// GJ Leave & Attendance - server bundle v0.1.0
// GENERATED FILE. Do not edit here. Edit src/ and run: node tools/build.js

// ===== src/rules/calendar.js =====
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

  var api = { isDate: isDate, isTime: isTime, addDays: addDays, weekday: weekday, monthKey: monthKey, daysInMonth: daysInMonth,
    nthSunday: nthSunday, isRosterOff: isRosterOff, rosterSundaysInMonth: rosterSundaysInMonth, dateRange: dateRange };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.GJCalendar = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);

// ===== src/rules/clash.js =====
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

  /** A rule member who is not an active person (left, or renamed) can never count as present. */
  function withGone(rule, map, people) {
    var out = {}; Object.keys(map).forEach(function (k) { out[k] = map[k]; });
    rule.members.forEach(function (m) { if (!people[m] && !out[m]) out[m] = 'gone'; });
    return out;
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
      // While a group runs on an extreme emergency (C1-E), the people it depends on must stay in.
      rules.forEach(function (rule) {
        if (!rule.on || !rule.emergencyIfAllPresent || rule.emergencyIfAllPresent.indexOf(request.person) === -1) return;
        var m0 = withGone(rule, map, people);
        if (!ruleBroken(rule, date, m0)) return;
        // Only when an extreme emergency was really granted for that day (never because someone was a little late).
        if (!others.some(function (a) { return a.date === date && a.extreme && rule.members.indexOf(a.person) !== -1; })) return;
        result.blocks.push({ rule: rule.id + '-E', date: date, who: rule.members.filter(function (m) { return m0[m] === 'request'; }),
          message: 'Not allowed: ' + rule.label + ' is running on an extreme emergency on ' + niceDate(date) + ' — ' + rule.emergencyIfAllPresent.join(' and ') + ' must both be present.' });
        result.ok = false;
      });
      map[request.person] = 'request';
      rules.forEach(function (rule) {
        if (!rule.on || rule.members.indexOf(request.person) === -1) return;
        var ruleMap = withGone(rule, map, people);
        var broken = ruleBroken(rule, date, ruleMap);
        if (!broken) return;

        var canBeEmergency = !!rule.emergencyIfAllPresent &&
          broken.present === rule.minPresent - 1 && broken.present >= 1 &&
          rule.emergencyIfAllPresent.every(function (m) { return !map[m] && people[m]; });
        if (canBeEmergency && request.extremeEmergency) { result.needsAakash = true; return; }
        if (canBeEmergency) result.extremeEmergencyPossible = true;

        var who = broken.awayMembers.filter(function (m) { return m !== request.person; });
        // The applicant sees only the clash, never the other person's reason.
        var message = 'Not allowed: ' + who.join(' and ') + (who.length > 1 ? ' are' : ' is') +
          ' off on ' + niceDate(date) + ' — ' + rule.label + ' needs ' + rule.minPresent +
          ' of ' + rule.members.join(', ') + ' present.';
        result.blocks.push({ rule: rule.id, date: date, message: message, who: who.filter(function (m) { return ruleMap[m] === 'request'; }) });
        result.ok = false;
      });
    });
    return result;
  }

  var api = { DEFAULT_RULES: DEFAULT_RULES, awayOn: awayOn, ruleBroken: ruleBroken, checkRequest: checkRequest };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.GJClash = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);

// ===== src/rules/leave.js =====
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
    if (input.restrictionViolation) reasons.push('Restricted period.');
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

// ===== src/rules/minutes.js =====
/**
 * GJ Leave & Attendance - short leave / late / early / going-out engine.
 * Handoff Part 3.5 ("2-hour bank") and Part 3.7 (violation ladder, version A,
 * confirmed by the owner on 20 Nov 2026).
 *
 * Pure functions, no I/O. The same file runs in Node (tests), in Apps Script
 * (server = source of truth) and in the browser (live preview only).
 *
 * The system only ESTIMATES. It never pays or deducts anything.
 */
(function (root) {
  'use strict';

  var DEFAULTS = {
    bankMinutes: 120,            // per person per calendar month
    lateGraceMinutes: 10,        // daily grace; only minutes after it are counted
    outFreeMinutes: 15,          // going out up to this is free; above it the WHOLE outing counts
    halfDayAfterMinutes: 120,    // more than this away in one day = half day (leave rules, not bank)
    notInformedMaxMinutes: 30,   // not informed and more than this = violation immediately
    freePasses: 3,               // not-informed passes per month
    passViolationEvery: 2,       // after the passes, every 2nd time = violation (5th, 7th, 9th...)
    extraViolationMinutes: 120,  // every extra 2 hours beyond the bank = 1 violation
    disciplineBonus: 500,
    // Confirmed by the owner, 20 Nov 2026:
    over30CountsAsOccasion: false,        // a ">30 min not informed" is its own violation, outside the pass counter
    notInformedExcessCountsForExtra: false // "extra 2 hours beyond the bank" counts informed minutes only
  };

  function ratePerMinute(person) {
    // Hourly rate = monthly salary / 30 / that person's duty hours.
    return person.salary / 30 / person.dutyHours / 60;
  }

  /**
   * Counted minutes of a single event (before bank logic).
   * event: { kind: 'late'|'early'|'out', minutes, informed, statedMinutes? }
   * Returns parts: [{ minutes, informed, raw }]
   */
  function countedParts(event, cfg) {
    var m = event.minutes;
    if (!(m > 0)) return [];
    if (event.kind === 'out') {
      // Going out is always told to the in-charge (approved in the app) = informed.
      if (m <= cfg.outFreeMinutes) return [];
      return [{ minutes: m, informed: true, raw: m }];
    }
    if (event.kind === 'early') {
      return [{ minutes: m, informed: !!event.informed, raw: m }];
    }
    if (event.kind === 'late') {
      if (m <= cfg.lateGraceMinutes) return [];
      if (event.informed && event.statedMinutes != null && m > event.statedMinutes) {
        // Arrived after the stated time: the extra minutes are "not informed".
        var stated = Math.max(event.statedMinutes, cfg.lateGraceMinutes);
        var parts = [];
        if (stated > cfg.lateGraceMinutes) {
          parts.push({ minutes: stated - cfg.lateGraceMinutes, informed: true, raw: stated });
        }
        var extra = m - stated;
        if (extra > 0) parts.push({ minutes: extra, informed: false, raw: extra });
        return parts;
      }
      return [{ minutes: m - cfg.lateGraceMinutes, informed: !!event.informed, raw: m }];
    }
    throw new Error('Unknown event kind: ' + event.kind);
  }

  /**
   * Run one person's month.
   * person: { salary, dutyHours }
   * events: chronological list. Besides late/early/out, an event may be
   *   { kind: 'violation', rule: '...' }  - e.g. unannounced leave, 3rd emergency, manual by Aakash.
   * Returns a full working so the "My month" page can show it line by line.
   */
  function runMonth(person, events, options) {
    var cfg = Object.assign({}, DEFAULTS, options || {});
    var bankUsed = 0;
    var excessInformed = 0;
    var excessNotInformed = 0;
    var notInformedCount = 0;
    var extraViolationsGiven = 0;
    var violations = [];
    var lines = [];

    function addViolation(rule, index) {
      violations.push({ n: violations.length + 1, rule: rule, eventIndex: index });
    }

    events.forEach(function (ev, index) {
      if (ev.kind === 'violation') {
        addViolation(ev.rule || 'manual', index);
        lines.push({ eventIndex: index, kind: 'violation', rule: ev.rule || 'manual' });
        return;
      }
      if (ev.minutes > cfg.halfDayAfterMinutes) {
        // Handled by leave rules (half day), never by the bank.
        lines.push({ eventIndex: index, kind: ev.kind, halfDay: true, counted: 0, fromBank: 0, beyondBank: 0 });
        return;
      }
      var parts = countedParts(ev, cfg);
      var line = { eventIndex: index, kind: ev.kind, counted: 0, fromBank: 0, beyondBank: 0, notes: [] };
      parts.forEach(function (p) {
        var fromBank = Math.min(p.minutes, Math.max(0, cfg.bankMinutes - bankUsed));
        var beyond = p.minutes - fromBank;
        bankUsed += fromBank;
        line.counted += p.minutes;
        line.fromBank += fromBank;
        line.beyondBank += beyond;
        if (p.informed) {
          excessInformed += beyond;
        } else {
          excessNotInformed += beyond;
          if (p.raw > cfg.notInformedMaxMinutes) {
            addViolation('not-informed-over-30', index);
            line.notes.push('Not informed, more than ' + cfg.notInformedMaxMinutes + ' min: violation');
            if (!cfg.over30CountsAsOccasion) return;
          }
          notInformedCount += 1;
          if (notInformedCount <= cfg.freePasses) {
            line.notes.push('Not-informed pass ' + notInformedCount + ' of ' + cfg.freePasses);
          } else if ((notInformedCount - cfg.freePasses) % cfg.passViolationEvery === 0) {
            addViolation('not-informed-beyond-passes', index);
            line.notes.push('Not-informed time no. ' + notInformedCount + ': violation');
          } else {
            line.notes.push('Not-informed time no. ' + notInformedCount + ': next one is a violation');
          }
        }
      });
      var extraBase = excessInformed + (cfg.notInformedExcessCountsForExtra ? excessNotInformed : 0);
      var due = Math.floor(extraBase / cfg.extraViolationMinutes);
      while (extraViolationsGiven < due) {
        extraViolationsGiven += 1;
        addViolation('extra-2-hours-beyond-bank', index);
        line.notes.push('Extra ' + (extraViolationsGiven * cfg.extraViolationMinutes) + ' min beyond the bank: violation');
      }
      lines.push(line);
    });

    var beyondBank = excessInformed + excessNotInformed;
    var rate = ratePerMinute(person);
    return {
      bankMinutes: cfg.bankMinutes,
      bankUsed: bankUsed,
      bankLeft: cfg.bankMinutes - bankUsed,
      notInformedCount: notInformedCount,
      passesUsed: Math.min(notInformedCount, cfg.freePasses),
      beyondBankMinutes: beyondBank,
      ratePerMinute: rate,
      wouldBeDeducted: Math.round(beyondBank * rate), // estimate only
      violations: violations,
      ladder: ladder(violations.length, cfg),
      lines: lines
    };
  }

  /**
   * Violation ladder, version A (owner, 20 Nov 2026):
   *   1st = record only, 2nd = discipline bonus + target allowance would be lost, 3rd = notice.
   * Shown only. Never applied by the system.
   */
  function ladder(count, cfg) {
    cfg = cfg || DEFAULTS;
    return {
      violations: count,
      recordOnly: count === 1,
      bonusLost: count >= 2,
      bonusAmount: count >= 2 ? cfg.disciplineBonus : 0,
      targetAllowanceLost: count >= 2,
      notice: count >= 3 // Varun decides
    };
  }

  var api = { DEFAULTS: DEFAULTS, ratePerMinute: ratePerMinute, countedParts: countedParts, runMonth: runMonth, ladder: ladder };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.GJMinutes = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);

// ===== src/server/schema.js =====
/**
 * Sheet schema (handoff Part 5). One tab per table. Row 1 = headers.
 * Columns listed in JSON_COLS hold JSON text in the Sheet and objects in code.
 * Rows are never deleted. Cancel is a status.
 */
(function (root) {
  'use strict';

  var TABS = {
    People: ['id', 'name', 'group', 'role', 'dutyStart', 'dutyEnd', 'sundayOff', 'noApproval', 'noClash', 'noQuota',
      'dressExempt', 'active', 'email', 'phone', 'pinSalt', 'pinHash', 'pinTries', 'pinLockedUntil', 'pinLockLevel', 'joinedOn'],
    Devices: ['id', 'personId', 'tokenHash', 'label', 'status', 'requestedAt', 'decidedAt', 'decidedBy', 'pinTries', 'pinLockedUntil', 'pinLockLevel', 'signedOut'],
    PayInfo: ['personId', 'fixedSalary', 'targetAllowance', 'disciplineBonus', 'dutyHours', 'updatedAt', 'updatedBy'],
    Rules: ['id', 'on', 'label', 'members', 'minPresent', 'rosterSundayException', 'emergencyIfAllPresent'],
    Restrictions: ['id', 'from', 'to', 'note', 'rule', 'appliesTo', 'on', 'createdBy', 'createdAt'],
    LeaveRequests: ['id', 'personId', 'kind', 'dates', 'halfStart', 'reasonCode', 'reasonText', 'submittedAt', 'type',
      'noticeHours', 'run', 'route', 'status', 'approvals', 'extremeEmergency', 'emergencyNo', 'penaltyEmergency',
      'restrictionViolation', 'enteredBy', 'decidedAt', 'decidedBy', 'decisionReason', 'history', 'override', 'remindedAt', 'noticeAt'],
    ShortRequests: ['id', 'personId', 'date', 'kind', 'time', 'submittedAt', 'status', 'note', 'decidedAt', 'decidedBy', 'decisionReason', 'remindedAt'],
    Outings: ['id', 'personId', 'date', 'reason', 'expectedMinutes', 'requestedAt', 'status', 'approvedAt', 'approvedBy',
      'decisionReason', 'backAt', 'confirmedAt', 'confirmedBy', 'correctedBackAt', 'minutes', 'remindedAt'],
    Thumbs: ['id', 'personId', 'date', 'data'],
    Punches: ['id', 'personId', 'date', 'kind', 'at', 'photoId', 'lat', 'lng', 'accuracy', 'distance', 'deviceId', 'flag', 'note', 'thumbId', 'dress', 'dressDecision', 'enteredBy'],
    DayMinutes: ['id', 'personId', 'date', 'kind', 'minutes', 'informed', 'statedMinutes', 'source', 'note', 'shortId'],
    Incidents: ['id', 'personId', 'date', 'item', 'note', 'photoId', 'createdBy', 'createdAt', 'result', 'countInPeriod', 'grace'],
    Violations: ['id', 'personId', 'date', 'rule', 'source', 'proof', 'note', 'createdBy', 'createdAt', 'disputeState',
      'disputeAt', 'disputeText', 'disputeDecidedBy', 'disputeDecidedAt'],
    MonthSheet: ['id', 'month', 'personId', 'result', 'lockedBy', 'lockedAt'],
    Notifications: ['id', 'to', 'kind', 'title', 'body', 'ref', 'createdAt', 'readAt', 'emailedAt'],
    Audit: ['id', 'at', 'actor', 'action', 'ref', 'detail'],
    Settings: ['key', 'value', 'updatedAt', 'updatedBy']
  };

  var JSON_COLS = {
    People: ['sundayOff'], Rules: ['members', 'rosterSundayException', 'emergencyIfAllPresent'],
    Restrictions: ['appliesTo'], LeaveRequests: ['dates', 'approvals', 'history'], Punches: ['dress'], MonthSheet: ['result'], Audit: ['detail']
  };

  // Every cell is stored as plain text (so Sheets never turns '2026-11-25' or '09:30' into a date).
  // These lists tell the store how to turn text back into numbers and booleans.
  var NUM_COLS = ['pinTries', 'pinLockedUntil', 'pinLockLevel', 'requestedAt', 'decidedAt', 'submittedAt', 'noticeHours', 'run', 'emergencyNo',
    'at', 'lat', 'lng', 'accuracy', 'distance', 'minutes', 'statedMinutes', 'createdAt', 'disputeAt', 'disputeDecidedAt',
    'lockedAt', 'readAt', 'emailedAt', 'updatedAt', 'minPresent', 'fixedSalary', 'targetAllowance', 'disciplineBonus', 'dutyHours',
    'noticeAt', 'expectedMinutes', 'countInPeriod', 'grace', 'approvedAt', 'backAt', 'confirmedAt', 'correctedBackAt', 'remindedAt'];
  var BOOL_COLS = ['noApproval', 'noClash', 'noQuota', 'dressExempt', 'active', 'on', 'extremeEmergency', 'penaltyEmergency',
    'restrictionViolation', 'informed', 'signedOut'];

  var SCHEMA_VERSION = 3;
  // Tabs added after the first version: an older Sheet may rightly not have them yet. Every other
  // missing tab on a Sheet that is in use means a tab was renamed or deleted by hand.
  var TAB_SINCE = { Thumbs: 2 };
  // What an empty or unreadable JSON cell is read as (everything else: null).
  var JSON_DEFAULT = { dates: [], approvals: {}, history: [], members: [] };

  var api = { TABS: TABS, JSON_COLS: JSON_COLS, NUM_COLS: NUM_COLS, BOOL_COLS: BOOL_COLS, SCHEMA_VERSION: SCHEMA_VERSION, TAB_SINCE: TAB_SINCE, JSON_DEFAULT: JSON_DEFAULT };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.GJSchema = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);

// ===== src/server/cachegrid.js =====
/**
 * Read cache in front of the Sheet. Reading a tab from the Sheet costs about half a second;
 * a screen needs up to ten tabs. With this cache a tab is read from the Sheet once and then
 * served from memory until something writes to it.
 *
 * Safety comes from a VERSION per tab:
 *   - the data of a tab is cached under  d:<tab>:<version>
 *   - a writer, after its writes are on the Sheet and still inside the server lock, moves the
 *     tab to a new version. Whatever was cached under the old version is never read again.
 * So a reader can never keep serving rows from before a write, even when two requests overlap.
 * Cached data also expires by itself after TTL seconds, which bounds the effect of a manual
 * edit made directly in the Sheet (the owner is told not to do that).
 *
 * cache = { getAll(keys) -> {key: text}, put(key, text, ttlSeconds), putAll(map, ttlSeconds) }
 */
(function (root) {
  'use strict';
  var DATA_TTL = 600;       // 10 minutes
  var VERSION_TTL = 21600;  // 6 hours (the longest Apps Script allows)
  var MAX_CHARS = 90000;    // one cache value may hold 100 KB; a bigger tab is kept in several pieces
  var MAX_PIECES = 12;      // about 1 MB of text per tab; beyond that the tab is read from the Sheet

  function wrap(grid, cache, tabNames, newVersion) {
    var versions = null, dirty = {}, readAt = {};
    function vkey(tab) { return 'v:' + tab; }
    function loadVersions() {
      if (versions) return versions;
      var got = {};
      try { got = cache.getAll(tabNames.map(vkey)) || {}; } catch (e) { got = {}; }
      versions = {};
      var fresh = {};
      tabNames.forEach(function (t) {
        if (got[vkey(t)]) versions[t] = got[vkey(t)];
        else { versions[t] = newVersion(); fresh[vkey(t)] = versions[t]; }
      });
      if (Object.keys(fresh).length) { try { cache.putAll(fresh, VERSION_TTL); } catch (e) { /* cache is optional */ } }
      return versions;
    }
    function dkey(tab) { return 'd:' + tab + ':' + (loadVersions()[tab] || 'x'); }
    /** Store a tab's text under key; a long text goes in numbered pieces with a small index entry. */
    function putText(key, json) {
      try {
        if (json.length <= MAX_CHARS) { cache.put(key, json, DATA_TTL); return; }
        var n = Math.ceil(json.length / MAX_CHARS);
        if (n > MAX_PIECES) return; // too big to keep: it is read from the Sheet
        var map = {};
        for (var i = 0; i < n; i++) map[key + ':' + i] = json.substr(i * MAX_CHARS, MAX_CHARS);
        map[key] = '#pieces:' + n + ':' + json.length;
        cache.putAll(map, DATA_TTL);
      } catch (e) { /* cache down or full: fine */ }
    }
    function getText(key) {
      var text = null;
      try { text = (cache.getAll([key]) || {})[key]; } catch (e) { return null; }
      if (!text || text.indexOf('#pieces:') !== 0) return text || null;
      var a = text.split(':'), n = +a[1], len = +a[2], keys = [], out = '';
      for (var i = 0; i < n; i++) keys.push(key + ':' + i);
      var got = {}; try { got = cache.getAll(keys) || {}; } catch (e) { return null; }
      for (var j = 0; j < n; j++) { if (typeof got[keys[j]] !== 'string') return null; out += got[keys[j]]; }
      return out.length === len ? out : null; // a missing or half-expired piece = not cached
    }
    function read(tab) {
      var key = dkey(tab), text = null;
      readAt[tab] = loadVersions()[tab];
      text = getText(key);
      if (text) { try { return JSON.parse(text); } catch (e) { /* fall through to the Sheet */ } }
      var data = grid.read(tab);
      try { putText(key, JSON.stringify(data)); } catch (e) { /* fine */ }
      return data;
    }
    return {
      /** Forget the versions seen so far: the next read asks the cache which copy is current. */
      reset: function () { versions = null; readAt = {}; },
      tabNames: function () { return grid.tabNames(); },
      addTab: function (name) { dirty[name] = true; return grid.addTab(name); },
      read: read,
      // Headers change only in setup, so they have their own long-lived entry and inserting a row
      // never needs the whole tab.
      headers: function (tab) {
        var key = 'h:' + tab, text = null;
        try { text = (cache.getAll([key]) || {})[key]; } catch (e) { text = null; }
        if (text) { try { return JSON.parse(text); } catch (e) { /* fall through */ } }
        var h = grid.headers ? grid.headers(tab) : (grid.read(tab)[0] || []);
        try { if (h.length) cache.put(key, JSON.stringify(h), VERSION_TTL); } catch (e) { /* optional */ }
        return h;
      },
      /** The header row straight from the Sheet; the remembered copy is refreshed with it. */
      liveHeaders: function (tab) {
        var h = grid.headers ? grid.headers(tab) : (grid.read(tab)[0] || []);
        try { if (h.length) cache.put('h:' + tab, JSON.stringify(h), VERSION_TTL); } catch (e) { /* optional */ }
        return h;
      },
      /** Header rows of many tabs with one cache call (used by the "is the Sheet upgraded?" check). */
      allHeaders: function (tabs) {
        var got = {}, out = {};
        try { got = cache.getAll(tabs.map(function (t) { return 'h:' + t; })) || {}; } catch (e) { got = {}; }
        tabs.forEach(function (t) {
          var text = got['h:' + t];
          if (text) { try { out[t] = JSON.parse(text); return; } catch (e) { /* read it */ } }
          var h = grid.headers ? grid.headers(t) : (grid.read(t)[0] || []);
          try { if (h.length) cache.put('h:' + t, JSON.stringify(h), VERSION_TTL); } catch (e) { /* optional */ }
          out[t] = h;
        });
        return out;
      },
      /** One row and the whole tab, straight from the Sheet (to check where a row stands before it is written). */
      readRow: function (tab, i) { return grid.readRow ? grid.readRow(tab, i) : (grid.read(tab)[i] || null); },
      readLive: function (tab) { return grid.read(tab); },
      tail: function (tab, n) { return grid.tail ? grid.tail(tab, n) : grid.read(tab).slice(1).slice(-n); },
      appendMany: function (batch) {
        batch.forEach(function (b) { dirty[b.tab] = true; });
        if (grid.appendMany) return grid.appendMany(batch);
        var first = {}; batch.forEach(function (b) { first[b.tab] = grid.appendRows(b.tab, b.rows); }); return first;
      },
      append: function (tab, row) { dirty[tab] = true; return grid.append(tab, row); },
      appendRows: function (tab, rows) { dirty[tab] = true; return grid.appendRows(tab, rows); },
      writeRow: function (tab, i, row) { dirty[tab] = true; return grid.writeRow(tab, i, row); },
      /** Called by the store after its writes are on the Sheet (inside the lock): retire the old versions. */
      commit: function (full) {
        var names = Object.keys(dirty);
        if (!names.length) return;
        var map = {}, current = {};
        loadVersions();
        // The writer holds the server lock here. If nobody else has written a tab since this
        // request read it, the request knows the tab's exact new content and can cache it.
        try { current = cache.getAll(names.map(vkey)) || {}; } catch (e) { current = {}; }
        names.forEach(function (t) {
          var untouched = readAt[t] && current[vkey(t)] === readAt[t];
          versions[t] = newVersion(); map[vkey(t)] = versions[t];
          if (full && full[t] && untouched) {
            try { putText('d:' + t + ':' + versions[t], JSON.stringify(full[t])); } catch (e) { /* optional */ }
          }
          readAt[t] = versions[t];
        });
        dirty = {};
        // The new versions MUST reach the cache: otherwise other requests keep reading the copy from before this write.
        try { cache.putAll(map, VERSION_TTL); }
        catch (e) {
          Object.keys(map).forEach(function (k) {
            try { cache.put(k, map[k], VERSION_TTL); }
            catch (e2) { try { if (cache.remove) cache.remove(k); } catch (e3) { /* the data TTL (10 min) is the last bound */ } }
          });
        }
      }
    };
  }

  var api = { wrap: wrap, DATA_TTL: DATA_TTL };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.GJCacheGrid = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);

// ===== src/server/store.js =====
/**
 * Sheet store. Turns tabs of plain-text cells into row objects and back.
 * It talks to a tiny "grid" interface so the same code is tested in Node with a fake grid
 * and runs in Apps Script on the real Sheet:
 *
 *   grid.tabNames() -> [name]
 *   grid.addTab(name)
 *   grid.read(name) -> 2D array of strings (row 0 = headers); [] when empty
 *   grid.append(name, rowArray)
 *   grid.writeRow(name, rowIndex /* 0-based, 0 = headers *\/, rowArray)
 *
 * Rows are never deleted. The first column of every tab is its key.
 */
(function (root) {
  'use strict';
  var Schema = (typeof require !== 'undefined') ? require('./schema.js') : root.GJSchema;
  var Clash = (typeof require !== 'undefined') ? require('../rules/clash.js') : root.GJClash;
  var Cal = (typeof require !== 'undefined') ? require('../rules/calendar.js') : root.GJCalendar;

  function has(list, x) { return list.indexOf(x) !== -1; }

  function encode(tab, col, v) {
    if (v === undefined || v === null) return '';
    if (has(Schema.JSON_COLS[tab] || [], col)) return JSON.stringify(v);
    if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
    var s = String(v);
    // Text that a spreadsheet could read as a formula is stored with a leading apostrophe
    // (the cells are plain text as well; this is the second lock on the same door).
    return /^[=+\-@']/.test(s) ? "'" + s : s;
  }
  function jsonDefault(col) { var d = Schema.JSON_DEFAULT[col]; return d === undefined ? null : JSON.parse(JSON.stringify(d)); }
  function decode(tab, col, text) {
    var isJson = has(Schema.JSON_COLS[tab] || [], col);
    if (text === '' || text === undefined || text === null) return isJson ? jsonDefault(col) : '';
    text = String(text);
    if (/^'[=+\-@']/.test(text)) text = text.slice(1);
    var trimmed = text.replace(/^\s+|\s+$/g, '');
    if (isJson) {
      try { return JSON.parse(text); } catch (e) { /* typed by hand: understand the plain forms, else the default */ }
      if (col === 'sundayOff' && /^every$/i.test(trimmed)) return 'every';
      if (col === 'dates' && Cal.isDate(trimmed)) return [trimmed];
      return jsonDefault(col);
    }
    if (has(Schema.BOOL_COLS, col)) return trimmed.toUpperCase() === 'TRUE';
    if (has(Schema.NUM_COLS, col)) { var n = Number(trimmed.replace(/,/g, '')); return trimmed === '' || isNaN(n) ? '' : n; }
    return text;
  }
  /** A row the app cannot work with (its dates were damaged by a hand edit). It is left alone and reported. */
  function damaged(tab, obj) {
    if (tab !== 'LeaveRequests') return false;
    return !(Array.isArray(obj.dates) && obj.dates.length && obj.dates.every(Cal.isDate));
  }

  /**
   * Create missing tabs and add missing columns. Safe to run twice: it never removes or
   * reorders anything that exists and never touches data rows.
   */
  function setup(grid, options) {
    var done = [];
    var names = grid.tabNames();
    var trim = function (h) { return String(h).replace(/^\s+|\s+$/g, ''); };
    // Which schema does this Sheet say it has? (0 = a new, empty Sheet.)
    var stored = 0;
    if (has(names, 'Settings')) {
      var st = grid.read('Settings'), kc = st.length ? st[0].map(trim).indexOf('key') : -1, vc = st.length ? st[0].map(trim).indexOf('value') : -1;
      st.slice(1).forEach(function (r) { if (kc !== -1 && r[kc] === 'schemaVersion') stored = Number(r[vc]) || 1; });
    }
    var inUse = stored > 0 || names.some(function (n) { return Schema.TABS[n] && grid.read(n).length > 1; });
    // First look at everything, and refuse before anything is written.
    Object.keys(Schema.TABS).forEach(function (tab) {
      if (!has(names, tab)) {
        if (inUse && (Schema.TAB_SINCE[tab] || 1) <= Math.max(stored, 1)) throw new Error('The "' + tab + '" tab is missing. It was renamed or deleted. Rename it back (or restore it from version history) and run this again. Nothing was changed.');
        return;
      }
      var data = grid.read(tab);
      if (data.length > 1 && !data[0].some(function (h) { return trim(h) !== ''; })) throw new Error('Row 1 of the "' + tab + '" tab (the column names) is empty. Restore it from version history and run this again. Nothing was changed.');
      if (data.length && data[0].some(function (h) { return trim(h) !== ''; }) && !has(data[0].map(trim), Schema.TABS[tab][0]))
        throw new Error('The "' + tab + '" tab has lost its "' + Schema.TABS[tab][0] + '" column. Restore the header row before using the app. Nothing was changed.');
    });
    Object.keys(Schema.TABS).forEach(function (tab) {
      if (!has(names, tab)) { grid.addTab(tab); grid.append(tab, Schema.TABS[tab].slice()); done.push('created ' + tab); return; }
      var data = grid.read(tab);
      if (!data.length) { grid.append(tab, Schema.TABS[tab].slice()); done.push('headers ' + tab); return; }
      var headers = data[0].map(String);
      // A space typed after a column name is repaired in place (never answered with a second, empty column).
      var tidy = headers.map(function (h) { return has(Schema.TABS[tab], trim(h)) ? trim(h) : h; });
      var changed = tidy.some(function (h, i) { return h !== headers[i]; });
      var missing = Schema.TABS[tab].filter(function (c) { return !has(tidy, c); });
      if (changed || missing.length) {
        grid.writeRow(tab, 0, tidy.concat(missing));
        if (changed) done.push('repaired column names in ' + tab);
        if (missing.length) done.push('columns ' + tab + ': ' + missing.join(', '));
      }
    });
    var db = open(grid);
    if (!db.rows('Rules').length) {
      Clash.DEFAULT_RULES.forEach(function (r) { db.insert('Rules', r); });
      done.push('seeded Rules');
    }
    var row = db.rows('Settings').filter(function (s) { return s.key === 'schemaVersion'; })[0];
    if (!row) {
      db.insert('Settings', { key: 'schemaVersion', value: String(Schema.SCHEMA_VERSION), updatedAt: '', updatedBy: 'setup' });
      done.push('schemaVersion ' + Schema.SCHEMA_VERSION);
      // A brand-new Sheet remembers the day it was made: nobody is marked absent for days before it.
      if (!inUse && options && options.today && !db.rows('Settings').some(function (s) { return s.key === 'startDate'; })) {
        db.insert('Settings', { key: 'startDate', value: options.today, updatedAt: '', updatedBy: 'setup' });
        done.push('startDate ' + options.today);
      }
    } else if (String(row.value) !== String(Schema.SCHEMA_VERSION)) {
      db.update('Settings', 'schemaVersion', { value: String(Schema.SCHEMA_VERSION), updatedBy: 'setup' });
      done.push('schemaVersion ' + row.value + ' -> ' + Schema.SCHEMA_VERSION);
    }
    return done;
  }

  /**
   * Open a db over the grid. Each tab is read at most once per request and cached.
   *
   * options.buffer = true (used on the real Sheet): inserts and updates are collected and
   * written together by flush() - one write per tab instead of one per row. That is the
   * difference between a 3-second and a 12-second check-in. flush() is called inside the
   * server lock, so nothing is visible to another request half-written.
   * A tab that is only written to in a request (Audit, usually Notifications) is never read in full.
   */
  function open(grid, options) {
    var buffer = !!(options && options.buffer);
    var cache = {};
    function entry(tab) {
      if (!cache[tab]) cache[tab] = { headers: null, rows: null, pending: [], dirty: [], damaged: [] };
      return cache[tab];
    }
    function headersOf(tab) {
      var t = entry(tab);
      if (!t.headers) {
        var h = grid.headers ? grid.headers(tab) : (grid.read(tab)[0] || []);
        t.headers = h && h.length ? h.map(function (x) { return String(x).replace(/^\s+|\s+$/g, ''); }) : Schema.TABS[tab].slice();
      }
      return t.headers;
    }
    function load(tab) {
      var t = entry(tab);
      if (t.rows) return t;
      var data = grid.read(tab);
      t.headers = data.length ? data[0].map(function (x) { return String(x).replace(/^\s+|\s+$/g, ''); }) : Schema.TABS[tab].slice();
      var rows = [];
      for (var i = 1; i < data.length; i++) {
        var obj = {}, empty = true;
        for (var c = 0; c < t.headers.length; c++) {
          var cell = data[i][c];
          if (cell !== '' && cell !== undefined && cell !== null) empty = false;
          obj[t.headers[c]] = decode(tab, t.headers[c], cell);
        }
        if (empty) continue;
        if (damaged(tab, obj)) { t.damaged.push(tab + ' row ' + (i + 1)); continue; }
        Object.defineProperty(obj, '__row', { value: i, enumerable: false, writable: true });
        rows.push(obj);
      }
      t.rows = rows.concat(t.pending); // rows inserted earlier in this request, before the tab was read
      return t;
    }
    function toArray(tab, headers, obj) { return headers.map(function (h) { return encode(tab, h, obj[h]); }); }
    var CELL_MAX = 49000; // a Sheet cell holds 50,000 characters
    function flush() {
      // Nothing is written unless everything can be written: one oversized cell must not leave half an action on the Sheet.
      Object.keys(cache).forEach(function (tab) {
        var t = cache[tab];
        t.pending.concat(t.dirty).forEach(function (r) {
          toArray(tab, t.headers, r).forEach(function (cell) { if (cell.length > CELL_MAX) { discard(); throw new Error('A value is too long to store.'); } });
        });
      });
      try { write(); } catch (e) { try { if (grid.commit) grid.commit({}); } catch (e2) { /* the cache expires by itself */ } discard(); throw e; } // a failed write is never repeated by a second flush
    }
    /** Forget everything read and everything not yet written (after a refused action, and when the server lock is taken). */
    function discard() { cache = {}; if (grid.reset) grid.reset(); }
    /** The header row as it is on the Sheet right now (never a remembered copy). */
    function liveHeaders(tab) {
      var h = grid.liveHeaders ? grid.liveHeaders(tab) : grid.headers ? grid.headers(tab) : (grid.read(tab)[0] || []);
      return h && h.length ? h.map(function (x) { return String(x).replace(/^\s+|\s+$/g, ''); }) : null;
    }
    function same(a, b) { return a.length === b.length && a.every(function (x, i) { return x === b[i]; }); }
    function write() {
      var full = {}, firstRows = {}, batch = [], live = {}, unsure = {};
      // Rows are laid out by the header row the Sheet has NOW. A column the owner inserted by hand,
      // or a header that changed since it was last read, can then never shift a row.
      Object.keys(cache).forEach(function (tab) {
        var t = cache[tab];
        if (!t.pending.length && !t.dirty.length) return;
        if (!t.headers) headersOf(tab);
        live[tab] = liveHeaders(tab) || t.headers;
        if (!same(live[tab], t.headers)) unsure[tab] = true;
      });
      // All appended rows of this request go to the Sheet in ONE step (reads first, then writes),
      // because on the real Sheet every read placed between two writes costs a round trip.
      Object.keys(cache).forEach(function (tab) {
        var t = cache[tab];
        if (t.pending.length) batch.push({ tab: tab, rows: t.pending.map(function (r) { return toArray(tab, live[tab], r); }) });
      });
      // Where does each changed row stand now? (A row deleted or sorted by hand moves the others.)
      var places = [];
      Object.keys(cache).forEach(function (tab) {
        var t = cache[tab], key = Schema.TABS[tab][0], kc = live[tab] ? live[tab].indexOf(key) : -1, fresh = null;
        t.dirty.forEach(function (r) {
          if (!(r.__row > 0)) return;
          var at = r.__row;
          if (grid.readRow && kc !== -1) {
            var now = grid.readRow(tab, at);
            if (!now || String(decode(tab, key, now[kc])) !== String(r[key])) {
              unsure[tab] = true;
              fresh = fresh || (grid.readLive ? grid.readLive(tab) : grid.read(tab));
              at = -1;
              for (var i = 1; i < fresh.length; i++) if (String(decode(tab, key, fresh[i][kc])) === String(r[key])) { at = i; break; }
              if (at === -1) throw new Error('A row of "' + tab + '" is no longer on the Sheet.');
            }
          }
          // Only the app's own columns are written; whatever else the owner keeps in that row is not touched.
          var cells = [];
          live[tab].forEach(function (h, c) { if (has(Schema.TABS[tab], h) && Object.prototype.hasOwnProperty.call(r, h)) cells[c] = encode(tab, h, r[h]); });
          places.push({ tab: tab, at: at, cells: cells, row: r });
        });
      });
      if (batch.length) {
        if (grid.appendMany) firstRows = grid.appendMany(batch) || {};
        else batch.forEach(function (b) {
          if (grid.appendRows) firstRows[b.tab] = grid.appendRows(b.tab, b.rows);
          else { firstRows[b.tab] = null; b.rows.forEach(function (a) { grid.append(b.tab, a); }); }
        });
      }
      places.forEach(function (p) { grid.writeRow(p.tab, p.at, p.cells); p.row.__row = p.at; });
      Object.keys(cache).forEach(function (tab) {
        var t = cache[tab];
        var changed = t.pending.length || t.dirty.length;
        if (t.pending.length) {
          var first = firstRows[tab];
          t.pending.forEach(function (r, i) { r.__row = first === null || first === undefined ? -1 : first + i; });
          t.pending = [];
        }
        t.dirty = [];
        // For a tab this request has read in full, hand the cache its exact new content, so the next
        // request does not have to read the Sheet again. Never when the Sheet was found changed by hand.
        if (changed && !unsure[tab] && !t.damaged.length && t.rows && t.rows.every(function (r) { return r.__row > 0; })) {
          var last = t.rows.reduce(function (m, r) { return Math.max(m, r.__row); }, 0), blank = t.headers.map(function () { return ''; });
          var data = [t.headers.slice()];
          for (var i = 1; i <= last; i++) data.push(blank);
          t.rows.forEach(function (r) { data[r.__row] = toArray(tab, t.headers, r); });
          full[tab] = data;
        }
        if (unsure[tab]) { t.rows = null; t.headers = null; } // read again if this request needs the tab once more
      });
      if (grid.commit) grid.commit(full); // retire cached copies of the tabs just written
    }
    var db = {
      rows: function (tab) { return load(tab).rows; },
      insert: function (tab, obj) {
        var headers = headersOf(tab), t = entry(tab), row = {};
        headers.forEach(function (h) { row[h] = decode(tab, h, encode(tab, h, obj[h])); });
        Object.defineProperty(row, '__row', { value: 0, enumerable: false, writable: true }); // 0 = not written yet
        t.pending.push(row);
        if (t.rows) t.rows.push(row);
        if (!buffer) flush();
      },
      update: function (tab, key, patch) {
        var t = load(tab);
        var keyCol = has(t.headers, Schema.TABS[tab][0]) ? Schema.TABS[tab][0] : t.headers[0]; // by name, wherever the column stands
        var row = t.rows.filter(function (r) { return String(r[keyCol]) === String(key); })[0];
        if (!row) throw new Error('update: no row in ' + tab + ' for ' + key);
        Object.keys(patch).forEach(function (k) {
          if (!has(t.headers, k)) {
            // A column of the current schema that this Sheet does not have yet (upgrade not run): skipped, never a crash.
            if (has(Schema.TABS[tab], k)) return;
            throw new Error('update: unknown column ' + tab + '.' + k);
          }
          row[k] = decode(tab, k, encode(tab, k, patch[k]));
        });
        if (row.__row > 0 && t.dirty.indexOf(row) === -1) t.dirty.push(row); // a not-yet-written row is simply written with its new values
        if (!buffer) flush();
      },
      /** The last n rows of a tab without reading the whole tab (used for today's thumbnails). */
      tail: function (tab, n) {
        var t = entry(tab);
        if (t.rows) return t.rows.slice(-n);
        var headers = headersOf(tab), data = grid.tail ? grid.tail(tab, n) : grid.read(tab).slice(1).slice(-n);
        var out = data.map(function (r) { var o = {}; headers.forEach(function (h, c) { o[h] = decode(tab, h, r[c]); }); return o; });
        return out.concat(t.pending).slice(-n);
      },
      flush: flush,
      /** Tabs and columns of the current schema that the Sheet does not have ([] = ready). */
      schemaProblems: function () {
        var tabs = Object.keys(Schema.TABS), out = [];
        var got = grid.allHeaders ? grid.allHeaders(tabs) : null;
        tabs.forEach(function (tab) {
          var h = (got ? got[tab] : (grid.headers ? grid.headers(tab) : (grid.read(tab)[0] || []))) || [];
          h = h.map(function (x) { return String(x).replace(/^\s+|\s+$/g, ''); });
          if (!h.length) { out.push(tab); return; }
          Schema.TABS[tab].forEach(function (c) { if (!has(h, c)) out.push(tab + '.' + c); });
        });
        return out;
      },
      /** Rows left out because a hand edit damaged them, as "Tab row N". */
      damaged: function () { var out = []; Object.keys(cache).forEach(function (tab) { out = out.concat(cache[tab].damaged); }); return out; },
      /** Called as the first thing inside the server lock: whatever was read while waiting is stale. */
      reset: function () { flush(); discard(); },
      discard: discard
    };
    return db;
  }

  var api = { setup: setup, open: open, encode: encode, decode: decode };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.GJStore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);

// ===== src/server/core.js =====
/**
 * Server core: login + phone binding, leave requests (preview, submit, decide, cancel).
 * Pure logic over a small storage interface, so the same code runs in Node tests
 * (memory store) and in Apps Script (Sheet store). The SERVER is the only source of truth:
 * every rule is enforced here, never trusted from the phone.
 *
 * ctx = { db, now (epoch ms, server time), env: { sha256(str), randomId(), withLock(fn) } }
 * db  = { rows(tab) -> array of objects, insert(tab, obj), update(tab, id, patch) }
 */
(function (root) {
  'use strict';
  var req = (typeof require !== 'undefined') ? require : null;
  var Cal = req ? req('../rules/calendar.js') : root.GJCalendar;
  var Clash = req ? req('../rules/clash.js') : root.GJClash;
  var Leave = req ? req('../rules/leave.js') : root.GJLeave;
  var Minutes = req ? req('../rules/minutes.js') : root.GJMinutes;

  var IST_OFFSET_MS = 5.5 * 3600000;
  var PIN_MAX_TRIES = 5;
  var PIN_LOCK_MS = 15 * 60000;       // first lock; each further lock in a row is 4 times longer, up to a day
  var PIN_LOCK_MAX_MS = 24 * 3600000;
  var MAX_PENDING_PHONES = 3;
  var HALF_DAY_MINUTES = 270;         // owner: a half day is any 4 h 30 min
  var REASONS = ['Sick', 'Family function', 'Family emergency', 'Personal work', 'Travel', 'Exam', 'Other'];
  var OPEN = { 'Pending with Aakash': 1, 'Special – waiting': 1, 'Pending with Varun': 1 };
  var GRANTED = { 'Approved': 1, 'Recorded': 1 };
  var ABSENT = 'Absent – unannounced';

  var RULE_LABELS = { 'not-informed-over-30': 'Not informed, more than 30 min', 'not-informed-beyond-passes': 'Not informed, after the 3 passes',
    'extra-2-hours-beyond-bank': 'Extra 2 hours beyond the bank', 'unannounced-leave': 'Unannounced leave', 'emergency-beyond-2': 'Emergency leave beyond 2 in the month',
    'leave-in-restricted-period': 'Leave in a restricted period', 'absent-no-request': 'Absent with no request' };
  function ruleLabel(rule) { return RULE_LABELS[rule] || String(rule).replace('manual:', 'Recorded by Aakash: '); }
  function fail(code, message) { var e = new Error(message); e.code = code; throw e; }
  /** A refusal whose side effects must still be saved (a wrong PIN is counted). */
  function failKeep(code, message) { var e = new Error(message); e.code = code; e.keep = true; throw e; }
  /** Months that Aakash and Varun have locked. Nothing dated in a locked month is changed in place any more. */
  function lockedMonths(ctx) {
    var out = {};
    ctx.db.rows('MonthSheet').forEach(function (m) { if (m.personId !== 'lock-ack' && m.personId !== 'correction') out[m.month] = true; });
    return out;
  }
  function assertOpen(ctx, dates) {
    var locked = lockedMonths(ctx);
    [].concat(dates || []).forEach(function (d) {
      if (d && locked[Cal.monthKey(String(d))]) fail('BLOCKED', 'This month is locked. Add a correction in the month report instead.');
    });
  }
  /** The moment a record is really made (an entry Aakash back-dates still starts its 24-hour dispute window now). */
  function stamp(ctx) { return ctx.stampNow || ctx.now; }
  function hhmmToMin(t) { var a = t.split(':'); return +a[0] * 60 + +a[1]; }
  function settingValue(ctx, key) { var s = ctx.db.rows('Settings').filter(function (x) { return x.key === key; })[0]; return s ? s.value : ''; }
  /** Shop-closed days (Settings). A leave on a closed day uses no quota. */
  function closedSet(ctx) {
    var out = {};
    try { (JSON.parse(settingValue(ctx, 'closedDays') || '[]') || []).forEach(function (d) { out[d] = true; }); } catch (e) { /* bad setting = no closed days */ }
    return out;
  }
  /** Days on which the total away time is over 2 hours: a half day, or a full day over 4 h 30 min. */
  function autoDays(ctx, personId) {
    var sum = {};
    ctx.db.rows('DayMinutes').forEach(function (m) { if (m.personId === personId) sum[m.date] = (sum[m.date] || 0) + m.minutes; });
    return Object.keys(sum).sort().filter(function (d) { return sum[d] > Minutes.DEFAULTS.halfDayAfterMinutes; })
      .map(function (d) { return { date: d, minutes: sum[d], amount: sum[d] > HALF_DAY_MINUTES ? 1 : 0.5 }; });
  }
  function find(ctx, tab, id) { return ctx.db.rows(tab).filter(function (r) { return r.id === id; })[0]; }
  function audit(ctx, actor, action, ref, detail) {
    ctx.db.insert('Audit', { id: ctx.env.randomId(), at: ctx.now, actor: actor, action: action, ref: ref || '', detail: detail || {} });
  }
  function notify(ctx, to, kind, title, body, ref) {
    ctx.db.insert('Notifications', { id: ctx.env.randomId(), to: to, kind: kind, title: title, body: body, ref: ref || '', createdAt: ctx.now, readAt: '', emailedAt: '' });
  }
  function byRole(ctx, role) { return ctx.db.rows('People').filter(function (p) { return p.role === role && p.active !== false; }); }
  function toMs(date, hhmm) {
    var d = date.split('-'), t = hhmm.split(':');
    return Date.UTC(+d[0], +d[1] - 1, +d[2], +t[0], +t[1]) - IST_OFFSET_MS;
  }
  function today(ctx) { return new Date(ctx.now + IST_OFFSET_MS).toISOString().slice(0, 10); }

  // ---------- Login and phone binding (handoff 3.9) ----------

  /** Owner sets or resets a PIN. Returns the PIN once; only its salted hash is stored. */
  function setPin(ctx, actor, personId, pin) {
    return ctx.env.withLock(function () { return setPinLocked(ctx, actor, personId, pin); });
  }
  function setPinLocked(ctx, actor, personId, pin) {
    if (actor.role !== 'owner') fail('FORBIDDEN', 'Only the owner can set a PIN.');
    if (!/^\d{4,6}$/.test(pin)) fail('BAD_PIN', 'PIN must be 4 to 6 digits.');
    var salt = ctx.env.randomId();
    ctx.db.update('People', personId, { pinSalt: salt, pinHash: ctx.env.sha256(salt + ':' + pin), pinTries: 0, pinLockedUntil: 0 });
    audit(ctx, actor.id, 'pin.set', personId);
    return { ok: true };
  }

  /**
   * Login from a phone. First login on a phone creates a device request that only the
   * owner can approve. The device token is returned once; the server keeps only its hash.
   */
  function login(ctx, personId, pin, deviceToken, deviceLabel) {
    return ctx.env.withLock(function () { return loginLocked(ctx, personId, pin, deviceToken, deviceLabel); });
  }
  function loginLocked(ctx, personId, pin, deviceToken, deviceLabel) {
    var p = find(ctx, 'People', personId);
    if (!p || p.active === false) fail('LOGIN', 'Wrong name or PIN.');
    var known = null;
    if (deviceToken) {
      var hash = ctx.env.sha256(String(deviceToken));
      known = ctx.db.rows('Devices').filter(function (d) { return d.personId === personId && d.tokenHash === hash; })[0] || null;
    }
    // The person's own approved phone has its own counter, so a stranger hammering the public
    // sign-in screen cannot lock a staff member out of the phone they already use.
    var own = known && known.status === 'approved';
    var lockedUntil = own ? known.pinLockedUntil : p.pinLockedUntil;
    if (lockedUntil && ctx.now < lockedUntil) fail('LOCKED', 'Too many wrong PINs. Try again later, or ask the owner to reset your PIN.');
    if (!p.pinHash || ctx.env.sha256(p.pinSalt + ':' + pin) !== p.pinHash) {
      var tries = ((own ? known.pinTries : p.pinTries) || 0) + 1;
      var patch = { pinTries: tries };
      if (tries >= PIN_MAX_TRIES) {
        var level = ((own ? known.pinLockLevel : p.pinLockLevel) || 0) + 1;
        patch.pinTries = 0; patch.pinLockedUntil = ctx.now + Math.min(PIN_LOCK_MAX_MS, PIN_LOCK_MS * Math.pow(4, level - 1));
        patch.pinLockLevel = level;
      }
      if (own) ctx.db.update('Devices', known.id, patch); else ctx.db.update('People', personId, patch);
      audit(ctx, personId, 'login.wrong-pin', personId);
      failKeep('LOGIN', 'Wrong name or PIN.');
    }
    // A right PIN clears only the counter it was checked against: signing in on the approved phone
    // does not lift a lock that guesses from elsewhere have earned.
    if (own) { if (known.pinTries || known.pinLockedUntil || known.pinLockLevel || known.signedOut) ctx.db.update('Devices', known.id, { pinTries: 0, pinLockedUntil: 0, pinLockLevel: 0, signedOut: false }); }
    else if (p.pinTries || p.pinLockedUntil || p.pinLockLevel) ctx.db.update('People', personId, { pinTries: 0, pinLockedUntil: 0, pinLockLevel: 0 });

    // A phone that was rejected or removed may ask again (a new request, a new token); it never comes back by itself.
    if (known && (known.status === 'approved' || known.status === 'pending')) return { ok: known.status === 'approved', deviceStatus: known.status, deviceId: known.id };
    var waiting = ctx.db.rows('Devices').filter(function (d) { return d.personId === personId && d.status === 'pending'; }).length;
    if (waiting >= MAX_PENDING_PHONES) fail('BLOCKED', 'Phone requests for this account are already waiting. Ask the owner to approve or reject them.');
    var token = ctx.env.randomId() + ctx.env.randomId();
    var dev = { id: ctx.env.randomId(), personId: personId, tokenHash: ctx.env.sha256(token), label: String(deviceLabel || '').slice(0, 120),
      status: 'pending', requestedAt: ctx.now, decidedAt: '', decidedBy: '', pinTries: 0, pinLockedUntil: 0, pinLockLevel: 0, signedOut: false };
    // The owner's very first phone is approved automatically (otherwise nobody could approve anything).
    var anyOwnerDevice = ctx.db.rows('Devices').some(function (d) { var o = find(ctx, 'People', d.personId); return o && o.role === 'owner' && d.status === 'approved'; });
    if (p.role === 'owner' && !anyOwnerDevice) { dev.status = 'approved'; dev.decidedAt = ctx.now; dev.decidedBy = 'bootstrap'; }
    ctx.db.insert('Devices', dev);
    audit(ctx, personId, 'device.request', dev.id, { label: dev.label, status: dev.status });
    if (dev.status === 'pending' && !waiting) byRole(ctx, 'owner').forEach(function (o) {
      notify(ctx, o.id, 'device', 'New phone request', p.name + ' wants to sign in on a new phone.', dev.id);
    });
    return { ok: dev.status === 'approved', deviceStatus: dev.status, deviceId: dev.id, deviceToken: token };
  }

  function decideDevice(ctx, actor, deviceId, approve) {
    return ctx.env.withLock(function () { return decideDeviceLocked(ctx, actor, deviceId, approve); });
  }
  function decideDeviceLocked(ctx, actor, deviceId, approve) {
    if (actor.role !== 'owner') fail('FORBIDDEN', 'Only the owner can approve a phone.');
    var dev = find(ctx, 'Devices', deviceId);
    if (dev && dev.status === 'approved' && !approve) {
      // Lost or stolen phone: the owner switches it off. It can never be used again.
      var owner = find(ctx, 'People', dev.personId);
      var otherOwnerPhones = ctx.db.rows('Devices').filter(function (d) { var o = find(ctx, 'People', d.personId); return d.id !== dev.id && d.status === 'approved' && o && o.role === 'owner' && o.active !== false; }).length;
      if (owner && owner.role === 'owner' && !otherOwnerPhones) fail('BLOCKED', 'This is the only approved owner phone. Approve another owner phone first.');
      ctx.db.update('Devices', deviceId, { status: 'revoked', decidedAt: ctx.now, decidedBy: actor.id });
      audit(ctx, actor.id, 'device.revoke', deviceId);
      notify(ctx, dev.personId, 'device', 'Phone removed', 'This phone can no longer use the app. Ask the owner.', deviceId);
      return { ok: true, status: 'revoked' };
    }
    if (!dev || dev.status !== 'pending') fail('NOT_FOUND', 'No such pending phone request.');
    if (approve) {
      // One phone per person: approving a new phone revokes the old one.
      ctx.db.rows('Devices').forEach(function (d) {
        if (d.personId === dev.personId && d.status === 'approved') ctx.db.update('Devices', d.id, { status: 'revoked', decidedAt: ctx.now, decidedBy: actor.id });
      });
    }
    ctx.db.update('Devices', deviceId, { status: approve ? 'approved' : 'rejected', decidedAt: ctx.now, decidedBy: actor.id });
    audit(ctx, actor.id, approve ? 'device.approve' : 'device.reject', deviceId);
    notify(ctx, dev.personId, 'device', approve ? 'Phone approved' : 'Phone not approved', approve ? 'You can now use the app on this phone.' : 'Ask the owner.', deviceId);
    return { ok: true };
  }

  /** "Sign out": from now on this phone's token is refused until the PIN is entered on it again. */
  function signOut(ctx, actor) {
    return ctx.env.withLock(function () {
      ctx.db.update('Devices', actor.deviceId, { signedOut: true });
      audit(ctx, actor.id, 'signout', actor.deviceId);
      return { ok: true };
    });
  }

  /** Every API call: who is this? Only an approved phone bound to that person passes. */
  function authenticate(ctx, personId, deviceToken) {
    var p = find(ctx, 'People', personId);
    if (!p || p.active === false || !deviceToken) fail('AUTH', 'Please sign in again.');
    var hash = ctx.env.sha256(deviceToken);
    var dev = ctx.db.rows('Devices').filter(function (d) { return d.personId === personId && d.tokenHash === hash && d.status === 'approved'; })[0];
    if (!dev) fail('AUTH', 'This phone is not approved for this account.');
    if (dev.signedOut) fail('AUTH', 'Please sign in again.'); // after Sign out the token alone opens nothing: the PIN is needed
    return { id: p.id, name: p.name, role: p.role, deviceId: dev.id };
  }

  // ---------- Leave ----------

  function peopleMap(ctx) {
    var m = {};
    ctx.db.rows('People').forEach(function (p) { if (p.active !== false) m[p.name] = p; });
    return m;
  }
  function rules(ctx) { var r = ctx.db.rows('Rules'); return r.length ? r : Clash.DEFAULT_RULES; }

  /** Approved away entries of everyone except one request (by id). */
  function approvedAway(ctx, exceptId) {
    var names = {}; ctx.db.rows('People').forEach(function (p) { names[p.id] = p.name; });
    var out = [];
    ctx.db.rows('LeaveRequests').forEach(function (r) {
      if (r.id === exceptId) return;
      if (r.status !== 'Approved' && r.status !== 'Recorded') return;
      r.dates.forEach(function (d) { out.push({ person: names[r.personId], date: d, kind: r.kind, extreme: !!r.extremeEmergency }); });
    });
    ctx.db.rows('DayMinutes').forEach(function (m) { out.push({ person: names[m.personId], date: m.date, kind: m.kind }); });
    // Planned late/early and approved outings also make a person "away" that day.
    ctx.db.rows('ShortRequests').forEach(function (q) {
      if (q.status === 'Approved' && q.id !== exceptId) out.push({ person: names[q.personId], date: q.date, kind: q.kind });
    });
    ctx.db.rows('Outings').forEach(function (o) {
      if (o.id !== exceptId && (o.status === 'Approved' || o.status === 'Back' || o.status === 'Confirmed')) out.push({ person: names[o.personId], date: o.date, kind: 'out' });
    });
    return out;
  }

  function liveLeaves(ctx, personId, exceptId) {
    return ctx.db.rows('LeaveRequests').filter(function (r) {
      return r.personId === personId && r.id !== exceptId && (GRANTED[r.status] || OPEN[r.status] || r.status === ABSENT);
    });
  }

  function violationsInMonth(ctx, personId, monthKey) {
    return ctx.db.rows('Violations').filter(function (v) {
      return v.personId === personId && Cal.monthKey(v.date) === monthKey && v.disputeState !== 'removed';
    }).length;
  }

  /**
   * Evaluate a request against every rule. Used for the live preview and again on submit,
   * on edit and at approval time. Never writes.
   */
  function evaluate(ctx, person, input, exceptId, opts) {
    var problems = [];
    var dates = (input.dates || []).slice().sort();
    if (!dates.length) problems.push('Pick exact dates.');
    dates.forEach(function (d, i) {
      if (!Cal.isDate(d)) problems.push('Invalid date.');
      if (i && Cal.addDays(dates[i - 1], 1) !== d) problems.push('Dates in one request must be consecutive.');
    });
    if (input.kind !== 'full' && input.kind !== 'half') problems.push('Choose full day or half day.');
    if (input.kind === 'half' && (dates.length !== 1 || !Cal.isTime(input.halfStart))) problems.push('A half day is one date with a start time.');
    else if (input.kind === 'half' && (hhmmToMin(input.halfStart) < hhmmToMin(person.dutyStart) || hhmmToMin(input.halfStart) + HALF_DAY_MINUTES > hhmmToMin(person.dutyEnd)))
      problems.push('The half day (4 h 30 min) must be inside your duty hours.');
    if (REASONS.indexOf(input.reasonCode) === -1) problems.push('Choose a reason.');
    if (!String(input.reasonText || '').trim()) problems.push('Write the reason.');
    if (problems.length) return { decision: 'blocked', reasons: problems, valid: false };

    var lockedSet = lockedMonths(ctx);
    if (dates.some(function (d) { return lockedSet[Cal.monthKey(d)]; })) return { decision: 'blocked', reasons: ['This month is locked.'], valid: false };

    var others = liveLeaves(ctx, person.id, exceptId);
    var overlap = others.some(function (r) { return r.dates.some(function (d) { return dates.indexOf(d) !== -1; }); });
    if (overlap) return { decision: 'blocked', reasons: ['You already have a request on one of these dates. Edit or cancel it first.'], valid: false };

    // Notice runs from the SERVER time of sending to the person's duty start on the first leave day
    // (handoff 3.4), also for a half day. Nothing the phone sends can change that time; only an
    // entry by Aakash or Varun may carry the time of the phone call it records (opts.at).
    var dutyStartAt = toMs(dates[0], person.dutyStart);
    var submittedAt = (opts && opts.at) || ctx.now;
    var noticeHours = (dutyStartAt - submittedAt) / 3600000;
    var type = Leave.noticeType(submittedAt, dutyStartAt);

    var people = peopleMap(ctx);
    var clash = Clash.checkRequest({ person: person.name, dates: dates, extremeEmergency: !!input.extremeEmergency }, people, approvedAway(ctx, exceptId), rules(ctx));
    var restr = Leave.checkRestrictions(person.name, person, dates, ctx.db.rows('Restrictions'));

    var approvedDates = [];
    others.forEach(function (r) { if (r.kind === 'full') approvedDates = approvedDates.concat(r.dates); });
    var run = input.kind === 'full' ? Leave.runLength(person, dates, approvedDates) : 1;

    // Emergency number in the month of the first day.
    var month = Cal.monthKey(dates[0]);
    var closed = closedSet(ctx);
    var emergencyNo = 0;
    if (type === 'Emergency') {
      emergencyNo = 1 + others.filter(function (r) { return r.type === 'Emergency' && Cal.monthKey(r.dates[0]) === month; }).length;
    }
    var penaltyEmergency = emergencyNo > 0 && Leave.isPenaltyEmergency(emergencyNo);

    // Quota after this request, for EVERY month the request touches (a leave across a month end
    // is checked against both months). Counted: leaves, auto absences, automatic half days.
    var amount = input.kind === 'half' ? 0.5 : 1;
    var days = [];
    others.forEach(function (r) { r.dates.forEach(function (d) { if (!closed[d]) days.push({ date: d, amount: r.kind === 'half' ? 0.5 : 1, penaltyEmergency: !!r.penaltyEmergency && !!GRANTED[r.status] }); }); });
    autoDays(ctx, person.id).forEach(function (a) { days.push({ date: a.date, amount: a.amount }); });
    dates.forEach(function (d) { if (!closed[d]) days.push({ date: d, amount: amount, penaltyEmergency: penaltyEmergency }); });
    var quota = Leave.monthQuota(person, month, days), worst = quota;
    dates.forEach(function (d) {
      var q = Leave.monthQuota(person, Cal.monthKey(d), days);
      if (q.total > worst.total) worst = q;
    });
    var leaveDays = dates.filter(function (d) { return !closed[d] && !Cal.isRosterOff(person, d); }).length;

    var routed = Leave.route({
      person: { noApproval: person.noApproval, isManager: person.role === 'manager', alwaysAakash: person.group === 'Housekeeping' },
      days: leaveDays, run: run, noticeHours: noticeHours, type: type, restrictionViolation: restr.violations > 0,
      clash: clash, restricted: restr.blocked, quotaAfter: worst.total,
      violationsThisMonth: violationsInMonth(ctx, person.id, Cal.monthKey(today(ctx)))
    });
    if (restr.blocked) routed.reasons = restr.hits.map(function (h) { return h.message; });

    var warnings = [];
    if (type === 'Unannounced') warnings.push('Less than 3 hours notice: this is an unannounced leave and counts as 1 violation.');
    if (penaltyEmergency) warnings.push('This is emergency no. ' + emergencyNo + ' this month: 1 violation, and it is not a free leave.');
    if (restr.violations) warnings.push(restr.hits[0].message);
    if (worst.daysAboveQuota > 0 && !person.noQuota) warnings.push('Above the 5 free leaves ' + (worst === quota ? 'this month' : 'in the second month') + ' by ' + worst.daysAboveQuota + '.');
    if (input.kind === 'half' && hhmmToMin(input.halfStart) > hhmmToMin(person.dutyStart) && hhmmToMin(input.halfStart) + HALF_DAY_MINUTES < hhmmToMin(person.dutyEnd))
      warnings.push('This half day is in the middle of your shift. Do not check out when you leave: come back after it and check out at the end of duty. If you check out when it starts, the time after it counts as leaving early.');
    if (clash.ok) {
      // A request that is still waiting blocks no one, but the applicant is told: the first one approved holds the slot.
      var names = {}; ctx.db.rows('People').forEach(function (x) { names[x.id] = x.name; });
      var waiting = [];
      ctx.db.rows('LeaveRequests').forEach(function (r) {
        if (OPEN[r.status] && r.id !== exceptId && r.personId !== person.id) r.dates.forEach(function (d) { waiting.push({ person: names[r.personId], date: d, kind: r.kind }); });
      });
      if (waiting.length) {
        var maybe = Clash.checkRequest({ person: person.name, dates: dates, extremeEmergency: !!input.extremeEmergency }, people, approvedAway(ctx, exceptId).concat(waiting), rules(ctx));
        if (!maybe.ok) warnings.push('Possible clash: ' + maybe.blocks.map(function (b) { return (b.who || []).join(' and '); }).filter(function (x, i, a) { return x && a.indexOf(x) === i; }).join(', ') +
          ' has a request waiting for the same day. The first one approved holds the slot.');
      }
    }
    if (clash.extremeEmergencyPossible) warnings.push('Only possible as an extreme emergency, with Aakash’s approval.');

    return {
      valid: true, decision: routed.decision, reasons: routed.reasons, warnings: warnings,
      dates: dates, type: type, noticeHours: Math.round(noticeHours * 10) / 10, run: run, submittedAt: submittedAt,
      emergencyNo: emergencyNo, penaltyEmergency: penaltyEmergency, restrictionViolation: restr.violations > 0,
      quota: person.noQuota ? null : { total: worst.total, left: worst.left, daysAboveQuota: worst.daysAboveQuota }
    };
  }

  function previewLeave(ctx, actor, input) {
    return evaluate(ctx, find(ctx, 'People', actor.id), input, input.editId);
  }

  function addViolation(ctx, personId, date, rule, ref) {
    var who = find(ctx, 'People', personId);
    if (who && who.noApproval) return; // records only (intern): never a violation
    ctx.db.insert('Violations', { id: ctx.env.randomId(), personId: personId, date: date, rule: rule, source: 'auto', proof: ref,
      note: '', createdBy: 'system', createdAt: stamp(ctx), disputeState: '', disputeAt: '', disputeText: '', disputeDecidedBy: '', disputeDecidedAt: '' });
    byRole(ctx, 'owner').concat(byRole(ctx, 'manager')).forEach(function (m) { notify(ctx, m.id, 'violation', 'Violation recorded', ruleLabel(rule), ref); });
    notify(ctx, personId, 'violation', 'Violation recorded', ruleLabel(rule) + '. You can dispute it within 24 hours.', ref);
  }

  /** Violations that came from a request are withdrawn (never deleted) when the request is edited or cancelled. */
  function withdrawViolations(ctx, leaveId, note) {
    ctx.db.rows('Violations').forEach(function (v) { if (v.proof === leaveId && v.disputeState !== 'removed') ctx.db.update('Violations', v.id, { disputeState: 'removed', note: note }); });
  }

  /** "Absent – unannounced" for one date (full day, or the half that no leave covers) + 1 violation. */
  function markAbsent(ctx, p, date, kind, why) {
    var row = { id: ctx.env.randomId(), personId: p.id, kind: kind || 'full', dates: [date], halfStart: '', reasonCode: '', reasonText: '', submittedAt: ctx.now,
      type: 'Unannounced', noticeHours: 0, run: 1, route: 'system', status: p.noApproval ? 'Recorded' : ABSENT, approvals: {},
      extremeEmergency: false, emergencyNo: 0, penaltyEmergency: false, restrictionViolation: false, enteredBy: 'system', decidedAt: ctx.now,
      decidedBy: 'system', decisionReason: why || '', history: [{ at: ctx.now, by: 'system', action: 'absent-no-request' }] };
    ctx.db.insert('LeaveRequests', row);
    var day = date.slice(8) + '-' + date.slice(5, 7);
    if (!p.noApproval) {
      ctx.db.insert('Violations', { id: ctx.env.randomId(), personId: p.id, date: date, rule: 'absent-no-request', source: 'auto', proof: row.id, note: '',
        createdBy: 'system', createdAt: stamp(ctx), disputeState: '', disputeAt: '', disputeText: '', disputeDecidedBy: '', disputeDecidedAt: '' });
      notify(ctx, p.id, 'violation', ABSENT, (why || 'No request and no check-in') + ' on ' + day + '.', row.id);
    }
    byRole(ctx, 'owner').concat(byRole(ctx, 'manager')).forEach(function (m) { notify(ctx, m.id, 'absent', ABSENT + ': ' + p.name, day + (kind === 'half' ? ' (half day)' : ''), row.id); });
    audit(ctx, 'system', 'absent.auto', row.id);
    return row;
  }
  function hasCheckIn(ctx, personId, date) {
    return ctx.db.rows('Punches').some(function (x) { return x.personId === personId && x.date === date && x.kind === 'in'; });
  }
  /** Has this working day ended for the person (server time)? */
  function dayOver(ctx, person, date) { return ctx.now >= toMs(date, person.dutyEnd); }

  /** Called whenever a request becomes Approved or Recorded. */
  function onGranted(ctx, r) {
    // Which emergency of the month this is, is settled NOW, among the GRANTED ones only:
    // a request that was rejected or is still waiting never pushes another one over the limit.
    if (r.type === 'Emergency') {
      var month = Cal.monthKey(r.dates[0]);
      var n = 1 + ctx.db.rows('LeaveRequests').filter(function (x) {
        return x.id !== r.id && x.personId === r.personId && x.type === 'Emergency' && GRANTED[x.status] && Cal.monthKey(x.dates[0]) === month;
      }).length;
      var pen = Leave.isPenaltyEmergency(n);
      if (n !== r.emergencyNo || pen !== !!r.penaltyEmergency) ctx.db.update('LeaveRequests', r.id, { emergencyNo: n, penaltyEmergency: pen });
      r = Object.assign({}, r, { emergencyNo: n, penaltyEmergency: pen });
    } else if (r.penaltyEmergency) { ctx.db.update('LeaveRequests', r.id, { penaltyEmergency: false }); r = Object.assign({}, r, { penaltyEmergency: false }); }
    // A "+1 violation" restriction counts as it stands NOW, at the moment the leave is granted.
    var who = find(ctx, 'People', r.personId);
    if (who && r.route !== 'override') {
      var rv = Leave.checkRestrictions(who.name, who, r.dates, ctx.db.rows('Restrictions')).violations > 0;
      if (rv !== !!r.restrictionViolation) { ctx.db.update('LeaveRequests', r.id, { restrictionViolation: rv }); r = Object.assign({}, r, { restrictionViolation: rv }); }
    }
    if (r.type === 'Unannounced') addViolation(ctx, r.personId, r.dates[0], 'unannounced-leave', r.id);
    if (r.penaltyEmergency) addViolation(ctx, r.personId, r.dates[0], 'emergency-beyond-2', r.id);
    if (r.restrictionViolation) addViolation(ctx, r.personId, r.dates[0], 'leave-in-restricted-period', r.id);
    r.dates.forEach(function (d) {
      // The person may already have arrived or left today while this was waiting: that day is counted again.
      if (hooks.recountDay) hooks.recountDay(ctx, r.personId, d);
      // A half day granted for a day that has gone by with no check-in at all: the other half is an absence.
      if (r.kind === 'half' && who && who.role === 'staff' && !who.noApproval && d <= today(ctx) && dayOver(ctx, who, d) && !hasCheckIn(ctx, r.personId, d) &&
        !ctx.db.rows('LeaveRequests').some(function (x) { return x.personId === r.personId && x.route === 'system' && x.dates.indexOf(d) !== -1; }))
        markAbsent(ctx, who, d, 'half', 'Half day, but no check-in for the other half');
    });
  }

  var hooks = {}; // set by the attendance module (which this module cannot load itself)
  var STATUS_FOR = { aakash: 'Pending with Aakash', special: 'Special – waiting', varun: 'Pending with Varun', auto: 'Approved', recorded: 'Recorded' };

  /**
   * Submit a leave request. Each person applies only for themselves; a manager/owner may
   * enter one for someone else, and it is labelled "entered by".
   */
  function submitLeave(ctx, actor, input) {
    return ctx.env.withLock(function () {
      var personId = input.forPersonId || actor.id;
      if (personId !== actor.id && actor.role === 'staff') fail('FORBIDDEN', 'You can apply only for yourself.');
      var person = find(ctx, 'People', personId);
      if (!person) fail('NOT_FOUND', 'No such person.');
      var opts = null, called = '';
      if (personId !== actor.id && input.calledAt !== undefined && input.calledAt !== '') {
        // "Called – emergency": Aakash records a phone call. Notice runs from the time of the call.
        if (!Cal.isTime(input.calledAt)) fail('BLOCKED', 'Enter the exact time of the call.');
        var at = toMs(today(ctx), input.calledAt);
        if (at > ctx.now) at -= 86400000; // a time later than now means yesterday evening
        if (ctx.now - at > 86400000) fail('BLOCKED', 'The call time must be within the last 24 hours.');
        opts = { at: at }; called = input.calledAt;
      }
      var ev = evaluate(ctx, person, input, undefined, opts);
      if (ev.decision === 'blocked') fail('BLOCKED', ev.reasons.join(' '));
      var row = {
        id: ctx.env.randomId(), personId: personId, kind: input.kind, dates: ev.dates, halfStart: input.halfStart || '',
        reasonCode: input.reasonCode, reasonText: String(input.reasonText).trim(), submittedAt: ctx.now, noticeAt: opts ? opts.at : '', type: ev.type,
        noticeHours: ev.noticeHours, run: ev.run, route: ev.decision, status: STATUS_FOR[ev.decision],
        approvals: ev.decision === 'special' ? { aakash: '', varun: '' } : {}, extremeEmergency: !!input.extremeEmergency,
        emergencyNo: ev.emergencyNo, penaltyEmergency: ev.penaltyEmergency, restrictionViolation: ev.restrictionViolation,
        enteredBy: personId === actor.id ? '' : actor.id, decidedAt: '', decidedBy: '', decisionReason: '',
        history: [{ at: ctx.now, by: actor.id, action: called ? 'called – emergency (' + called + ')' : 'submitted' }]
      };
      if (ev.decision === 'auto' || ev.decision === 'recorded') { row.decidedAt = ctx.now; row.decidedBy = 'system'; }
      ctx.db.insert('LeaveRequests', row);
      audit(ctx, actor.id, 'leave.submit', row.id, { status: row.status });
      if (row.status === 'Approved' || row.status === 'Recorded') onGranted(ctx, row);
      if (row.route === 'aakash' || row.route === 'special') byRole(ctx, 'manager').forEach(function (m) { notify(ctx, m.id, 'approval', 'Leave request', person.name + ': ' + ev.dates.join(', '), row.id); });
      if (row.route === 'varun' || row.route === 'special') byRole(ctx, 'owner').forEach(function (o) { notify(ctx, o.id, 'approval', row.route === 'special' ? 'Special approval' : 'Leave request', person.name + ': ' + ev.dates.join(', '), row.id); });
      notify(ctx, personId, 'decision', 'Leave: ' + row.status, ev.dates.join(', '), row.id);
      return { id: row.id, status: row.status, warnings: ev.warnings };
    });
  }

  /**
   * Approve or reject. Under a server lock. The clash rules are checked again at this moment:
   * if another approval got there first, this request becomes "Rejected - clash".
   */
  function decideLeave(ctx, actor, id, approve, reason) {
    return ctx.env.withLock(function () {
      var r = find(ctx, 'LeaveRequests', id);
      if (!r || !OPEN[r.status]) fail('NOT_FOUND', 'This request is not waiting for a decision.');
      assertOpen(ctx, r.dates);
      if (r.personId === actor.id) fail('FORBIDDEN', 'Nobody approves their own leave.');
      if (actor.role === 'staff') fail('FORBIDDEN', 'Only Aakash or Varun can decide.');
      var person = find(ctx, 'People', r.personId);
      if (r.route === 'varun' && actor.role !== 'owner') fail('FORBIDDEN', 'Only Varun can decide this.');
      if (!approve && !String(reason || '').trim()) fail('REASON', 'A reason is required to reject.');

      var hist = r.history.concat([{ at: ctx.now, by: actor.id, action: approve ? 'approved' : 'rejected', reason: reason || '' }]);
      function finish(status, why) {
        ctx.db.update('LeaveRequests', id, { status: status, decidedAt: ctx.now, decidedBy: actor.id, decisionReason: why || '', history: hist });
        audit(ctx, actor.id, 'leave.decide', id, { status: status });
        notify(ctx, r.personId, 'decision', 'Leave: ' + status, r.dates.join(', ') + (why ? ' — ' + why : ''), id);
        // An edited request kept the violations of its old version until this decision.
        if (status === 'Approved' || status === 'Rejected') withdrawViolations(ctx, id, 'Request decided again after an edit');
        if (status === 'Approved') onGranted(ctx, Object.assign({}, r, { status: status }));
        return { id: id, status: status };
      }

      if (!approve) {
        var out = finish('Rejected', reason);
        // Rejected after the day has already gone by with no check-in: that day is an absence with no approval.
        r.dates.forEach(function (d) {
          if (person.role !== 'staff') return; // Aakash and Varun are not tracked
          if (d > today(ctx) || Cal.isRosterOff(person, d) || closedSet(ctx)[d] || hasCheckIn(ctx, person.id, d) || !dayOver(ctx, person, d)) return;
          if (ctx.db.rows('LeaveRequests').some(function (x) { return x.personId === person.id && x.route === 'system' && x.dates.indexOf(d) !== -1; })) return;
          markAbsent(ctx, person, d, 'full', 'Leave request rejected, and no check-in');
        });
        return out;
      }
      // A restriction added after the request was sent still holds: only Varun can override it.
      var restr = Leave.checkRestrictions(person.name, person, r.dates, ctx.db.rows('Restrictions'));
      if (restr.blocked) fail('BLOCKED', restr.hits.filter(function (h) { return h.rule === 'no-leave'; })[0].message + ' Reject it, or Varun can override.');

      if (r.route === 'special') {
        var key = actor.role === 'owner' ? 'varun' : 'aakash';
        var approvals = Object.assign({}, r.approvals); approvals[key] = 'yes';
        if (!(approvals.aakash === 'yes' && approvals.varun === 'yes')) {
          ctx.db.update('LeaveRequests', id, { approvals: approvals, history: hist });
          audit(ctx, actor.id, 'leave.special-approve', id, approvals);
          return { id: id, status: r.status, approvals: approvals };
        }
        ctx.db.update('LeaveRequests', id, { approvals: approvals });
      }

      // Re-check clash and restrictions at the moment of approval.
      var clash = Clash.checkRequest({ person: person.name, dates: r.dates, extremeEmergency: r.extremeEmergency }, peopleMap(ctx), approvedAway(ctx, id), rules(ctx));
      if (!clash.ok) {
        var res = finish('Rejected – clash', clash.blocks[0].message);
        byRole(ctx, 'manager').forEach(function (m) { notify(ctx, m.id, 'clash', 'Rejected – clash', person.name + ': ' + clash.blocks[0].message, id); });
        // The person who holds the slot is told too (never the other person's reason).
        var holders = {}; clash.blocks.forEach(function (b) { (b.who || []).forEach(function (w) { holders[w] = b.date; }); });
        Object.keys(holders).forEach(function (name) {
          var h = peopleMap(ctx)[name];
          if (h) notify(ctx, h.id, 'clash', 'A clashing request was rejected', person.name + ' asked for ' + r.dates.join(', ') + '. Your approved time off keeps the slot.', id);
        });
        return res;
      }
      return finish('Approved', reason);
    });
  }

  /** Staff can cancel their own request until it starts. After that only Aakash or Varun, with a reason. */
  function cancelLeave(ctx, actor, id, reason) {
    return ctx.env.withLock(function () {
      var r = find(ctx, 'LeaveRequests', id);
      if (!r || r.status === 'Cancelled' || r.status.indexOf('Rejected') === 0 || r.route === 'system') fail('NOT_FOUND', 'Nothing to cancel.');
      assertOpen(ctx, r.dates);
      var person = find(ctx, 'People', r.personId);
      var started = ctx.now >= toMs(r.dates[0], r.kind === 'half' ? r.halfStart : person.dutyStart);
      var isBoss = actor.role !== 'staff';
      if (actor.id !== r.personId && !isBoss) fail('FORBIDDEN', 'You can cancel only your own request.');
      if (started && !isBoss) fail('FORBIDDEN', 'This leave has started. Ask Aakash or Varun.');
      if (isBoss && actor.id !== r.personId && !String(reason || '').trim()) fail('REASON', 'A reason is required.');
      ctx.db.update('LeaveRequests', id, { status: 'Cancelled', history: r.history.concat([{ at: ctx.now, by: actor.id, action: 'cancelled', reason: reason || '' }]) });
      if (!started) withdrawViolations(ctx, id, 'Request cancelled before it started');
      audit(ctx, actor.id, 'leave.cancel', id, { reason: reason || '' });
      if (actor.id !== r.personId) notify(ctx, r.personId, 'decision', 'Leave cancelled', r.dates.join(', ') + ' — ' + reason, id);
      return { id: id, status: 'Cancelled' };
    });
  }

  var api = { REASONS: REASONS, setPin: setPin, login: login, decideDevice: decideDevice, authenticate: authenticate,
    signOut: signOut, previewLeave: previewLeave, submitLeave: submitLeave, decideLeave: decideLeave, cancelLeave: cancelLeave, toMs: toMs,
    _: { hooks: hooks, lockedMonths: lockedMonths, assertOpen: assertOpen, stamp: stamp, fail: fail, failKeep: failKeep, closedSet: closedSet, autoDays: autoDays, markAbsent: markAbsent, hasCheckIn: hasCheckIn, dayOver: dayOver,
      withdrawViolations: withdrawViolations, GRANTED: GRANTED, ABSENT: ABSENT, HALF_DAY_MINUTES: HALF_DAY_MINUTES, settingValue: settingValue, hhmmToMin: hhmmToMin, find: find, audit: audit, notify: notify, byRole: byRole, today: today, peopleMap: peopleMap, rules: rules,
      approvedAway: approvedAway, liveLeaves: liveLeaves, IST_OFFSET_MS: IST_OFFSET_MS,
      evaluate: evaluate, onGranted: onGranted, ruleLabel: ruleLabel, STATUS_FOR: STATUS_FOR, OPEN: OPEN } };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.GJCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);

// ===== src/server/attendance.js =====
/**
 * Attendance: check-in / check-out, informed late / early requests, going out,
 * end-of-day absent job and the "My month" page data (handoff 3.5, 3.8, 3.10).
 * All times are SERVER time. The phone clock is never trusted.
 */
(function (root) {
  'use strict';
  var req = (typeof require !== 'undefined') ? require : null;
  var Cal = req ? req('../rules/calendar.js') : root.GJCalendar;
  var Clash = req ? req('../rules/clash.js') : root.GJClash;
  var Leave = req ? req('../rules/leave.js') : root.GJLeave;
  var Minutes = req ? req('../rules/minutes.js') : root.GJMinutes;
  var Core = req ? req('./core.js') : root.GJCore;
  var H = Core._;

  var HALF_DAY_MINUTES = 270;       // owner: a half day is any 4 h 30 min
  var SHOP_RADIUS_M = 50;

  function hhmmToMin(t) { var a = t.split(':'); return +a[0] * 60 + +a[1]; }
  function minToHhmm(m) { return ('0' + Math.floor(m / 60)).slice(-2) + ':' + ('0' + (m % 60)).slice(-2); }
  function nowMin(ctx) { var d = new Date(ctx.now + H.IST_OFFSET_MS); return d.getUTCHours() * 60 + d.getUTCMinutes(); }
  function setting(ctx, key) { var s = ctx.db.rows('Settings').filter(function (x) { return x.key === key; })[0]; return s ? s.value : ''; }

  function grantedLeaveOn(ctx, personId, date) {
    return ctx.db.rows('LeaveRequests').filter(function (r) {
      return r.personId === personId && (r.status === 'Approved' || r.status === 'Recorded') && r.dates.indexOf(date) !== -1;
    })[0];
  }

  /** Expected start and end of work today, moved by an approved half day at either end. */
  function expectedDay(ctx, person, date) {
    var start = hhmmToMin(person.dutyStart), end = hhmmToMin(person.dutyEnd);
    var lv = grantedLeaveOn(ctx, person.id, date);
    var win = null;
    if (lv && lv.kind === 'half' && lv.halfStart) {
      var hs = hhmmToMin(lv.halfStart), he = hs + HALF_DAY_MINUTES;
      if (hs <= start) start = Math.min(he, end);
      else if (he >= end) end = hs;
      else win = { from: hs, to: he }; // a half day in the middle of the shift: an approved window
    }
    return { start: start, end: end, win: win, fullLeave: !!(lv && lv.kind === 'full') };
  }
  /** Duty minutes between a and b that are NOT inside the approved half-day window. */
  function uncovered(a, b, win) {
    if (b <= a) return 0;
    var inside = win ? Math.max(0, Math.min(b, win.to) - Math.max(a, win.from)) : 0;
    return (b - a) - inside;
  }

  function punchesToday(ctx, personId, date, kind) {
    return ctx.db.rows('Punches').filter(function (p) { return p.personId === personId && p.date === date && p.kind === kind; });
  }

  function distanceM(lat1, lng1, lat2, lng2) {
    var R = 6371000, toRad = Math.PI / 180;
    var dLat = (lat2 - lat1) * toRad, dLng = (lng2 - lng1) * toRad;
    var a = Math.sin(dLat / 2) * Math.sin(dLat / 2) + Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
    return Math.round(2 * R * Math.asin(Math.sqrt(a)));
  }

  function addDayMinutes(ctx, personId, date, kind, minutes, informed, statedMinutes, source, shortId) {
    var row = { id: ctx.env.randomId(), personId: personId, date: date, kind: kind, minutes: minutes, informed: informed,
      statedMinutes: statedMinutes === undefined ? '' : statedMinutes, source: source, note: '', shortId: shortId || '' };
    ctx.db.insert('DayMinutes', row);
    return row;
  }

  function checkClashToday(ctx, person, date, exceptId) {
    var clash = Clash.checkRequest({ person: person.name, dates: [date] }, H.peopleMap(ctx), H.approvedAway(ctx, exceptId), H.rules(ctx));
    if (!clash.ok) H.fail('BLOCKED', clash.blocks[0].message);
  }

  // ---------- Informed late / early ----------

  /**
   * "I will be late" (before duty start, with the expected arrival time) or
   * "I will leave early" (before leaving, with the time).
   * Owner, 20 Nov 2026: the staff member can send it, but Aakash must APPROVE it.
   * The minutes are "informed" only when it is approved. If Aakash decides after the person
   * has already arrived or left, the day is corrected at that moment (approved = informed,
   * rejected = not informed).
   */
  function requestShort(ctx, actor, a) {
    return ctx.env.withLock(function () {
      var person = H.find(ctx, 'People', actor.id);
      var date = a.date || H.today(ctx);
      if (!Cal.isDate(date)) H.fail('BLOCKED', 'Pick an exact date.');
      if (a.kind !== 'late' && a.kind !== 'early') H.fail('BLOCKED', 'Choose late or early.');
      if (!Cal.isTime(a.time)) H.fail('BLOCKED', 'Enter the exact time.');
      if (date < H.today(ctx)) H.fail('BLOCKED', 'This date has passed.');
      var day = expectedDay(ctx, person, date), t = hhmmToMin(a.time);
      if (day.fullLeave) H.fail('BLOCKED', 'You are on leave that day.');
      var minutes = a.kind === 'late' ? t - day.start : day.end - t;
      if (minutes <= 0) H.fail('BLOCKED', a.kind === 'late' ? 'That time is not after your duty start.' : 'That time is not before your duty end.');
      if (minutes > Minutes.DEFAULTS.halfDayAfterMinutes) H.fail('BLOCKED', 'More than 2 hours is a half day. Please apply for a half-day leave.');
      if (date === H.today(ctx)) {
        if (a.kind === 'late' && nowMin(ctx) >= day.start) H.fail('BLOCKED', 'Duty has started. A late arrival can be informed only before duty start.');
        if (a.kind === 'early' && nowMin(ctx) > t) H.fail('BLOCKED', 'That time has passed.');
      }
      // The same request sent again (a second tap, a retry) is the same request: no new alert to Aakash.
      var twin = ctx.db.rows('ShortRequests').filter(function (q) { return q.personId === actor.id && q.date === date && q.kind === a.kind && q.time === a.time && (q.status === 'Pending' || q.status === 'Approved'); })[0];
      if (twin) return { id: twin.id, minutes: minutes, status: twin.status, repeated: true };
      if (ctx.db.rows('ShortRequests').filter(function (q) { return q.personId === actor.id && q.date === date && q.kind === a.kind; }).length >= 5) H.fail('BLOCKED', 'This request has been changed too many times today. Call Aakash.');
      checkClashToday(ctx, person, date);
      ctx.db.rows('ShortRequests').forEach(function (q) { // a new one replaces the old one of the same kind
        if (q.personId === actor.id && q.date === date && q.kind === a.kind && (q.status === 'Pending' || q.status === 'Approved')) ctx.db.update('ShortRequests', q.id, { status: 'Replaced' });
      });
      var row = { id: ctx.env.randomId(), personId: actor.id, date: date, kind: a.kind, time: a.time, submittedAt: ctx.now, status: 'Pending', note: '', decidedAt: '', decidedBy: '', decisionReason: '' };
      ctx.db.insert('ShortRequests', row);
      H.audit(ctx, actor.id, 'short.request', row.id, { kind: a.kind, time: a.time });
      H.byRole(ctx, 'manager').forEach(function (m) {
        H.notify(ctx, m.id, 'approval', person.name + (a.kind === 'late' ? ' asks to come late' : ' asks to leave early'), niceDay(date) + ', ' + a.time, row.id);
      });
      return { id: row.id, minutes: minutes, status: 'Pending' };
    });
  }

  /** Aakash (or Varun) approves or rejects a late / early request. */
  function decideShort(ctx, actor, id, approve, reason) {
    return ctx.env.withLock(function () {
      boss(actor);
      var q = H.find(ctx, 'ShortRequests', id);
      if (!q || q.status !== 'Pending') H.fail('NOT_FOUND', 'This request is not waiting.');
      H.assertOpen(ctx, q.date);
      if (q.personId === actor.id) H.fail('FORBIDDEN', 'Nobody approves their own request.');
      if (!approve && !String(reason || '').trim()) H.fail('REASON', 'A reason is required to reject.');
      if (approve) checkClashToday(ctx, H.find(ctx, 'People', q.personId), q.date, id);
      ctx.db.update('ShortRequests', id, { status: approve ? 'Approved' : 'Rejected', decidedAt: ctx.now, decidedBy: actor.id, decisionReason: reason || '' });
      // The person may already have arrived or left while this was pending: correct those minutes now.
      var touched = false;
      ctx.db.rows('DayMinutes').forEach(function (m) {
        if (m.shortId === id && approve && !m.informed) { ctx.db.update('DayMinutes', m.id, { informed: true, note: 'Approved later by ' + actor.name }); touched = true; }
      });
      if (touched) syncViolations(ctx, q.personId, Cal.monthKey(q.date));
      H.audit(ctx, actor.id, approve ? 'short.approve' : 'short.reject', id);
      H.notify(ctx, q.personId, 'decision', (q.kind === 'late' ? 'Late arrival ' : 'Early leaving ') + (approve ? 'approved' : 'not approved'),
        niceDay(q.date) + ', ' + q.time + (reason ? ' \u2014 ' + reason : ''), id);
      return { id: id, status: approve ? 'Approved' : 'Rejected' };
    });
  }
  function niceDay(d) { return d.slice(8) + '-' + d.slice(5, 7); }

  function activeShort(ctx, personId, date, kind) {
    return ctx.db.rows('ShortRequests').filter(function (q) { return q.personId === personId && q.date === date && q.kind === kind && (q.status === 'Pending' || q.status === 'Approved'); })[0];
  }

  // ---------- Check-in / check-out ----------

  function checkIn(ctx, actor, a) {
    return ctx.env.withLock(function () {
      a = a || {};
      var person = H.find(ctx, 'People', actor.id), date = H.today(ctx);
      if (punchesToday(ctx, actor.id, date, 'in').length) H.fail('BLOCKED', 'You have already checked in today.');
      var day = expectedDay(ctx, person, date);
      var flag = [];
      var distance = '';
      var shop = setting(ctx, 'shopPoint');
      var num = function (v, max) { return typeof v === 'number' && isFinite(v) && Math.abs(v) <= max; };
      var located = num(a.lat, 90) && num(a.lng, 180);
      if (!located) { a.lat = ''; a.lng = ''; }               // anything that is not a real reading is "no location"
      if (!(typeof a.accuracy === 'number' && isFinite(a.accuracy) && a.accuracy >= 0)) a.accuracy = '';
      if (shop && located) {
        var pt = JSON.parse(shop);
        distance = distanceM(pt.lat, pt.lng, a.lat, a.lng);
        if (distance > SHOP_RADIUS_M) flag.push('outside-shop-area');
      } else if (shop) flag.push('no-location');
      if (day.fullLeave || Cal.isRosterOff(person, date)) flag.push('off-day');
      var punch = { id: ctx.env.randomId(), personId: actor.id, date: date, kind: 'in', at: ctx.now, photoId: a.photoId || '',
        lat: a.lat === undefined ? '' : a.lat, lng: a.lng === undefined ? '' : a.lng, accuracy: a.accuracy === undefined ? '' : a.accuracy,
        distance: distance, deviceId: actor.deviceId || '', flag: flag.join(','), note: '', thumbId: a.thumbId || '', dress: null, dressDecision: '', enteredBy: '' };
      // Automatic dress check (Mon-Sat; Sunday casual; exempt people skipped). It only FLAGS to Aakash.
      if (a.dress && !person.dressExempt && Cal.weekday(date) !== 0) {
        punch.dress = cleanDress(a.dress);
        if (dressIssues(punch.dress).length) H.byRole(ctx, 'manager').forEach(function (m) {
          H.notify(ctx, m.id, 'dress', 'Dress check: ' + person.name, 'Possible issue: ' + dressIssues(punch.dress).join(', ') + '. Confirm or dismiss.', punch.id);
        });
      }
      ctx.db.insert('Punches', punch);

      var late = uncovered(day.start, nowMin(ctx), day.win), counted = null;
      if (!day.fullLeave && !Cal.isRosterOff(person, date) && late > Minutes.DEFAULTS.lateGraceMinutes) {
        var q = activeShort(ctx, actor.id, date, 'late');
        // "Informed" only if it was applied before duty start AND Aakash approved it.
        // Still pending: counted as not informed for now, and corrected when Aakash decides.
        var inTime = !!q && q.submittedAt < Core.toMs(date, minToHhmm(day.start));
        var informed = inTime && q.status === 'Approved';
        counted = addDayMinutes(ctx, actor.id, date, 'late', late, informed, inTime ? hhmmToMin(q.time) - day.start : undefined, punch.id,
          inTime && q.status === 'Pending' ? q.id : '');
        syncViolations(ctx, actor.id, Cal.monthKey(date));
      }
      H.audit(ctx, actor.id, 'punch.in', punch.id, { late: late, flag: punch.flag });
      return { id: punch.id, at: ctx.now, lateMinutes: Math.max(0, late), informed: counted ? counted.informed : null, flag: punch.flag, distance: distance };
    });
  }

  function checkOut(ctx, actor) {
    return ctx.env.withLock(function () {
      var person = H.find(ctx, 'People', actor.id), date = H.today(ctx);
      if (!punchesToday(ctx, actor.id, date, 'in').length) H.fail('BLOCKED', 'Check in first.');
      if (punchesToday(ctx, actor.id, date, 'out').length) H.fail('BLOCKED', 'You have already checked out today.');
      var open = ctx.db.rows('Outings').filter(function (o) { return o.personId === actor.id && o.date === date && o.status === 'Approved'; })[0];
      if (open) H.fail('BLOCKED', 'You are marked as out. Tap I’m back first.');
      var day = expectedDay(ctx, person, date);
      var punch = { id: ctx.env.randomId(), personId: actor.id, date: date, kind: 'out', at: ctx.now, photoId: '', lat: '', lng: '',
        accuracy: '', distance: '', deviceId: actor.deviceId || '', flag: '', note: '' };
      ctx.db.insert('Punches', punch);
      var now = nowMin(ctx), early = uncovered(now, day.end, day.win);
      if (!day.fullLeave && !Cal.isRosterOff(person, date) && early > 0) {
        var q = activeShort(ctx, actor.id, date, 'early');
        var stated = q ? hhmmToMin(q.time) : null;
        var ok = !!q && q.status === 'Approved', wait = q && q.status === 'Pending' ? q.id : '';
        if (q && now >= stated) addDayMinutes(ctx, actor.id, date, 'early', early, ok, undefined, punch.id, wait);
        else if (q) { // left before the stated time: the extra minutes are not informed
          if (uncovered(stated, day.end, day.win) > 0) addDayMinutes(ctx, actor.id, date, 'early', uncovered(stated, day.end, day.win), ok, undefined, punch.id, wait);
          if (uncovered(now, stated, day.win) > 0) addDayMinutes(ctx, actor.id, date, 'early', uncovered(now, stated, day.win), false, undefined, punch.id);
        } else addDayMinutes(ctx, actor.id, date, 'early', early, false, undefined, punch.id);
        syncViolations(ctx, actor.id, Cal.monthKey(date));
      }
      H.audit(ctx, actor.id, 'punch.out', punch.id, { early: Math.max(0, early) });
      return { id: punch.id, at: ctx.now, earlyMinutes: Math.max(0, early) };
    });
  }

  var DRESS_PARTS = { top: 'top not white', trousers: 'trousers not black', shoes: 'shoes not black', belt: 'belt not seen' };
  function cleanDress(d) {
    var out = {};
    Object.keys(DRESS_PARTS).forEach(function (k) { out[k] = d[k] === 'ok' || d[k] === 'issue' ? d[k] : 'unknown'; });
    return out;
  }
  /** Belt is a weak signal, so it is shown as a hint but never raises a flag on its own. */
  function dressIssues(d) {
    return ['top', 'trousers', 'shoes'].filter(function (k) { return d && d[k] === 'issue'; }).map(function (k) { return DRESS_PARTS[k]; });
  }

  /** Aakash confirms (uses the dress grace, then a violation) or dismisses with 1 tap. Never automatic. */
  function decideDress(ctx, actor, punchId, confirm, recordIncident) {
    return ctx.env.withLock(function () {
      boss(actor);
      var p = H.find(ctx, 'Punches', punchId);
      if (!p || !p.dress || p.dressDecision || !dressIssues(p.dress).length) H.fail('NOT_FOUND', 'Nothing to decide.');
      H.assertOpen(ctx, p.date);
      var result = { id: punchId, decision: 'dismissed' };
      if (confirm) result = Object.assign({ decision: 'confirmed' }, recordIncident(ctx, actor, { personId: p.personId, item: 'dress', date: p.date, note: 'Dress check: ' + dressIssues(p.dress).join(', '), photoId: p.photoId }));
      ctx.db.update('Punches', punchId, { dressDecision: confirm ? 'confirmed' : 'dismissed' });
      H.audit(ctx, actor.id, confirm ? 'dress.confirm' : 'dress.dismiss', punchId);
      return result;
    });
  }

  /** When a phone or camera fails: Aakash enters the check-in, labelled "entered by Aakash", with a reason. */
  function manualCheckIn(ctx, actor, a) {
    return ctx.env.withLock(function () {
      boss(actor);
      var person = H.find(ctx, 'People', a.personId), date = H.today(ctx);
      if (!person || person.role !== 'staff') H.fail('NOT_FOUND', 'Choose a staff member.');
      if (!String(a.reason || '').trim()) H.fail('REASON', 'Write why the person could not check in.');
      if (!Cal.isTime(a.time)) H.fail('BLOCKED', 'Enter the exact arrival time.');
      if (punchesToday(ctx, a.personId, date, 'in').length) H.fail('BLOCKED', 'Already checked in today.');
      var at = Core.toMs(date, a.time);
      if (at > ctx.now) H.fail('BLOCKED', 'The time cannot be in the future.');
      var asThen = { db: ctx.db, env: ctx.env, now: at, stampNow: ctx.now };
      var r = checkIn(asThen, { id: person.id, name: person.name, role: 'staff', deviceId: '' }, {});
      ctx.db.update('Punches', r.id, { enteredBy: actor.id, note: 'Entered by ' + actor.name + ': ' + String(a.reason).trim(), flag: 'entered-by-manager' });
      H.audit(ctx, actor.id, 'punch.manual', r.id, { personId: a.personId, time: a.time, reason: a.reason });
      return { id: r.id, lateMinutes: r.lateMinutes };
    });
  }

  /** A forgotten check-out: Aakash enters the time the person left, with a reason. Labelled "entered by". */
  function manualCheckOut(ctx, actor, a) {
    return ctx.env.withLock(function () {
      boss(actor);
      var person = H.find(ctx, 'People', a.personId), date = a.date || H.today(ctx);
      if (!person) H.fail('NOT_FOUND', 'Choose a person.');
      if (!Cal.isDate(date) || date > H.today(ctx)) H.fail('BLOCKED', 'Pick the date.');
      H.assertOpen(ctx, date);
      if (!String(a.reason || '').trim()) H.fail('REASON', 'Write why the check-out is entered by hand.');
      if (!Cal.isTime(a.time)) H.fail('BLOCKED', 'Enter the exact time the person left.');
      var pin = punchesToday(ctx, a.personId, date, 'in')[0];
      if (!pin) H.fail('BLOCKED', 'There is no check-in on that day.');
      if (punchesToday(ctx, a.personId, date, 'out').length) H.fail('BLOCKED', 'Already checked out on that day.');
      var at = Core.toMs(date, a.time);
      if (at > ctx.now || at < pin.at) H.fail('BLOCKED', 'The time must be after the check-in and not in the future.');
      var r = checkOut({ db: ctx.db, env: ctx.env, now: at, stampNow: ctx.now }, { id: person.id, name: person.name, role: person.role, deviceId: '' });
      ctx.db.update('Punches', r.id, { enteredBy: actor.id, note: 'Entered by ' + actor.name + ': ' + String(a.reason).trim(), flag: 'entered-by-manager' });
      H.audit(ctx, actor.id, 'punch.manual-out', r.id, { personId: a.personId, date: date, time: a.time, reason: a.reason });
      return { id: r.id, earlyMinutes: r.earlyMinutes };
    });
  }

  // ---------- Going out (owner's flow, handoff 3.8) ----------

  function goingOut(ctx, actor, a) {
    return ctx.env.withLock(function () {
      var person = H.find(ctx, 'People', actor.id), date = H.today(ctx);
      if (!String(a.reason || '').trim()) H.fail('BLOCKED', 'Write the reason.');
      if (!(a.expectedMinutes > 0)) H.fail('BLOCKED', 'Enter the expected minutes.');
      if (!punchesToday(ctx, actor.id, date, 'in').length || punchesToday(ctx, actor.id, date, 'out').length) H.fail('BLOCKED', 'You are not checked in.');
      var busy = ctx.db.rows('Outings').some(function (o) { return o.personId === actor.id && o.date === date && (o.status === 'Pending' || o.status === 'Approved'); });
      if (busy) H.fail('BLOCKED', 'You already have an open going-out request.');
      checkClashToday(ctx, person, date);
      var row = { id: ctx.env.randomId(), personId: actor.id, date: date, reason: String(a.reason).trim(), expectedMinutes: +a.expectedMinutes,
        requestedAt: ctx.now, status: 'Pending', approvedAt: '', approvedBy: '', decisionReason: '', backAt: '', confirmedAt: '',
        confirmedBy: '', correctedBackAt: '', minutes: '', remindedAt: '' };
      ctx.db.insert('Outings', row);
      H.audit(ctx, actor.id, 'out.request', row.id);
      H.byRole(ctx, 'manager').forEach(function (m) { H.notify(ctx, m.id, 'out', 'Going out: ' + person.name, row.reason + ' (' + row.expectedMinutes + ' min)', row.id); });
      return { id: row.id, status: 'Pending' };
    });
  }

  function boss(actor) { if (actor.role === 'staff') H.fail('FORBIDDEN', 'Only Aakash or Varun.'); }

  function decideOuting(ctx, actor, id, approve, reason) {
    return ctx.env.withLock(function () {
      boss(actor);
      var o = H.find(ctx, 'Outings', id);
      if (!o || o.status !== 'Pending') H.fail('NOT_FOUND', 'This request is not waiting.');
      if (o.personId === actor.id) H.fail('FORBIDDEN', 'Nobody approves their own request.');
      if (!approve && !String(reason || '').trim()) H.fail('REASON', 'A reason is required to reject.');
      if (approve) checkClashToday(ctx, H.find(ctx, 'People', o.personId), o.date, id);
      // The outing clock starts at the approval time.
      ctx.db.update('Outings', id, approve ? { status: 'Approved', approvedAt: ctx.now, approvedBy: actor.id }
        : { status: 'Rejected', approvedBy: actor.id, decisionReason: reason });
      H.audit(ctx, actor.id, approve ? 'out.approve' : 'out.reject', id);
      H.notify(ctx, o.personId, 'out', approve ? 'Going out approved' : 'Going out not approved', approve ? 'Tap I’m back when you return.' : reason, id);
      return { id: id, status: approve ? 'Approved' : 'Rejected' };
    });
  }

  function outingMinutes(o, backAt) { return Math.max(0, Math.floor((backAt - o.approvedAt) / 60000)); }

  /** Staff taps "I'm back". The counted time ends at THIS tap, not at Aakash's confirmation. */
  function imBack(ctx, actor, id) {
    return ctx.env.withLock(function () {
      var o = H.find(ctx, 'Outings', id);
      if (!o || o.personId !== actor.id || o.status !== 'Approved') H.fail('NOT_FOUND', 'No open outing.');
      var minutes = outingMinutes(o, ctx.now);
      ctx.db.update('Outings', id, { status: 'Back', backAt: ctx.now, minutes: minutes });
      addDayMinutes(ctx, actor.id, o.date, 'out', minutes, true, undefined, id);
      syncViolations(ctx, actor.id, Cal.monthKey(o.date));
      H.audit(ctx, actor.id, 'out.back', id, { minutes: minutes });
      H.byRole(ctx, 'manager').forEach(function (m) { H.notify(ctx, m.id, 'out', H.find(ctx, 'People', actor.id).name + ' is back', minutes + ' min. Please confirm.', id); });
      return { id: id, minutes: minutes };
    });
  }

  /** Aakash confirms. He may correct the back time (HH:MM); the correction is logged. */
  function confirmBack(ctx, actor, id, correctedTime) {
    return ctx.env.withLock(function () {
      boss(actor);
      var o = H.find(ctx, 'Outings', id);
      if (o) H.assertOpen(ctx, o.date);
      if (o && o.status === 'Approved') {
        // The person never tapped "I'm back": Aakash closes the outing with the time they returned.
        if (!Cal.isTime(correctedTime)) H.fail('BLOCKED', 'Enter the exact time the person came back.');
        var back = Core.toMs(o.date, correctedTime);
        if (back < o.approvedAt || back > ctx.now) H.fail('BLOCKED', 'That time is outside the outing.');
        var mins = outingMinutes(o, back);
        ctx.db.update('Outings', id, { status: 'Confirmed', backAt: back, correctedBackAt: back, minutes: mins, confirmedAt: ctx.now, confirmedBy: actor.id });
        var made = addDayMinutes(ctx, o.personId, o.date, 'out', mins, true, undefined, id);
        ctx.db.update('DayMinutes', made.id, { note: 'Closed by ' + actor.name });
        syncViolations(ctx, o.personId, Cal.monthKey(o.date));
        H.audit(ctx, actor.id, 'out.close', id, { back: back, minutes: mins });
        H.notify(ctx, o.personId, 'out', 'Going out closed by ' + actor.name, mins + ' min counted (back at ' + correctedTime + ').', id);
        return { id: id, status: 'Confirmed', minutes: mins };
      }
      if (!o || o.status !== 'Back') H.fail('NOT_FOUND', 'Nothing to confirm.');
      var patch = { status: 'Confirmed', confirmedAt: ctx.now, confirmedBy: actor.id };
      if (correctedTime) {
        if (!Cal.isTime(correctedTime)) H.fail('BLOCKED', 'Enter the exact time.');
        var corrected = Core.toMs(o.date, correctedTime);
        if (corrected < o.approvedAt || corrected > ctx.now) H.fail('BLOCKED', 'That time is outside the outing.');
        patch.correctedBackAt = corrected; patch.minutes = outingMinutes(o, corrected);
        var dm = ctx.db.rows('DayMinutes').filter(function (m) { return m.source === id; })[0];
        ctx.db.update('DayMinutes', dm.id, { minutes: patch.minutes, note: 'Back time corrected by ' + actor.name });
        H.audit(ctx, actor.id, 'out.correct', id, { from: o.backAt, to: corrected });
      }
      ctx.db.update('Outings', id, patch);
      if (correctedTime) syncViolations(ctx, o.personId, Cal.monthKey(o.date));
      H.audit(ctx, actor.id, 'out.confirm', id);
      return { id: id, status: 'Confirmed', minutes: patch.minutes === undefined ? o.minutes : patch.minutes };
    });
  }

  var REMIND_GAP_MS = 10 * 60000;
  function remindBack(ctx, actor, id) {
    return ctx.env.withLock(function () {
      var o = H.find(ctx, 'Outings', id);
      if (!o || o.personId !== actor.id || o.status !== 'Back') H.fail('NOT_FOUND', 'Nothing to remind.');
      if (o.remindedAt && ctx.now - o.remindedAt < REMIND_GAP_MS) H.fail('BLOCKED', 'A reminder was sent a few minutes ago.');
      ctx.db.update('Outings', id, { remindedAt: ctx.now });
      H.byRole(ctx, 'manager').forEach(function (m) { H.notify(ctx, m.id, 'out', 'Reminder: confirm ' + H.find(ctx, 'People', actor.id).name + ' is back', '', id); });
      return { ok: true };
    });
  }

  /**
   * A leave was granted for a day on which the person had already checked in or out (the request was
   * still waiting at that moment). The late / early minutes of that day are worked out again against
   * the day as it stands now; nothing is deleted, a row that no longer counts is set to 0 with a note.
   */
  function recountDay(ctx, personId, date) {
    var rows = ctx.db.rows('DayMinutes').filter(function (m) { return m.personId === personId && m.date === date && (m.kind === 'late' || m.kind === 'early') && m.minutes > 0; });
    if (!rows.length) return;
    var person = H.find(ctx, 'People', personId), day = expectedDay(ctx, person, date);
    var at = function (kind) { var p = punchesToday(ctx, personId, date, kind)[0]; if (!p) return null; var d = new Date(p.at + H.IST_OFFSET_MS); return d.getUTCHours() * 60 + d.getUTCMinutes(); };
    var cin = at('in'), cout = at('out');
    var left = { late: day.fullLeave || cin === null ? 0 : uncovered(day.start, cin, day.win), early: day.fullLeave || cout === null ? 0 : uncovered(cout, day.end, day.win) };
    if (left.late <= Minutes.DEFAULTS.lateGraceMinutes) left.late = 0;
    var touched = false;
    rows.forEach(function (m) {
      var now = Math.min(m.minutes, left[m.kind]); left[m.kind] -= now;
      if (now !== m.minutes) { ctx.db.update('DayMinutes', m.id, { minutes: now, note: 'Counted again after the leave for this day was granted' }); touched = true; }
    });
    if (touched) syncViolations(ctx, personId, Cal.monthKey(date));
  }
  H.hooks.recountDay = recountDay;

  // ---------- Month calculation ----------

  /** Days on which the total away time is over 2 hours become a half day (or a full day over 4 h 30 min). */
  function splitDays(rows) {
    var byDate = {};
    rows.forEach(function (m) { (byDate[m.date] = byDate[m.date] || []).push(m); });
    var events = [], converted = [];
    Object.keys(byDate).sort().forEach(function (date) {
      var total = byDate[date].reduce(function (s, m) { return s + m.minutes; }, 0);
      if (total > Minutes.DEFAULTS.halfDayAfterMinutes) converted.push({ date: date, minutes: total, amount: total > HALF_DAY_MINUTES ? 1 : 0.5 });
      else byDate[date].forEach(function (m) { events.push(m); });
    });
    return { events: events, converted: converted };
  }

  function monthMinutes(ctx, personId, monthKey) {
    var rows = ctx.db.rows('DayMinutes').filter(function (m) { return m.personId === personId && Cal.monthKey(m.date) === monthKey && m.minutes > 0; });
    var s = splitDays(rows);
    var person = H.find(ctx, 'People', personId);
    var pay = ctx.db.rows('PayInfo').filter(function (p) { return p.personId === personId; })[0];
    var dutyHours = (pay && pay.dutyHours) || (hhmmToMin(person.dutyEnd) - hhmmToMin(person.dutyStart)) / 60;
    var run = Minutes.runMonth({ salary: pay ? pay.fixedSalary : 0, dutyHours: dutyHours },
      s.events.map(function (m) { return { kind: m.kind, minutes: m.minutes, informed: m.informed, statedMinutes: (m.statedMinutes === '' || !m.informed) ? undefined : m.statedMinutes }; }));
    // Informed minutes already beyond the bank (they decide the "extra 2 hours" violations).
    var used = 0, beyondInformed = 0;
    run.lines.forEach(function (l, i) { if (s.events[i].informed) beyondInformed += l.beyondBank; used += l.fromBank; });
    run.beyondInformed = beyondInformed;
    return { run: run, events: s.events, converted: s.converted, pay: pay || null, dutyHours: dutyHours };
  }

  /** Keep the Violations tab in step with the minute rules. Never deletes: a dropped one is marked removed. */
  function syncViolations(ctx, personId, monthKey) {
    var who = H.find(ctx, 'People', personId);
    if (who && who.noApproval) return; // records only (intern): never a violation
    var mm = monthMinutes(ctx, personId, monthKey);
    var wanted = {}, perEvent = {};
    mm.run.violations.forEach(function (v) {
      var src = mm.events[v.eventIndex];
      var k = (perEvent[src.id + v.rule] = (perEvent[src.id + v.rule] || 0) + 1);
      wanted['dm:' + src.id + ':' + v.rule + ':' + k] = { rule: v.rule, date: src.date };
    });
    // A day that became a half/full day is outside the bank, but "not informed and more than
    // 30 min" is still a violation on that day.
    var convertedDates = {}; mm.converted.forEach(function (c) { convertedDates[c.date] = true; });
    ctx.db.rows('DayMinutes').forEach(function (m) {
      if (m.personId !== personId || !convertedDates[m.date]) return;
      // The part nobody was told about: everything when not informed; when informed, the minutes after the stated time.
      var stated = m.statedMinutes === '' || m.statedMinutes === undefined || m.statedMinutes === null ? null : m.statedMinutes;
      var silent = !m.informed ? m.minutes : (stated === null ? 0 : Math.max(0, m.minutes - stated));
      if (silent > Minutes.DEFAULTS.notInformedMaxMinutes) {
        wanted['dm:' + m.id + ':not-informed-over-30:1'] = { rule: 'not-informed-over-30', date: m.date };
      }
    });
    var existing = ctx.db.rows('Violations').filter(function (v) {
      return v.personId === personId && Cal.monthKey(v.date) === monthKey && String(v.proof).indexOf('dm:') === 0;
    });
    existing.forEach(function (v) {
      if (wanted[v.proof]) { delete wanted[v.proof]; return; }
      if (v.disputeState !== 'removed') ctx.db.update('Violations', v.id, { disputeState: 'removed', note: 'Recalculated after a correction' });
    });
    Object.keys(wanted).forEach(function (proof) {
      ctx.db.insert('Violations', { id: ctx.env.randomId(), personId: personId, date: wanted[proof].date, rule: wanted[proof].rule, source: 'auto',
        proof: proof, note: '', createdBy: 'system', createdAt: H.stamp(ctx), disputeState: '', disputeAt: '', disputeText: '', disputeDecidedBy: '', disputeDecidedAt: '' });
      H.notify(ctx, personId, 'violation', 'Violation recorded', H.ruleLabel(wanted[proof].rule) + '. You can dispute it within 24 hours.', proof);
      H.byRole(ctx, 'owner').concat(H.byRole(ctx, 'manager')).forEach(function (m) { H.notify(ctx, m.id, 'violation', 'Violation recorded', H.find(ctx, 'People', personId).name + ': ' + H.ruleLabel(wanted[proof].rule), proof); });
    });
  }

  /**
   * "My month" (handoff 3.10). Only the person, Aakash and Varun may call this for a person;
   * the API layer enforces that. Money lines are estimates and are labelled so.
   */
  function myMonth(ctx, personId, monthKey) {
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(String(monthKey))) H.fail('BLOCKED', 'Pick a month.');
    // A locked month is shown exactly as it was locked, to the person and in the report alike.
    var frozen = ctx.db.rows('MonthSheet').filter(function (m) { return m.month === monthKey && m.personId === personId && m.result; })[0];
    if (frozen) return Object.assign({}, frozen.result, { locked: true });
    return liveMonth(ctx, personId, monthKey);
  }
  function liveMonth(ctx, personId, monthKey) {
    var person = H.find(ctx, 'People', personId);
    var mm = monthMinutes(ctx, personId, monthKey);
    var closed = H.closedSet(ctx), today = H.today(ctx), undecided = [];
    var days = [], emergencies = 0;
    ctx.db.rows('LeaveRequests').forEach(function (r) {
      if (r.personId !== personId) return;
      var counted = H.GRANTED[r.status] || r.status === H.ABSENT;
      if (counted && r.type === 'Emergency' && Cal.monthKey(r.dates[0]) === monthKey) emergencies += 1;
      r.dates.forEach(function (d) {
        if (closed[d]) return; // the shop was closed: no leave is used
        // A request nobody decided, for a day that has gone by with no check-in, is still a day away.
        var gone = !counted && H.OPEN[r.status] && d <= today && !Cal.isRosterOff(person, d) && H.dayOver(ctx, person, d) && !H.hasCheckIn(ctx, personId, d);
        if (gone && Cal.monthKey(d) === monthKey) undecided.push(d);
        if (counted || gone) days.push({ date: d, amount: r.kind === 'half' ? 0.5 : 1, penaltyEmergency: !!r.penaltyEmergency && counted });
      });
    });
    mm.converted.forEach(function (c) { days.push({ date: c.date, amount: c.amount }); });
    var salary = mm.pay ? mm.pay.fixedSalary : 0;
    var quota = Leave.monthQuota({ sundayOff: person.sundayOff, salary: salary }, monthKey, days);
    var violations = ctx.db.rows('Violations').filter(function (v) {
      return v.personId === personId && Cal.monthKey(v.date) === monthKey && v.disputeState !== 'removed';
    });
    var ladder = Minutes.ladder(violations.length, { disciplineBonus: mm.pay ? mm.pay.disciplineBonus : Minutes.DEFAULTS.disciplineBonus });
    var lines = [];
    if (salary && quota.daysCut > 0) lines.push(quota.total + quota.penaltyEmergencyDays + ' leaves − ' + (quota.total + quota.penaltyEmergencyDays - quota.daysCut) +
      ' free = ' + quota.daysCut + ' day(s) × Rs ' + Math.round(quota.dayRate) + ' = Rs ' + quota.wouldBeDeducted);
    if (salary && mm.run.beyondBankMinutes > 0) lines.push(mm.run.beyondBankMinutes + ' min beyond bank × Rs ' + mm.run.ratePerMinute.toFixed(2) + ' = Rs ' + mm.run.wouldBeDeducted);
    return {
      month: monthKey, personId: personId, name: person.name, onPayroll: !person.noQuota,
      leaves: { total: quota.total, free: Leave.CFG.freeLeaves, left: quota.left, rosterSundays: quota.rosterSundays, taken: quota.leavesTaken,
        emergencies: emergencies, emergenciesAllowed: Leave.CFG.maxEmergencies, daysCut: quota.daysCut, autoHalfDays: mm.converted, undecided: undecided },
      bank: { minutes: mm.run.bankMinutes, used: mm.run.bankUsed, left: mm.run.bankLeft, beyond: mm.run.beyondBankMinutes,
        passesUsed: mm.run.passesUsed, passes: Minutes.DEFAULTS.freePasses,
        days: mm.events.map(function (m, i) { var l = mm.run.lines[i]; return { date: m.date, kind: m.kind, minutes: m.minutes, counted: l.counted, fromBank: l.fromBank, informed: m.informed, notes: l.notes || [] }; }) },
      // The record of the last 3 months (this month and the two before it) stays in view.
      last3: [2, 1, 0].map(function (back) {
        var y = +monthKey.slice(0, 4), mo = +monthKey.slice(5, 7) - back;
        while (mo < 1) { mo += 12; y -= 1; }
        var key = y + '-' + (mo < 10 ? '0' + mo : mo);
        var n = ctx.db.rows('Violations').filter(function (v) { return v.personId === personId && Cal.monthKey(v.date) === key && v.disputeState !== 'removed'; }).length;
        return { month: key, violations: n, stage: Minutes.ladder(n).notice ? 'notice' : n >= 2 ? 'bonus and allowance' : n === 1 ? 'record only' : 'none' };
      }),
      violations: violations.map(function (v) { return { id: v.id, date: v.date, rule: v.rule, source: v.source, disputeState: v.disputeState, createdAt: v.createdAt }; }),
      ladder: ladder,
      wouldBeDeducted: salary ? { lines: lines, total: quota.wouldBeDeducted + mm.run.wouldBeDeducted,
        label: 'Estimate as per company rules. Final salary is decided by management.' } : null
    };
  }

  // ---------- Proactive warnings (owner wants the person to see the effect BEFORE sending) ----------

  function rupees(mm, minutes) { return mm.pay && mm.pay.fixedSalary ? ' \u2248 Rs ' + Math.round(minutes * mm.run.ratePerMinute) + ' would be deducted' : ' would be deducted'; }

  /** What a late / early / going-out request of N minutes would do to this month. Never writes. */
  function effectOf(ctx, personId, kind, minutes, date) {
    var mm = monthMinutes(ctx, personId, Cal.monthKey(date || H.today(ctx)));
    var counted = kind === 'late' ? Math.max(0, minutes - Minutes.DEFAULTS.lateGraceMinutes) : kind === 'out' ? (minutes <= Minutes.DEFAULTS.outFreeMinutes ? 0 : minutes) : minutes;
    var left = mm.run.bankLeft, lines = [];
    if (minutes > Minutes.DEFAULTS.halfDayAfterMinutes) return { counted: 0, lines: ['More than 2 hours in one day is a half day (0.5 leave), not the bank.'] };
    if (counted === 0) lines.push(kind === 'out' ? 'Up to 15 min is free. Nothing is counted.' : 'Inside the 10-min grace. Nothing is counted.');
    else if (counted <= left) lines.push('This uses ' + counted + ' min. Bank left after this: ' + (left - counted) + ' min.');
    else {
      var beyond = counted - left;
      lines.push(left > 0 ? 'This uses the last ' + left + ' min of your bank. ' + beyond + ' min are beyond the bank:' + rupees(mm, beyond) + '.'
        : 'The bank is exhausted: these ' + beyond + ' min' + rupees(mm, beyond) + '.');
      var before = Math.floor(mm.run.beyondInformed / Minutes.DEFAULTS.extraViolationMinutes), after = Math.floor((mm.run.beyondInformed + beyond) / Minutes.DEFAULTS.extraViolationMinutes);
      if (after > before) lines.push('This crosses an extra 2 hours beyond the bank: 1 violation.');
      else lines.push((Minutes.DEFAULTS.extraViolationMinutes - ((mm.run.beyondInformed + beyond) % Minutes.DEFAULTS.extraViolationMinutes)) + ' more min beyond the bank = 1 violation.');
    }
    return { counted: counted, bankLeft: Math.max(0, left - counted), lines: lines };
  }

  /** Short status lines for the Today screen: how to avoid the next violation. */
  function hints(ctx, personId) {
    var person = H.find(ctx, 'People', personId);
    if (!person || person.noApproval) return [];
    var month = Cal.monthKey(H.today(ctx)), mm = monthMinutes(ctx, personId, month), out = [];
    var violations = ctx.db.rows('Violations').filter(function (v) { return v.personId === personId && Cal.monthKey(v.date) === month && v.disputeState !== 'removed'; }).length;
    out.push('2-hour bank: ' + mm.run.bankLeft + ' min left.');
    var n = mm.run.notInformedCount, passes = Minutes.DEFAULTS.freePasses;
    if (n < passes) out.push('Not-informed passes: ' + (passes - n) + ' of ' + passes + ' left.');
    else if ((n + 1 - passes) % Minutes.DEFAULTS.passViolationEvery === 0) out.push('You have ' + n + ' not-informed times. The next one (no. ' + (n + 1) + ') is a violation. Inform before duty start.');
    else out.push('You have ' + n + ' not-informed times. No. ' + (n + 2) + ' will be a violation.');
    var bonus = mm.pay ? mm.pay.disciplineBonus : Minutes.DEFAULTS.disciplineBonus;
    if (violations === 0) out.push('No violation this month.');
    else if (violations === 1) out.push('1 violation (record only). 1 more = Rs ' + bonus + ' discipline bonus and target allowance would be lost.');
    else if (violations === 2) out.push('2 violations. 1 more = notice.');
    else out.push(violations + ' violations: notice stage.');
    return out;
  }

  // ---------- End of day: absent with no request ----------

  /** Run after closing time. Creates "Absent - unannounced" + 1 violation for staff with no request and no check-in. */
  function endOfDay(ctx, date) {
    return ctx.env.withLock(function () {
      var closed = []; try { closed = JSON.parse(setting(ctx, 'closedDays') || '[]'); } catch (e) { closed = []; }
      if (closed.indexOf(date) !== -1) return [];
      if (H.lockedMonths(ctx)[Cal.monthKey(date)]) return [];
      var made = [];
      ctx.db.rows('People').forEach(function (p) {
        if (p.active === false || p.role !== 'staff' || Cal.isRosterOff(p, date)) return;
        if (p.joinedOn && date < p.joinedOn) return; // not yet part of the shop on that day
        if (!H.dayOver(ctx, p, date)) return; // never before that person's duty end (a job run by hand in the morning marks nobody)
        if (punchesToday(ctx, p.id, date, 'in').length) return;
        var rows = ctx.db.rows('LeaveRequests').filter(function (r) { return r.personId === p.id && r.dates.indexOf(date) !== -1; });
        var held = rows.filter(function (r) { return H.GRANTED[r.status] || r.status === H.ABSENT; });
        if (held.some(function (r) { return r.kind === 'full'; })) return;
        if (held.length) {
          // An approved half day, and the person did not come for the other half either.
          if (held.length < 2) { H.markAbsent(ctx, p, date, 'half', 'Approved half day, but no check-in for the other half'); made.push(p.name); }
          return;
        }
        var open = rows.filter(function (r) { return H.OPEN[r.status]; })[0];
        if (open) {
          // Asked, nobody decided, and the person stayed away: counted as a day away; the bosses must still decide.
          var told = ctx.db.rows('Notifications').some(function (n) { return n.kind === 'undecided' && n.ref === open.id + ':' + date; });
          if (!told) H.byRole(ctx, 'owner').concat(H.byRole(ctx, 'manager')).forEach(function (m) {
            H.notify(ctx, m.id, 'undecided', 'Not decided: ' + p.name + ' was away today', 'The leave request for ' + niceDay(date) + ' is still waiting. Approve or reject it.', open.id + ':' + date);
          });
          return;
        }
        H.markAbsent(ctx, p, date, 'full');
        made.push(p.name);
      });
      return made;
    });
  }

  /** Aakash marks an auto absence "humanitarian - excused" with a reason: the violation is removed. */
  function excuseAbsence(ctx, actor, leaveId, reason) {
    return ctx.env.withLock(function () {
      boss(actor);
      if (!String(reason || '').trim()) H.fail('REASON', 'A reason is required.');
      var r = H.find(ctx, 'LeaveRequests', leaveId);
      if (!r || r.status !== H.ABSENT) H.fail('NOT_FOUND', 'Not an unannounced absence.');
      H.assertOpen(ctx, r.dates);
      ctx.db.update('LeaveRequests', leaveId, { status: 'Approved', decisionReason: 'Humanitarian – excused: ' + reason, decidedBy: actor.id, decidedAt: ctx.now,
        history: r.history.concat([{ at: ctx.now, by: actor.id, action: 'excused', reason: reason }]) });
      ctx.db.rows('Violations').forEach(function (v) {
        if (v.proof === leaveId && v.rule === 'absent-no-request') ctx.db.update('Violations', v.id, { disputeState: 'removed', note: 'Humanitarian – excused: ' + reason });
      });
      H.audit(ctx, actor.id, 'absent.excuse', leaveId, { reason: reason });
      return { id: leaveId, status: 'Approved' };
    });
  }

  var api = { requestShort: requestShort, decideShort: decideShort, checkIn: checkIn, checkOut: checkOut, goingOut: goingOut, decideOuting: decideOuting,
    imBack: imBack, confirmBack: confirmBack, manualCheckOut: manualCheckOut, expectedDay: expectedDay, uncovered: uncovered, decideDress: decideDress, manualCheckIn: manualCheckIn, effectOf: effectOf, hints: hints, dressIssues: dressIssues, remindBack: remindBack, myMonth: myMonth, liveMonth: liveMonth, endOfDay: endOfDay, excuseAbsence: excuseAbsence,
    syncViolations: syncViolations };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.GJAttendance = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);

// ===== src/server/admin.js =====
/**
 * Management actions: manual violations with the grace table, disputes, editing a leave,
 * the owner's override, and Settings (people, pay, rules, restrictions, shop point).
 * Every change is written to the Audit tab.
 */
(function (root) {
  'use strict';
  var req = (typeof require !== 'undefined') ? require : null;
  var Cal = req ? req('../rules/calendar.js') : root.GJCalendar;
  var Core = req ? req('./core.js') : root.GJCore;
  var H = Core._;

  // Owner's grace table (handoff 3.7). Editable in Settings. per: 'month' | 'quarter'.
  var DEFAULT_GRACE = [
    { item: 'Dress (Mon–Sat)', key: 'dress', grace: 1, per: 'month' },
    { item: 'Display photo', key: 'display-photo', grace: 1, per: 'month' },
    { item: 'BytePhase job sheet', key: 'job-sheet', grace: 0, per: 'month' },
    { item: 'Monday inventory list', key: 'inventory-list', grace: 0, per: 'month' },
    { item: 'Windows late', key: 'windows-late', grace: 1, per: 'month' },
    { item: 'Chai cup', key: 'chai-cup', grace: 2, per: 'month' },
    { item: 'Wrapper / kachra (rubbish)', key: 'rubbish', grace: 3, per: 'quarter' },
    { item: 'Phone / reels / games', key: 'phone', grace: 0, per: 'month' },
    { item: 'Grouping (idle together)', key: 'grouping', grace: 0, per: 'month' }
  ];
  var DISPUTE_WINDOW_MS = 24 * 3600000;
  var SETTING_KEYS = { graceTable: 1, closedDays: 1, reminderHours: 1, ownerEmail: 1, managerEmail: 1, startDate: 1 };

  function owner(actor) { if (actor.role !== 'owner') H.fail('FORBIDDEN', 'Only the owner can do this.'); }
  function boss(actor) { if (actor.role === 'staff') H.fail('FORBIDDEN', 'Only Aakash or Varun.'); }
  function need(text, msg) { if (!String(text || '').trim()) H.fail('REASON', msg || 'A reason is required.'); }
  function setting(ctx, key) { var s = ctx.db.rows('Settings').filter(function (x) { return x.key === key; })[0]; return s ? s.value : ''; }
  function putSetting(ctx, actor, key, value) {
    var text = typeof value === 'string' ? value : JSON.stringify(value);
    var before = setting(ctx, key);
    if (ctx.db.rows('Settings').some(function (x) { return x.key === key; })) ctx.db.update('Settings', key, { value: text, updatedAt: ctx.now, updatedBy: actor.id });
    else ctx.db.insert('Settings', { key: key, value: text, updatedAt: ctx.now, updatedBy: actor.id });
    H.audit(ctx, actor.id, 'settings.' + key, key, { before: before, after: text });
  }
  function graceTable(ctx) { try { var t = JSON.parse(setting(ctx, 'graceTable') || 'null'); return t && t.length ? t : DEFAULT_GRACE; } catch (e) { return DEFAULT_GRACE; } }
  function periodKey(date, per) { return per === 'quarter' ? date.slice(0, 4) + '-Q' + (Math.floor((+date.slice(5, 7) - 1) / 3) + 1) : Cal.monthKey(date); }

  // ---------- Manual violations by Aakash ----------

  /**
   * Aakash records an incident (with a photo or note). Inside the grace number it is only
   * recorded; beyond it, it becomes a violation in the same monthly counter as the auto ones.
   */
  function recordIncident(ctx, actor, a) {
    return ctx.env.withLock(function () {
      boss(actor);
      var person = H.find(ctx, 'People', a.personId);
      if (!person || person.role !== 'staff') H.fail('NOT_FOUND', 'Choose a staff member.');
      var row = graceTable(ctx).filter(function (g) { return g.key === a.item; })[0];
      if (!row) H.fail('BLOCKED', 'Choose an item from the list.');
      if (!String(a.note || '').trim() && !a.photoId) H.fail('REASON', 'Add a photo or a note.');
      if (a.item === 'dress' && person.dressExempt) H.fail('BLOCKED', person.name + ' is exempt from the dress check.');
      var date = a.date || H.today(ctx);
      if (!Cal.isDate(date)) H.fail('BLOCKED', 'Pick the date.');
      if (date > H.today(ctx)) H.fail('BLOCKED', 'The date cannot be in the future.');
      H.assertOpen(ctx, date);
      if (a.item === 'dress' && Cal.weekday(date) === 0) H.fail('BLOCKED', 'The dress code is Monday to Saturday. Sunday is casual.');
      // The same entry sent twice (a retry after a slow reply) is one incident, not two.
      var twin = ctx.db.rows('Incidents').filter(function (i) {
        return i.personId === a.personId && i.item === a.item && i.date === date && i.createdBy === actor.id && i.note === String(a.note || '').trim() &&
          (i.photoId || '') === (a.photoId || '') && Math.abs(ctx.now - i.createdAt) < 5 * 60000;
      })[0];
      if (twin) return { id: twin.id, result: twin.result, count: twin.countInPeriod, grace: twin.grace, repeated: true };
      var pk = periodKey(date, row.per);
      var count = 1 + ctx.db.rows('Incidents').filter(function (i) { return i.personId === a.personId && i.item === a.item && periodKey(i.date, row.per) === pk && i.result !== 'cancelled'; }).length;
      var isViolation = count > row.grace && !person.noApproval; // Muskan: recorded only, never a violation
      var inc = { id: ctx.env.randomId(), personId: a.personId, date: date, item: a.item, note: String(a.note || '').trim(), photoId: a.photoId || '',
        createdBy: actor.id, createdAt: ctx.now, result: isViolation ? 'violation' : 'grace', countInPeriod: count, grace: row.grace };
      ctx.db.insert('Incidents', inc);
      if (isViolation) {
        ctx.db.insert('Violations', { id: ctx.env.randomId(), personId: a.personId, date: date, rule: 'manual:' + a.item, source: 'manual', proof: inc.id,
          note: inc.note, createdBy: actor.id, createdAt: ctx.now, disputeState: '', disputeAt: '', disputeText: '', disputeDecidedBy: '', disputeDecidedAt: '' });
        H.byRole(ctx, 'owner').forEach(function (o) { H.notify(ctx, o.id, 'violation', 'Violation: ' + person.name, row.item, inc.id); });
      }
      H.notify(ctx, a.personId, isViolation ? 'violation' : 'incident', isViolation ? 'Violation recorded' : 'Noted (within grace)',
        row.item + ' — ' + count + ' this ' + row.per + ', grace ' + row.grace + (isViolation ? '. You can dispute it within 24 hours.' : '.'), inc.id);
      H.audit(ctx, actor.id, 'incident.record', inc.id, { item: a.item, result: inc.result });
      return { id: inc.id, result: inc.result, count: count, grace: row.grace };
    });
  }

  // ---------- Disputes ----------

  /** Any violation can be disputed by the person within 24 hours. */
  function disputeViolation(ctx, actor, id, text) {
    return ctx.env.withLock(function () {
      var v = H.find(ctx, 'Violations', id);
      if (!v || v.personId !== actor.id) H.fail('NOT_FOUND', 'No such violation.');
      H.assertOpen(ctx, v.date);
      if (v.disputeState) H.fail('BLOCKED', 'This violation has already been disputed.');
      if (ctx.now - v.createdAt > DISPUTE_WINDOW_MS) H.fail('BLOCKED', 'The 24-hour dispute window has passed.');
      need(text, 'Write why you dispute it.');
      ctx.db.update('Violations', id, { disputeState: 'open', disputeAt: ctx.now, disputeText: String(text).trim() });
      H.byRole(ctx, 'owner').forEach(function (o) { H.notify(ctx, o.id, 'dispute', 'Dispute from ' + actor.name, v.rule, id); });
      H.audit(ctx, actor.id, 'violation.dispute', id);
      return { id: id, disputeState: 'open' };
    });
  }

  /** Varun checks it personally and marks it upheld or removed. */
  function decideDispute(ctx, actor, id, uphold, note) {
    return ctx.env.withLock(function () {
      owner(actor);
      var v = H.find(ctx, 'Violations', id);
      if (!v || v.disputeState !== 'open') H.fail('NOT_FOUND', 'No open dispute.');
      H.assertOpen(ctx, v.date);
      need(note, 'Write your decision note.');
      var state = uphold ? 'upheld' : 'removed';
      ctx.db.update('Violations', id, { disputeState: state, disputeDecidedBy: actor.id, disputeDecidedAt: ctx.now, note: (v.note ? v.note + ' | ' : '') + 'Dispute ' + state + ': ' + String(note).trim() });
      H.notify(ctx, v.personId, 'dispute', 'Dispute ' + state, String(note).trim(), id);
      H.audit(ctx, actor.id, 'violation.dispute-' + state, id);
      return { id: id, disputeState: state };
    });
  }

  // ---------- Edit a leave ----------

  /** An edit re-runs every check. The request is decided again from scratch. */
  function editLeave(ctx, actor, id, input) {
    return ctx.env.withLock(function () {
      var r = H.find(ctx, 'LeaveRequests', id);
      if (!r || !(r.status === 'Approved' || H.OPEN[r.status]) || r.route === 'system' || r.route === 'override') H.fail('NOT_FOUND', 'This request cannot be edited.');
      if (r.personId !== actor.id && actor.role === 'staff') H.fail('FORBIDDEN', 'You can edit only your own request.');
      H.assertOpen(ctx, r.dates);
      var person = H.find(ctx, 'People', r.personId);
      if (ctx.now >= Core.toMs(r.dates[0], r.kind === 'half' ? r.halfStart : person.dutyStart) && actor.role === 'staff') H.fail('FORBIDDEN', 'This leave has started. Ask Aakash or Varun.');
      // A recorded phone call keeps its time when Aakash or Varun corrects the entry for the same first day.
      var keep = r.noticeAt && actor.role !== 'staff' && (input.dates || []).slice().sort()[0] === r.dates[0] ? { at: r.noticeAt } : null;
      var ev = H.evaluate(ctx, person, input, id, keep);
      if (ev.decision === 'blocked') H.fail('BLOCKED', ev.reasons.join(' '));
      // Handoff Part 6: an edit after approval goes back to pending. It is never approved again by the system.
      if (r.status === 'Approved' && ev.decision === 'auto') { ev.decision = 'aakash'; ev.reasons = ['Edited after approval.']; }
      // Violations that came from the old version are withdrawn; the new version earns its own.
      var patch = { kind: input.kind, dates: ev.dates, halfStart: input.halfStart || '', reasonCode: input.reasonCode, reasonText: String(input.reasonText).trim(),
        submittedAt: ctx.now, noticeAt: keep ? keep.at : '', type: ev.type, noticeHours: ev.noticeHours, run: ev.run, route: ev.decision, status: H.STATUS_FOR[ev.decision],
        approvals: ev.decision === 'special' ? { aakash: '', varun: '' } : {}, extremeEmergency: !!input.extremeEmergency, emergencyNo: ev.emergencyNo,
        penaltyEmergency: ev.penaltyEmergency, restrictionViolation: ev.restrictionViolation, decidedAt: '', decidedBy: '', decisionReason: '',
        history: r.history.concat([{ at: ctx.now, by: actor.id, action: 'edited', from: { dates: r.dates, kind: r.kind, status: r.status } }]) };
      if (ev.decision === 'auto' || ev.decision === 'recorded') { patch.decidedAt = ctx.now; patch.decidedBy = 'system'; }
      ctx.db.update('LeaveRequests', id, patch);
      // The violations of the old version stand until the new version is decided (granted now, or by Aakash later).
      if (patch.status === 'Approved' || patch.status === 'Recorded') { H.withdrawViolations(ctx, id, 'Request edited'); H.onGranted(ctx, Object.assign({}, r, patch)); }
      if (ev.decision === 'aakash' || ev.decision === 'special') H.byRole(ctx, 'manager').forEach(function (m) { H.notify(ctx, m.id, 'approval', 'Leave request edited', person.name + ': ' + ev.dates.join(', '), id); });
      if (ev.decision === 'varun' || ev.decision === 'special') H.byRole(ctx, 'owner').forEach(function (o) { H.notify(ctx, o.id, 'approval', 'Leave request edited', person.name + ': ' + ev.dates.join(', '), id); });
      H.audit(ctx, actor.id, 'leave.edit', id, { status: patch.status });
      return { id: id, status: patch.status, warnings: ev.warnings };
    });
  }

  /**
   * Only Varun can override a hard rule (clash or restriction), with a written reason.
   * It is logged and shown in the month report.
   */
  function overrideLeave(ctx, actor, input) {
    return ctx.env.withLock(function () {
      owner(actor);
      need(input.overrideReason, 'Write the reason for the override.');
      var person = H.find(ctx, 'People', input.forPersonId);
      if (!person) H.fail('NOT_FOUND', 'No such person.');
      var dates = (input.dates || []).slice().sort();
      if (!dates.length || !/^(full|half)$/.test(input.kind) || !dates.every(Cal.isDate)) H.fail('BLOCKED', 'Pick exact dates.');
      if (input.kind === 'half' && (dates.length !== 1 || !Cal.isTime(input.halfStart))) H.fail('BLOCKED', 'A half day is one date with a start time.');
      H.assertOpen(ctx, dates);
      H.assertOpen(ctx, dates);
      var clashOverlap = H.liveLeaves(ctx, person.id).some(function (r) { return r.dates.some(function (d) { return dates.indexOf(d) !== -1; }); });
      if (clashOverlap) H.fail('BLOCKED', 'This person already has a request on one of these dates.');
      var row = { id: ctx.env.randomId(), personId: person.id, kind: input.kind, dates: dates, halfStart: input.halfStart || '', reasonCode: input.reasonCode || 'Other',
        reasonText: String(input.reasonText || '').trim(), submittedAt: ctx.now, type: 'Regular', noticeHours: 0, run: dates.length, route: 'override', status: 'Approved',
        approvals: {}, extremeEmergency: false, emergencyNo: 0, penaltyEmergency: false, restrictionViolation: false, enteredBy: actor.id, decidedAt: ctx.now,
        decidedBy: actor.id, decisionReason: 'Override by Varun: ' + String(input.overrideReason).trim(), history: [{ at: ctx.now, by: actor.id, action: 'override' }],
        override: String(input.overrideReason).trim() };
      ctx.db.insert('LeaveRequests', row);
      H.audit(ctx, actor.id, 'leave.override', row.id, { reason: row.override, dates: dates });
      H.notify(ctx, person.id, 'decision', 'Leave: Approved', dates.join(', '), row.id);
      H.byRole(ctx, 'manager').forEach(function (m) { H.notify(ctx, m.id, 'override', 'Override by Varun', person.name + ': ' + dates.join(', '), row.id); });
      return { id: row.id, status: 'Approved' };
    });
  }

  // ---------- Settings ----------

  var PERSON_FIELDS = ['name', 'group', 'role', 'dutyStart', 'dutyEnd', 'sundayOff', 'noApproval', 'noClash', 'noQuota', 'dressExempt', 'active', 'email', 'phone'];
  function validPerson(p) {
    if (!String(p.name || '').trim()) H.fail('BLOCKED', 'Name is required.');
    if (!Cal.isTime(p.dutyStart) || !Cal.isTime(p.dutyEnd) || p.dutyEnd <= p.dutyStart) H.fail('BLOCKED', 'Duty times must be HH:MM and the end after the start.');
    if (['staff', 'manager', 'owner'].indexOf(p.role) === -1) H.fail('BLOCKED', 'Role must be staff, manager or owner.');
    var s = p.sundayOff;
    if (!(s === 'every' || (Array.isArray(s) && s.every(function (n) { return n >= 1 && n <= 5; })))) H.fail('BLOCKED', 'Sunday roster is not valid.');
  }
  /** Rules and restrictions hold names. When a name is corrected, they follow, so no rule silently loses a member. */
  function renameEverywhere(ctx, actor, from, to) {
    var swap = function (list) { return Array.isArray(list) ? list.map(function (n) { return n === from ? to : n; }) : list; };
    var has = function (list) { return Array.isArray(list) && list.indexOf(from) !== -1; };
    if (!ctx.db.rows('Rules').length) H.rules(ctx).forEach(function (r) { ctx.db.insert('Rules', r); });
    ctx.db.rows('Rules').forEach(function (r) {
      if (has(r.members) || has(r.emergencyIfAllPresent)) ctx.db.update('Rules', r.id, { members: swap(r.members), emergencyIfAllPresent: swap(r.emergencyIfAllPresent) });
    });
    ctx.db.rows('Restrictions').forEach(function (r) { if (has(r.appliesTo)) ctx.db.update('Restrictions', r.id, { appliesTo: swap(r.appliesTo) }); });
    H.audit(ctx, actor.id, 'people.rename', from, { to: to });
  }
  function savePerson(ctx, actor, p) {
    return ctx.env.withLock(function () {
      owner(actor);
      validPerson(p);
      var clean = {}; PERSON_FIELDS.forEach(function (f) { clean[f] = p[f] === undefined ? '' : p[f]; });
      clean.name = String(clean.name).trim();
      var existing = p.id && H.find(ctx, 'People', p.id);
      var sameName = ctx.db.rows('People').some(function (x) { return x.name === clean.name && x.id !== p.id && x.active !== false; });
      if (sameName) H.fail('BLOCKED', 'Another active person already has this name.');
      if (existing) {
        var losesOwner = existing.role === 'owner' && existing.active !== false && (clean.role !== 'owner' || clean.active === false);
        if (losesOwner && ctx.db.rows('People').filter(function (x) { return x.role === 'owner' && x.active !== false; }).length < 2) H.fail('BLOCKED', 'There must always be one active owner.');
        if (existing.name !== clean.name) renameEverywhere(ctx, actor, existing.name, clean.name);
        var before = {}; PERSON_FIELDS.forEach(function (f) { before[f] = existing[f]; });
        ctx.db.update('People', p.id, clean);
        H.audit(ctx, actor.id, 'people.update', p.id, { before: before, after: clean });
        return { id: p.id };
      }
      var id = clean.name.toLowerCase().replace(/[^a-z0-9]+/g, '-') + '-' + ctx.env.randomId().slice(0, 4);
      if (clean.active === '') clean.active = true;
      clean.joinedOn = H.today(ctx); // nobody is marked absent for days before they were added
      ctx.db.insert('People', Object.assign({ id: id, pinSalt: '', pinHash: '', pinTries: 0, pinLockedUntil: 0, pinLockLevel: 0 }, clean));
      H.audit(ctx, actor.id, 'people.create', id, clean);
      return { id: id };
    });
  }

  function setPay(ctx, actor, a) {
    return ctx.env.withLock(function () {
      owner(actor);
      if (!H.find(ctx, 'People', a.personId)) H.fail('NOT_FOUND', 'No such person.');
      ['fixedSalary', 'targetAllowance', 'disciplineBonus', 'dutyHours'].forEach(function (f) { if (!(Number(a[f]) >= 0)) H.fail('BLOCKED', f + ' must be a number.'); });
      if (!(Number(a.dutyHours) > 0)) H.fail('BLOCKED', 'Duty hours must be more than 0.');
      var row = { fixedSalary: +a.fixedSalary, targetAllowance: +a.targetAllowance, disciplineBonus: +a.disciplineBonus, dutyHours: +a.dutyHours, updatedAt: ctx.now, updatedBy: actor.id };
      if (ctx.db.rows('PayInfo').some(function (x) { return x.personId === a.personId; })) ctx.db.update('PayInfo', a.personId, row);
      else ctx.db.insert('PayInfo', Object.assign({ personId: a.personId }, row));
      H.audit(ctx, actor.id, 'pay.set', a.personId, {}); // the amounts are NOT copied into the audit log
      return { ok: true };
    });
  }

  function saveRule(ctx, actor, r) {
    return ctx.env.withLock(function () {
      owner(actor);
      var names = ctx.db.rows('People').map(function (p) { return p.name; });
      if (!Array.isArray(r.members) || r.members.length < 2 || !r.members.every(function (m) { return names.indexOf(m) !== -1; })) H.fail('BLOCKED', 'Choose at least 2 people.');
      if (!(r.minPresent >= 1 && r.minPresent < r.members.length)) H.fail('BLOCKED', 'Minimum present must be between 1 and one less than the group size.');
      var clean = { on: r.on !== false, label: String(r.label || '').trim() || r.id, members: r.members, minPresent: +r.minPresent,
        rosterSundayException: r.rosterSundayException || null, emergencyIfAllPresent: r.emergencyIfAllPresent || null };
      if (r.id && H.find(ctx, 'Rules', r.id)) { ctx.db.update('Rules', r.id, clean); H.audit(ctx, actor.id, 'rules.update', r.id, clean); return { id: r.id }; }
      var id = 'C' + (ctx.db.rows('Rules').length + 1) + '-' + ctx.env.randomId().slice(0, 3);
      ctx.db.insert('Rules', Object.assign({ id: id }, clean));
      H.audit(ctx, actor.id, 'rules.create', id, clean);
      return { id: id };
    });
  }

  /** Varun or Aakash can add a restriction (blackout period). */
  function saveRestriction(ctx, actor, r) {
    return ctx.env.withLock(function () {
      boss(actor);
      if (!Cal.isDate(r.from) || !Cal.isDate(r.to) || r.to < r.from) H.fail('BLOCKED', 'Pick a valid date range.');
      var old = r.id && H.find(ctx, 'Restrictions', r.id);
      if (r.id && !old) H.fail('NOT_FOUND', 'No such restriction.');
      // Aakash can add a restriction, and change one he added himself. Changing or switching off
      // any other one lifts a hard rule, and only Varun can do that.
      if (old && actor.role !== 'owner' && old.createdBy !== actor.id) H.fail('FORBIDDEN', 'Only Varun can change or switch off this restriction.');
      var known = ctx.db.rows('People').map(function (p) { return p.name; });
      if (Array.isArray(r.appliesTo) && !r.appliesTo.every(function (n) { return known.indexOf(n) !== -1; })) H.fail('BLOCKED', 'Choose people from the list.');
      need(r.note, 'Write a note, for example "Peak sales season".');
      if (r.rule !== 'no-leave' && r.rule !== 'violation') H.fail('BLOCKED', 'Choose the rule.');
      var clean = { from: r.from, to: r.to, note: String(r.note).trim(), rule: r.rule, appliesTo: Array.isArray(r.appliesTo) && r.appliesTo.length ? r.appliesTo : null, on: r.on !== false };
      if (old) { ctx.db.update('Restrictions', r.id, clean); H.audit(ctx, actor.id, 'restrictions.update', r.id, clean); return { id: r.id }; }
      var id = 'R' + ctx.env.randomId().slice(0, 6);
      ctx.db.insert('Restrictions', Object.assign({ id: id, createdBy: actor.id, createdAt: ctx.now }, clean));
      H.audit(ctx, actor.id, 'restrictions.create', id, clean);
      return { id: id };
    });
  }

  function setSetting(ctx, actor, key, value) {
    return ctx.env.withLock(function () {
      owner(actor);
      if (!Object.prototype.hasOwnProperty.call(SETTING_KEYS, key)) H.fail('BLOCKED', 'Unknown setting.');
      if (key === 'closedDays' && !(Array.isArray(value) && value.length <= 400 && value.every(Cal.isDate))) H.fail('BLOCKED', 'Closed days must be a list of dates.');
      if (key === 'closedDays') {
        // Adding or removing a closed day re-counts that month: not possible once the month is locked.
        var before = []; try { before = JSON.parse(setting(ctx, 'closedDays') || '[]') || []; } catch (e) { before = []; }
        H.assertOpen(ctx, value.filter(function (d) { return before.indexOf(d) === -1; }).concat(before.filter(function (d) { return value.indexOf(d) === -1; })));
      }
      if (key === 'reminderHours' && !(Number(value) >= 1 && Number(value) <= 48)) H.fail('BLOCKED', 'Reminder hours must be between 1 and 48.');
      if (key === 'startDate' && !Cal.isDate(value)) H.fail('BLOCKED', 'Pick the start date.');
      var added = [];
      if (key === 'closedDays') { var was = H.closedSet(ctx); added = value.filter(function (d) { return !was[d]; }); }
      putSetting(ctx, actor, key, value);
      // The shop was closed on a day that the evening job had already marked: those absences are withdrawn.
      added.forEach(function (d) {
        ctx.db.rows('LeaveRequests').forEach(function (r) {
          if (r.route !== 'system' || r.dates.indexOf(d) === -1 || r.status === 'Cancelled') return;
          ctx.db.update('LeaveRequests', r.id, { status: 'Cancelled', decisionReason: 'Shop closed that day', history: r.history.concat([{ at: ctx.now, by: actor.id, action: 'shop closed' }]) });
          H.withdrawViolations(ctx, r.id, 'Shop closed that day');
        });
      });
      return { ok: true };
    });
  }

  /** "Set shop location": standing inside the shop, a few seconds of GPS samples are averaged. */
  function setShopPoint(ctx, actor, samples) {
    return ctx.env.withLock(function () {
      boss(actor);
      // The first time, Aakash or Varun sets it standing in the shop. Once set, only Varun can move it.
      if (setting(ctx, 'shopPoint') && actor.role !== 'owner') H.fail('FORBIDDEN', 'The shop location is already set. Only Varun can change it.');
      var good = (Array.isArray(samples) ? samples.slice(0, 60) : []).filter(function (s) { return s && typeof s.lat === 'number' && typeof s.lng === 'number' && isFinite(s.lat) && isFinite(s.lng) && Math.abs(s.lat) <= 90 && Math.abs(s.lng) <= 180; });
      if (good.length < 3) H.fail('BLOCKED', 'Not enough location readings. Stand inside the shop and try again.');
      var lat = good.reduce(function (t, s) { return t + +s.lat; }, 0) / good.length, lng = good.reduce(function (t, s) { return t + +s.lng; }, 0) / good.length;
      putSetting(ctx, actor, 'shopPoint', { lat: Math.round(lat * 1e6) / 1e6, lng: Math.round(lng * 1e6) / 1e6, samples: good.length });
      return { lat: lat, lng: lng };
    });
  }

  /** Everything the Settings screen needs. Owner only. PIN and token data are never included. */
  function getSettings(ctx, actor) {
    owner(actor);
    var pay = {}; ctx.db.rows('PayInfo').forEach(function (p) { pay[p.personId] = { fixedSalary: p.fixedSalary, targetAllowance: p.targetAllowance, disciplineBonus: p.disciplineBonus, dutyHours: p.dutyHours }; });
    var s = {}; ctx.db.rows('Settings').forEach(function (x) { s[x.key] = x.value; });
    return {
      people: ctx.db.rows('People').map(function (p) { var o = { id: p.id, hasPin: !!p.pinHash, pay: pay[p.id] || null }; PERSON_FIELDS.forEach(function (f) { o[f] = p[f]; }); return o; }),
      rules: ctx.db.rows('Rules'), restrictions: ctx.db.rows('Restrictions'), graceTable: graceTable(ctx), settings: s
    };
  }

  var api = { DEFAULT_GRACE: DEFAULT_GRACE, graceTable: graceTable, recordIncident: recordIncident, disputeViolation: disputeViolation, decideDispute: decideDispute,
    editLeave: editLeave, overrideLeave: overrideLeave, savePerson: savePerson, setPay: setPay, saveRule: saveRule, saveRestriction: saveRestriction,
    setSetting: setSetting, setShopPoint: setShopPoint, getSettings: getSettings };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.GJAdmin = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);

// ===== src/server/views.js =====
/**
 * Read models for the Aakash / Varun screens (handoff 3.11): Today board, "Today at GJ",
 * calendar, month report and the month lock.
 */
(function (root) {
  'use strict';
  var req = (typeof require !== 'undefined') ? require : null;
  var Cal = req ? req('../rules/calendar.js') : root.GJCalendar;
  var Clash = req ? req('../rules/clash.js') : root.GJClash;
  var Core = req ? req('./core.js') : root.GJCore;
  var Att = req ? req('./attendance.js') : root.GJAttendance;
  var H = Core._;

  function boss(actor) { if (actor.role === 'staff') H.fail('FORBIDDEN', 'Only Aakash or Varun.'); }
  function staff(ctx) { return ctx.db.rows('People').filter(function (p) { return p.active !== false && p.role === 'staff'; }); }
  function hhmmToMin(t) { var a = t.split(':'); return +a[0] * 60 + +a[1]; }
  function istMin(ms) { var d = new Date(ms + H.IST_OFFSET_MS); return d.getUTCHours() * 60 + d.getUTCMinutes(); }

  /** Who is in, late, not in yet, on leave, out right now. */
  function board(ctx, actor) {
    boss(actor);
    var date = H.today(ctx), now = istMin(ctx.now);
    return { date: date, people: staff(ctx).map(function (p) {
      var punches = ctx.db.rows('Punches').filter(function (x) { return x.personId === p.id && x.date === date; });
      var pin = punches.filter(function (x) { return x.kind === 'in'; })[0], pout = punches.filter(function (x) { return x.kind === 'out'; })[0];
      var leave = ctx.db.rows('LeaveRequests').filter(function (r) { return r.personId === p.id && (r.status === 'Approved' || r.status === 'Recorded') && r.dates.indexOf(date) !== -1; })[0];
      var outing = ctx.db.rows('Outings').filter(function (o) { return o.personId === p.id && o.date === date && o.status === 'Approved'; })[0];
      var day = Att.expectedDay(ctx, p, date), start = day.start;
      var state = Cal.isRosterOff(p, date) ? 'Roster off' : leave && leave.kind === 'full' ? 'On leave' : pout ? 'Checked out' : outing ? 'Out right now'
        : pin ? 'In' : now > start + 10 ? 'Not in yet – late' : 'Not in yet';
      return { id: p.id, name: p.name, group: p.group, state: state, dutyStart: p.dutyStart, dueAt: start, checkInAt: pin ? pin.at : '', checkOutAt: pout ? pout.at : '',
        lateMinutes: pin ? Att.uncovered(start, istMin(pin.at), day.win) : (state.indexOf('late') !== -1 ? now - start : 0), photoId: pin ? pin.photoId : '', flag: pin ? pin.flag : '',
        halfDay: leave && leave.kind === 'half' ? leave.halfStart : '', outSince: outing ? outing.approvedAt : '' };
    }) };
  }

  /** Today's check-in photos: visible to all staff, the owner and the manager. */
  function todayAtGJ(ctx) {
    var date = H.today(ctx), names = {};
    ctx.db.rows('People').forEach(function (p) { names[p.id] = p.name; });
    return ctx.db.rows('Punches').filter(function (x) { return x.date === date && x.kind === 'in'; })
      .map(function (x) { return { name: names[x.personId], at: x.at, photoId: x.thumbId }; });
  }

  /** Month grid by group, with roster Sundays, restrictions and clash-risk days. */
  function calendar(ctx, actor, monthKey) {
    boss(actor);
    validMonth(monthKey);
    var people = staff(ctx), names = {}, map = H.peopleMap(ctx), rules = H.rules(ctx);
    ctx.db.rows('People').forEach(function (p) { names[p.id] = p.name; });
    var leaves = ctx.db.rows('LeaveRequests').filter(function (r) { return r.status === 'Approved' || r.status === 'Recorded' || H.OPEN[r.status] || r.status === 'Absent – unannounced'; });
    var away = H.approvedAway(ctx);
    var days = [];
    for (var i = 1; i <= Cal.daysInMonth(monthKey); i++) {
      var d = monthKey + '-' + (i < 10 ? '0' + i : i), entries = [];
      people.forEach(function (p) { if (Cal.isRosterOff(p, d)) entries.push({ name: p.name, group: p.group, kind: 'roster' }); });
      leaves.forEach(function (r) { if (r.dates.indexOf(d) !== -1) entries.push({ name: names[r.personId], kind: r.kind === 'half' ? 'half' : 'leave', status: r.status }); });
      // Clash risk: a rule is at its minimum, so the next request from that group will be refused.
      var awayMap = Clash.awayOn(d, map, away), risk = [];
      rules.forEach(function (rule) {
        if (rule.on === false) return;
        var present = rule.members.filter(function (m) { return !awayMap[m]; }).length;
        if (present <= rule.minPresent) risk.push(rule.label);
      });
      var restr = ctx.db.rows('Restrictions').filter(function (r) { return r.on !== false && d >= r.from && d <= r.to; }).map(function (r) { return { note: r.note, rule: r.rule }; });
      days.push({ date: d, sunday: Cal.nthSunday(d), entries: entries, risk: risk, restrictions: restr });
    }
    return { month: monthKey, days: days };
  }

  /** Restrictions that apply to the caller, shown on the apply form before dates are picked. */
  function myRestrictions(ctx, actor) {
    var me = H.find(ctx, 'People', actor.id), today = H.today(ctx);
    return ctx.db.rows('Restrictions').filter(function (r) {
      if (r.on === false || r.to < today) return false;
      return r.appliesTo ? r.appliesTo.indexOf(me.name) !== -1 : !me.noClash;
    }).map(function (r) { return { from: r.from, to: r.to, note: r.note, rule: r.rule }; });
  }

  /** What the approver needs on a pending card: the rule result, who else is away, the person's month so far. */
  function pendingContext(ctx, r) {
    var p = H.find(ctx, 'People', r.personId), out = { ruleResult: [], awayToo: [], month: null };
    if (!p) return out;
    try {
      var ev = H.evaluate(ctx, p, { kind: r.kind, dates: r.dates, halfStart: r.halfStart, reasonCode: r.reasonCode, reasonText: r.reasonText || '-', extremeEmergency: r.extremeEmergency }, r.id, { at: r.submittedAt });
      out.ruleResult = (ev.reasons || []).concat(ev.warnings || []);
    } catch (e) { out.ruleResult = []; }
    var map = H.peopleMap(ctx), away = H.approvedAway(ctx, r.id), seen = {};
    r.dates.forEach(function (d) {
      var m = Clash.awayOn(d, map, away);
      Object.keys(m).forEach(function (name) { if (name !== p.name && !seen[name + d]) { seen[name + d] = 1; out.awayToo.push({ name: name, date: d, why: m[name] === 'roster' ? 'roster Sunday' : 'away' }); } });
    });
    var mm = Att.myMonth(ctx, p.id, Cal.monthKey(r.dates[0]));
    out.month = { leaves: mm.leaves.total, free: mm.leaves.free, emergencies: mm.leaves.emergencies, bankLeft: mm.bank.left, violations: mm.ladder.violations };
    return out;
  }

  function validMonth(monthKey) { if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(String(monthKey))) H.fail('BLOCKED', 'Pick a month.'); }
  /** Everyone who belongs in a month's report: today's staff, and anyone who has left but has entries in that month. */
  function staffForMonth(ctx, monthKey) {
    var seen = {};
    ['LeaveRequests', 'Punches', 'DayMinutes', 'Violations'].forEach(function (tab) {
      ctx.db.rows(tab).forEach(function (r) {
        var dates = tab === 'LeaveRequests' ? r.dates : [r.date];
        if (dates.some(function (d) { return Cal.monthKey(String(d)) === monthKey; })) seen[r.personId] = true;
      });
    });
    return ctx.db.rows('People').filter(function (p) { return p.role === 'staff' && (p.active !== false || seen[p.id]); });
  }
  function lockedMonths(ctx) {
    var m = {}; ctx.db.rows('MonthSheet').forEach(function (r) { if (r.personId !== 'correction' && r.personId !== 'lock-ack') m[r.month] = true; });
    return m;
  }

  /** All staff for one month. If the month is locked, the locked result is returned, plus later corrections. */
  function monthReport(ctx, actor, monthKey) {
    boss(actor);
    validMonth(monthKey);
    var locked = ctx.db.rows('MonthSheet').filter(function (r) { return r.month === monthKey; });
    var acks = locked.filter(function (r) { return r.personId === 'lock-ack'; }).map(function (r) { return r.result.by; });
    var rows = locked.filter(function (r) { return r.personId !== 'correction' && r.personId !== 'lock-ack'; });
    var overrides = ctx.db.rows('LeaveRequests').filter(function (r) { return r.override && Cal.monthKey(r.dates[0]) === monthKey; })
      .map(function (r) { return { personId: r.personId, dates: r.dates, reason: r.override }; });
    if (rows.length) return { month: monthKey, locked: true, lockedBy: rows[0].lockedBy, lockedAt: rows[0].lockedAt, people: rows.map(function (r) { return r.result; }),
      corrections: locked.filter(function (r) { return r.personId === 'correction'; }).map(function (r) { return r.result; }), overrides: overrides };
    return { month: monthKey, locked: false, lockConfirmedBy: acks, people: staffForMonth(ctx, monthKey).map(function (p) { return Att.myMonth(ctx, p.id, monthKey); }), corrections: [], overrides: overrides };
  }

  /** Lock a finished month. After the lock nothing in it is recalculated; corrections are new logged entries. */
  function lockMonth(ctx, actor, monthKey) {
    return ctx.env.withLock(function () {
      boss(actor);
      validMonth(monthKey);
      if (monthKey >= Cal.monthKey(H.today(ctx))) H.fail('BLOCKED', 'A month can be locked only after it has ended.');
      if (lockedMonths(ctx)[monthKey]) H.fail('BLOCKED', 'This month is already locked.');
      // Handoff 3.11: Aakash AND Varun lock the month. The first one confirms; the lock happens when the other one confirms too.
      var acks = ctx.db.rows('MonthSheet').filter(function (r) { return r.month === monthKey && r.personId === 'lock-ack'; });
      var otherRole = actor.role === 'owner' ? 'manager' : 'owner', others = H.byRole(ctx, otherRole);
      if (acks.some(function (a) { return a.lockedBy === actor.id; })) H.fail('BLOCKED', 'You have already confirmed. Waiting for ' + others.map(function (o) { return o.name; }).join(' / ') + '.');
      if (others.length && !acks.length) {
        ctx.db.insert('MonthSheet', { id: ctx.env.randomId(), month: monthKey, personId: 'lock-ack', result: { by: actor.name, at: ctx.now }, lockedBy: actor.id, lockedAt: ctx.now });
        H.audit(ctx, actor.id, 'month.lock-confirm', monthKey);
        others.forEach(function (o) { H.notify(ctx, o.id, 'month', 'Month report ready to lock: ' + monthKey, actor.name + ' has confirmed it. Check the report and lock it.', monthKey); });
        return { month: monthKey, locked: false, waitingFor: others.map(function (o) { return o.name; }) };
      }
      staffForMonth(ctx, monthKey).forEach(function (p) {
        ctx.db.insert('MonthSheet', { id: ctx.env.randomId(), month: monthKey, personId: p.id, result: Att.myMonth(ctx, p.id, monthKey), lockedBy: actor.id, lockedAt: ctx.now });
      });
      H.audit(ctx, actor.id, 'month.lock', monthKey);
      H.byRole(ctx, 'owner').concat(H.byRole(ctx, 'manager')).forEach(function (m) { if (m.id !== actor.id) H.notify(ctx, m.id, 'month', 'Month locked: ' + monthKey, 'Locked by ' + actor.name, monthKey); });
      return { month: monthKey, locked: true };
    });
  }

  function addCorrection(ctx, actor, monthKey, personId, note) {
    return ctx.env.withLock(function () {
      boss(actor);
      validMonth(monthKey);
      if (!lockedMonths(ctx)[monthKey]) H.fail('BLOCKED', 'This month is not locked. Change the entry itself.');
      if (!String(note || '').trim()) H.fail('REASON', 'Write the correction.');
      var names = {}; ctx.db.rows('People').forEach(function (p) { names[p.id] = p.name; });
      ctx.db.insert('MonthSheet', { id: ctx.env.randomId(), month: monthKey, personId: 'correction',
        result: { personId: personId, name: names[personId] || '', note: String(note).trim(), by: actor.name, at: ctx.now }, lockedBy: actor.id, lockedAt: ctx.now });
      H.audit(ctx, actor.id, 'month.correction', monthKey, { personId: personId, note: note });
      return { ok: true };
    });
  }

  var api = { board: board, todayAtGJ: todayAtGJ, calendar: calendar, myRestrictions: myRestrictions, monthReport: monthReport, lockMonth: lockMonth,
    addCorrection: addCorrection, lockedMonths: lockedMonths, pendingContext: pendingContext };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.GJViews = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);

// ===== src/server/jobs.js =====
/**
 * Timed jobs (handoff 3.12): email delivery, reminders, proactive warnings,
 * evening-before reminder, end-of-day absent check and the owner's daily summary.
 * Pure logic; Apps Script triggers call run(ctx, jobName, mailer).
 * mailer = { quota() -> number of emails left today, send(to, subject, body) }
 */
(function (root) {
  'use strict';
  var req = (typeof require !== 'undefined') ? require : null;
  var Cal = req ? req('../rules/calendar.js') : root.GJCalendar;
  var Core = req ? req('./core.js') : root.GJCore;
  var Att = req ? req('./attendance.js') : root.GJAttendance;
  var Views = req ? req('./views.js') : root.GJViews;
  var H = Core._;

  var DEFAULT_REMINDER_HOURS = 2; // owner, 20 Nov 2026
  var BANK_WARN_AT = 0.8;

  function setting(ctx, key) { var s = ctx.db.rows('Settings').filter(function (x) { return x.key === key; })[0]; return s ? s.value : ''; }
  function staff(ctx) { return ctx.db.rows('People').filter(function (p) { return p.active !== false && p.role === 'staff'; }); }
  function once(ctx, to, kind, ref, title, body) {
    var had = ctx.db.rows('Notifications').some(function (n) { return n.to === to && n.kind === kind && n.ref === ref; });
    if (!had) H.notify(ctx, to, kind, title, body, ref);
    return !had;
  }
  function timeOf(ms) { var d = new Date(ms + H.IST_OFFSET_MS); return ('0' + d.getUTCHours()).slice(-2) + ':' + ('0' + d.getUTCMinutes()).slice(-2); }

  /** One digest email per person for everything not yet emailed. In-app alerts work even with no email. */
  function sendEmails(ctx, mailer) {
    var people = {}; ctx.db.rows('People').forEach(function (p) { people[p.id] = p; });
    var groups = {};
    ctx.db.rows('Notifications').forEach(function (n) { if (!n.emailedAt) (groups[n.to] = groups[n.to] || []).push(n); });
    var sent = 0, marks = [];
    Object.keys(groups).forEach(function (to) {
      var p = people[to], list = groups[to];
      var email = p && (p.email || (p.role === 'owner' ? ctx.env.ownerEmail : ''));
      if (!email) { list.forEach(function (n) { marks.push([n.id, -1]); }); return; } // -1 = no address, in-app only
      var left = 0; try { left = mailer.quota(); } catch (e) { left = 0; }
      if (left < 1) return; // out of quota today: try again on the next run
      var subject = list.length === 1 ? 'GJ Leave: ' + list[0].title : 'GJ Leave: ' + list.length + ' updates';
      var body = list.map(function (n) { return '\u2022 ' + n.title + (n.body ? '\n  ' + n.body : ''); }).join('\n\n') + '\n\nOpen the app to act on these.';
      try { mailer.send(email, subject, body); }
      catch (e) { list.forEach(function (n) { marks.push([n.id, -2]); }); return; } // -2 = the address was refused: in-app only, never retried for these
      list.forEach(function (n) { marks.push([n.id, ctx.now]); });
      sent += 1;
    });
    // The marks are written together, on fresh rows, inside the server lock.
    ctx.env.withLock(function () {
      if (ctx.db.reset) ctx.db.reset();
      marks.forEach(function (m) { ctx.db.update('Notifications', m[0], { emailedAt: m[1] }); });
    });
    return sent;
  }

  /** A pending request reminds Aakash again every X hours (owner: 2). Varun too when he must decide. */
  function reminders(ctx) {
    var hours = Number(setting(ctx, 'reminderHours')) || DEFAULT_REMINDER_HOURS, gap = hours * 3600000, n = 0;
    var names = {}; ctx.db.rows('People').forEach(function (p) { names[p.id] = p.name; });
    ctx.db.rows('LeaveRequests').forEach(function (r) {
      if (!H.OPEN[r.status]) return;
      var last = r.remindedAt || r.submittedAt;
      if (ctx.now - last < gap) return;
      var who = [];
      if (r.route === 'aakash' || (r.route === 'special' && r.approvals.aakash !== 'yes')) who = who.concat(H.byRole(ctx, 'manager'));
      if (r.route === 'varun' || (r.route === 'special' && r.approvals.varun !== 'yes')) who = who.concat(H.byRole(ctx, 'owner'));
      who.forEach(function (m) { H.notify(ctx, m.id, 'reminder', 'Reminder: leave request waiting', names[r.personId] + ': ' + r.dates.join(', '), r.id); });
      ctx.db.update('LeaveRequests', r.id, { remindedAt: ctx.now });
      n += 1;
    });
    ctx.db.rows('ShortRequests').forEach(function (q) {
      if (q.status !== 'Pending') return;
      var last = q.remindedAt || q.submittedAt;
      if (ctx.now - last < gap) return;
      H.byRole(ctx, 'manager').forEach(function (m) { H.notify(ctx, m.id, 'reminder', 'Reminder: late / early request waiting', names[q.personId] + ': ' + q.date + ' ' + q.time, q.id); });
      ctx.db.update('ShortRequests', q.id, { remindedAt: ctx.now });
      n += 1;
    });
    return n;
  }

  /** "Bank 80% used", "1 more = violation ...", and the notice stage to Varun. Each is sent once per month. */
  function warnings(ctx) {
    var month = Cal.monthKey(H.today(ctx)), n = 0;
    staff(ctx).forEach(function (p) {
      if (p.noApproval) return;
      var m = Att.myMonth(ctx, p.id, month);
      if (m.bank.used >= m.bank.minutes * BANK_WARN_AT && m.bank.left > 0)
        n += once(ctx, p.id, 'warn-bank80', month, '2-hour bank: 80% used', m.bank.left + ' min left this month. After the bank, extra minutes would be deducted.') ? 1 : 0;
      if (m.bank.left === 0)
        n += once(ctx, p.id, 'warn-bank0', month, '2-hour bank is used up', 'Every extra 2 hours beyond the bank = 1 violation.') ? 1 : 0;
      if (m.bank.passesUsed >= m.bank.passes)
        n += once(ctx, p.id, 'warn-passes', month, 'All 3 not-informed passes are used', 'After the passes, every 2nd not-informed time is a violation.') ? 1 : 0;
      if (m.ladder.violations === 1)
        n += once(ctx, p.id, 'warn-v1', month, '1 violation this month', '1 more violation = discipline bonus and target allowance would be lost.') ? 1 : 0;
      if (m.ladder.violations === 2)
        n += once(ctx, p.id, 'warn-v2', month, '2 violations this month', '1 more violation = notice.') ? 1 : 0;
      if (m.ladder.notice) H.byRole(ctx, 'owner').forEach(function (o) {
        n += once(ctx, o.id, 'notice-stage', month + ':' + p.id, 'Notice stage: ' + p.name, m.ladder.violations + ' violations in ' + month + '. Your decision is needed.') ? 1 : 0;
      });
      if (m.leaves.emergencies >= m.leaves.emergenciesAllowed)
        n += once(ctx, p.id, 'warn-emergency', month, 'Both emergency leaves are used', 'The next emergency leave this month is a violation and is not a free leave.') ? 1 : 0;
    });
    return n;
  }

  /** The evening before: remind people whose leave starts tomorrow. */
  function eveningBefore(ctx) {
    var tomorrow = Cal.addDays(H.today(ctx), 1), n = 0;
    ctx.db.rows('LeaveRequests').forEach(function (r) {
      if (r.status === 'Approved' && r.dates[0] === tomorrow) n += once(ctx, r.personId, 'leave-tomorrow', r.id, 'Your leave starts tomorrow', r.dates.join(', ') + (r.kind === 'half' ? ' (half day from ' + r.halfStart + ')' : '')) ? 1 : 0;
    });
    return n;
  }

  /** After closing: absent check, then the owner's daily summary of who was away or late. */
  function endOfDay(ctx) {
    var date = H.today(ctx);
    // If the job did not run on an earlier night (a failed timer, quota), those days are checked now.
    // Never before the day the Sheet was started, and never twice: a day already dealt with is left alone.
    var start = setting(ctx, 'startDate'), absent = [];
    [3, 2, 1].forEach(function (back) {
      var d = Cal.addDays(date, -back);
      if (start && d < start) return;
      Att.endOfDay(ctx, d).forEach(function (name) { absent.push(name + ' (' + d.slice(8) + '-' + d.slice(5, 7) + ')'); });
    });
    absent = Att.endOfDay(ctx, date).concat(absent);
    var hurt = ctx.db.damaged ? ctx.db.damaged() : [];
    var b = Views.board(ctx, { role: 'owner' });
    var late = b.people.filter(function (p) { return p.checkInAt && p.lateMinutes > 10; }).map(function (p) { return p.name + ' ' + p.lateMinutes + ' min (in ' + timeOf(p.checkInAt) + ')'; });
    var leave = b.people.filter(function (p) { return p.state === 'On leave' || p.halfDay; }).map(function (p) { return p.name + (p.halfDay ? ' (half day)' : ''); });
    var noOut = b.people.filter(function (p) { return p.checkInAt && !p.checkOutAt; }).map(function (p) { return p.name; });
    var lines = ['On leave: ' + (leave.join(', ') || 'none'), 'Late: ' + (late.join(', ') || 'none'), 'Absent with no request: ' + (absent.join(', ') || 'none'),
      'No check-out yet: ' + (noOut.join(', ') || 'none')];
    if (hurt.length) lines.push('DAMAGED ROWS in the Sheet (edited by hand, ignored by the app until repaired): ' + hurt.join(', '));
    H.byRole(ctx, 'owner').forEach(function (o) { once(ctx, o.id, 'daily-summary', date, 'Daily summary ' + date, lines.join('\n  ')); });
    // A missing check-out is flagged for Aakash the next morning.
    if (noOut.length) H.byRole(ctx, 'manager').forEach(function (m) { once(ctx, m.id, 'missing-checkout', date, 'Missing check-out', noOut.join(', ') + ' on ' + date + '. Please fix.'); });
    return { absent: absent, summary: lines };
  }

  function run(ctx, job, mailer) {
    if (job === 'emails') return sendEmails(ctx, mailer);
    if (job === 'hourly') return ctx.env.withLock(function () { if (ctx.db.reset) ctx.db.reset(); return { reminders: reminders(ctx), warnings: warnings(ctx) }; });
    if (job === 'evening') return ctx.env.withLock(function () { if (ctx.db.reset) ctx.db.reset(); return eveningBefore(ctx); });
    if (job === 'endOfDay') return ctx.env.withLock(function () { if (ctx.db.reset) ctx.db.reset(); return endOfDay(ctx); });
    throw new Error('Unknown job ' + job);
  }

  var api = { run: run, sendEmails: sendEmails, reminders: reminders, warnings: warnings, eveningBefore: eveningBefore, endOfDay: endOfDay };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.GJJobs = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);

// ===== src/server/api.js =====
/**
 * API dispatcher. One entry point for every call from the phone.
 * request = { action, personId, deviceToken, clientVersion, args }
 * Always returns { ok: true, data } or { ok: false, code, message }.
 *
 * Privacy: every reply is built here from an explicit list of fields. Salary data
 * (PayInfo) is never included in anything that another staff member can receive.
 */
(function (root) {
  'use strict';
  var Core = (typeof require !== 'undefined') ? require('./core.js') : root.GJCore;
  var Att = (typeof require !== 'undefined') ? require('./attendance.js') : root.GJAttendance;
  var Admin = (typeof require !== 'undefined') ? require('./admin.js') : root.GJAdmin;
  var Views = (typeof require !== 'undefined') ? require('./views.js') : root.GJViews;

  var MIN_CLIENT_VERSION = 1; // version gate: an old cached app must update before it can do anything
  var SERVER_VERSION = 9;     // goes up with every server release; the phone shows it under More
  var Schema = (typeof require !== 'undefined') ? require('./schema.js') : root.GJSchema;

  function leaveView(r, names, viewer) {
    var own = r.personId === viewer.id, boss = viewer.role !== 'staff';
    var v = { id: r.id, personId: r.personId, name: names[r.personId], kind: r.kind, dates: r.dates, halfStart: r.halfStart,
      status: r.status, type: r.type };
    if (own || boss) {
      // The reason is visible only to the applicant, Aakash and Varun.
      v.reasonCode = r.reasonCode; v.reasonText = r.reasonText; v.submittedAt = r.submittedAt; v.route = r.route;
      v.approvals = r.approvals; v.decisionReason = r.decisionReason; v.enteredBy = r.enteredBy ? names[r.enteredBy] : '';
      v.history = r.history; v.run = r.run; v.noticeHours = r.noticeHours;
    }
    return v;
  }

  var PUBLIC = {
    names: function (ctx) {
      // Login screen: names only. Nothing else leaves the server without a bound phone.
      return ctx.db.rows('People').filter(function (p) { return p.active !== false; }).map(function (p) { return { id: p.id, name: p.name }; });
    },
    login: function (ctx, a) { return Core.login(ctx, a.personId, a.pin, a.deviceToken, a.deviceLabel); }
  };

  var PRIVATE = {
    me: function (ctx, actor) {
      var p = ctx.db.rows('People').filter(function (x) { return x.id === actor.id; })[0];
      var shop = ctx.db.rows('Settings').filter(function (x) { return x.key === 'shopPoint'; })[0], point = null;
      try { if (shop) { var sp = JSON.parse(shop.value); point = { lat: sp.lat, lng: sp.lng }; } } catch (e) { point = null; }
      return { id: p.id, name: p.name, role: p.role, group: p.group, dutyStart: p.dutyStart, dutyEnd: p.dutyEnd, reasons: Core.REASONS,
        serverVersion: SERVER_VERSION, schemaVersion: Schema.SCHEMA_VERSION, dressExempt: !!p.dressExempt, deviceShort: String(actor.deviceId || '').slice(-4), shopPoint: point, serverTime: ctx.now };
    },
    previewLeave: function (ctx, actor, a) { return Core.previewLeave(ctx, actor, a); },
    submitLeave: function (ctx, actor, a) { return Core.submitLeave(ctx, actor, a); },
    decideLeave: function (ctx, actor, a) { return Core.decideLeave(ctx, actor, a.id, !!a.approve, a.reason); },
    cancelLeave: function (ctx, actor, a) { return Core.cancelLeave(ctx, actor, a.id, a.reason); },
    myLeaves: function (ctx, actor) {
      var names = nameMap(ctx);
      return ctx.db.rows('LeaveRequests').filter(function (r) { return r.personId === actor.id; }).map(function (r) { return leaveView(r, names, actor); });
    },
    pending: function (ctx, actor) {
      if (actor.role === 'staff') throw err('FORBIDDEN', 'Only Aakash or Varun.');
      var names = nameMap(ctx);
      return ctx.db.rows('LeaveRequests').filter(function (r) { return /^(Pending|Special)/.test(r.status); }).map(function (r) { return leaveView(r, names, actor); });
    },
    requestShort: function (ctx, actor, a) { return Att.requestShort(ctx, actor, a); },
    effect: function (ctx, actor, a) {
      // Live preview for late / early / going out, shown before the request is sent.
      var me = ctx.db.rows('People').filter(function (x) { return x.id === actor.id; })[0], minutes = +a.minutes;
      if (a.kind !== 'out' && /^\d{2}:\d{2}$/.test(a.time || '')) {
        var t = +a.time.slice(0, 2) * 60 + +a.time.slice(3), s = +me.dutyStart.slice(0, 2) * 60 + +me.dutyStart.slice(3), e = +me.dutyEnd.slice(0, 2) * 60 + +me.dutyEnd.slice(3);
        minutes = a.kind === 'late' ? t - s : e - t;
      }
      if (!(minutes > 0)) return { counted: 0, lines: [] };
      return Att.effectOf(ctx, actor.id, a.kind, minutes, a.date);
    },
    decideShort: function (ctx, actor, a) { return Att.decideShort(ctx, actor, a.id, !!a.approve, a.reason); },
    checkIn: function (ctx, actor, a) {
      // a = what PREPARE.checkIn made of the phone's request. Inside the server lock, on fresh data:
      // a second copy of the same check-in (a retry, a second tab) is refused here.
      var result = Att.checkIn(ctx, actor, { lat: a.lat, lng: a.lng, accuracy: a.accuracy, dress: a.dress, photoId: a.photoId, thumbId: a.thumbId });
      ctx.db.insert('Thumbs', { id: a.thumbId, personId: actor.id, date: Core._.today(ctx), data: a.thumb });
      return result;
    },
    photo: function (ctx, actor, a) {
      if (typeof a.id !== 'string' || !a.id) throw err('NOT_FOUND', 'No such photo.');
      var p = ctx.db.rows('Punches').filter(function (x) { return x.photoId === a.id || x.thumbId === a.id; })[0];
      if (!p) throw err('NOT_FOUND', 'No such photo.');
      var isThumbToday = p.thumbId === a.id && p.date === Core._.today(ctx);   // "Today at GJ": everyone
      if (!(isThumbToday || actor.role !== 'staff' || p.personId === actor.id)) throw err('FORBIDDEN', 'You cannot see this photo.');
      if (p.thumbId === a.id) {
        var th = ctx.db.tail('Thumbs', 80).filter(function (x) { return x.id === a.id; })[0]; // recent thumbnails only
        if (th) return { data: th.data };
        return { data: ctx.env.readPhoto(p.photoId) }; // older than the recent rows: fall back to the photo itself
      }
      return { data: ctx.env.readPhoto(a.id) };
    },
    decideDress: function (ctx, actor, a) { return Att.decideDress(ctx, actor, a.id, !!a.confirm, Admin.recordIncident); },
    manualCheckIn: function (ctx, actor, a) { return Att.manualCheckIn(ctx, actor, a); },
    manualCheckOut: function (ctx, actor, a) { return Att.manualCheckOut(ctx, actor, a); },
    checkOut: function (ctx, actor) { return Att.checkOut(ctx, actor); },
    goingOut: function (ctx, actor, a) { return Att.goingOut(ctx, actor, a); },
    decideOuting: function (ctx, actor, a) { return Att.decideOuting(ctx, actor, a.id, !!a.approve, a.reason); },
    imBack: function (ctx, actor, a) { return Att.imBack(ctx, actor, a.id); },
    confirmBack: function (ctx, actor, a) { return Att.confirmBack(ctx, actor, a.id, a.correctedTime); },
    remindBack: function (ctx, actor, a) { return Att.remindBack(ctx, actor, a.id); },
    excuseAbsence: function (ctx, actor, a) { return Att.excuseAbsence(ctx, actor, a.id, a.reason); },
    myMonth: function (ctx, actor, a) {
      // A staff member sees only their own month. Aakash and Varun may open anyone's.
      var personId = a.personId || actor.id;
      if (personId !== actor.id && actor.role === 'staff') throw err('FORBIDDEN', 'You can see only your own page.');
      return Att.myMonth(ctx, personId, a.month);
    },
    today: function (ctx, actor) {
      var date = Core._.today(ctx);
      var mine = function (tab) { return ctx.db.rows(tab).filter(function (r) { return r.personId === actor.id && r.date === date; }); };
      var punches = mine('Punches');
      var pick = function (kind) { var p = punches.filter(function (x) { return x.kind === kind; })[0]; return p ? { at: p.at, flag: p.flag } : null; };
      var outing = mine('Outings').filter(function (o) { return o.status === 'Pending' || o.status === 'Approved' || o.status === 'Back'; })[0];
      return { date: date, serverTime: ctx.now, hints: Att.hints(ctx, actor.id), checkIn: pick('in'), checkOut: pick('out'),
        outing: outing ? { id: outing.id, status: outing.status, reason: outing.reason, approvedAt: outing.approvedAt, backAt: outing.backAt, minutes: outing.minutes } : null,
        shorts: mine('ShortRequests').filter(function (q) { return q.status === 'Pending' || q.status === 'Approved' || q.status === 'Rejected'; })
          .map(function (q) { return { id: q.id, kind: q.kind, time: q.time, status: q.status, decisionReason: q.decisionReason }; }) };
    },
    approvals: function (ctx, actor) {
      if (actor.role === 'staff') throw err('FORBIDDEN', 'Only Aakash or Varun.');
      var names = nameMap(ctx);
      var out = {
        leaves: ctx.db.rows('LeaveRequests').filter(function (r) { return /^(Pending|Special)/.test(r.status); }).map(function (r) { return Object.assign(leaveView(r, names, actor), { context: Views.pendingContext(ctx, r) }); }),
        absences: ctx.db.rows('LeaveRequests').filter(function (r) { return r.status === 'Absent \u2013 unannounced'; }).map(function (r) { return { id: r.id, name: names[r.personId], dates: r.dates }; }),
        outings: ctx.db.rows('Outings').filter(function (o) { return o.status === 'Pending' || o.status === 'Back'; }).map(function (o) {
          return { id: o.id, name: names[o.personId], status: o.status, reason: o.reason, expectedMinutes: o.expectedMinutes, requestedAt: o.requestedAt, approvedAt: o.approvedAt, backAt: o.backAt, minutes: o.minutes };
        }),
        // Out right now: if the person never taps "I'm back", Aakash closes it with the real time.
        outNow: ctx.db.rows('Outings').filter(function (o) { return o.status === 'Approved'; }).map(function (o) {
          return { id: o.id, name: names[o.personId], date: o.date, reason: o.reason, expectedMinutes: o.expectedMinutes, approvedAt: o.approvedAt };
        }),
        shorts: ctx.db.rows('ShortRequests').filter(function (q) { return q.status === 'Pending'; })
          .map(function (q) { return { id: q.id, name: names[q.personId], kind: q.kind, date: q.date, time: q.time, submittedAt: q.submittedAt }; }),
        dress: ctx.db.rows('Punches').filter(function (x) { return x.dress && !x.dressDecision && Att.dressIssues(x.dress).length; })
          .map(function (x) { return { id: x.id, name: names[x.personId], date: x.date, issues: Att.dressIssues(x.dress), belt: x.dress.belt, photoId: x.photoId }; }),
        devices: []
      };
      if (actor.role === 'owner') out.devices = ctx.db.rows('Devices').filter(function (d) { return d.status === 'pending'; })
        .map(function (d) { return { id: d.id, name: names[d.personId], label: d.label, requestedAt: d.requestedAt }; });
      return out;
    },
    // management
    recordIncident: function (ctx, actor, a) { return Admin.recordIncident(ctx, actor, a); },
    incidentItems: function (ctx, actor) {
      if (actor.role === 'staff') throw err('FORBIDDEN', 'Only Aakash or Varun.');
      return { items: Admin.graceTable(ctx), people: ctx.db.rows('People').filter(function (p) { return p.active !== false && p.role === 'staff'; }).map(function (p) { return { id: p.id, name: p.name }; }) };
    },
    disputeViolation: function (ctx, actor, a) { return Admin.disputeViolation(ctx, actor, a.id, a.text); },
    decideDispute: function (ctx, actor, a) { return Admin.decideDispute(ctx, actor, a.id, !!a.uphold, a.note); },
    disputes: function (ctx, actor) {
      if (actor.role !== 'owner') throw err('FORBIDDEN', 'Only the owner.');
      var names = nameMap(ctx);
      return ctx.db.rows('Violations').filter(function (v) { return v.disputeState === 'open'; })
        .map(function (v) { return { id: v.id, name: names[v.personId], date: v.date, rule: v.rule, note: v.note, text: v.disputeText, disputeAt: v.disputeAt }; });
    },
    editLeave: function (ctx, actor, a) { return Admin.editLeave(ctx, actor, a.id, a); },
    overrideLeave: function (ctx, actor, a) { return Admin.overrideLeave(ctx, actor, a); },
    getSettings: function (ctx, actor) { return Admin.getSettings(ctx, actor); },
    savePerson: function (ctx, actor, a) { return Admin.savePerson(ctx, actor, a); },
    setPay: function (ctx, actor, a) { return Admin.setPay(ctx, actor, a); },
    saveRule: function (ctx, actor, a) { return Admin.saveRule(ctx, actor, a); },
    saveRestriction: function (ctx, actor, a) { return Admin.saveRestriction(ctx, actor, a); },
    restrictions: function (ctx, actor) {
      if (actor.role === 'staff') throw err('FORBIDDEN', 'Only Aakash or Varun.');
      return { list: ctx.db.rows('Restrictions'), people: ctx.db.rows('People').filter(function (p) { return p.active !== false && p.role === 'staff'; }).map(function (p) { return p.name; }) };
    },
    setSetting: function (ctx, actor, a) { return Admin.setSetting(ctx, actor, a.key, a.value); },
    setShopPoint: function (ctx, actor, a) { return Admin.setShopPoint(ctx, actor, a.samples); },
    board: function (ctx, actor) { return Views.board(ctx, actor); },
    todayAtGJ: function (ctx) { return Views.todayAtGJ(ctx); },
    calendar: function (ctx, actor, a) { return Views.calendar(ctx, actor, a.month); },
    myRestrictions: function (ctx, actor) { return Views.myRestrictions(ctx, actor); },
    monthReport: function (ctx, actor, a) { return Views.monthReport(ctx, actor, a.month); },
    lockMonth: function (ctx, actor, a) { return Views.lockMonth(ctx, actor, a.month); },
    addCorrection: function (ctx, actor, a) { return Views.addCorrection(ctx, actor, a.month, a.personId, a.note); },
    signOut: function (ctx, actor) { return Core.signOut(ctx, actor); },
    setPin: function (ctx, actor, a) { return Core.setPin(ctx, actor, a.personId, a.pin); },
    devices: function (ctx, actor) {
      if (actor.role !== 'owner') throw err('FORBIDDEN', 'Only the owner.');
      var names = nameMap(ctx);
      return ctx.db.rows('Devices').map(function (d) { return { id: d.id, name: names[d.personId], label: d.label, status: d.status, requestedAt: d.requestedAt, decidedAt: d.decidedAt }; });
    },
    decideDevice: function (ctx, actor, a) { return Core.decideDevice(ctx, actor, a.id, !!a.approve); },
    notifications: function (ctx, actor) {
      return ctx.db.rows('Notifications').filter(function (n) { return n.to === actor.id; }).slice(-50)
        .map(function (n) { return { id: n.id, kind: n.kind, title: n.title, body: n.body, ref: n.ref, createdAt: n.createdAt, readAt: n.readAt }; });
    }
  };

  function nameMap(ctx) { var m = {}; ctx.db.rows('People').forEach(function (p) { m[p.id] = p.name; }); return m; }
  function err(code, message) { var e = new Error(message); e.code = code; return e; }

  // Actions that only read. Everything else changes data and runs, from start to end, inside the server lock.
  var READ_ONLY = { me: 1, previewLeave: 1, myLeaves: 1, pending: 1, effect: 1, photo: 1, myMonth: 1, today: 1, approvals: 1, incidentItems: 1,
    disputes: 1, getSettings: 1, restrictions: 1, board: 1, todayAtGJ: 1, calendar: 1, myRestrictions: 1, monthReport: 1, devices: 1, notifications: 1 };
  var JPEG = /^data:image\/jpeg;base64,[A-Za-z0-9+\/]+=*$/;
  var TEXT_MAX = 2000, LIST_MAX = 400;

  /** Slow work that must not hold the lock: the photo upload. Runs after sign-in is checked, before the lock. */
  var PREPARE = {
    checkIn: function (ctx, actor, a) {
      // The check-in photo is taken inside the app (back camera, landscape) and is required.
      // An app from before the photo check-in sends no photo at all: it must update, it can never check in.
      if (!a.photo || !a.thumb) throw err('UPDATE', 'Please update the app: close it and open it again.');
      if (typeof a.photo !== 'string' || typeof a.thumb !== 'string' || a.photo.length > 900000 || a.thumb.length > 45000) throw err('BLOCKED', 'The photo is too large. Please try again.');
      // Only a picture made by the app is stored: never a link that other phones would then load.
      if (!JPEG.test(a.thumb) || !JPEG.test(a.photo)) throw err('BLOCKED', 'The photo could not be read. Please take it again.');
      if (ctx.db.rows('Punches').some(function (x) { return x.personId === actor.id && x.date === Core._.today(ctx) && x.kind === 'in'; })) throw err('BLOCKED', 'You have already checked in today.');
      var stamp = Core._.today(ctx) + '_' + actor.id + '_' + ctx.now;
      // Full photo: private Drive folder. Thumbnail: a small cell in the Thumbs tab (no second Drive file).
      return { lat: a.lat, lng: a.lng, accuracy: a.accuracy, dress: a.dress, thumb: a.thumb, photoId: ctx.env.savePhoto(stamp + '.jpg', a.photo), thumbId: 't_' + ctx.env.randomId() };
    }
  };

  function own(map, key) { return typeof key === 'string' && Object.prototype.hasOwnProperty.call(map, key); }

  /** Sizes are enforced here, not only in the phone: no text beyond 2,000 characters, no endless lists. */
  function checkSizes(v, key, depth) {
    if (typeof v === 'string') {
      var max = key === 'photo' ? 900000 : key === 'thumb' ? 45000 : TEXT_MAX;
      if (v.length > max) throw err('BLOCKED', 'That text is too long.');
    } else if (v && typeof v === 'object') {
      if (depth > 5) throw err('BLOCKED', 'The request is not valid.');
      var keys = Object.keys(v);
      if (keys.length > LIST_MAX) throw err('BLOCKED', 'That list is too long.');
      keys.forEach(function (k) { checkSizes(v[k], k, depth + 1); });
    }
  }

  /**
   * Run a changing action inside the server lock. Whatever was read while waiting for the lock is
   * thrown away first, so every decision is made on what the Sheet holds NOW. If the action is
   * refused half-way, nothing of it is saved (except a counted wrong PIN).
   */
  function locked(ctx, fn) {
    return ctx.env.withLock(function () {
      if (ctx.db.reset) ctx.db.reset();
      try { return fn(); }
      catch (e) { if (!(e && e.keep) && ctx.db.discard) ctx.db.discard(); throw e; }
    });
  }

  function handle(ctx, request) {
    try {
      request = request || {};
      var args = request.args && typeof request.args === 'object' && !Array.isArray(request.args) ? request.args : {};
      var action = request.action;
      if (!(request.clientVersion >= MIN_CLIENT_VERSION)) return { ok: false, code: 'UPDATE', message: 'Please update the app.' };
      if (!own(PUBLIC, action) && !own(PRIVATE, action)) return { ok: false, code: 'UNKNOWN', message: 'Unknown action.' };
      checkSizes(args, '', 0);
      if (action === 'names') return { ok: true, data: PUBLIC.names(ctx, args) };
      if (own(PUBLIC, action)) return { ok: true, data: locked(ctx, function () { return PUBLIC[action](ctx, args); }) };
      // New code on a Sheet that has not been upgraded yet (setupOrUpgrade not run): nothing is
      // attempted, nothing is half-saved, and the phone gets a clear answer.
      if (ctx.db.schemaProblems && ctx.db.schemaProblems().length) return { ok: false, code: 'UPGRADE', message: 'The app is being updated. Please try again in a few minutes.' };
      var actor = Core.authenticate(ctx, request.personId, request.deviceToken);
      if (own(READ_ONLY, action)) return { ok: true, data: PRIVATE[action](ctx, actor, args) };
      if (own(PREPARE, action)) args = PREPARE[action](ctx, actor, args);
      return { ok: true, data: locked(ctx, function () {
        var fresh = Core.authenticate(ctx, request.personId, request.deviceToken); // the phone may have been removed meanwhile
        return PRIVATE[action](ctx, fresh, args);
      }) };
    } catch (e) {
      if (e && e.code) return { ok: false, code: e.code, message: e.message };
      // Unexpected: leave a trace the owner or a developer can find (Apps Script: Executions log).
      var ref = 'E' + String(ctx && ctx.now || 0).slice(-7);
      try { if (typeof console !== 'undefined' && console.error) console.error('GJ Leave error ' + ref + ' in "' + (request && request.action) + '": ' + (e && (e.stack || e.message || e))); } catch (e2) { /* no log available */ }
      return { ref: ref, ok: false, code: 'ERROR', message: 'Something went wrong. Please try again.' };
    }
  }

  var api = { handle: handle, MIN_CLIENT_VERSION: MIN_CLIENT_VERSION, SERVER_VERSION: SERVER_VERSION };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.GJApi = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);

// ===== src/gas/main.js =====
/**
 * Apps Script glue (runs only inside Google Apps Script, bound to the "GJ Leave" Sheet).
 * Everything with logic lives in the tested modules above; this file only connects them
 * to SpreadsheetApp, LockService and the web app entry points.
 */

/** Real Sheet behind the grid interface used by the store. */
function gjGrid_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  return {
    tabNames: function () { return ss.getSheets().map(function (s) { return s.getName(); }); },
    addTab: function (name) {
      var sh = ss.insertSheet(name);
      if (sh.getMaxColumns() < 40) sh.insertColumnsAfter(sh.getMaxColumns(), 40 - sh.getMaxColumns());
      sh.getRange(1, 1, sh.getMaxRows(), sh.getMaxColumns()).setNumberFormat('@'); // plain text everywhere
    },
    read: function (name) {
      gjReads_ += 1;
      var sh = ss.getSheetByName(name);
      if (!sh || sh.getLastRow() === 0) return [];
      return sh.getRange(1, 1, sh.getLastRow(), sh.getLastColumn()).getDisplayValues();
    },
    append: function (name, row) { return this.appendRows(name, [row]); },
    headers: function (name) {
      var sh = ss.getSheetByName(name);
      if (!sh || sh.getLastRow() === 0) return [];
      return sh.getRange(1, 1, 1, sh.getLastColumn()).getDisplayValues()[0];
    },
    /** The last n data rows of a tab, without reading the whole tab. */
    tail: function (name, n) {
      var sh = ss.getSheetByName(name), last = sh ? sh.getLastRow() : 0;
      if (last < 2) return [];
      var from = Math.max(2, last - n + 1);
      return sh.getRange(from, 1, last - from + 1, sh.getLastColumn()).getDisplayValues();
    },
    appendRows: function (name, rows) { return this.appendMany([{ tab: name, rows: rows }])[name]; },
    /**
     * Appends rows to several tabs. All reads (where does each tab end?) happen first, then all
     * writes, so Apps Script sends the writes together. Returns { tab: 0-based index of the first row }.
     */
    appendMany: function (batch) {
      var plan = batch.map(function (b) {
        var sh = ss.getSheetByName(b.tab);
        return { b: b, sh: sh, at: sh.getLastRow() + 1, max: sh.getMaxRows() };
      });
      var first = {};
      plan.forEach(function (p) {
        var need = p.at + p.b.rows.length - 1;
        if (need > p.max) { // grow the tab; new rows are plain text like the rest
          p.sh.insertRowsAfter(p.max, Math.max(500, need - p.max));
          p.sh.getRange(p.max + 1, 1, p.sh.getMaxRows() - p.max, p.sh.getMaxColumns()).setNumberFormat('@');
        }
        p.sh.getRange(p.at, 1, p.b.rows.length, p.b.rows[0].length).setValues(p.b.rows);
        first[p.b.tab] = p.at - 1;
      });
      return first;
    },
    /** One row as the Sheet shows it now (0-based index, 0 = headers); null when there is no such row. */
    readRow: function (name, index) {
      var sh = ss.getSheetByName(name);
      if (!sh || index + 1 > sh.getLastRow()) return null;
      return sh.getRange(index + 1, 1, 1, sh.getLastColumn()).getDisplayValues()[0];
    },
    /**
     * Writes the given cells of one row. The row array may have gaps: a gap is a column that is not
     * the app's own (something the owner added), and it is not touched.
     */
    writeRow: function (name, index, row) {
      var sh = ss.getSheetByName(name), start = -1, run = [];
      for (var c = 0; c <= row.length; c++) {
        if (c < row.length && row[c] !== undefined) { if (start === -1) start = c; run.push(row[c]); continue; }
        if (start !== -1) { sh.getRange(index + 1, start + 1, 1, run.length).setNumberFormat('@').setValues([run]); start = -1; run = []; }
      }
    }
  };
}

var gjReads_ = 0;
var gjT_ = {}; // where the time of a request went (returned as _t, for tuning)
function gjTime_(key, fn) { var a = Date.now(); try { return fn(); } finally { gjT_[key] = (gjT_[key] || 0) + Date.now() - a; } }
var gjLockDepth_ = 0;
var gjDb_ = null; // the request's db, so buffered writes are flushed before the lock is released

function gjEnv_() {
  return {
    sha256: function (s) {
      var bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, s, Utilities.Charset.UTF_8);
      return bytes.map(function (b) { return ('0' + ((b + 256) % 256).toString(16)).slice(-2); }).join('');
    },
    randomId: function () { return Utilities.getUuid().replace(/-/g, ''); },
    savePhoto: function (name, data) { return gjTime_('drive', function () { return gjSavePhoto_(name, data); }); },
    readPhoto: function (id) { return gjReadPhoto_(id); },
    withLock: function (fn) {
      if (gjLockDepth_ > 0) return fn(); // already inside the lock in this run
      var lock = LockService.getScriptLock();
      gjTime_('lockWait', function () { lock.waitLock(25000); });
      gjLockDepth_ += 1;
      // Writes are flushed while the lock is still held. A refused action has already thrown its
      // writes away (GJApi.locked), except a wrong PIN, which must still be counted.
      try { return fn(); } finally { try { if (gjDb_) gjTime_('flush', function () { gjDb_.flush(); }); } finally { gjLockDepth_ -= 1; lock.releaseLock(); } }
    }
  };
}

function gjCache_() {
  var c = CacheService.getScriptCache();
  return {
    getAll: function (keys) { return c.getAll(keys); },
    put: function (k, v, ttl) { c.put(k, v, ttl); },
    putAll: function (map, ttl) { c.putAll(map, ttl); },
    remove: function (k) { c.remove(k); }
  };
}
function gjCachedGrid_() {
  return GJCacheGrid.wrap(gjGrid_(), gjCache_(), Object.keys(GJSchema.TABS), function () { return Utilities.getUuid().slice(0, 8); });
}
function gjCtx_() {
  var ctx = { db: GJStore.open(gjCachedGrid_(), { buffer: true }), now: Date.now(), env: gjEnv_() }; // server time only
  gjDb_ = ctx.db;
  return ctx;
}

/** Run once from the editor after pasting the code. Safe to run again. */
function setupOrUpgrade() {
  var lock = LockService.getScriptLock();
  lock.waitLock(25000);
  try {
    var done = GJStore.setup(gjGrid_(), { today: Utilities.formatDate(new Date(), 'Asia/Kolkata', 'yyyy-MM-dd') });
    // Setup may have changed columns: retire every cached copy.
    var all = {}; Object.keys(GJSchema.TABS).forEach(function (t) { all['v:' + t] = Utilities.getUuid().slice(0, 8); });
    CacheService.getScriptCache().putAll(all, 21600);
    CacheService.getScriptCache().removeAll(Object.keys(GJSchema.TABS).map(function (t) { return 'h:' + t; }));
    Logger.log(done.length ? done.join('\n') : 'Nothing to do. Already up to date.');
    return done;
  } finally { lock.releaseLock(); }
}

function doPost(e) {
  var request = {};
  try { request = JSON.parse(e.postData.contents); } catch (err) { request = {}; }
  var t0 = Date.now(); gjT_ = {};
  var ctx = gjCtx_();
  var reply = GJApi.handle(ctx, request);
  ctx.db.flush(); // anything written outside a locked action
  gjT_.total = Date.now() - t0; gjT_.sheetReads = gjReads_; reply._t = gjT_;
  return ContentService.createTextOutput(JSON.stringify(reply)).setMimeType(ContentService.MimeType.JSON);
}

function doGet() {
  return ContentService.createTextOutput(JSON.stringify({ ok: true, data: { app: 'GJ Leave & Attendance', time: Date.now() } }))
    .setMimeType(ContentService.MimeType.JSON);
}

/**
 * Lists every Google service the app will ever use, so Google asks the owner for
 * permission ONCE (Sheet, email alerts, the private photo folder, timed jobs).
 */
function authorizeAll() {
  SpreadsheetApp.getActiveSpreadsheet().getName();
  MailApp.getRemainingDailyQuota();
  DriveApp.getRootFolder().getName();
  ScriptApp.getProjectTriggers();
  return 'Authorized.';
}

// ---------- Timed jobs ----------

function gjMailer_() {
  return {
    quota: function () { return MailApp.getRemainingDailyQuota(); },
    send: function (to, subject, body) { MailApp.sendEmail(to, subject, body, { name: 'GJ Leave & Attendance' }); }
  };
}
function gjJob_(name) {
  var ctx = gjCtx_();
  ctx.env.ownerEmail = Session.getEffectiveUser().getEmail();
  try { return GJJobs.run(ctx, name, gjMailer_()); }
  finally { ctx.db.flush(); } // whatever the job managed to do is saved, also when it stopped half-way
}
function jobEmails() { return gjJob_('emails'); }
function jobHourly() { return gjJob_('hourly'); }
function jobEvening() { return gjJob_('evening'); }
function jobEndOfDay() { return gjJob_('endOfDay'); }

/** Run once from the editor. Removes this project's old timers and installs the four jobs. Safe to run again. */
function installTriggers() {
  ScriptApp.getProjectTriggers().forEach(function (t) { ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('jobEmails').timeBased().everyMinutes(5).create();
  ScriptApp.newTrigger('jobHourly').timeBased().everyHours(1).create();
  ScriptApp.newTrigger('jobEvening').timeBased().atHour(19).everyDays(1).inTimezone('Asia/Kolkata').create();
  ScriptApp.newTrigger('jobEndOfDay').timeBased().atHour(21).everyDays(1).inTimezone('Asia/Kolkata').create();
  return 'Timers installed.';
}

// ---------- Photos (private Drive folder; the Sheet keeps only the file id) ----------

function gjPhotoFolder_() {
  var props = PropertiesService.getScriptProperties(), id = props.getProperty('photoFolderId');
  if (id) { try { return DriveApp.getFolderById(id); } catch (e) { /* folder was removed: make a new one */ } }
  var folder = DriveApp.createFolder('GJ Leave - check-in photos (private)');
  props.setProperty('photoFolderId', folder.getId());
  return folder;
}
function gjSavePhoto_(name, base64) {
  var blob = Utilities.newBlob(Utilities.base64Decode(String(base64).replace(/^data:image\/jpeg;base64,/, '')), 'image/jpeg', name);
  return gjPhotoFolder_().createFile(blob).getId(); // not shared with anyone
}
function gjReadPhoto_(id) {
  return 'data:image/jpeg;base64,' + Utilities.base64Encode(DriveApp.getFileById(id).getBlob().getBytes());
}
