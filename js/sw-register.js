// Service worker registration, kept apart from main.js so it can be unit-tested.

/**
 * Options for navigator.serviceWorker.register. updateViaCache "none": the browser must
 * revalidate sw.js and its importScripts (precache.js) with the server, never the HTTP cache.
 * GitHub Pages sends max-age=600; without this a new worker could install with the previous
 * precache list for up to 10 minutes after a deploy.
 */
export const SW_OPTIONS = /** @type {const} */ ({ updateViaCache: "none" });

/**
 * Register ./sw.js when service workers are supported. Relative URL: the scope is the folder that
 * holds index.html (e.g. /kitchen-recipes/ on Pages).
 * @param {{ serviceWorker?: { register(url: string, opts?: RegistrationOptions): Promise<unknown> } } | undefined} nav
 * @returns {Promise<unknown> | null}
 */
export function registerServiceWorker(nav) {
  if (!nav || !nav.serviceWorker) return null;
  return nav.serviceWorker.register("./sw.js", SW_OPTIONS)
    .catch(err => console.warn("Kitchen Master: service worker not registered", err));
}

/**
 * @typedef {{ state: string, postMessage(m: unknown): void, addEventListener(t: 'statechange', fn: () => void): void }} WorkerLike
 * @typedef {{ waiting: WorkerLike | null, installing: WorkerLike | null, addEventListener(t: 'updatefound', fn: () => void): void }} RegistrationLike
 * @typedef {{ controller: unknown, addEventListener(t: 'controllerchange', fn: () => void, o?: { once?: boolean }): void }} ContainerLike
 */

/**
 * Call `onReady(worker)` when a new service worker version is installed and waiting (plan R10).
 * The worker never takes over by itself: the page shows "Update ready" (Library, not cooking) and
 * applyUpdate() runs only on that tap. The first install (no controller yet) is not an update.
 * @param {RegistrationLike} reg
 * @param {ContainerLike} container navigator.serviceWorker
 * @param {(worker: WorkerLike) => void} onReady
 */
export function watchForUpdate(reg, container, onReady) {
  /** @param {WorkerLike | null} w */
  const follow = w => {
    if (!w) return;
    w.addEventListener("statechange", () => {
      if (w.state === "installed" && container.controller) onReady(w);
    });
  };
  if (reg.waiting && container.controller) onReady(reg.waiting);
  follow(reg.installing); // an update already installing when the page loaded
  reg.addEventListener("updatefound", () => follow(reg.installing));
}

/**
 * Ask the waiting worker to take over, then reload once it controls the page.
 * @param {WorkerLike} worker
 * @param {ContainerLike} container
 * @param {() => void} reload
 */
export function applyUpdate(worker, container, reload) {
  container.addEventListener("controllerchange", () => reload(), { once: true });
  worker.postMessage("skipWaiting");
}
