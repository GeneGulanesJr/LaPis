'use strict';

/**
 * Shared sync reads for project-detection (indexed code repos + memory projects).
 *
 * Used by the Claude Code bridge, MCP server, and dispatch-client so transport
 * layers do not depend on each other for DB access. In-process TTL cache mirrors
 * Pi's REPO_CACHE_TTL (5 min) to avoid duplicate queries within one hook/MCP
 * process lifetime.
 */

const CACHE_TTL_MS = 5 * 60 * 1000;

let _reposCache = null,
  _reposCacheTime = 0,
  _projectsCache = null,
  _projectsCacheTime = 0;

function clearProjectDbCache() {
  _reposCache = null;
  _reposCacheTime = 0;
  _projectsCache = null;
  _projectsCacheTime = 0;
}

function loadKnownRepos() {
  const { sqlJson } = require('../../db');
  return sqlJson('SELECT name, path, indexed_at FROM code_repos') || [];
}

function loadKnownProjects() {
  const { sqlJson } = require('../../db'),
    rows =
      sqlJson(`
      SELECT project
      FROM observations
      WHERE deleted_at IS NULL AND type != 'skill'
        AND project IS NOT NULL AND project != ''
      GROUP BY project
    `) || [];
  return rows.map((r) => r.project).filter(Boolean);
}

/**
 * Known indexed code repos. Best-effort; returns [] when the DB is unavailable.
 */
function getKnownRepos() {
  const now = Date.now();
  if (_reposCache && now - _reposCacheTime < CACHE_TTL_MS) {
    return _reposCache;
  }
  try {
    _reposCache = loadKnownRepos();
    _reposCacheTime = now;
    return _reposCache;
  } catch {
    return _reposCache || [];
  }
}

/**
 * Known memory project names (list-projects parity). Best-effort.
 */
function getKnownProjects() {
  const now = Date.now();
  if (_projectsCache && now - _projectsCacheTime < CACHE_TTL_MS) {
    return _projectsCache;
  }
  try {
    _projectsCache = loadKnownProjects();
    _projectsCacheTime = now;
    return _projectsCache;
  } catch {
    return _projectsCache || [];
  }
}

module.exports = {
  getKnownRepos,
  getKnownProjects,
  clearProjectDbCache,
  CACHE_TTL_MS,
};
