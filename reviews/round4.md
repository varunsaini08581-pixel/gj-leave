# GJ Leave & Attendance - review round 4: independent re-review of the fixes

Reviewed: every file in `src/rules`, `src/server`, `src/gas/main.js`, `docs/app.js`, `docs/app-admin.js` (read in full), against `spec.txt`, the owner decisions and assumptions 1-29 in `PROGRESS.md`, and the three earlier reports.
Reproducers: `/home/claude/findings/repro-round4.test.js` - 20 tests for 17 findings, all 20 FAIL on the current code, each for the reason stated (`node --test /home/claude/findings/repro-round4.test.js`).
Nothing under `/home/claude/gj-leave` was changed by me. No git, no network, no call to the deployed server.

State note: the tree moved while I worked. I read the code of the "180 tests pass" state. At 18:27 `src/server/store.js` and `schema.js` changed (schema version 3) and `test/round6.test.js` appeared (the project suite then showed 212 tests, 18 failing - none of them mine). I re-ran my 20 reproducers after that change: still 20 of 20 fail. My remarks on `store.js` describe the earlier version.

## Counts

| Severity | Findings |
|---|---|
| Critical | 0 |
| High | 1 (H1) |
| Medium | 3 (M1, M2, M3) |
| Low | 13 (L1-L13) |

Of the 17, six are "an earlier finding is only partly fixed" (M2, L3, L5, L6, L7, L8), two are side effects of a fix (M3, L10), nine are new or in code added while fixing.

## Were the reproducers weakened?

`test/round1.test.js` and `test/round3.test.js` differ from the originals only in the `require` paths. `test/round2.test.js` differs in the paths and in one assertion, the "F1b" test, as the author said.

F1b judgement: **acceptable, with one residual.** The old assertion said "the violation must still be there after a forged edit". The new one says the forged time is ignored (the edit stays Unannounced, is never approved by the system) and the violation returns when Aakash approves. That still proves the security point of F1 (the phone cannot choose the request time). What it gave up: an edit now withdraws the violation at once, before anyone has decided the new version. That opens a small loophole, reproduced as L10.

One test passes although its finding is not really closed: round 2 "F14" looks only at the `gjleave.session` key. The fix moved the token to a second key (L3).

---

## Findings

### H1 - High - A leave granted after the person has already arrived (or left) that day is not re-counted: the violation stays and the day counts twice

- Where: `attendance.js checkIn` / `checkOut` book the minutes against `expectedDay`, which only sees leave that is already Approved. `core.js onGranted` never looks at `DayMinutes` of the leave day. For late / early requests the code does correct the day when Aakash decides later (`shortId`); for leave there is nothing.
- Flow (H1a): Neha (09:30) asks at 05:00 for an emergency half day 09:30-14:00. It waits for Aakash. She arrives at 14:00. Aakash approves at 14:30.
- Result: 270 min "late, not informed" stays booked -> violation "Not informed, more than 30 min" + an automatic half day. With the approved half day that is **1 full leave day and 1 violation** for an approved half day. Approved at 10:30 instead (before she arrives): 0.5 leave, 0 violations. The outcome depends only on how fast Aakash taps.
- Same root (H1b): "called - emergency" typed in by Aakash after the person has come in (the flow the handoff describes in Part 2 no. 11 and 3.5). Also the afternoon case: half day from 14:00 asked in the morning, person leaves at 14:00, approved at 15:00 -> 1 leave day + 2 violations.
- In a random 12-day simulation this showed up on most runs as one date counted 1.5 or 2 leave days.
- Fix: when a leave becomes Approved / Recorded for a date that already has punches, recompute that day's `DayMinutes` against the new `expectedDay` and run `syncViolations`.
- Tests: `H1a`, `H1b`.

### M1 - Medium - Undecided half-day request and the person stays away the whole day: the missed half is never recorded; if rejected, nothing is recorded at all

- Where: `attendance.js endOfDay` (an open request -> only the "not decided" alert, return); `core.js decideLeave` reject branch: `if (r.kind === 'half') return; // ... the end-of-day job has dealt with it`. It has not.
- Rejected next morning (M1a): no absence, no violation, 0 leave for a full day away. Assumption 19 says this becomes "Absent - unannounced" (+1 violation).
- Approved next morning (M1b): 0.5 leave only. Assumption 18 says the other half is an absence.
- Fix: on a late decision of a half-day request for a day with no check-in, record the missing part (full day on reject, the other half on approve).
- Tests: `M1a`, `M1b`.

### M2 - Medium - Round 1 no. 20 is half fixed: the "+1 violation" restriction is frozen at the moment of sending

- Where: `core.js decideLeave` re-checks only `restr.blocked`; `onGranted` uses `r.restrictionViolation` stored at submit.
- M2a: Varun switches the restriction off before Aakash approves -> the leave still gets "Leave in a restricted period".
- M2b: a "+1 violation" restriction is added while the request waits -> approved with no violation (this half was named in round 1 no. 20).
- Fix: recompute `restr.violations` at approval and store it on the row before `onGranted`.
- Tests: `M2a`, `M2b`.

### M3 - Medium - The new C1-E lock fires on ordinary lateness, with a wrong message

- Where: `clash.js checkRequest`, the block added for round 1 no. 14. It triggers whenever rule C1 is "broken" by ANY away entries of two Sales people, and away entries include not-informed late rows and short outings (`core.js approvedAway` reads all `DayMinutes`).
- Flow: Neha on approved leave, Vikas arrives 15 min late (nobody can block that). From then on Bhawna and Pooja cannot send any going-out, late or early request that day: "Not allowed: Sales is running on an extreme emergency on 25 Nov - Bhawna and Pooja must both be present." No extreme emergency was asked for or approved. Two Sales people each 12 min late do the same.
- Knock-on (checked): Bhawna cannot inform that she leaves 1 hour early, leaves anyway -> "not informed, more than 30 min" violation.
- This is the per-day rule (assumption 1) meeting the new lock; the lock itself is not in the assumptions list. Fix options: trigger the lock only from a granted request with `extremeEmergency`, or only from leave (not from late / out minutes); at least correct the message.
- Test: `M3` (control without the lateness: the outing request is accepted).

### Low

| # | What | Where | Test |
|---|---|---|---|
| L1 | Varun rejects Aakash's own leave after the date: Aakash gets "Absent - unannounced" + a violation. He is not tracked (assumption 10) and has no check-in button, so he always "has no check-in". | `core.js decideLeave` reject branch -> `markAbsent` for any role | `L1` |
| L2 | An excused half-day absence becomes an Approved half day with an empty start time. `editLeave` compares "now >= NaN", so the staff member may edit it (the Edit button is shown) into a new request; the missed half day disappears from the month. | `admin.js editLeave`, `core.js markAbsent` (`halfStart: ''`) | `L2` |
| L3 | Round 2 F14 partly: "Sign out" copies the phone token to `gjleave.device` and the server is not told. The token alone still passes `authenticate` (no PIN on the server side). Sign-out protects only against someone using the honest screen. | `docs/app.js signOut` | `L3` |
| L4 | A rejected phone can never ask again: login with the right PIN answers `deviceStatus: 'rejected'`, makes no new request, the app keeps the token and shows "waiting for the owner's approval" for ever. One wrong tap on Reject = that phone needs its browser data cleared. Same dead end for a removed phone (the code says that one is intended). | `core.js loginLocked` (`if (known) return ...`), `docs/app.js viewLogin` | `L4` |
| L5 | Round 2 F11 partly: only `remindBack` got a limit. 40 `requestShort` calls in a minute = 40 alerts and e-mails to Aakash (the daily mail quota is about 100). | `attendance.js requestShort` | `L5` |
| L6 | Round 3 F13 partly: the duplicate guard is a 30-second window on identical text, not a request id. The same incident re-sent after 40 s is a second incident and a second violation. `addCorrection`, new restrictions and new rules have no guard. | `admin.js recordIncident` | `L6` |
| L7 | Round 3 F12 partly: the evening job only handles today. If the 21:00 run is missed once, that day's absences are never created. | `jobs.js endOfDay` | `L7` |
| L8 | Round 3 F11 partly: `savePerson` still checks times by shape; duty end "29:99" is saved. Owner-only screen with a time picker, so hard to reach. | `admin.js validPerson` | `L8` |
| L9 | The call time of a "called - emergency" entry is lost on any edit: fixing a typo turns the entry into Unannounced (+1 violation when approved again). | `admin.js editLeave` (no `opts.at`) | `L9` |
| L10 | Residual of the F1b change: a no-op edit of an approved unannounced leave parks its violation until Aakash re-decides. In that window "no violation this month" is true and another request is auto-approved. | `admin.js editLeave` (`withdrawViolations` before the new decision) | `L10` |
| L11 | Closed day entered after the evening job: the leave day is re-counted, the "absent" violations of that day stay (8 in the test). | `closedDays` is not applied to violations | `L11` |
| L12 | Round 2 F2b on the "own approved phone" path: the lock is always 15 min (`level = own ? 1 : ...`). A signed-out phone in the wrong hands allows 480 PIN tries a day; the PIN generator still makes 4 digits. | `core.js loginLocked` | `L12` |
| L13 | Round 3 note N3, still open, now testable: if the cache refuses the version bump after a write (`cachegrid.commit` swallows the error), later requests - also inside the lock - read the copy from before the write for up to 10 min. In the test two clashing leaves are both Approved. Needs a CacheService fault at that moment, so rare; the effect when it happens is the round 3 Critical again. | `cachegrid.js commit` | `L13` |

---

## The 50 earlier findings

Fixed, checked beyond the one test (variations tried, see "What held"): all except the following.

| Earlier finding | Verdict | Why |
|---|---|---|
| Round 1 no. 7 (pending at day end) | partly | full days fixed; half-day requests not (M1) |
| Round 1 no. 14 (C1-E keeps Calls in) | fixed, with a regression | M3 |
| Round 1 no. 15 / Round 3 F9 (closed day re-count) | partly | leave days yes, absence violations no (L11) |
| Round 1 no. 20 (restriction at approval) | partly | "no leave" yes, "+1 violation" no (M2) |
| Round 2 F1b (edit path) | fixed | test changed on purpose; acceptable; residual L10 |
| Round 2 F2 (PIN guessing) | fixed | public path escalates; own-phone path flat (L12) |
| Round 2 F11 (alert flooding) | partly | L5 |
| Round 2 F14 (sign out) | partly | L3 |
| Round 3 F11 (dates and times by shape) | partly | dates fixed; duty times not (L8) |
| Round 3 F12 (end of day) | partly | "too early" fixed; a missed day is not caught up (L7) |
| Round 3 F13 (same request twice) | partly | L6 |

Round 1 no. 2 (half day mid-shift) is fixed as assumption 17 describes; see the first point under "For the owner".

## What held (attacked, did not break)

- Lock model: every changing action goes through `api.locked` (reset, then fresh sign-in check, then the action); a refused action writes nothing (also no Audit row); a wrong PIN is still counted; nested `withLock` does not flush; no read-only action writes; jobs write only inside the lock. `main.js` final `flush()` has nothing left to write.
- Store against memory: the same random sequence of about 350 calls a run (leave, edit, cancel, decide, late / early, check-in / out, outings, manual entries, incidents, wrong PINs, text starting with `=`, `-`, `+`, `'`, jobs), 6 seeds, once on the memory store and once on the cached + buffered Sheet store: identical replies and identical rows in every tab.
- Random shop simulation, 12 seeds x 12 days: no unexpected server error, no double check-in, no negative minutes, no overlapping granted leave.
- `submittedAt` and every other time from the phone is ignored; `calledAt` is accepted only from Aakash / Varun for someone else.
- PIN lock on the public path (15 min, 1 h, 4 h, 16 h, 24 h), own-phone counter separate, at most 3 waiting phone requests, revoke works at once (also for a request already waiting for the lock), last owner phone cannot be removed.
- Restrictions: Aakash cannot change or switch off one he did not add; shop point: first time Aakash or Varun, then Varun only.
- Formula text, key column by name, oversized cell refused before anything is written, a failed write is not repeated.
- Emergency number settled at grant time among granted ones; quota checked for both months; closed days and automatic half days in the quota; rename follows into rules and restrictions; inactive rule member never counts as present.

## Where the code contradicts the handoff or a recorded owner decision

1. 3.4 "Absent with no request" and assumptions 18 / 19: not applied to half-day requests decided late (M1).
2. 3.6 / 3.3 "a rule added later": the "+1 violation" kind is not re-checked at approval (M2).
3. 3.3 C1-E: the lock on Bhawna and Pooja applies without any extreme emergency (M3).
4. 3.5 "A real emergency is a phone call to Aakash; Aakash records called - emergency": built for leave only. For a late arrival there is no such entry, so a real emergency late arrival over 30 min is always a violation that only a dispute to Varun can remove.
5. Owner decision "late / early: approved later = informed": the same idea is missing for leave approved later (H1).
6. Part 5 "staff can cancel their own request until it starts": holds; but editing is open after the day for excused half absences (L2).

## For the owner (assumptions I would question; not counted as bugs)

- Assumption 17 (half day anywhere in the shift): a person who picks "half day from 14:00" on a 10:30-19:30 duty must come back for 18:30-19:30. If they tap Check out when they leave at 14:00 (the natural thing to do), they get 60 min "not informed" + a violation and cannot check in again. The form shows no warning. Either allow only the first or last 4 h 30 min, or warn on the form.
- Assumption 12: a late request still waiting when the person arrives records a violation and sends "Violation recorded" to the person, Aakash and Varun, then withdraws it when Aakash approves. Noisy.
- Assumption 16: a half day from 14:00 asked at 08:00 the same morning is Unannounced (+1 violation). Follows the handoff wording; worth one explicit yes from the owner.
- Assumption 22 + 29 together are what make L10 possible.
- Assumption 27: say whether the own-phone lock should grow too (L12), and whether PINs should be 6 digits.
- Manual check-in can be entered only for today. If Aakash forgets, the person is "absent" the next morning and the only remedy is "excused", which counts as a leave day although they worked.
- A removed phone is blocked for good unless the browser data is cleared; the owner page should say so.

## Not reproduced / could not be verified here

- How the real Sheet treats the new leading apostrophe (`'-2.5`, `'+91...`) in `setValues` and `getDisplayValues`. The code decodes both forms, so I expect no problem; it needs one check on the TEST Sheet.
- Version keys expiring after 6 hours while a reader and a writer overlap (two readers may each invent a version). Window of milliseconds; not reproduced.
- Photo left in Drive when an overlapping duplicate check-in is refused inside the lock (round 2 D7): still so by reading; not counted, it was a design note.
- A leave approved for a locked month, incidents and manual check-outs dated into a locked month: accepted by the server, do not change the locked result. Read only, not tested (round 6 seems to cover the month lock).
