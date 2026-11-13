// Allergen toggles and the three-tier lookup (docs/v0-plan.md section 7): contains, may contain
// (check the label) and unknown (not in the table: also check the label).
import { TABLE } from "../data/allergen-table.js";

/** @typedef {import('../types').Allergen} Allergen */
/** @typedef {import('../types').Toggle} Toggle */

/** The toggles in display order, with their chip labels. */
export const TOGGLES = /** @type {const} */ ([
  ["gluten", "Gluten"],
  ["shellfish", "Shellfish"],
  ["fish", "Fish"],
  ["soy", "Soy"],
  ["egg", "Egg"],
  ["dairy", "Dairy"],
  ["peanut", "Peanut"],
  ["treenut", "Tree nuts"],
  ["sesame", "Sesame"],
]);

/** @type {ReadonlySet<string>} */
const TOGGLE_IDS = new Set(TOGGLES.map(([id]) => id));

/**
 * A known toggle id.
 * @param {unknown} v
 * @returns {v is Toggle}
 */
export const isToggle = v => typeof v === "string" && TOGGLE_IDS.has(v);

/** Allergen names in running text ("Tofu is the dish (soy)"). */
const ALLERGEN_WORD = /** @type {Record<Allergen, string>} */ ({
  gluten: "gluten", fish: "fish", crustacean: "shellfish", mollusc: "molluscs", peanut: "peanut",
  treenut: "tree nuts", soy: "soy", dairy: "dairy", egg: "egg", sesame: "sesame",
});

/**
 * Words for a list of allergens, without repeats, in a fixed order.
 * @param {readonly Allergen[]} list
 */
export function allergenWords(list) {
  const order = /** @type {Allergen[]} */ (Object.keys(ALLERGEN_WORD));
  const words = order.filter(a => list.includes(a)).map(a => ALLERGEN_WORD[a]);
  return [...new Set(words)].join(", ");
}

/**
 * The allergens tonight's toggles stand for (shellfish = crustaceans and molluscs).
 * @param {Iterable<Toggle>} toggles
 * @returns {Set<Allergen>}
 */
export function expandToggles(toggles) {
  /** @type {Set<Allergen>} */
  const out = new Set();
  for (const t of toggles) {
    if (t === "shellfish") { out.add("crustacean"); out.add("mollusc"); }
    else if (isToggle(t)) out.add(t);
  }
  return out;
}

/**
 * The toggle an allergen belongs to (for the "Contains" icons on a recipe card).
 * @param {Allergen} a
 * @returns {Toggle}
 */
export const toggleOf = a => (a === "crustacean" || a === "mollusc" ? "shellfish" : a);

/**
 * @typedef {{ kind: 'unknown' } | { kind: 'known', hard: Allergen[], may: Allergen[] }} Classification
 */

/**
 * Classify one ingredient ref against the active allergens. `hard` and `may` hold only the active
 * allergens the table lists for it.
 * @param {string} ref
 * @param {ReadonlySet<Allergen>} active
 * @returns {Classification}
 */
export function classify(ref, active) {
  const e = TABLE.get(ref);
  if (!e) return { kind: "unknown" };
  return {
    kind: "known",
    hard: e.contains.filter(a => active.has(a)),
    may: e.mayContain.filter(a => active.has(a)),
  };
}

/**
 * Every allergen a recipe's ingredients contain (table "contains" only), as toggles, in toggle order.
 * Unknown refs are reported separately.
 * @param {import('../types').Recipe} r
 * @returns {{ toggles: Toggle[], unknown: boolean }}
 */
export function recipeContains(r) {
  /** @type {Set<Toggle>} */
  const found = new Set();
  let unknown = false;
  for (const g of r.groups) for (const i of g.items) {
    const e = TABLE.get(i.ref);
    if (!e) { unknown = true; continue; }
    for (const a of e.contains) found.add(toggleOf(a));
  }
  return { toggles: TOGGLES.map(([id]) => id).filter(t => found.has(t)), unknown };
}
