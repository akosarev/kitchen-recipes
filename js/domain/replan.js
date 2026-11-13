// "I'm behind" (docs/v0-plan.md section 9, Replan). Pure: `now` is passed in.
//
// - Done steps keep their times.
// - Pinned steps keep theirs too: a wait whose timer is running cannot move (the tofu is already
//   under the weight). Its interval is the timer's real one.
// - Every other step is scheduled again, with the same scheduler, from `now` on. The serve time is
//   the earliest S = old serve + k × 30 s (k = 0..120) at which the rest fits: nothing starts
//   before now, nothing starts before a pinned wait it depends on has ended, and the equipment a
//   pinned wait holds is never needed twice.
// The plan's start stays where it was, so its total grows by the same shift as the serve time.
import { schedule, needsOf, byKey, ScheduleError } from "./scheduler.js";
import { timerView } from "../timer/engine.js";

/** Serve time moves in steps of this. */
export const REPLAN_STEP_MS = 30_000;
/** Most the serve time moves in one replan: 60 minutes. */
export const REPLAN_MAX_STEPS = 120;

/** @typedef {import('../types').CookPlan} CookPlan */
/** @typedef {import('../types').PlannedStep} PlannedStep */
/** @typedef {import('../types').Equipment} Equipment */

/**
 * @typedef {{ kind: 'ok', plan: CookPlan, shiftMs: number } | { kind: 'error', message: string }} Replan
 */

/**
 * @param {import('../types').CookSession} session with a plan
 * @param {Extract<import('./cook.js').Cook, { kind: 'ok' }>} cook the plan's resolved recipes
 * @param {number} now epoch ms
 * @returns {Replan}
 */
export function replan(session, cook, now) {
  const plan = /** @type {CookPlan} */ (session.plan);
  const setup = /** @type {import('../types').CookSetup} */ (plan.setup);
  const startAt = cook.startAt;
  const nowRel = Math.max(0, now - startAt);

  /** @type {Map<string, PlannedStep>} steps that keep their place */
  const fixed = new Map();
  /** @type {{ key: string, start: number, end: number, needs: Partial<Record<Equipment, number>> }[]} */
  const pinned = [];
  for (const p of plan.steps) {
    if (session.done[p.key] != null) { fixed.set(p.key, p); continue; }
    const t = session.timers.find(x => x.key === p.key && x.ackAt == null);
    if (p.hands !== "passive" || !t) continue;
    // A ringing wait ends now at the earliest: its pot is busy until the alarm is acknowledged.
    const end = Math.max(timerView(t, now).endAt - startAt, nowRel);
    const start = Math.min(Math.max(0, t.startedAt - startAt), end);
    fixed.set(p.key, { ...p, start, end });
    pinned.push({ key: p.key, start, end, needs: needsOf(/** @type {import('./cook.js').StepInfo} */ (cook.info.get(p.key)).step, setup) });
  }

  // The recipes without the fixed steps (and without the edges that pointed at them).
  const picks = cook.recipes.map(r => ({
    recipe: {
      ...r,
      steps: r.steps.filter(s => !fixed.has(r.id + "/" + s.id))
        .map(s => ({ ...s, after: s.after.filter(id => !fixed.has(r.id + "/" + id)) })),
    },
  })).filter(p => p.recipe.steps.length);

  const keep = [...fixed.values()];
  const lastFixed = Math.max(0, ...keep.map(p => p.end));
  if (!picks.length) {
    // Nothing left to place: the plan only has to be long enough for the waits that are running.
    const totalMs = Math.max(plan.totalMs, lastFixed);
    const shiftMs = totalMs - plan.totalMs;
    return { kind: "ok", shiftMs, plan: { ...plan, totalMs, serveAt: plan.serveAt + shiftMs, steps: keep.sort(order) } };
  }

  let s;
  try {
    s = schedule(picks, setup);
  } catch (e) {
    if (e instanceof ScheduleError) return { kind: "error", message: e.message };
    throw e;
  }
  /** @type {Map<string, Partial<Record<Equipment, number>>>} */
  const needs = new Map();
  /** @type {Map<string, number>} earliest start (ms from plan start) a pinned predecessor allows */
  const notBefore = new Map();
  for (const p of s.steps) {
    const i = /** @type {import('./cook.js').StepInfo} */ (cook.info.get(p.key));
    needs.set(p.key, needsOf(i.step, setup));
    const ends = pinned.filter(x => i.after.includes(x.key)).map(x => x.end);
    if (ends.length) notBefore.set(p.key, Math.max(...ends));
  }
  const cap = /** @type {Record<string, number>} */ (/** @type {unknown} */ (setup));

  /** @param {number} base offset of the new schedule from the plan start */
  const fits = base => {
    if (base < nowRel) return false;
    for (const p of s.steps) if (base + p.start < (notBefore.get(p.key) ?? 0)) return false;
    for (const pin of pinned) {
      // Equipment only changes when a step starts: check there and at the pin's own start.
      const points = [Math.max(pin.start, nowRel), ...s.steps.map(p => base + p.start).filter(t => t > pin.start && t < pin.end)];
      for (const t of points) {
        /** @type {Record<string, number>} */
        const use = {};
        for (const x of pinned) if (x.start <= t && t < x.end) for (const [k, v] of Object.entries(x.needs)) use[k] = (use[k] || 0) + (v || 0);
        for (const p of s.steps) {
          if (base + p.start <= t && t < base + p.end) for (const [k, v] of Object.entries(needs.get(p.key) || {})) use[k] = (use[k] || 0) + (v || 0);
        }
        for (const [k, v] of Object.entries(use)) if (v > (cap[k] ?? 0)) return false;
      }
    }
    return true;
  };

  for (let k = 0; k <= REPLAN_MAX_STEPS; k++) {
    const shiftMs = k * REPLAN_STEP_MS;
    const totalMs = plan.totalMs + shiftMs;
    const base = totalMs - s.totalMs;
    if (totalMs < lastFixed || !fits(base)) continue;
    const steps = [...keep, ...s.steps.map(p => ({ ...p, start: base + p.start, end: base + p.end }))].sort(order);
    const warnings = s.warnings.map(w => ({ ...w, at: base + w.at }));
    return { kind: "ok", shiftMs, plan: { ...plan, totalMs, serveAt: plan.serveAt + shiftMs, steps, warnings } };
  }
  return { kind: "error", message: "the rest does not fit within an hour of the old serve time" };
}

/**
 * @param {PlannedStep} a
 * @param {PlannedStep} b
 */
const order = (a, b) => a.start - b.start || a.end - b.end || byKey(a.key, b.key);
