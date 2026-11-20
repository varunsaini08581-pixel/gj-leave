# Round 8 review: FULL SHOP-DAY AND SHOP-MONTH SIMULATION

Reviewer: independent (did not write the code). Method: simulation with an independent hand count, not code reading.
Everything was driven only through `Api.handle` on the Sheet store with the read cache, the way `doPost` does it
(including one request overlapping another while it waits for the lock), and through `Jobs.run` for the timed jobs.

Files:
- `/home/claude/findings/sim-round8.test.js` - the simulations, PASSING (16 tests, 564 hand-counted values, about 12 s).
- `/home/claude/findings/repro-round8.test.js` - 14 reproducers for the 11 findings below, each FAILS on the current code.

## Read this first: the code changed while this review ran

Between 19:08 and 19:12 IST the fixes for round 7 (edge cases, run in parallel) were written into `src/`
(`reviews/round7.md`, `test/round7.test.js`, schema 4). Seven of the flows I had found broken by then were among them.
I threw nothing away: I re-ran everything on the code as it stood at 19:19 IST (last change to `src/` 19:12:34; project suite: 263 pass).

- Findings below = what is still wrong on that code. Every reproducer was re-run and fails for the reason stated.
- The seven flows that had failed and now pass are kept as passing tests in the sim file (tests 13 to 16), as an
  independent check of those fixes. Two of the round 7 fixes are incomplete or have a side effect: R8-2, R8-3, R8-4.

## Counts

| Severity | Count |
|---|---|
| Critical | 0 |
| High | 1 |
| Medium | 6 |
| Low | 4 |

**Did the app match the hand count? Yes, in every normal flow.** Three full shop days, a full month for all 11
people with every job every day, the first days of the next month and the owner's six worked examples: 564 values
written down by hand before the run (leaves total / taken / left, emergencies, bank used / left / beyond, passes,
violations and rules, ladder stage, money lines and totals, board, approvals, calendar, month report, alerts per
person and kind, Sheet row counts) and all 564 matched. What is wrong is in the flows where something goes wrong in
the shop first (a missed check-in, a lock at month end, a dispute, Aakash away) and in a few alerts.

---

## High

### R8-1. A person who was present but could not check in is "Absent – unannounced", and it can never be put right
- **Flow**: Neha is in the shop all day; her phone is dead (or the shop has no internet, or the app is down: handoff
  Part 2 no. 11 expects exactly this). At 21:00 the job records "Absent – unannounced" + 1 violation and tells Varun.
- **Hand count**: present all day = 0 leave days, 0 violations.
- **App**:
  - (a) Aakash enters her check-in the same evening after the job ("entered by Aakash", accepted): the day now has a
    check-in AND an unannounced absence. Still 1 leave day + 1 violation.
  - (b) Next morning (the time the handoff gives Aakash for fixes) there is no tool for it: a check-in can be entered
    only for today; `cancelLeave` refuses an automatic absence; "humanitarian – excused" removes the violation but
    keeps the day as one of her 5 leaves (and labels a working day as an excused absence). At 5 of 5 that is one
    day's salary in "would be deducted".
  - A whole-shop case (internet down for a day) gives 9 absences, 8 of them with a violation, none repairable. The only lever is
    to declare the day "shop closed", which is not true and also re-counts real leaves of that day.
- **Why High**: wrong leave count, wrong violation and possibly wrong money for a person who did nothing wrong; no
  correction path before the month is locked. Unusual per person, but with 9 phones over a month it will happen.
- **Fix idea**: let Aakash / Varun enter a check-in (and check-out) for a past day of an open month, with a reason;
  an accepted check-in for a day withdraws that day's automatic absence and its violation, and tells the person and Varun.
- **Reproducers**: `R8-1a`, `R8-1b`.

---

## Medium

### R8-2. A 3rd-emergency violation that Varun removed after a dispute comes back by itself (new with the round 7 fix)
- **Flow**: Manish has 3 emergencies; the 3rd is a violation. He disputes it (father in ICU), Varun removes it.
  Next day an ordinary leave of the same month is granted to him (auto-approved or by Aakash).
- **Hand count**: 0 violations; Varun's decision is final.
- **App**: `renumberEmergencies` runs on every grant, sees "penalty emergency with no standing violation" and records
  "Emergency beyond 2" again, with fresh "Violation recorded" alerts to Manish, Aakash and Varun. The Violations tab
  then holds the removed one and a new one.
- **Where**: `core.js renumberEmergencies` (`had` ignores rows in state `removed`, also those removed by a dispute).
- **Why Medium, not High**: needs a 3rd emergency, a dispute that was won and a further leave in the same month.
  When it does happen it silently reverses the owner's own decision, so it should not ship.
- **Reproducer**: `R8-2`.

### R8-3. Aakash on leave: Varun is still not told about going-out and late / early requests (round 7 M6 fixed for leave requests only)
- **Flow**: Aakash is on approved leave. Harsh asks to go out; Bhawna asks to leave early; Raunak sends an emergency leave.
- **Hand count** (handoff Part 6 "Aakash on leave: Varun approves", assumption 44): Varun is alerted for all three.
- **App**: Varun gets the leave request and its reminders. "Going out: Harsh", "Harsh is back", "Bhawna asks to leave
  early" and its 2-hour reminders go to Aakash alone. Going out is the one that needs an answer in minutes.
- **Where**: `attendance.js requestShort / goingOut / imBack / remindBack / cancelShort` and `jobs.js reminders`
  (ShortRequests) still use `byRole('manager')`, not `deciders`.
- **Seen in the month simulation**: 14 Nov, Harsh's outing; Varun approved it only because the script made him look.
- **Reproducer**: `R8-3`.

### R8-4. Cancelling the rest of a running leave while the person is still away makes today an unannounced absence (side effect of the round 7 fix, assumption 39)
- **Flow**: Vikas, approved leave 9-11 Dec. On the 10th he phones "back tomorrow"; Aakash cancels the rest.
- **Hand count**: 9th and 10th stay leave, the 11th is given back, 0 violations.
- **App**: the leave is cut to the 9th ("days from today on are given back"). At 21:00 Vikas has no leave and no
  check-in for the 10th: "Absent – unannounced" + 1 violation + alert to Varun.
- **Note**: the same action on the day he is actually back (the 11th) is right (sim test 13). Only the server action
  exists today (no button on the phone yet); fix it before that screen is built.
- **Fix idea**: give today back only when the person has checked in today; otherwise from tomorrow.
- **Reproducer**: `R8-4`.

### R8-5. The month lock also freezes what is not (only) in the locked month
- (a) **A leave that crosses the month end** (30 Nov - 2 Dec, approved). November is locked on 1 Dec. Neha comes back
  on the 1st and works the 1st and 2nd. Aakash can neither cancel the rest nor shorten it ("This month is locked"),
  so December keeps 2 leave days she worked. A correction entry exists only for the locked month, not for December.
- (b) **A request still waiting when its month is locked** can never be approved, rejected or cancelled. It stays in
  the Approvals list for ever and reminds Aakash every 2 hours for ever (12 reminders a day, measured four days later).
  The lock gives no warning that requests are still waiting.
- **Hand count**: (a) December: 0 leave days taken. (b) the request can be closed, or at least stops reminding.
- **Where**: `core.js assertOpen(ctx, r.dates)` in `cancelLeave` / `decideLeave`, `admin.js editLeave`; `jobs.js reminders`; `views.js lockMonth`.
- **Why Medium**: leaves across a month end are common, a lock on the 1st is what the handoff asks for; the early
  return on top of it is the unusual part. (b) needs a request ignored through the month end.
- **Fix idea**: (a) allow cancel / shorten when only days of open months change; (b) refuse the lock while requests
  dated in that month are waiting (list them), and never remind about a request that cannot be decided.
- **Reproducers**: `R8-5a`, `R8-5b`.

### R8-6. When a recorded violation is withdrawn, nobody who was told about it is told that it is gone
- **Flows**: (a) Bhawna asks at 17:00 to leave at 17:30, leaves while the request waits: "Violation recorded" goes
  to her, Aakash and Varun (assumption 12). At 19:00 Aakash approves: the violation is withdrawn, correctly. She
  gets "Early leaving approved"; Varun gets nothing. His alerts still say Bhawna has a violation.
  (b) Aakash marks an absence "humanitarian – excused": neither the person nor Varun is told (handoff 3.12: staff get "the decision").
  Same for: a check-out taken back, a closed day entered later (9 "Absent – unannounced" alerts to Varun stand), a leave cancelled.
- **Side effect**: "1 violation this month" is sent once a month. If the hourly job runs while such a provisional
  violation stands, the alert is used up; the person's real first violation later brings no "1 more = bonus lost" alert.
- **Hand count**: one alert "violation withdrawn" to everyone who received "Violation recorded"; the person is told about an excuse.
- **Why Medium**: (a) happens whenever Aakash is slower than the person's departure: a normal month. The month page
  is right; the alert trail (in-app and e-mail) is wrong and Varun may act on it.
- **Reproducers**: `R8-6a`, `R8-6b`.

### R8-7. Violation alerts that come from a leave do not say who
- **Flow**: unannounced leave, 3rd emergency, leave in a "+1 violation" restricted period (all three in the month simulation).
- **App**: Varun and Aakash read "Violation recorded – Unannounced leave" (also "Emergency leave beyond 2 in the
  month", "Leave in a restricted period") with no name. Minute-based violations do carry it ("Raunak: Not informed, more than 30 min").
- **Where**: `core.js addViolation` (body is the rule label only).
- **Why Medium**: happens in a normal month; in the e-mail digest the alert is useless and Varun cannot tell whose it is.
- **Reproducer**: `R8-7`.

---

## Low

| No. | What | Reproducer |
|---|---|---|
| R8-8 | A retry stores a second row: `addCorrection` (two identical corrections in the month report) and a new `saveRestriction` (the restriction is listed twice on the apply form and the calendar). Every other action sent twice in the simulations was refused or returned the same record. | `R8-8` |
| R8-9 | Varun's daily summary lists under "Late" a person who was not due: Harsh, roster off on the 1st Sunday, comes in at 12:00 to help: "Late: Harsh 90 min (in 12:00)". Same for someone on approved full leave who checks in. | `R8-9` |
| R8-10 | Muskan never gets "your leave starts tomorrow": the evening job looks only at status Approved, hers is Recorded (handoff 3.12: staff get a reminder the evening before their leave). | `R8-10` |
| R8-11 | Handoff 3.12 "1 more = violation": the only alert about passes comes after the 3rd not-informed time ("every 2nd time is a violation"). After the 4th (and 6th, 8th), when the next one really is a violation, no alert is sent; it is only a line on the Today screen. Interpretation of one line of the handoff; say so to the owner if you keep it. | `R8-11` |

---

## Found at the start of this review, fixed while it ran (now passing, kept in the sim file)

All seven were found independently here by simulation and are in `reviews/round7.md` as well. Re-tested on the new code:

| Flow | Hand count | Now |
|---|---|---|
| Back a day early from a 3-day leave, Aakash cancels the rest on that day | 2 leave days, 0 violations | matches (was: 2 absences + 2 violations at 21:00) |
| Same, Aakash shortens the leave instead | Regular, 0 violations | matches (was: Unannounced + 1 violation) |
| Check-out tapped by mistake and taken back on the day of the 5th not-informed late | the violation stands | matches (was: violation lost for good) |
| Same mistake by Bhawna: Pooja wants to go out afterwards | allowed | matches (was: "Bhawna is off") |
| Earlier emergency cancelled after the 3rd was granted | 2 emergencies, no violation, no cut | matches |
| Sunday roster changed in Settings on Tuesday | last Sunday stays a roster day off | matches (was: absent + violation for that Sunday) |
| Aakash on leave, a leave request comes in | Varun is told | matches for leave requests only: see R8-3 |

---

## The simulations (all in `sim-round8.test.js`, all passing)

1. **The owner's six worked examples as real requests and check-ins** (tests 1-6): late requests approved by Aakash,
   real check-ins / check-outs, a going-out with "I'm back" and a late confirmation, a leave told after duty start.
   Money and violations exact: Rs 0 / 0, Rs 5 / 0, Rs 0 / 0, Rs 126 / 1 (record only), Rs 0 / 2 (bonus + allowance),
   Rs 252 / 3 (notice). Alerts counted too (80% at the right day, "bank used up", notice stage to Varun).
2. **Day A, a normal Wednesday** (test 7): board at 09:20, 10:15 and 14:10, approvals before and after, calendar
   (roster Sundays, risk days), going out with reminder, effect preview, evening job, summary, next-morning list empty.
3. **Day B, the 1st Sunday** (test 8): roster in C1 / C2 / C3, C1-Sun, Muskan never blocked, a roster-off person who
   comes in, Sunday dress rules, a manual violation with dispute (Aakash refused, Varun upholds), forgotten check-out fixed next morning.
4. **Day C, a messy Friday** (test 9): a late request approved after arrival (violation appears and goes),
   stated-time overrun, a not-informed 35 min, a rejected leave, a half day, an outing Aakash has to close, an
   incident sent twice, two disputes (one removed, one upheld), overlapping double taps on check-in and check-out,
   12 reminders to Aakash through the night, forgotten check-out.
5. **November 2026 (5 Sundays) for all 11 people + 1-3 December** (test 10): every job every day (24 hourly, evening,
   end of day, each run twice). Leaves by every route (auto, Aakash, 3 in a row, special with both approvers, Varun
   for Aakash, recorded for Muskan, entered by Aakash as "called – emergency", Varun's override, an edit after
   approval), restricted week of both kinds, a closed day entered after a leave was approved, 3 emergencies, an
   absence, an automatic half day, month lock by Aakash then Varun, refusals after the lock, a correction, a leave
   across the month end, counters at zero in December, the last-3-months view, locked pages unchanged to the last value.
   Shop totals: 9 standing violations, Rs 2,099.
6. **Same month, cache on and off, jobs once and twice** (test 11): the Sheet is identical cell for cell.
7. **Edges through the API** (test 12): 48 h / 36 h / 3 h to the minute, runs over a roster Sunday, split requests, Anita with 4 Sundays, the 6th leave.

Checked during the simulations:
- **Privacy**: about 3,000 replies to staff phones: no salary structure keys, no number equal to another person's
  salary or allowance, none of 33 tagged reasons / notes / dispute texts / override reasons readable by anyone but
  the person concerned. 0 findings.
- **One row per real event**: row counts of every tab equal the hand count (month: 20 leave rows, 246 check-ins,
  246 check-outs, 28 minute rows, 11 violations rows, 5 outings, 8 late / early requests, 5 incidents, 11 MonthSheet rows); no duplicate ids. Only R8-8 breaks this.
- **Jobs twice**: every job run a second time at the same moment (about 900 runs) changed nothing.
- **Cache**: same result with the cache on and off.

Left out of the passing simulations because the app disagrees with the hand count: the "Late" line of day B (R8-9),
Muskan's evening reminder (R8-10), alerts to Varun on Aakash's leave day (R8-3). Alert comparisons tolerate a new
alert kind (so a "violation withdrawn" alert will not break them); if a fix re-uses an existing kind, the counts in
tests 7-10 must be raised by hand.

---

## For the owner (not counted as bugs)

1. **The handoff contradicts itself on going out.** 3.5: "more than 15 min, the whole outing comes from the bank".
   3.8 and 3.10, the owner's own examples: "Out 14:05–14:47 = 42 min (27 from bank)", i.e. the first 15 minutes are
   free. The app follows 3.5 (42 from the bank). Nobody has asked him. 15 minutes of bank per outing depend on it.
2. **Reminders run through the night**: a request sent at 21:30 reminds Aakash at 00:07, 02:07, 04:07, 06:07 (Varun
   got 10 for one special approval, four of them between 01:00 and 07:00). He said "every 2 hours"; ask whether at night too.
3. **Evening-before reminder**: sent once, at about 19:00. A leave approved after that (three in the month) gets none.
   A leave on a day later declared closed still gets one.
4. **The 3.12 list "to staff"** has no alert for a withdrawn violation or an excused absence (R8-6).
5. **Falling ill at work has no violation-free path** (assumption 16 open): leaving early over 2 hours cannot be
   requested, a half day asked after duty start is Unannounced, and Aakash's "called – emergency" entry is too.
6. **An edit of an approved leave that Aakash rejects** leaves the person with no leave at all (the approved version is gone).
7. **The calendar marks past days as clash-risk** when someone was merely late that day (3 Nov in the simulation).
8. A wrong check-in time cannot be corrected by anyone; only the resulting violation can be disputed.

## Not verified here

- `docs/` (the phone app) and the real Apps Script timers: not run in this round.
- New joiner, leaver and group change mid-month were not simulated (round 7 covered Settings changes).
- The code was still being edited during the review; anything changed after 19:19 IST is not covered.

## Summary

Critical 0, High 1, Medium 6, Low 4.

- **R8-1 (High)** Present but no check-in: "Absent – unannounced" stays, even after Aakash enters the check-in; next morning nothing can remove the leave day.
- **R8-2** A 3rd-emergency violation removed by Varun after a dispute is recorded again at the next grant (round 7 fix).
- **R8-3** Aakash on leave: Varun still not alerted for going-out and late / early requests (round 7 fix covers leaves only).
- **R8-4** Cancelling the rest of a leave while the person is still away turns today into an unannounced absence (round 7 fix).
- **R8-5** Month lock: a leave across the month end cannot be cancelled for December; a waiting request is stuck and reminds for ever.
- **R8-6** Withdrawn violations and excused absences are never announced; Varun's alerts keep the violation.
- **R8-7** Leave-violation alerts to Varun and Aakash do not name the person.
- Low: duplicate rows on retry (correction, restriction); "Late" in the summary for someone not due; no evening reminder for Muskan; no "next one is a violation" alert.

Hand-counted values compared: **586 in total. 564 matched** (all of the simulations). **22 did not match**, in the 14 reproducers of the 11 findings.
