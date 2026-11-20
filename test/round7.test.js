// Round 7 (EDGE CASES) reproducers. Each test states the behaviour the handoff asks for and FAILS on the
// current code. Nothing under /home/claude/gj-leave is written (tools/build.js is never run).
// Driven through Api.handle on the Sheet store over a fake grid, the way doPost runs it.
const test = require('node:test');
const assert = require('node:assert/strict');
const R = __dirname + '/../';
const Store = require(R + 'src/server/store.js');
const Api = require(R + 'src/server/api.js');
const Jobs = require(R + 'src/server/jobs.js');
const { TABS } = require(R + 'src/server/schema.js');
const { env, seed } = require(R + 'test/helpers.js');

function fakeGrid() {
  const tabs = {};
  const g = { tabs, tabNames: () => Object.keys(tabs), addTab: n => { tabs[n] = []; }, read: n => (tabs[n] || []).map(r => r.slice()),
    headers: n => (tabs[n] && tabs[n][0] || []).slice(), tail: (n, k) => tabs[n].slice(1).slice(-k).map(r => r.slice()),
    append: (n, row) => g.appendMany([{ tab: n, rows: [row] }])[n], appendRows: (n, rows) => g.appendMany([{ tab: n, rows }])[n],
    appendMany: batch => { const first = {}; batch.forEach(b => { first[b.tab] = tabs[b.tab].length; b.rows.forEach(r => tabs[b.tab].push(r.map(String))); }); return first; },
    writeRow: (n, i, row) => { tabs[n][i] = row.map(String); } };
  return g;
}

/** A fresh shop: the handoff roster, one approved phone each, pay Rs 17,000 / 9 h, default clash rules. */
function shop(startDate) {
  const g = fakeGrid(); Store.setup(g); const mem = seed(); const db0 = Store.open(g);
  mem.db.rows('People').forEach(p => {
    db0.insert('People', p);
    db0.insert('Devices', { id: 'dev_' + p.id, personId: p.id, tokenHash: env.sha256('tok-' + p.id), label: '', status: 'approved', requestedAt: 1, decidedAt: 1, decidedBy: 'test' });
    db0.insert('PayInfo', { personId: p.id, fixedSalary: 17000, targetAllowance: 2000, disciplineBonus: 500, dutyHours: 9 });
  });
  const s = db0.rows('Settings').find(x => x.key === 'startDate');
  if (s) db0.update('Settings', 'startDate', { value: startDate || '2026-01-01' }); else db0.insert('Settings', { key: 'startDate', value: startDate || '2026-01-01' });
  const open = () => { const db = Store.open(g, { buffer: true }); let depth = 0;
    const e = Object.assign({}, env, { photos: env.photos, withLock(fn) { if (depth > 0) return fn(); depth += 1; try { return fn(); } finally { try { db.flush(); } finally { depth -= 1; } } } });
    return { db, e }; };
  const call = (date, hhmm, action, person, args) => {
    const { db, e } = open();
    const reply = Api.handle({ db, now: mem.ist(date, hhmm), env: e }, { action, clientVersion: 1, personId: person, deviceToken: 'tok-' + person, args: args || {} });
    db.flush();
    return reply;
  };
  const ok = r => { assert.equal(r.ok, true, JSON.stringify(r)); return r.data; };
  const job = (date, hhmm, name) => { const { db, e } = open(); const out = Jobs.run({ db, now: mem.ist(date, hhmm), env: e }, name, null); db.flush(); return out; };
  const rows = tab => Store.open(g).rows(tab);
  const month = (date, hhmm, p, m) => ok(call(date, hhmm, 'myMonth', p, { month: m }));
  return { g, call, ok, job, rows, month, ist: mem.ist };
}
const PIC = { photo: 'data:image/jpeg;base64,AAAA', thumb: 'data:image/jpeg;base64,BBBB', lat: 29.15, lng: 75.72, accuracy: 10 };
const leave = (dates, extra) => Object.assign({ kind: 'full', dates, reasonCode: 'Personal work', reasonText: 'Bank work' }, extra);
const liveViolations = (s, person, monthKey) => s.rows('Violations').filter(v => v.personId === person && v.date.slice(0, 7) === monthKey && v.disputeState !== 'removed');

const settingsOf = (s, at) => s.ok(s.call(at[0], at[1], 'getSettings', 'varun'));
const personOf = (s, at, id) => settingsOf(s, at).people.find(p => p.id === id);
/** A leave that is granted: sent, and approved by Aakash when it waits for him. */
const granted = (s, who, dates, at, extra) => {
  const r = s.ok(s.call(at[0], at[1], 'submitLeave', who, leave(dates, extra)));
  if (r.status !== 'Approved' && r.status !== 'Recorded') s.ok(s.call(at[0], at[1], 'decideLeave', 'aakash', { id: r.id, approve: true }));
  return r.id;
};
const quiet = fn => { const keep = console.error; console.error = () => {}; try { return fn(); } finally { console.error = keep; } };

// ====================================================================================================
// HIGH
// ====================================================================================================

test('H1a a Sunday roster changed on Monday must not turn last Sunday (off under the old roster) into "Absent – unannounced" + a violation', () => {
  const s = shop('2026-12-20');                                   // 20 Dec 2026 = 3rd Sunday; Neha is off on the 3rd and 4th
  s.job('2026-12-20', '21:00', 'endOfDay');
  assert.equal(s.rows('LeaveRequests').filter(r => r.personId === 'neha').length, 0, 'Sunday evening: Neha is off by roster, nothing recorded');
  s.ok(s.call('2026-12-21', '10:05', 'savePerson', 'varun', Object.assign({}, personOf(s, ['2026-12-21', '10:00'], 'neha'), { sundayOff: [1, 2] })));
  s.ok(s.call('2026-12-21', '09:30', 'checkIn', 'neha', PIC)); s.ok(s.call('2026-12-21', '18:30', 'checkOut', 'neha'));
  s.job('2026-12-21', '21:00', 'endOfDay');                       // the nightly job also looks back 3 days, with TODAY's roster
  const absent = s.rows('LeaveRequests').filter(r => r.personId === 'neha' && /^Absent/.test(r.status)).map(r => r.dates[0]);
  assert.deepEqual(absent, [], 'Neha was off by roster on 20 Dec; a later roster change must not re-judge that day');
  assert.equal(liveViolations(s, 'neha', '2026-12').length, 0);
});

test('H1b roster Sundays a person has already taken this month stay counted in the 5 after the roster is changed mid-month', () => {
  const s = shop('2026-12-15');                                   // Vikas is off 1st and 2nd Sunday: 6 and 13 Dec are gone, he was off
  assert.equal(s.month('2026-12-14', '10:00', 'vikas', '2026-12').leaves.total, 2);
  s.ok(s.call('2026-12-15', '10:05', 'savePerson', 'varun', Object.assign({}, personOf(s, ['2026-12-15', '10:00'], 'vikas'), { sundayOff: [] })));
  assert.equal(s.month('2026-12-15', '10:10', 'vikas', '2026-12').leaves.total, 2, 'the two Sundays he already had off cannot disappear from his count');
});

test('H1d the other way round: Sundays a person WORKED before the roster change are not counted as roster Sundays used (they would eat 2 of the 5)', () => {
  const s = shop('2026-12-01');
  const harsh = personOf(s, ['2026-12-01', '09:00'], 'harsh');
  s.ok(s.call('2026-12-01', '09:05', 'savePerson', 'varun', Object.assign({}, harsh, { sundayOff: [] })));          // no Sunday off for now
  for (const d of ['2026-12-06', '2026-12-13']) { s.ok(s.call(d, '10:30', 'checkIn', 'harsh', PIC)); s.ok(s.call(d, '19:30', 'checkOut', 'harsh')); }
  s.ok(s.call('2026-12-15', '10:05', 'savePerson', 'varun', Object.assign({}, harsh, { sundayOff: [1, 2] })));     // from now on: 1st and 2nd
  const m = s.month('2026-12-15', '10:10', 'harsh', '2026-12');
  assert.equal(m.leaves.total, 0, 'he worked both Sundays; the page now says 2 of his 5 are used');
});

test('H1c a person switched back to Active is not marked absent (with violations) for the days they were inactive', () => {
  const s = shop('2026-12-01');
  const harsh = personOf(s, ['2026-12-01', '10:00'], 'harsh');
  s.ok(s.call('2026-12-01', '10:05', 'savePerson', 'varun', Object.assign({}, harsh, { active: false })));
  s.ok(s.call('2026-12-10', '10:05', 'savePerson', 'varun', Object.assign({}, harsh, { active: true })));
  s.ok(s.call('2026-12-10', '10:30', 'checkIn', 'harsh', PIC));
  s.job('2026-12-10', '21:00', 'endOfDay');
  assert.deepEqual(s.rows('LeaveRequests').filter(r => r.personId === 'harsh').map(r => r.dates[0]), [], 'not part of the shop on 7, 8, 9 Dec');
  assert.equal(liveViolations(s, 'harsh', '2026-12').length, 0);
});

test('H2 a late request sent in time and approved by Aakash AFTER the arrival must become "informed", also when the pool partner was a few minutes late that day', () => {
  const D = '2026-12-09', s = shop(D);
  const q = s.ok(s.call(D, '08:00', 'requestShort', 'bhawna', { kind: 'late', date: D, time: '10:10' })); // 90 min before duty start
  s.ok(s.call(D, '10:10', 'checkIn', 'bhawna', PIC));              // arrives at the stated time, the request is still waiting
  s.ok(s.call(D, '10:12', 'checkIn', 'pooja', PIC));               // Pooja: 12 min late, nobody told
  const r = s.call(D, '11:00', 'decideShort', 'aakash', { id: q.id, approve: true });
  assert.equal(r.ok, true, 'Aakash cannot approve: ' + r.message);
  assert.deepEqual(liveViolations(s, 'bhawna', '2026-12').map(v => v.rule), [], 'she informed 90 min before duty start');
});

// ====================================================================================================
// MEDIUM
// ====================================================================================================

test('M1a Aakash cancels a 2-day leave on day 2 (came back early): day 1 stays an approved leave day, not "Absent – unannounced" + violation', () => {
  const s = shop('2026-12-08');
  const id = s.ok(s.call('2026-12-01', '10:00', 'submitLeave', 'neha', leave(['2026-12-08', '2026-12-09']))).id;
  s.ok(s.call('2026-12-09', '09:20', 'cancelLeave', 'aakash', { id, reason: 'Came back a day early' }));
  s.ok(s.call('2026-12-09', '09:30', 'checkIn', 'neha', PIC)); s.ok(s.call('2026-12-09', '18:30', 'checkOut', 'neha'));
  s.job('2026-12-09', '21:00', 'endOfDay');
  const m = s.month('2026-12-10', '10:00', 'neha', '2026-12');
  assert.deepEqual(m.violations.map(v => v.rule + ' ' + v.date), [], '8 Dec was an approved leave day');
  assert.equal(m.leaves.taken, 1, '8 Dec is still 1 leave day');
});

test('M1b a 5-day special leave cancelled on day 5: the 4 days taken stay 4 approved leave days (today: 3 violations = notice stage, and one day vanishes)', () => {
  const s = shop('2026-12-07');
  const id = s.ok(s.call('2026-12-01', '10:00', 'submitLeave', 'manish', leave(['2026-12-07', '2026-12-08', '2026-12-09', '2026-12-10', '2026-12-11']))).id;
  s.ok(s.call('2026-12-01', '10:05', 'decideLeave', 'aakash', { id, approve: true })); s.ok(s.call('2026-12-01', '10:06', 'decideLeave', 'varun', { id, approve: true }));
  s.ok(s.call('2026-12-11', '09:00', 'cancelLeave', 'aakash', { id, reason: 'Back one day early' }));
  s.ok(s.call('2026-12-11', '09:30', 'checkIn', 'manish', PIC)); s.ok(s.call('2026-12-11', '18:30', 'checkOut', 'manish'));
  s.job('2026-12-11', '21:00', 'endOfDay');
  const m = s.month('2026-12-12', '10:00', 'manish', '2026-12');
  assert.equal(m.ladder.violations, 0);
  assert.equal(m.leaves.taken, 4);
});

test('M2a Aakash shortens a leave that has started (same first day): it does not become "Unannounced" with a violation', () => {
  const s = shop('2026-12-08');
  const id = s.ok(s.call('2026-12-01', '10:00', 'submitLeave', 'neha', leave(['2026-12-08', '2026-12-09']))).id; // asked a week ahead: Regular
  s.ok(s.call('2026-12-09', '09:20', 'editLeave', 'aakash', Object.assign({ id }, leave(['2026-12-08']))));
  s.call('2026-12-09', '09:21', 'decideLeave', 'aakash', { id, approve: true });
  assert.equal(s.rows('LeaveRequests').find(r => r.id === id).type, 'Regular');
  assert.deepEqual(liveViolations(s, 'neha', '2026-12').map(v => v.rule), []);
});

test('M2b the person shortens an approved leave the evening before (same first day): it does not become an Emergency leave', () => {
  const s = shop('2026-12-08');
  const id = s.ok(s.call('2026-12-01', '10:00', 'submitLeave', 'neha', leave(['2026-12-08', '2026-12-09']))).id;
  s.ok(s.call('2026-12-07', '20:00', 'editLeave', 'neha', Object.assign({ id }, leave(['2026-12-08']))));
  assert.equal(s.rows('LeaveRequests').find(r => r.id === id).type, 'Regular', 'the notice for 8 Dec was given on 1 Dec');
});

test('M3 notice runs to duty start on the first LEAVE day: the person’s own roster Sunday at the front of the request is not that day', () => {
  const s = shop('2026-12-01');                                   // 20 Dec = Neha's roster Sunday; Monday 21 Dec is the only leave day
  const withSunday = s.ok(s.call('2026-12-19', '08:00', 'previewLeave', 'neha', leave(['2026-12-20', '2026-12-21'])));
  const mondayOnly = s.ok(s.call('2026-12-19', '08:00', 'previewLeave', 'neha', leave(['2026-12-21'])));
  assert.equal(mondayOnly.type, 'Regular'); assert.equal(mondayOnly.decision, 'auto');
  assert.equal(withSunday.type, mondayOnly.type, 'the same single leave day (Monday) must get the same notice type');
  assert.equal(withSunday.decision, 'auto');
});

test('M4a a closed day entered after people had already checked in / out: that day’s minutes, automatic half days and violations are re-counted too', () => {
  const D = '2026-12-09', s = shop(D);
  s.ok(s.call(D, '09:30', 'checkIn', 'neha', PIC)); s.ok(s.call(D, '11:20', 'checkIn', 'harsh', PIC));
  s.ok(s.call(D, '14:00', 'checkOut', 'neha')); s.ok(s.call(D, '14:00', 'checkOut', 'harsh'));          // the shop is shut at 14:00
  s.ok(s.call(D, '15:00', 'setSetting', 'varun', { key: 'closedDays', value: [D] }));
  for (const p of ['neha', 'harsh']) {
    const m = s.month('2026-12-10', '10:00', p, '2026-12');
    assert.deepEqual(m.violations.map(v => v.rule), [], p + ': no violation for a day the shop was closed');
    assert.equal(m.leaves.taken, 0, p + ': no leave is used on a closed day');
  }
});

test('M4b an emergency leave on a day that is later entered as closed no longer counts as one of the 2 emergencies', () => {
  const s = shop('2026-12-01');
  granted(s, 'neha', ['2026-12-03'], ['2026-12-02', '10:00']); granted(s, 'neha', ['2026-12-08'], ['2026-12-07', '10:00']);
  s.ok(s.call('2026-12-09', '10:00', 'setSetting', 'varun', { key: 'closedDays', value: ['2026-12-08'] }));
  granted(s, 'neha', ['2026-12-15'], ['2026-12-14', '10:00']);    // her 2nd real emergency
  const m = s.month('2026-12-16', '10:00', 'neha', '2026-12');
  assert.equal(m.leaves.emergencies, 2);
  assert.deepEqual(m.violations.map(v => v.rule), []);
  assert.equal(m.leaves.daysCut, 0);
});

test('M5 a clash rule switched on (or added) later: of two approved leaves that now clash, the later one becomes "Rejected – clash" and people are told (handoff 3.3)', () => {
  const s = shop('2026-12-01');
  const c2 = settingsOf(s, ['2026-12-01', '10:00']).rules.find(r => r.id === 'C2');
  s.ok(s.call('2026-12-01', '10:01', 'saveRule', 'varun', Object.assign({}, c2, { on: false })));
  assert.equal(s.ok(s.call('2026-12-01', '10:02', 'submitLeave', 'bhawna', leave(['2026-12-15']))).status, 'Approved');
  const later = s.ok(s.call('2026-12-01', '10:03', 'submitLeave', 'pooja', leave(['2026-12-15'])));
  assert.equal(later.status, 'Approved');
  s.ok(s.call('2026-12-01', '10:04', 'saveRule', 'varun', Object.assign({}, c2, { on: true })));
  assert.equal(s.rows('LeaveRequests').find(r => r.id === later.id).status, 'Rejected – clash');
  assert.ok(s.rows('Notifications').some(n => n.kind === 'clash'));
});

test('M6 Aakash is on approved leave: a request that waits "with Aakash" is also brought to Varun (handoff Part 6: Varun approves)', () => {
  const s = shop('2026-12-01');
  const own = s.ok(s.call('2026-12-01', '10:00', 'submitLeave', 'aakash', leave(['2026-12-08', '2026-12-09'])));
  s.ok(s.call('2026-12-01', '10:10', 'decideLeave', 'varun', { id: own.id, approve: true }));
  const r = s.ok(s.call('2026-12-08', '06:00', 'submitLeave', 'neha', leave(['2026-12-09'])));
  assert.equal(r.status, 'Pending with Aakash');
  s.job('2026-12-08', '09:00', 'hourly'); s.job('2026-12-08', '12:00', 'hourly');
  const toVarun = s.rows('Notifications').filter(n => n.to === 'varun' && n.ref === r.id);
  assert.ok(toVarun.length > 0, 'nobody who is at work is told; Varun gets no alert and no reminder');
});

test('M7 a check-out that Aakash took back (minutes set to 0) no longer makes that person "away": the pool partner is not blocked', () => {
  const D = '2026-12-09', s = shop(D);
  s.ok(s.call(D, '09:30', 'checkIn', 'bhawna', PIC)); s.ok(s.call(D, '10:00', 'checkIn', 'pooja', PIC));
  s.ok(s.call(D, '12:00', 'checkOut', 'bhawna'));                  // tapped by mistake
  s.ok(s.call(D, '12:02', 'undoCheckOut', 'aakash', { personId: 'bhawna', date: D, reason: 'Tapped by mistake' }));
  const r = s.call(D, '13:00', 'goingOut', 'pooja', { reason: 'Bank', expectedMinutes: 10 });
  assert.equal(r.ok, true, r.message);
});

test('M8 a counted violation that was withdrawn by a correction comes back when the correction is entered again (page and counter agree)', () => {
  const s = shop('2026-12-01');
  ['01', '02', '03', '04', '05'].forEach(d => { s.ok(s.call('2026-12-' + d, '09:30', 'checkIn', 'neha', PIC)); s.ok(s.call('2026-12-' + d, '18:25', 'checkOut', 'neha')); });
  assert.deepEqual(liveViolations(s, 'neha', '2026-12').map(v => v.rule), ['not-informed-beyond-passes']);   // the 5th not-informed time
  // Aakash corrects the check-out time of 2 Dec: takes it back and enters the real time (still before duty end).
  s.ok(s.call('2026-12-07', '10:00', 'undoCheckOut', 'aakash', { personId: 'neha', date: '2026-12-02', reason: 'Wrong time' }));
  s.ok(s.call('2026-12-07', '10:01', 'manualCheckOut', 'aakash', { personId: 'neha', date: '2026-12-02', time: '18:20', reason: 'Real time' }));
  const m = s.month('2026-12-07', '10:02', 'neha', '2026-12');
  assert.ok(m.bank.days.some(d => (d.notes || []).some(n => /no\. 5: violation/.test(n))), 'the page still says the 5th time is a violation');
  assert.equal(m.ladder.violations, 1, 'but the counter says 0: the withdrawn row is never used again');
});

// ====================================================================================================
// LOW
// ====================================================================================================

test('L1 no active manager: a more-than-3-days request does not hang for ever and stays visible to Varun', () => {
  const s = shop('2026-12-01');
  s.ok(s.call('2026-12-01', '10:05', 'savePerson', 'varun', Object.assign({}, personOf(s, ['2026-12-01', '10:00'], 'aakash'), { active: false })));
  const r = s.ok(s.call('2026-12-01', '10:10', 'submitLeave', 'neha', leave(['2026-12-14', '2026-12-15', '2026-12-16', '2026-12-17'])));
  const d = s.ok(s.call('2026-12-01', '10:20', 'decideLeave', 'varun', { id: r.id, approve: true }));
  const stillListed = s.ok(s.call('2026-12-01', '10:22', 'approvals', 'varun')).leaves.some(l => l.id === r.id);
  assert.ok(d.status === 'Approved' || stillListed, 'status "' + d.status + '", waiting for an Aakash who does not exist, and gone from Varun’s list');
});

test('L2 when an earlier emergency is cancelled, a later one that was "no. 3" is renumbered (no violation, no day cut for 2 emergencies)', () => {
  const s = shop('2026-12-01');
  const e1 = granted(s, 'neha', ['2026-12-03'], ['2026-12-02', '10:00']);
  granted(s, 'neha', ['2026-12-08'], ['2026-12-07', '10:00']); granted(s, 'neha', ['2026-12-11'], ['2026-12-10', '10:00']);
  s.ok(s.call('2026-12-10', '12:00', 'cancelLeave', 'aakash', { id: e1, reason: 'She worked that day' }));
  const m = s.month('2026-12-12', '10:00', 'neha', '2026-12');
  assert.equal(m.leaves.emergencies, 2);
  assert.deepEqual(m.violations.map(v => v.rule), []);
  assert.equal(m.leaves.daysCut, 0);
});

test('L3 a restriction made in the app with the default ticks also covers a person who joins afterwards', () => {
  const s = shop('2026-12-01');
  const ticked = s.ok(s.call('2026-12-01', '10:00', 'restrictions', 'varun')).people.filter(n => n !== 'Anita' && n !== 'Muskan'); // what the form sends
  s.ok(s.call('2026-12-01', '10:01', 'saveRestriction', 'varun', { from: '2026-12-20', to: '2026-12-26', note: 'Peak season', rule: 'no-leave', appliesTo: ticked }));
  const g = s.ok(s.call('2026-12-02', '10:00', 'savePerson', 'varun', { name: 'Garvit', group: 'Calls', role: 'staff', dutyStart: '10:00', dutyEnd: '19:00', sundayOff: [1, 2], active: true }));
  Store.open(s.g).insert('Devices', { id: 'dev_g', personId: g.id, tokenHash: env.sha256('tok-' + g.id), label: '', status: 'approved', requestedAt: 1, decidedAt: 1, decidedBy: 'test' });
  assert.equal(s.ok(s.call('2026-12-02', '10:10', 'previewLeave', 'neha', leave(['2026-12-22']))).decision, 'blocked');
  assert.equal(s.ok(s.call('2026-12-02', '10:10', 'previewLeave', g.id, leave(['2026-12-22']))).decision, 'blocked', 'the new joiner is auto-approved inside the blackout');
});

test('L4 "Anita: always Aakash" does not depend on the exact spelling of the free-text Group field', () => {
  const s = shop('2026-12-01');
  assert.equal(s.ok(s.call('2026-12-01', '10:00', 'previewLeave', 'anita', leave(['2026-12-10']))).decision, 'aakash');
  s.ok(s.call('2026-12-01', '10:05', 'savePerson', 'varun', Object.assign({}, personOf(s, ['2026-12-01', '10:00'], 'anita'), { group: 'House keeping' })));
  assert.equal(s.ok(s.call('2026-12-01', '10:06', 'previewLeave', 'anita', leave(['2026-12-10']))).decision, 'aakash');
});

test('L5 a person made inactive: their waiting request stops reminding Aakash every 2 hours', () => {
  const s = shop('2026-12-09');
  s.ok(s.call('2026-12-08', '20:00', 'submitLeave', 'bhawna', leave(['2026-12-10'])));
  s.ok(s.call('2026-12-09', '10:05', 'savePerson', 'varun', Object.assign({}, personOf(s, ['2026-12-09', '10:00'], 'bhawna'), { active: false })));
  s.job('2026-12-09', '13:00', 'hourly'); s.job('2026-12-09', '16:00', 'hourly');
  assert.equal(s.rows('Notifications').filter(n => n.kind === 'reminder' && n.createdAt > s.ist('2026-12-09', '10:05')).length, 0);
});

test('L6 a run that shrinks: after the first piece is cancelled, the remaining 2-day request no longer needs Aakash AND Varun', () => {
  const s = shop('2026-12-01');
  const a = s.ok(s.call('2026-12-01', '10:00', 'submitLeave', 'harsh', leave(['2026-12-14', '2026-12-15'])));
  const b = s.ok(s.call('2026-12-01', '10:01', 'submitLeave', 'harsh', leave(['2026-12-16', '2026-12-17'])));
  assert.equal(b.status, 'Special – waiting');                    // 4 in a row: correct at this moment
  s.ok(s.call('2026-12-01', '10:02', 'cancelLeave', 'harsh', { id: a.id }));
  assert.equal(s.ok(s.call('2026-12-01', '10:03', 'decideLeave', 'aakash', { id: b.id, approve: true })).status, 'Approved');
});

test('L7 going out near closing time: minutes after the person’s duty end are not taken from the bank', () => {
  const D = '2026-12-09', s = shop(D);
  s.ok(s.call(D, '09:30', 'checkIn', 'neha', PIC));               // duty 09:30–18:30
  const o = s.ok(s.call(D, '18:20', 'goingOut', 'neha', { reason: 'Courier', expectedMinutes: 10 }));
  s.ok(s.call(D, '18:20', 'decideOuting', 'aakash', { id: o.id, approve: true }));
  s.ok(s.call(D, '18:50', 'imBack', 'neha', { id: o.id }));       // 10 min of duty time, 20 min after duty end
  assert.ok(s.month(D, '19:00', 'neha', '2026-12').bank.used <= 10);
});

test('L8 a going-out request cannot be approved after the person has checked out for the day', () => {
  const D = '2026-12-09', s = shop(D);
  s.ok(s.call(D, '09:30', 'checkIn', 'neha', PIC));
  const o = s.ok(s.call(D, '18:00', 'goingOut', 'neha', { reason: 'Courier', expectedMinutes: 10 }));
  s.ok(s.call(D, '18:30', 'checkOut', 'neha'));
  assert.equal(s.call(D, '18:40', 'decideOuting', 'aakash', { id: o.id, approve: true }).ok, false, 'an outing clock now runs for someone who has gone home');
});

test('L9 the "would be deducted" working for a 3rd emergency inside the quota does not claim that only 4 leaves are free', () => {
  const s = shop('2026-12-01');
  granted(s, 'neha', ['2026-12-03'], ['2026-12-02', '10:00']); granted(s, 'neha', ['2026-12-08'], ['2026-12-07', '10:00']); granted(s, 'neha', ['2026-12-11'], ['2026-12-10', '10:00']);
  const line = s.month('2026-12-12', '10:00', 'neha', '2026-12').wouldBeDeducted.lines[0];
  assert.doesNotMatch(line, /− 4 free/, line);
});

test('L10 Muskan stays away with no request: the board and Varun’s daily summary do not call it "On leave"', () => {
  const D = '2026-12-09', s = shop(D);
  for (const p of ['neha', 'vikas', 'harsh', 'raunak', 'manish', 'bhawna', 'pooja', 'anita']) s.ok(s.call(D, '09:00', 'checkIn', p, PIC));
  const out = s.job(D, '21:00', 'endOfDay');
  assert.doesNotMatch(out.summary.join(' | '), /On leave: [^|]*Muskan/);
});

test('L11a Settings: a wrong-typed "active" cannot switch the only owner off', () => {
  const s = shop('2026-12-01');
  s.call('2026-12-01', '10:01', 'savePerson', 'varun', Object.assign({}, personOf(s, ['2026-12-01', '10:00'], 'varun'), { active: 0 }));
  assert.equal(s.call('2026-12-01', '10:02', 'me', 'varun').ok, true, 'the only owner is locked out of the app');
});

test('L11b Settings: a clash rule saved with a wrong-typed extra field cannot break every later clash check of that group', () => {
  const s = shop('2026-12-01');
  const c1 = settingsOf(s, ['2026-12-01', '10:00']).rules.find(r => r.id === 'C1');
  const saved = s.call('2026-12-01', '10:01', 'saveRule', 'varun', Object.assign({}, c1, { emergencyIfAllPresent: 'Bhawna' }));
  s.ok(s.call('2026-12-01', '10:02', 'submitLeave', 'vikas', leave(['2026-12-10'])));
  const r = quiet(() => s.call('2026-12-01', '10:03', 'previewLeave', 'harsh', leave(['2026-12-10'])));
  assert.ok(saved.ok === false || r.code !== 'ERROR', 'saved, and Harsh now gets "Something went wrong" instead of the clash message');
});

test('L11c Override: the same date sent twice is not stored (and counted) twice', () => {
  const s = shop('2026-12-01');
  s.call('2026-12-01', '10:05', 'overrideLeave', 'varun', Object.assign({ forPersonId: 'neha', overrideReason: 'x' }, leave(['2026-12-15', '2026-12-15', '2026-12-15'])));
  assert.ok(s.month('2026-12-02', '10:00', 'neha', '2026-12').leaves.taken <= 1);
});

test('L12 wrong-typed arguments get a clear refusal, not "Something went wrong"', () => {
  const s = shop('2026-12-01');
  const codes = quiet(() => [
    s.call('2026-12-01', '10:06', 'submitLeave', 'neha', leave('2026-12-21')).code,                       // dates as text, not a list
    s.call('2026-12-01', '10:06', 'effect', 'neha', { kind: 'late', minutes: 20, date: 5 }).code,
    s.call('2026-12-01', '10:06', 'myMonth', 'aakash', { month: '2026-12', personId: 'nobody' }).code,
    s.call('2026-12-01', '10:06', 'setPin', 'varun', { personId: 'nobody', pin: '1234' }).code,
  ]);
  assert.ok(codes.indexOf('ERROR') === -1, codes.join(', '));
});
