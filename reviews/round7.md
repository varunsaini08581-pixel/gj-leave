# GJ Leave & Attendance - review round 7: EDGE CASES

Independent review. I did not write this code. Nothing under `/home/claude/gj-leave` was changed, git was not run, no network, no deployed server.
Reproducers: `/home/claude/findings/repro-round7.test.js` (30 tests, all FAIL on the current code, each for the reason stated here; run with `node --test /home/claude/findings/repro-round7.test.js`). They drive `Api.handle` on the Sheet store over a fake grid, the way `doPost` does.
Baseline: the existing suite without `test/store-api.test.js` passes 219 of 219. I did not run `store-api.test.js` because it runs `tools/build.js`, which rewrites generated files in the repo.

## Counts

| Severity | Count |
|---|---|
| Critical | 0 |
| High | 2 |
| Medium | 8 |
| Low | 12 |

Plain answer: the rule engine itself holds up. Every minute threshold, the month / year rollover, the 5-Sunday month, Anita, the ladder, the dispute window, the grace table across a quarter, the money working and the privacy of every reply came out right in both directions (list in "What held"). No way was found for a staff member to gain anything or see anything they should not. What does not hold up is what happens AROUND the rules when something is changed afterwards: a person's roster edited mid-month, a leave shortened or cancelled after it began, a closed day or a clash rule entered later, an approval given late. That is where all 2 High and most of the Medium findings are.

---

## High

### H1. A change to a person in Settings is applied to days that have already gone by
- **Where**: `jobs.js endOfDay` (line 116: every night it re-checks the 3 days before today) + `attendance.js endOfDay` (line 642) and `liveMonth` (line 547) + `calendar.js isRosterOff`: all of them read the person as they are NOW (`sundayOff`, `active`, `role`). `People` keeps no history; only `joinedOn` protects a new person.
- **What happens (reproduced)**:
  - **H1a**: Neha is off on the 3rd Sunday (20 Dec). On Monday the owner changes her roster to 1st and 2nd Sunday. Monday's 21:00 job looks back, sees "Sunday 20 Dec, working day, no check-in, no leave" and records **Absent - unannounced + 1 violation** for a day she was rightly off. Any roster edit within 3 days after an affected Sunday does this.
  - **H1b**: Vikas had the 1st and 2nd Sunday off (6 and 13 Dec). On 15 Dec his roster is changed. His month page drops from 2 leaves used to 0: the two Sundays he really had off are no longer counted anywhere.
  - **H1d**: the other way round. Harsh had no Sunday off and worked 6 and 13 Dec (check-ins exist). On 15 Dec he is given "1st and 2nd". His page now says 2 of his 5 are used. A later leave is then "above the 5" (goes to Aakash, a day "would be deducted") for Sundays he worked.
  - **H1c**: a person set inactive on 1 Dec and active again on 10 Dec is marked absent for 7, 8 and 9 Dec with 3 violations (= notice stage) that same night.
- **Why High**: wrong absence, wrong violation, wrong leave count and wrong money estimate for staff, silently, from an ordinary owner action in Settings (handoff 3.1: "All of this is editable in Settings"). Unusual, but a Sunday swap or a roster change is realistic, and nothing warns the owner.
- **Duty time, for the record**: a changed duty time does NOT re-judge old days. Late / early minutes are stored as minutes at the moment of the tap. Two small exceptions: a leave granted later for an old day re-counts that day against the new times (it can only lower minutes), and "has this leave started" (cancel / edit) uses the new start.
- **Fix idea**: give roster and active an effective date (or store the roster of each month on first use), and let the look-back skip any day on which the person was off or inactive under the settings in force that day. At the very least: after a roster / active change, do not look back before the change.
- **Reproducers**: `H1a`, `H1b`, `H1d`, `H1c`.

### H2. A late request sent in time cannot be approved after the arrival if the pool partner was away at all that day: it stays "not informed" (violation over 30 min)
- **Where**: `attendance.js decideShort` line 127: `if (approve) checkClashToday(...)`. The clash check counts every `DayMinutes` row of the partner (`core.js approvedAway`, line 215).
- **What happens (reproduced)**: Bhawna (duty 09:30) sends "late till 10:10" at 08:00. Aakash has not opened the app yet. She arrives at 10:10. Pooja arrives at 10:12, 12 minutes late, nobody told. At 11:00 Aakash taps Approve: "Not allowed: Pooja is off on 9 Dec - Calls needs 1 of Bhawna, Pooja present." He can only reject. Bhawna keeps "Not informed, more than 30 min: violation" although she informed 90 minutes before duty start and Aakash agrees.
- **Why High**: a false violation. The path "Aakash decides after the person arrived: approved = informed" is the owner's own (provisional) rule, assumption 12. It needs a slow approval plus any away entry of a partner that day (11 minutes late, a 5-minute outing, leaving early). With pairs (Bhawna / Pooja, Raunak / Manish) and with Muskan in the repair pool this will meet sooner or later. Under 30 minutes it costs a not-informed pass instead of a violation.
- **Fix idea**: when the minutes of that request have already happened (a `DayMinutes` row carries its `shortId`), the clash check has nothing left to prevent: skip it and only set informed. Keep the check for approvals before the time.
- **Reproducer**: `H2`.

---

## Medium

### M1. Cancelling a leave after it has started wipes the days already taken; the night job then turns them into "Absent - unannounced" with a violation each
- **Where**: `core.js cancelLeave` (line 537) sets the whole request to Cancelled. `jobs.js endOfDay` then finds "no leave, no check-in" on the days of the last 3 days.
- **Reproduced**: (a) Neha, approved 8-9 Dec, comes back on the 9th; Aakash cancels with a reason. That night: 8 Dec = Absent - unannounced + 1 violation. (b) Manish, approved 5-day special leave 7-11 Dec, back on the 11th, cancelled that morning: 8, 9, 10 Dec become 3 absences with **3 violations (notice stage)**, and 7 Dec (older than the 3-day look-back) is not counted at all.
- **Why not High**: the handoff gives this action to Aakash and Varun (Part 5), but the phone app has no button for it today (`cancelLeave` is only on the person's own list). It can only happen through the API until that screen exists. The day the screen is built this is High.
- **Fix idea**: a cancel after the start ends the leave from today: keep the days already gone as granted (shorten `dates`), cancel only the rest.
- **Reproducers**: `M1a`, `M1b`.

### M2. An edit that keeps the first day still measures the notice again from the moment of the edit
- **Where**: `admin.js editLeave` line 131-132: `keep` exists only for a "called" entry edited by Aakash or Varun.
- **Reproduced**: (a) Aakash shortens Neha's started leave 8-9 Dec to 8 Dec on the 9th: type becomes **Unannounced**, and on approval she gets an "Unannounced leave" violation for a leave that was asked a week ahead. (b) Neha herself shortens the same approved leave at 20:00 the evening before: Regular becomes **Emergency** (uses 1 of her 2; as a 3rd it would be a violation and a day cut). Same for fixing a spelling mistake in the reason.
- **Note**: (b) is shown in the live preview before saving, so it is not silent, but there is then no penalty-free way to give a leave day back. Round 4 L9 fixed exactly this for "called" entries by keeping the notice when the first day is unchanged; the same logic is missing for every other request. If the owner wants a shortened leave to count as new notice, (b) is not a bug; (a) is in any case.
- **Reproducers**: `M2a`, `M2b`.

### M3. Notice is measured to the first date of the request even when that date is the person's own roster Sunday (or a closed day)
- **Where**: `core.js evaluate` line 276: `toMs(dates[0], person.dutyStart)`.
- **Reproduced**: Neha, Saturday 08:00, asks for Sunday 20 Dec (her roster Sunday) + Monday 21 Dec: **Emergency**, goes to Aakash, uses an emergency. Asking for Monday alone at the same minute: Regular, auto-approved (49.5 h). Sent on Sunday 08:00 the same two dates would be **Unannounced** (+1 violation) instead of Emergency. The roster Sunday is already ignored for the day count, the run and the clash rules; only the notice anchor forgets it. The same date also decides "has it started" (she can no longer cancel Monday's leave on Sunday noon) and the date of any violation.
- **Why Medium, not High**: the form shows the result before sending and leaving the Sunday out avoids it. A person who picks "Sunday to Monday" will not know why.
- **Reproducer**: `M3`.

### M4. A closed day entered later re-counts leaves and absences, but not that day's attendance or the emergency numbering
- **Where**: `admin.js setSetting` (closedDays) only cancels `route: system` absences; `attendance.js monthMinutes / syncViolations`, `core.js autoDays` and `onGranted` do not know closed days.
- **Reproduced**: (a) the shop is shut at 14:00 and everyone checks out; the owner then enters the day as closed. Neha keeps an automatic half day (0.5 leave) + "not informed, more than 30 min"; Harsh (50 min late that morning) keeps a full day + 2 violations. (b) Neha's 2nd emergency leave was on 8 Dec; 8 Dec is later entered as closed; her next emergency is treated as **no. 3**: violation + 1 day cut, and her page shows "3 of 2".
- **Handoff**: Part 6 "a shop-closed day added after leaves were approved: re-count"; the closed-days screen promises "also when the day is added later".
- **Reproducers**: `M4a`, `M4b`.

### M5. A clash rule switched on, added or tightened later does nothing to leaves that are already approved
- **Where**: `admin.js saveRule` (line 246): saves and logs, no re-check.
- **Reproduced**: C2 off; Bhawna and Pooja are both auto-approved for 15 Dec; C2 on again: both stay Approved, nobody is told. The calendar shows the day only as an ordinary "risk" day.
- **Handoff 3.3**: "If a clash still passes (two approvals at the same instant, **or a rule added later**), the later request is automatically marked Rejected - clash. Both people and Aakash are notified."
- **Reproducer**: `M5`.

### M6. While Aakash is on approved leave (or there is no active manager), requests "pending with Aakash" alert nobody who can act
- **Where**: `core.js submitLeave` and `jobs.js reminders` (line 56) notify `byRole('manager')` only for route `aakash`; same for late / early and going-out requests.
- **Reproduced**: Aakash on approved leave 8-9 Dec. Neha sends an emergency request on the 8th: alert and both 2-hourly reminders go to Aakash only; Varun gets nothing. Varun CAN approve it (the server allows it and his Approvals list shows it), but only if he happens to open the app. With assumption 19 the day then passes as "not decided".
- **Handoff**: Part 6 "Aakash on leave: Varun approves".
- **Also**: Aakash's own late / early and going-out requests are alerted to "managers", that is to himself; Varun, who must decide, is not told.
- **Reproducer**: `M6`.

### M7. Minutes that were set to 0 still make the person "away" for the clash rules
- **Where**: `core.js approvedAway` line 228: every `DayMinutes` row counts, also rows zeroed by `undoCheckOut` or by `recountDay`.
- **Reproduced**: Bhawna taps Check out by mistake at 12:00; Aakash takes it back (the round 5 feature). For the rest of the day Pooja cannot go out, cannot send a late / early request and cannot get a leave for that day: "Not allowed: Bhawna is off on 9 Dec".
- **Reproducer**: `M7`.

### M8. A count-based violation that was withdrawn by a correction never comes back when the correction is re-entered
- **Where**: `attendance.js syncViolations` (line 499): a row with the same proof key that is already "removed" is treated as present (`delete wanted`). "Removed by recalculation" and "removed by Varun after a dispute" share one state.
- **Reproduced**: Neha leaves 5 min early without telling on 5 days: the 5th is a violation. Aakash corrects the check-out time of 2 Dec (take back + enter by hand, both on screen). After that her page still prints "Not-informed time no. 5: violation" on 5 Dec, but the counter, the ladder and the routing say 0 violations.
- **Fix idea**: a separate state for "withdrawn by recalculation", which may be revived; "removed by dispute" stays final.
- **Reproducer**: `M8`.

---

## Low

| No. | What | Where | Reproducer |
|---|---|---|---|
| L1 | No active manager: a more-than-3-days request can never be completed (it waits for the `aakash` half for ever) and, after Varun's yes, it disappears from Varun's own Approvals list. Only an override gets the person the leave. | `core.js` line 508, `api.js approvals` | `L1` |
| L2 | Emergencies are numbered once, when granted. If an earlier one is cancelled afterwards, a later "no. 3" keeps its violation and its day cut although only 2 stand (page: "2 of 2" next to "Emergency beyond 2"). Needs a cancel after the start, so API only today (see M1). | `core.js onGranted` | `L2` |
| L3 | The restriction form sends the ticked NAMES, so "all staff except Anita and Muskan" is frozen on the day it is made: a person who joins later is auto-approved inside the blackout. (An empty tick list is read as "default = everyone".) | `docs/app-admin.js` line 230 + `leave.js checkRestrictions` | `L3` |
| L4 | "Anita: always Aakash" is decided by `group === 'Housekeeping'`. Group is a free-text box: "House keeping" makes her leave auto-approved. | `core.js` line 313 | `L4` |
| L5 | A person made inactive keeps their waiting requests: Aakash is reminded every 2 hours until someone rejects them. Approved future leaves stay on the calendar, an open outing stays open. | `admin.js savePerson`, `jobs.js reminders` | `L5` |
| L6 | A run that shrinks is not looked at again: after the first 2 days are cancelled, the remaining 2-day request still needs Aakash AND Varun. | `core.js decideLeave` | `L6` |
| L7 | An outing is counted until the "I'm back" tap with no limit at duty end: out 18:20, duty ends 18:30, tap at 18:50 = 30 min from the bank. A tap the next morning makes it 15 hours = a full-day leave for a day worked (the person's Today screen no longer shows yesterday's open outing, so in practice Aakash closes it). | `attendance.js imBack` line 382 | `L7` |
| L8 | A going-out request still waiting when the person checks out can be approved afterwards; the outing clock then runs for someone who has gone home. | `attendance.js decideOuting` | `L8` |
| L9 | The working line for a 3rd emergency inside the quota reads "5 leaves - 4 free = 1 day(s) x Rs 567": the amount is what the owner decided, but "4 free" is not true and the person cannot see that it is the emergency rule. | `attendance.js liveMonth` | `L9` |
| L10 | Muskan stays away with no request: the row is "Recorded", so the board says "On leave" and Varun's daily summary lists her under "On leave" (and under "Absent with no request"). | `views.js board`, `jobs.js endOfDay` | `L10` |
| L11 | Owner-only Settings accept wrong types that break things later. (a) `active: 0` on the only owner passes the "one active owner" guard (it tests `=== false`), is stored as "0", read back as false: the owner is locked out. (b) `saveRule` stores `emergencyIfAllPresent` / `rosterSundayException` unchecked; a text value makes every later Sales clash check answer "Something went wrong". (c) `overrideLeave` accepts the same date three times and counts 3 leave days; it also does not check that dates are consecutive or that a half day fits the duty. The phone app sends correct values, so this needs a hand-made request. | `admin.js savePerson, saveRule, overrideLeave` | `L11a`, `L11b`, `L11c` |
| L12 | Wrong-typed arguments that end in the generic "Something went wrong" instead of a refusal (nothing is saved): `dates` as text in `previewLeave / submitLeave / editLeave / overrideLeave`, `effect.date` as a number, `myMonth` for an unknown person (manager / owner), `setPin` for an unknown person. | `core.js evaluate`, `api.js effect`, `attendance.js liveMonth`, `core.js setPin` | `L12` |

---

## What held (attacked in both directions, did not break)

- **Month and year**: leave 31 Dec + 1 Jan counts 1 day in each month's 5 and both months are checked; an emergency across the boundary is an emergency of the first month only; January starts at 0 emergencies, 0 bank, 0 passes; "a violation this month" blocks auto-approval at 23:59 on 30 Nov and no longer at 00:00 on 1 Dec; last-3-months view is right in December and in January; 29 Feb 2027 and `2026-2-3` are refused; a Sat + roster Sunday + Mon request across 28 Feb / 1 Mar is a run of 2.
- **Sundays**: 5th Sunday (29 Nov 2026) is a working day for all but Anita; Anita with 5 Sundays has no free weekday (6th = above quota), with 4 Sundays one weekday is free; both go to Aakash.
- **Runs**: split requests are one run; 3 = Aakash; more than 3 = both; an edit that lengthens a run is re-routed. (Half day and closed day inside a run: see "For the owner".)
- **Overlaps**: a second request on a date is refused while the first is pending, approved, recorded, an override or an automatic absence; allowed after cancelled, rejected and "Rejected - clash". Two half days on one date are refused (edit to a full day). Half day on a roster Sunday or closed day is accepted and uses nothing.
- **Attendance thresholds** through the API: late 10 / 11, not informed 30 / 31, out 15 / 16, away 120 / 121 and 270 / 271, late + outing + early = exactly 120 stays in the bank; check-in twice, check-out twice, check-out during an open outing, check-out after midnight ("Check in first", fixed by Aakash's hand entry) all behave as written.
- **Disputes**: allowed at exactly 24 h, refused at 24 h 01; only once; only the person; only Varun decides; a removed violation leaves the count, the ladder, the hints and the auto-approval rule; a dispute-removed violation is not re-created by the next recalculation.
- **Grace table**: per quarter across 31 Dec / 1 Jan is right (3 in Q4, the January one starts a new quarter, a back-dated 4th in Q4 is a violation).
- **Money**: 5.5 leaves = 0.5 day = Rs 283; no PayInfo = no estimate; Muskan = panel only, 0 violations; rounding as in the handoff examples.
- **Privacy**: 21 staff-side calls on a busy day scanned for other people's reasons, decision notes, incident notes, outing reasons, salary numbers, PIN and token data: nothing. Another person's month page and full photo are refused. The manager is refused on every owner-only action (settings, pay, rules, people, PIN, phones, disputes, override).
- **Inputs**: every argument of every action in `api.js` was sent as null, numbers, NaN, text, wrong dates, lists, objects and 2,000-character text, as staff, manager and owner (about 19,000 calls). Odd values from a staff phone were accepted only on the person's own actions (own request, own check-in, own month, own dispute, previews); no manager or owner action accepted anything from staff. What remains is L11 and L12.
- **Repeats**: decide, cancel, check-in, check-out, going out, I'm back, confirm, dispute, excuse, lock, override sent twice: the second one is refused or is the same record.

---

## For the owner (not counted as bugs; each needs a yes or no)

1. **Assumption 1 (per-day clash also for late / early / going out) has three consequences worth seeing before go-live** (all reproduced):
   - On every 1st to 4th Sunday one of each pair is off by roster, so the one who works can never send "I will be late", never leave early and never go out, not even for 5 minutes: Bhawna / Pooja, Raunak / Manish, Vikas and Harsh on the 3rd / 4th Sunday, Neha on the 1st / 2nd. A late bus on a Sunday is therefore always "not informed".
   - A partner who is 11 minutes late, or goes out for 5 minutes, takes the slot for the whole day. If Aakash then approves a waiting same-day leave of the other person (asked properly the evening before), the app answers "Rejected - clash" by itself, and at 21:00 that person is "Absent - unannounced" with a violation. Only "excused" by Aakash or an override by Varun repairs it.
   - Muskan being 11 minutes late blocks Raunak and Manish from going out that day. A person on approved leave who comes to work anyway still blocks the partner.
2. **Shortening or correcting an approved leave** (M2b): should the notice be counted again from the moment of the change? Today yes.
3. **Runs**: a half day does not join a run (Mon-Tue full, Wed half, Thu-Fri full can all be auto-approved); a closed day between two requests breaks the run; a closed day inside one request counts in its length.
4. **A roster Sunday that the person works** still counts as one of the 5; there is no way to swap a Sunday (and editing the roster for it causes H1).
5. **Not checking out costs nothing** unless Aakash enters the real time: no early minutes are counted for a missing check-out. The alert goes once, the next morning; there is no standing list of unfixed days.
6. **No grace when leaving**: a check-out 1 minute before duty end by the server clock is a not-informed time (uses a pass); arriving 1 minute after the stated late time also. This follows the handoff word for word.
7. **Salary changed mid-month** re-prices the whole open month; locked months keep the old figures.
8. **Month lock on the 1st** cuts the 24-hour dispute window of violations recorded on the last evening (assumption 30).
9. **An incident recorded by mistake inside the grace** cannot be cancelled or disputed and uses up the grace.
10. **A no-leave restriction added later** stops waiting requests but leaves already approved leaves in place (no alert).
11. **A dispute that removes "emergency beyond 2"** removes the violation, not the day cut.
12. **"Called - emergency"** takes only a clock time within the last 24 hours; a call entered more than a day later cannot be dated.

## Spec items with no screen (seen while checking; server side exists)

- **Cancel or edit a staff member's leave by Aakash / Varun** (handoff Part 5 "after that, only Aakash or Varun can cancel, with a reason"): `cancelLeave` and `editLeave` accept it, the phone app offers them only on the person's own list. See M1 and M2 before building it.
- **Editing a clash rule** (handoff 3.3 "a Rules sheet the owner can edit"): the screen can only switch a rule on or off. With assumption 25, when someone in a rule leaves, the rest of that group can take no leave, no late / early and no outing until the rule is edited in the Sheet by hand or switched off completely.

## Not reproduced / not verified here

- Whether the Apps Script timers fire as assumed (`atHour(21)` runs some time between 21:00 and 22:00; the code tolerates that by reading).
- Anything in `docs/` beyond reading the calls it makes (no browser run in this round).
- Concurrency (round 3 theme) was not attacked again.
- `test/store-api.test.js` was not run (it rewrites generated files).
- H1 for a role change (manager to staff) and for a closed day removed again: same code path by reading, not run.

## Summary

Critical 0, High 2, Medium 8, Low 12.

- **H1** Roster / active edited in Settings re-judges past days: last Sunday becomes "Absent + violation", Sundays already taken vanish from (or wrongly enter) the 5.
- **H2** A late request sent in time cannot be approved after arrival when the pool partner was a few minutes late: false "not informed" violation.
- **M1** Cancel after the start erases days already taken; the night job makes them absences with violations (3 violations in the 5-day example). API only today.
- **M2** Shortening a leave re-measures the notice: Regular becomes Emergency or Unannounced.
- **M3** Notice measured to the person's own roster Sunday when it is the first date picked.
- **M4** Closed day entered later: that day's minutes, half days, violations and emergency number are not re-counted.
- **M5** Clash rule switched on / added later: approved clashing leaves stand, nobody told (handoff 3.3).
- **M6** Aakash on leave: nobody who can act is alerted; Varun is never told.
- **M7** Zeroed minutes still block the pool partner.
- **M8** A withdrawn count-based violation never returns; page and counter disagree.
