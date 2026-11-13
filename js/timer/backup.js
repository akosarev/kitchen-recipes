// Backup timer via iOS Shortcuts (plan R7). The iOS Clock timer rings while the phone is locked and
// ignores the silent switch, which the web app cannot do. The one-time "KM Timer" shortcut takes
// seconds as text input and starts a Clock timer (setup steps: Settings screen and tests/DEVICE.md).

export const SHORTCUT_NAME = "KM Timer";
/** Waits of 5 minutes or more get a "Backup timer" button. */
export const BACKUP_MIN_MS = 5 * 60_000;

/**
 * shortcuts:// URL that runs "KM Timer" with the seconds as text input.
 * @param {number} seconds
 */
export function backupUrl(seconds) {
  const s = Math.max(1, Math.ceil(Number(seconds) || 0));
  return `shortcuts://run-shortcut?name=${encodeURIComponent(SHORTCUT_NAME)}&input=text&text=${s}`;
}

/**
 * Siri fallback line for a duration ("8 minutes", "1 minute 30 seconds").
 * @param {number} seconds
 */
export function siriText(seconds) {
  const s = Math.max(1, Math.ceil(seconds));
  const m = Math.floor(s / 60), r = s % 60;
  const part = (/** @type {number} */ n, /** @type {string} */ w) => `${n} ${w}${n === 1 ? "" : "s"}`;
  const words = [m ? part(m, "minute") : "", r ? part(r, "second") : ""].filter(Boolean).join(" ");
  return `or say "Hey Siri, set a timer for ${words}"`;
}
