/**
 * profile.js — Profile page logic for TheFrontHub.
 *
 * Flow:
 *   onAuthStateChanged →
 *     • no user                       → show #profile-gate
 *     • user, no Firestore profile    → show #profile-setup (ownership verification)
 *     • user, profile with publicId   → fetch OpenFront stats → show #profile-main
 *
 * Stats are fetched from `https://api.openfront.io/public/player/{publicId}` via
 * fetchOpenFront (handles CORS proxy). ELO is read from local `ranked.json`.
 * Recent games (last 5) get an additional `/public/game/{gameId}` fetch to
 * determine win/loss based on the `winner` array (clientIDs of winners).
 */

import {
  auth, db, doc, getDoc, setDoc,
  collection, onSnapshot,
  onAuthStateChanged,
} from "./auth.js";
import { fetchOpenFront } from "./openfront-client.js?v=24";
import {
  computePlaytimeStats, extractCareerWins, totalWins, pointsFor,
  formatDurationCompact, formatPct, formatFrenchDate,
  formatPoints, classifyGame,
} from "./playtime-stats.js?v=1";

/* ── Player overlays (plaque nominative) ── */
const PLAYER_OVERLAYS = [
  { match: /skailex/i, theme: "green", images: {
    dashboard: "green_original_dashboard_48x16.webp",
    ranked:    "green_original_ranked_144x48.webp",
    speedruns: "green_original_speedruns_171x57.webp",
    profile:   "green_original_profil_304x48.webp",
  }},
  { match: /varxard/i, theme: "fire", images: {
    dashboard: "fire_dashboard_48x16.webp",
    ranked:    "fire_ranked_144x48.webp",
    speedruns: "fire_speedruns_171x57.webp",
    profile:   "fire_profil_304x48.webp",
  }},
  // Available themes for future players: water, earth, air
];
function getPlayerOverlay(username, context) {
  if (!username) return null;
  for (const o of PLAYER_OVERLAYS) {
    if (o.match.test(username)) {
      if (context && o.images && o.images[context]) return o.images[context];
      return o.images ? o.images.profile : null;
    }
  }
  return null;
}

/* ── State ── */
let currentUser = null;
let currentProfile = null;
let _ownershipCode = null;
let _ownershipPublicId = null;
let _ownershipUsername = null;
let _rankedCache = null;
let _allGamesCache = null; // toutes les games paginées (pour playtime + map stats)
let _allGamesLoading = false;
let _mapStatsSortBy = "count";
let _mapStatsShowAll = false;

