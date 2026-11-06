/* Service worker de la version Firebase : garde l'écran de l'appli et les modules Firebase sur l'appareil.
   Les compteurs et relevés eux-mêmes sont gardés par Firebase (copie locale), pas ici. */
const CACHE = "compteurs-fb-v2";
const FBV = "10.14.1";
const SHELL = ["./", "index.html", "metier.js", "manifest.webmanifest", "icons/icon-192.png", "icons/icon-512.png", "icons/apple-touch-icon.png", "icons/icon.svg",
  `https://www.gstatic.com/firebasejs/${FBV}/firebase-app.js`,
  `https://www.gstatic.com/firebasejs/${FBV}/firebase-auth.js`,
  `https://www.gstatic.com/firebasejs/${FBV}/firebase-firestore.js`];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => Promise.all(SHELL.map(u => c.add(u).catch(() => {})))).then(() => self.skipWaiting()));
});

self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k.startsWith("compteurs-fb-") && k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener("fetch", e => {
  if (e.request.method !== "GET") return;
  const url = new URL(e.request.url);
  // Modules Firebase (versionnés, ne changent jamais) : copie gardée d'abord
  if (url.hostname === "www.gstatic.com" && url.pathname.startsWith("/firebasejs/")) {
    e.respondWith(caches.match(e.request).then(r => r || fetch(e.request).then(res => {
      const copy = res.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); return res;
    })));
    return;
  }
  if (url.origin !== location.origin) return; // Firebase et script Google : réseau direct
  // Pages de l'appli : réseau d'abord (version à jour), sinon la copie gardée
  e.respondWith(
    fetch(e.request).then(res => {
      const copy = res.clone();
      caches.open(CACHE).then(c => c.put(e.request, copy));
      return res;
    }).catch(() => caches.match(e.request).then(r => r || caches.match("index.html")))
  );
});
