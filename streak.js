// streak.js — Tracker de séries et records OpenFront
// Utilise ranked.json (top 100 1v1 + top 100 2v2) + dashboard_scores.json

const STREAK_VIEW = document.getElementById("streak-view");
const API_BASE = "https://api.openfront.io";

function esc(s) { if (s==null) return ""; return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&#39;"); }
function fmt(n) { return new Intl.NumberFormat("fr-FR").format(n || 0); }
function fmtDate(ts) { if (!ts) return "—"; return new Date(ts).toLocaleString("fr-FR",{day:"2-digit",month:"short",hour:"2-digit",minute:"2-digit"}); }

async function loadData() {
  // Load ranked.json + dashboard_scores.json.gz
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
      const decompressed = scoresRes.body.pipeThrough(ds);
      scores = await new Response(decompressed).json();
    } catch { /* fallback below */ }
  }
  if (!scores) {
    try { scores = await (await fetch("dashboard_scores.json")).json(); } catch {}
  }

  return { ranked, scores };
}

function computeRecords(ranked, scores) {
  const records = { streaks1v1: [], streaks2v2: [], winrates1v1: [], winrates2v2: [], topPoints: [], topWeekly: [] };

  // 1v1 streaks + winrates
  const p1 = (ranked["1v1"] || []).filter(p => p.total >= 10);
  records.streaks1v1 = [...p1].sort((a,b) => Math.abs(b.streak||0) - Math.abs(a.streak||0)).slice(0, 10);
  records.winrates1v1 = [...p1].sort((a,b) => (b.wins/b.total) - (a.wins/a.total)).slice(0, 10);

  // 2v2 streaks + winrates
  const p2 = (ranked["2v2"] || []).filter(p => p.total >= 5);
  records.streaks2v2 = [...p2].sort((a,b) => Math.abs(b.streak||0) - Math.abs(a.streak||0)).slice(0, 10);
  records.winrates2v2 = [...p2].sort((a,b) => (b.wins/b.total) - (a.wins/a.total)).slice(0, 10);

  // Top points (all-time)
  if (scores && scores.players) {
    records.topPoints = [...scores.players].sort((a,b) => b.points - a.points).slice(0, 10);
    records.topWeekly = [...scores.players].sort((a,b) => (b.weekly_points||0) - (a.weekly_points||0)).slice(0, 10);
  }

  return records;
}

function render(ranked, scores, records) {
  const p1Count = (ranked["1v1"] || []).length;
  const p2Count = (ranked["2v2"] || []).length;
  const totalGames = (ranked["1v1"] || []).reduce((s,p) => s + p.total, 0) + (ranked["2v2"] || []).reduce((s,p) => s + p.total, 0);
  const updatedAt = ranked.updatedAt || ranked.updated_at;

  STREAK_VIEW.innerHTML = `
    <div class="streak-intro">
      <p class="streak-intro-sub">Suivez les séries de victoires, les meilleurs winrates et les records de points de la communauté OpenFront.</p>
    </div>

    <!-- Stats globales -->
    <div class="streak-stats">
      <div class="streak-stat"><span class="streak-stat-val">${p1Count + p2Count}</span><span class="streak-stat-label">Joueurs classés</span></div>
      <div class="streak-stat"><span class="streak-stat-val">${fmt(totalGames)}</span><span class="streak-stat-label">Parties classées</span></div>
      <div class="streak-stat"><span class="streak-stat-val">${scores?.totalPlayers || "—"}</span><span class="streak-stat-label">Joueurs tracked</span></div>
      <div class="streak-stat"><span class="streak-stat-val">${fmtDate(updatedAt)}</span><span class="streak-stat-label">Dernière sync</span></div>
    </div>

    <!-- Record of the day -->
    ${records.winrates1v1[0] ? `
    <div class="streak-record-day">
      <div class="streak-record-trophy">🏆</div>
      <div class="streak-record-info">
        <div class="streak-record-label">RECORD DU JOUR — MEILLEUR WINRATE 1v1</div>
        <div class="streak-record-name">${esc(records.winrates1v1[0].username)}</div>
        <div class="streak-record-detail">${fmt(records.winrates1v1[0].wins)}V / ${fmt(records.winrates1v1[0].losses)}D — ${((records.winrates1v1[0].wins / records.winrates1v1[0].total) * 100).toFixed(1)}% de winrate</div>
      </div>
    </div>` : ""}

    <!-- 2 columns -->
    <div class="streak-grid">
      <!-- Séries 1v1 -->
      <div class="streak-section">
        <div class="streak-section-header">🔥 Séries 1v1</div>
        <div class="streak-section-body">
          ${records.streaks1v1.map((p, i) => `
            <div class="streak-row" onclick="location.href='profile.html?pid=${esc(p.public_id)}&player=${esc(p.username)}'">
              <span class="streak-rank">${i + 1}</span>
              <span class="streak-name">${esc(p.username)}</span>
              <span class="streak-value ${p.streak > 0 ? "pos" : "neg"}">${p.streak > 0 ? "🔥" : "❄️"} ${p.streak > 0 ? "+" : ""}${p.streak || 0}</span>
            </div>
          `).join("")}
        </div>
      </div>

      <!-- Winrates 1v1 -->
      <div class="streak-section">
        <div class="streak-section-header">📊 Winrates 1v1 (10+ parties)</div>
        <div class="streak-section-body">
          ${records.winrates1v1.map((p, i) => `
            <div class="streak-row" onclick="location.href='profile.html?pid=${esc(p.public_id)}&player=${esc(p.username)}'">
              <span class="streak-rank">${i + 1}</span>
              <span class="streak-name">${esc(p.username)}</span>
              <span class="streak-value">${((p.wins / p.total) * 100).toFixed(1)}%</span>
            </div>
          `).join("")}
        </div>
      </div>

      <!-- Séries 2v2 -->
      <div class="streak-section">
        <div class="streak-section-header">🔥 Séries 2v2</div>
        <div class="streak-section-body">
          ${records.streaks2v2.map((p, i) => `
            <div class="streak-row" onclick="location.href='profile.html?pid=${esc(p.public_id)}&player=${esc(p.username)}'">
              <span class="streak-rank">${i + 1}</span>
              <span class="streak-name">${esc(p.username)}</span>
              <span class="streak-value ${p.streak > 0 ? "pos" : "neg"}">${p.streak > 0 ? "🔥" : "❄️"} ${p.streak > 0 ? "+" : ""}${p.streak || 0}</span>
            </div>
          `).join("")}
        </div>
      </div>

      <!-- Winrates 2v2 -->
      <div class="streak-section">
        <div class="streak-section-header">📊 Winrates 2v2 (5+ parties)</div>
        <div class="streak-section-body">
          ${records.winrates2v2.map((p, i) => `
            <div class="streak-row" onclick="location.href='profile.html?pid=${esc(p.public_id)}&player=${esc(p.username)}'">
              <span class="streak-rank">${i + 1}</span>
              <span class="streak-name">${esc(p.username)}</span>
              <span class="streak-value">${((p.wins / p.total) * 100).toFixed(1)}%</span>
            </div>
          `).join("")}
        </div>
      </div>

      <!-- Top points all-time -->
      ${records.topPoints.length ? `
      <div class="streak-section">
        <div class="streak-section-header">💎 Top points (all-time)</div>
        <div class="streak-section-body">
          ${records.topPoints.map((p, i) => `
            <div class="streak-row" onclick="location.href='profile.html?pid=${esc(p.publicId)}&player=${esc(p.username)}'">
              <span class="streak-rank">${i + 1}</span>
              <span class="streak-name">${esc(p.username)}</span>
              <span class="streak-value">${fmt(p.points)} pts</span>
            </div>
          `).join("")}
        </div>
      </div>` : ""}

      <!-- Top weekly -->
      ${records.topWeekly.length ? `
      <div class="streak-section">
        <div class="streak-section-header">⚡ Top points (cette semaine)</div>
        <div class="streak-section-body">
          ${records.topWeekly.map((p, i) => `
            <div class="streak-row" onclick="location.href='profile.html?pid=${esc(p.publicId)}&player=${esc(p.username)}'">
              <span class="streak-rank">${i + 1}</span>
              <span class="streak-name">${esc(p.username)}</span>
              <span class="streak-value">${fmt(p.weekly_points || 0)} pts</span>
            </div>
          `).join("")}
        </div>
      </div>` : ""}
    </div>
  `;
}

// Init
(async () => {
  try {
    const { ranked, scores } = await loadData();
    const records = computeRecords(ranked, scores);
    render(ranked, scores, records);
  } catch (e) {
    STREAK_VIEW.innerHTML = `<div class="streak-error"><h3>Erreur</h3><p>${esc(e.message)}</p></div>`;
  }
})();
