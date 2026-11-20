# GJ Leave & Attendance - bug-hunt round 14 (everything except the counting rules)

Reviewed: commit b471950, server version 9, schema 4. Independent review; nothing inside `/home/claude/gj-leave` was changed, git was not run, no network was used (phone app served on 127.0.0.1 in demo mode).

Files: `src/` and `docs/` (25 files) hashed (sha256 of all file hashes) at the start and at the end: `a20aec8a...f37f4e` both times. **No file changed during the review.**

Project suite (`cd /home/claude/gj-leave && node --test`): **362 tests, 361 pass, 0 fail, 1 skipped.**

Reproducers: `/home/claude/findings/repro-round14.test.js` (19 tests, **all 19 FAIL** on the current code, each for the reason in its name) and `/home/claude/findings/repro-round14-ui.py` (python3 + Playwright, called by the test file; the 6 phone-app tests skip cleanly when Playwright is missing). Run: `node --test /home/claude/findings/repro-round14.test.js`.

## Result

| Severity | Count |
|---|---|
| Critical | 0 |
| High | 0 |
| Medium | 5 |
| Low | 9 |

Plainly: **no Critical and no High.** I could not make a staff member, an outsider, or the manager acting alone do anything reserved for the manager or the owner, and I found no privacy leak. The five Mediums are: a storage inconsistency that needs a Sheet error at one moment (M1), three weaknesses around the owner's phone (M2, M3, M4: each needs a lost reply, a known PIN, or a lost phone plus a stranger), and one remnant of a round 12 fix (M5).

## Round 12 fixes re-tested

| Fix | Holds? |
|---|---|
| Owner recovery, `decideDeviceLocked` | Yes for access. Staff: FORBIDDEN. Manager: can approve ONLY a waiting phone of the owner; reject it, revoke an approved owner phone, approve a staff phone or his own: all FORBIDDEN. Owner's name with a wrong PIN creates no phone request (a counted wrong PIN and an Audit row only). The manager alone cannot create the request (needs the owner's PIN). Weak points: M2, M3, M4. |
| Same-label sign-in reuses the request | Works for the lost reply of a WAITING request. Opened M3 (silent take-over) and does not cover the bootstrap phone (M2). |
| Tokens per person, offline sign-out | Hold. Two people on one phone keep their own approvals; offline Sign out refuses and says so. |
| Automatic refresh | Untouched Today / Approvals still refresh; a form with anything entered is not redrawn (also when the answer is AUTH); a tab tapped right after a refresh started is drawn as a normal navigation (top of page). Remnant: M5. New small ones: L5, L7. |
| Wrapping | 320 px and 390 px, every tab and every More screen (and the person, pay, rule forms) for staff, manager, owner, with 150-character words in reasons, notes, names, e-mail: **no screen wider than the phone**. |
| `store.write()` order | The round 12 case holds (no alert for an unsaved change). The new order has its own failure: M1. |
| TEXT_ARGS | Holds for the listed fields. A few fields outside the list: L8. |
| Photo removed after a refused check-in | Holds. |
| Approvals without the actor's own request | Holds: Aakash's request is not in his list, is in Varun's, and Varun can decide it. |
| graceTable validation | The Grace table screen saves the table it shows. A number above 31: L9. |
| Damaged Rules / Restrictions / shopPoint | Hold. Three other cells: L6. |
| E-mail retry | A passing fault is retried. No upper limit: L1. |

Also swept and held: 9,750 calls with hostile values in every field for owner, manager and staff (only `{toString: 1}` objects give a generic "Something went wrong", nothing stored); every action as staff against other people's records (all FORBIDDEN / NOT_FOUND); staff replies scanned for other people's reasons, notes, dispute text, e-mail, phone, pay numbers, PIN / token hashes (none); UPDATE / UPGRADE / ERROR answers on a screen (clear message, Try again, no reload loop); phone Back button (stays in the app); no emoji or non-English UI text.

## Findings

### M1 - Medium - A Sheet error between "changed rows" and "new rows" saves the decision without the rows it needs; the retry is refused
- **Where:** `src/server/store.js` `write()` (changed rows first, appended rows last, round 12 M4 fix); `attendance.js` `confirmBack`, `imBack`, `decideDress`; `core.js` `decideLeave`; `views.js` `lockMonth`.
- **What happens:** when the append step fails after the row updates went through, the action answers "Something went wrong" but its status change is on the Sheet. The new rows are not: DayMinutes, Incidents, Violations, MonthSheet, Audit, Notifications. A second tap is refused because the status already changed, and no later job repairs it.
  - M1a `confirmBack` (also `imBack`): outing "Confirmed, 44 min", 0 DayMinutes rows, bank shows 0 min used. Second tap: "Nothing to confirm."
  - M1b `decideDress` confirm: flag "confirmed", gone from Approvals, 0 incidents (grace count never sees it).
  - M1c `decideLeave` approve of an Unannounced leave: "Approved", 0 violations, no `leave.decide` Audit row, no alert to the person. Second tap: "not waiting for a decision". Hourly and evening jobs do not add the violation.
  - M1d `lockMonth`: first try closes the waiting requests and fails; second try locks. Raunak's locked October shows 2 leaves instead of 3 (the "counted, not decided" day is gone, because the request is now Cancelled).
- **Why it matters:** minutes and violations silently missing from a person's month, and a locked month that differs from what both approvers saw. Needs a Sheets failure at that moment (they do occur on Apps Script). Before round 12 the same failure produced a wrong alert; now it produces a wrong count with no trace.
- **Suggested fix:** make the retry repair instead of refuse. Derive the new rows from the changed row by id (DayMinutes by `source` = outing id, Incident by punch id, violations already have `syncLeaveViolations`: call it for the person on every read of a decided-but-unsynced row or from the hourly job; `lockMonth`: compute results before closing and, on a retry, treat requests "closed with the month lock" of an unlocked month as still counted). Or write a one-row "in progress" marker first and finish the action on the next call.

### M2 - Medium - The owner's very first sign-in with a lost reply leaves nobody able to approve anything
- **Where:** `src/server/core.js` `loginLocked` (bootstrap approval; the `same` branch only looks at `pending` requests).
- **What happens / steps:** new Sheet, no phones. Owner signs in: phone approved, token returned once. That reply does not reach the phone. He taps Sign in again: no token, an approved owner phone exists, so the new request is "pending". The manager's phone is pending too. Nobody is signed in.
- **Why it matters:** lock-out at the first step of release. Only way out: `resetOwnerPhones` in the script editor. Needs one lost reply (first call on a cold server; login measured up to 6 s).
- **Suggested fix:** when the owner signs in with the right PIN and no token, and the only approved owner phone was approved by "bootstrap" with the same label and has never made an authenticated call (add `lastSeenAt`, or check within 10 minutes of `requestedAt`), re-issue its token instead of making a new request.

### M3 - Medium - A waiting phone request is taken over silently by a second sign-in (needs the PIN)
- **Where:** `src/server/core.js` `loginLocked`, `same` branch (new in round 12); `docs/app.js` `phoneLabel()`.
- **What happens:** a sign-in with the right PIN, no token and the same label replaces the token of the waiting request. Labels are generic ("Android phone, Chrome", "iPhone, Safari"), so two phones normally have the same label. No Audit row, no alert, the approver's card is unchanged except its time. Whoever signed in last gets the approval.
  - M3a staff: Harsh's new phone waits; someone who knows his PIN signs in on another phone; Varun taps Approve once: Harsh's phone is not in, the other phone is.
  - M3b owner recovery: the owner's new phone waits for Aakash; a second iPhone with the owner's PIN signs in; Aakash approves the one card: the second phone is signed in as **owner**, the phone that asked first is not, and the owner's old working phone is removed by the approval.
- **Is it worse than before round 12?** Yes in one respect: before, the second attempt made a second card (a visible sign, and a 50% chance). Now there is one card and no trace. It still needs the PIN, so it is not an escalation without a secret.
- **Suggested fix:** write an Audit row and re-alert on every token replacement; show "asked N times, last at HH:MM" on the card; better, return a 2-digit code with the pending reply, show it on the waiting phone and on the approver's card ("approve only if the phone shows 47").

### M4 - Medium - Anyone who knows the owner's name can keep both owner recovery paths shut; `resetOwnerPhones` does not clear the PIN lock
- **Where:** `src/gas/main.js` `resetOwnerPhones` (sets Devices to revoked only); `core.js` `loginLocked` (lock on People for a phone that is not approved).
- **What happens / steps:** `names` is public. 5 wrong PINs on "Varun" lock new-phone sign-in for the owner (15 min, 1 h, 4 h, 16 h, then 24 h each; 5 guesses a day keep it shut). Owner has lost his phone: with the right PIN he gets "Too many wrong PINs", so no request reaches Aakash (path b). `resetOwnerPhones` answers "1 owner phone(s) removed. Sign in with the owner PIN now." and the sign-in is still LOCKED (path c).
- **Why it matters:** the owner stays out as long as someone keeps guessing; the message tells him to "ask the owner to reset your PIN". Workaround: clear `pinLockedUntil` / `pinLockLevel` / `pinTries` in the People tab by hand (up to 10 minutes of cache).
- **Suggested fix:** `resetOwnerPhones` also clears the three lock cells of the owner rows (and bumps `v:People`); document it. Consider not locking the first right-PIN attempt after a lock has run for the owner (round 10 M3, part 2, is still open).

### M5 - Medium - Manager's and owner's Today tab is thrown to the top by every 30-second refresh (round 12 M2, remnant)
- **Where:** `docs/app.js` `show()` (keeps `scrollY`), `docs/app-admin.js` `GJBoard` (fills the board after `show()`).
- **What happens / steps:** Aakash on Today, scrolled to 491 px (board, alerts). At the refresh the page is drawn with the board card still "Loading", the page is shorter than the kept position, the position becomes 0, then the board arrives. Staff Today and Approvals keep their place.
- **Why it matters:** the shop board is the manager's main screen; its lower half cannot be read for more than 30 s. No button moves under the finger there, so no wrong tap.
- **Suggested fix:** on an auto refresh keep the old board card until the new one has loaded (or set the scroll position again after the board is filled; or give the card a min-height equal to its last height).

### L1 - Low - E-mail job: no limit on retries
`src/server/jobs.js` `sendEmails`: a send that fails with anything other than a "bad address" text is unmarked and tried again on every run: 288 tries in 288 runs, for ever (two Sheet writes per run). A failing send uses no Gmail quota as far as I know; if a send delivers and then throws (a timeout after delivery), the same e-mail would go out every 5 minutes: not reproducible here, see the list below. Fix: a try counter per alert (give up after 3, mark -3).

### L2 - Low - Alert / e-mail flood through submit + cancel (round 10 L1, the door that was left)
`core.js` `submitLeave` / `cancelLeave`: no limit on requests per person per day. Pooja sends a leave for tomorrow and cancels it, every 5 minutes: 287 alerts for Aakash, 0 of the day's 100 e-mails left. Traceable in Audit. Fix: at most N new leave requests per person per day (for example 10), or one e-mail digest per person per hour.

### L3 - Low - A screen under More paints over the tab the person has moved to
`docs/app-admin.js`: `V.leaves`, `V.closed`, `V.phones`, `V.restrictions`, `V.rules`, `V.disputes`, `V.report` are called again after their action without the guard the four main tabs got in round 5; the person / pay forms call `open('people')`. Steps: Staff leaves, cancel a leave, tap Today before the answer: tab bar says "Today", screen shows "Staff leaves". Fix: after an action redraw only when `state.sub` is still that screen.

### L4 - Low - Manager's card for the owner's new phone: a Reject that can only fail, no explanation
`docs/app.js` approvals, `a.devices`: Aakash sees "Varun · New phone / Approve phone / Reject". Reject answers "Only the owner can approve a phone." The card does not say that this is the owner's lost-phone recovery or that he should approve only when Varun himself asks. Fix: for a manager show only Approve, with one line of caution.

### L5 - Low - A refresh that fails replaces the whole Today screen by one line
`docs/app.js` `VIEWS.home` `.catch`: a moment without network at the 30-second refresh leaves "No connection, or the server took too long. Please try again." and no button (Check in, Check out, "Send again" for a kept photo gone) until a later refresh works. Fix: on a failed auto refresh keep the screen and show a toast.

### L6 - Low - Three hand-damaged cells still take something down
- L6a `attendance.js` `endOfDay`: Settings `closedDays` holding valid JSON that is not a list (`{"2026-12-25":true}`, `12`, `null`) stops `jobEndOfDay` every night ("closed.indexOf is not a function"): no absent check, no daily summary. Fix: use `H.closedSet`.
- L6b `views.js` `myRestrictions`: Restrictions `appliesTo` = `12` or `{...}`: the action fails for everybody; the Apply form shows no restricted dates. Fix: use `H.restrictions(ctx)`.
- (seen, no separate test) MonthSheet `result` damaged: the month report of that locked month fails.

### L7 - Low - Approvals: a request that arrives moves another card under the finger
`docs/app.js` `show()`: the scroll position is kept in pixels; a new leave request is drawn above the going-out and late / early cards. Finger on "Approve" of Neha's going-out card; after the refresh the same spot is Manish's leave card. Approve acts on one tap. Needs a new request in the same seconds. Fix: keep the position relative to the card under the middle of the screen, or append new cards below and mark them "new".

### L8 - Low - Non-text accepted in fields outside TEXT_ARGS (API only, owner / manager)
`admin.js` `overrideLeave.reasonCode`, `savePerson.email` / `phone`; `core.js` `halfStart` on a full-day entry; `recordIncident.photoId`: an object is stored as "[object Object]". A `{toString: 1}` object in several fields gives "Something went wrong" instead of a clear refusal. Fix: check `REASONS` in `overrideLeave`; require strings for these fields.

### L9 - Low - Grace table: a number above 31 is refused with no hint
`docs/app-admin.js` `V.grace` / `admin.js` `setSetting`: 40 in a row answers only "The grace table is not valid."; the field has no `max`. (Also: `per: 'week'` is accepted by the server and counted as a month.) Fix: `max="31"` on the field and a message naming the row; drop `week`.

## Questions for the owner (not counted)

1. Assumption 63 (b): Aakash can approve the owner's new phone. With M3, anyone who has seen the owner's PIN and gets Aakash to tap Approve is the owner, and the real owner's phone is removed. Is manager approval acceptable, or editor-only recovery (`resetOwnerPhones`)? If (b) stays: should Aakash be told to approve only on a call from Varun, and should the owner's PIN be longer than 4 digits?
2. Should Aakash be alerted when the owner's new phone is waiting? Today only the owner is alerted (on the phone he no longer has); Aakash sees it only when he opens Approvals.
3. Is a limit of leave requests per person per day acceptable (L2)? How many?
4. May two staff members use one phone (for example Anita on a colleague's phone)? It works today; each needs the owner's approval once on that phone.

## Not reproduced / needs the real deployment (NOT counted)

1. **E-mail delivered, then an error** (L1): whether `MailApp.sendEmail` can throw "timed out" after the mail has gone out. If it can, the retry sends the same e-mail every 5 minutes and uses the day's quota.
2. **How often a Sheet write fails between `writeRow` and `appendMany`** (M1): the reproducer injects the failure; the real rate on Apps Script is unknown.
3. **Check-in answered UPGRADE** (during a redeploy, before `setupOrUpgrade`): by reading `docs/app.js`, the photo is kept only for NET / SERVER / ERROR, so it would have to be taken again.
4. **AUTH answer for `names`** would loop the sign-in screen (seen only with a fake server that answers AUTH to everything; the real server never does for `names`).
5. **`resetOwnerPhones`** finds its columns with `indexOf` on untrimmed headers and does not take the script lock: a header with a trailing space, or a sign-in at the same second, was not tried on a real Sheet.
6. **Header cache (6 hours):** a header row repaired by hand, not by `setupOrUpgrade`, may keep the app on "being updated" for up to 6 hours.
7. **Landscape check with rotation lock, camera plus phone Back, iPhone home-screen storage** (separate from Safari: the first sign-in from the icon is a new request; with the same-label rule it replaces the Safari one): real phones needed.
8. Items 1, 2, 5, 6, 7, 8 of the round 12 list are unchanged and still open.
