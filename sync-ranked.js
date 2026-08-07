import fs from "fs";
import zlib from "zlib";
import {
  API_BASE,
  openFrontFetch,
  hasExemption,
} from "./openfront-api.js";

// Charger .env manuellement (même pattern que sync.js)
try {
  const envContent = fs.readFileSync(".env", "utf8");
  envContent.split(/\r?\n/).forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) return;
    const [key, ...valueParts] = trimmed.split("=");
    const value = valueParts.join("=").trim();
    if (key && value) {
      process.env[key.trim()] = value;
    }
  });
} catch (e) {
  // .env optionnel
}

const MAX_PAGES = 4; // 4 × 50 = top 200 joueurs
const MAX_HISTORY_POINTS = 200; // 200 points max par joueur (~50h de sync)
const RANKED_MODES = ["1v1", "2v2"];

async function fetchLeaderboard(mode = "1v1") {
  const allPlayers = [];
  let page = 1;

  console.log(`[ranked-sync] 📡 Fetching ${mode} leaderboard...`);

  while (page <= MAX_PAGES) {
    let players;

    // Strategy: fetch the main endpoint and look for the mode key in the response
    // The API likely returns { "1v1": [...], "2v2": [...] } or { "1v1": [...], "twoVtwo": [...] }
    // Or separate endpoints per mode
    const urls = [
      `${API_BASE}/leaderboard/ranked?page=${page}`,
      `${API_BASE}/leaderboard/ranked/2v2?page=${page}`,
      `${API_BASE}/leaderboard/ranked?type=2v2&page=${page}`,
    ];

    for (const url of urls) {
      try {
        const res = await openFrontFetch(url);
        if (!res.ok) {
          if (res.status === 401 || res.status === 403) {
            console.warn(`[ranked-sync] ⚠️ HTTP ${res.status} — token d'exemption manquant ou invalide.`);
            const cached = loadCachedMode(mode);
            if (cached) return cached;
            return allPlayers;
          }
          if (res.status === 404) continue;
          console.warn(`[ranked-sync] HTTP ${res.status} from ${url}`);
          continue;
        }
        const data = await res.json();

        // Try to find players for our mode in the response
        // Pattern 1: data[mode] — e.g. data["1v1"] or data["2v2"]
        if (data[mode] && Array.isArray(data[mode]) && data[mode].length > 0) {
          players = data[mode];
          break;
        }
        // Pattern 2: data.twoVtwo for 2v2 (matches internal schema naming)
        if (mode === "2v2" && data.twoVtwo && Array.isArray(data.twoVtwo) && data.twoVtwo.length > 0) {
          players = data.twoVtwo;
          break;
        }
        // Pattern 3: direct array (the endpoint returns just the array for the mode)
        if (Array.isArray(data) && data.length > 0 && data[0]?.rank != null) {
          players = data;
          break;
        }
      } catch (e) {
        console.warn(`[ranked-sync] Erreur ${url}:`, e.message);
        continue;
      }
    }

    if (!players || players.length === 0) {
      if (page === 1) console.log(`[ranked-sync] ${mode}: aucune donnée trouvée`);
      break;
    }
    allPlayers.push(...players);
    console.log(`[ranked-sync] ${mode} page ${page}: ${players.length} joueurs (total: ${allPlayers.length})`);
    page++;
  }

  return allPlayers;
}

function loadCachedMode(mode) {
  try {
    const cached = JSON.parse(fs.readFileSync("ranked.json", "utf8"));
    if (cached[mode] && cached[mode].length > 0) {
      console.log(`[ranked-sync] Cache précédent conservé pour ${mode}: ${cached[mode].length} joueurs.`);
      return cached[mode];
    }
  } catch (e) { /* no cache */ }
  return null;
}

async function enrichStreaks(players) {
  // Calcule la série de victoires/défaites consécutives pour le top 20
  const topN = 20;
  const enriched = [...players];
  for (let i = 0; i < Math.min(topN, enriched.length); i++) {
    const p = enriched[i];
    if (!p.public_id) continue;
    try {
      const res = await openFrontFetch(`${API_BASE}/public/player/${encodeURIComponent(p.public_id)}`);
      if (!res.ok) {
        console.warn(`[ranked-sync] Streak fetch ${p.username}: HTTP ${res.status}`);
        continue;
      }
      const data = await res.json();
      const games = (data.games || [])
        .filter(g => g.rankedType === '1v1' || g.mode === '1v1' || g.type === 'Ranked')
        .sort((a, b) => new Date(b.start || b.end || 0) - new Date(a.start || a.end || 0));

      let streak = 0;
      for (const g of games) {
        if (g.hasWon === true) {
          if (streak >= 0) streak++;
          else break;
        } else if (g.hasWon === false) {
          if (streak <= 0) streak--;
          else break;
        } else {
          break; // unknown result
        }
      }
      enriched[i] = { ...p, streak };
      console.log(`[ranked-sync] Streak #${i + 1} ${p.username}: ${streak > 0 ? '🔥+' + streak : streak < 0 ? '❄️' + streak : '0'}`);
    } catch (e) {
      console.warn(`[ranked-sync] Streak erreur ${p.username}:`, e.message);
    }
  }
  return enriched;
}

function loadHistory() {
  try {
    const raw = fs.readFileSync("ranked_history.json", "utf8");
    return JSON.parse(raw);
  } catch (e) {
    return {};
  }
}

function saveHistory(history, players, mode = "1v1") {
  const now = Date.now();
  const modePrefix = mode + ':';
  players.forEach(p => {
    if (!p.public_id) return;
    const key = modePrefix + p.public_id;
    if (!history[key]) history[key] = [];
    history[key].push({ t: now, elo: p.elo, rank: p.rank });
    // Garder les derniers MAX_HISTORY_POINTS
    if (history[key].length > MAX_HISTORY_POINTS) {
      history[key] = history[key].slice(-MAX_HISTORY_POINTS);
    }
  });

  // Nettoyer les joueurs non vus depuis 7 jours
  const weekAgo = now - 7 * 24 * 60 * 60 * 1000;
  Object.keys(history).forEach(key => {
    const arr = history[key];
    if (!arr || arr.length === 0) { delete history[key]; return; }
    const last = arr[arr.length - 1];
    if (last.t < weekAgo) delete history[key];
  });

  const json = JSON.stringify(history);
  fs.writeFileSync("ranked_history.json", json);
  fs.writeFileSync("ranked_history.json.gz", zlib.gzipSync(json));
  console.log(`[ranked-sync] 📈 Historique ${mode} sauvegardé: ${Object.keys(history).filter(k => k.startsWith(modePrefix)).length} joueurs`);
}

function computeNewcomersAndDropouts(currentPlayers, previousPlayers) {
  const currentIds = new Set(currentPlayers.map(p => p.public_id));
  const previousIds = new Set(previousPlayers.map(p => p.public_id));
  const previousById = new Map(previousPlayers.map(p => [p.public_id, p]));

  const newcomers = currentPlayers
    .filter(p => !previousIds.has(p.public_id))
    .map(p => ({ rank: p.rank, username: p.username, public_id: p.public_id, elo: p.elo }));

  const dropouts = previousPlayers
    .filter(p => !currentIds.has(p.public_id))
    .map(p => ({ rank: p.rank, username: p.username, public_id: p.public_id, elo: p.elo }));

  return { newcomers, dropouts };
}

function saveWithMovement(players, mode = "1v1") {
  // Charger l'ancien classement pour calculer les mouvements
  let previousById = new Map();
  let previousPlayers = [];
  try {
    const oldRaw = fs.readFileSync("ranked.json", "utf8");
    const oldData = JSON.parse(oldRaw);
    previousPlayers = oldData[mode] || [];
    previousPlayers.forEach(p => {
      if (p.public_id) previousById.set(p.public_id, p.rank);
    });
    console.log(`[ranked-sync] 📊 Ancien classement ${mode} chargé: ${previousPlayers.length} joueurs`);
  } catch (e) {
    console.log(`[ranked-sync] ℹ️ Pas d'ancien classement ${mode}, mouvements non calculés`);
  }

  // Ajouter movement (ancien rang - nouveau rang)
  const enriched = players.map(p => {
    const prevRank = previousById.get(p.public_id);
    const movement = prevRank != null ? prevRank - p.rank : null;
    return { ...p, movement };
  });

  // Nouveaux arrivants / sortants (top 100 uniquement)
  const top100 = enriched.slice(0, 100);
  const prevTop100 = previousPlayers.slice(0, 100);
  const { newcomers, dropouts } = computeNewcomersAndDropouts(top100, prevTop100);
  if (newcomers.length) console.log(`[ranked-sync] 🆕 ${mode} nouveaux: ${newcomers.map(n => n.username).join(', ')}`);
  if (dropouts.length) console.log(`[ranked-sync] 📉 ${mode} sortants: ${dropouts.map(d => d.username).join(', ')}`);

  return { players: enriched, newcomers, dropouts };
}

async function main() {
  console.log("[ranked-sync] 🚀 Démarrage du sync ranked (1v1 + 2v2)...");
  if (hasExemption()) {
    console.log("[ranked-sync] 🔑 Exemption Skailex active");
  } else {
    console.warn(
      "[ranked-sync] ⚠️ Pas d'exemption — les rate limits peuvent s'appliquer"
    );
  }

  // Charger le fichier existant pour merger les modes
  let existingData = {};
  try {
    existingData = JSON.parse(fs.readFileSync("ranked.json", "utf8"));
  } catch (e) { /* no existing file */ }

  const allModes = {};
  const allNewcomers = {};
  const allDropouts = {};

  for (const mode of RANKED_MODES) {
    const players = await fetchLeaderboard(mode);
    if (players.length === 0) {
      console.log(`[ranked-sync] ⚠️ ${mode}: aucune donnée — conservation du cache`);
      if (existingData[mode]) {
        allModes[mode] = existingData[mode];
      }
      continue;
    }

    const playersWithStreaks = await enrichStreaks(players);
    const history = loadHistory();
    saveHistory(history, playersWithStreaks, mode);
    const { players: enriched, newcomers, dropouts } = saveWithMovement(playersWithStreaks, mode);

    allModes[mode] = enriched;
    allNewcomers[mode] = newcomers;
    allDropouts[mode] = dropouts;

    const movements = enriched.filter(p => p.movement != null && p.movement !== 0).length;
    const streaks = enriched.filter(p => p.streak != null && p.streak !== 0).length;
    console.log(
      `[ranked-sync] 💾 ${mode}: ${enriched.length} joueurs (${movements} mouvements, ${streaks} streaks, ${newcomers.length}↑, ${dropouts.length}↓)`
    );
  }

  // Sauvegarder tous les modes dans un seul ranked.json
  const payload = {
    ...allModes,
    newcomers: allNewcomers,
    dropouts: allDropouts,
    updatedAt: new Date().toISOString(),
    totalPlayers: Object.values(allModes).reduce((sum, arr) => sum + arr.length, 0),
    modes: Object.keys(allModes),
  };
  const json = JSON.stringify(payload);
  fs.writeFileSync("ranked.json", json);
  fs.writeFileSync("ranked.json.gz", zlib.gzipSync(json));
  console.log(
    `[ranked-sync] 📦 ranked.json: ${(json.length / 1024).toFixed(0)} KB raw / ${(zlib.gzipSync(json).length / 1024).toFixed(0)} KB gz — modes: ${Object.keys(allModes).join(', ')}`
  );

  console.log("[ranked-sync] ✅ Terminé.");
}

main().catch((e) => {
  console.error("[ranked-sync] Fatal:", e);
  process.exit(1);
});
