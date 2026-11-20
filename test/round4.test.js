// Round 4 - INDEPENDENT RE-REVIEW OF FIXES. Reproducers for GJ Leave & Attendance.
// Every test asserts the CORRECT behaviour, so every test here FAILS on the reviewed code.
// Run: node --test /home/claude/findings/repro-round4.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const ROOT = '/home/claude/gj-leave';
const SRC = ROOT + '/src/';
const Core = require(SRC + 'server/core.js');
const Att = require(SRC + 'server/attendance.js');
const Admin = require(SRC + 'server/admin.js');
const Jobs = require(SRC + 'server/jobs.js');
const Api = require(SRC + 'server/api.js');
const Store = require(SRC + 'server/store.js');
const { wrap } = require(SRC + 'server/cachegrid.js');
const { TABS } = require(SRC + 'server/schema.js');
const { seed, env } = require(ROOT + '/test/helpers.js');

const leave = (dates, extra) => ({ kind: 'full', dates, reasonCode: 'Personal work', reasonText: 'Bank work', ...extra });
const live = (s, personId) => s.db.rows('Violations').filter(v => v.disputeState !== 'removed' && (!personId || v.personId === personId));
const D = '2026-11-25'; // Wednesday. Nov 2026 Sundays: 1, 8, 15, 22, 29.
const ABSENT = 'Absent – unannounced';

// A signed-in world over the memory store (owner bootstrapped through the real login).
function apiWorld() {
  const s = seed();
  const call = (when, action, who, args) => Api.handle(s.ctx(...when), { action, clientVersion: 1, args, ...(who || {}) });
  const t = ['2026-11-20', '10:00'];
  s.db.update('People', 'varun', { pinSalt: 's', pinHash: env.sha256('s:9999') });
  const varun = { personId: 'varun', deviceToken: call(t, 'login', null, { personId: 'varun', pin: '9999' }).data.deviceToken };
  return { s, call, t, varun };
}

// =====================================================================================
// HIGH
// =====================================================================================

// H1. A leave that is granted AFTER the person has already arrived (or left) on that day does not
// re-count the day. The minutes booked at check-in / check-out, while the request was still waiting,
// stay as "not informed": the violation stays and the day is counted twice (0.5 leave + 0.5 automatic).
// For late / early requests the code corrects the day when Aakash decides later (shortId); for leave it does not.
test('H1a emergency half day asked at 05:00, Aakash approves it after she arrived at 14:00: still a "not informed" violation and 1 full leave day', () => {
  const s = seed(); const neha = s.actor('Neha'); // duty 09:30-18:30
  const r = Core.submitLeave(s.ctx(D, '05:00'), neha, leave([D], { kind: 'half', halfStart: '09:30' })); // half day 09:30-14:00
  assert.equal(r.status, 'Pending with Aakash');           // emergency: 4 h 30 min notice
  Att.checkIn(s.ctx(D, '14:00'), neha);                     // arrives exactly when the half day ends
  Core.decideLeave(s.ctx(D, '14:30'), s.actor('Aakash'), r.id, true); // Aakash approves half an hour later
  Att.checkOut(s.ctx(D, '18:30'), neha);
  const m = Att.myMonth(s.ctx(D, '20:00'), 'neha', '2026-11');
  // Control (approved at 10:30, before she arrives): taken 0.5, no violation.
  assert.deepEqual(live(s, 'neha').map(v => v.rule), [], 'the approved half day is still booked as 270 min "not informed" late');
  assert.equal(m.leaves.taken, 0.5, 'one half day is counted as ' + m.leaves.taken + ' leave days (0.5 leave + 0.5 automatic half day)');
});

test('H1b "called – emergency" entered by Aakash after the person has come in: the morning stays "not informed" (violation) and the day counts twice', () => {
  const s = seed(); const neha = s.actor('Neha');
  Att.checkIn(s.ctx(D, '14:00'), neha);                     // she phoned Aakash at 05:30; he has not typed it in yet
  const r = Core.submitLeave(s.ctx(D, '14:30'), s.actor('Aakash'), leave([D], { forPersonId: 'neha', kind: 'half', halfStart: '09:30', calledAt: '05:30' }));
  if (r.status !== 'Approved') Core.decideLeave(s.ctx(D, '14:35'), s.actor('Varun'), r.id, true);
  const m = Att.myMonth(s.ctx(D, '20:00'), 'neha', '2026-11');
  assert.deepEqual(live(s, 'neha').map(v => v.rule), []);
  assert.equal(m.leaves.taken, 0.5, 'counted ' + m.leaves.taken);
});

// =====================================================================================
// MEDIUM
// =====================================================================================

// M1. A half-day request that nobody decided before the day ended, and the person stayed away the WHOLE day.
// endOfDay only sends the "not decided" alert. decideLeave then skips half days on reject with the comment
// "the end-of-day job has dealt with it" - it has not. PROGRESS assumptions 18 and 19 promise an absence.
test('M1a half-day request still pending at night, person away all day, rejected next morning: nothing at all is recorded', () => {
  const s = seed(); const neha = s.actor('Neha');
  const r = Core.submitLeave(s.ctx(D, '05:00'), neha, leave([D], { kind: 'half', halfStart: '09:30' }));
  assert.equal(r.status, 'Pending with Aakash');
  Att.endOfDay(s.ctx(D, '21:00'), D);                        // no check-in at all that day
  Core.decideLeave(s.ctx('2026-11-26', '10:00'), s.actor('Aakash'), r.id, false, 'Not approved');
  const mine = s.db.rows('LeaveRequests').filter(x => x.personId === 'neha' && x.status === ABSENT);
  assert.equal(mine.length, 1, 'a full day away with a rejected request must be "Absent – unannounced" (assumption 19); found ' + mine.length);
  assert.equal(live(s, 'neha').length, 1);
});

test('M1b same, but approved next morning: only 0.5 is counted for a full day away (assumption 18: the other half is an absence)', () => {
  const s = seed(); const neha = s.actor('Neha');
  const r = Core.submitLeave(s.ctx(D, '05:00'), neha, leave([D], { kind: 'half', halfStart: '09:30' }));
  Att.endOfDay(s.ctx(D, '21:00'), D);
  Core.decideLeave(s.ctx('2026-11-26', '10:00'), s.actor('Aakash'), r.id, true);
  const m = Att.myMonth(s.ctx('2026-11-26', '12:00'), 'neha', '2026-11');
  assert.equal(m.leaves.taken, 1, 'away the whole of 25 Nov, counted ' + m.leaves.taken);
});

// M2. Round 1 no. 20 is only half fixed. decideLeave re-checks "no leave" restrictions, but the
// "+1 violation" kind is frozen at the moment of sending (row.restrictionViolation).
test('M2a "+1 violation" restriction switched off by Varun before the approval: the leave still gets the restricted-period violation', () => {
  const s = seed(); const varun = s.actor('Varun');
  const rr = Admin.saveRestriction(s.ctx('2026-11-20', '09:00'), varun, { from: '2026-12-10', to: '2026-12-12', note: 'Peak', rule: 'violation' });
  const r = Core.submitLeave(s.ctx('2026-11-20', '10:00'), s.actor('Vikas'), leave(['2026-12-10']));
  assert.equal(r.status, 'Pending with Aakash');
  Admin.saveRestriction(s.ctx('2026-11-21', '09:00'), varun, { id: rr.id, from: '2026-12-10', to: '2026-12-12', note: 'Peak', rule: 'violation', on: false });
  Core.decideLeave(s.ctx('2026-11-21', '10:00'), s.actor('Aakash'), r.id, true);
  assert.deepEqual(live(s, 'vikas').map(v => v.rule), [], 'no restriction is in force any more');
});

test('M2b "+1 violation" restriction added while the request waits: approved with no violation (round 1 no. 20, second half)', () => {
  const s = seed();
  const r = Core.submitLeave(s.ctx('2026-11-20', '10:00'), s.actor('Vikas'), leave(['2026-12-10', '2026-12-11', '2026-12-12'])); // 3 in a row -> Aakash
  assert.equal(r.status, 'Pending with Aakash');
  Admin.saveRestriction(s.ctx('2026-11-21', '09:00'), s.actor('Varun'), { from: '2026-12-10', to: '2026-12-12', note: 'Peak', rule: 'violation' });
  Core.decideLeave(s.ctx('2026-11-21', '10:00'), s.actor('Aakash'), r.id, true);
  assert.deepEqual(live(s, 'vikas').map(v => v.rule), ['leave-in-restricted-period']);
});

// M3. The new C1-E lock (fix for round 1 no. 14) fires whenever two Sales people have ANY away entry on a
// day, not only when an extreme emergency was granted. One approved leave + one colleague 15 min late
// (a not-informed late, which nobody can block) locks Bhawna and Pooja out of every going-out, late and
// early request that day, with a message about an "extreme emergency" that nobody asked for.
test('M3 Neha on approved leave, Vikas 15 min late: Bhawna cannot even ask for a 10-minute outing ("Sales is running on an extreme emergency")', () => {
  const s = seed();
  Core.submitLeave(s.ctx('2026-11-20', '10:00'), s.actor('Neha'), leave([D]));   // auto-approved
  Att.checkIn(s.ctx(D, '11:15'), s.actor('Vikas'));                                // duty 11:00, 15 min late, not informed
  Att.checkIn(s.ctx(D, '09:30'), s.actor('Bhawna'));
  let reply = null;
  try { reply = Att.goingOut(s.ctx(D, '14:00'), s.actor('Bhawna'), { reason: 'Medicine', expectedMinutes: 10 }); }
  catch (e) { reply = { blocked: e.message }; }
  assert.equal(reply.status, 'Pending', JSON.stringify(reply));
});

// =====================================================================================
// LOW
// =====================================================================================

// L1. "Rejected after the day has gone by" calls markAbsent for anyone. Aakash is not tracked
// (assumption 10, no check-in button for him), so he always "has no check-in".
test('L1 Varun rejects Aakash\'s own leave request a day late: Aakash gets "Absent – unannounced" + 1 violation (assumption 10: Aakash is not tracked)', () => {
  const s = seed();
  const r = Core.submitLeave(s.ctx('2026-11-20', '10:00'), s.actor('Aakash'), leave([D]));
  assert.equal(r.status, 'Pending with Varun');
  Core.decideLeave(s.ctx('2026-11-26', '10:00'), s.actor('Varun'), r.id, false, 'Could not spare you');
  assert.equal(s.db.rows('LeaveRequests').filter(x => x.personId === 'aakash' && x.status === ABSENT).length, 0);
  assert.equal(live(s, 'aakash').length, 0);
});

// L2. An excused half-day absence becomes an "Approved" half day with an empty start time. editLeave's
// "has it started?" check then compares with NaN and lets the staff member edit it; the Edit button is shown.
test('L2 excused half-day absence: the staff member can "edit" it into a new request and the missed half day disappears from the month', () => {
  const s = seed(); const harsh = s.actor('Harsh'); // duty 10:30-19:30
  Core.submitLeave(s.ctx('2026-11-20', '10:00'), harsh, leave([D], { kind: 'half', halfStart: '10:30' })); // auto-approved half day
  Att.endOfDay(s.ctx(D, '21:00'), D);                                                                       // never came: other half = absent
  const abs = s.db.rows('LeaveRequests').find(x => x.personId === 'harsh' && x.status === ABSENT);
  Att.excuseAbsence(s.ctx('2026-11-26', '10:00'), s.actor('Aakash'), abs.id, 'Was in hospital');
  assert.equal(Att.myMonth(s.ctx('2026-11-26', '10:30'), 'harsh', '2026-11').leaves.taken, 1);              // 0.5 leave + 0.5 excused absence
  let refused = false;
  try { Admin.editLeave(s.ctx('2026-11-26', '11:00'), harsh, abs.id, leave(['2026-12-30'])); } catch (e) { refused = true; }
  assert.ok(refused, 'a day that is over must not be editable by the staff member');
  assert.equal(Att.myMonth(s.ctx('2026-11-26', '12:00'), 'harsh', '2026-11').leaves.taken, 1);
});

// L3. Round 2 F14 is only moved, not fixed: Sign out copies the phone token to another localStorage key
// and the server is never told. The round 2 reproducer looks only at 'gjleave.session'.
test('L3 phone app: after "Sign out" the working phone token is still in the browser storage (key gjleave.device)', async () => {
  const fs = require('node:fs'), vm = require('node:vm');
  const made = [];
  const el = tag => {
    const e = { tag, kids: [], handlers: {}, attrs: {}, options: [], style: {}, hidden: false, textContent: '', value: '', className: '',
      appendChild(c) { this.kids.push(c); return c; }, replaceChildren(...c) { this.kids = c; }, replaceWith() {},
      addEventListener(k, fn) { this.handlers[k] = fn; }, setAttribute(k, v) { this.attrs[k] = v; } };
    made.push(e); return e;
  };
  const store = { 'gjleave.session': JSON.stringify({ personId: 'neha', deviceToken: 'TOKEN-ON-THIS-PHONE' }) };
  const sent = [];
  const replies = { me: { id: 'neha', name: 'Neha', role: 'staff', group: 'Sales', dutyStart: '09:30', dutyEnd: '18:30', reasons: [], serverTime: Date.now() },
    today: { date: '2026-11-20', hints: [], checkIn: null, checkOut: null, outing: null, shorts: [] }, notifications: [], names: [] };
  const sandbox = { console, setTimeout, clearTimeout, Promise, JSON, Date, Object, Math, String, Number, Array, Error,
    document: { getElementById: () => el('div'), createElement: el, createTextNode: t => ({ text: t }), body: el('body') },
    localStorage: { getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = v; }, removeItem: k => { delete store[k]; } },
    location: { search: '', origin: 'https://x.github.io', pathname: '/gj-leave/', reload() {} }, navigator: { userAgent: 'test' }, scrollTo() {},
    fetch: (url, o) => { const b = JSON.parse(o.body); sent.push(b.action); return Promise.resolve({ json: () => Promise.resolve({ ok: true, data: replies[b.action] }) }); } };
  sandbox.window = sandbox; sandbox.GJ_CONFIG = { API_URL: 'https://server.example/exec', CLIENT_VERSION: 1 };
  vm.runInNewContext(fs.readFileSync(ROOT + '/docs/app.js', 'utf8'), sandbox);
  await new Promise(r => setTimeout(r, 30));
  sandbox.GJApp.VIEWS.more();
  const before = sent.length;
  made.filter(e => e.tag === 'button' && e.kids.some(k => k.text === 'Sign out'))[0].handlers.click();
  await new Promise(r => setTimeout(r, 30));
  const everything = Object.keys(store).map(k => k + '=' + store[k]).join(' | ');
  const toldServer = sent.slice(before).some(a => a !== 'names');
  assert.ok(everything.indexOf('TOKEN-ON-THIS-PHONE') === -1 || toldServer,
    'the token still works on the server (authenticate needs no PIN) and is still stored: ' + everything);
});

// L4. A phone the owner rejected (one wrong tap) or removed can never ask again: login answers with the
// old status and makes no new request; the app keeps the token and shows "waiting for the owner's approval".
test('L4 rejected phone signs in again with the right PIN: no new request reaches the owner, the phone is stuck for ever', () => {
  const a = apiWorld();
  a.call(a.t, 'setPin', a.varun, { personId: 'neha', pin: '1111' });
  const first = a.call(a.t, 'login', null, { personId: 'neha', pin: '1111' }).data;
  a.call(a.t, 'decideDevice', a.varun, { id: first.deviceId, approve: false });            // owner tapped Reject
  const again = a.call(['2026-11-21', '10:00'], 'login', null, { personId: 'neha', pin: '1111', deviceToken: first.deviceToken }); // what app.js sends (knownToken)
  const waiting = a.s.db.rows('Devices').filter(d => d.personId === 'neha' && d.status === 'pending').length;
  assert.equal(waiting, 1, 'reply: ' + JSON.stringify(again.data) + ' - nothing for the owner to approve');
});

// L5. Round 2 F11 is only fixed for remindBack. requestShort still replaces and re-alerts without limit.
test('L5 alert flooding: 40 "I will be late" requests in one minute = 40 alerts (and e-mails) to Aakash', () => {
  const s = seed(); const neha = s.actor('Neha');
  for (let i = 0; i < 40; i++) Att.requestShort(s.ctx(D, '08:00'), neha, { kind: 'late', time: '10:00' });
  const alerts = s.db.rows('Notifications').filter(n => n.to === 'aakash').length;
  assert.ok(alerts <= 5, alerts + ' alerts to Aakash');
});

// L6. Round 3 F13: the duplicate guard is a 30-second window, not a request id. A retry after a slow reply
// (lock wait alone can be 25 s) is counted as a second incident.
test('L6 the same incident sent again 40 seconds later (slow reply, retry) is counted twice = a second violation', () => {
  const s = seed(); const aakash = s.actor('Aakash');
  const arg = { personId: 'neha', item: 'job-sheet', note: 'Job sheet 4411 not filled' };
  Admin.recordIncident(s.ctx(D, '12:00'), aakash, arg);
  const later = s.ctx(D, '12:00'); later.now += 40000;
  Admin.recordIncident(later, aakash, arg);
  assert.equal(s.db.rows('Incidents').length, 1);
  assert.equal(live(s, 'neha').length, 1);
});

// L7. Round 3 F12, second half ("a day that was never closed is never checked"): the job only looks at today.
test('L7 the 21:00 job did not run on 25 Nov (trigger failure): the next evening\'s run never records the 25 Nov absences', () => {
  const s = seed();
  Jobs.run(s.ctx('2026-11-26', '21:00'), 'endOfDay', { quota: () => 0, send() {} });
  const dates = s.db.rows('LeaveRequests').filter(r => r.status === ABSENT).map(r => r.dates[0]);
  assert.ok(dates.indexOf(D) !== -1, 'absent rows only for: ' + dates.filter((d, i) => dates.indexOf(d) === i).join(', '));
});

// L8. Round 3 F11: times are still checked by shape only in savePerson.
test('L8 duty end "29:99" is accepted for a person (every time calculation for that person is then wrong)', () => {
  const s = seed();
  let refused = false;
  try { Admin.savePerson(s.ctx(D, '10:00'), s.actor('Varun'), { id: 'neha', name: 'Neha', group: 'Sales', role: 'staff', dutyStart: '09:30', dutyEnd: '29:99', sundayOff: [3, 4], active: true }); }
  catch (e) { refused = true; }
  assert.ok(refused);
});

// L9. The call time of a "called – emergency" entry (assumption 24) is lost on any edit: the notice is
// measured again from the moment of the edit.
test('L9 Aakash corrects the reason text of a "called – emergency" entry: it turns into Unannounced (+1 violation when approved again)', () => {
  const s = seed();
  const r = Core.submitLeave(s.ctx(D, '12:00'), s.actor('Aakash'), leave([D], { forPersonId: 'neha', calledAt: '06:00' })); // call 3 h 30 min before duty
  assert.equal(s.db.rows('LeaveRequests')[0].type, 'Emergency');
  Core.decideLeave(s.ctx(D, '12:01'), s.actor('Varun'), r.id, true);
  Admin.editLeave(s.ctx(D, '12:10'), s.actor('Aakash'), r.id, leave([D], { reasonText: 'Mother in hospital' }));
  assert.equal(s.db.rows('LeaveRequests')[0].type, 'Emergency', 'the entry became ' + s.db.rows('LeaveRequests')[0].type);
});

// L10. What the changed round 2 "F1b" test gave up: an edit withdraws the violation at once, before
// anybody has decided the new version. While it waits, "no violation this month" is true again.
test('L10 no-op edit of an approved unannounced leave parks its violation; a second request is then auto-approved (3.4: a violation this month = Aakash)', () => {
  const s = seed(); const neha = s.actor('Neha');
  const r = Core.submitLeave(s.ctx(D, '07:00'), neha, leave([D]));                          // 2 h 30 min notice: Unannounced
  Core.decideLeave(s.ctx(D, '07:10'), s.actor('Aakash'), r.id, true);
  assert.equal(live(s, 'neha').length, 1);
  assert.equal(Core.previewLeave(s.ctx(D, '07:15'), neha, leave(['2026-11-30'])).decision, 'aakash'); // honest result
  Admin.editLeave(s.ctx(D, '07:20'), neha, r.id, leave([D]));                                // same dates, same text
  const second = Core.submitLeave(s.ctx(D, '07:21'), neha, leave(['2026-11-30']));
  assert.equal(second.status, 'Pending with Aakash', 'the second request was ' + second.status);
});

// L11. Round 1 no. 15 / round 3 F9 ("closed day added later: re-count"): the leave day is re-counted,
// the violation of an absence on that day is not.
test('L11 the shop was closed on 25 Nov but it is entered the next morning: every "absent" violation of that day stays', () => {
  const s = seed();
  Att.endOfDay(s.ctx(D, '21:00'), D);
  assert.ok(live(s).length > 0);
  Admin.setSetting(s.ctx('2026-11-26', '09:00'), s.actor('Varun'), 'closedDays', [D]);
  assert.equal(Att.myMonth(s.ctx('2026-11-26', '10:00'), 'neha', '2026-11').ladder.violations, 0);
});

// L12. Round 2 F2b on the "own approved phone" path: the lock is always 15 minutes.
test('L12 PIN guessing on the person\'s own (signed-out) phone: the lock never grows beyond 15 minutes', () => {
  const a = apiWorld();
  a.call(a.t, 'setPin', a.varun, { personId: 'neha', pin: '1111' });
  const lg = a.call(a.t, 'login', null, { personId: 'neha', pin: '1111' }).data;
  a.call(a.t, 'decideDevice', a.varun, { id: lg.deviceId, approve: true });
  let now = a.s.ist('2026-11-21', '10:00'); const locks = [];
  for (let round = 0; round < 3; round++) {
    for (let i = 0; i < 5; i++) Api.handle({ db: a.s.db, env, now }, { action: 'login', clientVersion: 1, args: { personId: 'neha', pin: '0000', deviceToken: lg.deviceToken } });
    const d = a.s.db.rows('Devices').find(x => x.id === lg.deviceId);
    locks.push(Math.round((d.pinLockedUntil - now) / 60000)); now = d.pinLockedUntil + 1000;
  }
  assert.ok(locks[2] > locks[0], 'lock minutes after 5, 10, 15 wrong PINs: ' + locks.join(', '));
});

// L13. Round 3 note N3, still open and now testable: when the cache refuses the version bump after a write
// (cachegrid.commit swallows the error), every later request - also inside the server lock - keeps reading
// the copy from BEFORE the write for up to 10 minutes.
test('L13 cache hiccup on the version bump: the next approval is decided on stale rows and two clashing leaves are both Approved', () => {
  const tabs = {};
  const g = { tabNames: () => Object.keys(tabs), addTab: n => { tabs[n] = []; }, read: n => (tabs[n] || []).map(r => r.slice()),
    headers: n => (tabs[n] && tabs[n][0] || []).slice(), tail: (n, k) => tabs[n].slice(1).slice(-k).map(r => r.slice()),
    append: (n, row) => g.appendRows(n, [row]), appendRows: (n, rows) => g.appendMany([{ tab: n, rows }])[n],
    appendMany: batch => { const first = {}; batch.forEach(b => { first[b.tab] = tabs[b.tab].length; b.rows.forEach(r => tabs[b.tab].push(r.map(String))); }); return first; },
    writeRow: (n, i, row) => { tabs[n][i] = row.map(String); } };
  Store.setup(g);
  const m = new Map(); let failPutAll = false;
  const cache = { getAll: keys => { const o = {}; keys.forEach(k => { if (m.has(k)) o[k] = m.get(k); }); return o; }, put: (k, v) => { m.set(k, v); },
    putAll: map => { if (failPutAll) throw new Error('Service error: Cache'); Object.keys(map).forEach(k => m.set(k, map[k])); } };
  const mem = seed(); const db0 = Store.open(g); let vn = 0;
  mem.db.rows('People').forEach(p => db0.insert('People', p));
  mem.db.rows('People').forEach(p => db0.insert('Devices', { id: 'dev_' + p.id, personId: p.id, tokenHash: env.sha256('tok-' + p.id), label: '', status: 'approved', requestedAt: 1, decidedAt: 1, decidedBy: 'test' }));
  function doPost(when, action, person, args) { // mirrors doPost + withLock in src/gas/main.js
    const db = Store.open(wrap(g, cache, Object.keys(TABS), () => 'v' + (++vn)), { buffer: true }); let depth = 0;
    const e = Object.assign({}, env, { withLock(fn) { if (depth > 0) return fn(); depth += 1; try { return fn(); } finally { try { db.flush(); } finally { depth -= 1; } } } });
    const reply = Api.handle({ db, now: mem.ist(...when), env: e }, { action, clientVersion: 1, args: args || {}, personId: person, deviceToken: 'tok-' + person });
    db.flush(); return reply;
  }
  const a = doPost(['2026-11-24', '12:00'], 'submitLeave', 'bhawna', leave([D])).data;   // emergency -> Pending with Aakash
  const b = doPost(['2026-11-24', '12:01'], 'submitLeave', 'pooja', leave([D])).data;
  doPost(['2026-11-24', '12:02'], 'approvals', 'aakash');
  failPutAll = true;                                                                       // CacheService fails once, during this commit
  assert.equal(doPost(['2026-11-24', '12:03'], 'decideLeave', 'aakash', { id: a.id, approve: true }).data.status, 'Approved');
  failPutAll = false;
  const second = doPost(['2026-11-24', '12:04'], 'decideLeave', 'aakash', { id: b.id, approve: true });
  // C2: Bhawna and Pooja are never both away. Bhawna holds the slot.
  assert.equal(second.data && second.data.status, 'Rejected – clash', JSON.stringify(second));
});
