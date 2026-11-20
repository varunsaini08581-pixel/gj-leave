// Read cache in front of the Sheet: fewer Sheet reads, and never a stale read after a write.
const test = require('node:test');
const assert = require('node:assert/strict');
const Store = require('../src/server/store.js');
const Core = require('../src/server/core.js');
const { wrap } = require('../src/server/cachegrid.js');
const { TABS } = require('../src/server/schema.js');
const { env, seed } = require('./helpers.js');

function fakeGrid() {
  const tabs = {}, calls = { read: 0 };
  return { tabs, calls, tabNames: () => Object.keys(tabs), addTab: n => { tabs[n] = []; }, read: n => { calls.read += 1; return (tabs[n] || []).map(r => r.slice()); },
    append: (n, r) => { tabs[n].push(r.map(String)); }, appendRows: (n, rows) => { const f = tabs[n].length; rows.forEach(r => tabs[n].push(r.map(String))); return f; },
    writeRow: (n, i, r) => { tabs[n][i] = r.map(String); } };
}
function fakeCache() {
  const m = new Map();
  return { m, getAll: keys => { const o = {}; keys.forEach(k => { if (m.has(k)) o[k] = m.get(k); }); return o; }, put: (k, v) => { m.set(k, v); }, putAll: map => { Object.keys(map).forEach(k => m.set(k, map[k])); } };
}
let n = 0; const ver = () => 'v' + (++n);
function world() {
  const g = fakeGrid(); Store.setup(g); const cache = fakeCache(); const mem = seed();
  const db0 = Store.open(g); mem.db.rows('People').forEach(p => db0.insert('People', p));
  const open = () => { const grid = wrap(g, cache, Object.keys(TABS), ver); return Store.open(grid, { buffer: true }); };
  const req = (when, fn) => { const db = open(); const out = fn({ db, env, now: mem.ist(...when) }); db.flush(); return out; };
  return { g, cache, mem, open, req };
}
const leave = (dates) => ({ kind: 'full', dates, reasonCode: 'Personal work', reasonText: 'Bank work' });

test('a tab is read from the Sheet once, then served from the cache', () => {
  const w = world(); w.g.calls.read = 0;
  w.open().rows('People'); const first = w.g.calls.read;
  w.open().rows('People'); w.open().rows('People');
  assert.equal(first, 1);
  assert.equal(w.g.calls.read, 1);
});

test('after a write the next request sees the new row (the old cached copy is retired)', () => {
  const w = world();
  assert.equal(w.open().rows('LeaveRequests').length, 0);                       // cached as empty
  w.req(['2026-11-20', '10:00'], c => Core.submitLeave(c, w.mem.actor('Vikas'), leave(['2026-11-25'])));
  assert.equal(w.open().rows('LeaveRequests').length, 1);
  // And the clash rule sees it on the very next request.
  assert.equal(w.req(['2026-11-20', '10:01'], c => Core.previewLeave(c, w.mem.actor('Neha'), leave(['2026-11-25']))).decision, 'blocked');
});

test('two overlapping requests: a reader that loaded before the write cannot poison the cache', () => {
  const w = world();
  const reader = wrap(w.g, w.cache, Object.keys(TABS), ver);
  const before = reader.read('LeaveRequests');                                  // old reader holds version N and old rows
  w.req(['2026-11-20', '10:00'], c => Core.submitLeave(c, w.mem.actor('Vikas'), leave(['2026-11-25'])));
  w.cache.put('d:LeaveRequests:' + [...w.cache.m.keys()].length, JSON.stringify(before)); // noise
  // The old reader now (late) re-caches what it saw under ITS version; nobody reads that version any more.
  const stale = wrap(w.g, { ...w.cache, getAll: w.cache.getAll, put: w.cache.put, putAll: w.cache.putAll }, Object.keys(TABS), ver);
  assert.equal(Store.open(stale).rows('LeaveRequests').length, 1);
  assert.equal(w.open().rows('LeaveRequests').length, 1);
});

test('the full leave flow gives the same Sheet with and without the cache', () => {
  const run = cached => {
    const g = fakeGrid(); Store.setup(g); const cache = fakeCache(); const mem = seed();
    const db0 = Store.open(g); mem.db.rows('People').forEach(p => db0.insert('People', p));
    const req = (when, fn) => { const db = Store.open(cached ? wrap(g, cache, Object.keys(TABS), ver) : g, { buffer: true }); const out = fn({ db, env, now: mem.ist(...when) }); db.flush(); return out; };
    const a = req(['2026-11-24', '12:00'], c => Core.submitLeave(c, mem.actor('Bhawna'), leave(['2026-11-25'])));
    const b = req(['2026-11-24', '12:01'], c => Core.submitLeave(c, mem.actor('Pooja'), leave(['2026-11-25'])));
    req(['2026-11-24', '12:05'], c => Core.decideLeave(c, mem.actor('Aakash'), a.id, true));
    const last = req(['2026-11-24', '12:06'], c => Core.decideLeave(c, mem.actor('Aakash'), b.id, true));
    return { status: last.status, statuses: g.tabs.LeaveRequests.slice(1).map(r => r[12]), reads: g.calls.read, notes: g.tabs.Notifications.length };
  };
  const plain = run(false), cached = run(true);
  assert.equal(cached.status, 'Rejected – clash');
  assert.deepEqual(cached.statuses, plain.statuses);
  assert.equal(cached.notes, plain.notes);
  assert.ok(cached.reads < plain.reads, cached.reads + ' vs ' + plain.reads);
});

test('a broken cache never breaks the app: it just reads the Sheet', () => {
  const g = fakeGrid(); Store.setup(g);
  const bad = { getAll: () => { throw new Error('down'); }, put: () => { throw new Error('down'); }, putAll: () => { throw new Error('down'); } };
  const db = Store.open(wrap(g, bad, Object.keys(TABS), ver), { buffer: true });
  db.insert('Settings', { key: 'k', value: 'v' }); db.flush();
  assert.equal(Store.open(wrap(g, bad, Object.keys(TABS), ver)).rows('Settings').some(s => s.key === 'k'), true);
});

test('after a write the writer hands the cache the new content: the next request reads nothing from the Sheet', () => {
  const w = world();
  w.req(['2026-11-20', '10:00'], c => Core.submitLeave(c, w.mem.actor('Vikas'), leave(['2026-11-25'])));   // warms People etc. and writes
  w.g.calls.read = 0;
  const db = w.open();
  assert.equal(db.rows('LeaveRequests').length, 1);
  assert.equal(db.rows('LeaveRequests')[0].status, 'Approved');
  assert.equal(db.rows('People').length, 11);
  assert.equal(w.g.calls.read, 0);
  // The cached copy is exactly what the Sheet holds, row for row.
  assert.deepEqual(db.rows('LeaveRequests')[0].dates, Store.open(w.g).rows('LeaveRequests')[0].dates);
  // An update through the cached copy lands on the right Sheet row.
  w.req(['2026-11-20', '10:05'], c => Core.cancelLeave(c, w.mem.actor('Vikas'), db.rows('LeaveRequests')[0].id));
  assert.equal(Store.open(w.g).rows('LeaveRequests')[0].status, 'Cancelled');
});

test('if another request wrote the tab in between, the writer does NOT cache its own (possibly stale) copy', () => {
  const w = world();
  const gridA = wrap(w.g, w.cache, Object.keys(TABS), ver); const dbA = Store.open(gridA, { buffer: true });
  dbA.rows('Settings');                                                          // A reads Settings (empty of key k)
  w.req(['2026-11-20', '10:00'], c => { c.db.insert('Settings', { key: 'k', value: 'from B' }); }); // B writes in between
  dbA.insert('Settings', { key: 'a', value: 'from A' }); dbA.flush();            // A writes without having seen B's row
  const keys = Store.open(wrap(w.g, w.cache, Object.keys(TABS), ver)).rows('Settings').map(s => s.key);
  assert.ok(keys.includes('k') && keys.includes('a'), keys.join(','));           // both rows visible: read from the Sheet, not A's copy
});
