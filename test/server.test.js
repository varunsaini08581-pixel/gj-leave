// Server core: login, phone binding, leave flow, concurrency, privacy of actions.
const test = require('node:test');
const assert = require('node:assert/strict');
const Core = require('../src/server/core.js');
const { seed } = require('./helpers.js');

const leave = (dates, extra) => ({ kind: 'full', dates, reasonCode: 'Personal work', reasonText: 'Bank work', ...extra });
const code = fn => { try { fn(); } catch (e) { return e.code; } return 'NO_ERROR'; };

test('PIN: only the owner sets it; wrong PIN 5 times locks for 15 minutes', () => {
  const s = seed(); const c = s.ctx('2026-11-20', '10:00');
  assert.equal(code(() => Core.setPin(c, s.actor('Aakash'), 'neha', '1234')), 'FORBIDDEN');
  Core.setPin(c, s.actor('Varun'), 'neha', '1234');
  assert.equal(s.db.rows('People').find(p => p.id === 'neha').pinHash.includes('1234'), false); // never stored plain
  for (let i = 0; i < 5; i++) assert.equal(code(() => Core.login(c, 'neha', '0000')), 'LOGIN');
  assert.equal(code(() => Core.login(c, 'neha', '1234')), 'LOCKED');
  const later = s.ctx('2026-11-20', '10:16');
  assert.equal(Core.login(later, 'neha', '1234').deviceStatus, 'pending');
});

test('phone binding: a new phone needs the owner; a second phone cannot sign in without approval', () => {
  const s = seed(); const c = s.ctx('2026-11-20', '10:00'); const varun = s.actor('Varun');
  Core.setPin(c, varun, 'neha', '1234');
  const first = Core.login(c, 'neha', '1234', null, 'Redmi');
  assert.equal(first.ok, false);
  assert.equal(code(() => Core.authenticate(c, 'neha', first.deviceToken)), 'AUTH'); // pending phone is useless
  assert.equal(code(() => Core.decideDevice(c, s.actor('Aakash'), first.deviceId, true)), 'FORBIDDEN');
  Core.decideDevice(c, varun, first.deviceId, true);
  assert.equal(Core.authenticate(c, 'neha', first.deviceToken).name, 'Neha');

  const second = Core.login(c, 'neha', '1234', null, 'Other phone');
  assert.equal(second.deviceStatus, 'pending');
  assert.equal(code(() => Core.authenticate(c, 'neha', second.deviceToken)), 'AUTH');
  // One person cannot act as another: Neha's token does not work for Vikas.
  assert.equal(code(() => Core.authenticate(c, 'vikas', first.deviceToken)), 'AUTH');
  // Changing phones: approving the new one revokes the old one.
  Core.decideDevice(c, varun, second.deviceId, true);
  assert.equal(code(() => Core.authenticate(c, 'neha', first.deviceToken)), 'AUTH');
  assert.equal(Core.authenticate(c, 'neha', second.deviceToken).name, 'Neha');
});

test('owner bootstrap: only the very first owner phone is approved automatically', () => {
  const s = seed(); const c = s.ctx('2026-11-20', '10:00');
  s.db.update('People', 'varun', { pinSalt: 'x', pinHash: require('./helpers.js').env.sha256('x:9999') });
  assert.equal(Core.login(c, 'varun', '9999').deviceStatus, 'approved');
  assert.equal(Core.login(c, 'varun', '9999').deviceStatus, 'pending');
});

test('auto-approved: 1 day, 48 h notice, no clash, inside the 5, no violation', () => {
  const s = seed(); const c = s.ctx('2026-11-20', '10:00');
  const p = Core.previewLeave(c, s.actor('Neha'), leave(['2026-11-25']));
  assert.equal(p.decision, 'auto');
  assert.equal(p.type, 'Regular');
  const r = Core.submitLeave(c, s.actor('Neha'), leave(['2026-11-25']));
  assert.equal(r.status, 'Approved');
});

test('vague or incomplete requests cannot be sent', () => {
  const s = seed(); const c = s.ctx('2026-11-20', '10:00'); const neha = s.actor('Neha');
  assert.equal(code(() => Core.submitLeave(c, neha, leave([]))), 'BLOCKED');
  assert.equal(code(() => Core.submitLeave(c, neha, leave(['2026-11-25'], { reasonText: '  ' }))), 'BLOCKED');
  assert.equal(code(() => Core.submitLeave(c, neha, leave(['2026-11-25'], { reasonCode: 'maybe' }))), 'BLOCKED');
  assert.equal(code(() => Core.submitLeave(c, neha, leave(['2026-11-25', '2026-11-27']))), 'BLOCKED');
  assert.equal(code(() => Core.submitLeave(c, neha, leave(['2026-11-25'], { kind: 'half' }))), 'BLOCKED');
});

test('each person applies only for themselves; Aakash entries are labelled', () => {
  const s = seed(); const c = s.ctx('2026-11-20', '10:00');
  assert.equal(code(() => Core.submitLeave(c, s.actor('Neha'), leave(['2026-11-25'], { forPersonId: 'vikas' }))), 'FORBIDDEN');
  const r = Core.submitLeave(c, s.actor('Aakash'), leave(['2026-11-25'], { forPersonId: 'vikas' }));
  assert.equal(s.db.rows('LeaveRequests').find(x => x.id === r.id).enteredBy, 'aakash');
});

test('clash: the second Sales request for the same day cannot even be sent', () => {
  const s = seed(); const c = s.ctx('2026-11-20', '10:00');
  Core.submitLeave(c, s.actor('Vikas'), leave(['2026-11-25']));
  const p = Core.previewLeave(c, s.actor('Neha'), leave(['2026-11-25']));
  assert.equal(p.decision, 'blocked');
  assert.match(p.reasons[0], /^Not allowed: Vikas is off on 25 Nov/);
  assert.equal(p.reasons[0].includes('Bank work'), false); // never the other person's reason
  assert.equal(code(() => Core.submitLeave(c, s.actor('Neha'), leave(['2026-11-25']))), 'BLOCKED');
});

test('concurrency: two pending clashing requests - only the first approval passes', () => {
  const s = seed(); const c = s.ctx('2026-11-24', '12:00'); const aakash = s.actor('Aakash');
  // Both are emergencies (under 36 h), so both go to Aakash and neither blocks the other while pending.
  const a = Core.submitLeave(c, s.actor('Bhawna'), leave(['2026-11-25']));
  const b = Core.submitLeave(c, s.actor('Pooja'), leave(['2026-11-25']));
  assert.equal(a.status, 'Pending with Aakash');
  assert.equal(b.status, 'Pending with Aakash');
  assert.equal(Core.decideLeave(c, aakash, a.id, true).status, 'Approved');
  assert.equal(Core.decideLeave(c, aakash, b.id, true).status, 'Rejected – clash');
  assert.equal(code(() => Core.decideLeave(c, aakash, b.id, true)), 'NOT_FOUND');
});

test('who decides: 3 in a row = Aakash; more than 3 = Aakash AND Varun; one no rejects', () => {
  const s = seed(); const c = s.ctx('2026-11-10', '10:00');
  const aakash = s.actor('Aakash'), varun = s.actor('Varun');
  const three = Core.submitLeave(c, s.actor('Harsh'), leave(['2026-11-17', '2026-11-18', '2026-11-19']));
  assert.equal(three.status, 'Pending with Aakash');
  const four = Core.submitLeave(c, s.actor('Manish'), leave(['2026-11-17', '2026-11-18', '2026-11-19', '2026-11-20']));
  assert.equal(four.status, 'Special – waiting');
  assert.equal(Core.decideLeave(c, varun, four.id, true).status, 'Special – waiting'); // either order
  assert.equal(Core.decideLeave(c, aakash, four.id, true).status, 'Approved');
  const four2 = Core.submitLeave(c, s.actor('Pooja'), leave(['2026-11-23', '2026-11-24', '2026-11-25', '2026-11-26']));
  Core.decideLeave(c, aakash, four2.id, true);
  assert.equal(code(() => Core.decideLeave(c, varun, four2.id, false, '')), 'REASON');
  assert.equal(Core.decideLeave(c, varun, four2.id, false, 'Peak week').status, 'Rejected');
});

test('nobody approves their own; staff cannot decide; Aakash leave goes to Varun', () => {
  const s = seed(); const c = s.ctx('2026-11-10', '10:00');
  const r = Core.submitLeave(c, s.actor('Aakash'), leave(['2026-11-17']));
  assert.equal(r.status, 'Pending with Varun');
  assert.equal(code(() => Core.decideLeave(c, s.actor('Aakash'), r.id, true)), 'FORBIDDEN');
  assert.equal(code(() => Core.decideLeave(c, s.actor('Neha'), r.id, true)), 'FORBIDDEN');
  assert.equal(Core.decideLeave(c, s.actor('Varun'), r.id, true).status, 'Approved');
});

test('Muskan: recorded only. Anita: always Aakash, never blocked by clash', () => {
  const s = seed(); const c = s.ctx('2026-11-10', '10:00');
  assert.equal(Core.submitLeave(c, s.actor('Muskan'), leave(['2026-11-17'])).status, 'Recorded');
  assert.equal(Core.submitLeave(c, s.actor('Anita'), leave(['2026-11-17'])).status, 'Pending with Aakash');
});

test('unannounced leave (under 3 h) goes to Aakash and gives 1 violation when granted', () => {
  const s = seed(); const c = s.ctx('2026-11-25', '08:00'); // Neha's duty starts 09:30
  const p = Core.previewLeave(c, s.actor('Neha'), leave(['2026-11-25']));
  assert.equal(p.type, 'Unannounced');
  const r = Core.submitLeave(c, s.actor('Neha'), leave(['2026-11-25']));
  assert.equal(s.db.rows('Violations').length, 0);
  Core.decideLeave(c, s.actor('Aakash'), r.id, true);
  assert.deepEqual(s.db.rows('Violations').map(v => v.rule), ['unannounced-leave']);
});

test('3rd emergency in a month: violation, flagged as not a free leave', () => {
  const s = seed(); const aakash = s.actor('Aakash'); const harsh = s.actor('Harsh');
  ['2026-11-10', '2026-11-12', '2026-11-17'].forEach((d, i) => {
    const c = s.ctx(d, '00:30'); // 10 hours before duty = Emergency
    const p = Core.previewLeave(c, harsh, leave([d]));
    assert.equal(p.type, 'Emergency');
    assert.equal(p.emergencyNo, i + 1);
    assert.equal(p.penaltyEmergency, i === 2);
    Core.decideLeave(c, aakash, Core.submitLeave(c, harsh, leave([d])).id, true);
  });
  assert.deepEqual(s.db.rows('Violations').map(v => v.rule), ['emergency-beyond-2']);
});

test('restricted period: no-leave blocks; violation-type allows with 1 violation for the whole request', () => {
  const s = seed(); const c = s.ctx('2026-11-01', '10:00');
  s.db.insert('Restrictions', { id: 'R1', from: '2026-11-05', to: '2026-11-10', note: 'Peak sales season', rule: 'no-leave', appliesTo: null, on: true });
  s.db.insert('Restrictions', { id: 'R2', from: '2026-11-16', to: '2026-11-20', note: 'Stock week', rule: 'violation', appliesTo: null, on: true });
  assert.equal(code(() => Core.submitLeave(c, s.actor('Neha'), leave(['2026-11-06']))), 'BLOCKED');
  const r = Core.submitLeave(c, s.actor('Neha'), leave(['2026-11-17', '2026-11-18']));
  assert.equal(r.status, 'Approved');
  assert.equal(s.db.rows('Violations').filter(v => v.rule === 'leave-in-restricted-period').length, 1);
});

test('cancel: own request before it starts; after start only Aakash or Varun with a reason; rows stay', () => {
  const s = seed(); const c = s.ctx('2026-11-20', '10:00'); const neha = s.actor('Neha');
  const r = Core.submitLeave(c, neha, leave(['2026-11-25']));
  assert.equal(code(() => Core.cancelLeave(c, s.actor('Vikas'), r.id)), 'FORBIDDEN');
  const during = s.ctx('2026-11-25', '12:00');
  assert.equal(code(() => Core.cancelLeave(during, neha, r.id)), 'FORBIDDEN');
  assert.equal(code(() => Core.cancelLeave(during, s.actor('Aakash'), r.id, '')), 'REASON');
  assert.equal(Core.cancelLeave(during, s.actor('Aakash'), r.id, 'Came to work').status, 'Cancelled');
  assert.equal(s.db.rows('LeaveRequests').length, 1); // never deleted
  // After a cancel the slot is free again.
  assert.equal(Core.previewLeave(c, s.actor('Vikas'), leave(['2026-11-25'])).decision, 'auto');
});

test('overlapping requests by the same person are refused', () => {
  const s = seed(); const c = s.ctx('2026-11-10', '10:00'); const neha = s.actor('Neha');
  Core.submitLeave(c, neha, leave(['2026-11-17']));
  assert.equal(code(() => Core.submitLeave(c, neha, leave(['2026-11-17', '2026-11-18']))), 'BLOCKED');
});
