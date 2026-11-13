// Tonight's plan (docs/v0-plan.md sections 8 and 9): picks + toggles + setup -> adapted recipes ->
// schedule -> CookPlan with the serve time, a "late" warning and the hash that identifies its
// inputs. Pure: `now` is passed in. The plan is frozen only by "Start cooking" (CP5).
import { adapt } from "./adapt.js";
import { schedule, ScheduleError } from "./scheduler.js";
import { fnv1a } from "../hash.js";
import { serveEpoch } from "../setup.js";

/**
 * @typedef {{ recipe: import('../types').Recipe, servings: number }} Pick
 * @typedef {{ kind: 'ok', plan: import('../types').CookPlan, recipes: import('../types').Recipe[],
 *   adapted: Extract<import('../types').Adapted, { kind: 'ok' }>[], startAt: number }
 *   | { kind: 'blocked', recipeId: string, reasons: import('../types').BlockReason[] }
 *   | { kind: 'error', error: ScheduleError }} PlanResult
 */

/**
 * Hash of everything a plan depends on: recipe ids and revisions, servings, toggles, setup and the
 * substitutions applied. Same inputs, same hash; any change, a different one (stale plan).
 * @param {Pick[]} picks
 * @param {readonly string[]} toggles
 * @param {import('../types').CookSetup} setup
 * @param {string[]} applied labels of the substitutions used
 */
export function planHash(picks, toggles, setup, applied) {
  const setupKey = [setup.burner, setup.wok, setup.pan, setup.pot, setup.oven, setup.wokFallbackPan, setup.serveAt];
  return fnv1a(JSON.stringify([picks.map(p => [p.recipe.id, p.recipe.rev, p.servings]), [...toggles].sort(), setupKey, applied]));
}

/**
 * Build tonight's plan.
 * @param {Pick[]} picks 1 or 2
 * @param {import('../types').Toggle[]} toggles
 * @param {import('../types').CookSetup} setup
 * @param {number} now epoch ms
 * @returns {PlanResult}
 */
export function buildPlan(picks, toggles, setup, now) {
  /** @type {Extract<import('../types').Adapted, { kind: 'ok' }>[]} */
  const adapted = [];
  for (const p of picks) {
    const a = adapt(p.recipe, toggles);
    if (a.kind === "blocked") return { kind: "blocked", recipeId: p.recipe.id, reasons: a.reasons };
    adapted.push(a);
  }
  let s;
  try {
    s = schedule(adapted.map(a => ({ recipe: a.recipe })), setup);
  } catch (e) {
    if (e instanceof ScheduleError) return { kind: "error", error: e };
    throw e;
  }
  const wanted = serveEpoch(setup.serveAt, now);
  const serveAt = wanted ?? now + s.totalMs;
  const startAt = serveAt - s.totalMs;
  const warnings = [...s.warnings];
  if (wanted !== null && startAt < now) {
    warnings.push({ kind: "late", at: 0, keys: [], msg: "Too late for that time: serve ASAP or later" });
  }
  const labels = adapted.flatMap(a => a.labels);
  return {
    kind: "ok",
    recipes: adapted.map(a => a.recipe),
    adapted,
    startAt,
    plan: {
      hash: planHash(picks, toggles, setup, labels),
      frozenAt: 0,
      totalMs: s.totalMs,
      serveAt,
      steps: s.steps,
      warnings,
      adaptations: adapted.map((a, i) => ({ recipeId: picks[i].recipe.id, labels: a.labels, checks: a.checks })),
    },
  };
}
