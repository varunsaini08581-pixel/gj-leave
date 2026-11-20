# GJ Leave & Attendance - Review round 13: rules and counting, the whole life of a record

Reviewer: independent (did not write the code). Date: 20 Nov 2026.
Code reviewed: `/home/claude/gj-leave`, commit b471950 as stated by the author (server version 9, schema 4).
Reproducers: `/home/claude/findings/repro-round13.test.js` - 17 tests for 10 findings, **all 17 fail on the current code**, each at the assertion named in its title (`node --test /home/claude/findings/repro-round13.test.js`).

**The code did not change during the review.** SHA-256 of all 25 files under `src/` and `docs/`, taken at the start and at the end: identical.
I did not run git, did not use the network, changed nothing inside `/home/claude/gj-leave`, and wrote only `round13.md` and `repro-round13.test.js` in `/home/claude/findings/` (scratch in `/tmp/r13`). The folder already holds `round14.*` files; they are not mine and I did not open or touch them.

The project's own suite (`cd /home/claude/gj-leave && node --test`): **362 tests, 361 pass, 0 fail, 1 skipped.**

## Counts

| Severity | Count | Findings |
|---|---|---|
| Critical | **0** | |
| High | **2** | R13-1, R13-2 |
| Medium | **5** | R13-3 ... R13-7 |
| Low | **3** | R13-8, R13-9, R13-10 |

Calibration, plainly:
- Both Highs are at the lower edge of High. Both are wrong only in the staff member's favour (a violation or minutes that are NOT counted); nobody is punished wrongly. I rate them High because each one is reached by ordinary taps and changes the violations ladder (R13-1) or the leave quota (R13-2). Round 11 rated a sibling of R13-2 (R11-10b) Medium; if you use that scale, R13-2 is Medium and there is one High.
- Both are again of the kind "something is changed AFTERWARDS", and both are in code this commit added or changed (`hadLeave`, `cancelLeave` shorten branch).
- `syncLeaveViolations` itself held: no doubling, no loss across the month end, nothing of a locked month touched (see "What held").

## Findings

### R13-1 (High) - any leave that was once granted and later cancelled or shortened makes a late arrival on that day "informed"; staff can do this themselves
- **Where**: `src/server/attendance.js:hadLeave`, used by `checkIn` (`informed = ... || hadLeave(...)`).
- **What happens**: `hadLeave` is true for every non-system request with status `Cancelled` and a `decidedAt`, and for every granted request whose history has a "shortened" entry that once covered the day. It does not look at WHO cancelled, WHEN, or whether the cancel was for that day. So a leave that the system approved by itself and that the staff member cancelled herself days ahead still turns her lateness on that day into "informed": no "not informed, more than 30 min" violation, no pass used, no approval by Aakash, no clash check.
- **Steps (a)**: 10 Nov Neha asks leave for 20 Nov: approved by the system. 19 Nov 20:00 she cancels it. 20 Nov she checks in at 11:00 (90 min late, told nobody). Reply: `informed: true`; 0 violations. Without the cancelled leave: `informed: false`, 1 violation.
- **Steps (b)**: leave 18-20 Nov; 19 Nov 08:00 Aakash ends it (she is back from the 19th). 20 Nov she comes 60 min late, told nobody: `informed: true`, 0 violations.
- **Why it matters**: the owner decided that a late arrival is informed only when Aakash approved it. This is a standing way round that rule for every staff member: ask a 1-2 day leave 48 hours ahead, cancel it the evening before, come late. By accident it happens whenever someone cancels a planned leave and is late that day. Assumption 62 only covers "cancelled for today".
- **Fix**: informed only when the leave covering that day was cancelled / ended by Aakash or Varun ON that day, after the person's duty start (or keep an explicit marker "known absence for date D" written by that tap). A cancel by the person, or any cancel before the day, gives nothing.
- **Reproducers**: `R13-1a`, `R13-1b`.

### R13-2 (High) - "End this leave" after the person has checked in: the day given back is never counted
- **Where**: `src/server/core.js:cancelLeave`, shorten branch: `ctx.db.update('LeaveRequests', id, { dates: gone, ... })` and then `r.dates.forEach(function (d) { if (gone.indexOf(d) === -1 && hooks.recountDay) ... })`. `r` is the stored row; after the update `r.dates` IS `gone`, so the loop body never runs. `recountDay` is dead code in this branch (Sheet store and memory store alike).
- **What happens**: a running leave is ended while the person is already checked in. The day is given back as a working day, but its late / early / going-out minutes (skipped at the tap because it was a leave day) are never booked. With the two taps the other way round they are booked.
- **Steps (a)**: Neha's leave 18-20 Nov. 20 Nov she checks in at 13:00, Aakash taps "End this leave" at 13:30. Result: 2 leave days, 20 Nov counts nothing. Same day with Aakash tapping at 12:30 and her check-in at 13:00: 210 min informed = automatic half day, 2.5 leaves. A one-day leave cancelled after check-in also gives the half day (that branch works).
- **Steps (b)**: leave 18-21 Nov; 19 Nov check-in 10:15 (45 min late), Aakash ends the leave 10:30: 19 Nov has 0 minutes.
- **Why it matters**: wrong leave quota (0.5 day) or bank minutes each time someone comes back early from a multi-day leave and checks in before Aakash taps; about half of all early returns. Assumptions 57 and 62 say these minutes count.
- **Fix**: copy the dates before the update (`var before = r.dates.slice()`), loop over `before`.
- **Reproducers**: `R13-2a`, `R13-2b`. Also seen in the random runs.

### R13-3 (Medium) - other ways a day gets or loses its leave do not count the day again
- **Where**: `admin.js:overrideLeave` (no `recountDay`), `admin.js:editLeave` (dropped dates are not recounted), `admin.js:recheckClashes` (no `recountDay`), `attendance.js:confirmBack` (corrected time written without `dayCounts`).
- **What happens / steps**:
  - a. Neha comes 45 min late, not informed (1 violation). Varun enters an override leave for today. The day is 1 leave AND 35 bank minutes AND the violation stays. An ordinary approved leave sets them aside (assumption 55).
  - b. Leave on 20 Nov; she comes in at 11:30 instead; Aakash moves the leave to 21 Nov (edit, then approve). The 120 late minutes of 20 Nov are never booked (a cancel books them).
  - c. Raunak and Manish both on leave 20 Nov (rule C3 off); Manish checks in 90 min late; Varun switches C3 on: Manish's leave is given back, his 90 min are never booked.
  - d. Going out 40 min, then a full-day leave is approved for the day (minutes set aside), then Aakash confirms "back" with a corrected time: 35 min are back on the leave day.
- **Why it matters**: minutes and a violation on a full-leave day (a, d), or lateness never counted (b, c). Unusual orders, small amounts.
- **Fix**: call `recountDay` for every date whose leave cover changed in `overrideLeave`, `editLeave` (old dates and new dates) and `recheckClashes`; in `confirmBack` write the corrected minutes through `recountDay` or only when `dayCounts`.
- **Reproducers**: `R13-3a` ... `R13-3d`. (a), (b) and (c) were also seen in the random runs.

### R13-4 (Medium) - `recountDay` brings set-aside minutes back wrongly (round 11 fix R11-8 is incomplete)
- **Where**: `attendance.js:recountDay` (`aside = ...[0]` gets ALL the minutes; a row that was only cut down has no "set aside" twin).
- **Steps (a)**: approved early leaving 17:30, she leaves 16:50: 60 min informed + 40 min not informed, 1 violation. Aakash enters a leave for the day by mistake and cancels it: one row with 100 min informed, the other 0; the violation is gone.
- **Steps (b)**: 300 min late, not informed (violation, full day). A morning half day is entered by mistake (row cut to 30) and cancelled: the row stays 30, no violation, no automatic day.
- **Why it matters**: a recorded violation erased by two taps of Aakash; same class and severity as R11-8.
- **Fix**: keep the original minutes on the row when it is set aside or cut (`asideMinutes`), and restore each row to its own value up to what the day now has.
- **Reproducers**: `R13-4a`, `R13-4b`. (b) was also seen in the random runs.

### R13-5 (Medium) - a closed day entered by mistake and removed after that day: what happened on the day is never counted
- **Where**: `admin.js:setSetting('closedDays')` (runs both syncs but no `recountDay`, no absent check); `attendance.js:checkIn / checkOut / imBack` (book nothing on a closed day); `jobs.js:endOfDay` (looks back 3 days).
- **Steps**: 17 Nov Varun types 20 Nov as closed (he meant another date). 20 Nov the shop works: Neha checks in 90 min late, Manish stays away with no request. 25 Nov Varun removes the closed day. Result: Neha 0 minutes and no violation; Manish no absence, ever.
- **Why it matters**: assumption 54 says the day "is as before". For a whole shop day the lateness, early leaving, outings and absences are lost. Needs a wrong date that is noticed late.
- **Fix**: when a closed day is removed, run `recountDay` for every person with a check-in on it and `Att.endOfDay` for that date (if the day is over and the month is open).
- **Reproducers**: `R13-5a`, `R13-5b`. Also seen in the random runs.

### R13-6 (Medium) - "no approval needed" unticked: days from before the change get violations
- **Where**: `attendance.js:syncViolations` and `core.js:syncLeaveViolations` read `noApproval` as it is today; `admin.js:savePerson` dates only roster / active changes (assumption 38).
- **Steps**: Muskan (intern, recorded only) is 105 min late on 6 Nov: no violation. 15 Nov Varun makes her regular staff. 17 Nov she checks out 5 min early: "Not informed, more than 30 min" is recorded with date 6 Nov, with alerts. Her earlier "Recorded" unannounced leaves get violations the same way at her next leave change. The other direction (ticking it) withdraws the leave violations of the open month but not the minute violations.
- **Why it matters**: happens the one time an intern is taken on; she starts with violations for days on which she could not get one. Round 11 (R11-9a) asked for flags to be dated; only the locked month was protected.
- **Fix**: treat `noApproval` like roster / active in `People.history` and judge each day by the flag as it was on that day.
- **Reproducer**: `R13-6`. Also seen in 2 of the 8 random runs with people changes.

### R13-7 (Medium) - a month can be locked before the absent check of its last days has run
- **Where**: `views.js:lockMonth` (no check that the evening job has dealt with the last days); `attendance.js:endOfDay` and `core.js:markAbsent` (skip a locked month).
- **Steps**: the 21:00 job of 30 Nov does not run (assumption 31 expects such nights and catches them up). 1 Dec 10:00 Aakash and Varun lock November. 1 Dec 21:00: the catch-up skips 30 Nov. Neha, away with no request on 30 Nov: locked report 0 leaves, 0 violations.
- **Why it matters**: an absence lost for good. Needs a failed timer on the last night plus a lock the next morning.
- **Fix**: `lockMonth` runs `Att.endOfDay` for the last 3 days of the month first (or refuses until those days are done).
- **Reproducer**: `R13-7`.

### R13-8 (Low) - an open dispute is dropped when the violation is withdrawn and applies again
- **Where**: `core.js:syncLeaveViolations` ("Applies again" sets `disputeState` to `''` or `'upheld'`; "No longer applies" overwrites `'open'`).
- **Steps**: Raunak disputes an "unannounced leave" violation (waiting for Varun). Varun enters that day as closed by mistake and removes it. The violation is live again with no dispute; it is not in Varun's list; after 24 hours Raunak cannot dispute again.
- **Fix**: keep the dispute state in its own field through withdraw / return; restore `'open'`.
- **Reproducer**: `R13-8`.

### R13-9 (Low) - month lock: a first confirmation can never be completed when the other role has no active person
- **Where**: `views.js:lockMonth` (`acks.some(lockedBy === actor.id)` is checked before `others.length`).
- **Steps**: Varun confirms November; Aakash is made inactive before he confirms; Varun taps again: "You have already confirmed. Waiting for ." Workaround: make someone a manager. A confirmation also cannot be taken back.
- **Fix**: when `others` is empty, lock.
- **Reproducer**: `R13-9`.

### R13-10 (Low) - "Rejected – clash" after a rule change: the alerts name the wrong days
- **Where**: `admin.js:recheckClashes` (same overwrite as R13-2: `r.dates` is read after the update).
- **Steps**: Manish's leave 19-20 Nov is cut to 19 Nov by a rule change on 20 Nov. His alert reads " — a clash rule was changed. ..." (no date); Raunak is told "Manish had 19 Nov" (the day that stayed, not the day given back).
- **Fix**: take the dates before the update.
- **Reproducer**: `R13-10`.

## Fixes of rounds 11 and 12: do they hold?

| Earlier fix | Result |
|---|---|
| R11-1 last day keeps earlier days | holds; but the day given back is not counted when she checked in first (R13-2) |
| R11-2 cancel before arrival = informed | holds for that case; made too wide (R13-1) |
| R11-3 lock closes waiting items | holds: after 102 runs every waiting item could be closed and the Approvals list was empty |
| R11-4 nothing written into a locked month | holds |
| R11-5 upheld restored / R11-6 forgiven emergency | hold (see question Q1) |
| R11-7 restriction flag recomputed on shorten | holds |
| R11-8 set-aside rows restored | holds for one row set to 0; not for two rows or a cut-down row (R13-4) |
| R11-9 locked month rows frozen | holds for the lock; `noApproval` in the open month not fixed (R13-6) |
| R11-10 going-out minutes / hand check-in | a, b, c hold; corrected back time not (R13-3d) |
| R11-11 ... R11-14 | hold |
| Round 12 | not re-tested here except through the simulation (no ERROR reply, no job exception) |

## What held (tried and found correct)

Random simulation (`/tmp/r13/sim.js`, seeded): 102 runs, each 43 shop days (2 Nov - 14 Dec), 11 people, about 156,000 API calls through `Api.handle` on the fake Sheet with the read cache; hourly job 11 times a day (also 00:30, 03:00, 05:59), evening job, end-of-day job (12% of nights skipped, 25% run twice, 5% also the next morning); November confirmed and locked by Aakash and Varun on random days 1-5 Dec; closed days added / removed, clash rules on / off, restrictions, overrides, edits, cancels, shortenings, hand check-in / check-out, undo check-out, keep / excuse / take back absences, incidents, disputes and decisions, dress flags; in 8 runs also people made inactive / noApproval / renamed / roster changed.
- No reply with code ERROR, no job exception: **held**.
- No day with more than 1 leave in the rows: **held**.
- `myMonth` leave total equal to an independent recount of the rows; ladder equal to the live violation rows; no negative or NaN number: **held**.
- Every live leave violation has its reason and every reason its violation, emergency numbering equal to the order granted, no violation doubled, both sync routines at rest: **held**, except after a `noApproval` change (R13-6).
- Locked November: locked report, leave rows, minute rows, punches, late / early requests, outings and violation rows never changed after the lock (apart from Varun's dispute decision and the "kept as absent" mark): **held**.
- At the end every waiting item (leave, late / early, outing, dress flag, dispute, absence) could be closed: **held**.
- No reminder between 00:00 and 06:00 IST, none to an inactive person, none twice in one job: **held**.
- Late / early / going-out minutes equal to an independent recount from the punches and outings: **broken** only in the classes R13-2, R13-3, R13-4b, R13-5.

Targeted checks that held: first-open-day dating (a leave across 30 Nov / 1 Dec gets exactly one violation, in the month where its first open day lies; a violation already in locked November is not recorded again in December); `markAbsent` on closed days and locked months; a violation removed by Varun does not return through edit, cancel, closed day or rule change; "forgiven" does not swallow a 4th or 5th emergency while the forgiven leave stands (also after an earlier emergency is edited and approved again); the note-text test ("Dispute removed:") - by reading only: the one place where text typed by Aakash lands in such a note is the excuse reason of an absence, and an excused absence can never earn its violation again; `manualCheckIn` takes back plain, excused and half absences before booking.

## Not reproduced (read in the code, not counted)

- N1. A running leave across a locked month end with a check-in on one of its locked days cannot be ended (`assertOpen` on the freed days); an edit would be the way round.
- N2. An emergency request 30 Nov - 1 Dec granted after November was locked is numbered in November but its violation and cut day land in December.
- N3. Minute rules: "Applies again after a correction" sets the state to `''`, also when it was "upheld" (label only).
- N4. `hadLeave` is used for late arrival only; leaving early on a day whose leave was cancelled is "not informed" when the cancel came first and "informed" when the check-out came first.
- N5. `src/gas/main.js` cannot run here; read only.

## Questions for the owner (not counted)

- Q1. Varun removes the "3rd emergency" violation of one leave; that leave is then cancelled; a new 3rd emergency in the same month gets no violation (the day is still cut). The code does this on purpose ("stays removed for that month"). Should the forgiveness belong to the leave or to the month?
- Q2. A violation of 30 Nov 21:00 cannot be disputed once November is locked on 1 Dec, although 24 hours have not passed (follows assumption 30). Wait 24 hours before a lock is possible?
- Q3. A one-day leave cancelled by Aakash at noon and the person does not come: absence + violation in the evening (assumptions 49 and 61 read differently for one day).
- Assumptions marked TO CONFIRM / OPEN (16, 18, 19, 23, 28, 47, 52, 63) were not counted.
