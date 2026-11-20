// Round 20 reproducers, commit 4f73a0b. Every test FAILS on the reviewed code for the reason in its name.
// Harness copied from /home/claude/gj-leave/test/round19.test.js. Run: node --test /home/claude/findings/repro-round20.test.js
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
function fakeCache() { const m = new Map(); return { m, getAll: keys => { const o = {}; keys.forEach(k => { if (m.has(k)) o[k] = m.get(k); }); return o; }, put: (k, v) => m.set(k, v), putAll: map => Object.keys(map).forEach(k => m.set(k, map[k])) }; }
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
  return { g, cache, call, job, ok, sheet, month, live, present };
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

const send = (w, t, who, day) => w.call('2026-11-20', t, 'submitLeave', who, lv([day]));


// ===================================================================================================================
// R20-1 Two Settings saves on the same day: first the duty hours, then the Sunday roster. The first save writes the
// history entry "until today" (old hours, roster as it was); the second save pushes nothing (last.until = today is not
// < yesterday), so Cal.asOn(today) still returns the OLD roster and the roster change starts only tomorrow.
// Same end result as R19-3, reached by two saves instead of one.
// ===================================================================================================================
test('R20-1 hours changed at 08:00 and a Sunday off for today given at 08:05 (two saves): today must be a roster day off', () => {
  const w = world('2026-11-22');
  // Sunday 22 Nov 2026 is the 4th Sunday; Vikas has the 1st and 2nd off, so today he would work.
  changePerson(w, '2026-11-22', '08:00', 'vikas', { dutyStart: '11:30', dutyEnd: '20:30' });
  changePerson(w, '2026-11-22', '08:05', 'vikas', { sundayOff: [1, 2, 4] });
  const saved = w.sheet('People').find(p => p.id === 'vikas');
  assert.deepEqual(saved.sundayOff, [1, 2, 4], 'setup: the roster was saved');
  const v = w.ok(w.call('2026-11-22', '08:06', 'board', 'aakash', {})).people.find(p => p.id === 'vikas');
  w.job('2026-11-22', '23:30', 'endOfDay');
  assert.deepEqual(absences(w, 'vikas'), [], 'Vikas, given today off in the second save, is marked absent tonight: ' + JSON.stringify(absences(w, 'vikas')) + ' (board said ' + v.state + ', history ' + JSON.stringify(saved.history) + ')');
});

// ===================================================================================================================
// R20-2 requestLimit / sentOnDay(before=true) count only requests whose history[0].at < this request's ctx.now. ctx.now
// is taken BEFORE the script lock is waited for (src/gas/main.js: now: Date.now()), so two sends from one person that
// overlap are saved in lock order but compared by start time. The send that started first but got the lock second does
// not see the other (its at is later), and the other did not see it (not saved yet): neither is counted, and the 4th
// request of the day is auto-approved. Before 4f73a0b the whole day was counted, so the second one went to Aakash.
// Simulated here by running the later-started call first.
// ===================================================================================================================
test('R20-2 two overlapping sends (3rd and 4th of the day): one of them must go to Aakash', () => {
  const w = world('2026-11-20');
  ['2026-12-01', '2026-12-02'].forEach((d, i) => { const x = w.ok(send(w, '10:0' + i, 'neha', d)); assert.equal(x.status, 'Approved', 'setup'); w.ok(w.call('2026-11-20', '10:0' + i, 'cancelLeave', 'neha', { id: x.id })); });
  // Send B started at 10:04 and got the lock first; send A started at 10:03, waited for the lock, and is saved second.
  const b = w.ok(send(w, '10:04', 'neha', '2026-12-04'));
  const a = w.ok(send(w, '10:03', 'neha', '2026-12-03'));
  assert.equal(w.sheet('LeaveRequests').filter(r => r.personId === 'neha').length, 4, 'setup: four sends today');
  assert.deepEqual([a.status, b.status].filter(s => s === 'Pending with Aakash').length, 1, 'four requests sent today, but none went to Aakash: A=' + a.status + ', B=' + b.status);
});
