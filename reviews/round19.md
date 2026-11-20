# Round 19 review - GJ Leave & Attendance, commit ab1f7f3 (server version 9, schema 4)

Scope: `git diff aef799d ab1f7f3 -- src docs` (round 17/18 fixes, owner rules of 20 Nov 23:46: requests per day, free outing once a day),
plus the author's mid-review change to src/gas/main.js (onOpen menu, setOwnerPin, resetOwnerPhonesFromMenu).

| Severity | Count |
|---|---|
| Critical | 0 |
| High | 1 |
| Medium | 2 |
| Low | 1 |

Reproducers: /home/claude/findings/repro-round19.test.js (node:test, 4 tests, all 4 FAIL on ab1f7f3 at their final assertion; set-up asserts pass).
UI check: /home/claude/findings/repro-round19-ui.py (Playwright 390x844, demo mode). It found no problem.
Project suite: `node --test` = 459 tests, 458 pass, 0 fail, 1 skipped.

Hashes of src/ + docs/ (sha256 over sorted file hashes): start ca6b2f03...e325, end c5ac70e0...59c1. They CHANGED. `git diff --stat ab1f7f3 -- src docs` shows only
src/gas/main.js (+39 lines). The author made that change during the review and told me about it (the coordinator's heads-up). I changed nothing in the repo.
docs/mock-server.js shows no diff against ab1f7f3.

---

## R19-1 (High) An edit is decided without the per-day request rule: the 4th-6th request of a day is auto-approved by editing it
- Where: src/server/admin.js `editLeave` (line ~146) calls `H.evaluate` but not `requestLimit`. `Core.previewLeave` (core.js:417-419) does call `requestLimit` with `input.editId`.
- What happens: Neha sends 4 requests on 20 Nov. The 4th is "Pending with Aakash" because of the per-day rule. She taps Edit and moves it to another day. The Apply screen preview (previewLeave with editId) shows "Goes to Aakash" and the red line "This is request number 4". On Save the request becomes **Approved** by the system. The same happens with the 6th and later requests that went to Varun.
- Steps: test `R19-1` (3 sends, each cancelled; 4th = Pending with Aakash; preview of the edit = 'aakash'; editLeave returns 'Approved').
- Why it matters: the owner's rule says these requests "always go for approval". A staff member gets past it with an ordinary Edit, maybe without meaning to. The phone also tells her the opposite of what happens. The Approvals card loses the request and no one is alerted.
- Suggested fix: in editLeave, run the same `requestLimit` as previewLeave, keeping the request's original send day: count the sends of the IST day of `history[0].at`, excluding this id. At least, never let an edit fall to 'auto' while the request is one of the 4th+ of its day. Then preview and save give the same decision. Also decide what the edit preview should count (today vs the request's own send day). Today the preview counts today's sends, so editing an old request on a busy day shows a red "request number N".

## R19-3 (Medium) One Settings save that changes duty hours AND the Sunday roster / records-only / active delays the roster change to tomorrow
- Where: src/server/admin.js savePerson (~line 244): `until = hours ? H.today(ctx) : yesterday`. The history entry then stores the OLD sundayOff / noApproval / active "until today".
- What happens: on Sunday 22 Nov at 08:00, Varun gives Vikas today off (sundayOff [1,2,4]) and new hours in one save. The board shows "Not in yet" instead of "Roster off". The end-of-day job marks Vikas **absent** on 22 Nov (system leave + absent-no-request violation). The same save without the hours change works (control in the test).
- Steps: test `R19-3`.
- Why it matters: it gives a wrong absence and violation, and the comment says "the other changes from today". Varun can take the absence back, and it needs both changes in one save, so Medium.
- Suggested fix: when hours change together with other fields, write two history entries: one "until yesterday" with the old roster/active/noApproval and old hours, and one "until today" with the NEW roster/active/noApproval and old hours. Or keep the hours history apart from the roster history.

## R19-4 (Medium) The owner's "first phone in use" marker is set only on writes, so an owner who only reads can still be signed out (round 18 M3 is not fully closed)
- Where: src/server/api.js:303-306. The `decidedBy: 'bootstrap' -> 'bootstrap-used'` update sits inside the write path (`locked(...)`). READ_ONLY actions (me, board, approvals, today ...) return before it. A write that fails is rolled back together with the marker.
- What happens: the owner signs in for the first time (bootstrap) and opens screens (me, board) without saving anything. Within 15 minutes a second sign-in with his PIN and the same device label gets `approved` at once. It takes over the same device row with a new token, and the owner's phone gets AUTH (signed out).
- Steps: test `R19-4` (the round 18 M3 test without the setPin write).
- Why it matters: the owner is locked out of his phone. It needs the owner PIN, a phone of the same kind, and the first 15 minutes after the very first owner sign-in, so Medium.
- Suggested fix: set the marker in the read path too, e.g. in `Core.authenticate` or before the READ_ONLY return, as a small separate write. Or tie the 15-minute retry to "token never used" (a lastSeenAt on the device row).

## R19-2 (Low) The red "request number N" line on the Approvals card counts requests sent LATER that day
- Where: src/server/views.js:93-95. `H.sentOnDay(ctx, r.personId, h0.at, r.id) + 1` counts every own send of that IST day except this one, not only the ones before it. The same line is in docs/mock-server.js.
- What happens: Neha's first request of the day (short notice, Pending with Aakash) is followed by 3 more. Aakash's card for the FIRST request shows in red "Request number 4 from Neha on that day. Too many".
- Steps: test `R19-2`.
- Why it matters: the warning is wrong and could lead Aakash to reject a normal request. The routing is not affected.
- Suggested fix: count only sends with `history[0].at < h0.at` (and same day), e.g. give sentOnDay an `before` bound.

---

## Checked, no finding
- syncViolations "heir": `db.update` changes the live row object, so a second orphan cannot take the same heir (no double violation).
- knownByLeave: "granted before" needs `decidedAt` for 'cancelled', and only Approved leaves are rejected/shortened by a rule change. Two-approver leaves use the last approval. A pending (never approved) leave cannot make lateness informed.
- requestLimit routing: auto->aakash (4th/5th), ->varun (6th+), special stays special, recorded stays recorded with the warning, blocked unchanged. Requests Aakash enters and called-emergency entries are not counted. Quiet from the 7th (no alerts).
- Free outing: markFreeOuting sorts by approval time per day and ignores closed days and days that do not count (minutes 0). A corrected back time / an outing closed by Aakash recounts the day. The effect preview says "free outing used" when a short row of that day exists.
- lockMonth now closes waiting short requests (with recount) before the results; outings and dress are closed before too.
- Phone app (Playwright 390x844, demo): the Apply form shows the red warning (class warn red, background rgb(253,232,232)) and "Goes to Aakash" for the 4th request. The refresh `seq` guard drops stale home/approvals answers. I did not exercise the start-screen failure path ("Could not load" + Try again / Sign in with PIN); I only read it.
- src/gas/main.js (author's mid-review change, read only, Apps Script): setOwnerPin uses the same salt + sha256(salt:pin) as core.setPin, clears pinTries / pinLockedUntil / pinLockLevel, writes Audit, takes the script lock and releases it in finally, and bumps the People/Audit cache versions. resetOwnerPhonesFromMenu asks Yes/No and then calls the existing resetOwnerPhones. I found no defect.

## Not reproduced / not counted
- `dayOver` (core.js:593), the half-day check (core.js:322, 392) and the leave-started checks (admin.js:140, core.js:762/773) still use the CURRENT duty hours, not `Cal.asOn`. On the day of an hours change, "day over" and the edit lock can disagree with the hours the day is judged by. I did not build a failing case in time.
- After sending, the phone shows only a toast "Request: Pending with Aakash". The red text is not repeated after the send. This is a design choice, not a bug.

## Questions for the owner (not counted)
1. Should an edit of a request keep that request's place in the day's count (so edits stay with Aakash / Varun), or be free? R19-1 assumes it keeps its place, because the preview already behaves that way.
2. The Sheet menu "Set owner PIN" works for anyone who can edit the Sheet. If Aakash (or anyone else) has edit access to the Sheet, they can set the owner PIN and, with "Reset owner phones", sign in as owner. Is the Sheet shared with edit rights with anyone but you?
