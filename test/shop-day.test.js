// A full shop day through the real entry point (Api.handle) on the Sheet store with the read cache,
// the way doPost runs it. Every reply a staff phone receives is scanned for salary data.
const test = require('node:test');
const assert = require('node:assert/strict');
const Store = require('../src/server/store.js');
const Api = require('../src/server/api.js');
const Jobs = require('../src/server/jobs.js');
const { wrap } = require('../src/server/cachegrid.js');
const { TABS } = require('../src/server/schema.js');
const { env, seed } = require('./helpers.js');

function fakeGrid() {
  const tabs = {};
  const g = { tabs, tabNames: () => Object.keys(tabs), addTab: n => { tabs[n] = []; }, read: n => (tabs[n] || []).map(r => r.slice()),
    headers: n => (tabs[n] && tabs[n][0] || []).slice(), tail: (n, k) => tabs[n].slice(1).slice(-k).map(r => r.slice()),
    append: (n, row) => g.appendMany([{ tab: n, rows: [row] }])[n], appendRows: (n, rows) => g.appendMany([{ tab: n, rows }])[n],
    appendMany: batch => { const first = {}; batch.forEach(b => { first[b.tab] = tabs[b.tab].length; b.rows.forEach(r => tabs[b.tab].push(r.map(String))); }); return first; },
    writeRow: (n, i, row) => { tabs[n][i] = row.map(String); } };
  return g;
}
function fakeCache() { const m = new Map(); return { getAll: keys => { const o = {}; keys.forEach(k => { if (m.has(k)) o[k] = m.get(k); }); return o; }, put: (k, v) => m.set(k, v), putAll: map => Object.keys(map).forEach(k => m.set(k, map[k])) }; }

test('one shop day, 11 people, through the API on the Sheet store', () => {
  const g = fakeGrid(); Store.setup(g); const cache = fakeCache(); const mem = seed(); let vn = 0;
  const db0 = Store.open(g); const who = {}; const staffReplies = [];
  mem.db.rows('People').forEach(p => {
    db0.insert('People', p);
    db0.insert('Devices', { id: 'dev_' + p.id, personId: p.id, tokenHash: env.sha256('tok-' + p.id), label: '', status: 'approved', requestedAt: 1, decidedAt: 1, decidedBy: 'test' });
    db0.insert('PayInfo', { personId: p.id, fixedSalary: 17321, targetAllowance: 2111, disciplineBonus: 500, dutyHours: 9 });
    who[p.id] = { personId: p.id, deviceToken: 'tok-' + p.id, role: p.role };
  });
  const call = (date, hhmm, action, person, args) => {
    const db = Store.open(wrap(g, cache, Object.keys(TABS), () => 'v' + (++vn)), { buffer: true }); let depth = 0;
    const e = Object.assign({}, env, { photos: env.photos, withLock(fn) { if (depth > 0) return fn(); depth += 1; try { return fn(); } finally { try { db.flush(); } finally { depth -= 1; } } } });
    const reply = Api.handle({ db, now: mem.ist(date, hhmm), env: e }, Object.assign({ action, clientVersion: 1, args: args || {} }, person ? who[person] : {}));
    db.flush();
    if (person && who[person].role === 'staff') staffReplies.push(action + ' ' + JSON.stringify(reply));
    return reply;
  };
  const ok = r => { assert.equal(r.ok, true, JSON.stringify(r)); return r.data; };
  const PIC = { photo: 'data:image/jpeg;base64,AAAA', thumb: 'data:image/jpeg;base64,BBBB', lat: 29.15, lng: 75.72, accuracy: 10 };
  const D = '2026-11-25', E = '2026-11-24';   // Wednesday; the evening before
  const leave = (dates, extra) => Object.assign({ kind: 'full', dates, reasonCode: 'Personal work', reasonText: 'Bank work' }, extra);

  db0.insert('Settings', { key: 'startDate', value: '2026-11-25' });
  ok(call('2026-11-20', '10:00', 'setShopPoint', 'varun', { samples: [1, 2, 3].map(() => ({ lat: 29.15, lng: 75.72 })) }));
  // Days before: Vikas has an approved leave for the day; Harsh cannot add a half day (Sales needs 2, per day); Manish takes an afternoon half day.
  assert.equal(ok(call('2026-11-20', '10:00', 'submitLeave', 'vikas', leave([D]))).status, 'Approved');
  assert.match(call('2026-11-20', '10:05', 'submitLeave', 'harsh', leave([D], { kind: 'half', halfStart: '15:00' })).message, /Not allowed: Vikas is off/);
  assert.equal(ok(call('2026-11-20', '10:06', 'submitLeave', 'manish', leave([D], { kind: 'half', halfStart: '14:00' }))).status, 'Approved');
  // Neha cannot also be away (Sales needs 2): the form is blocked.
  assert.equal(ok(call('2026-11-20', '10:10', 'previewLeave', 'neha', leave([D]))).decision, 'blocked');
  // The evening before: Bhawna says she will be 40 min late; Aakash approves.
  const late = ok(call(E, '20:00', 'requestShort', 'bhawna', { kind: 'late', date: D, time: '10:10' }));
  ok(call(E, '20:10', 'decideShort', 'aakash', { id: late.id, approve: true }));

  // Morning check-ins.
  ok(call(D, '09:28', 'checkIn', 'neha', PIC));
  ok(call(D, '09:36', 'checkIn', 'manish', PIC));                       // 6 min: inside the grace
  ok(call(D, '09:30', 'checkIn', 'anita', PIC));
  ok(call(D, '10:00', 'checkIn', 'pooja', Object.assign({}, PIC, { lat: 29.16, lng: 75.72 }))); // about 1.1 km away
  ok(call(D, '10:08', 'checkIn', 'bhawna', PIC));                       // informed 40, came after 38
  ok(call(D, '10:30', 'checkIn', 'harsh', PIC));
  ok(call(D, '10:45', 'checkIn', 'muskan', PIC));
  ok(call(D, '11:05', 'checkIn', 'raunak', PIC));                       // 35 min, nobody told = violation
  assert.equal(call(D, '11:06', 'checkIn', 'raunak', PIC).code, 'BLOCKED');
  assert.equal(call(D, '11:10', 'checkIn', 'vikas', PIC).ok, true);     // came in on his leave day: flagged, not refused

  // Aakash's board at noon.
  const board = ok(call(D, '12:00', 'board', 'aakash')).people;
  const st = n => board.find(p => p.name === n);
  assert.equal(st('Neha').state, 'In'); assert.equal(st('Vikas').state, 'On leave');
  assert.equal(st('Pooja').flag, 'outside-shop-area'); assert.equal(st('Raunak').lateMinutes, 35);
  assert.equal(call(D, '12:00', 'board', 'neha').code, 'FORBIDDEN'); // staff cannot open the board

  // Going out: Anita 12 min (free), Muskan 40 min (all from the bank), Neha and Pooja blocked by the per-day clash rule.
  assert.match(call(D, '12:30', 'goingOut', 'neha', { reason: 'Bank', expectedMinutes: 30 }).message, /Not allowed: Vikas/);
  const o1 = ok(call(D, '13:00', 'goingOut', 'anita', { reason: 'Courier', expectedMinutes: 10 }));
  ok(call(D, '13:01', 'decideOuting', 'aakash', { id: o1.id, approve: true }));
  assert.equal(ok(call(D, '13:13', 'imBack', 'anita', { id: o1.id })).minutes, 12);
  ok(call(D, '13:20', 'confirmBack', 'aakash', { id: o1.id }));
  const o2 = ok(call(D, '14:00', 'goingOut', 'muskan', { reason: 'Bank', expectedMinutes: 30 }));
  ok(call(D, '14:02', 'decideOuting', 'aakash', { id: o2.id, approve: true }));
  // She forgets to tap I'm back; Aakash closes it with the real time.
  assert.equal(ok(call(D, '15:10', 'confirmBack', 'aakash', { id: o2.id, correctedTime: '14:42' })).minutes, 40);
  assert.match(call(D, '14:30', 'goingOut', 'pooja', { reason: 'Tea', expectedMinutes: 10 }).message, /Not allowed: Bhawna/);

  // Manish checks out when his half day starts; Aakash records a chai cup; a dispute is raised.
  ok(call(D, '14:00', 'checkOut', 'manish'));
  const inc = ok(call(D, '16:00', 'recordIncident', 'aakash', { personId: 'neha', item: 'job-sheet', note: 'Job sheet not filled', date: D }));
  assert.equal(inc.result, 'violation');
  const nehaMonth = ok(call(D, '16:05', 'myMonth', 'neha', { month: '2026-11' }));
  ok(call(D, '16:10', 'disputeViolation', 'neha', { id: nehaMonth.violations[0].id, text: 'It was filled at 15:50' }));
  assert.equal(call(D, '16:11', 'decideDispute', 'aakash', { id: nehaMonth.violations[0].id, uphold: false, note: 'x' }).code, 'FORBIDDEN');
  ok(call(D, '16:20', 'decideDispute', 'varun', { id: nehaMonth.violations[0].id, uphold: false, note: 'Checked the sheet: it was filled' }));

  // Evening: check-outs. Muskan forgets.
  ok(call(D, '17:30', 'checkOut', 'anita'));
  ok(call(D, '18:30', 'checkOut', 'neha')); ok(call(D, '18:32', 'checkOut', 'bhawna'));
  ok(call(D, '18:40', 'checkOut', 'pooja'));                            // 20 min early, nobody told
  ok(call(D, '19:30', 'checkOut', 'raunak')); ok(call(D, '19:31', 'checkOut', 'harsh')); ok(call(D, '20:00', 'checkOut', 'vikas'));

  // 21:00 job. Nobody is absent (everyone checked in or is on leave).
  {
    const db = Store.open(wrap(g, cache, Object.keys(TABS), () => 'v' + (++vn)), { buffer: true });
    const out = Jobs.run({ db, now: mem.ist(D, '21:00'), env: Object.assign({}, env, { withLock: fn => { try { return fn(); } finally { db.flush(); } } }) }, 'endOfDay', null);
    db.flush();
    assert.deepEqual(out.absent, []);
    assert.match(out.summary.join('|'), /No check-out yet: Muskan/);
  }
  ok(call('2026-11-26', '10:30', 'manualCheckOut', 'aakash', { personId: 'muskan', date: D, time: '19:45', reason: 'Forgot to check out' }));

  // The day in numbers, read back from the Sheet (text cells) the next morning.
  const month = p => ok(call('2026-11-26', '11:00', 'myMonth', p, { month: '2026-11' }));
  assert.equal(month('neha').bank.used, 0); assert.equal(month('neha').ladder.violations, 0);   // dispute removed it
  assert.equal(month('bhawna').bank.used, 28);                           // 38 late - 10 grace, informed
  assert.equal(month('raunak').bank.used, 25); assert.deepEqual(month('raunak').violations.map(v => v.rule), ['not-informed-over-30']);
  assert.equal(month('pooja').bank.used, 20); assert.equal(month('pooja').bank.passesUsed, 1);
  assert.equal(month('manish').leaves.taken, 0.5); assert.equal(month('manish').bank.used, 0); assert.equal(month('manish').ladder.violations, 0);
  assert.equal(month('harsh').bank.used, 0);
  assert.equal(month('vikas').leaves.taken, 1);
  assert.equal(month('muskan').bank.used, 40); assert.equal(month('muskan').ladder.violations, 0);

  // Privacy: no reply to a staff phone ever carried salary data, a PIN hash or a token hash.
  staffReplies.forEach(r => assert.doesNotMatch(r, /fixedSalary|"targetAllowance"|pinHash|tokenHash|pinSalt/, r.slice(0, 80)));
  staffReplies.filter(r => r.indexOf('myMonth ') !== 0).forEach(r => assert.doesNotMatch(r, /17321/, r.slice(0, 80))); // own month page may show the own estimate
  // Staff see their own estimate only when they ask for their own month, and never another person's page.
  assert.equal(call('2026-11-26', '11:05', 'myMonth', 'neha', { month: '2026-11', personId: 'vikas' }).code, 'FORBIDDEN');
  assert.equal(call('2026-11-26', '11:05', 'getSettings', 'aakash').code, 'FORBIDDEN');
  // Everything on the Sheet is text, and nothing was lost on the way.
  assert.equal(Store.open(g).rows('Punches').filter(p => p.date === D && p.kind === 'in').length, 9);
  assert.equal(Store.open(g).rows('Punches').filter(p => p.date === D && p.kind === 'out').length, 9);
});
