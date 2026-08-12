// sync-dashboard.js — Pré-calcule les scores du dashboard
// Lit data/players.json, fetch les stats via API, calcule les points, sauvegarde dashboard_scores.json.gz
// Usage: node sync-dashboard.js

import fs from "fs";
import zlib from "zlib";
import { API_BASE, openFrontFetch, hasExemption } from "./openfront-api.js";

const PLAYERS_FILE = "data/players.json";
const OUTPUT_FILE = "dashboard_scores.json";
const CONCURRENCY = 8;

// Barème
const SCORE = {
  ffa_casual: 10,
  ffa_ranked: 1,
  team_casual: 5,
  team_ranked: 1,
};

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fetchPlayerStats(publicId) {
  try {
    const data = await openFrontFetch(`${API_BASE}/public/player/${encodeURIComponent(publicId)}`);
    return data;
  } catch (e) {
    console.warn(`[dashboard-sync] Failed for ${publicId}: ${e.message}`);
    return null;
  }
}

function calculatePoints(stats) {
  if (!stats || !stats.stats) return { total: 0, ffa_casual: 0, ffa_ranked: 0, team_casual: 0, team_ranked: 0, ranked_elo: null, peak_elo: null };

  const tree = stats.stats;
  let ffaCasualWins = 0, ffaRankedWins = 0, teamCasualWins = 0, teamRankedWins = 0;

  // Parse stats tree: { Public: { "Free For All": { Easy: {wins, losses, total}, Medium: {...} }, Team: {...} }, Ranked: { "1v1": {...}, "2v2": {...} } }
  for (const catKey of Object.keys(tree)) {
    const cat = tree[catKey];
    if (!cat || typeof cat !== "object") continue;

    for (const modeKey of Object.keys(cat)) {
      const mode = cat[modeKey];
      if (!mode || typeof mode !== "object") continue;

      let modeWins = 0;
      for (const diffKey of Object.keys(mode)) {
        const diff = mode[diffKey];
        if (diff && typeof diff === "object" && diff.wins != null) {
          modeWins += parseInt(diff.wins, 10) || 0;
        }
      }

      if (catKey === "Public" || catKey === "Private") {
        if (modeKey === "Free For All") ffaCasualWins += modeWins;
        else if (modeKey === "Team") teamCasualWins += modeWins;
      } else if (catKey === "Ranked") {
        if (modeKey === "1v1") ffaRankedWins += modeWins;
        else if (modeKey === "2v2") teamRankedWins += modeWins;
        else if (modeKey === "Free For All") ffaRankedWins += modeWins;
        else if (modeKey === "Team") teamRankedWins += modeWins;
      }
    }
  }

  const total = ffaCasualWins * SCORE.ffa_casual + ffaRankedWins * SCORE.ffa_ranked + teamCasualWins * SCORE.team_casual + teamRankedWins * SCORE.team_ranked;

  return {
    total,
    ffa_casual: ffaCasualWins,
    ffa_ranked: ffaRankedWins,
    team_casual: teamCasualWins,
    team_ranked: teamRankedWins,
  };
}

async function main() {
  console.log("[dashboard-sync] 🚀 Démarrage");
  if (hasExemption()) console.log("[dashboard-sync] 🔑 Exemption active");

  // Load players
  const playersData = JSON.parse(fs.readFileSync(PLAYERS_FILE, "utf8"));
  const players = playersData.players || [];
  console.log(`[dashboard-sync] ${players.length} joueurs à traiter`);

  // Also load ranked.json for ELO
  let ranked1v1 = [], ranked2v2 = [];
  try {
    const ranked = JSON.parse(fs.readFileSync("ranked.json", "utf8"));
    ranked1v1 = ranked["1v1"] || [];
    ranked2v2 = ranked["2v2"] || [];
  } catch (e) { console.warn("[dashboard-sync] ranked.json introuvable"); }

  const rankedMap = {};
  for (const p of [...ranked1v1, ...ranked2v2]) {
    if (p.public_id) {
      if (!rankedMap[p.public_id]) rankedMap[p.public_id] = {};
      if (p.elo) rankedMap[p.public_id].elo = p.elo;
      if (p.peakElo) rankedMap[p.public_id].peak_elo = p.peakElo;
      if (p.username) rankedMap[p.public_id].username = p.username;
    }
  }

  // Fetch stats for all players in parallel chunks
  const results = [];
  const chunks = [];
  for (let i = 0; i < players.length; i += CONCURRENCY) {
    chunks.push(players.slice(i, i + CONCURRENCY));
  }

  let done = 0;
  for (const chunk of chunks) {
    await Promise.all(chunk.map(async (player) => {
      const publicId = player.openfrontId || player.publicId || player.public_id || player.id;
      const username = player.name || player.username || rankedMap[publicId]?.username || "Unknown";

      if (!publicId) return;

      const stats = await fetchPlayerStats(publicId);
      const points = calculatePoints(stats);
      const elo = rankedMap[publicId] || {};

      results.push({
        publicId,
        username,
        points: points.total,
        ffa_casual: points.ffa_casual,
        ffa_ranked: points.ffa_ranked,
        team_casual: points.team_casual,
        team_ranked: points.team_ranked,
        elo: elo.elo || null,
        peak_elo: elo.peak_elo || null,
      });

      done++;
      if (done % 20 === 0) console.log(`[dashboard-sync] ${done}/${players.length} traités`);
    }));
  }

  // Sort by points descending
  results.sort((a, b) => b.points - a.points);

  // Save
  const output = {
    lastUpdate: new Date().toISOString(),
    totalPlayers: results.length,
    players: results,
  };

  const json = JSON.stringify(output);
  fs.writeFileSync(OUTPUT_FILE, json);
  fs.writeFileSync(OUTPUT_FILE + ".gz", zlib.gzipSync(json));

  console.log(`[dashboard-sync] ✅ ${results.length} joueurs — ${(zlib.gzipSync(json).length / 1024).toFixed(1)} KB`);
  console.log(`[dashboard-sync] 🏁 Top 3:`);
  for (const p of results.slice(0, 3)) {
    console.log(`  ${p.username} (${p.publicId}): ${p.points} pts`);
  }
}

main().catch(e => { console.error("[dashboard-sync] Fatal:", e); process.exit(1); });
