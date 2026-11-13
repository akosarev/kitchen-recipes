// "At a glance": the recipe's phases on a time axis, one lane per dish (two-dish recipes show both
// lanes, so the parallel cooking is visible before reading a word). Times are the author's phase
// windows ("10–25 min"); a phase without one runs for the sum of its steps. The plot is decorative
// (aria-hidden); the legend under it is the accessible version and jumps to each phase.
// CP4's plan preview replaces this with the scheduled plan for tonight's setup.
import { esc } from "./html.js";
import { icon } from "./icons.js";

/**
 * @typedef {{ i: number, t: string, window: string, start: number, end: number,
 *   dishes: Set<string>, timers: number }} PhaseSpan
 */

const WINDOW = /^(\d+)\s*[–-]\s*(\d+)\s*min$/;

/**
 * Phase spans in minutes from the start.
 * @param {import('../types').Recipe} r
 * @returns {PhaseSpan[]}
 */
export function phaseSpans(r) {
  const byId = new Map(r.steps.map(s => [s.id, s]));
  let prev = 0;
  return r.phases.map((p, i) => {
    const steps = p.stepIds.map(id => byId.get(id)).filter(s => !!s);
    const m = WINDOW.exec(p.window.trim());
    let start, end;
    if (m && +m[2] > +m[1]) { start = +m[1]; end = +m[2]; }
    else {
      start = prev;
      end = start + Math.max(1, Math.ceil(steps.reduce((a, s) => a + /** @type {import('../types').Step} */ (s).dur, 0) / 60));
    }
    prev = Math.max(prev, end);
    const dishes = new Set(steps.map(s => /** @type {import('../types').Step} */ (s).dish));
    const timers = steps.filter(s => !!s?.timer).length;
    return { i, t: p.t, window: p.window, start, end, dishes, timers };
  });
}

/** @param {number} n */
const pct = n => `${Math.round(n * 1000) / 10}%`;

/**
 * Dish colour class: d0, d1 for the recipe's dishes, "shared" for common prep.
 * @param {import('../types').Recipe} r
 * @param {string} dish
 */
const dishClass = (r, dish) => {
  const i = r.dishes.findIndex(d => d.id === dish);
  return i < 0 ? "shared" : "d" + i;
};

/**
 * The mini strip on a Library card: one bar, a segment per phase, coloured by the dishes it holds.
 * @param {import('../types').Recipe} r
 */
export function stripHtml(r) {
  const spans = phaseSpans(r);
  return `<div class="strip" aria-hidden="true">${spans.map(s => {
    const own = [...s.dishes].filter(d => d !== "shared");
    const cls = own.length > 1 ? "mix" : own.length === 1 ? dishClass(r, own[0]) : "shared";
    return `<span class="seg ${cls}" style="flex-grow:${Math.max(1, s.end - s.start)}"></span>`;
  }).join("")}</div>`;
}

/**
 * The lanes and the phase legend for the Recipe screen.
 * @param {import('../types').Recipe} r
 */
export function glanceHtml(r) {
  const spans = phaseSpans(r);
  const total = Math.max(...spans.map(s => s.end), 1);
  const two = r.dishes.length > 1;
  const lanes = r.dishes.map((d, di) => {
    const bars = spans.filter(s => s.dishes.has(d.id) || s.dishes.has("shared")).map(s => {
      const only = !s.dishes.has(d.id);
      return `<span class="gl-bar ${only ? "shared" : "d" + di}" style="left:calc(${pct(s.start / total)} + 1px);width:calc(${pct((s.end - s.start) / total)} - 2px)">${s.i + 1}</span>`;
    }).join("");
    return `<div class="gl-lane"><span class="gl-name">${two ? `<i class="dot d${di}"></i>${esc(d.title)}` : ""}</span><div class="gl-track">${bars}</div></div>`;
  }).join("");
  const step = total > 40 ? 10 : 5;
  const ticks = [];
  // Regular ticks stop short of the end label so they never overlap it.
  for (let m = 0; m < total - step * 0.6; m += step) ticks.push(`<span style="left:${pct(m / total)}">${m}</span>`);
  ticks.push(`<span class="end" style="left:100%">${total} min</span>`);
  const legend = spans.map(s => `<li><button type="button" class="gl-go" data-phase="${s.i}">`
    + `<b class="gl-num">${s.i + 1}</b><span class="gl-t">${esc(s.t)}</span>`
    + `<span class="gl-w">${esc(s.window || `${s.end - s.start} min`)}</span>`
    + (s.timers ? `<span class="gl-timers">${icon("timer")}${s.timers}<span class="sr"> timer${s.timers === 1 ? "" : "s"}</span></span>` : "")
    + `</button></li>`).join("");
  return `<section class="glance" aria-labelledby="glance-h">
    <h3 id="glance-h">At a glance</h3>
    <div class="gl-plot${two ? " two" : ""}" aria-hidden="true">${lanes}<div class="gl-lane"><span class="gl-name"></span><div class="gl-axis">${ticks.join("")}</div></div></div>
    <ol class="gl-legend">${legend}</ol>
  </section>`;
}

/**
 * Legend buttons scroll to their phase (hash links would change the route).
 * @param {ParentNode} root
 */
export function wireGlance(root) {
  root.querySelectorAll(".gl-go").forEach(el => {
    const b = /** @type {HTMLElement} */ (el);
    b.onclick = () => {
      const target = /** @type {HTMLElement | null} */ (root.querySelector(`#phase-${b.dataset.phase}`));
      if (!target) return;
      const reduce = globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
      target.scrollIntoView?.({ behavior: reduce ? "auto" : "smooth", block: "start" });
      target.focus?.({ preventScroll: true });
    };
  });
}
