// pulse.js — Méta analyzer OpenFront
// Analyse les tendances depuis ranked.json + dashboard_scores.json

const PULSE_VIEW = document.getElementById("pulse-view");

function esc(s) { if (s==null) return ""; return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&#39;"); }
function fmt(n) { return new Intl.NumberFormat("fr-FR").format(n || 0); }
function fmtDate(ts) { if (!ts) return "—"; return new Date(ts).toLocaleString("fr-FR",{day:"2-digit",month:"short",hour:"2-digit",minute:"2-digit"}); }

async function loadData() {
  const [rankedRes, scoresRes] = await Promise.all([
    fetch("ranked.json", { cache: "force-cache" }),
    fetch("dashboard_scores.json.gz", { cache: "force-cache" }),
  ]);
  if (!rankedRes.ok) throw new Error("Impossible de charger ranked.json");
  const ranked = await rankedRes.json();

  let scores = null;
  if (scoresRes.ok) {
    try {
      const ds = new DecompressionStream("gzip");
      scores = await new Response(scoresRes.body.pipeThrough(ds)).json();
    } catch {}
  }
  if (!scores) { try { scores = await (await fetch("dashboard_scores.json")).json(); } catch {} }
  return { ranked, scores };
}

function analyze(ranked, scores) {
  const p1 = ranked["1v1"] || [];
  const p2 = ranked["2v2"] || [];
  const players = (scores?.players) || [];

  // Mode distribution (from dashboard scores: FFA casual vs ranked vs team)
  let ffaCasualWins = 0, ffaRankedWins = 0, teamCasualWins = 0, teamRankedWins = 0;
  let weeklyFFA = 0, weeklyTeam = 0;
  for (const p of players) {
    ffaCasualWins += p.ffa_casual || 0;
    ffaRankedWins += p.ffa_ranked || 0;
    teamCasualWins += p.team_casual || 0;
    teamRankedWins += p.team_ranked || 0;
    weeklyFFA += (p.weekly_ffa_casual || 0) + (p.weekly_ffa_ranked || 0);
    weeklyTeam += (p.weekly_team_casual || 0) + (p.weekly_team_ranked || 0);
  }

  // ELO distribution (1v1)
  const eloBuckets = { "0-500": 0, "500-1000": 0, "1000-1500": 0, "1500-2000": 0, "2000-2500": 0, "2500+": 0 };
  for (const p of p1) {
    const elo = p.elo || 0;
    if (elo < 500) eloBuckets["0-500"]++;
    else if (elo < 1000) eloBuckets["500-1000"]++;
    else if (elo < 1500) eloBuckets["1000-1500"]++;
    else if (elo < 2000) eloBuckets["1500-2000"]++;
    else if (elo < 2500) eloBuckets["2000-2500"]++;
    else eloBuckets["2500+"]++;
  }

  // Top ELO players
  const topElo = [...p1].sort((a,b) => b.elo - a.elo).slice(0, 10);

  // Most active players (by total games in ranked)
  const mostActive = [...p1, ...p2].sort((a,b) => b.total - a.total).slice(0, 10);

  // Best winrates
  const bestWr1v1 = p1.filter(p => p.total >= 10).sort((a,b) => (b.wins/b.total) - (a.wins/a.total)).slice(0, 5);
  const bestWr2v2 = p2.filter(p => p.total >= 5).sort((a,b) => (b.wins/b.total) - (a.wins/a.total)).slice(0, 5);

  // Weekly activity
  const weeklyActive = players.filter(p => (p.weekly_points || 0) > 0).length;
  const totalPoints = players.reduce((s,p) => s + (p.points || 0), 0);
  const weeklyPoints = players.reduce((s,p) => s + (p.weekly_points || 0), 0);

  return {
    p1Count: p1.length, p2Count: p2.length,
    totalRankedGames: p1.reduce((s,p) => s+p.total, 0) + p2.reduce((s,p) => s+p.total, 0),
    ffaCasualWins, ffaRankedWins, teamCasualWins, teamRankedWins,
    weeklyFFA, weeklyTeam, weeklyActive,
    totalPoints, weeklyPoints,
    eloBuckets, topElo, mostActive, bestWr1v1, bestWr2v2,
    updatedAt: ranked.updatedAt,
    scoresUpdate: scores?.lastUpdate,
    weekStart: scores?.weekStart,
    totalTracked: players.length,
  };
}

function render(data) {
  const modeTotal = data.ffaCasualWins + data.ffaRankedWins + data.teamCasualWins + data.teamRankedWins || 1;
  const ffaPct = ((data.ffaCasualWins + data.ffaRankedWins) / modeTotal * 100).toFixed(0);
  const teamPct = ((data.teamCasualWins + data.teamRankedWins) / modeTotal * 100).toFixed(0);
  const rankedPct = (data.ffaRankedWins / modeTotal * 100).toFixed(0);

  const maxEloBucket = Math.max(...Object.values(data.eloBuckets), 1);

  PULSE_VIEW.innerHTML = `
    <div class="pulse-intro">
      <p class="pulse-intro-sub">Analyse en temps réel du méta OpenFront — répartition des modes, distribution ELO, joueurs les plus actifs et tendances hebdomadaires.</p>
    </div>

    <!-- KPIs -->
    <div class="pulse-kpis">
      <div class="pulse-kpi"><span class="pulse-kpi-val">${data.p1Count + data.p2Count}</span><span class="pulse-kpi-label">Joueurs classés</span></div>
      <div class="pulse-kpi"><span class="pulse-kpi-val">${fmt(data.totalRankedGames)}</span><span class="pulse-kpi-label">Parties classées</span></div>
      <div class="pulse-kpi"><span class="pulse-kpi-val">${data.totalTracked}</span><span class="pulse-kpi-label">Joueurs tracked</span></div>
      <div class="pulse-kpi"><span class="pulse-kpi-val">${data.weeklyActive}</span><span class="pulse-kpi-label">Actifs cette semaine</span></div>
    </div>

    <!-- Méta alert -->
    ${data.weeklyFFA > data.weeklyTeam ? `
    <div class="pulse-alert">
      <span class="pulse-alert-icon">🔥</span>
      <div><strong>FFA domine cette semaine</strong> — ${data.weeklyFFA} victoires FFA contre ${data.weeklyTeam} en Team (${Math.round(data.weeklyFFA / Math.max(data.weeklyFFA + data.weeklyTeam, 1) * 100)}% FFA)</div>
    </div>` : `
    <div class="pulse-alert">
      <span class="pulse-alert-icon">⚔️</span>
      <div><strong>Team mode en force</strong> — ${data.weeklyTeam} victoires Team contre ${data.weeklyFFA} en FFA cette semaine</div>
    </div>`}

    <div class="pulse-grid">
      <!-- Mode distribution -->
      <div class="pulse-section">
        <div class="pulse-section-header">🎮 Répartition des modes</div>
        <div class="pulse-section-body" style="padding:20px">
          <div class="pulse-bar-chart">
            <div class="pulse-bar-row">
              <span class="pulse-bar-label">FFA casual</span>
              <div class="pulse-bar-track"><div class="pulse-bar-fill" style="width:${(data.ffaCasualWins / modeTotal * 100).toFixed(0)}%;background:#ff7a00"></div></div>
              <span class="pulse-bar-val">${fmt(data.ffaCasualWins)}</span>
            </div>
            <div class="pulse-bar-row">
              <span class="pulse-bar-label">FFA classé</span>
              <div class="pulse-bar-track"><div class="pulse-bar-fill" style="width:${(data.ffaRankedWins / modeTotal * 100).toFixed(0)}%;background:#e86e00"></div></div>
              <span class="pulse-bar-val">${fmt(data.ffaRankedWins)}</span>
            </div>
            <div class="pulse-bar-row">
              <span class="pulse-bar-label">Team casual</span>
              <div class="pulse-bar-track"><div class="pulse-bar-fill" style="width:${(data.teamCasualWins / modeTotal * 100).toFixed(0)}%;background:#06b6d4"></div></div>
              <span class="pulse-bar-val">${fmt(data.teamCasualWins)}</span>
            </div>
            <div class="pulse-bar-row">
              <span class="pulse-bar-label">Team classé</span>
              <div class="pulse-bar-track"><div class="pulse-bar-fill" style="width:${(data.teamRankedWins / modeTotal * 100).toFixed(0)}%;background:#0891b2"></div></div>
              <span class="pulse-bar-val">${fmt(data.teamRankedWins)}</span>
            </div>
          </div>
          <div style="margin-top:16px;display:flex;gap:16px;font-size:13px;color:var(--muted)">
            <span>FFA: <strong style="color:var(--orange)">${ffaPct}%</strong></span>
            <span>Team: <strong style="color:#06b6d4">${teamPct}%</strong></span>
            <span>Classé: <strong style="color:var(--text)">${rankedPct}%</strong></span>
          </div>
        </div>
      </div>

      <!-- ELO distribution -->
      <div class="pulse-section">
        <div class="pulse-section-header">📊 Distribution ELO (1v1)</div>
        <div class="pulse-section-body" style="padding:20px">
          <div class="pulse-bar-chart">
            ${Object.entries(data.eloBuckets).map(([label, count]) => `
              <div class="pulse-bar-row">
                <span class="pulse-bar-label">${label}</span>
                <div class="pulse-bar-track"><div class="pulse-bar-fill" style="width:${(count / maxEloBucket * 100).toFixed(0)}%;background:var(--orange)"></div></div>
                <span class="pulse-bar-val">${count}</span>
              </div>
            `).join("")}
          </div>
          <div style="margin-top:12px;font-size:12px;color:var(--muted)">
            ELO moyen: <strong style="color:var(--orange)">${Math.round(data.topElo.reduce((s,p) => s + p.elo, 0) / Math.max(data.topElo.length, 1))}</strong> (top 10)
          </div>
        </div>
      </div>

      <!-- Top ELO -->
      <div class="pulse-section">
        <div class="pulse-section-header">🏆 Top ELO 1v1</div>
        <div class="pulse-section-body">
          ${data.topElo.map((p, i) => `
            <div class="pulse-row" onclick="location.href='profile.html?pid=${esc(p.public_id)}&player=${esc(p.username)}'">
              <span class="pulse-rank">${i + 1}</span>
              <span class="pulse-name">${esc(p.username)}</span>
              <span class="pulse-value">${p.elo}</span>
            </div>
          `).join("")}
        </div>
      </div>

      <!-- Most active -->
      <div class="pulse-section">
        <div class="pulse-section-header">⚡ Joueurs les plus actifs</div>
        <div class="pulse-section-body">
          ${data.mostActive.map((p, i) => `
            <div class="pulse-row" onclick="location.href='profile.html?pid=${esc(p.public_id)}&player=${esc(p.username)}'">
              <span class="pulse-rank">${i + 1}</span>
              <span class="pulse-name">${esc(p.username)}</span>
              <span class="pulse-value">${fmt(p.total)} parties</span>
            </div>
          `).join("")}
        </div>
      </div>

      <!-- Best winrates 1v1 -->
      <div class="pulse-section">
        <div class="pulse-section-header">🎯 Best winrates 1v1 (10+)</div>
        <div class="pulse-section-body">
          ${data.bestWr1v1.map((p, i) => `
            <div class="pulse-row" onclick="location.href='profile.html?pid=${esc(p.public_id)}&player=${esc(p.username)}'">
              <span class="pulse-rank">${i + 1}</span>
              <span class="pulse-name">${esc(p.username)}</span>
              <span class="pulse-value">${((p.wins/p.total)*100).toFixed(1)}%</span>
            </div>
          `).join("")}
        </div>
      </div>

      <!-- Best winrates 2v2 -->
      <div class="pulse-section">
        <div class="pulse-section-header">🎯 Best winrates 2v2 (5+)</div>
        <div class="pulse-section-body">
          ${data.bestWr2v2.map((p, i) => `
            <div class="pulse-row" onclick="location.href='profile.html?pid=${esc(p.public_id)}&player=${esc(p.username)}'">
              <span class="pulse-rank">${i + 1}</span>
              <span class="pulse-name">${esc(p.username)}</span>
              <span class="pulse-value">${((p.wins/p.total)*100).toFixed(1)}%</span>
            </div>
          `).join("")}
        </div>
      </div>
    </div>

    <!-- Weekly summary -->
    <div class="pulse-weekly">
      <div class="pulse-weekly-header">
        <h3>Résumé de la semaine</h3>
        <span class="pulse-weekly-date">Depuis ${fmtDate(data.weekStart)}</span>
      </div>
      <div class="pulse-weekly-grid">
        <div class="pulse-weekly-stat"><span>${data.weeklyActive}</span><label>Joueurs actifs</label></div>
        <div class="pulse-weekly-stat"><span>${fmt(data.weeklyFFA)}</span><label>Victoires FFA</label></div>
        <div class="pulse-weekly-stat"><span>${fmt(data.weeklyTeam)}</span><label>Victoires Team</label></div>
        <div class="pulse-weekly-stat"><span>${fmt(data.weeklyPoints)}</span><label>Points distribués</label></div>
      </div>
    </div>

    <!-- Sync info -->
    <div style="padding:12px 18px;background:var(--bg-subtle);border-radius:8px;font-size:12px;color:var(--muted);display:flex;gap:16px;flex-wrap:wrap;margin-top:16px">
      <span>📊 Ranked sync: ${fmtDate(data.updatedAt)}</span>
      <span>📊 Scores sync: ${fmtDate(data.scoresUpdate)}</span>
      <span>📅 Semaine: ${fmtDate(data.weekStart)}</span>
    </div>
  `;
}

(async () => {
  try {
    const { ranked, scores } = await loadData();
    const data = analyze(ranked, scores);
    render(data);
  } catch (e) {
    PULSE_VIEW.innerHTML = `<div class="pulse-error"><h3>Erreur</h3><p>${esc(e.message)}</p></div>`;
  }
})();
