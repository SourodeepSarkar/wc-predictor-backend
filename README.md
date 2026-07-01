# WC2026 Predictor — replacement backend

### Deployed on Railway

This replaces both pieces of your old setup:
- the AWS Lambda at `.../sync` (the one giving post-extra-time / post-penalty
  scores instead of full-time scores), and
- the tunneled backend your `index.html` was calling for `/users`,
  `/matches`, `/predictions`, `/leaderboard`.

It's a plain Node/Express server with a local SQLite file -- free, no
hosting account required, and matches your old setup's style (you were
already exposing a local server via a Cloudflare Tunnel, so this drops
into that same pattern).

## The bug, and the fix

**Note:** an earlier version of this project used API-FOOTBALL, but its
free tier turned out to only cover seasons 2022-2024, not the live 2026
tournament. This version uses **football-data.org** instead, whose free
tier has permanently included the FIFA World Cup (the maintainer has
publicly committed to this staying free), with no season restriction.

football-data.org's `score` object has a naming quirk worth knowing:

- `score.fullTime` -- despite the name, this is the FINAL match score,
  however the game ended. For a knockout game decided in extra time,
  this **includes** the extra-time goals.
- `score.regularTime` -- the score at the end of 90 minutes, full stop,
  no matter what happened afterward. This is what predictions must be
  graded against.

The old backend's bug was reading a "final score" field without
separating regulation time from extra time -- the exact same trap as
`fullTime` here. This backend always reads `score.regularTime` for
grading (see `lib/footballData.js`, the `normalizeMatch` function --
the reasoning is right there in the comments).

Docs: https://docs.football-data.org/general/v4/overtime.html

## 1. Install

```bash
cd wc-predictor-backend
npm install
cp .env.example .env
```

Get a free token at https://www.football-data.org/client/register
and put it in `.env` as `FOOTBALL_DATA_TOKEN`.

## 2. Export your existing data from the old backend

While the old backend is still running, save its data:

```bash
curl https://nowhere-admission-draft-adapters.trycloudflare.com/users   -o users.json
curl https://nowhere-admission-draft-adapters.trycloudflare.com/matches -o matches.json
```

## 3. Import it here

```bash
npm run import-legacy -- users.json matches.json
```

This intentionally **does not** copy over the old scores, statuses, or
points -- only teams, kickoff times, stages, and each person's raw
guesses. That's on purpose: those old fields are exactly what was wrong.

## 4. Run the fix

```bash
npm run fix-past-error
```

This pulls fresh data from football-data.org (with the fix applied),
links each imported match to the right fixture by team names + date,
fills in correct scores, and re-grades every prediction from scratch.
It prints out every match whose result changed -- that's your
confirmation the previously-wrong match got corrected, along with
anyone's points that were affected by it.

## 5. Run the server

```bash
npm start
```

Expose it the same way you did before:

```bash
cloudflared tunnel --url http://localhost:8787
```

Take the URL cloudflared prints and update line ~2818 of your
`index.html`:

```js
const API = 'https://your-new-tunnel-url.trycloudflare.com';
```

Also replace the hardcoded AWS sync URL the "Refresh Results" button
calls (search `index.html` for `d369cipp2c.execute-api...`) with:

```js
fetch(API + '/sync', { method: 'POST' })
```

(It's currently a separate hardcoded URL rather than using the `API`
constant -- that's worth fixing while you're in there, since the whole
point is retiring that endpoint.)

## Going forward

Every time someone clicks "Refresh Results," `/sync` re-pulls fixtures,
re-applies the regulation-time-score fix, and re-grades all predictions
-- so this can't drift back into the old bug. New matches you haven't
manually added yet get created automatically the first time they appear
in the football-data.org response.

## Notes

- Free tier rate limit is 10 requests/minute -- one call per sync click
  is nowhere close to that.
- Predictions lock 5 minutes after kickoff, enforced server-side now
  (matches the rule already stated in your leaderboard UI), configurable
  via `PREDICTION_LOCK_MINUTES` in `.env`.
- Set `ADMIN_KEY` in `.env` if you want `/sync` and `/admin/*` to require
  a header (`x-admin-key: ...`) -- optional since a private tunnel URL is
  already a reasonable barrier for a personal pool, but a real secret is
  safer if you ever share the URL for other reasons.
- `data.sqlite` is the entire database -- back it up occasionally (just
  copy the file).

ENDOFFILE
echo done