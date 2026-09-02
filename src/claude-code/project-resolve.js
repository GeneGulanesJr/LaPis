'use strict';

/**
 * Claude Code bridge: shared cwd → project resolution for hook handlers.
 *
 * Centralizes loading indexed repos + known memory projects and calling
 * hooks-engine resolveProjectKey so every handler shares the same fallback
 * chain (path prefix → knownProjects up-tree → basename).
 */

const path = require('node:path');
const { resolveCwd, resolveProjectKey } = require('../hooks-engine/project');

function loadReposAndProjects(getKnownRepos, getKnownProjects) {
  return {
    repos: (typeof getKnownRepos === 'function' ? getKnownRepos() : []) || [],
    knownProjects: (typeof getKnownProjects === 'function' ? getKnownProjects() : []) || [],
  };
}

/**
 * @returns {{ resolvedCwd: string, repos: object[], knownProjects: string[], project: string }}
 */
function resolveProjectForCwd(cwdHint, getKnownRepos, getKnownProjects) {
  const resolvedCwd = path.resolve(resolveCwd(cwdHint)),
    { repos, knownProjects } = loadReposAndProjects(getKnownRepos, getKnownProjects);
  return {
    resolvedCwd,
    repos,
    knownProjects,
    project: resolveProjectKey(resolvedCwd, repos, knownProjects),
  };
}

module.exports = { loadReposAndProjects, resolveProjectForCwd };
