// sync-teams.js — Team speedrun sync (Duos, Trios, Quads)
// Same accumulation logic as sync.js: loads existing runs, adds new ones, saves back.
// Scans last 2h each run, accumulates over time.
//
// Usage: node sync-teams.js
// Files: teams_runs.json (full accumulated), teams_seen.json (de-dupe),
//        teams_checkpoint.json (last_sync_time), teams_public.json.gz (payload)

import fs from "fs";
import zlib from "zlib";
import {
  API_BASE,
  openFrontFetch,
  hasExemption,
} from "./openfront-api.js";

// ── Constants ──
const TEAM_MODES = ["Duos", "Trios", "Quads"];
const RECENT_MAX_MS = 2 * 60 * 60 * 1000;  // 2 hours
const RECENT_OVERLAP_MS = 10 * 60 * 1000;   // 10 min overlap
const WINDOW_MS = 30 * 1000;                 // 30s windows
const WINDOW_DELAY = 0;                       // no delay (with exemption)
const FETCH_TIMEOUT = 8000;
const DETAIL_CONCURRENCY = 12;
const TIME_OFFSET_SECS = 32;
const MIN_HUMANS = 10;
const TOP_PER_MAP = 25; // for public payload only
const TARGET_DATE = new Date("2025-11-01").getTime(); // backfill jusqu'à nov 2025
const DEFAULT_HISTORY_WINDOWS = 10000; // fenêtres par cycle de backfill

// ── File paths ──
const RUNS_FILE = "teams_runs.json";        // { duos: [...], trios: [...], quads: [...] }
const SEEN_FILE = "teams_seen.json";        // ["gameId1", "gameId2", ...]
const CHECKPOINT_FILE = "teams_checkpoint.json";

// ── Helpers ──
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function loadRuns() {
  try {
    const raw = JSON.parse(fs.readFileSync(RUNS_FILE, "utf8"));
    return raw || { duos: [], trios: [], quads: [] };
  } catch { return { duos: [], trios: [], quads: [] }; }
}

function saveRuns(runs) {
  fs.writeFileSync(RUNS_FILE, JSON.stringify(runs, null, 2));
  fs.writeFileSync(RUNS_FILE + ".gz", zlib.gzipSync(JSON.stringify(runs)));
}

function loadSeen() {
  try { return new Set(JSON.parse(fs.readFileSync(SEEN_FILE, "utf8"))); }
  catch { return new Set(); }
}

function saveSeen(seen) {
  fs.writeFileSync(SEEN_FILE, JSON.stringify([...seen]));
}

function loadCheckpoint() {
  try { return JSON.parse(fs.readFileSync(CHECKPOINT_FILE, "utf8")); }
  catch { return { last_sync_time: "0" }; }
}

function saveCheckpoint(cp) {
  fs.writeFileSync(CHECKPOINT_FILE, JSON.stringify(cp, null, 2));
}

async function fetchWithRetry(url, retries = 3) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT);
    try {
      const res = await openFrontFetch(url, { signal: controller.signal });
      clearTimeout(timer);
      if (res.status === 429) {
        const wait = 2000 * (attempt + 1);
        console.log(`[teams] 429 — attente ${wait}ms (tentative ${attempt + 1}/${retries})`);
        await sleep(wait);
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      clearTimeout(timer);
      if (attempt < retries) {
        await sleep(500 * (attempt + 1));
        continue;
      }
      console.warn(`[teams] fetch failed: ${url}: ${e.message}`);
      return null;
    }
  }
  return null;
}

function buildWindows30s(rangeStart, rangeEnd) {
  const windows = [];
  for (let end = rangeEnd.getTime(); end > rangeStart.getTime(); end -= WINDOW_MS) {
    const start = Math.max(end - WINDOW_MS, rangeStart.getTime());
    windows.push({ start: new Date(start), end: new Date(end) });
  }
  return windows;
}

// ── Game filtering ──
function hasModifiers(config) {
  const mods = config.publicGameModifiers || {};
  if (mods.isCompact || mods.isRandomSpawn || mods.isCrowded ||
      mods.isHardNations || mods.isAlliancesDisabled || mods.isPortsDisabled ||
      mods.isNukesDisabled || mods.isSAMsDisabled || mods.isPeaceTime ||
      mods.isWaterNukes || mods.isDoomsdayClock) return true;
  if (config.randomSpawn === true) return true;
  if (config.infiniteGold || config.infiniteTroops || config.instantBuild) return true;
  if (config.startingGold != null && config.startingGold !== 0) return true;
  if (config.goldMultiplier != null && config.goldMultiplier !== 1) return true;
  return false;
}

function extractTeamRun(raw, mode) {
  const info = raw?.info;
  if (!info) return null;
  const config = info.config || {};

  if (config.gameType !== "Public") return null;
  if (config.gameMode !== "Team") return null;
  if (config.gameMapSize !== "Normal") return null;
  if (config.bots !== 400) return null;
  if (config.playerTeams !== mode) return null;
  if (hasModifiers(config)) return null;

  const players = info.players || [];
  const humanPlayers = players.filter(p => !p.isBot);
  if (humanPlayers.length < MIN_HUMANS) return null;

  const winner = info.winner;
  if (!Array.isArray(winner) || winner.length < 3 || winner[0] !== "team") return null;

  const winnerIds = winner.slice(2);
  const winnerPlayers = players.filter(p => winnerIds.includes(p.clientID) && p.username && !p.isBot);
  if (winnerPlayers.length === 0) return null;

  let durationSecs = info.duration;
  if (!durationSecs || durationSecs < 60) return null;
  durationSecs = Math.max(0, durationSecs - TIME_OFFSET_SECS);

  const gameId = info.gameID || info.gameId || info.id;

  return {
    id: gameId,
    team: winner[1],
    players: winnerPlayers.map(p => ({ username: p.username, clientID: p.clientID, clanTag: p.clanTag || null })),
    map: config.gameMap || "Unknown",
    duration_s: durationSecs,
    difficulty: config.difficulty || "Medium",
    bots: 400,
    numPlayers: humanPlayers.length,
    timestamp: info.start ? new Date(info.start > 1e10 ? info.start : info.start * 1000).toISOString() : new Date().toISOString(),
    url: `https://openfront.io/game/${gameId}`,
  };
}

// ── Sync recent (last 2h, accumulate) ──
async function syncRecent() {
  console.log(`[teams] 🔄 Sync récente — ${new Date().toISOString()}`);
  const seen = loadSeen();
  const runs = loadRuns();
  const cp = loadCheckpoint();

  const now = new Date();
  const lastSync = cp.last_sync_time ? parseInt(cp.last_sync_time, 10) : 0;
  const agoMs = now.getTime() - RECENT_MAX_MS; // TOUJOURS 2h
  const ago = new Date(agoMs);

  const windows = buildWindows30s(ago, now);
  console.log(`[teams] ${windows.length} fenêtres de 30s (~${Math.round((now - ago) / 60000)} min, max 2h, filtre Public Team ≥10p)`);

  let totalNew = 0;
  const newRunsByMode = { duos: [], trios: [], quads: [] };
  const gameIdsToFetch = []; // { gameId, mode }

  // Phase 1: fetch game lists in each window
  for (const { start, end } of windows) {
    for (const mode of TEAM_MODES) {
      const url = `${API_BASE}/public/games?start=${start.toISOString()}&end=${end.toISOString()}&type=Public&mode=Team&playerTeams=${encodeURIComponent(mode)}&limit=1000`;
      const data = await fetchWithRetry(url);
      if (!data) continue;
      const games = Array.isArray(data) ? data : (data.games || []);
      for (const g of games) {
        if (g.type !== "Public") continue;
        if ((g.numPlayers || 0) < MIN_HUMANS) continue;
        const gameId = g.game || g.gameId;
        if (!gameId || seen.has(gameId)) continue;
        gameIdsToFetch.push({ gameId, mode });
      }
    }
    if (WINDOW_DELAY > 0) await sleep(WINDOW_DELAY);
  }

  console.log(`[teams] ${gameIdsToFetch.length} games candidates à fetcher`);

  // Phase 2: fetch game details in parallel chunks
  const chunks = [];
  for (let i = 0; i < gameIdsToFetch.length; i += DETAIL_CONCURRENCY) {
    chunks.push(gameIdsToFetch.slice(i, i + DETAIL_CONCURRENCY));
  }

  for (const chunk of chunks) {
    await Promise.all(chunk.map(async ({ gameId, mode }) => {
      seen.add(gameId);
      try {
        const raw = await fetchWithRetry(`${API_BASE}/public/game/${encodeURIComponent(gameId)}?turns=false`);
        const run = extractTeamRun(raw, mode);
        if (run) {
          const key = mode.toLowerCase();
          newRunsByMode[key].push(run);
          totalNew++;
        }
      } catch (e) {
        console.warn(`[teams] game ${gameId}: ${e.message}`);
      }
    }));
  }

  // Phase 3: merge new runs into existing
  for (const mode of TEAM_MODES) {
    const key = mode.toLowerCase();
    if (newRunsByMode[key].length > 0) {
      // Deduplicate by run ID (in case of overlap)
      const existingIds = new Set(runs[key].map(r => r.id));
      const newOnes = newRunsByMode[key].filter(r => !existingIds.has(r.id));
      runs[key] = [...runs[key], ...newOnes];
      console.log(`[teams] ${mode}: +${newOnes.length} nouveaux runs (total: ${runs[key].length})`);
    }
  }

  // Save if new runs found
  if (totalNew > 0) {
    saveRuns(runs);
    console.log(`[teams] 💾 ${totalNew} nouveaux runs sauvegardés`);
  } else {
    console.log(`[teams] ✅ Aucun nouveau run`);
  }
  saveSeen(seen);

  cp.last_sync_time = String(Date.now());
  saveCheckpoint(cp);

  console.log(`[teams] ✅ Sync récente terminée — ${totalNew} nouveaux runs`);

  // Generate public payload
  generatePublicPayload(runs);

  return totalNew;
}

// ── Generate public payload (top 25/map, compact format) ──
function generatePublicPayload(runs) {
  const payload = {
    u: new Date().toISOString(),
    duos: {},
    trios: {},
    quads: {},
  };

  for (const key of ["duos", "trios", "quads"]) {
    // Group by map
    const byMap = {};
    for (const r of runs[key]) {
      if (!byMap[r.map]) byMap[r.map] = [];
      byMap[r.map].push(r);
    }
    // Sort by duration, keep top 25
    for (const map in byMap) {
      byMap[map].sort((a, b) => a.duration_s - b.duration_s);
      payload[key][map] = byMap[map].slice(0, TOP_PER_MAP).map(r => {
        // Robust: handle both array of objects and array of strings
        let teamName = "Unknown";
        let playerCount = 0;
        if (Array.isArray(r.players)) {
          teamName = r.players.map(p => typeof p === 'string' ? p : (p.username || p.name || '')).filter(Boolean).join(" + ");
          playerCount = r.players.length;
        } else if (typeof r.players === 'string') {
          teamName = r.players;
          playerCount = 0;
        }
        return {
          t: teamName,
          d: r.duration_s,
          g: r.id,
          n: playerCount,
          ts: r.timestamp,
        };
      });
    }
  }

  const json = JSON.stringify(payload);
  fs.writeFileSync("teams_public.json", json);
  fs.writeFileSync("teams_public.json.gz", zlib.gzipSync(json));

  const totals = {
    duos: Object.keys(payload.duos).length,
    trios: Object.keys(payload.trios).length,
    quads: Object.keys(payload.quads).length,
  };
  const totalRuns = runs.duos.length + runs.trios.length + runs.quads.length;
  console.log(`[teams] 📦 Public payload: ${(zlib.gzipSync(json).length / 1024).toFixed(1)} KB, ${totalRuns} runs total, ${totals.duos} duo / ${totals.trios} trio / ${totals.quads} quad maps`);
}

// ── History backfill (remonte dans le temps, comme sync.js) ──
async function syncHistory(maxWindows = DEFAULT_HISTORY_WINDOWS) {
  const seen = loadSeen();
  const runs = loadRuns();
  const cp = loadCheckpoint();

  const now = Date.now();
  const oldest = TARGET_DATE;
  const saved = cp.history_oldest_reached ? parseInt(cp.history_oldest_reached, 10) : now;

  if (saved <= oldest + WINDOW_MS * 2) {
    console.log("[teams-history] ✅ Historique complet jusqu'au " + new Date(oldest).toISOString().slice(0, 10));
    return 0;
  }

  // Scan backwards from saved towards oldest
  let oldestReached = saved;
  let totalNew = 0;
  const newRunsByMode = { duos: [], trios: [], quads: [] };

  for (let i = 0; i < maxWindows; i++) {
    const windowEnd = oldestReached - i * WINDOW_MS;
    const windowStart = Math.max(windowEnd - WINDOW_MS, oldest);

    if (windowEnd <= oldest) {
      console.log("[teams-history] ✅ Atteint la date cible: " + new Date(oldest).toISOString().slice(0, 10));
      break;
    }

    for (const mode of TEAM_MODES) {
      const url = `${API_BASE}/public/games?start=${new Date(windowStart).toISOString()}&end=${new Date(windowEnd).toISOString()}&type=Public&mode=Team&playerTeams=${encodeURIComponent(mode)}&limit=1000`;
      const data = await fetchWithRetry(url);
      if (!data) continue;
      const games = Array.isArray(data) ? data : (data.games || []);
      for (const g of games) {
        if (g.type !== "Public") continue;
        if ((g.numPlayers || 0) < MIN_HUMANS) continue;
        const gameId = g.game || g.gameId;
        if (!gameId || seen.has(gameId)) continue;

        // Fetch detail
        seen.add(gameId);
        try {
          const raw = await fetchWithRetry(`${API_BASE}/public/game/${encodeURIComponent(gameId)}?turns=false`);
          const run = extractTeamRun(raw, mode);
          if (run) {
            newRunsByMode[mode.toLowerCase()].push(run);
            totalNew++;
          }
        } catch (e) { /* skip */ }
      }
    }

    oldestReached = windowStart;

    // Checkpoint every 50 windows
    if (i > 0 && i % 50 === 0) {
      cp.history_oldest_reached = String(oldestReached);
      saveCheckpoint(cp);
      if (totalNew > 0) {
        // Merge + save
        for (const mode of TEAM_MODES) {
          const key = mode.toLowerCase();
          if (newRunsByMode[key].length > 0) {
            const existingIds = new Set(runs[key].map(r => r.id));
            const newOnes = newRunsByMode[key].filter(r => !existingIds.has(r.id));
            runs[key] = [...runs[key], ...newOnes];
          }
        }
        saveRuns(runs);
        saveSeen(seen);
      }
      const pct = Math.round(((now - oldestReached) / (now - oldest)) * 100);
      console.log(`[teams-history] ${i}/${maxWindows} fenêtres — ${pct}% — ${totalNew} nouveaux runs`);
    }
  }

  // Final merge + save
  for (const mode of TEAM_MODES) {
    const key = mode.toLowerCase();
    if (newRunsByMode[key].length > 0) {
      const existingIds = new Set(runs[key].map(r => r.id));
      const newOnes = newRunsByMode[key].filter(r => !existingIds.has(r.id));
      runs[key] = [...runs[key], ...newOnes];
      console.log(`[teams-history] ${mode}: +${newOnes.length} (total: ${runs[key].length})`);
    }
  }
  if (totalNew > 0) saveRuns(runs);
  saveSeen(seen);

  cp.history_oldest_reached = String(oldestReached);
  saveCheckpoint(cp);

  if (totalNew > 0) generatePublicPayload(runs);

  console.log(`[teams-history] 🏁 ${totalNew} nouveaux runs historiques (oldest: ${new Date(oldestReached).toISOString().slice(0, 10)})`);
  return totalNew;
}

// ── Main ──
async function main() {
  console.log("[teams] 🚀 Démarrage — Team Speedrun Sync (accumulate + history)");
  if (hasExemption()) console.log("[teams] 🔑 Exemption Skailex active");
  else console.log("[teams] ⚠️ Pas d'exemption — rate limits peuvent s'appliquer");

  // 1. Sync recent (last 2h)
  await syncRecent();

  // 2. History backfill (remonte dans le temps)
  const histNew = await syncHistory(DEFAULT_HISTORY_WINDOWS);

  const runs = loadRuns();
  console.log(`[teams] 🏁 Terminé: ${runs.duos.length} duos, ${runs.trios.length} trios, ${runs.quads.length} quads (${histNew} historiques)`);
}

main().catch(e => { console.error("[teams] Fatal:", e); process.exit(1); });
