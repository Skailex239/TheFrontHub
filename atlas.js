// atlas.js — Atlas interactif des cartes OpenFront
// Reprend la méthode de openfront-atlas (react-simple-maps) en vanilla JS
// Carte SVG mondiale (TopoJSON via d3-geo) + pins interactifs + tooltip avec thumbnail
// Données: atlas-data/maps_data.json (Public Domain)

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
  continental: "#77e0ff",
  regional: "#34d399",
  fantasy: "#a855f7",
  arcade: "#facc15",
  tournament: "#ff7a00",
};

const GEO_URL = "https://cdn.jsdelivr.net/npm/world-atlas@2/countries-110m.json";

/* ═══ Utilitaires ═══ */

function escapeHtml(s) {
  if (s == null) return "";
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function getThumbUrl(slug) {
  return `atlas-data/thumbnails/${slug}.webp`;
}

/* ═══ Projection (d3-geo sans dépendance — manual naturalEarth1) ═══
   On utilise une projection equirectangulaire simple mais avec un
   fond de carte SVG réel (TopoJSON → path). On charge le TopoJSON
   et on génère les paths avec une fonction de projection. */

// Equirectangular projection: [lng, lat] → [x, y] in 0-1000 × 0-500
function projectEq(lng, lat, width, height) {
  const x = ((lng + 180) / 360) * width;
  const y = ((90 - lat) / 180) * height;
  return [x, y];
}

/* ═══ Chargement TopoJSON → GeoJSON → SVG paths ═══ */

async function loadWorldMap() {
  try {
    const res = await fetch(GEO_URL);
    if (!res.ok) throw new Error("Cannot load world map");
    const topo = await res.json();

    // Convert TopoJSON → GeoJSON (minimal converter)
    const objects = topo.objects;
    const firstKey = Object.keys(objects)[0];
    if (!firstKey) return null;

    const arcs = topo.arcs;
    const transform = topo.transform;
    const geom = objects[firstKey];

    // Decode arcs
    function decodeArc(arcIndex) {
      const arc = arcs[arcIndex < 0 ? ~arcIndex : arcIndex];
      let x = 0, y = 0;
      const coords = [];
      for (let i = 0; i < arc.length; i += 2) {
        x += arc[i];
        y += arc[i + 1];
      }
      // Redo (need cumulative)
      x = 0; y = 0;
      for (let i = 0; i < arc.length; i += 2) {
        x += arc[i] * transform.scale[0] + (i === 0 ? transform.translate[0] : 0);
        y += arc[i + 1] * transform.scale[1] + (i === 1 ? transform.translate[1] : 0);
      }
      // Actually let's just use the proper cumulative decode
      const pts = [];
      let dx = 0, dy = 0;
      for (let i = 0; i < arc.length; i += 2) {
        dx += arc[i];
        dy += arc[i + 1];
        pts.push([
          dx * transform.scale[0] + transform.translate[0],
          dy * transform.scale[1] + transform.translate[1]
        ]);
      }
      return arcIndex < 0 ? pts.reverse() : pts;
    }

    function decodeGeometry(g) {
      if (g.type === "Polygon") {
        return g.arcs.map(ring => Array.isArray(ring[0]) ? ring.flatMap(decodeArc) : ring.map(decodeArc));
      } else if (g.type === "MultiPolygon") {
        return g.arcs.map(poly => poly.map(ring => Array.isArray(ring[0]) ? ring.flatMap(decodeArc) : ring.map(decodeArc)));
      }
      return [];
    }

    const features = (geom.geometries || []).map(g => ({
      type: "Feature",
      geometry: { type: g.type, coordinates: decodeGeometry(g) },
    }));

    return features;
  } catch (e) {
    console.warn("[atlas] World map load failed:", e.message);
    return null;
  }
}

// Convert GeoJSON coordinates [lng, lat] → SVG path "M x y L x y..."
function geoToPath(feature, width, height) {
  const coords = feature.geometry.coordinates;
  const projectRing = (ring) => ring.map(([lng, lat]) => {
    const [x, y] = projectEq(lng, lat, width, height);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });

  if (feature.geometry.type === "Polygon") {
    return coords.map(ring => "M" + projectRing(ring).join(" L") + "Z").join(" ");
  } else if (feature.geometry.type === "MultiPolygon") {
    return coords.map(poly => poly.map(ring => "M" + projectRing(ring).join(" L") + "Z").join(" ")).join(" ");
  }
  return "";
}

/* ═══ Chargement ═══ */

async function loadAtlas() {
  try {
    const [mapsRes, worldFeatures] = await Promise.all([
      fetch("atlas-data/maps_data.json", { cache: "force-cache" }),
      loadWorldMap()
    ]);
    if (!mapsRes.ok) throw new Error(`HTTP ${mapsRes.status}`);
    mapsData = await mapsRes.json();
    window._atlasWorldFeatures = worldFeatures;
    console.log(`[atlas] ${Object.keys(mapsData).length} cartes chargées, ${worldFeatures ? worldFeatures.length + ' pays' : 'pas de carte mondiale'}`);
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

  const totalMaps = maps.length;
  const earthMaps = maps.filter(m => m.category === "continental" || m.category === "regional").length;
  const fantasyMaps = maps.filter(m => m.category === "fantasy").length;
  const arcadeMaps = maps.filter(m => m.category === "arcade" || m.category === "tournament").length;

  const geoMaps = filtered.filter(m => m.geo_lat != null && m.geo_lng != null);
  const worldFeatures = window._atlasWorldFeatures;

  const MAP_W = 980;
  const MAP_H = 490;

  // Generate world map SVG paths
  let worldPaths = "";
  if (worldFeatures) {
    worldPaths = worldFeatures.map(f => geoToPath(f, MAP_W, MAP_H)).filter(p => p).join(" ");
  }

  ATLAS_VIEW.innerHTML = `
    <div class="atlas-intro">
      <p class="atlas-intro-sub">Explorez les ${totalMaps} cartes d'OpenFront — géographie réelle, mondes fantastiques et arcade. Survolez un point pour l'aperçu, cliquez pour les détails.</p>
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

    ${geoMaps.length > 0 && worldPaths ? `
    <div class="atlas-map-wrap">
      <svg class="atlas-map-svg" viewBox="0 0 ${MAP_W} ${MAP_H}" preserveAspectRatio="xMidYMid meet">
        <rect width="${MAP_W}" height="${MAP_H}" fill="var(--map-ocean, #0a1020)" />
        <path d="${worldPaths}" fill="var(--map-land, rgba(30,45,70,0.8))" stroke="var(--map-stroke, rgba(119,224,255,0.1))" stroke-width="0.5" />
        ${geoMaps.map(m => {
          const [x, y] = projectEq(m.geo_lng, m.geo_lat, MAP_W, MAP_H);
          const color = CAT_COLORS[m.category] || "#ff7a00";
          const isContinent = m.geo_type === "continent";
          const r = isContinent ? 7 : 4;
          return `
            <g class="atlas-svg-pin" data-slug="${m.slug}" data-name="${escapeHtml(m.translated_name || m.display_name)}" data-thumb="${getThumbUrl(m.slug)}" data-players="${m.estimated_max_players || '?'}" data-nations="${m.nation_count || 0}" data-land="${m.land_pct || '?'}" data-dim="${m.width || '?'}×${m.height || '?'}" style="cursor:pointer">
              <circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${r + 4}" fill="${color}" fill-opacity="0.12" />
              <circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${r}" fill="${color}" fill-opacity="0.9" stroke="${color}" stroke-width="1.5" stroke-opacity="0.4" />
              ${isContinent ? `<text x="${x.toFixed(1)}" y="${(y - 12).toFixed(1)}" text-anchor="middle" fill="${color}" font-size="9" font-weight="600" style="pointer-events:none">${escapeHtml(m.translated_name || m.display_name)}</text>` : ""}
            </g>
          `;
        }).join("")}
      </svg>
      <div class="atlas-map-legend">
        <span class="atlas-legend-item"><span class="atlas-legend-dot" style="background:#77e0ff"></span> Continental</span>
        <span class="atlas-legend-item"><span class="atlas-legend-dot" style="background:#34d399"></span> Régional</span>
        <span class="atlas-legend-item"><span class="atlas-legend-dot" style="background:#a855f7"></span> Fantasy</span>
        <span class="atlas-legend-item"><span class="atlas-legend-dot" style="background:#facc15"></span> Arcade</span>
        <span class="atlas-legend-item"><span class="atlas-legend-dot" style="background:#ff7a00"></span> Tournoi</span>
      </div>
    </div>` : geoMaps.length > 0 ? `
    <div class="atlas-map-fallback">
      <p>Carte mondiale indisponible — affichage des positions</p>
      <div class="atlas-map-pins-only">
        ${geoMaps.map(m => {
          const [x, y] = projectEq(m.geo_lng, m.geo_lat, 100, 50);
          const color = CAT_COLORS[m.category] || "#ff7a00";
          return `<div class="atlas-pin" style="left:${x}%;top:${y}%;background:${color};box-shadow:0 0 0 2px rgba(255,255,255,0.2),0 0 8px ${color}" data-slug="${m.slug}"></div>`;
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

  // Wire SVG pins (tooltip + click)
  const tooltip = document.getElementById("atlas-tooltip");
  ATLAS_VIEW.querySelectorAll(".atlas-svg-pin").forEach(pin => {
    pin.addEventListener("mouseenter", (e) => {
      showAtlasTooltip(pin, e);
    });
    pin.addEventListener("mousemove", (e) => {
      moveAtlasTooltip(e);
    });
    pin.addEventListener("mouseleave", () => {
      hideAtlasTooltip();
    });
    pin.addEventListener("click", () => {
      const slug = pin.dataset.slug;
      const card = ATLAS_VIEW.querySelector(`.atlas-card[data-slug="${slug}"]`);
      if (card) {
        card.scrollIntoView({ behavior: "smooth", block: "center" });
        card.classList.add("flash");
        setTimeout(() => card.classList.remove("flash"), 1000);
      } else {
        showMapDetail(slug);
      }
    });
  });

  // Wire pins fallback
  ATLAS_VIEW.querySelectorAll(".atlas-pin").forEach(pin => {
    pin.addEventListener("click", () => {
      const slug = pin.dataset.slug;
      showMapDetail(slug);
    });
  });

  // Wire cards
  ATLAS_VIEW.querySelectorAll(".atlas-card").forEach(card => {
    card.addEventListener("click", (e) => {
      if (e.target.closest("a")) return;
      const slug = card.dataset.slug;
      showMapDetail(slug);
    });
  });
}

/* ═══ Tooltip ═══ */

let atlasTooltipEl = null;

function ensureTooltip() {
  if (!atlasTooltipEl) {
    atlasTooltipEl = document.createElement("div");
    atlasTooltipEl.id = "atlas-tooltip";
    atlasTooltipEl.className = "atlas-tooltip";
    atlasTooltipEl.style.display = "none";
    document.body.appendChild(atlasTooltipEl);
  }
  return atlasTooltipEl;
}

function showAtlasTooltip(pin, e) {
  const t = ensureTooltip();
  const name = pin.dataset.name;
  const thumb = pin.dataset.thumb;
  const players = pin.dataset.players;
  const nations = pin.dataset.nations;
  const land = pin.dataset.land;
  const dim = pin.dataset.dim;

  t.innerHTML = `
    <img src="${escapeHtml(thumb)}" alt="${escapeHtml(name)}" onerror="this.style.display='none'">
    <div class="atlas-tooltip-name">${escapeHtml(name)}</div>
    <div class="atlas-tooltip-stats">
      <span>${dim}</span>
      <span>${nations} nations</span>
      <span>${land}% terre</span>
      <span>~${players} joueurs</span>
    </div>
  `;
  t.style.display = "block";
  moveAtlasTooltip(e);
}

function moveAtlasTooltip(e) {
  const t = ensureTooltip();
  let x = e.clientX + 14;
  let y = e.clientY - 10;
  if (x > window.innerWidth - 260) x = e.clientX - 240;
  t.style.left = x + "px";
  t.style.top = y + "px";
}

function hideAtlasTooltip() {
  const t = ensureTooltip();
  t.style.display = "none";
}

/* ═══ Card ═══ */

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
          <span>${m.estimated_max_players || "?"} joueurs</span>
          <span>${m.nation_count || 0} nations</span>
          <span>${m.playlist_frequency || 0}× playlist</span>
        </div>
        <div class="atlas-card-land">${m.land_pct ? `${m.land_pct}% terre · ${m.water_pct}% eau` : ""}</div>
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
  const nations = (m.nations || []).slice(0, 24);

  const existing = document.getElementById("atlas-modal");
  if (existing) existing.remove();

  const modal = document.createElement("div");
  modal.id = "atlas-modal";
  modal.className = "atlas-modal-overlay";
  modal.onclick = (e) => { if (e.target === modal) { modal.remove(); document.body.style.overflow = ""; } };
  modal.innerHTML = `
    <div class="atlas-modal">
      <button class="atlas-modal-close" onclick="this.closest('.atlas-modal-overlay').remove();document.body.style.overflow=''">&times;</button>
      <div class="atlas-modal-thumb"><img src="${escapeHtml(thumb)}" alt="${escapeHtml(name)}" onerror="this.style.opacity=0"></div>
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
          <div class="atlas-nations-grid">${nations.map(n => `<span class="atlas-nation">${escapeHtml(n.name)}</span>`).join("")}</div>
          ${m.nation_count > 24 ? `<p class="atlas-nations-more">+${m.nation_count - 24} autres</p>` : ""}
        </div>` : ""}
        <a class="atlas-modal-play" href="https://openfront.io/" target="_blank" rel="noopener">Jouer sur OpenFront →</a>
      </div>
    </div>
  `;
  document.body.appendChild(modal);
  document.body.style.overflow = "hidden";

  const escHandler = (e) => { if (e.key === "Escape") { modal.remove(); document.body.style.overflow = ""; document.removeEventListener("keydown", escHandler); } };
  document.addEventListener("keydown", escHandler);
}

/* ═══ Init ═══ */
loadAtlas();
