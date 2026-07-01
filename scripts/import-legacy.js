/**
 * Imports data exported from the OLD backend.
 *
 * Usage:
 *   node scripts/import-legacy.js users.json matches.json
 *
 * Where:
 *   users.json   = the JSON array returned by the old backend's GET /users
 *   matches.json = the JSON array returned by the old backend's GET /matches
 *
 * How to get those files (do this BEFORE you retire the old backend):
 *   curl https://<old-tunnel-url>/users   -o users.json
 *   curl https://<old-tunnel-url>/matches -o matches.json
 *
 * IMPORTANT / by design: this script deliberately does NOT import
 * score_home, score_away, status, or points from the old matches.json.
 * Those are exactly the fields the old backend got wrong for knockout
 * games. Instead it imports only the stable facts (teams, kickoff,
 * stage, match_id, and each user's raw pred_home/pred_away guess).
 *
 * After importing, run a sync (POST /sync, or click "Refresh Results"
 * in the app once you've pointed it at this new backend) — that pulls
 * every score fresh from API-FOOTBALL using the fixed score.fulltime
 * logic, auto-links each match by team name + date, and re-grades every
 * prediction from scratch. That single step both fixes the ongoing bug
 * AND corrects the one match that was wrongly marked before.
 */
const fs = require('fs');
const path = require('path');
const db = require('../lib/db');

const [, , usersPath, matchesPath] = process.argv;

if (!usersPath || !matchesPath) {
  console.error('Usage: node scripts/import-legacy.js users.json matches.json');
  process.exit(1);
}

const users = JSON.parse(fs.readFileSync(path.resolve(usersPath), 'utf8'));
const matches = JSON.parse(fs.readFileSync(path.resolve(matchesPath), 'utf8'));

const insertUser = db.prepare(`
  INSERT INTO users (user_id, display_name, name)
  VALUES (@user_id, @display_name, @name)
  ON CONFLICT(user_id) DO UPDATE SET display_name = excluded.display_name, name = excluded.name
`);

const insertMatch = db.prepare(`
  INSERT INTO matches (match_id, team_home, team_away, kickoff, stage, status, score_home, score_away)
  VALUES (@match_id, @team_home, @team_away, @kickoff, @stage, 'NS', NULL, NULL)
  ON CONFLICT(match_id) DO UPDATE SET
    team_home = excluded.team_home,
    team_away = excluded.team_away,
    kickoff   = excluded.kickoff,
    stage     = excluded.stage
`);

const insertPrediction = db.prepare(`
  INSERT INTO predictions (match_id, user_id, pred_home, pred_away, points)
  VALUES (@match_id, @user_id, @pred_home, @pred_away, NULL)
  ON CONFLICT(match_id, user_id) DO UPDATE SET
    pred_home = excluded.pred_home,
    pred_away = excluded.pred_away,
    points = NULL
`);

let userCount = 0, matchCount = 0, predCount = 0;

const tx = db.transaction(() => {
  for (const u of users) {
    insertUser.run({
      user_id: u.user_id,
      display_name: u.display_name || u.name || String(u.user_id),
      name: u.name || u.display_name || String(u.user_id),
    });
    userCount++;
  }

  for (const m of matches) {
    insertMatch.run({
      match_id: m.match_id,
      team_home: m.team_home,
      team_away: m.team_away,
      kickoff: m.kickoff,
      stage: m.stage || null,
    });
    matchCount++;

    const preds = m.predictions || {};
    for (const [userId, p] of Object.entries(preds)) {
      if (p == null || p.pred_home === null || p.pred_home === undefined) continue;
      insertPrediction.run({
        match_id: m.match_id,
        user_id: userId,
        pred_home: p.pred_home,
        pred_away: p.pred_away,
      });
      predCount++;
    }
  }
});
tx();

console.log(`Imported ${userCount} users, ${matchCount} matches, ${predCount} predictions.`);
console.log(`Scores/status were NOT imported on purpose — run a /sync now to populate them correctly.`);
