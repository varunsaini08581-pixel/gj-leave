// Round 16 reproducers: everything except the leave / attendance counting rules (round 15 has those).
// Every test here is written to FAIL on the current code (commit 4169780, server version 9, schema 4), for the reason in its name.
// Run: node --test /home/claude/findings/repro-round16.test.js
// The phone-app tests (U...) drive docs/ with python3 + Playwright in demo mode on 127.0.0.1 (repro-round16-ui.py)
// and are skipped when Playwright is missing. Nothing inside /home/claude/gj-leave is written.
const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const ROOT = '/home/claude/gj-leave/';
const Store = require(ROOT + 'src/server/store.js');
const Api = require(ROOT + 'src/server/api.js');
const Jobs = require(ROOT + 'src/server/jobs.js');
const { wrap } = require(ROOT + 'src/server/cachegrid.js');
const { TABS } = require(ROOT + 'src/server/schema.js');
const { env, seed } = require(ROOT + 'test/helpers.js');

// ---------- A fake Sheet that follows gjGrid_ in src/gas/main.js call by call ----------
// gjGrid_.appendMany does ONE setValues per tab, tab after tab; gjGrid_.writeRow does ONE setValues per run of
// neighbouring cells of the row. Each of those is modelled as one step. g.failOn = 'append Audit' (or 'row LeaveRequests#2')
// makes that step fail once, as a Sheets service error would; everything written before it stays, as on the real Sheet.
function gasGrid() {
  const tabs = {};
  const g = {
    tabs, failOn: '', seen: {}, log: [],
    step(what, fn) {
      g.seen[what] = (g.seen[what] || 0) + 1;
      const name = what + (g.seen[what] > 1 ? '#' + g.seen[what] : '');
      if (g.failOn && (g.failOn === what || g.failOn === name)) { g.failOn = ''; g.log.push('FAIL ' + name); throw new Error('Service Spreadsheets failed while accessing document.'); }
      g.log.push(name); fn();
    },
    arm(what) { g.failOn = what || ''; g.seen = {}; g.log = []; },
    tabNames: () => Object.keys(tabs), addTab: n => { tabs[n] = []; },
    read: n => (tabs[n] || []).map(r => r.slice()), headers: n => (tabs[n] && tabs[n][0] || []).slice(),
    tail: (n, k) => tabs[n].slice(1).slice(-k).map(r => r.slice()),
    append: (n, row) => g.appendRows(n, [row]), appendRows: (n, rows) => g.appendMany([{ tab: n, rows }])[n],
    appendMany: batch => {
      const plan = batch.map(b => ({ b, at: tabs[b.tab].length })); // all reads first, as in gjGrid_
      const first = {};
      plan.forEach(p => { g.step('append ' + p.b.tab, () => { p.b.rows.forEach(r => tabs[p.b.tab].push(r.map(String))); }); first[p.b.tab] = p.at; });
      return first;
    },
    readRow: (n, i) => (tabs[n][i] ? tabs[n][i].slice() : null),
    writeRow: (n, i, row) => {
      let start = -1, run = [];
      for (let c = 0; c <= row.length; c++) {
        if (c < row.length && row[c] !== undefined) { if (start === -1) start = c; run.push(row[c]); continue; }
        if (start !== -1) { const s = start, r = run; g.step('row ' + n, () => { const cur = tabs[n][i] || []; r.forEach((v, k) => { cur[s + k] = String(v); }); tabs[n][i] = cur; }); start = -1; run = []; }
      }
    },
  };
  return g;
}
function fakeCache() {
  const m = new Map();
  return { m, getAll: keys => { const o = {}; keys.forEach(k => { if (m.has(k)) o[k] = m.get(k); }); return o; }, put: (k, v) => { m.set(k, v); }, putAll: map => { Object.keys(map).forEach(k => m.set(k, map[k])); }, remove: k => m.delete(k) };
}
let vn = 0; const ver = () => 'v' + (++vn);
/** Mirrors doPost and gjJob_ in src/gas/main.js. */
function world(opts) {
  opts = opts || {};
  const g = gasGrid(); Store.setup(g, { today: '2026-11-01' });
  const cache = fakeCache(); const mem = seed();
  const db0 = Store.open(g);
  mem.db.rows('People').forEach(p => db0.insert('People', Object.assign({}, p)));
  const who = {};
  mem.db.rows('People').forEach(p => {
    if (!opts.noPhones) db0.insert('Devices', { id: 'dev_' + p.id, personId: p.id, tokenHash: env.sha256('tok-' + p.id), label: '', status: 'approved', requestedAt: 1, decidedAt: 1, decidedBy: 'test' });
    who[p.id] = { personId: p.id, deviceToken: 'tok-' + p.id };
  });
  function mk() {
    const db = Store.open(wrap(g, cache, Object.keys(TABS), ver), { buffer: true });
    let depth = 0;
    const e = Object.assign({}, env, {
      photos: env.photos, removePhoto() {},
      withLock(fn) { if (depth > 0) return fn(); depth += 1; try { return fn(); } finally { try { db.flush(); } finally { depth -= 1; } } },
    });
    return { db, e };
  }
  function doPost(when, action, person, args) {
    const { db, e } = mk();
    const req = Object.assign({ action, clientVersion: 1, args: args || {} }, typeof person === 'string' ? who[person] : (person || {}));
    const quiet = console.error; console.error = () => {};
    let reply;
    try { reply = Api.handle({ db, now: mem.ist(...when), env: e }, req); db.flush(); } finally { console.error = quiet; }
    return JSON.parse(JSON.stringify(reply));
  }
  function job(when, name, mailer) {
    const { db, e } = mk();
    e.ownerEmail = 'owner@example.test';
    try { return Jobs.run({ db, now: mem.ist(...when), env: e }, name, mailer); } finally { db.flush(); }
  }
  const sheet = tab => Store.open(g).rows(tab); // what the Sheet really holds
  return { g, cache, mem, doPost, job, sheet, who };
}
const leave = (dates, extra) => Object.assign({ kind: 'full', dates, reasonCode: 'Personal work', reasonText: 'Bank work' }, extra);
const JPEG = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAEB';
const must = r => { assert.equal(r.ok, true, 'test set-up: ' + JSON.stringify(r)); return r.data; };
const setPinHash = (w, id, pin) => { Store.open(w.g).update('People', id, { pinSalt: 's', pinHash: env.sha256('s:' + pin) }); w.cache.m.clear(); };
const D = '2026-11-20';
const monthOf = (w, id) => must(w.doPost([D, '20:00'], 'myMonth', 'aakash', { personId: id, month: '2026-11' }));
/** The Sheet fails once at the named step of this action; the reply must be the generic error (set-up check). */
function failing(w, step, fn) {
  w.g.arm(step);
  const r = fn();
  assert.equal(w.g.log.some(l => l.indexOf('FAIL ' + step) === 0), true, 'test set-up: the failure was not reached, steps were: ' + w.g.log.join(' | '));
  assert.equal(r === undefined || r.code === 'ERROR', true, 'test set-up: ' + JSON.stringify(r));
  w.g.arm('');
}

// =====================================================================================================
// M1 - a Sheet error BETWEEN the appended tabs (gjGrid_.appendMany writes tab after tab) leaves the tabs
//      written so far; changed rows are rolled back, new rows are not. The retry then doubles or loses rows.
// =====================================================================================================
test('M1a imBack: the Sheet fails after DayMinutes was appended; the row is rolled back, the retry appends the minutes again: one 44-minute outing uses 88 minutes of the bank', () => {
  const w = world();
  must(w.doPost([D, '10:25'], 'checkIn', 'harsh', { photo: JPEG, thumb: JPEG }));
  const id = must(w.doPost([D, '12:00'], 'goingOut', 'harsh', { reason: 'Bank', expectedMinutes: 40 })).id;
  must(w.doPost([D, '12:01'], 'decideOuting', 'aakash', { id, approve: true }));
  failing(w, 'append Audit', () => w.doPost([D, '12:45'], 'imBack', 'harsh', { id }));
  assert.equal(w.sheet('Outings')[0].status, 'Approved', 'test set-up: the changed row was put back');
  must(w.doPost([D, '12:45'], 'imBack', 'harsh', { id }));           // the person taps "I'm back" again, as the message says
  assert.equal(w.sheet('DayMinutes').filter(m => m.source === id).length, 1, 'one outing = one DayMinutes row');
  assert.equal(monthOf(w, 'harsh').bank.used, 44);
});

test('M1b check-in 50 min late, not informed: the Sheet fails after Punches was appended; the person is checked in, the late minutes and the violation are never recorded, the retry is refused', () => {
  const w = world();
  failing(w, 'append DayMinutes', () => w.doPost([D, '11:20'], 'checkIn', 'harsh', { photo: JPEG, thumb: JPEG }));
  const again = w.doPost([D, '11:21'], 'checkIn', 'harsh', { photo: JPEG, thumb: JPEG });
  const m = monthOf(w, 'harsh');
  // Either nothing of the failed check-in is on the Sheet (and the retry works), or all of it is.
  assert.deepEqual({ retry: again.ok || again.message, punches: w.sheet('Punches').length, lateMinutes: m.bank.days.reduce((s, d) => s + d.minutes, 0), violations: m.ladder.violations },
    { retry: true, punches: 1, lateMinutes: 51, violations: 1 }); // 51, not 50: the failed check-in is undone as a whole, so the retry at 11:21 is the check-in
});

test('M1c evening absent check: the Sheet fails after the absences were appended; every absence stays without its violation, and the next run leaves those days alone', () => {
  const w = world();
  failing(w, 'append Violations', () => { try { w.job([D, '21:00'], 'endOfDay', null); } catch (e) { return undefined; } return { code: 'no error' }; });
  w.job([D, '21:10'], 'endOfDay', null);                              // the job runs again (next timer, or by hand)
  w.job(['2026-11-21', '21:00'], 'endOfDay', null);
  const absent = w.sheet('LeaveRequests').filter(r => r.status === 'Absent – unannounced' && r.dates[0] <= D).length;
  const viol = w.sheet('Violations').filter(v => v.rule === 'absent-no-request' && v.date <= D).length;
  assert.equal(absent > 0, true, 'test set-up: absences were recorded');
  assert.equal(viol, absent, 'each "Absent – unannounced" of a staff member carries 1 violation');
});

test('M1d incident beyond grace: the Sheet fails after Incidents was appended; the incident says "violation", no violation exists, and the retry answers "violation recorded"', () => {
  const w = world();
  const args = { personId: 'harsh', item: 'phone', note: 'Reels at the counter' };
  failing(w, 'append Violations', () => w.doPost([D, '12:00'], 'recordIncident', 'aakash', args));
  const again = must(w.doPost([D, '12:01'], 'recordIncident', 'aakash', args));
  assert.equal(again.result, 'violation', 'test set-up: phone has no grace');
  assert.equal(w.sheet('Violations').filter(v => v.personId === 'harsh').length, 1);
});

// =====================================================================================================
// M2 - owner's first sign-in with a lost reply: the round 14 fix works only while the Devices tab holds one row
// =====================================================================================================
test('M2a new Sheet: one other person tapped Sign in before the owner; the owner\'s first reply is lost; his second sign-in is "pending" and nobody can approve anything', () => {
  const w = world({ noPhones: true }); ['varun', 'aakash'].forEach(p => setPinHash(w, p, '4321'));
  const label = 'Android phone, Chrome';
  assert.equal(must(w.doPost([D, '09:00'], 'login', null, { personId: 'aakash', pin: '4321', deviceLabel: label })).deviceStatus, 'pending', 'test set-up');
  assert.equal(must(w.doPost([D, '09:01'], 'login', null, { personId: 'varun', pin: '4321', deviceLabel: label })).deviceStatus, 'approved', 'test set-up: bootstrap'); // this reply never reaches the phone
  const second = must(w.doPost([D, '09:02'], 'login', null, { personId: 'varun', pin: '4321', deviceLabel: label }));
  assert.equal(second.deviceStatus, 'approved', 'the owner, same phone, one minute later, right PIN');
});
test('M2b after resetOwnerPhones: the owner signs in, the reply is lost, the second sign-in is "pending" (the Devices tab has other rows, so the 15-minute rule never applies)', () => {
  const w = world(); setPinHash(w, 'varun', '4321');
  Store.open(w.g).update('Devices', 'dev_varun', { status: 'revoked' }); w.cache.m.clear();   // what resetOwnerPhones does
  assert.equal(must(w.doPost([D, '09:01'], 'login', null, { personId: 'varun', pin: '4321', deviceLabel: 'iPhone, Safari' })).deviceStatus, 'approved', 'test set-up: accepted as the first phone again');
  assert.equal(must(w.doPost([D, '09:02'], 'login', null, { personId: 'varun', pin: '4321', deviceLabel: 'iPhone, Safari' })).deviceStatus, 'approved');
});

// =====================================================================================================
// L1 - "Phone request repeated" has no limit: one staff member can fill the owner's alerts
// =====================================================================================================
test('L1 a staff member repeats the first sign-in 200 times (right PIN, no token): 200 alerts and Audit rows; the owner\'s list of 50 holds nothing else', () => {
  const w = world(); setPinHash(w, 'harsh', '4321');
  must(w.doPost([D, '08:00'], 'submitLeave', 'neha', leave(['2026-11-21'])));
  must(w.doPost([D, '08:01'], 'decideLeave', 'aakash', { id: w.sheet('LeaveRequests')[0].id, approve: false, reason: 'No' }));
  must(w.doPost([D, '08:02'], 'submitLeave', 'aakash', leave(['2026-11-27'])));   // the manager's own leave: only Varun can decide it
  assert.equal(w.sheet('Notifications').some(n => n.to === 'varun' && n.title === 'Leave request'), true, 'test set-up');
  for (let i = 0; i < 200; i++) must(w.doPost([D, '09:' + String(10 + (i % 40))], 'login', null, { personId: 'harsh', pin: '4321', deviceLabel: 'Android phone, Chrome' }));
  const mine = w.sheet('Notifications').filter(n => n.to === 'varun' && /Phone request/.test(n.title)).length;
  const list = must(w.doPost([D, '10:00'], 'notifications', 'varun', {}));
  assert.equal(mine <= 10, true, mine + ' phone alerts for the owner from one person in one day');
  assert.equal(list.some(n => n.title === 'Leave request'), true, 'the owner still sees the alert that needs him');
});

// =====================================================================================================
// L2 - e-mail: five failed runs (20 minutes of a Gmail fault) and the alert is never e-mailed; nobody is told
// =====================================================================================================
test('L2 Gmail fails for five runs in a row (09:05 to 09:25): the manager\'s "Leave request" e-mail is given up for good, with no Audit row and no alert about it', () => {
  const w = world(); Store.open(w.g).update('People', 'aakash', { email: 'manager@example.test' }); w.cache.m.clear();
  must(w.doPost([D, '09:00'], 'submitLeave', 'harsh', leave(['2026-11-21'])));
  let up = false; const sent = [];
  const mailer = { quota: () => 50, send: (to, subject) => { if (!up) throw new Error('Service unavailable: Gmail'); sent.push(to + ' | ' + subject); } };
  for (let i = 0; i < 5; i++) w.job([D, '09:' + String(5 + 5 * i).padStart(2, '0')], 'emails', mailer);
  up = true;
  w.job([D, '09:30'], 'emails', mailer); w.job([D, '09:35'], 'emails', mailer);
  const told = w.sheet('Audit').some(a => /mail/i.test(a.action)) || w.sheet('Notifications').some(n => /e-?mail/i.test(n.title + ' ' + n.body));
  assert.equal(sent.some(s => /manager@example.test/.test(s)) || told, true, 'after Gmail is back the e-mail goes out, or somebody is told that it was given up');
});

// =====================================================================================================
// L6 - a row written in two pieces (the owner added his own column in the middle) is not put back when the second piece fails
// =====================================================================================================
test('L6 LeaveRequests has an owner\'s column after "status"; the Sheet fails on the second piece of the changed row: the request is "Approved" with no violation, no alert, and the retry is refused', () => {
  const w = world();
  const t = w.g.tabs.LeaveRequests, at = t[0].indexOf('status') + 1; t.forEach((r, i) => r.splice(at, 0, i ? '' : 'My remark')); w.cache.m.clear();
  const id = must(w.doPost([D, '09:00'], 'submitLeave', 'harsh', leave([D]))).id;       // same day, 90 minutes before duty: Unannounced
  assert.equal(w.sheet('LeaveRequests')[0].status, 'Pending with Aakash', 'test set-up');
  failing(w, 'row LeaveRequests#2', () => w.doPost([D, '09:05'], 'decideLeave', 'aakash', { id, approve: true }));
  const row = w.sheet('LeaveRequests')[0];
  const again = w.doPost([D, '09:06'], 'decideLeave', 'aakash', { id, approve: true });
  assert.deepEqual({ status: row.status, retry: again.ok || again.message }, { status: 'Pending with Aakash', retry: true });
});

// =====================================================================================================
// L7 - MonthSheet.result damaged by hand: the report of that locked month fails for the manager and the owner
// =====================================================================================================
test('L7 one MonthSheet "result" cell damaged by hand: the locked month report carries an empty entry for that person (the phone screen then stays on "Loading")', () => {
  const w = world();
  must(w.doPost([D, '09:00'], 'lockMonth', 'aakash', { month: '2026-10' })); assert.equal(must(w.doPost([D, '09:05'], 'lockMonth', 'varun', { month: '2026-10' })).locked, true, 'test set-up');
  assert.equal(must(w.doPost([D, '09:06'], 'monthReport', 'varun', { month: '2026-10' })).locked, true, 'test set-up');
  const t = w.g.tabs.MonthSheet, c = t[0].indexOf('result'), p = t[0].indexOf('personId');
  const i = t.findIndex((r, k) => k && r[p] === 'neha'); assert.equal(i > 0, true, 'test set-up'); t[i][c] = 'null'; w.cache.m.clear();
  const r = w.doPost([D, '09:10'], 'monthReport', 'varun', { month: '2026-10' });
  assert.equal(r.ok, true, 'test set-up: ' + JSON.stringify(r).slice(0, 200));
  assert.equal(r.data.people.every(x => x && typeof x.name === 'string'), true, 'every entry of the report is a person: ' + JSON.stringify(r.data.people.map(x => x && x.name)));
});

// =====================================================================================================
// Phone app (python3 + Playwright, demo mode)
// =====================================================================================================
let ui = null;
function phone() {
  if (ui) return ui;
  try { ui = JSON.parse(execFileSync('python3', ['/home/claude/findings/repro-round16-ui.py'], { encoding: 'utf8', timeout: 400000 })); }
  catch (e) { ui = { skip: 'python3 / Playwright could not run: ' + String(e.message).slice(0, 120) }; }
  return ui;
}
const uiTest = (name, key, fn) => test(name, t => {
  const u = phone();
  if (u.skip) return t.skip(u.skip);
  assert.equal(u[key + '_error'], undefined, 'test set-up (script): ' + u[key + '_error']);
  fn(u);
});

uiTest('M3a a check-in photo that could not be sent is still offered the NEXT morning (app left open); "Send again" checks the person in today with yesterday\'s photo, no camera', 'UD', u => {
  assert.equal(u.UD_keptDay1, 1, 'test set-up: the photo was kept after the failed upload');
  assert.match(u.UD_day2Date, /^21 Nov/, 'test set-up: the screen shows the next day');
  assert.equal(u.UD_day2Offer, 0, 'on 21 Nov the app offers to send the photo taken on 20 Nov; after the tap: ' + JSON.stringify(u.UD_day2Punch) + ', same picture sent both days: ' + (u.UD_sent && u.UD_sent[0] === u.UD_sent[1]));
});
uiTest('M3b the kept photo of one person is offered to the NEXT person who signs in on the same phone; one tap checks that person in with the other person\'s photo', 'UD', u => {
  assert.equal(u.UD_otherPersonOffer, 0, 'Harsh, signed in after Vikas on the same phone, sees "Send again"; his check-ins after the tap: ' + u.UD_otherPunch);
});
uiTest('L3 Approvals: two cards with the same heading (Bhawna, late arrival for two days); a new leave request arrives; the finger on "Approve" of 23 Nov is on "Approve" of 21 Nov after the refresh', 'UA', u => {
  assert.equal(u.UA_setup.every(r => r.ok) && u.UA_new, true, 'test set-up');
  assert.match(u.UA_before, /^Approve @ Bhawna.*23 Nov/, 'test set-up');
  assert.match(u.UA_after, /23 Nov/);
});
uiTest('L4 manager\'s Today: the shop board answers after 5 seconds (slow network); the page height is held for only 4 seconds and the screen is thrown to the top', 'UB', u => {
  assert.equal(u.UB_before > 300, true, 'test set-up: scrolled down');
  assert.equal(Math.min.apply(null, u.UB_ys), u.UB_before, 'scroll position during the refresh: ' + JSON.stringify(u.UB_ys));
});
uiTest('L5 device card: the time of a repeated sign-in is written in the phone\'s own language digits (Marathi phone), not in the app\'s English form', 'UC', u => {
  assert.match(u['UC_en-IN'], /repeated at \d\d:\d\d/i, 'test set-up');
  assert.match(u['UC_mr-IN'], /^[\x20-\x7e’]+$/, u['UC_mr-IN']);
});
