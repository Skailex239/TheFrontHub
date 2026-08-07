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
  envContent.split(/\\r?\\n/).forEach((line) => {
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

const MAX_PAGES = 4; // 4 × 50 = top 200 joueurs par ladder
const MAX_HISTORY_POINTS = 200; // 200 points max par joueur (~50h de sync)
const RANKED_TYPES = ["1v1", "2v2"];

// ── Normalisation d'une entrée brute de l'API ───────────────────────────────
// L'API retourne {rank, elo, peakElo, wins, losses, total, public_id, accountUsername, clanTag?}
// On ajoute `username` = accountUsername ?? public_id pour le frontend
function normalizeEntry(raw) {
  if (!raw || typeof raw !== "object") return null;
  const username = raw.accountUsername || raw.username || raw.public_id || "";
  return {
    rank: raw.rank,
    elo: raw.elo,
    peakElo: raw.peakElo ?? raw.elo,
    wins: raw.wins ?? 0,
    losses: raw.losses ?? 0,
    total: raw.total ?? (raw.wins ?? 0) + (raw.losses ?? 0),
    public_id: raw.public_id,
    accountUsername: raw.accountUsername ?? null,
    username,
    clanTag: raw.clanTag ?? null,
    // streak / movement seront ajoutés ensuite
  };
}

async function fetchLeaderboard() {
  const aggregated = { "1v1": [], "2v2": [] };
  let page = 1;
  let reachedEnd = { "1v1": false, "2v2": false };

  while (page <= MAX_PAGES) {
    const url = `${API_BASE}/leaderboard/ranked?page=${page}`;
    try {
      const res = await openFrontFetch(url);
      if (!res.ok) {
        if (res.status === 404) {
          console.log(`[ranked-sync] Page ${page}: 404, arrêt.`);
          break;
        }
        if (res.status === 400) {
          // OpenFront renvoie 400 quand on dépasse la fin du leaderboard
          try {
            const body = await res.json();
            const msg = JSON.stringify(body);
            if (msg.includes("page") || msg.includes("limit") || msg.includes("reached")) {
              console.log(`[ranked-sync] Page ${page}: fin du leaderboard (400 page bounds).`);
              break;
            }
          } catch {}
          console.warn(`[ranked-sync] HTTP 400 à la page ${page} — arrêt.`);
          break;
        }
        if (res.status === 401 || res.status === 403) {
          console.warn(`[ranked-sync] ⚠️ HTTP ${res.status} — token d'exemption manquant ou invalide.`);
          console.warn(`[ranked-sync] Conservation du cache précédent (ranked.json non écrasé).`);
          try {
            const cached = JSON.parse(fs.readFileSync("ranked.json", "utf8"));
            const legacy1v1 = Array.isArray(cached["1v1"]) ? cached["1v1"] : [];
            const legacy2v2 = Array.isArray(cached["2v2"]) ? cached["2v2"] : [];
            if (legacy1v1.length > 0 || legacy2v2.length > 0) {
              console.log(`[ranked-sync] Cache précédent conservé: 1v1=${legacy1v1.length}, 2v2=${legacy2v2.length}`);
              return { "1v1": legacy1v1, "2v2": legacy2v2, fromCache: true };
            }
          } catch (e2) { /* no cache available */ }
          return { "1v1": aggregated["1v1"], "2v2": aggregated["2v2"] };
        }
        console.warn(`[ranked-sync] HTTP ${res.status} à la page ${page}`);
        break;
      }
      const data = await res.json();
      // L'API retourne { "1v1": [...], "2v2": [...] } — 2v2 default [] si ancien déploiement
      const page1v1Raw = data["1v1"];
      const page2v2Raw = data["2v2"];

      const page1v1 = Array.isArray(page1v1Raw) ? page1v1Raw.map(normalizeEntry).filter(Boolean) : [];
      const page2v2 = Array.isArray(page2v2Raw) ? page2v2Raw.map(normalizeEntry).filter(Boolean) : [];

      if (page1v1.length === 0 && page2v2.length === 0) {
        console.log(`[ranked-sync] Page ${page}: vide pour 1v1 et 2v2, arrêt.`);
        break;
      }

      // Dedup par public_id (au cas où)
      const seen1v1 = new Set(aggregated["1v1"].map(p => p.public_id));
      for (const p of page1v1) {
        if (!seen1v1.has(p.public_id)) {
          aggregated["1v1"].push(p);
          seen1v1.add(p.public_id);
        }
      }
      const seen2v2 = new Set(aggregated["2v2"].map(p => p.public_id));
      for (const p of page2v2) {
        if (!seen2v2.has(p.public_id)) {
          aggregated["2v2"].push(p);
          seen2v2.add(p.public_id);
        }
      }

      console.log(`[ranked-sync] Page ${page}: 1v1=${page1v1.length} (total ${aggregated["1v1"].length}) | 2v2=${page2v2.length} (total ${aggregated["2v2"].length})`);

      // Si les deux ladders ont retourné < 50, on a atteint la fin commune
      // Sinon on continue : le 2v2 est plus jeune (moins de pages) mais le 1v1 peut encore avoir des pages
      const hasMore1v1 = page1v1.length >= 50;
      const hasMore2v2 = page2v2.length >= 50;
      if (!hasMore1v1) reachedEnd["1v1"] = true;
      if (!hasMore2v2) reachedEnd["2v2"] = true;
      if (reachedEnd["1v1"] && reachedEnd["2v2"]) {
        console.log(`[ranked-sync] Les deux ladders sont à court — arrêt à la page ${page}.`);
        break;
      }
      // Si un seul est à court, on continue quand même pour l'autre (page suivante retournera 0 pour celui terminé)
      page++;
    } catch (e) {
      console.warn(`[ranked-sync] Erreur page ${page}:`, e.message);
      break;
    }
  }

  // Si aucun joueur n'a été récupéré (réseau down, API KO…), ne pas écraser le cache avec du vide
  if (aggregated["1v1"].length === 0 && aggregated["2v2"].length === 0) {
    try {
      const cached = JSON.parse(fs.readFileSync("ranked.json", "utf8"));
      const c1 = Array.isArray(cached["1v1"]) ? cached["1v1"] : [];
      const c2 = Array.isArray(cached["2v2"]) ? cached["2v2"] : [];
      if (c1.length > 0 || c2.length > 0) {
        console.warn(`[ranked-sync] ⚠️ Aucune donnée récupérée — conservation du cache (1v1=${c1.length}, 2v2=${c2.length})`);
        return { "1v1": c1, "2v2": c2, fromCache: true };
      }
    } catch {}
    console.warn("[ranked-sync] ⚠️ Aucune donnée récupérée et pas de cache — payload vide conservé (évite écrase accidentel)");
    // On retourne quand même empty mais main() détectera fromCache=false → il va sauver vide ?
    // Pour éviter l'écrasement, on marque comme fromCache pour skip le save
    // Si on n'a vraiment pas de cache initial (premier run), on accepte le vide
    try {
      fs.accessSync("ranked.json");
      // si ranked.json existe mais vide → on évite d'écraser
      return { "1v1": aggregated["1v1"], "2v2": aggregated["2v2"], fromCache: true };
    } catch {}
  }

  return aggregated;
}

async function enrichStreaks(players, rankedType = "1v1") {
  if (!players || players.length === 0) return players;
  const topN = 20;
  const enriched = [...players];
  for (let i = 0; i < Math.min(topN, enriched.length); i++) {
    const p = enriched[i];
    if (!p.public_id) continue;
    try {
      const res = await openFrontFetch(`${API_BASE}/public/player/${encodeURIComponent(p.public_id)}`);
      if (!res.ok) {
        console.warn(`[ranked-sync] Streak fetch [${rankedType}] ${p.username}: HTTP ${res.status}`);
        continue;
      }
      const data = await res.json();
      const games = (data.games || [])
        .filter(g => g.rankedType === rankedType || g.mode === rankedType || (rankedType === "1v1" && g.type === "Ranked"))
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
      const streakIcon = streak > 0 ? '🔥+' + streak : streak < 0 ? '❄️' + streak : '0';
      console.log(`[ranked-sync] Streak [${rankedType}] #${i + 1} ${p.username}: ${streakIcon}`);
    } catch (e) {
      console.warn(`[ranked-sync] Streak erreur [${rankedType}] ${p.username}:`, e.message);
    }
    // petit délai pour éviter le burst si pas d'exemption
    if (!hasExemption()) await new Promise(r => setTimeout(r, 100));
  }
  return enriched;
}

function loadHistory() {
  try {
    const raw = fs.readFileSync("ranked_history.json", "utf8");
    const parsed = JSON.parse(raw);
    // Migration: si flat { public_id: [...] } → wrap en { "1v1": flat }
    if (parsed && typeof parsed === "object" && !parsed["1v1"] && !parsed["2v2"]) {
      // heuristique: si les clés ressemblent à des public_id (8 chars), c'est du flat
      const sampleKey = Object.keys(parsed)[0];
      if (sampleKey && sampleKey.length === 8) {
        console.log("[ranked-sync] 🔄 Migration ranked_history.json flat → {1v1, 2v2}");
        return { "1v1": parsed, "2v2": {} };
      }
    }
    return {
      "1v1": parsed["1v1"] || {},
      "2v2": parsed["2v2"] || {},
      // garde aussi le flat legacy si besoin
    };
  } catch (e) {
    return { "1v1": {}, "2v2": {} };
  }
}

function saveHistory(history, playersByMode) {
  const now = Date.now();
  for (const mode of RANKED_TYPES) {
    const players = playersByMode[mode] || [];
    if (!history[mode]) history[mode] = {};
    players.forEach(p => {
      if (!p.public_id) return;
      if (!history[mode][p.public_id]) history[mode][p.public_id] = [];
      history[mode][p.public_id].push({ t: now, elo: p.elo, rank: p.rank });
      if (history[mode][p.public_id].length > MAX_HISTORY_POINTS) {
        history[mode][p.public_id] = history[mode][p.public_id].slice(-MAX_HISTORY_POINTS);
      }
    });
    // Nettoyer >7j
    const weekAgo = now - 7 * 24 * 60 * 60 * 1000;
    Object.keys(history[mode]).forEach(pid => {
      const arr = history[mode][pid];
      if (!arr || arr.length === 0) { delete history[mode][pid]; return; }
      const last = arr[arr.length - 1];
      if (last.t < weekAgo) delete history[mode][pid];
    });
  }

  // Pour compat : si ancien code lit ranked_history.json comme flat, il tombera sur "1v1" key
  // mais on garde la structure nested propre
  const json = JSON.stringify(history);
  fs.writeFileSync("ranked_history.json", json);
  fs.writeFileSync("ranked_history.json.gz", zlib.gzipSync(json));
  const counts = RANKED_TYPES.map(m => `${m}:${Object.keys(history[m]||{}).length}`).join(' ');
  console.log(`[ranked-sync] 📈 Historique sauvegardé: ${counts} — ${(json.length / 1024).toFixed(0)} KB`);
}

function computeNewcomersAndDropouts(currentPlayers, previousPlayers) {
  const currentIds = new Set(currentPlayers.map(p => p.public_id));
  const previousIds = new Set(previousPlayers.map(p => p.public_id));
  const newcomers = currentPlayers
    .filter(p => !previousIds.has(p.public_id))
    .map(p => ({ rank: p.rank, username: p.username, public_id: p.public_id, elo: p.elo }));
  const dropouts = previousPlayers
    .filter(p => !currentIds.has(p.public_id))
    .map(p => ({ rank: p.rank, username: p.username, public_id: p.public_id, elo: p.elo }));
  return { newcomers, dropouts };
}

function saveWithMovement(playersByMode) {
  // Charger ancien classement pour calculer movement
  let previousByMode = { "1v1": new Map(), "2v2": new Map() };
  let previousPlayersByMode = { "1v1": [], "2v2": [] };
  try {
    const oldRaw = fs.readFileSync("ranked.json", "utf8");
    const oldData = JSON.parse(oldRaw);
    for (const mode of RANKED_TYPES) {
      const prevList = Array.isArray(oldData[mode]) ? oldData[mode] : [];
      previousPlayersByMode[mode] = prevList;
      prevList.forEach(p => {
        if (p.public_id) previousByMode[mode].set(p.public_id, p.rank);
      });
    }
    console.log(`[ranked-sync] 📊 Ancien classement: 1v1=${previousPlayersByMode["1v1"].length}, 2v2=${previousPlayersByMode["2v2"].length}`);
  } catch (e) {
    console.log("[ranked-sync] ℹ️ Pas d'ancien classement, mouvements non calculés");
  }

  const enrichedByMode = {};
  const metaByMode = {};

  for (const mode of RANKED_TYPES) {
    const players = playersByMode[mode] || [];
    const prevMap = previousByMode[mode];
    const enriched = players.map(p => {
      const prevRank = prevMap.get(p.public_id);
      const movement = prevRank != null ? prevRank - p.rank : null;
      return { ...p, movement };
    });
    enrichedByMode[mode] = enriched;

    const prevTop100 = previousPlayersByMode[mode].slice(0, 100);
    const curTop100 = enriched.slice(0, 100);
    const { newcomers, dropouts } = computeNewcomersAndDropouts(curTop100, prevTop100);
    if (newcomers.length) console.log(`[ranked-sync] [${mode}] 🆕 Nouveaux: ${newcomers.map(n => n.username).join(', ')}`);
    if (dropouts.length) console.log(`[ranked-sync] [${mode}] 📉 Sortants: ${dropouts.map(d => d.username).join(', ')}`);
    metaByMode[mode] = { newcomers, dropouts };
  }

  // Payload compatible : top-level 1v1 et 2v2 arrays + meta legacy pour 1v1 + nouvelles clés pour 2v2
  const payload = {
    "1v1": enrichedByMode["1v1"],
    "2v2": enrichedByMode["2v2"],
    // Legacy keys (1v1) — gardées pour ancien frontend
    newcomers: metaByMode["1v1"].newcomers,
    dropouts: metaByMode["1v1"].dropouts,
    // Nouvelles clés 2v2
    newcomers2v2: metaByMode["2v2"].newcomers,
    dropouts2v2: metaByMode["2v2"].dropouts,
    // Nested pour nouveau frontend (optionnel)
    modes: RANKED_TYPES,
    updatedAt: new Date().toISOString(),
    totalPlayers: enrichedByMode["1v1"].length,
    totalPlayers2v2: enrichedByMode["2v2"].length,
  };
  const json = JSON.stringify(payload);
  fs.writeFileSync("ranked.json", json);
  fs.writeFileSync("ranked.json.gz", zlib.gzipSync(json));

  for (const mode of RANKED_TYPES) {
    const list = enrichedByMode[mode];
    const movements = list.filter(p => p.movement != null && p.movement !== 0).length;
    const streaks = list.filter(p => p.streak != null && p.streak !== 0).length;
    const nd = metaByMode[mode];
    console.log(
      `[ranked-sync] [${mode}] 💾 ${list.length} joueurs — ` +
        `${movements} mouvements, ${streaks} streaks, ${nd.newcomers.length}↑, ${nd.dropouts.length}↓`
    );
  }
  console.log(`[ranked-sync] 💾 Total ${(json.length / 1024).toFixed(0)} KB raw / ${(zlib.gzipSync(json).length / 1024).toFixed(0)} KB gz`);

  return metaByMode;
}

async function main() {
  console.log("[ranked-sync] 🚀 Démarrage du sync ranked (1v1 + 2v2)...");
  if (hasExemption()) {
    console.log("[ranked-sync] 🔑 Exemption Skailex active");
  } else {
    console.warn("[ranked-sync] ⚠️ Pas d'exemption — les rate limits peuvent s'appliquer");
  }
  const leaders = await fetchLeaderboard();
  if (leaders.fromCache) {
    console.log("[ranked-sync] ♻️ Cache réutilisé — skip enrich/history");
    return;
  }

  // Enrich streaks séparément par ladder (top 20 chacun)
  const withStreak1v1 = await enrichStreaks(leaders["1v1"] || [], "1v1");
  const withStreak2v2 = await enrichStreaks(leaders["2v2"] || [], "2v2");

  const playersByMode = { "1v1": withStreak1v1, "2v2": withStreak2v2 };

  const history = loadHistory();
  saveHistory(history, playersByMode);
  saveWithMovement(playersByMode);
  console.log("[ranked-sync] ✅ Terminé.");
}

main().catch((e) => {
  console.error("[ranked-sync] Fatal:", e);
  process.exit(1);
});
