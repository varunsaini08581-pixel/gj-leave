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
