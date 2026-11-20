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
    if (lv && lv.kind === 'half') {
      var hs = hhmmToMin(lv.halfStart), he = hs + HALF_DAY_MINUTES;
      if (hs <= start) start = Math.min(he, end);
      else if (he >= end) end = hs;
    }
    return { start: start, end: end, fullLeave: !!(lv && lv.kind === 'full') };
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
      if (a.kind !== 'late' && a.kind !== 'early') H.fail('BLOCKED', 'Choose late or early.');
      if (!/^\d{2}:\d{2}$/.test(a.time || '')) H.fail('BLOCKED', 'Enter the exact time.');
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
      if (shop && a.lat !== undefined && a.lat !== '') {
        var pt = JSON.parse(shop);
        distance = distanceM(pt.lat, pt.lng, +a.lat, +a.lng);
        if (distance > SHOP_RADIUS_M) flag.push('outside-shop-area');
      } else if (shop) flag.push('no-location');
      if (day.fullLeave || Cal.isRosterOff(person, date)) flag.push('off-day');
      var punch = { id: ctx.env.randomId(), personId: actor.id, date: date, kind: 'in', at: ctx.now, photoId: a.photoId || '',
        lat: a.lat === undefined ? '' : a.lat, lng: a.lng === undefined ? '' : a.lng, accuracy: a.accuracy === undefined ? '' : a.accuracy,
        distance: distance, deviceId: actor.deviceId || '', flag: flag.join(','), note: '' };
      ctx.db.insert('Punches', punch);

      var late = nowMin(ctx) - day.start, counted = null;
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
      var now = nowMin(ctx), early = day.end - now;
      if (!day.fullLeave && !Cal.isRosterOff(person, date) && early > 0) {
        var q = activeShort(ctx, actor.id, date, 'early');
        var stated = q ? hhmmToMin(q.time) : null;
        var ok = !!q && q.status === 'Approved', wait = q && q.status === 'Pending' ? q.id : '';
        if (q && now >= stated) addDayMinutes(ctx, actor.id, date, 'early', early, ok, undefined, punch.id, wait);
        else if (q) { // left before the stated time: the extra minutes are not informed
          addDayMinutes(ctx, actor.id, date, 'early', day.end - stated, ok, undefined, punch.id, wait);
          addDayMinutes(ctx, actor.id, date, 'early', stated - now, false, undefined, punch.id);
        } else addDayMinutes(ctx, actor.id, date, 'early', early, false, undefined, punch.id);
        syncViolations(ctx, actor.id, Cal.monthKey(date));
      }
      H.audit(ctx, actor.id, 'punch.out', punch.id, { early: Math.max(0, early) });
      return { id: punch.id, at: ctx.now, earlyMinutes: Math.max(0, early) };
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
      if (!o || o.status !== 'Back') H.fail('NOT_FOUND', 'Nothing to confirm.');
      var patch = { status: 'Confirmed', confirmedAt: ctx.now, confirmedBy: actor.id };
      if (correctedTime) {
        if (!/^\d{2}:\d{2}$/.test(correctedTime)) H.fail('BLOCKED', 'Enter the exact time.');
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

  function remindBack(ctx, actor, id) {
    var o = H.find(ctx, 'Outings', id);
    if (!o || o.personId !== actor.id || o.status !== 'Back') H.fail('NOT_FOUND', 'Nothing to remind.');
    ctx.db.update('Outings', id, { remindedAt: ctx.now });
    H.byRole(ctx, 'manager').forEach(function (m) { H.notify(ctx, m.id, 'out', 'Reminder: confirm ' + H.find(ctx, 'People', actor.id).name + ' is back', '', id); });
    return { ok: true };
  }

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
    var rows = ctx.db.rows('DayMinutes').filter(function (m) { return m.personId === personId && Cal.monthKey(m.date) === monthKey; });
    var s = splitDays(rows);
    var person = H.find(ctx, 'People', personId);
    var pay = ctx.db.rows('PayInfo').filter(function (p) { return p.personId === personId; })[0];
    var dutyHours = (pay && pay.dutyHours) || (hhmmToMin(person.dutyEnd) - hhmmToMin(person.dutyStart)) / 60;
    var run = Minutes.runMonth({ salary: pay ? pay.fixedSalary : 0, dutyHours: dutyHours },
      s.events.map(function (m) { return { kind: m.kind, minutes: m.minutes, informed: m.informed, statedMinutes: (m.statedMinutes === '' || !m.informed) ? undefined : m.statedMinutes }; }));
    return { run: run, events: s.events, converted: s.converted, pay: pay || null, dutyHours: dutyHours };
  }

  /** Keep the Violations tab in step with the minute rules. Never deletes: a dropped one is marked removed. */
  function syncViolations(ctx, personId, monthKey) {
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
      if (m.personId === personId && convertedDates[m.date] && !m.informed && m.minutes > Minutes.DEFAULTS.notInformedMaxMinutes) {
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
        proof: proof, note: '', createdBy: 'system', createdAt: ctx.now, disputeState: '', disputeAt: '', disputeText: '', disputeDecidedBy: '', disputeDecidedAt: '' });
      H.notify(ctx, personId, 'violation', 'Violation recorded', H.ruleLabel(wanted[proof].rule) + '. You can dispute it within 24 hours.', proof);
      H.byRole(ctx, 'owner').concat(H.byRole(ctx, 'manager')).forEach(function (m) { H.notify(ctx, m.id, 'violation', 'Violation recorded', H.find(ctx, 'People', personId).name + ': ' + H.ruleLabel(wanted[proof].rule), proof); });
    });
  }

  /**
   * "My month" (handoff 3.10). Only the person, Aakash and Varun may call this for a person;
   * the API layer enforces that. Money lines are estimates and are labelled so.
   */
  function myMonth(ctx, personId, monthKey) {
    var person = H.find(ctx, 'People', personId);
    var mm = monthMinutes(ctx, personId, monthKey);
    var leaves = ctx.db.rows('LeaveRequests').filter(function (r) {
      return r.personId === personId && (r.status === 'Approved' || r.status === 'Recorded' || r.status === 'Absent – unannounced');
    });
    var days = [], emergencies = 0;
    leaves.forEach(function (r) {
      if (r.type === 'Emergency' && Cal.monthKey(r.dates[0]) === monthKey) emergencies += 1;
      r.dates.forEach(function (d) { days.push({ date: d, amount: r.kind === 'half' ? 0.5 : 1, penaltyEmergency: !!r.penaltyEmergency }); });
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
        emergencies: emergencies, emergenciesAllowed: Leave.CFG.maxEmergencies, daysCut: quota.daysCut, autoHalfDays: mm.converted },
      bank: { minutes: mm.run.bankMinutes, used: mm.run.bankUsed, left: mm.run.bankLeft, beyond: mm.run.beyondBankMinutes,
        passesUsed: mm.run.passesUsed, passes: Minutes.DEFAULTS.freePasses,
        days: mm.events.map(function (m, i) { var l = mm.run.lines[i]; return { date: m.date, kind: m.kind, minutes: m.minutes, counted: l.counted, fromBank: l.fromBank, informed: m.informed, notes: l.notes || [] }; }) },
      violations: violations.map(function (v) { return { id: v.id, date: v.date, rule: v.rule, source: v.source, disputeState: v.disputeState, createdAt: v.createdAt }; }),
      ladder: ladder,
      wouldBeDeducted: salary ? { lines: lines, total: quota.wouldBeDeducted + mm.run.wouldBeDeducted,
        label: 'Estimate as per company rules. Final salary is decided by management.' } : null
    };
  }

  // ---------- End of day: absent with no request ----------

  /** Run after closing time. Creates "Absent - unannounced" + 1 violation for staff with no request and no check-in. */
  function endOfDay(ctx, date) {
    return ctx.env.withLock(function () {
      var closed = []; try { closed = JSON.parse(setting(ctx, 'closedDays') || '[]'); } catch (e) { closed = []; }
      if (closed.indexOf(date) !== -1) return [];
      var made = [];
      ctx.db.rows('People').forEach(function (p) {
        if (p.active === false || p.role !== 'staff' || Cal.isRosterOff(p, date)) return;
        if (punchesToday(ctx, p.id, date, 'in').length) return;
        var has = ctx.db.rows('LeaveRequests').some(function (r) { return r.personId === p.id && r.dates.indexOf(date) !== -1 && r.status !== 'Cancelled' && r.status.indexOf('Rejected') !== 0; });
        if (has) return;
        var row = { id: ctx.env.randomId(), personId: p.id, kind: 'full', dates: [date], halfStart: '', reasonCode: '', reasonText: '', submittedAt: ctx.now,
          type: 'Unannounced', noticeHours: 0, run: 1, route: 'system', status: p.noApproval ? 'Recorded' : 'Absent – unannounced', approvals: {},
          extremeEmergency: false, emergencyNo: 0, penaltyEmergency: false, restrictionViolation: false, enteredBy: 'system', decidedAt: ctx.now,
          decidedBy: 'system', decisionReason: '', history: [{ at: ctx.now, by: 'system', action: 'absent-no-request' }] };
        ctx.db.insert('LeaveRequests', row);
        if (!p.noApproval) {
          ctx.db.insert('Violations', { id: ctx.env.randomId(), personId: p.id, date: date, rule: 'absent-no-request', source: 'auto', proof: row.id, note: '',
            createdBy: 'system', createdAt: ctx.now, disputeState: '', disputeAt: '', disputeText: '', disputeDecidedBy: '', disputeDecidedAt: '' });
          H.notify(ctx, p.id, 'violation', 'Absent – unannounced', 'No request and no check-in on ' + niceDay(date) + '.', row.id);
        }
        H.byRole(ctx, 'owner').concat(H.byRole(ctx, 'manager')).forEach(function (m) { H.notify(ctx, m.id, 'absent', 'Absent – unannounced: ' + p.name, niceDay(date), row.id); });
        H.audit(ctx, 'system', 'absent.auto', row.id);
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
      if (!r || r.status !== 'Absent – unannounced') H.fail('NOT_FOUND', 'Not an unannounced absence.');
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
    imBack: imBack, confirmBack: confirmBack, remindBack: remindBack, myMonth: myMonth, endOfDay: endOfDay, excuseAbsence: excuseAbsence,
    syncViolations: syncViolations };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.GJAttendance = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
