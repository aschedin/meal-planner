/* Offline support for the phone app: every page, script and icon is cached on first visit,
   so the app opens (and works) with no signal. Bump VERSION (the build does) to ship an update. */
const VERSION = "20261110102426";
const CACHE = "meal-planner-" + VERSION;
const FILES = [
  "./", "index.html", "recipes.html", "preferences.html",
  "styles.css", "config.js", "data.js", "common.js", "week.js", "recipes.js", "preferences.js",
  "manifest.webmanifest", "icon-192.png", "icon-512.png", "icon-maskable-512.png", "apple-touch-icon.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith("meal-planner-") && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  if (new URL(req.url).origin !== self.location.origin) return; // the PDF reader (cdnjs) goes straight to the network
  event.respondWith(
    caches.match(req, { ignoreSearch: true }).then(
      (hit) => hit || fetch(req).catch(() => (req.mode === "navigate" ? caches.match("index.html") : Response.error()))
    )
  );
});