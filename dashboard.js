/**
 * dashboard.js — Contrôleur du Tableau de bord TheFrontHub.
 *
 * Architecture (v2 — stats agrégées côté serveur OpenFront) :
 *
 *   1. ranked.json (auto-synced par GitHub Actions) → ranked wins carrière
 *      pour le top 100 1v1 + top 100 2v2. Servé depuis GitHub Pages.
 *      Utilisé pour les joueurs ranked-only (non connectés au site).
 *
 *   2. Firebase public-aliases (Firestore REST API) → liste des joueurs
 *      connectés via Google/Discord qui ont lié leur Public ID.
 *
 *   3. OpenFront API (via proxy Cloudflare Worker ou /api/openfront en dev)
 *      → pour chaque joueur connecté, DEUX appels seulement :
 *
 *        a) GET /public/player/{id}  →  objet `stats` AGRÉGÉ côté serveur
 *           contenant les wins carrière par mode/difficulté/ranked.
 *           1 requête = toutes les wins all-time (plus de pagination de
 *           300 pages !). Marche même pour un joueur à 3000+ games.
 *
 *        b) GET /public/player/{id}/games  →  pagination COURTE qui
 *           S'ARRÊTE au premier game de plus de 7 jours. Typiquement
 *           2-5 pages pour un joueur actif (vs 300 si on paginait tout).
 *           Sert uniquement à calculer les wins de la semaine.
 *
 *      Le proxy Cloudflare Worker ajoute le header x-skailex-access côté
 *      serveur (exemption de rate-limit). Avec seulement ~3-6 requêtes par
 *      joueur (au lieu de 300+), le rate-limit Cloudflare n'est plus un
 *      problème et le dashboard charge en quelques secondes.
 *
 *   Merge :
 *     - Joueurs ranked-only : ranked wins de ranked.json, casual = 0
 *     - Joueurs connectés : ranked wins = max(ranked.json, API carrière),
 *       casual wins = API agrégée
 *
 *   Cache : les stats live sont mises en cache dans localStorage (30 min)
 *   pour éviter de re-fetcher à chaque visite.
 *
 * Barème :
 *   FFA casual  = +10  ·  FFA classé (1v1) = +1
 *   Team casual = +5   ·  Team classé (2v2) = +1
 *   (ranked = 1 pt, PAS en plus du FFA/Team)
 *
 * Auth : importe auth.js (Firebase) et écoute onAuthStateChanged pour brancher
 * la sidebar (login-btn / user-badge). Définit sur window les handlers utilisés
 * par les onclick du HTML : toggleAuthModal, handleLogin, handleLogout,
 * toggleUserDropdown, goToProfilePage, closeProfileModal,
 * startOwnershipVerification, confirmOwnershipVerification,
 * cancelOwnershipVerification.
 */

import {
  auth, db,
  doc, getDoc, setDoc,
  collection, query, where, onSnapshot,
  onAuthStateChanged, signOut,
} from "./auth.js";
import { fetchOpenFront } from "./openfront-client.js?v=25";

/* ════════════════════════════════════════════════════════════════
   Constantes (barème)
   ════════════════════════════════════════════════════════════════ */

const PTS_FFA_CASUAL  = 10;
const PTS_FFA_RANKED  = 1;   // ranked = 1 pt, pas en plus du FFA
const PTS_TEAM_CASUAL = 5;
const PTS_TEAM_RANKED = 1;   // ranked = 1 pt, pas en plus du Team

/* ════════════════════════════════════════════════════════════════
   State + DOM
   ════════════════════════════════════════════════════════════════ */

const view = document.getElementById("dashboard-view");
const lastUpdateEl = document.getElementById("last-update");

let _rankedData = null;        // ranked.json décodé (ranked wins carrière)
let _connectedPlayers = [];    // [{publicId, username}] depuis Firebase
let _liveStats = {};           // { publicId: { global: {...}, weekly: {...}, games: [], fetchedAt } }
// Layout 2 panneaux : on maintient deux vues (global + weekly) en parallèle
let _mergedViews = { global: [], weekly: [] };
let _liveFetchDone = false;    // true quand toutes les stats live sont chargées
let _liveFetchProgress = 0;    // nombre de joueurs connectés traités
// _dashMode conservé pour compat (plus utilisé par render() — layout 2 panneaux)
let _dashMode = "global";      // "global" | "weekly"
let currentUser = null;     // { name, publicId, avatar, uid, email }
let _ownershipCode = null;
let _ownershipPublicId = null;
let _ownershipUsername = null;
let _loginInProgress = false;

// Cache key bumped to v2 : anciennes entrées v1 (calculées par pagination
// exhaustive) sont invalidées car la nouvelle méthode (stats agrégées) donne
// des nombres différents (plus précis, surtout pour les gros joueurs).
const LIVE_CACHE_KEY = "dash_live_stats_v2";
const LIVE_CACHE_TTL = 30 * 60 * 1000; // 30 minutes
const WEEKLY_MS = 7 * 24 * 60 * 60 * 1000;
// Nombre max de pages de games à fetcher pour le calcul hebdo. Chaque page
// = ~10 games. 50 pages = 500 games = largement plus qu'une semaine d'activité
// même pour un joueur très actif. On s'arrête en plus dès le 1er game > 7 jours.
const MAX_WEEKLY_PAGES = 50;
const FIREBASE_PROJECT = "openfront-speedrun";
const FIRESTORE_BASE = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT}/databases/(default)/documents`;

/* ════════════════════════════════════════════════════════════════
   Helpers
   ════════════════════════════════════════════════════════════════ */

function escapeHtml(s) {
  if (s == null) return "";
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatPoints(n) {
  return new Intl.NumberFormat("fr-FR").format(n || 0);
}

/**
 * Retourne le timestamp (ms) du lundi 00:00 (heure locale navigateur)
 * de la semaine contenant `now`. Utilisé pour le label "Depuis lundi …".
 */
function getWeekStartMs(now) {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  // getDay(): 0=Sunday, 1=Monday... On veut lundi comme début de semaine
  const day = d.getDay();
  const diff = day === 0 ? -6 : 1 - day; // recule jusqu'à lundi
  d.setDate(d.getDate() + diff);
  return d.getTime();
}

/** Formate un timestamp (ms) en date longue française (ex: "lundi 11 août 2026"). */
function formatFrenchDate(ms) {
  return new Intl.DateTimeFormat("fr-FR", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(new Date(ms));
}

function initials(name) {
  if (!name) return "?";
  const clean = name.replace(/^\[[^\]]+\]\s*/, "").trim();
  const parts = clean.split(/[\s_-]+/).filter(Boolean);
  const letters = parts.length >= 2 ? parts[0][0] + parts[1][0] : clean.slice(0, 2);
  return letters.toUpperCase();
}

function rankCircleHtml(rank) {
  let cls = "dash-rank";
  if (rank === 1) cls += " dash-rank-1";
  else if (rank === 2) cls += " dash-rank-2";
  else if (rank === 3) cls += " dash-rank-3";
  return `<span class="${cls}">${rank}</span>`;
}

function avatarHtml(name, size = "sm") {
  return `<span class="dash-avatar dash-avatar-${size}" aria-hidden="true">${escapeHtml(initials(name))}</span>`;
}

function clanBadgeHtml(clan) {
  if (!clan) return "";
  return `<span class="dash-clan">[${escapeHtml(clan)}]</span>`;
}

function showToast(msg, type = "info", duration = 4000) {
  if (typeof window.showToast === "function") window.showToast(msg, type, duration);
  else console.log(`[toast:${type}]`, msg);
}

/* ════════════════════════════════════════════════════════════════
   Chargement des données (LIVE — pas de sync)
   ════════════════════════════════════════════════════════════════ */

/** Charge ranked.json (ranked wins carrière pour top 100 1v1 + 2v2). */
async function loadRankedJson() {
  try {
    const res = await fetch("ranked.json", { cache: "no-store" });
    if (res.ok) {
      _rankedData = await res.json();
      if (_rankedData?.updatedAt) updateLastUpdateLabel(_rankedData.updatedAt);
      console.log(`[dashboard] ranked.json: ${(_rankedData["1v1"]?.length || 0) + (_rankedData["2v2"]?.length || 0)} joueurs classés`);
    }
  } catch (e) {
    console.warn("[dashboard] ranked.json indisponible:", e.message);
  }
}

/** Charge la liste des joueurs connectés depuis Firebase public-aliases. */
async function loadConnectedPlayers() {
  try {
    const url = `${FIRESTORE_BASE}/public-aliases`;
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) {
      console.warn(`[dashboard] Firebase public-aliases: HTTP ${res.status}`);
      return;
    }
    const data = await res.json();
    const docs = data.documents || [];
    const seen = new Set();
    _connectedPlayers = docs.map((doc) => {
      const fields = doc.fields || {};
      const val = (f) => (f?.stringValue || f?.integerValue || "");
      const publicId = val(fields.publicId);
      return {
        publicId,
        username: val(fields.username) || publicId || "?",
      };
    })
    // Filtrer : publicId valide = exactement 8 caractères alphanumériques
    .filter((p) => /^[A-Za-z0-9]{8}$/.test(p.publicId))
    // Dédoublonner par publicId (garder le premier)
    .filter((p) => {
      if (seen.has(p.publicId)) return false;
      seen.add(p.publicId);
      return true;
    });
    console.log(`[dashboard] Firebase: ${_connectedPlayers.length} joueurs connectés (sur ${docs.length} documents)`);
  } catch (e) {
    console.warn("[dashboard] Firebase indisponible:", e.message);
  }
}

/**
 * Extrait les wins carrière (all-time) depuis l'objet `stats` agrégé
 * renvoyé par GET /public/player/{id}. L'API OpenFront maintient ces
 * totaux côté serveur → 1 seule requête par joueur, pas de pagination.
 *
 * Structure de stats (vérifiée empiriquement) :
 *   {
 *     "Public":       { "Free For All": {Easy:{wins,losses,total}, ...},
 *                       "Team": {Easy:{wins,...}, ...},
 *                       "Humans Vs Nations": {...} },
 *     "Private":      { ... idem ... },
 *     "Singleplayer": { "Free For All": {...} },
 *     "Ranked":       { "1v1": {wins, losses, total},
 *                       "2v2": {wins, losses, total} },
 *     "recent":       { ... breakdown des 100 dernières games ... }
 *   }
 *
 * Mapping vers nos 4 catégories (pour coller à l'ancien classifyGame) :
 *   ffaCasual   = Σ stats[Public|Private|Singleplayer]["Free For All"][*].wins
 *                 + Σ stats[*]["Humans Vs Nations"][*].wins
 *   teamCasual  = Σ stats[Public|Private]["Team"][*].wins
 *   ffaRanked   = stats.Ranked["1v1"].wins
 *   teamRanked  = stats.Ranked["2v2"].wins
 */
function extractCareerWinsFromStats(stats) {
  const global = { ffaCasual: 0, ffaRanked: 0, teamCasual: 0, teamRanked: 0 };
  if (!stats || typeof stats !== "object") return global;

  // Casual wins : on somme toutes les visibilities (Public/Private/Singleplayer)
  // et tous les modes non-Team non-Ranked (FFA + Humans Vs Nations).
  const CASUAL_VIS = ["Public", "Private", "Singleplayer"];
  const FFA_MODES = ["Free For All", "Humans Vs Nations"];
  for (const vis of CASUAL_VIS) {
    const visData = stats[vis];
    if (!visData || typeof visData !== "object") continue;
    for (const mode of FFA_MODES) {
      const modeData = visData[mode];
      if (!modeData || typeof modeData !== "object") continue;
      for (const diff of Object.keys(modeData)) {
        const d = modeData[diff];
        if (d && typeof d === "object" && d.wins != null) {
          global.ffaCasual += Number(d.wins) || 0;
        }
      }
    }
    // Team casual
    const teamData = visData["Team"];
    if (teamData && typeof teamData === "object") {
      for (const diff of Object.keys(teamData)) {
        const d = teamData[diff];
        if (d && typeof d === "object" && d.wins != null) {
          global.teamCasual += Number(d.wins) || 0;
        }
      }
    }
  }

  // Ranked wins (carrière exacte — pas besoin de ranked.json pour ces joueurs)
  const r1 = stats?.Ranked?.["1v1"];
  if (r1 && r1.wins != null) global.ffaRanked = Number(r1.wins) || 0;
  const r2 = stats?.Ranked?.["2v2"];
  if (r2 && r2.wins != null) global.teamRanked = Number(r2.wins) || 0;

  return global;
}

/**
 * Pagine les parties récentes d'un joueur en S'ARRÊTANT dès qu'on croise
 * une game plus vieille que WEEKLY_MS (7 jours). Typiquement 2-5 pages
 * pour un joueur actif, au lieu des 300+ pages qu'il faudrait pour un
 * joueur à 3000 games si on paginait tout l'historique.
 *
 * Retourne uniquement les games des 7 derniers jours.
 */
async function fetchWeeklyGames(publicId) {
  const weeklyGames = [];
  const weekStartMs = Date.now() - WEEKLY_MS;
  let cursor = null;
  for (let page = 0; page < MAX_WEEKLY_PAGES; page++) {
    let apiPath = `/public/player/${encodeURIComponent(publicId)}/games`;
    if (cursor) apiPath += `?cursor=${encodeURIComponent(cursor)}`;
    let data;
    try {
      data = await fetchOpenFront(apiPath);
    } catch (e) {
      console.warn(`[dashboard] weekly games ${publicId} page ${page}:`, e.message);
      break;
    }
    const results = data?.results || [];
    if (results.length === 0) break;
    let hitOld = false;
    for (const g of results) {
      const t = g.start ? new Date(g.start).getTime() : 0;
      if (t && t < weekStartMs) { hitOld = true; break; }
      weeklyGames.push(g);
    }
    if (hitOld) break;
    if (!data.nextCursor) break;
    cursor = data.nextCursor;
  }
  return weeklyGames;
}

/**
 * Charge les stats complètes d'un joueur connecté en 2 étapes :
 *   1. GET /public/player/{id} → wins carrière (agrégé côté serveur, 1 req)
 *   2. GET /public/player/{id}/games paginé jusqu'à la barre des 7 jours
 *      → wins hebdo (2-5 req, stop au premier game trop vieux)
 *
 * Total : ~3-6 requêtes par joueur (vs 300+ auparavant pour un gros joueur).
 * Pour un joueur à 3000 games, les wins carrière sont EXACTES car l'API
 * les maintient côté serveur — le site n'a plus besoin de tout télécharger.
 */
async function fetchPlayerStats(player) {
  // 1. Career (all-time) — 1 requête, stats agrégées côté serveur
  const profile = await fetchOpenFront(`/public/player/${encodeURIComponent(player.publicId)}`);
  const global = extractCareerWinsFromStats(profile?.stats || {});
  const username = profile?.username || player.username;

  // 2. Weekly — pagination courte jusqu'à 7 jours
  const weeklyGames = await fetchWeeklyGames(player.publicId);
  // computeWinsFromGames retourne { global, weekly } ; comme on ne lui passe
  // QUE les games des 7 derniers jours, .global == .weekly (toutes les games
  // sont dans la fenêtre). On prend .global par simplicité.
  const weekly = computeWinsFromGames(weeklyGames).global;

  return {
    publicId: player.publicId,
    username,
    games: weeklyGames.slice(-20), // 20 plus récentes pour le profil
    global,
    weekly,
    totalGames: 0, // non disponible simplement depuis l'API agrégée
    fetchedAt: Date.now(),
  };
}

/** Classifie une game en catégorie. */
function classifyGame(g) {
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

/** Calcule les wins globales + hebdo depuis une liste de games. */
function computeWinsFromGames(games) {
  const global = { ffaCasual: 0, ffaRanked: 0, teamCasual: 0, teamRanked: 0 };
  const weekly = { ffaCasual: 0, ffaRanked: 0, teamCasual: 0, teamRanked: 0 };
  const now = Date.now();
  for (const g of games) {
    if (g.result !== "victory") continue;
    const cat = classifyGame(g);
    global[cat]++;
    if (g.start && now - new Date(g.start).getTime() < WEEKLY_MS) {
      weekly[cat]++;
    }
  }
  return { global, weekly };
}

/** Charge les stats live pour tous les joueurs connectés (avec cache, en parallèle). */
async function loadLiveStats() {
  if (_connectedPlayers.length === 0) {
    _liveFetchDone = true;
    return;
  }

  // ── 1. Charger le cache localStorage ──
  let cached = {};
  try {
    const raw = localStorage.getItem(LIVE_CACHE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") cached = parsed;
    }
  } catch (e) { /* ignore */ }

  // ── 2. Séparer les joueurs en cache (frais) vs à fetcher ──
  const toFetch = [];
  for (const player of _connectedPlayers) {
    const cacheEntry = cached[player.publicId];
    const isFresh = cacheEntry && (Date.now() - cacheEntry.fetchedAt) < LIVE_CACHE_TTL;
    if (isFresh) {
      _liveStats[player.publicId] = cacheEntry;
      _liveFetchProgress++;
    } else {
      toFetch.push(player);
    }
  }
  // Premier rendu avec les données en cache
  if (_liveFetchProgress > 0) mergeAndRender();

  // ── 3. Fetch tous les joueurs en parallèle (exemption = 8 concurrent) ──
  const fetchOne = async (player) => {
    try {
      const entry = await fetchPlayerStats(player);
      _liveStats[player.publicId] = entry;
      cached[player.publicId] = entry;
      localStorage.setItem(LIVE_CACHE_KEY, JSON.stringify(cached));
      console.log(`[dashboard] live: ${entry.username} (${player.publicId}) → global=${JSON.stringify(entry.global)} weekly=${JSON.stringify(entry.weekly)}`);
    } catch (e) {
      console.warn(`[dashboard] live fetch failed for ${player.publicId}:`, e.message);
    }
    _liveFetchProgress++;
    mergeAndRender(); // rendu progressif après chaque joueur
  };

  // Lancer tous les fetchs en parallèle
  await Promise.all(toFetch.map(fetchOne));
  _liveFetchDone = true;
}

function updateLastUpdateLabel(ts) {
  if (!ts || !lastUpdateEl) return;
  const d = new Date(typeof ts === "number" ? ts : ts);
  if (Number.isNaN(d.getTime())) return;
  lastUpdateEl.textContent = "Mis à jour le " + new Intl.DateTimeFormat("fr-FR", {
    day: "2-digit", month: "2-digit", year: "numeric",
    hour: "2-digit", minute: "2-digit",
  }).format(d);
}

/* ════════════════════════════════════════════════════════════════
   Merge ranked.json + stats live → _mergedViews { global, weekly }
   ════════════════════════════════════════════════════════════════ */

function pointsFor(p) {
  return (p.ffaCasualWins || 0) * PTS_FFA_CASUAL
       + (p.ffaRankedWins || 0) * PTS_FFA_RANKED
       + (p.teamCasualWins || 0) * PTS_TEAM_CASUAL
       + (p.teamRankedWins || 0) * PTS_TEAM_RANKED;
}

/**
 * Fusionne ranked.json (career ranked wins) + live API (casual wins)
 * pour les DEUX vues (global + weekly) d'un coup. Les stats live
 * contiennent déjà `global` et `weekly` pour chaque joueur (cf.
 * computeWinsFromGames), donc on parcourt _liveStats deux fois sans
 * re-fetcher.
 */
function buildMergedViews() {
  const buildForMode = (isWeekly) => {
    const byPid = new Map();

    // 1. ranked.json → ranked wins carrière (GLOBAL uniquement)
    //    En weekly, on ne peut pas déduire les wins hebdo depuis ranked.json
    //    (career total only) → les joueurs ranked-only ont 0 pts en weekly
    if (_rankedData) {
      const getOrCreate = (pid, name) => {
        let e = byPid.get(pid);
        if (!e) {
          e = {
            publicId: pid, username: name || pid, clan: null,
            ffaCasualWins: 0, ffaRankedWins: 0,
            teamCasualWins: 0, teamRankedWins: 0,
            _hasLive: false,
          };
          byPid.set(pid, e);
        }
        return e;
      };
      for (const p of _rankedData["1v1"] || []) {
        const nm = p.username || p.accountUsername || p.public_id;
        const e = getOrCreate(p.public_id, nm);
        if (!isWeekly) e.ffaRankedWins = p.wins || 0;
        if (nm && nm !== p.public_id) e.username = nm;
      }
      for (const p of _rankedData["2v2"] || []) {
        const nm = p.username || p.accountUsername || p.public_id;
        const e = getOrCreate(p.public_id, nm);
        if (!isWeekly) e.teamRankedWins = p.wins || 0;
        if (nm && nm !== p.public_id) e.username = nm;
      }
    }

    // 2. Stats live → casual wins + ranked wins
    for (const [pid, live] of Object.entries(_liveStats)) {
      let e = byPid.get(pid);
      if (!e) {
        e = {
          publicId: pid, username: live.username || pid, clan: null,
          ffaCasualWins: 0, ffaRankedWins: 0,
          teamCasualWins: 0, teamRankedWins: 0,
          _hasLive: false,
        };
        byPid.set(pid, e);
      }
      const g = isWeekly ? live.weekly : live.global;
      e.ffaCasualWins = g.ffaCasualWins;
      e.teamCasualWins = g.teamCasualWins;
      // Ranked wins :
      //   - Global : max(ranked.json career, API live) — ranked.json est plus complet
      //   - Weekly : API live uniquement (ranked.json n'a pas de breakdown hebdo)
      if (isWeekly) {
        e.ffaRankedWins = g.ffaRankedWins;
        e.teamRankedWins = g.teamRankedWins;
      } else {
        e.ffaRankedWins = Math.max(e.ffaRankedWins || 0, g.ffaRankedWins);
        e.teamRankedWins = Math.max(e.teamRankedWins || 0, g.teamRankedWins);
      }
      e._hasLive = true;
      if (live.username && live.username !== pid) e.username = live.username;
    }

    // 3. Calcul des points + tri
    const players = [...byPid.values()].map((p) => ({
      ...p,
      points: pointsFor(p),
    }));
    players.sort((a, b) => b.points - a.points);
    return players;
  };

  return {
    global: buildForMode(false),
    weekly: buildForMode(true),
  };
}

/**
 * Compat shim : retourne la vue globale (ancienne API).
 * Plus utilisé par render() mais conservé pour d'éventuels appels externes.
 */
function getActiveView() {
  return { players: _mergedViews.global };
}

/* ════════════════════════════════════════════════════════════════
   Rendu
   ════════════════════════════════════════════════════════════════ */

function render() {
  if (!_rankedData && _mergedViews.global.length === 0 && _mergedViews.weekly.length === 0) {
    view.innerHTML = `
      <div class="dash-empty-state">
        <div class="dash-empty-icon"><i data-icon="chart"></i></div>
        <h3>Chargement…</h3>
        <p>Récupération du classement…</p>
      </div>`;
    if (window.hydrateIcons) window.hydrateIcons(view);
    return;
  }

  // Deux vues : globale (all time) + hebdo (cette semaine)
  const globalView = _mergedViews.global.map((p) => ({ ...p }));
  const weeklyView = _mergedViews.weekly.map((p) => ({ ...p }));
  if (globalView.length === 0 && weeklyView.length === 0) {
    view.innerHTML = `
      <div class="dash-empty-state">
        <div class="dash-empty-icon"><i data-icon="chart"></i></div>
        <h3>Aucune donnée disponible</h3>
        <p>Chargement…</p>
      </div>`;
    if (window.hydrateIcons) window.hydrateIcons(view);
    return;
  }

  // Ajout du rang dans chaque vue
  globalView.forEach((p, i) => { p.rank = i + 1; });
  weeklyView.forEach((p, i) => { p.rank = i + 1; });

  const globalChampion = globalView[0] ?? null;
  const weeklyChampion = weeklyView[0] ?? null;
  const globalTopN = globalView.slice(0, 50);
  const weeklyTopN = weeklyView.slice(0, 50);

  // Indicateur de chargement live — barre de progression 0-100 %
  const total = _connectedPlayers.length || 1;
  const done = _liveFetchProgress;
  const pct = Math.min(100, Math.round((done / total) * 100));
  const liveTag = !_liveFetchDone
    ? `<div class="dash-progress" role="progressbar" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100" aria-label="Chargement des stats live">
        <div class="dash-progress-header">
          <span class="dash-progress-label"><i data-icon="chart"></i> Chargement des stats live…</span>
          <span class="dash-progress-pct">${pct}%</span>
        </div>
        <div class="dash-progress-track"><div class="dash-progress-fill" style="width:${pct}%"></div></div>
      </div>`
    : "";

  // Label "Depuis le lundi X …" (début de semaine en heure locale navigateur)
  const weekStartMs = getWeekStartMs(Date.now());
  const weekStartLabel = formatFrenchDate(weekStartMs);

  view.innerHTML = `
    ${liveTag}

    <div class="dash-grid">
      <section class="dash-panel">
        <div class="dash-panel-header">
          <h2 class="dash-panel-title">Top players all Time</h2>
          <span class="dash-panel-sub">Classement cumulé · ${globalView.length} joueurs</span>
        </div>
        ${globalChampion ? renderChampion(globalChampion, false) : ""}
        ${renderRanking(globalTopN, globalView.length, "Global")}
      </section>
      <section class="dash-panel">
        <div class="dash-panel-header">
          <h2 class="dash-panel-title">Top players this Week</h2>
          <span class="dash-panel-sub">Depuis le ${weekStartLabel} · ${weeklyView.length} joueurs actifs</span>
        </div>
        ${weeklyChampion ? renderChampion(weeklyChampion, true) : ""}
        ${renderRanking(weeklyTopN, weeklyView.length, "Cette semaine")}
      </section>
    </div>

    <div class="dash-scoring-info">
      <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>
      <span>Barème : <strong>FFA casual +10</strong> · <strong>FFA classé +1</strong> · <strong>Team casual +5</strong> · <strong>Team classé +1</strong> (le classé rapporte juste 1 pt, pas en plus). Colonne gauche = cumul de toutes les parties. Colonne droite = parties des 7 derniers jours. Les stats des joueurs connectés sont récupérées en temps réel via l'API OpenFront.</span>
    </div>
  `;

  // Hydrate les icônes <i data-icon>
  if (window.hydrateIcons) window.hydrateIcons(view);
}

/** Merge + render (utilisé après chaque fetch live pour mise à jour progressive). */
function mergeAndRender() {
  _mergedViews = buildMergedViews();
  render();
}

/* ── Champion card (left column) ── */
function renderChampion(champion, isWeekly) {
  const name = champion.username || champion.publicId;
  const profileUrl = champion.publicId
    ? `profile.html?pid=${encodeURIComponent(champion.publicId)}&player=${encodeURIComponent(name)}`
    : `profile.html?player=${encodeURIComponent(name)}`;

  const ffaCasualPts  = (champion.ffaCasualWins  || 0) * PTS_FFA_CASUAL;
  const ffaRankedPts  = (champion.ffaRankedWins  || 0) * PTS_FFA_RANKED;
  const teamCasualPts = (champion.teamCasualWins || 0) * PTS_TEAM_CASUAL;
  const teamRankedPts = (champion.teamRankedWins || 0) * PTS_TEAM_RANKED;

  return `
    <section class="dash-section dash-champion-section">
      <div class="dash-section-header">
        <h2 class="dash-section-title">Top joueur</h2>
        <span class="dash-section-meta">${isWeekly ? "Cette semaine" : "Global"}</span>
      </div>
      <div class="dash-champion">
        <div class="dash-champion-top">
          <span class="dash-champion-trophy" aria-hidden="true"><i data-icon="trophy"></i></span>
          <div class="dash-champion-meta">
            <div class="dash-champion-name">${escapeHtml(name)}${champion.clan ? ` <span class="dash-player-clan">[${escapeHtml(champion.clan)}]</span>` : ""}</div>
            <div class="dash-champion-sub">Rang #1 · ${isWeekly ? "champion de la semaine" : "champion global"}</div>
          </div>
          <div class="dash-champion-points-wrap">
            <div class="dash-champion-points">${formatPoints(champion.points)}</div>
            <div class="dash-champion-points-label">points</div>
          </div>
        </div>
        <div class="dash-champion-breakdown">
          <div class="dash-champion-stat">
            <span class="dash-champion-stat-label">FFA casual</span>
            <span class="dash-champion-stat-val">${champion.ffaCasualWins || 0}<span class="dash-champion-stat-pts">+${formatPoints(ffaCasualPts)}</span></span>
          </div>
          <div class="dash-champion-stat">
            <span class="dash-champion-stat-label">FFA classé</span>
            <span class="dash-champion-stat-val">${champion.ffaRankedWins || 0}<span class="dash-champion-stat-pts">+${formatPoints(ffaRankedPts)}</span></span>
          </div>
          <div class="dash-champion-stat">
            <span class="dash-champion-stat-label">Team casual</span>
            <span class="dash-champion-stat-val">${champion.teamCasualWins || 0}<span class="dash-champion-stat-pts">+${formatPoints(teamCasualPts)}</span></span>
          </div>
          <div class="dash-champion-stat">
            <span class="dash-champion-stat-label">Team classé</span>
            <span class="dash-champion-stat-val">${champion.teamRankedWins || 0}<span class="dash-champion-stat-pts">+${formatPoints(teamRankedPts)}</span></span>
          </div>
        </div>
        <a class="dash-more-btn" href="${profileUrl}">Voir le profil</a>
      </div>
    </section>`;
}

/* ── Ranking list (right column, flex rows) ── */
function renderRanking(topN, totalPlayers, modeLabel) {
  const rows = topN.map((p) => {
    const name = p.username || p.publicId;
    const profileUrl = p.publicId
      ? `profile.html?pid=${encodeURIComponent(p.publicId)}&player=${encodeURIComponent(name)}`
      : `profile.html?player=${encodeURIComponent(name)}`;
    // Icônes SVG (pas d'émojis) pour les 3 premiers : trophy / medal / medal
    const rankIcon = p.rank === 1 ? "trophy" : p.rank === 2 ? "medal" : p.rank === 3 ? "medal" : null;
    const rankSlot = rankIcon
      ? `<span class="dash-rank-trophy dash-rank-${p.rank}" aria-hidden="true"><i data-icon="${rankIcon}"></i></span>`
      : `<span class="dash-rank-badge">${p.rank}</span>`;
    return `
      <a class="dash-row dash-row-link" href="${profileUrl}">
        <span class="dash-rank-slot">${rankSlot}</span>
        <span class="dash-player">
          <span class="dash-player-name">${escapeHtml(name)}</span>
          ${p.clan ? `<span class="dash-player-clan">[${escapeHtml(p.clan)}]</span>` : ""}
        </span>
        <span class="dash-score">
          <span class="dash-score-val">${formatPoints(p.points)}</span><span class="dash-score-suffix">pts</span>
        </span>
      </a>`;
  }).join("");

  return `
    <section class="dash-section dash-ranking-section">
      <div class="dash-section-header">
        <h2 class="dash-section-title">Classement</h2>
        <span class="dash-section-meta">${totalPlayers} joueurs · ${modeLabel}</span>
      </div>
      <div class="dash-list">
        ${rows || `<p class="dash-empty">Aucun joueur classé pour le moment.</p>`}
      </div>
      <a class="dash-more-btn" href="index.html?tab=ranked">Voir tout le classement</a>
    </section>`;
}

/* ════════════════════════════════════════════════════════════════
   Auth UI (sidebar)
   ════════════════════════════════════════════════════════════════ */

function updateAuthUI(user) {
  const loginBtn = document.getElementById("login-btn-main");
  const userContainer = document.getElementById("user-container");
  if (!loginBtn || !userContainer) return;

  if (!user) {
    loginBtn.style.display = "flex";
    userContainer.style.display = "none";
    userContainer.classList.remove("open");
    return;
  }

  loginBtn.style.display = "none";
  userContainer.style.display = "block";

  const name = user.name || "Joueur";
  const publicId = user.publicId || "Non lié";

  const setText = (id, val) => {
    const el = document.getElementById(id);
    if (el) el.textContent = val;
  };
  setText("user-display-name", name);
  setText("user-public-id-side", publicId !== "Non lié" ? publicId : "En ligne");
  setText("dropdown-username-display", name);
  setText("dropdown-publicid-display", publicId);

  const avatarEl = document.getElementById("dropdown-avatar");
  const sidebarAvatarEl = document.getElementById("sidebar-avatar");
  const renderAvatar = (el) => {
    if (!el) return;
    if (user.avatar) {
      el.innerHTML = `<img src="${escapeHtml(user.avatar)}" alt="${escapeHtml(name)}" style="width:100%;height:100%;border-radius:50%;object-fit:cover">`;
    } else {
      el.innerHTML = "";
      el.textContent = initials(name);
      el.style.background = "linear-gradient(135deg,var(--accent),var(--accentL))";
      el.style.color = "#fff";
    }
  };
  renderAvatar(avatarEl);
  renderAvatar(sidebarAvatarEl);
}

onAuthStateChanged(auth, async (user) => {
  if (!user) {
    currentUser = null;
    updateAuthUI(null);
    return;
  }
  currentUser = { uid: user.uid, avatar: user.photoURL, email: user.email };

  // Lecture du profil Firestore
  let profile = null;
  try {
    const snap = await getDoc(doc(db, "users", user.uid));
    if (snap.exists()) profile = snap.data();
  } catch (e) {
    console.warn("[dashboard] Firestore read error:", e.message);
  }

  if (profile && profile.publicId) {
    currentUser.name = profile.username;
    currentUser.publicId = profile.publicId;
    updateAuthUI(currentUser);
  } else {
    // Premier login sans profil : on affiche le badge + ouvre le setup modal
    currentUser.name = user.displayName || "Joueur";
    updateAuthUI(currentUser);
    // Redirige vers profile.html pour finaliser le setup (le dashboard n'a pas
    // vocation à héberger tout le flow d'ownership verification ici).
    if (profile == null) {
      // Pas de doc Firestore du tout → l'utilisateur n'a jamais finalisé.
      // On l'envoie sur profile.html qui gère le setup.
      // On évite la boucle en ne redirigeant que si l'URL ne contient pas ?setup=1
      const params = new URLSearchParams(window.location.search);
      if (params.get("setup") !== "1") {
        // Petit délai pour laisser le toast se figurer
        showToast("Bienvenue ! Finalisez votre profil pour accéder à vos stats.", "info", 3500);
        setTimeout(() => { window.location.href = "profile.html"; }, 1200);
        return;
      }
    }
  }
});

/* ════════════════════════════════════════════════════════════════
   Handlers globaux (pour onclick HTML)
   ════════════════════════════════════════════════════════════════ */

window.toggleAuthModal = function () {
  const modal = document.getElementById("auth-modal");
  if (modal) modal.classList.toggle("active");
};

window.closeProfileModal = function () {
  const modal = document.getElementById("profile-modal");
  if (modal) modal.classList.remove("active");
};

window.handleLogin = async function (provider) {
  if (_loginInProgress) return;
  _loginInProgress = true;
  const authBtns = document.querySelectorAll(".auth-btn");
  authBtns.forEach((b) => { b.disabled = true; b.style.opacity = "0.6"; });
  try {
    if (provider === "google") await window.loginWithGoogle();
    else if (provider === "discord") await window.loginWithDiscord();
    const modal = document.getElementById("auth-modal");
    if (modal) modal.classList.remove("active");
    // onAuthStateChanged prend le relais pour la redirection / UI
  } catch (e) {
    console.error("[dashboard] Login error:", e);
  } finally {
    _loginInProgress = false;
    authBtns.forEach((b) => { b.disabled = false; b.style.opacity = ""; });
  }
};

window.handleLogout = async function (event) {
  if (event) event.stopPropagation();
  if (!confirm("Voulez-vous vous déconnecter ?")) return;
  try { await signOut(auth); } catch (e) { console.warn("[dashboard] logout error:", e.message); }
  currentUser = null;
  updateAuthUI(null);
};

window.toggleUserDropdown = function (event) {
  if (event) event.stopPropagation();
  const c = document.getElementById("user-container");
  if (c) c.classList.toggle("open");
};

window.closeUserDropdown = function () {
  const c = document.getElementById("user-container");
  if (c) c.classList.remove("open");
};

window.goToProfilePage = function (event) {
  if (event) event.stopPropagation();
  window.closeUserDropdown();
  // Si l'utilisateur a un publicId, on pointe vers son profil public
  const pid = currentUser?.publicId;
  if (pid) {
    window.location.href = `profile.html?publicId=${encodeURIComponent(pid)}&player=${encodeURIComponent(currentUser.name || "")}`;
  } else {
    window.location.href = "profile.html";
  }
};

// Fermer le dropdown au clic extérieur
document.addEventListener("click", (e) => {
  const c = document.getElementById("user-container");
  if (c && !c.contains(e.target)) c.classList.remove("open");
});

/* ── Ownership verification (pour le #profile-modal copié de index.html) ── */

window.startOwnershipVerification = async function () {
  if (!currentUser) {
    showToast("Veuillez vous connecter d'abord.", "warning");
    return;
  }
  const usernameInput = document.getElementById("profile-username");
  const publicIdInput = document.getElementById("profile-public-id");
  const username = (usernameInput?.value || "").trim();
  const publicId = (publicIdInput?.value || "").trim();

  if (!username || !publicId) {
    showToast("Veuillez remplir tous les champs.", "warning");
    return;
  }
  if (username.length < 2 || username.length > 30) {
    showToast("Le pseudo doit faire entre 2 et 30 caractères.", "warning");
    return;
  }
  if (!/^[A-Za-z0-9]{8}$/.test(publicId)) {
    showToast("Le Public ID doit faire exactement 8 caractères alphanumériques (ex: HabCsQYR).", "warning");
    return;
  }
  if (/[^a-zA-Z0-9_\- ]/.test(username)) {
    showToast("Le pseudo ne peut contenir que des lettres, chiffres, espaces, _ et -.", "warning");
    return;
  }

  showToast("Vérification du Public ID…", "info", 3000);
  try {
    const playerData = await fetchOpenFront(`/public/player/${encodeURIComponent(publicId)}`);
    if (!playerData || !playerData.publicId) {
      showToast("Public ID introuvable sur OpenFront. Vérifiez votre saisie.", "error");
      return;
    }
  } catch (e) {
    if (e?.isNotFound || e?.status === 404) {
      showToast("Public ID introuvable sur OpenFront. Vérifiez votre saisie.", "error");
      return;
    }
    showToast("Impossible de vérifier le Public ID (API indisponible). Réessayez plus tard.", "error", 6000);
    console.error("[ownership] API check failed:", e);
    return;
  }

  // Génération du code challenge TFS-XXXX
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  _ownershipCode = "TFS-";
  const rand = crypto.getRandomValues(new Uint8Array(4));
  for (let i = 0; i < 4; i++) _ownershipCode += chars[rand[i] % chars.length];
  _ownershipPublicId = publicId;
  _ownershipUsername = username;

  const s1 = document.getElementById("profile-setup-step1");
  const s2 = document.getElementById("profile-setup-step2");
  if (s1) s1.style.display = "none";
  if (s2) s2.style.display = "block";
  const codeEl = document.getElementById("ownership-code");
  const exEl = document.getElementById("ownership-example");
  if (codeEl) codeEl.textContent = _ownershipCode;
  if (exEl) exEl.textContent = _ownershipCode + " " + username;
  showToast("Code généré. Suivez les instructions ci-dessous.", "info");
  if (window.hydrateIcons) window.hydrateIcons(document.getElementById("profile-modal"));
};

window.confirmOwnershipVerification = async function () {
  if (!_ownershipCode || !_ownershipPublicId) return;
  const btn = document.getElementById("confirm-ownership-btn");
  const original = btn?.textContent || "Confirmer";
  if (btn) { btn.disabled = true; btn.textContent = "Vérification…"; }
  try {
    const gamesData = await fetchOpenFront(`/public/player/${encodeURIComponent(_ownershipPublicId)}/games`);
    const games = Array.isArray(gamesData?.results) ? gamesData.results : [];
    const found = games.some((g) => g.username && g.username.includes(_ownershipCode));
    if (!found) {
      showToast("Code non trouvé dans vos parties récentes. Jouez une partie avec le code dans votre pseudo, puis confirmez.", "error", 6000);
      if (btn) { btn.disabled = false; btn.textContent = original; }
      return;
    }
    await saveUserProfile(_ownershipUsername, _ownershipPublicId);
  } catch (e) {
    console.error("[ownership] Confirmation failed:", e);
    showToast("Erreur lors de la vérification. Réessayez.", "error");
    if (btn) { btn.disabled = false; btn.textContent = original; }
  }
};

window.cancelOwnershipVerification = function () {
  _ownershipCode = null;
  _ownershipPublicId = null;
  _ownershipUsername = null;
  const s1 = document.getElementById("profile-setup-step1");
  const s2 = document.getElementById("profile-setup-step2");
  if (s1) s1.style.display = "block";
  if (s2) s2.style.display = "none";
};

async function saveUserProfile(username, publicId) {
  if (!currentUser) throw new Error("No authenticated user");
  try {
    const userDocRef = doc(db, "users", currentUser.uid);
    const existing = (await getDoc(userDocRef)).data() || {};
    await setDoc(userDocRef, {
      username,
      publicId,
      email: currentUser.email,
      verified: true,
      verifiedAt: new Date().toISOString(),
      createdAt: existing.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      openFrontSyncPending: true,
    }, { merge: true });

    currentUser.name = username;
    currentUser.publicId = publicId;

    const modal = document.getElementById("profile-modal");
    if (modal) modal.classList.remove("active");
    window.cancelOwnershipVerification();
    updateAuthUI(currentUser);
    showToast("Profil vérifié et enregistré avec succès ! Redirection…", "success");
    setTimeout(() => { window.location.href = `profile.html?publicId=${encodeURIComponent(publicId)}&player=${encodeURIComponent(username)}`; }, 800);
  } catch (e) {
    console.error("[dashboard] Save profile error:", e);
    showToast("Erreur lors de la sauvegarde du profil.", "error");
    throw e;
  }
}

/* ════════════════════════════════════════════════════════════════
   Navigation cliquable des lignes du tableau (délégation)
   ════════════════════════════════════════════════════════════════ */

document.addEventListener("click", (e) => {
  const row = e.target.closest(".dash-row-link");
  if (row && row.dataset.href) {
    window.location.href = row.dataset.href;
  }
});

/* ════════════════════════════════════════════════════════════════
   Init
   ════════════════════════════════════════════════════════════════ */

(async function init() {
  try {
    // Phase 0 : Charger dashboard_scores.json.gz (pré-calculé par la sync)
    // → rendu INSTANTANÉ, pas d'appel API live
    let scoresLoaded = false;
    try {
      const res = await fetch("dashboard_scores.json.gz", { cache: "no-store" });
      if (res.ok) {
        const ds = new DecompressionStream("gzip");
        const decompressed = res.body.pipeThrough(ds);
        const scoresData = await new Response(decompressed).json();
        if (scoresData && scoresData.players && scoresData.players.length > 0) {
          console.log(`[dashboard] ⚡ Scores pré-calculés chargés: ${scoresData.players.length} joueurs (${scoresData.lastUpdate})`);

          // Remplir _liveStats avec les scores pré-calculés pour réutiliser buildMergedViews
          for (const p of scoresData.players) {
            _liveStats[p.publicId] = {
              username: p.username,
              global: {
                ffaCasualWins: p.ffa_casual || 0,
                ffaRankedWins: p.ffa_ranked || 0,
                teamCasualWins: p.team_casual || 0,
                teamRankedWins: p.team_ranked || 0,
              },
              weekly: { ffaCasualWins: p.ffa_casual || 0, ffaRankedWins: p.ffa_ranked || 0, teamCasualWins: p.team_casual || 0, teamRankedWins: p.team_ranked || 0 },
              elo: p.elo,
              peak_elo: p.peak_elo,
              fetchedAt: Date.now(),
            };
          }

          // Load ranked.json for ELO display + ranked wins merge
          await loadRankedJson();
          _mergedViews = buildMergedViews();
          mergeAndRender();
          scoresLoaded = true;
          _liveFetchDone = true;
          _liveFetchProgress = 1; // prevent progress bar
        }
      }
    } catch (e) {
      console.warn("[dashboard] dashboard_scores.json.gz non disponible, fallback live:", e.message);
    }

    if (scoresLoaded) {
      console.log("[dashboard] ✅ Rendu instantané depuis scores pré-calculés");
      return;
    }

    // Fallback : ancien système (ranked.json + live API)
    // Phase 1 : Charger ranked.json → rendu immédiat avec données classées
    await loadRankedJson();
    _mergedViews = buildMergedViews();
    render();

    // Phase 2 : Charger la liste des joueurs connectés (Firebase)
    await loadConnectedPlayers();

    // Phase 3 : Charger les stats live pour chaque joueur connecté
    if (_connectedPlayers.length > 0) {
      loadLiveStats().then(() => {
        mergeAndRender();
        console.log("[dashboard] Stats live chargées");
      }).catch((e) => {
        console.warn("[dashboard] loadLiveStats error:", e.message);
      });
    } else {
      _liveFetchDone = true;
    }
  } catch (e) {
    console.error("[dashboard] init failed:", e);
    view.innerHTML = `<div class="dash-empty-state"><div class="dash-empty-icon"><i data-icon="warning"></i></div><h3>Erreur</h3><p>${escapeHtml(e.message || "Chargement impossible.")}</p></div>`;
    if (window.hydrateIcons) window.hydrateIcons(view);
  }
})();
