// Fraction formatter, moved from legacy/index.html ("amounts" block). Behaviour is unchanged;
// tests/unit/parity.test.js compares it against the legacy function on a dense input grid.

/** @type {ReadonlyArray<readonly [number, string]>} */
export const FR = [[0, ""], [0.25, "¼"], [0.33, "⅓"], [0.5, "½"], [0.67, "⅔"], [0.75, "¾"], [1, ""]];

/**
 * Format a non-negative number as a whole number plus the nearest kitchen fraction.
 * @param {number} x
 * @returns {string}
 */
export function frac(x) {
  let w = Math.floor(x), r = x - w, best = FR[0], bd = 9;
  for (const f of FR) { const d = Math.abs(r - f[0]); if (d < bd) { bd = d; best = f; } }
  if (best[0] === 1) { w += 1; best = FR[0]; }
  if (w === 0 && best[1] === "") return x > 0 ? "¼" : "0";
  return (w ? String(w) : "") + best[1];
}
