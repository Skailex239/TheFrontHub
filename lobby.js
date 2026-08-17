// lobby.js — Live Feed (Twitter/X timeline style)
// WebSocket wss://openfront.io/{w0-w4}/lobbies
// + History of recently ended games (recentHistory)
// v7 — full render() rewrite for LOBBY-FEED-1.

const LOBBY_VIEW = document.getElementById("lobby-view");

const WORKER_POOL = ["w0", "w1", "w2", "w3", "w4"];
const WS_URL = (w) => `wss://openfront.io/${w}/lobbies`;

const MOD_LABEL = new Map(Object.entries({
  compact:        "Compact",
  hardNations:    "Nations diff.",
  waterNukes:     "Nukes marines",
  noNations:      "Sans nations",
  infiniteGold:   "Or infini",
  infiniteTroops: "Troupes infinies",
  instantBuild:   "Build instant",
  randomSpawn:    "Spawn aléa.",
  donateGold:     "Don d'or",
  donateTroops:   "Don de troupes",
  noClanTags:     "Sans tags",
  disabledUnits:  "Unités désact.",
}));
const DULL_MODS = new Set(["donateGold", "donateTroops", "noClanTags", "noNations"]);
const KNOWN_PM = new Set(["isCompact", "isHardNations", "isWaterNukes"]);
const TEAM_WORDS = { duos: 2, trios: 3, quads: 4, quints: 5, sextets: 6 };
const SIZE_WORDS = { 2: "Duos", 3: "Trios", 4: "Quads" };

let ws = null;
let wsGen = 0;
let reconnectTimer = null;
let retries = 0;
let snapshot = null;
let renderTimer = null;
let historyLoaded = false;
let recentHistory = []; // games qui viennent de quitter le lobby (terminées)
let prevGameIds = new Set(); // IDs présents au snapshot précédent

/* Live Feed state */
let currentFilter = "all"; // all | ffa | team | special
let seenGameIds = new Set(); // all game IDs ever rendered (for slide-in detection)
let tabsWired = false;

/* ═══ Utilitaires ═══ */

function escapeHtml(s) {
  if (s == null) return "";
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
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

function humanize(k) {
  return k.replace(/^is(?=[A-Z])/, "").replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/^./, c => c.toUpperCase());
}

function pmKey(k) {
  const bare = k.replace(/^is(?=[A-Z])/, "");
  return bare.charAt(0).toLowerCase() + bare.slice(1);
}

function modsOf(cfg) {
  const set = new Set();
  const pm = cfg.publicGameModifiers || {};
  if (pm.isCompact || cfg.gameMapSize === "Compact") set.add("compact");
  if (pm.isHardNations) set.add("hardNations");
  if (pm.isWaterNukes || cfg.waterNukes) set.add("waterNukes");
  if (cfg.nations === "disabled") set.add("noNations");
  if (cfg.infiniteGold) set.add("infiniteGold");
  if (cfg.infiniteTroops) set.add("infiniteTroops");
  if (cfg.instantBuild) set.add("instantBuild");
  if (cfg.randomSpawn) set.add("randomSpawn");
  if (cfg.donateGold) set.add("donateGold");
  if (cfg.donateTroops) set.add("donateTroops");
  if (cfg.disableClanTags) set.add("noClanTags");
  if (Array.isArray(cfg.disabledUnits) && cfg.disabledUnits.length) set.add("disabledUnits");
  for (const [k, v] of Object.entries(pm)) {
    if (v !== true || KNOWN_PM.has(k)) continue;
    const key = pmKey(k);
    set.add(key);
    if (!MOD_LABEL.has(key)) MOD_LABEL.set(key, humanize(k));
  }
  return set;
}

function extrasOf(cfg) {
  const pm = cfg.publicGameModifiers || {};
  const out = [];
  for (const [k, v] of Object.entries(pm)) {
    if (typeof v !== "number") continue;
    if (k === "goldMultiplier") out.push(`Or ×${v}`);
    else out.push(`${humanize(k)} ${v}`);
  }
  return out;
}

function teamShape(playerTeams, capacity) {
  if (typeof playerTeams === "number" && playerTeams > 0)
    return { teams: playerTeams, perTeam: capacity ? Math.floor(capacity / playerTeams) : 0, hvn: false };
  if (typeof playerTeams === "string") {
    const key = playerTeams.trim().toLowerCase();
    if (key === "humans vs nations") return { teams: 0, perTeam: 0, hvn: true };
    const size = TEAM_WORDS[key];
    if (size) return { teams: capacity ? Math.floor(capacity / size) : 0, perTeam: size, hvn: false };
  }
  return { teams: 0, perTeam: 0, hvn: false };
}

function modeLabel(g) {
  if (g.hvn) return "Humains vs Nations";
  if (g.teams > 0) {
    const word = SIZE_WORDS[g.perTeam];
    return word ? `${word} · ${g.teams} équipes` : `${g.teams} équipes de ${g.perTeam}`;
  }
  return "Free For All";
}

function formatStartsAt(startsAt, serverTime) {
  if (!startsAt) return "";
  const now = serverTime || Date.now();
  const diff = startsAt - now;
  if (diff <= 0) return "En cours";
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "Imminent";
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60);
  return `${h}h${mins % 60 ? " " + (mins % 60) + "min" : ""}`;
}

function formatDate(ts) {
  if (!ts) return "—";
  const d = new Date(ts);
  return d.toLocaleDateString("fr-FR", { day: "2-digit", month: "short" }) +
    " " + d.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
}

/** Time elapsed since a past timestamp, humanized (e.g. "2 min", "1 h", "3 j"). */
function formatTimeAgo(ts, now) {
  if (!ts) return "—";
  const diff = Math.max(0, (now || Date.now()) - ts);
  const sec = Math.floor(diff / 1000);
  if (sec < 60)   return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60)   return `${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24)     return `${h} h`;
  const d = Math.floor(h / 24);
  return `${d} j`;
}

function normalizeGame(raw) {
  const cfg = raw.gameConfig || raw.cfg || {};
  const capacity = Number(cfg.maxPlayers) || 0;
  const shape = teamShape(cfg.playerTeams, capacity);
  const mods = modsOf(cfg);
  const badges = [
    ...[...mods].filter(k => !DULL_MODS.has(k)).map(k => MOD_LABEL.get(k) || k),
    ...extrasOf(cfg),
  ];
  return {
    id: raw.gameID || raw.id || "",
    cat: raw.publicGameType || "ffa",
    players: Number(raw.numClients) || 0,
    capacity, map: cfg.gameMap || raw.map || "?",
    difficulty: cfg.difficulty || "",
    teams: shape.teams, perTeam: shape.perTeam, hvn: shape.hvn,
    startsAt: Number(raw.startsAt) || 0, badges, gameConfig: cfg,
  };
}

/* ═══ WebSocket ═══ */

function connect() {
  closeSocket();
  const gen = ++wsGen;
  const worker = WORKER_POOL[Math.floor(Math.random() * WORKER_POOL.length)];
  console.log(`[lobby] Connecting to ${WS_URL(worker)}…`);
  let socket;
  try { socket = new WebSocket(WS_URL(worker)); } catch { scheduleReconnect(gen); return; }
  ws = socket;
  const ct = setTimeout(() => { if (gen !== wsGen || socket.readyState === WebSocket.OPEN) return; try { socket.close(); } catch {} }, 12000);
  socket.onopen = () => { if (gen !== wsGen) return; clearTimeout(ct); retries = 0; console.log("[lobby] ✅ Connected"); };
  socket.onmessage = (e) => { if (gen !== wsGen) return; try { applyMessage(JSON.parse(e.data)); } catch {} };
  socket.onclose = () => { if (gen !== wsGen) return; clearTimeout(ct); scheduleReconnect(gen); };
  socket.onerror = () => { if (gen !== wsGen) return; try { socket.close(); } catch {} };
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
  const delay = Math.min(1000 * Math.pow(2, retries - 1), 15000);
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => { if (gen === wsGen) connect(); }, delay);
}

/* ═══ Traitement des messages ═══ */

function applyMessage(msg) {
  if (!msg || typeof msg !== "object") return;
  let serverTime = Date.now();
  if (typeof msg.serverTime === "number") serverTime = msg.serverTime;

  if (msg.type === "counts" && msg.counts) {
    if (!snapshot || !snapshot.games) return;
    for (const cat of Object.keys(snapshot.games)) {
      for (const game of snapshot.games[cat]) {
        if (game.id && Object.prototype.hasOwnProperty.call(msg.counts, game.id))
          game.players = Number(msg.counts[game.id]) || 0;
      }
    }
    snapshot.serverTime = serverTime;
    scheduleRender();
    return;
  }

  if (msg.games && typeof msg.games === "object") {
    const normalized = { ffa: [], team: [], special: [] };
    for (const cat of Object.keys(normalized)) {
      const list = msg.games[cat];
      if (Array.isArray(list))
        normalized[cat] = list.filter(g => g && (g.gameID || g.id)).map(normalizeGame);
    }

    // Détecter les games qui ont quitté le lobby (terminées) → historique
    const currentIds = new Set();
    for (const cat of Object.keys(normalized)) {
      for (const g of normalized[cat]) currentIds.add(g.id);
    }
    if (prevGameIds.size > 0) {
      for (const id of prevGameIds) {
        if (!currentIds.has(id)) {
          // Cette game était dans le snapshot précédent, elle n'y est plus → terminée
          // On la cherche dans l'ancien snapshot pour récupérer ses infos
          if (snapshot && snapshot.games) {
            for (const cat of Object.keys(snapshot.games)) {
              const oldGame = snapshot.games[cat].find(g => g.id === id);
              if (oldGame) {
                recentHistory.unshift({ ...oldGame, endedAt: serverTime });
                break;
              }
            }
          }
        }
      }
    }
    // Garder max 25 entrées
    if (recentHistory.length > 25) recentHistory = recentHistory.slice(0, 25);
    prevGameIds = currentIds;

    snapshot = { serverTime, games: normalized };
    scheduleRender();
    return;
  }
}

/* ═══ Rendu ═══ */

function scheduleRender() {
  if (renderTimer) return;
  renderTimer = setTimeout(() => { renderTimer = null; render(); }, 120);
}

/* Inline SVG strings (Lucide-style, no emojis) */
const SVG = {
  bolt:  `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>`,
  users: `<svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>`,
  clock: `<svg viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>`,
  arrow: `<svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg>`,
  map:   `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>`,
  search:`<svg viewBox="0 0 24 24" width="44" height="44" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>`,
  ghost: `<svg viewBox="0 0 24 24" width="44" height="44" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M9 12h.01M15 12h.01M12 2a8 8 0 0 0-8 8v12l3-3 3 3 2-2 2 2 3-3 3 3V10a8 8 0 0 0-8-8z"/></svg>`,
  check: `<svg viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`,
};

function renderFeedHeader(totalGames, totalPlayers) {
  const gamesTxt = `${totalGames} partie${totalGames !== 1 ? "s" : ""}`;
  const playersTxt = `${totalPlayers.toLocaleString("fr-FR")} joueur${totalPlayers !== 1 ? "s" : ""}`;
  const tabs = [
    { key: "all",     label: "Toutes" },
    { key: "ffa",     label: "FFA" },
    { key: "team",    label: "Team" },
    { key: "special", label: "Special" },
  ].map(t => `<button class="lobby-filter-tab ${currentFilter === t.key ? "active" : ""}" data-filter="${t.key}">${t.label}</button>`).join("");

  return `
    <header class="lobby-feed-header">
      <h1 class="lobby-feed-title">
        ${SVG.bolt}
        <span>Lobby en direct</span>
      </h1>
      <div class="lobby-feed-counters">
        <span class="lobby-feed-counter-dot"></span>
        <span id="lobby-feed-counter-text">${escapeHtml(gamesTxt)} · ${escapeHtml(playersTxt)} · Temps réel</span>
      </div>
      <div class="lobby-filter-tabs" id="lobby-filter-tabs">${tabs}</div>
    </header>
  `;
}

function wireTabs() {
  if (tabsWired) return;
  const tabsEl = document.getElementById("lobby-filter-tabs");
  if (!tabsEl) return;
  tabsEl.addEventListener("click", (e) => {
    const btn = e.target.closest(".lobby-filter-tab");
    if (!btn) return;
    if (currentFilter === btn.dataset.filter) return;
    currentFilter = btn.dataset.filter;
    tabsEl.querySelectorAll(".lobby-filter-tab").forEach(b =>
      b.classList.toggle("active", b === btn));
    scheduleRender();
  });
  tabsWired = true;
}

function renderSectionSeparator(kind, label, count) {
  return `
    <div class="lobby-section-separator ${kind}">
      <span class="lobby-section-separator-dot"></span>
      <span class="lobby-section-separator-title">${escapeHtml(label)}</span>
      <span class="lobby-section-separator-line"></span>
      <span class="lobby-section-separator-count">${count}</span>
    </div>
  `;
}

function renderCard(game, serverTime, status) {
  const isNew = !seenGameIds.has(game.id);
  const thumbUrl = getMapThumbnailUrl(game.map);
  const mode = modeLabel(game);
  const gameUrl = `https://openfront.io/game/${encodeURIComponent(game.id)}`;
  const capacity = game.capacity || 0;
  const players = game.players || 0;
  const fillPct = capacity > 0 ? Math.min(100, Math.round((players / capacity) * 100)) : 0;
  const isFull = capacity > 0 && players >= capacity;
  const startsLabel = formatStartsAt(game.startsAt, serverTime);

  // Status badge
  let statusBadge;
  if (status === "live") {
    statusBadge = `<span class="lobby-status-badge live">LIVE</span>`;
  } else {
    statusBadge = `<span class="lobby-status-badge lobby">${SVG.clock}LOBBY</span>`;
  }

  // Duration / waiting
  let metaRight;
  if (status === "live") {
    const elapsedMin = game.startsAt ? Math.max(0, Math.floor((serverTime - game.startsAt) / 60000)) : 0;
    metaRight = elapsedMin > 0
      ? `<span class="lobby-feed-card-meta-item">${elapsedMin} min</span>`
      : `<span class="lobby-feed-card-meta-item">À l'instant</span>`;
  } else {
    metaRight = `<span class="lobby-feed-card-meta-item">${escapeHtml(startsLabel || "En attente…")}</span>`;
  }

  // Mod badges
  const badges = game.badges.length
    ? `<div class="lobby-feed-card-badges">${game.badges.map(b => `<span class="lobby-badge">${escapeHtml(b)}</span>`).join("")}</div>`
    : "";

  // Thumbnail (fallback SVG is always present; img paints over it when it loads)
  const fallback = `<span class="lobby-feed-card-thumb-fallback">${SVG.map}</span>`;
  const thumb = thumbUrl
    ? `${fallback}<img src="${escapeHtml(thumbUrl)}" alt="${escapeHtml(game.map)}" loading="lazy" onerror="this.remove()">`
    : fallback;

  return `
    <a class="lobby-feed-card${isNew ? " lobby-feed-card-new" : ""}"
       href="${escapeHtml(gameUrl)}" target="_blank" rel="noopener"
       data-game-id="${escapeHtml(game.id)}" data-status="${status}">
      <div class="lobby-feed-card-thumb">${thumb}</div>
      <div class="lobby-feed-card-info">
        <div class="lobby-feed-card-title">
          <span class="lobby-feed-card-name">${escapeHtml(game.map)}</span>
          <span class="lobby-feed-card-mode">${escapeHtml(mode)}</span>
        </div>
        <div class="lobby-feed-card-meta">
          <span class="lobby-feed-card-meta-item">${SVG.users}<strong>${players}</strong>/${capacity || "?"}</span>
          <span class="lobby-feed-card-meta-sep">·</span>
          ${metaRight}
        </div>
        <div class="lobby-progress-bar">
          <div class="lobby-progress-bar-track">
            <div class="lobby-progress-bar-fill${isFull ? " full" : ""}" style="width:${fillPct}%"></div>
          </div>
          <span class="lobby-progress-bar-text">${players}/${capacity || "?"}${capacity > 0 ? ` · ${fillPct}%` : ""}</span>
        </div>
        ${badges}
      </div>
      <div class="lobby-feed-card-right">
        ${statusBadge}
        <span class="lobby-feed-card-join-hint">Rejoindre ${SVG.arrow}</span>
      </div>
    </a>
  `;
}

function renderHistorySection(serverTime) {
  if (recentHistory.length === 0) {
    return `
      <section class="lobby-history-section">
        ${renderSectionSeparator("ended", "Terminé", 0)}
        <div class="lobby-history-empty">En attente de parties terminées…</div>
      </section>
    `;
  }

  const items = recentHistory.map(g => {
    const thumbUrl = getMapThumbnailUrl(g.map);
    const mode = modeLabel(g);
    const gameUrl = `https://openfront.io/game/${encodeURIComponent(g.id)}`;
    const ago = formatTimeAgo(g.endedAt, serverTime);
    const players = g.players || 0;
    const capacity = g.capacity || 0;
    const fallback = `<span class="lobby-history-thumb-fallback">${SVG.map}</span>`;
    const thumb = thumbUrl
      ? `${fallback}<img src="${escapeHtml(thumbUrl)}" alt="${escapeHtml(g.map)}" loading="lazy" onerror="this.remove()">`
      : fallback;
    return `
      <a class="lobby-history-item" href="${escapeHtml(gameUrl)}" target="_blank" rel="noopener">
        <div class="lobby-history-thumb">${thumb}</div>
        <div class="lobby-history-info">
          <div class="lobby-history-map">${escapeHtml(g.map)}</div>
          <div class="lobby-history-meta">${escapeHtml(mode)} · ${players}/${capacity || "?"} joueurs</div>
        </div>
        <div class="lobby-history-date">il y a ${escapeHtml(ago)}</div>
      </a>
    `;
  }).join("");

  return `
    <section class="lobby-history-section">
      ${renderSectionSeparator("ended", "Terminé", recentHistory.length)}
      <div class="lobby-history-list">${items}</div>
    </section>
  `;
}

function renderEmptyState() {
  return `
    <div class="lobby-empty">
      ${SVG.ghost}
      <h3>Aucune partie en cours</h3>
      <p>Les parties OpenFront apparaîtront ici dès qu'elles seront créées.</p>
    </div>
  `;
}

function renderEmptyFilteredState() {
  return `
    <div class="lobby-empty">
      ${SVG.search}
      <h3>Aucune partie dans cette catégorie</h3>
      <p>Essayez un autre filtre — la catégorie « ${escapeHtml(currentFilter.toUpperCase())} » est vide pour le moment.</p>
    </div>
  `;
}

function render() {
  if (!LOBBY_VIEW) return;
  if (!snapshot || !snapshot.games) {
    LOBBY_VIEW.innerHTML = `<div class="lobby-loading"><div class="spinner"></div><p>Connexion aux serveurs OpenFront…</p></div>`;
    return;
  }

  const { ffa, team, special } = snapshot.games;
  const all = [...ffa, ...team, ...special];
  const totalPlayers = all.reduce((s, g) => s + (g.players || 0), 0);
  const serverTime = snapshot.serverTime || Date.now();

  // Build feed skeleton (header + body container) if missing
  let feed = document.getElementById("lobby-feed");
  if (!feed) {
    LOBBY_VIEW.innerHTML = `<div id="lobby-feed" class="lobby-feed">${renderFeedHeader(all.length, totalPlayers)}<div class="lobby-feed-body" id="lobby-feed-body"></div></div>`;
    wireTabs();
    feed = document.getElementById("lobby-feed");
  } else {
    // Update header counters in place
    const counterText = document.getElementById("lobby-feed-counter-text");
    if (counterText) {
      const gamesTxt = `${all.length} partie${all.length !== 1 ? "s" : ""}`;
      const playersTxt = `${totalPlayers.toLocaleString("fr-FR")} joueur${totalPlayers !== 1 ? "s" : ""}`;
      counterText.textContent = `${gamesTxt} · ${playersTxt} · Temps réel`;
    }
    // Refresh active tab state (in case filter changed)
    feed.querySelectorAll(".lobby-filter-tab").forEach(b =>
      b.classList.toggle("active", b.dataset.filter === currentFilter));
  }

  const body = document.getElementById("lobby-feed-body");
  if (!body) return;

  if (all.length === 0) {
    body.innerHTML = renderEmptyState();
    seenGameIds = new Set();
    return;
  }

  // Apply filter
  let filtered;
  if (currentFilter === "all")     filtered = all;
  else if (currentFilter === "ffa")     filtered = ffa;
  else if (currentFilter === "team")    filtered = team;
  else                                   filtered = special;

  const isWaiting = (g) => g.startsAt && g.startsAt > serverTime;

  // Sort: started games first (by player count desc), then waiting games (by player count desc)
  filtered = filtered.slice().sort((a, b) => {
    const aWait = isWaiting(a);
    const bWait = isWaiting(b);
    if (aWait && !bWait) return 1;
    if (!aWait && bWait) return -1;
    return (b.players || 0) - (a.players || 0);
  });

  const started = filtered.filter(g => !isWaiting(g));
  const waiting = filtered.filter(g => isWaiting(g));

  // Build body HTML
  let html = "";
  if (started.length === 0 && waiting.length === 0) {
    html = renderEmptyFilteredState();
  } else {
    if (started.length > 0) {
      html += renderSectionSeparator("live", "En cours", started.length);
      html += started.map(g => renderCard(g, serverTime, "live")).join("");
    }
    if (waiting.length > 0) {
      if (started.length > 0) html += `<div class="lobby-section-gap"></div>`;
      html += renderSectionSeparator("lobby-waiting", "Lancement", waiting.length);
      html += waiting.map(g => renderCard(g, serverTime, "lobby")).join("");
    }
  }

  // History section (ended games)
  html += renderHistorySection(serverTime);

  body.innerHTML = html;

  // Mark all currently visible game IDs as seen (for next slide-in detection)
  seenGameIds = new Set(all.map(g => g.id));
}

/* ═══ Init ═══ */

connect();

setInterval(() => { if (snapshot && snapshot.games) scheduleRender(); }, 30000);
