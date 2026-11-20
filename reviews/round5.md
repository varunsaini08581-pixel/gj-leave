# Bug round 5 — Phone UI and usability

Independent review of the phone app in `/home/claude/gj-leave/docs`, demo mode (`?demo=1`), driven with Playwright / Chromium on 127.0.0.1 only.

- Sizes tested: 360x740 and 390x844 portrait (all three roles, every screen), 740x360 landscape (sign in, Today, check-in camera, Apply).
- Roles: staff (Neha, Vikas, Harsh), manager (Aakash), owner (Varun).
- Reproducers: `/home/claude/findings/repro-round5.py` (23 checks, one per finding; all 23 FAIL on the current code; about 3 minutes). Run `python3 repro-round5.py [docs-path] [--shots] [--only=R5-07]`.
- Screenshots: `/home/claude/findings/shots5/` (7 files).
- Nothing under `/home/claude/gj-leave` was changed.

**Note on the moving target.** `app.js`, `app-admin.js`, `index.html` and `mock-server.js` were rewritten while this review ran (18:16, 18:21 and 18:29 IST: "Also away / Month so far" on approval cards, shop-closed days, two-person month lock, last-3-months line, new update handling, sign-out told to the server). The last full run was at 18:31 IST against the 18:29 / 18:30 files: all 23 checks fail. The 18:29 change fixed the worst part of R5-02 (the reload loop), so that finding is now Low. One check-in run timed out once at the moment the files were being rewritten; it did not repeat, so it is not reported.

## Counts

| Severity | Count |
|---|---|
| Critical | 0 |
| High | 1 |
| Medium | 11 |
| Low | 11 |

Privacy: 0 findings. As a staff member, every management action (`approvals`, `pending`, `board`, `calendar`, `monthReport`, `getSettings`, `devices`, `disputes`, `incidentItems`, `restrictions`, another person's `myMonth`) answers FORBIDDEN, and nothing a staff phone receives contained another person's reason, note or salary. The clash message shows only "Neha is off on 27 Nov — Sales needs 2 of Neha, Vikas, Harsh present."

---

## High

### R5-01 — One tap on "Check out" ends the day, records a violation and a leave day, and nobody can correct it
- Screen: Today > Attendance, staff. Screenshot `01-checkout-one-tap.png`.
- The "Check out" button appears directly under the check-in time from the first second after check-in and acts on a single tap. No question, no time-of-day guard, no undo.
- Reproduced: Neha (duty 09:30–18:30) checks in at 09:26 and taps "Check out" once. Result: toast "Checked out.", `not-informed-over-30` violation, "Leaves taken 1", hint "1 violation (record only). 1 more = Rs 500 discipline bonus and target allowance would be lost."
- Aakash cannot repair it: "Enter a forgotten check-out" answers "Already checked out on that day.", "Enter a check-in" answers "Already checked in today." The only route is a dispute to Varun.
- Why High: this button is on the screen every person opens every day, next to the outing and late/early forms; a mis-tap costs a violation and a day.
- Fix: ask before checking out when it is before duty end ("It is 09:26. Your duty ends at 18:30. Checking out now counts 9 h 4 min as leaving early. Check out?"), and give Aakash a logged "undo check-out" entry.

### (R5-02 was High when found; the author changed it during the review. See R5-02 under Low.)

---

## Medium

### R5-03 — A slow answer replaces the screen of the tab opened after it; typed text is lost
- Screenshot `03-tab-race.png` (Today content under a highlighted "Apply" tab).
- Views draw whenever their call returns, without checking that the tab is still the current one. With the measured 2–3 s per call this is routine: tap Today, then Apply, start typing; the Today answer arrives and replaces the form. The same happens when an action finishes after the user moved on (`.then(VIEWS.approve)`, `.then(VIEWS.home)`).
- Fix: a render token in `go()` / `open()`; a view draws only if its token is still current.

### R5-04 — Screens stay on "Loading…" for ever after a failed call
- Screenshot `04-stuck-loading.png`.
- My month, Approvals and every More sub-screen (Calendar, Month report, Restrictions, People, Phones, …) end in `.catch(function () {})`. After the red toast disappears (6 s) the screen shows only "Loading…": no message, no retry; sub-screens also have no Back button. Only Today shows the error text.
- Also: `fetch` has no timeout, so on a hung connection the screen stays on "Loading…" and the pressed button stays disabled with no end.
- Fix: one shared error card ("Could not load. Check the connection." + "Try again" + Back) and a 20–30 s timeout.

### R5-05 — Sign-in screen prints "nullnull" (real mode) / "null" (demo)
- Screenshot `05-login-null.png`. `show()` passes `null` entries to `replaceChildren`, which prints them as text. In production every person sees "nullnull" above "Your name".
- Fix: filter null / false in `show()` as `h()` already does.

### R5-06 — A late / early request for another day disappears after sending; no late / early request can be cancelled
- Today > "Late or leaving early" accepts a future date ("Sent to Aakash. 30 min.") but lists only requests dated today. A request for tomorrow is shown on no screen of the sender until that day; nothing confirms it exists, and it cannot be withdrawn or corrected (there is no cancel for these requests at all, also for today's).
- Fix: list all open and upcoming late / early requests with their date and a "Cancel" control.

### R5-07 — "My month" is locked to the current month; "Open <name>'s month" from an older report opens the wrong month
- My month has no month control. On the 1st, last month's page is gone for staff: a violation recorded on the last evening of the month (end-of-day absent job) cannot be read or disputed in its 24 hours, and the final "would be deducted" working that staff argued about before cannot be seen.
- Month report > Oct 2026 > "Open Neha's month" shows "Neha · Nov 2026" (`V.month(p.personId)` ignores the report month): the manager reads November numbers believing they are October's.
- The opened page has no Back button and highlights the "My month" tab while showing another person.
- Fix: previous / next month on the page (reuse `monthNav`), pass the month through, add Back.

### R5-08 — An unexcused absence stays in Approvals as "waiting" for ever
- `approvals.absences` is every request with status "Absent – unannounced", of any age. The only button is "Humanitarian – excused". If Aakash rightly does not excuse it, the card and the red badge never go away (reproduced with an absence 46 days old: "1 waiting"). After a few weeks the badge no longer means anything.
- Fix: a "Keep as absent" button that clears the card, or show absences for a few days only and leave them out of the badge.

### R5-09 — The phone's Back button leaves the app from any screen
- No screen is added to the browser history (`history.length` stays the same). Android Back or the iPhone back swipe closes the installed app, or goes to the previous website in a browser tab, from every sub-screen and from the camera, losing a half-filled form. Staff on Android use Back all the time; the on-screen "‹ Back" exists only on More sub-screens.
- Fix: `pushState` on tab / sub-screen / camera open, and handle `popstate`.

### R5-10 — Nothing refreshes by itself; a person waiting for approval keeps seeing "Pending with Aakash"
- Going out: after sending, the card says "Wait for the approval before you leave." Five minutes after Aakash approved, and after the app was brought back to the front, it still says Pending. The outing clock runs from Aakash's approval, so the person either waits without need or leaves without having seen the approval. There is no push by design, which makes the screen the only signal.
- Same for Aakash: the Approvals badge is counted only when he opens Today or Approvals.
- Fix: refresh the current tab on `visibilitychange` / focus and every 20–30 s while something is pending; or at least a "Refresh" button and the line "Tap Today to check".

### R5-11 — Irreversible actions happen on one tap, with no question
- More > Set a PIN (owner): the list is pre-set to the first name. One tap on "Create new PIN" replaces Neha's PIN at once; her old PIN stops working.
- Apply > My requests > "Cancel this request": cancels an approved leave at once. Re-applying restarts the notice clock, so the same leave may come back as Emergency or Unannounced.
- Phones > "Remove this phone": "A removed phone can never sign in again", one tap. (Removing the only owner phone is correctly refused.)
- Fix: a confirm step naming the person and the effect; start the PIN list on "Choose a person".

### R5-12 — Calendar is wider than the phone at 360 and 390 px
- Screenshot `12-calendar-overflow.png`. The chip "Clash risk: Sales, Calls, Repairing, Repair pool" is `white-space: nowrap`; the page becomes 412 px wide. The left edge of every row and the "Today" tab are cut off or the whole page shrinks. It appears on every 1st–4th Sunday, so every month.
- Fix: let that chip wrap or put it on its own line.
- Related, not counted separately: the handoff asks for a month grid with group colours; the screen is a 30-row list.

### R5-13 — A violation on "My month" shows an internal key and not the note
- Screenshot `13-violation-raw-key.png`. The line reads "20 Nov: Recorded by Aakash: job-sheet" (also `display-photo`, `chai-cup`, …) with "Dispute (within 24 hours)" under it. Aakash's note ("Sheet not filled for job 4411") is not sent to the person at all. The handoff lists "date, rule, proof, dispute button". The person has 24 hours to dispute something the page does not describe.
- Fix: send the item's display name and the note; show them on the line.

---

## Low

- **R5-02 — Old cached app (was High: endless reload loop; now a message that vanishes).** On the code up to 18:28 IST an UPDATE answer called `location.reload()` every time: 73–85 page loads in 4 seconds, no message, one server call per loop. The author's 18:29 change (version number moved into `app.js`, one reload per session, `?v=` on the script tags) removes the loop; the check confirms that. What is left: the text "This copy of the app is old. Close the app completely and open it again…" is only a 6-second toast; after it the person sits on the sign-in screen with an empty name list and no explanation. Show it as a fixed card on the screen. In demo mode the single reload also drops `?demo=1`.
- **R5-14 — No offline screen.** No service worker is registered. Opened without network, the installed app shows the browser's error page. Related, by reading only: the manifest has only an SVG icon and there is no `apple-touch-icon`, so the home-screen icon on iPhone (and possibly the install prompt on some Android versions) needs a check on real phones.
- **R5-15 — Framing guide is not on the picture.** Screenshot `15-camera-guide.png`. The dashed frame is sized from the screen area, the picture from the camera's shape; in landscape the frame runs over the black bars (picture x 219–520, guide x 44–695), so "whole shop inside the frame" cannot be judged from it.
- **R5-16 — "Edit person" Save can do nothing.** If a person's Sunday pattern is not one of the four in the list (for example 2nd and 4th, typed in the Sheet), the list is blank, `JSON.parse('')` throws, `busy()` swallows it: no save, no message. `busy()` hides every such error app-wide; it should at least show a toast.
- **R5-17 — Two different numbers for one request.** Late request 09:30 → 10:15: preview "This uses 35 min. Bank left after this: 85 min.", then toast "Sent to Aakash. 45 min."
- **R5-18 — Edit mode is nearly invisible.** After "Edit" the heading stays "Apply for leave", the only sign is a 3-second toast and the button text "Save changes"; there is no "Stop editing"; a half-day form labels its date "First day". A person can believe they are making a new request and overwrite an approved one.
- **R5-19 — Notifications and phone labels.** Notifications show a clock time only ("11:05"), so yesterday's look like today's, and "Recent" on Today shows no time; bodies carry raw dates ("Vikas: 2026-12-07, 2026-12-08, …"). Phones and the "New phone" approval card label a phone with the raw browser string ("Mozilla/5.0 (Linux; Android 10; K) AppleWebKit…"), which is the same on every Android phone, so the owner cannot tell which phone he is approving.
- **R5-20 — Accessibility basics.** Most fields have no programmatic label (visible `<label>` without `for`; outing fields have placeholders only). "Applies to" and person tick rows are 21 px high (target is about 40). `#app` is one `aria-live` region, so a screen reader re-reads the whole screen on every draw. The current tab has no `aria-current`. Pressing Enter / "Go" in the PIN field does nothing. Chip text contrast is 4.44–4.49:1 (green, amber, blue), just under 4.5.
- **R5-21 — Special approval after Aakash's yes.** The request stays in his list as "1 waiting" with live Approve / Reject and keeps the badge. Chip and toast say "Special – waiting"; the handoff's wording is "Special – waiting for Varun". The preview for a December request says "Above the 5 free leaves this month by 2".
- **R5-22 — Photo is thrown away if the upload fails.** After "Take photo", a failed `checkIn` call returns to "Check in" with "No connection. Please try again."; the second person or tripod must be set up again and the arrival time moves later. Keep the photo and offer "Send again". There is also no look-at-it / retake step before the photo is final.
- **R5-23 — Messages that do not match.** (a) A Google error page (quota, outage) is reported as "No connection. Please try again." (b) With location refused, "Set shop location" runs "Reading 1…5 of 5" for about 6 s, then leaves "Reading 5 of 5…" on the card; the toast does not mention the location permission. (c) Demo only: "Clash rules" is an empty page although rules are in force. (d) Roles show as raw lower-case "staff / manager / owner"; "Overrides by Varun" lists the person id and raw dates; "Saved. 520 min before duty end." (e) After a rejected outing the card simply resets; the reason is only under "Recent".

---

## Needs a test on real phones (not counted; could not be decided in a desktop browser)

1. **Auto-rotate off.** "Take photo" is enabled only when the camera stream is wider than tall. With screen rotation locked (common on Android; iPhone ignores the manifest's orientation), a browser tab may keep delivering a portrait stream even when the phone is held sideways; the hint then says "Turn the phone sideways" for ever and check-in cannot be done on that phone. If this happens on any staff phone it is Critical for that person. Test on each staff phone with rotation locked, both installed and in the browser; if it fails, add "switch on auto-rotate" to the hint or judge orientation from the device sensor.
2. **On-screen keyboard and the fixed tab bar** on the long forms (Apply, Enter leave, People): check that the focused field and the Send button are not covered.
3. **Dress model download.** Each first check-in after opening loads the MediaPipe bundle and model from two outside sites; on slow mobile data "Saving the photo…" can last up to the 12 s limit before the check-in is sent.

## Checked and found working

Sign in, wrong PIN message, new phone waiting for approval; apply full / half / multi-day with live result; clash shown with Send disabled; restricted dates above the form; special approval notice; cancel; late / early with effect preview and required time; going out → approve → I'm back → confirm, "still open", Remind; check-in with fake camera in portrait and landscape viewports (back-camera constraint `exact: environment` confirmed; portrait stream disables "Take photo"); stamp drawn; Today at GJ photo; My month numbers and estimate label; dispute within 24 hours, button gone after 24 hours, empty dispute refused; manager approvals of every kind, reject needs a reason, close an outing (time required and checked), dress flag confirm / dismiss, record incident, enter leave with call time, enter check-in, forgotten check-out; month report; restrictions; shop location; owner disputes, override, people and pay, grace table, removing the only owner phone refused, deactivating the only owner refused. Double tap on Send request sends once. No console errors on any screen. No Hinglish or emoji in the UI; "kachra (rubbish)" follows the bracket rule.
