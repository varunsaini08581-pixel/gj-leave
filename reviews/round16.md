# GJ Leave & Attendance - bug-hunt round 16 (everything except the counting rules)

Reviewed: commit 4169780, server version 9, schema 4. Independent review; nothing inside `/home/claude/gj-leave` was changed, git was not run, no network was used (phone app served on 127.0.0.1 in demo mode).

Files: `src/` and `docs/` hashed (sha256 of all file hashes) at the start and at the end: `77ee96ed...1aebcb` both times. **No file changed during the review.** (The review machine restarted once after about 8 minutes; scratch files were rebuilt, the hash was the same before and after.)

Project suite (`cd /home/claude/gj-leave && node --test`): **398 tests, 397 pass, 0 fail, 1 skipped.**

Reproducers: `/home/claude/findings/repro-round16.test.js` (15 tests, **all 15 FAIL** on the current code, each for the reason in its name; set-up steps are guarded with "test set-up" asserts) and `/home/claude/findings/repro-round16-ui.py` (python3 + Playwright, called by the test file; the 5 phone-app tests skip cleanly when Playwright is missing). Run: `node --test /home/claude/findings/repro-round16.test.js`.

## Result

| Severity | Count |
|---|---|
| Critical | 0 |
| High | 0 |
| Medium | 3 |
| Low | 7 |

Plainly: **no Critical and no High.** No staff member, outsider, pending / revoked / signed-out phone or inactive person could do anything reserved for the manager or the owner, the manager could do no owner action except the one that is designed (approve the owner's waiting phone), and no reply leaked a reason, note, dispute text, e-mail, phone number, pay figure, PIN hash or token hash. The three Mediums each need an unusual moment: a Sheet error at one step (M1), a lost reply at the owner's first sign-in (M2), an upload that failed and an app left open (M3).

## Round 14 fixes re-tested

| Fix | Holds? |
|---|---|
| `store.write()` roll-back | Holds for what it was built for. Failure on the 1st, 2nd or last changed row, two tabs changed in one request, a row moved by hand between read and write: changed rows are put back from `was`, the cache versions are retired (no stale copy after a roll-back), the retry of the same action works. **Does not hold** when the failure comes between the appended tabs (M1), or in the second piece of a row that is written in two pieces (L6). Failure of the roll-back itself: swallowed, the Sheet stays half-written and the action answers the generic error (a double fault; not counted). |
| Byte-for-byte write-back of formula-like / apostrophe / JSON text | In the test Sheet model: yes. On the real Sheet the roll-back writes back what `getDisplayValues` returned, i.e. without the protecting apostrophe: see "needs the real deployment" 1. |
| Repeated first sign-in keeps one request | Holds: one row, `asked-again`, Audit row, alert, card shows the time. Empty label behaves the same. The manager sees only the owner's waiting phone. Opened L1 (no limit on the alerts) and L5 (time format). |
| Owner bootstrap repeated within 15 minutes | Works only while the Devices tab has exactly one row: M2. Only someone with the owner's PIN and the same label can use the window (the earlier token then stops working, Audit row only). Two owners: the second owner's phone is "pending", not bootstrap. |
| Manager approves only the owner's pending phone | Holds. Reject, revoke, a staff phone, his own phone: FORBIDDEN. Card has no Reject button and carries the caution text. |
| `MAX_REQUESTS_PER_DAY = 6` | Blocks only the staff member's own sending; Aakash entering a request (also a called-in emergency) is not blocked. Not dodged by cancel + resend. Edits are limited separately (10 per request). Note: an edit sets `submittedAt` to now, so requests of earlier days that were edited today count toward today's 6 (not reproduced as a real block; needs 6). |
| Wrong-PIN lock, `resetOwnerPhones` | Lock escalation as in assumption 27; own approved phone keeps its own counter. `resetOwnerPhones` clears the owner's lock cells (read only; not runnable here). |
| E-mail retry counter (-11..-15, then -2) | `emailedAt` is read only by `sendEmails`; no other code is confused by -11. Counter works as written. Consequence: L2. |
| `TEXT_ARGS` | Every `api()` call in `docs/app.js` and `docs/app-admin.js` was checked against the list: all listed keys are sent as text (or left out / null). Nothing legitimate is refused. |
| Grace table validation | Holds (whole number 0 to 31, clear message). |
| `show()` anchor on Approvals | Holds when headings differ. Fails for two cards with the same heading: L3. |
| `minHeight` for 4 s on Today | Holds when the board answers within 4 s. Slower: L4. |
| `run()` drops the answer after navigation | No flow found that hangs with a disabled button or never continues: login, check-in with camera, apply + preview, sign-out, month navigation, admin sub-screens all continue (the generation only changes together with a redraw). One side effect on the kept photo: part of M3. |
| Failed automatic refresh keeps Today | Holds. |

Also swept and held: 46 actions x 7 callers (staff, pending phone, revoked phone, inactive person, signed-out, owner's name with a staff token, manager's name with a staff token): only a staff member's own read actions answered, every other call was AUTH / FORBIDDEN and left the Sheet byte-identical; staff and manager replies scanned for marker reasons, outing reason, incident note, dispute text, e-mail, phone, pay figures, hashes (none); every JSON cell of every tab and every Settings value set to 10 kinds of damage, then 22 actions and the 4 jobs (only L7 breaks); 320 px and 390 px on every tab and every More screen for owner, manager and staff with a 120-character device label and a 180-character reason (no screen wider than the phone, no screen stuck on Loading).

## Findings

### M1 - Medium - A Sheet error between the appended tabs leaves half an action; the roll-back then makes the retry count twice, or the rows are lost for good
- **Where:** `src/gas/main.js` `gjGrid_.appendMany` (one `setValues` per tab, tab after tab); `src/server/store.js` `write()` (rolls back changed rows only; appended rows cannot be taken back); `attendance.js` `imBack`, `checkIn`, `checkOut`, `endOfDay`; `admin.js` `recordIncident`.
- **What happens:** round 14's reproducer failed the append step as a whole. On the real Sheet the append is several writes. When a later tab fails, the tabs already written stay.
  - M1a `imBack`: DayMinutes is appended, Audit fails, the Outings row is rolled back to "Approved". The person taps "I'm back" again: a second DayMinutes row. One 44-minute outing uses 88 minutes of the bank. This case is caused by the roll-back (before it the retry was refused).
  - M1b `checkIn` 50 minutes late, not informed: Punches is appended, DayMinutes fails. The person is checked in; the late minutes and the violation never exist; the retry answers "You have already checked in today." Same for an early `checkOut` (90 minutes missing in the test run).
  - M1c evening job: the "Absent – unannounced" rows are appended, Violations fails. Every absence of that run has no violation (32 in the test run, which also catches up three earlier days); the next runs leave those days alone ("dealt with once").
  - M1d `recordIncident` beyond grace: the Incident row says "violation", no Violations row; the retry answers "violation" from the stored incident.
- **Steps:** see tests M1a to M1d (the fake Sheet follows `gjGrid_` call by call and fails one named step).
- **Why it matters:** minutes counted twice or not at all, violations missing, with only "Something went wrong" as a trace. Needs a Sheets failure at one step.
- **Suggested fix:** make the appended rows safe to repeat: give every appended row a key that the action can find again (DayMinutes by `source`, Violations by `proof` + rule, Incidents by id) and skip or repair on a retry; in `checkIn` / `checkOut` treat "punch exists, minutes row missing" as unfinished and finish it; in `endOfDay` call `syncLeaveViolations` for people whose system absence has no violation. Or write all appended tabs of one request in a single batch call (Sheets API `batchUpdate`), which fails as a whole.

### M2 - Medium - Owner's first sign-in with a lost reply: the 15-minute rule works only while the Devices tab has exactly one row
- **Where:** `src/server/core.js` `loginLocked` (`everyPhone.length === 1`).
- **What happens / steps:**
  - M2a new Sheet: Aakash (or any staff member) taps Sign in first, so one "pending" row exists. The owner signs in: approved by bootstrap, the reply is lost. He signs in again one minute later: "pending". Nobody is signed in, nobody can approve.
  - M2b after `resetOwnerPhones` (the Devices tab always has other rows then): first sign-in approved, reply lost, second sign-in "pending".
- **Why it matters:** the round 14 M2 lock-out is closed only for a completely empty Devices tab. Way back: `resetOwnerPhones` in the script editor again (M2a), or the manager's approval if he is signed in (M2b).
- **Suggested fix:** look only at the owner's own rows: the person's single approved row with `decidedBy === 'bootstrap'`, same label, within 15 minutes, and no authenticated call made with it yet.

### M3 - Medium - A check-in photo that could not be sent stays in the app with no owner and no date
- **Where:** `docs/app.js` `state.shot` (set on NET / SERVER / ERROR, cleared only by a successful send that is still on the Today screen), "Send again" in `VIEWS.home`.
- **What happens / steps:**
  - M3a Vikas takes the photo on 20 Nov, the upload fails, the photo is kept. The app stays open (Aakash enters the check-in by hand, or the person simply leaves it). On 21 Nov the Today screen says "Your photo is saved on this phone but was not sent" and "Send again" checks him in for 21 Nov with the photo and the location of 20 Nov, without the camera.
  - M3b Vikas's upload fails; he signs out; Harsh signs in on the same phone (two people on one phone work today): Harsh is offered "Send again" and one tap checks Harsh in with Vikas's photo.
- **Why it matters:** a check-in whose photo and location are not of that day or not of that person; the photo check-in is the proof the owner relies on. Needs a failed upload and an app that was not closed. (Sending any JPEG through the API is already a noted design risk for technical people; this is the same result with one tap.)
- **Suggested fix:** keep `{ personId, date, shot }`; show "Send again" only for the same person and the same server day; drop it on sign-out and when the day changes; clear it when Today shows a check-in.

### L1 - Low - "Phone request repeated" has no limit
`core.js` `loginLocked`, `same` branch: every repeated first sign-in (right PIN, no token) writes an alert to the owner and an Audit row. 200 repeats by one staff member: 199 alerts; the owner's in-app list (last 50) holds nothing else, and one digest e-mail goes out per 5-minute run until the day's quota is used. Same door as round 14 L2, left open by the 6-per-day rule. Fix: alert at most once per request per hour (compare with `decidedAt`), keep the Audit row.

### L2 - Low - An e-mail is given up after five failed runs (about 20 minutes), and nobody is told
`jobs.js` `sendEmails`: -11, -12, -13, -14, then -2. Gmail failing from 09:05 to 09:25 loses the manager's "Leave request" e-mail for good; no Audit row, no alert, nothing in the daily summary. It is written only in PROGRESS (assumption 70), not on the owner page. The in-app alert stays, and the 2-hourly reminder sends a new e-mail for a request that is still waiting. Fix: count tries per hour instead of per run (give up after a day), and add one line to the owner's daily summary ("N alerts could not be e-mailed").

### L3 - Low - Approvals: two cards with the same heading defeat the anchor
`docs/app.js` `show()` / `cardKey()`: the key is the heading text. Bhawna has asked to come late on 21 Nov and on 23 Nov (both headings "Bhawna · Coming late"); a new leave request is drawn above; after the refresh the finger that was on "Approve" of 23 Nov is on "Approve" of 21 Nov. Same for two leave requests of one person when a card arrives above them. Fix: put the record id on the card (`data-id`) and anchor on it.

### L4 - Low - Manager's Today: a shop board slower than 4 seconds still throws the screen to the top
`docs/app.js` `show()` (`setTimeout(..., 4000)` clears `minHeight`). With the board answering after 5 s the position goes 491 px to 0. Fix: clear `minHeight` when the board has been filled (or after the board call ends), not on a timer.

### L5 - Low - Device card: time written in the phone's language
`docs/app.js` approvals, `askedAgainAt`: `toLocaleTimeString([])` instead of the app's own `timeOf()`. On a Marathi-language phone the card reads "repeated at १०:०० AM" (Hindi and English phones show "10:00 am"); it also uses the phone's time zone, every other time in the app is IST. Fix: `timeOf(d.askedAgainAt)`.

### L6 - Low - A row written in two pieces is not put back when the second piece fails
`store.js` `write()` + `gjGrid_.writeRow`: when the owner has added his own column in the middle of a tab, a changed row is two `setValues`. If the second fails, the row is not in `done`, so the first piece stays: "Approved" with empty `decidedBy`, no violation, no alert, and the retry answers "This request is not waiting for a decision." Needs a hand-added column and a Sheet failure. Fix: push the place to `done` before writing it (rolling back a row that was not written is harmless).

### L7 - Low - MonthSheet `result` damaged by hand: the locked month report cannot be shown
`views.js` `monthReport`: a person's `result` cell that no longer parses is returned as an empty entry (`people: [null, ...]`); the phone screen stays on "Loading". With the confirmation rows damaged too the action answers "Something went wrong". Noted in round 14 without a test; still open. Fix: skip a row whose `result` is not an object and list it under "damaged rows".

## Questions for the owner (not counted)

1. M3: should a kept photo be usable for the rest of the same day only (proposed), or not at all after some minutes?
2. L2: is "e-mail given up after about 20 minutes of Gmail trouble" acceptable, or should it keep trying for the day?
3. Round 14 questions 1, 2 and 4 are still open (manager approval of the owner's phone, alerting Aakash about it, two people on one phone). M3b depends on question 4.

## Not reproduced / needs the real deployment (NOT counted)

1. **Roll-back and the apostrophe.** `encode` stores `'=...` text with a leading apostrophe; the Sheet shows it without. The roll-back writes back the displayed text (`=...`) into a plain-text cell. Whether Apps Script `setValues` keeps that as text in a "@" cell, or makes a formula of it, must be tried on the TEST Sheet. Also: user text that itself starts with `'=`, `'+`, `'-`, `'@` or `''` would read back one apostrophe shorter from the Sheet than from the cache copy.
2. **How often a Sheets write fails between two tabs** (M1) or between two pieces of a row (L6): the reproducers inject the failure; the real rate is unknown.
3. **The app surviving the night on a phone** (M3a): reproduced with a browser clock; whether Android / iPhone keep the page alive that long depends on the phone.
4. **`resetOwnerPhones`**: read only. It still finds its columns with `indexOf` on untrimmed headers and does not take the script lock.
5. **Camera open + phone Back button, landscape with rotation lock, iPhone home-screen storage**: real phones needed (unchanged from round 14).
6. **UPGRADE answer during a check-in**: the photo is not kept (kept only for NET / SERVER / ERROR); by reading, not run against a real redeploy.
7. **A check-in whose final write fails**: the photo already uploaded to Drive is not moved to the bin (the removal covers only a refused action, not a failed flush); needs Drive.
