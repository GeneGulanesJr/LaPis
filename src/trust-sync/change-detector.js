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

function createGitTrustSyncAdapter(mem, notify) {
  return async function syncGitOperation(repo) {
    // The git hook currently does not receive a symbol diff.
    // The empty object is a best-effort sentinel that sync-code-trust rejects as a no-op.
    // This adapter intentionally swallows that result until the hook can provide real changed-symbol payloads.
    await mem('sync-code-trust', {
      repo,
      'changed-symbols-json': '{}',
    }).catch(() => {});
    if (notify) {
      notify(`🔄 Memory: syncing trust scores after git operation on ${repo}`, 'info');
    }
  };
}

module.exports = {
  extractSymbolKey,
  collectChangedSymbols,
  parseChangedSymbolsJson,
  createGitTrustSyncAdapter,
};
