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
  /**
   * The history of a request, with new entries added. It never grows without limit: beyond 40 entries
   * the first one, a note and the latest 30 are kept (every step is in the Audit tab as well), so no
   * amount of editing can make a request too big to decide, cancel or lock.
   */
  function addHistory(list, add) {
    var out = (Array.isArray(list) ? list : []).concat(add);
    if (out.length <= 40) return out;
    var tail = out.slice(-30), dropped = out.length - 31 + (out[1] && out[1].dropped ? out[1].dropped - 1 : 0);
    return [out[0], { action: 'older entries are in the Audit tab', dropped: dropped }].concat(tail);
  }
  var MAX_EDITS = 10;
  function hhmmToMin(t) { var a = t.split(':'); return +a[0] * 60 + +a[1]; }
  function settingValue(ctx, key) { var s = ctx.db.rows('Settings').filter(function (x) { return x.key === key; })[0]; return s ? s.value : ''; }
  /** Shop-closed days (Settings). A leave on a closed day uses no quota. */
  function closedSet(ctx) {
    var out = {};
    try { var list = JSON.parse(settingValue(ctx, 'closedDays') || '[]'); if (Array.isArray(list)) list.forEach(function (d) { if (typeof d === 'string') out[d] = true; }); } catch (e) { /* bad setting = no closed days */ }
    return out;
  }
  /** Days on which the total away time is over 2 hours: a half day, or a full day over 4 h 30 min. */
  function autoDays(ctx, personId) {
    var sum = {};
    ctx.db.rows('DayMinutes').forEach(function (m) { if (m.personId === personId) sum[m.date] = (sum[m.date] || 0) + m.minutes; });
    var shut = closedSet(ctx);
    return Object.keys(sum).sort().filter(function (d) { return !shut[d] && sum[d] > Minutes.DEFAULTS.halfDayAfterMinutes; })
      .map(function (d) { return { date: d, minutes: sum[d], amount: sum[d] > HALF_DAY_MINUTES ? 1 : 0.5 }; });
  }
  function find(ctx, tab, id) { return ctx.db.rows(tab).filter(function (r) { return r.id === id; })[0]; }
  function audit(ctx, actor, action, ref, detail) {
    ctx.db.insert('Audit', { id: ctx.env.randomId(), at: ctx.now, actor: actor, action: action, ref: ref || '', detail: detail || {} });
  }
  function notify(ctx, to, kind, title, body, ref) {
    ctx.db.insert('Notifications', { id: ctx.env.randomId(), to: to, kind: kind, title: title, body: body, ref: ref || '', createdAt: ctx.now, readAt: '', emailedAt: '' });
  }
  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  /** "25 Nov" or "7 Dec – 10 Dec (4 days)" for alerts and e-mails. */
  function niceDates(dates) {
    var one = function (d) { return (+d.slice(8)) + ' ' + MONTHS[+d.slice(5, 7) - 1]; };
    if (!dates || !dates.length) return '';
    return dates.length === 1 ? one(dates[0]) : one(dates[0]) + ' \u2013 ' + one(dates[dates.length - 1]) + ' (' + dates.length + ' days)';
  }
  /** The people who must hear about something waiting for Aakash: Aakash, plus Varun when Aakash is on leave today or there is no manager. */
  function deciders(ctx) {
    var day = today(ctx);
    var managers = byRole(ctx, 'manager'), here = managers.filter(function (m) {
      return !ctx.db.rows('LeaveRequests').some(function (r) { return r.personId === m.id && GRANTED[r.status] && r.dates.indexOf(day) !== -1; });
    });
    return here.length === managers.length && managers.length ? managers : managers.concat(byRole(ctx, 'owner'));
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
    if (!find(ctx, 'People', personId)) fail('NOT_FOUND', 'Choose a person.');
    if (typeof pin !== 'string' || !/^\d{4,6}$/.test(pin)) fail('BAD_PIN', 'PIN must be 4 to 6 digits.');
    var salt = ctx.env.randomId();
    ctx.db.update('People', personId, { pinSalt: salt, pinHash: ctx.env.sha256(salt + ':' + pin), pinTries: 0, pinLockedUntil: 0, pinLockLevel: 0 }); // a reset by the owner also clears what a stranger's guesses had built up
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
    var p = typeof personId === 'string' && typeof pin === 'string' ? find(ctx, 'People', personId) : null;
    if (!p || p.active === false) fail('LOGIN', 'Wrong name or PIN.');
    if (deviceToken !== undefined && deviceToken !== null && typeof deviceToken !== 'string') deviceToken = '';
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
    var label = String(deviceLabel || '').slice(0, 120);
    var everyPhone = ctx.db.rows('Devices');
    if (p.role === 'owner' && everyPhone.length === 1 && everyPhone[0].personId === personId && everyPhone[0].status === 'approved' && everyPhone[0].decidedBy === 'bootstrap' &&
      everyPhone[0].label === label && ctx.now - everyPhone[0].requestedAt < 15 * 60000) {
      var retry = ctx.env.randomId() + ctx.env.randomId();
      ctx.db.update('Devices', everyPhone[0].id, { tokenHash: ctx.env.sha256(retry) });
      audit(ctx, personId, 'device.first-sign-in-repeated', everyPhone[0].id);
      return { ok: true, deviceStatus: 'approved', deviceId: everyPhone[0].id, deviceToken: retry };
    }
    var same = ctx.db.rows('Devices').filter(function (d) { return d.personId === personId && d.status === 'pending' && d.label === label; })[0];
    if (same) {
      var again = ctx.env.randomId() + ctx.env.randomId();
      // Kept as one request, but never silently: the card says it was asked again, the approvers are told, Audit has a row.
      ctx.db.update('Devices', same.id, { tokenHash: ctx.env.sha256(again), decidedAt: ctx.now, decidedBy: 'asked-again' });
      audit(ctx, personId, 'device.asked-again', same.id, { label: label });
      (p.role === 'owner' ? byRole(ctx, 'manager') : byRole(ctx, 'owner')).forEach(function (o) {
        notify(ctx, o.id, 'device', 'Phone request repeated: ' + p.name, 'The sign-in was repeated; the request now belongs to the phone that asked last. Approve only after ' + p.name + ' confirms it is the phone in hand.', same.id);
      });
      return { ok: false, deviceStatus: 'pending', deviceId: same.id, deviceToken: again };
    }
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
    var dev = find(ctx, 'Devices', deviceId);
    var devOwner = dev && find(ctx, 'People', dev.personId);
    // The owner's own new phone (lost phone, cleared browser) is approved by the manager: the owner is signed in nowhere and cannot do it himself.
    var ownerRecovery = actor.role === 'manager' && approve && dev && dev.status === 'pending' && devOwner && devOwner.role === 'owner';
    if (actor.role !== 'owner' && !ownerRecovery) fail('FORBIDDEN', 'Only the owner can approve a phone.');
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
    if (ownerRecovery) byRole(ctx, 'owner').forEach(function (o) { notify(ctx, o.id, 'device', 'Owner phone approved by ' + actor.name, 'A new phone was approved for ' + devOwner.name + '. If this was not you, remove it under Phones and change your PIN.', deviceId); });
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
    if (typeof personId !== 'string' || typeof deviceToken !== 'string' || !deviceToken) fail('AUTH', 'Please sign in again.');
    if (!p || p.active === false) fail('AUTH', 'Please sign in again.');
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
  function rules(ctx) {
    var all = ctx.db.rows('Rules'), list = function (v) { return Array.isArray(v) ? v : null; };
    var good = all.filter(function (x) { return x && Array.isArray(x.members) && x.members.length >= 2; })
      .map(function (x) { return Object.assign({}, x, { emergencyIfAllPresent: list(x.emergencyIfAllPresent), rosterSundayException: list(x.rosterSundayException) }); });
    return all.length ? good : Clash.DEFAULT_RULES;
  }
  function restrictions(ctx) {
    return ctx.db.rows('Restrictions').filter(function (x) { return x && Cal.isDate(x.from) && Cal.isDate(x.to); })
      .map(function (x) { return Array.isArray(x.appliesTo) || x.appliesTo === null || x.appliesTo === undefined || x.appliesTo === '' ? x : Object.assign({}, x, { appliesTo: null }); });
  }

  /** Approved away entries of everyone except one request (by id). */
  function approvedAway(ctx, exceptId) {
    var names = {}; ctx.db.rows('People').forEach(function (p) { names[p.id] = p.name; });
    var out = [];
    ctx.db.rows('LeaveRequests').forEach(function (r) {
      if (r.id === exceptId) return;
      if (r.status !== 'Approved' && r.status !== 'Recorded') return;
      r.dates.forEach(function (d) { out.push({ person: names[r.personId], date: d, kind: r.kind, extreme: !!r.extremeEmergency }); });
    });
    var shutDays = closedSet(ctx);
    ctx.db.rows('DayMinutes').forEach(function (m) { if (m.minutes > 0 && !shutDays[m.date]) out.push({ person: names[m.personId], date: m.date, kind: m.kind }); }); // a row set to 0 (taken back, shop closed) is not time away
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
    var dates = (Array.isArray(input.dates) ? input.dates : []).filter(function (d) { return typeof d === 'string'; }).sort();
    if (!dates.length || !Array.isArray(input.dates) || dates.length !== input.dates.length) problems.push('Pick exact dates.');
    dates.forEach(function (d, i) {
      if (!Cal.isDate(d)) problems.push('Invalid date.');
      if (i && Cal.addDays(dates[i - 1], 1) !== d) problems.push('Dates in one request must be consecutive.');
    });
    if (input.kind !== 'full' && input.kind !== 'half') problems.push('Choose full day or half day.');
    if (input.kind === 'half' && (dates.length !== 1 || !Cal.isTime(input.halfStart))) problems.push('A half day is one date with a start time.');
    else if (input.kind === 'half' && (hhmmToMin(input.halfStart) < hhmmToMin(person.dutyStart) || hhmmToMin(input.halfStart) + HALF_DAY_MINUTES > hhmmToMin(person.dutyEnd)))
      problems.push('The half day (4 h 30 min) must be inside your duty hours.');
    if (REASONS.indexOf(input.reasonCode) === -1) problems.push('Choose a reason.');
    if (typeof input.reasonText !== 'string' || !input.reasonText.trim()) problems.push('Write the reason.');
    if (problems.length) return { decision: 'blocked', reasons: problems, valid: false };

    var lockedSet = lockedMonths(ctx);
    var hadDays = (opts && opts.had) || [];
    if (dates.some(function (d) { return lockedSet[Cal.monthKey(d)] && hadDays.indexOf(d) === -1; })) return { decision: 'blocked', reasons: ['This month is locked.'], valid: false };

    var others = liveLeaves(ctx, person.id, exceptId);
    var overlap = others.some(function (r) { return r.dates.some(function (d) { return dates.indexOf(d) !== -1; }); });
    if (overlap) return { decision: 'blocked', reasons: ['You already have a request on one of these dates. Edit or cancel it first.'], valid: false };

    // Notice runs from the SERVER time of sending to the person's duty start on the first leave day
    // (handoff 3.4), also for a half day. Nothing the phone sends can change that time; only an
    // entry by Aakash or Varun may carry the time of the phone call it records (opts.at).
    // The first LEAVE day: the person's own roster Sunday or a shop-closed day at the front of the request is not it.
    var shut = closedSet(ctx);
    var firstDay = dates.filter(function (d) { return !Cal.isRosterOff(person, d) && !shut[d]; })[0] || dates[0];
    var dutyStartAt = toMs(firstDay, person.dutyStart);
    var submittedAt = (opts && opts.at) || ctx.now;
    var noticeHours = (dutyStartAt - submittedAt) / 3600000;
    var type = Leave.noticeType(submittedAt, dutyStartAt);

    var people = peopleMap(ctx);
    var clash = Clash.checkRequest({ person: person.name, dates: dates, extremeEmergency: !!input.extremeEmergency }, people, approvedAway(ctx, exceptId), rules(ctx));
    var restr = Leave.checkRestrictions(person.name, person, dates, restrictions(ctx));

    var approvedDates = [];
    others.forEach(function (r) { if (r.kind === 'full') approvedDates = approvedDates.concat(r.dates); });
    var run = input.kind === 'full' ? Leave.runLength(person, dates, approvedDates) : 1;

    // Emergency number in the month of the first day.
    var month = Cal.monthKey(dates[0]);
    var closed = closedSet(ctx);
    var emergencyNo = 0;
    if (type === 'Emergency') {
      emergencyNo = 1 + others.filter(function (r) { return isEmergency(r, closed) && Cal.monthKey(r.dates[0]) === month; }).length;
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
      // "Always Aakash" (Anita): needs approval but no clash rule applies. Decided by the flags, never by how the group name is spelled.
      person: { noApproval: person.noApproval, isManager: person.role === 'manager', alwaysAakash: !!person.noClash && !person.noApproval },
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
    if (who && Cal.asOn(who, date).noApproval) return; // records only (intern) on that day: never a violation
    ctx.db.insert('Violations', { id: ctx.env.randomId(), personId: personId, date: date, rule: rule, source: 'auto', proof: ref,
      note: '', createdBy: 'system', createdAt: stamp(ctx), disputeState: '', disputeAt: '', disputeText: '', disputeDecidedBy: '', disputeDecidedAt: '' });
    byRole(ctx, 'owner').concat(byRole(ctx, 'manager')).forEach(function (m) { notify(ctx, m.id, 'violation', 'Violation recorded', (who ? who.name + ': ' : '') + ruleLabel(rule), ref); });
    notify(ctx, personId, 'violation', 'Violation recorded', ruleLabel(rule) + '. You can dispute it within 24 hours.', ref);
  }

  /** An emergency leave that counts: granted, and not only on days the shop was closed. */
  function isEmergency(r, closed) { return r.type === 'Emergency' && r.dates.some(function (d) { return !closed[d]; }); }
  /**
   * The granted emergencies of one person in one month, numbered in the order they were granted.
   * The 3rd and later carry the penalty (violation + day cut). Called whenever one is granted,
   * cancelled, shortened or falls on a day that became a closed day: the others are numbered again.
   */
  function renumberEmergencies(ctx, personId, month) {
    var closed = closedSet(ctx), who = find(ctx, 'People', personId), n = 0;
    ctx.db.rows('LeaveRequests').filter(function (x) { return x.personId === personId && x.type === 'Emergency' && Cal.monthKey(x.dates[0]) === month; })
      .sort(function (a, b) { return (a.decidedAt || 0) - (b.decidedAt || 0); })
      .forEach(function (x) {
        var counts = GRANTED[x.status] && isEmergency(x, closed);
        var no = counts ? ++n : 0, pen = counts && Leave.isPenaltyEmergency(no);
        if (GRANTED[x.status] && (no !== x.emergencyNo || pen !== !!x.penaltyEmergency)) ctx.db.update('LeaveRequests', x.id, { emergencyNo: no, penaltyEmergency: pen });
      });
  }

  function plainNote(note) { return String(note || '').replace(/( \| )?(No longer applies|Applies again|Recalculated after a correction|Applies again after a correction)/g, ''); }
  function removedByVarun(v) { return v.disputeState === 'removed' && /Dispute removed:/.test(v.note || ''); }
  /** A violation that no longer applies is marked removed (never deleted); the person and the owner are told. */
  function withdrawRow(ctx, v, why) {
    var note = plainNote(v.note);
    ctx.db.update('Violations', v.id, { disputeState: 'removed', note: (note ? note + ' | ' : '') + 'No longer applies' });
    toldWithdrawn(ctx, v, why);
  }
  /** It applies again: back as it was (upheld stays upheld, a dispute that was waiting waits again). Never when Varun removed it. */
  function reviveRow(ctx, v) {
    if (removedByVarun(v)) return false;
    var note = plainNote(v.note);
    var state = /Dispute upheld:/.test(note) ? 'upheld' : (v.disputeText && !v.disputeDecidedBy ? 'open' : '');
    ctx.db.update('Violations', v.id, { disputeState: state, note: (note ? note + ' | ' : '') + 'Applies again' });
    notify(ctx, v.personId, 'violation', 'Violation applies again', ruleLabel(v.rule) + ' (' + niceDates([v.date]) + '). The change that had withdrawn it was undone.', v.id);
    return true;
  }
  var MAX_REQUESTS_PER_DAY = 6;
  var LEAVE_RULES = { 'unannounced-leave': 1, 'emergency-beyond-2': 1, 'leave-in-restricted-period': 1, 'absent-no-request': 1 };
  /**
   * Keeps the violations that come from leave rows (unannounced, 3rd emergency, restricted period,
   * absent) in step with those rows AS THEY STAND NOW. It is called after every change to a leave:
   * grant, reject, cancel, shorten, edit, a closed day entered or removed, a rule change. So a
   * violation can never stay behind without its reason, or go missing while its reason stands.
   *  - A request that is waiting for a decision keeps what it has until it is decided.
   *  - A violation Varun removed after a dispute is never recorded again.
   *  - Nothing is deleted: a violation that no longer applies is marked removed, and comes back if it applies again.
   */
  function syncLeaveViolations(ctx, personId) {
    var who = find(ctx, 'People', personId);
    if (!who) return;
    var closed = closedSet(ctx), mine = ctx.db.rows('LeaveRequests').filter(function (r) { return r.personId === personId; });
    var months = {}; mine.forEach(function (r) { if (r.type === 'Emergency') months[Cal.monthKey(r.dates[0])] = 1; });
    Object.keys(months).forEach(function (m) { renumberEmergencies(ctx, personId, m); });
    var wanted = {}, waiting = {}, locked = lockedMonths(ctx);
    var firstOpen = function (dates) { for (var i = 0; i < dates.length; i++) if (!locked[Cal.monthKey(dates[i])] && !closed[dates[i]]) return dates[i]; return ''; };
    ctx.db.rows('LeaveRequests').forEach(function (r) {
      if (r.personId !== personId) return;
      if (OPEN[r.status]) { waiting[r.id] = 1; return; }
      if (who.role !== 'staff' && r.route === 'system') return;
      // Dated on the first day of the leave that is in an open month and not a closed day. No such day: nothing to record.
      var on = firstOpen(r.dates);
      if (!on || Cal.asOn(who, on).noApproval) return;
      if (r.status === ABSENT) { wanted[r.id + '|absent-no-request'] = on; return; }
      if (!GRANTED[r.status] || r.route === 'system' || r.route === 'override') return;
      if (r.type === 'Unannounced') wanted[r.id + '|unannounced-leave'] = on;
      if (r.penaltyEmergency) wanted[r.id + '|emergency-beyond-2'] = on;
      if (r.restrictionViolation) wanted[r.id + '|leave-in-restricted-period'] = on;
    });
    var byKey = {};
    var byVarun = removedByVarun;
    ctx.db.rows('Violations').forEach(function (v) {
      if (v.personId !== personId || !LEAVE_RULES[v.rule]) return;
      var key = v.proof + '|' + v.rule;
      // A waiting request keeps what it has. A violation of a LOCKED month is never touched again, whatever happens later.
      if (waiting[v.proof] || locked[Cal.monthKey(v.date)]) { delete wanted[key]; return; }
      (byKey[key] = byKey[key] || []).push(v);
    });
    // A 3rd-emergency violation Varun removed stays removed for that month, also when the numbering moves it to another request.
    var forgiven = {};
    Object.keys(byKey).forEach(function (key) {
      if (key.split('|')[1] !== 'emergency-beyond-2' || wanted[key]) return;
      byKey[key].forEach(function (v) { if (byVarun(v)) forgiven[Cal.monthKey(v.date)] = (forgiven[Cal.monthKey(v.date)] || 0) + 1; });
    });
    Object.keys(byKey).forEach(function (key) {
      var list = byKey[key], live = list.filter(function (v) { return v.disputeState !== 'removed'; });
      if (wanted[key]) {
        delete wanted[key];
        if (live.length) return;
        if (list.some(byVarun)) return; // removed by Varun after a dispute: never again
        reviveRow(ctx, list[0]);
        return;
      }
      live.forEach(function (v) { withdrawRow(ctx, v, 'It no longer applies'); });
    });
    Object.keys(wanted).sort().forEach(function (key) {
      var p = key.split('|'), m = Cal.monthKey(wanted[key]);
      if (p[1] === 'emergency-beyond-2' && forgiven[m] > 0) { forgiven[m] -= 1; return; }
      addViolation(ctx, personId, wanted[key], p[1], p[0]);
    });
  }

  /** Whoever was told "Violation recorded" is told when it is withdrawn again. */
  function toldWithdrawn(ctx, v, why) {
    var p = find(ctx, 'People', v.personId), day = (+v.date.slice(8)) + ' ' + MONTHS[+v.date.slice(5, 7) - 1];
    notify(ctx, v.personId, 'withdrawn', 'Violation withdrawn', ruleLabel(v.rule) + ' (' + day + '). ' + why + '.', v.id);
    byRole(ctx, 'owner').forEach(function (o) { notify(ctx, o.id, 'withdrawn', 'Violation withdrawn: ' + (p ? p.name : ''), ruleLabel(v.rule) + ' (' + day + '). ' + why + '.', v.id); });
  }

  /** Violations that came from a request are withdrawn (never deleted) when the request is edited or cancelled. */
  function withdrawViolations(ctx, leaveId, note) {
    ctx.db.rows('Violations').forEach(function (v) {
      if (v.proof !== leaveId || v.disputeState === 'removed') return;
      ctx.db.update('Violations', v.id, { disputeState: 'removed', note: note });
      toldWithdrawn(ctx, v, note);
    });
  }

  /** "Absent – unannounced" for one date (full day, or the half that no leave covers) + 1 violation. */
  function markAbsent(ctx, p, date, kind, why) {
    if (closedSet(ctx)[date] || lockedMonths(ctx)[Cal.monthKey(date)]) return null;
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
    // A "+1 violation" restriction counts as it stands NOW, at the moment the leave is granted.
    var who = find(ctx, 'People', r.personId);
    if (who && r.route !== 'override') {
      var rv = Leave.checkRestrictions(who.name, who, r.dates, restrictions(ctx)).violations > 0;
      if (rv !== !!r.restrictionViolation) { ctx.db.update('LeaveRequests', r.id, { restrictionViolation: rv }); r = Object.assign({}, r, { restrictionViolation: rv }); }
    }
    syncLeaveViolations(ctx, r.personId);
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
      // Nobody needs more than a few requests in one day; without a limit one phone could fill Aakash's alerts and the day's e-mails.
      var day0 = toMs(today(ctx), '00:00');
      if (actor.role === 'staff' && ctx.db.rows('LeaveRequests').filter(function (x) { return x.personId === personId && x.route !== 'system' && x.submittedAt >= day0; }).length >= MAX_REQUESTS_PER_DAY)
        fail('BLOCKED', 'You have sent ' + MAX_REQUESTS_PER_DAY + ' requests today. Ask Aakash to enter it for you.');
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
      if (row.route === 'aakash' || row.route === 'special') deciders(ctx).forEach(function (m) { if (row.route === 'special' && m.role === 'owner') return; notify(ctx, m.id, 'approval', 'Leave request', person.name + ': ' + niceDates(ev.dates), row.id); });
      if (row.route === 'varun' || row.route === 'special') byRole(ctx, 'owner').forEach(function (o) { notify(ctx, o.id, 'approval', row.route === 'special' ? 'Special approval' : 'Leave request', person.name + ': ' + niceDates(ev.dates), row.id); });
      notify(ctx, personId, 'decision', 'Leave: ' + row.status, niceDates(ev.dates), row.id);
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
      // A request that reaches into an open month can still be decided; the locked month keeps its locked result.
      if (r.dates.every(function (d) { return lockedMonths(ctx)[Cal.monthKey(d)]; })) assertOpen(ctx, r.dates);
      if (r.personId === actor.id) fail('FORBIDDEN', 'Nobody approves their own leave.');
      if (actor.role === 'staff') fail('FORBIDDEN', 'Only Aakash or Varun can decide.');
      var person = find(ctx, 'People', r.personId);
      if (r.route === 'varun' && actor.role !== 'owner') fail('FORBIDDEN', 'Only Varun can decide this.');
      if (!approve && !String(reason || '').trim()) fail('REASON', 'A reason is required to reject.');

      var hist = addHistory(r.history, [{ at: ctx.now, by: actor.id, action: approve ? 'approved' : 'rejected', reason: reason || '' }]);
      function finish(status, why) {
        ctx.db.update('LeaveRequests', id, { status: status, decidedAt: ctx.now, decidedBy: actor.id, decisionReason: why || '', history: hist });
        audit(ctx, actor.id, 'leave.decide', id, { status: status });
        notify(ctx, r.personId, 'decision', 'Leave: ' + status, niceDates(r.dates) + (why ? ' — ' + why : ''), id);
        // An edited request kept the violations of its old version until this decision.
        if (status === 'Approved') onGranted(ctx, Object.assign({}, r, { status: status }));
        else { syncLeaveViolations(ctx, r.personId); r.dates.forEach(function (d) { if (hooks.recountDay) hooks.recountDay(ctx, r.personId, d); }); }
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
      var restr = Leave.checkRestrictions(person.name, person, r.dates, restrictions(ctx));
      if (restr.blocked) fail('BLOCKED', restr.hits.filter(function (h) { return h.rule === 'no-leave'; })[0].message + ' Reject it, or Varun can override.');

      if (r.route === 'special') {
        // The run may have shrunk since it was sent (another piece was cancelled or rejected): then one approval is enough.
        var rest = [];
        liveLeaves(ctx, r.personId, id).forEach(function (x) { if (x.kind === 'full') rest = rest.concat(x.dates); });
        if (r.kind === 'full' && Leave.runLength(person, r.dates, rest) <= Leave.CFG.specialAboveDays) {
          ctx.db.update('LeaveRequests', id, { route: 'aakash' }); r = Object.assign({}, r, { route: 'aakash' });
        }
      }
      if (r.route === 'special') {
        var key = actor.role === 'owner' ? 'varun' : 'aakash';
        var approvals = Object.assign({}, r.approvals); approvals[key] = 'yes';
        // With no active manager (or owner) there is nobody to give the other yes: the one who exists decides.
        if (!byRole(ctx, 'manager').length) approvals.aakash = 'yes';
        if (!byRole(ctx, 'owner').length) approvals.varun = 'yes';
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
          if (h) notify(ctx, h.id, 'clash', 'A clashing request was rejected', person.name + ' asked for ' + niceDates(r.dates) + '. Your approved time off keeps the slot.', id);
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
      if (!r || r.status === 'Cancelled' || r.status.indexOf('Rejected') === 0) fail('NOT_FOUND', 'Nothing to cancel.');
      if (r.route === 'system') {
        // An absence the evening job recorded for someone who WAS at work (dead phone, app down): Aakash or Varun takes it back.
        if (actor.role === 'staff') fail('FORBIDDEN', 'Ask Aakash or Varun.');
        if (!String(reason || '').trim()) fail('REASON', 'A reason is required.');
        assertOpen(ctx, r.dates);
        ctx.db.update('LeaveRequests', id, { status: 'Cancelled', decisionReason: 'Absence taken back: ' + String(reason).trim(), decidedBy: actor.id, decidedAt: ctx.now,
          history: addHistory(r.history, [{ at: ctx.now, by: actor.id, action: 'absence taken back', reason: reason }]) });
        syncLeaveViolations(ctx, r.personId);
        audit(ctx, actor.id, 'absent.cancel', id, { reason: reason });
        notify(ctx, r.personId, 'decision', 'Absence taken back', niceDates(r.dates) + ' \u2014 ' + String(reason).trim(), id);
        return { id: id, status: 'Cancelled' };
      }
      var person = find(ctx, 'People', r.personId);
      var started = ctx.now >= toMs(r.dates[0], r.kind === 'half' ? r.halfStart : person.dutyStart);
      var isBoss = actor.role !== 'staff';
      if (actor.id !== r.personId && !isBoss) fail('FORBIDDEN', 'You can cancel only your own request.');
      if (started && !isBoss) fail('FORBIDDEN', 'This leave has started. Ask Aakash or Varun.');
      if (isBoss && actor.id !== r.personId && !String(reason || '').trim()) fail('REASON', 'A reason is required.');
      var month = Cal.monthKey(r.dates[0]), allDates = r.dates.slice();
      // Days that stay as leave: past days on which the person was really away, and today too when duty
      // has begun and the person has not come in (cancelling "the rest" at noon does not make today an absence).
      var now = today(ctx);
      var gone = started && GRANTED[r.status] ? r.dates.filter(function (d) {
        if (hasCheckIn(ctx, r.personId, d)) return false;
        return d < now || (d === now && ctx.now >= toMs(d, person.dutyStart));
      }) : [];
      // Ended on its last day: the days before today were taken and stay; today is given back (the person is coming in).
      if (gone.length === r.dates.length && r.dates.length > 1 && r.dates.indexOf(now) !== -1) gone = gone.filter(function (d) { return d < now; });
      // Only the days that are given back must lie in an open month.
      var kept = gone.length && gone.length < r.dates.length ? gone : [];
      if (r.route === 'system') kept = [];
      var freed = r.dates.filter(function (d) { return kept.indexOf(d) === -1; });
      // A waiting request that reaches into an open month can always be closed. A granted one gives back only days of an open month.
      if (GRANTED[r.status] || freed.every(function (d) { return lockedMonths(ctx)[Cal.monthKey(d)]; })) assertOpen(ctx, freed);
      // A leave that is still running is shortened. One that is completely over is cancelled as a whole (a correction by Aakash or Varun).
      if (gone.length && gone.length < r.dates.length) {
        // The leave has started: the days already taken stay as leave; only the days from today on are given back.
        ctx.db.update('LeaveRequests', id, { dates: gone, run: gone.length, restrictionViolation: !!r.restrictionViolation && Leave.checkRestrictions(person.name, person, gone, restrictions(ctx)).violations > 0, history: addHistory(r.history, [{ at: ctx.now, by: actor.id, action: 'shortened', from: { dates: r.dates }, reason: reason || '' }]) });
        syncLeaveViolations(ctx, r.personId);
        allDates.forEach(function (d) { if (hooks.recountDay) hooks.recountDay(ctx, r.personId, d); });
        audit(ctx, actor.id, 'leave.shorten', id, { reason: reason || '', dates: gone });
        if (actor.id !== r.personId) notify(ctx, r.personId, 'decision', 'Leave shortened', niceDates(gone) + ' stays as leave \u2014 ' + reason, id);
        return { id: id, status: r.status, dates: gone };
      }
      ctx.db.update('LeaveRequests', id, { status: 'Cancelled', history: addHistory(r.history, [{ at: ctx.now, by: actor.id, action: 'cancelled', reason: reason || '' }]) });
      syncLeaveViolations(ctx, r.personId);
      // The person may have come in on a day of this leave: that day's late / early minutes count now.
      allDates.forEach(function (d) { if (hooks.recountDay) hooks.recountDay(ctx, r.personId, d); });
      audit(ctx, actor.id, 'leave.cancel', id, { reason: reason || '' });
      if (actor.id !== r.personId) notify(ctx, r.personId, 'decision', 'Leave cancelled', niceDates(r.dates) + ' — ' + reason, id);
      return { id: id, status: 'Cancelled' };
    });
  }

  var api = { REASONS: REASONS, setPin: setPin, login: login, decideDevice: decideDevice, authenticate: authenticate,
    signOut: signOut, previewLeave: previewLeave, submitLeave: submitLeave, decideLeave: decideLeave, cancelLeave: cancelLeave, toMs: toMs,
    _: { withdrawRow: withdrawRow, reviveRow: reviveRow, removedByVarun: removedByVarun, restrictions: restrictions, rules: rules, syncLeaveViolations: syncLeaveViolations, hist: addHistory, MAX_EDITS: MAX_EDITS, toldWithdrawn: toldWithdrawn, addDays: Cal.addDays, deciders: deciders, isEmergency: isEmergency, renumberEmergencies: renumberEmergencies, niceDates: niceDates, hooks: hooks, lockedMonths: lockedMonths, assertOpen: assertOpen, stamp: stamp, fail: fail, failKeep: failKeep, closedSet: closedSet, autoDays: autoDays, markAbsent: markAbsent, hasCheckIn: hasCheckIn, dayOver: dayOver,
      withdrawViolations: withdrawViolations, GRANTED: GRANTED, ABSENT: ABSENT, HALF_DAY_MINUTES: HALF_DAY_MINUTES, settingValue: settingValue, hhmmToMin: hhmmToMin, find: find, audit: audit, notify: notify, byRole: byRole, today: today, peopleMap: peopleMap, rules: rules,
      approvedAway: approvedAway, liveLeaves: liveLeaves, IST_OFFSET_MS: IST_OFFSET_MS,
      evaluate: evaluate, onGranted: onGranted, ruleLabel: ruleLabel, STATUS_FOR: STATUS_FOR, OPEN: OPEN } };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.GJCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
