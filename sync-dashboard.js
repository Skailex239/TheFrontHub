/**
 * sync-dashboard.js — Synchronise le classement du Tableau de bord.
 *
 * Sources des joueurs (2 pools fusionnées) :
 *   1. ranked.json — top 100 classés 1v1 + top 100 classés 2v2 (déjà disponibles).
 *   2. public-aliases (Firebase Firestore) — tous les joueurs connectés via
 *      Google/Discord qui ont lié leur Public ID. C'est la NOUVELLE source
 *      qui inclut les joueurs non classés mais connectés.
 *
 * Pour chaque joueur connecté (public-aliases), on fetch ses parties via :
 *   GET /public/player/<publicId>/games?cursor=<base64>
 * qui retourne { results: [...], nextCursor } avec par partie :
 *   { mode, rankedType, result, start, map, ... }
 * On compte les victoires (result === "victory") par catégorie.
 *
 * Scoring :
 *   FFA casual   win = +10
 *   FFA ranked   win = +1   (ranked = 1 pt, PAS en plus du FFA)
 *   Team casual  win = +5
 *   Team ranked  win = +1   (ranked = 1 pt, PAS en plus du Team)
 *
 * Sortie :
 *   - dashboard_ranking.json (agrégat global + hebdo, lu par le frontend)
 *   - dashboard_player_games.json (cache des dernières parties par joueur,
 *     pour affichage sur le profil)
 *   + copies dans public/
 */

import fs from "fs";
import path from "path";
import {
  API_BASE,
  openFrontFetch,
  hasExemption,
  logApiStats,
  resetApiStats,
} from "./openfront-api.js";
import { firebaseConfig } from "./shared/firebase-config.js";

// ── Config ────────────────────────────────────────────────────────────────
const HAS_EXEMPTION = hasExemption();
const FIREBASE_PROJECT = firebaseConfig.projectId;
const FIRESTORE_BASE = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT}/databases/(default)/documents`;

const MAX_PAGES_PER_PLAYER = parseInt(process.env.DASH_MAX_PAGES || "20", 10); // 20 pages × 10 = 200 games max
const WEEKLY_MS = 7 * 24 * 60 * 60 * 1000; // 7 jours
const DETAIL_CONCURRENCY = HAS_EXEMPTION ? 8 : 3;
const BATCH_DELAY = HAS_EXEMPTION ? 0 : 150;
const DELAY_429 = HAS_EXEMPTION ? 2000 : 8000;
const MAX_RETRIES = 4;

const ROOT = process.cwd();
const RANKING_FILE = path.join(ROOT, "dashboard_ranking.json");
const PLAYER_GAMES_FILE = path.join(ROOT, "dashboard_player_games.json");
const PUBLIC_RANKING_FILE = path.join(ROOT, "public", "dashboard_ranking.json");
const PUBLIC_PLAYER_GAMES_FILE = path.join(ROOT, "public", "dashboard_player_games.json");
const RANKED_FILE = path.join(ROOT, "ranked.json");

// ── CLI flags ─────────────────────────────────────────────────────────────
const ARGS = new Set(process.argv.slice(2));
const DRY_RUN = ARGS.has("--dry-run");
const VERBOSE = ARGS.has("--verbose");
const SKIP_FIREBASE = ARGS.has("--no-firebase");

// ── Helpers ───────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isoNow = () => new Date().toISOString();

async function fetchJson(url, label = "fetch") {
  let attempt = 0;
  while (attempt < MAX_RETRIES) {
    attempt++;
    const res = await openFrontFetch(url);
    if (res.status === 429) {
      const wait = DELAY_429 * attempt;
      if (VERBOSE) console.warn(`[sync-dashboard] 429 ${label} — retry ${attempt}/${MAX_RETRIES} dans ${wait}ms`);
      await sleep(wait);
      continue;
    }
    if (!res.ok) {
      console.warn(`[sync-dashboard] HTTP ${res.status} ${label}: ${url.slice(0, 120)}`);
      return null;
    }
    return await res.json();
  }
  console.warn(`[sync-dashboard] abandon ${label} après ${MAX_RETRIES} retries 429`);
  return null;
}

async function fetchFirestoreAll(collection) {
  const all = [];
  let pageToken = null;
  do {
    let url = `${FIRESTORE_BASE}/${collection}?pageSize=300`;
    if (pageToken) url += `&pageToken=${encodeURIComponent(pageToken)}`;
    const data = await fetchJson(url, `firestore/${collection}`);
    if (!data) break;
    const docs = data.documents || [];
    all.push(...docs);
    pageToken = data.nextPageToken || null;
    if (VERBOSE) console.log(`[sync-dashboard] firestore ${collection}: ${all.length} docs (page ${pageToken ? "continue" : "done"})`);
  } while (pageToken);
  return all;
}

/** Extrait publicId + username d'un doc Firestore public-aliases. */
function parseAliasDoc(doc) {
  const f = doc.fields || {};
  const publicId = f.publicId?.stringValue || doc.name.split("/").pop();
  const username = f.username?.stringValue || publicId;
  const aliases = (f.aliases?.arrayValue?.values || []).map((v) => v.stringValue).filter(Boolean);
  return { publicId, username: username || publicId, aliases };
}

/** Fetch toutes les games d'un joueur (paginé par curseur). */
async function fetchPlayerGames(publicId, label) {
  const allGames = [];
  let cursor = null;
  for (let page = 0; page < MAX_PAGES_PER_PLAYER; page++) {
    let url = `${API_BASE}/public/player/${publicId}/games`;
    if (cursor) url += `?cursor=${encodeURIComponent(cursor)}`;
    const data = await fetchJson(url, `player-games/${label}`);
    if (!data) break;
    const results = data.results || [];
    if (results.length === 0) break;
    allGames.push(...results);
    cursor = data.nextCursor;
    if (!cursor) break; // fin de l'historique
    if (BATCH_DELAY > 0) await sleep(BATCH_DELAY);
  }
  return allGames;
}

/** Agrège les victoires d'un joueur depuis sa liste de games. */
function aggregatePlayerWins(games) {
  let ffaCasual = 0, ffaRanked = 0, teamCasual = 0, teamRanked = 0;
  const recent = []; // pour affichage profil (max 20)
  for (const g of games) {
    if (g.result !== "victory") continue;
    const isFFA = (g.mode || "").toLowerCase().includes("free") || g.mode === "FFA";
    const isRanked = g.rankedType === "1v1" || g.rankedType === "2v2";
    if (isFFA) {
      if (isRanked) ffaRanked++;
      else ffaCasual++;
    } else {
      if (isRanked) teamRanked++;
      else teamCasual++;
    }
  }
  // Recent games (victoires + défaites) pour le profil, triées par date desc
  const sorted = [...games].sort((a, b) => new Date(b.start) - new Date(a.start));
  for (const g of sorted.slice(0, 20)) {
    recent.push({
      gameId: g.gameId,
      start: g.start,
      duration: g.durationSeconds,
      map: g.map,
      mode: g.mode,
      rankedType: g.rankedType,
      result: g.result,
      totalPlayers: g.totalPlayers,
    });
  }
  return { ffaCasual, ffaRanked, teamCasual, teamRanked, recent };
}

function computePoints(p) {
  // FFA casual = 10, Team casual = 5, Ranked (1v1 ou 2v2) = 1 (pas en plus)
  return p.ffaCasualWins * 10 + p.ffaRankedWins * 1 + p.teamCasualWins * 5 + p.teamRankedWins * 1;
}

// ── Main ──────────────────────────────────────────────────────────────────
async function main() {
  console.log(`[sync-dashboard] démarrage — exemption: ${HAS_EXEMPTION ? "oui" : "non"}, dry-run: ${DRY_RUN}`);
  resetApiStats();

  // Index depuis ranked.json (top 100 classés)
  const rankedPlayers = new Map(); // publicId → {username, clan, ffaRankedWins, teamRankedWins}
  try {
    const raw = JSON.parse(fs.readFileSync(RANKED_FILE, "utf8"));
    for (const p of raw["1v1"] || []) {
      const pid = p.public_id;
      if (!pid) continue;
      const existing = rankedPlayers.get(pid) || { username: p.username, clan: null, ffaCasualWins: 0, ffaRankedWins: 0, teamCasualWins: 0, teamRankedWins: 0 };
      existing.ffaRankedWins = Math.max(existing.ffaRankedWins, p.wins || 0);
      existing.username = p.username || existing.username;
      rankedPlayers.set(pid, existing);
    }
    for (const p of raw["2v2"] || []) {
      const pid = p.public_id;
      if (!pid) continue;
      const existing = rankedPlayers.get(pid) || { username: p.username, clan: null, ffaCasualWins: 0, ffaRankedWins: 0, teamCasualWins: 0, teamRankedWins: 0 };
      existing.teamRankedWins = Math.max(existing.teamRankedWins, p.wins || 0);
      existing.username = p.username || existing.username;
      rankedPlayers.set(pid, existing);
    }
    console.log(`[sync-dashboard] ranked.json: ${rankedPlayers.size} joueurs classés`);
  } catch (e) {
    console.warn(`[sync-dashboard] ranked.json introuvable: ${e.message}`);
  }

  // Joueurs connectés depuis Firebase public-aliases
  const connectedPlayers = []; // [{publicId, username}]
  if (!SKIP_FIREBASE) {
    console.log(`[sync-dashboard] fetch Firebase public-aliases...`);
    const docs = await fetchFirestoreAll("public-aliases");
    for (const doc of docs) {
      const { publicId, username } = parseAliasDoc(doc);
      if (publicId && /^[A-Za-z0-9]{6,12}$/.test(publicId)) {
        connectedPlayers.push({ publicId, username });
      }
    }
    console.log(`[sync-dashboard] ${connectedPlayers.length} joueurs connectés trouvés dans public-aliases`);
  } else {
    console.log(`[sync-dashboard] --no-firebase: skip public-aliases`);
  }

  // Pour chaque joueur connecté, fetch ses games et agrège
  const playerGamesCache = {}; // publicId → [recent games]
  const enrichedPlayers = new Map(); // publicId → {username, clan, ffaCasualWins, ...}

  // Initialiser avec ranked.json
  for (const [pid, info] of rankedPlayers) {
    enrichedPlayers.set(pid, { publicId: pid, ...info });
  }

  // Fetch games pour chaque joueur connecté (en parallèle par batch)
  console.log(`[sync-dashboard] fetch games pour ${connectedPlayers.length} joueurs connectés...`);
  let processed = 0;
  for (let i = 0; i < connectedPlayers.length; i += DETAIL_CONCURRENCY) {
    const batch = connectedPlayers.slice(i, i + DETAIL_CONCURRENCY);
    const results = await Promise.all(
      batch.map(async (p) => {
        const games = await fetchPlayerGames(p.publicId, p.username);
        if (VERBOSE) console.log(`[sync-dashboard]   ${p.username} (${p.publicId}): ${games.length} games`);
        return { player: p, games };
      })
    );
    for (const { player, games } of results) {
      processed++;
      if (games.length === 0) {
        // Pas de games via l'API — garder les données ranked.json si dispo
        if (!enrichedPlayers.has(player.publicId)) {
          enrichedPlayers.set(player.publicId, {
            publicId: player.publicId,
            username: player.username,
            clan: null,
            ffaCasualWins: 0, ffaRankedWins: 0, teamCasualWins: 0, teamRankedWins: 0,
          });
        }
        continue;
      }
      const agg = aggregatePlayerWins(games);
      playerGamesCache[player.publicId] = { username: player.username, recent: agg.recent };
      // Merge : 
      // - Si le joueur est dans ranked.json, on garde ses wins ranked生涯 (plus complètes)
      //   et on AJOUTE les casual wins de l'API (que ranked.json n'a pas).
      // - Si le joueur n'est PAS dans ranked.json, on utilise toutes les wins de l'API.
      const existing = enrichedPlayers.get(player.publicId);
      if (existing) {
        // Joueur ranked + connecté : garde wins ranked de ranked.json, ajoute casual de l'API
        existing.ffaCasualWins = agg.ffaCasual;
        existing.teamCasualWins = agg.teamCasual;
        // ffaRankedWins / teamRankedWins : on garde le max(ranked.json, API)
        // (ranked.json est normalement plus complet, mais l'API peut avoir plus si le joueur
        // a joué récemment et ranked.json n'est pas encore à jour)
        existing.ffaRankedWins = Math.max(existing.ffaRankedWins || 0, agg.ffaRanked);
        existing.teamRankedWins = Math.max(existing.teamRankedWins || 0, agg.teamRanked);
        existing.username = player.username || existing.username;
      } else {
        // Joueur connecté non ranked : utilise toutes les wins de l'API
        enrichedPlayers.set(player.publicId, {
          publicId: player.publicId,
          username: player.username,
          clan: null,
          ffaCasualWins: agg.ffaCasual,
          ffaRankedWins: agg.ffaRanked,
          teamCasualWins: agg.teamCasual,
          teamRankedWins: agg.teamRanked,
        });
      }
    }
    if (VERBOSE || processed % 5 === 0) {
      console.log(`[sync-dashboard]   ${processed}/${connectedPlayers.length} joueurs traités`);
    }
  }

  // Construit le tableau global
  const allPlayers = Array.from(enrichedPlayers.values()).map((p) => ({
    publicId: p.publicId,
    username: p.username,
    clan: p.clan,
    ffaCasualWins: p.ffaCasualWins || 0,
    ffaRankedWins: p.ffaRankedWins || 0,
    teamCasualWins: p.teamCasualWins || 0,
    teamRankedWins: p.teamRankedWins || 0,
  }));
  for (const p of allPlayers) p.points = computePoints(p);
  allPlayers.sort((a, b) => b.points - a.points);

  // Vue hebdo : on n'a pas de timestamp agrégé fiable ici (l'API ne retourne
  // que les 200 dernières games par joueur, sans filtre date). On prend les
  // games récentes du cache pour calculer un weekly.
  const weeklyCutoff = Date.now() - WEEKLY_MS;
  const weeklyPlayers = [];
  for (const p of allPlayers) {
    const cache = playerGamesCache[p.publicId];
    if (!cache) {
      // Pas de games via API (joueur ranked.json seul) — on le garde tel quel
      // mais avec 0 en weekly (on n'a pas ses games récentes)
      weeklyPlayers.push({ ...p, ffaCasualWins: 0, ffaRankedWins: 0, teamCasualWins: 0, teamRankedWins: 0, points: 0 });
      continue;
    }
    const recent = (cache.recent || []).filter((g) => new Date(g.start).getTime() >= weeklyCutoff);
    let ffaC = 0, ffaR = 0, teamC = 0, teamR = 0;
    for (const g of recent) {
      if (g.result !== "victory") continue;
      const isFFA = (g.mode || "").toLowerCase().includes("free") || g.mode === "FFA";
      const isRanked = g.rankedType === "1v1" || g.rankedType === "2v2";
      if (isFFA) { if (isRanked) ffaR++; else ffaC++; }
      else { if (isRanked) teamR++; else teamC++; }
    }
    weeklyPlayers.push({
      ...p,
      ffaCasualWins: ffaC, ffaRankedWins: ffaR, teamCasualWins: teamC, teamRankedWins: teamR,
      points: ffaC * 10 + ffaR * 1 + teamC * 5 + teamR * 1,
    });
  }
  weeklyPlayers.sort((a, b) => b.points - a.points);

  const ranking = {
    updatedAt: isoNow(),
    gamesScanned: allPlayers.length,
    sources: {
      rankedCount: rankedPlayers.size,
      connectedCount: connectedPlayers.length,
      total: allPlayers.length,
    },
    global: {
      from: null,
      to: isoNow(),
      gamesScanned: allPlayers.length,
      players: allPlayers,
    },
    weekly: {
      from: new Date(weeklyCutoff).toISOString(),
      to: isoNow(),
      gamesScanned: weeklyPlayers.filter((p) => p.points > 0).length,
      players: weeklyPlayers,
    },
  };

  console.log(`[sync-dashboard] agrégat: global=${allPlayers.length} joueurs, weekly=${weeklyPlayers.filter(p=>p.points>0).length} joueurs actifs`);
  if (allPlayers.length > 0) {
    const top = allPlayers[0];
    console.log(`[sync-dashboard] champion global: ${top.username} (${top.points} pts — FFA c:${top.ffaCasualWins} r:${top.ffaRankedWins} / Team c:${top.teamCasualWins} r:${top.teamRankedWins})`);
  }

  if (DRY_RUN) {
    console.log("[sync-dashboard] dry-run — fichiers non écrits");
  } else {
    fs.writeFileSync(RANKING_FILE, JSON.stringify(ranking, null, 2));
    fs.writeFileSync(PLAYER_GAMES_FILE, JSON.stringify(playerGamesCache, null, 2));
    try {
      fs.mkdirSync(path.dirname(PUBLIC_RANKING_FILE), { recursive: true });
      fs.writeFileSync(PUBLIC_RANKING_FILE, JSON.stringify(ranking, null, 2));
      fs.writeFileSync(PUBLIC_PLAYER_GAMES_FILE, JSON.stringify(playerGamesCache, null, 2));
      console.log(`[sync-dashboard] fichiers écrits: ${RANKING_FILE}, ${PLAYER_GAMES_FILE}, ${PUBLIC_RANKING_FILE}, ${PUBLIC_PLAYER_GAMES_FILE}`);
    } catch (e) {
      console.warn(`[sync-dashboard] copie public/ échouée: ${e.message}`);
    }
  }

  logApiStats("sync-dashboard");
  console.log("[sync-dashboard] terminé");
}

main().catch((e) => {
  console.error("[sync-dashboard] FATAL:", e);
  process.exit(1);
});
