/**
 * tournois.js — Contrôleur principal de la section Tournois & Power Ranking.
 *
 * Architecture :
 *   - Routeur par hash (#/home, #/ranking, #/tournaments, #/tournament/:slug,
 *     #/player/:id, #/calendar)
 *   - Charge les données une fois (loadData du moteur) puis rend la vue.
 *   - Les vues sont des fonctions pures (rootEl, data) => HTML string.
 *
 * Design : réutilise le design system TheFrontHub (variables CSS, .sidebar,
 * .topbar, .nav-item, icônes icons.js).
 */

import {
  loadData,
  computePlayerPRs,
  computeTournamentPlayerStats,
  isFinalPhase,
  phaseUsesTierMultiplier,
  tierMultiplier,
  rewardPoints,
  formatPoints,
  formatDate,
  formatDateShort,
  formatDateTime,
  initials,
  placeLabel,
  getPlayer,
  getTournament,
} from "./tournois-engine.js";
import { hydrateIcons } from "./icons.js";

/* ════════════════════════════════════════════════════════════════
   État global
   ════════════════════════════════════════════════════════════════ */
let _data = null; // { players, scoring, tournaments, calendar, leaderboard }

const view = document.getElementById("tournois-view");
const titleEl = document.getElementById("tournois-title");
const subtitleEl = document.getElementById("tournois-subtitle");
const countEl = document.getElementById("tournois-count");
const breadcrumb = document.getElementById("tournois-breadcrumb");
const breadcrumbPath = document.getElementById("breadcrumb-path");
const breadcrumbBack = document.getElementById("breadcrumb-back");

/* ════════════════════════════════════════════════════════════════
   Helpers de rendu
   ════════════════════════════════════════════════════════════════ */

function setHeader(title, subtitle, count) {
  if (titleEl) titleEl.textContent = title;
  if (subtitleEl) subtitleEl.textContent = subtitle || "";
  if (countEl) countEl.textContent = count || "";
}

function showBreadcrumb(path) {
  if (!breadcrumb) return;
  if (path) {
    breadcrumb.style.display = "flex";
    breadcrumbPath.innerHTML = path;
  } else {
    breadcrumb.style.display = "none";
  }
}

function avatarHtml(name, size = "sm") {
  return `<span class="t-avatar t-avatar-${size}">${initials(name)}</span>`;
}

function rankCircleHtml(rank) {
  let cls = "";
  if (rank === 1) cls = "top1";
  else if (rank === 2) cls = "top2";
  else if (rank === 3) cls = "top3";
  else if (rank <= 10) cls = "top10";
  return `<span class="t-rank-circle ${cls}">${rank}</span>`;
}

function tierBadge(tier) {
  const labels = { major: "Major", standard: "Standard", minor: "Minor" };
  return `<span class="t-badge t-badge-${tier}">${labels[tier] || tier}</span>`;
}

function formatTierMult(tier) {
  const mults = { major: "×2.5", standard: "×1.0", minor: "×0.5" };
  return mults[tier] || "";
}

function escapeHtml(s) {
  if (s == null) return "";
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/* ════════════════════════════════════════════════════════════════
   Routeur
   ════════════════════════════════════════════════════════════════ */

function parseHash() {
  const h = window.location.hash.replace(/^#\/?/, "");
  if (!h) return { route: "home", params: {} };
  const parts = h.split("/");
  const route = parts[0];
  const params = {};
  if (route === "tournament" && parts[1]) params.slug = decodeURIComponent(parts[1]);
  else if (route === "player" && parts[1]) params.id = decodeURIComponent(parts[1]);
  return { route, params };
}

async function router() {
  if (!_data) {
    try {
      _data = await loadData();
    } catch (e) {
      console.error("[tournois] loadData failed:", e);
      view.innerHTML = `<div class="tournois-error">
        <div class="spinner"></div>
        <h3>Impossible de charger les données</h3>
        <p>${escapeHtml(e.message)}</p>
      </div>`;
      return;
    }
  }

  const { route, params } = parseHash();

  // Mise à jour de la sous-nav active
  document.querySelectorAll(".subnav-item").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.route === route);
  });

  // Breadcrumb + retour
  let bcPath = "";
  let backRoute = "home";
  if (route === "tournament" && params.slug) {
    const t = getTournament(_data.tournaments, params.slug);
    bcPath = `<strong>Tournois</strong> / ${escapeHtml(t?.name || params.slug)}`;
    backRoute = "tournaments";
  } else if (route === "player" && params.id) {
    const p = getPlayer(_data.players, params.id);
    bcPath = `<strong>Classement</strong> / ${escapeHtml(p?.name || params.id)}`;
    backRoute = "ranking";
  }
  showBreadcrumb(bcPath);
  breadcrumbBack?.setAttribute("data-back", backRoute);

  // Rendu
  try {
    switch (route) {
      case "ranking": await renderRanking(); break;
      case "tournaments": await renderTournamentsList(); break;
      case "tournament": await renderTournamentDetail(params.slug); break;
      case "player": await renderPlayerProfile(params.id); break;
      case "calendar": await renderCalendar(); break;
      case "home":
      default: await renderHome(); break;
    }
    hydrateIcons(view);
  } catch (e) {
    console.error("[tournois] render error:", e);
    view.innerHTML = `<div class="tournois-error"><h3>Erreur de rendu</h3><p>${escapeHtml(e.message)}</p></div>`;
  }

  // Scroll en haut
  view.scrollIntoView({ behavior: "smooth", block: "start" });
}

/* ════════════════════════════════════════════════════════════════
   VUE : Accueil
   ════════════════════════════════════════════════════════════════ */
async function renderHome() {
  setHeader("Tournois", "Power Ranking · Circuit compétitif OpenFront",
    `${_data.tournaments.length} tournois · ${_data.leaderboard.length} joueurs`);

  const lb = _data.leaderboard;
  const champion = lb[0] ?? null;
  const mostWins = [...lb].sort((a, b) => b.wins - a.wins)[0] ?? null;
  const latestTournament = _data.tournaments[0] ?? null;

  // Dernier vainqueur
  let latestWinnerName = "—";
  if (latestTournament) {
    for (const phase of latestTournament.phases) {
      if (!isFinalPhase(_data.scoring, latestTournament, phase.type)) continue;
      const win = phase.placements.find((p) => p.place === 1);
      if (win) {
        latestWinnerName = getPlayer(_data.players, win.player)?.name || win.player;
        break;
      }
    }
  }

  // Top 5 pour le mini-classement
  const top5 = lb.slice(0, 5);
  const podium = lb.slice(0, 3);

  // Total points distribués
  const totalPoints = lb.reduce((s, e) => s + e.points, 0);

  // Derniers résultats (top 3 du dernier tournoi)
  let recentResultsHtml = "";
  if (latestTournament) {
    const finalPhase = latestTournament.phases.find((p) =>
      isFinalPhase(_data.scoring, latestTournament, p.type)
    );
    if (finalPhase) {
      const top3 = [...finalPhase.placements]
        .filter((p) => p.place != null)
        .sort((a, b) => a.place - b.place)
        .slice(0, 3);
      recentResultsHtml = top3.map((p) => {
        const name = getPlayer(_data.players, p.player)?.name || p.player;
        const entry = lb.find((e) => e.playerId === p.player);
        return `<div class="t-list-item">
          ${rankCircleHtml(p.place)}
          <span class="t-list-name">${escapeHtml(name)}</span>
          ${entry ? `<span class="t-list-points">${formatPoints(entry.points)} PR</span>` : ""}
        </div>`;
      }).join("");
    }
  }

  view.innerHTML = `
    ${champion ? `
    <div class="t-hero">
      <div class="t-hero-label">Champion Power Ranking</div>
      <div class="t-hero-name">${escapeHtml(champion.player?.name || champion.playerId)}</div>
      <div style="opacity:.9;font-size:var(--text-md)">
        ${champion.player?.clan ? `[${escapeHtml(champion.player.clan)}] ` : ""}Rank #${champion.rank}
      </div>
      <div class="t-hero-stats">
        <div class="t-hero-stat">
          <div class="t-hero-stat-val">${formatPoints(champion.points)}</div>
          <div class="t-hero-stat-label">Points PR</div>
        </div>
        <div class="t-hero-stat">
          <div class="t-hero-stat-val">${champion.events}</div>
          <div class="t-hero-stat-label">Tournois</div>
        </div>
        <div class="t-hero-stat">
          <div class="t-hero-stat-val">${champion.wins}</div>
          <div class="t-hero-stat-label">Victoires</div>
        </div>
        <div class="t-hero-stat">
          <div class="t-hero-stat-val">${champion.top3}</div>
          <div class="t-hero-stat-label">Top 3</div>
        </div>
      </div>
    </div>` : ""}

    <div class="t-stats-grid">
      <div class="t-stat-card">
        <div class="label">Tournois</div>
        <div class="value">${_data.tournaments.length}</div>
        <div class="sub">${_data.tournaments.filter(t => t.tier === "major").length} major · ${_data.tournaments.filter(t => t.tier === "minor").length} minor</div>
      </div>
      <div class="t-stat-card">
        <div class="label">Joueurs classés</div>
        <div class="value">${lb.length}</div>
        <div class="sub">${lb.filter(e => e.events >= 2).length} récurrents</div>
      </div>
      <div class="t-stat-card">
        <div class="label">Points distribués</div>
        <div class="value">${formatPoints(totalPoints)}</div>
        <div class="sub">cumul à vie</div>
      </div>
      <div class="t-stat-card">
        <div class="label">Dernier vainqueur</div>
        <div class="value" style="font-size:var(--text-xl)">${escapeHtml(latestWinnerName)}</div>
        <div class="sub">${latestTournament ? formatDateShort(latestTournament.date) : "—"}</div>
      </div>
    </div>

    <div class="t-grid-2">
      <div class="t-card">
        <div class="t-card-header">
          <span class="t-card-title">Podium Power Ranking</span>
        </div>
        <div class="t-card-body">
          ${podium.length ? `
          <div class="t-podium">
            ${podium.map((e, i) => `
              <div class="t-podium-step">
                <div class="t-podium-bar"></div>
                <div class="t-podium-rank">#${e.rank}</div>
                ${avatarHtml(e.player?.name || e.playerId, "md")}
                <div class="t-podium-name">${escapeHtml(e.player?.name || e.playerId)}</div>
                <div class="t-podium-points">${formatPoints(e.points)}</div>
              </div>
            `).join("")}
          </div>` : `<p style="color:var(--muted);text-align:center;padding:20px">Aucun classement.</p>`}
        </div>
      </div>

      <div class="t-card">
        <div class="t-card-header">
          <span class="t-card-title">Top 5</span>
          <a class="t-link" href="#/ranking">Tout voir →</a>
        </div>
        <div class="t-card-body">
          <ul class="t-list">
            ${top5.map((e) => `
              <li class="t-list-item t-row-link" onclick="location.hash='#/player/${encodeURIComponent(e.playerId)}'">
                ${rankCircleHtml(e.rank)}
                ${avatarHtml(e.player?.name || e.playerId, "sm")}
                <span class="t-list-name">${escapeHtml(e.player?.name || e.playerId)}</span>
                <span class="t-list-points">${formatPoints(e.points)}</span>
              </li>
            `).join("")}
          </ul>
        </div>
      </div>
    </div>

    ${mostWins && mostWins.wins > 0 ? `
    <div class="t-card" style="margin-top:20px">
      <div class="t-card-header">
        <span class="t-card-title">Spotlight — Plus de victoires</span>
      </div>
      <div class="t-card-body">
        <div class="t-spotlight">
          <div class="t-spotlight-icon"><i data-icon="crown" data-icon-size="24"></i></div>
          <div class="t-spotlight-content">
            <div class="t-spotlight-title">Joueur le plus titré</div>
            <div class="t-spotlight-name">${escapeHtml(mostWins.player?.name || mostWins.playerId)}</div>
            <div class="t-spotlight-meta">${mostWins.wins} victoires · ${mostWins.top3} top 3 · ${mostWins.events} tournois</div>
          </div>
        </div>
      </div>
    </div>` : ""}

    ${recentResultsHtml ? `
    <div class="t-card" style="margin-top:20px">
      <div class="t-card-header">
        <span class="t-card-title">Dernier tournoi — ${escapeHtml(latestTournament?.name || "")}</span>
        <a class="t-link" href="#/tournament/${encodeURIComponent(latestTournament?.slug || "")}">Détails →</a>
      </div>
      <div class="t-card-body">
        <ul class="t-list">${recentResultsHtml}</ul>
      </div>
    </div>` : ""}
  `;
  hydrateIcons(view);
}

/* ════════════════════════════════════════════════════════════════
   VUE : Classement PR
   ════════════════════════════════════════════════════════════════ */

let _lbState = { q: "", filter: "all", sort: { key: "points", direction: "desc" } };

async function renderRanking() {
  setHeader("Classement Power Ranking", "Points cumulés sur tous les tournois",
    `${_data.leaderboard.length} joueurs`);

  const rows = _data.leaderboard.map((e) => ({
    rank: e.rank,
    id: e.playerId,
    name: e.player?.name ?? e.playerId,
    clan: e.player?.clan ?? null,
    points: e.points,
    events: e.events,
    wins: e.wins,
    top3: e.top3,
    avgPlace: e.avgPlace,
  }));

  view.innerHTML = `
    <div class="t-card">
      <div class="t-card-header">
        <span class="t-card-title">Classement général</span>
      </div>
      <div class="t-filters" id="lb-filters">
        ${[
          { id: "all", label: "Tous", count: rows.length },
          { id: "recurring", label: "Réguliers (≥2)", count: rows.filter(r => r.events >= 2).length },
          { id: "top100", label: "Top 100", count: Math.min(100, rows.length) },
          { id: "clan", label: "Avec clan", count: rows.filter(r => r.clan).length },
        ].map(f => `<button class="t-filter-btn ${_lbState.filter === f.id ? "active" : ""}" data-filter="${f.id}">${f.label}<span class="count">${f.count}</span></button>`).join("")}
        <div class="t-search">
          <i data-icon="info" data-icon-size="14"></i>
          <input type="text" id="lb-search" placeholder="Rechercher un joueur…" value="${escapeHtml(_lbState.q)}">
        </div>
      </div>
      <div class="t-table-wrap">
        <table class="t-table" id="lb-table">
          <thead></thead>
          <tbody></tbody>
        </table>
      </div>
    </div>
  `;
  hydrateIcons(view);

  const filtersEl = document.getElementById("lb-filters");
  const searchEl = document.getElementById("lb-search");
  const tableEl = document.getElementById("lb-table");

  filtersEl.addEventListener("click", (e) => {
    const btn = e.target.closest(".t-filter-btn");
    if (!btn) return;
    _lbState.filter = btn.dataset.filter;
    renderLbTable();
    filtersEl.querySelectorAll(".t-filter-btn").forEach(b => b.classList.toggle("active", b.dataset.filter === _lbState.filter));
  });
  searchEl.addEventListener("input", (e) => {
    _lbState.q = e.target.value;
    renderLbTable();
  });

  function renderLbTable() {
    let out = rows;
    if (_lbState.filter === "recurring") out = out.filter(r => r.events >= 2);
    else if (_lbState.filter === "top100") out = out.filter(r => r.rank <= 100);
    else if (_lbState.filter === "clan") out = out.filter(r => r.clan);
    const needle = _lbState.q.trim().toLowerCase();
    if (needle) {
      out = out.filter(r => `${r.name} ${r.id} ${r.clan ?? ""}`.toLowerCase().includes(needle));
    }
    // Tri
    const { key, direction } = _lbState.sort;
    out = [...out].sort((a, b) => {
      const av = a[key], bv = b[key];
      if (av == null && bv == null) return a.rank - b.rank;
      if (av == null) return 1;
      if (bv == null) return -1;
      if (av === bv) return a.rank - b.rank;
      return direction === "desc" ? bv - av : av - bv;
    });

    const sortArrow = (col) => {
      if (key !== col) return "↕";
      return direction === "desc" ? "↓" : "↑";
    };
    const sortClass = (col) => `sortable ${key === col ? "active" : ""}`;

    tableEl.querySelector("thead").innerHTML = `
      <tr>
        <th class="${sortClass("rank")}" data-sort="rank"># <span class="sort-arrow">${sortArrow("rank")}</span></th>
        <th>Joueur</th>
        <th class="num ${sortClass("points")}" data-sort="points">PR <span class="sort-arrow">${sortArrow("points")}</span></th>
        <th class="num ${sortClass("events")}" data-sort="events">Tournois <span class="sort-arrow">${sortArrow("events")}</span></th>
        <th class="num ${sortClass("wins")}" data-sort="wins">Victoires <span class="sort-arrow">${sortArrow("wins")}</span></th>
        <th class="num ${sortClass("top3")}" data-sort="top3">Top 3 <span class="sort-arrow">${sortArrow("top3")}</span></th>
        <th class="num ${sortClass("avgPlace")}" data-sort="avgPlace">Place moy. <span class="sort-arrow">${sortArrow("avgPlace")}</span></th>
      </tr>
    `;
    tableEl.querySelector("tbody").innerHTML = out.length ? out.map((r) => `
      <tr class="t-row-link" onclick="location.hash='#/player/${encodeURIComponent(r.id)}'">
        <td>${rankCircleHtml(r.rank)}</td>
        <td>
          <div class="t-player-cell">
            ${avatarHtml(r.name, "sm")}
            <div>
              <div>
                ${r.clan ? `<span class="t-player-clan">[${escapeHtml(r.clan)}]</span>` : ""}
                <span class="t-player-name">${escapeHtml(r.name)}</span>
                ${r.events === 1 ? `<span class="t-badge t-badge-new" style="margin-left:6px">Nouveau</span>` : ""}
              </div>
              <div class="t-player-id">${escapeHtml(r.id)}</div>
            </div>
          </div>
        </td>
        <td class="num"><span class="t-points">${formatPoints(r.points)}</span></td>
        <td class="num">${r.events}</td>
        <td class="num">${r.wins}</td>
        <td class="num">${r.top3}</td>
        <td class="num">${r.avgPlace == null ? "—" : `#${r.avgPlace.toFixed(1)}`}</td>
      </tr>
    `).join("") : `<tr><td colspan="7" style="text-align:center;padding:32px;color:var(--muted)">Aucun résultat.</td></tr>`;

    // Tri au clic sur les en-têtes
    tableEl.querySelector("thead").addEventListener("click", (e) => {
      const th = e.target.closest("th[data-sort]");
      if (!th) return;
      const col = th.dataset.sort;
      if (_lbState.sort.key === col) {
        _lbState.sort.direction = _lbState.sort.direction === "desc" ? "asc" : "desc";
      } else {
        _lbState.sort.key = col;
        _lbState.sort.direction = (col === "rank" || col === "avgPlace") ? "asc" : "desc";
      }
      renderLbTable();
    }, { once: true });
  }

  renderLbTable();
}

/* ════════════════════════════════════════════════════════════════
   VUE : Liste des tournois
   ════════════════════════════════════════════════════════════════ */
async function renderTournamentsList() {
  setHeader("Tournois", "Circuit compétitif OpenFront",
    `${_data.tournaments.length} tournois`);

  const cards = _data.tournaments.map((t) => {
    const finalPhase = t.phases.find((p) => isFinalPhase(_data.scoring, t, p.type));
    const winner = finalPhase?.placements.find((p) => p.place === 1);
    const winnerName = winner ? (getPlayer(_data.players, winner.player)?.name || "—") : null;
    const participantCount = finalPhase?.placements.length || t.participants || 0;
    return `
      <div class="t-tournament-card" onclick="location.hash='#/tournament/${encodeURIComponent(t.slug)}'">
        <div class="t-tournament-card-header">
          <div>
            <div class="t-tournament-name">${escapeHtml(t.name)}</div>
            <div class="t-tournament-date">${formatDate(t.date)}</div>
          </div>
          ${tierBadge(t.tier)}
        </div>
        <div class="t-tournament-meta">
          <span><i data-icon="swords" data-icon-size="14"></i> ${t.format.toUpperCase()}</span>
          <span><i data-icon="users" data-icon-size="14"></i> ${participantCount}</span>
          ${t.series ? `<span><i data-icon="trophy" data-icon-size="14"></i> ${escapeHtml(t.series)}</span>` : ""}
          ${formatTierMult(t.tier) ? `<span style="color:var(--orange);font-weight:700">${formatTierMult(t.tier)}</span>` : ""}
        </div>
        ${winnerName ? `<div style="font-size:var(--text-sm);color:var(--muted)">Vainqueur : <strong style="color:var(--text)">${escapeHtml(winnerName)}</strong></div>` : ""}
      </div>
    `;
  }).join("");

  view.innerHTML = `
    <div class="t-tournament-grid">
      ${cards || `<p style="color:var(--muted)">Aucun tournoi.</p>`}
    </div>
  `;
  hydrateIcons(view);
}

/* ════════════════════════════════════════════════════════════════
   VUE : Détail tournoi
   ════════════════════════════════════════════════════════════════ */
async function renderTournamentDetail(slug) {
  const t = getTournament(_data.tournaments, slug);
  if (!t) {
    setHeader("Tournoi introuvable", "", "");
    view.innerHTML = `<div class="tournois-error"><h3>Tournoi introuvable</h3><p>Slug : ${escapeHtml(slug)}</p></div>`;
    return;
  }

  setHeader(t.name, `${formatDate(t.date)} · ${t.format.toUpperCase()} · ${tierBadge(t.tier)}`, "");
  // Le badge dans le subtitle ne rendra pas en HTML via textContent, donc on le met dans count
  countEl.innerHTML = `${tierBadge(t.tier)} <span style="margin-left:8px;color:var(--muted);font-size:12px">${formatTierMult(t.tier)}</span>`;

  const scoring = _data.scoring;
  const mult = tierMultiplier(scoring, t);

  // Phases (dans l'ordre du format)
  const formatConf = scoring.formats[t.format];
  const phaseOrder = formatConf?.phaseOrder || t.phases.map(p => p.type);
  const phasesHtml = phaseOrder.map((phaseType) => {
    const phase = t.phases.find(p => p.type === phaseType);
    if (!phase) return "";
    const phaseConf = formatConf?.phases?.[phaseType];
    const label = phaseConf?.label || phaseType;
    const isFinal = isFinalPhase(scoring, t, phaseType);
    const usesMult = phaseUsesTierMultiplier(scoring, t, phaseType);

    const placements = [...phase.placements]
      .filter(p => p.place != null)
      .sort((a, b) => a.place - b.place);

    if (placements.length === 0) {
      const participants = phase.placements;
      return `
        <div class="t-phase-section">
          <h3 class="t-phase-title">${escapeHtml(label)} ${isFinal ? '<span class="t-badge t-badge-major">Finale</span>' : ''}</h3>
          <p style="color:var(--muted);padding:8px 0">${participants.length} participants (pas de classement détaillé)</p>
        </div>
      `;
    }

    const rows = placements.map((p) => {
      const name = getPlayer(_data.players, p.player)?.name || p.player;
      const entry = _data.leaderboard.find(e => e.playerId === p.player);
      const reward = rewardPoints(scoring, t, p.place);
      return `
        <tr class="t-row-link" onclick="location.hash='#/player/${encodeURIComponent(p.player)}'">
          <td>${rankCircleHtml(p.place)}</td>
          <td>
            <div class="t-player-cell">
              ${avatarHtml(name, "sm")}
              <div>
                ${entry?.player?.clan ? `<span class="t-player-clan">[${escapeHtml(entry.player.clan)}]</span>` : ""}
                <span class="t-player-name">${escapeHtml(name)}</span>
              </div>
            </div>
          </td>
          <td class="num"><strong style="color:var(--orange)">+${Math.round((phaseConf?.places?.[String(p.place)] || 0) * (usesMult ? mult : 1))}</strong></td>
          <td class="num">${reward > 0 ? `<span style="color:var(--gold);font-weight:700">${reward} P</span>` : "—"}</td>
        </tr>
      `;
    }).join("");

    return `
      <div class="t-phase-section">
        <h3 class="t-phase-title">${escapeHtml(label)} ${isFinal ? '<span class="t-badge t-badge-major">Finale</span>' : ''}</h3>
        <div class="t-table-wrap">
          <table class="t-results-table">
            <thead>
              <tr>
                <th>Place</th>
                <th>Joueur</th>
                <th class="num">Points PR</th>
                <th class="num">Récompense</th>
              </tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
      </div>
    `;
  }).join("");

  // Stats par joueur (depuis details.games)
  let statsHtml = "";
  if (t.details?.games?.length) {
    const statsMap = computeTournamentPlayerStats(t);
    const statsArr = [...statsMap.values()].sort((a, b) => b.gamesPlayed - a.gamesPlayed || (a.bestPlace ?? 999) - (b.bestPlace ?? 999));
    if (statsArr.length) {
      const stageLabels = { qualifier: "Qualif", semifinal: "Demi", final: "Finale" };
      statsHtml = `
        <div class="t-card" style="margin-bottom:20px">
          <div class="t-card-header"><span class="t-card-title">Stats du tournoi (par joueur)</span></div>
          <div class="t-table-wrap">
            <table class="t-stats-table">
              <thead>
                <tr>
                  <th>Joueur</th>
                  <th>Parties</th>
                  <th>Wins</th>
                  <th>Kills</th>
                  <th>Survécues</th>
                  <th>Meilleure place</th>
                  <th>Stage max</th>
                  <th>Temps (min)</th>
                  <th>Pts/partie</th>
                </tr>
              </thead>
              <tbody>
                ${statsArr.map(s => {
                  const name = getPlayer(_data.players, s.playerId)?.name || s.playerId;
                  return `<tr class="t-row-link" onclick="location.hash='#/player/${encodeURIComponent(s.playerId)}'">
                    <td><strong>${escapeHtml(name)}</strong></td>
                    <td>${s.gamesPlayed}</td>
                    <td>${s.wins}</td>
                    <td>${s.kills}</td>
                    <td>${s.survived}</td>
                    <td>${s.bestPlace == null ? "—" : `#${s.bestPlace}`}</td>
                    <td>${s.furthestStage ? stageLabels[s.furthestStage] || s.furthestStage : "—"}</td>
                    <td>${Math.round(s.playtimeMin)}</td>
                    <td>${s.avgGamePoints == null ? "—" : s.avgGamePoints}</td>
                  </tr>`;
                }).join("")}
              </tbody>
            </table>
          </div>
        </div>
      `;
    }
  }

  view.innerHTML = `
    <div class="t-detail-header">
      <div class="t-detail-title">${escapeHtml(t.name)}</div>
      <div class="t-detail-meta">
        <span><i data-icon="info" data-icon-size="14"></i> ${formatDate(t.date)}</span>
        <span><i data-icon="swords" data-icon-size="14"></i> ${t.format.toUpperCase()}</span>
        <span><i data-icon="trophy" data-icon-size="14"></i> ${escapeHtml(t.series || "—")}</span>
        <span><i data-icon="users" data-icon-size="14"></i> ${t.participants} participants</span>
        ${t.map ? `<span><i data-icon="map" data-icon-size="14"></i> ${escapeHtml(t.map)}</span>` : ""}
      </div>
    </div>
    ${statsHtml}
    ${phasesHtml || '<p style="color:var(--muted)">Aucune phase.</p>'}
  `;
  hydrateIcons(view);
}

/* ════════════════════════════════════════════════════════════════
   VUE : Profil joueur
   ════════════════════════════════════════════════════════════════ */
async function renderPlayerProfile(discordId) {
  const player = getPlayer(_data.players, discordId);
  const entry = _data.leaderboard.find(e => e.playerId === discordId);

  if (!player && !entry) {
    setHeader("Joueur introuvable", "", "");
    view.innerHTML = `<div class="tournois-error"><h3>Joueur introuvable</h3><p>ID : ${escapeHtml(discordId)}</p></div>`;
    return;
  }

  const name = player?.name || discordId;
  const clan = player?.clan || null;
  const rank = entry?.rank ?? "—";
  const points = entry?.points ?? 0;
  const events = entry?.events ?? 0;
  const wins = entry?.wins ?? 0;
  const top3 = entry?.top3 ?? 0;
  const bestPlace = entry?.bestPlace;
  const avgPlace = entry?.avgPlace;

  setHeader(name, `Profil tournoi · ${clan ? `[${clan}] ` : ""}Rank #${rank}`, "");

  // Décomposition des points (awards groupés par tournoi)
  const awards = entry?.awards || [];
  const byTournament = new Map();
  for (const a of awards) {
    if (!byTournament.has(a.tournamentSlug)) {
      byTournament.set(a.tournamentSlug, {
        slug: a.tournamentSlug,
        name: a.tournamentName,
        date: a.tournamentDate,
        tier: a.tier,
        awards: [],
        total: 0,
      });
    }
    const grp = byTournament.get(a.tournamentSlug);
    grp.awards.push(a);
    grp.total += a.points;
  }
  const tournaments = [...byTournament.values()].sort((a, b) => b.date.localeCompare(a.date));

  // Chart PR (top 8 tournois par points)
  const chartData = tournaments.slice(0, 8).sort((a, b) => b.total - a.total);
  const maxChart = Math.max(...chartData.map(c => c.total), 1);

  // Récompenses Plutonium cumulées
  let totalPlutonium = 0;
  for (const a of awards) {
    const t = getTournament(_data.tournaments, a.tournamentSlug);
    if (t && a.place != null) {
      totalPlutonium += rewardPoints(_data.scoring, t, a.place);
    }
  }

  const awardsHtml = tournaments.length ? tournaments.map((grp) => `
    <div class="t-award">
      <div class="t-award-place">${grp.tier === "major" ? "★" : "•"}</div>
      <div class="t-award-info">
        <div class="t-award-tournament">
          <a class="t-link" href="#/tournament/${encodeURIComponent(grp.slug)}">${escapeHtml(grp.name)}</a>
        </div>
        <div class="t-award-phase">
          ${formatDateShort(grp.date)} · ${grp.awards.map(a => `${a.phaseLabel}${a.place ? ` #${a.place}` : ""}`).join(", ")}
        </div>
      </div>
      <div class="t-award-points">+${formatPoints(grp.total)}</div>
    </div>
  `).join("") : `<p style="color:var(--muted);padding:16px">Aucun tournoi joué.</p>`;

  const chartHtml = chartData.length ? `
    <div class="t-chart">
      ${chartData.map(c => `
        <div class="t-chart-row">
          <div class="t-chart-label" title="${escapeHtml(c.name)}">${escapeHtml(c.name)}</div>
          <div class="t-chart-bar-wrap"><div class="t-chart-bar" style="width:${(c.total / maxChart * 100).toFixed(1)}%"></div></div>
          <div class="t-chart-val">${formatPoints(c.total)}</div>
        </div>
      `).join("")}
    </div>
  ` : `<p style="color:var(--muted)">Pas assez de données.</p>`;

  view.innerHTML = `
    <div class="t-profile-header">
      ${avatarHtml(name, "lg")}
      <div style="flex:1">
        <div class="t-profile-name">${escapeHtml(name)}</div>
        <div class="t-profile-sub">
          ${clan ? `Clan : <strong>${escapeHtml(clan)}</strong> · ` : ""}Rank Power Ranking : <strong style="color:var(--orange)">#${rank}</strong>
        </div>
        <div class="t-profile-stats">
          <div class="t-profile-stat"><div class="v">${formatPoints(points)}</div><div class="l">Points PR</div></div>
          <div class="t-profile-stat"><div class="v">${events}</div><div class="l">Tournois</div></div>
          <div class="t-profile-stat"><div class="v">${wins}</div><div class="l">Victoires</div></div>
          <div class="t-profile-stat"><div class="v">${top3}</div><div class="l">Top 3</div></div>
          <div class="t-profile-stat"><div class="v">${bestPlace == null ? "—" : `#${bestPlace}`}</div><div class="l">Meilleure place</div></div>
          <div class="t-profile-stat"><div class="v">${avgPlace == null ? "—" : `#${avgPlace.toFixed(1)}`}</div><div class="l">Place moy.</div></div>
          ${totalPlutonium > 0 ? `<div class="t-profile-stat"><div class="v" style="color:var(--gold)">${totalPlutonium} P</div><div class="l">Plutonium</div></div>` : ""}
        </div>
      </div>
    </div>

    <div class="t-grid-2">
      <div class="t-card">
        <div class="t-card-header"><span class="t-card-title">Décomposition des points</span></div>
        <div class="t-card-body">
          <div class="t-awards-list">${awardsHtml}</div>
        </div>
      </div>
      <div class="t-card">
        <div class="t-card-header"><span class="t-card-title">Points par tournoi (top 8)</span></div>
        <div class="t-card-body">${chartHtml}</div>
      </div>
    </div>
  `;
  hydrateIcons(view);
}

/* ════════════════════════════════════════════════════════════════
   VUE : Calendrier
   ════════════════════════════════════════════════════════════════ */
async function renderCalendar() {
  setHeader("Calendrier", "Prochains tournois du circuit", `${_data.calendar.length} événement(s)`);

  const events = [..._data.calendar].sort((a, b) =>
    (a.startsAt ?? a.date).localeCompare(b.startsAt ?? b.date)
  );

  if (!events.length) {
    view.innerHTML = `<div class="t-card"><div class="t-card-body"><p style="color:var(--muted);padding:20px">Aucun événement à venir.</p></div></div>`;
    return;
  }

  const monthLabels = ["JAN","FÉV","MAR","AVR","MAI","JUN","JUL","AOÛ","SEP","OCT","NOV","DÉC"];

  view.innerHTML = `
    <div class="t-cal-list">
      ${events.map(ev => {
        const d = new Date(ev.startsAt || ev.date + "T12:00:00Z");
        const day = d.getUTCDate();
        const month = monthLabels[d.getUTCMonth()];
        const time = ev.startsAt ? formatDateTime(ev.startsAt) : formatDate(ev.date);
        return `
          <div class="t-cal-item">
            <div class="t-cal-date">
              <div class="t-cal-day">${day}</div>
              <div class="t-cal-month">${month}</div>
            </div>
            <div class="t-cal-info">
              <div class="t-cal-name">${escapeHtml(ev.name)}</div>
              <div class="t-cal-meta">
                ${time}
                ${ev.format ? ` · ${ev.format.toUpperCase()}` : ""}
                ${ev.tier ? ` · ${tierBadge(ev.tier)}` : ""}
                ${ev.series ? ` · ${escapeHtml(ev.series)}` : ""}
                ${ev.participants ? ` · ${ev.participants} inscrits` : ""}
              </div>
            </div>
            ${ev.registrationUrl ? `<a class="t-cal-register" href="${escapeHtml(ev.registrationUrl)}" target="_blank" rel="noreferrer">S'inscrire</a>` : ""}
          </div>
        `;
      }).join("")}
    </div>
  `;
  hydrateIcons(view);
}

/* ════════════════════════════════════════════════════════════════
   Init & events
   ════════════════════════════════════════════════════════════════ */

// Sous-nav : navigation par hash
document.querySelectorAll(".subnav-item").forEach((btn) => {
  btn.addEventListener("click", () => {
    const route = btn.dataset.route;
    if (route) location.hash = `#/${route}`;
  });
});

// Breadcrumb retour
breadcrumbBack?.addEventListener("click", () => {
  const back = breadcrumbBack.getAttribute("data-back") || "home";
  location.hash = `#/${back}`;
});

// Route au chargement et au changement de hash
window.addEventListener("hashchange", router);
window.addEventListener("DOMContentLoaded", router);

// Si pas de hash au démarrage, aller à l'accueil
if (!window.location.hash) {
  window.location.hash = "#/home";
} else {
  router();
}
