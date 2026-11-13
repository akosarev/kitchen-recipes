// HTML escaping. Escapes & < > " ' so values are safe in text and in quoted attributes.
// Recipes come from a public repo (and later from imports), so every interpolated value goes through esc().

/**
 * @param {string | number} s
 * @returns {string}
 */
export const esc = s => String(s).replace(/[&<>"']/g, c => (/** @type {Record<string, string>} */ ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }))[c]);
