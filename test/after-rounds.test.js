// Features added while fixing rounds 1-3: recorded phone call, forgotten check-out, removing a phone, PIN locks.
const test = require('node:test');
const assert = require('node:assert/strict');
const Core = require('../src/server/core.js');
const Att = require('../src/server/attendance.js');
const { seed, env } = require('./helpers.js');
const leave = (dates, extra) => ({ kind: 'full', dates, reasonCode: 'Family emergency', reasonText: 'Called in the morning', ...extra });
const code = fn => { try { fn(); return 'ok'; } catch (e) { return e.code; } };

test('called – emergency: Aakash enters a phone call later; notice runs from the call, not from when he types', () => {
  const s = seed(); const aakash = s.actor('Aakash');
  // Harsh (duty 10:30) phoned at 06:30 = 4 h notice = Emergency. Aakash types it at 12:00.
  const r = Core.submitLeave(s.ctx('2026-11-25', '12:00'), aakash, leave(['2026-11-25'], { forPersonId: 'harsh', calledAt: '06:30' }));
  const row = s.db.rows('LeaveRequests')[0];
  assert.equal(row.type, 'Emergency');
  assert.match(row.history[0].action, /called – emergency \(06:30\)/);
  assert.equal(row.enteredBy, 'aakash');
  // Without the call time the same entry is Unannounced.
  const s2 = seed();
  Core.submitLeave(s2.ctx('2026-11-25', '12:00'), s2.actor('Aakash'), leave(['2026-11-25'], { forPersonId: 'harsh' }));
  assert.equal(s2.db.rows('LeaveRequests')[0].type, 'Unannounced');
  // A staff member cannot use the field for their own request.
  const s3 = seed();
  Core.submitLeave(s3.ctx('2026-11-25', '12:00'), s3.actor('Harsh'), leave(['2026-11-25'], { calledAt: '06:30' }));
  assert.equal(s3.db.rows('LeaveRequests')[0].type, 'Unannounced');
  assert.equal(code(() => Core.submitLeave(s.ctx('2026-11-25', '12:00'), aakash, leave(['2026-11-26'], { forPersonId: 'vikas', calledAt: 'soon' }))), 'BLOCKED');
  assert.ok(r.id);
});

test('forgotten check-out: Aakash enters the time the next day; early minutes are counted; labelled', () => {
  const s = seed(); const aakash = s.actor('Aakash');
  Att.checkIn(s.ctx('2026-11-24', '10:30'), s.actor('Harsh'));               // duty 10:30-19:30
  assert.equal(code(() => Att.manualCheckOut(s.ctx('2026-11-25', '11:00'), s.actor('Harsh'), { personId: 'harsh', date: '2026-11-24', time: '19:00', reason: 'Forgot' })), 'FORBIDDEN');
  assert.equal(code(() => Att.manualCheckOut(s.ctx('2026-11-25', '11:00'), aakash, { personId: 'harsh', date: '2026-11-24', time: '09:00', reason: 'Forgot' })), 'BLOCKED');
  const r = Att.manualCheckOut(s.ctx('2026-11-25', '11:00'), aakash, { personId: 'harsh', date: '2026-11-24', time: '19:00', reason: 'Forgot to check out' });
  assert.equal(r.earlyMinutes, 30);
  const out = s.db.rows('Punches').find(p => p.kind === 'out');
  assert.equal(out.date, '2026-11-24'); assert.equal(out.enteredBy, 'aakash');
  assert.equal(code(() => Att.manualCheckOut(s.ctx('2026-11-25', '11:05'), aakash, { personId: 'harsh', date: '2026-11-24', time: '19:10', reason: 'Again' })), 'BLOCKED');
});

test('phones: the owner removes a lost phone; the only owner phone cannot be removed; requests are capped', () => {
  const s = seed(); const varun = s.actor('Varun'); const c = s.ctx('2026-11-20', '10:00');
  s.db.update('People', 'varun', { pinSalt: 's', pinHash: env.sha256('s:9999') });
  const own = Core.login(c, 'varun', '9999');
  assert.equal(own.deviceStatus, 'approved');
  assert.equal(code(() => Core.decideDevice(c, varun, own.deviceId, false)), 'BLOCKED');
  Core.setPin(c, varun, 'neha', '1111');
  const a = Core.login(c, 'neha', '1111'); Core.decideDevice(c, varun, a.deviceId, true);
  assert.equal(Core.authenticate(c, 'neha', a.deviceToken).id, 'neha');
  assert.equal(Core.decideDevice(c, varun, a.deviceId, false).status, 'revoked');
  assert.equal(code(() => Core.authenticate(c, 'neha', a.deviceToken)), 'AUTH');
  for (let i = 0; i < 3; i++) Core.login(c, 'neha', '1111');
  assert.equal(code(() => Core.login(c, 'neha', '1111')), 'BLOCKED');
  assert.equal(s.db.rows('Notifications').filter(n => n.kind === 'device' && n.to === 'varun').length, 2); // one alert per wave, not per tap
});

test('PIN lock: each lock in a row is longer; the person’s own approved phone is not locked out by a stranger', () => {
  const s = seed(); const varun = s.actor('Varun'); const t0 = s.ist('2026-11-20', '10:00');
  const at = ms => ({ db: s.db, env, now: ms });
  s.db.update('People', 'varun', { pinSalt: 's', pinHash: env.sha256('s:9999') });
  Core.login(at(t0), 'varun', '9999');
  Core.setPin(at(t0), varun, 'neha', '1111');
  const phone = Core.login(at(t0), 'neha', '1111'); Core.decideDevice(at(t0), varun, phone.deviceId, true);
  for (let i = 0; i < 5; i++) code(() => Core.login(at(t0 + 1000), 'neha', '0000'));          // a stranger on the public screen
  assert.equal(code(() => Core.login(at(t0 + 2000), 'neha', '1111')), 'LOCKED');
  assert.equal(Core.login(at(t0 + 2000), 'neha', '1111', phone.deviceToken).ok, true);         // her own phone still works
  for (let i = 0; i < 5; i++) code(() => Core.login(at(t0 + 16 * 60000), 'neha', '0000'));     // second lock = 1 hour
  assert.equal(code(() => Core.login(at(t0 + 16 * 60000 + 20 * 60000), 'neha', '1111')), 'LOCKED');
  assert.equal(Core.login(at(t0 + 16 * 60000 + 61 * 60000), 'neha', '1111').deviceStatus, 'pending');
});

test('possible clash: a request that is still waiting blocks no one, but the applicant is told', () => {
  const s = seed();
  const a = Core.submitLeave(s.ctx('2026-11-24', '12:00'), s.actor('Bhawna'), leave(['2026-11-25']));
  assert.equal(a.status, 'Pending with Aakash');
  const ev = Core.previewLeave(s.ctx('2026-11-20', '10:00'), s.actor('Pooja'), leave(['2026-11-25']));
  assert.notEqual(ev.decision, 'blocked');
  assert.match(ev.warnings.join(' '), /Possible clash: Bhawna has a request waiting/);
  assert.doesNotMatch(ev.warnings.join(' '), /Called in the morning/); // never the other person's reason
});

test('an edit after approval goes back to Aakash, even when every auto condition still holds (handoff Part 6)', () => {
  const Admin = require('../src/server/admin.js');
  const s = seed(); const c = s.ctx('2026-11-10', '10:00'); const neha = s.actor('Neha');
  const r = Core.submitLeave(c, neha, leave(['2026-11-25'], { reasonCode: 'Personal work' }));
  assert.equal(r.status, 'Approved');
  const e = Admin.editLeave(s.ctx('2026-11-11', '10:00'), neha, r.id, leave(['2026-11-26'], { reasonCode: 'Personal work' }));
  assert.equal(e.status, 'Pending with Aakash');
  assert.deepEqual(s.db.rows('LeaveRequests')[0].dates, ['2026-11-26']);
});

test('my month keeps the last 3 months in view; a new month starts at zero', () => {
  const s = seed();
  Att.checkIn(s.ctx('2026-09-10', '11:30'), s.actor('Harsh'));   // 60 min late, not informed = violation in September
  Att.checkIn(s.ctx('2026-10-12', '11:30'), s.actor('Harsh'));   // and one in October
  const m = Att.myMonth(s.ctx('2026-11-05', '10:00'), 'harsh', '2026-11');
  assert.deepEqual(m.last3.map(x => [x.month, x.violations]), [['2026-09', 1], ['2026-10', 1], ['2026-11', 0]]);
  assert.equal(m.ladder.violations, 0);
  assert.equal(m.bank.used, 0);
  const jan = Att.myMonth(s.ctx('2027-01-05', '10:00'), 'harsh', '2027-01');
  assert.deepEqual(jan.last3.map(x => x.month), ['2026-11', '2026-12', '2027-01']);
});

test('pending card: rule result, who else is away, the month so far; never salary', () => {
  const Views = require('../src/server/views.js');
  const s = seed();
  Core.submitLeave(s.ctx('2026-11-10', '10:00'), s.actor('Vikas'), leave(['2026-11-25'], { reasonCode: 'Personal work' }));
  const r = Core.submitLeave(s.ctx('2026-11-24', '12:00'), s.actor('Bhawna'), leave(['2026-11-25']));
  const cx = Views.pendingContext(s.ctx('2026-11-24', '12:05'), s.db.rows('LeaveRequests').find(x => x.id === r.id));
  assert.match(cx.ruleResult.join(' '), /Emergency leave/);
  assert.deepEqual(cx.awayToo.map(x => x.name), ['Vikas']);
  assert.equal(cx.month.free, 5);
  assert.doesNotMatch(JSON.stringify(cx), /salary|17000/i);
});
