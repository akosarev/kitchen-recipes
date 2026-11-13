// The cook session (key km.v1.session): pure operations plus a store-backed holder. Storage is the
// single source of truth, so a reload, a second tab or a cold start all read the same timers.
// Every change is written synchronously before the UI updates (plan R2).
import * as E from "./engine.js";
import { cleanSetup } from "../setup.js";

export const LOG_MAX = 30;
/** Acknowledged timers older than this are dropped on load; a session with nothing left ends. */
export const STALE_MS = 12 * 3600_000;
/** A session with no timers and no done steps is kept this long (for Undo), then ends on load. */
export const IDLE_MS = 60_000;

/**
 * @param {number} now
 * @returns {import('../types').CookSession}
 */
export function newSession(now) {
  return { v: 1, id: "s" + now.toString(36), plan: null, startedAt: now, done: {}, timers: [], log: [] };
}

/** @param {unknown} n */
const num = n => typeof n === "number" && Number.isFinite(n);
/**
 * @param {unknown} s
 * @param {number} max
 */
const str = (s, max) => typeof s === "string" && s.length <= max;

/**
 * A stored timer, checked field by field (storage and imports are untrusted). Null when unusable.
 * @param {unknown} x
 * @returns {import('../types').Timer | null}
 */
export function cleanTimer(x) {
  if (!x || typeof x !== "object") return null;
  const t = /** @type {Record<string, unknown>} */ (x);
  if (!str(t.key, 120) || !num(t.startedAt) || !num(t.durMs) || /** @type {number} */ (t.durMs) <= 0
    || /** @type {number} */ (t.durMs) > E.MAX_MS) return null;
  /** @type {import('../types').Timer} */
  const out = {
    key: /** @type {string} */ (t.key),
    startedAt: /** @type {number} */ (t.startedAt),
    durMs: /** @type {number} */ (t.durMs),
    pausedMs: num(t.pausedMs) && /** @type {number} */ (t.pausedMs) >= 0 ? /** @type {number} */ (t.pausedMs) : 0,
  };
  if (num(t.pausedAt)) out.pausedAt = /** @type {number} */ (t.pausedAt);
  if (num(t.firedAt)) out.firedAt = /** @type {number} */ (t.firedAt);
  if (num(t.ackAt)) out.ackAt = /** @type {number} */ (t.ackAt);
  if (str(t.label, 300)) out.label = /** @type {string} */ (t.label);
  if (str(t.verb, 40)) out.verb = /** @type {string} */ (t.verb);
  const w = /** @type {Record<string, unknown> | undefined} */ (t.wait);
  // Tide Marks only when ordered and positive (0 < min <= ideal <= max, max at most 2 x MAX_MS, as
  // tideMarks() puts max at 1.25 x the duration): a zero or reversed window would make the
  // Lighthouse divide by zero or start overdue.
  if (w && typeof w === "object" && num(w.min) && num(w.ideal) && num(w.max)
    && /** @type {number} */ (w.min) > 0 && /** @type {number} */ (w.min) <= /** @type {number} */ (w.ideal)
    && /** @type {number} */ (w.ideal) <= /** @type {number} */ (w.max) && /** @type {number} */ (w.max) <= 2 * E.MAX_MS) {
    out.wait = { min: /** @type {number} */ (w.min), ideal: /** @type {number} */ (w.ideal), max: /** @type {number} */ (w.max) };
  }
  return out;
}

const HANDS = new Set(["active", "passive"]);
const WARNINGS = new Set(["hands-tight", "idle-hot", "late"]);
/** Longest plan a session keeps: the scheduler's 6 h span plus an hour of "I'm behind". */
export const PLAN_MAX_MS = 8 * 3600_000;
const PLAN_MAX_STEPS = 400;

/**
 * @param {unknown} v
 * @param {number} maxItems
 * @param {number} maxLen
 * @returns {v is string[]}
 */
const strs = (v, maxItems, maxLen) => Array.isArray(v) && v.length <= maxItems && v.every(x => str(x, maxLen));

/**
 * A stored frozen plan, checked field by field. Null when any part is unusable: a plan is all or
 * nothing, since a cook screen with steps missing would be worse than none.
 * @param {unknown} x
 * @returns {import('../types').CookPlan | null}
 */
export function cleanPlan(x) {
  if (!x || typeof x !== "object") return null;
  const p = /** @type {Record<string, any>} */ (x);
  if (!str(p.hash, 40) || !num(p.frozenAt) || p.frozenAt <= 0 || !num(p.serveAt)
    || !num(p.totalMs) || p.totalMs <= 0 || p.totalMs > PLAN_MAX_MS) return null;
  if (!Array.isArray(p.steps) || !p.steps.length || p.steps.length > PLAN_MAX_STEPS) return null;
  /** @type {import('../types').PlannedStep[]} */
  const steps = [];
  const seen = new Set();
  for (const s of p.steps) {
    if (!s || typeof s !== "object" || !str(s.key, 120) || seen.has(s.key) || !str(s.lane, 120) || !HANDS.has(s.hands)
      || !num(s.start) || !num(s.end) || s.start < 0 || s.end < s.start || s.end > p.totalMs) return null;
    seen.add(s.key);
    steps.push({ key: s.key, start: s.start, end: s.end, lane: s.lane, hands: s.hands, coupled: s.coupled === true });
  }
  /** @type {import('../types').PlanWarning[]} */
  const warnings = [];
  for (const w of Array.isArray(p.warnings) ? p.warnings.slice(0, 100) : []) {
    if (w && typeof w === "object" && WARNINGS.has(w.kind) && num(w.at) && strs(w.keys, 20, 120) && str(w.msg, 300)) {
      warnings.push({ kind: w.kind, at: w.at, keys: [...w.keys], msg: w.msg });
    }
  }
  const adaptations = [];
  for (const a of Array.isArray(p.adaptations) ? p.adaptations.slice(0, 4) : []) {
    if (a && typeof a === "object" && str(a.recipeId, 60) && strs(a.labels, 60, 300) && num(a.checks)) {
      adaptations.push({ recipeId: a.recipeId, labels: [...a.labels], checks: a.checks });
    }
  }
  if (!Array.isArray(p.picks) || !p.picks.length || p.picks.length > 2) return null;
  const picks = [];
  for (const k of p.picks) {
    if (!k || typeof k !== "object" || !str(k.recipeId, 60) || !Number.isInteger(k.servings) || k.servings < 1 || k.servings > 12) return null;
    picks.push({ recipeId: k.recipeId, servings: k.servings });
  }
  const setup = cleanSetup(p.setup);
  if (!setup || !strs(p.toggles, 12, 20)) return null;
  return { hash: p.hash, frozenAt: p.frozenAt, totalMs: p.totalMs, serveAt: p.serveAt, steps, warnings, adaptations, picks, toggles: [...p.toggles], setup };
}

/**
 * A stored session, checked (null when missing or not a v1 session). Bad timers and log entries
 * are dropped; acknowledged timers older than 12 h are dropped. A frozen plan that fails its
 * check is dropped whole; a good one is kept until 12 h after its serve time, then goes with its
 * done steps. A session left with no plan, no timers and no done steps ends once its last command
 * is more than a minute old.
 * @param {unknown} x
 * @param {number} now
 * @returns {import('../types').CookSession | null}
 */
export function cleanSession(x, now) {
  if (!x || typeof x !== "object") return null;
  const s = /** @type {Record<string, unknown>} */ (x);
  if (s.v !== 1 || !str(s.id, 60) || !num(s.startedAt)) return null;
  const timers = (Array.isArray(s.timers) ? s.timers : []).map(cleanTimer)
    .filter(/** @type {(t: import('../types').Timer | null) => t is import('../types').Timer} */ (t => !!t))
    .filter(t => !(t.ackAt != null && now - t.ackAt > STALE_MS));
  let plan = cleanPlan(s.plan);
  // A cook left unfinished: 12 h after its serve time the plan goes, and its done steps with it.
  const expired = !!plan && now - plan.serveAt > STALE_MS;
  if (expired) plan = null;
  /** @type {Record<string, number>} */
  const done = {};
  if (!expired && s.done && typeof s.done === "object") {
    for (const [k, v] of Object.entries(s.done)) if (str(k, 120) && num(v)) done[k] = v;
  }
  /** @type {import('../types').Command[]} */
  const log = [];
  for (const c of Array.isArray(s.log) ? s.log : []) {
    if (!c || typeof c !== "object" || !num(c.at)) continue;
    if ((c.kind === "done" || c.kind === "timerStart") && str(c.key, 120)) log.push({ kind: c.kind, key: c.key, at: c.at });
    else if (c.kind === "timerCancel") { const t = cleanTimer(c.timer); if (t) log.push({ kind: "timerCancel", timer: t, at: c.at }); }
    else if (c.kind === "replan" && plan) { const prev = cleanPlan(c.prev); if (prev) log.push({ kind: "replan", prev, at: c.at }); }
  }
  const kept = expired ? log.filter(c => c.kind !== "done") : log;
  if (!plan && !timers.length && !Object.keys(done).length && kept.every(c => now - c.at > IDLE_MS)) return null;
  return { v: 1, id: /** @type {string} */ (s.id), plan, startedAt: /** @type {number} */ (s.startedAt), done, timers, log: kept.slice(-LOG_MAX) };
}

/**
 * @param {import('../types').CookSession} s
 * @param {import('../types').Command} c
 * @returns {import('../types').CookSession}
 */
function logged(s, c) {
  return { ...s, log: [...s.log, c].slice(-LOG_MAX) };
}

/**
 * Start (or restart) the timer for `timer.key`. An earlier timer with the same key is replaced.
 * @param {import('../types').CookSession} s
 * @param {import('../types').Timer} timer
 * @returns {import('../types').CookSession}
 */
export function startTimer(s, timer) {
  const timers = [...s.timers.filter(t => t.key !== timer.key), timer];
  return logged({ ...s, timers }, { kind: "timerStart", key: timer.key, at: timer.startedAt });
}

/**
 * Remove a timer (stop it, or clear a finished one). Undo can bring it back as it was.
 * @param {import('../types').CookSession} s
 * @param {string} key
 * @param {number} now
 * @returns {import('../types').CookSession}
 */
export function cancelTimer(s, key, now) {
  const timer = s.timers.find(t => t.key === key);
  if (!timer) return s;
  return logged({ ...s, timers: s.timers.filter(t => t !== timer) }, { kind: "timerCancel", timer, at: now });
}

/**
 * Apply `fn` to one timer (pause, resume, ack, adjust). Not logged: these are not undoable, so undo
 * can never revert firedAt or ackAt.
 * @param {import('../types').CookSession} s
 * @param {string} key
 * @param {(t: import('../types').Timer) => import('../types').Timer} fn
 * @returns {import('../types').CookSession}
 */
export function updateTimer(s, key, fn) {
  let changed = false;
  const timers = s.timers.map(t => {
    if (t.key !== key) return t;
    const n = fn(t);
    if (n !== t) changed = true;
    return n;
  });
  return changed ? { ...s, timers } : s;
}

/**
 * Mark a step done from the cook screen. Undo makes it pending again.
 * @param {import('../types').CookSession} s
 * @param {string} key
 * @param {number} now
 * @returns {import('../types').CookSession}
 */
export function markDone(s, key, now) {
  return logged({ ...s, done: { ...s.done, [key]: now } }, { kind: "done", key, at: now });
}

/**
 * Mark a step done without logging it: a wait ends when its alarm is acknowledged, and an
 * acknowledgement is never undone.
 * @param {import('../types').CookSession} s
 * @param {string} key
 * @param {number} now
 * @returns {import('../types').CookSession}
 */
export function setDone(s, key, now) {
  return s.done[key] != null ? s : { ...s, done: { ...s.done, [key]: now } };
}

/**
 * "Start cooking": freeze `plan` into the session. Earlier done steps and plan commands go (they
 * belonged to another plan); running timers stay, so a timer started from a recipe page keeps
 * counting and shows on the cook screen under the same key.
 * @param {import('../types').CookSession} s
 * @param {import('../types').CookPlan} plan
 * @returns {import('../types').CookSession}
 */
export function startCooking(s, plan) {
  return { ...s, plan, startedAt: plan.frozenAt, done: {}, log: s.log.filter(c => c.kind === "timerStart" || c.kind === "timerCancel") };
}

/**
 * End the cook: the plan and its done steps go, timers stay.
 * @param {import('../types').CookSession} s
 * @returns {import('../types').CookSession}
 */
export function endCooking(s) {
  if (!s.plan && !Object.keys(s.done).length) return s;
  return { ...s, plan: null, done: {}, log: s.log.filter(c => c.kind === "timerStart" || c.kind === "timerCancel") };
}

/**
 * "I'm behind": swap in the new plan. The old one goes to the log, so Undo restores it.
 * @param {import('../types').CookSession} s
 * @param {import('../types').CookPlan} plan
 * @param {number} now
 * @returns {import('../types').CookSession}
 */
export function replan(s, plan, now) {
  if (!s.plan) return s;
  return logged({ ...s, plan }, { kind: "replan", prev: s.plan, at: now });
}

/**
 * Apply the inverse of one command. firedAt and ackAt are never cleared:
 * - timerStart: the timer is removed (it can no longer alarm, so no second alarm is possible);
 * - timerCancel: the timer comes back exactly as it was, firedAt and ackAt included; if a newer
 *   timer with the same key exists, that one is kept;
 * - done: the step is not done any more;
 * - replan: the plan from before "I'm behind" is back. Steps done since then stay done.
 * @param {import('../types').CookSession} s
 * @param {import('../types').Command} c
 * @returns {import('../types').CookSession}
 */
export function applyInverse(s, c) {
  switch (c.kind) {
    case "timerStart":
      return { ...s, timers: s.timers.filter(t => !(t.key === c.key && t.startedAt === c.at)) };
    case "timerCancel":
      if (s.timers.some(t => t.key === c.timer.key)) return s;
      return { ...s, timers: [...s.timers, c.timer] };
    case "done": {
      const done = { ...s.done };
      delete done[c.key];
      return { ...s, done };
    }
    case "replan":
      return s.plan ? { ...s, plan: c.prev } : s;
  }
  return s;
}

/**
 * Pop the last command and apply its inverse.
 * @param {import('../types').CookSession} s
 * @returns {{ session: import('../types').CookSession, undone: import('../types').Command | null }}
 */
export function undo(s) {
  const c = s.log[s.log.length - 1];
  if (!c) return { session: s, undone: null };
  return { session: applyInverse({ ...s, log: s.log.slice(0, -1) }, c), undone: c };
}

/**
 * Store-backed session holder. Reads go to storage every time (another tab may have written);
 * when a write fails, the in-memory copy wins until a write succeeds again.
 * @param {{ get<T>(key: string, d: T): T, set(key: string, v: unknown): boolean, remove(key: string): void }} store
 * @param {string} key
 * @param {() => number} now
 */
export function createSessionStore(store, key, now) {
  /** @type {import('../types').CookSession | null} */
  let mem = null;
  let unsaved = false;
  const api = {
    /** @returns {import('../types').CookSession | null} */
    load() {
      if (unsaved) return mem;
      mem = cleanSession(store.get(key, null), now());
      return mem;
    },
    /**
     * Write synchronously; a session with no plan, timers, done steps or log ends (key removed).
     * @param {import('../types').CookSession | null} s
     * @returns {boolean} saved
     */
    save(s) {
      mem = s;
      if (!s || (!s.plan && !s.timers.length && !Object.keys(s.done).length && !s.log.length)) {
        store.remove(key);
        mem = null;
        unsaved = false;
        return true;
      }
      unsaved = !store.set(key, s);
      return !unsaved;
    },
    /** Write the current state again (pagehide, hidden, freeze). */
    flush() { if (mem) api.save(mem); },
    /** The last write failed: cooking state will be lost on reload. */
    unsaved: () => unsaved,
    /**
     * Load, change and save in one step. Creates the session on first use.
     * @param {(s: import('../types').CookSession) => import('../types').CookSession} fn
     */
    update(fn) {
      const cur = api.load() || newSession(now());
      const next = fn(cur);
      if (next !== cur) api.save(next);
      return next;
    },
  };
  return api;
}
