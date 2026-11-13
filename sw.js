// Kitchen Master service worker. Classic script (Safari support), relative URLs only.
// CI replaces the VERSION line below with the git SHA on deploy (.github/workflows/deploy.yml),
// so every deploy gets a new cache and a byte-different sw.js that triggers an update.
const VERSION = "3c672f72e01bff16d05ca68c796f40a52f2a96de";

importScripts("./precache.js");

/** @type {ServiceWorkerGlobalScope} */
const sw = /** @type {any} */ (self);
/** @type {string[]} */
const PRECACHE = /** @type {any} */ (self).PRECACHE;
const CACHE = "km-" + VERSION;
// Recipes come from the public kitchen-recipes repo and change independently of the app, so they
// live in their own cache that survives app updates (the activate step keeps it).
const RECIPE_CACHE = "km-recipes";
const SCOPE = sw.registration.scope;
const SHELL = new URL("index.html", SCOPE).href;
const RECIPES = new URL("recipes/", SCOPE).href;
// Schema 2 lives in recipes/v2/ (CP3); recipes/*.json stay published for older app versions.
const RECIPE_DIR = new URL("v2/", RECIPES).href;
const RECIPE_INDEX = new URL("index.json", RECIPE_DIR).href;
// With a cached copy at hand, a slow network ("lie-fi") falls back to it after this long.
const NETWORK_TIMEOUT_MS = 4000;

sw.addEventListener("install", event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await Promise.all(PRECACHE.map(async path => {
      // Bypass the HTTP cache so a new version never mixes in stale files.
      const res = await fetch(new Request(path, { cache: "reload" }));
      if (!res.ok) throw new Error("precache failed: " + path + " " + res.status);
      // Safari refuses redirected responses for navigations; store a clean copy.
      const clean = res.redirected
        ? new Response(await res.blob(), { status: res.status, statusText: res.statusText, headers: res.headers })
        : res;
      await cache.put(path, clean);
    }));
    // Best effort: a failure here must never fail the install (the app shell matters most).
    await cacheRecipes();
  })());
  // No skipWaiting here: an update waits until no page uses the old version (plan R10).
});

/**
 * Recipe file URLs listed by a parsed index.json (relative to recipes/v2/; only ones inside it).
 * @param {any} index
 * @returns {string[]}
 */
function listedFiles(index) {
  if (!index || !Array.isArray(index.recipes)) return [];
  return index.recipes
    .map((/** @type {any} */ e) => e && e.file)
    .filter((/** @type {unknown} */ f) => typeof f === "string")
    .map((/** @type {string} */ f) => new URL(f, RECIPE_DIR).href)
    .filter((/** @type {string} */ url) => url.startsWith(RECIPE_DIR)); // never cache outside recipes/v2/
}

/**
 * Store a fresh index.json only once every file it lists is in the recipe cache, fetching the
 * missing ones first. Otherwise the cached index stays as it was: the app loads recipes as a whole,
 * so an index naming a file the cache lacks would hide every recipe offline. Never throws.
 * @param {Response} res a fresh, ok index.json response (not yet read)
 * @returns {Promise<boolean>} whether the index was stored
 */
async function storeIndex(res) {
  try {
    const files = listedFiles(await res.clone().json());
    const cache = await caches.open(RECIPE_CACHE);
    const got = await Promise.allSettled(files.map(async url => {
      if (await cache.match(url)) return;
      const r = await fetch(url);
      if (!r.ok) throw new Error("recipe fetch failed: " + url + " " + r.status);
      await cache.put(url, r);
    }));
    if (got.some(g => g.status === "rejected")) return false;
    await cache.put(RECIPE_INDEX, res);
    return true;
  } catch (err) {
    console.warn("Kitchen Master: recipe index not cached", err);
    return false;
  }
}

/**
 * Download recipes/v2/index.json and every recipe it lists into the recipe cache. Never throws.
 * @returns {Promise<void>}
 */
async function cacheRecipes() {
  try {
    const res = await fetch(new Request(RECIPE_INDEX, { cache: "reload" }));
    if (!res.ok) return;
    // Install refreshes every file (a new app version may come with edited recipes); the index
    // replaces the cached one only when all its files made it.
    const files = listedFiles(await res.clone().json());
    const cache = await caches.open(RECIPE_CACHE);
    await Promise.allSettled(files.map(async url => {
      const r = await fetch(new Request(url, { cache: "reload" }));
      if (r.ok) await cache.put(url, r);
    }));
    await storeIndex(res);
  } catch (err) {
    console.warn("Kitchen Master: recipes not cached on install", err);
  }
}

sw.addEventListener("activate", event => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names
      .filter(n => n.startsWith("km-") && n !== CACHE && n !== RECIPE_CACHE)
      .map(n => caches.delete(n)));
    await sw.clients.claim();
  })());
});

// Only a page can ask a waiting worker to take over (the "Update ready" tap, shown on Library only
// when no timer runs). "version" answers on the given port (Settings shows it).
sw.addEventListener("message", event => {
  if (event.data === "skipWaiting") sw.skipWaiting();
  else if (event.data === "version" && event.ports && event.ports[0]) event.ports[0].postMessage({ version: VERSION });
});

sw.addEventListener("fetch", event => {
  const req = event.request;
  if (req.method !== "GET") return;
  if (new URL(req.url).origin !== sw.location.origin) return;
  event.respondWith(req.url.startsWith(RECIPES) ? recipe(req, event) : respond(req));
});

/**
 * Recipes: network first so edits show up, cached copy when offline (stale is fine).
 * A fresh index.json is cached only after its files are (storeIndex), in the background.
 * @param {Request} req
 * @param {FetchEvent} event
 * @returns {Promise<Response>}
 */
async function recipe(req, event) {
  const cache = await caches.open(RECIPE_CACHE);
  const cached = await cache.match(req, { ignoreSearch: true });
  const ctrl = new AbortController();
  const timer = cached ? setTimeout(() => ctrl.abort(), NETWORK_TIMEOUT_MS) : undefined;
  try {
    const res = await fetch(req.url, { signal: ctrl.signal });
    if (res.ok) {
      if (req.url.split("?")[0] === RECIPE_INDEX) event.waitUntil(storeIndex(res.clone()));
      else await cache.put(req.url, res.clone());
      return res;
    }
    return cached || res;
  } catch (err) {
    if (cached) return cached;
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Cache first for precached files; navigations fall back to the cached shell when offline.
 * @param {Request} req
 * @returns {Promise<Response>}
 */
async function respond(req) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(req, { ignoreSearch: true });
  if (hit) {
    // Safari's media stack loads <audio src> (audio/beep3.wav) with Range requests and needs
    // 206 Partial Content back; a whole-file 200 from a worker can make the load fail.
    const range = req.headers && req.headers.get("range");
    return range ? partial(hit, range) : hit;
  }
  try {
    return await fetch(req);
  } catch (err) {
    if (req.mode === "navigate") {
      const shell = await cache.match(SHELL);
      if (shell) return shell;
    }
    throw err;
  }
}

/**
 * Answer a Range request from a cached response: 206 with the requested bytes, or 416 when the
 * range cannot be satisfied. Only single "bytes=" ranges are supported (what media elements send);
 * anything else gets the whole file.
 * @param {Response} res cached response
 * @param {string} header the Range header
 * @returns {Promise<Response>}
 */
async function partial(res, header) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (m[1] === "" && m[2] === "")) return res;
  const body = await res.arrayBuffer();
  const size = body.byteLength;
  let start, end;
  if (m[1] === "") { // suffix: the last N bytes
    const n = Number(m[2]);
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  const type = res.headers.get("content-type") || "application/octet-stream";
  if (start >= size || start > end || size === 0) {
    return new Response(null, { status: 416, headers: { "Content-Range": "bytes */" + size } });
  }
  return new Response(body.slice(start, end + 1), {
    status: 206,
    statusText: "Partial Content",
    headers: {
      "Content-Type": type,
      "Content-Range": `bytes ${start}-${end}/${size}`,
      "Content-Length": String(end - start + 1),
      "Accept-Ranges": "bytes",
    },
  });
}
