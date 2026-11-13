// Full-screen Lighthouse for one timer (#/clock/<key>), readable from across the kitchen. Controls:
// pause / resume, stop (Undo), -1 / +1 min on a quick timer, "Backup timer" for waits of 5 minutes
// or more (iOS Shortcuts), and the other running timers.
import { esc } from "./html.js";
import { runtime } from "../timer/app.js";
import { timerView } from "../timer/engine.js";
import { lighthouseHtml, paintLighthouse } from "./lighthouse.js";
import { backupUrl, siriText, BACKUP_MIN_MS } from "../timer/backup.js";
import { startQuick, paintAll } from "./chrome.js";

/**
 * The timer a #/clock route shows: the named one, else the most urgent live one.
 * @param {string | null} key
 */
export function clockTimer(key) {
  const rt = runtime();
  if (key) { const t = rt.timer(key); if (t) return t; }
  const now = rt.now();
  return rt.live().sort((a, b) => timerView(a, now).remainingMs - timerView(b, now).remainingMs)[0] || null;
}

/** @param {import('../types').Timer} t */
const recipeOf = t => (t.key.startsWith("adhoc/") ? null : t.key.split("/")[0]);

/**
 * @param {import('../types').Timer} t
 * @param {number} now
 */
function backupLink(t, now) {
  const v = timerView(t, now);
  if (t.durMs < BACKUP_MIN_MS || t.firedAt != null || v.due || v.paused) return "";
  const sec = Math.ceil(v.remainingMs / 1000);
  return `<p class="hint">If your phone locks, Kitchen Master cannot ring. A backup alarm in the Clock app can.</p>`
    + `<a class="btn backup" data-backup href="${esc(backupUrl(sec))}">Set up backup alarm</a>`
    + `<p class="hint" data-siri>${esc(siriText(sec))}</p>`;
}

/**
 * @param {import('../types').Timer} t
 * @param {number} now
 */
function controls(t, now) {
  const v = timerView(t, now);
  const k = esc(t.key);
  const out = [];
  if (t.firedAt != null) {
    if (t.ackAt == null) out.push(`<button type="button" class="btn btn-main" data-act="ack" data-key="${k}">Stop alarm</button>`);
    out.push(`<button type="button" class="btn" data-act="cancel" data-key="${k}">Clear timer</button>`);
    return out.join("");
  }
  if (t.key.startsWith("adhoc/")) {
    out.push(`<button type="button" class="btn" data-act="minus" data-key="${k}" aria-label="One minute less">−1 min</button>`);
    out.push(`<button type="button" class="btn" data-act="plus" data-key="${k}" aria-label="One minute more">+1 min</button>`);
  }
  out.push(v.paused
    ? `<button type="button" class="btn btn-main" data-act="resume" data-key="${k}">Resume</button>`
    : `<button type="button" class="btn" data-act="pause" data-key="${k}">Pause</button>`);
  out.push(`<button type="button" class="btn" data-act="cancel" data-key="${k}">Stop timer</button>`);
  return out.join("");
}

/**
 * @param {string | null} key
 */
function clockHtml(key) {
  const rt = runtime();
  const now = rt.now();
  const t = clockTimer(key);
  if (!t) {
    return `<div class="top"><a class="back" href="#">‹ Recipes</a></div>`
      + `<div class="clock-empty"><h1 class="rtitle">No timer running</h1>`
      + `<button type="button" class="btn btn-main" data-act="quick">Start a quick timer</button></div>`;
  }
  const rid = recipeOf(t);
  const back = rid ? `<a class="back" href="#${esc(rid)}">‹ Recipe</a>` : `<a class="back" href="#">‹ Recipes</a>`;
  const others = rt.live().filter(x => x.key !== t.key)
    .map(x => `<li><a href="#/clock/${esc(encodeURIComponent(x.key))}">${esc(x.verb || "Timer")}: ${esc(x.label || "")}</a></li>`).join("");
  return `<div class="top">${back}</div>`
    + `<section class="clock" data-key="${esc(t.key)}">${lighthouseHtml(t, now, "big")}`
    + `<p class="clock-label">${esc(t.label || "")}</p>`
    + `<div class="clock-btns">${controls(t, now)}</div>`
    + `<div class="clock-backup">${backupLink(t, now)}</div>`
    + (others ? `<h3>Other timers</h3><ul class="clock-others">${others}</ul>` : "")
    + `</section>`;
}

/** @type {{ key: string | null, structure: string }} */
const view = { key: null, structure: "" };

/** @param {string | null} key */
function structure(key) {
  const rt = runtime();
  const now = rt.now();
  const t = clockTimer(key);
  if (!t) return "none";
  const v = timerView(t, now);
  const backup = t.durMs >= BACKUP_MIN_MS && t.firedAt == null && !v.due && !v.paused;
  return [t.key, t.startedAt, t.durMs, v.zone, v.paused, t.firedAt, t.ackAt, backup, rt.live().map(x => x.key).join(",")].join("|");
}

/**
 * @param {HTMLElement} app
 * @param {string | null} key
 */
export function renderClock(app, key) {
  document.title = "Timer";
  view.key = key;
  view.structure = structure(key);
  app.innerHTML = clockHtml(key);
  app.onclick = e => {
    const el = /** @type {HTMLElement | null} */ (/** @type {HTMLElement} */ (e.target).closest?.("[data-act], [data-backup]"));
    if (!el) return;
    const rt = runtime();
    if (el.hasAttribute("data-backup")) { rt.flush(); return; } // session written before leaving for Shortcuts
    const k = /** @type {string} */ (el.dataset.key);
    switch (el.dataset.act) {
      case "ack": rt.ack(k); break;
      case "cancel": rt.cancel(k); break;
      case "pause": rt.pause(k); break;
      case "resume": rt.resume(k); break;
      case "plus": rt.adjust(k, 60_000); break;
      case "minus": rt.adjust(k, -60_000); break;
      case "quick": startQuick(); break;
    }
    paintAll();
  };
}

/**
 * Paint the clock view in place; re-render when its structure changed.
 * @param {HTMLElement} app
 */
export function paintClock(app) {
  const sec = app.querySelector("section.clock, .clock-empty");
  if (!sec) return;
  const s = structure(view.key);
  if (s !== view.structure) { renderClock(app, view.key); return; }
  const rt = runtime();
  const now = rt.now();
  const t = clockTimer(view.key);
  if (!t) return;
  const lh = app.querySelector(".lh");
  if (lh) paintLighthouse(lh, t, now);
  const a = /** @type {HTMLAnchorElement | null} */ (app.querySelector("[data-backup]"));
  if (a) {
    const sec = Math.ceil(timerView(t, now).remainingMs / 1000);
    const href = backupUrl(sec);
    if (a.getAttribute("href") !== href) a.setAttribute("href", href);
    const siri = app.querySelector("[data-siri]");
    if (siri) siri.textContent = siriText(sec);
  }
}
