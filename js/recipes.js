// Recipe loader. Recipes live in the public kitchen-recipes repo and are served next to the app.
// CP3: schema 2, from recipes/v2/index.json plus one recipes/v2/<id>.json per recipe (relative
// URLs, so the app works under any subpath). The schema 1 files (recipes/*.json) stay published for
// app versions from before CP3. The service worker keeps a copy for offline use (network first,
// cache fallback). Every file is checked with js/recipe-schema.js, a byte-identical copy of the
// recipes repo's own validator (scripts/schema-v2.mjs).
import { checkIndexV2, checkRecipeV2, INDEX_VERSION as V2 } from "./recipe-schema.js";

/** Folder that holds index.json and the recipe files, relative to index.html. */
export const RECIPES_BASE = "recipes/v2/";

/** Index format version this app understands. */
export const INDEX_VERSION = V2;

/** Thrown when the recipes cannot be fetched or are malformed. */
export class RecipeLoadError extends Error {
  /**
   * @param {string} message
   * @param {unknown} [cause]
   */
  constructor(message, cause) {
    super(message);
    this.name = "RecipeLoadError";
    this.cause = cause;
  }
}

/**
 * @typedef {(url: string) => Promise<{ ok: boolean, status: number, json(): Promise<unknown> }>} FetchLike
 */

/**
 * @param {FetchLike} fetchFn
 * @param {string} url
 * @returns {Promise<unknown>}
 */
async function getJson(fetchFn, url) {
  let res;
  try { res = await fetchFn(url); } catch (e) { throw new RecipeLoadError("network error: " + url, e); }
  if (!res.ok) throw new RecipeLoadError(`HTTP ${res.status}: ${url}`);
  try { return await res.json(); } catch (e) { throw new RecipeLoadError("invalid JSON: " + url, e); }
}

/**
 * Parse and check recipes/v2/index.json.
 * @param {unknown} index
 * @returns {import('./types').RecipeIndexEntry[]}
 */
export function parseIndex(index) {
  const errs = checkIndexV2(index);
  if (errs.length) throw new RecipeLoadError("index.json: " + errs.slice(0, 3).join("; "));
  const list = /** @type {{ recipes: import('./types').RecipeIndexEntry[] }} */ (index).recipes;
  return list.map(e => ({ id: e.id, title: e.title, file: e.file }));
}

/**
 * Check a recipe file strictly (schema 2). Throws with the first problems found.
 * @param {unknown} r
 * @param {import('./types').RecipeIndexEntry} entry
 * @returns {import('./types').Recipe}
 */
export function checkRecipe(r, entry) {
  const errs = checkRecipeV2(r, entry);
  if (errs.length) throw new RecipeLoadError(`${entry.file}: ${errs.slice(0, 3).join("; ")}`);
  return /** @type {import('./types').Recipe} */ (r);
}

/**
 * Load every recipe listed in index.json, in index order. Fails as a whole: a partial list would
 * silently hide a dish.
 * @param {FetchLike} fetchFn
 * @param {string} [base]
 * @returns {Promise<import('./types').Recipe[]>}
 */
export async function loadRecipes(fetchFn, base = RECIPES_BASE) {
  const entries = parseIndex(await getJson(fetchFn, base + "index.json"));
  return Promise.all(entries.map(async e => checkRecipe(await getJson(fetchFn, base + e.file), e)));
}
