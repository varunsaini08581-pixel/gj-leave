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

  function lockedMonths(ctx) {
    var m = {}; ctx.db.rows('MonthSheet').forEach(function (r) { if (r.personId !== 'correction') m[r.month] = true; });
    return m;
  }

  /** All staff for one month. If the month is locked, the locked result is returned, plus later corrections. */
  function monthReport(ctx, actor, monthKey) {
    boss(actor);
    var locked = ctx.db.rows('MonthSheet').filter(function (r) { return r.month === monthKey; });
    var rows = locked.filter(function (r) { return r.personId !== 'correction'; });
    var overrides = ctx.db.rows('LeaveRequests').filter(function (r) { return r.override && Cal.monthKey(r.dates[0]) === monthKey; })
      .map(function (r) { return { personId: r.personId, dates: r.dates, reason: r.override }; });
    if (rows.length) return { month: monthKey, locked: true, lockedBy: rows[0].lockedBy, lockedAt: rows[0].lockedAt, people: rows.map(function (r) { return r.result; }),
      corrections: locked.filter(function (r) { return r.personId === 'correction'; }).map(function (r) { return r.result; }), overrides: overrides };
    return { month: monthKey, locked: false, people: staff(ctx).map(function (p) { return Att.myMonth(ctx, p.id, monthKey); }), corrections: [], overrides: overrides };
  }

  /** Lock a finished month. After the lock nothing in it is recalculated; corrections are new logged entries. */
  function lockMonth(ctx, actor, monthKey) {
    return ctx.env.withLock(function () {
      boss(actor);
      if (monthKey >= Cal.monthKey(H.today(ctx))) H.fail('BLOCKED', 'A month can be locked only after it has ended.');
      if (lockedMonths(ctx)[monthKey]) H.fail('BLOCKED', 'This month is already locked.');
      staff(ctx).forEach(function (p) {
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
    addCorrection: addCorrection, lockedMonths: lockedMonths };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.GJViews = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
