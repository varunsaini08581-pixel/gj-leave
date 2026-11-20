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
      'dressExempt', 'active', 'email', 'phone', 'pinSalt', 'pinHash', 'pinTries', 'pinLockedUntil'],
    Devices: ['id', 'personId', 'tokenHash', 'label', 'status', 'requestedAt', 'decidedAt', 'decidedBy'],
    PayInfo: ['personId', 'fixedSalary', 'targetAllowance', 'disciplineBonus', 'dutyHours', 'updatedAt', 'updatedBy'],
    Rules: ['id', 'on', 'label', 'members', 'minPresent', 'rosterSundayException', 'emergencyIfAllPresent'],
    Restrictions: ['id', 'from', 'to', 'note', 'rule', 'appliesTo', 'on', 'createdBy', 'createdAt'],
    LeaveRequests: ['id', 'personId', 'kind', 'dates', 'halfStart', 'reasonCode', 'reasonText', 'submittedAt', 'type',
      'noticeHours', 'run', 'route', 'status', 'approvals', 'extremeEmergency', 'emergencyNo', 'penaltyEmergency',
      'restrictionViolation', 'enteredBy', 'decidedAt', 'decidedBy', 'decisionReason', 'history'],
    Punches: ['id', 'personId', 'date', 'kind', 'at', 'photoId', 'lat', 'lng', 'accuracy', 'distance', 'deviceId', 'flag', 'note'],
    DayMinutes: ['id', 'personId', 'date', 'kind', 'minutes', 'informed', 'statedMinutes', 'source', 'note'],
    Violations: ['id', 'personId', 'date', 'rule', 'source', 'proof', 'note', 'createdBy', 'createdAt', 'disputeState',
      'disputeAt', 'disputeText', 'disputeDecidedBy', 'disputeDecidedAt'],
    MonthSheet: ['id', 'month', 'personId', 'result', 'lockedBy', 'lockedAt'],
    Notifications: ['id', 'to', 'kind', 'title', 'body', 'ref', 'createdAt', 'readAt', 'emailedAt'],
    Audit: ['id', 'at', 'actor', 'action', 'ref', 'detail'],
    Settings: ['key', 'value', 'updatedAt', 'updatedBy']
  };

  var JSON_COLS = {
    People: ['sundayOff'], Rules: ['members', 'rosterSundayException', 'emergencyIfAllPresent'],
    Restrictions: ['appliesTo'], LeaveRequests: ['dates', 'approvals', 'history'], MonthSheet: ['result'], Audit: ['detail']
  };

  // Every cell is stored as plain text (so Sheets never turns '2026-11-25' or '09:30' into a date).
  // These lists tell the store how to turn text back into numbers and booleans.
  var NUM_COLS = ['pinTries', 'pinLockedUntil', 'requestedAt', 'decidedAt', 'submittedAt', 'noticeHours', 'run', 'emergencyNo',
    'at', 'lat', 'lng', 'accuracy', 'distance', 'minutes', 'statedMinutes', 'createdAt', 'disputeAt', 'disputeDecidedAt',
    'lockedAt', 'readAt', 'emailedAt', 'updatedAt', 'minPresent', 'fixedSalary', 'targetAllowance', 'disciplineBonus', 'dutyHours'];
  var BOOL_COLS = ['noApproval', 'noClash', 'noQuota', 'dressExempt', 'active', 'on', 'extremeEmergency', 'penaltyEmergency',
    'restrictionViolation', 'informed'];

  var SCHEMA_VERSION = 1;

  var api = { TABS: TABS, JSON_COLS: JSON_COLS, NUM_COLS: NUM_COLS, BOOL_COLS: BOOL_COLS, SCHEMA_VERSION: SCHEMA_VERSION };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.GJSchema = api;
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

  function has(list, x) { return list.indexOf(x) !== -1; }

  function encode(tab, col, v) {
    if (v === undefined || v === null) return '';
    if (has(Schema.JSON_COLS[tab] || [], col)) return JSON.stringify(v);
    if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
    return String(v);
  }
  function decode(tab, col, text) {
    if (text === '' || text === undefined || text === null) return has(Schema.JSON_COLS[tab] || [], col) ? null : '';
    text = String(text);
    if (has(Schema.JSON_COLS[tab] || [], col)) { try { return JSON.parse(text); } catch (e) { return null; } }
    if (has(Schema.BOOL_COLS, col)) return text.toUpperCase() === 'TRUE';
    if (has(Schema.NUM_COLS, col)) { var n = Number(text); return isNaN(n) ? '' : n; }
    return text;
  }

  /**
   * Create missing tabs and add missing columns. Safe to run twice: it never removes or
   * reorders anything that exists and never touches data rows.
   */
  function setup(grid) {
    var done = [];
    var names = grid.tabNames();
    Object.keys(Schema.TABS).forEach(function (tab) {
      if (!has(names, tab)) { grid.addTab(tab); grid.append(tab, Schema.TABS[tab].slice()); done.push('created ' + tab); return; }
      var data = grid.read(tab);
      if (!data.length) { grid.append(tab, Schema.TABS[tab].slice()); done.push('headers ' + tab); return; }
      var headers = data[0].map(String);
      var missing = Schema.TABS[tab].filter(function (c) { return !has(headers, c); });
      if (missing.length) { grid.writeRow(tab, 0, headers.concat(missing)); done.push('columns ' + tab + ': ' + missing.join(', ')); }
    });
    var db = open(grid);
    if (!db.rows('Rules').length) {
      Clash.DEFAULT_RULES.forEach(function (r) { db.insert('Rules', r); });
      done.push('seeded Rules');
    }
    if (!db.rows('Settings').some(function (s) { return s.key === 'schemaVersion'; })) {
      db.insert('Settings', { key: 'schemaVersion', value: String(Schema.SCHEMA_VERSION), updatedAt: '', updatedBy: 'setup' });
      done.push('schemaVersion');
    }
    return done;
  }

  /** Open a db over the grid. Each tab is read at most once per request and cached. */
  function open(grid) {
    var cache = {};
    function load(tab) {
      if (cache[tab]) return cache[tab];
      var data = grid.read(tab);
      var headers = data.length ? data[0].map(String) : Schema.TABS[tab].slice();
      var rows = [];
      for (var i = 1; i < data.length; i++) {
        var obj = {};
        var empty = true;
        for (var c = 0; c < headers.length; c++) {
          var cell = data[i][c];
          if (cell !== '' && cell !== undefined && cell !== null) empty = false;
          obj[headers[c]] = decode(tab, headers[c], cell);
        }
        if (empty) continue;
        Object.defineProperty(obj, '__row', { value: i, enumerable: false, writable: true });
        rows.push(obj);
      }
      cache[tab] = { headers: headers, rows: rows, nextRow: data.length || 1 };
      return cache[tab];
    }
    function toArray(tab, headers, obj) { return headers.map(function (h) { return encode(tab, h, obj[h]); }); }
    return {
      rows: function (tab) { return load(tab).rows; },
      insert: function (tab, obj) {
        var t = load(tab);
        var row = {};
        t.headers.forEach(function (h) { row[h] = decode(tab, h, encode(tab, h, obj[h])); });
        grid.append(tab, toArray(tab, t.headers, obj));
        Object.defineProperty(row, '__row', { value: t.nextRow, enumerable: false, writable: true });
        t.nextRow += 1;
        t.rows.push(row);
      },
      update: function (tab, key, patch) {
        var t = load(tab);
        var keyCol = t.headers[0];
        var row = t.rows.filter(function (r) { return String(r[keyCol]) === String(key); })[0];
        if (!row) throw new Error('update: no row in ' + tab + ' for ' + key);
        Object.keys(patch).forEach(function (k) {
          if (!has(t.headers, k)) throw new Error('update: unknown column ' + tab + '.' + k);
          row[k] = decode(tab, k, encode(tab, k, patch[k]));
        });
        grid.writeRow(tab, row.__row, toArray(tab, t.headers, row));
      }
    };
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

  var IST_OFFSET_MS = 5.5 * 3600000;
  var PIN_MAX_TRIES = 5;
  var PIN_LOCK_MS = 15 * 60000;
  var REASONS = ['Sick', 'Family function', 'Family emergency', 'Personal work', 'Travel', 'Exam', 'Other'];
  var OPEN = { 'Pending with Aakash': 1, 'Special – waiting': 1, 'Pending with Varun': 1 };

  function fail(code, message) { var e = new Error(message); e.code = code; throw e; }
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
    var p = find(ctx, 'People', personId);
    if (!p || p.active === false) fail('LOGIN', 'Wrong name or PIN.');
    if (p.pinLockedUntil && ctx.now < p.pinLockedUntil) fail('LOCKED', 'Too many wrong PINs. Try again in 15 minutes.');
    if (!p.pinHash || ctx.env.sha256(p.pinSalt + ':' + pin) !== p.pinHash) {
      var tries = (p.pinTries || 0) + 1;
      var patch = { pinTries: tries };
      if (tries >= PIN_MAX_TRIES) { patch.pinTries = 0; patch.pinLockedUntil = ctx.now + PIN_LOCK_MS; }
      ctx.db.update('People', personId, patch);
      audit(ctx, personId, 'login.wrong-pin', personId);
      fail('LOGIN', 'Wrong name or PIN.');
    }
    ctx.db.update('People', personId, { pinTries: 0, pinLockedUntil: 0 });

    if (deviceToken) {
      var hash = ctx.env.sha256(deviceToken);
      var known = ctx.db.rows('Devices').filter(function (d) { return d.personId === personId && d.tokenHash === hash; })[0];
      if (known) return { ok: known.status === 'approved', deviceStatus: known.status, deviceId: known.id };
    }
    var token = ctx.env.randomId() + ctx.env.randomId();
    var dev = { id: ctx.env.randomId(), personId: personId, tokenHash: ctx.env.sha256(token), label: deviceLabel || '',
      status: 'pending', requestedAt: ctx.now, decidedAt: '', decidedBy: '' };
    // The owner's very first phone is approved automatically (otherwise nobody could approve anything).
    var anyOwnerDevice = ctx.db.rows('Devices').some(function (d) { var o = find(ctx, 'People', d.personId); return o && o.role === 'owner' && d.status === 'approved'; });
    if (p.role === 'owner' && !anyOwnerDevice) { dev.status = 'approved'; dev.decidedAt = ctx.now; dev.decidedBy = 'bootstrap'; }
    ctx.db.insert('Devices', dev);
    audit(ctx, personId, 'device.request', dev.id, { label: dev.label, status: dev.status });
    if (dev.status === 'pending') byRole(ctx, 'owner').forEach(function (o) {
      notify(ctx, o.id, 'device', 'New phone request', p.name + ' wants to sign in on a new phone.', dev.id);
    });
    return { ok: dev.status === 'approved', deviceStatus: dev.status, deviceId: dev.id, deviceToken: token };
  }

  function decideDevice(ctx, actor, deviceId, approve) {
    if (actor.role !== 'owner') fail('FORBIDDEN', 'Only the owner can approve a phone.');
    var dev = find(ctx, 'Devices', deviceId);
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

  /** Every API call: who is this? Only an approved phone bound to that person passes. */
  function authenticate(ctx, personId, deviceToken) {
    var p = find(ctx, 'People', personId);
    if (!p || p.active === false || !deviceToken) fail('AUTH', 'Please sign in again.');
    var hash = ctx.env.sha256(deviceToken);
    var dev = ctx.db.rows('Devices').filter(function (d) { return d.personId === personId && d.tokenHash === hash && d.status === 'approved'; })[0];
    if (!dev) fail('AUTH', 'This phone is not approved for this account.');
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
      r.dates.forEach(function (d) { out.push({ person: names[r.personId], date: d, kind: r.kind }); });
    });
    ctx.db.rows('DayMinutes').forEach(function (m) { out.push({ person: names[m.personId], date: m.date, kind: m.kind }); });
    return out;
  }

  function liveLeaves(ctx, personId, exceptId) {
    return ctx.db.rows('LeaveRequests').filter(function (r) {
      return r.personId === personId && r.id !== exceptId && (r.status === 'Approved' || r.status === 'Recorded' || OPEN[r.status]);
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
  function evaluate(ctx, person, input, exceptId) {
    var problems = [];
    var dates = (input.dates || []).slice().sort();
    if (!dates.length) problems.push('Pick exact dates.');
    dates.forEach(function (d, i) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) problems.push('Invalid date.');
      if (i && Cal.addDays(dates[i - 1], 1) !== d) problems.push('Dates in one request must be consecutive.');
    });
    if (input.kind !== 'full' && input.kind !== 'half') problems.push('Choose full day or half day.');
    if (input.kind === 'half' && (dates.length !== 1 || !/^\d{2}:\d{2}$/.test(input.halfStart || ''))) problems.push('A half day is one date with a start time.');
    if (REASONS.indexOf(input.reasonCode) === -1) problems.push('Choose a reason.');
    if (!String(input.reasonText || '').trim()) problems.push('Write the reason.');
    if (problems.length) return { decision: 'blocked', reasons: problems, valid: false };

    var others = liveLeaves(ctx, person.id, exceptId);
    var overlap = others.some(function (r) { return r.dates.some(function (d) { return dates.indexOf(d) !== -1; }); });
    if (overlap) return { decision: 'blocked', reasons: ['You already have a request on one of these dates. Edit or cancel it first.'], valid: false };

    var dutyStartAt = toMs(dates[0], input.kind === 'half' ? input.halfStart : person.dutyStart);
    var submittedAt = input.submittedAt || ctx.now;
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
    var emergencyNo = 0;
    if (type === 'Emergency') {
      emergencyNo = 1 + others.filter(function (r) { return r.type === 'Emergency' && Cal.monthKey(r.dates[0]) === month; }).length;
    }
    var penaltyEmergency = emergencyNo > 0 && Leave.isPenaltyEmergency(emergencyNo);

    // Quota after this request (first month only for the routing check; the month page splits per month).
    var amount = input.kind === 'half' ? 0.5 : 1;
    var days = [];
    others.forEach(function (r) { r.dates.forEach(function (d) { days.push({ date: d, amount: r.kind === 'half' ? 0.5 : 1, penaltyEmergency: !!r.penaltyEmergency }); }); });
    dates.forEach(function (d) { days.push({ date: d, amount: amount, penaltyEmergency: penaltyEmergency }); });
    var quota = Leave.monthQuota(person, month, days);

    var routed = Leave.route({
      person: { noApproval: person.noApproval, isManager: person.role === 'manager', alwaysAakash: person.group === 'Housekeeping' },
      days: dates.length, run: run, noticeHours: noticeHours, type: type,
      clash: clash, restricted: restr.blocked, quotaAfter: quota.total,
      violationsThisMonth: violationsInMonth(ctx, person.id, Cal.monthKey(today(ctx)))
    });
    if (restr.blocked) routed.reasons = restr.hits.map(function (h) { return h.message; });

    var warnings = [];
    if (type === 'Unannounced') warnings.push('Less than 3 hours notice: this is an unannounced leave and counts as 1 violation.');
    if (penaltyEmergency) warnings.push('This is emergency no. ' + emergencyNo + ' this month: 1 violation, and it is not a free leave.');
    if (restr.violations) warnings.push(restr.hits[0].message);
    if (quota.daysAboveQuota > 0 && !person.noQuota) warnings.push('Above the 5 free leaves this month by ' + quota.daysAboveQuota + '.');
    if (clash.extremeEmergencyPossible) warnings.push('Only possible as an extreme emergency, with Aakash’s approval.');

    return {
      valid: true, decision: routed.decision, reasons: routed.reasons, warnings: warnings,
      dates: dates, type: type, noticeHours: Math.round(noticeHours * 10) / 10, run: run,
      emergencyNo: emergencyNo, penaltyEmergency: penaltyEmergency, restrictionViolation: restr.violations > 0,
      quota: person.noQuota ? null : { total: quota.total, left: quota.left, daysAboveQuota: quota.daysAboveQuota }
    };
  }

  function previewLeave(ctx, actor, input) {
    return evaluate(ctx, find(ctx, 'People', actor.id), input, input.editId);
  }

  function addViolation(ctx, personId, date, rule, ref) {
    ctx.db.insert('Violations', { id: ctx.env.randomId(), personId: personId, date: date, rule: rule, source: 'auto', proof: ref,
      note: '', createdBy: 'system', createdAt: ctx.now, disputeState: '', disputeAt: '', disputeText: '', disputeDecidedBy: '', disputeDecidedAt: '' });
    byRole(ctx, 'owner').concat(byRole(ctx, 'manager')).forEach(function (m) { notify(ctx, m.id, 'violation', 'Violation recorded', rule, ref); });
    notify(ctx, personId, 'violation', 'Violation recorded', rule + '. You can dispute it within 24 hours.', ref);
  }

  /** Called whenever a request becomes Approved or Recorded. */
  function onGranted(ctx, r) {
    if (r.type === 'Unannounced') addViolation(ctx, r.personId, r.dates[0], 'unannounced-leave', r.id);
    if (r.penaltyEmergency) addViolation(ctx, r.personId, r.dates[0], 'emergency-beyond-2', r.id);
    if (r.restrictionViolation) addViolation(ctx, r.personId, r.dates[0], 'leave-in-restricted-period', r.id);
  }

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
      var ev = evaluate(ctx, person, input);
      if (ev.decision === 'blocked') fail('BLOCKED', ev.reasons.join(' '));
      var row = {
        id: ctx.env.randomId(), personId: personId, kind: input.kind, dates: ev.dates, halfStart: input.halfStart || '',
        reasonCode: input.reasonCode, reasonText: String(input.reasonText).trim(), submittedAt: ctx.now, type: ev.type,
        noticeHours: ev.noticeHours, run: ev.run, route: ev.decision, status: STATUS_FOR[ev.decision],
        approvals: ev.decision === 'special' ? { aakash: '', varun: '' } : {}, extremeEmergency: !!input.extremeEmergency,
        emergencyNo: ev.emergencyNo, penaltyEmergency: ev.penaltyEmergency, restrictionViolation: ev.restrictionViolation,
        enteredBy: personId === actor.id ? '' : actor.id, decidedAt: '', decidedBy: '', decisionReason: '',
        history: [{ at: ctx.now, by: actor.id, action: 'submitted' }]
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
        if (status === 'Approved') onGranted(ctx, Object.assign({}, r, { status: status }));
        return { id: id, status: status };
      }

      if (!approve) return finish('Rejected', reason);

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
        return res;
      }
      return finish('Approved', reason);
    });
  }

  /** Staff can cancel their own request until it starts. After that only Aakash or Varun, with a reason. */
  function cancelLeave(ctx, actor, id, reason) {
    return ctx.env.withLock(function () {
      var r = find(ctx, 'LeaveRequests', id);
      if (!r || r.status === 'Cancelled' || r.status.indexOf('Rejected') === 0) fail('NOT_FOUND', 'Nothing to cancel.');
      var person = find(ctx, 'People', r.personId);
      var started = ctx.now >= toMs(r.dates[0], r.kind === 'half' ? r.halfStart : person.dutyStart);
      var isBoss = actor.role !== 'staff';
      if (actor.id !== r.personId && !isBoss) fail('FORBIDDEN', 'You can cancel only your own request.');
      if (started && !isBoss) fail('FORBIDDEN', 'This leave has started. Ask Aakash or Varun.');
      if (isBoss && actor.id !== r.personId && !String(reason || '').trim()) fail('REASON', 'A reason is required.');
      ctx.db.update('LeaveRequests', id, { status: 'Cancelled', history: r.history.concat([{ at: ctx.now, by: actor.id, action: 'cancelled', reason: reason || '' }]) });
      audit(ctx, actor.id, 'leave.cancel', id, { reason: reason || '' });
      if (actor.id !== r.personId) notify(ctx, r.personId, 'decision', 'Leave cancelled', r.dates.join(', ') + ' — ' + reason, id);
      return { id: id, status: 'Cancelled' };
    });
  }

  var api = { REASONS: REASONS, setPin: setPin, login: login, decideDevice: decideDevice, authenticate: authenticate,
    previewLeave: previewLeave, submitLeave: submitLeave, decideLeave: decideLeave, cancelLeave: cancelLeave, toMs: toMs };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.GJCore = api;
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

  var MIN_CLIENT_VERSION = 1; // version gate: an old cached app must update before it can do anything

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
      return { id: p.id, name: p.name, role: p.role, group: p.group, dutyStart: p.dutyStart, dutyEnd: p.dutyEnd, reasons: Core.REASONS };
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
    setPin: function (ctx, actor, a) { return Core.setPin(ctx, actor, a.personId, a.pin); },
    devices: function (ctx, actor) {
      if (actor.role !== 'owner') throw err('FORBIDDEN', 'Only the owner.');
      var names = nameMap(ctx);
      return ctx.db.rows('Devices').map(function (d) { return { id: d.id, name: names[d.personId], label: d.label, status: d.status, requestedAt: d.requestedAt }; });
    },
    decideDevice: function (ctx, actor, a) { return Core.decideDevice(ctx, actor, a.id, !!a.approve); },
    notifications: function (ctx, actor) {
      return ctx.db.rows('Notifications').filter(function (n) { return n.to === actor.id; }).slice(-50)
        .map(function (n) { return { id: n.id, kind: n.kind, title: n.title, body: n.body, ref: n.ref, createdAt: n.createdAt, readAt: n.readAt }; });
    }
  };

  function nameMap(ctx) { var m = {}; ctx.db.rows('People').forEach(function (p) { m[p.id] = p.name; }); return m; }
  function err(code, message) { var e = new Error(message); e.code = code; return e; }

  function handle(ctx, request) {
    try {
      request = request || {};
      var args = request.args || {};
      if (!(request.clientVersion >= MIN_CLIENT_VERSION)) return { ok: false, code: 'UPDATE', message: 'Please update the app.' };
      if (PUBLIC[request.action]) return { ok: true, data: PUBLIC[request.action](ctx, args) };
      if (!PRIVATE[request.action]) return { ok: false, code: 'UNKNOWN', message: 'Unknown action.' };
      var actor = Core.authenticate(ctx, request.personId, request.deviceToken);
      return { ok: true, data: PRIVATE[request.action](ctx, actor, args) };
    } catch (e) {
      if (e && e.code) return { ok: false, code: e.code, message: e.message };
      return { ok: false, code: 'ERROR', message: 'Something went wrong. Please try again.' };
    }
  }

  var api = { handle: handle, MIN_CLIENT_VERSION: MIN_CLIENT_VERSION };
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
      sh.getRange(1, 1, sh.getMaxRows(), sh.getMaxColumns()).setNumberFormat('@'); // plain text everywhere
    },
    read: function (name) {
      var sh = ss.getSheetByName(name);
      if (!sh || sh.getLastRow() === 0) return [];
      return sh.getRange(1, 1, sh.getLastRow(), sh.getLastColumn()).getDisplayValues();
    },
    append: function (name, row) {
      var sh = ss.getSheetByName(name);
      var r = sh.getLastRow() + 1;
      sh.getRange(r, 1, 1, row.length).setNumberFormat('@').setValues([row]);
    },
    writeRow: function (name, index, row) {
      var sh = ss.getSheetByName(name);
      sh.getRange(index + 1, 1, 1, row.length).setNumberFormat('@').setValues([row]);
    }
  };
}

function gjEnv_() {
  return {
    sha256: function (s) {
      var bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, s, Utilities.Charset.UTF_8);
      return bytes.map(function (b) { return ('0' + ((b + 256) % 256).toString(16)).slice(-2); }).join('');
    },
    randomId: function () { return Utilities.getUuid().replace(/-/g, ''); },
    withLock: function (fn) {
      var lock = LockService.getScriptLock();
      lock.waitLock(25000);
      try { return fn(); } finally { lock.releaseLock(); }
    }
  };
}

function gjCtx_() {
  return { db: GJStore.open(gjGrid_()), now: Date.now(), env: gjEnv_() }; // server time only
}

/** Run once from the editor after pasting the code. Safe to run again. */
function setupOrUpgrade() {
  var lock = LockService.getScriptLock();
  lock.waitLock(25000);
  try {
    var done = GJStore.setup(gjGrid_());
    Logger.log(done.length ? done.join('\n') : 'Nothing to do. Already up to date.');
    return done;
  } finally { lock.releaseLock(); }
}

function doPost(e) {
  var request = {};
  try { request = JSON.parse(e.postData.contents); } catch (err) { request = {}; }
  var reply = GJApi.handle(gjCtx_(), request);
  return ContentService.createTextOutput(JSON.stringify(reply)).setMimeType(ContentService.MimeType.JSON);
}

function doGet() {
  return ContentService.createTextOutput(JSON.stringify({ ok: true, data: { app: 'GJ Leave & Attendance', time: Date.now() } }))
    .setMimeType(ContentService.MimeType.JSON);
}
