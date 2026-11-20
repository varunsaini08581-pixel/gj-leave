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
    var then = Cal.asOn(person, date); // the duty hours the person had on that day, not the ones Settings show today
    var start = hhmmToMin(Cal.isTime(then.dutyStart) ? then.dutyStart : person.dutyStart), end = hhmmToMin(Cal.isTime(then.dutyEnd) ? then.dutyEnd : person.dutyEnd);
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

  /** Is this a working day for the person? On a full leave day, a roster Sunday off or a shop-closed day no minutes are counted at all. */
  function dayCounts(ctx, personId, date) {
    var p = H.find(ctx, 'People', personId);
    return !!p && !expectedDay(ctx, p, date).fullLeave && !Cal.isRosterOff(p, date) && !H.closedSet(ctx)[date];
  }
  /**
   * How many of the minutes from..to (minutes of the day) were covered by a leave that
   *  (a) had been GRANTED before the moment `at` (the arrival or the leaving), and
   *  (b) was taken back by Aakash, Varun or a rule change ON that day or LATER?
   * That time was approved leave when it happened, so it counts as "informed". A leave the person cancelled, one taken
   * back before the day began, or one entered or approved only afterwards changes nothing. A half day covers only its
   * own hours. Returns Infinity for a full day, else the covered minutes (0 = none).
   */
  function knownByLeave(ctx, personId, date, from, to, at) {
    var dayStart = Core.toMs(date, '00:00'), best = 0;
    var cover = function (kind, halfStart) {
      if (kind === 'full') return Infinity;
      if (kind !== 'half' || !halfStart) return 0;
      var hs = hhmmToMin(halfStart);
      return Math.max(0, Math.min(to, hs + HALF_DAY_MINUTES) - Math.max(from, hs));
    };
    ctx.db.rows('LeaveRequests').forEach(function (r) {
      if (r.personId !== personId || r.route === 'system') return;
      var hist = r.history || [];
      hist.forEach(function (h, k) {
        if (!h || h.by === personId || !(h.at >= dayStart)) return;
        var a = h.action || '', got = 0;
        if (a === 'cancelled') got = r.status === 'Cancelled' && !!r.decidedAt && r.dates.indexOf(date) !== -1 ? cover(r.kind, r.halfStart) : 0;
        else if (/^rejected – clash \(rule changed\)/.test(a)) got = r.dates.indexOf(date) !== -1 ? cover(r.kind, r.halfStart) : 0;
        else if (/^shortened/.test(a)) got = h.from && (h.from.dates || []).indexOf(date) !== -1 && r.dates.indexOf(date) === -1 ? Infinity : 0;
        else if (a === 'edited') got = h.from && /^(Approved|Recorded)$/.test(h.from.status || '') && h.from.kind === 'full' && h.from.first <= date && date <= h.from.last && r.dates.indexOf(date) === -1 ? Infinity : 0;
        if (!got) return;
        // When was it granted (as it stood just before this take-back)? The last approval after the last submit / edit; with no approval it was granted by itself at that submit / edit.
        var s = -1, granted = 0;
        for (var i = 0; i < k; i++) { var x = hist[i] && hist[i].action || ''; if (x === 'submitted' || x === 'edited' || /^called/.test(x) || /^override/.test(x)) { s = i; granted = hist[i].at; } else if (x === 'approved' && i > s) granted = hist[i].at; }
        if (s === -1) granted = r.submittedAt;
        if (!(granted < at)) return;
        if (got > best) best = got;
      });
    });
    return best;
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
      if (date > Cal.addDays(H.today(ctx), 14)) H.fail('BLOCKED', 'A late or early request can be sent for the next 14 days only.');
      if (ctx.db.rows('ShortRequests').filter(function (q) { return q.personId === actor.id && q.date >= H.today(ctx) && (q.status === 'Pending' || q.status === 'Approved'); }).length >= 8) H.fail('BLOCKED', 'You already have 8 late / early requests open. Cancel one first.');
      var day = expectedDay(ctx, person, date), t = hhmmToMin(a.time);
      if (day.fullLeave) H.fail('BLOCKED', 'You are on leave that day.');
      var minutes = a.kind === 'late' ? t - day.start : day.end - t;
      if (minutes <= 0) H.fail('BLOCKED', a.kind === 'late' ? 'That time is not after your duty start.' : 'That time is not before your duty end.');
      if (minutes > Minutes.DEFAULTS.halfDayAfterMinutes) H.fail('BLOCKED', 'More than 2 hours is a half day. Please apply for a half-day leave.');
      if (punchesToday(ctx, actor.id, date, a.kind === 'late' ? 'in' : 'out').length) H.fail('BLOCKED', a.kind === 'late' ? 'You have already checked in.' : 'You have already checked out. An early leaving can be informed only before you leave.');
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
      H.deciders(ctx).forEach(function (m) {
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
      // The person may already have arrived or left while this was pending: the day is counted again.
      recountDay(ctx, q.personId, q.date);
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
        var pt = null; try { pt = JSON.parse(shop); } catch (e) { pt = null; } // a cell damaged by hand must not stop every check-in
        if (pt && typeof pt.lat === 'number' && typeof pt.lng === 'number') {
          distance = distanceM(pt.lat, pt.lng, a.lat, a.lng);
          if (distance > SHOP_RADIUS_M) flag.push('outside-shop-area');
        } else flag.push('shop-location-not-set');
      } else if (shop) flag.push('no-location');
      if (day.fullLeave || Cal.isRosterOff(person, date) || H.closedSet(ctx)[date]) flag.push('off-day');
      var punch = { id: ctx.env.randomId(), personId: actor.id, date: date, kind: 'in', at: ctx.now, photoId: a.photoId || '',
        lat: a.lat === undefined ? '' : a.lat, lng: a.lng === undefined ? '' : a.lng, accuracy: a.accuracy === undefined ? '' : a.accuracy,
        distance: distance, deviceId: actor.deviceId || '', flag: flag.join(','), note: '', thumbId: a.thumbId || '', dress: null, dressDecision: '', enteredBy: '' };
      // Automatic dress check (Mon-Sat; Sunday casual; exempt people skipped). It only FLAGS to Aakash.
      if (a.dress && !person.dressExempt && Cal.weekday(date) !== 0) {
        punch.dress = cleanDress(a.dress);
        if (dressIssues(punch.dress).length) H.deciders(ctx).forEach(function (m) {
          H.notify(ctx, m.id, 'dress', 'Dress check: ' + person.name, 'Possible issue: ' + dressIssues(punch.dress).join(', ') + '. Confirm or dismiss.', punch.id);
        });
      }
      ctx.db.insert('Punches', punch);

      recountDay(ctx, actor.id, date);
      var counted = ctx.db.rows('DayMinutes').filter(function (m) { return m.personId === actor.id && m.date === date && m.kind === 'late' && m.minutes > 0; })[0] || null;
      var late = counted ? counted.minutes : !dayCounts(ctx, actor.id, date) ? 0 : Math.min(uncovered(day.start, nowMin(ctx), day.win), uncovered(day.start, day.end, day.win));
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
      recountDay(ctx, actor.id, date);
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
      var person = H.find(ctx, 'People', a.personId), date = a.date || H.today(ctx);
      if (!person || person.role !== 'staff') H.fail('NOT_FOUND', 'Choose a staff member.');
      if (!Cal.isDate(date) || date > H.today(ctx)) H.fail('BLOCKED', 'Pick the date.');
      H.assertOpen(ctx, date);
      if (!String(a.reason || '').trim()) H.fail('REASON', 'Write why the person could not check in.');
      if (!Cal.isTime(a.time)) H.fail('BLOCKED', 'Enter the exact arrival time.');
      if (punchesToday(ctx, a.personId, date, 'in').length) H.fail('BLOCKED', 'Already checked in today.');
      var at = Core.toMs(date, a.time);
      if (at > ctx.now) H.fail('BLOCKED', 'The time cannot be in the future.');
      // The person was at work: an absence the evening job has already recorded for that day is taken back.
      ctx.db.rows('LeaveRequests').forEach(function (x) {
        if (x.personId !== person.id || x.route !== 'system' || x.dates.indexOf(date) === -1 || x.status === 'Cancelled') return;
        ctx.db.update('LeaveRequests', x.id, { status: 'Cancelled', decisionReason: 'Check-in entered by ' + actor.name, decidedBy: actor.id, decidedAt: ctx.now,
          history: H.hist(x.history, [{ at: ctx.now, by: actor.id, action: 'absence taken back (check-in entered)' }]) });
      });
      var asThen = { db: ctx.db, env: ctx.env, now: at, stampNow: ctx.now };
      var r = checkIn(asThen, { id: person.id, name: person.name, role: 'staff', deviceId: '' }, {});
      ctx.db.update('Punches', r.id, { enteredBy: actor.id, note: 'Entered by ' + actor.name + ': ' + String(a.reason).trim(), flag: 'entered-by-manager' });
      H.syncLeaveViolations(ctx, person.id);
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
      recountDay(ctx, a.personId, date);
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
      H.deciders(ctx).forEach(function (m) { H.notify(ctx, m.id, 'approval', actor.name + ' cancelled a ' + (q.kind === 'late' ? 'late arrival' : 'early leaving') + ' request', niceDay(q.date) + ', ' + q.time, id); });
      return { id: id, status: 'Cancelled' };
    });
  }

  /** Aakash has looked at an automatic absence and leaves it as it is: it no longer waits in Approvals. */
  function keepAbsent(ctx, actor, id) {
    return ctx.env.withLock(function () {
      boss(actor);
      var r = H.find(ctx, 'LeaveRequests', id);
      if (!r || r.status !== H.ABSENT) H.fail('NOT_FOUND', 'Not an unannounced absence.');
      ctx.db.update('LeaveRequests', id, { decidedBy: actor.id, decidedAt: ctx.now, decisionReason: 'Kept as absent', history: H.hist(r.history, [{ at: ctx.now, by: actor.id, action: 'kept as absent' }]) });
      H.audit(ctx, actor.id, 'absent.keep', id);
      return { id: id };
    });
  }

  // ---------- Going out (owner's flow, handoff 3.8) ----------

  function goingOut(ctx, actor, a) {
    return ctx.env.withLock(function () {
      var person = H.find(ctx, 'People', actor.id), date = H.today(ctx);
      if (typeof a.reason !== 'string' || !a.reason.trim()) H.fail('BLOCKED', 'Write the reason.');
      if (!(typeof a.expectedMinutes === 'number' && a.expectedMinutes > 0 && a.expectedMinutes <= 600)) H.fail('BLOCKED', 'Enter the expected minutes.');
      if (!punchesToday(ctx, actor.id, date, 'in').length || punchesToday(ctx, actor.id, date, 'out').length) H.fail('BLOCKED', 'You are not checked in.');
      var busy = ctx.db.rows('Outings').some(function (o) { return o.personId === actor.id && o.date === date && (o.status === 'Pending' || o.status === 'Approved'); });
      if (busy) H.fail('BLOCKED', 'You already have an open going-out request.');
      checkClashToday(ctx, person, date);
      var row = { id: ctx.env.randomId(), personId: actor.id, date: date, reason: String(a.reason).trim(), expectedMinutes: +a.expectedMinutes,
        requestedAt: ctx.now, status: 'Pending', approvedAt: '', approvedBy: '', decisionReason: '', backAt: '', confirmedAt: '',
        confirmedBy: '', correctedBackAt: '', minutes: '', remindedAt: '' };
      ctx.db.insert('Outings', row);
      H.audit(ctx, actor.id, 'out.request', row.id);
      H.deciders(ctx).forEach(function (m) { H.notify(ctx, m.id, 'out', 'Going out: ' + person.name, row.reason + ' (' + row.expectedMinutes + ' min)', row.id); });
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
    var end = backAt, start = o.approvedAt, p = ctx ? H.find(ctx, 'People', o.personId) : null;
    if (p) {
      var day = expectedDay(ctx, p, o.date); // the person's own time before duty start and after duty end is not counted
      end = Math.min(backAt, Core.toMs(o.date, minToHhmm(day.end))); start = Math.max(o.approvedAt, Core.toMs(o.date, minToHhmm(day.start)));
    }
    return Math.max(0, Math.floor((end - start) / 60000));
  }

  /** Staff taps "I'm back". The counted time ends at THIS tap, not at Aakash's confirmation. */
  function imBack(ctx, actor, id) {
    return ctx.env.withLock(function () {
      var o = H.find(ctx, 'Outings', id);
      if (!o || o.personId !== actor.id || o.status !== 'Approved') H.fail('NOT_FOUND', 'No open outing.');
      var minutes = outingMinutes(o, ctx.now, ctx);
      ctx.db.update('Outings', id, { status: 'Back', backAt: ctx.now, minutes: minutes });
      recountDay(ctx, actor.id, o.date);
      H.audit(ctx, actor.id, 'out.back', id, { minutes: minutes });
      H.deciders(ctx).forEach(function (m) { H.notify(ctx, m.id, 'out', H.find(ctx, 'People', actor.id).name + ' is back', minutes + ' min. Please confirm.', id); });
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
        recountDay(ctx, o.personId, o.date);
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
        H.audit(ctx, actor.id, 'out.correct', id, { from: o.backAt, to: corrected });
      }
      ctx.db.update('Outings', id, patch);
      recountDay(ctx, o.personId, o.date);
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
      H.deciders(ctx).forEach(function (m) { H.notify(ctx, m.id, 'out', 'Reminder: confirm ' + H.find(ctx, 'People', actor.id).name + ' is back', '', id); });
      return { ok: true };
    });
  }

  /**
   * A leave was granted for a day on which the person had already checked in or out (the request was
   * still waiting at that moment). The late / early minutes of that day are worked out again against
   * the day as it stands now; nothing is deleted, a row that no longer counts is set to 0 with a note.
   */
  /**
   * What one day costs, worked out from the facts alone: the check-in and check-out, the outings, the late /
   * early requests, and the leave of that day AS IT STANDS NOW. Nothing here depends on which tap came first.
   */
  function deriveDay(ctx, person, date) {
    var out = [], id = person.id;
    var pin = punchesToday(ctx, id, date, 'in')[0], pout = punchesToday(ctx, id, date, 'out')[0];
    if (!pin) return out;
    var day = expectedDay(ctx, person, date), counts = dayCounts(ctx, id, date);
    var minOf = function (p) { var d = new Date(p.at + H.IST_OFFSET_MS); return d.getUTCHours() * 60 + d.getUTCMinutes(); };
    if (counts) {
      var cin = minOf(pin), late = Math.min(uncovered(day.start, cin, day.win), uncovered(day.start, day.end, day.win));
      if (late > Minutes.DEFAULTS.lateGraceMinutes) {
        var q = activeShort(ctx, id, date, 'late');
        // "Informed" only if it was applied before duty start AND Aakash approved it. Still pending: not informed for now.
        var inTime = !!q && q.submittedAt < Core.toMs(date, minToHhmm(day.start));
        var told = inTime && q.status === 'Approved', byLeave = knownByLeave(ctx, id, date, day.start, cin, pin.at);
        // Told by an approved request: informed up to the stated time. Covered by a leave taken back that day: informed for the hours the leave covered.
        var statedMin = told ? hhmmToMin(q.time) - day.start : (inTime ? hhmmToMin(q.time) - day.start : '');
        if (byLeave) statedMin = byLeave === Infinity ? (told ? statedMin : '') : Math.max(told ? statedMin : 0, Math.min(late, byLeave));
        out.push({ kind: 'late', minutes: late, informed: told || byLeave > 0, statedMinutes: statedMin, source: pin.id, shortId: inTime && q.status === 'Pending' ? q.id : '' });
      }
      if (pout) {
        var cout = minOf(pout), early = uncovered(cout, day.end, day.win);
        if (early > 0) {
          var e = activeShort(ctx, id, date, 'early');
          if (e && !(e.submittedAt < pout.at)) e = null; // sent after the leaving: it cannot make the leaving informed
          var stated = e ? hhmmToMin(e.time) : null;
          var ok = !!e && e.status === 'Approved', wait = e && e.status === 'Pending' ? e.id : '';
          var known = knownByLeave(ctx, id, date, cout, day.end, pout.at), pieces = [];
          if (e && ok && cout < stated) { // approved, but left before the stated time: the extra minutes are not informed
            if (uncovered(stated, day.end, day.win) > 0) pieces.push([uncovered(stated, day.end, day.win), true, '']);
            if (uncovered(cout, stated, day.win) > 0) pieces.push([uncovered(cout, stated, day.win), false, '']);
          } else pieces.push([early, ok, wait]); // one leaving = one row while nothing is approved (pending counts as not informed for now)
          if (known === Infinity) pieces = pieces.map(function (p) { return [p[0], true, p[2]]; });
          else if (known > 0 && pieces.length === 1 && !pieces[0][1] && known < early) pieces = [[known, true, ''], [early - known, false, wait]];
          else if (known > 0 && pieces.length === 1) pieces = [[pieces[0][0], true, pieces[0][2]]];
          known = false;
          pieces.forEach(function (p) { out.push({ kind: 'early', minutes: p[0], informed: p[1] || known, statedMinutes: '', source: pout.id, shortId: p[2] }); });
        }
      }
    }
    // Going out: counted on a working day only (a full-leave day, a roster Sunday off and a closed day cost nothing).
    ctx.db.rows('Outings').forEach(function (o) {
      if (o.personId !== id || o.date !== date || !(o.status === 'Back' || o.status === 'Confirmed') || !(o.minutes > 0)) return;
      out.push({ kind: 'out', minutes: counts ? o.minutes : 0, informed: true, statedMinutes: '', source: o.id, shortId: '' });
    });
    return out;
  }

  /**
   * The minute rows of one day are made to say exactly what deriveDay says. It runs after EVERY change that can
   * touch a day (a tap, a decision, a leave granted / cancelled / edited / shortened, a closed day, a rule change),
   * so the same facts always give the same count. Rows are never deleted: one that no longer counts is set to 0.
   */
  function recountDay(ctx, personId, date) {
    if (H.lockedMonths(ctx)[Cal.monthKey(date)]) return; // a locked month is never counted again
    var person = H.find(ctx, 'People', personId);
    if (!person) return;
    var want = deriveDay(ctx, person, date);
    var have = ctx.db.rows('DayMinutes').filter(function (m) { return m.personId === personId && m.date === date; });
    var touched = false, used = {};
    var same = function (m, w) { return m.minutes === w.minutes && !!m.informed === !!w.informed && String(m.statedMinutes === undefined || m.statedMinutes === null ? '' : m.statedMinutes) === String(w.statedMinutes) && (m.source || '') === w.source && (m.shortId || '') === w.shortId; };
    want.forEach(function (w) {
      // An outing keeps its own row; late / early rows are reused in order (their violations hang on the row).
      var row = have.filter(function (m) { return !used[m.id] && m.kind === w.kind && (w.kind !== 'out' || m.source === w.source); })[0];
      if (!row) {
        if (!(w.minutes > 0)) return;
        var made = addDayMinutes(ctx, personId, date, w.kind, w.minutes, w.informed, w.statedMinutes === '' ? undefined : w.statedMinutes, w.source, w.shortId);
        used[made.id] = 1; touched = true; return;
      }
      used[row.id] = 1;
      if (!same(row, w)) { ctx.db.update('DayMinutes', row.id, { minutes: w.minutes, informed: w.informed, statedMinutes: w.statedMinutes, source: w.source, shortId: w.shortId, note: w.minutes > 0 ? '' : 'Not counted on this day' }); touched = true; }
    });
    have.forEach(function (m) { if (!used[m.id] && m.minutes > 0) { ctx.db.update('DayMinutes', m.id, { minutes: 0, note: 'Not counted: the day was counted again' }); touched = true; } });
    if (touched) syncViolations(ctx, personId, Cal.monthKey(date));
  }
  H.hooks.recountDay = recountDay;
  H.hooks.endOfDay = function (ctx, date) { return endOfDay(ctx, date); };
  H.hooks.syncViolations = function (ctx, personId, monthKey) { return syncViolations(ctx, personId, monthKey); };

  // ---------- Month calculation ----------

  /** Days on which the total away time is over 2 hours become a half day (or a full day over 4 h 30 min). */
  /** Only the first short outing (15 min or less) of a day is free; the other short outings of that day are counted. */
  function markFreeOuting(ctx, events) {
    var at = {}; ctx.db.rows('Outings').forEach(function (o) { at[o.id] = o.approvedAt || o.requestedAt || 0; });
    var byDay = {}, notFree = {};
    events.forEach(function (e) { if (e.kind === 'out' && e.minutes > 0 && e.minutes <= Minutes.DEFAULTS.outFreeMinutes) (byDay[e.date] = byDay[e.date] || []).push(e); });
    Object.keys(byDay).forEach(function (d) {
      byDay[d].sort(function (a, b) { return (at[a.source] || 0) - (at[b.source] || 0); }).forEach(function (e, i) { if (i > 0) notFree[e.id] = true; });
    });
    return notFree; // ids of rows, never written into the rows themselves
  }
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
    var shut = H.closedSet(ctx);
    var rows = ctx.db.rows('DayMinutes').filter(function (m) { return m.personId === personId && Cal.monthKey(m.date) === monthKey && m.minutes > 0 && !shut[m.date] && (m.kind === 'late' || m.kind === 'early' || m.kind === 'out'); }); // a kind cell damaged by hand is left out, not a crash
    var s = splitDays(rows);
    var notFree = markFreeOuting(ctx, s.events);
    var person = H.find(ctx, 'People', personId);
    var pay = ctx.db.rows('PayInfo').filter(function (p) { return p.personId === personId; })[0];
    var dutyHours = (pay && pay.dutyHours) || (hhmmToMin(person.dutyEnd) - hhmmToMin(person.dutyStart)) / 60;
    var run = Minutes.runMonth({ salary: pay ? pay.fixedSalary : 0, dutyHours: dutyHours },
      s.events.map(function (m) { return { kind: m.kind, minutes: m.minutes, informed: m.informed, noFree: !!notFree[m.id], statedMinutes: (m.statedMinutes === '' || !m.informed) ? undefined : m.statedMinutes }; }));
    // Informed minutes already beyond the bank (they decide the "extra 2 hours" violations).
    var used = 0, beyondInformed = 0;
    run.lines.forEach(function (l, i) { if (s.events[i].informed) beyondInformed += l.beyondBank; used += l.fromBank; });
    run.beyondInformed = beyondInformed;
    return { run: run, events: s.events, converted: s.converted, pay: pay || null, dutyHours: dutyHours };
  }

  /** Keep the Violations tab in step with the minute rules. Never deletes: a dropped one is marked removed. */
  function syncViolations(ctx, personId, monthKey) {
    var who = H.find(ctx, 'People', personId);
    if (H.lockedMonths(ctx)[monthKey]) return; // a locked month is never counted again
    var mm = monthMinutes(ctx, personId, monthKey);
    var wanted = {}, perEvent = {};
    mm.run.violations.forEach(function (v) {
      var src = mm.events[v.eventIndex];
      var k = (perEvent[src.id + v.rule] = (perEvent[src.id + v.rule] || 0) + 1);
      if (who && Cal.asOn(who, src.date).noApproval) return; // "records only" on that day: never a violation
      wanted['dm:' + src.id + ':' + v.rule + ':' + k] = { rule: v.rule, date: src.date };
    });
    // A day that became a half/full day is outside the bank, but "not informed and more than
    // 30 min" is still a violation on that day.
    var convertedDates = {}; mm.converted.forEach(function (c) { convertedDates[c.date] = true; });
    ctx.db.rows('DayMinutes').forEach(function (m) {
      if (m.personId !== personId || !convertedDates[m.date] || !(m.minutes > 0)) return;
      // The part nobody was told about: everything when not informed; when informed, the minutes after the stated time.
      var stated = m.statedMinutes === '' || m.statedMinutes === undefined || m.statedMinutes === null ? null : m.statedMinutes;
      var silent = !m.informed ? m.minutes : (stated === null ? 0 : Math.max(0, m.minutes - stated));
      if (silent > Minutes.DEFAULTS.notInformedMaxMinutes && !(who && Cal.asOn(who, m.date).noApproval)) {
        wanted['dm:' + m.id + ':not-informed-over-30:1'] = { rule: 'not-informed-over-30', date: m.date };
      }
    });
    var existing = ctx.db.rows('Violations').filter(function (v) {
      return v.personId === personId && Cal.monthKey(v.date) === monthKey && String(v.proof).indexOf('dm:') === 0;
    });
    existing.forEach(function (v) {
      if (wanted[v.proof]) return;
      var heir = Object.keys(wanted).filter(function (k) { return wanted[k].rule === v.rule && wanted[k].date === v.date && !existing.some(function (x) { return x.proof === k; }); })[0];
      if (heir) ctx.db.update('Violations', v.id, { proof: heir });
    });
    existing.forEach(function (v) {
      if (wanted[v.proof]) {
        if (v.disputeState === 'removed') H.reviveRow(ctx, v); // never when Varun removed it
        delete wanted[v.proof]; return;
      }
      if (v.disputeState !== 'removed') H.withdrawRow(ctx, v, 'Counted again after a correction or a later approval');
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
        passesUsed: mm.run.passesUsed, passes: Minutes.DEFAULTS.freePasses, notInformed: mm.run.notInformedCount,
        days: mm.events.map(function (m, i) { var l = mm.run.lines[i]; return { date: m.date, kind: m.kind, minutes: m.minutes, counted: l.counted, fromBank: l.fromBank, informed: m.informed, notes: l.notes || [] }; }) },
      // The record of the last 3 months (this month and the two before it) stays in view.
      last3: [2, 1, 0].map(function (back) {
        var y = +monthKey.slice(0, 4), mo = +monthKey.slice(5, 7) - back;
        while (mo < 1) { mo += 12; y -= 1; }
        var key = y + '-' + (mo < 10 ? '0' + mo : mo);
        var n = ctx.db.rows('Violations').filter(function (v) { return v.personId === personId && Cal.monthKey(v.date) === key && v.disputeState !== 'removed'; }).length;
        var frozen = ctx.db.rows('MonthSheet').filter(function (s) { return s.month === key && s.personId === personId; })[0];
        if (frozen && frozen.result && frozen.result.ladder) n = frozen.result.ladder.violations;
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
    var day = date || H.today(ctx);
    var freeUsed = kind === 'out' && ctx.db.rows('DayMinutes').some(function (m) { return m.personId === personId && m.date === day && m.kind === 'out' && m.minutes > 0 && m.minutes <= Minutes.DEFAULTS.outFreeMinutes; });
    var counted = kind === 'late' ? Math.max(0, minutes - Minutes.DEFAULTS.lateGraceMinutes) : kind === 'out' ? (minutes <= Minutes.DEFAULTS.outFreeMinutes && !freeUsed ? 0 : minutes) : minutes;
    var left = mm.run.bankLeft, lines = [];
    if (minutes > Minutes.DEFAULTS.halfDayAfterMinutes) return { counted: 0, lines: ['More than 2 hours in one day is a half day (0.5 leave), not the bank.'] };
    if (kind === 'out' && freeUsed && minutes <= Minutes.DEFAULTS.outFreeMinutes) lines.push('Your free outing of today is used: this one counts from the bank.');
    if (counted === 0) lines.push(kind === 'out' ? 'Up to 15 min is free, once a day. Nothing is counted.' : 'Inside the 10-min grace. Nothing is counted.');
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
      if (H.closedSet(ctx)[date]) return [];
      if (H.lockedMonths(ctx)[Cal.monthKey(date)]) return [];
      var made = [];
      ctx.db.rows('People').forEach(function (p) {
        if (p.role !== 'staff' || !Cal.wasActive(p, date) || Cal.isRosterOff(p, date)) return; // as the person was ON THAT DAY, not as Settings say today
        if (p.joinedOn && date < p.joinedOn) return; // not yet part of the shop on that day
        if (!H.dayOver(ctx, p, date)) return; // never before that person's duty end (a job run by hand in the morning marks nobody)
        if (punchesToday(ctx, p.id, date, 'in').length) return;
        var rows = ctx.db.rows('LeaveRequests').filter(function (r) { return r.personId === p.id && r.dates.indexOf(date) !== -1; });
        if (rows.some(function (r) { return r.route === 'system'; })) return; // the job has dealt with this day once (also when Aakash took the absence back): never marked twice
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
        history: H.hist(r.history, [{ at: ctx.now, by: actor.id, action: 'excused', reason: reason }]) });
      ctx.db.rows('Violations').forEach(function (v) {
        if (v.proof === leaveId && v.rule === 'absent-no-request') ctx.db.update('Violations', v.id, { disputeState: 'removed', note: 'Humanitarian – excused: ' + reason });
      });
      r.dates.forEach(function (d) { recountDay(ctx, r.personId, d); }); // a late tap on that day counts nothing on an excused full-leave day
      H.audit(ctx, actor.id, 'absent.excuse', leaveId, { reason: reason });
      H.notify(ctx, r.personId, 'decision', 'Absence excused', H.niceDates(r.dates) + ': the violation is removed. The day stays as a leave day. \u2014 ' + String(reason).trim(), leaveId);
      H.byRole(ctx, 'owner').forEach(function (o) { if (o.id !== actor.id) H.notify(ctx, o.id, 'decision', 'Absence excused: ' + H.find(ctx, 'People', r.personId).name, H.niceDates(r.dates) + ' \u2014 ' + String(reason).trim() + ' (by ' + actor.name + ')', leaveId); });
      return { id: leaveId, status: 'Approved' };
    });
  }

  var api = { requestShort: requestShort, decideShort: decideShort, checkIn: checkIn, checkOut: checkOut, goingOut: goingOut, decideOuting: decideOuting,
    imBack: imBack, confirmBack: confirmBack, manualCheckOut: manualCheckOut, undoCheckOut: undoCheckOut, cancelShort: cancelShort, keepAbsent: keepAbsent, expectedDay: expectedDay, uncovered: uncovered, decideDress: decideDress, manualCheckIn: manualCheckIn, effectOf: effectOf, hints: hints, dressIssues: dressIssues, remindBack: remindBack, myMonth: myMonth, liveMonth: liveMonth, endOfDay: endOfDay, excuseAbsence: excuseAbsence,
    syncViolations: syncViolations };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.GJAttendance = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
