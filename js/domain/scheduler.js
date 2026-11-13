// Greedy backward list scheduler (docs/v0-plan.md section 9). Deterministic, no solver, pure.
//
// Steps of 1-2 adapted recipes are scheduled backwards from serve time (0 = serve):
// - A passive step with a wait (Tide Marks) and exactly one active successor is coupled with it into
//   one block with fixed offsets, so the noodles never sit in the pot past the ideal time.
// - Hands = 1: no two active intervals overlap. Passive steps never use hands.
// - Equipment is counted: at any moment the holders of a kind never need more than the setup has.
// - Sinks (steps nothing waits for) end at serve. A block that does not fit slides earlier until it
//   does: the conflicting sub-interval then ends where the blocker starts.
// - Each predecessor must end before the part of the block that needs it starts.
// The result is shifted so the plan starts at 0. Times are in seconds inside, milliseconds out.

/** @typedef {import('../types').Recipe} Recipe */
/** @typedef {import('../types').Step} Step */
/** @typedef {import('../types').Equipment} Equipment */

/** A block that would have to start more than 6 hours before serve does not fit. */
export const MAX_SPAN_S = 6 * 3600;
/** Two active steps of different dishes closer than this: "Both need your hands". */
export const HANDS_TIGHT_S = 60;
/** A hot dish ready this long before serve sits and cools: "idle-hot". */
export const IDLE_HOT_S = 5 * 60;

/** Thrown when the recipes or the setup cannot produce a plan. */
export class ScheduleError extends Error {
  /**
   * @param {string} message
   * @param {'cycle' | 'cannot-fit' | 'setup'} kind
   * @param {string[]} [keys]
   */
  constructor(message, kind, keys = []) {
    super(message);
    this.name = "ScheduleError";
    this.kind = kind;
    this.keys = keys;
  }
}

/**
 * @typedef {{
 *   burner: number, wok: number, pan: number, pot: number, oven: number,
 *   wokFallbackPan?: boolean,
 * }} Capacity
 */

/**
 * @typedef {{ key: string, recipeId: string, step: Step, lane: string, dishOrder: number,
 *   off: number, dur: number, hands: 'active' | 'passive', needs: Partial<Record<Equipment, number>> }} Member
 * @typedef {{ id: number, members: Member[], len: number, preds: { member: Member, pred: string }[] }} Unit
 * @typedef {{ start: number, end: number, member: Member }} Placed
 */

/**
 * A step's equipment needs under the setup (no wok + "use a pan for wok steps": wok needs a pan).
 * @param {Step} s
 * @param {Capacity} cap
 * @returns {Partial<Record<Equipment, number>>}
 */
export function needsOf(s, cap) {
  /** @type {Partial<Record<Equipment, number>>} */
  const out = {};
  for (const [k, v] of Object.entries(s.needs || {})) {
    if (!v) continue;
    const kind = /** @type {Equipment} */ (k === "wok" && cap.wok < 1 && cap.wokFallbackPan ? "pan" : k);
    out[kind] = (out[kind] || 0) + v;
  }
  return out;
}

/**
 * Equipment the recipes need that the setup does not have (before scheduling), as messages per
 * recipe: "Mie Padje + Priauw Waan Tofu needs a wok".
 * @param {{ recipe: Recipe }[]} picks
 * @param {Capacity} cap
 * @returns {{ recipeId: string, kind: Equipment, need: number, have: number }[]}
 */
export function missingEquipment(picks, cap) {
  const out = [];
  for (const { recipe } of picks) {
    /** @type {Partial<Record<Equipment, number>>} */
    const max = {};
    for (const s of recipe.steps) {
      for (const [k, v] of Object.entries(needsOf(s, cap))) {
        const kind = /** @type {Equipment} */ (k);
        max[kind] = Math.max(max[kind] || 0, /** @type {number} */ (v));
      }
    }
    for (const [k, need] of Object.entries(max)) {
      const kind = /** @type {Equipment} */ (k);
      if ((cap[kind] || 0) < /** @type {number} */ (need)) out.push({ recipeId: recipe.id, kind, need: /** @type {number} */ (need), have: cap[kind] || 0 });
    }
  }
  return out;
}

/**
 * Plan the picks for a setup.
 * @param {{ recipe: Recipe }[]} picks adapted recipes, in pick order (1 or 2)
 * @param {Capacity} cap
 * @returns {{ totalMs: number, steps: import('../types').PlannedStep[], warnings: import('../types').PlanWarning[] }}
 */
export function schedule(picks, cap) {
  const miss = missingEquipment(picks, cap);
  if (miss.length) throw new ScheduleError(`setup lacks ${miss.map(m => m.kind).join(", ")}`, "setup", miss.map(m => m.recipeId));

  // ---- flatten: keys "recipeId/stepId"
  /** @type {Map<string, Member>} */
  const members = new Map();
  /** @type {Map<string, string[]>} key -> predecessor keys */
  const after = new Map();
  /** @type {Map<string, boolean>} */
  const hotByLane = new Map();
  let dishOrder = 0;
  for (const { recipe } of picks) {
    /** @type {Map<string, number>} */
    const order = new Map();
    for (const d of recipe.dishes) { order.set(d.id, dishOrder++); hotByLane.set(recipe.id + "/" + d.id, d.hot); }
    const sharedOrder = dishOrder++;
    for (const s of recipe.steps) {
      const key = recipe.id + "/" + s.id;
      members.set(key, {
        key, recipeId: recipe.id, step: s, lane: recipe.id + "/" + s.dish,
        dishOrder: order.get(s.dish) ?? sharedOrder,
        off: 0, dur: s.dur, hands: s.hands, needs: needsOf(s, cap),
      });
      after.set(key, s.after.map(id => recipe.id + "/" + id));
    }
  }
  assertDag(after);

  /** @type {Map<string, string[]>} key -> successor keys */
  const succ = new Map([...members.keys()].map(k => [k, /** @type {string[]} */ ([])]));
  for (const [k, ps] of after) for (const p of ps) /** @type {string[]} */ (succ.get(p)).push(k);

  // ---- couple: passive + wait + exactly one successor, which is active
  /** @type {Map<string, Unit>} member key -> its unit */
  const unitOf = new Map();
  /** @type {Unit[]} */
  const units = [];
  const keys = [...members.keys()].sort(byKey);
  for (const k of keys) {
    if (unitOf.has(k)) continue;
    const m = /** @type {Member} */ (members.get(k));
    const next = /** @type {string[]} */ (succ.get(k));
    /** @type {Member[]} */
    let group = [m];
    if (m.hands === "passive" && m.step.wait && next.length === 1) {
      const n = /** @type {Member} */ (members.get(next[0]));
      if (n.hands === "active" && !unitOf.has(n.key)) {
        n.off = m.step.wait.ideal;
        group = [m, n];
      }
    }
    const unit = { id: units.length, members: group, len: Math.max(...group.map(x => x.off + x.dur)), preds: /** @type {Unit['preds']} */ ([]) };
    for (const x of group) unitOf.set(x.key, unit);
    units.push(unit);
  }
  for (const u of units) {
    const own = new Set(u.members.map(x => x.key));
    for (const x of u.members) for (const p of /** @type {string[]} */ (after.get(x.key))) if (!own.has(p)) u.preds.push({ member: x, pred: p });
  }
  /** @param {Unit} u */
  const succUnits = u => {
    /** @type {Set<Unit>} */
    const out = new Set();
    for (const x of u.members) for (const s of /** @type {string[]} */ (succ.get(x.key))) {
      const su = /** @type {Unit} */ (unitOf.get(s));
      if (su !== u) out.add(su);
    }
    return out;
  };

  // ---- mise en place: prep is placed after everything else, so it never pushes hot steps apart.
  // A unit is prep when it is one active step, everything before it is prep too, and it does not
  // start a chain on its own equipment ("heat oil in the wok" is followed by wok steps: not prep;
  // cutting, mixing a sauce, or simmering a substitute that a sauce step uses: prep). The set is
  // closed under predecessors, so holding it back never blocks another unit.
  /** @type {Map<string, boolean>} */
  const prepMemo = new Map();
  /**
   * @param {string} k
   * @returns {boolean}
   */
  const isPrep = k => {
    const known = prepMemo.get(k);
    if (known !== undefined) return known;
    const m = /** @type {Member} */ (members.get(k));
    const kinds = Object.keys(m.needs);
    const v = m.hands === "active"
      && (/** @type {Unit} */ (unitOf.get(k))).members.length === 1
      && /** @type {string[]} */ (after.get(k)).every(isPrep)
      && !/** @type {string[]} */ (succ.get(k)).some(n => kinds.some(kind => (/** @type {Member} */ (members.get(n))).needs[/** @type {Equipment} */ (kind)]));
    prepMemo.set(k, v);
    return v;
  };
  const prepUnit = /** @param {Unit} u */ u => (isPrep(u.members[0].key) ? 1 : 0);

  // Longest chain behind a unit (its predecessors' work), for the tie-break.
  /** @type {Map<Unit, number>} */
  const chain = new Map();
  /**
   * @param {Unit} u
   * @returns {number}
   */
  const chainOf = u => {
    const c = chain.get(u);
    if (c !== undefined) return c;
    let best = 0;
    for (const { pred } of u.preds) best = Math.max(best, chainOf(/** @type {Unit} */ (unitOf.get(pred))));
    const v = best + u.len;
    chain.set(u, v);
    return v;
  };

  // ---- place, backwards
  /** @type {Map<Unit, number>} latest allowed end */
  const bound = new Map();
  /** @type {Map<Unit, number>} chosen end */
  const placedEnd = new Map();
  /** @type {Placed[]} */
  const placed = [];
  /** @type {Set<Unit>} */
  const ready = new Set(units.filter(u => succUnits(u).size === 0));
  for (const u of ready) bound.set(u, 0);
  const minOrder = /** @param {Unit} u */ u => Math.min(...u.members.map(x => x.dishOrder));
  const firstKey = /** @param {Unit} u */ u => u.members.map(x => x.key).sort(byKey)[0];

  while (ready.size) {
    const u = /** @type {Unit} */ ([...ready].sort((a, b) =>
      (prepUnit(a) - prepUnit(b))
      || (/** @type {number} */ (bound.get(b)) - /** @type {number} */ (bound.get(a)))
      || (chainOf(b) - chainOf(a))
      || (minOrder(a) - minOrder(b))
      || byKey(firstKey(a), firstKey(b)))[0]);
    ready.delete(u);
    let end = /** @type {number} */ (bound.get(u));
    for (;;) {
      const shift = conflictShift(u, end, placed, cap);
      if (shift === 0) break;
      end -= shift;
      if (end - u.len < -MAX_SPAN_S) {
        throw new ScheduleError(`cannot fit ${u.members.map(x => x.key).join(" + ")} within 6 hours`, "cannot-fit", u.members.map(x => x.key));
      }
    }
    placedEnd.set(u, end);
    const start = end - u.len;
    for (const x of u.members) placed.push({ start: start + x.off, end: start + x.off + x.dur, member: x });
    for (const { member, pred } of u.preds) {
      const pu = /** @type {Unit} */ (unitOf.get(pred));
      const pm = /** @type {Member} */ (members.get(pred));
      // pred member must end by the time this member starts.
      const limit = start + member.off - (pm.off + pm.dur) + pu.len;
      bound.set(pu, Math.min(bound.get(pu) ?? 0, limit));
    }
    for (const { pred } of u.preds) {
      const pu = /** @type {Unit} */ (unitOf.get(pred));
      if (placedEnd.has(pu) || ready.has(pu)) continue;
      if ([...succUnits(pu)].every(s => placedEnd.has(s))) ready.add(pu);
    }
  }
  if (placedEnd.size !== units.length) throw new ScheduleError("not every step could be placed", "cycle");

  // ---- shift so the plan starts at 0
  const t0 = Math.min(...placed.map(p => p.start));
  const total = Math.max(...placed.map(p => p.end)) - t0;
  const steps = placed
    .map(p => ({
      key: p.member.key, start: (p.start - t0) * 1000, end: (p.end - t0) * 1000,
      lane: p.member.lane, hands: p.member.hands, coupled: (/** @type {Unit} */ (unitOf.get(p.member.key))).members.length > 1,
    }))
    .sort((a, b) => a.start - b.start || a.end - b.end || byKey(a.key, b.key));
  return { totalMs: total * 1000, steps, warnings: warningsOf(steps, total * 1000, hotByLane) };
}

/**
 * How far a unit ending at `end` must slide earlier to clear its first conflict (0: it fits).
 * The conflicting sub-interval then ends where the nearest blocker starts.
 * @param {Unit} u
 * @param {number} end
 * @param {Placed[]} placed
 * @param {Capacity} cap
 */
function conflictShift(u, end, placed, cap) {
  const start = end - u.len;
  let shift = 0;
  for (const m of u.members) {
    const s = start + m.off, e = s + m.dur;
    /** @param {Placed} p */
    const overlaps = p => p.start < e && p.end > s;
    if (m.hands === "active") {
      for (const p of placed) {
        if (p.member.hands === "active" && overlaps(p)) shift = minPositive(shift, e - p.start);
      }
    }
    for (const [k, n] of Object.entries(m.needs)) {
      const kind = /** @type {Equipment} */ (k);
      const holders = placed.filter(p => overlaps(p) && (p.member.needs[kind] || 0) > 0);
      if (!holders.length) continue;
      if (peak(holders, kind, s, e) + /** @type {number} */ (n) > (cap[kind] || 0)) {
        for (const p of holders) shift = minPositive(shift, e - p.start);
      }
    }
  }
  return shift;
}

/**
 * Highest number of `kind` held at once by `holders` within [s, e).
 * @param {Placed[]} holders
 * @param {Equipment} kind
 * @param {number} s
 * @param {number} e
 */
function peak(holders, kind, s, e) {
  /** @type {[number, number][]} */
  const ev = [];
  for (const p of holders) {
    const n = p.member.needs[kind] || 0;
    ev.push([Math.max(s, p.start), n], [Math.min(e, p.end), -n]);
  }
  ev.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let cur = 0, max = 0;
  for (const [, d] of ev) { cur += d; max = Math.max(max, cur); }
  return max;
}

/**
 * @param {number} a current best (0: none yet)
 * @param {number} b candidate
 */
const minPositive = (a, b) => (b > 0 && (a === 0 || b < a) ? b : a);

/**
 * Stable order of step keys: recipe id, then step id by number ("2.10" after "2.9").
 * @param {string} a
 * @param {string} b
 */
export function byKey(a, b) {
  const [ra, sa] = a.split("/"), [rb, sb] = b.split("/");
  if (ra !== rb) return ra < rb ? -1 : 1;
  const na = sa.split(".").map(Number), nb = sb.split(".").map(Number);
  for (let i = 0; i < Math.max(na.length, nb.length); i++) {
    const x = na[i], y = nb[i];
    if (Number.isNaN(x) || Number.isNaN(y)) return sa < sb ? -1 : sa > sb ? 1 : 0;
    if (x !== y) return (x ?? -1) - (y ?? -1);
  }
  return 0;
}

/**
 * Kahn's algorithm; a cycle throws naming its steps.
 * @param {Map<string, string[]>} after
 */
export function assertDag(after) {
  const indeg = new Map([...after.keys()].map(k => [k, 0]));
  /** @type {Map<string, string[]>} */
  const out = new Map([...after.keys()].map(k => [k, /** @type {string[]} */ ([])]));
  for (const [k, ps] of after) {
    for (const p of ps) {
      if (!after.has(p)) throw new ScheduleError(`${k} waits for unknown step ${p}`, "cycle", [k]);
      indeg.set(k, /** @type {number} */ (indeg.get(k)) + 1);
      /** @type {string[]} */ (out.get(p)).push(k);
    }
  }
  const queue = [...indeg].filter(([, d]) => d === 0).map(([k]) => k);
  let seen = 0;
  while (queue.length) {
    const k = /** @type {string} */ (queue.shift());
    seen++;
    for (const n of /** @type {string[]} */ (out.get(k))) {
      const d = /** @type {number} */ (indeg.get(n)) - 1;
      indeg.set(n, d);
      if (d === 0) queue.push(n);
    }
  }
  if (seen !== after.size) {
    const left = [...indeg].filter(([, d]) => d > 0).map(([k]) => k).sort(byKey);
    throw new ScheduleError(`steps form a cycle: ${left.join(", ")}`, "cycle", left);
  }
}

/**
 * Warnings for a placed plan (times in ms from plan start; serve = totalMs).
 * @param {import('../types').PlannedStep[]} steps sorted by start
 * @param {number} totalMs
 * @param {Map<string, boolean>} hotByLane
 * @returns {import('../types').PlanWarning[]}
 */
function warningsOf(steps, totalMs, hotByLane) {
  /** @type {import('../types').PlanWarning[]} */
  const out = [];
  const dishOf = /** @param {import('../types').PlannedStep} p */ p => p.lane;
  // "Both need your hands": the cook switches dishes with under a minute to spare next to a step
  // that cannot wait: the active end of a wait (the drain) or a dish's last step before serving.
  // Back-to-back switches form one marker (the busy finish is one warning, not ten).
  const lastOfLane = new Map();
  for (const p of steps) if (p.end > (lastOfLane.get(p.lane)?.end ?? -1)) lastOfLane.set(p.lane, p);
  const critical = /** @param {import('../types').PlannedStep} p */ p => p.coupled || lastOfLane.get(p.lane) === p;
  const active = steps.filter(p => p.hands === "active").sort((a, b) => a.start - b.start);
  /** @type {import('../types').PlanWarning | null} */
  let open = null;
  for (let i = 1; i < active.length; i++) {
    const a = active[i - 1], b = active[i];
    const switches = dishOf(a) !== dishOf(b) && !dishOf(a).endsWith("/shared") && !dishOf(b).endsWith("/shared");
    if (switches && b.start - a.end < HANDS_TIGHT_S * 1000 && (critical(a) || critical(b))) {
      if (open && open.keys[open.keys.length - 1] === a.key) open.keys.push(b.key);
      else { open = { kind: "hands-tight", at: a.end, keys: [a.key, b.key], msg: "Both need your hands" }; out.push(open); }
    }
  }
  /** @type {Map<string, number>} */
  const lastEnd = new Map();
  for (const p of steps) lastEnd.set(p.lane, Math.max(lastEnd.get(p.lane) ?? 0, p.end));
  for (const [lane, end] of lastEnd) {
    if (hotByLane.get(lane) && totalMs - end > IDLE_HOT_S * 1000) {
      out.push({ kind: "idle-hot", at: end, keys: steps.filter(p => p.lane === lane && p.end === end).map(p => p.key), msg: "Ready early: keep it warm" });
    }
  }
  return out;
}
