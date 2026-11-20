// Sheet store on a fake grid of plain-text cells, the API dispatcher, and the built bundle.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Store = require('../src/server/store.js');
const Api = require('../src/server/api.js');
const Core = require('../src/server/core.js');
const { TABS } = require('../src/server/schema.js');
const { env, seed } = require('./helpers.js');

// A fake Sheet: every cell is text, exactly like the real Sheet with plain-text format.
function fakeGrid() {
  const tabs = {};
  return {
    tabs,
    tabNames: () => Object.keys(tabs),
    addTab: name => { tabs[name] = []; },
    read: name => (tabs[name] || []).map(r => r.slice()),
    append: (name, row) => { tabs[name].push(row.map(String)); },
    writeRow: (name, i, row) => { tabs[name][i] = row.map(String); },
  };
}

test('setup creates every tab and is safe to run twice', () => {
  const g = fakeGrid();
  const first = Store.setup(g);
  assert.equal(Object.keys(g.tabs).length, Object.keys(TABS).length);
  assert.ok(first.includes('seeded Rules'));
  const snapshot = JSON.stringify(g.tabs);
  assert.deepEqual(Store.setup(g), []);
  assert.equal(JSON.stringify(g.tabs), snapshot);
});

test('upgrade adds a missing column without touching data', () => {
  const g = fakeGrid(); Store.setup(g);
  g.tabs.People[0] = g.tabs.People[0].filter(h => h !== 'phone'); // an older sheet without "phone"
  g.tabs.People.push(['neha', 'Neha']);
  const done = Store.setup(g);
  assert.deepEqual(done, ['columns People: phone']);
  assert.equal(g.tabs.People[1][1], 'Neha');
});

test('round trip through text cells keeps types: dates stay text, numbers, booleans, JSON', () => {
  const g = fakeGrid(); Store.setup(g);
  const db = Store.open(g);
  db.insert('LeaveRequests', { id: 'L1', personId: 'neha', kind: 'full', dates: ['2026-11-25'], submittedAt: 1795000000000,
    penaltyEmergency: false, extremeEmergency: true, approvals: {}, history: [{ at: 1, by: 'neha' }], status: 'Approved' });
  db.update('LeaveRequests', 'L1', { status: 'Cancelled', run: 3 });
  const again = Store.open(g).rows('LeaveRequests')[0]; // a fresh request reads from the cells
  assert.deepEqual(again.dates, ['2026-11-25']);
  assert.equal(again.submittedAt, 1795000000000);
  assert.equal(again.penaltyEmergency, false);
  assert.equal(again.extremeEmergency, true);
  assert.equal(again.status, 'Cancelled');
  assert.equal(again.run, 3);
  assert.deepEqual(again.history, [{ at: 1, by: 'neha' }]);
  assert.throws(() => db.update('LeaveRequests', 'L1', { nope: 1 }));
  assert.throws(() => db.update('LeaveRequests', 'missing', { status: 'x' }));
});

// The whole leave flow again, but on the Sheet store instead of the memory store.
function sheetWorld() {
  const g = fakeGrid(); Store.setup(g);
  const mem = seed();
  const db0 = Store.open(g);
  mem.db.rows('People').forEach(p => db0.insert('People', p));
  const ctx = (date, hhmm) => ({ db: Store.open(g), env, now: mem.ist(date, hhmm) }); // new db per request, like the server
  return { g, ctx, actor: mem.actor };
}
const leave = (dates, extra) => ({ kind: 'full', dates, reasonCode: 'Personal work', reasonText: 'Bank work', ...extra });

test('leave flow on the Sheet store: auto-approve, clash block, concurrency', () => {
  const w = sheetWorld();
  assert.equal(Core.submitLeave(w.ctx('2026-11-20', '10:00'), w.actor('Vikas'), leave(['2026-11-25'])).status, 'Approved');
  assert.equal(Core.previewLeave(w.ctx('2026-11-20', '10:01'), w.actor('Neha'), leave(['2026-11-25'])).decision, 'blocked');
  const a = Core.submitLeave(w.ctx('2026-11-24', '12:00'), w.actor('Bhawna'), leave(['2026-11-25']));
  const b = Core.submitLeave(w.ctx('2026-11-24', '12:01'), w.actor('Pooja'), leave(['2026-11-25']));
  assert.equal(Core.decideLeave(w.ctx('2026-11-24', '12:05'), w.actor('Aakash'), a.id, true).status, 'Approved');
  assert.equal(Core.decideLeave(w.ctx('2026-11-24', '12:06'), w.actor('Aakash'), b.id, true).status, 'Rejected – clash');
  assert.ok(w.g.tabs.Audit.length > 4);
});

function apiWorld() {
  const w = sheetWorld();
  const call = (when, action, who, args) => Api.handle(w.ctx(...when), { action, clientVersion: 1, args, ...(who || {}) });
  const t = ['2026-11-20', '10:00'];
  // Owner signs in first (bootstrap phone), sets PINs, approves phones.
  const c = w.ctx(...t);
  c.db.update('People', 'varun', { pinSalt: 's', pinHash: env.sha256('s:9999') });
  const varun = { personId: 'varun', deviceToken: call(t, 'login', null, { personId: 'varun', pin: '9999' }).data.deviceToken };
  const signIn = (id, pin) => {
    call(t, 'setPin', varun, { personId: id, pin });
    const r = call(t, 'login', null, { personId: id, pin }).data;
    call(t, 'decideDevice', varun, { id: r.deviceId, approve: true });
    return { personId: id, deviceToken: r.deviceToken };
  };
  return { w, call, t, varun, neha: signIn('neha', '1111'), vikas: signIn('vikas', '2222'), aakash: signIn('aakash', '3333') };
}

test('API: nothing private without an approved phone; old app versions are refused', () => {
  const a = apiWorld();
  assert.equal(a.call(a.t, 'myLeaves', null).code, 'AUTH');
  assert.equal(a.call(a.t, 'myLeaves', { personId: 'neha', deviceToken: 'guess' }).code, 'AUTH');
  assert.equal(a.call(a.t, 'myLeaves', { personId: 'vikas', deviceToken: a.neha.deviceToken }).code, 'AUTH');
  assert.equal(Api.handle(a.w.ctx(...a.t), { action: 'myLeaves', clientVersion: 0, ...a.neha }).code, 'UPDATE');
  assert.equal(a.call(a.t, 'nope', a.neha).code, 'UNKNOWN');
  assert.deepEqual(Object.keys(a.call(a.t, 'names').data[0]), ['id', 'name']);
});

test('API privacy: no reply to a staff member ever contains salary, PIN or token data', () => {
  const a = apiWorld();
  a.w.ctx(...a.t).db.insert('PayInfo', { personId: 'vikas', fixedSalary: 17000, targetAllowance: 2000, disciplineBonus: 500, dutyHours: 9 });
  a.call(a.t, 'submitLeave', a.vikas, leave(['2026-11-25']));
  const replies = ['me', 'myLeaves', 'notifications', 'names', 'pending', 'devices']
    .map(action => JSON.stringify(a.call(a.t, action, a.neha)))
    .concat(JSON.stringify(a.call(a.t, 'previewLeave', a.neha, leave(['2026-11-25']))));
  replies.forEach(text => {
    ['17000', 'fixedSalary', 'targetAllowance', 'pinHash', 'pinSalt', 'tokenHash', 'Bank work'].forEach(secret => {
      assert.equal(text.includes(secret), false, 'leaked ' + secret + ' in ' + text.slice(0, 80));
    });
  });
  assert.equal(a.call(a.t, 'pending', a.neha).code, 'FORBIDDEN');
  assert.equal(a.call(a.t, 'devices', a.aakash).code, 'FORBIDDEN');
  assert.equal(a.call(a.t, 'setPin', a.aakash, { personId: 'neha', pin: '0000' }).code, 'FORBIDDEN');
});

test('API privacy: a staff member cannot open another person\u2019s month page', () => {
  const a = apiWorld();
  a.w.ctx(...a.t).db.insert('PayInfo', { personId: 'vikas', fixedSalary: 17000, targetAllowance: 2000, disciplineBonus: 500, dutyHours: 9 });
  assert.equal(a.call(a.t, 'myMonth', a.neha, { personId: 'vikas', month: '2026-11' }).code, 'FORBIDDEN');
  assert.equal(a.call(a.t, 'myMonth', a.neha, { month: '2026-11' }).data.name, 'Neha');
  assert.equal(a.call(a.t, 'myMonth', a.aakash, { personId: 'vikas', month: '2026-11' }).data.name, 'Vikas');
  assert.equal(a.call(a.t, 'checkIn', a.neha, {}).ok, true);
});

test('API: full flow through the dispatcher', () => {
  const a = apiWorld();
  const r = a.call(['2026-11-24', '12:00'], 'submitLeave', a.neha, leave(['2026-11-25']));
  assert.equal(r.data.status, 'Pending with Aakash');
  const pend = a.call(['2026-11-24', '12:01'], 'pending', a.aakash).data;
  assert.equal(pend[0].reasonText, 'Bank work'); // Aakash sees the reason
  assert.equal(a.call(['2026-11-24', '12:02'], 'decideLeave', a.aakash, { id: r.data.id, approve: true }).data.status, 'Approved');
  assert.equal(a.call(['2026-11-24', '12:03'], 'myLeaves', a.neha).data[0].status, 'Approved');
});

test('the Apps Script bundle builds and loads with every module wired', () => {
  require('node:child_process').execFileSync(process.execPath, [path.join(__dirname, '..', 'tools', 'build.js')]);
  const code = fs.readFileSync(path.join(__dirname, '..', 'apps-script', 'Code.js'), 'utf8');
  const sandbox = {}; sandbox.globalThis = sandbox;
  vm.runInNewContext(code, sandbox);
  ['GJCalendar', 'GJClash', 'GJLeave', 'GJMinutes', 'GJSchema', 'GJStore', 'GJCore', 'GJAttendance', 'GJAdmin', 'GJViews', 'GJJobs', 'GJApi'].forEach(n => assert.ok(sandbox[n], n));
  ['doPost', 'doGet', 'setupOrUpgrade'].forEach(n => assert.equal(typeof sandbox[n], 'function', n));
  // The bundle works without require(): run setup + a call inside the sandbox on a fake grid.
  const g = fakeGrid();
  assert.ok(sandbox.GJStore.setup(g).length > 0);
  const reply = sandbox.GJApi.handle({ db: sandbox.GJStore.open(g), now: Date.now(), env }, { action: 'names', clientVersion: 1 });
  assert.equal(reply.ok, true);
});
