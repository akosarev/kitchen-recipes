// Inline timer buttons on the Recipe screen, painted from the timer engine (CP2). CP3: buttons carry
// the step key directly ("mie-udang/2.1"); the old "mie-udang:s:2:1" form still maps to it. Idle markup is the
// old page's ("⏱ 10:00", "Start timer 10:00"), so the reading view keeps its look. Tap: start;
// tap while running: stop (Undo for 15 s); "Done ✓" once fired; tap again to clear it.
import { runtime } from "../timer/app.js";
import { timerView, clockText } from "../timer/engine.js";
import { requestStart } from "./chrome.js";

/**
 * Engine key for a button's data-tid ("mie-udang:s:2:1" -> "mie-udang/2.1", plan step ids).
 * @param {string} tid
 */
export function tidKey(tid) {
  const m = /^(.+):s:(\d+):(\d+)$/.exec(tid);
  return m ? `${m[1]}/${m[2]}.${m[3]}` : tid;
}

/** @param {number} sec */
const mmss = sec => clockText(sec * 1000);

/**
 * @param {HTMLElement} btn
 * @param {import('../types').Timer | null} t
 * @param {number} now
 */
export function paintTimerButton(btn, t, now) {
  const sec = +(btn.dataset.sec ?? 0);
  /** @type {[string, string, string[]]} */
  let s;
  if (!t) s = ["⏱ " + mmss(sec), "Start timer " + mmss(sec), []];
  else if (t.firedAt != null) s = ["Done ✓", "Timer done, tap to reset", ["fin"]];
  else {
    const v = timerView(t, now);
    s = [(v.paused ? "❚❚ " : "■ ") + clockText(v.remainingMs), "Stop timer", v.paused ? ["run", "paused"] : ["run"]];
  }
  const [text, label, cls] = s;
  for (const c of ["run", "fin", "paused"]) btn.classList.toggle(c, cls.includes(c));
  if (btn.textContent !== text) btn.textContent = text;
  if (btn.getAttribute("aria-label") !== label) btn.setAttribute("aria-label", label);
}

/**
 * Repaint every timer button under `root`.
 * @param {ParentNode} root
 */
export function paintTimerButtons(root) {
  const btns = /** @type {HTMLElement[]} */ ([...root.querySelectorAll("button.timer[data-tid]")]);
  if (!btns.length) return;
  const rt = runtime();
  const now = rt.now();
  const timers = rt.timers();
  for (const b of btns) {
    const key = tidKey(/** @type {string} */ (b.dataset.tid));
    paintTimerButton(b, timers.find(t => t.key === key) || null, now);
  }
}

/**
 * Wire a recipe timer button. `wait` (seconds): the step's own Tide Marks (schema 2); without it
 * the default 0.8 / 1 / 1.25 marks apply.
 * @param {HTMLElement} btn
 * @param {{ label: string, verb: string, wait?: { min: number, ideal: number, max: number } }} info
 */
export function wireTimerButton(btn, info) {
  btn.onclick = () => {
    const rt = runtime();
    const key = tidKey(/** @type {string} */ (btn.dataset.tid));
    const t = rt.timer(key);
    if (!t) {
      const sec = +(btn.dataset.sec ?? 0);
      if (sec > 0) {
        const w = info.wait;
        const wait = w ? { min: w.min * 1000, ideal: w.ideal * 1000, max: w.max * 1000 } : undefined;
        requestStart({ key, durMs: sec * 1000, label: info.label, verb: info.verb, tide: true, wait },
          () => paintTimerButton(btn, rt.timer(key), rt.now()));
      }
    } else if (t.firedAt != null && t.ackAt == null) {
      rt.ack(key);
      rt.cancel(key);
    } else {
      rt.cancel(key);
    }
    paintTimerButton(btn, rt.timer(key), rt.now());
  };
}
