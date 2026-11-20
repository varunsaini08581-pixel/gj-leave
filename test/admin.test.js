// Manual violations + grace table, disputes, edit, override, settings.
const test = require('node:test');
const assert = require('node:assert/strict');
const Core = require('../src/server/core.js');
const Att = require('../src/server/attendance.js');
const Admin = require('../src/server/admin.js');
const Views = require('../src/server/views.js');
const { seed } = require('./helpers.js');

const code = fn => { try { fn(); } catch (e) { return e.code + ': ' + e.message; } return 'NO_ERROR'; };
const leave = (dates, extra) => ({ kind: 'full', dates, reasonCode: 'Personal work', reasonText: 'Bank work', ...extra });
const D = '2026-11-25';

test('grace table: chai cup 2 a month are noted, the 3rd is a violation; job sheet has no grace', () => {
  const s = seed(); const aakash = s.actor('Aakash'); const c = s.ctx(D, '12:00');
  const inc = item => Admin.recordIncident(c, aakash, { personId: 'harsh', item, note: 'Seen on the counter' });
  assert.deepEqual([inc('chai-cup').result, inc('chai-cup').result, inc('chai-cup').result], ['grace', 'grace', 'violation']);
  assert.equal(inc('job-sheet').result, 'violation');
  assert.deepEqual(s.db.rows('Violations').map(v => v.rule), ['manual:chai-cup', 'manual:job-sheet']);
  assert.equal(Att.myMonth(c, 'harsh', '2026-11').ladder.bonusLost, true); // same counter as the auto ones: 2nd violation
});

test('grace table: rubbish is 3 per QUARTER; a new month in the same quarter does not reset it', () => {
  const s = seed(); const aakash = s.actor('Aakash');
  const inc = (date) => Admin.recordIncident(s.ctx(date, '12:00'), aakash, { personId: 'harsh', item: 'rubbish', note: 'Wrapper on the floor', date }).result;
  assert.deepEqual([inc('2026-10-05'), inc('2026-10-20'), inc('2026-11-03'), inc('2026-11-25')], ['grace', 'grace', 'grace', 'violation']);
  assert.equal(inc('2027-01-04'), 'grace'); // next quarter
});

test('incidents: only Aakash/Varun; proof needed; Anita is dress exempt; Muskan never gets a violation', () => {
  const s = seed(); const aakash = s.actor('Aakash'); const c = s.ctx(D, '12:00');
  assert.match(code(() => Admin.recordIncident(c, s.actor('Neha'), { personId: 'harsh', item: 'phone', note: 'x' })), /FORBIDDEN/);
  assert.match(code(() => Admin.recordIncident(c, aakash, { personId: 'harsh', item: 'phone', note: ' ' })), /REASON/);
  assert.match(code(() => Admin.recordIncident(c, aakash, { personId: 'harsh', item: 'made-up', note: 'x' })), /BLOCKED/);
  assert.match(code(() => Admin.recordIncident(c, aakash, { personId: 'anita', item: 'dress', note: 'x' })), /exempt/);
  assert.equal(Admin.recordIncident(c, aakash, { personId: 'muskan', item: 'phone', note: 'Reels' }).result, 'grace');
  assert.equal(s.db.rows('Violations').length, 0);
});

test('dispute: own violation only, within 24 hours, once; only Varun decides; removed drops from the count', () => {
  const s = seed(); const aakash = s.actor('Aakash'), harsh = s.actor('Harsh'), varun = s.actor('Varun');
  Admin.recordIncident(s.ctx(D, '12:00'), aakash, { personId: 'harsh', item: 'phone', note: 'Reels for 20 min' });
  const v = s.db.rows('Violations')[0];
  assert.match(code(() => Admin.disputeViolation(s.ctx(D, '13:00'), s.actor('Neha'), v.id, 'not mine')), /NOT_FOUND/);
  assert.match(code(() => Admin.disputeViolation(s.ctx(D, '13:00'), harsh, v.id, '')), /REASON/);
  assert.match(code(() => Admin.disputeViolation(s.ctx('2026-11-26', '12:01'), harsh, v.id, 'Too late')), /24-hour/);
  Admin.disputeViolation(s.ctx(D, '13:00'), harsh, v.id, 'It was a customer call');
  assert.match(code(() => Admin.disputeViolation(s.ctx(D, '13:05'), harsh, v.id, 'again')), /already/);
  assert.match(code(() => Admin.decideDispute(s.ctx(D, '14:00'), aakash, v.id, false, 'ok')), /FORBIDDEN/);
  assert.equal(Att.myMonth(s.ctx(D, '14:00'), 'harsh', '2026-11').violations.length, 1); // still counts while open
  Admin.decideDispute(s.ctx(D, '15:00'), varun, v.id, false, 'Checked CCTV, it was a customer');
  assert.equal(Att.myMonth(s.ctx(D, '15:01'), 'harsh', '2026-11').violations.length, 0);
  assert.equal(s.db.rows('Violations').length, 1); // the row stays
});

test('edit: re-runs every check; an edit into a clash is refused; an edit can go back to pending', () => {
  const s = seed(); const c = s.ctx('2026-11-10', '10:00'); const neha = s.actor('Neha');
  Core.submitLeave(c, s.actor('Vikas'), leave(['2026-11-19']));
  const r = Core.submitLeave(c, neha, leave(['2026-11-18']));
  assert.equal(r.status, 'Approved');
  assert.match(code(() => Admin.editLeave(c, neha, r.id, leave(['2026-11-19']))), /Not allowed: Vikas is off/);
  assert.match(code(() => Admin.editLeave(c, s.actor('Harsh'), r.id, leave(['2026-11-20']))), /FORBIDDEN/);
  // Same date is allowed (the request does not clash with itself); a short-notice date goes to Aakash.
  assert.equal(Admin.editLeave(c, neha, r.id, leave(['2026-11-18'], { reasonText: 'Bank and LIC work' })).status, 'Approved');
  assert.equal(Admin.editLeave(c, neha, r.id, leave(['2026-11-11'])).status, 'Pending with Aakash');
  const row = s.db.rows('LeaveRequests').find(x => x.id === r.id);
  assert.deepEqual(row.dates, ['2026-11-11']);
  assert.equal(row.history.filter(h => h.action === 'edited').length, 2);
  assert.equal(s.db.rows('LeaveRequests').length, 2); // edited in place, with history
  // The old date is free again for the Sales partner.
  assert.equal(Core.previewLeave(c, s.actor('Harsh'), leave(['2026-11-18'])).decision, 'auto');
});

test('edit: a violation earned by the old version is withdrawn', () => {
  const s = seed(); const neha = s.actor('Neha'), aakash = s.actor('Aakash');
  const c = s.ctx(D, '08:00');
  const r = Core.submitLeave(c, neha, leave([D])); // unannounced
  Core.decideLeave(c, aakash, r.id, true);
  assert.equal(Att.myMonth(c, 'neha', '2026-11').violations.length, 1);
  Admin.editLeave(c, aakash, r.id, leave(['2026-11-30']));
  assert.equal(Att.myMonth(c, 'neha', '2026-11').violations.length, 0);
});

test('override: only Varun, with a written reason; it beats a clash and is logged', () => {
  const s = seed(); const c = s.ctx('2026-11-10', '10:00'); const varun = s.actor('Varun');
  Core.submitLeave(c, s.actor('Vikas'), leave(['2026-11-19']));
  const input = leave(['2026-11-19'], { forPersonId: 'neha', overrideReason: 'Her wedding in the family, agreed in person' });
  assert.match(code(() => Admin.overrideLeave(c, s.actor('Aakash'), input)), /FORBIDDEN/);
  assert.match(code(() => Admin.overrideLeave(c, varun, { ...input, overrideReason: '' })), /REASON/);
  const r = Admin.overrideLeave(c, varun, input);
  assert.equal(r.status, 'Approved');
  assert.match(s.db.rows('LeaveRequests').find(x => x.id === r.id).override, /wedding/);
  assert.ok(s.db.rows('Audit').some(a => a.action === 'leave.override'));
});

test('settings: owner only; every change is audited; salary is not copied into the audit log', () => {
  const s = seed(); const c = s.ctx(D, '12:00'); const varun = s.actor('Varun'), aakash = s.actor('Aakash');
  assert.match(code(() => Admin.getSettings(c, aakash)), /FORBIDDEN/);
  assert.match(code(() => Admin.setPay(c, aakash, { personId: 'neha', fixedSalary: 1, targetAllowance: 0, disciplineBonus: 0, dutyHours: 9 })), /FORBIDDEN/);
  Admin.setPay(c, varun, { personId: 'neha', fixedSalary: 18500, targetAllowance: 2000, disciplineBonus: 500, dutyHours: 9 });
  Admin.setPay(c, varun, { personId: 'neha', fixedSalary: 19000, targetAllowance: 2000, disciplineBonus: 500, dutyHours: 9 });
  assert.equal(s.db.rows('PayInfo').filter(p => p.personId === 'neha').length, 1);
  assert.equal(JSON.stringify(s.db.rows('Audit')).includes('19000'), false);
  const set = Admin.getSettings(c, varun);
  assert.equal(set.people.find(p => p.id === 'neha').pay.fixedSalary, 19000);
  assert.equal(JSON.stringify(set).includes('pinHash'), false);
});

test('settings: add a new joiner, change duty time, switch a rule off, change the grace table', () => {
  const s = seed(); const c = s.ctx(D, '12:00'); const varun = s.actor('Varun');
  const base = { name: 'Garvit', group: 'Calls', role: 'staff', dutyStart: '10:00', dutyEnd: '19:00', sundayOff: [1, 2], active: true };
  assert.match(code(() => Admin.savePerson(c, varun, { ...base, dutyEnd: '09:00' })), /Duty times/);
  assert.match(code(() => Admin.savePerson(c, varun, { ...base, name: 'Neha' })), /already has this name/);
  const id = Admin.savePerson(c, varun, base).id;
  Admin.savePerson(c, varun, { ...base, id, dutyStart: '09:30', dutyEnd: '18:30' });
  assert.equal(s.db.rows('People').find(p => p.id === id).dutyStart, '09:30');
  assert.match(code(() => Admin.savePerson(c, varun, { id: 'varun', name: 'Varun', group: 'Owner', role: 'staff', dutyStart: '10:00', dutyEnd: '19:00', sundayOff: [] })), /always be one owner/);

  s.db.insert('Rules', { id: 'C2', on: true, label: 'Calls', members: ['Bhawna', 'Pooja'], minPresent: 1 });
  Core.submitLeave(s.ctx('2026-11-10', '10:00'), s.actor('Bhawna'), leave(['2026-11-18']));
  assert.equal(Core.previewLeave(s.ctx('2026-11-10', '10:00'), s.actor('Pooja'), leave(['2026-11-18'])).decision, 'blocked');
  Admin.saveRule(c, varun, { id: 'C2', on: false, label: 'Calls', members: ['Bhawna', 'Pooja'], minPresent: 1 });
  assert.notEqual(Core.previewLeave(s.ctx('2026-11-10', '10:00'), s.actor('Pooja'), leave(['2026-11-18'])).decision, 'blocked');
  assert.match(code(() => Admin.saveRule(c, varun, { label: 'Bad', members: ['Bhawna', 'Nobody'], minPresent: 1 })), /at least 2 people/);

  Admin.setSetting(c, varun, 'graceTable', Admin.DEFAULT_GRACE.map(g => g.key === 'chai-cup' ? { ...g, grace: 0 } : g));
  assert.equal(Admin.recordIncident(c, s.actor('Aakash'), { personId: 'harsh', item: 'chai-cup', note: 'Cup left' }).result, 'violation');
  assert.match(code(() => Admin.setSetting(c, varun, 'anything', 1)), /Unknown setting/);
  assert.ok(s.db.rows('Audit').filter(a => /^(people|rules|settings)\./.test(a.action)).length >= 4);
});

test('restrictions: Aakash can add one; it blocks straight away; shop point is the average of the readings', () => {
  const s = seed(); const c = s.ctx('2026-11-01', '10:00'); const aakash = s.actor('Aakash');
  assert.match(code(() => Admin.saveRestriction(c, s.actor('Neha'), { from: '2026-11-05', to: '2026-11-10', note: 'x', rule: 'no-leave' })), /FORBIDDEN/);
  assert.match(code(() => Admin.saveRestriction(c, aakash, { from: '2026-11-10', to: '2026-11-05', note: 'x', rule: 'no-leave' })), /valid date range/);
  const r = Admin.saveRestriction(c, aakash, { from: '2026-11-05', to: '2026-11-10', note: 'Peak sales season', rule: 'no-leave' });
  assert.equal(Core.previewLeave(c, s.actor('Neha'), leave(['2026-11-06'])).decision, 'blocked');
  assert.notEqual(Core.previewLeave(c, s.actor('Anita'), leave(['2026-11-06'])).decision, 'blocked'); // default excludes Anita
  Admin.saveRestriction(c, aakash, { id: r.id, from: '2026-11-05', to: '2026-11-10', note: 'Peak sales season', rule: 'no-leave', on: false });
  assert.notEqual(Core.previewLeave(c, s.actor('Neha'), leave(['2026-11-06'])).decision, 'blocked');
  assert.match(code(() => Admin.setShopPoint(c, aakash, [{ lat: 29.1, lng: 75.7 }])), /Not enough/);
  const p = Admin.setShopPoint(c, aakash, [{ lat: 29.1490, lng: 75.7215 }, { lat: 29.1492, lng: 75.7217 }, { lat: 29.1494, lng: 75.7219 }]);
  assert.equal(p.lat.toFixed(4), '29.1492');
  assert.equal(Att.checkIn(s.ctx(D, '09:30'), s.actor('Neha'), { lat: 29.1492, lng: 75.7217 }).flag, '');
});

test('board: in, late, not in yet, on leave, out right now, roster off', () => {
  const s = seed(); const aakash = s.actor('Aakash');
  Core.submitLeave(s.ctx('2026-11-20', '10:00'), s.actor('Vikas'), leave([D]));
  Att.checkIn(s.ctx(D, '09:30'), s.actor('Neha'));
  Att.checkIn(s.ctx(D, '10:55'), s.actor('Harsh'));
  Att.checkIn(s.ctx(D, '09:30'), s.actor('Manish'));
  const o = Att.goingOut(s.ctx(D, '12:00'), s.actor('Manish'), { reason: 'Bank', expectedMinutes: 20 });
  Att.decideOuting(s.ctx(D, '12:01'), aakash, o.id, true);
  const b = Views.board(s.ctx(D, '12:30'), aakash);
  const st = n => b.people.find(p => p.name === n);
  assert.equal(st('Neha').state, 'In');
  assert.equal(st('Harsh').lateMinutes, 25);
  assert.equal(st('Vikas').state, 'On leave');
  assert.equal(st('Manish').state, 'Out right now');
  assert.equal(st('Raunak').state, 'Not in yet \u2013 late');
  assert.equal(Views.board(s.ctx('2026-11-15', '12:00'), aakash).people.find(p => p.name === 'Neha').state, 'Roster off');
  assert.match(code(() => Views.board(s.ctx(D, '12:30'), s.actor('Neha'))), /FORBIDDEN/);
  assert.deepEqual(Views.todayAtGJ(s.ctx(D, '12:30')).map(x => x.name).sort(), ['Harsh', 'Manish', 'Neha']);
});

test('calendar: roster Sundays, leaves, restrictions and clash-risk days', () => {
  const s = seed(); const aakash = s.actor('Aakash'); const c = s.ctx('2026-11-01', '10:00');
  Core.submitLeave(c, s.actor('Vikas'), leave(['2026-11-19']));
  Admin.saveRestriction(c, aakash, { from: '2026-11-05', to: '2026-11-06', note: 'Peak sales season', rule: 'no-leave' });
  const cal = Views.calendar(c, aakash, '2026-11');
  const day = d => cal.days.find(x => x.date === '2026-11-' + d);
  assert.equal(cal.days.length, 30);
  assert.ok(day('19').risk.includes('Sales'));       // Vikas away: Sales is at its minimum
  assert.equal(day('18').risk.includes('Sales'), false);
  assert.ok(day('15').entries.some(e => e.name === 'Neha' && e.kind === 'roster'));
  assert.equal(day('05').restrictions[0].note, 'Peak sales season');
  assert.equal(Views.myRestrictions(c, s.actor('Neha')).length, 1);
  assert.equal(Views.myRestrictions(c, s.actor('Anita')).length, 0);
});

test('month lock: only after the month ends; the locked result never changes; corrections are new entries', () => {
  const s = seed(); const aakash = s.actor('Aakash');
  s.db.insert('PayInfo', { personId: 'harsh', fixedSalary: 17000, targetAllowance: 0, disciplineBonus: 500, dutyHours: 9 });
  Att.checkIn(s.ctx('2026-10-12', '10:55'), s.actor('Harsh')); // 15 counted, not informed
  assert.match(code(() => Views.lockMonth(s.ctx('2026-10-31', '21:00'), aakash, '2026-10')), /only after it has ended/);
  assert.equal(Views.monthReport(s.ctx('2026-11-01', '10:00'), aakash, '2026-10').locked, false);
  Views.lockMonth(s.ctx('2026-11-01', '10:00'), aakash, '2026-10');
  assert.match(code(() => Views.lockMonth(s.ctx('2026-11-01', '10:01'), aakash, '2026-10')), /already locked/);
  s.db.insert('DayMinutes', { id: 'late-added', personId: 'harsh', date: '2026-10-13', kind: 'late', minutes: 60, informed: true, statedMinutes: '', source: 't' });
  const rep = Views.monthReport(s.ctx('2026-11-02', '10:00'), aakash, '2026-10');
  assert.equal(rep.locked, true);
  assert.equal(rep.people.find(p => p.name === 'Harsh').bank.used, 15); // unchanged by the later row
  assert.match(code(() => Core.submitLeave(s.ctx('2026-11-02', '10:00'), aakash, leave(['2026-10-20'], { forPersonId: 'harsh' }))), /locked/);
  Views.addCorrection(s.ctx('2026-11-02', '11:00'), aakash, '2026-10', 'harsh', '13 Oct: 1 hour late was missed');
  assert.equal(Views.monthReport(s.ctx('2026-11-02', '12:00'), aakash, '2026-10').corrections.length, 1);
  assert.match(code(() => Views.monthReport(s.ctx('2026-11-02', '12:00'), s.actor('Neha'), '2026-10')), /FORBIDDEN/);
});
