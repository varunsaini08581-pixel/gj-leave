# Round 6 review: upgrade and deploy safety

Reviewer: independent (did not write the code). State reviewed: `/home/claude/gj-leave` as it stood at 18:23 IST, 20 Nov 2026.
Reproducers: `/home/claude/findings/repro-round6.test.js` (27 tests, all 27 fail on the current code, each for the reason in its name and message).
Run: `node --test /home/claude/findings/repro-round6.test.js`

## Counts

| Severity | Findings | Tests |
|---|---|---|
| Critical | 0 | - |
| High | 3 | H1a-e, H2a-b, H3a-b |
| Medium | 9 | M1, M2, M3a-c, M4a-d, M5, M6, M7, M8, M9 |
| Low | 4 | L1-L4 |

No Critical: I found no path where a normal deploy step, done as written, loses or corrupts data. The three High findings each need one wrong or skipped step (setup not run, a hand edit in the Sheet, a change after the lock), and none of them is stopped or reported by the code.

## Two things to know first

1. **The repository changed while I was reviewing** (source files at 18:15, generated files at 18:21, month lock by two people appeared mid-review). Every test was re-run at 18:23 against the then-current code.
2. **I changed two generated files by accident.** I ran the repo's own `node --test` twice (18:13 and 18:15) to get a baseline. `test/store-api.test.js` runs `tools/build.js`, which rewrites `apps-script/Code.js` and `docs/mock-server.js` from whatever is in `src/` at that moment. So those two files were regenerated from the working tree, once while it was mid-edit (2 tests were failing at 18:15). They were rebuilt again by someone else at 18:21. No source file was touched, no git command was run. This is also a finding in itself (see "Observations without a test", item 1).

---

## High

### H1. New code on a Sheet that was not upgraded: check-in dead, PIN lock off, data silently dropped; `SCHEMA_VERSION` does nothing

- **Where**: `store.js` `insert` (drops fields whose column is missing, no error), `update` (throws a plain `Error` for a missing column), `setup` (writes `schemaVersion` only if the key is absent); `api.js handle` (no schema check); `core.js loginLocked`.
- **How it happens**: the owner pastes the new `Code.js`, presses New version, and forgets `setupOrUpgrade` (nothing tells him when the schema changed). Sheet as version 1 made it: no `Thumbs` tab, no `People.pinLockLevel`, no `Devices.pinTries / pinLockedUntil`, no `LeaveRequests.override / remindedAt`, no `Punches.thumbId`, no `DayMinutes.shortId`.
- **Result (reproduced)**:
  - Every check-in answers "Something went wrong". The photo is already in Drive each time (orphan file per attempt). (H1c)
  - The 5th wrong PIN crashes on `pinLockLevel`, the crash is not a "keep" error, so the count is thrown away. `pinTries` stays at 4 for ever: no lock, unlimited guessing. (H1a)
  - Anyone with one earlier wrong PIN cannot sign in with the right PIN (same crash). The reply differs from a wrong PIN (`ERROR` instead of `LOGIN`), so a guesser learns the PIN was right. (H1b)
  - Varun's override is answered "Approved" but the written reason is not stored; the month report will not list it. Same silent drop for `shortId` (a late arrival approved later is never corrected) and `thumbId`. (H1d)
  - After the upgrade, a Sheet whose `Settings.schemaVersion` said 1 still says 1. No code reads the value. (H1e)
- **Fix**: `setup` writes the current version every time; `handle` (and the timed jobs) compare it once per request and answer a coded error such as "The Sheet needs setupOrUpgrade" before doing anything; `insert` throws on an unknown column instead of dropping it. Better: run `setup` automatically inside the lock when the stored version is lower.

### H2. A structural hand edit in the Sheet while the cache is warm corrupts rows

- **Where**: `cachegrid.js` (tab data cached 10 min under `d:`, header rows cached 6 hours under `h:`), `store.js write` (`writeRow(tab, r.__row, ...)` with the cached row index and cached header order).
- **Result (reproduced)**:
  - H2a: the owner inserts one column in `LeaveRequests`. The next request writes its row in the old column order: Vikas is told "Approved", the Sheet row has `status = {}` and `kind = ["2026-11-28"]`. `Audit` and `Notifications` are written shifted for up to 6 hours (they are never read in full, so only the `h:` entry is used).
  - H2b: the owner deletes one row (or sorts the tab). The next approval writes Manish's row over Harsh's request. Harsh's request is gone; Manish's exists twice.
- **Why High and not Critical**: the owner page says not to edit or delete by hand. But the stated consequence is "a change can take 10 minutes to show", not "another person's record is overwritten", and the project log shows rows being cleared by hand on TEST. A sort on `People` would overwrite one person's PIN hash with another's on the next wrong PIN.
- **Fix**: before every `writeRow`, read the key cell of that row from the Sheet (one small read inside the lock) and refuse on mismatch; store headers with the data version, not for 6 hours; compare the cached header row with the live one inside the lock before the first write of a request. Tell the owner the real consequence.

### H3. A locked month still accepts changes, and the staff member's own page for it is recalculated live

- **Where**: only `core.js evaluate` checks the lock. `cancelLeave`, `decideLeave`, `manualCheckOut`, `recordIncident`, `overrideLeave`, `setSetting(closedDays)`, `excuseAbsence`, `decideShort`, `confirmBack`, `decideDispute` do not. `api.js myMonth` always calls `Att.myMonth` (live), never the locked row.
- **Result (reproduced)**: October locked by Aakash and Varun on 2 Nov. On 3 Nov all six tried actions on October data were accepted (H3a): a check-out entered by hand (new minutes and a new violation dated 13 Oct), a cancelled leave, a rejected request (which creates "Absent – unannounced" plus a violation in October), an incident, an override leave, a closed day. Locked report for Neha: 4 leaves, 0 violations. Her own "My month" for October: 4.5 leaves, 2 violations (H3b). A salary change also moves her October estimate.
- **Spec**: 3.11 "after the lock, corrections are new logged entries".
- **Fix**: one helper `assertMonthOpen(ctx, date)` called by every action that writes a dated row; `myMonth` returns the locked row when the month is locked (plus corrections).

---

## Medium

### M1. One damaged JSON cell takes most of the app down for everyone
- `store.decode` returns `null` for unparsable JSON; callers do `r.dates.forEach / indexOf`, `r.history.concat`.
- Reproduced: the owner retypes one date in `LeaveRequests.dates` (`2026-11-28` instead of `["2026-11-28"]`). `submitLeave` (for another person), `myMonth`, `board`, `calendar`, `monthReport` all answer "Something went wrong"; the `endOfDay` and `hourly` jobs throw, so no absent check and no reminders.
- Fix: validate rows on load (skip and report a bad row), or guard the JSON columns with defaults (`[]`, `{}`).

### M2. Unexpected server errors are logged nowhere
- `api.js handle` catches everything and returns a generic message. Nothing goes to `console.error`. A caught exception is not recorded by Apps Script either.
- After a deploy, "Something went wrong" (H1, M1) cannot be diagnosed by anyone.
- Fix: `console.error(action, e.stack)` in the catch, and return a short reference id.

### M3. `setup` is not safe against a damaged header row or a missing tab
- M3a: a header typed as `status ` (trailing space) is treated as missing. Setup adds a second, empty `status` column; every old leave then reads with status "". No warning.
- M3b: a cleared header row: setup writes all headers to the right of the existing data (`["", "", ... , "id", "name", ...]`). The app then sees 0 people. On the real Sheet this would also run past column 40 for `LeaveRequests` (see hand list 2).
- M3c: a renamed or deleted tab on a Sheet in use is silently recreated empty ("created People"). Without setup the live app also reads a missing tab as empty: a missing `MonthSheet` unlocks every month, a missing `Devices` signs everyone out and re-opens the owner bootstrap.
- Running setup twice or after a half-finished run is fine (checked: second run does nothing, a tab created without headers gets them on the next run). Setup never deletes or reorders data.
- Fix: trim headers before comparing; refuse when row 1 is blank but data exists; when `Settings.schemaVersion` exists, treat a missing tab as damage and stop with a clear message.

### M4. The version gate cannot do its job; client and server can be out of step with no message
- M4a: `MIN_CLIENT_VERSION` and `CLIENT_VERSION` are both 1 and have never moved, although `checkIn` changed shape (photo required) and sign-out storage changed. An app from before the photo check-in gets "Take the check-in photo first" for ever, never "update". Only TEST phones are affected today; after release the same will happen at the first shape change, because nothing in `tools/ship.py` or the recipe bumps the numbers.
- M4b: the app's version is in `config.js`, not in `app.js`. A fresh `config.js` with a cached old `app.js` passes the gate. The five `<script src>` tags have no version in the address; there is no service worker. Freshness depends on the browser's HTTP cache alone.
- M4c: on `UPDATE` the app calls `location.reload()` with no guard and no message. With the same cached files it reloads again: 4 boots, 4 reloads, 4 server calls in the test, and it goes on. (Noted as design risk D6 in round 2; still open.)
- M4d: the reverse direction happens at every release: `git push` updates the phone app at once, the server changes only when the owner presses New version. No reply carries a server version and `app.js` has no handling for `UNKNOWN`, so staff see a bare "Unknown action." until then.
- Fix: one build number, written by `build.js` into `Code.js`, `app.js` and the script addresses (`app.js?v=N`); server returns its build in `me`/`names`; on `UPDATE` show "Close and reopen the app" after one failed reload; on `UNKNOWN` show "The server is being updated".

### M5. If `config.js` does not load, production silently becomes demo mode
- `docs/app.js:5`: `DEMO = !CFG.API_URL || ...`. With `window.GJ_CONFIG` missing (a failed request, a broken edit of `config.js` at release) the app loads `mock-server.js`: sample people, every PIN 1234, nothing saved. The demo notice is on the sign-in screen only.
- Related: `?demo=1` works on the production address, and `mock-server.js` (182 KB) is published with the site. That is by design, but there is no demo marker after sign-in.
- Fix: demo only with `?demo=1`; a missing `API_URL` is an error screen; a fixed "DEMO" bar on every screen.

### M6. A missed 21:00 job is never caught up
- `jobs.js endOfDay` looks only at today. If the trigger fails one night (Google-side failure, quota, timers removed), that day's "absent with no request" rows and violations are never created.
- Reproduced: nobody checks in on 24 Nov, job runs on 25 Nov: absent rows exist for 25 Nov only.
- Fix: keep `lastAbsentCheck` in Settings and process every day since then.

### M7. After about a month the cache stops working for the growing tabs
- `cachegrid.js MAX_CHARS = 95000`. With 9 staff the `Punches` tab passed that on day 36 in the test (short test ids; real ids are longer, so sooner). From then on every screen that reads `Punches` reads the whole tab from the Sheet on every call: 3 identical "Today" calls = 3 Sheet reads. `Notifications`, `DayMinutes`, `LeaveRequests`, `Violations` follow. The read gets slower as the tab grows; nothing archives.
- Effect: the speed in the owner page (2-3 s) is true for the first weeks only. It is a slow-down, not a failure: when the value is too big the code falls back to the Sheet correctly (also when `put` throws).
- Fix: cache in chunks, or cache only the current month's rows, or split big tabs by month.

### M8. A person who left before the lock is missing from the locked month
- `views.js lockMonth` and `monthReport` use active staff at lock time. Raunak works all of October, is made inactive on 1 Nov, October is locked on 2 Nov: 8 people in the locked report, no Raunak, and it cannot be added later.
- Related to the open item "joining / leaving dates per person", but this is a data gap in the lock, not a rule question.
- Fix: include everyone who has any row in that month.

### M9. A violation from a check-out entered later can never be disputed
- `attendance.js manualCheckOut` runs `checkOut` with `now` = the entered leaving time, so the violation's `createdAt` is in the past. `disputeViolation` counts 24 hours from `createdAt`.
- Reproduced: check-out for 24 Nov entered on 26 Nov; five minutes later the dispute is refused: "The 24-hour dispute window has passed."
- Fix: `createdAt` = real server time; keep the event time in `date`.

---

## Low

- **L1. `photo` with an empty id returns a colleague's full photo.** `api.js photo` matches `x.thumbId === a.id`; rows written before the `thumbId` column have it blank. On the day of the upgrade, `photo {id: ""}` gives a staff member the full photo of the first such check-in of today. Fix: refuse an empty id.
- **L2. `lockMonth` accepts any text as the month.** `"2026-1"`, `""`, `"2026-13"`, `"2026-11 "` are each locked: 40 permanent junk rows in the test. (Round 2 D8, still open.) Fix: `/^\d{4}-(0[1-9]|1[0-2])$/`.
- **L3. Values typed by hand are read as blank.** `"17,000"` salary reads as "" (no estimate shown), `" TRUE"` reads as false (person inactive), `every` without quotes reads as no Sunday roster (Anita would be marked absent every Sunday). Fix: trim, strip thousands separators, accept the bare word; or refuse loudly.
- **L4. An update rewrites the whole row, including columns the app does not own.** A formula in the owner's extra column becomes fixed text; extra columns with blank headers copy each other's value. Fix: write only the schema columns that changed.

---

## Needs the real Sheet (not reproducible in Node): exact steps

1. **Leading apostrophe.** In `Settings`, set the shop point to a negative longitude through the app (or type a reason starting with `-` or `=`). Open the Sheet: the cell should show the text without a visible `'`. Read it back in the app: unchanged. Then type a reason starting with `'=`: check what comes back.
2. **A tab with no spare columns.** In a copy of the Sheet, delete the empty columns to the right of `LeaveRequests`. Remove the `remindedAt` header cell, run `setupOrUpgrade`. Expected by reading: `getRange` fails ("outside the dimensions"), setup stops half-way, tabs after it are not upgraded, a second run fails at the same place. `writeRow` never adds columns.
3. **Photo folder in the bin.** Move "GJ Leave - check-in photos (private)" to the bin, then check in. `gjPhotoFolder_` only recreates the folder when `getFolderById` throws, and it does not throw for a binned folder. Expected: photos go into the binned folder and are deleted by Google after 30 days.
4. **Drive full.** With the owner's Drive at its limit, check in. Expected: "Something went wrong" for every check-in (the save runs before the lock); only Aakash's manual check-in works. Confirm, and decide whether a check-in without photo (flagged) is wanted then.
5. **Thumbs growth.** Each check-in adds a cell of up to 45,000 characters and nothing is ever removed (only today's are shown). About 10 a day: estimate 30 to 75 MB of cell text a year. After a few hundred rows: time one `photo` call (it reads the last 80 rows, up to 3.2 MB) and open the Sheet in a browser.
6. **Morning rush.** Five phones check in within the same 5 seconds once `Punches` is past the cache size (M7). Watch for "Something went wrong" from the 25-second lock wait.
7. **Column format changed by hand.** Format `Punches.date` as Date, or `DayMinutes.minutes` as Number with separators. Check what `getDisplayValues` returns (`25/11/2026`, `1,234`) and whether "My month" still counts those rows.
8. **Check-boxes.** Turn `People.active` into check-boxes for the whole column. Add a person in the app: expected to land below the last check-box row, and the blank check-box rows to be read as people with no id.
9. **Script time zone.** Change the project time zone to another zone and call `today`. By reading, nothing depends on it (all date maths use a fixed IST offset, the daily timers pass `Asia/Kolkata`); only `appsscript.json` sets it and that file is not part of the paste recipe.
10. **Deploy order.** Run `setupOrUpgrade` from the editor before pressing New version and use the live app in between: the old deployed code then runs on the upgraded Sheet (by reading: safe, columns are found by name).
11. **Phone cache.** After a `git push`, open the installed app on a phone that was left open overnight. Note how long it keeps the old `app.js` (GitHub Pages allows 10 minutes of browser cache; an open page is not reloaded at all).
12. **Mail quota.** Count the emails of one busy day. Aakash gets one digest per 5-minute window in which anything happened; the limit is about 100 a day for the whole app. By reading, running out is handled (it retries on the next run).

## Observations without a test (not counted above)

1. **Running the tests rewrites shipped files.** `test/store-api.test.js` runs `tools/build.js`, so `node --test` regenerates `apps-script/Code.js` and `docs/mock-server.js` from the working tree, also when the tree is half-edited.
2. **`tools/ship.py` does not check the push.** The result of `git push` is captured and ignored; the script still prints a status line and makes the zip. A failed push means the phone app is not updated and nobody is told. The zip number is counted from files in `/home/claude`, so it restarts at 01 in a new session.
3. **`git add -A` publishes everything in the folder to the public repo**: `PROGRESS.md` (internal decisions, staff names), `reviews/` (attack descriptions against the live TEST address, including design risks still open) and six screenshots (about 800 KB, also in every backup zip). No secret found in the current tree: only the TEST web-app address, which must be public. Older commits still hold what was "removed from this log".
4. **The bundle has no build stamp.** Header says `v0.1.0` for every build; `doGet` returns no version. The owner cannot check which code is in the editor or live.
5. **Rollback is described for the server only.** The owner page says to pick an older version in Manage deployments. That works for the server (old code finds columns by name, so extra columns do not hurt), but the phone app always serves the newest commit, so a rolled-back server meets a newer app (M4d). There is no README; the redeploy recipe exists only in `PROGRESS.md`, and it does not say when `setupOrUpgrade` is needed.

## Checked, no bug found

- **Bundle**: loaded `apps-script/Code.js` in a Node `vm` with stub Google services (Sheet with row and column limits, cache with a 100 KB limit, lock, Drive, mail, triggers). `setupOrUpgrade` twice (19 steps, then 0), `doPost` for `names`, `login` (owner bootstrap, staff pending), `decideDevice`, `checkIn` with photo, `today`, `todayAtGJ`, `submitLeave`, `monthReport`, `setShopPoint` with negative coordinates, all four jobs, `installTriggers` twice (4 timers both times). Module order in `tools/build.js` is right; nothing is missing from the bundle.
- **Old rows under new code after setup**: blank new columns (`pinLockLevel`, phone counters, `shortId`, `createdBy`, `remindedAt`, `override`) read as empty and behave; `penaltyEmergency` on a pending or rejected old row is ignored in the quota; old values starting with `-` or `+` without the apostrophe read unchanged.
- **Year change**: a leave over 31 Dec / 1 Jan counts 1 day in each month; December can be locked in January and January cannot; nth-Sunday and month keys are plain string and UTC maths.
- **Blank rows in the middle of a tab** keep row positions right; **tabs beyond 1,000 rows** grow by 500 as plain text; a **cache value over the limit** falls back to the Sheet.
- **Sign-out change**: an old stored session (token inside `gjleave.session`) still signs in under the new app.

## Summary

Critical 0, High 3, Medium 9, Low 4.

- **H1**: new code on a Sheet without `setupOrUpgrade`: check-in fails for everyone, the PIN lock never engages, override reasons are dropped; `SCHEMA_VERSION` is written once and never read.
- **H2**: a column inserted or a row deleted by hand while the cache is warm makes the app write shifted rows or overwrite another person's record.
- **H3**: a locked month accepts cancels, rejections, hand check-outs, incidents and overrides, and the staff member's page for that month no longer matches the locked report.
- **M1/M2**: one bad JSON cell breaks most screens and both nightly jobs, and no unexpected error is logged anywhere.
- **M4/M5**: the version gate has never moved and lives in `config.js`; `UPDATE` reloads in a loop; a missing `config.js` turns production into demo mode.
