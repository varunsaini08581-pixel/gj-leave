// Round 13: rules and counting over the whole life of a record (what is changed AFTERWARDS), commit b471950, server version 9, schema 4.
// Every test states what must hold and FAILS on the code as reviewed, for the reason in its name.
// Everything is driven through Api.handle on the Sheet store (fake Sheet + read cache), the way doPost does it, and through Jobs.run.
// Run: node --test /home/claude/findings/repro-round13.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const SRC = '/home/claude/gj-leave/src/';
const Store = require(SRC + 'server/store.js');
const Api = require(SRC + 'server/api.js');
const Jobs = require(SRC + 'server/jobs.js');
const { wrap } = require(SRC + 'server/cachegrid.js');
const { TABS } = require(SRC + 'server/schema.js');

// ------------------------------------------------------------------ harness (same shape as sim-round8)
function fakeGrid() {
  const tabs = {};
  const g = { tabs, tabNames: () => Object.keys(tabs), addTab: n => { tabs[n] = []; }, read: n => (tabs[n] || []).map(r => r.slice()),
    headers: n => (tabs[n] && tabs[n][0] || []).slice(), tail: (n, k) => tabs[n].slice(1).slice(-k).map(r => r.slice()),
    append: (n, row) => g.appendMany([{ tab: n, rows: [row] }])[n], appendRows: (n, rows) => g.appendMany([{ tab: n, rows }])[n],
    appendMany: batch => { const first = {}; batch.forEach(b => { first[b.tab] = tabs[b.tab].length; b.rows.forEach(r => tabs[b.tab].push(r.map(String))); }); return first; },
    writeRow: (n, i, row) => { tabs[n][i] = row.map(String); } };
  return g;
}
function fakeCache() { const m = new Map(); return { getAll: keys => { const o = {}; keys.forEach(k => { if (m.has(k)) o[k] = m.get(k); }); return o; }, put: (k, v) => m.set(k, v), putAll: map => Object.keys(map).forEach(k => m.set(k, map[k])) }; }
const ROSTER = [
  ['Neha', 'Sales', 'staff', '09:30', '18:30', [3, 4]], ['Vikas', 'Sales', 'staff', '11:00', '20:00', [1, 2]], ['Harsh', 'Sales', 'staff', '10:30', '19:30', [1, 2]],
  ['Raunak', 'Repairing', 'staff', '10:30', '19:30', [1, 2]], ['Manish', 'Repairing', 'staff', '09:30', '18:30', [3, 4]], ['Muskan', 'Testing', 'staff', '10:45', '19:45', []],
  ['Bhawna', 'Calls', 'staff', '09:30', '18:30', [3, 4]], ['Pooja', 'Calls', 'staff', '10:00', '19:00', [1, 2]], ['Anita', 'Housekeeping', 'staff', '09:30', '17:30', 'every'],
  ['Aakash', 'Manager', 'manager', '10:00', '19:00', []], ['Varun', 'Owner', 'owner', '10:00', '19:00', []],
];
const ist = (date, hhmm) => Date.parse(date + 'T' + hhmm + ':00+05:30');
const PIC = { photo: 'data:image/jpeg;base64,AAAA', thumb: 'data:image/jpeg;base64,BBBB', lat: 29.15, lng: 75.72, accuracy: 10 };
const lv = (dates, extra) => Object.assign({ kind: 'full', dates, reasonCode: 'Personal work', reasonText: 'Bank work' }, extra);
/** startDate: the evening job never looks at days before it (so only the people of a test are in play). */
function world(startDate) {
  const g = fakeGrid(); Store.setup(g); const cache = fakeCache(); let vn = 0, seq = 0;
  const env = { sha256: s => crypto.createHash('sha256').update(s).digest('hex'), randomId: () => 'id' + (++seq) + '_' + ('00000' + seq).slice(-6),
    withLock: fn => fn(), photos: {}, savePhoto(name, data) { const id = 'photo_' + name; this.photos[id] = data; return id; }, readPhoto(id) { return this.photos[id]; } };
  const db0 = Store.open(g); const who = {};
  ROSTER.forEach(([name, group, role, dutyStart, dutyEnd, sundayOff]) => {
    const id = name.toLowerCase();
    db0.insert('People', { id, name, group, role, dutyStart, dutyEnd, sundayOff, noApproval: name === 'Muskan', noClash: name === 'Muskan' || name === 'Anita', noQuota: name === 'Muskan', dressExempt: name === 'Anita', active: true, pinTries: 0 });
    db0.insert('Devices', { id: 'dev_' + id, personId: id, tokenHash: env.sha256('tok-' + id), label: '', status: 'approved', requestedAt: 1, decidedAt: 1, decidedBy: 'test' });
    db0.insert('PayInfo', { personId: id, dutyHours: 9, fixedSalary: 17000, targetAllowance: 2000, disciplineBonus: 500 });
    who[id] = { personId: id, deviceToken: 'tok-' + id, role };
  });
  if (startDate) db0.insert('Settings', { key: 'startDate', value: startDate });
  const open = () => Store.open(wrap(g, cache, Object.keys(TABS), () => 'v' + (++vn)), { buffer: true });
  function call(date, hhmm, action, person, args) {
    const db = open(); let depth = 0;
    const e = Object.assign({}, env, { photos: env.photos, withLock(fn) { if (depth > 0) return fn(); depth += 1; try { return fn(); } finally { try { db.flush(); } finally { depth -= 1; } } } });
    const reply = Api.handle({ db, now: ist(date, hhmm), env: e }, Object.assign({ action, clientVersion: 1, args: args || {} }, person ? who[person] : {}));
    db.flush(); return reply;
  }
  function job(date, hhmm, name) {
    const db = open(); let depth = 0;
    const e = Object.assign({}, env, { withLock(fn) { if (depth > 0) return fn(); depth += 1; try { return fn(); } finally { try { db.flush(); } finally { depth -= 1; } } } });
    const out = Jobs.run({ db, now: ist(date, hhmm), env: e }, name, null); db.flush(); return out;
  }
  const ok = r => { assert.equal(r.ok, true, JSON.stringify(r)); return r.data; };
  const sheet = tab => Store.open(g).rows(tab);
  const month = (date, time, p, m) => ok(call(date, time, 'myMonth', 'varun', { personId: p, month: m || date.slice(0, 7) }));
  const live = (p, rule) => sheet('Violations').filter(v => v.personId === p && v.disputeState !== 'removed' && (!rule || v.rule === rule));
  /** Everyone except the named people checks in and out on time (so only they can be absent). */
  const present = (date, except) => ROSTER.filter(r => r[2] === 'staff' && (except || []).indexOf(r[0].toLowerCase()) === -1).forEach(r => {
    const id = r[0].toLowerCase(); call(date, r[3], 'checkIn', id, PIC); call(date, r[4], 'checkOut', id); });
  return { g, call, job, ok, sheet, month, live, present };
}
/** Three granted emergency leaves of Raunak in November (4, 10 and 17 Nov), each asked the evening before. Returns their ids. */
function threeEmergencies(w) {
  return [['2026-11-03', '2026-11-04'], ['2026-11-09', '2026-11-10'], ['2026-11-16', '2026-11-17']].map(([ask, day]) => {
    const r = w.ok(w.call(ask, '18:00', 'submitLeave', 'raunak', lv([day])));
    assert.equal(w.ok(w.call(ask, '18:05', 'decideLeave', 'aakash', { id: r.id, approve: true })).status, 'Approved');
    return r.id;
  });
}
/** A leave asked well ahead and approved (by the system or by Aakash). Returns its id. */
function approvedLeave(w, person, dates, askDate) {
  const r = w.ok(w.call(askDate, '10:00', 'submitLeave', person, lv(dates)));
  // Changed after the review: a 4-day leave needs both approvers (the reviewer's helper stopped at Aakash and the test failed in its set-up).
  if (r.status !== 'Approved') { const a = w.ok(w.call(askDate, '10:05', 'decideLeave', 'aakash', { id: r.id, approve: true })); if (a.status !== 'Approved') assert.equal(w.ok(w.call(askDate, '10:06', 'decideLeave', 'varun', { id: r.id, approve: true })).status, 'Approved'); }
  return r.id;
}
/** Aakash confirms November, Varun locks it. */
function lockNovember(w, date) {
  w.ok(w.call(date, '10:00', 'lockMonth', 'aakash', { month: '2026-11' }));
  assert.equal(w.ok(w.call(date, '10:05', 'lockMonth', 'varun', { month: '2026-11' })).locked, true, 'setup: November is locked');
}
const absences = (w, p) => w.sheet('LeaveRequests').filter(r => r.personId === p && r.route === 'system' && r.status !== 'Cancelled').map(r => r.dates[0]);
const minutesOn = (w, p, date, kind) => w.sheet('DayMinutes').filter(m => m.personId === p && m.date === date && m.minutes > 0 && (!kind || m.kind === kind)).reduce((s, m) => s + m.minutes, 0);

// ====================================================================================================================
// R13-1 (High) hadLeave: ANY leave that was once granted for a day and later cancelled or shortened makes a late arrival on
// that day "informed" - also when the staff member cancelled it herself days before. Nobody approved the lateness.
// ====================================================================================================================
test('R13-1a a leave the staff member cancelled herself the evening before does not make her late arrival "informed"', () => {
  const w = world('2026-11-20');
  const r = w.ok(w.call('2026-11-10', '10:00', 'submitLeave', 'neha', lv(['2026-11-20'])));
  assert.equal(r.status, 'Approved', 'setup: asked 10 days ahead, approved by the system');
  assert.equal(w.ok(w.call('2026-11-19', '20:00', 'cancelLeave', 'neha', { id: r.id })).status, 'Cancelled', 'setup: she cancels it herself before it starts');
  // 20 Nov is now an ordinary working day. She walks in 90 minutes late and has told nobody.
  const cin = w.ok(w.call('2026-11-20', '11:00', 'checkIn', 'neha', PIC));
  assert.equal(cin.lateMinutes, 90);
  assert.equal(cin.informed, false, '90 min late with no late request approved by Aakash is "not informed"');
  assert.equal(w.live('neha', 'not-informed-over-30').length, 1, 'not informed, more than 30 min = 1 violation (owner decision, 20 Nov 16:00)');
});
test('R13-1b a day given back when a leave was shortened the day before is an ordinary working day: late without telling = not informed', () => {
  const w = world('2026-11-18');
  const id = approvedLeave(w, 'neha', ['2026-11-18', '2026-11-19', '2026-11-20'], '2026-11-10');
  w.present('2026-11-18', ['neha']); w.job('2026-11-18', '21:00', 'endOfDay');
  // 19 Nov 08:00, before duty: she is back from today. Aakash ends the leave; 19 and 20 Nov are working days again.
  assert.deepEqual(w.ok(w.call('2026-11-19', '08:00', 'cancelLeave', 'aakash', { id, reason: 'Back from today' })).dates, ['2026-11-18']);
  w.ok(w.call('2026-11-19', '09:30', 'checkIn', 'neha', PIC)); w.ok(w.call('2026-11-19', '18:30', 'checkOut', 'neha'));
  const cin = w.ok(w.call('2026-11-20', '10:30', 'checkIn', 'neha', PIC)); // the NEXT day, 60 min late, nobody told
  assert.equal(cin.informed, false, 'the leave for 20 Nov was given back the day before; this lateness was not known to anybody');
  assert.equal(w.live('neha', 'not-informed-over-30').length, 1);
});

// ====================================================================================================================
// R13-2 (High) "End this leave" on a running leave AFTER the person has checked in: the day that is given back is never
// counted again (cancelLeave reads r.dates after it has overwritten them, so recountDay is never called).
// The same facts with the two taps the other way round are counted.
// ====================================================================================================================
test('R13-2a leave ended on its last day after she checked in at 13:00: the 3 h 30 min count (automatic half day), as they do when Aakash taps first', () => {
  const run = endFirst => {
    const w = world('2026-11-18');
    const id = approvedLeave(w, 'neha', ['2026-11-18', '2026-11-19', '2026-11-20'], '2026-11-10');
    ['2026-11-18', '2026-11-19'].forEach(d => { w.present(d, ['neha']); w.job(d, '21:00', 'endOfDay'); });
    if (endFirst) w.ok(w.call('2026-11-20', '12:30', 'cancelLeave', 'aakash', { id, reason: 'She is coming in' }));
    w.ok(w.call('2026-11-20', '13:00', 'checkIn', 'neha', PIC));
    if (!endFirst) assert.deepEqual(w.ok(w.call('2026-11-20', '13:30', 'cancelLeave', 'aakash', { id, reason: 'She is back' })).dates, ['2026-11-18', '2026-11-19'], 'setup: 20 Nov is given back');
    w.ok(w.call('2026-11-20', '18:30', 'checkOut', 'neha'));
    return w.month('2026-11-20', '20:00', 'neha').leaves;
  };
  const tapFirst = run(true), checkInFirst = run(false);
  assert.equal(tapFirst.taken, 2.5, 'control: Aakash taps first, she arrives at 13:00 = 2 leave days + automatic half day');
  assert.equal(checkInFirst.taken, 2.5, 'she checks in first, Aakash taps afterwards: the same day must count the same; it counts nothing (taken = ' + checkInFirst.taken + ')');
});
test('R13-2b leave ended on a middle day after she checked in 45 min late: those minutes are counted (assumption 57), not lost', () => {
  const w = world('2026-11-18');
  const id = approvedLeave(w, 'neha', ['2026-11-18', '2026-11-19', '2026-11-20', '2026-11-21'], '2026-11-10');
  w.present('2026-11-18', ['neha']); w.job('2026-11-18', '21:00', 'endOfDay');
  w.ok(w.call('2026-11-19', '10:15', 'checkIn', 'neha', PIC)); // she is back early, 45 min after duty start
  assert.deepEqual(w.ok(w.call('2026-11-19', '10:30', 'cancelLeave', 'aakash', { id, reason: 'She is back' })).dates, ['2026-11-18'], 'setup: 19, 20 and 21 Nov are given back');
  assert.equal(minutesOn(w, 'neha', '2026-11-19', 'late'), 45, 'the 45 late minutes of the day that was given back are booked');
});

// ====================================================================================================================
// R13-3 (Medium) Other ways a day gets or loses its leave are not counted again either.
// ====================================================================================================================
test('R13-3a Varun\'s override leave for today, after she came 45 min late: no minutes and no minute violation stay on a full-leave day (assumption 55)', () => {
  const w = world('2026-11-20');
  w.ok(w.call('2026-11-20', '10:15', 'checkIn', 'neha', PIC));
  assert.equal(w.live('neha', 'not-informed-over-30').length, 1, 'setup: 45 min late, not informed');
  w.ok(w.call('2026-11-20', '11:00', 'overrideLeave', 'varun', Object.assign(lv(['2026-11-20']), { forPersonId: 'neha', overrideReason: 'Family emergency, she has to go' })));
  const m = w.month('2026-11-20', '12:00', 'neha');
  assert.equal(m.leaves.taken, 1, 'setup: the day is 1 leave');
  assert.equal(minutesOn(w, 'neha', '2026-11-20'), 0, 'a full-leave day carries no minutes (an ordinary approved leave sets them aside)');
  assert.equal(m.ladder.violations, 0, 'and no "not informed" violation for a day that is a full leave');
});
test('R13-3b Aakash moves a leave to the next day after she came in at 11:30: the 2 hours of the day she worked are counted', () => {
  const w = world('2026-11-20');
  const id = approvedLeave(w, 'neha', ['2026-11-20'], '2026-11-10');
  w.ok(w.call('2026-11-20', '11:30', 'checkIn', 'neha', PIC));
  w.ok(w.call('2026-11-20', '12:00', 'editLeave', 'aakash', Object.assign({ id }, lv(['2026-11-21']))));
  assert.equal(w.ok(w.call('2026-11-20', '12:05', 'decideLeave', 'aakash', { id, approve: true })).status, 'Approved');
  w.ok(w.call('2026-11-20', '18:30', 'checkOut', 'neha'));
  assert.equal(minutesOn(w, 'neha', '2026-11-20', 'late'), 120, '20 Nov is a working day now and she came 120 min late (a cancel on the same day books them; the edit does not)');
});
test('R13-3c a clash rule switched on gives back today\'s leave after he checked in 90 min late: those minutes are counted', () => {
  const w = world('2026-11-20');
  const rules = w.ok(w.call('2026-11-10', '09:00', 'getSettings', 'varun')).rules;
  ['C3', 'C4'].forEach(k => w.ok(w.call('2026-11-10', '09:01', 'saveRule', 'varun', Object.assign({}, rules.find(r => r.id === k), { on: false }))));
  approvedLeave(w, 'raunak', ['2026-11-20'], '2026-11-10'); approvedLeave(w, 'manish', ['2026-11-20'], '2026-11-11');
  w.ok(w.call('2026-11-20', '11:00', 'checkIn', 'manish', PIC));
  const out = w.ok(w.call('2026-11-20', '12:00', 'saveRule', 'varun', Object.assign({}, rules.find(r => r.id === 'C3'), { on: true })));
  assert.equal(out.rejected.length, 1, 'setup: Manish\'s leave (approved last) gives way');
  assert.equal(minutesOn(w, 'manish', '2026-11-20', 'late'), 90, '20 Nov is a working day for Manish now and he came 90 min late');
});
test('R13-3d Aakash confirms "back" with a corrected time after the day became a full leave: no going-out minutes return to the leave day', () => {
  const w = world('2026-11-20');
  w.ok(w.call('2026-11-20', '09:30', 'checkIn', 'neha', PIC));
  const o = w.ok(w.call('2026-11-20', '11:00', 'goingOut', 'neha', { reason: 'Bank', expectedMinutes: 20 }));
  w.ok(w.call('2026-11-20', '11:01', 'decideOuting', 'aakash', { id: o.id, approve: true }));
  w.ok(w.call('2026-11-20', '11:41', 'imBack', 'neha', { id: o.id }));
  const l = w.ok(w.call('2026-11-20', '12:00', 'submitLeave', 'aakash', lv(['2026-11-20'], { forPersonId: 'neha' })));
  assert.equal(w.ok(w.call('2026-11-20', '12:01', 'decideLeave', 'aakash', { id: l.id, approve: true })).status, 'Approved');
  assert.equal(minutesOn(w, 'neha', '2026-11-20'), 0, 'setup: the leave set the 40 min aside');
  w.ok(w.call('2026-11-20', '12:05', 'confirmBack', 'aakash', { id: o.id, correctedTime: '11:36' }));
  assert.equal(minutesOn(w, 'neha', '2026-11-20'), 0, 'still a full-leave day: 1 leave and no minutes from the bank');
});

// ====================================================================================================================
// R13-4 (Medium) recountDay brings set-aside minutes back wrongly: two rows are merged into the "informed" one,
// and a row that was only cut down is not put back.
// ====================================================================================================================
test('R13-4a left 40 min before the approved early time (violation); a leave entered and cancelled by mistake must not turn those 40 min into informed ones', () => {
  const w = world('2026-11-20');
  w.ok(w.call('2026-11-20', '09:25', 'checkIn', 'neha', PIC));
  const q = w.ok(w.call('2026-11-20', '10:00', 'requestShort', 'neha', { kind: 'early', time: '17:30' }));
  w.ok(w.call('2026-11-20', '10:05', 'decideShort', 'aakash', { id: q.id, approve: true }));
  w.ok(w.call('2026-11-20', '16:50', 'checkOut', 'neha'));
  assert.equal(w.live('neha', 'not-informed-over-30').length, 1, 'setup: 60 min informed + 40 min not informed = 1 violation');
  const l = w.ok(w.call('2026-11-20', '17:00', 'submitLeave', 'aakash', lv(['2026-11-20'], { forPersonId: 'neha' })));
  w.ok(w.call('2026-11-20', '17:01', 'decideLeave', 'aakash', { id: l.id, approve: true }));
  w.ok(w.call('2026-11-20', '17:05', 'cancelLeave', 'aakash', { id: l.id, reason: 'Entered for the wrong person' }));
  const notInformed = w.sheet('DayMinutes').filter(m => m.personId === 'neha' && m.minutes > 0 && !m.informed).reduce((s, m) => s + m.minutes, 0);
  assert.equal(notInformed, 40, 'the 40 min nobody was told about come back as they were');
  assert.equal(w.live('neha', 'not-informed-over-30').length, 1, 'and so does the violation');
});
test('R13-4b 5 hours late (violation, full day); a morning half day entered and cancelled by mistake must not leave 30 minutes and no violation', () => {
  const w = world('2026-11-20');
  w.ok(w.call('2026-11-20', '14:30', 'checkIn', 'neha', PIC));
  assert.equal(minutesOn(w, 'neha', '2026-11-20', 'late'), 300, 'setup');
  const l = w.ok(w.call('2026-11-20', '15:00', 'submitLeave', 'aakash', lv(['2026-11-20'], { forPersonId: 'neha', kind: 'half', halfStart: '09:30' })));
  w.ok(w.call('2026-11-20', '15:01', 'decideLeave', 'aakash', { id: l.id, approve: true }));
  assert.equal(minutesOn(w, 'neha', '2026-11-20', 'late'), 30, 'setup: with the half day she is 30 min late');
  w.ok(w.call('2026-11-20', '15:05', 'cancelLeave', 'aakash', { id: l.id, reason: 'Entered for the wrong person' }));
  assert.equal(minutesOn(w, 'neha', '2026-11-20', 'late'), 300, 'the half day is gone: she is 300 min late again');
  assert.equal(w.live('neha', 'not-informed-over-30').length, 1, 'and the violation she had is back');
});

// ====================================================================================================================
// R13-5 (Medium) A closed day entered by mistake and removed after that day: "the day is as before" (assumption 54) does not
// hold for what happened ON that day. Minutes of the check-ins are never counted, an absence is never recorded.
// ====================================================================================================================
test('R13-5a closed day typed for the wrong date and removed 5 days later: the 90 min late of that day are counted', () => {
  const w = world('2026-11-20');
  w.ok(w.call('2026-11-17', '10:00', 'setSetting', 'varun', { key: 'closedDays', value: ['2026-11-20'] })); // meant 22 Nov
  w.present('2026-11-20', ['neha', 'manish']);
  w.ok(w.call('2026-11-20', '11:00', 'checkIn', 'neha', PIC)); w.ok(w.call('2026-11-20', '18:30', 'checkOut', 'neha'));
  w.job('2026-11-20', '21:00', 'endOfDay');
  ['2026-11-21', '2026-11-22', '2026-11-23', '2026-11-24'].forEach(d => { w.present(d, []); w.job(d, '21:00', 'endOfDay'); });
  w.ok(w.call('2026-11-25', '10:00', 'setSetting', 'varun', { key: 'closedDays', value: [] }));
  assert.equal(minutesOn(w, 'neha', '2026-11-20', 'late'), 90, '20 Nov was a working day after all; Neha came 90 min late, not informed');
});
test('R13-5b the same mistake: Manish, who stayed away on that day with no request, is recorded as absent once the closed day is removed', () => {
  const w = world('2026-11-20');
  w.ok(w.call('2026-11-17', '10:00', 'setSetting', 'varun', { key: 'closedDays', value: ['2026-11-20'] }));
  w.present('2026-11-20', ['manish']); w.job('2026-11-20', '21:00', 'endOfDay');
  ['2026-11-21', '2026-11-22', '2026-11-23', '2026-11-24'].forEach(d => { w.present(d, []); w.job(d, '21:00', 'endOfDay'); });
  w.ok(w.call('2026-11-25', '10:00', 'setSetting', 'varun', { key: 'closedDays', value: [] }));
  w.present('2026-11-25', []); w.job('2026-11-25', '21:00', 'endOfDay');
  assert.deepEqual(absences(w, 'manish'), ['2026-11-20'], 'no leave, no check-in on a working day = "Absent – unannounced" (the evening job looks back 3 days only)');
});

// ====================================================================================================================
// R13-6 (Medium) "No approval needed" unticked for a person (the intern becomes regular staff): days from BEFORE the change
// get violations at her next punch. Assumption 38 (roster / active) says a Settings change applies from that day on.
// ====================================================================================================================
test('R13-6 Muskan becomes regular staff on 15 Nov: her lateness of 6 Nov, when she was "recorded only", does not become a violation', () => {
  const w = world('2026-11-06');
  w.ok(w.call('2026-11-06', '12:30', 'checkIn', 'muskan', PIC)); w.ok(w.call('2026-11-06', '19:45', 'checkOut', 'muskan'));
  assert.equal(w.live('muskan').length, 0, 'setup: 105 min late as an intern, recorded only');
  const s = w.ok(w.call('2026-11-15', '10:00', 'getSettings', 'varun')).people.find(p => p.id === 'muskan');
  w.ok(w.call('2026-11-15', '10:01', 'savePerson', 'varun', Object.assign({}, s, { noApproval: false, noQuota: false })));
  w.ok(w.call('2026-11-17', '10:40', 'checkIn', 'muskan', PIC)); w.ok(w.call('2026-11-17', '19:40', 'checkOut', 'muskan')); // on time, 5 min early out
  const old = w.live('muskan').filter(v => v.date < '2026-11-15');
  assert.equal(old.length, 0, 'a violation dated ' + old.map(v => v.date).join(', ') + ' was recorded on 17 Nov for a day on which she could not get one');
});

// ====================================================================================================================
// R13-7 (Medium) The evening job of the last day of the month did not run; the month is locked the next morning. The catch-up
// skips the locked month: the absence of 30 Nov is never recorded and the locked report does not have it.
// ====================================================================================================================
test('R13-7 a month can be locked before the absent check of its last days has run: the absence of 30 Nov is lost', () => {
  const w = world('2026-11-28');
  ['2026-11-28', '2026-11-29'].forEach(d => { w.present(d, []); w.job(d, '21:00', 'endOfDay'); });
  w.present('2026-11-30', ['neha']); // Neha stays away, no request. The 21:00 job of 30 Nov fails (assumption 31: caught up on the next nights).
  const a = w.call('2026-12-01', '10:00', 'lockMonth', 'aakash', { month: '2026-11' }), b = w.call('2026-12-01', '10:05', 'lockMonth', 'varun', { month: '2026-11' });
  w.present('2026-12-01', []); w.job('2026-12-01', '21:00', 'endOfDay');
  if (!(a.ok && b.ok && b.data.locked)) return; // refusing the lock until the absent check has run would be a correct fix
  const nov = w.month('2026-12-02', '10:00', 'neha', '2026-11');
  assert.equal(nov.ladder.violations, 1, 'Neha was absent with no request on 30 Nov: locked November shows ' + nov.leaves.taken + ' leave and ' + nov.ladder.violations + ' violations, and nothing can add it any more');
});

// ====================================================================================================================
// R13-8 (Low) An open dispute is dropped when the violation is withdrawn and applies again (closed day entered by mistake).
// ====================================================================================================================
test('R13-8 a dispute that is waiting for Varun survives a closed day entered and removed by mistake', () => {
  const w = world('2026-11-10');
  const r = w.ok(w.call('2026-11-10', '09:00', 'submitLeave', 'raunak', lv(['2026-11-10'])));
  w.ok(w.call('2026-11-10', '09:05', 'decideLeave', 'aakash', { id: r.id, approve: true }));
  const v = w.live('raunak', 'unannounced-leave')[0];
  w.ok(w.call('2026-11-10', '12:00', 'disputeViolation', 'raunak', { id: v.id, text: 'I rang Aakash at 7 in the morning' }));
  w.ok(w.call('2026-11-10', '13:00', 'setSetting', 'varun', { key: 'closedDays', value: ['2026-11-10'] }));
  w.ok(w.call('2026-11-10', '13:01', 'setSetting', 'varun', { key: 'closedDays', value: [] }));
  const now = w.sheet('Violations').filter(x => x.id === v.id)[0];
  assert.notEqual(now.disputeState, 'removed', 'setup: the violation applies again');
  assert.equal(now.disputeState, 'open', 'the dispute is still waiting for Varun (it is gone from his list, and Raunak cannot dispute again after 24 hours)');
});

// ====================================================================================================================
// R13-9 (Low) Month lock: the first confirmation can never be completed or taken back when the other role has no active person.
// ====================================================================================================================
test('R13-9 Varun confirmed November, then Aakash left: Varun can still lock the month', () => {
  const w = world('2026-11-28');
  assert.equal(w.ok(w.call('2026-12-01', '10:00', 'lockMonth', 'varun', { month: '2026-11' })).locked, false, 'setup: waiting for Aakash');
  const s = w.ok(w.call('2026-12-02', '10:00', 'getSettings', 'varun')).people.find(p => p.id === 'aakash');
  w.ok(w.call('2026-12-02', '10:01', 'savePerson', 'varun', Object.assign({}, s, { active: false })));
  const again = w.call('2026-12-03', '10:00', 'lockMonth', 'varun', { month: '2026-11' });
  assert.equal(again.ok && again.data.locked, true, 'with no manager the owner locks alone (as he would have without the earlier tap); answer: ' + again.message);
});

// ====================================================================================================================
// R13-10 (Low) "Rejected – clash" after a rule change: the alerts name the wrong days (r.dates is read after it was overwritten).
// ====================================================================================================================
test('R13-10 leave shortened by a rule change: the alert to the person names the days that were given back', () => {
  const w = world('2026-11-19');
  const rules = w.ok(w.call('2026-11-10', '09:00', 'getSettings', 'varun')).rules;
  ['C3', 'C4'].forEach(k => w.ok(w.call('2026-11-10', '09:01', 'saveRule', 'varun', Object.assign({}, rules.find(r => r.id === k), { on: false }))));
  approvedLeave(w, 'raunak', ['2026-11-19', '2026-11-20'], '2026-11-10'); approvedLeave(w, 'manish', ['2026-11-19', '2026-11-20'], '2026-11-11');
  w.present('2026-11-19', ['raunak', 'manish']); w.job('2026-11-19', '21:00', 'endOfDay');
  w.ok(w.call('2026-11-20', '08:00', 'saveRule', 'varun', Object.assign({}, rules.find(r => r.id === 'C3'), { on: true })));
  const told = w.sheet('Notifications').filter(n => n.to === 'manish' && n.kind === 'clash')[0];
  assert.ok(told, 'setup: Manish is told');
  assert.match(told.body, /^20 Nov/, 'the alert starts with the day that was given back; it reads: "' + told.body.slice(0, 60) + '"');
});
