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
    requestShort: function (ctx, actor, a) { return Att.requestShort(ctx, actor, a); },
    checkIn: function (ctx, actor, a) { return Att.checkIn(ctx, actor, a); },
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
