/**
 * Diagnostic only -- prints the RAW, unmodified JSON for a couple of
 * finished matches straight from football-data.org, so we can see the
 * actual field names instead of guessing from documentation.
 *
 * Usage: node scripts/debug-fixture.js
 * (requires .env to be configured -- see .env.example)
 *
 * Run this and paste the output back -- it'll settle the home/away vs
 * homeTeam/awayTeam question (and anything else) with certainty.
 */
require('dotenv').config();

async function main() {
  const apiToken = process.env.FOOTBALL_DATA_TOKEN;
  if (!apiToken) {
    console.error('Set FOOTBALL_DATA_TOKEN in .env first.');
    process.exit(1);
  }
  const competitionCode = process.env.COMPETITION_CODE || 'WC';

  const res = await fetch(`https://api.football-data.org/v4/competitions/${competitionCode}/matches`, {
    headers: { 'X-Auth-Token': apiToken },
  });
  if (!res.ok) {
    console.error('Request failed:', res.status, res.statusText, await res.text());
    process.exit(1);
  }
  const data = await res.json();
  const matches = data.matches || [];

  // Find Belgium vs Senegal specifically (went to extra time), plus the
  // first plain FINISHED match we see (no extra time), so we can
  // compare both shapes side by side.
  const belSen = matches.find(m =>
    /belgium/i.test(m.homeTeam?.name || '') && /senegal/i.test(m.awayTeam?.name || '')
  );
  const plainFinished = matches.find(m => m.status === 'FINISHED' && m !== belSen);

  console.log('=== Full raw match object: Belgium vs Senegal (if found) ===');
  console.log(JSON.stringify(belSen, null, 2));

  console.log('\n=== Full raw match object: a plain finished match (for comparison) ===');
  console.log(JSON.stringify(plainFinished, null, 2));

  console.log('\n=== Just the "score" key across ALL finished matches, deduped by shape ===');
  const seenShapes = new Set();
  for (const m of matches) {
    if (m.status !== 'FINISHED') continue;
    const shape = JSON.stringify(Object.keys(m.score || {}).sort());
    if (seenShapes.has(shape)) continue;
    seenShapes.add(shape);
    console.log(`${m.homeTeam?.name} vs ${m.awayTeam?.name}:`, JSON.stringify(m.score));
  }
}

main().catch(e => { console.error(e); process.exit(1); });
