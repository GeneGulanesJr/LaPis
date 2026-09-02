const { TRUST_DELTA } = require('../../constants'),
  { detectChangedSymbols } = require('./change-detector'),
  { evaluateTrustSync, stripOperations } = require('./trust-policy'),
  TRUST_SYNC_METHODS = [
    'linkSymbol',
    'findUnlinked',
    'insertSymbolLink',
    'adjustTrust',
    'recordRecall',
    'getStaleLinks',
    'getAnchoredLinks',
    'updateLinkTrust',
    'insertTrustAdjustment',
    'getRecalledMemoryIds',
    'updateLinkTrustByMemoryId',
    'getSymbolsForMemory',
    'getSymbolCluster',
    'getRelatedMemories',
  ];

function assertRepositoryMethods(repository, requiredMethods) {
  const missing = requiredMethods.filter((method) => typeof repository[method] !== 'function');
  if (missing.length > 0) {
    throw new Error(`trust-sync repository missing methods: ${missing.join(', ')}`);
  }
}

function createLegacyTrustSyncRepository(deps, requiredMethods) {
  const hasLegacyMethod = TRUST_SYNC_METHODS.some((method) => typeof deps[method] === 'function');
  if (!hasLegacyMethod) {
    return null;
  }

  assertRepositoryMethods(deps, requiredMethods);
  return Object.fromEntries(
    TRUST_SYNC_METHODS.map((method) => [
      method,
      (params) => {
        if (typeof deps[method] !== 'function') {
          throw new Error(`trust-sync repository missing methods: ${method}`);
        }
        return deps[method](params);
      },
    ]),
  );
}

function getTrustSyncRepository(deps, requiredMethods = TRUST_SYNC_METHODS) {
  if (deps.trustSyncRepository) {
    assertRepositoryMethods(deps.trustSyncRepository, requiredMethods);
    return deps.trustSyncRepository;
  }
  if (deps.repositories && deps.repositories.trustSync) {
    assertRepositoryMethods(deps.repositories.trustSync, requiredMethods);
    return deps.repositories.trustSync;
  }

  const legacyRepository = createLegacyTrustSyncRepository(deps, requiredMethods);
  if (legacyRepository) {
    return legacyRepository;
  }
  throw new Error('trust-sync repository is required');
}

function linkSymbol(deps, args) {
  const memoryId = args['memory-id'] || args.memoryId,
    symbolId = args['symbol-id'] || args.symbolId,
    repo = args.repo,
    trust = parseFloat(args.trust || '0.5');
  if (!memoryId) {
    return deps.jsonErrNoExit('--memory-id required');
  }
  if (!repo) {
    return deps.jsonErrNoExit('--repo required');
  }
  return getTrustSyncRepository(deps, ['linkSymbol']).linkSymbol({ memoryId, symbolId, repo, trust });
}

function autoLink(deps, args) {
  const project = args.project,
    repository = project ? getTrustSyncRepository(deps, ['findUnlinked', 'insertSymbolLink']) : undefined,
    unlinked = project ? repository.findUnlinked(project) : undefined;
  if (!project) {
    return deps.jsonErrNoExit('--project required');
  }
  let linked = 0;
  for (const row of unlinked) {
    repository.insertSymbolLink({
      memoryId: row.memory_id,
      symbolId: '__unlinked__',
      repo: project,
      trustScore: 0.5,
    });
    linked++;
  }
  return { ok: true, linked, total: unlinked.length };
}

function adjustTrust(deps, args) {
  const memoryId = args['memory-id'] || args.memoryId,
    delta = parseFloat(args.delta || '0'),
    reason = args.reason || 'manual',
    newTrust = memoryId
      ? getTrustSyncRepository(deps, ['adjustTrust']).adjustTrust({ memoryId, delta, reason })
      : undefined;
  if (!memoryId) {
    return deps.jsonErrNoExit('--memory-id required');
  }
  if (newTrust === null) {
    return { ok: true, memoryId, newTrust: null, delta, reason, warning: 'No symbol link found for this memory' };
  }
  return { ok: true, memoryId, newTrust, delta, reason };
}

function recordRecall(deps, args) {
  const sessionId = args['session-id'] || args.sessionId,
    memoryId = args['memory-id'] || args.memoryId;
  if (!sessionId || !memoryId) {
    return deps.jsonErrNoExit('--session-id and --memory-id required');
  }
  getTrustSyncRepository(deps, ['recordRecall']).recordRecall({ sessionId, memoryId });
  return { ok: true, sessionId, memoryId };
}

function staleLinks(deps, args) {
  const repo = args.repo,
    links = repo ? getTrustSyncRepository(deps, ['getStaleLinks']).getStaleLinks(repo) : undefined;
  if (!repo) {
    return deps.jsonErrNoExit('--repo required');
  }
  return { links, total: links.length };
}

function syncCodeTrust(deps, args) {
  const repo = args.repo,
    detected = repo ? detectChangedSymbols(deps, repo) : undefined;
  if (!repo) {
    return deps.jsonErrNoExit('Missing --repo');
  }

  // Try new git-based detection first
  if (detected.error) {
    return detected.error;
  }

  // HEAD unchanged — nothing to do
  if (detected.message) {
    return detected;
  }

  // No changed symbols in the index — update head_commit and return
  if (detected.changedSet.size === 0) {
    const tx = deps.withTransaction || require('../../db').withTransaction;
    tx(() => {
      deps.sqlRun('UPDATE code_repos SET head_commit = ? WHERE name = ?', [detected.new_head, repo]);
    });
    return {
      ok: true,
      repo,
      message: 'Files changed but no indexed symbols affected',
      changed_files: detected.changed_files,
      old_head: detected.old_head,
      new_head: detected.new_head,
    };
  }

  // Evaluate trust adjustments
  const repository = getTrustSyncRepository(deps, ['getAnchoredLinks', 'updateLinkTrust', 'insertTrustAdjustment']),
    allLinks = repository.getAnchoredLinks(repo),
    evaluated = evaluateTrustSync(allLinks, detected.changedSet),
    applyTrustUpdates = () => {
      for (const operation of evaluated.operations) {
        repository.updateLinkTrust({
          memoryId: operation.link.memory_id,
          symbolId: operation.link.symbol_id,
          newTrust: operation.newTrust,
        });
        repository.insertTrustAdjustment({
          memoryId: operation.link.memory_id,
          reason: operation.reason,
          delta: operation.delta,
        });
      }
      deps.sqlRun('UPDATE code_repos SET head_commit = ? WHERE name = ?', [detected.new_head, repo]);
    },
    tx = deps.withTransaction || require('../../db').withTransaction,
    result = (() => {
      tx(applyTrustUpdates);

      return stripOperations(evaluated);
    })();
  result.changed_symbols = detected.changedSet.size;
  result.changed_files = detected.changed_files;
  result.old_head = detected.old_head;
  result.new_head = detected.new_head;
  return result;
}

function trustRecovery(deps, args) {
  const sessionId = parseInt(args.session, 10),
    repository = sessionId
      ? getTrustSyncRepository(deps, ['getRecalledMemoryIds', 'updateLinkTrustByMemoryId', 'insertTrustAdjustment'])
      : undefined,
    recalled = sessionId ? repository.getRecalledMemoryIds(sessionId) : undefined;
  if (!sessionId) {
    return deps.jsonErrNoExit('Missing --session');
  }

  let recovered = 0;
  for (const row of recalled) {
    const memoryId = String(row.memory_id);
    repository.updateLinkTrustByMemoryId({ memoryId, newTrust: TRUST_DELTA.PASSIVE_SURVIVAL });
    repository.insertTrustAdjustment({
      memoryId,
      reason: 'passive_survival',
      delta: TRUST_DELTA.PASSIVE_SURVIVAL,
    });
    recovered++;
  }
  return { ok: true, memoriesRecovered: recovered };
}

module.exports = {
  TRUST_SYNC_METHODS,
  assertRepositoryMethods,
  getTrustSyncRepository,
  linkSymbol,
  autoLink,
  adjustTrust,
  recordRecall,
  staleLinks,
  syncCodeTrust,
  trustRecovery,
};
