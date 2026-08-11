/**
 * Cloudflare Worker — Proxy CORS vers l'API OpenFront avec exemption Skailex.
 *
 * Ce proxy :
 *   1. Ajoute le header `x-skailex-access` côté serveur (token non exposé côté client)
 *   2. Ajoute les headers CORS permissifs (`Access-Control-Allow-Origin: *`)
 *   3. Forward la requête vers https://api.openfront.io/<path>
 *
 * Déploiement :
 *   1. Créer un compte gratuit sur https://dash.cloudflare.com
 *   2. Workers & Pages → Create application → Create Worker
 *   3. Nommer le worker "openfront-proxy" → Deploy
 *   4. Edit code → coller ce fichier → Save and deploy
 *   5. L'URL sera : https://openfront-proxy.<votre-sous-domaine>.workers.dev
 *   6. Ajouter cette URL dans public/dashboard.html :
 *      <meta name="openfront-api-proxy" content="https://openfront-proxy.xxx.workers.dev">
 *
 * Le plan gratuit : 100 000 requêtes/jour — largement suffisant.
 */

// Token d'exemption Skailex — fourni par OpenFront
const SKAILEX_ACCESS_TOKEN = "6e477cdeeea36386e4061dd89450a66c";

const API_BASE = "https://api.openfront.io";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Accept",
  "Access-Control-Max-Age": "86400",
};

export default {
  async fetch(request) {
    // ── CORS preflight ──
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    // ── Only allow GET ──
    if (request.method !== "GET") {
      return new Response(JSON.stringify({ error: "Method not allowed" }), {
        status: 405,
        headers: { "Content-Type": "application/json", ...CORS_HEADERS },
      });
    }

    // ── Build target URL ──
    const url = new URL(request.url);
    // Le worker reçoit /public/player/xxx/games?cursor=yyy
    // On forward vers https://api.openfront.io/public/player/xxx/games?cursor=yyy
    const targetUrl = `${API_BASE}${url.pathname}${url.search}`;

    try {
      const upstream = await fetch(targetUrl, {
        method: "GET",
        headers: {
          Accept: "application/json",
          "User-Agent": "skailex",
          "x-skailex-access": SKAILEX_ACCESS_TOKEN,
        },
        cf: { cacheTtl: 0 },
      });

      const body = await upstream.text();
      const contentType = upstream.headers.get("content-type") || "application/json";

      return new Response(body, {
        status: upstream.status,
        headers: {
          "Content-Type": contentType,
          "Cache-Control": "no-store",
          ...CORS_HEADERS,
        },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown proxy error";
      return new Response(
        JSON.stringify({ error: "Proxy fetch failed", message, target: targetUrl }),
        {
          status: 502,
          headers: { "Content-Type": "application/json", ...CORS_HEADERS },
        }
      );
    }
  },
};
