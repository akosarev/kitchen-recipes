// Tonight's allergen toggles (plan section 7, UI rules): nine chips, each a toggle button with an
// icon and a word (pressed state also shown by a check mark, never by colour alone). Library and
// Recipe show the same bar and write the same draft (km.v1.tonight).
import { esc } from "./html.js";
import { icon } from "./icons.js";
import { TOGGLES } from "../domain/allergens.js";
import { store, KEYS } from "../store.js";
import { readToggles, writeToggles } from "../tonight.js";
import { runtime } from "../timer/app.js";

/** Shown wherever toggles are on (plan section 7: footer on adapted views). */
export const LABEL_NOTE = "Rule-based swaps from a fixed table. Check every label; brands vary.";

/** Tonight's toggles (an expired draft is dropped). */
export const currentToggles = () => readToggles(store, KEYS.tonight, runtime().now());

/**
 * @param {Iterable<import('../types').Toggle>} toggles
 */
export const saveToggles = toggles => writeToggles(store, KEYS.tonight, toggles, runtime().now());

/**
 * The chip grid.
 * @param {readonly import('../types').Toggle[]} active
 */
export function chipsHtml(active) {
  return `<div class="chips" role="group" aria-label="Allergens to avoid tonight">${TOGGLES.map(([id, label]) => {
    const on = active.includes(id);
    return `<button type="button" class="chip-a${on ? " on" : ""}" data-toggle="${esc(id)}" aria-pressed="${on}">`
      + `${icon(id)}<span>${esc(label)}</span>${on ? icon("check", "ic tick") : ""}</button>`;
  }).join("")}</div>`;
}

/** Prompt on the closed panel when no toggle is on. */
export const PROMPT = "Avoiding anything?";

/**
 * Tonight's toggle panel: a summary row ("Avoiding tonight: Gluten, Soy") with a disclosure button
 * that opens the nine chips (progressive disclosure, so the recipes stay on the first screen).
 * Library and Recipe show the same panel; `open` keeps it expanded across re-renders.
 * @param {readonly import('../types').Toggle[]} active
 * @param {{ open?: boolean }} [o]
 */
export function toggleBarHtml(active, o = {}) {
  const names = TOGGLES.filter(([id]) => active.includes(id)).map(([, l]) => l);
  const clear = active.length ? `<button type="button" class="link-btn clear-toggles">Clear</button>` : "";
  const summary = names.length ? `Avoiding tonight: <b>${esc(names.join(", "))}</b>` : esc(PROMPT);
  const icons = names.length ? "" : `<span class="tonight-icons" aria-hidden="true">${TOGGLES.slice(0, 5).map(([id]) => icon(id)).join("")}</span>`;
  return `<section class="tonight${o.open ? " open" : ""}${names.length ? " active" : ""}" aria-label="Tonight's allergens">
      <div class="tonight-row">${icon(names.length ? "alert" : "serves")}<p class="tonight-sum">${summary}</p>${icons}
        <button type="button" class="link-btn change-toggles" aria-expanded="${!!o.open}">${o.open ? "Done" : names.length ? "Change" : "Set"}</button></div>
      ${o.open ? `${chipsHtml(active)}<div class="tonight-foot"><p class="hint">For tonight only, not saved as a profile. Recipes swap ingredients or hide.</p>${clear}</div>` : ""}
      ${names.length ? `<p class="label-note">${icon("tag")}<span>${esc(LABEL_NOTE)}</span></p>` : ""}
    </section>`;
}

/**
 * Wire the chips and buttons of a toggle bar under `root`. `onChange` re-renders the view.
 * @param {ParentNode} root
 * @param {() => void} onChange
 * @param {{ onToggleOpen?: () => void }} [o]
 */
export function wireToggleBar(root, onChange, o = {}) {
  root.querySelectorAll("[data-toggle]").forEach(el => {
    const b = /** @type {HTMLElement} */ (el);
    b.onclick = () => {
      const id = /** @type {import('../types').Toggle} */ (b.dataset.toggle);
      const cur = currentToggles();
      saveToggles(cur.includes(id) ? cur.filter(t => t !== id) : [...cur, id]);
      onChange();
      // Keep the focus on the same chip after the re-render (keyboard and VoiceOver users).
      /** @type {HTMLElement | null} */ (document.querySelector(`[data-toggle="${id}"]`))?.focus({ preventScroll: true });
    };
  });
  root.querySelectorAll(".clear-toggles").forEach(el => {
    /** @type {HTMLElement} */ (el).onclick = () => { saveToggles([]); onChange(); };
  });
  root.querySelectorAll(".change-toggles").forEach(el => {
    /** @type {HTMLElement} */ (el).onclick = () => o.onToggleOpen?.();
  });
}
