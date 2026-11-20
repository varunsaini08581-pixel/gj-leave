// Round 11: rules and counting over the whole life of a record (what happens when something is changed AFTERWARDS).
// Every test states what must hold and FAILS on the code as reviewed (commit 0d23639, server version 9, schema 4).
// Everything is driven through Api.handle on the Sheet store (fake Sheet + read cache), the way doPost does it, and through Jobs.run.
// Run: node --test /home/claude/findings/repro-round11.test.js
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
  if (r.status !== 'Approved') assert.equal(w.ok(w.call(askDate, '10:05', 'decideLeave', 'aakash', { id: r.id, approve: true })).status, 'Approved');
  return r.id;
}
/** Aakash confirms November, Varun locks it. */
function lockNovember(w, date) {
  w.ok(w.call(date, '10:00', 'lockMonth', 'aakash', { month: '2026-11' }));
  assert.equal(w.ok(w.call(date, '10:05', 'lockMonth', 'varun', { month: '2026-11' })).locked, true, 'setup: November is locked');
}
const absences = (w, p) => w.sheet('LeaveRequests').filter(r => r.personId === p && r.route === 'system' && r.status !== 'Cancelled').map(r => r.dates[0]);

// ====================================================================================================================
// R11-1 (High) A running leave ended by Aakash on its LAST day (duty begun, person not in yet) is cancelled as a whole:
// the days already taken become "Absent – unannounced", one violation each.
// ====================================================================================================================
test('R11-1 a leave ended on its last day keeps the days already taken as leave (no absences, no violations)', () => {
  const w = world('2026-11-18');
  const id = approvedLeave(w, 'neha', ['2026-11-18', '2026-11-19', '2026-11-20'], '2026-11-10');
  ['2026-11-18', '2026-11-19'].forEach(d => { w.present(d, ['neha']); w.job(d, '21:00', 'endOfDay'); });
  assert.deepEqual(absences(w, 'neha'), [], 'setup: two leave days gone by, no absence');
  // 20 Nov, noon: Neha rings, she is coming back this afternoon. Aakash ends the leave ("Staff leaves: cancel or shorten").
  w.ok(w.call('2026-11-20', '12:00', 'cancelLeave', 'aakash', { id, reason: 'She is coming back this afternoon' }));
  w.call('2026-11-20', '14:00', 'checkIn', 'neha', PIC); w.call('2026-11-20', '18:30', 'checkOut', 'neha');
  w.present('2026-11-20', ['neha']); w.job('2026-11-20', '21:00', 'endOfDay');
  // Assumptions 39 and 49: the days already taken stay as leave.
  assert.deepEqual(absences(w, 'neha'), [], '18 and 19 Nov were approved leave and must not turn into absences');
  assert.equal(w.live('neha', 'absent-no-request').length, 0, 'no "absent with no request" violation for approved leave days');
});

// ====================================================================================================================
// R11-2 (Medium) The same facts, two results: leave cancelled BEFORE the person walks in = "not informed" late + violation;
// cancelled AFTER = informed, no violation (assumption 57).
// ====================================================================================================================
test('R11-2 leave cancelled by Aakash on the day: coming in 90 min late gives the same result whichever tap came first', () => {
  const result = order => {
    const w = world('2026-11-20');
    const id = approvedLeave(w, 'neha', ['2026-11-20'], '2026-11-10');
    if (order === 'cancel first') { w.ok(w.call('2026-11-20', '10:30', 'cancelLeave', 'aakash', { id, reason: 'She is coming in' })); w.ok(w.call('2026-11-20', '11:00', 'checkIn', 'neha', PIC)); }
    else { w.ok(w.call('2026-11-20', '11:00', 'checkIn', 'neha', PIC)); w.ok(w.call('2026-11-20', '11:30', 'cancelLeave', 'aakash', { id, reason: 'She came in' })); }
    const late = w.sheet('DayMinutes').filter(m => m.personId === 'neha' && m.kind === 'late' && m.minutes > 0)[0];
    return { minutes: late && late.minutes, informed: late && late.informed, violations: w.live('neha').map(v => v.rule) };
  };
  assert.deepEqual(result('cancel first'), result('check-in first'));
});

// ====================================================================================================================
// R11-3 (Medium) Things still waiting when the month is locked can never be closed by anyone.
// ====================================================================================================================
test('R11-3a a late request nobody decided before the month lock can still be closed, and stops reminding', () => {
  const w = world('2026-11-27');
  const q = w.ok(w.call('2026-11-27', '18:00', 'requestShort', 'neha', { kind: 'late', date: '2026-11-28', time: '10:15' }));
  w.call('2026-11-28', '10:15', 'checkIn', 'neha', PIC); w.call('2026-11-28', '18:30', 'checkOut', 'neha');
  lockNovember(w, '2026-12-02');
  const tries = [w.call('2026-12-02', '11:00', 'decideShort', 'aakash', { id: q.id, approve: true }), w.call('2026-12-02', '11:01', 'decideShort', 'varun', { id: q.id, approve: false, reason: 'Month is closed' }),
    w.call('2026-12-02', '11:02', 'cancelShort', 'neha', { id: q.id })];
  const stillWaiting = w.sheet('ShortRequests').filter(x => x.id === q.id)[0].status === 'Pending';
  assert.equal(stillWaiting, false, 'still Pending after the lock; Aakash, Varun and Neha were all refused: ' + tries.map(t => t.message).join(' / '));
});
test('R11-3b no 2-hourly reminder for a late request of a locked month', () => {
  const w = world('2026-11-27');
  w.ok(w.call('2026-11-27', '18:00', 'requestShort', 'neha', { kind: 'late', date: '2026-11-28', time: '10:15' }));
  w.call('2026-11-28', '10:15', 'checkIn', 'neha', PIC); w.call('2026-11-28', '18:30', 'checkOut', 'neha');
  lockNovember(w, '2026-12-02');
  ['12:00', '14:00', '16:00'].forEach(t => w.job('2026-12-05', t, 'hourly'));
  const after = w.sheet('Notifications').filter(n => n.kind === 'reminder' && n.createdAt >= ist('2026-12-05', '00:00'));
  assert.equal(after.length, 0, 'Aakash is reminded every 2 hours about a request he is not allowed to decide: ' + after.length + ' reminders on 5 Dec');
});
test('R11-3c an "I\'m back" that Aakash did not confirm before the month lock leaves his Approvals list', () => {
  const w = world('2026-11-27');
  w.call('2026-11-27', '09:30', 'checkIn', 'neha', PIC);
  const o = w.ok(w.call('2026-11-27', '12:00', 'goingOut', 'neha', { reason: 'Bank', expectedMinutes: 20 }));
  w.ok(w.call('2026-11-27', '12:01', 'decideOuting', 'aakash', { id: o.id, approve: true }));
  w.ok(w.call('2026-11-27', '12:30', 'imBack', 'neha', { id: o.id }));
  w.call('2026-11-27', '18:30', 'checkOut', 'neha');
  lockNovember(w, '2026-12-02');
  const tap = w.call('2026-12-02', '11:00', 'confirmBack', 'aakash', { id: o.id });
  const list = w.ok(w.call('2026-12-02', '11:01', 'approvals', 'aakash')).outings;
  assert.equal(list.length, 0, 'the outing waits in Approvals for ever; Confirm answers: ' + tap.message);
});
test('R11-3d a dress flag and an open dispute of a locked month can still be closed', () => {
  const w = world('2026-11-27');
  w.call('2026-11-27', '09:30', 'checkIn', 'neha', Object.assign({}, PIC, { dress: { top: 'issue', trousers: 'ok', shoes: 'ok', belt: 'ok' } }));
  w.call('2026-11-27', '18:30', 'checkOut', 'neha');
  w.call('2026-11-28', '10:30', 'checkIn', 'neha', PIC);                                  // 60 min late, not informed: a violation
  const v = w.live('neha', 'not-informed-over-30')[0];
  w.ok(w.call('2026-11-28', '12:00', 'disputeViolation', 'neha', { id: v.id, text: 'The bus broke down' }));
  lockNovember(w, '2026-12-02');
  const a = w.ok(w.call('2026-12-02', '11:00', 'approvals', 'aakash'));
  const dress = a.dress.length ? w.call('2026-12-02', '11:01', 'decideDress', 'aakash', { id: a.dress[0].id, confirm: false }) : { ok: true };
  const waiting = w.ok(w.call('2026-12-02', '11:02', 'disputes', 'varun'));
  const dispute = waiting.length ? w.call('2026-12-02', '11:03', 'decideDispute', 'varun', { id: v.id, uphold: false, note: 'Checked: the bus did break down' }) : { ok: true };
  assert.deepEqual({ dress: dress.ok, dispute: dispute.ok }, { dress: true, dispute: true }, 'dress: ' + dress.message + ' / dispute: ' + dispute.message);
});

test('R11-3e a request across the month end that nobody decided is closed, at the latest, when the second month is locked', () => {
  const w = world('2026-11-30');
  const r = w.ok(w.call('2026-11-29', '10:00', 'submitLeave', 'neha', lv(['2026-11-30', '2026-12-01'])));
  lockNovember(w, '2026-12-02');
  w.ok(w.call('2027-01-02', '10:00', 'lockMonth', 'aakash', { month: '2026-12' }));
  assert.equal(w.ok(w.call('2027-01-02', '10:05', 'lockMonth', 'varun', { month: '2026-12' })).locked, true);
  const tries = [w.call('2027-01-02', '11:00', 'decideLeave', 'aakash', { id: r.id, approve: false, reason: 'Too late' }), w.call('2027-01-02', '11:01', 'cancelLeave', 'varun', { id: r.id, reason: 'Too late' })];
  const status = w.sheet('LeaveRequests').filter(x => x.id === r.id)[0].status;
  assert.equal(/^(Pending|Special)/.test(status), false, 'still "' + status + '" with both months locked; reject and cancel answer: ' + tries.map(t => t.message).join(' / '));
});

// ====================================================================================================================
// R11-4 (Medium) A request across the month end, decided after the first month was locked, writes into the locked month:
// a violation (or an absence + violation) that no month's count holds and that cannot be disputed.
// ====================================================================================================================
test('R11-4a approved after the lock: the "unannounced leave" violation is in some month\'s count', () => {
  const w = world('2026-11-30');
  const r = w.ok(w.call('2026-11-30', '08:30', 'submitLeave', 'neha', lv(['2026-11-30', '2026-12-01', '2026-12-02'])));  // 1 hour before duty: unannounced
  w.present('2026-11-30', ['neha']); w.job('2026-11-30', '21:00', 'endOfDay');
  lockNovember(w, '2026-12-01');
  assert.equal(w.ok(w.call('2026-12-01', '11:00', 'decideLeave', 'aakash', { id: r.id, approve: true })).status, 'Approved');
  const live = w.live('neha'), nov = w.month('2026-12-01', '12:00', 'neha', '2026-11'), dec = w.month('2026-12-01', '12:00', 'neha', '2026-12');
  assert.equal(nov.ladder.violations + dec.ladder.violations, live.length,
    live.length + ' live violation(s) on the Sheet (' + live.map(v => v.rule + ' ' + v.date).join(', ') + '), but November shows ' + nov.ladder.violations + ' and December ' + dec.ladder.violations);
});
test('R11-4b rejected after the lock: nothing new is written into the locked month', () => {
  const w = world('2026-11-30');
  const r = w.ok(w.call('2026-11-29', '10:00', 'submitLeave', 'neha', lv(['2026-11-30', '2026-12-01'])));
  w.present('2026-11-30', ['neha']); w.job('2026-11-30', '21:00', 'endOfDay');
  lockNovember(w, '2026-12-01');
  const inNov = () => JSON.stringify([w.sheet('LeaveRequests').filter(x => x.id !== r.id && x.dates.every(d => d.slice(0, 7) === '2026-11')).map(x => [x.dates, x.status]), w.sheet('Violations').filter(v => v.date.slice(0, 7) === '2026-11').map(v => [v.rule, v.date, v.disputeState])]);
  const before = inNov();
  assert.equal(w.ok(w.call('2026-12-01', '11:00', 'decideLeave', 'aakash', { id: r.id, approve: false, reason: 'Not possible' })).status, 'Rejected');
  assert.equal(inNov(), before, 'an absence and a violation dated 30 Nov were recorded after November was locked (the locked report still says 0 violations)');
});
test('R11-4c "I\'m back" for an outing of a locked month writes no minutes into that month', () => {
  const w = world('2026-11-30');
  w.call('2026-11-30', '09:30', 'checkIn', 'neha', PIC);
  const o = w.ok(w.call('2026-11-30', '12:00', 'goingOut', 'neha', { reason: 'Bank', expectedMinutes: 20 }));
  w.ok(w.call('2026-11-30', '12:01', 'decideOuting', 'aakash', { id: o.id, approve: true }));    // she never taps "I'm back"
  lockNovember(w, '2026-12-01');
  const tap = w.call('2026-12-01', '10:30', 'imBack', 'neha', { id: o.id });
  assert.deepEqual(w.sheet('DayMinutes').filter(m => m.date === '2026-11-30').map(m => m.kind + ' ' + m.minutes), [], 'reply ' + JSON.stringify(tap));
});

// ====================================================================================================================
// R11-5 (Medium) A violation Varun UPHELD after a dispute is lost for good when it is withdrawn and applies again.
// ====================================================================================================================
test('R11-5 a closed day entered by mistake and removed again: an upheld violation is back (assumption 54)', () => {
  const w = world('2026-11-10');
  const r = w.ok(w.call('2026-11-10', '09:00', 'submitLeave', 'raunak', lv(['2026-11-10'])));                // 90 min before duty: unannounced
  w.ok(w.call('2026-11-10', '09:05', 'decideLeave', 'aakash', { id: r.id, approve: true }));
  const v = w.live('raunak', 'unannounced-leave')[0];
  w.ok(w.call('2026-11-10', '12:00', 'disputeViolation', 'raunak', { id: v.id, text: 'I told Aakash on the phone' }));
  w.ok(w.call('2026-11-10', '13:00', 'decideDispute', 'varun', { id: v.id, uphold: true, note: 'The violation stands' }));
  assert.equal(w.month('2026-11-10', '14:00', 'raunak').ladder.violations, 1, 'setup: upheld, 1 violation');
  w.ok(w.call('2026-11-11', '10:00', 'setSetting', 'varun', { key: 'closedDays', value: ['2026-11-10'] }));  // wrong date typed
  w.ok(w.call('2026-11-11', '10:01', 'setSetting', 'varun', { key: 'closedDays', value: [] }));              // taken out again
  assert.equal(w.month('2026-11-11', '10:02', 'raunak').ladder.violations, 1, 'the day is as before: the upheld violation must be there');
});

// ====================================================================================================================
// R11-6 (Medium) The "3rd emergency" violation Varun removed after a dispute comes back on another request.
// ====================================================================================================================
test('R11-6 a 3rd-emergency violation removed by Varun does not return when another emergency of the month is corrected', () => {
  const w = world('2026-11-03');
  const ids = threeEmergencies(w);
  const v = w.live('raunak', 'emergency-beyond-2')[0];
  w.ok(w.call('2026-11-16', '19:00', 'disputeViolation', 'raunak', { id: v.id, text: 'My father was in hospital' }));
  w.ok(w.call('2026-11-16', '20:00', 'decideDispute', 'varun', { id: v.id, uphold: false, note: 'Real emergency. Removed.' }));
  assert.equal(w.month('2026-11-16', '21:00', 'raunak').ladder.violations, 0, 'setup: removed by Varun');
  // Aakash corrects the reason text of the FIRST emergency (4 Nov); Varun approves the edit. Still the same 3 emergencies.
  w.ok(w.call('2026-11-18', '11:00', 'editLeave', 'aakash', Object.assign({ id: ids[0] }, lv(['2026-11-04'], { reasonText: 'Bank work (corrected)' }))));
  assert.equal(w.ok(w.call('2026-11-18', '11:05', 'decideLeave', 'varun', { id: ids[0], approve: true })).status, 'Approved');
  assert.equal(w.live('raunak', 'emergency-beyond-2').length, 0, 'assumptions 51 and 53: a violation removed after a dispute never returns');
});

// ====================================================================================================================
// R11-7 (Medium) "Leave in a restricted period" stays after the leave was shortened to days outside the period.
// ====================================================================================================================
test('R11-7 a leave shortened so that no day is left in the restricted period loses that violation', () => {
  const w = world('2026-11-18');
  w.ok(w.call('2026-11-02', '10:00', 'saveRestriction', 'varun', { from: '2026-11-20', to: '2026-11-22', note: 'Peak', rule: 'violation' }));
  const id = approvedLeave(w, 'neha', ['2026-11-18', '2026-11-19', '2026-11-20'], '2026-11-10');
  assert.equal(w.live('neha', 'leave-in-restricted-period').length, 1, 'setup: 20 Nov is in the restricted period');
  w.present('2026-11-18', ['neha']);
  const cut = w.ok(w.call('2026-11-19', '08:00', 'cancelLeave', 'aakash', { id, reason: 'Back early' }));
  assert.deepEqual(cut.dates, ['2026-11-18'], 'setup: only 18 Nov is left');
  assert.equal(w.live('neha', 'leave-in-restricted-period').length, 0, 'she took no leave in the restricted period');
});

// ====================================================================================================================
// R11-8 (Medium) A leave entered for a day and taken out again turns a "not informed" lateness into an informed one.
// ====================================================================================================================
test('R11-8 leave granted and then cancelled for a day with a not-informed late arrival: the violation is back', () => {
  const w = world('2026-11-20');
  w.ok(w.call('2026-11-20', '10:30', 'checkIn', 'neha', PIC));                                               // 60 min late, nobody told
  assert.equal(w.live('neha', 'not-informed-over-30').length, 1, 'setup');
  const r = w.ok(w.call('2026-11-20', '11:00', 'submitLeave', 'aakash', Object.assign(lv(['2026-11-20']), { forPersonId: 'neha' })));  // entered for the wrong person
  if (r.status !== 'Approved') w.ok(w.call('2026-11-20', '11:01', 'decideLeave', 'aakash', { id: r.id, approve: true }));
  w.ok(w.call('2026-11-20', '11:10', 'cancelLeave', 'aakash', { id: r.id, reason: 'Entered by mistake' }));
  const late = w.sheet('DayMinutes').filter(m => m.personId === 'neha' && m.kind === 'late' && m.minutes > 0);
  assert.deepEqual({ informed: late.map(m => m.informed), violations: w.live('neha').map(v => v.rule) }, { informed: [false], violations: ['not-informed-over-30'] });
});

// ====================================================================================================================
// R11-9 (Medium) Ticking "no approval needed" for a person re-judges all their past leaves, also in a locked month.
// ====================================================================================================================
test('R11-9a a person switched to "no approval needed" in December: the violation of locked November is not touched', () => {
  const w = world('2026-11-25');
  w.present('2026-11-25', ['raunak']); w.job('2026-11-25', '21:00', 'endOfDay');                             // absent with no request: 1 violation
  // 29 Nov added after round 13: the month lock now runs the absent check of the last days itself (R13-7), and 29 Nov (5th Sunday) is a working day.
  ['2026-11-26', '2026-11-27', '2026-11-28', '2026-11-29', '2026-11-30'].forEach(d => w.present(d));
  lockNovember(w, '2026-12-01');
  const person = w.ok(w.call('2026-12-02', '10:00', 'getSettings', 'varun')).people.filter(p => p.id === 'raunak')[0];
  w.ok(w.call('2026-12-02', '10:01', 'savePerson', 'varun', Object.assign({}, person, { noApproval: true })));
  w.ok(w.call('2026-12-02', '10:05', 'submitLeave', 'raunak', lv(['2026-12-21'])));
  const row = w.sheet('Violations').filter(v => v.personId === 'raunak' && v.date === '2026-11-25')[0];
  const shown = w.month('2026-12-02', '11:00', 'raunak', '2026-12').last3.filter(x => x.month === '2026-11')[0].violations;
  assert.deepEqual({ state: row.disputeState, novemberOnDecemberPage: shown, lockedNovember: w.month('2026-12-02', '11:00', 'raunak', '2026-11').ladder.violations },
    { state: '', novemberOnDecemberPage: 1, lockedNovember: 1 });
});

test('R11-9b a request closed by the month lock: its violation, counted in the locked report, is not withdrawn afterwards', () => {
  const w = world('2026-11-26');
  const r = w.ok(w.call('2026-11-26', '09:00', 'submitLeave', 'raunak', lv(['2026-11-26'])));                // 90 min before duty: unannounced
  w.ok(w.call('2026-11-26', '09:05', 'decideLeave', 'aakash', { id: r.id, approve: true }));
  ['2026-11-26', '2026-11-27', '2026-11-28', '2026-11-29', '2026-11-30'].forEach(d => w.present(d, d === '2026-11-26' ? ['raunak'] : []));
  // 1 Dec: Aakash corrects a typo in the reason (the request waits again) and forgets it; then the month is locked.
  w.ok(w.call('2026-12-01', '09:30', 'editLeave', 'aakash', Object.assign({ id: r.id }, lv(['2026-11-26'], { reasonText: 'Bank work (typo fixed)' }))));
  lockNovember(w, '2026-12-01');
  const locked = w.month('2026-12-01', '11:00', 'raunak', '2026-11').ladder.violations;
  assert.equal(locked, 1, 'setup: the locked November report counts the violation');
  w.ok(w.call('2026-12-05', '10:00', 'submitLeave', 'raunak', lv(['2026-12-21'])));                          // any later leave of his
  const row = w.sheet('Violations').filter(v => v.personId === 'raunak' && v.date === '2026-11-26')[0];
  const told = w.sheet('Notifications').filter(n => n.kind === 'withdrawn').length;
  const shown = w.month('2026-12-05', '11:00', 'raunak', '2026-12').last3.filter(x => x.month === '2026-11')[0].violations;
  assert.deepEqual({ state: row.disputeState, withdrawnAlerts: told, novemberOnDecemberPage: shown }, { state: '', withdrawnAlerts: 0, novemberOnDecemberPage: locked });
});

// ====================================================================================================================
// R11-10 (Medium) Minutes that a leave covered, or that came before the leave, are not counted again (only late / early are).
// ====================================================================================================================
test('R11-10a going out, then a full-day leave granted for the same day: no minutes from the bank (assumption 55)', () => {
  const w = world('2026-11-20');
  w.call('2026-11-20', '09:30', 'checkIn', 'neha', PIC);
  const o = w.ok(w.call('2026-11-20', '11:00', 'goingOut', 'neha', { reason: 'Bank', expectedMinutes: 25 }));
  w.ok(w.call('2026-11-20', '11:00', 'decideOuting', 'aakash', { id: o.id, approve: true }));
  w.ok(w.call('2026-11-20', '11:25', 'imBack', 'neha', { id: o.id }));
  const r = w.ok(w.call('2026-11-20', '12:00', 'submitLeave', 'neha', lv(['2026-11-20'])));                  // has to go home: asks leave for today
  w.ok(w.call('2026-11-20', '12:05', 'decideLeave', 'aakash', { id: r.id, approve: true }));
  const m = w.month('2026-11-20', '22:00', 'neha');
  assert.equal(m.bank.used, 0, 'the day is 1 leave; it must not cost ' + m.bank.used + ' min of the 2-hour bank as well');
});
test('R11-10b going out on a leave day, leave cancelled afterwards because she worked: the outing is counted', () => {
  const w = world('2026-11-20');
  const id = approvedLeave(w, 'neha', ['2026-11-20'], '2026-11-10');
  w.call('2026-11-20', '09:30', 'checkIn', 'neha', PIC);
  const o = w.ok(w.call('2026-11-20', '12:00', 'goingOut', 'neha', { reason: 'Bank', expectedMinutes: 60 }));
  w.ok(w.call('2026-11-20', '12:00', 'decideOuting', 'aakash', { id: o.id, approve: true }));
  w.ok(w.call('2026-11-20', '13:30', 'imBack', 'neha', { id: o.id }));
  w.ok(w.call('2026-11-20', '14:00', 'cancelLeave', 'aakash', { id, reason: 'She worked today' }));
  w.call('2026-11-20', '18:30', 'checkOut', 'neha');
  assert.equal(w.month('2026-11-20', '22:00', 'neha').bank.used, 90, 'a normal working day now: 90 min out = 90 min from the bank');
});
test('R11-10c absence excused, then Aakash enters the check-in (she had come at 12:30): the 3 hours are counted', () => {
  const w = world('2026-11-20');
  w.present('2026-11-20', ['neha']); w.job('2026-11-20', '21:00', 'endOfDay');
  const a = w.sheet('LeaveRequests').filter(r => r.personId === 'neha')[0];
  w.ok(w.call('2026-11-21', '10:00', 'excuseAbsence', 'aakash', { id: a.id, reason: 'Medical paper' }));
  assert.equal(w.ok(w.call('2026-11-21', '10:05', 'manualCheckIn', 'aakash', { personId: 'neha', date: '2026-11-20', time: '12:30', reason: 'She was here, phone dead' })).lateMinutes, 180);
  const m = w.month('2026-11-21', '22:00', 'neha');
  assert.deepEqual(m.leaves.autoHalfDays.map(d => d.date + ' ' + d.amount), ['2026-11-20 0.5'], '180 min late = an automatic half day; the day shows no leave and no minutes at all');
});

// ====================================================================================================================
// R11-11 (Low) "Violation withdrawn" is announced; when the same violation applies again nobody is told.
// ====================================================================================================================
test('R11-11 a violation that comes back after "Violation withdrawn" is announced to the person', () => {
  const w = world('2026-11-10');
  w.ok(w.call('2026-11-10', '11:30', 'checkIn', 'raunak', PIC));                                             // 60 min late, not informed
  w.ok(w.call('2026-11-11', '10:00', 'setSetting', 'varun', { key: 'closedDays', value: ['2026-11-10'] }));
  w.ok(w.call('2026-11-11', '10:01', 'setSetting', 'varun', { key: 'closedDays', value: [] }));
  assert.equal(w.live('raunak').length, 1, 'setup: the violation applies again');
  const told = w.sheet('Notifications').filter(n => n.to === 'raunak' && (n.kind === 'violation' || n.kind === 'withdrawn')).map(n => n.title);
  assert.notEqual(told[told.length - 1], 'Violation withdrawn', 'the last thing Raunak was told: ' + told.join(' > '));
});

// ====================================================================================================================
// R11-12 (Low) No evening-before reminder after the dates of a leave were changed.
// ====================================================================================================================
test('R11-12 a leave moved to another date still gets its evening-before reminder', () => {
  const w = world('2026-11-02');
  const r = w.ok(w.call('2026-11-02', '10:00', 'submitLeave', 'neha', lv(['2026-11-06'])));
  w.job('2026-11-05', '19:00', 'evening');                                                                    // reminded for 6 Nov
  w.ok(w.call('2026-11-05', '20:00', 'editLeave', 'neha', Object.assign({ id: r.id }, lv(['2026-11-12']))));
  assert.equal(w.ok(w.call('2026-11-05', '20:05', 'decideLeave', 'aakash', { id: r.id, approve: true })).status, 'Approved');
  w.job('2026-11-11', '19:00', 'evening');
  const on11 = w.sheet('Notifications').filter(n => n.kind === 'leave-tomorrow' && n.createdAt >= ist('2026-11-11', '00:00'));
  assert.equal(on11.length, 1, 'no reminder on the evening of 11 Nov for the leave on 12 Nov');
});

// ====================================================================================================================
// R11-13 (Low) The late / early request of a person who has left keeps reminding Aakash (leave requests stop).
// ====================================================================================================================
test('R11-13 no reminder about the late request of a person who has left', () => {
  const w = world('2026-11-02');
  w.ok(w.call('2026-11-02', '18:00', 'requestShort', 'neha', { kind: 'late', date: '2026-11-04', time: '10:15' }));
  const person = w.ok(w.call('2026-11-03', '10:00', 'getSettings', 'varun')).people.filter(p => p.id === 'neha')[0];
  w.ok(w.call('2026-11-03', '10:01', 'savePerson', 'varun', Object.assign({}, person, { active: false })));
  w.job('2026-11-03', '14:00', 'hourly'); w.job('2026-11-08', '14:00', 'hourly');
  const after = w.sheet('Notifications').filter(n => n.kind === 'reminder' && n.createdAt >= ist('2026-11-03', '10:01'));
  assert.equal(after.length, 0, after.map(n => n.to + ': ' + n.body).join(' | '));
});

// ====================================================================================================================
// R11-14 (Low) A half day approved late for a day that has meanwhile been entered as "shop closed" records an absence + violation on the closed day.
// ====================================================================================================================
test('R11-14 no absence and no violation on a shop-closed day when a waiting half day is approved afterwards', () => {
  const w = world('2026-11-20');
  const r = w.ok(w.call('2026-11-19', '18:00', 'submitLeave', 'neha', lv(['2026-11-20'], { kind: 'half', halfStart: '09:30' })));
  w.ok(w.call('2026-11-21', '09:00', 'setSetting', 'varun', { key: 'closedDays', value: ['2026-11-20'] }));  // the shop did not open on 20 Nov
  assert.equal(w.ok(w.call('2026-11-21', '10:00', 'decideLeave', 'aakash', { id: r.id, approve: true })).status, 'Approved');
  assert.deepEqual({ absences: absences(w, 'neha'), violations: w.month('2026-11-21', '11:00', 'neha').ladder.violations }, { absences: [], violations: 0 });
});
