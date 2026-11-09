// Schema 2 recipe checks (recipes/v2/*.json). No dependencies; Node 20+ and browsers.
// Kitchen Master ships a byte-identical copy as js/recipe-schema.js and checks every recipe it
// loads with it (a unit test there compares the two files), so a recipe that passes here loads in
// the app and one that fails here is refused there.
//
// Every function returns a list of problems ("" never appears); an empty list means valid.

export const INDEX_VERSION = 2;
export const ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** Ingredient keys: placeholders and data-key attributes. "__" is reserved for swap extras. */
export const KEY = /^(?!.*__)[A-Za-z0-9_]{1,40}$/;
/** Canonical ingredient id, looked up in the app's allergen table. */
export const REF = /^[a-z][a-z0-9_]{0,59}$/;
export const DISH = /^[a-z][a-z0-9]{0,19}$/;
export const STEP_ID = /^(\d{1,2})\.(\d{1,2})$/;
/** Substitution rule ids used as keys of a step's `alt`. */
export const SUB_ID = /^[a-z0-9]+(?:[-_][a-z0-9]+)*$/;
export const UNITS = ["g", "kg", "ml", "l", "tsp", "tbsp", "cup", "pc", "clove", "pinch", "to_taste"];
export const LANGS = ["en", "ru", "nl", "id"];
export const EQUIPMENT = ["burner", "wok", "pan", "pot", "oven"];
export const TECHNIQUES = ["chop", "boil", "soak", "simmer", "stirfry", "fry", "toss", "mix", "rest", "plate", "other"];
export const SOURCES = ["seed", "manual", "import"];
/** `{k}` is the scaled amount, `{k:n}` the ingredient's name. */
export const PLACEHOLDER = /\{(\w+)(?::(n))?\}/g;
const MAX_SEC = 86400;
const MAX_TEXT = 2000;

// Inputs are untrusted parsed JSON, hence `any`.
/**
 * @param {any} v
 * @returns {v is string}
 */
const isStr = v => typeof v === "string";
/**
 * @param {any} v
 * @returns {v is string}
 */
const isText = v => isStr(v) && v.length <= MAX_TEXT;
/**
 * @param {any} v
 * @returns {boolean}
 */
const isObj = v => !!v && typeof v === "object" && !Array.isArray(v);
/**
 * @param {any} v
 * @returns {boolean}
 */
const isSec = v => Number.isInteger(v) && v >= 1 && v <= MAX_SEC;
/**
 * @param {object} o
 * @param {string} k
 */
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

/**
 * Keys a text refers to through {k} or {k:n}.
 * @param {string} t
 * @returns {string[]}
 */
export const placeholderKeys = t => [...t.matchAll(PLACEHOLDER)].map(m => m[1]);

/**
 * @param {any} index
 * @returns {string[]}
 */
export function checkIndexV2(index) {
  /**
   * @type {string[]}
   */
  const errs = [];
  if (!isObj(index)) return ["index must be an object"];
  if (index.version !== INDEX_VERSION) return [`index version must be ${INDEX_VERSION}, got ${JSON.stringify(index.version)}`];
  if (!Array.isArray(index.recipes)) return ["index needs a recipes list"];
  const ids = new Set();
  index.recipes.forEach((/** @type {any} */ e, /** @type {number} */ i) => {
    const at = `recipes[${i}]`;
    if (!isObj(e) || !isStr(e.id) || !isStr(e.title) || !isStr(e.file)) { errs.push(`${at}: needs id, title and file (strings)`); return; }
    if (!ID.test(e.id)) errs.push(`${at}: id "${e.id}" must be lowercase words joined by "-"`);
    if (ids.has(e.id)) errs.push(`${at}: duplicate id "${e.id}"`);
    ids.add(e.id);
    if (e.file !== e.id + ".json") errs.push(`${at}: file must be "${e.id}.json"`);
  });
  return errs;
}

/**
 * The shared rules for a wait (Tide Marks), in seconds.
 * @param {any} w
 * @returns {boolean}
 */
const isWait = w => isObj(w) && isSec(w.min) && isSec(w.ideal) && isSec(w.max) && w.min <= w.ideal && w.ideal <= w.max;

/**
 * @param {any} n
 * @returns {boolean}
 */
const isNeeds = n => isObj(n) && Object.entries(n).every(([k, v]) => EQUIPMENT.includes(k) && Number.isInteger(v) && v >= 0 && v <= 6);

/**
 * Check the timing fields of a step (or of a step with an alt applied).
 * @param {any} s
 * @param {string} at
 * @param {string[]} errs
 */
function checkTiming(s, at, errs) {
  if (s.hands !== "active" && s.hands !== "passive") errs.push(`${at}: hands must be "active" or "passive"`);
  if (!isSec(s.dur)) errs.push(`${at}: dur must be whole seconds, 1 to ${MAX_SEC}`);
  if (s.timer !== undefined && s.timer !== null && !isSec(s.timer)) errs.push(`${at}: timer must be whole seconds, 1 to ${MAX_SEC}`);
  if (s.wait !== undefined && s.wait !== null) {
    if (!isWait(s.wait)) errs.push(`${at}: wait needs whole seconds min <= ideal <= max`);
    else {
      const w = s.wait;
      if (s.hands !== "passive") errs.push(`${at}: wait is only for passive steps`);
      if (s.dur !== w.ideal) errs.push(`${at}: dur must equal wait.ideal`);
      if (s.timer !== w.ideal) errs.push(`${at}: timer must equal wait.ideal`);
    }
  }
  if (s.then !== undefined && s.then !== null && !(isStr(s.then) && s.then.length >= 1 && s.then.length <= 40)) errs.push(`${at}: then must be one short word`);
  if (s.technique !== undefined && !TECHNIQUES.includes(s.technique)) errs.push(`${at}: unknown technique ${JSON.stringify(s.technique)}`);
  if (s.needs !== undefined && !isNeeds(s.needs)) errs.push(`${at}: needs maps equipment (${EQUIPMENT.join(", ")}) to 0-6`);
}

const ALT_FIELDS = ["t", "sub", "dur", "timer", "hands", "wait", "technique", "then", "needs"];

/**
 * Check one schema 2 recipe against its index entry.
 * @param {any} r
 * @param {{ id: string, title: string, file: string }} entry
 * @returns {string[]}
 */
export function checkRecipeV2(r, entry) {
  /**
   * @type {string[]}
   */
  const errs = [];
  /**
   * @param {string} msg
   */
  const bad = msg => { errs.push(msg); };
  if (!isObj(r)) return ["recipe must be an object"];
  if (r.schema !== 2) bad("schema must be 2");
  if (r.id !== entry.id) bad(`id "${r.id}" does not match index id "${entry.id}"`);
  if (entry.file !== entry.id + ".json") bad(`file must be "${entry.id}.json"`);
  if (r.title !== entry.title) bad(`title does not match index title "${entry.title}"`);
  for (const f of ["title", "sub", "time", "tip"]) if (!isText(r[f])) bad(`${f} must be text`);
  if (!Number.isInteger(r.rev) || r.rev < 1) bad("rev must be a whole number from 1");
  if (!LANGS.includes(r.lang)) bad(`lang must be one of ${LANGS.join(", ")}`);
  if (!Number.isInteger(r.base) || r.base < 1 || r.base > 12) bad("base must be a whole number from 1 to 12");
  if (!isObj(r.source) || !SOURCES.includes(r.source.kind) || (r.source.url !== undefined && !isStr(r.source.url))) {
    bad(`source needs kind (${SOURCES.join(", ")}) and an optional url`);
  }

  const dishes = new Set();
  if (!Array.isArray(r.dishes) || r.dishes.length < 1 || r.dishes.length > 2) bad("dishes must list 1 or 2 dishes");
  else r.dishes.forEach((/** @type {any} */ d, /** @type {number} */ i) => {
    if (!isObj(d) || !isStr(d.id) || !DISH.test(d.id) || d.id === "shared" || !isText(d.title) || typeof d.hot !== "boolean") {
      bad(`dishes[${i}] needs id (lowercase, not "shared"), title and hot`); return;
    }
    if (dishes.has(d.id)) bad(`duplicate dish id "${d.id}"`);
    dishes.add(d.id);
  });

  const keys = new Set();
  if (!Array.isArray(r.groups) || r.groups.length === 0) bad("groups must be a non-empty list");
  else r.groups.forEach((/** @type {any} */ g, /** @type {number} */ gi) => {
    if (!isObj(g) || !isText(g.title) || !Array.isArray(g.items)) { bad(`groups[${gi}] needs title and items`); return; }
    g.items.forEach((/** @type {any} */ i, /** @type {number} */ ii) => {
      const at = `groups[${gi}].items[${ii}]`;
      if (!isObj(i)) { bad(`${at} must be an object`); return; }
      if (!isStr(i.k) || !KEY.test(i.k)) { bad(`${at}: k must be 1-40 letters, digits or _ (no "__")`); return; }
      if (keys.has(i.k)) bad(`${at}: duplicate ingredient key "${i.k}"`);
      keys.add(i.k);
      if (!isStr(i.ref) || !REF.test(i.ref)) bad(`${i.k}: ref must be a lowercase id`);
      if (!UNITS.includes(i.u)) bad(`${i.k}: unit must be one of ${UNITS.join(", ")}`);
      if (i.u === "to_taste" ? i.q !== null : !(typeof i.q === "number" && Number.isFinite(i.q) && i.q >= 0 && i.q <= 100000)) {
        bad(`${i.k}: q must be a number from 0 (null only with unit to_taste)`);
      }
      if (!isText(i.n) || i.n.length === 0) bad(`${i.k}: n must be text`);
      if (i.short !== undefined && !(isText(i.short) && i.short.length > 0)) bad(`${i.k}: short must be text`);
      if (i.scale !== undefined && i.scale !== "linear" && i.scale !== "none") bad(`${i.k}: scale must be linear or none`);
      for (const f of ["core", "optional"]) if (i[f] !== undefined && typeof i[f] !== "boolean") bad(`${i.k}: ${f} must be true or false`);
      if (i.core && i.optional) bad(`${i.k}: an ingredient cannot be both core and optional`);
    });
  });

  /**
   * @param {any} t
   * @param {string} at
   */
  const checkText = (t, at) => {
    if (!isText(t)) { bad(`${at}: text must be a string`); return; }
    for (const k of placeholderKeys(t)) if (!keys.has(k)) bad(`${at}: placeholder {${k}} names no ingredient`);
  };
  /**
   * @param {any} sub
   * @param {string} at
   */
  const checkSub = (sub, at) => {
    if (!Array.isArray(sub)) { bad(`${at}: sub must be a list of text`); return; }
    sub.forEach((x, i) => checkText(x, `${at}.sub[${i}]`));
  };

  const stepIds = new Set();
  /**
   * @type {Map<string, string[]>}
   */
  const after = new Map();
  if (!Array.isArray(r.steps) || r.steps.length === 0) bad("steps must be a non-empty list");
  else r.steps.forEach((/** @type {any} */ s, /** @type {number} */ i) => {
    if (!isObj(s) || !isStr(s.id) || !STEP_ID.test(s.id)) { bad(`steps[${i}] needs an id "<phase>.<step>"`); return; }
    const at = `step ${s.id}`;
    if (stepIds.has(s.id)) bad(`${at}: duplicate step id`);
    stepIds.add(s.id);
    if (!isStr(s.dish) || !(s.dish === "shared" || dishes.has(s.dish))) bad(`${at}: dish must be a dish id or "shared"`);
    checkText(s.t, at);
    if (s.sub !== undefined) checkSub(s.sub, at);
    checkTiming(s, at, errs);
    if (!Array.isArray(s.after) || !s.after.every(isStr)) bad(`${at}: after must be a list of step ids`);
    else after.set(s.id, s.after);
    if (s.alt !== undefined) {
      if (!isObj(s.alt)) bad(`${at}: alt must map rule ids to step changes`);
      else for (const [sid, a] of /** @type {[string, any][]} */ (Object.entries(s.alt))) {
        const aat = `${at} alt ${sid}`;
        if (!SUB_ID.test(sid)) bad(`${aat}: bad rule id`);
        if (!isObj(a) || Object.keys(a).length === 0) { bad(`${aat}: must be a non-empty object`); continue; }
        for (const f of Object.keys(a)) if (!ALT_FIELDS.includes(f)) bad(`${aat}: unknown field ${f}`);
        if (has(a, "t")) checkText(a.t, aat);
        if (has(a, "sub")) checkSub(a.sub, aat);
        checkTiming({ ...s, ...a }, aat, errs);
      }
    }
  });
  for (const [id, deps] of after) {
    for (const d of deps) {
      if (d === id) bad(`step ${id}: depends on itself`);
      else if (!stepIds.has(d)) bad(`step ${id}: after names unknown step ${d}`);
    }
  }
  const cycle = findCycle(after);
  if (cycle) bad(`steps form a cycle: ${cycle.join(" -> ")}`);

  // Recipe-level texts per swap rule: the description and the tip, when a swap makes them wrong.
  if (r.alt !== undefined) {
    if (!isObj(r.alt)) bad("alt must map rule ids to { sub, tip }");
    else for (const [sid, a] of /** @type {[string, any][]} */ (Object.entries(r.alt))) {
      if (!SUB_ID.test(sid)) bad(`alt ${sid}: bad rule id`);
      if (!isObj(a) || Object.keys(a).length === 0) { bad(`alt ${sid}: must be a non-empty object`); continue; }
      for (const [f, v] of Object.entries(a)) {
        if (f !== "sub" && f !== "tip") bad(`alt ${sid}: unknown field ${f}`);
        else if (!isText(v)) bad(`alt ${sid}: ${f} must be text`);
      }
    }
  }

  const placed = new Set();
  if (!Array.isArray(r.phases) || r.phases.length === 0) bad("phases must be a non-empty list");
  else r.phases.forEach((/** @type {any} */ p, /** @type {number} */ pi) => {
    if (!isObj(p) || !isText(p.t) || !isText(p.window) || !Array.isArray(p.stepIds)) { bad(`phases[${pi}] needs t, window and stepIds`); return; }
    p.stepIds.forEach((/** @type {any} */ sid, /** @type {number} */ si) => {
      // Step ids are positions, "<phaseIdx>.<stepIdx>": timers and checkmarks are keyed by them.
      if (sid !== `${pi}.${si}`) bad(`phases[${pi}].stepIds[${si}] must be "${pi}.${si}"`);
      if (!stepIds.has(sid)) bad(`phases[${pi}] lists unknown step ${sid}`);
      if (placed.has(sid)) bad(`step ${sid} is in more than one phase`);
      placed.add(sid);
    });
  });
  for (const id of stepIds) if (!placed.has(id)) bad(`step ${id} is in no phase`);
  return errs;
}

/**
 * A dependency cycle (as a list of step ids), or null.
 * @param {Map<string, string[]>} after
 * @returns {string[] | null}
 */
export function findCycle(after) {
  /**
   * @type {Map<string, number>} 1
   */
  const state = new Map();
  /**
   * @type {string[]}
   */
  const stack = [];
  /**
   * @param {string} id
   * @returns {string[] | null}
   */
  const visit = id => {
    if (state.get(id) === 2) return null;
    if (state.get(id) === 1) return [...stack.slice(stack.indexOf(id)), id];
    state.set(id, 1); stack.push(id);
    for (const d of after.get(id) || []) {
      if (!after.has(d)) continue;
      const c = visit(d);
      if (c) return c;
    }
    stack.pop(); state.set(id, 2);
    return null;
  };
  for (const id of after.keys()) { const c = visit(id); if (c) return c; }
  return null;
}
