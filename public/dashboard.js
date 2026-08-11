/**
 * dashboard.js — Contrôleur du Tableau de bord.
 *
 * Classement par points des parties OpenFront :
 *   - FFA (1v1 ranked) : chaque victoire = +10 points
 *   - Team (2v2 ranked) : chaque victoire = +5 points
 *
 * Source : ranked.json (leaderboards 1v1 + 2v2 avec wins/losses/total par joueur).
 * Deux vues : Global (cumul) + Cette semaine (progression ELO sur 7 jours,
 *   issue de ranked_history.json.gz).
 */

const FFA_POINTS_PER_WIN = 10;
const TEAM_POINTS_PER_WIN = 5;

const view = document.getElementById("dashboard-view");
const lastUpdateEl = document.getElementById("last-update");

let _ranked = null; // { '1v1': [...], '2v2': [...], updatedAt, totalPlayers1v1, totalPlayers2v2 }
let _history1v1 = null; // { publicId: [{t, elo, rank}, ...] }
let _history2v2 = null;
let _dashMode = "overall"; // "overall" | "weekly"

/* ════════════════════════════════════════════════════════════════
   Helpers
   ════════════════════════════════════════════════════════════════ */

function escapeHtml(s) {
  if (s == null) return "";
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatPoints(n) {
  return new Intl.NumberFormat("fr-FR").format(n);
}

function initials(name) {
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
  return `<span class="dash-avatar dash-avatar-${size}">${escapeHtml(initials(name))}</span>`;
}

/* ════════════════════════════════════════════════════════════════
   Chargement des données
   ════════════════════════════════════════════════════════════════ */

// Charge un fichier .json.gz en le décompressant côté navigateur.
async function loadGzJson(url) {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) return null;
  try {
    const ds = new DecompressionStream("gzip");
    const decompressed = res.body.pipeThrough(ds);
    return await new Response(decompressed).json();
  } catch (e) {
    console.warn(`[dashboard] decompression failed for ${url}:`, e);
    return null;
  }
}

async function loadData() {
  // ranked.json (plaintext, à la racine)
  const res = await fetch("ranked.json", { cache: "no-store" });
  if (!res.ok) throw new Error("Impossible de charger ranked.json");
  _ranked = await res.json();

  // ranked_history pour la vue hebdomadaire (ELO delta sur 7 jours)
  try {
    const [h1, h2] = await Promise.all([
      loadGzJson("ranked_history.json.gz"),
      loadGzJson("ranked_2v2_history.json.gz"),
    ]);
    _history1v1 = h1;
    _history2v2 = h2;
  } catch (e) {
    console.warn("[dashboard] history load failed (weekly view indisponible):", e);
  }

  if (_ranked.updatedAt) {
    const d = new Date(typeof _ranked.updatedAt === "number" ? _ranked.updatedAt : _ranked.updatedAt);
    if (!Number.isNaN(d.getTime())) {
      lastUpdateEl.textContent = "Mis à jour " + new Intl.DateTimeFormat("fr-FR", {
        day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit",
      }).format(d);
    }
  }
}

/* ════════════════════════════════════════════════════════════════
   Calcul du classement
   ════════════════════════════════════════════════════════════════ */

// ELO gagné sur les 7 derniers jours pour un joueur (depuis l'historique).
function weeklyEloGain(history, publicId) {
  if (!history || !history[publicId]) return 0;
  const arr = history[publicId];
  if (!arr.length) return 0;
  const now = Date.now();
  const weekAgo = now - 7 * 86400000;
  // Trouver l'entrée la plus proche d'il y a 7 jours
  let before = null;
  for (const e of arr) {
    if (e.t <= weekAgo) before = e;
    else break;
  }
  const current = arr[arr.length - 1];
  if (!current) return 0;
  const baseElo = before ? before.elo : current.elo;
  return Math.max(0, current.elo - baseElo);
}

// Construit le classement global (points = FFA wins × 10 + Team wins × 5).
function buildOverallRanking() {
  if (!_ranked) return [];
  const byPid = new Map(); // publicId → entry

  const getOrCreate = (pid, name) => {
    let e = byPid.get(pid);
    if (!e) {
      e = {
        publicId: pid,
        name: name || pid,
        ffaWins: 0,
        teamWins: 0,
        ffaLosses: 0,
        teamLosses: 0,
        ffaElo: 0,
        teamElo: 0,
        ffaGames: 0,
        teamGames: 0,
      };
      byPid.set(pid, e);
    }
    return e;
  };

  // 1v1 = FFA
  for (const p of _ranked["1v1"] || []) {
    const e = getOrCreate(p.public_id, p.username || p.accountUsername);
    e.ffaWins = p.wins || 0;
    e.ffaLosses = p.losses || 0;
    e.ffaElo = p.elo || 0;
    e.ffaGames = p.total || 0;
    // Conserve le nom le plus propre
    const nm = p.username || p.accountUsername;
    if (nm && nm !== p.public_id) e.name = nm;
  }

  // 2v2 = Team
  for (const p of _ranked["2v2"] || []) {
    const e = getOrCreate(p.public_id, p.username || p.accountUsername);
    e.teamWins = p.wins || 0;
    e.teamLosses = p.losses || 0;
    e.teamElo = p.elo || 0;
    e.teamGames = p.total || 0;
    const nm = p.username || p.accountUsername;
    if (nm && nm !== p.public_id) e.name = nm;
  }

  const arr = [...byPid.values()];
  for (const e of arr) {
    e.points = e.ffaWins * FFA_POINTS_PER_WIN + e.teamWins * TEAM_POINTS_PER_WIN;
    e.totalWins = e.ffaWins + e.teamWins;
    e.totalGames = e.ffaGames + e.teamGames;
  }
  arr.sort((a, b) => {
    if (b.points !== a.points) return b.points - a.points;
    if (b.totalWins !== a.totalWins) return b.totalWins - a.totalWins;
    const aMax = Math.max(a.ffaElo, a.teamElo);
    const bMax = Math.max(b.ffaElo, b.teamElo);
    return bMax - aMax;
  });
  return arr.map((e, i) => ({ ...e, rank: i + 1 }));
}

// Construit le classement hebdomadaire (ELO gagné sur 7 jours, proxy activité).
function buildWeeklyRanking() {
  if (!_ranked) return [];
  const byPid = new Map();

  const getOrCreate = (pid, name) => {
    let e = byPid.get(pid);
    if (!e) {
      e = {
        publicId: pid,
        name: name || pid,
        ffaEloGain: 0,
        teamEloGain: 0,
        ffaWins: 0,
        teamWins: 0,
        ffaElo: 0,
        teamElo: 0,
      };
      byPid.set(pid, e);
    }
    return e;
  };

  for (const p of _ranked["1v1"] || []) {
    const e = getOrCreate(p.public_id, p.username || p.accountUsername);
    e.ffaEloGain = weeklyEloGain(_history1v1, p.public_id);
    e.ffaWins = p.wins || 0;
    e.ffaElo = p.elo || 0;
    const nm = p.username || p.accountUsername;
    if (nm && nm !== p.public_id) e.name = nm;
  }
  for (const p of _ranked["2v2"] || []) {
    const e = getOrCreate(p.public_id, p.username || p.accountUsername);
    e.teamEloGain = weeklyEloGain(_history2v2, p.public_id);
    e.teamWins = p.wins || 0;
    e.teamElo = p.elo || 0;
    const nm = p.username || p.accountUsername;
    if (nm && nm !== p.public_id) e.name = nm;
  }

  const arr = [...byPid.values()];
  for (const e of arr) {
    // Points hebdo = ELO gagné (FFA + Team) — proxy de la performance de la semaine
    e.points = e.ffaEloGain + e.teamEloGain;
  }
  // Ne garder que les joueurs avec progression > 0 cette semaine
  const active = arr.filter((e) => e.points > 0);
  active.sort((a, b) => b.points - a.points);
  return active.map((e, i) => ({ ...e, rank: i + 1 }));
}

/* ════════════════════════════════════════════════════════════════
   Rendu
   ════════════════════════════════════════════════════════════════ */

function render() {
  if (!_ranked) {
    view.innerHTML = `<div class="dash-error"><h3>Données indisponibles</h3><p>Impossible de charger le classement.</p></div>`;
    return;
  }

  const isWeekly = _dashMode === "weekly";
  const ranking = isWeekly ? buildWeeklyRanking() : buildOverallRanking();
  const champion = ranking[0] ?? null;

  // Stats globales
  const totalPlayers = ranking.length;
  const totalPoints = ranking.reduce((s, e) => s + e.points, 0);
  const totalFfaWins = isWeekly ? 0 : ranking.reduce((s, e) => s + e.ffaWins, 0);
  const totalTeamWins = isWeekly ? 0 : ranking.reduce((s, e) => s + e.teamWins, 0);

  const modeLabel = isWeekly ? "Cette semaine" : "Global";
  const topN = ranking.slice(0, 100);

  view.innerHTML = `
    ${champion ? `
    <div class="dash-hero">
      <div class="dash-hero-label">${isWeekly ? "Champion de la semaine" : "Champion Global"}</div>
      <div class="dash-hero-name">${escapeHtml(champion.name)}</div>
      <div class="dash-hero-sub">Rank #${champion.rank}</div>
      <div class="dash-hero-stats">
        <div class="dash-hero-stat">
          <div class="dash-hero-stat-val">${formatPoints(champion.points)}</div>
          <div class="dash-hero-stat-label">${isWeekly ? "ELO gagné" : "Points"}</div>
        </div>
        ${!isWeekly ? `
        <div class="dash-hero-stat">
          <div class="dash-hero-stat-val">${champion.ffaWins}</div>
          <div class="dash-hero-stat-label">Victoires FFA</div>
        </div>
        <div class="dash-hero-stat">
          <div class="dash-hero-stat-val">${champion.teamWins}</div>
          <div class="dash-hero-stat-label">Victoires Team</div>
        </div>` : `
        <div class="dash-hero-stat">
          <div class="dash-hero-stat-val">+${formatPoints(champion.ffaEloGain)}</div>
          <div class="dash-hero-stat-label">ELO FFA</div>
        </div>
        <div class="dash-hero-stat">
          <div class="dash-hero-stat-val">+${formatPoints(champion.teamEloGain)}</div>
          <div class="dash-hero-stat-label">ELO Team</div>
        </div>`}
      </div>
    </div>` : ""}

    <div class="dash-stats-grid">
      <div class="dash-stat-card">
        <div class="label">Joueurs classés</div>
        <div class="value">${formatPoints(totalPlayers)}</div>
        <div class="sub">${modeLabel}</div>
      </div>
      <div class="dash-stat-card">
        <div class="label">${isWeekly ? "ELO total distribué" : "Points distribués"}</div>
        <div class="value">${formatPoints(totalPoints)}</div>
        <div class="sub">${modeLabel}</div>
      </div>
      <div class="dash-stat-card">
        <div class="label">Victoires FFA</div>
        <div class="value">${formatPoints(totalFfaWins)}</div>
        <div class="sub">+10 pts chacune</div>
      </div>
      <div class="dash-stat-card">
        <div class="label">Victoires Team</div>
        <div class="value">${formatPoints(totalTeamWins)}</div>
        <div class="sub">+5 pts chacune</div>
      </div>
    </div>

    <div class="dash-card">
      <div class="dash-card-header">
        <span class="dash-card-title">Classement — ${modeLabel}</span>
        <div class="dash-toggle" role="tablist" aria-label="Période du classement">
          <button class="dash-toggle-btn ${!isWeekly ? "active" : ""}" data-mode="overall" role="tab" aria-selected="${!isWeekly}">Global</button>
          <button class="dash-toggle-btn ${isWeekly ? "active" : ""}" data-mode="weekly" role="tab" aria-selected="${isWeekly}">Cette semaine</button>
        </div>
      </div>
      <div class="dash-card-body">
        ${topN.length ? `
        <div class="dash-table-wrap">
          <table class="dash-table">
            <thead>
              <tr>
                <th class="dash-th-rank">#</th>
                <th>Joueur</th>
                ${isWeekly
                  ? `<th class="dash-th-num">ELO FFA</th><th class="dash-th-num">ELO Team</th><th class="dash-th-num">Total</th>`
                  : `<th class="dash-th-num">FFA (×10)</th><th class="dash-th-num">Team (×5)</th><th class="dash-th-num">Top ELO</th><th class="dash-th-num">Points</th>`}
              </tr>
            </thead>
            <tbody>
              ${topN.map((e) => {
                const name = e.name;
                const topElo = Math.max(e.ffaElo || 0, e.teamElo || 0);
                const profileUrl = `profile.html?pid=${encodeURIComponent(e.publicId)}`;
                if (isWeekly) {
                  return `
                  <tr class="dash-row-link" onclick="location.href='${profileUrl}'">
                    <td class="dash-td-rank">${rankCircleHtml(e.rank)}</td>
                    <td class="dash-td-player">
                      ${avatarHtml(name, "sm")}
                      <span class="dash-td-name">${escapeHtml(name)}</span>
                    </td>
                    <td class="dash-td-num">+${formatPoints(e.ffaEloGain)}</td>
                    <td class="dash-td-num">+${formatPoints(e.teamEloGain)}</td>
                    <td class="dash-td-num dash-td-points">+${formatPoints(e.points)}</td>
                  </tr>`;
                }
                const ffaPts = e.ffaWins * FFA_POINTS_PER_WIN;
                const teamPts = e.teamWins * TEAM_POINTS_PER_WIN;
                return `
                <tr class="dash-row-link" onclick="location.href='${profileUrl}'">
                  <td class="dash-td-rank">${rankCircleHtml(e.rank)}</td>
                  <td class="dash-td-player">
                    ${avatarHtml(name, "sm")}
                    <div class="dash-td-player-info">
                      <span class="dash-td-name">${escapeHtml(name)}</span>
                      ${e.totalGames ? `<span class="dash-td-sub">${e.totalGames} parties</span>` : ""}
                    </div>
                  </td>
                  <td class="dash-td-num">${e.ffaWins} <span class="dash-td-pts">(${formatPoints(ffaPts)})</span></td>
                  <td class="dash-td-num">${e.teamWins} <span class="dash-td-pts">(${formatPoints(teamPts)})</span></td>
                  <td class="dash-td-num">${formatPoints(topElo)}</td>
                  <td class="dash-td-num dash-td-points">${formatPoints(e.points)}</td>
                </tr>`;
              }).join("")}
            </tbody>
          </table>
        </div>` : `<p class="dash-empty">${isWeekly ? "Aucune progression ELO cette semaine (données d'historique indisponibles ou aucun match joué)." : "Aucun joueur classé pour le moment."}</p>`}
      </div>
    </div>

    <div class="dash-scoring-info">
      <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>
      <span>Barème : <strong>FFA</strong> (1v1 ranked) — chaque victoire = <strong>+10 points</strong> · <strong>Team</strong> (2v2 ranked) — chaque victoire = <strong>+5 points</strong>. ${isWeekly ? "Vue hebdo basée sur la progression ELO sur 7 jours." : "Vue globale = cumul des victoires."}</span>
    </div>
  `;

  // Toggle listeners
  view.querySelectorAll(".dash-toggle-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      _dashMode = btn.dataset.mode;
      render();
    });
  });
}

/* ════════════════════════════════════════════════════════════════
   Init
   ════════════════════════════════════════════════════════════════ */

(async function init() {
  try {
    await loadData();
    render();
  } catch (e) {
    console.error("[dashboard] init failed:", e);
    view.innerHTML = `<div class="dash-error"><h3>Erreur</h3><p>${escapeHtml(e.message)}</p></div>`;
  }
})();
