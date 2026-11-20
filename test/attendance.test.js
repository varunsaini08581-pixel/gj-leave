// Check-in/out, informed late/early, going out, absent job, My month.
const test = require('node:test');
const assert = require('node:assert/strict');
const Core = require('../src/server/core.js');
const Att = require('../src/server/attendance.js');
const { seed } = require('./helpers.js');

const code = fn => { try { fn(); } catch (e) { return e.code + ': ' + e.message; } return 'NO_ERROR'; };
const D = '2026-11-25'; // a Wednesday
const leave = (dates, extra) => ({ kind: 'full', dates, reasonCode: 'Personal work', reasonText: 'Bank work', ...extra });
// Harsh: duty 10:30-19:30.

test('check-in within 10 min grace counts nothing; one check-in per day', () => {
  const s = seed(); const harsh = s.actor('Harsh');
  const r = Att.checkIn(s.ctx(D, '10:40'), harsh);
  assert.equal(r.lateMinutes, 10);
  assert.equal(s.db.rows('DayMinutes').length, 0);
  assert.match(code(() => Att.checkIn(s.ctx(D, '10:45'), harsh)), /already checked in/);
});

test('late informed before duty start: minutes after grace come from the bank', () => {
  const s = seed(); const harsh = s.actor('Harsh');
  Att.requestShort(s.ctx(D, '09:50'), harsh, { kind: 'late', time: '11:00' });
  const r = Att.checkIn(s.ctx(D, '10:52'), harsh);
  assert.equal(r.informed, true);
  const m = Att.myMonth(s.ctx(D, '12:00'), 'harsh', '2026-11');
  assert.equal(m.bank.used, 12);
  assert.equal(m.bank.left, 108);
  assert.equal(m.bank.passesUsed, 0);
});

test('late cannot be informed after duty start; uninformed late uses a pass', () => {
  const s = seed(); const harsh = s.actor('Harsh');
  assert.match(code(() => Att.requestShort(s.ctx(D, '10:31'), harsh, { kind: 'late', time: '11:00' })), /Duty has started/);
  assert.equal(Att.checkIn(s.ctx(D, '10:55'), harsh).informed, false);
  const m = Att.myMonth(s.ctx(D, '12:00'), 'harsh', '2026-11');
  assert.equal(m.bank.used, 15);
  assert.equal(m.bank.passesUsed, 1);
});

test('informed late but arrived after the stated time: the extra is not informed', () => {
  const s = seed(); const harsh = s.actor('Harsh');
  Att.requestShort(s.ctx(D, '09:00'), harsh, { kind: 'late', time: '11:00' }); // stated 30 min
  Att.checkIn(s.ctx(D, '11:15'), harsh);                                      // actual 45 min
  const m = Att.myMonth(s.ctx(D, '12:00'), 'harsh', '2026-11');
  assert.equal(m.bank.used, 35);
  assert.equal(m.bank.passesUsed, 1);
});

test('not informed and more than 30 min late: violation immediately, stored and visible', () => {
  const s = seed(); const harsh = s.actor('Harsh');
  Att.checkIn(s.ctx(D, '11:10'), harsh);
  assert.deepEqual(s.db.rows('Violations').map(v => v.rule), ['not-informed-over-30']);
  assert.equal(Att.myMonth(s.ctx(D, '12:00'), 'harsh', '2026-11').ladder.recordOnly, true);
});

test('short requests: more than 2 hours must be a half-day leave; clash is per day', () => {
  const s = seed();
  assert.match(code(() => Att.requestShort(s.ctx(D, '08:00'), s.actor('Harsh'), { kind: 'late', time: '12:45' })), /half day/);
  // Bhawna (09:30) informs late; Pooja then cannot leave early the same day (owner example).
  Att.requestShort(s.ctx(D, '08:00'), s.actor('Bhawna'), { kind: 'late', time: '10:30' });
  assert.match(code(() => Att.requestShort(s.ctx(D, '12:00'), s.actor('Pooja'), { kind: 'early', time: '18:00' })), /Not allowed: Bhawna is off/);
  assert.equal(code(() => Att.requestShort(s.ctx(D, '12:00'), s.actor('Pooja'), { kind: 'early', time: '18:00', date: '2026-11-26' })), 'NO_ERROR');
});

test('early: informed before leaving; leaving before the stated time splits the minutes', () => {
  const s = seed(); const harsh = s.actor('Harsh');
  Att.checkIn(s.ctx(D, '10:30'), harsh);
  Att.requestShort(s.ctx(D, '15:00'), harsh, { kind: 'early', time: '19:00' });
  assert.equal(Att.checkOut(s.ctx(D, '18:50'), harsh).earlyMinutes, 40);
  const rows = s.db.rows('DayMinutes').map(m => [m.minutes, m.informed]);
  assert.deepEqual(rows, [[30, true], [10, false]]);
  assert.match(code(() => Att.checkOut(s.ctx(D, '19:00'), harsh)), /already checked out/);
});

test('check-out needs a check-in; leaving on time counts nothing', () => {
  const s = seed(); const harsh = s.actor('Harsh');
  assert.match(code(() => Att.checkOut(s.ctx(D, '19:30'), harsh)), /Check in first/);
  Att.checkIn(s.ctx(D, '10:30'), harsh);
  Att.checkOut(s.ctx(D, '19:31'), harsh);
  assert.equal(s.db.rows('DayMinutes').length, 0);
});

test('going out: counted from approval to the staff tap, not to Aakash’s confirmation', () => {
  const s = seed(); const harsh = s.actor('Harsh'), aakash = s.actor('Aakash');
  assert.match(code(() => Att.goingOut(s.ctx(D, '14:00'), harsh, { reason: 'Bank', expectedMinutes: 30 })), /not checked in/);
  Att.checkIn(s.ctx(D, '10:30'), harsh);
  const o = Att.goingOut(s.ctx(D, '14:00'), harsh, { reason: 'Bank', expectedMinutes: 30 });
  assert.match(code(() => Att.decideOuting(s.ctx(D, '14:02'), s.actor('Neha'), o.id, true)), /FORBIDDEN/);
  Att.decideOuting(s.ctx(D, '14:05'), aakash, o.id, true);
  assert.match(code(() => Att.checkOut(s.ctx(D, '14:20'), harsh)), /marked as out/);
  assert.equal(Att.imBack(s.ctx(D, '14:47'), harsh, o.id).minutes, 42);
  Att.remindBack(s.ctx(D, '14:55'), harsh, o.id);
  assert.equal(Att.confirmBack(s.ctx(D, '14:57'), aakash, o.id).minutes, 42); // confirming 10 min late costs nothing
  const m = Att.myMonth(s.ctx(D, '15:00'), 'harsh', '2026-11');
  assert.equal(m.bank.days[0].fromBank, 42); // over 15 min: the whole outing counts
});

test('going out up to 15 min is free; Aakash can correct the back time and it is logged', () => {
  const s = seed(); const harsh = s.actor('Harsh'), aakash = s.actor('Aakash');
  Att.checkIn(s.ctx(D, '10:30'), harsh);
  const o = Att.goingOut(s.ctx(D, '14:00'), harsh, { reason: 'Tea', expectedMinutes: 10 });
  Att.decideOuting(s.ctx(D, '14:00'), aakash, o.id, true);
  Att.imBack(s.ctx(D, '14:40'), harsh, o.id);               // forgot to tap; really back at 14:12
  assert.equal(Att.myMonth(s.ctx(D, '14:41'), 'harsh', '2026-11').bank.used, 40);
  Att.confirmBack(s.ctx(D, '14:45'), aakash, o.id, '14:12');
  assert.equal(Att.myMonth(s.ctx(D, '14:46'), 'harsh', '2026-11').bank.used, 0);
  assert.ok(s.db.rows('Audit').some(a => a.action === 'out.correct'));
});

test('going out is blocked by the per-day clash rule', () => {
  const s = seed();
  Att.checkIn(s.ctx(D, '09:30'), s.actor('Manish'));
  Core.submitLeave(s.ctx('2026-11-20', '10:00'), s.actor('Raunak'), leave([D]));
  assert.match(code(() => Att.goingOut(s.ctx(D, '14:00'), s.actor('Manish'), { reason: 'Bank', expectedMinutes: 30 })), /Not allowed: Raunak is off/);
});

test('more than 2 hours away in a day is a half day (0.5 leave), not the bank', () => {
  const s = seed(); const harsh = s.actor('Harsh');
  s.db.insert('DayMinutes', { id: 'x1', personId: 'harsh', date: D, kind: 'late', minutes: 130, informed: true, statedMinutes: '', source: 't' });
  const m = Att.myMonth(s.ctx(D, '15:00'), 'harsh', '2026-11');
  assert.equal(m.bank.used, 0);
  assert.equal(m.leaves.autoHalfDays[0].amount, 0.5);
  assert.equal(m.leaves.total, 2.5); // 2 roster Sundays + 0.5
});

test('month page: Karan example end to end gives Rs 126 and 1 violation (record only)', () => {
  const s = seed(); const harsh = s.actor('Harsh');
  s.db.insert('PayInfo', { personId: 'harsh', fixedSalary: 17000, targetAllowance: 2000, disciplineBonus: 500, dutyHours: 9 });
  const days = ['02', '03', '04', '05', '06', '07', '09', '10', '11', '12', '13', '14'];
  days.forEach(d => {
    const date = '2026-11-' + d;
    Att.requestShort(s.ctx(date, '09:00'), harsh, { kind: 'late', time: '11:00' });
    Att.checkIn(s.ctx(date, '11:00'), harsh);
  });
  const m = Att.myMonth(s.ctx('2026-11-14', '12:00'), 'harsh', '2026-11');
  assert.equal(m.bank.used, 120);
  assert.equal(m.bank.beyond, 120);
  assert.equal(m.wouldBeDeducted.total, 126);
  assert.equal(m.wouldBeDeducted.lines[0], '120 min beyond bank × Rs 1.05 = Rs 126');
  assert.match(m.wouldBeDeducted.label, /^Estimate as per company rules/);
  assert.equal(m.violations.length, 1);
  assert.equal(m.ladder.recordOnly, true);
});

test('month page: leaves above 5 show the working line', () => {
  const s = seed(); const aakash = s.actor('Aakash');
  s.db.insert('PayInfo', { personId: 'vikas', fixedSalary: 17000, targetAllowance: 0, disciplineBonus: 500, dutyHours: 9 });
  ['10', '12', '17', '19', '24'].forEach(d => {
    const r = Core.submitLeave(s.ctx('2026-11-01', '10:00'), aakash, leave(['2026-11-' + d], { forPersonId: 'vikas' }));
    if (r.status !== 'Approved') Core.decideLeave(s.ctx('2026-11-01', '10:05'), aakash, r.id, true);
  });
  const m = Att.myMonth(s.ctx('2026-11-25', '12:00'), 'vikas', '2026-11');
  assert.equal(m.leaves.total, 7);
  assert.equal(m.wouldBeDeducted.lines[0], '7 leaves − 5 free = 2 day(s) × Rs 567 = Rs 1133');
});

test('absent with no request: violation at end of day; Aakash can excuse; Muskan and leave-takers are skipped', () => {
  const s = seed(); const aakash = s.actor('Aakash');
  ['Neha', 'Vikas', 'Raunak', 'Manish', 'Bhawna', 'Pooja', 'Anita'].forEach(n => Att.checkIn(s.ctx(D, '09:30'), s.actor(n)));
  const made = Att.endOfDay(s.ctx(D, '21:00'), D);
  assert.deepEqual(made.sort(), ['Harsh', 'Muskan']);
  assert.deepEqual(s.db.rows('Violations').map(v => [v.personId, v.rule]), [['harsh', 'absent-no-request']]);
  assert.deepEqual(Att.endOfDay(s.ctx(D, '21:05'), D), []); // running it twice changes nothing
  const absent = s.db.rows('LeaveRequests').find(r => r.personId === 'harsh');
  assert.match(code(() => Att.excuseAbsence(s.ctx(D, '21:10'), aakash, absent.id, '')), /REASON/);
  Att.excuseAbsence(s.ctx(D, '21:10'), aakash, absent.id, 'Hospital, father admitted');
  assert.equal(Att.myMonth(s.ctx(D, '21:11'), 'harsh', '2026-11').violations.length, 0);
});

test('check-in location: flagged when more than 50 m from the shop point', () => {
  const s = seed();
  s.db.insert('Settings', { key: 'shopPoint', value: JSON.stringify({ lat: 29.1492, lng: 75.7217 }) });
  assert.equal(Att.checkIn(s.ctx(D, '10:30'), s.actor('Harsh'), { lat: 29.1493, lng: 75.7217, accuracy: 10 }).flag, '');
  assert.equal(Att.checkIn(s.ctx(D, '09:30'), s.actor('Neha'), { lat: 29.1502, lng: 75.7217, accuracy: 10 }).flag, 'outside-shop-area');
  assert.equal(Att.checkIn(s.ctx(D, '09:30'), s.actor('Manish')).flag, 'no-location');
});

test('3 hours late and not informed: the day becomes a half day AND it is still a violation', () => {
  const s = seed(); const harsh = s.actor('Harsh');
  Att.checkIn(s.ctx(D, '13:30'), harsh);
  const m = Att.myMonth(s.ctx(D, '14:00'), 'harsh', '2026-11');
  assert.equal(m.leaves.autoHalfDays[0].amount, 0.5);
  assert.equal(m.bank.used, 0);
  assert.deepEqual(m.violations.map(v => v.rule), ['not-informed-over-30']);
});
