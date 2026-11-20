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

## Assumptions made in code (to show the owner together, not blocking)
1. Per-day clash also covers "Going out". Flagged to the owner twice, no objection.
2. Auto violations for a leave (unannounced / 3rd+ emergency / restricted period) are recorded when the leave is GRANTED, not when it is only requested. If Aakash rejects it, no violation from that request.
3. Reason list on the form: Sick, Family function, Family emergency, Personal work, Travel, Exam, Other (+ free text always required). The handoff says "from a list" but gives no list.
4. One request = consecutive dates only. Non-consecutive days need separate requests.
5. PIN is 4 to 6 digits.

## Next
- Sheet store adapter + Apps Script entry (doGet/doPost), idempotent setup function, build script that bundles `src/` into `apps-script/`.
- Short leave / late / early / going-out requests and check-in/out in the server core (uses `minutes.js`).
- Absent-with-no-request end-of-day job, edit-after-approval, 12-person month simulation.
- First phone screens.
- Needs the owner's Chrome: create test Sheet "GJ Leave - TEST", paste/deploy Apps Script, Google "Allow".
