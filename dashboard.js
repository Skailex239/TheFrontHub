/**
 * dashboard.js — Contrôleur du Tableau de bord TheFrontHub.
 *
 * Architecture (NO SYNC — le site fait les requêtes API lui-même) :
 *
 *   1. ranked.json (auto-synced par GitHub Actions) → ranked wins carrière
 *      pour le top 100 1v1 + top 100 2v2. Servé depuis GitHub Pages.
 *
 *   2. Firebase public-aliases (Firestore REST API) → liste des joueurs
 *      connectés via Google/Discord qui ont lié leur Public ID.
 *
 *   3. OpenFront API (via proxy Cloudflare Worker ou /api/openfront en dev)
 *      → pour chaque joueur connecté, on pagine TOUTES ses parties et on
 *      compte les victoires par catégorie (FFA casual, FFA classé, Team
 *      casual, Team classé). Le proxy ajoute le header x-skailex-access
 *      côté serveur (exemption de rate-limit).
 *
 *   Merge :
 *     - Joueurs ranked-only : ranked wins de ranked.json, casual = 0
 *     - Joueurs connectés : ranked wins = max(ranked.json, API carrière),
 *       casual wins = API live
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
import { fetchOpenFront } from "./openfront-client.js?v=24";

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
let _mergedPlayers = [];       // liste fusionnée ranked + live
let _liveFetchDone = false;    // true quand toutes les stats live sont chargées
let _liveFetchProgress = 0;    // nombre de joueurs connectés traités
let _dashMode = "global";      // "global" | "weekly"
let currentUser = null;     // { name, publicId, avatar, uid, email }
let _ownershipCode = null;
let _ownershipPublicId = null;
let _ownershipUsername = null;
let _loginInProgress = false;

const LIVE_CACHE_KEY = "dash_live_stats_v1";
const LIVE_CACHE_TTL = 30 * 60 * 1000; // 30 minutes
const WEEKLY_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_GAMES_PER_PLAYER = 5000; // sécurité
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
 * Pagine TOUTES les parties d'un joueur via le proxy OpenFront.
 * Retourne [{ gameId, start, mode, rankedType, result, map, ... }].
 */
async function fetchAllPlayerGames(publicId) {
  const allGames = [];
  let cursor = null;
  for (let page = 0; page < 500; page++) {
    let apiPath = `/public/player/${encodeURIComponent(publicId)}/games`;
    if (cursor) apiPath += `?cursor=${encodeURIComponent(cursor)}`;
    let data;
    try {
      data = await fetchOpenFront(apiPath);
    } catch (e) {
      console.warn(`[dashboard] fetch games ${publicId} page ${page}:`, e.message);
      break;
    }
    const results = data?.results || [];
    if (results.length === 0) break;
    allGames.push(...results);
    if (!data.nextCursor) break;
    cursor = data.nextCursor;
    if (allGames.length >= MAX_GAMES_PER_PLAYER) break;
  }
  return allGames;
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
      const games = await fetchAllPlayerGames(player.publicId);
      const wins = computeWinsFromGames(games);
      const entry = {
        publicId: player.publicId,
        username: player.username,
        games: games.slice(-20), // garder les 20 plus récentes pour le profil
        global: wins.global,
        weekly: wins.weekly,
        totalGames: games.length,
        fetchedAt: Date.now(),
      };
      _liveStats[player.publicId] = entry;
      cached[player.publicId] = entry;
      localStorage.setItem(LIVE_CACHE_KEY, JSON.stringify(cached));
      console.log(`[dashboard] live: ${player.username} (${player.publicId}) → ${games.length} games, global=${JSON.stringify(wins.global)}`);
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
   Merge ranked.json + stats live → _mergedPlayers
   ════════════════════════════════════════════════════════════════ */

function pointsFor(p) {
  return (p.ffaCasualWins || 0) * PTS_FFA_CASUAL
       + (p.ffaRankedWins || 0) * PTS_FFA_RANKED
       + (p.teamCasualWins || 0) * PTS_TEAM_CASUAL
       + (p.teamRankedWins || 0) * PTS_TEAM_RANKED;
}

/** Fusionne ranked.json (career ranked wins) + live API (casual wins). */
function buildMergedPlayers() {
  const byPid = new Map();
  const isWeekly = _dashMode === "weekly";

  // 1. ranked.json → ranked wins carrière (GLOBAL uniquement)
  //    En weekly, on ne peut pas déduire les wins hebdo depuis ranked.json (career total only)
  //    → les joueurs ranked-only ont 0 pts en weekly
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
      // En weekly, on garde les career wins uniquement si le joueur n'a PAS de stats live
      // (les stats live remplaceront par les vraies valeurs hebdo)
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
    e.ffaCasualWins = g.ffaCasual;
    e.teamCasualWins = g.teamCasual;
    // Ranked wins :
    //   - Global : max(ranked.json career, API live) — ranked.json est plus complet
    //   - Weekly : API live uniquement (ranked.json n'a pas de breakdown hebdo)
    if (isWeekly) {
      e.ffaRankedWins = g.ffaRanked;
      e.teamRankedWins = g.teamRanked;
    } else {
      e.ffaRankedWins = Math.max(e.ffaRankedWins || 0, g.ffaRanked);
      e.teamRankedWins = Math.max(e.teamRankedWins || 0, g.teamRanked);
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
}

/** Retourne la vue active (global ou weekly). */
function getActiveView() {
  return { players: _mergedPlayers };
}

/* ════════════════════════════════════════════════════════════════
   Rendu
   ════════════════════════════════════════════════════════════════ */

function render() {
  if (!_rankedData && _mergedPlayers.length === 0) {
    view.innerHTML = `
      <div class="dash-empty-state">
        <div class="dash-empty-icon"><i data-icon="chart"></i></div>
        <h3>Chargement…</h3>
        <p>Récupération du classement…</p>
      </div>`;
    if (window.hydrateIcons) window.hydrateIcons(view);
    return;
  }

  const isWeekly = _dashMode === "weekly";
  const players = _mergedPlayers.map((p) => ({ ...p }));
  if (players.length === 0) {
    view.innerHTML = `
      <div class="dash-empty-state">
        <div class="dash-empty-icon"><i data-icon="chart"></i></div>
        <h3>Aucune donnée disponible</h3>
        <p>${isWeekly ? "Aucune partie cette semaine." : "Chargement…"}</p>
      </div>`;
    if (window.hydrateIcons) window.hydrateIcons(view);
    return;
  }

  // Ajout du rang
  players.forEach((p, i) => { p.rank = i + 1; });

  const champion = players[0] ?? null;
  const totalPlayers = players.length;
  const topN = players.slice(0, 50);
  const modeLabel = isWeekly ? "Cette semaine" : "Global";

  // Indicateur de chargement live
  const liveTag = !_liveFetchDone
    ? `<span class="dash-fallback-tag">⚡ Chargement live des stats… (${_liveFetchProgress}/${_connectedPlayers.length})</span>`
    : "";

  view.innerHTML = `
    ${liveTag}

    <div class="dash-controls-row">
      <div class="dash-toggle" role="tablist" aria-label="Période du classement">
        <button class="dash-toggle-btn ${!isWeekly ? "active" : ""}" data-mode="global" role="tab" aria-selected="${!isWeekly}">Global</button>
        <button class="dash-toggle-btn ${isWeekly ? "active" : ""}" data-mode="weekly" role="tab" aria-selected="${isWeekly}">Cette semaine</button>
      </div>
      <div class="dash-scoring-inline">FFA casual +10 · FFA classé +1 · Team casual +5 · Team classé +1</div>
    </div>

    <div class="dash-grid">
      ${champion ? renderChampion(champion, isWeekly) : ""}
      ${renderRanking(topN, totalPlayers, modeLabel)}
    </div>

    <div class="dash-scoring-info">
      <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>
      <span>Barème : <strong>FFA casual +10</strong> · <strong>FFA classé +1</strong> · <strong>Team casual +5</strong> · <strong>Team classé +1</strong> (le classé rapporte juste 1 pt, pas en plus). ${isWeekly ? "Vue hebdomadaire = parties des 7 derniers jours." : "Vue globale = cumul de toutes les parties."} Les stats des joueurs connectés sont récupérées en temps réel via l'API OpenFront.</span>
    </div>
  `;

  // Hydrate les icônes <i data-icon>
  if (window.hydrateIcons) window.hydrateIcons(view);

  // Toggle listeners (les boutons sont dans #dashboard-view)
  view.querySelectorAll(".dash-toggle-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      _dashMode = btn.dataset.mode;
      mergeAndRender();
    });
  });
}

/** Merge + render (utilisé après chaque fetch live pour mise à jour progressive). */
function mergeAndRender() {
  _mergedPlayers = buildMergedPlayers();
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
          <span class="dash-champion-trophy" aria-hidden="true">🏆</span>
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
    const trophy = p.rank === 1 ? "🏆" : p.rank === 2 ? "🥈" : p.rank === 3 ? "🥉" : null;
    const rankSlot = trophy
      ? `<span class="dash-rank-trophy" aria-hidden="true">${trophy}</span>`
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
    // Phase 1 : Charger ranked.json → rendu immédiat avec données classées
    await loadRankedJson();
    _mergedPlayers = buildMergedPlayers();
    render();

    // Phase 2 : Charger la liste des joueurs connectés (Firebase)
    await loadConnectedPlayers();

    // Phase 3 : Charger les stats live pour chaque joueur connecté
    // (rendu progressif après chaque joueur)
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
