---
Task ID: 2
Agent: Explore (frontend analysis)
Task: Analyse du frontend vanilla JS de TheFrontHub

Work Log:
- Vérifié l'absence d'un worklog précédent dans /home/z/my-project/ (aucun agent avant moi).
- Lister le contenu du repo /tmp/thefronthub pour identifier les fichiers frontend cibles.
- Lu intégralement les 3 pages HTML: index.html (~511 lignes), profile.html (~549 lignes), runs.html (~74 lignes).
- Lu intégralement les scripts JS navigateur: app.js (2431 lignes, module ES principal), auth.js (157 lignes, wrapper Firebase), profile.js (621 lignes), runs.js (203 lignes), i18n.js (475 lignes), icons.js (115 lignes), animations.js (313 lignes), toast.js (36 lignes), openfront-client.js (124 lignes), openfront-parse.js (36 lignes), sw.js (89 lignes), generate-code.js (85 lignes).
- Lu shared/firebase-config.js et shared/maps.js (60 premières lignes pour confirmer le rôle de normalisation).
- Lu les fichiers CSS: styles.css (1005 lignes — palette orange, layout sidebar+content, cosmétiques RGB), profile.css (1150 lignes), auth.css (251 lignes), toast.css (26 lignes), animations.css (482 lignes, premières 100 lignes pour comprendre le système).
- Vérifié l'existence d'un manifest PWA (aucun manifest.json / .webmanifest présent) et recherché `navigator.serviceWorker.register` (introuvable → sw.js n'est jamais enregistré).
- Vérifié l'absence de Chart.js (aucun canvas, aucun `new Chart(`, aucune balise `<canvas>`) → graphiques faits à la main en HTML/CSS.
- Vérifié les appels API en grepant server.js (3 endpoints: /api/top-runs, /api/openfront/*, /api/debug/upstream — utilisés uniquement en dev local).
- Inspecté rapidement le contenu de ranked.json et maps_list.json pour confirmer le format des données.
- Synthétisé l'architecture, les features, le design system, les dépendances et les problèmes dans le stage summary ci-dessous.

Stage Summary:

# Architecture frontend globale
- **Stack**: 100% vanilla JS (ES modules + scripts classiques globaux). Aucun framework (pas de React/Vue/Svelte), aucune lib UI (pas de Chart.js/Tailwind).
- **3 pages HTML distinctes** (pas de SPA):
  - `index.html` — leaderboard principal (Speedruns / Classé / Stats)
  - `profile.html` — profil joueur (auth + ownership verification + stats OpenFront)
  - `runs.html` — table top runs récents (filtre fenêtre de temps + limite)
- **Routing**: pas de hash-based routing. Navigation par `<a href>` directe + query params URL gérés via `URLSearchParams` + `history.replaceState`:
  - `?tab=maps|ranked|stats|profile` (tab actif)
  - `?map=MapName` (carte sélectionnée)
  - `?mapSize=normal|compact`
  - `?gameMode=solo|duos|trios|quads`
  - `?player=Username&publicId=XXXXXXXX` (profil d'un autre joueur)
- **Communication inter-pages**: via Firebase Firestore (collections `users`, `public-rewards`, `public-aliases`, `likes`) pour état partagé + `localStorage` (favoris `thefrontstats:favorites:v1`, langue `openfront_lang`) + `sessionStorage` (flag `tfs_just_logged_in` pour redirection post-login).
- **Chargement des modules**: `i18n.js`, `toast.js`, `animations.js` sont des scripts classiques globaux (exposent `window.t`, `window.showToast`, etc.). `app.js`, `profile.js`, `auth.js`, `icons.js`, `openfront-client.js`, `openfront-parse.js`, `shared/maps.js`, `shared/firebase-config.js` sont des ES modules (`type="module"`). Les handlers `onclick` HTML utilisent des fonctions exportées vers `window.*`.

# Features du leaderboard (index.html → app.js)
- **3 onglets** gérés par `switchTab(name, btn)`:
  1. **Speedruns** (FFA + Teams): Hall of Fame top 3, recherche joueur, liste cartes (recherche filtre), leaderboard par carte (top 25 + "Voir plus"), classement mondial Top 50 (points: 1er=3, 2e=2, 3e=1), feed 10 dernières victoires, comparateur 2 joueurs (rank, points, gold/silver/bronze, wins, maps, avg time, max streak). Sélecteur Map size (Normal/Compact) + dropdown Game mode (Solo/Duos/Trios/Quads). Stats cards: total runs, maps, players, best time.
  2. **Classé** (Ranked 1v1/2v2): stats cards (joueurs classés, Elo moyen, Peak Elo, parties), recherche **floue** (sous-séquence + normalisation NFD sans diacritics), toggle 1v1/2v2, filtres Top 10/25/50/All + Favoris (localStorage), sections Newcomers/Dropouts top 100, "My Position" si loggué, tableau Top 100 (rank, player, elo, peak, winrate coloré, V-D, total, movement, streak), distribution Elo (barres CSS), classement Clans (top 10 par elo moyen, ≥2 membres). Modal historique 10 derniers matchs ranked (fetch `/public/player/{id}` puis `/public/game/{id}` pour chaque match — détermine win/loss via `info.winner[2..]` qui contient les clientIDs gagnants).
  3. **Statistiques**: top 10 cartes populaires (barres CSS) + distribution des durées par bucket de 60s.
- **Système de points**: 1er=3pts, 2e=2e=2pts, 3e=1pt → classement mondial. 6 tiers de rang: Champion (100+), Diamond (50+), Gold (25+), Silver (10+), Bronze (3+), Unranked.
- **Filtres dynamiques**: recherche carte (`filterMaps`), recherche joueur (`searchPlayer`), comparateur (`searchCompare`, `addCompare`).
- **GG Button (likes)**: collection Firestore `likes` avec `increment()` + `deleteField()` atomiques, `onSnapshot` temps réel, optimistic UI.
- **Cosmetics VIP**: 11 skins RGB animés (prism, cyberpunk, sunset, aurore, pastel, gold, volcano, ocean, miami, toxic, chroma) — dégradés `background-clip:text` + keyframes `prism-slide`. Chargés via collection Firestore `public-rewards` (champ `activeType`).

# Système de profil joueur (profile.html → profile.js)
- **4 vues** gérées par `showView(view)`: `profile-loading`, `profile-gate` (non loggué), `profile-setup` (ownership verification), `profile-main` (stats affichées).
- **Ownership verification 2-step** (sécurité anti-vol d'identité):
  1. Étape 1: user saisit username + publicId (8 chars alphanumériques, regex `^[A-Za-z0-9]{8}$`). Vérifie via API OpenFront que le publicId existe (`/public/player/{id}`). Génère code challenge `TFS-XXXX` (4 chars, alphabet sans I/O/0/1) via `crypto.getRandomValues`.
  2. Étape 2: user ajoute le code dans son pseudo OpenFront, joue une partie, clique sur Confirmer. Le script vérifie que le code apparaît dans les `games[].username` récents du joueur. Si OK → save dans Firestore `users/{uid}` avec `verified:true, verifiedAt, openFrontSyncPending:true`.
- **Stats affichées** dans `profile-main`:
  - Week rank/score (approximatif — calculé en local sur 7 derniers jours)
  - All-time score (heuristique: `wins*4 + (total-wins)`)
  - ELO 1v1 (peak + rank) — lu depuis `ranked.json` local
  - ELO 2v2 (peak + rank) — idem
  - Breakdown par mode (FFA/Team/Duos/Trios/Quads) depuis le stats tree OpenFront
- **Dernières 5 parties**: fetch parallèle de chaque `/public/game/{gameId}` pour déterminer WIN/LOSS (check `info.winner[2..].includes(clientId)`). Badge `+4 pts` pour victoires.
- **Cross-profile**: `?player=Username&publicId=XXX` permet de voir le profil d'un autre joueur connecté (depuis le leaderboard, `showPlayer()` redirige si le joueur est dans `connectedUsernames`).
- **Avatar**: utilise `PDP.png` statique (pas d'avatar dynamique personnalisé).

# Système d'auth Firebase (auth.js)
- **Firebase v10.7.1** via CDN ESM (`https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js`, `firebase-auth.js`, `firebase-firestore.js`).
- **2 providers**: Google (`GoogleAuthProvider`) + Discord (`OAuthProvider("oidc.discord")`).
- **Flux de connexion**: `signInWithPopup` → fallback `signInWithRedirect` si popup bloqué/annulé (mobile/iframe). `getRedirectResult` géré au chargement de page.
- **Persistance**: `browserLocalPersistence` (cross-session).
- **Collections Firestore** utilisées:
  - `users/{uid}` — profil user (username, publicId, email, verified, verifiedAt, openFrontSessions, openFrontSyncPending)
  - `likes/{runId}` — GG button (count + users map)
  - `public-rewards/{publicId}` — cosmétiques VIP activés (activeType, username, activated)
  - `public-aliases/{publicId}` — fusion pseudos (aliases[], clientIds[]) pour leaderboard déterministe
  - `reward-codes/{id}` — codes récompense (générés par `generate-code.js`)
- **Real-time listeners** (`onSnapshot`): likes, public-rewards, public-aliases — re-render debounced (300ms) sur changements.
- **Race condition gérée**: flag `sessionStorage.tfs_just_logged_in` posé AVANT l'appel login pour que `onAuthStateChanged` (qui peut fire avant la résolution de `signInWithPopup`) sache rediriger vers `profile.html` si le profil existe déjà.
- **generate-code.js**: script admin Node.js (requiert env var `TFS_ADMIN_TOKEN ≥ 8 chars`). Génère codes `OR-XXXXXX` (6 chars, alphabet sans I/O/0/1) dans collection `reward-codes` avec type `vip`/`gold`. Liste les codes non utilisés en fin d'exécution.

# i18n
- **2 langues**: `fr` (défaut) + `en`. Persistance via `localStorage.openfront_lang`.
- **Mécanisme**: dictionnaire `translations` (~470 clés), fonction `t(key, params)` avec interpolation `{var}`.
- **Hydratation DOM**: `updateDOMTranslations()` parcourt `[data-i18n]` au `DOMContentLoaded` + re-render `window.renderAll()`.
- **Changement de langue**: `setLanguage(lang)` → `location.reload()` (pas de re-render en place — choix simple mais coûteux).
- **Noms de cartes traduits**: ~80 clés `map.XXX` (Afrique→Africa, etc.) + normalisation côté `shared/maps.js` (MAP_ALIASES, MAP_NORMALIZATION).
- **Faiblesse**: beaucoup de strings restent hardcoded FR dans app.js (ex: labels tableaux, boutons "Voir plus", "Actualiser", "Me trouver", etc.) — i18n partiellement implémenté. Les pages profile.html et runs.html sont quasi 100% FR.

# PWA / Offline
- **sw.js existe mais n'est JAMAIS enregistré** (aucun `navigator.serviceWorker.register` dans tout le repo). Le service worker est donc totalement inactif en production.
- **Pas de manifest.json / .webmanifest** → site non installable comme PWA.
- **Stratégie SW (théorique)**: network-first pour tout (fallback cache offline), skip Firebase/gstatic/corsproxy/openfront.io (laissés passer), cache nommé `thefrontstats-v5`, 30 assets statiques pré-cacheés à l'install.
- **Cache applicatif réel**: `IndexedDB` (`TheFrontStatsDB`, store `cache`) pour cache offline des payloads `runs_public.json.gz` / `runs_compact_public.json.gz` / `teams_public.json.gz` — clé `cache_data_{mode}`. Affichage instantané depuis le cache + re-fetch réseau en arrière-plan avec badge "LIVE" si nouvelle version.
- **Cache HTTP navigateur**: ETag/If-None-Match sur auto-refresh (toutes les 3 min via `setInterval(autoRefresh, 180000)`) + re-sync sur `visibilitychange` (throttled 30s).

# Libs UI utilisées
- **Aucune lib UI tierce** (pas de Chart.js, pas de React/Vue, pas de Tailwind, pas de Bootstrap).
- **Graphiques** faits à la main en HTML/CSS: barres horizontales via `<div class="dist-bar" style="width:Xpx">` + compteurs. Pas de `<canvas>` dans tout le repo.
- **Icons**: système maison `icons.js` — ~30 icônes SVG inline monochrome (`currentColor`), hydratation auto des `<i data-icon>` via `MutationObserver` (debounced rAF). Aucune lib d'icônes (pas de Lucide/Heroicons/Feather).
- **Toasts**: système maison `toast.js` (~35 lignes) avec 4 types (success/error/warning/info), auto-dismiss, icônes SVG via `window.icon`.
- **Animations**: système maison `animations.js` (~313 lignes) — particules canvas (18 max, repoussion souris, pause on tab hidden), scroll reveal (IntersectionObserver), count-up animé, ripple effect boutons, 3D tilt sur cards (throttled 32ms), shimmer loading, staggered entrance.
- **Firebase** v10.7.1 via CDN (auth + firestore) — seule dépendance JS externe.

# Appels API faits depuis le navigateur
1. **Fichiers JSON statiques** (servis par GitHub Pages, gzippés, décompressés via `DecompressionStream('gzip')` natif):
   - `runs_public.json.gz` — FFA solo, format compact `{k:[keys], r:[[values]], t:totalCount, u:lastUpdate, c:latestCommit, m:mapTotals}` (décompacté par `decodeCompactPayload`)
   - `runs_compact_public.json.gz` — mode Compact (3+ joueurs, 100 bots)
   - `teams_public.json.gz` — Duos/Trios/Quads (structure `{duos:{map:[...]}, trios:..., quads:...}`)
   - `ranked.json.gz` — ranked 1v1 + 2v2 + newcomers + dropouts + clans
   - Fallbacks: `runs.json.gz`, `runs_compact.json.gz`, `runs.json` (si 404 sur la version `_public`)
2. **OpenFront API** (`https://api.openfront.io`) — jamais en direct en prod:
   - En dev local (localhost/127.0.0.1): proxy via `server.js` → `/api/openfront/*`
   - En prod (GitHub Pages): proxy CORS `corsproxy.io` (`https://corsproxy.io/?url=<encoded>`) avec 2 fallbacks: `api.codetabs.com/v1/proxy/?quest=<encoded>` puis `api.allorigins.win/raw?url=<encoded>`
   - Timeout 6-8s via `AbortController`, 2 retries avec backoff 300×attempt ms
   - Endpoints utilisés: `/public/player/{publicId}` (ownership check + stats), `/public/game/{gameId}?turns=false` (détermination win/loss, modal historique)
   - Configurable via `<meta name="openfront-api-proxy">` ou `window.OPENFRONT_API_PROXY`
3. **Firebase Firestore** (real-time + writes): collections users/likes/public-rewards/public-aliases (voir section Auth).
4. **IndexedDB** local pour cache offline payloads.
5. **Pas d'appel vers `/api/*` du server.js en production** (server.js ne tourne pas sur GitHub Pages).

# Design system
- **Palette**: orange `--orange: #ff7a00` (+ 4 variantes: light `#ffb15d`, hover `#e86e00`, deep `#cc6200`, pale `#fff4e9`) avec 4 gradients orange. Couleurs sémantiques: green `#3dd68c`, red `#e54d4d`, gold `#ffc800`, silver `#b0b0b0`, bronze `#cd7f32`.
- **Pas de dark mode**: le thème orange/yellow gradient est fixe (code commenté indique que les fonctions `toggleTheme`/color picker ont été retirées). Pas de `prefers-color-scheme` actif dans les CSS (juste un `:root.light` orphelin dans animations.css).
- **Fonts** (Google Fonts, preload via `preconnect`):
  - `Inter` (300-800) — UI principale
  - `Orbitron` (900) — titres + skins RGB prism/cyberpunk
  - `JetBrains Mono` (400-500) — chiffres, Elo, durées, public IDs
  - Fonts cosmétiques référencées dans styles.css mais probablement pas preloadées: `Cinzel` (sunset/gold), `Montserrat` (aurore/chroma), `Rubik Glitch` (volcano), `Rubik Mono One` (ocean), `Permanent Marker` (miami), `Speedy` (toxic), `Creepster` (pastel) → **FOUT potentiel** sur les pseudos cosmétiques.
- **Layout**: sidebar fixe 260px à gauche + content `margin-left:260px`. Sidebar cachée en dessous de 900px (mobile). Topbar avec titre + version du jeu + last update.
- **Responsive**: breakpoints 1200px / 900px / 768px / 600px / 480px. Stats grid passe de 4→2→1 colonnes. Leaderboard grid passe en 1 colonne. Run row simplifiée (cache gap + replay) sous 600px.
- **Accessibilité**: skip-link "Aller au contenu principal", `role="tablist"/"tab"/"tabpanel"`, `aria-selected`, `aria-modal` sur modals, `aria-controls`/`aria-haspopup`/`aria-expanded` sur dropdown, `aria-label` sur boutons icône, `prefers-reduced-motion` respecté dans animations.js (désactive particules + 3D tilt).
- **Loading bar**: barre fixe en haut (3px) avec gradient shimmer animé, contrôlée par `setProgressBar()`/`showProgressBar()`/`hideProgressBar()`.
- **Code mort**: `createConfetti()` et `playSound()` sont des fonctions vides (placeholders pour futures features).

# Dépendances externes (récap)
- **Firebase v10.7.1** (auth + firestore) via CDN ESM — seule dépendance JS externe
- **Google Fonts**: Inter, Orbitron, JetBrains Mono (+ 7 fonts cosmétiques non preloadées)
- **corsproxy.io** + **api.codetabs.com** + **api.allorigins.win** — proxies CORS third-party pour OpenFront API en prod
- **Aucune dépendance npm côté navigateur** (`package.json` n'a pas de `dependencies`, juste des scripts Node pour sync)

# Problèmes détectés
1. **PWA cassée**: `sw.js` existe mais n'est jamais enregistré (pas de `navigator.serviceWorker.register`), pas de `manifest.json` → le site n'est pas installable et le SW ne fonctionne pas malgré son code complet. Le cache offline applicatif repose uniquement sur IndexedDB.
2. **i18n partiel**: beaucoup de strings hardcoded FR dans app.js (rendering de tableaux, boutons, labels) — `t(key)` n'est utilisé qu'à certains endroits. profile.html et runs.html sont quasi 100% FR. Le reload sur changement de langue est coûteux.
3. **runs.html a une erreur de syntaxe HTML**: lignes 70-71 contiennent `}` et `</script>` orphelins (un reste de code mort). Le JS réel est dans `runs.js` appelé en bas, donc la page fonctionne, mais le HTML est malformé.
4. **Liens morts dans profile.html**: `href="index.html?tab=global"` et `href="index.html?tab=stats"` — or les tabs d'index.html sont `maps`/`ranked`/`stats` (pas de `global`). Le lien "Classements" pointe vers un tab inexistant.
5. **CSS inline massif dans profile.html**: ~300 lignes de `<style>` inline qui dupliquent/surchargent des classes de `profile.css` (ex: `.pf-game-card`, `.pf-game-result`, `.pf-header-card`). Maintenance difficile.
6. **Cosmétiques RGB**: utilisation massive de `!important` (~80 occurrences dans styles.css) + fonts non preloadées → FOUT sur pseudos VIP + risque de flash visuel.
7. **Code mort**: `createConfetti()` et `playSound()` vides, fonctions `animateRanking()` qui dépendent de `previousGlobalLeaderboard` mais l'animation CSS `.animate` n'est pas définie clairement.
8. **State global fragile**: `processData()` modifie de nombreuses globales (`allRuns`, `_rawRuns`, `playerStats`, `globalLeaderboard`, `allMaps`, `_recentRuns`, `_mapTotalCounts`, `_durationBuckets`) et est appelée depuis ~6 endroits différents avec des side effects cumulatifs. Risque de bugs de cohérence.
9. **Config Firebase en clair** dans `shared/firebase-config.js` (apiKey, projectId, etc.) — pas critique pour Firebase web (clés publiques par design) mais exposé publiquement dans le repo.
10. **Dépendance CORS proxy fragile**: en production GitHub Pages, le site dépend de 3 proxies CORS third-party (corsproxy.io + codetabs + allorigins). Si un tombe en panne ou change de politique, l'auth ownership verification et le modal historique ranked cassent.
11. **Re-render non optimisé**: `renderAll()` re-render tout (maps + feed + global + hof + charts + compare + active map) à chaque changement mineur. Le debounce de 300ms existe mais n'est pas appliqué partout.
12. **Pas de lazy-load des images**: tous les logos PNG sont chargés `eager` (sauf un `loading="eager"` explicite sur le logo sidebar). Pas de `loading="lazy"` sur les avatars.
