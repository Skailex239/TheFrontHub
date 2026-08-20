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

const TEAM_SIZES = {
  duos: { min: 2, max: 2 },
  trios: { min: 3, max: 3 },
  quads: { min: 4, max: 4 },
  team_custom: { min: 5, max: 7 },
  hvn: { min: 1, max: 999 },  // HvN teams can be any size
};

function main() {
  const raw = JSON.parse(fs.readFileSync("teams_runs.json", "utf8"));
  let cleaned = 0;
  let removed = 0;
  let totalRuns = 0;

  for (const [mode, { min: minSize, max: maxSize }] of Object.entries(TEAM_SIZES)) {
    const runs = raw[mode] || [];
    const keptRuns = [];
    for (const run of runs) {
      totalRuns++;
      const playerCount = Array.isArray(run.players) ? run.players.length : 0;

      // Trop de joueurs → tronquer
      if (playerCount > maxSize) {
        run.players = run.players.slice(0, maxSize);
        cleaned++;
      }

      // Trop peu de joueurs → supprimer la run (équipe incomplète = bug)
      if (playerCount < minSize) {
        removed++;
        continue;  // ne pas garder cette run
      }

      keptRuns.push(run);
    }
    raw[mode] = keptRuns;
  }

  if (cleaned > 0 || removed > 0) {
    const json = JSON.stringify(raw);
    fs.writeFileSync("teams_runs.json", json);
    const zlib = require("zlib");
    fs.writeFileSync("teams_runs.json.gz", zlib.gzipSync(json));
    console.log(`✓ Nettoyé ${cleaned} runs (tronquées à maxTeamSize)`);
    console.log(`✓ Supprimé ${removed} runs (équipe incomplète, <minSize)`);
    console.log(`  Total runs avant: ${totalRuns}`);
    console.log(`  Total runs après: ${totalRuns - removed}`);
    console.log(`  Taille: ${(json.length / 1024 / 1024).toFixed(2)} MB`);
  } else {
    console.log(`✅ Aucun run à nettoyer (${totalRuns} runs analysés)`);
  }
}

main();
