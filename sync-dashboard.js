// sync-dashboard.js — Pré-calcule les scores du dashboard
// Sources de joueurs (fusionnées par publicId) :
//   1. data/players.json (joueurs Discord)
//   2. Firebase public-aliases (joueurs connectés via Google/Discord)
//   3. ranked.json (top 100 1v1 + top 100 2v2 — nouveaux ranked auto-inclus)
// Usage: node sync-dashboard.js

import fs from "fs";
import zlib from "zlib";
import { API_BASE, openFrontFetch, hasExemption } from "./openfront-api.js";

const PLAYERS_FILE = "data/players.json";
const OUTPUT_FILE = "dashboard_scores.json";
const CONCURRENCY = 8;
const FIRESTORE_BASE = "https://firestore.googleapis.com/v1/projects/openfront-speedrun/databases/(default)/documents";

const SCORE = {
  ffa_casual: 10,
  ffa_ranked: 1,
  team_casual: 5,
  team_ranked: 1,
};

async function fetchPlayerStats(publicId) {
  try {
    const res = await openFrontFetch(`${API_BASE}/public/player/${encodeURIComponent(publicId)}`);
    if (!res || !res.ok) return null;
    return await res.json();
  } catch (e) {
    console.warn(`[dashboard-sync] Failed for ${publicId}: ${e.message}`);
    return null;
  }
}

async function loadFirebasePlayers() {
  try {
    const res = await fetch(`${FIRESTORE_BASE}/public-aliases`, { cache: "no-store" });
    if (!res.ok) { console.warn(`[dashboard-sync] Firebase: HTTP ${res.status}`); return []; }
    const data = await res.json();
    const docs = data.documents || [];
    const players = [];
    const seen = new Set();
    for (const doc of docs) {
      const fields = doc.fields || {};
      const val = (f) => (f?.stringValue || f?.integerValue || "");
      const publicId = val(fields.publicId);
      if (!publicId || !/^[A-Za-z0-9]{8}$/.test(publicId) || seen.has(publicId)) continue;
      seen.add(publicId);
      players.push({ publicId, name: val(fields.username) || publicId, openfrontId: publicId, source: "firebase" });
    }
    console.log(`[dashboard-sync] Firebase: ${players.length} joueurs connectés`);
    return players;
  } catch (e) {
    console.warn(`[dashboard-sync] Firebase error: ${e.message}`);
    return [];
  }
}

function loadRankedPlayers(ranked) {
  const players = [];
  const seen = new Set();
  for (const p of [...(ranked["1v1"] || []), ...(ranked["2v2"] || [])]) {
    const pid = p.public_id;
    if (!pid || seen.has(pid)) continue;
    seen.add(pid);
    players.push({ publicId: pid, name: p.username || p.accountUsername || pid, openfrontId: pid, source: "ranked" });
  }
  console.log(`[dashboard-sync] ranked.json: ${players.length} joueurs classés`);
  return players;
}

function calculatePoints(apiResponse) {
  if (!apiResponse) return { total: 0, ffa_casual: 0, ffa_ranked: 0, team_casual: 0, team_ranked: 0 };
  let tree = null;
  if (apiResponse.stats && typeof apiResponse.stats === "object") {
    tree = apiResponse.stats;
  } else if (apiResponse.Public || apiResponse.Private || apiResponse.Ranked) {
    tree = apiResponse;
  } else {
    return { total: 0, ffa_casual: 0, ffa_ranked: 0, team_casual: 0, team_ranked: 0 };
  }
  let ffaCasualWins = 0, ffaRankedWins = 0, teamCasualWins = 0, teamRankedWins = 0;
  for (const catKey of Object.keys(tree)) {
    const cat = tree[catKey];
    if (!cat || typeof cat !== "object") continue;
    for (const modeKey of Object.keys(cat)) {
      const mode = cat[modeKey];
      if (!mode || typeof mode !== "object") continue;
      let modeWins = 0;
      for (const diffKey of Object.keys(mode)) {
        const diff = mode[diffKey];
        if (diff && typeof diff === "object" && diff.wins != null) modeWins += parseInt(diff.wins, 10) || 0;
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
  return { total, ffa_casual: ffaCasualWins, ffa_ranked: ffaRankedWins, team_casual: teamCasualWins, team_ranked: teamRankedWins };
}


// Fetch recent games (last 7 days) for weekly stats
async function fetchWeeklyWins(publicId) {
  try {
    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    let cursor = null;
    let ffaCasual = 0, ffaRanked = 0, teamCasual = 0, teamRanked = 0;
    
    for (let page = 0; page < 10; page++) {
      let url = `${API_BASE}/public/player/${encodeURIComponent(publicId)}/games?limit=50`;
      if (cursor) url += `&cursor=${encodeURIComponent(cursor)}`;
      
      const res = await openFrontFetch(url);
      if (!res || !res.ok) break;
      const data = await res.json();
      const games = data.results || data.games || [];
      if (!games.length) break;
      
      let stop = false;
      for (const g of games) {
        const gameDate = g.start ? new Date(g.start) : null;
        if (gameDate && gameDate < new Date(weekAgo)) { stop = true; break; }
        if (g.result !== 'victory') continue;
        
        const mode = g.mode || g.gameMode || '';
        const type = g.type || g.gameType || '';
        const ranked = g.rankedType || '';
        
        if (ranked === '1v1' || ranked === '2v2') {
          if (ranked === '1v1') ffaRanked++;
          else teamRanked++;
        } else if (mode === 'Free For All' || mode === 'FFA') {
          ffaCasual++;
        } else if (mode === 'Team') {
          teamCasual++;
        }
      }
      
      cursor = data.nextCursor || data.cursor;
      if (!cursor || stop) break;
    }
    
    return { ffa_casual: ffaCasual, ffa_ranked: ffaRanked, team_casual: teamCasual, team_ranked: teamRanked };
  } catch (e) {
    return { ffa_casual: 0, ffa_ranked: 0, team_casual: 0, team_ranked: 0 };
  }
}

async function main() {
  console.log("[dashboard-sync] 🚀 Démarrage");
  if (hasExemption()) console.log("[dashboard-sync] 🔑 Exemption active");

  // 1. data/players.json (Discord)
  const playersData = JSON.parse(fs.readFileSync(PLAYERS_FILE, "utf8"));
  const discordPlayers = (playersData.players || []).map(p => ({
    publicId: p.openfrontId || p.publicId || p.public_id || p.id,
    name: p.name || p.username || "Unknown",
    source: "discord",
  })).filter(p => p.publicId);
  console.log(`[dashboard-sync] data/players.json: ${discordPlayers.length} joueurs Discord`);

  // 2. Firebase public-aliases (connectés)
  const firebasePlayers = await loadFirebasePlayers();

  // 3. ranked.json (top 100 1v1 + top 100 2v2)
  let ranked = {};
  let rankedPlayers = [];
  let rankedMap = {};
  try {
    ranked = JSON.parse(fs.readFileSync("ranked.json", "utf8"));
    rankedPlayers = loadRankedPlayers(ranked);
    for (const p of [...(ranked["1v1"] || []), ...(ranked["2v2"] || [])]) {
      if (p.public_id) {
        if (!rankedMap[p.public_id]) rankedMap[p.public_id] = {};
        if (p.elo) rankedMap[p.public_id].elo = p.elo;
        if (p.peakElo) rankedMap[p.public_id].peak_elo = p.peakElo;
        if (p.username) rankedMap[p.public_id].username = p.username;
      }
    }
  } catch (e) { console.warn("[dashboard-sync] ranked.json introuvable"); }

  // 4. Fusionner les 3 sources (déduire par publicId)
  const merged = new Map();
  for (const p of discordPlayers) if (p.publicId && !merged.has(p.publicId)) merged.set(p.publicId, p);
  for (const p of firebasePlayers) if (p.publicId && !merged.has(p.publicId)) merged.set(p.publicId, p);
  for (const p of rankedPlayers) if (p.publicId && !merged.has(p.publicId)) merged.set(p.publicId, p);

  const allPlayers = [...merged.values()];
  console.log(`[dashboard-sync] Total: ${allPlayers.length} joueurs (${discordPlayers.length} Discord + ${firebasePlayers.length} Firebase + ${rankedPlayers.length} Ranked)`);

  // 5. Fetch stats
  const results = [];
  const chunks = [];
  for (let i = 0; i < allPlayers.length; i += CONCURRENCY) chunks.push(allPlayers.slice(i, i + CONCURRENCY));

  let done = 0;
  for (const chunk of chunks) {
    await Promise.all(chunk.map(async (player) => {
      const publicId = player.publicId;
      const username = player.name || rankedMap[publicId]?.username || "Unknown";
      if (!publicId) return;

      const stats = await fetchPlayerStats(publicId);
      const points = calculatePoints(stats);
      const elo = rankedMap[publicId] || {};

      // Pour les joueurs ranked-only (pas de stats API), utiliser ranked.json directement
      let finalPoints = points.total;
      let ffaRanked = points.ffa_ranked;
      let teamRanked = points.team_ranked;
      if (finalPoints === 0 && elo.elo) {
        // Joueur ranked mais pas de stats casual → utiliser wins de ranked.json
        const r1v1 = (ranked["1v1"] || []).find(p => p.public_id === publicId);
        const r2v2 = (ranked["2v2"] || []).find(p => p.public_id === publicId);
        ffaRanked = r1v1?.wins || 0;
        teamRanked = r2v2?.wins || 0;
        finalPoints = ffaRanked * SCORE.ffa_ranked + teamRanked * SCORE.team_ranked;
      }

      // Fetch weekly wins (last 7 days)
      const weekly = await fetchWeeklyWins(publicId);
      const weeklyPoints = weekly.ffa_casual * SCORE.ffa_casual + weekly.ffa_ranked * SCORE.ffa_ranked + weekly.team_casual * SCORE.team_casual + weekly.team_ranked * SCORE.team_ranked;
      
      results.push({
        publicId, username,
        points: finalPoints,
        ffa_casual: points.ffa_casual,
        ffa_ranked: ffaRanked,
        team_casual: points.team_casual,
        team_ranked: teamRanked,
        weekly_ffa_casual: weekly.ffa_casual,
        weekly_ffa_ranked: weekly.ffa_ranked,
        weekly_team_casual: weekly.team_casual,
        weekly_team_ranked: weekly.team_ranked,
        weekly_points: weeklyPoints,
        elo: elo.elo || null,
        peak_elo: elo.peak_elo || null,
      });

      done++;
      if (done % 20 === 0) console.log(`[dashboard-sync] ${done}/${allPlayers.length} traités`);
    }));
  }

  results.sort((a, b) => b.points - a.points);

  const output = { lastUpdate: new Date().toISOString(), totalPlayers: results.length, players: results };
  const json = JSON.stringify(output);
  fs.writeFileSync(OUTPUT_FILE, json);
  fs.writeFileSync(OUTPUT_FILE + ".gz", zlib.gzipSync(json));

  console.log(`[dashboard-sync] ✅ ${results.length} joueurs — ${(zlib.gzipSync(json).length / 1024).toFixed(1)} KB`);
  console.log(`[dashboard-sync] 🏁 Top 3:`);
  for (const p of results.slice(0, 3)) console.log(`  ${p.username} (${p.publicId}): ${p.points} pts`);
}

main().catch(e => { console.error("[dashboard-sync] Fatal:", e); process.exit(1); });
