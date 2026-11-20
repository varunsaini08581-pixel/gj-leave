# GJ Leave & Attendance - bug-hunt round 18 (everything except the counting rules)

Reviewed: commit aef799d, server version 9, schema 4. Independent review; nothing inside `/home/claude/gj-leave` was changed by me, git was not run, no network was used (phone app served on 127.0.0.1 in demo mode).

Files: every file of `src/` and `docs/` (25 files) hashed at the start and at the end: identical, file by file (`round18-hash-start.txt`, `round18-hash-end.txt`; sha256 of the list `d4be1ffa...8ebff5` both times). **No source file changed during the review.** One remark: the project's own suite rebuilds `apps-script/Code.js` and `docs/mock-server.js` when it runs (their time stamps moved to 22:34); the content is the same, both bundles contain every `src/` file byte for byte, and the content hashes in `docs/index.html` match the files.

Project suite (`cd /home/claude/gj-leave && node --test`): **426 tests, 425 pass, 0 fail, 1 skipped** (R9-13, a phone-app test that skips itself when its local web server does not start).

Reproducers: `/home/claude/findings/repro-round18.test.js` (14 tests, **all 14 FAIL** on the current code, each for the reason in its name; set-up steps are guarded with "test set-up" asserts) and `/home/claude/findings/repro-round18-ui.py` (python3 + Playwright, called by the test file; the 5 phone-app tests skip cleanly when Playwright is missing). Run: `node --test /home/claude/findings/repro-round18.test.js`.

## Result

| Severity | Count |
|---|---|
| Critical | 0 |
| High | 0 |
| Medium | 3 |
| Low | 5 |

Plainly: **no Critical and no High.** No staff member, outsider, pending / revoked / signed-out phone or inactive person could do anything reserved for the manager or the owner; the manager could do no owner action except the designed one (approve the owner's waiting phone); no reply leaked a reason, note, dispute text, e-mail, phone number, pay figure, PIN hash or token hash; no ordinary flow of the phone app is broken. Each Medium needs an unusual moment: a Sheet error during the very first setup (M1), a cell changed by hand (M2), the owner's PIN in a second person's hands within 15 minutes of his first sign-in (M3).

## Round 16 fixes re-tested

| Fix | Holds? |
|---|---|
| `store.write()` roll-back, now with blanking of the appended rows | **Holds.** 13 actions (check-in late, check-out early, decide leave / outing, submit leave, incident, login, new person, pay, closed day, evening job, hourly job) were each failed at every single write step: the Sheet was byte-identical to the state before, the reply was the generic error, and the retry gave the same rows as a run without a failure. Same result with an owner's column added in the middle of eight tabs (row written in two pieces, round 16 L6) and with the key column moved to the end. |
| Could it blank a row it did not append? | Not found. Rows are matched by key within the last rows only; every key appended by an action is a fresh random id (Settings and PayInfo rows are appended only when no row with that key exists); everything happens inside the server lock, so no other writer can append in between. A tab whose key column is missing is skipped (nothing blanked). |
| Blank row in the middle of a tab, `__row`, cache, `tail()`, next append | Not reachable through the app: the blanked rows are always the last rows, `getLastRow` then ends before them and the next append reuses the place. Full reads skip empty rows and keep real row positions; the cache versions of every touched tab are retired after a roll-back. |
| Failure in the roll-back itself | Swallowed; the Sheet stays half-written and the reply is the generic error (a double fault, not counted, unchanged from round 16; see "not reproduced" 2). |
| Failure during setup / upgrade / a job | Upgrade (missing columns) and the jobs are safe to run again. **First setup is not: M1.** |
| Owner bootstrap repeated within 15 minutes | The lost-reply case of round 16 M2 is closed (also with other phone rows present, also after `resetOwnerPhones`). A different phone name, a wrong PIN, or minute 16: pending / refused as before. **New weakness: M3** (the token is issued again even when the first one is in use). |
| "asked-again" told once per request | Holds: 21 repeats = 1 phone row, 1 alert, 1 Audit row; the card shows the time through `timeOf` (IST, same on Hindi / Marathi phones: the round 16 test passes). |
| `MAX_REQUESTS_PER_DAY` | Holds: the 7th request of a day is refused; Aakash can still enter one. |
| Manager approves only the owner's pending phone | Holds: staff phone, reject, revoke of an approved owner phone: FORBIDDEN; staff: FORBIDDEN. |
| "E-mail could not be sent" (jobs.js) | Holds. The alert is in-app only (marked `-1` in the same write), so it cannot loop or be e-mailed. Gmail down for one hour with alerts for 8 people at the start and a new alert every 10 minutes: 4 owner alerts and 4 Audit rows in the hour (at most one per 5-minute run); when Gmail is back only the alerts not yet given up are sent. No daily-quota use while failing. |
| `monthReport` with a damaged locked row | Server: the person row is left out and named in `damaged`. **The phone never shows that list, and two other row kinds still break the report: L1.** |
| Kept check-in photo belongs to one person and one day | Holds (round 16 tests pass; by reading: cleared when Today is drawn for another person or another date; never offered once a check-in exists). |
| Approvals anchor on the whole card text | Holds for the round 16 case. |
| `minHeight` held up to 20 s | Round 16 L4 (slow board) holds; it is reset on every navigation. **Side effect: L2** (empty screen when the page became shorter). |
| checkIn / checkOut / imBack / confirmBack / decideShort / undoCheckOut through `recountDay` | Replies still carry `lateMinutes`, `informed`, `earlyMinutes`, `minutes`, `flag`, `distance` for staff, manager and owner; no throw for any hostile value; Sheet reads per call: 0 to 3 with a warm cache, 8 on a cold one. On days that do not count the wording is off: L4. |

Also swept and held: 41,760 random calls and 65,472 single-field mutations of 57 prepared calls, 45 of them accepted as sent (62 hostile values in every field; staff, manager, owner): the only unexpected errors are the `{toString: 1}` objects of round 14 on four owner / preview fields, and no refused call changed a single cell; 55 valid calls x 8 callers (the right role answers, everyone else FORBIDDEN / NOT_FOUND); privacy scan of 26 read actions x 8 people with marker texts in reasons, notes, dispute text, decision reasons, e-mail, phone, pay figures and all hashes (none outside the allowed readers); every cell of every tab damaged with 16 kinds of text, one row at a time, 7 row choices, then about 70 calls and the 4 jobs (only M2 breaks; MonthSheet: L1); 320 px and 390 px on every tab and every More screen for staff, manager and owner with 150-character words and a 120-character phone name, plus the phone's Back button from every screen (no screen wider than the phone, none stuck on Loading, no console error); one full staff day in the phone app with the camera (check-in, going out, I'm back, confirm, My month, check-out).

## Findings

### M1 - Medium - First setup that fails while the default clash rules are written leaves the Sheet with only some of them, for good
- **Where:** `src/server/store.js` `setup()` (`if (!db.rows('Rules').length) Clash.DEFAULT_RULES.forEach(insert)`; setup writes unbuffered, one append per rule); `core.js` `rules()` (defaults are used only while the Rules tab is completely empty).
- **What happens:** `setupOrUpgrade` on a new Sheet; the Sheet service fails after C1 and C2 were written. The run ends with the error. The owner runs it again: it reports only `schemaVersion 4`, a third run "Nothing to do. Already up to date." The Rules tab holds C1 and C2; C3 (Repairing: Raunak, Manish) and C4 (Repair pool) are never written, and because the tab is not empty the built-in defaults are not used either. Raunak and Manish can then both get leave for the same day, auto-approved. The Clash rules screen has no "add a rule" button, so the missing rules can only be typed into the Sheet.
- **Steps:** test M1 (the fake Sheet fails the 4th append to Rules: header, C1, C2, then C3).
- **Why it matters:** a hard owner rule is silently missing from the first day, with a setup log that says everything is up to date. Needs a Sheet error during the four appends of the first setup.
- **Suggested fix:** seed by id (insert every default rule whose id is not in the tab while `stored === 0`), or write all default rules in one append; let the setup log list the rule ids it found. Same pattern, smaller effect: when the failure hits between `schemaVersion` and `startDate`, `startDate` is never written (repaired by `installTriggers`, which sets it).

### M2 - Medium - A "kind" cell of DayMinutes changed by hand takes down that person's Today, the month report of the whole shop and the hourly job
- **Where:** `src/rules/minutes.js` `countedParts` (`throw new Error('Unknown event kind')`), reached from `attendance.js` `monthMinutes` (hints on Today, My month, effect preview, month report, lock, warnings).
- **What happens:** one DayMinutes row whose `kind` is anything but `late` / `early` / `out` (typed "Late", emptied, a stray character). From then on, for the whole month:
  - M2a that person's Today screen answers "Something went wrong" ("Could not load"): no Check in, no Check out, no going out from the phone; My month and the effect preview fail too;
  - M2b the month report fails for Aakash and Varun (all people, not only that one), so the month cannot be confirmed or locked from the phone;
  - M2c the hourly job throws: reminders written so far are saved, the warnings ("bank 80% used", "the next one is a violation", notice stage) stop for everybody.
- **Steps:** tests M2a, M2b, M2c.
- **Why it matters:** rounds 6, 14 and 16 made damaged cells harmless one by one; this one still blocks a person's attendance. In the sweep of every cell of every tab it is the only cell that still does. Way back: correct the cell (up to 10 minutes of cache), or any manager entry that counts that day again (the damaged row is then set to 0).
- **Suggested fix:** in `monthMinutes` leave out rows whose kind is not one of the three and report them through `db.damaged()` (daily summary), as for damaged leave rows; or let `countedParts` return no parts for an unknown kind.

### M3 - Medium - Owner's first sign-in repeated within 15 minutes: the token is re-issued although the first phone is already in use
- **Where:** `src/server/core.js` `loginLocked`, `boot` branch (round 16 M2 fix).
- **What happens:** the rule was built for a lost reply. It does not check whether the first token was ever used. Anyone who has the owner's PIN and a phone that names itself the same way (the names are generic: "Android phone, Chrome", "iPhone, Safari") is, for 15 minutes after the owner's first sign-in (release day, and after every `resetOwnerPhones`), signed in as **owner at once**, and the owner's own phone stops working in the same moment. Normally the PIN alone gives only a waiting request that the owner must approve.
- **Steps:** test M3: owner signs in at 10:00, uses the app (`me`, `setPin`), a second phone signs in at 10:05 with the PIN: `approved` with a token; the owner's next call answers AUTH.
- **What limits it:** the PIN is needed; 15 minutes; an Audit row and an alert are written (the alert is in-app on the account the owner was just pushed out of, plus the e-mail digest if the timers run). The owner gets back in by signing in again inside the window (then the other phone is out), later through Aakash's approval or `resetOwnerPhones`. Rated Medium for consistency with round 14 M3 (same class: take-over that needs the PIN); the window is much narrower here.
- **Suggested fix:** re-issue only while the first token has made no authenticated call (set a `lastSeenAt` / `usedAt` cell on the first call, or reuse `signedOut`-style marking); after that, treat the sign-in as a new, waiting phone.

### L1 - Low - Month report: the phone does not show the damaged rows; a damaged confirmation or correction row still breaks the report (round 16 L7, remnant)
- **Where:** `docs/app-admin.js` `V.report` (never reads `r.damaged`; `c.name` on every correction); `src/server/views.js` `monthReport` (`r.result.by` for "lock-ack" rows; corrections passed on as they are).
- **What happens:**
  - U1a one person's locked result is unreadable: the server leaves the person out and names him in `damaged`; the phone shows the other 8 people and no word about it. The person is also missing from the Corrections list.
  - L1b / U1b a damaged correction row reaches the phone as `null`; the screen code fails inside the answer, the error is swallowed, and tapping the month does nothing (no report, no message).
  - L1a a damaged confirmation ("lock-ack") row: the report answers "Something went wrong" before the lock and for ever after it (the row stays), although `lockMonth` itself still works.
- **Steps:** tests L1a, L1b, U1a, U1b.
- **Why it matters:** the locked report is what salary is paid from; a missing person should be said, not silent. Needs a hand-edited cell.
- **Suggested fix:** phone: a warning card "N row(s) of this month could not be read: names" from `r.damaged`; server: skip corrections and confirmations whose `result` is not an object (and count them in `damaged`).

### L2 - Low - Approvals: after the automatic refresh the screen can be completely empty for 20 seconds
- **Where:** `docs/app.js` `show()` (`app.style.minHeight = app.offsetHeight` on an automatic refresh, cleared by a 20-second timer; scroll position kept).
- **What happens / steps:** Aakash has six waiting cards and has scrolled to the lower ones (811 px). Varun decides all six on his phone. At the next 30-second refresh the list is "Nothing is waiting." at the top, the page keeps its old height (1439 px) and its old scroll position, so nothing at all is on the screen. After 20 seconds the height is released and the page jumps to the top. Test U2. With some cards left the anchor keeps one in view and only empty space remains below.
- **Why it matters:** looks like a broken app for 20 seconds; no wrong tap is possible. The 20 seconds came in with the round 16 L4 fix (was 4).
- **Suggested fix:** hold the height only on Today while the board is loading (clear it when the board call ends), not on Approvals; or after drawing, if nothing is inside the viewport, scroll to the last element.

### L3 - Low - A slow answer to the automatic refresh can paint over the answer to the person's own action
- **Where:** `docs/app.js` `refresh()` / `show()` (`state.auto` marks "the next draw is the automatic one"; the screen functions do not carry which call they belong to).
- **What happens / steps:** the automatic refresh of Today starts; its answer takes 5 seconds. Meanwhile Neha sends "I will leave early 18:00"; that call and the redraw after it are answered first. The redraw is taken for the automatic one and dropped (the form still holds what she typed); then the old answer arrives and is drawn as a normal one. Result: toast "Sent to Aakash.", but the card shows no request and an empty form. Test U3. The same order of answers after "Check out" shows the Check out button again. The next refresh (30 s) puts it right; a second tap is refused by the server ("already sent").
- **Why it matters:** a person may think the request was not sent. Needs the earlier call to be slower than two later ones (Apps Script answers vary between 2 and 6 seconds, so it is rare, not impossible).
- **Suggested fix:** give every load of a screen a number; draw an answer only if no later load of that screen has been drawn; pass "automatic" as an argument of the load instead of a shared flag.

### L4 - Low - On a day that does not count, replies, board and daily summary still say "late"
- **Where:** `src/server/attendance.js` `checkIn` (`lateMinutes` falls back to the raw minutes when no row was counted); `views.js` `board` (`lateMinutes` is 0 only for roster-off and full leave, not for a closed day); `jobs.js` `endOfDay` summary; `docs/app-admin.js` ("Saved. N min late.").
- **What happens:**
  - L4a Aakash enters a check-in at 11:00 for Manish on Manish's roster Sunday off: the phone prints "Saved. 90 min late."; the board says 0 and nothing is counted.
  - L4b shop-closed day, Harsh comes in at 12:00: nothing is counted, but the board shows "1 h 30 min late" and the owner's daily summary lists "Late: Harsh 90 min (in 12:00)". On a closed day the board also shows everybody as "Not in yet - late".
- **Steps:** tests L4a, L4b.
- **Why it matters:** wording only; the count (assumption 55) is right. The owner's summary names a person as late on a day the shop was closed.
- **Suggested fix:** one helper "does this day count for this person" (already `dayCounts`) used by the reply, the board and the summary.

### L5 - Low - A signed-in phone that opens the app without a connection gets the sign-in form
- **Where:** `docs/app.js` `start()` (`if (e.code !== 'AUTH') viewLogin(e.message)`).
- **What happens / steps:** the phone is approved and signed in. The app is opened while the first call fails (no signal, 45-second timeout, or the "being updated" answer during a redeploy): the sign-in screen appears with the message above the name and PIN fields; there is no "Try again". The person types the PIN again although nothing was wrong with the sign-in. Test U4. Every other screen that cannot load shows "Could not load / Try again" (round 5).
- **Why it matters:** in a shop with weak signal this is the first thing people see; it reads as "you were signed out". The token is not lost and signing in again works.
- **Suggested fix:** in `start()` show `showLoadError(e.message)` with `state.reload = start` for every code except AUTH.

## Questions for the owner (not counted)

1. M3: once the owner's first phone is in use, should a second sign-in in the first 15 minutes wait for approval like any new phone (proposed)?
2. L4: someone comes to work on a shop-closed day or on their roster Sunday off. Should the board and the daily summary show the arrival without the word "late" (proposed), or keep it?
3. Round 14 questions 1, 2 and 4 and round 16 questions 1 and 2 are still open (manager approval of the owner's phone, alerting Aakash about it, two people on one phone, how long a kept photo may be used, e-mail given up after about 20 minutes).

## Not reproduced / needs the real deployment (NOT counted)

1. **Roll-back and the apostrophe** (round 16, unchanged): the roll-back writes back what `getDisplayValues` returned, without the protecting apostrophe. New side of the same question: the blanking of appended rows compares the encoded key (with apostrophe) with the displayed key (without). A person added with a name that does not start with a Latin letter or digit gets an id that starts with "-" (for example a name in Devanagari gives `--ab12`), so after a failed write that People row may not be blanked on the real Sheet. Must be tried on the TEST Sheet.
2. **Roll-back while the Sheet stays down:** a Sheets outage usually lasts longer than one call; the roll-back writes then fail too (swallowed) and the half-written action stays. The reproducers can only fail one step.
3. **Growth of the Notifications tab:** Today, Notifications and the jobs read the whole tab. The read cache keeps a tab only up to about 1 MB of text (12 pieces); beyond that (a few months at about 80 alerts a day) every Today load reads the tab from the Sheet again. The cost on the real Sheet is not measurable here.
4. **UPDATE answer in real mode:** the one-time reload drops `?demo=1`, so it cannot be followed in demo mode; read only (one reload, then the "Update needed" card, no loop).
5. **L3 on the real server:** how often an earlier call is overtaken by two later ones depends on Apps Script; reproduced with injected delays.
6. **Check-in photo upload on a slow connection:** a 900 KB photo against the 45-second timeout; the photo is kept and "Send again" has the same limit. Needs a real phone on mobile data.
7. **Camera with the phone's Back button, landscape with rotation lock, iPhone home-screen storage, `resetOwnerPhones`:** unchanged from rounds 14 and 16 (real phone / script editor needed).
