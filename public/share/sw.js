// Share offline shell — scope: /share/

const CACHE = "share-shell-v1";
const SHELL = [
  "/share/",
  "/share/manifest.webmanifest",
  "/avatar.png",
  "/favicon-192.png",
  "/icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))),
    ).then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  if (
    req.mode === "navigate" ||
    (url.origin === self.location.origin &&
      (url.pathname === "/share/" || url.pathname === "/share/index.html"))
  ) {
    event.respondWith(
      caches.open(CACHE).then((cache) =>
        cache.match("/share/").then((cached) => {
          const network = fetch(req).then((res) => {
            if (res && res.status === 200) cache.put("/share/", res.clone());
            return res;
          }).catch(() => cached);
          return cached || network;
        }),
      ),
    );
    return;
  }

  if (url.origin === self.location.origin) {
    event.respondWith(
      caches.match(req).then((cached) =>
        cached || fetch(req).then((res) => {
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

  event.respondWith(
    fetch(req).then((res) => {
      if (res && res.status === 200 && res.type === "basic") {
        const clone = res.clone();
        caches.open(CACHE).then((c) => c.put(req, clone));
      }
      return res;
    }).catch(() => caches.match(req)),
  );
});
