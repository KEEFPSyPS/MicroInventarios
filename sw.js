/* ===========================================================================
 * sw.js — Service Worker de Microinventarios
 * ---------------------------------------------------------------------------
 * - Precaché del "app shell" (HTML, manifest, iconos).
 * - HTML: network-first con respaldo a caché (las actualizaciones llegan rápido).
 * - Estáticos y CDN (cdnjs, Google Fonts, gstatic de Firebase JS):
 *   stale-while-revalidate (tolera respuestas opacas tipo "no-cors").
 * - NUNCA intercepta Firestore/Auth/API dinámica ni peticiones no-GET:
 *   esos datos van SIEMPRE directo a la red.
 * - Actualización controlada: si hay un SW nuevo esperando, la página muestra
 *   un aviso "Hay una versión nueva · Actualizar" y llama a skipWaiting.
 * - Sin conexión: sirve el shell en caché; la página muestra el aviso.
 *
 * NOTA: `VERSION` NO se edita a mano. Lo deriva del contenido del shell el
 * script scripts/actualizar-version-sw.mjs, que corre en `predeploy` (ver
 * firebase.json) y con `npm run build:sw`. Así, cualquier cambio en
 * index.html/styles.css/app.js produce una versión nueva automáticamente.
 * ======================================================================== */

const VERSION = "h8559d7851ed2-d8d4db2";
const CACHE = "microinventarios-" + VERSION;

/* App shell: rutas relativas para funcionar también en subcarpetas. */
const SHELL = [
  "./",
  "./index.html",
  "./styles.css",
  "./app.js",
  "./busqueda.js",
  "./firebase-config.js",
  "./manifest.webmanifest",
  "./icons/icon.svg",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/icon-512-maskable.png",
  "./icons/apple-touch-icon-180.png"
];

/* Hosts de API dinámica que NUNCA deben pasar por caché (datos en vivo). */
const NO_CACHE_HOSTS = [
  "firestore.googleapis.com",
  "identitytoolkit.googleapis.com",
  "securetoken.googleapis.com",
  "firebaseio.com",
  "firebaseapp.com",
  "googleapis.com"
];

/* Hosts estáticos/CDN que usan stale-while-revalidate. */
const SWR_HOSTS = [
  "cdnjs.cloudflare.com",
  "fonts.googleapis.com",
  "fonts.gstatic.com",
  "gstatic.com"
];

/* ---------- install: precachear el shell ---------- */
self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      await Promise.all(
        SHELL.map((url) =>
          cache.add(new Request(url, { cache: "reload" })).catch(() => {})
        )
      );
      // No forzamos skipWaiting aquí: la página decide cuándo con el aviso.
    })()
  );
});

/* ---------- activate: limpiar cachés antiguas y tomar control ---------- */
self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((k) => k.startsWith("microinventarios-") && k !== CACHE)
          .map((k) => caches.delete(k))
      );
      if (self.registration.navigationPreload) {
        try { await self.registration.navigationPreload.disable(); } catch (_) {}
      }
      await self.clients.claim();
    })()
  );
});

/* ---------- mensajes desde la página ---------- */
self.addEventListener("message", (event) => {
  const data = event.data || {};
  if (data.type === "SKIP_WAITING") self.skipWaiting();
  if (data.type === "GET_VERSION" && event.ports && event.ports[0]) {
    event.ports[0].postMessage({ version: VERSION });
  }
});

/* ---------- helpers ---------- */
function isSameOrigin(url) {
  return new URL(url).origin === self.location.origin;
}

function isNavigationRequest(request) {
  return (
    request.mode === "navigate" ||
    (request.method === "GET" &&
      (request.headers.get("accept") || "").includes("text/html"))
  );
}

function shouldBypass(request) {
  // Solo GET se cachea. Todo lo demás va directo a la red.
  if (request.method !== "GET") return true;
  let host;
  try { host = new URL(request.url).host; } catch (_) { return true; }
  // API dinámica: jamás tocar (Firestore, Auth, tokens, realtime).
  if (NO_CACHE_HOSTS.some((h) => host === h || host.endsWith("." + h))) return true;
  return false;
}

function isCacheable(request) {
  let host;
  try { host = new URL(request.url).host; } catch (_) { return false; }
  return SWR_HOSTS.some((h) => host === h || host.endsWith("." + h));
}

/* ---------- fetch ---------- */
self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = request.url;

  if (!url.startsWith("http")) return;              // data:, chrome-extension, etc.
  if (shouldBypass(request)) return;                // API dinámica / no-GET

  if (isNavigationRequest(request)) {               // 1) HTML: network-first
    event.respondWith(networkFirstHtml(request));
    return;
  }
  if (isSameOrigin(url) || isCacheable(request)) {  // 2) estáticos/CDN: SWR
    event.respondWith(staleWhileRevalidate(request));
    return;
  }
  // 3) Cualquier otro GET: a la red normalmente.
});

async function networkFirstHtml(request) {
  const cache = await caches.open(CACHE);
  try {
    const fresh = await fetch(request);
    cache.put(request, fresh.clone()).catch(() => {});
    return fresh;
  } catch (_) {
    const cached =
      (await cache.match(request)) ||
      (await cache.match("./index.html")) ||
      (await cache.match("./"));
    if (cached) return cached;
    return new Response(
      "<h1>Sin conexión</h1><p>No se puede abrir Microinventarios. Reconecta e inténtalo de nuevo.</p>",
      { status: 503, headers: { "Content-Type": "text/html; charset=utf-8" } }
    );
  }
}

async function staleWhileRevalidate(request) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(request);

  const network = fetch(request)
    .then((response) => {
      if (response && (response.ok || response.type === "opaque")) {
        cache.put(request, response.clone()).catch(() => {});
      }
      return response;
    })
    .catch(() => null);

  return cached || (await network) || Response.error();
}

