'use strict';

/**
 * Claude Code bridge: shared file-path normalization for per-session state.
 *
 * editedFiles and exploredFiles previously normalized inconsistently
 * (exploredFiles: lowercased + basename; editedFiles: raw). Centralizing the
 * scheme here makes the two arrays comparable and keeps the read-guardrail's
 * lookup shape stable (#230).
 */

const path = require('node:path');

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
  const lower = p.toLowerCase();
  const base = path.basename(lower.replace(/\\/g, '/'));
  if (!base) {
    return null;
  }
  return { lower, base };
}

/**
 * Append the canonical {lower, base} forms of a path onto an array, deduped.
 * Used by both addEditedFile (PostToolUse) and addExploredFile/addExploredPath
 * (PreToolUse/PostToolUse) so the two trackers share one normalization scheme.
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

module.exports = { fileKey, addNormalized };
