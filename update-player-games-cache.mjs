/**
 * update-player-games-cache.mjs — Met à jour dashboard_player_games.json
 * avec les 20 games les plus récentes de Skailex (pour la page profil).
 */
import fs from "fs";

const PUBLIC_ID = "UWetOwlW";

// Charger les games live
let liveGames = [];
try {
  const s = JSON.parse(fs.readFileSync("verify-state.json", "utf8"));
  if (s.publicId === PUBLIC_ID && Array.isArray(s.games)) liveGames = s.games;
} catch (e) {
  const g = JSON.parse(fs.readFileSync("verify-player-games.json", "utf8"));
  if (g.publicId === PUBLIC_ID) liveGames = g.games || [];
}
console.log(`${liveGames.length} games chargées pour ${PUBLIC_ID}`);

// Trier par date décroissante et prendre les 20 plus récentes
liveGames.sort((a, b) => new Date(b.start) - new Date(a.start));
const recent = liveGames.slice(0, 20).map((g) => ({
  gameId: g.gameId,
  start: g.start,
  duration: g.durationSeconds,
  map: g.map,
  mode: g.mode,
  rankedType: g.rankedType,
  result: g.result,
  totalPlayers: g.totalPlayers,
}));

// Charger le cache existant et mettre à jour
const cacheFile = "dashboard_player_games.json";
let cache = {};
try {
  cache = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
} catch (e) {
  console.log("Cache inexistant, création");
}

cache[PUBLIC_ID] = {
  username: "Skailex on YT",
  recent,
};

fs.writeFileSync(cacheFile, JSON.stringify(cache, null, 2));
fs.writeFileSync("public/dashboard_player_games.json", JSON.stringify(cache, null, 2));
console.log(`Cache mis à jour : ${recent.length} games récentes pour ${PUBLIC_ID}`);
console.log("Première game récente:", recent[0]?.start);
console.log("20e game récente  :", recent[19]?.start);
