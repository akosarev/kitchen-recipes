// adapt(recipe, toggles): tonight's allergens applied to one recipe (docs/v0-plan.md section 7).
//
// 1. Expand the toggles (shellfish = crustaceans + molluscs).
// 2. Classify every ingredient with the fixed table.
// 3. A "contains" hit: a core ingredient blocks the recipe; otherwise the first rule (in priority
//    order) whose replacements contain none of tonight's allergens is used; with no such rule an
//    optional ingredient is left out, anything else blocks the recipe. Replacements are never
//    replaced again. "May contain" hits and unknown ingredients stay, with a "Check label" chip.
// 4. Step patches are applied in order, then the recipe's own texts for that rule (step.alt).
//    A removed step's predecessors are linked to its successors. The result must still be a DAG
//    with every placeholder resolving; anything else is a bug in the rules and throws.
import { TABLE } from "../data/allergen-table.js";
import { RULES_BY_REF } from "../data/substitutions.js";
import { expandToggles, classify } from "./allergens.js";
import { placeholders } from "./scale.js";

/** @typedef {import('../types').Recipe} Recipe */
/** @typedef {import('../types').Step} Step */
/** @typedef {import('../types').Ingredient} Ingredient */
/** @typedef {import('../types').Substitution} Substitution */
/** @typedef {import('../types').Allergen} Allergen */
/** @typedef {import('../types').IngredientStatus} IngredientStatus */
/** @typedef {import('../types').AdaptedLine} AdaptedLine */
/** @typedef {import('../types').Adapted} Adapted */

/**
 * Keys a step's text and sub-steps refer to.
 * @param {Step} s
 * @returns {Set<string>}
 */
export function stepKeys(s) {
  return new Set([s.t, ...(s.sub || [])].flatMap(placeholders));
}

/**
 * Whether no replacement of a rule contains an active allergen (and all are in the table).
 * @param {Substitution} rule
 * @param {ReadonlySet<Allergen>} active
 */
export function ruleFits(rule, active) {
  if (rule.with === "omit") return true;
  return rule.with.every(c => {
    const e = TABLE.get(c.ref);
    return !!e && !e.contains.some(a => active.has(a));
  });
}

/**
 * Keys whose amount ({k}, not {k:n}) a step's text and sub-steps show: the steps that handle the
 * ingredient itself. A step that only names it ({k:n}) reads right after any swap.
 * @param {Step} s
 * @returns {Set<string>}
 */
export function amountKeys(s) {
  return new Set([s.t, ...(s.sub || [])].flatMap(t => [...t.matchAll(/\{(\w+)\}/g)].map(m => m[1])));
}

/**
 * Whether a recipe has the texts a needsAlt rule requires for ingredient key k: every step showing
 * its amount carries step.alt[rule id]. Without them the rule is not used (the next rule is tried,
 * or the recipe is blocked), so a swap never leaves cooking text written for the old ingredient.
 * @param {Substitution} rule
 * @param {Recipe} r
 * @param {string} k
 */
export function altReady(rule, r, k) {
  if (!rule.needsAlt) return true;
  return r.steps.every(s => !amountKeys(s).has(k) || !!s.alt?.[rule.id]);
}

/**
 * Whether a rule's "remove" patches only drop steps about this ingredient alone: a step that also
 * handles another ingredient ("add the noodles and the eggs") is never removed; the rule does not
 * fit that recipe then (the next rule is tried, or the recipe is blocked).
 * @param {Substitution} rule
 * @param {Recipe} r
 * @param {string} k
 */
export function removeReady(rule, r, k) {
  if (!(rule.patch || []).some(p => p.op === "remove")) return true;
  return r.steps.every(s => {
    const keys = stepKeys(s);
    return !keys.has(k) || [...keys].every(x => x === k);
  });
}

/**
 * Replace {$} (the ingredient's key) in a rule's text.
 * @param {string} t
 * @param {string} k
 */
const keyed = (t, k) => t.replace(/\{\$(__\w+)?(:n)?\}/g, (_, extra, name) => `{${k}${extra || ""}${name || ""}}`);

/**
 * Apply a set of changes to a step (null removes the field). Text gets {$} replaced.
 * @param {Step} s
 * @param {import('../types').StepChange} change
 * @param {string} k
 */
function applyChange(s, change, k) {
  for (const [f, v] of Object.entries(change)) {
    const field = /** @type {keyof Step} */ (f);
    if (v === null) { delete s[field]; continue; }
    if (f === "t") s.t = keyed(/** @type {string} */ (v), k);
    else if (f === "sub") s.sub = /** @type {string[]} */ (v).map(x => keyed(x, k));
    else /** @type {any} */ (s)[field] = structuredClone(v);
  }
}

/**
 * The adapted shopping line for a replacement component.
 * @param {Ingredient} orig
 * @param {import('../types').SubComponent} c
 * @param {string} k
 * @returns {Ingredient}
 */
function component(orig, c, k) {
  const u = c.u ?? orig.u;
  let q;
  if (c.q !== undefined) q = c.q;
  else q = orig.q === null ? null : orig.q * (c.ratio ?? 1);
  /** @type {Ingredient} */
  const item = { k, ref: c.ref, q: u === "to_taste" ? null : q, u: q === null ? "to_taste" : u, n: c.n };
  if (c.short) item.short = c.short;
  if (orig.scale) item.scale = orig.scale;
  return item;
}

/**
 * @param {Recipe} recipe
 * @param {Iterable<import('../types').Toggle>} toggles
 * @returns {Adapted}
 */
export function adapt(recipe, toggles) {
  const active = expandToggles(toggles);
  const r = /** @type {Recipe} */ (structuredClone(recipe));
  /** @type {Record<string, IngredientStatus>} */
  const status = {};
  /** @type {AdaptedLine[][]} */
  const lines = [];
  /** @type {import('../types').BlockReason[]} */
  const reasons = [];
  /** @type {{ k: string, rule: Substitution }[]} */
  const applied = [];
  /** @type {string[]} */
  const labels = [];
  /** @type {Set<string>} */
  const omittedKeys = new Set();
  let swaps = 0;

  for (const g of r.groups) {
    /** @type {AdaptedLine[]} */
    const gl = [];
    /** @type {Ingredient[]} */
    const items = [];
    for (const item of g.items) {
      /** @type {(line: AdaptedLine) => void} */
      const keep = line => { gl.push(line); status[line.item.k] = line.status; };
      if (active.size === 0) { items.push(item); keep({ item, status: { kind: "clear" } }); continue; }
      const c = classify(item.ref, active);
      if (c.kind === "unknown") { items.push(item); keep({ item, status: { kind: "unknown" } }); continue; }
      if (c.hard.length === 0) {
        items.push(item);
        keep({ item, status: c.may.length ? { kind: "check", allergens: c.may } : { kind: "clear" } });
        continue;
      }
      if (item.core) { reasons.push({ k: item.k, n: item.short ?? item.n, allergens: c.hard, why: "core" }); continue; }
      const rule = (RULES_BY_REF.get(item.ref) || []).find(x => ruleFits(x, active) && altReady(x, recipe, item.k) && removeReady(x, recipe, item.k));
      if (rule && rule.with !== "omit") {
        const [first, ...rest] = rule.with;
        const main = component(item, first, item.k);
        main.short = rule.as ?? first.short ?? first.n;
        /** @type {AdaptedLine[]} */
        const extras = [];
        items.push(main);
        keep({ item: main, status: { kind: "swapped", sub: rule.id, checks: mayOf(first.ref, active) }, was: item, label: rule.label });
        for (const comp of rest) {
          const extra = component(item, comp, `${item.k}__${comp.ref}`);
          items.push(extra);
          extras.push({ item: extra, status: { kind: "swapped", sub: rule.id, checks: mayOf(comp.ref, active) }, extraOf: item.k, label: rule.label });
        }
        extras.forEach(keep);
        applied.push({ k: item.k, rule });
        if (!labels.includes(rule.label)) labels.push(rule.label);
        swaps++;
        continue;
      }
      if (rule || item.optional) {
        const label = rule ? rule.label : `${cap(item.short ?? item.n)} left out`;
        keep({ item, status: { kind: "omitted", sub: rule ? rule.id : null }, was: item, label });
        omittedKeys.add(item.k);
        if (rule) applied.push({ k: item.k, rule });
        if (!labels.includes(label)) labels.push(label);
        swaps++;
        continue;
      }
      reasons.push({ k: item.k, n: item.short ?? item.n, allergens: c.hard, why: "no-rule" });
    }
    g.items = items;
    lines.push(gl);
  }
  if (reasons.length) return { kind: "blocked", reasons };

  /** @type {Set<string>} */
  const changed = new Set();
  /** @type {string[]} */
  const added = [];
  /** @type {string[]} */
  const removed = [];
  const stepById = () => new Map(r.steps.map(s => [s.id, s]));

  for (const { k, rule } of applied) {
    for (const p of rule.patch || []) {
      if (p.op === "set") {
        for (const s of r.steps) {
          if (!stepKeys(s).has(k) || (p.technique && s.technique !== p.technique)) continue;
          applyChange(s, p.set, k);
          changed.add(s.id);
        }
      } else if (p.op === "remove") {
        for (const s of r.steps.filter(x => stepKeys(x).has(k))) {
          removeStep(r, s.id);
          removed.push(s.id);
          changed.delete(s.id);
        }
      } else if (p.op === "add") {
        const order = r.phases.flatMap(ph => ph.stepIds);
        const byId = stepById();
        const target = order.map(id => /** @type {Step} */ (byId.get(id))).find(s => stepKeys(s).has(k));
        if (!target) continue;
        const id = "+" + k;
        /** @type {Step} */
        const step = { id, dish: target.dish, t: keyed(p.step.t, k), hands: p.step.hands, dur: p.step.dur, after: [...target.after] };
        if (p.step.timer) step.timer = p.step.timer;
        if (p.step.needs) step.needs = { ...p.step.needs };
        if (p.step.technique) step.technique = p.step.technique;
        r.steps.splice(r.steps.indexOf(target), 0, step);
        target.after = [...target.after, id];
        const ph = /** @type {import('../types').Phase} */ (r.phases.find(x => x.stepIds.includes(target.id)));
        ph.stepIds.splice(ph.stepIds.indexOf(target.id), 0, id);
        added.push(id);
      }
    }
    for (const s of r.steps) {
      const change = s.alt?.[rule.id];
      if (change) { applyChange(s, change, k); changed.add(s.id); }
    }
    const top = r.alt?.[rule.id];
    if (top?.sub) r.sub = top.sub;
    if (top?.tip) r.tip = top.tip;
  }
  for (const s of r.steps) delete s.alt;
  delete r.alt;

  checkResult(r, omittedKeys);
  const checks = lines.flat().filter(l => l.status.kind === "check" || l.status.kind === "unknown"
    || (l.status.kind === "swapped" && l.status.checks.length > 0)).length;
  return { kind: "ok", recipe: r, status, lines, changed: [...changed], added, removed, labels, swaps, checks };
}

/**
 * Active allergens a ref may contain.
 * @param {string} ref
 * @param {ReadonlySet<Allergen>} active
 * @returns {Allergen[]}
 */
function mayOf(ref, active) {
  return (TABLE.get(ref)?.mayContain || []).filter(a => active.has(a));
}

/** @param {string} s */
const cap = s => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * Remove a step; steps that waited for it now wait for its predecessors.
 * @param {Recipe} r
 * @param {string} id
 */
function removeStep(r, id) {
  const gone = /** @type {Step} */ (r.steps.find(s => s.id === id));
  r.steps = r.steps.filter(s => s.id !== id);
  for (const s of r.steps) {
    if (!s.after.includes(id)) continue;
    s.after = [...new Set([...s.after.filter(d => d !== id), ...gone.after])];
  }
  for (const ph of r.phases) ph.stepIds = ph.stepIds.filter(x => x !== id);
}

/**
 * The adapted recipe must stay a DAG whose step ids are all in a phase, with every placeholder
 * naming an ingredient (or a left-out one, which renders as "left out").
 * @param {Recipe} r
 * @param {ReadonlySet<string>} omitted
 */
export function checkResult(r, omitted) {
  const keys = new Set(r.groups.flatMap(g => g.items.map(i => i.k)));
  const ids = new Set(r.steps.map(s => s.id));
  for (const s of r.steps) {
    for (const k of stepKeys(s)) {
      if (!keys.has(k) && !omitted.has(k)) throw new Error(`adapt: step ${s.id} of ${r.id} names unknown {${k}}`);
    }
    for (const d of s.after) if (!ids.has(d)) throw new Error(`adapt: step ${s.id} of ${r.id} waits for missing ${d}`);
  }
  const inPhases = r.phases.flatMap(p => p.stepIds);
  if (inPhases.length !== ids.size || !inPhases.every(id => ids.has(id))) throw new Error(`adapt: ${r.id} phases do not match its steps`);
  // Kahn: every step must be placeable.
  const indeg = new Map(r.steps.map(s => [s.id, s.after.length]));
  const queue = r.steps.filter(s => s.after.length === 0).map(s => s.id);
  let seen = 0;
  while (queue.length) {
    const id = /** @type {string} */ (queue.shift());
    seen++;
    for (const s of r.steps) {
      if (!s.after.includes(id)) continue;
      const n = /** @type {number} */ (indeg.get(s.id)) - 1;
      indeg.set(s.id, n);
      if (n === 0) queue.push(s.id);
    }
  }
  if (seen !== r.steps.length) throw new Error(`adapt: ${r.id} has a dependency cycle`);
}

/**
 * Text for a blocked recipe: "Tofu is the dish (soy)", "Shrimp has no swap for shellfish".
 * @param {import('../types').BlockReason} b
 * @param {(list: readonly Allergen[]) => string} words
 */
export function reasonText(b, words) {
  return b.why === "core" ? `${cap(b.n)} is the dish (${words(b.allergens)})` : `${cap(b.n)} has no swap for ${words(b.allergens)}`;
}
