/**
 * update-skailex.mjs — Met à jour l'entrée Skailex (UWetOwlW) dans
 * dashboard_ranking.json avec les vraies stats calculées depuis l'API live.
 *
 * Stratégie de merge :
 *  - ffaCasualWins  : API live (ranked.json n'a pas de casual)
 *  - ffaRankedWins  : max(API live, ranked.json career) — ranked.json a le total carrière
 *  - teamCasualWins : API live
 *  - teamRankedWins : max(API live, ranked.json career)
 *  - points         : recalculé avec le barème (10/1/5/1)
 *
 * Met aussi à jour la vue weekly (7 derniers jours).
 */
import fs from "fs";

const PUBLIC_ID = "UWetOwlW";
const WEEKLY_MS = 7 * 24 * 60 * 60 * 1000;
const PTS = { ffaCasual: 10, ffaRanked: 1, teamCasual: 5, teamRanked: 1 };

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

function computePoints(p) {
  return (
    (p.ffaCasualWins || 0) * PTS.ffaCasual +
    (p.ffaRankedWins || 0) * PTS.ffaRanked +
    (p.teamCasualWins || 0) * PTS.teamCasual +
    (p.teamRankedWins || 0) * PTS.teamRanked
  );
}

// ── 1. Charger les games depuis verify-state.json (ou verify-player-games.json) ──
let liveGames = [];
try {
  const s = JSON.parse(fs.readFileSync("verify-state.json", "utf8"));
  if (s.publicId === PUBLIC_ID && Array.isArray(s.games)) liveGames = s.games;
}
catch (e) {
  const g = JSON.parse(fs.readFileSync("verify-player-games.json", "utf8"));
  if (g.publicId === PUBLIC_ID) liveGames = g.games || [];
}
console.log(`1. ${liveGames.length} games chargées depuis l'API live`);

// ── 2. Charger ranked.json pour les career ranked wins ──
const ranked = JSON.parse(fs.readFileSync("ranked.json", "utf8"));
const r1v1 = (ranked["1v1"] || []).find((p) => p.public_id === PUBLIC_ID);
const r2v2 = (ranked["2v2"] || []).find((p) => p.public_id === PUBLIC_ID);
console.log(`2. ranked.json: 1v1=${r1v1?.wins || 0} wins / 2v2=${r2v2?.wins || 0} wins (career)`);

// ── 3. Calculer les wins globales + weekly ──
const wins = { ffaCasual: 0, ffaRanked: 0, teamCasual: 0, teamRanked: 0 };
const winsWeek = { ffaCasual: 0, ffaRanked: 0, teamCasual: 0, teamRanked: 0 };
const now = Date.now();

for (const g of liveGames) {
  if (g.result !== "victory") continue;
  const cat = classify(g);
  wins[cat]++;
  if (g.start && now - new Date(g.start).getTime() < WEEKLY_MS) {
    winsWeek[cat]++;
  }
}

// Merge : pour les ranked, on prend le max entre API et ranked.json (career)
const finalGlobal = {
  ffaCasualWins: wins.ffaCasual,
  ffaRankedWins: Math.max(wins.ffaRanked, r1v1?.wins || 0),
  teamCasualWins: wins.teamCasual,
  teamRankedWins: Math.max(wins.teamRanked, r2v2?.wins || 0),
};
const finalWeekly = {
  ffaCasualWins: winsWeek.ffaCasual,
  ffaRankedWins: winsWeek.ffaRanked,
  teamCasualWins: winsWeek.teamCasual,
  teamRankedWins: winsWeek.teamRanked,
};

console.log("\n3. Stats finales (merge intelligent) :");
console.log("   Global:", finalGlobal, "→", computePoints(finalGlobal), "pts");
console.log("   Weekly:", finalWeekly, "→", computePoints(finalWeekly), "pts");

// ── 4. Mettre à jour dashboard_ranking.json ──
const dash = JSON.parse(fs.readFileSync("dashboard_ranking.json", "utf8"));

function updateView(view, finalStats) {
  const idx = dash[view].players.findIndex((p) => p.publicId === PUBLIC_ID);
  if (idx < 0) {
    console.log(`   ${view}: joueur non trouvé, ajout`);
    dash[view].players.push({
      publicId: PUBLIC_ID,
      username: "Skailex on YT",
      clan: null,
      ...finalStats,
      points: computePoints(finalStats),
    });
  } else {
    console.log(`   ${view}: avant =`, dash[view].players[idx], "→", computePoints(dash[view].players[idx]), "pts");
    dash[view].players[idx] = {
      ...dash[view].players[idx],
      ...finalStats,
      points: computePoints(finalStats),
    };
    console.log(`   ${view}: après =`, dash[view].players[idx], "→", computePoints(dash[view].players[idx]), "pts");
  }
  // Re-trier par points desc
  dash[view].players.sort((a, b) => (b.points || 0) - (a.points || 0));
}

console.log("\n4. Mise à jour dashboard_ranking.json :");
updateView("global", finalGlobal);
updateView("weekly", finalWeekly);

dash.updatedAt = new Date().toISOString();
dash.sources = {
  ...dash.sources,
  note: "Skailex (UWetOwlW) mis à jour via API live le " + dash.updatedAt,
};

// ── 5. Sauvegarder ──
fs.writeFileSync("dashboard_ranking.json", JSON.stringify(dash, null, 2));
fs.writeFileSync("public/dashboard_ranking.json", JSON.stringify(dash, null, 2));
console.log("\n5. dashboard_ranking.json mis à jour (local + public/)");

// Vérifier la nouvelle position
const newRank = dash.global.players.findIndex((p) => p.publicId === PUBLIC_ID) + 1;
const newWeekRank = dash.weekly.players.findIndex((p) => p.publicId === PUBLIC_ID) + 1;
console.log(`\n=== Résultat ===`);
console.log(`Global  : rank #${newRank} / ${dash.global.players.length} (${computePoints(finalGlobal)} pts)`);
console.log(`Weekly  : rank #${newWeekRank} / ${dash.weekly.players.length} (${computePoints(finalWeekly)} pts)`);
console.log(`\nTop 5 global:`);
dash.global.players.slice(0, 5).forEach((p, i) => {
  const me = p.publicId === PUBLIC_ID ? " ← TOI" : "";
  console.log(`  ${i + 1}. ${p.username} — ${p.points} pts${me}`);
});
