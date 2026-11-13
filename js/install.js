// Install gate and persistent storage (plan R8 and R9). Cooking belongs in the installed home-screen
// app: Safari tab storage may be deleted after 7 days and is not shared with the app.
import { cleanPrefs } from "./store.js";

export const INSTALL_TEXT = "Install to Home Screen: cooking data in Safari may be deleted after 7 days and is not shared with the installed app.";

// CP1 (ux-v1, docs/ux/brief.md decision 4): the install question, asked once per device, in
// plain words (glossary: "Not installed" -> this title; "Cook in Safari anyway" -> "Show me how").
export const GATE_TITLE = "Add Kitchen Master to your Home Screen?";
export const GATE_BODY = "In Safari, iPhone may delete your saved cooking after 7 days.";
export const GATE_OK = "Show me how";
export const GATE_CANCEL = "Not now";

/**
 * Running as the installed home-screen app.
 * @param {{ matchMedia?: (q: string) => { matches: boolean }, navigator?: { standalone?: boolean } }} [w]
 */
export function isStandalone(w = /** @type {any} */ (globalThis)) {
  try {
    if (w.matchMedia && w.matchMedia("(display-mode: standalone)").matches) return true;
  } catch { /* no matchMedia */ }
  return !!(w.navigator && w.navigator.standalone);
}

/**
 * On the first standalone launch, ask for persistent storage once and remember the answer.
 * @param {{ persist?: () => Promise<boolean> } | undefined} storage navigator.storage
 * @param {{ get<T>(k: string, d: T): T, set(k: string, v: unknown): boolean }} store
 * @param {string} prefsKey
 * @param {boolean} standalone
 * @param {number} now
 * @returns {Promise<boolean | null>} the answer, or null when not asked
 */
export async function requestPersistOnce(storage, store, prefsKey, standalone, now) {
  if (!standalone || !storage || typeof storage.persist !== "function") return null;
  /** @returns {import('./types').Prefs} */
  const read = () => cleanPrefs(store.get(prefsKey, {})) || {};
  if (read().persist) return null;
  let granted = false;
  try { granted = !!(await storage.persist()); } catch { granted = false; }
  store.set(prefsKey, { ...read(), persist: { granted, at: now } });
  return granted;
}
