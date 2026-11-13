// Tonight's cook setup (docs/v0-plan.md section 8): the equipment on hand and the serve time.
// The last setup (km.v1.lastSetup) is offered as the default next time; it is not a profile.
import { isPlainObject } from "./store.js";

/** Stepper and switch limits. */
export const LIMITS = Object.freeze({ burner: [1, 6], pot: [0, 4], pan: [0, 3], wok: [0, 1], oven: [0, 1] });

/** The setup offered before any was saved: a common four-burner stove with one wok. */
export const DEFAULT_SETUP = Object.freeze(/** @type {import('./types').CookSetup} */ ({
  burner: 4, wok: 1, pan: 1, pot: 2, oven: 0, wokFallbackPan: false, serveAt: "asap",
}));

/**
 * A stored or imported setup, checked; null when any field is out of range.
 * @param {unknown} v
 * @returns {import('./types').CookSetup | null}
 */
export function cleanSetup(v) {
  if (!isPlainObject(v)) return null;
  /** @type {Record<string, number>} */
  const n = {};
  for (const [k, [lo, hi]] of Object.entries(LIMITS)) {
    const x = v[k];
    if (!Number.isInteger(x) || /** @type {number} */ (x) < lo || /** @type {number} */ (x) > hi) return null;
    n[k] = /** @type {number} */ (x);
  }
  if (typeof v.wokFallbackPan !== "boolean") return null;
  const s = v.serveAt;
  if (s !== "asap" && !(Number.isInteger(s) && /** @type {number} */ (s) >= 0 && /** @type {number} */ (s) < 24 * 60)) return null;
  return {
    burner: n.burner, wok: /** @type {0 | 1} */ (n.wok), pan: n.pan, pot: n.pot, oven: /** @type {0 | 1} */ (n.oven),
    wokFallbackPan: /** @type {boolean} */ (v.wokFallbackPan), serveAt: /** @type {number | 'asap'} */ (s),
  };
}

/**
 * Epoch ms of a serve time (minutes after local midnight); ASAP: null. The time is taken on the day
 * of `now`, unless that is more than 6 hours past: then it means tomorrow (00:30 asked at 23:00).
 * @param {number | 'asap'} serveAt
 * @param {number} now
 */
export function serveEpoch(serveAt, now) {
  if (serveAt === "asap") return null;
  const d = new Date(now);
  d.setHours(Math.floor(serveAt / 60), serveAt % 60, 0, 0);
  if (d.getTime() < now - 6 * 3600_000) d.setDate(d.getDate() + 1);
  return d.getTime();
}

/**
 * "19:30" for minutes after midnight.
 * @param {number} min
 */
export const hhmm = min => `${String(Math.floor(min / 60) % 24).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;

/**
 * "19:30" for an epoch, in local time.
 * @param {number} epoch
 */
export function clockAt(epoch) {
  const d = new Date(epoch);
  return hhmm(d.getHours() * 60 + d.getMinutes());
}
