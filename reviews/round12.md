# GJ Leave & Attendance - bug-hunt round 12 (everything except the counting rules)

Reviewed: commit 0d23639, server version 9, schema 4. Independent review; nothing inside `/home/claude/gj-leave` was changed, git was not run, no network was used (phone app served on 127.0.0.1 in demo mode).

Files: `src/` and `docs/` (25 files) were hashed (sha256) at the start and at the end: **no file changed during the review**.

Project suite (`cd /home/claude/gj-leave && node --test`): **320 tests, 319 pass, 0 fail, 1 skipped**.

Reproducers: `/home/claude/findings/repro-round12.test.js` (19 tests, all FAIL on the current code, each for the reason in its name) and `/home/claude/findings/repro-round12-ui.py` (python3 + Playwright, called by the test file; the 8 phone-app tests skip cleanly when Playwright is missing). Run: `node --test /home/claude/findings/repro-round12.test.js`.

## Result

| Severity | Count |
|---|---|
| Critical | 0 |
| High | 1 |
| Medium | 5 |
| Low | 10 |

Plainly: **no Critical. One High** (the owner can lock himself out of the app for good from the phone app; no privilege escalation and no privacy leak were found). Access control and privacy held everywhere I pushed.

## What was checked and held

- **Access control.** 58 actions x 7 callers (staff x2, manager, owner, a phone still waiting for approval, signed-out, right name with another person's token) x base / empty / wrong-shaped args plus 41 hostile values in every field (null, 0, -1, Infinity, booleans, lists, nested lists, objects, `__proto__` / `constructor` / `toString` / `hasOwnProperty`, formula text, 2026-02-30, 9999-99-99, 2,000-character text, ids of other tables, other people's ids, extra `role` / `personId` / `__proto__` keys): about 39,000 calls on the real store + cache. **0 internal errors, 0 actions a staff member or an unapproved phone could do beyond their own.** Every refused call left the Sheet unchanged (except a counted wrong PIN).
- **Privacy.** Every read action for staff, manager and owner scanned for marker reasons, outing reason, incident note, dispute text, e-mail, phone, salary numbers, PIN hash / salt, token hash. Staff replies: none. Manager: reasons and notes only (allowed), no e-mail, no dispute text, no pay numbers. Owner: as designed. Full photo of another person: refused for staff.
- **Login.** Wrong-PIN lock, lock while the right PIN is sent, sign-out, revoked / pending / inactive, only-owner-phone guard, 3 waiting requests cap: as described in assumptions 27 and 32.
- **Round 10 fixes re-tested:** history cap + 10 edits, TOTAL_MAX (also checked that the `photo` / `thumb` exemption cannot be used to store anything), typed staff fields, e-mail mark-then-send, setPin clears the lock level, typed token -> AUTH, closed-day check-in, late / early limits: all hold. (`findings/repro-round10.test.js` H1a/H1b "fail" only because their own set-up still expects the 11th edit to be accepted; the fix refuses it.) Rounds 7, 8, 9 reproducers: all pass.
- **Restructure of this commit** (syncLeaveViolations, closed days left out of counts, recheckClashes shortening, staffLeaves / approvals, typing()): nothing new opened on the access, privacy or store side. typing() does stop a redraw of a filled form at the moment the refresh starts, and untouched Today / Approvals still refresh; what is left is M1, M2, L1.
- **Damaged cells.** Every column of every tab set to 13 kinds of garbage, then 30 actions and the 4 jobs: jobs never fail; the cases that still break are in M5.
- **Text.** No emoji, no non-English UI text in `docs/` or in server messages (two item names from the owner's own list: "Chai cup", "Wrapper / kachra (rubbish)").

## Findings

### H1 - High - The owner can lock himself out for good (one phone token per phone; no way back for an owner without his token)
- **Where:** `docs/app.js` `viewLogin` (`saveDevice({ personId, deviceToken })` after every successful sign-in: one slot per phone); `src/server/core.js` `loginLocked` (bootstrap only while no owner phone is "approved") and `decideDeviceLocked` (owner only).
- **What happens:** Signing in as another person on the same phone, with that person's right PIN, overwrites the phone's stored token. When the owner then signs in as himself, the phone has no token for him: the server makes a new phone request. His old phone entry still says "approved", so the bootstrap rule does not apply; only the owner can approve a phone; he is signed in nowhere. Result: "This phone is waiting for the owner's approval" for ever.
- **Steps (H1a, phone app):** Varun signed in on his phone -> More -> Sign out -> choose Neha, enter Neha's PIN (he created it) -> Sign in ("waiting for approval") -> choose Varun, enter his PIN -> Sign in. He is not let in. Server: Varun has one "approved" phone (token gone) and one "pending".
- **Steps (H1b, server):** owner with one approved phone signs in with the right PIN and no token (new phone, cleared browser data, broken phone): `pending`; Aakash's `decideDevice` is FORBIDDEN and he does not see phone requests.
- **Why it matters:** From then on nobody can approve a phone, set or reset a PIN, decide a dispute, give the second approval of a special request, decide Aakash's leave, lock a month as owner, or open Settings. The only way out is a hand edit of the Devices tab. The owner trying a staff account on his own phone is an ordinary thing to do in the first week; a replaced or lost owner phone gives the same end state. For a staff member the same overwrite costs a new approval by the owner (recoverable).
- **Suggested fix:** (1) Phone: keep tokens per person (`{ personId: token }`), never overwrite another person's token. (2) Server: a recovery path that does not need a signed-in owner, for example an editor-only function `resetOwnerPhone()` in `gas/main.js` that revokes the owner's phones so the next owner sign-in is the bootstrap again (document it on the owner page); or let a new owner request with the right PIN replace the old phone after a one-time code printed from the editor.

### M1 - Medium - The automatic refresh still empties a form when its answer arrives after typing began
- **Where:** `docs/app.js` `refresh()` / `typing()`; `VIEWS.home`, `VIEWS.approve` draw in `.then` without asking again.
- **What happens:** `typing()` is asked only when the refresh starts. The answer comes 2-3 s later (PROGRESS: about 2.3 s per screen) and `show()` redraws. What was typed in between is gone.
- **Steps:** M1a staff, Today: refresh starts, type the late / early time within 2.5 s -> field empty. M1b Aakash, Approvals: type the reject reason in the same window -> empty.
- **Why it matters:** Every 30 s and every time the app comes to the front, on the two most used screens. Workaround: type again.
- **Suggested fix:** in the refresh path, check `typing()` (and that the tab is still the same) again right before `show()`; drop the answer if true.

### M2 - Medium - Every automatic refresh throws Today / Approvals back to the top
- **Where:** `docs/app.js` `show()` (`window.scrollTo(0, 0)`) used by the 30-second refresh.
- **What happens / steps:** Aakash, Approvals with 6 requests, scrolled to 900 px (Raunak's card mid-screen); 31 s later the page is at 0 px and Vikas's card is at the same place.
- **Why it matters:** A list longer than one screen cannot be read for more than 30 s; Approve is one tap with no question, so a tap can land on another person's request.
- **Suggested fix:** keep `scrollY` across a refresh redraw (scroll to top only on navigation), or redraw only when the data changed.

### M3 - Medium - One long word in a reason makes Approvals and "Staff leaves" several phones wide
- **Where:** `docs/styles.css` (no `overflow-wrap` on text in cards), `docs/app.js` approvals card, `app-admin.js` `V.leaves`.
- **What happens / steps:** Vikas sends a leave with a 171-character reason without spaces (a pasted link; the form allows 200, the server 2,000). Aakash's Approvals page is 1,349 px wide on a 390 px phone; the fixed tab bar stretches with it and "More" is off the screen.
- **Why it matters:** A staff member can, by accident or on purpose, make the approval screens of Aakash and Varun awkward until that request is decided. Workaround: scroll sideways / zoom out.
- **Suggested fix:** `.card, .list li, .muted, p { overflow-wrap: anywhere; }` and `#app { overflow-x: hidden; }`.

### M4 - Medium - A Sheet error in the middle of a flush leaves "Leave: Approved" told to the person while the request is still pending
- **Where:** `src/server/store.js` `write()`: appended rows (Notifications, Audit) are written before changed rows.
- **What happens / steps:** `decideLeave` approve; the Sheet fails on the row update after the appends went through. Aakash sees "Something went wrong"; the request is still "Pending with Aakash"; Vikas has the alert (and e-mail) "Leave: Approved"; Audit says `leave.decide`.
- **Why it matters:** The person believes the leave is granted. Needs a Sheets failure at that moment; Aakash can tap again.
- **Suggested fix:** write the changed rows first and the appends last (a missing alert is the smaller harm), or on a failed flush append a "please ignore the last alert" correction.

### M5 - Medium - A cell damaged by hand still takes an action down for everyone
- **Where:** `src/server/attendance.js:173` (`JSON.parse(shop)` with no guard; `api.js me` guards the same value); `rules/clash.js` / `leave.js` on `Rules.members`, `Rules.emergencyIfAllPresent`, `Restrictions.appliesTo` when the cell holds valid JSON that is not a list.
- **What happens / steps:** M5a `shopPoint` mistyped in the Settings tab -> every check-in that carries a location answers "Something went wrong"; each try has already stored its photo in Drive. M5b `Rules.members` = `null` (or `12`, `{"a":1}`) -> every leave preview / request / decision, late / early and going-out request fails for everyone.
- **Why it matters:** Whole-shop outage of check-in or of leave requests from one wrong cell. Workaround: hand check-in by Aakash; repair the cell.
- **Suggested fix:** guard the parse (bad shop point = "no shop point", reported in the daily summary); in `store.decode` return the JSON default when the parsed value is not of the expected kind (list for these columns).

### L1 - Low - "I will leave early" falls back to "I will be late" at the next refresh
`docs/app.js` `shortCard`: the switch is not a form field, `typing()` does not see it. Choose "I will leave early", wait for a refresh, enter the time: it goes as a late request (usually refused, confusing). Fix: keep `kind` outside the redraw or count it in `typing()`.

### L2 - Low - 320 px phone: "Special – waiting for Aakash and Varun" chip does not wrap
Page is 371 px wide on a 320 px phone (Approvals, Staff leaves; the person's own "My requests" has the same chip). Fix: `.row .chip { white-space: normal; }` or the existing `.wrap` class.

### L3 - Low - "Sign out" without a connection does not sign out on the server
`docs/app.js` `signOut()` swallows the failed call. The sign-in screen is shown with only the general "No connection" toast; the token on the phone still opens the account without the PIN. Fix: say "Could not sign out: no connection" and keep the person signed in, or retry at the next start.

### L4 - Low - E-mail job: a send that failed for a passing reason is never tried again
`src/server/jobs.js` `sendEmails`: every exception of `mailer.send` is filed as -2 "address refused". One "Service invoked too many times" and those alerts are never e-mailed (in-app still works). Fix: mark -2 only for an invalid-address error; otherwise clear the mark so the next run retries (with a small retry count).

### L5 - Low - Manager / owner free-text fields accept non-text
`decideLeave`, `cancelLeave`, `decideShort`, `decideOuting`, `excuseAbsence`, `manualCheckIn/Out`, `recordIncident.note`, `decideDispute.note`, `overrideLeave.reasonCode/reasonText`, `saveRule.label`, `saveRestriction.note`: an object is stored and shown to the staff member as "[object Object]", a list is joined with commas. API only. Fix: the same `typeof === 'string'` check round 10 added for staff fields.

### L6 - Low - Aakash's own waiting leave is in his own Approvals
`src/server/api.js` `approvals` / `pending`: "Pending with Varun" requests are listed for the manager, with Approve / Reject that can only answer "Nobody approves their own leave", and they count in his badge. Fix: leave out `r.personId === actor.id` (and route `varun` for a manager).

### L7 - Low - A first sign-in repeated after a lost reply leaves two identical phone requests
`core.js loginLocked`: two "Harsh · New phone" cards with the same label; only the second belongs to the phone in his hand. Approving the first changes nothing for him. Fix: a new request by the same person replaces the older waiting ones (or show the request time and "newest" on the card).

### L8 - Low - `setSetting('graceTable')` is not checked
`admin.js setSetting`: `[null]` (API only) is stored; "My month" then fails for everyone and no incident can be recorded; `grace: "many"` means never a violation. Fix: list of `{ key, item, grace >= 0 number, per: month|quarter }`, keys from the default table.

### L9 - Low - Overlapping check-ins leave an extra photo in Drive
`api.js PREPARE.checkIn` stores the photo before the lock; the copy that loses is refused inside the lock, its file stays in Drive, linked from nowhere. (Also every try in M5a.) Fix: on a refusal inside the lock, trash the file (an `env.deletePhoto`), or store after the lock in a second short step.

### L10 - Low - Month report "Overrides by Varun" shows the internal person id
`views.js monthReport` returns only `personId`; `app-admin.js` prints it ("garvit-id51: 2026-11-25 — ..."). Fix: add `name` and print it with `niceDates`.

## Not reproduced / needs the real deployment (NOT counted)

1. **Apps Script daily runtime quota.** Today / Approvals poll every 30 s (2-4 calls each, about 0.5 s server time per call) plus the e-mail job every 5 minutes. With several phones left open on Today this may approach the daily execution-time limit of a consumer Google account, after which every call fails until the next day. Needs measuring on the real account.
2. **Sign-in hammering.** `login` is public and takes the script lock; a stream of wrong-PIN calls from outside can keep the lock busy and fills the Audit tab. Also (known, assumption 27) an outsider can keep new-phone sign-in of any person locked up to 24 h at a time; the owner's reset clears it.
3. **iPhone Safari storage clearing** (site data dropped after days without use when the app is not on the home screen) would lose the phone token: a new approval for staff, H1 for the owner.
4. **Leading apostrophe.** Text that starts with `'=`, `'+`, `'-`, `'@` may lose its apostrophe on a real Sheet (the Sheet and the store each strip one); cosmetic.
5. **`installTriggers`** writes the `startDate` row by column position (key, value, ...); wrong if the Settings columns were reordered by hand.
6. **`photo` thumbnails** use the 6-hour header cache with live rows: a column inserted by hand in Thumbs would make "Today at GJ" fall back to full photos (slow) for up to 6 hours.
7. **E-mail mark-then-send:** a run killed between the mark and the send loses those e-mails (chosen in round 10; in-app alerts stay).
8. **Timers not installed:** no absent check, no reminders, no e-mails, and nothing in the app says so.
9. **Phone Back while the camera is open:** the screen behind is redrawn, the camera stays; looked harmless, needs a real phone.
