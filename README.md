# WC2026 Predictor — replacement backend (v1.1 — bugfix)

## What was actually wrong with Bel vs Sen showing 3-2

Two bugs, both now fixed:

1. **Wrong JSON key names.** football-data.org's score sub-objects use
   `{ homeTeam, awayTeam }`, not `{ home, away }`. The previous version
   of `lib/footballData.js` read `.home`/`.away` everywhere, which is
   always `undefined` against the real API -- so `score.regularTime`
   was never actually being picked up correctly.
2. **A dependency that was never installed.** `footballData.js` called
   `require('node-fetch')`, but `node-fetch` was never in
   `package.json`. That call was almost certainly throwing "Cannot
   find module" on every sync attempt, meaning `/sync` -- both the
   button and `fix-past-error.js` -- was failing silently and never
   touching the database. That's why the match kept showing 3-2 no
   matter how many times you ran the fix: the fix was never actually
   running.

Fixed by switching to Node's **built-in `fetch`** (Node 18+, which
`better-sqlite3` already requires) instead of `node-fetch`, and by
correcting every `score.X.home`/`.away` read to `score.X.homeTeam`/
`.awayTeam`. See the comments in `lib/footballData.js` for the full
reasoning.

I also widened match-linking from "exact same calendar day" to
"within 1 day," since a kickoff near UTC midnight can land on a
different calendar date than the one recorded in your legacy export --
which could otherwise cause a match to silently fail to link (and thus
never get updated) even with the fetch bug fixed.

## What to do now

You already ran `import-legacy`, so you don't need to redo that step.
Just re-run the fix with this corrected code:

```bash
npm run fix-past-error
```

It will print out every match whose score/status changed -- you should
see Belgium vs Senegal listed as `3-2 -> 2-2` (or similar) in that
output. If a match you expect to see corrected does NOT show up, the
script also prints any fixtures it couldn't link to a local row, which
will tell you if it's a team-name mismatch rather than the old bug.

## Auto-sync on load, not just on "Refresh Results"

The server now:
- **Syncs once immediately on boot** (i.e. the moment Railway starts
  the process), so data is fresh without anyone touching the button.
- **Syncs again every `SYNC_INTERVAL_MINUTES`** (default 10, set in
  `.env`) for as long as the server stays running.
- The "Refresh Results" button still works exactly as before, calling
  the same `/sync` endpoint on demand.

All three paths (boot, timer, button) now call the exact same
`performSync()` function in `server.js`, so there's only one place the
sync logic can go wrong, not three.

One caveat worth knowing on Railway specifically: if you're on a plan
where the service can sleep/restart between requests, the boot-sync
still covers you (it fires on every restart), but the interval timer
only keeps running while the process is actually alive. That's fine for
this use case -- predictions only need to be correct by the time
someone loads the page, and the boot sync handles that.

## Redeploying

```bash
npm install     # package.json no longer references node-fetch at all
npm run fix-past-error
npm start        # or however Railway runs it -- same start command
```

If you're on Railway, just push these files; Railway will reinstall
dependencies and restart the service, which triggers the boot sync
automatically.

## Everything else

Unchanged from before -- see the earlier sections of this project for
the `/users`, `/matches`, `/predictions`, `/leaderboard` endpoint docs,
the points-scoring rules, and the `index.html` edits needed to point at
this backend.

## Update: the homeTeam/awayTeam fix was also wrong

If you ran `fix-past-error` and got `?-?` for *every* match (not just
knockout ones), that confirms `homeTeam`/`awayTeam` wasn't right either
-- I was going on documentation text without a live token to verify
against, and got it wrong twice now. Rather than guess a third time:

1. Run the new diagnostic first:
   ```bash
   npm run debug-fixture
   ```
   This hits football-data.org directly and prints the **raw, actual**
   JSON for Belgium vs Senegal plus a plain finished match -- no
   interpretation, just what the API really sends back.

2. `lib/footballData.js`'s `pair()` helper now accepts **either**
   `{home, away}` or `{homeTeam, awayTeam}` automatically, so this
   should self-correct regardless of which naming the API actually
   uses. Re-run:
   ```bash
   npm run fix-past-error
   ```

3. If scores are still coming back null/wrong after that, paste the
   `debug-fixture` output back -- with the real raw shape in hand there's
   no more guessing involved.

## Update 2: the real fix, verified against live data

Your `debug-fixture` output settled it. Ground truth from the actual
API:

```
Belgium vs Senegal score object:
{
  "winner": "HOME_TEAM",
  "duration": "REGULAR",          <- misleading! this match went to ET
  "fullTime":    { "home": 3, "away": 2 },
  "halfTime":    { "home": 0, "away": 1 },
  "regularTime": { "home": null, "away": null },   <- not backfilled
  "extraTime":   { "home": 1, "away": 0 }
}
```

Two things this revealed:
- Keys really are `home`/`away`, confirmed.
- `duration` can't be trusted to tell you whether a match went to extra
  time -- this one says `"REGULAR"` despite clearly having an
  `extraTime` object. football-data.org's own data is inconsistent
  here (compare Germany vs Paraguay, where `regularTime` WAS correctly
  filled in alongside a penalty shootout).

The fix now uses this priority order, which covers everything seen in
your data:
1. If `regularTime` is populated, use it directly.
2. Else, if an `extraTime` object exists at all (regardless of what
   `duration` claims), derive the 90-minute score as
   `fullTime − extraTime`.
3. Else, it's a plain match -- `fullTime` IS the regulation score.

Verified against your three real examples:
- Mexico vs South Africa -> 2-0 (plain match, unchanged)
- Germany vs Paraguay -> 1-1 (regularTime trusted directly, penalty
  shootout ignored for grading)
- **Belgium vs Senegal -> 2-2** (derived: fullTime 3-2 minus extraTime
  1-0)

Re-run:
```bash
npm run fix-past-error
```
You should now see Belgium vs Senegal land on 2-2, and every other
match should match what actually happened in 90 minutes.
