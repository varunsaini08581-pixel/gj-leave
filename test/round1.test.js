// Round 1 (rule correctness) reproducers. Every test here FAILS on the reviewed code.
// Run: node --test /home/claude/findings/repro-round1.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const SRC = __dirname + '/../src/';
const Core = require(SRC + 'server/core.js');
const Att = require(SRC + 'server/attendance.js');
const Admin = require(SRC + 'server/admin.js');
const Views = require(SRC + 'server/views.js');
const Api = require(SRC + 'server/api.js');
const { seed, env } = require('./helpers.js');

const leave = (dates, extra) => ({ kind: 'full', dates, reasonCode: 'Personal work', reasonText: 'Bank work', ...extra });
const live = s => s.db.rows('Violations').filter(v => v.disputeState !== 'removed');
const D = '2026-11-25'; // Wednesday. Nov 2026 Sundays: 1, 8, 15, 22, 29. Dec 2026 Sundays: 6, 13, 20, 27.
const okShort = (s, when, r) => Att.decideShort(s.ctx(...when), s.actor('Aakash'), r.id, true);

// ---------------------------------------------------------------- CRITICAL

test('R01 staff can backdate the notice: a same-day leave sent after duty start is auto-approved (PDF 3.4 notice = server time; Part 6 wrong phone clock)', () => {
  const s = seed();
  const call = (when, action, who, args) => Api.handle(s.ctx(...when), { action, clientVersion: 1, args, ...(who || {}) });
  const t = ['2026-11-20', '10:00'];
  s.db.update('People', 'varun', { pinSalt: 's', pinHash: env.sha256('s:9999') });
  const varun = { personId: 'varun', deviceToken: call(t, 'login', null, { personId: 'varun', pin: '9999' }).data.deviceToken };
  call(t, 'setPin', varun, { personId: 'vikas', pin: '2222' });
  const lg = call(t, 'login', null, { personId: 'vikas', pin: '2222' }).data;
  call(t, 'decideDevice', varun, { id: lg.deviceId, approve: true });
  const vikas = { personId: 'vikas', deviceToken: lg.deviceToken };
  // Vikas, duty 11:00. It is 25 Nov 12:00 (duty already started). The phone sends a made-up submittedAt.
  const r = call([D, '12:00'], 'submitLeave', vikas, leave([D], { submittedAt: s.ist('2026-11-20', '10:00') }));
  assert.equal(r.ok, true);
  const row = s.db.rows('LeaveRequests')[0];
  assert.equal(row.type, 'Unannounced', 'sent after duty start = Unannounced, whatever the phone says');
  assert.notEqual(row.status, 'Approved', 'must go to Aakash, never auto-approved');
});

test('R02 approved half day that starts mid-shift (not at duty start, and ending before duty end): checking out at the approved start time is booked as 330 min "not informed" = violation + a full day on top of the 0.5 (owner: half day = ANY 4 h 30 min, staff picks the start)', () => {
  const s = seed(); const harsh = s.actor('Harsh'); // duty 10:30-19:30
  const r = Core.submitLeave(s.ctx('2026-11-20', '10:00'), harsh, leave([D], { kind: 'half', halfStart: '14:00' })); // approved half day 14:00-18:30
  assert.equal(r.status, 'Approved');
  Att.checkIn(s.ctx(D, '10:30'), harsh);
  Att.checkOut(s.ctx(D, '14:00'), harsh);          // leaves exactly when the approved half day starts
  const m = Att.myMonth(s.ctx(D, '20:00'), 'harsh', '2026-11');
  const booked = s.db.rows('DayMinutes').reduce((t, x) => t + x.minutes, 0);
  // Only 18:30-19:30 (60 min) is outside the approved half day. The approved 270 min must never be booked as away time.
  assert.ok(booked <= 60, 'booked ' + booked + ' min as not-informed early leaving; the approved 270 min are inside it');
  assert.equal(m.leaves.taken, 0.5, 'the approved half day must not become 1.5 leaves');
});

// ---------------------------------------------------------------- HIGH

test('R03 leave in an "allowed, +1 violation" restricted period is auto-approved (PDF 3.4: auto-approval needs "no restriction")', () => {
  const s = seed();
  Admin.saveRestriction(s.ctx('2026-11-20', '09:00'), s.actor('Aakash'), { from: '2026-12-10', to: '2026-12-12', note: 'Peak sales season', rule: 'violation' });
  const r = Core.submitLeave(s.ctx('2026-11-20', '10:00'), s.actor('Vikas'), leave(['2026-12-10']));
  assert.equal(r.status, 'Pending with Aakash');
});

test('R04 cancelling a leave before it starts leaves its violation standing (restricted-period violation; same for unannounced and 3rd emergency)', () => {
  const s = seed(); const vikas = s.actor('Vikas');
  Admin.saveRestriction(s.ctx('2026-11-20', '09:00'), s.actor('Aakash'), { from: '2026-12-10', to: '2026-12-12', note: 'Peak sales season', rule: 'violation' });
  const r = Core.submitLeave(s.ctx('2026-11-20', '10:00'), vikas, leave(['2026-12-10']));
  if (r.status !== 'Approved') Core.decideLeave(s.ctx('2026-11-20', '10:05'), s.actor('Aakash'), r.id, true);
  assert.equal(live(s).length, 1);                                   // violation given when granted
  Core.cancelLeave(s.ctx('2026-11-21', '10:00'), vikas, r.id);       // cancelled 19 days before it starts
  assert.equal(live(s).length, 0, 'no leave was taken, so no violation may remain (edit already withdraws them; cancel does not)');
});

test('R05 informed "30 min late", arrives 3 hours late: the 150 extra minutes are not informed (> 30 min) but no violation is given (PDF 3.5 + assumption 9)', () => {
  const s = seed(); const harsh = s.actor('Harsh'); // duty 10:30
  okShort(s, [D, '09:05'], Att.requestShort(s.ctx(D, '09:00'), harsh, { kind: 'late', time: '11:00' }));
  Att.checkIn(s.ctx(D, '13:30'), harsh);
  assert.deepEqual(live(s).map(v => v.rule), ['not-informed-over-30']);
});

test('R06 half-day leave approved, person never comes at all: end of day records nothing (PDF 3.4 absent rule; only 0.5 leave is counted for a full day away)', () => {
  const s = seed(); const harsh = s.actor('Harsh');
  Core.submitLeave(s.ctx('2026-11-20', '10:00'), harsh, leave([D], { kind: 'half', halfStart: '10:30' })); // 10:30-15:00, back at 15:00
  const made = Att.endOfDay(s.ctx(D, '21:00'), D);
  const m = Att.myMonth(s.ctx(D, '21:05'), 'harsh', '2026-11');
  assert.ok(made.includes('Harsh') || m.leaves.taken >= 1, 'the missed half of the day must be recorded somewhere; got taken=' + m.leaves.taken + ', absent=' + JSON.stringify(made));
});

// ---------------------------------------------------------------- MEDIUM

test('R07 request still pending (never decided) and the person stays away: the day is recorded nowhere (PDF 3.4 absent rule, 3.10 month page)', () => {
  const s = seed(); const bhawna = s.actor('Bhawna'); // duty 09:30
  const r = Core.submitLeave(s.ctx('2026-11-24', '20:00'), bhawna, leave([D]));
  assert.equal(r.status, 'Pending with Aakash');
  const made = Att.endOfDay(s.ctx(D, '21:00'), D);
  const m = Att.myMonth(s.ctx(D, '21:05'), 'bhawna', '2026-11');
  assert.ok(made.includes('Bhawna') || m.leaves.taken >= 1, 'a day away must be counted; got taken=' + m.leaves.taken + ', absent=' + JSON.stringify(made));
});

test('R08 "3rd emergency" penalty is decided at submit time: if an earlier pending emergency is rejected, the 2nd granted emergency still gets the violation (owner decision 16:08)', () => {
  const s = seed(); const harsh = s.actor('Harsh'); const aakash = s.actor('Aakash');
  const e1 = Core.submitLeave(s.ctx('2026-11-09', '20:00'), harsh, leave(['2026-11-10']));
  Core.decideLeave(s.ctx('2026-11-09', '20:05'), aakash, e1.id, true);
  const e2 = Core.submitLeave(s.ctx('2026-11-17', '20:00'), harsh, leave(['2026-11-18']));
  const e3 = Core.submitLeave(s.ctx('2026-11-17', '23:00'), harsh, leave(['2026-11-19']));
  Core.decideLeave(s.ctx('2026-11-17', '23:30'), aakash, e2.id, false, 'Not this week');
  Core.decideLeave(s.ctx('2026-11-17', '23:31'), aakash, e3.id, true);
  const m = Att.myMonth(s.ctx('2026-11-20', '12:00'), 'harsh', '2026-11');
  assert.equal(m.leaves.emergencies, 2);
  assert.deepEqual(live(s).map(v => v.rule), [], 'only 2 emergencies were granted this month');
  assert.equal(m.leaves.daysCut, 0);
});

test('R09 leave across month end: the quota of the SECOND month is not checked (PDF Part 6 "a leave across month end (the quota is per month)")', () => {
  const s = seed(); const vikas = s.actor('Vikas'); const c = s.ctx('2026-11-20', '10:00');
  // December for Vikas: roster Sundays 6 + 13, plus 3 single leaves = 5 of 5.
  ['2026-12-10', '2026-12-15', '2026-12-22'].forEach(d => assert.equal(Core.submitLeave(c, vikas, leave([d])).status, 'Approved'));
  // 30 Nov + 1 Dec: December becomes 6.
  const ev = Core.previewLeave(c, vikas, leave(['2026-11-30', '2026-12-01']));
  assert.equal(ev.decision, 'aakash', '1 Dec is the 6th December leave: not "within the 5"');
});

test('R10 Saturday + own roster Sunday + Monday in one request is treated as "more than 2 days" (PDF 3.4: roster Sundays inside a run do not add to its length)', () => {
  const s = seed(); const vikas = s.actor('Vikas'); const c = s.ctx('2026-11-20', '10:00');
  const one = Core.previewLeave(c, vikas, leave(['2026-12-05', '2026-12-06', '2026-12-07'])); // 6 Dec = 1st Sunday = Vikas roster off
  assert.equal(one.run, 2);
  assert.equal(one.decision, 'auto', '2 leave days, 48 h notice, no clash: same result as sending Sat and Mon separately');
});

test('R11a Muskan (intern, records only) gets a real violation row for an unannounced leave (PDF 3.10, Part 9; endOfDay and incidents already skip her)', () => {
  const s = seed();
  const r = Core.submitLeave(s.ctx(D, '12:00'), s.actor('Muskan'), leave([D]));
  assert.equal(r.status, 'Recorded');
  assert.equal(live(s).length, 0);
});

test('R11b Muskan gets a real violation row for a not-informed late over 30 min', () => {
  const s = seed();
  Att.checkIn(s.ctx(D, '11:30'), s.actor('Muskan')); // duty 10:45
  assert.equal(live(s).length, 0);
});

test('R12 Today board + daily summary: a person on an approved morning half day is shown as "Not in yet – late"', () => {
  const s = seed();
  Core.submitLeave(s.ctx('2026-11-20', '10:00'), s.actor('Harsh'), leave([D], { kind: 'half', halfStart: '10:30' })); // due at 15:00
  const p = Views.board(s.ctx(D, '12:00'), s.actor('Aakash')).people.find(x => x.name === 'Harsh');
  assert.equal(p.lateMinutes, 0);
  assert.doesNotMatch(p.state, /late/);
});

test('R13 auto "Absent – unannounced" does not block a later leave entry for the same date: one day is counted as 2 leaves with 2 violations (PDF Part 6 overlapping requests)', () => {
  const s = seed(); const aakash = s.actor('Aakash');
  Att.endOfDay(s.ctx(D, '21:00'), D);                                // Bhawna absent, no request
  let entered = null;
  try { entered = Core.submitLeave(s.ctx('2026-11-26', '10:00'), aakash, leave([D], { forPersonId: 'bhawna' })); } catch (e) { /* a refusal is the correct result */ }
  if (entered) Core.decideLeave(s.ctx('2026-11-26', '10:05'), s.actor('Varun'), entered.id, true);
  const m = Att.myMonth(s.ctx('2026-11-26', '11:00'), 'bhawna', '2026-11');
  assert.equal(m.leaves.taken, 1, 'one calendar day can never be more than 1 leave');
  assert.equal(live(s).filter(v => v.personId === 'bhawna').length, 1);
});

test('R14 C1-E: after an extreme emergency is approved (2 of Sales away), Bhawna can still take leave that day (PDF 3.3 C1-E: only if Bhawna AND Pooja are both present)', () => {
  const s = seed(); const c = s.ctx('2026-11-20', '10:00');
  assert.equal(Core.submitLeave(c, s.actor('Vikas'), leave([D])).status, 'Approved');
  const h = Core.submitLeave(c, s.actor('Harsh'), leave([D], { extremeEmergency: true }));
  assert.equal(Core.decideLeave(c, s.actor('Aakash'), h.id, true).status, 'Approved');
  assert.equal(Core.previewLeave(c, s.actor('Bhawna'), leave([D])).decision, 'blocked');
});

test('R15 shop-closed day added after a leave was approved: the leave is still counted (PDF Part 6 "re-count")', () => {
  const s = seed(); const c = s.ctx('2026-11-20', '10:00');
  Core.submitLeave(c, s.actor('Vikas'), leave([D]));
  Admin.setSetting(s.ctx('2026-11-21', '10:00'), s.actor('Varun'), 'closedDays', [D]);
  assert.equal(Att.myMonth(s.ctx('2026-11-26', '10:00'), 'vikas', '2026-11').leaves.taken, 0);
});

test('R16 a person who has left (inactive) still counts as "present" in a clash rule: Vikas may go on leave with only Neha in Sales (PDF 3.3 C1, Part 6 leaver)', () => {
  const s = seed();
  s.db.update('People', 'harsh', { active: false });
  assert.equal(Core.previewLeave(s.ctx('2026-11-20', '10:00'), s.actor('Vikas'), leave([D])).decision, 'blocked');
});

test('R17 half-day notice is measured to the half-day start, not to duty start (PDF 3.4: notice = submission -> duty start on the first leave day; < 3 h = Unannounced)', () => {
  const s = seed(); // Neha duty 09:30. At 08:00 she asks for a half day from 14:00 today: 1 h 30 min before duty start.
  const ev = Core.previewLeave(s.ctx(D, '08:00'), s.actor('Neha'), leave([D], { kind: 'half', halfStart: '14:00' }));
  assert.equal(ev.type, 'Unannounced');
});

test('R18 going out and never tapping "I am back": Aakash cannot close the outing or set the back time, so nothing is ever counted (PDF 3.8 step 4)', () => {
  const s = seed(); const harsh = s.actor('Harsh'); const aakash = s.actor('Aakash');
  Att.checkIn(s.ctx(D, '10:30'), harsh);
  const o = Att.goingOut(s.ctx(D, '14:00'), harsh, { reason: 'Bank', expectedMinutes: 20 });
  Att.decideOuting(s.ctx(D, '14:05'), aakash, o.id, true);
  assert.doesNotThrow(() => Att.confirmBack(s.ctx(D, '16:00'), aakash, o.id, '15:35'));
  assert.equal(Att.myMonth(s.ctx(D, '20:00'), 'harsh', '2026-11').bank.used, 90);
});

test('R19 automatic half days (more than 2 h away) are counted in "My month" but not in the "within the 5" check for auto-approval (PDF 3.4 + assumption 9)', () => {
  const s = seed(); const harsh = s.actor('Harsh'); // roster Sundays 1 + 8 Nov = 2
  okShort(s, ['2026-11-10', '08:05'], Att.requestShort(s.ctx('2026-11-10', '08:00'), harsh, { kind: 'late', time: '12:30' }));
  okShort(s, ['2026-11-10', '08:06'], Att.requestShort(s.ctx('2026-11-10', '08:01'), harsh, { kind: 'early', time: '19:20' }));
  Att.checkIn(s.ctx('2026-11-10', '12:30'), harsh);
  Att.checkOut(s.ctx('2026-11-10', '19:20'), harsh);                 // 120 + 10 = 130 min away, all informed = half day
  const c = s.ctx('2026-11-11', '10:00');
  assert.equal(live(s).length, 0);
  ['2026-11-17', '2026-11-19'].forEach(d => assert.equal(Core.submitLeave(c, harsh, leave([d])).status, 'Approved'));
  assert.equal(Att.myMonth(c, 'harsh', '2026-11').leaves.total, 4.5);
  assert.equal(Core.previewLeave(c, harsh, leave(['2026-11-24'])).decision, 'aakash', '4.5 + 1 = 5.5 is above the 5');
});

test('R20 restriction added while a request is pending: Aakash can still approve it (PDF 3.6: refused, only Varun can override; code comment says restrictions are re-checked)', () => {
  const s = seed(); const aakash = s.actor('Aakash');
  const r = Core.submitLeave(s.ctx('2026-11-23', '22:00'), s.actor('Bhawna'), leave([D]));
  assert.equal(r.status, 'Pending with Aakash');
  Admin.saveRestriction(s.ctx('2026-11-24', '09:00'), s.actor('Varun'), { from: '2026-11-24', to: '2026-11-28', note: 'Peak sales season', rule: 'no-leave' });
  let status = '';
  try { status = Core.decideLeave(s.ctx('2026-11-24', '10:00'), aakash, r.id, true).status; } catch (e) { status = 'refused'; }
  assert.notEqual(status, 'Approved');
});

// ---------------------------------------------------------------- LOW

test('R21 "Rejected – clash": the other person (who holds the slot) is not notified (PDF 3.3: both people and Aakash are notified)', () => {
  const s = seed();
  const a = Core.submitLeave(s.ctx('2026-11-24', '12:00'), s.actor('Bhawna'), leave([D]));
  const b = Core.submitLeave(s.ctx('2026-11-24', '12:01'), s.actor('Pooja'), leave([D]));
  Core.decideLeave(s.ctx('2026-11-24', '12:05'), s.actor('Aakash'), a.id, true);
  assert.equal(Core.decideLeave(s.ctx('2026-11-24', '12:06'), s.actor('Aakash'), b.id, true).status, 'Rejected – clash');
  assert.ok(s.db.rows('Notifications').some(n => n.to === 'bhawna' && n.ref === b.id), 'Bhawna gets no notice about the clash');
});

test('R22 manual dress incident dated on a Sunday is accepted and uses the dress grace (PDF 3.7 "Dress (Mon–Sat)", 3.8 Sunday casual)', () => {
  const s = seed();
  let result = 'refused';
  try { result = Admin.recordIncident(s.ctx('2026-11-29', '12:00'), s.actor('Aakash'), { personId: 'harsh', item: 'dress', note: 'Blue shirt', date: '2026-11-29' }).result; } catch (e) { /* correct */ }
  assert.equal(result, 'refused');
});
