'use strict';

/**
 * Claude Code bridge: shared file-path normalization for per-session state.
 *
 * exploredFiles stores lowercased full path + basename for the read-guardrail
 * lookup (#230). editedFiles stores original-case paths (deduped by normalized
 * path) because audit-diff and summaries need the real path.
 */

const path = require('node:path');

/**
 * Lowercase and normalize separators for stable path comparison (#230).
 *
 * @param {string} p
 * @returns {string}
 */
function normalizePathForCompare(p) {
  if (typeof p !== 'string' || !p) {
    return '';
  }
  return p.toLowerCase().replace(/\\/g, '/');
}

/**
 * Lowercase a path and split off its basename, tolerating both POSIX and
 * Windows separators. Returns null for non-string / empty input.
 *
 * @param {string} p
 * @returns {{ lower: string, base: string } | null}
 */
function fileKey(p) {
  if (typeof p !== 'string' || !p) {
    return null;
  }
  const lower = normalizePathForCompare(p),
    base = path.basename(lower);
  if (!base) {
    return null;
  }
  return { lower, base };
}

/**
 * Append the canonical {lower, base} forms of a path onto an array, deduped.
 * Used by addExploredFile/addExploredPath (PreToolUse/PostToolUse) so the
 * read-guardrail can look files up by full path or basename.
 *
 * @param {string[]} arr
 * @param {string} p
 */
function addNormalized(arr, p) {
  const key = fileKey(p);
  if (!key) {
    return;
  }
  for (const candidate of [key.lower, key.base]) {
    if (candidate && !arr.includes(candidate)) {
      arr.push(candidate);
    }
  }
}

/**
 * Dedupe edited paths by full normalized path, keeping each file's first-seen
 * original-case spelling. Audit-diff matches file_path case-sensitively, and
 * same-named files in different folders (src/a/index.js, src/b/index.js) must
 * stay separate in summaries and checkpoints.
 *
 * @param {Iterable<string>|null|undefined} editedFiles
 * @returns {string[]}
 */
function uniqueEditedPaths(editedFiles) {
  if (!editedFiles) {
    return [];
  }
  const byKey = new Map();
  for (const entry of editedFiles) {
    const key = normalizePathForCompare(entry);
    if (key && !byKey.has(key)) {
      byKey.set(key, entry);
    }
  }
  return [...byKey.values()];
}

module.exports = { fileKey, addNormalized, uniqueEditedPaths, normalizePathForCompare };
