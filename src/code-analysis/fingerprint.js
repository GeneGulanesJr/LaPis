'use strict';

const { DUPLICATE_DETECTION: CFG } = require('../../constants');

// Deterministic hash function (cyrb53) — fast, no crypto dependency
function _hash(str, seed = 0) {
  let h1 = 0xdeadbeef ^ seed,
    h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

/**
 * Normalize a function/method body for structural comparison.
 * Strips comments, normalizes strings/numbers, collapses whitespace.
 */
function normalizeBody(body) {
  if (!body || typeof body !== 'string') {
    return '';
  }
  let s = body;
  // Remove block comments
  s = s.replace(/\/\*[\s\S]*?\*\//g, ' ');
  // Remove line comments
  s = s.replace(/\/\/.*$/gm, ' ');
  // Normalize string literals (single, double, template)
  s = s.replace(/'(?:[^'\\]|\\.)*'/g, '__STR__');
  s = s.replace(/"(?:[^"\\]|\\.)*"/g, '__STR__');
  s = s.replace(/`(?:[^`\\]|\\.)*`/g, '__STR__');
  // Normalize numeric literals
  s = s.replace(/\b\d+(?:\.\d+)?\b/g, '__NUM__');
  // Collapse whitespace
  s = s.replace(/\s+/g, ' ').trim();
  return s;
}

/**
 * Split normalized body into meaningful tokens.
 */
function tokenize(normalized) {
  if (!normalized) {
    return [];
  }
  return normalized.split(/\s+/).filter((t) => t.length > 0);
}

/**
 * Create overlapping shingles from a token array.
 */
function shingle(tokens, size = CFG.SHINGLE_SIZE) {
  if (tokens.length < size) {
    return [];
  }
  const result = [];
  for (let i = 0; i <= tokens.length - size; i++) {
    result.push(tokens.slice(i, i + size).join(' '));
  }
  return result;
}

/**
 * Compute MinHash signature for a set of shingles.
 * Returns an array of `numPermutations` hash values.
 */
function minhashSignature(shingles, numPermutations = CFG.MINHASH_PERMUTATIONS) {
  if (shingles.length === 0) {
    return new Array(numPermutations).fill(Infinity);
  }
  const signature = new Array(numPermutations);
  for (let i = 0; i < numPermutations; i++) {
    let minHash = Infinity;
    for (const sh of shingles) {
      const h = _hash(sh, i);
      if (h < minHash) {
        minHash = h;
      }
    }
    signature[i] = minHash;
  }
  return signature;
}

/**
 * Estimate Jaccard similarity between two MinHash signatures.
 */
function jaccardSimilarity(sig1, sig2) {
  if (sig1.length !== sig2.length) {
    return 0;
  }
  let matches = 0;
  for (let i = 0; i < sig1.length; i++) {
    if (sig1[i] === sig2[i]) {
      matches++;
    }
  }
  return matches / sig1.length;
}

/**
 * Band a MinHash signature for Locality-Sensitive Hashing (LSH).
 * Splits the signature into contiguous bands of `rowsPerBand` values and
 * returns one string key per band. Signatures that share any band key are
 * LSH candidates (likely similar); exact similarity is verified separately.
 *
 * With rowsPerBand=4 and 128 permutations this yields 32 bands. The number of
 * bands adapts to the actual signature length (e.g. 16 bands for 64 perms). A
 * trailing partial band (when the signature length is not evenly divisible by
 * rowsPerBand) is still emitted so no elements are dropped and recall is not
 * silently degraded; the shorter last band only slightly lowers its own
 * selectivity, and exact Jaccard re-verifies every candidate anyway.
 *
 * @param {number[]} signature — MinHash signature
 * @param {number} rowsPerBand — values grouped into one band key
 * @returns {string[]} band keys (empty if signature too short)
 */
function lshBands(signature, rowsPerBand = CFG.LSH_ROWS_PER_BAND) {
  const len = signature.length,
    r = rowsPerBand > 0 ? rowsPerBand : CFG.LSH_ROWS_PER_BAND,
    numBands = !(len < r) ? Math.ceil(len / r) : undefined,
    keys = !(len < r) ? new Array(numBands) : undefined;
  if (len < r) {
    return [];
  }
  // Math.ceil so a non-divisible signature length keeps its trailing band
  // Instead of silently discarding the remainder (which would reduce recall).
  for (let b = 0; b < numBands; b++) {
    const start = b * r;
    keys[b] = `${b}:${signature.slice(start, start + r).join('|')}`;
  }
  return keys;
}

/**
 * Fingerprint a code symbol for duplicate detection.
 * Returns null if the body is too short to be meaningful.
 */
function fingerprintSymbol(symbol) {
  const body = symbol.body_preview || '',
    normalized = normalizeBody(body),
    tokens = tokenize(normalized),
    shingles = !(tokens.length < 5) ? shingle(tokens) : undefined,
    signature = !(tokens.length < 5) && !(shingles.length === 0) ? minhashSignature(shingles) : undefined;
  if (tokens.length < 5) {
    return null;
  }

  if (shingles.length === 0) {
    return null;
  }

  return {
    symbolName: symbol.name,
    filePath: symbol.file_path,
    kind: symbol.kind,
    startLine: symbol.start_line || 0,
    signature,
    tokenCount: tokens.length,
    shingleCount: shingles.length,
  };
}

module.exports = {
  normalizeBody,
  tokenize,
  shingle,
  minhashSignature,
  jaccardSimilarity,
  lshBands,
  fingerprintSymbol,
  _hash,
};
