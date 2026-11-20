// Round 15: rules and counting, the whole life of a record (recountDay, hadLeave, per-day "records only", lock). Commit 4169780, server version 9, schema 4.
// Every test states what must hold and FAILS on the code as reviewed, for the reason in its name.
// Harness copied from /home/claude/gj-leave/test/round13.test.js (Api.handle on the Sheet store with the read cache, Jobs.run).
// Run: node --test /home/claude/findings/repro-round15.test.js
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
const rowsOn = (w, p, d, kind) => w.sheet('DayMinutes').filter(m => m.personId === p && m.date === d && (!kind || m.kind === kind));
const FIELDS = ['id', 'name', 'group', 'role', 'dutyStart', 'dutyEnd', 'sundayOff', 'noApproval', 'noClash', 'noQuota', 'dressExempt', 'active', 'email', 'phone'];
/** Varun changes one person in Settings (all other fields as they are). */
function changePerson(w, date, time, id, patch) {
  const m = w.ok(w.call(date, time, 'getSettings', 'varun', {})).people.find(p => p.id === id), f = {};
  FIELDS.forEach(k => { f[k] = m[k]; });
  w.ok(w.call(date, time, 'savePerson', 'varun', Object.assign(f, patch)));
}

// ====================================================================================================================
// R15-1 (High) hadLeave is true only when the leave was taken back ON the day itself. A leave that covered the day for
// the WHOLE day and is taken back on a LATER day (Aakash ends the leave the next morning / corrects it afterwards)
// leaves the day's lateness "not informed": a violation for coming to work on a day of approved leave.
// ====================================================================================================================
test('R15-1a she comes back a day early from a 3-day leave (in at 11:00); Aakash ends the leave the next morning: no "not informed" violation for the leave day she worked', () => {
  const w = world('2026-11-18');
  const id = approvedLeave(w, 'neha', ['2026-11-18', '2026-11-19', '2026-11-20'], '2026-11-10');
  w.present('2026-11-18', ['neha']); w.job('2026-11-18', '21:00', 'endOfDay');
  // 19 Nov is a day of approved leave. She comes in anyway at 11:00 and works until 18:30.
  w.ok(w.call('2026-11-19', '11:00', 'checkIn', 'neha', PIC)); w.ok(w.call('2026-11-19', '18:30', 'checkOut', 'neha'));
  w.job('2026-11-19', '21:00', 'endOfDay');
  assert.equal(w.live('neha').length, 0, 'setup: nothing against her on the evening of the 19th');
  // 20 Nov 09:00: Aakash taps "End this leave" (the day she worked is given back, assumption 49).
  assert.deepEqual(w.ok(w.call('2026-11-20', '09:00', 'cancelLeave', 'aakash', { id, reason: 'Back since yesterday' })).dates, ['2026-11-18'], 'setup: 18 Nov stays leave, 19 and 20 are given back');
  assert.equal(minutesOn(w, 'neha', '2026-11-19', 'late'), 90, 'setup: the 90 minutes of 19 Nov are booked now');
  assert.equal(rowsOn(w, 'neha', '2026-11-19', 'late')[0].informed, true, 'her absence on 19 Nov was approved leave all day: the lateness was known (assumptions 57, 62)');
  assert.equal(w.live('neha', 'not-informed-over-30').length, 0, 'no violation for coming to work on a day of approved leave');
});
test('R15-1b one-day leave, she worked that day (in at 10:30); Aakash cancels the leave the next day as a correction: no violation', () => {
  const w = world('2026-11-19');
  const id = approvedLeave(w, 'neha', ['2026-11-19'], '2026-11-10');
  w.ok(w.call('2026-11-19', '10:30', 'checkIn', 'neha', PIC)); w.ok(w.call('2026-11-19', '18:30', 'checkOut', 'neha'));
  assert.equal(w.ok(w.call('2026-11-20', '09:00', 'cancelLeave', 'aakash', { id, reason: 'She worked that day' })).status, 'Cancelled');
  assert.equal(minutesOn(w, 'neha', '2026-11-19', 'late'), 60, 'setup: 60 min booked');
  assert.equal(w.live('neha', 'not-informed-over-30').length, 0, 'same facts with the cancel tapped on the 19th give "informed" and no violation; tapped one day later they must not give a violation');
});

// ====================================================================================================================
// R15-2 (Medium) decideShort overwrites the note of a row that is set aside ("[was N]" is lost). When the leave / the
// closed day that covered the time is taken away again, the minutes never come back.
// ====================================================================================================================
test('R15-2a late 45 min (request waiting), a leave is entered for the day by mistake, Aakash approves the late request, the leave is cancelled: the 45 min are back', () => {
  const w = world('2026-11-20');
  const q = w.ok(w.call('2026-11-20', '08:00', 'requestShort', 'neha', { kind: 'late', time: '10:15' }));
  w.ok(w.call('2026-11-20', '10:15', 'checkIn', 'neha', PIC));
  assert.equal(minutesOn(w, 'neha', '2026-11-20', 'late'), 45, 'setup: 45 min booked at the check-in');
  const l = w.ok(w.call('2026-11-20', '10:20', 'overrideLeave', 'varun', { forPersonId: 'neha', kind: 'full', dates: ['2026-11-20'], overrideReason: 'entered for the wrong person', reasonText: 'x' }));
  assert.equal(minutesOn(w, 'neha', '2026-11-20', 'late'), 0, 'setup: set aside while the leave covers the day');
  assert.equal(w.ok(w.call('2026-11-20', '10:25', 'decideShort', 'aakash', { id: q.id, approve: true })).status, 'Approved');
  assert.equal(w.ok(w.call('2026-11-20', '10:30', 'cancelLeave', 'varun', { id: l.id, reason: 'Wrong person' })).status, 'Cancelled');
  assert.equal(minutesOn(w, 'neha', '2026-11-20', 'late'), 45, 'the day is a working day again: she was 45 min late (assumption 67: minutes set aside come back as they were)');
});
test('R15-2b the same with a shop-closed day entered by mistake and removed (assumption 54: "the day is as before")', () => {
  const w = world('2026-11-20');
  const q = w.ok(w.call('2026-11-20', '08:00', 'requestShort', 'neha', { kind: 'late', time: '10:15' }));
  w.ok(w.call('2026-11-20', '10:15', 'checkIn', 'neha', PIC));
  w.ok(w.call('2026-11-20', '10:20', 'setSetting', 'varun', { key: 'closedDays', value: ['2026-11-20'] }));
  w.ok(w.call('2026-11-20', '10:25', 'decideShort', 'aakash', { id: q.id, approve: true }));
  w.ok(w.call('2026-11-20', '10:30', 'setSetting', 'varun', { key: 'closedDays', value: [] }));
  assert.equal(minutesOn(w, 'neha', '2026-11-20', 'late'), 45, 'closed day removed: the 45 min late are counted again');
  assert.equal(w.month('2026-11-20', '10:40', 'neha').bank.used, 35, '35 min from the bank (45 less the 10-min grace)');
});

// ====================================================================================================================
// R15-3 (Medium) recountDay books time that was never booked only when the day has NO row of that kind. When a row
// exists (a smaller lateness measured against a half day, or a voided check-out row) the rest is never booked.
// ====================================================================================================================
test('R15-3a morning half day, she arrives 14:40 (40 min after it); Aakash cancels the half day afterwards: the day counts the same as when he cancels first', () => {
  const day = order => {
    const w = world('2026-11-20');
    const r = w.ok(w.call('2026-11-10', '10:00', 'submitLeave', 'neha', lv(['2026-11-20'], { kind: 'half', halfStart: '09:30' })));
    assert.equal(r.status, 'Approved', 'setup: half day 09:30-14:00 approved');
    if (order === 'cancel first') w.ok(w.call('2026-11-20', '14:30', 'cancelLeave', 'aakash', { id: r.id, reason: 'Entered by mistake' }));
    w.ok(w.call('2026-11-20', '14:40', 'checkIn', 'neha', PIC));
    if (order === 'check-in first') w.ok(w.call('2026-11-20', '15:00', 'cancelLeave', 'aakash', { id: r.id, reason: 'Entered by mistake' }));
    return { late: minutesOn(w, 'neha', '2026-11-20', 'late'), taken: w.month('2026-11-20', '15:10', 'neha').leaves.taken };
  };
  const a = day('cancel first'), b = day('check-in first');
  assert.equal(a.late, 310, 'setup: cancel first, then check-in at 14:40 = 310 min late (a full day)');
  assert.equal(b.late, 310, 'check-in first, cancel afterwards: she was away 09:30-14:40 with no leave = 310 min; only ' + b.late + ' are booked');
  assert.equal(b.taken, a.taken, 'the month must count the same in both orders (' + a.taken + ' leave), it counts ' + b.taken);
});
test('R15-3b check-out taken back, a leave covers the day while she checks out again, the leave is cancelled: the early leaving of the real check-out is counted', () => {
  const w = world('2026-11-20');
  w.ok(w.call('2026-11-20', '09:30', 'checkIn', 'neha', PIC));
  w.ok(w.call('2026-11-20', '17:00', 'checkOut', 'neha'));                                   // wrong tap
  w.ok(w.call('2026-11-20', '17:05', 'undoCheckOut', 'aakash', { personId: 'neha', date: '2026-11-20', reason: 'Wrong tap' }));
  const o = w.ok(w.call('2026-11-20', '17:10', 'overrideLeave', 'varun', { forPersonId: 'neha', kind: 'full', dates: ['2026-11-20'], overrideReason: 'wrong person', reasonText: 'x' }));
  w.ok(w.call('2026-11-20', '17:40', 'checkOut', 'neha'));                                   // she really leaves 50 min early
  w.ok(w.call('2026-11-20', '17:50', 'cancelLeave', 'varun', { id: o.id, reason: 'Wrong person' }));
  assert.equal(minutesOn(w, 'neha', '2026-11-20', 'early'), 50, 'a working day again: she left at 17:40, 50 min before 18:30');
});

// ====================================================================================================================
// R15-4 (Medium) a ONE-day leave taken back by a rule change ("Rejected – clash") is not seen by hadLeave (it looks
// for "cancelled", "shortened...", "edited" only). A multi-day leave shortened by the same rule change IS seen.
// ====================================================================================================================
test('R15-4 Manish came in 90 min late on his leave day; Varun switches the clash rule on and the leave becomes "Rejected – clash": the lateness is informed (assumption 66 lists the rule change)', () => {
  const w = world('2026-11-20');
  const c3 = w.sheet('Rules').find(r => r.id === 'C3'), c4 = w.sheet('Rules').find(r => r.id === 'C4');
  w.ok(w.call('2026-11-10', '09:00', 'saveRule', 'varun', Object.assign({}, c3, { on: false })));
  w.ok(w.call('2026-11-10', '09:01', 'saveRule', 'varun', Object.assign({}, c4, { on: false })));
  approvedLeave(w, 'raunak', ['2026-11-20'], '2026-11-10');
  const mine = approvedLeave(w, 'manish', ['2026-11-20'], '2026-11-11');
  w.ok(w.call('2026-11-20', '11:00', 'checkIn', 'manish', PIC));
  assert.deepEqual(w.ok(w.call('2026-11-20', '11:30', 'saveRule', 'varun', Object.assign({}, c3, { on: true }))).rejected, [mine], 'setup: the rule change takes Manish\'s leave back today');
  assert.equal(minutesOn(w, 'manish', '2026-11-20', 'late'), 90, 'setup: the 90 min are booked');
  assert.equal(rowsOn(w, 'manish', '2026-11-20', 'late')[0].informed, true, 'the leave was taken back today by Varun\'s rule change: informed, as for a cancel or a shortening on the same day');
  assert.equal(w.live('manish', 'not-informed-over-30').length, 0, 'no violation for a lateness that was approved leave until 11:30');
});

// ====================================================================================================================
// R15-5 (Medium) hadLeave does not look at what the leave covered: an AFTERNOON half day taken back in the morning
// makes a MORNING lateness "informed", although nobody approved it and the half day never covered it.
// ====================================================================================================================
test('R15-5 afternoon half day (from 14:00) cancelled by Aakash at 09:00; she comes 90 min late in the morning, told nobody: not informed, 1 violation', () => {
  const w = world('2026-11-20');
  const r = w.ok(w.call('2026-11-10', '10:00', 'submitLeave', 'neha', lv(['2026-11-20'], { kind: 'half', halfStart: '14:00' })));
  assert.equal(r.status, 'Approved', 'setup');
  w.ok(w.call('2026-11-20', '09:00', 'cancelLeave', 'aakash', { id: r.id, reason: 'She will work the full day' }));
  const cin = w.ok(w.call('2026-11-20', '11:00', 'checkIn', 'neha', PIC));
  assert.equal(cin.lateMinutes, 90);
  assert.equal(cin.informed, false, 'the half day was 14:00-18:30; with it she would also have been "not informed" at 11:00. Cancelling it cannot make the morning informed');
  assert.equal(w.live('neha', 'not-informed-over-30').length, 1);
});

// ====================================================================================================================
// R15-6 (Medium) markAbsent judges "records only" by the flag as it is TODAY, not as it was on the day (assumption 68).
// An absent check that runs later (missed night, closed day removed, month lock) gives a records-only day a violation,
// or a regular day none.
// ====================================================================================================================
test('R15-6a Muskan (records only) is away on 19 Nov, the night job is missed, she is made regular staff on 20 Nov: the catch-up gives no violation for 19 Nov', () => {
  const w = world('2026-11-19');
  w.present('2026-11-19', ['muskan']);                         // the 21:00 job of 19 Nov does not run
  changePerson(w, '2026-11-20', '09:05', 'muskan', { noApproval: false });
  w.present('2026-11-20', []); w.job('2026-11-20', '21:00', 'endOfDay');
  assert.deepEqual(absences(w, 'muskan'), ['2026-11-19'], 'setup: the catch-up recorded the day');
  assert.equal(w.live('muskan').length, 0, 'on 19 Nov she was "records only": never a violation for that day');
  assert.equal(w.month('2026-11-20', '21:10', 'muskan').ladder.violations, 0);
});
test('R15-6b Neha (regular) is away on 19 Nov, the night job is missed, she is made "records only" on 20 Nov: the catch-up still gives the violation of 19 Nov', () => {
  const w = world('2026-11-19');
  w.present('2026-11-19', ['neha']);
  changePerson(w, '2026-11-20', '09:05', 'neha', { noApproval: true });
  w.present('2026-11-20', []); w.job('2026-11-20', '21:00', 'endOfDay');
  assert.deepEqual(absences(w, 'neha'), ['2026-11-19'], 'setup: the catch-up recorded the day');
  assert.equal(w.live('neha', 'absent-no-request').length, 1, 'on 19 Nov she needed approval: absent with no request = 1 violation, as on a night when the job runs');
});

// ====================================================================================================================
// R15-7 (Low) leaving early on a day whose leave was taken back that day: informed or not depends on the tap order.
// ====================================================================================================================
test('R15-7 leave for today taken back by Aakash, she leaves 60 min early without telling: the same result whichever tap came first', () => {
  const day = first => {
    const w = world('2026-11-20');
    const id = approvedLeave(w, 'neha', ['2026-11-20'], '2026-11-10');
    w.ok(w.call('2026-11-20', '09:30', 'checkIn', 'neha', PIC));
    if (first === 'cancel') { w.ok(w.call('2026-11-20', '17:00', 'cancelLeave', 'aakash', { id, reason: 'x' })); w.ok(w.call('2026-11-20', '17:30', 'checkOut', 'neha')); }
    else { w.ok(w.call('2026-11-20', '17:30', 'checkOut', 'neha')); w.ok(w.call('2026-11-20', '17:45', 'cancelLeave', 'aakash', { id, reason: 'x' })); }
    return { informed: rowsOn(w, 'neha', '2026-11-20', 'early')[0].informed, violations: w.live('neha').length };
  };
  assert.deepEqual(day('out'), day('cancel'), 'check-out first then cancel, and cancel first then check-out, are the same day');
});

// ====================================================================================================================
// R15-8 (Low) lateness booked by recountDay ignores the stated time of the approved late request.
// ====================================================================================================================
test('R15-8 approved late request "by 10:00", she arrives 11:00 on a day entered as closed by mistake; the closed day is removed: 60 min after the stated time are not informed, as on any other day', () => {
  const w = world('2026-11-20');
  w.ok(w.call('2026-11-17', '10:00', 'setSetting', 'varun', { key: 'closedDays', value: ['2026-11-20'] }));
  const q = w.ok(w.call('2026-11-19', '20:00', 'requestShort', 'neha', { kind: 'late', date: '2026-11-20', time: '10:00' }));
  w.ok(w.call('2026-11-19', '20:05', 'decideShort', 'aakash', { id: q.id, approve: true }));
  w.ok(w.call('2026-11-20', '11:00', 'checkIn', 'neha', PIC));
  w.ok(w.call('2026-11-20', '12:00', 'setSetting', 'varun', { key: 'closedDays', value: [] }));
  assert.equal(minutesOn(w, 'neha', '2026-11-20', 'late'), 90, 'setup: 90 min booked when the closed day is removed');
  assert.equal(w.live('neha', 'not-informed-over-30').length, 1, 'she said 10:00 and came at 11:00: the 60 min after the stated time are not informed, more than 30 min = violation (it is one on a day that was never marked closed)');
});

// ====================================================================================================================
// R15-9 (Low) a change of "records only" / Sunday roster in Settings applies from today, but today is not counted
// again at that moment: what today shows flips later, at an unrelated tap.
// ====================================================================================================================
test('R15-9 Neha is made "records only" at noon after a 90-min-late check-in: her violations do not change again by themselves at her next check-in', () => {
  const w = world('2026-11-20');
  w.ok(w.call('2026-11-20', '11:00', 'checkIn', 'neha', PIC));
  assert.equal(w.live('neha').length, 1, 'setup: not informed, more than 30 min');
  changePerson(w, '2026-11-20', '12:05', 'neha', { noApproval: true });
  const after = w.live('neha').length;
  w.ok(w.call('2026-11-20', '18:30', 'checkOut', 'neha'));
  w.ok(w.call('2026-11-21', '09:50', 'checkIn', 'neha', PIC));          // 20 min late on the next day
  assert.equal(w.live('neha').length, after, 'the count right after the Settings change (' + after + ') must be the count that stays; it changed at the next day\'s check-in');
});
