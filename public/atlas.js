// atlas.js — Atlas interactif des cartes OpenFront
// Reprend la structure de openfront-atlas en vanilla JS
// Carte SVG mondiale (chaque pays = 1 path séparé) + pins + page détail
//
// FEATURES (v2):
//   • Deep-link URL : ?map=slug ouvre le modal, ?cat=key pré-filtre, ?nation=name cherche une nation
//   • Zoom/pan sur la world map (mouse wheel + drag)
//   • Atlas Insights : top 10 cartes par taille + distribution joueurs + pie chart catégories + densité nations
//   • Mode comparison : sélectionner 2-3 cartes → vue side-by-side

const ATLAS_VIEW = document.getElementById("atlas-view");
let mapsData = null;
let activeFilter = "all";
let activeSearch = "";
let activeSort = "default"; // default | alpha | size | players | nations | playlist | land
let compareSelection = []; // slugs sélectionnés pour comparison (max 3)
let mapTransform = { x: 0, y: 0, k: 1 }; // pan/zoom transform

// ── Deep-link URL parsing ──
function parseUrlParams() {
  const params = new URLSearchParams(window.location.search);
  return {
    map: params.get("map") || params.get("m") || null,
    cat: params.get("cat") || params.get("c") || null,
    nation: params.get("nation") || params.get("n") || null,
  };
}

function updateUrl(params) {
  const url = new URL(window.location);
  // On garde seulement les params non-null
  ["map", "cat", "nation"].forEach(k => {
    if (params[k] != null) url.searchParams.set(k, params[k]);
    else url.searchParams.delete(k);
  });
  window.history.replaceState({}, "", url);
}

const CATEGORIES = [
  { key: "all", label: "Toutes" },
  { key: "continental", label: "Continentales" },
  { key: "regional", label: "Régionales" },
  { key: "fantasy", label: "Autres mondes" },
  { key: "arcade", label: "Arcade" },
  { key: "tournament", label: "Tournoi" },
];

const CAT_COLORS = {
  continental: "#06b6d4", regional: "#34d399", fantasy: "#a855f7",
  arcade: "#facc15", tournament: "#ff7a00",
};

const GEO_URL = "https://cdn.jsdelivr.net/npm/world-atlas@2/countries-110m.json";

function escapeHtml(s) {
  if (s == null) return "";
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
function getThumbUrl(slug) { return `atlas-data/thumbnails/${slug}.webp`; }
function getMapUrl(slug) { return `atlas-data/maps/${slug}.webp`; }
function getFlagUrl(flag) { return `atlas-data/flags/${flag}.svg`; }

function projectEq(lng, lat, w, h) {
  return [((lng + 180) / 360) * w, ((90 - lat) / 180) * h];
}

// Use d3-geo for proper projection (handles antimeridian, etc.)
function createProjection(width, height) {
  if (window.d3 && window.d3.geoEquirectangular) {
    return window.d3.geoEquirectangular()
      .scale(width / 6.283)
      .translate([width / 2, height / 2])
      .clipExtent([[0, 0], [width, height]]);
  }
  return null;
}

function geoToPath(feature, width, height) {
  // Use d3.geoPath if available (proper projection)
  if (window.d3 && window.d3.geoPath) {
    const projection = createProjection(width, height);
    if (projection) {
      const pathGen = window.d3.geoPath(projection);
      // Use the full geometry (all rings) not just the outer ring
      const d = pathGen(feature);
      return d || "";
    }
  }
  // Fallback: manual equirectangular — process ALL rings (outer + holes)
  const coords = feature.geometry.coordinates;
  const projectRing = (ring) => ring.map(([lng, lat]) => {
    const [x, y] = projectEq(lng, lat, width, height);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  if (feature.geometry.type === "Polygon")
    return coords.map(ring => "M" + projectRing(ring).join(" L") + "Z").join(" ");
  if (feature.geometry.type === "MultiPolygon")
    return coords.map(poly => poly.map(ring => "M" + projectRing(ring).join(" L") + "Z").join(" ")).join(" ");
  return "";
}

async function loadWorldMap() {
  try {
    const res = await fetch(GEO_URL);
    if (!res.ok) return null;
    const topo = await res.json();
    if (window.topojson && window.topojson.feature) {
      const fc = window.topojson.feature(topo, topo.objects.countries || Object.values(topo.objects)[0]);
      return fc.features || [fc];
    }
    return null;
  } catch { return null; }
}

async function loadAtlas() {
  try {
    const [mapsRes, worldFeatures] = await Promise.all([
      fetch("atlas-data/maps_data.json", { cache: "force-cache" }), loadWorldMap()
    ]);
    if (!mapsRes.ok) throw new Error(`HTTP ${mapsRes.status}`);
    mapsData = await mapsRes.json();
    window._atlasWorldFeatures = worldFeatures;

    // ── Apply deep-link URL params ──
    const urlParams = parseUrlParams();
    if (urlParams.cat && CATEGORIES.some(c => c.key === urlParams.cat)) {
      activeFilter = urlParams.cat;
    }
    if (urlParams.nation) {
      activeSearch = urlParams.nation.toLowerCase();
    }

    render();

    // Ouvre le modal si ?map=slug est dans l'URL (après le render initial)
    if (urlParams.map && mapsData[urlParams.map]) {
      setTimeout(() => showMapDetail(urlParams.map), 100);
    }
  } catch (e) {
    ATLAS_VIEW.innerHTML = `<div class="atlas-error"><h3>Erreur</h3><p>${escapeHtml(e.message)}</p></div>`;
  }
}

// ── Atlas Insights dashboard ──
function renderInsights(maps) {
  // Top 10 cartes par taille (total_pixels)
  const topBySize = [...maps]
    .filter(m => m.total_pixels)
    .sort((a, b) => (b.total_pixels || 0) - (a.total_pixels || 0))
    .slice(0, 10);
  const maxSize = topBySize[0]?.total_pixels || 1;

  // Distribution par nb joueurs (buckets)
  const buckets = [
    { range: "≤10", count: 0, color: "#06b6d4" },
    { range: "11-25", count: 0, color: "#34d399" },
    { range: "26-50", count: 0, color: "#facc15" },
    { range: "51-100", count: 0, color: "#f97316" },
    { range: ">100", count: 0, color: "#a855f7" },
  ];
  maps.forEach(m => {
    const p = m.estimated_max_players || 0;
    if (p <= 10) buckets[0].count++;
    else if (p <= 25) buckets[1].count++;
    else if (p <= 50) buckets[2].count++;
    else if (p <= 100) buckets[3].count++;
    else buckets[4].count++;
  });
  const maxBucket = Math.max(...buckets.map(b => b.count), 1);

  // Pie chart par catégorie (calcul angles)
  const catCounts = CATEGORIES.filter(c => c.key !== "all").map(c => ({
    ...c, count: maps.filter(m => m.category === c.key).length,
  }));
  const totalCat = catCounts.reduce((s, c) => s + c.count, 0) || 1;

  // Donut SVG : rayon 60, centre (80,80)
  const R_OUTER = 60, R_INNER = 32, CENTER = 80;
  let cumAngle = -Math.PI / 2; // start at top
  const arcPaths = catCounts.map(c => {
    if (c.count === 0) return null;
    const angle = (c.count / totalCat) * 2 * Math.PI;
    const startAngle = cumAngle;
    const endAngle = cumAngle + angle;
    cumAngle = endAngle;
    const x1 = CENTER + R_OUTER * Math.cos(startAngle);
    const y1 = CENTER + R_OUTER * Math.sin(startAngle);
    const x2 = CENTER + R_OUTER * Math.cos(endAngle);
    const y2 = CENTER + R_OUTER * Math.sin(endAngle);
    const xi1 = CENTER + R_INNER * Math.cos(endAngle);
    const yi1 = CENTER + R_INNER * Math.sin(endAngle);
    const xi2 = CENTER + R_INNER * Math.cos(startAngle);
    const yi2 = CENTER + R_INNER * Math.sin(startAngle);
    const large = angle > Math.PI ? 1 : 0;
    return `<path d="M${x1},${y1} A${R_OUTER},${R_OUTER} 0 ${large} 1 ${x2},${y2} L${xi1},${yi1} A${R_INNER},${R_INNER} 0 ${large} 0 ${xi2},${yi2} Z" fill="${CAT_COLORS[c.key]}" stroke="#fff" stroke-width="1.5"><title>${c.label}: ${c.count} (${Math.round(c.count/totalCat*100)}%)</title></path>`;
  }).filter(Boolean).join("");

  // Densité nations/km² (proxy via nation_count / land_tiles)
  const densityData = [...maps]
    .filter(m => m.nation_count > 0 && m.land_tiles > 0)
    .map(m => ({
      slug: m.slug,
      name: m.translated_name || m.display_name,
      density: (m.nation_count / (m.land_tiles / 1000)).toFixed(2),
      nation_count: m.nation_count,
    }))
    .sort((a, b) => parseFloat(b.density) - parseFloat(a.density))
    .slice(0, 5);
  const maxDensity = parseFloat(densityData[0]?.density || "1");

  return `
    <details class="atlas-insights" open>
      <summary class="atlas-insights-summary">
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3v18h18"/><path d="M7 14l4-4 4 4 6-6"/></svg>
        Atlas Insights — Statistiques sur ${maps.length} cartes
      </summary>
      <div class="atlas-insights-grid">
        <div class="atlas-insight-card">
          <h4>Top 10 — Taille (px²)</h4>
          <div class="atlas-bar-list">
            ${topBySize.map((m, i) => `
              <div class="atlas-bar-row" data-slug="${m.slug}">
                <span class="atlas-bar-rank">#${i+1}</span>
                <span class="atlas-bar-label" title="${escapeHtml(m.translated_name || m.display_name)}">${escapeHtml((m.translated_name || m.display_name).slice(0, 18))}</span>
                <div class="atlas-bar-track"><div class="atlas-bar-fill" style="width:${((m.total_pixels/maxSize)*100).toFixed(1)}%;background:linear-gradient(90deg, var(--orange), #f97316)"></div></div>
                <span class="atlas-bar-value">${(m.total_pixels/1000000).toFixed(1)}M</span>
              </div>`).join("")}
          </div>
        </div>
        <div class="atlas-insight-card">
          <h4>Distribution — Joueurs max</h4>
          <div class="atlas-bar-list atlas-bar-vertical">
            ${buckets.map(b => `
              <div class="atlas-bar-col">
                <div class="atlas-bar-col-track">
                  <div class="atlas-bar-col-fill" style="height:${(b.count/maxBucket*100).toFixed(1)}%;background:${b.color}"></div>
                </div>
                <span class="atlas-bar-col-label">${b.range}</span>
                <span class="atlas-bar-col-count">${b.count}</span>
              </div>`).join("")}
          </div>
        </div>
        <div class="atlas-insight-card">
          <h4>Répartition par catégorie</h4>
          <div class="atlas-pie-wrap">
            <svg viewBox="0 0 160 160" class="atlas-pie-svg">
              ${arcPaths}
              <text x="${CENTER}" y="${CENTER-4}" text-anchor="middle" class="atlas-pie-center">${totalCat}</text>
              <text x="${CENTER}" y="${CENTER+12}" text-anchor="middle" class="atlas-pie-center-sub">cartes</text>
            </svg>
            <div class="atlas-pie-legend">
              ${catCounts.map(c => `
                <div class="atlas-pie-legend-item">
                  <span class="atlas-pie-dot" style="background:${CAT_COLORS[c.key]}"></span>
                  <span class="atlas-pie-label">${c.label}</span>
                  <span class="atlas-pie-value">${c.count}</span>
                </div>`).join("")}
            </div>
          </div>
        </div>
        <div class="atlas-insight-card">
          <h4>Top 5 — Densité de nations</h4>
          <div class="atlas-bar-list">
            ${densityData.map((d, i) => `
              <div class="atlas-bar-row" data-slug="${d.slug}">
                <span class="atlas-bar-rank">#${i+1}</span>
                <span class="atlas-bar-label" title="${escapeHtml(d.name)}">${escapeHtml(d.name.slice(0, 18))}</span>
                <div class="atlas-bar-track"><div class="atlas-bar-fill" style="width:${(parseFloat(d.density)/maxDensity*100).toFixed(1)}%;background:linear-gradient(90deg, #a855f7, #c084fc)"></div></div>
                <span class="atlas-bar-value">${d.nation_count}n</span>
              </div>`).join("")}
          </div>
          <p class="atlas-insight-sub">Nations par 1000 tuiles de terre</p>
        </div>
      </div>
    </details>
  `;
}

// ── Comparison bar (sticky en bas) ──
function renderCompareBar() {
  if (compareSelection.length === 0) return "";
  const selectedMaps = compareSelection.map(slug => ({ slug, ...mapsData[slug] }));
  return `
    <div class="atlas-compare-bar">
      <div class="atlas-compare-bar-info">
        <span class="atlas-compare-bar-count">${compareSelection.length}/3</span>
        <span class="atlas-compare-bar-label">sélectionnées</span>
      </div>
      <div class="atlas-compare-bar-items">
        ${selectedMaps.map(m => `
          <div class="atlas-compare-item">
            <img src="${escapeHtml(getThumbUrl(m.slug))}" alt="" onerror="this.style.display='none'">
            <span class="atlas-compare-item-name">${escapeHtml((m.translated_name || m.display_name || m.slug).slice(0, 16))}</span>
            <button class="atlas-compare-remove" data-slug="${m.slug}" title="Retirer">×</button>
          </div>`).join("")}
      </div>
      <button class="atlas-compare-btn" ${compareSelection.length < 2 ? "disabled" : ""}>${compareSelection.length < 2 ? `Sélectionnez ${2-compareSelection.length} de plus` : "Comparer →"}</button>
      <button class="atlas-compare-clear" title="Tout vider">Vider</button>
    </div>
  `;
}

// ── Comparison modal ──
function showComparisonModal() {
  const maps = compareSelection.map(slug => ({ slug, ...mapsData[slug] }));
  if (maps.length < 2) return;

  const existing = document.getElementById("atlas-modal");
  if (existing) existing.remove();

  const modal = document.createElement("div");
  modal.id = "atlas-modal";
  modal.className = "atlas-modal-overlay";
  modal.onclick = (e) => { if (e.target === modal) { modal.remove(); document.body.style.overflow = ""; } };

  // Build comparison table rows
  const rows = [
    { label: "Catégorie", get: m => CATEGORIES.find(c => c.key === m.category)?.label || m.category, color: m => CAT_COLORS[m.category] || "#ff7a00" },
    { label: "Dimensions", get: m => `${m.width || "?"} × ${m.height || "?"}` },
    { label: "Pixels totaux", get: m => m.total_pixels ? `${(m.total_pixels/1000000).toFixed(1)}M` : "—" },
    { label: "Joueurs max", get: m => `~${m.estimated_max_players || "?"}`, highlight: true },
    { label: "Nations", get: m => `${m.nation_count || 0}`, highlight: true },
    { label: "% terre", get: m => m.land_pct ? `${m.land_pct.toFixed(1)}%` : "—" },
    { label: "% eau", get: m => m.water_pct ? `${m.water_pct.toFixed(1)}%` : "—" },
    { label: "Fréquence playlist", get: m => `${m.playlist_frequency || 0}×`, highlight: true },
    { label: "Géolocalisée", get: m => m.geo_lat != null ? `Oui (${m.geo_lat.toFixed(1)}, ${m.geo_lng.toFixed(1)})` : "Non" },
  ];

  modal.innerHTML = `
    <div class="atlas-detail atlas-comparison-modal">
      <button class="atlas-detail-close" onclick="this.closest('.atlas-modal-overlay').remove();document.body.style.overflow=''">&times;</button>
      <div class="atlas-detail-back" onclick="this.closest('.atlas-modal-overlay').remove();document.body.style.overflow=''">← Retour à l'Atlas</div>
      <h2 class="atlas-comparison-title">Comparaison de ${maps.length} cartes</h2>
      <div class="atlas-comparison-grid" style="grid-template-columns: 160px repeat(${maps.length}, 1fr)">
        <div class="atlas-comp-col-header atlas-comp-sticky">Critère</div>
        ${maps.map(m => `
          <div class="atlas-comp-col-header">
            <img src="${escapeHtml(getThumbUrl(m.slug))}" alt="" class="atlas-comp-thumb" onerror="this.style.display='none'">
            <div class="atlas-comp-name">${escapeHtml(m.translated_name || m.display_name)}</div>
            <button class="atlas-comp-open" data-slug="${m.slug}">Voir détails →</button>
          </div>`).join("")}
        ${rows.map(row => `
          <div class="atlas-comp-row-label atlas-comp-sticky">${row.label}</div>
          ${maps.map(m => {
            const val = row.get(m);
            const color = row.color ? row.color(m) : null;
            return `<div class="atlas-comp-cell ${row.highlight ? "atlas-comp-cell-highlight" : ""}" ${color ? `style="color:${color}"` : ""}>${escapeHtml(String(val))}</div>`;
          }).join("")}
        `).join("")}
      </div>
    </div>
  `;
  document.body.appendChild(modal);
  document.body.style.overflow = "hidden";

  modal.querySelectorAll(".atlas-comp-open").forEach(btn => {
    btn.addEventListener("click", () => {
      modal.remove();
      document.body.style.overflow = "";
      showMapDetail(btn.dataset.slug);
    });
  });

  const escHandler = (e) => { if (e.key === "Escape") { modal.remove(); document.body.style.overflow = ""; document.removeEventListener("keydown", escHandler); } };
  document.addEventListener("keydown", escHandler);
}

function render() {
  if (!mapsData) return;
  const maps = Object.entries(mapsData).map(([slug, data]) => ({ slug, ...data }));

  // ── Apply search + filter + sort ──
  let filtered = activeFilter === "all" ? [...maps] : maps.filter(m => m.category === activeFilter);

  if (activeSearch) {
    const q = activeSearch.toLowerCase();
    filtered = filtered.filter(m => {
      const name = (m.display_name || "").toLowerCase();
      const tname = (m.translated_name || "").toLowerCase();
      const slug = (m.slug || "").toLowerCase();
      const nations = (m.nations || []).map(n => (n.name || "").toLowerCase());
      return name.includes(q) || tname.includes(q) || slug.includes(q) || nations.some(n => n.includes(q));
    });
  }

  switch (activeSort) {
    case "alpha":
      filtered.sort((a, b) => (a.translated_name || a.display_name).localeCompare(b.translated_name || b.display_name));
      break;
    case "size":
      filtered.sort((a, b) => (b.total_pixels || 0) - (a.total_pixels || 0));
      break;
    case "players":
      filtered.sort((a, b) => (b.estimated_max_players || 0) - (a.estimated_max_players || 0));
      break;
    case "nations":
      filtered.sort((a, b) => (b.nation_count || 0) - (a.nation_count || 0));
      break;
    case "playlist":
      filtered.sort((a, b) => (b.playlist_frequency || 0) - (a.playlist_frequency || 0));
      break;
    case "land":
      filtered.sort((a, b) => (b.land_pct || 0) - (a.land_pct || 0));
      break;
  }

  const totalMaps = maps.length;
  const earthMaps = maps.filter(m => m.category === "continental" || m.category === "regional").length;
  const fantasyMaps = maps.filter(m => m.category === "fantasy").length;
  const arcadeMaps = maps.filter(m => m.category === "arcade" || m.category === "tournament").length;
  const geoMaps = filtered.filter(m => m.geo_lat != null && m.geo_lng != null);
  const worldFeatures = window._atlasWorldFeatures;
  const MAP_W = 980, MAP_H = 490;

  let countryPaths = "";
  if (worldFeatures) {
    countryPaths = worldFeatures.map(f => {
      if (f.id === "ATA" || (f.properties && f.properties.name === "Antarctica")) return "";
      const d = geoToPath(f, MAP_W, MAP_H);
      return d ? `<path d="${d}" />` : "";
    }).join("");
  }

  const sortOptions = [
    { key: "default", label: "Par défaut" },
    { key: "alpha", label: "A → Z" },
    { key: "size", label: "Taille" },
    { key: "players", label: "Joueurs max" },
    { key: "nations", label: "Nations" },
    { key: "playlist", label: "Playlist" },
    { key: "land", label: "% terre" },
  ];

  ATLAS_VIEW.innerHTML = `
    <div class="atlas-intro">
      <p class="atlas-intro-sub">Explorez les ${totalMaps} cartes d'OpenFront — géographie réelle, mondes fantastiques et arcade. Cliquez sur une carte pour les détails, nations et stratégies.</p>
    </div>

    ${renderInsights(maps)}

    <div class="atlas-stats">
      <div class="atlas-stat"><span class="atlas-stat-val">${totalMaps}</span><span class="atlas-stat-label">Cartes totales</span></div>
      <div class="atlas-stat"><span class="atlas-stat-val">${earthMaps}</span><span class="atlas-stat-label">Terre</span></div>
      <div class="atlas-stat"><span class="atlas-stat-val">${fantasyMaps}</span><span class="atlas-stat-label">Autres mondes</span></div>
      <div class="atlas-stat"><span class="atlas-stat-val">${arcadeMaps}</span><span class="atlas-stat-label">Arcade/Tournoi</span></div>
    </div>

    <div class="atlas-toolbar">
      <div class="atlas-filters">
        ${CATEGORIES.map(c => `<button class="atlas-filter-btn ${c.key === activeFilter ? "active" : ""}" data-cat="${c.key}">${c.label}</button>`).join("")}
      </div>
      <div class="atlas-toolbar-right">
        <div class="atlas-search-wrap">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
          <input type="text" class="atlas-search" placeholder="Rechercher carte ou nation…" value="${escapeHtml(activeSearch)}" />
          ${activeSearch ? `<button class="atlas-search-clear" title="Effacer">×</button>` : ""}
        </div>
        <select class="atlas-sort">
          ${sortOptions.map(o => `<option value="${o.key}" ${o.key === activeSort ? "selected" : ""}>${o.label}</option>`).join("")}
        </select>
      </div>
    </div>

    ${geoMaps.length > 0 && countryPaths ? `
    <div class="atlas-map-wrap" id="atlas-map-wrap">
      <svg class="atlas-map-svg" id="atlas-map-svg" viewBox="0 0 ${MAP_W} ${MAP_H}" preserveAspectRatio="xMidYMid meet">
        <rect width="${MAP_W}" height="${MAP_H}" fill="#a8d5e8" />
        <g class="atlas-zoom-group" id="atlas-zoom-group">
          <g class="atlas-countries">${countryPaths}</g>
          <g class="atlas-pins">
            ${geoMaps.map(m => {
              const _proj = createProjection(MAP_W, MAP_H);
              let x, y;
              if (_proj) { [x, y] = _proj([m.geo_lng, m.geo_lat]); }
              else { [x, y] = projectEq(m.geo_lng, m.geo_lat, MAP_W, MAP_H); }
              const color = CAT_COLORS[m.category] || "#ff7a00";
              const isContinent = m.geo_type === "continent";
              const r = isContinent ? 7 : 4;
              return `<g class="atlas-svg-pin" data-slug="${m.slug}" style="cursor:pointer">
                <circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${r + 5}" fill="${color}" fill-opacity="0.1" />
                <circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${r}" fill="${color}" fill-opacity="0.85" stroke="${color}" stroke-width="1" stroke-opacity="0.3" />
                ${isContinent ? `<text x="${x.toFixed(1)}" y="${(y - 12).toFixed(1)}" text-anchor="middle" fill="${color}" font-size="9" font-weight="600" style="pointer-events:none">${escapeHtml(m.translated_name || m.display_name)}</text>` : ""}
              </g>`;
            }).join("")}
          </g>
        </g>
      </svg>
      <div class="atlas-zoom-controls">
        <button class="atlas-zoom-btn" data-action="zoom-in" title="Zoomer +">+</button>
        <button class="atlas-zoom-btn" data-action="zoom-out" title="Zoomer −">−</button>
        <button class="atlas-zoom-btn" data-action="reset" title="Réinitialiser">⟲</button>
      </div>
      <div class="atlas-map-hint">Molette pour zoomer · Glisser pour déplacer</div>
      <div class="atlas-map-legend">
        <span class="atlas-legend-item"><span class="atlas-legend-dot" style="background:#06b6d4"></span> Continental</span>
        <span class="atlas-legend-item"><span class="atlas-legend-dot" style="background:#34d399"></span> Régional</span>
        <span class="atlas-legend-item"><span class="atlas-legend-dot" style="background:#a855f7"></span> Fantasy</span>
        <span class="atlas-legend-item"><span class="atlas-legend-dot" style="background:#facc15"></span> Arcade</span>
        <span class="atlas-legend-item"><span class="atlas-legend-dot" style="background:#ff7a00"></span> Tournoi</span>
      </div>
    </div>` : ""}

    <div class="atlas-grid">
      ${filtered.length > 0
        ? filtered.map(m => renderMapCard(m)).join("")
        : `<div class="atlas-empty">Aucune carte ne correspond à votre recherche.</div>`}
    </div>

    ${renderCompareBar()}
  `;

  // ── Wire events ──
  ATLAS_VIEW.querySelectorAll(".atlas-filter-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      activeFilter = btn.dataset.cat;
      updateUrl({ map: null, cat: activeFilter === "all" ? null : activeFilter, nation: activeSearch || null });
      render();
    });
  });

  const searchInput = ATLAS_VIEW.querySelector(".atlas-search");
  if (searchInput) {
    let searchTimer;
    searchInput.addEventListener("input", (e) => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => {
        activeSearch = e.target.value.trim().toLowerCase();
        updateUrl({ map: null, cat: activeFilter === "all" ? null : activeFilter, nation: activeSearch || null });
        render();
        // Refocus after re-render
        const newInput = ATLAS_VIEW.querySelector(".atlas-search");
        if (newInput) {
          newInput.focus();
          newInput.setSelectionRange(newInput.value.length, newInput.value.length);
        }
      }, 200);
    });
    const clearBtn = ATLAS_VIEW.querySelector(".atlas-search-clear");
    if (clearBtn) {
      clearBtn.addEventListener("click", () => {
        activeSearch = "";
        updateUrl({ map: null, cat: activeFilter === "all" ? null : activeFilter, nation: null });
        render();
      });
    }
  }

  const sortSelect = ATLAS_VIEW.querySelector(".atlas-sort");
  if (sortSelect) {
    sortSelect.addEventListener("change", (e) => {
      activeSort = e.target.value;
      render();
    });
  }

  // Pin hover → tooltip
  let tooltipEl = null;
  ATLAS_VIEW.querySelectorAll(".atlas-svg-pin").forEach(pin => {
    pin.addEventListener("mouseenter", (e) => {
      const slug = pin.dataset.slug;
      const m = { slug, ...mapsData[slug] };
      if (!tooltipEl) { tooltipEl = document.createElement("div"); tooltipEl.className = "atlas-tooltip"; document.body.appendChild(tooltipEl); }
      tooltipEl.innerHTML = `
        <img src="${escapeHtml(getThumbUrl(slug))}" alt="${escapeHtml(m.translated_name || m.display_name)}" onerror="this.style.display='none'">
        <div class="atlas-tooltip-name">${escapeHtml(m.translated_name || m.display_name)}</div>
        <div class="atlas-tooltip-stats">
          <span>${m.width || "?"}×${m.height || "?"}</span>
          <span>${m.nation_count || 0} nations</span>
          <span>${m.land_pct || "?"}% terre</span>
          <span>~${m.estimated_max_players || "?"} joueurs</span>
        </div>`;
      tooltipEl.style.display = "block";
      moveTooltip(e);
    });
    pin.addEventListener("mousemove", moveTooltip);
    pin.addEventListener("mouseleave", () => { if (tooltipEl) tooltipEl.style.display = "none"; });
    pin.addEventListener("click", () => showMapDetail(pin.dataset.slug));
  });

  function moveTooltip(e) {
    if (!tooltipEl) return;
    let x = e.clientX + 14, y = e.clientY - 10;
    if (x > window.innerWidth - 260) x = e.clientX - 240;
    tooltipEl.style.left = x + "px"; tooltipEl.style.top = y + "px";
  }

  ATLAS_VIEW.querySelectorAll(".atlas-card").forEach(card => {
    card.addEventListener("click", (e) => {
      // Si clic sur le bouton compare, ne pas ouvrir le détail
      if (e.target.closest(".atlas-card-compare")) return;
      showMapDetail(card.dataset.slug);
    });
  });

  // Comparison buttons on cards
  ATLAS_VIEW.querySelectorAll(".atlas-card-compare").forEach(btn => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const slug = btn.dataset.slug;
      toggleCompare(slug);
    });
  });

  // Insights bar rows clickable → open map detail
  ATLAS_VIEW.querySelectorAll(".atlas-bar-row[data-slug]").forEach(row => {
    row.addEventListener("click", () => showMapDetail(row.dataset.slug));
  });

  // Comparison bar buttons
  const compareBtn = ATLAS_VIEW.querySelector(".atlas-compare-btn");
  if (compareBtn) compareBtn.addEventListener("click", () => showComparisonModal());
  const compareClear = ATLAS_VIEW.querySelector(".atlas-compare-clear");
  if (compareClear) compareClear.addEventListener("click", () => { compareSelection = []; render(); });
  ATLAS_VIEW.querySelectorAll(".atlas-compare-remove").forEach(btn => {
    btn.addEventListener("click", () => toggleCompare(btn.dataset.slug));
  });

  // ── Zoom/pan setup ──
  setupZoomPan();
}

function toggleCompare(slug) {
  const idx = compareSelection.indexOf(slug);
  if (idx >= 0) {
    compareSelection.splice(idx, 1);
  } else {
    if (compareSelection.length >= 3) {
      // Replace the oldest if already 3
      compareSelection.shift();
    }
    compareSelection.push(slug);
  }
  render();
}

// ── Zoom/pan sur la world map ──
function setupZoomPan() {
  const svg = document.getElementById("atlas-map-svg");
  const wrap = document.getElementById("atlas-map-wrap");
  if (!svg || !wrap) return;
  const zoomGroup = document.getElementById("atlas-zoom-group");
  if (!zoomGroup) return;

  function applyTransform() {
    zoomGroup.setAttribute("transform", `translate(${mapTransform.x},${mapTransform.y}) scale(${mapTransform.k})`);
  }

  // Wheel zoom (centered on cursor)
  svg.addEventListener("wheel", (e) => {
    e.preventDefault();
    const rect = svg.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    // Convert to SVG coords using viewBox ratio
    const vbW = 980, vbH = 490;
    const svgX = (mx / rect.width) * vbW;
    const svgY = (my / rect.height) * vbH;
    const delta = e.deltaY > 0 ? 0.85 : 1.18;
    const newK = Math.max(1, Math.min(8, mapTransform.k * delta));
    // Zoom centered on cursor: world coord under cursor stays the same
    const ratio = newK / mapTransform.k;
    mapTransform.x = svgX - (svgX - mapTransform.x) * ratio;
    mapTransform.y = svgY - (svgY - mapTransform.y) * ratio;
    mapTransform.k = newK;
    applyTransform();
  }, { passive: false });

  // Drag pan
  let isDragging = false;
  let dragStart = { x: 0, y: 0, tx: 0, ty: 0 };
  svg.addEventListener("mousedown", (e) => {
    // Only drag on background (not on pins)
    if (e.target.closest(".atlas-svg-pin")) return;
    isDragging = true;
    dragStart = { x: e.clientX, y: e.clientY, tx: mapTransform.x, ty: mapTransform.y };
    svg.style.cursor = "grabbing";
  });
  window.addEventListener("mousemove", (e) => {
    if (!isDragging) return;
    const rect = svg.getBoundingClientRect();
    const vbW = 980;
    const dx = ((e.clientX - dragStart.x) / rect.width) * vbW;
    const dy = ((e.clientY - dragStart.y) / rect.height) * 490;
    mapTransform.x = dragStart.tx + dx;
    mapTransform.y = dragStart.ty + dy;
    applyTransform();
  });
  window.addEventListener("mouseup", () => {
    if (isDragging) { isDragging = false; svg.style.cursor = ""; }
  });

  // Touch support (single finger pan, pinch zoom — basic)
  let touchState = null;
  svg.addEventListener("touchstart", (e) => {
    if (e.target.closest(".atlas-svg-pin")) return;
    if (e.touches.length === 1) {
      touchState = { mode: "pan", x: e.touches[0].clientX, y: e.touches[0].clientY, tx: mapTransform.x, ty: mapTransform.y };
    } else if (e.touches.length === 2) {
      const dx = e.touches[0].clientX - e.touches[1].clientX;
      const dy = e.touches[0].clientY - e.touches[1].clientY;
      touchState = { mode: "pinch", dist: Math.hypot(dx, dy), k: mapTransform.k };
    }
  }, { passive: true });
  svg.addEventListener("touchmove", (e) => {
    if (!touchState) return;
    e.preventDefault();
    const rect = svg.getBoundingClientRect();
    const vbW = 980;
    if (touchState.mode === "pan" && e.touches.length === 1) {
      const dx = ((e.touches[0].clientX - touchState.x) / rect.width) * vbW;
      const dy = ((e.touches[0].clientY - touchState.y) / rect.height) * 490;
      mapTransform.x = touchState.tx + dx;
      mapTransform.y = touchState.ty + dy;
      applyTransform();
    } else if (touchState.mode === "pinch" && e.touches.length === 2) {
      const dx = e.touches[0].clientX - e.touches[1].clientX;
      const dy = e.touches[0].clientY - e.touches[1].clientY;
      const newDist = Math.hypot(dx, dy);
      const newK = Math.max(1, Math.min(8, touchState.k * (newDist / touchState.dist)));
      mapTransform.k = newK;
      applyTransform();
    }
  }, { passive: false });
  svg.addEventListener("touchend", () => { touchState = null; });

  // Zoom buttons
  document.querySelectorAll(".atlas-zoom-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      const action = btn.dataset.action;
      if (action === "zoom-in") {
        mapTransform.k = Math.min(8, mapTransform.k * 1.3);
      } else if (action === "zoom-out") {
        mapTransform.k = Math.max(1, mapTransform.k / 1.3);
        if (mapTransform.k === 1) { mapTransform.x = 0; mapTransform.y = 0; }
      } else if (action === "reset") {
        mapTransform = { x: 0, y: 0, k: 1 };
      }
      applyTransform();
    });
  });
}

function renderMapCard(m) {
  const name = m.translated_name || m.display_name || m.slug;
  const thumb = getThumbUrl(m.slug);
  const color = CAT_COLORS[m.category] || "#ff7a00";
  const catLabel = CATEGORIES.find(c => c.key === m.category)?.label || m.category;
  const isSelected = compareSelection.includes(m.slug);
  return `
    <div class="atlas-card ${isSelected ? "atlas-card-selected" : ""}" data-slug="${m.slug}">
      <div class="atlas-card-thumb">
        <img src="${escapeHtml(thumb)}" alt="${escapeHtml(name)}" loading="lazy" onerror="this.style.opacity=0">
        <span class="atlas-card-cat" style="--cat-color:${color}">${escapeHtml(catLabel)}</span>
        <button class="atlas-card-compare ${isSelected ? "active" : ""}" data-slug="${m.slug}" title="${isSelected ? "Retirer de la comparaison" : "Ajouter à la comparaison"}">
          <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
            ${isSelected ? "<polyline points=\"20 6 9 17 4 12\"/>" : "<line x1=\"12\" y1=\"5\" x2=\"12\" y2=\"19\"/><line x1=\"5\" y1=\"12\" x2=\"19\" y2=\"12\"/>"}
          </svg>
        </button>
      </div>
      <div class="atlas-card-body">
        <div class="atlas-card-name">${escapeHtml(name)}</div>
        <div class="atlas-card-meta">
          <span>${m.estimated_max_players || "?"} joueurs</span>
          <span>${m.nation_count || 0} nations</span>
          <span>${m.playlist_frequency || 0}× playlist</span>
        </div>
      </div>
    </div>`;
}

/* ═══ Page détail (reproduit openfront-atlas) ═══ */

function showMapDetail(slug) {
  const m = { slug, ...mapsData[slug] };
  if (!m.display_name) return;
  const name = m.translated_name || m.display_name;
  const mapImg = getMapUrl(slug);
  const color = CAT_COLORS[m.category] || "#ff7a00";
  const catLabel = CATEGORIES.find(c => c.key === m.category)?.label || m.category;
  const nations = m.nations || [];
  const aspectRatio = m.width && m.height ? `${m.width} / ${m.height}` : "3 / 2";

  // Deep-link : met à jour l'URL pour permettre le partage
  updateUrl({ map: slug, cat: activeFilter === "all" ? null : activeFilter, nation: activeSearch || null });

  const existing = document.getElementById("atlas-modal");
  if (existing) existing.remove();

  const modal = document.createElement("div");
  modal.id = "atlas-modal";
  modal.className = "atlas-modal-overlay";
  modal.onclick = (e) => { if (e.target === modal) closeModal(); };

  modal.innerHTML = `
    <div class="atlas-detail">
      <button class="atlas-detail-close" onclick="this.closest('.atlas-modal-overlay').remove();document.body.style.overflow=''">&times;</button>
      <div class="atlas-detail-back" onclick="this.closest('.atlas-modal-overlay').remove();document.body.style.overflow=''">← Retour à l'Atlas</div>
      <div class="atlas-detail-grid">
        <div class="atlas-detail-map-wrap">
          <div class="atlas-detail-map-stage" style="aspect-ratio:${aspectRatio}">
            <img src="${escapeHtml(mapImg)}" alt="${escapeHtml(name)}" class="atlas-detail-map-img" onerror="this.src='${escapeHtml(getThumbUrl(slug))}'">
            ${nations.length > 0 ? `
            <div class="atlas-nation-overlay">
              ${nations.map(n => `
                <div class="atlas-nation-marker" style="left:${(n.x / m.width * 100).toFixed(1)}%;top:${(n.y / m.height * 100).toFixed(1)}%" title="${escapeHtml(n.name)}">
                  ${n.flag ? `<img src="${escapeHtml(getFlagUrl(n.flag))}" alt="" class="atlas-nation-flag" loading="lazy" onerror="this.style.display='none';this.nextElementSibling.style.display=''">` : ""}
                  <span class="atlas-nation-dot" ${n.flag ? 'style="display:none"' : ''}></span>
                  <span class="atlas-nation-label">${escapeHtml(n.name)}</span>
                </div>`).join("")}
            </div>` : ""}
          </div>
        </div>
        <div class="atlas-detail-info">
          <div class="atlas-detail-badges">
            <span class="atlas-detail-cat" style="--cat-color:${color}">${escapeHtml(catLabel)}</span>
            <span class="atlas-detail-freq">${m.playlist_frequency || 0}× playlist</span>
          </div>
          <h2 class="atlas-detail-name">${escapeHtml(name)}</h2>
          <div class="atlas-detail-stats">
            <div class="atlas-detail-stat"><span>${m.width || "?"} × ${m.height || "?"}</span><label>Dimensions</label></div>
            <div class="atlas-detail-stat"><span>${m.nation_count || 0}</span><label>Nations</label></div>
            <div class="atlas-detail-stat"><span>~${m.estimated_max_players || "?"}</span><label>Joueurs max</label></div>
            <div class="atlas-detail-stat"><span>${m.playlist_frequency || 0}×</span><label>Playlist</label></div>
          </div>
          <div class="atlas-detail-landbar">
            <div class="atlas-landbar-labels">
              <span style="color:#34d399">Terre ${m.land_pct ? m.land_pct.toFixed(1) : "?"}%</span>
              <span style="color:#38bdf8">Eau ${m.water_pct ? m.water_pct.toFixed(1) : "?"}%</span>
            </div>
            <div class="atlas-landbar-track">
              <div class="atlas-landbar-fill" style="width:${m.land_pct || 0}%"></div>
            </div>
          </div>
          <a class="atlas-detail-play" href="https://openfront.io/" target="_blank" rel="noopener">Jouer sur OpenFront →</a>
        </div>
      </div>
      ${nations.length > 0 ? `
      <div class="atlas-detail-nations">
        <h3>Nations <span class="atlas-detail-count">${nations.length}</span></h3>
        <div class="atlas-nations-grid">
          ${nations.map(n => `
            <div class="atlas-nation-card">
              <span class="atlas-nation-flag-wrap">
                ${n.flag ? `<img src="${escapeHtml(getFlagUrl(n.flag))}" alt="" loading="lazy" onerror="this.style.display='none'">` : ""}
              </span>
              <span class="atlas-nation-card-name" title="${escapeHtml(n.name)}">${escapeHtml(n.name)}</span>
            </div>`).join("")}
        </div>
      </div>` : ""}
    </div>
  `;
  document.body.appendChild(modal);
  document.body.style.overflow = "hidden";
  const escHandler = (e) => { if (e.key === "Escape") { modal.remove(); document.body.style.overflow = ""; document.removeEventListener("keydown", escHandler); } };
  document.addEventListener("keydown", escHandler);
}

function closeModal() {
  const m = document.getElementById("atlas-modal");
  if (m) { m.remove(); document.body.style.overflow = ""; }
  // Nettoie ?map= de l'URL quand on ferme le modal
  updateUrl({ map: null, cat: activeFilter === "all" ? null : activeFilter, nation: activeSearch || null });
}

loadAtlas();
