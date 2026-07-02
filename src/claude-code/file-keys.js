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
  const lower = normalizePathForCompare(p);
  const base = path.basename(lower);
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

/**
 * Collapse the dual {fullPath, basename} entries stored by addNormalized into
 * one representative path per file for summaries, checkpoints, and audit-diff.
 * Prefers the longest path in each basename group (typically the full path).
 *
 * @param {Iterable<string>|null|undefined} editedFiles
 * @returns {string[]}
 */
function uniqueEditedPaths(editedFiles) {
  if (!editedFiles) {
    return [];
  }
  const byBase = new Map();
  for (const entry of editedFiles instanceof Set ? editedFiles : editedFiles) {
    if (!entry) {
      continue;
    }
    const raw = String(entry);
    const base = path.basename(raw.replace(/\\/g, '/')).toLowerCase();
    const prev = byBase.get(base);
    if (!prev || raw.length > prev.length) {
      byBase.set(base, raw);
    }
  }
  return [...byBase.values()];
}

module.exports = { fileKey, addNormalized, uniqueEditedPaths, normalizePathForCompare };
