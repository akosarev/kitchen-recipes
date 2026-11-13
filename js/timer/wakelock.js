// Wake Lock controller (plan R6). States: held / released / unsupported / denied.
// While wanted (a timer runs, or "Keep screen on" is pressed) it holds a screen lock: acquired on
// start, re-acquired when the page becomes visible and, if that fails, on the next tap. iOS drops
// the lock on every visibility change (Control Center, notifications, app switch); the `release`
// event moves it to released. Works in home-screen apps from iOS 18.4.

/**
 * @typedef {{ released?: boolean, release(): Promise<void>, addEventListener(type: 'release', fn: () => void): void }} SentinelLike
 * @typedef {{ request(type: 'screen'): Promise<SentinelLike> }} WakeLockLike
 */

/** Pill copy (also used by tests). */
export const WAKE_TEXT = {
  held: "Screen stays on",
  off: "Screen may lock: set Auto-Lock to Never while cooking",
};

/**
 * @param {{ wakeLock?: WakeLockLike | null, visible?: () => boolean }} env
 */
export function createWakeLock(env) {
  /** @type {import('../types').WakeState} */
  let state = env.wakeLock ? "released" : "unsupported";
  /** @type {SentinelLike | null} */
  let sentinel = null;
  let wanted = false;
  /** @type {Promise<import('../types').WakeState> | null} */
  let pending = null;
  /** @type {Set<(s: import('../types').WakeState) => void>} */
  const listeners = new Set();
  const visible = env.visible || (() => true);

  /** @param {import('../types').WakeState} s */
  function set(s) {
    if (s === state) return;
    state = s;
    for (const fn of listeners) { try { fn(s); } catch { /* ignore */ } }
  }

  /** @returns {Promise<import('../types').WakeState>} */
  function acquire() {
    if (!env.wakeLock) { set("unsupported"); return Promise.resolve(state); }
    if (state === "held" && sentinel && !sentinel.released) return Promise.resolve(state);
    if (pending) return pending;
    const wl = env.wakeLock;
    pending = (async () => {
      try {
        const s = await wl.request("screen");
        if (!wanted) { s.release().catch(() => {}); set("released"); return state; }
        sentinel = s;
        s.addEventListener("release", () => {
          if (sentinel !== s) return;
          sentinel = null;
          set("released");
          if (wanted && visible()) acquire();
        });
        set("held");
      } catch {
        sentinel = null;
        set("denied");
      } finally {
        pending = null;
      }
      return state;
    })();
    return pending;
  }

  async function releaseLock() {
    const s = sentinel;
    sentinel = null;
    if (s) { try { await s.release(); } catch { /* already gone */ } }
    if (state !== "unsupported") set("released");
  }

  return {
    /** @returns {import('../types').WakeState} */
    get state() { return state; },
    get wanted() { return wanted; },
    /**
     * Want the screen on (true) or not (false).
     * @param {boolean} on
     */
    want(on) {
      wanted = on;
      return on ? acquire() : releaseLock().then(() => state);
    },
    /** Page became visible again: the lock was dropped, take it back. */
    onVisible() { return wanted && visible() ? acquire() : Promise.resolve(state); },
    /** A tap: retry if the last attempt failed or the lock was lost. */
    onTap() { return wanted && state !== "held" && state !== "unsupported" ? acquire() : Promise.resolve(state); },
    /** @param {(s: import('../types').WakeState) => void} fn */
    onChange(fn) { listeners.add(fn); return () => { listeners.delete(fn); }; },
  };
}
