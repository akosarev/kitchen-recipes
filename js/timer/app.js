// The app's one timer runtime, built from the browser's pieces, and the hooks that keep it honest:
// reconcile on boot, pageshow (back-forward cache too), visibilitychange:visible, focus and a 1 s
// tick while visible; flush on hidden, pagehide and freeze; paint at 4 Hz with rAF (plan R2, R3, R11).
// A tap re-arms audio on touchend and click: those are activation-triggering events in WebKit, while
// a touch pointerdown is not (resume() and unmuted play() would be refused there). The alarm leader
// lock follows visibility, so the tab the cook is looking at is the one that sounds.
import { store, KEYS } from "../store.js";
import { clock } from "./clock.js";
import { createRuntime } from "./runtime.js";
import { createAudioController, browserAudioEnv } from "./alarm.js";
import { createWakeLock } from "./wakelock.js";
import { createLeader } from "./leader.js";

/** @type {ReturnType<typeof createRuntime> | null} */
let rt = null;
/** @type {ReturnType<typeof createLeader> | null} */
let lead = null;

/** The app runtime (created on first use). */
export function runtime() {
  if (rt) return rt;
  const nav = /** @type {any} */ (globalThis.navigator || {});
  const doc = globalThis.document;
  lead = createLeader(nav.locks || null, {
    visible: () => !doc || doc.visibilityState !== "hidden",
    onChange: () => rt?.reconcile(),
  });
  rt = createRuntime({
    store,
    sessionKey: KEYS.session,
    now: () => clock.now(),
    audio: createAudioController(browserAudioEnv()),
    wake: createWakeLock({ wakeLock: nav.wakeLock || null, visible: () => !doc || doc.visibilityState !== "hidden" }),
    leader: lead,
  });
  return rt;
}

export const TICK_MS = 1000;
export const PAINT_MS = 250;

let hooked = false;

/**
 * Install the reconcile, flush, tap, tick and paint hooks once.
 * @param {() => void} paint
 */
export function installTimerHooks(paint) {
  const r = runtime();
  r.subscribe(paint);
  if (hooked) return;
  hooked = true;
  const visible = () => document.visibilityState !== "hidden";
  const l = /** @type {ReturnType<typeof createLeader>} */ (lead);
  document.addEventListener("visibilitychange", () => {
    if (visible()) { l.onVisible(); r.onVisible(); } else { l.onHidden(); r.flush(); }
  });
  window.addEventListener("pageshow", () => { if (visible()) l.onVisible(); r.onVisible(); });
  window.addEventListener("focus", () => r.onVisible());
  window.addEventListener("pagehide", () => { l.onHidden(); r.flush(); });
  document.addEventListener("freeze", () => { l.onHidden(); r.flush(); });
  window.addEventListener("storage", e => { if (e.key === KEYS.session || e.key === null) r.reconcile(); });
  const tap = () => r.onTap();
  document.addEventListener("touchend", tap, { capture: true, passive: true });
  document.addEventListener("click", tap, { capture: true });
  setInterval(() => { if (visible()) r.reconcile(); }, TICK_MS);
  let last = 0;
  const frame = (/** @type {number} */ ts) => {
    if (visible() && ts - last >= PAINT_MS) { last = ts; r.notify(); }
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
  r.reconcile();
}
