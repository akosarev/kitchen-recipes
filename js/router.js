// Hash routing, as on the old page: "#<recipeId>" opens a recipe, anything else shows the library.
// CP2 adds "#/settings" and "#/clock[/<timer key>]" (full-screen Lighthouse); CP4 adds the cook
// setup flow: "#/tonight", "#/setup", "#/plan"; CP5 adds "#/cook" and "#/done".
import { renderLibrary } from "./ui/library.js";
import { renderRecipe } from "./ui/recipe.js";
import { renderSettings } from "./ui/settings.js";
import { renderClock } from "./ui/clock.js";
import { renderTonight } from "./ui/tonight-view.js";
import { renderSetup } from "./ui/setup-view.js";
import { renderPlan } from "./ui/plan-view.js";
import { renderCook, renderDone } from "./ui/cook-view.js";
import { setRoute, paintAll } from "./ui/chrome.js";

/**
 * Recipe id for a location hash, or null for the library.
 * @param {string} hash
 * @param {import('./types').Recipe[]} recipes
 * @returns {import('./types').Recipe | null}
 */
export function matchRoute(hash, recipes) {
  const id = hash.replace("#", "");
  return recipes.find(x => x.id === id) || null;
}

/**
 * @typedef {{ name: 'library' } | { name: 'settings' } | { name: 'clock', key: string | null }
 *   | { name: 'tonight' } | { name: 'setup' } | { name: 'plan' } | { name: 'cook' } | { name: 'done' }
 *   | { name: 'recipe', recipe: import('./types').Recipe }} Route
 */

/**
 * @param {string} hash
 * @param {import('./types').Recipe[]} recipes
 * @returns {Route}
 */
export function parseRoute(hash, recipes) {
  if (hash === "#/settings") return { name: "settings" };
  if (hash === "#/tonight") return { name: "tonight" };
  if (hash === "#/setup") return { name: "setup" };
  if (hash === "#/plan") return { name: "plan" };
  if (hash === "#/cook") return { name: "cook" };
  if (hash === "#/done") return { name: "done" };
  const m = /^#\/clock(?:\/(.*))?$/.exec(hash);
  if (m) {
    let key = null;
    try { key = m[1] ? decodeURIComponent(m[1]) : null; } catch { key = null; }
    return { name: "clock", key };
  }
  const r = matchRoute(hash, recipes);
  return r ? { name: "recipe", recipe: r } : { name: "library" };
}

/**
 * @param {HTMLElement} app
 * @param {import('./types').Recipe[]} recipes
 */
export function startRouter(app, recipes) {
  const route = () => {
    const r = parseRoute(location.hash, recipes);
    app.onclick = app.onpointerdown = app.onpointerup = app.onpointercancel = app.onpointerleave = app.oncontextmenu = null;
    if (r.name === "recipe") { renderRecipe(app, r.recipe); window.scrollTo(0, 0); }
    else if (r.name === "settings") { renderSettings(app); window.scrollTo(0, 0); }
    else if (r.name === "clock") { renderClock(app, r.key); window.scrollTo(0, 0); }
    else if (r.name === "tonight") renderTonight(app, recipes);
    else if (r.name === "setup") renderSetup(app, recipes);
    else if (r.name === "plan") renderPlan(app, recipes);
    else if (r.name === "cook") renderCook(app, recipes);
    else if (r.name === "done") renderDone(app);
    else renderLibrary(app, recipes);
    setRoute(r.name);
    paintAll();
  };
  window.addEventListener("hashchange", route);
  route();
}
