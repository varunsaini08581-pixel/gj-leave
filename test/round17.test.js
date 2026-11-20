// Round 17: the minute engine after the rewrite (deriveDay / recountDay / knownByLeave). Commit aef799d, server version 9, schema 4.
// Every test states what must hold and FAILS on the code as reviewed, for the reason in its name.
// Harness copied from /home/claude/gj-leave/test/round15.test.js (Api.handle on the Sheet store with the read cache, Jobs.run).
// Run: node --test /home/claude/findings/repro-round17.test.js
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

const D = '2026-11-20'; // a Friday; Neha's duty is 09:30-18:30, Vikas's 11:00-20:00
const liveNI = (w, p) => w.live(p, 'not-informed-over-30').length;

// ====================================================================================================================
// R17-1 (Medium, regression) A change of duty hours in Settings re-judges days that are already gone, and today's
// arrival. deriveDay reads person.dutyStart / dutyEnd as they are NOW for every date; savePerson does not count today
// again for a duty-time change and keeps no history of it. Round 7 had found "a changed duty time does NOT re-judge
// old days" (minutes were stored at the tap); the rewrite lost that.
// ====================================================================================================================
test('R17-1a duty hours changed at 14:00 (09:30-18:30 -> 08:30-17:30): the on-time arrival of that morning is not turned into 60 min late + a violation at check-out', () => {
  const w = world(D);
  w.ok(w.call(D, '09:30', 'checkIn', 'neha', PIC));
  assert.equal(minutesOn(w, 'neha', D), 0, 'setup: on time');
  changePerson(w, D, '14:00', 'neha', { dutyStart: '08:30', dutyEnd: '17:30' });
  w.ok(w.call(D, '18:30', 'checkOut', 'neha'));
  assert.equal(minutesOn(w, 'neha', D, 'late'), 0, 'she arrived at her duty start of that morning: no late minutes');
  assert.equal(w.live('neha').length, 0, 'no violation for an arrival that was on time when it happened');
});
test('R17-1b duty hours changed today (to 10:30-19:30): yesterday, worked 09:30-18:30 under the old hours, is not re-judged when Aakash enters the forgotten check-out', () => {
  const w = world('2026-11-19');
  w.ok(w.call('2026-11-19', '09:30', 'checkIn', 'neha', PIC)); // she forgets to check out at 18:30
  changePerson(w, D, '09:00', 'neha', { dutyStart: '10:30', dutyEnd: '19:30' });
  w.ok(w.call(D, '09:10', 'manualCheckOut', 'aakash', { personId: 'neha', date: '2026-11-19', time: '18:30', reason: 'forgot to check out' }));
  assert.equal(minutesOn(w, 'neha', '2026-11-19'), 0, 'she left at her duty end of that day: nothing to count on 19 Nov');
  assert.equal(w.live('neha').length, 0, 'no violation on a day worked in full under the hours of that day');
});

// ====================================================================================================================
// R17-2 (Medium) An early-leaving request can be sent AFTER the person has already checked out (the only time test is
// "the stated time has not passed"). requestShort does not count the day again (rows no longer say what deriveDay
// says), and when Aakash approves it from his normal card the leaving that nobody was told about becomes "informed".
// For late arrivals the rule is enforced (sent before duty start); for early leaving the mirror rule is not.
// ====================================================================================================================
test('R17-2 she leaves 90 min early without telling (violation), then sends "I will leave early" from outside; Aakash approves: the leaving stays not informed', () => {
  const w = world(D);
  w.ok(w.call(D, '09:30', 'checkIn', 'neha', PIC));
  w.ok(w.call(D, '17:00', 'checkOut', 'neha'));
  assert.equal(liveNI(w, 'neha'), 1, 'setup: 90 min early, nobody told: 1 violation');
  const r = w.call(D, '17:05', 'requestShort', 'neha', { kind: 'early', time: '17:05' }); // correct: refused, or accepted without effect
  if (r.ok) w.call(D, '17:20', 'decideShort', 'aakash', { id: r.data.id, approve: true });
  assert.equal(rowsOn(w, 'neha', D, 'early').filter(m => m.minutes > 0 && m.informed).length, 0, 'a request sent after she left cannot make the leaving informed');
  assert.equal(liveNI(w, 'neha'), 1, 'the violation for leaving without telling stays');
});

// ====================================================================================================================
// R17-3 (Medium) knownByLeave does not ask whether the leave was GRANTED before the arrival (assumption 72 (a)):
//  a. a request that was only WAITING when she arrived, approved afterwards and then cancelled by Aakash, makes the
//     lateness informed (the test is submittedAt < arrival, not granted-at < arrival);
//  b. the "edited" branch has no time test at all: a leave entered after the arrival and then MOVED by Aakash makes the
//     lateness informed, while the same leave CANCELLED by Aakash leaves it not informed.
// ====================================================================================================================
test('R17-3a leave asked at 08:00 (waiting), she comes in 90 min late, Aakash approves it at 12:00 and cancels it at 12:30: the lateness is not informed', () => {
  const w = world(D);
  const r = w.ok(w.call(D, '08:00', 'submitLeave', 'neha', lv([D])));
  assert.equal(r.status, 'Pending with Aakash', 'setup: the request is waiting');
  w.ok(w.call(D, '11:00', 'checkIn', 'neha', PIC));
  assert.equal(liveNI(w, 'neha'), 1, 'setup: 90 min late, no leave granted, nobody approved the lateness');
  assert.equal(w.ok(w.call(D, '12:00', 'decideLeave', 'aakash', { id: r.id, approve: true })).status, 'Approved');
  assert.equal(w.ok(w.call(D, '12:30', 'cancelLeave', 'aakash', { id: r.id, reason: 'She is here' })).status, 'Cancelled');
  assert.equal(minutesOn(w, 'neha', D, 'late'), 90, 'setup: the 90 minutes are back');
  assert.equal(rowsOn(w, 'neha', D, 'late')[0].informed, false, 'no leave had been granted when she arrived: the lateness was not known (assumption 72 a)');
  assert.equal(liveNI(w, 'neha'), 1, 'the violation is back with the minutes');
});
test('R17-3b leave entered by Aakash AFTER her late arrival (a mistake) and then moved to tomorrow by an edit: same result as cancelling it (not informed)', () => {
  const w = world(D);
  w.ok(w.call(D, '11:00', 'checkIn', 'neha', PIC));
  assert.equal(liveNI(w, 'neha'), 1, 'setup: 90 min late, not informed');
  const r = w.ok(w.call(D, '11:30', 'submitLeave', 'aakash', lv([D], { forPersonId: 'neha' })));
  if (r.status !== 'Approved') assert.equal(w.ok(w.call(D, '11:31', 'decideLeave', 'aakash', { id: r.id, approve: true })).status, 'Approved');
  assert.equal(minutesOn(w, 'neha', D), 0, 'setup: a leave day counts nothing');
  w.ok(w.call(D, '11:40', 'editLeave', 'aakash', lv(['2026-11-21'], { id: r.id })));
  assert.equal(minutesOn(w, 'neha', D, 'late'), 90, 'setup: the 90 minutes are back');
  assert.equal(rowsOn(w, 'neha', D, 'late')[0].informed, false, 'the leave did not exist when she arrived: it changes nothing about what was known then');
  assert.equal(liveNI(w, 'neha'), 1, 'the violation is back with the minutes');
});

// ====================================================================================================================
// R17-4 (Low) Assumption 72 (b): "a half day only its own hours". knownByLeave only asks whether the half day TOUCHES
// the time away; then the whole row is informed. An approved morning half day (09:30-14:00), she comes at 15:00
// (60 min after the half day, told nobody: violation). When the half day is cancelled afterwards all 330 minutes are
// informed and the violation is gone.
// ====================================================================================================================
test('R17-4 morning half day, in at 15:00 (60 min not informed), Aakash cancels the half day: the hour after the half day is still not informed', () => {
  const w = world(D);
  const r = w.ok(w.call('2026-11-10', '10:00', 'submitLeave', 'neha', lv([D], { kind: 'half', halfStart: '09:30' })));
  if (r.status !== 'Approved') w.ok(w.call('2026-11-10', '10:05', 'decideLeave', 'aakash', { id: r.id, approve: true }));
  w.ok(w.call(D, '15:00', 'checkIn', 'neha', PIC));
  assert.equal(liveNI(w, 'neha'), 1, 'setup: 60 min late after the half day, not informed: 1 violation');
  assert.equal(w.ok(w.call(D, '15:30', 'cancelLeave', 'aakash', { id: r.id, reason: 'Entered for the wrong day' })).status, 'Cancelled');
  assert.equal(minutesOn(w, 'neha', D, 'late'), 330, 'setup: the whole morning counts now');
  assert.equal(liveNI(w, 'neha'), 1, 'the half day covered 09:30-14:00 only: the 60 minutes after it were not known, the violation stays');
});

// ====================================================================================================================
// R17-5 (Medium) An early request still WAITING when she leaves before its stated time: deriveDay cuts the leaving in
// two "not informed" pieces and each piece is judged alone against the 30-minute rule and the pass counter.
//  a. 70 min early (35 + 35): 2 violations for one leaving; with no request at all: 1.
//  b. 50 min early (25 + 25): no violation and 2 passes; with no request at all: 1 violation.
// It lasts until Aakash decides; the month lock works out the result BEFORE it closes waiting requests, so it can freeze.
// ====================================================================================================================
test('R17-5a waiting early request for 17:55, she leaves 17:20 (70 min before 18:30): one leaving nobody approved = 1 violation, not 2', () => {
  const w = world(D);
  w.ok(w.call(D, '09:30', 'checkIn', 'neha', PIC));
  w.ok(w.call(D, '12:00', 'requestShort', 'neha', { kind: 'early', time: '17:55' }));
  w.ok(w.call(D, '17:20', 'checkOut', 'neha'));
  assert.equal(minutesOn(w, 'neha', D, 'early'), 70, 'setup: 70 minutes early');
  assert.equal(liveNI(w, 'neha'), 1, 'pending = not informed for now (assumption 12): 70 min not informed is ONE violation');
});
test('R17-5b waiting early request for 18:05, she leaves 17:40 (50 min early): not informed and more than 30 min = 1 violation, not 0', () => {
  const w = world(D);
  w.ok(w.call(D, '09:30', 'checkIn', 'neha', PIC));
  w.ok(w.call(D, '12:00', 'requestShort', 'neha', { kind: 'early', time: '18:05' }));
  w.ok(w.call(D, '17:40', 'checkOut', 'neha'));
  assert.equal(minutesOn(w, 'neha', D, 'early'), 50, 'setup: 50 minutes early');
  assert.equal(liveNI(w, 'neha'), 1, 'nothing is approved yet: 50 min not informed is a violation, as it is with no request at all');
});

// ====================================================================================================================
// R17-6 (Low) Assumption 46: "an outing counts only the minutes inside duty hours". outingMinutes cuts at duty END only.
// ====================================================================================================================
test('R17-6 Vikas (duty from 11:00) is in early and goes out 10:30-10:55, back before his duty starts: nothing is taken from his bank', () => {
  const w = world(D);
  w.ok(w.call(D, '10:20', 'checkIn', 'vikas', PIC));
  const o = w.ok(w.call(D, '10:25', 'goingOut', 'vikas', { reason: 'Chai', expectedMinutes: 20 }));
  w.ok(w.call(D, '10:30', 'decideOuting', 'aakash', { id: o.id, approve: true }));
  w.ok(w.call(D, '10:55', 'imBack', 'vikas', { id: o.id }));
  assert.equal(w.month(D, '12:00', 'vikas').bank.used, 0, 'the 25 minutes were all before 11:00, his own time');
});

// ====================================================================================================================
// R17-7 (Low) excuseAbsence turns the absence into an approved full-day leave but does not count the day again. If the
// person has a check-in on that day (tapped after the evening job), the minutes and the "not informed" violation stay
// on a full-leave day (assumption 55: nothing is counted on a full-leave day).
// ====================================================================================================================
test('R17-7 marked absent at 21:00, she taps check-in at 21:30 (540 min, violation), Aakash excuses the absence: a full-leave day counts no minutes and no violation', () => {
  const w = world(D);
  w.present(D, ['neha']); w.job(D, '21:00', 'endOfDay');
  const abs = w.sheet('LeaveRequests').filter(x => x.personId === 'neha' && x.route === 'system')[0];
  assert.ok(abs, 'setup: the evening job recorded the absence');
  w.ok(w.call(D, '21:30', 'checkIn', 'neha', PIC));
  assert.equal(w.ok(w.call(D, '22:00', 'excuseAbsence', 'aakash', { id: abs.id, reason: 'Hospital' })).status, 'Approved');
  assert.equal(minutesOn(w, 'neha', D), 0, 'the day is an approved full-day leave now: no minutes');
  assert.equal(w.live('neha').length, 0, 'excused: no violation is left on that day');
});

// ====================================================================================================================
// R17-8 (Medium) Violations hang on row ids, but when the early pieces of a day change shape the meaning moves to
// another row. Waiting early request for 18:10, she leaves 17:20: row A = 20 min (the waiting piece), row B = 50 min
// (before the stated time) with the violation. Aakash rejects the request: row A becomes the whole 70 minutes, row B 0.
//  a. Varun had REMOVED the violation after her dispute: a new violation for the same leaving is recorded on row A
//     (assumption 51: a violation Varun removed is never recorded again).
//  b. Her dispute was still OPEN: it is withdrawn with row B and Varun's dispute list is empty; the new violation on
//     row A has no dispute.
// ====================================================================================================================
function leftBeforeStated(w) {
  w.ok(w.call(D, '09:30', 'checkIn', 'neha', PIC));
  const r = w.ok(w.call(D, '12:00', 'requestShort', 'neha', { kind: 'early', time: '18:10' }));
  w.ok(w.call(D, '17:20', 'checkOut', 'neha'));
  const v = w.live('neha', 'not-informed-over-30');
  assert.equal(v.length, 1, 'setup: one violation (the 50 minutes before the stated time)');
  w.ok(w.call(D, '17:30', 'disputeViolation', 'neha', { id: v[0].id, text: 'I had asked for it' }));
  return { shortId: r.id, violationId: v[0].id };
}
test('R17-8a Varun removes the violation after her dispute, then Aakash rejects the early request: the violation is not recorded again for the same leaving', () => {
  const w = world(D), x = leftBeforeStated(w);
  w.ok(w.call(D, '17:40', 'decideDispute', 'varun', { id: x.violationId, uphold: false, note: 'Accepted this once' }));
  assert.equal(w.live('neha').length, 0, 'setup: removed by Varun');
  w.ok(w.call(D, '18:00', 'decideShort', 'aakash', { id: x.shortId, approve: false, reason: 'Was not asked in time' }));
  assert.equal(w.live('neha').length, 0, 'Varun removed the violation for this leaving: it is never recorded again (assumption 51)');
});
test('R17-8b her dispute is open when Aakash rejects the early request: the dispute is still waiting for Varun', () => {
  const w = world(D), x = leftBeforeStated(w);
  w.ok(w.call(D, '18:00', 'decideShort', 'aakash', { id: x.shortId, approve: false, reason: 'Was not asked in time' }));
  assert.equal(w.live('neha', 'not-informed-over-30').length, 1, 'setup: still one violation for the leaving');
  assert.equal(w.sheet('Violations').filter(v => v.personId === 'neha' && v.disputeState === 'open').length, 1, 'the open dispute about this leaving is kept');
});

// ====================================================================================================================
// R17-9 (Medium) knownByLeave uses submittedAt as "the leave existed before the arrival", and editLeave resets
// submittedAt. After "End this leave" (the day she came back is given back, lateness informed) any later edit of that
// leave row by Aakash / Varun makes the day "not informed" at its next count; the edit itself does not count the day
// again, so the rows and deriveDay disagree in between (seen in the random runs, seeds 21 and 25).
// ====================================================================================================================
test('R17-9 leave 18-20 Nov, back on the 20th at 11:00, Aakash ends the leave (informed); next day he corrects the leave entry, then enters her forgotten check-out: the 20th stays informed', () => {
  const w = world('2026-11-18');
  const id = approvedLeave(w, 'neha', ['2026-11-18', '2026-11-19', '2026-11-20'], '2026-11-10');
  w.ok(w.call(D, '11:00', 'checkIn', 'neha', PIC)); // she forgets to check out in the evening
  assert.deepEqual(w.ok(w.call(D, '11:30', 'cancelLeave', 'aakash', { id, reason: 'Back today' })).dates, ['2026-11-18', '2026-11-19'], 'setup: the 20th is given back');
  assert.equal(rowsOn(w, 'neha', D, 'late')[0].informed, true, 'setup: 90 min, informed (the absence was approved leave)');
  assert.equal(w.live('neha').length, 0, 'setup: no violation');
  w.ok(w.call('2026-11-21', '10:00', 'editLeave', 'aakash', lv(['2026-11-18', '2026-11-19'], { id, reasonText: 'Family function (corrected)' })));
  w.ok(w.call('2026-11-21', '10:30', 'manualCheckOut', 'aakash', { personId: 'neha', date: D, time: '18:30', reason: 'forgot to check out' }));
  assert.equal(minutesOn(w, 'neha', D, 'late'), 90, 'setup: still 90 minutes');
  assert.equal(rowsOn(w, 'neha', D, 'late').filter(m => m.minutes > 0)[0].informed, true, 'the leave covered the 20th when she arrived and Aakash took it back that day: informed (assumption 72)');
  assert.equal(liveNI(w, 'neha'), 0, 'no violation for coming back early from an approved leave');
});

// ====================================================================================================================
// R17-10 (Low) setSetting('closedDays') counts the changed day again for role "staff" only. Aakash checks in too and
// gets minutes and violations like everyone; a closed day entered later leaves his row and his violation in place
// (assumption 42: a closed day entered later clears that day's minutes and their violations; 55: no minutes on a closed day).
// ====================================================================================================================
test('R17-10 Aakash checks in 60 min late (violation); Varun then enters the day as shop-closed: his minutes and the violation are cleared like a staff member\'s', () => {
  const w = world(D);
  w.ok(w.call(D, '11:00', 'checkIn', 'aakash', PIC));
  w.ok(w.call(D, '10:35', 'checkIn', 'pooja', PIC)); // a staff member, 35 min late, for comparison
  assert.equal(w.live('aakash').length, 1, 'setup: Aakash has the violation');
  assert.equal(w.live('pooja').length, 1, 'setup: Pooja has the violation');
  w.ok(w.call(D, '12:00', 'setSetting', 'varun', { key: 'closedDays', value: [D] }));
  assert.equal(w.live('pooja').length, 0, 'setup: the closed day clears the staff member\'s violation');
  assert.equal(minutesOn(w, 'aakash', D), 0, 'no minutes on a closed day, for the manager too');
  assert.equal(w.live('aakash').length, 0, 'the closed day clears his violation too');
});

// ====================================================================================================================
// R17-11 (Medium; found by the random run, seed 90) A leave that reaches over the month end (30 Nov - 1 Dec), edited by
// Aakash AFTER November is locked so that only the November day is left: editLeave puts it back to "Pending with
// Aakash" (an edit after approval always waits again), and now every day of it lies in a locked month. Nobody can
// approve, reject, cancel or edit it any more: it waits in Approvals and reminds Aakash every 2 hours, for ever.
// ====================================================================================================================
test('R17-11 leave 30 Nov - 1 Dec, November locked, Aakash edits it down to 30 Nov: the request is not left waiting where nobody can ever close it', () => {
  const w = world('2026-11-30');
  const id = approvedLeave(w, 'neha', ['2026-11-30', '2026-12-01'], '2026-11-20');
  w.present('2026-11-30', ['neha']); w.job('2026-11-30', '21:00', 'endOfDay');
  lockNovember(w, '2026-12-01');
  const row = () => w.sheet('LeaveRequests').filter(r => r.id === id)[0];
  assert.equal(row().status, 'Approved', 'setup: the leave is approved and reaches into December, so the lock left it alone');
  // 4 Dec: she was back on 1 Dec; Aakash corrects the entry with Edit (drops 1 Dec).
  w.call('2026-12-04', '12:00', 'editLeave', 'aakash', lv(['2026-11-30'], { id })); // correct: refused, or the result stays decidable
  if (/^(Pending|Special)/.test(row().status)) {
    const tries = [w.call('2026-12-04', '12:10', 'decideLeave', 'aakash', { id, approve: true }), w.call('2026-12-04', '12:11', 'decideLeave', 'varun', { id, approve: false, reason: 'Closing it' }),
      w.call('2026-12-04', '12:12', 'cancelLeave', 'varun', { id, reason: 'Closing it' }), w.call('2026-12-04', '12:13', 'editLeave', 'varun', lv(['2026-11-30', '2026-12-01'], { id }))];
    assert.ok(tries.some(t => t.ok), 'a waiting request must be closable by somebody: ' + tries.map(t => t.message).join(' | '));
  }
});
