const BASE = 'https://api.football-data.org/v4';

/**
 * ---------------------------------------------------------------------
 * THE BUG, AND THE FIX (football-data.org edition)
 * ---------------------------------------------------------------------
 * football-data.org's `score` node carries several sub-scores, and each
 * one is an object shaped { homeTeam, awayTeam } -- NOT { home, away }.
 * (An earlier version of this file used the wrong key names, which
 * silently produced `undefined` for every score read. That's fixed
 * here -- see the sample response in the docs below.)
 *
 *   - score.fullTime    -> the FINAL match score, however the game
 *                           ended. For a knockout game decided in extra
 *                           time or penalties, this INCLUDES the
 *                           extra-time goals. (Despite the name, this
 *                           is NOT the 90-minute score.)
 *   - score.regularTime -> the score at the end of 90 minutes, full
 *                           stop, regardless of what happened after.
 *                           This is what predictions must be graded
 *                           against.
 *   - score.extraTime    -> goals scored during extra time only.
 *   - score.penalties    -> the penalty shootout score only.
 *   - score.duration     -> 'REGULAR' | 'EXTRA_TIME' | 'PENALTY_SHOOTOUT'
 *
 * The fix: always read score.regularTime for grading, never
 * score.fullTime.
 *
 * Docs: https://docs.football-data.org/general/v4/overtime.html
 * ---------------------------------------------------------------------
 */

const FINISHED_STATUSES = new Set(['FINISHED']);
const NOT_STARTED_STATUSES = new Set(['SCHEDULED', 'TIMED', 'POSTPONED', 'SUSPENDED', 'CANCELLED']);

function normalizeStatus(match) {
  const { status, score } = match;
  if (FINISHED_STATUSES.has(status)) return 'FINISHED';
  if (NOT_STARTED_STATUSES.has(status)) return 'NS';
  if (status === 'PAUSED') return 'HT';
  if (status === 'IN_PLAY') {
    if (score.duration === 'EXTRA_TIME') return 'ET';
    if (score.duration === 'PENALTY_SHOOTOUT') return 'PEN';
    return 'LIVE';
  }
  return 'LIVE';
}

function pair(node) {
  if (!node) return null;
  const home = node.home !== undefined ? node.home : node.homeTeam;
  const away = node.away !== undefined ? node.away : node.awayTeam;
  if (home === null || home === undefined) return null;
  return { home, away };
}

/**
 * Turns one raw football-data.org match into our normalized shape.
 * This is the single choke point for the fix -- every caller must go
 * through here rather than reading score.fullTime directly for grading.
 */
function normalizeMatch(match) {
  const status = normalizeStatus(match);
  const score = match.score || {};

  let scoreHome = null;
  let scoreAway = null;

  if (status === 'FINISHED') {
    // THE FIX, take 3 -- ground-truthed against a real API response.
    // Confirmed facts from live data:
    //   - score sub-objects use {home, away}, not {homeTeam, awayTeam}.
    //   - `duration` is NOT reliable as a "did this go to extra time"
    //     signal -- a match can show duration:"REGULAR" while still
    //     carrying a populated `extraTime` object (Belgium vs Senegal,
    //     2026-07-01: duration REGULAR, fullTime 3-2, extraTime 1-0,
    //     regularTime explicitly {null,null}).
    //   - `regularTime` is sometimes correctly populated even for
    //     matches that went past 90 (Germany vs Paraguay: regularTime
    //     1-1 alongside a penalty shootout) -- so when it IS present,
    //     trust it directly.
    //
    // So the actual rule, in priority order:
    //   1. If regularTime is populated, use it.
    //   2. Else, if an extraTime object exists at all (regardless of
    //      what `duration` claims), the match went past 90 minutes --
    //      derive the 90-minute score as fullTime minus extraTime.
    //   3. Else, it's a plain match that never left regulation time --
    //      fullTime IS the regulation score.
    const rt = pair(score.regularTime);
    if (rt) {
      scoreHome = rt.home;
      scoreAway = rt.away;
    } else if (score.extraTime) {
      const ft = pair(score.fullTime);
      const et = pair(score.extraTime);
      if (ft && et) {
        scoreHome = ft.home - et.home;
        scoreAway = ft.away - et.away;
      }
    } else {
      const ft = pair(score.fullTime);
      if (ft) {
        scoreHome = ft.home;
        scoreAway = ft.away;
      }
    }
  } else if (status === 'LIVE' || status === 'HT' || status === 'ET' || status === 'PEN') {
    // Nice-to-have: show a live-updating score while in progress.
    // Display-only -- overwritten by regularTime the moment the match
    // finishes, so it can never leak into grading.
    const ft = pair(score.fullTime);
    if (ft) {
      scoreHome = ft.home;
      scoreAway = ft.away;
    }
  }

  return {
    api_fixture_id: match.id,
    team_home: match.homeTeam && match.homeTeam.name ? match.homeTeam.name : 'TBD',
    team_away: match.awayTeam && match.awayTeam.name ? match.awayTeam.name : 'TBD',
    kickoff: match.utcDate,
    status,
    raw_status: `${match.status}${score.duration ? ':' + score.duration : ''}`,
    score_home: scoreHome,
    score_away: scoreAway,
    round: match.stage || null,
  };
}

async function fetchFixtures({ apiToken, competitionCode }) {
  const url = `${BASE}/competitions/${encodeURIComponent(competitionCode)}/matches`;
  const res = await fetch(url, {
    headers: { 'X-Auth-Token': apiToken },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`football-data.org request failed: ${res.status} ${res.statusText} ${body}`);
  }
  const data = await res.json();
  if (!data.matches) {
    throw new Error(`football-data.org error: ${JSON.stringify(data)}`);
  }
  return data.matches.map(normalizeMatch);
}

module.exports = { fetchFixtures, normalizeMatch, normalizeStatus };
