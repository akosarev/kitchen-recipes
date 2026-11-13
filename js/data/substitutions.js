// Rule-based substitutions (docs/v0-plan.md section 7), tried in priority order per ingredient.
// A rule is valid for tonight's toggles when the table says none of its replacements contains an
// active allergen (adapt.js works that out; nothing here is hand-written per toggle).
//
// with:     replacements. The first takes over the ingredient's key (its {k} amount and {k:n} name);
//           the others are added as extra shopping lines. Amount: q (absolute, for the recipe's base
//           servings) or ratio x the original amount, in u (default: the original unit).
//           "omit" leaves the ingredient out.
// as:       the name {k:n} shows in step text, when it should differ from the first replacement's.
// patch:    step changes on the steps that use the ingredient ({k} or {k:n} in their text):
//           set (optionally only steps with a given technique), remove (dependencies re-linked),
//           add (a new step before the first step that uses it; {$} in its text is the key).
// needsAlt: the swap changes how a step is cooked in a way no generic text can say ("cook the
//           chicken through"), so every recipe step that uses the ingredient must carry its own
//           text in step.alt[<rule id>] (tests enforce this for every swap that can happen).

/** @typedef {import('../types').Substitution} Substitution */

/**
 * The step that makes homemade sweet soy (kecap manis) before its first use.
 * @param {string} base what is simmered with the palm sugar
 */
const sweetSoyStep = base => ({
  op: /** @type {const} */ ("add"),
  step: {
    t: `Homemade sweet soy: simmer {$} ${base} with {$__palm_sugar} palm sugar in a small pan for 1 min, stirring, until syrupy. Let it cool.`,
    hands: /** @type {const} */ ("active"), dur: 120, technique: /** @type {const} */ ("simmer"), needs: { pan: 1, burner: 1 },
  },
});

/** @type {readonly Substitution[]} */
export const SUBSTITUTIONS = Object.freeze(/** @type {Substitution[]} */ ([
  { id: "soy-tamari", replaces: "soy_sauce", priority: 1, label: "Tamari instead of soy sauce",
    with: [{ ref: "tamari", n: "tamari (gluten-free label)", short: "tamari", ratio: 1 }] },
  { id: "soy-aminos", replaces: "soy_sauce", priority: 2, label: "Coconut aminos instead of soy sauce",
    with: [{ ref: "coconut_aminos", n: "coconut aminos", ratio: 1 }, { ref: "salt", n: "salt (with the aminos)", ratio: 1, u: "pinch" }],
    as: "coconut aminos (with the salt)" },

  { id: "kecap-tamari", replaces: "kecap_manis", priority: 1, label: "Homemade sweet soy (tamari)",
    with: [{ ref: "tamari", n: "tamari (gluten-free label)", short: "tamari", ratio: 1 }, { ref: "palm_sugar", n: "palm sugar", ratio: 0.75 }],
    as: "homemade sweet soy", patch: [sweetSoyStep("tamari")] },
  { id: "kecap-aminos", replaces: "kecap_manis", priority: 2, label: "Homemade sweet soy (coconut aminos)",
    with: [{ ref: "coconut_aminos", n: "coconut aminos", ratio: 1 }, { ref: "palm_sugar", n: "palm sugar", ratio: 0.5 }],
    as: "homemade sweet soy", patch: [sweetSoyStep("coconut aminos")] },

  { id: "oyster-mushroom", replaces: "oyster_sauce", priority: 1, label: "Mushroom \"oyster\" sauce",
    with: [{ ref: "mushroom_oyster_sauce", n: "mushroom \"oyster\" sauce", ratio: 1 }] },
  { id: "oyster-aminos", replaces: "oyster_sauce", priority: 2, label: "Aminos and cornstarch instead of oyster sauce",
    with: [{ ref: "coconut_aminos", n: "coconut aminos", ratio: 1 }, { ref: "cornstarch", n: "cornstarch (with the aminos)", ratio: 0.5, u: "tsp" },
      { ref: "sugar", n: "sugar (with the aminos)", ratio: 1, u: "pinch" }],
    as: "coconut aminos (with the cornstarch and sugar)" },

  { id: "vegsauce-mushroom", replaces: "vegetarian_stirfry_sauce", priority: 1, label: "Mushroom \"oyster\" sauce instead of stir-fry sauce",
    with: [{ ref: "mushroom_oyster_sauce", n: "mushroom \"oyster\" sauce", ratio: 1 }] },
  { id: "vegsauce-aminos", replaces: "vegetarian_stirfry_sauce", priority: 2, label: "Aminos and cornstarch instead of stir-fry sauce",
    with: [{ ref: "coconut_aminos", n: "coconut aminos", ratio: 1 }, { ref: "cornstarch", n: "cornstarch (with the aminos)", ratio: 0.5, u: "tsp" },
      { ref: "sugar", n: "sugar (with the aminos)", ratio: 1, u: "pinch" }],
    as: "coconut aminos (with the cornstarch and sugar)" },

  { id: "fishsauce-soy", replaces: "fish_sauce", priority: 1, label: "Soy sauce and lime instead of fish sauce",
    with: [{ ref: "soy_sauce", n: "soy sauce", ratio: 1 }, { ref: "lime", n: "lime (squeezed)", ratio: 0.25, u: "pc" }] },
  { id: "fishsauce-salt", replaces: "fish_sauce", priority: 2, label: "Salt and lime instead of fish sauce",
    with: [{ ref: "salt", n: "salt", ratio: 0.5, u: "tsp" }, { ref: "lime", n: "lime (squeezed)", ratio: 0.25, u: "pc" }] },

  { id: "terasi-garlic", replaces: "shrimp_paste_terasi", priority: 1, label: "Terasi left out, extra garlic",
    with: [{ ref: "garlic", n: "garlic (extra, instead of terasi)", q: 1, u: "clove" }] },

  { id: "noodles-eggless", replaces: "egg_noodles", priority: 1, label: "Eggless wheat noodles",
    with: [{ ref: "wheat_noodles_eggless", n: "eggless wheat noodles", short: "noodles", ratio: 1 }] },
  { id: "noodles-rice", replaces: "egg_noodles", priority: 2, label: "Rice noodles (soaked, 8 min)",
    with: [{ ref: "rice_noodles", n: "flat rice noodles", short: "rice noodles", ratio: 0.8 }],
    patch: [{ op: "set", technique: "boil", set: {
      t: "Soak the {$:n} ({$}) in just-boiled water for 6–10 min, until soft. Drain, rinse with cold water and toss with a few drops of oil.",
      hands: "passive", technique: "soak", dur: 480, timer: 480, wait: { min: 360, ideal: 480, max: 600 }, then: "Drain", needs: {},
    } }] },

  { id: "shrimp-chicken", replaces: "shrimp", priority: 1, label: "Chicken instead of shrimp", needsAlt: true,
    with: [{ ref: "chicken_thigh", n: "boneless chicken thigh", short: "chicken", ratio: 1 }] },
  { id: "shrimp-tofu", replaces: "shrimp", priority: 2, label: "Tofu instead of shrimp", needsAlt: true,
    with: [{ ref: "tofu", n: "firm tofu", short: "tofu", ratio: 1 }] },

  { id: "egg-omit", replaces: "egg", priority: 1, label: "Egg left out", with: "omit", patch: [{ op: "remove" }] },

  { id: "peanuts-sunflower", replaces: "peanuts", priority: 1, label: "Sunflower seeds instead of peanuts",
    with: [{ ref: "sunflower_seeds", n: "sunflower seeds, toasted", short: "sunflower seeds", ratio: 1 }] },
  { id: "peanutoil-neutral", replaces: "peanut_oil", priority: 1, label: "Neutral oil instead of peanut oil",
    with: [{ ref: "oil_neutral", n: "neutral oil", short: "oil", ratio: 1 }] },
  { id: "kemiri-omit", replaces: "candlenut_kemiri", priority: 1, label: "Kemiri left out",
    with: [{ ref: "oil_neutral", n: "neutral oil (instead of kemiri)", short: "oil", q: 1, u: "tsp" }, { ref: "shallot", n: "shallot (extra)", q: 1, u: "pc" }] },
  { id: "sesameoil-neutral", replaces: "sesame_oil", priority: 1, label: "Neutral oil instead of sesame oil",
    with: [{ ref: "oil_neutral", n: "neutral oil", short: "oil", ratio: 1 }] },
  { id: "tofu-chicken", replaces: "tofu", priority: 1, label: "Chicken instead of tofu", needsAlt: true,
    with: [{ ref: "chicken_thigh", n: "boneless chicken thigh", short: "chicken", ratio: 1 }] },
  { id: "butter-oil", replaces: "butter", priority: 1, label: "Neutral oil instead of butter",
    with: [{ ref: "oil_neutral", n: "neutral oil", short: "oil", ratio: 1 }] },
]));

/** Rules by the ref they replace, in priority order. */
export const RULES_BY_REF = (() => {
  /** @type {Map<string, Substitution[]>} */
  const m = new Map();
  for (const s of SUBSTITUTIONS) m.set(s.replaces, [...(m.get(s.replaces) || []), s]);
  for (const list of m.values()) list.sort((a, b) => a.priority - b.priority);
  return m;
})();
