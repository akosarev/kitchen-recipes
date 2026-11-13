// Shared pieces of the Tonight -> Setup -> Plan flow (docs/v0-plan.md section 8): the draft state
// in km.v1.tonight and km.v1.lastSetup, and the step indicator at the top of each screen.
import { esc } from "./html.js";
import { store, KEYS, isServings } from "../store.js";
import { readPicks, writePicks } from "../tonight.js";
import { cleanSetup, DEFAULT_SETUP } from "../setup.js";
import { runtime } from "../timer/app.js";

/** Most recipes cooked together in v0. */
export const MAX_PICKS = 2;

/** Tonight's picks. */
export const currentPicks = () => readPicks(store, KEYS.tonight, runtime().now());

/** @param {import('../types').Tonight['picks']} picks */
export const savePicks = picks => writePicks(store, KEYS.tonight, picks, runtime().now());

/** The saved setup, or null when none was saved (or it is unreadable). */
export const savedSetup = () => cleanSetup(store.get(KEYS.lastSetup, null));

/** The setup to start from: the saved one, else the default. */
export const startSetup = () => savedSetup() ?? { ...DEFAULT_SETUP };

/** @param {import('../types').CookSetup} s */
export const saveSetup = s => store.set(KEYS.lastSetup, s);

/**
 * The servings a recipe was last shown with (the reading view's stepper), else its base.
 * @param {import('../types').Recipe} r
 */
export function lastServings(r) {
  const v = store.get(KEYS.servings(r.id), r.base);
  return isServings(v) ? v : r.base;
}

/**
 * Picks resolved to recipes (picks whose recipe no longer exists are dropped).
 * @param {import('../types').Recipe[]} recipes
 */
export function pickedRecipes(recipes) {
  return currentPicks().flatMap(p => {
    const recipe = recipes.find(r => r.id === p.recipeId);
    return recipe ? [{ recipe, servings: p.servings }] : [];
  });
}

/**
 * The step indicator: Tonight, Setup, Plan.
 * @param {1 | 2 | 3} at
 */
export function flowNav(at) {
  const steps = [["#/tonight", "Tonight"], ["#/setup", "Setup"], ["#/plan", "Plan"]];
  return `<nav class="flow-nav" aria-label="Steps">${steps.map(([href, label], i) => {
    const n = i + 1;
    const cur = n === at ? ' aria-current="step"' : "";
    return `<a href="${href}" class="flow-step${n === at ? " cur" : n < at ? " done" : ""}"${cur}><b>${n}</b>${esc(label)}</a>`;
  }).join("")}</nav>`;
}
