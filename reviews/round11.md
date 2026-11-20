# GJ Leave & Attendance - Review round 11: rules and counting over the whole life of a record

Reviewer: independent (did not write the code). Date: 20 Nov 2026.
Code reviewed: `/home/claude/gj-leave`, commit 0d23639 as stated by the author (server version 9, schema 4).
Reproducers: `/home/claude/findings/repro-round11.test.js` - 23 tests for 14 findings, **all 23 fail on the current code**, each for the reason in its name (`node --test /home/claude/findings/repro-round11.test.js`).

**The code did not change during the review.** SHA-256 of all 25 files under `src/` and `docs/` taken at the start and at the end: identical.
I did not run git, did not use the network, changed nothing inside `/home/claude/gj-leave`, and wrote only inside `/home/claude/findings/` (scratch in `/tmp/r11`).

The project's own suite (`cd /home/claude/gj-leave && node --test`): **320 tests, 319 pass, 0 fail, 1 skipped.**

## Counts

| Severity | Count | Findings |
|---|---|---|
| Critical | **0** | |
| High | **1** | R11-1 |
| Medium | **9** | R11-2 ... R11-10 |
| Low | **4** | R11-11 ... R11-14 |

Plain verdict: the new single routine `syncLeaveViolations` does what it says in ordinary flows. In about 180,000 random calls it never doubled a violation, never left a granted leave without its violation, never threw, and one day never counted more than 1 leave. The one High is not in that routine: it is in `cancelLeave`, on the last day of a running leave. Again it is of the kind "something is changed AFTERWARDS". The Medium findings are edges of the new design: what the month lock leaves behind, what a dispute decision means to the sync, and minutes that are not counted again.

## What was checked

1. **Fixes of rounds 9 and 10.** The original `repro-round9.test.js` runs against the current code: 16 of 16 pass. The original `repro-round10.test.js`: 9 of 11 pass; H1a and H1b fail only in their own set-up, because the 11th edit is now refused ("changed 10 times"), which is the fix. No regression of a round 9 or 10 fix was found, except what is listed in the table "Earlier fixes that are not complete" below.
2. **Random month simulation** (`/tmp/r11/sim.js`, seeded): 165 runs, each 41 shop days (2 Nov - 12 Dec, November locked by Aakash on 2 Dec and Varun on 3 Dec), 11 people, through `Api.handle` on the fake Sheet with the read cache, with the hourly job 13 times a day (also 00:30, 03:00, 05:59), the evening job (sometimes twice), the end-of-day job (12% of nights skipped, 25% run twice, 5% also run the next morning). About 180,000 API calls: leave submit / edit (dates, reason only, kind) / approve / reject / cancel / shorten, entry by Aakash with call time, override, late / early, going out with corrected back time, check-in / check-out, hand check-in (also for past days), hand check-out, undo check-out, keep as absent, excuse, take back, incidents, disputes and decisions, closed days added and removed, clash rules on / off, restrictions added and switched, and in part of the runs people made inactive / renamed / roster changed / "no approval" switched.
   Checked every evening:
   - no reply with a code other than the business codes, no job threw: **held in all runs**
   - one day never more than 1 leave (rows, and `myMonth` against an independent recount of the rows): **held**
   - `myMonth` leave total and ladder count equal an independent recount: **held**
   - every live leave violation has a live reason, every reason has its violation (independent re-derivation, including emergency numbering in the order granted): **held**, except R11-14 (closed day) and after a "no approval" switch (R11-9)
   - no violation doubled: **held**
   - running both sync routines again on a copy of the Sheet changes nothing ("the sync is at rest"): **held**, except R11-9 and R11-14
   - no negative or NaN number in any `myMonth`: **held**
   - no minutes on a full-leave day: **broken** for going-out minutes (R11-10a)
   - locked November unchanged (report, violation rows, minute rows, leave rows, punches, and November as shown on the December page): report **held**; violation rows **broken** (R11-9)
   - no reminder between 00:00 and 06:00 IST, no reminder to an inactive person, no alert twice: **held**
   - at the end, everything still waiting can be closed by someone: **broken** for late / early requests, outings and disputes of the locked month (R11-3)
3. **Targeted sequences** read out of the changed code (`syncLeaveViolations`, `renumberEmergencies`, `recountDay`, `cancelLeave`, `lockMonth`, `setSetting`, `reminders`): these gave R11-1, 2, 4, 5, 6, 7, 8, 11, 12, 13.

## Findings

### R11-1 (High) - "End this leave today" on the LAST day turns the leave days already taken into absences with violations
- **Where**: `src/server/core.js:cancelLeave` (the lines `kept = gone.length && gone.length < r.dates.length ? gone : []` and `if (gone.length && gone.length < r.dates.length)`); then `attendance.js:endOfDay` with the 3-day catch-up in `jobs.js:endOfDay`.
- **What happens**: on the last day of a running leave, after the person's duty start and before she has checked in, EVERY day of the leave is "already taken" (today included, by assumption 49). The code reads "all days taken" as "the leave is completely over" and cancels the whole request. The evening job then finds the earlier days with no leave and no check-in and records "Absent – unannounced" + 1 violation for each (up to 3 days back).
- **Steps**: Neha has approved leave 18-20 Nov. 18 and 19 Nov pass. 20 Nov 12:00: she rings that she is coming in; Aakash opens More > "Staff leaves: cancel or shorten" and taps "End this leave today" (the button says "the days already taken stay, the rest is given back"). Reply: `Cancelled`. She checks in at 14:00. 21:00 job: 18 and 19 Nov become "Absent – unannounced", 2 violations; her arrival at 14:00 is "not informed, more than 30 min", a 3rd violation, plus an automatic half day. Without the tap: 3 leave days, 0 violations.
- **Why it matters**: one tap on the screen built for this, with the screen promising the opposite, takes a staff member from 0 violations to bonus-lost or notice stage. The same tap one hour earlier (before duty start) or after she has checked in works correctly, so nobody will see why.
- **Fix**: decide "completely over" by the calendar (last day < today), not by `gone.length === r.dates.length`. On the last day with duty begun and no check-in there is nothing to give back: answer `BLOCKED` ("nothing left to give back; she is on leave today") or keep all days and return the unchanged dates. Never fall through to the whole-cancel branch for a leave whose last day is today.
- **Reproducer**: `R11-1`.

### R11-2 (Medium) - leave cancelled on the day: violation or not depends on which tap came first
- **Where**: `core.js:cancelLeave` + `attendance.js:checkIn` / `recountDay` (assumption 57).
- **What happens**: Aakash cancels today's leave because the person is coming in. If she checks in first and he cancels afterwards, `recountDay` books the lateness as informed (assumption 57). If he cancels first and she walks in afterwards, `checkIn` books the same minutes as "not informed" and, over 30 min, records a violation. After duty start she cannot send a late request any more, so she has no way to avoid it.
- **Steps**: Neha's approved leave on 20 Nov. (a) 10:30 Aakash cancels, 11:00 check-in: 90 min not informed + violation. (b) 11:00 check-in, 11:30 Aakash cancels: 90 min informed, no violation.
- **Why it matters**: same facts, different ladder count; the natural order (cancel when she rings, she arrives later) is the one that punishes.
- **Fix**: when a leave is cancelled by Aakash / Varun after the person's duty start on that day, remember it (for example an approved late marker for that date) so that the following check-in is informed; or in `checkIn`, treat a day whose leave was cancelled by a boss after duty start as informed.
- **Reproducer**: `R11-2`.

### R11-3 (Medium) - what is still waiting when a month is locked can never be closed
- **Where**: `views.js:lockMonth` (closes only leave requests whose days are ALL in that month); `attendance.js:decideShort`, `cancelShort`, `confirmBack`, `decideDress`; `admin.js:decideDispute`; `core.js:decideLeave` / `cancelLeave`; `jobs.js:reminders`.
- **What happens** (each reproduced):
  - a. A late / early request nobody decided: after the lock Aakash and Varun get "This month is locked", the person gets "already been used". It stays Pending for ever.
  - b. `reminders` keeps sending "Reminder: late / early request waiting" to Aakash every 2 hours, with no end, for a request he is not allowed to decide.
  - c. An "I'm back" that Aakash did not confirm stays in his Approvals list for ever (the random runs produced this in every run: 136 to 276 such outings per batch of 25 to 40 runs).
  - d. A dress flag nobody decided and a dispute Varun had not decided: same. The dispute is still inside its handling; the person never gets an answer.
  - e. A leave request across the month end (30 Nov - 1 Dec) that nobody decided: decidable while December is open (round 9 fix), but once December is locked too it is stuck as "Pending with Aakash" for ever, and reminds for ever. This is the rest of R9-2a.
- **Why it matters**: endless reminders that cannot be stopped teach Aakash to ignore reminders; an open dispute silently dies. I rate it Medium, not High, because for (a) and (e) Aakash must have ignored 2-hourly reminders for days before the lock, and (c) and (d) change no count.
- **Fix**: `lockMonth` should either refuse while something of that month is waiting (list it: "decide these 3 first"), or close every such item with a note, as it already does for leave requests: late / early requests -> "Not decided before the lock", outings -> Confirmed with the tapped time, dress flags -> dismissed, disputes -> must be decided first. A request across the month end must be closable by reject at any time.
- **Reproducers**: `R11-3a` ... `R11-3e`.

### R11-4 (Medium) - a request across the month end, decided after the first month was locked, writes into the locked month
- **Where**: `core.js:decideLeave` -> `onGranted` -> `syncLeaveViolations` (violation dated `r.dates[0]`), `decideLeave` reject -> `markAbsent`; `attendance.js:imBack` (no lock check).
- **What happens**:
  - a. Unannounced request 30 Nov - 2 Dec, still waiting; November is locked on 1 Dec; Aakash approves. The "unannounced leave" violation is written with date 30 Nov. The locked November report does not have it, December does not count it: it is in no month's ladder, and the person cannot dispute it ("This month is locked").
  - b. Same request rejected after the lock: an "Absent – unannounced" row and its violation are created for 30 Nov, inside the locked month. The locked report says 0 violations and "not decided"; the December page shows November with 1.
  - c. An outing of 30 Nov that was never closed: "I'm back" sent on 1 Dec books 389 minutes into locked November. (The phone does not show this button on a later day; reachable only by a direct call.)
- **Why it matters**: a violation the staff member is told about but that counts nowhere and cannot be disputed; rows of a locked month that differ from its locked report.
- **Fix**: date a leave violation by the first day that lies in an open month (or count it in the month of the decision when the first day is locked); `markAbsent`, `recountDay` and `imBack` must skip days of a locked month.
- **Reproducers**: `R11-4a`, `R11-4b`, `R11-4c`.

### R11-5 (Medium) - a violation Varun UPHELD after a dispute is lost for good once it is withdrawn and applies again
- **Where**: `core.js:syncLeaveViolations`, line `if (list.some(function (v) { return v.disputeDecidedBy; })) return;`
- **What happens**: `disputeDecidedBy` is set for both decisions, "removed" and "upheld". The sync reads it as "removed by Varun: never again". So an upheld violation that is withdrawn for any reason (and loses its "upheld" state in that step) can never come back.
- **Steps**: Raunak's unannounced leave on 10 Nov, 1 violation. He disputes, Varun upholds. Varun types 10 Nov as a closed day by mistake and takes it out again one minute later (assumption 54: "the day is as before"). Result: 0 violations.
- **Why it matters**: the one violation the owner looked at personally and confirmed is the one that disappears.
- **Fix**: test the decision, not the decider: "never again" only when a row has `disputeState === 'removed'` AND was decided by a dispute (keep the dispute result in its own field so that "No longer applies" does not overwrite "upheld"); on return restore the earlier state ("upheld").
- **Reproducer**: `R11-5`.

### R11-6 (Medium) - the "3rd emergency" violation Varun removed comes back on another request
- **Where**: `core.js:renumberEmergencies` (order = `decidedAt`) + `syncLeaveViolations` (key = request id + rule).
- **What happens**: the "never again" memory is kept per request. When an earlier emergency of the month is edited and approved again, it gets a new `decidedAt`, becomes "no. 3", and a fresh violation is recorded on it. The month still has the same three emergencies.
- **Steps**: Raunak's emergencies on 4, 10, 17 Nov; the 3rd has the violation. He disputes, Varun removes it (0 violations). On 18 Nov Aakash corrects the reason text of the 4 Nov leave, Varun approves the edit. Result: 4 Nov is now "no. 3", "Emergency leave beyond 2" is recorded again, alerts go out. Assumptions 51 and 53 say it never returns.
- **Why it matters**: Varun's decision is undone by a typo correction.
- **Fix**: an edit that is approved again should keep the original `decidedAt` for numbering (number by first grant); and remember a dispute removal of `emergency-beyond-2` per person and month, not per request.
- **Reproducer**: `R11-6`. The same pattern exists for the minute rules ("not informed after the 3 passes" is keyed to one event); not tested, see N2.

### R11-7 (Medium) - "Leave in a restricted period" stays after the leave was shortened out of the period
- **Where**: `core.js:cancelLeave` (shorten branch) and `admin.js:recheckClashes` (shorten branch): `restrictionViolation` is not worked out again; `syncLeaveViolations` trusts the stored flag.
- **Steps**: restricted period 20-22 Nov ("+1 violation"). Neha's leave 18-20 Nov is approved: 1 violation. On 19 Nov 08:00 Aakash ends it: the leave is now 18 Nov only. The violation stays, although she took no leave in the period. (An edit to the same dates before the start does withdraw it.)
- **Fix**: in both shorten branches recompute `restrictionViolation` for the days that are left, before the sync.
- **Reproducer**: `R11-7`.

### R11-8 (Medium) - a leave entered and taken out again turns a "not informed" lateness into an informed one
- **Where**: `attendance.js:recountDay` (second block: "booked now ... informed").
- **What happens**: when a leave is granted for a day with a late row, the row is set to 0. When that leave is cancelled, `recountDay` finds no row above 0 and books the minutes anew as informed. The original row was "not informed"; its violation does not return.
- **Steps**: Neha checks in 60 min late, not informed: 1 violation. Aakash enters a leave for today for her by mistake and approves it; then cancels it. Result: 60 min informed, 0 violations.
- **Why it matters**: a recorded violation can be erased by entering and cancelling a leave (two taps by Aakash, traceable in Audit).
- **Fix**: in `recountDay`, first bring back rows of that day that were set to 0 by an earlier recount (same row, same `informed`, same violation key); book new "informed" minutes only for time that never had a row.
- **Reproducer**: `R11-8`.

### R11-9 (Medium) - violation rows of a locked month are changed afterwards
- **Where**: `core.js:syncLeaveViolations` (works on ALL months of a person, never looks at the lock); `views.js:lockMonth` (closes waiting requests without running the sync); `admin.js:savePerson` (flag changes are not dated, unlike roster / active in assumption 38).
- **What happens**:
  - a. Varun ticks "no approval needed" for a person in December. At that person's next leave change the sync withdraws ALL their leave violations of every month, locked November included, and sends "Violation withdrawn" to the person and to Varun. (Unticking it later records violations for old "Recorded" leaves.)
  - b. A November leave that Aakash edits on 1 Dec (typo in the reason) waits again; the lock closes it as "Not decided" but leaves its violation live, and the locked report counts it. At the person's next leave change the sync withdraws it: "Violation withdrawn" alert, row changed inside the locked month. Seen in 2 random runs (seeds 321, 418); case (a) in 1 (seed 211).
  - In both cases the locked report itself keeps its number (that part holds), but the December page ("last 3 months") shows November with one violation fewer than the locked report, and the person has an alert saying the violation is gone.
- **Why it matters**: two screens of the same app disagree about a closed month; assumption 30 says nothing dated in a locked month is changed in place.
- **Fix**: `syncLeaveViolations` must leave every violation dated in a locked month alone; `lockMonth` should run the sync for the people whose requests it closes BEFORE it takes the results; `savePerson` should treat `noApproval` (and role) like roster / active: valid from today.
- **Reproducers**: `R11-9a`, `R11-9b`.

### R11-10 (Medium) - minutes that a leave covered, or that came before the leave, are not counted again
- **Where**: `attendance.js:recountDay` (late / early only), `imBack` / `confirmBack`, `manualCheckIn`.
- **What happens**:
  - a. Going out 25 min, then a full-day leave for the same day is asked and approved (she has to go home): the day is 1 leave AND 25 min from the 2-hour bank. Assumption 55: no minutes of any kind on a full-leave day. Seen in 5 of 5 random batches.
  - b. On an approved leave day she comes in and goes out for 90 min; Aakash then cancels the leave because she worked. The 90 min were skipped at the tap and are never booked: bank used 0.
  - c. An absence is excused (it becomes an approved full day); the next day Aakash enters the check-in (she had come at 12:30). The absence is taken back, the reply says "180 min late", but no minutes are booked: the day shows no leave, no half day, nothing. `manualCheckIn` runs `checkIn` while the excused day still counts as full leave and does not call `recountDay` afterwards.
- **Fix**: let `recountDay` also handle `out` rows (set to 0 when the day stops counting; book from the Outings row when it counts again); call `recountDay` in `manualCheckIn` after the system row is cancelled.
- **Reproducers**: `R11-10a`, `R11-10b`, `R11-10c`.

### R11-11 (Low) - "Violation withdrawn" is announced; when it applies again nobody is told
- **Where**: `core.js:syncLeaveViolations` ("Applies again") and `attendance.js:syncViolations` ("Applies again after a correction"): no `notify`.
- **Steps**: closed day entered by mistake and removed: the person's last alert is "Violation withdrawn", the violation is live again. The 24-hour dispute window still runs from the first recording.
- **Fix**: send "Violation applies again" to the people who got "withdrawn".
- **Reproducer**: `R11-11`.

### R11-12 (Low) - no evening-before reminder after the dates of a leave were changed
- **Where**: `jobs.js:eveningBefore` (`once` by request id).
- **Steps**: leave 6 Nov, reminded on 5 Nov; edited to 12 Nov and approved; no reminder on 11 Nov.
- **Fix**: use `r.id + ':' + r.dates[0]` as the reference.
- **Reproducer**: `R11-12`.

### R11-13 (Low) - the late / early request of a person who has left keeps reminding Aakash
- **Where**: `jobs.js:reminders`, ShortRequests part (the leave part has the check since round 7).
- **Fix**: same `active` check; better, close open requests when a person is made inactive.
- **Reproducer**: `R11-13`.

### R11-14 (Low) - a waiting half day approved for a day meanwhile entered as "shop closed" records an absence + violation on the closed day
- **Where**: `core.js:onGranted` (the half-day `markAbsent` has no closed-day check and runs after the sync).
- **Steps**: half day asked for 20 Nov, not decided; 21 Nov Varun enters 20 Nov as closed; Aakash approves the request: "Absent – unannounced" (half) + 1 violation on the closed day, alerts to her, Aakash and Varun. It goes away only when some later change of her leaves runs the sync.
- **Why Low**: needs three unusual things together; a wrong violation while it lasts.
- **Fix**: skip closed days (and roster Sundays) in that `markAbsent`; run the sync last.
- **Reproducer**: `R11-14`.

## Earlier fixes that are not complete

| Earlier fix | What is left | Here |
|---|---|---|
| R8 "ending a running leave at noon no longer makes today an absence" (assumption 49) | on the last day the whole leave is cancelled | R11-1 |
| R9-5 "leave cancelled after arrival books the minutes" (assumption 57) | not when the cancel comes before the arrival; not for going-out minutes; overwrites "not informed" | R11-2, R11-10b, R11-8 |
| R9-2a "request across a locked month end" | stuck again once the second month is locked; its decision writes into the locked month | R11-3e, R11-4 |
| R8-5 "undecided requests are closed with the month lock" | late / early requests, outings, dress flags, disputes are not; the sync is not run | R11-3, R11-9b |
| R9-6 / R8-4 "a violation removed after a dispute never comes back" | an UPHELD one never comes back either; a removed 3rd-emergency one comes back on another request | R11-5, R11-6 |
| R9-7 "going-out minutes on a leave day" | still counted when the leave is granted after the outing | R11-10a |
| R9-12 "leave on a closed day earns no violation" | the half-day absence path | R11-14 |
| R7 "reminders stop for a leaver" | late / early requests | R11-13 |

## What held up (tried and found correct)

- `syncLeaveViolations`: no doubling, no violation on a waiting request touched, a waiting request keeps what it has, rejected / cancelled / shortened / closed-day / rule-change paths all end in step with the rows; `noApproval` people, override rows and excused absences never get a leave violation; a violation removed by a dispute does not come back through edit + approve (the round 9 reproducers for this pass).
- Emergency numbering in the order granted, across edits, rejects, cancels and closed days: always equal to an independent recount (except the dispute case R11-6).
- One day never more than 1 leave: half day + automatic half day + half absence, late over 4 h 30 min on a half-day, absence + excuse, override: all capped.
- Ladder, quota, bank, passes, >30 min, >2 h and >4 h 30 min: `myMonth` equal to the independent recount in all runs.
- Locked month: the locked report (`MonthSheet`) never changed in any run, and neither did the leave, minute and punch rows of November; only the violation rows did (R11-9).
- End-of-day job late, twice, the next morning, and catch-up of missed nights: no day marked twice, no absence for a day with a check-in.
- Reminders: none between 00:00 and 06:00 IST (job run at 00:30, 03:00, 05:59 every night), none addressed to an inactive person, no alert twice.

## Not reproduced (read in the code or seen once; not counted)

- N1. A one-day leave cancelled by Aakash at noon, and the person does not come: the evening job records an absence + violation. Assumption 49 can be read both ways for a one-day leave.
- N2. Minute rules: a "not informed after the 3 passes" or "extra 2 hours" violation removed by Varun is keyed to one event; if an earlier event is added or taken away later (hand check-in for a past day, closed day), the rule lands on another event and is recorded again. Same pattern as R11-6; not tested.
- N3. `recountDay` on a date that is entered as closed sets that day's late / early rows to 0 for good; if the closed day is removed later the minutes return as "informed". Needs a leave decision for that date while it is closed.
- N4. A roster change made on the Sunday itself after the person has checked in leaves late minutes on what is now a roster Sunday off (seen once, seed 127 with people changes; not isolated).
- N5. An emergency request whose first date is a closed day or roster Sunday at the end of a month is numbered in that month although its first real leave day is in the next.
- N6. A manager's own unannounced leave gets a violation row (Aakash and Varun are "not tracked" for attendance; for leave violations the handoff is not clear).
- N7. `src/gas/main.js` cannot run here; read only.

## Open questions, not bugs

Assumptions marked TO CONFIRM (16, 18, 19, 23, 28, 47) and 52 were not counted.
