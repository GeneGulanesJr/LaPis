'use strict';

/**
 * Hooks-engine: project
 *
 * Shared, pure project-detection helpers. Promotes the basename heuristic from
 * src/mcp/server.js:35-38 and the up-tree walks in
 * extensions/memory-layer/host/project-detector.ts and tool-guardrails.ts.
 *
 * IMPORTANT: prefers process.env.CLAUDE_PROJECT_DIR over cwd/basename so the
 * Claude Code bridge and MCP agree on the project key.
 */

const path = require('node:path');

/**
 * Resolve the effective working directory. Claude Code sets
 * CLAUDE_PROJECT_DIR; Pi/MCP default to process.cwd().
 */
function resolveCwd(hint) {
  if (process.env.CLAUDE_PROJECT_DIR) {
    return process.env.CLAUDE_PROJECT_DIR;
  }
  if (hint) {
    return hint;
  }
  return process.cwd();
}

/**
 * Derive a project name from a directory (basename, lowercased).
 * Verbatim port of src/mcp/server.js projectFromCwd.
 */
function projectFromCwd(cwd) {
  const base = path.basename(path.resolve(cwd || process.cwd()));
  return base ? base.toLowerCase() : 'unknown';
}

/**
 * Normalize a path for cross-platform repo matching: resolve to absolute,
 * lowercase, and convert backslashes to forward slashes.
 * @param {string} p
 * @returns {string}
 */
function normalizeRepoPath(p) {
  return path.resolve(p).toLowerCase().replace(/\\/g, '/');
}

/**
 * Find the repo whose path matches resolvedCwd (prefix or exact, case-insensitive).
 * Mirrors the matching in tool-guardrails.ts:204-208.
 *
 * @param {string} resolvedCwd
 * @param {Array<{path:string}>} repos
 * @returns {object|null}
 */
function findMatchingRepo(resolvedCwd, repos) {
  // Normalize separators so a Windows cwd matches a DB path stored with `/`
  // (or vice versa). Prefix match always uses `/` after normalization (#227).
  // When several indexed repos match (nested paths), prefer the deepest/longest
  // Path — mirrors detectProject()'s depth tie-break in project-detector.ts.
  const abs = normalizeRepoPath(resolvedCwd);
  let best = null,
    bestLen = -1;
  for (const r of repos) {
    if (!r?.path) {
      continue;
    }
    const rp = normalizeRepoPath(r.path);
    if (abs !== rp && !abs.startsWith(`${rp}/`)) {
      continue;
    }
    if (rp.length > bestLen) {
      best = r;
      bestLen = rp.length;
    }
  }
  return best;
}

/**
 * Find a known project whose basename matches a directory in the resolvedCwd's
 * up-tree. Mirrors the up-tree walk in project-detector.ts:133-142.
 *
 * @param {string} resolvedCwd
 * @param {string[]} knownProjects
 * @returns {string|null}
 */
function findMatchingProject(resolvedCwd, knownProjects) {
  let dir = path.resolve(resolvedCwd);
  const root = path.parse(dir).root;
  while (dir !== root && dir !== path.dirname(dir)) {
    const name = path.basename(dir),
      match = knownProjects.find((p) => p && p.toLowerCase() === name.toLowerCase());
    if (match) {
      return match;
    }
    dir = path.dirname(dir);
  }
  return null;
}

/**
 * Resolve the indexed code repo for a cwd. Path-prefix match wins (monorepo
 * subdirs whose basename differs from the repo name); then name match on the
 * stored project hint.
 *
 * @param {string} resolvedCwd
 * @param {Array<{name:string,path:string}>} repos
 * @param {string|null|undefined} [currentProject]
 * @returns {object|null}
 */
function resolveIndexedRepo(resolvedCwd, repos, currentProject) {
  const byPath = findMatchingRepo(resolvedCwd, repos);
  if (byPath) {
    return byPath;
  }
  if (currentProject) {
    const key = String(currentProject).toLowerCase();
    return repos.find((r) => r.name && r.name.toLowerCase() === key) || null;
  }
  return null;
}

/**
 * Best-effort memory project key: indexed repo name when cwd is inside one,
 * else a known project basename from the up-tree walk, else cwd basename.
 * Mirrors the fallback chain in detectProject() without async DB calls.
 *
 * @param {string} resolvedCwd
 * @param {Array<{name:string,path:string}>} repos
 * @param {string[]} [knownProjects]
 * @returns {string}
 */
function resolveProjectKey(resolvedCwd, repos, knownProjects) {
  const repo = findMatchingRepo(resolvedCwd, repos);
  if (repo?.name) {
    return repo.name.toLowerCase();
  }
  if (Array.isArray(knownProjects) && knownProjects.length > 0) {
    const fromTree = findMatchingProject(resolvedCwd, knownProjects);
    if (fromTree) {
      return fromTree.toLowerCase();
    }
  }
  return projectFromCwd(resolvedCwd);
}

module.exports = {
  resolveCwd,
  projectFromCwd,
  findMatchingRepo,
  findMatchingProject,
  normalizeRepoPath,
  resolveIndexedRepo,
  resolveProjectKey,
};
