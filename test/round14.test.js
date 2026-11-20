// Round 14 reproducers: everything except the leave / attendance counting rules (round 13 has those).
// Every test here is written to FAIL on the current code (commit b471950, server version 9, schema 4), for the reason in its name.
// Run: node --test /home/claude/findings/repro-round14.test.js
// The phone-app tests (U...) drive docs/ with python3 + Playwright in demo mode on 127.0.0.1 (repro-round14-ui.py)
// and are skipped when Playwright is missing. Nothing inside /home/claude/gj-leave is written.
const test = require('node:test');
const assert = require('node:assert/strict');
const ROOT = '/home/claude/gj-leave/';
const Store = require(ROOT + 'src/server/store.js');
const Api = require(ROOT + 'src/server/api.js');
const Jobs = require(ROOT + 'src/server/jobs.js');
const { wrap } = require(ROOT + 'src/server/cachegrid.js');
const { TABS } = require(ROOT + 'src/server/schema.js');
const { env, seed } = require(ROOT + 'test/helpers.js');

// ---------- A fake Sheet that behaves like gjGrid_ in src/gas/main.js (same helper as test/round12.test.js) ----------
// Added: g.failAppend = n makes the next n "append rows" calls fail, as a Sheets service error would.
function fakeGrid() {
  const tabs = {};
  const g = {
    tabs, failAppend: 0, tabNames: () => Object.keys(tabs), addTab: n => { tabs[n] = []; },
    read: n => (tabs[n] || []).map(r => r.slice()), headers: n => (tabs[n] && tabs[n][0] || []).slice(),
    tail: (n, k) => tabs[n].slice(1).slice(-k).map(r => r.slice()),
    append: (n, row) => g.appendRows(n, [row]), appendRows: (n, rows) => g.appendMany([{ tab: n, rows }])[n],
    appendMany: batch => {
      if (g.failAppend > 0) { g.failAppend -= 1; throw new Error('Service Spreadsheets failed while accessing document.'); }
      const first = {}; batch.forEach(b => { first[b.tab] = tabs[b.tab].length; b.rows.forEach(r => tabs[b.tab].push(r.map(String))); }); return first;
    },
    readRow: (n, i) => (tabs[n][i] ? tabs[n][i].slice() : null),
    writeRow: (n, i, row) => { const cur = tabs[n][i] || []; row.forEach((c, k) => { if (c !== undefined) cur[k] = String(c); }); tabs[n][i] = cur; },
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
  const g = fakeGrid(); Store.setup(g, { today: '2026-11-01' });
  const cache = fakeCache(); const mem = seed();
  const db0 = Store.open(g);
  mem.db.rows('People').forEach(p => db0.insert('People', Object.assign({}, p, opts.people ? opts.people(p) : {})));
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

// ---------- phone app: one Playwright run for all U... tests ----------
let uiResult = null;
function ui() {
  if (uiResult) return uiResult;
  const { spawnSync } = require('node:child_process');
  const r = spawnSync('python3', [__dirname + '/repro-round14-ui.py'], { encoding: 'utf8', timeout: 280000 });
  try { uiResult = JSON.parse((r.stdout || '').trim().split('\n').pop()); }
  catch (e) { uiResult = { skip: 'python3 / Playwright could not run: ' + String(r.error || r.stderr || '').slice(0, 200) }; }
  return uiResult;
}
function uiTest(name, fn) {
  test(name, { timeout: 300000 }, t => {
    const out = ui();
    if (out.skip) { t.skip(out.skip); return; }
    fn(out);
  });
}

// =====================================================================================
// M1 (Medium). store.js write() now writes CHANGED rows first and NEW rows last (round 12 M4 fix).
// When the Sheet fails between the two, the decision is saved but the new rows it needs are not
// (minutes, incident, violation, the month lock), and the retry is refused ("not waiting", "nothing to confirm"),
// so nothing ever puts them back. Before the change the same failure left a wrong alert; now it leaves a wrong count.
// =====================================================================================
test('M1a a Sheet error while Aakash closes an outing must not leave the outing "Confirmed" with its minutes counted nowhere', () => {
  const w = world();
  must(w.doPost(['2026-11-20', '10:30'], 'checkIn', 'raunak', { photo: JPEG, thumb: JPEG }));
  const o = must(w.doPost(['2026-11-20', '12:00'], 'goingOut', 'raunak', { reason: 'Bank', expectedMinutes: 40 }));
  must(w.doPost(['2026-11-20', '12:01'], 'decideOuting', 'aakash', { id: o.id, approve: true }));
  w.g.failAppend = 1;                                                    // the Sheet fails once, after the changed rows went through
  const first = w.doPost(['2026-11-20', '13:00'], 'confirmBack', 'aakash', { id: o.id, correctedTime: '12:45' });
  assert.equal(first.ok, false, 'test set-up: the failed write is reported');
  const again = w.doPost(['2026-11-20', '13:01'], 'confirmBack', 'aakash', { id: o.id, correctedTime: '12:45' });   // Aakash taps again
  const outing = w.sheet('Outings')[0], used = must(w.doPost(['2026-11-20', '13:05'], 'myMonth', 'raunak', { month: '2026-11' })).bank.used;
  assert.equal(used, outing.minutes, 'the outing stands as "' + outing.status + '", ' + outing.minutes + ' min, but the 2-hour bank shows ' + used + ' min used; DayMinutes rows: ' +
    w.sheet('DayMinutes').length + '; the second tap answered: ' + JSON.stringify(again));
});
test('M1b a Sheet error while Aakash confirms a dress flag must not make the flag "confirmed" with no incident recorded', () => {
  const w = world();
  must(w.doPost(['2026-11-20', '10:30'], 'checkIn', 'raunak', { photo: JPEG, thumb: JPEG, dress: { top: 'issue', trousers: 'ok', shoes: 'ok', belt: 'ok' } }));
  const flag = must(w.doPost(['2026-11-20', '10:40'], 'approvals', 'aakash')).dress[0];
  w.g.failAppend = 1;
  assert.equal(w.doPost(['2026-11-20', '10:41'], 'decideDress', 'aakash', { id: flag.id, confirm: true }).ok, false, 'test set-up');
  const again = w.doPost(['2026-11-20', '10:42'], 'decideDress', 'aakash', { id: flag.id, confirm: true });
  const decision = w.sheet('Punches')[0].dressDecision, incidents = w.sheet('Incidents').length;
  assert.ok(!(decision === 'confirmed' && incidents === 0), 'the dress flag is "' + decision + '" and has left Approvals, but ' + incidents + ' incident was recorded (the grace count never sees it); the second tap answered: ' + JSON.stringify(again));
});
test('M1c a Sheet error while Aakash approves an unannounced leave must not leave it Approved without its violation, audit row and alert', () => {
  const w = world();
  const s = must(w.doPost(['2026-11-20', '08:00'], 'submitLeave', 'raunak', leave(['2026-11-20'])));   // 2.5 h before duty: Unannounced, goes to Aakash
  assert.equal(w.sheet('LeaveRequests')[0].type, 'Unannounced', 'test set-up');
  w.g.failAppend = 1;
  assert.equal(w.doPost(['2026-11-20', '08:10'], 'decideLeave', 'aakash', { id: s.id, approve: true }).ok, false, 'test set-up');
  const again = w.doPost(['2026-11-20', '08:11'], 'decideLeave', 'aakash', { id: s.id, approve: true });
  w.job(['2026-11-20', '12:05'], 'hourly'); w.job(['2026-11-20', '21:05'], 'endOfDay');                // nothing repairs it later
  const row = w.sheet('LeaveRequests')[0];
  const violations = w.sheet('Violations').filter(v => v.personId === 'raunak' && v.rule === 'unannounced-leave').length;
  const audited = w.sheet('Audit').filter(a => a.action === 'leave.decide').length, told = w.sheet('Notifications').filter(n => n.to === 'raunak' && /Approved/.test(n.title)).length;
  assert.ok(!(row.status === 'Approved' && violations === 0), 'the leave is "' + row.status + '" (type ' + row.type + '): "Unannounced leave" violations ' + violations + ', leave.decide rows in Audit ' + audited +
    ', "Leave: Approved" alerts to Raunak ' + told + '; the second tap answered: ' + JSON.stringify(again));
});
test('M1d a Sheet error during the month lock must not change what is locked on the second try', () => {
  const run = fail => {
    const w = world();
    must(w.doPost(['2026-10-20', '08:00'], 'submitLeave', 'raunak', leave(['2026-10-21'], { reasonCode: 'Sick' })));   // waits for Aakash; nobody decides; Raunak stays away
    w.job(['2026-10-21', '21:05'], 'endOfDay');
    must(w.doPost(['2026-11-02', '10:00'], 'lockMonth', 'aakash', { month: '2026-10' }));
    if (fail) { w.g.failAppend = 1; assert.equal(w.doPost(['2026-11-02', '10:05'], 'lockMonth', 'varun', { month: '2026-10' }).ok, false, 'test set-up'); }
    must(w.doPost(['2026-11-02', '10:06'], 'lockMonth', 'varun', { month: '2026-10' }));
    return must(w.doPost(['2026-11-02', '10:07'], 'monthReport', 'varun', { month: '2026-10' })).people.find(p => p.name === 'Raunak').leaves;
  };
  const clean = run(false), afterError = run(true);
  assert.deepEqual({ total: afterError.total, undecided: afterError.undecided }, { total: clean.total, undecided: clean.undecided },
    'locked October for Raunak: without the error ' + clean.total + ' leaves (21 Oct "counted, not decided"); after one failed try and a second tap ' + afterError.total + ' leaves: the day he was away is gone from the locked result');
});

// =====================================================================================
// M2 (Medium). The owner's very first sign-in (the "bootstrap" phone) with a lost reply.
// The first sign-in approves the phone and returns its token once. If that reply does not reach the phone
// (first call on a cold server, weak signal), the phone has no token. The next sign-in is a new request that
// "waits for the owner's approval"; the bootstrap rule no longer applies; the manager has no approved phone yet.
// Round 12 L7 handled the lost reply for a WAITING request only.
// =====================================================================================
test('M2 the owner\'s first sign-in repeated after a lost reply must let him in (nobody else can approve anything yet)', () => {
  const w = world({ noPhones: true });
  setPinHash(w, 'varun', '4821'); setPinHash(w, 'aakash', '2222');
  const first = must(w.doPost(['2026-11-20', '09:00'], 'login', {}, { personId: 'varun', pin: '4821', deviceLabel: 'Android phone, Chrome' }));
  assert.equal(first.deviceStatus, 'approved', 'test set-up: the first phone of the owner is approved by itself');
  // ... this reply never reaches the phone. He taps Sign in again: same phone, same PIN, no token.
  const again = must(w.doPost(['2026-11-20', '09:01'], 'login', {}, { personId: 'varun', pin: '4821', deviceLabel: 'Android phone, Chrome' }));
  const manager = must(w.doPost(['2026-11-20', '09:02'], 'login', {}, { personId: 'aakash', pin: '2222', deviceLabel: 'iPhone, Safari' }));
  assert.equal(again.deviceStatus, 'approved', 'the owner is told "' + again.deviceStatus + '" (waiting for the owner\'s approval). Phones on the Sheet: ' +
    w.sheet('Devices').map(d => d.personId + ' ' + d.status).join(', ') + '; the manager\'s phone is "' + manager.deviceStatus + '" too. Nobody can approve anybody; only resetOwnerPhones in the script editor helps.');
});

// =====================================================================================
// M3 (Medium). A waiting phone request is taken over without a trace (core.js loginLocked, the "same" branch).
// A second sign-in with the right PIN, no token and the same label replaces the token of the request that is
// waiting. The label is the same for almost every phone ("Android phone, Chrome" / "iPhone, Safari").
// Nothing is written to Audit, nobody is alerted, the card the approver sees is the same card. Whoever signed in
// last gets the approval. On the owner-recovery path the manager then approves the other phone as the OWNER, and
// the owner's own working phone is removed by that approval. Before round 12 a second card at least appeared.
// =====================================================================================
test('M3a a second sign-in that replaces the token of a waiting phone request must leave a trace (Audit) for the approver', () => {
  const w = world();
  setPinHash(w, 'harsh', '3333');
  const real = must(w.doPost(['2026-11-20', '09:00'], 'login', {}, { personId: 'harsh', pin: '3333', deviceLabel: 'Android phone, Chrome' }));      // Harsh, new phone
  const auditBefore = w.sheet('Audit').length, alertsBefore = w.sheet('Notifications').length;
  const cardBefore = must(w.doPost(['2026-11-20', '09:04'], 'approvals', 'varun')).devices.map(d => [d.id, d.name, d.label]);
  const otherPhone = must(w.doPost(['2026-11-20', '09:05'], 'login', {}, { personId: 'harsh', pin: '3333', deviceLabel: 'Android phone, Chrome' })); // somebody who knows his PIN, on another phone
  const cardAfter = must(w.doPost(['2026-11-20', '09:06'], 'approvals', 'varun')).devices.map(d => [d.id, d.name, d.label]);
  assert.equal(otherPhone.deviceId, real.deviceId, 'test set-up: the second sign-in reuses the waiting request');
  const auditNew = w.sheet('Audit').length - auditBefore, alertsNew = w.sheet('Notifications').length - alertsBefore;
  must(w.doPost(['2026-11-20', '09:10'], 'decideDevice', 'varun', { id: real.deviceId, approve: true }));
  const realIn = w.doPost(['2026-11-20', '09:11'], 'me', { personId: 'harsh', deviceToken: real.deviceToken }).ok;
  const otherIn = w.doPost(['2026-11-20', '09:11'], 'me', { personId: 'harsh', deviceToken: otherPhone.deviceToken }).ok;
  assert.ok(auditNew > 0 || alertsNew > 0 || JSON.stringify(cardBefore) !== JSON.stringify(cardAfter),
    'the second sign-in wrote ' + auditNew + ' Audit rows and ' + alertsNew + ' alerts, and the owner\'s card is the same (' + JSON.stringify(cardAfter) + '). After his one tap on Approve: first phone signed in = ' + realIn + ', second phone signed in = ' + otherIn);
});
test('M3b owner recovery: the manager approves "Varun, new phone" and the phone that gets in must be the one that asked first, or he must be able to tell', () => {
  const w = world();
  setPinHash(w, 'varun', '4821');
  const real = must(w.doPost(['2026-11-20', '09:00'], 'login', {}, { personId: 'varun', pin: '4821', deviceLabel: 'iPhone, Safari' }));   // the owner on his new phone
  const card1 = must(w.doPost(['2026-11-20', '09:01'], 'approvals', 'aakash')).devices;
  const second = must(w.doPost(['2026-11-20', '09:02'], 'login', {}, { personId: 'varun', pin: '4821', deviceLabel: 'iPhone, Safari' })); // another iPhone, someone who has seen the PIN
  const card2 = must(w.doPost(['2026-11-20', '09:03'], 'approvals', 'aakash')).devices;
  must(w.doPost(['2026-11-20', '09:04'], 'decideDevice', 'aakash', { id: card2[0].id, approve: true }));
  const firstIn = w.doPost(['2026-11-20', '09:05'], 'me', { personId: 'varun', deviceToken: real.deviceToken }).ok;
  const secondRole = (w.doPost(['2026-11-20', '09:05'], 'me', { personId: 'varun', deviceToken: second.deviceToken }).data || {}).role;
  const oldPhone = w.doPost(['2026-11-20', '09:05'], 'me', 'varun').code;
  const told = card1.length !== card2.length || card1[0].label !== card2[0].label || Object.keys(card2[0]).some(k => !(k in card1[0]));
  assert.ok(firstIn || told, 'Aakash saw one card, unchanged but for its time (' + JSON.stringify(card2[0]) + '). After his tap: the phone that asked first is in = ' + firstIn +
    '; the second phone is signed in as "' + secondRole + '"; the owner\'s old, working phone now answers ' + oldPhone + '.');
});

// =====================================================================================
// M4 (Medium). The owner's two ways back in (assumption 63 b and c) are both closed by anyone who knows his NAME.
// `names` is public. Five wrong PINs on the owner's name lock "sign in on a new phone" for the owner
// (15 min, 1 h, 4 h, 16 h, then 24 h each time; five guesses a day keep it shut). While it is locked the owner
// cannot even create the request Aakash would approve, and `resetOwnerPhones` (gas/main.js) removes the phones
// but leaves People.pinLockedUntil: the owner with the right PIN still gets "Too many wrong PINs".
// =====================================================================================
test('M4 resetOwnerPhones must let the owner in with the right PIN, also after a stranger\'s wrong PINs on his name', () => {
  const vm = require('node:vm'), fs = require('node:fs');
  const w = world();
  setPinHash(w, 'varun', '4821');
  for (let i = 0; i < 5; i++) w.doPost(['2026-11-20', '09:00'], 'login', {}, { personId: 'varun', pin: '000' + i, deviceLabel: 'x' });   // a stranger: 5 guesses, no PIN known
  const viaManager = w.doPost(['2026-11-20', '09:05'], 'login', {}, { personId: 'varun', pin: '4821', deviceLabel: 'New phone' });        // the owner, lost phone, right PIN
  // run the real resetOwnerPhones from src/gas/main.js against this Sheet
  const sheetOf = name => ({ getDataRange: () => ({ getDisplayValues: () => w.g.tabs[name].map(r => r.slice()) }),
    getRange: (r, c) => ({ setNumberFormat() { return this; }, setValue(v) { w.g.tabs[name][r - 1][c - 1] = String(v); } }) });
  const box = { SpreadsheetApp: { getActiveSpreadsheet: () => ({ getSheetByName: sheetOf }) }, CacheService: { getScriptCache: () => ({ put: (k, v) => w.cache.m.set(k, v) }) }, Utilities: { getUuid: () => 'reset-' + (++vn) + '-xxxx' } };
  vm.createContext(box); vm.runInContext(fs.readFileSync(ROOT + 'src/gas/main.js', 'utf8'), box);
  const said = box.resetOwnerPhones();
  const after = w.doPost(['2026-11-20', '09:06'], 'login', {}, { personId: 'varun', pin: '4821', deviceLabel: 'New phone' });
  assert.equal(after.ok && after.data.deviceStatus, 'approved', 'resetOwnerPhones said "' + said + '", then the owner with the right PIN got: ' + JSON.stringify(after) +
    ' (before the reset, the request for Aakash to approve was refused the same way: ' + viaManager.code + ')');
});

// =====================================================================================
// M5 (Medium). Round 12 M2 again on the manager's and owner's Today tab: every 30-second refresh throws it to the top.
// show() keeps scrollY, but the "Shop today" board is filled in after show(): at that moment the page is short,
// the kept position is cut to 0, then the board arrives.
// =====================================================================================
uiTest('M5 Aakash reading the lower part of Today (board, alerts): the 30-second refresh must leave the page where it is', out => {
  assert.equal(out.UA_error, undefined, out.UA_error);
  assert.ok(out.UA_before > 200, 'test set-up: the page is scrolled (' + out.UA_before + ' px)');
  assert.ok(Math.abs(out.UA_after - out.UA_before) < 40, 'scrolled to ' + out.UA_before + ' px ("' + out.UA_underBefore + '" in the middle of the screen); after the refresh the page is at ' + out.UA_after + ' px ("' + out.UA_underAfter + '")');
});

// =====================================================================================
// L1 (Low). E-mail job: a send that fails for a reason that is not "bad address" is tried again every 5 minutes with no limit.
// =====================================================================================
test('L1 an e-mail that can never be sent must be given up after a few tries, not tried 288 times a day for ever', () => {
  const w = world({ people: p => (p.id === 'aakash' ? { email: 'aakash@example.test' } : {}) });
  must(w.doPost(['2026-11-20', '08:00'], 'submitLeave', 'raunak', leave(['2026-11-20'])));     // one alert for Aakash
  let tries = 0;
  const mailer = { quota: () => 100, send() { tries += 1; throw new Error('Exception: Authorization is required to perform that action.'); } };
  for (let i = 0; i < 288; i++) w.job(['2026-11-20', '09:00'], 'emails', mailer);              // one day of 5-minute runs
  assert.ok(tries <= 10, 'the same e-mail was tried ' + tries + ' times in 288 runs; its alert is still marked "not e-mailed" (' + JSON.stringify(w.sheet('Notifications').filter(n => n.to === 'aakash').map(n => n.emailedAt)) + ')');
});

// =====================================================================================
// L2 (Low). Round 10 L1 / round 2 F11 through the door that was left: send a leave request, cancel it, send it again.
// Each round is one alert (and one e-mail) to Aakash and one to the person: the 100 e-mails of the day are gone.
// =====================================================================================
test('L2 one staff member sending and cancelling a leave request all day must not use up the daily e-mail quota', () => {
  const w = world({ people: p => ({ email: p.id + '@example.test' }) });
  const mailer = { left: 100, quota() { return this.left; }, send() { this.left -= 1; } };
  for (let m = 5; m < 24 * 60; m += 5) {
    const hhmm = ('0' + Math.floor(m / 60)).slice(-2) + ':' + ('0' + (m % 60)).slice(-2);
    const r = w.doPost(['2026-11-20', hhmm], 'submitLeave', 'pooja', leave(['2026-11-21']));   // tomorrow: short notice, goes to Aakash
    if (r.ok) w.doPost(['2026-11-20', hhmm], 'cancelLeave', 'pooja', { id: r.data.id });
    w.job(['2026-11-20', hhmm], 'emails', mailer);
  }
  const alerts = w.sheet('Notifications').filter(n => n.to === 'aakash').length;
  assert.ok(mailer.left > 0, 'Pooja alone raised ' + alerts + ' alerts for Aakash in one day (' + w.sheet('LeaveRequests').length + ' requests); e-mails left for everybody else today: ' + mailer.left);
});

// =====================================================================================
// L3 (Low). Screens under More are not covered by the round 5 guard: their answer paints over the tab the person moved to.
// =====================================================================================
uiTest('L3 "Staff leaves": cancel a leave, move to Today before the answer: Today must stay on the screen', out => {
  assert.equal(out.UB_error, undefined, out.UB_error);
  assert.match(out.UB_heading, /^Hello/, 'the tab bar says "' + out.UB_tab + '" and the screen shows "' + out.UB_heading + '"');
});

// =====================================================================================
// L4 (Low). The manager's card for the owner's new phone: a Reject button that can only fail, and no word on what the card is.
// =====================================================================================
uiTest('L4 Aakash\'s "Varun, new phone" card must not offer a Reject that answers "Only the owner can approve a phone"', out => {
  assert.equal(out.UC_error, undefined, out.UC_error);
  assert.equal(out.UC_hasReject, 0, 'card: "' + out.UC_card.replace(/\n+/g, ' / ') + '"; Reject answers: "' + out.UC_rejectToast + '"');
});

// =====================================================================================
// L5 (Low). A 30-second refresh that fails (a moment without network) replaces the whole Today screen by one line.
// =====================================================================================
uiTest('L5 Today: a refresh that fails must keep the screen (or offer Try again), not leave one line and no button', out => {
  assert.equal(out.UD_error, undefined, out.UD_error);
  assert.ok(out.UD_buttons > 0, 'the Today screen is now only: "' + out.UD_screen + '" (' + out.UD_buttons + ' buttons; Check in, Check out, "Send again" for a kept photo are gone until a later refresh works)');
});

// =====================================================================================
// L6 (Low). Hand-damaged cells that still take something down (round 12 M5 covered Rules.members, shopPoint, Restrictions dates).
// =====================================================================================
test('L6a Settings "closedDays" holding valid JSON that is not a list must not stop the evening absent check and the daily summary', () => {
  const w = world();
  must(w.doPost(['2026-11-20', '09:00'], 'setSetting', 'varun', { key: 'closedDays', value: ['2026-12-25'] }));
  const t = w.g.tabs.Settings, row = t.find(r => r[0] === 'closedDays'); row[t[0].indexOf('value')] = '{"2026-12-25":true}'; w.cache.m.clear();   // typed by hand in the Sheet
  let error = '';
  try { w.job(['2026-11-20', '21:05'], 'endOfDay'); } catch (e) { error = e.message; }
  assert.equal(error, '', 'jobEndOfDay stops with "' + error + '": nobody is marked absent and Varun gets no daily summary, every night, until the cell is repaired');
});
test('L6b a restriction whose "applies to" cell is not a list must not take the restricted-dates notice off the Apply form', () => {
  const w = world();
  must(w.doPost(['2026-11-20', '09:00'], 'saveRestriction', 'varun', { from: '2026-11-24', to: '2026-11-30', note: 'Peak season', rule: 'no-leave', appliesTo: ['Neha', 'Vikas'] }));
  const t = w.g.tabs.Restrictions; t[1][t[0].indexOf('appliesTo')] = '12'; w.cache.m.clear();
  const r = w.doPost(['2026-11-20', '09:10'], 'myRestrictions', 'neha');
  assert.equal(r.ok, true, 'myRestrictions answers ' + JSON.stringify(r) + ' for everybody; the Apply form swallows the error and shows no restricted dates at all');
});

// =====================================================================================
// L7 (Low). Approvals: the refresh keeps the scroll position in pixels, but a request that arrives is drawn above
// the going-out / late-early cards, so another card stands under the finger. Approve acts on one tap.
// =====================================================================================
uiTest('L7 Approvals: when a new request arrives, the card under the finger must still be the same card after the refresh', out => {
  assert.equal(out.UE_error, undefined, out.UE_error);
  const cardOf = s => String(s).split(' @ ')[1];
  assert.equal(cardOf(out.UE_after), cardOf(out.UE_before), 'the finger was on "' + out.UE_before + '"; after the refresh the same spot is "' + out.UE_after + '"');
});

// =====================================================================================
// L8 (Low). Fields outside TEXT_ARGS that still take a non-text value (API only, owner / manager).
// =====================================================================================
test('L8 an override whose reason code is not text must be refused, not stored as "[object Object]"', () => {
  const w = world();
  const r = w.doPost(['2026-11-20', '09:00'], 'overrideLeave', 'varun', Object.assign(leave(['2026-11-29']), { forPersonId: 'neha', overrideReason: 'Wedding in the family', reasonCode: { a: 1 } }));
  const stored = (w.sheet('LeaveRequests')[0] || {}).reasonCode;
  assert.ok(!r.ok, 'accepted (' + JSON.stringify(r.data) + ') and stored with reason code "' + stored + '", which Aakash sees on the Staff leaves card');
});

// =====================================================================================
// L9 (Low). Grace table screen: a number above 31 is refused with no hint.
// =====================================================================================
uiTest('L9 Grace table: a grace of 40 must be saved, or the screen must say what is wrong', out => {
  assert.equal(out.UF_error, undefined, out.UF_error);
  assert.equal(out.UF_plainSave, 'Saved.', 'test set-up: the table as shown is saved');
  assert.ok(out.UF_toast === 'Saved.' || /31|at most|maximum/i.test(out.UF_toast) || out.UF_max, 'the screen answers only "' + out.UF_toast + '"; the field has no maximum (max = ' + out.UF_max + ')');
});
