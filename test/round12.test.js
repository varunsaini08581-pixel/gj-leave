// Round 12 reproducers: access control, privacy, login / phones, store and concurrency, jobs, phone app.
// Every test here is written to FAIL on the current code (commit 0d23639, server version 9), for the reason in its name.
// Run: node --test /home/claude/findings/repro-round12.test.js
// The phone-app tests (U...) drive docs/ with python3 + Playwright in demo mode on 127.0.0.1 (repro-round12-ui.py)
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

// ---------- A fake Sheet that behaves like gjGrid_ in src/gas/main.js (same helper as test/round10.test.js) ----------
const CELL_LIMIT = 50000;
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
  return { m, getAll: keys => { const o = {}; keys.forEach(k => { if (m.has(k)) o[k] = m.get(k); }); return o; }, put: (k, v) => { m.set(k, v); }, putAll: map => { Object.keys(map).forEach(k => m.set(k, map[k])); }, remove: k => m.delete(k) };
}
let vn = 0; const ver = () => 'v' + (++vn);
/** Mirrors doPost and gjJob_ in src/gas/main.js. hooks.whileWaitingForLock(): another request runs completely while this one waits for the lock. */
function world() {
  const g = fakeGrid(); Store.setup(g, { today: '2026-11-01' });
  const cache = fakeCache(); const mem = seed();
  const db0 = Store.open(g);
  mem.db.rows('People').forEach(p => db0.insert('People', Object.assign({}, p)));
  const who = {};
  mem.db.rows('People').forEach(p => {
    db0.insert('Devices', { id: 'dev_' + p.id, personId: p.id, tokenHash: env.sha256('tok-' + p.id), label: '', status: 'approved', requestedAt: 1, decidedAt: 1, decidedBy: 'test' });
    who[p.id] = { personId: p.id, deviceToken: 'tok-' + p.id };
  });
  const photoCalls = [];
  function mk(hooks) {
    const db = Store.open(wrap(g, cache, Object.keys(TABS), ver), { buffer: true });
    let depth = 0;
    const e = Object.assign({}, env, {
      photos: env.photos,
      savePhoto(name, data) { photoCalls.push(name); return env.savePhoto(name + '#' + photoCalls.length, data); }, // Drive: every createFile is a new file
      removePhoto(id) { const i = photoCalls.findIndex((n, k) => 'photo_' + n + '#' + (k + 1) === id); if (i !== -1) photoCalls.splice(i, 1, null); photoCalls.removed = (photoCalls.removed || 0) + 1; }, // added with the fix: the refused upload is removed again
      withLock(fn) {
        if (depth > 0) return fn();
        if (hooks.whileWaitingForLock) { const f = hooks.whileWaitingForLock; hooks.whileWaitingForLock = null; f(); }
        depth += 1;
        try { return fn(); } finally { try { db.flush(); } finally { depth -= 1; } }
      },
    });
    return { db, e };
  }
  function doPost(when, action, person, args, hooks) {
    const { db, e } = mk(hooks || {});
    const req = Object.assign({ action, clientVersion: 1, args: args || {} }, typeof person === 'string' ? who[person] : (person || {}));
    const quiet = console.error; console.error = () => {};
    let reply;
    try { reply = Api.handle({ db, now: mem.ist(...when), env: e }, req); db.flush(); } finally { console.error = quiet; }
    return JSON.parse(JSON.stringify(reply));
  }
  function job(when, name, mailer) {
    const { db, e } = mk({});
    e.ownerEmail = 'owner@example.test';
    try { return Jobs.run({ db, now: mem.ist(...when), env: e }, name, mailer); } finally { db.flush(); }
  }
  const sheet = tab => Store.open(g).rows(tab); // what the Sheet really holds
  return { g, cache, mem, doPost, job, sheet, who, photoCalls };
}
const leave = (dates, extra) => Object.assign({ kind: 'full', dates, reasonCode: 'Personal work', reasonText: 'Bank work' }, extra);
const JPEG = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAEB';
const must = r => { assert.equal(r.ok, true, 'test set-up: ' + JSON.stringify(r)); return r.data; };

// ---------- phone app: one Playwright run for all U... tests ----------
let uiResult = null;
function ui() {
  if (uiResult) return uiResult;
  const { spawnSync } = require('node:child_process');
  const r = spawnSync('python3', [__dirname + '/repro-round12-ui.py'], { encoding: 'utf8', timeout: 280000 });
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
// H1 (High). The owner can lock himself out for good, with ordinary taps.
// The phone keeps ONE approval token (localStorage "gjleave.device"). Signing in as another person on the same
// phone, with that person's right PIN, overwrites it. The owner is the one person who knows other people's PINs
// (he creates them), and trying a staff account on his own phone is the natural way to "see what staff see".
// After that his own sign-in makes a NEW phone request. Only the owner can approve a phone, and the bootstrap rule
// no longer applies (his old phone still stands as "approved"). Nobody can approve it: no phone approvals, no PIN
// resets, no disputes, no special approvals, no Settings, until someone edits the Devices tab by hand.
// The same end state follows from a lost, broken or replaced owner phone, or cleared browser data.
// =====================================================================================
uiTest('H1a phone app: owner signs out, signs in as a staff member on his own phone, then as himself: he must get back in', out => {
  assert.equal(out.UA_error, undefined, out.UA_error);
  assert.equal(out.UA_signedIn, true, 'the owner is not signed in. Screen: "' + out.UA_screen.replace(/\n/g, ' / ') + '". His phones on the server: ' + JSON.stringify(out.UA_ownerDevices) +
    ' (the approved one is the token the phone has just thrown away; the pending one can be approved only by the owner)');
});
test('H1b server: an owner whose only phone lost its token (new phone, cleared browser, H1a) has no way back in', () => {
  const w = world();
  must(w.doPost(['2026-11-20', '09:00'], 'setPin', 'varun', { personId: 'varun', pin: '4821' }));
  const again = must(w.doPost(['2026-11-20', '09:05'], 'login', {}, { personId: 'varun', pin: '4821', deviceToken: null, deviceLabel: 'Android phone, Chrome' }));
  // Who can let him in? Not Aakash:
  const byManager = w.doPost(['2026-11-20', '09:06'], 'decideDevice', 'aakash', { id: again.deviceId, approve: true });
  const seenByManager = must(w.doPost(['2026-11-20', '09:06'], 'approvals', 'aakash', {})).devices.length;
  assert.ok(again.ok === true || byManager.ok === true,
    'right name and PIN on a new phone: ' + JSON.stringify({ ok: again.ok, deviceStatus: again.deviceStatus }) + '; Aakash cannot approve it (' + byManager.code + ', he sees ' + seenByManager +
    ' phone requests); the owner cannot approve it either, he is not signed in anywhere. There is no recovery in the app.');
});

// =====================================================================================
// M1 (Medium). The automatic refresh still empties a form: typing() is asked only when the refresh STARTS.
// The answer comes 2 to 3 seconds later (PROGRESS: about 2.3 s per screen on the real server) and is drawn without
// asking again. Whatever was typed in between is gone. Every 30 seconds, and whenever the app comes to the front.
// =====================================================================================
uiTest('M1a phone app (staff, Today): a time typed while the 30-second refresh is on its way must stay', out => {
  assert.equal(out.UB_error, undefined, out.UB_error);
  assert.equal(out.UB_staffTime, '11:40', 'the late / early time typed 2.5 s before the refresh answer arrived is now "' + out.UB_staffTime + '"');
});
uiTest('M1b phone app (Aakash, Approvals): a reject reason typed while the refresh is on its way must stay', out => {
  assert.equal(out.UB_error, undefined, out.UB_error);
  assert.equal(out.UB_rejectReason, 'Two people are already away', 'the reject reason is now "' + out.UB_rejectReason + '"');
});

// =====================================================================================
// M2 (Medium). Every automatic refresh (30 s) redraws Today / Approvals through show(), which scrolls to the top.
// Aakash, reading the 4th request, finds another person's card under his finger; Approve is a single tap.
// =====================================================================================
uiTest('M2 phone app (Aakash, Approvals with 6 requests): the automatic refresh must not move the page under the finger', out => {
  assert.equal(out.UC_error, undefined, out.UC_error);
  assert.equal(out.UC_scrollAfter, out.UC_scrollBefore, 'scrolled to ' + out.UC_scrollBefore + ' px, after the refresh the page is at ' + out.UC_scrollAfter +
    ' px; the card in the middle of the screen was ' + out.UC_cardBefore + ', now it is ' + out.UC_cardAfter);
});

// =====================================================================================
// M3 (Medium). A reason is shown as one unbroken line when it has no spaces (a pasted link, "aaaa..."): the form
// allows 200 characters, the server 2,000. The whole Approvals screen (and "Staff leaves") becomes several
// phones wide, the tab bar with it: "More" is off the screen. One staff member can do this to Aakash and Varun.
// =====================================================================================
uiTest('M3 phone app (Aakash, Approvals): a 171-character reason without spaces must not make the screen wider than the phone', out => {
  assert.equal(out.UE_error, undefined, out.UE_error);
  assert.ok(out.UE_pageWidth <= out.UE_phoneWidth + 1, 'the page is ' + out.UE_pageWidth + ' px wide on a ' + out.UE_phoneWidth + ' px phone; the right edge of the "More" tab is at ' + out.UE_moreTabRight + ' px');
});

// =====================================================================================
// M4 (Medium). store.js write(): the appended rows (Notifications, Audit) go to the Sheet first, the changed
// rows (the request itself) after them. When the Sheet fails between the two (a time-out in the middle of a
// flush), the person has been TOLD "Leave: Approved" (in the app and by e-mail), the Audit tab says it was
// decided, and the request is still "Pending with Aakash". Aakash only sees "Something went wrong".
// =====================================================================================
test('M4 a Sheet error in the middle of a flush must not leave "Leave: Approved" told to the person while the request is still pending', () => {
  const w = world();
  const id = must(w.doPost(['2026-11-19', '15:00'], 'submitLeave', 'vikas', leave(['2026-11-21']))).id;
  const before = w.sheet('Notifications').length;
  const real = w.g.writeRow; let once = true;
  w.g.writeRow = function (tab) { if (once && tab === 'LeaveRequests') { once = false; throw new Error('Service Spreadsheets timed out while accessing document.'); } return real.apply(this, arguments); };
  const reply = w.doPost(['2026-11-20', '10:00'], 'decideLeave', 'aakash', { id, approve: true });
  w.g.writeRow = real;
  const status = w.sheet('LeaveRequests').find(r => r.id === id).status;
  const told = w.sheet('Notifications').slice(before).filter(n => n.to === 'vikas').map(n => n.title);
  assert.equal(reply.code, 'ERROR', JSON.stringify(reply));
  assert.ok(!(status === 'Pending with Aakash' && told.indexOf('Leave: Approved') !== -1),
    'Aakash got "' + reply.message + '", the request is "' + status + '", and Vikas has been told: ' + JSON.stringify(told) + ' (last Audit row: ' + w.sheet('Audit').slice(-1)[0].action + ')');
});

// =====================================================================================
// M5 (Medium). A cell damaged by hand still takes actions down for everyone (round 6 fixed the row-level cases).
// Settings "shopPoint" is read with a bare JSON.parse inside checkIn: one mistyped character there (the owner
// correcting the location in the Sheet) and NO ONE can check in with location on; each try has already put a
// photo in Drive. Same class, found by the same sweep: Rules.members / Rules.emergencyIfAllPresent /
// Restrictions.appliesTo holding valid JSON that is not a list (12, null, {"a":1}) -> every leave, late / early
// and going-out request of everyone answers "Something went wrong".
// =====================================================================================
test('M5a a mistyped shop location in the Settings tab must not stop every check-in', () => {
  const w = world();
  must(w.doPost(['2026-11-19', '09:00'], 'setShopPoint', 'varun', { samples: [{ lat: 29.15, lng: 75.72 }, { lat: 29.15, lng: 75.72 }, { lat: 29.15, lng: 75.72 }] }));
  const row = w.g.tabs.Settings.find(r => r[0] === 'shopPoint'); row[1] = '{"lat":29.1512,"lng":75.7231'; w.cache.m.clear(); // typed in the Sheet, the closing bracket is lost
  const tries = ['harsh', 'neha', 'manish'].map(p => w.doPost(['2026-11-20', '10:25'], 'checkIn', p, { photo: JPEG, thumb: JPEG, lat: 29.15, lng: 75.72, accuracy: 8 }));
  assert.deepEqual(tries.map(r => r.ok), [true, true, true], 'check-in replies: ' + JSON.stringify(tries.map(r => r.code + ': ' + r.message)) + '; photos already stored in Drive for these refused tries: ' + w.photoCalls.length);
});
test('M5b a clash rule whose members cell holds something that is not a list must not stop every leave request', () => {
  const w = world();
  const head = w.g.tabs.Rules[0], c = head.indexOf('members'); w.g.tabs.Rules[1][c] = 'null'; w.cache.m.clear();
  const r = w.doPost(['2026-11-20', '10:00'], 'submitLeave', 'bhawna', leave(['2026-11-27']));
  const p = w.doPost(['2026-11-20', '10:00'], 'previewLeave', 'manish', leave(['2026-11-28']));
  assert.ok(r.code !== 'ERROR' && p.code !== 'ERROR', 'submitLeave: ' + JSON.stringify(r) + ' previewLeave: ' + JSON.stringify(p));
});

// =====================================================================================
// L1 (Low). The late / early switch is not a form field, so typing() does not see it: "I will leave early"
// falls back to "I will be late" at the next refresh. The time entered afterwards is then sent as a LATE request.
// =====================================================================================
uiTest('L1 phone app (staff, Today): "I will leave early" must still be selected after the automatic refresh', out => {
  assert.equal(out.UD_error, undefined, out.UD_error);
  assert.equal(out.UD_kind, 'I will leave early', 'selected after 31 s: "' + out.UD_kind + '"');
});

// =====================================================================================
// L2 (Low). 320 px wide phone: the status chip "Special – waiting for Aakash and Varun" does not wrap.
// =====================================================================================
uiTest('L2 phone app at 320 px (Aakash, Approvals, a request that needs both approvers): nothing wider than the phone', out => {
  assert.equal(out.UF_error, undefined, out.UF_error);
  assert.ok(out.UF_pageWidth <= 321, 'the page is ' + out.UF_pageWidth + ' px wide on a 320 px phone (chip: "' + out.UF_status + '")');
});

// =====================================================================================
// L3 (Low). "Sign out" with no connection: the phone shows the sign-in screen, but the server was never told
// (the failed call is swallowed). The token on the phone keeps opening everything without the PIN.
// =====================================================================================
uiTest('L3 phone app: after "Sign out" without a connection the phone token must not open the account without the PIN', out => {
  assert.equal(out.UG_error, undefined, out.UG_error);
  // Changed with the fix: with no connection the server cannot be told, so the honest answer is that the phone is NOT shown as signed out.
  assert.ok(out.UG_loginScreenShown === false || out.UG_tokenStillOpens === false, 'the sign-in screen is shown (with only the general "No connection" toast, nothing about the sign-out), and the token alone still answers "me"');
});

// =====================================================================================
// L4 (Low). E-mail job: ANY failure of a send (Google's "Service invoked too many times in a short time", a
// passing mail outage) is filed as "the address was refused" (-2) and those alerts are never e-mailed.
// =====================================================================================
test('L4 e-mail job: a send that failed once for a passing reason must be tried again on the next run', () => {
  const w = world();
  must(w.doPost(['2026-11-20', '09:00'], 'savePerson', 'varun', { id: 'aakash', name: 'Aakash', group: 'Manager', role: 'manager', dutyStart: '10:00', dutyEnd: '19:00', sundayOff: [], email: 'aakash@example.test', active: true }));
  must(w.doPost(['2026-11-20', '09:10'], 'submitLeave', 'vikas', leave(['2026-11-21'])));   // -> "Leave request" alert for Aakash
  const sent = [];
  w.job(['2026-11-20', '09:15'], 'emails', { quota: () => 80, send: () => { throw new Error('Service invoked too many times in a short time: gmail. Try Utilities.sleep(1000) between calls.'); } });
  w.job(['2026-11-20', '09:20'], 'emails', { quota: () => 80, send: to => { sent.push(to); } });
  assert.ok(sent.indexOf('aakash@example.test') !== -1, 'second run sent to: ' + JSON.stringify(sent) + '; Aakash\'s alerts are marked ' +
    JSON.stringify([...new Set(w.sheet('Notifications').filter(n => n.to === 'aakash').map(n => n.emailedAt))]) + ' (-2 = never again)');
});

// =====================================================================================
// L5 (Low). Round 10 made the staff free-text fields typed; the manager / owner ones are not. A reason that
// arrives as an object is stored and shown to the staff member as "[object Object]" (decideLeave, cancelLeave,
// decideShort, excuseAbsence, manualCheckIn / Out, recordIncident note, decideDispute note, overrideLeave
// reasonCode / reasonText, saveRule label, saveRestriction note; a list is joined with commas).
// =====================================================================================
test('L5 a reject reason that is not text must be refused, not stored as "[object Object]"', () => {
  const w = world();
  const id = must(w.doPost(['2026-11-19', '15:00'], 'submitLeave', 'vikas', leave(['2026-11-21']))).id;
  const r = w.doPost(['2026-11-20', '10:00'], 'decideLeave', 'aakash', { id, approve: false, reason: { text: 'Two people are away' } });
  const shown = must(w.doPost(['2026-11-20', '10:01'], 'myLeaves', 'vikas', {})).find(x => x.id === id);
  assert.ok(!r.ok, 'accepted: ' + JSON.stringify(r) + '; Vikas sees status "' + shown.status + '" with the reason "' + shown.decisionReason + '"');
});

// =====================================================================================
// L6 (Low). Aakash's own leave ("Pending with Varun") is listed in his own Approvals with Approve / Reject and
// counts in his badge; the buttons can only answer "Nobody approves their own leave".
// =====================================================================================
test('L6 Aakash\'s own waiting leave must not be in his own Approvals list', () => {
  const w = world();
  const id = must(w.doPost(['2026-11-20', '10:00'], 'submitLeave', 'aakash', leave(['2026-12-11']))).id;
  const mine = must(w.doPost(['2026-11-20', '10:01'], 'approvals', 'aakash', {})).leaves.filter(l => l.id === id);
  const tap = w.doPost(['2026-11-20', '10:02'], 'decideLeave', 'aakash', { id, approve: true });
  assert.equal(mine.length, 0, 'listed for him as "' + (mine[0] && mine[0].status) + '"; tapping Approve answers: ' + tap.message);
});

// =====================================================================================
// L7 (Low). The first sign-in on a new phone, sent twice (the reply was lost, the person taps Sign in again):
// two phone requests wait for the owner, same name, same label. Only the second one is the phone in the
// person's hand (the first token never arrived). Nothing tells the owner which one; approving the first changes nothing for the person.
// =====================================================================================
test('L7 a first sign-in repeated after a lost reply must not leave two phone requests the owner cannot tell apart', () => {
  const w = world();
  must(w.doPost(['2026-11-20', '09:00'], 'setPin', 'varun', { personId: 'harsh', pin: '2468' }));
  const args = { personId: 'harsh', pin: '2468', deviceToken: null, deviceLabel: 'Android phone (SM-A155F), Chrome' };
  must(w.doPost(['2026-11-20', '09:05'], 'login', {}, args));                 // the reply (with the token) never reaches the phone
  const second = must(w.doPost(['2026-11-20', '09:06'], 'login', {}, args));  // the person taps Sign in again
  const waiting = must(w.doPost(['2026-11-20', '09:07'], 'approvals', 'varun', {})).devices;
  must(w.doPost(['2026-11-20', '09:08'], 'decideDevice', 'varun', { id: waiting[0].id, approve: true })); // the owner approves the one on top
  const now = w.doPost(['2026-11-20', '09:09'], 'me', { personId: 'harsh', deviceToken: second.deviceToken }, {});
  assert.ok(waiting.length === 1 || now.ok, waiting.length + ' requests wait: ' + JSON.stringify(waiting.map(d => d.name + ' / ' + d.label)) +
    '; the owner approved the first, and Harsh\'s phone still answers: ' + now.message);
});

// =====================================================================================
// L8 (Low). setSetting does not look at "graceTable" at all (round 7 typed the other keys). A table that is not
// a list of rows (API only; the screen always sends rows) is stored, and from then on "My month" answers
// "Something went wrong" for every person and no incident can be recorded.
// =====================================================================================
test('L8 a grace table that is not a list of rows must be refused', () => {
  const w = world();
  const set = w.doPost(['2026-11-20', '10:00'], 'setSetting', 'varun', { key: 'graceTable', value: [null] });
  const month = w.doPost(['2026-11-20', '10:01'], 'myMonth', 'neha', { month: '2026-11' });
  assert.ok(!set.ok, 'stored: ' + JSON.stringify(set) + '; Neha\'s My month now answers: ' + JSON.stringify(month));
});

// =====================================================================================
// L9 (Low). The check-in photo is put into Drive BEFORE the server lock (PREPARE). Two check-ins of one person
// that overlap (double tap, a retry while the first is still running) both store their photo; one check-in is
// recorded. The other file stays in Drive for ever, linked from nowhere.
// =====================================================================================
test('L9 two overlapping check-ins of one person must not leave a second photo in Drive', () => {
  const w = world();
  const a = { photo: JPEG, thumb: JPEG, lat: 29.15, lng: 75.72, accuracy: 5 };
  let inner;
  const outer = w.doPost(['2026-11-20', '10:20'], 'checkIn', 'harsh', a, { whileWaitingForLock: () => { inner = w.doPost(['2026-11-20', '10:20'], 'checkIn', 'harsh', a); } });
  const punches = w.sheet('Punches').filter(p => p.personId === 'harsh' && p.kind === 'in').length;
  assert.equal(punches, 1);
  assert.equal(w.photoCalls.length - (w.photoCalls.removed || 0), 1, 'check-ins recorded: ' + punches + ' (replies: ' + (inner.ok ? 'ok' : inner.code) + ' / ' + (outer.ok ? 'ok' : outer.code) + '), photo files created in Drive: ' + w.photoCalls.length);
});

// =====================================================================================
// L10 (Low). Month report, "Overrides by Varun": the reply carries only the person's id, and the phone prints
// it as it is ("garvit-id4f: 2026-11-25 — reason" for anyone added through the People screen).
// =====================================================================================
test('L10 month report: an override entry must carry the person\'s name, not only the internal id', () => {
  const w = world();
  const pid = must(w.doPost(['2026-11-20', '09:00'], 'savePerson', 'varun', { name: 'Garvit', group: 'Sales', role: 'staff', dutyStart: '10:00', dutyEnd: '19:00', sundayOff: [], active: true })).id;
  must(w.doPost(['2026-11-20', '09:05'], 'overrideLeave', 'varun', leave(['2026-11-25'], { forPersonId: pid, overrideReason: 'Family emergency, cleared by me' })));
  const o = must(w.doPost(['2026-11-20', '09:06'], 'monthReport', 'varun', { month: '2026-11' })).overrides[0];
  assert.equal(o.name, 'Garvit', 'the entry is ' + JSON.stringify(o) + '; docs/app-admin.js prints o.personId + ": " + dates');
});
