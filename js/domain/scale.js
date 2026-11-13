// Quantity scaler and {k} placeholder renderer, moved from legacy/index.html. Behaviour is unchanged
// for the old units ("" and "cloves"). CP3: schema 2 units (pc and clove show as the old page did),
// amounts "to taste", ingredients that do not scale, and {k:n} name placeholders.
import { frac } from "./fraction.js";

/** How a schema 2 unit is written after the number (pc: nothing, as the old page's ""). */
const UNIT_LABEL = /** @type {Record<string, string>} */ ({ pc: "", clove: "cloves", to_taste: "" });

/**
 * Label for a unit, old or schema 2.
 * @param {string} u
 */
export const unitLabel = u => Object.hasOwn(UNIT_LABEL, u) ? UNIT_LABEL[u] : u;

/**
 * Format a scaled quantity in its unit.
 * @param {number} q
 * @param {string} u
 * @returns {string}
 */
export function fmt(q, u) {
  let s;
  if (u === "g") { s = String(q >= 50 ? Math.round(q / 5) * 5 : Math.max(1, Math.round(q))); }
  else if (u === "ml") { s = String(Math.round(q / 10) * 10 || 5); }
  else if (u === "tbsp" || u === "tsp") { s = frac(q); }
  else { s = frac(Math.round(q * 4) / 4); }
  return u ? s + " " + u : s;
}

/**
 * Rendered amount of one ingredient at a servings factor.
 * @param {{ q: number | null, u: string, scale?: 'linear' | 'none' }} i
 * @param {number} f servings / base
 */
export function amountOf(i, f) {
  if (i.q === null || i.u === "to_taste") return "to taste";
  const q = i.scale === "none" ? i.q : i.q * f;
  // "pinch" is new in schema 2, so it can read naturally: 1 pinch, 2 pinches.
  return fmt(q, i.u === "pinch" && q > 1.125 ? "pinches" : unitLabel(i.u));
}

/**
 * Rendered amount for every ingredient key at the given servings.
 * @param {{ base: number, groups: { items: { k: string, q: number | null, u: string, scale?: 'linear' | 'none' }[] }[] }} r
 * @param {number} serv
 * @returns {import('../types').Amounts}
 */
export function amounts(r, serv) {
  /** @type {import('../types').Amounts} */
  const m = {};
  const f = serv / r.base;
  r.groups.forEach(g => g.items.forEach(i => { m[i.k] = amountOf(i, f); }));
  return m;
}

/**
 * Name shown by {k:n} for every ingredient key.
 * @param {{ groups: { items: { k: string, n: string, short?: string }[] }[] }} r
 * @returns {Record<string, string>}
 */
export function names(r) {
  /** @type {Record<string, string>} */
  const m = {};
  r.groups.forEach(g => g.items.forEach(i => { m[i.k] = i.short ?? i.n; }));
  return m;
}

const PLACEHOLDER = /\{(\w+)(?::(n))?\}/g;

/**
 * Replace {k} placeholders with amounts and {k:n} with names. Lenient, exactly like the old page:
 * an unknown key renders as the bare key name.
 * @param {string} t
 * @param {import('../types').Amounts} a
 * @param {Record<string, string>} [n] names for {k:n}
 * @returns {string}
 */
export const fill = (t, a, n = {}) => t.replace(PLACEHOLDER, (_, k, isName) => {
  const m = isName ? n : a;
  return (Object.hasOwn(m, k) && m[k]) || k;
});

/**
 * Placeholder keys used in a text ({k} and {k:n} alike).
 * @param {string} t
 * @returns {string[]}
 */
export const placeholders = t => [...t.matchAll(PLACEHOLDER)].map(m => m[1]);

/**
 * Strict renderer: throws on an unknown {k} or {k:n}. Used by tests to prove every placeholder in
 * the data resolves, so the lenient `fill` never hits its fallback.
 * @param {string} t
 * @param {import('../types').Amounts} a
 * @param {Record<string, string>} [n]
 * @returns {string}
 */
export function fillStrict(t, a, n = {}) {
  const missing = [...t.matchAll(PLACEHOLDER)]
    .filter(m => !Object.hasOwn(m[2] ? n : a, m[1]))
    .map(m => m[2] ? m[1] + ":n" : m[1]);
  if (missing.length) throw new Error("Unknown placeholder {" + missing.join("}, {") + "} in: " + t);
  return fill(t, a, n);
}
