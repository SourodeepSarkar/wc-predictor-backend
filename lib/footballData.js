const BASE = 'https://api.football-data.org/v4';

/**
 * ---------------------------------------------------------------------
 * THE BUG, AND THE FIX (football-data.org edition)
 * ---------------------------------------------------------------------
 * football-data.org's `score` node carries several sub-scores. The
 * naming is a little counter-intuitive, so read carefully:
 *
 *   - score.fullTime   -> the FINAL match score, however the match
 *                          ended. For a knockout game decided in extra
 *                          time, this INCLUDES the extra-time goals.
 *                          (Despite the name, this is NOT the
 *                          90-minute score.)
 *   - score.regularTime -> the score at the end of 90 minutes, full
 *                          stop, regardless of what happened after.
 *                          This is what predictions must be graded
 *                          against.
 *   - score.extraTime   -> goals scored during extra time only.
 *   - score.penalties   -> the penalty shootout score only.
 *
 * The old backend's bug (reading a "final score" field without
 * distinguishing regulation time from extra time) maps exactly onto
 * the score.fullTime trap here. The fix is the same principle as
 * before: always grade against the explicitly-regulation-time field,
 * never the "whatever the final result was" field.
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

/**
 * Turns one raw football-data.org match into our normalized shape.
 * This is the single choke point for the fix — every caller must go
 * through here rather than reading score.fullTime directly for grading.
 */
function normalizeMatch(match) {
  const status = normalizeStatus(match);
  const score = match.score || {};

  let scoreHome = null;
  let scoreAway = null;

  if (status === 'FINISHED') {
    // THE FIX: always the 90-minute score, never fullTime (which for
    // AET/penalty matches includes extra-time goals).
    const rt = score.regularTime;
    if (rt && rt.home !== null && rt.home !== undefined) {
      scoreHome = rt.home;
      scoreAway = rt.away;
    } else if (score.duration === 'REGULAR' || !score.duration) {
      // Defensive fallback: a plain 90-minute finish where regularTime
      // wasn't populated (older data) — fullTime is safe to use here
      // because the match never went to extra time.
      scoreHome = score.fullTime ? score.fullTime.home : null;
      scoreAway = score.fullTime ? score.fullTime.away : null;
    }
  } else if (status === 'LIVE' || status === 'HT' || status === 'ET' || status === 'PEN') {
    // Nice-to-have: show a live-updating score while in progress.
    // Display-only — overwritten by regularTime the moment the match
    // finishes, so it can never leak into grading.
    scoreHome = score.fullTime ? score.fullTime.home : null;
    scoreAway = score.fullTime ? score.fullTime.away : null;
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