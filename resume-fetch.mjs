/**
 * resume-fetch.mjs — Continue la pagination depuis verify-player-games.json.
 * Sauvegarde le curseur entre les runs pour permettre la reprise.
 */
import fs from "fs";

const API_BASE = "https://api.openfront.io";
const PUBLIC_ID = process.argv[2] || "UWetOwlW";
const STATE_FILE = "verify-state.json";
const GAMES_FILE = "verify-player-games.json";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchJsonWithRetry(url, attempt = 0) {
  const r = await fetch(url, { headers: { "User-Agent": "TheFrontHub-Verify/1.0" } });
  if (r.status === 429) {
    const wait = Math.min(30000, 2000 * Math.pow(2, attempt));
    if (attempt < 6) {
      process.stdout.write(`  429 (wait ${wait}ms)...`);
      await sleep(wait);
      process.stdout.write(" retry...");
      return fetchJsonWithRetry(url, attempt + 1);
    }
    throw new Error(`429 after ${attempt} retries`);
  }
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

// Charger l'état précédent
let state = { cursor: null, games: [], page: 0 };
try {
  const s = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  if (s.publicId === PUBLIC_ID) state = s;
  console.log(`Reprise: ${state.games.length} games déjà récupérées, curseur ${state.cursor ? "présent" : "vide"}`);
} catch (e) {
  // Essayer de charger depuis verify-player-games.json (ancien format)
  try {
    const g = JSON.parse(fs.readFileSync(GAMES_FILE, "utf8"));
    if (g.publicId === PUBLIC_ID && g.games?.length) {
      state.games = g.games;
      state.page = Math.floor(g.games.length / 10);
      console.log(`Reprise depuis verify-player-games.json: ${state.games.length} games`);
      console.log("⚠️ Curseur perdu — on doit repartir du début et dédoublonner");
    }
  } catch (e2) {
    console.log("Démarrage à zéro");
  }
}

// Si on n'a pas de curseur mais qu'on a des games, on doit tout recommencer
// et dédoublonner. Sinon on continue depuis le curseur.
const startTime = Date.now();
const seen = new Set(state.games.map((g) => g.gameId));
let cursor = state.cursor;
let page = state.page;
let added = 0;
let duplicates = 0;

console.log(`\n=== Reprise de la pagination pour ${PUBLIC_ID} ===\n`);

while (page < 5000) {
  page++;
  let url = `${API_BASE}/public/player/${PUBLIC_ID}/games`;
  if (cursor) url += `?cursor=${encodeURIComponent(cursor)}`;
  process.stdout.write(`  [${page}] ${new Date().toISOString().slice(11, 19)} `);
  let data;
  try {
    data = await fetchJsonWithRetry(url);
  } catch (e) {
    console.error(`❌ ${e.message}`);
    break;
  }
  const n = data.results?.length || 0;
  console.log(`${n} games`);
  if (n > 0) {
    for (const g of data.results) {
      if (!seen.has(g.gameId)) {
        state.games.push(g);
        seen.add(g.gameId);
        added++;
      } else {
        duplicates++;
      }
    }
  }
  // Sauvegarder l'état toutes les 5 pages
  if (page % 5 === 0 || !data.nextCursor) {
    state.cursor = data.nextCursor;
    state.page = page;
    state.publicId = PUBLIC_ID;
    state.updatedAt = new Date().toISOString();
    fs.writeFileSync(STATE_FILE, JSON.stringify(state));
    fs.writeFileSync(GAMES_FILE, JSON.stringify({ publicId: PUBLIC_ID, games: state.games }));
  }
  if (!data.nextCursor) {
    console.log("  → Fin de pagination");
    break;
  }
  cursor = data.nextCursor;
  await sleep(600);
}

const elapsed = Math.round((Date.now() - startTime) / 1000);
console.log(`\n=== Terminé en ${elapsed}s ===`);
console.log(`Total: ${state.games.length} games (+${added} nouvelles, ${duplicates} doublons)`);
if (state.games.length > 0) {
  console.log(`Première: ${state.games[0].start}`);
  console.log(`Dernière : ${state.games[state.games.length - 1].start}`);
}
