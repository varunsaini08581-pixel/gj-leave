# GJ Leave & Attendance — Review round 10: second pass on privacy, security and concurrency

Reviewer: independent (did not write the code). Date: 20 Nov 2026.
Code reviewed: `/home/claude/gj-leave` as it stood at 19:23 IST (server version 9, schema 4).
Reproducers: `/home/claude/findings/repro-round10.test.js` — 11 tests, **all 11 fail on the current code**, each for the reason in its name
(`node --test /home/claude/findings/repro-round10.test.js`). The project's own suite: 293 of 293 pass.

**The code did not change during the review.** I hashed every file at the start and at the end (598 files, same content).
I did not run git, did not use the network and wrote nothing outside `/home/claude/findings/` (scratch scripts in `/tmp` only).
One thing to know: to see what the public history still holds, I read the loose objects under `.git/objects` with a read-only Python script (no git command).

## Counts

| Severity | Count |
|---|---|
| Critical | **0** |
| High | **1** (H1) |
| Medium | **3** (M1, M2, M3) |
| Low | **3** (L1, L2, L3) |
| Design risks / needs the real deployment | 9 (D1–D9) |

Plain verdict: **privacy and access control held up completely** — I could not read a salary figure, another person's reason, note, dispute text, e-mail, phone label or any PIN / token data as a staff member or an outsider, and the manager could not do one owner-only thing. **Overlapping requests held up** on every new write path. What did not hold up is **resource limits**: every finding below is some form of "a limit is checked per piece, or not at all".

---

## High

### H1 — A staff member can make his own leave request impossible to reject, approve, cancel or edit — for everyone

- **Where**: `admin.js:147` (`editLeave` appends `{ action: 'edited', from: { dates, kind, status } }` to `history` on every edit, with no limit on the number of edits); `store.js:162-170` (`flush` refuses the whole write when one cell is over 49,000 characters); every other action on a leave also appends to `history` (`core.js:527`, `:603`, `:630`, `:635`; `views.js:151`; `attendance.js:345`, `:713`).
- **Attack** (own approved phone + a script): send a request, then edit it again and again. Each edit copies the old dates into the history cell. The person sees the history in `myLeaves`, so he can stop a few characters under 49,000. Measured: **255 edits** for Raunak (6 dates at a time); **10 edits** for a person with no clash rule (Anita: a 380-day request is accepted as "Special – waiting").
- **Result (reproduced)**: from then on any action on that request adds one more history entry, the cell is too long, nothing is saved and the reply is "Something went wrong":
  - Aakash cannot reject or approve, Varun cannot reject, cancel or edit; Varun's override is refused ("already has a request on these dates").
  - The evening job does not mark the person absent on those days (a waiting request holds the day): **no "Absent – unannounced", no violation**. The days only count as leave days.
  - `lockMonth` for that month fails for ever (the lock closes waiting requests, which adds a history entry) — the month can never be locked.
  - The request reminds Aakash every 2 hours for ever; the 255 edits themselves raised 253 alerts for him.
  - The only way out is editing the Sheet by hand.
- **Severity note**: by the letter of the rubric this touches "any staff member can change a violation outcome". I rate it High, not Critical, because it needs a scripted run, is loud (one alert per edit) and fully traceable in Audit, and the days are still counted as leave.
- **Fix**: (1) do not let `history` grow without limit: keep the dates out of it or cap it (drop the oldest entries into Audit, which already has them); (2) cap edits per request (for example 10) and days per request (for example 31); (3) a decision by Aakash / Varun must never fail because of history size; (4) answer an over-long value with a clear `BLOCKED`, not `ERROR`.
- **Reproducers**: `H1a` (cannot reject / cancel), `H1b` (no absence, month cannot be locked). Control without the stuffing: reject works, month locks.

---

## Medium

### M1 — The 2,000-character text limit is bypassed by sending a list instead of a text

- **Where**: `api.js:243-253` `checkSizes` checks each string leaf; the fields are then turned into text with `String(...)` (`core.js:494` reasonText, `attendance.js:362` going-out reason, `admin.js:97` dispute text, `core.js:602/635` cancel reason, `admin.js:143` edit). `String(['a','b'])` joins the pieces.
- **Attack**: `reasonText: [2000 chars, 2000 chars, …]`. Anything up to the 49,000-character cell limit is stored.
- **Result (reproduced)**: a leave reason of 40,019 characters is accepted and stored; a going-out reason of 40,019 characters is copied into Aakash's alert (40,028 characters) and into his e-mail. **30 such requests by one person** make the LeaveRequests tab 1.45 million characters: the read cache keeps at most 12 × 90,000, so from then on **every request of every person reads the whole tab from the Sheet** (measured: 10 screens = 10 Sheet reads; with normal rows: 0). Requests can be sent for any date up to the year 2100 with no limit on their number, so the slowdown grows as far as the person wants.
- **Fix**: for every free-text field require `typeof value === 'string'` (refuse lists and objects with `BLOCKED`); one helper `text(value, max)` used everywhere instead of `String(...)`.
- **Reproducers**: `M1a`, `M1b`, `M1c`.

### M2 — The e-mail job sends first and marks afterwards: an overlap or a busy lock sends everything again

- **Where**: `jobs.js:29-53` `sendEmails`: reads un-marked alerts with no lock, sends, and only then takes the lock to write `emailedAt`.
- **Result (reproduced)**:
  - a) two runs that overlap (the 5-minute timer plus a run by hand, or a slow run) both read the same alerts and both send them: every recipient gets each e-mail twice;
  - b) if the lock cannot be taken after sending (`lock.waitLock(25000)` throws when the lock is busy), nothing is marked. The next run, 5 minutes later, sends all of it again, and again on every run while the lock stays busy. With 11 recipients the 100 e-mails of the day are gone after 9 such runs, and the real alerts of that day are not e-mailed.
- **Condition for b)**: lock waits above 25 seconds. In ordinary use of 10 people that is rare; a stranger who keeps posting `login` calls (each one takes the lock, see D1) can cause it on purpose. The lock timeout itself is simulated in the test; it cannot be produced in Node.
- **Fix**: inside the lock, mark the alerts as "being sent by this run" (or set `emailedAt` first), flush, then send; put back only the ones whose send failed. Or hold the lock for the whole job (11 e-mails are a few seconds).
- **Reproducers**: `M2a`, `M2b`.

### M3 — Anyone on the internet can keep new-phone sign-in locked for any person, and the owner's PIN reset does not help

- **Where**: `core.js:128-141` (the lock for a phone that is not yet approved is on the person), `core.js:105` (`setPin` clears `pinTries` and `pinLockedUntil` but not `pinLockLevel`).
- **Attack**: `names` gives every id without sign-in. Five wrong PINs lock the person's "new phone" door for 15 min, then 1 h, 4 h, 16 h, then 24 h each time. **Five requests a day per person keep it closed for ever.**
- **Who is hit**: not people on their approved phone (that door has its own counter — this fix from round 2 works). Hit are: a new joiner, anyone whose phone was replaced or whose browser data was cleared, **and the owner himself if he loses his only phone** — none of them can get a phone request in, even with the right PIN.
- **Result (reproduced)**: after the lock has grown, the owner resets Neha's PIN; the stranger sends 5 more guesses; the account is locked for **24 hours at once** (level kept), and Neha with the right new PIN gets "Too many wrong PINs".
- **Fix**: (1) `setPin` must reset `pinLockLevel`; (2) do not let strangers hold this door shut: a right PIN from an unknown phone only creates a request the owner must approve, so the lock adds little there — for example a one-time "new phone code" from the owner (valid 15 minutes) that opens the door regardless of the lock, or answer every unknown-phone attempt the same way and count wrong PINs only as a delay, not a full lock.
- **Reproducer**: `M3` (shows the reset part; the "five requests a day" part is the design as written, see the lock times `15, 60, 240, 960, 1440, 1440` minutes).

---

## Low

### L1 — One staff member can still raise alerts without limit and use up the day's e-mail quota (round 2 F11, other doors)

- **Where**: `attendance.js:103` (5 late / early requests per kind **per date**, any date up to 2100); `admin.js:152` (every edit of a waiting leave alerts Aakash, no cap); no cap on leave requests.
- **Result (reproduced)**: one late / early request every 5 minutes, each for another day = one e-mail to Aakash every 5 minutes; **the 100 e-mails of a consumer Google account are used up by one person** (268 alerts in a day in the test). In-app alerts still work; the trail in Audit names the person.
- **Fix**: a per-person daily cap on alert-raising actions; late / early only for the next N days; at most one digest e-mail per recipient per hour except for a short list of urgent kinds.
- **Reproducer**: `L1`.

### L2 — A call without sign-in and a non-text `deviceToken` ends as an internal error

- **Where**: `core.js:207` (`sha256(deviceToken)` with no type check); `api.js:289` (any error that carries a `.code` is returned to the caller with its internal message).
- **Result (reproduced)**: `deviceToken: 12345` is not answered `AUTH`. In Node the caller receives the runtime's own error text and code. Nothing private leaks and nothing is bypassed; on Apps Script it should end as "Something went wrong" plus a line in the Executions log that any stranger can produce.
- **Fix**: `typeof deviceToken !== 'string'` → `AUTH`; return only the app's own codes (a fixed list), everything else as `ERROR`.
- **Reproducer**: `L2`.

### L3 — Check-in on a day already marked "shop closed" is judged against full duty hours (found by the "closed days vs check-in" overlap probe)

- **Where**: `attendance.js:152-225` (`checkIn` / `checkOut` do not look at `closedDays`); `admin.js:355-360` clears minutes only for a closed day that is added **after** them.
- **Result (reproduced)**: day marked closed at 08:00; Neha is called in, checks in 10:30 and out 15:00: **automatic half day (0.5 leave) and 2 violations**. The other order (check-in first, day marked closed afterwards) gives nothing. Same facts, opposite result — also when the two requests overlap, whichever gets the lock first decides. Assumption 42 in PROGRESS.md says such minutes are cleared.
- **Fix**: on a closed day count no late / early / going-out minutes (same rule as the later clearing).
- **Reproducer**: `L3`. Rated Low: it needs someone working on a day the owner marked closed.

---

## Design risks / needs the real deployment (not reproducible in Node)

- **D1 — The lock is one queue for everybody, and `login` (no sign-in needed) stands in it.** Condition: a stranger keeps about 20–30 `login` posts running at once. Every changing action of every person waits behind them; after 25 s of waiting Apps Script throws and the person sees "Something went wrong" (and a check-in photo already uploaded stays in Drive without a check-in). Also triggers M2b. Check on TEST: 30 parallel posts, then one check-in.
- **D2 — M3 by design**: even with the level reset fixed, 5 requests a day per person keep the "new phone" door shut. Needs the owner's decision on the fix (one-time code).
- **D3 — Size is checked after parsing.** `doPost` parses the whole body (Apps Script accepts up to about 50 MB) before `checkSizes` runs, and `checkSizes` runs before sign-in. Condition: a stranger posts very large bodies in a loop; cost is execution time and the 30-simultaneous-runs limit, not data.
- **D4 — L2 on Apps Script**: what `Utilities.computeDigest` does with a number or an object is not known here (convert, or throw). Check on TEST once: `deviceToken: 12345` must answer `AUTH`.
- **D5 — Photos without a check-in** (round 2 D7, still open): the upload happens before the lock. Condition: N copies of the same first check-in sent at the same moment → N files of up to 900 KB in Drive, 1 check-in. Nothing deletes the rest.
- **D6 — The phone token never changes and never expires.** Signing out and in again on the same phone makes the same token valid again; a copy taken earlier (another page on the same github.io address, round 2 D2; a backup of the phone) works until the owner removes the phone.
- **D7 — Public history.** Older versions of PROGRESS.md and `reviews/round2.md` in the repository history still say that the TEST roster used PIN 1234 and name the TEST Sheet. PROGRESS.md says TEST PINs were replaced and nothing of TEST is reused; that must stay true, because history cannot be un-published without rewriting it.
- **D8 — `me` gives every signed-in person the exact shop point** (`shopPoint`). It makes a faked location exact to the metre. Same family as round 2 D5 (location and dress come from the phone); the photo remains the real proof.
- **D9 — A person who has left still gets e-mails.** `sendEmails` does not look at `active`; alerts addressed to a leaver (their own only) go to the stored address until it is removed.

Cache versions (`cachegrid.js`): I tried to construct a stale read that survives a write (version key expiring between two requests, a reader storing an old copy after a writer's commit, pieces of a large tab from two writers). I found no order of events that leaves an old copy under a live version key; a reader that overlaps a write can show one screen with old rows of one tab and new rows of another, which the next refresh (30 s) corrects.

---

## What I tried and what held up

**Every action, three roles.** All actions (57 in one matrix, `login` separately) × about 340 argument sets (every id in the Sheet: leaves, short requests, outings, punches, photo and thumbnail ids, violations, devices, incidents; plus empty, `null`, `0`, `{}`, `[]`, another person's id, `__proto__`, `constructor`) as a staff member, as the manager and with no sign-in, after a busy month built through the API (salaries, leaves with reasons, a rejection, outings, late request, incidents with notes, a dispute and its decision, a phone request with a label, the evening and hourly jobs).
- No sign-in: only `names` answers (ids and names of active people). Everything else: `AUTH`.
- Staff: only own data. Other people's leave, short request, outing, punch, violation, device ids: `NOT_FOUND` / `FORBIDDEN`. No unexpected error.
- Manager: `decideDispute`, `overrideLeave`, `savePerson`, `setPay`, `saveRule`, `setSetting` (closed days, owner e-mail, start date), `setShopPoint` (once set), `setPin`, `decideDevice` (approve and revoke), `getSettings`, `devices`, `disputes`: all `FORBIDDEN`. He cannot decide his own leave, late request or outing. Dispute texts, phone labels, e-mail addresses, phone numbers never reach him.

**Privacy scan.** Every reply a staff member can get, and every alert addressed to each person, searched for: other people's salary figures, target allowance, reason texts, decision reasons, going-out reasons, violation notes, dispute texts, the owner's dispute note, phone labels, e-mail addresses, phone numbers, PIN hashes and salts, token hashes. **Nothing found.** `approvals.context`, `myMonth` (labels and notes), `me`, `today`, `notifications`, `names` carry only what they should.

**Photos.** Thumbnail of today: everyone. Thumbnail of an earlier day, or any full photo, with an id taken from an older reply: staff get `FORBIDDEN` unless it is their own. `photoId` / `thumbId` cannot be sent by the phone (the prepared arguments replace the request). Only a real `data:image/jpeg;base64` text is stored.

**Sign-in and phones.** Wrong PINs: own-phone and public counters are separate and both grow 15 min → 24 h. A right PIN on an unknown phone only creates a request (at most 3 waiting, owner alerted once). Signed-out phone: token refused until the PIN is entered on it. Removed phone: refused inside the lock even when its request was already waiting. Rejected phone: new request, new token. Two requests approved at once: one phone. Inactive person: nothing works. Role changed while a request waits: the new role applies.

**Forged fields.** Time, date, status, person, `enteredBy`, `deviceId`, `calledAt` (staff), minutes, month keys: all decided by the server. Still from the phone, as already known: location and dress result. Keys such as `__proto__` in arguments have no effect. Depth and list limits hold (except M1).

**Phone app.** `docs/app.js`, `docs/app-admin.js`, `camera.js`, `dress.js`: no `innerHTML`, `insertAdjacentHTML`, `document.write`, `eval` or `new Function`; all text goes in as text nodes; the only link built from data is the WhatsApp link (encoded); the only image source is the server's JPEG data. Script text in reasons, notes, labels, `halfStart` is shown as text. Text starting with `=`, `+`, `-`, `@` is stored neutralised.

**Overlapping requests** (doPost-like harness, lock + reset, hooks from round 3): two bosses locking a month (one confirms, one locks; a double tap is one confirmation); approve vs edit vs cancel of one leave (one wins, the others are refused cleanly); undo check-out twice, check-out vs hand check-out; hand check-in vs the evening job in both orders (no absence left standing); two evening jobs, two hourly jobs (no double absence, no double reminder, one summary); sign-out, phone removal and demotion while a request waits; a new clash rule vs an approval; two check-ins with the photo upload in between (one check-in, one thumbnail). **All correct.** The only overlap defect is the e-mail job (M2).

---

## Summary

- **Counts**: Critical 0 · High 1 · Medium 3 · Low 3 · design risks 9.
- **H1**: a staff member fills his request's history cell with repeated edits; nobody can then reject, approve or cancel it, he is never marked absent on those days, and the month cannot be locked.
- **M1**: a text sent as a list passes the 2,000-character check and is stored at up to 49,000; 30 such requests push the leave tab out of the cache and slow every screen for everyone.
- **M2**: e-mails are sent before they are marked; two overlapping runs, or one lock timeout, send them again (every 5 minutes while the lock is busy).
- **M3**: a stranger keeps new-phone sign-in locked with 5 wrong PINs a day per person; the owner's PIN reset keeps the lock level, so the next lock is 24 hours at once.
- **L1–L3**: unlimited alerts by one person use up the day's e-mails; a non-text token ends as an internal error; check-in on an already-closed day costs a half day and 2 violations.
- **Held up**: all access rules for outsider, staff and manager; every privacy check (salary, reasons, notes, disputes, PIN / token data, e-mail, labels, photos); phone binding and sign-out; forged server-side fields; the phone app's rendering; every overlap on the new write paths; the read cache's versions.
