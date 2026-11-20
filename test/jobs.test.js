// Timed jobs: emails, reminders, proactive warnings, evening reminder, end of day.
const test = require('node:test');
const assert = require('node:assert/strict');
const Core = require('../src/server/core.js');
const Att = require('../src/server/attendance.js');
const Jobs = require('../src/server/jobs.js');
const { seed, env } = require('./helpers.js');

const leave = (dates, extra) => ({ kind: 'full', dates, reasonCode: 'Personal work', reasonText: 'Bank work', ...extra });
const D = '2026-11-25';
const mailer = (quota = 100) => { const m = { sent: [], quota: () => quota - m.sent.length, send: (to, subject, body) => m.sent.push({ to, subject, body }) }; return m; };
const notes = (s, to, kind) => s.db.rows('Notifications').filter(n => n.to === to && (!kind || n.kind === kind));

test('pending request reminds Aakash every 2 hours, not before, and stops once decided', () => {
  const s = seed(); const aakash = s.actor('Aakash');
  const r = Core.submitLeave(s.ctx('2026-11-24', '12:00'), s.actor('Neha'), leave([D]));
  assert.equal(Jobs.reminders(s.ctx('2026-11-24', '13:59')), 0);
  assert.equal(Jobs.reminders(s.ctx('2026-11-24', '14:00')), 1);
  assert.equal(Jobs.reminders(s.ctx('2026-11-24', '15:00')), 0);
  assert.equal(Jobs.reminders(s.ctx('2026-11-24', '16:00')), 1);
  assert.equal(notes(s, 'aakash', 'reminder').length, 2);
  Core.decideLeave(s.ctx('2026-11-24', '16:05'), aakash, r.id, true);
  assert.equal(Jobs.reminders(s.ctx('2026-11-24', '20:00')), 0);
});

test('reminder hours come from Settings; special approval reminds only the one who has not decided', () => {
  const s = seed();
  s.db.insert('Settings', { key: 'reminderHours', value: '1' });
  const r = Core.submitLeave(s.ctx('2026-11-10', '10:00'), s.actor('Manish'), leave(['2026-11-17', '2026-11-18', '2026-11-19', '2026-11-20']));
  Core.decideLeave(s.ctx('2026-11-10', '10:10'), s.actor('Aakash'), r.id, true);
  assert.equal(Jobs.reminders(s.ctx('2026-11-10', '11:00')), 1);
  assert.equal(notes(s, 'aakash', 'reminder').length, 0);
  assert.equal(notes(s, 'varun', 'reminder').length, 1);
});

test('emails: one digest per person; people with no address stay in-app; quota is respected', () => {
  const s = seed();
  s.db.update('People', 'aakash', { email: 'aakash@example.test' });
  Core.submitLeave(s.ctx('2026-11-24', '12:00'), s.actor('Neha'), leave([D]));
  Core.submitLeave(s.ctx('2026-11-24', '12:01'), s.actor('Raunak'), leave([D]));
  const c = s.ctx('2026-11-24', '12:05'); c.env = { ...env, ownerEmail: 'owner@example.test' };
  const none = mailer(0);
  assert.equal(Jobs.sendEmails(c, none), 0);           // no quota: nothing sent, nothing marked
  const m = mailer();
  assert.equal(Jobs.sendEmails(c, m), 1);
  assert.equal(m.sent[0].to, 'aakash@example.test');
  assert.match(m.sent[0].subject, /2 updates/);
  assert.equal(Jobs.sendEmails(c, m), 0);              // nothing is emailed twice
  assert.equal(m.sent.some(e => /17000|salary/i.test(e.body)), false);
});

test('owner gets email at the deploying account when no address is set', () => {
  const s = seed(); const c = s.ctx(D, '21:00'); c.env = { ...env, ownerEmail: 'owner@example.test' };
  Jobs.endOfDay(c);
  const m = mailer(); Jobs.sendEmails(c, m);
  assert.ok(m.sent.some(e => e.to === 'owner@example.test' && /Daily summary/.test(e.subject + e.body)));
});

test('proactive warnings: bank 80%, passes used, 1 more violation - each only once a month', () => {
  const s = seed(); const harsh = s.actor('Harsh');
  ['02', '03', '04', '05'].forEach(d => Att.checkIn(s.ctx('2026-11-' + d, '11:00'), harsh)); // 4 x 30 min not informed = 80 counted
  s.db.insert('DayMinutes', { id: 'x', personId: 'harsh', date: '2026-11-06', kind: 'early', minutes: 20, informed: true, statedMinutes: '', source: 't' });
  assert.ok(Jobs.warnings(s.ctx('2026-11-06', '20:00')) >= 2);
  const kinds = notes(s, 'harsh').map(n => n.kind);
  assert.ok(kinds.includes('warn-bank80'));
  assert.ok(kinds.includes('warn-passes'));
  assert.equal(Jobs.warnings(s.ctx('2026-11-06', '21:00')), 0);
  Att.checkIn(s.ctx('2026-11-07', '11:00'), harsh);           // 5th not-informed time = violation
  Jobs.warnings(s.ctx('2026-11-07', '12:00'));
  assert.equal(notes(s, 'harsh', 'warn-v1').length, 1);
});

test('notice stage (3 violations) goes to Varun once', () => {
  const s = seed();
  ['02', '03', '04'].forEach(d => Att.checkIn(s.ctx('2026-11-' + d, '11:30'), s.actor('Harsh'))); // 3 x over 30 min not informed
  Jobs.warnings(s.ctx('2026-11-04', '12:00')); Jobs.warnings(s.ctx('2026-11-04', '13:00'));
  assert.equal(notes(s, 'varun', 'notice-stage').length, 1);
});

test('evening before: leave starting tomorrow gets one reminder', () => {
  const s = seed();
  Core.submitLeave(s.ctx('2026-11-20', '10:00'), s.actor('Neha'), leave([D]));
  assert.equal(Jobs.eveningBefore(s.ctx('2026-11-23', '19:00')), 0);
  assert.equal(Jobs.eveningBefore(s.ctx('2026-11-24', '19:00')), 1);
  assert.equal(Jobs.eveningBefore(s.ctx('2026-11-24', '19:30')), 0);
});

test('end of day: absent check + daily summary to Varun + missing check-out to Aakash', () => {
  const s = seed();
  Core.submitLeave(s.ctx('2026-11-20', '10:00'), s.actor('Vikas'), leave([D]));
  ['Neha', 'Raunak', 'Manish', 'Bhawna', 'Pooja', 'Anita', 'Muskan'].forEach(n => Att.checkIn(s.ctx(D, '09:30'), s.actor(n)));
  Att.checkOut(s.ctx(D, '18:30'), s.actor('Neha'));
  const r = Jobs.run(s.ctx(D, '21:00'), 'endOfDay');
  assert.deepEqual(r.absent, ['Harsh']);
  const sum = notes(s, 'varun', 'daily-summary')[0].body;
  assert.match(sum, /On leave: Vikas/);
  assert.match(sum, /Absent with no request: Harsh/);
  assert.equal(notes(s, 'aakash', 'missing-checkout').length, 1);
  Jobs.run(s.ctx(D, '21:10'), 'endOfDay');
  assert.equal(notes(s, 'varun', 'daily-summary').length, 1);
});
