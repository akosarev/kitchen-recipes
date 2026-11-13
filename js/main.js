// Boot: register the service worker, resume any cooking session (cold start) and start the timer
// hooks, load the recipes (recipes/v2/*.json), migrate old storage keys, then start routing.
import { store, KEYS } from "./store.js";
import { startRouter } from "./router.js";
import { registerServiceWorker, watchForUpdate, applyUpdate } from "./sw-register.js";
import { loadRecipes } from "./recipes.js";
import { renderLoading, renderLoadError } from "./ui/status.js";
import { installTimerHooks, runtime } from "./timer/app.js";
import { wireChrome, paintAll, noteSaveError, setUpdateReady, onPaint, prefs } from "./ui/chrome.js";
import { paintTimerButtons } from "./ui/timer-button.js";
import { paintClock } from "./ui/clock.js";
import { paintCook } from "./ui/cook-view.js";
import { applyTheme } from "./ui/settings.js";
import { isStandalone, requestPersistOnce } from "./install.js";

const app = /** @type {HTMLElement} */ (document.getElementById("app"));

applyTheme(prefs().theme);
// Register first: on the very first visit the worker's install also caches the recipes.
const nav = globalThis.navigator;
const reg = registerServiceWorker(nav);
if (reg && nav.serviceWorker) {
  const container = nav.serviceWorker;
  reg.then(r => {
    if (!r || typeof r !== "object" || !("addEventListener" in r)) return;
    watchForUpdate(/** @type {any} */ (r), /** @type {any} */ (container), w => {
      setUpdateReady({ apply: () => applyUpdate(w, /** @type {any} */ (container), () => location.reload()) });
    });
  });
}
store.onSaveError((err, key) => { console.warn("Kitchen Master: could not save", key, err); noteSaveError(); });

// Timers first: a stored session resumes (and an alarm that came due while the app was closed
// fires once) even before the recipes arrive.
wireChrome();
onPaint(() => paintTimerButtons(app));
onPaint(() => paintClock(app));
onPaint(paintCook);
installTimerHooks(paintAll);
requestPersistOnce(/** @type {any} */ (nav).storage, store, KEYS.prefs, isStandalone(), runtime().now())
  .catch(() => {});

async function boot() {
  renderLoading(app);
  let recipes;
  try {
    recipes = await loadRecipes(url => fetch(url));
  } catch (err) {
    console.warn("Kitchen Master: recipes not loaded", err);
    renderLoadError(app, boot);
    return;
  }
  // Migration needs the recipe ids, so it runs once the recipes are known.
  store.migrateLegacy(recipes.map(r => r.id));
  startRouter(app, recipes);
}

boot();
