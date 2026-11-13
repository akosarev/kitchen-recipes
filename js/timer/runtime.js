// Timer runtime: ties the session, the engine, the alarm leader, the audio controller and the Wake
// Lock controller together, and runs reconcile on every return to the screen (plan R2, R3, R5, R6).
// The UI calls these actions and repaints from runtime state; it never keeps timer state itself.
import * as E from "./engine.js";
import * as S from "./session.js";

/** Undo stays offered this long after an action (plan section 11). */
export const UNDO_MS = 15_000;

/**
 * @typedef {ReturnType<typeof import('./alarm.js').createAudioController>} AudioController
 * @typedef {ReturnType<typeof import('./wakelock.js').createWakeLock>} WakeController
 * @typedef {{ isLeader(): boolean, ready: Promise<void> }} Leader
 * @typedef {{ get<T>(key: string, d: T): T, set(key: string, v: unknown): boolean, remove(key: string): void }} StoreLike
 * @typedef {{ key: string, durMs: number, label?: string, verb?: string, tide?: boolean,
 *   wait?: { min: number, ideal: number, max: number } }} StartSpec
 */

/**
 * @param {{ store: StoreLike, sessionKey: string, now: () => number, audio: AudioController,
 *   wake: WakeController, leader: Leader }} deps
 */
export function createRuntime(deps) {
  const { now, audio, wake, leader } = deps;
  const sessions = S.createSessionStore(deps.store, deps.sessionKey, now);
  /** @type {Set<() => void>} */
  const listeners = new Set();
  /** Last alarm repeat played per timer run ("key@startedAt" -> ring index). In memory only. */
  /** @type {Map<string, number>} */
  const rung = new Map();
  let sounding = false;
  let userWake = false;
  /** @type {{ cmd: import('../types').Command, at: number } | null} */
  let lastAction = null;
  let rings = 0;

  /** @param {import('../types').Timer} t */
  const runId = t => t.key + "@" + t.startedAt;

  // Alarms that were already ringing before this page loaded (reload, second tab, cold start)
  // continue at their next 10 s repeat instead of ringing again right away.
  const bootAt = now();
  for (const t of sessions.load()?.timers || []) {
    if (t.firedAt != null && t.firedAt <= bootAt) rung.set(runId(t), E.ringIndex(t, bootAt));
  }

  function notify() {
    for (const fn of listeners) { try { fn(); } catch (e) { console.warn("Kitchen Master: paint failed", e); } }
  }

  /** Timers that still need attention (running, or fired and not acknowledged). */
  function live() {
    return (sessions.load()?.timers || []).filter(E.isLive);
  }

  /** Cooking from the cook screen: a frozen plan is in the session. */
  const planned = () => !!sessions.load()?.plan;

  function syncWake() {
    const want = userWake || planned() || live().length > 0;
    if (want !== wake.wanted) wake.want(want);
  }

  /**
   * Sound every alarm repeat that is due and not yet played. Only the leader tab plays.
   * @param {import('../types').Timer[]} timers
   * @param {number} t
   */
  function ringDue(timers, t) {
    let any = false;
    let play = -1; // the highest repeat index due now: later repeats are louder and longer
    for (const x of timers) {
      const i = E.ringIndex(x, t);
      if (i < 0) continue;
      any = true;
      const id = runId(x);
      if (i > (rung.get(id) ?? -1)) {
        if (!leader.isLeader()) continue; // not marked as played: a new leader picks it up
        rung.set(id, i);
        play = Math.max(play, i);
      }
    }
    if (play >= 0) {
      rings++; sounding = true;
      // A ring that finds no working sound path moves the audio state to "failed" (re-arm bar).
      Promise.resolve(audio.ring(play)).then(notify, notify);
    }
    if (!any && sounding) { audio.quiet(); sounding = false; }
  }

  const api = {
    /** The stored session, checked (null when not cooking). */
    session: () => sessions.load(),
    /** All timers, including acknowledged ones (their buttons show "Done"). */
    timers: () => sessions.load()?.timers || [],
    live,
    /**
     * A timer needs attention or a plan is being cooked, so the app is "cooking" (pills, re-arm
     * bar, no SW update).
     */
    cooking: () => planned() || live().length > 0,
    /** The frozen plan being cooked, or null. */
    plan: () => sessions.load()?.plan || null,
    /** @param {string} key */
    timer: key => (sessions.load()?.timers || []).find(t => t.key === key) || null,
    /** Fired and not acknowledged, oldest first: the alarm overlay shows the first. */
    alarming: () => live().filter(t => t.firedAt != null).sort((a, b) => /** @type {number} */ (a.firedAt) - /** @type {number} */ (b.firedAt)),
    unsaved: () => sessions.unsaved(),
    now,
    audio,
    wake,
    leader,
    /** Number of alarm sounds played by this tab (Settings, tests). */
    rings: () => rings,
    /** The undoable action shown in the Undo toast, while it is recent. */
    lastAction() {
      if (!lastAction || now() - lastAction.at > UNDO_MS || now() < lastAction.at) return null;
      return lastAction;
    },

    /**
     * Reconcile at `now`: fire-once transitions (set firedAt, write, then play), repeats from
     * firedAt, Wake Lock wanted while cooking. Idempotent; safe to call from every hook.
     */
    reconcile() {
      const t = now();
      const s = sessions.load();
      if (s) {
        const { timers, fired } = E.reconcile(s.timers, t);
        if (fired.length) sessions.save({ ...s, timers });
        ringDue(timers, t);
      } else if (sounding) { audio.quiet(); sounding = false; }
      syncWake();
      notify();
    },

    /**
     * Start a timer (call from a tap: it also arms audio and takes the Wake Lock).
     * @param {StartSpec} spec
     */
    start(spec) {
      const at = now();
      const timer = E.createTimer({ ...spec, now: at });
      const s = sessions.update(cur => S.startTimer(cur, timer));
      lastAction = { cmd: s.log[s.log.length - 1], at };
      if (audio.state !== "armed") audio.arm().then(notify, notify);
      api.reconcile();
      return timer;
    },

    /**
     * Stop a timer, or clear a finished one. Undo brings it back.
     * @param {string} key
     */
    cancel(key) {
      const at = now();
      const before = sessions.load();
      if (!before || !before.timers.some(t => t.key === key)) return;
      const s = sessions.update(cur => S.cancelTimer(cur, key, at));
      lastAction = { cmd: s.log[s.log.length - 1], at };
      api.reconcile();
    },

    /**
     * "Start cooking" (call from a tap: it arms audio and takes the Wake Lock). The plan must be
     * frozen (frozenAt set) and carry its picks, toggles and setup.
     * @param {import('../types').CookPlan} plan
     */
    startCooking(plan) {
      sessions.update(cur => S.startCooking(cur, plan));
      lastAction = null;
      if (audio.state !== "armed") audio.arm().then(notify, notify);
      api.reconcile();
    },

    /** End the cook (Done screen, "End cooking"): the plan goes, timers stay. */
    endCooking() {
      const s = sessions.load();
      if (s) sessions.save(S.endCooking(s));
      lastAction = null;
      api.reconcile();
    },

    /**
     * Mark a plan step done (hold on the cook screen). Undo makes it pending again.
     * @param {string} key
     */
    done(key) {
      const at = now();
      const before = sessions.load();
      if (!before?.plan || before.done[key] != null) return;
      const s = sessions.update(cur => S.markDone(cur, key, at));
      lastAction = { cmd: s.log[s.log.length - 1], at };
      api.reconcile();
    },

    /**
     * "I'm behind": swap in a later plan. Undo brings the old one back.
     * @param {import('../types').CookPlan} plan
     */
    replan(plan) {
      const at = now();
      if (!sessions.load()?.plan) return;
      const s = sessions.update(cur => S.replan(cur, plan, at));
      lastAction = { cmd: s.log[s.log.length - 1], at };
      api.reconcile();
    },

    /** Undo the last action (start, stop, step done, replan). Never clears firedAt or ackAt. */
    undo() {
      const s = sessions.load();
      if (!s) return null;
      const r = S.undo(s);
      if (r.undone) sessions.save(r.session);
      lastAction = null;
      api.reconcile();
      return r.undone;
    },

    /**
     * Acknowledge an alarm: set ackAt, write, give the audio session back ("auto"). When the timer
     * belongs to a waiting step of the plan, the wait is over and the step is done with it.
     * @param {string} key
     */
    ack(key) {
      const t = now();
      sessions.update(cur => {
        const fired = cur.timers.some(x => x.key === key && x.firedAt != null);
        const next = S.updateTimer(cur, key, x => (x.firedAt != null ? E.ack(x, t) : x));
        const wait = fired && cur.plan?.steps.some(p => p.key === key && p.hands === "passive");
        return wait ? S.setDone(next, key, t) : next;
      });
      api.reconcile();
      if (!api.alarming().length) { audio.quiet(); sounding = false; }
    },

    /** @param {string} key */
    pause(key) { const t = now(); sessions.update(cur => S.updateTimer(cur, key, x => E.pause(x, t))); api.reconcile(); },
    /** @param {string} key */
    resume(key) { const t = now(); sessions.update(cur => S.updateTimer(cur, key, x => E.resume(x, t))); api.reconcile(); },
    /**
     * @param {string} key
     * @param {number} deltaMs
     */
    adjust(key, deltaMs) { const t = now(); sessions.update(cur => S.updateTimer(cur, key, x => E.adjust(x, deltaMs, t))); api.reconcile(); },

    /** Write the session again (pagehide, hidden, freeze, before leaving for Shortcuts). */
    flush() { sessions.flush(); },

    /**
     * "Keep screen on" pressed (also on while cooking).
     * @param {boolean} on
     */
    setUserWake(on) { userWake = on; syncWake(); notify(); },
    userWake: () => userWake,

    /** A tap anywhere: re-arm audio when cooking and not armed; retry the Wake Lock. */
    onTap() {
      if (api.cooking() && audio.state !== "armed") audio.arm().then(notify, notify);
      wake.onTap().then(notify, notify);
    },

    /** The page is visible again (also pageshow and focus): reconcile and take the lock back. */
    onVisible() {
      audio.nudge();
      api.reconcile();
      wake.onVisible().then(notify, notify);
    },

    /** @param {() => void} fn */
    subscribe(fn) { listeners.add(fn); return () => { listeners.delete(fn); }; },
    notify,
  };
  audio.onChange(notify);
  wake.onChange(notify);
  return api;
}
