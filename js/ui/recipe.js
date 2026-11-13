// Recipe reading view. CP1 moved it from the old page; CP2 runs the timer buttons on the persisted
// timer engine and "Keep screen on" on the Wake Lock controller. CP3: schema 2 recipes, tonight's
// allergen toggles (adapted ingredients struck through with the replacement and its rule,
// "Check label" chips, changed and added steps marked), an "At a glance" timeline, and a two-column
// layout on wide screens (iPad landscape). A blocked recipe shows why and stays readable unchanged.
// Checkmark keys stay the old page's ("i:<group>:<k>", "s:<phase>:<step>"), timer keys the CP2
// step keys ("<recipeId>/<phase>.<step>"), so ticks and running timers carry over. A swapped
// ingredient line is ticked separately ("i:<group>:<k>~<rule id>").
import { esc } from "./html.js";
import { icon } from "./icons.js";
import { amounts, names, fill } from "../domain/scale.js";
import { store, KEYS, isBoolMap, isServings } from "../store.js";
import { paintTimerButtons, wireTimerButton } from "./timer-button.js";
import { runtime } from "../timer/app.js";
import { verbFor } from "../timer/engine.js";
import { adapt, reasonText } from "../domain/adapt.js";
import { allergenWords } from "../domain/allergens.js";
import { toggleBarHtml, wireToggleBar, currentToggles, LABEL_NOTE } from "./allergen-bar.js";
import { glanceHtml, wireGlance } from "./glance.js";
import { adaptedSummary } from "./library.js";
import { currentPicks, savePicks, MAX_PICKS } from "./flow.js";
import { markQuickCook, clearQuickCook } from "./setup-view.js";

/** The toggle panel stays open across re-renders of the same recipe. */
const view = { openFor: "" };

/**
 * Checkmark key of a step ("0.1" -> "s:0:1", as on the old page; "+k" -> "s:+k").
 * @param {string} id
 */
export const stepCheckKey = id => "s:" + id.replace(".", ":");

/**
 * Timer key of a step (plan step ids, CP2).
 * @param {string} recipeId
 * @param {string} stepId
 */
export const stepTimerKey = (recipeId, stepId) => recipeId + "/" + stepId;

/**
 * The "Check the label" verdict (CP1 ux-v1, glossary): one plain sentence, never "safe".
 * @param {import('../types').Allergen[] | null} allergens null: not in the table
 */
function checkChip(allergens) {
  const what = allergens && allergens.length ? ` for ${allergenWords(allergens)}` : "";
  return `<span class="chip-check">${icon("tag")}Check the label${esc(what)}</span>`;
}

/**
 * One ingredient line.
 * @param {import('../types').AdaptedLine} l
 * @param {number} gi
 * @param {import('../types').Amounts} a
 * @param {(key: string) => string} ck
 */
function lineHtml(l, gi, a, ck) {
  const st = l.status;
  // A swapped line is a different thing to buy: it gets its own checkmark key, so a tick on the
  // original ("kecap manis, bought") does not carry over to the replacement.
  const key = "i:" + gi + ":" + l.item.k + (st.kind === "swapped" && !l.extraOf ? "~" + st.sub : "");
  let name = esc(l.item.n);
  let cls = "check" + ck(key);
  let amt = esc(a[l.item.k] ?? "");
  if (st.kind === "swapped") {
    cls += " swapped";
    // CP1 (ux-v1, glossary): exactly one verdict per line ("Swapped: <new> (was <old>)"), never
    // a second "Check label" chip on the same line, even when the swap itself still needs one.
    if (l.extraOf) {
      name = `<span class="plus">+</span> <span class="now">${esc(l.item.n)}</span>`;
    } else {
      let verdict = l.was ? `Swapped: ${esc(l.item.n)} (was ${esc(l.was.n)})` : `Swapped: ${esc(l.item.n)}`;
      // CP1 (ux-v1, glossary): exactly one verdict per line, but a swap that itself still needs an
      // allergen label check must keep saying so on that same line, never silently drop it (the
      // summary count still includes this line's check).
      const swapChecks = /** @type {import('../types').Allergen[]} */ (st.checks ?? []);
      if (swapChecks.length) verdict += ` \u00b7 check the label for ${esc(allergenWords(swapChecks))}`;
      name = `<span class="now">${verdict}</span><span class="rule">${icon("swap")}${esc(l.label ?? "")}</span>`;
    }
  } else if (st.kind === "omitted") {
    cls += " omitted";
    amt = "";
    name = `<s class="was">${esc(l.item.n)}</s><span class="sr">: </span><span class="rule">${icon("x")}${esc(l.label ?? "Left out")}</span>`;
  } else if (st.kind === "check") {
    name += checkChip(st.allergens);
  } else if (st.kind === "unknown") {
    name += checkChip(null);
  }
  return `<li class="${cls}" data-key="${esc(key)}" tabindex="0"><span class="q">${amt}</span><span class="nm">${name}</span></li>`;
}

/**
 * @param {HTMLElement} app
 * @param {import('../types').Recipe} r
 */
export function renderRecipe(app, r) {
  // Landing here invalidates any pending quick-path card (CP3); a fresh "Cook this" click below
  // sets it again for this visit.
  clearQuickCook();
  // Stored values are checked: a bad one (old data, a hand-edited backup) reads as the default.
  const storedServ = store.get(KEYS.servings(r.id), r.base);
  /** @type {number} */
  const serv = isServings(storedServ) ? storedServ : r.base;
  const storedChecks = store.get(KEYS.checks(r.id), {});
  /** @type {import('../types').Checks} */
  const checks = isBoolMap(storedChecks) ? storedChecks : {};
  const toggles = currentToggles();
  const result = adapt(r, toggles);
  const blocked = result.kind === "blocked";
  // A blocked recipe stays readable as the original (plan: no override in v0).
  const ad = result.kind === "ok" ? result : /** @type {Extract<import('../types').Adapted, { kind: 'ok' }>} */ (adapt(r, []));
  const rr = ad.recipe;
  const a = amounts(rr, serv);
  const n = names(rr);
  for (const l of ad.lines.flat()) {
    if (l.status.kind === "omitted") { a[l.item.k] = "left out"; n[l.item.k] = l.item.short ?? l.item.n; }
  }
  /** @param {string} key */
  const ck = key => checks[key] ? " done" : "";
  const wantWake = runtime().userWake();
  const open = view.openFor === r.id;
  document.title = r.title;

  let banner = "";
  if (result.kind === "blocked") {
    banner = `<div class="banner blocked" role="note">${icon("hidden")}<div><b>Hidden tonight.</b> `
      + `${esc(result.reasons.map(b => reasonText(b, allergenWords)).join("; "))}. `
      + `This is the original recipe; no swaps are applied.</div></div>`;
  } else if (toggles.length && (ad.swaps || ad.checks)) {
    banner = `<div class="banner adapted" role="note">${icon("swap")}<div><b>Adapted for tonight:</b> ${esc(adaptedSummary(ad))}`
      + (ad.labels.length ? `<ul class="rules">${ad.labels.map(l => `<li>${esc(l)}</li>`).join("")}</ul>` : "")
      + `</div></div>`;
  } else if (toggles.length) {
    banner = `<div class="banner plain" role="note">${icon("check")}<div>No swaps needed for tonight's toggles.</div></div>`;
  }
  // The label note also sits under the shopping list, where the swaps are.
  const note = toggles.length ? `<p class="label-note">${icon("tag")}<span>${esc(LABEL_NOTE)}</span></p>` : "";

  let ing = `<h3>Shopping list</h3>`;
  ad.lines.forEach((gl, gi) => {
    ing += `<div class="sec">${rr.groups.length > 1 ? `<h4>${esc(rr.groups[gi].title)}</h4>` : ""}<ul class="ing">`;
    ing += gl.map(l => lineHtml(l, gi, a, ck)).join("");
    ing += `</ul></div>`;
  });
  ing += note;

  const byId = new Map(rr.steps.map(s => [s.id, s]));
  const changed = new Set(blocked ? [] : ad.changed);
  const added = new Set(blocked ? [] : ad.added);
  // Step tags name the dish by its id ("Mie", "Tofu"): short enough for a phone line.
  const dishName = new Map(rr.dishes.map((d, i) => [d.id, { t: d.title, short: d.id.charAt(0).toUpperCase() + d.id.slice(1), i }]));
  let how = `<h3>How to cook</h3>`;
  rr.phases.forEach((p, pi) => {
    how += `<section class="phase" id="phase-${pi}" tabindex="-1"><header><b>Step ${pi + 1}. ${esc(p.t)}</b><span>${esc(p.window)}</span></header><ol class="steps">`;
    for (const id of p.stepIds) {
      const s = /** @type {import('../types').Step} */ (byId.get(id));
      const key = stepCheckKey(s.id);
      const mark = added.has(s.id) ? `<span class="mark">added</span>` : changed.has(s.id) ? `<span class="mark">changed</span>` : "";
      const dish = rr.dishes.length > 1 ? dishName.get(s.dish) : undefined;
      const tag = dish ? `<span class="dish-tag d${dish.i}" title="${esc(dish.t)}">${esc(dish.short)}</span>` : "";
      how += `<li><div class="txt check${ck(key)}" data-key="${esc(key)}" tabindex="0">${mark}${tag}${esc(fill(s.t, a, n))}`;
      if (s.sub) how += `<ul class="sub">${s.sub.map(x => `<li>${esc(fill(x, a, n))}</li>`).join("")}</ul>`;
      how += `</div>`;
      if (s.timer) how += `<button class="timer" data-tid="${esc(stepTimerKey(r.id, s.id))}" data-sec="${Math.max(0, Math.floor(Number(s.timer)) || 0)}"></button>`;
      how += `</li>`;
    }
    how += `</ol></section>`;
  });
  how += `<div class="tip">${esc(rr.tip)}</div><button class="reset">Clear all checkmarks</button>`;

  app.innerHTML = `<div class="top"><a class="back" href="#">‹ Recipes</a>
    <button class="wake" aria-pressed="${wantWake}" title="The screen stays on while the recipe is open">Keep screen on</button></div>
    <div class="rpage">
    <header class="rhead"><h1 class="rtitle">${esc(r.title)}</h1><p class="rsub">${esc(rr.sub)} Takes ${esc(r.time)}.</p></header>
    ${toggleBarHtml(toggles, { open })}
    ${banner}
    ${blocked ? "" : `<div class="cook-btns">
      <a class="btn btn-main" href="#/setup" data-cook-this>${icon("dishes")}Cook this</a>
      ${currentPicks().some(p => p.recipeId === r.id) ? `<a class="btn" href="#/tonight">${icon("check")}On tonight's list</a>`
        : currentPicks().length < MAX_PICKS ? `<a class="btn" href="#/tonight" data-add-tonight>Add to tonight</a>` : ""}
    </div>`}
    ${glanceHtml(rr)}
    <div class="rgrid">
      <div class="col-ing">
        <div class="serv"><div class="lbl">Servings<small>Amounts update automatically</small></div>
          <button class="step-btn" data-d="-1" aria-label="Fewer servings">−</button>
          <span class="n" aria-live="polite">${esc(serv)}</span>
          <button class="step-btn" data-d="1" aria-label="More servings">+</button></div>
        ${ing}
      </div>
      <div class="col-steps">${how}</div>
    </div></div>`;

  /** @param {string} sel */
  const all = sel => /** @type {HTMLElement[]} */ ([...app.querySelectorAll(sel)]);
  const rerender = () => { const y = window.scrollY; renderRecipe(app, r); window.scrollTo(0, y); };

  /** @type {Map<string, { label: string, verb: string, wait?: import('../types').Wait }>} */
  const timed = new Map();
  for (const s of rr.steps) {
    if (!s.timer) continue;
    timed.set(stepTimerKey(r.id, s.id), { label: fill(s.t, a, n), verb: s.then ?? verbFor(s.t), wait: s.wait });
  }
  all(".timer").forEach(b => {
    const info = timed.get(b.dataset.tid ?? "");
    if (info) wireTimerButton(b, info);
  });
  paintTimerButtons(app);

  wireToggleBar(app, rerender, { onToggleOpen: () => { view.openFor = open ? "" : r.id; rerender(); } });
  wireGlance(app);
  // Weeknight shortcut: "Cook this" makes this recipe tonight's only pick and opens Setup.
  app.querySelector("[data-cook-this]")?.addEventListener("click", () => { savePicks([{ recipeId: r.id, servings: serv }]); markQuickCook([r.id]); });
  app.querySelector("[data-add-tonight]")?.addEventListener("click", () => savePicks([...currentPicks(), { recipeId: r.id, servings: serv }]));

  all(".step-btn").forEach(b => b.onclick = () => {
    const v = Math.min(12, Math.max(1, serv + +(b.dataset.d ?? 0)));
    store.set(KEYS.servings(r.id), v); rerender();
  });
  /** @param {HTMLElement} el */
  const toggle = el => {
    const k = /** @type {string} */ (el.dataset.key); checks[k] = !checks[k]; if (!checks[k]) delete checks[k];
    store.set(KEYS.checks(r.id), checks); el.classList.toggle("done", !!checks[k]);
  };
  all(".check").forEach(el => {
    el.onclick = () => toggle(el);
    el.onkeydown = e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(el); } };
  });
  /** @type {HTMLElement} */ (app.querySelector(".wake")).onclick = () => {
    const rt = runtime();
    rt.setUserWake(!rt.userWake());
    app.querySelector(".wake")?.setAttribute("aria-pressed", String(rt.userWake()));
  };
  /** @type {HTMLElement} */ (app.querySelector(".reset")).onclick = () => {
    store.set(KEYS.checks(r.id), {}); all(".check.done").forEach(e => e.classList.remove("done"));
  };
}
