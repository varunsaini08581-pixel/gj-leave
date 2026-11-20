// Round 9: independent re-review of the round 4-8 fixes. Every test states what must hold and FAILS on the code as reviewed.
// Everything is driven through Api.handle on the Sheet store (fake Sheet + read cache), the way doPost does it, and through Jobs.run.
// Run: node --test /home/claude/findings/repro-round9.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const SRC = __dirname + '/../src/';
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

// ====================================================================================================================
// R9-1 (High). The 3rd emergency of the month is edited (same day, only the reason) and Aakash approves it again:
// the "emergency beyond 2" violation is gone for good, while the day is still cut as a penalty emergency.
// decideLeave.finish() withdraws every violation of the request ("Request decided again after an edit"), and
// renumberEmergencies() then finds a withdrawn row with a note it does not know and records nothing.
// ====================================================================================================================
test('R9-1 the 3rd emergency keeps its violation when it is edited and approved again', () => {
  const w = world();
  const ids = threeEmergencies(w);
  assert.equal(w.live('raunak', 'emergency-beyond-2').length, 1, 'setup: the 3rd emergency has its violation');
  // 16 Nov 18:20, before the leave starts: Raunak corrects the reason. Same day, same kind.
  assert.equal(w.ok(w.call('2026-11-16', '18:20', 'editLeave', 'raunak', Object.assign({ id: ids[2] }, lv(['2026-11-17'], { reasonText: 'Bank work (corrected)' })))).status, 'Pending with Aakash');
  assert.equal(w.ok(w.call('2026-11-16', '18:30', 'decideLeave', 'aakash', { id: ids[2], approve: true })).status, 'Approved');
  const row = w.sheet('LeaveRequests').find(r => r.id === ids[2]);
  assert.equal(row.emergencyNo, 3); assert.equal(row.penaltyEmergency, true);           // still the 3rd, still a day cut
  const m = w.month('2026-11-16', '18:40', 'raunak');
  assert.equal(m.leaves.daysCut, 1);
  assert.equal(m.ladder.violations, 1, 'the 3rd emergency is approved again but its violation is gone: ' + JSON.stringify(w.sheet('Violations').map(v => [v.rule, v.disputeState, v.note])));
});

// ====================================================================================================================
// R9-2 (Medium). Round 8 (R8-5) closed undecided requests with the month lock, but only those that lie completely
// inside the month. A request across the month end that nobody decided stays "Pending with Aakash" for ever:
// it can be neither approved, rejected nor cancelled (every path answers "This month is locked"), Aakash is
// reminded every 2 hours without end, and the December day stays "not decided" on the person's page.
// ====================================================================================================================
test('R9-2 an undecided request across a month end can still be closed after the month is locked', () => {
  const w = world('2026-12-10');
  const a = w.ok(w.call('2026-11-29', '10:00', 'submitLeave', 'raunak', lv(['2026-11-30', '2026-12-01'])));
  assert.equal(a.status, 'Pending with Aakash');
  w.ok(w.call('2026-12-03', '10:00', 'lockMonth', 'aakash', { month: '2026-11' }));
  assert.equal(w.ok(w.call('2026-12-03', '10:05', 'lockMonth', 'varun', { month: '2026-11' })).locked, true);
  const tries = [
    w.call('2026-12-03', '11:00', 'decideLeave', 'aakash', { id: a.id, approve: true }),
    w.call('2026-12-03', '11:01', 'decideLeave', 'aakash', { id: a.id, approve: false, reason: 'too late' }),
    w.call('2026-12-03', '11:02', 'cancelLeave', 'varun', { id: a.id, reason: 'never decided' }),
    w.call('2026-12-03', '11:03', 'editLeave', 'varun', Object.assign({ id: a.id }, lv(['2026-12-01']))),
  ];
  const status = w.sheet('LeaveRequests').find(r => r.id === a.id).status;
  const stillAsked = w.job('2026-12-20', '11:00', 'hourly').reminders;
  assert.ok(!/^Pending/.test(status) || tries.some(t => t.ok),
    'the request is still "' + status + '" and nobody can close it: ' + tries.map(t => t.code).join(', ') + '; reminders on 20 Dec: ' + stillAsked);
});

test('R9-2b a leave inside a locked month cannot be sent back to "pending" by an edit (Aakash\'s own leave, Apply > Edit > Save)', () => {
  const w = world('2026-12-10');
  const a = w.ok(w.call('2026-11-20', '10:00', 'submitLeave', 'aakash', lv(['2026-11-25'])));
  w.ok(w.call('2026-11-20', '11:00', 'decideLeave', 'varun', { id: a.id, approve: true }));
  w.ok(w.call('2026-12-03', '10:00', 'lockMonth', 'aakash', { month: '2026-11' }));
  assert.equal(w.ok(w.call('2026-12-03', '10:05', 'lockMonth', 'varun', { month: '2026-11' })).locked, true);
  // The Apply screen still offers "Edit" on the approved November leave. Same date, new reason text.
  const edit = w.call('2026-12-04', '10:00', 'editLeave', 'aakash', Object.assign({ id: a.id }, lv(['2026-11-25'], { reasonText: 'Bank work (note added)' })));
  const row = w.sheet('LeaveRequests').find(r => r.id === a.id);
  const decide = w.call('2026-12-04', '11:00', 'decideLeave', 'varun', { id: a.id, approve: true });
  assert.equal(row.status, 'Approved', 'an approved leave of the locked month is now "' + row.status + '" (edit answered ' + (edit.ok ? 'ok' : edit.code) +
    '), and Varun cannot decide it: ' + (decide.ok ? 'ok' : decide.code + ' ' + decide.message));
});

// ====================================================================================================================
// R9-3 (Medium). A clash rule is switched on while a clashing leave is RUNNING (assumption 43: "from today on").
// The whole leave becomes "Rejected – clash", also the day that is already over; the next evening job then records
// that past day as "Absent – unannounced" with a violation. On that day the leave was approved.
// ====================================================================================================================
test('R9-3 a clash rule switched on later does not turn a leave day that is already over into an absence with a violation', () => {
  const w = world('2026-11-19');
  const calls = w.ok(w.call('2026-11-01', '10:00', 'getSettings', 'varun')).rules.find(r => r.id === 'C2');
  w.ok(w.call('2026-11-01', '10:01', 'saveRule', 'varun', Object.assign({}, calls, { on: false })));
  assert.equal(w.ok(w.call('2026-11-10', '10:00', 'submitLeave', 'bhawna', lv(['2026-11-19', '2026-11-20']))).status, 'Approved');
  assert.equal(w.ok(w.call('2026-11-10', '10:10', 'submitLeave', 'pooja', lv(['2026-11-19', '2026-11-20']))).status, 'Approved');
  w.present('2026-11-19', ['bhawna', 'pooja']); w.job('2026-11-19', '21:10', 'endOfDay');
  assert.equal(w.live('pooja').length, 0);
  // 20 Nov, noon: Varun switches the Calls rule on again. Pooja's leave was approved last, so it gives way.
  assert.equal(w.ok(w.call('2026-11-20', '12:00', 'saveRule', 'varun', Object.assign({}, calls, { on: true }))).rejected.length, 1);
  w.present('2026-11-20', ['bhawna', 'pooja']); w.job('2026-11-20', '21:10', 'endOfDay');
  const on19 = w.sheet('Violations').filter(v => v.personId === 'pooja' && v.date === '2026-11-19' && v.disputeState !== 'removed');
  assert.equal(on19.length, 0, 'Pooja was on approved leave on 19 Nov; after the rule change she has: ' + on19.map(v => v.rule).join(', ') +
    ' (leave rows: ' + w.sheet('LeaveRequests').filter(r => r.personId === 'pooja').map(r => r.dates.join('+') + ' ' + r.status).join(' | ') + ')');
});

// ====================================================================================================================
// R9-4 (Medium). A shop-closed day entered on the wrong date cannot be put right. Entering it sets that day's
// minutes to 0, withdraws their violations and cancels the absences; taking the date out of the list again brings
// nothing back, and no screen can restore it.
// ====================================================================================================================
test('R9-4 a closed day entered by mistake and removed again leaves the day as it was', () => {
  const w = world('2026-11-10');
  w.present('2026-11-10', ['raunak', 'harsh']);
  w.ok(w.call('2026-11-10', '11:10', 'checkIn', 'raunak', PIC)); w.ok(w.call('2026-11-10', '19:30', 'checkOut', 'raunak')); // 40 min late, not informed: 1 violation
  w.job('2026-11-10', '21:10', 'endOfDay');                                                                                // Harsh: absent, 1 violation
  w.present('2026-11-11', []); w.job('2026-11-11', '21:10', 'endOfDay');
  const before = { raunak: w.month('2026-11-12', '09:00', 'raunak'), harsh: w.month('2026-11-12', '09:00', 'harsh') };
  assert.deepEqual([before.raunak.bank.used, before.raunak.ladder.violations, before.harsh.leaves.taken, before.harsh.ladder.violations], [30, 1, 1, 1]); // 40 late - 10 grace = 30 from the bank
  // Varun means to enter 12 Nov, picks 10 Nov, sees it and takes it out again.
  w.ok(w.call('2026-11-12', '10:00', 'setSetting', 'varun', { key: 'closedDays', value: ['2026-11-10'] }));
  w.ok(w.call('2026-11-12', '10:02', 'setSetting', 'varun', { key: 'closedDays', value: [] }));
  w.present('2026-11-12', []); w.job('2026-11-12', '21:10', 'endOfDay');
  const after = { raunak: w.month('2026-11-12', '22:00', 'raunak'), harsh: w.month('2026-11-12', '22:00', 'harsh') };
  assert.deepEqual([after.raunak.bank.used, after.raunak.ladder.violations, after.harsh.leaves.taken, after.harsh.ladder.violations], [30, 1, 1, 1],
    '10 Nov after the mistake was undone: Raunak bank ' + after.raunak.bank.used + ' min, ' + after.raunak.ladder.violations + ' violation(s), late minutes ' + JSON.stringify(w.sheet('DayMinutes').map(m => m.minutes + ' ' + m.note)) +
    '; Harsh ' + after.harsh.leaves.taken + ' leave day(s), ' + after.harsh.ladder.violations + ' violation(s)');
});

// ====================================================================================================================
// R9-5 (Medium). A person on approved leave comes to work after all, 3 hours late, and Aakash cancels the leave
// ("Staff leaves" screen). The day is given back (assumption 49), but the lateness is never counted: recountDay
// can only lower minutes, and at check-in none were written because the day was a leave day.
// 180 min away = a half day (assumption 9). The app shows a full normal day.
// ====================================================================================================================
test('R9-5 a leave cancelled after the person came in late counts the lateness of that day', () => {
  const w = world('2026-11-11');
  const a = w.ok(w.call('2026-11-05', '10:00', 'submitLeave', 'raunak', lv(['2026-11-11'])));
  assert.equal(a.status, 'Approved');
  w.ok(w.call('2026-11-11', '13:30', 'checkIn', 'raunak', PIC));                        // duty 10:30: 180 min late
  assert.equal(w.ok(w.call('2026-11-11', '13:40', 'cancelLeave', 'aakash', { id: a.id, reason: 'Came to work' })).status, 'Cancelled');
  w.ok(w.call('2026-11-11', '19:30', 'checkOut', 'raunak'));
  const m = w.month('2026-11-11', '20:00', 'raunak');
  assert.equal(m.leaves.taken, 0.5, 'Raunak arrived 3 hours late with no leave for the day; counted: ' + m.leaves.taken + ' leave, ' + m.bank.used + ' bank minutes, day list ' + JSON.stringify(m.bank.days));
});

// ====================================================================================================================
// R9-6 (Medium). Round 8 (R8-4, assumption 51): "a violation Varun removed after a dispute is never recorded again".
// True for the minute rules and for renumbering, not for a leave that is edited and approved again: onGranted
// records "unannounced leave" (and "leave in a restricted period") afresh.
// ====================================================================================================================
test('R9-6 a violation Varun removed after a dispute does not come back when the leave is edited and approved again', () => {
  const w = world('2026-11-11');
  const r = w.ok(w.call('2026-11-10', '09:00', 'submitLeave', 'raunak', lv(['2026-11-10', '2026-11-11'])));  // 1.5 h before duty: Unannounced
  w.ok(w.call('2026-11-10', '09:05', 'decideLeave', 'aakash', { id: r.id, approve: true }));
  const v = w.live('raunak', 'unannounced-leave')[0];
  w.ok(w.call('2026-11-10', '09:30', 'disputeViolation', 'raunak', { id: v.id, text: 'I called Aakash at 6 in the morning' }));
  w.ok(w.call('2026-11-10', '12:00', 'decideDispute', 'varun', { id: v.id, uphold: false, note: 'Correct, he called' }));
  assert.equal(w.month('2026-11-10', '12:05', 'raunak').ladder.violations, 0);
  // Raunak's own edit the same morning, before duty start (10:30)? Not possible any more; the correction comes from Aakash (API; the entry for the same first day).
  assert.equal(w.ok(w.call('2026-11-10', '15:00', 'editLeave', 'aakash', Object.assign({ id: r.id }, lv(['2026-11-10'])))).status, 'Pending with Aakash');
  w.ok(w.call('2026-11-10', '15:05', 'decideLeave', 'varun', { id: r.id, approve: true }));
  assert.equal(w.month('2026-11-10', '15:10', 'raunak').ladder.violations, 0,
    'the violation Varun removed is recorded again: ' + JSON.stringify(w.sheet('Violations').map(x => [x.rule, x.disputeState, x.note])));
});
test('R9-6b the same through the person\'s own phone: restricted-period violation removed by Varun, then the reason is edited', () => {
  const w = world('2026-11-11');
  w.ok(w.call('2026-11-02', '10:00', 'saveRestriction', 'varun', { from: '2026-11-20', to: '2026-11-22', note: 'Peak', rule: 'violation' }));
  const r = w.ok(w.call('2026-11-10', '09:00', 'submitLeave', 'raunak', lv(['2026-11-20'])));
  w.ok(w.call('2026-11-10', '09:05', 'decideLeave', 'aakash', { id: r.id, approve: true }));
  const v = w.live('raunak', 'leave-in-restricted-period')[0];
  w.ok(w.call('2026-11-10', '09:30', 'disputeViolation', 'raunak', { id: v.id, text: 'Varun allowed this before the restriction' }));
  w.ok(w.call('2026-11-10', '12:00', 'decideDispute', 'varun', { id: v.id, uphold: false, note: 'Yes, agreed earlier' }));
  w.ok(w.call('2026-11-11', '09:00', 'editLeave', 'raunak', Object.assign({ id: r.id }, lv(['2026-11-20'], { reasonText: 'Sister\'s wedding (Varun agreed)' }))));
  w.ok(w.call('2026-11-11', '09:05', 'decideLeave', 'aakash', { id: r.id, approve: true }));
  assert.equal(w.live('raunak').length, 0, 'recorded again: ' + JSON.stringify(w.sheet('Violations').map(x => [x.rule, x.disputeState, x.note])));
});

// ====================================================================================================================
// R9-7 (Medium). Late and early minutes are skipped on a leave day and on a roster Sunday; going-out minutes are not.
// (a) On approved full-day leave, came in to help, went out for 2 h 10 min: the day counts 1.5 leaves.
// (b) On the person's own roster Sunday off, came in to help, went out 40 min: 40 min are taken from the 2-hour bank.
// ====================================================================================================================
test('R9-7a one day is never more than 1 leave: full-day leave + an outing over 2 hours', () => {
  const w = world('2026-11-11');
  assert.equal(w.ok(w.call('2026-11-05', '10:00', 'submitLeave', 'raunak', lv(['2026-11-11']))).status, 'Approved');
  w.ok(w.call('2026-11-11', '10:30', 'checkIn', 'raunak', PIC));                         // came in anyway; the leave stays
  const o = w.ok(w.call('2026-11-11', '13:00', 'goingOut', 'raunak', { reason: 'Bank', expectedMinutes: 60 }));
  w.ok(w.call('2026-11-11', '13:00', 'decideOuting', 'aakash', { id: o.id, approve: true }));
  w.ok(w.call('2026-11-11', '15:10', 'imBack', 'raunak', { id: o.id }));
  w.ok(w.call('2026-11-11', '19:30', 'checkOut', 'raunak'));
  const m = w.month('2026-11-11', '20:00', 'raunak');
  assert.equal(m.leaves.taken, 1, '11 Nov counts as ' + m.leaves.taken + ' leaves (1 leave day + automatic half day ' + JSON.stringify(m.leaves.autoHalfDays) + ')');
});
test('R9-7b an outing on the person\'s own roster Sunday off does not use the 2-hour bank', () => {
  const w = world('2026-11-08');
  w.ok(w.call('2026-11-08', '10:30', 'checkIn', 'raunak', PIC));                         // 8 Nov = 2nd Sunday, Raunak's roster off; he came in to help
  const o = w.ok(w.call('2026-11-08', '13:00', 'goingOut', 'raunak', { reason: 'Lunch at home', expectedMinutes: 40 }));
  w.ok(w.call('2026-11-08', '13:00', 'decideOuting', 'aakash', { id: o.id, approve: true }));
  w.ok(w.call('2026-11-08', '13:40', 'imBack', 'raunak', { id: o.id }));
  assert.equal(w.month('2026-11-08', '20:00', 'raunak').bank.used, 0, 'bank minutes taken on a roster Sunday off (late and early are not counted on that day)');
});

// ====================================================================================================================
// R9-8 (Low). Lateness is not capped at the end of the part of the day the person had to work. Afternoon half-day
// leave (15:00-19:30), check-in at 15:20 (after the working half 10:30-15:00 was over): 290 "late" minutes > 4 h 30 min
// = a FULL automatic day, plus the 0.5 leave = 1.5 leaves for one day. (The whole working half missed is 270 min = 0.5.)
// ====================================================================================================================
test('R9-8 one day is never more than 1 leave: half-day leave + check-in after the working half is over', () => {
  const w = world('2026-11-11');
  assert.equal(w.ok(w.call('2026-11-05', '10:00', 'submitLeave', 'raunak', lv(['2026-11-11'], { kind: 'half', halfStart: '15:00' }))).status, 'Approved');
  w.ok(w.call('2026-11-11', '15:20', 'checkIn', 'raunak', PIC));
  const m = w.month('2026-11-11', '20:00', 'raunak');
  assert.equal(m.leaves.taken, 1, '11 Nov counts as ' + m.leaves.taken + ' leaves: ' + JSON.stringify(m.leaves.autoHalfDays));
});

// ====================================================================================================================
// R9-9 (Low). A half-day leave, the person does not come for the other half: half absence + 1 violation (assumption 18).
// Aakash then cancels the (past) half-day leave. The next evening job reads the remaining half absence as "an approved
// half day" and records a SECOND half absence with a second violation for the same day.
// ====================================================================================================================
test('R9-9 one day of absence is one violation, also after the half-day leave of that day is cancelled', () => {
  const w = world('2026-11-11');
  const a = w.ok(w.call('2026-11-05', '10:00', 'submitLeave', 'raunak', lv(['2026-11-11'], { kind: 'half', halfStart: '10:30' })));
  w.present('2026-11-11', ['raunak']); w.job('2026-11-11', '21:10', 'endOfDay');
  assert.equal(w.live('raunak', 'absent-no-request').length, 1);
  w.ok(w.call('2026-11-12', '10:00', 'cancelLeave', 'aakash', { id: a.id, reason: 'Entered by mistake' }));
  w.present('2026-11-12', []); w.job('2026-11-12', '21:10', 'endOfDay');
  assert.equal(w.live('raunak', 'absent-no-request').length, 1, w.live('raunak').length + ' violations for 11 Nov; rows: ' +
    w.sheet('LeaveRequests').filter(r => r.personId === 'raunak').map(r => r.kind + ' ' + r.status + ' "' + r.decisionReason + '"').join(' | '));
});

// ====================================================================================================================
// R9-10 (Medium). After "Keep as absent" the absence is in no list a boss's phone can load (Approvals shows only
// absences nobody looked at; "Staff leaves" leaves system rows out). The handoff (3.4) lets Aakash excuse a genuine
// case; when the medical paper comes a day after "Keep as absent", "Humanitarian – excused" can no longer be reached.
// (The server action itself still works; the id is simply not given to any screen.)
// ====================================================================================================================
test('R9-10 an absence that was "kept" can still be found by Aakash or Varun to excuse it later', () => {
  const w = world('2026-11-11');
  w.present('2026-11-11', ['raunak']); w.job('2026-11-11', '21:10', 'endOfDay');
  const id = w.ok(w.call('2026-11-12', '09:00', 'approvals', 'aakash')).absences[0].id;
  w.ok(w.call('2026-11-12', '09:01', 'keepAbsent', 'aakash', { id }));
  const seen = JSON.stringify([w.ok(w.call('2026-11-13', '09:00', 'approvals', 'aakash')), w.ok(w.call('2026-11-13', '09:00', 'approvals', 'varun')),
    w.ok(w.call('2026-11-13', '09:00', 'staffLeaves', 'aakash')), w.ok(w.call('2026-11-13', '09:00', 'pending', 'aakash')),
    w.ok(w.call('2026-11-13', '09:00', 'monthReport', 'aakash', { month: '2026-11' })), w.ok(w.call('2026-11-13', '09:00', 'board', 'aakash'))]);
  assert.ok(seen.indexOf(id) !== -1, 'no reply to Aakash or Varun contains the absence any more, so "Humanitarian – excused" cannot be tapped (the server would still accept it: ' +
    w.call('2026-11-13', '09:05', 'excuseAbsence', 'aakash', { id, reason: 'Medical paper brought' }).ok + ')');
});

// ====================================================================================================================
// R9-11 (Low). Emergencies are numbered again when one is cancelled (R7), but not when one stops being granted in
// another way. Here: three granted emergencies, the 2nd (not started) is edited and then rejected. Only two are
// granted now, but the other one stays "no. 3" with its violation and its day cut. (Same gap in recheckClashes.)
// ====================================================================================================================
test('R9-11 emergencies are numbered again when an edited one is rejected', () => {
  const w = world('2026-11-30');
  const one = w.ok(w.call('2026-11-03', '18:00', 'submitLeave', 'raunak', lv(['2026-11-04'])));
  w.ok(w.call('2026-11-03', '18:05', 'decideLeave', 'aakash', { id: one.id, approve: true }));
  const two = w.ok(w.call('2026-11-16', '23:00', 'submitLeave', 'raunak', lv(['2026-11-18'])));   // 35.5 h: Emergency
  w.ok(w.call('2026-11-16', '23:05', 'decideLeave', 'aakash', { id: two.id, approve: true }));
  const three = w.ok(w.call('2026-11-16', '23:30', 'submitLeave', 'raunak', lv(['2026-11-17']))); // 11 h: Emergency, granted third
  w.ok(w.call('2026-11-16', '23:35', 'decideLeave', 'aakash', { id: three.id, approve: true }));
  assert.equal(w.live('raunak', 'emergency-beyond-2').length, 1);
  w.ok(w.call('2026-11-17', '09:00', 'editLeave', 'raunak', Object.assign({ id: two.id }, lv(['2026-11-18'], { reasonText: 'Changed' }))));
  w.ok(w.call('2026-11-17', '09:05', 'decideLeave', 'aakash', { id: two.id, approve: false, reason: 'One day is enough' }));
  const m = w.month('2026-11-17', '09:10', 'raunak');
  assert.deepEqual([m.leaves.emergencies, m.leaves.daysCut, m.ladder.violations], [2, 0, 0],
    'two emergencies are granted, but: emergencies ' + m.leaves.emergencies + ', days cut ' + m.leaves.daysCut + ', violations ' + m.ladder.violations);
});

// ====================================================================================================================
// R9-12 (Low). A closed day entered LATER withdraws the violations of a leave that lies only on closed days (R4/R7).
// A leave that is granted AFTER the closed day was entered earns them: the check exists only in setSetting.
// ====================================================================================================================
test('R9-12 a leave only on a shop-closed day earns no violation, whichever of the two was entered first', () => {
  const w = world('2026-11-30');
  w.ok(w.call('2026-11-02', '10:00', 'saveRestriction', 'varun', { from: '2026-11-20', to: '2026-11-22', note: 'Peak', rule: 'violation' }));
  const r = w.ok(w.call('2026-11-10', '09:00', 'submitLeave', 'bhawna', lv(['2026-11-21'])));
  w.ok(w.call('2026-11-10', '10:00', 'setSetting', 'varun', { key: 'closedDays', value: ['2026-11-21'] }));   // the shop will be closed that day
  w.ok(w.call('2026-11-10', '11:00', 'decideLeave', 'aakash', { id: r.id, approve: true }));
  assert.equal(w.live('bhawna').length, 0, 'violation for a leave on a day the shop is closed: ' + w.live('bhawna').map(v => v.rule).join(', '));
});

// ====================================================================================================================
// R9-13 (Low, phone app). The 30-second refresh (round 5) redraws Today and Approvals unless the focus is in a
// filled field. After the keyboard is closed (iPhone "Done", a tap beside the field) the focus is gone, and the next
// refresh empties what was typed: Aakash's reject reason, the late / early form (which also jumps back to "late").
// Needs python3 + playwright (as tools/ui-round5.py); skipped when they are missing. Only 127.0.0.1 is contacted.
// ====================================================================================================================
test('R9-13 phone app: the automatic refresh does not empty a form that is being filled in', { timeout: 120000 }, t => {
  const { spawnSync } = require('node:child_process');
  const py = `
import subprocess, time, datetime, sys, json
try:
    from playwright.sync_api import sync_playwright
except Exception:
    print(json.dumps({'skip': 'playwright is not installed'})); sys.exit(0)
PORT = 8797
srv = subprocess.Popen([sys.executable, '-m', 'http.server', str(PORT), '--bind', '127.0.0.1', '--directory', __dirname + '/../docs'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(1.2)
IST = datetime.timezone(datetime.timedelta(hours=5, minutes=30))
URL = 'http://127.0.0.1:%d/index.html?demo=1&poll=1' % PORT
out = {}
try:
    with sync_playwright() as p:
        b = p.chromium.launch()
        ctx = b.new_context(viewport={'width': 360, 'height': 740}, has_touch=True, is_mobile=True)
        ctx.route('**/*', lambda r: r.continue_() if '127.0.0.1' in r.request.url else r.abort())
        pg = ctx.new_page(); pg.set_default_timeout(8000)
        pg.clock.install(time=datetime.datetime(2026, 11, 20, 9, 0, tzinfo=IST))
        def login(who):
            pg.goto(URL); pg.wait_for_selector('#who option', state='attached')
            pg.select_option('#who', who); pg.fill('#pin', '1234'); pg.click('button:has-text("Sign in")')
            pg.wait_for_selector('button:has-text("Demo only"), h1:has-text("Hello,")')
            if pg.locator('text=Demo only: approve this phone').count():
                pg.click('text=Demo only: approve this phone'); pg.click('button:has-text("Sign in")')
            pg.wait_for_selector('text=Hello,')
        login('vikas')
        card = '.card:has-text("Late or leaving early")'
        pg.click('button:has-text("I will leave early")'); pg.fill(card + ' input[type=time]', '19:00')
        pg.evaluate("()=>document.activeElement && document.activeElement.blur()")
        pg.clock.run_for(35000); pg.wait_for_timeout(500)
        out['staffTime'] = pg.input_value(card + ' input[type=time]'); out['staffKind'] = pg.inner_text(card + ' .seg button.on')
        pg.evaluate("()=>{localStorage.removeItem('gjleave.demo')}")
        login('aakash')
        pg.evaluate("""()=>{var who='vikas';var r=GJMock.handle({action:'login',args:{personId:who,pin:'1234',deviceToken:null,deviceLabel:'other'},clientVersion:1});GJMock.approveDevices();
          return GJMock.handle({action:'submitLeave',args:{kind:'full',dates:['2026-11-21'],reasonCode:'Sick',reasonText:'fever'},clientVersion:1,personId:who,deviceToken:r.data.deviceToken})}""")
        pg.evaluate("n=>{[].slice.call(document.querySelectorAll('#tabs button')).filter(b=>b.firstChild.textContent===n)[0].click()}", 'Approvals')
        pg.wait_for_timeout(800)
        sel = 'input[placeholder^="Reason (required to reject)"]'
        pg.fill(sel, 'Vikas and Neha are both needed on Saturday')
        pg.evaluate("()=>document.activeElement && document.activeElement.blur()")
        pg.clock.run_for(35000); pg.wait_for_timeout(500)
        out['aakashReason'] = pg.input_value(sel)
        b.close()
except Exception as e:
    out['skip'] = 'browser could not run: ' + str(e)[:200]
finally:
    srv.terminate()
print(json.dumps(out))
`;
  const run = spawnSync('python3', ['-c', py], { encoding: 'utf8', timeout: 110000 });
  let out = null; try { out = JSON.parse(String(run.stdout).trim().split('\n').pop()); } catch (e) { out = { skip: 'python3 did not answer: ' + String(run.stderr || run.error).slice(0, 200) }; }
  if (out.skip) return t.skip(out.skip);
  assert.deepEqual(out, { staffTime: '19:00', staffKind: 'I will leave early', aakashReason: 'Vikas and Neha are both needed on Saturday' },
    '35 seconds after typing (focus outside the field): ' + JSON.stringify(out));
});
