// Round 19 reproducers, commit ab1f7f3 (server version 9, schema 4). Every test FAILS on the reviewed code for the reason in its name.
// Harness copied from /home/claude/gj-leave/test/owner-rules-20nov.test.js. Run: node --test /home/claude/findings/repro-round19.test.js
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
// R19-1 An edit of the 4th-6th request of a day is decided without the per-day rule: auto-approved, although the
// preview of that same edit says "goes to Aakash" (admin.js editLeave calls H.evaluate but not requestLimit).
// ===================================================================================================================
test('R19-1 editing the 4th request of the day (pending with Aakash for "too many") must not auto-approve it', () => {
  const w = world('2026-11-20');
  // as in the project's own test: three sends, each cancelled again (they still count as sends of the day)
  ['2026-12-01', '2026-12-02', '2026-12-03'].forEach((d, i) => { const x = w.ok(send(w, '10:0' + i, 'neha', d)); assert.equal(x.status, 'Approved', 'setup'); w.ok(w.call('2026-11-20', '10:0' + i, 'cancelLeave', 'neha', { id: x.id })); });
  const r = w.ok(send(w, '10:04', 'neha', '2026-12-04'));
  assert.equal(r.status, 'Pending with Aakash', 'setup: the 4th goes to Aakash');
  const edit = Object.assign(lv(['2026-12-09']), { id: r.id, editId: r.id });
  const p = w.ok(w.call('2026-11-20', '10:05', 'previewLeave', 'neha', edit));
  assert.equal(p.decision, 'aakash', 'setup: the preview of the edit says it goes to Aakash');
  const e = w.ok(w.call('2026-11-20', '10:06', 'editLeave', 'neha', edit));
  assert.equal(e.status, 'Pending with Aakash', 'the edited 4th request must still need Aakash (the preview said so), but it was ' + e.status);
});

// ===================================================================================================================
// R19-2 The red "request number N" line on an Approvals card counts the requests sent LATER that day too
// (views.js: H.sentOnDay(ctx, personId, h0.at, r.id) counts the whole IST day, not the sends before this one).
// ===================================================================================================================
test('R19-2 the FIRST request of a day must not carry the red "too many" line because three more were sent after it', () => {
  const w = world('2026-11-20');
  const first = w.ok(send(w, '09:00', 'neha', '2026-11-21'));
  assert.match(first.status, /^Pending/, 'setup: short notice, it waits for approval');
  ['2026-12-01', '2026-12-02', '2026-12-03'].forEach((d, i) => { const x = w.ok(send(w, '10:0' + i, 'neha', d)); w.ok(w.call('2026-11-20', '10:0' + i, 'cancelLeave', 'neha', { id: x.id })); });
  const card = w.ok(w.call('2026-11-20', '11:00', 'approvals', 'aakash')).leaves.find(x => x.id === first.id);
  assert.ok(card, 'setup: the first request is on the Approvals screen');
  assert.equal(card.context.tooMany, undefined, 'request number 1 of the day was shown in red as request number ' + card.context.tooMany);
});

// ===================================================================================================================
// R19-3 One Settings save that changes the duty hours AND the Sunday roster (or "records only" / active) writes the
// history entry "until today" (admin.js savePerson: until = hours ? today : yesterday), so the roster change also
// starts only TOMORROW, against its own comment "the other changes from today". Today the person is still expected.
// ===================================================================================================================
test('R19-3 a Sunday off given for today in the same save as new duty hours must make today a roster day off', () => {
  const w = world('2026-11-22');
  // Sunday 22 Nov 2026 is the 4th Sunday; Vikas has the 1st and 2nd off, so today he would work.
  changePerson(w, '2026-11-22', '08:00', 'vikas', { sundayOff: [1, 2, 4] });
  const control = w.ok(w.call('2026-11-22', '08:01', 'board', 'aakash', {})).people.find(p => p.id === 'vikas');
  assert.equal(control.state, 'Roster off', 'control: the roster change alone applies from today');
  const w2 = world('2026-11-22');
  changePerson(w2, '2026-11-22', '08:00', 'vikas', { sundayOff: [1, 2, 4], dutyStart: '11:30', dutyEnd: '20:30' });
  const v = w2.ok(w2.call('2026-11-22', '08:01', 'board', 'aakash', {})).people.find(p => p.id === 'vikas');
  w2.job('2026-11-22', '23:30', 'endOfDay');
  assert.deepEqual(absences(w2, 'vikas'), [], 'Vikas, given today off, is marked absent tonight: ' + JSON.stringify(absences(w2, 'vikas')) + ' (board said ' + v.state + ')');
});

// ===================================================================================================================
// R19-4 The "first phone is in use" marker (api.js: decidedBy 'bootstrap' -> 'bootstrap-used') is set only inside
// the write path. An owner who only LOOKS (me, board, approvals) in his first 15 minutes keeps the 'bootstrap' row, so
// a second sign-in with his PIN from a phone of the same kind is let in at once and his own phone is signed out
// (the round 18 M3 case, without the write step).
// ===================================================================================================================
test('R19-4 owner signed in and is reading screens; a second same-kind phone with his PIN must be a pending request, and his phone must stay in', () => {
  const w = world('2026-11-20');
  const db = Store.open(w.g);
  db.update('Devices', 'dev_varun', { status: 'revoked' }); // no owner phone yet: the next owner sign-in is the bootstrap
  db.update('People', 'varun', { pinSalt: 's1', pinHash: crypto.createHash('sha256').update('s1:4321').digest('hex') });
  const label = 'Android phone, Chrome';
  const first = w.ok(w.call('2026-11-20', '10:00', 'login', null, { personId: 'varun', pin: '4321', deviceLabel: label }));
  assert.equal(first.deviceStatus, 'approved', 'setup: bootstrap');
  const owner = { personId: 'varun', deviceToken: first.deviceToken };
  // Changed after the review: withLock now flushes, as the real Apps Script withLock does (src/gas/main.js); without it nothing a call writes reaches the Sheet.
  const as = (t, action, args) => { const db1 = Store.open(w.g); return Api.handle({ db: db1, now: ist('2026-11-20', t), env: { sha256: s => crypto.createHash('sha256').update(s).digest('hex'), randomId: () => 'r' + Math.random().toString(36).slice(2), withLock: fn => { const r = fn(); db1.flush(); w.cache.m && w.cache.m.clear(); return r; } } }, Object.assign({ action, clientVersion: 1, args: args || {} }, owner)); };
  assert.equal(as('10:01', 'me').ok, true, 'setup: the owner\'s phone works (the reply was not lost)');
  assert.equal(as('10:02', 'board').ok, true, 'setup: he looks at the board');
  const second = w.ok(w.call('2026-11-20', '10:05', 'login', null, { personId: 'varun', pin: '4321', deviceLabel: label }));
  const still = as('10:06', 'me');
  assert.deepEqual({ secondPhone: second.deviceStatus, ownerStillSignedIn: still.ok || still.code }, { secondPhone: 'pending', ownerStillSignedIn: true });
});
