// The fixed allergen table (docs/v0-plan.md section 7). One row per canonical ingredient (`ref`).
//   contains:   the ingredient is or contains the allergen (a hard hit: swap, omit or block)
//   mayContain: depends on the brand or is hidden (kept, with a "Check label" chip)
// A ref missing from this table is "unknown" and always gets a "Check label" chip.
// Rows are reviewed by hand in a PR; tests/unit/allergens.test.js checks that every recipe ref and
// every substitution ref is listed here.

/** @typedef {import('../types').AllergenEntry} AllergenEntry */

/** @type {AllergenEntry[]} */
const ROWS = [
  // Sauces and seasonings
  { ref: "kecap_manis", contains: ["soy", "gluten"], mayContain: [], note: "Most brands are brewed with wheat." },
  { ref: "soy_sauce", contains: ["soy", "gluten"], mayContain: [] },
  { ref: "tamari", contains: ["soy"], mayContain: ["gluten"], note: "Only labels that say gluten-free are made without wheat." },
  { ref: "coconut_aminos", contains: [], mayContain: [] },
  { ref: "oyster_sauce", contains: ["mollusc", "gluten"], mayContain: ["soy"] },
  { ref: "mushroom_oyster_sauce", contains: ["soy"], mayContain: ["gluten"] },
  { ref: "vegetarian_stirfry_sauce", contains: ["soy", "gluten"], mayContain: [], note: "Usually soy sauce and wheat based." },
  { ref: "fish_sauce", contains: ["fish"], mayContain: ["crustacean"] },
  { ref: "shrimp_paste_terasi", contains: ["crustacean"], mayContain: ["fish"] },
  { ref: "chicken_stock_cube", contains: [], mayContain: ["gluten", "soy", "dairy", "egg"] },
  { ref: "ketchup", contains: [], mayContain: ["gluten"] },
  { ref: "sweet_chili_sauce", contains: [], mayContain: ["gluten"] },
  { ref: "rice_vinegar", contains: [], mayContain: [] },
  { ref: "vinegar", contains: [], mayContain: [] },
  { ref: "white_pepper", contains: [], mayContain: [] },
  { ref: "chili_flakes", contains: [], mayContain: [] },
  { ref: "salt", contains: [], mayContain: [] },
  { ref: "sugar", contains: [], mayContain: [] },
  { ref: "palm_sugar", contains: [], mayContain: [] },
  { ref: "cornstarch", contains: [], mayContain: [] },
  { ref: "tamarind", contains: [], mayContain: [] },
  { ref: "water", contains: [], mayContain: [] },
  // Noodles
  { ref: "egg_noodles", contains: ["gluten", "egg"], mayContain: ["soy"] },
  { ref: "wheat_noodles_eggless", contains: ["gluten"], mayContain: ["egg"], note: "Often made on the same lines as egg noodles." },
  { ref: "rice_noodles", contains: [], mayContain: ["gluten"], note: "Some brands are made on lines that also run wheat." },
  // Protein
  { ref: "egg", contains: ["egg"], mayContain: [] },
  { ref: "tofu", contains: ["soy"], mayContain: [] },
  { ref: "tempeh", contains: ["soy"], mayContain: [] },
  { ref: "shrimp", contains: ["crustacean"], mayContain: [] },
  { ref: "chicken_thigh", contains: [], mayContain: [] },
  { ref: "butter", contains: ["dairy"], mayContain: [] },
  // Nuts, seeds and oils
  { ref: "peanuts", contains: ["peanut"], mayContain: [] },
  { ref: "peanut_oil", contains: ["peanut"], mayContain: [] },
  { ref: "candlenut_kemiri", contains: ["treenut"], mayContain: [] },
  { ref: "sesame_oil", contains: ["sesame"], mayContain: [] },
  { ref: "sunflower_seeds", contains: [], mayContain: [] },
  { ref: "oil_neutral", contains: [], mayContain: [] },
  // Garnishes and sides
  { ref: "fried_shallots", contains: [], mayContain: ["gluten"], note: "Often dusted with wheat flour." },
  { ref: "kerupuk_udang", contains: ["crustacean"], mayContain: ["gluten"] },
  // Vegetables, fruit and herbs
  { ref: "garlic", contains: [], mayContain: [] },
  { ref: "shallot", contains: [], mayContain: [] },
  { ref: "onion", contains: [], mayContain: [] },
  { ref: "spring_onion", contains: [], mayContain: [] },
  { ref: "chili", contains: [], mayContain: [] },
  { ref: "lime", contains: [], mayContain: [] },
  { ref: "bell_pepper", contains: [], mayContain: [] },
  { ref: "cucumber", contains: [], mayContain: [] },
  { ref: "tomato", contains: [], mayContain: [] },
  { ref: "pineapple", contains: [], mayContain: [] },
  { ref: "carrot", contains: [], mayContain: [] },
  { ref: "cabbage", contains: [], mayContain: [] },
  { ref: "bean_sprouts", contains: [], mayContain: [], note: "Mung bean sprouts, not soy." },
  { ref: "zucchini", contains: [], mayContain: [] },
  { ref: "mushroom", contains: [], mayContain: [] },
];

/** @type {readonly AllergenEntry[]} */
export const ALLERGEN_TABLE = Object.freeze(ROWS.map(e => Object.freeze({ ...e, contains: Object.freeze([...e.contains]), mayContain: Object.freeze([...e.mayContain]) })));

/** Lookup by ref. */
export const TABLE = new Map(ALLERGEN_TABLE.map(e => [e.ref, e]));
