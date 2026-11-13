// Timer engine: pure functions over Timer data (plan section 10, R1 and R3). Nothing here counts
// down in memory or reads a clock: every value comes from start/end epochs and the `now` passed in.

/** Alarm repeats every 10 s after it fires, for at most 120 s, until acknowledged (R5). */
export const REPEAT_MS = 10_000;
export const REPEAT_WINDOW_MS = 120_000;
/** A timer that fires this long after its end was missed (app asleep or closed): "Overdue by". */
export const LATE_MS = 2_000;
/** Default Tide Marks around a step's seconds (plan CP2: 0.8 / 1 / 1.25). */
export const TIDE = { min: 0.8, max: 1.25 };
/** Longest timer the engine accepts (recipes cap timers at 24 h too). */
export const MAX_MS = 86_400_000;

/**
 * Tide Marks for a timer of `durMs` (ideal = durMs).
 * @param {number} durMs
 * @returns {{ min: number, ideal: number, max: number }}
 */
export function tideMarks(durMs) {
  return { min: Math.round(durMs * TIDE.min), ideal: durMs, max: Math.round(durMs * TIDE.max) };
}

/**
 * A new running timer. `wait` (ms) gives the step's own Tide Marks (schema 2 steps with a wait,
 * CP3); `tide` without a wait uses the default 0.8 / 1 / 1.25 around the duration. A wait whose
 * ideal is not the duration, or that is not ordered, falls back to the default.
 * @param {{ key: string, durMs: number, now: number, label?: string, verb?: string, tide?: boolean,
 *   wait?: { min: number, ideal: number, max: number } }} o
 * @returns {import('../types').Timer}
 */
export function createTimer({ key, durMs, now, label, verb, tide, wait }) {
  const d = clampDur(durMs);
  /** @type {import('../types').Timer} */
  const t = { key, startedAt: now, durMs: d, pausedMs: 0 };
  if (label) t.label = label;
  if (verb) t.verb = verb;
  if (wait && wait.ideal === d && wait.min > 0 && wait.min <= wait.ideal && wait.ideal <= wait.max && wait.max <= 2 * MAX_MS) {
    t.wait = { min: wait.min, ideal: wait.ideal, max: wait.max };
  } else if (tide || wait) t.wait = tideMarks(d);
  return t;
}

/** @param {number} ms */
function clampDur(ms) {
  return Math.min(MAX_MS, Math.max(1000, Math.round(Number(ms) || 0)));
}

/**
 * Display values for a timer at `now`. remaining = startedAt + durMs + pausedMs - now, clamped to
 * [-inf, durMs] so a clock set backwards never shows more than the full time.
 * @param {import('../types').Timer} t
 * @param {number} now
 * @returns {import('../types').TimerView}
 */
export function timerView(t, now) {
  const paused = t.pausedAt != null;
  const at = paused ? /** @type {number} */ (t.pausedAt) : now;
  const endAt = t.startedAt + t.durMs + t.pausedMs + (paused ? Math.max(0, now - /** @type {number} */ (t.pausedAt)) : 0);
  const remainingMs = Math.min(t.durMs, t.startedAt + t.durMs + t.pausedMs - at);
  const elapsedMs = t.durMs - remainingMs;
  const due = remainingMs <= 0;
  const scale = t.wait ? t.wait.max : t.durMs;
  const progress = Math.min(1, Math.max(0, elapsedMs / scale));
  /** @type {import('../types').TimerZone} */
  let zone;
  if (t.wait) zone = elapsedMs < t.wait.min ? "cooking" : elapsedMs <= t.wait.max ? "ready" : "overdue";
  else zone = due ? "done" : "running";
  if (paused && !due) zone = "paused";
  /** @type {import('../types').TimerView} */
  const v = { endAt, remainingMs, elapsedMs, due, paused, zone, progress };
  if (t.wait) v.marks = { min: t.wait.min / scale, ideal: t.wait.ideal / scale };
  return v;
}

/**
 * Whether a timer still needs attention: not yet fired, or fired and not acknowledged.
 * @param {import('../types').Timer} t
 */
export const isLive = t => t.ackAt == null;

/**
 * Fire-once transitions. Every timer past its end without firedAt gets firedAt = now; nothing else
 * changes. Idempotent: a second call with the same or a later `now` returns no fired timers.
 * @param {import('../types').Timer[]} timers
 * @param {number} now
 * @returns {{ timers: import('../types').Timer[], fired: import('../types').Timer[] }}
 */
export function reconcile(timers, now) {
  /** @type {import('../types').Timer[]} */
  const fired = [];
  const next = timers.map(t => {
    if (t.firedAt != null || t.ackAt != null) return t;
    if (!timerView(t, now).due) return t;
    const f = { ...t, firedAt: now };
    fired.push(f);
    return f;
  });
  return { timers: fired.length ? next : timers, fired };
}

/**
 * Which repeat of the alarm should be sounding at `now`: 0 at firedAt, 1 at +10 s, ... up to 11.
 * -1 when not fired, acknowledged, or more than 120 s after firing (or a clock set before firedAt).
 * Worked out from firedAt only, so a reload or a second tab gets the same answer.
 * @param {import('../types').Timer} t
 * @param {number} now
 */
export function ringIndex(t, now) {
  if (t.firedAt == null || t.ackAt != null) return -1;
  const since = now - t.firedAt;
  if (since < 0 || since >= REPEAT_WINDOW_MS) return -1;
  return Math.floor(since / REPEAT_MS);
}

/**
 * The fired timer was found late (the app was asleep, closed or in the background).
 * @param {import('../types').Timer} t
 */
export function firedLate(t) {
  if (t.firedAt == null) return false;
  return t.firedAt - (t.startedAt + t.durMs + t.pausedMs) > LATE_MS;
}

/**
 * @param {import('../types').Timer} t
 * @param {number} now
 * @returns {import('../types').Timer}
 */
export function pause(t, now) {
  if (t.pausedAt != null || t.firedAt != null || timerView(t, now).due) return t;
  return { ...t, pausedAt: Math.max(now, t.startedAt) };
}

/**
 * @param {import('../types').Timer} t
 * @param {number} now
 * @returns {import('../types').Timer}
 */
export function resume(t, now) {
  if (t.pausedAt == null) return t;
  const { pausedAt, ...rest } = t;
  return { ...rest, pausedMs: t.pausedMs + Math.max(0, now - pausedAt) };
}

/**
 * Acknowledge a fired timer (stops the alarm). Never clears firedAt; a second ack keeps the first.
 * @param {import('../types').Timer} t
 * @param {number} now
 * @returns {import('../types').Timer}
 */
export function ack(t, now) {
  if (t.ackAt != null) return t;
  return { ...t, firedAt: t.firedAt ?? now, ackAt: now };
}

/**
 * Change the length of a timer that has not fired yet (quick timer -1 / +1 min). The Tide Marks
 * follow the new length. A timer that has fired keeps its length.
 * @param {import('../types').Timer} t
 * @param {number} deltaMs
 * @param {number} now
 * @returns {import('../types').Timer}
 */
export function adjust(t, deltaMs, now) {
  if (t.firedAt != null) return t;
  const elapsed = timerView(t, now).elapsedMs;
  const durMs = Math.max(clampDur(t.durMs + deltaMs), Math.min(MAX_MS, elapsed + 1000));
  const n = { ...t, durMs };
  if (t.wait) n.wait = tideMarks(durMs);
  return n;
}

/**
 * m:ss (or h:mm:ss) of a duration, rounded up to whole seconds so 0:00 shows only at the end.
 * @param {number} ms
 */
export function clockText(ms) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
}

/**
 * Past-the-end time, rounded down (whole seconds over), as m:ss.
 * @param {number} ms
 */
export function overText(ms) {
  return clockText(Math.floor(Math.max(0, ms) / 1000) * 1000);
}

/** Cooking verbs a step's timer may end on, in the words the recipes use. */
const VERBS = ["drain", "fry", "add", "stir", "soak", "boil", "simmer", "cover", "pat", "return", "push",
  "pour", "heat", "toss", "scramble", "mix", "rinse", "press", "cut", "taste", "serve", "turn", "flip",
  "crack", "remove", "rest", "chop", "slice", "bake", "roast", "steam", "cook", "check", "blend", "whisk"];

/**
 * One verb for the Lighthouse, taken from the step text: the first known cooking verb, so
 * "Noodles into boiling water for 3-4 min. Drain, rinse" gives "Drain". CP3 replaces this with the
 * step's `then` field.
 * @param {string} text
 * @param {string} [fallback]
 */
export function verbFor(text, fallback = "Timer") {
  for (const w of String(text).toLowerCase().split(/[^a-z]+/)) {
    if (VERBS.includes(w)) return w[0].toUpperCase() + w.slice(1);
  }
  return fallback;
}
