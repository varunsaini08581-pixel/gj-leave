// Round 3 reproducers: concurrency, dates, data storage.
// Every test here is written to FAIL on the current code. Run: node --test /home/claude/findings/repro-round3.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const SRC = __dirname + '/../src/server/';
const Store = require(SRC + 'store.js');
const Api = require(SRC + 'api.js');
const Core = require(SRC + 'core.js');
const Att = require(SRC + 'attendance.js');
const Admin = require(SRC + 'admin.js');
const Jobs = require(SRC + 'jobs.js');
const { wrap } = require(SRC + 'cachegrid.js');
const { TABS } = require(SRC + 'schema.js');
const Clash = require('../src/rules/clash.js');
const { env, seed } = require('./helpers.js');

// ---------- A fake Sheet that behaves like gjGrid_ in src/gas/main.js ----------
const CELL_LIMIT = 50000; // Google Sheets: max characters in one cell; setValues throws above it
function fakeGrid() {
  const tabs = {};
  const check = row => row.forEach(c => { if (String(c).length > CELL_LIMIT) throw new Error('Your input contains more than the maximum of 50000 characters in a single cell.'); });
  const g = {
    tabs,
    tabNames: () => Object.keys(tabs),
    addTab: n => { tabs[n] = []; },
    read: n => (tabs[n] || []).map(r => r.slice()),
    headers: n => (tabs[n] && tabs[n][0] || []).slice(),
    tail: (n, k) => tabs[n].slice(1).slice(-k).map(r => r.slice()),
    append: (n, row) => g.appendRows(n, [row]),
    appendRows: (n, rows) => g.appendMany([{ tab: n, rows }])[n],
    // like the real one: tab after tab, no rollback when a later tab fails
    appendMany: batch => { const first = {}; batch.forEach(b => { b.rows.forEach(check); first[b.tab] = tabs[b.tab].length; b.rows.forEach(r => tabs[b.tab].push(r.map(String))); }); return first; },
    writeRow: (n, i, row) => { check(row); tabs[n][i] = row.map(String); },
  };
  return g;
}
function fakeCache() {
  const m = new Map();
  return { m, getAll: keys => { const o = {}; keys.forEach(k => { if (m.has(k)) o[k] = m.get(k); }); return o; }, put: (k, v) => { m.set(k, v); }, putAll: map => { Object.keys(map).forEach(k => m.set(k, map[k])); } };
}
let vn = 0; const ver = () => 'v' + (++vn);

/**
 * A world that mirrors doPost in src/gas/main.js:
 *   ctx = { db: Store.open(cachedGrid, {buffer:true}), now, env }; reply = Api.handle(ctx, request); ctx.db.flush();
 *   env.withLock(fn): take the script lock, run fn, flush inside the lock (finally), release.
 * hooks.whileWaitingForLock(): runs at the moment this request asks for the lock, i.e. another request
 *   holds the lock first and finishes completely (flush + commit) before this one gets it.
 * hooks.duringPhotoUpload(): runs inside env.savePhoto (the Drive upload, before the lock).
 * hooks.beforeFinalFlush(): runs between handle() returning and the final un-locked flush.
 */
function world(opts) {
  const cached = !opts || opts.cached !== false;
  const g = fakeGrid(); Store.setup(g);
  const cache = fakeCache(); const mem = seed();
  const db0 = Store.open(g);
  mem.db.rows('People').forEach(p => db0.insert('People', p));
  const who = {};
  mem.db.rows('People').forEach(p => {
    db0.insert('Devices', { id: 'dev_' + p.id, personId: p.id, tokenHash: env.sha256('tok-' + p.id), label: '', status: 'approved', requestedAt: 1, decidedAt: 1, decidedBy: 'test' });
    who[p.id] = { personId: p.id, deviceToken: 'tok-' + p.id };
  });
  function doPost(when, action, person, args, hooks) {
    hooks = hooks || {};
    const grid = cached ? wrap(g, cache, Object.keys(TABS), ver) : g;
    const db = Store.open(grid, { buffer: true });
    let depth = 0;
    const e = Object.assign({}, env, {
      photos: env.photos,
      savePhoto(name, data) { if (hooks.duringPhotoUpload) hooks.duringPhotoUpload(); return env.savePhoto(name, data); },
      withLock(fn) {
        if (depth > 0) return fn();
        if (hooks.whileWaitingForLock) hooks.whileWaitingForLock();
        depth += 1;
        try { return fn(); } finally { try { db.flush(); } finally { depth -= 1; } }
      },
    });
    const reply = Api.handle({ db, now: mem.ist(...when), env: e }, Object.assign({ action, clientVersion: 1, args: args || {} }, person ? who[person] : {}));
    if (hooks.beforeFinalFlush) hooks.beforeFinalFlush();
    db.flush();
    return reply;
  }
  const sheet = tab => Store.open(g).rows(tab); // what the Sheet really holds
  return { g, cache, mem, doPost, sheet, who };
}
const leave = (dates, extra) => Object.assign({ kind: 'full', dates, reasonCode: 'Personal work', reasonText: 'Bank work' }, extra);
const granted = (w, date) => w.sheet('LeaveRequests').filter(r => (r.status === 'Approved' || r.status === 'Recorded') && r.dates.indexOf(date) !== -1);

// =====================================================================================
// F1 (Critical). The cache's version map is read once per request, BEFORE the lock
// (authenticate reads People). A request that waits for the lock then reads LeaveRequests
// under the OLD version key and gets the copy from before the other request's write.
// =====================================================================================
test('F1a two clashing leave requests sent at the same moment: only one may be auto-approved', () => {
  const w = world();
  w.doPost(['2026-11-20', '09:55'], 'myLeaves', 'neha');                      // any earlier screen: LeaveRequests is in the cache
  const t = ['2026-11-20', '10:00'];
  let vikas;
  const neha = w.doPost(t, 'submitLeave', 'neha', leave(['2026-11-25']), {
    whileWaitingForLock: () => { vikas = w.doPost(t, 'submitLeave', 'vikas', leave(['2026-11-25'])); },
  });
  assert.equal(vikas.data.status, 'Approved');
  // Sales needs 2 of Neha, Vikas, Harsh. Vikas holds the slot, so Neha must be blocked.
  assert.equal(granted(w, '2026-11-25').length, 1, 'both Neha and Vikas are Approved for 25 Nov: ' + JSON.stringify(neha));
});

test('F1b two clashing approvals at the same moment (Part 7 "only one passes")', () => {
  const w = world();
  const a = w.doPost(['2026-11-24', '12:00'], 'submitLeave', 'bhawna', leave(['2026-11-25'])).data;
  const b = w.doPost(['2026-11-24', '12:01'], 'submitLeave', 'pooja', leave(['2026-11-25'])).data;
  assert.equal(a.status, 'Pending with Aakash'); assert.equal(b.status, 'Pending with Aakash');
  w.doPost(['2026-11-24', '12:04'], 'approvals', 'aakash');                   // Aakash opens the approvals screen
  const t = ['2026-11-24', '12:05'];
  // Aakash taps Approve on Bhawna and, before that call has returned, Approve on Pooja (or Varun approves Pooja).
  let first;
  const second = w.doPost(t, 'decideLeave', 'varun', { id: b.id, approve: true }, {
    whileWaitingForLock: () => { first = w.doPost(t, 'decideLeave', 'aakash', { id: a.id, approve: true }); },
  });
  assert.equal(first.data.status, 'Approved');
  assert.equal(second.data && second.data.status, 'Rejected – clash');
});

test('F1c a staff member cancels while Aakash approves: the cancelled leave must not come back as Approved', () => {
  const w = world();
  const r = w.doPost(['2026-11-24', '12:00'], 'submitLeave', 'neha', leave(['2026-11-26'])).data;
  w.doPost(['2026-11-24', '12:04'], 'approvals', 'aakash');
  const t = ['2026-11-24', '12:05'];
  w.doPost(t, 'decideLeave', 'aakash', { id: r.id, approve: true }, {
    whileWaitingForLock: () => { assert.equal(w.doPost(t, 'cancelLeave', 'neha', { id: r.id }).data.status, 'Cancelled'); },
  });
  assert.equal(w.sheet('LeaveRequests')[0].status, 'Cancelled');
});

test('F1d special leave: Aakash and Varun approve at the same moment, one approval is lost', () => {
  const w = world();
  const r = w.doPost(['2026-11-10', '12:00'], 'submitLeave', 'raunak', leave(['2026-11-23', '2026-11-24', '2026-11-25', '2026-11-26'])).data;
  assert.equal(r.status, 'Special – waiting');
  w.doPost(['2026-11-10', '12:04'], 'approvals', 'varun');
  const t = ['2026-11-10', '12:05'];
  w.doPost(t, 'decideLeave', 'varun', { id: r.id, approve: true }, {
    whileWaitingForLock: () => { w.doPost(t, 'decideLeave', 'aakash', { id: r.id, approve: true }); },
  });
  const row = w.sheet('LeaveRequests')[0];
  assert.equal(row.status, 'Approved', 'both said yes, but the Sheet holds ' + JSON.stringify(row.approvals) + ' / ' + row.status);
});

// =====================================================================================
// F2 (High). api.js checkIn reads Punches BEFORE the lock (and before the slow photo
// upload). Att.checkIn, inside the lock, then re-checks on that same request-local copy.
// No cache needed: this fails on the plain Sheet store too.
// =====================================================================================
test('F2 the same check-in sent twice (retry / second tab) stores two check-ins and counts the late minutes twice', () => {
  const w = world({ cached: false });
  const pic = { photo: 'data:image/jpeg;base64,FULL', thumb: 'data:image/jpeg;base64,THUMB' };
  const t = ['2026-11-20', '10:20'];                                           // Neha starts 09:30: 50 min late
  w.doPost(t, 'checkIn', 'neha', pic, { duringPhotoUpload: () => { w.doPost(t, 'checkIn', 'neha', pic); } });
  const ins = w.sheet('Punches').filter(p => p.personId === 'neha' && p.kind === 'in');
  const late = w.sheet('DayMinutes').filter(m => m.personId === 'neha' && m.kind === 'late');
  assert.equal(ins.length, 1, ins.length + ' check-ins, ' + late.reduce((s, m) => s + m.minutes, 0) + ' late minutes counted');
});

// =====================================================================================
// F3 (High). remindBack has no lock: it reads Outings, and its write goes out in the final
// un-locked flush as a WHOLE row built from that old copy.
// =====================================================================================
test('F3 staff taps "Remind" while Aakash confirms the return: the confirmation must survive', () => {
  const w = world({ cached: false });
  const pic = { photo: 'data:image/jpeg;base64,FULL', thumb: 'data:image/jpeg;base64,THUMB' };
  w.doPost(['2026-11-20', '09:30'], 'checkIn', 'neha', pic);
  const o = w.doPost(['2026-11-20', '12:00'], 'goingOut', 'neha', { reason: 'Bank', expectedMinutes: 20 }).data;
  w.doPost(['2026-11-20', '12:01'], 'decideOuting', 'aakash', { id: o.id, approve: true });
  w.doPost(['2026-11-20', '12:20'], 'imBack', 'neha', { id: o.id });
  const t = ['2026-11-20', '12:30'];
  w.doPost(t, 'remindBack', 'neha', { id: o.id }, {
    beforeFinalFlush: () => { assert.equal(w.doPost(t, 'confirmBack', 'aakash', { id: o.id }).data.status, 'Confirmed'); },
  });
  assert.equal(w.sheet('Outings')[0].status, 'Confirmed');
});

// =====================================================================================
// F4 (High). authenticate reads Devices before the lock; decideDevice decides on that copy.
// =====================================================================================
test('F4 two phone requests of one person approved at the same moment: one phone per person', () => {
  const w = world({ cached: false });
  const db = Store.open(w.g);
  ['x', 'y'].forEach(k => db.insert('Devices', { id: 'new_' + k, personId: 'neha', tokenHash: env.sha256('new-' + k), label: k, status: 'pending', requestedAt: 2, decidedAt: '', decidedBy: '' }));
  const t = ['2026-11-20', '10:00'];
  w.doPost(t, 'decideDevice', 'varun', { id: 'new_y', approve: true }, {
    whileWaitingForLock: () => { w.doPost(t, 'decideDevice', 'varun', { id: 'new_x', approve: true }); },
  });
  const ok = w.sheet('Devices').filter(d => d.personId === 'neha' && d.status === 'approved').map(d => d.id);
  assert.equal(ok.length, 1, 'approved phones for Neha: ' + ok.join(', '));
});

// =====================================================================================
// F5 (High). sendEmails: one address that makes MailApp throw. gjJob_ does run() and THEN
// flush(), with no try/finally, so the "emailedAt" marks of the people already mailed in
// this run are never written. Every 5 minutes they are mailed again; the people after the
// bad address are never mailed.
// =====================================================================================
test('F5 one bad e-mail address: the others must get their digest exactly once', () => {
  const g = fakeGrid(); Store.setup(g);
  const db0 = Store.open(g);
  [['a', 'a@example.com'], ['b', 'not-an-address'], ['c', 'c@example.com']].forEach(([id, email]) => {
    db0.insert('People', { id, name: id.toUpperCase(), role: 'staff', active: true, email });
    db0.insert('Notifications', { id: 'n_' + id, to: id, kind: 'decision', title: 'Leave: Approved', body: '', ref: '', createdAt: 1, readAt: '', emailedAt: '' });
  });
  const sent = [];
  const mailer = { quota: () => 100, send: (to) => { if (to.indexOf('@') === -1) throw new Error('Invalid email: ' + to); sent.push(to); } };
  const jobEmails = now => {                                                   // gjJob_('emails') as written in main.js
    const ctx = { db: Store.open(g, { buffer: true }), now, env };
    const result = Jobs.run(ctx, 'emails', mailer);
    ctx.db.flush();
    return result;
  };
  for (let i = 0; i < 3; i++) { try { jobEmails(1000 + i * 300000); } catch (e) { /* the trigger run fails; the next one starts 5 min later */ } }
  assert.deepEqual([sent.filter(x => x === 'a@example.com').length, sent.filter(x => x === 'c@example.com').length], [1, 1],
    'after 3 runs: A mailed ' + sent.filter(x => x === 'a@example.com').length + ' times, C mailed ' + sent.filter(x => x === 'c@example.com').length + ' times');
});

// =====================================================================================
// F6 (Medium). withLock flushes in "finally", also when the action threw half-way.
// decideDress writes dressDecision first and only then calls recordIncident, which can refuse.
// =====================================================================================
test('F6 dress check of a non-staff person confirmed: the action fails but the half of it is saved', () => {
  const w = world({ cached: false });
  const pic = { photo: 'data:image/jpeg;base64,FULL', thumb: 'data:image/jpeg;base64,THUMB', dress: { top: 'issue', trousers: 'ok', shoes: 'ok', belt: 'ok' } };
  const p = w.doPost(['2026-11-20', '10:00'], 'checkIn', 'aakash', pic).data;  // the manager's own check-in gets a dress flag
  assert.equal(w.doPost(['2026-11-20', '10:05'], 'approvals', 'varun').data.dress.length, 1);
  const r = w.doPost(['2026-11-20', '10:06'], 'decideDress', 'varun', { id: p.id, confirm: true });
  assert.equal(r.ok, false);                                                    // "Choose a staff member."
  const punch = w.sheet('Punches').filter(x => x.id === p.id)[0];
  assert.equal(punch.dressDecision, '', 'the call failed, yet dressDecision = ' + punch.dressDecision + ' and Incidents has ' + w.sheet('Incidents').length + ' rows');
});

// =====================================================================================
// F7 (Medium). flush() is not safe to run twice after a failure: appended tabs stay in
// "pending" until ALL appends succeeded, so the retry in doPost appends them again.
// Deterministic trigger: a text above the 50,000-character cell limit (nothing limits
// reasonText / decision reason / dispute text).
// =====================================================================================
test('F7 a write that fails half-way is repeated by the second flush: duplicate rows, and the Audit says something the Sheet does not', () => {
  const w = world({ cached: false });
  const r = w.doPost(['2026-11-24', '12:00'], 'submitLeave', 'neha', leave(['2026-11-26'])).data;
  let reply = null;
  try { reply = w.doPost(['2026-11-24', '12:05'], 'decideLeave', 'aakash', { id: r.id, approve: false, reason: 'x'.repeat(50001) }); } catch (e) { reply = { crashed: e.message }; }
  const audits = w.sheet('Audit').filter(a => a.action === 'leave.decide');
  assert.equal(w.sheet('LeaveRequests')[0].status, 'Pending with Aakash');      // the decision itself was not stored
  assert.equal(audits.length, 0, audits.length + ' "leave.decide" audit rows for a decision that was never stored; reply: ' + JSON.stringify(reply).slice(0, 120));
});

// =====================================================================================
// F8 (High). Rules.members and Restrictions.appliesTo hold NAMES. savePerson may change a
// name; nothing follows.
// =====================================================================================
test('F8 the owner corrects the spelling of a name: the clash rule must still hold', () => {
  const s = seed();
  Clash.DEFAULT_RULES.forEach(r => s.db.insert('Rules', r));                    // as setupOrUpgrade seeds them
  const b = s.db.rows('People').find(p => p.id === 'bhawna');
  Admin.savePerson(s.ctx('2026-11-20', '09:00'), s.actor('Varun'), Object.assign({}, b, { name: 'Bhavna' }));
  assert.equal(Core.submitLeave(s.ctx('2026-11-20', '10:00'), s.actor('Pooja'), leave(['2026-11-25'])).status, 'Approved');
  // Calls needs 1 of Bhawna, Pooja present.
  assert.throws(() => Core.submitLeave(s.ctx('2026-11-20', '10:01'), { id: 'bhawna', name: 'Bhavna', role: 'staff' }, leave(['2026-11-25'])), /Not allowed/);
});

// =====================================================================================
// F9 (Medium). Part 6: "a shop-closed day added after leaves were approved: re-count".
// closedDays is read only by the end-of-day absent job.
// =====================================================================================
test('F9 a shop-closed day added later: the approved leave on that day must not use the quota', () => {
  const s = seed();
  assert.equal(Core.submitLeave(s.ctx('2026-11-20', '10:00'), s.actor('Vikas'), leave(['2026-11-25'])).status, 'Approved');
  Admin.setSetting(s.ctx('2026-11-21', '10:00'), s.actor('Varun'), 'closedDays', ['2026-11-25']);
  assert.equal(Att.myMonth(s.ctx('2026-11-26', '10:00'), 'vikas', '2026-11').leaves.taken, 0);
});

// =====================================================================================
// F10 (Medium). Leave across month end: routing looks at the quota of the FIRST month only.
// =====================================================================================
test('F10 30 Nov + 1 Dec, with December already at 5: must go to Aakash ("above the 5 free leaves")', () => {
  const s = seed();
  // Neha: roster Sundays 20 and 27 Dec, plus 3 approved days in December = 5.
  s.db.insert('LeaveRequests', { id: 'dec', personId: 'neha', kind: 'full', dates: ['2026-12-08', '2026-12-09', '2026-12-10'], status: 'Approved', type: 'Regular', penaltyEmergency: false, history: [], approvals: {} });
  const ev = Core.previewLeave(s.ctx('2026-11-20', '10:00'), s.actor('Neha'), leave(['2026-11-30', '2026-12-01']));
  assert.equal(ev.decision, 'aakash', 'decision = ' + ev.decision + ' (' + ev.reasons.join(' ') + ')');
});

// =====================================================================================
// F11 (Low). Dates from the phone are checked only by shape.
// =====================================================================================
test('F11 a date that does not exist (30 Feb) must be refused by the server', () => {
  const s = seed();
  assert.throws(() => Core.submitLeave(s.ctx('2027-02-01', '10:00'), s.actor('Vikas'), leave(['2027-02-30'])), e => e.code === 'BLOCKED');
});

// =====================================================================================
// F12 (Medium). endOfDay trusts that it runs after closing. Run in the morning (by hand
// from the editor, or a delayed / re-run trigger) it marks everyone who has not arrived yet.
// =====================================================================================
test('F12 endOfDay run before closing time must not record absences and violations', () => {
  const s = seed();
  s.db.insert('Settings', { key: 'startDate', value: '2026-11-20' }); // as setupOrUpgrade writes it on a new Sheet (added with the round 6 catch-up of missed nights)
  const out = Jobs.run(s.ctx('2026-11-20', '08:00'), 'endOfDay', null);
  assert.deepEqual(out.absent, [], out.absent.length + ' people marked absent at 08:00, ' + s.db.rows('Violations').length + ' violations');
});

// =====================================================================================
// F13 (Medium). No protection against the same request stored twice (no request id).
// The state checks cover leave / going out, but not incidents.
// =====================================================================================
test('F13 the same incident sent twice (retry after a slow reply) must not become a violation', () => {
  const s = seed();
  const args = { personId: 'neha', item: 'dress', note: 'Blue shirt', date: '2026-11-20' };
  const first = Admin.recordIncident(s.ctx('2026-11-20', '11:00'), s.actor('Aakash'), args);
  const again = Admin.recordIncident(s.ctx('2026-11-20', '11:00'), s.actor('Aakash'), args); // identical retry, same second
  assert.equal(first.result, 'grace');
  assert.equal(s.db.rows('Violations').length, 0, 'retry result: ' + again.result + ' (count ' + again.count + ')');
});

// =====================================================================================
// F14 (Low). "The first column of every tab is its key": the store takes whatever header is
// first on the Sheet, and setupOrUpgrade says "Already up to date".
// =====================================================================================
test('F14 a column added on the left of a tab: setup reports nothing, and every update on that tab fails', () => {
  const g = fakeGrid(); Store.setup(g);
  const s = seed(); const db0 = Store.open(g); s.db.rows('People').forEach(p => db0.insert('People', p));
  g.tabs.LeaveRequests = g.tabs.LeaveRequests.map((r, i) => [i === 0 ? 'Remarks' : ''].concat(r));
  assert.deepEqual(Store.setup(g), []);                                         // upgrade: "nothing to do"
  const ctx = (d, t) => ({ db: Store.open(g), env, now: s.ist(d, t) });
  const r = Core.submitLeave(ctx('2026-11-20', '10:00'), s.actor('Vikas'), leave(['2026-11-25']));
  assert.doesNotThrow(() => Core.cancelLeave(ctx('2026-11-20', '10:05'), s.actor('Vikas'), r.id));
});
