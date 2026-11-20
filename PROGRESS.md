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
- 20 Nov 19:27 IST (owner, voice): going out over 15 minutes is NOT free: the whole outing comes from the 2-hour bank. The 2-hourly reminder is never sent between 00:00 and 06:00. One reminder on the evening before is fine. (Taken as: an outing of 15 minutes or less stays free; to confirm.)
- 20 Nov 23:46 IST (owner): (1) lost owner phone: Aakash may approve the owner's new phone, AND the editor reset stays (63 confirmed). (2) Coming to work on a day of approved leave: the rule of 72 is confirmed. Sunday swaps get NO separate rule: the same rules apply to every day; the owner corrects swaps by hand. (3) Requests per day: from the 4th request a person sends in one day, everyone sees a red warning and it always goes for approval (Aakash); from the 6th it goes to Varun directly; nothing is refused. (4) The free outing (15 min or less) is free ONCE a day; other short outings of that day count whole. (5) The total limits stay as given before. Go live: 21 Nov 2026.

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
- DEMO mode: while `config.js` has no API_URL the app runs the SAME server modules inside the phone on sample data (sample PINs, nothing saved). Lets the owner see the screens before the Apps Script deploy.
- Checked in a 390x844 phone viewport with Playwright (`tools/ui-check.py`): sign in, phone approval, check-in, apply (auto-approved), my month, emergency request, Aakash approval. 0 console errors.
- Found by that check and fixed: an uninformed very late arrival turned into a half/full day and lost its violation. Now the "not informed, more than 30 min" violation stays. Test added.
- Folder is `docs/` (not `web/`) because GitHub Pages serves only the root or `/docs` from a branch.
- Tests: 72 of 72 pass.

### 20 Nov 2026, 17:00 - first real deploy (TEST)
- Owner corrections: (1) late/early requests MUST be approved by Aakash (staff can send; Aakash approves) - NOT YET CODED, currently no approval; asked the owner what happens if Aakash has not decided before the person arrives (proposal: approved later = informed, rejected = not informed). (2) Left before the stated early time = those minutes not informed: confirmed. (3) More than 2 hours away = half day in quota only: confirmed; told him the uninformed-over-30 violation still applies on such a day.
- Owner: if the Fable limit runs out, continue on Opus 5.5; wants safety wake-ups every 20-30 min. Told him I cannot switch the model myself. Safety wake-ups scheduled and re-armed by each run.
- Test Sheet "GJ Leave - TEST" created. Bound Apps Script project created through the owner's Chrome, bundle loaded from GitHub raw, `setupOrUpgrade` run on the real Sheet (all tabs created), owner granted permissions himself.
- Web app deployed (version 1, execute as owner, access Anyone). URL is in `docs/config.js`.
- Real-server check from the browser: names, owner bootstrap login, staff login pending, owner approves phone, preview, submit (auto-approved), stored as text in the Sheet. About 2.5 s per call. Test rows cleared afterwards.
- Test roster seeded in People (test PINs, to be replaced) and sample PayInfo (17,000 from the handoff example). TEST DATA ONLY.
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
- Test rows made by these checks were cleared from the TEST Sheet and `setupOrUpgrade` was run to refresh the read cache.

### 20 Nov 2026, 17:52 IST
- `test/month-simulation.test.js`: October 2026 with 12 people (9 staff + new joiner Garvit + Aakash + Varun) driven through the real server functions: auto-approved leave, three emergencies, not-informed lates and passes, going out, special approval, restricted week, half day, absent with no request, recorded-only leave, early leaving, bank overflow, Anita's weekdays, Aakash's leave to Varun. Every person's leaves, days cut, bank minutes, minutes beyond the bank, violations and rupees match a hand count written in the test; shop totals 6 violations and Rs 1,764.
- Bug rounds 1-3 started with three independent review agents (rule correctness vs the handoff, privacy and security, concurrency / dates / storage). They only write findings and failing reproducers; fixes follow.
- Tests: 117 pass.

### 20 Nov 2026, 17:58 IST
Staff guide (5 pages, Hinglish) and owner page (3 pages) written; built by tools/staff-guide.py and tools/owner-guide.py. Not yet sent to the owner as final: wording follows the rules as built today and must be rebuilt if a bug round changes a rule.

### 20 Nov 2026, 18:09 IST
BUG ROUNDS 1-3 (independent reviewers; every finding came with a failing test, now in test/round1-3.test.js; reports in reviews/). Round 1 rule correctness: 2 Critical, 4 High, 14 Medium, 2 Low. Round 2 privacy and security: 1 Critical, 2 High, 7 Medium, 4 Low (+8 design risks). Round 3 concurrency, dates, storage: 1 Critical, 4 High, 7 Medium, 2 Low. Total 4 Critical, 10 High. ALL 50 findings fixed; 180 tests pass. Main fixes: the request time can no longer come from the phone; every changing action now runs from start to end inside the server lock and first throws away whatever it read while waiting (two clashing approvals can no longer both pass, a cancelled leave cannot come back, no lost approval, no double check-in); a refused action saves nothing; half day in the middle of the shift; informed-short-then-very-late now gives the violation; restricted-period leave goes to Aakash; cancel withdraws violations; quota checked for both months and includes automatic half days; closed days re-counted; C1-E keeps Bhawna and Pooja in; inactive or renamed rule members; PIN lock grows 15 min to 24 h; owner can remove a phone; Aakash cannot lift Varun's restriction or move the shop point; sizes and dates checked on the server; formula text neutralised; one bad e-mail no longer blocks the rest; end-of-day never runs before duty end; Sign out now needs the PIN again. New: called-emergency time on Aakash's entry, forgotten check-out entry, close an outing nobody closed, Phones screen. Rule choices made while fixing are assumptions 16-29 (several TO CONFIRM). Schema version 2 (3 new columns): TEST needs setupOrUpgrade + new deployment version. Test PIN and Sheet id removed from this log.

### 20 Nov 2026, 18:17 IST
Built the handoff items round 1 listed as missing: 'last 3 months' on My month (new month starts at zero, old months stay in view), 'Possible clash' warning when another request for the same day is still waiting, Shop-closed days screen (owner), month lock by Aakash AND Varun (the first confirms, the second locks), pending card now shows the rule result, who else is away and the person's month so far, and an edit after approval always goes back to Aakash (handoff Part 6). TEST server redeployed as version 8 (schema 2, setupOrUpgrade added 3 columns) and checked live: two clashing requests sent at the same moment gave exactly one Approved and one 'Not allowed'; the same check-in sent twice stored one check-in; a link in place of the thumbnail was refused; formula text is stored as plain text. Test PINs on the TEST Sheet replaced by a random one that is not written anywhere in the repo. Screenshots (binaries) removed from the repo and ignored. 184 tests pass. (TEST runs version 8 = commit f6cfb5b; this commit is not deployed yet.)

### 20 Nov 2026, 18:33 IST
BUG ROUND 4 (independent re-review of the round 1-3 fixes): 0 Critical, 1 High, 3 Medium, 13 Low; 9 of the 50 earlier fixes were only partly done, 1 fix had caused a regression. BUG ROUND 6 (upgrade and deploy safety): 0 Critical, 3 High, 9 Medium, 4 Low. All fixed, reproducers in test/round4.test.js and test/round6.test.js, reports in reviews/. Round 4: leave granted after arrival now re-counts the day; half day pending and away all day; restricted-period violation settled at grant time; the C1-E lock no longer fires on ordinary lateness (regression); Aakash never marked absent; excused absence not editable; sign-out told to the server; rejected phone can ask again; alert limits; duty time validation; call time kept on edit; edit cannot park a violation; closed day entered later withdraws that day's absences; own-phone PIN lock grows; cache version bump has a fallback. Round 6: new code on a Sheet that was not upgraded answers 'being updated' instead of half-working (and PIN lock still works); rows are written by the header row the Sheet has NOW and a moved row is found again by its id (a column inserted or a row deleted by hand no longer corrupts data); only the app's own cells are written; locked month frozen everywhere and shown as locked to staff; a damaged cell no longer takes the app down and is reported in the daily summary; unexpected errors are logged with a reference; setup refuses a missing tab / empty header row and repairs a trailing space; schemaVersion is now maintained (3); file addresses carry a content hash; no reload loop; server version in replies; a missing config never turns into demo mode; missed nights caught up; big tabs cached in pieces; leavers stay in their month's report; back-dated entries keep the 24-hour dispute window. 232 tests pass. Schema 3 (People.joinedOn, Devices.pinLockLevel + signedOut, LeaveRequests.noticeAt): TEST needs setupOrUpgrade + a new deployment version. Also added: full shop-day test through the API (test/shop-day.test.js). Assumptions 30-37 added.

### 20 Nov 2026, 18:42 IST
BUG ROUND 5 (phone UI and usability, Playwright at phone sizes, all roles): 0 Critical, 1 High (after an earlier fix removed a second one), 11 Medium, 11 Low. Privacy: 0 findings. All 23 fixed; the reviewer's script is kept as tools/ui-round5.py (23 of 23 pass). Fixes: Check out before duty end asks once more, and Aakash can take back a wrong check-out; a slow answer no longer paints over another tab; a screen that cannot load says so with Try again (45 s timeout); no 'null' on the sign-in screen; late / early requests for other days stay visible and can be cancelled; My month has a month control and Back, and opens the right month from a report; an absence leaves Approvals after 'Keep as absent'; the phone's Back button moves inside the app; Today and Approvals refresh when the app comes to the front and every 30 s; Create new PIN, Cancel request, Remove phone ask once more; calendar fits the phone; a violation shows its plain name and Aakash's note; offline page (sw.js keeps nothing of the app); framing guide sits on the picture; edit mode is visible with Stop editing; notifications carry the day and readable dates; phones are named (Android phone / iPhone); labels tied to fields; a special request Aakash approved leaves his list; the photo is kept when sending fails (Send again); clearer messages. ROUND TREND so far (Critical/High): R1 2/4, R2 1/2, R3 1/4, R4 0/1, R5 0/1, R6 0/3. Not yet two rounds in a row with 0 High. Needs a REAL PHONE test: check-in with screen rotation locked, keyboard over the tab bar, dress model download on mobile data, home-screen icon on iPhone (the manifest has only an SVG icon; a PNG is a binary and is not in the repo).

### 20 Nov 2026, 19:11 IST
BUG ROUND 7 (edge cases: boundaries, runs, people and rule changes, thresholds, wrong inputs): 0 Critical, 2 High, 8 Medium, 12 Low. The reviewer found the rule engine itself correct in both directions (every minute threshold, month and year rollover, 5-Sunday month, Anita, ladder, dispute window, money working, privacy, about 19,000 wrong-typed calls); what broke was what happens when something is CHANGED AFTERWARDS. All 22 fixed (test/round7.test.js): a roster or active change in Settings no longer re-judges past days (People.history); a late request approved after arrival is no longer refused because the pool partner was late; cancelling a running leave keeps the days already taken; an edit with the same first day keeps its notice; notice runs to the first real leave day; a closed day entered later clears that day's minutes and violations; a clash rule switched on later rejects the later of two clashing leaves; Varun is told while Aakash is on leave; a taken-back check-out no longer blocks the pool partner; a withdrawn count violation comes back when it applies again; no-manager case; emergencies renumbered; restriction default ticks cover later joiners; Anita by flag not by group spelling; reminders stop for a leaver; a shrunken run needs one approval; outing minutes only inside duty; no outing approval after check-out; clearer deduction line; Muskan's no-show is 'Absent' not 'On leave'; wrong-typed Settings and arguments refused. Schema 4 (People.history). 262 tests pass. ROUND TREND (Critical/High): R1 2/4, R2 1/2, R3 1/4, R4 0/1, R5 0/1, R6 0/3, R7 0/2. Assumptions 38-47 added. Note: tools/ui-check2.py asks for an early leaving at 19:00, so it fails by itself when run after 19:00 IST (test script, not the app).

### 20 Nov 2026, 19:13 IST
Two screens the server already supported: 'Staff leaves: cancel or shorten' for Aakash and Varun (a leave not started is cancelled, a running one is shortened and the days taken stay, with a reason), and 'Change people' on a clash rule for Varun (members and minimum present; a leaver is taken out here). Checked at phone size (tools/ui-check3.py). 263 tests pass.

### 20 Nov 2026, 19:23 IST
BUG ROUND 8 (independent simulation with its own hand count: 3 shop days, a full month for 11 people with all jobs every day, the first days of the next month, and the owner's six worked examples driven as real check-ins and requests): 0 Critical, 1 High, 6 Medium, 4 Low. 586 hand-counted values compared; 564 matched, the other 22 are the findings. All six worked examples exact; no salary or reason leak in about 3,000 staff replies; no duplicate or lost rows; jobs run twice change nothing; same result with the cache on and off. All 11 fixed (test/round8.test.js); the reviewer's simulations are now part of the suite (test/sim-round8.test.js, 16 tests). Fixes: a person who was at work but could not check in can be put right (absence taken back, by hand or by entering the check-in, for any open day); a violation removed by Varun after a dispute never comes back; Varun is told about going-out and late / early requests while Aakash is on leave; ending a running leave at noon no longer makes today an absence; a leave across a locked month end can be shortened; undecided requests are closed with the month lock; withdrawn violations are announced; violation alerts name the person; retries of a correction or restriction store one row; the daily summary no longer calls a roster-off helper late; Muskan gets the evening-before reminder; 'the next not-informed time is a violation' alert. 293 tests pass. ROUND TREND (Critical/High): R1 2/4, R2 1/2, R3 1/4, R4 0/1, R5 0/1, R6 0/3, R7 0/2, R8 0/1. TEST server runs version 10 (round 7 state); this commit is not deployed yet (no schema change).

### 20 Nov 2026, 19:56 IST
Rounds 9 (0/1/7/5) and 10 (0/1/3/3) fixed: 26 reproducers pass, 319 tests. Owner's night-reminder rule built. Server version 9.

### 20 Nov 2026, 20:34 IST
Rounds 11 (0/1/9/4) and 12 (0/1/5/10) fixed: 42 reproducers pass (2 round-12 tests adjusted with reasons: L3 offline sign-out, L9 photo removed not avoided), 361 tests. Server version 9.

### 20 Nov 2026, 21:26 IST
Rounds 13 (0/2/5/3) and 14 (0/0/5/9) fixed: 36 reproducers pass (2 test set-ups repaired, reasons in the files), 397 tests. Server version 9.

### 20 Nov 2026, 22:27 IST
Rounds 15 (0/1/5/3) and 16 (0/0/3/7) fixed: 28 reproducers pass (1 expectation adjusted with its reason: M1b retry time), 425 tests. Minutes of a day now derived from facts (deriveDay). Server version 9.

### 20 Nov 2026, 23:56 IST
Rounds 17 (0/0/7/4) and 18 (0/0/3/5) fixed: 29 reproducers pass. Owner decisions of 23:46 built (requests per day, free outing once a day; phone recovery and leave-day rule confirmed). 458 tests. Server version 9.

### 21 Nov 2026, 00:00 IST
Go-live prep: real Sheet 'GJ Leave' created (id 1M72Pp0SqqNDyqO2fYLtC7tZB3BMwSQSWMW4HXxVVOCY), bound script being set up; owner sets his own PIN from the Sheet menu.

## Assumptions made in code (to show the owner together, not blocking)
1. Per-day clash also covers "Going out" and planned late/early. Flagged to the owner twice, no objection.
2. Auto violations for a leave (unannounced / 3rd+ emergency / restricted period) are recorded when the leave is GRANTED, not when it is only requested.
3. Reason list on the form: Sick, Family function, Family emergency, Personal work, Travel, Exam, Other (+ free text always required).
4. One request = consecutive dates only.
5. PIN is 4 to 6 digits.
6. (Replaced by the owner's decision: late / early requests must be APPROVED by Aakash.)
7. Going-out time is counted from Aakash's APPROVAL time to the staff member's "I'm back" tap.
8. Leaving before the stated early time: the minutes before the stated time are "not informed" (mirror of the late rule).
9. A day with more than 2 hours away becomes a half day (0.5 leave) automatically, more than 4 h 30 min a full day, counted in the quota. No emergency count is added. If the time was NOT informed and over 30 min, the normal "not informed, more than 30 min" violation still applies.
10. Absent with no request: counted as 1 leave day + 1 violation. Muskan: recorded only. Aakash and Varun are not tracked.
11. Shop-closed days are read from Settings `closedDays`; no screen for it yet.

12. Late / early request still pending when the person arrives or leaves: counted as not informed for now; when Aakash decides later, approved = informed, rejected = not informed. Asked the owner twice, no answer yet.
13. A new joiner in the middle of a month: the roster Sundays of the whole month are counted in that month's 5 (not pro-rated), and the absent check does not look at days before the joining date because it only runs for "today". The handoff lists "a new joiner or a leaver" as an edge case but gives no rule.
14. Going-out requests are not part of the 2-hour reminder to Aakash.
15. Manual check-in by Aakash when a phone or camera fails (no photo, reason required, labelled).
16. Half-day notice is measured to the person's DUTY START that day (the handoff's wording), also for an afternoon half day. So a half day from 14:00 asked at 08:00 the same morning is Unannounced. Was measured to the half-day start before round 1. TO CONFIRM with the owner.
17. A half day may sit anywhere inside the duty hours (owner: "any 4 h 30 min"). In the middle of the shift it is an approved window: the person stays checked in, leaves and returns; minutes missed outside the window count as late / early. A half day must fit inside duty hours.
18. Approved half day and the person does not come for the other half either: end of day records "Absent – unannounced" for that half (0.5 leave + 1 violation; Aakash can excuse it). TO CONFIRM.
19. A request still not decided when the day is over and the person stayed away: the day is counted as leave on the month page ("not decided"), Aakash and Varun are alerted, no violation by itself. If it is then REJECTED, the day becomes "Absent – unannounced" (+1 violation). TO CONFIRM.
20. Which emergency of the month a request is (1st, 2nd, 3rd) is settled when it is GRANTED, among granted ones only.
21. A leave in an "allowed, +1 violation" restricted period is never auto-approved; it goes to Aakash (handoff 3.4 "no restriction").
22. Cancelling a leave before it starts withdraws the violations it had earned. Cancelled after it started: they stay.
23. Restrictions: Aakash can add one and change one he added. Changing or switching off any other one is an override: Varun only. The shop location: first time Aakash or Varun; after that only Varun can move it. (Handoff 3.6 and 3.11 do not fully agree here.) TO CONFIRM.
24. "Called – emergency": when Aakash enters a leave for someone he can give the time of the phone call (within the last 24 hours); notice is counted from that time. Without it, notice is counted from when he types it.
25. A rule member who is not an active person (left, or the name no longer matches) never counts as present. When someone leaves, the owner must edit the clash rule, otherwise that group can take no leave.
26. Dress incident on a Sunday is refused (dress code is Mon-Sat).
27. PIN guessing: 5 wrong PINs lock the account for 15 min, then 1 h, 4 h, 16 h, 24 h. The person's own approved phone has its own counter, so a stranger cannot lock them out of it. At most 3 phone requests can wait per person.
28. A 2-day 3rd emergency cuts 2 days (each day of it), the owner's words were "1 day cut". TO CONFIRM.
29. An edit of an approved leave always goes back to Aakash (handoff Part 6), even a small one. While it waits it does not hold its date.
30. A locked month is frozen: nothing dated in it can be changed in place any more (cancel, decide, incident, override, hand check-out, dispute, closed day); the person's own page shows the locked numbers. A request still waiting when the month is locked stays as it is; the fix is a correction entry.
31. The evening absent check also looks at the 3 days before today (a night when the timer failed is caught up), never before the Sheet's start date (written by setup on a new Sheet; Settings `startDate`) and never before the day a person was added (`joinedOn`).
32. "Sign out" tells the server: the phone's token is refused until the PIN is entered on that phone again. A rejected or removed phone can ask again with the right PIN (a new request to the owner).
33. A leave granted after the person already checked in or out that day re-counts that day's late / early minutes (as for late / early requests).
34. The "extreme emergency" lock on Bhawna and Pooja applies only on a day for which an extreme emergency was really granted.
35. A "+1 violation" restriction is applied as it stands at the moment the leave is GRANTED (added later = counts; switched off before = does not).
36. An edit keeps the violations of the old version until the new version is decided.
37. The same incident (same person, item, date, note) sent again within 5 minutes is one incident. The same late / early request sent again is one request; at most 5 changes per day.
38. A change in Settings to a person's Sunday roster or active state applies from that day on. What was true until the day before is kept (People.history), so days already gone are never judged again.
39. Cancelling a leave that is still running (Aakash / Varun) only gives back the days from today on; the days already taken stay as leave. A leave that is completely over is cancelled as a whole.
40. An edit that keeps the same first day keeps the original notice (the notice for that day was given when the request was first sent).
41. Notice is measured to the first real leave day of the request (the person's own roster Sunday or a closed day at the front is skipped).
42. A shop-closed day entered later also clears that day's late / early / going-out minutes and their violations, and an emergency leave only on closed days does not count as one of the 2.
43. A clash rule added or switched on later: an approved leave that now clashes (from today on) becomes "Rejected – clash", the one approved last gives way; everyone concerned is told. Varun's overrides are left alone.
44. While Aakash is on approved leave (or there is no manager), requests waiting for Aakash are also brought to Varun. With no manager at all, a special request needs only Varun.
45. Emergencies are numbered among the granted ones in the order granted, and numbered again when one is cancelled.
46. An outing counts only the minutes inside duty hours; it cannot be approved after the person has checked out.
47. The per-day clash rule (assumption 1) is strict, and round 7 showed its effects: on a 1st-4th Sunday nobody in Calls, Repair or Sales can ask for a late arrival or an outing; one person's lateness blocks the pool partner's requests that day. This follows the owner's "per day" decision; flagged to him again. TO CONFIRM.
48. An absence the evening job recorded for someone who was at work (dead phone, app down) can be taken back by Aakash or Varun with a reason, and is taken back automatically when Aakash enters the check-in for that day (a check-in can now be entered for any day of an open month).
49. When Aakash ends a running leave, today stays a leave day if duty has begun and the person has not come in; a past day on which the person did check in is given back.
50. A request of a month that nobody decided is closed when the month is locked (its days stay in the locked result as "counted, not decided").
51. Whoever was told "Violation recorded" is also told "Violation withdrawn". A violation Varun removed after a dispute is never recorded again.
52. OPEN, found by round 8, for the owner: (a) going out over 15 minutes: handoff 3.5 says the WHOLE outing comes from the bank (built this way), but the examples in 3.8 and 3.10 say "42 min (27 from bank)", i.e. the first 15 free. (b) Reminders every 2 hours also run through the night. (c) The evening-before reminder goes out once at about 19:00.
53. Leave violations (unannounced, 3rd emergency, restricted period, absent) are kept in step with the leave rows by ONE routine (`syncLeaveViolations`) that runs after every change. A waiting request keeps what it has; a violation removed after a dispute never returns.
54. Closed days are not written into the rows any more: every count leaves them out. A closed day entered by mistake can be removed and the day is as before.
55. One calendar day never counts as more than 1 leave. No minutes of any kind on a full-leave day, a roster Sunday off or a closed day.
56. A clash rule changed during a running leave: days already over stay approved leave, only days from today on are given back.
57. A leave cancelled or rejected after the person came in: the late / early time of that day is counted then, as informed.
58. Staff may edit one request at most 10 times; late / early requests only for the next 14 days, at most 8 open. `installTriggers` sets `startDate` to that day.
59. A LOCKED month is frozen in the rows too: no violation, minute or absence of a locked month is added, removed or counted again by anything that happens later. Only Varun's decision on an open dispute is still allowed (the locked report itself stays as locked). The "last 3 months" line shows the locked number.
60. Locking a month closes everything of that month that is still waiting: late / early requests, outings (a confirmed-back wait is confirmed, a never-closed outing is closed with no minutes), dress flags, and leave requests whose days all lie in locked months. A request that reaches into an open month can still be decided; its violation is dated on its first open day.
61. "End this leave" on the last day of a running leave keeps the days before today as leave and gives back today only.
62. A leave that was approved and then cancelled for today: coming in late that day counts as informed (the absence was known), whichever tap came first. Minutes set aside when a leave was granted come back as they were when it is cancelled. Going-out minutes follow the same rule.
63. OPEN, for the owner (round 12 H1): the owner could lock himself out (new or lost phone: only the owner can approve phones). Built: (a) the phone keeps one approval per person, so trying a staff account on the owner's phone loses nothing; (b) Aakash can approve ONLY the owner's own new phone request (right PIN already entered), the owner is alerted; (c) `resetOwnerPhones` can be run by hand in the Apps Script editor. To confirm with the owner: is (b) acceptable, or editor-only recovery?
64. "Sign out" with no connection does not sign out (the server could not be told); the app says so. A photo uploaded for a check-in that is then refused is moved to the Drive bin.
65. A first sign-in repeated from the same phone is the same request (new token), not a second one. Changed rows are written before new rows (alerts), so a Sheet failure cannot announce a change that was not saved.
66. Coming in late counts as "informed" because of a leave ONLY when that leave was taken back on that same day by Aakash or Varun (cancel, shorten, move, rule change). A leave the person cancelled, or one taken back on an earlier day, leaves an ordinary working day (round 13 R13-1; narrows 62).
67. Every change to a leave counts its days again (cancel, shorten, edit old and new days, override, rule change, closed day added or removed, corrected back time). Minutes set aside while a leave covers the time keep what they were ("[was N]" in the note) and come back in the same pieces, informed or not.
68. "Records only" (no approval needed) is judged by the day: switching it on or off does not add or remove violations of earlier days. A closed day removed after the day is over gets its absent check then. The month lock runs the absent check of the month's last 7 days itself, and one person can lock when the other role has no active person.
69. A write to the Sheet that fails half-way puts the rows it had already changed back as they were, so a failed action can simply be tapped again (changed rows first, new rows last).
70. Phones: a repeated first sign-in keeps one request but says so on the card, in Audit and by an alert; the owner's very first sign-in repeated within 15 minutes from the same phone (no other phone exists yet) gets back in; `resetOwnerPhones` also clears wrong-PIN locks on the owner. Staff: at most 6 leave requests a day. An e-mail that keeps failing is given up after 5 tries (in-app alert stays).
71. ONE MODEL FOR A DAY (round 15): the late / early / going-out minutes of a day are worked out from the facts alone (check-in, check-out, outings, late / early requests, the leave of that day as it stands) by `deriveDay`, and `recountDay` makes the rows say exactly that after every tap and every change. The same facts give the same count whichever tap came first. This replaces the event-by-event booking and the "[was N]" notes of 67.
72. OPEN, for the owner (replaces 66): time away counts as "informed" because of a leave when that leave (a) existed before the arrival / leaving, (b) covered those hours (a half day only its own hours), and (c) was taken back by Aakash, Varun or a rule change on that day OR LATER. A leave the person cancelled herself, or one taken back before the day began, leaves an ordinary working day. Reason: coming to work on a day of approved leave must not earn a violation because the correction was tapped a day later.
73. A write that fails half-way is undone completely: changed rows are put back AND the new rows that did get in are blanked again, so every action is saved whole or not at all and can be tapped again.
74. A kept check-in photo (upload failed) belongs to one person and one day. A repeated phone request alerts once. An e-mail given up after 5 failed tries leaves an Audit row and an in-app alert for the owner. The owner's first sign-in repeated within 15 minutes from the same phone gets back in (also after `resetOwnerPhones`).
75. Requests per day (owner 20 Nov): counted per IST day, own sends only (edits and requests Aakash enters for someone are not counted). 4th and 5th: auto-approval becomes "Pending with Aakash"; 6th and later: "Pending with Varun" (a request that needs both stays with both); a records-only person stays "Recorded" but still sees the red warning. From the 7th, no alert is sent (Varun, Aakash, the person) so one phone cannot fill the alerts and the day's e-mails; the request is still in Approvals. Replaces the hard limit of 6 in 70.
76. Free outing once a day (owner 20 Nov): the first short outing of the day by approval time is free; any other outing of 15 min or less that day counts whole. The free outing still counts toward the "more than 2 hours away in a day" total (unchanged).
77. Round 17/18 fixes: duty hours are kept per day (a change applies from tomorrow); a late / early request after the punch is refused; "informed because of a leave" needs the leave GRANTED before the arrival / leaving and counts only the hours it covered; one early leaving = one row while nothing is approved; outings count only inside duty hours; a violation follows its day and rule when the rows of a day change shape; a closed day clears the manager's minutes too; an edit cannot move a leave wholly into a locked month; the month lock closes waiting late / early requests BEFORE working out the result; setup adds missing default rules after a broken first run; damaged cells (DayMinutes kind, MonthSheet rows) are left out and named instead of breaking screens.

## Next
- Owner still to answer: late/early request still PENDING when the person arrives - is "approved later = informed, rejected = not informed" right? (built this way)
- About 10 bug rounds with independent review agents (rule correctness; privacy and security; concurrency and dates; phone UI; upgrade and deploy safety; full shop-day simulation; edge cases; re-review of fixes). Done only when 2 rounds in a row have 0 Critical and 0 High.
- SCREENS MISSING (server side exists): Aakash / Varun cancelling or editing a staff member's leave from their phone; editing the members of a clash rule (the screen only switches a rule on or off).
- NOT BUILT YET: joining / leaving dates per person (waiting for the owner's answer on a mid-month joiner). Built after round 1 pointed them out: last 3 months on My month, possible clash with waiting requests, Shop-closed days screen, month lock by Aakash AND Varun (first confirms, second locks), pending card with rule result / who else is away / month so far, edit after approval goes back to pending.
- Design risks noted by round 2, still open: PIN hashes in the Sheet are 4-6 digit PINs (anyone who can open the Sheet could work them out: keep the Sheet private to the owner); GPS and the dress result come from the phone and can be faked by a technical person; the app shares the github.io address with the owner's other Pages sites.
- Before release: a NEW Sheet, NEW PINs and a NEW Devices tab. Nothing from the TEST deployment is reused. The owner signs in first, at once, so the bootstrap phone is his.
- Dress check on REAL shop photos (needs the owner or staff to take a few check-in photos at the shop).
- Staff guide (visual PDF, simple Hinglish), owner page (what to watch, what the system cannot catch).
- Release, only after the owner's OK: real Sheet "GJ Leave", real people / duty times / salary structure from the owner, new PINs, bind phones, set shop location, \`installTriggers\`, point \`docs/config.js\` at the real deployment.
- Redeploy recipe (TEST): open the Apps Script project, load \`apps-script/Code.js\` of the commit, save, run \`setupOrUpgrade\`, Deploy > Manage deployments > edit > New version > Deploy. Same URL. No Google permission needed unless a new Google service is added.
