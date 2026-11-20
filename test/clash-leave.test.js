// Clash rules and leave rules, both directions (blocked and allowed).
const test = require('node:test');
const assert = require('node:assert/strict');
const Cal = require('../src/rules/calendar.js');
const { checkRequest, ruleBroken, awayOn, DEFAULT_RULES } = require('../src/rules/clash.js');
const { noticeType, monthQuota, runLength, route, emergencyPenalty, checkRestrictions } = require('../src/rules/leave.js');

const people = {
  Neha: { sundayOff: [3, 4] }, Vikas: { sundayOff: [1, 2] }, Harsh: { sundayOff: [1, 2] },
  Raunak: { sundayOff: [1, 2] }, Manish: { sundayOff: [3, 4] },
  Muskan: { sundayOff: [], noClash: true, noApproval: true },
  Bhawna: { sundayOff: [3, 4] }, Pooja: { sundayOff: [1, 2] },
  Anita: { sundayOff: 'every', noClash: true, alwaysAakash: true },
};
// November 2026: Sundays are 1, 8, 15, 22, 29 (five Sundays).
const req = (person, dates, extra) => checkRequest({ person, dates, ...extra }, people, away);
let away = [];
const withAway = (list, fn) => { away = list; try { fn(); } finally { away = []; } };

test('calendar: Sundays of Nov 2026', () => {
  assert.deepEqual(['2026-11-01', '2026-11-08', '2026-11-15', '2026-11-22', '2026-11-29'].map(Cal.nthSunday), [1, 2, 3, 4, 5]);
  assert.equal(Cal.nthSunday('2026-11-25'), 0);
  assert.equal(Cal.isRosterOff(people.Vikas, '2026-11-08'), true);
  assert.equal(Cal.isRosterOff(people.Vikas, '2026-11-29'), false); // 5th Sunday is working
  assert.equal(Cal.isRosterOff(people.Anita, '2026-11-29'), true);  // except Anita
});

test('C1: one of Sales away is allowed; a second on the same day is blocked', () => {
  assert.equal(req('Neha', ['2026-11-25']).ok, true);
  withAway([{ person: 'Vikas', date: '2026-11-25' }], () => {
    const r = req('Neha', ['2026-11-25']);
    assert.equal(r.ok, false);
    assert.equal(r.blocks[0].rule, 'C1');
    assert.equal(r.blocks[0].message, 'Not allowed: Vikas is off on 25 Nov — Sales needs 2 of Neha, Vikas, Harsh present.');
    assert.equal(req('Neha', ['2026-11-26']).ok, true); // next day is fine
  });
});

test('C1-Sun: on the 1st and 2nd Sunday the roster alone is allowed, but Neha cannot also be off', () => {
  assert.equal(ruleBroken(DEFAULT_RULES[0], '2026-11-08', awayOn('2026-11-08', people, [])), null);
  assert.equal(req('Neha', ['2026-11-08']).ok, false);
});

test('C1: on the 3rd Sunday Neha is off by roster, so Vikas cannot take leave', () => {
  assert.equal(req('Vikas', ['2026-11-15']).ok, false);
  assert.equal(req('Vikas', ['2026-11-29']).ok, true); // 5th Sunday, everyone working
});

test('C1-E: extreme emergency only when Bhawna and Pooja are both present, and only via Aakash', () => {
  withAway([{ person: 'Vikas', date: '2026-11-25' }], () => {
    const plain = req('Neha', ['2026-11-25']);
    assert.equal(plain.ok, false);
    assert.equal(plain.extremeEmergencyPossible, true);
    const em = req('Neha', ['2026-11-25'], { extremeEmergency: true });
    assert.equal(em.ok, true);
    assert.equal(em.needsAakash, true);
  });
  withAway([{ person: 'Vikas', date: '2026-11-25' }, { person: 'Pooja', date: '2026-11-25' }], () => {
    const em = req('Neha', ['2026-11-25'], { extremeEmergency: true });
    assert.equal(em.ok, false); // Pooja is away, so no emergency route
  });
  withAway([{ person: 'Vikas', date: '2026-11-25' }, { person: 'Harsh', date: '2026-11-25' }], () => {
    assert.equal(req('Neha', ['2026-11-25'], { extremeEmergency: true }).ok, false); // all 3 never
  });
});

test('C2: Bhawna and Pooja never both away - counted per day (owner example)', () => {
  // Bhawna came 1 hour late in the morning; Pooja wants to leave early the same day: blocked.
  withAway([{ person: 'Bhawna', date: '2026-11-25', kind: 'late' }], () => {
    assert.equal(req('Pooja', ['2026-11-25']).ok, false);
    assert.equal(req('Pooja', ['2026-11-26']).ok, true);
  });
  assert.equal(req('Pooja', ['2026-11-15']).ok, false); // Bhawna's roster Sunday counts
  assert.equal(req('Bhawna', ['2026-11-25']).ok, true);
});

test('C3 and C4: repair rules', () => {
  withAway([{ person: 'Raunak', date: '2026-11-25' }], () => {
    const r = req('Manish', ['2026-11-25']);
    assert.deepEqual(r.blocks.map(b => b.rule), ['C3', 'C4']);
  });
  withAway([{ person: 'Muskan', date: '2026-11-25' }], () => {
    assert.equal(req('Manish', ['2026-11-25']).blocks[0].rule, 'C4'); // Muskan counts for the pool
  });
  assert.equal(req('Manish', ['2026-11-25']).ok, true);
});

test('Muskan and Anita are never blocked by clash rules', () => {
  withAway([{ person: 'Raunak', date: '2026-11-25' }, { person: 'Manish', date: '2026-11-26' }], () => {
    assert.equal(req('Muskan', ['2026-11-25', '2026-11-26']).ok, true);
    assert.equal(req('Anita', ['2026-11-25']).ok, true);
  });
});

test('a switched-off rule does not block', () => {
  const rules = DEFAULT_RULES.map(r => r.id === 'C2' ? { ...r, on: false } : r);
  const r = checkRequest({ person: 'Pooja', dates: ['2026-11-25'] }, people, [{ person: 'Bhawna', date: '2026-11-25' }], rules);
  assert.equal(r.ok, true);
});

test('notice: 36 h or more Regular, 3 to 36 h Emergency, under 3 h or after start Unannounced', () => {
  const start = Date.UTC(2026, 10, 25, 5, 0); // 10:30 IST
  const h = n => start - n * 3600000;
  assert.equal(noticeType(h(36), start), 'Regular');
  assert.equal(noticeType(h(35.99), start), 'Emergency');
  assert.equal(noticeType(h(3), start), 'Emergency');
  assert.equal(noticeType(h(2.99), start), 'Unannounced');
  assert.equal(noticeType(h(-1), start), 'Unannounced');
});

test('quota: roster Sundays count inside the 5; every day above 5 = 1 day salary', () => {
  const vikas = { ...people.Vikas, salary: 17000 };
  const days = n => Array.from({ length: n }, (_, i) => ({ date: `2026-11-${String(i + 10).padStart(2, '0')}`, amount: 1 }));
  assert.equal(monthQuota(vikas, '2026-11', days(3)).total, 5);
  assert.equal(monthQuota(vikas, '2026-11', days(3)).wouldBeDeducted, 0);
  const q = monthQuota(vikas, '2026-11', days(5)); // 2 Sundays + 5 = 7 leaves
  assert.equal(q.daysAboveQuota, 2);
  assert.equal(q.wouldBeDeducted, 1133); // 7 - 5 = 2 days x Rs 567
  assert.equal(monthQuota(vikas, '2026-11', [{ date: '2026-11-10', amount: 0.5 }]).total, 2.5);
});

test('Anita: 4-Sunday month gives 1 free weekday; 5-Sunday month gives none', () => {
  const anita = { ...people.Anita, salary: 9000 };
  assert.equal(monthQuota(anita, '2026-10', []).left, 1);  // Oct 2026 has 4 Sundays
  assert.equal(monthQuota(anita, '2026-11', []).left, 0);  // Nov 2026 has 5 Sundays
  assert.equal(monthQuota(anita, '2026-11', [{ date: '2026-11-10', amount: 1 }]).daysAboveQuota, 1);
});

test('run length: split requests join; a roster Sunday inside does not add', () => {
  // Vikas: Sat 7, (Sun 8 roster), Mon 9, Tue 10 = one run of 3.
  assert.equal(runLength(people.Vikas, ['2026-11-09', '2026-11-10'], ['2026-11-07']), 3);
  assert.equal(runLength(people.Vikas, ['2026-11-10'], ['2026-11-12']), 1);
});

test('who decides', () => {
  const base = { person: people.Neha, days: 1, run: 1, noticeHours: 50, type: 'Regular', quotaAfter: 3, violationsThisMonth: 0 };
  const d = x => route({ ...base, ...x }).decision;
  assert.equal(d({}), 'auto');
  assert.equal(d({ days: 2, run: 2 }), 'auto');
  assert.equal(d({ noticeHours: 40 }), 'aakash');
  assert.equal(d({ type: 'Emergency', noticeHours: 10 }), 'aakash');
  assert.equal(d({ quotaAfter: 6 }), 'aakash');
  assert.equal(d({ violationsThisMonth: 1 }), 'aakash');
  assert.equal(d({ days: 1, run: 3 }), 'aakash');
  assert.equal(d({ days: 4, run: 4 }), 'special');
  assert.equal(d({ restricted: true }), 'blocked');
  assert.equal(d({ clash: { ok: false, blocks: [{ message: 'x' }] } }), 'blocked');
  assert.equal(d({ person: people.Muskan }), 'recorded');
  assert.equal(d({ person: people.Anita }), 'aakash');
  assert.equal(d({ person: { isManager: true } }), 'varun');
});

test('emergencies: 2 are fine; the 3rd, 4th, 5th each give 1 violation and 1 extra day', () => {
  const p = { salary: 17000 };
  assert.deepEqual([0, 2, 3, 4, 5].map(n => emergencyPenalty(p, n).violations), [0, 0, 1, 2, 3]);
  assert.equal(emergencyPenalty(p, 2).wouldBeDeducted, 0);
  assert.equal(emergencyPenalty(p, 3).wouldBeDeducted, 567);
  assert.equal(emergencyPenalty(p, 5).wouldBeDeducted, 1700);
  assert.equal(emergencyPenalty(p, 1).left, 1);
});

test('restrictions: no-leave blocks, penalty allows with amount, default skips Anita and Muskan', () => {
  const peak = [{ id: 'R1', from: '2026-11-05', to: '2026-11-10', note: 'Peak sales season', rule: 'no-leave', appliesTo: null }];
  assert.equal(checkRestrictions('Neha', people.Neha, ['2026-11-06'], peak).blocked, true);
  assert.equal(checkRestrictions('Neha', people.Neha, ['2026-11-11'], peak).blocked, false);
  assert.equal(checkRestrictions('Anita', people.Anita, ['2026-11-06'], peak).blocked, false);
  assert.equal(checkRestrictions('Muskan', people.Muskan, ['2026-11-06'], peak).blocked, false);
  const withAnita = [{ ...peak[0], appliesTo: ['Anita', 'Neha'] }];
  assert.equal(checkRestrictions('Anita', people.Anita, ['2026-11-06'], withAnita).blocked, true);
  assert.equal(checkRestrictions('Vikas', people.Vikas, ['2026-11-06'], withAnita).blocked, false);
  const aug = [{ id: 'R2', from: '2026-08-03', to: '2026-08-07', note: 'No leave week', rule: 'penalty', penalty: 500, appliesTo: null }];
  const r = checkRestrictions('Neha', people.Neha, ['2026-08-04', '2026-08-05'], aug);
  assert.equal(r.blocked, false);
  assert.equal(r.penalty, 1000);
  assert.equal(checkRestrictions('Neha', people.Neha, ['2026-11-06'], [{ ...peak[0], on: false }]).blocked, false);
});
