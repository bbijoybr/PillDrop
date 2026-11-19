/* PillDrop service worker: makes the app open offline.
   Bump VERSION whenever you upload a new index.html so phones refresh the cache. */
var VERSION = "pilldrop-v6";
var CORE = ["./", "manifest.webmanifest", "icon-192.png", "icon-512.png", "icon-maskable-512.png"];

self.addEventListener("install", function (e) {
  e.waitUntil(caches.open(VERSION).then(function (c) { return c.addAll(CORE); }).then(function () { return self.skipWaiting(); }));
});

self.addEventListener("activate", function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.filter(function (k) { return k !== VERSION; }).map(function (k) { return caches.delete(k); }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener("fetch", function (e) {
  var req = e.request;
  if (req.method !== "GET") return;
  var url = new URL(req.url);
  if (url.origin !== location.origin) return;            /* AI / maps / other sites: always network */

  if (req.mode === "navigate") {                           /* page: network first, cached copy when offline */
    e.respondWith(
      fetch(req, { cache: "no-cache" }).then(function (res) {
        var copy = res.clone();
        caches.open(VERSION).then(function (c) { c.put("./", copy); });
        return res;
      }).catch(function () { return caches.match("./").then(function (r) { return r || caches.match(req); }); })
    );
    return;
  }
  e.respondWith(                                           /* files: cache first, fill cache on first use */
    caches.match(req).then(function (hit) {
      return hit || fetch(req).then(function (res) {
        if (res && res.ok) { var copy = res.clone(); caches.open(VERSION).then(function (c) { c.put(req, copy); }); }
        return res;
      });
    })
  );
});
