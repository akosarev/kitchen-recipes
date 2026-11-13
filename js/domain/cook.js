// The cook screen's model (docs/v0-plan.md sections 8 and 11, CP5). Pure: `now` is passed in.
//
// `resolveCook` turns a frozen plan back into recipes (the picks adapted with the frozen toggles)
// and the text of every step. `cookView` reads the session and says what the screen shows: one
// clock per dish, the waits that are running, the step to do now, what comes next, how far behind
// the cook is.
//
// A plan step is in one of three states:
// - done: its key is in session.done;
// - waiting: a passive step whose timer is running or ringing (it ends when the alarm is
//   acknowledged);
// - pending: everything else. A pending step is "ready" when every step it comes after is done.
// The current step is only the highlighted default: any ready step can be done out of order.
import { adapt } from "./adapt.js";
import { amounts, names, fill } from "./scale.js";
import { timerView, verbFor } from "../timer/engine.js";

/** A ready step becomes the current one this long before its planned start. */
export const DUE_LEAD_MS = 60_000;

/** @typedef {import('../types').CookPlan} CookPlan */
/** @typedef {import('../types').PlannedStep} PlannedStep */
/** @typedef {import('../types').Recipe} Recipe */
/** @typedef {import('../types').Step} Step */
/** @typedef {import('../types').Timer} Timer */

/**
 * @typedef {{ key: string, title: string, cls: string, dish: boolean }} Lane
 * @typedef {{ step: Step, recipe: Recipe, text: string, sub: string[], lane: Lane, after: string[] }} StepInfo
 * @typedef {{ kind: 'ok', info: Map<string, StepInfo>, lanes: Lane[], recipes: Recipe[], startAt: number }
 *   | { kind: 'stale' }} Cook
 */

/**
 * The frozen plan's recipes and step texts. `stale` when the plan cannot be shown as it was frozen:
 * a recipe is gone or hidden, or a planned step no longer exists.
 * @param {CookPlan} plan
 * @param {Recipe[]} recipes the library
 * @returns {Cook}
 */
export function resolveCook(plan, recipes) {
  if (!plan.picks || !plan.toggles || !plan.setup) return { kind: "stale" };
  /** @type {Map<string, StepInfo>} */
  const info = new Map();
  /** @type {Lane[]} */
  const lanes = [];
  /** @type {Recipe[]} */
  const out = [];
  /** @type {{ r: Recipe, i: number }[]} */
  const shared = [];
  let color = 0;
  for (const [i, pick] of plan.picks.entries()) {
    const src = recipes.find(r => r.id === pick.recipeId);
    if (!src) return { kind: "stale" };
    const ad = adapt(src, /** @type {import('../types').Toggle[]} */ (plan.toggles));
    if (ad.kind !== "ok") return { kind: "stale" };
    const r = ad.recipe;
    out.push(r);
    const a = amounts(r, pick.servings), n = names(r);
    for (const l of ad.lines.flat()) if (l.status.kind === "omitted") { a[l.item.k] = "left out"; n[l.item.k] = l.item.short ?? l.item.n; }
    /** @type {Map<string, Lane>} */
    const own = new Map();
    for (const d of r.dishes) {
      const lane = { key: r.id + "/" + d.id, title: d.title, cls: "d" + color++, dish: true };
      own.set(d.id, lane);
      lanes.push(lane);
    }
    if (r.steps.some(s => !own.has(s.dish))) {
      const lane = { key: r.id + "/shared", title: "Shared prep", cls: "shared", dish: false };
      own.set("shared", lane);
      lanes.push(lane);
      shared.push({ r, i });
    }
    for (const s of r.steps) {
      info.set(r.id + "/" + s.id, {
        step: s, recipe: r, text: fill(s.t, a, n), sub: (s.sub || []).map(x => fill(x, a, n)),
        lane: /** @type {Lane} */ (own.get(s.dish) ?? own.get("shared")),
        after: s.after.map(id => r.id + "/" + id),
      });
    }
  }
  if (shared.length > 1) for (const { r, i } of shared) { const l = lanes.find(x => x.key === r.id + "/shared"); if (l) l.title = `Shared prep ${i + 1}`; }
  if (plan.steps.some(p => !info.has(p.key))) return { kind: "stale" };
  return { kind: "ok", info, lanes, recipes: out, startAt: plan.serveAt - plan.totalMs };
}

/**
 * What holding a step does: a passive step with a timer starts its wait; any other step is done.
 * @param {PlannedStep} p
 * @param {Step} step
 * @returns {'timer' | 'done'}
 */
export const holdAction = (p, step) => (p.hands === "passive" && step.timer ? "timer" : "done");

/**
 * @typedef {{ p: PlannedStep, info: StepInfo, at: number, ready: boolean, tight: boolean,
 *   action: 'timer' | 'done', timer: Timer | null }} Row
 * @typedef {{ lane: Lane, kind: 'timer', key: string, timer: Timer, view: ReturnType<typeof timerView>, verb: string }
 *   | { lane: Lane, kind: 'next', inMs: number, row: Row }
 *   | { lane: Lane, kind: 'done' }} DishClock
 * @typedef {{
 *   clocks: DishClock[], waiting: Row[], current: Row | null, next: Row[], done: Row[],
 *   doneCount: number, total: number, finished: boolean, serveAt: number, startAt: number,
 *   behindMs: number, bothHands: Row | null,
 * }} CookView
 */

/**
 * @param {import('../types').CookSession} session with a plan
 * @param {Extract<Cook, { kind: 'ok' }>} cook
 * @param {number} now
 * @returns {CookView}
 */
export function cookView(session, cook, now) {
  const plan = /** @type {CookPlan} */ (session.plan);
  const { startAt, info } = cook;
  const done = session.done;
  /** @type {Map<string, Timer>} */
  const live = new Map();
  for (const t of session.timers) if (t.ackAt == null) live.set(t.key, t);
  const tightKeys = new Set(plan.warnings.filter(w => w.kind === "hands-tight").flatMap(w => w.keys));

  /**
   * @param {PlannedStep} p
   * @returns {Row}
   */
  const row = p => {
    const i = /** @type {StepInfo} */ (info.get(p.key));
    return {
      p, info: i, at: startAt + p.start, tight: tightKeys.has(p.key),
      ready: i.after.every(k => done[k] != null),
      action: holdAction(p, i.step), timer: live.get(p.key) ?? null,
    };
  };
  const rows = plan.steps.map(row);
  const isDone = (/** @type {Row} */ r) => done[r.p.key] != null;
  const isWaiting = (/** @type {Row} */ r) => !isDone(r) && r.p.hands === "passive" && !!r.timer;
  const doneRows = rows.filter(isDone);
  const waiting = rows.filter(isWaiting);
  const pending = rows.filter(r => !isDone(r) && !isWaiting(r));
  // The step that follows a finished wait goes first (the noodles are out of the pot), then plan order.
  const ready = pending.filter(r => r.ready);
  // A ready step is due once its planned start is within a minute. While something waits, a step
  // planned for later is not pushed at the cook (it can still be opened and done early); with
  // nothing running at all, the first ready step is shown so the cook never stalls.
  const due = ready.filter(r => r.at - now <= DUE_LEAD_MS);
  const current = ready.find(r => r.p.coupled && r.p.hands === "active") ?? due[0] ?? (waiting.length ? null : ready[0]) ?? null;
  const next = pending.filter(r => r !== current);

  /** @type {DishClock[]} */
  const clocks = cook.lanes.filter(l => l.dish).map(lane => {
    const mine = rows.filter(r => r.info.lane === lane);
    const timers = mine.filter(r => !isDone(r) && r.timer).map(r => ({ r, view: timerView(/** @type {Timer} */ (r.timer), now) }))
      .sort((a, b) => a.view.endAt - b.view.endAt);
    if (timers.length) {
      const { r, view } = timers[0];
      return { lane, kind: "timer", key: r.p.key, timer: /** @type {Timer} */ (r.timer), view, verb: r.info.step.then ?? verbFor(r.info.step.t) };
    }
    const todo = mine.find(r => !isDone(r));
    if (!todo) return { lane, kind: "done" };
    return { lane, kind: "next", inMs: todo.at - now, row: todo };
  });

  const finished = doneRows.length === rows.length;
  // Behind: the current step should have ended already (a wait that runs long does not count,
  // its own clock says so).
  const behindMs = current ? Math.max(0, now - (startAt + current.p.end)) : 0;
  // "Both need your hands": the next tight step of another dish than the current one.
  const bothHands = current ? next.find(r => r.tight && r.info.lane !== current.info.lane && r.at - now < 5 * 60_000) ?? null : null;
  return {
    clocks, waiting, current, next, done: doneRows, doneCount: doneRows.length, total: rows.length,
    finished, serveAt: plan.serveAt, startAt, behindMs, bothHands,
  };
}
