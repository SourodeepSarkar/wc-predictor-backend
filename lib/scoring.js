/**
 * Points rules (taken directly from the frontend's own "How It Works" box):
 *   Exact score              -> 3 points
 *   Correct result (W/D/L)   -> 1 point
 *   Wrong prediction         -> 0 points
 *
 * IMPORTANT: this must always be computed against the regulation
 * (90-minute) score, i.e. score_home/score_away as stored by
 * apiFootball.js's normalizeFixture(), which uses score.fulltime.
 * Never compute this against a live/extra-time/penalty score.
 */
function computePoints(predHome, predAway, actualHome, actualAway) {
  if (
    predHome === null || predHome === undefined ||
    predAway === null || predAway === undefined ||
    actualHome === null || actualHome === undefined ||
    actualAway === null || actualAway === undefined
  ) {
    return null;
  }
  if (predHome === actualHome && predAway === actualAway) return 3;

  const predResult = Math.sign(predHome - predAway);   // 1 home win, -1 away win, 0 draw
  const actualResult = Math.sign(actualHome - actualAway);
  if (predResult === actualResult) return 1;

  return 0;
}

module.exports = { computePoints };
