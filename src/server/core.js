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

  var RULE_LABELS = { 'not-informed-over-30': 'Not informed, more than 30 min', 'not-informed-beyond-passes': 'Not informed, after the 3 passes',
    'extra-2-hours-beyond-bank': 'Extra 2 hours beyond the bank', 'unannounced-leave': 'Unannounced leave', 'emergency-beyond-2': 'Emergency leave beyond 2 in the month',
    'leave-in-restricted-period': 'Leave in a restricted period', 'absent-no-request': 'Absent with no request' };
  function ruleLabel(rule) { return RULE_LABELS[rule] || String(rule).replace('manual:', 'Recorded by Aakash: '); }
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

    var lockedSet = {}; ctx.db.rows('MonthSheet').forEach(function (m) { lockedSet[m.month] = true; });
    if (dates.some(function (d) { return lockedSet[Cal.monthKey(d)]; })) return { decision: 'blocked', reasons: ['This month is locked.'], valid: false };

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
    byRole(ctx, 'owner').concat(byRole(ctx, 'manager')).forEach(function (m) { notify(ctx, m.id, 'violation', 'Violation recorded', ruleLabel(rule), ref); });
    notify(ctx, personId, 'violation', 'Violation recorded', ruleLabel(rule) + '. You can dispute it within 24 hours.', ref);
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
    previewLeave: previewLeave, submitLeave: submitLeave, decideLeave: decideLeave, cancelLeave: cancelLeave, toMs: toMs,
    _: { fail: fail, find: find, audit: audit, notify: notify, byRole: byRole, today: today, peopleMap: peopleMap, rules: rules,
      approvedAway: approvedAway, liveLeaves: liveLeaves, IST_OFFSET_MS: IST_OFFSET_MS,
      evaluate: evaluate, onGranted: onGranted, ruleLabel: ruleLabel, STATUS_FOR: STATUS_FOR, OPEN: OPEN } };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.GJCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
