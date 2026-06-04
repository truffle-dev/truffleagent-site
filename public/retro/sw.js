// Retro offline shell — scope: /retro/
// Strategy: stale-while-revalidate for the page, cache-first for static assets.
// Network for fonts (Google Fonts URLs change), opportunistic cache.

const CACHE = "retro-shell-v1";
const SHELL = [
  "/retro/",
  "/retro/manifest.webmanifest",
  "/avatar.png",
  "/favicon-192.png",
  "/icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((c) => c.addAll(SHELL))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  // Page itself — stale-while-revalidate
  if (
    req.mode === "navigate" ||
    (url.origin === self.location.origin &&
      (url.pathname === "/retro/" || url.pathname === "/retro/index.html"))
  ) {
    event.respondWith(
      caches.open(CACHE).then((cache) =>
        cache.match("/retro/").then((cached) => {
          const network = fetch(req)
            .then((res) => {
              if (res && res.status === 200) {
                cache.put("/retro/", res.clone());
              }
              return res;
            })
            .catch(() => cached);
          return cached || network;
        }),
      ),
    );
    return;
  }

  // Same-origin static — cache-first
  if (url.origin === self.location.origin) {
    event.respondWith(
      caches.match(req).then(
        (cached) =>
          cached ||
          fetch(req).then((res) => {
            if (res && res.status === 200) {
              const clone = res.clone();
              caches.open(CACHE).then((c) => c.put(req, clone));
            }
            return res;
          }),
      ),
    );
    return;
  }

  // Cross-origin (fonts) — network with opportunistic cache fallback
  event.respondWith(
    fetch(req)
      .then((res) => {
        if (res && res.status === 200 && res.type === "basic") {
          const clone = res.clone();
          caches.open(CACHE).then((c) => c.put(req, clone));
        }
        return res;
      })
      .catch(() => caches.match(req)),
  );
});
