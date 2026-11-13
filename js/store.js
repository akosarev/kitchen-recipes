// localStorage wrapper with versioned keys (km.v1.*). Every read and write is synchronous and
// wrapped in try/catch: a throwing storage (private mode, quota, blocked site data) never crashes
// the page. A failed write notifies the save-error listeners ("Can't save" signal).
import { cleanSession } from "./timer/session.js";
import { cleanTonight } from "./tonight.js";
import { cleanSetup } from "./setup.js";

export const PREFIX = "km.v1.";

/** Versioned storage keys (docs/v0-plan.md section 6). */
export const KEYS = {
  prefs: PREFIX + "prefs",
  /** The cook session: timers as start/end epochs (CP2), written on every change. */
  session: PREFIX + "session",
  /** Tonight's per-meal draft: allergen toggles (CP3), picks (CP4). Expires after 12 h. */
  tonight: PREFIX + "tonight",
  /** The last cook setup (CP4): offered as the default, not a profile. */
  lastSetup: PREFIX + "lastSetup",
  /** CP1 (ux-v1): the install question's answer, once given, on this device (never re-asked). */
  installAnswer: PREFIX + "installAnswer",
  /** CP1 (ux-v1): the home screen's install tip, once dismissed, on this device. */
  installDismissed: PREFIX + "installDismissed",
  /** @param {string} id */
  servings: id => PREFIX + "servings." + id,
  /** @param {string} id */
  checks: id => PREFIX + "checks." + id,
};

/**
 * Keys written by the old single-file page (serv:<id>, chk:<id>), their km.v1 replacement and the
 * value shape the old page wrote. The origin (akosarev.github.io) is shared by every project site,
 * so only exact keys for known recipe ids with the expected shape are treated as ours.
 * @type {{ prefix: string, to: (id: string) => string, valid: (v: unknown) => boolean }[]}
 */
const LEGACY = [
  { prefix: "serv:", to: KEYS.servings, valid: v => isServings(v) },
  { prefix: "chk:", to: KEYS.checks, valid: isBoolMap },
];

/**
 * A plain object (not an array, not a class instance).
 * @param {unknown} v
 * @returns {v is Record<string, unknown>}
 */
export function isPlainObject(v) {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/**
 * A plain object whose values are all booleans (a checkmark map, old page and km.v1 alike).
 * @param {unknown} v
 * @returns {v is Record<string, boolean>}
 */
export function isBoolMap(v) {
  return isPlainObject(v) && Object.values(v).every(x => typeof x === "boolean");
}

/**
 * A servings count the app can show: an integer from 1 to 12.
 * @param {unknown} v
 * @returns {v is number}
 */
export function isServings(v) {
  return Number.isInteger(v) && /** @type {number} */ (v) >= 1 && /** @type {number} */ (v) <= 12;
}

/** @param {unknown} n */
const finite = n => typeof n === "number" && Number.isFinite(n);

/**
 * Checked preferences: a plain object whose known fields have the right type (unknown fields are
 * dropped). Null when it is not an object or a known field is wrong.
 * @param {unknown} v
 * @returns {import('./types').Prefs | null}
 */
export function cleanPrefs(v) {
  if (!isPlainObject(v)) return null;
  /** @type {import('./types').Prefs} */
  const out = {};
  if (v.theme !== undefined) {
    if (v.theme !== "auto" && v.theme !== "light" && v.theme !== "dark") return null;
    out.theme = v.theme;
  }
  if (v.quickSec !== undefined) {
    if (!finite(v.quickSec)) return null;
    out.quickSec = /** @type {number} */ (v.quickSec);
  }
  if (v.alarmTestedAt !== undefined) {
    if (!finite(v.alarmTestedAt)) return null;
    out.alarmTestedAt = /** @type {number} */ (v.alarmTestedAt);
  }
  if (v.persist !== undefined) {
    const p = v.persist;
    if (!isPlainObject(p) || typeof p.granted !== "boolean" || !finite(p.at)) return null;
    out.persist = { granted: p.granted, at: /** @type {number} */ (p.at) };
  }
  return out;
}

/**
 * The value to write for one imported key, checked like the app reads it. Throws on a bad value;
 * undefined means "nothing to write" (a session that has already ended).
 * @param {string} key
 * @param {unknown} v
 * @param {number} now
 * @returns {unknown}
 */
function importValue(key, v, now) {
  if (key === KEYS.prefs) {
    const p = cleanPrefs(v);
    if (!p) throw new Error("Bad value for " + key);
    return p;
  }
  if (key === KEYS.session) {
    if (!isPlainObject(v) || v.v !== 1 || typeof v.id !== "string") throw new Error("Bad value for " + key);
    return cleanSession(v, now) ?? undefined;
  }
  if (key === KEYS.lastSetup) {
    const s = cleanSetup(v);
    if (!s) throw new Error("Bad value for " + key);
    return s;
  }
  if (key === KEYS.tonight) {
    // The shape must be right; an expired draft (or one dated far in the future) is then simply
    // not written: toggles are per meal.
    if (!isPlainObject(v) || typeof v.createdAt !== "number" || !cleanTonight({ ...v, createdAt: now }, now)) {
      throw new Error("Bad value for " + key);
    }
    return cleanTonight(v, now) ?? undefined;
  }
  if (key.startsWith(KEYS.checks(""))) {
    if (!isBoolMap(v)) throw new Error("Bad value for " + key);
    return v;
  }
  if (key.startsWith(KEYS.servings(""))) {
    if (!isServings(v)) throw new Error("Bad value for " + key);
    return v;
  }
  throw new Error("Unexpected key in export: " + key);
}

/**
 * @typedef {(err: unknown, key: string) => void} SaveErrorListener
 */

/**
 * @param {() => (import('./types').StorageLike | null | undefined)} getBackend
 */
export function createStore(getBackend) {
  /** @type {Set<SaveErrorListener>} */
  const listeners = new Set();

  /** @returns {import('./types').StorageLike | null} */
  function backend() {
    try { return getBackend() || null; } catch { return null; }
  }

  /**
   * @param {unknown} err
   * @param {string} key
   */
  function saveFailed(err, key) {
    for (const fn of listeners) {
      try { fn(err, key); } catch { /* a listener must not break saving */ }
    }
  }

  /**
   * @param {string} key
   * @param {string} raw
   * @returns {boolean}
   */
  function setRaw(key, raw) {
    const b = backend();
    if (!b) { saveFailed(new Error("storage unavailable"), key); return false; }
    try { b.setItem(key, raw); return true; } catch (e) { saveFailed(e, key); return false; }
  }

  /** @returns {string[]} */
  function allKeys() {
    const b = backend();
    if (!b) return [];
    try {
      const out = [];
      for (let i = 0; i < b.length; i++) { const k = b.key(i); if (k != null) out.push(k); }
      return out;
    } catch { return []; }
  }

  const api = {
    /**
     * Read a JSON value, or the default when missing, unreadable or unparsable.
     * @template T
     * @param {string} key
     * @param {T} d
     * @returns {T}
     */
    get(key, d) {
      try {
        const b = backend();
        const v = b ? b.getItem(key) : null;
        return v == null ? d : JSON.parse(v);
      } catch { return d; }
    },

    /**
     * Write a JSON value. Returns false (and signals) when the write fails.
     * @param {string} key
     * @param {unknown} v
     * @returns {boolean}
     */
    set(key, v) {
      let raw;
      try { raw = JSON.stringify(v); } catch (e) { saveFailed(e, key); return false; }
      return setRaw(key, raw);
    },

    /** @param {string} key */
    remove(key) {
      try { backend()?.removeItem(key); } catch { /* ignore */ }
    },

    /** All km.v1.* keys currently stored. */
    keys() { return allKeys().filter(k => k.startsWith(PREFIX)); },

    /**
     * Listen for failed writes. Returns an unsubscribe function.
     * @param {SaveErrorListener} fn
     */
    onSaveError(fn) { listeners.add(fn); return () => { listeners.delete(fn); }; },

    /**
     * Move data written by the old page (serv:<id>, chk:<id>) to km.v1 keys. Only exact keys for
     * the given recipe ids are touched, and only when the value has the shape the old page wrote
     * (servings: integer 1-12; checks: plain object of booleans); anything else on the shared
     * origin is left alone. An existing km.v1 value wins. A legacy key is removed only after its
     * value is safely stored, so a failed write keeps the old data for the next boot. Idempotent.
     * @param {Iterable<string>} knownIds recipe ids the app knows
     * @returns {number} number of legacy keys migrated
     */
    migrateLegacy(knownIds) {
      const b = backend();
      if (!b) return 0;
      let moved = 0;
      for (const id of knownIds) {
        for (const { prefix, to, valid } of LEGACY) {
          const k = prefix + id;
          let raw = null;
          try { raw = b.getItem(k); } catch { continue; }
          if (raw == null) continue;
          let value;
          try { value = JSON.parse(raw); } catch { continue; }
          if (!valid(value)) continue;
          const target = to(id);
          let existing = null;
          try { existing = b.getItem(target); } catch { continue; }
          if (existing == null && !setRaw(target, raw)) continue;
          api.remove(k);
          moved++;
        }
      }
      return moved;
    },

    /**
     * Snapshot of every km.v1.* key, for backup or moving data from a Safari tab to the app.
     * @param {number} [now]
     * @returns {import('./types').ExportFile}
     */
    exportAll(now = Date.now()) {
      /** @type {Record<string, unknown>} */
      const data = {};
      for (const k of api.keys()) data[k] = api.get(k, null);
      return { app: "kitchen-master", v: 1, exportedAt: now, data };
    },

    /**
     * Check an export without writing: the wrapper, the key names and every value (checked the
     * way the app reads it). Throws on an invalid file.
     * @param {unknown} file
     * @param {number} [now] for the session check (ended sessions are not written)
     * @returns {[string, unknown][]} the keys and values to write
     */
    checkImport(file, now = Date.now()) {
      if (!file || typeof file !== "object") throw new Error("Not a Kitchen Master export");
      const f = /** @type {Partial<import('./types').ExportFile>} */ (file);
      if (f.app !== "kitchen-master" || f.v !== 1 || !isPlainObject(f.data)) {
        throw new Error("Not a Kitchen Master v1 export");
      }
      const entries = Object.entries(f.data);
      for (const [k] of entries) {
        if (!k.startsWith(PREFIX)) throw new Error("Unexpected key in export: " + k);
      }
      return entries
        .map(([k, v]) => /** @type {[string, unknown]} */ ([k, importValue(k, v, now)]))
        .filter(([, v]) => v !== undefined);
    },

    /**
     * Restore an export. Validates the whole file, every value included, before writing
     * anything (checkImport). Throws on an invalid file.
     * @param {unknown} file
     * @param {number} [now]
     * @returns {number} number of keys written
     */
    importAll(file, now = Date.now()) {
      const values = api.checkImport(file, now);
      let n = 0;
      for (const [k, v] of values) { if (api.set(k, v)) n++; }
      return n;
    },
  };
  return api;
}

/** The app's store, backed by window.localStorage (looked up lazily; access may throw). */
export const store = createStore(() => globalThis.localStorage);
