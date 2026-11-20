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

// ===== Owner decisions of 20 Nov 2026, 23:46 IST =====
const send = (w, t, who, day) => w.call('2026-11-20', t, 'submitLeave', who, lv([day]));

test('owner 20 Nov: requests 1-3 of a day follow the normal rules; the 4th and 5th go to Aakash with a red warning; from the 6th they go to Varun', () => {
  const w = world('2026-11-20');
  const days = ['2026-12-01', '2026-12-02', '2026-12-03', '2026-12-04', '2026-12-05', '2026-12-07', '2026-12-08'];
  const got = [];
  days.forEach((d, i) => {
    const r = w.ok(send(w, '10:0' + i, 'neha', d));
    got.push(r.status);
    if (r.status === 'Approved' || /^Pending/.test(r.status)) w.ok(w.call('2026-11-20', '10:0' + i, 'cancelLeave', 'neha', { id: r.id }));
  });
  assert.deepEqual(got.slice(0, 3), ['Approved', 'Approved', 'Approved'], 'far ahead, one day each: auto-approved');
  assert.deepEqual(got.slice(3, 5), ['Pending with Aakash', 'Pending with Aakash'], 'the 4th and 5th need Aakash');
  assert.deepEqual(got.slice(5), ['Pending with Varun', 'Pending with Varun'], 'from the 6th: Varun directly; nothing is refused');
});

test('owner 20 Nov: the staff member sees the red warning before sending, and Aakash sees it on the card', () => {
  const w = world('2026-11-20');
  ['2026-12-01', '2026-12-02', '2026-12-03'].forEach((d, i) => { const r = w.ok(send(w, '10:0' + i, 'neha', d)); w.ok(w.call('2026-11-20', '10:0' + i, 'cancelLeave', 'neha', { id: r.id })); });
  const p = w.ok(w.call('2026-11-20', '10:05', 'previewLeave', 'neha', lv(['2026-12-04'])));
  assert.equal(p.decision, 'aakash');
  assert.match(p.warnings[0], /^This is request number 4 from you today/);
  const r = w.ok(send(w, '10:06', 'neha', '2026-12-04'));
  const card = w.ok(w.call('2026-11-20', '10:07', 'approvals', 'aakash')).leaves.find(x => x.id === r.id);
  assert.equal(card.context.tooMany, 4, 'the card carries the red line');
});

test('owner 20 Nov: requests of other days and edits do not count; Aakash entering a request for someone does not count', () => {
  const w = world('2026-11-19');
  ['2026-12-01', '2026-12-02', '2026-12-03'].forEach((d, i) => w.ok(w.call('2026-11-19', '10:0' + i, 'submitLeave', 'neha', lv([d]))));
  w.ok(w.call('2026-11-20', '10:00', 'submitLeave', 'aakash', Object.assign(lv(['2027-02-09']), { forPersonId: 'neha' })));
  const r = w.ok(send(w, '10:01', 'neha', '2027-01-12'));
  assert.equal(r.status, 'Approved', 'the first own request of 20 Nov');
});

test('owner 20 Nov: only the first short outing (15 min or less) of a day is free; the second one counts whole', () => {
  const w = world('2026-11-20');
  w.ok(w.call('2026-11-20', '09:30', 'checkIn', 'neha', PIC));
  const out = (from, back) => { const o = w.ok(w.call('2026-11-20', from, 'goingOut', 'neha', { reason: 'Bank', expectedMinutes: 10 })); w.ok(w.call('2026-11-20', from, 'decideOuting', 'aakash', { id: o.id, approve: true })); w.ok(w.call('2026-11-20', back, 'imBack', 'neha', { id: o.id })); };
  out('11:00', '11:10');
  assert.equal(w.month('2026-11-20', '11:20', 'neha').bank.used, 0, 'the first 10-minute outing is free');
  out('15:00', '15:12');
  assert.equal(w.month('2026-11-20', '15:20', 'neha').bank.used, 12, 'the second short outing of the day counts whole');
  w.ok(w.call('2026-11-21', '09:30', 'checkIn', 'neha', PIC));
  const o = w.ok(w.call('2026-11-21', '11:00', 'goingOut', 'neha', { reason: 'Bank', expectedMinutes: 10 })); w.ok(w.call('2026-11-21', '11:00', 'decideOuting', 'aakash', { id: o.id, approve: true })); w.ok(w.call('2026-11-21', '11:08', 'imBack', 'neha', { id: o.id }));
  assert.equal(w.month('2026-11-21', '11:20', 'neha').bank.used, 12, 'a new day has its own free outing');
});
