// Alarm leader election with the Web Locks API (plan R3): only the tab holding the "km-alarm" lock
// plays sound, so two open tabs never ring twice. Leadership follows visibility: a tab lets the lock
// go when it is hidden (iOS freezes background tabs, so a hidden leader would leave the tab the cook
// is looking at silent) and asks for it again, queued, when it is visible. A lock that is granted
// after the tab went hidden again is let go at once.

export const LOCK_NAME = "km-alarm";

/**
 * @typedef {{ request(name: string, opts: { ifAvailable?: boolean, signal?: AbortSignal }, cb: (lock: unknown) => unknown): Promise<unknown> }} LocksLike
 */

/**
 * @param {LocksLike | undefined | null} locks navigator.locks (absent: this tab is always leader)
 * @param {{ name?: string, onChange?: (leader: boolean) => void, visible?: () => boolean }} [opts]
 */
export function createLeader(locks, opts = {}) {
  const name = opts.name || LOCK_NAME;
  const visible = opts.visible || (() => true);
  let leader = !locks;
  /** The Web Locks API failed: every tab leads (a broken API must not silence every tab). */
  let broken = false;
  /** Whether this tab currently wants the lock (visible and not stopped). */
  let want = false;
  /** Bumped on every give-up, so a grant for an older request is let go. */
  let gen = 0;
  let stopped = false;
  /** @type {(() => void) | null} */
  let release = null;
  /** Aborts the queued request when the tab is hidden before it is granted. */
  /** @type {AbortController | null} */
  let queued = null;

  /** @param {boolean} v */
  const changed = v => { try { opts.onChange?.(v); } catch { /* listener errors never drop the lock */ } };

  /**
   * @param {number} my
   * @returns {(lock: unknown) => unknown}
   */
  const take = my => lock => {
    if (!lock) return null;
    if (my !== gen || !want) return null; // hidden or stopped meanwhile: let it go at once
    leader = true;
    changed(true);
    return new Promise(r => { release = () => { release = null; r(undefined); }; });
  };

  /** Ask for the lock: at once if free, else queue and take over when it is let go. */
  function acquire() {
    if (!locks || broken || want || stopped) return Promise.resolve();
    want = true;
    const my = gen;
    return new Promise(/** @param {(got: boolean | null) => void} res */ res => {
      // The request's own promise settles only when the lock is let go, so the callback reports.
      const cb = take(my);
      locks.request(name, { ifAvailable: true }, lock => { res(!!lock); return cb(lock); })
        .catch(() => res(null));
    }).then(got => {
      if (got === null) { broken = true; leader = true; return; }
      if (got || my !== gen || !want) return;
      queued = typeof AbortController === "function" ? new AbortController() : null;
      locks.request(name, queued ? { signal: queued.signal } : {}, take(my)).catch(() => {}); // AbortError when hidden
    });
  }

  /** Give the lock back (or drop the queued request when it is granted). */
  function giveUp() {
    if (!locks || broken) return;
    want = false;
    gen++;
    if (queued) { queued.abort(); queued = null; }
    const r = release;
    if (r) r();
    if (leader) { leader = false; changed(false); }
  }

  const ready = visible() ? acquire() : Promise.resolve();

  return {
    /** Whether this tab plays alarm sound. */
    isLeader: () => leader,
    /** Resolves once the first lock attempt has settled. */
    ready,
    /** The page is visible again: ask for the lock. */
    onVisible() { if (visible()) acquire(); },
    /** The page is hidden (or going away): let another, visible tab lead. */
    onHidden() { giveUp(); },
    /** Give up the lock for good (tests; page unload releases it anyway). */
    stop() { stopped = true; giveUp(); },
  };
}
