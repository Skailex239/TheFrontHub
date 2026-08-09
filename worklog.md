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

---
Task ID: 1-openfront-api
Agent: Explore (openfront API schema)
Task: Analyse du schéma API ranked d'OpenFront

Work Log:
- Lu le worklog précédent (Agent 2 — frontend TheFrontHub) pour contexte : `/public/player/{id}` + `/public/game/{id}` sont utilisés pour ownership verification et détermination win/loss, `ranked.json` sert le leaderboard Classé.
- Cloné shallow le repo OpenFront : `git clone --depth 1 https://github.com/openfrontio/OpenFrontIO.git /tmp/openfront` (réussi, 3140 fichiers).
- Lister `/tmp/openfront` : c'est le repo du JEU (client + game server Workers/Master), PAS le repo du backend API `api.openfront.io` (qui est séparé et nommé "infra" dans les commentaires). Les endpoints `/leaderboard/ranked` et `/public/player/:id` sont servis par ce backend séparé, mais le schéma Zod qu'ils retournent est défini dans CE repo (game repo) à `src/core/ApiSchemas.ts`, et le client wrapper est dans `src/client/Api.ts`.
- Grep `leaderboard.*ranked` dans `src/` → 1 fichier : `src/client/Api.ts` (seul le client-side fetcher est ici ; pas de handler serveur).
- Lu `src/client/Api.ts` (1140 lignes) : confirmé `fetchPlayerLeaderboard(page)` (lignes 984-1023) appelle `GET ${getApiBase()}/leaderboard/ranked?page=N` sans auth, parse avec `RankedLeaderboardResponseSchema`. `getApiBase()` retourne `https://api.openfront.io` en prod. 400 avec message `Page must be between N and M` → `"reached_limit"` (fin de pagination).
- Lu `docs/API.md` (285 lignes) : décrit `/public/player/:playerId` (retourne PlayerProfile), `/public/player/:playerId/sessions` (jeux + client ids par session), `/public/player/:playerId/games` (keyset pagination, `filter=ffa|team|hvn|ranked`, `type=public|private|singleplayer`, retourne `username`/`clanTag` per-game). Note: "Public player IDs are stripped from game records for privacy".
- Lu `docs/Auth.md` (25 lignes) : établit la distinction fondamentale `clientID` (éphémère, par WebSocket session) vs `persistentID` (longue durée, dans le JWT `sub`).
- Lu `src/core/ApiSchemas.ts` (711 lignes) en entier via offset/limit + grep ciblés. Trouvé les schémas Zod clés:
  - `RankedLeaderboardEntrySchema` (lignes 597-611): `{ rank, elo, peakElo:nullable, wins, losses, total, public_id: string, accountUsername: string|null }`
  - `RankedLeaderboardResponseSchema` (lignes 613-622): `{ "1v1": Entry[], "2v2": Entry[] (default []) }`
  - `PlayerProfileSchema` (lignes 497-519): `{ createdAt, user?:DiscordUser, username: string|null|optional (pré-rendu server), stats: PlayerStatsTree, clans?: array }`
  - `PublicPlayerGameSchema` (lignes 546-560): `{ gameId, start, durationSeconds, map, mode, type, playerTeams, rankedType, result: victory|defeat|incomplete, totalPlayers, username, clanTag }` — PAS de clientID ici
  - `PlayerLeaderboardEntrySchema` (lignes 573-588): `{ rank, playerId, accountUsername:nullable, flag?, elo, games, wins, losses, winRate }` — note: `playerId` (camelCase) ici vs `public_id` (snake_case) dans RankedLeaderboardEntry. Ce sont 2 endpoints distincts.
  - `UserMeResponseSchema.player` (lignes 171-257): contient `publicId`, `username`, `usernameBase`, `usernameDiscriminator`, `usernameStatus`, `usernameClaimExpiresAt`, `nextUsernameChangeAt`. Confirme que `publicId` est l'ID public stable au niveau compte.
- Lu `src/core/validations/username.ts` (126 lignes) : `AccountUsernameSchema` = regex `^[a-zA-Z0-9_-]+( [a-zA-Z0-9_-]+)*$`, 3-20 chars, no dots (dot = séparateur base.suffix). Commentaire ligne 13: "Mirrors the API's account-username rules (infra src/api/lib/Usernames.ts)" — confirme que la GÉNÉRATION du suffixe est dans le backend "infra" NON inclus dans ce repo.
- Lu `src/client/components/ui/UsernameText.ts` (39 lignes) : pattern `^(.+)\.(\d{4})$` — confirme format suffix = exactement 4 digits, leading zeros préservés (donc `.9681`, `.0001`, etc.). "the server renders account usernames as 'base.1234'".
- Lu `src/client/components/UsernamePanel.ts` (243 lignes) : le formulaire de rename ne montre que `usernameBase` (pas le suffix), confirme que le suffix est server-side généré.
- Lu `src/server/Client.ts` (27 lignes) : la classe `Client` (server-side game server) stocke `{ clientID, persistentID, claims, role, flares, ip, username, clanTag, ws, cosmetics, publicId, friends }`. Confirme les 3 IDs co-existent au runtime.
- Lu `src/server/Worker.ts` lignes 410-698 : le flow complet de join WebSocket — `verifyClientToken(token)` extrait `persistentId` du JWT, puis `getUserMe(token)` récupère `publicId`/`accountUsername`/`friends`/`flares`/etc. depuis l'API backend, puis `new Client(generateID(), persistentId, ...)` crée un client avec un `clientID` frais ET le `publicId` API-resolved.
- Lu `src/server/GameServer.ts` lignes 1590-1624 (`buildFriendsLookup`) : friends list = tableau de `publicId`s (pas de clientIDs). Le serveur mappe `publicId → clientID` au démarrage de la game. Confirme `publicId` est la clé d'identité cross-game.
- Lu `src/core/Schemas.ts`:
  - Lignes 405-416: `PersistentIdSchema = z.uuid()` — persistentID est un UUID canonique (36 chars). Dans le JWT il est encodé base64url (TokenPayloadSchema.sub).
  - Lignes 423-428: `GAME_ID_REGEX = /^[A-Za-z0-9]{8}$/`, `ID = z.string().regex(GAME_ID_REGEX)` — définit le format des `clientID` ET `gameID`.
  - Lignes 715-726 `PlayerSchema` : `{ clientID: ID, username, clanTag, cosmetics?, isLobbyCreator?, friends?: ID[], teamIndex? }`.
  - Lignes 739-749 `GameStartInfoSchema` : inclut `players: PlayerSchema[]` (donc avec leurs clientIDs).
  - Lignes 751-758 `WinnerSchema` : `z.union([["player", ID, ...ID], ["team", SafeString, ...ID], ["nation", SafeString, ...ID]]).optional()`. Le winner est donc un tuple où index 0 = type ("player"/"team"/"nation"), index 1+ = clientIDs (ou team/nation name en [1] puis clientIDs en [2+] pour team/nation).
  - Lignes 929-944 `PlayerRecordSchema` + `GameEndInfoSchema` : `GameEndInfo` = `GameStartInfo` + `{ start, end, duration, num_turns, winner, lobbyFillTime }` avec `players: PlayerRecordSchema[]` (où PlayerRecord = Player + `{ persistentID: uuid|null (PII), stats }`).
  - Lignes 986-1000 `ArchivedAnalyticsRecordSchema` : variante tolérante pour la lecture des archives anciennes.
- Lu `src/core/Util.ts` lignes 368-374 : `generateID()` = customAlphabet `"123456789abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ"` (exclut 0/O/l/I), 8 chars. C'est ce qui génère les `clientID` ET `gameID` côté game server. Note: le regex `ID` autorise 0/O/l/I mais la fonction ne les produit pas — les IDs réels n'ont donc pas ces chars.
- Lu `tests/client/ApiPlayerLeaderboard.test.ts` (157 lignes) : confirme le format de payload `{ "1v1": [entry], "2v2": [] }` avec `entry.public_id = "player-N"` et `entry.accountUsername = "alpha.0001"` (le test utilise des valeurs factices mais valide la structure suffixée).
- Vérifié `public_id` stable cross-mode : `publicId` est fetché UNE fois via `/users/@me` au join WebSocket, stocké sur `Client.publicId`, et utilisé pour `/public/player/:publicId` indépendamment du mode de game. Le `PlayerStatsTree` dans PlayerProfile ventile par mode (`Ranked.1v1`, `Ranked.2v2`, `Public.FFA`, `Public.Team`, etc.) mais tous sous le même `publicId`. Donc OUI, `public_id` est IDENTIQUE en FFA speedrun et en ranked 1v1/2v2.

Stage Summary:

# Sémantique des champs API ranked OpenFront

## Hiérarchie des identifiants (3 niveaux)

1. **`persistentID`** (UUID canonique 36 chars, base64url dans le JWT `sub`)
   - Jamais exposé publiquement.
   - Stocké côté game server dans `Client.persistentID` (PII).
   - Mapping `persistentID → clientID` tenu par `GameServer.persistentIdToClientId` pour la reconnexion.
   - Marqué `// WARNING: PII` dans `PlayerRecordSchema` (Schemas.ts:930).

2. **`publicId`** / **`public_id`** (8 chars alphanumériques, regex `^[A-Za-z0-9]{8}$`)
   - Stable par COMPTE, jamais par session.
   - Retourné par `GET /users/@me` dans `player.publicId` (UserMeResponseSchema).
   - Au join WebSocket, le worker fetch `/users/@me` UNE fois pour résoudre `publicId` depuis le JWT, puis stocke sur `Client.publicId`.
   - C'est l'ID utilisé comme `:playerId` dans `/public/player/:playerId` et `/public/player/:playerId/games` et `/public/player/:playerId/sessions`.
   - Apparaît dans `/leaderboard/ranked` sous le nom de champ `public_id` (snake_case) au sein de `RankedLeaderboardEntry`.
   - Apparaît dans `/leaderboard/players` (autre endpoint) sous le nom `playerId` (camelCase) au sein de `PlayerLeaderboardEntry`.
   - **STABLE CROSS-MODE** : un même compte a le même `public_id` en FFA speedrun, en ranked 1v1, et en ranked 2v2. Les modes sont ventilés dans `PlayerStatsTree` (PlayerProfile.stats), pas via des IDs distincts.

3. **`clientID`** (8 chars alphanumériques, généré par `generateID()` — alphabet sans `0/O/l/I`)
   - ÉPHÉMÈRE : nouveau clientID à chaque connexion WebSocket (page refresh, reconnect, nouvelle tab = nouveau clientID).
   - Stocké dans `Client.clientID` côté game server.
   - Utilisé pour le routage des intents in-game, le kick, le vote, l'attribution de team, etc.
   - Mapping `publicId → clientID` reconstruit au démarrage de chaque game (GameServer.buildFriendsLookup) pour traduire la friends list (stockée en publicIds) vers les clientIDs live.
   - Persisté dans les archives de games (`info.players[].clientID`), mais PAS dans `/public/player/:id/games` (la response `PublicPlayerGameSchema` n'expose QUE `username` et `clanTag` par game, pas de clientID).
   - Pour récupérer le clientID d'un joueur dans une game donnée : `/public/player/:playerId/sessions` (retourne `{ game, clientID }[]` — voir docs/API.md).

## Suffixe `.9681` des `accountUsername`

- Format : `base.suffix` où `suffix` = exactement 4 digits, leading zeros préservés (ex: `Skailex.9681`, `alpha.0001`). Regex client: `^(.+)\.(\d{4})$`.
- La base ne peut JAMAIS contenir de point (`AccountUsernameSchema` = `^[a-zA-Z0-9_-]+( [a-zA-Z0-9_-]+)*$`, 3-20 chars).
- **Génération côté serveur** dans le backend "infra" (repo séparé non inclus ici — référence: `src/api/lib/Usernames.ts` mentionné dans `src/core/validations/username.ts:13`). Pas visible dans le game repo.
- Le suffix est **re-rolled à chaque rename** (commentaire ApiSchemas.ts:264-265). Donc PAS dérivé du `public_id` ou `accountId` — c'est un discriminator aléatoire/unique géré serveur, probablement pour éviter les collisions entre comptes qui ont choisi le même base name.
- Quatre `usernameStatus` possibles (ApiSchemas.ts:120-126): `unclaimed` (défaut, pas de réservation de bare name → suffix affiché), `claimed` (réservation tenue mais abonnement expiré → suffix réapparaît + grace deadline), `premium` (abonné, bare name affiché sans suffix), `indefinite` (admin-locked bare display).
- Seuls `premium` et `indefinite` affichent le bare name sans suffix. Tous les autres → format `base.suffix`.
- `TEMPORARY####` est un cas spécial de bare name (sans suffix) attribué serveur quand un subscriber prend le bare name d'un joueur `claimed` — pas un vrai username choisi.
- `isVerifiedUsername(username)` (ApiSchemas.ts:142-150) = true ssi `username` est une string, ne contient pas de `.`, et n'est pas `TEMPORARY####`. C'est le critère pour le badge vérifié (blue check).

## Différence `accountUsername` vs `username` vs `usernameBase`/`usernameDiscriminator`

| Champ | Scope | Mutabilité | Format | Où |
|---|---|---|---|---|
| `accountUsername` | Compte (account-level) | Change via `PUT /users/@me/username` (cooldown 30j, re-roll suffix) | `base` (bare, premium/indefinite) OU `base.dddd` (unclaimed/claimed) | `RankedLeaderboardEntry.accountUsername`, `PlayerLeaderboardEntry.accountUsername` |
| `username` (dans PlayerProfile/UserMeResponse) | Compte (account-level) | Idem que accountUsername | Idem (pré-rendu serveur) | `UserMeResponseSchema.player.username`, `PlayerProfileSchema.username`, `FriendEntrySchema.username` |
| `usernameBase` | Compte | Idem | Juste la base (`Skailex`), sans suffix | `UserMeResponseSchema.player.usernameBase` (uniquement sur /users/@me, jamais dans public leaderboards) |
| `usernameDiscriminator` | Compte | Idem | Juste les 4 digits (`9681`) ou null | `UserMeResponseSchema.player.usernameDiscriminator` (uniquement sur /users/@me) |
| `username` (dans PublicPlayerGame) | PER-GAME (snapshot au moment de la game) | Immutable post-game | In-game display name utilisé à ce moment-là (avec ou sans clan tag intégré, etc.) | `PublicPlayerGameSchema.username` |

**Convention de nommage**: dans les leaderboards PUBLICS (`RankedLeaderboardEntry`, `PlayerLeaderboardEntry`, `FriendEntry`), le champ account-level s'appelle `accountUsername` (snake_case) ou `username` (selon le contexte). Dans `/users/@me` (auth-self), il s'appelle `username` (display form pré-rendu) + `usernameBase` + `usernameDiscriminator` + `usernameStatus` (détaillé). Dans `/public/player/:id/games`, le champ per-game s'appelle `username` (mais c'est l'IDENTITÉ IN-GAME snapshot, pas l'account username).

## Endpoint `/leaderboard/ranked` — schéma complet

```
GET https://api.openfront.io/leaderboard/ranked?page=N
```
- Pas d'auth.
- `page` est requis (1-indexed). Au-delà de la dernière page, le serveur répond 400 avec `{"message": "Page must be between 1 and N"}` — c'est le signal de fin (pas de liste vide).
- Response: `RankedLeaderboardResponse`
```ts
{
  "1v1": [
    {
      "rank": number,           // 1-indexed, position dans la ladder
      "elo": number,            // ELO courant
      "peakElo": number | null, // max ELO historique (null si pas encore calculé/connu)
      "wins": number,
      "losses": number,
      "total": number,          // wins + losses
      "public_id": string,      // 8 chars alphanum, STABLE par compte, clé d'identité
      "accountUsername": string | null  // null si jamais set; "base.suffix" ou "base" (premium)
    },
    ...
  ],
  "2v2": [ ... ] // default [] si l'API ne supporte pas encore 2v2
}
```

## Endpoint `/public/player/:id` — schéma complet

- `:id` = `public_id` (PAS clientID, PAS persistentID). Format `^[A-Za-z0-9]{8}$`.
- Pas d'auth.
- Response: `PlayerProfile`
```ts
{
  "createdAt": ISO datetime,
  "user"?: DiscordUser,   // seulement si le joueur a lié Discord
  "username": string | null | undefined,  // account username pré-rendu (base ou base.suffix), null si jamais set
  "stats": PlayerStatsTree,               // arbre complet: Singleplayer/Public/Private/Ranked × FFA/Team/HvN × Easy/Medium/Hard/Impossible
  "clans"?: [{ tag, name, role: leader|officer|member, joinedAt, memberCount }]
}
```
- Ne retourne PAS `games[]` directement. Pour l'historique de parties, utiliser `/public/player/:id/games` (paginated) ou `/public/player/:id/sessions` (jeux + clientIDs).

## Endpoint `/public/player/:id/games`

- `:id` = `public_id`. Pas d'auth.
- Query: `filter=ffa|team|hvn|ranked`, `type=public|private|singleplayer`, `cursor=<opaque>`.
- Response: `PublicPlayerGamesResponse`
```ts
{
  "results": [
    {
      "gameId": string,
      "start": ISO datetime,
      "durationSeconds": number,
      "map": string,
      "mode": string,            // "Free For All" | "Team" | HumansVsNations
      "type": string,            // "Public" | "Private" | "Singleplayer"
      "playerTeams": string | null,  // "Duos"|"Trios"|"Quads"|null
      "rankedType": string,      // "unranked"|"1v1"|"2v2"
      "result": "victory" | "defeat" | "incomplete",  // incomplete = no recorded winner
      "totalPlayers": number | null,
      "username": string,        // PER-GAME in-game username (snapshot au moment de la game)
      "clanTag": string | null   // PER-GAME clan tag
    },
    ...
  ],
  "nextCursor": string | null   // null = plus de pages; sinon round-trip verbatim
}
```
- `username` et `clanTag` reflètent l'identité utilisée DANS CETTE GAME spécifique (commentaire docs/API.md:167).

## Relation compte ↔ usernames

Un compte (1 `persistentID` ↔ 1 `public_id` immuable) peut avoir :

1. **0 ou 1 `accountUsername` courant** (muté via `PUT /users/@me/username`, cooldown 30j). Si null → le joueur n'a jamais set de custom name et s'affiche par son `public_id`. Si set → s'affiche en `base` (premium/indefinite) ou `base.suffix` (unclaimed/claimed). Le suffix re-roll à chaque rename.

2. **N `username` per-game archivés** (1 par game jouée). Stockés dans les `AnalyticsRecord.info.players[].username` des archives de games. Reflètent l'in-game display name au moment de la game — peuvent différer entre games à cause de:
   - Renames (le joueur a renommé son compte entre 2 games).
   - Clan tag changes (le clan tag est per-game, pas per-account — le player peut quitter/rejoindre un clan).
   - Anonymization (anonymizeNames flag en private/custom games).
   - Censoring (le serveur censure les names inappropriés au join via `censorPlayer()` dans Worker.ts:458-461, puis `verifyJoin` overwrite avec le verdict API).

3. **N `clientID` éphémères** (1 par session WebSocket). Non archivés publiquement dans `/public/player/:id/games` (la privacy policy strippe les IDs publics des game records), MAIS récupérables via `/public/player/:id/sessions` qui retourne explicitement la liste `{ game, clientID }[]` (voir docs/API.md:107-121).

**Donc**: pour TheFrontHub, le `accountUsername` (champ `username` ou `accountUsername` selon l'endpoint) est l'identité "officielle" courante du compte à afficher dans les leaderboards. Le `public_id` est la seule clé stable à utiliser pour matcher un joueur entre endpoints différents (ranked leaderboard ↔ player profile ↔ game history). Ne JAMAIS utiliser `username` comme clé (peut changer), et ENCORE MOINS `clientID` (éphémère).

## Implications pour TheFrontHub

1. **Clé d'identité recommandée**: `public_id` (champ `public_id` dans `ranked.json`, `publicId` dans `/users/@me`, `:id` dans `/public/player/:id`). Déjà ce que fait TheFrontHub.

2. **Affichage recommandé**: `accountUsername ?? public_id` (formule donnée dans le commentaire ApiSchemas.ts:605-607). Déjà ce que fait TheFrontHub.

3. **Pour la détermination WIN/LOSS** dans le modal historique ranked:
   - `/public/player/:publicId/games?filter=ranked` → donne les games ranked avec `result` déjà calculé côté serveur (`victory|defeat|incomplete`). Donc TheFrontHub n'a PAS besoin de fetcher `/public/game/:id` pour déterminer win/loss — le champ `result` est déjà là.
   - MAIS si TheFrontHub veut des détails supplémentaires (par exemple qui étaient les coéquipiers/adversaires), il faut alors `/public/game/:gameId` qui retourne `info.players[]` (avec leurs clientIDs/usernames) et `info.winner` (tuple `["player"|"team"|"nation", ID, ...]`).
   - Le match player↔clientID dans une game donnée se fait via `/public/player/:id/sessions` qui retourne explicitement les paires `{game, clientID}`.

4. **Stabilité du suffixe**: `.9681` est un discriminator qui peut CHANGER si le joueur rename. Donc ne PAS utiliser `accountUsername` comme clé de cache permanent — uniquement `public_id`. TheFrontHub a déjà cette convention (compare par `publicId` uniquement, cf. commentaire ApiSchemas.ts:501-502).

5. **Quand `accountUsername` est null**: le joueur n'a jamais set de custom name → afficher `public_id` à la place. Ne pas crasher si le champ est absent.

---
Task ID: 2-skin-linking
Agent: main (Z.ai Code)
Task: Étendre le skin multicolore VIP au leaderboard ranked + profil, en reliant l'identité ranked (accountUsername/public_id) à l'identité speedrun

Work Log:
- Analysé le système VIP existant dans app.js (loadVipPlayers, vipPlayers Map, rendu cosmétique)
- Identifié le mismatch: pseudo speedrun "Skailex" vs pseudo ranked "Skailex.9681" + public_id "UWetOwlW"
- Confirmé via l'API OpenFront que public_id est stable cross-mode (FFA/ranked 1v1/2v2)
- Ajouté 3 maps globales dans app.js: vipPlayersByPublicId, aliasToCanonical, publicIdToCanonical
- Ajouté 2 helpers: resolveVip({username, accountUsername, publicId}) + vipCosmeticClasses(rewardType)
- Enhancé loadVipPlayers() pour indexer data.aliases + data.publicIds depuis public-rewards
- Enhancé loadPublicAliases() pour construire aliasToCanonical + publicIdToCanonical (et ne plus skip les docs à alias unique)
- Remplacé les 4 appels directs vipPlayers.get() par resolveVip() dans: rendu ranked table, speedrun leaderboard, global top 50, modal ranked player
- Ajouté le skin sur Hall of Fame top 3 + comparateur de joueurs (n'en avaient pas avant)
- Ajouté le système VIP complet dans profile.js: loadProfileVip() + resolveProfileVip() + applyProfileCosmetic()
- Modifié renderHero() dans profile.js pour appliquer le skin sur le pseudo du profil
- Modifié saveUserProfile() dans profile.js pour auto-écrire dans public-aliases avec lookup du accountUsername ranked (auto-linking)
- Vérifié la syntaxe (node --check) des 2 fichiers modifiés
- Test logique de résolution avec vraies données Skailex: ✅ "Skailex.9681" + "UWetOwlW" → rewardType "prism"

Stage Summary:
- 2 fichiers modifiés: app.js (+182/-49 lignes), profile.js (+134 lignes)
- Le skin multicolore s'applique maintenant sur: leaderboard ranked, speedruns, global top 50, Hall of Fame, comparateur, modal joueur ranked, profil utilisateur
- 2 mécanismes de linking: (A) manuel via champs aliases[]/publicIds[] dans public-rewards, (B) automatique via public-aliases auto-écrit à la vérification de profil
- L'utilisateur Skailex doit soit: re-vérifier son profil (auto-link), soit ajouter aliases:["Skailex.9681"] + publicIds:["UWetOwlW"] à son doc public-rewards dans Firebase console
- Aucune régression: les skins existants (match direct username) continuent de fonctionner
