// Round 10 reproducers: second pass on privacy, security and concurrency.
// Every test here is written to FAIL on the current code, for the reason given in its name.
// Run: node --test /home/claude/findings/repro-round10.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const ROOT = __dirname + '/../';
const Store = require(ROOT + 'src/server/store.js');
const Api = require(ROOT + 'src/server/api.js');
const Jobs = require(ROOT + 'src/server/jobs.js');
const Cal = require(ROOT + 'src/rules/calendar.js');
const { wrap } = require(ROOT + 'src/server/cachegrid.js');
const { TABS } = require(ROOT + 'src/server/schema.js');
const { env, seed } = require(ROOT + 'test/helpers.js');

// ---------- A fake Sheet that behaves like gjGrid_ in src/gas/main.js (same idea as test/round3.test.js) ----------
const CELL_LIMIT = 50000; // Google Sheets: characters in one cell
function fakeGrid() {
  const tabs = {};
  const check = row => row.forEach(c => { if (c !== undefined && String(c).length > CELL_LIMIT) throw new Error('Your input contains more than the maximum of 50000 characters in a single cell.'); });
  const g = {
    tabs, tabNames: () => Object.keys(tabs), addTab: n => { tabs[n] = []; },
    read: n => (tabs[n] || []).map(r => r.slice()), headers: n => (tabs[n] && tabs[n][0] || []).slice(),
    tail: (n, k) => tabs[n].slice(1).slice(-k).map(r => r.slice()),
    append: (n, row) => g.appendRows(n, [row]), appendRows: (n, rows) => g.appendMany([{ tab: n, rows }])[n],
    appendMany: batch => { const first = {}; batch.forEach(b => { b.rows.forEach(check); first[b.tab] = tabs[b.tab].length; b.rows.forEach(r => tabs[b.tab].push(r.map(String))); }); return first; },
    readRow: (n, i) => (tabs[n][i] ? tabs[n][i].slice() : null),
    writeRow: (n, i, row) => { check(row); const cur = tabs[n][i] || []; row.forEach((c, k) => { if (c !== undefined) cur[k] = String(c); }); tabs[n][i] = cur; },
  };
  return g;
}
function fakeCache() {
  const m = new Map();
  return { getAll: keys => { const o = {}; keys.forEach(k => { if (m.has(k)) o[k] = m.get(k); }); return o; }, put: (k, v) => { m.set(k, v); }, putAll: map => { Object.keys(map).forEach(k => m.set(k, map[k])); }, remove: k => m.delete(k) };
}
let vn = 0; const ver = () => 'v' + (++vn);

/**
 * A world that mirrors doPost and gjJob_ in src/gas/main.js: a fresh buffered db per request over the cached grid,
 * env.withLock = take the script lock, run, flush inside the lock.
 * hooks.whileWaitingForLock(): another request runs completely while this one waits for the lock.
 * hooks.lockFails: the next lock.waitLock(25000) times out (Apps Script throws).
 */
function world(opts) {
  opts = opts || {};
  const g = fakeGrid(); Store.setup(g, { today: '2026-11-01' });
  const cache = fakeCache(); const mem = seed();
  const db0 = Store.open(g);
  mem.db.rows('People').forEach(p => db0.insert('People', Object.assign({}, p, opts.people ? opts.people(p) : {})));
  const who = {};
  mem.db.rows('People').forEach(p => {
    db0.insert('Devices', { id: 'dev_' + p.id, personId: p.id, tokenHash: env.sha256('tok-' + p.id), label: '', status: 'approved', requestedAt: 1, decidedAt: 1, decidedBy: 'test' });
    who[p.id] = { personId: p.id, deviceToken: 'tok-' + p.id };
  });
  function mk(hooks) {
    const db = Store.open(wrap(g, cache, Object.keys(TABS), ver), { buffer: true });
    let depth = 0;
    const e = Object.assign({}, env, {
      photos: env.photos,
      withLock(fn) {
        if (depth > 0) return fn();
        if (hooks.whileWaitingForLock) { const f = hooks.whileWaitingForLock; hooks.whileWaitingForLock = null; f(); }
        if (hooks.lockFails) { hooks.lockFails = false; throw new Error('Exception: Lock timeout: another process was holding the lock for too long.'); }
        depth += 1;
        try { return fn(); } finally { try { db.flush(); } finally { depth -= 1; } }
      },
    });
    return { db, e };
  }
  function doPost(when, action, person, args, hooks) {
    const { db, e } = mk(hooks || {});
    const req = Object.assign({ action, clientVersion: 1, args: args || {} }, typeof person === 'string' ? who[person] : (person || {}));
    const quiet = console.error; console.error = () => {}; // handle() logs unexpected errors; keep the test output readable
    let reply;
    try { reply = Api.handle({ db, now: mem.ist(...when), env: e }, req); db.flush(); } finally { console.error = quiet; }
    return JSON.parse(JSON.stringify(reply));
  }
  function job(when, name, mailer, hooks) {
    const { db, e } = mk(hooks || {});
    e.ownerEmail = 'owner@example.test';
    try { return Jobs.run({ db, now: mem.ist(...when), env: e }, name, mailer); } finally { db.flush(); }
  }
  const sheet = tab => Store.open(g).rows(tab); // what the Sheet really holds
  return { g, mem, doPost, job, sheet, who };
}
const leave = (dates, extra) => Object.assign({ kind: 'full', dates, reasonCode: 'Personal work', reasonText: 'Bank work' }, extra);
const JPEG = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAEB';
const range = (from, n) => { const out = []; for (let i = 0; i < n; i++) out.push(Cal.addDays(from, i)); return out; };

// =====================================================================================
// H1 (High). A staff member edits his own waiting request again and again. Every edit adds an entry to
// the request's `history` cell (the old dates are copied into it). He stops when the cell is a few
// characters under the store's 49,000-character limit (he can see the history in `myLeaves`).
// From then on EVERY action on that request by anyone adds one more history entry, the cell would be
// too long, the store refuses the whole write, and the reply is "Something went wrong":
//   - Aakash and Varun cannot reject, approve, cancel or edit it; an override is refused ("already has a request");
//   - the evening job never marks the person absent on those days (a waiting request holds the day);
//   - the month cannot be locked (the lock closes waiting requests, which adds a history entry).
// =====================================================================================
function stuffHistory(w, person, date) {
  const now = ['2026-11-20', '09:00'];
  const first = w.doPost(now, 'submitLeave', person, leave([date], { reasonText: 'x' }));
  assert.equal(first.ok, true, JSON.stringify(first));
  const id = first.data.id;
  const monday = Cal.addDays(date, -1), week = range(monday, 6); // Mon..Sat around the date (no Sunday: no roster clash)
  const row = () => w.sheet('LeaveRequests').find(x => x.id === id);
  const entry = (dates, status) => JSON.stringify({ at: 1795000000000, by: person, action: 'edited', from: { dates, kind: 'full', status } }).length + 1;
  let calls = 0;
  for (;;) {
    const cur = row(), gap = 49000 - JSON.stringify(cur.history).length;
    if (gap < 60) break;                                   // the next entry by anyone (at least 65 characters) no longer fits
    const est = entry(cur.dates, cur.status);              // what THIS edit will add (it copies the current dates)
    if (est > gap) break;
    let k = 6;                                             // dates to ask for now = size of the entry the NEXT edit adds
    if (gap - est < 400) { for (k = 1; k <= 5; k++) { const e = entry(week.slice(1, 1 + k), 'Special – waiting'); if (gap - est - e >= 0 && gap - est - e < 60) break; } if (k > 5) k = 1; }
    const dates = k === 6 ? week : week.slice(1, 1 + k);   // always contains the original date (Tuesday)
    const r = w.doPost(now, 'editLeave', person, Object.assign({ id }, leave(dates, { reasonText: 'x' })));
    // Changed with the fix: a request can now be edited only 10 times, so the stuffing stops being accepted.
    // The test goes on from there: whatever the staff member managed to do, the request must stay decidable.
    if (!r.ok) { assert.equal(r.code, 'BLOCKED', JSON.stringify(r)); break; }
    calls += 1;
    assert.ok(calls < 600, 'the staff member needs only a few hundred edits');
  }
  const end = row();
  assert.ok(/^(Pending|Special)/.test(end.status), 'the request is waiting for a decision: ' + end.status);
  return { id, calls, dates: end.dates, historyChars: JSON.stringify(end.history).length };
}

test('H1a a staff member can make his own waiting leave request impossible to reject (history cell filled by repeated edits)', () => {
  const w = world();
  const s = stuffHistory(w, 'raunak', '2026-12-15');
  const reject = w.doPost(['2026-11-20', '10:00'], 'decideLeave', 'aakash', { id: s.id, approve: false, reason: 'No' });
  const cancel = w.doPost(['2026-11-20', '10:01'], 'cancelLeave', 'varun', { id: s.id, reason: 'No' });
  assert.equal(reject.ok, true, 'after ' + s.calls + ' edits by Raunak (history cell: ' + s.historyChars + ' characters) Aakash cannot reject: ' + JSON.stringify(reject) +
    '; Varun cannot cancel either: ' + JSON.stringify(cancel));
});

test('H1b ...and with that request he stays away with no absence, no violation, and the month can never be locked', () => {
  const w = world();
  const s = stuffHistory(w, 'raunak', '2026-12-15');
  const day = s.dates[0];
  w.doPost(['2026-11-20', '10:00'], 'decideLeave', 'aakash', { id: s.id, approve: false, reason: 'No' }); // fails, see H1a
  w.job([day, '21:30'], 'endOfDay', null);
  const marked = w.sheet('LeaveRequests').filter(r => r.personId === 'raunak' && r.route === 'system' && r.dates.indexOf(day) !== -1).length;
  const first = w.doPost(['2027-01-02', '10:00'], 'lockMonth', 'aakash', { month: '2026-12' });
  assert.equal(first.ok, true, JSON.stringify(first));
  const second = w.doPost(['2027-01-02', '10:05'], 'lockMonth', 'varun', { month: '2026-12' });
  assert.equal(second.ok && second.data.locked, true, 'Raunak did not come on ' + day + ' (absence rows for that day: ' + marked + ', Aakash had tried to reject the request); ' +
    'and December cannot be locked: ' + JSON.stringify(second));
});

// =====================================================================================
// M1 (Medium). "No text beyond 2,000 characters" is checked per text value. A free-text field sent as a
// LIST of texts passes the check piece by piece, and the server then joins it with String(): one reason
// of 40,000+ characters. About 30 such requests push the LeaveRequests tab over what the read cache
// keeps (12 x 90,000 characters), after which every request of every person reads that tab from the Sheet.
// =====================================================================================
test('M1a a free-text field sent as a list of texts is stored 20 times longer than the 2,000-character limit', () => {
  const w = world();
  const r = w.doPost(['2026-11-20', '09:00'], 'submitLeave', 'anita', leave(['2026-12-10'], { reasonText: Array(20).fill('x'.repeat(2000)) }));
  const stored = w.sheet('LeaveRequests').map(x => String(x.reasonText).length);
  assert.ok(!r.ok || Math.max.apply(null, stored) <= 2000, 'accepted (' + JSON.stringify(r.data) + ') and stored a reason of ' + stored + ' characters');
});

test('M1b the same through "going out": a 40,000-character reason goes into Aakash\'s alert (and his e-mail)', () => {
  const w = world();
  assert.equal(w.doPost(['2026-11-20', '09:25'], 'checkIn', 'bhawna', { photo: JPEG, thumb: JPEG }).ok, true);
  const r = w.doPost(['2026-11-20', '12:00'], 'goingOut', 'bhawna', { reason: Array(20).fill('y'.repeat(2000)), expectedMinutes: 10 });
  const bodies = w.sheet('Notifications').filter(n => n.kind === 'out').map(n => String(n.body).length);
  assert.ok(!r.ok || Math.max.apply(null, bodies) <= 2100, 'accepted, and the alert to Aakash is ' + bodies + ' characters long');
});

test('M1c thirty such requests by one person: the LeaveRequests tab is no longer cached, every screen of everyone reads the Sheet', () => {
  const w = world();
  let reads = 0; const read = w.g.read; w.g.read = n => { if (n === 'LeaveRequests') reads += 1; return read(n); };
  for (let i = 0; i < 30; i++) w.doPost(['2026-11-20', '09:00'], 'submitLeave', 'anita', leave([Cal.addDays('2027-02-01', 3 * i)], { reasonText: Array(24).fill('x'.repeat(2000)) }));
  assert.equal(w.doPost(['2026-11-20', '09:05'], 'myLeaves', 'neha').ok, true);
  reads = 0;
  for (let i = 0; i < 10; i++) w.doPost(['2026-11-20', '09:06'], 'myLeaves', 'neha');
  assert.equal(reads, 0, '10 screens opened by Neha read the whole LeaveRequests tab from the Sheet ' + reads + ' times (tab size now ' + JSON.stringify(w.g.tabs.LeaveRequests).length + ' characters)');
});

// =====================================================================================
// M2 (Medium). The e-mail job sends first and marks "e-mailed" afterwards, in a separate locked step.
//  a) Two runs of the job that overlap both read the same un-marked alerts and both send them.
//  b) If the lock cannot be taken after sending (LockService.waitLock(25000) throws when the lock is
//     busy), nothing is marked and the next run, 5 minutes later, sends everything again. That repeats
//     for as long as the lock is busy, and the day's mail quota (100) goes with it.
// =====================================================================================
test('M2a two overlapping runs of the e-mail job: each alert must be e-mailed once', () => {
  const w = world({ people: p => ({ email: p.id + '@example.test' }) });
  assert.equal(w.doPost(['2026-11-20', '09:00'], 'submitLeave', 'neha', leave(['2026-11-21'])).ok, true);
  const sent = []; let second = false;
  const mailer = { quota: () => 100, send: to => { sent.push(to); if (!second) { second = true; w.job(['2026-11-20', '09:05'], 'emails', mailer); } } };
  w.job(['2026-11-20', '09:05'], 'emails', mailer);
  const toAakash = sent.filter(x => x === 'aakash@example.test').length;
  assert.equal(toAakash, 1, 'Aakash got the same "Leave request" e-mail ' + toAakash + ' times: ' + sent.join(', '));
});

test('M2b the lock is busy when the e-mail job wants to mark what it sent: the next run must not send the same e-mails again', () => {
  const w = world({ people: p => ({ email: p.id + '@example.test' }) });
  assert.equal(w.doPost(['2026-11-20', '09:00'], 'submitLeave', 'neha', leave(['2026-11-21'])).ok, true);
  const sent = []; const mailer = { quota: () => 100, send: to => { sent.push(to); } };
  try { w.job(['2026-11-20', '09:05'], 'emails', mailer, { lockFails: true }); } catch (e) { /* the job run ends with "Lock timeout" */ }
  assert.equal(sent.filter(x => x === 'aakash@example.test').length, 1, 'first run sent it once');
  w.job(['2026-11-20', '09:10'], 'emails', mailer);
  const toAakash = sent.filter(x => x === 'aakash@example.test').length;
  assert.equal(toAakash, 1, 'after one lock timeout the same e-mail went to Aakash ' + toAakash + ' times (and again on every further run while the lock is busy)');
});

// =====================================================================================
// M3 (Medium). Sign-in from a phone that is not yet approved uses the lock on the PERSON. Anyone on the
// internet (names and ids come from `names`) can keep that lock closed with 5 wrong PINs per lock period:
// 15 min, 1 h, 4 h, 16 h, then 24 h for ever, i.e. 5 requests a day per person. A new joiner, a person with
// a new or wiped phone, and the owner himself after losing his phone can then never get a phone request in.
// The owner's remedy ("reset the PIN") clears the lock but keeps its level, so the stranger's next
// 5 guesses close it for 24 hours at once.
// =====================================================================================
test('M3 after the owner resets a PIN, five wrong guesses by a stranger lock new-phone sign-in for 24 hours at once', () => {
  const w = world();
  const at = ms => { const d = new Date(ms + 5.5 * 3600000).toISOString(); return [d.slice(0, 10), d.slice(11, 16)]; };
  assert.equal(w.doPost(['2026-11-20', '09:00'], 'setPin', 'varun', { personId: 'neha', pin: '4821' }).ok, true);
  let t = w.mem.ist('2026-11-20', '09:00');
  for (let round = 0; round < 5; round++) {                // the stranger: 5 guesses whenever the lock opens
    for (let i = 0; i < 5; i++) w.doPost(at(t), 'login', null, { personId: 'neha', pin: '0000' });
    t = w.sheet('People').find(p => p.id === 'neha').pinLockedUntil + 60000;
  }
  assert.equal(w.doPost(at(t), 'setPin', 'varun', { personId: 'neha', pin: '5932' }).ok, true); // Neha asks the owner for help
  for (let i = 0; i < 5; i++) w.doPost(at(t + 60000), 'login', null, { personId: 'neha', pin: '0000' }); // the stranger is quicker
  const lockedMin = Math.round((w.sheet('People').find(p => p.id === 'neha').pinLockedUntil - t) / 60000);
  const neha = w.doPost(at(t + 20 * 60000), 'login', null, { personId: 'neha', pin: '5932', deviceLabel: 'Neha new phone' });
  assert.ok(lockedMin <= 16 && neha.code !== 'LOCKED', 'locked for ' + lockedMin + ' minutes straight after the reset; Neha with the right new PIN, 20 minutes later: ' + JSON.stringify(neha));
});

// =====================================================================================
// L3 (Low). A day the owner has ALREADY marked "shop closed": a person who is asked to come in and
// checks in / out on that day is judged against full duty hours. If the day is marked closed AFTER the
// check-in, the same minutes are set to 0. Same facts, opposite result, depending on the order.
// =====================================================================================
test('L3 check-in and check-out on a day already marked "shop closed" must not cost a half day and violations', () => {
  const w = world();
  assert.equal(w.doPost(['2026-11-20', '08:00'], 'setSetting', 'varun', { key: 'closedDays', value: ['2026-11-20'] }).ok, true);
  assert.equal(w.doPost(['2026-11-20', '10:30'], 'checkIn', 'neha', { photo: JPEG, thumb: JPEG }).ok, true);   // duty 09:30-18:30
  assert.equal(w.doPost(['2026-11-20', '15:00'], 'checkOut', 'neha').ok, true);
  const m = w.doPost(['2026-11-20', '15:01'], 'myMonth', 'neha', { month: '2026-11' }).data;
  assert.deepEqual({ halfDays: m.leaves.autoHalfDays.length, violations: m.violations.length }, { halfDays: 0, violations: 0 },
    'Neha came in on a closed day: automatic half day ' + JSON.stringify(m.leaves.autoHalfDays) + ' and violations ' + JSON.stringify(m.violations.map(v => v.rule)));
});

// =====================================================================================
// L1 (Low). Round 2 F11 again, by other doors: one staff member can still raise alerts without limit
// (a late / early request for each coming day; every edit of a waiting leave). One alert every 5 minutes
// is one e-mail to Aakash every 5 minutes: the 100 e-mails a consumer Google account may send in a day
// are used up by one person, and the real alerts of that day are not e-mailed to anyone.
// =====================================================================================
test('L1 one staff member must not be able to use up the whole daily e-mail quota', () => {
  const w = world({ people: p => ({ email: p.id + '@example.test' }) });
  const mailer = { left: 100, quota() { return this.left; }, send() { this.left -= 1; } };
  let day = '2027-01-10';
  for (let m = 0; m < 24 * 60; m += 5) {
    const hhmm = ('0' + Math.floor(m / 60)).slice(-2) + ':' + ('0' + (m % 60)).slice(-2);
    day = Cal.addDays(day, 1);
    w.doPost(['2026-11-20', hhmm], 'requestShort', 'pooja', { kind: 'early', time: '18:30', date: day });
    w.job(['2026-11-20', hhmm], 'emails', mailer);
  }
  const alerts = w.sheet('Notifications').filter(n => n.to === 'aakash').length;
  assert.ok(mailer.left > 0, 'Pooja alone raised ' + alerts + ' alerts for Aakash in one day; e-mails left for everybody else today: ' + mailer.left);
});

// =====================================================================================
// L2 (Low). A call with no sign-in whose deviceToken is not text (a number, an object) is not answered
// "Please sign in again": it runs into the hash function and ends as an unexpected error. And handle()
// hands any error that carries a `.code` to the caller with its internal message.
// =====================================================================================
test('L2 a deviceToken that is not text must be answered as "not signed in", not as an internal error', () => {
  const w = world();
  const r = w.doPost(['2026-11-20', '09:00'], 'me', { personId: 'neha', deviceToken: 12345 });
  assert.equal(r.code, 'AUTH', JSON.stringify(r));
});
