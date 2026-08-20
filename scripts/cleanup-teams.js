/**
 * scripts/cleanup-teams.js — Clean up existing teams_runs.json data
 *
 * Bug: extractTeamRun was not limiting the number of winner players to
 * maxTeamSize. So Duos games could have 5, 9, even 50 players in the
 * winner team (instead of just 2).
 *
 * This script truncates each run's `players` array to the correct
 * maxTeamSize based on the mode.
 */
const fs = require("fs");

const MAX_TEAM_SIZES = {
  duos: 2,
  trios: 3,
  quads: 4,
  team_custom: 7,
  hvn: 999,  // no limit for HvN
};

function main() {
  const raw = JSON.parse(fs.readFileSync("teams_runs.json", "utf8"));
  let cleaned = 0;
  let totalRuns = 0;

  for (const [mode, maxSize] of Object.entries(MAX_TEAM_SIZES)) {
    const runs = raw[mode] || [];
    for (const run of runs) {
      totalRuns++;
      if (Array.isArray(run.players) && run.players.length > maxSize) {
        const before = run.players.length;
        run.players = run.players.slice(0, maxSize);
        cleaned++;
      }
    }
  }

  if (cleaned > 0) {
    const json = JSON.stringify(raw);
    fs.writeFileSync("teams_runs.json", json);
    const zlib = require("zlib");
    fs.writeFileSync("teams_runs.json.gz", zlib.gzipSync(json));
    console.log(`✓ Nettoyé ${cleaned} runs (sur ${totalRuns} total)`);
    console.log(`  Taille: ${(json.length / 1024 / 1024).toFixed(2)} MB`);
  } else {
    console.log(`✅ Aucun run à nettoyer (${totalRuns} runs analysés)`);
  }
}

main();
