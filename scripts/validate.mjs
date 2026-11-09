#!/usr/bin/env node
// Validates the recipe files. No dependencies; Node 20+.
// Usage: node scripts/validate.mjs [recipes-dir]   (default: recipes/ next to this script's parent)
//
// Checks:
// - recipes/index.json parses and has the shape {version: 1, recipes: [{id, title, file}]}
// - every listed file exists, parses, and its id equals the index id and its file name
// - every recipes/*.json file (other than index.json) is listed in the index
// - each recipe has the fields the app reads, with the right types
// - ingredient keys are unique within a recipe
// - every {k} placeholder in step text and sub-steps names an ingredient key of that recipe
// - files are UTF-8 without BOM, pretty-printed with 2 spaces and end with one newline
// Schema 2 (recipes/v2/, read by the app from CP3 on): the same file checks, plus every rule in
// scripts/schema-v2.mjs (step ids, dependencies without cycles, timings, dishes, phases, alt texts).
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { checkIndexV2, checkRecipeV2 } from "./schema-v2.mjs";

const DIR = resolve(process.argv[2] || join(import.meta.dirname, "..", "recipes"));
const ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const PLACEHOLDER = /\{(\w+)\}/g;
// Keep in sync with kitchen-master js/recipes.js checkRecipe(): the app refuses anything else.
const UNITS = new Set(["", "g", "ml", "tsp", "tbsp", "cloves"]);
const KEY = /^[A-Za-z0-9_]{1,40}$/;

/** @type {string[]} */
const errors = [];
const fail = (where, msg) => errors.push(`${where}: ${msg}`);

const isStr = v => typeof v === "string";
const isNum = v => typeof v === "number" && Number.isFinite(v);
const isObj = v => !!v && typeof v === "object" && !Array.isArray(v);

/** Read and parse a JSON file; checks encoding and formatting. Returns undefined on failure. */
function readJson(name, dir = DIR) {
  const path = join(dir, name);
  if (!existsSync(path)) { fail(name, "file not found"); return undefined; }
  const buf = readFileSync(path);
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) fail(name, "has a UTF-8 BOM");
  const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(buf);
  let data;
  try { data = JSON.parse(text.replace(/^﻿/, "")); } catch (e) { fail(name, "invalid JSON: " + e.message); return undefined; }
  if (text !== JSON.stringify(data, null, 2) + "\n") {
    fail(name, "not pretty-printed (expected JSON.stringify(data, null, 2) plus a trailing newline)");
  }
  return data;
}

function checkRecipe(name, r, entry) {
  if (!isObj(r)) { fail(name, "recipe must be an object"); return; }
  if (r.id !== entry.id) fail(name, `id "${r.id}" does not match index id "${entry.id}"`);
  if (name !== r.id + ".json") fail(name, `file name does not match id "${r.id}"`);
  for (const f of ["title", "sub", "time", "tip"]) if (!isStr(r[f])) fail(name, `${f} must be a string`);
  if (r.title !== entry.title) fail(name, `title "${r.title}" does not match index title "${entry.title}"`);
  if (!Number.isInteger(r.base) || r.base < 1) fail(name, "base must be a positive integer");

  const keys = new Set();
  if (!Array.isArray(r.groups) || r.groups.length === 0) fail(name, "groups must be a non-empty array");
  else r.groups.forEach((g, gi) => {
    const at = `${name} groups[${gi}]`;
    if (!isObj(g) || !isStr(g.title) || !Array.isArray(g.items)) { fail(at, "needs title (string) and items (array)"); return; }
    g.items.forEach((it, ii) => {
      const iat = `${at}.items[${ii}]`;
      if (!isObj(it)) { fail(iat, "must be an object"); return; }
      if (!isStr(it.k) || !KEY.test(it.k)) fail(iat, "k must be 1-40 letters, digits or _");
      else if (keys.has(it.k)) fail(iat, `duplicate ingredient key "${it.k}"`);
      else keys.add(it.k);
      if (!isNum(it.q) || it.q < 0) fail(iat, "q must be a non-negative number");
      if (!isStr(it.u) || !UNITS.has(it.u)) fail(iat, `u must be one of: ${[...UNITS].map(u => JSON.stringify(u)).join(", ")}`);
      if (!isStr(it.n)) fail(iat, "n must be a string");
    });
  });

  if (!Array.isArray(r.phases) || r.phases.length === 0) fail(name, "phases must be a non-empty array");
  else r.phases.forEach((p, pi) => {
    const at = `${name} phases[${pi}]`;
    if (!isObj(p) || !isStr(p.t) || !isStr(p.time) || !Array.isArray(p.steps)) {
      fail(at, "needs t (string), time (string) and steps (array)"); return;
    }
    p.steps.forEach((s, si) => {
      const sat = `${at}.steps[${si}]`;
      if (!isObj(s) || !isStr(s.t)) { fail(sat, "needs t (string)"); return; }
      if (s.sub !== undefined && (!Array.isArray(s.sub) || !s.sub.every(isStr))) fail(sat, "sub must be an array of strings");
      if (s.timer !== undefined && (!Number.isInteger(s.timer) || s.timer <= 0 || s.timer > 86400)) fail(sat, "timer must be whole seconds, 1 to 86400");
      for (const t of [s.t, ...(Array.isArray(s.sub) ? s.sub.filter(isStr) : [])]) {
        for (const [, k] of t.matchAll(PLACEHOLDER)) {
          if (!keys.has(k)) fail(sat, `placeholder {${k}} has no ingredient with that key: "${t}"`);
        }
      }
    });
  });
}

function main() {
  if (!existsSync(DIR)) { console.error(`recipes directory not found: ${DIR}`); process.exit(1); }
  const index = readJson("index.json");
  /** @type {Set<string>} */
  const listed = new Set();
  let count = 0;
  if (index !== undefined) {
    if (!isObj(index)) fail("index.json", "must be an object");
    else if (index.version !== 1) fail("index.json", `version must be 1, got ${JSON.stringify(index.version)}`);
    else if (!Array.isArray(index.recipes) || index.recipes.length === 0) fail("index.json", "recipes must be a non-empty array");
    else {
      const ids = new Set();
      index.recipes.forEach((e, i) => {
        const at = `index.json recipes[${i}]`;
        if (!isObj(e) || !isStr(e.id) || !isStr(e.title) || !isStr(e.file)) { fail(at, "needs id, title and file (strings)"); return; }
        if (!ID.test(e.id)) fail(at, `id "${e.id}" must be lowercase words joined by "-"`);
        if (ids.has(e.id)) fail(at, `duplicate id "${e.id}"`);
        ids.add(e.id);
        if (e.file !== e.id + ".json") { fail(at, `file must be "${e.id}.json", got "${e.file}"`); return; }
        listed.add(e.file);
        const r = readJson(e.file);
        if (r !== undefined) { checkRecipe(e.file, r, e); count++; }
      });
    }
  }
  for (const f of readdirSync(DIR).filter(f => f.endsWith(".json") && f !== "index.json")) {
    if (!listed.has(f)) fail(f, "not listed in index.json");
  }
  count += validateV2(join(DIR, "v2"));
  if (errors.length) {
    console.error(`recipe validation failed (${errors.length} problem${errors.length === 1 ? "" : "s"}):`);
    for (const e of errors) console.error("  - " + e);
    process.exit(1);
  }
  console.log(`ok: ${count} recipe files valid in ${DIR}`);
}

/**
 * Schema 2 files in recipes/v2/. Returns the number of recipes checked.
 * @param {string} dir
 */
function validateV2(dir) {
  if (!existsSync(dir)) return 0;
  const index = readJson("index.json", dir);
  if (index === undefined) return 0;
  const where = "v2/index.json";
  const ierrs = checkIndexV2(index);
  for (const e of ierrs) fail(where, e);
  if (ierrs.length) return 0;
  let n = 0;
  const listed = new Set();
  for (const e of index.recipes) {
    listed.add(e.file);
    const r = readJson(e.file, dir);
    if (r === undefined) continue;
    for (const msg of checkRecipeV2(r, e)) fail("v2/" + e.file, msg);
    n++;
  }
  for (const f of readdirSync(dir).filter(f => f.endsWith(".json") && f !== "index.json")) {
    if (!listed.has(f)) fail("v2/" + f, "not listed in v2/index.json");
  }
  return n;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
