const CACHE_NAME = "magang-ic-v1";
const APP_SHELL = [
  "./index.html",
  "./manifest.json",
  "./style.css",
  "./app.js",
  "./db.js",
  "./icon-192.png",
  "./icon-512.png"
];

// Install: cache App Shell (Cache First untuk asset statis)
self.addEventListener("install", (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL))
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))
      )
    )
  );
  self.clients.claim();
});

// Fetch: App Shell pakai Cache First, request data ke Apps Script pakai Network First
self.addEventListener("fetch", (event) => {
  const isApiCall = event.request.url.includes("script.google.com");

  if (isApiCall) {
    event.respondWith(
      fetch(event.request).catch(
        () =>
          new Response(
            JSON.stringify({
              status: "offline",
              message: "Tersimpan lokal, akan disinkron otomatis."
            }),
            { headers: { "Content-Type": "application/json" } }
          )
      )
    );
    return;
  }

  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request).catch(() => caches.match("./index.html"));
    })
  );
});

// Background Sync: kirim ulang antrean logbook offline saat koneksi kembali
self.addEventListener("sync", (event) => {
  if (event.tag === "sync-logbook-queue") {
    event.waitUntil(broadcastSyncRequest());
  }
});

// Service worker tidak bisa akses IndexedDB app langsung dengan mudah lintas
// scope tanpa duplikasi logic, jadi minta halaman aktif yang melakukan sync
// (app.js sudah punya semua fungsi API_URL + antrian). Ini juga jalan sebagai
// fallback untuk browser yang belum dukung Background Sync API.
async function broadcastSyncRequest() {
  const clientsList = await self.clients.matchAll({ type: "window" });
  clientsList.forEach((client) => client.postMessage({ type: "SYNC_QUEUE" }));
}
