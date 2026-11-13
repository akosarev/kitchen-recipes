// #/tonight: pick one or two recipes for tonight, each with its servings; the allergen toggles are
// the same panel as on Library and Recipe. A recipe tonight's toggles hide cannot be picked.
import { esc } from "./html.js";
import { icon } from "./icons.js";
import { adapt, reasonText } from "../domain/adapt.js";
import { allergenWords } from "../domain/allergens.js";
import { toggleBarHtml, wireToggleBar, currentToggles } from "./allergen-bar.js";
import { adaptedSummary } from "./library.js";
import { currentPicks, savePicks, lastServings, flowNav, MAX_PICKS } from "./flow.js";
import { stripHtml } from "./glance.js";
import { clearQuickCook, isAllergyEditFromQuickCook } from "./setup-view.js";

const view = { open: false };

/**
 * @param {HTMLElement} app
 * @param {import('../types').Recipe[]} recipes
 */
export function renderTonight(app, recipes) {
  // Landing here (not via "Cook this") invalidates any pending quick-path card (CP3). Exception
  // (CP3 F1 fix): the quick card's own "Change allergies" link sent the user here on purpose, to
  // review/change allergies and come straight back to that same card — don't drop its marker then.
  if (!isAllergyEditFromQuickCook()) clearQuickCook();
  document.title = "Tonight";
  const toggles = currentToggles();
  // Picks that tonight's toggles now block are dropped.
  let picks = currentPicks().filter(p => {
    const r = recipes.find(x => x.id === p.recipeId);
    return r && adapt(r, toggles).kind === "ok";
  });
  if (picks.length !== currentPicks().length) savePicks(picks);
  const full = picks.length >= MAX_PICKS;

  const cards = recipes.map((r, idx) => {
    const a = adapt(r, toggles);
    const pick = picks.find(p => p.recipeId === r.id);
    const blocked = a.kind === "blocked";
    const state = blocked
      ? `<p class="why">${icon("hidden")}${esc(a.reasons.map(b => reasonText(b, allergenWords)).join("; "))}</p>`
      : toggles.length && adaptedSummary(a) ? `<p class="badge adapted">${icon("swap")}<span>${esc(adaptedSummary(a))}</span></p>` : "";
    const disabled = blocked || (!pick && full);
    const serv = pick ? `<div class="serv mini" data-serv="${esc(r.id)}"><span class="lbl">Servings</span>
        <button class="step-btn" data-d="-1" aria-label="Fewer servings for ${esc(r.title)}">−</button>
        <span class="n" aria-live="polite">${esc(pick.servings)}</span>
        <button class="step-btn" data-d="1" aria-label="More servings for ${esc(r.title)}">+</button></div>` : "";
    return `<li class="pick c${idx % 3}${pick ? " on" : ""}${blocked ? " blocked" : ""}">
      <button type="button" class="pick-btn" data-pick="${esc(r.id)}" aria-pressed="${!!pick}"${disabled ? " disabled" : ""}>
        <span class="pick-mark" aria-hidden="true">${pick ? icon("check") : ""}</span>
        <span class="pick-body"><b>${esc(r.title)}</b><span class="pick-meta">${esc(r.time)}${r.dishes.length > 1 ? ` · ${r.dishes.length} dishes` : ""}</span>
        <span class="strip-row">${stripHtml(r)}</span></span>
      </button>${state}${serv}</li>`;
  }).join("");

  app.innerHTML = `<div class="top"><a class="back" href="#">‹ Recipes</a></div>
    <div class="flow">
    ${flowNav(1)}
    <h1 class="rtitle">Tonight</h1>
    <p class="rsub">Pick one recipe, or two to cook side by side.${full ? " Two at most." : ""}</p>
    ${toggleBarHtml(toggles, { open: view.open })}
    <ul class="picks">${cards}</ul>
    <div class="flow-foot"><a class="btn btn-main next${picks.length ? "" : " off"}" href="#/setup"${picks.length ? "" : ' aria-disabled="true"'}>Next: setup</a></div>
    </div>`;

  const rerender = () => { const y = window.scrollY; renderTonight(app, recipes); window.scrollTo(0, y); };
  wireToggleBar(app, rerender, { onToggleOpen: () => { view.open = !view.open; rerender(); } });
  app.querySelectorAll("[data-pick]").forEach(el => {
    const b = /** @type {HTMLButtonElement} */ (el);
    b.onclick = () => {
      const id = /** @type {string} */ (b.dataset.pick);
      const cur = currentPicks();
      const r = /** @type {import('../types').Recipe} */ (recipes.find(x => x.id === id));
      savePicks(cur.some(p => p.recipeId === id) ? cur.filter(p => p.recipeId !== id)
        : cur.length < MAX_PICKS ? [...cur, { recipeId: id, servings: lastServings(r) }] : cur);
      rerender();
    };
  });
  app.querySelectorAll("[data-serv] .step-btn").forEach(el => {
    const b = /** @type {HTMLElement} */ (el);
    b.onclick = () => {
      const id = /** @type {HTMLElement} */ (b.closest("[data-serv]")).dataset.serv;
      savePicks(currentPicks().map(p => p.recipeId === id ? { ...p, servings: Math.min(12, Math.max(1, p.servings + Number(b.dataset.d))) } : p));
      rerender();
    };
  });
  const next = /** @type {HTMLElement} */ (app.querySelector(".next"));
  next.onclick = e => { if (!currentPicks().length) e.preventDefault(); };
  window.scrollTo(0, 0);
}
