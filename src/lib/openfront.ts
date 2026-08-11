/**
 * OpenFront client-side helpers.
 *
 * Architecture (NO SYNC at runtime — the browser makes the requests):
 *
 *   1. ranked.json  → static, served from /public (auto-synced offline by
 *      GitHub Actions). Contains career ranked wins for the top 100 1v1
 *      and top 100 2v2 players. NO sync at runtime — it's just a file.
 *
 *   2. Firebase public-aliases (Firestore REST API) → list of players
 *      who linked their OpenFront Public ID via Google/Discord login.
 *
 *   3. OpenFront API → /api/openfront/public/player/<pid>/games (paginated).
 *      The Next.js route at src/app/api/openfront/[...path]/route.ts adds
 *      the `x-skailex-access` header server-side (rate-limit exemption).
 *      For each connected player, we paginate ALL their games and count
 *      victories by category (FFA casual/ranked, Team casual/ranked),
 *      both globally and for the current week (Mon-Sun Europe/Paris).
 *
 * Scoring (per Task 26 spec):
 *   FFA casual  = +10 · FFA ranked (1v1)  = +1
 *   Team casual = +5  · Team ranked (2v2) = +1
 *   (ranked = 1 pt, NOT in addition to FFA/Team)
 *
 * All functions here are browser-safe (fetch, localStorage, Date).
 */

/* ════════════════════════════════════════════════════════════════
   Types
   ════════════════════════════════════════════════════════════════ */

export type GameCategory = "ffaCasual" | "ffaRanked" | "teamCasual" | "teamRanked";

export interface Wins {
  ffaCasual: number;
  ffaRanked: number;
  teamCasual: number;
  teamRanked: number;
}

export interface OpenFrontGame {
  gameId: string;
  start: string; // ISO 8601
  durationSeconds?: number;
  duration?: number;
  map?: string;
  mode?: string; // "Free For All" | "Team" | ...
  type?: string;
  playerTeams?: number | null;
  rankedType?: string; // "1v1" | "2v2" | "unranked" | ...
  result?: string; // "victory" | "defeat" | "incomplete" | ...
  totalPlayers?: number;
  username?: string;
  clanTag?: string | null;
}

export interface RankedPlayerEntry {
  rank: number;
  elo: number;
  peakElo: number;
  wins: number;
  losses: number;
  total: number;
  public_id: string;
  accountUsername: string | null;
  username: string;
  streak: number;
  movement: number;
}

export interface RankedJson {
  "1v1": RankedPlayerEntry[];
  "2v2": RankedPlayerEntry[];
  updatedAt?: string;
}

export interface ConnectedPlayer {
  publicId: string;
  username: string;
}

export interface LiveStats {
  publicId: string;
  username: string;
  gamesCount: number;
  global: Wins;
  weekly: Wins;
  fetchedAt: number;
}

export interface MergedPlayer {
  publicId: string;
  username: string;
  clan: string | null;
  ffaCasualWins: number;
  ffaRankedWins: number;
  teamCasualWins: number;
  teamRankedWins: number;
  hasLive: boolean;
  gamesCount: number;
}

/* ════════════════════════════════════════════════════════════════
   Constants
   ════════════════════════════════════════════════════════════════ */

export const PTS_FFA_CASUAL = 10;
export const PTS_FFA_RANKED = 1;
export const PTS_TEAM_CASUAL = 5;
export const PTS_TEAM_RANKED = 1;

const LIVE_CACHE_KEY = "dash_live_stats_v2";
const LIVE_CACHE_TTL = 30 * 60 * 1000; // 30 min
const MAX_GAMES_PER_PLAYER = 5000;
const MAX_PAGES_PER_PLAYER = 500;
const FIREBASE_PROJECT = "openfront-speedrun";
const FIRESTORE_BASE = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT}/databases/(default)/documents`;

/* ════════════════════════════════════════════════════════════════
   Week helpers (Europe/Paris, ISO week starting Monday)
   ════════════════════════════════════════════════════════════════ */

/**
 * Returns the start of the current week (Monday 00:00) in Europe/Paris
 * as a UTC timestamp (ms since epoch).
 *
 * Strategy: format "now" into Europe/Paris, take the weekday, subtract
 * (weekday - 1) days, build Monday 00:00 Europe/Paris, then convert back
 * to a UTC ms timestamp. This avoids relying on a timezone DB.
 */
export function getWeekStartMs(now: number = Date.now()): number {
  // Format current time in Europe/Paris → "Mon, 11 Aug 2026 14:30:05"
  const dtf = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Paris",
    weekday: "short",
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const parts = dtf.formatToParts(new Date(now));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const weekdayStr = get("weekday"); // "Mon", "Tue", ...
  const day = parseInt(get("day"), 10);
  const month = get("month"); // "Jan", "Feb", ...
  const year = parseInt(get("year"), 10);
  const hour = parseInt(get("hour"), 10);
  const minute = parseInt(get("minute"), 10);
  const second = parseInt(get("second"), 10);

  const weekdayMap: Record<string, number> = {
    Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6,
  };
  const weekdayOffset = weekdayMap[weekdayStr] ?? 0;
  const monthMap: Record<string, number> = {
    Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5,
    Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11,
  };
  const monthIdx = monthMap[month] ?? 0;

  // Build Monday 00:00:00 in Europe/Paris as a UTC timestamp.
  // We trick Intl with a fake "UTC" date, then ask for the Europe/Paris
  // interpretation, and offset by the timezone difference.
  const mondayDay = day - weekdayOffset;
  // Construct a UTC date for Monday 00:00 (we'll correct for Paris offset).
  const utcGuess = Date.UTC(year, monthIdx, mondayDay, 0, 0, 0);
  // Compute Paris offset (in ms) at that instant.
  const parisFmt = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Paris",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const parisParts = parisFmt.formatToParts(new Date(utcGuess));
  const parisHour = parseInt(parisParts.find((p) => p.type === "hour")?.value ?? "0", 10);
  const parisMin = parseInt(parisParts.find((p) => p.type === "minute")?.value ?? "0", 10);
  // Paris local minutes since midnight.
  const parisLocalMin = parisHour * 60 + parisMin;
  // Offset (ms): Paris is ahead of UTC, so to get back to UTC, subtract.
  const offsetMs = (parisLocalMin - 0) * 60 * 1000;
  // Wait — we want "Monday 00:00 Paris" as a UTC ms. The utcGuess above
  // is "Monday 00:00 UTC", but in Paris that's "Monday 02:00" (CEST).
  // To get "Monday 00:00 Paris", we subtract 2 hours.
  // General formula: mondayParisMs = utcGuess - offsetMs (when offset positive).
  void hour; void minute; void second;
  return utcGuess - offsetMs;
}

/** Format a UTC ms timestamp as a French date in Europe/Paris. */
export function formatFrenchDate(ms: number): string {
  return new Intl.DateTimeFormat("fr-FR", {
    timeZone: "Europe/Paris",
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(new Date(ms));
}

/** Format a UTC ms timestamp with day + month only (French). */
export function formatShortFrenchDate(ms: number): string {
  return new Intl.DateTimeFormat("fr-FR", {
    timeZone: "Europe/Paris",
    day: "2-digit",
    month: "2-digit",
  }).format(new Date(ms));
}

/* ════════════════════════════════════════════════════════════════
   Fetch helpers
   ════════════════════════════════════════════════════════════════ */

/** Fetch ranked.json (static, served from /public). */
export async function fetchRankedJson(): Promise<RankedJson | null> {
  try {
    const res = await fetch("/ranked.json", { cache: "no-store" });
    if (!res.ok) return null;
    return (await res.json()) as RankedJson;
  } catch (e) {
    console.warn("[openfront] ranked.json indisponible:", (e as Error).message);
    return null;
  }
}

/** Fetch the list of connected players from Firebase public-aliases. */
export async function fetchConnectedPlayers(): Promise<ConnectedPlayer[]> {
  try {
    const res = await fetch(`${FIRESTORE_BASE}/public-aliases`, { cache: "no-store" });
    if (!res.ok) {
      console.warn(`[openfront] Firebase public-aliases: HTTP ${res.status}`);
      return [];
    }
    const data = await res.json();
    const docs: Array<{ fields?: Record<string, unknown> }> = data.documents || [];
    const seen = new Set<string>();
    const list: ConnectedPlayer[] = [];
    for (const doc of docs) {
      const fields = doc.fields || {};
      const val = (f: unknown): string => {
        if (!f || typeof f !== "object") return "";
        const obj = f as Record<string, unknown>;
        return (obj.stringValue as string) || (obj.integerValue as string) || "";
      };
      const publicId = val(fields.publicId);
      if (!/^[A-Za-z0-9]{8}$/.test(publicId)) continue;
      if (seen.has(publicId)) continue;
      seen.add(publicId);
      list.push({
        publicId,
        username: val(fields.username) || publicId,
      });
    }
    return list;
  } catch (e) {
    console.warn("[openfront] Firebase indisponible:", (e as Error).message);
    return [];
  }
}

/** Fetch with timeout. */
async function fetchWithTimeout(url: string, ms = 8000): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  return fetch(url, { cache: "no-store", signal: ctrl.signal }).finally(() =>
    clearTimeout(timer),
  );
}

/**
 * Paginate ALL games of a player via the Next.js proxy.
 * Stops early when `shouldStop(game)` returns true (used for weekly cutoff).
 * Returns the full list of games.
 */
export async function fetchAllPlayerGames(
  publicId: string,
  shouldStop?: (game: OpenFrontGame) => boolean,
  onProgress?: (count: number) => void,
): Promise<OpenFrontGame[]> {
  const all: OpenFrontGame[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < MAX_PAGES_PER_PLAYER; page++) {
    let path = `/api/openfront/public/player/${encodeURIComponent(publicId)}/games`;
    if (cursor) path += `?cursor=${encodeURIComponent(cursor)}`;
    let data: { results?: OpenFrontGame[]; nextCursor?: string | null };
    try {
      const res = await fetchWithTimeout(path, 8000);
      if (!res.ok) {
        console.warn(`[openfront] fetch games ${publicId} page ${page}: HTTP ${res.status}`);
        break;
      }
      data = await res.json();
    } catch (e) {
      console.warn(`[openfront] fetch games ${publicId} page ${page}:`, (e as Error).message);
      break;
    }
    const results = data?.results || [];
    if (results.length === 0) break;
    let stop = false;
    for (const g of results) {
      if (shouldStop && shouldStop(g)) {
        stop = true;
        break;
      }
      all.push(g);
    }
    onProgress?.(all.length);
    if (stop) break;
    if (!data.nextCursor) break;
    cursor = data.nextCursor;
    if (all.length >= MAX_GAMES_PER_PLAYER) break;
  }
  return all;
}

/* ════════════════════════════════════════════════════════════════
   Game classification + win computation
   ════════════════════════════════════════════════════════════════ */

/** Classify a game into one of the 4 categories. */
export function classifyGame(g: OpenFrontGame): GameCategory {
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

/** Compute wins (global + weekly) from a list of games. */
export function computeWinsFromGames(
  games: OpenFrontGame[],
  weekStartMs: number,
  now: number = Date.now(),
): { global: Wins; weekly: Wins } {
  const global: Wins = { ffaCasual: 0, ffaRanked: 0, teamCasual: 0, teamRanked: 0 };
  const weekly: Wins = { ffaCasual: 0, ffaRanked: 0, teamCasual: 0, teamRanked: 0 };
  const weekEnd = now; // current time = end of "this week"
  for (const g of games) {
    if (g.result !== "victory") continue;
    const cat = classifyGame(g);
    global[cat]++;
    if (g.start) {
      const t = new Date(g.start).getTime();
      if (t >= weekStartMs && t <= weekEnd) {
        weekly[cat]++;
      }
    }
  }
  return { global, weekly };
}

/** Points for a player given their win breakdown. Accepts either
 *  Wins ({ffaCasual, ffaRanked, teamCasual, teamRanked}) or
 *  MergedPlayer ({ffaCasualWins, ffaRankedWins, teamCasualWins, teamRankedWins}). */
export function pointsFor(
  w:
    | Partial<Wins>
    | Partial<MergedPlayer>
    | Record<string, number | undefined>,
): number {
  const ffaCasual = (w as Partial<Wins>).ffaCasual ?? (w as Partial<MergedPlayer>).ffaCasualWins ?? 0;
  const ffaRanked = (w as Partial<Wins>).ffaRanked ?? (w as Partial<MergedPlayer>).ffaRankedWins ?? 0;
  const teamCasual = (w as Partial<Wins>).teamCasual ?? (w as Partial<MergedPlayer>).teamCasualWins ?? 0;
  const teamRanked = (w as Partial<Wins>).teamRanked ?? (w as Partial<MergedPlayer>).teamRankedWins ?? 0;
  return (
    ffaCasual * PTS_FFA_CASUAL +
    ffaRanked * PTS_FFA_RANKED +
    teamCasual * PTS_TEAM_CASUAL +
    teamRanked * PTS_TEAM_RANKED
  );
}

/** Total wins across all categories. Accepts either Wins or MergedPlayer. */
export function totalWins(
  w:
    | Partial<Wins>
    | Partial<MergedPlayer>
    | Record<string, number | undefined>,
): number {
  const ffaCasual = (w as Partial<Wins>).ffaCasual ?? (w as Partial<MergedPlayer>).ffaCasualWins ?? 0;
  const ffaRanked = (w as Partial<Wins>).ffaRanked ?? (w as Partial<MergedPlayer>).ffaRankedWins ?? 0;
  const teamCasual = (w as Partial<Wins>).teamCasual ?? (w as Partial<MergedPlayer>).teamCasualWins ?? 0;
  const teamRanked = (w as Partial<Wins>).teamRanked ?? (w as Partial<MergedPlayer>).teamRankedWins ?? 0;
  return ffaCasual + ffaRanked + teamCasual + teamRanked;
}

/* ════════════════════════════════════════════════════════════════
   Cache (localStorage)
   ════════════════════════════════════════════════════════════════ */

type LiveCache = Record<string, LiveStats>;

export function loadLiveCache(): LiveCache {
  try {
    const raw = localStorage.getItem(LIVE_CACHE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") return parsed as LiveCache;
  } catch {
    /* ignore */
  }
  return {};
}

export function saveLiveCache(cache: LiveCache): void {
  try {
    localStorage.setItem(LIVE_CACHE_KEY, JSON.stringify(cache));
  } catch {
    /* quota exceeded — ignore */
  }
}

export function isCacheFresh(entry: LiveStats, now: number = Date.now()): boolean {
  return now - entry.fetchedAt < LIVE_CACHE_TTL;
}

/* ════════════════════════════════════════════════════════════════
   Merge: ranked.json + live stats → MergedPlayer list
   ════════════════════════════════════════════════════════════════ */

/**
 * Merge ranked.json (career ranked wins) + live stats (casual wins).
 * Returns two lists: globalView and weeklyView.
 *
 * Global view:
 *   - ranked.json players: ffaRanked/teamRanked from career, casual = 0
 *   - connected players: ffaRanked/teamRanked = max(ranked.json, API live),
 *     casual = API live
 *
 * Weekly view:
 *   - Only connected players (live API gives weekly breakdown).
 *   - ranked.json has no weekly breakdown.
 */
export function buildMergedPlayers(
  rankedData: RankedJson | null,
  liveStats: Record<string, LiveStats>,
): { global: MergedPlayer[]; weekly: MergedPlayer[] } {
  const byPid = new Map<string, MergedPlayer>();
  const getOrCreate = (pid: string, name?: string): MergedPlayer => {
    let e = byPid.get(pid);
    if (!e) {
      e = {
        publicId: pid,
        username: name || pid,
        clan: null,
        ffaCasualWins: 0,
        ffaRankedWins: 0,
        teamCasualWins: 0,
        teamRankedWins: 0,
        hasLive: false,
        gamesCount: 0,
      };
      byPid.set(pid, e);
    }
    return e;
  };

  // 1. ranked.json → career ranked wins (global only)
  if (rankedData) {
    for (const p of rankedData["1v1"] || []) {
      const nm = p.username || p.accountUsername || p.public_id;
      const e = getOrCreate(p.public_id, nm);
      e.ffaRankedWins = p.wins || 0;
      if (nm && nm !== p.public_id) e.username = nm;
    }
    for (const p of rankedData["2v2"] || []) {
      const nm = p.username || p.accountUsername || p.public_id;
      const e = getOrCreate(p.public_id, nm);
      e.teamRankedWins = p.wins || 0;
      if (nm && nm !== p.public_id) e.username = nm;
    }
  }

  // 2. Live stats → casual wins + (weekly) ranked wins
  for (const [pid, live] of Object.entries(liveStats)) {
    const e = getOrCreate(pid, live.username);
    // Global: take max(ranked.json, API live) for ranked, API live for casual
    e.ffaCasualWins = live.global.ffaCasual;
    e.teamCasualWins = live.global.teamCasual;
    e.ffaRankedWins = Math.max(e.ffaRankedWins, live.global.ffaRanked);
    e.teamRankedWins = Math.max(e.teamRankedWins, live.global.teamRanked);
    e.hasLive = true;
    e.gamesCount = live.gamesCount;
    if (live.username && live.username !== pid) e.username = live.username;
  }

  // Build the two views
  const all = [...byPid.values()];
  const globalView: MergedPlayer[] = all
    .map((p) => ({ ...p, points: pointsFor(p) }))
    .sort((a, b) => (b.points ?? 0) - (a.points ?? 0));

  // Weekly view: only players with live stats (no ranked.json weekly breakdown)
  const weeklyView: MergedPlayer[] = all
    .filter((p) => p.hasLive)
    .map((p) => {
      const live = liveStats[p.publicId];
      const weeklyWins: Wins = live?.weekly ?? {
        ffaCasual: 0,
        ffaRanked: 0,
        teamCasual: 0,
        teamRanked: 0,
      };
      return {
        ...p,
        ffaCasualWins: weeklyWins.ffaCasual,
        ffaRankedWins: weeklyWins.ffaRanked,
        teamCasualWins: weeklyWins.teamCasual,
        teamRankedWins: weeklyWins.teamRanked,
        points: pointsFor(weeklyWins),
      };
    })
    .sort((a, b) => (b.points ?? 0) - (a.points ?? 0));

  return { global: globalView, weekly: weeklyView };
}

/* ════════════════════════════════════════════════════════════════
   Format helpers
   ════════════════════════════════════════════════════════════════ */

const frFormatter = new Intl.NumberFormat("fr-FR");

export function formatPoints(n: number): string {
  return frFormatter.format(n || 0);
}
