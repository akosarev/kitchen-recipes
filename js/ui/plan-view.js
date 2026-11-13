// #/plan: tonight's plan before cooking (docs/v0-plan.md sections 8 and 11). One lane per dish on a
// clock-time axis (active steps solid, waits hatched), the serve time, amber "Both need your hands"
// markers, idle-hot and late warnings, the swaps, a backup-timer list for waits of 5 minutes or
// more, and a nag when the test alarm never ran. Under the chart the run sheet lists every step in
// order with its clock time: the readable version on a phone and for VoiceOver.
// The plan is recomputed from the current picks, toggles and setup on every render, so it is never
// stale. "Start cooking" builds it once more at the tap, freezes it into the session with its
// inputs and opens the cook screen.
import { esc } from "./html.js";
import { icon } from "./icons.js";
import { buildPlan } from "../domain/plan.js";
import { reasonText } from "../domain/adapt.js";
import { allergenWords } from "../domain/allergens.js";
import { amounts, names, fill } from "../domain/scale.js";
import { verbFor, clockText } from "../timer/engine.js";
import { backupUrl, BACKUP_MIN_MS } from "../timer/backup.js";
import { clockAt, hhmm } from "../setup.js";
import { currentToggles, LABEL_NOTE } from "./allergen-bar.js";
import { pickedRecipes, savedSetup, saveSetup, flowNav } from "./flow.js";
import { setupSummary, openSetupForm, clearQuickCook } from "./setup-view.js";
import { runtime } from "../timer/app.js";
import { prefs } from "./chrome.js";
import { startCookingNow } from "./cook-start.js";

/** Minimum chart width per minute, so short steps stay visible (the chart scrolls sideways). */
const PX_PER_MIN = 14;

/** @param {number} ms */
const minutes = ms => Math.round(ms / 60_000);
/** @param {number} n */
const pct = n => `${Math.round(n * 10000) / 100}%`;

/**
 * @param {HTMLElement} app
 * @param {import('../types').Recipe[]} recipes
 */
export function renderPlan(app, recipes) {
  // Landing here (not via the quick path's own "Start cooking") invalidates any pending
  // quick-path card (CP3).
  clearQuickCook();
  document.title = "Tonight's plan";
  const picks = pickedRecipes(recipes);
  const setup = savedSetup();
  const now = runtime().now();
  const head = `<div class="top"><a class="back" href="#/setup">‹ Setup</a></div><div class="flow wide">${flowNav(3)}<h1 class="rtitle">Tonight's plan</h1>`;
  const stop = (/** @type {string} */ msg, /** @type {string} */ href, /** @type {string} */ label) => {
    app.innerHTML = `${head}<p class="rsub">${msg}</p><div class="flow-foot"><a class="btn btn-main" href="${href}">${esc(label)}</a></div></div>`;
    window.scrollTo(0, 0);
  };
  if (!picks.length) return stop("Pick a recipe for tonight first.", "#/tonight", "Pick recipes");
  if (!setup) return stop("Set up tonight's equipment first.", "#/setup", "Set up");

  const toggles = currentToggles();
  const res = buildPlan(picks, toggles, setup, now);
  if (res.kind === "blocked") {
    const r = recipes.find(x => x.id === res.recipeId);
    return stop(esc(`${r?.title ?? res.recipeId} is hidden tonight: ${res.reasons.map(b => reasonText(b, allergenWords)).join("; ")}.`), "#/tonight", "Change tonight's picks");
  }
  if (res.kind === "error") {
    return stop(esc(res.error.kind === "setup" ? "Tonight's setup is missing equipment these recipes need." : `No plan fits: ${res.error.message}.`), "#/setup", "Change setup");
  }

  const { plan, recipes: adaptedRecipes, startAt, adapted } = res;
  const cooking = !!runtime().plan();
  const byKey = new Map();
  adaptedRecipes.forEach((r, i) => {
    const a = amounts(r, picks[i].servings), n = names(r);
    for (const l of adapted[i].lines.flat()) if (l.status.kind === "omitted") { a[l.item.k] = "left out"; n[l.item.k] = l.item.short ?? l.item.n; }
    for (const s of r.steps) byKey.set(r.id + "/" + s.id, { step: s, recipe: r, text: fill(s.t, a, n) });
  });

  // Lanes: each pick's dishes in order, then its shared prep.
  /** @type {{ key: string, title: string, cls: string }[]} */
  const lanes = [];
  let color = 0;
  const sharedCount = adaptedRecipes.filter(r => plan.steps.some(p => p.lane === r.id + "/shared")).length;
  adaptedRecipes.forEach((r, i) => {
    for (const d of r.dishes) lanes.push({ key: r.id + "/" + d.id, title: d.title, cls: "d" + color++ });
    if (plan.steps.some(p => p.lane === r.id + "/shared")) lanes.push({ key: r.id + "/shared", title: sharedCount > 1 ? `Shared prep ${i + 1}` : "Shared prep", cls: "shared" });
  });
  const laneOf = new Map(lanes.map(l => [l.key, l]));
  const total = plan.totalMs;
  const tight = plan.warnings.filter(w => w.kind === "hands-tight");
  const tightKeys = new Set(tight.flatMap(w => w.keys));

  const bars = lanes.map(l => {
    const blocks = plan.steps.filter(p => p.lane === l.key).map(p => {
      const info = byKey.get(p.key);
      const len = p.end - p.start;
      const label = len >= 3 * 60_000 ? esc(p.hands === "passive" ? "wait" : verbFor(info.step.t, "")) : "";
      return `<span class="g-blk ${p.hands}${p.coupled ? " coupled" : ""}${tightKeys.has(p.key) ? " tight" : ""}" style="left:${pct(p.start / total)};width:${pct(len / total)}" title="${esc(clockAt(startAt + p.start))} ${esc(info.text)}">${label}</span>`;
    }).join("");
    return `<div class="g-lane"><span class="g-name"><i class="dot ${l.cls}"></i>${esc(l.title)}</span><div class="g-track ${l.cls}">${blocks}</div></div>`;
  }).join("");
  const step = minutes(total) > 60 ? 10 : 5;
  const ticks = [];
  for (let m = 0; m <= minutes(total) - step * 0.6; m += step) ticks.push(`<span style="left:${pct(m * 60_000 / total)}">${esc(clockAt(startAt + m * 60_000))}</span>`);
  ticks.push(`<span class="end" style="left:100%">${esc(clockAt(plan.serveAt))}</span>`);
  const marks = tight.map(w => `<span class="g-mark" style="left:${pct(w.at / total)}" title="Both need your hands"></span>`).join("");
  const chart = `<div class="gantt" aria-hidden="true"><div class="g-in" style="min-width:calc(${minutes(total)} * ${PX_PER_MIN}px + 9em)">
      ${bars}<div class="g-lane"><span class="g-name"></span><div class="g-axis">${ticks.join("")}</div></div>
      <div class="g-marks">${marks}</div>
    </div></div>
    <p class="legend" aria-hidden="true"><span class="lg active"></span>you're needed <span class="lg passive"></span>waiting <span class="lg tightmark"></span>you're needed for both</p>`;

  const warn = [];
  const late = plan.warnings.find(w => w.kind === "late");
  if (late) {
    const earliest = Math.ceil((now + total) / 300_000) * 300_000;
    const d = new Date(earliest);
    warn.push(`<div class="banner blocked" role="alert">${icon("clock")}<div><b>Too late for ${esc(clockAt(plan.serveAt))}.</b> Cooking takes ${minutes(total)} min.
      <div class="fix-btns"><button type="button" class="btn small" data-serve="asap">Serve ASAP</button>
      <button type="button" class="btn small" data-serve="${d.getHours() * 60 + d.getMinutes()}">Serve at ${esc(clockAt(earliest))}</button></div></div></div>`);
  }
  if (tight.length) {
    warn.push(`<div class="banner adapted" role="note">${icon("alert")}<div><b>You're needed for both dishes ${tight.length === 1 ? "once" : `${tight.length} times`}</b>
      (${esc(tight.map(w => clockAt(startAt + w.at)).join(", "))}): two dishes need you within a minute of each other. Read ahead.</div></div>`);
  }
  for (const w of plan.warnings.filter(x => x.kind === "idle-hot")) {
    const info = byKey.get(w.keys[0]);
    warn.push(`<div class="banner plain" role="note">${icon("clock")}<div><b>${esc(laneOf.get(`${info.recipe.id}/${info.step.dish}`)?.title ?? "A dish")} is ready ${minutes(total - w.at)} min early.</b> Keep it covered and warm.</div></div>`);
  }
  if (!prefs().alarmTestedAt) {
    warn.push(`<div class="banner plain" role="note">${icon("alert")}<div><b>Alarm never tested.</b> <a href="#/settings">Test it once</a> with the silent switch on before you cook.</div></div>`);
  }

  const sheet = plan.steps.map(p => {
    const info = byKey.get(p.key);
    const l = /** @type {{ title: string, cls: string }} */ (laneOf.get(p.lane));
    const dur = clockText(p.end - p.start);
    const what = p.hands === "passive" ? `<span class="rs-wait">waiting ${esc(dur)}</span>` : `<span class="rs-dur">${esc(dur)}</span>`;
    return `<li class="rs ${p.hands}${tightKeys.has(p.key) ? " tight" : ""}"><time>${esc(clockAt(startAt + p.start))}</time>
      <span class="rs-body"><span class="dish-tag ${l.cls}">${esc(l.title)}</span>${esc(info.text)} ${what}${tightKeys.has(p.key) ? `<span class="rs-tight">${icon("alert")}You're needed for both</span>` : ""}</span></li>`;
  }).join("");

  const backups = plan.steps.filter(p => {
    const s = byKey.get(p.key).step;
    return p.hands === "passive" && s.timer && s.timer * 1000 >= BACKUP_MIN_MS;
  }).map(p => {
    const { step: s, text } = byKey.get(p.key);
    return `<li><span><b>${esc(clockAt(startAt + p.start))}</b> ${esc(text)}</span><a class="btn small backup" href="${esc(backupUrl(s.timer))}">${icon("timer")}Set up backup alarm ${esc(clockText(s.timer * 1000))}</a></li>`;
  }).join("");

  const swaps = adapted.map((a, i) => a.labels.length ? `<li><b>${esc(picks[i].recipe.title)}:</b> ${esc(a.labels.join("; "))}${a.checks ? ` · ${a.checks} label check${a.checks === 1 ? "" : "s"}` : ""}</li>` : "").join("");

  app.innerHTML = `${head}
    <div class="plan-facts">
      <div><span>Start</span><b>${esc(clockAt(startAt))}</b></div>
      <div><span>Serve</span><b>${esc(clockAt(plan.serveAt))}</b></div>
      <div><span>Takes</span><b>${minutes(total)} min</b></div>
    </div>
    <p class="setup-sum">${esc(setupSummary(setup))} · <a href="#/setup" data-change-setup>Change setup</a></p>
    ${warn.join("")}
    <div class="plan-cols">
      <section class="card" aria-labelledby="rs-h"><h3 id="rs-h">Minute by minute</h3><ol class="run-sheet">${sheet}</ol></section>
      <div>
        <button type="button" class="btn" data-show-chart aria-expanded="false" aria-controls="plan-chart">Show chart</button>
        <section id="plan-chart" class="card plan-chart" aria-label="Timeline" hidden>${chart}</section>
        ${backups ? `<section class="card" aria-labelledby="bk-h"><h3 id="bk-h">Long waits</h3><p class="hint">The app can't ring while the phone is locked. For these, start an iOS Clock timer too.</p><ul class="backups">${backups}</ul></section>` : ""}
        ${swaps ? `<section class="card" aria-labelledby="sw-h"><h3 id="sw-h">Swaps tonight</h3><ul class="swaps">${swaps}</ul><p class="label-note">${icon("tag")}<span>${esc(LABEL_NOTE)}</span></p></section>` : ""}
        <section class="card" aria-label="Open the recipes"><h3>Recipes</h3><p class="hint">The full recipes, with ingredients and tips.</p>
          <div class="fix-btns">${picks.map(p => `<a class="btn" href="#${esc(p.recipe.id)}">${esc(p.recipe.title)}</a>`).join("")}</div></section>
      </div>
    </div>
    <p class="hint plan-hash">Plan ${esc(plan.hash)} · ${esc(setup.serveAt === "asap" ? "serve ASAP" : `serve at ${hhmm(setup.serveAt)}`)}</p>
    <div class="flow-foot">${cooking
    ? `<a class="btn btn-main" href="#/cook">Back to the cook screen</a>`
    : `<button type="button" class="btn btn-main" data-start-cooking>Start cooking</button>`}</div>
    </div>`;

  app.querySelector("[data-start-cooking]")?.addEventListener("click", () => startCookingNow(picks, toggles, setup, () => renderPlan(app, recipes)));

  const chartToggle = /** @type {HTMLButtonElement} */ (app.querySelector("[data-show-chart]"));
  const chartSection = app.querySelector(".plan-chart");
  chartToggle?.addEventListener("click", () => {
    const open = chartToggle.getAttribute("aria-expanded") === "true";
    chartToggle.setAttribute("aria-expanded", String(!open));
    chartToggle.textContent = open ? "Show chart" : "Hide chart";
    if (open) chartSection?.setAttribute("hidden", ""); else chartSection?.removeAttribute("hidden");
  });

  app.querySelector("[data-change-setup]")?.addEventListener("click", () => openSetupForm());
  app.querySelectorAll("[data-serve]").forEach(el => {
    const b = /** @type {HTMLElement} */ (el);
    b.onclick = () => {
      const v = b.dataset.serve;
      saveSetup({ ...setup, serveAt: v === "asap" ? "asap" : Number(v) });
      renderPlan(app, recipes);
    };
  });
  window.scrollTo(0, 0);
}
