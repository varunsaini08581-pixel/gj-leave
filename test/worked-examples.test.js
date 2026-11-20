// The owner's six worked examples (handoff Part 3.5). Mandatory, exact match.
// Duty 10:30, salary 17,000, 9 duty hours. Ladder version A.
const test = require('node:test');
const assert = require('node:assert/strict');
const { runMonth, ratePerMinute } = require('../src/rules/minutes.js');

const P = { salary: 17000, dutyHours: 9 };
const rep = (n, ev) => Array.from({ length: n }, () => ({ ...ev }));
const late = (minutes, informed) => ({ kind: 'late', minutes, informed });

test('rate: 17,000 and 9 hours = about Rs 63 an hour, Rs 1.05 a minute', () => {
  assert.equal(Math.round(ratePerMinute(P) * 60), 63);
  assert.equal(ratePerMinute(P).toFixed(2), '1.05');
});

test('1. Rohit: Rs 0, 0 violations', () => {
  const r = runMonth(P, [...rep(8, late(10, true)), ...rep(10, late(22, true))]);
  assert.equal(r.bankUsed, 120);
  assert.equal(r.wouldBeDeducted, 0);
  assert.equal(r.violations.length, 0);
});

test('2. Simran: Rs 5, 0 violations', () => {
  const r = runMonth(P, [
    ...rep(3, late(35, true)),
    { kind: 'out', minutes: 15 },
    { kind: 'early', minutes: 45, informed: true },
    late(15, false),
  ]);
  assert.equal(r.bankUsed, 120);
  assert.equal(r.beyondBankMinutes, 5);
  assert.equal(r.passesUsed, 1);
  assert.equal(r.wouldBeDeducted, 5);
  assert.equal(r.violations.length, 0);
});

test('3. Aman: Rs 0, 0 violations', () => {
  const r = runMonth(P, [late(25, false), late(15, false), late(30, false), late(40, true)]);
  assert.equal(r.bankUsed, 70);
  assert.equal(r.passesUsed, 3);
  assert.equal(r.wouldBeDeducted, 0);
  assert.equal(r.violations.length, 0);
});

test('4. Karan: Rs 126, 1 violation, record only', () => {
  const r = runMonth(P, rep(12, late(30, true)));
  assert.equal(r.beyondBankMinutes, 120);
  assert.equal(r.wouldBeDeducted, 126);
  assert.equal(r.violations.length, 1);
  assert.equal(r.ladder.recordOnly, true);
  assert.equal(r.ladder.bonusLost, false);
  assert.equal(r.ladder.targetAllowanceLost, false);
});

test('5. Priya: Rs 500 bonus + target allowance lost, 2 violations', () => {
  const r = runMonth(P, [...rep(5, late(20, false)), late(40, false)]);
  assert.equal(r.bankUsed, 80);
  assert.equal(r.wouldBeDeducted, 0);
  assert.deepEqual(r.violations.map(v => v.rule), ['not-informed-beyond-passes', 'not-informed-over-30']);
  assert.equal(r.ladder.bonusAmount, 500);
  assert.equal(r.ladder.targetAllowanceLost, true);
  assert.equal(r.ladder.notice, false);
});

test('6. Deepak: Rs 252 + bonus + allowance, 3 violations = notice', () => {
  const r = runMonth(P, [
    { kind: 'violation', rule: 'unannounced-leave' },
    ...rep(2, late(70, true)),
    ...rep(2, late(70, true)),
    ...rep(2, late(70, true)),
  ]);
  assert.equal(r.wouldBeDeducted, 252);
  assert.equal(r.violations.length, 3);
  assert.equal(r.ladder.bonusLost, true);
  assert.equal(r.ladder.targetAllowanceLost, true);
  assert.equal(r.ladder.notice, true);
});

// Rule edges, both directions.
test('late exactly 10 min is grace; 11 min counts 1', () => {
  assert.equal(runMonth(P, [late(10, false)]).notInformedCount, 0);
  const r = runMonth(P, [late(11, true)]);
  assert.equal(r.bankUsed, 1);
});

test('going out: 15 free, 16 counts the whole 16', () => {
  assert.equal(runMonth(P, [{ kind: 'out', minutes: 15 }]).bankUsed, 0);
  assert.equal(runMonth(P, [{ kind: 'out', minutes: 16 }]).bankUsed, 16);
});

test('not informed: 30 min is a pass, 31 min is an immediate violation', () => {
  assert.equal(runMonth(P, [late(30, false)]).violations.length, 0);
  assert.equal(runMonth(P, [late(31, false)]).violations.length, 1);
});

test('not informed: 4th time no violation, 5th and 7th are violations, 6th is not', () => {
  const count = n => runMonth(P, rep(n, late(12, false))).violations.length;
  assert.deepEqual([3, 4, 5, 6, 7].map(count), [0, 0, 1, 1, 2]);
});

test('informed but arrived after the stated time: extra minutes are not informed', () => {
  const r = runMonth(P, [{ kind: 'late', minutes: 45, informed: true, statedMinutes: 30 }]);
  assert.equal(r.bankUsed, 35); // 20 informed + 15 not informed
  assert.equal(r.passesUsed, 1);
});

test('more than 2 hours away is a half day, not the bank', () => {
  const r = runMonth(P, [{ kind: 'early', minutes: 121, informed: true }]);
  assert.equal(r.bankUsed, 0);
  assert.equal(r.lines[0].halfDay, true);
});
