/**
 * tournaments.js — Power Ranking tournament system for TheFrontHub.
 * Converted from PR-Front (React/TS) to vanilla JS.
 * 
 * Loads tournament data, computes PR rankings, renders tournament pages.
 */

// ── State ──
let _tournaments = [];
let _players = [];
let _scoring = null;
let _calendar = [];
let _leaderboard = [];
let _dataLoaded = false;

// ── Data Loading ──

async function loadTournamentData() {
  if (_dataLoaded) return;

  try {
    const [playersRes, scoringRes, calendarRes] = await Promise.all([
      fetch('data/players.json'),
      fetch('data/scoring.config.json'),
      fetch('data/calendar.json'),
    ]);

    const playersData = await playersRes.json();
    _players = (playersData.players || []).filter(p => p && p.discordId && p.name);

    const scoringRaw = await scoringRes.json();
    _scoring = {
      tiers: scoringRaw.tiers || {},
      formats: scoringRaw.formats || {},
      rewards: scoringRaw.rewards || {},
    };

    _calendar = await calendarRes.json();
    _calendar.sort((a, b) => (a.startsAt || a.date).localeCompare(b.startsAt || b.date));

    // Load all tournament files from the tournament list index
    const tournamentSlugs = [
      '2026-summer-ffa-major',
      '2026-summer-ffa-minor-4',
      'openfront-minor-1',
      'openfront-minor-2',
      'openfront-minor-3',
      'openfront-minor-4',
      'openfront-minor-5',
    ];

    const tournamentPromises = tournamentSlugs.map(slug =>
      fetch(`data/tournaments/${slug}.json`).then(r => r.ok ? r.json() : null).catch(() => null)
    );

    const tournamentResults = await Promise.all(tournamentPromises);
    _tournaments = tournamentResults
      .filter(t => t && t.slug && t.format && Array.isArray(t.phases))
      .sort((a, b) => b.date.localeCompare(a.date));

    // Compute leaderboard
    _leaderboard = computeLeaderboard(_tournaments, _players, _scoring);

    _dataLoaded = true;
    console.log(`[tournaments] ✅ Chargé: ${_tournaments.length} tournois, ${_players.length} joueurs, ${_leaderboard.length} classés`);
  } catch (e) {
    console.error('[tournaments] Erreur chargement:', e);
  }
}

// ── Scoring Engine (converted from pr.ts) ──

function basePoints(scoring, tournament, phaseType, place) {
  const formatConf = scoring.formats[tournament.format];
  if (!formatConf) return 0;
  const phaseConf = formatConf.phases[phaseType];
  if (!phaseConf) return 0;

  if (place != null && phaseConf.places[String(place)] != null) {
    return phaseConf.places[String(place)];
  }
  if (place != null && phaseConf.ranges) {
    const range = phaseConf.ranges.find(r => place >= r.min && (r.max == null || place <= r.max));
    if (range) return range.points;
  }
  return phaseConf.defaultPoints || 0;
}

function phaseUsesTierMultiplier(scoring, tournament, phaseType) {
  const phaseConf = scoring.formats[tournament.format]?.phases[phaseType];
  return !phaseConf?.ignoreTierMultiplier;
}

function isFinalPhase(scoring, tournament, phaseType) {
  if (phaseType === 'finale') return true;
  const phaseConf = scoring.formats[tournament.format]?.phases[phaseType];
  return phaseConf?.countsAsFinal === true;
}

function tierMultiplier(scoring, tournament) {
  return scoring.tiers[tournament.tier] ?? 1;
}

function rewardPoints(scoring, tournament, place) {
  const conf = scoring.rewards?.[tournament.tier];
  if (!conf || place == null) return 0;
  if (conf.places[String(place)] != null) return conf.places[String(place)];
  if (conf.ranges) {
    const range = conf.ranges.find(r => place >= r.min && (r.max == null || place <= r.max));
    if (range) return range.points;
  }
  return 0;
}

function computePlayerPRs(tournaments, scoring) {
  const prs = new Map();

  const getOrCreate = (id) => {
    if (!prs.has(id)) {
      prs.set(id, {
        playerId: id, points: 0, events: 0, wins: 0, top3: 0,
        bestPlace: null, avgPlace: null, awards: [], rewards: 0,
      });
    }
    return prs.get(id);
  };

  for (const t of [...tournaments].sort((a, b) => a.date.localeCompare(b.date))) {
    const mult = tierMultiplier(scoring, t);
    const seen = new Set();

    for (const phase of (t.phases || [])) {
      const formatConf = scoring.formats[t.format];
      const phaseLabel = formatConf?.phases[phase.type]?.label ?? phase.type;

      for (const p of (phase.placements || [])) {
        const pr = getOrCreate(p.player);
        const place = p.place ?? null;
        const base = basePoints(scoring, t, phase.type, place);
        const phaseMult = phaseUsesTierMultiplier(scoring, t, phase.type) ? mult : 1;

        pr.awards.push({
          tournamentSlug: t.slug,
          tournamentName: t.name,
          tournamentDate: t.date,
          format: t.format,
          tier: t.tier,
          phaseType: phase.type,
          phaseLabel,
          place,
          basePoints: base,
          points: Math.round(base * phaseMult),
        });
        pr.points += Math.round(base * phaseMult);
        seen.add(p.player);

        if (isFinalPhase(scoring, t, phase.type) && place != null) {
          if (place === 1) pr.wins += 1;
          if (place <= 3) pr.top3 += 1;
          pr.bestPlace = pr.bestPlace == null ? place : Math.min(pr.bestPlace, place);
        }
      }
    }

    // Compute rewards for final placements
    for (const phase of (t.phases || [])) {
      if (!isFinalPhase(scoring, t, phase.type)) continue;
      for (const p of (phase.placements || [])) {
        const pr = getOrCreate(p.player);
        pr.rewards += rewardPoints(scoring, t, p.place ?? null);
      }
    }

    for (const id of seen) {
      getOrCreate(id).events += 1;
    }
  }

  // Average placement
  for (const pr of prs.values()) {
    const finalPlaces = pr.awards
      .filter(a => {
        const t = tournaments.find(x => x.slug === a.tournamentSlug);
        return t && isFinalPhase(scoring, t, a.phaseType) && a.place != null;
      })
      .map(a => a.place);
    pr.avgPlace = finalPlaces.length > 0
      ? finalPlaces.reduce((s, v) => s + v, 0) / finalPlaces.length
      : null;
  }

  return prs;
}

function computeLeaderboard(tournaments, players, scoring) {
  const byId = new Map(players.map(p => [p.discordId, p]));
  const prs = [...computePlayerPRs(tournaments, scoring).values()];

  prs.sort((a, b) => {
    if (b.points !== a.points) return b.points - a.points;
    if (b.wins !== a.wins) return b.wins - a.wins;
    const ba = a.bestPlace ?? Infinity;
    const bb = b.bestPlace ?? Infinity;
    if (bb !== ba) return bb - ba;
    const na = byId.get(a.playerId)?.name ?? a.playerId;
    const nb = byId.get(b.playerId)?.name ?? b.playerId;
    return na.localeCompare(nb, 'fr');
  });

  return prs.map((pr, i) => ({
    ...pr,
    rank: i + 1,
    player: byId.get(pr.playerId) ?? null,
  }));
}

// ── Rendering: Tournament List Page ──

function renderTournamentsPage() {
  const container = document.getElementById('tournaments-content');
  if (!container) return;

  const activeSubTab = window._tournamentsSubTab || 'ranking';

  let html = '';

  // Stats cards
  html += renderTournamentStats();

  // Sub-tab selector
  html += `
    <div class="tournament-subtabs" style="display:flex;gap:4px;background:var(--bg);border:1px solid var(--border);border-radius:var(--radius-sm);padding:3px;margin-bottom:20px;width:fit-content">
      <button class="ranked-mode-btn ${activeSubTab === 'ranking' ? 'active' : ''}" onclick="switchTournamentSubTab('ranking')">
        <i data-icon="trophy"></i> Classement
      </button>
      <button class="ranked-mode-btn ${activeSubTab === 'tournaments' ? 'active' : ''}" onclick="switchTournamentSubTab('tournaments')">
        <i data-icon="map"></i> Tournois
      </button>
      <button class="ranked-mode-btn ${activeSubTab === 'calendar' ? 'active' : ''}" onclick="switchTournamentSubTab('calendar')">
        <i data-icon="calendar"></i> Calendrier
      </button>
    </div>
  `;

  if (activeSubTab === 'ranking') {
    html += renderRankingSection();
  } else if (activeSubTab === 'tournaments') {
    html += renderTournamentList();
  } else if (activeSubTab === 'calendar') {
    html += renderCalendarSection();
  }

  container.innerHTML = html;
  if (typeof window.refreshIcons === 'function') window.refreshIcons();
}

function renderTournamentStats() {
  const totalTournaments = _tournaments.length;
  const totalPlayers = _leaderboard.length;
  const totalParticipants = _tournaments.reduce((s, t) => s + (t.participants || 0), 0);
  const nextEvent = _calendar.length > 0 ? _calendar[0] : null;

  return `
    <section class="stats-grid" style="margin-bottom:20px">
      <div class="card">
        <h2>${totalTournaments}</h2>
        <p>Tournois</p>
        <div class="stat-icon"><i data-icon="trophy"></i></div>
      </div>
      <div class="card">
        <h2>${totalPlayers}</h2>
        <p>Joueurs classés</p>
        <div class="stat-icon"><i data-icon="users"></i></div>
      </div>
      <div class="card">
        <h2>${totalParticipants.toLocaleString('fr')}</h2>
        <p>Participants total</p>
        <div class="stat-icon"><i data-icon="chart"></i></div>
      </div>
      <div class="card">
        <h2>${nextEvent ? formatDateShort(nextEvent.date) : '—'}</h2>
        <p>Prochain événement</p>
        <div class="stat-icon"><i data-icon="bolt"></i></div>
      </div>
    </section>
  `;
}

function renderRankingSection() {
  if (_leaderboard.length === 0) {
    return '<div class="empty-state"><p>Aucun classement disponible</p></div>';
  }

  const top3 = _leaderboard.slice(0, 3);
  const rest = _leaderboard.slice(3);

  let html = '';

  // Podium
  html += `
    <div class="hof-cards" style="margin-bottom:24px">
      ${top3.map((p, i) => {
        const name = p.player?.name ?? p.playerId;
        const clan = p.player?.clan ? `[${esc(p.player.clan)}] ` : '';
        const tierClass = i === 0 ? 'hof-1' : i === 1 ? 'hof-2' : 'hof-3';
        return `
          <div class="hof-card ${tierClass}" onclick="showTournamentPlayer('${esc(p.playerId)}')" style="cursor:pointer">
            <div class="hof-name">${clan}${esc(name)}</div>
            <div class="hof-pts">${p.points.toLocaleString('fr')} PR</div>
            <div class="hof-detail">${p.wins}V · ${p.top3} podiums · ${p.events} tournois</div>
          </div>
        `;
      }).join('')}
    </div>
  `;

  // Search
  html += `
    <div class="search-bar" style="margin-bottom:12px">
      <input type="text" class="search-input" placeholder="Rechercher un joueur..." oninput="filterTournamentRanking(this.value)" id="tournament-search">
    </div>
  `;

  // Full table
  html += `
    <div class="feed-card">
      <div class="feed-header"><i data-icon="trophy"></i> Classement Power Ranking — ${_leaderboard.length} joueurs</div>
      <div class="table-container" style="overflow-x:auto">
        <table style="width:100%;border-collapse:collapse;text-align:left;font-size:13px">
          <thead>
            <tr style="border-bottom:1px solid var(--border);color:var(--muted);">
              <th style="padding:10px 12px;width:6%">#</th>
              <th style="padding:10px 12px;width:25%">Joueur</th>
              <th style="padding:10px 12px;width:10%">PR</th>
              <th style="padding:10px 12px;width:8%">Tournois</th>
              <th style="padding:10px 12px;width:8%">Victoires</th>
              <th style="padding:10px 12px;width:8%">Podiums</th>
              <th style="padding:10px 12px;width:10%">Meilleure</th>
              <th style="padding:10px 12px;width:10%">Moyenne</th>
              <th style="padding:10px 12px;width:10%">Plutonium</th>
            </tr>
          </thead>
          <tbody id="tournament-ranking-body">
            ${renderRankingRows(_leaderboard)}
          </tbody>
        </table>
      </div>
    </div>
  `;

  return html;
}

function renderRankingRows(players) {
  return players.map(p => {
    const name = p.player?.name ?? p.playerId;
    const clan = p.player?.clan ? `<span style="color:var(--muted);font-size:11px;margin-right:4px">[${esc(p.player.clan)}]</span>` : '';
    const rankColor = p.rank <= 3 ? 'var(--orange)' : 'var(--text)';
    const rewardText = p.rewards > 0 ? `${p.rewards.toLocaleString('fr')} P` : '—';

    return `
      <tr style="border-bottom:1px solid var(--border-light);cursor:pointer;transition:background var(--duration) var(--ease-out)"
          onmouseover="this.style.background='var(--card-hover)'"
          onmouseout="this.style.background='transparent'"
          onclick="showTournamentPlayer('${esc(p.playerId)}')">
        <td style="padding:10px 12px;font-weight:700;color:${rankColor};font-family:var(--mono)">#${p.rank}</td>
        <td style="padding:10px 12px;font-weight:500">${clan}${esc(name)}</td>
        <td style="padding:10px 12px;font-weight:700;color:var(--orange);font-family:var(--mono)">${p.points.toLocaleString('fr')}</td>
        <td style="padding:10px 12px;font-family:var(--mono);color:var(--muted)">${p.events}</td>
        <td style="padding:10px 12px;font-family:var(--mono);color:var(--muted)">${p.wins}</td>
        <td style="padding:10px 12px;font-family:var(--mono);color:var(--muted)">${p.top3}</td>
        <td style="padding:10px 12px;font-family:var(--mono);color:var(--muted)">${p.bestPlace != null ? '#' + p.bestPlace : '—'}</td>
        <td style="padding:10px 12px;font-family:var(--mono);color:var(--muted)">${p.avgPlace != null ? '#' + p.avgPlace.toFixed(1) : '—'}</td>
        <td style="padding:10px 12px;font-family:var(--mono);font-weight:600;color:var(--green)">${rewardText}</td>
      </tr>
    `;
  }).join('');
}

function renderTournamentList() {
  if (_tournaments.length === 0) {
    return '<div class="empty-state"><p>Aucun tournoi disponible</p></div>';
  }

  // Group by series
  const series = {};
  for (const t of _tournaments) {
    const s = t.series || 'Autres';
    if (!series[s]) series[s] = [];
    series[s].push(t);
  }

  let html = '';
  for (const [seriesName, tournaments] of Object.entries(series)) {
    html += `
      <div class="feed-card" style="margin-bottom:16px">
        <div class="feed-header">${esc(seriesName)} — ${tournaments.length} tournoi${tournaments.length > 1 ? 's' : ''}</div>
        <div style="padding:12px">
          ${tournaments.map(t => renderTournamentCard(t)).join('')}
        </div>
      </div>
    `;
  }

  return html;
}

function renderTournamentCard(t) {
  const tierLabel = t.tier === 'major' ? '🏆 Major' : t.tier === 'standard' ? 'Standard' : 'Minor';
  const tierColor = t.tier === 'major' ? 'var(--gold)' : t.tier === 'standard' ? 'var(--text)' : 'var(--muted)';
  const formatLabel = t.format === 'ffa' ? 'FFA' : t.format === 'minor' ? 'Battle Royale' : t.format;
  const isMajor = t.tier === 'major';

  return `
    <a href="tournament-detail.html?slug=${encodeURIComponent(t.slug)}" style="text-decoration:none;color:inherit">
      <div style="display:flex;align-items:center;gap:12px;padding:12px 16px;border-radius:var(--radius);border:1px solid ${isMajor ? 'rgba(255,200,0,.25)' : 'var(--border-light)'};margin-bottom:8px;transition:all var(--duration) var(--ease-out);cursor:pointer;${isMajor ? 'background:rgba(255,200,0,.03)' : 'background:var(--bg)'}"
           onmouseover="this.style.borderColor='var(--orange)';this.style.transform='translateY(-1px)'"
           onmouseout="this.style.borderColor='${isMajor ? 'rgba(255,200,0,.25)' : 'var(--border-light)'}';this.style.transform='none'">
        <div style="flex:1;min-width:0">
          <div style="font-weight:600;font-size:14px;color:var(--text);margin-bottom:2px">${esc(t.name)}</div>
          <div style="font-size:12px;color:var(--muted)">${formatDateShort(t.date)} · ${formatLabel} · ${t.participants || '?'} participants</div>
        </div>
        <div style="font-size:11px;font-weight:700;color:${tierColor};white-space:nowrap">${tierLabel}</div>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--dim)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>
      </div>
    </a>
  `;
}

function renderCalendarSection() {
  if (_calendar.length === 0) {
    return '<div class="empty-state"><h3>Aucun événement à venir</h3><p>Revenez bientôt pour les prochains tournois !</p></div>';
  }

  let html = '<div class="feed-card"><div class="feed-header"><i data-icon="bolt"></i> Prochains événements</div>';

  for (const event of _calendar) {
    const date = new Date(event.startsAt || event.date);
    const dateStr = date.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });
    const timeStr = event.startsAt ? date.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }) : '';
    const tierLabel = event.tier === 'major' ? '🏆 Major' : event.tier === 'standard' ? 'Standard' : 'Minor';
    const isMajor = event.tier === 'major';

    html += `
      <div style="padding:16px 20px;border-bottom:1px solid var(--border-light);display:flex;align-items:center;gap:16px">
        <div style="min-width:60px;text-align:center">
          <div style="font-size:24px;font-weight:800;color:var(--orange);line-height:1">${date.getDate()}</div>
          <div style="font-size:11px;color:var(--muted);text-transform:uppercase">${date.toLocaleDateString('fr-FR', { month: 'short' })}</div>
        </div>
        <div style="flex:1;min-width:0">
          <div style="font-weight:600;font-size:14px;color:var(--text);margin-bottom:2px">${esc(event.name)}</div>
          <div style="font-size:12px;color:var(--muted)">${timeStr ? timeStr + ' · ' : ''}${event.format === 'minor' ? 'Battle Royale' : event.format} · ${tierLabel}</div>
        </div>
        ${event.registrationUrl ? `<a href="${esc(event.registrationUrl)}" target="_blank" class="btn-primary" style="padding:6px 14px;font-size:12px;text-decoration:none">S'inscrire</a>` : ''}
      </div>
    `;
  }

  html += '</div>';
  return html;
}

// ── Tournament Detail Page ──

async function renderTournamentDetail() {
  const params = new URLSearchParams(window.location.search);
  const slug = params.get('slug');
  if (!slug) return;

  await loadTournamentData();
  const tournament = _tournaments.find(t => t.slug === slug);
  if (!tournament) {
    document.getElementById('tournament-detail-content').innerHTML = '<div class="empty-state"><h3>Tournoi introuvable</h3></div>';
    return;
  }

  const container = document.getElementById('tournament-detail-content');
  const isMajor = tournament.tier === 'major';

  let html = '';

  // Header
  html += `
    <div style="margin-bottom:24px;${isMajor ? 'border:2px solid rgba(255,200,0,.3);box-shadow:0 0 24px rgba(255,200,0,.08)' : ''};border-radius:var(--radius-lg);padding:20px;background:var(--card)">
      <div style="display:flex;align-items:center;gap:12px;margin-bottom:8px;flex-wrap:wrap">
        <a href="tournaments.html" style="color:var(--muted);text-decoration:none;font-size:13px;display:flex;align-items:center;gap:4px">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="15 18 9 12 15 6"/></svg>
          Tournois
        </a>
      </div>
      <h1 style="font-size:24px;font-weight:800;margin-bottom:4px;${isMajor ? 'background:linear-gradient(135deg,#ffc800,#ff7a00);-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text' : ''}">${esc(tournament.name)}</h1>
      <div style="display:flex;gap:16px;flex-wrap:wrap;font-size:13px;color:var(--muted)">
        <span>${formatDateShort(tournament.date)}</span>
        <span>${tournament.format === 'minor' ? 'Battle Royale' : tournament.format.toUpperCase()}</span>
        <span style="font-weight:700;color:${isMajor ? 'var(--gold)' : 'var(--muted)'}">${tournament.tier === 'major' ? '🏆 MAJOR' : tournament.tier}</span>
        <span>${tournament.participants} participants</span>
        ${tournament.series ? `<span>Série: ${esc(tournament.series)}</span>` : ''}
      </div>
    </div>
  `;

  // Phase results
  if (tournament.phases && tournament.phases.length > 0) {
    const formatConf = _scoring.formats[tournament.format];

    for (const phase of tournament.phases) {
      const phaseConf = formatConf?.phases[phase.type];
      const phaseLabel = phaseConf?.label ?? phase.type;
      const placements = phase.placements || [];

      html += `
        <div class="feed-card" style="margin-bottom:16px">
          <div class="feed-header">
            <i data-icon="trophy"></i> Phase — ${esc(phaseLabel)}
            <span style="float:right;font-size:11px;color:var(--dim)">${placements.length} joueurs</span>
          </div>
          <div class="table-container" style="overflow-x:auto">
            <table style="width:100%;border-collapse:collapse;text-align:left;font-size:13px">
              <thead>
                <tr style="border-bottom:1px solid var(--border);color:var(--muted)">
                  <th style="padding:8px 12px;width:8%">#</th>
                  <th style="padding:8px 12px;width:30%">Joueur</th>
                  <th style="padding:8px 12px;width:15%">PR gagné</th>
                  ${isMajor ? '<th style="padding:8px 12px;width:12%">Plutonium</th>' : ''}
                </tr>
              </thead>
              <tbody>
                ${placements.map(p => {
                  const player = _players.find(pl => pl.discordId === p.player);
                  const name = player?.name ?? p.player;
                  const clan = player?.clan ? `[${esc(player.clan)}] ` : '';
                  const base = basePoints(_scoring, tournament, phase.type, p.place);
                  const mult = phaseUsesTierMultiplier(_scoring, tournament, phase.type) ? tierMultiplier(_scoring, tournament) : 1;
                  const finalPoints = Math.round(base * mult);
                  const reward = isFinalPhase(_scoring, tournament, phase.type) ? rewardPoints(_scoring, tournament, p.place) : 0;
                  const rankStyle = p.place === 1 ? 'color:var(--gold);font-weight:700' : p.place === 2 ? 'color:var(--silver);font-weight:700' : p.place === 3 ? 'color:var(--bronze);font-weight:700' : 'color:var(--muted);font-family:var(--mono)';

                  return `
                    <tr style="border-bottom:1px solid var(--border-light);cursor:pointer" onclick="showTournamentPlayer('${esc(p.player)}')"
                        onmouseover="this.style.background='var(--card-hover)'" onmouseout="this.style.background='transparent'">
                      <td style="padding:8px 12px;${rankStyle}">${p.place ?? '—'}</td>
                      <td style="padding:8px 12px;font-weight:500">${clan}${esc(name)}</td>
                      <td style="padding:8px 12px;font-weight:700;color:var(--orange);font-family:var(--mono)">${finalPoints}</td>
                      ${isMajor ? `<td style="padding:8px 12px;font-weight:600;color:var(--green);font-family:var(--mono)">${reward > 0 ? reward + ' P' : '—'}</td>` : ''}
                    </tr>
                  `;
                }).join('')}
              </tbody>
            </table>
          </div>
        </div>
      `;
    }
  }

  // Game details
  if (tournament.details?.games && tournament.details.games.length > 0) {
    html += `
      <div class="feed-card" style="margin-bottom:16px">
        <div class="feed-header"><i data-icon="map"></i> Parties détaillées</div>
        <div style="padding:12px">
    `;

    for (const round of tournament.details.games) {
      html += `<div style="margin-bottom:12px"><div style="font-weight:700;font-size:13px;color:var(--text);margin-bottom:8px">${esc(round.round)}</div>`;

      for (const game of (round.entries || [])) {
        html += `
          <div style="display:flex;align-items:center;gap:10px;padding:8px 12px;background:var(--bg);border-radius:var(--radius-sm);margin-bottom:4px;font-size:12px">
            <span style="font-weight:600;color:var(--text)">${esc(game.name || 'Game')}</span>
            ${game.map ? `<span style="color:var(--muted)">· ${esc(game.map)}</span>` : ''}
            <span style="color:var(--muted)">${game.players} joueurs</span>
            ${game.gameUrl ? `<a href="${esc(game.gameUrl)}" target="_blank" style="margin-left:auto;color:var(--orange);text-decoration:none;font-weight:600;font-size:11px">Replay ▶</a>` : ''}
          </div>
        `;

        // Results table for this game
        if (game.results && game.results.length > 0) {
          html += `
            <div style="margin:4px 0 12px 12px;overflow-x:auto">
              <table style="width:100%;border-collapse:collapse;font-size:11px">
                <thead>
                  <tr style="color:var(--dim);border-bottom:1px solid var(--border-light)">
                    <th style="padding:4px 8px;text-align:left">#</th>
                    <th style="padding:4px 8px;text-align:left">Joueur</th>
                    <th style="padding:4px 8px;text-align:right">Kills</th>
                    <th style="padding:4px 8px;text-align:right">Points</th>
                    <th style="padding:4px 8px;text-align:right">Tiles</th>
                  </tr>
                </thead>
                <tbody>
                  ${game.results.slice(0, 15).map(r => {
                    const p = _players.find(pl => pl.discordId === r.player);
                    const name = p?.name ?? r.player;
                    const rowColor = r.place <= 3 ? 'color:var(--text);font-weight:600' : 'color:var(--muted)';
                    return `
                      <tr style="border-bottom:1px solid var(--border-light)">
                        <td style="padding:3px 8px;${rowColor}">${r.place}</td>
                        <td style="padding:3px 8px;${rowColor}">${esc(name)}</td>
                        <td style="padding:3px 8px;text-align:right;font-family:var(--mono);color:var(--muted)">${r.kills ?? '—'}</td>
                        <td style="padding:3px 8px;text-align:right;font-family:var(--mono);color:var(--orange);font-weight:600">${r.points ?? '—'}</td>
                        <td style="padding:3px 8px;text-align:right;font-family:var(--mono);color:var(--muted)">${r.finalTiles ? r.finalTiles.toLocaleString('fr') : '—'}</td>
                      </tr>
                    `;
                  }).join('')}
                </tbody>
              </table>
              ${game.results.length > 15 ? `<div style="padding:4px 8px;font-size:11px;color:var(--dim)">+ ${game.results.length - 15} autres joueurs</div>` : ''}
            </div>
          `;
        }
      }
      html += '</div>';
    }

    html += '</div></div>';
  }

  container.innerHTML = html;
  if (typeof window.refreshIcons === 'function') window.refreshIcons();
}

// ── Player Modal ──

function showTournamentPlayer(playerId) {
  await_init_then_show(playerId);
}

async function await_init_then_show(playerId) {
  await loadTournamentData();
  const entry = _leaderboard.find(e => e.playerId === playerId);
  if (!entry) return;

  const player = entry.player;
  const name = player?.name ?? playerId;
  const clan = player?.clan ? `[${player.clan}] ` : '';

  // Build awards detail
  const awardsByTournament = {};
  for (const a of entry.awards) {
    if (!awardsByTournament[a.tournamentSlug]) {
      awardsByTournament[a.tournamentSlug] = { name: a.tournamentName, date: a.tournamentDate, tier: a.tier, phases: [] };
    }
    awardsByTournament[a.tournamentSlug].phases.push(a);
  }

  let awardsHtml = '';
  const sortedTournaments = Object.entries(awardsByTournament).sort(([,a], [,b]) => b.date.localeCompare(a.date));
  for (const [slug, data] of sortedTournaments) {
    const tierBadge = data.tier === 'major' ? '🏆' : data.tier === 'standard' ? '' : '';
    const totalPR = data.phases.reduce((s, p) => s + p.points, 0);
    awardsHtml += `
      <div style="padding:8px 12px;border-bottom:1px solid var(--border-light)">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px">
          <a href="tournament-detail.html?slug=${encodeURIComponent(slug)}" style="font-weight:600;font-size:13px;color:var(--text);text-decoration:none">${tierBadge} ${esc(data.name)}</a>
          <span style="font-weight:700;color:var(--orange);font-family:var(--mono);font-size:12px">+${totalPR} PR</span>
        </div>
        <div style="font-size:11px;color:var(--muted)">${data.phases.map(p => `${p.phaseLabel}: ${p.place != null ? '#' + p.place : '✓'} (${p.points}pts)`).join(' · ')}</div>
      </div>
    `;
  }

  // Show modal
  const modal = document.getElementById('player-modal');
  if (!modal) return;

  document.getElementById('modal-player-name').innerHTML = `${clan}${esc(name)}`;
  document.getElementById('modal-player-stats').textContent = `#${entry.rank} · ${entry.points.toLocaleString('fr')} PR · ${entry.events} tournois`;
  document.getElementById('modal-wins').textContent = entry.wins;
  document.getElementById('modal-maps').textContent = entry.top3;
  document.getElementById('modal-avg').textContent = entry.avgPlace != null ? '#' + entry.avgPlace.toFixed(1) : '—';

  // Replace the runs section with tournament awards
  const runsContainer = document.getElementById('modal-runs');
  if (runsContainer) {
    runsContainer.innerHTML = awardsHtml || '<div class="empty-state">Aucun détail</div>';
  }

  modal.classList.add('active');
}

// ── Search/Filter ──

function filterTournamentRanking(query) {
  const body = document.getElementById('tournament-ranking-body');
  if (!body) return;

  const q = query.toLowerCase().trim();
  if (!q) {
    body.innerHTML = renderRankingRows(_leaderboard);
    return;
  }

  const filtered = _leaderboard.filter(p => {
    const name = (p.player?.name ?? p.playerId).toLowerCase();
    const clan = (p.player?.clan ?? '').toLowerCase();
    return name.includes(q) || clan.includes(q);
  });

  body.innerHTML = renderRankingRows(filtered);
}

function switchTournamentSubTab(tab) {
  window._tournamentsSubTab = tab;
  renderTournamentsPage();
}

// ── Helpers ──

function formatDateShort(dateStr) {
  if (!dateStr) return '—';
  const d = new Date(dateStr);
  return d.toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit', year: '2-digit' });
}

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// ── Exports ──

window.loadTournamentData = loadTournamentData;
window.renderTournamentsPage = renderTournamentsPage;
window.renderTournamentDetail = renderTournamentDetail;
window.switchTournamentSubTab = switchTournamentSubTab;
window.filterTournamentRanking = filterTournamentRanking;
window.showTournamentPlayer = showTournamentPlayer;
