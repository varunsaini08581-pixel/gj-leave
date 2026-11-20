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
      // If the person has already arrived or left, the time away has happened: the approval only says it was
      // informed, and the clash rule (which is about letting someone go) has nothing left to stop.
      var happened = ctx.db.rows('DayMinutes').some(function (m) { return m.shortId === id; });
      if (approve && !happened) checkClashToday(ctx, H.find(ctx, 'People', q.personId), q.date, id);
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

  /**
   * A check-out tapped by mistake: Aakash takes it back, with a reason. Nothing is deleted: the
   * check-out is kept as "void", its minutes are set to 0, and the person can check out again.
   */
  function undoCheckOut(ctx, actor, a) {
    return ctx.env.withLock(function () {
      boss(actor);
      var date = a.date || H.today(ctx);
      if (!Cal.isDate(date) || date > H.today(ctx)) H.fail('BLOCKED', 'Pick the date.');
      H.assertOpen(ctx, date);
      if (!String(a.reason || '').trim()) H.fail('REASON', 'Write why the check-out is taken back.');
      var out = punchesToday(ctx, a.personId, date, 'out')[0];
      if (!out) H.fail('NOT_FOUND', 'There is no check-out on that day.');
      ctx.db.update('Punches', out.id, { kind: 'out-void', note: 'Taken back by ' + actor.name + ': ' + String(a.reason).trim() });
      ctx.db.rows('DayMinutes').forEach(function (m) { if (m.source === out.id && m.minutes > 0) ctx.db.update('DayMinutes', m.id, { minutes: 0, note: 'Check-out taken back by ' + actor.name }); });
      syncViolations(ctx, a.personId, Cal.monthKey(date));
      H.audit(ctx, actor.id, 'punch.undo-out', out.id, { personId: a.personId, date: date, reason: a.reason });
      H.notify(ctx, a.personId, 'decision', 'Check-out taken back', niceDay(date) + ': you are checked in again. Check out when you leave.', out.id);
      return { id: out.id };
    });
  }

  /** The person withdraws a late / early request before it takes effect. */
  function cancelShort(ctx, actor, id) {
    return ctx.env.withLock(function () {
      var q = H.find(ctx, 'ShortRequests', id), today = H.today(ctx);
      if (!q || q.personId !== actor.id || (q.status !== 'Pending' && q.status !== 'Approved')) H.fail('NOT_FOUND', 'Nothing to cancel.');
      var used = q.date < today || (q.date === today && punchesToday(ctx, actor.id, today, q.kind === 'late' ? 'in' : 'out').length > 0);
      if (used) H.fail('BLOCKED', 'This request has already been used.');
      ctx.db.update('ShortRequests', id, { status: 'Cancelled', decisionReason: 'Cancelled by ' + actor.name });
      H.audit(ctx, actor.id, 'short.cancel', id);
      H.byRole(ctx, 'manager').forEach(function (m) { H.notify(ctx, m.id, 'approval', actor.name + ' cancelled a ' + (q.kind === 'late' ? 'late arrival' : 'early leaving') + ' request', niceDay(q.date) + ', ' + q.time, id); });
      return { id: id, status: 'Cancelled' };
    });
  }

  /** Aakash has looked at an automatic absence and leaves it as it is: it no longer waits in Approvals. */
  function keepAbsent(ctx, actor, id) {
    return ctx.env.withLock(function () {
      boss(actor);
      var r = H.find(ctx, 'LeaveRequests', id);
      if (!r || r.status !== H.ABSENT) H.fail('NOT_FOUND', 'Not an unannounced absence.');
      ctx.db.update('LeaveRequests', id, { decidedBy: actor.id, decidedAt: ctx.now, decisionReason: 'Kept as absent', history: r.history.concat([{ at: ctx.now, by: actor.id, action: 'kept as absent' }]) });
      H.audit(ctx, actor.id, 'absent.keep', id);
      return { id: id };
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
      if (approve && punchesToday(ctx, o.personId, o.date, 'out').length) H.fail('BLOCKED', 'This person has already checked out for the day. Reject the request.');
      if (approve) checkClashToday(ctx, H.find(ctx, 'People', o.personId), o.date, id);
      // The outing clock starts at the approval time.
      ctx.db.update('Outings', id, approve ? { status: 'Approved', approvedAt: ctx.now, approvedBy: actor.id }
        : { status: 'Rejected', approvedBy: actor.id, decisionReason: reason });
      H.audit(ctx, actor.id, approve ? 'out.approve' : 'out.reject', id);
      H.notify(ctx, o.personId, 'out', approve ? 'Going out approved' : 'Going out not approved', approve ? 'Tap I’m back when you return.' : reason, id);
      return { id: id, status: approve ? 'Approved' : 'Rejected' };
    });
  }

  /** Minutes of an outing that fall inside the person's duty hours (time after duty end is their own). */
  function outingMinutes(o, backAt, ctx) {
    var end = backAt, p = ctx ? H.find(ctx, 'People', o.personId) : null;
    if (p && Cal.isTime(p.dutyEnd)) end = Math.min(backAt, Core.toMs(o.date, p.dutyEnd));
    return Math.max(0, Math.floor((end - o.approvedAt) / 60000));
  }

  /** Staff taps "I'm back". The counted time ends at THIS tap, not at Aakash's confirmation. */
  function imBack(ctx, actor, id) {
    return ctx.env.withLock(function () {
      var o = H.find(ctx, 'Outings', id);
      if (!o || o.personId !== actor.id || o.status !== 'Approved') H.fail('NOT_FOUND', 'No open outing.');
      var minutes = outingMinutes(o, ctx.now, ctx);
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
        var mins = outingMinutes(o, back, ctx);
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
        patch.correctedBackAt = corrected; patch.minutes = outingMinutes(o, corrected, ctx);
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
  H.hooks.syncViolations = function (ctx, personId, monthKey) { return syncViolations(ctx, personId, monthKey); };

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
      if (wanted[v.proof]) {
        if (v.disputeState === 'removed' && /^Recalculated/.test(v.note || '')) ctx.db.update('Violations', v.id, { disputeState: '', note: 'Applies again after a correction' });
        delete wanted[v.proof]; return;
      }
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
      if (counted && H.isEmergency(r, closed) && Cal.monthKey(r.dates[0]) === monthKey) emergencies += 1;
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
    var quota = Leave.monthQuota({ sundayOff: person.sundayOff, history: person.history, salary: salary }, monthKey, days);
    var violations = ctx.db.rows('Violations').filter(function (v) {
      return v.personId === personId && Cal.monthKey(v.date) === monthKey && v.disputeState !== 'removed';
    });
    var ladder = Minutes.ladder(violations.length, { disciplineBonus: mm.pay ? mm.pay.disciplineBonus : Minutes.DEFAULTS.disciplineBonus });
    var lines = [];
    if (salary && quota.daysCut > 0) {
      var parts = [];
      if (quota.daysAboveQuota > 0) parts.push(quota.total + ' leaves − ' + Leave.CFG.freeLeaves + ' free = ' + quota.daysAboveQuota + ' day(s)');
      if (quota.penaltyEmergencyDays > 0) parts.push(quota.penaltyEmergencyDays + ' day(s) of emergency leave beyond 2 (never free)');
      lines.push(parts.join(' + ') + (parts.length > 1 ? ' = ' + quota.daysCut + ' day(s)' : '') + ' × Rs ' + Math.round(quota.dayRate) + ' = Rs ' + quota.wouldBeDeducted);
    }
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
      violations: violations.map(function (v) { return { id: v.id, date: v.date, rule: v.rule, source: v.source, note: v.source === 'manual' ? v.note : '', disputeState: v.disputeState, createdAt: v.createdAt }; }),
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
        if (p.role !== 'staff' || !Cal.wasActive(p, date) || Cal.isRosterOff(p, date)) return; // as the person was ON THAT DAY, not as Settings say today
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
    imBack: imBack, confirmBack: confirmBack, manualCheckOut: manualCheckOut, undoCheckOut: undoCheckOut, cancelShort: cancelShort, keepAbsent: keepAbsent, expectedDay: expectedDay, uncovered: uncovered, decideDress: decideDress, manualCheckIn: manualCheckIn, effectOf: effectOf, hints: hints, dressIssues: dressIssues, remindBack: remindBack, myMonth: myMonth, liveMonth: liveMonth, endOfDay: endOfDay, excuseAbsence: excuseAbsence,
    syncViolations: syncViolations };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.GJAttendance = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
