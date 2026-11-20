// In-memory store + test environment that mimics the Sheet store and Apps Script services.
const crypto = require('node:crypto');
const { TABS } = require('../src/server/schema.js');

function memoryDb() {
  const data = {};
  Object.keys(TABS).forEach(t => { data[t] = []; });
  return {
    data,
    rows: tab => data[tab],
    insert: (tab, obj) => { data[tab].push(JSON.parse(JSON.stringify(obj))); },
    update: (tab, id, patch) => {
      const row = data[tab].find(r => r.id === id);
      if (!row) throw new Error('update: no row ' + tab + ' ' + id);
      Object.assign(row, JSON.parse(JSON.stringify(patch)));
    },
  };
}

let seq = 0;
const env = {
  sha256: s => crypto.createHash('sha256').update(s).digest('hex'),
  randomId: () => 'id' + (++seq) + '_' + crypto.randomBytes(6).toString('hex'),
  withLock: fn => fn(),
};

// The real shop roster from the handoff (no real salaries; test values only).
const ROSTER = [
  ['Neha', 'Sales', 'staff', '09:30', '18:30', [3, 4]],
  ['Vikas', 'Sales', 'staff', '11:00', '20:00', [1, 2]],
  ['Harsh', 'Sales', 'staff', '10:30', '19:30', [1, 2]],
  ['Raunak', 'Repairing', 'staff', '10:30', '19:30', [1, 2]],
  ['Manish', 'Repairing', 'staff', '09:30', '18:30', [3, 4]],
  ['Muskan', 'Testing', 'staff', '10:45', '19:45', []],
  ['Bhawna', 'Calls', 'staff', '09:30', '18:30', [3, 4]],
  ['Pooja', 'Calls', 'staff', '10:00', '19:00', [1, 2]],
  ['Anita', 'Housekeeping', 'staff', '09:30', '17:30', 'every'],
  ['Aakash', 'Manager', 'manager', '10:00', '19:00', []],
  ['Varun', 'Owner', 'owner', '10:00', '19:00', []],
];

function seed() {
  const db = memoryDb();
  ROSTER.forEach(([name, group, role, dutyStart, dutyEnd, sundayOff]) => db.insert('People', {
    id: name.toLowerCase(), name, group, role, dutyStart, dutyEnd, sundayOff,
    noApproval: name === 'Muskan', noClash: name === 'Muskan' || name === 'Anita', noQuota: name === 'Muskan',
    dressExempt: name === 'Anita', active: true, salary: 17000, pinTries: 0,
  }));
  const actor = name => { const p = db.rows('People').find(x => x.name === name); return { id: p.id, name: p.name, role: p.role }; };
  // ist('2026-11-20', '16:00') -> epoch ms
  const ist = (date, hhmm) => Date.parse(date + 'T' + hhmm + ':00+05:30');
  const ctx = (date, hhmm) => ({ db, env, now: ist(date, hhmm) });
  return { db, actor, ist, ctx };
}

module.exports = { memoryDb, env, seed };
