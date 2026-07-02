/**
 * One-shot script: pulls fresh, correct data from football-data.org
 * (using score.regularTime, not the misleadingly-named score.fullTime),
 * updates every match, and re-grades every prediction. Prints out any
 * match whose result changes as a result, so you can see exactly what
 * got corrected.
 *
 * Usage: node scripts/fix-past-error.js
 * (requires .env to be configured -- see .env.example)
 */
require('dotenv').config();
const db = require('../lib/db');
const { fetchFixtures } = require('../lib/footballData');
const { computePoints } = require('../lib/scoring');

function normalizeTeamName(name) {
  return String(name || '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]/g, '');
}

function dayKey(iso) {
  return String(iso).slice(0, 10);
}
function daysApart(isoA, isoB) {
  const a = new Date(dayKey(isoA) + 'T00:00:00Z').getTime();
  const b = new Date(dayKey(isoB) + 'T00:00:00Z').getTime();
  return Math.abs(a - b) / 86400000;
}

async function main() {
  const apiToken = process.env.FOOTBALL_DATA_TOKEN;
  if (!apiToken) {
    console.error('Set FOOTBALL_DATA_TOKEN in .env first.');
    process.exit(1);
  }

  const before = db.prepare(`SELECT match_id, team_home, team_away, score_home, score_away, status FROM matches`).all();
  const beforeById = Object.fromEntries(before.map(m => [m.match_id, m]));

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

  let linkedCount = 0, unmatchedFixtures = [];

  const tx = db.transaction(() => {
    for (const fx of fixtures) {
      let local = byFixtureId.get(fx.api_fixture_id);
      if (!local) {
        const fxHome = normalizeTeamName(fx.team_home);
        const fxAway = normalizeTeamName(fx.team_away);
        const idx = unlinked.findIndex(m =>
          normalizeTeamName(m.team_home) === fxHome &&
          normalizeTeamName(m.team_away) === fxAway &&
          daysApart(m.kickoff, fx.kickoff) <= 1
        );
        if (idx !== -1) {
          local = unlinked[idx];
          unlinked.splice(idx, 1);
          linkedCount++;
        }
      }
      if (!local) {
        unmatchedFixtures.push(`${fx.team_home} vs ${fx.team_away} (${fx.kickoff})`);
        continue; // brand new fixture with no local row yet -- handled by /sync, not this script
      }
      updateStmt.run(fx.team_home, fx.team_away, fx.status, fx.raw_status, fx.score_home, fx.score_away, fx.api_fixture_id, local.match_id);
    }
  });
  tx();

  // Re-grade
  const matches = db.prepare(`SELECT match_id, score_home, score_away, status FROM matches`).all();
  const updatePoints = db.prepare(`UPDATE predictions SET points = ? WHERE match_id = ? AND user_id = ?`);
  const regradeTx = db.transaction(() => {
    for (const m of matches) {
      const preds = db.prepare(`SELECT * FROM predictions WHERE match_id = ?`).all(m.match_id);
      for (const p of preds) {
        if (p.pred_home === null || m.status !== 'FINISHED') {
          updatePoints.run(null, m.match_id, p.user_id);
          continue;
        }
        const pts = computePoints(p.pred_home, p.pred_away, m.score_home, m.score_away);
        updatePoints.run(pts, m.match_id, p.user_id);
      }
    }
  });
  regradeTx();

  const after = db.prepare(`SELECT match_id, team_home, team_away, score_home, score_away, status FROM matches`).all();
  console.log('Matches whose stored result changed:\n');
  let changed = 0;
  for (const m of after) {
    const b = beforeById[m.match_id];
    if (!b) continue;
    if (b.score_home !== m.score_home || b.score_away !== m.score_away || b.status !== m.status) {
      changed++;
      console.log(`  ${m.team_home} vs ${m.team_away}: was ${b.score_home ?? '?'}-${b.score_away ?? '?'} (${b.status}) -> now ${m.score_home ?? '?'}-${m.score_away ?? '?'} (${m.status})`);
    }
  }
  if (changed === 0) console.log('  (none -- nothing needed correcting)');
  console.log(`\nLinked ${linkedCount} previously-unlinked local matches to fixtures this run.`);
  if (unmatchedFixtures.length) {
    console.log(`\n${unmatchedFixtures.length} fixture(s) from the API had no matching local row (fine if these are just new/future matches):`);
    unmatchedFixtures.slice(0, 10).forEach(f => console.log(`  - ${f}`));
  }
  console.log(`\nDone. ${changed} match(es) corrected, predictions re-graded.`);
}

main().catch(e => { console.error(e); process.exit(1); });
