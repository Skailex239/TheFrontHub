// sw.js — Service Worker for TheFrontHub (v8 — Stale-While-Revalidate)
//
// Strategies:
//   • /dist/*.js (minified, versioned via ?v=N)  → CACHE-FIRST, immutable (1 year)
//   • Data files (.json, .json.gz)              → STALE-WHILE-REVALIDATE
//   • HTML pages (/, /index.html, /profile.html, /runs.html, /dashboard.html,
//                 /lobby.html, /atlas.html, /tournois.html)
//                                                → NETWORK-FIRST with cache fallback (offline)
//   • Other static assets (CSS, images)          → CACHE-FIRST with network fallback
//   • Cross-origin (firebase, gstatic, openfront, corsproxy, jsdelivr) → BYPASS SW
//
// Why SWR for data files?
//   - User opens site → INSTANT cache response (even if stale)
//   - Network fetch in background → cache silently updated
//   - On next visit: user sees fresh data, still instantly
//   - Works even on flaky 3G

const CACHE_NAME = 'thefronthub-v1';
const CACHE_IMMUTABLE = 'thefronthub-imm-v1';
const SWR_MAX_AGE_MS = 30 * 60 * 1000;  // 30 min — consider cache fresh this long

// Static assets to pre-cache on install (HTML pages + core JS + CSS + icons)
const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/runs.html',
  '/profile.html',
  '/dashboard.html',
  '/lobby.html',
  '/atlas.html',
  '/tournois.html',
  '/styles.css',
  '/auth.css',
  '/profile.css',
  '/dashboard.css',
  '/lobby.css',
  '/atlas.css',
  '/tournois.css',
  '/skins.css',
  '/animations.css',
  '/toast.css',
  // Minified JS bundles
  '/dist/app.min.js',
  '/dist/profile.min.js',
  '/dist/dashboard.min.js',
  '/dist/lobby.min.js',
  '/dist/atlas.min.js',
  '/dist/tournois.min.js',
  '/dist/tournois-icons.min.js',
  '/dist/runs.min.js',
  '/dist/i18n.min.js',
  '/dist/toast.min.js',
  '/dist/animations.min.js',
  '/dist/lenis.min.js',
  '/dist/icons.min.js',
  '/dist/auth.min.js',
  // Shared modules (used as ESM imports)
  '/shared/maps.js',
  '/shared/firebase-config.js',
  // Favicons + logo
  '/favicon.ico',
  '/favicon-32x32.png',
  '/favicon-180x180.png',
  '/TheFrontHub Logo Text.png',
  // Optimized public data files (small, cacheable)
  '/runs_public.json.gz',
  '/runs_compact_public.json.gz',
  '/teams_public.json.gz',
  '/ranked.json',
  '/ranked.json.gz',
];

// ── Install: pre-cache static assets ────────────────────────────────────────
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      // Use individual adds instead of addAll so one failure doesn't block everything
      return Promise.all(
        STATIC_ASSETS.map((url) =>
          cache.add(url).catch((err) => {
            console.warn('[SW] Could not pre-cache:', url, err.message);
          })
        )
      );
    })
  );
  self.skipWaiting();  // activate new SW immediately on install
});

// ── Activate: clean old caches + claim clients ──────────────────────────────
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys
          .filter((key) => key !== CACHE_NAME && key !== CACHE_IMMUTABLE)
          .map((key) => {
            console.log('[SW] Deleting old cache:', key);
            return caches.delete(key);
          })
      );
    }).then(() => self.clients.claim())
  );
});

// ── Helpers ──────────────────────────────────────────────────────────────────

function isCrossOrigin(url) {
  // Bypass SW for all cross-origin requests — let browser handle them directly
  return (
    url.hostname.includes('firebaseio.com') ||
    url.hostname.includes('googleapis.com') ||
    url.hostname.includes('gstatic.com') ||
    url.hostname.includes('corsproxy.io') ||
    url.hostname.includes('allorigins.win') ||
    url.hostname.includes('openfront.io') ||
    url.hostname.includes('fonts.googleapis.com') ||
    url.hostname.includes('fonts.gstatic.com') ||
    url.hostname.includes('jsdelivr.net')
  );
}

function isImmutableAsset(pathname) {
  // Files in /dist/ are versioned via ?v=N — treat as immutable (1y cache)
  return pathname.startsWith('/dist/');
}

function isDataFile(pathname) {
  return pathname.endsWith('.json.gz') || pathname.endsWith('.json');
}

function isHtmlPage(pathname) {
  return pathname === '/' ||
         pathname.endsWith('.html') ||
         pathname === '/index.html';
}

// ── Fetch handler ───────────────────────────────────────────────────────────
self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // Skip non-GET requests
  if (req.method !== 'GET') return;

  // Skip cross-origin requests entirely (Firebase, OpenFront, CDN, etc.)
  if (isCrossOrigin(url)) return;

  // ── Strategy 1: /dist/*.js → cache-first, immutable ──
  if (isImmutableAsset(url.pathname)) {
    event.respondWith(
      caches.open(CACHE_IMMUTABLE).then((cache) =>
        cache.match(req).then((cached) => {
          if (cached) return cached;
          return fetch(req).then((response) => {
            if (response.ok) {
              cache.put(req, response.clone());
            }
            return response;
          }).catch(() => cached || new Response('Offline', { status: 503 }));
        })
      )
    );
    return;
  }

  // ── Strategy 2: Data files (.json, .json.gz) → stale-while-revalidate ──
  if (isDataFile(url.pathname)) {
    event.respondWith(
      caches.open(CACHE_NAME).then(async (cache) => {
        const cached = await cache.match(req);

        // Always start a network fetch in the background to revalidate
        const networkFetchPromise = fetch(req)
          .then((response) => {
            if (response.ok) {
              cache.put(req, response.clone());
            }
            return response;
          })
          .catch(() => null);

        // SWR logic:
        //   - Cache exists → return it IMMEDIATELY (even if stale)
        //   - Network fetch updates the cache silently in the background
        //   - No cache → wait for network
        if (cached) {
          return cached;
        }
        const networkResponse = await networkFetchPromise;
        return networkResponse || new Response('Offline', { status: 503 });
      })
    );
    return;
  }

  // ── Strategy 3: HTML pages → network-first, cache fallback (offline) ──
  if (isHtmlPage(url.pathname)) {
    event.respondWith(
      fetch(req)
        .then((response) => {
          if (response.ok) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(req, clone));
          }
          return response;
        })
        .catch(() => caches.match(req).then((cached) => cached || caches.match('/')))
    );
    return;
  }

  // ── Strategy 4: Other static assets (CSS, images) → cache-first, network fallback ──
  event.respondWith(
    caches.match(req).then((cached) => {
      if (cached) return cached;
      return fetch(req).then((response) => {
        if (response.ok && url.origin === self.location.origin) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(req, clone));
        }
        return response;
      }).catch(() => {
        if (req.mode === 'navigate') {
          return caches.match('/');
        }
        return new Response('Offline', { status: 503 });
      });
    })
  );
});

// ── Message handler: allow page to trigger skipWaiting ──────────────────────
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});
