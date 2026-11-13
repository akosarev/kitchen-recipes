// Settings (#/settings): test alarm, "How alarms work" (the honest v0 promise, plan section 10),
// what this device supports, the backup-timer shortcut setup, JSON export and import, theme, version.
import { esc } from "./html.js";
import { runtime } from "../timer/app.js";
import { store, KEYS } from "../store.js";
import { isStandalone } from "../install.js";
import { SHORTCUT_NAME } from "../timer/backup.js";
import { openSheet, paintAll, prefs, quickSec } from "./chrome.js";

export const TEST_TEXT = "Turn silent mode on, raise media volume, tap Test alarm.";

/** "How alarms work": what v0 promises and what it does not (plan section 10). */
export const PROMISES = [
  "The remaining time is always right after a reload, the screen sleeping, the app being closed, or a restart.",
  "While Kitchen Master is open and in front with the screen on, the alarm sounds even in silent mode, once it has been armed by a tap.",
  "If an alarm was missed, an \"Overdue by 2:13\" banner appears as soon as the app is back. It alarms once, never twice.",
  "The app opens offline from the home screen.",
];
export const NOT_PROMISED = [
  "No alarm while the phone is locked, another app is open, or during a call or Siri. Use \"Set up backup alarm\" for long waits.",
  "No vibration on iPhone.",
  "The alarm uses media volume. Bluetooth headphones receive it.",
  "Data in a Safari tab is separate from the installed app.",
];

/** @type {{ text: string }} */
const status = { text: "" };

/**
 * App version from the active service worker (its cache is km-<sha>).
 * @returns {Promise<string>}
 */
export async function appVersion() {
  try {
    const sw = navigator.serviceWorker;
    const ctl = sw && sw.controller;
    if (!ctl) return "not cached yet";
    return await new Promise(res => {
      const ch = new MessageChannel();
      const t = setTimeout(() => res("unknown"), 2000);
      ch.port1.onmessage = e => { clearTimeout(t); res(String(e.data && e.data.version || "unknown")); };
      ctl.postMessage("version", [ch.port2]);
    });
  } catch { return "unknown"; }
}

/**
 * @param {string} name
 * @param {string} text
 */
function row(name, text) {
  return `<li><span>${esc(name)}</span><b>${esc(text)}</b></li>`;
}

/**
 * Apply a theme preference to <html data-theme>.
 * @param {import('../types').Prefs['theme']} theme
 */
export function applyTheme(theme) {
  const root = document.documentElement;
  if (theme === "light" || theme === "dark") root.dataset.theme = theme; else delete root.dataset.theme;
}

/** Download every km.v1.* key as JSON. */
export function exportBackup() {
  const file = store.exportAll(runtime().now());
  const blob = new Blob([JSON.stringify(file, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `kitchen-master-backup-${new Date(file.exportedAt).toISOString().slice(0, 10)}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
}

/**
 * Read an export file, validate it, ask before overwriting, then import.
 * @param {File} file
 * @param {() => void} done
 */
export async function importBackup(file, done) {
  let parsed;
  try {
    parsed = JSON.parse(await file.text());
    // Every value is checked before anything is written: a bad value never reaches the app.
    store.checkImport(parsed, runtime().now());
  } catch {
    status.text = "That file is not a Kitchen Master backup. Nothing was changed.";
    done();
    return;
  }
  const n = Object.keys(parsed.data).length;
  openSheet({
    title: "Import backup?",
    html: `<p>This replaces ${esc(n)} saved item${n === 1 ? "" : "s"} on this device (ticks, servings, timers, settings) with the ones in the file.</p>`,
    ok: "Import and replace",
    cancel: "Cancel",
    onOk: () => {
      try {
        const written = store.importAll(parsed, runtime().now());
        status.text = `Imported ${written} item${written === 1 ? "" : "s"}.`;
        applyTheme(prefs().theme);
      } catch (e) {
        status.text = "Import failed: " + (e instanceof Error ? e.message : String(e));
      }
      runtime().reconcile();
      done();
    },
  });
}

/**
 * @param {HTMLElement} app
 */
export function renderSettings(app) {
  document.title = "Settings";
  const rt = runtime();
  const sup = rt.audio.support();
  const p = prefs();
  const theme = p.theme || "auto";
  const tested = p.alarmTestedAt ? new Date(p.alarmTestedAt).toLocaleString() : "never";
  const persisted = p.persist ? (p.persist.granted ? "granted" : "not granted") : "not asked yet (asked on the first launch from the home screen)";
  const wakeText = rt.wake.state === "unsupported" ? "not supported (needs iOS 18.4)" : rt.wake.state;
  app.innerHTML = `<div class="top"><a class="back" href="#">‹ Recipes</a></div>
    <h1 class="rtitle">Settings</h1>
    <section class="card">
      <h3>Test alarm</h3>
      <p>${esc(TEST_TEXT)}</p>
      <button type="button" class="btn btn-main" data-act="test">Test alarm</button>
      <p class="hint" data-test-result>Last test: ${esc(tested)}</p>
    </section>
    <section class="card how">
      <h3>How alarms work</h3>
      <p><b>Kitchen Master promises:</b></p>
      <ul>${PROMISES.map(x => `<li>${esc(x)}</li>`).join("")}</ul>
      <p><b>It does not promise:</b></p>
      <ul>${NOT_PROMISED.map(x => `<li>${esc(x)}</li>`).join("")}</ul>
    </section>
    <section class="card">
      <h3>Backup alarm</h3>
      <p>For long waits, "Set up backup alarm" starts an iOS Clock timer through the Shortcuts app. It rings while the phone is locked and in silent mode. Set it up once:</p>
      <ol>
        <li>Open Shortcuts, tap +, name the shortcut <b>${esc(SHORTCUT_NAME)}</b>.</li>
        <li>Add the action <b>Get Numbers from Input</b> (input: Shortcut Input).</li>
        <li>Add the action <b>Start Timer</b>, set its duration to the <b>Numbers</b> result, unit <b>seconds</b>.</li>
        <li>Run "Set up backup alarm" once from a 5-minute or longer timer and allow Kitchen Master to open Shortcuts.</li>
      </ol>
      <p class="hint">No shortcut? Say "Hey Siri, set a timer for 8 minutes".</p>
    </section>
    <section class="card">
      <h3>This device</h3>
      <ul class="facts-list">
        ${row("Installed app", isStandalone() ? "yes" : "no (Safari tab)")}
        ${row("Web Audio", sup.webAudio ? "yes" : "no")}
        ${row("Audio session switching", sup.audioSession ? "yes" : "no")}
        ${row("Alarm sound", rt.audio.state)}
        ${row("Screen Wake Lock", wakeText)}
        ${row("Persistent storage", persisted)}
        <li><span>Storage now</span><b data-persisted>…</b></li>
      </ul>
    </section>
    <section class="card">
      <h3>Backup and move data</h3>
      <p>Export saves your ticks, servings, timers and settings as a file. Import it in the installed app to move data from a Safari tab.</p>
      <div class="clock-btns">
        <button type="button" class="btn" data-act="export">Export backup</button>
        <label class="btn">Import backup<input type="file" accept="application/json,.json" data-import hidden></label>
      </div>
      <p class="hint" role="status" data-import-status>${esc(status.text)}</p>
    </section>
    <section class="card">
      <h3>Theme</h3>
      <div class="clock-btns" role="radiogroup" aria-label="Theme">
        ${["auto", "light", "dark"].map(t => `<button type="button" class="btn" role="radio" aria-checked="${theme === t}" data-act="theme" data-theme="${t}">${t[0].toUpperCase() + t.slice(1)}</button>`).join("")}
      </div>
    </section>
    <section class="card">
      <h3>Version</h3>
      <ul class="facts-list">
        <li><span>App</span><b data-version>…</b></li>
        ${row("Recipe format", "1 (schema 2 arrives with allergens)")}
        ${row("Quick timer", Math.round(quickSec() / 60) + " min")}
      </ul>
    </section>`;

  appVersion().then(v => { const el = app.querySelector("[data-version]"); if (el) el.textContent = v; });
  const st = /** @type {any} */ (navigator).storage;
  Promise.resolve(st && st.persisted ? st.persisted() : null).then(
    v => { const el = app.querySelector("[data-persisted]"); if (el) el.textContent = v == null ? "unknown" : v ? "persistent" : "may be cleared by the system"; },
    () => {},
  );

  const input = /** @type {HTMLInputElement} */ (app.querySelector("[data-import]"));
  input.onchange = () => {
    const f = input.files && input.files[0];
    input.value = "";
    if (f) importBackup(f, () => { renderSettings(app); paintAll(); });
  };

  app.onclick = e => {
    const el = /** @type {HTMLElement | null} */ (/** @type {HTMLElement} */ (e.target).closest?.("[data-act]"));
    if (!el) return;
    switch (el.dataset.act) {
      case "test": testAlarm(app); break;
      case "export": exportBackup(); break;
      case "theme": {
        const t = /** @type {import('../types').Prefs['theme']} */ (el.dataset.theme);
        store.set(KEYS.prefs, { ...prefs(), theme: t });
        applyTheme(t);
        renderSettings(app);
        break;
      }
    }
  };
}

/**
 * Arm audio (this tap is the gesture), ring once with the audio session on "playback", then give
 * the session back after 3 s.
 * @param {HTMLElement} app
 */
async function testAlarm(app) {
  const rt = runtime();
  const out = app.querySelector("[data-test-result]");
  const state = await rt.audio.arm();
  const path = await rt.audio.ring(0); // the path that really played (play() resolved)
  setTimeout(() => rt.audio.quiet(), 3000);
  store.set(KEYS.prefs, { ...prefs(), alarmTestedAt: rt.now() });
  const how = path === "webaudio" ? "Web Audio" : path === "element" ? "the audio file" : null;
  if (out) {
    out.textContent = how
      ? `Played with ${how}. Did you hear three beeps? If not, raise the volume and check the audio pill.`
      : `No sound path worked (audio ${state}). Tap Test alarm again.`;
  }
  paintAll();
}
