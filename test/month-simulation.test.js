// A full shop month with 12 people (handoff Part 7), compared with a HAND COUNT.
// October 2026: 1 Oct is a Thursday; Sundays are 4, 11, 18, 25 (four Sundays).
// Everybody's sample salary: Rs 17,000, 9 duty hours -> Rs 567 a day, Rs 1.05 a minute.
const test = require('node:test');
const assert = require('node:assert/strict');
const Core = require('../src/server/core.js');
const Att = require('../src/server/attendance.js');
const Admin = require('../src/server/admin.js');
const Views = require('../src/server/views.js');
const { seed } = require('./helpers.js');

const leave = (dates, extra) => ({ kind: 'full', dates, reasonCode: 'Personal work', reasonText: 'Simulation', ...extra });
const d = n => '2026-10-' + String(n).padStart(2, '0');

test('12-person October 2026 matches the hand count', () => {
  const s = seed();
  const A = n => s.actor(n), aakash = A('Aakash'), varun = A('Varun');
  const at = (day, hhmm) => s.ctx(d(day), hhmm);
  s.db.rows('People').filter(p => p.role === 'staff').forEach(p => s.db.insert('PayInfo', { personId: p.id, fixedSalary: 17000, targetAllowance: 2000, disciplineBonus: 500, dutyHours: 9 }));
  const approve = (when, r) => { if (/Pending|Special/.test(r.status)) return Core.decideLeave(at(...when), aakash, r.id, true); return r; };
  const lateOk = (who, day, time) => Att.decideShort(at(day - 1, '20:05'), aakash, Att.requestShort(at(day - 1, '20:00'), A(who), { kind: 'late', time, date: d(day) }).id, true);

  // 1 Oct: Aakash adds a restricted week (leave allowed, counts as a violation): 26-30 Oct.
  Admin.saveRestriction(at(1, '09:00'), aakash, { from: d(26), to: d(30), note: 'Diwali stock week', rule: 'violation' });

  // --- Neha: 1 day (auto), later 2 days (auto), one approved late arrival.
  assert.equal(Core.submitLeave(at(1, '10:00'), A('Neha'), leave([d(7)])).status, 'Approved');
  assert.equal(Core.submitLeave(at(15, '10:00'), A('Neha'), leave([d(21), d(22)])).status, 'Approved');
  lateOk('Neha', 13, '10:00'); Att.checkIn(at(13, '10:00'), A('Neha'));                 // 30 late -> 20 counted

  // --- Vikas: three emergencies (13 h, 12 h and 13 h notice). The 3rd is a violation and is not free.
  approve([5, '22:05'], Core.submitLeave(at(5, '22:00'), A('Vikas'), leave([d(6)])));
  approve([13, '23:05'], Core.submitLeave(at(13, '23:00'), A('Vikas'), leave([d(14)])));
  const v3 = Core.submitLeave(at(19, '22:00'), A('Vikas'), leave([d(20)]));
  Core.decideLeave(at(19, '22:10'), varun, v3.id, true);                                // Aakash is on leave that day

  // --- Harsh: five times 20 min late without informing, then once 40 min late without informing.
  [5, 6, 7, 8, 9].forEach(day => Att.checkIn(at(day, '10:50'), A('Harsh')));
  Att.checkIn(at(12, '11:10'), A('Harsh'));

  // --- Raunak: two outings, then 4 days in a row (special approval) inside the restricted week.
  Att.checkIn(at(8, '10:30'), A('Raunak'));
  const o1 = Att.goingOut(at(8, '14:00'), A('Raunak'), { reason: 'Courier', expectedMinutes: 30 });
  Att.decideOuting(at(8, '14:05'), aakash, o1.id, true); Att.imBack(at(8, '14:47'), A('Raunak'), o1.id); Att.confirmBack(at(8, '14:55'), aakash, o1.id);
  Att.checkIn(at(9, '10:30'), A('Raunak'));
  const o2 = Att.goingOut(at(9, '15:00'), A('Raunak'), { reason: 'Tea', expectedMinutes: 10 });
  Att.decideOuting(at(9, '15:00'), aakash, o2.id, true); Att.imBack(at(9, '15:12'), A('Raunak'), o2.id); Att.confirmBack(at(9, '15:13'), aakash, o2.id);
  const r4 = Core.submitLeave(at(10, '10:00'), A('Raunak'), leave([d(26), d(27), d(28), d(29)]));
  assert.equal(r4.status, 'Special – waiting');
  Core.decideLeave(at(10, '11:00'), aakash, r4.id, true);
  assert.equal(Core.decideLeave(at(10, '12:00'), varun, r4.id, true).status, 'Approved');

  // --- Manish: a half day (auto-approved), and one day absent with no request.
  assert.equal(Core.submitLeave(at(12, '10:00'), A('Manish'), leave([d(20)], { kind: 'half', halfStart: '14:00' })).status, 'Approved');
  ['Neha', 'Vikas', 'Harsh', 'Raunak', 'Muskan', 'Bhawna', 'Pooja', 'Anita'].forEach(n => Att.checkIn(at(15, s.db.rows('People').find(p => p.name === n).dutyStart), A(n)));

  // --- Garvit: new joiner added on 12 Oct by Varun; on time on the 15th.
  const garvit = Admin.savePerson(at(12, '09:00'), varun, { name: 'Garvit', group: 'Calls', role: 'staff', dutyStart: '10:00', dutyEnd: '19:00', sundayOff: [1, 2], active: true }).id;
  Att.checkIn(at(15, '10:00'), { id: garvit, name: 'Garvit', role: 'staff' });
  assert.deepEqual(Att.endOfDay(at(15, '21:00'), d(15)), ['Manish']);

  // --- Muskan: recorded only.
  assert.equal(Core.submitLeave(at(10, '10:00'), A('Muskan'), leave([d(16)])).status, 'Recorded');

  // --- Bhawna: approved early leaving (60 min), then two approved late arrivals of 70 min.
  Att.checkIn(at(9, '09:30'), A('Bhawna'));
  Att.decideShort(at(9, '12:05'), aakash, Att.requestShort(at(9, '12:00'), A('Bhawna'), { kind: 'early', time: '17:30' }).id, true);
  Att.checkOut(at(9, '17:30'), A('Bhawna'));
  lateOk('Bhawna', 13, '10:40'); Att.checkIn(at(13, '10:40'), A('Bhawna'));
  lateOk('Bhawna', 14, '10:40'); Att.checkIn(at(14, '10:40'), A('Bhawna'));

  // --- Pooja: 2 days inside the restricted week (allowed, 1 violation for the whole request).
  assert.equal(Core.submitLeave(at(15, '11:00'), A('Pooja'), leave([d(27), d(28)])).status, 'Approved');

  // --- Anita: two weekdays (a 4-Sunday month gives her 1 free weekday). Aakash approves.
  approve([5, '11:00'], Core.submitLeave(at(5, '10:00'), A('Anita'), leave([d(14)])));
  approve([16, '11:00'], Core.submitLeave(at(16, '10:00'), A('Anita'), leave([d(23)])));

  // --- Aakash: his own leave goes to Varun.
  const ak = Core.submitLeave(at(12, '10:00'), aakash, leave([d(19)]));
  assert.equal(ak.status, 'Pending with Varun');
  Core.decideLeave(at(12, '12:00'), varun, ak.id, true);

  // ================= HAND COUNT =================
  const rep = Views.monthReport(s.ctx('2026-11-01', '10:00'), varun, '2026-10');
  const m = n => rep.people.find(p => p.name === n);
  const row = n => { const p = m(n); return { leaves: p.leaves.total, cut: p.leaves.daysCut, bank: p.bank.used, beyond: p.bank.beyond, violations: p.ladder.violations, rupees: p.wouldBeDeducted.total }; };

  // Neha: Sundays 18, 25 + 7, 21, 22 = 5 leaves, exactly the free 5. Late 30 - 10 grace = 20 from the bank.
  assert.deepEqual(row('Neha'), { leaves: 5, cut: 0, bank: 20, beyond: 0, violations: 0, rupees: 0 });
  // Vikas: Sundays 4, 11 + 2 emergencies = 4 free leaves. 3rd emergency: violation + 1 day cut (17,000 / 30 = 567).
  assert.deepEqual(row('Vikas'), { leaves: 4, cut: 1, bank: 0, beyond: 0, violations: 1, rupees: 567 });
  assert.equal(m('Vikas').leaves.emergencies, 3);
  // Harsh: 5 x (20 - 10) = 50; passes 1-3 free, 4th nothing, 5th = violation. Then 40 min not informed: 30 counted, immediate violation.
  assert.deepEqual(row('Harsh'), { leaves: 2, cut: 0, bank: 80, beyond: 0, violations: 2, rupees: 0 });
  assert.equal(m('Harsh').ladder.bonusLost && m('Harsh').ladder.targetAllowanceLost && !m('Harsh').ladder.notice, true);
  assert.equal(m('Harsh').bank.passesUsed, 3);
  // Raunak: outing 42 min (over 15, all counted); 12 min free. Sundays 4, 11 + 26-29 = 6 leaves, 1 above 5. Leave in the restricted week = 1 violation.
  assert.deepEqual(row('Raunak'), { leaves: 6, cut: 1, bank: 42, beyond: 0, violations: 1, rupees: 567 });
  // Manish: Sundays 18, 25 + absent 15th (1) + half day (0.5) = 3.5. Absent with no request = 1 violation.
  assert.deepEqual(row('Manish'), { leaves: 3.5, cut: 0, bank: 0, beyond: 0, violations: 1, rupees: 0 });
  // Muskan: no roster Sunday, 1 recorded leave, never a violation; shown as "if on payroll".
  assert.deepEqual(row('Muskan'), { leaves: 1, cut: 0, bank: 0, beyond: 0, violations: 0, rupees: 0 });
  assert.equal(m('Muskan').onPayroll, false);
  // Bhawna: 60 early + 60 (70 - 10) = bank full. Next 60 beyond the bank: 60 x 1.0494 = Rs 63. Under 120 extra, so no violation.
  assert.deepEqual(row('Bhawna'), { leaves: 2, cut: 0, bank: 120, beyond: 60, violations: 0, rupees: 63 });
  // Pooja: Sundays 4, 11 + 27, 28 = 4. One violation for the restricted-week request.
  assert.deepEqual(row('Pooja'), { leaves: 4, cut: 0, bank: 0, beyond: 0, violations: 1, rupees: 0 });
  // Anita: 4 Sundays + 2 weekdays = 6, 1 above her 5.
  assert.deepEqual(row('Anita'), { leaves: 6, cut: 1, bank: 0, beyond: 0, violations: 0, rupees: 567 });
  // Garvit is in the report; Aakash and Varun are not tracked.
  assert.equal(rep.people.length, 10);
  assert.equal(m('Garvit').ladder.violations, 0);
  assert.equal(m('Garvit').wouldBeDeducted, null); // no salary structure entered yet: no rupee estimate is shown
  // Totals for the owner: 6 violations in the shop, Rs 1,764 "would be deducted".
  assert.equal(rep.people.reduce((t, p) => t + p.ladder.violations, 0), 6);
  assert.equal(rep.people.reduce((t, p) => t + (p.wouldBeDeducted ? p.wouldBeDeducted.total : 0), 0), 567 + 567 + 63 + 567);
  // The Violations tab holds exactly those six, each with its rule.
  const rules = s.db.rows('Violations').filter(v => v.disputeState !== 'removed').map(v => v.personId + ':' + v.rule).sort();
  assert.deepEqual(rules, ['harsh:not-informed-beyond-passes', 'harsh:not-informed-over-30', 'manish:absent-no-request', 'pooja:leave-in-restricted-period',
    'raunak:leave-in-restricted-period', 'vikas:emergency-beyond-2']);
});
