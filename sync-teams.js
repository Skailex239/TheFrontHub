// sync-teams.js — Fetches team speedrun data from OpenFront API
// 3 separate categories: Duos, Trios, Quads
// Filters: Public, 10+ players, 400 bots, Normal map, no modifiers
// Usage: node sync-teams.js

const https = require('https');
const fs = require('fs');
const zlib = require('zlib');

const API_HOST = 'api.openfront.io';
const TEAM_MODES = ['Duos', 'Trios', 'Quads'];
const DAYS_BACK = 7;
const API_LIMIT = 1000;
const DETAIL_FETCH_CAP = 150;
const TOP_PER_MAP = 25;
const RATE_MS = 400;

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

function apiGet(path) {
  return new Promise((resolve, reject) => {
    const req = https.get({ hostname: API_HOST, path, headers: { 'Accept': 'application/json', 'User-Agent': 'skailex' }, timeout: 20000 }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error('JSON parse: ' + data.slice(0, 200))); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

async function fetchAllGames(mode, startDate, endDate) {
  let all = [];
  let offset = 0;
  while (true) {
    const path = '/public/games?start=' + encodeURIComponent(startDate) + '&end=' + encodeURIComponent(endDate) + '&type=Public&mode=Team&playerTeams=' + encodeURIComponent(mode) + '&limit=' + API_LIMIT + '&offset=' + offset;
    const batch = await apiGet(path);
    if (!batch || !Array.isArray(batch) || !batch.length) break;
    all = all.concat(batch);
    if (batch.length < API_LIMIT) break;
    offset += API_LIMIT;
    await delay(RATE_MS);
  }
  return all;
}

// Check if a game config has any modifiers (reject if yes)
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

async function main() {
  console.log('🔄 Team Speedrun Sync starting...');
  console.log('Date range: last ' + DAYS_BACK + ' days');
  console.log('Categories: Duos, Trios, Quads (separate)');
  const result = { lastUpdate: new Date().toISOString(), duos: {}, trios: {}, quads: {} };
  const now = new Date();

  for (const mode of TEAM_MODES) {
    const key = mode.toLowerCase();
    console.log('\n📋 Syncing ' + mode + '...');

    let allQualified = [];

    for (let d = 0; d < DAYS_BACK; d++) {
      const dayStart = new Date(now);
      dayStart.setUTCDate(dayStart.getUTCDate() - d);
      dayStart.setUTCHours(0, 0, 0, 0);
      const dayEnd = new Date(dayStart);
      dayEnd.setUTCHours(23, 59, 59, 999);

      const startStr = dayStart.toISOString().slice(0, 19) + '.000Z';
      const endStr = dayEnd.toISOString().slice(0, 19) + '.999Z';

      try {
        const games = await fetchAllGames(mode, startStr, endStr);
        console.log('  [' + key + '] Day -' + d + ': ' + games.length + ' games');

        for (const g of games) {
          if (g.type !== 'Public') continue;
          if ((g.numPlayers || 0) < 10) continue;

          const dur = (new Date(g.end) - new Date(g.start)) / 1000;
          if (dur < 60 || dur > 7200) continue;

          allQualified.push({ gameId: g.game, duration_s: dur, date: g.start, numPlayers: g.numPlayers });
        }
      } catch (e) {
        console.error('  [' + key + '] Error -' + d + ': ' + e.message);
      }
      await delay(RATE_MS * 2);
    }

    allQualified.sort((a, b) => a.duration_s - b.duration_s);
    const topGames = allQualified.slice(0, DETAIL_FETCH_CAP);
    console.log('  [' + key + '] ' + allQualified.length + ' qualified, fetching top ' + topGames.length + '...');

    let fetched = 0;
    for (const g of topGames) {
      try {
        const detail = await apiGet('/public/game/' + g.gameId + '?turns=false');
        const info = detail.info;
        if (!info) continue;
        const c = info.config;
        if (!c) continue;

        // Strict filters
        if (c.gameType !== 'Public') continue;
        if (c.gameMode !== 'Team') continue;
        if (c.playerTeams !== mode) continue;
        if (c.bots !== 400) continue;
        if (c.gameMapSize && c.gameMapSize !== 'Normal') continue;
        if (hasModifiers(c)) continue;

        const winner = info.winner;
        if (!winner || !Array.isArray(winner) || winner[0] !== 'team' || winner.length < 3) continue;

        const winnerIds = winner.slice(2);
        const winnerPlayers = info.players.filter(p => winnerIds.includes(p.clientID) && p.username && !p.isBot);
        if (!winnerPlayers.length) continue;

        const map = c.gameMap || 'Unknown';
        if (!result[key][map]) result[key][map] = [];

        result[key][map].push({
          players: winnerPlayers.map(p => ({
            username: p.username,
            clientID: p.clientID,
            clanTag: p.clanTag || null
          })),
          team: winner[1], // team name
          duration_s: info.duration,
          date: info.start,
          gameId: g.gameId,
          difficulty: c.difficulty || 'Medium',
          numPlayers: info.players.filter(p => !p.isBot).length
        });

        fetched++;
      } catch (e) { /* skip */ }
      await delay(RATE_MS);
    }

    // Sort by duration and keep top 25 per map
    let totalRuns = 0, totalMaps = 0;
    for (const map in result[key]) {
      result[key][map].sort((a, b) => a.duration_s - b.duration_s);
      result[key][map] = result[key][map].slice(0, TOP_PER_MAP);
      totalRuns += result[key][map].length;
      totalMaps++;
    }
    console.log('  ✅ ' + mode + ': ' + totalMaps + ' maps, ' + totalRuns + ' runs');
  }

  // Write teams.json (full)
  fs.writeFileSync('teams.json', JSON.stringify(result, null, 2));
  
  // Write teams.json.gz (compressed)
  const jsonStr = JSON.stringify(result);
  fs.writeFileSync('teams.json.gz', zlib.gzipSync(jsonStr));
  
  // Generate compact public payload (top 25/map, no full player lists)
  const publicPayload = {
    u: result.lastUpdate,
    duos: {},
    trios: {},
    quads: {}
  };
  for (const key of ['duos', 'trios', 'quads']) {
    for (const map in result[key]) {
      publicPayload[key][map] = result[key][map].map(r => ({
        t: r.players.map(p => p.username).join(' + '),
        d: r.duration_s,
        g: r.gameId,
        n: r.numPlayers
      }));
    }
  }
  const publicJson = JSON.stringify(publicPayload);
  fs.writeFileSync('teams_public.json', publicJson);
  fs.writeFileSync('teams_public.json.gz', zlib.gzipSync(publicJson));
  
  const dm = Object.keys(result.duos).length;
  const tr = Object.keys(result.trios).length;
  const qd = Object.keys(result.quads).length;
  console.log('\n✅ teams.json written! (' + dm + ' duo, ' + tr + ' trio, ' + qd + ' quad maps)');
  console.log('✅ teams_public.json.gz written (' + (zlib.gzipSync(publicJson).length / 1024).toFixed(1) + ' KB)');
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
