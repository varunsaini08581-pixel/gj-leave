# GJ Leave & Attendance - Review round 15: rules and counting, the whole life of a record

Reviewer: independent (did not write the code). Date: 20 Nov 2026.
Code reviewed: `/home/claude/gj-leave`, commit 4169780 as stated by the author (server version 9, schema 4).
Reproducers: `/home/claude/findings/repro-round15.test.js` - 13 tests for 9 findings, **all 13 fail on the current code**, each at the assertion named in its title (`node --test /home/claude/findings/repro-round15.test.js`).

**The code did not change during the review.** SHA-256 of all 25 files under `src/` and `docs/`, taken at the start and at the end: identical (hash of the list `77ee96ed24836cb4...`). The session was restarted once in the middle; the hash list from the start survived and still matched.
I did not run git, did not use the network, changed nothing inside `/home/claude/gj-leave`, and wrote only `round15.md` and `repro-round15.test.js` in `/home/claude/findings/` (scratch in `/tmp/r15`).

The project's own suite (`cd /home/claude/gj-leave && node --test`): **398 tests, 397 pass, 0 fail, 1 skipped.**

## Counts

| Severity | Count | Findings |
|---|---|---|
| Critical | **0** | |
| High | **1** | R15-1 |
| Medium | **5** | R15-2 ... R15-6 |
| Low | **3** | R15-7, R15-8, R15-9 |

Calibration, plainly:
- R15-1 is at the lower edge of High. It is the first finding of these rounds that is wrong AGAINST the staff member (a violation she should not have). It comes from the round 13 fix of `hadLeave` (the "same day only" rule), so it is a regression of that fix. If the owner reads assumption 66 literally ("ONLY when taken back on that same day") it is behaviour as written, and then it is an owner question, not a bug; I count it because assumptions 49, 57 and 62 say the opposite for the same facts.
- All five Mediums need an unusual order (an entry made and taken back, a rule or Settings change in between). None is reachable by a staff member alone.
- The round 13 fixes themselves hold (table below). The random runs found only the classes R15-2, R15-3, R15-6 and R15-9; everything else held.

## Findings

### R15-1 (High) - a leave day she worked, given back on a LATER day, gets a "not informed" violation
- **Where**: `src/server/attendance.js:hadLeave` (`dayOf(h.at) !== date` -> false), used by `recountDay` (`told = hadLeave(...)`), called from `core.js:cancelLeave` (shorten and cancel branches).
- **What happens**: `hadLeave` is true only when Aakash / Varun took the leave back on the day itself. When the leave covered the day for the whole day and is taken back the next morning or later, `recountDay` books the lateness of that day as NOT informed: over 30 min = violation "Not informed, more than 30 min"; 11 to 30 min = a not-informed pass used.
- **Steps (a)**: Neha has approved leave 18-20 Nov. 19 Nov she comes back early, checks in 11:00, works to 18:30 (nothing is counted: leave day). 20 Nov 09:00 Aakash taps "End this leave". Result: 19 Nov = 90 min late, `informed: false`, 1 violation. With the same tap on 19 Nov at any time: `informed: true`, 0 violations.
- **Steps (b)**: one-day leave 19 Nov, she works that day from 10:30; Aakash cancels the leave on 20 Nov as a correction: 60 min not informed, 1 violation.
- **Why it matters**: coming to work on a day of approved leave ends in a violation on the ladder (2nd = Rs 500 bonus and target allowance, 3rd = notice), and the "Violation recorded" alert goes out a day later. Aakash has a reason to make the tap: without it she loses a leave day for a day she worked (assumption 49 says that day "is given back").
- **Why High and not Medium**: no mistake and no unusual order is needed: an early return from leave (a few times a year in a shop of 10) plus ONE ordinary manager tap that is not made on the same day. It changes the violations ladder, and nobody did anything wrong.
- **Fix**: in `hadLeave` accept a take-back by Aakash / Varun on the day OR on any later day (`dayOf(h.at) >= date`); "earlier day" and "by the person" stay excluded, which is what R13-1 needed.
- **Reproducers**: `R15-1a`, `R15-1b`.

### R15-2 (Medium) - approving a late / early request while its minutes are set aside loses them for good
- **Where**: `attendance.js:decideShort` (`ctx.db.update('DayMinutes', m.id, { informed: true, note: 'Approved later by ...' })` replaces the note and with it "[was N]"); `recountDay` (`was()` then reads 0, and `!mine.length` is false, so nothing is booked).
- **Steps (a)**: late request waiting, Neha checks in 45 min late (row 45). Varun enters a leave for her for today by mistake (row 0 "[was 45]"). Aakash approves the late request (note becomes "Approved later by Aakash"). The leave is cancelled. Result: 0 minutes on the day; correct: 45 informed.
- **Steps (b)**: the same with a shop-closed day entered and removed instead of the leave.
- **Why it matters**: assumptions 54 and 67 say the day "is as before". Up to 2 hours of lateness vanish from the bank. Seen 14 times in the 52 random runs I classified by cause (always this order: minutes booked, cover entered, request approved, cover removed).
- **Fix**: in `decideShort` keep the tail: `note: 'Approved later by X' + (/\[was \d+\]/.exec(m.note) || [''])[0]`; better, store the original minutes in their own column instead of in the note.
- **Reproducers**: `R15-2a`, `R15-2b`.

### R15-3 (Medium) - `recountDay` books missing time only when the day has no row of that kind
- **Where**: `attendance.js:recountDay` (`if (left[kind] > 0 && !mine.length)`).
- **Steps (a)**: approved morning half day 09:30-14:00; Neha arrives 14:40 (row: 40 min late). Aakash cancels the half day afterwards (entered by mistake). The day now has no leave and she arrived 310 min after duty start, but the row stays 40: month = 0 leave, 30 bank minutes. With the cancel tapped BEFORE the check-in the same day is 310 min = 1 full day. Also with a half day in the middle of the shift and a hand-entered check-in (random run, seed 103: booked 120, recount 330).
- **Steps (b)**: check-out at 17:00 taken back by Aakash (row set to 0), a leave is entered for the day, she checks out at 17:40, the leave is cancelled: the 50 min early are never booked because the voided row exists.
- **Why it matters**: a tap-order difference of a whole leave day (a) in the quota. Needs a half day / leave entered and taken back after the punch.
- **Fix**: book the remainder whenever `left[kind] > 0` after the existing rows have been restored (a new row "Counted after the day became a working day again"), and leave out rows voided by `undoCheckOut` (source punch is `out-void`).
- **Reproducers**: `R15-3a`, `R15-3b`. (a) was seen 7 times in the 52 classified random runs.

### R15-4 (Medium) - a one-day leave taken back by a rule change is "not informed"; a longer one is "informed"
- **Where**: `attendance.js:hadLeave` (knows `cancelled`, `shortened...`, `edited`); `admin.js:recheckClashes` writes `rejected – clash (rule changed)` when no day of the leave is over.
- **Steps**: Raunak and Manish both have leave on 20 Nov (rule C3 off). Manish checks in 90 min late. Varun switches C3 on: Manish's leave becomes "Rejected – clash", his 90 min are booked `informed: false`, 1 violation. For a leave 19-20 Nov the same rule change writes "shortened – clash" and the 20th is informed.
- **Why it matters**: a violation caused by Varun's own Settings change; assumption 66 names the rule change as one of the take-backs that count. Rule change on a day somebody is on leave and at work: rare.
- **Fix**: in `hadLeave` also accept `/^rejected – clash \(rule changed\)/` when `r.dates` holds the date.
- **Reproducer**: `R15-4`.

### R15-5 (Medium) - a cancelled AFTERNOON half day makes MORNING lateness "informed"
- **Where**: `attendance.js:hadLeave` (does not look at `kind` / `halfStart`).
- **Steps**: Neha has an approved half day from 14:00 on 20 Nov. 09:00 Aakash cancels it ("she will work the full day"). She arrives 11:00, 90 min late, told nobody. Reply `informed: true`, no violation, no pass used. With the half day still in place the same arrival is not informed + 1 violation.
- **Why it matters**: this is the remaining way to get "informed" lateness with nobody approving the lateness (focus point 2). It needs Aakash's cancel on that day, so a staff member cannot do it alone; she can ask for it ("cancel my half day, I am coming") and then come late.
- **Fix**: for a half day, `hadLeave` counts only when the time between duty start and the arrival lies inside the half-day window (a morning half day).
- **Reproducer**: `R15-5`.

### R15-6 (Medium) - a late absent check judges "records only" by today's flag, not by the day's
- **Where**: `core.js:markAbsent` (`p.noApproval ? 'Recorded' : ABSENT`, and the violation is inserted directly, not through `addViolation` / `Cal.asOn`). Reached from `jobs.js:endOfDay` (3-day catch-up), `admin.js:setSetting` (closed day removed) and `views.js:lockMonth` (last 7 days) - the three new callers of this commit.
- **Steps (a)**: Muskan (records only) is away 19 Nov, the 21:00 job does not run. 20 Nov Varun makes her regular staff. 20 Nov 21:00 catch-up: "Absent – unannounced" + 1 violation dated 19 Nov. Assumption 68: the flag is judged by the day.
- **Steps (b)**: the other way round (regular on the 19th, records only from the 20th): the absence of the 19th is "Recorded" with no violation.
- **Why it matters**: the R13-6 fix covers `syncViolations` / `syncLeaveViolations` but not this path; the wrong violation stays until the next leave change of that person (the sync then withdraws it), or for good when the month lock made it. Needs a flag change within days of a missed night / removed closed day. Seen in 3 of the 21 random runs with people changes (closed day removed after the flag change).
- **Fix**: in `markAbsent` use `Cal.asOn(p, date).noApproval` for both the status and the violation.
- **Reproducers**: `R15-6a`, `R15-6b`.

### R15-7 (Low) - early leaving on a day whose leave was taken back: informed or not by tap order
- **Where**: `attendance.js:checkOut` (never asks `hadLeave`) against `recountDay` (`told = hadLeave(...)` for `early` too).
- **Steps**: leave for today, she works from 09:30. Order 1: Aakash cancels 17:00, she checks out 17:30 = 60 min not informed, 1 violation. Order 2: she checks out 17:30, Aakash cancels 17:45 = 60 min informed, 0 violations. (N4 of round 13, now reproduced.)
- **Fix**: decide which is meant (I would say not informed in both) and use the same test in both places.
- **Reproducer**: `R15-7`.

### R15-8 (Low) - lateness booked by `recountDay` forgets the stated time
- **Where**: `attendance.js:recountDay` (`addDayMinutes(..., told, undefined, ...)`).
- **Steps**: approved late request "by 10:00"; she arrives 11:00 on a day entered as closed by mistake; the closed day is removed: 90 min fully informed. On a normal day: 30 informed + 60 not informed = violation.
- **Fix**: pass `hhmmToMin(q.time) - day.start` as `statedMinutes` when the approved request is what makes it informed.
- **Reproducer**: `R15-8`.

### R15-9 (Low) - a Settings change of "records only" / Sunday roster applies from today, but today is not counted again
- **Where**: `admin.js:savePerson` (no `recountDay`, no sync for today).
- **Steps**: Neha checks in 90 min late (1 violation); at noon Varun ticks "no approval needed". The violation stays in her month until her next late / early / outing event, then is withdrawn with an alert (here: at the next day's check-in). The other direction: a violation appears at a later unrelated tap. Same for the roster: a person given "off" for the Sunday she is already working keeps that day's minutes (random run, seed 119: 200 + 70 min on a roster-off day).
- **Fix**: after a change of `noApproval` / `sundayOff` / `active`, run `recountDay(today)`, `syncViolations` and `syncLeaveViolations` for that person. Or let the change apply from tomorrow.
- **Reproducer**: `R15-9`.

## Fixes of round 13: do they hold?

| Round 13 fix | Result |
|---|---|
| R13-1 `hadLeave` (own cancel, earlier-day take-back) | holds. Made too narrow on the other side: R15-1; gaps R15-4, R15-5 |
| R13-2 shorten after check-in | holds (day is counted; informed when same day) |
| R13-3 override / edit / rule change / corrected back time | minutes hold in all four; informed flag after a one-day rule-change rejection: R15-4 |
| R13-4 "[was N]" restore in the same pieces | holds for cancel / shorten / edit / override / closed day; broken by `decideShort` (R15-2) and when the day needs MORE than the rows had (R15-3) |
| R13-5 closed day removed | holds (recount + absent check); stated time lost: R15-8 |
| R13-6 per-day "records only" | holds in both syncs; not in `markAbsent` (R15-6); same-day change not counted at once (R15-9) |
| R13-7 lock runs the absent check | holds |
| R13-8 dispute state kept through withdraw / revive | holds |
| R13-9 lock with no person in the other role | holds |
| R13-10 alert dates | holds |

## What held (tried and found correct)

Random simulation (`/tmp/r15/sim.js`, seeded): 72 runs (51 with fixed people, 21 with random people changes: records-only, active, Sunday roster), each 43 shop days (2 Nov - 14 Dec), 9 staff + Aakash + Varun, about 163,000 API calls through `Api.handle` on the fake Sheet with the read cache. Hourly job 10 times a day (also 00:30, 03:00, 05:59), evening job, end-of-day job (12% of nights skipped, 25% run twice, 5% also at 07:00), e-mail job; November confirmed and locked on a random day 1-5 Dec; leaves (full, half at the start / middle / end of the shift, entered by Aakash), decisions, cancels and shortenings by Aakash / Varun / the person, edits, overrides, closed days added and removed (past, today, future), clash rules on / off, restrictions, late / early requests decided before and after the punch, outings with and without "I'm back" and with corrected times, hand check-in / check-out, undo check-out, keep / excuse / take back absences, incidents, disputes and decisions.
- No reply with code ERROR, no job exception: **held**.
- No day with more than 1 leave in the rows: **held**.
- `myMonth` leave total, bank used / beyond and ladder equal to an independent recount of the rows; nothing negative or NaN: **held**.
- Every live leave violation has its reason and every reason its violation; no violation doubled: **held**, except R15-6.
- Both sync routines at rest at the end of every day (run on a copy of the Sheet, nothing changes): **held**, except on the day of a people change (R15-9) and R15-6.
- Booked late / early / going-out minutes of every person and open-month day equal to an independent recount from punches, outings and the leave of that day: **held**, except R15-2, R15-3 and R15-9 (roster): 33 mismatches in 72 runs; the 23 in the 52 runs classified by cause were 14 x R15-2, 7 x R15-3, 2 x R15-9 (one day). No doubled minutes in any run.
- Locked November: locked report, minute rows, punches, late / early requests, outings, violation rows and November-only leave rows never changed after the lock: **held**. (One flag in seed 29 was my own filter: a leave 30 Nov - 2 Dec shortened to 30 Nov after the lock, which assumption 30 allows.)
- At the end every waiting leave, late / early request, outing and dispute could be closed and the Approvals list was empty: **held**.
- No reminder between 00:00 and 06:00 IST, none to an inactive person, none twice: **held**.

Targeted checks that held: cancel before / after check-in on the same day (both informed); shortening on the day before (ordinary day); own cancel (ordinary day); an edit by Aakash that moves the leave away on that day (informed) and on an earlier day (ordinary); person edited twice in one day and inactive-then-active (history keeps one entry per day, days in between are not marked absent); pending half day approved after arrival (row cut and "[was N]" kept, restored on cancel).

## Not reproduced (read in the code, not counted)

- N1. `markAbsent` inside `lockMonth` records a violation the person can never dispute (the month is locked in the same tap). See Q2.
- N2. `decideShort`: after an undone check-out the early request counts as "happened" (voided row with its `shortId`), so approving it skips the clash check.
- N3. A back-dated `joinedOn` cannot be entered through the app (not in `PERSON_FIELDS`); only by hand in the Sheet. Not tested.
- N4. `src/gas/main.js` cannot run here; read only.

## Questions for the owner (not counted)

- Q1. (R15-1) A leave day on which the person came to work and that Aakash gives back on a later day: is the lateness of that day informed (my reading of 49 / 57 / 62) or an ordinary not-informed lateness (literal reading of 66)?
- Q2. An absence found by the month lock itself (missed night job) gets a violation that cannot be disputed. Wait 24 hours, or allow the dispute after the lock?
- Q3. (R15-7) Leaving early without telling on a day whose leave was taken back that day: informed or not?
- Assumptions marked TO CONFIRM / OPEN (16, 18, 19, 23, 28, 47, 52, 63) were not counted.
