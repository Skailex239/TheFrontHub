// theatre.js — THEATRE: OpenFront replay analyzer
// 1. INGESTION: fetch game data from api.openfront.io/public/game/{id}
// 2. ANALYTICS: parse players, stats, timeline events, build dashboard
// 3. UI: timeline, expansion charts, nuke tracker, diplomacy graph

const THEATRE_VIEW = document.getElementById("theatre-view");
const GAME_INPUT = document.getElementById("theatre-game-input");
const ANALYZE_BTN = document.getElementById("theatre-analyze-btn");
const ERROR_MSG = document.getElementById("theatre-error");

const API_BASE = "https://api.openfront.io";

let currentGame = null;

/* ═══ Utils ═══ */
function esc(s) {
  if (s == null) return "";
  return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&#39;");
}
function fmtTime(seconds) {
  if (!seconds) return "—";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2,"0")}`;
}
function fmtNum(n) {
  if (n == null) return "—";
  return new Intl.NumberFormat("fr-FR").format(n);
}
function fmtDate(ts) {
  if (!ts) return "—";
  return new Date(ts).toLocaleString("fr-FR", { day:"2-digit", month:"short", hour:"2-digit", minute:"2-digit" });
}

/* ═══ Ingestion ═══ */

function parseGameId(input) {
  if (!input) return null;
  input = input.trim();
  // From URL: openfront.io/#join=XXXX or openfront.io/game/XXXX
  const urlMatch = input.match(/(?:#join=|game\/)([A-Za-z0-9]+)/);
  if (urlMatch) return urlMatch[1];
  // Direct ID
  if (/^[A-Za-z0-9]{6,12}$/.test(input)) return input;
  return null;
}

async function fetchGame(gameId) {
  console.log(`[theatre] Fetching game ${gameId}…`);
  const gameUrl = `${API_BASE}/public/game/${gameId}?turns=false`;
  const encodedUrl = encodeURIComponent(gameUrl);
  const proxies = [
    `https://corsproxy.io/?url=${encodedUrl}`,
    `https://api.codetabs.com/v1/proxy/?quest=${encodedUrl}`,
    `https://api.allorigins.win/raw?url=${encodedUrl}`,
    gameUrl,
  ];
  let res = null;
  for (const proxyUrl of proxies) {
    try {
      res = await fetch(proxyUrl);
      if (res && res.ok) break;
    } catch { continue; }
  }
  if (!res || !res.ok) {
    throw new Error("Partie introuvable ou API inaccessible. Vérifiez l'ID.");
  }
  const data = await res.json();
  if (data.error) throw new Error(data.error);

  // Check if game is finished
  const info = data.info || {};
  if (!info.end || !info.duration) {
    throw new Error("Cette partie n'est pas terminée. Revenez plus tard.");
  }

  return { gameId, gitCommit: data.gitCommit, ...info, raw: data };
}

/* ═══ Analytics ═══ */

function analyzeGame(game) {
  const players = (game.players || []).map((p, i) => {
    const stats = p.stats || {};
    const attacks = stats.attacks || [];
    const isDead = stats.killedAt != null;
    const hasNukes = (stats.bombs && stats.bombs > 0) || false;
    const gold = stats.gold ? (Array.isArray(stats.gold) ? stats.gold[0] : stats.gold) : 0;
    const finalTiles = stats.finalTiles || 0;
    const boats = stats.boats || {};
    const units = stats.units || {};

    return {
      index: i,
      clientID: p.clientID,
      username: p.username || `Player ${i}`,
      clanTag: p.clanTag || null,
      isLobbyCreator: p.isLobbyCreator || false,
      isDead,
      killedAt: stats.killedAt ? parseInt(stats.killedAt) : null,
      attacks: attacks.length,
      attackTargets: attacks,
      conquests: (stats.conquests || []).length,
      betrayals: stats.betrayals || 0,
      finalTiles: parseInt(finalTiles) || 0,
      gold: parseInt(gold) || 0,
      boats: boats,
      units: units,
      hasNukes,
      bombs: stats.bombs || 0,
      stats,
    };
  });

  // Winner
  const winnerData = game.winner || [];
  let winnerId = null;
  if (winnerData.length >= 2 && winnerData[0] === "player") {
    winnerId = winnerData[1];
  }
  const winner = players.find(p => p.clientID === winnerId);

  // Timeline events
  const events = [];
  const totalTicks = game.num_turns || 1;
  const duration = game.duration || 1;

  // Eliminations
  players.forEach(p => {
    if (p.killedAt != null) {
      events.push({
        type: "elimination",
        tick: p.killedAt,
        time: (p.killedAt / totalTicks) * duration,
        player: p.username,
        text: `${p.username} éliminé`,
      });
    }
  });

  // Attacks (if detailed enough)
  players.forEach(p => {
    if (p.attackTargets && p.attackTargets.length > 0) {
      p.attackTargets.forEach(targetId => {
        const target = players[parseInt(targetId)];
        if (target) {
          events.push({
            type: "attack",
            tick: 0, // We don't have exact tick for attacks
            time: 0,
            player: p.username,
            target: target.username,
            text: `${p.username} → ${target.username}`,
          });
        }
      });
    }
  });

  // Betrayals
  players.forEach(p => {
    if (p.betrayals > 0) {
      events.push({
        type: "betrayal",
        tick: 0,
        time: 0,
        player: p.username,
        text: `${p.username} a trahi (${p.betrayals}×)`,
      });
    }
  });

  // Victory
  if (winner) {
    events.push({
      type: "victory",
      tick: totalTicks,
      time: duration,
      player: winner.username,
      text: `Victoire de ${winner.username}`,
    });
  }

  // Sort by time
  events.sort((a, b) => (a.time || 0) - (b.time || 0));

  return { players, winner, events, totalTicks, duration };
}

/* ═══ Render ═══ */

function showLoading(step) {
  THEATRE_VIEW.innerHTML = `
    <div class="theatre-loading">
      <div class="spinner"></div>
      <div class="theatre-loading-text">Analyse de la partie…</div>
      <div class="theatre-loading-step">${esc(step || "")}</div>
    </div>`;
}

function showError(msg) {
  ERROR_MSG.textContent = msg;
  ERROR_MSG.style.display = "block";
  setTimeout(() => { ERROR_MSG.style.display = "none"; }, 8000);
}

function renderDashboard(game, analysis) {
  const { players, winner, events, totalTicks, duration } = analysis;
  const config = game.config || {};
  const mapName = config.gameMap || "Unknown";
  const gameMode = config.gameMode || config.gameType || "—";
  const difficulty = config.difficulty || "—";
  const maxPlayers = config.maxPlayers || players.length;
  const bots = config.bots || 0;

  THEATRE_VIEW.innerHTML = `
    <div class="theatre-dashboard">
      <!-- Header -->
      <div class="theatre-game-header">
        <div>
          <h2 class="theatre-game-title">${esc(mapName)}</h2>
          <div class="theatre-game-meta">
            <span class="theatre-game-meta-item">🎮 ${esc(gameMode)}</span>
            <span class="theatre-game-meta-item">⚔️ ${players.length}/${maxPlayers} joueurs</span>
            <span class="theatre-game-meta-item">🤖 ${bots} bots</span>
            <span class="theatre-game-meta-item">📊 ${esc(difficulty)}</span>
            <span class="theatre-game-meta-item">⏱️ ${fmtTime(duration)}</span>
            <span class="theatre-game-meta-item">🔄 ${fmtNum(totalTicks)} ticks</span>
            <span class="theatre-game-meta-item">📅 ${fmtDate(game.start)}</span>
          </div>
        </div>
        <button class="theatre-back-btn" onclick="location.reload()">← Nouvelle analyse</button>
      </div>

      ${winner ? `
      <div class="theatre-winner">
        <span class="theatre-winner-trophy">🏆</span>
        <div class="theatre-winner-info">
          <div class="theatre-winner-label">Vainqueur</div>
          <div class="theatre-winner-name">${esc(winner.username)}${winner.clanTag ? ` <span style="color:var(--muted);font-size:14px">[${esc(winner.clanTag)}]</span>` : ""}</div>
        </div>
      </div>` : ""}

      <!-- Stats -->
      <div class="theatre-stats-grid">
        <div class="theatre-stat-box"><span>${players.length}</span><label>Joueurs</label></div>
        <div class="theatre-stat-box"><span>${players.filter(p => p.isDead).length}</span><label>Éliminés</label></div>
        <div class="theatre-stat-box"><span>${players.reduce((s,p) => s + p.betrayals, 0)}</span><label>Trahisons</label></div>
        <div class="theatre-stat-box"><span>${players.reduce((s,p) => s + p.bombs, 0)}</span><label>Nukes</label></div>
        <div class="theatre-stat-box"><span>${fmtTime(duration)}</span><label>Durée</label></div>
        <div class="theatre-stat-box"><span>${fmtNum(totalTicks)}</span><label>Ticks</label></div>
      </div>

      <!-- Tabs -->
      <div class="theatre-tabs">
        <button class="theatre-tab active" data-tab="overview">Vue d'ensemble</button>
        <button class="theatre-tab" data-tab="economy">Économie</button>
        <button class="theatre-tab" data-tab="timeline">Timeline</button>
        <button class="theatre-tab" data-tab="diplomacy">Diplomatie</button>
      </div>

      <!-- Overview tab -->
      <div class="theatre-tab-content active" id="tab-overview">
        <div class="theatre-section">
          <div class="theatre-section-header">Classement des joueurs</div>
          <div class="theatre-section-body">
            <table class="theatre-player-table">
              <thead>
                <tr>
                  <th>#</th><th>Joueur</th><th class="num">Tuiles</th><th class="num">Or</th><th class="num">Attaques</th><th class="num">Conquêtes</th><th class="num">Trahisons</th><th class="num">Nukes</th><th>Statut</th>
                </tr>
              </thead>
              <tbody>
                ${players.map((p, i) => `
                  <tr>
                    <td class="theatre-player-rank">${i + 1}</td>
                    <td class="theatre-player-name ${p.isDead ? "theatre-player-dead" : ""}">${esc(p.username)}${p.clanTag ? ` <span class="theatre-player-clan">[${esc(p.clanTag)}]</span>` : ""}</td>
                    <td class="num">${fmtNum(p.finalTiles)}</td>
                    <td class="num">${fmtNum(p.gold)}</td>
                    <td class="num">${p.attacks}</td>
                    <td class="num">${p.conquests}</td>
                    <td class="num">${p.betrayals || 0}</td>
                    <td class="num">${p.bombs || 0}</td>
                    <td>${p.isDead ? `<span style="color:var(--red);font-size:12px">💀 Tick ${p.killedAt}</span>` : `<span style="color:var(--green);font-size:12px">✓ Vivant</span>`}</td>
                  </tr>
                `).join("")}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <!-- Economy tab -->
      <div class="theatre-tab-content" id="tab-economy">
        <div class="theatre-section">
          <div class="theatre-section-header">Courbes d'expansion</div>
          <div class="theatre-chart-wrap">
            <canvas class="theatre-chart-canvas" id="expansion-chart"></canvas>
          </div>
        </div>
      </div>

      <!-- Timeline tab -->
      <div class="theatre-tab-content" id="tab-timeline">
        <div class="theatre-section">
          <div class="theatre-section-header">Timeline des événements</div>
          <div class="theatre-timeline">
            <div class="theatre-timeline-track" id="timeline-track">
              <div class="theatre-timeline-progress" id="timeline-progress" style="width:100%"></div>
              ${events.filter(e => e.time > 0).map(e => {
                const pct = (e.time / duration) * 100;
                return `<div class="theatre-timeline-event ${e.type}" style="left:${pct}%" title="${esc(e.text)}"></div>`;
              }).join("")}
            </div>
            <div class="theatre-timeline-labels">
              <span>0:00</span>
              <span>${fmtTime(duration / 2)}</span>
              <span>${fmtTime(duration)}</span>
            </div>
            <div class="theatre-timeline-legend">
              <span class="theatre-legend-item"><span class="theatre-legend-dot" style="background:#ef4444"></span> Attaque</span>
              <span class="theatre-legend-item"><span class="theatre-legend-dot" style="background:#facc15"></span> Nuke</span>
              <span class="theatre-legend-item"><span class="theatre-legend-dot" style="background:#34d399"></span> Alliance</span>
              <span class="theatre-legend-item"><span class="theatre-legend-dot" style="background:#a855f7"></span> Trahison</span>
              <span class="theatre-legend-item"><span class="theatre-legend-dot" style="background:#6b7280"></span> Élimination</span>
              <span class="theatre-legend-item"><span class="theatre-legend-dot" style="background:var(--orange)"></span> Victoire</span>
            </div>
          </div>
        </div>

        <!-- Events list -->
        <div class="theatre-section" style="margin-top:16px">
          <div class="theatre-section-header">Événements (${events.length})</div>
          <div class="theatre-section-body">
            <table class="theatre-player-table">
              <thead><tr><th>Temps</th><th>Type</th><th>Événement</th></tr></thead>
              <tbody>
                ${events.map(e => `
                  <tr>
                    <td class="num" style="width:80px">${fmtTime(e.time)}</td>
                    <td style="width:100px"><span class="theatre-legend-dot" style="background:${getEventColor(e.type)};display:inline-block;vertical-align:middle;margin-right:4px"></span>${esc(e.type)}</td>
                    <td>${esc(e.text)}</td>
                  </tr>
                `).join("")}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <!-- Diplomacy tab -->
      <div class="theatre-tab-content" id="tab-diplomacy">
        <div class="theatre-section">
          <div class="theatre-section-header">Graphe diplomatique</div>
          <div class="theatre-diplomacy">
            <canvas class="theatre-diplomacy-canvas" id="diplomacy-canvas"></canvas>
          </div>
        </div>
        ${players.filter(p => p.betrayals > 0).length > 0 ? `
        <div class="theatre-section" style="margin-top:16px">
          <div class="theatre-section-header">Trahisons</div>
          <div class="theatre-section-body">
            <table class="theatre-player-table">
              <thead><tr><th>Joueur</th><th class="num">Trahisons</th></tr></thead>
              <tbody>
                ${players.filter(p => p.betrayals > 0).map(p => `<tr><td class="theatre-player-name">${esc(p.username)}</td><td class="num">${p.betrayals}</td></tr>`).join("")}
              </tbody>
            </table>
          </div>
        </div>` : ""}
      </div>

      <!-- Git commit info -->
      <div style="padding:12px 18px;background:var(--bg-subtle);border-radius:8px;font-size:12px;color:var(--muted);display:flex;gap:16px;flex-wrap:wrap;align-items:center">
        <span>🔧 Commit: <code style="color:var(--orange)">${esc(game.gitCommit?.slice(0,12) || "?")}</code></span>
        <span>📦 Version: ${esc(game.raw?.version || "?")}</span>
        <span>🆔 Game ID: <code>${esc(game.gameId)}</code></span>
        <a href="${API_BASE}/public/game/${esc(game.gameId)}" target="_blank" rel="noopener" style="color:var(--orange);text-decoration:none">Voir JSON brut →</a>
      </div>
    </div>
  `;

  // Wire tabs
  document.querySelectorAll(".theatre-tab").forEach(tab => {
    tab.addEventListener("click", () => {
      document.querySelectorAll(".theatre-tab").forEach(t => t.classList.remove("active"));
      document.querySelectorAll(".theatre-tab-content").forEach(c => c.classList.remove("active"));
      tab.classList.add("active");
      document.getElementById(`tab-${tab.dataset.tab}`).classList.add("active");
      // Render charts on tab open
      if (tab.dataset.tab === "economy") drawExpansionChart(players);
      if (tab.dataset.tab === "diplomacy") drawDiplomacyGraph(players);
    });
  });
}

function getEventColor(type) {
  const colors = { attack:"#ef4444", nuke:"#facc15", alliance:"#34d399", betrayal:"#a855f7", elimination:"#6b7280", victory:"var(--orange)" };
  return colors[type] || "#999";
}

/* ═══ Charts (canvas, vanilla JS) ═══ */

function drawExpansionChart(players) {
  const canvas = document.getElementById("expansion-chart");
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  const W = canvas.offsetWidth;
  const H = 300;
  canvas.width = W * (window.devicePixelRatio || 1);
  canvas.height = H * (window.devicePixelRatio || 1);
  ctx.scale(window.devicePixelRatio || 1, window.devicePixelRatio || 1);
  ctx.clearRect(0, 0, W, H);

  // We don't have per-tick data (turns=false), so show final stats as bar chart
  const alive = players.filter(p => !p.isDead);
  const dead = players.filter(p => p.isDead);
  const all = [...alive, ...dead];
  const maxGold = Math.max(...all.map(p => p.gold), 1);
  const maxTiles = Math.max(...all.map(p => p.finalTiles), 1);

  const barH = 24;
  const gap = 6;
  const labelW = 120;
  const chartW = W - labelW - 60;
  let y = 10;

  // Title
  ctx.fillStyle = "#595959";
  ctx.font = "11px Inter, sans-serif";
  ctx.fillText("Tuiles contrôlées (fin de partie)", labelW, y - 4);
  y += 4;

  all.forEach((p, i) => {
    // Label
    ctx.fillStyle = p.isDead ? "#9ca3af" : "#232323";
    ctx.font = "12px Inter, sans-serif";
    ctx.textAlign = "right";
    const name = p.username.length > 14 ? p.username.slice(0, 12) + "…" : p.username;
    ctx.fillText(name, labelW - 8, y + barH / 2 + 4);
    ctx.textAlign = "left";

    // Bar
    const tilePct = p.finalTiles / maxTiles;
    const barW = tilePct * chartW;
    ctx.fillStyle = p.isDead ? "#d1d5db" : "#ff7a00";
    ctx.fillRect(labelW, y, barW, barH);

    // Value
    ctx.fillStyle = "#232323";
    ctx.font = "11px JetBrains Mono, monospace";
    ctx.fillText(fmtNum(p.finalTiles), labelW + barW + 6, y + barH / 2 + 4);

    y += barH + gap;
  });

  // Gold section
  y += 16;
  ctx.fillStyle = "#595959";
  ctx.font = "11px Inter, sans-serif";
  ctx.fillText("Or final", labelW, y - 4);
  y += 4;

  all.forEach((p, i) => {
    const goldPct = p.gold / maxGold;
    const barW = goldPct * chartW;
    ctx.fillStyle = p.isDead ? "#d1d5db" : "#fbbf24";
    ctx.fillRect(labelW, y, barW, barH);
    ctx.fillStyle = "#232323";
    ctx.font = "11px JetBrains Mono, monospace";
    ctx.fillText(fmtNum(p.gold), labelW + barW + 6, y + barH / 2 + 4);
    y += barH + gap;
  });
}

function drawDiplomacyGraph(players) {
  const canvas = document.getElementById("diplomacy-canvas");
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  const W = canvas.offsetWidth;
  const H = 350;
  canvas.width = W * (window.devicePixelRatio || 1);
  canvas.height = H * (window.devicePixelRatio || 1);
  ctx.scale(window.devicePixelRatio || 1, window.devicePixelRatio || 1);
  ctx.clearRect(0, 0, W, H);

  // Position players in a circle
  const cx = W / 2, cy = H / 2;
  const radius = Math.min(W, H) / 2 - 60;
  const n = players.length;
  const positions = players.map((p, i) => ({
    x: cx + Math.cos((i / n) * Math.PI * 2 - Math.PI / 2) * radius,
    y: cy + Math.sin((i / n) * Math.PI * 2 - Math.PI / 2) * radius,
  }));

  // Draw attack lines
  players.forEach((p, i) => {
    if (p.attackTargets) {
      p.attackTargets.forEach(targetIdx => {
        const target = parseInt(targetIdx);
        if (target < n && target !== i) {
          ctx.strokeStyle = "rgba(239,68,68,0.3)";
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          ctx.moveTo(positions[i].x, positions[i].y);
          ctx.lineTo(positions[target].x, positions[target].y);
          ctx.stroke();
        }
      });
    }
  });

  // Draw nodes
  positions.forEach((pos, i) => {
    const p = players[i];
    const r = p.isDead ? 10 : 16;
    // Glow
    if (!p.isDead) {
      ctx.fillStyle = "rgba(255,122,0,0.15)";
      ctx.beginPath();
      ctx.arc(pos.x, pos.y, r + 8, 0, Math.PI * 2);
      ctx.fill();
    }
    // Circle
    ctx.fillStyle = p.isDead ? "#d1d5db" : "#ff7a00";
    ctx.beginPath();
    ctx.arc(pos.x, pos.y, r, 0, Math.PI * 2);
    ctx.fill();
    // Name
    ctx.fillStyle = p.isDead ? "#9ca3af" : "#232323";
    ctx.font = "11px Inter, sans-serif";
    ctx.textAlign = "center";
    const name = p.username.length > 12 ? p.username.slice(0, 10) + "…" : p.username;
    ctx.fillText(name, pos.x, pos.y + r + 14);
  });

  // Legend
  ctx.fillStyle = "#595959";
  ctx.font = "11px Inter, sans-serif";
  ctx.textAlign = "left";
  ctx.fillText("🔴 Lignes = attaques dirigées", 10, H - 20);
  ctx.fillText("🟠 Cercles = joueurs (gris = éliminés)", 10, H - 6);
}

/* ═══ Recent games ═══ */

async function loadRecentGames() {
  const listEl = document.getElementById("theatre-recent-list");
  if (!listEl) return;
  try {
    // Fetch a known active player's recent games
    // Fetch via CORS proxy (API doesn't allow cross-origin)
    const gameUrl = `${API_BASE}/public/player/CpomD1Nt/games?limit=6`;
    const encodedUrl = encodeURIComponent(gameUrl);
    const proxies = [
      `https://corsproxy.io/?url=${encodedUrl}`,
      `https://api.codetabs.com/v1/proxy/?quest=${encodedUrl}`,
      `https://api.allorigins.win/raw?url=${encodedUrl}`,
    ];
    let res = null;
    for (const proxyUrl of proxies) {
      try { res = await fetch(proxyUrl); if (res && res.ok) break; } catch { continue; }
    }
    if (!res || !res.ok) throw new Error("API error");
    const data = await res.json();
    const games = data.results || data.games || [];
    if (!games.length) {
      listEl.innerHTML = "<div style='color:var(--muted);font-size:13px;padding:12px'>Aucune partie récente.</div>";
      return;
    }
    listEl.innerHTML = games.map(g => `
      <div class="theatre-recent-item" data-game-id="${esc(g.gameId)}">
        <div class="theatre-recent-info">
          <div class="theatre-recent-map">${esc(g.map || "Unknown")}</div>
          <div class="theatre-recent-meta">${esc(g.mode || "?")} · ${fmtTime(g.durationSeconds)} · ${fmtDate(g.start)}</div>
        </div>
        <span class="theatre-recent-result ${g.result === "victory" ? "victory" : "defeat"}">${g.result === "victory" ? "Victoire" : "Défaite"}</span>
      </div>
    `).join("");
    listEl.querySelectorAll(".theatre-recent-item").forEach(item => {
      item.addEventListener("click", () => {
        GAME_INPUT.value = item.dataset.gameId;
        analyzeGameId();
      });
    });
  } catch (e) {
    listEl.innerHTML = "<div style='color:var(--muted);font-size:13px;padding:12px'>Impossible de charger les parties récentes.</div>";
  }
}

/* ═══ Init ═══ */

async function analyzeGameId() {
  const raw = GAME_INPUT.value;
  const gameId = parseGameId(raw);
  if (!gameId) {
    showError("ID de partie invalide. Utilisez un ID comme SFXXaPJc ou une URL openfront.io.");
    return;
  }
  ERROR_MSG.style.display = "none";
  ANALYZE_BTN.disabled = true;
  showLoading("Récupération des données de partie…");

  try {
    const game = await fetchGame(gameId);
    showLoading("Analyse des joueurs et événements…");
    await new Promise(r => setTimeout(r, 300)); // Small delay for UX
    const analysis = analyzeGame(game);
    currentGame = { game, analysis };
    renderDashboard(game, analysis);

    // Update URL with game ID
    history.replaceState(null, "", `?g=${gameId}`);
  } catch (e) {
    THEATRE_VIEW.innerHTML = ""; // Clear loading
    showError(e.message);
    console.error("[theatre] Error:", e);
  } finally {
    ANALYZE_BTN.disabled = false;
  }
}

// Wire events
ANALYZE_BTN.addEventListener("click", analyzeGameId);
GAME_INPUT.addEventListener("keydown", (e) => {
  if (e.key === "Enter") analyzeGameId();
});

// Check URL for ?g=gameId
const urlParams = new URLSearchParams(window.location.search);
const urlGameId = urlParams.get("g");
if (urlGameId) {
  GAME_INPUT.value = urlGameId;
  analyzeGameId();
} else {
  loadRecentGames();
}
