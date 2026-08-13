// lobby.js — Lobby Preview (parties OpenFront en temps réel)
// Connexion WebSocket à wss://openfront.io/{worker}/lobbies
// Affiche les parties en cours en 3 colonnes (FFA / Team / Special) + prochaine partie.

const LOBBY_VIEW = document.getElementById("lobby-view");
const LOBBY_STATUS = document.getElementById("lobby-status");

// Workers pool (OpenFront load-balances between w0-w4)
const WORKER_POOL = ["w0", "w1", "w2", "w3", "w4"];

let ws = null;
let reconnectTimer = null;
let currentGames = { ffa: [], team: [], special: [] };

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

function getMapThumbnailUrl(mapName) {
  if (typeof mapName !== "string") mapName = "";
  const slug = mapName.toLowerCase().replace(/[\s_]/g, "").replace(/[^\w]/g, "");
  return `https://raw.githubusercontent.com/openfrontio/OpenFrontIO/main/resources/maps/${slug}/thumbnail.webp`;
}

function formatStartsAt(timestamp) {
  if (!timestamp) return "";
  const now = Date.now();
  const start = new Date(timestamp).getTime();
  const diff = start - now;
  if (diff < 0) return "En cours";
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "Imminent";
  if (mins < 60) return `Dans ${mins} min`;
  const hours = Math.floor(mins / 60);
  return `Dans ${hours}h${mins % 60 ? " " + (mins % 60) + "min" : ""}`;
}

function getDifficultyLabel(cfg) {
  if (!cfg) return "";
  const diff = cfg.difficulty || cfg.diff;
  if (!diff) return "";
  const d = String(diff).toLowerCase();
  if (d.includes("easy") || d === "0") return { label: "Easy", cls: "easy" };
  if (d.includes("medium") || d === "1") return { label: "Medium", cls: "medium" };
  if (d.includes("hard") || d === "2") return { label: "Hard", cls: "hard" };
  return null;
}

/* ════════════════════════════════════════════════════════════════
   Connexion WebSocket
   ════════════════════════════════════════════════════════════════ */

function connect() {
  const worker = WORKER_POOL[Math.floor(Math.random() * WORKER_POOL.length)];
  const url = `wss://openfront.io/${worker}/lobbies`;

  console.log(`[lobby] Connecting to ${url}…`);
  setStatus("connecting", "Connexion…");

  try {
    ws = new WebSocket(url);
  } catch (e) {
    console.error("[lobby] WebSocket init failed:", e);
    scheduleReconnect();
    return;
  }

  ws.onopen = () => {
    console.log("[lobby] ✅ Connected");
    setStatus("connected", "En direct");
  };

  ws.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      handleLobbyData(data);
    } catch (e) {
      console.warn("[lobby] Parse error:", e.message);
    }
  };

  ws.onerror = (e) => {
    console.error("[lobby] WebSocket error");
    setStatus("error", "Erreur");
  };

  ws.onclose = () => {
    console.log("[lobby] Disconnected");
    setStatus("connecting", "Reconnexion…");
    scheduleReconnect();
  };
}

function scheduleReconnect() {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(connect, 3000);
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
   Traitement des données
   ════════════════════════════════════════════════════════════════ */

function handleLobbyData(data) {
  // Le serveur envoie soit un array de games, soit un objet avec games
  const games = Array.isArray(data) ? data : (data.games || data.lobbies || []);
  if (!games.length) {
    currentGames = { ffa: [], team: [], special: [] };
    renderEmpty();
    return;
  }

  // Bucket les games par catégorie
  const buckets = { ffa: [], team: [], special: [] };
  for (const game of games) {
    const cat = game.raw?.__rawType || game.raw?.publicGameType || game.category || "ffa";
    const key = String(cat).toLowerCase();
    if (key.includes("team")) buckets.team.push(game);
    else if (key.includes("special")) buckets.special.push(game);
    else buckets.ffa.push(game);
  }

  // Trier par startsAt (les plus prochaines en premier)
  for (const k of Object.keys(buckets)) {
    buckets[k].sort((a, b) => (a.startsAt || 0) - (b.startsAt || 0));
  }

  currentGames = buckets;
  render();
}

/* ════════════════════════════════════════════════════════════════
   Rendu
   ════════════════════════════════════════════════════════════════ */

function renderEmpty() {
  if (!LOBBY_VIEW) return;
  LOBBY_VIEW.innerHTML = `
    <div class="lobby-empty">
      <div style="font-size:40px">🎮</div>
      <h3>Aucune partie en cours</h3>
      <p>Les parties OpenFront apparaîtront ici en temps réel dès qu'elles seront créées.</p>
    </div>
  `;
}

function render() {
  if (!LOBBY_VIEW) return;

  // Trouver la prochaine partie (toutes catégories confondues, la plus proche dans le temps)
  const allGames = [...currentGames.ffa, ...currentGames.team, ...currentGames.special];
  const upcoming = allGames
    .filter(g => g.startsAt && new Date(g.startsAt).getTime() > Date.now())
    .sort((a, b) => new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime())[0];

  const nextHtml = upcoming ? renderNextGame(upcoming) : "";

  LOBBY_VIEW.innerHTML = `
    ${nextHtml}
    <div class="lobby-columns">
      ${renderColumn("ffa", "FFA", currentGames.ffa)}
      ${renderColumn("team", "Team", currentGames.team)}
      ${renderColumn("special", "Special", currentGames.special)}
    </div>
  `;
}

function renderNextGame(game) {
  const name = game.map || "Partie OpenFront";
  const joined = game.joined ?? 0;
  const max = game.maxPlayers ?? game.cfg?.maxPlayers ?? "?";
  const teamCount = game.teamCount;
  const playersPerTeam = game.playersPerTeam;
  const startsIn = formatStartsAt(game.startsAt);
  const diff = getDifficultyLabel(game.cfg);
  const thumbUrl = getMapThumbnailUrl(game.map);
  const gameUrl = `https://openfront.io/game/${encodeURIComponent(game.id)}`;

  const teamInfo = teamCount && playersPerTeam
    ? `${teamCount} équipes × ${playersPerTeam}`
    : teamCount
    ? `${teamCount} équipes`
    : "";

  return `
    <div class="lobby-next">
      <div class="lobby-next-thumb">
        <img src="${escapeHtml(thumbUrl)}" alt="${escapeHtml(name)}" onerror="this.style.display='none';this.parentElement.innerHTML='<div class=\\'lobby-game-thumb-fallback\\'>🗺️</div>'">
      </div>
      <div class="lobby-next-content">
        <div class="lobby-next-label">🎮 Prochaine partie ${startsIn ? '· ' + escapeHtml(startsIn) : ''}</div>
        <h2 class="lobby-next-name">${escapeHtml(name)}</h2>
        <div class="lobby-next-meta">
          <span class="lobby-next-meta-item">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
            ${joined}/${max} joueurs
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
  const joined = game.joined ?? 0;
  const max = game.maxPlayers ?? game.cfg?.maxPlayers ?? "?";
  const teamCount = game.teamCount;
  const playersPerTeam = game.playersPerTeam;
  const startsIn = formatStartsAt(game.startsAt);
  const diff = getDifficultyLabel(game.cfg);
  const thumbUrl = getMapThumbnailUrl(game.map);
  const gameUrl = `https://openfront.io/game/${encodeURIComponent(game.id)}`;
  const isFull = typeof max === "number" && joined >= max;

  const teamInfo = teamCount && playersPerTeam
    ? `${teamCount}×${playersPerTeam}`
    : teamCount
    ? `${teamCount} teams`
    : "";

  return `
    <a class="lobby-game" href="${escapeHtml(gameUrl)}" target="_blank" rel="noopener" style="animation-delay:${Math.min(index, 10) * 0.04}s">
      <div class="lobby-game-thumb">
        <img src="${escapeHtml(thumbUrl)}" alt="${escapeHtml(name)}" loading="lazy" onerror="this.style.display='none';this.parentElement.innerHTML='<div class=\\'lobby-game-thumb-fallback\\'>🗺️</div>'">
      </div>
      <div class="lobby-game-info">
        <div class="lobby-game-name">${escapeHtml(name)}</div>
        <div class="lobby-game-meta">
          <span class="lobby-game-players ${isFull ? "full" : ""}">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/></svg>
            ${joined}/${max}
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
  if (Object.values(currentGames).some(arr => arr.length > 0)) {
    render();
  }
}, 30000);
