const CACHE_VERSION = "esperanto-mobile-pwa-2026-09-06-phrases-2";
const APP_CACHE = `${CACHE_VERSION}:app`;
const RUNTIME_CACHE = `${CACHE_VERSION}:runtime`;
const RUNTIME_CACHE_MAX_ENTRIES = 400;

const APP_SHELL = [
  "./mobile_app/index.html",
  "./mobile_app/styles.css?v=2026-09-06-phrases-2",
  "./mobile_app/app.js",
  "./mobile_app/quiz_core.mjs",
  "./mobile_app/quiz_questions.mjs",
  "./mobile_app/learning_sync.mjs",
  "./mobile_app/legacy_session_migration.mjs",
  "./mobile_app/manifest.webmanifest",
  "./mobile_app/icon.svg",
  "./mobile_app/data/vocab.json",
  "./mobile_app/data/sentences.json",
  "./mobile_app/data/audio_manifest.json",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(APP_CACHE)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys
          .filter((key) => key.startsWith("esperanto-mobile-pwa-") && !key.startsWith(CACHE_VERSION))
          .map((key) => caches.delete(key)),
      ))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") {
    return;
  }
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) {
    return;
  }

  if (
    url.pathname.endsWith("/vocab.json")
    || url.pathname.endsWith("/sentences.json")
    || url.pathname.endsWith("/audio_manifest.json")
  ) {
    event.respondWith(networkFirst(request));
    return;
  }

  if (url.pathname.endsWith(".wav") || url.pathname.endsWith(".mp3") || url.pathname.endsWith(".ogg")) {
    event.respondWith(cacheFirst(request, RUNTIME_CACHE));
    return;
  }

  if (url.pathname.includes("/mobile_app/") || url.pathname.endsWith("/mobile-sw.js")) {
    event.respondWith(networkFirst(request));
  }
});

async function cacheFirst(request, cacheName) {
  const cached = await caches.match(request);
  if (cached) {
    return cached;
  }
  const response = await fetch(request);
  if (response.ok) {
    const cache = await caches.open(cacheName);
    await cache.put(request, response.clone());
    await trimCache(cacheName, RUNTIME_CACHE_MAX_ENTRIES);
  }
  return response;
}

async function trimCache(cacheName, maxEntries) {
  const cache = await caches.open(cacheName);
  const keys = await cache.keys();
  if (keys.length <= maxEntries) {
    return;
  }
  await Promise.all(keys.slice(0, keys.length - maxEntries).map((key) => cache.delete(key)));
}

async function networkFirst(request) {
  const cache = await caches.open(APP_CACHE);
  try {
    const response = await fetch(request);
    if (response.ok) {
      cache.put(request, response.clone());
    }
    return response;
  } catch (error) {
    const cached = await cache.match(request);
    if (cached) {
      return cached;
    }
    // The first visit precedes worker activation, so its directory/query URL
    // may never have been cached. Both entry URLs use the installed app shell.
    if (request.mode === "navigate") {
      const indexUrl = new URL("./mobile_app/index.html", self.location.href);
      const requestPath = new URL(request.url).pathname;
      const directoryPath = indexUrl.pathname.slice(0, -"index.html".length);
      if (requestPath === directoryPath || requestPath === indexUrl.pathname) {
        const shell = await cache.match(indexUrl.href);
        if (shell) return shell;
      }
    }
    throw error;
  }
}
