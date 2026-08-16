/**
 * profile.js — Profile page logic for TheFrontHub.
 *
 * Flow:
 *   onAuthStateChanged →
 *     • no user                       → show #profile-gate
 *     • user, no Firestore profile    → show #profile-setup (ownership verification)
 *     • user, profile with publicId   → fetch OpenFront stats → show #profile-main
 *
 * Stats are fetched from `https://api.openfront.io/public/player/{publicId}` via
 * fetchOpenFront (handles CORS proxy). ELO is read from local `ranked.json`.
 * Recent games (last 5) get an additional `/public/game/{gameId}` fetch to
 * determine win/loss based on the `winner` array (clientIDs of winners).
 */

import {
  auth, db, doc, getDoc, setDoc,
  collection, onSnapshot,
  onAuthStateChanged,
} from "./auth.js";
import { fetchOpenFront } from "./openfront-client.js?v=24";
import {
  getSkin, getUnlockableSkins, DEFAULT_SKIN_ID, RARITY_META, normalizeCode,
} from "./skins.js?v=1";
import {
  fetchOwnedSkins, redeemCode, activateSkin, applySkinToElement,
  invalidateActiveSkinCache,
} from "./reward-codes.js?v=1";
import {
  computePlaytimeStats, extractCareerWins, totalWins, pointsFor,
  formatDurationCompact, formatPct, formatFrenchDate,
  formatPoints, classifyGame,
} from "./playtime-stats.js?v=1";

/* ── State ── */
let currentUser = null;
let currentProfile = null;
let _ownershipCode = null;
let _ownershipPublicId = null;
let _ownershipUsername = null;
let _rankedCache = null;
let _allGamesCache = null; // toutes les games paginées (pour playtime + map stats)
let _allGamesLoading = false;
let _mapStatsSortBy = "count";
let _mapStatsShowAll = false;
let _rewardCardState = { publicId: null, ownedSkins: [], activeSkinId: null };

// VIP skin: publicId → rewardType (matching par PUBLIC ID, pas par alias)
let vipPlayersByPid = new Map();
let _vipUnsub = null;
const NEW_SKIN_TYPES = ['cyberpunk','sunset','aurore','pastel','gold','volcano','ocean','miami','toxic','chroma','prism'];

/**
 * Écoute public-rewards et construit la map publicId → rewardType.
 * Le skin suit le PUBLIC ID (identité stable) plutôt que l'alias (changeant).
 * On lit data.publicId directement; en fallback on essaie data.username contre
 * le username du profil courant.
 */
function loadVipForProfile() {
  if (_vipUnsub) return; // déjà abonné
  try {
    _vipUnsub = onSnapshot(collection(db, "public-rewards"), (snap) => {
      vipPlayersByPid = new Map();
      // fallback: username → rewardType (pour les docs sans publicId direct)
      const usernameToType = new Map();
      snap.forEach((docSnap) => {
        const data = docSnap.data();
        const rewardType = data.activeType || data.type || null;
        if (!rewardType || data.activated === false) return;
        if (data.publicId) vipPlayersByPid.set(String(data.publicId), rewardType);
        if (data.username) usernameToType.set(data.username, rewardType);
      });
      // Re-applique le skin sur le hero si on a un profil
      // En mode visualisation publique, on utilise le profil virtuel du joueur consulté
      // (son publicId) plutôt que le profil propre de l'utilisateur courant.
      if (viewingPublicId) {
        applyProfileSkin({ username: viewingUsername, publicId: viewingPublicId }, usernameToType);
      } else if (currentProfile) {
        applyProfileSkin(currentProfile, usernameToType);
      }
    }, (err) => {
      console.warn("[profile] VIP listener error (non-critique):", err.message);
    });
  } catch (e) {
    console.warn("[profile] loadVipForProfile error:", e);
  }
}

/**
 * Applique le skin VIP sur le pseudo du hero, résolu via publicId (prioritaire)
 * puis fallback username.
 */
function applyProfileSkin(profile, usernameToTypeFallback) {
  const nameEl = document.getElementById("profile-title-name");
  if (!nameEl) return;
  const pid = profile?.publicId;
  const rewardType = (pid && vipPlayersByPid.get(pid))
    || (profile?.username && usernameToTypeFallback?.get(profile.username))
    || null;
  if (rewardType && NEW_SKIN_TYPES.includes(rewardType)) {
    nameEl.className = `rgb-${rewardType}`;
  } else if (rewardType) {
    nameEl.className = `player-${rewardType}`;
  } else {
    nameEl.className = "";
  }
}

/* ── Helpers ── */

function esc(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function showToast(msg, type = "info", duration = 4000) {
  if (typeof window.showToast === "function") window.showToast(msg, type, duration);
  else console.log(`[toast:${type}]`, msg);
}

function showView(view) {
  const views = ["profile-loading", "profile-gate", "profile-setup", "profile-main"];
  views.forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.classList.toggle("is-active", id === view);
  });
}

function formatDateShort(iso) {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleDateString(undefined, { day: "2-digit", month: "short", year: "numeric" });
  } catch { return iso; }
}

function formatDateTime(iso) {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString(undefined, { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
  } catch { return iso; }
}

function setStat(id, value, muted = false) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = value == null ? "—" : String(value);
  el.classList.toggle("muted", muted);
}

/* ── Auth state ── */

// Public profile view state (set when URL contains ?publicId=XXX)
let viewingPublicId = null;
let viewingUsername = null;

/**
 * Détecte si l'URL demande de visualiser le profil PUBLIC d'un autre joueur.
 * Format: profile.html?player=NAME&publicId=XXXXXXXX
 * Si le publicId correspond à celui de l'utilisateur courant, on ignore
 * (c'est son propre profil — flux normal).
 */
function getPublicProfileRequest() {
  const params = new URLSearchParams(window.location.search);
  const pid = (params.get("publicId") || params.get("pid") || "").trim();
  const name = (params.get("player") || "").trim();
  if (pid && /^[A-Za-z0-9]{8}$/.test(pid)) {
    return { publicId: pid, username: name || pid };
  }
  return null;
}

onAuthStateChanged(auth, async (user) => {
  // ── Cas 1 : visualisation du profil public d'un autre joueur ──
  // On vérifie l'URL AVANT toute logique d'auth, car cela doit fonctionner
  // même si l'utilisateur n'est pas connecté.
  const pubReq = getPublicProfileRequest();
  if (pubReq) {
    // Lecture du propre profil de l'utilisateur courant (s'il est connecté)
    // pour détecter s'il visualise son PROPRE profil → flux normal.
    let ownProfile = null;
    if (user) {
      try {
        const snap = await getDoc(doc(db, "users", user.uid));
        if (snap.exists()) ownProfile = snap.data();
      } catch (e) {
        console.warn("[profile] Firestore read error (own, non-bloquant):", e.message);
      }
    }

    if (ownProfile && ownProfile.publicId === pubReq.publicId) {
      // L'utilisateur visualise son propre profil → flux normal (on nettoie l'URL)
      history.replaceState(null, "", window.location.pathname);
      currentUser = user;
      currentProfile = ownProfile;
      updateSidebarUI(user, ownProfile);
      showView("profile-main");
      renderHero(user, ownProfile);
      loadVipForProfile();
      await loadStats(ownProfile.publicId);
      return;
    }

    // ── Profil d'un AUTRE joueur (ou visiteur non connecté) ──
    currentUser = user; // peut être null
    currentProfile = ownProfile; // pour la sidebar (peut être null)
    updateSidebarUI(user, ownProfile);
    viewingPublicId = pubReq.publicId;
    viewingUsername = pubReq.username;
    showView("profile-main");
    renderPublicProfile(pubReq.username, pubReq.publicId);
    loadVipForProfile();
    await loadStats(pubReq.publicId);
    return;
  }

  // ── Cas 2 : pas de ?publicId dans l'URL → flux normal ──
  if (!user) {
    currentUser = null;
    currentProfile = null;
    updateSidebarUI(null);
    showView("profile-gate");
    return;
  }

  currentUser = user;

  // Read Firestore profile
  let profile = null;
  try {
    const snap = await getDoc(doc(db, "users", user.uid));
    if (snap.exists()) profile = snap.data();
  } catch (e) {
    console.error("[profile] Firestore read error:", e);
    showToast("Erreur de lecture du profil (Firestore).", "error");
  }

  currentProfile = profile;
  updateSidebarUI(user, profile);

  if (!profile || !profile.publicId) {
    // New user → setup form
    showView("profile-setup");
    return;
  }

  // Returning user with publicId → fetch & display stats
  showView("profile-main");
  renderHero(user, profile);
  // Lance l'écoute VIP (skin par publicId) — re-applique le skin dès que les rewards arrivent
  loadVipForProfile();
  await loadStats(profile.publicId);
});

/**
 * Affiche le profil PUBLIC d'un autre joueur (ou le sien propre si visité via URL).
 * Masque le bouton de déconnexion, neutralise les actions d'édition, et applique
 * le skin VIP résolu via publicId.
 */
function renderPublicProfile(username, publicId) {
  const nameEl = document.getElementById("profile-title-name");
  if (nameEl) nameEl.textContent = username;

  const badgeEl = document.getElementById("profile-public-badge");
  if (badgeEl) badgeEl.textContent = "Public ID : " + publicId;

  // Affiche la bannière "Profil public" + bouton retour
  const banner = document.getElementById("public-profile-banner");
  if (banner) banner.style.display = "flex";

  // Masque le bouton de déconnexion (ce n'est pas notre session)
  const logoutBtn = document.querySelector(".pf-logout-btn");
  if (logoutBtn) logoutBtn.style.display = "none";

  // Avatar : fallback PDP.png (on n'a pas l'avatar du joueur distant)
  const avatarEl = document.getElementById("profile-avatar-large");
  if (avatarEl) {
    avatarEl.innerHTML = `<img src="PDP.png" alt="${esc(username)}" style="width:100%;height:100%;object-fit:cover">`;
  }

  // Construit un pseudo-profil pour que applyProfileSkin résolve le skin VIP
  // via le publicId du joueur visualisé (et non celui de l'utilisateur courant).
  const virtualProfile = { username, publicId };
  applyProfileSkin(virtualProfile, null);
}

/* ── Sidebar / dropdown UI ── */

function updateSidebarUI(user, profile) {
  const loginBtn = document.getElementById("login-btn-main");
  const userContainer = document.getElementById("user-container");
  if (!user) {
    if (loginBtn) loginBtn.style.display = "flex";
    if (userContainer) { userContainer.style.display = "none"; userContainer.classList.remove("open"); }
    return;
  }
  if (loginBtn) loginBtn.style.display = "none";
  if (userContainer) userContainer.style.display = "block";

  const name = profile?.username || user.displayName || user.email || "Joueur";
  const publicId = profile?.publicId || "Non lié";

  const setText = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
  setText("user-display-name", name);
  setText("user-public-id-side", publicId !== "Non lié" ? publicId : "En ligne");
  setText("dropdown-username-display", name);
  setText("dropdown-publicid-display", publicId);

  const avatarEl = document.getElementById("dropdown-avatar");
  if (avatarEl) {
    if (user.photoURL) {
      avatarEl.innerHTML = `<img src="${esc(user.photoURL)}" alt="${esc(name)}" style="width:100%;height:100%;border-radius:50%;object-fit:cover">`;
    } else {
      avatarEl.textContent = (name || "U").substring(0, 2).toUpperCase();
      avatarEl.style.background = "linear-gradient(135deg,var(--accent),var(--accentL))";
    }
  }
}

/* ── Main view: hero ── */

function renderHero(user, profile) {
  const nameEl = document.getElementById("profile-title-name");
  if (nameEl) {
    nameEl.innerHTML = "";
    const skinSpan = document.createElement("span");
    skinSpan.textContent = profile.username || user.displayName || "Joueur";
    nameEl.appendChild(skinSpan);
    applySkinToElement(skinSpan, profile.publicId, true);
  }

  const badgeEl = document.getElementById("profile-public-badge");
  if (badgeEl) badgeEl.textContent = "Public ID: " + (profile.publicId || "—");

  // Masque la bannière "Profil public" (flux normal = propre profil)
  const banner = document.getElementById("public-profile-banner");
  if (banner) banner.style.display = "none";

  // Ré-affiche le bouton de déconnexion (flux normal)
  const logoutBtn = document.querySelector(".pf-logout-btn");
  if (logoutBtn) logoutBtn.style.display = "";

  const avatarEl = document.getElementById("profile-avatar-large");
  if (avatarEl) {
    // Use PDP.png as the avatar image (instead of default letter)
    avatarEl.innerHTML = `<img src="PDP.png" alt="${esc(profile.username || 'avatar')}" style="width:100%;height:100%;object-fit:cover">`;
  }

  // Applique le skin VIP résolu par publicId (le listener VIP re-appliquera quand
  // les rewards arriveront). Fallback username = null ici car pas encore chargé.
  applyProfileSkin(profile, null);
}

/* ── Main view: load stats ── */

async function loadStats(publicId) {
  // Reset stats list to loading
  setText("stat-week-rank", "This week rank: …");
  setText("stat-week-score", "This week score: …");
  setText("stat-alltime", "All-time score: …");
  const recentEl = document.getElementById("profile-recent-games");
  if (recentEl) recentEl.innerHTML = `<div class="pf-empty">Chargement…</div>`;
  hideError();

  // Kick off ELO lookup (ranked.json) in parallel
  const eloPromise = getRankedEntry(publicId);

  // Kick off recent games fetch in parallel (separate endpoint)
  // /public/player/{id} returns aggregated stats only (no games array).
  // /public/player/{id}/games returns the actual recent games list with
  // result (victory/defeat) already included — no need for per-game fetch.
  const recentGamesPromise = fetchRecentGames(publicId);
  // Supprime la rejection non-gérée si on retourne avant (publicId invalide).
  recentGamesPromise.catch(() => {});

  let playerData;
  try {
    playerData = await fetchOpenFront(`/public/player/${encodeURIComponent(publicId)}`);
  } catch (e) {
    console.error("[profile] OpenFront API error:", e);
    if (e?.isNotFound || e?.status === 404) {
      showError(
        `Joueur introuvable sur l'API OpenFront (publicId : ${publicId}). ` +
        `Vérifie que ton identifiant OpenFront est correct dans tes paramètres de profil.`
      );
    } else {
      showError(`Impossible de charger les statistiques depuis l'API OpenFront.`);
    }
    setText("stat-week-rank", "This week rank: —");
    setText("stat-week-score", "This week score: —");
    setText("stat-alltime", "All-time score: —");
    const c = document.getElementById("profile-recent-games");
    if (c) c.innerHTML = `<div class="pf-empty">Aucune partie récente.</div>`;
    return;
  }

  if (!playerData) {
    showError("Réponse vide de l'API OpenFront.");
    return;
  }

  // NOTE: /public/player/{id} no longer returns a `games` array.
  // Recent games come from the separate /games endpoint (recentGamesPromise).
  const games = [];
  const stats = computeStats(games, playerData.stats || {});

  // ── Render reward card + career stats + start games loading IMMEDIATELY ──
  // Don't wait for dashboard_scores, ELO, or recent games — those are secondary.
  renderRewardCodeCard(publicId);
  renderCareerStats(playerData.stats || {}, publicId);
  loadAllGamesForStats(publicId);

  // ── Week stats from dashboard_scores.json (official data) — non-blocking ──
  (async () => {
    let weekScore = 0, weekRank = "—", weekFFA = 0, weekTeam = 0, weekTotalPoints = 0;
    try {
      const scoresRes = await fetch("dashboard_scores.json.gz", { cache: "force-cache" });
      let scoresData = null;
      if (scoresRes.ok) {
        const ds = new DecompressionStream("gzip");
        scoresData = await new Response(scoresRes.body.pipeThrough(ds)).json();
      } else {
        const fallback = await fetch("dashboard_scores.json");
        if (fallback.ok) scoresData = await fallback.json();
      }
      if (scoresData && scoresData.players) {
        const entry = scoresData.players.find(p => p.publicId === publicId);
        if (entry) {
          weekFFA = (entry.weekly_ffa_casual || 0) + (entry.weekly_ffa_ranked || 0);
          weekTeam = (entry.weekly_team_casual || 0) + (entry.weekly_team_ranked || 0);
          weekScore = entry.weekly_points || 0;
          weekTotalPoints = entry.points || 0;
          // Compute rank: position in the sorted weekly leaderboard
          const weeklySorted = [...scoresData.players].sort((a, b) => (b.weekly_points || 0) - (a.weekly_points || 0));
          const rankIdx = weeklySorted.findIndex(p => p.publicId === publicId);
          weekRank = rankIdx >= 0 ? rankIdx + 1 : "—";

          // Store for the chart
          window._profileWeekData = {
            ffa: weekFFA,
            team: weekTeam,
            total: weekScore,
            rank: weekRank,
            weekStart: scoresData.weekStart,
            // Detailed breakdown for tooltip
            ffaCasual: entry.weekly_ffa_casual || 0,
            ffaRanked: entry.weekly_ffa_ranked || 0,
            teamCasual: entry.weekly_team_casual || 0,
            teamRanked: entry.weekly_team_ranked || 0,
            allTimePoints: entry.points || 0,
            allTimeFfa: entry.ffa_casual || 0,
            allTimeTeam: entry.team_casual || 0,
          };
        }
      }
    } catch (e) {
      console.warn("[profile] Week stats load failed:", e.message);
    }

    // All-time score
    const allTimeScore = stats.wins * 4 + (stats.total - stats.wins);

    // Breakdown by mode
    const breakdown = computeModeBreakdown(playerData.stats || {});
    const detail = [];
    if (breakdown.FFA) detail.push("FFA: " + breakdown.FFA);
    if (breakdown.Team) detail.push("Team: " + breakdown.Team);
    if (breakdown.Duos) detail.push("Duos: " + breakdown.Duos);
    if (breakdown.Trios) detail.push("Trios: " + breakdown.Trios);
    if (breakdown.Quads) detail.push("Quads: " + breakdown.Quads);
    const detailStr = detail.length ? " (" + detail.join(", ") + ")" : "";

    setText("stat-week-rank", `This week rank: #${weekRank}`);
    setText("stat-week-score", `This week score: ${weekScore} pts (FFA: ${weekFFA} · Team: ${weekTeam})`);
    setText("stat-alltime", `All-time score: ${weekTotalPoints || allTimeScore} (${stats.wins} wins${detailStr})`);

    // ELO from ranked.json (1v1)
    const ranked1v1 = await eloPromise;
    const eloLine = document.getElementById("stat-elo-line");
    if (eloLine) {
      if (ranked1v1 && ranked1v1.elo != null) {
        eloLine.textContent = `ELO 1v1: ${ranked1v1.elo} (Peak: ${ranked1v1.peakElo ?? '—'}) — Rank #${ranked1v1.rank}`;
        eloLine.style.display = "list-item";
      } else {
        eloLine.style.display = "none";
      }
    }

    // ELO 2v2 from ranked.json
    const ranked2v2 = await getRankedEntry(publicId, "2v2");
    const elo2v2Line = document.getElementById("stat-elo-2v2-line");
    if (elo2v2Line) {
      if (ranked2v2 && ranked2v2.elo != null) {
        elo2v2Line.textContent = `ELO 2v2: ${ranked2v2.elo} (Peak: ${ranked2v2.peakElo ?? '—'}) — Rank #${ranked2v2.rank}`;
        elo2v2Line.style.display = "list-item";
      } else {
        elo2v2Line.style.display = "none";
      }
    }

    // Recent games — fetched from /public/player/{id}/games (separate endpoint).
    try {
      const recentGames = await recentGamesPromise;
      renderRecentGames(recentGames, publicId);
      renderWeeklyChart();
    } catch (e) {
      console.error("[profile] recent games fetch failed:", e);
      const c = document.getElementById("profile-recent-games");
      if (c) c.innerHTML = `<div class="pf-empty">Impossible de charger les parties récentes.</div>`;
    }
  })();
}

/**
 * Fetch recent games for a player from the /public/player/{id}/games endpoint.
 * Returns up to 10 games with result (victory/defeat) already included.
 * Supports cursor pagination to fetch more if needed.
 */
async function fetchRecentGames(publicId, maxPages = 1) {
  const all = [];
  let cursor = null;
  for (let page = 0; page < maxPages; page++) {
    const url = `/public/player/${encodeURIComponent(publicId)}/games` +
      (cursor ? `?cursor=${encodeURIComponent(cursor)}` : "");
    const data = await fetchOpenFront(url);
    const results = Array.isArray(data?.results) ? data.results : [];
    all.push(...results);
    cursor = data?.nextCursor;
    if (!cursor || results.length === 0) break;
  }
  return all;
}

function setText(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
}

function computeModeBreakdown(statsTree) {
  const out = { FFA: 0, Team: 0, Duos: 0, Trios: 0, Quads: 0 };
  if (!statsTree || typeof statsTree !== "object") return out;
  for (const catKey of Object.keys(statsTree)) {
    const cat = statsTree[catKey];
    if (!cat || typeof cat !== "object") continue;
    for (const modeKey of Object.keys(cat)) {
      const mode = cat[modeKey];
      if (!mode || typeof mode !== "object") continue;
      let wins = 0;
      for (const diffKey of Object.keys(mode)) {
        const diff = mode[diffKey];
        if (diff && typeof diff === "object" && diff.wins != null) {
          wins += parseInt(diff.wins, 10) || 0;
        }
      }
      if (modeKey === "Free For All") out.FFA += wins;
      else if (modeKey === "Team") {
        // Try to break down by playerTeams if available
        out.Team += wins;
      }
    }
  }
  return out;
}

function computeStats(games, statsTree) {
  // Wins: sum all "wins" fields across the stats tree (Private/Public/Ranked → mode → difficulty)
  let wins = 0;
  let total = 0;
  if (statsTree && typeof statsTree === "object") {
    for (const catKey of Object.keys(statsTree)) {
      const cat = statsTree[catKey];
      if (!cat || typeof cat !== "object") continue;
      for (const modeKey of Object.keys(cat)) {
        const mode = cat[modeKey];
        if (!mode || typeof mode !== "object") continue;
        for (const diffKey of Object.keys(mode)) {
          const diff = mode[diffKey];
          if (!diff || typeof diff !== "object") continue;
          if (diff.wins != null) wins += parseInt(diff.wins, 10) || 0;
          if (diff.total != null) total += parseInt(diff.total, 10) || 0;
          else if (diff.wins != null && diff.losses != null) {
            total += (parseInt(diff.wins, 10) || 0) + (parseInt(diff.losses, 10) || 0);
          }
        }
      }
    }
  }

  // Fallback: if stats tree has no totals, use games.length
  if (total === 0 && games.length > 0) total = games.length;

  // Unique maps + favourite map
  const mapCounts = {};
  let lastGame = null;
  for (const g of games) {
    if (g.map) mapCounts[g.map] = (mapCounts[g.map] || 0) + 1;
    if (g.start) {
      const d = new Date(g.start).getTime();
      if (!isNaN(d) && (lastGame === null || d > lastGame)) lastGame = d;
    }
  }
  const uniqueMaps = Object.keys(mapCounts).length;
  let favMap = null;
  let favCount = 0;
  for (const [m, c] of Object.entries(mapCounts)) {
    if (c > favCount) { favMap = m; favCount = c; }
  }
  const lastGameIso = lastGame ? new Date(lastGame).toISOString() : null;

  return { wins, total, uniqueMaps, favMap, lastGame: lastGameIso };
}

async function getRankedEntry(publicId, mode = "1v1") {
  if (_rankedCache === null) {
    try {
      const res = await fetch("ranked.json", { cache: "no-store" });
      if (res.ok) _rankedCache = await res.json();
      else _rankedCache = {};
    } catch (e) {
      console.warn("[profile] ranked.json load failed:", e);
      _rankedCache = {};
    }
  }
  const list = (_rankedCache && Array.isArray(_rankedCache[mode])) ? _rankedCache[mode] : [];
  return list.find((p) => p && p.public_id === publicId) || null;
}

function showError(msg) {
  const el = document.getElementById("profile-api-error");
  if (!el) return;
  el.textContent = msg;
  el.style.display = "block";
}
function hideError() {
  const el = document.getElementById("profile-api-error");
  if (el) el.style.display = "none";
}

/* ── Recent games ── */

/**
 * Render recent games from /public/player/{id}/games endpoint.
 * Each game already includes a `result` field ("victory" | "defeat" | other)
 * so no per-game fetch is needed.
 *
 * Game object structure:
 *   { gameId, start, durationSeconds, map, mode, type, playerTeams,
 *     rankedType, result, totalPlayers, username, clanTag }
 */
function renderRecentGames(games, publicId) {
  const container = document.getElementById("profile-recent-games");
  if (!container) return;

  // Sort by start date desc, take last 10 (API returns 10 per page)
  const sorted = games
    .slice()
    .sort((a, b) => new Date(b.start || 0).getTime() - new Date(a.start || 0).getTime())
    .slice(0, 10);

  if (sorted.length === 0) {
    container.innerHTML = `<div class="pf-empty">Aucune partie récente.</div>`;
    return;
  }

  container.innerHTML = sorted.map((g) => {
    const isWin = g.result === "victory";
    const resultClass = isWin ? "win" : "loss";
    const resultLabel = isWin ? "VICTOIRE" : (g.result === "defeat" ? "DÉFAITE" : (g.result || "—"));
    const duration = g.durationSeconds ? formatDuration(g.durationSeconds) : "—";
    const modeLabel = formatGameMode(g);
    const mapName = g.map || "Carte inconnue";
    const rankedBadge = g.rankedType && g.rankedType !== "unranked"
      ? `<span class="pf-game-ranked">${esc(g.rankedType)}</span>` : "";
    const totalPlayers = g.totalPlayers != null ? `${g.totalPlayers} joueurs` : "";

    return `
      <div class="pf-game-card ${resultClass}">
        <div class="pf-game-result">${resultLabel}</div>
        <div class="pf-game-info">
          <div class="pf-game-map">${esc(mapName)} ${rankedBadge}</div>
          <div class="pf-game-meta">${esc(modeLabel)}${totalPlayers ? ' · ' + esc(totalPlayers) : ''} · ${duration}</div>
          <div class="pf-game-meta">${formatDateTime(g.start)}</div>
        </div>
        <a class="pf-game-replay" href="https://openfront.io/game/${encodeURIComponent(g.gameId)}" target="_blank" rel="noopener" title="Voir le replay">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>
        </a>
      </div>
    `;
  }).join("");
}

/** Format duration in seconds as M:SS or H:MM:SS */
function formatDuration(seconds) {
  const s = Math.floor(Number(seconds) || 0);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rs = s % 60;
  if (m < 60) return `${m}:${String(rs).padStart(2, "0")}`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return `${h}:${String(rm).padStart(2, "0")}:${String(rs).padStart(2, "0")}`;
}

/** Build a human-readable game mode label from the game object */
function formatGameMode(g) {
  const parts = [];
  if (g.type) parts.push(g.type);
  if (g.mode) parts.push(g.mode === "Free For All" ? "FFA" : g.mode);
  if (g.playerTeams && g.playerTeams !== "null") parts.push(g.playerTeams);
  return parts.join(" · ") || "—";
}

/**
 * Check whether the given clientId is among the winners of the given game.
 * OpenFront `/public/game/{gameId}` returns `info.winner` as
 * `[type, name, ...clientIDs]`.
 */
async function checkGameWin(gameId, clientId) {
  if (!gameId || !clientId) return null;
  const data = await fetchOpenFront(`/public/game/${encodeURIComponent(gameId)}`);
  const winner = data?.info?.winner;
  if (!Array.isArray(winner) || winner.length < 3) return null;
  // winner[0] = "team" | "player", winner[1] = name, winner[2..] = clientIDs
  const winnerIds = winner.slice(2);
  return winnerIds.includes(clientId);
}

/* ── Setup: ownership verification ── */

window.startOwnershipVerification = async () => {
  if (!currentUser) {
    showToast("Veuillez vous connecter d'abord.", "warning");
    return;
  }
  const usernameInput = document.getElementById("setup-username");
  const publicIdInput = document.getElementById("setup-public-id");
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

  // If user already has a different publicId, refuse change
  try {
    if (currentProfile && currentProfile.publicId && currentProfile.publicId !== publicId) {
      showToast("Le Public ID OpenFront ne peut plus être modifié.", "error");
      return;
    }
  } catch (e) { /* non-blocking */ }

  // Verify publicId exists on OpenFront
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
    console.error("[setup] API check failed:", e);
    return;
  }

  // Check that no other user has this publicId already
  try {
    const aliasesRes = await fetch(`${FIRESTORE_BASE}/public-aliases`);
    if (aliasesRes.ok) {
      const aliasesData = await aliasesRes.json();
      const docs = aliasesData.documents || [];
      for (const doc of docs) {
        const f = doc.fields || {};
        const val = (field) => (field?.stringValue || field?.integerValue || "");
        const pid = val(f.publicId);
        const docUid = doc.name?.split("/").pop();
        if (pid === publicId && docUid !== currentUser.uid) {
          showToast("Ce Public ID est déjà lié à un autre compte.", "error");
          return;
        }
      }
    }
  } catch (e) { /* non-blocking */ }

  // Directly save — no challenge code needed, public ID is unique
  await saveUserProfile(username, publicId);
};

window.confirmOwnershipVerification = async () => {
  if (!_ownershipCode || !_ownershipPublicId) return;
  const btn = document.getElementById("confirm-ownership-btn");
  const original = btn?.textContent || "Confirmer";
  if (btn) { btn.disabled = true; btn.textContent = "Vérification…"; }

  try {
    // L'API /public/player/{id} ne renvoie plus `games`. On récupère les
    // parties récentes via l'endpoint dédié /public/player/{id}/games.
    const gamesData = await fetchOpenFront(`/public/player/${encodeURIComponent(_ownershipPublicId)}/games`);
    const games = Array.isArray(gamesData?.results) ? gamesData.results : [];
    let found = games.some((g) => g.username && g.username.includes(_ownershipCode));
    if (!found) {
      showToast("Code non trouvé dans vos parties récentes. Jouez une partie avec le code dans votre pseudo, puis confirmez.", "error", 6000);
      if (btn) { btn.disabled = false; btn.textContent = original; }
      return;
    }
    // Verified → save to Firestore
    await saveUserProfile(_ownershipUsername, _ownershipPublicId);
  } catch (e) {
    console.error("[ownership] Confirmation failed:", e);
    showToast("Erreur lors de la vérification. Réessayez.", "error");
    if (btn) { btn.disabled = false; btn.textContent = original; }
  }
};

window.cancelOwnershipVerification = () => {
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
    const existing = currentProfile || {};
    await setDoc(doc(db, "users", currentUser.uid), {
      username,
      publicId,
      email: currentUser.email || null,
      verified: true,
      verifiedAt: new Date().toISOString(),
      createdAt: existing.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }, { merge: true });

    currentProfile = { ...(currentProfile || {}), username, publicId, verified: true };
    showToast("Profil vérifié et enregistré avec succès !", "success");

    // Publie le lien publicId ↔ username/uid dans une collection publique pour que
    // le matching VIP par PUBLIC ID fonctionne pour tous les viewers (skin suit le
    // public_id, pas l'alias). Best-effort: ignoré silencieusement si règles bloquent.
    try {
      await setDoc(doc(db, "public-aliases", currentUser.uid), {
        username,
        publicId,
        aliases: [username],
        updatedAt: new Date().toISOString(),
      }, { merge: true });
    } catch (bridgeErr) {
      console.warn("[profile] Bridge public-aliases (publicId) write failed (non-critique):", bridgeErr.message);
    }
    try {
      await setDoc(doc(db, "public-rewards", currentUser.uid), {
        publicId,
        username,
      }, { merge: true });
    } catch (rewardsErr) {
      console.warn("[profile] public-rewards publicId merge failed (non-critique):", rewardsErr.message);
    }

    // Reset setup form
    window.cancelOwnershipVerification();
    updateSidebarUI(currentUser, currentProfile);

    // Switch to main view and load stats
    showView("profile-main");
    renderHero(currentUser, currentProfile);
    loadVipForProfile(); // écoute VIP pour appliquer le skin par publicId
    await loadStats(publicId);
  } catch (e) {
    console.error("[profile] Save profile error:", e);
    showToast("Erreur lors de la sauvegarde du profil.", "error");
    throw e;
  }
}

/* ── Sidebar / auth modal handlers ── */

window.toggleAuthModal = function () {
  const modal = document.getElementById("auth-modal");
  if (modal) modal.classList.toggle("active");
};

window.handleLogin = async function (provider) {
  if (window._loginInProgress) return;
  window._loginInProgress = true;
  const authBtns = document.querySelectorAll(".auth-btn");
  authBtns.forEach((b) => { b.disabled = true; b.style.opacity = "0.6"; });
  try {
    if (provider === "google") await window.loginWithGoogle();
    else if (provider === "discord") await window.loginWithDiscord();
    // Close modal on success — onAuthStateChanged will switch view
    const modal = document.getElementById("auth-modal");
    if (modal) modal.classList.remove("active");
  } catch (e) {
    console.error("[profile] Login error:", e);
  } finally {
    window._loginInProgress = false;
    authBtns.forEach((b) => { b.disabled = false; b.style.opacity = ""; });
  }
};

window.handleLogout = async function (event) {
  if (event) event.stopPropagation();
  if (!confirm("Voulez-vous vous déconnecter ?")) return;
  try { await window.logout(); } catch (e) { console.warn("[profile] logout error:", e); }
  currentUser = null;
  currentProfile = null;
  updateSidebarUI(null);
  showView("profile-gate");
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
  // Already on profile page — just close dropdown
  window.closeUserDropdown();
};

// Close dropdown on outside click
document.addEventListener("click", (e) => {
  const c = document.getElementById("user-container");
  if (c && !c.contains(e.target)) c.classList.remove("open");
});

/* ═══ Activity chart + playtime estimation ═══ */



/* ═══ Weekly Performance Chart — Line chart ═══
   Graphique en lignes: semaines sur l'axe X (horizontal), score sur
   l'axe Y gauche, position sur l'axe Y droite (inversé).
   Lignes colorées par mode: FFA=rouge, Team=bleu, Total=noir.
   Points avec cercle contenant le rang (#X). */

function renderWeeklyChart() {
  const data = window._profileWeekData;
  if (!data) return;

  let wrap = document.getElementById("weekly-chart-card");
  if (!wrap) {
    const recent = document.getElementById("profile-recent-games");
    if (!recent) return;
    wrap = document.createElement("div");
    wrap.id = "weekly-chart-card";
    wrap.className = "pf-card";
    wrap.style.marginTop = "16px";
    wrap.innerHTML = `
      <div class="pf-card-header">
        <span class="pf-card-title">Weekly Performance</span>
        <span class="pf-card-sub">Points par semaine</span>
      </div>
      <div class="pf-card-body" style="padding:16px">
        <canvas id="weekly-chart-canvas" style="width:100%;height:320px;display:block"></canvas>
      </div>
    `;
    recent.parentNode.after(wrap);
  }

  const canvas = document.getElementById("weekly-chart-canvas");
  if (!canvas) return;

  const ctx = canvas.getContext("2d");
  const W = canvas.offsetWidth;
  const H = 320;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = W * dpr;
  canvas.height = H * dpr;
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, W, H);

  // ── Data: 1 week for now (Week 1). Will expand as history accumulates. ──
  const weeks = ["Week 1"];
  const rankedScore = data.ffaRanked + data.teamRanked;
  const series = [
    { label: "FFA", color: "#ef4444", points: [{ score: data.ffa, rank: data.rank, detail: { wins: data.ffaCasual } }] },
    { label: "Team", color: "#2196f3", points: [{ score: data.team, rank: data.rank, detail: { wins: data.teamCasual } }] },
    { label: "Class\u00e9", color: "#9333ea", points: [{ score: rankedScore, rank: data.rank, detail: { ffa1v1: data.ffaRanked, team2v2: data.teamRanked } }] },
    { label: "Total", color: "#111827", points: [{ score: data.total, rank: data.rank, detail: { ffa: data.ffa, team: data.team, ranked: rankedScore, allTime: data.allTimePoints } }] },
  ];

  // Store point positions for hover detection
  const pointPositions = [];

  // ── Layout ──
  const padding = { top: 40, right: 30, bottom: 50, left: 55 };
  const chartW = W - padding.left - padding.right;
  const chartH = H - padding.top - padding.bottom;

  // ── Scale ──
  const allScores = series.flatMap(s => s.points.map(p => p.score));
  const maxScore = Math.max(...allScores, 10);
  const niceMax = Math.ceil(maxScore / 5) * 5 || 5;

  // X positions: Week 1 at far left, subsequent weeks spread right
  // For 1 week: place at left + small offset (not centered)
  // For multiple weeks: spread across full width
  const xForIndex = (i) => {
    if (weeks.length === 1) return padding.left + 20;
    return padding.left + (i / (weeks.length - 1)) * chartW;
  };
  const yForScore = (score) => padding.top + chartH - (score / niceMax) * chartH;

  // ── Grid + Y-axis (Score, left) ──
  ctx.fillStyle = "#6b7280";
  ctx.font = "10px Inter, sans-serif";
  ctx.textAlign = "right";
  for (let i = 0; i <= 5; i++) {
    const val = Math.round((niceMax / 5) * i);
    const y = padding.top + chartH - (i / 5) * chartH;
    ctx.fillText(val, padding.left - 8, y + 3);
    ctx.strokeStyle = "#f3f4f6";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(padding.left, y);
    ctx.lineTo(W - padding.right, y);
    ctx.stroke();
  }

  // Y-axis label "Score"
  ctx.save();
  ctx.translate(14, padding.top + chartH / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.textAlign = "center";
  ctx.fillStyle = "#6b7280";
  ctx.font = "11px Inter, sans-serif";
  ctx.fillText("Score", 0, 0);
  ctx.restore();

  // ── X-axis labels (weeks) ──
  ctx.fillStyle = "#6b7280";
  ctx.font = "11px Inter, sans-serif";
  ctx.textAlign = "center";
  weeks.forEach((label, i) => {
    ctx.fillText(label, xForIndex(i), padding.top + chartH + 20);
  });

  // "Week" label centered
  ctx.fillStyle = "#9ca3af";
  ctx.font = "10px Inter, sans-serif";
  ctx.fillText("Week", padding.left + chartW / 2, H - 8);

  // ── Draw lines + points for each series ──
  series.forEach(s => {
    if (s.points.length === 0) return;

    // Line connecting points (only if 2+ weeks)
    if (s.points.length >= 2) {
      ctx.strokeStyle = s.color;
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      s.points.forEach((p, i) => {
        const x = xForIndex(i);
        const y = yForScore(p.score);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.stroke();
    }

    // Points — dots only, except Total which gets a rank circle
    s.points.forEach((p, i) => {
      const x = xForIndex(i);
      const y = yForScore(p.score);

      if (s.label === "Total" && p.rank && p.rank !== "—") {
        // Total point: rank circle with "#X" inside
        const r = 16;
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fillStyle = "#fff";
        ctx.fill();
        ctx.strokeStyle = s.color;
        ctx.lineWidth = 2.5;
        ctx.stroke();

        ctx.fillStyle = "#111827";
        ctx.font = "700 11px Inter, sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText("#" + p.rank, x, y);
        ctx.textBaseline = "alphabetic";

        // Movement arrow (up/down) compared to previous week
        if (i > 0) {
          const prev = s.points[i - 1];
          if (prev.rank && prev.rank !== "—") {
            const prevRank = parseInt(prev.rank);
            const currRank = parseInt(p.rank);
            if (currRank < prevRank) {
              // Better rank (lower number) → green up arrow
              ctx.fillStyle = "#10b981";
              ctx.font = "700 14px Inter, sans-serif";
              ctx.textAlign = "center";
              ctx.fillText("\u2191", x + r + 4, y - 4);
            } else if (currRank > prevRank) {
              // Worse rank (higher number) → red down arrow
              ctx.fillStyle = "#ef4444";
              ctx.font = "700 14px Inter, sans-serif";
              ctx.textAlign = "center";
              ctx.fillText("\u2193", x + r + 4, y - 4);
            }
          }
        }
      } else {
        // Other series: simple filled dot
        ctx.beginPath();
        ctx.arc(x, y, 5, 0, Math.PI * 2);
        ctx.fillStyle = s.color;
        ctx.fill();
        ctx.strokeStyle = "#fff";
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }

      // Store position for hover detection
      pointPositions.push({ x, y, r: s.label === "Total" ? 18 : 12, series: s, point: p, weekIndex: i });
    });
  });

  // ── Legend (top right) ──
  const legendY = 20;
  let legendX = W - padding.right - 180;
  ctx.font = "11px Inter, sans-serif";
  ctx.textAlign = "left";
  series.forEach(s => {
    ctx.beginPath();
    ctx.arc(legendX, legendY - 3, 5, 0, Math.PI * 2);
    ctx.fillStyle = s.color;
    ctx.fill();
    ctx.strokeStyle = "#fff";
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.fillStyle = "#6b7280";
    ctx.fillText(s.label, legendX + 10, legendY);
    legendX += 45;
  });

  // ── Hover tooltip ──
  let tooltip = document.getElementById("weekly-chart-tooltip");
  if (!tooltip) {
    tooltip = document.createElement("div");
    tooltip.id = "weekly-chart-tooltip";
    tooltip.style.cssText = "position:fixed;z-index:1000;display:none;pointer-events:none;background:rgba(26,20,16,0.97);border:1px solid rgba(255,165,80,0.3);border-radius:10px;padding:10px 14px;font-size:12px;color:#ffd9b3;box-shadow:0 8px 24px rgba(0,0,0,0.3);backdrop-filter:blur(12px);max-width:220px;line-height:1.6";
    document.body.appendChild(tooltip);
  }

  // Clone canvas to remove old event listeners
  const newCanvas = canvas.cloneNode(true);
  canvas.parentNode.replaceChild(newCanvas, canvas);
  const ctx2 = newCanvas.getContext("2d");
  ctx2.drawImage(canvas, 0, 0, W, H);

  const hoverHandler = (e) => {
    const rect = newCanvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;

    let found = null;
    for (const pp of pointPositions) {
      const dx = mx - pp.x;
      const dy = my - pp.y;
      if (Math.sqrt(dx * dx + dy * dy) <= pp.r) {
        found = pp;
        break;
      }
    }

    if (found) {
      const d = found.point.detail || {};
      const wk = weeks[found.weekIndex] || "";
      let html = `<div style="font-weight:700;color:#fff;margin-bottom:4px">${found.series.label} \u2014 ${wk}</div>`;
      html += `<div style="color:#9ca3af;font-size:11px;margin-bottom:6px">Score: <span style="color:${found.series.color};font-weight:700">${found.point.score} pts</span></div>`;

      if (found.series.label === "FFA") {
        html += `<div style="font-size:11px;color:#a89480">Wins FFA: ${d.wins || 0}</div>`;
      } else if (found.series.label === "Team") {
        html += `<div style="font-size:11px;color:#a89480">Wins Team: ${d.wins || 0}</div>`;
      } else if (found.series.label === "Class\u00e9") {
        html += `<div style="font-size:11px;color:#a89480">1v1: ${d.ffa1v1 || 0} wins</div>`;
        html += `<div style="font-size:11px;color:#a89480">2v2: ${d.team2v2 || 0} wins</div>`;
      } else if (found.series.label === "Total") {
        html += `<div style="font-size:11px;color:#a89480">FFA: ${d.ffa || 0} pts</div>`;
        html += `<div style="font-size:11px;color:#a89480">Team: ${d.team || 0} pts</div>`;
        html += `<div style="font-size:11px;color:#a89480">Class\u00e9: ${d.ranked || 0} pts</div>`;
        html += `<div style="font-size:11px;color:#a89480">Rang: #${found.point.rank}</div>`;
        html += `<div style="font-size:11px;color:#a89480;margin-top:4px;padding-top:4px;border-top:1px solid rgba(255,255,255,0.1)">All-time: ${d.allTime || 0} pts</div>`;
      }

      tooltip.innerHTML = html;
      tooltip.style.display = "block";

      let tx = e.clientX + 14;
      let ty = e.clientY - 10;
      if (tx > window.innerWidth - 250) tx = e.clientX - 240;
      tooltip.style.left = tx + "px";
      tooltip.style.top = ty + "px";

      newCanvas.style.cursor = "pointer";
    } else {
      tooltip.style.display = "none";
      newCanvas.style.cursor = "default";
    }
  };

  newCanvas.addEventListener("mousemove", hoverHandler);
  newCanvas.addEventListener("mouseleave", () => {
    tooltip.style.display = "none";
    newCanvas.style.cursor = "default";
  });
}
/* ════════════════════════════════════════════════════════════════
   REWARD CODE CARD (skins)
   ════════════════════════════════════════════════════════════════ */

let _rewardCardState = { publicId: null, ownedSkins: [], activeSkinId: null };

function renderRewardCodeCard(publicId) {
  _rewardCardState.publicId = publicId;
  const container = document.getElementById("reward-code-section");
  if (!container) return;

  // Build the card HTML
  container.innerHTML = `
    <div class="reward-code-card">
      <div class="reward-code-header">
        <span class="reward-code-header-icon">
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 12 20 22 4 22 4 12"/><rect x="2" y="7" width="20" height="5"/><line x1="12" y1="22" x2="12" y2="7"/><path d="M12 7H7.5a2.5 2.5 0 0 1 0-5C11 2 12 7 12 7z"/><path d="M12 7h4.5a2.5 2.5 0 0 0 0-5C13 2 12 7 12 7z"/></svg>
        </span>
        <div>
          <h2>Codes de récompense</h2>
          <p>Entre un code pour débloquer un skin (motif de texte coloré sur ton pseudo)</p>
        </div>
      </div>
      <div class="reward-code-body">
        <label for="reward-code-input" style="display:block;font-size:12px;font-weight:600;color:var(--text2);margin-bottom:6px">Code de récompense</label>
        <div class="reward-code-input-row">
          <div class="reward-code-input-wrap">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"/></svg>
            <input type="text" id="reward-code-input" placeholder="EX: GOLD-2025" autocomplete="off" style="text-transform:uppercase">
          </div>
          <button type="button" class="reward-code-btn" id="reward-code-submit" disabled>
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>
            Valider
          </button>
        </div>
        <p class="reward-code-hint">Les codes sont normalisés en majuscules. Un code peut être à usage unique ou limité.</p>
      </div>
      <div class="reward-code-gallery-section">
        <div class="reward-code-gallery-title">
          <h3>Skins possédés (<span id="owned-skins-count">0</span>)</h3>
          <span class="reward-code-gallery-hint">Clique pour activer</span>
        </div>
        <div class="skins-gallery" id="skins-gallery">
          <div style="padding:24px;text-align:center;color:var(--text3);font-size:13px">Chargement…</div>
        </div>
      </div>
    </div>
  `;

  // Wire up the input + button
  const input = document.getElementById("reward-code-input");
  const btn = document.getElementById("reward-code-submit");

  input.addEventListener("input", () => {
    input.value = normalizeCode(input.value);
    btn.disabled = !input.value.trim();
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && input.value.trim()) handleRedeem();
  });
  btn.addEventListener("click", handleRedeem);

  // Load owned skins
  refreshOwnedSkins(publicId);
}

async function refreshOwnedSkins(publicId) {
  const gallery = document.getElementById("skins-gallery");
  const countEl = document.getElementById("owned-skins-count");
  if (!gallery) return;

  try {
    const { ownedSkins, activeSkinId } = await fetchOwnedSkins(publicId);
    _rewardCardState.ownedSkins = ownedSkins;
    _rewardCardState.activeSkinId = activeSkinId;
    if (countEl) countEl.textContent = ownedSkins.filter((s) => s.skinId !== DEFAULT_SKIN_ID).length;
    renderSkinsGallery(ownedSkins, activeSkinId);
  } catch (e) {
    console.warn("[profile] refreshOwnedSkins failed:", e);
    gallery.innerHTML = `<div style="padding:24px;text-align:center;color:var(--text3);font-size:13px">Erreur de chargement</div>`;
  }
}

function renderSkinsGallery(ownedSkins, activeSkinId) {
  const gallery = document.getElementById("skins-gallery");
  if (!gallery) return;

  const ownedIds = new Set(ownedSkins.map((s) => s.skinId));
  const allSkins = [getSkin(DEFAULT_SKIN_ID), ...getUnlockableSkins()];

  gallery.innerHTML = allSkins.map((skin) => {
    const isOwned = skin.id === DEFAULT_SKIN_ID || ownedIds.has(skin.id);
    const isActive = (skin.id === DEFAULT_SKIN_ID && (!activeSkinId || activeSkinId === DEFAULT_SKIN_ID)) || activeSkinId === skin.id;
    const ownedEntry = ownedSkins.find((s) => s.skinId === skin.id);
    const rarity = RARITY_META[skin.rarity];

    if (!isOwned) {
      return `
        <div class="skin-card locked" title="${esc(skin.description)}">
          <svg class="skin-locked-icon" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
          <div class="skin-preview"><span class="${skin.cssClass}" style="opacity:0.3">${esc(skin.name)}</span></div>
          <div class="skin-name">${esc(skin.name)}</div>
          <span class="skin-rarity-badge" style="color:${rarity.color};background:${rarity.bg}">${rarity.label}</span>
          <div style="margin-top:4px;font-size:10px;color:var(--text3)">Verrouillé</div>
        </div>
      `;
    }

    return `
      <button type="button" class="skin-card ${isActive ? 'active' : ''}" data-skin-id="${esc(skin.id)}" title="${esc(skin.description)}">
        ${isActive ? '<span style="position:absolute;top:6px;right:6px;width:18px;height:18px;border-radius:50%;background:var(--orange);color:#fff;display:inline-flex;align-items:center;justify-content:center"><svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg></span>' : ''}
        <div class="skin-preview"><span class="${skin.cssClass}">${esc(skin.name)}</span></div>
        <div class="skin-name">${esc(skin.name)}</div>
        <span class="skin-rarity-badge" style="color:${rarity.color};background:${rarity.bg}">${rarity.label}</span>
        ${ownedEntry && ownedEntry.redeemedAt ? `<span class="skin-redeemed-date">Depuis le ${formatFrenchDate(new Date(ownedEntry.redeemedAt).getTime())}</span>` : ''}
        ${isActive ? '<span class="skin-active-badge">● Actif</span>' : ''}
      </button>
    `;
  }).join("");

  // Wire up activate buttons
  gallery.querySelectorAll(".skin-card[data-skin-id]").forEach((card) => {
    card.addEventListener("click", () => handleActivate(card.dataset.skinId));
  });
}

async function handleRedeem() {
  const input = document.getElementById("reward-code-input");
  const btn = document.getElementById("reward-code-submit");
  if (!input || !input.value.trim()) return;

  const code = input.value.trim();
  const publicId = _rewardCardState.publicId;
  if (!publicId) return;

  btn.disabled = true;
  btn.innerHTML = `<div class="games-loading-spinner" style="width:14px;height:14px"></div> Validation…`;

  try {
    const result = await redeemCode(code, publicId);
    if (result.alreadyOwned) {
      showToast(result.message, "info");
    } else {
      showToast(result.message || `Skin "${result.skinName}" débloqué !`, "success");
    }
    input.value = "";
    await refreshOwnedSkins(publicId);
    // Refresh the hero name skin
    if (currentProfile) renderHero(currentUser, currentProfile);
  } catch (e) {
    showToast(e.message || "Code invalide", "error");
  } finally {
    btn.disabled = false;
    btn.innerHTML = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg> Valider`;
  }
}

async function handleActivate(skinId) {
  const publicId = _rewardCardState.publicId;
  if (!publicId) return;
  try {
    const result = await activateSkin(publicId, skinId);
    _rewardCardState.activeSkinId = result.activeSkinId;
    showToast(skinId === DEFAULT_SKIN_ID ? "Skin standard activé" : `Skin "${getSkin(skinId).name}" activé`, "success");
    renderSkinsGallery(_rewardCardState.ownedSkins, result.activeSkinId);
    // Refresh hero name
    if (currentProfile) renderHero(currentUser, currentProfile);
  } catch (e) {
    showToast(e.message || "Activation impossible", "error");
  }
}

/* ════════════════════════════════════════════════════════════════
   CAREER STATS OVERVIEW + CHARTS
   ════════════════════════════════════════════════════════════════ */

function renderCareerStats(statsTree, publicId) {
  const container = document.getElementById("career-stats-section");
  if (!container) return;

  const careerWins = extractCareerWins(statsTree);
  const totalW = totalWins(careerWins);
  const points = pointsFor(careerWins);

  const ranked1v1 = Number(statsTree.Ranked?.["1v1"]?.wins ?? 0) || 0;
  const ranked1v1Losses = Number(statsTree.Ranked?.["1v1"]?.losses ?? 0) || 0;
  const ranked2v2 = Number(statsTree.Ranked?.["2v2"]?.wins ?? 0) || 0;
  const ranked2v2Losses = Number(statsTree.Ranked?.["2v2"]?.losses ?? 0) || 0;
  const r1Total = ranked1v1 + ranked1v1Losses;
  const r2Total = ranked2v2 + ranked2v2Losses;

  const tiles = [
    { label: "Points", value: formatPoints(points), icon: "⭐", color: "#c25700", bg: "rgba(255,122,0,0.12)" },
    { label: "Wins FFA Casual", value: formatPoints(careerWins.ffaCasual), icon: "⚔️", color: "#ff7a00", bg: "rgba(255,122,0,0.12)" },
    { label: "Wins Team Casual", value: formatPoints(careerWins.teamCasual), icon: "🛡️", color: "#10b981", bg: "rgba(16,185,129,0.12)" },
    { label: "Wins Classé 1v1", value: formatPoints(ranked1v1), sub: r1Total > 0 ? `${formatPct(ranked1v1 / r1Total)} (${r1Total} games)` : "—", icon: "🏆", color: "#d97706", bg: "rgba(217,119,6,0.12)" },
    { label: "Wins Classé 2v2", value: formatPoints(ranked2v2), sub: r2Total > 0 ? `${formatPct(ranked2v2 / r2Total)} (${r2Total} games)` : "—", icon: "🎖️", color: "#a855f7", bg: "rgba(168,85,247,0.12)" },
  ];

  container.innerHTML = `
    <div class="stats-section">
      <div class="stats-section-title">
        <span class="stats-section-title-icon">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg>
        </span>
        <div>
          <h2>Statistiques générales</h2>
          <p>Vue d'ensemble de la carrière</p>
        </div>
      </div>
      <div class="stats-grid">
        ${tiles.map((t) => `
          <div class="stat-tile">
            <div class="stat-tile-header">
              <span class="stat-tile-icon" style="background:${t.bg};color:${t.color}">${t.icon}</span>
              <span class="stat-tile-label">${esc(t.label)}</span>
            </div>
            <div class="stat-tile-value">${t.value}</div>
            ${t.sub ? `<div class="stat-tile-sub">${t.sub}</div>` : ''}
          </div>
        `).join("")}
      </div>
    </div>
    <div class="charts-grid">
      <div class="chart-card">
        <h3>Répartition des wins</h3>
        <p>Par catégorie</p>
        <div id="wins-chart"></div>
      </div>
    </div>
    <div id="playtime-section-mount"></div>
    <div id="activity-section-mount"></div>
    <div id="map-stats-section-mount"></div>
    <div id="achievements-section-mount"></div>
    <div id="recent-games-full-section-mount"></div>
  `;

  // Render wins chart (simple CSS bars)
  renderWinsChart(careerWins);
}

function renderWinsChart(careerWins) {
  const el = document.getElementById("wins-chart");
  if (!el) return;

  const data = [
    { name: "FFA Casual", value: careerWins.ffaCasual, color: "#ff7a00" },
    { name: "Team Casual", value: careerWins.teamCasual, color: "#10b981" },
    { name: "1v1 Classé", value: careerWins.ffaRanked, color: "#d97706" },
    { name: "2v2 Classé", value: careerWins.teamRanked, color: "#a855f7" },
  ].filter((d) => d.value > 0);

  if (data.length === 0) {
    el.innerHTML = `<div style="height:120px;display:flex;align-items:center;justify-content:center;color:var(--text3);font-size:13px">Aucune win enregistrée</div>`;
    return;
  }

  const max = Math.max(...data.map((d) => d.value), 1);
  const total = data.reduce((s, d) => s + d.value, 0);

  el.innerHTML = `
    <div style="display:flex;flex-direction:column;gap:8px">
      ${data.map((d) => `
        <div>
          <div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:3px">
            <span style="color:var(--text2)">${esc(d.name)}</span>
            <span style="font-weight:600;font-family:var(--mono,monospace)">${d.value} (${formatPct(d.value / total)})</span>
          </div>
          <div style="height:8px;background:var(--border,#F3F4F6);border-radius:999px;overflow:hidden">
            <div style="height:100%;width:${(d.value / max) * 100}%;background:${d.color};border-radius:999px;transition:width 0.3s"></div>
          </div>
        </div>
      `).join("")}
    </div>
  `;
}

/* ════════════════════════════════════════════════════════════════
   ALL GAMES PAGINATION (for playtime + map stats)
   ════════════════════════════════════════════════════════════════ */

async function loadAllGamesForStats(publicId) {
  if (_allGamesLoading) return;
  _allGamesLoading = true;

  const mount = document.getElementById("playtime-section-mount");
  const CACHE_KEY = `tfs_games_v1_${publicId}`;
  const CACHE_TTL = 60 * 60 * 1000; // 1 hour

  // 0. Try the SYNCED player-data file first — instant for synced players!
  //    This file is maintained by sync-player-games.js (GitHub Actions, continuous loop).
  //    It contains ALL games for the player, refreshed every few minutes.
  try {
    const syncRes = await fetch(`player-data/${encodeURIComponent(publicId)}.json`, { cache: "no-store" });
    if (syncRes.ok) {
      const syncData = await syncRes.json();
      if (syncData && Array.isArray(syncData.games) && syncData.games.length > 0) {
        _allGamesCache = syncData.games;
        if (mount) mount.innerHTML = "";
        renderPlaytimeStats(syncData.games);
        renderActivityStats(syncData.games);
        renderMapStatsTable(syncData.games);
        renderAchievements(syncData.games);
        renderRecentGamesFull(syncData.games);
        // Show a small "synced data" badge
        if (mount) {
          const badge = document.createElement("div");
          badge.style.cssText = "padding:8px 12px;background:rgba(16,185,129,0.08);border:1px solid rgba(16,185,129,0.2);border-radius:8px;font-size:11px;color:#10b981;margin-bottom:12px;display:flex;align-items:center;gap:6px";
          const syncedDate = syncData.lastSyncedAt ? new Date(syncData.lastSyncedAt) : null;
          const syncedStr = syncedDate ? syncedDate.toLocaleString("fr-FR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : "récemment";
          badge.innerHTML = `<span>✓</span> Données synchronisées (${syncData.totalGames} parties · MAJ ${syncedStr})`;
          mount.insertBefore(badge, mount.firstChild);
        }
        _allGamesLoading = false;
        return;
      }
    }
  } catch (e) {
    console.warn("[profile] Could not load synced player-data file:", e.message);
  }

  // 1. Check localStorage cache first — instant for returning visitors
  try {
    const cached = localStorage.getItem(CACHE_KEY);
    if (cached) {
      const parsed = JSON.parse(cached);
      if (parsed && parsed.fetchedAt && Date.now() - parsed.fetchedAt < CACHE_TTL && Array.isArray(parsed.games)) {
        _allGamesCache = parsed.games;
        if (mount) mount.innerHTML = "";
        renderPlaytimeStats(parsed.games);
        renderActivityStats(parsed.games);
        renderMapStatsTable(parsed.games);
        renderAchievements(parsed.games);
        renderRecentGamesFull(parsed.games);
        _allGamesLoading = false;
        return;
      }
    }
  } catch { /* ignore cache read errors */ }

  // 2. Show skeleton loading with skip button
  if (mount) {
    mount.innerHTML = `
      <div class="games-loading-banner">
        <div class="games-loading-spinner"></div>
        <div style="flex:1">
          <div class="games-loading-text">Chargement du temps de jeu et des stats…</div>
          <div class="games-loading-sub" id="games-load-count">0 parties chargées</div>
        </div>
        <button id="games-skip-btn" style="padding:6px 12px;background:transparent;border:1px solid var(--border,#E5E7EB);border-radius:6px;font-size:11px;font-weight:600;color:var(--text2,#6B7280);cursor:pointer;font-family:var(--f,inherit)">Skip</button>
      </div>
    `;
    const skipBtn = document.getElementById("games-skip-btn");
    if (skipBtn) {
      skipBtn.addEventListener("click", () => {
        _allGamesLoading = false;
        if (mount) mount.innerHTML = `<div style="padding:14px;background:var(--bg,#FAFAFA);border:1px solid var(--border,#F3F4F6);border-radius:10px;font-size:13px;color:var(--text3,#9CA3AF);text-align:center">Stats détaillées ignorées. Recharge la page pour réessayer.</div>`;
      });
    }
  }

  try {
    const allGames = [];
    let cursor = null;
    // Cap at 30 pages = 300 games (plenty for stats, 17x faster than 500 pages)
    const MAX_PAGES = 30;
    let lastRenderAt = 0;

    for (let page = 0; page < MAX_PAGES; page++) {
      let path = `/public/player/${encodeURIComponent(publicId)}/games`;
      if (cursor) path += `?cursor=${encodeURIComponent(cursor)}`;
      let data;
      try {
        data = await fetchOpenFront(path);
      } catch (e) {
        console.warn(`[profile] games page ${page} failed:`, e.message);
        break;
      }
      const results = data?.results || [];
      if (results.length === 0) break;
      for (const g of results) allGames.push(g);
      const countEl = document.getElementById("games-load-count");
      if (countEl) countEl.textContent = `${allGames.length} parties chargées${page >= MAX_PAGES - 1 ? " (limite)" : ""}`;
      if (!data.nextCursor) break;
      cursor = data.nextCursor;

      // Incremental render every 5 pages — user sees progress
      if (page > 0 && page % 5 === 0 && Date.now() - lastRenderAt > 1000) {
        renderPlaytimeStats(allGames);
        renderActivityStats(allGames);
        renderMapStatsTable(allGames);
        renderAchievements(allGames);
        renderRecentGamesFull(allGames);
        lastRenderAt = Date.now();
      }
    }
    _allGamesCache = allGames;
    // Save to cache
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify({ games: allGames, fetchedAt: Date.now() }));
    } catch { /* quota exceeded */ }
    // Hide loading banner
    if (mount) mount.innerHTML = "";
    // Final render of all stats sections
    renderPlaytimeStats(allGames);
    renderActivityStats(allGames);
    renderMapStatsTable(allGames);
    renderAchievements(allGames);
    renderRecentGamesFull(allGames);
  } catch (e) {
    console.error("[profile] loadAllGamesForStats error:", e);
    if (mount) mount.innerHTML = `<div class="pf-error-banner">Erreur: ${esc(e.message)}</div>`;
  } finally {
    _allGamesLoading = false;
  }
}

/* ════════════════════════════════════════════════════════════════
   PLAYTIME STATS
   ════════════════════════════════════════════════════════════════ */

function renderPlaytimeStats(games) {
  const mount = document.getElementById("playtime-section-mount");
  if (!mount) return;
  if (games.length === 0) {
    mount.innerHTML = "";
    return;
  }

  const pt = computePlaytimeStats(games);
  const v = pt.byVisibility;
  const totalVis = v.public + v.private + v.singleplayer || 1;
  const cat = pt.byCategory;

  const visData = [
    { name: "Publiques", value: v.public, color: "#ff7a00" },
    { name: "Privées", value: v.private, color: "#a855f7" },
    { name: "Solo", value: v.singleplayer, color: "#3b82f6" },
  ].filter((d) => d.value > 0);

  const playtimeByCat = [
    { name: "FFA Casual", sec: cat.ffaCasual.playtimeSec, games: cat.ffaCasual.games, color: "#ff7a00" },
    { name: "FFA Classé", sec: cat.ffaRanked.playtimeSec, games: cat.ffaRanked.games, color: "#d97706" },
    { name: "Team Casual", sec: cat.teamCasual.playtimeSec, games: cat.teamCasual.games, color: "#10b981" },
    { name: "Team Classé", sec: cat.teamRanked.playtimeSec, games: cat.teamRanked.games, color: "#a855f7" },
  ];

  mount.innerHTML = `
    <div class="stats-section">
      <div class="stats-section-title">
        <span class="stats-section-title-icon">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
        </span>
        <div>
          <h2>Temps de jeu</h2>
          <p>Toutes parties confondues (publiques, privées, solo)</p>
        </div>
      </div>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:14px">
        <div class="playtime-hero">
          <div class="playtime-hero-label">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
            Temps de jeu total
          </div>
          <div class="playtime-hero-value">${formatDuration(pt.totalPlaytimeSec)}</div>
          <div class="playtime-hero-sub">${pt.totalGames} parties · moyenne ${formatDuration(pt.avgGameDurationSec)} / partie</div>
        </div>
        <div class="chart-card">
          <h3>Répartition par visibilité</h3>
          <p>${pt.totalGames} parties au total</p>
          <div style="display:flex;flex-direction:column;gap:8px;margin-top:8px">
            ${visData.map((d) => `
              <div>
                <div class="playtime-breakdown-label">
                  <span>${esc(d.name)}</span>
                  <span>${d.value} (${formatPct(d.value / totalVis)})</span>
                </div>
                <div class="playtime-breakdown-bar">
                  <div class="playtime-breakdown-fill" style="width:${(d.value / totalVis) * 100}%;background:${d.color}"></div>
                </div>
              </div>
            `).join("")}
          </div>
        </div>
        <div class="chart-card">
          <h3>Temps par catégorie</h3>
          <p>Heures jouées par mode</p>
          <div style="display:flex;flex-direction:column;gap:10px;margin-top:8px">
            ${playtimeByCat.map((c) => `
              <div>
                <div class="playtime-breakdown-label">
                  <span>${esc(c.name)}</span>
                  <span>${c.sec > 0 ? formatDurationCompact(c.sec) : "—"}</span>
                </div>
                <div class="playtime-breakdown-bar">
                  <div class="playtime-breakdown-fill" style="width:${pt.totalPlaytimeSec > 0 ? (c.sec / pt.totalPlaytimeSec) * 100 : 0}%;background:${c.color}"></div>
                </div>
                <div class="playtime-breakdown-sub">${c.games} parties</div>
              </div>
            `).join("")}
          </div>
        </div>
      </div>
      <div class="stats-grid" style="margin-top:14px">
        <div class="stat-tile">
          <div class="stat-tile-header"><span class="stat-tile-icon" style="background:rgba(59,130,246,0.12);color:#3b82f6">⏱️</span><span class="stat-tile-label">Durée moyenne</span></div>
          <div class="stat-tile-value">${formatDuration(pt.avgGameDurationSec)}</div>
        </div>
        <div class="stat-tile">
          <div class="stat-tile-header"><span class="stat-tile-icon" style="background:rgba(239,68,68,0.12);color:#ef4444">📈</span><span class="stat-tile-label">Partie la plus longue</span></div>
          <div class="stat-tile-value">${formatDuration(pt.longestGameSec)}</div>
        </div>
        <div class="stat-tile">
          <div class="stat-tile-header"><span class="stat-tile-icon" style="background:rgba(16,185,129,0.12);color:#10b981">🎯</span><span class="stat-tile-label">Winrate global</span></div>
          <div class="stat-tile-value">${formatPct(pt.results.victory / Math.max(1, pt.results.victory + pt.results.defeat))}</div>
          <div class="stat-tile-sub">${pt.results.victory}V / ${pt.results.defeat}D / ${pt.results.incomplete} incomplètes</div>
        </div>
      </div>
    </div>
  `;
}

/* ════════════════════════════════════════════════════════════════
   ACTIVITY STATS (heatmap + by hour + by weekday)
   ════════════════════════════════════════════════════════════════ */

function renderActivityStats(games) {
  const mount = document.getElementById("activity-section-mount");
  if (!mount || games.length === 0) { if (mount) mount.innerHTML = ""; return; }

  const pt = computePlaytimeStats(games);

  // Build 90-day heatmap
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const days = [];
  for (let i = 90; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const key = new Intl.DateTimeFormat("fr-FR", {
      timeZone: "Europe/Paris", day: "2-digit", month: "2-digit", year: "numeric",
    }).format(d);
    const entry = pt.byDay.find((b) => b.date === key);
    days.push({ date: d, count: entry?.count ?? 0, playtimeSec: entry?.playtimeSec ?? 0 });
  }
  const maxCount = Math.max(...days.map((d) => d.count), 1);
  const totalGames = days.reduce((s, d) => s + d.count, 0);
  const activeDays = days.filter((d) => d.count > 0).length;

  const colorFor = (count) => {
    if (count === 0) return "var(--border, #F3F4F6)";
    const ratio = count / maxCount;
    if (ratio < 0.25) return "#ffe8d1";
    if (ratio < 0.5) return "#ffc88a";
    if (ratio < 0.75) return "#ffa14d";
    return "#ff7a00";
  };

  // Group into weeks
  const weeks = [];
  for (let i = 0; i < days.length; i += 7) weeks.push(days.slice(i, i + 7));

  // By hour bars
  const maxHour = Math.max(...pt.byHour, 1);
  const peakHour = pt.byHour.indexOf(maxHour);
  const hourBars = pt.byHour.map((count, hour) => {
    const h = Math.max(1, (count / maxHour) * 100);
    return `<div class="activity-bar-row" title="${hour}h — ${count} parties">
      <div class="activity-bars-row" style="height:80px;align-items:flex-end">
        <div class="activity-bar" style="height:${h}%;width:100%"></div>
      </div>
      <div class="activity-bar-label">${hour % 3 === 0 ? hour + 'h' : ''}</div>
    </div>`;
  }).join("");

  // By weekday bars
  const wdLabels = ["Lun", "Mar", "Mer", "Jeu", "Ven", "Sam", "Dim"];
  const maxWd = Math.max(...pt.byWeekday, 1);
  const peakDay = wdLabels[pt.byWeekday.indexOf(maxWd)];
  const wdBars = pt.byWeekday.map((count, i) => {
    const h = Math.max(1, (count / maxWd) * 100);
    return `<div class="activity-bar-row" title="${wdLabels[i]} — ${count} parties">
      <div class="activity-bars-row" style="height:80px;align-items:flex-end">
        <div class="activity-bar" style="height:${h}%;width:100%;background:#10b981"></div>
      </div>
      <div class="activity-bar-label">${wdLabels[i]}</div>
    </div>`;
  }).join("");

  mount.innerHTML = `
    <div class="stats-section">
      <div class="stats-section-title">
        <span class="stats-section-title-icon">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>
        </span>
        <div>
          <h2>Activité</h2>
          <p>Quand le joueur joue le plus</p>
        </div>
      </div>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:14px;margin-bottom:14px">
        <div class="activity-chart-card">
          <h3 class="activity-chart-title">Activité par heure</h3>
          <p class="activity-chart-subtitle">Heure de Paris</p>
          <div class="activity-bars">${hourBars}</div>
          <p class="activity-chart-footer">Heure de pointe: <strong>${peakHour}h</strong> (${maxHour} parties)</p>
        </div>
        <div class="activity-chart-card">
          <h3 class="activity-chart-title">Activité par jour</h3>
          <p class="activity-chart-subtitle">Répartition par jour de la semaine</p>
          <div class="activity-bars">${wdBars}</div>
          <p class="activity-chart-footer">Jour préféré: <strong>${peakDay}</strong> (${maxWd} parties)</p>
        </div>
      </div>
      <div class="activity-heatmap-wrap">
        <div class="activity-heatmap-header">
          <div>
            <h3 class="activity-heatmap-title">90 derniers jours</h3>
            <p class="activity-heatmap-subtitle">${totalGames} parties sur ${activeDays} jours actifs</p>
          </div>
          <div class="activity-heatmap-legend">
            <span>Moins</span>
            ${["#F3F4F6", "#ffe8d1", "#ffc88a", "#ffa14d", "#ff7a00"].map((c) => `<span class="activity-heatmap-legend-cell" style="background:${c}"></span>`).join("")}
            <span>Plus</span>
          </div>
        </div>
        <div class="activity-heatmap-grid">
          ${weeks.map((week) => `
            <div class="activity-heatmap-week">
              ${week.map((day) => {
                const dateStr = day.date.toLocaleDateString("fr-FR");
                const title = `${dateStr} — ${day.count} parties · ${formatDurationCompact(day.playtimeSec)}`;
                return `<div class="activity-heatmap-day" title="${title}" style="background:${colorFor(day.count)}"></div>`;
              }).join("")}
            </div>
          `).join("")}
        </div>
      </div>
    </div>
  `;
}

/* ════════════════════════════════════════════════════════════════
   MAP STATS TABLE
   ════════════════════════════════════════════════════════════════ */

let _mapStatsSortBy = "count";
let _mapStatsShowAll = false;

function renderMapStatsTable(games) {
  const mount = document.getElementById("map-stats-section-mount");
  if (!mount || games.length === 0) { if (mount) mount.innerHTML = ""; return; }

  const pt = computePlaytimeStats(games);
  if (pt.byMap.length === 0) { mount.innerHTML = ""; return; }

  mount.innerHTML = `
    <div class="stats-section">
      <div class="stats-section-title">
        <span class="stats-section-title-icon">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="1 6 1 22 8 18 16 22 23 18 23 2 16 6 8 2 1 6"/><line x1="8" y1="2" x2="8" y2="18"/><line x1="16" y1="6" x2="16" y2="22"/></svg>
        </span>
        <div>
          <h2>Statistiques par carte</h2>
          <p>${pt.byMap.length} cartes jouées · triées par nombre de parties</p>
        </div>
      </div>
      <div class="map-stats-table-wrap">
        <div class="map-stats-sort-row">
          <span class="map-stats-sort-label">Trier par:</span>
          ${[
            { key: "count", label: "Parties" },
            { key: "winRate", label: "Winrate" },
            { key: "avgDuration", label: "Durée moy." },
            { key: "playtimeSec", label: "Temps total" },
          ].map((s) => `<button class="map-stats-sort-btn ${_mapStatsSortBy === s.key ? 'active' : ''}" data-sort="${s.key}">${s.label}</button>`).join("")}
        </div>
        <div class="map-stats-table-scroll">
          <table class="map-stats-table" id="map-stats-table-inner">
          </table>
        </div>
        <div class="map-stats-show-more" id="map-stats-show-more"></div>
      </div>
    </div>
  `;

  // Wire sort buttons
  mount.querySelectorAll(".map-stats-sort-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      _mapStatsSortBy = btn.dataset.sort;
      _mapStatsShowAll = false;
      renderMapStatsTable(games);
    });
  });

  // Render table rows
  const tableEl = document.getElementById("map-stats-table-inner");
  if (!tableEl) return;

  const sorted = [...pt.byMap].sort((a, b) => {
    if (_mapStatsSortBy === "count") return b.count - a.count;
    if (_mapStatsSortBy === "winRate") return b.winRate - a.winRate;
    if (_mapStatsSortBy === "avgDuration") return b.avgDuration - a.avgDuration;
    return b.playtimeSec - a.playtimeSec;
  });
  const displayed = _mapStatsShowAll ? sorted : sorted.slice(0, 10);

  tableEl.innerHTML = `
    <thead>
      <tr>
        <th>Carte</th>
        <th style="text-align:right">Parties</th>
        <th style="text-align:right">V</th>
        <th style="text-align:right">D</th>
        <th style="text-align:right">Winrate</th>
        <th style="text-align:right">Durée moy.</th>
        <th style="text-align:right">Temps total</th>
        <th style="text-align:right">Dernière</th>
      </tr>
    </thead>
    <tbody>
      ${displayed.map((m) => {
        const wrColor = m.winRate >= 0.6 ? "#10b981" : m.winRate >= 0.4 ? "#d97706" : "#ef4444";
        return `
          <tr>
            <td class="map-name">${esc(m.map)}</td>
            <td class="num">${m.count}</td>
            <td class="num" style="color:#10b981">${m.wins}</td>
            <td class="num" style="color:#ef4444">${m.losses}</td>
            <td class="num" style="color:${wrColor};font-weight:700">${formatPct(m.winRate)}</td>
            <td class="num">${m.avgDuration > 0 ? formatDurationCompact(m.avgDuration) : "—"}</td>
            <td class="num">${m.playtimeSec > 0 ? formatDurationCompact(m.playtimeSec) : "—"}</td>
            <td class="num" style="font-size:11px;color:var(--text3)">${m.lastPlayed > 0 ? new Intl.DateTimeFormat("fr-FR",{day:"2-digit",month:"2-digit",year:"2-digit"}).format(new Date(m.lastPlayed)) : "—"}</td>
          </tr>
        `;
      }).join("")}
    </tbody>
  `;

  // Show more button
  const showMoreEl = document.getElementById("map-stats-show-more");
  if (showMoreEl && sorted.length > 10) {
    showMoreEl.innerHTML = `<button id="map-stats-toggle">${_mapStatsShowAll ? "Voir moins" : `Voir les ${sorted.length} cartes`}</button>`;
    const toggleBtn = showMoreEl.querySelector("button");
    if (toggleBtn) {
      toggleBtn.addEventListener("click", () => {
        _mapStatsShowAll = !_mapStatsShowAll;
        renderMapStatsTable(games);
      });
    }
  }
}

/* ════════════════════════════════════════════════════════════════
   ACHIEVEMENTS + STREAKS
   ════════════════════════════════════════════════════════════════ */

function renderAchievements(games) {
  const mount = document.getElementById("achievements-section-mount");
  if (!mount || games.length === 0) { if (mount) mount.innerHTML = ""; return; }

  const pt = computePlaytimeStats(games);
  // Career wins from games (approximation — better to use the aggregated stats)
  const careerWins = { ffaCasual: 0, ffaRanked: 0, teamCasual: 0, teamRanked: 0 };
  for (const g of games) {
    if (g.result !== "victory") continue;
    const cat = classifyGame(g);
    careerWins[cat]++;
  }
  const totalW = totalWins(careerWins);
  const distinctMaps = pt.byMap.length;
  const activeDays = pt.byDay.filter((d) => d.count > 0).length;
  const playtimeHours = pt.totalPlaytimeSec / 3600;

  const achievements = [
    { id: "first-win", name: "Première victoire", desc: "Remporte ta 1ère partie", icon: "🏆", unlocked: totalW >= 1 },
    { id: "ten-wins", name: "Décathlon", desc: "Remporte 10 parties", icon: "⭐", unlocked: totalW >= 10, progress: totalW >= 10 ? null : { current: totalW, target: 10 } },
    { id: "hundred-wins", name: "Centurion", desc: "Remporte 100 parties", icon: "🎖️", unlocked: totalW >= 100, progress: totalW >= 100 ? null : { current: totalW, target: 100 } },
    { id: "marathon", name: "Marathonien", desc: "Joue plus de 24h au total", icon: "⏱️", unlocked: playtimeHours >= 24, progress: playtimeHours >= 24 ? null : { current: Math.floor(playtimeHours), target: 24 } },
    { id: "weekend", name: "Assidu", desc: "Joue 7 jours différents", icon: "📅", unlocked: activeDays >= 7, progress: activeDays >= 7 ? null : { current: activeDays, target: 7 } },
    { id: "cartographer", name: "Cartographe", desc: "Joue 10 cartes différentes", icon: "🗺️", unlocked: distinctMaps >= 10, progress: distinctMaps >= 10 ? null : { current: distinctMaps, target: 10 } },
    { id: "streak5", name: "En feu", desc: "Fais une série de 5 victoires", icon: "🔥", unlocked: pt.bestStreak >= 5, progress: pt.bestStreak >= 5 ? null : { current: pt.bestStreak, target: 5 } },
    { id: "streak10", name: "Intouchable", desc: "Fais une série de 10 victoires", icon: "⚡", unlocked: pt.bestStreak >= 10, progress: pt.bestStreak >= 10 ? null : { current: pt.bestStreak, target: 10 } },
    { id: "polyvalent", name: "Polyvalent", desc: "Gagne dans les 4 catégories", icon: "🎖️", unlocked: careerWins.ffaCasual > 0 && careerWins.ffaRanked > 0 && careerWins.teamCasual > 0 && careerWins.teamRanked > 0 },
    { id: "night-owl", name: "Oiseau de nuit", desc: "Joue après minuit (0h-4h)", icon: "🌙", unlocked: pt.byHour.slice(0, 4).some((c) => c > 0) },
  ];

  const unlockedCount = achievements.filter((a) => a.unlocked).length;

  mount.innerHTML = `
    <div class="stats-section">
      <div class="stats-section-title">
        <span class="stats-section-title-icon">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="7"/><polyline points="8.21 13.89 7 23 12 20 17 23 15.79 13.88"/></svg>
        </span>
        <div>
          <h2>Succès & séries</h2>
          <p>Récompenses débloquées et séries de victoires</p>
        </div>
      </div>
      <div class="streak-cards">
        <div class="streak-card ${pt.currentStreak > 0 ? 'active' : ''}">
          <div style="font-size:22px;margin-bottom:4px">🔥</div>
          <div class="streak-card-value">${pt.currentStreak}</div>
          <div class="streak-card-label">Série actuelle</div>
        </div>
        <div class="streak-card">
          <div style="font-size:22px;margin-bottom:4px">🏆</div>
          <div class="streak-card-value" style="color:#d97706">${pt.bestStreak}</div>
          <div class="streak-card-label">Meilleure série</div>
        </div>
      </div>
      <div class="chart-card">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px">
          <h3 style="margin:0;font-size:14px;font-weight:700">Succès</h3>
          <span style="font-size:12px;color:var(--text3)">${unlockedCount}/${achievements.length} débloqués</span>
        </div>
        <div class="achievements-grid">
          ${achievements.map((a) => `
            <div class="achievement-card ${a.unlocked ? 'unlocked' : ''}">
              ${a.unlocked ? `<div class="achievement-icon">${a.icon}</div>` : `<div class="achievement-icon"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg></div>`}
              <div class="achievement-name">${esc(a.name)}</div>
              <div class="achievement-desc">${esc(a.desc)}</div>
              ${a.progress && !a.unlocked ? `<div class="achievement-progress">${a.progress.current}/${a.progress.target}</div>` : ''}
            </div>
          `).join("")}
        </div>
      </div>
    </div>
  `;
}

/* ════════════════════════════════════════════════════════════════
   RECENT GAMES FULL LIST (20 most recent)
   ════════════════════════════════════════════════════════════════ */

function renderRecentGamesFull(games) {
  const mount = document.getElementById("recent-games-full-section-mount");
  if (!mount || games.length === 0) { if (mount) mount.innerHTML = ""; return; }

  const sorted = [...games]
    .filter((g) => g.start)
    .sort((a, b) => new Date(b.start).getTime() - new Date(a.start).getTime())
    .slice(0, 20);

  const catLabels = {
    ffaCasual: "FFA Casual",
    ffaRanked: "FFA Classé",
    teamCasual: "Team Casual",
    teamRanked: "Team Classé",
  };

  mount.innerHTML = `
    <div class="stats-section">
      <div class="stats-section-title">
        <span class="stats-section-title-icon">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="6" width="20" height="12" rx="2"/><line x1="6" y1="12" x2="10" y2="12"/><line x1="8" y1="10" x2="8" y2="14"/><circle cx="15" cy="11" r="1"/><circle cx="18" cy="13" r="1"/></svg>
        </span>
        <div>
          <h2>Parties récentes</h2>
          <p>${games.length} parties au total · 20 plus récentes</p>
        </div>
      </div>
      <div class="recent-games-list">
        ${sorted.map((g) => {
          const cat = classifyGame(g);
          const resultColor = g.result === "victory" ? "#10b981" : g.result === "defeat" ? "#ef4444" : g.result === "incomplete" ? "#6B7280" : "#9CA3AF";
          const resultLabel = g.result === "victory" ? "Victoire" : g.result === "defeat" ? "Défaite" : g.result === "incomplete" ? "Incomplet" : (g.result || "—");
          const dur = g.durationSeconds || g.duration;
          return `
            <div class="recent-game-row">
              <span class="recent-game-dot" style="background:${resultColor}"></span>
              <div class="recent-game-info">
                <div class="recent-game-map">${esc(g.map || "Carte inconnue")}</div>
                <div class="recent-game-meta">${catLabels[cat] || g.mode || "—"} · ${g.totalPlayers || "?"} joueurs</div>
              </div>
              <div style="text-align:right;flex-shrink:0">
                <div class="recent-game-result" style="color:${resultColor}">${resultLabel}</div>
                <div class="recent-game-date">${g.start ? formatFrenchDate(new Date(g.start).getTime()) : "—"}${dur ? ` · ${formatDurationCompact(Number(dur) || 0)}` : ""}</div>
              </div>
            </div>
          `;
        }).join("")}
      </div>
    </div>
  `;
}

/* ════════════════════════════════════════════════════════════════
   FALLBACK: si onAuthStateChanged ne se déclenche pas (Firebase CDN
   bloqué ou lent), force le rendu du profil public après 8s.
   ════════════════════════════════════════════════════════════════ */
setTimeout(() => {
  const loading = document.getElementById("profile-loading");
  if (loading && loading.classList.contains("is-active")) {
    const pubReq = getPublicProfileRequest();
    if (pubReq) {
      console.warn("[profile] Auth state timeout — forcing public profile render");
      currentUser = null;
      currentProfile = null;
      updateSidebarUI(null);
      viewingPublicId = pubReq.publicId;
      viewingUsername = pubReq.username;
      showView("profile-main");
      renderPublicProfile(pubReq.username, pubReq.publicId);
      loadVipForProfile();
      loadStats(pubReq.publicId);
    } else {
      console.warn("[profile] Auth state timeout — showing gate");
      showView("profile-gate");
    }
  }
}, 8000);
