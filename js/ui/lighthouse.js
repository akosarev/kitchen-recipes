// Lighthouse clock (plan section 10): one arc, one huge number, one verb. With Tide Marks the clock
// is teal "cooking" before min, amber "ready" from min to max (tick at ideal), red "overdue +1:12"
// after max. Without Tide Marks: teal "running", then red "done +0:12". Every colour state also has
// a word and an icon, never colour alone. All text is escaped.
import { esc } from "./html.js";
import { timerView, clockText, overText } from "../timer/engine.js";

const R = 52;
const C = 2 * Math.PI * R;

/** @type {Record<import('../types').TimerZone, string>} */
const ICON = { cooking: "◔", running: "◔", ready: "◑", overdue: "⚠", done: "⚠", paused: "❚❚" };

/**
 * Word under the number, with the time past the end where it applies.
 * @param {import('../types').TimerView} v
 * @returns {{ icon: string, text: string }}
 */
export function zoneWord(v) {
  const over = overText(-v.remainingMs);
  switch (v.zone) {
    case "overdue": return { icon: ICON.overdue, text: "overdue +" + over };
    case "done": return { icon: ICON.done, text: "done +" + over };
    default: return { icon: ICON[v.zone], text: v.zone };
  }
}

/**
 * The one number: time left, or time past the end with a "+".
 * @param {import('../types').TimerView} v
 */
export function bigNumber(v) {
  return v.due ? "+" + overText(-v.remainingMs) : clockText(v.remainingMs);
}

/**
 * Longer than "mm:ss" ("1:39:00", "+12:34"): the big clock sets it smaller so it fits the ring.
 * @param {string} n
 */
const long = n => n.length > 5;

/** @param {number} f fraction of the circle */
const dash = f => `${(Math.max(0, Math.min(1, f)) * C).toFixed(2)} ${C.toFixed(2)}`;

/**
 * Lighthouse markup for one timer.
 * @param {import('../types').Timer} t
 * @param {number} now
 * @param {'big' | 'mini'} size
 */
export function lighthouseHtml(t, now, size) {
  const v = timerView(t, now);
  const w = zoneWord(v);
  const n = bigNumber(v);
  let band = "", tick = "";
  if (v.marks) {
    band = `<circle class="lh-band" cx="60" cy="60" r="${R}" stroke-dasharray="${dash(1 - v.marks.min)}" stroke-dashoffset="${(-v.marks.min * C).toFixed(2)}"/>`;
    const a = v.marks.ideal * 2 * Math.PI - Math.PI / 2;
    const p = (/** @type {number} */ r) => `${(60 + r * Math.cos(a)).toFixed(2)} ${(60 + r * Math.sin(a)).toFixed(2)}`;
    tick = `<path class="lh-tick" d="M ${p(R - 10)} L ${p(R + 7)}"/>`;
  }
  return `<div class="lh lh-${size} zone-${v.zone}" data-lh="${esc(t.key)}">`
    + `<svg class="lh-ring" viewBox="0 0 120 120" aria-hidden="true"><g transform="rotate(-90 60 60)">`
    + `<circle class="lh-track" cx="60" cy="60" r="${R}"/>${band}`
    + `<circle class="lh-arc" data-lh-arc cx="60" cy="60" r="${R}" stroke-dasharray="${dash(v.progress)}"/></g>${tick}</svg>`
    + `<div class="lh-face"><div class="lh-verb">${esc(t.verb || "Timer")}</div>`
    + `<div class="lh-num" data-lh-num${long(n) ? " data-long" : ""}>${esc(n)}</div>`
    // The mini clock hides the verb and word for screen readers only; its badge keeps the zone
    // icon visible, so the dock never tells "cooking" from "ready" by colour alone.
    + (size === "mini" ? `<span class="lh-badge" aria-hidden="true" data-lh-icon>${w.icon}</span>` : "")
    + `<div class="lh-word${size === "big" ? " lh-word-lg" : ""}" data-lh-word><span aria-hidden="true">${w.icon}</span> ${esc(w.text)}</div></div></div>`;
}

/**
 * Update a rendered Lighthouse in place (number, word, arc, zone class).
 * @param {Element} el the .lh element
 * @param {import('../types').Timer} t
 * @param {number} now
 */
export function paintLighthouse(el, t, now) {
  const v = timerView(t, now);
  const w = zoneWord(v);
  const zone = "zone-" + v.zone;
  if (!el.classList.contains(zone)) {
    for (const c of [...el.classList]) if (c.startsWith("zone-")) el.classList.remove(c);
    el.classList.add(zone);
  }
  const num = el.querySelector("[data-lh-num]");
  const n = bigNumber(v);
  if (num && num.textContent !== n) {
    num.textContent = n;
    num.toggleAttribute("data-long", long(n));
  }
  const icon = el.querySelector("[data-lh-icon]");
  if (icon && icon.textContent !== w.icon) icon.textContent = w.icon;
  const word = el.querySelector("[data-lh-word]");
  const wt = w.icon + " " + w.text;
  if (word && word.textContent !== wt) word.innerHTML = `<span aria-hidden="true">${w.icon}</span> ${esc(w.text)}`;
  el.querySelector("[data-lh-arc]")?.setAttribute("stroke-dasharray", dash(v.progress));
}
