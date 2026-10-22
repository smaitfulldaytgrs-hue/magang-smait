// Naikkan versi ini setiap kali file shell (manifest/ikon) berubah.
// index.html sendiri tidak bergantung pada versi ini: navigasi memakai network-first.
const CACHE_NAME = "magang-ic-v10";
const RUNTIME_CACHE = "magang-ic-runtime-v1"; // Alpine (unpkg) + Google Fonts
const KEEP_CACHES = [CACHE_NAME, RUNTIME_CACHE];

// Hanya file yang benar-benar ada. CSS dan JS sudah inline di index.html.
const APP_SHELL = [
  "./",
  "./index.html",
  "./manifest.json",
  "./icon-192.png",
  "./icon-512.png"
];

const API_HOSTS = ["script.google.com", "script.googleusercontent.com"];

function isApiRequest(url) {
  return API_HOSTS.some((h) => url.hostname === h || url.hostname.endsWith("." + h));
}

// Install: cache app shell satu per satu. Satu file gagal tidak boleh
// membatalkan seluruh install (addAll menolak semuanya jika satu gagal).
self.addEventListener("install", (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) =>
      Promise.allSettled(APP_SHELL.map((url) => cache.add(url)))
    )
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => KEEP_CACHES.indexOf(k) === -1).map((k) => caches.delete(k)))
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // 1) API Apps Script: network only, balas {status:"offline"} jika jaringan mati.
  if (isApiRequest(url)) {
    event.respondWith(
      fetch(req).catch(
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

  // Selain API, hanya tangani GET.
  if (req.method !== "GET") return;

  // 2) Navigasi (index.html): network-first agar update langsung sampai,
  //    cache hanya sebagai cadangan saat offline.
  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res && res.ok) {
            const copy = res.clone();
            caches.open(CACHE_NAME).then((c) => c.put(req, copy));
          }
          return res;
        })
        .catch(() =>
          caches
            .match(req, { ignoreSearch: true })
            .then((hit) => hit || caches.match("./index.html"))
            .then((hit) => hit || caches.match("./"))
        )
    );
    return;
  }

  // 3) Lintas origin (Alpine di unpkg, Google Fonts): stale-while-revalidate.
  //    Response opaque (tag <script>/<link> tanpa CORS) tetap boleh disimpan.
  if (url.origin !== self.location.origin) {
    event.respondWith(
      caches.open(RUNTIME_CACHE).then((cache) =>
        cache.match(req).then((cached) => {
          const network = fetch(req)
            .then((res) => {
              if (res && (res.ok || res.type === "opaque")) cache.put(req, res.clone());
              return res;
            })
            .catch(() => cached);
          return cached || network;
        })
      )
    );
    return;
  }

  // 4) Aset statis satu origin (manifest, ikon): cache-first.
  event.respondWith(
    caches.match(req).then((cached) => cached || fetch(req))
  );
});

// Background Sync: minta halaman aktif menjalankan sinkronisasi antrean offline.
self.addEventListener("sync", (event) => {
  if (event.tag === "sync-logbook-queue") {
    event.waitUntil(broadcastSyncRequest());
  }
});

// Service worker tidak mengakses IndexedDB app langsung; halaman aktif yang
// menjalankan syncQueue() (punya API_URL dan token sesi).
async function broadcastSyncRequest() {
  const clientsList = await self.clients.matchAll({ type: "window" });
  clientsList.forEach((client) => client.postMessage({ type: "SYNC_QUEUE" }));
}
