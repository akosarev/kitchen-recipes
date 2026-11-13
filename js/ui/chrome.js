// App chrome around the views (CP2): status bars (Can't save, Tap to re-arm alarms, Wake Lock and
// audio pills, install banner, Update ready, Cooking in progress), the bottom dock (Settings, mini
// Lighthouses, 1-tap quick timer), the full-screen alarm, the Undo toast and confirmation sheets.
// It lives outside #app so the reading views keep the old page's markup. Every value is escaped.
import { esc } from "./html.js";
import { runtime } from "../timer/app.js";
import { firedLate, overText, timerView } from "../timer/engine.js";
import { lighthouseHtml, paintLighthouse } from "./lighthouse.js";
import { WAKE_TEXT } from "../timer/wakelock.js";
import { isStandalone, INSTALL_TEXT, GATE_TITLE, GATE_BODY, GATE_OK, GATE_CANCEL } from "../install.js";
import { store, KEYS, cleanPrefs } from "../store.js";
import { clockAt } from "../setup.js";

export const REARM_TEXT = "Sound is off: alarms will be silent. Tap to turn on";
export const CANT_SAVE_TEXT = "Can't save: cooking state will be lost on reload";
/** Quick timer length until the user picks another (seconds). */
export const QUICK_DEFAULT_SEC = 300;

/** @typedef {{ title: string, html: string, onOk: () => void, onCancel?: () => void, ok: string, cancel?: string }} Sheet */

/** CP1 (ux-v1): the install question, answered once on this device, never re-asked. */
function installAnswered() {
  try { return !!localStorage.getItem(KEYS.installAnswer); } catch { return false; }
}

/** CP1 (ux-v1): the home screen's install tip, dismissed once on this device, stays gone. */
function installDismissed() {
  try { return !!localStorage.getItem(KEYS.installDismissed); } catch { return false; }
}

const ui = {
  /** @type {string} */
  route: "library",
  /** A waiting service worker (Update ready). */
  /** @type {{ apply: () => void } | null} */
  update: null,
  /** @type {Sheet | null} */
  sheet: null,
  /** @type {number | null} */
  saveErrorAt: null,
  gateOk: false,
};

/**
 * @param {string} id
 * @param {string} tag
 * @param {string} cls
 */
function host(id, tag, cls) {
  let el = document.getElementById(id);
  if (!el) {
    el = document.createElement(tag);
    el.id = id;
    el.className = cls;
    document.body.appendChild(el);
  }
  return el;
}

/**
 * Replace innerHTML only when the structure changed (taps never land on a detached element).
 * @param {HTMLElement} el
 * @param {string} html
 */
function put(el, html) {
  if (el.dataset.html === html) return false;
  el.innerHTML = html;
  el.dataset.html = html;
  return true;
}

/**
 * Move focus to a newly shown control (screen readers and keyboards land on it).
 * @param {Element | null} el
 */
function focusEl(el) {
  try { /** @type {HTMLElement | null} */ (el)?.focus({ preventScroll: true }); } catch { /* ignore */ }
}

/** @param {string} route library | recipe | clock | settings */
export function setRoute(route) { ui.route = route; paintChrome(); }

/** @param {{ apply: () => void } | null} u */
export function setUpdateReady(u) { ui.update = u; paintChrome(); }

/** A write failed somewhere (store.onSaveError). */
export function noteSaveError() { ui.saveErrorAt = runtime().now(); paintChrome(); }

/**
 * Preferences, checked: a stored value of the wrong shape reads as no preferences.
 * @returns {import('../types').Prefs}
 */
export const prefs = () => cleanPrefs(store.get(KEYS.prefs, {})) || {};

/** Quick timer length in seconds. */
export function quickSec() {
  const s = prefs().quickSec;
  return typeof s === "number" && s >= 60 && s <= 86400 ? Math.round(s) : QUICK_DEFAULT_SEC;
}

function gateAccepted() {
  if (ui.gateOk) return true;
  try { return sessionStorage.getItem("km.gate") === "1"; } catch { return false; }
}

/**
 * Show a confirmation sheet.
 * @param {Sheet} s
 */
export function openSheet(s) { ui.sheet = s; paintChrome(); }
/** Close the confirmation sheet. */
export function closeSheet() { ui.sheet = null; paintChrome(); }

/**
 * Start a timer from a tap. Outside the installed app, the first start in this tab asks first
 * (install gate, plan R8): "Cook in Safari anyway".
 * @param {import('../timer/runtime.js').StartSpec} spec
 * @param {() => void} [onStarted] repaint the caller's view
 */
export function requestStart(spec, onStarted) {
  gated(() => { runtime().start(spec); onStarted?.(); paintAll(); });
}

/**
 * Run `go` now when the app is installed (or the user already chose to go on in Safari), else
 * after the "Not installed" sheet is accepted. Used by everything that starts cooking.
 * @param {() => void} go
 */
export function gated(go) {
  if (isStandalone() || gateAccepted() || installAnswered()) { go(); return; }
  wireChrome();
  openSheet({
    title: GATE_TITLE,
    html: `<p>${esc(GATE_BODY)}</p><p>Add it from Safari: Share, then Add to Home Screen.</p>`,
    ok: GATE_OK,
    cancel: GATE_CANCEL,
    // "Show me how" shows the Add to Home Screen steps and does not start anything: the cook is
    // about to leave for the Home Screen icon. The answer is remembered, so the question never
    // comes back on this device.
    onOk: () => {
      recordInstallAnswer();
      openSheet({
        title: HOWTO_TITLE,
        html: HOWTO_HTML,
        ok: HOWTO_OK,
        cancel: HOWTO_CANCEL,
        onOk: () => {},
        onCancel: () => goInSafari(go),
      });
    },
    // "Not now" means: not installing now, keep cooking. It goes on at once (one tap, not two)
    // and is remembered, so the question never comes back on this device.
    onCancel: () => {
      recordInstallAnswer();
      goInSafari(go);
    },
  });
}

export const HOWTO_TITLE = "Add to Home Screen";
export const HOWTO_OK = "Got it";
export const HOWTO_CANCEL = "Cook in Safari now";
const HOWTO_HTML = `<ol class="howto"><li>Tap Share (the square with the arrow) in Safari.</li>`
  + `<li>Tap Add to Home Screen, then Add.</li>`
  + `<li>Open Kitchen Master from its new icon.</li></ol>`;

/** @param {() => void} go */
function goInSafari(go) {
  ui.gateOk = true;
  try { sessionStorage.setItem("km.gate", "1"); } catch { /* per page then */ }
  go();
}

/** CP1: remember that the install question has been answered on this device (either button). */
function recordInstallAnswer() {
  try {
    const v = String(runtime().now());
    localStorage.setItem(KEYS.installAnswer, v);
    // Real Storage objects reflect every key as an enumerable own property (so
    // Object.keys(localStorage) sees it); mirror that explicitly for test doubles that don't.
    localStorage[KEYS.installAnswer] = v;
  } catch { /* per page then */ }
}


/** Start a quick timer with no recipe (one tap). */
export function startQuick() {
  const sec = quickSec();
  const at = runtime().now();
  requestStart({ key: "adhoc/" + at.toString(36), durMs: sec * 1000, label: "Quick timer", verb: "Timer", tide: false });
}

/** @param {import('../types').Timer} t */
const clockHref = t => "#/clock/" + encodeURIComponent(t.key);

/**
 * Status bars as keyed items: only the items that changed are replaced, so a tap on one bar never
 * lands on a detached element when another bar appears or goes.
 * @returns {[string, string][]}
 */
function barItems() {
  const rt = runtime();
  const cooking = rt.cooking();
  /** @type {[string, string][]} */
  const out = [];
  if (rt.unsaved() || (ui.saveErrorAt != null && rt.now() - ui.saveErrorAt < 10_000)) {
    out.push(["save", `<div class="bar bar-red" role="alert">${esc(CANT_SAVE_TEXT)}</div>`]);
  }
  if (cooking || rt.userWake()) {
    const held = rt.wake.state === "held";
    const pills = [`<span class="pill ${held ? "pill-ok" : "pill-warn"} wake-pill"><span aria-hidden="true">${held ? "●" : "▲"}</span> ${esc(held ? WAKE_TEXT.held : WAKE_TEXT.off)}</span>`];
    if (cooking) {
      const a = rt.audio.state;
      const text = a === "armed" ? "Alarm sound on" : a === "interrupted" ? "Alarm sound interrupted" : "Alarm sound off";
      // CP1 (ux-v1, decision 3): on the cook screen the sound-off warning replaces this chip; on
      // every other screen it is its own bar under the header (pushed below), never the bottom.
      if (ui.route === "cook" && a !== "armed") pills.push(rearmHtml());
      else pills.push(`<span class="pill ${a === "armed" ? "pill-ok" : "pill-warn"} audio-pill"><span aria-hidden="true">♪</span> ${esc(text)}</span>`);
    }
    out.push(["pills", `<div class="pills">${pills.join("")}</div>`]);
    if (cooking && ui.route !== "cook" && rt.audio.state !== "armed") out.push(["rearm", rearmHtml()]);
  }
  if ((ui.route === "library" || ui.route === "settings") && !isStandalone() && !installDismissed()) {
    out.push(["install", `<div class="bar bar-info install" role="note">${esc(INSTALL_TEXT)}`
      + `<button type="button" class="link-btn install-dismiss" data-act="install-dismiss" aria-label="Dismiss">✕</button></div>`]);
  }
  if (ui.route === "library" && cooking) {
    const n = rt.live().length;
    out.push(["resume", rt.plan()
      ? `<a class="resume" href="#/cook">Cooking in progress. Back to the cook screen</a>`
      : `<a class="resume" href="#/clock">Cooking in progress: ${n} timer${n === 1 ? "" : "s"}. Open the clock</a>`]);
  }
  if (ui.route === "library" && ui.update && !cooking) {
    out.push(["update", `<button type="button" class="chip update" data-act="update">Update ready: tap to apply</button>`]);
  }
  return out;
}

/**
 * The sound-off warning (CP1, decision 3): a red bar that names the consequence. On the cook
 * screen it takes the "Alarm sound on" chip's place; on every other screen it is its own bar
 * under the header, in the page's normal flow (never pinned to the bottom).
 */
function rearmHtml() {
  const rt = runtime();
  if (!rt.cooking() || rt.audio.state === "armed") return "";
  const why = rt.audio.state === "interrupted" ? "Alarm sound was interrupted. " : "";
  return `<button type="button" class="bar bar-red rearm" data-act="rearm">${esc(why + REARM_TEXT)}</button>`;
}

/**
 * @param {HTMLElement} host
 * @param {[string, string][]} items
 */
function putKeyed(host, items) {
  /** @type {Map<string, HTMLElement>} */
  const have = new Map();
  for (const c of /** @type {HTMLElement[]} */ ([...host.children])) have.set(c.dataset.k || "", c);
  let prev = /** @type {Element | null} */ (null);
  for (const [k, html] of items) {
    let el = have.get(k);
    have.delete(k);
    if (!el || el.dataset.html !== html) {
      const n = document.createElement("div");
      n.className = "bar-item";
      n.dataset.k = k;
      n.dataset.html = html;
      n.innerHTML = html;
      if (el) el.replaceWith(n);
      el = n;
    }
    const want = prev ? prev.nextElementSibling : host.firstElementChild;
    if (want !== el) host.insertBefore(el, want);
    prev = el;
  }
  for (const el of have.values()) el.remove();
}

function dockHtml() {
  const rt = runtime();
  // No aria-label: the link reads its Lighthouse text (verb, time left, zone word), kept current.
  // On the cook screen the plan's own timers already show as dish clocks and waits.
  const plan = ui.route === "cook" ? rt.plan() : null;
  const own = new Set(plan ? plan.steps.map(p => p.key) : []);
  const minis = rt.live().filter(t => !own.has(t.key)).map(t => `<a class="dock-lh" href="${esc(clockHref(t))}">${lighthouseHtml(t, rt.now(), "mini")}</a>`).join("");
  const q = quickSec();
  const qt = `${Math.floor(q / 60)}:${String(q % 60).padStart(2, "0")}`;
  return `<a class="dock-btn" href="#/settings"><span aria-hidden="true">⚙</span> <span class="dock-word">Settings</span></a>`
    + `<div class="dock-timers">${minis}</div>`
    + `<button type="button" class="dock-btn quick" data-act="quick"><span aria-hidden="true">⏱</span> Timer ${qt}</button>`;
}

function overlayHtml() {
  const rt = runtime();
  const a = rt.alarming();
  if (!a.length) return "";
  const t = a[0];
  const more = a.length > 1 ? `<p class="alarm-more">+${a.length - 1} more</p>` : "";
  const late = firedLate(t) ? `<p class="alarm-late" data-late>Overdue by ${esc(overText(-timerView(t, rt.now()).remainingMs))}</p>` : "";
  // role="alert" on the container: VoiceOver announces a firing timer; the button also takes focus.
  return `<div role="alert"><button type="button" class="alarm" data-act="ack" data-key="${esc(t.key)}">`
    + `<span class="alarm-verb">${esc(t.verb || "Timer")}: tap to stop</span>`
    + `<span class="alarm-label">${esc(t.label || "")}</span>${late}${more}</button></div>`;
}

/**
 * "Serve moved to 19:42 (+3 min)" for the Undo toast after "I'm behind".
 * @param {Extract<import('../types').Command, { kind: 'replan' }>} cmd
 */
function replanText(cmd) {
  const plan = runtime().plan();
  if (!plan) return "Plan changed";
  const min = Math.round((plan.serveAt - cmd.prev.serveAt) / 60_000);
  return min > 0 ? `Serve moved to ${clockAt(plan.serveAt)} (+${min} min)` : `Still on for ${clockAt(plan.serveAt)}`;
}

function toastHtml() {
  const a = runtime().lastAction();
  if (!a) return "";
  // CP2 (ux-v1, decision 1): on the cook screen a "done" action gets its own pinned Undo bar,
  // right where the Done bar was (js/ui/cook-view.js); this generic toast stays out of its way
  // so the bottom never shows two bars at once (G7).
  if (ui.route === "cook" && a.cmd.kind === "done") return "";
  const k = a.cmd.kind;
  const what = k === "timerStart" ? "Timer started" : k === "timerCancel" ? "Timer stopped" : k === "replan" ? replanText(a.cmd) : "Step done";
  return `<div class="toast" role="status"><span>${esc(what)}</span><button type="button" data-act="undo">Undo</button></div>`;
}

function sheetHtml() {
  const s = ui.sheet;
  if (!s) return "";
  return `<div class="sheet-back"><div class="sheet" role="dialog" aria-modal="true" aria-labelledby="sheet-title">`
    + `<h2 id="sheet-title">${esc(s.title)}</h2>${s.html}`
    + `<div class="sheet-btns">${s.cancel ? `<button type="button" class="btn" data-act="sheet-cancel">${esc(s.cancel)}</button>` : ""}`
    + `<button type="button" class="btn btn-main" data-act="sheet-ok">${esc(s.ok)}</button></div></div></div>`;
}

/** Repaint the chrome (cheap when nothing structural changed). */
export function paintChrome() {
  if (typeof document === "undefined") return;
  const rt = runtime();
  const now = rt.now();
  putKeyed(host("bars", "div", "bars"), barItems());
  const dock = host("dock", "nav", "dock");
  // Structure key: which timers and their zones; numbers and arcs are painted in place.
  const live = rt.live();
  const dockKey = live.map(t => t.key + ":" + timerView(t, now).zone + ":" + (t.verb || "")).join("|") + "#" + quickSec();
  if (dock.dataset.key !== dockKey) { dock.innerHTML = dockHtml(); dock.dataset.key = dockKey; }
  for (const el of dock.querySelectorAll("[data-lh]")) {
    const t = live.find(x => x.key === /** @type {HTMLElement} */ (el).dataset.lh);
    if (t) paintLighthouse(el, t, now);
  }
  const ov = host("overlay", "div", "overlay");
  const a = rt.alarming();
  const ovKey = a.map(t => t.key + ":" + t.firedAt).join("|");
  if (ov.dataset.key !== ovKey) {
    ov.innerHTML = overlayHtml();
    ov.dataset.key = ovKey;
    focusEl(ov.querySelector(".alarm"));
  }
  const late = ov.querySelector("[data-late]");
  if (late && a[0]) {
    const txt = "Overdue by " + overText(-timerView(a[0], now).remainingMs);
    if (late.textContent !== txt) late.textContent = txt;
  }
  document.documentElement.classList.toggle("alarming", a.length > 0);
  put(host("toast", "div", "toast-host"), toastHtml());
  const sheet = host("sheet", "div", "sheet-host");
  if (put(sheet, sheetHtml())) focusEl(sheet.querySelector(".sheet button"));
  stackBottom();
}

/** @type {string} */
let stackKey = "";
/**
 * The bottom chrome is a stack: dock, then the re-arm bar, then the Undo bar. Their heights vary
 * (a running timer makes the dock taller), so each bar's place and the room the page leaves for
 * them come from measured heights, published as CSS variables. Nothing floats over the content.
 */
function stackBottom() {
  const h = /** @param {string} id */ id => document.getElementById(id)?.offsetHeight ?? 0;
  const dock = h("dock");
  if (!dock) return; // not laid out (tests without layout): the CSS fallbacks apply
  const toast = h("toast");
  const key = dock + "/" + toast;
  if (key === stackKey) return;
  stackKey = key;
  const st = document.documentElement.style;
  st.setProperty("--dock-h", dock + "px");
  st.setProperty("--toast-h", toast + "px");
}

/** @type {Set<() => void>} */
const painters = new Set();

/**
 * Register a view painter (recipe buttons, clock) run on every paint.
 * @param {() => void} fn
 */
export function onPaint(fn) { painters.add(fn); return () => { painters.delete(fn); }; }

/** Paint everything: chrome and the current view's live parts. */
export function paintAll() {
  paintChrome();
  for (const fn of painters) fn();
}

let wired = false;

/**
 * Delegated taps for the chrome's buttons.
 *
 * CP1 note: a hot module re-import (tests simulating a fresh page load without a fresh
 * `document`) must not leave a stale listener bound to a discarded `ui`/`runtime` behind. The
 * single handler is tracked on `document` itself so a later re-import replaces it instead of
 * stacking a second one that could act on an old, already-closed sheet.
 */
export function wireChrome() {
  if (wired || typeof document === "undefined") return;
  wired = true;
  /** @type {any} */
  const doc = document;
  if (doc.__kmChromeHandler) doc.removeEventListener("click", doc.__kmChromeHandler);
  const handler = (/** @type {MouseEvent} */ e) => {
    const el = /** @type {HTMLElement | null} */ (/** @type {HTMLElement} */ (e.target).closest?.("[data-act]"));
    if (!el || !el.closest("#bars, #dock, #overlay, #toast, #sheet")) return;
    const rt = runtime();
    switch (el.dataset.act) {
      case "ack": rt.ack(/** @type {string} */ (el.dataset.key)); break;
      case "undo": rt.undo(); break;
      case "quick": startQuick(); break;
      case "rearm": rt.audio.arm().then(paintAll, paintAll); break;
      case "install-dismiss": localStorage.setItem(KEYS.installDismissed, "1"); break;
      case "update": ui.update?.apply(); break;
      case "sheet-cancel": { const s = ui.sheet; closeSheet(); s?.onCancel?.(); break; }
      case "sheet-ok": { const s = ui.sheet; closeSheet(); s?.onOk(); break; }
    }
    paintAll();
  };
  doc.addEventListener("click", handler);
  doc.__kmChromeHandler = handler;
}
