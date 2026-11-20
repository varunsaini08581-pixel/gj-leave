# Round 20 review: delta ab1f7f3..4f73a0b (src, docs)

| Severity | Count |
|---|---|
| Critical | 0 |
| High | 0 |
| Medium | 1 |
| Low | 1 |

No Critical or High findings. The round 19 reproducers are fixed for the right reasons. `node --test`: 463 tests, 462 pass, 0 fail, 1 skipped. Reproducers: /home/claude/findings/repro-round20.test.js (both fail on 4f73a0b with the message below). The hash of src+docs was the same at start and end (2f671564...efd2).

## R20-1 (Medium) Duty hours saved first, then roster / records-only / active in a second save the same day: the second change starts only tomorrow
- Where: src/server/admin.js savePerson (history block, ~l.247-252), and the same block in docs/mock-server.js.
- What happens: save 1 (hours only) writes `{until: yesterday, old}` and `{until: today, old hours, roster = clean (= old)}`. In save 2 (roster only) until = yesterday, the last entry's until is today, so nothing is pushed. `Cal.asOn(today)` returns the save-1 entry with the OLD roster.
- Steps: Sunday 22 Nov 08:00, Varun changes Vikas's duty hours. At 08:05 he gives him the 4th Sunday off. The board says "Not in yet". At 23:30 endOfDay marks Vikas absent on 22 Nov. Test R20-1.
- Why it matters: this is the same wrong absence / violation as R19-3, reached with two saves instead of one (for example, when the owner fixes a forgotten field). Varun can take it back. Medium, matching R19-3. (It is not a regression: before ab1f7f3 this case already behaved this way. It is a gap in the R19-3 fix.)
- Fix: when `changed` and the last history entry has `until === today` (written today because of an hours change), set that entry's sundayOff / active / noApproval to the clean values and keep its duty hours. In short: update today's entry instead of skipping it.

## R20-2 (Low) Overlapping sends from one person: the 4th request of the day is auto-approved (regression from the `before` filter)
- Where: src/server/core.js sentOnDay(..., before) `h.at < at` with requestLimit `at = ctx.now`. ctx.now comes from src/gas/main.js l.119 (`now: Date.now()`), which runs BEFORE `waitLock`.
- What happens: send A starts at T1 and waits for the lock. Send B starts at T2 > T1 and gets the lock first. B counts only saved rows (A is not saved yet). A counts only rows with at < T1 (B's at is T2), so neither sees the other. Before 4f73a0b, the whole-day count made A count B.
- Steps: Neha sends 2 requests and cancels them. Then B (now 10:04) runs, then A (now 10:03) runs. Both are "Approved". The test expects one of them to be "Pending with Aakash". Also, in views.js, B's card shows red "request number 4" but B was auto-approved. Test R20-2.
- Why it matters: the per-day rule (owner 23:46 (3)) is skipped. It needs two sends from the same person in flight together, for example a double tap or a retry while the first is still waiting for the lock. Low.
- Fix: in requestLimit, for a NEW request (no exceptId) count the whole day as before: `sentOnDay(ctx, id, ctx.now, undefined, false)`. Keep `before=true` only for edits (at = h0.at) and the red line. Or order by insertion (row order) instead of `at`.

## Checked, no finding
- R19-1..4 reproducers: fixed by the intended change. Preview (core.js:419) and editLeave both pass the edit id into requestLimit, so preview = real routing.
- addHistory keeps out[0] when it trims at 40, so h0 / requestLimit / the red line survive the cap. Requests entered by Aakash and 'called – emergency' rows (h0.by = Aakash) are not counted, as PROGRESS 75 says.
- Cal.asOn with two entries (yesterday, today), with roster-then-hours on one day, and with hours on two consecutive days: correct.
- api.js marker write on a read: a revoked, signed-out or wrong-token phone fails in authenticate before the write. Only owner bootstrap rows match, and the write happens once per device. authenticate writes nothing, so locked()'s reset drops nothing. Speed cost: one in-memory Devices scan per call, and a lock only on the owner's first call. On a lock timeout, that one call fails and the phone can retry.
- src/gas/main.js onOpen / setOwnerPin / resetOwnerPhonesFromMenu (read only): input is validated, the PIN is asked twice, the write is under the script lock, there is an audit row, and the cache versions are bumped.

## Not reproduced / not counted
- Two sends of one person with exactly equal `at` (the same ms) would not count each other. This is not realistic with Date.now() and is covered by R20-2's fix.
