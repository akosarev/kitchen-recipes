// #/setup: tonight's equipment and serve time (docs/v0-plan.md section 8, step 2). Prefilled from
// the last setup; "Next" saves it (km.v1.lastSetup) and opens the plan. With a saved setup the
// screen first shows one "Looks right" card (the weeknight shortcut). Missing equipment is named
// with a fix ("Mie Goreng Udang needs a wok": use a pan for wok steps, or "I have one").
import { esc } from "./html.js";
import { icon } from "./icons.js";
import { LIMITS, hhmm } from "../setup.js";
import { missingEquipment } from "../domain/scheduler.js";
import { adapt } from "../domain/adapt.js";
import { TOGGLES } from "../domain/allergens.js";
import { currentToggles } from "./allergen-bar.js";
import { pickedRecipes, savedSetup, startSetup, saveSetup, flowNav } from "./flow.js";
import { startCookingNow } from "./cook-start.js";

/** Shown once per app session (plan section 8). */
export const ALARM_LINE = "Alarms work only while Kitchen Master is open and the screen is on. Keep it on the counter, unlocked.";

const NAMES = /** @type {Record<string, [string, string]>} */ ({
  burner: ["burner", "burners"], pot: ["pot", "pots"], pan: ["frying pan", "frying pans"], wok: ["wok", "woks"], oven: ["oven", "ovens"],
});

/**
 * @param {string} kind
 * @param {number} n
 */
const named = (kind, n) => `${n} ${NAMES[kind][n === 1 ? 0 : 1]}`;

/**
 * One-line summary of a setup: "4 burners · wok · 1 frying pan · 2 pots · serve ASAP".
 * @param {import('../types').CookSetup} s
 */
export function setupSummary(s) {
  const parts = [named("burner", s.burner)];
  if (s.wok) parts.push("wok");
  else if (s.wokFallbackPan) parts.push("no wok (pan instead)");
  parts.push(named("pan", s.pan), named("pot", s.pot));
  if (s.oven) parts.push("oven");
  parts.push(s.serveAt === "asap" ? "serve ASAP" : `serve at ${hhmm(s.serveAt)}`);
  return parts.join(" · ");
}

/** Draft setup while the screen is open, and whether the full form is shown. */
const view = { draft: /** @type {import('../types').CookSetup | null} */ (null), form: false };

/**
 * Open the setup screen with the full form (from "Change setup" on the plan).
 */
export function openSetupForm() { view.form = true; view.draft = null; }

/**
 * sessionStorage key for the one-shot "came from Cook this" marker (CP3 quick path): a plain JS
 * module flag would leak across unrelated Setup visits in the same tab (e.g. a user who opened the
 * recipe, tapped "Cook this", then much later lands on #/setup a different way); sessionStorage is
 * consumed (removed) the first time it is read, same one-shot idea as ALARM_LINE above.
 */
const QUICK_KEY = "km.quickCook";

/**
 * sessionStorage key: the quick card's own "Change allergies" link set this right before
 * navigating to #/tonight (CP3 F1 fix). Tonight's render checks it to tell "the quick card sent me
 * here to edit allergies" apart from any other way of landing on #/tonight, which must still
 * invalidate the quick marker (see `clearQuickCook` below).
 */
const ALLERGY_EDIT_KEY = "km.quickCook.fromCard";

/**
 * Mark the next Setup render as reached via "Cook this" (CP3 quick path: ./recipe.js's
 * `[data-cook-this]` handler calls this alongside `savePicks`). Records the recipe id(s) picked at
 * that moment (CP3 F2 fix): the quick card is only valid for the exact recipe(s) the user actually
 * tapped "Cook this" on, so later a diverging set of picks (e.g. swapped during the "Change
 * allergies" Tonight detour) can be told apart from a mere servings/toggle change.
 * @param {readonly string[]} recipeIds
 */
export function markQuickCook(recipeIds) {
  // A fresh visit: start the draft from the current saved setup (or the default), not from
  // whatever was left over from an earlier, unrelated Setup visit, and not stuck on the form.
  view.draft = null;
  view.form = false;
  try { sessionStorage.setItem(QUICK_KEY, JSON.stringify([...recipeIds].sort())); } catch { /* per page then */ }
}

/**
 * Mark that the next #/tonight render was reached via the quick card's "Change allergies" link
 * (CP3 F1 fix), so that render can skip `clearQuickCook` and the user lands back on the
 * allergy-updated quick card instead of the full Setup form. Called from the link's click handler,
 * which fires synchronously before the browser follows the `href="#/tonight"` navigation.
 */
export function markAllergyEditFromQuickCook() { try { sessionStorage.setItem(ALLERGY_EDIT_KEY, "1"); } catch { /* per page then */ } }

/**
 * Whether the pending Tonight visit was reached via the quick card's "Change allergies" link.
 * Read-only (not cleared here): Tonight's own re-renders (toggle clicks, etc.) must keep seeing
 * this as true for the whole visit, not just the first render — it is cleared only by
 * `clearQuickCook` (landing on any other screen, or truly leaving the quick-path loop).
 */
export function isAllergyEditFromQuickCook() {
  try { return sessionStorage.getItem(ALLERGY_EDIT_KEY) === "1"; } catch { return false; }
}

/**
 * Invalidate a pending "Cook this" marker: landing on any other screen (Library, Recipe, Tonight,
 * Plan, Cook) without going through Setup means the shortcut no longer applies. Each of those
 * screens calls this at the top of its own render. Tonight's render calls this too, except for the
 * visit initiated by the quick card's own "Change allergies" link (see `isAllergyEditFromQuickCook`
 * above) — any other route into Tonight still clears both markers here.
 */
export function clearQuickCook() { try { sessionStorage.removeItem(QUICK_KEY); sessionStorage.removeItem(ALLERGY_EDIT_KEY); } catch { /* ignore */ } }

/**
 * Whether the pending "Cook this" marker still applies to the given recipe ids (CP3 F2 fix): the
 * id set recorded by `markQuickCook` must equal the current picks' recipe ids (order does not
 * matter; servings may differ — only the recipe identities must match). Read-only, does not clear
 * the marker; a mismatch is handled by the caller (treat as no quick card this render).
 * @param {readonly string[]} recipeIds
 */
function quickCookMatches(recipeIds) {
  let raw;
  try { raw = sessionStorage.getItem(QUICK_KEY); } catch { return false; }
  if (!raw) return false;
  let ids;
  try { ids = JSON.parse(raw); } catch { return false; }
  if (!Array.isArray(ids)) return false;
  const current = [...recipeIds].sort();
  return ids.length === current.length && ids.every((id, i) => id === current[i]);
}

/** Read the pending "Cook this" marker's presence without clearing it (does not check recipe ids). */
function hasQuickCook() {
  try { return sessionStorage.getItem(QUICK_KEY) !== null; } catch { return false; }
}

/**
 * Tonight's allergen choice in plain words, never "safe" (CP1 ux-v1 glossary).
 * @param {readonly import('../types').Toggle[]} toggles
 */
function allergyLine(toggles) {
  const names = TOGGLES.filter(([id]) => toggles.includes(id)).map(([, l]) => l);
  return names.length ? `Without: ${names.join(", ")}` : "Allergies: none";
}

/**
 * @param {HTMLElement} app
 * @param {import('../types').Recipe[]} recipes
 */
export function renderSetup(app, recipes) {
  document.title = "Setup";
  const picks = pickedRecipes(recipes);
  // Stays true across re-renders of this same Setup visit (toggle changes, etc.); any other
  // screen's render invalidates it first (clearQuickCook above). CP3 F2 fix: also requires the
  // current picks' recipe ids to still match what `markQuickCook` recorded — a pick swap during
  // the "Change allergies" Tonight detour (or any other route) must fall back to the full form
  // instead of showing the quick-confirm card for a recipe never vetted via "Cook this".
  const quickPending = hasQuickCook();
  const quickValid = quickPending && quickCookMatches(picks.map(p => p.recipe.id));
  if (quickPending && !quickValid) clearQuickCook();
  const quick = !view.form && quickValid;
  const saved = savedSetup();
  const d = view.draft ?? (view.draft = startSetup());
  const showForm = view.form || (!quick && !saved);
  let alarmLine = "";
  try {
    if (!sessionStorage.getItem("km.alarmLine")) { sessionStorage.setItem("km.alarmLine", "1"); alarmLine = ALARM_LINE; }
  } catch { alarmLine = ALARM_LINE; }

  if (!picks.length) {
    app.innerHTML = `<div class="top"><a class="back" href="#/tonight">‹ Tonight</a></div><div class="flow">${flowNav(2)}
      <h1 class="rtitle">Setup</h1><p class="rsub">Pick a recipe for tonight first.</p>
      <div class="flow-foot"><a class="btn btn-main" href="#/tonight">Pick recipes</a></div></div>`;
    window.scrollTo(0, 0);
    return;
  }
  const toggles = currentToggles();
  const adapted = picks.map(p => { const a = adapt(p.recipe, toggles); return { recipe: a.kind === "ok" ? a.recipe : p.recipe }; });
  const missing = missingEquipment(adapted, d);
  const titleOf = /** @param {string} id */ id => recipes.find(r => r.id === id)?.title ?? id;
  const fixes = missing.map(m => {
    const wokFix = m.kind === "wok" ? `<button type="button" class="btn small" data-fix="fallback">Use a frying pan for wok steps</button>` : "";
    const max = LIMITS[/** @type {keyof typeof LIMITS} */ (m.kind)]?.[1] ?? 0;
    const add = m.need <= max ? `<button type="button" class="btn small" data-fix="set" data-kind="${esc(m.kind)}" data-n="${m.need}">I have ${esc(named(m.kind, m.need))}</button>` : "";
    return `<div class="banner blocked" role="alert">${icon("alert")}<div><b>${esc(titleOf(m.recipeId))} needs ${esc(named(m.kind, m.need))}.</b>
      <div class="fix-btns">${wokFix}${add}</div></div></div>`;
  }).join("");

  const stepper = (/** @type {'burner' | 'pot' | 'pan'} */ k, /** @type {string} */ label) => {
    const [lo, hi] = LIMITS[k];
    return `<div class="row"><span class="lbl">${esc(label)}</span>
      <button class="step-btn" data-k="${k}" data-d="-1" aria-label="Fewer ${esc(label.toLowerCase())}"${d[k] <= lo ? " disabled" : ""}>−</button>
      <span class="n" aria-live="polite">${d[k]}</span>
      <button class="step-btn" data-k="${k}" data-d="1" aria-label="More ${esc(label.toLowerCase())}"${d[k] >= hi ? " disabled" : ""}>+</button></div>`;
  };
  const sw = (/** @type {'wok' | 'oven'} */ k, /** @type {string} */ label) =>
    `<div class="row"><span class="lbl">${esc(label)}</span><button type="button" class="switch" data-sw="${k}" role="switch" aria-checked="${d[k] === 1}" aria-label="${esc(label)}"><span>${d[k] ? "Yes" : "No"}</span></button></div>`;
  const serveTime = d.serveAt === "asap" ? "" : hhmm(d.serveAt);
  const form = `<section class="card setup-form" aria-label="Equipment">
      <h3>Equipment tonight</h3>
      ${stepper("burner", "Burners")}${stepper("pot", "Pots")}${stepper("pan", "Frying pans")}${sw("wok", "Wok")}${sw("oven", "Oven")}
      ${!d.wok ? `<div class="row"><span class="lbl">Wok steps in a frying pan</span><button type="button" class="switch" data-sw="wokFallbackPan" role="switch" aria-checked="${d.wokFallbackPan}" aria-label="Wok steps in a frying pan"><span>${d.wokFallbackPan ? "Yes" : "No"}</span></button></div>` : ""}
    </section>
    <section class="card" aria-label="Serve time">
      <h3>Serve</h3>
      <div class="seg" role="radiogroup" aria-label="Serve time">
        <button type="button" role="radio" class="seg-btn" data-serve="asap" aria-checked="${d.serveAt === "asap"}">As soon as it's ready</button>
        <button type="button" role="radio" class="seg-btn" data-serve="time" aria-checked="${d.serveAt !== "asap"}">At a time</button>
      </div>
      ${d.serveAt !== "asap" ? `<label class="time-row">Serve at <input type="time" class="serve-time" value="${esc(serveTime)}" step="300"></label>` : ""}
    </section>`;
  const card = `<section class="card looks" aria-label="Last setup">
      <h3>Same as last time?</h3>
      <p class="setup-sum">${esc(setupSummary(d))}</p>
      <div class="fix-btns"><a class="btn btn-main" href="#/plan" data-looks-right>Looks right</a><button type="button" class="btn" data-change>Change</button></div>
    </section>`;
  const totalServ = picks.reduce((sum, p) => sum + p.servings, 0);
  const quickCard = `<section class="card looks quick-check" aria-label="Looks right?">
      <h2>Looks right?</h2>
      <p class="servings-line">For ${totalServ} ${totalServ === 1 ? "person" : "people"}</p>
      <p class="setup-sum">${esc(setupSummary(d))}</p>
      <p class="allergy-line">${esc(allergyLine(toggles))}</p>
      <a class="btn allergy-change" href="#/tonight" data-change-allergens>Change allergies</a>
      <div class="fix-btns">
        <button type="button" class="btn btn-main" data-start-cooking${missing.length ? ' aria-disabled="true"' : ""}>Start cooking</button>
        <button type="button" class="btn" data-change>Change</button>
      </div>
    </section>`;

  app.innerHTML = `<div class="top"><a class="back" href="#/tonight">‹ Tonight</a></div>
    <div class="flow">
    ${flowNav(2)}
    <h1 class="rtitle">Setup</h1>
    <p class="rsub">Cooking ${esc(picks.map(p => `${p.recipe.title} (${p.servings})`).join(" and "))}.</p>
    ${fixes}
    ${showForm ? form : quick ? quickCard : card}
    ${alarmLine ? `<p class="label-note">${icon("alert")}<span>${esc(alarmLine)}</span></p>` : ""}
    ${showForm ? `<div class="flow-foot"><a class="btn btn-main next${missing.length ? " off" : ""}" href="#/plan"${missing.length ? ' aria-disabled="true"' : ""}>Next: plan</a></div>` : ""}
    </div>`;

  const rerender = () => { const y = window.scrollY; renderSetup(app, recipes); window.scrollTo(0, y); };
  /** @param {(s: import('../types').CookSetup) => void} f */
  const change = f => { f(d); rerender(); };
  app.querySelectorAll(".step-btn[data-k]").forEach(el => {
    const b = /** @type {HTMLButtonElement} */ (el);
    b.onclick = () => change(s => {
      const k = /** @type {'burner' | 'pot' | 'pan'} */ (b.dataset.k);
      const [lo, hi] = LIMITS[k];
      s[k] = Math.min(hi, Math.max(lo, s[k] + Number(b.dataset.d)));
    });
  });
  app.querySelectorAll("[data-sw]").forEach(el => {
    const b = /** @type {HTMLElement} */ (el);
    b.onclick = () => change(s => {
      if (b.dataset.sw === "wokFallbackPan") s.wokFallbackPan = !s.wokFallbackPan;
      else { const k = /** @type {'wok' | 'oven'} */ (b.dataset.sw); s[k] = s[k] ? 0 : 1; }
    });
  });
  app.querySelectorAll("[data-fix]").forEach(el => {
    const b = /** @type {HTMLElement} */ (el);
    b.onclick = () => { view.form = true; change(s => {
      if (b.dataset.fix === "fallback") { s.wokFallbackPan = true; s.pan = Math.max(1, s.pan); }
      else { const k = /** @type {'burner' | 'pot' | 'pan' | 'wok' | 'oven'} */ (b.dataset.kind); s[k] = /** @type {any} */ (Number(b.dataset.n)); }
    }); };
  });
  app.querySelectorAll("[data-serve]").forEach(el => {
    const b = /** @type {HTMLElement} */ (el);
    b.onclick = () => change(s => {
      if (b.dataset.serve === "asap") s.serveAt = "asap";
      else if (s.serveAt === "asap") {
        const now = new Date();
        // Default: the next quarter hour, an hour from now.
        s.serveAt = (Math.ceil((now.getHours() * 60 + now.getMinutes() + 60) / 15) * 15) % (24 * 60);
      }
    });
  });
  const time = /** @type {HTMLInputElement | null} */ (app.querySelector(".serve-time"));
  if (time) time.onchange = () => {
    const m = /^(\d{2}):(\d{2})$/.exec(time.value);
    if (m) change(s => { s.serveAt = Number(m[1]) * 60 + Number(m[2]); });
  };
  app.querySelector("[data-change]")?.addEventListener("click", () => { view.form = true; rerender(); });
  app.querySelector("[data-change-allergens]")?.addEventListener("click", () => { markAllergyEditFromQuickCook(); });
  app.querySelector("[data-start-cooking]")?.addEventListener("click", () => {
    if (missing.length) return;
    saveSetup(d);
    view.form = false; view.draft = null; clearQuickCook();
    startCookingNow(picks, toggles, d, () => renderSetup(app, recipes));
  });
  app.querySelectorAll(".next, [data-looks-right]").forEach(el => {
    /** @type {HTMLElement} */ (el).onclick = e => {
      if (missing.length) { e.preventDefault(); return; }
      saveSetup(d);
      view.form = false; view.draft = null;
    };
  });
  window.scrollTo(0, 0);
}
