// src/judgment/internal.js
// Shared kernel for the judgment layer (spec §12). Exists from day one to
// prevent the cross-file duplication the RetellMCP review found (memory #26800 P3).

// ONE confidence floor for the whole layer. Do not redefine this elsewhere.
const CONFIDENT_THRESHOLD = 0.6;

/** Coerce to a finite float in [0,1]; null when not numeric. (Contract rule R2.) */
function normalizeScore(x) {
  if (typeof x !== 'number') return null; // strings/null/undefined are not numeric (test contract)
  const n = Number(x);
  if (!Number.isFinite(n)) return null;
  return Math.min(1, Math.max(0, n));
}

/** Ordered banding, inclusive lower bounds. thresholds: {high, medium} upper bounds. */
function band(p, thresholds) {
  if (p >= thresholds.high) return 'high';
  if (p >= thresholds.medium) return 'medium';
  return 'low';
}

/** Truncate text to n chars with a single-char ellipsis marker. */
function capText(s, n) {
  if (typeof s !== 'string' || s.length <= n) return s;
  return s.slice(0, n) + '…';
}

/** Split arr into n-sized chunks. Throws on n < 1 (RetellMCP P2: chunk 0 looped forever). */
function chunk(arr, n) {
  if (!Number.isInteger(n) || n < 1) throw new Error(`chunk size must be a positive integer, got ${n}`);
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

module.exports = { normalizeScore, band, capText, chunk, CONFIDENT_THRESHOLD };
