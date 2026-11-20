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

## To confirm with the owner (not blocking)
1. Per-day clash also covers "Going out". Built this way; flagged to the owner, no objection so far.
2. Emergency "1 extra day": coded as 1 day's salary on top of the normal quota rule, even when the person is still inside the 5 leaves. Example sent to the owner for confirmation.
3. "Leave allowed with Rs 500 penalty" restriction: coded as Rs 500 per restricted day (the old WhatsApp line says "Rs 500 per leave").

## Blocked
- Repo `gj-leave`: waiting for the owner to create it and give Claude access.

## Next
- Restrictions (blackout periods), 3rd-emergency violation, absent-with-no-request, edit/cancel re-check.
- 12-person month simulation against a hand count.
- Test Sheet + Apps Script skeleton; first deploy through the owner's Chrome.
