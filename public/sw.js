// Commons-Bluetooth service worker — caches the app shell so it installs and
// opens with no network at all. The API is the node on this device, so it is
// never cached and always answers from (or waits for) the local process.
//
// Bump CACHE whenever the shell changes so installed clients drop the old copy.
const CACHE = "commons-bluetooth-v3";
const SHELL = [
  "./", "index.html", "app.js", "lucide.js",
  "manifest.webmanifest", "icon.svg",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== self.location.origin) return;
  // Never cache the local node's API.
  if (url.pathname.startsWith("/api/")) {
    e.respondWith(fetch(e.request).catch(() => new Response("null", { headers: { "Content-Type": "application/json" } })));
    return;
  }
  // Network-first so a rebuilt shell is picked up immediately, cache as the
  // fallback for when the local node is not running yet.
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy)).catch(() => {});
        }
        return res;
      })
      .catch(() => caches.match(e.request))
  );
});
