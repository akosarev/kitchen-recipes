// Shared "Start cooking" action (CP3, docs/ux/brief.md decision 5): builds the plan fresh one
// more time at the tap (so "serve ASAP" counts from now, not from when the screen opened), freezes
// it into the session and opens the cook screen. Used by the long road's Plan screen and the quick
// path's "Looks right?" card, so both land on exactly the same adapted plan.
import { buildPlan } from "../domain/plan.js";
import { runtime } from "../timer/app.js";
import { gated } from "./chrome.js";

/**
 * @param {{ recipe: import('../types').Recipe, servings: number }[]} picks
 * @param {import('../types').Toggle[]} toggles
 * @param {import('../types').CookSetup} setup
 * @param {() => void} onBlocked called instead of opening the cook screen when the fresh plan no
 *   longer builds (e.g. a toggle changed between render and tap); the caller re-renders itself.
 */
export function startCookingNow(picks, toggles, setup, onBlocked) {
  gated(() => {
    const at = runtime().now();
    const fresh = buildPlan(picks, toggles, setup, at);
    if (fresh.kind !== "ok") { onBlocked(); return; }
    runtime().startCooking({
      ...fresh.plan, frozenAt: at, toggles: [...toggles], setup,
      picks: picks.map(p => ({ recipeId: p.recipe.id, servings: p.servings })),
    });
    location.hash = "#/cook";
  });
}
