require('dotenv').config();
const express = require('express');
const cors = require('cors');
const db = require('./lib/db');
const { fetchFixtures } = require('./lib/footballData');
const { computePoints } = require('./lib/scoring');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 8787;
const ADMIN_KEY = process.env.ADMIN_KEY || '';
const LOCK_MINUTES = Number(process.env.PREDICTION_LOCK_MINUTES || 5);
const NULL_SENTINEL = -1;

function requireAdmin(req, res, next) {
  if (!ADMIN_KEY) return next(); // no secret configured -> open (fine behind a private tunnel)
  if (req.get('x-admin-key') === ADMIN_KEY) return next();
  return res.status(401).json({ error: 'Unauthorized' });
}

function normalizeTeamName(name) {
  return String(name || '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // strip accents
    .replace(/[^a-z0-9]/g, '');
}

// ---------------------------------------------------------------------
// Re-grading: recompute predictions.points for every FINISHED match,
// then roll up per-user totals. This is what both "run this after a
// sync" and "fix the past error" rely on — it is idempotent and safe
// to run as often as you like.
// ---------------------------------------------------------------------
function regradeAll() {
  const matches = db.prepare(`SELECT match_id, score_home, score_away, status FROM matches`).all();
  const updatePoints = db.prepare(`UPDATE predictions SET points = ? WHERE match_id = ? AND user_id = ?`);

  const tx = db.transaction(() => {
    for (const m of matches) {
      const preds = db.prepare(`SELECT * FROM predictions WHERE match_id = ?`).all(m.match_id);
      for (const p of preds) {
        if (p.pred_home === null || p.pred_away === null) {
          updatePoints.run(null, m.match_id, p.user_id);
          continue;
        }
        if (m.status !== 'FINISHED') {
          updatePoints.run(null, m.match_id, p.user_id);
          continue;
        }
        const pts = computePoints(p.pred_home, p.pred_away, m.score_home, m.score_away);
        updatePoints.run(pts, m.match_id, p.user_id);
      }
    }
  });
  tx();
}

function getUsersAggregated() {
  const users = db.prepare(`SELECT * FROM users`).all();
  const rows = db.prepare(`
    SELECT user_id,
           COALESCE(SUM(points), 0) AS total_points,
           SUM(CASE WHEN points = 3 THEN 1 ELSE 0 END) AS exact,
           SUM(CASE WHEN points = 1 THEN 1 ELSE 0 END) AS correct
    FROM predictions
    WHERE points IS NOT NULL
    GROUP BY user_id
  `).all();
  const byId = Object.fromEntries(rows.map(r => [r.user_id, r]));
  return users.map(u => {
    const agg = byId[u.user_id] || { total_points: 0, exact: 0, correct: 0 };
    return {
      user_id: u.user_id,
      display_name: u.display_name,
      name: u.name || u.display_name,
      total_points: agg.total_points,
      pts: agg.total_points,
      exact: agg.exact,
      correct: agg.correct,
    };
  });
}

function getMatchesWithPredictions() {
  const matches = db.prepare(`SELECT * FROM matches ORDER BY kickoff ASC`).all();
  const allPreds = db.prepare(`SELECT * FROM predictions`).all();
  const byMatch = {};
  for (const p of allPreds) {
    (byMatch[p.match_id] = byMatch[p.match_id] || {})[p.user_id] = {
      pred_home: p.pred_home,
      pred_away: p.pred_away,
      points: p.points,
    };
  }
  return matches.map(m => ({
    match_id: m.match_id,
    team_home: m.team_home,
    team_away: m.team_away,
    kickoff: m.kickoff,
    stage: m.stage,
    status: m.status,
    score_home: m.score_home,
    score_away: m.score_away,
    predictions: byMatch[m.match_id] || {},
  }));
}

// ---------------------------------------------------------------------
// GET /users
// ---------------------------------------------------------------------
app.get('/users', (req, res) => {
  res.json(getUsersAggregated());
});

// ---------------------------------------------------------------------
// GET /matches
// ---------------------------------------------------------------------
app.get('/matches', (req, res) => {
  res.json(getMatchesWithPredictions());
});

// ---------------------------------------------------------------------
// GET /leaderboard
// ---------------------------------------------------------------------
app.get('/leaderboard', (req, res) => {
  res.json(getUsersAggregated());
});

// ---------------------------------------------------------------------
// POST /predictions
// body: { user_id, match_id, pred_home, pred_away }
// pred_home === NULL_SENTINEL (-1) clears the prediction.
// ---------------------------------------------------------------------
app.post('/predictions', (req, res) => {
  try {
    const { user_id, match_id, pred_home, pred_away } = req.body || {};
    if (!user_id || match_id === undefined || match_id === null) {
      return res.status(400).json({ error: 'user_id and match_id are required' });
    }
    const match = db.prepare(`SELECT * FROM matches WHERE match_id = ?`).get(match_id);
    if (!match) return res.status(404).json({ error: 'Match not found' });

    const kickoff = new Date(match.kickoff);
    const lockAt = new Date(kickoff.getTime() + LOCK_MINUTES * 60 * 1000);
    if (Date.now() > lockAt.getTime()) {
      return res.status(400).json({ error: 'Predictions are locked for this match' });
    }

    const clearing = pred_home === NULL_SENTINEL || pred_away === NULL_SENTINEL;

    db.prepare(`
      INSERT INTO predictions (match_id, user_id, pred_home, pred_away, points)
      VALUES (@match_id, @user_id, @pred_home, @pred_away, NULL)
      ON CONFLICT(match_id, user_id) DO UPDATE SET
        pred_home = excluded.pred_home,
        pred_away = excluded.pred_away,
        points = NULL
    `).run({
      match_id,
      user_id,
      pred_home: clearing ? null : pred_home,
      pred_away: clearing ? null : pred_away,
    });

    if (!clearing && match.status === 'FINISHED') {
      const pts = computePoints(pred_home, pred_away, match.score_home, match.score_away);
      db.prepare(`UPDATE predictions SET points = ? WHERE match_id = ? AND user_id = ?`)
        .run(pts, match_id, user_id);
    }

    res.json({ status: 'saved' });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

// ---------------------------------------------------------------------
// POST /sync
// Pulls fixtures from API-FOOTBALL, fixes the FT/AET/PEN score bug,
// links fixtures to local matches (by team name + calendar date, or by
// stored api_fixture_id if already linked), inserts any brand-new
// fixtures, then re-grades every prediction.
// ---------------------------------------------------------------------
app.post('/sync', requireAdmin, async (req, res) => {
  try {
    const apiToken = process.env.FOOTBALL_DATA_TOKEN;
    if (!apiToken) return res.status(500).json({ error: 'FOOTBALL_DATA_TOKEN is not configured on the server' });

    const fixtures = await fetchFixtures({
      apiToken,
      competitionCode: process.env.COMPETITION_CODE || 'WC',
    });

    const localMatches = db.prepare(`SELECT * FROM matches`).all();
    const byFixtureId = new Map(localMatches.filter(m => m.api_fixture_id).map(m => [m.api_fixture_id, m]));
    const unlinked = localMatches.filter(m => !m.api_fixture_id);

    const updateStmt = db.prepare(`
      UPDATE matches SET team_home=?, team_away=?, status=?, raw_status=?, score_home=?, score_away=?, api_fixture_id=?
      WHERE match_id=?
    `);
    const insertStmt = db.prepare(`
      INSERT INTO matches (match_id, api_fixture_id, team_home, team_away, kickoff, stage, status, raw_status, score_home, score_away)
      VALUES (@match_id, @api_fixture_id, @team_home, @team_away, @kickoff, @stage, @status, @raw_status, @score_home, @score_away)
    `);

    let updated = 0, inserted = 0, linked = 0;

    const tx = db.transaction(() => {
      for (const fx of fixtures) {
        let local = byFixtureId.get(fx.api_fixture_id);

        // Try to auto-link an unlinked local match by team names + same
        // calendar day (handles legacy rows imported without a fixture id).
        if (!local) {
          const fxHome = normalizeTeamName(fx.team_home);
          const fxAway = normalizeTeamName(fx.team_away);
          const fxDate = fx.kickoff.slice(0, 10);
          const idx = unlinked.findIndex(m =>
            normalizeTeamName(m.team_home) === fxHome &&
            normalizeTeamName(m.team_away) === fxAway &&
            String(m.kickoff).slice(0, 10) === fxDate
          );
          if (idx !== -1) {
            local = unlinked[idx];
            unlinked.splice(idx, 1);
            linked++;
          }
        }

        if (local) {
          updateStmt.run(
            fx.team_home, fx.team_away, fx.status, fx.raw_status,
            fx.score_home, fx.score_away, fx.api_fixture_id,
            local.match_id
          );
          updated++;
        } else {
          // Brand new fixture we've never seen before — create it.
          // Use the API-FOOTBALL fixture id as our match_id (offset to
          // dodge collision with any legacy integer ids).
          const newId = 900000000 + fx.api_fixture_id;
          insertStmt.run({
            match_id: newId,
            api_fixture_id: fx.api_fixture_id,
            team_home: fx.team_home,
            team_away: fx.team_away,
            kickoff: fx.kickoff,
            stage: fx.round,
            status: fx.status,
            raw_status: fx.raw_status,
            score_home: fx.score_home,
            score_away: fx.score_away,
          });
          inserted++;
        }
      }
      db.prepare(`INSERT INTO sync_log (ts, note) VALUES (?, ?)`)
        .run(new Date().toISOString(), `updated=${updated} inserted=${inserted} linked=${linked}`);
    });
    tx();

    regradeAll();

    res.json({ count: updated + inserted, updated, inserted, linked });
  } catch (e) {
    console.error('[sync] failed:', e);
    res.status(500).json({ error: e.message || 'Sync failed' });
  }
});

// ---------------------------------------------------------------------
// POST /admin/regrade  — manually re-run grading without a live sync
// (useful right after import, or to prove the past-error fix worked).
// ---------------------------------------------------------------------
app.post('/admin/regrade', requireAdmin, (req, res) => {
  regradeAll();
  res.json({ status: 'regraded' });
});

app.get('/health', (req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`WC2026 predictor backend listening on http://localhost:${PORT}`);
});