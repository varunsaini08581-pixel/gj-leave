// Round 8 reproducers (full shop-day / shop-month simulation). Every test here is written to FAIL on the current code,
// for the reason given in round8.md under the same number. Extracted from the big simulations so each stands alone.
// Everything goes through Api.handle on the Sheet store with the cache, the way doPost does, and Jobs.run for the timed jobs.
// Run: node --test /home/claude/findings/repro-round8.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const SRC = __dirname + '/../src/';
const Store = require(SRC + 'server/store.js');
const Api = require(SRC + 'server/api.js');
const Jobs = require(SRC + 'server/jobs.js');
const { wrap } = require(SRC + 'server/cachegrid.js');
const { TABS } = require(SRC + 'server/schema.js');
const Cal = require(SRC + 'rules/calendar.js');

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
const hm = (t, add) => { const m = +t.slice(0, 2) * 60 + +t.slice(3) + add; return String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0'); };
const PIC = { photo: 'data:image/jpeg;base64,AAAA', thumb: 'data:image/jpeg;base64,BBBB', lat: 29.15, lng: 75.72, accuracy: 10 };
const lv = (dates, extra) => Object.assign({ kind: 'full', dates, reasonCode: 'Personal work', reasonText: 'Bank work' }, extra);
const D = d => '2026-12-' + String(d).padStart(2, '0');   // December 2026: 1 = Tuesday; Sundays 6, 13, 20, 27

function world(startDate) {
  const g = fakeGrid(); Store.setup(g); const cache = fakeCache(); let vn = 0, seq = 0;
  const env = { sha256: s => crypto.createHash('sha256').update(s).digest('hex'), randomId: () => 'id' + (++seq) + '_' + ('00000' + seq).slice(-6),
    withLock: fn => fn(), photos: {}, savePhoto(name, data) { const id = 'photo_' + name; this.photos[id] = data; return id; }, readPhoto(id) { return this.photos[id]; } };
  const db0 = Store.open(g); const who = {};
  ROSTER.forEach(([name, group, role, dutyStart, dutyEnd, sundayOff]) => {
    const id = name.toLowerCase();
    db0.insert('People', { id, name, group, role, dutyStart, dutyEnd, sundayOff, noApproval: name === 'Muskan', noClash: name === 'Muskan' || name === 'Anita', noQuota: name === 'Muskan', dressExempt: name === 'Anita', active: true, pinTries: 0 });
    db0.insert('Devices', { id: 'dev_' + id, personId: id, tokenHash: env.sha256('tok-' + id), label: '', status: 'approved', requestedAt: 1, decidedAt: 1, decidedBy: 'test' });
    db0.insert('PayInfo', { personId: id, fixedSalary: 17000, targetAllowance: 2000, disciplineBonus: 500, dutyHours: (ist('2026-01-01', dutyEnd) - ist('2026-01-01', dutyStart)) / 3600000 });
    who[id] = { personId: id, deviceToken: 'tok-' + id };
  });
  db0.insert('Settings', { key: 'startDate', value: startDate });
  const open = () => Store.open(wrap(g, cache, Object.keys(TABS), () => 'v' + (++vn)), { buffer: true });
  const locker = db => { let depth = 0; return fn => { if (depth > 0) return fn(); depth += 1; try { return fn(); } finally { try { db.flush(); } finally { depth -= 1; } } }; };
  function call(date, hhmm, action, person, args) {
    const db = open();
    const reply = Api.handle({ db, now: ist(date, hhmm), env: Object.assign({}, env, { photos: env.photos, withLock: locker(db) }) }, Object.assign({ action, clientVersion: 1, args: args || {} }, person ? who[person] : {}));
    db.flush(); return reply;
  }
  function job(date, hhmm, name) { const db = open(); const out = Jobs.run({ db, now: ist(date, hhmm), env: Object.assign({}, env, { withLock: locker(db) }) }, name, null); db.flush(); return out; }
  const ok = r => { assert.equal(r.ok, true, JSON.stringify(r)); return r.data; };
  const sheet = tab => Store.open(g).rows(tab);
  // A plain working day for everybody except the people in `away`: in 1 min before duty, out at duty end.
  const plainDay = (d, away) => ROSTER.filter(r => r[2] === 'staff').forEach(([name, , , ds, de, off]) => { const p = name.toLowerCase();
    if ((away || []).indexOf(p) !== -1 || Cal.isRosterOff({ sundayOff: off }, d)) return; ok(call(d, hm(ds, -1), 'checkIn', p, PIC)); ok(call(d, de, 'checkOut', p)); });
  const month = (d, t, p, m) => ok(call(d, t, 'myMonth', p, { month: m || d.slice(0, 7) }));
  const told = (to, kind) => sheet('Notifications').filter(n => n.to === to && (!kind || n.kind === kind));
  return { call, job, ok, sheet, plainDay, month, told };
}
const rules = m => m.violations.map(v => v.rule);

// =====================================================================================================
// R8-1 (High). A person who was in the shop all day but could not check in (phone dead, no internet, app
// down - handoff Part 2 no. 11) is marked "Absent – unannounced" at 21:00, and that can never be put right:
// the leave day stays counted. Hand count: present all day = 0 leave, 0 violations.
// =====================================================================================================
test('R8-1a High: Aakash enters the check-in the same evening, after the 21:00 job -> accepted, but the absence and its violation stay', () => {
  const w = world(D(2));
  w.plainDay(D(2), ['neha']);                                            // Neha is there, her phone is dead
  assert.deepEqual(w.job(D(2), '21:15', 'endOfDay').absent, ['Neha']);
  w.ok(w.call(D(2), '21:30', 'manualCheckIn', 'aakash', { personId: 'neha', time: '09:30', reason: 'Phone dead, she was here all day' }));
  const m = w.month(D(2), '21:40', 'neha');
  assert.deepEqual([m.leaves.taken, rules(m)], [0, []], 'a day with a check-in entered by Aakash is still counted as an unannounced absence');
});
test('R8-1b High: next morning there is no way to take back an absence recorded for someone who was present', () => {
  const w = world(D(2));
  w.plainDay(D(2), ['neha']); w.job(D(2), '21:15', 'endOfDay');
  const a = w.ok(w.call(D(3), '10:00', 'approvals', 'aakash')).absences[0];
  // Everything Aakash can do with it: cancel it (refused), or mark it "humanitarian – excused".
  const cancel = w.call(D(3), '10:01', 'cancelLeave', 'aakash', { id: a.id, reason: 'She was present, phone dead' });
  if (!cancel.ok) w.ok(w.call(D(3), '10:02', 'excuseAbsence', 'aakash', { id: a.id, reason: 'She was present, phone dead' }));
  const m = w.month(D(3), '10:05', 'neha');
  assert.equal(m.leaves.taken, 0, 'one of her 5 leaves is used for a day she worked');
});

// =====================================================================================================
// R8-2 (Medium). NEW with the round 7 fix "emergencies are numbered again": an "Emergency beyond 2" violation
// that Varun REMOVED after a dispute is recorded again, by itself, the next time any leave of that month is
// granted to the person. Hand count: Varun removed it = 0 violations, and it stays 0.
// =====================================================================================================
test('R8-2 Medium: a 3rd-emergency violation removed by Varun after a dispute comes back when the next leave is granted', () => {
  const w = world(D(1));
  const em = (d, t, day) => { const e = w.ok(w.call(d, t, 'submitLeave', 'manish', lv([day], { reasonCode: 'Family emergency' }))); w.ok(w.call(d, hm(t, 5), 'decideLeave', 'aakash', { id: e.id, approve: true })); };
  em(D(1), '20:00', D(2)); em(D(7), '20:00', D(8)); em(D(9), '20:00', D(10));                                // the 3rd: violation
  const v = w.month(D(10), '08:00', 'manish').violations[0];
  w.ok(w.call(D(10), '08:05', 'disputeViolation', 'manish', { id: v.id, text: 'Father in ICU, papers attached' }));
  w.ok(w.call(D(10), '12:00', 'decideDispute', 'varun', { id: v.id, uphold: false, note: 'Genuine. Removed.' }));
  assert.deepEqual(rules(w.month(D(10), '12:10', 'manish')), []);                                           // correct so far
  const told = w.told('varun', 'violation').length;
  const r = w.ok(w.call(D(11), '10:00', 'submitLeave', 'manish', lv([D(22)])));                              // an ordinary leave, 11 days ahead
  if (r.status !== 'Approved') w.ok(w.call(D(11), '10:05', 'decideLeave', 'aakash', { id: r.id, approve: true }));
  assert.deepEqual(rules(w.month(D(11), '10:10', 'manish')), [], 'the violation Varun removed is back');
  assert.equal(w.told('varun', 'violation').length, told, 'and it is announced again as a new violation');
});

// =====================================================================================================
// R8-3 (Medium). Aakash is on approved leave (handoff Part 6: "Aakash on leave: Varun approves"). After the
// round 7 fix Varun is told about LEAVE requests, but a going-out request (needs an answer in minutes), the
// "I'm back" tap and a late / early request (with its 2-hour reminders) still go to Aakash alone.
// =====================================================================================================
test('R8-3 Medium: on a day Aakash is on leave, Varun gets no alert for a going-out request or a late / early request', () => {
  const w = world(D(8));
  const la = w.ok(w.call(D(1), '10:00', 'submitLeave', 'aakash', lv([D(8)]))); w.ok(w.call(D(1), '10:05', 'decideLeave', 'varun', { id: la.id, approve: true }));
  w.ok(w.call(D(8), '10:28', 'checkIn', 'harsh', PIC));
  w.ok(w.call(D(8), '13:00', 'goingOut', 'harsh', { reason: 'Bank', expectedMinutes: 20 }));
  w.ok(w.call(D(8), '13:05', 'requestShort', 'bhawna', { kind: 'early', date: D(8), time: '18:00' }));
  w.ok(w.call(D(8), '13:10', 'submitLeave', 'raunak', lv([D(9)], { reasonCode: 'Family emergency' })));
  ['15:07', '17:07'].forEach(t => w.job(D(8), t, 'hourly'));
  const v = w.told('varun').map(n => n.kind + ': ' + n.title);
  assert.ok(v.some(x => /Leave request/.test(x) && /^approval/.test(x)), 'leave request (fixed in round 7)');
  assert.ok(v.some(x => /Going out: Harsh/.test(x)), 'going-out request: Varun has only ' + JSON.stringify(v));
  assert.ok(v.some(x => /Bhawna asks to leave early/.test(x)), 'early-leaving request');
});

// =====================================================================================================
// R8-4 (Medium). NEW with the round 7 fix "cancelling a running leave keeps the days already taken": the days
// "from today on" are given back, also when the person is still away today. Vikas, approved leave 9-11 Dec.
// On the 10th he phones: "back tomorrow". Aakash cancels the rest. That night Vikas is "Absent – unannounced"
// for the 10th. Hand count: 9th and 10th leave, 11th given back, 0 violations.
// =====================================================================================================
test('R8-4 Medium: Aakash cancels the rest of a running leave while the person is still away -> today becomes an unannounced absence + violation', () => {
  const w = world(D(8));
  w.plainDay(D(8)); w.job(D(8), '21:15', 'endOfDay');
  const l = w.ok(w.call(D(1), '12:00', 'submitLeave', 'vikas', lv([D(9), D(10), D(11)]))); w.ok(w.call(D(1), '12:30', 'decideLeave', 'aakash', { id: l.id, approve: true }));
  w.plainDay(D(9), ['vikas']); w.job(D(9), '21:15', 'endOfDay');
  w.plainDay(D(10), ['vikas']);
  w.ok(w.call(D(10), '12:00', 'cancelLeave', 'aakash', { id: l.id, reason: 'He phoned: back tomorrow' }));
  const out = w.job(D(10), '21:15', 'endOfDay');
  const m = w.month(D(10), '22:00', 'vikas');
  assert.deepEqual([out.absent, rules(m)], [[], []]);
});

// =====================================================================================================
// R8-5 (Medium). The month lock freezes requests that are not only in the locked month.
// =====================================================================================================
test('R8-5a Medium: a leave that crosses the month end cannot be cancelled or shortened for its December days once November is locked', () => {
  const w = world('2026-11-30');
  // Neha: 30 Nov - 2 Dec, approved. November is locked on 1 Dec. She comes back on 1 Dec and works the 1st and 2nd.
  const l = w.ok(w.call('2026-11-20', '10:00', 'submitLeave', 'neha', lv(['2026-11-30', D(1), D(2)]))); w.ok(w.call('2026-11-20', '10:05', 'decideLeave', 'aakash', { id: l.id, approve: true }));
  w.plainDay('2026-11-30', ['neha']); w.job('2026-11-30', '21:15', 'endOfDay');
  w.ok(w.call(D(1), '09:00', 'lockMonth', 'aakash', { month: '2026-11' })); w.ok(w.call(D(1), '09:05', 'lockMonth', 'varun', { month: '2026-11' }));
  w.plainDay(D(1)); w.plainDay(D(2));
  const cancel = w.call(D(2), '12:00', 'cancelLeave', 'aakash', { id: l.id, reason: 'Came back on the 1st' });
  const edit = w.call(D(2), '12:01', 'editLeave', 'aakash', Object.assign({ id: l.id }, lv(['2026-11-30'])));
  const dec = w.month(D(2), '22:00', 'neha', '2026-12');
  assert.equal(dec.leaves.taken, 0, 'December (not locked) keeps 2 leave days she worked; cancel: ' + cancel.message + ' / edit: ' + edit.message);
});
test('R8-5b Medium: a request still waiting when its month is locked can never be decided or cancelled, and reminds Aakash every 2 hours for ever', () => {
  const w = world('2026-11-29');
  w.plainDay('2026-11-29'); w.job('2026-11-29', '21:15', 'endOfDay');
  const p = w.ok(w.call('2026-11-29', '20:00', 'submitLeave', 'raunak', lv(['2026-11-30'], { reasonCode: 'Family emergency' })));   // emergency: waits for Aakash
  w.plainDay('2026-11-30', ['raunak']); w.job('2026-11-30', '21:15', 'endOfDay');
  w.ok(w.call(D(1), '09:00', 'lockMonth', 'aakash', { month: '2026-11' })); w.ok(w.call(D(1), '09:05', 'lockMonth', 'varun', { month: '2026-11' }));
  const decide = w.call(D(1), '12:00', 'decideLeave', 'aakash', { id: p.id, approve: true });
  const reject = w.call(D(1), '12:01', 'decideLeave', 'aakash', { id: p.id, approve: false, reason: 'Too late' });
  let reminders = 0; for (let h = 0; h < 24; h++) reminders += w.job(D(5), String(h).padStart(2, '0') + ':07', 'hourly').reminders;     // four days later
  assert.ok(decide.ok || reject.ok || reminders === 0, 'approve: ' + decide.code + ', reject: ' + reject.code + ', reminders on 5 Dec alone: ' + reminders);
});

// =====================================================================================================
// R8-6 (Medium). When a recorded violation is withdrawn, nobody who was told about it is told that it is gone.
// =====================================================================================================
test('R8-6a Medium: early-leaving request approved after she left -> the violation is withdrawn, Varun keeps the "Violation recorded" alert and nothing else', () => {
  const w = world(D(2));
  w.ok(w.call(D(2), '09:28', 'checkIn', 'bhawna', PIC));
  const q = w.ok(w.call(D(2), '17:00', 'requestShort', 'bhawna', { kind: 'early', date: D(2), time: '17:30' }));
  w.ok(w.call(D(2), '17:30', 'checkOut', 'bhawna'));                                                         // 60 min early, request still waiting
  assert.equal(w.told('varun', 'violation').length, 1);                                                     // "Violation recorded: Bhawna ..."
  w.ok(w.call(D(2), '19:00', 'decideShort', 'aakash', { id: q.id, approve: true }));
  assert.deepEqual(rules(w.month(D(2), '19:05', 'bhawna')), []);                                            // withdrawn: correct
  const after = w.sheet('Notifications').filter(n => n.createdAt >= ist(D(2), '19:00'));
  assert.ok(after.some(n => n.to === 'varun'), 'Varun is not told that the violation was withdrawn');
  assert.ok(after.some(n => n.to === 'bhawna' && /violation/i.test(n.title + ' ' + n.body)), 'Bhawna is told "Early leaving approved" only; her "Violation recorded" alert stands');
});
test('R8-6b Medium: Aakash marks an absence "humanitarian – excused" -> the person is not told, and Varun is not told', () => {
  const w = world(D(2));
  w.plainDay(D(2), ['harsh']); w.job(D(2), '21:15', 'endOfDay');
  const a = w.ok(w.call(D(3), '10:00', 'approvals', 'aakash')).absences[0];
  const n0 = w.sheet('Notifications').length;
  w.ok(w.call(D(3), '10:05', 'excuseAbsence', 'aakash', { id: a.id, reason: 'Hospital, showed the papers' }));
  const after = w.sheet('Notifications').slice(n0).map(n => n.to);
  assert.deepEqual(after.sort(), ['harsh', 'varun'], 'alerts after the excuse: ' + JSON.stringify(after));
});

// =====================================================================================================
// R8-7 (Medium). The alert to Varun and Aakash for a violation that comes from a leave does not say who.
// =====================================================================================================
test('R8-7 Medium: "Violation recorded – Unannounced leave": the alert to Varun and to Aakash does not name the person', () => {
  const w = world(D(2));
  const r = w.ok(w.call(D(2), '10:45', 'submitLeave', 'harsh', lv([D(2)], { reasonCode: 'Sick' })));       // told after duty start
  w.ok(w.call(D(2), '11:00', 'decideLeave', 'aakash', { id: r.id, approve: true }));
  ['varun', 'aakash'].forEach(to => { const n = w.told(to, 'violation')[0]; assert.match(n.title + ' ' + n.body, /Harsh/, to + ' reads: "' + n.title + ' – ' + n.body + '"'); });
});

// =====================================================================================================
// R8-8 (Low). The same entry sent twice (a retry after a slow reply) is stored twice.
// =====================================================================================================
test('R8-8 Low: a correction and a restriction sent twice are stored twice', () => {
  const w = world('2026-11-30');
  w.plainDay('2026-11-30'); w.job('2026-11-30', '21:15', 'endOfDay');
  w.ok(w.call(D(1), '09:00', 'lockMonth', 'aakash', { month: '2026-11' })); w.ok(w.call(D(1), '09:05', 'lockMonth', 'varun', { month: '2026-11' }));
  const c = { month: '2026-11', personId: 'raunak', note: '24 Nov: had informed by phone' };
  w.call(D(1), '10:00', 'addCorrection', 'aakash', c); w.call(D(1), '10:00', 'addCorrection', 'aakash', c);
  const r = { from: D(20), to: D(22), note: 'Year end rush', rule: 'no-leave' };
  w.call(D(1), '10:05', 'saveRestriction', 'aakash', r); w.call(D(1), '10:05', 'saveRestriction', 'aakash', r);
  assert.deepEqual([w.ok(w.call(D(1), '10:10', 'monthReport', 'aakash', { month: '2026-11' })).corrections.length, w.ok(w.call(D(1), '10:11', 'myRestrictions', 'neha')).length], [1, 1]);
});

// =====================================================================================================
// R8-9 (Low). Varun's daily summary lists as "Late" someone who was not due at all.
// =====================================================================================================
test('R8-9 Low: 1st Sunday, Harsh (roster off) comes in at noon to help -> the daily summary says "Late: Harsh 90 min"', () => {
  const w = world(D(6));
  w.plainDay(D(6));                                                     // Neha, Manish, Muskan, Bhawna: on time
  w.ok(w.call(D(6), '12:00', 'checkIn', 'harsh', PIC)); w.ok(w.call(D(6), '16:00', 'checkOut', 'harsh'));
  assert.equal(w.job(D(6), '21:15', 'endOfDay').summary[1], 'Late: none');
});

// =====================================================================================================
// R8-10 (Low). Handoff 3.12: staff get "a reminder the evening before their leave". Muskan never does.
// =====================================================================================================
test('R8-10 Low: Muskan (leave is recorded, not approved) gets no reminder the evening before her leave', () => {
  const w = world(D(1));
  assert.equal(w.ok(w.call(D(1), '12:00', 'submitLeave', 'muskan', lv([D(5)]))).status, 'Recorded');
  w.job(D(4), '19:30', 'evening');
  assert.equal(w.told('muskan', 'leave-tomorrow').length, 1);
});

// =====================================================================================================
// R8-11 (Low). Handoff 3.12: staff get "1 more = violation". After the 4th not-informed time (the 5th is a
// violation) no alert is sent; the only alert came one step earlier, after the 3rd.
// =====================================================================================================
test('R8-11 Low: after the 4th not-informed late no "the next one is a violation" alert is sent', () => {
  const w = world(D(1));
  [1, 2, 3].forEach(k => { w.ok(w.call(D(k), '11:20', 'checkIn', 'vikas', PIC)); w.ok(w.call(D(k), '20:00', 'checkOut', 'vikas')); w.job(D(k), '12:07', 'hourly'); });
  const before = w.told('vikas').length;                                // "All 3 not-informed passes are used"
  w.ok(w.call(D(4), '11:20', 'checkIn', 'vikas', PIC)); w.job(D(4), '12:07', 'hourly');   // the 4th: the next one is a violation
  assert.equal(w.told('vikas').length, before + 1);
});
