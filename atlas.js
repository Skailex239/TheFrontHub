// atlas.js — Atlas interactif des cartes OpenFront
// Données: atlas-data/maps_data.json (105 cartes)
// Carte mondiale avec pins cliquables + grille de cartes filtrable
// Données sous licence Public Domain (openfront-atlas)

const ATLAS_VIEW = document.getElementById("atlas-view");
let mapsData = null;
let activeFilter = "all";

const CATEGORIES = [
  { key: "all", label: "Toutes" },
  { key: "continental", label: "Continentales" },
  { key: "regional", label: "Régionales" },
  { key: "fantasy", label: "Autres mondes" },
  { key: "arcade", label: "Arcade" },
  { key: "tournament", label: "Tournoi" },
];

const CAT_COLORS = {
  continental: "#06b6d4",
  regional: "#34d399",
  fantasy: "#a855f7",
  arcade: "#facc15",
  tournament: "#ff7a00",
};

/* ═══ Utilitaires ═══ */

function escapeHtml(s) {
  if (s == null) return "";
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function getThumbUrl(slug) {
  return `atlas-data/thumbnails/${slug}.webp`;
}

// Equirectangular projection: lat/lng → x/y %
function project(lat, lng) {
  const x = ((lng + 180) / 360) * 100;
  const y = ((90 - lat) / 180) * 100;
  return { x, y };
}

/* ═══ Chargement ═══ */

async function loadAtlas() {
  try {
    const res = await fetch("atlas-data/maps_data.json", { cache: "force-cache" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    mapsData = await res.json();
    console.log(`[atlas] ${Object.keys(mapsData).length} cartes chargées`);
    render();
  } catch (e) {
    ATLAS_VIEW.innerHTML = `<div class="atlas-error"><h3>Erreur</h3><p>${escapeHtml(e.message)}</p></div>`;
  }
}

/* ═══ Rendu ═══ */

function render() {
  if (!mapsData) return;
  const maps = Object.entries(mapsData).map(([slug, data]) => ({ slug, ...data }));
  const filtered = activeFilter === "all" ? maps : maps.filter(m => m.category === activeFilter);

  // Stats globales
  const totalMaps = maps.length;
  const earthMaps = maps.filter(m => m.category === "continental" || m.category === "regional").length;
  const fantasyMaps = maps.filter(m => m.category === "fantasy").length;
  const arcadeMaps = maps.filter(m => m.category === "arcade" || m.category === "tournament").length;

  // Maps avec coordonnées géo (pour la carte)
  const geoMaps = filtered.filter(m => m.geo_lat != null && m.geo_lng != null);

  ATLAS_VIEW.innerHTML = `
    <div class="atlas-intro">
      <p class="atlas-intro-sub">Explorez les ${totalMaps} cartes d'OpenFront — géographie réelle, mondes fantastiques et arcade. Cliquez sur un pin ou une carte pour les détails.</p>
    </div>

    <div class="atlas-stats">
      <div class="atlas-stat"><span class="atlas-stat-val">${totalMaps}</span><span class="atlas-stat-label">Cartes totales</span></div>
      <div class="atlas-stat"><span class="atlas-stat-val">${earthMaps}</span><span class="atlas-stat-label">Terre</span></div>
      <div class="atlas-stat"><span class="atlas-stat-val">${fantasyMaps}</span><span class="atlas-stat-label">Autres mondes</span></div>
      <div class="atlas-stat"><span class="atlas-stat-val">${arcadeMaps}</span><span class="atlas-stat-label">Arcade/Tournoi</span></div>
    </div>

    <div class="atlas-filters">
      ${CATEGORIES.map(c => `<button class="atlas-filter-btn ${c.key === activeFilter ? "active" : ""}" data-cat="${c.key}">${c.label}</button>`).join("")}
    </div>

    ${geoMaps.length > 0 ? `
    <div class="atlas-map-wrap">
      <div class="atlas-map" id="atlas-worldmap">
        <div class="atlas-map-bg"></div>
        ${geoMaps.map(m => {
          const { x, y } = project(m.geo_lat, m.geo_lng);
          const color = CAT_COLORS[m.category] || "#ff7a00";
          return `<div class="atlas-pin" style="left:${x}%;top:${y}%;--pin-color:${color}" data-slug="${m.slug}" title="${escapeHtml(m.translated_name || m.display_name)}"></div>`;
        }).join("")}
      </div>
    </div>` : ""}

    <div class="atlas-grid" id="atlas-grid">
      ${filtered.map(m => renderMapCard(m)).join("")}
    </div>
  `;

  // Wire filters
  ATLAS_VIEW.querySelectorAll(".atlas-filter-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      activeFilter = btn.dataset.cat;
      render();
    });
  });

  // Wire pins
  ATLAS_VIEW.querySelectorAll(".atlas-pin").forEach(pin => {
    pin.addEventListener("click", () => {
      const slug = pin.dataset.slug;
      const card = ATLAS_VIEW.querySelector(`.atlas-card[data-slug="${slug}"]`);
      if (card) {
        card.scrollIntoView({ behavior: "smooth", block: "center" });
        card.classList.add("flash");
        setTimeout(() => card.classList.remove("flash"), 1000);
      }
    });
  });

  // Wire card clicks → detail modal
  ATLAS_VIEW.querySelectorAll(".atlas-card").forEach(card => {
    card.addEventListener("click", (e) => {
      if (e.target.closest("a")) return;
      const slug = card.dataset.slug;
      showMapDetail(slug);
    });
  });
}

function renderMapCard(m) {
  const name = m.translated_name || m.display_name || m.slug;
  const thumb = getThumbUrl(m.slug);
  const color = CAT_COLORS[m.category] || "#ff7a00";
  const catLabel = CATEGORIES.find(c => c.key === m.category)?.label || m.category;

  return `
    <div class="atlas-card" data-slug="${m.slug}">
      <div class="atlas-card-thumb">
        <img src="${escapeHtml(thumb)}" alt="${escapeHtml(name)}" loading="lazy" onerror="this.style.opacity=0">
        <span class="atlas-card-cat" style="--cat-color:${color}">${escapeHtml(catLabel)}</span>
      </div>
      <div class="atlas-card-body">
        <div class="atlas-card-name">${escapeHtml(name)}</div>
        <div class="atlas-card-meta">
          <span title="Joueurs max">${m.estimated_max_players || "?"} joueurs</span>
          <span title="Nations">${m.nation_count || 0} nations</span>
          <span title="Fréquence playlist">${m.playlist_frequency || 0}× playlist</span>
        </div>
        <div class="atlas-card-land">
          ${m.land_pct ? `${m.land_pct}% terre · ${m.water_pct}% eau` : ""}
        </div>
      </div>
    </div>
  `;
}

/* ═══ Modal détail ═══ */

function showMapDetail(slug) {
  const m = { slug, ...mapsData[slug] };
  if (!m.display_name) return;

  const name = m.translated_name || m.display_name;
  const thumb = getThumbUrl(slug);
  const color = CAT_COLORS[m.category] || "#ff7a00";
  const catLabel = CATEGORIES.find(c => c.key === m.category)?.label || m.category;
  const nations = (m.nations || []).slice(0, 20);

  // Remove existing modal
  const existing = document.getElementById("atlas-modal");
  if (existing) existing.remove();

  const modal = document.createElement("div");
  modal.id = "atlas-modal";
  modal.className = "atlas-modal-overlay";
  modal.onclick = (e) => { if (e.target === modal) modal.remove(); };
  modal.innerHTML = `
    <div class="atlas-modal">
      <button class="atlas-modal-close" onclick="this.closest('.atlas-modal-overlay').remove()">&times;</button>
      <div class="atlas-modal-thumb">
        <img src="${escapeHtml(thumb)}" alt="${escapeHtml(name)}" onerror="this.style.opacity=0">
      </div>
      <div class="atlas-modal-body">
        <span class="atlas-modal-cat" style="--cat-color:${color}">${escapeHtml(catLabel)}</span>
        <h2 class="atlas-modal-name">${escapeHtml(name)}</h2>
        <div class="atlas-modal-stats">
          <div class="atlas-modal-stat"><span>${m.estimated_max_players || "?"}</span><label>Joueurs max</label></div>
          <div class="atlas-modal-stat"><span>${m.nation_count || 0}</span><label>Nations</label></div>
          <div class="atlas-modal-stat"><span>${m.land_pct || "?"}%</span><label>Terre</label></div>
          <div class="atlas-modal-stat"><span>${m.playlist_frequency || 0}</span><label>Playlist</label></div>
          <div class="atlas-modal-stat"><span>${m.width || "?"}×${m.height || "?"}</span><label>Dimensions</label></div>
        </div>
        ${nations.length ? `
        <div class="atlas-modal-nations">
          <h3>Nations (${m.nation_count || nations.length})</h3>
          <div class="atlas-nations-grid">
            ${nations.map(n => `<span class="atlas-nation">${escapeHtml(n.name)}</span>`).join("")}
          </div>
          ${m.nation_count > 20 ? `<p class="atlas-nations-more">+${m.nation_count - 20} autres</p>` : ""}
        </div>` : ""}
        <a class="atlas-modal-play" href="https://openfront.io/" target="_blank" rel="noopener">Jouer sur OpenFront →</a>
      </div>
    </div>
  `;
  document.body.appendChild(modal);
  document.body.style.overflow = "hidden";

  // Escape to close
  const escHandler = (e) => { if (e.key === "Escape") { modal.remove(); document.body.style.overflow = ""; document.removeEventListener("keydown", escHandler); } };
  document.addEventListener("keydown", escHandler);
}

/* ═══ Init ═══ */
loadAtlas();
