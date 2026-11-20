/**
 * Timed jobs (handoff 3.12): email delivery, reminders, proactive warnings,
 * evening-before reminder, end-of-day absent check and the owner's daily summary.
 * Pure logic; Apps Script triggers call run(ctx, jobName, mailer).
 * mailer = { quota() -> number of emails left today, send(to, subject, body) }
 */
(function (root) {
  'use strict';
  var req = (typeof require !== 'undefined') ? require : null;
  var Cal = req ? req('../rules/calendar.js') : root.GJCalendar;
  var Core = req ? req('./core.js') : root.GJCore;
  var Att = req ? req('./attendance.js') : root.GJAttendance;
  var Views = req ? req('./views.js') : root.GJViews;
  var H = Core._;

  var DEFAULT_REMINDER_HOURS = 2; // owner, 20 Nov 2026
  var BANK_WARN_AT = 0.8;

  function setting(ctx, key) { var s = ctx.db.rows('Settings').filter(function (x) { return x.key === key; })[0]; return s ? s.value : ''; }
  function staff(ctx) { return ctx.db.rows('People').filter(function (p) { return p.active !== false && p.role === 'staff'; }); }
  function once(ctx, to, kind, ref, title, body) {
    var had = ctx.db.rows('Notifications').some(function (n) { return n.to === to && n.kind === kind && n.ref === ref; });
    if (!had) H.notify(ctx, to, kind, title, body, ref);
    return !had;
  }
  function timeOf(ms) { var d = new Date(ms + H.IST_OFFSET_MS); return ('0' + d.getUTCHours()).slice(-2) + ':' + ('0' + d.getUTCMinutes()).slice(-2); }

  /** One digest email per person for everything not yet emailed. In-app alerts work even with no email. */
  function sendEmails(ctx, mailer) {
    if (ctx.db.reset) ctx.db.reset(); // start from what the Sheet holds now
    var people = {}; ctx.db.rows('People').forEach(function (p) { people[p.id] = p; });
    var groups = {};
    ctx.db.rows('Notifications').forEach(function (n) { if (!n.emailedAt) (groups[n.to] = groups[n.to] || []).push(n); });
    // Each alert is e-mailed at most once. The alerts of this run are first marked as taken, under the
    // server lock and on fresh rows; only then are the e-mails sent. A second run that overlaps this one,
    // or the next run after a failure, finds them taken and does not send them again.
    var sent = 0, jobs = [], marks = [];
    function mark(list) {
      var write = function () { if (ctx.db.reset) ctx.db.reset(); list.forEach(function (m) { ctx.db.update('Notifications', m[0], { emailedAt: m[1] }); }); };
      try { ctx.env.withLock(write); }
      catch (e) { list.forEach(function (m) { ctx.db.update('Notifications', m[0], { emailedAt: m[1] }); }); if (ctx.db.flush) ctx.db.flush(); } // the lock is busy: these rows belong to this job alone
    }
    var left = 0; try { left = mailer.quota(); } catch (e) { left = 0; }
    Object.keys(groups).forEach(function (to) {
      var p = people[to], list = groups[to];
      var email = p && p.active !== false && (p.email || (p.role === 'owner' ? ctx.env.ownerEmail : ''));
      if (!email) { list.forEach(function (n) { marks.push([n.id, -1]); }); return; } // -1 = no address (or the person has left): in-app only
      if (left < 1) return; // out of quota today: try again on the next run
      left -= 1;
      var subject = list.length === 1 ? 'GJ Leave: ' + list[0].title : 'GJ Leave: ' + list.length + ' updates';
      var body = list.map(function (n) { return '\u2022 ' + n.title + (n.body ? '\n  ' + String(n.body).slice(0, 500) : ''); }).join('\n\n') + '\n\nOpen the app to act on these.';
      jobs.push({ email: email, subject: subject, body: body.slice(0, 20000), ids: list.map(function (n) { return n.id; }) });
      list.forEach(function (n) { marks.push([n.id, ctx.now]); });
    });
    if (marks.length) mark(marks);
    var failed = [];
    jobs.forEach(function (j) {
      try { mailer.send(j.email, j.subject, j.body); sent += 1; }
      catch (e) { j.ids.forEach(function (id) { failed.push([id, -2]); }); } // -2 = the address was refused: in-app only
    });
    if (failed.length) mark(failed);
    return sent;
  }

  /** A pending request reminds Aakash again every X hours (owner: 2). Varun too when he must decide. */
  function reminders(ctx) {
    // Owner, 20 Nov 2026: no reminders between midnight and 6 in the morning.
    if (new Date(ctx.now + H.IST_OFFSET_MS).getUTCHours() < 6) return 0;
    var hours = Number(setting(ctx, 'reminderHours')) || DEFAULT_REMINDER_HOURS, gap = hours * 3600000, n = 0;
    var names = {}; ctx.db.rows('People').forEach(function (p) { names[p.id] = p.name; });
    ctx.db.rows('LeaveRequests').forEach(function (r) {
      if (!H.OPEN[r.status]) return;
      var asker = H.find(ctx, 'People', r.personId);
      if (!asker || asker.active === false) return; // the person has left: nothing to remind about
      var last = r.remindedAt || r.submittedAt;
      if (ctx.now - last < gap) return;
      var who = [];
      if (r.route === 'aakash') who = who.concat(H.deciders(ctx)); // Varun too while Aakash is on leave
      if (r.route === 'special' && r.approvals.aakash !== 'yes') who = who.concat(H.byRole(ctx, 'manager'));
      if (r.route === 'varun' || (r.route === 'special' && r.approvals.varun !== 'yes')) who = who.concat(H.byRole(ctx, 'owner'));
      who.forEach(function (m) { H.notify(ctx, m.id, 'reminder', 'Reminder: leave request waiting', names[r.personId] + ': ' + H.niceDates(r.dates), r.id); });
      ctx.db.update('LeaveRequests', r.id, { remindedAt: ctx.now });
      n += 1;
    });
    ctx.db.rows('ShortRequests').forEach(function (q) {
      if (q.status !== 'Pending') return;
      var last = q.remindedAt || q.submittedAt;
      if (ctx.now - last < gap) return;
      H.deciders(ctx).forEach(function (m) { H.notify(ctx, m.id, 'reminder', 'Reminder: late / early request waiting', names[q.personId] + ': ' + q.date + ' ' + q.time, q.id); });
      ctx.db.update('ShortRequests', q.id, { remindedAt: ctx.now });
      n += 1;
    });
    return n;
  }

  /** "Bank 80% used", "1 more = violation ...", and the notice stage to Varun. Each is sent once per month. */
  function warnings(ctx) {
    var month = Cal.monthKey(H.today(ctx)), n = 0;
    staff(ctx).forEach(function (p) {
      if (p.noApproval) return;
      var m = Att.myMonth(ctx, p.id, month);
      if (m.bank.used >= m.bank.minutes * BANK_WARN_AT && m.bank.left > 0)
        n += once(ctx, p.id, 'warn-bank80', month, '2-hour bank: 80% used', m.bank.left + ' min left this month. After the bank, extra minutes would be deducted.') ? 1 : 0;
      if (m.bank.left === 0)
        n += once(ctx, p.id, 'warn-bank0', month, '2-hour bank is used up', 'Every extra 2 hours beyond the bank = 1 violation.') ? 1 : 0;
      if (m.bank.passesUsed >= m.bank.passes)
        n += once(ctx, p.id, 'warn-passes', month, 'All 3 not-informed passes are used', 'After the passes, every 2nd not-informed time is a violation.') ? 1 : 0;
      // After the passes, every 2nd not-informed time is a violation: say so the time before.
      var ni = m.bank.notInformed || 0;
      if (ni >= m.bank.passes && (ni + 1 - m.bank.passes) % 2 === 0)
        n += once(ctx, p.id, 'warn-next', month + ':' + ni, 'The next not-informed time is a violation', 'You have ' + ni + ' not-informed times this month. Inform in the app before duty start (late) or before you leave (early).') ? 1 : 0;
      if (m.ladder.violations === 1)
        n += once(ctx, p.id, 'warn-v1', month, '1 violation this month', '1 more violation = discipline bonus and target allowance would be lost.') ? 1 : 0;
      if (m.ladder.violations === 2)
        n += once(ctx, p.id, 'warn-v2', month, '2 violations this month', '1 more violation = notice.') ? 1 : 0;
      if (m.ladder.notice) H.byRole(ctx, 'owner').forEach(function (o) {
        n += once(ctx, o.id, 'notice-stage', month + ':' + p.id, 'Notice stage: ' + p.name, m.ladder.violations + ' violations in ' + month + '. Your decision is needed.') ? 1 : 0;
      });
      if (m.leaves.emergencies >= m.leaves.emergenciesAllowed)
        n += once(ctx, p.id, 'warn-emergency', month, 'Both emergency leaves are used', 'The next emergency leave this month is a violation and is not a free leave.') ? 1 : 0;
    });
    return n;
  }

  /** The evening before: remind people whose leave starts tomorrow. */
  function eveningBefore(ctx) {
    var tomorrow = Cal.addDays(H.today(ctx), 1), n = 0;
    ctx.db.rows('LeaveRequests').forEach(function (r) {
      if ((r.status === 'Approved' || r.status === 'Recorded') && r.route !== 'system' && r.dates[0] === tomorrow) n += once(ctx, r.personId, 'leave-tomorrow', r.id, 'Your leave starts tomorrow', H.niceDates(r.dates) + (r.kind === 'half' ? ' (half day from ' + r.halfStart + ')' : '')) ? 1 : 0;
    });
    return n;
  }

  /** After closing: absent check, then the owner's daily summary of who was away or late. */
  function endOfDay(ctx) {
    var date = H.today(ctx);
    // If the job did not run on an earlier night (a failed timer, quota), those days are checked now.
    // Never before the day the Sheet was started, and never twice: a day already dealt with is left alone.
    var start = setting(ctx, 'startDate'), absent = [];
    [3, 2, 1].forEach(function (back) {
      var d = Cal.addDays(date, -back);
      if (start && d < start) return;
      Att.endOfDay(ctx, d).forEach(function (name) { absent.push(name + ' (' + d.slice(8) + '-' + d.slice(5, 7) + ')'); });
    });
    absent = Att.endOfDay(ctx, date).concat(absent);
    var hurt = ctx.db.damaged ? ctx.db.damaged() : [];
    var b = Views.board(ctx, { role: 'owner' });
    var late = b.people.filter(function (p) { return p.checkInAt && p.lateMinutes > 10; }).map(function (p) { return p.name + ' ' + p.lateMinutes + ' min (in ' + timeOf(p.checkInAt) + ')'; });
    var leave = b.people.filter(function (p) { return p.state === 'On leave' || p.halfDay; }).map(function (p) { return p.name + (p.halfDay ? ' (half day)' : ''); });
    var noOut = b.people.filter(function (p) { return p.checkInAt && !p.checkOutAt; }).map(function (p) { return p.name; });
    var lines = ['On leave: ' + (leave.join(', ') || 'none'), 'Late: ' + (late.join(', ') || 'none'), 'Absent with no request: ' + (absent.join(', ') || 'none'),
      'No check-out yet: ' + (noOut.join(', ') || 'none')];
    if (hurt.length) lines.push('DAMAGED ROWS in the Sheet (edited by hand, ignored by the app until repaired): ' + hurt.join(', '));
    H.byRole(ctx, 'owner').forEach(function (o) { once(ctx, o.id, 'daily-summary', date, 'Daily summary ' + date, lines.join('\n  ')); });
    // A missing check-out is flagged for Aakash the next morning.
    if (noOut.length) H.byRole(ctx, 'manager').forEach(function (m) { once(ctx, m.id, 'missing-checkout', date, 'Missing check-out', noOut.join(', ') + ' on ' + date + '. Please fix.'); });
    return { absent: absent, summary: lines };
  }

  function run(ctx, job, mailer) {
    if (job === 'emails') return sendEmails(ctx, mailer);
    if (job === 'hourly') return ctx.env.withLock(function () { if (ctx.db.reset) ctx.db.reset(); return { reminders: reminders(ctx), warnings: warnings(ctx) }; });
    if (job === 'evening') return ctx.env.withLock(function () { if (ctx.db.reset) ctx.db.reset(); return eveningBefore(ctx); });
    if (job === 'endOfDay') return ctx.env.withLock(function () { if (ctx.db.reset) ctx.db.reset(); return endOfDay(ctx); });
    throw new Error('Unknown job ' + job);
  }

  var api = { run: run, sendEmails: sendEmails, reminders: reminders, warnings: warnings, eveningBefore: eveningBefore, endOfDay: endOfDay };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.GJJobs = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
