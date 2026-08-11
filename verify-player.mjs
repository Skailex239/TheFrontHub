/**
 * verify-player.mjs v2 — Récupère TOUTES les parties d'un joueur via l'API
 * OpenFront avec backoff exponentiel sur les 429 et sauvegarde progressive.
 *
 * Usage: node verify-player.mjs <publicId>
 */
import fs from "fs";

const API_BASE = "https://api.openfront.io";
const PUBLIC_ID = process.argv[2] || "UWetOwlW";
const MAX_PAGES = 2000;
const RESULT_FILE = "verify-player-result.json";
const GAMES_FILE = "verify-player-games.json";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchJsonWithRetry(url, attempt = 0) {
  const r = await fetch(url, { headers: { "User-Agent": "TheFrontHub-Verify/1.0" } });
  if (r.status === 429) {
    const wait = Math.min(30000, 2000 * Math.pow(2, attempt));
    if (attempt < 6) {
      process.stdout.write(`  429 (retry in ${wait}ms)...`);
      await sleep(wait);
      process.stdout.write(" retry...");
      return fetchJsonWithRetry(url, attempt + 1);
    }
    throw new Error(`429 after ${attempt} retries`);
  }
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

function classify(g) {
  const mode = String(g.mode || "").toLowerCase();
  const rt = String(g.rankedType || "").toLowerCase();
  const isTeam =
    mode === "team" ||
    mode.startsWith("2v2") ||
    mode.startsWith("3v3") ||
    mode.startsWith("4v4") ||
    rt === "2v2";
  const isRanked = rt === "1v1" || rt === "2v2" || rt === "ranked";
  if (isTeam) return isRanked ? "teamRanked" : "teamCasual";
  return isRanked ? "ffaRanked" : "ffaCasual";
}

function computeStats(allGames) {
  const wins = { ffaCasual: 0, ffaRanked: 0, teamCasual: 0, teamRanked: 0 };
  const losses = { ffaCasual: 0, ffaRanked: 0, teamCasual: 0, teamRanked: 0 };
  const incomplete = { ffaCasual: 0, ffaRanked: 0, teamCasual: 0, teamRanked: 0 };
  for (const g of allGames) {
    const cat = classify(g);
    if (g.result === "victory") wins[cat]++;
    else if (g.result === "defeat") losses[cat]++;
    else incomplete[cat]++;
  }
  return { wins, losses, incomplete };
}

(async () => {
  console.log(`\n=== Récupération de TOUTES les parties de ${PUBLIC_ID} ===\n`);
  const allGames = [];
  let cursor = null;
  let page = 0;
  const startedAt = Date.now();

  while (page < MAX_PAGES) {
    page++;
    let url = `${API_BASE}/public/player/${PUBLIC_ID}/games`;
    if (cursor) url += `?cursor=${encodeURIComponent(cursor)}`;
    process.stdout.write(`  [${page}] ${new Date().toISOString().slice(11, 19)} `);
    let data;
    try {
      data = await fetchJsonWithRetry(url);
    } catch (e) {
      console.error(`❌ ${e.message}`);
      break;
    }
    const n = data.results?.length || 0;
    console.log(`${n} games`);
    if (n > 0) allGames.push(...data.results);
    // Sauvegarde progressive
    fs.writeFileSync(GAMES_FILE, JSON.stringify({ publicId: PUBLIC_ID, games: allGames }, null, 0));
    if (!data.nextCursor) {
      console.log("  → Fin de pagination");
      break;
    }
    cursor = data.nextCursor;
    // Délai variable selon si on a eu des 429 récemment
    await sleep(500);
  }

  const elapsed = Math.round((Date.now() - startedAt) / 1000);
  console.log(`\n=== Total: ${allGames.length} parties en ${elapsed}s ===\n`);

  const { wins, losses, incomplete } = computeStats(allGames);
  console.log("=== Résultats par catégorie (LIVE API) ===");
  console.log(`FFA casual  : ${wins.ffaCasual} victoires / ${losses.ffaCasual} défaites / ${incomplete.ffaCasual} incomplètes`);
  console.log(`FFA classé  : ${wins.ffaRanked} victoires / ${losses.ffaRanked} défaites / ${incomplete.ffaRanked} incomplètes`);
  console.log(`Team casual : ${wins.teamCasual} victoires / ${losses.teamCasual} défaites / ${incomplete.teamCasual} incomplètes`);
  console.log(`Team classé : ${wins.teamRanked} victoires / ${losses.teamRanked} défaites / ${incomplete.teamRanked} incomplètes`);

  // Points selon le barème actuel (10/1/5/1) — "ranked = 1 pt, pas en plus"
  const pts_v1 = wins.ffaCasual * 10 + wins.ffaRanked * 1 + wins.teamCasual * 5 + wins.teamRanked * 1;
  // Points selon le barème alternatif (10/11/5/6) — "ranked = casual + bonus +1"
  const pts_v2 = wins.ffaCasual * 10 + wins.ffaRanked * 11 + wins.teamCasual * 5 + wins.teamRanked * 6;

  console.log("\n=== Calcul des points ===");
  console.log(`Barème actuel    (FFA casual +10, FFA classé +1, Team casual +5, Team classé +1) = ${pts_v1} pts`);
  console.log(`Barème alternatif (FFA casual +10, FFA classé +11, Team casual +5, Team classé +6) = ${pts_v2} pts`);

  // Comparaison avec le dashboard
  try {
    const dash = JSON.parse(fs.readFileSync("dashboard_ranking.json", "utf8"));
    const dp = dash.global.players.find((p) => p.publicId === PUBLIC_ID);
    if (dp) {
      console.log("\n=== Comparaison avec dashboard_ranking.json (sync) ===");
      console.log(`                Dashboard (sync)   API (live)    Diff`);
      console.log(`FFA casual  :   ${dp.ffaCasualWins}                 ${wins.ffaCasual}              ${wins.ffaCasual - dp.ffaCasualWins}`);
      console.log(`FFA classé  :   ${dp.ffaRankedWins}                ${wins.ffaRanked}              ${wins.ffaRanked - dp.ffaRankedWins}`);
      console.log(`Team casual :   ${dp.teamCasualWins}                 ${wins.teamCasual}              ${wins.teamCasual - dp.teamCasualWins}`);
      console.log(`Team classé :   ${dp.teamRankedWins}                ${wins.teamRanked}              ${wins.teamRanked - dp.teamRankedWins}`);
      console.log(`Points (v1) :   ${dp.points}                ${pts_v1}             ${pts_v1 - dp.points}`);
    }
  } catch (e) {
    console.log("\n(pas de dashboard_ranking.json pour comparaison)");
  }

  const result = {
    publicId: PUBLIC_ID,
    fetchedAt: new Date().toISOString(),
    elapsedSec: elapsed,
    totalGames: allGames.length,
    wins,
    losses,
    incomplete,
    points_v1_current: pts_v1,
    points_v2_alt: pts_v2,
  };
  fs.writeFileSync(RESULT_FILE, JSON.stringify(result, null, 2));
  console.log(`\n→ ${allGames.length} games sauvés dans ${GAMES_FILE}`);
  console.log(`→ Stats sauvées dans ${RESULT_FILE}`);
})().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
