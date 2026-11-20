// Round 18 reproducers: everything except the leave / attendance counting rules (round 17 has those).
// Every test here is written to FAIL on the current code (commit aef799d, server version 9, schema 4), for the reason in its name.
// Run: node --test /home/claude/findings/repro-round18.test.js
// The phone-app tests (U...) drive docs/ with python3 + Playwright in demo mode on 127.0.0.1 (repro-round18-ui.py)
// and are skipped when Playwright is missing. Nothing inside /home/claude/gj-leave is written.
const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const ROOT = '/home/claude/gj-leave/';
const Store = require(ROOT + 'src/server/store.js');
const Api = require(ROOT + 'src/server/api.js');
const Jobs = require(ROOT + 'src/server/jobs.js');
const Clash = require(ROOT + 'src/rules/clash.js');
const { wrap } = require(ROOT + 'src/server/cachegrid.js');
const { TABS } = require(ROOT + 'src/server/schema.js');
const { env, seed } = require(ROOT + 'test/helpers.js');

// ---------- A fake Sheet that follows gjGrid_ in src/gas/main.js call by call (copied from test/round16.test.js) ----------
// gjGrid_.appendMany does ONE setValues per tab, tab after tab; gjGrid_.writeRow does ONE setValues per run of
// neighbouring cells of the row. Each of those is one step. g.arm('append Rules#4') makes that step fail once, as a
// Sheets service error would; everything written before it stays, as on the real Sheet.
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
  /** A cell changed by hand in the Sheet (the read cache is emptied, as after its 10 minutes). */
  function handEdit(tab, pick, col, text) {
    const head = g.tabs[tab][0], c = head.indexOf(col); let n = 0;
    g.tabs[tab].forEach((row, i) => { if (i && pick(Object.fromEntries(head.map((h, k) => [h, row[k]])))) { row[c] = text; n += 1; } });
    cache.m.clear();
    assert.equal(n > 0, true, 'test set-up: no ' + tab + ' row to edit');
  }
  return { g, cache, mem, doPost, job, sheet, who, handEdit };
}
const leave = (dates, extra) => Object.assign({ kind: 'full', dates, reasonCode: 'Personal work', reasonText: 'Bank work' }, extra);
const JPEG = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAEB';
const must = r => { assert.equal(r.ok, true, 'test set-up: ' + JSON.stringify(r)); return r.data; };
const setPinHash = (w, id, pin) => { Store.open(w.g).update('People', id, { pinSalt: 's', pinHash: env.sha256('s:' + pin) }); w.cache.m.clear(); };
const D = '2026-11-20';

// =====================================================================================================
// M1 - setupOrUpgrade on a new Sheet: the Sheet fails while the default clash rules are being written (one
//      append per rule). Run again, as the error message invites: the rules that were not written are never
//      written, because "Rules has rows" is taken as "rules are seeded".
// =====================================================================================================
test('M1 first setup fails after 2 of the 4 default clash rules were written; running setup again reports nothing to do for Rules and the Repairing rules (C3, C4) never exist', () => {
  const g = gasGrid();
  g.arm('append Rules#4');                                  // #1 = header row, #2 = C1, #3 = C2, #4 = C3
  assert.throws(() => Store.setup(g, { today: '2026-11-01' }), /Spreadsheets failed/, 'test set-up: the first run must fail');
  assert.equal(g.log.includes('FAIL append Rules#4'), true, 'test set-up: the failure was not reached: ' + g.log.join(' | '));
  g.arm('');
  Store.setup(g, { today: '2026-11-01' });                  // the owner runs setupOrUpgrade again
  Store.setup(g, { today: '2026-11-01' });                  // and once more: "Nothing to do. Already up to date."
  assert.deepEqual(Store.open(g).rows('Rules').map(r => r.id), Clash.DEFAULT_RULES.map(r => r.id), 'after a completed setup the Sheet holds every default clash rule');
});

// =====================================================================================================
// M2 - a "kind" cell of the DayMinutes tab changed by hand (here: "Late" with a capital letter). minutes.js
//      throws "Unknown event kind" and every screen and job that counts that person's month answers ERROR.
// =====================================================================================================
function lateWorld() {
  const w = world();
  must(w.doPost([D, '11:20'], 'checkIn', 'harsh', { photo: JPEG, thumb: JPEG })); // 50 min late: one DayMinutes row
  assert.equal(w.sheet('DayMinutes').length, 1, 'test set-up: one minutes row');
  w.handEdit('DayMinutes', r => r.personId === 'harsh', 'kind', 'Late');
  return w;
}
test('M2a DayMinutes "kind" typed as "Late" by hand: Harsh\'s Today screen cannot load any more (so he cannot check out, or check in on the following days of the month)', () => {
  const w = lateWorld();
  const today = w.doPost([D, '18:00'], 'today', 'harsh', {}), next = w.doPost(['2026-11-21', '10:20'], 'today', 'harsh', {});
  assert.deepEqual({ today: today.ok || today.code, nextDay: next.ok || next.code }, { today: true, nextDay: true });
});
test('M2b the same cell: the month report of the whole shop answers "Something went wrong" for Aakash and Varun', () => {
  const w = lateWorld();
  const r = w.doPost([D, '18:00'], 'monthReport', 'aakash', { month: '2026-11' });
  assert.equal(r.ok || r.code, true);
});
test('M2c the same cell: the hourly job stops with an error, so nobody gets the "bank 80% used / next one is a violation" warnings', () => {
  const w = lateWorld();
  assert.doesNotThrow(() => w.job([D, '18:00'], 'hourly', null));
});

// =====================================================================================================
// L1 - MonthSheet rows damaged by hand (round 16 L7, remnant). The person rows are now handled on the server
//      (`damaged` list); the confirmation row and a correction row are not, and the phone never shows the list (U1).
// =====================================================================================================
test('L1a month report: the "result" cell of the lock confirmation row damaged by hand: the report answers "Something went wrong", before and after the lock', () => {
  const w = world();
  must(w.doPost(['2026-11-02', '10:00'], 'lockMonth', 'aakash', { month: '2026-10' }));       // Aakash confirms: a "lock-ack" row
  w.handEdit('MonthSheet', r => r.personId === 'lock-ack', 'result', '{"by":"Aaka');
  const before = w.doPost(['2026-11-02', '10:05'], 'monthReport', 'varun', { month: '2026-10' });
  must(w.doPost(['2026-11-02', '10:06'], 'lockMonth', 'varun', { month: '2026-10' }));        // the lock itself still works
  const after = w.doPost(['2026-11-02', '10:07'], 'monthReport', 'varun', { month: '2026-10' });
  assert.deepEqual({ before: before.ok || before.code, after: after.ok || after.code }, { before: true, after: true });
});
test('L1b month report: a correction row damaged by hand is handed to the phone as an empty entry (the screen then cannot be drawn)', () => {
  const w = world();
  must(w.doPost(['2026-11-02', '10:00'], 'lockMonth', 'aakash', { month: '2026-10' }));
  must(w.doPost(['2026-11-02', '10:01'], 'lockMonth', 'varun', { month: '2026-10' }));
  must(w.doPost(['2026-11-02', '10:02'], 'addCorrection', 'varun', { month: '2026-10', personId: 'neha', note: 'One leave less' }));
  w.handEdit('MonthSheet', r => r.personId === 'correction', 'result', '{"name":"Ne');
  const rep = must(w.doPost(['2026-11-02', '10:05'], 'monthReport', 'varun', { month: '2026-10' }));
  assert.equal(rep.corrections.every(c => c && typeof c.name === 'string'), true, 'every correction handed to the phone has a name and a note: ' + JSON.stringify(rep.corrections));
});

// =====================================================================================================
// M3 - owner bootstrap repeated within 15 minutes (round 16 M2 fix): the token is issued again also when the
//      first token is already in use, to anyone who has the owner's PIN and a phone of the same kind.
// =====================================================================================================
test('M3 the owner signed in 5 minutes ago and is using the app; a second phone of the same kind with his PIN signs in: it is let in as owner at once and the owner\'s phone is signed out', () => {
  const w = world({ noPhones: true });
  setPinHash(w, 'varun', '4321');
  const label = 'Android phone, Chrome';
  const first = must(w.doPost([D, '10:00'], 'login', null, { personId: 'varun', pin: '4321', deviceLabel: label }));
  const owner = { personId: 'varun', deviceToken: first.deviceToken };
  assert.equal(first.deviceStatus, 'approved', 'test set-up: bootstrap');
  must(w.doPost([D, '10:01'], 'me', owner));                                             // the reply was NOT lost: the phone is in use
  must(w.doPost([D, '10:03'], 'setPin', owner, { personId: 'neha', pin: '1111' }));
  const second = must(w.doPost([D, '10:05'], 'login', null, { personId: 'varun', pin: '4321', deviceLabel: label }));
  const stillIn = w.doPost([D, '10:06'], 'me', owner);
  assert.deepEqual({ secondPhone: second.deviceStatus, ownerStillSignedIn: stillIn.ok || stillIn.code }, { secondPhone: 'pending', ownerStillSignedIn: true });
});

// =====================================================================================================
// L4 - a day that does not count (the person's roster Sunday off, a shop-closed day): nothing is counted
//      (assumption 55), but the reply, the shop board and the owner's daily summary still say "late".
// =====================================================================================================
test('L4a check-in entered for Manish on his roster Sunday off (22 Nov, 11:00): the reply says 90 minutes late (the phone prints "Saved. 90 min late."), the board says 0 and nothing is counted', () => {
  const w = world(); const S = '2026-11-22';
  const r = must(w.doPost([S, '15:00'], 'manualCheckIn', 'aakash', { personId: 'manish', date: S, time: '11:00', reason: 'Phone was dead' }));
  const onBoard = must(w.doPost([S, '15:01'], 'board', 'aakash', {})).people.filter(p => p.id === 'manish')[0];
  assert.deepEqual({ state: onBoard.state, board: onBoard.lateMinutes, counted: w.sheet('DayMinutes').length }, { state: 'Roster off', board: 0, counted: 0 }, 'test set-up: a roster Sunday off, nothing counted');
  assert.equal(r.lateMinutes, 0, 'the reply the phone prints agrees with the board and the count');
});
test('L4b shop-closed day: Harsh comes in at 12:00; nothing is counted, but the board and the owner\'s daily summary list him as 90 minutes late', () => {
  const w = world(); const C = '2026-11-23';
  must(w.doPost([C, '08:00'], 'setSetting', 'varun', { key: 'closedDays', value: [C] }));
  must(w.doPost([C, '12:00'], 'checkIn', 'harsh', { photo: JPEG, thumb: JPEG }));
  assert.equal(w.sheet('DayMinutes').filter(m => m.minutes > 0).length, 0, 'test set-up: nothing is counted on a closed day');
  const onBoard = must(w.doPost([C, '12:05'], 'board', 'aakash', {})).people.filter(p => p.id === 'harsh')[0];
  const summary = w.job([C, '21:00'], 'endOfDay', null).summary.filter(l => /^Late:/.test(l))[0];
  assert.deepEqual({ board: onBoard.lateMinutes, summary }, { board: 0, summary: 'Late: none' });
});

// =====================================================================================================
// Phone app (python3 + Playwright, demo mode). One browser run for all U tests.
// =====================================================================================================
let ui = null;
function phone() {
  if (ui) return ui;
  try { ui = JSON.parse(execFileSync('python3', ['/home/claude/findings/repro-round18-ui.py'], { encoding: 'utf8', timeout: 240000 })); }
  catch (e) { ui = { skip: 'python3 did not answer: ' + String(e.message).slice(0, 200) }; }
  return ui;
}
function uiTest(name, fn) {
  test(name, t => { const r = phone(); if (r.skip) return t.skip(r.skip); fn(r); });
}
uiTest('U1a (L1) phone, month report of a locked month with one damaged row: Harsh is missing from the list and the screen says nothing about a damaged or missing row', r => {
  assert.equal(r.U1_error, undefined, 'test set-up: ' + r.U1_error);
  assert.deepEqual(r.U1_serverDamaged, ['harsh'], 'test set-up: the server names the damaged row');
  assert.equal(/Locked/.test(r.U1_screen) && /Neha/.test(r.U1_screen), true, 'test set-up: the locked report is on the screen: ' + r.U1_screen.slice(0, 200));
  assert.match(r.U1_screen, /Harsh|damaged|could not be read|missing/i);
});
uiTest('U1b (L1) phone, a damaged correction row: tapping "‹ Nov 2026" in the month report does nothing at all (no report, no message)', r => {
  assert.equal(r.U1_error, undefined, 'test set-up: ' + r.U1_error);
  assert.match(r.U1b_before, /Dec 2026/, 'test set-up: the report opens on December');
  assert.match(r.U1b_after, /Nov 2026 · Locked|Could not|damaged/);
});
uiTest('U2 (L2) phone, Approvals scrolled to the lower cards; the other approver decides every request; after the automatic refresh the screen is completely empty for 20 seconds', r => {
  assert.equal(r.U2_error, undefined, 'test set-up: ' + r.U2_error);
  assert.equal(r.U2_before.cards >= 5 && r.U2_before.y > 300, true, 'test set-up: scrolled down a list of cards: ' + JSON.stringify(r.U2_before));
  assert.equal(r.U2_after.cards, 0, 'test set-up: the refresh has drawn the empty list');
  assert.notDeepEqual(r.U2_after.visible, [], 'something of the page ("Nothing is waiting.") is on the screen right after the refresh; minHeight was ' + r.U2_after.min);
});
uiTest('U3 (L3) phone, staff Today: the automatic refresh is answered slowly (5 s); meanwhile an early-leaving request is sent and answered; the screen ends on the OLD answer: the request that was just sent is not shown', r => {
  assert.equal(r.U3_error, undefined, 'test set-up: ' + r.U3_error);
  assert.deepEqual(r.U3_server, ['neha early 18:00 Pending'], 'test set-up: the request is saved on the server');
  assert.match(r.U3_card, /Pending with Aakash/);
});
uiTest('U4 (L5) phone signed in, the app is opened while the first call fails (no connection): the sign-in form with the PIN field is shown instead of "Could not load / Try again"', r => {
  assert.equal(r.U4_error, undefined, 'test set-up: ' + r.U4_error);
  assert.match(r.U4_first, /Hello, Harsh/, 'test set-up: signed in before the app was opened again');
  assert.deepEqual({ pinField: r.U4_pinField, tryAgain: r.U4_tryAgain }, { pinField: 0, tryAgain: 1 }, 'screen was: ' + r.U4_screen);
});
