# GJ Leave – review round 3: concurrency, dates, data storage

Reviewed: `src/server/*.js`, `src/gas/main.js`, `src/rules/*.js` against the handoff PDF (Parts 3.3, 5, 6, 7).
Reproducers: `/home/claude/findings/repro-round3.test.js` – 17 tests, all FAIL on the current code
(`node --test /home/claude/findings/repro-round3.test.js`). The project's own 117 tests still pass; nothing in `/home/claude/gj-leave` was changed.

How overlapping requests are modelled in the reproducers: a `doPost` copy of `main.js` (cached grid + buffered store,
`withLock` = run, flush in `finally`). The hook `whileWaitingForLock` runs a second complete request at the moment the first one
asks for the lock, i.e. "the other phone got the lock first". No code of the app is replaced.

Counts: Critical 1, High 4, Medium 7, Low 2.

---

## Critical

### F1. The server lock does not protect anything when two requests overlap (stale cache version read before the lock)
- Where: `cachegrid.js` `loadVersions()` (version map read once per request and kept), `core.js authenticate` (first read, before the lock), `main.js withLock` (nothing is refreshed after `waitLock`).
- Interleaving:
  1. Request B starts. `authenticate` reads People, so B loads the version of every tab (LeaveRequests = v1).
  2. Request A (already in the lock) writes LeaveRequests and commits: version becomes v2. The copy under `d:LeaveRequests:v1` stays in CacheService for up to 10 minutes.
  3. B gets the lock and reads LeaveRequests for the first time, with its old map: key `d:LeaveRequests:v1`, a cache hit, the rows from before A's write.
  4. B runs every check on that old copy and, for updates, writes the whole row back from it (`store.update` writes all columns).
- The old key is almost always present: every reader stores it, and every writer stores the new content under the new version.
- Everyday case: Aakash taps Approve on two requests one after the other. One call takes about 2.5 s, so the second starts before the first has committed.
- Impact (each one reproduced):
  - two clashing leave requests both auto-approved – `F1a`
  - two clashing approvals both Approved, no "Rejected – clash" (Part 3.3 and Part 7) – `F1b`
  - staff cancels, Aakash's overlapping approve writes Approved over Cancelled – `F1c`
  - special leave: Aakash's "yes" is overwritten by Varun's row, request stays "Special – waiting" – `F1d`
  - the same applies to every locked action: overlap check, emergency number, quota, grace count, month lock, going out, late/early.
- Fix: after `lock.waitLock()` throw away everything read so far: clear the store's per-tab cache (rows, headers) and set `versions = null; readAt = {}` in the cache grid, then run the action. Simplest form: for every writing action take the lock first and build `ctx.db` inside it (authenticate inside the lock). Second line of defence: make `store.update` write only the changed cells, not the whole row.

## High

### F2. Check-in stored twice, late minutes counted twice
- Where: `api.js checkIn` reads Punches before the lock and before the photo upload (seconds); `attendance.js checkIn` re-checks inside the lock on the same request-local copy. Fails on the plain Sheet store, no cache involved.
- Interleaving: request 2 for the same person passes the pre-check while request 1 is still uploading / waiting; both then insert.
- Needs the same check-in sent twice (retry after a hang, second tab, reload). The button guard in `docs/app.js` stops a plain double tap only.
- Impact: 2 "in" punches, 2 DayMinutes rows (50 min late becomes 100 min: bank used twice, two not-informed counts, possible violation), 2 photos in Drive.
- Fix: same as F1 (reload after the lock); drop the pre-lock check or repeat it on fresh data.
- Test: `F2 the same check-in sent twice ...`

### F3. `remindBack` writes without the lock and undoes Aakash's confirmation
- Where: `attendance.js remindBack` (no `withLock`); its Outings update goes out in the final un-locked `ctx.db.flush()` of `doPost`, as a whole row from the copy read earlier.
- Interleaving: Neha taps Remind (reads status "Back") → Aakash's `confirmBack` runs and commits "Confirmed" → Neha's request flushes: row written back with status "Back".
- Impact: confirmation (and `confirmedAt/By`, corrected back time) lost; the outing is back in Aakash's list. This is exactly the moment both act on the same row.
- Fix: put `remindBack` inside `withLock`; no action may write outside the lock (see N1).
- Test: `F3 staff taps "Remind" while Aakash confirms ...`

### F5. One bad e-mail address: people before it are mailed every 5 minutes, people after it never
- Where: `jobs.js sendEmails` (no try/catch per person), `main.js gjJob_` (`run()` then `flush()`, no `finally`).
- Input: one People row whose `email` makes `MailApp.sendEmail` throw (typo, space, missing @). Also any failure half-way.
- Impact: the run stops; the buffered `emailedAt` marks of people already mailed in this run are never written, so they get the same digest again on every run (12 per hour) until the daily quota is gone; everyone after the bad address gets nothing.
- Fix: try/catch around each `send`; mark a failing address (for example `emailedAt = -2` after 3 tries) and tell the owner; flush in `finally`; flush after each person.
- Test: `F5 one bad e-mail address ...` (3 runs: A mailed 3 times, C 0 times)

### F8. Renaming a person silently switches off their clash rules and restrictions
- Where: `Rules.members`, `Rules.emergencyIfAllPresent`, `Restrictions.appliesTo` hold names; `admin.js savePerson` lets the owner change the name and updates nothing else.
- Input: owner corrects "Bhawna" to "Bhavna" in Settings.
- Impact: rule C2 no longer contains her; Pooja and Bhavna are both auto-approved for the same day. No error anywhere.
- Fix: store person ids in rules and restrictions (names only for display), or rewrite the name in Rules/Restrictions in the same locked action.
- Test: `F8 the owner corrects the spelling of a name ...`

## Medium

### F4. Two approved phones for one person
- Where: `core.js authenticate` reads Devices before the lock; `decideDeviceLocked` decides on that copy.
- Interleaving: two pending phone requests of one person, the owner's two Approve calls overlap. The second still sees the first as "pending", so it does not revoke it.
- Impact: "one phone per person" broken; both phones can check in for that person.
- Fix: F1 fix. Test: `F4 two phone requests ...`

### F6. A failed action is half saved (flush in `finally`)
- Where: `main.js withLock` flushes buffered writes also after an exception; `attendance.js decideDress` writes `dressDecision` and only then calls `recordIncident`, which can refuse.
- Input: the manager's own check-in gets a dress flag (dress check runs for every non-exempt person); Varun taps Confirm. `recordIncident` answers "Choose a staff member."
- Impact: error on screen, but `dressDecision = confirmed` is saved and the item disappears; no incident exists. Same if the "dress" item is removed from the grace table.
- Fix: run all checks before the first write; or on an exception discard the buffer except writes the action marks as "keep" (wrong-PIN counter). Skip the dress check for non-staff.
- Test: `F6 dress check of a non-staff person ...`

### F7. `flush()` is not safe to run twice after a failure: duplicate rows
- Where: `store.js flush` clears `pending` only after all appends succeeded, and per tab only when the loop reaches it; `appendMany` in `main.js` writes tab after tab with no rollback; `doPost` flushes again after the lock.
- Input used: a reject reason of 50,001 characters (Sheets refuses cells above 50,000; no text field has a length limit: `reasonText`, decision reason, dispute text, notes). Any Sheets error between two tabs does the same.
- Impact: Audit written, Notifications fails, the second flush appends Audit again and fails again: 2 "leave.decide" audit rows for a request that is still Pending; `doPost` crashes with no JSON reply. With a failure in `writeRow` instead, already appended Audit/Notifications rows are appended a second time (duplicate ids, duplicate e-mails).
- Fix: clear `pending` of each tab as soon as its append succeeded (have `appendMany` report progress); wrap the final flush; limit text lengths in `api.js` (for example 1,000 characters).
- Test: `F7 a write that fails half-way ...`

### F9. Shop-closed day added later is not re-counted (Part 6)
- Where: `closedDays` is read only in `attendance.js endOfDay`. `evaluate`, `monthQuota`, `myMonth` ignore it.
- Impact: an approved leave on a day later marked closed still uses 1 of the 5 free leaves and can produce a "would be deducted" line.
- Fix: drop closed days from the counted days in `myMonth` and `evaluate`.
- Test: `F9 a shop-closed day added later ...`

### F10. Leave across month end: routing checks the quota of the first month only
- Where: `core.js evaluate` (`month = monthKey(dates[0])`; the comment admits it).
- Input: Neha already at 5 in December; request 30 Nov + 1 Dec.
- Impact: auto-approved; the same 1 Dec alone goes to Aakash ("Above the 5 free leaves"). The warning line is missing too.
- Fix: compute the quota for every month the dates touch and use the worst.
- Test: `F10 30 Nov + 1 Dec ...`

### F12. `endOfDay` has no time check
- Where: `jobs.js endOfDay` / `attendance.js endOfDay` use `today` whenever they run.
- Input: `jobEndOfDay` run from the editor in the morning, or a re-run / late trigger.
- Impact: at 08:00 all 9 staff are "Absent – unannounced" with 8 violations and notifications; later check-ins do not remove them. Also the reverse: a run after midnight checks the new day, the old day is never checked.
- Fix: refuse before the last duty end of the day (or before 20:30 IST); let the job take the date to close and remember the last closed date in Settings.
- Test: `F12 endOfDay run before closing time ...`

### F13. No protection against the same request stored twice
- Where: no request id anywhere (`docs/app.js` `fetch` has no id, no timeout). Leave, going out, late/early are covered by their state checks (once F1 is fixed); `recordIncident`, `addCorrection`, new `saveRestriction`, new `saveRule` are not.
- Input: Aakash records an incident, the reply is slow, he sends it again.
- Impact: second incident, count 2, above grace 1: a violation from a retry.
- Fix: the phone sends a random `requestId`; the server stores it (Audit) and inside the lock returns the first result for a repeated id.
- Test: `F13 the same incident sent twice ...`

## Low

### F11. Dates are checked by shape only
- `2027-02-30` passes `/^\d{4}-\d{2}-\d{2}$/` and is stored and auto-approved; it counts in February's quota. Same in `requestShort` (`a.date` not checked at all), `saveRestriction`, and times like `10:75`.
- Fix: accept a date only if `Cal.addDays(d, 0) === d`; hours < 24, minutes < 60.
- Test: `F11 a date that does not exist ...`

### F14. Key column taken by position, upgrade says "up to date"
- `store.update` uses `t.headers[0]` as the key. With a column added on the left of a tab, `setupOrUpgrade` reports nothing and every update on that tab fails with a generic error, while inserts keep working.
- Fix: find the key column by name (`Schema.TABS[tab][0]`); let setup report a tab whose first header is not the key.
- Test: `F14 a column added on the left ...`

---

## Races not unit-tested (exact interleaving)

- **N1. Un-locked appends can overwrite each other's row.** `gjGrid_.appendMany` does `getLastRow()` and then `setValues`. Writers outside the lock: the final flush of `doPost` (Thumbs row after every check-in, everything `remindBack` writes), `Jobs.endOfDay` (daily summary and missing-check-out notifications are created after `Att.endOfDay` released the lock), `sendEmails`. Interleaving: U reads last row = N; L (in the lock, or another un-locked run) reads last row = N; both write row N+1. One row is lost (a thumbnail at the morning rush; a notification). The store also gives the loser a `__row` that now holds another row. Fix: no write outside the lock; make the final flush take the lock when something is pending.
- **N2. Overlapping `sendEmails` runs** (no lock, sending is slow): both read the same un-mailed notifications and both send. Fix: run the job under the lock or mark before sending.
- **N3. `commit()` version bump can fail silently** (`putAll` in try/catch). Then the old version stays current and the old copy is served for up to 10 minutes, also inside the lock. Fix: on a failed bump, fall back to "no cache" for this deployment (for example a flag in script properties) or retry.
- **N4. Writer caches its own copy while an un-locked writer appended in between** (L reads tab in lock, U appends, L commits "untouched" and stores a copy without U's row, U commits and retires it). Window is milliseconds; disappears with N1's fix.
- **N5. Lock wait is 25 s, one locked call is 3 to 12 s.** With several check-ins at once the later ones time out with "Something went wrong"; the photo is already in Drive (orphan) and the person retries (see F2).

## Not verified here (needs the TEST Sheet)

- Text that starts with `=`, `+` or `'` written by `setValues` into plain-text cells (reason, note, name, phone "+91…"): check that it comes back unchanged from `getDisplayValues`.
- `setupOrUpgrade` sets plain-text format only on tabs it creates. A tab that already existed, or columns beyond the 40 formatted ones, may turn `2026-11-25` / `09:30` into dates.

## Checked by reading, no bug found

- Date maths: `calendar.js` (UTC only), `toMs`, `today`, `nowMin`, `istMin`, `timeOf`; nth Sunday, 5th Sunday, leap years, 31-day months, December to January, quarter key.
- Text round trip of `0`, `false`, `''`, `-1`, JSON `null` (`pinTries`, `informed`, `statedMinutes`, `minutes`, `emailedAt`).
- Row positions: blank rows in the middle of a tab keep `__row` right; rows inserted and updated in one request; `tail()`.
- Run twice: `setup`, `endOfDay` (same evening), reminders, warnings, evening reminder (all keyed, and the timed jobs read inside the lock, so F1 does not hit them).
