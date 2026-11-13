// #/cook: the cook screen (docs/v0-plan.md sections 8 and 11, CP5), and #/done after it.
// One clock per dish on top (a running wait, else the time to the dish's next step), the waits
// that are running, the step to do now with its pinned tap button, then every later step as one
// line. On a phone it reads as one list; on an iPad the dish clocks grow into cards.
//
// - CP2 (ux-v1, decisions 1-2): tap to act (no hold). A tap fires on pointerup while the finger is
//   still over the button; a slide-off (pointerleave/pointercancel) before lifting cancels it. A
//   keyboard or switch activation (a click no pointer made) acts at once. The current step's action
//   is pinned above the dock; right after it fires, an Undo bar takes its exact place for 15 s (or
//   until the next action, whichever is first), then a permanent "Just done: <step> · Not done yet"
//   line under the dish cards can undo that last finished step at any later point in the meal.
// - The highlighted step is a default, not a gate: tap any later line to open it; it can be done
//   as soon as the steps it comes after are done.
// - "I'm behind" schedules what is left from now and moves the serve time (Undo restores it).
// The markup is rebuilt only when the structure changes and never mid-tap; clocks and countdowns
// are painted in place. Every value is escaped.
import { esc } from "./html.js";
import { icon, techniqueIcon } from "./icons.js";
import { runtime } from "../timer/app.js";
import { UNDO_MS } from "../timer/runtime.js";
import { resolveCook, cookView } from "../domain/cook.js";
import { replan } from "../domain/replan.js";
import { clockText, verbFor } from "../timer/engine.js";
import { lighthouseHtml, paintLighthouse } from "./lighthouse.js";
import { clockAt } from "../setup.js";
import { gated, openSheet, closeSheet, paintAll } from "./chrome.js";

/** "On time" until the current step is this late. */
const LATE_MS = 60_000;

/** @typedef {import('../domain/cook.js').Row} Row */
/** @typedef {import('../domain/cook.js').CookView} View */
/** @typedef {Extract<import('../domain/cook.js').Cook, { kind: 'ok' }>} Cook */

const st = {
  /** @type {HTMLElement | null} */
  app: null,
  /** @type {import('../types').Recipe[]} */
  recipes: [],
  sig: "",
  /** Key of the later step the user opened. */
  /** @type {string | null} */
  open: null,
  /** The pointer currently down on a tap button, cleared on pointerup/leave/cancel. */
  /** @type {{ btn: HTMLElement, pointer: number } | null} */
  tap: null,
  /** @type {{ id: string, cook: import('../domain/cook.js').Cook } | null} */
  cache: null,
  /** @type {string | null} */
  note: null,
  /**
   * CP2: the Undo bar shown in the Done bar's place right after a "done" tap, for UNDO_MS or
   * until the next action (any log entry past `logLen` ends it, whoever caused it). `pinned` is
   * true when the tap that caused it came from the pinned bar (the current step), false when it
   * came from an opened later row in .cook-more, which never held that spot to begin with.
   * @type {{ key: string, until: number, logLen: number, pinned: boolean } | null}
   */
  undo: null,
};

/**
 * The frozen plan resolved to recipes; cached, since it does not depend on the plan's times.
 * @param {import('../types').CookPlan} plan
 */
function resolved(plan) {
  const id = plan.hash + "|" + plan.frozenAt;
  if (st.cache?.id !== id) st.cache = { id, cook: resolveCook(plan, st.recipes) };
  return st.cache.cook;
}

/** @param {number} ms */
const mins = ms => Math.max(1, Math.round(ms / 60_000));

/**
 * "in 4 min", "now", "3 min late".
 * @param {number} at epoch
 * @param {number} now
 */
export function whenText(at, now) {
  const d = at - now;
  if (d > 45_000) return `in ${mins(d)} min`;
  if (d >= -LATE_MS) return "now";
  return `${mins(-d)} min late`;
}

/** @param {Row} r */
const durText = r => (r.p.hands === "passive" ? "wait " : "") + clockText(r.p.end - r.p.start);

/**
 * CP2: a plain tap button (no hold), as the inner content of a .cook-acts row (see actionsHtml
 * and the pinned bar in html() below, which puts this next to an Undo button when one is due).
 * @param {Row} r
 */
function actionInner(r) {
  const k = esc(r.p.key);
  const sec = r.info.step.timer;
  // The visible label names the step itself (so the pinned bar reads "Done: <step>", never a bare
  // "Done:"); the trailing colon some step texts carry (introduced before a sub-bullet list) is
  // stripped here since there is no list under this button. A screen-reader-only suffix adds the
  // dish name, so two buttons that happened to share a step text still read apart. The colon stays
  // in the same text node as "Done"/"Start the ... timer": a browser's accessible-name algorithm
  // adds a space between separate child nodes, which would otherwise turn "Done:" into "Done :".
  const label = esc(/** @type {string} */ (r.info.text).replace(/:\s*$/, ""));
  const lane = `<span class="sr">, ${esc(r.info.lane.title)}</span>`;
  if (r.action === "timer") {
    const verb = esc(verbFor(r.info.step.t, "this step"));
    return `<button type="button" class="tap" data-key="${k}" data-do="timer"><span>Start the ${esc(clockText(/** @type {number} */ (sec) * 1000))} timer: ${verb}${lane}</span></button>`;
  }
  let extra = "";
  if (sec) {
    extra = r.timer
      ? `<a class="btn cook-timer" href="#/clock/${encodeURIComponent(r.p.key)}">${icon("timer")}Timer running</a>`
      : `<button type="button" class="btn cook-timer" data-timer="${k}">${icon("timer")}Timer ${esc(clockText(sec * 1000))}</button>`;
  }
  return `<button type="button" class="tap" data-key="${k}" data-do="done"><span>Done: ${label}${lane}</span></button>${extra}`;
}

/**
 * A later step's inline action, where it sits in .cook-more.
 * @param {Row} r
 */
const actions = r => `<div class="cook-acts">${actionInner(r)}</div>`;

/**
 * The most recently finished step, whatever finished it: a tap (logged as a "done" command) or a
 * wait's alarm acknowledgement (session.js setDone(), which deliberately never logs "an
 * acknowledgement is never undone"). Read from session.done (the source of truth for "is this
 * step finished"), not the command log, so a step the alarm finished is never shown as stale
 * (cp2-F1). `revertible` is true only when the finish is still the log's own last command for
 * that exact step and instant: the undo path (runtime().undo()) can only ever reverse a logged
 * "done" command, never an unlogged acknowledgement.
 * @param {import('../types').CookSession | null} session
 * @returns {{ key: string, at: number, revertible: boolean } | null}
 */
function lastFinished(session) {
  const done = session?.done ?? {};
  let key = null, at = -Infinity;
  for (const [k, v] of Object.entries(done)) if (v > at) { key = k; at = v; }
  if (key == null) return null;
  const log = session?.log ?? [];
  const tail = log[log.length - 1];
  const revertible = !!tail && tail.kind === "done" && tail.key === key && tail.at === at;
  return { key, at, revertible };
}

/** @param {Row} r */
const subHtml = r => (r.info.sub.length ? `<ul class="sub">${r.info.sub.map(x => `<li>${esc(x)}</li>`).join("")}</ul>` : "");

/**
 * @param {View} v
 * @param {Cook} cook
 * @param {number} now
 * @param {import('../types').CookSession} session
 */
function html(v, cook, now, session) {
  const lastAct = runtime().lastAction();
  // CP2 decision 1: tapping the pinned Done bar replaces it, in place, with an Undo bar, so a
  // second stray tap hits Undo, never a different next step (brief, decision 1). A step finished
  // from .cook-more (an open later step, not the pinned one) never used that spot, so it does not
  // take it over. Either way, a recent non-done action (timer start, replan) shows its own Undo as
  // the app's generic toast in the same bottom spot, hiding the pinned bar too (G7). The one
  // exception: if hiding the pinned bar would leave nothing at all to act on (no other ready step,
  // no running wait), it stays — there is no "next step" left for a stray tap to hit by mistake.
  const stuck = !v.next.some(r => r.ready) && !v.waiting.length;
  const hidePinned = (!!st.undo?.pinned && !stuck) || (!!lastAct && lastAct.cmd.kind !== "done");
  const lastDone = !st.undo ? lastFinished(session) : null;
  const lastDoneInfo = lastDone && cook.info.get(lastDone.key);
  // The step text may carry a trailing colon (it introduces a sub-bullet list on the Now card);
  // dropped here since there is no list on this one-line summary, so it never reads "<step>: ·".
  // cp2-F1: an alarm-finished step (session.js setDone(), never logged) cannot be reverted through
  // the undo path, so its "Not done yet" link is left out rather than shown as a dead control; the
  // name still updates so the line never reads a stale, earlier tap-done step.
  // "\u00b7 Not done yet" sits inside the link's own non-breaking container so the separator can
  // never end up alone on the line above the link; the step name itself may still wrap on a narrow
  // phone, and the container's min-height keeps the tap target >= 56px tall even then.
  const justDone = lastDoneInfo
    ? `<p class="cook-just" role="note">Just done: ${esc(/** @type {string} */ (lastDoneInfo.text).replace(/:\s*$/, ""))}${/** @type {{revertible: boolean}} */ (lastDone).revertible
        ? ` <span class="cook-just-undo">\u00b7 <button type="button" class="link" data-not-done data-key="${esc(/** @type {{key: string}} */ (lastDone).key)}">Not done yet</button></span>`
        : ""}</p>`
    : "";

  const clocks = v.clocks.map(c => {
    const head = `<span class="cook-clock-h"><i class="dot ${c.lane.cls}"></i>${esc(c.lane.title)}</span>`;
    if (c.kind === "timer") {
      return `<a class="cook-clock ${c.lane.cls}" href="#/clock/${encodeURIComponent(c.key)}">${lighthouseHtml(c.timer, now, "mini")}
        <span class="cook-clock-b">${head}<span class="cook-clock-s">${esc(c.verb)}</span></span></a>`;
    }
    if (c.kind === "done") {
      return `<div class="cook-clock ${c.lane.cls} idle"><span class="cook-idle" aria-hidden="true">✓</span><span class="cook-clock-b">${head}<span class="cook-clock-s">done</span></span></div>`;
    }
    return `<div class="cook-clock ${c.lane.cls} idle"><span class="cook-idle" aria-hidden="true">${icon("clock")}</span>
      <span class="cook-clock-b">${head}<span class="cook-clock-s">next <b data-when="${c.row.at}"></b></span></span></div>`;
  }).join("");

  const waits = v.waiting.map(r => `<li><a class="cook-wait ${r.info.lane.cls}" href="#/clock/${encodeURIComponent(r.p.key)}">
      <i class="dot ${r.info.lane.cls}"></i><span class="sr">${esc(r.info.lane.title)}: </span><span class="x">${esc(r.info.text)}</span><b data-left="${esc(r.p.key)}"></b></a></li>`).join("");

  const cur = v.current;
  // CP2 decision 1: one bar above the dock, always — the current step's own action, an Undo for
  // the step just finished, or both side by side when a later step became current right away (so
  // tapping Done never leaves the next step waiting on a 15 s window it didn't ask for). It is a
  // DOM child of .cook-now (so the current step's own button stays reachable from there), but
  // .cook-pin's own CSS (position:fixed) pins it above the dock regardless of where it sits in
  // the document.
  const pinInner = (!hidePinned && cur ? actionInner(cur) : "")
    + (st.undo ? `<div class="cook-undo"><span class="cook-undo-label">Step done</span><button type="button" class="tap-undo" data-undo>Undo</button></div>` : "");
  const pinBar = pinInner ? `<div class="cook-acts cook-pin">${pinInner}</div>` : "";
  const nowCard = cur
    ? `<section class="cook-now ${cur.info.lane.cls}" aria-labelledby="cook-now-h">
        <div class="cook-now-h"><h2 id="cook-now-h" class="cap">Now</h2><span class="dish-tag ${cur.info.lane.cls}">${esc(cur.info.lane.title)}</span><span class="cook-at" data-when="${cur.at}"></span>${techniqueIcon(cur.info.step, "ic cook-tech")}</div>
        <p class="cook-text">${esc(cur.info.text)}</p>${subHtml(cur)}${pinBar}
      </section>`
    : `<section class="cook-now idle" aria-labelledby="cook-now-h"><div class="cook-now-h"><h2 id="cook-now-h" class="cap">Now</h2></div>
        <p class="cook-text">Nothing for your hands right now.</p>
        <p class="hint">${v.waiting.length ? "The clock rings when the wait ends. " : ""}${v.next.some(r => r.ready) ? "Ahead of the plan? Open a step below to do it early." : ""}</p>${pinBar}</section>`;

  const both = v.bothHands
    ? `<p class="cook-both" role="note">${icon("alert")}<span><b>Both dishes need your hands.</b> ${esc(v.bothHands.info.lane.title)} at ${esc(clockAt(v.bothHands.at))}: read it now.</span></p>`
    : "";

  const next = v.next.map(r => {
    const open = st.open === r.p.key;
    const blockers = r.info.after.filter(k => !v.done.some(d => d.p.key === k)).map(k => cook.info.get(k)).filter(Boolean);
    const more = !open ? "" : `<div class="cook-more"><p class="cook-text">${esc(r.info.text)}</p>${subHtml(r)}
        ${r.ready ? actions(r) : `<p class="hint">Comes after: ${esc(blockers.map(b => verbFor(/** @type {import('../domain/cook.js').StepInfo} */ (b).step.t, "an earlier step")).join(", "))}.</p>`}</div>`;
    return `<li class="${r.p.hands}${r.ready ? " ready" : ""}${r.tight ? " tight" : ""}${open ? " open" : ""}">
      <button type="button" class="cook-row" data-open="${esc(r.p.key)}" aria-expanded="${open}">
        <time>${esc(clockAt(r.at))}</time><i class="dot ${r.info.lane.cls}"></i><span class="sr"> ${esc(r.info.lane.title)}: </span><span class="x">${esc(r.info.text)}</span><em>${esc(durText(r))}</em>
      </button>${more}</li>`;
  }).join("");

  const done = v.done.map(r => `<li><i class="dot ${r.info.lane.cls}"></i><span class="sr">${esc(r.info.lane.title)}: </span><span>${esc(r.info.text)}</span></li>`).join("");

  return `<div class="cook">
    <header class="cook-top">
      <a class="back" href="#">‹ Recipes</a>
      <span class="cook-serve"><small>Serve</small> <b>${esc(clockAt(v.serveAt))}</b></span>
      <span class="cook-state" data-state role="status"></span>
    </header>
    ${st.note ? `<p class="cook-note" role="alert">${esc(st.note)}</p>` : ""}
    <div class="cook-cols"><div class="cook-main">
      <div class="cook-clocks n${v.clocks.length}">${clocks}</div>
      ${justDone}
      ${waits ? `<ul class="cook-waits" aria-label="Waiting">${waits}</ul>` : ""}
      ${nowCard}
      ${both}
    </div><div class="cook-side">
      ${next ? `<h2 class="cap cook-cap">Next</h2><ol class="cook-next">${next}</ol>` : ""}
      <details class="cook-done"><summary>${v.doneCount} of ${v.total} steps done</summary><ol>${done}</ol></details>
      <div class="cook-foot">
        <button type="button" class="btn" data-behind>I'm behind</button>
        <button type="button" class="btn" data-end>End cooking</button>
      </div>
    </div></div>
  </div>`;
}

/**
 * Countdowns, clocks and the on-time pill, updated in place.
 * @param {HTMLElement} app
 * @param {View} v
 * @param {number} now
 */
function paintLive(app, v, now) {
  const rt = runtime();
  /**
   * @param {Element} el
   * @param {string} text
   */
  const set = (el, text) => { if (el.textContent !== text) el.textContent = text; };
  app.querySelectorAll("[data-when]").forEach(el => set(el, whenText(Number(/** @type {HTMLElement} */ (el).dataset.when), now)));
  app.querySelectorAll(".cook-clock [data-lh]").forEach(el => {
    const t = rt.timer(/** @type {string} */ (/** @type {HTMLElement} */ (el).dataset.lh));
    if (t) paintLighthouse(el, t, now);
  });
  app.querySelectorAll("[data-left]").forEach(el => {
    const r = v.waiting.find(x => x.p.key === /** @type {HTMLElement} */ (el).dataset.left);
    if (!r?.timer) return;
    const left = r.timer.startedAt + r.timer.durMs + r.timer.pausedMs - now;
    set(el, r.timer.firedAt != null || left <= 0 ? "ready" : r.timer.pausedAt != null ? "paused" : clockText(left));
  });
  const state = app.querySelector("[data-state]");
  if (state) {
    const late = v.behindMs > LATE_MS;
    state.classList.toggle("late", late);
    set(state, late ? `${mins(v.behindMs)} min behind` : "on time");
  }
}

/**
 * Space reserved for the pinned bar (css/app.css --act-h), measured after every draw.
 * @param {HTMLElement} root
 */
function syncActHeight(root) {
  if (typeof document === "undefined") return;
  const el = /** @type {HTMLElement | null} */ (root.querySelector(".cook-pin"));
  const want = (el ? el.offsetHeight : 0) + "px";
  if (document.documentElement.style.getPropertyValue("--act-h") !== want) document.documentElement.style.setProperty("--act-h", want);
}

/** Draw the cook screen, or repaint it in place when its structure did not change. */
function draw() {
  const app = st.app;
  if (!app || !app.isConnected || !app.querySelector("[data-cook-root]")) return;
  const rt = runtime();
  const session = rt.session();
  const root = /** @type {HTMLElement} */ (app.querySelector("[data-cook-root]"));
  if (!session?.plan) {
    const empty = `<div class="top"><a class="back" href="#">‹ Recipes</a></div><div class="flow"><h1 class="rtitle">Nothing is cooking</h1>
      <p class="rsub">Pick tonight's recipes and the plan starts the cook screen.</p>
      <div class="flow-foot"><a class="btn btn-main" href="#/tonight">Plan tonight</a></div></div>`;
    if (st.sig !== "empty") { root.innerHTML = empty; st.sig = "empty"; }
    syncActHeight(root);
    return;
  }
  const cook = resolved(session.plan);
  if (cook.kind === "stale") {
    if (st.sig !== "stale") {
      root.innerHTML = `<div class="top"><a class="back" href="#">‹ Recipes</a></div><div class="flow"><h1 class="rtitle">This plan no longer matches</h1>
        <p class="rsub">A recipe changed since the plan was made. End this cook and plan again; running timers stay.</p>
        <div class="flow-foot"><button type="button" class="btn btn-main" data-end-now>End cooking</button></div></div>`;
      st.sig = "stale";
    }
    syncActHeight(root);
    return;
  }
  const now = rt.now();
  // CP2: the Undo bar closes on its own 15 s window, or sooner on any other logged action,
  // whoever caused it (another tab finishing a different step included).
  if (st.undo && (now >= st.undo.until || (session.log.length !== st.undo.logLen))) st.undo = null;
  const v = cookView(session, cook, now);
  if (v.finished) { location.replace("#/done"); return; }
  if (st.open && !v.next.some(r => r.p.key === st.open)) st.open = null;
  const lastAct = rt.lastAction();
  const sig = JSON.stringify([
    session.plan.serveAt, session.plan.totalMs, v.doneCount, v.waiting.map(r => r.p.key), v.current?.p.key ?? null,
    v.clocks.map(c => (c.kind === "timer" ? c.key : c.kind === "next" ? c.row.p.key : "")), v.next.map(r => [r.p.key, r.ready, !!r.timer, r.tight]),
    v.current?.timer ? 1 : 0, v.bothHands?.p.key ?? null, st.open, st.note,
    !!st.undo, st.undo?.key ?? null, !!lastAct, lastAct?.cmd.kind ?? null, session.log.length,
  ]);
  if (sig !== st.sig) {
    const openDone = !!root.querySelector(".cook-done")?.hasAttribute("open");
    root.innerHTML = html(v, cook, now, session);
    if (openDone) root.querySelector(".cook-done")?.setAttribute("open", "");
    st.sig = sig;
  }
  paintLive(root, v, now);
  syncActHeight(root);
}

/** Repaint hook for the app's paint loop. */
export function paintCook() { draw(); }

/** @param {HTMLElement} btn */
function act(btn) {
  const rt = runtime();
  const key = /** @type {string} */ (btn.dataset.key);
  st.note = null;
  // The button may be older than the session (another tab, an alarm since it was drawn): act only
  // on a step that is still open.
  if (rt.session()?.done[key] != null) { draw(); return; }
  if (btn.dataset.do === "timer") { startTimer(key); st.open = null; paintAll(); draw(); return; }
  const plan = rt.plan();
  const cook = plan && resolved(plan);
  const info = cook && cook.kind === "ok" ? cook.info.get(key) : null;
  const pinned = !!btn.closest(".cook-pin");
  rt.done(key);
  const session = rt.session();
  // CP2: the Undo bar takes the Done bar's place for UNDO_MS, or until the next logged action.
  st.undo = info ? { key, until: rt.now() + UNDO_MS, logLen: session?.log.length ?? 0, pinned } : null;
  st.open = null;
  paintAll();
  draw();
}

/** @param {string} key */
function startTimer(key) {
  const rt = runtime();
  const plan = rt.plan();
  const cook = plan && resolved(plan);
  if (!cook || cook.kind !== "ok") return;
  const i = cook.info.get(key);
  const old = rt.timer(key);
  // Never restart a timer that is running or ringing (started in another tab, or during the hold).
  if (!i?.step.timer || (old && old.ackAt == null)) return;
  const w = i.step.wait;
  const wait = w ? { min: w.min * 1000, ideal: w.ideal * 1000, max: w.max * 1000 } : undefined;
  gated(() => {
    rt.start({ key, durMs: /** @type {number} */ (i.step.timer) * 1000, label: i.text, verb: i.step.then ?? verbFor(i.step.t), tide: true, wait });
    paintAll();
  draw();
  });
}

function behind() {
  const rt = runtime();
  const session = rt.session();
  const cook = session?.plan && resolved(session.plan);
  if (!session?.plan || !cook || cook.kind !== "ok") return;
  const res = replan(session, cook, rt.now());
  if (res.kind === "error") st.note = `Could not move the plan: ${res.message}. Keep going in order.`;
  else { st.note = null; rt.replan(res.plan); }
  paintAll();
  draw();
}

function end() {
  openSheet({
    title: "End cooking?",
    html: "<p>The plan and its done steps go. Running timers stay.</p>",
    ok: "End cooking",
    cancel: "Keep cooking",
    onOk: () => { closeSheet(); runtime().endCooking(); location.hash = "#"; },
  });
}

/** CP2: the Undo bar's own button; reverses the one "done" action it stands for. */
function undoNow() {
  const key = st.undo?.key ?? null;
  st.undo = null;
  runtime().undo();
  // The step reopens where it was: Undo should leave the user right back where they tapped Done.
  st.open = key;
  paintAll();
  draw();
}

/**
 * CP2: "Not done yet" on the permanent Just done line, at any later point in the meal. Reverts
 * through the same runtime undo path as the 15 s Undo bar, guarded to the exact step it names (a
 * later unrelated action since then is left alone).
 * @param {string} key
 */
function notDoneYet(key) {
  const rt = runtime();
  const log = rt.session()?.log ?? [];
  const tail = log[log.length - 1];
  if (tail?.kind !== "done" || tail.key !== key) return;
  rt.undo();
  paintAll();
  draw();
}

/**
 * @param {HTMLElement} app
 * @param {import('../types').Recipe[]} recipes
 */
export function renderCook(app, recipes) {
  document.title = "Cooking";
  st.tap = null;
  st.app = app;
  st.recipes = recipes;
  st.sig = "";
  st.open = null;
  st.note = null;
  st.cache = null;
  st.undo = null;
  app.innerHTML = `<div data-cook-root></div>`;

  /**
   * @param {Event} e
   * @param {string} sel
   */
  const hit = (e, sel) => /** @type {HTMLElement | null} */ (/** @type {Element} */ (e.target).closest?.(sel));
  // CP2: a tap fires on pointerup while the finger is still over the button it went down on; a
  // slide-off (pointerleave/pointercancel) before lifting cancels it, however long it was down.
  app.onpointerdown = e => {
    const btn = hit(e, "[data-do]");
    if (!btn || (e.pointerType === "mouse" && e.button !== 0)) return;
    st.tap = { btn, pointer: e.pointerId };
  };
  app.onpointerup = e => {
    if (!st.tap || e.pointerId !== st.tap.pointer) return;
    const btn = st.tap.btn;
    st.tap = null;
    act(btn);
  };
  // Only the finger that went down can cancel its own tap: a second finger or a sleeve does not.
  app.onpointercancel = app.onpointerleave = e => { if (st.tap && e.pointerId === st.tap.pointer) st.tap = null; };
  app.oncontextmenu = e => { if (hit(e, "[data-do]")) e.preventDefault(); };
  app.onclick = e => {
    const doBtn = hit(e, "[data-do]");
    // A click that no pointer made (keyboard, switch control): act at once.
    if (doBtn) { if (/** @type {MouseEvent} */ (e).detail === 0) act(doBtn); return; }
    if (hit(e, "[data-undo]")) { undoNow(); return; }
    const notDone = hit(e, "[data-not-done]");
    if (notDone) { notDoneYet(/** @type {string} */ (notDone.dataset.key)); return; }
    const timer = hit(e, "[data-timer]");
    if (timer) { startTimer(/** @type {string} */ (timer.dataset.timer)); return; }
    const row = hit(e, "[data-open]");
    if (row) { st.open = st.open === row.dataset.open ? null : /** @type {string} */ (row.dataset.open); draw(); return; }
    if (hit(e, "[data-behind]")) { behind(); return; }
    if (hit(e, "[data-end]")) { end(); return; }
    if (hit(e, "[data-end-now]")) { runtime().endCooking(); location.hash = "#"; }
  };
  draw();
  window.scrollTo(0, 0);
}

/**
 * #/done: every step is done.
 * @param {HTMLElement} app
 */
export function renderDone(app) {
  document.title = "Done";
  st.app = null;
  const rt = runtime();
  const session = rt.session();
  const plan = session?.plan;
  if (!plan) { location.replace("#"); return; }
  if (plan.steps.some(p => session.done[p.key] == null)) { location.replace("#/cook"); return; }
  const last = Math.max(...Object.values(session.done));
  const took = mins(last - session.startedAt);
  const diff = Math.round((last - plan.serveAt) / 60_000);
  const vs = diff > 1 ? `${diff} min after the plan` : diff < -1 ? `${-diff} min ahead of the plan` : "on time";
  app.innerHTML = `<div class="flow done-view"><h1 class="rtitle">Done. Serve it.</h1>
    <p class="rsub">${plan.steps.length} steps in ${took} min, finished at ${esc(clockAt(last))}: ${esc(vs)}.</p>
    <div class="flow-foot"><button type="button" class="btn btn-main" data-clear>Clear session</button></div></div>`;
  app.onclick = e => {
    if (!(/** @type {Element} */ (e.target).closest("[data-clear]"))) return;
    rt.endCooking();
    location.hash = "#";
  };
  window.scrollTo(0, 0);
}
