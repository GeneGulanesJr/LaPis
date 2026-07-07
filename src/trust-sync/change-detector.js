const { execFileSync } = require('child_process');

/**
 * Detects changed symbols by comparing stored head_commit against current HEAD.
 * Uses git diff + the built-in code index (zero external dependencies).
 */
function detectChangedSymbols(deps, repoName) {
  const { sqlJson, sqlRun, jsonErrNoExit } = deps;

  // Look up the indexed repo
  const repoRow = sqlJson('SELECT id, path, head_commit FROM code_repos WHERE name = ?', [repoName]);
  if (!repoRow || repoRow.length === 0) {
    return { error: jsonErrNoExit(`Repo not found: ${repoName}. Index it first with index-repo.`) };
  }
  const { id: repoId, path: repoPath, head_commit: storedHead } = repoRow[0];

  // Get current HEAD commit
  let currentHead = null;
  try {
    currentHead = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: repoPath,
      encoding: 'utf-8',
      timeout: 5000,
    }).trim();
  } catch {
    return { error: jsonErrNoExit(`Cannot read HEAD commit from ${repoPath}. Is it a git repo?`) };
  }

  // No stored baseline — establish head_commit without penalizing linked memories.
  if (!storedHead) {
    sqlRun('UPDATE code_repos SET head_commit = ? WHERE id = ?', [currentHead, repoId]);
    return {
      ok: true,
      repo: repoName,
      message: 'Initialized head_commit baseline',
      old_head: null,
      new_head: currentHead,
      changedSet: new Set(),
    };
  }

  // No changes if HEAD hasn't moved
  if (storedHead === currentHead) {
    return {
      ok: true,
      repo: repoName,
      message: 'HEAD unchanged, nothing to sync',
      old_head: storedHead,
      new_head: currentHead,
      changedSet: new Set(),
    };
  }

  // Determine the base commit for diff
  const baseCommit = storedHead;

  // Get changed files via git diff
  let changedFiles = [];
  try {
    const diffRange = `${baseCommit}..HEAD`;
    const output = execFileSync('git', ['diff', '--name-only', diffRange], {
      cwd: repoPath,
      encoding: 'utf-8',
      timeout: 10000,
      maxBuffer: 10 * 1024 * 1024,
    });
    changedFiles = output
      .trim()
      .split('\n')
      .map((f) => f.trim())
      .filter(Boolean);
  } catch {
    return { error: jsonErrNoExit('Failed to run git diff to determine changed files') };
  }

  if (changedFiles.length === 0) {
    // Update head_commit even if no file changes
    sqlRun('UPDATE code_repos SET head_commit = ? WHERE id = ?', [currentHead, repoId]);
    return {
      ok: true,
      repo: repoName,
      message: 'No file changes detected',
      old_head: storedHead,
      new_head: currentHead,
      changedSet: new Set(),
    };
  }

  // Build set of changed symbol names from the code index
  const changedSet = new Set();
  const placeholders = changedFiles.map(() => '?').join(',');
  const changedSymbols = sqlJson(
    `SELECT DISTINCT name, qualified_name FROM code_symbols
     WHERE repo_id = ? AND file_path IN (${placeholders})`,
    [repoId, ...changedFiles],
  );
  for (const sym of changedSymbols) {
    changedSet.add(sym.name);
    if (sym.qualified_name && sym.qualified_name !== sym.name) {
      changedSet.add(sym.qualified_name);
    }
  }

  return {
    ok: true,
    repo: repoName,
    old_head: storedHead,
    new_head: currentHead,
    changed_files: changedFiles.length,
    changed_symbols: changedSet.size,
    changedSet,
  };
}

// --- Legacy functions (kept for backward compat with existing tests) ---

function hasOwn(value, key) {
  return Object.hasOwn(value, key);
}

function extractSymbolKey(value) {
  if (typeof value === 'string') {
    return value;
  }
  if (!value || typeof value !== 'object') {
    return null;
  }
  if (hasOwn(value, 'symbol_id')) {
    return value.symbol_id;
  }
  if (hasOwn(value, 'name')) {
    return value.name;
  }
  return null;
}

function collectSymbolsFromList(changedSet, values) {
  if (!Array.isArray(values)) {
    return;
  }
  for (const value of values) {
    const symbol = extractSymbolKey(value);
    if (symbol !== null && symbol !== undefined && symbol !== '') {
      changedSet.add(String(symbol));
    }
  }
}

function collectChangedSymbols(changedData) {
  const changedSet = new Set();
  if (Array.isArray(changedData)) {
    collectSymbolsFromList(changedSet, changedData);
  } else if (changedData && typeof changedData === 'object') {
    for (const key of ['added', 'modified', 'removed', 'changed']) {
      collectSymbolsFromList(changedSet, changedData[key]);
    }
  }
  return changedSet;
}

/**
 * @deprecated Use detectChangedSymbols() instead. Kept for test compatibility.
 */
function parseChangedSymbolsJson(args, jsonErrNoExit) {
  const repo = args.repo;
  const changedJson = args['changed-symbols-json'] || args['changed-symbols'];
  if (!repo || !changedJson) {
    return { error: jsonErrNoExit('Missing --repo and --changed-symbols-json') };
  }

  let changedData;
  try {
    changedData = JSON.parse(changedJson);
  } catch {
    return { error: jsonErrNoExit('Invalid JSON for --changed-symbols-json') };
  }

  const changedSet = collectChangedSymbols(changedData);
  if (changedSet.size === 0) {
    return { error: jsonErrNoExit('No changed symbols found in input') };
  }

  return { repo, changedSet };
}

/**
 * Creates a git trust sync adapter for the extension hook.
 * Uses the built-in code index for symbol-aware trust updates.
 */
function createGitTrustSyncAdapter(mem, notify) {
  return async function syncGitOperation(repo) {
    try {
      const result = await mem('sync-code-trust', { repo });
      if (result && result.error) {
        // Repo not indexed yet — silently skip
        return;
      }
      if (notify) {
        notify(`Memory: synced trust scores after git operation on ${repo}`, 'info');
      }
    } catch {
      // Non-critical — trust sync failure should not break the session
    }
  };
}

module.exports = {
  detectChangedSymbols,
  extractSymbolKey,
  collectChangedSymbols,
  parseChangedSymbolsJson,
  createGitTrustSyncAdapter,
};
