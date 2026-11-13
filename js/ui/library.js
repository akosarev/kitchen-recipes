// Home / library view ("My recipes"). Tonight's allergen toggles and "Plan tonight" share one row at the
// top; the cards are compact so several recipes fit one phone screen. Each card shows
// its phases as a strip, its facts, and either what it contains (no toggles) or how tonight's
// toggles change it. Blocked recipes go behind "Show N hidden" with the reason, and stay readable.
import { esc } from "./html.js";
import { icon } from "./icons.js";
import { store, KEYS, isServings } from "../store.js";
import { adapt, reasonText } from "../domain/adapt.js";
import { allergenWords, recipeContains, TOGGLES } from "../domain/allergens.js";
import { toggleBarHtml, wireToggleBar, currentToggles } from "./allergen-bar.js";
import { stripHtml } from "./glance.js";
import { clearQuickCook } from "./setup-view.js";

/** The toggle panel's open state while the Library is shown. */
const view = { open: false, q: "" };

/**
 * Stored servings, or the recipe's base when the stored value is not a valid count.
 * @param {import('../types').Recipe} r
 */
function servings(r) {
  const v = store.get(KEYS.servings(r.id), r.base);
  return isServings(v) ? v : r.base;
}

/**
 * @param {number} n
 * @param {string} one
 * @param {string} many
 */
const count = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/**
 * What tonight's toggles do to a recipe, as a short line ("2 swaps · 1 label check"), or "".
 * @param {Extract<import('../types').Adapted, { kind: 'ok' }>} a
 */
export function adaptedSummary(a) {
  const parts = [];
  if (a.swaps) parts.push(`${count(a.swaps, "ingredient", "ingredients")} swapped`);
  if (a.checks) parts.push(`check ${count(a.checks, "label", "labels")}`);
  return parts.join(" · ");
}

/**
 * @param {import('../types').Recipe} r
 * @param {Extract<import('../types').Adapted, { kind: 'ok' }>} a
 * @param {readonly import('../types').Toggle[]} toggles
 * @param {number} idx position in the full list: the card's colour stays when others hide
 */
function card(r, a, toggles, idx) {
  const facts = `<div class="facts">`
    + `<span>${icon("clock")}${esc(r.time)}</span>`
    + `<span>${icon("serves")}serves ${esc(servings(r))}</span>`
    + (r.dishes.length > 1 ? `<span>${icon("dishes")}${r.dishes.length} dishes</span>` : "")
    + `</div>`;
  let state = "";
  if (toggles.length) {
    const s = adaptedSummary(a);
    if (s) state = `<p class="badge adapted">${icon("swap")}<span>${esc(s)}</span></p>`;
  } else {
    const c = recipeContains(r);
    const labels = new Map(TOGGLES);
    const items = c.toggles.map(t => `<span class="ct">${icon(t)}${esc(/** @type {string} */ (labels.get(t)))}</span>`);
    if (c.unknown) items.push(`<span class="ct">${icon("tag")}check labels</span>`);
    if (items.length) state = `<p class="contains"><span class="ct-h">Contains</span>${items.join("")}</p>`;
  }
  return `<a class="dish c${idx % 3}" href="#${esc(r.id)}">
      <h2>${esc(r.title)}</h2><p>${esc(a.recipe.sub)}</p>
      <div class="strip-row">${stripHtml(r)}</div>
      ${facts}${state}</a>`;
}

/** The search box appears once the list is longer than a couple of screens on a phone. */
export const SEARCH_MIN = 8;

/**
 * Lower case without accents, so "pate" finds "Pâté".
 * @param {string} x
 */
const fold = x => x.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();

/**
 * Does the recipe match the search text? Every word must appear in its title, subtitle, dish
 * titles or ingredient names.
 * @param {import('../types').Recipe} r
 * @param {string} q
 */
export function matches(r, q) {
  const words = fold(q).split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const hay = fold([r.title, r.sub, ...r.dishes.map(d => d.title), ...r.groups.flatMap(g => g.items.map(i => i.n))].join(" \n "));
  return words.every(w => hay.includes(w));
}

/**
 * @param {HTMLElement} app
 * @param {import('../types').Recipe[]} recipes
 */
export function renderLibrary(app, recipes) {
  // Landing here (not via "Cook this") invalidates any pending quick-path card (CP3).
  clearQuickCook();
  document.title = "My recipes";
  const toggles = currentToggles();
  const results = recipes.map((r, idx) => ({ r, idx, a: adapt(r, toggles) }));
  const shown = results.filter(x => x.a.kind === "ok");
  const hidden = results.filter(x => x.a.kind === "blocked");
  const hiddenHtml = hidden.length ? `<details class="hidden-list">
      <summary>${icon("hidden")}<span>Show ${hidden.length} hidden</span>${icon("chevron", "ic chev")}</summary>
      <ul>${hidden.map(({ r, a }) => `<li><a href="#${esc(r.id)}"><b>${esc(r.title)}</b>`
        + `<span class="why">${a.kind === "blocked" ? esc(a.reasons.map(b => reasonText(b, allergenWords)).join("; ")) : ""}</span>`
        + `<span class="hint">Opens the original recipe, unchanged.</span></a></li>`).join("")}</ul>
    </details>` : "";
  app.innerHTML = `<div class="home">
    <header class="home-head"><h1>My recipes</h1></header>
    <div class="home-tools">${toggleBarHtml(toggles, { open: view.open })}
    <a class="plan-cta" href="#/tonight">${icon("dishes")}<b>Plan tonight</b>${icon("chevron", "ic chev-r")}</a></div>
    ${recipes.length >= SEARCH_MIN ? `<label class="search">${icon("search")}<span class="sr">Search recipes</span>
      <input type="search" data-search placeholder="Search: dish or ingredient" autocomplete="off" autocapitalize="off" spellcheck="false" enterkeyhint="search" value="${esc(view.q)}"></label>
      <p class="empty" data-nomatch hidden>No recipe matches. <button type="button" class="linkish" data-clear-search>Clear the search</button></p>` : ""}
    <div class="cards">${shown.map(({ r, a, idx }) => card(r, /** @type {any} */ (a), toggles, idx)).join("")}</div>
    ${!shown.length && hidden.length ? `<p class="empty">No recipe fits tonight's toggles.</p>` : ""}
    ${hiddenHtml}
  </div>`;
  const rerender = () => {
    const y = window.scrollY;
    const open = /** @type {HTMLDetailsElement | null} */ (app.querySelector(".hidden-list"))?.open;
    renderLibrary(app, recipes);
    if (open) { const d = /** @type {HTMLDetailsElement | null} */ (app.querySelector(".hidden-list")); if (d) d.open = true; }
    window.scrollTo(0, y);
  };
  wireToggleBar(app, rerender, { onToggleOpen: () => { view.open = !view.open; rerender(); } });
  // Search hides cards in place (no re-render: the keyboard and the caret stay where they are).
  const box = /** @type {HTMLInputElement | null} */ (app.querySelector("[data-search]"));
  if (box) {
    const cards = /** @type {HTMLElement[]} */ ([...app.querySelectorAll(".cards > .dish")]);
    const none = /** @type {HTMLElement} */ (app.querySelector("[data-nomatch]"));
    const apply = () => {
      view.q = box.value;
      let n = 0;
      shown.forEach(({ r }, i) => { const ok = matches(r, view.q); cards[i].hidden = !ok; if (ok) n++; });
      none.hidden = n > 0 || !shown.length;
    };
    box.addEventListener("input", apply);
    /** @type {HTMLElement} */ (app.querySelector("[data-clear-search]")).addEventListener("click", () => { box.value = ""; apply(); box.focus(); });
    apply();
  }
  window.scrollTo(0, 0);
}
