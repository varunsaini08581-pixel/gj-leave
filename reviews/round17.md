# GJ Leave & Attendance - Review round 17: the rewritten minute engine (deriveDay / recountDay / knownByLeave)

Reviewer: independent (did not write the code). Date: 20 Nov 2026.
Code reviewed: `/home/claude/gj-leave`, commit aef799d as stated by the author (server version 9, schema 4).
Reproducers: `/home/claude/findings/repro-round17.test.js` - 15 tests for 11 findings, **all 15 fail on the current code**, each at the assertion named in its title, none in its set-up (`node --test /home/claude/findings/repro-round17.test.js`).

**The code did not change during the review.** SHA-256 of all 25 files under `src/` and `docs/`, taken at the start and at the end: identical (hash of the list `d4be1fface426472...`; lists kept as `round17-hashes-start.txt` / `round17-hashes-end.txt`).
I did not run git, did not use the network, changed nothing inside `/home/claude/gj-leave`. Written in `/home/claude/findings/`: `round17.md`, `repro-round17.test.js`, `round17-notes.md`, `sim-round17.js`, `round17-harness.js`, the two hash lists. Scratch in `/tmp/r17`.
`deriveDay` is not exported by `attendance.js`; my harness adds it to the exports in memory when the file is loaded (the file on disk is untouched). The reproducers do not need this: they use the public API only.

The project's own suite (`cd /home/claude/gj-leave && node --test`): **426 tests, 425 pass, 0 fail, 1 skipped.**

## Counts

| Severity | Count | Findings |
|---|---|---|
| Critical | **0** | |
| High | **0** | |
| Medium | **7** | R17-1, R17-2, R17-3, R17-5, R17-8, R17-9, R17-11 |
| Low | **4** | R17-4, R17-6, R17-7, R17-10 |

Calibration, plainly:
- **I found nothing High.** In ordinary use (no entry made and corrected, no Settings change, every request decided) the rewritten engine held: 96 random runs with every fact checked after every step, and the battery of old rules, gave no wrong count.
- Closest to High are R17-11 (a waiting request nobody can ever close; not High because it needs a leave across the month end that is edited after the lock, and it changes no count) and R17-2 (not High because Aakash himself approves the request; what he is not shown is that she had already left).
- R17-1 is a regression of the rewrite (round 7 had verified the opposite). R17-9 and R17-11 were found by the random runs, the rest by reading and targeted probes.
- A staff member ALONE can no longer turn uninformed time into informed time (focus point 4). Every remaining way needs a tap by Aakash or Varun (R17-2, R17-3, R17-4).

## Findings

### R17-1 (Medium, regression) - a change of duty hours re-judges days that are already gone, and today's arrival
- **Where**: `src/server/attendance.js:deriveDay` / `expectedDay` (read `person.dutyStart` / `dutyEnd` as they are now, for every date); `src/server/admin.js:savePerson` (`changed` covers roster, active and "records only" only: no history and no recount for duty times).
- **What happens**: before the rewrite the minutes were stored at the tap, and round 7 recorded "a changed duty time does NOT re-judge old days". Now every later count of a day (check-out, a forgotten check-out entered by Aakash, "back" confirmed the next day, a late request decided later, a leave or closed-day change) works the day out again against the NEW hours. Until that count happens the rows and `deriveDay` disagree.
- **Steps (a)**: Neha (09:30-18:30) checks in 09:30. 14:00 Varun sets her hours to 08:30-17:30. 18:30 she checks out: 60 min late, not informed, 1 violation.
- **Steps (b)**: 19 Nov she works 09:30-18:30 and forgets to check out. 20 Nov 09:00 Varun sets 10:30-19:30. 09:10 Aakash enters the check-out of the 19th (18:30): 60 min "left early", not informed, 1 violation on the 19th.
- **Why it matters**: a violation and bank minutes for a day worked in full, caused by a Settings change (winter timings, a changed shift). Random runs with duty changes: 2 of 7 runs had mismatches, hundreds of step-checks each.
- **Why not High**: needs a Settings change (the rubric's Medium), which is rare.
- **Fix**: keep duty times in `People.history` like the roster (`Cal.asOn(person, date).dutyStart`), and count today again in `savePerson`; or let a duty-time change apply from tomorrow.
- **Reproducers**: `R17-1a`, `R17-1b`.

### R17-2 (Medium) - an early-leaving request sent AFTER she has left becomes "informed" when Aakash approves it
- **Where**: `attendance.js:requestShort` (for `early` the only time test is `nowMin > t`; no test for an existing check-out; no `recountDay`), `deriveDay` (no "sent before leaving" test for `early`; for `late` there is `inTime`).
- **Steps**: Neha checks out 17:00 (90 min early, told nobody: violation). 17:05 she sends "I will leave early at 17:05". The request is accepted as Pending; the rows are not counted again (rows: one piece of 90; `deriveDay`: 85 waiting + 5). Aakash's card shows name, kind, date and time, not that she is already checked out. He approves: 85 min informed, 5 not informed, the violation is withdrawn.
- **Why it matters**: the owner's rule is that time away is informed when it was told BEFORE. For late arrivals the code enforces it; for leaving it does not. It also works to replace an approved request after leaving before its time.
- **Why not High**: Aakash approves it himself; a staff member cannot do it alone.
- **Fix**: refuse an `early` request for today once a check-out exists (as `cancelShort` already tests), or in `deriveDay` count an early request only when `submittedAt < pout.at`; call `recountDay` in `requestShort` when a punch exists.
- **Reproducer**: `R17-2`.

### R17-3 (Medium) - knownByLeave does not ask whether the leave was GRANTED before the arrival
- **Where**: `attendance.js:knownByLeave` (`if (a !== 'edited' && !(r.submittedAt < at)) return false;`).
- **What happens**: assumption 72 (a) says the leave "existed before the arrival". The code tests the time the request was SENT, and for the `edited` branch tests no time at all.
- **Steps (a)**: 08:00 Neha asks leave for today (waiting). 11:00 she comes in, 90 min late (violation). 12:00 Aakash approves the leave, 12:30 he cancels it ("she is here"): 90 min informed, 0 violations.
- **Steps (b)**: she comes in 90 min late (violation). Aakash enters a leave for her for today by mistake and approves it, then moves it to tomorrow with Edit: 90 min informed, the "not informed" violation is gone. The same leave cancelled instead of moved: not informed, violation stays.
- **Why it matters**: lateness nobody approved ends as informed after two manager taps; and the same correction gives two results depending on the button.
- **Fix**: keep the grant time on the row (or read the `approved` / `override` / auto history entry) and require it `< at` in every branch, including `edited`.
- **Reproducers**: `R17-3a`, `R17-3b`.

### R17-5 (Medium) - a waiting early request cuts one leaving into two "not informed" pieces, each judged alone
- **Where**: `attendance.js:deriveDay` (the `else if (e)` branch also runs while the request is Pending); `views.js:lockMonth` (works out the results before it closes waiting requests).
- **Steps (a)**: waiting request for 17:55, she leaves 17:20 (duty end 18:30): pieces 35 + 35, **2** violations and 2 "Violation recorded" alerts. With no request at all: 1.
- **Steps (b)**: waiting request for 18:05, she leaves 17:40: pieces 25 + 25, **0** violations and 2 passes. With no request at all: 1 violation.
- **Why it matters**: assumption 12 says a waiting request is "not informed for now"; then the whole leaving is one not-informed time. Case (a) shows her at "bonus lost" until Aakash decides. If nobody decides before the lock, the wrong count is frozen in the month report.
- **Why not High**: it corrects itself when Aakash decides the request.
- **Fix**: while the request is Pending, one piece (not informed, `shortId` set); split only when it is Approved.
- **Reproducers**: `R17-5a`, `R17-5b`.

### R17-8 (Medium) - when the early pieces of a day change shape, violations and disputes do not follow
- **Where**: `attendance.js:recountDay` (late / early rows "reused in order"), `syncViolations` (proof `dm:<rowId>:...`).
- **Steps**: waiting request for 18:10, she leaves 17:20. Row A = 20 min (waiting piece), row B = 50 min with the violation. She disputes it.
  - a. Varun REMOVES the violation. Aakash then rejects the request: row A becomes 70 min, row B 0, and a NEW violation is recorded on row A for the same leaving.
  - b. The dispute is still open when Aakash rejects: the violation on row B is withdrawn with her dispute, the new one on row A has none; Varun's dispute list is empty.
- **Why it matters**: assumption 51: a violation Varun removed is never recorded again. In (b) she must dispute again and Varun never sees the first one.
- **What held**: a row that goes to 0 and comes back (closed day, override entered and cancelled, undo check-out) keeps "removed by Varun" and brings an open dispute back.
- **Fix**: goes away with the R17-5 fix for this case; in general carry the dispute / removal over when the not-informed part of a day moves to another row (key the proof on day + kind + "not informed part" instead of the row).
- **Reproducers**: `R17-8a`, `R17-8b`.

### R17-9 (Medium, found by the random runs) - an edit of a shortened leave makes the day she came back "not informed"
- **Where**: `admin.js:editLeave` (`submittedAt: ctx.now`; counts only old and new dates again) against `knownByLeave` (`r.submittedAt < at`).
- **Steps**: leave 18-20 Nov. 20 Nov she is back at 11:00 (forgets to check out); Aakash taps "End this leave": 90 min informed, no violation. 21 Nov Aakash corrects the leave entry (Edit, same dates). The 20th is not counted again, so rows (informed) and `deriveDay` (not informed) disagree. Then he enters her forgotten check-out for the 20th: the day is counted, 90 min not informed, 1 violation.
- **Why it matters**: the R15-1 case (violation for coming back early from approved leave) comes back after an edit. Seen in 2 of 96 random runs (seeds 21, 25).
- **Fix**: do not reset `submittedAt` in `editLeave` (use a separate `editedAt`), or let `knownByLeave` read the first history entry.
- **Reproducer**: `R17-9`.

### R17-11 (Medium, found by the random runs) - a waiting request nobody can ever close
- **Where**: `admin.js:editLeave` (dropped days must be in an open month; the days that stay may be locked; an approved leave goes back to "Pending with Aakash"); `core.js:decideLeave`, `cancelLeave` and `editLeave` again (all refuse when every day is locked); `jobs.js:reminders` (no lock test for leave requests).
- **Steps**: leave 30 Nov - 1 Dec, approved. November is locked on 1 Dec. 4 Dec Aakash edits the leave down to 30 Nov (she was back on the 1st). Result: "Pending with Aakash" with only a locked day. Approve, reject, cancel and edit all answer "This month is locked". It stays in Approvals (still there in January in my probe) and reminds Aakash every 2 hours.
- **Why it matters**: assumption 60 says nothing of a locked month can wait or remind for ever. Only a hand edit in the Sheet ends it. No count is wrong (November keeps its locked result, 1 Dec is given back).
- **Why not High**: needs a leave across the month end edited after the lock; "End this leave" in the same situation works.
- **Fix**: in `editLeave`, when every remaining day is locked, refuse ("use End this leave") or keep the status Approved; and let `cancelLeave` close a waiting request whatever its dates.
- **Reproducer**: `R17-11`.

### R17-4 (Low) - a cancelled half day makes ALL the lateness informed, also the part after it
- **Where**: `attendance.js:knownByLeave` (`covers` = the half day touches the time away), `deriveDay` (one late row).
- **Steps**: approved morning half day 09:30-14:00; she comes 15:00 (60 min not informed, violation). Aakash cancels the half day (wrong day): 330 min informed, automatic full day, no violation.
- **Fix**: informed minutes = the overlap with the half-day window; the rest stays not informed (as for a stated time).
- **Reproducer**: `R17-4`.

### R17-6 (Low) - an outing before duty start is taken from the bank
- **Where**: `attendance.js:outingMinutes` (cuts at duty end only).
- **Steps**: Vikas (duty from 11:00) checks in 10:20, goes out 10:30-10:55: 25 min from his bank. Assumption 46: only minutes inside duty hours count.
- **Fix**: start at `max(approvedAt, duty start)`.
- **Reproducer**: `R17-6`.

### R17-7 (Low) - excuseAbsence (and an absence taken back) does not count the day again
- **Where**: `attendance.js:excuseAbsence`, `core.js:cancelLeave` (system branch): no `recountDay`.
- **Steps**: marked absent at 21:00; she taps check-in at 21:30 (540 min late, a second violation for the same day); Aakash excuses the absence: the day is an approved full-day leave, but the 540 minutes and the "not informed" violation stay. Mirror case: Muskan (records only), absence "Recorded", night check-in, absence taken back: the day is a working day with no minutes booked.
- **Why Low**: needs a check-in after the evening job.
- **Fix**: call `recountDay` for the day in both places.
- **Reproducer**: `R17-7`.

### R17-10 (Low) - a closed day entered later does not clear the manager's minutes and violation
- **Where**: `admin.js:setSetting` (`if (p.role !== 'staff') return;`).
- **Steps**: Aakash checks in 60 min late (violation, as for anyone). Varun enters the day as shop-closed: Pooja's violation of that day is withdrawn, Aakash's row and violation stay.
- **Fix**: run the recount for everyone who has a punch or a minute row on the changed day.
- **Reproducer**: `R17-10`.

## The five attack points

1. **A fact changed without recountDay**: found in `savePerson` duty times (R17-1), `requestShort` after the check-out (R17-2), `editLeave` for days outside the old and new dates (R17-9), `excuseAbsence` and absence taken back (R17-7), `setSetting` for non-staff (R17-10). Checked and consistent: `cancelShort` (only possible before the punch), `decideShort` approve and reject, a late request closed by the lock (month frozen), `decideOuting`, an outing open at check-out (check-out refused) and at day end (no minutes until closed), `remindBack`, `keepAbsent`, half days approved late, roster / "records only" / active changes, rule changes, closed days added and removed, end-of-day absent then manual check-in, undo check-out then new check-out, edits that keep or move the dates, overrides, cancel and shorten.
2. **Row reuse**: R17-8. Otherwise held (see "What held" under R17-8).
3. **Old behaviours**: all hold (10 / 11 min grace; late request before duty start and approved; pending = not informed, decided later corrects in both directions; a late request after duty start is refused; stated 30 / actual 75; left before the stated time; outing 15 free, 16 counts 16; 120 / 121 and 270 / 271 minutes; violation at 31 not-informed minutes; bank 120 and "beyond"; 5th and 7th not-informed time; manual check-in for a past day; nothing on a full-leave day, roster Sunday off, closed day; locked month frozen).
4. **knownByLeave**: staff alone: no way found. Own cancel, take-back before the day, a request never granted and cancelled by Aakash (`decidedAt` empty, also after a staff edit), an override entered after the arrival and cancelled: all "not informed", correct. Gaps: R17-3, R17-4, R17-9.
5. **Random runs**: below.

## Random simulation

`/home/claude/findings/sim-round17.js` (seeded). Each run: 9 staff + Aakash + Varun, 43 shop days (2 Nov - 14 Dec 2026), about 1,900 API calls and job runs through `Api.handle` on the fake Sheet with the read cache. Hourly job 11 times a day (also 00:30, 03:00, 05:59), evening job, end-of-day job (12% skipped, 20% twice, 5% also at 07:00); November locked on a random day 1-5 Dec; leaves (full, half at start / middle / end, entered by Aakash, called-emergency), decisions, cancels and shortenings by the person / Aakash / Varun, edits that keep or move dates, overrides, closed days added and removed, clash rules on / off, restrictions, "records only" / roster / active changes, pay changes, late and early requests decided before the punch, after it, the next day or never, outings with and without "I'm back" and corrected times, manual check-in and check-out, undo check-out, keep / excuse / take back absences, incidents, disputes.

After EVERY step: DayMinutes rows of today and the two days before (and the days the step named) equal `deriveDay`. At every day end: all days of the open months, both sync routines run on a copy and change nothing, `myMonth` bank numbers and ladder against my own recount, no day above 1 leave, no doubled violation, no live violation on a dead row, nothing negative / NaN, locked November unchanged. At the end: no reminder 00:00-06:00 or doubled, every waiting item closed and the Approvals list empty.

| Runs | Steps | Result |
|---|---|---|
| 96 baseline (seeds 1-96) | 182,091 | 93 clean. Seeds 21, 25: R17-9. Seed 90: R17-11. No ERROR reply, no job exception, no other failed check |
| 7 with duty-time changes (seeds 101-107) | about 13,400 | 2 runs with row / deriveDay mismatches: R17-1 |
| 7 with requests after check-out, night check-ins, Aakash checking in (seeds 201-207) | about 13,400 | all 7 with mismatches of the classes R17-2, R17-7, R17-10 |

Limits: seeds 1-48 ran before I added the mismatch classifier and the exact lock snapshot; one flag there (seed 47, "locked month changed") was my own filter (a leave 30 Nov - 2 Dec shortened to 30 Nov after the lock, which assumption 30 allows). The reminder check does not test "to an inactive person" by date; I read that in `reminders()` only. E-mail job not run. In the two flag sets the mismatches were not classified one by one.

## Round 15 fixes: do they hold?

The 13 reproducers of round 15 (`repro-round15.test.js`) run against this commit: 13 pass.

| Round 15 fix | Result |
|---|---|
| R15-1 take-back on a later day | holds; undone by a later edit of the row: R17-9 |
| R15-2 approve while minutes are set aside | holds (no "[was N]" any more) |
| R15-3 missing time booked | holds |
| R15-4 one-day leave rejected by a rule change | holds |
| R15-5 afternoon half day / morning lateness | holds; partial overlap: R17-4 |
| R15-6 "records only" by the day in markAbsent | holds |
| R15-7 early leaving, same result in both orders | holds (informed in both; see Q2) |
| R15-8 stated time kept | holds |
| R15-9 Settings change counts today | holds for roster / active / "records only"; duty times: R17-1 |

## Not reproduced / not counted

- N1. A self check-in tapped late (forgot in the morning, taps at 18:20): 530 min late, full day and violation, and Aakash cannot enter the real time ("Already checked in today"). Known since round 8 ("a wrong check-in time cannot be corrected by anyone"); not counted again.
- N2. Corrected "back" time later than the person's check-out counts the same minutes as outing and as early leaving. Read in the code, not tested.
- N3. A "beyond passes" / "extra 2 hours" violation Varun removed can be recorded on another row when earlier days of the month change. Tried one sequence (closed day added and removed): it stayed removed. Not reproduced.
- N4. `src/gas/main.js` cannot run here; read only. Phone UI not tested this round.

## Questions for the owner (not counted)

- Q1. (R17-2) Aakash approves an early-leaving request that was sent after the person had already left: informed or not?
- Q2. On a day whose leave was taken back by Aakash, leaving early without telling counts as informed (assumption 72 b, "covered those hours"). Meant so?
- Q3. A free outing (15 min or less) still counts toward "more than 2 hours away": late 110 min (approved) + outing 15 min = 125 = half day. Meant so?
- Q4. A change of duty hours: from today or from tomorrow?
- Assumptions marked TO CONFIRM / OPEN (12, 16, 18, 19, 23, 28, 47, 52, 63, 72) were not counted.
