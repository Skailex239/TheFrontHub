// theatre.js — THEATRE: enregistreur/téléchargeur de replays OpenFront
// Collez un lien de game → récupère toutes les données (turns inclus) → téléchargement

const THEATRE_VIEW = document.getElementById("theatre-view");
const GAME_INPUT = document.getElementById("theatre-game-input");
const RECORD_BTN = document.getElementById("theatre-record-btn");
const ERROR_MSG = document.getElementById("theatre-error");

const API_BASE = "https://api.openfront.io";

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
function fmtBytes(bytes) {
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1048576) return (bytes / 1024).toFixed(1) + " KB";
  return (bytes / 1048576).toFixed(1) + " MB";
}

function parseGameId(input) {
  if (!input) return null;
  input = input.trim();
  const urlMatch = input.match(/(?:#join=|game\/)([A-Za-z0-9]+)/);
  if (urlMatch) return urlMatch[1];
  if (/^[A-Za-z0-9]{6,12}$/.test(input)) return input;
  return null;
}

/* ═══ Fetch via CORS proxy ═══ */

async function fetchViaProxy(url) {
  const encodedUrl = encodeURIComponent(url);
  const proxies = [
    `https://corsproxy.io/?url=${encodedUrl}`,
    `https://api.codetabs.com/v1/proxy/?quest=${encodedUrl}`,
    `https://api.allorigins.win/raw?url=${encodedUrl}`,
    url,
  ];
  for (const proxyUrl of proxies) {
    try {
      const res = await fetch(proxyUrl);
      if (res && res.ok) return res;
    } catch { continue; }
  }
  return null;
}

/* ═══ Ingestion ═══ */

async function fetchGameData(gameId) {
  console.log(`[theatre] Fetching game ${gameId} (with turns)…`);
  const gameUrl = `${API_BASE}/public/game/${gameId}?turns=true`;
  const res = await fetchViaProxy(gameUrl);
  if (!res) throw new Error("Partie introuvable ou API inaccessible. Vérifiez le lien.");

  const data = await res.json();
  if (data.error) throw new Error(data.error);

  const info = data.info || {};
  if (!info.end || !info.duration) {
    throw new Error("Cette partie n'est pas terminée. Revenez plus tard.");
  }

  return data;
}

/* ═══ Render ═══ */

function showLoading(step) {
  THEATRE_VIEW.innerHTML = `
    <div class="theatre-loading">
      <div class="spinner"></div>
      <div class="theatre-loading-text">${esc(step)}</div>
    </div>`;
}

function showError(msg) {
  ERROR_MSG.textContent = msg;
  ERROR_MSG.style.display = "block";
  setTimeout(() => { ERROR_MSG.style.display = "none"; }, 8000);
}

function renderGameRecord(gameData) {
  const info = gameData.info || {};
  const turns = gameData.turns || [];
  const players = info.players || [];
  const config = info.config || {};
  const winnerData = info.winner || [];
  const winnerId = winnerData.length >= 2 ? winnerData[1] : null;
  const winner = players.find(p => p.clientID === winnerId);

  const mapName = config.gameMap || "Unknown";
  const gameMode = config.gameMode || config.gameType || "—";
  const difficulty = config.difficulty || "—";
  const maxPlayers = config.maxPlayers || players.length;
  const bots = config.bots || 0;

  // Compute replay file size
  const replayJson = JSON.stringify(gameData, null, 2);
  const replaySize = new Blob([replayJson]).size;
  const replaySizeFmt = fmtBytes(replaySize);

  // Create download blob
  const blob = new Blob([replayJson], { type: "application/json" });
  const downloadUrl = URL.createObjectURL(blob);

  THEATRE_VIEW.innerHTML = `
    <div class="theatre-dashboard">
      <!-- Header -->
      <div class="theatre-game-header">
        <div>
          <h2 class="theatre-game-title">🎬 Enregistrement de partie</h2>
          <div class="theatre-game-meta">
            <span>🎮 ${esc(mapName)}</span>
            <span>⚔️ ${esc(gameMode)}</span>
            <span>📊 ${esc(difficulty)}</span>
            <span>👥 ${players.length}/${maxPlayers} joueurs</span>
            <span>🤖 ${bots} bots</span>
            <span>⏱️ ${fmtTime(info.duration)}</span>
            <span>🔄 ${fmtNum(info.num_turns)} tours</span>
            <span>📅 ${fmtDate(info.start)}</span>
          </div>
        </div>
        <button class="theatre-back-btn" onclick="location.reload()">← Nouvelle partie</button>
      </div>

      ${winner ? `
      <div class="theatre-winner">
        <span class="theatre-winner-trophy">🏆</span>
        <div class="theatre-winner-info">
          <div class="theatre-winner-label">Vainqueur</div>
          <div class="theatre-winner-name">${esc(winner.username)}${winner.clanTag ? ` <span style="color:var(--muted);font-size:14px">[${esc(winner.clanTag)}]</span>` : ""}</div>
        </div>
      </div>` : ""}

      <!-- Download section -->
      <div class="theatre-section">
        <div class="theatre-section-header">📥 Télécharger le replay</div>
        <div style="padding:24px;text-align:center">
          <p style="font-size:14px;color:var(--muted);margin:0 0 16px;line-height:1.6">
            Replay complet avec les ${fmtNum(turns.length)} tours d'inputs.<br>
            Format JSON · ${replaySizeFmt} · Commit: <code style="color:var(--orange)">${esc(gameData.gitCommit?.slice(0,12) || "?")}</code>
          </p>
          <a href="${downloadUrl}" download="openfront-replay-${esc(info.gameID || 'game')}.json" class="theatre-record-btn" style="display:inline-flex;text-decoration:none">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
            Télécharger le replay (${replaySizeFmt})
          </a>
          <p style="font-size:12px;color:var(--dim);margin:12px 0 0">
            Le fichier contient toutes les données : configuration, joueurs, tours d'inputs, statistiques finales.
          </p>
        </div>
      </div>

      <!-- Replay info -->
      <div class="theatre-stats-grid">
        <div class="theatre-stat-box"><span>${players.length}</span><label>Joueurs</label></div>
        <div class="theatre-stat-box"><span>${fmtNum(turns.length)}</span><label>Tours</label></div>
        <div class="theatre-stat-box"><span>${fmtTime(info.duration)}</span><label>Durée</label></div>
        <div class="theatre-stat-box"><span>${replaySizeFmt}</span><label>Taille replay</label></div>
        <div class="theatre-stat-box"><span>${players.filter(p => p.stats?.killedAt != null).length}</span><label>Éliminés</label></div>
        <div class="theatre-stat-box"><span>${esc(gameData.version || "?")}</span><label>Version</label></div>
      </div>

      <!-- Players -->
      <div class="theatre-section">
        <div class="theatre-section-header">Joueurs (${players.length})</div>
        <div class="theatre-section-body">
          <table class="theatre-player-table">
            <thead>
              <tr>
                <th>#</th><th>Joueur</th><th>Statut</th><th class="num">Tuiles</th><th class="num">Or</th><th class="num">Attaques</th><th class="num">Nukes</th>
              </tr>
            </thead>
            <tbody>
              ${players.map((p, i) => {
                const stats = p.stats || {};
                const isDead = stats.killedAt != null;
                const gold = stats.gold ? (Array.isArray(stats.gold) ? stats.gold[0] : stats.gold) : 0;
                const finalTiles = stats.finalTiles || 0;
                const attacks = (stats.attacks || []).length;
                return `
                  <tr>
                    <td class="theatre-player-rank">${i + 1}</td>
                    <td class="theatre-player-name ${isDead ? "theatre-player-dead" : ""}">${esc(p.username || `Player ${i}`)}${p.clanTag ? ` <span class="theatre-player-clan">[${esc(p.clanTag)}]</span>` : ""}</td>
                    <td>${isDead ? `<span style="color:var(--red);font-size:12px">💀 Tour ${stats.killedAt}</span>` : `<span style="color:var(--green);font-size:12px">✓ Vivant</span>`}</td>
                    <td class="num">${fmtNum(parseInt(finalTiles) || 0)}</td>
                    <td class="num">${fmtNum(parseInt(gold) || 0)}</td>
                    <td class="num">${attacks}</td>
                    <td class="num">${stats.bombs || 0}</td>
                  </tr>
                `;
              }).join("")}
            </tbody>
          </table>
        </div>
      </div>

      <!-- Turn preview -->
      <div class="theatre-section">
        <div class="theatre-section-header">Aperçu des tours (premiers inputs)</div>
        <div style="padding:16px 18px;font-family:var(--mono,monospace);font-size:12px;color:var(--muted);max-height:300px;overflow-y:auto;background:var(--bg-subtle);border-radius:0 0 12px 12px">
          ${turns.slice(0, 10).map((t, i) => {
            const intents = t.intents || [];
            const intentTypes = intents.map(intent => intent.type).slice(0, 5);
            return `<div style="padding:4px 0;border-bottom:1px solid var(--border-light)">
              <span style="color:var(--orange);font-weight:700">Tour ${t.turnNumber ?? i}:</span>
              <span style="color:var(--text)">${intents.length} inputs</span>
              <span style="color:var(--dim)"> — ${esc(intentTypes.join(", "))}${intents.length > 5 ? "…" : ""}</span>
            </div>`;
          }).join("")}
          ${turns.length > 10 ? `<div style="padding:8px 0;color:var(--dim);text-align:center">… et ${fmtNum(turns.length - 10)} autres tours dans le replay téléchargé</div>` : ""}
        </div>
      </div>

      <!-- Technical info -->
      <div style="padding:12px 18px;background:var(--bg-subtle);border-radius:8px;font-size:12px;color:var(--muted);display:flex;gap:16px;flex-wrap:wrap;align-items:center">
        <span>🔧 Commit: <code style="color:var(--orange)">${esc(gameData.gitCommit?.slice(0,12) || "?")}</code></span>
        <span>📦 Version: ${esc(gameData.version || "?")}</span>
        <span>🆔 Game ID: <code>${esc(info.gameID || "?")}</code></span>
        <span>🌐 Domain: ${esc(gameData.domain || "?")}</span>
        <a href="${API_BASE}/public/game/${esc(info.gameID || '')}" target="_blank" rel="noopener" style="color:var(--orange);text-decoration:none">Voir JSON brut →</a>
      </div>
    </div>
  `;
}

/* ═══ Recent games ═══ */

async function loadRecentGames() {
  const listEl = document.getElementById("theatre-recent-list");
  if (!listEl) return;
  try {
    const gameUrl = `${API_BASE}/public/player/CpomD1Nt/games?limit=6`;
    const res = await fetchViaProxy(gameUrl);
    if (!res) throw new Error("API error");
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
        recordGame();
      });
    });
  } catch {
    listEl.innerHTML = "<div style='color:var(--muted);font-size:13px;padding:12px'>Impossible de charger les parties récentes.</div>";
  }
}

/* ═══ Init ═══ */

async function recordGame() {
  const raw = GAME_INPUT.value;
  const gameId = parseGameId(raw);
  if (!gameId) {
    showError("Lien invalide. Collez un ID comme SFXXaPJc ou une URL openfront.io.");
    return;
  }
  ERROR_MSG.style.display = "none";
  RECORD_BTN.disabled = true;
  showLoading("Récupération de l'enregistrement complet (tours inclus)…");

  try {
    const gameData = await fetchGameData(gameId);
    showLoading("Préparation du téléchargement…");
    await new Promise(r => setTimeout(r, 300));
    renderGameRecord(gameData);
    history.replaceState(null, "", `?g=${gameId}`);
  } catch (e) {
    THEATRE_VIEW.innerHTML = "";
    showError(e.message);
    console.error("[theatre] Error:", e);
  } finally {
    RECORD_BTN.disabled = false;
  }
}

// Wire events
RECORD_BTN.addEventListener("click", recordGame);
GAME_INPUT.addEventListener("keydown", (e) => {
  if (e.key === "Enter") recordGame();
});

// Check URL for ?g=gameId
const urlParams = new URLSearchParams(window.location.search);
const urlGameId = urlParams.get("g");
if (urlGameId) {
  GAME_INPUT.value = urlGameId;
  recordGame();
} else {
  loadRecentGames();
}
