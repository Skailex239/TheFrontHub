/**
 * compute-player-stats.js — Calcule un résumé complet de stats par joueur.
 *
 * Lit player-data/<pid>.json (généré par sync-player-games.js),
 * calcule TOUTES les stats (playtime, wins, map stats, activity, streaks,
 * achievements), et écrit player-stats/<pid>.json.
 *
 * Le site n'a plus qu'à charger ce fichier et afficher les valeurs —
 * zéro calcul côté navigateur, affichage instantané.
 *
 * Usage:
 *   node compute-player-stats.js                # calcule pour tous les joueurs
 *   node compute-player-stats.js <publicId>     # calcule pour un joueur
 */

const fs = require("fs");
const path = require("path");

const DATA_DIR = path.join(__dirname, "player-data");
const STATS_DIR = path.join(__dirname, "player-stats");

/* ── Helpers ── */

function classifyGame(g) {
  const mode = String(g.mode || "").toLowerCase();
  const rt = String(g.rankedType || "").toLowerCase();
  const isTeam =
    mode === "team" ||
    mode.startsWith("2v2") ||
    mode.startsWith("3v3") ||
    mode.startsWith("4v4") ||
    rt === "2v2";
  const isRanked = rt === "1v1" || rt === "2v2" || rt === "ranked";
  if (isTeam) return isRanked ? "teamRanked" : "teamCasual";
  return isRanked ? "ffaRanked" : "ffaCasual";
}

function gameDurationSec(g) {
  const d = g.durationSeconds ?? g.duration;
  const n = typeof d === "number" ? d : parseFloat(String(d ?? "0"));
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function gameVisibility(g) {
  const v = String(g.visibility || "").toLowerCase();
  if (v === "private") return "private";
  if (v === "singleplayer" || v === "single") return "singleplayer";
  if (v === "public") return "public";
  const rt = String(g.rankedType || "").toLowerCase();
  if (rt === "singleplayer") return "singleplayer";
  return "public";
}

function formatDuration(totalSec) {
  const s = Math.max(0, Math.floor(totalSec || 0));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const remS = s % 60;
  if (m < 60) return `${m}m ${remS}s`;
  const h = Math.floor(m / 60);
  const remM = m % 60;
  if (h < 24) return `${h}h ${remM}m`;
  const d = Math.floor(h / 24);
  const remH = h % 24;
  return `${d}j ${remH}h`;
}

function formatDurationCompact(totalSec) {
  const s = Math.max(0, Math.floor(totalSec || 0));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const remM = m % 60;
  if (h < 24) return `${h}h ${remM}m`;
  const d = Math.floor(h / 24);
  const remH = h % 24;
  return `${d}j ${remH}h`;
}

function formatPct(ratio) {
  if (!Number.isFinite(ratio) || ratio <= 0) return "0%";
  return `${Math.round(ratio * 100)}%`;
}

function formatPoints(n) {
  try { return new Intl.NumberFormat("fr-FR").format(n || 0); }
  catch { return String(n || 0); }
}

/* ── Extract career wins from aggregated stats tree ── */

function extractCareerWins(stats) {
  const w = { ffaCasual: 0, ffaRanked: 0, teamCasual: 0, teamRanked: 0 };
  if (!stats || typeof stats !== "object") return w;
  const CASUAL_VIS = ["Public", "Private", "Singleplayer"];
  const FFA_MODES = ["Free For All", "Humans Vs Nations"];
  for (const vis of CASUAL_VIS) {
    const visData = stats[vis];
    if (!visData) continue;
    for (const mode of FFA_MODES) {
      const modeData = visData[mode];
      if (!modeData) continue;
      for (const diff of Object.keys(modeData)) {
        const d = modeData[diff];
        if (d && d.wins != null) w.ffaCasual += Number(d.wins) || 0;
      }
    }
    const teamData = visData["Team"];
    if (teamData) {
      for (const diff of Object.keys(teamData)) {
        const d = teamData[diff];
        if (d && d.wins != null) w.teamCasual += Number(d.wins) || 0;
      }
    }
  }
  const r1 = stats.Ranked && stats.Ranked["1v1"];
  if (r1 && r1.wins != null) w.ffaRanked = Number(r1.wins) || 0;
  const r2 = stats.Ranked && stats.Ranked["2v2"];
  if (r2 && r2.wins != null) w.teamRanked = Number(r2.wins) || 0;
  return w;
}

function totalWins(w) {
  return (w.ffaCasual || 0) + (w.ffaRanked || 0) + (w.teamCasual || 0) + (w.teamRanked || 0);
}

function pointsFor(w) {
  const PTS_FFA_CASUAL = 10, PTS_FFA_RANKED = 1, PTS_TEAM_CASUAL = 5, PTS_TEAM_RANKED = 1;
  return (w.ffaCasual || 0) * PTS_FFA_CASUAL +
         (w.ffaRanked || 0) * PTS_FFA_RANKED +
         (w.teamCasual || 0) * PTS_TEAM_CASUAL +
         (w.teamRanked || 0) * PTS_TEAM_RANKED;
}

/* ── Main stats computation ── */

function computeStats(games, statsTree) {
  let totalPlaytimeSec = 0;
  let longestGameSec = 0;
  let shortestGameSec = Infinity;

  const byCategory = {
    ffaCasual:  { games: 0, playtimeSec: 0, wins: 0 },
    ffaRanked:  { games: 0, playtimeSec: 0, wins: 0 },
    teamCasual: { games: 0, playtimeSec: 0, wins: 0 },
    teamRanked: { games: 0, playtimeSec: 0, wins: 0 },
  };
  const byVisibility = { public: 0, private: 0, singleplayer: 0 };
  const byHour = new Array(24).fill(0);
  const byWeekday = new Array(7).fill(0);
  const byDayMap = new Map();
  const results = { victory: 0, defeat: 0, incomplete: 0, other: 0 };
  const mapAgg = new Map();

  for (const g of games) {
    const dur = gameDurationSec(g);
    totalPlaytimeSec += dur;
    if (dur > longestGameSec) longestGameSec = dur;
    if (dur > 0 && dur < shortestGameSec) shortestGameSec = dur;

    const cat = classifyGame(g);
    byCategory[cat].games++;
    byCategory[cat].playtimeSec += dur;
    if (g.result === "victory") byCategory[cat].wins++;

    byVisibility[gameVisibility(g)]++;

    if (g.start) {
      const t = new Date(g.start).getTime();
      if (Number.isFinite(t)) {
        try {
          const hourStr = new Intl.DateTimeFormat("en-GB", {
            timeZone: "Europe/Paris", hour: "2-digit", hour12: false,
          }).format(new Date(t));
          const hour = parseInt(hourStr, 10);
          if (hour >= 0 && hour < 24) byHour[hour]++;

          const weekdayStr = new Intl.DateTimeFormat("en-GB", {
            timeZone: "Europe/Paris", weekday: "short",
          }).format(new Date(t));
          const wdMap = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };
          const wd = wdMap[weekdayStr];
          if (wd != null) byWeekday[wd]++;

          const dayKey = new Intl.DateTimeFormat("fr-FR", {
            timeZone: "Europe/Paris", day: "2-digit", month: "2-digit", year: "numeric",
          }).format(new Date(t));
          const existing = byDayMap.get(dayKey) || { count: 0, playtimeSec: 0 };
          existing.count++;
          existing.playtimeSec += dur;
          byDayMap.set(dayKey, existing);
        } catch { /* ignore TZ errors */ }
      }
    }

    if (g.result === "victory") results.victory++;
    else if (g.result === "defeat") results.defeat++;
    else if (g.result === "incomplete") results.incomplete++;
    else results.other++;

    const mapName = g.map || "Inconnue";
    const t = g.start ? new Date(g.start).getTime() : 0;
    const m = mapAgg.get(mapName) || {
      count: 0, wins: 0, losses: 0, incompletes: 0, playtimeSec: 0, lastPlayed: 0,
    };
    m.count++;
    m.playtimeSec += dur;
    if (g.result === "victory") m.wins++;
    else if (g.result === "defeat") m.losses++;
    else if (g.result === "incomplete") m.incompletes++;
    if (t > m.lastPlayed) m.lastPlayed = t;
    mapAgg.set(mapName, m);
  }

  const byMap = [...mapAgg.entries()].map(([map, a]) => ({
    map,
    count: a.count,
    wins: a.wins,
    losses: a.losses,
    incompletes: a.incompletes,
    playtimeSec: a.playtimeSec,
    avgDuration: a.count > 0 ? a.playtimeSec / a.count : 0,
    winRate: a.wins + a.losses > 0 ? a.wins / (a.wins + a.losses) : 0,
    lastPlayed: a.lastPlayed,
  })).sort((a, b) => b.count - a.count);

  const byDay = [...byDayMap.entries()].map(([date, a]) => ({ date, ...a }))
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(-90);

  // Streaks
  const sortedByDateDesc = [...games].filter((g) => g.start)
    .sort((a, b) => new Date(b.start).getTime() - new Date(a.start).getTime());
  let currentStreak = 0;
  for (const g of sortedByDateDesc) {
    if (g.result === "victory") currentStreak++;
    else break;
  }
  const sortedAsc = [...games].filter((g) => g.start)
    .sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime());
  let bestStreak = 0;
  let running = 0;
  for (const g of sortedAsc) {
    if (g.result === "victory") {
      running++;
      if (running > bestStreak) bestStreak = running;
    } else {
      running = 0;
    }
  }

  // Career wins: count from games directly (more reliable than stats tree)
  // If statsTree is available, use max(games count, stats tree) for accuracy
  const gamesWins = { ffaCasual: 0, ffaRanked: 0, teamCasual: 0, teamRanked: 0 };
  for (const g of games) {
    if (g.result !== "victory") continue;
    const cat = classifyGame(g);
    gamesWins[cat]++;
  }
  const statsWins = extractCareerWins(statsTree);
  // Take max: stats tree may have more wins (aggregated all-time), games may have more (recent syncs)
  const careerWins = {
    ffaCasual: Math.max(gamesWins.ffaCasual, statsWins.ffaCasual),
    ffaRanked: Math.max(gamesWins.ffaRanked, statsWins.ffaRanked),
    teamCasual: Math.max(gamesWins.teamCasual, statsWins.teamCasual),
    teamRanked: Math.max(gamesWins.teamRanked, statsWins.teamRanked),
  };

  return {
    totalGames: games.length,
    totalPlaytimeSec,
    avgGameDurationSec: games.length > 0 ? totalPlaytimeSec / games.length : 0,
    longestGameSec,
    shortestGameSec: shortestGameSec === Infinity ? 0 : shortestGameSec,
    byCategory,
    byVisibility,
    byMap,
    byHour,
    byWeekday,
    byDay,
    results,
    currentStreak,
    bestStreak,
    careerWins,
  };
}

/* ── Achievements ── */

function computeAchievements(pt) {
  const cw = pt.careerWins;
  const totalW = totalWins(cw);
  const distinctMaps = pt.byMap.length;
  const activeDays = pt.byDay.filter((d) => d.count > 0).length;
  const playtimeHours = pt.totalPlaytimeSec / 3600;

  const list = [
    { id: "first-win", name: "Première victoire", desc: "Remporte ta 1ère partie", unlocked: totalW >= 1 },
    { id: "ten-wins", name: "Décathlon", desc: "Remporte 10 parties", unlocked: totalW >= 10, progress: totalW >= 10 ? null : { current: totalW, target: 10 } },
    { id: "hundred-wins", name: "Centurion", desc: "Remporte 100 parties", unlocked: totalW >= 100, progress: totalW >= 100 ? null : { current: totalW, target: 100 } },
    { id: "marathon", name: "Marathonien", desc: "Joue plus de 24h au total", unlocked: playtimeHours >= 24, progress: playtimeHours >= 24 ? null : { current: Math.floor(playtimeHours), target: 24 } },
    { id: "weekend", name: "Assidu", desc: "Joue 7 jours différents", unlocked: activeDays >= 7, progress: activeDays >= 7 ? null : { current: activeDays, target: 7 } },
    { id: "cartographer", name: "Cartographe", desc: "Joue 10 cartes différentes", unlocked: distinctMaps >= 10, progress: distinctMaps >= 10 ? null : { current: distinctMaps, target: 10 } },
    { id: "streak5", name: "En feu", desc: "Fais une série de 5 victoires", unlocked: pt.bestStreak >= 5, progress: pt.bestStreak >= 5 ? null : { current: pt.bestStreak, target: 5 } },
    { id: "streak10", name: "Intouchable", desc: "Fais une série de 10 victoires", unlocked: pt.bestStreak >= 10, progress: pt.bestStreak >= 10 ? null : { current: pt.bestStreak, target: 10 } },
    { id: "polyvalent", name: "Polyvalent", desc: "Gagne dans les 4 catégories", unlocked: cw.ffaCasual > 0 && cw.ffaRanked > 0 && cw.teamCasual > 0 && cw.teamRanked > 0 },
    { id: "night-owl", name: "Oiseau de nuit", desc: "Joue après minuit (0h-4h)", unlocked: pt.byHour.slice(0, 4).some((c) => c > 0) },
  ];
  const unlockedCount = list.filter((a) => a.unlocked).length;
  return { list, unlockedCount };
}

/* ── Recent games (top 20) ── */

function getRecentGames(games, n = 20) {
  return [...games]
    .filter((g) => g.start)
    .sort((a, b) => new Date(b.start).getTime() - new Date(a.start).getTime())
    .slice(0, n)
    .map((g) => ({
      gameId: g.gameId,
      start: g.start,
      map: g.map || "Inconnue",
      mode: g.mode || "—",
      result: g.result || "—",
      durationSeconds: gameDurationSec(g),
      totalPlayers: g.totalPlayers || null,
      rankedType: g.rankedType || null,
      category: classifyGame(g),
    }));
}

/* ── Main: compute stats for one player ── */

function computePlayerStats(publicId) {
  const dataPath = path.join(DATA_DIR, `${publicId}.json`);
  if (!fs.existsSync(dataPath)) {
    console.warn(`[stats] No data file for ${publicId}, skipping`);
    return null;
  }

  const rawData = JSON.parse(fs.readFileSync(dataPath, "utf8"));
  const games = rawData.games || [];
  const statsTree = rawData.profileStats || null; // if we stored the aggregated stats

  console.log(`[stats] ${publicId}: computing from ${games.length} games...`);

  const pt = computeStats(games, statsTree);
  const achievements = computeAchievements(pt);
  const recentGames = getRecentGames(games, 20);

  // Build the final summary — everything pre-formatted for instant display
  const summary = {
    publicId,
    username: rawData.username || publicId,
    computedAt: new Date().toISOString(),
    lastSyncedAt: rawData.lastSyncedAt || null,
    totalGames: pt.totalGames,

    // Career wins (from aggregated stats, accurate)
    careerWins: pt.careerWins,
    totalWins: totalWins(pt.careerWins),
    points: pointsFor(pt.careerWins),

    // Pre-formatted strings (ready to display)
    formatted: {
      points: formatPoints(pointsFor(pt.careerWins)),
      totalWins: formatPoints(totalWins(pt.careerWins)),
      totalGames: formatPoints(pt.totalGames),
      totalPlaytime: formatDuration(pt.totalPlaytimeSec),
      totalPlaytimeCompact: formatDurationCompact(pt.totalPlaytimeSec),
      avgGameDuration: formatDuration(pt.avgGameDurationSec),
      longestGame: formatDuration(pt.longestGameSec),
      winrate: formatPct(pt.results.victory / Math.max(1, pt.results.victory + pt.results.defeat)),
    },

    // Playtime
    playtime: {
      totalSec: pt.totalPlaytimeSec,
      avgGameSec: pt.avgGameDurationSec,
      longestSec: pt.longestGameSec,
      shortestSec: pt.shortestGameSec,
      byVisibility: pt.byVisibility,
      byCategory: pt.byCategory,
    },

    // Results
    results: pt.results,

    // Map stats
    maps: pt.byMap.map((m) => ({
      ...m,
      formatted: {
        playtime: formatDurationCompact(m.playtimeSec),
        avgDuration: formatDurationCompact(m.avgDuration),
        winRate: formatPct(m.winRate),
        lastPlayed: m.lastPlayed > 0
          ? new Intl.DateTimeFormat("fr-FR", { day: "2-digit", month: "2-digit", year: "2-digit" }).format(new Date(m.lastPlayed))
          : "—",
      },
    })),

    // Activity
    activity: {
      byHour: pt.byHour,
      byWeekday: pt.byWeekday,
      byDay: pt.byDay,
      peakHour: pt.byHour.indexOf(Math.max(...pt.byHour)),
      peakWeekday: ["Lun", "Mar", "Mer", "Jeu", "Ven", "Sam", "Dim"][pt.byWeekday.indexOf(Math.max(...pt.byWeekday))],
      activeDays: pt.byDay.filter((d) => d.count > 0).length,
    },

    // Streaks
    streaks: {
      current: pt.currentStreak,
      best: pt.bestStreak,
    },

    // Achievements
    achievements,

    // Recent games (top 20)
    recentGames,
  };

  return summary;
}

/* ── Main ── */

async function main() {
  const args = process.argv.slice(2);
  let publicIds = [];

  for (const arg of args) {
    if (!arg.startsWith("-")) publicIds.push(arg);
  }

  if (publicIds.length === 0) {
    // Compute for all players in player-data/
    if (!fs.existsSync(DATA_DIR)) {
      console.error(`[stats] No player-data directory`);
      process.exit(1);
    }
    const files = fs.readdirSync(DATA_DIR).filter((f) => f.endsWith(".json") && !f.startsWith("_"));
    publicIds = files.map((f) => f.replace(".json", ""));
    console.log(`[stats] Found ${publicIds.length} player data files`);
  }

  if (!fs.existsSync(STATS_DIR)) fs.mkdirSync(STATS_DIR, { recursive: true });

  console.log(`[stats] Computing stats for ${publicIds.length} player(s) at ${new Date().toISOString()}`);

  const results = [];
  for (const pid of publicIds) {
    try {
      const summary = computePlayerStats(pid);
      if (summary) {
        const statsPath = path.join(STATS_DIR, `${pid}.json`);
        fs.writeFileSync(statsPath, JSON.stringify(summary, null, 2));
        console.log(`[stats] ✅ ${pid}: ${summary.totalGames} games, ${summary.formatted.totalPlaytime} playtime → ${statsPath}`);
        results.push({ publicId: pid, ok: true, totalGames: summary.totalGames, playtime: summary.formatted.totalPlaytime });
      } else {
        results.push({ publicId: pid, ok: false, error: "no data file" });
      }
    } catch (e) {
      console.error(`[stats] ❌ ${pid}: ${e.message}`);
      results.push({ publicId: pid, ok: false, error: e.message });
    }
  }

  // Write summary
  const summaryPath = path.join(STATS_DIR, "_stats-summary.json");
  fs.writeFileSync(summaryPath, JSON.stringify({
    computedAt: new Date().toISOString(),
    results,
  }, null, 2));

  console.log(`\n[stats] Done! ${results.filter((r) => r.ok).length}/${results.length} succeeded`);
}

main().catch((e) => {
  console.error("[stats] Fatal:", e);
  process.exit(1);
});
