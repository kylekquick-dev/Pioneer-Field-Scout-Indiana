/* =====================================================================
   Field Scout — Service Worker
   App-shell caching for offline use. Data writes made while offline are
   handled separately by an IndexedDB queue in offline.js (the SW only
   caches the static shell + CDN libs and serves them when the network
   is unavailable).
   ===================================================================== */

const CACHE = "fieldscout-shell-v1";

// Files that make up the offline app shell.
const SHELL = [
  "./",
  "./index.html",
  "./app.js",
  "./config.js",
  "./offline.js",
  "./manifest.json",
  "./icon-192.png",
  "./icon-512.png",
  "./favicon.ico",
  "./favicon-32.png",
  "./apple-touch-icon.png",
  "https://unpkg.com/leaflet@1.9.4/dist/leaflet.css",
  "https://unpkg.com/leaflet@1.9.4/dist/leaflet.js",
  "https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js",
  "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2",
];

// Install: pre-cache the shell. addAll tolerates a couple of CDN misses
// by caching individually so one failure doesn't abort the whole install.
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then(async (cache) => {
      await Promise.allSettled(SHELL.map((url) => cache.add(url)));
      self.skipWaiting();
    })
  );
});

// Activate: clean up old caches.
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// Fetch strategy:
//   • Supabase API / Storage calls  -> network only (never cache live data/auth)
//   • Navigations & shell/CDN assets -> cache-first, fall back to network,
//     and update the cache opportunistically.
self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // Don't interfere with non-GET or Supabase traffic.
  if (req.method !== "GET" || url.hostname.endsWith(".supabase.co")) {
    return; // browser handles it normally
  }

  // Map-tile images: cache opportunistically (nice for revisiting an area).
  const isTile = url.hostname.endsWith("tile.openstreetmap.org");

  event.respondWith(
    caches.match(req).then((cached) => {
      const network = fetch(req)
        .then((res) => {
          if (res && res.status === 200 && (isTile || url.origin === location.origin || SHELL.includes(req.url))) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy));
          }
          return res;
        })
        .catch(() => cached); // offline: serve cache if we have it
      return cached || network;
    })
  );
});