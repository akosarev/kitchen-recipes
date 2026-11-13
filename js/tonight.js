// Tonight's per-meal draft (km.v1.tonight, docs/v0-plan.md sections 6 and 7). CP3 uses the allergen
// toggles; CP4 adds the picks. Not a stored profile: the draft is dropped 12 hours after it was
// started (on the next read), on "Clear", and (CP5) when a cook is done.
import { isToggle, TOGGLES } from "./domain/allergens.js";
import { isPlainObject, isServings } from "./store.js";

/** A draft older than this is discarded on the next read. */
export const TONIGHT_TTL_MS = 12 * 60 * 60 * 1000;

const ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * A stored draft, checked: null when it is not a valid draft or is older than 12 hours (or dated in
 * the future by more than a day: a clock set back must not keep toggles forever). Toggles are kept
 * in display order without repeats.
 * @param {unknown} v
 * @param {number} now
 * @returns {import('./types').Tonight | null}
 */
export function cleanTonight(v, now) {
  if (!isPlainObject(v)) return null;
  const at = v.createdAt;
  if (typeof at !== "number" || !Number.isFinite(at)) return null;
  if (now - at > TONIGHT_TTL_MS || at - now > 24 * 60 * 60 * 1000) return null;
  if (!Array.isArray(v.toggles) || !v.toggles.every(isToggle)) return null;
  if (!Array.isArray(v.picks) || v.picks.length > 2) return null;
  /** @type {import('./types').Tonight['picks']} */
  const picks = [];
  for (const p of v.picks) {
    if (!isPlainObject(p) || typeof p.recipeId !== "string" || !ID.test(p.recipeId) || !isServings(p.servings)) return null;
    picks.push({ recipeId: p.recipeId, servings: /** @type {number} */ (p.servings) });
  }
  const set = new Set(v.toggles);
  return { createdAt: at, picks, toggles: TOGGLES.map(([id]) => id).filter(t => set.has(t)) };
}

/**
 * @typedef {{ get<T>(key: string, d: T): T, set(key: string, v: unknown): boolean, remove(key: string): void }} StoreLike
 */

/**
 * Tonight's toggles. An expired or broken draft is removed.
 * @param {StoreLike} store
 * @param {string} key
 * @param {number} now
 * @returns {import('./types').Toggle[]}
 */
export function readToggles(store, key, now) {
  const raw = store.get(key, null);
  if (raw === null) return [];
  const t = cleanTonight(raw, now);
  if (!t) { store.remove(key); return []; }
  return t.toggles;
}

/**
 * Tonight's picks (1-2 recipes with servings), in pick order. An expired draft reads as none.
 * @param {StoreLike} store
 * @param {string} key
 * @param {number} now
 * @returns {import('./types').Tonight['picks']}
 */
export function readPicks(store, key, now) {
  const raw = store.get(key, null);
  if (raw === null) return [];
  const t = cleanTonight(raw, now);
  if (!t) { store.remove(key); return []; }
  return t.picks;
}

/**
 * Save tonight's picks (at most 2, no repeats; servings 1-12), keeping the toggles.
 * @param {StoreLike} store
 * @param {string} key
 * @param {import('./types').Tonight['picks']} picks
 * @param {number} now
 * @returns {boolean} whether the write succeeded
 */
export function writePicks(store, key, picks, now) {
  const cur = cleanTonight(store.get(key, null), now);
  const seen = new Set();
  const list = picks.filter(p => !seen.has(p.recipeId) && seen.add(p.recipeId)).slice(0, 2)
    .map(p => ({ recipeId: p.recipeId, servings: Math.min(12, Math.max(1, Math.round(p.servings))) }));
  const toggles = cur ? cur.toggles : [];
  if (list.length === 0 && toggles.length === 0) { store.remove(key); return true; }
  return store.set(key, { createdAt: cur ? cur.createdAt : now, picks: list, toggles });
}

/**
 * Save tonight's toggles. The draft's clock starts with the first toggle; no toggles and no picks
 * removes the draft.
 * @param {StoreLike} store
 * @param {string} key
 * @param {Iterable<import('./types').Toggle>} toggles
 * @param {number} now
 * @returns {boolean} whether the write succeeded
 */
export function writeToggles(store, key, toggles, now) {
  const cur = cleanTonight(store.get(key, null), now);
  const set = new Set(toggles);
  const list = TOGGLES.map(([id]) => id).filter(t => set.has(t));
  const picks = cur ? cur.picks : [];
  if (list.length === 0 && picks.length === 0) { store.remove(key); return true; }
  /** @type {import('./types').Tonight} */
  const next = { createdAt: cur ? cur.createdAt : now, picks, toggles: list };
  return store.set(key, next);
}
