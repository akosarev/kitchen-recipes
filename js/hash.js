// FNV-1a (32-bit) for plan hashes: synchronous and dependency-free (crypto.subtle is async).

/**
 * FNV-1a hash of a string, as 8 hex digits.
 * @param {string} s
 */
export function fnv1a(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}
