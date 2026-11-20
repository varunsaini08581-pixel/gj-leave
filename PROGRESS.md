# GJ Leave & Attendance - PROGRESS

Separate app. Not part of GJ App / stock system. Nothing of that system is opened, reused or changed.

## Owner decisions (20 Nov 2026)
- Violation ladder: version A. 1st = record only, 2nd = Rs 500 discipline bonus + target allowance would be lost, 3rd = notice. Manual violations by Aakash use the same ladder.
- Stack confirmed: PWA on GitHub Pages (public repo) + Apps Script + new Google Sheet.
- Names: repo `gj-leave`, Sheet "GJ Leave" (test copy: "GJ Leave - TEST").
- PIN delivery: WhatsApp click-to-chat link, pre-filled on the owner's phone; he presses Send.
- Reminder to Aakash for a pending request: every 2 hours.
- Half day = any 4 h 30 min; the staff member picks the start time.
- Notifications: email + in-app only. No push, no Firebase, no SMS.

## Log
### 20 Nov 2026
- Read the full 18-page handoff. Sent time estimate, questions, permissions, precautions and the visual plan PDF.
- Owner answered and said start.
- Checked access: Drive folder "GJ Software Backups" writable; one Windows Chrome connected; GitHub session can only see `gj-stock-app` and `gj-quote`.
- Tried to create repo `gj-leave` myself: NOT possible (session is bound to existing repos). Owner must create it and give access.
- Project scaffolded locally (`src/rules`, `test`, `web`, `apps-script`).
- Built the short-leave engine `src/rules/minutes.js`: 2-hour bank, 10-min grace, going-out 15-min rule, half-day cut-off, not-informed passes, >30 min rule, extra-2-hours rule, ladder A, per-minute rate.
- Tests: 13 of 13 pass, including the owner's six worked examples (exact match).

### 20 Nov 2026, 16:00 - owner answers
- A "not informed, more than 30 min" late = immediate violation and is NOT counted in the pass counter. Confirmed.
- "Every extra 2 hours beyond the bank = 1 violation" counts informed minutes only. Confirmed.
- Clash rules are counted PER DAY: if one person is away for any part of a day, the other person in the rule cannot be away that day at all (owner example: Bhawna 1 hour late in the morning, Pooja cannot leave early the same evening).
- Away 2 h to 4 h 30 min = half day; more than 4 h 30 min = full day. Confirmed.
- Built `calendar.js` (nth Sunday, roster), `clash.js` (C1, C1-Sun, C1-E, C2, C3, C4 as data, per-day), `leave.js` (notice type, month quota with roster Sundays, Anita, run length, who decides).
- Tests: 27 of 27 pass.

### 20 Nov 2026, 16:03 - owner answer
- Emergencies: the 3rd, 4th, 5th... in a month EACH give +1 violation plus 1 extra day's leave cut (estimate).
- Built `emergencyPenalty` and `checkRestrictions` (no-leave / allowed-with-penalty, applies-to list, default excludes Anita and Muskan).
- Sent the owner the steps to create repo `gj-leave` and give Claude access.
- Tests: 29 of 29 pass.

### 20 Nov 2026, 16:08 - owner answers
- 3rd/4th/5th emergency: it is a violation, so it is NOT counted as a free leave. +1 violation and that day's salary is cut (1 day), whether or not the person is inside the 5. Rewrote `monthQuota` (penaltyEmergency days) and `emergencyStatus`.
- Restricted period of the "allowed" kind: leave there = +1 violation. No money penalty at all. Rule renamed from 'penalty' to 'violation'.
- Owner created repo `gj-leave` and gave access.

### 20 Nov 2026, 16:22 - owner answers + backend core
- Restricted period (violation kind): 1 violation per leave request, even for 2 days. Confirmed.
- Owner wants near-continuous work. Told him plainly: work happens only inside runs; runs are chained with scheduled wake-ups. Revised estimate: first working version on the test Sheet by Sat 21 Nov evening; "ready" Mon 23 night or Tue 24 Nov.
- Code pushed to GitHub `varunsaini08581-pixel/gj-leave` (branch main).
- Built `src/server/schema.js` (13 tabs; added Devices and Notifications to the handoff list as implementation tabs).
- Built `src/server/core.js`: PIN (salted hash, 5 wrong tries = 15 min lock), phone binding (owner approves, one phone per person, new phone revokes old), authenticate, leave preview / submit / decide / cancel, server lock, re-check at approval ("Rejected - clash"), special approval (Aakash AND Varun), auto violations (unannounced, emergency beyond 2, restricted period), audit and notification rows.
- Tests: 45 of 45 pass (rules + server).

### 20 Nov 2026, 16:30 run - Sheet store, API, Apps Script bundle
- `src/server/store.js`: Sheet store over a small grid interface. Every cell is plain text (dates and times never auto-convert); numbers, booleans and JSON are restored on read. `setup` creates missing tabs / adds missing columns, never removes anything, safe to run twice (tested).
- `src/server/api.js`: single dispatcher, version gate (old cached app is refused), explicit field lists per reply. Reason of a leave is visible only to the applicant, Aakash and Varun.
- `src/gas/main.js`: Apps Script glue (SpreadsheetApp grid, SHA-256, LockService, doPost/doGet, `setupOrUpgrade`). Not runnable in Node; kept thin on purpose. First real run happens on the test Sheet.
- `tools/build.js` bundles everything into `apps-script/Code.js`; a test loads the bundle in a sandbox and runs setup + a call.
- Privacy test: no reply to a staff member contains salary, PIN hash, token hash or another person's reason.
- Tests: 53 of 53 pass.

### 20 Nov 2026, 16:35 run - attendance
- `src/server/attendance.js`: informed late / early requests, check-in / check-out (server time, late and early minutes worked out automatically, half-day aware), going out (request, Aakash approves, I'm back, confirm, correct back time with log, remind), month calculation, violation sync into the Violations tab (never deletes; a dropped one is marked removed), "My month" data with the working lines and the estimate label, end-of-day absent job, humanitarian excuse.
- Check-in distance from the shop point (flag above 50 m; flag when no location). Photo, stamp and dress check come later (Phase 5).
- New tabs: ShortRequests, Outings.
- Karan example verified end to end through real check-ins: Rs 126, 1 violation, record only.
- Tests: 70 of 70 pass.

### 20 Nov 2026, 16:45 run - phone app (first screens) + demo mode
- `docs/` (served by GitHub Pages): `index.html`, `styles.css`, `app.js`, `config.js`, `manifest.json`, `icon.svg`. Screens: sign in, Today (check-in/out, going out, late/early), Apply (live result before Send, my requests, cancel), My month (leaves, 2-hour bank, violations, estimate), Approvals (leaves, going out, back confirm with time correction, unannounced absences, new phones), More (owner: create PIN shown once + WhatsApp link; sign out).
- DEMO mode: while `config.js` has no API_URL the app runs the SAME server modules inside the phone on sample data (every PIN 1234, nothing saved). Lets the owner see the screens before the Apps Script deploy.
- Checked in a 390x844 phone viewport with Playwright (`tools/ui-check.py`): sign in, phone approval, check-in, apply (auto-approved), my month, emergency request, Aakash approval. 0 console errors.
- Found by that check and fixed: an uninformed very late arrival turned into a half/full day and lost its violation. Now the "not informed, more than 30 min" violation stays. Test added.
- Folder is `docs/` (not `web/`) because GitHub Pages serves only the root or `/docs` from a branch.
- Tests: 72 of 72 pass.

### 20 Nov 2026, 17:00 - first real deploy (TEST)
- Owner corrections: (1) late/early requests MUST be approved by Aakash (staff can send; Aakash approves) - NOT YET CODED, currently no approval; asked the owner what happens if Aakash has not decided before the person arrives (proposal: approved later = informed, rejected = not informed). (2) Left before the stated early time = those minutes not informed: confirmed. (3) More than 2 hours away = half day in quota only: confirmed; told him the uninformed-over-30 violation still applies on such a day.
- Owner: if the Fable limit runs out, continue on Opus 5.5; wants safety wake-ups every 20-30 min. Told him I cannot switch the model myself. Safety wake-ups scheduled and re-armed by each run.
- Test Sheet "GJ Leave - TEST" created (id 1ve6Piese3kmJ7VPx4q4MIjeyKvMXkEV9T9xfc9bO1yA). Bound Apps Script project created through the owner's Chrome, bundle loaded from GitHub raw, `setupOrUpgrade` run on the real Sheet (all tabs created), owner granted permissions himself.
- Web app deployed (version 1, execute as owner, access Anyone). URL is in `docs/config.js`.
- Real-server check from the browser: names, owner bootstrap login, staff login pending, owner approves phone, preview, submit (auto-approved), stored as text in the Sheet. About 2.5 s per call. Test rows cleared afterwards.
- Test roster seeded in People (every PIN 1234) and sample PayInfo (17,000 from the handoff example). TEST DATA ONLY.
- GitHub Pages enabled (main, /docs): https://varunsaini08581-pixel.github.io/gj-leave/  Demo mode: add ?demo=1
- Redeploying after code changes: Apps Script > Deploy > Manage deployments > edit > New version (same URL). New Google permission is not needed unless a new service is added.

### 20 Nov 2026, 17:11 IST
- Owner correction applied: late / early requests now need Aakash's approval (Pending -> Approved / Rejected). Informed only when approved; if Aakash decides after the person arrived or left, the day is corrected then (approved = informed, rejected = not informed). Clash is re-checked at approval. PROVISIONAL on the 'decided later' part until the owner answers.
- Owner (17:06): keep working without stopping; he will test later; report when everything is done.
- `src/server/admin.js`: incidents by Aakash with the grace table (per month / per quarter, editable), disputes (24 h, once, Varun decides, removed never deletes), edit a leave (every check re-run, old violations withdrawn), Varun's override with a written reason, Settings (people, pay, rules, restrictions, grace table, shop point). Everything audited; salary amounts are not copied into the audit log.
- `src/server/views.js`: Today board, Today at GJ, calendar with clash-risk days and restrictions, month report, month lock (only after the month ends; locked result never changes; corrections are new logged entries; no new leave in a locked month).
- All wired into the API and the Apps Script bundle. Server on the TEST deployment is still version 1 (needs a redeploy through the owner's Chrome to pick these up).
- Tests: 88 pass.

### 20 Nov 2026, 17:13 IST
- `src/server/jobs.js`: one email digest per person (in-app only when no address; daily quota respected; never sent twice), reminder to Aakash every 2 hours for pending leave and late/early requests (hours from Settings; special approval reminds only whoever has not decided), proactive warnings once a month (bank 80%, bank used up, passes used, 1 violation, 2 violations, emergencies used), notice stage to Varun, evening-before leave reminder, end-of-day absent check + daily summary to Varun + missing check-out to Aakash.
- Apps Script glue: jobEmails (5 min), jobHourly, jobEvening (19:00), jobEndOfDay (21:00), `installTriggers` (safe to run again). Owner email falls back to the deploying Google account.
- Assumption: going-out requests are not in the 2-hour reminder (they need an answer in minutes; the staff member has the Remind button).
- Tests: 96 pass.

### 20 Nov 2026, 17:18 IST
- Phone app: `docs/app-admin.js` with all Aakash / Varun screens (Shop today board on the Today tab, Record incident, Enter leave for staff, Calendar with clash-risk days, Month report + lock + corrections, Restrictions, Set shop location) and owner screens (Disputes, Override, People + duty + salary structure, Clash rules on/off, Grace table). Staff: Edit a request, restricted dates shown on the apply form, Dispute button on a violation (24 h), Today at GJ, Notifications, late/early shows Pending / Approved / Rejected.
- Notifications now use readable violation names instead of rule keys.
- `tools/ui-check2.py`: phone-size run through every management screen in demo mode (3 users, 20+ screens). 0 console errors. `tools/ui-check.py` still passes.
- Tests: 96 pass.

### 20 Nov 2026, 17:23 IST
- Check-in photo: `docs/camera.js` opens the BACK camera only (facingMode exact environment; the front camera cannot be offered), accepts LANDSCAPE only (Take photo stays disabled in portrait), no gallery upload, framing guide and person outline, stamp drawn on the photo (name, server date and time, lat/long with accuracy, distance from the shop point, device). Photo about 1280 px wide + a 320 px thumbnail.
- Server: check-in through the API now REQUIRES the photo; photos go to a private Drive folder (id kept in script properties), the Sheet keeps only file ids; `photo` action serves today's thumbnails to everyone (Today at GJ) and the full photo only to that person, Aakash and Varun; yesterday's thumbnails are no longer public. Size limits enforced.
- Dress check: `docs/dress.js` (MediaPipe pose model on the phone + colour sampling). Top white (black coat OK), trousers black, shoes black, belt = hint only. Result only flags to Aakash; Confirm uses the dress grace then becomes a violation, Dismiss clears it. Skipped on Sundays and for exempt people. Colour logic tested on synthetic photos; the pose model itself loaded fine in the test browser but is NOT yet verified on real shop photos.
- Manual check-in by Aakash (phone or camera failed): reason required, labelled entered by Aakash, no photo. ASSUMPTION, not in the handoff.
- Apps Script lock made safe for nested locked actions.
- UI checks run with a fake camera: photo is captured, stamped, stored and shown in Today at GJ. 0 console errors.
- BLOCKED: the new server code is saved in the Apps Script editor but Google asks the owner for one more permission (new code uses Session email + email sending). Dialog left open in his Chrome. Until he allows and a new version is deployed, the live test site talks to server version 1 and the new screens answer 'Unknown action'.
- Tests: 105 pass.

### 20 Nov 2026, 17:25 IST
- Before sending a late / early / going-out request the person sees the effect: minutes used and bank left, or 'the bank is exhausted: these N min = Rs X would be deducted', and how close the next 'extra 2 hours' violation is. Today screen shows This month hints: bank left, not-informed passes left or 'the next one is a violation', and the bonus / notice warning.
- Owner allowed the new Google permission (17:25).
- Tests: 107 pass. Both phone checks pass with 0 console errors.

### 20 Nov 2026, 17:30 IST
- Server version 2 deployed on TEST through the owner's Chrome after he allowed the extra Google permission (two tries; the first time not every box was ticked). `setupOrUpgrade` ran on the real Sheet and added the new tabs and columns without touching data (upgrade path proven on the real Sheet). `jobHourly` ran once on the real Sheet without error.
- Real-server check of v2: owner bootstrap login, staff phone approval, check-in WITH photo saved to the private Drive folder, hints, effect preview, Today at GJ. All correct, but the check-in took 12.6 s (first photo also created the Drive folder).
- Fix for speed: the Sheet store now buffers inserts and updates and writes each tab once per request (`flush` inside the server lock, before it is released); a tab that is only written to (Audit, usually Notifications) is no longer read in full. Buffered and immediate modes proven to give the same Sheet content.
- Timers (`installTriggers`) are NOT installed on the TEST Sheet on purpose: with test data they would email the owner a fake absent list every night. They go on at release.
- Tests: 109 pass.

### 20 Nov 2026, 17:34 IST
- Measured on the real server (v3): about 2.4 s fixed per call plus about 0.5 s for every tab read; Today took 5-8 s, check-in 12-15 s. Too slow.
- `src/server/cachegrid.js`: each tab is read from the Sheet once and then served from the Apps Script cache. A version per tab makes it safe: a writer, after its writes are on the Sheet and still inside the lock, moves the tab to a new version, so nobody can read rows from before a write. Cached data also expires after 10 minutes. If the cache fails the app simply reads the Sheet. Tests: fewer reads, same Sheet content with and without cache, no stale read after a write, overlapping requests cannot poison it.
- Note for the owner page: a manual edit made directly in the Sheet can take up to 10 minutes to show in the app.
- Tests: 114 pass.

### 20 Nov 2026, 17:37 IST
- Real-server timings on v4 (read cache): repeat reads dropped to 1.4-2.0 s (names 1.4, Today 2.0, My month 1.6). Writes were still slow (login 6 s, check-in 10 s) because every write emptied the cache and the next call read the Sheet again.
- Now the writer, still holding the lock, hands the cache the exact new content of the tabs it read in full, but only if nobody else wrote that tab since it read it (checked by version). Otherwise it only retires the old copy. Tests for both cases.
- Login, PIN set and phone approval now run inside the server lock (they write), and buffered writes are flushed inside the lock even when the action ends in an error (a wrong PIN is still counted).
- Tests: 116 pass.

### 20 Nov 2026, 17:41 IST
- v5 timings: reads right after a write are now about 2.1 s, but the writes themselves were slow (login 5 s, phone approval 4.5 s, check-in 10 s). Cause: on the real Sheet a read between two writes forces a round trip, and each tab append did read-then-write.
- All appended rows of a request now go in ONE step (find the end of every tab first, then write them all), header rows are cached, and the thumbnail is stored as a small cell in a new Thumbs tab instead of a second Drive file (read back from the last 80 rows only).
- Found and fixed before it could bite: a tab is created with 1000 rows; appending beyond that would have failed. Tabs now grow by 500 rows (plain text) when needed.
- A second check-in the same day is refused before any photo is stored.
- Tests: 116 pass; management phone check passes.

### 20 Nov 2026, 17:45 IST
- Server version 7 is live on TEST (same URL). Measured with the timing info now returned by the server: Today 0.5 s on the server (0 Sheet reads), login 1.4 s, phone approval 0.8 s, check-in with photo 4.1 s (Drive 1.8 s, Sheet writes 1.4 s). On top of that Google's web-app layer adds about 2 s per call that the app cannot remove. So on a phone: screens about 2.3 s, simple actions about 3 s, check-in about 6 s (was 12-15 s).
- Thumbnail read back through the API matched byte for byte; Today at GJ lists the check-ins.
- Test rows made by these checks were cleared from the TEST Sheet and `setupOrUpgrade` was run to refresh the read cache; the owner's first sign-in will be the bootstrap phone again.

### 20 Nov 2026, 17:52 IST
- `test/month-simulation.test.js`: October 2026 with 12 people (9 staff + new joiner Garvit + Aakash + Varun) driven through the real server functions: auto-approved leave, three emergencies, not-informed lates and passes, going out, special approval, restricted week, half day, absent with no request, recorded-only leave, early leaving, bank overflow, Anita's weekdays, Aakash's leave to Varun. Every person's leaves, days cut, bank minutes, minutes beyond the bank, violations and rupees match a hand count written in the test; shop totals 6 violations and Rs 1,764.
- Bug rounds 1-3 started with three independent review agents (rule correctness vs the handoff, privacy and security, concurrency / dates / storage). They only write findings and failing reproducers; fixes follow.
- Tests: 117 pass.

## Assumptions made in code (to show the owner together, not blocking)
1. Per-day clash also covers "Going out" and planned late/early. Flagged to the owner twice, no objection.
2. Auto violations for a leave (unannounced / 3rd+ emergency / restricted period) are recorded when the leave is GRANTED, not when it is only requested.
3. Reason list on the form: Sick, Family function, Family emergency, Personal work, Travel, Exam, Other (+ free text always required).
4. One request = consecutive dates only.
5. PIN is 4 to 6 digits.
6. Late / early requests need no approval (the handoff only says "applied in the app"). Aakash gets a notification.
7. Going-out time is counted from Aakash's APPROVAL time to the staff member's "I'm back" tap.
8. Leaving before the stated early time: the minutes before the stated time are "not informed" (mirror of the late rule).
9. A day with more than 2 hours away becomes a half day (0.5 leave) automatically, more than 4 h 30 min a full day, counted in the quota. No emergency count is added. If the time was NOT informed and over 30 min, the normal "not informed, more than 30 min" violation still applies.
10. Absent with no request: counted as 1 leave day + 1 violation. Muskan: recorded only. Aakash and Varun are not tracked.
11. Shop-closed days are read from Settings `closedDays`; no screen for it yet.

12. Late / early request still pending when the person arrives or leaves: counted as not informed for now; when Aakash decides later, approved = informed, rejected = not informed. Asked the owner twice, no answer yet.
13. A new joiner in the middle of a month: the roster Sundays of the whole month are counted in that month's 5 (not pro-rated), and the absent check does not look at days before the joining date because it only runs for "today". The handoff lists "a new joiner or a leaver" as an edge case but gives no rule.
14. Going-out requests are not part of the 2-hour reminder to Aakash.
15. Manual check-in by Aakash when a phone or camera fails (no photo, reason required, labelled).

## Next
- Owner still to answer: late/early request still PENDING when the person arrives - is "approved later = informed, rejected = not informed" right? (built this way)
- 12-person month simulation against a hand count (handoff Part 7).
- About 10 bug rounds with independent review agents (rule correctness; privacy and security; concurrency and dates; phone UI; upgrade and deploy safety; full shop-day simulation; edge cases; re-review of fixes). Done only when 2 rounds in a row have 0 Critical and 0 High.
- Dress check on REAL shop photos (needs the owner or staff to take a few check-in photos at the shop).
- Staff guide (visual PDF, simple Hinglish), owner page (what to watch, what the system cannot catch).
- Release, only after the owner's OK: real Sheet "GJ Leave", real people / duty times / salary structure from the owner, new PINs, bind phones, set shop location, \`installTriggers\`, point \`docs/config.js\` at the real deployment.
- Redeploy recipe (TEST): open the Apps Script project, load \`apps-script/Code.js\` of the commit, save, run \`setupOrUpgrade\`, Deploy > Manage deployments > edit > New version > Deploy. Same URL. No Google permission needed unless a new Google service is added.
