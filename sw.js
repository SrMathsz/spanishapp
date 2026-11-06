const CACHE = "espanhol-v2";
const FILES = ["./", "./index.html", "./app.js", "./firebase-config.js", "./manifest.webmanifest", "./icon-192.png", "./icon-512.png"];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES)));
  self.skipWaiting();
});
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))));
  self.clients.claim();
});

async function put(req, res) { const c = await caches.open(CACHE); c.put(req, res); }

self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  // Biblioteca do Firebase: usa o cache e só vai à rede na primeira vez.
  if (url.hostname === "www.gstatic.com" && url.pathname.startsWith("/firebasejs/")) {
    e.respondWith(caches.match(req).then(hit => hit || fetch(req).then(r => { if (r.ok) put(req, r.clone()); return r; })));
    return;
  }
  // Arquivos do app: tenta a rede (pega atualizações) e cai no cache se estiver offline.
  if (url.origin === location.origin) {
    e.respondWith(fetch(req).then(r => { if (r.ok) put(req, r.clone()); return r; })
      .catch(() => caches.match(req).then(hit => hit || caches.match("./index.html"))));
  }
});
