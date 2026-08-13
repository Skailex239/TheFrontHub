// lobby.js — Lobby Preview (parties OpenFront en temps réel)
// Méthode reprise exactement de minhkarl.github.io et zeldableu.github.io
// WebSocket wss://openfront.io/{w0-w4}/lobbies
// Le serveur envoie :
//   1. Full snapshot : { serverTime, games: { ffa:[...], team:[...], special:[...] } }
//   2. Count update  : { type:"counts", counts: { gameID: number }, serverTime }
// Chaque game a : gameID, publicGameType, numClients, startsAt, gameConfig { maxPlayers, gameMap, difficulty, playerTeams, ... }

const LOBBY_VIEW = document.getElementById("lobby-view");
const LOBBY_STATUS = document.getElementById("lobby-status");

const WORKER_POOL = ["w0", "w1", "w2", "w3", "w4"];
const WS_URL = (w) => `wss://openfront.io/${w}/lobbies`;

let ws = null;
let wsGen = 0;
let reconnectTimer = null;
let retries = 0;
let snapshot = null; // { serverTime, games: { ffa:[], team:[], special:[] } }
let renderTimer = null;

/* ════════════════════════════════════════════════════════════════
   Utilitaires
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

function mapSlug(mapName) {
  if (typeof mapName !== "string") return "";
  return mapName.toLowerCase().replace(/[\s_]/g, "").replace(/[^\w]/g, "");
}

function getMapThumbnailUrl(mapName) {
  const slug = mapSlug(mapName);
  if (!slug) return "";
  return `https://raw.githubusercontent.com/openfrontio/OpenFrontIO/main/resources/maps/${slug}/thumbnail.webp`;
}

function formatStartsAt(startsAt, serverTime) {
  if (!startsAt) return "";
  const now = serverTime || Date.now();
  const diff = startsAt - now;
  if (diff <= 0) return "En cours";
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "Imminent";
  if (mins < 60) return `Dans ${mins} min`;
  const hours = Math.floor(mins / 60);
  const remMins = mins % 60;
  return `Dans ${hours}h${remMins ? " " + remMins + "min" : ""}`;
}

function getDifficultyLabel(diff) {
  if (!diff) return null;
  const d = String(diff).toLowerCase();
  if (d.includes("easy") || d === "0") return { label: "Easy", cls: "easy" };
  if (d.includes("medium") || d === "1") return { label: "Medium", cls: "medium" };
  if (d.includes("hard") || d === "2") return { label: "Hard", cls: "hard" };
  return null;
}

/* ════════════════════════════════════════════════════════════════
   Normalisation d'une game (méthode zeldableu)
   ════════════════════════════════════════════════════════════════ */

function normalizeGame(raw) {
  const cfg = raw.gameConfig || raw.cfg || {};
  const capacity = Number(cfg.maxPlayers) || 0;
  const playerTeams = cfg.playerTeams || [];
  let teams = 0, perTeam = 0;
  if (Array.isArray(playerTeams) && playerTeams.length > 0) {
    teams = playerTeams.length;
    perTeam = Math.max(...playerTeams.map(t => Number(t) || 0));
  } else if (capacity > 0) {
    teams = 1;
    perTeam = capacity;
  }

  return {
    id: raw.gameID || raw.id || "",
    cat: raw.publicGameType || "ffa",
    players: Number(raw.numClients) || 0,
    capacity,
    map: cfg.gameMap || raw.map || "?",
    difficulty: cfg.difficulty || "",
    teams,
    perTeam,
    startsAt: Number(raw.startsAt) || 0,
    gameConfig: cfg,
  };
}

/* ════════════════════════════════════════════════════════════════
   Connexion WebSocket (méthode exacte minhkarl + zeldableu)
   ════════════════════════════════════════════════════════════════ */

function connect() {
  closeSocket();
  const gen = ++wsGen;
  const worker = WORKER_POOL[Math.floor(Math.random() * WORKER_POOL.length)];
  setStatus("connecting", "Connexion…");

  console.log(`[lobby] Connecting to ${WS_URL(worker)}…`);

  let socket;
  try {
    socket = new WebSocket(WS_URL(worker));
  } catch (e) {
    console.error("[lobby] WebSocket init failed:", e);
    scheduleReconnect(gen);
    return;
  }
  ws = socket;

  // Timeout connexion (12s comme minhkarl)
  const connectTimeout = setTimeout(() => {
    if (gen !== wsGen || socket.readyState === WebSocket.OPEN) return;
    setStatus("error", "Timeout");
    try { socket.close(); } catch {}
  }, 12000);

  socket.onopen = () => {
    if (gen !== wsGen) return;
    clearTimeout(connectTimeout);
    retries = 0;
    setStatus("connected", "En direct");
    console.log("[lobby] ✅ Connected");
  };

  socket.onmessage = (event) => {
    if (gen !== wsGen) return;
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }
    applyMessage(msg);
  };

  socket.onclose = () => {
    if (gen !== wsGen) return;
    clearTimeout(connectTimeout);
    setStatus("connecting", "Reconnexion…");
    scheduleReconnect(gen);
  };

  socket.onerror = () => {
    if (gen !== wsGen) return;
    setStatus("error", "Erreur");
    try { socket.close(); } catch {}
  };
}

function closeSocket() {
  if (!ws) return;
  ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
  try { ws.close(); } catch {}
  ws = null;
}

function scheduleReconnect(gen) {
  if (gen !== wsGen) return;
  retries++;
  // Backoff exponentiel comme zeldableu (1s, 2s, 4s, 8s, 15s max)
  const delay = Math.min(1000 * Math.pow(2, retries - 1), 15000);
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => {
    if (gen === wsGen) connect();
  }, delay);
}

function setStatus(state, text) {
  if (!LOBBY_STATUS) return;
  LOBBY_STATUS.className = "lobby-status";
  if (state === "connected") LOBBY_STATUS.classList.add("connected");
  else if (state === "error") LOBBY_STATUS.classList.add("error");
  const textEl = LOBBY_STATUS.querySelector(".lobby-status-text");
  if (textEl) textEl.textContent = text;
}

/* ════════════════════════════════════════════════════════════════
   Traitement des messages (méthode exacte minhkarl + zeldableu)
   ════════════════════════════════════════════════════════════════ */

function applyMessage(msg) {
  if (!msg || typeof msg !== "object") return;

  let serverTime = Date.now();
  if (typeof msg.serverTime === "number") {
    serverTime = msg.serverTime;
  }

  // Count update : { type:"counts", counts:{ gameID: number } }
  if (msg.type === "counts" && msg.counts) {
    if (!snapshot || !snapshot.games) return;
    for (const cat of Object.keys(snapshot.games)) {
      for (const game of snapshot.games[cat]) {
        const id = game.id;
        if (id && Object.prototype.hasOwnProperty.call(msg.counts, id)) {
          game.players = Number(msg.counts[id]) || 0;
        }
      }
    }
    snapshot.serverTime = serverTime;
    scheduleRender();
    return;
  }

  // Full snapshot : { games: { ffa:[...], team:[...], special:[...] } }
  if (msg.games && typeof msg.games === "object") {
    const normalized = { ffa: [], team: [], special: [] };
    for (const cat of Object.keys(normalized)) {
      const list = msg.games[cat];
      if (Array.isArray(list)) {
        normalized[cat] = list
          .filter(g => g && (g.gameID || g.id))
          .map(normalizeGame);
      }
    }
    snapshot = { serverTime, games: normalized };
    console.log(`[lobby] Snapshot: ${normalized.ffa.length} FFA, ${normalized.team.length} Team, ${normalized.special.length} Special`);
    scheduleRender();
    return;
  }
}

/* ════════════════════════════════════════════════════════════════
   Rendu (adapté au style TheFrontHub)
   ════════════════════════════════════════════════════════════════ */

function scheduleRender() {
  if (renderTimer) return;
  renderTimer = setTimeout(() => {
    renderTimer = null;
    render();
  }, 100);
}

function render() {
  if (!LOBBY_VIEW) return;
  if (!snapshot || !snapshot.games) {
    LOBBY_VIEW.innerHTML = `
      <div class="lobby-loading">
        <div class="spinner"></div>
        <p>Connexion aux serveurs OpenFront…</p>
      </div>
    `;
    return;
  }

  const { ffa, team, special } = snapshot.games;
  const totalGames = ffa.length + team.length + special.length;

  if (totalGames === 0) {
    LOBBY_VIEW.innerHTML = `
      <div class="lobby-empty">
        <div style="font-size:40px">🎮</div>
        <h3>Aucune partie en cours</h3>
        <p>Les parties OpenFront apparaîtront ici en temps réel dès qu'elles seront créées.</p>
      </div>
    `;
    return;
  }

  // Trouver la prochaine partie (la plus proche dans le temps, toutes catégories)
  const allGames = [...ffa, ...team, ...special]
    .filter(g => g.startsAt && g.startsAt > snapshot.serverTime)
    .sort((a, b) => a.startsAt - b.startsAt);
  const nextGame = allGames[0] || null;

  LOBBY_VIEW.innerHTML = `
    ${nextGame ? renderNextGame(nextGame) : ""}
    <div class="lobby-columns">
      ${renderColumn("ffa", "FFA", ffa)}
      ${renderColumn("team", "Team", team)}
      ${renderColumn("special", "Special", special)}
    </div>
  `;
}

function renderNextGame(game) {
  const name = game.map || "Partie OpenFront";
  const players = game.players || 0;
  const max = game.capacity || "?";
  const startsIn = formatStartsAt(game.startsAt, snapshot.serverTime);
  const diff = getDifficultyLabel(game.difficulty);
  const thumbUrl = getMapThumbnailUrl(game.map);
  const gameUrl = `https://openfront.io/game/${encodeURIComponent(game.id)}`;

  const teamInfo = game.teams > 1
    ? `${game.teams} équipes × ${game.perTeam}`
    : "";

  return `
    <div class="lobby-next">
      <div class="lobby-next-thumb">
        ${thumbUrl
          ? `<img src="${escapeHtml(thumbUrl)}" alt="${escapeHtml(name)}" onerror="this.parentElement.innerHTML='<div class=&quot;lobby-game-thumb-fallback&quot;>🗺️</div>'">`
          : `<div class="lobby-game-thumb-fallback">🗺️</div>`}
      </div>
      <div class="lobby-next-content">
        <div class="lobby-next-label">🎮 Prochaine partie${startsIn ? " · " + escapeHtml(startsIn) : ""}</div>
        <h2 class="lobby-next-name">${escapeHtml(name)}</h2>
        <div class="lobby-next-meta">
          <span class="lobby-next-meta-item">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
            ${players}/${max} joueurs
          </span>
          ${teamInfo ? `<span class="lobby-next-meta-item">⚔️ ${escapeHtml(teamInfo)}</span>` : ""}
          ${diff ? `<span class="lobby-game-difficulty ${diff.cls}">${escapeHtml(diff.label)}</span>` : ""}
        </div>
      </div>
      <div class="lobby-next-join">
        <a href="${escapeHtml(gameUrl)}" target="_blank" rel="noopener">
          Rejoindre
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg>
        </a>
      </div>
    </div>
  `;
}

function renderColumn(key, label, games) {
  const cards = games.slice(0, 20).map((g, i) => renderGameCard(g, i)).join("");

  return `
    <section class="lobby-column lobby-column-${key}">
      <div class="lobby-column-header">
        <span class="lobby-column-title">${escapeHtml(label)}</span>
        <span class="lobby-column-count">${games.length}</span>
      </div>
      ${cards || `<div class="lobby-column-empty">Aucune partie ${escapeHtml(label)} en cours</div>`}
    </section>
  `;
}

function renderGameCard(game, index) {
  const name = game.map || "Partie";
  const players = game.players || 0;
  const max = game.capacity || "?";
  const startsIn = formatStartsAt(game.startsAt, snapshot.serverTime);
  const diff = getDifficultyLabel(game.difficulty);
  const thumbUrl = getMapThumbnailUrl(game.map);
  const gameUrl = `https://openfront.io/game/${encodeURIComponent(game.id)}`;
  const isFull = typeof max === "number" && players >= max;

  const teamInfo = game.teams > 1
    ? `${game.teams}×${game.perTeam}`
    : "";

  return `
    <a class="lobby-game" href="${escapeHtml(gameUrl)}" target="_blank" rel="noopener" style="animation-delay:${Math.min(index, 10) * 0.04}s">
      <div class="lobby-game-thumb">
        ${thumbUrl
          ? `<img src="${escapeHtml(thumbUrl)}" alt="${escapeHtml(name)}" loading="lazy" onerror="this.parentElement.innerHTML='<div class=&quot;lobby-game-thumb-fallback&quot;>🗺️</div>'">`
          : `<div class="lobby-game-thumb-fallback">🗺️</div>`}
      </div>
      <div class="lobby-game-info">
        <div class="lobby-game-name">${escapeHtml(name)}</div>
        <div class="lobby-game-meta">
          <span class="lobby-game-players ${isFull ? "full" : ""}">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/></svg>
            ${players}/${max}
          </span>
          ${teamInfo ? `<span>${escapeHtml(teamInfo)}</span>` : ""}
          ${diff ? `<span class="lobby-game-difficulty ${diff.cls}">${escapeHtml(diff.label)}</span>` : ""}
          ${startsIn ? `<span>${escapeHtml(startsIn)}</span>` : ""}
        </div>
      </div>
      <div class="lobby-game-join">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg>
      </div>
    </a>
  `;
}

/* ════════════════════════════════════════════════════════════════
   Init
   ════════════════════════════════════════════════════════════════ */

connect();

// Re-render toutes les 30s pour mettre à jour les "Dans X min"
setInterval(() => {
  if (snapshot && snapshot.games) {
    scheduleRender();
  }
}, 30000);

// Cleanup on page hide
document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    // Tab hidden — on garde la connexion mais on arrête le refresh
  } else {
    // Tab visible again — force refresh
    if (snapshot && snapshot.games) {
      scheduleRender();
    }
  }
});
