// Round 8: FULL SHOP-DAY AND SHOP-MONTH SIMULATION (the parts where the app matches an independent hand count).
// Everything is driven ONLY through Api.handle on the Sheet store with the read cache, the way doPost does it,
// and through Jobs.run for the timed jobs. The hand count is written as comments next to each assertion.
// Run: node --test /home/claude/findings/sim-round8.test.js
//
// LEFT OUT here because the app disagrees with the hand count (see round8.md and repro-round8.test.js):
//   - day B: the daily summary lists Harsh (roster off, came in to help) as "Late"                   -> R8-9
//   - month: Muskan gets no "your leave starts tomorrow" reminder (hand count: 1)                    -> R8-10
//   - month: the alerts to Varun / Aakash for a leave violation do not name the person               -> R8-7
//   - month / day C: nobody is told when a recorded violation is withdrawn                           -> R8-6
//   - month: on Aakash's leave day (14 Nov) Varun is not told about Harsh's going-out request        -> R8-3
//   - a missed check-in, a lock across a month end, a dispute-removed emergency violation,
//     cancelling the rest of a leave while still away, retries, "1 more = violation"               -> R8-1, R8-2, R8-4, R8-5, R8-8, R8-11
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

// ------------------------------------------------------------------ harness (mirrors doPost in src/gas/main.js)
const CELL_LIMIT = 50000; // Google Sheets refuses more characters than this in one cell
function fakeGrid() {
  const tabs = {};
  const check = row => row.forEach(c => { if (String(c).length > CELL_LIMIT) throw new Error('cell over 50000 characters'); });
  const g = { tabs, tabNames: () => Object.keys(tabs), addTab: n => { tabs[n] = []; }, read: n => (tabs[n] || []).map(r => r.slice()),
    headers: n => (tabs[n] && tabs[n][0] || []).slice(), tail: (n, k) => tabs[n].slice(1).slice(-k).map(r => r.slice()),
    append: (n, row) => g.appendMany([{ tab: n, rows: [row] }])[n], appendRows: (n, rows) => g.appendMany([{ tab: n, rows }])[n],
    appendMany: batch => { const first = {}; batch.forEach(b => { b.rows.forEach(check); first[b.tab] = tabs[b.tab].length; b.rows.forEach(r => tabs[b.tab].push(r.map(String))); }); return first; },
    writeRow: (n, i, row) => { check(row); tabs[n][i] = row.map(String); } };
  return g;
}
function fakeCache() { const m = new Map(); return { getAll: keys => { const o = {}; keys.forEach(k => { if (m.has(k)) o[k] = m.get(k); }); return o; }, put: (k, v) => m.set(k, v), putAll: map => Object.keys(map).forEach(k => m.set(k, map[k])) }; }

// The roster of handoff Part 3.1.
const ROSTER = [
  ['Neha', 'Sales', 'staff', '09:30', '18:30', [3, 4]],
  ['Vikas', 'Sales', 'staff', '11:00', '20:00', [1, 2]],
  ['Harsh', 'Sales', 'staff', '10:30', '19:30', [1, 2]],
  ['Raunak', 'Repairing', 'staff', '10:30', '19:30', [1, 2]],
  ['Manish', 'Repairing', 'staff', '09:30', '18:30', [3, 4]],
  ['Muskan', 'Testing', 'staff', '10:45', '19:45', []],
  ['Bhawna', 'Calls', 'staff', '09:30', '18:30', [3, 4]],
  ['Pooja', 'Calls', 'staff', '10:00', '19:00', [1, 2]],
  ['Anita', 'Housekeeping', 'staff', '09:30', '17:30', 'every'],
  ['Aakash', 'Manager', 'manager', '10:00', '19:00', []],
  ['Varun', 'Owner', 'owner', '10:00', '19:00', []],
];
const STAFF = ROSTER.filter(r => r[2] === 'staff').map(r => r[0].toLowerCase());
const ist = (date, hhmm) => Date.parse(date + 'T' + hhmm + ':00+05:30');
const hm = (t, add) => { const m = +t.slice(0, 2) * 60 + +t.slice(3) + add; return String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0'); };
const PIC = { photo: 'data:image/jpeg;base64,AAAA', thumb: 'data:image/jpeg;base64,BBBB', lat: 29.15, lng: 75.72, accuracy: 10 };
const lv = (dates, code, text, extra) => Object.assign({ kind: 'full', dates, reasonCode: code || 'Personal work', reasonText: text || 'Bank work' }, extra);

function world(opts) {
  opts = opts || {};
  const cached = opts.cached !== false;
  const g = fakeGrid(); Store.setup(g); const cache = fakeCache(); let vn = 0, seq = 0;
  const env = { sha256: s => crypto.createHash('sha256').update(s).digest('hex'), randomId: () => 'id' + (++seq) + '_' + ('00000' + seq).slice(-6),
    withLock: fn => fn(), photos: {}, savePhoto(name, data) { const id = 'photo_' + name; this.photos[id] = data; return id; }, readPhoto(id) { return this.photos[id]; } };
  const db0 = Store.open(g); const who = {}; const staffReplies = [];
  const pay = opts.pay || (() => ({ fixedSalary: 17000, targetAllowance: 2000, disciplineBonus: 500 }));
  ROSTER.forEach(([name, group, role, dutyStart, dutyEnd, sundayOff]) => {
    const id = name.toLowerCase();
    db0.insert('People', { id, name, group, role, dutyStart, dutyEnd, sundayOff, noApproval: name === 'Muskan', noClash: name === 'Muskan' || name === 'Anita', noQuota: name === 'Muskan', dressExempt: name === 'Anita', active: true, pinTries: 0 });
    db0.insert('Devices', { id: 'dev_' + id, personId: id, tokenHash: env.sha256('tok-' + id), label: '', status: 'approved', requestedAt: 1, decidedAt: 1, decidedBy: 'test' });
    db0.insert('PayInfo', Object.assign({ personId: id, dutyHours: (ist('2026-01-01', dutyEnd) - ist('2026-01-01', dutyStart)) / 3600000 }, pay(id)));
    who[id] = { personId: id, deviceToken: 'tok-' + id, role };
  });
  if (opts.startDate) db0.insert('Settings', { key: 'startDate', value: opts.startDate });
  const open = () => Store.open(cached ? wrap(g, cache, Object.keys(TABS), () => 'v' + (++vn)) : g, { buffer: true });
  // hooks.whileWaitingForLock: another request gets the lock first and finishes completely before this one.
  function call(date, hhmm, action, person, args, hooks) {
    hooks = hooks || {};
    const db = open(); let depth = 0;
    const e = Object.assign({}, env, { photos: env.photos, withLock(fn) { if (depth > 0) return fn(); if (hooks.whileWaitingForLock) hooks.whileWaitingForLock(); depth += 1; try { return fn(); } finally { try { db.flush(); } finally { depth -= 1; } } } });
    const reply = Api.handle({ db, now: ist(date, hhmm), env: e }, Object.assign({ action, clientVersion: 1, args: args || {} }, person ? who[person] : {}));
    db.flush();
    if (person && who[person].role === 'staff') staffReplies.push({ person, action, reply });
    return reply;
  }
  function job(date, hhmm, name) {
    const db = open(); let depth = 0;
    const e = Object.assign({}, env, { withLock(fn) { if (depth > 0) return fn(); depth += 1; try { return fn(); } finally { try { db.flush(); } finally { depth -= 1; } } } });
    const out = Jobs.run({ db, now: ist(date, hhmm), env: e }, name, null); db.flush(); return out;
  }
  const ok = r => { assert.equal(r.ok, true, JSON.stringify(r)); return r.data; };
  const sheet = tab => Store.open(g).rows(tab);
  const snap = () => JSON.stringify(g.tabs);
  /** Running a job a second time at the same moment must change nothing on the Sheet. */
  const jobTwice = (date, hhmm, name) => { const out = job(date, hhmm, name); const before = snap(); job(date, hhmm, name); assert.equal(snap(), before, name + ' run twice changed the Sheet on ' + date + ' ' + hhmm); return out; };
  const alerts = () => { const t = {}; sheet('Notifications').forEach(n => { t[n.to] = t[n.to] || {}; t[n.to][n.kind] = (t[n.to][n.kind] || 0) + 1; }); return t; };
  return { g, call, job, jobTwice, ok, sheet, snap, staffReplies, who, alerts };
}

// ------------------------------------------------------------------ counting the hand-counted values
let COMPARED = 0;
const eq = (actual, expected, label) => { COMPARED += 1; assert.deepEqual(actual, expected, label); };
const like = (actual, re, label) => { COMPARED += 1; assert.match(String(actual), re, label); };
test.after(() => { console.log('hand-counted values compared in sim-round8: ' + COMPARED + ' (all matched)'); });

/**
 * Alerts per person, kind by kind, against the hand count. Every kind the app has today must match exactly.
 * Tolerated: a kind that does not exist today (a later fix may add one, e.g. "violation withdrawn"), and the
 * pairs named in `leftOut` (alerts the hand count expects and the app does not send yet: see the list at the top).
 */
const KINDS_TODAY = ['decision', 'leave-tomorrow', 'out', 'violation', 'approval', 'reminder', 'override', 'dress', 'missing-checkout', 'absent', 'month', 'dispute', 'incident',
  'notice-stage', 'daily-summary', 'device', 'clash', 'undecided', 'warn-bank80', 'warn-bank0', 'warn-passes', 'warn-v1', 'warn-v2', 'warn-emergency'];
function eqAlerts(actual, expected, leftOut) {
  const skip = {}; (leftOut || []).forEach(([to, kind]) => { skip[to + ':' + kind] = true; });
  const clean = {};
  Object.keys(actual).forEach(to => Object.keys(actual[to]).forEach(kind => { if (KINDS_TODAY.indexOf(kind) !== -1 && !skip[to + ':' + kind]) (clean[to] = clean[to] || {})[kind] = actual[to][kind]; }));
  Object.keys(expected).forEach(to => { COMPARED += Object.keys(expected[to]).length; });
  assert.deepEqual(clean, expected);
}
/** One person's alerts, kind by kind (same tolerance as eqAlerts). */
function eqKinds(actual, expected) {
  const clean = {}; Object.keys(actual || {}).forEach(kind => { if (KINDS_TODAY.indexOf(kind) !== -1) clean[kind] = actual[kind]; });
  COMPARED += Object.keys(expected || {}).length || 1;
  assert.deepEqual(clean, expected || {});
}
/** Every reply a staff phone received: no salary structure, no PIN / token data, nobody else's reasons or notes. */
function privacy(w, secrets, salaries) {
  const BAD_KEYS = /^(fixedSalary|targetAllowance|pinHash|pinSalt|tokenHash|disciplineBonus)$/;
  w.staffReplies.forEach(({ person, action, reply }) => {
    const text = JSON.stringify(reply);
    (function walk(v, key) {
      if (v && typeof v === 'object') return Object.keys(v).forEach(k => { assert.doesNotMatch(k, BAD_KEYS, person + ' ' + action + ' has key ' + k); walk(v[k], k); });
      if (salaries && typeof v === 'number') Object.keys(salaries).forEach(p => { if (p !== person && salaries[p] > 0) assert.notEqual(v, salaries[p], person + ' ' + action + ' carries the salary of ' + p + ' in ' + key); });
    })(reply, '');
    (secrets || []).forEach(([textOf, ...allowed]) => { if (allowed.indexOf(person) === -1) assert.equal(text.indexOf(textOf), -1, person + ' ' + action + ' can read "' + textOf + '"'); });
  });
  COMPARED += 1;
}
const month = (w, date, time, p, m) => w.ok(w.call(date, time, 'myMonth', p, { month: m || date.slice(0, 7) }));
const rules = m => m.violations.map(v => v.date.slice(8) + ':' + v.rule + (v.disputeState ? '(' + v.disputeState + ')' : ''));
const D = d => '2026-12-' + String(d).padStart(2, '0');
const N = d => '2026-11-' + String(d).padStart(2, '0');

// =====================================================================================================
// (d) The owner's six worked examples (handoff 3.5), as real requests and check-ins. Duty 10:30, Rs 17,000, 9 h.
//     Rate: 17000 / 30 / 9 / 60 = Rs 1.0494 a minute.
// =====================================================================================================
function exampleWorld() {
  const w = world({ startDate: D(1) });
  const days = []; for (let i = 1; i <= 31; i++) if (Cal.weekday(D(i)) !== 0) days.push(D(i)); // Mon-Sat of December 2026
  let i = 0;
  const jobs = d => { w.jobTwice(d, '12:07', 'hourly'); w.jobTwice(d, '20:07', 'hourly'); };
  const api = {
    w, next: () => days[i++],
    // not informed: just arrives N minutes late
    late(p, n) { const d = days[i++]; w.ok(w.call(d, hm('10:30', n), 'checkIn', p, PIC)); w.ok(w.call(d, '19:30', 'checkOut', p)); jobs(d); },
    // informed: applied in the app before duty start with the arrival time, approved by Aakash, arrives at that time
    lateInformed(p, n) { const d = days[i++]; const q = w.ok(w.call(d, '09:00', 'requestShort', p, { kind: 'late', date: d, time: hm('10:30', n) })); w.ok(w.call(d, '09:05', 'decideShort', 'aakash', { id: q.id, approve: true }));
      w.ok(w.call(d, hm('10:30', n), 'checkIn', p, PIC)); w.ok(w.call(d, '19:30', 'checkOut', p)); jobs(d); },
    jobs, end: p => month(w, D(31), '21:30', p),
  };
  return api;
}
const money = m => m.wouldBeDeducted.total;

test('worked example 1 (Rohit): 8 days in the grace + 10 days 22 min informed = Rs 0, 0 violations', () => {
  const x = exampleWorld();
  [5, 6, 7, 8, 9, 10, 10, 5].forEach(n => x.late('harsh', n));      // grace: nothing
  for (let k = 0; k < 10; k++) x.lateInformed('harsh', 22);         // 12 x 10 = 120
  const m = x.end('harsh');
  eq([m.bank.used, m.bank.left, m.bank.beyond, m.bank.passesUsed], [120, 0, 0, 0]); eq(m.violations.length, 0); eq(money(m), 0); eq(m.ladder.bonusLost, false);
  // alerts: 10 approvals; "80% used" after the 8th informed day (96 min), "bank used up" after the 10th
  eqKinds(x.w.alerts().harsh, { decision: 10, 'warn-bank80': 1, 'warn-bank0': 1 }); eqKinds(x.w.alerts().varun, undefined);
  eq(x.w.sheet('DayMinutes').length, 10);                           // the 8 grace days leave no minutes row
});

test('worked example 2 (Simran): 75 + free 15-min outing + 45 early + bus 15 not informed = Rs 5, 0 violations', () => {
  const x = exampleWorld(), w = x.w;
  for (let k = 0; k < 3; k++) x.lateInformed('harsh', 35);          // 25 x 3 = 75
  { const d = x.next(); w.ok(w.call(d, '10:30', 'checkIn', 'harsh', PIC));
    const o = w.ok(w.call(d, '13:00', 'goingOut', 'harsh', { reason: 'Bank', expectedMinutes: 15 })); w.ok(w.call(d, '13:02', 'decideOuting', 'aakash', { id: o.id, approve: true }));
    eq(w.ok(w.call(d, '13:17', 'imBack', 'harsh', { id: o.id })).minutes, 15); w.ok(w.call(d, '13:25', 'confirmBack', 'aakash', { id: o.id })); // Aakash confirms 8 min later: not charged
    w.ok(w.call(d, '19:30', 'checkOut', 'harsh')); x.jobs(d); }
  { const d = x.next(); w.ok(w.call(d, '10:30', 'checkIn', 'harsh', PIC));
    const q = w.ok(w.call(d, '12:00', 'requestShort', 'harsh', { kind: 'early', date: d, time: '18:45' })); w.ok(w.call(d, '12:05', 'decideShort', 'aakash', { id: q.id, approve: true }));
    eq(w.ok(w.call(d, '18:45', 'checkOut', 'harsh')).earlyMinutes, 45); x.jobs(d); }                     // total 120
  x.late('harsh', 15);                                              // 5 counted, pass 1, all 5 beyond the bank
  const m = x.end('harsh');
  eq([m.bank.used, m.bank.left, m.bank.beyond, m.bank.passesUsed], [120, 0, 5, 1]); eq(m.violations.length, 0);
  eq(money(m), 5);                                                  // 5 x 1.0494 = 5.25 -> Rs 5
  eq(m.wouldBeDeducted.lines, ['5 min beyond bank × Rs 1.05 = Rs 5']);
  eqKinds(w.alerts().harsh, { decision: 4, out: 1, 'warn-bank0': 1 });   // 75 -> 120 in one step: no "80%" alert
});

test('worked example 3 (Aman): bus 25, 15, 30 not informed (passes 1-3) + 40 informed = 70 min, Rs 0, 0 violations', () => {
  const x = exampleWorld();
  [25, 15, 30].forEach(n => x.late('harsh', n));                    // 15 + 5 + 20 = 40
  x.lateInformed('harsh', 40);                                      // 30 -> 70
  const m = x.end('harsh');
  eq([m.bank.used, m.bank.left, m.bank.beyond, m.bank.passesUsed], [70, 50, 0, 3]); eq(m.violations.length, 0); eq(money(m), 0);
  eqKinds(x.w.alerts().harsh, { decision: 1, 'warn-passes': 1 });
});

test('worked example 4 (Karan): 12 days 30 min informed = Rs 126, 1 violation (record only)', () => {
  const x = exampleWorld();
  for (let k = 0; k < 12; k++) x.lateInformed('raunak', 30);        // 20 x 6 = 120, then 120 more beyond
  const m = x.end('raunak');
  eq([m.bank.used, m.bank.left, m.bank.beyond, m.bank.passesUsed], [120, 0, 120, 0]);
  eq(m.violations.map(v => v.rule), ['extra-2-hours-beyond-bank']);
  eq(money(m), 126);                                                // 120 x 1.0494 = 125.9
  eq([m.ladder.violations, m.ladder.recordOnly, m.ladder.bonusLost, m.ladder.notice], [1, true, false, false]);
  // alerts: "80%" after day 5 (100 min), "used up" after day 6, the violation on day 12 and "1 violation this month"
  eqKinds(x.w.alerts().raunak, { decision: 12, 'warn-bank80': 1, 'warn-bank0': 1, violation: 1, 'warn-v1': 1 });
  eqKinds(x.w.alerts().varun, { violation: 1 }); eqKinds(x.w.alerts().aakash, { approval: 12, violation: 1 });
});

test('worked example 5 (Priya): 5 x 20 min not informed + one 40 min = 2 violations, bonus and allowance lost, Rs 0', () => {
  const x = exampleWorld();
  for (let k = 0; k < 5; k++) x.late('harsh', 20);                  // 3 passes, the 4th, the 5th = VIOLATION 1
  x.late('harsh', 40);                                              // more than 30 = VIOLATION 2
  const m = x.end('harsh');
  eq([m.bank.used, m.bank.left, m.bank.beyond, m.bank.passesUsed], [80, 40, 0, 3]);
  eq(m.violations.map(v => v.rule), ['not-informed-beyond-passes', 'not-informed-over-30']);
  eq(money(m), 0);
  eq([m.ladder.violations, m.ladder.bonusLost, m.ladder.bonusAmount, m.ladder.targetAllowanceLost, m.ladder.notice], [2, true, 500, true, false]);
  eqKinds(x.w.alerts().harsh, { 'warn-passes': 1, violation: 2, 'warn-v1': 1, 'warn-v2': 1 });
  eqKinds(x.w.alerts().varun, { violation: 2 });
});

test('worked example 6 (Deepak): leave told after duty start + 6 days 1 h 10 informed = Rs 252, 3 violations, notice', () => {
  const x = exampleWorld(), w = x.w;
  { const d = x.next();                                             // told at 10:45, duty started 10:30
    const r = w.ok(w.call(d, '10:45', 'submitLeave', 'harsh', lv([d], 'Sick', 'Fever')));
    eq(r.status, 'Pending with Aakash'); like(r.warnings[0], /unannounced leave and counts as 1 violation/);
    eq(w.ok(w.call(d, '11:00', 'decideLeave', 'aakash', { id: r.id, approve: true })).status, 'Approved'); x.jobs(d); }  // VIOLATION 1
  for (let k = 0; k < 6; k++) x.lateInformed('harsh', 70);          // 60 x 2 = bank; 120 beyond = V2; 240 beyond = V3
  const m = x.end('harsh');
  eq([m.bank.used, m.bank.left, m.bank.beyond], [120, 0, 240]);
  eq(m.violations.map(v => v.rule), ['unannounced-leave', 'extra-2-hours-beyond-bank', 'extra-2-hours-beyond-bank']);
  eq(money(m), 252);
  eq([m.ladder.violations, m.ladder.bonusLost, m.ladder.targetAllowanceLost, m.ladder.notice], [3, true, true, true]);
  eq([m.leaves.total, m.leaves.taken, m.leaves.left], [3, 1, 2]);   // 2 roster Sundays (6, 13 Dec) + the leave
  eqKinds(w.alerts().harsh, { decision: 8, violation: 3, 'warn-v1': 1, 'warn-bank0': 1, 'warn-v2': 1 });
  eqKinds(w.alerts().varun, { violation: 3, 'notice-stage': 1 });        // every 3rd warning goes to Varun
});

// =====================================================================================================
// (a1) A normal weekday: Wednesday 9 December 2026.
// =====================================================================================================
test('shop day A: a normal Wednesday, 11 people, board / approvals / calendar / alerts against the hand count', () => {
  const w = world({ startDate: D(9) }), { call, ok } = w;
  // Two days before: Raunak asks for Wednesday. 48.5 h notice, 1 day, 2 roster Sundays + 1 = 3 of 5, no violation: auto-approved.
  eq(ok(call(D(7), '10:00', 'submitLeave', 'raunak', lv([D(9)], 'Personal work', 'Sister admission RAUNAK-A'))).status, 'Approved');
  eq(w.jobTwice(D(8), '19:30', 'evening'), 1);                      // "your leave starts tomorrow" for Raunak
  const late = ok(call(D(8), '20:00', 'requestShort', 'pooja', { kind: 'late', date: D(9), time: '10:30' }));
  eq([late.minutes, late.status], [30, 'Pending']);
  const a1 = ok(call(D(8), '20:05', 'approvals', 'aakash'));
  eq(a1.shorts.map(q => [q.name, q.kind, q.date, q.time]), [['Pooja', 'late', D(9), '10:30']]); eq(a1.leaves.length, 0);
  ok(call(D(8), '20:15', 'decideShort', 'aakash', { id: late.id, approve: true }));
  const state = (t) => { const b = ok(call(D(9), t, 'board', 'aakash')).people; const o = {}; b.forEach(p => { o[p.name] = p.state + (p.lateMinutes ? ' ' + p.lateMinutes : ''); }); return o; };
  const events = [];
  const at = (t, fn) => events.push({ t, fn, o: events.length });
  for (let h = 0; h < 24; h++) at(String(h).padStart(2, '0') + ':07', () => w.jobTwice(D(9), String(h).padStart(2, '0') + ':07', 'hourly'));
  at('09:20', () => eq(state('09:20'), { Neha: 'Not in yet', Vikas: 'Not in yet', Harsh: 'Not in yet', Raunak: 'On leave', Manish: 'Not in yet', Muskan: 'Not in yet', Bhawna: 'Not in yet', Pooja: 'Not in yet', Anita: 'Not in yet' }));
  at('09:25', () => ok(call(D(9), '09:25', 'checkIn', 'neha', PIC)));
  at('09:28', () => ok(call(D(9), '09:28', 'checkIn', 'bhawna', PIC)));
  at('09:29', () => ok(call(D(9), '09:29', 'checkIn', 'anita', PIC)));
  at('09:37', () => { const r = ok(call(D(9), '09:37', 'checkIn', 'manish', PIC)); eq([r.lateMinutes, r.informed, r.flag], [7, null, '']); });   // inside the 10-min grace
  // 10:15: Pooja (due 10:00) is 15 min late on the board; Harsh, Muskan, Vikas are not due yet
  at('10:15', () => eq(state('10:15'), { Neha: 'In', Vikas: 'Not in yet', Harsh: 'Not in yet', Raunak: 'On leave', Manish: 'In 7', Muskan: 'Not in yet', Bhawna: 'In', Pooja: 'Not in yet – late 15', Anita: 'In' }));
  at('10:25', () => ok(call(D(9), '10:25', 'checkIn', 'harsh', PIC)));
  at('10:28', () => { const r = ok(call(D(9), '10:28', 'checkIn', 'pooja', PIC)); eq([r.lateMinutes, r.informed], [28, true]); });               // informed 30, came after 28: 18 from the bank
  at('10:40', () => ok(call(D(9), '10:40', 'checkIn', 'muskan', PIC)));
  at('10:55', () => ok(call(D(9), '10:55', 'checkIn', 'vikas', PIC)));
  // Raunak is on leave: Manish cannot be away at all today (C3), and says only who, never why
  at('11:00', () => eq(call(D(9), '11:00', 'goingOut', 'manish', { reason: 'Tea', expectedMinutes: 10 }).message, 'Not allowed: Raunak is off on 9 Dec — Repairing needs 1 of Raunak, Manish present.'));
  at('12:00', () => eq(ok(call(D(9), '12:00', 'submitLeave', 'neha', lv([D(15)], 'Family function', 'Engagement NEHA-A'))).status, 'Approved'));   // 141.5 h, 3 of 5: auto
  at('12:05', () => { const p = ok(call(D(9), '12:05', 'previewLeave', 'harsh', lv([D(15)])));
    eq([p.decision, p.reasons], ['blocked', ['Not allowed: Neha is off on 15 Dec — Sales needs 2 of Neha, Vikas, Harsh present.']]); like(p.warnings.join('|'), /extreme emergency/); });
  at('12:10', () => { const c = ok(call(D(9), '12:10', 'calendar', 'aakash', { month: '2026-12' })).days; const day = n => c[n - 1];
    eq(day(9).entries, [{ name: 'Raunak', kind: 'leave', status: 'Approved' }]);
    eq(day(9).risk, ['Calls', 'Repairing', 'Repair pool']);        // Pooja was late (away that day), Raunak on leave
    eq([day(15).entries.map(e => e.name), day(15).risk], [['Neha'], ['Sales']]);
    eq([day(6).sunday, day(6).entries.map(e => e.name + ':' + e.kind), day(6).risk], [1, ['Vikas:roster', 'Harsh:roster', 'Raunak:roster', 'Pooja:roster', 'Anita:roster'], ['Sales', 'Calls', 'Repairing', 'Repair pool']]);
    eq([day(20).sunday, day(20).entries.map(e => e.name)], [3, ['Neha', 'Manish', 'Bhawna', 'Anita']]);
    eq([day(10).entries, day(10).risk, day(10).restrictions], [[], [], []]); });
  let oA, oV;
  at('13:00', () => { oA = ok(call(D(9), '13:00', 'goingOut', 'anita', { reason: 'Vegetable market ANITA-A', expectedMinutes: 15 })); });
  at('13:02', () => ok(call(D(9), '13:02', 'decideOuting', 'aakash', { id: oA.id, approve: true })));
  at('13:17', () => eq(ok(call(D(9), '13:17', 'imBack', 'anita', { id: oA.id })).minutes, 15));                                                  // 15 min: free
  at('13:20', () => ok(call(D(9), '13:20', 'confirmBack', 'aakash', { id: oA.id })));
  at('14:00', () => { oV = ok(call(D(9), '14:00', 'goingOut', 'vikas', { reason: 'ATM VIKAS-A', expectedMinutes: 20 })); });
  at('14:03', () => ok(call(D(9), '14:03', 'decideOuting', 'aakash', { id: oV.id, approve: true })));
  at('14:10', () => eq(state('14:10').Vikas, 'Out right now'));
  at('14:25', () => eq(ok(call(D(9), '14:25', 'imBack', 'vikas', { id: oV.id })).minutes, 22));                                                  // counted from the approval (14:03) to the tap
  at('14:30', () => { const t = ok(call(D(9), '14:30', 'today', 'vikas')); eq([t.outing.status, t.outing.minutes], ['Back', 22]); });
  at('14:40', () => ok(call(D(9), '14:40', 'remindBack', 'vikas', { id: oV.id })));
  at('14:41', () => eq(call(D(9), '14:41', 'remindBack', 'vikas', { id: oV.id }).code, 'BLOCKED'));
  at('14:45', () => eq(ok(call(D(9), '14:45', 'confirmBack', 'aakash', { id: oV.id })).minutes, 22));                                            // confirmed 20 min later: still 22
  at('15:00', () => eq(call(D(9), '15:00', 'goingOut', 'harsh', { reason: 'Courier', expectedMinutes: 10 }).message, 'Not allowed: Vikas is off on 9 Dec — Sales needs 2 of Neha, Vikas, Harsh present.'));
  at('16:00', () => { const e = ok(call(D(9), '16:00', 'effect', 'pooja', { kind: 'early', time: '18:30', date: D(9) })); eq([e.counted, e.bankLeft, e.lines[0]], [30, 72, 'This uses 30 min. Bank left after this: 72 min.']); });
  at('16:05', () => eq(ok(call(D(9), '16:05', 'todayAtGJ', 'neha')).map(x => x.name).sort(), ['Anita', 'Bhawna', 'Harsh', 'Manish', 'Muskan', 'Neha', 'Pooja', 'Vikas']));
  [['anita', '17:30'], ['neha', '18:30'], ['bhawna', '18:30'], ['manish', '18:31'], ['pooja', '19:00'], ['harsh', '19:30'], ['muskan', '19:45'], ['vikas', '20:00']]
    .forEach(([p, t]) => at(t, () => eq(ok(call(D(9), t, 'checkOut', p)).earlyMinutes, 0)));
  at('19:31', () => eq(w.jobTwice(D(9), '19:31', 'evening'), 0));
  at('21:15', () => { const out = w.jobTwice(D(9), '21:15', 'endOfDay');
    eq(out.absent, []); eq(out.summary, ['On leave: Raunak', 'Late: Pooja 28 min (in 10:28)', 'Absent with no request: none', 'No check-out yet: none']); });
  events.sort((a, b) => a.t < b.t ? -1 : a.t > b.t ? 1 : a.o - b.o).forEach(e => e.fn());

  // Next morning: nothing waits for Aakash.
  const a2 = ok(call(D(10), '09:00', 'approvals', 'aakash'));
  eq([a2.leaves.length, a2.absences.length, a2.outings.length, a2.outNow.length, a2.shorts.length, a2.dress.length], [0, 0, 0, 0, 0, 0]);
  // My month, by hand: Pooja 28 - 10 = 18 informed; Vikas 22 (whole outing); Anita 15 free; Manish grace.
  const m = p => month(w, D(10), '09:10', p);
  eq([m('pooja').bank.used, m('pooja').bank.left, m('pooja').bank.passesUsed], [18, 102, 0]); eq(m('pooja').bank.days.map(d => [d.kind, d.minutes, d.counted, d.informed]), [['late', 28, 18, true]]);
  eq([m('vikas').bank.used, m('anita').bank.used, m('manish').bank.used, m('neha').bank.used], [22, 0, 0, 0]);
  eq([m('raunak').leaves.total, m('raunak').leaves.taken, m('raunak').leaves.left], [3, 1, 2]);   // roster 6 + 13 Dec, and the 9th
  eq([m('neha').leaves.total, m('neha').leaves.taken, m('neha').leaves.left], [3, 1, 2]);         // roster 20 + 27 Dec, and the 15th
  STAFF.forEach(p => eq(m(p).violations.length, 0, p));
  eq(ok(call(D(9), '20:30', 'today', 'vikas')).hints, ['2-hour bank: 98 min left.', 'Not-informed passes: 3 of 3 left.', 'No violation this month.']);
  // Alerts, by hand. Aakash: Pooja's late request; going out: Anita (asked, back) and Vikas (asked, back, reminder).
  eqAlerts(w.alerts(), { raunak: { decision: 1, 'leave-tomorrow': 1 }, pooja: { decision: 1 }, neha: { decision: 1 }, anita: { out: 1 }, vikas: { out: 1 },
    aakash: { approval: 1, out: 5 }, varun: { 'daily-summary': 1 } });
  // The Sheet: one row per real event.
  eq(['LeaveRequests', 'ShortRequests', 'Outings', 'DayMinutes', 'Violations', 'Incidents', 'Thumbs'].map(t => w.sheet(t).length), [2, 1, 2, 3, 0, 0, 8]);
  eq([w.sheet('Punches').filter(p => p.kind === 'in').length, w.sheet('Punches').filter(p => p.kind === 'out').length], [8, 8]);
  privacy(w, [['RAUNAK-A', 'raunak'], ['NEHA-A', 'neha'], ['ANITA-A', 'anita'], ['VIKAS-A', 'vikas']]);
});

// =====================================================================================================
// (a2) The 1st Sunday: 6 December 2026. Roster off: Vikas, Harsh, Raunak, Pooja (1st and 2nd) and Anita.
// =====================================================================================================
test('shop day B: the 1st Sunday, roster in every clash rule, a manual violation and a dispute, a forgotten check-out', () => {
  const w = world({ startDate: D(6) }), { call, ok } = w;
  const state = (t) => { const o = {}; ok(call(D(6), t, 'board', 'aakash')).people.forEach(p => { o[p.name] = p.state; }); return o; };
  const events = []; const at = (t, fn) => events.push({ t, fn, o: events.length });
  for (let h = 0; h < 24; h++) at(String(h).padStart(2, '0') + ':07', () => w.jobTwice(D(6), String(h).padStart(2, '0') + ':07', 'hourly'));
  const OFF = { Vikas: 'Roster off', Harsh: 'Roster off', Raunak: 'Roster off', Pooja: 'Roster off', Anita: 'Roster off' };
  at('09:20', () => eq(state('09:20'), Object.assign({ Neha: 'Not in yet', Manish: 'Not in yet', Muskan: 'Not in yet', Bhawna: 'Not in yet' }, OFF)));
  at('09:28', () => ok(call(D(6), '09:28', 'checkIn', 'manish', PIC)));
  at('09:30', () => ok(call(D(6), '09:30', 'checkIn', 'bhawna', PIC)));
  // Neha 20 min late, nobody told: 10 from the bank, pass 1. Sunday is casual: a "top not white" result raises no flag.
  at('09:50', () => { const r = ok(call(D(6), '09:50', 'checkIn', 'neha', Object.assign({}, PIC, { dress: { top: 'issue', trousers: 'ok', shoes: 'ok', belt: 'ok' } }))); eq([r.lateMinutes, r.informed], [20, false]); });
  at('10:43', () => ok(call(D(6), '10:43', 'checkIn', 'muskan', PIC)));
  // C1-Sun: the roster may leave only Neha in Sales. Neha herself cannot be away. Roster Sundays count in C2 and C3.
  at('11:00', () => eq(call(D(6), '11:00', 'goingOut', 'neha', { reason: 'Bank', expectedMinutes: 20 }).message, 'Not allowed: Vikas and Harsh are off on 6 Dec — Sales needs 2 of Neha, Vikas, Harsh present.'));
  at('11:05', () => eq(call(D(6), '11:05', 'requestShort', 'bhawna', { kind: 'early', date: D(6), time: '17:30' }).message, 'Not allowed: Pooja is off on 6 Dec — Calls needs 1 of Bhawna, Pooja present.'));
  at('11:10', () => eq(call(D(6), '11:10', 'goingOut', 'manish', { reason: 'Tea', expectedMinutes: 10 }).message, 'Not allowed: Raunak is off on 6 Dec — Repairing needs 1 of Raunak, Manish present.'));
  let o;
  at('11:15', () => { o = ok(call(D(6), '11:15', 'goingOut', 'muskan', { reason: 'Lunch MUSKAN-B', expectedMinutes: 20 })); });        // Muskan is never blocked
  at('11:17', () => ok(call(D(6), '11:17', 'decideOuting', 'aakash', { id: o.id, approve: true })));
  at('11:30', () => { eq(state('11:30').Muskan, 'Out right now');
    eq(ok(call(D(6), '11:30', 'previewLeave', 'neha', lv([D(13)]))).reasons, ['Not allowed: Vikas and Harsh are off on 13 Dec — Sales needs 2 of Neha, Vikas, Harsh present.']);
    eq(ok(call(D(6), '11:31', 'previewLeave', 'bhawna', lv([D(13)]))).reasons, ['Not allowed: Pooja is off on 13 Dec — Calls needs 1 of Bhawna, Pooja present.']);
    eq(ok(call(D(6), '11:32', 'submitLeave', 'muskan', lv([D(13)], 'Exam', 'Test MUSKAN-B2'))).status, 'Recorded'); });
  at('11:45', () => eq(ok(call(D(6), '11:45', 'imBack', 'muskan', { id: o.id })).minutes, 28));
  at('11:50', () => ok(call(D(6), '11:50', 'confirmBack', 'aakash', { id: o.id })));
  // Harsh (roster off) comes in to help for a few hours: flagged, never counted.
  at('12:00', () => eq(ok(call(D(6), '12:00', 'checkIn', 'harsh', PIC)).flag, 'off-day'));
  at('12:10', () => eq(state('12:10'), Object.assign({ Neha: 'In', Manish: 'In', Muskan: 'In', Bhawna: 'In' }, OFF)));
  at('12:30', () => like(call(D(6), '12:30', 'recordIncident', 'aakash', { personId: 'manish', item: 'dress', note: 'No belt', date: D(6) }).message, /Sunday is casual/));
  at('12:35', () => eq(ok(call(D(6), '12:35', 'recordIncident', 'aakash', { personId: 'manish', item: 'phone', note: 'Reels for 20 min NOTE-M1', date: D(6) })).result, 'violation')); // no grace
  let vid;
  at('13:00', () => { vid = month(w, D(6), '13:00', 'manish').violations[0].id; ok(call(D(6), '13:01', 'disputeViolation', 'manish', { id: vid, text: 'Customer video MANISH-D1' })); });
  at('13:05', () => { eq(ok(call(D(6), '13:05', 'disputes', 'varun')).map(d => [d.name, d.rule]), [['Manish', 'manual:phone']]); eq(call(D(6), '13:06', 'decideDispute', 'aakash', { id: vid, uphold: false, note: 'x' }).code, 'FORBIDDEN'); });
  at('15:00', () => ok(call(D(6), '15:00', 'decideDispute', 'varun', { id: vid, uphold: true, note: 'Saw the screen recording NOTE-V' })));
  at('16:00', () => ok(call(D(6), '16:00', 'checkOut', 'harsh')));
  at('16:05', () => eq(ok(call(D(6), '16:05', 'todayAtGJ', 'bhawna')).length, 5));
  at('18:10', () => eq(ok(call(D(6), '18:10', 'checkOut', 'bhawna')).earlyMinutes, 20));      // she could not inform it (Pooja is off): 20 from the bank, pass 1
  at('18:30', () => ok(call(D(6), '18:30', 'checkOut', 'neha')));
  at('18:31', () => ok(call(D(6), '18:31', 'checkOut', 'manish')));                             // Muskan forgets
  at('19:30', () => eq(w.jobTwice(D(6), '19:30', 'evening'), 0));
  at('21:15', () => { const out = w.jobTwice(D(6), '21:15', 'endOfDay');
    eq(out.absent, []);                                                                         // roster off is never "absent"
    eq(out.summary[0], 'On leave: none'); like(out.summary[1], /Neha 20 min \(in 09:50\)/);     // (the Harsh part of this line: R8-12)
    eq(out.summary.slice(2), ['Absent with no request: none', 'No check-out yet: Muskan']); });
  events.sort((a, b) => a.t < b.t ? -1 : a.t > b.t ? 1 : a.o - b.o).forEach(e => e.fn());
  // Next morning Aakash enters Muskan's check-out.
  eq(ok(call(D(7), '10:00', 'manualCheckOut', 'aakash', { personId: 'muskan', date: D(6), time: '19:45', reason: 'Forgot to check out' })).earlyMinutes, 0);
  const m = p => month(w, D(7), '10:05', p);
  eq([m('neha').bank.used, m('neha').bank.passesUsed], [10, 1]); eq([m('bhawna').bank.used, m('bhawna').bank.passesUsed], [20, 1]); eq(m('muskan').bank.used, 28);
  eq(rules(m('manish')), ['06:manual:phone(upheld)']); eq([m('manish').ladder.violations, m('manish').ladder.recordOnly], [1, true]);
  eq([m('harsh').leaves.total, m('harsh').leaves.rosterSundays, m('harsh').bank.used], [2, 2, 0]);
  eq([m('muskan').leaves.total, m('muskan').onPayroll], [1, false]);
  eq(ok(call(D(7), '10:06', 'approvals', 'aakash')).dress, []);
  eqAlerts(w.alerts(), { aakash: { out: 2, 'missing-checkout': 1 }, muskan: { out: 1, decision: 1 }, manish: { violation: 1, dispute: 1, 'warn-v1': 1 },
    varun: { violation: 1, dispute: 1, 'daily-summary': 1 } });
  eq(['LeaveRequests', 'ShortRequests', 'Outings', 'DayMinutes', 'Violations', 'Incidents'].map(t => w.sheet(t).length), [1, 0, 1, 3, 1, 1]);
  eq([w.sheet('Punches').filter(p => p.kind === 'in').length, w.sheet('Punches').filter(p => p.kind === 'out').length], [5, 5]);
  privacy(w, [['MUSKAN-B', 'muskan'], ['NOTE-M1', 'manish'], ['MANISH-D1', 'manish'], ['NOTE-V', 'manish']]);
});

// =====================================================================================================
// (a3) A messy Friday: 11 December 2026.
// =====================================================================================================
test('shop day C: late arrivals, a request decided after arrival, outings, a half day, double taps, an incident, disputes, a forgotten check-out', () => {
  const w = world({ startDate: D(11) }), { call, ok } = w;
  // Before the day.
  eq(ok(call(D(7), '10:00', 'submitLeave', 'manish', lv([D(11)], 'Personal work', 'Gas agency MANISH-C', { kind: 'half', halfStart: '14:00' }))).status, 'Approved'); // 95.5 h, 2.5 of 5
  eq(w.jobTwice(D(10), '19:30', 'evening'), 1);
  const sH = ok(call(D(10), '20:00', 'requestShort', 'harsh', { kind: 'late', date: D(11), time: '11:00' })); ok(call(D(10), '20:10', 'decideShort', 'aakash', { id: sH.id, approve: true }));
  const sB = ok(call(D(10), '20:30', 'requestShort', 'bhawna', { kind: 'late', date: D(11), time: '10:00' }));     // Aakash does not see it until 10:40 next day
  // Pooja: Saturday, asked Thursday 22:00 = exactly 36 h before her duty start: Regular, but under 48 h: Aakash.
  const lp = ok(call(D(10), '22:00', 'submitLeave', 'pooja', lv([D(12)], 'Sick', 'Viral fever POOJA-C'))); eq(lp.status, 'Pending with Aakash');
  let reminders = 0;
  ['21:07', '22:07', '23:07'].forEach(t => { reminders += w.jobTwice(D(10), t, 'hourly').reminders; });
  const events = []; const at = (t, fn) => events.push({ t, fn, o: events.length });
  for (let h = 0; h < 24; h++) at(String(h).padStart(2, '0') + ':07', () => { reminders += w.jobTwice(D(11), String(h).padStart(2, '0') + ':07', 'hourly').reminders; });
  at('09:25', () => ok(call(D(11), '09:25', 'checkIn', 'neha', PIC)));
  at('09:30', () => ok(call(D(11), '09:30', 'checkIn', 'anita', PIC)));
  at('09:31', () => eq(ok(call(D(11), '09:31', 'checkIn', 'manish', PIC)).lateMinutes, 1));
  at('10:05', () => eq(ok(call(D(11), '10:05', 'checkIn', 'pooja', PIC)).lateMinutes, 5));
  // Bhawna arrives 50 min late while her request still waits: for now not informed (more than 30 min = a violation).
  at('10:20', () => { const r = ok(call(D(11), '10:20', 'checkIn', 'bhawna', PIC)); eq([r.lateMinutes, r.informed], [50, false]);
    const m = month(w, D(11), '10:25', 'bhawna'); eq([rules(m), m.bank.used], [['11:not-informed-over-30'], 40]); });
  // Aakash approves at 10:40: 30 min were informed (20 counted), the 20 min after the stated time are not informed (pass 1).
  at('10:40', () => { ok(call(D(11), '10:40', 'decideShort', 'aakash', { id: sB.id, approve: true }));
    const m = month(w, D(11), '10:41', 'bhawna'); eq([rules(m), m.bank.used, m.bank.passesUsed], [[], 40, 1]); });
  at('10:45', () => ok(call(D(11), '10:45', 'checkIn', 'muskan', PIC)));
  at('10:58', () => ok(call(D(11), '10:58', 'checkIn', 'vikas', PIC)));
  // Raunak: 35 min late, nobody told. He taps twice; the second tap overlaps the first.
  at('11:05', () => { let inner; const outer = call(D(11), '11:05', 'checkIn', 'raunak', PIC, { whileWaitingForLock: () => { inner = call(D(11), '11:05', 'checkIn', 'raunak', PIC); } });
    eq([inner.ok, inner.data.lateMinutes, outer.code], [true, 35, 'BLOCKED']); });
  at('11:10', () => { const r = ok(call(D(11), '11:10', 'checkIn', 'harsh', PIC)); eq([r.lateMinutes, r.informed], [40, true]); });               // informed 30, came after 40
  at('11:30', () => eq(ok(call(D(11), '11:30', 'decideLeave', 'aakash', { id: lp.id, approve: false, reason: 'Short of staff on Saturday NOTE-A1' })).status, 'Rejected'));
  at('12:00', () => { const o = {}; ok(call(D(11), '12:00', 'board', 'aakash')).people.forEach(p => { o[p.name] = [p.state, p.lateMinutes, p.halfDay]; });
    eq(o, { Neha: ['In', 0, ''], Vikas: ['In', 0, ''], Harsh: ['In', 40, ''], Raunak: ['In', 35, ''], Manish: ['In', 1, '14:00'], Muskan: ['In', 0, ''], Bhawna: ['In', 50, ''], Pooja: ['In', 5, ''], Anita: ['In', 0, ''] }); });
  // Harsh was late today, so Neha cannot go out (Sales, counted per day).
  at('12:10', () => eq(call(D(11), '12:10', 'goingOut', 'neha', { reason: 'Bank', expectedMinutes: 20 }).message, 'Not allowed: Harsh is off on 11 Dec — Sales needs 2 of Neha, Vikas, Harsh present.'));
  let oA, oM;
  at('12:15', () => { oA = ok(call(D(11), '12:15', 'goingOut', 'anita', { reason: 'Milk ANITA-C', expectedMinutes: 10 })); });
  at('12:16', () => ok(call(D(11), '12:16', 'decideOuting', 'aakash', { id: oA.id, approve: true })));
  at('12:28', () => eq(ok(call(D(11), '12:28', 'imBack', 'anita', { id: oA.id })).minutes, 12));
  at('12:30', () => ok(call(D(11), '12:30', 'confirmBack', 'aakash', { id: oA.id })));
  at('12:40', () => { oM = ok(call(D(11), '12:40', 'goingOut', 'muskan', { reason: 'Bank MUSKAN-C', expectedMinutes: 30 })); eq(call(D(11), '12:40', 'goingOut', 'muskan', { reason: 'Bank MUSKAN-C', expectedMinutes: 30 }).code, 'BLOCKED'); });
  at('12:42', () => ok(call(D(11), '12:42', 'decideOuting', 'aakash', { id: oM.id, approve: true })));
  at('14:00', () => eq(ok(call(D(11), '14:00', 'checkOut', 'manish')).earlyMinutes, 0));                                                          // his half day starts
  // Muskan forgot "I'm back"; Aakash closes it with the real time: 12:42-13:24 = 42 min, the whole outing from the bank (3.5).
  at('15:00', () => eq(ok(call(D(11), '15:00', 'confirmBack', 'aakash', { id: oM.id, correctedTime: '13:24' })).minutes, 42));
  let nv;
  at('15:30', () => { const a = { personId: 'neha', item: 'job-sheet', note: 'Job sheet 4471 not filled NOTE-N1', date: D(11) };
    const r1 = ok(call(D(11), '15:30', 'recordIncident', 'aakash', a)), r2 = ok(call(D(11), '15:31', 'recordIncident', 'aakash', a));           // sent twice (slow reply): one incident
    eq([r1.result, r2.repeated, r2.id === r1.id], ['violation', true, true]); });
  at('15:45', () => { nv = month(w, D(11), '15:45', 'neha').violations[0]; eq(nv.label, 'Recorded by Aakash: BytePhase job sheet');
    ok(call(D(11), '15:46', 'disputeViolation', 'neha', { id: nv.id, text: 'Filled at 15:20 NEHA-D1' })); eq(call(D(11), '15:47', 'disputeViolation', 'neha', { id: nv.id, text: 'again' }).code, 'BLOCKED'); });
  at('16:00', () => eq(ok(call(D(11), '16:00', 'recordIncident', 'aakash', { personId: 'vikas', item: 'chai-cup', note: 'Cup on the counter NOTE-V1', date: D(11) })).result, 'grace'));   // 1 of 2
  // Bhawna was late today, so Pooja cannot inform an early leaving (Calls, per day).
  at('16:30', () => eq(call(D(11), '16:30', 'requestShort', 'pooja', { kind: 'early', date: D(11), time: '18:30' }).message, 'Not allowed: Bhawna is off on 11 Dec — Calls needs 1 of Bhawna, Pooja present.'));
  at('17:00', () => ok(call(D(11), '17:00', 'decideDispute', 'varun', { id: nv.id, uphold: false, note: 'Sheet checked NOTE-V2' })));
  at('17:30', () => ok(call(D(11), '17:30', 'checkOut', 'anita')));
  at('18:30', () => { ok(call(D(11), '18:30', 'checkOut', 'neha')); ok(call(D(11), '18:30', 'checkOut', 'bhawna')); });
  // Pooja leaves 20 min early, nobody told; double tap, overlapping.
  at('18:40', () => { let inner; const outer = call(D(11), '18:40', 'checkOut', 'pooja', {}, { whileWaitingForLock: () => { inner = call(D(11), '18:40', 'checkOut', 'pooja'); } });
    eq([inner.data.earlyMinutes, outer.code], [20, 'BLOCKED']); });
  at('19:30', () => { ok(call(D(11), '19:30', 'checkOut', 'harsh')); ok(call(D(11), '19:30', 'checkOut', 'raunak')); eq(w.jobTwice(D(11), '19:30', 'evening'), 0); });
  at('19:45', () => ok(call(D(11), '19:45', 'checkOut', 'muskan')));                                                                              // Vikas forgets
  at('21:15', () => { const out = w.jobTwice(D(11), '21:15', 'endOfDay');
    eq(out.absent, []);
    eq(out.summary, ['On leave: Manish (half day)', 'Late: Harsh 40 min (in 11:10), Raunak 35 min (in 11:05), Bhawna 50 min (in 10:20)', 'Absent with no request: none', 'No check-out yet: Vikas']); });
  events.sort((a, b) => a.t < b.t ? -1 : a.t > b.t ? 1 : a.o - b.o).forEach(e => e.fn());
  for (let h = 0; h < 10; h++) reminders += w.jobTwice(D(12), String(h).padStart(2, '0') + ':07', 'hourly').reminders;
  // Reminders to Aakash, every 2 hours while a request waits (the job runs at :07):
  //   Bhawna's late request (20:30): 23:07, 01:07, 03:07, 05:07, 07:07, 09:07 = 6; Pooja's leave (22:00): 00:07 ... 10:07 = 6.
  // Owner, 20 Nov 2026 (after this simulation was written): no reminders between 00:00 and 06:00.
  // The night runs (00:07 ... 05:07) now send nothing; a waiting request reminds again from 06:07. 12 became 7.
  eq(reminders, 7);
  // Next morning.
  const a2 = ok(call(D(12), '10:00', 'approvals', 'aakash'));
  eq([a2.leaves.length, a2.absences.length, a2.outings.length, a2.outNow.length, a2.shorts.length, a2.dress.length], [0, 0, 0, 0, 0, 0]);
  eq(ok(call(D(12), '10:01', 'manualCheckOut', 'aakash', { personId: 'vikas', date: D(11), time: '20:00', reason: 'Forgot to check out' })).earlyMinutes, 0);
  const rv = month(w, D(12), '10:05', 'raunak').violations[0];
  ok(call(D(12), '10:06', 'disputeViolation', 'raunak', { id: rv.id, text: 'Bike puncture RAUNAK-D1' }));                                         // 23 h after it was recorded
  ok(call(D(12), '12:00', 'decideDispute', 'varun', { id: rv.id, uphold: true, note: 'No call was made NOTE-V3' }));
  // My month, by hand.
  const m = p => month(w, D(12), '12:30', p);
  eq([m('neha').bank.used, rules(m('neha')), m('neha').ladder.violations], [0, [], 0]);                                                           // the job-sheet violation was removed by Varun
  eq([m('vikas').bank.used, rules(m('vikas'))], [0, []]);
  eq([m('harsh').bank.used, m('harsh').bank.passesUsed, rules(m('harsh'))], [30, 1, []]);                                                         // 20 informed + 10 after the stated time
  eq([m('raunak').bank.used, m('raunak').bank.passesUsed, rules(m('raunak'))], [25, 0, ['11:not-informed-over-30(upheld)']]);
  eq([m('manish').leaves.total, m('manish').leaves.taken, m('manish').leaves.left, m('manish').bank.used], [2.5, 0.5, 2.5, 0]);
  eq([m('muskan').bank.used, m('muskan').bank.left], [42, 78]);
  eq([m('bhawna').bank.used, m('bhawna').bank.passesUsed, rules(m('bhawna'))], [40, 1, []]);
  eq([m('pooja').bank.used, m('pooja').bank.passesUsed, m('pooja').leaves.total], [20, 1, 2]);                                                    // the rejected leave is not counted
  eq([m('anita').bank.used, m('anita').leaves.total], [0, 4]);                                                                                     // 12 min out: free; 4 Sundays
  STAFF.forEach(p => eq(m(p).wouldBeDeducted.total, 0, p));
  // Alerts, by hand.
  eqAlerts(w.alerts(), {
    manish: { decision: 1, 'leave-tomorrow': 1 }, harsh: { decision: 1 }, bhawna: { violation: 1, decision: 1 }, pooja: { decision: 2 },
    raunak: { violation: 1, 'warn-v1': 1, dispute: 1 }, neha: { violation: 1, 'warn-v1': 1, dispute: 1 }, vikas: { incident: 1 }, anita: { out: 1 }, muskan: { out: 2 },
    aakash: { approval: 3, reminder: 7 /* was 12 before night reminders were switched off */, out: 3, violation: 2, 'missing-checkout': 1 }, varun: { violation: 3, dispute: 2, 'daily-summary': 1 } });
  // The Sheet: one row per real event, double taps included.
  eq(['LeaveRequests', 'ShortRequests', 'Outings', 'DayMinutes', 'Violations', 'Incidents', 'Thumbs'].map(t => w.sheet(t).length), [2, 2, 2, 6, 3, 2, 9]);
  eq([w.sheet('Punches').filter(p => p.kind === 'in').length, w.sheet('Punches').filter(p => p.kind === 'out').length], [9, 9]);
  privacy(w, [['MANISH-C', 'manish'], ['POOJA-C', 'pooja'], ['NOTE-A1', 'pooja'], ['ANITA-C', 'anita'], ['MUSKAN-C', 'muskan'], ['NOTE-N1', 'neha'], ['NEHA-D1', 'neha'], ['NOTE-V2', 'neha'],
    ['NOTE-V1', 'vikas'], ['RAUNAK-D1', 'raunak'], ['NOTE-V3', 'raunak']]);
});

// =====================================================================================================
// (b) + (c) November 2026 for all 11 people (5 Sundays: 1, 8, 15, 22, 29), then 1-3 December.
//     Every job runs every day: hourly (24 times), evening (19:30), end of day (21:15).
// =====================================================================================================
const SAL = { neha: 18000, vikas: 21000, harsh: 17000, raunak: 19500, manish: 16500, muskan: 9000, bhawna: 15000, pooja: 14400, anita: 9600, aakash: 30300, varun: 0 };
const ALLOW = { neha: 2110, vikas: 2120, harsh: 2130, raunak: 2140, manish: 2150, muskan: 0, bhawna: 2170, pooja: 2180, anita: 1190, aakash: 5110, varun: 0 };
const SECRETS = [['HARSH-R1', 'harsh'], ['OVR-1', 'harsh'], ['ANITA-R0', 'anita'], ['VIKAS-R1', 'vikas'], ['MANISH-R1', 'manish'], ['NOTE-P1', 'pooja'], ['NEHA-R1', 'neha'], ['ANITA-O1', 'anita'],
  ['RAUNAK-O1', 'raunak'], ['BHAWNA-R1', 'bhawna'], ['AAKASH-R1'], ['ANITA-R1', 'anita'], ['MUSKAN-R1', 'muskan'], ['MUSKAN-O1', 'muskan'], ['MANISH-R2', 'manish'], ['RAUNAK-R1', 'raunak'],
  ['NOTE-P2', 'pooja'], ['HARSH-O1', 'harsh'], ['NEHA-O1', 'neha'], ['VIKAS-D1', 'vikas'], ['NOTE-V1', 'vikas'], ['NEHA-R2', 'neha'], ['NOTE-P3', 'pooja'], ['POOJA-D1', 'pooja'], ['NOTE-V2', 'pooja'],
  ['HARSH-R2', 'harsh'], ['VIKAS-R2', 'vikas'], ['NEHA-R3', 'neha'], ['HARSH-R3', 'harsh'], ['MANISH-R3', 'manish'], ['POOJA-R1', 'pooja'], ['VIKAS-R3', 'vikas'], ['CORR-1']];

function runMonth(cached, twice) {
  const w = world({ cached, startDate: N(1), pay: id => ({ fixedSalary: SAL[id], targetAllowance: ALLOW[id], disciplineBonus: 500 }) });
  const { call, ok } = w; const S = {}; const ev = []; let order = 0;
  const at = (date, time, fn) => ev.push({ k: date + ' ' + time, o: order++, fn });
  const runJob = (d, t, name) => (twice ? w.jobTwice(d, t, name) : w.job(d, t, name));
  // ---- who is in on which day, and when (written from the story below, not read from the app) ----
  const noIn = {}, inAt = {}, outAt = {};
  const away = (p, ...dates) => dates.forEach(d => { noIn[p + d] = 1; });
  const IN = (p, d, t) => { inAt[p + d] = t; }, OUT = (p, d, t) => { outAt[p + d] = t; };
  const CLOSED = [N(10)];
  away('harsh', N(5), N(20), N(30), D(1)); away('vikas', N(11), N(12), N(13), N(27)); away('manish', N(4), N(12), N(25)); away('neha', N(19));
  away('raunak', N(17), N(24)); away('muskan', N(13), N(14), N(21)); away('bhawna', N(20), N(21), N(23), N(24)); away('pooja', N(30)); away('anita', N(18));
  IN('bhawna', N(2), '10:20'); IN('harsh', N(2), '11:20'); IN('neha', N(3), '09:55'); IN('vikas', N(3), '11:20'); IN('vikas', N(4), '11:20'); IN('vikas', N(5), '11:20');
  IN('muskan', N(5), '11:15'); IN('neha', N(6), '09:42'); IN('vikas', N(6), '11:20'); IN('manish', N(9), '09:38'); IN('vikas', N(9), '11:20'); IN('harsh', N(9), '11:20');
  OUT('anita', N(12), '17:10'); OUT('bhawna', N(16), '17:30'); IN('neha', N(17), '10:20'); IN('vikas', N(18), '11:40'); OUT('raunak', N(19), '18:45'); OUT('manish', N(20), null);
  IN('harsh', N(23), '11:20'); IN('pooja', N(23), '10:15'); OUT('neha', N(24), '18:00'); IN('harsh', N(25), '11:00'); OUT('neha', N(26), '14:00'); IN('muskan', N(26), '11:30'); IN('manish', N(27), '12:00');
  IN('vikas', D(1), '11:20');
  const DRESS = {}; DRESS['pooja' + N(13)] = DRESS['pooja' + N(27)] = { top: 'ok', trousers: 'ok', shoes: 'issue', belt: 'ok' };
  const allDays = []; for (let i = 1; i <= 30; i++) allDays.push(N(i)); for (let i = 1; i <= 3; i++) allDays.push(D(i));
  S.ins = 0; S.outs = 0; S.eod = {};
  allDays.forEach(d => {
    ROSTER.filter(r => r[2] === 'staff').forEach(([name, , , ds, de, off]) => {
      const p = name.toLowerCase();
      if (CLOSED.includes(d) || Cal.isRosterOff({ sundayOff: off }, d) || noIn[p + d]) return;
      S.ins++; const tin = inAt[p + d] || hm(ds, -2);
      at(d, tin, () => ok(call(d, tin, 'checkIn', p, Object.assign({}, PIC, DRESS[p + d] ? { dress: DRESS[p + d] } : {}))));
      if (outAt[p + d] === null) return;
      S.outs++; const tout = outAt[p + d] || hm(de, 1);
      at(d, tout, () => ok(call(d, tout, 'checkOut', p)));
    });
    for (let h = 0; h < 24; h++) { const t = String(h).padStart(2, '0') + ':07'; at(d, t, () => runJob(d, t, 'hourly')); }
    at(d, '19:30', () => runJob(d, '19:30', 'evening'));
    at(d, '21:15', () => { S.eod[d] = runJob(d, '21:15', 'endOfDay'); });
  });
  const X = (date, time, action, person, args, check) => at(date, time, () => { const r = call(date, time, action, person, typeof args === 'function' ? args() : args); if (check) check(r); else ok(r); });
  const save = key => r => { S[key] = ok(r); };
  const raw = key => r => { S[key] = r; };
  const short = (key, date, time, p, kind, forDate, t, apprDate, apprTime) => {
    X(date, time, 'requestShort', p, { kind, date: forDate, time: t }, save(key));
    X(apprDate, apprTime, 'decideShort', 'aakash', () => ({ id: S[key].id, approve: true }));
  };
  const outing = (key, date, p, reqT, apprT, backT, confT, reason, mins, by) => {
    X(date, reqT, 'goingOut', p, { reason, expectedMinutes: mins }, save(key));
    X(date, apprT, 'decideOuting', by || 'aakash', () => ({ id: S[key].id, approve: true }));
    X(date, backT, 'imBack', p, () => ({ id: S[key].id }), save(key + 'Back'));
    X(date, confT, 'confirmBack', by || 'aakash', () => ({ id: S[key].id }));
  };
  // ---- 30 Oct: set-up. Restrictions: R1 3-7 Nov no leave for Sales (Aakash); R2 16-18 Nov "+1 violation" for Repairing (Varun); R3 2 Nov no leave for Anita (Varun).
  const O30 = '2026-10-30';
  X(O30, '10:00', 'setShopPoint', 'varun', { samples: [1, 2, 3].map(() => ({ lat: 29.15, lng: 75.72 })) });
  X(O30, '11:00', 'saveRestriction', 'aakash', { from: N(3), to: N(7), note: 'Peak sales season', rule: 'no-leave', appliesTo: ['Neha', 'Vikas', 'Harsh'] }, save('R1'));
  X(O30, '11:05', 'saveRestriction', 'varun', { from: N(16), to: N(18), note: 'Stock audit', rule: 'violation', appliesTo: ['Raunak', 'Manish'] }, save('R2'));
  X(O30, '11:10', 'saveRestriction', 'varun', { from: N(2), to: N(2), note: 'Deep cleaning day', rule: 'no-leave', appliesTo: ['Anita'] }, save('R3'));
  X(O30, '11:15', 'saveRestriction', 'aakash', () => ({ id: S.R2.id, from: N(16), to: N(18), note: 'Stock audit', rule: 'violation', appliesTo: ['Raunak', 'Manish'], on: false }), raw('aakashR2'));
  X(O30, '12:00', 'previewLeave', 'harsh', lv([N(5)], 'Family function', 'Sister wedding HARSH-R1'), save('harshPrev'));
  X(O30, '12:01', 'submitLeave', 'harsh', lv([N(5)], 'Family function', 'Sister wedding HARSH-R1'), raw('harshBlocked'));
  X(O30, '12:30', 'overrideLeave', 'varun', { forPersonId: 'harsh', kind: 'full', dates: [N(5)], reasonCode: 'Family function', reasonText: 'Sister wedding HARSH-R1', overrideReason: 'Wedding in the family OVR-1' }, save('ovr'));
  X(O30, '12:40', 'previewLeave', 'anita', lv([N(2)], 'Personal work', 'Ration card ANITA-R0'), save('anitaPrev'));
  // ---- November ----
  short('sB2', N(1), '19:00', 'bhawna', 'late', N(2), '10:00', N(1), '19:10');            // Bhawna: will come 10:00 (30 min); she comes 10:20
  short('sH2', N(1), '20:00', 'harsh', 'late', N(2), '11:20', N(1), '20:10');             // Harsh: 50 min, informed
  X(N(2), '12:00', 'submitLeave', 'vikas', lv([N(11), N(12), N(13)], 'Travel', 'Trip to Jaipur VIKAS-R1'), save('L4'));   // 3 days in a row: Aakash, always
  X(N(2), '12:30', 'decideLeave', 'aakash', () => ({ id: S.L4.id, approve: true }));
  X(N(2), '13:00', 'goingOut', 'pooja', { reason: 'Tea', expectedMinutes: 10 }, raw('poojaOutBlocked'));                    // Bhawna was late today
  X(N(3), '19:00', 'submitLeave', 'manish', lv([N(4)], 'Family emergency', 'Father unwell MANISH-R1'), save('E1'));        // 14.5 h: emergency 1
  X(N(3), '19:20', 'decideLeave', 'aakash', () => ({ id: S.E1.id, approve: true }));
  X(N(4), '16:00', 'recordIncident', 'aakash', { personId: 'pooja', item: 'chai-cup', note: 'Cup left on desk NOTE-P1', date: N(4) }, save('inc1'));
  X(N(5), '10:00', 'submitLeave', 'neha', lv([N(10)], 'Personal work', 'Passport office NEHA-R1'), save('L1'));            // 119.5 h, 3 of 5: auto
  outing('oA', N(5), 'anita', '13:00', '13:01', '13:11', '13:15', 'Courier ANITA-O1', 10);                                  // 10 min: free
  X(N(6), '14:58', 'goingOut', 'raunak', { reason: 'Parts market RAUNAK-O1', expectedMinutes: 45 }, save('oR'));
  X(N(6), '15:00', 'decideOuting', 'aakash', () => ({ id: S.oR.id, approve: true }));
  X(N(6), '17:00', 'confirmBack', 'aakash', () => ({ id: S.oR.id, correctedTime: '15:51' }), save('oRclose'));              // he forgot "I'm back": 51 min
  short('sH9', N(8), '20:00', 'harsh', 'late', N(9), '11:20', N(8), '20:10');
  // Bhawna: Fri 20 - Tue 24, her roster Sunday (22nd) inside: 4 leave days, a run of 4: Aakash AND Varun.
  X(N(9), '10:30', 'submitLeave', 'bhawna', lv([N(20), N(21), N(22), N(23), N(24)], 'Family function', 'Cousin wedding BHAWNA-R1'), save('L12'));
  X(N(9), '10:45', 'approvals', 'aakash', {}, save('apprA1'));
  X(N(9), '11:00', 'decideLeave', 'aakash', () => ({ id: S.L12.id, approve: true }), save('L12a'));
  X(N(9), '11:05', 'approvals', 'aakash', {}, save('apprA2'));
  X(N(9), '11:06', 'approvals', 'varun', {}, save('apprV2'));
  X(N(9), '11:30', 'submitLeave', 'aakash', lv([N(14)], 'Personal work', 'Property papers AAKASH-R1'), save('LA'));         // Aakash's own leave: Varun
  X(N(9), '11:35', 'decideLeave', 'aakash', () => ({ id: S.LA.id, approve: true }), raw('selfApprove'));
  X(N(9), '11:45', 'decideLeave', 'varun', () => ({ id: S.LA.id, approve: true }));
  X(N(9), '12:00', 'submitLeave', 'anita', lv([N(18)], 'Personal work', 'Village visit ANITA-R1'), save('L15'));           // Anita: always Aakash; 5 Sundays + 1 = 6
  X(N(9), '12:10', 'submitLeave', 'muskan', lv([N(13), N(14)], 'Exam', 'College exam MUSKAN-R1'), save('L11'));            // recorded only
  X(N(9), '12:20', 'decideLeave', 'aakash', () => ({ id: S.L15.id, approve: true }));
  X(N(9), '18:00', 'setSetting', 'varun', { key: 'closedDays', value: [N(10)] });                                           // shop closed on the 10th, entered after Neha's leave was approved
  X(N(10), '09:00', 'decideLeave', 'varun', () => ({ id: S.L12.id, approve: true }), save('L12v'));
  outing('oM', N(11), 'muskan', '15:00', '15:02', '15:42', '15:45', 'Bank MUSKAN-O1', 30);                                  // 40 min: all from the bank
  X(N(11), '20:00', 'submitLeave', 'manish', lv([N(12)], 'Family emergency', 'Hospital visit MANISH-R2'), save('E2'));     // emergency 2
  X(N(11), '20:15', 'decideLeave', 'aakash', () => ({ id: S.E2.id, approve: true }));
  X(N(12), '11:00', 'submitLeave', 'raunak', lv([N(17)], 'Personal work', 'Bike service RAUNAK-R1'), save('L8'));          // inside R2: Aakash, +1 violation when granted
  X(N(12), '11:30', 'decideLeave', 'aakash', () => ({ id: S.L8.id, approve: true }));
  X(N(12), '12:00', 'board', 'aakash', {}, save('board12'));
  X(N(12), '12:30', 'goingOut', 'neha', { reason: 'Bank', expectedMinutes: 30 }, raw('nehaOutBlocked'));                   // Vikas is on leave
  X(N(12), '16:00', 'recordIncident', 'aakash', { personId: 'pooja', item: 'chai-cup', note: 'Cup on counter NOTE-P2', date: N(12) }, save('inc2'));
  X(N(13), '10:30', 'approvals', 'aakash', {}, save('apprDress'));
  X(N(13), '10:31', 'decideDress', 'aakash', () => ({ id: S.apprDress.dress[0].id, confirm: true }), save('dress1'));      // dress grace 1 of 1
  outing('oH', N(14), 'harsh', '13:00', '13:02', '13:14', '13:20', 'Lunch pickup HARSH-O1', 10, 'varun');                   // Aakash is on leave: Varun approves; 12 min free
  X(N(16), '10:00', 'previewLeave', 'pooja', lv([N(21)], 'Personal work', 'Shopping POOJA-R0'), save('poojaPrev'));        // Bhawna holds the 21st
  outing('oN', N(16), 'neha', '12:00', '12:02', '12:42', '12:45', 'Bank NEHA-O1', 40);
  X(N(16), '17:00', 'requestShort', 'bhawna', { kind: 'early', date: N(16), time: '17:30' }, save('sB16'));                // she leaves 17:30 while it still waits
  X(N(16), '18:10', 'myMonth', 'bhawna', { month: '2026-11' }, save('bhawnaMid'));
  X(N(16), '19:00', 'decideShort', 'aakash', () => ({ id: S.sB16.id, approve: true }));                                    // approved later = informed
  short('sN17', N(16), '20:00', 'neha', 'late', N(17), '10:15', N(16), '20:10');                                           // stated 45 min; she comes after 50
  X(N(18), '12:00', 'myMonth', 'vikas', { month: '2026-11' }, r => { S.vikasV = ok(r).violations; });
  X(N(18), '12:01', 'disputeViolation', 'vikas', () => ({ id: S.vikasV.filter(v => v.date === N(18))[0].id, text: 'Road blocked VIKAS-D1' }));
  X(N(18), '15:00', 'decideDispute', 'varun', () => ({ id: S.vikasV.filter(v => v.date === N(18))[0].id, uphold: true, note: 'No call was made NOTE-V1' }));
  X(N(18), '20:00', 'submitLeave', 'neha', lv([N(19)], 'Sick', 'High fever NEHA-R2'), save('L2'));                         // 13.5 h: emergency 1
  X(N(18), '20:20', 'decideLeave', 'aakash', () => ({ id: S.L2.id, approve: true }));
  X(N(19), '16:00', 'recordIncident', 'aakash', { personId: 'pooja', item: 'chai-cup', note: 'Cup again NOTE-P3', date: N(19) }, save('inc3'));   // 3rd: beyond the grace of 2
  X(N(19), '17:00', 'myMonth', 'pooja', { month: '2026-11' }, r => { S.poojaV = ok(r).violations; });
  X(N(19), '17:01', 'disputeViolation', 'pooja', () => ({ id: S.poojaV[0].id, text: 'Not my cup POOJA-D1' }));
  X(N(20), '10:00', 'decideDispute', 'varun', () => ({ id: S.poojaV[0].id, uphold: false, note: 'Checked camera NOTE-V2' }));
  // Harsh phones at 10:50 (duty started 10:30): Aakash enters it, "called – emergency"; told after duty start = unannounced.
  X(N(20), '11:15', 'submitLeave', 'aakash', lv([N(20)], 'Sick', 'Food poisoning HARSH-R2', { forPersonId: 'harsh', calledAt: '10:50' }), save('L7'));
  X(N(20), '11:16', 'decideLeave', 'aakash', () => ({ id: S.L7.id, approve: true }));
  X(N(20), '12:00', 'calendar', 'aakash', { month: '2026-11' }, save('cal'));
  X(N(20), '15:00', 'submitLeave', 'vikas', lv([N(27)], 'Personal work', 'Bank loan VIKAS-R2'), save('L5'));               // his 6th leave, and he has violations: Aakash
  X(N(20), '15:30', 'decideLeave', 'aakash', () => ({ id: S.L5.id, approve: true }));
  X(N(21), '10:00', 'manualCheckOut', 'aakash', { personId: 'manish', date: N(20), time: '18:30', reason: 'Forgot to check out' });
  short('sH23', N(22), '20:00', 'harsh', 'late', N(23), '11:20', N(22), '20:10');
  X(N(23), '09:00', 'submitLeave', 'neha', lv([N(26)], 'Personal work', 'School meeting NEHA-R3', { kind: 'half', halfStart: '14:00' }), save('L3'));   // 72.5 h, 3.5 of 5, no violation: auto
  X(N(24), '10:00', 'submitLeave', 'harsh', lv([N(30), D(1)], 'Travel', 'Village trip HARSH-R3'), save('L16'));            // crosses the month end; he has a violation: Aakash
  X(N(24), '10:20', 'decideLeave', 'aakash', () => ({ id: S.L16.id, approve: true }));
  short('sN24', N(24), '15:00', 'neha', 'early', N(24), '18:00', N(24), '15:10');
  X(N(24), '15:05', 'effect', 'neha', { kind: 'early', time: '18:00', date: N(24) }, save('nehaEffect'));
  short('sH25', N(24), '20:00', 'harsh', 'late', N(25), '11:00', N(24), '20:10');
  X(N(24), '20:05', 'effect', 'harsh', { kind: 'late', time: '11:00', date: N(25) }, save('harshEffect'));
  X(N(24), '21:30', 'submitLeave', 'manish', lv([N(25)], 'Family emergency', 'Father admitted MANISH-R3'), save('E3'));    // emergency 3
  X(N(24), '21:40', 'decideLeave', 'aakash', () => ({ id: S.E3.id, approve: true }));
  X(N(25), '10:00', 'approvals', 'aakash', {}, save('apprAbs'));
  X(N(25), '10:01', 'keepAbsent', 'aakash', () => ({ id: S.apprAbs.absences.filter(a => a.name === 'Raunak')[0].id }));
  X(N(25), '10:02', 'approvals', 'aakash', {}, save('apprAbs2'));
  X(N(25), '12:00', 'submitLeave', 'pooja', lv([N(28)], 'Personal work', 'Cousin visit POOJA-R1'), save('L13'));           // 70 h, clean month: auto
  X(N(26), '11:00', 'editLeave', 'pooja', () => Object.assign({ id: S.L13.id }, lv([N(30)], 'Personal work', 'Cousin visit POOJA-R1')), save('L13e'));   // an edit after approval: back to Aakash
  X(N(26), '11:30', 'decideLeave', 'aakash', () => ({ id: S.L13.id, approve: true }));
  X(N(27), '10:30', 'approvals', 'aakash', {}, save('apprDress2'));
  X(N(27), '10:31', 'decideDress', 'aakash', () => ({ id: S.apprDress2.dress[0].id, confirm: true }), save('dress2'));     // 2nd dress: violation
  // ---- month end, lock, the first days of December ----
  STAFF.forEach(p => X(N(30), '22:00', 'myMonth', p, { month: '2026-11' }, save('m_' + p)));
  X(N(30), '22:10', 'monthReport', 'aakash', { month: '2026-11' }, save('report'));
  X(N(30), '22:11', 'lockMonth', 'aakash', { month: '2026-11' }, raw('earlyLock'));
  X(D(1), '10:00', 'lockMonth', 'aakash', { month: '2026-11' }, save('lock1'));
  X(D(1), '10:01', 'lockMonth', 'aakash', { month: '2026-11' }, raw('lock1again'));
  X(D(2), '10:00', 'lockMonth', 'varun', { month: '2026-11' }, save('lock2'));
  X(D(2), '11:00', 'submitLeave', 'vikas', lv([D(9)], 'Personal work', 'Car service VIKAS-R3'), save('LD'));               // new month, counters at zero: auto
  X(D(2), '11:30', 'excuseAbsence', 'aakash', () => ({ id: S.apprAbs.absences.filter(a => a.name === 'Raunak')[0].id, reason: 'He had phoned' }), raw('excuseLocked'));
  X(D(2), '11:31', 'recordIncident', 'aakash', { personId: 'pooja', item: 'phone', note: 'late entry', date: N(28) }, raw('incidentLocked'));
  X(D(3), '10:00', 'addCorrection', 'aakash', { month: '2026-11', personId: 'raunak', note: '24 Nov: had informed by phone CORR-1' });
  STAFF.forEach(p => { X(D(3), '22:00', 'myMonth', p, { month: '2026-11' }, save('m2_' + p)); X(D(3), '22:01', 'myMonth', p, { month: '2026-12' }, save('d_' + p)); });
  X(D(3), '22:10', 'monthReport', 'varun', { month: '2026-11' }, save('report2'));
  X(D(3), '22:11', 'myMonth', 'neha', { month: '2026-11', personId: 'vikas' }, raw('peek'));
  ev.sort((a, b) => a.k < b.k ? -1 : a.k > b.k ? 1 : a.o - b.o).forEach(e => e.fn());
  return { w, S };
}

test('one calendar month (November 2026, 5 Sundays) for all 11 people, every job every day, then 1-3 December: hand count', () => {
  const { w, S } = runMonth(true, true);          // with the cache; every job is run twice and must change nothing the second time
  const M = p => S['m_' + p];
  const L = m => [m.leaves.total, m.leaves.taken, m.leaves.left, m.leaves.rosterSundays, m.leaves.emergencies, m.leaves.daysCut];
  const B = m => [m.bank.used, m.bank.left, m.bank.beyond, m.bank.passesUsed];
  const T = m => m.wouldBeDeducted.total;

  // ---- things that must be refused ----
  eq(S.harshPrev.decision, 'blocked'); eq(S.harshPrev.reasons, ['Not allowed: no leave during this period (Peak sales season).']); eq(S.harshBlocked.code, 'BLOCKED');
  eq(S.anitaPrev.reasons, ['Not allowed: no leave during this period (Deep cleaning day).']);                    // Anita only when she is ticked
  eq(S.aakashR2.code, 'FORBIDDEN');                                                                                // Aakash cannot switch off Varun's restriction
  eq(S.poojaOutBlocked.message, 'Not allowed: Bhawna is off on 2 Nov — Calls needs 1 of Bhawna, Pooja present.');
  eq(S.nehaOutBlocked.message, 'Not allowed: Vikas is off on 12 Nov — Sales needs 2 of Neha, Vikas, Harsh present.');
  eq(S.poojaPrev.reasons, ['Not allowed: Bhawna is off on 21 Nov — Calls needs 1 of Bhawna, Pooja present.']);
  eq(S.selfApprove.code, 'FORBIDDEN'); eq(S.earlyLock.code, 'BLOCKED'); eq(S.lock1again.code, 'BLOCKED');
  eq(S.excuseLocked.code, 'BLOCKED'); eq(S.incidentLocked.code, 'BLOCKED'); eq(S.peek.code, 'FORBIDDEN');
  // ---- routes ----
  eq([S.ovr.status, S.L4.status, S.E1.status, S.L1.status, S.L12.status, S.LA.status, S.L15.status, S.L11.status],
    ['Approved', 'Pending with Aakash', 'Pending with Aakash', 'Approved', 'Special – waiting', 'Pending with Varun', 'Pending with Aakash', 'Recorded']);
  eq([S.E2.status, S.L8.status, S.L2.status, S.L7.status, S.L5.status, S.L3.status, S.L16.status, S.E3.status, S.L13.status, S.L13e.status, S.LD.status],
    ['Pending with Aakash', 'Pending with Aakash', 'Pending with Aakash', 'Pending with Aakash', 'Pending with Aakash', 'Approved', 'Pending with Aakash', 'Pending with Aakash', 'Approved', 'Pending with Aakash', 'Approved']);
  like(S.L8.warnings.join('|'), /Restricted period \(Stock audit\): leave here counts as 1 violation/);
  like(S.L7.warnings.join('|'), /unannounced leave and counts as 1 violation/);
  like(S.E3.warnings.join('|'), /emergency no\. 3 this month: 1 violation, and it is not a free leave/);
  eq(S.L12.warnings, ['Above the 5 free leaves this month by 1.']); eq(S.L15.warnings, ['Above the 5 free leaves this month by 1.']);
  // ---- special approval: both approvers' status ----
  eq(S.apprA1.leaves.map(l => [l.name, l.status, l.waitingFor]), [['Bhawna', 'Special – waiting', 'Aakash and Varun']]);
  eq(S.apprA1.leaves[0].context.ruleResult, ['More than 3 days in a row: needs Aakash and Varun.', 'Above the 5 free leaves this month by 1.']);
  eq(S.apprA1.leaves[0].context.month, { leaves: 2, free: 5, emergencies: 0, bankLeft: 80, violations: 0 });     // 2 roster Sundays; 40 min used on the 2nd
  eq(S.apprA1.leaves[0].context.awayToo.map(a => a.name + ' ' + a.date.slice(8) + ' ' + a.why), ['Neha 22 roster Sunday', 'Manish 22 roster Sunday', 'Anita 22 roster Sunday']);
  eq([S.L12a.status, S.L12a.approvals], ['Special – waiting', { aakash: 'yes', varun: '' }]);
  eq(S.apprA2.leaves, []); eq(S.apprV2.leaves.map(l => [l.name, l.waitingFor]), [['Bhawna', 'Varun']]); eq(S.L12v.status, 'Approved');
  // ---- small results on the way ----
  eq([S.oABack.minutes, S.oRclose.minutes, S.oMBack.minutes, S.oHBack.minutes, S.oNBack.minutes], [10, 51, 40, 12, 40]);
  eq([S.inc1.result, S.inc2.result, S.inc3.result, S.inc3.count, S.dress1.result, S.dress2.result], ['grace', 'grace', 'violation', 3, 'grace', 'violation']);
  eq([rules(S.bhawnaMid), S.bhawnaMid.bank.used], [['16:not-informed-over-30'], 100]);                           // while her request waits (assumption 12)
  // Neha has 23 min left and asks to leave 30 min early: 7 beyond = 7 x 18000/30/9/60 = Rs 7.8
  eq(S.nehaEffect.lines[0], 'This uses the last 23 min of your bank. 7 min are beyond the bank: ≈ Rs 8 would be deducted.');
  eq(S.harshEffect.lines, ['The bank is exhausted: these 20 min ≈ Rs 21 would be deducted.', '100 more min beyond the bank = 1 violation.']);
  eq(Object.fromEntries(S.board12.people.map(p => [p.name, p.state])), { Neha: 'In', Vikas: 'On leave', Harsh: 'In', Raunak: 'In', Manish: 'On leave', Muskan: 'In', Bhawna: 'In', Pooja: 'In', Anita: 'In' });
  eq(S.apprAbs.absences.map(a => [a.name, a.dates]), [['Raunak', [N(24)]]]); eq(S.apprAbs2.absences, []);

  // ---- MY MONTH, by hand ---------------------------------------------------------------------------
  // NEHA (Rs 18,000; roster 15, 22). Leaves: 10th (shop closed: not counted), 19th emergency, 26th half = 1.5; total 3.5, left 1.5, emergencies 1.
  //   Bank: 3rd 25 late (15, pass 1) + 6th 12 late (2, pass 2) + 16th out 40 + 17th 50 late, stated 45 (35 informed + 5, pass 3) + 24th 30 early (23 + 7 beyond) = 120, beyond 7.
  //   Money: 7 x 1.111 = Rs 8. Violations 0.
  eq(L(M('neha')), [3.5, 1.5, 1.5, 2, 1, 0]); eq(B(M('neha')), [120, 0, 7, 3]); eq(rules(M('neha')), []); eq(T(M('neha')), 8);
  eq(M('neha').wouldBeDeducted.lines, ['7 min beyond bank × Rs 1.11 = Rs 8']);
  eq(M('neha').bank.days.map(d => [d.date.slice(8), d.kind, d.minutes, d.counted, d.fromBank]), [['03', 'late', 25, 15, 15], ['06', 'late', 12, 2, 2], ['16', 'out', 40, 40, 40], ['17', 'late', 50, 40, 40], ['24', 'early', 30, 30, 23]]);
  // VIKAS (Rs 21,000; roster 1, 8). Leaves 11-13 + 27 = 4; total 6, 1 day above = Rs 700.
  //   Bank: 3, 4, 5, 6 Nov 20 min not informed (passes 1-3, the 4th), 9th the 5th = VIOLATION, 18th 40 min not informed = VIOLATION (upheld). 5 x 10 + 30 = 80.
  eq(L(M('vikas')), [6, 4, 0, 2, 0, 1]); eq(B(M('vikas')), [80, 40, 0, 3]); eq(rules(M('vikas')), ['09:not-informed-beyond-passes', '18:not-informed-over-30(upheld)']); eq(T(M('vikas')), 700);
  eq(M('vikas').wouldBeDeducted.lines, ['6 leaves − 5 free = 1 day(s) × Rs 700 = Rs 700']);
  eq([M('vikas').ladder.violations, M('vikas').ladder.bonusLost, M('vikas').ladder.targetAllowanceLost, M('vikas').ladder.notice], [2, true, true, false]);
  // HARSH (Rs 17,000; roster 1, 8). Leaves: 5th (Varun's override), 20th (unannounced), 30th (of 30 Nov - 1 Dec) = 3; total 5, left 0.
  //   Bank: 2nd, 9th, 23rd 50 min informed (40 each = 120), 14th out 12 (free), 25th 30 informed (20 beyond = Rs 21). Violations: unannounced leave.
  eq(L(M('harsh')), [5, 3, 0, 2, 0, 0]); eq(B(M('harsh')), [120, 0, 20, 0]); eq(rules(M('harsh')), ['20:unannounced-leave']); eq(T(M('harsh')), 21);
  eq([M('harsh').ladder.violations, M('harsh').ladder.recordOnly, M('harsh').ladder.bonusLost], [1, true, false]);
  // RAUNAK (Rs 19,500; roster 1, 8). Leaves: 17th, 24th (absent, no request) = 2; total 4, left 1.
  //   Bank: 6th out 51 + 19th left 45 min early, not informed = 96. Violations: restricted period (17th), not informed over 30 (19th), absent (24th) = 3: notice.
  eq(L(M('raunak')), [4, 2, 1, 2, 0, 0]); eq(B(M('raunak')), [96, 24, 0, 0]); eq(rules(M('raunak')), ['17:leave-in-restricted-period', '19:not-informed-over-30', '24:absent-no-request']); eq(T(M('raunak')), 0);
  eq([M('raunak').ladder.violations, M('raunak').ladder.bonusLost, M('raunak').ladder.notice], [3, true, true]);
  // MANISH (Rs 16,500; roster 15, 22). Emergencies on the 4th, 12th, 25th: the 3rd is a violation and 1 day cut (Rs 550), outside the 5.
  //   27th: 150 min late, not informed = half day (0.5) + violation; nothing from the bank. In the 5: 2 + 2 + 0.5 = 4.5.
  eq(L(M('manish')), [4.5, 2.5, 0.5, 2, 3, 1]); eq(B(M('manish')), [0, 120, 0, 0]); eq(rules(M('manish')), ['25:emergency-beyond-2', '27:not-informed-over-30']); eq(T(M('manish')), 550);
  eq(M('manish').leaves.autoHalfDays, [{ date: N(27), minutes: 150, amount: 0.5 }]);
  // MUSKAN (intern, records only). Leaves 13, 14 + absent 21st = 3. Bank: 5th 30 late (20, pass 1) + 11th out 40 + 26th 45 late (35) = 95. Never a violation.
  eq(L(M('muskan')), [3, 3, 2, 0, 0, 0]); eq(B(M('muskan')), [95, 25, 0, 1]); eq(rules(M('muskan')), []); eq([M('muskan').onPayroll, T(M('muskan'))], [false, 0]);
  // BHAWNA (Rs 15,000; roster 15, 22). Leave 20-24 with her Sunday inside = 4; total 6, 1 day above = Rs 500.
  //   Bank: 2nd 50 late, stated 30 (20 informed + 20, pass 1) + 16th 60 early (approved later) = 100. Violations 0.
  eq(L(M('bhawna')), [6, 4, 0, 2, 0, 1]); eq(B(M('bhawna')), [100, 20, 0, 1]); eq(rules(M('bhawna')), []); eq(T(M('bhawna')), 500);
  // POOJA (Rs 14,400; roster 1, 8). Leave 30th (moved from the 28th) = 1; total 3. Bank: 23rd 15 late (5, pass 1).
  //   Violations: 3rd chai cup (removed by Varun), 2nd dress on the 27th (stands) = 1.
  eq(L(M('pooja')), [3, 1, 2, 2, 0, 0]); eq(B(M('pooja')), [5, 115, 0, 1]); eq(rules(M('pooja')), ['27:manual:dress']); eq(T(M('pooja')), 0);
  eq(M('pooja').violations[0].label, 'Recorded by Aakash: Dress (Mon–Sat)');
  // ANITA (Rs 9,600, 8 h). 5 Sundays = all 5 leaves; the 18th is the 6th = Rs 320. Bank: 5th out 10 (free), 12th left 20 min early (pass 1).
  eq(L(M('anita')), [6, 1, 0, 5, 0, 1]); eq(B(M('anita')), [20, 100, 0, 1]); eq(rules(M('anita')), []); eq(T(M('anita')), 320);
  // The shop: 9 standing violations, Rs 2,099.
  eq(STAFF.reduce((s, p) => s + M(p).violations.length, 0), 9); eq(STAFF.reduce((s, p) => s + T(M(p)), 0), 2099);
  STAFF.forEach(p => eq(M(p).wouldBeDeducted.label, 'Estimate as per company rules. Final salary is decided by management.', p));

  // ---- the evening job on some days ----
  eq(S.eod[N(1)].summary, ['On leave: none', 'Late: none', 'Absent with no request: none', 'No check-out yet: none']);
  eq(S.eod[N(10)].absent, []);                                                                                     // shop closed: nobody is absent
  eq(S.eod[N(18)].summary, ['On leave: Anita', 'Late: Vikas 40 min (in 11:40)', 'Absent with no request: none', 'No check-out yet: none']);
  eq(S.eod[N(20)].summary, ['On leave: Harsh, Bhawna', 'Late: none', 'Absent with no request: none', 'No check-out yet: Manish']);
  eq([S.eod[N(21)].absent, S.eod[N(24)].absent, S.eod[N(29)].absent, S.eod[D(1)].absent], [['Muskan'], ['Raunak'], [], []]);
  // ---- calendar (asked on the 20th) ----
  const day = n => S.cal.days[n - 1];
  eq([day(1).sunday, day(1).entries.map(e => e.name), day(1).risk], [1, ['Vikas', 'Harsh', 'Raunak', 'Pooja', 'Anita'], ['Sales', 'Calls', 'Repairing', 'Repair pool']]);
  eq(day(5).restrictions, [{ note: 'Peak sales season', rule: 'no-leave' }]); eq(day(17).restrictions, [{ note: 'Stock audit', rule: 'violation' }]);
  eq([day(12).entries.map(e => e.name + ':' + e.status), day(12).risk], [['Vikas:Approved', 'Manish:Approved'], ['Sales', 'Repairing', 'Repair pool']]);
  eq([day(21).entries.map(e => e.name), day(21).risk], [['Bhawna'], ['Calls']]);
  eq([day(29).sunday, day(29).entries.map(e => e.name + ':' + e.kind), day(29).risk], [5, ['Anita:roster'], []]);  // 5th Sunday: a working day for all but Anita
  // ---- month report, lock, correction ----
  eq([S.report.locked, S.report.people.length, S.report.lockConfirmedBy], [false, 9, []]);
  eq(S.report.overrides, [{ personId: 'harsh', name: 'Harsh', dates: [N(5)], reason: 'Wedding in the family OVR-1' }]);
  STAFF.forEach((p, i) => eq(JSON.stringify(Object.assign({}, S.report.people[i], { violations: [] })), JSON.stringify(Object.assign({}, M(p), { violations: [] })), 'report row ' + p));
  eq(S.lock1, { month: '2026-11', locked: false, waitingFor: ['Varun'] }); eq(S.lock2, { month: '2026-11', locked: true });
  eq([S.report2.locked, S.report2.lockedBy, S.report2.people.length], [true, 'varun', 9]);
  eq(S.report2.corrections.map(c => [c.name, c.note, c.by]), [['Raunak', '24 Nov: had informed by phone CORR-1', 'Aakash']]);
  // The locked month is unchanged, to the last value, three days into December.
  STAFF.forEach(p => { const after = Object.assign({}, S['m2_' + p]); eq(after.locked, true, p); delete after.locked; eq(JSON.stringify(after), JSON.stringify(M(p)), 'locked page ' + p); });

  // ---- DECEMBER 1-3: counters at zero, the last 3 months in view ----
  const Dm = p => S['d_' + p];
  // Vikas: roster 6, 13 Dec + the 9th (auto-approved: November's violations do not count) = 3; 1 Dec 20 min late = pass 1 of the new month, 10 min.
  eq(L(Dm('vikas')), [3, 1, 2, 2, 0, 0]); eq(B(Dm('vikas')), [10, 110, 0, 1]); eq(rules(Dm('vikas')), []);
  eq(Dm('vikas').last3, [{ month: '2026-10', violations: 0, stage: 'none' }, { month: '2026-11', violations: 2, stage: 'bonus and allowance' }, { month: '2026-12', violations: 0, stage: 'none' }]);
  // Harsh: the leave that crossed the month end: 1 Dec counts in December (roster 6, 13 + 1 = 3).
  eq(L(Dm('harsh')), [3, 1, 2, 2, 0, 0]); eq(B(Dm('harsh')), [0, 120, 0, 0]); eq(Dm('harsh').last3[1], { month: '2026-11', violations: 1, stage: 'record only' });
  eq(L(Dm('raunak')), [2, 0, 3, 2, 0, 0]); eq(Dm('raunak').last3[1], { month: '2026-11', violations: 3, stage: 'notice' }); eq(Dm('raunak').ladder.violations, 0);
  eq(L(Dm('manish')), [2, 0, 3, 2, 0, 0]); eq(Dm('manish').last3[1].stage, 'bonus and allowance');
  eq(L(Dm('neha')), [2, 0, 3, 2, 0, 0]); eq(B(Dm('neha')), [0, 120, 0, 0]);
  eq(L(Dm('anita')), [4, 0, 1, 4, 0, 0]);                                                                         // 4 Sundays in December: 1 weekday free
  eq(L(Dm('muskan')), [0, 0, 5, 0, 0, 0]); eq(L(Dm('bhawna')), [2, 0, 3, 2, 0, 0]); eq(L(Dm('pooja')), [2, 0, 3, 2, 0, 0]);
  STAFF.forEach(p => eq([Dm(p).violations.length, Dm(p).wouldBeDeducted.total, Dm(p).locked], [0, 0, undefined], p));

  // ---- ALERTS for the whole run, by hand (kind: how many) ----
  // Left out (the hand count expects them, the app does not send them yet): Muskan's evening reminder for the 13th (R8-10),
  // and the going-out alerts to Varun on the 14th, when Aakash is on leave (R8-3).
  eqAlerts(w.alerts(), {
    // Neha: decisions: leave 10th, late 17th, leave 19th (waiting, approved), half day, early 24th = 6. Evening reminders: for the 10th and for the 26th (the 19th was approved after the evening job).
    neha: { decision: 6, 'leave-tomorrow': 2, out: 1, 'warn-bank80': 1, 'warn-passes': 1, 'warn-bank0': 1 },
    vikas: { decision: 5, 'warn-passes': 1, violation: 2, 'warn-v1': 1, 'leave-tomorrow': 2, 'warn-v2': 1, dispute: 1 },
    // Harsh: decisions: the override 1 + 4 late requests + the unannounced leave (waiting, approved) 2 + the month-end leave 2 = 9. Evening reminders: for the 5th and the 30th.
    harsh: { decision: 9, 'leave-tomorrow': 2, out: 1, violation: 1, 'warn-v1': 1, 'warn-bank0': 1 },
    raunak: { out: 2, decision: 2, violation: 3, 'warn-v1': 1, 'leave-tomorrow': 1, 'warn-bank80': 1, 'warn-v2': 1 },
    manish: { decision: 6, 'leave-tomorrow': 1, 'warn-emergency': 1, violation: 2, 'warn-v1': 1, 'warn-v2': 1 },   // only the 1st emergency was approved before the evening job
    muskan: { decision: 1, out: 1 },
    bhawna: { decision: 4, violation: 1, 'warn-bank80': 1, 'warn-v1': 1, 'leave-tomorrow': 1 },                    // the violation of the 16th stood from 17:30 to 19:00 (assumption 12)
    pooja: { incident: 3, violation: 2, 'warn-v1': 1, dispute: 1, decision: 2, 'leave-tomorrow': 1 },
    anita: { out: 1, decision: 2, 'leave-tomorrow': 1 },
    // Aakash: 20 requests needing him (8 late / early, 11 leaves incl. the edit, his own entry for Harsh), 9 going-out alerts, 8 automatic violations, ...
    aakash: { override: 1, approval: 20, out: 9, violation: 8, decision: 2, dress: 2, 'leave-tomorrow': 1, 'missing-checkout': 1, absent: 2, month: 1 },
    // Varun: special approval + Aakash's leave; 10 reminders for the special approval (9 Nov 13:07 to 10 Nov 07:07, every 2 h); 10 violations; 2 disputes; 2 absences; Raunak's notice stage; 33 daily summaries.
    varun: { 'daily-summary': 33, approval: 2, violation: 10, reminder: 8 /* was 10 before the owner switched night reminders (00:00-06:00) off */, dispute: 2, absent: 2, 'notice-stage': 1, month: 1 },
  }, [['muskan', 'leave-tomorrow'], ['varun', 'out']]);

  // ---- THE SHEET: exactly one row per real event ----
  const rows = t => w.sheet(t).length;
  eq(rows('LeaveRequests'), 20);        // 18 requests + 2 automatic absences (Muskan 21st, Raunak 24th); refused ones leave no row
  eq(w.sheet('LeaveRequests').map(r => r.status).sort().join(','), Array(17).fill('Approved').concat(['Absent – unannounced', 'Recorded', 'Recorded']).sort().join(','));
  eq([w.sheet('Punches').filter(p => p.kind === 'in').length, w.sheet('Punches').filter(p => p.kind === 'out').length], [S.ins, S.outs + 1]);   // + Manish's check-out entered by Aakash
  eq([S.ins, S.outs], [246, 245]);
  eq(rows('Thumbs'), 246); eq(rows('DayMinutes'), 28); eq(rows('Outings'), 5); eq(rows('ShortRequests'), 8); eq(rows('Incidents'), 5); eq(rows('Restrictions'), 3);
  eq(rows('Violations'), 11);           // 9 standing + Bhawna's (withdrawn) + Pooja's chai cup (removed by Varun)
  eq(rows('MonthSheet'), 11);           // Aakash's confirmation + 9 people + 1 correction
  ['LeaveRequests', 'Punches', 'DayMinutes', 'Outings', 'ShortRequests', 'Incidents', 'Violations', 'Notifications', 'Audit', 'MonthSheet'].forEach(t => { const ids = w.sheet(t).map(r => r.id); eq(new Set(ids).size, ids.length, 'ids in ' + t); });
  eq(w.sheet('Punches').filter(p => p.enteredBy).map(p => [p.personId, p.date, p.flag]), [['manish', N(20), 'entered-by-manager']]);
  eq(w.sheet('LeaveRequests').filter(r => r.enteredBy && r.enteredBy !== 'system').map(r => [r.personId, r.enteredBy]), [['harsh', 'varun'], ['harsh', 'aakash']]);

  // ---- privacy: 3,000+ replies to staff phones ----
  assert.ok(w.staffReplies.length > 500);
  privacy(w, SECRETS, SAL); privacy(w, [], ALLOW);
});

test('the same month gives the same Sheet, cell for cell, with the cache on and off, and with every job run twice', () => {
  const a = runMonth(true, true), b = runMonth(false, false), c = runMonth(true, false);
  Object.keys(TABS).forEach(tab => { eq(JSON.stringify(b.w.g.tabs[tab]), JSON.stringify(c.w.g.tabs[tab]), 'cache on / off: ' + tab); eq(JSON.stringify(a.w.g.tabs[tab]), JSON.stringify(c.w.g.tabs[tab]), 'jobs twice / once: ' + tab); });
});

// =====================================================================================================
// Edges of the leave rules, through the API (both directions).
// =====================================================================================================
test('notice, run and quota edges through the API', () => {
  const w = world({ startDate: D(1) }), { call, ok } = w;
  const pv = (d, t, dates, p, extra) => { const r = ok(call(d, t, 'previewLeave', p || 'harsh', lv(dates, 'Personal work', 'x', extra))); return [r.type, r.decision, r.run]; };
  // Harsh, duty 10:30, leave on Thu 10 Dec.
  eq(pv(D(8), '10:30', [D(10)]), ['Regular', 'auto', 1]);          // exactly 48 h
  eq(pv(D(8), '10:31', [D(10)]), ['Regular', 'aakash', 1]);        // 47 h 59
  eq(pv(D(8), '22:30', [D(10)]), ['Regular', 'aakash', 1]);        // exactly 36 h
  eq(pv(D(8), '22:31', [D(10)]), ['Emergency', 'aakash', 1]);
  eq(pv(D(10), '07:30', [D(10)]), ['Emergency', 'aakash', 1]);     // exactly 3 h
  eq(pv(D(10), '07:31', [D(10)]), ['Unannounced', 'aakash', 1]);
  // A run over his roster Sunday (6 Dec): the Sunday does not add to the length and does not break the run.
  eq(pv(D(1), '10:00', [D(5), D(6), D(7)]), ['Regular', 'auto', 2]);
  eq(pv(D(1), '10:00', [D(4), D(5), D(6), D(7)]), ['Regular', 'aakash', 3]);
  eq(pv(D(1), '10:00', [D(3), D(4), D(5), D(6), D(7)]), ['Regular', 'special', 4]);
  // Anita, December (4 Sundays): 1 weekday free, the 2nd is above the 5.
  eq(ok(call(D(1), '10:00', 'previewLeave', 'anita', lv([D(10)]))).quota, { total: 5, left: 0, daysAboveQuota: 0 });
  eq(ok(call(D(1), '10:00', 'previewLeave', 'anita', lv([D(10), D(11)]))).quota, { total: 6, left: 0, daysAboveQuota: 1 });
  // Harsh: 2 roster Sundays + 2 + 1 = 5 are auto-approved one after another; the 6th goes to Aakash.
  const a = ok(call(D(1), '10:00', 'submitLeave', 'harsh', lv([D(15), D(16)]))), b = ok(call(D(1), '10:01', 'submitLeave', 'harsh', lv([D(22)]))), c = ok(call(D(1), '10:02', 'submitLeave', 'harsh', lv([D(24)])));
  eq([a.status, b.status, c.status, c.warnings], ['Approved', 'Approved', 'Pending with Aakash', ['Above the 5 free leaves this month by 1.']]);
  // Split requests are one run: 15-16 approved, 17-18 added = 4 in a row = special.
  eq(pv(D(2), '10:00', [D(17), D(18)]), ['Regular', 'special', 4]);
  // He cancels the 22nd before it starts: it no longer counts.
  ok(call(D(10), '10:00', 'cancelLeave', 'harsh', { id: b.id }));
  const m = month(w, D(10), '10:05', 'harsh'); eq([m.leaves.total, m.leaves.taken, m.leaves.left], [4, 2, 1]);
  eq(['LeaveRequests', 'Violations'].map(t => w.sheet(t).length), [3, 0]);
});

// =====================================================================================================
// Flows this round found broken on the code as it stood at the start of the review, which were fixed while the
// review ran (round 7 reported the same ones independently). Kept here as passing checks of those fixes.
// =====================================================================================================
const plainDay = (w, d, away) => ROSTER.filter(r => r[2] === 'staff').forEach(([name, , , ds, de, off]) => { const p = name.toLowerCase();
  if ((away || []).indexOf(p) !== -1 || Cal.isRosterOff({ sundayOff: off }, d)) return; w.ok(w.call(d, hm(ds, -1), 'checkIn', p, PIC)); w.ok(w.call(d, de, 'checkOut', p)); });

test('back a day early from an approved 3-day leave: cancel the rest, or shorten it = 2 leave days, 0 violations', () => {
  ['cancel', 'edit'].forEach(mode => {
    const w = world({ startDate: D(8) });
    plainDay(w, D(8)); w.job(D(8), '21:15', 'endOfDay');
    const l = w.ok(w.call(D(1), '12:00', 'submitLeave', 'vikas', lv([D(9), D(10), D(11)]))); w.ok(w.call(D(1), '12:30', 'decideLeave', 'aakash', { id: l.id, approve: true }));
    [D(9), D(10)].forEach(d => { plainDay(w, d, ['vikas']); w.job(d, '21:15', 'endOfDay'); });
    plainDay(w, D(11), ['vikas']);
    w.ok(w.call(D(11), '10:58', 'checkIn', 'vikas', PIC));                                                 // he is back on the 11th
    if (mode === 'cancel') w.ok(w.call(D(11), '11:30', 'cancelLeave', 'aakash', { id: l.id, reason: 'Came back a day early' }));
    else { const e = w.ok(w.call(D(11), '11:30', 'editLeave', 'aakash', Object.assign({ id: l.id }, lv([D(9), D(10)]))));
      if (e.status !== 'Approved') w.ok(w.call(D(11), '11:31', 'decideLeave', 'aakash', { id: l.id, approve: true })); }
    w.ok(w.call(D(11), '20:00', 'checkOut', 'vikas'));
    eq(w.jobTwice(D(11), '21:15', 'endOfDay').absent, [], mode);                                          // the evening job looks 3 days back
    const m = month(w, D(11), '22:00', 'vikas');
    eq([m.leaves.taken, m.leaves.total, rules(m)], [2, 4, []], mode);                                     // 9th + 10th, roster 6 + 13
    eq(w.sheet('LeaveRequests').filter(r => r.personId === 'vikas').map(r => [r.type, r.dates.length]), [['Regular', 2]], mode);
    eq(w.alerts().varun.absent, undefined, mode);
  });
});

test('a check-out tapped by mistake and taken back: the 5th not-informed violation of that day stands, and the pool partner is not blocked', () => {
  const w = world({ startDate: D(1) });
  [1, 2, 3, 4].forEach(k => { w.ok(w.call(D(k), '10:50', 'checkIn', 'harsh', PIC)); w.ok(w.call(D(k), '19:30', 'checkOut', 'harsh')); });
  w.ok(w.call(D(5), '09:25', 'checkIn', 'neha', PIC)); w.ok(w.call(D(5), '10:55', 'checkIn', 'vikas', PIC));
  w.ok(w.call(D(5), '10:50', 'checkIn', 'harsh', PIC));                                                     // the 5th time 20 min late, nobody told
  eq(rules(month(w, D(5), '11:00', 'harsh')), ['05:not-informed-beyond-passes']);
  w.ok(w.call(D(5), '12:00', 'checkOut', 'harsh'));                                                         // wrong tap
  w.ok(w.call(D(5), '12:05', 'undoCheckOut', 'aakash', { personId: 'harsh', reason: 'Tapped by mistake' }));
  w.ok(w.call(D(5), '19:30', 'checkOut', 'harsh'));
  const m = month(w, D(5), '19:40', 'harsh');
  eq([m.bank.used, m.bank.passesUsed, rules(m), m.leaves.taken], [50, 3, ['05:not-informed-beyond-passes'], 0]);
  // Bhawna: the same mistake, taken back. She is in all day, so Pooja may go out.
  w.ok(w.call(D(7), '09:28', 'checkIn', 'bhawna', PIC)); w.ok(w.call(D(7), '09:58', 'checkIn', 'pooja', PIC));
  w.ok(w.call(D(7), '12:00', 'checkOut', 'bhawna')); w.ok(w.call(D(7), '12:05', 'undoCheckOut', 'aakash', { personId: 'bhawna', reason: 'Tapped by mistake' }));
  eq([w.call(D(7), '13:00', 'goingOut', 'pooja', { reason: 'Bank', expectedMinutes: 20 }).ok, w.call(D(7), '13:01', 'requestShort', 'pooja', { kind: 'early', date: D(7), time: '18:30' }).ok], [true, true]);
});

test('an earlier emergency is cancelled: the two that remain are inside the allowance (no violation, no day cut)', () => {
  const w = world({ startDate: D(1) });
  const em = (d, t, day) => { const e = w.ok(w.call(d, t, 'submitLeave', 'manish', lv([day], 'Family emergency', 'x'))); w.ok(w.call(d, hm(t, 5), 'decideLeave', 'aakash', { id: e.id, approve: true })); return e; };
  em(D(1), '20:00', D(2)); const e2 = em(D(8), '20:00', D(9)); em(D(8), '22:00', D(10));
  eq(rules(month(w, D(8), '22:10', 'manish')), ['10:emergency-beyond-2']);
  w.ok(w.call(D(9), '07:00', 'cancelLeave', 'manish', { id: e2.id }));
  const m = month(w, D(9), '07:10', 'manish');
  eq([m.leaves.emergencies, rules(m), m.leaves.daysCut, m.wouldBeDeducted.total], [2, [], 0, 0]);
});

test('the Sunday roster is changed in Settings on Tuesday: last Sunday stays a roster day off; Aakash on leave: Varun hears about a leave request', () => {
  const w = world({ startDate: D(19) });
  [D(19), D(20), D(21)].forEach(d => { plainDay(w, d); w.job(d, '21:15', 'endOfDay'); });                  // 20 Dec = 3rd Sunday, Neha off
  const neha = w.ok(w.call(D(22), '09:00', 'getSettings', 'varun')).people.filter(p => p.id === 'neha')[0];
  w.ok(w.call(D(22), '09:05', 'savePerson', 'varun', Object.assign({}, neha, { sundayOff: [1, 2] })));
  plainDay(w, D(22));
  eq(w.jobTwice(D(22), '21:15', 'endOfDay').absent, []);
  const m = month(w, D(22), '22:00', 'neha');
  eq([rules(m), m.leaves.rosterSundays, m.leaves.taken], [[], 1, 0]);                                       // the 20th was hers; the 27th (4th Sunday) is now a working day
  const la = w.ok(w.call(D(22), '10:00', 'submitLeave', 'aakash', lv([D(23)]))); w.ok(w.call(D(22), '10:05', 'decideLeave', 'varun', { id: la.id, approve: true }));
  w.ok(w.call(D(23), '08:00', 'submitLeave', 'raunak', lv([D(24)], 'Family emergency', 'x')));
  eq(w.sheet('Notifications').filter(n => n.to === 'varun' && n.kind === 'approval' && /Raunak/.test(n.body)).length, 1);
});
