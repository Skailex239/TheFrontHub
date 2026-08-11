/**
 * sync-dashboard.js — Synchronise le classement du Tableau de bord.
 *
 * Source : API OpenFront /public/games + /public/game/<id>
 *   - FFA casual   (mode=Free For All, rankedType=unranked) → +10 pts/victoire
 *   - FFA classé   (mode=Free For All, rankedType=1v1)      → +11 pts/victoire (+1 bonus ranked)
 *   - Team casual  (mode=Team, rankedType=unranked)         → +5  pts/victoire
 *   - Team classé  (mode=Team, rankedType=2v2)              → +6  pts/victoire (+1 bonus ranked)
 *
 * Le winner est résolu via son `username` (display name) matché contre
 * ranked.json (qui contient le public_id des top 100 1v1 + 2v2).
 * Les winners non classés (pas dans ranked.json) sont quand même comptés
 * mais sans publicId (pas de lien profil cliquable).
 *
 * Sortie :
 *   - dashboard_games.json   (log incrémental des games, 30 jours)
 *   - dashboard_ranking.json (agrégat global + hebdo, lu par le frontend)
 *   + copies dans public/
 */

import fs from "fs";
import path from "path";
import {
  API_BASE,
  openFrontFetch,
  hasExemption,
  logApiStats,
  resetApiStats,
} from "./openfront-api.js";

// ── Config ────────────────────────────────────────────────────────────────
const HAS_EXEMPTION = hasExemption();
const WINDOW_MS = (parseInt(process.env.DASH_WINDOW_MIN || "5", 10)) * 60 * 1000;  // 5min par défaut
const LOG_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;  // 30 jours
const WEEKLY_MS = 7 * 24 * 60 * 60 * 1000;           // 7 jours
const DETAIL_CONCURRENCY = HAS_EXEMPTION ? 12 : 4;
const DELAY_429 = HAS_EXEMPTION ? 2000 : 8000;
const BATCH_DELAY = HAS_EXEMPTION ? 0 : 100;
const GAMES_LIMIT = 50;
const MAX_OFFSET = parseInt(process.env.DASH_MAX_OFFSET || "500", 10);  // max 10 pages par sous-fenêtre/catégorie
const DEFAULT_SCAN_HOURS = parseFloat(process.env.DASH_SCAN_HOURS || "24");  // 24h par défaut

const ROOT = process.cwd();
const GAMES_FILE = path.join(ROOT, "dashboard_games.json");
const RANKING_FILE = path.join(ROOT, "dashboard_ranking.json");
const PUBLIC_GAMES_FILE = path.join(ROOT, "public", "dashboard_games.json");
const PUBLIC_RANKING_FILE = path.join(ROOT, "public", "dashboard_ranking.json");
const RANKED_FILE = path.join(ROOT, "ranked.json");

// ── CLI flags ─────────────────────────────────────────────────────────────
const ARGS = new Set(process.argv.slice(2));
const DRY_RUN = ARGS.has("--dry-run");
const FULL = ARGS.has("--full");
const VERBOSE = ARGS.has("--verbose");

// ── Index username → publicId (depuis ranked.json) ───────────────────────
const usernameToPid = new Map();   // "eyesofruby" → { publicId, username, clan }
const pidToInfo = new Map();       // "Ajp51M2d" → { username, clan }

function buildRankedIndex() {
  try {
    const raw = JSON.parse(fs.readFileSync(RANKED_FILE, "utf8"));
    const seen = new Map(); // displayName_lower → best player (par wins)
    for (const list of [raw["1v1"] || [], raw["2v2"] || []]) {
      for (const p of list) {
        const fullUsername = p.username || p.accountUsername || "";
        if (!fullUsername) continue;
        // display name = partie avant le dernier ".XXXX"
        const dotIdx = fullUsername.lastIndexOf(".");
        const displayName = dotIdx > 0 ? fullUsername.slice(0, dotIdx) : fullUsername;
        const key = displayName.toLowerCase();
        const prev = seen.get(key);
        // Garde celui avec le plus de wins (plus actif = plus probable d'être le bon)
        if (!prev || (p.wins || 0) > prev.wins) {
          seen.set(key, {
            publicId: p.public_id,
            username: fullUsername,
            displayName,
            clan: null, // ranked.json n'a pas le clan
            wins: p.wins || 0,
          });
        }
        pidToInfo.set(p.public_id, { username: fullUsername, clan: null });
      }
    }
    for (const [key, info] of seen) {
      usernameToPid.set(key, info);
    }
    console.log(`[sync-dashboard] index ranked: ${usernameToPid.size} display names uniques`);
  } catch (e) {
    console.warn(`[sync-dashboard] ranked.json introuvable ou invalide: ${e.message}`);
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function isoNow() { return new Date().toISOString(); }

function fmtDate(d) {
  return new Date(d).toISOString().replace(/\.\d{3}Z$/, "Z");
}

async function fetchJson(url) {
  let attempt = 0;
  const MAX_RETRIES = 4;
  while (attempt < MAX_RETRIES) {
    attempt++;
    const res = await openFrontFetch(url);
    if (res.status === 429) {
      const wait = DELAY_429 * attempt;
      console.warn(`[sync-dashboard] 429 — retry dans ${wait}ms (attempt ${attempt}/${MAX_RETRIES})`);
      await sleep(wait);
      continue;
    }
    if (!res.ok) {
      console.warn(`[sync-dashboard] HTTP ${res.status} sur ${url}`);
      return null;
    }
    return await res.json();
  }
  console.warn(`[sync-dashboard] abandon après ${MAX_RETRIES} retries 429: ${url}`);
  return null;
}

/** Liste les games d'une catégorie sur une sous-fenêtre [start, end]. */
async function listGames(start, end, mode, rankedType) {
  const modeQ = encodeURIComponent(mode);
  const rtQ = encodeURIComponent(rankedType);
  const url = `${API_BASE}/public/games?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}&mode=${modeQ}&rankedType=${rtQ}&type=Public&limit=${GAMES_LIMIT}`;
  const out = [];
  let offset = 0;
  while (offset < MAX_OFFSET) {
    const pageUrl = `${url}&offset=${offset}`;
    const data = await fetchJson(pageUrl);
    if (!Array.isArray(data)) break;
    if (data.length === 0) break;
    out.push(...data);
    if (data.length < GAMES_LIMIT) break;  // dernière page
    offset += GAMES_LIMIT;
    if (BATCH_DELAY > 0) await sleep(BATCH_DELAY);
  }
  return out;
}

/** Récupère le détail d'une game et extrait le winner. */
async function fetchGameDetail(gameId) {
  const url = `${API_BASE}/public/game/${gameId}?turns=false`;
  const data = await fetchJson(url);
  if (!data || !data.info) return null;
  const info = data.info;
  const winner = info.winner;
  const players = Array.isArray(info.players) ? info.players : [];
  if (!winner || winner.length < 2) return null;

  let mode, ranked, winners;
  // winner[0] = "player" (FFA) ou "team" (Team)
  const winnerType = winner[0];
  if (winnerType === "player") {
    const winnerClientId = winner[1];
    const p = players.find((x) => x.clientID === winnerClientId);
    if (!p) return null;
    winners = [{ username: p.username, clanTag: p.clanTag, clientID: winnerClientId }];
  } else if (winnerType === "team") {
    // winner = ["team", teamName, ...clientIDs]
    const clientIds = winner.slice(2);
    winners = clientIds
      .map((cid) => {
        const p = players.find((x) => x.clientID === cid);
        if (!p) return null;
        return { username: p.username, clanTag: p.clanTag, clientID: cid };
      })
      .filter(Boolean);
    if (winners.length === 0) return null;
  } else {
    return null;
  }

  // Détermine mode + ranked depuis la summary (passée plus tard) — on retourne juste les winners
  return { winners, end: info.end || info.start };
}

/** Mappe un winner (display name) vers un publicId via ranked.json. */
function resolvePublicId(winner) {
  const dn = (winner.username || "").toLowerCase();
  if (!dn) return null;
  const match = usernameToPid.get(dn);
  if (match) return match.publicId;
  return null;
}

/** Traite un batch de games en parallèle. */
async function processGamesBatch(games, categoryLabel) {
  const results = [];
  for (let i = 0; i < games.length; i += DETAIL_CONCURRENCY) {
    const batch = games.slice(i, i + DETAIL_CONCURRENCY);
    const batchResults = await Promise.all(
      batch.map(async (g) => {
        const detail = await fetchGameDetail(g.game);
        if (!detail) {
          if (VERBOSE) console.log(`[sync-dashboard]   ${categoryLabel} game ${g.game}: SKIP (no detail)`);
          return null;
        }
        return { summary: g, detail };
      })
    );
    for (const r of batchResults) {
      if (!r) continue;
      const g = r.summary;
      const mode = g.mode === "Team" ? "Team" : "FFA";
      const ranked = g.rankedType === "1v1" || g.rankedType === "2v2";
      const detailWinners = Array.isArray(r.detail.winners) ? r.detail.winners : [];
      const winners = detailWinners.map((w) => {
        const pid = resolvePublicId(w);
        let clan = w.clanTag || null;
        if (!clan && pid && pidToInfo.has(pid)) {
          clan = pidToInfo.get(pid).clan;
        }
        return { publicId: pid, username: w.username, clan };
      });
      if (VERBOSE) {
        console.log(`[sync-dashboard]   ${categoryLabel} game ${g.game}: detail.winners=${detailWinners.length} → resolved=${winners.length} — ${winners.map((w) => w.username).join(", ") || "(empty)"}`);
      }
      results.push({
        id: g.game,
        ts: g.end || g.start,
        mode,
        ranked,
        winners,
      });
    }
    if (BATCH_DELAY > 0) await sleep(BATCH_DELAY);
  }
  return results;
}

// ── Scan principal ────────────────────────────────────────────────────────
async function scanWindow(startMs, endMs) {
  const categories = [
    { label: "FFA-casual",  mode: "Free For All", rankedType: "unranked" },
    { label: "FFA-ranked",  mode: "Free For All", rankedType: "1v1" },
    { label: "Team-casual", mode: "Team",         rankedType: "unranked" },
    { label: "Team-ranked", mode: "Team",         rankedType: "2v2" },
  ];

  const allNewGames = [];
  const totalWindows = Math.ceil((endMs - startMs) / WINDOW_MS);
  let winIdx = 0;

  for (let t = startMs; t < endMs; t += WINDOW_MS) {
    winIdx++;
    const wStart = fmtDate(t);
    const wEnd = fmtDate(Math.min(t + WINDOW_MS, endMs));
    if (winIdx % 20 === 1 || VERBOSE) {
      console.log(`[sync-dashboard] fenêtre ${winIdx}/${totalWindows} [${wStart} → ${wEnd}]`);
    }
    for (const cat of categories) {
      const games = await listGames(wStart, wEnd, cat.mode, cat.rankedType);
      if (games.length === 0) continue;
      const processed = await processGamesBatch(games, cat.label);
      allNewGames.push(...processed);
      if (!VERBOSE && games.length > 0) {
        process.stdout.write(`  ${cat.label}:${games.length} `);
      }
    }
    if (!VERBOSE && winIdx % 20 === 0) console.log("");
  }
  if (!VERBOSE) console.log("");
  return allNewGames;
}

// ── Agrégation ────────────────────────────────────────────────────────────
function aggregate(gamesLog) {
  const players = new Map(); // key → {publicId, username, clan, ffaCasual, ffaRanked, teamCasual, teamRanked}

  for (const g of gamesLog) {
    for (const w of g.winners) {
      // Clé d'agrégation : publicId si résolu, sinon username (display name)
      const key = w.publicId || `user:${(w.username || "").toLowerCase()}`;
      let entry = players.get(key);
      if (!entry) {
        entry = {
          publicId: w.publicId,
          username: w.username || "Inconnu",
          clan: w.clan || null,
          ffaCasualWins: 0,
          ffaRankedWins: 0,
          teamCasualWins: 0,
          teamRankedWins: 0,
        };
        players.set(key, entry);
      }
      if (g.mode === "FFA") {
        if (g.ranked) entry.ffaRankedWins++;
        else entry.ffaCasualWins++;
      } else {
        if (g.ranked) entry.teamRankedWins++;
        else entry.teamCasualWins++;
      }
    }
  }

  const arr = Array.from(players.values());
  for (const p of arr) {
    p.points = p.ffaCasualWins * 10 + p.ffaRankedWins * 11 + p.teamCasualWins * 5 + p.teamRankedWins * 6;
  }
  arr.sort((a, b) => b.points - a.points);
  return arr;
}

// ── Main ──────────────────────────────────────────────────────────────────
async function main() {
  console.log(`[sync-dashboard] démarrage — exemption: ${HAS_EXEMPTION ? "oui" : "non"}, dry-run: ${DRY_RUN}, full: ${FULL}`);
  resetApiStats();
  buildRankedIndex();

  // Charge le log existant
  let log = { lastScan: null, games: [] };
  if (!FULL) {
    try {
      log = JSON.parse(fs.readFileSync(GAMES_FILE, "utf8"));
      console.log(`[sync-dashboard] log existant chargé: ${log.games.length} games, lastScan=${log.lastScan}`);
    } catch (e) {
      console.log("[sync-dashboard] aucun log existant — scan complet");
    }
  }

  // Détermine la fenêtre de scan
  const now = Date.now();
  let startMs;
  if (FULL || !log.lastScan) {
    startMs = now - DEFAULT_SCAN_HOURS * 60 * 60 * 1000;
    console.log(`[sync-dashboard] scan complet sur ${DEFAULT_SCAN_HOURS}h depuis ${new Date(startMs).toISOString()}`);
    if (FULL) log.games = [];  // reset log en mode full
  } else {
    startMs = new Date(log.lastScan).getTime();
    if (Number.isNaN(startMs)) startMs = now - DEFAULT_SCAN_HOURS * 60 * 60 * 1000;
    console.log(`[sync-dashboard] scan incrémental depuis ${new Date(startMs).toISOString()}`);
  }

  // Scan
  const newGames = await scanWindow(startMs, now);
  console.log(`[sync-dashboard] ${newGames.length} nouvelles games scannées`);

  // Merge dans le log + trim 30 jours
  log.games.push(...newGames);
  const cutoff = now - LOG_RETENTION_MS;
  const before = log.games.length;
  log.games = log.games.filter((g) => new Date(g.ts).getTime() >= cutoff);
  if (log.games.length !== before) {
    console.log(`[sync-dashboard] trim log: ${before} → ${log.games.length} (>${LOG_RETENTION_MS / 86400000}j supprimés)`);
  }
  log.lastScan = isoNow();

  // Agrège
  const gamesLog = log.games;
  const globalPlayers = aggregate(gamesLog);
  const weeklyCutoff = now - WEEKLY_MS;
  const weeklyGames = gamesLog.filter((g) => new Date(g.ts).getTime() >= weeklyCutoff);
  const weeklyPlayers = aggregate(weeklyGames);

  const tsSorted = gamesLog.map((g) => new Date(g.ts).getTime()).sort((a, b) => a - b);
  const globalFrom = tsSorted.length ? new Date(tsSorted[0]).toISOString() : null;
  const globalTo = tsSorted.length ? new Date(tsSorted[tsSorted.length - 1]).toISOString() : null;
  const weeklyTsSorted = weeklyGames.map((g) => new Date(g.ts).getTime()).sort((a, b) => a - b);
  const weeklyFrom = weeklyTsSorted.length ? new Date(weeklyTsSorted[0]).toISOString() : new Date(weeklyCutoff).toISOString();
  const weeklyTo = weeklyTsSorted.length ? new Date(weeklyTsSorted[weeklyTsSorted.length - 1]).toISOString() : isoNow();

  const ranking = {
    updatedAt: isoNow(),
    gamesScanned: gamesLog.length,
    global: {
      from: globalFrom,
      to: globalTo,
      gamesScanned: gamesLog.length,
      players: globalPlayers,
    },
    weekly: {
      from: weeklyFrom,
      to: weeklyTo,
      gamesScanned: weeklyGames.length,
      players: weeklyPlayers,
    },
  };

  console.log(`[sync-dashboard] agrégat: global=${globalPlayers.length} joueurs, weekly=${weeklyPlayers.length} joueurs`);
  if (globalPlayers.length > 0) {
    const top = globalPlayers[0];
    console.log(`[sync-dashboard] champion global: ${top.username} (${top.points} pts — FFA c:${top.ffaCasualWins} r:${top.ffaRankedWins} / Team c:${top.teamCasualWins} r:${top.teamRankedWins})`);
  }
  if (weeklyPlayers.length > 0) {
    const top = weeklyPlayers[0];
    console.log(`[sync-dashboard] champion weekly: ${top.username} (${top.points} pts)`);
  }

  if (DRY_RUN) {
    console.log("[sync-dashboard] dry-run — fichiers non écrits");
  } else {
    fs.writeFileSync(GAMES_FILE, JSON.stringify(log));
    fs.writeFileSync(RANKING_FILE, JSON.stringify(ranking, null, 2));
    try {
      fs.mkdirSync(path.dirname(PUBLIC_GAMES_FILE), { recursive: true });
      fs.writeFileSync(PUBLIC_GAMES_FILE, JSON.stringify(log));
      fs.writeFileSync(PUBLIC_RANKING_FILE, JSON.stringify(ranking, null, 2));
      console.log(`[sync-dashboard] fichiers écrits: ${GAMES_FILE}, ${RANKING_FILE}, ${PUBLIC_RANKING_FILE}`);
    } catch (e) {
      console.warn(`[sync-dashboard] copie public/ échouée: ${e.message}`);
    }
  }

  logApiStats("sync-dashboard");
  console.log("[sync-dashboard] terminé");
}

main().catch((e) => {
  console.error("[sync-dashboard] FATAL:", e);
  process.exit(1);
});
