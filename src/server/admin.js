/**
 * Management actions: manual violations with the grace table, disputes, editing a leave,
 * the owner's override, and Settings (people, pay, rules, restrictions, shop point).
 * Every change is written to the Audit tab.
 */
(function (root) {
  'use strict';
  var req = (typeof require !== 'undefined') ? require : null;
  var Cal = req ? req('../rules/calendar.js') : root.GJCalendar;
  var Leave = req ? req('../rules/leave.js') : root.GJLeave;
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
  function graceTable(ctx) {
    try { var t = JSON.parse(setting(ctx, 'graceTable') || 'null'); return Array.isArray(t) && t.length && t.every(function (g) { return g && typeof g.key === 'string' && typeof g.item === 'string'; }) ? t : DEFAULT_GRACE; }
    catch (e) { return DEFAULT_GRACE; }
  }
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
      // Varun may decide a dispute also after the month is locked: the locked report stays as it was locked.
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
      // Days of a locked month that the request already has may stay; only what changes must lie in an open month.
      if (r.dates.every(function (d) { return H.lockedMonths(ctx)[Cal.monthKey(d)]; })) H.assertOpen(ctx, r.dates);
      var newDates = Array.isArray(input.dates) ? input.dates : [];
      if (newDates.length && newDates.every(function (d) { return Cal.isDate(d) && H.lockedMonths(ctx)[Cal.monthKey(d)]; })) H.fail('BLOCKED', 'Those days are in a locked month. To give back the days of the open month, use "End this leave" or Cancel.');
      H.assertOpen(ctx, r.dates.filter(function (d) { return newDates.indexOf(d) === -1; }).concat(newDates.filter(function (d) { return r.dates.indexOf(d) === -1; })));
      // A request can be changed a limited number of times; after that it is cancelled and sent again.
      if (r.history.filter(function (x) { return x && x.action === 'edited'; }).length >= H.MAX_EDITS && actor.role === 'staff') H.fail('BLOCKED', 'This request has been changed ' + H.MAX_EDITS + ' times. Cancel it and send a new one.');
      var person = H.find(ctx, 'People', r.personId);
      if (ctx.now >= Core.toMs(r.dates[0], r.kind === 'half' ? r.halfStart : person.dutyStart) && actor.role === 'staff') H.fail('FORBIDDEN', 'This leave has started. Ask Aakash or Varun.');
      // A recorded phone call keeps its time when Aakash or Varun corrects the entry for the same first day.
      // The notice for the first day was given when the request was first sent (or when the recorded call was made).
      // Changing the end, the reason or the kind does not make that day a late request.
      var sameStart = Array.isArray(input.dates) && input.dates.slice().sort()[0] === r.dates[0];
      var keep = sameStart ? { at: r.noticeAt || r.submittedAt, had: r.dates } : { had: r.dates };
      var ev = H.requestLimit(ctx, person, actor, H.evaluate(ctx, person, input, id, keep), id);
      if (ev.decision === 'blocked') H.fail('BLOCKED', ev.reasons.join(' '));
      // Handoff Part 6: an edit after approval goes back to pending. It is never approved again by the system.
      if (r.status === 'Approved' && ev.decision === 'auto') { ev.decision = 'aakash'; ev.reasons = ['Edited after approval.']; }
      // Violations that came from the old version are withdrawn; the new version earns its own.
      var patch = { kind: input.kind, dates: ev.dates, halfStart: input.halfStart || '', reasonCode: input.reasonCode, reasonText: String(input.reasonText).trim(),
        submittedAt: ctx.now, noticeAt: keep.at || '', type: ev.type, noticeHours: ev.noticeHours, run: ev.run, route: ev.decision, status: H.STATUS_FOR[ev.decision],
        approvals: ev.decision === 'special' ? { aakash: '', varun: '' } : {}, extremeEmergency: !!input.extremeEmergency, emergencyNo: ev.emergencyNo,
        penaltyEmergency: ev.penaltyEmergency, restrictionViolation: ev.restrictionViolation, decidedAt: '', decidedBy: '', decisionReason: '',
        history: H.hist(r.history, [{ at: ctx.now, by: actor.id, action: 'edited', from: { first: r.dates[0], last: r.dates[r.dates.length - 1], days: r.dates.length, kind: r.kind, status: r.status } }]) };
      if (ev.decision === 'auto' || ev.decision === 'recorded') { patch.decidedAt = ctx.now; patch.decidedBy = 'system'; }
      var oldDates = r.dates.slice();
      ctx.db.update('LeaveRequests', id, patch);
      // The violations of the old version stand until the new version is decided (granted now, or by Aakash later).
      if (patch.status === 'Approved' || patch.status === 'Recorded') H.onGranted(ctx, Object.assign({}, r, patch));
      else H.syncLeaveViolations(ctx, r.personId);
      oldDates.concat(ev.dates).forEach(function (d) { if (H.hooks.recountDay) H.hooks.recountDay(ctx, r.personId, d); });
      if (ev.decision === 'aakash' || ev.decision === 'special') H.byRole(ctx, 'manager').forEach(function (m) { H.notify(ctx, m.id, 'approval', 'Leave request edited', person.name + ': ' + H.niceDates(ev.dates), id); });
      if (ev.decision === 'varun' || ev.decision === 'special') H.byRole(ctx, 'owner').forEach(function (o) { H.notify(ctx, o.id, 'approval', 'Leave request edited', person.name + ': ' + H.niceDates(ev.dates), id); });
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
      var dates = (Array.isArray(input.dates) ? input.dates : []).filter(function (d, i, a) { return a.indexOf(d) === i; }).sort();
      if (!dates.length || !/^(full|half)$/.test(input.kind) || !dates.every(Cal.isDate)) H.fail('BLOCKED', 'Pick exact dates.');
      if (dates.some(function (d, i) { return i && Cal.addDays(dates[i - 1], 1) !== d; })) H.fail('BLOCKED', 'Dates in one request must be consecutive.');
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
      // The person may already have come in on one of these days: nothing is counted on a full-leave day.
      H.syncLeaveViolations(ctx, person.id);
      dates.forEach(function (d) { if (H.hooks.recountDay) H.hooks.recountDay(ctx, person.id, d); });
      H.audit(ctx, actor.id, 'leave.override', row.id, { reason: row.override, dates: dates });
      H.notify(ctx, person.id, 'decision', 'Leave: Approved', H.niceDates(dates), row.id);
      H.byRole(ctx, 'manager').forEach(function (m) { H.notify(ctx, m.id, 'override', 'Override by Varun', person.name + ': ' + H.niceDates(dates), row.id); });
      return { id: row.id, status: 'Approved' };
    });
  }

  // ---------- Settings ----------

  var PERSON_FIELDS = ['name', 'group', 'role', 'dutyStart', 'dutyEnd', 'sundayOff', 'noApproval', 'noClash', 'noQuota', 'dressExempt', 'active', 'email', 'phone'];
  function flag(v, name) { if (!(v === true || v === false || v === '' || v === undefined)) H.fail('BLOCKED', name + ' must be yes or no.'); }
  function validPerson(p) {
    ['noApproval', 'noClash', 'noQuota', 'dressExempt', 'active'].forEach(function (f) { flag(p[f], f); });
    if (typeof p.name !== 'string' || typeof p.group !== 'string' && p.group !== undefined) H.fail('BLOCKED', 'Name and group must be text.');
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
        // The roster and the active state as they were until yesterday are kept, so days already gone are
        // never judged again by what Settings say from today on.
        var changed = JSON.stringify(existing.sundayOff) !== JSON.stringify(clean.sundayOff) || (existing.active !== false) !== (clean.active !== false) || !!existing.noApproval !== !!clean.noApproval;
        var hours = existing.dutyStart !== clean.dutyStart || existing.dutyEnd !== clean.dutyEnd;
        if (hours) changed = true;
        if (changed) {
          // New duty hours apply from tomorrow (today's arrival is judged by the hours of this morning); the other changes from today.
          var past = Array.isArray(existing.history) ? existing.history.slice() : [], until = hours ? H.today(ctx) : Cal.addDays(H.today(ctx), -1);
          var yest = Cal.addDays(H.today(ctx), -1), old = { sundayOff: existing.sundayOff, active: existing.active !== false, noApproval: !!existing.noApproval, dutyStart: existing.dutyStart, dutyEnd: existing.dutyEnd };
          if (!past.length || past[past.length - 1].until < yest) past.push(Object.assign({ until: yest }, old));
          // Today: the new roster / records-only / active already apply, the old duty hours still do (they change from tomorrow).
          if (hours && (!past.length || past[past.length - 1].until < until)) past.push(Object.assign({ until: until }, old, { sundayOff: clean.sundayOff, active: clean.active !== false, noApproval: !!clean.noApproval }));
          clean.history = past;
        }
        var before = {}; PERSON_FIELDS.forEach(function (f) { before[f] = existing[f]; });
        ctx.db.update('People', p.id, clean);
        H.audit(ctx, actor.id, 'people.update', p.id, { before: before, after: clean });
        // The change applies from today: today is counted again now, not at the person's next tap.
        if (changed) {
          if (H.hooks.recountDay) H.hooks.recountDay(ctx, p.id, H.today(ctx));
          H.syncLeaveViolations(ctx, p.id);
          if (H.hooks.syncViolations) H.hooks.syncViolations(ctx, p.id, Cal.monthKey(H.today(ctx)));
        }
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

  /**
   * Handoff 3.3: when a rule is added or switched on later, a leave that now clashes is marked
   * "Rejected – clash": the one approved LAST gives way, the first approved keeps the slot. Only days
   * from today on, never Varun's overrides. Both people, Aakash and Varun are told.
   */
  function recheckClashes(ctx, actor) {
    var Clash = (typeof require !== 'undefined') ? require('../rules/clash.js') : root.GJClash;
    var today = H.today(ctx), out = [], again = [];
    ctx.db.rows('LeaveRequests').filter(function (r) { return r.status === 'Approved' && r.route !== 'override' && r.route !== 'system' && r.dates.some(function (d) { return d >= today; }); })
      .sort(function (a, b) { return (b.decidedAt || 0) - (a.decidedAt || 0); })
      .forEach(function (r) {
        var person = H.find(ctx, 'People', r.personId);
        if (!person) return;
        var clash = Clash.checkRequest({ person: person.name, dates: r.dates.filter(function (d) { return d >= today; }), extremeEmergency: r.extremeEmergency }, H.peopleMap(ctx), H.approvedAway(ctx, r.id), H.rules(ctx));
        if (clash.ok) return;
        // Days of this leave that are already over were taken as approved leave and stay so: only the days from today on are given back.
        var taken = r.dates.filter(function (d) { return d < today; }), was = r.dates.slice(), back = was.filter(function (d) { return d >= today; });
        if (taken.length) ctx.db.update('LeaveRequests', r.id, { dates: taken, run: taken.length, restrictionViolation: !!r.restrictionViolation && Leave.checkRestrictions(person.name, person, taken, H.restrictions(ctx)).violations > 0,
          history: H.hist(r.history, [{ at: ctx.now, by: actor.id, action: 'shortened – clash (rule changed)', from: { dates: r.dates } }]) });
        else ctx.db.update('LeaveRequests', r.id, { status: 'Rejected – clash', decisionReason: clash.blocks[0].message, decidedAt: ctx.now, decidedBy: 'system',
          history: H.hist(r.history, [{ at: ctx.now, by: actor.id, action: 'rejected – clash (rule changed)' }]) });
        H.syncLeaveViolations(ctx, r.personId);
        again.push([r.personId, was]);
        H.notify(ctx, r.personId, 'clash', 'Leave: Rejected – clash', H.niceDates(back) + ' \u2014 a clash rule was changed. ' + clash.blocks[0].message, r.id);
        H.byRole(ctx, 'manager').concat(H.byRole(ctx, 'owner')).forEach(function (m) { H.notify(ctx, m.id, 'clash', 'Rejected – clash', person.name + ': ' + clash.blocks[0].message, r.id); });
        var holders = {}; clash.blocks.forEach(function (b) { (b.who || []).forEach(function (w) { holders[w] = 1; }); });
        Object.keys(holders).forEach(function (name) { var h = H.peopleMap(ctx)[name]; if (h) H.notify(ctx, h.id, 'clash', 'A clashing leave was rejected', person.name + ' had ' + H.niceDates(back) + '. Your approved time off keeps the slot.', r.id); });
        out.push(r.id);
      });
    // Days given back are counted again only now: minutes booked here must not decide the next leave in this same check.
    again.forEach(function (x) { x[1].forEach(function (d) { if (H.hooks.recountDay) H.hooks.recountDay(ctx, x[0], d); }); });
    return out;
  }
  function saveRule(ctx, actor, r) {
    return ctx.env.withLock(function () {
      owner(actor);
      var names = ctx.db.rows('People').map(function (p) { return p.name; });
      if (!Array.isArray(r.members) || r.members.length < 2 || !r.members.every(function (m) { return names.indexOf(m) !== -1; })) H.fail('BLOCKED', 'Choose at least 2 people.');
      if (!(r.minPresent >= 1 && r.minPresent < r.members.length)) H.fail('BLOCKED', 'Minimum present must be between 1 and one less than the group size.');
      var e = r.emergencyIfAllPresent, x = r.rosterSundayException;
      if (!(e === null || e === undefined || e === '' || (Array.isArray(e) && e.every(function (m) { return names.indexOf(m) !== -1; })))) H.fail('BLOCKED', 'The extreme-emergency list must be people from the list.');
      if (!(x === null || x === undefined || x === '' || (Array.isArray(x) && x.every(function (n) { return n >= 1 && n <= 5; })))) H.fail('BLOCKED', 'The Sunday exception must be Sunday numbers 1 to 5.');
      var clean = { on: r.on !== false, label: String(r.label || '').trim() || r.id, members: r.members, minPresent: +r.minPresent,
        rosterSundayException: r.rosterSundayException || null, emergencyIfAllPresent: r.emergencyIfAllPresent || null };
      if (r.id && H.find(ctx, 'Rules', r.id)) { ctx.db.update('Rules', r.id, clean); H.audit(ctx, actor.id, 'rules.update', r.id, clean); return { id: r.id, rejected: recheckClashes(ctx, actor) }; }
      var id = 'C' + (ctx.db.rows('Rules').length + 1) + '-' + ctx.env.randomId().slice(0, 3);
      ctx.db.insert('Rules', Object.assign({ id: id }, clean));
      H.audit(ctx, actor.id, 'rules.create', id, clean);
      return { id: id, rejected: recheckClashes(ctx, actor) };
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
      var usual = ctx.db.rows('People').filter(function (p) { return p.active !== false && p.role === 'staff' && !p.noClash; }).map(function (p) { return p.name; }).sort();
      var list = Array.isArray(r.appliesTo) && r.appliesTo.length ? r.appliesTo.slice().sort() : null;
      // The usual ticks (everyone except Anita and Muskan) are stored as "the default", so a person who joins later is covered too.
      if (list && JSON.stringify(list) === JSON.stringify(usual)) list = null;
      var clean = { from: r.from, to: r.to, note: String(r.note).trim(), rule: r.rule, appliesTo: list, on: r.on !== false };
      if (old) { ctx.db.update('Restrictions', r.id, clean); H.audit(ctx, actor.id, 'restrictions.update', r.id, clean); return { id: r.id }; }
      // The same new restriction sent twice (a retry) is one restriction.
      var twin = ctx.db.rows('Restrictions').filter(function (x) { return x.from === clean.from && x.to === clean.to && x.note === clean.note && x.rule === clean.rule && x.on !== false && JSON.stringify(x.appliesTo || null) === JSON.stringify(clean.appliesTo); })[0];
      if (twin) return { id: twin.id, repeated: true };
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
      var changedDays = [];
      if (key === 'closedDays') { var was = H.closedSet(ctx); changedDays = value.filter(function (d) { return !was[d]; }).concat(Object.keys(was).filter(function (d) { return value.indexOf(d) === -1; })); }
      if (key === 'graceTable') {
        if (!(Array.isArray(value) && value.length && value.length <= 40 && value.every(function (g) {
          return g && typeof g === 'object' && typeof g.item === 'string' && g.item.trim() && typeof g.key === 'string' && /^[a-z0-9-]{1,40}$/.test(g.key) && (g.per === 'month' || g.per === 'quarter');
        }))) H.fail('BLOCKED', 'The grace table is not valid.');
        if (!value.every(function (g) { return typeof g.grace === 'number' && g.grace >= 0 && g.grace <= 31 && Math.floor(g.grace) === g.grace; })) H.fail('BLOCKED', 'Grace must be a whole number from 0 to 31.');
      }
      putSetting(ctx, actor, key, value);
      // Closed days are never written into the rows: everything is counted again from the rows as they
      // are, with the closed days left out. So a closed day entered by mistake can simply be removed again.
      if (key === 'closedDays') {
        ctx.db.rows('People').forEach(function (p) {
          changedDays.forEach(function (d) { if (H.hooks.recountDay) H.hooks.recountDay(ctx, p.id, d); });
          H.syncLeaveViolations(ctx, p.id);
          var months = {}; changedDays.forEach(function (d) { months[Cal.monthKey(d)] = 1; });
          Object.keys(months).forEach(function (m) { if (H.hooks.syncViolations) H.hooks.syncViolations(ctx, p.id, m); });
        });
        // A day that is a working day again and is already over: its absent check runs now (the nightly job only looks 3 days back).
        var start = setting(ctx, 'startDate');
        changedDays.forEach(function (d) { if (value.indexOf(d) === -1 && d < H.today(ctx) && (!start || d >= start) && H.hooks.endOfDay) H.hooks.endOfDay(ctx, d); });
      }
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
