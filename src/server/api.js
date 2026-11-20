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
  var Admin = (typeof require !== 'undefined') ? require('./admin.js') : root.GJAdmin;
  var Views = (typeof require !== 'undefined') ? require('./views.js') : root.GJViews;

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
      var shop = ctx.db.rows('Settings').filter(function (x) { return x.key === 'shopPoint'; })[0], point = null;
      try { if (shop) { var sp = JSON.parse(shop.value); point = { lat: sp.lat, lng: sp.lng }; } } catch (e) { point = null; }
      return { id: p.id, name: p.name, role: p.role, group: p.group, dutyStart: p.dutyStart, dutyEnd: p.dutyEnd, reasons: Core.REASONS,
        dressExempt: !!p.dressExempt, deviceShort: String(actor.deviceId || '').slice(-4), shopPoint: point, serverTime: ctx.now };
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
    effect: function (ctx, actor, a) {
      // Live preview for late / early / going out, shown before the request is sent.
      var me = ctx.db.rows('People').filter(function (x) { return x.id === actor.id; })[0], minutes = +a.minutes;
      if (a.kind !== 'out' && /^\d{2}:\d{2}$/.test(a.time || '')) {
        var t = +a.time.slice(0, 2) * 60 + +a.time.slice(3), s = +me.dutyStart.slice(0, 2) * 60 + +me.dutyStart.slice(3), e = +me.dutyEnd.slice(0, 2) * 60 + +me.dutyEnd.slice(3);
        minutes = a.kind === 'late' ? t - s : e - t;
      }
      if (!(minutes > 0)) return { counted: 0, lines: [] };
      return Att.effectOf(ctx, actor.id, a.kind, minutes, a.date);
    },
    decideShort: function (ctx, actor, a) { return Att.decideShort(ctx, actor, a.id, !!a.approve, a.reason); },
    checkIn: function (ctx, actor, a) {
      // a = what PREPARE.checkIn made of the phone's request. Inside the server lock, on fresh data:
      // a second copy of the same check-in (a retry, a second tab) is refused here.
      var result = Att.checkIn(ctx, actor, { lat: a.lat, lng: a.lng, accuracy: a.accuracy, dress: a.dress, photoId: a.photoId, thumbId: a.thumbId });
      ctx.db.insert('Thumbs', { id: a.thumbId, personId: actor.id, date: Core._.today(ctx), data: a.thumb });
      return result;
    },
    photo: function (ctx, actor, a) {
      var p = ctx.db.rows('Punches').filter(function (x) { return x.photoId === a.id || x.thumbId === a.id; })[0];
      if (!p) throw err('NOT_FOUND', 'No such photo.');
      var isThumbToday = p.thumbId === a.id && p.date === Core._.today(ctx);   // "Today at GJ": everyone
      if (!(isThumbToday || actor.role !== 'staff' || p.personId === actor.id)) throw err('FORBIDDEN', 'You cannot see this photo.');
      if (p.thumbId === a.id) {
        var th = ctx.db.tail('Thumbs', 80).filter(function (x) { return x.id === a.id; })[0]; // recent thumbnails only
        if (th) return { data: th.data };
        return { data: ctx.env.readPhoto(p.photoId) }; // older than the recent rows: fall back to the photo itself
      }
      return { data: ctx.env.readPhoto(a.id) };
    },
    decideDress: function (ctx, actor, a) { return Att.decideDress(ctx, actor, a.id, !!a.confirm, Admin.recordIncident); },
    manualCheckIn: function (ctx, actor, a) { return Att.manualCheckIn(ctx, actor, a); },
    manualCheckOut: function (ctx, actor, a) { return Att.manualCheckOut(ctx, actor, a); },
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
    today: function (ctx, actor) {
      var date = Core._.today(ctx);
      var mine = function (tab) { return ctx.db.rows(tab).filter(function (r) { return r.personId === actor.id && r.date === date; }); };
      var punches = mine('Punches');
      var pick = function (kind) { var p = punches.filter(function (x) { return x.kind === kind; })[0]; return p ? { at: p.at, flag: p.flag } : null; };
      var outing = mine('Outings').filter(function (o) { return o.status === 'Pending' || o.status === 'Approved' || o.status === 'Back'; })[0];
      return { date: date, serverTime: ctx.now, hints: Att.hints(ctx, actor.id), checkIn: pick('in'), checkOut: pick('out'),
        outing: outing ? { id: outing.id, status: outing.status, reason: outing.reason, approvedAt: outing.approvedAt, backAt: outing.backAt, minutes: outing.minutes } : null,
        shorts: mine('ShortRequests').filter(function (q) { return q.status === 'Pending' || q.status === 'Approved' || q.status === 'Rejected'; })
          .map(function (q) { return { id: q.id, kind: q.kind, time: q.time, status: q.status, decisionReason: q.decisionReason }; }) };
    },
    approvals: function (ctx, actor) {
      if (actor.role === 'staff') throw err('FORBIDDEN', 'Only Aakash or Varun.');
      var names = nameMap(ctx);
      var out = {
        leaves: ctx.db.rows('LeaveRequests').filter(function (r) { return /^(Pending|Special)/.test(r.status); }).map(function (r) { return leaveView(r, names, actor); }),
        absences: ctx.db.rows('LeaveRequests').filter(function (r) { return r.status === 'Absent \u2013 unannounced'; }).map(function (r) { return { id: r.id, name: names[r.personId], dates: r.dates }; }),
        outings: ctx.db.rows('Outings').filter(function (o) { return o.status === 'Pending' || o.status === 'Back'; }).map(function (o) {
          return { id: o.id, name: names[o.personId], status: o.status, reason: o.reason, expectedMinutes: o.expectedMinutes, requestedAt: o.requestedAt, approvedAt: o.approvedAt, backAt: o.backAt, minutes: o.minutes };
        }),
        // Out right now: if the person never taps "I'm back", Aakash closes it with the real time.
        outNow: ctx.db.rows('Outings').filter(function (o) { return o.status === 'Approved'; }).map(function (o) {
          return { id: o.id, name: names[o.personId], date: o.date, reason: o.reason, expectedMinutes: o.expectedMinutes, approvedAt: o.approvedAt };
        }),
        shorts: ctx.db.rows('ShortRequests').filter(function (q) { return q.status === 'Pending'; })
          .map(function (q) { return { id: q.id, name: names[q.personId], kind: q.kind, date: q.date, time: q.time, submittedAt: q.submittedAt }; }),
        dress: ctx.db.rows('Punches').filter(function (x) { return x.dress && !x.dressDecision && Att.dressIssues(x.dress).length; })
          .map(function (x) { return { id: x.id, name: names[x.personId], date: x.date, issues: Att.dressIssues(x.dress), belt: x.dress.belt, photoId: x.photoId }; }),
        devices: []
      };
      if (actor.role === 'owner') out.devices = ctx.db.rows('Devices').filter(function (d) { return d.status === 'pending'; })
        .map(function (d) { return { id: d.id, name: names[d.personId], label: d.label, requestedAt: d.requestedAt }; });
      return out;
    },
    // management
    recordIncident: function (ctx, actor, a) { return Admin.recordIncident(ctx, actor, a); },
    incidentItems: function (ctx, actor) {
      if (actor.role === 'staff') throw err('FORBIDDEN', 'Only Aakash or Varun.');
      return { items: Admin.graceTable(ctx), people: ctx.db.rows('People').filter(function (p) { return p.active !== false && p.role === 'staff'; }).map(function (p) { return { id: p.id, name: p.name }; }) };
    },
    disputeViolation: function (ctx, actor, a) { return Admin.disputeViolation(ctx, actor, a.id, a.text); },
    decideDispute: function (ctx, actor, a) { return Admin.decideDispute(ctx, actor, a.id, !!a.uphold, a.note); },
    disputes: function (ctx, actor) {
      if (actor.role !== 'owner') throw err('FORBIDDEN', 'Only the owner.');
      var names = nameMap(ctx);
      return ctx.db.rows('Violations').filter(function (v) { return v.disputeState === 'open'; })
        .map(function (v) { return { id: v.id, name: names[v.personId], date: v.date, rule: v.rule, note: v.note, text: v.disputeText, disputeAt: v.disputeAt }; });
    },
    editLeave: function (ctx, actor, a) { return Admin.editLeave(ctx, actor, a.id, a); },
    overrideLeave: function (ctx, actor, a) { return Admin.overrideLeave(ctx, actor, a); },
    getSettings: function (ctx, actor) { return Admin.getSettings(ctx, actor); },
    savePerson: function (ctx, actor, a) { return Admin.savePerson(ctx, actor, a); },
    setPay: function (ctx, actor, a) { return Admin.setPay(ctx, actor, a); },
    saveRule: function (ctx, actor, a) { return Admin.saveRule(ctx, actor, a); },
    saveRestriction: function (ctx, actor, a) { return Admin.saveRestriction(ctx, actor, a); },
    restrictions: function (ctx, actor) {
      if (actor.role === 'staff') throw err('FORBIDDEN', 'Only Aakash or Varun.');
      return { list: ctx.db.rows('Restrictions'), people: ctx.db.rows('People').filter(function (p) { return p.active !== false && p.role === 'staff'; }).map(function (p) { return p.name; }) };
    },
    setSetting: function (ctx, actor, a) { return Admin.setSetting(ctx, actor, a.key, a.value); },
    setShopPoint: function (ctx, actor, a) { return Admin.setShopPoint(ctx, actor, a.samples); },
    board: function (ctx, actor) { return Views.board(ctx, actor); },
    todayAtGJ: function (ctx) { return Views.todayAtGJ(ctx); },
    calendar: function (ctx, actor, a) { return Views.calendar(ctx, actor, a.month); },
    myRestrictions: function (ctx, actor) { return Views.myRestrictions(ctx, actor); },
    monthReport: function (ctx, actor, a) { return Views.monthReport(ctx, actor, a.month); },
    lockMonth: function (ctx, actor, a) { return Views.lockMonth(ctx, actor, a.month); },
    addCorrection: function (ctx, actor, a) { return Views.addCorrection(ctx, actor, a.month, a.personId, a.note); },
    setPin: function (ctx, actor, a) { return Core.setPin(ctx, actor, a.personId, a.pin); },
    devices: function (ctx, actor) {
      if (actor.role !== 'owner') throw err('FORBIDDEN', 'Only the owner.');
      var names = nameMap(ctx);
      return ctx.db.rows('Devices').map(function (d) { return { id: d.id, name: names[d.personId], label: d.label, status: d.status, requestedAt: d.requestedAt, decidedAt: d.decidedAt }; });
    },
    decideDevice: function (ctx, actor, a) { return Core.decideDevice(ctx, actor, a.id, !!a.approve); },
    notifications: function (ctx, actor) {
      return ctx.db.rows('Notifications').filter(function (n) { return n.to === actor.id; }).slice(-50)
        .map(function (n) { return { id: n.id, kind: n.kind, title: n.title, body: n.body, ref: n.ref, createdAt: n.createdAt, readAt: n.readAt }; });
    }
  };

  function nameMap(ctx) { var m = {}; ctx.db.rows('People').forEach(function (p) { m[p.id] = p.name; }); return m; }
  function err(code, message) { var e = new Error(message); e.code = code; return e; }

  // Actions that only read. Everything else changes data and runs, from start to end, inside the server lock.
  var READ_ONLY = { me: 1, previewLeave: 1, myLeaves: 1, pending: 1, effect: 1, photo: 1, myMonth: 1, today: 1, approvals: 1, incidentItems: 1,
    disputes: 1, getSettings: 1, restrictions: 1, board: 1, todayAtGJ: 1, calendar: 1, myRestrictions: 1, monthReport: 1, devices: 1, notifications: 1 };
  var JPEG = /^data:image\/jpeg;base64,[A-Za-z0-9+\/]+=*$/;
  var TEXT_MAX = 2000, LIST_MAX = 400;

  /** Slow work that must not hold the lock: the photo upload. Runs after sign-in is checked, before the lock. */
  var PREPARE = {
    checkIn: function (ctx, actor, a) {
      // The check-in photo is taken inside the app (back camera, landscape) and is required.
      if (!a.photo || !a.thumb) throw err('BLOCKED', 'Take the check-in photo first.');
      if (typeof a.photo !== 'string' || typeof a.thumb !== 'string' || a.photo.length > 900000 || a.thumb.length > 45000) throw err('BLOCKED', 'The photo is too large. Please try again.');
      // Only a picture made by the app is stored: never a link that other phones would then load.
      if (!JPEG.test(a.thumb) || !JPEG.test(a.photo)) throw err('BLOCKED', 'The photo could not be read. Please take it again.');
      if (ctx.db.rows('Punches').some(function (x) { return x.personId === actor.id && x.date === Core._.today(ctx) && x.kind === 'in'; })) throw err('BLOCKED', 'You have already checked in today.');
      var stamp = Core._.today(ctx) + '_' + actor.id + '_' + ctx.now;
      // Full photo: private Drive folder. Thumbnail: a small cell in the Thumbs tab (no second Drive file).
      return { lat: a.lat, lng: a.lng, accuracy: a.accuracy, dress: a.dress, thumb: a.thumb, photoId: ctx.env.savePhoto(stamp + '.jpg', a.photo), thumbId: 't_' + ctx.env.randomId() };
    }
  };

  function own(map, key) { return typeof key === 'string' && Object.prototype.hasOwnProperty.call(map, key); }

  /** Sizes are enforced here, not only in the phone: no text beyond 2,000 characters, no endless lists. */
  function checkSizes(v, key, depth) {
    if (typeof v === 'string') {
      var max = key === 'photo' ? 900000 : key === 'thumb' ? 45000 : TEXT_MAX;
      if (v.length > max) throw err('BLOCKED', 'That text is too long.');
    } else if (v && typeof v === 'object') {
      if (depth > 5) throw err('BLOCKED', 'The request is not valid.');
      var keys = Object.keys(v);
      if (keys.length > LIST_MAX) throw err('BLOCKED', 'That list is too long.');
      keys.forEach(function (k) { checkSizes(v[k], k, depth + 1); });
    }
  }

  /**
   * Run a changing action inside the server lock. Whatever was read while waiting for the lock is
   * thrown away first, so every decision is made on what the Sheet holds NOW. If the action is
   * refused half-way, nothing of it is saved (except a counted wrong PIN).
   */
  function locked(ctx, fn) {
    return ctx.env.withLock(function () {
      if (ctx.db.reset) ctx.db.reset();
      try { return fn(); }
      catch (e) { if (!(e && e.keep) && ctx.db.discard) ctx.db.discard(); throw e; }
    });
  }

  function handle(ctx, request) {
    try {
      request = request || {};
      var args = request.args && typeof request.args === 'object' && !Array.isArray(request.args) ? request.args : {};
      var action = request.action;
      if (!(request.clientVersion >= MIN_CLIENT_VERSION)) return { ok: false, code: 'UPDATE', message: 'Please update the app.' };
      if (!own(PUBLIC, action) && !own(PRIVATE, action)) return { ok: false, code: 'UNKNOWN', message: 'Unknown action.' };
      checkSizes(args, '', 0);
      if (action === 'names') return { ok: true, data: PUBLIC.names(ctx, args) };
      if (own(PUBLIC, action)) return { ok: true, data: locked(ctx, function () { return PUBLIC[action](ctx, args); }) };
      var actor = Core.authenticate(ctx, request.personId, request.deviceToken);
      if (own(READ_ONLY, action)) return { ok: true, data: PRIVATE[action](ctx, actor, args) };
      if (own(PREPARE, action)) args = PREPARE[action](ctx, actor, args);
      return { ok: true, data: locked(ctx, function () {
        var fresh = Core.authenticate(ctx, request.personId, request.deviceToken); // the phone may have been removed meanwhile
        return PRIVATE[action](ctx, fresh, args);
      }) };
    } catch (e) {
      if (e && e.code) return { ok: false, code: e.code, message: e.message };
      return { ok: false, code: 'ERROR', message: 'Something went wrong. Please try again.' };
    }
  }

  var api = { handle: handle, MIN_CLIENT_VERSION: MIN_CLIENT_VERSION };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.GJApi = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
