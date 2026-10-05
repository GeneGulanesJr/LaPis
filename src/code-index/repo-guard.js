// src/code-index/repo-guard.js
// Guard rail against registering/indexing non-codebase directories.
//
// Incident (2026-10-05): broken project attribution registered the HOME
// Directory ('genejrgulanes' → /Users/genejrgulanes, 5,376 files) and
// '~/Documents' as code repos. A home-dir index can never go fresh (home dirs
// Change constantly), so the stale-check → reindex loop ran forever, pegging a
// Core at 98% CPU and hammering the production DB until test children hit
// ExecFileSync ETIMEDOUT.
//
// Rules:
//   1. NEVER indexable, no opt-out: the home directory itself, standard user
//      Content dirs (Documents/Downloads/Desktop/…), and filesystem root.
//   2. Indexable fast-path: the path contains .git (dir, or file for
//      Worktrees/submodules).
//   3. Anything else requires an explicit opt-out: LAPIS_INDEX_ALLOW_NON_GIT=1
//      (used by the test suite, which indexes throwaway fixture dirs).

const fs = require('fs'),
  os = require('os'),
  path = require('path');

const USER_CONTENT_DIRS = new Set([
  'Desktop',
  'Documents',
  'Downloads',
  'Pictures',
  'Music',
  'Movies',
  'Public',
  'Library',
]);

function isIndexableRepoPath(repoPath) {
  const result = { ok: true, reason: null };
  if (!repoPath || !String(repoPath).trim()) {
    return { ok: false, reason: 'empty path' };
  }
  let resolved;
  try {
    resolved = path.resolve(String(repoPath));
  } catch {
    return { ok: false, reason: 'unresolvable path' };
  }
  if (!resolved || resolved === path.parse(resolved).root) {
    return { ok: false, reason: 'filesystem root is not a codebase' };
  }

  const home = os.homedir();
  if (resolved === home) {
    return { ok: false, reason: 'home directory is not a codebase' };
  }
  const base = path.basename(resolved);
  if (path.dirname(resolved) === home && USER_CONTENT_DIRS.has(base)) {
    return { ok: false, reason: `user content directory (~/${base}) is not a codebase` };
  }

  try {
    if (fs.existsSync(path.join(resolved, '.git'))) {
      return result; // Git root (or worktree/submodule) — fast-path allow
    }
  } catch {
    // Unreadable path — fall through to the non-git decision
  }

  if (process.env.LAPIS_INDEX_ALLOW_NON_GIT === '1') {
    return result;
  }
  return {
    ok: false,
    reason: `no .git at ${resolved} — not a codebase root (set LAPIS_INDEX_ALLOW_NON_GIT=1 to override)`,
  };
}

function assertIndexableRepoPath(repoPath) {
  const check = isIndexableRepoPath(repoPath);
  if (!check.ok) {
    const err = new Error(`repo guard: ${check.reason}`);
    err.code = 'EREPOGUARD';
    throw err;
  }
  return check;
}

module.exports = { isIndexableRepoPath, assertIndexableRepoPath, USER_CONTENT_DIRS };
