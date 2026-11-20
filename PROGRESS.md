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

## Next
- Late/early approval by Aakash (owner correction), then redeploy a new version.
- Screens still missing: calendar, month report, settings, restrictions, Today at GJ, camera check-in, disputes, manual violations.
- Edit-after-approval (back to pending, re-check), manual violations by Aakash with grace table, disputes (24 h), settings API, month lock, 12-person month simulation, email alerts + 2-hour reminder trigger.
