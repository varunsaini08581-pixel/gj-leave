# Round 9 - independent re-review of the round 4-8 fixes

Reviewed: `/home/claude/gj-leave` as it stood on 20 Nov 2026 (suite: 293 tests, all pass). No file under the project changed during the review (checksums of `src`, `docs`, `test`, `tools`, `PROGRESS.md` taken at the start and compared at the end).

Reproducers: `/home/claude/findings/repro-round9.test.js` (16 tests, all FAIL on the current code, each for the reason stated here; run `node --test /home/claude/findings/repro-round9.test.js`). R9-13 drives the phone app with python3 + Playwright on 127.0.0.1 and is skipped when they are missing.

## Result

| Severity | Count |
|---|---|
| Critical | 0 |
| High | 1 |
| Medium | 7 |
| Low | 5 |

The rule engine and the store hold up. Every finding is about what happens when something is changed AFTERWARDS (edit, cancel, lock, rule or closed-day change). The one High is a regression of the round 4 fix "an edit keeps the violations of the old version until the new one is decided".

## What was checked

1. **Reproducer copies.** `test/round4`, `round6`, `round7`, `round8`, `sim-round8` and `tools/ui-round5.py` differ from the originals only in the require / docs path. No assertion was weakened. The originals of rounds 1-8 run against the current code: 165 of 166 pass; `repro-round5.py` passes 23 of 23.
2. **Older tests the author changed.**
   - `round2.test.js` F1b: the assertion right after the edit was replaced by "still Unannounced, still pending, violation there after the approval". Justified (handoff Part 6, assumption 36). The original assertion also still passes. The comment in the copy ("the old violation is withdrawn with the old version") is out of date.
   - `round3.test.js` F12: a `startDate` row was added. This is the one original that fails today: without `startDate` the 08:00 run now marks the 3 days before. Justified by assumption 31 for a Sheet made by `setupOrUpgrade`. See note N2.
   - `admin.test.js` (edit goes back to Aakash; the old violation stands while waiting), `server.test.js` (restricted-period leave goes to Aakash), `jobs.test.js` (`startDate`), `store-api.test.js` (check-in without a photo answers UPDATE): each follows the handoff or a logged assumption.
3. **Random sequences.** 70 seeded runs, each 41 shop days (2 Nov - 12 Dec, with the November lock) and about 1,800 calls through `Api.handle` on the fake Sheet with the read cache, plus the three jobs every day. About 125,000 calls: leave submit / edit / cancel / decide, late / early, going out, hand check-in and check-out (also back-dated), take-backs, excuses, incidents, disputes, overrides, closed days, restrictions, roster changes, rules switched off and on. Checked every evening:
   - one day never more than 1 leave: **broken** (R9-7, R9-8)
   - no two granted leaves of one person overlap: held
   - live violations have a reason that still exists: **broken** for a leave on a closed day (R9-12); minute violations always equal a fresh recount
   - a locked month never changes: **broken** through an edit with unchanged dates (R9-2b)
   - `myMonth` leaves, days cut, bank, violations and rupees equal an independent recount from the rows: held in all runs
   - no reply to a staff phone carries a salary figure, a pay key, or another person's reason / note: held
   - no reply with code ERROR, no alert stored twice
   The other findings are sequences too rare for the random runs; they come from reading the changed code.

## Findings

### R9-1 (High) - the 3rd emergency loses its violation when it is edited and approved again
`core.js` `decideLeave.finish` + `renumberEmergencies`. Raunak's 3rd emergency of the month is approved (violation + day cut). Before it starts he taps Edit and changes only the reason; Aakash approves again. `finish` withdraws every violation of the request with the note "Request decided again after an edit"; `renumberEmergencies` then sees a withdrawn row whose note it does not know (`mine` only matches "No longer the 3rd…", and `all.length` is not 0) and records nothing. Result: `penaltyEmergency` true, day still cut, **0 violations**. Any edit of a 3rd+ emergency clears its violation. "Unannounced" and "restricted period" come back because `onGranted` adds them directly; only this rule is lost.

### R9-2 (Medium) - requests that can never be closed after a month lock
- **a.** Round 8 closes undecided requests with the lock only when ALL their dates are in the month (`views.js` `lockMonth`). A request for 30 Nov - 1 Dec that nobody decided stays "Pending with Aakash" for ever: approve, reject, cancel (Aakash or Varun) and a date edit all answer "This month is locked". Aakash is reminded every 2 hours without end, and 1 Dec stays "not decided" on the page. Locking December does not close it either.
- **b.** `admin.js` `editLeave` lets a request keep days of a locked month (`had`). An edit that changes no date therefore passes on a leave wholly inside a locked month and sets it to pending. On the phone this is reachable for Aakash's own leave (Apply > My requests > Edit > Save): his approved November leave becomes "Pending with Varun" and Varun gets "This month is locked". For staff leaves it needs a direct API call by Aakash or Varun (no screen).

### R9-3 (Medium) - a rule switched on later turns leave days already taken into absences with violations
`admin.js` `recheckClashes` checks only days from today on, but then rejects the WHOLE request. Pooja's approved leave 19-20 Nov; on 20 Nov Varun switches the Calls rule on. Her leave becomes "Rejected – clash" including 19 Nov, and the evening job (3-day catch-up) records 19 Nov and 20 Nov as "Absent – unannounced" with a violation each. Contradicts assumptions 39 and 43.

### R9-4 (Medium) - a closed day entered on the wrong date cannot be undone
`admin.js` `setSetting`. Entering a closed day for a past date sets every minute row of that day to 0, withdraws the violations and cancels the absences. Removing the date again restores nothing: the minutes stay 0, the withdrawn violations stay withdrawn, and the cancelled absence rows stop the evening job from marking the day again. No screen can put it back. One wrong tap by Varun wipes a day for the whole shop.

### R9-5 (Medium) - leave cancelled after the person came in late: the lateness is never counted
`core.js` `cancelLeave` + `attendance.js` `recountDay`. On a leave day a check-in writes no late minutes. When Aakash then cancels the leave ("Staff leaves"), the day is given back, but `recountDay` can only lower minutes, never add them. Raunak arrives 3 hours late, the leave is cancelled: 0 leave, 0 bank minutes (should be an automatic half day). The same happens when a running leave is ended on the day the person returned.

### R9-6 (Medium) - a violation Varun removed after a dispute comes back
Round 8 (assumption 51) fixed this for minute rules and renumbering only. `onGranted` records "unannounced leave" and "leave in a restricted period" afresh on every approval. Flow on the person's own phone: restricted-period violation, dispute, Varun removes it, the person edits the reason, Aakash approves: the violation is recorded again (R9-6b). Same for an unannounced leave corrected by Aakash (R9-6, API only).

### R9-7 (Medium) - going-out minutes count on a leave day and on a roster Sunday off
`attendance.js` `imBack` / `confirmBack`. Late and early minutes are skipped on a full-leave day and on the person's roster Sunday; outing minutes are not.
- **a.** On approved leave, came in to help, out for 2 h 10 min: the day counts **1.5 leaves** (1 + automatic half day).
- **b.** On his roster Sunday off, came in to help, out 40 min: 40 min taken from the 2-hour bank.

### R9-10 (Medium) - after "Keep as absent" the absence can no longer be excused from the phone
`api.js` `approvals` lists only absences with `decidedBy === 'system'`; `staffLeaves` leaves system rows out. Once Aakash taps "Keep as absent", no reply to Aakash or Varun contains that absence, so "Humanitarian – excused" (handoff 3.4) cannot be tapped when the medical paper comes the next day. The server action still works. "Take back" stays possible through "Enter a check-in".

### R9-8 (Low) - check-in after the working half is over counts 1.5 leaves
`attendance.js` `checkIn`. Lateness is not capped at the end of the part the person had to work. Afternoon half-day leave from 15:00, check-in at 15:20: 290 "late" minutes = a full automatic day, plus the 0.5 leave.

### R9-9 (Low) - two absence violations for one day
`attendance.js` `endOfDay`. Half-day leave, no check-in: half absence + violation. Aakash cancels the past half-day leave; the next evening job reads the remaining half absence as "an approved half day" and records a second half absence with a second violation.

### R9-11 (Low) - emergencies are not numbered again when one stops being granted without a cancel
`renumberEmergencies` runs on grant, cancel and closed days only. Three granted emergencies, the 2nd is edited and then rejected: two are granted, but the other one stays "no. 3" with its violation and day cut. `recheckClashes` has the same gap.

### R9-12 (Low) - a leave granted on a day already entered as closed still earns violations
The "only on closed days" check exists in `setSetting` only. A leave approved after the closed day was entered gets "leave in a restricted period" / "unannounced leave" from `onGranted`.

### R9-13 (Low, phone app) - the 30-second refresh empties a form that is being filled in
`docs/app.js` `refresh` / `typing`. The redraw is held back only while the focus is in a non-empty field. After the keyboard is closed (iPhone "Done", a tap beside the field) the next refresh clears Aakash's typed reject reason on Approvals, and on Today the late / early form loses its time and jumps back to "I will be late".

## Earlier findings that are not fully fixed

| Earlier fix | What is left | Here |
|---|---|---|
| R4 "edit cannot park a violation" (assumption 36) | caused the loss of the emergency violation | R9-1 |
| R8-5 "undecided requests are closed with the month lock" | not for a request across the month end | R9-2a |
| R6 "locked month frozen everywhere" / R8-2 | an edit that keeps the dates still changes a locked leave | R9-2b |
| R7 "rule switched on later" (assumption 43) vs R7 "days already taken stay" (39) | the two contradict each other | R9-3 |
| R4 / R7 "closed day entered later" | cannot be undone; not applied to a leave granted afterwards | R9-4, R9-12 |
| R4 "leave granted after arrival re-counts the day" (33) | the reverse direction (leave cancelled after arrival) is missing | R9-5 |
| R8-4 "a violation removed after a dispute never comes back" (51) | still comes back through edit + approval | R9-6 |
| R7 "emergencies renumbered" (45) | only on cancel and grant | R9-11 |
| R5 "Today and Approvals refresh every 30 s" | clears typed input | R9-13 |

## Not reproduced (read in the code, no failing test)

- N1. The C1-E lock on Bhawna and Pooja is keyed on the `extremeEmergency` flag the phone sends. A Sales leave sent with the flag although it was not needed would still arm the lock on a day a second Sales person is merely late.
- N2. Go-live: `startDate` is the day `setupOrUpgrade` first ran. If the timers are installed days later, the first evening job marks up to 3 earlier days absent for people typed into the Sheet (they have no `joinedOn`). `startDate` can be set through `setSetting`, but no screen offers it. An upgraded Sheet without `startDate` gets the same.
- N3. "Cancel this past leave" for a day with no check-in: inside 3 days the evening job records an absence + violation; older than 3 days the day is neither leave nor absence.
- N4. Shortening a leave across a locked month end is refused when the person checked in on one of its locked-month days.
- N5. `sendEmails`: if the write of the marks fails after the mail went out, the digest is sent again on the next run.
- N6. `src/gas/main.js` cannot run here; `readRow`, sparse `writeRow` and `setup` with `today` were read, not executed.

## Open questions, not bugs
Assumptions marked TO CONFIRM (16, 18, 19, 23, 28, 47) and 52 were not counted.
