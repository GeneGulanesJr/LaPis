'use strict';

/**
 * hooks-engine: project
 *
 * Shared, pure project-detection helpers. Promotes the basename heuristic from
 * src/mcp/server.js:35-38 and the up-tree walks in
 * extensions/memory-layer/host/project-detector.ts and tool-guardrails.ts.
 *
 * IMPORTANT: prefers process.env.CLAUDE_PROJECT_DIR over cwd/basename so the
 * Claude Code bridge and MCP agree on the project key (resolves the TODO at
 * src/mcp/server.js:30-34). NOT yet wired into mcp/server.js (Phase 2+).
 */

const path = require('node:path');

/**
 * Resolve the effective working directory. Claude Code sets
 * CLAUDE_PROJECT_DIR; Pi/MCP default to process.cwd().
 */
function resolveCwd(hint) {
  if (hint) {
    return hint;
  }
  return process.env.CLAUDE_PROJECT_DIR || process.cwd();
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
 * Find the repo whose path matches resolvedCwd (prefix or exact, case-insensitive).
 * Mirrors the matching in tool-guardrails.ts:204-208.
 *
 * @param {string} resolvedCwd
 * @param {Array<{path:string}>} repos
 * @returns {object|null}
 */
function findMatchingRepo(resolvedCwd, repos) {
  // Use path.sep (not a hardcoded "/") so a Windows cwd nested under an
  // indexed repo still prefix-matches: the DB stores backslash paths there,
  // and the old `${rp}/` check only ever matched on exact equality (#227).
  const abs = path.resolve(resolvedCwd).toLowerCase();
  const sep = path.sep;
  return (
    repos.find((r) => {
      const rp = r.path.toLowerCase();
      return abs === rp || abs.startsWith(rp + sep);
    }) || null
  );
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
    const name = path.basename(dir);
    const match = knownProjects.find((p) => p && p.toLowerCase() === name.toLowerCase());
    if (match) {
      return match;
    }
    dir = path.dirname(dir);
  }
  return null;
}

module.exports = {
  resolveCwd,
  projectFromCwd,
  findMatchingRepo,
  findMatchingProject,
};
