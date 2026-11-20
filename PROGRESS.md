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

## Open questions (provisional defaults are in code, clearly marked; nothing is final until the owner answers)
1. A "not informed, more than 30 min" late gives an immediate violation. Does it ALSO count as one of the not-informed times (pass counter)? Default now: no.
2. "Every extra 2 hours beyond the bank = 1 violation": do not-informed minutes beyond the bank count toward those 2 hours, or informed minutes only? Default now: informed only.
3. Clash rules for short windows: do two people clash only when their away TIMES overlap, or whenever both are away at any time on the same DAY? Not coded yet.
4. Away between 2 h and 4 h 30 min in one day = half day (0.5 leave); more than 4 h 30 min = full day. Told to the owner, not yet confirmed.

## Blocked
- Repo `gj-leave`: waiting for the owner to create it and give Claude access.

## Next
- Clash rules C1-C4 with tests in both directions (needs answer 3).
- Notice types, quota, Anita rules, who-decides routing.
- Test Sheet + Apps Script skeleton; first deploy through the owner's Chrome.
