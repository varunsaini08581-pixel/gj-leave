// Round 6 reproducers: UPGRADE AND DEPLOY SAFETY.
// Every test here is written to FAIL on the current code, for the reason given in its name and message.
// Run: node --test /home/claude/findings/repro-round6.test.js
// Nothing under /home/claude/gj-leave is written by this file (it never runs tools/build.js).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ROOT = '/home/claude/gj-leave';
const SRC = ROOT + '/src/server/';
const Store = require(SRC + 'store.js');
const Api = require(SRC + 'api.js');
const Jobs = require(SRC + 'jobs.js');
const Schema = require(SRC + 'schema.js');
const { wrap } = require(SRC + 'cachegrid.js');
const Cal = require(ROOT + '/src/rules/calendar.js');
const { env, seed } = require(ROOT + '/test/helpers.js');

// ---------- A fake Sheet that behaves like gjGrid_ in src/gas/main.js ----------
// read() of a missing tab = [] ; headers() of a missing tab = [] ; any write to a missing tab throws
// (getSheetByName() is null) BEFORE anything is written, exactly like the "plan first" loop of appendMany.
// A cell may hold a formula the owner typed: read() returns what the cell shows, a write replaces the formula.
function sheetGrid() {
  const tabs = {}, formulas = {};
  const need = n => { if (!tabs[n]) throw new TypeError("Cannot read properties of null (reading 'getLastRow')"); return tabs[n]; };
  const g = {
    tabs, formulas, reads: {},
    tabNames: () => Object.keys(tabs),
    addTab: n => { tabs[n] = []; },
    read: n => { g.reads[n] = (g.reads[n] || 0) + 1; return (tabs[n] || []).map(r => r.slice()); },
    headers: n => (tabs[n] && tabs[n][0] || []).slice(),
    tail: (n, k) => (tabs[n] || []).slice(1).slice(-k).map(r => r.slice()),
    append: (n, row) => g.appendRows(n, [row]),
    appendRows: (n, rows) => g.appendMany([{ tab: n, rows }])[n],
    appendMany: batch => {
      const plan = batch.map(b => ({ b, sh: need(b.tab) })), first = {};
      plan.forEach(p => { first[p.b.tab] = p.sh.length; p.b.rows.forEach(r => p.sh.push(r.map(String))); });
      return first;
    },
    writeRow: (n, i, row) => {
      const sh = need(n), out = (sh[i] || []).slice();
      row.forEach((c, k) => { out[k] = String(c); delete formulas[n + '!' + i + ',' + k]; });
      sh[i] = out;
    },
  };
  return g;
}
function fakeCache() {
  const m = new Map();
  return { m, getAll: keys => { const o = {}; keys.forEach(k => { if (m.has(k)) o[k] = m.get(k); }); return o; }, put: (k, v) => { m.set(k, v); }, putAll: map => { Object.keys(map).forEach(k => m.set(k, map[k])); } };
}
let vn = 0; const ver = () => 'v' + (++vn);

// The Sheet as the FIRST deployed version of the schema made it (PROGRESS.md: "Schema version 2 (3 new columns)",
// Thumbs tab added at 17:41, thumbId / shortId / createdBy / phone counters added by later fixes).
const V1 = JSON.parse(JSON.stringify(Schema.TABS));
delete V1.Thumbs;
V1.People = V1.People.filter(c => c !== 'pinLockLevel');
V1.Devices = V1.Devices.filter(c => c !== 'pinTries' && c !== 'pinLockedUntil');
V1.LeaveRequests = V1.LeaveRequests.filter(c => c !== 'override' && c !== 'remindedAt');
V1.Punches = V1.Punches.filter(c => c !== 'thumbId');
V1.DayMinutes = V1.DayMinutes.filter(c => c !== 'shortId');
V1.Restrictions = V1.Restrictions.filter(c => c !== 'createdBy');

const PIN = '4321';
const JPEG = 'data:image/jpeg;base64,' + 'A'.repeat(200);

/**
 * A world that mirrors doPost in src/gas/main.js on a Sheet whose tabs have the given headers.
 * opts.tabs: header map (default: the current schema). opts.cached === false: no CacheService.
 */
function world(opts) {
  opts = opts || {};
  const g = sheetGrid(), T = opts.tabs || Schema.TABS;
  Object.keys(T).forEach(t => { g.addTab(t); g.tabs[t].push(T[t].slice()); });
  const cache = fakeCache(), mem = seed();
  const put = (tab, obj) => g.tabs[tab].push(g.tabs[tab][0].map(h => Store.encode(tab, h, obj[h])));
  mem.db.rows('People').forEach(p => put('People', Object.assign({}, p, { pinSalt: 's', pinHash: env.sha256('s:' + PIN) })));
  const who = {};
  mem.db.rows('People').forEach(p => {
    put('Devices', { id: 'dev_' + p.id, personId: p.id, tokenHash: env.sha256('tok-' + p.id), label: '', status: 'approved', requestedAt: 1, decidedAt: 1, decidedBy: 'test', pinTries: 0, pinLockedUntil: 0 });
    who[p.id] = { personId: p.id, deviceToken: 'tok-' + p.id };
  });
  const photos = {};
  function doPost(when, action, person, args) {
    const db = Store.open(opts.cached === false ? g : wrap(g, cache, Object.keys(Schema.TABS), ver), { buffer: true });
    let depth = 0;
    const e = Object.assign({}, env, {
      savePhoto(name, data) { photos[name] = data; return 'photo_' + name; }, readPhoto(id) { return 'FULL-PHOTO:' + id; },
      withLock(fn) { if (depth > 0) return fn(); depth += 1; try { return fn(); } finally { try { db.flush(); } finally { depth -= 1; } } },
    });
    const reply = Api.handle({ db, now: mem.ist(...when), env: e }, Object.assign({ action, clientVersion: 1, args: args || {} }, person ? who[person] : {}));
    try { db.flush(); } catch (err) { reply.flushError = err.message; }
    return reply;
  }
  const rows = tab => Store.open(g).rows(tab);
  const jobCtx = when => ({ db: Store.open(g), now: mem.ist(...when), env: Object.assign({}, env, { withLock: fn => fn() }) });
  return { g, cache, doPost, rows, put, ist: mem.ist, photos, jobCtx, setup: () => Store.setup(g) };
}
const leave = (dates, text) => ({ kind: 'full', dates, reasonCode: 'Sick', reasonText: text || 'fever' });
const lockBoth = (w, when, month) => { w.doPost([when, '10:00'], 'lockMonth', 'aakash', { month }); return w.doPost([when, '10:01'], 'lockMonth', 'varun', { month }); };
const mailer = { quota: () => 100, send: () => {} };

// =====================================================================================================
// H1  New code on a Sheet that has not been upgraded (setupOrUpgrade forgotten or not yet run)
// =====================================================================================================

test('H1a new code on a version-1 Sheet: 5 wrong PINs must lock the account (today the 5th crashes, is thrown away, and guessing never stops)', () => {
  const w = world({ tabs: V1 });
  const codes = [];
  for (let i = 1; i <= 8; i++) codes.push(w.doPost(['2026-11-24', '09:0' + i], 'login', null, { personId: 'neha', pin: '0000' }).code);
  const neha = w.rows('People').find(p => p.id === 'neha');
  assert.ok(neha.pinLockedUntil > w.ist('2026-11-24', '09:08'),
    'no lock after 8 wrong PINs. Replies: ' + codes.join(',') + '; People.pinTries=' + neha.pinTries + ', pinLockedUntil=' + JSON.stringify(neha.pinLockedUntil));
});

test('H1b new code on a version-1 Sheet: a staff member who mistyped the PIN once can still sign in with the right PIN', () => {
  const w = world({ tabs: V1 });
  assert.equal(w.doPost(['2026-11-24', '09:00'], 'login', null, { personId: 'neha', pin: '0000' }).code, 'LOGIN');
  const r = w.doPost(['2026-11-24', '09:01'], 'login', null, { personId: 'neha', pin: PIN });
  assert.notEqual(r.code, 'ERROR', 'right PIN answers "' + r.message + '" (update of the missing column People.pinLockLevel). It also tells a guesser the PIN was right.');
});

test('H1c new code on a version-1 Sheet: check-in either works or says clearly that the Sheet needs the upgrade, and leaves no photo behind', () => {
  const w = world({ tabs: V1 });
  const r = w.doPost(['2026-11-24', '09:25'], 'checkIn', 'neha', { photo: JPEG, thumb: JPEG, lat: 29.1, lng: 75.7, accuracy: 10 });
  assert.ok(r.ok || r.code !== 'ERROR', 'every check-in answers only "' + r.message + '" (the Thumbs tab does not exist)');
  if (!r.ok) assert.equal(Object.keys(w.photos).length, 0, 'the refused check-in still left a photo in Drive');
});

test('H1d new code on a version-1 Sheet: an override must not be accepted while its written reason is silently dropped', () => {
  const w = world({ tabs: V1, cached: false });
  const r = w.doPost(['2026-11-20', '10:00'], 'overrideLeave', 'varun', { forPersonId: 'neha', kind: 'full', dates: ['2026-11-27'], overrideReason: 'Sister wedding, I allow it', reasonText: 'wedding' });
  const stored = w.rows('LeaveRequests')[0];
  assert.ok(!r.ok || (stored && stored.override), 'the app answered ' + JSON.stringify(r.data) + ' but the Sheet has no "override" column: the reason is gone and the month report will not list the override');
});

test('H1e SCHEMA_VERSION does something: after setup the Sheet says which schema it has (today a Sheet that said 1 still says 1)', () => {
  const w = world({ tabs: V1 });
  w.put('Settings', { key: 'schemaVersion', value: '1', updatedAt: '', updatedBy: 'setup' });
  w.setup();
  const v = w.rows('Settings').find(s => s.key === 'schemaVersion').value;
  assert.equal(String(v), String(Schema.SCHEMA_VERSION), 'Settings.schemaVersion is still "' + v + '" after the upgrade, and no code ever reads it');
});

// =====================================================================================================
// H2  A change made by hand in the Sheet while the read cache is warm (data 10 min, header rows 6 hours)
// =====================================================================================================

test('H2a owner inserts a column in the Sheet: the next request must not write its rows shifted by one column', () => {
  const w = world({});
  assert.equal(w.doPost(['2026-11-20', '09:25'], 'submitLeave', 'neha', leave(['2026-11-27'])).data.status, 'Approved'); // warms the cache
  // The owner adds a "remark" column after column B in three tabs (Insert > Column right).
  ['LeaveRequests', 'Notifications', 'Audit'].forEach(t => w.g.tabs[t].forEach((row, i) => row.splice(2, 0, i === 0 ? 'remark' : '')));
  const r = w.doPost(['2026-11-20', '09:40'], 'submitLeave', 'vikas', leave(['2026-11-28']));
  assert.equal(r.ok, true);
  const stored = w.rows('LeaveRequests').find(x => x.personId === 'vikas');
  assert.equal(stored.status, 'Approved', 'Vikas was told "' + r.data.status + '" but the Sheet row is shifted: kind=' + JSON.stringify(stored.kind) + ', status=' + JSON.stringify(stored.status));
});

test('H2b owner deletes one row in the Sheet: the next approval must not overwrite another person\'s request', () => {
  const w = world({});
  w.doPost(['2026-11-20', '09:25'], 'submitLeave', 'neha', leave(['2026-11-30']));
  const b = w.doPost(['2026-11-20', '09:26'], 'submitLeave', 'manish', leave(['2026-12-01', '2026-12-02', '2026-12-03', '2026-12-04']));
  const c = w.doPost(['2026-11-20', '09:27'], 'submitLeave', 'harsh', leave(['2026-12-07', '2026-12-08', '2026-12-09', '2026-12-10']));
  assert.equal(b.data.status, 'Special – waiting'); assert.equal(c.data.status, 'Special – waiting');
  w.g.tabs.LeaveRequests.splice(1, 1); // the owner deletes Neha's row by hand (a test row, a mistake, or a sort moves it)
  assert.equal(w.doPost(['2026-11-20', '09:30'], 'decideLeave', 'aakash', { id: b.data.id, approve: true }).ok, true);
  const people = w.g.tabs.LeaveRequests.slice(1).map(r => r[1]);
  assert.deepEqual(people, ['manish', 'harsh'], 'rows now on the Sheet: ' + people.join(', ') + ' (Harsh\'s request was overwritten by a second copy of Manish\'s)');
});

// =====================================================================================================
// H3  Month lock
// =====================================================================================================

function lockedOctober() {
  const w = world({ cached: false });
  w.put('PayInfo', { personId: 'neha', fixedSalary: 17000, targetAllowance: 2000, disciplineBonus: 500, dutyHours: 9 });
  const a = w.doPost(['2026-10-05', '10:00'], 'submitLeave', 'neha', leave(['2026-10-12']));
  w.doPost(['2026-10-13', '09:28'], 'checkIn', 'neha', { photo: JPEG, thumb: JPEG });                   // forgot to check out
  const p = w.doPost(['2026-10-19', '20:00'], 'submitLeave', 'neha', leave(['2026-10-20']));             // still waiting for Aakash
  assert.equal(a.data.status, 'Approved'); assert.equal(p.data.status, 'Pending with Aakash');
  assert.equal(lockBoth(w, '2026-11-02', '2026-10').data.locked, true);
  return { w, approvedId: a.data.id, pendingId: p.data.id };
}

test('H3a after the month is locked, old data of that month is not changed in place (handoff 3.11: corrections are new logged entries)', () => {
  const { w, approvedId, pendingId } = lockedOctober();
  const tries = [
    ['manualCheckOut', 'aakash', { personId: 'neha', date: '2026-10-13', time: '15:00', reason: 'forgot' }],
    ['cancelLeave', 'aakash', { id: approvedId, reason: 'entered by mistake' }],
    ['decideLeave', 'aakash', { id: pendingId, approve: false, reason: 'too late' }],
    ['recordIncident', 'aakash', { personId: 'neha', item: 'dress', date: '2026-10-14', note: 'no belt' }],
    ['overrideLeave', 'varun', { forPersonId: 'neha', kind: 'full', dates: ['2026-10-22'], overrideReason: 'ok', reasonText: 'r' }],
    ['setSetting', 'varun', { key: 'closedDays', value: ['2026-10-12'] }],
  ];
  const accepted = tries.filter(t => w.doPost(['2026-11-03', '11:00'], t[0], t[1], t[2]).ok).map(t => t[0]);
  assert.deepEqual(accepted, [], 'accepted for locked October: ' + accepted.join(', '));
});

test('H3b a locked month shows the same numbers to the staff member as in the locked report', () => {
  const { w, approvedId, pendingId } = lockedOctober();
  w.doPost(['2026-11-03', '11:00'], 'manualCheckOut', 'aakash', { personId: 'neha', date: '2026-10-13', time: '15:00', reason: 'forgot' });
  w.doPost(['2026-11-03', '11:01'], 'decideLeave', 'aakash', { id: pendingId, approve: false, reason: 'too late' });
  w.doPost(['2026-11-03', '11:02'], 'setPay', 'varun', { personId: 'neha', fixedSalary: 30000, targetAllowance: 2000, disciplineBonus: 500, dutyHours: 9 });
  const report = w.doPost(['2026-11-03', '11:05'], 'monthReport', 'varun', { month: '2026-10' }).data.people.find(x => x.personId === 'neha');
  const mine = w.doPost(['2026-11-03', '11:06'], 'myMonth', 'neha', { month: '2026-10' }).data;
  assert.deepEqual({ leaves: mine.leaves.total, violations: mine.violations.length }, { leaves: report.leaves.total, violations: report.violations.length },
    'locked report: ' + report.leaves.total + ' leaves, ' + report.violations.length + ' violations; Neha\'s own page for the same month: ' + mine.leaves.total + ' leaves, ' + mine.violations.length + ' violations');
});

// =====================================================================================================
// Medium
// =====================================================================================================

test('M1 one damaged cell (the owner retypes a date by hand in LeaveRequests.dates) must not take the app down for everyone', () => {
  const w = world({ cached: false });
  w.doPost(['2026-11-20', '09:25'], 'submitLeave', 'neha', leave(['2026-11-27']));
  const L = w.g.tabs.LeaveRequests; L[1][L[0].indexOf('dates')] = '2026-11-28'; // was ["2026-11-27"]
  const broken = [];
  [['submitLeave', 'bhawna', leave(['2026-12-05'])], ['myMonth', 'neha', { month: '2026-11' }], ['board', 'aakash', {}], ['calendar', 'aakash', { month: '2026-11' }], ['monthReport', 'varun', { month: '2026-11' }]]
    .forEach(t => { if (!w.doPost(['2026-11-20', '10:00'], t[0], t[1], t[2]).ok) broken.push(t[0]); });
  ['endOfDay', 'hourly'].forEach(j => { try { Jobs.run(w.jobCtx(['2026-11-20', '21:30']), j, mailer); } catch (e) { broken.push('job ' + j + ' (' + e.message + ')'); } });
  assert.deepEqual(broken, [], 'answering "Something went wrong" or crashing: ' + broken.join('; '));
});

test('M2 an unexpected server error leaves a trace somewhere (today: a generic reply and nothing in any log)', () => {
  const seen = [], keep = { error: console.error, warn: console.warn, log: console.log };
  console.error = console.warn = console.log = (...a) => seen.push(a.join(' '));
  globalThis.Logger = { log: (...a) => seen.push(a.join(' ')) };
  let r;
  try { r = Api.handle({ db: { rows() { throw new Error('Service Spreadsheets failed while accessing document'); } }, now: 1, env }, { action: 'names', clientVersion: 1 }); }
  finally { Object.assign(console, keep); delete globalThis.Logger; }
  assert.equal(r.code, 'ERROR');
  assert.ok(seen.length > 0 || r.ref, 'reply: ' + JSON.stringify(r) + '; logged lines: 0. Nobody can find out what failed after a deploy.');
});

test('M3a setup: a header with a space typed after it ("status ") must not hide that column\'s data behind a new empty column', () => {
  const w = world({ cached: false });
  w.doPost(['2026-11-20', '09:25'], 'submitLeave', 'neha', leave(['2026-11-27']));
  const hs = w.g.tabs.LeaveRequests[0]; hs[hs.indexOf('status')] = 'status ';
  let done = []; try { done = w.setup(); } catch (e) { return; } // a clear refusal would also be fine
  assert.equal(w.rows('LeaveRequests')[0].status, 'Approved', 'setup said: ' + done.filter(d => /LeaveRequests/.test(d)).join(' | ') + '. The approved leave now reads with status ""');
});

test('M3b setup: a cleared header row must be refused (or restored in place), not rewritten to the right of the data', () => {
  const w = world({ cached: false });
  w.g.tabs.People[0] = w.g.tabs.People[0].map(() => ''); // the owner wiped row 1 of People
  try { w.setup(); } catch (e) { return; }
  const names = w.rows('People').map(p => p.name).filter(Boolean);
  assert.equal(names.length, 11, 'after setup the app sees ' + names.length + ' people; header row is now: ' + JSON.stringify(w.g.tabs.People[0].slice(0, 22)));
});

test('M3c setup on a Sheet that is already in use: a renamed or deleted tab is reported, not silently replaced by an empty one', () => {
  const w = world({ cached: false });
  w.setup(); // the Sheet is in use: Settings.schemaVersion exists
  w.g.tabs['People (old)'] = w.g.tabs.People; delete w.g.tabs.People;
  let done; try { done = w.setup(); } catch (e) { return; }
  assert.ok(false, 'setup answered ' + JSON.stringify(done) + ' and the app now has ' + w.rows('People').length + ' people');
});

test('M4a version gate: a phone still running the app from before the photo check-in is told to update (it sends the same clientVersion 1 as today\'s app)', () => {
  const w = world({ cached: false });
  const r = w.doPost(['2026-11-24', '09:25'], 'checkIn', 'neha', { lat: 29.1, lng: 75.7, accuracy: 10 }); // the first deployed app.js: no photo, no thumb
  assert.equal(r.code, 'UPDATE', 'the old app gets "' + r.code + ': ' + r.message + '" for ever. MIN_CLIENT_VERSION=' + Api.MIN_CLIENT_VERSION + ' has never moved.');
});

test('M4b version gate: the app\'s version lives in the app code and the page forces fresh files (today: in config.js, and plain <script src="app.js">)', () => {
  const html = fs.readFileSync(ROOT + '/docs/index.html', 'utf8'), app = fs.readFileSync(ROOT + '/docs/app.js', 'utf8');
  const plain = (html.match(/<script src="[^"?]+"/g) || []).length;
  const ownVersion = /CLIENT_VERSION\s*=\s*\d+/.test(app) || /clientVersion:\s*\d+/.test(app);
  assert.ok(plain === 0 && ownVersion, plain + ' script tags without a version in the address; app.js carries its own version number: ' + ownVersion +
    '. A new config.js (version 2) with an old cached app.js passes the gate; an old config.js with a new app.js is refused.');
});

// A tiny DOM so docs/app.js can boot in Node (same idea as test/round2.test.js F14).
function bootApp(opts) {
  const made = [], reloads = { n: 0 }, store = opts.store || {};
  const el = tag => {
    const e = { tag, kids: [], handlers: {}, attrs: {}, options: [], style: {}, hidden: false, textContent: '', value: '', className: '', src: '',
      appendChild(c) { this.kids.push(c); return c; }, replaceChildren(...c) { this.kids = c; }, replaceWith() {},
      addEventListener(k, fn) { this.handlers[k] = fn; }, setAttribute(k, v) { this.attrs[k] = v; } };
    made.push(e); return e;
  };
  const sandbox = { console: { log() {}, error() {}, warn() {} }, setTimeout, clearTimeout, Promise, JSON, Date, Object, Math, String, Number, Array, Error,
    document: { getElementById: () => el('div'), createElement: el, createTextNode: t => ({ text: t }), body: el('body') },
    localStorage: { getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = v; }, removeItem: k => { delete store[k]; } },
    sessionStorage: { getItem: k => (('s:' + k) in store ? store['s:' + k] : null), setItem: (k, v) => { store['s:' + k] = v; }, removeItem: k => { delete store['s:' + k]; } },
    location: { search: '', origin: 'https://x.github.io', pathname: '/gj-leave/', href: 'https://x.github.io/gj-leave/', reload() { reloads.n += 1; }, replace() { reloads.n += 1; } },
    navigator: { userAgent: 'test' }, scrollTo() {},
    fetch: (url, o) => Promise.resolve({ json: () => Promise.resolve(opts.reply(JSON.parse(o.body))) }) };
  sandbox.window = sandbox;
  if (opts.config) sandbox.GJ_CONFIG = opts.config;
  vm.runInNewContext(fs.readFileSync(ROOT + '/docs/app.js', 'utf8'), sandbox);
  return { made, reloads, store, sandbox };
}

test('M4c "Please update the app": the phone must not reload in a loop when the reload brings the same cached files', () => {
  // Runs in a child process: the app's own promise chains reject on purpose here, which would otherwise fail this test for the wrong reason.
  const script = `
    process.on('unhandledRejection', () => {});
    const bootApp = ${bootApp.toString()};
    const fs = require('node:fs'), vm = require('node:vm'), ROOT = ${JSON.stringify(ROOT)};
    (async () => {
      const store = {}; let reloads = 0, calls = 0;
      for (let visit = 0; visit < 4; visit++) { // each reload = the same cached app.js boots again
        const a = bootApp({ store, config: { API_URL: 'https://server.example/exec', CLIENT_VERSION: 1 }, reply: () => { calls += 1; return { ok: false, code: 'UPDATE', message: 'Please update the app.' }; } });
        await new Promise(r => setTimeout(r, 20));
        reloads += a.reloads.n;
        if (!a.reloads.n) break;
      }
      console.log(JSON.stringify({ reloads, calls })); process.exit(0);
    })();`;
  const out = require('node:child_process').spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', cwd: '/home/claude/findings' });
  const got = JSON.parse(out.stdout.trim().split('\n').pop());
  assert.ok(got.reloads <= 1, 'the page reloaded itself ' + got.reloads + ' times in ' + got.calls + ' server calls and would go on (one server call every 2-3 s per phone, until the browser cache gives a new file)');
});

test('M4d the server tells the phone which server build is running (new app + old server today ends in a bare "Unknown action.")', () => {
  const w = world({ cached: false });
  const me = w.doPost(['2026-11-24', '09:25'], 'me', 'neha', {});
  const names = w.doPost(['2026-11-24', '09:25'], 'names', null, {});
  const app = fs.readFileSync(ROOT + '/docs/app.js', 'utf8');
  const known = (me.data && (me.data.serverVersion || me.data.build)) || me.serverVersion || me.v || names.serverVersion || names.v;
  assert.ok(known || /UNKNOWN/.test(app), 'no server version in any reply, and app.js has no handling for the reply code UNKNOWN');
});

test('M5 production: if config.js does not arrive, the app must stop with an error, not switch to demo mode (sample data, every PIN 1234, nothing saved)', async () => {
  const a = bootApp({ config: undefined, reply: () => ({ ok: true, data: [] }) });
  await new Promise(r => setTimeout(r, 20));
  const demo = a.made.filter(e => e.tag === 'script' && /mock-server\.js/.test(e.src));
  assert.equal(demo.length, 0, 'window.GJ_CONFIG is missing and the app loaded mock-server.js: the staff member sees a working app whose check-in is saved nowhere');
});

test('M6 a night when the 21:00 job did not run (Google trigger failure, quota, owner removed the timers): the absent check is caught up the next day', () => {
  const w = world({ cached: false });
  // Tue 24 Nov: nobody checks in, the job never runs. Wed 25 Nov 21:30: the job runs.
  Jobs.run(w.jobCtx(['2026-11-25', '21:30']), 'endOfDay', mailer);
  const days = [...new Set(w.rows('LeaveRequests').map(r => r.dates[0]))].sort();
  assert.ok(days.includes('2026-11-24'), 'absent rows exist only for: ' + days.join(', ') + '. 24 Nov is never looked at again.');
});

test('M7 after about 6 weeks of normal use the Punches tab no longer fits one cache value: the same screen must not read the Sheet on every call', () => {
  const w = world({});
  const staff = ['neha', 'vikas', 'harsh', 'raunak', 'manish', 'muskan', 'bhawna', 'pooja', 'anita'];
  for (let d = 0; d < 45; d++) {
    const date = Cal.addDays('2026-11-02', d);
    staff.forEach(s => w.doPost([date, '09:20'], 'checkIn', s, { photo: JPEG, thumb: JPEG, lat: 29.1, lng: 75.7, accuracy: 10 }));
    staff.forEach(s => w.doPost([date, '20:10'], 'checkOut', s, {}));
  }
  w.g.reads = {};
  for (let i = 0; i < 3; i++) w.doPost(['2026-12-17', '10:0' + i], 'today', 'neha', {});
  assert.ok((w.g.reads.Punches || 0) <= 1, 'three identical "Today" screens read the whole Punches tab from the Sheet ' + w.g.reads.Punches + ' times (' +
    w.g.tabs.Punches.length + ' rows, ' + JSON.stringify(w.g.tabs.Punches).length + ' characters; the cache takes 95,000)');
});

test('M8 a person who left before the month was locked is still in that month\'s locked report', () => {
  const w = world({ cached: false });
  w.doPost(['2026-10-05', '10:00'], 'submitLeave', 'raunak', leave(['2026-10-12']));
  const me = w.doPost(['2026-11-01', '10:00'], 'getSettings', 'varun', {}).data.people.find(p => p.id === 'raunak');
  assert.equal(w.doPost(['2026-11-01', '10:00'], 'savePerson', 'varun', Object.assign({}, me, { active: false })).ok, true); // Raunak left on 31 Oct
  assert.equal(lockBoth(w, '2026-11-02', '2026-10').data.locked, true);
  const rep = w.doPost(['2026-11-02', '10:02'], 'monthReport', 'varun', { month: '2026-10' }).data;
  assert.ok(rep.people.some(p => p.personId === 'raunak'), 'locked October has ' + rep.people.length + ' people and Raunak (worked all of October, 1 leave) is not one of them; it can never be added');
});

test('M9 a violation created by a check-out that Aakash enters two days later can still be disputed for 24 hours', () => {
  const w = world({ cached: false });
  w.doPost(['2026-11-24', '09:28'], 'checkIn', 'neha', { photo: JPEG, thumb: JPEG });
  assert.equal(w.doPost(['2026-11-26', '11:00'], 'manualCheckOut', 'aakash', { personId: 'neha', date: '2026-11-24', time: '17:00', reason: 'forgot' }).ok, true);
  const v = w.rows('Violations')[0];
  const r = w.doPost(['2026-11-26', '11:05'], 'disputeViolation', 'neha', { id: v.id, text: 'I left at 18:30' });
  assert.equal(r.ok, true, 'five minutes after the violation appeared: "' + r.message + '" (createdAt was set to the entered leaving time, ' + new Date(v.createdAt + 19800000).toISOString().slice(0, 16) + ' IST)');
});

// =====================================================================================================
// Low
// =====================================================================================================

test('L1 photo with an empty id: a staff member must not get a colleague\'s FULL photo (rows written before the thumbId column have a blank thumbId)', () => {
  const w = world({ cached: false });
  // Vikas checked in this morning on the previous server version: photoId set, thumbId blank.
  w.put('Punches', { id: 'p_old', personId: 'vikas', date: '2026-11-24', kind: 'in', at: w.ist('2026-11-24', '10:55'), photoId: 'DRIVE_FILE_OF_VIKAS', thumbId: '' });
  const r = w.doPost(['2026-11-24', '12:00'], 'photo', 'neha', { id: '' });
  assert.equal(r.ok, false, 'Neha received ' + JSON.stringify(r.data));
});

test('L2 lockMonth refuses a month key that is not YYYY-MM (today "2026-1", "", "2026-13" and "2026-11 " are locked for ever)', () => {
  const w = world({ cached: false });
  const locked = ['2026-1', '', '2026-13', '2026-11 '].filter(m => { const r = lockBoth(w, '2027-01-05', m); return r.ok && r.data.locked; });
  assert.deepEqual(locked, [], 'locked: ' + JSON.stringify(locked) + '; junk rows in MonthSheet: ' + w.rows('MonthSheet').length);
});

test('L3 values typed by hand in the Sheet: "17,000", " TRUE" and every (no quotes) are understood or refused, not read as blank / false / no roster', () => {
  const got = { salary: Store.decode('PayInfo', 'fixedSalary', '17,000'), active: Store.decode('People', 'active', ' TRUE'), sundayOff: Store.decode('People', 'sundayOff', 'every') };
  assert.deepEqual(got, { salary: 17000, active: true, sundayOff: 'every' }, 'read as ' + JSON.stringify(got));
});

test('L4 an app update of one row leaves the owner\'s own extra column alone (today the whole row is rewritten: a formula there becomes fixed text)', () => {
  const w = world({ cached: false });
  const b = w.doPost(['2026-11-20', '09:26'], 'submitLeave', 'manish', leave(['2026-12-01', '2026-12-02', '2026-12-03', '2026-12-04']));
  const L = w.g.tabs.LeaveRequests, col = L[0].length;
  L[0][col] = 'days (owner)'; L[1][col] = '4'; w.g.formulas['LeaveRequests!1,' + col] = '=COUNTA(SPLIT(D2,","))'; // the owner's helper column
  w.doPost(['2026-11-20', '09:30'], 'decideLeave', 'aakash', { id: b.data.id, approve: true });
  assert.ok(w.g.formulas['LeaveRequests!1,' + col], 'the formula in the owner\'s column was replaced by the text it showed');
});
